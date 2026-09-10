#!/usr/bin/env node
//
// Stranded work-order audit — read-only, writes NOTHING (CRM-11).
//
// For every non-terminal work order: id, type, status, customer, created,
// scheduledFor, direct invoice / service record, other invoices on the
// same customer/property (the "papered elsewhere" signal), parent-project
// state for build days, and a SUGGESTED classification:
//
//   (a) genuinely upcoming — leave alone
//   (b) done + papered elsewhere — close/cancel WITHOUT invoicing
//   (c) done, uninvoiced — candidate for scripts/complete-backdated-wo.js
//   (d) test/junk — delete
//
// Suggestions are heuristics for a human to overrule, not verdicts.
//
// Run: node scripts/audit-stranded-wos.js

const path = require("node:path");
const fs = require("node:fs");

const DATA = path.resolve(__dirname, "..", "server", "data");
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, `${f}.json`), "utf8")); }
  catch { return []; }
};

const wos = read("work-orders");
const invoices = read("invoices");
const properties = read("properties");
const projects = read("projects");
const leads = read("leads");

const TERMINAL = new Set(["completed", "cancelled", "no_show"]);
const now = Date.now();
const open = wos.filter((w) => !w.deletedAt && !TERMINAL.has(w.status));
const d = (iso) => (iso || "").slice(0, 10) || "—";

console.log(`non-terminal work orders: ${open.length}\n`);
const tally = {};
for (const w of open) {
  const cust = w.customerName || w.customerId || "?";
  const direct = invoices.filter((i) => i.woId === w.id);
  const nearby = invoices.filter((i) => i.woId !== w.id && i.status !== "void"
    && ((w.customerId && i.customerId === w.customerId) || (w.propertyId && i.propertyId === w.propertyId)));
  const prop = properties.find((p) => p.id === w.propertyId);
  const srDirect = (prop?.serviceRecords || []).find((r) => r.woId === w.id);
  const proj = w.parentProjectId ? projects.find((p) => p.id === w.parentProjectId) : null;
  const lead = w.leadId ? leads.find((l) => l.id === w.leadId) : null;

  console.log(`${w.id} | ${w.type} | ${w.status} | ${cust} | created ${d(w.createdAt)} | scheduledFor ${w.scheduledFor ? d(w.scheduledFor) : "(dateless)"}`);
  console.log(`  invoice direct: ${direct.length ? direct.map((i) => `${i.id} ${i.status} $${i.total}`).join(", ") : "none"}`);
  if (nearby.length) console.log(`  invoices same customer/property: ${nearby.map((i) => `${i.id} ${i.status} $${i.total} (${d(i.createdAt)})${i.woId ? " wo:" + i.woId : ""}`).join("; ")}`);
  console.log(`  service record for this WO: ${srDirect ? srDirect.id : "none"}${prop ? ` | property records total: ${(prop.serviceRecords || []).length}` : " | NO PROPERTY LINK"}`);
  if (w.parentProjectId) console.log(`  parent project: ${proj ? `${proj.id} (${proj.status})` : `${w.parentProjectId} (NOT FOUND)`}`);
  if (lead?.contact?.email) console.log(`  lead email: ${lead.contact.email}`);

  let cls, why;
  const junk = /test|fake|charette/i.test(`${cust} ${w.address || ""} ${w.customerNotes || ""} ${w.techNotes || ""}`);
  const futureDated = w.scheduledFor && Date.parse(w.scheduledFor) >= now;
  if (junk) { cls = "(d) test/junk?"; why = "name/notes match test markers — verify before deleting"; }
  else if (direct.length || srDirect) { cls = "(b) close without invoicing"; why = `already has ${direct.length ? "an invoice" : "a service record"} for this WO`; }
  else if (proj && proj.status !== "active") { cls = "(b) close without invoicing"; why = `build day under ${proj.status} project — project completion invoices, not build days`; }
  else if (proj && proj.status === "active") { cls = "(a) leave alone"; why = "build day under an active project"; }
  else if (futureDated) { cls = "(a) leave alone"; why = "future-dated"; }
  else if (w.type === "fall_closing") { cls = "(a) leave alone (likely)"; why = "dateless fall closing — booked for the season ahead"; }
  else if (w.status === "on_site" || w.status === "in_progress") { cls = "(a)/(c) VERIFY with the field"; why = "on_site with no paper — could be genuinely in progress right now (e.g. multi-visit commercial work), or a visit that was never closed out. Only the calendar knows."; }
  else { cls = "(c) back-date candidate — CONFIRM visit happened"; why = `past/dateless ${w.type}, no invoice, no service record`; }
  tally[cls[1]] = (tally[cls[1]] || 0) + 1;
  console.log(`  -> suggested: ${cls} — ${why}\n`);
}
console.log(`suggested tally: (a) ${tally.a || 0} | (b) ${tally.b || 0} | (c) ${tally.c || 0} | (d) ${tally.d || 0}`);
console.log("Legend: (a) upcoming, leave | (b) done + papered, close w/o invoicing | (c) done, uninvoiced — back-date | (d) test/junk — delete");

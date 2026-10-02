// scripts/e2e/lib/journey.mjs
//
// Shared steps for the business-journey suites (scripts/e2e/journey-*.mjs).
// Each step is the request the real client makes — the phone app's
// pjl-field/src/api.js, the CRM's buttons, the customer's pay page and
// portal — against a server booted by scripts/lib/field-server.mjs, so
// nothing leaves the machine and every message is accounted for by
// srv.ledger().
//
// Prices are never typed here: expectations read pricing.json by key
// (Hard Rule 21).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootServer, SIGNATURE, sleep } from "../../lib/field-server.mjs";

export { bootServer, SIGNATURE, sleep };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, "pricing.json"), "utf8"));
export const priceOf = (key) => {
  const item = PRICING.items[key];
  if (!item) throw new Error(`pricing.json has no item ${key}`);
  return item.price;
};
// The app's own routing rules (pure module, runs in Node).
export const routing = await import(pathToFileURL(path.join(ROOT, "pjl-field", "src", "workorder-routing.js")).href);

export const j = (v) => JSON.stringify(v)?.slice(0, 300);
export const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
export const money = (n) => Math.round(Number(n) * 100) / 100;
// HST as invoices.js applies it, from its exported rate.
export const withTax = (srv, subtotal) => money(subtotal + Math.round(subtotal * srv.lib("invoices.js").HST_RATE * 100) / 100);

// A local wall-clock time in Toronto, as an ISO instant.
export const at = (ymd, hh, mm = 0) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
};
// A weekday at least `days` out, so portal cut-offs never bite.
export const dayOut = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-CA");
};

// Pass/fail bookkeeping with the step each assertion belongs to, so a
// failure reads as the business step that broke.
export function journey(name) {
  let passed = 0;
  const failures = [];
  const findings = [];
  let step = "setup";
  return {
    step(label) { step = label; },
    // A behaviour this journey found that looks wrong for the business but
    // is a decision for Patrick, not a test to quietly pin either way.
    // Reported on every run, never fails it; once decided, it becomes ok().
    finding(cond, label) { if (!cond) findings.push(`[${step}] ${label}`); },
    ok(cond, label) {
      if (cond) passed += 1;
      else failures.push(`[${step}] ${label}`);
    },
    // A ledger step: every outbound message it expected, nothing else.
    async sent(L, label, matchers, opts) {
      const r = await L.expect(label, matchers, opts);
      if (r.ok) passed += 1;
      else failures.push(...r.errors.map((e) => `[${step}] ${e}`));
      return r.entries;
    },
    crashed(err) { failures.push(`[${step}] crashed: ${err?.stack || err}`); },
    // Anything sent after the last step — call before srv.stop().
    close(L) {
      try { for (const e of L.close()) failures.push(`[end] ${e}`); } catch (err) { failures.push(`[end] ledger unreadable: ${err.message}`); }
    },
    finish() {
      for (const f of findings) console.warn(`  ⚠ FINDING ${f}`);
      if (failures.length) {
        console.error(`✗ ${name}: ${failures.length} failed, ${passed} passed`);
        for (const f of failures) console.error(`  ✗ ${f}`);
        process.exit(1);
      }
      console.log(`✓ ${name}: ${passed} passed`);
      process.exit(0);
    }
  };
}

// The invoice-ready text fires on its timer at once, so a journey sees it.
export function textInvoicesImmediately(srv) {
  const current = srv.data("settings");
  const base = Array.isArray(current) ? {} : current;
  srv.writeData("settings", { ...base, invoiceSms: { enabled: true, delayMinutes: 0, maxAgeHours: 24 } });
}

// ---- booking ---------------------------------------------------------------

// A booking made from the app's Book tab / the CRM (admin, forced slot):
// the same /api/booking/reserve the public page uses. `leadId` books an
// existing customer; without it the server builds a new customer.
export async function book(srv, { leadId = null, contact = {}, serviceKey, zoneCount, day, hour = 10 }) {
  const r = await srv.api("POST", "/api/booking/reserve", {
    ...(leadId ? { leadId } : {}),
    serviceKey, slotStart: at(day, hour), source: "admin_custom", zoneCount, contact
  });
  if (r.status !== 201 || !r.body.ok) throw new Error(`booking refused: ${r.status} ${j(r.body)}`);
  const lead = srv.data("leads").find((l) => l.id === r.body.leadId);
  return { res: r.body, lead };
}

// Today → the visit → "Start": the app's openWorkOrder(leadId).
export async function openWorkOrder(srv, leadId) {
  const r = await srv.api("POST", `/api/leads/${encodeURIComponent(leadId)}/open-wo`, {});
  if (r.status !== 200 || !r.body.workOrder) throw new Error(`open-wo failed: ${r.status} ${j(r.body)}`);
  return r.body.workOrder;
}

// The closing screen's work: walk `walked` zones (all fine), answer the
// gates. What the tech taps before Finish.
export async function walkTheSystem(srv, woId, { walked, paidOnSite = false }) {
  const wo = (await srv.api("GET", `/api/work-orders/${woId}`)).body.workOrder;
  const have = (wo.zones || []).length;
  const extra = Array.from({ length: Math.max(0, walked - have) }, (_, i) => ({ number: have + i + 1, location: `Zone ${have + i + 1}`, status: "ok" }));
  return srv.prepClosing(woId, { extraZones: extra, paidOnSite });
}

// What the tech shows the customer before they sign: the preview the
// app's getWorkOrder carries (seasonalFee.atFinish).
export async function priceAtSigning(srv, woId) {
  return (await srv.api("GET", `/api/work-orders/${woId}`)).body.seasonalFee?.atFinish || null;
}

// Finish, as the app's completeWorkOrder sends it.
export async function finish(srv, woId, { signature = SIGNATURE } = {}) {
  const now = new Date().toISOString();
  return srv.api("PATCH", `/api/work-orders/${woId}`, {
    status: "completed", ...(signature ? { signature } : {}), arrivedAt: now, departedAt: now
  });
}

// Reopening a finished closing from the day: the app's own rule
// (workorder-routing.js reopensToInvoice + activeInvoiceFor) over the
// same two reads the app makes.
export async function reopen(srv, woId) {
  const wo = (await srv.api("GET", `/api/work-orders/${woId}`)).body.workOrder;
  const list = (await srv.api("GET", `/api/invoices?woId=${encodeURIComponent(woId)}`)).body.invoices || [];
  const target = routing.reopensToInvoice(wo) ? routing.activeInvoiceFor(list, woId) : null;
  const invoice = target ? (await srv.api("GET", `/api/invoices/${target.id}`)).body.invoice : null;
  return { wo, invoice, opensInvoice: Boolean(invoice) };
}

export const invoiceFor = (srv, woId) => srv.data("invoices").find((i) => i.woId === woId && i.status !== "void") || null;
export const invoicesFor = (srv, woId) => srv.data("invoices").filter((i) => i.woId === woId);
export const feeLine = (lines) => (lines || []).find((l) => /^fall_close_/.test(l?.key || "")) || null;

// ---- paying ----------------------------------------------------------------

// The pay link the app mints and the customer opens: token out of the URL.
export async function payLink(srv, invoiceId) {
  const r = await srv.api("POST", `/api/invoices/${invoiceId}/payment-link`, {});
  if (r.status !== 200) return { res: r, token: null };
  return { res: r, url: r.body.url, token: new URL(r.body.url).searchParams.get("t") };
}

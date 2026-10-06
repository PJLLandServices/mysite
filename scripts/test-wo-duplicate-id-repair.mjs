#!/usr/bin/env node
// scripts/test-wo-duplicate-id-repair.mjs
//
// Two work orders under one number are split at boot, and the visit that
// lost its completion gets one (2026-10-06, Rina Sinapi, WO-2SYJCAW6).
//
// Before create() refused a taken id (2026-09-22), a returning customer's
// fall closing was minted under the lead's spring envelope id. Finishing
// it found spring's service record under that number, answered "already
// ran", and handed back spring's PAID invoice: the closing was never
// invoiced, recorded or reported.
//
// Seeded exactly that way (the fall record first in the file, as on the
// live store), booted against temp data with outbound stubbed:
//   1. Every work order has its own number; the EARLIEST record (spring)
//      keeps the old one, the fall record gets a new one and a history line.
//   2. The fall visit now has a service record, a report and a DRAFT
//      invoice for its own lines; spring's paid invoice is untouched.
//   3. Nothing reached the customer: no email, no text (the office sends).
//   4. The fall photos are under the new number; the old folder is intact.
//   5. The lead points at the new number.
//   6. A second boot changes nothing (no second invoice, no renumbering).
//
// Run: node scripts/test-wo-duplicate-id-repair.mjs   (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
const pricing = require("../server/lib/pricing.js");
const { totalsForLines } = require("../server/lib/invoices.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SHARED = "WO-DUPL2345";
const PROPERTY = "prop-dup-id";
const LEAD = "lead-dup-id";
const FALL = pricing.priceForBooking("fall_close_8z").price;
const SPRING = pricing.priceForBooking("spring_open_8z").price;
const fallLine = { key: "fall_close_8z", label: "Fall Closing (2026)", qty: 1, originalPrice: FALL, overridePrice: null, custom: false, source: { zoneNumbers: [], issueIds: [], baseline: true }, note: "" };
const springLine = { key: "spring_open_8z", label: "Spring Opening (2026)", qty: 1, originalPrice: SPRING, overridePrice: null, custom: false, source: { zoneNumbers: [], issueIds: [], baseline: true }, note: "" };
const springTotals = totalsForLines([{ unitPrice: SPRING, qty: 1 }]);
const fallTotals = totalsForLines([{ unitPrice: FALL, qty: 1 }]);
const customer = { customerId: "cust-dup", customerName: "Dup Customer", customerEmail: "dup@example.com", customerPhone: "9055550199", address: "53 Example Dr, Nobleton, ON" };
const zones = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, kind: "zone", location: `Zone ${i + 1}`, status: "working_well", issues: [] }));
const bypass = (total) => ({ reason: "trusted_customer_verbal", note: "", customerNamePrinted: "Dup Customer", bypassedBy: "admin", ts: "", acceptedScopeSnapshot: { total }, coversQuoteAcceptance: false });

const spring = {
  id: SHARED, type: "spring_opening", status: "completed", propertyId: PROPERTY, leadId: LEAD, ...customer, zones,
  onSiteQuote: { quoteId: null, status: "draft", builderLineItems: [springLine] },
  signatureBypass: { ...bypass(springTotals.total), ts: "2026-07-09T12:59:58.000Z" }, locked: true,
  photos: [{ n: 1, mediaType: "image/jpeg", kind: "image", bytes: 6, category: "general" }],
  completedAt: "2026-07-09T13:00:06.000Z", completionReportSnapshotAt: "2026-07-09T13:00:07.000Z",
  createdAt: "2026-07-09T12:19:40.000Z", updatedAt: "2026-07-09T13:00:07.000Z",
  history: [{ ts: "2026-07-09T13:00:07.000Z", action: "cascade_fire", by: "system", note: "Service record + draft invoice I-2026-0040" }]
};
const fall = {
  id: SHARED, type: "fall_closing", status: "completed", propertyId: PROPERTY, leadId: LEAD, ...customer, zones,
  scheduledFor: "2026-07-09T12:00:00.000Z",
  onSiteQuote: { quoteId: null, status: "draft", builderLineItems: [fallLine] },
  signatureBypass: { ...bypass(fallTotals.total), ts: "2026-10-06T15:38:05.000Z" }, locked: true,
  serviceChecklist: { controller_off: true, water_off: true, compressor_disconnected: true, system_winterized: true },
  photos: [{ n: 2, mediaType: "image/jpeg", kind: "image", bytes: 4, category: "general" }],
  completedAt: "2026-10-06T15:38:06.000Z", completionReportSnapshotAt: null,
  createdAt: "2026-09-08T20:40:43.000Z", updatedAt: "2026-10-06T15:38:06.000Z",
  history: [{ ts: "2026-10-06T15:38:06.000Z", action: "status_change", by: "admin", note: "", before: "on_site", after: "completed" }]
};
const springInvoice = {
  id: "I-2026-0040", woId: SHARED, propertyId: PROPERTY, ...customer, status: "paid", invoiceRole: "standard",
  lineItems: [{ key: "spring_open_8z", label: "Spring Opening (2026)", qty: 1, unitPrice: SPRING, lineTotal: SPRING, note: "" }],
  ...springTotals, currency: "CAD", amountPaid: springTotals.total, balanceDue: 0,
  payments: [{ id: "pmt_1", amount: springTotals.total, method: "card_qb", receivedAt: "2026-07-09T15:38:12.000Z", receivedBy: "admin" }],
  sentAt: "2026-07-09T13:26:54.000Z", paidAt: "2026-07-09T15:38:12.000Z",
  createdAt: "2026-07-09T13:00:06.000Z", updatedAt: "2026-07-09T15:38:12.000Z", history: []
};
const property = {
  id: PROPERTY, code: "P-2026-0999", customerId: customer.customerId, customerName: customer.customerName,
  customerEmail: customer.customerEmail, customerPhone: customer.customerPhone, address: customer.address,
  system: { zones: [] }, leadIds: [LEAD], workOrderIds: [],
  serviceRecords: [{ id: "sr_spring", woId: SHARED, woType: "spring_opening", completedAt: spring.completedAt, summary: "Spring opening", lineItems: [springLine], ...springTotals, invoiceId: springInvoice.id }],
  createdAt: "2026-07-09T09:04:46.000Z", updatedAt: "2026-10-06T15:13:08.000Z"
};
const lead = {
  id: LEAD, createdAt: "2026-07-09T09:04:46.000Z", status: "won", source: "spring_opening", customerId: customer.customerId,
  contact: { name: customer.customerName, phone: customer.customerPhone, email: customer.customerEmail, address: customer.address },
  booking: { start: "2026-07-09T12:00:00.000Z", serviceKey: "spring_open_8z", workOrder: { id: SHARED, status: "scheduled", createdAt: "2026-07-09T09:04:46.000Z" } },
  propertyId: PROPERTY, workOrderId: SHARED
};

const seed = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-dup-seed-"));
const write = (name, v) => fs.writeFileSync(path.join(seed, `${name}.json`), JSON.stringify(v, null, 2));
// The fall record FIRST, as on the live store (get() answered it).
write("work-orders", [fall, spring]);
write("invoices", [springInvoice]);
write("properties", [property]);
write("leads", [lead]);
fs.mkdirSync(path.join(seed, "wo-photos", SHARED), { recursive: true });
fs.writeFileSync(path.join(seed, "wo-photos", SHARED, "1.jpg"), "SPRING");
fs.writeFileSync(path.join(seed, "wo-photos", SHARED, "2.jpg"), "FALL");

async function settle(srv, until) {
  for (let i = 0; i < 80; i++) { if (until()) return true; await wait(150); }
  return false;
}

let carried = null;
const srv = await bootServer({ port: 4871, seedData: seed });
try {
  const fallId = () => srv.data("work-orders").find((w) => w.type === "fall_closing")?.id;
  const draftFor = (id) => srv.data("invoices").find((i) => i.woId === id);
  await settle(srv, () => fallId() && fallId() !== SHARED && draftFor(fallId()) && srv.data("work-orders").find((w) => w.type === "fall_closing")?.completionReportSnapshotAt);

  const wos = srv.data("work-orders");
  const ids = wos.map((w) => w.id);
  ok(wos.length === 2, `still two work orders (got ${wos.length})`);
  ok(new Set(ids).size === ids.length, `every work order has its own number (got ${ids.join(", ")})`);
  const s = wos.find((w) => w.type === "spring_opening");
  const f = wos.find((w) => w.type === "fall_closing");
  ok(s?.id === SHARED, `the earliest record (spring) keeps ${SHARED} (got ${s?.id})`);
  ok(f && f.id !== SHARED && /^WO-[A-HJ-NP-Z2-9]{8}$/.test(f.id), `the fall record has a new number (got ${f?.id})`);
  const renum = (f?.history || []).find((h) => h.action === "renumbered");
  ok(renum && renum.before?.id === SHARED && renum.after?.id === f?.id, "the fall record's history says what it was renumbered from");
  ok(!(s?.history || []).some((h) => h.action === "renumbered"), "the spring record is not touched");

  // 2. The fall visit's completion.
  const inv = f ? draftFor(f.id) : null;
  ok(inv && inv.status === "draft", `a DRAFT invoice for the fall visit (got ${inv?.status})`);
  ok(inv && Math.abs(Number(inv.total) - fallTotals.total) < 0.005, `…for the fall lines, ${fallTotals.total} (got ${inv?.total})`);
  ok(inv && (inv.lineItems || []).every((l) => l.key === "fall_close_8z"), "…and only the fall lines");
  ok(inv && !inv.sentAt && !inv.customerSmsScheduledAt, "…not sent, no invoice text scheduled");
  const sp = srv.data("invoices").find((i) => i.id === springInvoice.id);
  ok(sp?.status === "paid" && sp?.woId === SHARED && Number(sp?.amountPaid) === springTotals.total, "spring's paid invoice is untouched and still on spring's number");
  ok(srv.data("invoices").length === 2, `two invoices in all (got ${srv.data("invoices").length})`);
  const recs = srv.data("properties")[0]?.serviceRecords || [];
  ok(recs.some((r) => r.woId === SHARED && r.invoiceId === springInvoice.id), "spring's service record is kept");
  ok(recs.some((r) => r.woId === f?.id && r.invoiceId === inv?.id && r.woType === "fall_closing"), "the fall visit has its own service record, on its invoice");
  ok(Boolean(f?.completionReportSnapshotAt), "the fall visit has its completion report");

  // 3. Nothing reached the customer.
  await wait(500);
  const out = srv.outbox().filter((m) => /dup@example\.com|9055550199/.test(JSON.stringify(m.to || "")));
  ok(out.length === 0, `nothing sent to the customer (got ${out.map((m) => m.channel + ":" + (m.subject || "")).join(" | ")})`);

  // 4. Photos.
  const photo = (id, n) => { try { return fs.readFileSync(path.join(srv.DATA, "wo-photos", id, `${n}.jpg`), "utf8"); } catch { return null; } };
  ok(photo(f?.id, 2) === "FALL", "the fall photo is under the new number");
  ok(photo(SHARED, 1) === "SPRING" && photo(SHARED, 2) === "FALL", "the old folder is left as it was");

  // 5. The lead.
  ok(srv.data("leads")[0]?.workOrderId === f?.id, `the lead points at the new number (got ${srv.data("leads")[0]?.workOrderId})`);

  // Routes answer per visit.
  await srv.login();
  const gs = await srv.api("GET", `/api/work-orders/${SHARED}`);
  ok(gs.body?.workOrder?.type === "spring_opening", `GET ${SHARED} is the spring visit (got ${gs.body?.workOrder?.type})`);
  const gf = await srv.api("GET", `/api/work-orders/${f?.id}`);
  ok(gf.body?.workOrder?.type === "fall_closing", "GET <new number> is the fall visit");

  carried = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-dup-carry-"));
  fs.cpSync(srv.DATA, carried, { recursive: true });
} finally {
  await srv.stop();
}

// 6. Idempotent: boot again on what the first boot left.
if (carried) {
  const before = JSON.parse(fs.readFileSync(path.join(carried, "work-orders.json"), "utf8")).map((w) => w.id).sort();
  const srv2 = await bootServer({ port: 4872, seedData: carried });
  try {
    await wait(1500);
    const after = srv2.data("work-orders").map((w) => w.id).sort();
    ok(JSON.stringify(after) === JSON.stringify(before), "a second boot renumbers nothing");
    ok(srv2.data("invoices").length === 2, `a second boot drafts no second invoice (got ${srv2.data("invoices").length})`);
    ok((srv2.data("properties")[0]?.serviceRecords || []).length === 2, "…and adds no service record");
  } finally {
    await srv2.stop();
  }
  fs.rmSync(carried, { recursive: true, force: true });
}
fs.rmSync(seed, { recursive: true, force: true });

console.log(`test-wo-duplicate-id-repair: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

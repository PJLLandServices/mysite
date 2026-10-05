#!/usr/bin/env node
// scripts/test-paid-in-full.mjs
//
// SETTLE-PIF-01 (P-PJL-22, requirement D): an admin-only "Paid in Full"
// settlement for a prepaid customer's visit, distinct from No Charge.
//
// Nothing in the system can say "this visit is prepaid" today (2026-10-05
// research): the season plan is a route plan with no money fields, and the
// only two outcomes of a visit are an invoice or No Charge (lines that total
// $0). A prepaid customer therefore either gets an invoice for money already
// paid, or is recorded as No Charge, which erases that the visit was paid
// for. The PROPOSED state (see docs/INVOICE_DELIVERY_TTP.md §D):
//
//   wo.settlement = { type: "paid_in_full", reference, by, at }
//     set by an admin only, through PUT /api/work-orders/:id/settlement;
//     copied onto the visit's service record at completion.
//
// What must hold:
//   D1. admin only: a tech is refused the route, and the generic work-order
//       PATCH cannot set it for anyone. A tech's read of the work order
//       does not show it (it says only that payment is handled by the office).
//   D2. the visit completes normally: the sign-off's payment question is
//       answered by the settlement, the customer gets the full report.
//   D3. the customer-facing money says PAID IN FULL and shows no dollar
//       values: the report, the completion email (no "invoice will follow").
//   D4. no invoice, no payment link, no Tap to Pay / Take payment now, no
//       invoice text or reminder, no $0 or made-up payment record; a manual
//       "Generate invoice" is refused.
//   D5. the audit trail keeps who chose Paid in Full and when (work-order
//       history), and the service history says the visit was satisfied by
//       prepayment — not No Charge.
//   D6. No Charge is separate and unchanged: a $0 visit still completes with
//       no invoice, is called no charge, and carries no settlement.
//
// D1–D5 FAIL on main at 9d36363f (no such state). D6 passes there and is
// pinned so Paid in Full cannot leak into No Charge or the other way.
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
// Run: node scripts/test-paid-in-full.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";
import { readPdf } from "./lib/pdf-text.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- Customer-facing wording (PROPOSED — awaiting Patrick's approval) ----
const PIF = "PAID IN FULL";
const DOLLARS = /\$\s?\d/;
const SETTLE = (id) => `/api/work-orders/${id}/settlement`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4957 });
try {
  await srv.login();
  const now = () => new Date().toISOString();
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
  const smsTo = (phone) => srv.outbox().filter((m) => m.channel === "sms" && String(m.to || "").replace(/\D/g, "").endsWith(String(phone).replace(/\D/g, "")));

  const f = await srv.fixture({ phone: "9055550199" });
  const id = f.wo.id;

  // ---- D1. admin only ------------------------------------------------------
  await srv.login({ role: "tech" });
  let r = await srv.api("PUT", SETTLE(id), { type: "paid_in_full", reference: "2026 plan, paid in April" });
  ok(r.status === 403, `D1. a tech cannot choose Paid in Full (${r.status})`);
  r = await srv.qpatch(id, { settlement: { type: "paid_in_full" } });
  ok(!srv.data("work-orders").find((w) => w.id === id).settlement, "D1. nor slip it in through the work-order PATCH");
  await srv.login();
  r = await srv.qpatch(id, { settlement: { type: "paid_in_full" } });
  ok(!srv.data("work-orders").find((w) => w.id === id).settlement, "D1. the PATCH does not set it for an admin either — one door");
  r = await srv.api("PUT", SETTLE(id), { type: "paid_in_full" });
  ok(r.status === 400, `D1. a reference is required — what paid for it (${r.status})`);
  r = await srv.api("PUT", SETTLE(id), { type: "paid_in_full", reference: "2026 plan, paid in April" });
  ok(r.status === 200, `D1. an admin chooses Paid in Full (${r.status} ${r.body?.errors?.[0] || ""})`);
  const set = srv.data("work-orders").find((w) => w.id === id);
  ok(set.settlement?.type === "paid_in_full" && set.settlement.by && set.settlement.at, `D5. it records who and when (${JSON.stringify(set.settlement || null)})`);
  ok((set.history || []).some((h) => h.action === "settlement_paid_in_full" && h.by), "D5. …and says so in the work order's history");
  await srv.login({ role: "tech" });
  const techView = await srv.api("GET", `/api/work-orders/${id}`);
  ok(!JSON.stringify(techView.body).includes("paid_in_full"), "D1. a tech's read of the work order does not show Paid in Full");
  ok(techView.body.workOrder?.paymentHandledByOffice === true, "D1. …only that payment is handled by the office");
  await srv.login();

  // ---- D2. the visit completes normally --------------------------------------
  await srv.prepClosing(id, { paidOnSite: null });
  const c = await complete(id);
  ok(c.status === 200, `D2. the visit completes without a payment choice (${c.status} ${JSON.stringify(c.body?.fails || c.body?.errors || "").slice(0, 200)})`);
  await sleep(500);
  ok(c.body?.cascade?.paidInFull === true && c.body?.cascade?.noCharge !== true, `D2. the app is told Paid in Full, not no charge (${JSON.stringify(c.body?.cascade || null)})`);

  // ---- D4. nothing to collect ----------------------------------------------------
  ok(!srv.data("invoices").some((i) => i.woId === id), "D4. no invoice — not even a $0 one");
  const gen = await srv.api("POST", `/api/work-orders/${id}/create-invoice`, {});
  ok(gen.status === 409 && gen.body.code === "paid_in_full", `D4. Generate invoice is refused (${gen.status} ${gen.body.code})`);
  await sleep(300);
  ok(smsTo("9055550199").length === 0, "D4. no invoice text or reminder");

  // ---- D3. what the customer reads ------------------------------------------------
  const mail = srv.outbox().filter((m) => m.channel === "email" && m.to.includes(f.cust.email)).pop();
  const body = `${mail?.subject || ""}\n${mail?.text || ""}\n${mail?.html || ""}`;
  ok(Boolean(mail), "D2. the customer gets the completion email");
  ok(body.includes(PIF), `D3. it says ${PIF}`);
  ok(!DOLLARS.test(body.replace(/<[^>]+>/g, " ")), "D3. …with no dollar value");
  ok(!/invoice will follow|your invoice/i.test(body), "D3. …and no invoice to come");
  const wo = (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
  const pdfLib = srv.lib("wo-report-pdf.js");
  const report = await new Promise((resolve, reject) => {
    const chunks = [];
    const s = pdfLib.generateWoReportPdf({ wo, property: f.prop, customer: f.cust, mode: "service_report", audience: "customer" });
    s.on("data", (x) => chunks.push(x)); s.on("end", () => resolve(Buffer.concat(chunks))); s.on("error", reject);
  });
  const text = readPdf(report).text;
  ok(/Zone 1/.test(text), "D2. the customer's report is the full visit report");
  ok(text.includes(PIF), `D3. the report says ${PIF}`);
  ok(!DOLLARS.test(text), "D3. …with no dollar value, subtotal, HST or balance");

  // ---- D5. service history ---------------------------------------------------------
  const prop = srv.data("properties").find((p) => p.id === f.prop.id);
  const rec = (prop.serviceRecords || []).find((x) => x.woId === id);
  ok(rec?.settlement?.type === "paid_in_full", `D5. the service record says Paid in Full (${JSON.stringify(rec?.settlement || null)})`);
  ok(rec && !rec.invoiceId && rec.total !== 0, `D5. …with no invoice and no fake $0 total (total ${rec?.total})`);
  const list = await srv.api("GET", "/api/work-orders");
  const row = (list.body.workOrders || []).find((w) => w.id === id);
  ok(row && row.noCharge !== true, "D5. the office does not file it under No charge");
  ok(!(prop.serviceRecords || []).some((x) => x.woId === id && (x.payments || []).length), "D4. no made-up payment record");

  // ---- D6. No Charge is untouched ------------------------------------------------------
  {
    const n = await srv.fixture();
    await srv.api("PATCH", `/api/properties/${n.prop.id}`, { seasonalPricing: { fallClosingPrice: 0 } });
    await srv.prepClosing(n.wo.id, { paidOnSite: false });
    const nc = await complete(n.wo.id);
    await sleep(300);
    ok(nc.body?.cascade?.noCharge === true && nc.body?.cascade?.paidInFull !== true, `D6. a $0 visit is still No charge (${JSON.stringify(nc.body?.cascade || null)})`);
    ok(!srv.data("invoices").some((i) => i.woId === n.wo.id), "D6. …with no invoice");
    ok(!srv.data("work-orders").find((w) => w.id === n.wo.id).settlement, "D6. …and no settlement");
    const p2 = srv.data("properties").find((p) => p.id === n.prop.id);
    ok(!(p2.serviceRecords || []).find((x) => x.woId === n.wo.id)?.settlement, "D6. its service record carries no settlement");
    const m2 = srv.outbox().filter((m) => m.channel === "email" && m.to.includes(n.cust.email)).pop();
    ok(m2 && !`${m2.text}${m2.html}`.includes(PIF), "D6. No charge never says Paid in Full");
  }

  // ---- the field app -----------------------------------------------------------------------
  const closing = fs.readFileSync(path.join(ROOT, "pjl-field/src/screens/ClosingScreen.js"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "pjl-field/App.js"), "utf8");
  ok(/paidInFull/.test(closing) && /JOB\.PAID_IN_FULL/.test(app), "D4. the app lands on a Paid in Full screen, with no payment buttons");
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`paid-in-full: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

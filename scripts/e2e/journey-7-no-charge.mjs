#!/usr/bin/env node
// scripts/e2e/journey-7-no-charge.mjs
//
// JOURNEY 7 — a No Charge closing (the property's own fall price is $0).
// Patrick's rule (2026-09-26): no invoice, no payment prompt, no "invoice
// coming" wording, nothing to QuickBooks — and a clear No Charge state he
// can report on. Never a $0 invoice.
//
//   booked, then priced $0 → Patrick sets the property's fall price to $0
//   the tech's preview     → $0 before signing
//   Finish                 → no invoice; the app is told "no charge"; the
//                            customer's email has no total and no "invoice
//                            will follow"; Patrick's alert doesn't read as
//                            money owed; no invoice text, even instantly
//   no payment prompt      → "Generate invoice" refuses it as no charge;
//                            there is nothing to pay, link or tap
//   reportable             → the work order reads noCharge in the office
//                            list (the "No charge" filter) and its record;
//                            the property's service record is $0, no invoice
//   QuickBooks             → nothing to push: no invoice exists, and no
//                            call to Intuit is ever attempted
//   reopen / Finish again  → still no invoice; nothing sent
//
// Run: node scripts/e2e/journey-7-no-charge.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, priceAtSigning, finish, reopen,
  invoicesFor, textInvoicesImmediately, dayOut, strip, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-7 No Charge");
const srv = await bootServer({ port: 4937 });
const L = srv.ledger();
try {
  await srv.login();
  textInvoicesImmediately(srv);
  const PHONE = "9055550148";

  J.step("book, then price the property at $0");
  const { lead } = await book(srv, { serviceKey: "fall_close_4z", zoneCount: 4, day: dayOut(14),
    contact: { name: "Nell Nocharge", email: "nell@example.com", phone: PHONE, address: "200 Main St S, Newmarket, ON L3Y 3Z1" } });
  await J.sent(L, "booking", [
    { channel: "email", to: "nell@example.com", subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);
  const wo = await openWorkOrder(srv, lead.id);
  const prop = await srv.api("PATCH", `/api/properties/${wo.propertyId}`, { seasonalPricing: { fallClosingPrice: 0 } });
  J.ok(prop.status === 200 && prop.body.property?.seasonalPricing?.fallClosingPrice === 0, `Patrick sets this property's fall price to $0 (${prop.status})`);
  await J.sent(L, "price $0", []);

  J.step("the visit");
  await walkTheSystem(srv, wo.id, { walked: 4, paidOnSite: false });
  const shown = await priceAtSigning(srv, wo.id);
  J.ok(shown && Number(shown.price) === 0, `the tech's preview says $0 before signing (${j(shown)})`);
  const done = await finish(srv, wo.id);
  J.ok(done.status === 200 && done.body.cascade?.noCharge === true && !done.body.cascade?.invoiceId, `Finish: no charge, no invoice (${j(done.body.cascade)})`);
  J.ok(invoicesFor(srv, wo.id).length === 0, "no invoice exists — not even a $0 one");
  const mail = await J.sent(L, "finish", [
    { channel: "email", to: "nell@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ], { settleMs: 1200 });   // and NO invoice text, even with the timer at zero
  const cust = strip(mail.find((m) => m.to.includes("nell@"))?.html);
  J.ok(cust && !/invoice will follow/i.test(cust) && !/Total for today/i.test(cust), "the customer's email promises no invoice and shows no total");
  J.ok(cust && !/\$0\.00/.test(cust), "…and never says $0.00");
  const alert = mail.find((m) => m.to === "stub@pjl.test");
  J.ok(alert && !/Estimated total \$0\.00|No specific items selected/.test(alert.text || ""), `Patrick's alert doesn't read as a $0 bill (${(alert?.text || "").match(/Total:.*$/m)?.[0]})`);

  J.step("no payment prompt");
  const gen = await srv.api("POST", `/api/work-orders/${wo.id}/create-invoice`, {});
  J.ok(gen.status === 409 && gen.body.code === "no_charge", `"Generate invoice" refuses it as no charge (${gen.status} ${gen.body.code})`);
  J.ok(invoicesFor(srv, wo.id).length === 0, "…and makes none");
  const back = await reopen(srv, wo.id);
  J.ok(!back.opensInvoice, "reopening from the day finds no invoice to open (the web record, as designed)");
  await J.sent(L, "no payment", []);

  J.step("reportable");
  const rec = (await srv.api("GET", `/api/work-orders/${wo.id}`)).body.workOrder;
  J.ok(rec?.status === "completed" && rec?.noCharge === true, `the work order reads No Charge (${j([rec?.status, rec?.noCharge])})`);
  const list = (await srv.api("GET", "/api/work-orders")).body.workOrders || [];
  const row = list.find((w) => w.id === wo.id);
  J.ok(row?.noCharge === true, "the office list marks it No Charge (what the \"No charge\" filter reads)");
  const billed = list.filter((w) => w.status === "completed" && w.noCharge !== true);
  J.ok(!billed.some((w) => w.id === wo.id), "…and never among visits that need an invoice");
  const property = (await srv.api("GET", `/api/properties/${wo.propertyId}`)).body.property;
  const sr = (property?.serviceRecords || []).find((s) => s.woId === wo.id);
  J.ok(sr && !sr.invoiceId && Number(sr.total || 0) === 0 && (sr.lineItems || []).length > 0, `the service record keeps the visit's lines, $0, no invoice (${j(sr && { invoiceId: sr.invoiceId, total: sr.total, lines: (sr.lineItems || []).length })})`);

  J.step("QuickBooks");
  J.ok(!srv.outbox().some((e) => /intuit/i.test(e.host || e.url || "")), "no call to QuickBooks was ever attempted");

  J.step("Finish again");
  const again = await finish(srv, wo.id, { signature: null });
  J.ok(again.status === 200 || again.status === 409, `a retried Finish is safe (${again.status})`);
  await sleep(300);
  J.ok(invoicesFor(srv, wo.id).length === 0, "still no invoice");
  await J.sent(L, "finish again", [], { settleMs: 800 });
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

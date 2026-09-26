#!/usr/bin/env node
// scripts/e2e/journey-2-booked-4-walked-6.mjs
//
// JOURNEY 2 — booked as 4 zones, the tech walks 6. The price the customer
// is shown at signing is the price on every surface after it.
//
//   book 4 zones          → the booking carries the 1-4 zone tier
//   walk 6 zones          → before signing, the tech's preview moves to the
//                           5-6 zone tier (what the customer is shown)
//   sign + Finish         → the price freezes at signing; the draft invoice
//                           bills exactly that tier, + HST
//   completion email      → the same total
//   paid on site          → the pay link the tech hands over asks for the
//                           same balance; cash for that amount settles it
//                           (and emails nothing — a card receipt does)
//   nothing reprices it   → the 1-4 zone booking price never reappears
//
// Run: node scripts/e2e/journey-2-booked-4-walked-6.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, priceAtSigning, finish,
  invoiceFor, invoicesFor, feeLine, priceOf, withTax, payLink, dayOut, strip, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-2 booked 4 · walked 6 · price at signing = invoice");
const srv = await bootServer({ port: 4932 });
const L = srv.ledger();
try {
  await srv.login();
  const BOOKED = "fall_close_4z", WALKED = "fall_close_6z";
  const PHONE = "9055550142";

  J.step("book 4 zones");
  const { lead, res } = await book(srv, {
    serviceKey: BOOKED, zoneCount: 4, day: dayOut(11),
    contact: { name: "Walt Sixzones", email: "walt@example.com", phone: PHONE, address: "120 Davis Dr, Newmarket, ON L3Y 2N1" }
  });
  J.ok(res.booking?.serviceKey === BOOKED && res.booking?.workOrder?.total === priceOf(BOOKED), `booked at the 1-4 zone price (${j([res.booking?.serviceKey, res.booking?.workOrder?.total])})`);
  await J.sent(L, "booking", [
    { channel: "email", to: "walt@example.com", subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);

  J.step("walk 6 zones");
  const wo = await openWorkOrder(srv, lead.id);
  J.ok((wo.zones || []).length === 4, `the work order starts with the 4 booked zones (${(wo.zones || []).length})`);
  const before = await priceAtSigning(srv, wo.id);
  J.ok(before?.key === BOOKED, `before walking, the preview is the booked tier (${j(before)})`);
  await walkTheSystem(srv, wo.id, { walked: 6, paidOnSite: true });
  const shown = await priceAtSigning(srv, wo.id);
  J.ok(shown?.key === WALKED && shown?.price === priceOf(WALKED), `after walking 6, the customer is shown the 5-6 zone price (${j(shown)})`);
  J.ok(shown?.pending !== true, "…a real price, not 'PJL will price it'");
  await J.sent(L, "walk", []);

  J.step("sign and Finish");
  const done = await finish(srv, wo.id);
  J.ok(done.status === 200 && done.body.ok, `Finish succeeds (${done.status} ${j(done.body.errors)})`);
  const after = (await srv.api("GET", `/api/work-orders/${wo.id}`)).body;
  const signedFee = feeLine(after.workOrder?.onSiteQuote?.builderLineItems);
  J.ok(signedFee?.key === WALKED && Number(signedFee?.unitPrice ?? signedFee?.overridePrice ?? signedFee?.originalPrice) === shown.price,
    `the signed scope carries the price shown (${j(signedFee)})`);
  const billed = await srv.lib("billing.js").billingFor(srv.data("work-orders").find((w) => w.id === wo.id));
  J.ok(billed?.fee?.lockedAtSigning === true && billed?.fee?.after?.price === shown.price, `…and billing reads it as frozen at signing (${j(billed?.fee)})`);
  J.ok(after.workOrder?.signature?.signed === true, "the signature is on file");
  const inv = invoiceFor(srv, wo.id);
  const fee = feeLine(inv?.lineItems);
  J.ok(fee?.key === WALKED && fee?.unitPrice === shown.price, `the invoice bills the price shown at signing (${j(fee)})`);
  J.ok(!(inv?.lineItems || []).some((l) => l.key === BOOKED), "…and never the booked 1-4 zone line");
  J.ok(inv?.total === withTax(srv, shown.price), `invoice total = that price + HST (${inv?.total})`);
  J.ok(inv?.status === "draft" && inv?.paidOnSiteAtCompletion === true, `paid-on-site: a draft waiting for the payment (${j([inv?.status, inv?.paidOnSiteAtCompletion])})`);
  const mail = await J.sent(L, "finish", [
    { channel: "email", to: "walt@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);
  const cust = mail.find((m) => m.to.includes("walt@"));
  J.ok(cust && strip(cust.html).includes(`$${inv.total.toFixed(2)}`), `the completion email shows the same total ($${inv?.total})`);
  J.ok(cust && !strip(cust.html).includes(`$${withTax(srv, priceOf(BOOKED)).toFixed(2)}`), "…not the booked price");

  J.step("paid on site");
  const link = await payLink(srv, inv.id);
  J.ok(link.res.status === 200 && Boolean(link.token), `the tech can open a pay link on site (${link.res.status})`);
  const page = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${encodeURIComponent(link.token || "")}`);
  const due = Number(page.body.invoice?.balanceDue ?? page.body.balanceDue);
  J.ok(page.status === 200 && due === inv.total, `the pay page asks for the same balance (${due})`);
  await J.sent(L, "pay link", []);
  const cash = await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: inv.total, method: "cash", receivedAt: new Date().toISOString(), notes: "" });
  J.ok(cash.status === 200 || cash.status === 201, `cash for the balance is recorded (${cash.status} ${j(cash.body.errors)})`);
  await sleep(400);
  const paid = (await srv.api("GET", `/api/invoices/${inv.id}`)).body.invoice;
  J.ok(paid?.status === "paid" && Number(paid?.balanceDue) === 0 && Number(paid?.amountPaid) === inv.total, `the invoice is paid in full (${j([paid?.status, paid?.amountPaid, paid?.balanceDue])})`);
  // Cash recorded by staff emails nothing today (a card payment sends a
  // receipt — journey 4). Pinned as it is; whether cash should get a
  // receipt too is a question for Patrick, not something to assume.
  await J.sent(L, "payment", []);
  J.ok(invoicesFor(srv, wo.id).length === 1, `one invoice for the visit (${invoicesFor(srv, wo.id).length})`);
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

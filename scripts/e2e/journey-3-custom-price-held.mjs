#!/usr/bin/env node
// scripts/e2e/journey-3-custom-price-held.mjs
//
// JOURNEY 3 — a 16-zone residential system: a custom price Patrick sets.
// Nothing is payable, sent or texted until he confirms it, and confirming
// sends nothing by itself — he uses Send when ready (Patrick, 2026-09-26).
//
//   book 16 zones        → booked as the custom tier; no price promised
//   walk 16, preview     → the tech sees "PJL will price it", no number
//   Finish (Bill later)  → a draft invoice prefilled with the suggestion,
//                          flagged unconfirmed; the customer's completion
//                          email names no price; NO invoice text, ever
//   held                 → no pay link, no Tap to Pay, no Send, and the
//                          pay page takes no card
//   reopen from the day  → opens the held invoice
//   Confirm price        → a tech can't; Patrick can, at his own number.
//                          Nothing goes to the customer
//   Send (Patrick)       → one invoice email at the confirmed price; its
//                          pay link asks for exactly that
//
// Run: node scripts/e2e/journey-3-custom-price-held.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, priceAtSigning, finish, reopen,
  invoiceFor, invoicesFor, feeLine, withTax, payLink, textInvoicesImmediately, dayOut, strip, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-3 16 zones · custom price held · Confirm sends nothing · manual Send");
const srv = await bootServer({ port: 4933 });
const L = srv.ledger();
try {
  await srv.login();
  // So a text that shouldn't exist would show at once, not in 5 minutes.
  textInvoicesImmediately(srv);
  const PHONE = "9055550143";

  J.step("book 16 zones");
  const { lead, res } = await book(srv, {
    serviceKey: "fall_close_16plus", zoneCount: 16, day: dayOut(12),
    contact: { name: "Sixteen Zones", email: "sixteen@example.com", phone: PHONE, address: "17250 Yonge St, Newmarket, ON L3Y 4W5" }
  });
  J.ok(res.booking?.workOrder?.customQuote === true || /custom|quote/i.test(res.booking?.workOrder?.priceLabel || ""), `booked as a custom price (${j(res.booking?.workOrder)})`);
  await J.sent(L, "booking", [
    { channel: "email", to: "sixteen@example.com", subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);

  J.step("walk 16 zones");
  const wo = await openWorkOrder(srv, lead.id);
  // The app reads the work order right after opening it (getWorkOrder);
  // that read is where the fee line is built.
  const seeded = feeLine((await srv.api("GET", `/api/work-orders/${wo.id}`)).body.workOrder?.onSiteQuote?.builderLineItems);
  J.ok(seeded?.priceStatus === "pending" && seeded?.originalPrice == null, `the work order's fee line is price-pending, no number (${j(seeded)})`);
  await walkTheSystem(srv, wo.id, { walked: 16, paidOnSite: false });
  const shown = await priceAtSigning(srv, wo.id);
  J.ok(shown?.pending === true && shown?.price === null, `the tech's preview: PJL will price it (${j(shown)})`);
  await J.sent(L, "walk", []);

  J.step("Finish");
  const done = await finish(srv, wo.id);
  J.ok(done.status === 200 && done.body.ok, `Finish succeeds (${done.status} ${j(done.body.errors)})`);
  const drafted = invoiceFor(srv, wo.id);
  const full = (await srv.api("GET", `/api/invoices/${drafted?.id}`)).body.invoice;
  const suggested = feeLine(full?.lineItems)?.unitPrice;
  J.ok(full?.status === "draft" && full?.priceUnconfirmed === true, `a draft, flagged price-unconfirmed (${j([full?.status, full?.priceUnconfirmed, full?.priceConfirm])})`);
  J.ok(Number(suggested) > 0, `prefilled with a suggestion for Patrick (${suggested})`);
  const mail = await J.sent(L, "finish", [
    { channel: "email", to: "sixteen@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);
  const cust = mail.find((m) => m.to.includes("sixteen@"));
  J.ok(cust && /PJL will confirm the price/.test(strip(cust.html)) && !/Total for today/.test(strip(cust.html)), "the completion email names no price");
  J.ok(cust && !strip(cust.html).includes(`$${Number(suggested).toFixed(2)}`) && !strip(cust.html).includes(`$${full.total.toFixed(2)}`), "…not even the suggestion");
  J.ok(!full.customerSmsScheduledAt && (full.history || []).some((h) => h.action === "customer_sms_not_scheduled_price_set_by_pjl"),
    `no invoice text is scheduled, and the history says why (${j(full.customerSmsScheduledAt)})`);

  J.step("held until confirmed");
  const link = await srv.api("POST", `/api/invoices/${full.id}/payment-link`, {});
  J.ok(link.status === 409 && link.body.code === "needs_pricing", `no pay link (${link.status} ${link.body.code})`);
  const tap = await srv.api("POST", `/api/invoices/${full.id}/terminal-intent`, {});
  J.ok(tap.status === 409 && tap.body.code === "needs_pricing", `no Tap to Pay (${tap.status} ${tap.body.code})`);
  const send = await srv.api("POST", `/api/invoices/${full.id}/send`, {});
  J.ok(send.status === 409 && send.body.code === "price_unconfirmed", `no Send (${send.status} ${send.body.code})`);
  // The customer somehow holding a pay token still can't be charged.
  const tokened = srv.data("invoices").find((i) => i.id === full.id);
  if (tokened?.paymentToken) {
    const intent = await srv.api("POST", `/api/pay/invoice/${full.id}/payment-intent`, { t: tokened.paymentToken });
    J.ok(intent.status === 409, `the pay page takes no card (${intent.status})`);
  } else {
    J.ok(tokened && !tokened.paymentToken, "no pay token exists at all, so there is no pay page to reach");
  }
  await J.sent(L, "held", []);   // not one Stripe call, email or text

  J.step("reopen from the day");
  const back = await reopen(srv, wo.id);
  J.ok(back.opensInvoice && back.invoice.id === full.id && back.invoice.priceUnconfirmed === true, `the app reopens on the held invoice (${back.invoice?.id} ${back.invoice?.priceUnconfirmed})`);
  await J.sent(L, "reopen", []);

  J.step("Confirm price");
  const PATRICKS = Number(suggested) + 15;   // his own number, not the suggestion
  await srv.login({ role: "tech" });
  const techTry = await srv.api("POST", `/api/invoices/${full.id}/confirm-price`, { amount: PATRICKS });
  J.ok(techTry.status === 403, `a tech can't set the price (${techTry.status})`);
  await srv.login();
  const conf = await srv.api("POST", `/api/invoices/${full.id}/confirm-price`, { amount: PATRICKS });
  J.ok(conf.status === 200 && conf.body.invoice?.priceUnconfirmed === false, `Patrick confirms (${conf.status} ${j(conf.body.errors)})`);
  J.ok(feeLine(conf.body.invoice?.lineItems)?.unitPrice === PATRICKS && conf.body.invoice?.total === withTax(srv, PATRICKS), `at his price, + HST (${conf.body.invoice?.total})`);
  J.ok(conf.body.invoice?.status === "draft" && !conf.body.invoice?.sentAt, "…still a draft: confirming is not sending");
  await J.sent(L, "confirm", [], { settleMs: 1200 });   // NOTHING to the customer
  const rec = (await srv.api("GET", `/api/invoices/${full.id}`)).body.invoice;
  J.ok(!rec.customerSmsScheduledAt && !rec.customerSmsSentAt, "no invoice text scheduled after confirming either");

  J.step("Send");
  const sent = await srv.api("POST", `/api/invoices/${full.id}/send`, {});
  J.ok(sent.status === 200 && sent.body.invoice?.status === "sent", `Send works now (${sent.status} ${sent.body.invoice?.status})`);
  const out = await J.sent(L, "send", [{ channel: "email", to: "sixteen@example.com", subject: new RegExp(`Your invoice .*\\$${withTax(srv, PATRICKS).toFixed(2).replace(".", "\\.")}`) }]);
  const url = (out[0]?.text || "").match(/http:\/\/127\.0\.0\.1:\d+\/pay\/invoice\/[^\s"]+/)?.[0];
  const t = url ? new URL(url).searchParams.get("t") : "";
  const page = await srv.api("GET", `/api/pay/invoice/${full.id}?t=${encodeURIComponent(t)}`);
  J.ok(Number(page.body.invoice?.balanceDue ?? page.body.balanceDue) === withTax(srv, PATRICKS), `the emailed pay link asks for the confirmed price (${j(page.body.invoice?.balanceDue ?? page.body.balanceDue)})`);
  J.ok(invoicesFor(srv, wo.id).length === 1, "one invoice for the visit");
  await J.sent(L, "after send", [], { settleMs: 1000 });
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

#!/usr/bin/env node
// scripts/e2e/journey-1-new-customer-bill-later.mjs
//
// JOURNEY 1 — a new customer, a 4-zone fall closing, Bill Later.
//
//   book (new customer)  → the customer gets a confirmation email + text,
//                          Patrick gets the booking alert
//   Start on the day     → one work order, 4 declared zones, priced from
//                          the 1-4 zone tier
//   walk 4 zones, sign   → the price shown at signing is the tier price
//   Finish (Bill later)  → a DRAFT invoice for that price + HST; the
//                          customer's "complete" email, Patrick's alert;
//                          the "invoice ready" text fires on its timer
//                          (FINDING: it says the invoice was emailed; it
//                          wasn't — reported, not pinned, until decided)
//   reopen from the day  → the app opens that invoice, not the web record
//   Send (Patrick)       → one invoice email with a working pay link; the
//                          pay page shows the same balance
//   Finish again         → nothing new: no second invoice, no second message
//
// Every email/SMS/Stripe call is accounted for step by step (srv.ledger).
//
// Run: node scripts/e2e/journey-1-new-customer-bill-later.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, priceAtSigning, finish, reopen,
  invoiceFor, invoicesFor, feeLine, priceOf, withTax, payLink, textInvoicesImmediately, dayOut, strip, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-1 new customer · 4 zones · Bill later");
const srv = await bootServer({ port: 4931 });
const L = srv.ledger();
try {
  await srv.login();
  textInvoicesImmediately(srv);
  await J.sent(L, "boot", []);
  const TIER = "fall_close_4z";
  const PHONE = "9055550141";

  J.step("book a new customer");
  const { lead } = await book(srv, {
    serviceKey: TIER, zoneCount: 4, day: dayOut(10),
    contact: { name: "Nora Newcustomer", email: "nora@example.com", phone: PHONE, address: "851 Hilton Blvd, Newmarket, ON L3X 2M9" }
  });
  J.ok(Boolean(lead?.customerId), "the booking made a customer record");
  J.ok(srv.data("customers").length === 1, `exactly one customer (${srv.data("customers").length})`);
  await J.sent(L, "booking", [
    { channel: "email", to: "nora@example.com", subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);

  J.step("start the visit");
  const wo = await openWorkOrder(srv, lead.id);
  J.ok(wo.type === "fall_closing" && wo.customerId === lead.customerId && Boolean(wo.propertyId), `a fall closing on the new customer's property (${j([wo.type, wo.customerId, wo.propertyId])})`);
  J.ok((wo.zones || []).length === 4, `4 declared zones carried from the booking (${(wo.zones || []).length})`);
  const again = await openWorkOrder(srv, lead.id);
  J.ok(again.id === wo.id, "a second tap opens the same work order");
  await J.sent(L, "start", []);

  J.step("walk and sign");
  await walkTheSystem(srv, wo.id, { walked: 4, paidOnSite: false });
  const shown = await priceAtSigning(srv, wo.id);
  J.ok(shown?.key === TIER && shown?.price === priceOf(TIER), `the customer is shown the 1-4 zone price at signing (${j(shown)})`);

  J.step("Finish (Bill later)");
  const done = await finish(srv, wo.id);
  J.ok(done.status === 200 && done.body.ok, `Finish succeeds (${done.status} ${j(done.body.errors)})`);
  J.ok(done.body.cascade?.invoiceId && done.body.cascade?.noCharge === false, `the app is handed the drafted invoice (${j(done.body.cascade)})`);
  const inv = invoiceFor(srv, wo.id);
  J.ok(inv?.status === "draft", `the invoice is a draft — Bill later waits for Patrick (${inv?.status})`);
  J.ok(feeLine(inv?.lineItems)?.key === TIER && feeLine(inv?.lineItems)?.unitPrice === shown?.price, `billed the price shown at signing (${j(feeLine(inv?.lineItems))})`);
  J.ok(inv?.total === withTax(srv, priceOf(TIER)), `total is that price plus HST (${inv?.total})`);
  const finishMail = await J.sent(L, "finish", [
    { channel: "email", to: "nora@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ },
    { channel: "sms", to: PHONE, text: /invoice/i }
  ]);
  const custMail = finishMail.find((m) => m.channel === "email" && m.to.includes("nora@"));
  J.ok(custMail && new RegExp(String(inv?.total?.toFixed(2)).replace(".", "\\.")).test(strip(custMail.html)), "the completion email shows the invoice total");
  const text = finishMail.find((m) => m.channel === "sms");
  J.ok(text && /http:\/\/127\.0\.0\.1:\d+\//.test(text.body) && !/pjllandservices\.com/.test(text.body), `the invoice text links to this server, never production (${text?.body})`);
  const afterText = (await srv.api("GET", `/api/invoices/${inv.id}`)).body.invoice;
  J.ok(Boolean(afterText?.customerSmsSentAt), "…and the invoice records it was texted");
  const portalLink = (text?.body || "").match(/\/portal\/invoice\/([^?\s]+)\?t=([^\s]+)/);
  const portalView = portalLink ? (await srv.api("GET", `/api/portal/invoice/${portalLink[1]}?t=${portalLink[2]}`)).body.invoice : null;
  J.ok(portalView?.id === inv.id && portalView?.total === inv.total, `the texted link opens this invoice in the portal (${j([portalView?.id, portalView?.total])})`);
  J.ok(portalView?.status === "draft" && portalView?.payUrl === null, `…still a draft with no Pay button (${j([portalView?.status, portalView?.payUrl])})`);
  J.finding(!(/has been emailed to you/.test(text?.body || "") && !afterText?.sentAt),
    "Bill later: the invoice text says \"Your invoice … has been emailed to you … check spam/junk\", but the invoice is still a draft nobody has sent, and its portal page has no Pay button until Patrick sends it");

  J.step("reopen from the day");
  const back = await reopen(srv, wo.id);
  J.ok(back.wo.status === "completed" && back.wo.locked === true, `the work order is completed and locked (${back.wo.status} ${back.wo.locked})`);
  J.ok(back.opensInvoice && back.invoice.id === inv.id, `the app reopens it on its invoice (${back.invoice?.id})`);
  J.ok(Number(back.invoice?.balanceDue) === inv.total, `…showing the full balance owing (${back.invoice?.balanceDue})`);
  await J.sent(L, "reopen", []);

  J.step("Patrick sends it");
  const sent = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
  J.ok(sent.status === 200 && sent.body.invoice?.status === "sent", `Send works (${sent.status} ${sent.body.invoice?.status})`);
  const mail = await J.sent(L, "send", [{ channel: "email", to: "nora@example.com", subject: /Your invoice/ }]);
  const link = (mail[0]?.text || "").match(/http:\/\/127\.0\.0\.1:\d+\/pay\/invoice\/[^\s"]+/)?.[0];
  J.ok(Boolean(link), "the invoice email carries a pay link on this server");
  const t = link ? new URL(link).searchParams.get("t") : "";
  const page = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${encodeURIComponent(t)}`);
  J.ok(page.status === 200 && Number(page.body.invoice?.balanceDue ?? page.body.balanceDue) === inv.total, `the customer's pay page shows the same balance (${page.status} ${j(page.body.invoice?.balanceDue ?? page.body.balanceDue)})`);
  const again2 = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
  J.ok(again2.status !== 200 || again2.body.alreadySent === true, `a second Send doesn't email again (${again2.status})`);
  await J.sent(L, "send again", []);

  J.step("Finish tapped again");
  const retry = await finish(srv, wo.id, { signature: null });
  J.ok(retry.status === 200 || retry.status === 409, `a retried Finish is safe (${retry.status})`);
  await sleep(300);
  J.ok(invoicesFor(srv, wo.id).length === 1, `still exactly one invoice (${invoicesFor(srv, wo.id).length})`);
  await J.sent(L, "finish again", []);
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

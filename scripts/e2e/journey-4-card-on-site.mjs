#!/usr/bin/env node
// scripts/e2e/journey-4-card-on-site.mjs
//
// JOURNEY 4 — "Paid on site" by card, through the pay page the tech opens
// for the customer (the app's invoicePaymentLink). Stripe is stubbed; each
// outcome is one the real Stripe produces.
//
//   A. approved          intent for the server's balance → card approved →
//                        confirm → paid once, one receipt. The same webhook
//                        delivered twice changes nothing and sends nothing.
//                        A second Pay tap is refused, no second intent.
//   B. declined          the decline is recorded with a customer message,
//                        the invoice stays owing and payable; the Stripe
//                        failure webhook doesn't record it twice; another
//                        card on the same intent then pays it
//   C. timeout           (1) Stripe unreachable when Pay is tapped: nothing
//                        created, nothing charged, a clear message; works
//                        once Stripe answers. (2) the customer paid but
//                        their page died before confirming: the webhook
//                        backstop marks it paid and sends the receipt.
//                        (3) Stripe unreachable at confirm: not marked
//                        paid on the browser's word; the retry settles it
//   D. double payment    the pay page and Tap to Pay both succeed for one
//                        invoice: paid ONCE in the ledger, the second is
//                        flagged "needs a manual refund", and PJL never
//                        refunds anything by itself
//   E. refund            a refund made in the Stripe dashboard does not
//                        change the invoice by itself; Patrick reverses the
//                        payment in the ledger, which calls no one
//
// Run: node scripts/e2e/journey-4-card-on-site.mjs

import { bootServer, journey, finish, invoiceFor, payLink, strip, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-4 paid on site by card · approved / declined / timeout / duplicates / refund");
const srv = await bootServer({ port: 4934 });
const L = srv.ledger();
const STRIPE_READS = { channel: "stripe", method: "GET", path: /^\/v1\/payment_intents\/pi_/, n: "*" };
try {
  await srv.login();
  await J.sent(L, "boot", []);

  // A finished "Paid on site" closing, and the pay page the tech opens.
  let n = 0;
  async function visit(label) {
    n += 1;
    const email = `card${n}@example.com`;
    const f = await srv.fixture({ zones: 4, email, name: `Card ${label}`, phone: `90555502${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    const inv = invoiceFor(srv, f.wo.id);
    const custEmail = f.cust.email;
    await J.sent(L, `${label}: finish`, [
      { channel: "email", to: custEmail, subject: /complete/i },
      { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
    ]);
    const link = await payLink(srv, inv.id);
    J.ok(link.res.status === 200 && link.token, `${label}: the tech opens the pay page on site (${link.res.status})`);
    return { inv, t: link.token, email: custEmail };
  }
  const tapPay = (v) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-intent`, { t: v.t });
  const confirm = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/charge`, { t: v.t, paymentIntentId: pi });
  const reportFail = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-failed`, { t: v.t, paymentIntentId: pi });
  const read = async (v) => (await srv.api("GET", `/api/invoices/${v.inv.id}`)).body.invoice;
  const intentOf = (id, metadata) => ({ id, object: "payment_intent", metadata });
  const cents = (v) => String(Math.round(v.inv.total * 100));

  // ---- A. approved ------------------------------------------------------------
  J.step("A. approved");
  const a = await visit("A");
  const ia = await tapPay(a);
  J.ok(ia.status === 200 && ia.body.paymentIntentId, `Pay tapped: an intent is created (${ia.status} ${j(ia.body.errors)})`);
  await J.sent(L, "A: intent", [{ channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 }, STRIPE_READS]);
  const formA = srv.outbox().filter((e) => e.channel === "stripe" && e.method === "POST" && e.path === "/v1/payment_intents").pop()?.form || {};
  J.ok(formA.amount === cents(a), `…for the server's balance (${formA.amount} vs ${cents(a)})`);
  J.ok(formA["metadata[invoiceId]"] === a.inv.id, "…tied to this invoice");
  srv.stripeSucceed(ia.body.paymentIntentId);
  const ca = await confirm(a, ia.body.paymentIntentId);
  J.ok(ca.status === 200 && ca.body.invoice?.status === "paid" && !ca.body.alreadyPaid, `confirmed: paid (${ca.status} ${j(ca.body)})`);
  let recA = await read(a);
  J.ok((recA.payments || []).length === 1 && recA.payments[0].method === "card_qb" && Number(recA.payments[0].amount) === a.inv.total, `one card payment for the total (${j(recA.payments)})`);
  J.ok(Number(recA.balanceDue) === 0, "nothing owing");
  await J.sent(L, "A: paid", [{ channel: "email", to: a.email, subject: /receipt|payment/i }, STRIPE_READS]);

  J.step("A. duplicate webhook");
  for (let k = 0; k < 2; k++) {
    const w = await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: intentOf(ia.body.paymentIntentId, { invoiceId: a.inv.id }) } });
    J.ok(w.status === 200, `webhook delivery ${k + 1} acknowledged (${w.status})`);
  }
  await sleep(500);
  recA = await read(a);
  J.ok((recA.payments || []).length === 1 && Number(recA.amountPaid) === a.inv.total, `still ONE payment after the same event twice (${(recA.payments || []).length} · ${recA.amountPaid})`);
  J.ok((recA.paymentAttempts || []).filter((x) => x.outcome === "success").length === 1, "one success attempt on record");
  await J.sent(L, "A: duplicate webhooks", [STRIPE_READS]);   // no second receipt
  const again = await tapPay(a);
  J.ok(again.status === 409, `a second Pay tap is refused: already paid (${again.status})`);
  await J.sent(L, "A: pay again", [STRIPE_READS]);             // no new intent

  // ---- B. declined -------------------------------------------------------------
  J.step("B. declined");
  const b = await visit("B");
  const ib = await tapPay(b);
  const pib = ib.body.paymentIntentId;
  srv.stripeMode(pib, "declined");
  const fb = await reportFail(b, pib);
  J.ok(fb.status === 200 && fb.body.recorded === true, `the decline is recorded (${j(fb.body)})`);
  J.ok(/declined/i.test(fb.body.errors?.[0] || ""), `…and the customer is told their card was declined (${fb.body.errors?.[0]})`);
  let recB = await read(b);
  J.ok(recB.status !== "paid" && Number(recB.balanceDue) === b.inv.total && (recB.payments || []).length === 0, `still owing in full, no payment (${j([recB.status, recB.balanceDue])})`);
  const wb = await srv.stripeWebhook({ type: "payment_intent.payment_failed", data: { object: { ...intentOf(pib, { invoiceId: b.inv.id }), last_payment_error: { code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." } } } });
  J.ok(wb.status === 200, "Stripe's failure webhook is acknowledged");
  await sleep(400);
  recB = await read(b);
  J.ok((recB.paymentAttempts || []).filter((x) => x.outcome === "failure").length === 1, `…and the decline is not recorded twice (${(recB.paymentAttempts || []).length})`);
  const retry = await tapPay(b);
  J.ok(retry.status === 200 && retry.body.paymentIntentId === pib, `another card: the same intent is reused, no second one (${retry.body.paymentIntentId})`);
  srv.stripeMode(pib, "succeeded");
  const cb = await confirm(b, pib);
  J.ok(cb.status === 200 && cb.body.invoice?.status === "paid", `the second card pays it (${cb.status})`);
  await J.sent(L, "B: decline then paid", [
    { channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 },
    { channel: "email", to: b.email, subject: /receipt|payment/i },
    STRIPE_READS
  ]);

  // ---- C. timeouts --------------------------------------------------------------
  J.step("C1. Stripe unreachable at Pay");
  const c = await visit("C");
  srv.stripeMode("*", "unreachable");
  const ic = await tapPay(c);
  J.ok(ic.status === 502 && ic.body.errors?.[0] && !/declined/i.test(ic.body.errors[0]), `a clear "couldn't reach payments" answer, not a decline (${ic.status} ${ic.body.errors?.[0]})`);
  let recC = await read(c);
  J.ok(!recC.stripePaymentIntentId && (recC.payments || []).length === 0 && recC.status !== "paid", "nothing created, nothing charged");
  await J.sent(L, "C1: unreachable", [{ channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 }]);
  srv.stripeMode("*", null);

  J.step("C2. paid, then the page died");
  const ic2 = await tapPay(c);
  J.ok(ic2.status === 200, `with Stripe back, Pay works (${ic2.status})`);
  srv.stripeSucceed(ic2.body.paymentIntentId);
  // No confirm POST ever arrives. Stripe's webhook is the backstop.
  recC = await read(c);
  J.ok(recC.status !== "paid", "before the webhook: not paid (the server never takes the browser's word)");
  const wc = await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: intentOf(ic2.body.paymentIntentId, { invoiceId: c.inv.id }) } });
  J.ok(wc.status === 200, "the webhook is acknowledged");
  await sleep(700);
  recC = await read(c);
  J.ok(recC.status === "paid" && (recC.payments || []).length === 1, `the webhook backstop marks it paid, once (${j([recC.status, (recC.payments || []).length])})`);
  await J.sent(L, "C2: webhook backstop", [
    { channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 },
    { channel: "email", to: c.email, subject: /receipt|payment/i },
    STRIPE_READS
  ]);

  J.step("C3. Stripe unreachable at confirm");
  const c3 = await visit("C3");
  const i3 = await tapPay(c3);
  srv.stripeSucceed(i3.body.paymentIntentId);
  srv.stripeMode(i3.body.paymentIntentId, "unreachable");
  const x3 = await confirm(c3, i3.body.paymentIntentId);
  J.ok(x3.status === 502 && x3.body.ok === false, `confirm can't reach Stripe: not marked paid (${x3.status} ${x3.body.errors?.[0]})`);
  J.ok((await read(c3)).status !== "paid", "…the invoice is still owing");
  srv.stripeMode(i3.body.paymentIntentId, null);
  const y3 = await confirm(c3, i3.body.paymentIntentId);
  J.ok(y3.status === 200 && y3.body.invoice?.status === "paid", `the retry settles it (${y3.status})`);
  J.ok(((await read(c3)).payments || []).length === 1, "one payment");
  await J.sent(L, "C3: unreachable at confirm", [
    { channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 },
    { channel: "email", to: c3.email, subject: /receipt|payment/i },
    STRIPE_READS
  ]);

  // ---- D. double payment --------------------------------------------------------
  J.step("D. pay page and Tap to Pay both succeed");
  const d = await visit("D");
  const onPage = await tapPay(d);
  const tap = await srv.api("POST", `/api/invoices/${d.inv.id}/terminal-intent`, {});
  J.ok(onPage.status === 200 && tap.status === 200 && onPage.body.paymentIntentId !== tap.body.paymentIntentId, "two intents open at once (the customer's page and the tech's reader)");
  srv.stripeSucceed(onPage.body.paymentIntentId);
  srv.stripeSucceed(tap.body.paymentIntentId);
  const fin = await srv.api("POST", `/api/invoices/${d.inv.id}/terminal-intent/finalize`, { paymentIntentId: tap.body.paymentIntentId });
  J.ok(fin.status === 200 && fin.body.invoice?.status === "paid", `Tap to Pay settles it (${fin.status})`);
  const second = await confirm(d, onPage.body.paymentIntentId);
  J.ok(second.status === 200 && second.body.alreadyPaid === true && /manual refund/i.test(second.body.warning || ""), `the second success is flagged for a manual refund (${j(second.body.warning)})`);
  const recD = await read(d);
  J.ok((recD.payments || []).length === 1 && Number(recD.amountPaid) === d.inv.total, `paid ONCE in the ledger (${(recD.payments || []).length} · ${recD.amountPaid})`);
  await J.sent(L, "D: double payment", [
    { channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 2 },
    { channel: "email", to: d.email, subject: /receipt|payment/i },
    STRIPE_READS
  ]);   // and no /v1/refunds — PJL refunds nothing by itself
  const flagged = (recD.history || []).some((h) => /double|refund/i.test(`${h.action} ${h.note}`)) || (recD.paymentAttempts || []).filter((x) => x.outcome === "success").length > 1;
  J.finding(flagged, "a double card payment (pay page + Tap to Pay, both approved) is only a server log line and a warning on whichever screen confirmed second — nothing reaches Patrick (no email, no CRM flag) telling him a refund is owed");

  // ---- E. refund ------------------------------------------------------------------
  J.step("E. refund");
  const e = await visit("E");
  const ie = await tapPay(e);
  srv.stripeSucceed(ie.body.paymentIntentId);
  await confirm(e, ie.body.paymentIntentId);
  await J.sent(L, "E: paid", [
    { channel: "stripe", method: "POST", path: "/v1/payment_intents", n: 1 },
    { channel: "email", to: e.email, subject: /receipt|payment/i },
    STRIPE_READS
  ]);
  const refunded = await srv.stripeWebhook({ type: "charge.refunded", data: { object: { id: `ch_${ie.body.paymentIntentId}`, object: "charge", payment_intent: ie.body.paymentIntentId, metadata: { invoiceId: e.inv.id }, amount_refunded: Number(cents(e)) } } });
  J.ok(refunded.status === 200, "a refund event from Stripe is acknowledged");
  await sleep(300);
  let recE = await read(e);
  J.ok(recE.status === "paid", `…but changes nothing by itself: still paid (${recE.status})`);
  const pay = (recE.payments || [])[0];
  const rev = await srv.api("DELETE", `/api/invoices/${e.inv.id}/payments/${pay?.id}`, { reason: "Refunded in Stripe — customer paid twice by mistake" });
  J.ok(rev.status === 200 && rev.body.removed?.id === pay?.id, `Patrick reverses the card payment in the ledger (${rev.status})`);
  recE = await read(e);
  J.ok(recE.status !== "paid" && Number(recE.balanceDue) === e.inv.total, `the balance is owing again (${j([recE.status, recE.balanceDue])})`);
  J.ok((recE.history || []).some((h) => h.action === "payment_reversed" && /Refunded in Stripe/.test(h.note)), "the history keeps why");
  await J.sent(L, "E: refund + reversal", []);   // not one call to Stripe, nothing to the customer
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

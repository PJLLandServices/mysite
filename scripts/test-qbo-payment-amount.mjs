#!/usr/bin/env node
// scripts/test-qbo-payment-amount.mjs
//
// QuickBooks receives what the invoice ledger applied, never the processor
// charge (Patrick, 2026-09-28).
//
// WHAT BROKE: after #332 the ledger applies a Stripe charge only up to what
// the invoice owes (any excess is a payment exception), but the finalizer's
// QuickBooks call kept its old rule: post the amount the intent was created
// for, and only when the charge equalled the invoice's total or balance.
//   - part cash, then the open pay page's card for the full total (S3):
//     QuickBooks was sent the FULL charge while the ledger applied only the
//     balance, so QuickBooks read the excess as payment of this invoice
//   - revised down (or up) while the pay page was open: the charge equalled
//     neither the new total nor the balance, so QuickBooks was sent NOTHING
//     although the ledger applied a payment
//
// THE RULE: one QuickBooks payment per decided Stripe payment, for exactly
// the amount the ledger applied (invoices.recordProcessorPayment's
// decision), linked to the invoice's QuickBooks invoice. Nothing applied
// (wholly excess, a duplicate, a reversed payment) → nothing sent.
//
// QuickBooks is the stubbed SANDBOX host (scripts/lib/stub-outbound.cjs);
// nothing leaves the machine.
//
// Run: node scripts/test-qbo-payment-amount.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, finish, invoiceFor, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---- one rule, in one place --------------------------------------------------------
{
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const fin = server.slice(server.indexOf("async function finalizeStripeInvoicePayment("));
  const body = fin.slice(0, fin.indexOf("\n}\n"));
  ok(/amountCents:\s*appliedCents/.test(body) && /appliedCents\s*=\s*Math\.round\(Number\(decided\.applied\)\s*\*\s*100\)/.test(body),
    "structure: the QuickBooks payment amount is the ledger's applied amount");
  ok(!/expectedCents/.test(body), "structure: …not the amount the intent was created for");
  ok((server.match(/quickbooks\.recordPaymentForInvoice\(/g) || []).length === 1, "structure: the Stripe finalizer is the only place a payment is posted to QuickBooks");
}

const srv = await bootServer({ port: 4945, env: { QB_CLIENT_ID: "stub", QB_CLIENT_SECRET: "stub", QB_ENVIRONMENT: "sandbox" } });
try {
  // "Connected": a (legacy plaintext) token file the server encrypts on first read.
  srv.writeData("quickbooks", { access_token: "stub", refresh_token: "stub", realmId: "stub-realm", expires_at: Date.now() + 864e5, refresh_expires_at: Date.now() + 864e6 });
  await srv.login();
  let n = 0;
  async function visit(label, { qb = true } = {}) {
    n += 1;
    const f = await srv.fixture({ zones: 4, email: `qbo${n}@example.com`, name: `Qbo ${label}`, phone: `90555506${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    const inv = invoiceFor(srv, f.wo.id);
    const link = await payLink(srv, inv.id);
    const v = { label, inv, t: link.token, qbId: qb ? `qbinv_${label}` : null };
    if (qb) linkQb(v);
    return v;
  }
  // The invoice as pushed to QuickBooks earlier (the id the push stores).
  function linkQb(v) {
    const all = srv.data("invoices");
    const rec = all.find((i) => i.id === v.inv.id);
    rec.quickbooksInvoiceId = v.qbId;
    srv.writeData("invoices", all);
  }
  const payIntent = (v) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-intent`, { t: v.t });
  const confirm = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/charge`, { t: v.t, paymentIntentId: pi });
  const ttp = (v) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent`, {});
  const ttpFin = (v, pi) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent/finalize`, { paymentIntentId: pi });
  const cash = (v, amount) => srv.api("POST", `/api/invoices/${v.inv.id}/payments`, { amount, method: "cash" });
  const read = async (v) => (await srv.api("GET", `/api/invoices/${v.inv.id}`)).body.invoice;
  const hook = (v, pi) => srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi, object: "payment_intent", metadata: { invoiceId: v.inv.id } } } });
  const settle = () => sleep(700);
  const qbPays = (from, v) => srv.outbox().slice(from).filter((e) => e.channel === "quickbooks" && e.method === "POST" && /\/payment$/.test(e.path)
    && (!v || (e.body?.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === v.qbId))));
  const amt = (e) => money(e?.body?.TotalAmt);
  const lineAmt = (e) => money(e?.body?.Line?.[0]?.Amount);
  const cards = (r) => (r?.payments || []).filter((p) => p.method === "card_qb");
  const applied = (r) => money(cards(r).reduce((a, p) => a + p.amount, 0));
  // One payment sent, for exactly what the ledger applied, linked to this invoice.
  function agrees(sent, r, want, label) {
    ok(sent.length === 1, `${label}: exactly one QuickBooks payment (${sent.length})`);
    ok(amt(sent[0]) === want && lineAmt(sent[0]) === want, `${label}: QuickBooks gets ${want}, what the ledger applied (${amt(sent[0])} / line ${lineAmt(sent[0])})`);
    ok(applied(r) === want, `${label}: …and the ledger applied ${want} from the card (${applied(r)})`);
  }

  // ---- Q1 exact: the card pays the whole invoice ------------------------------------
  const q1 = await visit("Q1");
  {
    const m0 = srv.outbox().length;
    const pi = (await payIntent(q1)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    const c = await confirm(q1, pi);
    const r = await read(q1);
    agrees(qbPays(m0, q1), r, money(q1.inv.total), "Q1 exact");
    ok(c.status === 200 && r.status === "paid" && /^qbpay_stub_\d+$/.test(r.quickbooksPaymentId || ""),
      `Q1: the invoice keeps the QuickBooks payment id (${r.quickbooksPaymentId})`);
    // ---- Q2 the same payment delivered again: webhook ×2, confirm again ----
    const m1 = srv.outbox().length;
    await hook(q1, pi); await hook(q1, pi); await confirm(q1, pi); await settle();
    ok(qbPays(m1, q1).length === 0, `Q2 duplicate delivery: no second QuickBooks payment (${qbPays(m1, q1).length})`);
  }

  // ---- Q3 partial: part cash, then the card for the balance -------------------------
  const q3 = await visit("Q3");
  {
    const part = money(q3.inv.total * 0.4);
    await cash(q3, part);
    const m0 = srv.outbox().length;
    const pi = (await payIntent(q3)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    await confirm(q3, pi);
    const r = await read(q3);
    agrees(qbPays(m0, q3), r, money(q3.inv.total - part), "Q3 partial");
    ok(r.status === "paid" && (r.paymentExceptions || []).length === 0, `Q3: paid, no exception (${r.status})`);
  }

  // ---- Q4 overpayment (S3): part cash, then the open page's card for the full total --
  const q4 = await visit("Q4");
  {
    const pi = (await payIntent(q4)).body.paymentIntentId;
    const part = money(q4.inv.total * 0.4);
    await cash(q4, part);
    const m0 = srv.outbox().length;
    srv.stripeSucceed(pi);
    await confirm(q4, pi);
    await hook(q4, pi); await settle();
    const r = await read(q4);
    const owed = money(q4.inv.total - part);
    agrees(qbPays(m0, q4), r, owed, "Q4 overpayment");
    const x = (r.paymentExceptions || [])[0] || {};
    ok(money(x.chargedTotal) === money(q4.inv.total) && money(x.excess) === part, `Q4: the excess stays a PJL payment exception, not a QuickBooks payment (${j([x.chargedTotal, x.applied, x.excess])})`);
  }

  // ---- Q5 wholly excess (#332): cash in full, then the open page's card -------------
  const q5 = await visit("Q5");
  {
    const pi = (await payIntent(q5)).body.paymentIntentId;
    await cash(q5, q5.inv.total);
    const m0 = srv.outbox().length;
    srv.stripeSucceed(pi);
    await confirm(q5, pi); await hook(q5, pi); await settle();
    const r = await read(q5);
    ok(qbPays(m0, q5).length === 0, `Q5 wholly excess: nothing was applied, so nothing goes to QuickBooks (${qbPays(m0, q5).length})`);
    ok((r.paymentExceptions || []).length === 1 && cards(r).length === 0, `Q5: it is one open payment exception (${(r.paymentExceptions || []).length})`);
  }

  // ---- Q6 revised down while the page was open (S7) --------------------------------
  const q6 = await visit("Q6");
  {
    await srv.api("POST", `/api/invoices/${q6.inv.id}/send`, {});
    linkQb(q6);
    const pi = (await payIntent(q6)).body.paymentIntentId;
    const full = await read(q6);
    const lines = full.lineItems.map((l, i) => (i === 0 ? { ...l, unitPrice: money(l.unitPrice * 0.8) } : l));
    const rev = await srv.api("POST", `/api/invoices/${q6.inv.id}/revise`, { lineItems: lines, reason: "discount agreed" });
    const newTotal = money(rev.body.invoice?.total);
    const m0 = srv.outbox().length;
    srv.stripeSucceed(pi);
    await confirm(q6, pi); await settle();
    const r = await read(q6);
    ok(rev.status === 200 && newTotal < money(q6.inv.total), `Q6: revised down to ${newTotal} (${rev.status})`);
    agrees(qbPays(m0, q6), r, newTotal, "Q6 revised down");
  }

  // ---- Q7 revised up while the page was open ---------------------------------------
  const q7 = await visit("Q7");
  {
    await srv.api("POST", `/api/invoices/${q7.inv.id}/send`, {});
    linkQb(q7);
    const pi = (await payIntent(q7)).body.paymentIntentId;
    const full = await read(q7);
    const lines = full.lineItems.map((l, i) => (i === 0 ? { ...l, unitPrice: money(l.unitPrice * 1.25) } : l));
    const rev = await srv.api("POST", `/api/invoices/${q7.inv.id}/revise`, { lineItems: lines, reason: "extra zone" });
    const m0 = srv.outbox().length;
    srv.stripeSucceed(pi);
    await confirm(q7, pi); await settle();
    const r = await read(q7);
    ok(rev.status === 200 && money(rev.body.invoice?.total) > money(q7.inv.total), `Q7: revised up (${rev.status} ${rev.body.invoice?.total})`);
    agrees(qbPays(m0, q7), r, money(q7.inv.total), "Q7 revised up (the old, smaller charge)");
    ok(r.status !== "paid" && r.balanceDue > 0, `Q7: the rest is still owing (${r.status} ${r.balanceDue})`);
  }

  // ---- Q8 Tap to Pay: the same rule --------------------------------------------------
  const q8 = await visit("Q8");
  {
    const part = money(q8.inv.total * 0.25);
    await cash(q8, part);
    const m0 = srv.outbox().length;
    const pi = (await ttp(q8)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    await ttpFin(q8, pi);
    const r = await read(q8);
    agrees(qbPays(m0, q8), r, money(q8.inv.total - part), "Q8 Tap to Pay");
  }

  // ---- Q9 QuickBooks fails after the ledger accepted the payment --------------------
  const q9 = await visit("Q9");
  {
    srv.quickbooksMode("fail");
    const m0 = srv.outbox().length;
    const pi = (await payIntent(q9)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    const c = await confirm(q9, pi);
    let r = await read(q9);
    const tries = qbPays(m0, q9);
    ok(tries.length === 1 && tries[0].failed === true && amt(tries[0]) === money(q9.inv.total), `Q9: one QuickBooks attempt, for the applied amount, and it failed (${tries.length})`);
    ok(c.status === 200 && r.status === "paid" && applied(r) === money(q9.inv.total), `Q9: the payment still stands on the ledger: money moved (${c.status} ${r.status})`);
    ok(!r.quickbooksPaymentId, `Q9: no QuickBooks payment id is recorded (${r.quickbooksPaymentId})`);
    srv.quickbooksMode(null);
    const m1 = srv.outbox().length;
    await hook(q9, pi); await confirm(q9, pi); await settle();
    r = await read(q9);
    ok(qbPays(m1, q9).length === 0, `Q9: a redelivery never posts it again (${qbPays(m1, q9).length}); the retry is "Push to QuickBooks" by hand`);
  }

  // ---- Q10 reversal (#348): nothing re-sent; a new payment sends its own amount ------
  const q10 = await visit("Q10");
  {
    const m0 = srv.outbox().length;
    const pi = (await payIntent(q10)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    await confirm(q10, pi);
    let r = await read(q10);
    ok(qbPays(m0, q10).length === 1, "Q10: the payment posts once");
    await srv.api("DELETE", `/api/invoices/${q10.inv.id}/payments/${cards(r)[0].id}`, { reason: "refunded in Stripe dashboard" });
    const m1 = srv.outbox().length;
    await hook(q10, pi); await confirm(q10, pi); await settle();
    ok(qbPays(m1, q10).length === 0, `Q10: the reversed payment redelivered posts nothing to QuickBooks (${qbPays(m1, q10).length})`);
    const pi2 = (await payIntent(q10)).body.paymentIntentId;
    srv.stripeSucceed(pi2);
    await confirm(q10, pi2);
    r = await read(q10);
    const sent = qbPays(m1, q10);
    ok(sent.length === 1 && amt(sent[0]) === money(q10.inv.total) && pi2 !== pi, `Q10: a new payment after the reversal posts its own applied amount (${sent.length} ${amt(sent[0])})`);
  }

  // ---- Q11 an invoice never pushed to QuickBooks: nothing to link to ----------------
  const q11 = await visit("Q11", { qb: false });
  {
    const m0 = srv.outbox().length;
    const pi = (await payIntent(q11)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    await confirm(q11, pi);
    const r = await read(q11);
    ok(qbPays(m0).length === 0 && r.status === "paid", `Q11: no QuickBooks invoice, no QuickBooks payment (${qbPays(m0).length})`);
  }

  ok(!srv.outbox().some((e) => e.channel === "refused" && /intuit/.test(e.host || "")), "no call to a real Intuit host was even attempted");
} finally {
  await srv.stop();
}

console.log(`\nquickbooks payment amount: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

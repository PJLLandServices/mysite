#!/usr/bin/env node
// scripts/test-payment-reversal.mjs
//
// S6 — a Stripe payment reversed in the ledger is never resurrected
// (Patrick, 2026-09-27).
//
// WHAT BROKE: reversing a payment (DELETE /api/invoices/:id/payments/:pid,
// "refunded in Stripe") deleted its ledger line, and that line was the
// only lasting record that the Stripe payment had been decided. The intent
// itself stays "succeeded" at Stripe after a refund, so any path that
// finalizes it again — the reopened pay page, a webhook retry, a confirm
// retry, a Tap to Pay retry — asked invoices.recordProcessorPayment "seen
// this payment?" and got no. The refunded money went back on the ledger,
// the invoice read Paid again and a second receipt went out; or, if a new
// payment had settled the invoice meanwhile, the refunded one opened a
// false payment exception and alerted the office.
//
// THE RULE: a processor payment id, once decided on an invoice, is tied to
// that invoice's history for good. Reversing it records the reversal
// (reversedProcessorPayments); every later delivery of the same payment is
// recognised as already handled and changes nothing: no ledger line, no
// Paid, no receipt, no exception, no alert. A different Stripe payment is
// handled normally.
//
// Run: node scripts/test-payment-reversal.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, finish, invoiceFor, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const ADMIN = "stub@pjl.test";

// ---- one rule, in one place --------------------------------------------------------
{
  const lib = fs.readFileSync(new URL("../server/lib/invoices.js", import.meta.url), "utf8");
  const rm = lib.slice(lib.indexOf("async function removePayment("));
  const rmBody = rm.slice(0, rm.indexOf("\n}\n"));
  ok(/reversedProcessorPayments/.test(rmBody), "structure: reversing a processor payment keeps its id on the invoice (reversedProcessorPayments)");
  const seen = lib.slice(lib.indexOf("function processorPaymentSeen("));
  const seenBody = seen.slice(0, seen.indexOf("\n}\n"));
  ok(/reversedProcessorPayments/.test(seenBody), "structure: the one \"already decided?\" rule reads the reversal record");
  ok(/removePayment: withStoreLock\(removePayment\)/.test(lib), "structure: a reversal is under the same store lock as the decision");
}

const srv = await bootServer({ port: 4944 });
try {
  await srv.login();
  let n = 0;
  async function visit(label) {
    n += 1;
    const email = `rev${n}@example.com`;
    const f = await srv.fixture({ zones: 4, email, name: `Rev ${label}`, phone: `90555505${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    const inv = invoiceFor(srv, f.wo.id);
    const link = await payLink(srv, inv.id);
    return { label, inv, t: link.token, email: f.cust.email };
  }
  const payIntent = (v) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-intent`, { t: v.t });
  const confirm = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/charge`, { t: v.t, paymentIntentId: pi });
  const ttp = (v) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent`, {});
  const ttpFin = (v, pi) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent/finalize`, { paymentIntentId: pi });
  const reverse = (v, pid) => srv.api("DELETE", `/api/invoices/${v.inv.id}/payments/${pid}`, { reason: "refunded in Stripe dashboard" });
  const read = async (v) => (await srv.api("GET", `/api/invoices/${v.inv.id}`)).body.invoice;
  const hook = (v, pi) => srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi, object: "payment_intent", metadata: { invoiceId: v.inv.id } } } });
  const settle = () => sleep(700);
  const mail = (from) => srv.outbox().slice(from).filter((m) => m.channel === "email");
  const receipts = (from, v) => mail(from).filter((m) => m.to === v.email && /Receipt/i.test(m.subject || ""));
  const alerts = (from, v) => mail(from).filter((m) => m.to === ADMIN && /refund|reconcil/i.test(m.subject || "") && (m.subject || "").includes(v.inv.id));
  const stripeCreates = (from) => srv.outbox().slice(from).filter((m) => m.channel === "stripe" && m.method === "POST" && m.path === "/v1/payment_intents");
  const exc = (r) => r?.paymentExceptions || [];
  const cards = (r) => (r?.payments || []).filter((p) => p.method === "card_qb");
  const hist = (r, action) => (r?.history || []).filter((h) => h.action === action);

  // Pay by the pay page, then reverse it. Returns the refunded intent.
  async function paidThenReversed(v, { tap = false } = {}) {
    let pi;
    if (tap) {
      pi = (await ttp(v)).body.paymentIntentId;
      srv.stripeSucceed(pi);
      const f = await ttpFin(v, pi);
      if (f.status !== 200) throw new Error(`ttp finalize ${f.status} ${j(f.body)}`);
    } else {
      pi = (await payIntent(v)).body.paymentIntentId;
      srv.stripeSucceed(pi);
      const c = await confirm(v, pi);
      if (c.status !== 200) throw new Error(`confirm ${c.status} ${j(c.body)}`);
    }
    const paid = await read(v);
    if (paid.status !== "paid") throw new Error(`${v.label}: not paid first (${paid.status})`);
    const rev = await reverse(v, cards(paid)[0].id);
    if (rev.status !== 200) throw new Error(`reverse ${rev.status} ${j(rev.body)}`);
    const after = await read(v);
    return { pi, total: paid.total, after };
  }
  // The invoice is as the reversal left it: nothing re-added.
  function unchanged(r, base, total, label) {
    ok(cards(r).length === 0, `${label}: the reversed payment is not re-added (${cards(r).length} card lines)`);
    ok(r.status !== "paid" && Math.abs(Number(r.balanceDue) - Number(total)) < 0.01, `${label}: the invoice stays unpaid with the full balance owing (${r.status}, ${r.balanceDue})`);
    ok(exc(r).length === 0, `${label}: no payment exception for the same refunded payment (${exc(r).length})`);
  }

  // ---- A pay page: every re-ingest path after the reversal ---------------------------
  const a = await visit("A");
  {
    const { pi, total, after } = await paidThenReversed(a);
    ok(hist(after, "payment_reversed").length === 1 && after.status !== "paid", `A: the reversal is recorded and un-pays the invoice (${after.status})`);
    ok((after.reversedProcessorPayments || []).some((x) => x.paymentIntentId === pi), `A: the reversal keeps the Stripe payment id on the invoice (${j(after.reversedProcessorPayments)})`);
    const m0 = srv.outbox().length;

    // A1 the customer reopens the pay page (the stored intent is the refunded one)
    const reopen = await payIntent(a);
    await settle();
    let r = await read(a);
    unchanged(r, after, total, "A1 reopened pay page");
    ok(reopen.status === 200 && reopen.body.paymentIntentId && reopen.body.paymentIntentId !== pi,
      `A1: the reopened page offers a NEW payment for what is owed, not the refunded one (${reopen.status} ${j(reopen.body)})`);

    // A2 Stripe redelivers the refunded payment's webhook, twice
    await hook(a, pi); await hook(a, pi); await settle();
    r = await read(a);
    unchanged(r, after, total, "A2 webhook retry");

    // A3 the pay page retries its confirm of the refunded payment
    const c = await confirm(a, pi);
    await settle();
    r = await read(a);
    unchanged(r, after, total, "A3 confirm retry");
    ok(c.status === 409 && c.body.code === "payment_reversed" && !/received|thank/i.test(c.body.errors?.[0] || ""),
      `A3: the confirm retry is refused as refunded, never shown as "Payment received" (${c.status} ${j(c.body)})`);

    ok(receipts(m0, a).length === 0, `A: no second receipt (${receipts(m0, a).length})`);
    ok(alerts(m0, a).length === 0, `A: no admin alert (${alerts(m0, a).length})`);
    const dupNotes = hist(r, "processor_payment_after_reversal");
    ok(dupNotes.length >= 1 && dupNotes.every((h) => String(h.note).includes(pi)), `A: each later delivery is kept in the audit history, naming the payment (${dupNotes.length})`);
    ok(hist(r, "payment_recorded").length === 1 && hist(r, "payment_reversed").length === 1, "A: the original payment and its reversal stay in the history");

    // A4 a genuinely new payment (different Stripe id) is handled normally
    const m1 = srv.outbox().length;
    const fresh = reopen.body.paymentIntentId;
    srv.stripeSucceed(fresh);
    const c2 = await confirm(a, fresh);
    await hook(a, fresh); await settle();
    r = await read(a);
    ok(c2.status === 200 && r.status === "paid" && cards(r).length === 1 && cards(r)[0].processorRef === fresh,
      `A4: a new Stripe payment pays the invoice normally (${c2.status} ${r.status} ${j(cards(r).map((p) => p.processorRef))})`);
    ok(receipts(m1, a).length === 1 && exc(r).length === 0 && alerts(m1, a).length === 0, `A4: …with one receipt and no exception (${receipts(m1, a).length}/${exc(r).length})`);
    // …and the refunded one still can't come back on top of it
    await hook(a, pi); await confirm(a, pi); await settle();
    r = await read(a);
    ok(cards(r).length === 1 && exc(r).length === 0 && alerts(m1, a).length === 0 && receipts(m1, a).length === 1,
      `A4: the refunded payment redelivered after the new one opens no exception and adds nothing (${cards(r).length}/${exc(r).length})`);
  }

  // ---- B the invoice settled by a different card before the refunded one reappears ---
  const b = await visit("B");
  {
    const { pi, total } = await paidThenReversed(b);
    const m0 = srv.outbox().length;
    const tap = (await ttp(b)).body.paymentIntentId;
    ok(tap && tap !== pi, `B: Tap to Pay starts a new payment after the reversal (${tap})`);
    srv.stripeSucceed(tap);
    const f = await ttpFin(b, tap);
    let r = await read(b);
    ok(f.status === 200 && r.status === "paid" && cards(r).length === 1 && Math.abs(r.amountPaid - total) < 0.01, `B: the new card pays the invoice (${f.status} ${r.status})`);
    await hook(b, pi); await confirm(b, pi); await payIntent(b); await settle();
    r = await read(b);
    ok(exc(r).length === 0, `B: the refunded payment reappearing is not a payment exception (${exc(r).length})`);
    ok(alerts(m0, b).length === 0, `B: …and alerts nobody (${alerts(m0, b).length})`);
    ok(cards(r).length === 1 && r.status === "paid" && Math.abs(r.amountPaid - total) < 0.01, `B: the ledger holds only the new payment (${cards(r).length}, ${r.amountPaid})`);
    ok(receipts(m0, b).length === 1, `B: one receipt, for the new payment (${receipts(m0, b).length})`);
  }

  // ---- C Tap to Pay: the reversed reader payment ------------------------------------
  const c = await visit("C");
  {
    const { pi, total, after } = await paidThenReversed(c, { tap: true });
    const m0 = srv.outbox().length;
    const f = await ttpFin(c, pi);
    await hook(c, pi); await settle();
    let r = await read(c);
    unchanged(r, after, total, "C finalize/webhook retry");
    ok(f.status === 409 && f.body?.code === "payment_reversed" && f.body?.invoice?.status !== "paid", `C: the finalize retry is refused as refunded, not reported Paid (${f.status} ${j(f.body?.code)})`);
    const again = await ttp(c);
    await settle();
    r = await read(c);
    unchanged(r, after, total, "C next tap");
    ok(again.status === 200 && again.body.paymentIntentId && again.body.paymentIntentId !== pi,
      `C: the next tap starts a new payment for what is owed (${again.status} ${j(again.body)})`);
    ok(receipts(m0, c).length === 0 && alerts(m0, c).length === 0, `C: no receipt, no alert (${receipts(m0, c).length}/${alerts(m0, c).length})`);
  }

  // ---- D the pay page's retry key never replays the refunded payment ----------------
  const d = await visit("D");
  {
    const { pi } = await paidThenReversed(d);
    const m0 = srv.outbox().length;
    const reopen = await payIntent(d);
    const creates = stripeCreates(m0);
    const key = creates[0]?.idempotencyKey || "";
    ok(creates.length === 1 && key && key.includes(pi),
      `D: the new intent's idempotency key names the payment it replaces, so Stripe can't hand back the refunded one (${creates.length} ${j(key)})`);
    ok(reopen.status === 200, `D: …and the page gets it (${reopen.status})`);
  }

  // ---- F two refunded cards: the older one must not come back as Paid ---------------
  // The invoice only remembers the LAST card's charge id (stripeChargeId), so
  // once a second card has paid and been refunded too, the first refunded
  // payment is recognised by nothing but its reversal.
  const f = await visit("F");
  {
    const { pi, total } = await paidThenReversed(f);
    const tap = (await ttp(f)).body.paymentIntentId;
    srv.stripeSucceed(tap);
    await ttpFin(f, tap);
    const paid2 = await read(f);
    await reverse(f, cards(paid2)[0].id);
    const after = await read(f);
    const m0 = srv.outbox().length;
    await hook(f, pi); await settle();
    const c1 = await confirm(f, pi);
    await payIntent(f); await ttp(f); await settle();
    const r = await read(f);
    unchanged(r, after, total, "F older refunded card redelivered");
    ok(c1.status === 409 && c1.body?.code === "payment_reversed", `F: the confirm retry is refused as refunded (${c1.status} ${j(c1.body?.code)})`);
    ok(receipts(m0, f).length === 0 && alerts(m0, f).length === 0, `F: no receipt, no alert (${receipts(m0, f).length}/${alerts(m0, f).length})`);
    ok((r.reversedProcessorPayments || []).map((x) => x.paymentIntentId).sort().join() === [pi, tap].sort().join(),
      `F: both reversals keep their Stripe payment ids (${j(r.reversedProcessorPayments)})`);
  }

  // ---- E cash reversed: no processor id, nothing to remember ------------------------
  const e = await visit("E");
  {
    const inv = await read(e);
    const add = await srv.api("POST", `/api/invoices/${e.inv.id}/payments`, { amount: inv.total, method: "cash" });
    const pid = add.body.invoice.payments[0].id;
    await reverse(e, pid);
    const r = await read(e);
    ok(r.status !== "paid" && (r.reversedProcessorPayments || []).length === 0, `E: reversing cash records no processor payment (${j(r.reversedProcessorPayments)})`);
  }
} finally {
  await srv.stop();
}

console.log(`\npayment reversal (S6): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

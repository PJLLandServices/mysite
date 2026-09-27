#!/usr/bin/env node
// scripts/test-payment-exceptions.mjs
//
// A second successful card payment is a financial exception, never a log
// line (Patrick, 2026-09-27; E2E journey 4's finding).
//
// WHAT BROKE: money that reached Stripe but not the invoice was hidden.
//   S1 pay page + Tap to Pay both approved → the second was a server log
//   S2 cash in full, then the open pay page's card approved → SILENT: the
//      pay page had stored its intent id, so the charge looked like a
//      repeat of the one that paid
//   S3 part cash, then the open pay page's card approved for the full
//      total → the ledger refused the card (over balance): the invoice
//      said $61.02 owing while the customer had overpaid $40.68
//   S4 cash in full, then the open Tap to Pay intent approved → a warning
//      on the phone only
//   S7 revised down while the pay page was open, card approved at the old
//      amount → refused as "wrong amount": $0 paid, $81.36 owing
//
// THE RULE (invoices.recordProcessorPayment, inside the invoice lock,
// keyed on the Stripe payment id). One distinct Stripe payment makes ONE
// accounting decision: apply up to what is owed; the excess, if any,
// becomes one open payment exception. A payment already decided is a
// no-op. So at most one receipt, one exception and one admin alert each.
//   S5 the same payment's webhook delivered twice → nothing new
//   S8 two confirms and the webhook for the same payment at once → one
//      payment, one receipt, no exception, no alert
//   S6 (a reversed payment re-recorded by a reopened pay page) is a
//      separate PR; here only: a reversal never raises a false exception
//
// The office sees it (the invoice, the list filter) and resolves it with
// a note (refunded / reconciled); the history is never deleted. The
// customer is never shown a negative balance, and on an overpayment sees
// neutral wording instead of the plain "Payment received".
//
// Run: node scripts/test-payment-exceptions.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, finish, invoiceFor, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const money = (n) => Math.round(Number(n) * 100) / 100;
const CUSTOMER_MESSAGE = "Payment received. We received more than the remaining invoice balance. PJL will review the extra amount and contact you if any action is required.";
const ADMIN = "stub@pjl.test";

// ---- one rule, in one place --------------------------------------------------------
{
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const fin = server.slice(server.indexOf("async function finalizeStripeInvoicePayment("));
  const body = fin.slice(0, fin.indexOf("\n}\n"));
  ok(/invoices\.recordProcessorPayment\(/.test(body), "structure: the Stripe finalizer records money through invoices.recordProcessorPayment");
  ok(!/invoices\.addPayment\(/.test(body) && !/fresh\.status === "paid"/.test(body), "structure: …and no longer decides duplicates by the invoice's status or stored intent id");
  const lib = fs.readFileSync(new URL("../server/lib/invoices.js", import.meta.url), "utf8");
  ok(/recordProcessorPayment: withStoreLock\(recordProcessorPayment\)/.test(lib), "structure: the decision is made inside the invoice store lock");
  ok(/resolvePaymentException: withStoreLock\(resolvePaymentException\)/.test(lib), "structure: resolving is under the same lock");
  const page = fs.readFileSync(new URL("../server/invoice.html", import.meta.url), "utf8");
  const pageJs = fs.readFileSync(new URL("../server/invoice.js", import.meta.url), "utf8");
  ok(/id="invoicePaymentExceptionsCard"[^>]*hidden/.test(page) && /Needs refund \/ reconciliation/.test(page), "office: the invoice page has the Needs refund / reconciliation card");
  ok(["Total charge", "Applied to invoice", "Excess", "Method / card", "Stripe payment", "Mark refunded", "Mark reconciled"].every((t) => pageJs.includes(t)) && /renderPaymentExceptionsCard\(inv\);/.test(pageJs),
    "office: …showing charge, applied, excess, method/card and Stripe id, with Mark refunded / Mark reconciled");
  const listHtml = fs.readFileSync(new URL("../server/invoices.html", import.meta.url), "utf8");
  const listJs = fs.readFileSync(new URL("../server/invoices.js", import.meta.url), "utf8");
  ok(/data-status-filter="needs_reconciliation"/.test(listHtml) && /needsReconciliation=1/.test(listJs) && /inv\.needsReconciliation/.test(listJs), "office: the invoice list has the Needs refund filter and row badge");
  const thanks = fs.readFileSync(new URL("../server/pay-thanks.html", import.meta.url), "utf8");
  ok(thanks.includes(CUSTOMER_MESSAGE.replace(/^Payment received\. /, "")), "the thanks page carries the approved overpayment wording");
}

const srv = await bootServer({ port: 4942 });
try {
  await srv.login();
  let n = 0;
  async function visit(label) {
    n += 1;
    const email = `pex${n}@example.com`;
    const f = await srv.fixture({ zones: 4, email, name: `Pex ${label}`, phone: `90555504${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    const inv = invoiceFor(srv, f.wo.id);
    const link = await payLink(srv, inv.id);
    return { label, inv, t: link.token, email: f.cust.email, wo: f.wo, name: `Pex ${label}` };
  }
  const tapPay = (v) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-intent`, { t: v.t });
  const confirm = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/charge`, { t: v.t, paymentIntentId: pi });
  const ttp = (v) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent`, {});
  const ttpFin = (v, pi) => srv.api("POST", `/api/invoices/${v.inv.id}/terminal-intent/finalize`, { paymentIntentId: pi });
  const cash = (v, amount) => srv.api("POST", `/api/invoices/${v.inv.id}/payments`, { amount, method: "cash" });
  const read = async (v) => (await srv.api("GET", `/api/invoices/${v.inv.id}`)).body.invoice;
  const hook = (v, pi) => srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi, object: "payment_intent", metadata: { invoiceId: v.inv.id } } } });
  const settle = () => sleep(700);
  const mail = (from) => srv.outbox().slice(from).filter((m) => m.channel === "email");
  const receipts = (from, v) => mail(from).filter((m) => m.to === v.email && /Receipt/i.test(m.subject || ""));
  const alerts = (from, v) => mail(from).filter((m) => m.to === ADMIN && /refund|reconcil/i.test(m.subject || "") && (m.subject || "").includes(v.inv.id));
  const exc = (r) => r?.paymentExceptions || [];
  const cardPayments = (r) => (r?.payments || []).filter((p) => p.method === "card_qb");
  const successAttempts = (r) => (r?.paymentAttempts || []).filter((a) => a.outcome === "success");
  const alertCarries = (m, v, e, extra = []) => {
    const body = `${m?.subject}\n${m?.text}\n${m?.html}`;
    const f2 = (n) => Number(n || 0).toFixed(2);
    return [v.inv.id, v.wo.id, v.name, e?.paymentIntentId || "(no exception)", f2(e?.chargedTotal), f2(e?.applied), f2(e?.excess), "4242", `/admin/invoice/${v.inv.id}`, ...extra]
      .filter((s) => !body.includes(s));
  };

  // ---- S1 pay page + Tap to Pay, both approved -------------------------------------
  const s1 = await visit("S1");
  {
    const m0 = srv.outbox().length;
    const page = await tapPay(s1); const tap = await ttp(s1);
    srv.stripeSucceed(page.body.paymentIntentId); srv.stripeSucceed(tap.body.paymentIntentId);
    const f1 = await ttpFin(s1, tap.body.paymentIntentId);
    ok(f1.status === 200 && f1.body.invoice?.status === "paid" && !f1.body.overpayment, `S1: Tap to Pay settles it normally (${f1.status})`);
    const f2 = await confirm(s1, page.body.paymentIntentId);
    ok(f2.status === 200 && f2.body.ok === true && f2.body.overpayment === true && f2.body.customerMessage === CUSTOMER_MESSAGE,
      `S1: the second payment's customer is shown the neutral overpayment wording (${f2.status} ${j([f2.body.overpayment, f2.body.customerMessage])})`);
    for (let k = 0; k < 2; k++) { await hook(s1, page.body.paymentIntentId); await hook(s1, tap.body.paymentIntentId); }
    await settle();
    const r = await read(s1);
    ok(r.status === "paid" && r.balanceDue === 0 && money(r.amountPaid) === s1.inv.total && cardPayments(r).length === 1,
      `S1: the invoice is paid once — $0 due, never negative (${j([r.status, r.amountPaid, r.balanceDue, cardPayments(r).length])})`);
    const e = exc(r);
    ok(e.length === 1, `S1: exactly one payment exception, through two webhook retries each (${e.length})`);
    const x = e[0] || {};
    ok(x.status === "open" && x.paymentIntentId === page.body.paymentIntentId && money(x.chargedTotal) === s1.inv.total && x.applied === 0 && money(x.excess) === s1.inv.total,
      `S1: it keeps the whole charge as excess: charged ${x.chargedTotal}, applied ${x.applied}, excess ${x.excess} (${x.status})`);
    ok(x.method === "card_qb" && /online card/i.test(x.methodLabel || "") && x.cardLast4 === "4242" && x.reason === "already_covered" && x.detectedAt && x.via,
      `S1: method, card, reason and arrival are on it (${j([x.methodLabel, x.cardBrand, x.cardLast4, x.reason, x.via])})`);
    ok(r.needsReconciliation === true, "S1: the invoice reads Needs refund / reconciliation");
    const a = alerts(m0, s1);
    ok(a.length === 1, `S1: one admin alert (${a.length})`);
    ok(a[0] && alertCarries(a[0], s1, x).length === 0, `S1: the alert carries invoice, work order, customer, charge, applied, excess, card, Stripe id and link (missing ${j(a[0] ? alertCarries(a[0], s1, x) : "all")})`);
    const rc = receipts(m0, s1);
    ok(rc.length === 2, `S1: one receipt per distinct payment (${rc.length})`);
    ok(rc.filter((m) => (m.text || "").includes("more than the remaining invoice balance")).length === 1
      && rc.filter((m) => !(m.text || "").includes("more than the remaining invoice balance")).length === 1,
      "S1: the Tap to Pay receipt is the normal one; the extra payment's receipt carries the neutral wording");
    ok(!rc.some((m) => /refund/i.test(m.text || "")), "S1: no receipt promises a refund");
  }

  // ---- S2 cash in full, then the open pay page's card approved ---------------------
  const s2 = await visit("S2");
  {
    const m0 = srv.outbox().length;
    const page = await tapPay(s2);
    const c = await cash(s2, s2.inv.total);
    ok(c.status === 201, `S2: cash recorded in full (${c.status})`);
    srv.stripeSucceed(page.body.paymentIntentId);
    const f = await confirm(s2, page.body.paymentIntentId);
    await hook(s2, page.body.paymentIntentId); await settle();
    const r = await read(s2); const x = exc(r)[0] || {};
    ok(f.status === 200 && f.body.overpayment === true && f.body.customerMessage === CUSTOMER_MESSAGE, `S2: the customer is told neutrally, not a plain "Payment received" (${f.status} ${j(f.body.overpayment)})`);
    ok(exc(r).length === 1 && x.status === "open" && x.applied === 0 && money(x.excess) === s2.inv.total && x.reason === "already_covered",
      `S2: no longer silent — one open exception for the whole charge (${j([exc(r).length, x.applied, x.excess, x.reason])})`);
    ok(r.balanceDue === 0 && (r.payments || []).length === 1 && r.payments[0].method === "cash", `S2: the ledger is just the cash (${j((r.payments || []).map((p) => p.method))})`);
    ok(alerts(m0, s2).length === 1 && receipts(m0, s2).length === 1, `S2: one alert, one receipt (${alerts(m0, s2).length}, ${receipts(m0, s2).length})`);
  }

  // ---- S3 part cash, then the open pay page's card for the full total --------------
  const s3 = await visit("S3");
  {
    const m0 = srv.outbox().length;
    const page = await tapPay(s3);
    const part = money(s3.inv.total * 0.4);
    await cash(s3, part);
    srv.stripeSucceed(page.body.paymentIntentId);
    const f = await confirm(s3, page.body.paymentIntentId);
    await hook(s3, page.body.paymentIntentId); await settle();
    const r = await read(s3); const x = exc(r)[0] || {};
    const owed = money(s3.inv.total - part);
    ok(r.status === "paid" && r.balanceDue === 0, `S3: the invoice is Paid / $0 due (${r.status} ${r.balanceDue})`);
    ok(cardPayments(r).length === 1 && money(cardPayments(r)[0].amount) === owed, `S3: only what was owed (${owed}) is applied from the card (${j(cardPayments(r).map((p) => p.amount))})`);
    ok(exc(r).length === 1 && money(x.chargedTotal) === s3.inv.total && money(x.applied) === owed && money(x.excess) === part && x.reason === "over_balance",
      `S3: the exception is only the excess: charged ${x.chargedTotal}, applied ${x.applied}, excess ${x.excess} (want ${part})`);
    ok(f.status === 200 && f.body.overpayment === true, `S3: the customer sees the overpayment wording (${f.status})`);
    ok(alerts(m0, s3).length === 1 && receipts(m0, s3).length === 1, `S3: one alert, one receipt (${alerts(m0, s3).length}, ${receipts(m0, s3).length})`);
    ok(alerts(m0, s3)[0] && alertCarries(alerts(m0, s3)[0], s3, x).length === 0, "S3: the alert shows charge, applied and excess");
  }

  // ---- S4 cash in full, then the open Tap to Pay intent approved -------------------
  const s4 = await visit("S4");
  {
    const m0 = srv.outbox().length;
    const tap = await ttp(s4);
    await cash(s4, s4.inv.total);
    srv.stripeSucceed(tap.body.paymentIntentId);
    const f = await ttpFin(s4, tap.body.paymentIntentId);
    await hook(s4, tap.body.paymentIntentId); await settle();
    const r = await read(s4); const x = exc(r)[0] || {};
    ok(f.status === 200 && f.body.overpayment === true && f.body.customerMessage === CUSTOMER_MESSAGE, `S4: the phone is told it's an overpayment (${f.status} ${j(f.body.overpayment)})`);
    ok(exc(r).length === 1 && /tap to pay/i.test(x.methodLabel || "") && x.applied === 0 && money(x.excess) === s4.inv.total,
      `S4: one exception, method Tap to Pay (${j([exc(r).length, x.methodLabel, x.excess])})`);
    ok(alerts(m0, s4).length === 1, `S4: one alert (${alerts(m0, s4).length})`);
  }

  // ---- S5 control: one payment, its webhook twice -----------------------------------
  const s5 = await visit("S5");
  {
    const m0 = srv.outbox().length;
    const page = await tapPay(s5);
    srv.stripeSucceed(page.body.paymentIntentId);
    const f = await confirm(s5, page.body.paymentIntentId);
    await hook(s5, page.body.paymentIntentId); await hook(s5, page.body.paymentIntentId); await settle();
    const r = await read(s5);
    ok(f.status === 200 && !f.body.overpayment, "S5: a normal payment is a normal payment");
    ok(exc(r).length === 0 && !r.needsReconciliation, `S5: no false exception from a redelivered webhook (${exc(r).length})`);
    ok(cardPayments(r).length === 1 && successAttempts(r).length === 1, `S5: one payment, one attempt (${cardPayments(r).length}, ${successAttempts(r).length})`);
    ok(receipts(m0, s5).length === 1 && alerts(m0, s5).length === 0, `S5: one receipt, no alert (${receipts(m0, s5).length}, ${alerts(m0, s5).length})`);
    ok(!(receipts(m0, s5)[0]?.text || "").includes("more than the remaining"), "S5: the normal receipt wording is unchanged");

    // A payment recorded before this change (no processor reference on the
    // ledger line, only its charge id in the notes): its redelivery is
    // still recognised.
    const all = srv.data("invoices");
    const rec = all.find((i) => i.id === s5.inv.id);
    rec.payments = rec.payments.map(({ processorRef, ...p }) => p);
    srv.writeData("invoices", all);
    await hook(s5, page.body.paymentIntentId); await settle();
    const r2 = await read(s5);
    ok(exc(r2).length === 0 && cardPayments(r2).length === 1, `S5: a payment recorded before this change is still recognised on redelivery (${exc(r2).length})`);
  }

  // ---- S6 a reversal is not an overpayment (the re-record bug is its own PR) -------
  const s6 = await visit("S6");
  {
    const page = await tapPay(s6);
    srv.stripeSucceed(page.body.paymentIntentId);
    await confirm(s6, page.body.paymentIntentId);
    const r1 = await read(s6);
    await srv.api("DELETE", `/api/invoices/${s6.inv.id}/payments/${r1.payments[0].id}`, { reason: "refunded in Stripe dashboard" });
    await tapPay(s6); await settle();
    const r = await read(s6);
    ok(exc(r).length === 0 && r.balanceDue >= 0, `S6: reversing a payment raises no false exception (${exc(r).length})`);
  }

  // ---- S7 revised down while the pay page was open ---------------------------------
  const s7 = await visit("S7");
  {
    await srv.api("POST", `/api/invoices/${s7.inv.id}/send`, {});
    const m0 = srv.outbox().length;
    const page = await tapPay(s7);
    const full = await read(s7);
    const lines = full.lineItems.map((l, i) => (i === 0 ? { ...l, unitPrice: money(l.unitPrice * 0.8) } : l));
    const rev = await srv.api("POST", `/api/invoices/${s7.inv.id}/revise`, { lineItems: lines, reason: "discount agreed" });
    const newTotal = rev.body.invoice?.total;
    ok(rev.status === 200 && newTotal < s7.inv.total, `S7: revised down to ${newTotal} (${rev.status})`);
    srv.stripeSucceed(page.body.paymentIntentId);
    const f = await confirm(s7, page.body.paymentIntentId);
    await hook(s7, page.body.paymentIntentId); await settle();
    const r = await read(s7); const x = exc(r)[0] || {};
    ok(f.status === 200 && f.body.overpayment === true, `S7: the charge is taken, not refused (${f.status} ${j(f.body.errors)})`);
    ok(r.status === "paid" && r.balanceDue === 0 && cardPayments(r).length === 1 && money(cardPayments(r)[0].amount) === newTotal,
      `S7: the revised total is applied and the invoice is paid (${j([r.status, r.balanceDue, cardPayments(r).map((p) => p.amount)])})`);
    ok(exc(r).length === 1 && money(x.chargedTotal) === s7.inv.total && money(x.applied) === newTotal && money(x.excess) === money(s7.inv.total - newTotal) && x.reason === "over_balance",
      `S7: the excess over the revised total is the exception (${j([x.chargedTotal, x.applied, x.excess, x.reason])})`);
    ok(alerts(m0, s7).length === 1, `S7: one alert (${alerts(m0, s7).length})`);
  }

  // ---- S8 the same payment: two confirms and the webhook at once -------------------
  const s8 = await visit("S8");
  {
    const m0 = srv.outbox().length;
    const page = await tapPay(s8);
    srv.stripeSucceed(page.body.paymentIntentId);
    const replies = await Promise.all([confirm(s8, page.body.paymentIntentId), hook(s8, page.body.paymentIntentId), confirm(s8, page.body.paymentIntentId)]);
    await settle();
    const r = await read(s8);
    ok(replies[0].status === 200 && replies[2].status === 200 && !replies[0].body.overpayment && !replies[2].body.overpayment, "S8: both confirms answer as a normal payment");
    ok(cardPayments(r).length === 1 && exc(r).length === 0 && r.balanceDue === 0, `S8: one payment, no false exception (${cardPayments(r).length}, ${exc(r).length})`);
    ok(successAttempts(r).length === 1, `S8: one accounting decision (${successAttempts(r).length} success attempts)`);
    ok(receipts(m0, s8).length === 1 && alerts(m0, s8).length === 0, `S8: one receipt, no alert (${receipts(m0, s8).length}, ${alerts(m0, s8).length})`);
  }

  // ---- the office: the list, and resolving ------------------------------------------
  {
    const flagged = (await srv.api("GET", "/api/invoices?needsReconciliation=1")).body.invoices || [];
    const ids = flagged.map((i) => i.id).sort();
    const want = [s1, s2, s3, s4, s7].map((v) => v.inv.id).sort();
    ok(j(ids) === j(want), `list: the Needs refund / reconciliation filter shows exactly the flagged invoices (${j(ids)})`);
    ok(flagged.every((i) => i.needsReconciliation === true && !i.paymentToken && !i.portalToken), "list: each flagged row says so (and carries no bearer token)");

    const r1 = await read(s1); const x = exc(r1)[0] || {};
    const url = `/api/invoices/${s1.inv.id}/payment-exceptions/${x.id}/resolve`;
    const noNote = await srv.api("POST", url, { resolution: "refunded", note: "  " });
    ok(noNote.status === 422, `resolve: a note is required (${noNote.status})`);
    const bad = await srv.api("POST", url, { resolution: "deleted", note: "gone" });
    ok(bad.status === 422, `resolve: only refunded or reconciled (${bad.status})`);
    const m0 = srv.outbox().length;
    const done = await srv.api("POST", url, { resolution: "refunded", note: "Refunded the pay-page charge in the Stripe dashboard" });
    ok(done.status === 200, `resolve: Mark refunded with a note (${done.status} ${j(done.body.errors)})`);
    const r2 = await read(s1); const y = exc(r2)[0] || {};
    ok(exc(r2).length === 1 && y.status === "refunded" && y.resolution?.note && y.resolution?.by && y.resolution?.at, `resolve: the exception is kept, marked refunded, with who/when/note (${j(y.resolution)})`);
    ok((y.history || []).length >= 2 && (r2.history || []).some((h) => h.action === "payment_exception_resolved"), "resolve: its history and the invoice's keep every step");
    ok(r2.needsReconciliation === false && r2.balanceDue === 0 && cardPayments(r2).length === 1, "resolve: the flag clears; the ledger is untouched");
    const again = await srv.api("POST", url, { resolution: "reconciled", note: "twice" });
    ok(again.status === 409, `resolve: a resolved exception can't be resolved again (${again.status})`);
    ok(mail(m0).length === 0, "resolve: nothing is sent to anyone");
    const x3 = exc(await read(s3))[0] || {};
    const rec3 = await srv.api("POST", `/api/invoices/${s3.inv.id}/payment-exceptions/${x3.id}/resolve`, { resolution: "reconciled", note: "Customer asked us to keep the $ as credit toward spring" });
    ok(rec3.status === 200 && exc(await read(s3))[0]?.status === "reconciled", "resolve: Mark reconciled works too");
    const still = ((await srv.api("GET", "/api/invoices?needsReconciliation=1")).body.invoices || []).map((i) => i.id).sort();
    ok(j(still) === j([s2, s4, s7].map((v) => v.inv.id).sort()), `list: resolved invoices leave the filter (${j(still)})`);
  }

  // ---- the customer never sees the exception, or a negative balance -----------------
  {
    const v = s3;
    const rec = srv.data("invoices").find((i) => i.id === v.inv.id);
    const pay = (await srv.api("GET", `/api/pay/invoice/${v.inv.id}?t=${v.t}`)).body.invoice;
    ok(pay && pay.balanceDue === 0 && !("paymentExceptions" in pay) && !JSON.stringify(pay).includes("pi_"), `customer: the pay view shows $0 due and nothing internal (${j(pay && Object.keys(pay))})`);
    const portal = (await srv.api("GET", `/api/portal/invoice/${v.inv.id}?t=${rec.portalToken || ""}`)).body.invoice;
    ok(!portal || (portal.balanceDue === 0 && !("paymentExceptions" in portal)), "customer: the portal view likewise");
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  ok(!srv.outbox().some((m) => m.channel === "stripe" && /refunds/.test(m.path || "")), "PJL refunds nothing by itself");
  await srv.stop();
}

console.log(`payment-exceptions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

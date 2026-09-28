#!/usr/bin/env node
// scripts/test-deposit-payment-lifecycle.mjs
//
// Financials, Fix A (Patrick, 2026-09-28): a deposit counts as paid when
// — and only when — its deposit invoice is PAID, however the money came in,
// and stops counting when that payment is reversed (#348's reversal rules).
//
// WHAT BROKE: the deposit lifecycle (quote.deposit.stage, the held balance
// invoice) was advanced by explicit deposits.onInvoicePaid() calls in two
// routes only — the manual "Mark paid" PATCH and the Stripe finalizer.
//   - "Record payment" (cash / e-transfer / cheque: POST /payments), a
//     corrected payment (PATCH), Klarna capture: never told the deposit.
//     The deposit invoice read Paid, the job still read "awaiting deposit",
//     no balance invoice was made, and completion was blocked with
//     "Deposit … hasn't been paid" for money PJL had.
//   - The Stripe path told it on ANY applied amount, so a card payment
//     covering part of the deposit counted as the whole deposit.
//   - Nothing un-told it: reversing the payment (DELETE /payments, "refunded
//     in Stripe") left the deposit counted and the held balance invoice —
//     crediting a deposit no longer paid — in place.
//
// THE RULE: the invoice store reports every change of an invoice to or from
// "paid" (and to "void"), from every writer, after its lock is released;
// deposits.onInvoiceStatusChange is the one place that decides what it
// means for the deposit lifecycle.
//
// Run: node scripts/test-deposit-payment-lifecycle.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- one rule, in one place --------------------------------------------------------
{
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const lib = fs.readFileSync(new URL("../server/lib/invoices.js", import.meta.url), "utf8");
  const dep = fs.readFileSync(new URL("../server/lib/deposits.js", import.meta.url), "utf8");
  ok(!/deposits\.onInvoice(Paid|Voided)\(/.test(server),
    "structure: no route calls the deposit paid/void hooks itself — the invoice store reports every paid-state change");
  ok(/onInvoiceStatusChange/.test(lib) && /withStoreLock/.test(lib),
    "structure: the invoice store hands paid-state changes to deposits.onInvoiceStatusChange");
  ok(/async function onInvoiceStatusChange\(/.test(dep) && /onInvoiceStatusChange,/.test(dep),
    "structure: deposits.onInvoiceStatusChange is the one place the deposit lifecycle follows an invoice");
}

const SIG = { customerName: "Marisol Quenneville", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.9", userAgent: "test" };
const srv = await bootServer({ port: 4947 });
try {
  await srv.login();
  const quotes = srv.lib("quotes.js");
  const invoices = srv.lib("invoices.js");
  const projects = srv.lib("projects.js");
  const customers = srv.lib("customers.js");
  const deposits = srv.lib("deposits.js");

  let n = 0;
  // A signed, deposit-enabled job: $5,000 + HST = $5,650, 40% deposit
  // ($2,260), its deposit invoice issued (sent) — what onQuoteAccepted
  // leaves, built here without its email.
  async function depositJob(label, { billingMode = "fixed_price" } = {}) {
    n += 1;
    const cust = await customers.create({ name: `Marisol ${label}`, email: `dep${n}.${Date.now()}@example.com`, phone: `90555566${String(n).padStart(2, "0")}` });
    let q = await quotes.create({
      type: "project_proposal", status: "draft", customerId: cust.id, customerEmail: cust.email,
      branch: "direct_residential", billingMode,
      lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }], subtotal: 5000, hst: 650, total: 5650
    });
    // Deposit terms are set by a save, as the quote builder does.
    q = await quotes.updateProposal(q.id, { deposit: { enabled: true, type: "percent", value: 40 } });
    q = await quotes.markSent(q.id, { channels: ["email"], toEmail: cust.email });
    q = await quotes.recordPortalSignAcceptance(q.id, SIG);
    if (!(q.deposit?.enabled && q.deposit.amount > 0)) throw new Error(`setup: deposit not enabled on ${q.id} ${j(q.deposit)}`);
    const figures = quotes.computeDepositFigures(q.total, q.deposit);
    const depInv = await invoices.createDraft({
      quoteId: q.id, customerId: cust.id, customerEmail: cust.email, customerName: cust.name,
      lineItems: [{ key: "quote_deposit", label: `Deposit — 40% of quote ${q.id}`, qty: 1, price: deposits.preTaxForTotal(figures.amount) }],
      invoiceRole: "deposit"
    });
    await quotes.updateDepositLifecycle(q.id, {
      stage: "awaiting_deposit",
      snapshot: { amount: figures.amount, balance: figures.balance, grandTotal: Number(q.total) },
      depositInvoiceId: depInv.id
    }, { note: "test setup" });
    const proj = await projects.createFromProposal(q, { customerName: cust.name, customerEmail: cust.email });
    await projects.update(proj.id, { status: "active", name: `Deposit ${label}` });
    const sent = await srv.api("PATCH", `/api/invoices/${depInv.id}`, { status: "sent" });
    if (sent.status !== 200) throw new Error(`send ${sent.status} ${j(sent.body)}`);
    return { label, q, proj, dep: sent.body.invoice, email: cust.email };
  }
  const stage = async (v) => (await quotes.get(v.q.id)).deposit;
  const inv = async (id) => (await srv.api("GET", `/api/invoices/${id}`)).body.invoice;
  const pay = (id, amount, method = "e_transfer") => srv.api("POST", `/api/invoices/${id}/payments`, { amount, method });
  const reverse = (id, pid) => srv.api("DELETE", `/api/invoices/${id}/payments/${pid}`, { reason: "bounced e-transfer" });
  const balances = (v) => srv.data("invoices").filter((i) => i.quoteId === v.q.id && i.invoiceRole === "balance");
  const live = (list) => list.filter((i) => i.status !== "void");
  const blockers = async (v) => ((await srv.api("GET", `/api/projects/${v.proj.id}/completion-preflight`)).body.checks?.blockers || []).map((b) => b.key);
  const settle = () => sleep(300);

  // ---- A recorded payments (e-transfer / cash) --------------------------------------
  const a = await depositJob("A");
  {
    ok((await stage(a)).stage === "awaiting_deposit" && (await blockers(a)).includes("deposit_unpaid"), "A0: a sent, unpaid deposit blocks completion as unpaid");

    // A1 part of the deposit, by e-transfer
    const p1 = await pay(a.dep.id, 1000);
    let d = await stage(a);
    ok(p1.status === 201 && p1.body.invoice.status === "partially_paid", `A1: $1,000 of $${a.dep.total} records as a part payment (${p1.status} ${p1.body.invoice?.status})`);
    ok(d.stage === "awaiting_deposit" && !d.balanceInvoiceId && balances(a).length === 0, `A1: a part-paid deposit does not count — no balance invoice (${d.stage}, ${balances(a).length})`);

    // A2 the rest, by cash — the deposit is paid
    const p2 = await pay(a.dep.id, Math.round((a.dep.total - 1000) * 100) / 100, "cash");
    d = await stage(a);
    const bal = live(balances(a));
    ok(p2.status === 201 && p2.body.invoice.status === "paid", `A2: the rest settles the deposit invoice (${p2.status} ${p2.body.invoice?.status})`);
    ok(d.stage === "deposit_paid", `A2: a deposit paid by RECORDED payments counts as paid (stage ${d.stage})`);
    ok(bal.length === 1 && d.balanceInvoiceId === bal[0]?.id && bal[0].status === "draft" && bal[0].holdUntilCompletion === true,
      `A2: …and the held balance invoice is made (${bal.length} ${j(bal.map((b) => [b.status, b.holdUntilCompletion]))})`);
    const credit = (bal[0]?.lineItems || []).find((l) => l.key === "deposit_credit");
    ok(credit && Math.abs(Number(credit.lineTotal) + Number(a.dep.subtotal)) < 0.01, `A2: …crediting the deposit paid (${j(credit)})`);
    ok(!(await blockers(a)).includes("deposit_unpaid"), `A2: completion no longer says the deposit is unpaid (${j(await blockers(a))})`);

    // A3 the cash is reversed — the deposit no longer counts
    const firstBalance = bal[0]?.id;
    const cash = (await inv(a.dep.id)).payments.find((p) => p.method === "cash");
    const r = await reverse(a.dep.id, cash?.id);
    d = await stage(a);
    const withdrawn = srv.data("invoices").find((i) => i.id === firstBalance);
    ok(r.status === 200 && r.body.invoice.status === "partially_paid", `A3: reversing the cash un-pays the deposit invoice (${r.status} ${r.body.invoice?.status})`);
    ok(d.stage === "awaiting_deposit" && !d.balanceInvoiceId, `A3: a reversed deposit payment stops counting (stage ${d.stage}, balance ${d.balanceInvoiceId})`);
    ok(withdrawn?.status === "void" && live(balances(a)).length === 0, `A3: …and the held balance invoice crediting it is withdrawn (${withdrawn?.status})`);
    ok((await blockers(a)).includes("deposit_unpaid"), `A3: completion is blocked as unpaid again (${j(await blockers(a))})`);

    // A4 paid again — one fresh balance invoice, never two
    await pay(a.dep.id, Math.round((a.dep.total - 1000) * 100) / 100, "cheque");
    d = await stage(a);
    const again = live(balances(a));
    ok(d.stage === "deposit_paid" && again.length === 1 && again[0].id !== firstBalance && d.balanceInvoiceId === again[0].id,
      `A4: paid again → counted again, with ONE new held balance invoice (${d.stage}, ${again.length})`);

    // A5 a payment corrected down un-pays it too (PATCH /payments/:pid)
    const e = (await inv(a.dep.id)).payments.find((p) => p.method === "e_transfer");
    const c = await srv.api("PATCH", `/api/invoices/${a.dep.id}/payments/${e?.id}`, { amount: 500 });
    d = await stage(a);
    ok(c.status === 200 && c.body.invoice.status === "partially_paid" && d.stage === "awaiting_deposit" && live(balances(a)).length === 0,
      `A5: a payment corrected down un-counts the deposit and withdraws its balance invoice (${c.status} ${c.body.invoice?.status} ${d.stage} ${live(balances(a)).length})`);

    // A6 corrected back up — counted again
    await srv.api("PATCH", `/api/invoices/${a.dep.id}/payments/${e?.id}`, { amount: 1000 });
    d = await stage(a);
    ok(d.stage === "deposit_paid" && live(balances(a)).length === 1, `A6: corrected back up → counted, one balance invoice (${d.stage}, ${live(balances(a)).length})`);

    const notes = (await quotes.get(a.q.id)).history.filter((h) => h.action === "deposit_lifecycle").map((h) => h.note);
    ok(notes.some((x) => /revers|no longer/i.test(x)), `A: the quote's history says why the deposit stopped counting (${j(notes)})`);
  }

  // ---- B card on the pay page, refunded, redelivered (#348 S6) ----------------------
  const b = await depositJob("B");
  {
    const link = await payLink(srv, b.dep.id);
    const pi = (await srv.api("POST", `/api/pay/invoice/${b.dep.id}/payment-intent`, { t: link.token })).body.paymentIntentId;
    srv.stripeSucceed(pi);
    const c = await srv.api("POST", `/api/pay/invoice/${b.dep.id}/charge`, { t: link.token, paymentIntentId: pi });
    await settle();
    let d = await stage(b);
    ok(c.status === 200 && d.stage === "deposit_paid" && live(balances(b)).length === 1, `B1: a card-paid deposit counts, one balance invoice (${c.status} ${d.stage} ${live(balances(b)).length})`);

    const card = (await inv(b.dep.id)).payments.find((p) => p.method === "card_qb");
    await srv.api("DELETE", `/api/invoices/${b.dep.id}/payments/${card?.id}`, { reason: "refunded in Stripe dashboard" });
    d = await stage(b);
    const unpaid = await inv(b.dep.id);
    ok(unpaid.status === "sent" && Math.abs(unpaid.balanceDue - unpaid.total) < 0.01 && !unpaid.paidAt,
      `B2: reversing the ONLY payment on an emailed invoice puts it back to Sent with the full amount owing — never Paid with $0 received (${unpaid.status}, ${unpaid.balanceDue}, ${unpaid.paidAt})`);
    ok(d.stage === "awaiting_deposit" && live(balances(b)).length === 0, `B2: the card refunded and reversed → the deposit stops counting (${d.stage}, ${live(balances(b)).length})`);

    // the refunded payment redelivered: #348 records nothing — and the
    // deposit stays uncounted
    await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi, object: "payment_intent", metadata: { invoiceId: b.dep.id } } } });
    await srv.api("POST", `/api/pay/invoice/${b.dep.id}/charge`, { t: link.token, paymentIntentId: pi });
    await settle();
    d = await stage(b);
    ok(d.stage === "awaiting_deposit" && live(balances(b)).length === 0 && (await inv(b.dep.id)).status !== "paid",
      `B3: the refunded payment redelivered neither re-pays the invoice nor re-counts the deposit (${d.stage}, ${live(balances(b)).length})`);

    // a new card pays it — counted again, one balance invoice
    const pi2 = (await srv.api("POST", `/api/pay/invoice/${b.dep.id}/payment-intent`, { t: link.token })).body.paymentIntentId;
    srv.stripeSucceed(pi2);
    await srv.api("POST", `/api/pay/invoice/${b.dep.id}/charge`, { t: link.token, paymentIntentId: pi2 });
    await settle();
    d = await stage(b);
    ok(pi2 && pi2 !== pi && d.stage === "deposit_paid" && live(balances(b)).length === 1, `B4: a new card counts again, one balance invoice (${d.stage}, ${live(balances(b)).length})`);
  }

  // ---- C a card payment that covers only PART of the deposit ------------------------
  // The office recorded $500 cash; the customer then paid the rest by card.
  // Before the cash, the pay page had minted an intent for the whole
  // deposit — so Stripe only APPLIES what was still owed, the rest opens a
  // payment exception. What matters here: the part-cash + card that SETTLES
  // it counts; a card that leaves money owing does not.
  const c = await depositJob("C");
  {
    const link = await payLink(srv, c.dep.id);
    // Pay part by card: record cash first so the card intent is for the rest,
    // then reverse the cash — leaving the card as a PART payment.
    await pay(c.dep.id, 500, "cash");
    const pi = (await srv.api("POST", `/api/pay/invoice/${c.dep.id}/payment-intent`, { t: link.token })).body.paymentIntentId;
    srv.stripeSucceed(pi);
    await srv.api("POST", `/api/pay/invoice/${c.dep.id}/charge`, { t: link.token, paymentIntentId: pi });
    await settle();
    let d = await stage(c);
    ok(d.stage === "deposit_paid", `C1: $500 cash + the rest by card settles and counts (${d.stage})`);
    const cash = (await inv(c.dep.id)).payments.find((p) => p.method === "cash");
    await reverse(c.dep.id, cash?.id);
    d = await stage(c);
    const now = await inv(c.dep.id);
    ok(now.status === "partially_paid" && d.stage === "awaiting_deposit" && live(balances(c)).length === 0,
      `C2: with the cash reversed, the card alone is PART of the deposit — it does not count (${now.status} ${d.stage} ${live(balances(c)).length})`);
  }

  // ---- D the manual "Mark paid" and its undo ----------------------------------------
  const dd = await depositJob("D");
  {
    const m = await srv.api("PATCH", `/api/invoices/${dd.dep.id}`, { status: "paid" });
    let d = await stage(dd);
    ok(m.status === 200 && d.stage === "deposit_paid" && live(balances(dd)).length === 1, `D1: "Mark paid" still counts the deposit, one balance invoice (${d.stage}, ${live(balances(dd)).length})`);
    await srv.api("PATCH", `/api/invoices/${dd.dep.id}`, { status: "sent" });
    d = await stage(dd);
    ok(d.stage === "awaiting_deposit" && live(balances(dd)).length === 0, `D2: un-marking it un-counts the deposit and withdraws the balance invoice (${d.stage}, ${live(balances(dd)).length})`);
    await srv.api("PATCH", `/api/invoices/${dd.dep.id}`, { status: "paid" });
    await srv.api("PATCH", `/api/invoices/${dd.dep.id}`, { status: "paid", notes: "marked paid twice" });
    d = await stage(dd);
    ok(d.stage === "deposit_paid" && live(balances(dd)).length === 1, `D3: marked paid again → one balance invoice, never two (${live(balances(dd)).length})`);
  }

  // ---- E time & materials: no balance invoice until completion ----------------------
  const e = await depositJob("E", { billingMode: "time_and_material" });
  {
    const p = await pay(e.dep.id, e.dep.total);
    let d = await stage(e);
    ok(p.status === 201 && d.stage === "deposit_paid" && balances(e).length === 0, `E1: a recorded T&M deposit counts, and makes no balance invoice yet (${d.stage}, ${balances(e).length})`);
    await reverse(e.dep.id, p.body.invoice?.payments?.[0]?.id);
    d = await stage(e);
    ok(d.stage === "awaiting_deposit", `E2: reversed → a T&M deposit stops counting (${d.stage})`);
  }

  // ---- F reversed AFTER the balance invoice went out: left for the office -----------
  // Past completion the balance invoice has been sent to the customer; the
  // lifecycle does not silently rewrite a sent invoice. It says so, on the
  // balance invoice and on the quote.
  const f = await depositJob("F");
  {
    const p = await pay(f.dep.id, f.dep.total);
    const bal = live(balances(f))[0];
    if (!bal) { ok(false, "F: setup — paying the deposit made no balance invoice"); throw new Error("F setup"); }
    await srv.api("PATCH", `/api/invoices/${bal.id}`, { holdUntilCompletion: false, status: "sent" });
    await quotes.updateDepositLifecycle(f.q.id, { stage: "awaiting_balance_payment" }, { note: "test: completed" });
    await reverse(f.dep.id, p.body.invoice?.payments?.[0]?.id);
    const d = await stage(f);
    const after = await inv(bal.id);
    ok(after.status === "sent" && d.balanceInvoiceId === bal.id, `F1: a SENT balance invoice is not withdrawn behind the customer's back (${after.status})`);
    ok((after.history || []).some((h) => /deposit/i.test(h.note || "") && /revers/i.test(h.note || "")),
      `F1: …its history says the deposit it credits was reversed (${j((after.history || []).map((h) => h.note))})`);
    const notes = (await quotes.get(f.q.id)).history.filter((h) => h.action === "deposit_lifecycle").map((h) => h.note);
    ok(notes.some((x) => /revers/i.test(x) && x.includes(bal.id)), `F1: …and the quote's history names the balance invoice to correct (${j(notes.slice(-1))})`);

    // F2 the balance paid closes it; reversing that payment re-opens it
    const bp = await pay(bal.id, after.balanceDue, "cheque");
    let dd2 = await stage(f);
    ok(bp.status === 201 && dd2.stage === "closed", `F2: a RECORDED payment settling the balance invoice closes the deposit lifecycle (${bp.status} ${dd2.stage})`);
    await reverse(bal.id, bp.body.invoice?.payments?.find((x) => x.method === "cheque")?.id);
    dd2 = await stage(f);
    ok(dd2.stage === "awaiting_balance_payment", `F2: reversing it re-opens the balance (${dd2.stage})`);
  }
} finally {
  await srv.stop();
}

console.log(`\ndeposit payment lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

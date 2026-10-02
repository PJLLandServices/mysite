#!/usr/bin/env node
// scripts/test-payment-reconciliation.mjs
//
// Payment reconciliation (Patrick, 2026-09-28): the payment LEDGER is the
// source of truth for money received; an invoice's status never proves it.
//
//   1. Net valid payments only (a reversed/refunded payment is off the
//      ledger).
//   2. "Paid" is a claim: settled = paid AND covered by the ledger.
//   3. "Mark paid" never stands in for a payment: refused unless the ledger
//      covers the invoice, pointing the office to Record payment.
//   4. An invoice marked Paid with its payments short (from before rule 3)
//      is in RECONCILIATION: the gap is unresolved — not received, not
//      collectible, no reminders, no online or Tap to Pay payment — and the
//      claim (and gap) is preserved until the office records the missing
//      payment or corrects the status to Partially paid.
//   5. A deposit in reconciliation is NOT satisfied: no balance invoice,
//      and completion is blocked — no override.
//   6. Resolving it is audited: who, when, how.
//
// The exact case: a $1,260 invoice, $1,000 recorded, marked Paid → $260
// unresolved.
//
// Run: node scripts/test-payment-reconciliation.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { bootServer, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- one rule, in one place --------------------------------------------------------
{
  const lib = fs.readFileSync(new URL("../server/lib/invoices.js", import.meta.url), "utf8");
  const dep = fs.readFileSync(new URL("../server/lib/deposits.js", import.meta.url), "utf8");
  const cascade = fs.readFileSync(new URL("../server/lib/completion-cascade.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  ok(/function reconciliationFor\(/.test(lib) && /function isSettled\(/.test(lib), "structure: invoices.reconciliationFor / isSettled are the rule");
  ok(/invoices\.isSettled\(before\)/.test(dep) && /invoices\.isSettled\(after\)/.test(dep), "structure: the deposit lifecycle follows SETTLED, not a status");
  ok(!/depositInvoice(\?)?\.status === "paid"|depInv\.status === "paid"/.test(cascade), "structure: completion never reads a deposit's status as its payment");
  ok(!/invoiceRole === "deposit" && i\.status === "paid"/.test(server), "structure: the portal's \"deposit paid\" stage reads the ledger");
  ok(/record_payment_required/.test(lib), "structure: an unbacked Mark paid is refused in the store itself");
}

const SIG = { customerName: "Ingrid Vasquez-Lamarre", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.31", userAgent: "test" };
const srv = await bootServer({ port: 4961 });
try {
  await srv.login();
  const quotes = srv.lib("quotes.js");
  const invoices = srv.lib("invoices.js");
  const projects = srv.lib("projects.js");
  const customers = srv.lib("customers.js");
  const deposits = srv.lib("deposits.js");

  const inv = async (id) => (await srv.api("GET", `/api/invoices/${id}`)).body.invoice;
  // Guarded, so the code before this rule reports every check instead of crashing.
  const settled = (r) => typeof invoices.isSettled === "function" ? invoices.isSettled(r) : null;
  const covers = (r) => typeof invoices.ledgerCovers === "function" ? invoices.ledgerCovers(r) : null;
  const recon = (r) => r?.paymentReconciliation || {};
  const pay = (id, amount, method = "e_transfer", notes = "") => srv.api("POST", `/api/invoices/${id}/payments`, { amount, method, notes });
  const reverse = (id, pid, reason = "bounced") => srv.api("DELETE", `/api/invoices/${id}/payments/${pid}`, { reason });
  const patch = (id, body) => srv.api("PATCH", `/api/invoices/${id}`, body);
  // An invoice marked Paid with its payments short, as the old "Mark paid"
  // left them — written straight to the store, since the route now refuses.
  function forcePaid(id) {
    const f = path.join(srv.DATA, "invoices.json");
    const all = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = all.find((x) => x.id === id);
    r.status = "paid"; r.paidAt = r.paidAt || new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
  }
  let n = 0;
  async function customer(label) {
    n += 1;
    return customers.create({ name: `Ingrid ${label}`, email: `recon${n}.${Date.now()}@example.com`, phone: `90555599${String(n).padStart(2, "0")}` });
  }
  // A sent $1,260.00 invoice (pre-tax chosen so the total is exactly 1260).
  async function invoice1260(label) {
    const c = await customer(label);
    const d = await invoices.createDraft({
      customerId: c.id, customerEmail: c.email, customerName: c.name, customerPhone: c.phone,
      lineItems: [{ key: "custom", label: `Irrigation work ${label}`, qty: 1, price: deposits.preTaxForTotal(1260) }]
    });
    const s = await patch(d.id, { status: "sent" });
    if (s.status !== 200 || s.body.invoice.total !== 1260) throw new Error(`setup ${label}: ${s.status} ${j(s.body)}`);
    return s.body.invoice;
  }

  // ---- 1. THE case: $1,260, $1,000 recorded, marked Paid → $260 unresolved ----------
  const x = await invoice1260("X");
  {
    await pay(x.id, 1000);
    // "Mark paid" now: refused, and it says why and what to do.
    const m = await patch(x.id, { status: "paid" });
    ok(m.status === 409 && m.body.code === "record_payment_required", `1a: Mark paid with $1,000 of $1,260 recorded is refused (${m.status} ${m.body.code})`);
    ok(/\$1,000\.00 of \$1,260\.00/.test(m.body.errors?.[0] || "") && /Record payment/.test(m.body.errors?.[0] || "") && /\$260\.00/.test(m.body.errors?.[0] || ""),
      `1a: …naming what's recorded, the total, the $260 and Record payment (${m.body.errors?.[0]})`);
    ok((await inv(x.id)).status === "partially_paid", "1a: …the invoice stays Partially paid");
    // The same state as an invoice marked Paid before this rule.
    forcePaid(x.id);
    const r = await inv(x.id);
    ok(r.status === "paid" && r.amountPaid === 1000, `1b: legacy: marked Paid with $1,000 recorded (${r.status} ${r.amountPaid})`);
    ok(r.paymentReconciliation?.required === true && recon(r).total === 1260 && recon(r).recorded === 1000 && recon(r).unresolved === 260,
      `1b: received is the ledger's $1,000; $260 unresolved; reconciliation required (${j(r.paymentReconciliation)})`);
    ok(settled(r) === false && covers(r) === false, "1b: a Paid status alone is not settled");
  }

  // ---- 2. full and partial payment: no reconciliation --------------------------------
  const f = await invoice1260("F");
  {
    const p1 = await pay(f.id, 500, "cash");
    ok(p1.body.invoice.status === "partially_paid" && !recon(p1.body.invoice).required, "2a: a partial payment is Partially paid, not reconciliation");
    const p2 = await pay(f.id, 760, "cheque");
    const r = p2.body.invoice;
    ok(r.status === "paid" && settled(r) === true && !recon(r).required && r.balanceDue === 0, `2b: paid in full by the ledger is Paid and settled (${r.status} ${r.balanceDue})`);
    const again = await patch(f.id, { status: "paid", notes: "already covered" });
    ok(again.status === 200, `2c: "Paid" on a covered invoice is allowed (${again.status})`);
    const draft = await invoices.createDraft({ customerEmail: "zero@example.com", lineItems: [{ key: "custom", label: "Nothing", qty: 1, price: 50 }] });
    await patch(draft.id, { status: "sent" });
    const z = await patch(draft.id, { status: "paid" });
    ok(z.status === 409 && z.body.code === "record_payment_required", `2d: Mark paid with nothing recorded is refused (${z.status})`);
  }

  // ---- 3. the claim is preserved until the office resolves it ------------------------
  const pres = await invoice1260("P");
  {
    await pay(pres.id, 1000);
    forcePaid(pres.id);
    // A part of the gap recorded: still Paid, still reconciliation, gap narrows.
    const part = await pay(pres.id, 100, "e_transfer");
    let r = part.body.invoice;
    ok(part.status === 201 && r.status === "paid" && recon(r).required && recon(r).unresolved === 160,
      `3a: $100 toward the gap keeps it in reconciliation, $160 unresolved — not turned into an ordinary balance (${r.status} ${j(r.paymentReconciliation)})`);
    ok((r.history || []).some((h) => h.action === "payment_reconciliation_changed"), "3a: …and the history says the gap changed");
    // A reversal widens it — still preserved, never auto-cleared.
    const ep = (r.payments || []).find((p) => p.amount === 100);
    const rev = await reverse(pres.id, ep.id);
    r = rev.body.invoice;
    ok(rev.status === 200 && r.status === "paid" && recon(r).unresolved === 260, `3b: reversing that payment keeps the claim; $260 unresolved again (${r.status} ${recon(r).unresolved})`);
    // The rest recorded: resolved, audited.
    const rest = await pay(pres.id, 260, "cheque", "ref #4471");
    r = rest.body.invoice;
    const rec = (r.reconciliations || [])[0];
    ok(rest.status === 201 && r.status === "paid" && !recon(r).required && settled(r) === true, `3c: recording the missing $260 resolves it — Paid, settled (${r.status})`);
    ok(rec && rec.resolution === "recorded_payment" && rec.unresolvedBefore === 260 && rec.total === 1260 && rec.recordedBefore === 1000 && rec.at && rec.by && rec.paymentId,
      `3c: …audited: who, when, how, what was unresolved, which payment (${j(rec)})`);
    ok((r.history || []).some((h) => h.action === "payment_reconciled" && /missing payment was recorded/.test(h.note)), "3c: …and in the history");
  }

  // ---- 4. resolved by correcting the status to Partially paid ------------------------
  const cor = await invoice1260("C");
  {
    await pay(cor.id, 1000);
    forcePaid(cor.id);
    const c = await patch(cor.id, { status: "partially_paid" });
    const r = c.body.invoice;
    const rec = (r?.reconciliations || [])[0];
    ok(c.status === 200 && r.status === "partially_paid" && r.balanceDue === 260 && !recon(r).required,
      `4a: corrected to Partially paid — the $260 is now an ordinary balance, owed (${c.status} ${r?.status} ${r?.balanceDue})`);
    ok(rec && rec.resolution === "status_corrected" && rec.statusAfter === "partially_paid" && rec.unresolvedBefore === 260 && rec.by && rec.by !== "admin",
      `4a: …audited as a status correction, by a named person (${j(rec)})`);
    ok(!r.paidAt, "4a: …and it is no longer dated as paid");
    const bad = await patch(f.id, { status: "partially_paid" });
    ok(bad.status === 409 && bad.body.code === "status_mismatch", `4b: Partially paid is refused on an invoice its payments cover (${bad.status} ${bad.body.code})`);
    const zero = await invoice1260("Z");
    const bad2 = await patch(zero.id, { status: "partially_paid" });
    ok(bad2.status === 409 && bad2.body.code === "status_mismatch", `4c: …and on one with nothing recorded (${bad2.status})`);
  }

  // ---- 5. void: a Paid claim can't be voided; corrected first, then void ------------
  const v = await invoice1260("V");
  {
    forcePaid(v.id); // marked Paid, nothing recorded at all
    let r = await inv(v.id);
    ok(recon(r).required && recon(r).unresolved === 1260, `5a: Paid with nothing recorded: $1,260 unresolved (${j(r.paymentReconciliation)})`);
    const vd = await srv.api("POST", `/api/invoices/${v.id}/void`, { reason: "duplicate" });
    ok(vd.status !== 200 && (await inv(v.id)).status === "paid", `5b: it can't be voided while marked Paid (${vd.status})`);
    const s = await patch(v.id, { status: "sent" });
    r = s.body.invoice;
    ok(s.status === 200 && r.status === "sent" && !recon(r).required && (r.reconciliations || [])[0]?.resolution === "status_corrected",
      `5c: set back to Sent — resolved as a status correction (${r?.status} ${j(r?.reconciliations)})`);
    const vd2 = await srv.api("POST", `/api/invoices/${v.id}/void`, { reason: "duplicate" });
    r = await inv(v.id);
    ok(vd2.status === 200 && r.status === "void" && !recon(r).required, `5d: then voided; a void invoice is never in reconciliation (${vd2.status})`);
  }

  // ---- 6. no collection: no reminder, no online or Tap to Pay payment ---------------
  const s6 = await invoice1260("S");
  {
    await pay(s6.id, 1000);
    const link = await payLink(srv, s6.id); // minted while it was still collectible
    forcePaid(s6.id);
    const m0 = srv.outbox().length;
    const rem = await srv.api("POST", `/api/invoices/${s6.id}/send-reminder`, { force: true });
    const smsOut = srv.outbox().slice(m0).filter((e) => e.channel === "sms");
    ok(rem.status !== 200 && smsOut.length === 0, `6a: no collection reminder for the unresolved $260 (${rem.status} ${j(rem.body?.errors || rem.body?.code)}; ${smsOut.length} sms)`);
    const pi = await srv.api("POST", `/api/pay/invoice/${s6.id}/payment-intent`, { t: link.token });
    ok(pi.status === 409 && pi.body.code === "reconciliation_required" && !/paid/i.test(pi.body.errors?.[0] || "x paid"),
      `6b: the customer's pay link takes nothing — reconciliation required (${pi.status} ${pi.body.code} ${pi.body.errors?.[0]})`);
    const tt = await srv.api("POST", `/api/invoices/${s6.id}/terminal-intent`, {});
    ok(tt.status === 409 && tt.body.code === "reconciliation_required", `6c: Tap to Pay takes nothing either (${tt.status} ${tt.body.code})`);
    const creates = srv.outbox().slice(m0).filter((e) => e.channel === "stripe" && e.method === "POST" && e.path === "/v1/payment_intents");
    ok(creates.length === 0, `6d: no Stripe charge was even started (${creates.length})`);
    ok(invoices.isPayableOnline(await inv(s6.id)) === false && invoices.payBlockReason(await inv(s6.id)) === "reconciliation_required", "6e: the one pay rule says why");
  }

  // ---- 7. a real card payment that arrives for the gap reconciles it (#348/#349) ----
  const k = await invoice1260("K");
  {
    await pay(k.id, 1000);
    const link = await payLink(srv, k.id);
    const intent = (await srv.api("POST", `/api/pay/invoice/${k.id}/payment-intent`, { t: link.token })).body.paymentIntentId;
    forcePaid(k.id); // then marked Paid by hand, before the card went through
    srv.stripeSucceed(intent);
    await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: intent, object: "payment_intent", metadata: { invoiceId: k.id } } } });
    await sleep(700);
    let r = await inv(k.id);
    const card = (r.payments || []).find((p) => p.processorRef === intent);
    ok(card && card.amount === 260 && r.status === "paid" && !recon(r).required && (r.reconciliations || [])[0]?.resolution === "recorded_payment",
      `7a: the customer's card for the $260 lands on the ledger and reconciles it (${j(r.payments?.map((p) => [p.method, p.amount]))} ${j(r.reconciliations)})`);
    ok((r.paymentExceptions || []).length === 0, "7a: …with no payment exception");
    // Refunded and reversed (S6): the invoice is back in reconciliation? No —
    // its Paid claim was resolved; the refund un-settles it by the ledger.
    const rv = await reverse(k.id, card.id, "refunded in Stripe");
    r = rv.body.invoice;
    ok(rv.status === 200 && r.status !== "paid" && r.balanceDue === 260 && !recon(r).required, `7b: refunding that card un-pays it; $260 owed again, by the ledger (${r.status} ${r.balanceDue})`);
    await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: intent, object: "payment_intent", metadata: { invoiceId: k.id } } } });
    await sleep(500);
    r = await inv(k.id);
    ok(r.amountPaid === 1000 && r.status !== "paid", `7c: the refunded card redelivered adds nothing (S6) (${r.amountPaid} ${r.status})`);
  }

  // ---- 8. a deposit in reconciliation: not satisfied, no balance, completion blocked -
  {
    const c = await customer("D");
    let q = await quotes.create({
      type: "project_proposal", status: "draft", customerId: c.id, customerEmail: c.email, branch: "direct_residential", billingMode: "fixed_price",
      lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }], subtotal: 5000, hst: 650, total: 5650
    });
    q = await quotes.updateProposal(q.id, { deposit: { enabled: true, type: "percent", value: 40 } });
    q = await quotes.markSent(q.id, { channels: ["email"], toEmail: c.email });
    q = await quotes.recordPortalSignAcceptance(q.id, SIG);
    const figures = quotes.computeDepositFigures(q.total, q.deposit);
    const dep = await invoices.createDraft({
      quoteId: q.id, customerId: c.id, customerEmail: c.email, customerName: c.name,
      lineItems: [{ key: "quote_deposit", label: "Deposit — 40%", qty: 1, price: deposits.preTaxForTotal(figures.amount) }], invoiceRole: "deposit"
    });
    await quotes.updateDepositLifecycle(q.id, { stage: "awaiting_deposit", snapshot: { amount: figures.amount, balance: figures.balance, grandTotal: 5650 }, depositInvoiceId: dep.id }, { note: "test setup" });
    await patch(dep.id, { status: "sent" });
    const proj = await projects.createFromProposal(q, { customerName: c.name, customerEmail: c.email });
    await projects.update(proj.id, { status: "active", customerId: c.id });
    await pay(dep.id, 1000);
    forcePaid(dep.id);
    // Nudge the store so its observer sees the forced record (a no-op note).
    await patch(dep.id, { notes: "legacy mark-paid" });
    const balances = () => srv.data("invoices").filter((i) => i.quoteId === q.id && i.invoiceRole === "balance" && i.status !== "void");
    const stage = async () => (await quotes.get(q.id)).deposit.stage;
    ok((await stage()) === "awaiting_deposit" && balances().length === 0, `8a: a deposit marked Paid with $1,000 of $2,260 is NOT satisfied — no balance invoice (${await stage()}, ${balances().length})`);
    const pf = (await srv.api("GET", `/api/projects/${proj.id}/completion-preflight`)).body.checks;
    const keys = (pf?.blockers || []).map((b) => b.key);
    ok(keys.includes("payment_reconciliation_required") && !keys.includes("deposit_unpaid"), `8b: completion names the reconciliation, not "unpaid" (${j(keys)})`);
    ok(/\$1,260\.00 unresolved/.test((pf.blockers.find((b) => b.key === "payment_reconciliation_required") || {}).message || ""), "8b: …with the $1,260 unresolved");
    const done = await srv.api("POST", `/api/projects/${proj.id}/complete`, { allowOverride: true, overrideReason: "test: try to force it", notify: false });
    ok(done.status === 409 && (await projects.get(proj.id)).status !== "complete" && balances().length === 0,
      `8c: an admin override cannot complete it — no balance invoice released (${done.status} ${j(done.body?.errors)})`);
    // Reconciled by recording the rest: satisfied, balance invoice made, blocker gone.
    await pay(dep.id, 1260, "cheque", "ref #88");
    const r = await inv(dep.id);
    const pf2 = (await srv.api("GET", `/api/projects/${proj.id}/completion-preflight`)).body.checks;
    ok(!recon(r).required && (await stage()) === "deposit_paid" && balances().length === 1, `8d: the missing $1,260 recorded → deposit satisfied, one balance invoice (${await stage()}, ${balances().length})`);
    ok(!(pf2?.blockers || []).some((b) => b.key === "payment_reconciliation_required" || b.key === "deposit_unpaid"), "8d: …and completion is no longer blocked by the deposit");
    ok((r.reconciliations || [])[0]?.resolution === "recorded_payment", "8d: …audited");
  }
} finally {
  await srv.stop();
}

console.log(`\npayment reconciliation: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

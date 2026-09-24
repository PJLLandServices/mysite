#!/usr/bin/env node
// scripts/test-taptopay-server.mjs
//
// Tap to Pay on iPhone, the server half: the phone takes the card, the
// SERVER decides what it charges and whether the invoice is paid.
//
// WHY. The reference implementation (claude/pjl-field-taptopay, Sep 2026)
// had the phone create the PaymentIntent for an amount it read off the
// screen, then POST /payments with method card_qb and the intent id in a
// free-text note. The invoice was marked paid on the phone's say-so. The
// rest of this system never does that: finalizeStripeInvoicePayment
// exists precisely because "the browser's word is not evidence". So Tap
// to Pay goes through the same door as the pay page and the webhook:
//
//   POST /api/invoices/:id/terminal-intent            (admin)
//     - the same on-site rule as "Take payment now"
//       (invoices.openForOnSitePayment: Bill-later drafts, $0 and
//       custom-quote placeholders are refused, nothing is charged)
//     - the amount is the server's balanceDue, never the phone's
//     - card_present + interac_present (Interac is most debit in Canada)
//     - reused while open, so a second tap does not mint a second charge
//   POST /api/invoices/:id/terminal-intent/finalize   (admin)
//     - re-reads the intent FROM STRIPE and runs finalizeStripeInvoicePayment
//       (belongs to this invoice, succeeded, right amount, right currency,
//       idempotent), which records the ledger payment, QBO, receipt
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
//
// Run: node scripts/test-taptopay-server.mjs   (also in build:check)

import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4871 });
try {
  await srv.login();
  const complete = async (id) => srv.api("PATCH", `/api/work-orders/${id}`, {
    status: "completed", signature: SIGNATURE, arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString()
  });
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;
  const stripeCalls = () => srv.outbox().filter((e) => e.channel === "stripe");
  const creates = () => stripeCalls().filter((e) => e.method === "POST" && e.path === "/v1/payment_intents");

  // A finished "Paid on site" closing: a draft invoice, payable on site.
  const f = await srv.fixture();
  await srv.prepClosing(f.wo.id, { paidOnSite: true });
  const c = await complete(f.wo.id);
  ok(c.status === 200, `the closing completes (${c.status})`);
  await sleep(300);
  const inv = invoiceFor(f.wo.id);
  ok(inv?.status === "draft" && Number(inv?.balanceDue) > 0, `the cascade drafted an invoice with a balance (${inv?.status} ${inv?.balanceDue})`);
  const dueCents = Math.round(Number(inv?.balanceDue) * 100);

  // ---- A. the intent: server amount, in-person methods, this invoice ----
  const before = creates().length;
  // The phone's opinion of the amount is ignored — sent only to prove it.
  const a = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, { amountCents: 1 });
  ok(a.status === 200 && a.body.ok, `Tap to Pay gets an intent (${a.status} ${a.body.errors?.[0] || ""})`);
  ok(typeof a.body.clientSecret === "string" && a.body.clientSecret.length > 0, "…with the client secret the SDK retrieves it by");
  ok(a.body.amountCents === dueCents, `…for the server's balance, not the phone's number (${a.body.amountCents} vs ${dueCents})`);
  const made = creates().slice(before);
  ok(made.length === 1, `exactly one intent was created at Stripe (${made.length})`);
  const form = made[0]?.form || {};
  ok(Number(form.amount) === dueCents, `Stripe was asked for the balance (${form.amount})`);
  ok(form["payment_method_types[0]"] === "card_present" && form["payment_method_types[1]"] === "interac_present",
    `card_present + interac_present (${form["payment_method_types[0]"]}, ${form["payment_method_types[1]"]})`);
  ok(!Object.values(form).includes("card"), "never the online 'card' method — the pay page's intent is a different thing");
  ok(form.capture_method === "automatic", `captured on approval (${form.capture_method})`);
  ok(form["metadata[invoiceId]"] === inv.id, "metadata.invoiceId ties it to this invoice (what the finalizer and webhook check)");
  ok(form["metadata[source]"] === "pjl-field-taptopay", `metadata.source says Tap to Pay (${form["metadata[source]"]})`);
  const opened = invoiceFor(f.wo.id);
  ok(opened?.status === "draft" && Boolean(opened?.onSitePayment?.openedAt), "the draft is opened for on-site payment, not sent");
  ok(opened?.stripeTerminalIntentId === a.body.paymentIntentId, "the open intent is remembered on the invoice");

  // ---- B. a second tap reuses it -----------------------------------------
  const b = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
  ok(b.status === 200 && b.body.paymentIntentId === a.body.paymentIntentId, `a second tap reuses the open intent (${b.body.paymentIntentId})`);
  ok(creates().length === before + 1, "…and creates nothing new at Stripe");

  // ---- C. finalize refuses what Stripe has not approved -------------------
  const early = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent/finalize`, { paymentIntentId: a.body.paymentIntentId });
  ok(early.status === 409, `finalizing an unpaid intent is refused (${early.status})`);
  ok(invoiceFor(f.wo.id)?.status !== "paid" && !(invoiceFor(f.wo.id)?.payments || []).length, "…and nothing is recorded");

  // ---- D. approved → paid through the one finalizer ------------------------
  srv.stripeSucceed(a.body.paymentIntentId);
  const d = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent/finalize`, { paymentIntentId: a.body.paymentIntentId });
  ok(d.status === 200 && d.body.invoice?.status === "paid", `an approved tap pays the invoice (${d.status} ${d.body.invoice?.status} ${d.body.errors?.[0] || ""})`);
  const paid = invoiceFor(f.wo.id);
  const pays = paid?.payments || [];
  ok(pays.length === 1 && Math.round(Number(pays[0]?.amount) * 100) === dueCents, `one ledger payment for the balance (${pays.length})`);
  ok(/Tap to Pay on iPhone/.test(pays[0]?.notes || ""), `the ledger says Tap to Pay, not "Online card payment" (${pays[0]?.notes})`);
  ok(paid?.stripePaymentIntentId === a.body.paymentIntentId, "the paying intent is recorded like any Stripe payment");
  const attempt = (paid?.paymentAttempts || []).find((x) => x.outcome === "success");
  ok(attempt?.cardLast4 === "4242", `the in-person card's last four reach the attempt record (${attempt?.cardLast4})`);
  const again = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent/finalize`, { paymentIntentId: a.body.paymentIntentId });
  ok(again.status === 200 && again.body.alreadyPaid === true, `finalizing twice is harmless (${again.status} alreadyPaid=${again.body.alreadyPaid})`);
  ok((invoiceFor(f.wo.id)?.payments || []).length === 1, "…still exactly one payment");
  const paidAgain = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
  ok(paidAgain.status === 409, `a paid invoice will not start another charge (${paidAgain.status})`);

  // ---- E. the on-site rule is the same one "Take payment now" uses -------
  {
    const g = await srv.fixture();
    await srv.prepClosing(g.wo.id, { paidOnSite: false });
    await complete(g.wo.id);
    await sleep(300);
    const later = invoiceFor(g.wo.id);
    const n = stripeCalls().length;
    const e = await srv.api("POST", `/api/invoices/${later.id}/terminal-intent`, {});
    ok(e.status === 409 && e.body.code === "needs_review", `a "Bill later" draft is refused for review (${e.status} ${e.body.code})`);
    ok(stripeCalls().length === n, "…without touching Stripe");

    // ---- G. an intent from another invoice cannot pay this one -----------
    const wrong = await srv.api("POST", `/api/invoices/${later.id}/terminal-intent/finalize`, { paymentIntentId: a.body.paymentIntentId });
    ok(wrong.status === 409 && invoiceFor(g.wo.id)?.status !== "paid", `another invoice's approved intent is refused (${wrong.status})`);
    const none = await srv.api("POST", `/api/invoices/${later.id}/terminal-intent/finalize`, {});
    ok(none.status === 400, `finalize without an intent id is a 400 (${none.status})`);
  }

  // ---- F. staff-only --------------------------------------------------------
  {
    const h = await srv.fixture();
    await srv.prepClosing(h.wo.id, { paidOnSite: true });
    await complete(h.wo.id);
    await sleep(300);
    const other = invoiceFor(h.wo.id);
    const anon = await fetch(`${srv.BASE}/api/invoices/${other.id}/terminal-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    ok(anon.status === 401 || anon.status === 403, `no session, no intent (${anon.status})`);
    await srv.login({ role: "tech" });
    const tech = await srv.api("POST", `/api/invoices/${other.id}/terminal-intent`, {});
    ok(tech.status === 403, `a tech cannot start a charge — admin only, like the connection token (${tech.status})`);
    const techFin = await srv.api("POST", `/api/invoices/${other.id}/terminal-intent/finalize`, { paymentIntentId: "pi_x" });
    ok(techFin.status === 403, `…or finalize one (${techFin.status})`);
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
  console.error(srv.logs().slice(-1500));
} finally {
  await srv.stop();
}

console.log(`taptopay-server: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

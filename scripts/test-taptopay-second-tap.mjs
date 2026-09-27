#!/usr/bin/env node
// scripts/test-taptopay-second-tap.mjs
//
// Tap to Pay: a second tap never starts a second charge while the first can
// still take the customer's money (Patrick, 2026-09-27; E2E journey 5's
// finding, item 4).
//
// WHAT BROKE: POST /api/invoices/:id/terminal-intent looked at the invoice's
// stored intent and recognised only "collectable" (reuse it) and "succeeded"
// (finalize it). Anything else — `processing`, the reader dropped mid-charge —
// fell through and created a NEW intent. Its idempotency key includes the
// stored intent's id, so Stripe saw a new key: a real second charge, with
// the first still processing (and not cancellable). Also: if Stripe could
// not be read, the route fell through and created one anyway; and two taps
// at the same moment were serialised only by Stripe's idempotency key.
//
// THE RULE (server-side, keyed on the invoice's stored terminal intent,
// one tap at a time per invoice): stripe.intentPhase() says what the stored
// intent is —
//   collectable → reuse it (same amount), or cancel and replace it (the
//                 balance changed — it can't have taken money yet)
//   in flight   → (processing) refuse with its id and state; start nothing,
//                 cancel nothing — the reader's own outcome decides it
//   succeeded   → finalize it; start nothing
//   cancelled   → a fresh attempt
//   unreadable  → refuse; never start a charge beside one we can't see
//
// Run: node scripts/test-taptopay-second-tap.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, finish, invoiceFor, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---- one rule, in one place --------------------------------------------------------
{
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const at = server.indexOf("const terminalIntentMatch");
  const route = server.slice(at, server.indexOf("const terminalFinalizeMatch", at));
  ok(/stripe\.intentPhase\(/.test(route), "structure: the Tap to Pay route decides by stripe.intentPhase()");
  ok(/withTerminalIntentLock\(/.test(route), "structure: …one tap at a time per invoice");
  const lib = fs.readFileSync(new URL("../server/lib/stripe.js", import.meta.url), "utf8");
  ok(/intentPhase,/.test(lib), "structure: stripe.intentPhase is exported");
}

const srv = await bootServer({ port: 4943 });
try {
  await srv.login();
  // ---- the rule itself ---------------------------------------------------------
  {
    const { intentPhase } = srv.lib("stripe.js");
    const phase = (status) => (typeof intentPhase === "function" ? intentPhase(status == null ? status : { status }) : "(missing)");
    ok(["requires_payment_method", "requires_confirmation", "requires_action"].every((s) => phase(s) === "collectable"), "rule: open intents are collectable");
    ok(phase("processing") === "in_flight" && phase("requires_capture") === "in_flight", "rule: processing / requires_capture are in flight");
    ok(phase("succeeded") === "succeeded" && phase("canceled") === "canceled", "rule: succeeded and canceled are themselves");
    ok(phase("something_new") === "in_flight" && phase(null) === "in_flight", "rule: an unknown state is treated as in flight — never charge beside it");
  }

  let n = 0;
  async function closing(label, { zones = 4, paidOnSite = true } = {}) {
    n += 1;
    const f = await srv.fixture({ zones, email: `tt${n}@example.com`, name: `TT ${label}`, phone: `90555505${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`${label}: finish ${done.status} ${j(done.body)}`);
    return { f, inv: invoiceFor(srv, f.wo.id) };
  }
  const start = (inv) => srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
  const finalize = (inv, pi) => srv.api("POST", `/api/invoices/${inv.id}/terminal-intent/finalize`, { paymentIntentId: pi });
  const read = async (inv) => (await srv.api("GET", `/api/invoices/${inv.id}`)).body.invoice;
  const creates = (from) => srv.outbox().slice(from).filter((e) => e.channel === "stripe" && e.method === "POST" && e.path === "/v1/payment_intents").length;
  const cancels = (from, pi) => srv.outbox().slice(from).filter((e) => e.channel === "stripe" && e.method === "POST" && e.path === `/v1/payment_intents/${pi}/cancel`).length;

  // ---- A. second tap while the first is processing -------------------------------
  {
    const c = await closing("A");
    const first = await start(c.inv);
    const pi = first.body.paymentIntentId;
    ok(first.status === 200 && pi, `A: the first tap starts one intent (${first.status})`);
    srv.stripeMode(pi, "processing");
    const m0 = srv.outbox().length;
    const second = await start(c.inv);
    ok(second.status === 409 && second.body.code === "payment_in_progress", `A: a tap while it's processing is refused as in progress (${second.status} ${second.body.code})`);
    ok(second.body.paymentIntentId === pi && second.body.intentStatus === "processing", `A: …and says which payment and its state (${j([second.body.paymentIntentId, second.body.intentStatus])})`);
    ok(creates(m0) === 0, `A: no second intent is created (${creates(m0)})`);
    ok(cancels(m0, pi) === 0, "A: the processing intent is not cancelled");
    ok((await read(c.inv)).stripeTerminalIntentId === pi, "A: the invoice still points at the first intent");
    // Then the reader's charge completes: paid once.
    srv.stripeMode(pi, "succeeded");
    const fin = await finalize(c.inv, pi);
    const r = await read(c.inv);
    ok(fin.status === 200 && r.status === "paid" && (r.payments || []).length === 1 && !(r.paymentExceptions || []).length,
      `A: when it completes, the invoice is paid once — no exception (${j([fin.status, r.status, (r.payments || []).length])})`);
  }

  // ---- B. simultaneous first taps --------------------------------------------------
  {
    const c = await closing("B");
    const m0 = srv.outbox().length;
    const replies = await Promise.all([start(c.inv), start(c.inv), start(c.inv)]);
    const ids = [...new Set(replies.map((r) => r.body.paymentIntentId))];
    ok(replies.every((r) => r.status === 200) && ids.length === 1, `B: three taps at once all get the SAME intent (${j(replies.map((r) => [r.status, r.body.paymentIntentId]))})`);
    ok(creates(m0) === 1, `B: exactly one intent is created (${creates(m0)})`);
    ok((await read(c.inv)).stripeTerminalIntentId === ids[0], "B: …and it is the one the invoice points at");
  }

  // ---- C. simultaneous taps while processing ---------------------------------------
  {
    const c = await closing("C");
    const pi = (await start(c.inv)).body.paymentIntentId;
    srv.stripeMode(pi, "processing");
    const m0 = srv.outbox().length;
    const replies = await Promise.all([start(c.inv), start(c.inv), start(c.inv)]);
    ok(replies.every((r) => r.status === 409 && r.body.code === "payment_in_progress" && r.body.paymentIntentId === pi), `C: every tap is refused as in progress (${j(replies.map((r) => [r.status, r.body.code]))})`);
    ok(creates(m0) === 0 && cancels(m0, pi) === 0, `C: nothing created, nothing cancelled (${creates(m0)})`);
  }

  // ---- D. the stored intent already succeeded (the flip hasn't landed) -------------
  {
    const c = await closing("D");
    const pi = (await start(c.inv)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    const m0 = srv.outbox().length;
    const again = await start(c.inv);
    const r = await read(c.inv);
    ok(again.status === 409 && again.body.code === "already_paid", `D: a tap after it succeeded finalizes instead of charging (${again.status} ${again.body.code})`);
    ok(creates(m0) === 0 && r.status === "paid" && (r.payments || []).length === 1, `D: paid once, no new intent (${j([r.status, (r.payments || []).length, creates(m0)])})`);
    const third = await start(c.inv);
    ok(third.status === 409 && third.body.code === "already_paid" && creates(m0) === 0, `D: …and a further tap starts nothing (${third.status})`);
  }

  // ---- E. failed / cancelled, then a valid retry ------------------------------------
  {
    // E1 declined: the same intent takes another card.
    const c1 = await closing("E1");
    const pi1 = (await start(c1.inv)).body.paymentIntentId;
    srv.stripeMode(pi1, "declined");
    const m1 = srv.outbox().length;
    const retry1 = await start(c1.inv);
    ok(retry1.status === 200 && retry1.body.paymentIntentId === pi1 && creates(m1) === 0, `E1: after a decline, the retry reuses the same intent (${retry1.status} ${retry1.body.paymentIntentId === pi1})`);

    // E2 cancelled at Stripe: a fresh attempt.
    const c2 = await closing("E2");
    const pi2 = (await start(c2.inv)).body.paymentIntentId;
    srv.stripeMode(pi2, "canceled");
    const m2 = srv.outbox().length;
    const retry2 = await start(c2.inv);
    ok(retry2.status === 200 && retry2.body.paymentIntentId && retry2.body.paymentIntentId !== pi2 && creates(m2) === 1, `E2: after a cancel, the retry starts one fresh intent (${retry2.status} ${creates(m2)})`);
    ok((await read(c2.inv)).stripeTerminalIntentId === retry2.body.paymentIntentId, "E2: …and the invoice points at it");
    const again2 = await start(c2.inv);
    ok(again2.status === 200 && again2.body.paymentIntentId === retry2.body.paymentIntentId && creates(m2) === 1, "E2: a further tap reuses the fresh one");

    // E3 the balance changed under an open intent: it is replaced (it can't have charged).
    const c3 = await closing("E3");
    const pi3 = (await start(c3.inv)).body.paymentIntentId;
    await srv.api("POST", `/api/invoices/${c3.inv.id}/payments`, { amount: 20, method: "cash" });
    const m3 = srv.outbox().length;
    const retry3 = await start(c3.inv);
    ok(retry3.status === 200 && retry3.body.paymentIntentId !== pi3 && retry3.body.amountCents === Math.round((c3.inv.total - 20) * 100),
      `E3: the balance changed: a new intent for the new balance (${retry3.status} ${retry3.body.amountCents})`);
    ok(cancels(m3, pi3) === 1 && creates(m3) === 1, `E3: …and the stale open one is cancelled (${cancels(m3, pi3)})`);

    // E4 the balance changed while one is PROCESSING: still refused, nothing cancelled.
    const c4 = await closing("E4");
    const pi4 = (await start(c4.inv)).body.paymentIntentId;
    srv.stripeMode(pi4, "processing");
    await srv.api("POST", `/api/invoices/${c4.inv.id}/payments`, { amount: 20, method: "cash" });
    const m4 = srv.outbox().length;
    const retry4 = await start(c4.inv);
    ok(retry4.status === 409 && retry4.body.code === "payment_in_progress" && creates(m4) === 0 && cancels(m4, pi4) === 0,
      `E4: a processing charge is never replaced, even if the balance moved (${retry4.status} ${retry4.body.code})`);
  }

  // ---- F. Stripe can't be read: never charge beside an unknown -----------------------
  {
    const c = await closing("F");
    const pi = (await start(c.inv)).body.paymentIntentId;
    srv.stripeMode(pi, "unreachable");
    const m0 = srv.outbox().length;
    const blind = await start(c.inv);
    ok(blind.status === 502 && blind.body.code === "stripe_unreadable", `F: can't read the earlier payment → refused (${blind.status} ${blind.body.code})`);
    ok(creates(m0) === 0, `F: …and no second intent (${creates(m0)})`);
    srv.stripeMode(pi, null);
    const back = await start(c.inv);
    ok(back.status === 200 && back.body.paymentIntentId === pi, "F: once Stripe answers, the same intent is reused");
  }

  // ---- G. with #332's payment exceptions ---------------------------------------------
  {
    const c = await closing("G");
    const pi = (await start(c.inv)).body.paymentIntentId;
    srv.stripeMode(pi, "processing");
    // The customer pays cash in full while the reader is still processing.
    const cash = await srv.api("POST", `/api/invoices/${c.inv.id}/payments`, { amount: c.inv.total, method: "cash" });
    ok(cash.status === 201, `G: cash in full recorded (${cash.status})`);
    const m0 = srv.outbox().length;
    const tap = await start(c.inv);
    ok(tap.status === 409 && tap.body.code === "already_paid" && creates(m0) === 0, `G: a paid invoice starts no charge (${tap.status} ${tap.body.code})`);
    // …then the reader's charge completes after all: an exception, not a second ledger line.
    srv.stripeMode(pi, "succeeded");
    await finalize(c.inv, pi);
    await sleep(400);
    const r = await read(c.inv);
    ok(r.balanceDue === 0 && (r.payments || []).length === 1 && (r.paymentExceptions || []).length === 1 && money(r.paymentExceptions[0].excess) === money(c.inv.total) && r.needsReconciliation === true,
      `G: the processing charge that completes becomes ONE payment exception (${j([(r.payments || []).length, (r.paymentExceptions || []).length, r.paymentExceptions?.[0]?.excess])})`);
  }

  // ---- H. held / unconfirmed invoices are still refused ------------------------------
  {
    const later = await closing("H1", { paidOnSite: false });
    const m0 = srv.outbox().length;
    const h1 = await start(later.inv);
    ok(h1.status === 409 && h1.body.code === "needs_review" && creates(m0) === 0, `H: a Bill-later draft is refused (${h1.status} ${h1.body.code})`);
    const custom = await closing("H2", { zones: 16 });
    const h2 = await start(custom.inv);
    ok(h2.status === 409 && h2.body.code === "needs_pricing" && creates(m0) === 0, `H: an unconfirmed price is refused (${h2.status} ${h2.body.code})`);
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`taptopay-second-tap: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

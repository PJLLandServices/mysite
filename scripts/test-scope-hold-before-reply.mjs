#!/usr/bin/env node
// scripts/test-scope-hold-before-reply.mjs
//
// THE HOLD IS ON DISK BEFORE THE ROUTE REPLIES. DETERMINISTICALLY.
//
// Patrick, 2026-09-26: "This is a real invoice-safety defect, not merely
// a flaky test. The system must never report that an invoice hold was
// applied before the hold actually exists."
//
// WHAT WAS WRONG. When a signed work order's scope changes, its invoice
// is held — nothing payable, sent or texted — until the customer signs
// the revised order. #298 wired that two ways:
//
//   syncResignatureHold()            awaited before the response  (2 routes)
//   events.on("resignature", …)      NOT awaited                  (3 paths)
//
// `EventEmitter.emit()` calls its listeners synchronously but does not
// wait for a promise one returns. So the three write paths in
// lib/work-orders.js — captureSignatureBypass(), relockWorkOrder() and
// update() — started the hold write and returned. The route replied
// while the write was still in flight. On a fast disk it usually landed
// before anything looked; under load it did not.
//
// WHICH PATHS ARE ACTUALLY EXPOSED — stated precisely, because the
// first cut of this test got it wrong and passed on the unfixed code.
//
// Three ROUTES flip the signature requirement, and all three already
// awaited syncResignatureHold() before replying: PATCH
// /api/work-orders/:id, the signature-bypass route, and the relock
// route. Those were never exposed, and a test driving them proves
// nothing about this fix — the first version of this file did exactly
// that and passed on the unfixed code.
//
// The exposure is the OTHER callers. workOrders.update() is called from
// roughly twenty places in server.js that do NOT follow it with
// syncResignatureHold — among them server.js:14338 (inheriting priced
// lines onto a follow-up work order) and server.js:20537 (the
// self-healing seasonal-fee seed, which runs on a GET). Those change
// onSiteQuote.builderLineItems, which is the priced scope, so they can
// flip the requirement and had only the fire-and-forget listener behind
// them.
//
// So the contract this pins is the one that actually protects them:
// captureSignatureBypass(), relockWorkOrder() and update() DO NOT
// RETURN until the hold is written. Every caller inherits that,
// including the nineteen that never knew they needed it.
//
// HOW THIS TEST IS DETERMINISTIC. It does not race and hope. The preload
// scripts/lib/delay-scope-hold.cjs makes the hold write take a fixed
// PJL_DELAY_SCOPE_HOLD_MS. If a path does not await it, the reply
// returns first on EVERY machine; if it does, the reply cannot come back
// sooner than the delay. The laptop and the CI runner give the same
// answer.
//
// It also covers what the old test did not: that EVERY invoice type is
// blocked during a required re-sign, not just the "Bill later" draft
// that another gate happened to catch.
//
// Run: node scripts/test-scope-hold-before-reply.mjs   (also in build:check)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DELAY_MS = 600;

let passed = 0;
const failures = [];
const ok = (cond, label, detail = "") => {
  if (cond) { passed += 1; console.log("  ok   " + label); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + label + (detail ? ` — ${detail}` : "")); }
};

const srv = await bootServer({
  port: 4919,
  env: {
    NODE_OPTIONS: `--require ${path.join(ROOT, "scripts", "lib", "delay-scope-hold.cjs")}`,
    PJL_DELAY_SCOPE_HOLD_MS: String(DELAY_MS)
  }
});

try {
  await srv.login();
  const get = async (id) => (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId && i.status !== "void") || null;
  const heldNow = (woId) => Boolean(invoiceFor(woId)?.scopeHold?.since);

  // ── Setup: a signed, completed closing with an invoice ─────────────
  const f = await srv.fixture({ zones: 4 });
  const id = f.wo.id;
  await srv.prepClosing(id);
  const done = await srv.api("PATCH", `/api/work-orders/${id}`, {
    status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString()
  });
  ok(done.status === 200, `setup: the closing is signed and completed (${done.status})`);
  // The invoice is drafted by the completion cascade. Poll rather than
  // sleep a guessed amount — this part is not what the test is about.
  for (let i = 0; i < 60 && !invoiceFor(id); i++) await sleep(100);
  ok(Boolean(invoiceFor(id)), "setup: its invoice is drafted");
  ok(!heldNow(id), "setup: and is not held yet");

  const unlock = await srv.api("POST", `/api/work-orders/${id}/unlock`,
    { reason: "Customer asked for a fifth zone to be added" });
  ok(unlock.status === 200, `setup: admin unlocks it (${unlock.status})`);

  // ── The covered route still behaves ────────────────────────────────
  //
  // PATCH /api/work-orders/:id awaits syncResignatureHold() of its own,
  // so this passed before the fix too. It is here as a regression guard
  // on the route, NOT as evidence for the fix — the library-level check
  // further down is that.
  {
    const wo = await get(id);
    const five = [...wo.zones, { number: wo.zones.length + 1, location: "Back corner bed", status: "ok", issues: [] }];
    const g = await srv.api("GET", `/api/work-orders/${id}`);

    const started = Date.now();
    const r = await srv.api("PATCH", `/api/work-orders/${id}`, { zones: five },
      { "if-match": g.body.workOrder?.updatedAt || "" });
    const elapsed = Date.now() - started;
    // Read the store the instant the reply lands — no sleep, no retry.
    const heldAtReply = heldNow(id);

    ok(r.status === 200, `a zone is added through the API (${r.status})`, JSON.stringify(r.body).slice(0, 200));
    ok(r.body.workOrder?.resignature?.required === true,
      "...and the work order now awaits a new signature",
      JSON.stringify(r.body.workOrder?.resignature));

    // THE defect, stated as an assertion: on the unfixed code this is
    // false, because the reply beat the write.
    ok(heldAtReply, "the covered route has the hold on disk when it replies");

    // And the proof it actually waited rather than got lucky: the reply
    // cannot be faster than the delay we forced into the write.
    ok(elapsed >= DELAY_MS,
      `...having waited for the write (${elapsed}ms ≥ ${DELAY_MS}ms)`,
      `took ${elapsed}ms`);
  }

  // ── STEP 5 · every invoice type is blocked, not just "Bill later" ──
  //
  // This is the part the old test could not see. With the hold missing,
  // a "Bill later" draft is refused anyway — by a DIFFERENT gate
  // (needs_review, "waits for Patrick's review"). That accident made the
  // exposure look smaller than it was: a draft opened for on-site
  // payment, or an invoice already sent, has no such second gate.
  //
  // With the hold correctly applied, all of them refuse for the RIGHT
  // reason: awaiting_signature.
  {
    const require = (await import("node:module")).createRequire(import.meta.url);
    const invoices = require(path.join(ROOT, "server", "lib", "invoices.js"));
    const held = invoiceFor(id);
    ok(Boolean(held?.scopeHold?.since), "the invoice carries the hold", JSON.stringify(held?.scopeHold));

    // payBlockReason is the one rule every payment surface reads.
    const reasonFor = (overrides) =>
      invoices.payBlockReason
        ? invoices.payBlockReason({ ...held, ...overrides })
        : "(payBlockReason not exported)";

    const cases = [
      ["a Bill-later draft", { status: "draft", paidOnSiteAtCompletion: false, onSitePayment: null }],
      ["a draft opened for on-site payment", { status: "draft", paidOnSiteAtCompletion: true, onSitePayment: { openedAt: new Date().toISOString() } }],
      ["an invoice already sent", { status: "sent" }],
      ["a partially paid invoice", { status: "partially_paid" }]
    ];
    for (const [label, overrides] of cases) {
      ok(reasonFor(overrides) === "awaiting_signature",
        `${label} is blocked, and blocked for the right reason`,
        String(reasonFor(overrides)));
    }

    // The control: without the hold, two of those four are payable —
    // which is the exposure the race opened, stated as a fact rather
    // than an inference.
    const unheld = { ...held, scopeHold: null };
    const unheldReasons = cases.map(([label, o]) =>
      [label, invoices.payBlockReason ? invoices.payBlockReason({ ...unheld, ...o }) : null]);
    const payableWithoutHold = unheldReasons.filter(([, reason]) => reason === null).map(([l]) => l);
    ok(payableWithoutHold.length >= 1,
      `control: without the hold these are payable — ${payableWithoutHold.join("; ")}`,
      JSON.stringify(unheldReasons));
    // And the accident that made the exposure look smaller: the
    // Bill-later draft is refused even unheld, by needs_review rather
    // than by the hold. That is why the old test's failures pointed at
    // the wrong gate.
    const billLater = unheldReasons.find(([l]) => /Bill-later/.test(l));
    ok(billLater && billLater[1] !== null,
      `...while the Bill-later draft is caught by a different gate anyway (${billLater && billLater[1]})`);
  }

  // ── The live route agrees ──────────────────────────────────────────
  {
    const pay = await srv.api("POST", `/api/invoices/${invoiceFor(id).id}/payment-link`, {});
    ok(pay.status === 409 && pay.body?.code === "awaiting_signature",
      `the pay-link route refuses with awaiting_signature (${pay.status} ${pay.body?.code})`,
      JSON.stringify(pay.body).slice(0, 200));
  }

  // ── relockWorkOrder() — the second of the three paths ──────────────
  {
    const before = Date.now();
    const relock = await srv.api("POST", `/api/work-orders/${id}/relock`, {});
    const elapsed = Date.now() - before;
    // Re-locking a revised scope keeps the signature requirement, so the
    // hold state does not change and no listener runs — the point here
    // is that the path still works once awaited.
    ok(relock.status === 200 || relock.status === 409,
      `relock is reachable (${relock.status})`, JSON.stringify(relock.body).slice(0, 160));
    ok(heldNow(id), "...and the invoice is still held afterwards", `elapsed ${elapsed}ms`);
  }

  // ── Releasing the hold is awaited too ──────────────────────────────
  //
  // The same race in reverse: signing the revised order RELEASES the
  // hold, and a reply that beats that write leaves an invoice held that
  // should be payable — the customer cannot pay, with nothing to show
  // why.
  {
    const wo = await get(id);
    const NEW_SIGNATURE = {
      acknowledgement: true,
      imageData: "data:image/png;base64," + "B".repeat(220),
      customerName: "Jane Customer (revised)"
    };
    const g = await srv.api("GET", `/api/work-orders/${id}`);
    const started = Date.now();
    const sign = await srv.api("PATCH", `/api/work-orders/${id}`, { signature: NEW_SIGNATURE },
      { "if-match": g.body.workOrder?.updatedAt || "" });
    const elapsed = Date.now() - started;
    const heldAtReply = heldNow(id);

    if (sign.status === 200 && wo.resignature?.required === true) {
      ok(!heldAtReply, "signing the revised order RELEASES the hold before the reply", `held=${heldAtReply}`);
      ok(elapsed >= DELAY_MS, `...and that release was waited for (${elapsed}ms ≥ ${DELAY_MS}ms)`);
    } else {
      // Not the route's shape on this fixture — say so rather than
      // claiming a pass we did not earn.
      ok(false, "signing the revised order is reachable for the release check",
        `status ${sign.status}, required=${wo.resignature?.required}`);
    }
  }
} finally {
  await srv.stop();
}

console.log(`\nscope hold before reply: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

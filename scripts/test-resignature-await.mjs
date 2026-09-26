#!/usr/bin/env node
// scripts/test-resignature-await.mjs
//
// THE WRITE FINISHES BEFORE THE FUNCTION RETURNS.
//
// Patrick, 2026-09-26: "The system must never report that an invoice
// hold was applied before the hold actually exists."
//
// WHAT WAS WRONG. When a signed work order's priced scope changes, its
// invoice is held until the customer signs the revised order. #298
// delivered that through an EventEmitter:
//
//     events.emit("resignature", after);          // work-orders.js
//     …
//     workOrders.events.on("resignature", (wo) => {
//       invoices.setScopeHold(…).catch(log);      // server.js — no return
//     });
//
// `emit()` calls listeners synchronously but does NOT wait for a
// promise one returns. So the hold write STARTED and the function
// returned. Whether the hold existed when the caller carried on was a
// matter of which won: the disk write, or the rest of the request.
//
// WHY THIS TEST AND NOT AN HTTP ONE. The first attempt drove
// PATCH /api/work-orders/:id and passed on the UNFIXED code — because
// that route already awaits syncResignatureHold() of its own, as do the
// signature-bypass and relock routes. Those three were never the
// exposure, and a test through them proves nothing.
//
// The exposure is every OTHER caller. workOrders.update() is called
// from roughly twenty places in server.js with no such follow-up —
// among them server.js:14338 (pull-baseline-from-parent, which rewrites
// onSiteQuote.builderLineItems, i.e. the priced scope) and
// server.js:20537 (the self-healing seasonal-fee seed). They had only
// the fire-and-forget listener behind them.
//
// So this pins the contract that covers all of them at once, including
// the nineteen that never knew they needed it:
//
//     update(), captureSignatureBypass() and relockWorkOrder() do not
//     return until every "resignature" listener has settled.
//
// Deterministic by construction: the listener takes a fixed time, and
// the assertion is ordering, not duration. No load, no luck, same
// answer on a laptop and a loaded runner.
//
// Run: node scripts/test-resignature-await.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");

let passed = 0;
const failures = [];
const ok = (cond, label, detail = "") => {
  if (cond) { passed += 1; console.log("  ok   " + label); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + label + (detail ? ` — ${detail}` : "")); }
};

// On the UNFIXED code the rejecting listener below produces an
// unhandled rejection — nothing awaits it, which is the defect. Swallow
// it here so the run reports its whole failure list instead of dying at
// the first one and hiding the rest.
process.on("unhandledRejection", (err) => {
  console.log("  (note) unhandled rejection from an un-awaited listener: " + (err?.message || err));
});

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["work-orders.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

try {
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  // A signed, UNLOCKED work order with a priced line — the state a
  // re-sign requirement is decided from. Written straight into the
  // store: this is fixture setup, and going through the whole booking →
  // closing → signature flow would make the test about that flow.
  const WO_ID = "WO-AWAIT-TEST";
  const base = {
    id: WO_ID,
    type: "fall_closing",
    status: "completed",
    locked: false,                       // unlocked: a scope change counts
    signature: { signed: true, signedAt: "2026-09-20T15:00:00.000Z", customerName: "Jane Customer" },
    zones: [],
    onSiteQuote: {
      status: "draft",
      builderLineItems: [{ key: "fall_close_4z", label: "Fall closing — 4 zones", qty: 1, price: 180 }]
    },
    history: [],
    createdAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T15:00:00.000Z"
  };
  fs.writeFileSync(path.join(DATA, "work-orders.json"), JSON.stringify([base], null, 2));

  // ── The listener, deliberately slow ────────────────────────────────
  //
  // Stands in for invoices.setScopeHold(). It records when it finished;
  // the assertion is whether update() returned before or after that.
  const LISTENER_MS = 400;
  let finishedAt = null;
  let startedAt = null;
  let sawWorkOrder = null;
  const listener = (wo) => {
    startedAt = Date.now();
    sawWorkOrder = wo;
    return new Promise((resolve) => setTimeout(() => { finishedAt = Date.now(); resolve(); }, LISTENER_MS));
  };
  workOrders.events.on("resignature", listener);

  // ── Change the priced scope ────────────────────────────────────────
  const updated = await workOrders.update(WO_ID, {
    onSiteQuote: {
      status: "draft",
      builderLineItems: [
        { key: "fall_close_4z", label: "Fall closing — 4 zones", qty: 1, price: 180 },
        { key: "extra_zone", label: "Fifth zone", qty: 1, price: 35 }
      ]
    },
    __by: "admin"
  });
  const returnedAt = Date.now();

  ok(updated?.resignature?.required === true,
    "setup: changing the priced scope on a signed, unlocked WO requires a new signature",
    JSON.stringify(updated?.resignature));
  ok(startedAt !== null, "the resignature listener ran at all");
  ok(sawWorkOrder?.id === WO_ID, "...and was handed this work order", String(sawWorkOrder?.id));

  // THE assertion. On the unfixed code update() returns while the
  // listener is still pending, so finishedAt is null here.
  ok(finishedAt !== null,
    "UPDATE() DID NOT RETURN UNTIL THE LISTENER FINISHED",
    finishedAt === null ? "listener still pending when update() resolved — the write is not awaited" : "");
  ok(finishedAt !== null && returnedAt >= finishedAt,
    "...and returned after it, not before",
    `returned ${returnedAt}, listener finished ${finishedAt}`);

  // ── A listener that FAILS must not be swallowed ────────────────────
  //
  // A hold that could not be written, reported as success, breaks the
  // same rule the race did — just less often, which is worse rather
  // than better, because nobody goes looking.
  {
    workOrders.events.off("resignature", listener);
    const boom = () => Promise.reject(new Error("invoice store unavailable"));
    workOrders.events.on("resignature", boom);

    let threw = null;
    try {
      // Put the scope back — that CLEARS the requirement, so the
      // listener fires again.
      await workOrders.update(WO_ID, {
        onSiteQuote: {
          status: "draft",
          builderLineItems: [{ key: "fall_close_4z", label: "Fall closing — 4 zones", qty: 1, price: 180 }]
        },
        __by: "admin"
      });
    } catch (err) { threw = err; }
    workOrders.events.off("resignature", boom);

    ok(threw !== null, "a hold that cannot be written is reported, not swallowed",
      threw ? "" : "update() resolved despite the listener rejecting");
    ok(threw === null || /invoice store unavailable/.test(String(threw.message)),
      "...with the underlying reason intact", String(threw && threw.message));
  }

  // ── No listeners, or no change: nothing to wait for ────────────────
  {
    const before = Date.now();
    // The scope is already back to the accepted one, so this changes
    // nothing about the requirement and must not fire anything.
    const again = await workOrders.update(WO_ID, { techNotes: "Gate code 4821." }, {});
    const elapsed = Date.now() - before;
    ok(Boolean(again), "an unrelated edit still succeeds with no listeners attached");
    ok(elapsed < LISTENER_MS, `...and is not slowed by the awaiting machinery (${elapsed}ms)`);
  }

  // ── The other half: server.js's listener must RETURN its promise ───
  //
  // Awaiting the emit achieves nothing if the listener starts the write
  // and returns undefined. That is a one-line mistake that would
  // silently restore the original race, so it is pinned here rather
  // than left to review.
  {
    const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
    const block = src.slice(src.indexOf('workOrders.events.on("resignature"'));
    const body = block.slice(0, block.indexOf("});") + 3);
    ok(/return\s+invoices\.setScopeHold\(/.test(body),
      "server.js's resignature listener RETURNS the hold write",
      body.replace(/\s+/g, " ").slice(0, 200));
    ok(!/\.catch\(/.test(body),
      "...and does not swallow its failure with a .catch()",
      body.replace(/\s+/g, " ").slice(0, 200));
  }
} finally {
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\nresignature await: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

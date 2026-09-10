#!/usr/bin/env node
// scripts/test-wo-unlock.mjs
//
// Tests for admin unlock / re-lock of work orders (2026-08-06).
//
// Motivating case: WO-BF86TWRW was bypass-locked with the $95 service
// call missing from its scope, and there was no way to add it. Before
// this, `locked` could only ever go one way.
//
// What's covered:
//   1. isScopeFrozen() — the freeze flag is wo.locked ALONE. This is the
//      load-bearing change: guards used to read
//      `locked || signature.signed`, which would have left a drawn-
//      signature WO frozen after an unlock (button appears to work, does
//      nothing). Identical behaviour for any WO never explicitly unlocked.
//   2. unlockWorkOrder() — refusals (not found, not locked, missing or
//      too-short reason) and the happy path.
//   3. The acceptance record SURVIVES an unlock — Patrick's ruling: flip
//      the flag, keep the record. Both the bypass and signature paths.
//   4. History: a wo_unlocked entry carrying the reason + how it was
//      locked, so the audit trail explains the override.
//   5. relockWorkOrder() — refusals (already locked, no acceptance record
//      to re-freeze against) and the happy path.
//   6. Full round trip: bypass → locked → unlock → edit scope → re-lock,
//      which is the actual WO-BF86TWRW recovery. The edit in the middle
//      must stick.
//   7. The "left unlocked" predicate used by the Unlocked filter on
//      /admin/work-orders — last lock event wins.
//
// Isolation: work-orders.js requires only node builtins and resolves its
// store as `<lib dir>/../data/work-orders.json`, so this runs against a
// copy in a temp directory and can never touch real data. Same pattern as
// test-wo-completedat.mjs.
//
// Run: node scripts/test-wo-unlock.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
async function throwsWithCode(fn, code, label) {
  try {
    await fn();
    failed += 1;
    console.error(`  FAIL: ${label} (expected a throw, got none)`);
  } catch (err) {
    if (err?.code === code) { passed += 1; }
    else { failed += 1; console.error(`  FAIL: ${label} (expected code "${code}", got "${err?.code}")`); }
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-wo-unlock-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
fs.copyFileSync(
  path.join(ROOT, "server", "lib", "work-orders.js"),
  path.join(SANDBOX, "lib", "work-orders.js")
);
const require = createRequire(import.meta.url);
const workOrders = require(path.join(SANDBOX, "lib", "work-orders.js"));
const WO_JSON = path.join(SANDBOX, "data", "work-orders.json");
fs.writeFileSync(WO_JSON, "[]\n", "utf8");

const fakeLead = {
  id: "L-TEST",
  customerId: "1",
  contact: { name: "Test Customer", email: "t@example.com", phone: "", address: "1 Test St" }
};
const GOOD_REASON = "Service call fee missing from scope";

// ---- 1. isScopeFrozen: wo.locked alone -------------------------------
{
  ok(workOrders.isScopeFrozen({ locked: true }) === true, "isScopeFrozen: locked → frozen");
  ok(workOrders.isScopeFrozen({ locked: false }) === false, "isScopeFrozen: unlocked → not frozen");
  ok(workOrders.isScopeFrozen({}) === false, "isScopeFrozen: absent locked → not frozen");
  ok(workOrders.isScopeFrozen(null) === false, "isScopeFrozen: null WO → not frozen (no crash)");

  // The behaviour change that makes unlock mean anything: a WO carrying a
  // real signature but locked:false is NOT frozen. Under the old
  // `locked || signature.signed` form this was frozen, and unlocking a
  // signed WO would have silently done nothing.
  ok(
    workOrders.isScopeFrozen({ locked: false, signature: { signed: true } }) === false,
    "isScopeFrozen: unlocked-but-signed → not frozen (unlock actually unlocks)"
  );
  ok(
    workOrders.isScopeFrozen({ locked: false, signatureBypass: { reason: "other" } }) === false,
    "isScopeFrozen: unlocked-but-bypassed → not frozen"
  );
  // ...and the normal case is untouched: signing sets locked, so a signed
  // WO that nobody unlocked still reads frozen.
  ok(
    workOrders.isScopeFrozen({ locked: true, signature: { signed: true } }) === true,
    "isScopeFrozen: signed + locked → frozen (unchanged for every existing WO)"
  );
}

// ---- 2. unlock refusals ----------------------------------------------
{
  await throwsWithCode(
    () => workOrders.unlockWorkOrder("WO-NOPE", { reason: GOOD_REASON }),
    "wo_not_found",
    "unlock: refuses a non-existent WO"
  );

  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  ok(wo.locked === false, "new WO starts unlocked");
  await throwsWithCode(
    () => workOrders.unlockWorkOrder(wo.id, { reason: GOOD_REASON }),
    "wo_not_locked",
    "unlock: refuses a WO that isn't locked"
  );

  await workOrders.captureSignatureBypass(wo.id, { reason: "customer_not_home", note: "Left for work" }, {});
  await throwsWithCode(
    () => workOrders.unlockWorkOrder(wo.id, {}),
    "reason_required",
    "unlock: refuses a missing reason"
  );
  await throwsWithCode(
    () => workOrders.unlockWorkOrder(wo.id, { reason: "oops" }),
    "reason_required",
    "unlock: refuses a too-short reason"
  );
  await throwsWithCode(
    () => workOrders.unlockWorkOrder(wo.id, { reason: "         " }),
    "reason_required",
    "unlock: refuses a whitespace-only reason"
  );
}

// ---- 3 + 4. Unlock preserves the bypass record, and logs why ---------
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  const bypassed = await workOrders.captureSignatureBypass(
    wo.id,
    { reason: "trusted_customer_verbal", note: "Faramarz approved verbally" },
    {}
  );
  ok(bypassed.locked === true, "bypass locks the WO");
  const bypassTs = bypassed.signatureBypass.ts;

  const unlocked = await workOrders.unlockWorkOrder(
    wo.id,
    { reason: GOOD_REASON, unlockedBy: "patrick" },
    { ip: "1.2.3.4", userAgent: "test-agent" }
  );
  ok(unlocked.locked === false, "unlock clears locked");
  ok(workOrders.isScopeFrozen(unlocked) === false, "unlocked WO is no longer scope-frozen");

  // The whole point of the flip-the-flag ruling.
  ok(!!unlocked.signatureBypass, "unlock PRESERVES the signatureBypass record");
  ok(unlocked.signatureBypass.ts === bypassTs, "preserved bypass is byte-identical (same ts)");
  ok(unlocked.signatureBypass.reason === "trusted_customer_verbal", "preserved bypass keeps its reason");
  ok(
    !!unlocked.signatureBypass.acceptedScopeSnapshot,
    "preserved bypass keeps its accepted-scope snapshot"
  );

  const entry = unlocked.history.filter((h) => h.action === "wo_unlocked").pop();
  ok(!!entry, "unlock writes a wo_unlocked history entry");
  ok(entry.by === "patrick", "history entry records who unlocked it");
  ok(entry.note.includes(GOOD_REASON), "history note carries the reason");
  ok(entry.after.reason === GOOD_REASON, "history after-state carries the reason verbatim");
  ok(entry.after.lockSource.includes("bypass"), "history records that a bypass held the lock");
  ok(entry.after.signatureRetained === true, "history states the acceptance record was retained");
  ok(entry.before.locked === true && entry.after.locked === false, "history before/after brackets the flip");
  ok(entry.after.ip === "1.2.3.4", "history captures the request IP");
}

// ---- 3b. Same, on the drawn-signature path ---------------------------
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  // Mirror what the PATCH route writes at a fresh sign: signature + locked.
  await workOrders.update(wo.id, {
    signature: { signed: true, customerName: "Real Customer", imageData: "data:image/png;base64,AAA", acknowledgement: true, signedAt: "2026-08-01T12:00:00.000Z" },
    locked: true
  });
  const signed = await workOrders.get(wo.id);
  ok(workOrders.isScopeFrozen(signed) === true, "signed WO is frozen");

  const unlocked = await workOrders.unlockWorkOrder(wo.id, { reason: GOOD_REASON }, {});
  ok(unlocked.locked === false, "unlock clears locked on a signed WO");
  ok(workOrders.isScopeFrozen(unlocked) === false, "signed WO is genuinely unfrozen after unlock");
  ok(unlocked.signature.signed === true, "unlock PRESERVES the drawn signature");
  ok(unlocked.signature.customerName === "Real Customer", "preserved signature keeps the customer name");
  ok(unlocked.signature.imageData.length > 0, "preserved signature keeps the image data");
  const entry = unlocked.history.filter((h) => h.action === "wo_unlocked").pop();
  ok(entry.after.lockSource === "customer signature", "history records that a signature held the lock");
}

// ---- 5. Re-lock refusals + happy path --------------------------------
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  await throwsWithCode(
    () => workOrders.relockWorkOrder(wo.id, {}),
    "no_acceptance_record",
    "relock: refuses a WO with no signature or bypass on file"
  );
  await throwsWithCode(
    () => workOrders.relockWorkOrder("WO-NOPE", {}),
    "wo_not_found",
    "relock: refuses a non-existent WO"
  );

  await workOrders.captureSignatureBypass(wo.id, { reason: "customer_not_home", note: "Vacant" }, {});
  await throwsWithCode(
    () => workOrders.relockWorkOrder(wo.id, {}),
    "wo_already_locked",
    "relock: refuses a WO that's already locked"
  );

  await workOrders.unlockWorkOrder(wo.id, { reason: GOOD_REASON }, {});
  const relocked = await workOrders.relockWorkOrder(wo.id, { relockedBy: "patrick" }, {});
  ok(relocked.locked === true, "relock re-freezes the WO");
  ok(workOrders.isScopeFrozen(relocked) === true, "re-locked WO is scope-frozen again");
  ok(!!relocked.signatureBypass, "relock leaves the acceptance record alone");
  const entry = relocked.history.filter((h) => h.action === "wo_relocked").pop();
  ok(!!entry && entry.by === "patrick", "relock writes a wo_relocked history entry");
}

// ---- 6. The WO-BF86TWRW round trip -----------------------------------
// Bypass-locked with no billable lines → unlock → add the $95 service
// call → re-lock. The edit in the middle is the thing that was
// impossible before.
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  await workOrders.captureSignatureBypass(wo.id, { reason: "customer_not_home", note: "Nobody on site at close" }, {});

  const locked = await workOrders.get(wo.id);
  ok(workOrders.isScopeFrozen(locked) === true, "round trip: starts frozen");
  ok((locked.onSiteQuote.builderLineItems || []).length === 0, "round trip: no billable lines — why nothing invoiced");

  await workOrders.unlockWorkOrder(wo.id, { reason: "Service call fee was never added to scope" }, {});
  const open = await workOrders.get(wo.id);
  ok(workOrders.isScopeFrozen(open) === false, "round trip: unlocked");

  // The scope edit the whole job exists for.
  await workOrders.update(wo.id, {
    onSiteQuote: {
      builderLineItems: [
        { sku: "service_call", label: "Service call (mobilization + quick assessment)", qty: 1, originalPrice: 95, overridePrice: null }
      ]
    }
  });
  const edited = await workOrders.get(wo.id);
  ok(edited.onSiteQuote.builderLineItems.length === 1, "round trip: service call line added while unlocked");
  ok(edited.onSiteQuote.builderLineItems[0].originalPrice === 95, "round trip: line carries the $95 from pricing.json");

  const done = await workOrders.relockWorkOrder(wo.id, {}, {});
  ok(done.locked === true, "round trip: re-locked");
  ok(done.onSiteQuote.builderLineItems.length === 1, "round trip: the edit survived the re-lock");
  ok(!!done.signatureBypass, "round trip: original bypass still on file throughout");

  // Ordering of the audit trail reads as a story.
  const actions = done.history.map((h) => h.action);
  ok(
    actions.indexOf("signature_bypassed") < actions.indexOf("wo_unlocked")
      && actions.indexOf("wo_unlocked") < actions.indexOf("wo_relocked"),
    "round trip: history reads bypass → unlock → relock in order"
  );
}

// ---- 7. The "left unlocked" predicate (Unlocked filter) --------------
// Mirrors isUnlockedByAdmin() in server/work-orders-index.js — last lock
// event wins, so an unlock/relock/unlock cycle still reads as unlocked.
{
  const isUnlockedByAdmin = (w) => {
    const events = (Array.isArray(w?.history) ? w.history : [])
      .filter((h) => h && (h.action === "wo_unlocked" || h.action === "wo_relocked"));
    return events.length > 0 && events[events.length - 1].action === "wo_unlocked";
  };

  ok(isUnlockedByAdmin({ history: [] }) === false, "filter: never-unlocked WO is not 'left unlocked'");
  ok(
    isUnlockedByAdmin({ history: [{ action: "signature_bypassed" }] }) === false,
    "filter: a plain bypassed WO is not 'left unlocked'"
  );
  ok(
    isUnlockedByAdmin({ history: [{ action: "wo_unlocked" }] }) === true,
    "filter: unlocked WO is 'left unlocked'"
  );
  ok(
    isUnlockedByAdmin({ history: [{ action: "wo_unlocked" }, { action: "wo_relocked" }] }) === false,
    "filter: unlock → relock is not 'left unlocked'"
  );
  ok(
    isUnlockedByAdmin({ history: [{ action: "wo_unlocked" }, { action: "wo_relocked" }, { action: "wo_unlocked" }] }) === true,
    "filter: unlock → relock → unlock is 'left unlocked' (last event wins)"
  );
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\nwo-unlock: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

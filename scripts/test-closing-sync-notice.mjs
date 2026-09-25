#!/usr/bin/env node
// scripts/test-closing-sync-notice.mjs
//
// The closing screen's yellow sync notice appears only when an upload has
// actually FAILED, never for the second every tap spends uploading.
//
// WHY. Patrick, 2026-09-25: "every time I click something on the app, it
// drops down the yellow syncing tab across the top. It causes the page to
// jump all over the place." Every tap records on the phone first
// (queue.patch) and then uploads (queue.flush). For that moment the queue
// counts one pending change, and the notice was shown for `pending > 0`,
// so it slid in above the stage tabs and slid out again on every tap,
// pushing the whole screen down and back up.
//
// The queue records an error for a key only when a flush attempt fails
// (network, auth, a server refusal) and clears it when one succeeds
// (src/offline/queue.mjs). So "pending AND an error" is exactly "the
// upload did not go through". That is when the notice has something to
// say. The header's "On phone · 1 pending" text still reports the brief
// normal wait, in place, without moving anything.
//
// Run: node scripts/test-closing-sync-notice.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREEN = fs.readFileSync(path.join(ROOT, "pjl-field/src/screens/ClosingScreen.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

let syncNoticeFor = null;
try {
  ({ syncNoticeFor } = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/sync-notice.js")).href));
} catch (err) {
  ok(false, `pjl-field/src/sync-notice.js exports syncNoticeFor (${err.code || err.message})`);
}

if (typeof syncNoticeFor === "function") {
  // The jump: a normal tap, uploading, nothing wrong.
  ok(syncNoticeFor({ pending: 1, error: null }) === null, "a tap that is simply uploading shows no notice");
  ok(syncNoticeFor({ pending: 3, error: null, syncing: true }) === null, "several queued taps, still uploading, show no notice");
  ok(syncNoticeFor({ pending: 0, error: null }) === null, "nothing pending, nothing shown");
  ok(syncNoticeFor(null) === null && syncNoticeFor(undefined) === null, "no state yet, nothing shown");

  // What the notice is FOR.
  ok(syncNoticeFor({ pending: 1, error: { code: "network", message: "x" } }) === "pending", "an upload that failed for want of signal shows the notice");
  ok(syncNoticeFor({ pending: 2, error: { code: "auth", message: "x" } }) === "pending", "a sign-in problem shows the notice (it is the way to sign in)");
  ok(syncNoticeFor({ pending: 1, error: { code: "server", message: "x" } }) === "pending", "a server refusal shows the notice with its message");
  ok(syncNoticeFor({ pending: 1, error: { code: "conflict", message: "x" } }) === "conflict", "a conflict still shows Keep mine / Use office's");
  ok(syncNoticeFor({ pending: 0, error: { code: "conflict", message: "x" } }) === "conflict", "a conflict shows even with nothing else pending");
  // A stale error with nothing left to send is not a reason to nag.
  ok(syncNoticeFor({ pending: 0, error: { code: "network", message: "x" } }) === null, "a leftover network error with nothing pending shows nothing");
}

// The screen decides from the rule, not from `pending > 0` again.
ok(/import \{ syncNoticeFor \} from '\.\.\/sync-notice';/.test(SCREEN), "ClosingScreen imports syncNoticeFor");
ok(!/syncState\.pending > 0 \? \(/.test(SCREEN), "ClosingScreen no longer shows the notice for any pending change");
ok(/notice === 'conflict' \? \(/.test(SCREEN) && /notice === 'pending' \? \(/.test(SCREEN), "both notice branches come from syncNoticeFor");
// The in-place header status still reports the normal wait.
ok(/syncState\.pending \? `On phone · \$\{syncState\.pending\} pending`/.test(SCREEN), "the header still says 'On phone · N pending' while a tap uploads");

console.log(`closing-sync-notice: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

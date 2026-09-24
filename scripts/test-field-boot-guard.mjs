#!/usr/bin/env node
// scripts/test-field-boot-guard.mjs
//
// When the field app fails to start, the phone SHOWS the error instead of
// closing.
//
// WHY. Build 12 (TestFlight, 2026-09-24) closed 0.35 s after every launch.
// The crash report (bug_type 309, SIGABRT on expo.controller.
// errorRecoveryQueue) said only that expo-updates' error recovery aborted
// on a JavaScript error during startup. With no older bundle to fall back
// to, it ends the app. The error's own words reached nobody.
//
//   A. describeBootError / bootErrorText: the error's name and message,
//      what the app was doing, a short stack, and the running commit —
//      and the advice to screenshot it, and that the CRM still works
//   B. installFatalHandler: a FATAL error goes to the screen and never to
//      the default handler (which aborts); a non-fatal one still does; a
//      handler that itself throws falls back to the default; no ErrorUtils
//      is a no-op
//   C. the app starts through BootGuard: index.js registers it, and it
//      loads App lazily inside a try, wraps it in an error boundary, and
//      imports nothing native at the top (if a native module is what
//      failed, the error screen must not depend on it)
//
// The screen itself was rendered under jest-expo (a module that throws
// while loading, a render error, and a normal start); that harness isn't a
// dependency of this repo, so this suite pins the logic and the wiring.
//
// Run: node scripts/test-field-boot-guard.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };

let be = null;
try { be = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/bootError.mjs")).href); } catch {}
ok(Boolean(be?.describeBootError), "pjl-field/src/bootError.mjs exists");

// ---- A. what the screen says -------------------------------------------------
if (be?.describeBootError) {
  const err = new Error("Cannot find native module 'ExpoSQLite'");
  err.stack = "Error: Cannot find native module 'ExpoSQLite'\n    at requireNativeModule (expo-modules-core)\n    at storage.js:1\n" + Array.from({ length: 30 }, (_, i) => `    at frame${i}`).join("\n");
  const d = be.describeBootError(err, { phase: "loading the app", versionLines: ["Commit 5a46f93 · TestFlight build (run #20)", "Running the bundle shipped with the build"] });
  ok(d.summary === "Error: Cannot find native module 'ExpoSQLite'", `A. names the error in its own words (${d.summary})`);
  ok(d.phase === "loading the app", "A. says what the app was doing");
  ok(d.stack.length === 12 && d.stack[0].startsWith("at requireNativeModule"), `A. a short stack, without repeating the message (${d.stack.length}: ${d.stack[0]})`);
  const text = be.bootErrorText(d);
  ok(text.includes("Commit 5a46f93") && text.includes("(while: loading the app)"), "A. the text carries the running commit and the phase");
  ok(/screenshot/i.test(d.advice) && /Safari/.test(d.advice), "A. it tells the tech what to do (screenshot it; the CRM still works)");
  const odd = be.describeBootError("a thrown string", {});
  ok(odd.summary === "Error: a thrown string" && Array.isArray(odd.stack), `A. a thrown non-Error is still described (${odd.summary})`);
  ok(be.describeBootError(null).summary === "Error: Unknown error", "A. …and so is nothing at all");
}

// ---- B. the fatal handler ----------------------------------------------------
if (be?.installFatalHandler) {
  const calls = [];
  let handler = null;
  const errorUtils = { getGlobalHandler: () => (e, f) => calls.push(["default", e.message, f]), setGlobalHandler: (h) => { handler = h; } };
  const shown = [];
  const undo = be.installFatalHandler(errorUtils, (e) => shown.push(e.message));
  handler(new Error("boom"), true);
  ok(shown.join() === "boom" && !calls.length, `B. a FATAL error goes to the screen, not the aborting default (${shown} / ${JSON.stringify(calls)})`);
  handler(new Error("minor"), false);
  ok(calls.length === 1 && calls[0][1] === "minor", "B. a non-fatal error still reaches the default handler");
  const eu2 = { getGlobalHandler: () => (e) => calls.push(["default2", e.message]), setGlobalHandler: (h) => { handler = h; } };
  be.installFatalHandler(eu2, () => { throw new Error("screen broke"); });
  handler(new Error("boom2"), true);
  ok(calls.some((c) => c[0] === "default2" && c[1] === "boom2"), "B. if showing it fails, the default handler still runs");
  ok(typeof be.installFatalHandler(undefined, () => {}) === "function", "B. no ErrorUtils (tests, web): a no-op");
  ok(typeof undo === "function", "B. it can be uninstalled");
}

// ---- C. the wiring -----------------------------------------------------------
{
  const index = read("pjl-field/index.js");
  ok(/import BootGuard from '\.\/src\/BootGuard'/.test(index) && /registerRootComponent\(BootGuard\)/.test(index) && !/import App from/.test(index),
    "C. index.js starts the app through BootGuard");
  const guard = read("pjl-field/src/BootGuard.js");
  ok(/try\s*\{\s*App = require\('\.\.\/App'\)\.default;/.test(guard), "C. BootGuard loads App lazily, inside a try");
  ok(/getDerivedStateFromError/.test(guard), "C. …wraps it in an error boundary");
  ok(/installFatalHandler\(global\.ErrorUtils/.test(guard), "C. …and installs the fatal handler");
  const imports = [...guard.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  ok(JSON.stringify(imports) === JSON.stringify(["react", "react-native", "./bootError.mjs"]),
    `C. …importing nothing native at the top (${JSON.stringify(imports)})`);
}

console.log(`field-boot-guard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

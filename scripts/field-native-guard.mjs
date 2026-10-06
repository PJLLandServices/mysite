#!/usr/bin/env node
// scripts/field-native-guard.mjs
//
// Main's over-the-air updates reach a phone only when they are published to
// the runtime that phone was built with, AND the update's JavaScript was
// built against the same native code. This is the check for both, before
// anything is published (PJL-114, one-app migration plan §3).
//
// WHY NOT THE FINGERPRINT POLICY. The fingerprint was the runtime once, and
// it did both jobs at once. It cannot any more: the Tap to Pay app has to be
// built on Patrick's Mac in Xcode (Apple's development entitlement only
// rides a development profile), and the Mac and the Linux runners hash the
// same tree differently — 41661c6f… on the Mac, a7df9c32… on Linux, same
// commit (docs/TTP_RUNTIME_PIN.md). A fingerprint-policy publish from CI
// lands on a runtime the phone is not listening on, and looks exactly like
// success.
//
// SO: the runtime is the app version (`runtimeVersion: { policy:
// "appVersion" }`, 1.1.0), which the Mac and CI agree on by construction;
// and the native code is checked here instead. config/field-native.json
// records, for each version, the native fingerprint (computed on Linux, the
// same way CI computes it) of the tree that version was built from. If the
// tree in front of us no longer has that fingerprint, its native code has
// changed since the build — a new module, a plugin, an SDK bump, app.json —
// and its JavaScript may need native code the phone does not have. Then the
// fix is a version bump and a new build, never a publish.
//
//   node scripts/field-native-guard.mjs              # computes the fingerprint in pjl-field/
//   node scripts/field-native-guard.mjs --fingerprint <hash>
//   node scripts/field-native-guard.mjs --print      # just prints the fingerprint (for recording)
//
// Exit 0 = may publish; 1 = must not.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "pjl-field");
const RECORD = path.join(ROOT, "config", "field-native.json");

// The rule, pure: what the app says, what was recorded, what the tree hashes to.
export function checkNative({ app, record, fingerprint }) {
  const rt = app?.runtimeVersion;
  if (!rt || typeof rt !== "object" || rt.policy !== "appVersion") {
    return { ok: false, message: `app.json runtimeVersion is ${JSON.stringify(rt)}; main publishes only on the appVersion policy (see scripts/field-native-guard.mjs).` };
  }
  const version = String(app?.version || "");
  const entry = record?.builds?.[version];
  if (!entry) {
    return { ok: false, message: `No native build of version ${version || "(none)"} is recorded in config/field-native.json, so no phone can be listening on runtime ${version || "(none)"}. Build it first, then record it.` };
  }
  if (!/^[0-9a-f]{40}$/.test(String(fingerprint || ""))) {
    return { ok: false, message: `Could not compute the native fingerprint (${JSON.stringify(fingerprint)}); refusing rather than guessing.` };
  }
  if (fingerprint !== entry.nativeFingerprint) {
    return { ok: false, message: `The native code has changed since version ${version} was built (fingerprint ${fingerprint}, built from ${entry.nativeFingerprint}). An update from this tree could need native code the phones do not have. Bump expo.version, build it on the Mac, record it in config/field-native.json, then publish.` };
  }
  return { ok: true, message: `Native code matches the ${version} build (${fingerprint}). Updates go to runtime ${version}.` };
}

function computeFingerprint() {
  const out = execFileSync("npx", ["expo-updates", "fingerprint:generate", "--platform", "ios"], { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out).hash;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--fingerprint");
  const fingerprint = at >= 0 ? args[at + 1] : computeFingerprint();
  if (args.includes("--print")) { console.log(fingerprint); process.exit(0); }
  const app = JSON.parse(fs.readFileSync(path.join(APP_DIR, "app.json"), "utf8")).expo;
  let record = null;
  try { record = JSON.parse(fs.readFileSync(RECORD, "utf8")); } catch {}
  const r = checkNative({ app, record, fingerprint });
  if (r.ok) console.log(r.message);
  else console.log(`::error::${r.message}`);
  process.exit(r.ok ? 0 : 1);
}

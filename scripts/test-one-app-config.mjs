#!/usr/bin/env node
// scripts/test-one-app-config.mjs
//
// One PJL Field app: Tap to Pay merged into main, photos saved to the
// iPhone library, and an update channel that reaches a phone built on the
// Mac (PJL-114, "One-app migration plan", approved by Patrick 2026-10-06).
//
// What has to be true of main's app before Patrick builds it in Xcode:
//
//   IDENTITY — same bundle id, so it installs over the Tap to Pay app and
//     keeps its data; the Tap to Pay entitlement and the Stripe reader
//     plugin, so Tap to Pay still works; the Tap to Pay code itself.
//   PHOTOS — expo-media-library with the ADD-ONLY wording (Patrick: no
//     album, "just download them to the library"), the read wording left as
//     it was, and the resizer for the upload copy, all at Expo SDK 54.
//   RUNTIME — the lane's literal pin never comes to main. main is on the
//     appVersion policy at 1.1.0, so the Mac and CI agree on the runtime by
//     construction (they never agreed on the fingerprint: 41661c6f on the
//     Mac, a7df9c32 on Linux, same tree). What the fingerprint used to
//     protect, the native guard protects instead: config/field-native.json
//     records the native fingerprint each version was built from, and
//     main's update workflow refuses to publish when the tree no longer
//     matches it (native code changed without a new version and build).
//
// Run: node scripts/test-one-app-config.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const APP = JSON.parse(read("pjl-field/app.json")).expo;
const PKG = JSON.parse(read("pjl-field/package.json"));
const deps = PKG.dependencies || {};
const plugin = (name) => (APP.plugins || []).find((p) => (Array.isArray(p) ? p[0] : p) === name);
const pluginOpts = (name) => { const p = plugin(name); return Array.isArray(p) ? p[1] || {} : {}; };

// ---- identity -------------------------------------------------------------
ok(APP.ios?.bundleIdentifier === "com.pjllandservices.field", `same bundle id as the installed app (${APP.ios?.bundleIdentifier})`);
ok(APP.ios?.entitlements?.["com.apple.developer.proximity-reader.payment.acceptance"] === true, "the Tap to Pay entitlement is on main's app");
ok(Boolean(plugin("@stripe/stripe-terminal-react-native")), "the Stripe Terminal (Tap to Pay reader) plugin is on main's app");
ok(/^0\.0\.1-beta\.32$/.test(deps["@stripe/stripe-terminal-react-native"] || ""), `…at the version the Tap to Pay build was proven on (${deps["@stripe/stripe-terminal-react-native"]})`);
ok(Boolean(plugin("./plugins/withNoUserScriptSandboxing")) && exists("pjl-field/plugins/withNoUserScriptSandboxing.js"), "the Xcode script-sandboxing fix the Mac build needs is on main");
for (const f of ["src/taptopay/TapToPayProvider.js", "src/taptopay/useTapToPay.js", "src/screens/TapToPaySettings.js"]) {
  ok(exists(`pjl-field/${f}`), `Tap to Pay code is on main: ${f}`);
}
ok(/TapToPayProvider/.test(read("pjl-field/App.js")), "App.js wraps the app in the Tap to Pay provider");
ok(/useTapToPay|tapToPay/.test(read("pjl-field/src/screens/InvoiceScreen.js")), "the invoice screen offers Tap to Pay");

// ---- photos ---------------------------------------------------------------
const ml = pluginOpts("expo-media-library");
ok(Boolean(plugin("expo-media-library")), "expo-media-library is on the app (saving to the photo library)");
ok(ml.savePhotosPermission === "PJL Field saves the photos you take on a visit to your Photos, so you have your own copy.",
  `the add-photos permission says what it is for (${JSON.stringify(ml.savePhotosPermission)})`);
ok(ml.photosPermission === APP.ios?.infoPlist?.NSPhotoLibraryUsageDescription,
  "the read permission wording is unchanged (media-library and Info.plist agree, so neither overwrites the other)");
ok(ml.isAccessMediaLocationEnabled === false, "no media-location access is asked for");
ok(!/album/i.test(JSON.stringify(ml)), "no album wording: photos go to the library only");
ok(/^~18\.2\./.test(deps["expo-media-library"] || ""), `expo-media-library at the SDK 54 version (${deps["expo-media-library"]})`);
ok(/^~14\.0\./.test(deps["expo-image-manipulator"] || ""), `expo-image-manipulator at the SDK 54 version (${deps["expo-image-manipulator"]})`);
ok(/^~19\.0\./.test(deps["expo-file-system"] || ""), `expo-file-system at the SDK 54 version (${deps["expo-file-system"]})`);
ok(/^~54\./.test(deps.expo || ""), `Expo stays at SDK 54 (${deps.expo})`);

// ---- runtime --------------------------------------------------------------
ok(JSON.stringify(APP.runtimeVersion) === JSON.stringify({ policy: "appVersion" }), `main is on the appVersion runtime policy (${JSON.stringify(APP.runtimeVersion)})`);
ok(!read("pjl-field/app.json").includes("41661c6f"), "the lane's literal runtime pin is not on main");
ok(APP.version === "1.1.0", `the one-app build is version 1.1.0 (${APP.version})`);

let record = null;
try { record = JSON.parse(read("config/field-native.json")); } catch {}
const entry = record?.builds?.[APP.version];
ok(Boolean(entry), `config/field-native.json records the native build for ${APP.version}`);
ok(/^[0-9a-f]{40}$/.test(entry?.nativeFingerprint || ""), `…with the native fingerprint it is built from (${entry?.nativeFingerprint})`);

// The guard, on cases.
let guard = null;
try { guard = await import(pathToFileURL(path.join(ROOT, "scripts", "field-native-guard.mjs")).href); } catch {}
ok(typeof guard?.checkNative === "function", "scripts/field-native-guard.mjs exports checkNative");
if (typeof guard?.checkNative === "function") {
  const rec = { builds: { "1.1.0": { nativeFingerprint: "a".repeat(40) } } };
  const app = { runtimeVersion: { policy: "appVersion" }, version: "1.1.0" };
  ok(guard.checkNative({ app, record: rec, fingerprint: "a".repeat(40) }).ok === true, "guard: same native code as the recorded build → publish");
  ok(guard.checkNative({ app, record: rec, fingerprint: "b".repeat(40) }).ok === false, "guard: native code changed, version not bumped → refuse");
  ok(guard.checkNative({ app: { ...app, version: "1.2.0" }, record: rec, fingerprint: "a".repeat(40) }).ok === false, "guard: a version with no recorded build → refuse (nothing is listening)");
  ok(guard.checkNative({ app: { ...app, runtimeVersion: "1.1.0" }, record: rec, fingerprint: "a".repeat(40) }).ok === false, "guard: a literal runtime → refuse");
  ok(guard.checkNative({ app: { ...app, runtimeVersion: { policy: "fingerprint" } }, record: rec, fingerprint: "a".repeat(40) }).ok === false, "guard: any other policy → refuse");
  ok(/runtime 1\.1\.0/.test(guard.checkNative({ app, record: rec, fingerprint: "a".repeat(40) }).message || ""), "guard: says which runtime the phones will get it on");
}

// main's update workflow runs the guard before it publishes.
const upd = read(".github/workflows/field-app-update.yml");
const guardAt = upd.indexOf("node scripts/field-native-guard.mjs");
const publishAt = upd.indexOf("npx eas-cli@23.2.0 update");
ok(guardAt > 0 && publishAt > guardAt, "main's update workflow runs the native guard before it publishes");
ok(upd.indexOf("npm ci") > 0 && upd.indexOf("npm ci") < guardAt, "…after installing, so the fingerprint is of the real tree");

// EAS (TestFlight) builds still refuse: the Tap to Pay entitlement is a
// development one until Apple grants publishing (docs/TAP_TO_PAY_REQUIREMENTS.md).
for (const wf of ["field-app-build.yml", "field-app-taptopay-build.yml"]) {
  ok(/- name: Refuse while the runtime is pinned/.test(read(`.github/workflows/${wf}`)), `${wf} still refuses a non-fingerprint tree (no cloud build of the one-app tree yet)`);
}

console.log(`test-one-app-config: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

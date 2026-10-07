#!/usr/bin/env node
// scripts/test-field-script-sandboxing.mjs
//
// `expo prebuild` writes an iOS project whose build scripts can read the
// app's own files: User Script Sandboxing is OFF on every configuration.
//
// WHY. Patrick's Release build on the Mac (2026-09-24) failed with ten
// copies of "Sandbox: find(…) deny(1) file-read-data /Users/…/Downloads/…".
// Xcode's User Script Sandboxing blocks the build's shell scripts (the
// Release-only "Bundle React Native code and images" among them) from
// reading the project folder. He switched it off by hand in Build
// Settings, but `npx expo prebuild --clean` regenerates the project, so
// every fresh download would bring the error back. The local config
// plugin pjl-field/plugins/withNoUserScriptSandboxing.js sets
// ENABLE_USER_SCRIPT_SANDBOXING = NO on every build configuration of the
// app project at prebuild time.
//
// Run: node scripts/test-field-script-sandboxing.mjs   (build:check on the Tap to Pay branch)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "pjl-field");
const require = createRequire(path.join(APP, "package.json"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const appJson = JSON.parse(fs.readFileSync(path.join(APP, "app.json"), "utf8"));
const plugins = appJson.expo.plugins || [];
ok(plugins.includes("./plugins/withNoUserScriptSandboxing"), "app.json runs ./plugins/withNoUserScriptSandboxing at prebuild");

let plugin = null;
try { plugin = require("./plugins/withNoUserScriptSandboxing"); } catch (err) { ok(false, `the plugin loads (${err.code || err.message})`); }

if (plugin) {
  ok(typeof plugin === "function", "the plugin is a config plugin (a function of the config)");
  ok(typeof plugin.disableUserScriptSandboxing === "function", "it exposes the pure edit it makes, for this test");

  // The same shape the xcode library hands a withXcodeProject mod: a
  // section of build configurations keyed by id, with *_comment entries.
  const section = {
    A1: { isa: "XCBuildConfiguration", buildSettings: { PRODUCT_NAME: "PJLField", ENABLE_USER_SCRIPT_SANDBOXING: "YES" }, name: "Debug" },
    A1_comment: "Debug",
    B2: { isa: "XCBuildConfiguration", buildSettings: { PRODUCT_NAME: "PJLField" }, name: "Release" },
    B2_comment: "Release",
    C3: { isa: "XCBuildConfiguration", buildSettings: { SDKROOT: "iphoneos" }, name: "Release" },
    C3_comment: "Release",
  };
  const project = { pbxXCBuildConfigurationSection: () => section };
  const changed = plugin.disableUserScriptSandboxing(project);
  ok(changed === 3, `every build configuration is set (${changed} of 3)`);
  for (const id of ["A1", "B2", "C3"]) {
    ok(section[id].buildSettings.ENABLE_USER_SCRIPT_SANDBOXING === "NO", `${section[id].name} (${id}) has sandboxing off`);
  }
  ok(section.A1_comment === "Debug" && section.B2.buildSettings.PRODUCT_NAME === "PJLField", "nothing else in the project is touched");
}

console.log(`field-script-sandboxing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

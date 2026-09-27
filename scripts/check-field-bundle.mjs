#!/usr/bin/env node
// scripts/check-field-bundle.mjs
//
// Bundles the REAL Field app for iOS — `expo export`, the same Metro build
// an OTA update ships — and fails if it doesn't produce one.
//
// WHY. Every other app check reads source: a parse with the app's own Babel
// (test-today-map.mjs), Metro's resolver on the import graph
// (test-field-module-resolution.mjs). None of them runs the bundler end to
// end, so a change could pass all of them and still fail the first time
// the OTA workflow builds the bundle, after it has merged to main. This
// runs that build on every PR instead.
//
// Offline (EXPO_OFFLINE=1): it contacts nothing and publishes nothing.
// Output goes to a temp directory that is removed afterwards. It also
// prints the iOS runtime fingerprint this checkout would publish to, so a
// PR that changes it (a native change: needs a new build, not an OTA
// update) is visible in the CI log before it merges.
//
// Run: node scripts/check-field-bundle.mjs   (CI: "Field app bundle")

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "pjl-field");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-field-bundle-"));
const env = { ...process.env, EXPO_OFFLINE: "1", CI: "1", EXPO_NO_TELEMETRY: "1" };
const problems = [];
try {
  const r = spawnSync("npx", ["expo", "export", "--platform", "ios", "--output-dir", OUT], { cwd: APP, env, encoding: "utf8", timeout: 10 * 60 * 1000 });
  const log = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0) problems.push(`expo export exited ${r.status}:\n${log.slice(-4000)}`);
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, "metadata.json"), "utf8")); } catch { return null; } })();
  const bundle = meta?.fileMetadata?.ios?.bundle;
  const bytes = bundle && fs.existsSync(path.join(OUT, bundle)) ? fs.statSync(path.join(OUT, bundle)).size : 0;
  if (!bundle) problems.push("no iOS bundle in metadata.json");
  // The app is ~2 MB of Hermes bytecode; a bundle a fraction of that is a
  // build that silently dropped most of the app.
  else if (bytes < 500 * 1024) problems.push(`the iOS bundle is suspiciously small (${bytes} bytes)`);
  const modules = log.match(/Bundled \d+ms \S+ \((\d+) modules\)/)?.[1];
  if (!problems.length) console.log(`field-bundle: iOS bundle OK — ${(bytes / 1048576).toFixed(2)} MB, ${modules || "?"} modules`);

  const fp = spawnSync("npx", ["expo-updates", "fingerprint:generate", "--platform", "ios"], { cwd: APP, env, encoding: "utf8", timeout: 5 * 60 * 1000 });
  let hash = null;
  try { hash = JSON.parse(fp.stdout).hash; } catch {}
  console.log(`field-bundle: iOS runtime fingerprint ${hash || "(unavailable)"}`);
  if (process.env.GITHUB_STEP_SUMMARY && hash) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Field app bundle\n\niOS bundle built (${(bytes / 1048576).toFixed(2)} MB). Runtime fingerprint \`${hash}\` — ` +
      "if this differs from the build on the phones, this change needs a new native build; an OTA update will not reach them.\n");
  }
} finally {
  fs.rmSync(OUT, { recursive: true, force: true });
}
if (problems.length) {
  for (const p of problems) console.error(`field-bundle: FAIL ${p}`);
  process.exit(1);
}

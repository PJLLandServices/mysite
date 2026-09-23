#!/usr/bin/env node
// Stamp the commit into the field app's bundle, for a build or an update.
//
//   node scripts/stamp-field-build-info.mjs build|update
//
// Run by .github/workflows/field-app-build.yml and field-app-update.yml
// before EAS bundles the JavaScript. Writes pjl-field/src/buildInfo.json
// (in git it is a placeholder of nulls), which the app shows on the Today
// tab and sends on every request (pjl-field/src/clientVersion.mjs).
//
// REFUSES without GITHUB_SHA. An unstamped bundle would read "commit
// unknown" on the phone, which is honest but useless for the one question
// this answers — so a workflow that lost its commit fails here, loudly,
// instead of shipping it. Outside Actions, pass STAMP_SHA to try it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.STAMP_OUT || path.join(ROOT, "pjl-field", "src", "buildInfo.json");

const source = process.argv[2];
if (source !== "build" && source !== "update") {
  console.error("usage: stamp-field-build-info.mjs build|update");
  process.exit(2);
}
const sha = String(process.env.GITHUB_SHA || process.env.STAMP_SHA || "").trim();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`::error::No commit to stamp (GITHUB_SHA=${JSON.stringify(sha)}). Refusing to ship a bundle that cannot say what it is.`);
  process.exit(1);
}
const info = {
  commit: sha,
  ref: String(process.env.GITHUB_REF_NAME || "").slice(0, 64) || null,
  source,
  run: String(process.env.GITHUB_RUN_NUMBER || "").slice(0, 12) || null,
  stampedAt: new Date().toISOString()
};
fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n");
console.log(`Stamped ${source}: commit ${sha.slice(0, 7)} (${info.ref || "no ref"}, run #${info.run || "?"}) → ${path.relative(ROOT, OUT)}`);
console.log(`After install, the Today tab should read "Commit ${sha.slice(0, 7)}", and the server log "[field-client] … commit=${sha}".`);

#!/usr/bin/env node
// scripts/e2e/run-all.mjs
//
// Runs every business-journey suite (scripts/e2e/journey-*.mjs), one after
// another, each on its own throwaway server (scripts/lib/field-server.mjs:
// temp data, stubbed email/SMS/Stripe, production tripwires). Exits 1 if
// any journey fails. FINDINGs — behaviour a journey found that is a
// decision for Patrick, not a failure — are collected and printed at the
// end, and into the GitHub step summary when run in Actions.
//
// Run: npm run test:e2e   (CI: "E2E business journeys")

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const journeys = fs.readdirSync(HERE).filter((f) => /^journey-\d+-.*\.mjs$/.test(f))
  .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
const results = [];
for (const file of journeys) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--no-warnings", path.join(HERE, file)], { encoding: "utf8", timeout: 10 * 60 * 1000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const findings = out.split("\n").filter((l) => /⚠ FINDING/.test(l)).map((l) => l.replace(/^\s*⚠ FINDING\s*/, ""));
  results.push({ file, ok: r.status === 0, secs: ((Date.now() - t0) / 1000).toFixed(1), out, findings });
  console.log(out.split("\n").filter((l) => !/⚠ FINDING/.test(l)).join("\n"));
}
const failed = results.filter((r) => !r.ok);
const findings = results.flatMap((r) => r.findings.map((f) => `${r.file.replace(/\.mjs$/, "")} ${f}`));
console.log(`\ne2e: ${results.length - failed.length}/${results.length} journeys passed (${results.map((r) => `${r.file.split("-")[1]}:${r.secs}s`).join(" ")})`);
if (findings.length) {
  console.log(`\n${findings.length} finding(s) for Patrick — reported, not failed:`);
  for (const f of findings) console.log(`  ⚠ ${f}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ["### E2E business journeys", "", ...results.map((r) => `- ${r.ok ? "✅" : "❌"} \`${r.file}\` (${r.secs}s)`)];
  if (findings.length) lines.push("", "**Findings for Patrick** (reported, not failed):", "", ...findings.map((f) => `- ${f}`));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
process.exit(failed.length ? 1 : 0);

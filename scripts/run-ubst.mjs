#!/usr/bin/env node
// scripts/run-ubst.mjs — run every Unified Booking Source of Truth suite
// (P-PJL-39) in sequence and print one line per suite.
//
// These suites are FAIL-FIRST: they describe the contract PJL-133 → PJL-138
// build toward and are expected to fail until each phase lands. They are
// deliberately NOT in `npm run build:check`; a suite joins the gate when the
// phase that makes it green ships. Each suite's header records how many
// assertions failed on the base it was written against.
//
//   npm run test:ubst            every suite
//   npm run test:ubst -- cancel  suites whose name contains "cancel"
//
// Exit code is 1 when any suite fails, so the same runner can join the gate
// later without changes.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const suites = fs.readdirSync(path.join(ROOT, "scripts"))
  .filter((f) => /^test-ubst-.*\.mjs$/.test(f))
  .filter((f) => !filter.length || filter.some((x) => f.includes(x)))
  .sort();

let anyFailed = false;
const rows = [];
for (const f of suites) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", f)], { encoding: "utf8", timeout: 15 * 60 * 1000 });
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  const m = out.match(/^(test-ubst-[\w-]+): (\d+) passed, (\d+) failed/m);
  const passed = m ? Number(m[2]) : null;
  const failed = m ? Number(m[3]) : null;
  const crashed = !m;
  if (crashed || failed > 0 || run.status !== 0) anyFailed = true;
  rows.push({ suite: f.replace(/^test-ubst-|\.mjs$/g, ""), passed, failed, crashed, seconds: Math.round((Date.now() - started) / 1000) });
  if (crashed) console.log(`\n--- ${f} did not report a result ---\n${out.slice(-1500)}`);
}

console.log("\nUnified Booking Source of Truth — fail-first suites (expected to fail until their phase lands)\n");
const w = Math.max(...rows.map((r) => r.suite.length));
for (const r of rows) {
  console.log(`  ${r.suite.padEnd(w)}  ${r.crashed ? "CRASHED" : `${String(r.passed).padStart(3)} passed  ${String(r.failed).padStart(3)} failed`}  (${r.seconds}s)`);
}
const totals = rows.reduce((t, r) => ({ passed: t.passed + (r.passed || 0), failed: t.failed + (r.failed || 0) }), { passed: 0, failed: 0 });
console.log(`\n  total: ${totals.passed} passed, ${totals.failed} failed across ${rows.length} suites`);
process.exit(anyFailed ? 1 : 0);

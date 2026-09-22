#!/usr/bin/env node
// scripts/capture-system-design-golden.mjs
//
// Records the golden master: what the System Builder's calculation engine
// answers TODAY, for every fixture, before anything is moved.
//
//   npm run capture:system-design-golden
//
// Writes scripts/fixtures/system-design-golden.json. That file is the
// contract the extracted engine has to meet, so re-recording it is not a
// way to make a failing test pass — it is how you deliberately accept a
// changed answer, and it belongs in its own commit with a reason.
//
// The guard below is there to make that hard to do by accident.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures } from "./fixtures/system-design-fixtures.mjs";
import { captureFromPage } from "./lib/system-design-capture.mjs";
import { normalizeSnapshot, stableStringify, diffSnapshots } from "./lib/system-design-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "scripts", "fixtures", "system-design-golden.json");

const snapshot = normalizeSnapshot(await captureFromPage(fixtures));

if (fs.existsSync(GOLDEN) && !process.argv.includes("--accept-changes")) {
  const prev = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const diffs = diffSnapshots(stripMeta(prev), stripMeta(snapshot));
  if (diffs.length) {
    console.error(`\nThe engine's answers have MOVED — ${diffs.length} field(s) differ from the recorded golden master.\n`);
    for (const d of diffs.slice(0, 40)) {
      console.error(`  ${d.path}\n    golden: ${JSON.stringify(d.expected)}\n    now:    ${JSON.stringify(d.actual)}`);
    }
    if (diffs.length > 40) console.error(`  … and ${diffs.length - 40} more`);
    console.error(
      "\nNothing was written. If this change is intended, re-run with --accept-changes\n" +
      "and say in the commit message which number changed and why.\n"
    );
    process.exit(1);
  }
  console.log("Golden master unchanged — nothing to write.");
  process.exit(0);
}

fs.writeFileSync(GOLDEN, stableStringify(snapshot) + "\n");
console.log(`Wrote ${path.relative(ROOT, GOLDEN)} — ${snapshot.fixtures.length} fixtures.`);
for (const f of snapshot.fixtures) {
  console.log(
    `  ${f.id.padEnd(36)} ${String(f.totals.valveCount).padStart(3)} valves · ` +
    `${String(f.totals.stationCount).padStart(3)} stations · ` +
    `${String(f.totals.headCount).padStart(4)} heads · ` +
    `${String(f.bom.lines.length).padStart(3)} BOM lines · ` +
    `$${(f.bom.subtotalCents / 100).toFixed(2)}`
  );
}

/** Timestamps are not part of the contract. */
function stripMeta(snap) {
  const { capturedAt, engine, ...rest } = snap;
  return rest;
}

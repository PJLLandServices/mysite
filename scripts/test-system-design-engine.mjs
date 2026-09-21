#!/usr/bin/env node
// scripts/test-system-design-engine.mjs
//
// The extracted calculation engine must answer EXACTLY what the old
// in-page engine answered.
//
//   npm run test:system-design-engine
//
// The golden master (scripts/fixtures/system-design-golden.json) was
// recorded from the engine as it lived inside sitebuilder.html, in
// Chromium, BEFORE any of it moved. Everything here is measured against
// that recording.
//
//   A. THE EXTRACTED ENGINE, in the same browser the golden master was
//      recorded in. Must match bit for bit, with no allowance whatsoever.
//      This is the claim "the extraction changed nothing", tested with the
//      runtime held constant so there is only one variable.
//
//   B. THE SYSTEM BUILDER PAGE, driven through the names it declares.
//      Must also match bit for bit. A could pass while the page quietly
//      kept a stale private copy of the code; B is what rules that out.
//
//   C. THE ENGINE UNDER NODE, with no browser at all — the point of
//      pulling it out. Exact on every count, quantity and cent; Math.sin
//      and Math.cos differ by an ulp between V8 builds, so sub-ulp drift
//      in non-integer geometry is reported by path rather than failed on.
//      See classifyDiffs() for how narrowly that is drawn.
//
//   D. NET INTEGRITY. Deliberately break the engine twelve different ways
//      and require every one to be caught. A safety net nobody has thrown
//      anything at is a guess.
//
//      Twelve is every deliberate rule in the engine that a fixture can
//      reach. A thirteenth was tried during development and is NOT here:
//      plan()'s own `|| 18` drip row-spacing fallback is unreachable,
//      because familyDefaults() has always set that field by the time
//      plan() reads it. It is listed as UNREACHABLE at the bottom of this
//      file's run so the count stays honest rather than quietly rounded.
//
// A and B need Chromium. With --no-browser they are skipped and the run
// is reported as incomplete, because C alone does not prove the page still
// works.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fixtures } from "./fixtures/system-design-fixtures.mjs";
import { normalizeSnapshot, diffSnapshots, classifyDiffs, moneyFields } from "./lib/system-design-snapshot.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "scripts", "fixtures", "system-design-golden.json");
const PARTS = path.join(ROOT, "scripts", "fixtures", "system-design-parts.json");
const ENGINE = path.join(ROOT, "server", "sitebuilder-engine.js");

const parts = JSON.parse(fs.readFileSync(PARTS, "utf8")).parts;
const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
const wantBrowser = !process.argv.includes("--no-browser");

let ok = true;
const summary = [];

/** Drive an engine module through every fixture, in Node.
 *  Mirrors the browser runners step for step — same calls, same order,
 *  same recorded fields — or the captures would not be comparable. */
function runAllInNode(E) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    fixtures: fixtures.map((fx) => {
      const areas = clone(fx.areas);
      const routing = clone(fx.routing || {});
      const valveGroupModes = clone(fx.valveGroupModes || {});
      const { ceiling, spacingFactor } = fx.inputs;

      const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
      const zones = E.computeZonePlan({ plans, areas, routing, valveGroupModes, ceiling });
      const bom = E.buildBOM({ plans, zones, parts, spacingFactor });

      const areaOut = areas.map((a, i) => ({
        aid: a.aid,
        name: a.name,
        resolvedFamily: a.family,
        materialCents: E.areaMaterialCents(a, plans[i].plan, { parts, spacingFactor }),
        plan: plans[i].plan
      }));

      return {
        id: fx.id,
        why: fx.why,
        inputs: fx.inputs,
        areas: areaOut,
        zones,
        stations: { count: E.stationCount(zones), zones: E.stationZones(zones), peakGPM: E.peakStationGPM(zones) },
        bom,
        totals: {
          areaCount: areas.length,
          valveCount: zones.length,
          stationCount: E.stationCount(zones),
          headCount: plans.reduce((t, x) => t + ((x.plan.heads && x.plan.heads.length) || 0), 0),
          totalGPM: plans.reduce((t, x) => t + (x.plan.totalGPM || 0), 0),
          bomSubtotalCents: bom.subtotalCents,
          areaMaterialCentsTotal: areaOut.reduce((t, a) => t + a.materialCents, 0)
        }
      };
    })
  };
}

const stripMeta = ({ capturedAt, engine, ...rest }) => rest;
const against = (snap) => diffSnapshots(stripMeta(golden), stripMeta(normalizeSnapshot(snap)));

function report(diffs, limit = 25) {
  for (const d of diffs.slice(0, limit)) {
    console.error(`         ${d.path}\n           golden: ${JSON.stringify(d.expected)}\n           now:    ${JSON.stringify(d.actual)}`);
  }
  if (diffs.length > limit) console.error(`         … and ${diffs.length - limit} more`);
}

/** Exact: no allowance at all. Used where the runtime is held constant. */
function expectExact(label, snapshot) {
  const diffs = against(snapshot);
  if (!diffs.length) {
    console.log(`  ok   ${label} — identical to the golden master, field for field`);
    summary.push([label, "identical"]);
    return true;
  }
  console.error(`  FAIL ${label} — ${diffs.length} field(s) differ (${moneyFields(diffs).length} of them money)`);
  report(diffs);
  summary.push([label, `${diffs.length} DIFFERENT`]);
  ok = false;
  return false;
}

let browserAvailable = false;
let captureFromPage = null, captureFromModule = null;
if (wantBrowser) {
  try {
    ({ captureFromPage, captureFromModule } = await import("./lib/system-design-capture.mjs"));
    browserAvailable = true;
  } catch (err) {
    console.error(`\n  Chromium/Playwright unavailable: ${err.message.split("\n")[0]}`);
  }
}

// ── A. The extracted engine, in the golden master's own runtime ──────
console.log("\nA. Extracted engine (server/sitebuilder-engine.js) in Chromium");
if (browserAvailable) {
  expectExact("extracted engine vs golden master", await captureFromModule(fixtures));
} else {
  console.log("  SKIP no browser — the extraction is NOT verified by this run");
  summary.push(["extracted engine vs golden master", "SKIPPED"]);
  ok = false;
}

// ── B. The page, still producing what it always did ──────────────────
console.log("\nB. The System Builder page itself (server/sitebuilder.html) in Chromium");
if (browserAvailable) {
  expectExact("page vs golden master", await captureFromPage(fixtures));
} else {
  console.log("  SKIP no browser — the page is NOT verified by this run");
  summary.push(["page vs golden master", "SKIPPED"]);
  ok = false;
}

// ── C. The engine with no browser at all ─────────────────────────────
console.log("\nC. Extracted engine under Node (no browser, no DOM)");
{
  const diffs = against(runAllInNode(require(ENGINE)));
  const { real, runtimeFloat } = classifyDiffs(diffs);
  if (real.length) {
    console.error(`  FAIL ${real.length} real difference(s) (${moneyFields(real).length} of them money)`);
    report(real);
    summary.push(["engine under Node vs golden master", `${real.length} DIFFERENT`]);
    ok = false;
  } else if (runtimeFloat.length) {
    console.log(`  ok   every count, quantity and cent matches exactly`);
    console.log(`       ${runtimeFloat.length} sub-ulp geometry value(s) differ — V8's Math.sin/cos, not the code:`);
    for (const d of runtimeFloat) {
      console.log(`         ${d.path}  ${d.expected} vs ${d.actual}  (${Math.abs(d.expected - d.actual).toExponential(1)})`);
    }
    summary.push(["engine under Node vs golden master", `exact, ${runtimeFloat.length} sub-ulp geometry`]);
  } else {
    console.log("  ok   identical to the golden master, field for field");
    summary.push(["engine under Node vs golden master", "identical"]);
  }
}

// ── D. Does the comparison actually catch a broken engine? ───────────
console.log("\nD. Net integrity — deliberately broken engines that MUST be caught");

// Every deliberate rule in the engine that a fixture can reach. Each entry
// is a one-line change to a real formula, constant or SKU. A mutation that
// slips through is a hole in the net, and the whole point of the net is
// that it has none.
//
// These are the SAME mutations that were run by hand against the old
// in-page engine while the fixtures were being built — kept here so they
// run on every future change rather than once, by me, on a Sunday.
const MUTATIONS = [
  ["zone packer epsilon removed", "sum <= cap + 0.001", "sum <= cap"],
  ["fill's own ceiling test loses its epsilon", "acc + g > cap + 0.001", "acc + g > cap"],
  ["balancing pass disabled", "if(k > 1 && k * n * n <= PZ_BALANCE_BUDGET)", "if(false && k * n * n <= PZ_BALANCE_BUDGET)"],
  ["drip 500 ft roll threshold 200 -> 250", "const DRIP_ROLL500_MIN = 200;", "const DRIP_ROLL500_MIN = 250;"],
  ["RWS bubbler flow 0.5 -> 0.55", "const TREE_RWS_GPM_PER_UNIT = 0.5;", "const TREE_RWS_GPM_PER_UNIT = 0.55;"],
  ["lateral estimate 0.6 -> 0.65", "* 0.6;  // rough trunk+branch", "* 0.65;  // rough trunk+branch"],
  ["manifold box grouping 4 -> 3 valves", "const MANIFOLD_PER_BOX = 4;", "const MANIFOLD_PER_BOX = 3;"],
  ["swing arm SKU changed", "swingArm:'SJ506',", "swingArm:'SJ507',"],
  ["drip row-spacing default 18 -> 16", "if(a.dripRowIn==null) a.dripRowIn=18;", "if(a.dripRowIn==null) a.dripRowIn=16;"],
  // The greedy fill is the fallback the packer uses when the balancing
  // pass cannot split a run exactly k ways. It has its OWN copy of the
  // epsilon, and it needs one.
  ["greedy fill loses its epsilon", "acc + hd.gpm > cap + 0.001", "acc + hd.gpm > cap"],
  // A hand-picked valve is reported as over the ceiling, never re-split.
  // Without the epsilon a valve sitting exactly at its limit gets flagged
  // as overloaded.
  ["hand-zoned over-ceiling report loses its epsilon", "g > cap + 0.001 ? i : -1", "g > cap ? i : -1"],
  // The default 10% drip overage, applied when a bed does not name one.
  ["drip overage default 10% -> 12%", "if(a.overagePct==null) a.overagePct=10; if(a.dripRowIn==null)", "if(a.overagePct==null) a.overagePct=12; if(a.dripRowIn==null)"]
];

// Tried during development and deliberately NOT in the list above: this
// one cannot be caught by any fixture because no saved design can reach
// the code. Asserted, not assumed — if it ever becomes reachable, the
// assertion below fails and it should join MUTATIONS.
const UNREACHABLE = [
  ["plan()'s own drip row-spacing fallback", "parseFloat(a.dripRowIn)||18", "parseFloat(a.dripRowIn)||16",
   "familyDefaults() always sets a.dripRowIn before computePlan() reads it"]
];

const source = fs.readFileSync(ENGINE, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-engine-"));
let caught = 0;
for (const [i, [label, from, to]] of MUTATIONS.entries()) {
  if (!source.includes(from)) {
    console.error(`  FAIL ${label} — the code this mutation edits is not in the engine any more`);
    ok = false;
    continue;
  }
  const file = path.join(tmp, `m${i}.cjs`);
  fs.writeFileSync(file, source.replace(from, to));
  let diffs;
  try {
    diffs = classifyDiffs(against(runAllInNode(require(file)))).real;
  } catch (err) {
    diffs = [{ path: "(threw)", expected: "a result", actual: err.message }];
  }
  if (diffs.length) {
    caught += 1;
    console.log(`  ok   caught: ${label} (${diffs.length} field(s), first: ${diffs[0].path})`);
  } else {
    console.error(`  FAIL NOT CAUGHT: ${label} — the fixtures never reach this code`);
    ok = false;
  }
}

// The unreachable one, checked rather than taken on trust.
for (const [label, from, to, why] of UNREACHABLE) {
  if (!source.includes(from)) {
    console.error(`  FAIL ${label} — the code this mutation edits is not in the engine any more`);
    ok = false;
    continue;
  }
  const file = path.join(tmp, `u-${label.replace(/\W+/g, "-")}.cjs`);
  fs.writeFileSync(file, source.replace(from, to));
  const diffs = classifyDiffs(against(runAllInNode(require(file)))).real;
  if (diffs.length) {
    console.error(`  FAIL ${label} is REACHABLE after all (${diffs.length} field(s) moved) — it belongs in MUTATIONS`);
    ok = false;
  } else {
    console.log(`  ok   unreachable, as documented: ${label}`);
    console.log(`       ${why}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
summary.push(["broken engines caught", `${caught} of ${MUTATIONS.length}`]);
summary.push(["unreachable rules, confirmed unreachable", `${UNREACHABLE.length} of ${UNREACHABLE.length}`]);

// ── Summary ──────────────────────────────────────────────────────────
const f = runAllInNode(require(ENGINE)).fixtures;
console.log("\n─────────────────────────────────────────────────────────────");
console.log(`Fixtures: ${fixtures.length}   Golden master: ${path.relative(ROOT, GOLDEN)}`);
for (const [k, v] of summary) console.log(`  ${k.padEnd(38)} ${v}`);
console.log(
  `  ${"covered by the fixtures".padEnd(38)} ` +
  `${f.reduce((t, x) => t + x.totals.valveCount, 0)} valves · ` +
  `${f.reduce((t, x) => t + x.totals.headCount, 0)} heads · ` +
  `${f.reduce((t, x) => t + x.bom.lines.length, 0)} BOM lines · ` +
  `$${(f.reduce((t, x) => t + x.bom.subtotalCents, 0) / 100).toFixed(2)} of materials`
);
console.log(ok ? "\nPASS — the extracted engine is indistinguishable from the old one.\n"
               : "\nFAIL — see above.\n");
process.exit(ok ? 0 : 1);

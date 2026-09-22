#!/usr/bin/env node
// scripts/enumerate-stations.mjs
//
// Enumerate a saved design, rather than deducing anything about it.
//
//   node scripts/enumerate-stations.mjs <design.json>
//
// WHY THIS EXISTS
//
// The number of lines on a proposal is not the number of outputs on a
// controller. A proposal can combine work for presentation; the controller
// still has however many terminals it has. Reading one off the other is a
// guess dressed up as a fact, and it is the mistake this file exists to
// stop being made again.
//
// So this prints the three lists separately, from the saved design, and
// then the mapping between them:
//
//   1. CONTROLLER STATIONS — numbered from 1, with the areas each feeds
//   2. PHYSICAL VALVES — every one, including both halves of every split
//   3. PROPOSAL LINES — exactly what quoteSections() would emit
//
//   area -> hydraulic section -> physical valve -> station -> proposal line
//
// and then says plainly where the counts differ and why, so a station that
// is combined inside a proposal line is named rather than lost.
//
// Reads a design file. No server, no project, no writes, no design change.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E = require(path.join(ROOT, "server", "sitebuilder-engine.js"));

const file = process.argv[2];
if (!file) { console.error("\nUsage: node scripts/enumerate-stations.mjs <design.json>\n"); process.exit(2); }
const rawFile = JSON.parse(fs.readFileSync(file, "utf8"));
const design = rawFile.systemDesign || (rawFile.project && rawFile.project.systemDesign) || rawFile;
if (!design || !Array.isArray(design.areas)) { console.error("No design with an `areas` array in that file."); process.exit(2); }

const clone = (v) => JSON.parse(JSON.stringify(v));
const ceiling = parseFloat((design.inputs || {}).ceiling) || 0;
const spacingFactor = (design.inputs || {}).spacingFactor;

const areas = clone(design.areas);
const routing = clone(design.routing || {});
const valveGroupModes = clone(design.valveGroupModes || {});
const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
const valves = E.computeZonePlan({ plans, areas, routing, valveGroupModes, ceiling });
const stations = E.stationZones(valves);

const f1 = (n) => Number(n || 0).toFixed(1);
const bar = (c = "─") => c.repeat(94);
const cell = (s, w) => String(s == null ? "" : s).slice(0, w).padEnd(w);

console.log(`\n${bar("═")}`);
console.log("ENUMERATED FROM THE SAVED DESIGN — nothing here is inferred from the proposal");
console.log(bar("═"));
console.log(`  GPM ceiling ${ceiling} · spacing factor ${spacingFactor} · ${areas.length} areas`);
console.log(`  ${stations.length} controller stations · ${valves.length} physical valves · ` +
            `${valves.length - stations.length} extra valve(s) sharing a station`);

// ── 1. Controller stations ───────────────────────────────────────────
console.log(`\n${bar()}`);
console.log("1. CONTROLLER STATIONS — one programmed output each");
console.log(bar());
console.log(`  ${cell("#", 4)}${cell("name", 40)}${cell("GPM", 8)}${cell("valves", 7)}areas fed`);
stations.forEach((s) => {
  console.log(`  ${cell(s.station + 1, 4)}${cell(s.name, 40)}${cell(f1(s.gpm), 8)}${cell(s.valves, 7)}${(s.members || []).join(", ")}`);
});

// ── 2. Physical valves ───────────────────────────────────────────────
console.log(`\n${bar()}`);
console.log("2. PHYSICAL VALVES — what goes in the ground, both halves of every split");
console.log(bar());
console.log(`  ${cell("#", 4)}${cell("valve", 44)}${cell("GPM", 8)}${cell("station", 8)}${cell("half", 6)}box`);
valves.forEach((z, i) => {
  console.log(`  ${cell(i + 1, 4)}${cell(z.name, 44)}${cell(f1(z.gpm), 8)}${cell((z.station || 0) + 1, 8)}` +
              `${cell(z.half || "—", 6)}${z.boxId || (z.stationGroup ? "(group " + z.stationGroup + ")" : "—")}`);
});

// ── 3. Proposal lines ────────────────────────────────────────────────
//
// quoteSections() builds one line per STATION, from stationZones(). That
// is the thing to check rather than assume, so it is derived here the same
// way and counted separately.
console.log(`\n${bar()}`);
console.log("3. PROPOSAL / SPEC LINES — one per station, as the quote generator emits them");
console.log(bar());
stations.forEach((s, i) => {
  const grouped = valves.filter((z) => (z.station || 0) === s.station);
  const detail = s.grouped
    ? `${s.members.length} bed${s.members.length === 1 ? "" : "s"} on ${grouped.length > 1 ? grouped.length + " valves wired as one zone" : "one valve"}`
    : `${s.headCount} head${s.headCount === 1 ? "" : "s"}${grouped.length > 1 ? ` on ${grouped.length} valves wired as one zone` : ""}`;
  console.log(`  ${cell(i + 1, 4)}${cell(s.name, 44)}${cell(f1(s.gpm) + " GPM", 12)}${detail}`);
});

// ── The mapping ──────────────────────────────────────────────────────
console.log(`\n${bar()}`);
console.log("AREA → HYDRAULIC SECTION → PHYSICAL VALVE → STATION → PROPOSAL LINE");
console.log(bar());
console.log(`  ${cell("area", 26)}${cell("section", 9)}${cell("valve", 30)}${cell("station", 9)}prop. line`);
let unmapped = 0;
plans.forEach(({ area, plan }, ai) => {
  if (plan.noShape) { console.log(`  ${cell(area.name, 26)}${cell("—", 9)}${cell("(nothing drawn)", 30)}${cell("—", 9)}—`); return; }
  for (let lz = 0; lz < plan.zones; lz++) {
    const feeding = valves
      .map((z, vi) => ({ z, vi }))
      .filter(({ z }) => (z.parts || []).some((pt) => pt.areaIdx === ai && pt.localZone === lz));
    if (!feeding.length) { unmapped++; console.log(`  ${cell(area.name, 26)}${cell(lz + 1 + "/" + plan.zones, 9)}${cell("*** NO VALVE ***", 30)}${cell("—", 9)}—`); continue; }
    feeding.forEach(({ z, vi }, k) => {
      const st = (z.station || 0) + 1;
      const line = stations.findIndex((s) => s.station === (z.station || 0)) + 1;
      console.log(`  ${cell(k === 0 ? area.name : "", 26)}${cell(k === 0 ? lz + 1 + "/" + plan.zones : "", 9)}` +
                  `${cell("#" + (vi + 1) + " " + z.name, 30)}${cell(st, 9)}${line}`);
    });
  }
});

// ── Where the counts differ, named ───────────────────────────────────
console.log(`\n${bar()}`);
console.log("WHERE THE THREE COUNTS DIFFER");
console.log(bar());
const areaZones = plans.reduce((t, x) => t + (x.plan.noShape ? 0 : x.plan.zones), 0);
console.log(`  ${cell("hydraulic sections (area zones)", 40)}${areaZones}`);
console.log(`  ${cell("physical valves", 40)}${valves.length}`);
console.log(`  ${cell("controller stations", 40)}${stations.length}`);
console.log(`  ${cell("proposal / spec lines", 40)}${stations.length}`);
if (unmapped) console.log(`  ${cell("*** sections with no valve at all", 40)}${unmapped}`);

const multi = stations.filter((s) => s.valves > 1);
if (multi.length) {
  console.log(`\n  Stations carrying more than one valve — these are the places a valve count`);
  console.log(`  and a station count legitimately disagree. Each is ONE controller output:`);
  multi.forEach((s) => {
    const vs = valves.filter((z) => (z.station || 0) === s.station);
    const why = vs[0].stationGroup ? "shared drip group, one valve per box" : "split across a line drawn on the sheet";
    console.log(`\n    Station ${s.station + 1}: ${s.name}`);
    console.log(`      ${vs.length} valves, ${why}`);
    vs.forEach((z) => console.log(`        · ${z.name}  ${f1(z.gpm)} GPM${z.boxId ? "  box " + z.boxId : ""}`));
    console.log(`      they open together, so the station draws ${f1(s.gpm)} GPM`);
    console.log(`      ONE proposal line, ONE controller terminal, ${vs.length} valves in the ground`);
  });
  console.log(`\n  If any of these is wired as SEPARATE controller outputs on site, then the`);
  console.log(`  design does not describe what was built, and the station count is short by`);
  console.log(`  one for each one that was separated.`);
}
console.log("");

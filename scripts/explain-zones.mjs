#!/usr/bin/env node
// scripts/explain-zones.mjs
//
// "Why does this design say N zones?" — the whole derivation, shown.
//
//   node scripts/explain-zones.mjs <design.json>
//
// A zone count is three numbers that people say interchangeably and that
// are not the same:
//
//   AREA ZONES  what each area needs on its own, from its flow and the
//               GPM ceiling. An area over the ceiling needs more than one.
//   VALVES      what goes in the ground. Drip beds sharing a valve group
//               collapse several area zones onto fewer valves; a zone
//               split across a driveway is ONE zone on TWO valves.
//   STATIONS    what the controller drives, and what the summary calls
//               "total zones". Split halves are one station. A boxed drip
//               group is one station however many valves it has.
//
// This prints all three, names every place one collapses into the next,
// and then sweeps the GPM ceiling to show which ceiling values change the
// answer and WHICH AREA flips at each one — so "it used to be 12" has a
// specific area attached to it rather than a shrug.
//
// Reads a design file and nothing else. No server, no project, no writes.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E = require(path.join(ROOT, "server", "sitebuilder-engine.js"));

const file = process.argv[2];
if (!file) {
  console.error("\nUsage: node scripts/explain-zones.mjs <design.json>\n");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const design = raw.systemDesign || (raw.project && raw.project.systemDesign) || raw;
if (!design || !Array.isArray(design.areas)) {
  console.error("That file has no design with an `areas` array in it.");
  process.exit(2);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const ceiling0 = parseFloat((design.inputs || {}).ceiling) || 0;
const spacingFactor = (design.inputs || {}).spacingFactor;

/** Run the engine at a given ceiling and return the shape of the answer. */
function at(ceiling) {
  const areas = clone(design.areas);
  const routing = clone(design.routing || {});
  const valveGroupModes = clone(design.valveGroupModes || {});
  const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
  const zones = E.computeZonePlan({ plans, areas, routing, valveGroupModes, ceiling });
  return {
    areas, plans, zones,
    areaZones: plans.reduce((t, x) => t + (x.plan.noShape ? 0 : x.plan.zones), 0),
    valves: zones.length,
    stations: E.stationCount(zones),
    perArea: plans.map((x) => (x.plan.noShape ? 0 : x.plan.zones))
  };
}

const now = at(ceiling0);
const fmt = (n, d = 1) => Number(n).toFixed(d);
const bar = (c = "─") => c.repeat(74);

console.log(`\n${bar("═")}`);
console.log(`WHY THIS DESIGN SAYS ${now.stations} ZONES`);
console.log(bar("═"));
console.log(`  ${design.areas.length} areas · GPM ceiling ${ceiling0} · spacing factor ${spacingFactor}`);
console.log(`\n  ${String(now.areaZones).padStart(3)}  area zones   what each area needs on its own`);
console.log(`  ${String(now.valves).padStart(3)}  valves       what goes in the ground`);
console.log(`  ${String(now.stations).padStart(3)}  stations     what the controller drives — the "total zones" figure`);

// ── Area by area ─────────────────────────────────────────────────────
console.log(`\n${bar()}`);
console.log("EVERY AREA, AND THE ZONES IT ASKS FOR");
console.log(bar());
console.log(`  ${"area".padEnd(30)} ${"family".padEnd(7)} ${"GPM".padStart(6)} ${"zones".padStart(5)}  why`);
now.plans.forEach(({ area, plan }) => {
  if (plan.noShape) {
    console.log(`  ${String(area.name || "?").slice(0, 30).padEnd(30)} ${"—".padEnd(7)} ${"—".padStart(6)} ${"0".padStart(5)}  nothing drawn yet`);
    return;
  }
  const gpm = plan.totalGPM || 0;
  let why;
  if (plan.family === "drip" || plan.family === "trees") {
    why = `${fmt(gpm)} GPM / ${ceiling0} ceiling, rounded up`;
  } else {
    const perZone = (plan.zoneGPM || []).map((g) => fmt(g)).join(" + ");
    why = plan.handZoned ? `valves assigned by hand (${perZone})`
        : plan.zones > 1 ? `${perZone} — split to stay under ${ceiling0}`
        : `${perZone}, under the ${ceiling0} ceiling`;
  }
  if (area.valveGroup) why += `  ·  shares valve group "${area.valveGroup}"`;
  if ((plan.overZones || []).length) why += `  ·  valve ${plan.overZones.map((z) => z + 1).join(", ")} OVER the ceiling (set by hand)`;
  console.log(`  ${String(area.name || "?").slice(0, 30).padEnd(30)} ${String(plan.family).padEnd(7)} ${fmt(gpm).padStart(6)} ${String(plan.zones).padStart(5)}  ${why}`);
});

// ── Where the count collapses ────────────────────────────────────────
console.log(`\n${bar()}`);
console.log("WHERE THE COUNT COLLAPSES");
console.log(bar());
const collapses = [];
const byStation = new Map();
now.zones.forEach((z) => {
  const s = z.station || 0;
  if (!byStation.has(s)) byStation.set(s, []);
  byStation.get(s).push(z);
});
const grouped = now.zones.filter((z) => z.grouped);
if (grouped.length) {
  const groups = new Map();
  now.areas.forEach((a) => { if (a.valveGroup) groups.set(a.valveGroup, (groups.get(a.valveGroup) || 0) + 1); });
  for (const [g, beds] of groups) {
    const valves = now.zones.filter((z) => z.grouped && String(z.name).startsWith(g)).length;
    const stations = new Set(now.zones.filter((z) => z.grouped && String(z.name).startsWith(g)).map((z) => z.station)).size;
    const mode = (design.valveGroupModes || {})[g] === "station" ? "one valve per box, all on one station" : "one shared valve";
    collapses.push(`${beds} drip beds -> ${valves} valve${valves === 1 ? "" : "s"} -> ${stations} station${stations === 1 ? "" : "s"}`);
    console.log(`  valve group "${g}"  ·  ${mode}`);
    console.log(`      ${beds} beds  ->  ${valves} valve${valves === 1 ? "" : "s"}  ->  ${stations} station${stations === 1 ? "" : "s"}   (saves ${beds - stations} station${beds - stations === 1 ? "" : "s"})`);
  }
}
for (const [s, zs] of [...byStation].sort((a, b) => a[0] - b[0])) {
  if (zs.length > 1 && !zs[0].grouped) {
    console.log(`  split zone   "${zs[0].name.replace(/ · [AB]$/, "")}"`);
    console.log(`      ${zs.length} valves on station ${s + 1}: ${zs.map((z) => `${z.half || "?"} ${fmt(z.gpm)} GPM`).join(" + ")}  =  ${fmt(zs.reduce((t, z) => t + z.gpm, 0))} GPM together`);
  }
}
if (!grouped.length && [...byStation.values()].every((v) => v.length === 1)) {
  console.log("  Nothing collapses — every area zone is its own valve and its own station.");
}

// ── What would change the answer ─────────────────────────────────────
console.log(`\n${bar()}`);
console.log("WHAT WOULD CHANGE THE ANSWER — sweeping the GPM ceiling");
console.log(bar());
const steps = [];
for (let c = 1; c <= Math.max(40, ceiling0 * 2); c = Math.round((c + 0.1) * 10) / 10) steps.push(c);
let prev = null;
const breaks = [];
for (const c of steps) {
  const r = at(c);
  if (prev && r.stations !== prev.r.stations) {
    const changed = r.perArea
      .map((n, i) => ({ i, from: prev.r.perArea[i], to: n }))
      .filter((x) => x.from !== x.to);
    breaks.push({ from: prev.c, to: c, was: prev.r.stations, now: r.stations, changed, areas: r.areas });
  }
  prev = { c, r };
}
if (!breaks.length) {
  console.log(`  The ceiling makes no difference to the station count anywhere from 1 to ${steps[steps.length - 1]} GPM.`);
} else {
  console.log(`  ceiling        stations   what changed`);
  for (const b of breaks) {
    const who = b.changed.length
      ? b.changed.map((x) => `${b.areas[x.i].name || "area " + (x.i + 1)}: ${x.from} -> ${x.to} zone${x.to === 1 ? "" : "s"}`).join("; ")
      : "valve grouping repacked";
    const dir = b.now > b.was ? "" : "";
    console.log(`  ${String(b.from).padStart(5)} -> ${String(b.to).padEnd(5)}  ${String(b.was).padStart(3)} -> ${String(b.now).padEnd(3)}   ${who}${dir}`);
  }
}

// ── The question people actually ask: it used to be a different number ──
console.log(`\n${bar()}`);
console.log(`IT USED TO BE A DIFFERENT NUMBER — where would each one come from?`);
console.log(bar());
{
  // For every station count reachable by moving the ceiling alone, report
  // the highest ceiling that produces it and exactly which areas differ
  // from the design as it stands. Compared against TODAY, not against the
  // neighbouring sweep step, so the answer reads as "what is different".
  const byCount = new Map();
  for (const c of steps) {
    const r = at(c);
    if (!byCount.has(r.stations) || c > byCount.get(r.stations).c) byCount.set(r.stations, { c, r });
  }
  const near = [...byCount.keys()]
    .filter((n) => n !== now.stations)
    .sort((a, b) => Math.abs(a - now.stations) - Math.abs(b - now.stations))
    .slice(0, 4)
    .sort((a, b) => a - b);
  if (!near.length) {
    console.log("  The ceiling alone cannot produce any other station count.");
  } else {
    for (const n of near) {
      const { c, r } = byCount.get(n);
      const diff = r.perArea.map((v, i) => ({ i, was: now.perArea[i], now: v })).filter((x) => x.was !== x.now);
      console.log(`\n  ${String(n).padStart(3)} stations  ·  at a GPM ceiling of ${c} or ${c > ceiling0 ? "higher" : "lower"} (it is ${ceiling0} now)`);
      if (!diff.length) {
        console.log(`        no area changes its own zone count — the valve grouping repacks instead`);
      } else {
        for (const x of diff) {
          const a = now.areas[x.i];
          console.log(`        ${String(a.name || "area " + (x.i + 1)).padEnd(30)} ${x.was} -> ${x.now} zone${x.now === 1 ? "" : "s"}`);
        }
      }
    }
  }
}
console.log("");

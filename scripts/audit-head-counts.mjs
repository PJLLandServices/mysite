#!/usr/bin/env node
// scripts/audit-head-counts.mjs
//
// WHERE DID THE HEADS GO?
//
// Patrick, on Dundalk: "in the front rotors a zone that says it's got 6
// heads but it's printed on the sheet 8 heads... they are hand placed."
//
// Counting head dots off a screenshot is not an answer — they sit under
// overlapping spray circles at 45% zoom, and a guessed number is worse
// than none. This reads the saved design instead and prints, per area:
//
//   placed    heads HAND-PLACED in the layout editor (area.manualHeads)
//   planned   heads the engine produced for that area (plan.heads)
//   assigned  heads the VALVES actually account for, summed
//
// On a healthy area all three match. They can part company in two ways,
// and the difference says which:
//
//   placed > planned    the engine dropped hand-placed heads while
//                       building the plan
//   planned > assigned  the plan made heads that no valve claims — the
//                       sheet would draw them, the zone would not count
//                       them, and that is the 6-versus-8 shape exactly
//
// READ-ONLY. It opens two files and prints. It writes nothing, sends
// nothing, and takes no customer detail: project id, project name, area
// name, family and counts. Nothing else is read.
//
//   npm run audit:head-counts                      every project
//   npm run audit:head-counts -- --project PROJ-2026-0008
//   npm run audit:head-counts -- --json
//   npm run audit:head-counts -- --mismatches      only areas that disagree

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E = require(path.join(ROOT, "server", "sitebuilder-engine.js"));

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const dataDir = arg("--data") || path.join(ROOT, "server", "data");
const only = arg("--project");
const asJson = argv.includes("--json");
const mismatchesOnly = argv.includes("--mismatches");
const projectsFile = path.join(dataDir, "projects.json");

if (!fs.existsSync(projectsFile)) {
  console.error(`\nNo projects file at ${projectsFile}`);
  console.error(`Run this where the data lives, or pass --data <dir>.`);
  console.error(`(server/data is gitignored, so it is never present in a fresh checkout.)\n`);
  process.exit(2);
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const raw = readJson(projectsFile);
const projects = Array.isArray(raw) ? raw : ((raw && raw.projects) || []);

// Families that carry sprinkler heads at all. Drip beds and tree zones are
// counted in beds and trees, and are reported as such rather than as zero.
const HEAD_FAMILIES = new Set(["rotor", "mp", "spray", "strip"]);

function analyse(design) {
  const areas = JSON.parse(JSON.stringify(design.areas || [])).map((a) => E.ensureArea(a));
  const inputs = design.inputs || {};
  const ceiling = parseFloat(inputs.ceiling) || 0;
  const spacingFactor = inputs.spacingFactor;
  const routing = E.migrateRoutingSplits(design.routing || {}, design.version);
  const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
  const zones = E.computeZonePlan({
    plans, areas, routing, valveGroupModes: design.valveGroupModes || {}, ceiling
  });
  // How many heads each valve claims, per area it feeds.
  const assigned = new Map();                       // areaIdx -> heads
  const valvesOf = new Map();                       // areaIdx -> [{name, station, heads}]
  zones.forEach((z) => {
    (z.parts || []).forEach((pt) => {
      const a = areas[pt.areaIdx];
      if (!a || !HEAD_FAMILIES.has(a.family)) return;
      const p = (plans[pt.areaIdx] || {}).plan;
      // The heads THIS valve feeds in THIS area — the same question the
      // printed zone sheet asks when it draws them.
      const n = p ? E.mpZoneHeads(z, pt, a, p, { plans, areas, routing, valveGroupModes: design.valveGroupModes || {}, ceiling }).length : 0;
      assigned.set(pt.areaIdx, (assigned.get(pt.areaIdx) || 0) + n);
      if (!valvesOf.has(pt.areaIdx)) valvesOf.set(pt.areaIdx, []);
      valvesOf.get(pt.areaIdx).push({ name: z.name, station: (z.station || 0) + 1, heads: z.headCount || 0, drawn: n });
    });
  });
  return areas.map((a, i) => {
    const p = (plans[i] || {}).plan || {};
    const headFamily = HEAD_FAMILIES.has(a.family);
    return {
      area: a.name || `Area ${i + 1}`,
      family: a.family,
      handPlaced: a.layout === "manual",
      placed: headFamily && Array.isArray(a.manualHeads) ? a.manualHeads.length : null,
      planned: headFamily ? (Array.isArray(p.heads) ? p.heads.length : 0) : null,
      assigned: headFamily ? (assigned.get(i) || 0) : null,
      traced: !!(p.poly && p.orig),
      beds: a.family === "drip" ? 1 : null,
      trees: a.family === "trees" ? (Array.isArray(a.trees) ? a.trees.length : 0) : null,
      valves: valvesOf.get(i) || []
    };
  });
}

const rows = [];
for (const p of projects) {
  if (!p || !p.systemDesign || !Array.isArray(p.systemDesign.areas)) continue;
  if (only && p.id !== only) continue;
  let areas;
  try { areas = analyse(p.systemDesign); } catch (e) { 
    rows.push({ project: p.id, name: p.name || "", error: String(e && e.message || e).slice(0, 120) });
    continue;
  }
  areas.forEach((a) => rows.push(Object.assign({ project: p.id, name: p.name || "" }, a)));
}

// Nothing here should ever carry contact detail. If it somehow does, say so
// and print nothing rather than leaking it into a terminal or a paste.
const LEAK = /[\w.+-]+@[\w-]+\.\w+|\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/;
const leak = rows.find((r) => LEAK.test(JSON.stringify(r)));
if (leak) {
  console.error("\nRefusing to print: a field looks like contact data.");
  console.error(`(project ${leak.project}) — fix the report before running it again.\n`);
  process.exit(3);
}

// An area that is NOT traced on a sheet has no drawable heads by
// definition, so `assigned` is legitimately 0 and comparing it proves
// nothing. Only a traced area can disagree.
const disagrees = (r) => r.placed != null && r.traced &&
  (r.placed !== r.planned || r.planned !== r.assigned);
// Show every valve's heads when one project was asked for — that is the
// question, not a diagnostic — or on any area whose numbers disagree.
const showValves = !!only || argv.includes("--valves");
const shown = mismatchesOnly ? rows.filter(disagrees) : rows;

if (asJson) { console.log(JSON.stringify(shown, null, 2)); process.exit(0); }

if (!shown.length) {
  console.log(mismatchesOnly
    ? "\n  Every area's heads add up: placed = planned = assigned.\n"
    : "\n  No saved designs found.\n");
  process.exit(0);
}

const w = (s, n) => String(s == null ? "—" : s).slice(0, n).padEnd(n);
const wr = (s, n) => String(s == null ? "—" : s).slice(0, n).padStart(n);
let lastProject = null;
console.log("");
for (const r of shown) {
  if (r.project !== lastProject) {
    console.log(`\n  ${r.project}  ${r.name}`);
    console.log(`  ${"area".padEnd(34)}${"family".padEnd(9)}${"by hand".padEnd(9)}${"placed".padStart(7)}${"planned".padStart(8)}${"assigned".padStart(9)}`);
    console.log(`  ${"-".repeat(76)}`);
    lastProject = r.project;
  }
  if (r.error) { console.log(`  ${w(r.error, 74)}`); continue; }
  const flag = disagrees(r) ? "  <-- DISAGREES" : "";
  const extra = r.trees != null ? `  (${r.trees} trees)`
              : (r.beds != null ? "  (drip bed)"
              : (r.planned != null && !r.traced ? "  (not traced on a sheet — nothing to draw)" : ""));
  console.log(`  ${w(r.area, 34)}${w(r.family, 9)}${w(r.handPlaced ? "yes" : "auto", 9)}` +
              `${wr(r.placed, 7)}${wr(r.planned, 8)}${wr(r.assigned, 9)}${flag}${extra}`);
  if ((showValves || disagrees(r)) && r.valves.length) {
    r.valves.forEach((v) => console.log(
      `  ${" ".repeat(34)}station ${String(v.station).padStart(2)} · ${v.name}` +
      ` — zone says ${v.heads} hd, sheet draws ${v.drawn}` +
      // Only meaningful on a traced area: an untraced one draws nothing
      // anywhere, which is not a disagreement about anything.
      (r.traced && v.heads !== v.drawn ? "   <-- these differ" : "")));
  }
}
const bad = rows.filter(disagrees).length;
console.log(`\n  ${rows.filter((r) => r.placed != null).length} head areas checked · ${bad} disagree\n`);
if (!bad) console.log("  placed = planned = assigned everywhere: no heads are being lost.\n");

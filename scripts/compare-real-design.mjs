#!/usr/bin/env node
// scripts/compare-real-design.mjs
//
// Run ONE REAL SAVED DESIGN through both engines and diff every number.
//
//   node scripts/compare-real-design.mjs <design.json> [--ref origin/main]
//
// The fixtures prove the extraction on 18 designs I invented. This proves
// it on YOURS — the actual blob out of the project, with its real areas,
// its real routing, its real valve groups and its real hand-placed heads.
//
// It loads the System Builder TWICE in the same browser:
//
//   PRODUCTION  server/sitebuilder.html as it stands on `--ref` (default
//               origin/main) — the engine still inline, exactly what is
//               serving www.pjllandservices.com right now.
//   PR          the working tree — the page plus the extracted engine.
//
// Both get the same design, the same parts catalog and the same form
// values, and both are driven through restoreState(), which is the same
// path taken when you open the project. Then every figure is compared:
// zones, per-zone GPM, valve grouping and splits, head counts, pipe and
// drip footage, every BOM line quantity, and the BOM total to the cent.
//
// It also does the SAVE AND REOPEN check, in both versions: serialize the
// design the way "Save to project" does, restore it the way opening the
// project does, recompute, and require every number to come back the
// same — and the re-serialized blob to be byte-for-byte identical.
//
// NOTHING IS WRITTEN ANYWHERE. No server is contacted, no project is
// opened, no design is saved. The design file is read from disk and every
// API call the page makes is answered with an empty object. Point it at a
// copy of a real design and the real design cannot be touched.

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { stableStringify, diffSnapshots, classifyDiffs, moneyFields } from "./lib/system-design-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const designPath = args.find((a) => !a.startsWith("--"));
const refIdx = args.indexOf("--ref");
const REF = refIdx >= 0 ? args[refIdx + 1] : "origin/main";

if (!designPath) {
  console.error(`
Usage: node scripts/compare-real-design.mjs <design.json> [--ref origin/main]

  <design.json>  the saved design. Either the systemDesign blob itself, or
                 the whole /api/projects/<id> response — it finds the blob.
`);
  process.exit(2);
}

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const fallback = "/opt/pw-browsers/chromium";
  if (fs.existsSync(fallback)) return { executablePath: fallback };
  return {};
}

// ── The design, however it was handed over ───────────────────────────
const raw = JSON.parse(fs.readFileSync(designPath, "utf8"));
const design = raw.systemDesign || (raw.project && raw.project.systemDesign) || raw;
if (!design || !Array.isArray(design.areas)) {
  console.error("That file has no systemDesign with an `areas` array in it.");
  process.exit(2);
}
// Prices: the catalog committed to the repo. Both sides get the SAME one,
// which is what makes the comparison mean something. Runtime edits from
// parts-overrides.json are not in it, so the BOM total here can differ
// from the live page's — but it differs the same way on both sides.
const partsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "parts.json"), "utf8"));
const parts = partsRaw.parts || partsRaw;

console.log(`\nDesign:   ${path.relative(ROOT, designPath)}`);
console.log(`          ${design.areas.length} areas · saved format v${design.version ?? "?"}` +
            (design.savedAt ? ` · last saved ${design.savedAt}` : ""));
console.log(`Compared: PRODUCTION (${REF}) vs PR (working tree)\n`);

// ── Serve both versions ──────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-compare-"));
const showRef = (f) => execFileSync("git", ["show", `${REF}:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

// EACH SIDE GETS ITS OWN ENGINE.
//
// The page loads its maths from the fixed path /admin/sitebuilder-engine.js,
// so one server cannot answer that path two ways: serving both pages from
// one handed the WORKING TREE's engine to the reference page as well, and
// "production" became the old page running the new maths. That is not
// either version, and a comparison between two things neither of which is
// production proves nothing. Two servers, one per version.
function serveBuilder(html, engine, helpJs) {
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    const serve = (buf, type) => {
      res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
      res.end(buf);
    };
    if (p === "/") return serve(html, "text/html");
    if (p === "/admin/sitebuilder-engine.js") return serve(engine, "text/javascript");
    // The help registry (2026-09-23). The PRODUCTION page may predate it
    // and simply never ask; the candidate page reads its tooltips from it.
    if (p === "/admin/sitebuilder-help.js") return serve(helpJs || "", "text/javascript");
    // Every API call the page makes gets an empty object. Nothing is fetched
    // and nothing can be saved.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
}
const helpNow = () => fs.readFileSync(path.join(ROOT, "server", "sitebuilder-help.js"));
const prodSrv = serveBuilder(showRef("server/sitebuilder.html"), showRef("server/sitebuilder-engine.js"), helpNow());
const prSrv = serveBuilder(fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html")),
                           fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js")),
                           helpNow());
await new Promise((r) => prodSrv.listen(0, "127.0.0.1", r));
await new Promise((r) => prSrv.listen(0, "127.0.0.1", r));
const PROD_URL = `http://127.0.0.1:${prodSrv.address().port}/`;
const PR_URL = `http://127.0.0.1:${prSrv.address().port}/`;

/** Runs INSIDE the page: restore the design, compute, harvest every number,
 *  then save-and-reopen it and harvest again. */
/* c8 ignore start — executes in the browser */
function harvest({ design, parts }) {
  const out = { pageErrors: [] };
  PARTS_MAP = parts;
  if (!restoreState(JSON.parse(JSON.stringify(design)))) throw new Error("restoreState() refused the design");
  compute();
  LAST_ZONES = computeZonePlan();

  const snap = () => {
    LAST_PLANS = areas.map((a) => ({ area: a, plan: plan(a) }));
    LAST_ZONES = computeZonePlan();
    const bom = buildBOM(PARTS_MAP);
    return {
      totalZones: stationCount(),
      totalValves: LAST_ZONES.length,
      splitValves: LAST_ZONES.length - stationCount(),
      peakStationGPM: peakStationGPM(),
      // Zone by zone, in the order the controller sees them.
      zones: LAST_ZONES.map((z) => ({
        name: z.name, family: z.family, station: z.station, half: z.half || null,
        gpm: z.gpm, stationGpm: z.stationGpm ?? null, dripFt: z.dripFt,
        headCount: z.headCount, treeCount: z.treeCount ?? null,
        members: z.members, grouped: !!z.grouped, key: z.key,
        boxId: z.boxId ?? null, stationGroup: z.stationGroup ?? null
      })),
      stations: stationZones().map((s) => ({
        station: s.station, name: s.name, family: s.family, gpm: s.gpm,
        valves: s.valves, headCount: s.headCount, dripFt: s.dripFt, members: s.members
      })),
      areas: areas.map((a, i) => {
        const p = LAST_PLANS[i].plan;
        return {
          name: a.name, family: a.family, valveGroup: a.valveGroup || null,
          sqft: p.sqft, zones: p.zones, zoneGPM: p.zoneGPM, totalGPM: p.totalGPM,
          headCount: (p.heads || []).length, arcCount: p.arcCount || null,
          manual: !!p.manual, handZoned: !!p.handZoned, overZones: p.overZones || [],
          dripLengthFt: p.dripLengthFt ?? null, areaDripFt: p.areaDripFt ?? null,
          treeTubeFt: p.treeTubeFt ?? null, tubeFt: p.tubeFt ?? null,
          emitters: p.emitters ?? null, treeCount: p.treeCount ?? null,
          rwsUnits: p.rwsUnits ?? null, ringTrees: p.ringTrees ?? null,
          materialCents: areaMaterialCents(a, p)
        };
      }),
      bom: {
        subtotalCents: bom.subtotalCents,
        lateralFt: bom.lateralFt,
        lateralBySize: bom.lateralBySize,
        lateralMeasured: bom.lateralMeasured,
        lines: bom.lines.map((l) => ({ sku: l.sku, desc: l.desc, qty: l.qty, priceCents: l.priceCents, unit: l.unit }))
      }
    };
  };

  out.first = snap();

  // ---- Save and reopen -------------------------------------------------
  // serializeState() is exactly what "Save to project" PATCHes. Restoring
  // it is exactly what opening the project does. Nothing is sent anywhere.
  const saved = serializeState();
  if (!restoreState(JSON.parse(JSON.stringify(saved)))) throw new Error("restoreState() refused the re-saved design");
  compute();
  out.reopened = snap();
  const savedAgain = serializeState();

  // savedAt is a clock reading, not design data.
  const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.savedAt; return c; };
  out.blobStable = JSON.stringify(strip(saved)) === JSON.stringify(strip(savedAgain));
  out.blobBytes = JSON.stringify(saved).length;
  return out;
}
/* c8 ignore stop */

async function run(label, url) {
  const browser = await chromium.launch(chromiumLaunchOpts());
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("appReady === true", null, { timeout: 30000 });
    const res = await page.evaluate(harvest, { design, parts });
    res.pageErrors = errors;
    return res;
  } finally {
    await browser.close();
  }
}

let prod, pr;
try {
  prod = await run("production", PROD_URL);
  pr = await run("pr", PR_URL);
} finally {
  prodSrv.close(); prSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Report ───────────────────────────────────────────────────────────
let ok = true;
const row = (k, v) => `  ${String(k).padEnd(34)} ${v}`;

console.log("─".repeat(72));
console.log("WHAT EACH VERSION SAYS ABOUT THIS DESIGN");
console.log("─".repeat(72));
const f = prod.first, g = pr.first;
const cmp = (label, a, b, fmt = (x) => String(x)) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) ok = false;
  console.log(row(label, `${fmt(a).padEnd(22)} ${fmt(b).padEnd(22)} ${same ? "same" : "*** DIFFERENT ***"}`));
};
console.log(row("", `${"PRODUCTION".padEnd(22)} ${"PR".padEnd(22)}`));
cmp("Total zones (stations)", f.totalZones, g.totalZones);
cmp("Valves in the ground", f.totalValves, g.totalValves);
cmp("  of which split", f.splitValves, g.splitValves);
cmp("Peak station GPM", f.peakStationGPM, g.peakStationGPM, (x) => Number(x).toFixed(2));
cmp("Spray/rotor heads", f.areas.reduce((t, a) => t + a.headCount, 0), g.areas.reduce((t, a) => t + a.headCount, 0));
cmp("Dripline (ft)", Math.round(f.areas.reduce((t, a) => t + (a.dripLengthFt || a.tubeFt || 0), 0)),
                     Math.round(g.areas.reduce((t, a) => t + (a.dripLengthFt || a.tubeFt || 0), 0)));
cmp("Lateral pipe (ft)", f.bom.lateralFt, g.bom.lateralFt);
cmp("BOM lines", f.bom.lines.length, g.bom.lines.length);
cmp("BOM total", f.bom.subtotalCents, g.bom.subtotalCents, (c) => "$" + (c / 100).toFixed(2));

console.log("\n" + "─".repeat(72));
console.log("EVERY FIGURE, FIELD BY FIELD");
console.log("─".repeat(72));
const diffs = diffSnapshots(JSON.parse(stableStringify(prod.first)), JSON.parse(stableStringify(pr.first)));
const { real, runtimeFloat } = classifyDiffs(diffs);
if (!real.length) {
  console.log("  ok   PRODUCTION and PR agree on every single field, to the cent.");
} else {
  ok = false;
  console.log(`  FAIL ${real.length} field(s) differ (${moneyFields(real).length} of them money):`);
  for (const d of real.slice(0, 40)) {
    console.log(`         ${d.path}\n           production: ${JSON.stringify(d.expected)}\n           PR:         ${JSON.stringify(d.actual)}`);
  }
  if (real.length > 40) console.log(`         … and ${real.length - 40} more`);
}
if (runtimeFloat.length) console.log(`       (${runtimeFloat.length} sub-nanometre geometry value(s), reported not hidden)`);

console.log("\n" + "─".repeat(72));
console.log("SAVE AND REOPEN");
console.log("─".repeat(72));
for (const [label, res] of [["PRODUCTION", prod], ["PR", pr]]) {
  const rt = diffSnapshots(JSON.parse(stableStringify(res.first)), JSON.parse(stableStringify(res.reopened)));
  const bad = classifyDiffs(rt).real;
  const good = !bad.length && res.blobStable;
  if (!good) ok = false;
  console.log(row(label, `${bad.length ? `${bad.length} figure(s) moved` : "every figure identical"}` +
                         ` · saved blob ${res.blobStable ? "byte-for-byte identical" : "*** CHANGED ***"}` +
                         ` (${(res.blobBytes / 1024).toFixed(0)} KB)`));
  for (const d of bad.slice(0, 10)) console.log(`         ${d.path}: ${JSON.stringify(d.expected)} -> ${JSON.stringify(d.actual)}`);
}

for (const [label, res] of [["PRODUCTION", prod], ["PR", pr]]) {
  if (res.pageErrors.length) {
    ok = false;
    console.log(`\n  ${label} page errors:`);
    for (const e of res.pageErrors) console.log(`    ${e}`);
  }
}

console.log("\n" + "═".repeat(72));
console.log(ok
  ? "PASS — on your own design, the PR produces exactly what production does,\n       and both survive a save and reopen unchanged."
  : "FAIL — see the differing fields above.");
console.log("═".repeat(72) + "\n");
process.exit(ok ? 0 : 1);

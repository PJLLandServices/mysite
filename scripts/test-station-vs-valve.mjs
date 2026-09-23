#!/usr/bin/env node
// scripts/test-station-vs-valve.mjs
//
// ONE CONTROLLER STATION CAN OPEN TWO PHYSICAL VALVES, AND EVERY READER
// HAS TO SAY SO IN ITS OWN TERMS.
//
// Patrick, on Dundalk: "Trees A and Trees B must appear separately, even
// though they share one controller station. They are still two physical
// valves with separate lateral piping." Three different counts, and the
// builder had been conflating them:
//
//   controller station   one programmed output      Station 9 · Trees
//   physical valve       a box, a solenoid, a run   Trees A, Trees B
//   designed area        one landscape area         Trees
//
// TWO DEFECTS, BOTH FIXED HERE.
//
// SB-01  mpDraw() built its valve set by walking HEADS. Trees are not
//        heads, so a split trees zone contributed only its A half: Trees B
//        never appeared in the layers panel and the header's valve count
//        was one short — on a sheet whose laterals were drawn correctly the
//        whole time.
//
// SB-02  The project summary sent zoneCount = areas.length, and four
//        readers printed it as a zone count. Areas are not stations and
//        stations are not valves. Dundalk is 12 · 16 · 19.
//
//   npm run test:station-vs-valve

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const html = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"), "utf8");
const engineJs = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js"), "utf8");
// The help registry ships with the page (2026-09-23): the toolbar reads
// every tooltip and label out of it, so a harness that does not serve it
// renders unlabelled controls.
const helpJs = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-help.js"), "utf8");
const pjlDialogJs = fs.readFileSync(path.join(ROOT, "server", "pjl-dialog.js"), "utf8");
const pjlDialogCss = fs.readFileSync(path.join(ROOT, "server", "pjl-dialog.css"), "utf8");

let pass = 0; const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

const PAGE = "spp_stations";
// A rotor lawn, plus a row of four trees straddling a driveway at x = 100.
// The trees are ONE designed area, split into TWO valves fed from two
// boxes, wired to ONE controller station — Dundalk's Trees A / Trees B.
const treeAt = (x, y) => ({ x, y, type: "ring", dia: 4 });
const design = (mode) => ({
  version: 9,
  inputs: { availGPM: "18", psi: "60", ceiling: "17.5", spacingFactor: "1" },
  waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
  linkedQuoteId: null, wcRunOverrides: {},
  areas: [
    { aid: "a_lawn", name: "Front lawn", family: "rotor", rotorNoz: "b40", mode: "custom",
      planRef: { pageId: PAGE },
      poly: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 60 }, { x: 20, y: 60 }] },
    // Dundalk's Trees area is 10,930 sq ft, so it carries a traced outline
    // as well as the trees themselves. The driveway runs down x = 100.
    { aid: "a_trees", name: "Trees", family: "trees", mode: "custom", planRef: { pageId: PAGE },
      poly: [{ x: 40, y: 100 }, { x: 170, y: 100 }, { x: 170, y: 140 }, { x: 40, y: 140 }],
      // SEVEN trees, split FIVE and TWO. Deliberately lopsided: a 2-and-2
      // split cannot tell "each half measured on its own" apart from "the
      // same measurement printed twice", so the halves are made to differ
      // in tree count, in flow and in lateral length. Real rows of trees
      // do not fall evenly either side of a driveway.
      trees: [treeAt(50, 120), treeAt(62, 120), treeAt(74, 120), treeAt(86, 120), treeAt(96, 120),
              treeAt(130, 120), treeAt(152, 120)] }
  ].filter((a) => mode !== "lawnOnly" || a.aid !== "a_trees"),
  routing: { [PAGE]: {
    poc: { x: 100, y: 160 }, main: [],
    manifolds: [{ x: 40, y: 90, id: "m_west" }, { x: 170, y: 90, id: "m_east" }],
    pins: {},
    // shareStation:true — two valves, ONE controller station.
    splits: mode === "split"
      ? { "z:a_trees:0": { ax: 100, ay: 60, bx: 100, by: 180, shareStation: true } }
      : {}
  } }
});

const project = (mode) => ({
  id: "PROJ-TEST-0001", name: "Station vs valve", customerName: "Test",
  sitePlan: { pages: [{ id: PAGE, label: "Sheet 1", rasterWidthPx: 3000, rasterHeightPx: 2000,
    calibration: { state: "calibrated", ftPerPx: 0.1, verify: { state: "passed", residualPct: 0.1 } } }] },
  systemDesign: design(mode)
});

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { executablePath: "/opt/pw-browsers/chromium" });

async function open(mode) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/sitebuilder") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/admin/sitebuilder-engine.js") return route.fulfill({ contentType: "text/javascript", body: engineJs });
    if (url.pathname === "/crm/pjl-dialog.js") return route.fulfill({ contentType: "application/javascript", body: pjlDialogJs });
    if (url.pathname === "/crm/pjl-dialog.css") return route.fulfill({ contentType: "text/css", body: pjlDialogCss });
    if (url.pathname === "/api/projects/PROJ-TEST-0001") return route.fulfill({ json: { ok: true, project: project(mode) } });
    if (url.pathname === "/api/parts") return route.fulfill({ json: { ok: true, parts: [] } });
    if (url.pathname === "/api/projects") return route.fulfill({ json: { ok: true, projects: [] } });
    if (url.pathname.endsWith("town-water-rates.json")) return route.fulfill({ json: { towns: [] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://pjl.test/admin/sitebuilder?project=PROJ-TEST-0001");
  await page.waitForFunction(() => appReady === true);
  await page.evaluate((id) => openMasterPlan(id), PAGE);
  await page.waitForSelector("#mpOverlay:not([hidden])");
  const seen = await page.evaluate(() => ({
    stations: stationCount(),
    valves: LAST_ZONES.length,
    areaCount: areas.length,
    valveNames: LAST_ZONES.map((z) => z.name),
    stationOf: LAST_ZONES.map((z) => z.station),
    // What the layers panel actually renders.
    layerNames: [...document.querySelectorAll("#mpLegend .mp-layer b")].map((b) => b.textContent),
    stationHeadings: [...document.querySelectorAll("#mpLegend .mp-station")].map((d) => d.textContent),
    layersCount: (document.getElementById("mpLayersN") || {}).textContent || "",
    headerStat: (document.getElementById("mpStat") || {}).textContent || "",
    // Laterals, per valve, from the same plan the BOM orders from.
    lateralRuns: mpLateralPlan().runs.map((r) => ({ name: LAST_ZONES[r.zi].name, ft: Math.round(r.ft) })),
    // Per half: what the sheet says each valve actually waters.
    halves: LAST_ZONES.filter((z) => z.half).map((z) => ({
      name: z.name, half: z.half, station: z.station,
      trees: z.treeCount || 0, gpm: +z.gpm.toFixed(2)
    })),
    // What the customer would be offered.
    quoteLines: desiredQuoteLines().desired.filter((l) => l.kind === "zone").map((l) => l.label)
  }));
  await ctx.close();
  return { seen, errors };
}

// ── A. One area, one valve, one station ──────────────────────────────
console.log("\nA. The trees as ONE valve (no split)");
const plain = await open("trees");
console.log(`     ${plain.seen.stations} stations · ${plain.seen.valves} valves · ${plain.seen.areaCount} areas`);
check("no page errors", plain.errors.length === 0, plain.errors[0] || "");
check("the trees are one valve", plain.seen.valveNames.filter((n) => /Trees/.test(n)).length === 1,
      JSON.stringify(plain.seen.valveNames));
check("the trees valve is drawn on the sheet", plain.seen.layerNames.some((n) => /Trees/.test(n)),
      JSON.stringify(plain.seen.layerNames));
check("its lateral run is measured", plain.seen.lateralRuns.some((r) => /Trees/.test(r.name) && r.ft > 0),
      JSON.stringify(plain.seen.lateralRuns));

// ── B. Split, shared station: +1 station, +2 valves ──────────────────
console.log("\nB. The same trees split across two boxes, wired to ONE station");
const split = await open("split");
const lawnOnly = await open("lawnOnly");
console.log(`     ${split.seen.stations} stations · ${split.seen.valves} valves · ${split.seen.areaCount} areas`);
console.log(`     layers panel: ${JSON.stringify(split.seen.layerNames)}`);
console.log(`     heading:      ${JSON.stringify(split.seen.stationHeadings)}`);
check("no page errors", split.errors.length === 0, split.errors[0] || "");

const treeValves = split.seen.valveNames.filter((n) => /Trees/.test(n));
check("the trees are now TWO physical valves", treeValves.length === 2, JSON.stringify(treeValves));
check("...named A and B", /· A$/.test(treeValves[0] || "") && /· B$/.test(treeValves[1] || ""),
      JSON.stringify(treeValves));
check("...on the SAME controller station",
      split.seen.stationOf[split.seen.valveNames.indexOf(treeValves[0])] ===
      split.seen.stationOf[split.seen.valveNames.indexOf(treeValves[1])]);
check("splitting an existing valve adds ONE more valve",
      split.seen.valves === plain.seen.valves + 1, `${plain.seen.valves} -> ${split.seen.valves}`);
check("...and does NOT add a station (they share one)",
      split.seen.stations === plain.seen.stations, `${plain.seen.stations} -> ${split.seen.stations}`);
check("...and does NOT add a designed area (still one Trees area)",
      split.seen.areaCount === plain.seen.areaCount, `${plain.seen.areaCount} -> ${split.seen.areaCount}`);

// Patrick's regression, stated as he stated it: a station that operates two
// physical valves contributes ONE station and TWO valves. Measured against
// a design with no trees at all, which is what that claim compares to.
console.log("\n   A station operating two valves, against a design without it:");
console.log(`     lawn only          ${lawnOnly.seen.stations} stations · ${lawnOnly.seen.valves} valves · ${lawnOnly.seen.areaCount} areas`);
console.log(`     + shared-split trees ${split.seen.stations} stations · ${split.seen.valves} valves · ${split.seen.areaCount} areas`);
check("station count increases by ONE",
      split.seen.stations === lawnOnly.seen.stations + 1,
      `${lawnOnly.seen.stations} -> ${split.seen.stations}`);
check("valve count increases by TWO",
      split.seen.valves === lawnOnly.seen.valves + 2,
      `${lawnOnly.seen.valves} -> ${split.seen.valves}`);
check("designed area count increases by ONE",
      split.seen.areaCount === lawnOnly.seen.areaCount + 1,
      `${lawnOnly.seen.areaCount} -> ${split.seen.areaCount}`);

// ── C. Both valve layers on the master plan ──────────────────────────
console.log("\nC. Both valve layers appear on the master plan");
const treeLayers = split.seen.layerNames.filter((n) => /Trees/.test(n));
check("BOTH Trees A and Trees B are listed", treeLayers.length === 2, JSON.stringify(split.seen.layerNames));
check("...each individually, not merged into one row",
      treeLayers.some((n) => /· A$/.test(n)) && treeLayers.some((n) => /· B$/.test(n)),
      JSON.stringify(treeLayers));
check("they sit under a station heading that names the station",
      split.seen.stationHeadings.some((h) => /Station \d+ · Trees/.test(h)),
      JSON.stringify(split.seen.stationHeadings));
check("...which says one station opens both",
      split.seen.stationHeadings.some((h) => /2 valves, one station/.test(h)),
      JSON.stringify(split.seen.stationHeadings));
check("the panel counts valves and stations separately",
      /2 valves/.test(split.seen.layersCount.replace(/^\d+/, (m) => m)) || /valve/.test(split.seen.layersCount),
      split.seen.layersCount);
check("the sheet header names both counts",
      /valve/.test(split.seen.headerStat) && /station/.test(split.seen.headerStat),
      split.seen.headerStat);

// ── D. Both laterals, and one proposal line ──────────────────────────
console.log("\nD. Two lateral runs, one line on the proposal");
// The halves are lopsided on purpose — five trees one side, two the other.
// If these ever come out equal the fixture has stopped testing anything.
console.log(`     halves: ${split.seen.halves.map((h) => `${h.name} ${h.trees} trees ${h.gpm} GPM`).join("  |  ")}`);
const hA = split.seen.halves.find((h) => h.half === "A") || {};
const hB = split.seen.halves.find((h) => h.half === "B") || {};
check("the halves carry DIFFERENT tree counts (5 and 2)",
      (hA.trees === 5 && hB.trees === 2) || (hA.trees === 2 && hB.trees === 5),
      `${hA.trees} and ${hB.trees}`);
check("...so their flows differ too", hA.gpm !== hB.gpm, `${hA.gpm} vs ${hB.gpm}`);
check("...and every tree is still accounted for", (hA.trees || 0) + (hB.trees || 0) === 7,
      `${hA.trees} + ${hB.trees}`);

const treeRuns = split.seen.lateralRuns.filter((r) => /Trees/.test(r.name));
check("BOTH halves have their own lateral run", treeRuns.length === 2, JSON.stringify(split.seen.lateralRuns));
check("...and both are measured, not zero", treeRuns.every((r) => r.ft > 0), JSON.stringify(treeRuns));
check("...and the two runs are DIFFERENT lengths — each measured on its own",
      treeRuns.length === 2 && treeRuns[0].ft !== treeRuns[1].ft,
      JSON.stringify(treeRuns) + " — equal lengths would mean one measurement printed twice");
const treeLines = split.seen.quoteLines.filter((l) => /Trees/.test(l));
check("the proposal still offers ONE line for the trees", treeLines.length === 1, JSON.stringify(split.seen.quoteLines));
check("...and the proposal's line count equals the station count",
      split.seen.quoteLines.length === split.seen.stations,
      `${split.seen.quoteLines.length} lines, ${split.seen.stations} stations`);

// ── E. The server counts the same design the same way ───────────────
//
// The project summary is built server-side, with no browser. If it counts
// differently from the builder, the overview and the screen disagree about
// the same job — which is how `zoneCount: areas.length` survived: nothing
// ever compared the two.
console.log("\nE. The server's counts, against the browser's");
{
  const { countSystemDesign } = createRequire(import.meta.url)(
    path.join(ROOT, "server", "lib", "system-design-counts.js"));
  for (const [mode, seen] of [["trees", plain.seen], ["split", split.seen], ["lawnOnly", lawnOnly.seen]]) {
    const c = countSystemDesign(design(mode));
    console.log(`     ${mode.padEnd(9)} server ${c.stationCount}/${c.valveCount}/${c.areaCount}` +
                `   browser ${seen.stations}/${seen.valves}/${seen.areaCount}`);
    check(`[${mode}] stations agree`, c.stationCount === seen.stations, `${c.stationCount} vs ${seen.stations}`);
    check(`[${mode}] valves agree`, c.valveCount === seen.valves, `${c.valveCount} vs ${seen.valves}`);
    check(`[${mode}] areas agree`, c.areaCount === seen.areaCount, `${c.areaCount} vs ${seen.areaCount}`);
  }
  // The specific lie the old summary told.
  const c = countSystemDesign(design("split"));
  check("the valve count is NOT the area count", c.valveCount !== c.areaCount,
        `${c.valveCount} valves, ${c.areaCount} areas — if these match, this fixture stopped testing anything`);
  check("a version-8 design is migrated before counting, not read raw", (() => {
    const v8 = JSON.parse(JSON.stringify(design("split")));
    v8.version = 8;
    delete v8.routing[PAGE].splits["z:a_trees:0"].shareStation;   // v8 stored no flag
    const c8 = countSystemDesign(v8);
    return c8.stationCount === c.stationCount && c8.valveCount === c.valveCount;
  })(), "a flagless version-8 split must count as SHARED, like the builder shows it");
  check("a blob with no areas is not a design", countSystemDesign({}) === null);
  check("an empty design counts as zero, not as a crash",
        JSON.stringify(countSystemDesign({ areas: [] })) === JSON.stringify({ stationCount: 0, valveCount: 0, areaCount: 0 }));
}

// ── F. Nothing calls the area count a zone count any more ────────────
console.log("\nF. No reader reports areas.length as a zone count");
{
  const reads = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const server = reads("server/server.js");
  check("the summary sends stationCount, valveCount and areaCount",
        /stationCount: counts\.stationCount/.test(server) &&
        /valveCount: counts\.valveCount/.test(server) &&
        /areaCount: counts\.areaCount/.test(server));
  check("...and no longer sends zoneCount at all",
        !/zoneCount: proj\.systemDesign\.areas\.length/.test(server));
  for (const f of ["server/project.js", "admin-app/src/routes/ProjectOverview.tsx", "admin-app/src/lib/nextAction.ts"]) {
    const src = reads(f);
    check(`${f} reads none of sb.zoneCount`, !/\.zoneCount\b/.test(src),
          (src.match(/.*\.zoneCount\b.*/) || [""])[0].trim());
  }
  // The built bundle is what actually gets served — a .tsx edit that was
  // never rebuilt would leave the old wording live.
  const dist = fs.readdirSync(path.join(ROOT, "server", "app-dist", "assets"));
  const js = dist.find((f) => f.endsWith(".js"));
  const bundle = reads(path.join("server", "app-dist", "assets", js));
  check("the built bundle carries the new wording (it was rebuilt)",
        /valveCount/.test(bundle) && /stationCount/.test(bundle), js);
  check("...and none of the old zoneCount", !/zoneCount/.test(bundle), js);
}

await browser.close();
console.log(`\nstation vs valve: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

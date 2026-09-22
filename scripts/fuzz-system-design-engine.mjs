#!/usr/bin/env node
// scripts/fuzz-system-design-engine.mjs
//
// Does the extracted engine calculate identically to production? Asked of
// hundreds of randomly generated designs instead of one real one.
//
//   node scripts/fuzz-system-design-engine.mjs [--designs 300] [--seed 1]
//
// The 19 hand-written fixtures pin the boundaries I thought of. This asks
// the question I could not think of: it builds designs at random across
// the whole feature space — every head family, every input mode, traced
// polygons, sectors and circles, hand-placed layouts with hand-assigned
// valves and free arcs and reduced radii, ring and RWS trees, shared and
// boxed drip valve groups, driveway splits, legacy v1 areas, and ceilings
// and spacing factors swept across their range — then runs each one
// through BOTH engines and requires every number to match.
//
//   PRODUCTION  server/sitebuilder.html on origin/main — the engine still
//               inline, which is what serves the live site.
//   PR          the working tree — the page plus the extracted module.
//
// Both run in the same browser, so there is one variable. Every design is
// generated from a seed, so a failure is reproducible: the seed and the
// design index are printed, and --only <n> replays that one.
//
// Nothing is read from or written to any project. The designs are made up.

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { stableStringify, diffSnapshots, classifyDiffs, moneyFields } from "./lib/system-design-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = parseInt(arg("--designs", "300"), 10);
const SEED = parseInt(arg("--seed", "1"), 10);
const ONLY = argv.includes("--only") ? parseInt(arg("--only", "0"), 10) : null;
const REF = arg("--ref", "origin/main");

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const fallback = "/opt/pw-browsers/chromium";
  if (fs.existsSync(fallback)) return { executablePath: fallback };
  return {};
}

// ── A seeded generator, so every failure is reproducible ─────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROTOR = ["b15","b20","b25","b30","b40","b50","b60","b80","g20","g25","g35","g45","r1","r2","r3","r4","r5","r6","r7","r8","r9","r10","r11","r12"];
const MP = ["mp1000","mp2000","mp3000"];
const SPRAY = ["s8","s10","s12","s15"];
const BODY = ["b4","b6","b12"];
const STRIP = ["cst","sst","est","lcs","rcs","s9"];
const DRIPP = ["xf09","ld08"];
const FAMILIES = ["rotor","mp","spray","strip","drip","trees"];

function makeDesign(rnd, idx) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const num = (lo, hi, d = 1) => Math.round((lo + rnd() * (hi - lo)) * 10 ** d) / 10 ** d;

  const nAreas = int(1, 9);
  const usePlan = rnd() < 0.6;
  const groupNames = ["Drip A", "Drip B", "Drip C"].slice(0, int(0, 3));
  const areas = [];
  let ox = 0;

  for (let i = 0; i < nAreas; i++) {
    const aid = `a_f${idx}_${i}`;
    // 1 in 12 is a legacy v1 area, to keep the migration path exercised.
    if (rnd() < 0.08) {
      areas.push({ aid, name: `Old area ${i + 1}`, mode: "rect", L: num(10, 80), W: num(4, 40),
                   sqft: num(100, 3000), avgW: num(4, 40),
                   head: pick(["pgp4","pgp2","pgp15","mp2000","mp3000","spray15","cst","drip"]) });
      continue;
    }
    const family = pick(FAMILIES);
    const modeRoll = rnd();
    const a = { aid, name: `Area ${i + 1}`, family };
    if (usePlan) a.planRef = { pageId: "pg1" };

    // ---- shape ----
    if (modeRoll < 0.3) {
      a.mode = "rect"; a.L = num(8, 140); a.W = num(3, 60); a.sqft = Math.round(a.L * a.W); a.avgW = a.W;
    } else if (modeRoll < 0.45) {
      a.mode = "sqft"; a.sqft = num(80, 6000, 0); a.avgW = num(3, 50); a.L = Math.round(a.sqft / a.avgW); a.W = a.avgW;
    } else if (modeRoll < 0.55) {
      a.mode = "custom"; a.shapeKind = "sector";
      a.arc = { cx: ox + num(10, 40), cy: num(10, 40), r: num(6, 45), a0: num(0, 6, 2), sweep: num(20, 350, 0) };
      a.L = a.arc.r * 2; a.W = a.arc.r * 2; a.sqft = Math.round(Math.PI * a.arc.r ** 2); a.avgW = a.W;
    } else if (modeRoll < 0.65) {
      a.mode = "custom"; a.shapeKind = "circle";
      a.circle = { cx: ox + num(10, 40), cy: num(10, 40), r: num(4, 30) };
      a.L = a.circle.r * 2; a.W = a.L; a.sqft = Math.round(Math.PI * a.circle.r ** 2); a.avgW = a.W;
    } else if (modeRoll < 0.72) {
      // Custom mode with nothing drawn — must contribute nothing at all.
      a.mode = "custom"; a.L = 1; a.W = 1; a.sqft = 0; a.avgW = 1;
    } else {
      // A traced outline, sometimes concave so the arc rule has to work on
      // a real corner rather than a rectangle.
      a.mode = "custom"; a.shapeKind = "poly";
      const w = num(15, 120), h = num(8, 60);
      a.poly = rnd() < 0.4
        ? [{x:ox,y:0},{x:ox+w,y:0},{x:ox+w,y:h*0.5},{x:ox+w*0.45,y:h*0.5},{x:ox+w*0.45,y:h},{x:ox,y:h}]
        : [{x:ox,y:0},{x:ox+w,y:0},{x:ox+w,y:h},{x:ox,y:h}];
      a.L = w; a.W = h; a.sqft = Math.round(w * h); a.avgW = h;
    }
    ox += 160;

    // ---- family settings ----
    if (family === "rotor") a.rotorNoz = pick(ROTOR);
    if (family === "mp") a.mpNoz = pick(MP);
    if (family === "spray") { a.spraySeries = pick(SPRAY); a.sprayBody = pick(BODY); }
    if (family === "strip") { a.stripNoz = pick(STRIP); a.stripBody = pick(BODY); }
    if (family === "drip" || family === "trees") {
      a.dripProduct = pick(DRIPP);
      a.overagePct = pick([0, 5, 10, 15, 20]);
      if (family === "drip") { a.dripRowIn = pick([12, 15, 18, 24]); a.dripDir = pick(["auto","h","v"]); }
      if (rnd() < 0.5) {
        const n = int(1, 8);
        a.trees = Array.from({ length: n }, () => ({ x: num(0, 60), y: num(0, 40), type: rnd() < 0.5 ? "rws" : "ring", dia: pick([3,4,5,6]) }));
      } else if (family === "trees") {
        a.trees = Array.from({ length: int(1, 6) }, () => ({ x: num(0, 60), y: num(0, 40), type: rnd() < 0.5 ? "rws" : "ring", dia: pick([3,4,5,6]) }));
      } else a.trees = [];
      if (family === "drip" && groupNames.length && rnd() < 0.6) a.valveGroup = pick(groupNames);
    }

    // ---- hand-placed layout ----
    if ((family === "rotor" || family === "mp" || family === "spray") && rnd() < 0.45 && a.poly) {
      const n = int(1, 14);
      const nozzles = family === "rotor" ? ROTOR : family === "mp" ? MP : SPRAY;
      const handZone = rnd() < 0.3;
      a.layout = "manual";
      a.manualHeads = Array.from({ length: n }, (_, k) => {
        const h = { x: a.poly[0].x + num(1, Math.max(a.L - 1, 2)), y: num(1, Math.max(a.W - 1, 2)),
                    arc: rnd() < 0.35 ? int(30, 360) : pick([90, 180, 270, 360]),
                    dir: num(0, 6, 2), noz: pick(nozzles) };
        if (rnd() < 0.25) h.rPct = num(0.3, 1, 2);
        if (handZone && rnd() < 0.7) h.zone = int(0, 3);
        return h;
      });
    }
    areas.push(a);
  }

  // ---- routing: valve boxes and the occasional driveway split ----
  const routing = {};
  if (usePlan) {
    const man = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, m) => ({ id: `m_f${idx}_${m}`, x: num(0, 400), y: num(0, 80) }));
    const splits = {};
    areas.forEach((a) => {
      if (a.planRef && a.family !== "drip" && rnd() < 0.3) {
        const x = num(10, 120);
        splits[`z:${a.aid}:0`] = { ax: x, ay: -50, bx: x, by: 200 };
      }
    });
    routing.pg1 = { poc: { x: num(0, 200), y: num(0, 80) }, main: [], manifolds: man, pins: {}, splits, latSize: {}, laterals: {} };
  }

  const modes = {};
  groupNames.forEach((g) => { if (rnd() < 0.5) modes[g] = "station"; });

  return {
    version: 8,
    inputs: { availGPM: String(num(4, 60)), psi: String(int(40, 90)), supply: "municipal",
              ceiling: String(num(0.5, 30)), spacingFactor: pick(["1.0", "0.9", "0.8"]) },
    waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
    areas, valveGroupModes: modes, routing
  };
}

const rnd = mulberry32(SEED);
const designs = [];
for (let i = 0; i < N; i++) {
  const d = makeDesign(rnd, i);
  if (ONLY == null || ONLY === i) designs.push({ i, d });
}
if (ONLY != null && !designs.length) { console.error(`--only ${ONLY} is out of range (0..${N - 1})`); process.exit(2); }

// ── Serve both versions ──────────────────────────────────────────────
const parts = (() => { const p = JSON.parse(fs.readFileSync(path.join(ROOT, "parts.json"), "utf8")); return p.parts || p; })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-fuzz-"));
fs.writeFileSync(path.join(tmp, "prod.html"), execFileSync("git", ["show", `${REF}:server/sitebuilder.html`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const send = (f, t) => { res.writeHead(200, { "Content-Type": t + "; charset=utf-8" }); res.end(fs.readFileSync(f)); };
  if (p === "/prod") return send(path.join(tmp, "prod.html"), "text/html");
  if (p === "/pr") return send(path.join(ROOT, "server", "sitebuilder.html"), "text/html");
  if (p === "/admin/sitebuilder-engine.js") return send(path.join(ROOT, "server", "sitebuilder-engine.js"), "text/javascript");
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

/* c8 ignore start — runs in the browser */
function runBatch({ batch, parts }) {
  const out = [];
  for (const { i, d } of batch) {
    try {
      PARTS_MAP = parts;
      restoreState(JSON.parse(JSON.stringify(d)));
      compute();
      LAST_PLANS = areas.map((a) => ({ area: a, plan: plan(a) }));
      LAST_ZONES = computeZonePlan();
      const bom = buildBOM(PARTS_MAP);
      out.push({ i, ok: true, r: {
        stations: stationCount(), valves: LAST_ZONES.length, peak: peakStationGPM(),
        zones: LAST_ZONES.map((z) => ({ name: z.name, gpm: z.gpm, station: z.station, half: z.half || null,
                                        headCount: z.headCount, dripFt: z.dripFt, members: z.members, key: z.key })),
        areas: LAST_PLANS.map(({ area, plan: p }) => ({
          family: p.family, zones: p.zones, zoneGPM: p.zoneGPM, totalGPM: p.totalGPM, sqft: p.sqft,
          heads: (p.heads || []).map((h) => ({ x: h.xft, y: h.yft, arc: h.arc, gpm: h.gpm, r: h.r, zone: h.zone })),
          arcCount: p.arcCount || null, overZones: p.overZones || [], noShape: !!p.noShape,
          dripLengthFt: p.dripLengthFt ?? null, tubeFt: p.tubeFt ?? null, emitters: p.emitters ?? null,
          rwsUnits: p.rwsUnits ?? null, materialCents: areaMaterialCents(area, p)
        })),
        bom: { subtotalCents: bom.subtotalCents, lateralFt: bom.lateralFt, lateralBySize: bom.lateralBySize,
               lines: bom.lines.map((l) => ({ sku: l.sku, desc: l.desc, qty: l.qty, priceCents: l.priceCents })) }
      } });
    } catch (e) { out.push({ i, ok: false, err: String(e && e.message ? e.message : e) }); }
  }
  return out;
}
/* c8 ignore stop */

async function runAll(url) {
  const browser = await chromium.launch(chromiumLaunchOpts());
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("appReady === true", null, { timeout: 30000 });
    const out = [];
    for (let s = 0; s < designs.length; s += 25) {
      out.push(...await page.evaluate(runBatch, { batch: designs.slice(s, s + 25), parts }));
      process.stdout.write(`\r    ${Math.min(s + 25, designs.length)} / ${designs.length}   `);
    }
    process.stdout.write("\r" + " ".repeat(40) + "\r");
    return { out, errors };
  } finally { await browser.close(); }
}

console.log(`\nFuzzing the calculation engine — ${designs.length} random designs, seed ${SEED}`);
console.log(`PRODUCTION (${REF})  vs  PR (working tree)\n`);
let prod, pr;
try {
  console.log("  production…"); prod = await runAll(`http://127.0.0.1:${PORT}/prod`);
  console.log("  PR…");         pr   = await runAll(`http://127.0.0.1:${PORT}/pr`);
} finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

// ── Compare ──────────────────────────────────────────────────────────
let ok = true, matched = 0, threwBoth = 0;
const failures = [];
for (let k = 0; k < designs.length; k++) {
  const a = prod.out[k], b = pr.out[k];
  if (!a.ok || !b.ok) {
    // Both refusing the same way is the engines agreeing, not a pass to hide.
    if (a.ok === b.ok && a.err === b.err) { threwBoth++; continue; }
    ok = false;
    failures.push({ i: a.i, why: `production ${a.ok ? "computed" : "threw: " + a.err}, PR ${b.ok ? "computed" : "threw: " + b.err}`, diffs: [] });
    continue;
  }
  const diffs = classifyDiffs(diffSnapshots(JSON.parse(stableStringify(a.r)), JSON.parse(stableStringify(b.r)))).real;
  if (diffs.length) { ok = false; failures.push({ i: a.i, why: `${diffs.length} field(s) differ`, diffs }); }
  else matched++;
}

const totals = prod.out.filter((x) => x.ok).reduce((t, x) => ({
  stations: t.stations + x.r.stations, valves: t.valves + x.r.valves,
  heads: t.heads + x.r.areas.reduce((u, a) => u + a.heads.length, 0),
  cents: t.cents + x.r.bom.subtotalCents, lines: t.lines + x.r.bom.lines.length
}), { stations: 0, valves: 0, heads: 0, cents: 0, lines: 0 });

console.log("─".repeat(72));
console.log(`  designs compared                 ${designs.length}`);
console.log(`  identical on every field         ${matched}`);
if (threwBoth) console.log(`  both engines refused alike       ${threwBoth}`);
console.log(`  differing                        ${failures.length}`);
console.log(`  covered                          ${totals.stations} stations · ${totals.valves} valves · ${totals.heads} heads · ${totals.lines} BOM lines · $${(totals.cents / 100).toFixed(2)}`);
if (prod.errors.length || pr.errors.length) {
  console.log(`  page errors                      production ${prod.errors.length}, PR ${pr.errors.length}`);
  [...new Set([...prod.errors, ...pr.errors])].slice(0, 5).forEach((e) => console.log(`      ${e}`));
  ok = false;
}
console.log("─".repeat(72));
for (const f of failures.slice(0, 10)) {
  console.log(`\n  design #${f.i} — ${f.why}   (replay: --seed ${SEED} --designs ${N} --only ${f.i})`);
  for (const d of f.diffs.slice(0, 8)) {
    console.log(`      ${d.path}\n        production: ${JSON.stringify(d.expected)}\n        PR:         ${JSON.stringify(d.actual)}`);
  }
  const money = moneyFields(f.diffs);
  if (money.length) console.log(`      ${money.length} of them money`);
}
if (failures.length > 10) console.log(`\n  … and ${failures.length - 10} more`);
console.log(ok ? "\nPASS — the two engines are indistinguishable across every generated design.\n"
               : "\nFAIL — see above.\n");
process.exit(ok ? 0 : 1);

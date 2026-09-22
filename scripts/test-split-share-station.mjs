#!/usr/bin/env node
// scripts/test-split-share-station.mjs
//
// A split zone's two valves may share one controller station or have one
// each. That is now a stored decision. This proves the decision is stored,
// defaulted correctly, and — the part that matters — that supplying it to
// designs which never had it changes nothing about them.
//
//   npm run test:split-share-station
//
//   A. A VERSION-8 PROJECT OPENS UNCHANGED. The same version-8 design is
//      loaded into the builder as it stands on origin/main and into the
//      builder with this change, in one browser, and every figure a
//      version-8 job was sold and scheduled on is compared: stations,
//      proposal lines, controller selection, full-cycle run time, peak
//      flow, the mainline size printed on the sheets, and every BOM line.
//      Anything that moves is a job re-specified by opening it.
//
//   B. THE NEW DEFAULT IS THE OTHER WAY. A split drawn from now on is two
//      stations; a migrated one is one. Both directions asserted, because a
//      migration that preserved everything by never changing behaviour at
//      all would also pass A.
//
//   C. THE DECISION SURVIVES A ROUND TRIP, and a migrated design is marked
//      for review rather than silently believed.
//
//   D. THE MAINLINE DOES NOT SHRINK when a split is separated. Splitting a
//      zone lowers peak station flow, which lowers the suggested pipe size.
//      The size already specified is what the sheets must keep printing.
//
// No server, no project, no writes.

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { v8WithSplits } from "./fixtures/v8-split-designs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF = process.argv.includes("--ref") ? process.argv[process.argv.indexOf("--ref") + 1] : "origin/main";

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const fallback = "/opt/pw-browsers/chromium";
  if (fs.existsSync(fallback)) return { executablePath: fallback };
  return {};
}

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

const parts = (() => { const p = JSON.parse(fs.readFileSync(path.join(ROOT, "parts.json"), "utf8")); return p.parts || p; })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-split-"));
const showRef = (f) => execFileSync("git", ["show", `${REF}:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

// The page loads its maths from /admin/sitebuilder-engine.js and refuses to
// start without it. Each side must get ITS OWN engine — serving the working
// tree's engine to the reference page would compare this change against
// itself and pass no matter what it did — so the two versions get a server
// each rather than sharing one and fighting over that fixed path.
function serveBuilder(html, engine) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const send = (buf, t) => { res.writeHead(200, { "Content-Type": t + "; charset=utf-8" }); res.end(buf); };
    if (p === "/") return send(html, "text/html");
    if (p === "/admin/sitebuilder-engine.js") return send(engine, "text/javascript");
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
  return srv;
}
const beforeSrv = serveBuilder(showRef("server/sitebuilder.html"), showRef("server/sitebuilder-engine.js"));
const afterSrv = serveBuilder(fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html")),
                              fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js")));
await new Promise((r) => beforeSrv.listen(0, "127.0.0.1", r));
await new Promise((r) => afterSrv.listen(0, "127.0.0.1", r));
const BEFORE_URL = `http://127.0.0.1:${beforeSrv.address().port}/`;
const AFTER_URL = `http://127.0.0.1:${afterSrv.address().port}/`;

/** Runs INSIDE the page. Everything a version-8 job was sold on. */
/* c8 ignore start */
function harvest({ design, parts }) { return harvestInner(design, parts); }
/* eslint-disable no-undef */
function harvestInner(design, parts) {
  PARTS_MAP = parts;
  if (!restoreState(JSON.parse(JSON.stringify(design)))) throw new Error("restoreState refused the design");
  compute();
  LAST_ZONES = computeZonePlan();
  const bom = buildBOM(PARTS_MAP);
  const stations = stationZones();
  // The controller the summary recommends, and the one the BOM orders.
  const n = stationCount();
  const recommended = n <= 6 ? "6-station" : n <= 12 ? "12-station" : `${n}-station (HPC + PCM modules)`;
  const controllerSku = (bom.lines.find((l) => /^HC/.test(l.sku)) || {}).sku || null;
  let windowMin = 0; wcZones.forEach((z, i) => { windowMin += zoneMinutes(i); });
  return {
    stations: n,
    valves: LAST_ZONES.length,
    peakStationGPM: peakStationGPM(),
    recommendedController: recommended,
    controllerSku,
    fullCycleMinutes: windowMin,
    mainline: typeof mainlineSize === "function" ? mainlineSize() : pipeForGPM(peakStationGPM()),
    // {kind, label, description, price} — the real shape. An earlier version
    // of this read l.name/l.detail, which are not fields on a quote line, so
    // every entry was {undefined, undefined} and the comparison only ever
    // caught a change in the NUMBER of lines. Prices are included because a
    // proposal line that keeps its wording and changes its price is exactly
    // the kind of silent rewrite this test exists to catch.
    proposalLines: desiredQuoteLines().desired.map((l) => ({ kind: l.kind, label: l.label, description: l.description, price: l.price })),
    stationList: stations.map((s) => ({ station: s.station, name: s.name, gpm: s.gpm, valves: s.valves })),
    valveList: LAST_ZONES.map((z) => ({ name: z.name, station: z.station, half: z.half || null, gpm: z.gpm })),
    bom: bom.lines.map((l) => ({ sku: l.sku, qty: l.qty, priceCents: l.priceCents })),
    bomSubtotalCents: bom.subtotalCents,
    // Present only after the change; undefined before it.
    savedSplits: (() => {
      const blob = serializeState();
      const out = {};
      Object.entries((blob.routing || {}).pg1 ? blob.routing.pg1.splits || {} : {}).forEach(([k, v]) => {
        out[k] = { shareStation: v.shareStation, legacy: v.legacy };
      });
      return out;
    })(),
    savedVersion: serializeState().version,
    savedMainline: serializeState().mainlineSize ?? null
  };
}
/* c8 ignore stop */

/** Runs INSIDE the page. Opens the version-8 design, saves it the way
 *  "Save to project" would, re-opens THAT blob, then separates one split in
 *  it and re-opens again. Using the app's own saved output rather than a
 *  hand-written version-9 fixture is the point: a fixture I wrote could
 *  differ from what the app really writes, and then the round trip would be
 *  tested against my assumption instead of against the app. */
/* c8 ignore start */
function roundTrip({ design, parts, splitKey }) {
  const first = harvestInner(design, parts);
  const migrated = serializeState();               // what Save to project would send
  const reopened = harvestInner(migrated, parts);
  const separated = JSON.parse(JSON.stringify(migrated));
  const sp = separated.routing.pg1.splits[splitKey];
  sp.shareStation = false;
  delete sp.legacy;
  const afterSeparate = harvestInner(separated, parts);
  return { first, migrated, reopened, afterSeparate };
}
/* c8 ignore stop */

async function open(url, fn, arg) {
  const browser = await chromium.launch(chromiumLaunchOpts());
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("appReady === true", null, { timeout: 30000 });
    // harvestInner is referenced by both evaluated functions, so it has to
    // exist in the page before either runs.
    await page.evaluate(`window.harvestInner = ${harvestInner.toString()}`);
    return { out: await page.evaluate(fn, arg), errors };
  } finally { await browser.close(); }
}

let before, after;
try {
  before = await open(BEFORE_URL, harvest, { design: v8WithSplits, parts });
  after = await open(AFTER_URL, roundTrip, { design: v8WithSplits, parts, splitKey: "z:a_front:0" });
} finally { beforeSrv.close(); afterSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

const B = before.out;
const A = after.out.first;
const M = after.out.reopened;
const S = after.out.afterSeparate;

// ── A. A version-8 project opens unchanged ───────────────────────────
console.log(`\nA. A version-8 design with three splits, opened before and after the change`);
console.log(`   (${REF} vs the working tree, same browser)\n`);
const same = (label, key, fmt = (v) => JSON.stringify(v)) =>
  check(`${label} is unchanged`, JSON.stringify(B[key]) === JSON.stringify(A[key]),
        `was ${fmt(B[key])}, now ${fmt(A[key])}`);

same("controller station count", "stations");
same("valve count", "valves");
same("peak station GPM", "peakStationGPM");
same("recommended controller", "recommendedController");
same("controller part ordered", "controllerSku");
same("full-cycle run time", "fullCycleMinutes");
same("mainline size on the sheets", "mainline");
same("the station list", "stationList", (v) => `${(v || []).length} stations`);
same("the valve list", "valveList", (v) => `${(v || []).length} valves`);
same("every proposal line", "proposalLines", (v) => `${(v || []).length} lines`);
same("every BOM line and quantity", "bom", (v) => `${(v || []).length} lines`);
same("the BOM total", "bomSubtotalCents", (c) => "$" + (c / 100).toFixed(2));

// ── B. The new default is the other way ──────────────────────────────
console.log(`\nB. The default for a split drawn from now on`);
check("a migrated version-8 split shares one station",
      A.valveList.filter((v) => v.half).every((v) => {
        const twin = A.valveList.find((x) => x.name === v.name.replace(/ · [AB]$/, "") + " · " + (v.half === "A" ? "B" : "A"));
        return twin && twin.station === v.station;
      }), "some migrated split landed on two stations");
check("separating one split adds exactly one station",
      S.stations === M.stations + 1, `${M.stations} -> ${S.stations}`);
check("separating a split does NOT change the valve count",
      S.valves === M.valves, `${M.valves} vs ${S.valves}`);
check("the separated halves are on different stations",
      (() => { const a = S.valveList.find((v) => v.name === "Front lawn · A"), b = S.valveList.find((v) => v.name === "Front lawn · B");
               return a && b && a.station !== b.station; })(), "Front lawn A/B still share");
check("the splits left alone still share",
      (() => { const a = S.valveList.find((v) => v.name === "Boulevard trees · A"), b = S.valveList.find((v) => v.name === "Boulevard trees · B");
               return a && b && a.station === b.station; })(), "Boulevard trees A/B were separated too");
check("separating a split adds a proposal line",
      S.proposalLines.length === M.proposalLines.length + 1, `${M.proposalLines.length} -> ${S.proposalLines.length}`);

// ── C. The decision survives a round trip, and is flagged ────────────
console.log(`\nC. What gets saved back`);
check("the design saves as version 9", A.savedVersion === 9, String(A.savedVersion));
check("every migrated split saves shareStation:true",
      Object.values(A.savedSplits).length === 3 && Object.values(A.savedSplits).every((s) => s.shareStation === true),
      JSON.stringify(A.savedSplits));
check("every migrated split is marked for review",
      Object.values(A.savedSplits).every((s) => s.legacy === true), JSON.stringify(A.savedSplits));
check("a re-opened version-9 design keeps its stations",
      M.stations === A.stations, `${A.stations} then ${M.stations}`);
check("a deliberately separated split is no longer marked legacy",
      S.savedSplits["z:a_front:0"].shareStation === false && !S.savedSplits["z:a_front:0"].legacy,
      JSON.stringify(S.savedSplits["z:a_front:0"]));

// ── D. The mainline does not shrink ──────────────────────────────────
console.log(`\nD. The pipe already in the ground`);
console.log(`     peak station before separating: ${A.peakStationGPM.toFixed(1)} GPM -> ${A.mainline}`);
console.log(`     peak station after  separating: ${S.peakStationGPM.toFixed(1)} GPM -> suggestion would be ${S.mainline === A.mainline ? "smaller, but the pin holds" : S.mainline}`);
console.log(`     stations: ${A.stationList.map((x) => x.name + " " + x.gpm.toFixed(1)).join(" · ")}`);
check("a version-8 design pins the mainline it has always printed",
      A.savedMainline === B.mainline, `pinned ${A.savedMainline}, was printing ${B.mainline}`);
check("separating a split does not change the printed mainline",
      S.mainline === A.mainline, `${A.mainline} -> ${S.mainline}`);
check("...even though the flow calculation now suggests smaller",
      S.peakStationGPM < A.peakStationGPM,
      `peak ${A.peakStationGPM.toFixed(1)} -> ${S.peakStationGPM.toFixed(1)} GPM; if this is not lower the test is not testing anything`);

// ── E. What Patrick actually sees ────────────────────────────────────
console.log(`\nE. The notice on screen`);
{
  const browser = await chromium.launch(chromiumLaunchOpts());
  const srv = serveBuilder(fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html")),
                           fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js")));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e.message)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: "load" });
    await page.waitForFunction("appReady === true", null, { timeout: 30000 });
    const seen = await page.evaluate((d) => {
      PARTS_MAP = {}; restoreState(JSON.parse(JSON.stringify(d))); compute();
      const note = document.getElementById("grandNote").innerText;
      // Answer the question on one valve, the way the toggle does.
      const zi = LAST_ZONES.findIndex((z) => z.half === "A" && /Front lawn/.test(z.name));
      const before = stationCount();
      mpSetShareStation(zi, false);
      return { note, before, after: stationCount(),
               noteAfter: document.getElementById("grandNote").innerText,
               legacyAfter: [...new Set(LAST_ZONES.filter((z) => z.half && z.legacyShare).map((z) => z.name.replace(/ · [AB]$/, "")))] };
    }, v8WithSplits);
    check("the summary says the assignment is legacy and needs review",
          /Legacy shared-station assignment - review required/i.test(seen.note), seen.note.slice(0, 120));
    check("it names the zones involved", /Front lawn/.test(seen.note) && /Boulevard trees/.test(seen.note));
    check("it says nothing about the job has changed", /nothing about this job has changed/i.test(seen.note));
    check("it reports the pinned mainline", /Mainline pinned to/i.test(seen.note), seen.note.slice(-160));
    check("the toggle gives the pair its own stations", seen.after === seen.before + 1,
          `${seen.before} -> ${seen.after}`);
    // Asserted on the engine's own list rather than on scraped screen text:
    // a substring search over innerText passes or fails for reasons that
    // have nothing to do with the rule under test.
    check("answering one zone drops it from the review list",
          !seen.legacyAfter.includes("Front lawn"), seen.legacyAfter.join(", "));
    check("the zones not yet answered stay on the review list",
          seen.legacyAfter.includes("Boulevard trees") && seen.legacyAfter.includes("Back lawn"),
          seen.legacyAfter.join(", ") || "(none)");
    check("no page errors", errs.length === 0, errs.join("; "));
  } finally { await browser.close(); srv.close(); }
}

// ── F. An accepted proposal is not rewritten ─────────────────────────
//
// Dundalk's split will be changed AFTER its proposal was accepted. Saving
// the design re-syncs a linked quote, so the question is whether that sync
// can touch an accepted one. The guard exists in syncQuoteFromDesign(); this
// runs it rather than reading it, for a draft and for an accepted quote.
console.log(`\nF. Saving a design against a linked quote`);
{
  const browser = await chromium.launch(chromiumLaunchOpts());
  for (const status of ["draft", "accepted"]) {
    const writes = [];
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (req.method !== "GET") writes.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/after") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"))); }
      if (u.pathname === "/admin/sitebuilder-engine.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js"))); }
      if (u.pathname === "/api/admin/quote-folder") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, quotes: [{ id: "Q-2026-0088", status, lineItems: [] }] }));
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, quote: { id: "Q-2026-0088", total: 0 } }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${srv.address().port}/after`, { waitUntil: "load" });
      await page.waitForFunction("appReady === true", null, { timeout: 30000 });
      const r = await page.evaluate(async (d) => {
        PARTS_MAP = {}; restoreState(JSON.parse(JSON.stringify(d))); compute();
        linkedProject = { id: "PROJ-TEST", customerEmail: "", propertyId: null };
        linkedQuoteId = "Q-2026-0088";
        return await syncQuoteFromDesign();
      }, v8WithSplits);
      const patched = writes.some((w) => /PATCH .*\/proposal/.test(w));
      if (status === "draft") {
        check("a DRAFT linked quote is re-synced on save", r.action === "updated" && patched,
              `action=${r.action}, writes=${writes.join(", ") || "none"}`);
      } else {
        check("an ACCEPTED linked quote is left alone", r.action === "locked" && !patched,
              `action=${r.action}, writes=${writes.join(", ") || "none"}`);
        check("...and the builder says so rather than failing silently", r.status === "accepted", String(r.status));
      }
    } finally { srv.close(); }
  }
  await browser.close();
}

for (const [label, r] of [["before", before], ["after", after]]) {
  if (r.errors.length) { failures.push(`${label} page errors: ${r.errors.join("; ")}`); console.error(`  FAIL ${label} page errors:\n    ` + r.errors.join("\n    ")); }
}

console.log(`\nsplit share-station: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

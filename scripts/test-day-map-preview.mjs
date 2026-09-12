#!/usr/bin/env node
// scripts/test-day-map-preview.mjs
//
// Patrick, 2026-09-12, on the "Best: Oct 6 · +4 min" line under a
// property that wasn't on the plan: "honestly, that's literally no help
// either. Can you do something that allows me to see the map of what
// the day would look like with the appointment incorporated, and I
// choose whether or not I want to add it to that day?"
//
// A number is not a route. This pins the preview: the route day built
// WITH the candidate through the board's own day builder, the two
// figures that change read off it, the road line through the day as it
// would be — and the decision left to him, on a separate button that is
// the only write.
//
// Run: node scripts/test-day-map-preview.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const dayPreview = require(path.join(ROOT, "server", "lib", "day-preview.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 240) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};
// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const lib = (name) => (typeof dayPreview[name] === "function"
  ? dayPreview[name]
  : () => ({ missing: `(${name} is missing)` }));

// ---- 1. The day as it would be ----------------------------------------
{
  const stored = {
    label: "Newmarket", territory: "N", morning: ["A1", "A2"], afternoon: ["P1"],
    constraints: { A1: { notBefore: "10:00" } }, manualOrder: true
  };
  const day = lib("planDayWithCandidate")(stored, "NEW1", "afternoon");
  ok("the candidate joins the asked-for bucket", Array.isArray(day.afternoon) && day.afternoon.includes("NEW1"), j(day));
  ok("…at the end of it, after the day's own stops", day.afternoon && day.afternoon[day.afternoon.length - 1] === "NEW1", j(day.afternoon));
  ok("the other bucket is untouched", j(day.morning) === j(["A1", "A2"]), j(day.morning));
  ok("the label, windows and manual order ride along",
    day.label === "Newmarket" && day.constraints?.A1?.notBefore === "10:00" && day.manualOrder === true, j(day));
  ok("the stored day itself is not mutated", stored.afternoon.length === 1, j(stored.afternoon));
  const am = lib("planDayWithCandidate")(stored, "NEW1", "morning");
  ok("morning means morning", am.morning?.includes("NEW1") && !am.afternoon?.includes("NEW1"), j(am));
  const twice = lib("planDayWithCandidate")(stored, "A2", "afternoon");
  ok("a code already on the day is not added twice",
    twice.morning?.filter((c) => c === "A2").length === 1 && !twice.afternoon?.includes("A2"), j(twice));
  const fresh = lib("planDayWithCandidate")(null, "NEW1", "morning");
  ok("no stored day → a fresh day holding just the candidate",
    fresh.morning?.length === 1 && fresh.morning[0] === "NEW1" && fresh.afternoon?.length === 0, j(fresh));
  const odd = lib("planDayWithCandidate")(stored, "NEW1", "lunch");
  ok("an unknown bucket lands in the afternoon rather than nowhere", odd.afternoon?.includes("NEW1"), j(odd));
  const blank = lib("planDayWithCandidate")(stored, "", "morning");
  ok("no code → the day unchanged", j(blank.morning) === j(stored.morning) && j(blank.afternoon) === j(stored.afternoon), j(blank));
}

// ---- 2. The figures that decide it --------------------------------------
{
  const before = { counts: { total: 3 }, driveMinutes: 70, homeAt: "15:40", morningEndsAt: "11:50", flags: [], booked: [{ id: "b" }] };
  const after = { counts: { total: 4 }, driveMinutes: 84, homeAt: "16:20", morningEndsAt: "12:10",
    flags: [{ code: "morning_overruns", message: "Morning runs past noon" }], booked: [{ id: "b" }] };
  const b = lib("daySummary")(before), a = lib("daySummary")(after);
  ok("a summary counts plan stops AND booked ones as the one total", b?.stops === 4 && a?.stops === 5, j({ b, a }));
  ok("…and carries drive and home time", b?.driveMinutes === 70 && a?.homeAt === "16:20", j({ b, a }));
  ok("…and the day's flags, in words", a?.flags?.[0] === "Morning runs past noon", j(a?.flags));
  ok("the delta is the minutes the day grows by", lib("driveDelta")(b, a) === 14, j(lib("driveDelta")(b, a)));
  ok("no drive figure on one side → null, not zero",
    lib("driveDelta")(lib("daySummary")({ counts: { total: 0 }, driveMinutes: null }), a) === null,
    j(lib("driveDelta")(lib("daySummary")({ counts: { total: 0 }, driveMinutes: null }), a)));
  ok("a missing day summarises to null, not a crash", lib("daySummary")(null) === null, j(lib("daySummary")(null)));
}

// ---- 3. The line follows the numbers ------------------------------------
{
  const day = {
    morning: [{ code: "A1", coords: { lat: 44.05, lng: -79.46 } }, { code: "A2", coords: null }],
    afternoon: [{ code: "NEW1", coords: { lat: 44.07, lng: -79.40 }, candidate: true }],
    booked: [{ mapCode: "__bk:7", coords: { lat: 44.06, lng: -79.45 } }],
    timeline: [
      { propertyCode: "A1", stopNumber: 1 }, { propertyCode: "__bk:7", stopNumber: 2 },
      { propertyCode: "A2", stopNumber: 3 }, { propertyCode: "NEW1", stopNumber: 4 }
    ]
  };
  const answer = lib("planLineStops")(day);
  const stops = Array.isArray(answer) ? answer : [];   // absent → every assertion reports, none crashes
  ok("stops come out in TIMELINE order, plan and booked together",
    Array.isArray(answer) && stops.map((s) => s.number).join(",") === "1,2,4", j(answer));
  ok("a booked stop is found by its mapCode", stops[1]?.coords?.lat === 44.06, j(stops[1]));
  ok("a stop with no coordinates keeps its number but is not drawn", !stops.some((s) => s.number === 3), j(stops));
  ok("the candidate is on the line", stops.some((s) => s.number === 4 && s.coords.lng === -79.40), j(stops));
  ok("an empty day draws nothing and throws nothing", j(lib("planLineStops")(null)) === "[]", j(lib("planLineStops")(null)));
}

// ---- 4. The server: one day builder, one read-only route ----------------
{
  const src = read("server/server.js");
  ok("the board's day builder is one named function",
    (src.match(/async function resolvePlanDay\(/g) || []).length === 1, "resolvePlanDay defined 0 or 2+ times");
  const board = src.slice(src.indexOf("async function resolveSeasonPlan("), src.indexOf("async function resolveSeasonPlan(") + 6000);
  ok("…the board builds every day through it",
    (board.match(/await resolvePlanDay\(/g) || []).length >= 2, "resolveSeasonPlan builds days some other way");

  const start = src.indexOf("seasonPlanPreviewMatch = pathname.match(");
  const block = start >= 0 ? src.slice(start, src.indexOf("// Place — put unplanned properties", start)) : "";
  ok("GET /api/season-plans/:season/:year/preview/:date exists",
    /\/preview\\\/\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\$\//.test(block) && /req\.method === "GET"/.test(block), "no preview route");
  ok("…behind a login", /await requireUser\(req\)/.test(block), "the preview is open to anyone");
  ok("…and it builds BOTH days through the board's own builder",
    (block.match(/await resolvePlanDay\(/g) || []).length === 2, "the preview has its own day builder");
  ok("…the hypothetical day comes from planDayWithCandidate", /dayPreview\.planDayWithCandidate\(/.test(block), "the day is built some other way");
  ok("…it WRITES NOTHING", !/addStop\(|savePlan\(|moveStop\(/.test(block), "the preview writes to the plan");
  ok("…a code already on the plan is refused, not doubled", /plannedCodes\(plan\)\.has\(code\)/.test(block) && /409/.test(block), "no already-planned guard");
  ok("…a pin Google can't place is said, not hidden", /coordsAreResolved\(coords\)/.test(block) && /"unresolved"/.test(block), "no unresolved guard");
  ok("…the candidate stop is flagged for the map", /stop\.candidate = true/.test(block), "the candidate is not marked");
  ok("…the line is drawn through the day as it would be",
    /routeGeometry\.roadLine\(origin, dayPreview\.planLineStops\(after\)\)/.test(block), "the line is not the preview day's");
  ok("…and the answer carries before, after and the delta",
    /before: beforeSummary/.test(block) && /after: afterSummary/.test(block) && /addedDriveMinutes: dayPreview\.driveDelta\(/.test(block), "summary missing");
}

// ---- 5. The page: see it, then decide -----------------------------------
{
  const html = read("server/season-plan.html");
  const js = read("server/season-plan.js");
  ok("the preview dialog is on the page",
    /id="previewModal"/.test(html) && /id="previewMap"/.test(html) && /id="previewDay"/.test(html) && /id="previewBucket"/.test(html), "dialog markup missing");
  ok("…with the decision as two buttons: not this day / add",
    /id="previewCancel"[^>]*>Not this day</.test(html) && /id="previewAdd"[^>]*disabled>/.test(html), "buttons missing or Add enabled before a day is drawn");
  ok("a row's button opens the best day's map, not a blind placement",
    /See it on the best day/.test(js) && /openPreview\(row, date, null\)/.test(js), "no See-on-map button");
  ok("…and the old blind 'Place on best day' per-row button is gone", !/"Place on best day"/.test(js), "per-row blind placement still there");
  ok("the day picker opens the preview for the chosen day instead of adding",
    /Look at a day…/.test(js) && /openPreview\(row, toDate, toBucket\)/.test(js), "picker still adds directly");
  ok("the ONE write is addToDay, through /add",
    (js.match(/\$\{base\(\)\}\/add`/g) || []).length === 1 && /async function addToDay\(/.test(js), "more than one add path");
  ok("…and after adding, the board jumps to that day with the stop lit",
    /selectDay\(toDate, \{ flashCode: code \}\)/.test(js), "no jump to the day");
  ok("the map drawer takes a ready-made line for a day that isn't stored",
    /async function drawDayMap\(mapBox, listRoot, day, \{ line = null \} = \{\}\)/.test(js) && /if \(line\) \{\s*paintLine\(map, mapBox, line\);/.test(js), "drawDayMap can't draw a preview line");
  ok("…the line painter is one function shared with the stored day", (js.match(/function paintLine\(/g) || []).length === 1 && /paintLine\(map, mapBox, data\)/.test(js), "two line painters");
  ok("the candidate pin is lit like a hovered stop", /const lit = Boolean\(hot \|\| \(stop && stop\.candidate\)\)/.test(js), "candidate not lit");
  ok("…and mappableStops carries the flag to it", /candidate: found\.stop\.candidate === true/.test(js), "flag dropped on the way to the map");
  ok("the preview asks the server, never draws its own arithmetic",
    /\$\{base\(\)\}\/preview\/\$\{date\}\?\$\{q\}/.test(js), "no preview fetch");
  ok("a stale answer for a day he moved on from is dropped", /if \(seq !== previewSeq\) return;/.test(js), "no request sequencing");
  ok("the drive change reads as before → after (+delta)", /Driving: \$\{b\.driveMinutes != null/.test(js), "no drive chip");
}

// ---- 6. On a booted server: the route is live and gated ----------------
{
  const port = 8340 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/booking/services`);
      booted = r.ok;
    } catch { /* not yet */ }
  }
  ok("the server boots", booted, "no response from /api/booking/services");
  if (booted) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/season-plans/fall/2026/preview/2026-10-06?code=X1`);
      ok("the preview route answers, and asks for a login first", r.status === 401, `status ${r.status}`);
    } catch (err) {
      failures.push(`boot probe threw — ${err.message}`);
    }
  }
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
}

if (failures.length) {
  console.error(`\n✗ test-day-map-preview: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-day-map-preview: ${pass} assertions passed`);

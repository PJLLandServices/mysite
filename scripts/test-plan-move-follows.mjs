#!/usr/bin/env node
// scripts/test-plan-move-follows.mjs
//
// Patrick, 2026-09-12, after moving "A BUNCH" of stops with "Move to…":
// "tell me though is this automatically saving and keeping these dates
// now??" The plan file saved; the appointments did not move. A whole-day
// move had always carried its bookings along (moveDayBookings); a single
// stop's move touched the stored plan only.
//
// This pins followPlanMoves — the single-stop counterpart, by the same
// rules — the /move route calling it, the follow-plan routes for the
// moves already made, and the screen saying what happened.
//
// Run: node scripts/test-plan-move-follows.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const assignments = require(path.join(ROOT, "server", "lib", "assignments.js"));

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
const follow = async (...a) => {
  if (typeof assignments.followPlanMoves !== "function") return { missing: "(followPlanMoves is missing)" };
  try { return await assignments.followPlanMoves(...a); } catch (err) { return { error: err.message }; }
};

const at = (date, h) => new Date(`${date}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const props = [
  { id: "p1", code: "A1", customerName: "Alfie", coords: { lat: 44.05, lng: -79.46 }, system: { zones: [1, 2] } },
  { id: "p2", code: "A2", customerName: "Bravo", coords: { lat: 44.06, lng: -79.47 }, system: { zones: [1, 2] } },
  { id: "p3", code: "A3", customerName: "Charlie", coords: { lat: 44.07, lng: -79.48 }, system: { zones: [1, 2] } },
  { id: "p4", code: "A4", customerName: "Delta", coords: { lat: 44.08, lng: -79.49 }, system: { zones: [1, 2] } }
];
const asg = (id, propertyId, code, date, bucket, over = {}) => ({
  id, source: "assignment", status: "confirmed", propertyId, durationMinutes: 45,
  scheduledFor: at(date, bucket === "morning" ? 9 : 13),
  assignment: { season: "fall", year: 2026, date, bucket, code, outreach: {} },
  ...over
});
// A trivial sequencer: arrivals in list order, 30 min apart from 08:00.
const seq = async (day) => {
  const codes = [...(day.morning || []), ...(day.afternoon || [])];
  return { timeline: codes.map((c, i) => ({ propertyCode: c, stopNumber: i + 1, arriveAt: `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}` })) };
};
function harness(plan, rows) {
  const moves = [];
  return {
    moves,
    deps: {
      getPlan: async () => plan,
      listProperties: async () => props,
      listBookings: async () => rows,
      sequenceDay: seq,
      moveAssignmentDay: async (id, opts) => { moves.push({ id, ...opts }); return { id }; }
    }
  };
}

// ---- 1. A stop moved in the plan pulls its booking along ------------------
{
  // Patrick moved A1 from the 6th (morning) to the 9th (afternoon). A2 is
  // where it always was. A3 the CUSTOMER moved to the 14th themselves.
  // A4's stop moved bucket only, on the same day.
  const plan = { days: {
    "2026-10-06": { morning: ["A2"], afternoon: ["A4", "A3"] },
    "2026-10-09": { morning: [], afternoon: ["A1"] },
    "2026-10-14": { morning: [], afternoon: [] }
  } };
  const rows = [
    asg("BK-1", "p1", "A1", "2026-10-06", "morning", { assignment: { season: "fall", year: 2026, date: "2026-10-06", bucket: "morning", code: "A1", outreach: { steps: { "1": { at: "x" } }, respondedAt: "2026-09-11T10:00:00Z", responseVia: "page" } } }),
    asg("BK-2", "p2", "A2", "2026-10-06", "morning"),
    asg("BK-3", "p3", "A3", "2026-10-06", "afternoon", { scheduledFor: at("2026-10-14", 13), rescheduleCount: 1 }),
    asg("BK-4", "p4", "A4", "2026-10-06", "morning")
  ];
  const h = harness(plan, rows);
  const r = await follow("fall", 2026, { actor: "patrick" }, h.deps);
  ok("the run answers", r && r.ok === true, j(r));
  ok("A1's booking is moved to the 9th, afternoon",
    h.moves.some((m) => m.id === "BK-1" && m.toDate === "2026-10-09" && m.toBucket === "afternoon"), j(h.moves));
  const m1 = h.moves.find((m) => m.id === "BK-1");
  ok("…re-timed inside the afternoon on the new day",
    m1 && /^2026-10-09T/.test(new Date(m1.scheduledFor).toLocaleString("sv-SE").replace(" ", "T")) && new Date(m1.scheduledFor).getHours() >= 12, j(m1?.scheduledFor));
  ok("…remembering where it came from", m1 && m1.oldDate === "2026-10-06", j(m1));
  ok("…with the customer told (they had the blast) and their old answer reset",
    m1 && m1.queueNotice === true && m1.resetResponse === true, j(m1));
  ok("…by the actor who moved the stop", m1 && m1.by === "patrick", j(m1));
  ok("A2 stays: it is where its booking is", !h.moves.some((m) => m.id === "BK-2"), j(h.moves));
  ok("A3 stays: the CUSTOMER moved it and that is theirs to keep", !h.moves.some((m) => m.id === "BK-3"), j(h.moves));
  const m4 = h.moves.find((m) => m.id === "BK-4");
  ok("A4's half-day change is a move too — same day, new half", m4 && m4.toDate === "2026-10-06" && m4.toBucket === "afternoon", j(m4));
  ok("…and a customer never messaged gets no notice", m4 && m4.queueNotice === false, j(m4));
  ok("the summary counts it all", r.moved === 2 && r.noticesQueued === 1 && r.responsesReset === 1 && r.checked === 4, j(r));
  ok("…and lists each row with from → to for the screen",
    r.rows?.some((x) => x.code === "A1" && x.from?.date === "2026-10-06" && x.to?.date === "2026-10-09" && x.notice === true), j(r.rows));
}

// ---- 2. Limits: codes, dry run, flexible, nothing to do -------------------
{
  const plan = { days: { "2026-10-06": { morning: ["A2"], afternoon: [] }, "2026-10-09": { morning: ["A1", "A4"], afternoon: [] } } };
  const rows = [
    asg("BK-1", "p1", "A1", "2026-10-06", "morning"),
    asg("BK-2", "p2", "A2", "2026-10-06", "morning"),
    asg("BK-4", "p4", "A4", "2026-10-06", "morning", { flexBucket: { at: "x", by: "customer" }, assignment: { season: "fall", year: 2026, date: "2026-10-06", bucket: "morning", code: "A4", outreach: { steps: { "1": {} }, respondedAt: "y" } } })
  ];
  let h = harness(plan, rows);
  const only = await follow("fall", 2026, { codes: ["A4"] }, h.deps);
  ok("`codes` limits the run to the stops just moved", only.moved === 1 && h.moves.length === 1 && h.moves[0].id === "BK-4", j({ only, moves: h.moves }));
  ok("a free-bucket customer moves without a notice or a reset (they said 'whenever')",
    h.moves[0]?.queueNotice === false && h.moves[0]?.resetResponse === false && only.flexibleMoved === 1, j(h.moves[0]));

  h = harness(plan, rows);
  const dry = await follow("fall", 2026, { dryRun: true }, h.deps);
  ok("a dry run lists both stragglers and moves nothing", dry.rows?.length === 2 && dry.moved === 0 && h.moves.length === 0, j({ dry, moves: h.moves }));

  h = harness({ days: { "2026-10-06": { morning: ["A2"], afternoon: [] } } }, rows.slice(1, 2));
  const none = await follow("fall", 2026, {}, h.deps);
  ok("plan and bookings agreeing → nothing moves, nothing listed", none.moved === 0 && none.rows?.length === 0 && none.checked === 1, j(none));
  const noPlan = await follow("fall", 2026, {}, { ...h.deps, getPlan: async () => null });
  ok("no plan → an empty answer, not a crash", noPlan.ok === true && noPlan.checked === 0, j(noPlan));
  const cancelled = harness(plan, [asg("BK-1", "p1", "A1", "2026-10-06", "morning", { status: "cancelled" })]);
  const c = await follow("fall", 2026, {}, cancelled.deps);
  ok("a cancelled assignment is not dragged anywhere", c.moved === 0 && cancelled.moves.length === 0, j(c));
}

// ---- 3. The record keeps the half-day ---------------------------------------
{
  const src = read("server/lib/bookings.js");
  ok("moveAssignmentDay takes the half-day too", /toBucket = null/.test(src) && /assignment: \{ \.\.\.current\.assignment, date: toDate, bucket, outreach \}/.test(src), "the half-day is dropped on a move");
}

// ---- 4. The routes ---------------------------------------------------------
{
  const src = read("server/server.js");
  const move = src.slice(src.indexOf("seasonPlanMoveMatch = pathname.match("), src.indexOf("seasonPlanMoveMatch = pathname.match(") + 2200);
  ok("a single-stop move carries its booking along", /assignments\.followPlanMoves\(season, year, \{\s*codes: \[moved\.propertyCode\]/.test(move), "/move still moves the plan only");
  ok("…and says what it did", /follow \}\);/.test(move), "the follow result is not returned");
  ok("GET/POST /follow-plan exist for the moves already made",
    /seasonPlanFollowMatch = pathname\.match\(\/\^\\\/api\\\/season-plans\\\/\(spring\|fall\)\\\/\(\\d\{4\}\)\\\/follow-plan\$\/\)/.test(src)
      && /dryRun: req\.method === "GET"/.test(src), "no follow-plan route");
  ok("the board reports the stragglers", /planMoves = \(await assignments\.followPlanMoves\(season, year, \{ dryRun: true \}\)\)\.rows;/.test(src) && /\n\s+planMoves,\n/.test(src), "the board doesn't know");
}

// ---- 5. The screen says what happened ---------------------------------------
{
  const page = read("server/season-plan.js");
  const html = read("server/season-plan.html");
  ok("the move toast says what happened to the appointment", /followWords\(data\.follow\)/.test(page) && /Appointment moved with it/.test(page), "toast still says only 'moved'");
  ok("…including when it could NOT be moved", /could NOT be moved/.test(page), "a failed ride-along is silent");
  ok("…and when the customer had moved it themselves", /already moved their own appointment/.test(page), "customer moves not explained");
  ok("the banner lists the stragglers with one button", /id="followPlanBar"/.test(html) && /id="followPlanBtn"/.test(html) && /renderFollowBar\(plan\)/.test(page), "no banner");
  ok("…armed twice like every send on this page", /armTwice\(followBtn, "Press again to MOVE them"/.test(page), "one press moves appointments");
  ok("…posting to /follow-plan", /\$\{base\(\)\}\/follow-plan`, \{ method: "POST" \}/.test(page), "the button calls something else");
}

if (failures.length) {
  console.error(`\n✗ test-plan-move-follows: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-plan-move-follows: ${pass} assertions passed`);

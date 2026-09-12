#!/usr/bin/env node
// scripts/test-plan-follows-bookings.mjs
//
// Patrick, 2026-09-12, the morning after the blast: "there's some
// appointments that were cancelled when we sent out the appointments this
// morning. They are not reflecting on the map. Also there are properties
// that we don't go to, they are still on the route. Can this route not be
// updating like it was supposed to be?"
//
// The plan is a stored list of codes per day; once Assign has run, the
// BOOKING is the truth. Nothing ever took a cancelled or moved stop off
// the stored plan, and every reader drew the stored codes as the route.
// This pins the one derived rule (planStopState), the driven plan every
// reader now holds (drivenPlan), and that each reader actually holds it.
//
// CLAUDE.md, "finish the workflow, not the write": find every reader,
// define the rule once, walk the workflow, pin it with a test that fails
// on the old code.
//
// Run: node scripts/test-plan-follows-bookings.mjs  (also in build:check)

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
// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const lib = (name) => (typeof assignments[name] === "function"
  ? assignments[name]
  : () => ({ missing: `(${name} is missing)` }));

const at = (date, h) => new Date(`${date}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const assigned = (over) => ({
  id: "BK-1", source: "assignment", status: "confirmed", propertyId: "p1",
  scheduledFor: at("2026-10-06", 9), assignment: { season: "fall", year: 2026, date: "2026-10-06", bucket: "morning", code: "A1" },
  ...over
});
const ctx = { date: "2026-10-06", season: "fall", year: 2026 };
const state = (rows, over = {}) => lib("planStopState")({ ...ctx, bookingsForProperty: rows, ...over });

// ---- 1. The rule: one stop on one day, judged by its bookings -----------
{
  ok("no bookings at all → unassigned (the plan is still the intent)", state([]).state === "unassigned", j(state([])));
  ok("a confirmed assignment ON the day → on_day", state([assigned()]).state === "on_day", j(state([assigned()])));
  const c = state([assigned({ status: "cancelled", cancelledAt: "2026-09-12T13:00:00Z", cancellationReason: "Already done — another company came", removalCode: "already_done" })]);
  ok("a CANCELLED assignment → cancelled, with the customer's reason",
    c.state === "cancelled" && /another company/.test(c.reason || "") && c.reasonCode === "already_done" && c.bookingId === "BK-1", j(c));
  const ns = state([assigned({ status: "no_show", cancelledAt: "2026-10-06T14:00:00Z" })]);
  ok("a NO-SHOW assignment → no_show", ns.state === "no_show", j(ns));
  const mv = state([assigned({ scheduledFor: at("2026-10-09", 13), rescheduleCount: 1 })]);
  ok("an assignment that now lives on another day → moved, naming the day",
    mv.state === "moved" && mv.toDate === "2026-10-09", j(mv));
  const done = state([assigned({ status: "completed" })]);
  ok("a COMPLETED booking on the day → done, kept as history", done.state === "done", j(done));
  const rebooked = state([
    assigned({ status: "cancelled", cancelledAt: "2026-09-12T13:00:00Z" }),
    { id: "BK-2", source: "admin", status: "confirmed", propertyId: "p1", scheduledFor: at("2026-10-06", 14) }
  ]);
  ok("cancelled, then re-booked BY HAND on the same day → on_day (the hand booking wins)",
    rebooked.state === "on_day" && rebooked.bookingId === "BK-2", j(rebooked));
  const otherSeason = state([assigned({ assignment: { season: "spring", year: 2026 }, scheduledFor: at("2026-04-10", 9) })]);
  ok("another season's assignment is not this season's answer", otherSeason.state === "unassigned", j(otherSeason));
  const twice = state([
    assigned({ id: "BK-old", status: "cancelled", cancelledAt: "2026-09-10T10:00:00Z", cancellationReason: "first" }),
    assigned({ id: "BK-new", status: "cancelled", cancelledAt: "2026-09-12T10:00:00Z", cancellationReason: "second" })
  ]);
  ok("two dead assignments → the LATEST one's reason", twice.bookingId === "BK-new" && twice.reason === "second", j(twice));
  ok("gone means moved, cancelled or no_show — not on_day, done or unassigned",
    typeof assignments.stopIsGone === "function"
      && assignments.stopIsGone({ state: "moved" }) && assignments.stopIsGone({ state: "cancelled" }) && assignments.stopIsGone({ state: "no_show" })
      && !assignments.stopIsGone({ state: "on_day" }) && !assignments.stopIsGone({ state: "done" }) && !assignments.stopIsGone({ state: "unassigned" }) && !assignments.stopIsGone(null),
    "stopIsGone missing or wrong");
}

// ---- 2. The driven plan: gone stops leave their day, and are listed ------
{
  const stored = {
    bucketCap: 5, dayCap: 10,
    days: {
      "2026-10-06": { label: "Newmarket", morning: ["A1", "A2"], afternoon: ["A3"], constraints: { A2: { notBefore: "10:00" } }, manualOrder: true },
      "2026-10-07": { label: "Oshawa", morning: ["B1"], afternoon: [] }
    }
  };
  const states = { "A1|2026-10-06": { state: "cancelled", bookingId: "BK-1", reason: "selling" }, "A3|2026-10-06": { state: "moved", toDate: "2026-10-07" } };
  const out = lib("planAsDriven")(stored, (code, date) => states[`${code}|${date}`] || { state: "on_day" });
  const d6 = out.plan?.days?.["2026-10-06"];
  ok("the cancelled stop leaves its bucket", d6 && j(d6.morning) === j(["A2"]), j(d6?.morning));
  ok("…and the moved one leaves its bucket", d6 && j(d6.afternoon) === j([]), j(d6?.afternoon));
  ok("the day's label, windows and manual order survive",
    d6 && d6.label === "Newmarket" && d6.constraints?.A2?.notBefore === "10:00" && d6.manualOrder === true, j(d6));
  ok("a day with nothing gone is unchanged", j(out.plan?.days?.["2026-10-07"]) === j(stored.days["2026-10-07"]), j(out.plan?.days?.["2026-10-07"]));
  ok("the STORED plan is not touched", stored.days["2026-10-06"].morning.length === 2 && stored.days["2026-10-06"].afternoon.length === 1, j(stored.days["2026-10-06"]));
  const gone = out.gone?.["2026-10-06"] || [];
  ok("what left is LISTED for that day, with its bucket and why",
    gone.length === 2 && gone.some((g) => g.code === "A1" && g.bucket === "morning" && g.state === "cancelled" && g.reason === "selling")
      && gone.some((g) => g.code === "A3" && g.state === "moved" && g.toDate === "2026-10-07"), j(gone));
  ok("a day with nothing gone lists nothing", !out.gone?.["2026-10-07"], j(out.gone));
  ok("no plan → no plan, no crash", lib("planAsDriven")(null, () => null)?.plan === null, j(lib("planAsDriven")(null, () => null)));
}

// ---- 3. drivenPlan end to end, on fixtures ------------------------------
{
  const plan = { days: { "2026-10-06": { label: "Newmarket", morning: ["A1", "A2"], afternoon: ["A3", "NOPROP"] } } };
  const props = [
    { id: "p1", code: "A1", customerName: "Alfie Muzzin", address: "12 Oak St, Newmarket" },
    { id: "p2", code: "A2", customerName: "Bravo" },
    { id: "p3", code: "A3", customerName: "Charlie" }
  ];
  const rows = [
    assigned({ id: "BK-1", propertyId: "p1", status: "cancelled", cancelledAt: "2026-09-12T13:00:00Z", cancellationReason: "Selling the house" }),
    assigned({ id: "BK-2", propertyId: "p2" }),
    assigned({ id: "BK-3", propertyId: "p3", scheduledFor: at("2026-10-09", 13), rescheduleCount: 1 })
  ];
  const deps = { getPlan: async () => plan, listProperties: async () => props, listBookings: async () => rows };
  let driven;
  try { driven = await lib("drivenPlan")("fall", 2026, deps); } catch (err) { driven = { error: err.message }; }
  ok("drivenPlan answers with stored, plan and gone", driven && driven.stored && driven.plan && driven.gone, j(driven));
  ok("Alfie's cancelled stop is off the morning; Bravo stays", j(driven?.plan?.days?.["2026-10-06"]?.morning) === j(["A2"]), j(driven?.plan?.days?.["2026-10-06"]?.morning));
  ok("Charlie moved to the 9th and is off the 6th; a code with no property stays (unassigned)",
    j(driven?.plan?.days?.["2026-10-06"]?.afternoon) === j(["NOPROP"]), j(driven?.plan?.days?.["2026-10-06"]?.afternoon));
  const g = driven?.gone?.["2026-10-06"] || [];
  ok("the gone list carries the customer's name and address for the screen",
    g.some((x) => x.code === "A1" && x.customerName === "Alfie Muzzin" && /Oak St/.test(x.address) && /Selling/.test(x.reason)), j(g));
  ok("…and the moved one names its new day", g.some((x) => x.code === "A3" && x.state === "moved" && x.toDate === "2026-10-09"), j(g));
  ok("the stored plan comes back as written", j(driven?.stored?.days?.["2026-10-06"]?.morning) === j(["A1", "A2"]), j(driven?.stored));
  let none;
  try { none = await lib("drivenPlan")("fall", 2026, { ...deps, getPlan: async () => null }); } catch (err) { none = { error: err.message }; }
  ok("no plan → null, not a crash", none === null, j(none));
}

// ---- 4. Every reader holds the DRIVEN plan --------------------------------
{
  const src = read("server/server.js");
  const block = (start, len = 1200) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + len); };
  ok("the board (resolveSeasonPlan) reads the driven plan and hands each day its dropped list",
    /assignments\.drivenPlan\(season, year\)/.test(block("async function resolveSeasonPlan(", 800)) && /d\.dropped = driven\.gone\[d\.date\]/.test(src),
    "the board still draws stored codes");
  ok("the day shapes that gate customers read the driven plan",
    /assignments\.drivenPlan\(resolvedSeason, resolvedYear\)/.test(block("async function dayShapesForSeason(", 1600)), "availability still shapes days from cancelled stops");
  ok("the route line reads the driven plan",
    /assignments\.drivenPlan\(season, year\)/.test(block("const seasonPlanLineMatch = pathname.match(", 800)), "the line still runs through cancelled stops");
  ok("the route map image reads the driven plan",
    /assignments\.drivenPlan\(season, year\)/.test(block("const seasonPlanMapMatch = pathname.match(", 800)), "the map image still draws cancelled stops");
  ok("the unplanned ranker reads the driven plan",
    /assignments\.drivenPlan\(season, year\)/.test(block("async function unplannedRanker(", 400)), "ranking still counts cancelled stops as route shape");
  ok("the day preview reads the driven plan, and guards on the stored one",
    /assignments\.drivenPlan\(season, year\)/.test(block("const seasonPlanPreviewMatch = pathname.match(", 1600))
      && /plannedCodes\(driven\.stored\)/.test(block("const seasonPlanPreviewMatch = pathname.match(", 2200)), "the preview sequences cancelled stops");
  ok("the probe reads the driven plan",
    /assignments\.drivenPlan\(season, year\)/.test(block("const seasonPlanProbeMatch = pathname.match(", 800)) || /assignments\.drivenPlan\(season, year\)/.test(block("/probe$/", 900)),
    "the phone probe still scores against cancelled stops");
  ok("the job finder searches the driven plan",
    /assignments\.drivenPlan\(season, y\)/.test(src), "search still lists cancelled stops on their day");
  ok("the write paths still write the STORED plan",
    /const stored = await seasonPlans\.getPlan\(season, year\);/.test(src), "a write path lost the stored plan");

  const lib2 = read("server/lib/assignments.js");
  ok("the calendar-time sync sequences the driven day",
    /const driven = await drivenPlan\(season, year, \{ getPlan, listProperties, listBookings \}\);/.test(lib2.slice(lib2.indexOf("async function syncAssignedTimes("))),
    "assigned times still include a cancelled stop's drive");
  ok("…and the day-move ride-along deliberately still reads the stored plan (its bookings have not moved yet)",
    /const plan = await getPlan\(season, year\);/.test(lib2.slice(lib2.indexOf("async function moveDayBookings("))), "moveDayBookings changed");
}

// ---- 5. The screen says why ----------------------------------------------
{
  const page = read("server/season-plan.js");
  ok("each dropped stop reads on the day's notes strip", /day\.dropped \|\| \[\]/.test(page) && /"is-dropped"/.test(page), "no dropped strip");
  ok("…in words: cancelled with the reason, moved with the day, nobody home",
    /moved to \$\{g\.toDate/.test(page) && /nobody home/.test(page) && /customer cancelled\$\{g\.reason/.test(page), "the words are missing");
  ok("…styled as the record, not an alarm", /\.sp-day-notes li\.is-dropped/.test(read("server/season-plan.css")), "no style");
}

if (failures.length) {
  console.error(`\n✗ test-plan-follows-bookings: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-plan-follows-bookings: ${pass} assertions passed`);

#!/usr/bin/env node
// scripts/test-plan-day-order.mjs
//
// The field app follows the Season Plan's day — order AND times.
//
// Patrick, 2026-10-09, October 17: the Season Plan drove 61 French Dr,
// Orangeville FIRST at 07:00 (an "after 07:00" on that stop, which starts
// the day early), then Wayne Stewart, East Gwillimbury 8:17, Andrew
// Steele, Newmarket 9:00, Michael Sirizzotti 9:35. The field app showed
// Stewart 8:17, Steele 9:00, Orangeville 8:00 (third), Sirizzotti 9:35.
// Two faults:
//
//   1. THE STORED TIME. The time sync clamped every morning start up to the
//      half-day's 8:00, so the route's 07:00 arrival was saved as 8:00.
//      Now a morning stop whose OWN window opens earlier keeps the route's
//      arrival; anyone promised 8-12 is still never stored before 8:00.
//   2. THE ORDER. /api/schedule/today ran its own drive-order from the yard
//      that only honoured exact times — not a stop's window, not a hand
//      order. Now a day on the plan is listed in the plan's own route.
//
// Run: node scripts/test-plan-day-order.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const assignments = require(path.join(ROOT, "server", "lib", "assignments.js"));
const daySchedule = require(path.join(ROOT, "server", "lib", "day-schedule.js"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const DATE = "2026-10-17";
const at = (h, m = 0) => new Date(`${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).toISOString();
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// ---- 1. The rule for the earliest stored start -----------------------------
{
  const s = assignments.scheduledStartFor;
  ok(typeof assignments.earliestStartMinutes === "function", "assignments exports earliestStartMinutes (the one rule)");
  ok(typeof s === "function", "assignments exports scheduledStartFor");
  if (typeof s === "function") {
    ok(hhmm(s(DATE, "morning", "07:00", 30, { notBefore: "07:00" }).toISOString()) === "07:00",
      "a morning stop with \"after 07:00\" that the route reaches at 07:00 is stored at 07:00, not 08:00");
    ok(hhmm(s(DATE, "morning", "06:40", 30, { notBefore: "07:00" }).toISOString()) === "07:00",
      "…never earlier than its own window");
    ok(hhmm(s(DATE, "morning", "07:40", 30, null).toISOString()) === "08:00",
      "a stop promised 8-12 with no window is never stored before 08:00");
    ok(hhmm(s(DATE, "morning", "07:40", 30, { notBefore: "09:00" }).toISOString()) === "08:00",
      "a window opening later than 08:00 does not lower the floor");
    ok(hhmm(s(DATE, "afternoon", "11:00", 30, { notBefore: "07:00" }).toISOString()) === "12:00",
      "the afternoon is untouched: a window never pulls a stop out of its half-day");
    ok(hhmm(s(DATE, "morning", "07:00", 30, { notBefore: "bad" }).toISOString()) === "08:00",
      "an unreadable window is ignored");
    ok(hhmm(s(DATE, "morning", "13:10", 30, null).toISOString()) === "11:30",
      "the upper clamp is unchanged: a morning overrun still stores inside the morning");
  }
}

// ---- 2. The time sync stores the route's 07:00 -----------------------------
{
  const props = [
    { id: "p-or", code: "P-2026-0057", customerName: "Jaswinder Chatrath", coords: { lat: 43.93, lng: -80.06 }, system: { zones: [1, 2, 3, 4] } },
    { id: "p-nm", code: "P-2026-0099", customerName: "Newmarket stop", coords: { lat: 44.05, lng: -79.49 }, system: { zones: [1, 2, 3, 4] } }
  ];
  const asg = (id, propertyId, code, h) => ({
    id, source: "assignment", status: "confirmed", propertyId, durationMinutes: 30,
    scheduledFor: at(h), rescheduleCount: 0, workOrderIds: [],
    assignment: { season: "fall", year: 2026, date: DATE, bucket: "morning", code, outreach: {} }
  });
  const rows = [asg("BK-OR", "p-or", "P-2026-0057", 8), asg("BK-NM", "p-nm", "P-2026-0099", 9)];
  const plan = { days: { [DATE]: { label: "R", morning: ["P-2026-0057", "P-2026-0099"], afternoon: [],
    constraints: { "P-2026-0057": { notBefore: "07:00" } } } } };
  // The sequencer as it drove the real day: Orangeville at 07:00 (the early
  // start), then the next stop. A second stop the route reached at 07:40
  // (no window) must still store at 08:00.
  const seq = async (day) => ({
    morning: day.morning, afternoon: [],
    timeline: [
      { propertyCode: "P-2026-0057", stopNumber: 1, arriveAt: "07:00" },
      { propertyCode: "P-2026-0099", stopNumber: 2, arriveAt: "07:40" }
    ]
  });
  const retimes = [];
  let r;
  try {
    r = await assignments.syncAssignedTimes("fall", 2026, {
      getPlan: async () => plan,
      listProperties: async () => props,
      listBookings: async () => rows,
      sequenceDay: seq,
      setRouteTime: async (id, when) => { retimes.push({ id, when }); },
      todayKey: "2026-10-09"
    });
  } catch (err) { r = { error: err.message }; }
  ok(r && r.ok === true, `the sync runs (${JSON.stringify(r)})`);
  const orRetime = retimes.find((x) => x.id === "BK-OR");
  ok(orRetime && hhmm(orRetime.when) === "07:00", `the Orangeville stop is stored at 07:00 (got ${orRetime && hhmm(orRetime.when)})`);
  const nm = retimes.find((x) => x.id === "BK-NM");
  ok(nm && hhmm(nm.when) === "08:00", `a stop with no window is held at 08:00 (got ${nm && hhmm(nm.when)})`);
}

// ---- 3. The app's order is the plan's route --------------------------------
{
  const order = daySchedule.orderByPlanRoute;
  ok(typeof order === "function", "day-schedule exports orderByPlanRoute");
  if (typeof order === "function") {
    // The rows as the app received them on 2026-10-09 (drive order from the yard).
    const rows = [
      { bookingId: "BK-2026-0201", propertyId: "p-stewart", customerName: "Wayne Stewart", start: at(8, 17) },
      { bookingId: "BK-2026-0220", propertyId: "p-steele", customerName: "Andrew Steele", start: at(9, 0) },
      { bookingId: "BK-2026-0156", propertyId: "p-chatrath", customerName: "Jaswinder Chatrath", start: at(8, 0) },
      { bookingId: "BK-2026-0231", propertyId: "p-sirizzotti", customerName: "Michael Sirizzotti", start: at(9, 35) }
    ];
    // The plan's route, as the Season Plan drew it: stop 1 is the plan stop
    // (keyed by its property), the rest are booked customers (keyed by booking).
    const route = new Map([
      ["prop:p-chatrath", { stopNumber: 1, arriveAt: "07:00" }],
      ["bk:BK-2026-0201", { stopNumber: 2, arriveAt: "08:17" }],
      ["bk:BK-2026-0220", { stopNumber: 3, arriveAt: "09:00" }],
      ["bk:BK-2026-0231", { stopNumber: 4, arriveAt: "09:35" }]
    ]);
    const names = (list) => (list || []).map((x) => x.customerName.split(" ")[1]).join(", ");
    const got = order(rows, route);
    ok(names(got) === "Chatrath, Stewart, Steele, Sirizzotti", `Oct 17 in the plan's order (got ${names(got)})`);
    const withWo = [...rows, { workOrderId: "WO-X", customerName: "Work Order", start: at(8, 30) }];
    const got2 = order(withWo, route);
    ok(names(got2) === "Chatrath, Stewart, Order, Steele, Sirizzotti",
      `a row the plan doesn't know sits by its own time, not dropped or pushed last (got ${names(got2)})`);
    ok(order(rows, new Map()) === null && order(rows, null) === null, "no plan route: the caller keeps its own order");
    ok(order(rows, new Map([["bk:other", { stopNumber: 1, arriveAt: "07:00" }]])) === null, "a route that places none of the rows: no change");
  }
}

// ---- 4. Today is wired to the plan's route ---------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const fn = src.slice(src.indexOf("async function orderDayForDriving"), src.indexOf("async function orderDayForDriving") + 4000);
  ok(/async function planRouteForDate\(dateKey\)/.test(src), "server.js has planRouteForDate");
  ok(/async function planRouteForDate[\s\S]{0,2000}sequenceDayWithBookings\(/.test(src),
    "…built with sequenceDayWithBookings, the same sequence the Season Plan screen draws");
  ok(/orderByPlanRoute\(rows, await planRouteForDate\(dateKey\)\)/.test(fn) && fn.indexOf("orderByPlanRoute") < fn.indexOf("resequence.sequenceDay"),
    "orderDayForDriving asks the plan's route first, and only then drive-orders");
  ok(/const ordered = await orderDayForDriving\(merged, dayKey\);/.test(src), "GET /api/schedule/today passes its date");
}

console.log(`test-plan-day-order: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

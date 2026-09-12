#!/usr/bin/env node
// scripts/test-routed-times.mjs
//
// Patrick, 2026-09-12, on a self-booked customer's row reading 10:30 while
// the route reached her at 08:20: "instead of the time slot being a place
// holder, can that also move around as well? The only place holder that
// is contained is the 8–12, and 12–5 ... Keep just the two time slots."
//
// The half-day is the promise; the minute inside it is the route's. This
// pins ONE sequence for a day (plan stops, assigned bookings AND
// self-booked customers), the customer's placeholder following it inside
// its half-day, the assigned stops timed WITH the customers in the loop,
// history never re-timed, and the old lead-only re-stamp delegating to
// the same sync rather than running its own arithmetic beside it.
//
// Run: node scripts/test-routed-times.mjs  (also in build:check)

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
const sync = async (...a) => {
  try { return await assignments.syncAssignedTimes(...a); } catch (err) { return { error: err.message }; }
};
const at = (date, h, m = 0) => new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).toISOString();
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const props = [
  { id: "p1", code: "A1", customerName: "Valleymede", coords: { lat: 43.87, lng: -79.42 }, system: { zones: [1, 2] } },
  { id: "p2", code: "A2", customerName: "Fanshawe", coords: { lat: 43.88, lng: -79.43 }, system: { zones: [1] } }
];
const asg = (id, propertyId, code, date, bucket, h) => ({
  id, source: "assignment", status: "confirmed", propertyId, durationMinutes: 30,
  scheduledFor: at(date, h),
  assignment: { season: "fall", year: 2026, date, bucket, code, outreach: {} }
});
// Cynthia: self-booked, Markham, placeholder 10:30, 30 minutes.
const cynthia = (date) => ({
  code: null, customerName: "Cynthia Tam", address: "79 Silver Rose Cres", bucket: "morning",
  start: at(date, 10, 30), end: at(date, 11, 0), durationMinutes: 30, timeLabel: "10:30 a.m.",
  coords: { lat: 43.86, lng: -79.30 }, leadId: "L-CT", bookingId: "BK-CT", propertyId: null
});
// A sequencer that drives the booked customer FIRST, then the plan stops —
// the shape the real day had. It returns arrivals for every code it is
// given, plan and __bk: alike.
const seqFirstBooked = async (day) => {
  const m = [...(day.morning || [])];
  const bk = m.filter((c) => String(c).startsWith("__bk:"));
  const plan = m.filter((c) => !String(c).startsWith("__bk:"));
  const order = [...bk, ...plan, ...(day.afternoon || [])];
  const times = ["08:20", "09:02", "09:37", "12:09", "12:47", "13:39"];
  return { morning: [...bk, ...plan], afternoon: day.afternoon || [],
    timeline: order.map((c, i) => ({ propertyCode: c, stopNumber: i + 1, arriveAt: times[i] || "15:00" })) };
};
function harness({ plan, rows, booked, seq = seqFirstBooked, today = "2026-09-12" }) {
  const updates = [];
  const retimes = [];
  const bookedRowsByDate = new Map(Object.entries(booked || {}));
  return {
    updates, retimes,
    deps: {
      getPlan: async () => plan,
      listProperties: async () => props,
      listBookings: async () => rows,
      sequenceDay: seq,
      updateBooking: async (id, patch) => { updates.push({ id, ...patch }); },
      bookedRowsByDate,
      retimeBooking: async (row, start, duration) => { retimes.push({ leadId: row.leadId, start: start.toISOString(), duration }); return true; },
      todayKey: today
    }
  };
}

// ---- 1. The customer's placeholder follows the route, inside its half-day --
{
  const date = "2026-10-15";
  const plan = { days: { [date]: { label: "East", morning: ["A1", "A2"], afternoon: [] } } };
  const rows = [asg("BK-1", "p1", "A1", date, "morning", 9), asg("BK-2", "p2", "A2", date, "morning", 9)];
  const h = harness({ plan, rows, booked: { [date]: [cynthia(date)] } });
  const r = await sync("fall", 2026, h.deps);
  ok("the sync answers with both passes", r && r.ok === true && "customersUpdated" in r, j(r));
  const ct = h.retimes.find((x) => x.leadId === "L-CT");
  ok("Cynthia's 10:30 placeholder moves to the route's 08:20", ct && hhmm(ct.start) === "08:20", j(h.retimes));
  ok("…keeping her 30 minutes", ct && ct.duration === 30, j(ct));
  ok("…and the summary counts her", r.customersChecked === 1 && r.customersUpdated === 1, j(r));
  ok("the assigned stops are timed WITH her in the loop — stops 2 and 3, not 1 and 2",
    h.updates.some((u) => u.id === "BK-1" && hhmm(u.scheduledFor) === "09:02") && h.updates.some((u) => u.id === "BK-2" && hhmm(u.scheduledFor) === "09:37"), j(h.updates));
}

// ---- 2. Inside the half-day, always ----------------------------------------
{
  const date = "2026-10-15";
  const plan = { days: { [date]: { label: "East", morning: [], afternoon: [] } } };
  // A sequencer that would put an afternoon customer at 11:00 — before noon.
  const early = async (day) => ({ morning: [], afternoon: day.afternoon || [],
    timeline: (day.afternoon || []).map((c, i) => ({ propertyCode: c, stopNumber: i + 1, arriveAt: "11:00" })) });
  const pm = { ...cynthia(date), bucket: "afternoon", start: at(date, 13, 0), end: at(date, 13, 30) };
  const h = harness({ plan, rows: [], booked: { [date]: [pm] }, seq: early });
  await sync("fall", 2026, h.deps);
  ok("an afternoon customer is never moved before noon", h.retimes.length === 1 && hhmm(h.retimes[0].start) === "12:00", j(h.retimes));
  // …and never so late that the visit runs past the half-day's close.
  const late = async (day) => ({ morning: [], afternoon: day.afternoon || [],
    timeline: (day.afternoon || []).map((c, i) => ({ propertyCode: c, stopNumber: i + 1, arriveAt: "16:50" })) });
  const h2 = harness({ plan, rows: [], booked: { [date]: [pm] }, seq: late });
  await sync("fall", 2026, h2.deps);
  ok("…nor so late the visit runs past 5", h2.retimes.length === 1 && hhmm(h2.retimes[0].start) === "16:30", j(h2.retimes));
}

// ---- 3. What is left alone ---------------------------------------------------
{
  const date = "2026-10-15";
  const plan = { days: { [date]: { label: "East", morning: [], afternoon: [] } } };
  // Already at the route's time → no write.
  const settled = { ...cynthia(date), start: at(date, 8, 20), end: at(date, 8, 50) };
  let h = harness({ plan, rows: [], booked: { [date]: [settled] } });
  let r = await sync("fall", 2026, h.deps);
  ok("a customer already at the route's minute is not rewritten", h.retimes.length === 0 && r.customersChecked === 1 && r.customersUpdated === 0, j({ r, retimes: h.retimes }));
  // History.
  const past = "2026-09-01";
  h = harness({ plan: { days: { [past]: { morning: [], afternoon: [] } } }, rows: [], booked: { [past]: [cynthia(past)] } });
  r = await sync("fall", 2026, h.deps);
  ok("a day already driven is never re-timed", h.retimes.length === 0 && r.customersChecked === 0, j({ r, retimes: h.retimes }));
  // No coordinates → no place in the sequence → no time to follow.
  const nowhere = { ...cynthia(date), coords: null };
  h = harness({ plan, rows: [], booked: { [date]: [nowhere] } });
  r = await sync("fall", 2026, h.deps);
  ok("a customer with no pin keeps their placeholder", h.retimes.length === 0, j(h.retimes));
  // Without the deps, the old behaviour exactly.
  const plain = harness({ plan, rows: [asg("BK-1", "p1", "A1", date, "morning", 9)], booked: {} });
  delete plain.deps.bookedRowsByDate; delete plain.deps.retimeBooking;
  r = await sync("fall", 2026, plain.deps);
  ok("without the customer deps the assignment pass runs as it always has", r.ok && r.checked === 1 && r.customersChecked === 0, j(r));
  // A season with no plan still times its booked days.
  h = harness({ plan: null, rows: [], booked: { [date]: [cynthia(date)] } });
  r = await sync("fall", 2026, h.deps);
  ok("no plan → booked days are still timed from the yard", h.retimes.length === 1 && r.customersUpdated === 1, j({ r, retimes: h.retimes }));
  // Scoped to the days that changed.
  const other = "2026-10-16";
  h = harness({ plan: { days: { [date]: { morning: [], afternoon: [] }, [other]: { morning: [], afternoon: [] } } }, rows: [],
    booked: { [date]: [cynthia(date)], [other]: [{ ...cynthia(other), leadId: "L-2", bookingId: "BK-Z" }] } });
  h.deps.onlyDates = [other];
  r = await sync("fall", 2026, h.deps);
  ok("`onlyDates` re-times just those days", h.retimes.length === 1 && h.retimes[0].leadId === "L-2" && r.customersChecked === 1, j({ r, retimes: h.retimes }));
}

// ---- 4. One sequencer for the day, everywhere ------------------------------
{
  ok("sequenceWithBookings lives in the lib", typeof assignments.sequenceWithBookings === "function", "missing");
  const src = read("server/server.js");
  ok("the server's day sequencer delegates to it",
    /async function sequenceDayWithBookings\(\{ storedDay, bookedRows, byCode, season, requestedWindows \}\) \{\s*return assignments\.sequenceWithBookings\(/.test(src), "two sequencers");
  const rawCalls = (src.match(/assignments\.syncAssignedTimes\(/g) || []).length;
  ok("every time-sync trigger runs the routed sync — the lib is called from ONE place, inside it",
    rawCalls === 1 && /async function syncRoutedTimes\([\s\S]{0,600}assignments\.syncAssignedTimes\(/.test(src) && (src.match(/syncRoutedTimes\(/g) || []).length >= 9,
    `${rawCalls} raw call(s), ${(src.match(/syncRoutedTimes\(/g) || []).length} routed call sites`);
  ok("…including a stop move, an add and a place",
    /time sync after move failed/.test(src) && /time sync after add failed/.test(src) && /time sync after place failed/.test(src), "a plan change still skips the sync");
  ok("the routed sync hands the day's customers to the lib", /bookedRowsByDate, retimeBooking: retimeCustomerBooking/.test(src), "customers not passed");
  ok("booked rows carry their duration for the re-time", /durationMinutes: b\.end \? Math\.max\(1, Math\.round/.test(src), "no duration on the row");
  const restamp = src.slice(src.indexOf("async function restampDayInDrivingOrder("), src.indexOf("async function restampDayInDrivingOrder(") + 700);
  ok("the old lead-only re-stamp delegates to the same sync, scoped to ITS day",
    /await syncRoutedTimes\(season, year, \{ dates: \[dayKey\] \}\)/.test(restamp) && !/SLOT_MINUTES/.test(restamp), "a second re-timing implementation still runs, or it sequences the whole season per booking");
  ok("…so every booking path (through syncBookingFromLead) re-times the day", /await restampDayInDrivingOrder\(lead\.booking\.start\)/.test(src), "the wrapper no longer re-stamps");
  const retime = src.slice(src.indexOf("async function retimeCustomerBooking("), src.indexOf("async function syncRoutedTimes("));
  ok("the re-time moves BOTH stores through the one mirror", /lead\.booking\.start = startIso/.test(retime) && /await mirrorBookingOnly\(lead\)/.test(retime) && !/bookings\.upsertFromLead\(/.test(retime), "stores can drift");
  ok("…and the linked work order", /workOrders\.update\(wo\.id, \{ scheduledFor: startIso \}\)/.test(retime), "the WO keeps the old time");
  ok("…never a visit the tech has reached, nor a locked day", /w\.arrivedAt\)\) return false/.test(retime) && /dayLocked\) return false/.test(retime), "guards missing");
  ok("…and sends nothing", !/notifyCustomer|sendSms|sendEmail|notify\(/.test(retime), "the re-time messages the customer");
  ok("…leaving a line on the customer's record", /Route timing: /.test(retime), "no audit line");
}

if (failures.length) {
  console.error(`\n✗ test-routed-times: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-routed-times: ${pass} assertions passed`);

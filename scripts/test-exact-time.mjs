#!/usr/bin/env node
// scripts/test-exact-time.mjs
//
// Patrick, 2026-10-08: "Most — if not all — reschedules should only be
// capable of booking either morning or afternoon appointments like every
// other one. I'd like the option when I (me only, admin) am changing the
// schedule to schedule it for a specific time." Then: "go with the exact
// time — but if I select 7am, it needs to be booked at 7am."
//
// An EXACT TIME is a state on a booking, so (CLAUDE.md) every reader has
// to honour it, through one rule — bookings.exactTimeOf(): the exact time
// holds only while the appointment still starts at that local minute.
//
//   the store      reschedule(exactTime) sets it, any other reschedule ends it;
//                  setExactTime sets/clears it on a booked stop; setRouteTime
//                  never moves it; a day move keeps the clock time
//   the route      the stop is pinned to the minute (requestedWindowsFor, booked
//                  rows), and a 7:00 first stop starts the day early
//   the sync       syncAssignedTimes and the self-booking re-time skip it
//   the customer   every message, the appointment page and the time notice say
//                  "at 7:00 AM"; a season customer Patrick reschedules is now
//                  told at all (the reschedule email only ever reached leads)
//   the field app  the day order puts a 7:00 job first
//   the half-day   the promise is booking.bucket, so a Morning → Afternoon move
//                  is told as Afternoon (assignment.bucket was stale after a
//                  reschedule)
//
// Fails on the code before the fix: almost every section.
//
// Run: node scripts/test-exact-time.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
};
const j = (v) => JSON.stringify(v);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-exact-"));
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
const prop = (id) => ({ id, code: id, customerName: `Customer ${id}`, customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`, address: `${id} French Dr, Orangeville, ON`, town: "Orangeville" });
const PROPS = ["P-A", "P-B", "P-C", "P-D", "P-E", "P-F", "P-G"].map(prop);
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify(PROPS, null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const messages = require(path.join(SANDBOX, "server/lib/assignment-messages.js"));
const cadence = require(path.join(SANDBOX, "server/lib/assignment-cadence.js"));
const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));
const resequence = require(path.join(SANDBOX, "server/lib/resequence.js"));
const appt = require(path.join(SANDBOX, "server/lib/appointment-actions.js"));
const fn = (mod, name) => (typeof mod[name] === "function" ? mod[name] : () => { throw new Error(`${name} is missing`); });

const T = (day, h, m = 0) => new Date(2026, 9, day, h, m).toISOString();   // October 2026
const ALL_STEPS = Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((n) => [n, { at: "2026-09-11T13:00:00Z", attempted: ["email", "sms"], sent: ["email", "sms"] }]));
async function mk(pid, { day = 17, h = 8, m = 51, bucket = "morning", messaged = true } = {}) {
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  const b = await bookings.createDirect({
    propertyId: pid, customerName: `Jaswinder ${pid}`, customerPhone: "+19055550100",
    customerEmail: `${pid.toLowerCase()}@example.com`, address: "61 French Dr, Orangeville, ON",
    serviceKey: "fall_close_4z", serviceLabel: "Fall winterization (1-4 zones residential)",
    scheduledFor: T(day, h, m), durationMinutes: 30, status: "confirmed", source: "assignment",
    assignment: { season: "fall", year: 2026, batchId: "AS-t", assignedAt: "x", date, bucket, code: pid }
  });
  if (messaged) await bookings.setAssignmentOutreach(b.id, { token: `tok${pid}`, steps: ALL_STEPS });
  return bookings.get(b.id);
}
const wire = { emails: [], smses: [] };
const clearWire = () => { wire.emails.length = 0; wire.smses.length = 0; };
const deps = {
  getPlan: async () => ({ days: {} }),
  sendEmail: async (a) => { wire.emails.push(a); return { ok: true }; },
  sendSms: async (a) => { wire.smses.push(a); return { ok: true }; }
};
const sweep = () => cadence.sweepDue("fall", 2026, { deps, now: new Date(2026, 9, 8, 11, 0), appointmentPageReady: true });

// ---- 1. The rule ---------------------------------------------------------
{
  const exactOf = (r) => safe(() => fn(bookings, "exactTimeOf")(r));
  ok("1a. an exact time holds while the visit starts at that minute", await exactOf({ exactTime: "07:00", scheduledFor: T(17, 7) }) === "07:00");
  ok("1b. …and is void the moment the start is anywhere else", await exactOf({ exactTime: "07:00", scheduledFor: T(17, 8, 51) }) === null);
  ok("1c. a lead's booking envelope (start, not scheduledFor) reads the same", await exactOf({ exactTime: "07:00", start: T(17, 7) }) === "07:00");
  ok("1d. junk is not a time", await exactOf({ exactTime: "7am", scheduledFor: T(17, 7) }) === null);
}

// ---- 2. The store --------------------------------------------------------
{
  const a = await mk("P-A");
  const r1 = await safe(() => bookings.reschedule(a.id, { scheduledFor: T(17, 7), exactTime: true, by: "admin" }));
  ok("2a. Patrick's custom-time reschedule books 7:00 AS an exact time",
    r1.scheduledFor === T(17, 7) && r1.exactTime === "07:00" && r1.bucket === "morning", j(r1));
  const routed = await safe(() => bookings.setRouteTime(a.id, T(17, 9, 30), { by: "route" }));
  ok("2b. the route can never move it", (await bookings.get(a.id)).scheduledFor === T(17, 7), j(routed));
  const moved = await safe(() => bookings.moveAssignmentDay(a.id, { toDate: "2026-10-20", scheduledFor: T(20, 9, 40), oldDate: "2026-10-17", queueNotice: false, kind: "stop" }));
  ok("2c. moved to another day, it is still 7:00 — the time travels with the visit",
    moved.scheduledFor === T(20, 7) && fn(bookings, "exactTimeOf")(moved) === "07:00" && moved.assignment.date === "2026-10-20", j(moved && moved.scheduledFor));
  const r2 = await bookings.reschedule(a.id, { scheduledFor: T(21, 8), bucket: "morning", by: "customer" });
  ok("2d. a half-day reschedule (the customer's, or a normal slot) ends the exact time", !r2.exactTime && r2.scheduledFor === T(21, 8), j(r2.exactTime));

  const b = await mk("P-B");
  const s1 = await safe(() => fn(bookings, "setExactTime")(b.id, { time: "07:00", by: "patrick" }));
  ok("2e. setExactTime on a booked stop: same day, 7:00 sharp, still morning",
    s1.scheduledFor === T(17, 7) && s1.exactTime === "07:00" && s1.bucket === "morning"
    && (s1.history || []).some((h) => h.action === "exact_time_set"), j(s1));
  ok("2f. …and it is not a reschedule — the customer keeps their own move", (Number(s1.rescheduleCount) || 0) === 0);
  const s2 = await safe(() => fn(bookings, "setExactTime")(b.id, { time: "13:30", by: "patrick" }));
  ok("2g. an exact time can move the half-day (1:30 PM is an afternoon visit)",
    s2.scheduledFor === T(17, 13, 30) && s2.bucket === "afternoon" && s2.assignment?.bucket === "afternoon", j(s2 && s2.bucket));
  const s3 = await safe(() => fn(bookings, "setExactTime")(b.id, { time: null, by: "patrick" }));
  ok("2h. clearing hands the minute back to the route", !s3.exactTime && (s3.history || []).some((h) => h.action === "exact_time_cleared"), j(s3));
  await fn(bookings, "setExactTime")(b.id, { time: "07:00" });
  const s4 = await safe(() => fn(bookings, "setExactTime")(b.id, { time: null }));
  ok("2h½. …and a cleared 7:00 goes back inside the morning it is now promised (8:00), not left before it",
    s4.scheduledFor === T(17, 8) && s4.bucket === "morning", j(s4 && s4.scheduledFor));
  const bad = await safe(() => fn(bookings, "setExactTime")(b.id, { time: "7am" }));
  ok("2i. a time that isn't HH:MM is refused in words", /not a time/.test(bad.error || ""), j(bad));
  const c = await safe(() => bookings.createDirect({ propertyId: "P-G", serviceKey: "fall_close_4z", scheduledFor: T(22, 7, 15), exactTime: "07:15", source: "admin_custom" }));
  ok("2j. a booking created at a custom time is born exact", c.exactTime === "07:15", j(c && c.exactTime));
}

// ---- 3. The route pins it, and starts the day early ----------------------
const at = ([x, y]) => ({ lat: 44 + x / 1000, lng: -79.5 + y / 1000 });
const gx = (c) => Math.round((c.lat - 44) * 1000);
const gy = (c) => Math.round((c.lng + 79.5) * 1000);
const travel = async (a, b) => Math.round(Math.hypot(gx(a) - gx(b), gy(a) - gy(b)));
const gprop = (code, xy) => ({ code, id: code, address: code, coords: at(xy), system: { zones: [{}, {}, {}] } });
const byCode = new Map([["N1", gprop("N1", [10, 0])], ["N2", gprop("N2", [12, 0])], ["FAR", gprop("FAR", [40, 40])]]);
{
  const day = { morning: ["N1", "N2", "FAR"], afternoon: [] };
  const plain = await resequence.sequenceDay(day, { propertiesByCode: byCode, travel, base: at([0, 0]) });
  ok("3a. (control) unpinned, the day starts at 8:00 and nothing arrives before it",
    plain.timeline.every((t) => t.arriveAt >= "08:00") && !(plain.flags || []).some((f) => f.code === "early_start"),
    j(plain.timeline.map((t) => `${t.propertyCode}@${t.arriveAt}`)));
  const pinned = await resequence.sequenceDay(day, { propertiesByCode: byCode, travel, base: at([0, 0]),
    requestedWindows: { FAR: { notBefore: "07:00", notAfter: "07:00" } } });
  const first = pinned.timeline[0];
  ok("3b. pinned at 7:00, it is the first stop and the truck is there AT 7:00",
    first.propertyCode === "FAR" && first.arriveAt === "07:00", j(pinned.timeline.map((t) => `${t.propertyCode}@${t.arriveAt}`)));
  ok("3c. …nothing is a miss", !(pinned.flags || []).some((f) => /miss/i.test(f.code || "")), j(pinned.flags));
  const early = (pinned.flags || []).find((f) => f.code === "early_start");
  ok("3d. the card says the day starts early, and when to leave", early && /leave the yard at 06:\d\d/.test(early.message), j(pinned.flags));
  const manual = await resequence.sequenceDay({ ...day, morning: ["FAR", "N1", "N2"], manualOrder: true },
    { propertiesByCode: byCode, travel, base: at([0, 0]), requestedWindows: { FAR: { notBefore: "07:00", notAfter: "07:00" } } });
  ok("3e. a hand-ordered day with the 7:00 stop first also starts early", manual.timeline[0].arriveAt === "07:00", j(manual.timeline.map((t) => t.arriveAt)));

  const listBookings = async () => [{ ...(await mk("P-C", { messaged: false })), exactTime: "07:00", scheduledFor: T(17, 7) }];
  const w = await assignments.requestedWindowsFor("fall", 2026, listBookings);
  ok("3f. requestedWindowsFor pins an assigned stop with an exact time", j(w["P-C"]) === j({ notBefore: "07:00", notAfter: "07:00" }), j(w));

  const row = { bookingId: "BK-X", bucket: "morning", coords: at([40, 40]), exactTime: "07:00" };
  const { sequenced } = await assignments.sequenceWithBookings({ storedDay: { morning: ["N1", "N2"], afternoon: [] }, bookedRows: [row], byCode, season: "fall",
    seq: (d, o) => resequence.sequenceDay(d, { ...o, travel, base: at([0, 0]) }) });
  ok("3g. a self-booked customer with an exact time is pinned too", sequenced.timeline[0].propertyCode === "__bk:BK-X" && sequenced.timeline[0].arriveAt === "07:00",
    j(sequenced.timeline.map((t) => `${t.propertyCode}@${t.arriveAt}`)));
}

// ---- 4. What the customer is told ----------------------------------------
{
  const exactB = { exactTime: "07:00", scheduledFor: T(17, 7), bucket: "morning", requestedWindow: { notBefore: "11:00" }, assignment: { bucket: "morning" }, customerName: "J C" };
  ok("4a. every message says 'at 7:00 AM' — the exact time beats their own window and the plan's",
    messages.contextForBooking(exactB, { planWindow: { notBefore: "09:00" } }).bucket === "at 7:00 AM", messages.contextForBooking(exactB, {}).bucket);
  ok("4b. the appointment page says the same", appt.bucketLabelOf(exactB) === "at 7:00 AM", appt.bucketLabelOf(exactB));
  const stale = { scheduledFor: T(17, 13), bucket: "afternoon", assignment: { bucket: "morning" }, customerName: "J C" };
  ok("4c. after a move to the afternoon the half-day is the BOOKING's, not the stale assignment one",
    messages.contextForBooking(stale, {}).bucket === "Afternoon (12 PM – 5 PM)" && appt.bucketLabelOf(stale) === "Afternoon (12 PM – 5 PM)",
    `${messages.contextForBooking(stale, {}).bucket} | ${appt.bucketLabelOf(stale)}`);
}

// ---- 5. The Season plan's Exact time, end to end (Jaswinder's 7am) --------
{
  const d = await mk("P-D", { day: 17, h: 8, m: 51 });
  const res = await safe(() => fn(assignments, "setStopExactTime")("fall", 2026, { date: "2026-10-17", code: "P-D", time: "07:00" }, { listProperties: async () => PROPS, actor: "patrick" }));
  const after = await bookings.get(d.id);
  ok("5a. 'if I select 7am — it needs to be booked at 7am'", after.scheduledFor === T(17, 7) && after.exactTime === "07:00", j(after.scheduledFor));
  ok("5b. the customer notice is queued", res.timeNotice?.queued === true && Boolean(after.assignment.outreach.pendingTimeNotice), j(res));
  clearWire();
  await sweep();
  const mail = wire.emails.find((e) => e.refId === d.id);
  const text = wire.smses.find((s) => /time is set/.test(s.smsBody));
  ok("5c. the email says Saturday, October 17 — at 7:00 AM", mail && /Saturday, October 17 — at 7:00 AM/.test(mail.emailBody), mail && mail.emailBody);
  ok("5d. the text says it too", text && /Saturday, October 17, at 7:00 AM/.test(text.smsBody), text && text.smsBody);
  const off = await safe(() => assignments.setStopExactTime("fall", 2026, { date: "2026-10-17", code: "P-D", time: null }, { listProperties: async () => PROPS }));
  ok("5e. clearing it queues the notice that it's back to the half-day", off.ok && off.timeNotice?.queued === true, j(off));
  const none = await safe(() => assignments.setStopExactTime("fall", 2026, { date: "2026-10-18", code: "P-D", time: "07:00" }, { listProperties: async () => PROPS }));
  ok("5f. a stop with no booking on that day is refused, with the reason", none.ok === false && none.reason === "no_booking", j(none));
}

// ---- 6. A half-day change is told even with no window ---------------------
{
  const e = await mk("P-E", { day: 23, h: 9, m: 10 });
  // What they were told by their last step: the morning.
  await bookings.setAssignmentOutreach(e.id, { timeNotice: { told: null, label: "Morning (8 AM – 12 PM)", at: "2026-10-01T13:00:00Z", via: "step_5" } });
  await bookings.reschedule(e.id, { scheduledFor: T(23, 13, 0), bucket: "afternoon", by: "admin" });
  await bookings.setAssignmentOutreach(e.id, { pendingTimeNotice: { date: "2026-10-23", queuedAt: new Date().toISOString() } });
  clearWire();
  await sweep();
  const mail = wire.emails.find((x) => x.refId === e.id);
  ok("6. Morning → Afternoon on the same day is told as the afternoon (it used to read 'nothing changed')",
    mail && /Friday, October 23 — Afternoon \(12 PM – 5 PM\)/.test(mail.emailBody), mail ? mail.emailBody.slice(0, 300) : "(nothing sent)");
}

// ---- 7. Every reader is wired ---------------------------------------------
{
  const server = read("server/server.js");
  const page = read("server/season-plan.js");
  const asg = read("server/lib/assignments.js");
  ok("7a. the admin Custom time reschedule books an exact time; any other reschedule doesn't",
    /const isExact = source === "admin_custom" && actor !== "customer";/.test(server) && /exactTime: isExact,/.test(server));
  ok("7b. …mirrored onto the lead for a self-booked customer", /if \(isExact\) lead\.booking\.exactTime = bookings\.localHHMM/.test(server) && /else delete lead\.booking\.exactTime;/.test(server));
  ok("7c. a season customer Patrick reschedules is told (move notice or time notice)",
    /4b\) A season \(assignment\) customer has no lead/.test(server) && /pendingDayMove: \{ oldDate: .*kind: "stop"/.test(server) && /pendingTimeNotice: \{ date: toDay/.test(server));
  ok("7d. the self-booking re-time skips an exact time (both stores)",
    /if \(bookings\.exactTimeOf\(rec\)\) return false;/.test(server) && /if \(bookings\.exactTimeOf\(lead\.booking\)\) return false;/.test(server));
  ok("7e. the assigned-stop sync skips it", /!bookings\.exactTimeOf\(b\)\s+\/\/ Patrick's exact minute/.test(asg));
  ok("7f. the season plan's booked rows carry it, and the field-app order pins it",
    /exactTime: bookings\.exactTimeOf\(b\.bookingId \? canonicalById\.get\(b\.bookingId\) : null\)/.test(server)
    && /resequence\.sequenceDay\(day, \{ propertiesByCode: byCode, requestedWindows \}\)/.test(server));
  ok("7g. new custom-time bookings (reserve, follow-up) are born exact",
    (server.match(/\.\.\.\(forcedByAdmin \? \{ exactTime: bookings\.localHHMM\(startDate\.toISOString\(\)\) \} : \{\}\)/g) || []).length === 3);
  ok("7h. the Season plan route is admin-only and books through setStopExactTime",
    /stop-exact-time\$\//.test(server) && /Only an admin can set an exact time/.test(server) && /assignments\.setStopExactTime\(season, year/.test(server));
  ok("7i. the stop form has an Exact time box that saves through that route", /"Exact time"/.test(page) && /patch\("stop-exact-time"/.test(page));
  ok("7j. the reschedule window's Custom time says it books an exact time and tells the customer",
    /customer is told the exact time/.test(read("js/time-picker.js")));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`test-exact-time: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);

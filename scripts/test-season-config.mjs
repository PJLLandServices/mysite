// Season config — the fall 2026 date correction, and the consolidation
// that made it a one-place edit.
//
//   node scripts/test-season-config.mjs
//
// THE BUG. server/lib/outreach.js carried a hardcoded SEASON_WINDOWS
// constant declaring fall as Sep 1 – Dec 15. The real fall 2026 season
// ends Nov 6 — past that is hard frost and no truck rolls. Two things
// ran on the wrong dates: deriveBookingState decided "is this customer
// already booked for fall?" by testing the season window, so a Nov 20
// appointment counted as booked; and /admin/outreach classified its
// Booked / Not-booked rows from that same answer.
//
// THE CONSOLIDATION. The dates now live in seasons.json, read through
// server/lib/seasons.js, so the seasonal gate planned for
// availability.js reads one source instead of keeping a second copy
// that drifts from this one.
//
// TIMEZONE. PJL operates in America/Toronto and scheduledFor is stored
// as a UTC Z timestamp, so an 8 PM Nov 6 appointment is written
// 2026-11-07T01:00:00Z and must still read as Nov 6. server.js pins
// process.env.TZ at boot; this file is loaded directly by the test
// runner, without server.js, so it pins the same TZ below — before any
// module that does date math is imported. Without this the file would
// pass under Toronto and fail under the UTC default of a CI container.
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
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Sandbox --------------------------------------------------------
//
// Same approach as test-seasonal-consent.mjs: the libs resolve their
// stores relative to their own __dirname, so a copy of the tree gets a
// copy of the stores. Real customer data is never opened, and nothing
// under server/data/ is created. Layout mirrors the repo (SANDBOX/
// server/lib + SANDBOX/*.json) so `../../seasons.json` still resolves.

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-seasons-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const file of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, file), path.join(SANDBOX, file));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const seasons = require(path.join(SANDBOX, "server/lib/seasons.js"));

// Toronto-local wall-clock time as the UTC Z string the booking flow
// actually stores (server.js writes startDate.toISOString()).
function storedAs(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0).toISOString();
}

// The window exactly as outreach.js hardcoded it before this change.
// Every "unchanged" assertion below is measured against this, not
// against a re-typed literal of what the new config happens to say.
const ORIGINAL_WINDOWS = {
  spring: { startMonth: 3, startDay: 1, endMonth: 6, endDay: 30 },
  fall:   { startMonth: 9, startDay: 1, endMonth: 12, endDay: 15 }
};
function inOriginalWindow(year, month, day, season) {
  const win = ORIGINAL_WINDOWS[season];
  if (month < win.startMonth || month > win.endMonth) return false;
  if (month === win.startMonth && day < win.startDay) return false;
  if (month === win.endMonth && day > win.endDay) return false;
  return true;
}

// ---- 1. The config itself -------------------------------------------
{
  ok("seasons.json loads clean", seasons.loadError() === null, String(seasons.loadError()));

  const fall = seasons.configFor("fall", 2026);
  ok("fall 2026 serviceableFrom is Sep 1", fall.serviceableFrom === "2026-09-01", fall.serviceableFrom);
  ok("fall 2026 serviceableThrough is Nov 6 (frost stop)",
    fall.serviceableThrough === "2026-11-06", fall.serviceableThrough);
  ok("fall 2026 publicBookingThrough is Oct 30",
    fall.publicBookingThrough === "2026-10-30", fall.publicBookingThrough);

  // Nov 1–6 is the admin-placement tail the earlier public deadline reserves.
  ok("fall 2026 reserves an admin tail",
    fall.publicBookingThrough < fall.serviceableThrough);

  // Public booking opens with the first planned route day, not the
  // serviceable season: Sep 1–27 is truck-less for the public flow.
  ok("fall 2026 publicBookingFrom is Sep 28 (first route day)",
    fall.publicBookingFrom === "2026-09-28", fall.publicBookingFrom);

  const spring = seasons.configFor("spring", 2026);
  ok("spring 2026 serviceableFrom unchanged (Mar 1)", spring.serviceableFrom === "2026-03-01");
  ok("spring 2026 serviceableThrough unchanged (Jun 30)", spring.serviceableThrough === "2026-06-30");
  ok("spring 2026 reserves no admin tail",
    spring.publicBookingThrough === spring.serviceableThrough);
  ok("an absent publicBookingFrom defaults to serviceableFrom (spring 2026)",
    spring.publicBookingFrom === spring.serviceableFrom, spring.publicBookingFrom);
  ok("...and in an unplanned year's defaults too (fall 2027)",
    seasons.configFor("fall", 2027).publicBookingFrom === "2027-09-01",
    seasons.configFor("fall", 2027).publicBookingFrom);

  ok("an unknown season resolves to nothing", seasons.windowFor("summer", 2026) === null);

  // A year nobody has planned inherits the frost stop, NOT the Dec 15 the
  // old hardcoded constant used. Inheriting a safe default beats inheriting
  // a known-wrong one: fall 2027 must not silently reacquire this bug.
  ok("2026 is explicitly configured", seasons.hasExplicitYear(2026) === true);
  ok("2027 is not yet configured", seasons.hasExplicitYear(2027) === false);
  const fall2027 = seasons.windowFor("fall", 2027);
  ok("an unplanned year inherits the Nov 6 frost stop, not Dec 15",
    fall2027.endMonth === 11 && fall2027.endDay === 6,
    JSON.stringify(fall2027));
  const spring2027 = seasons.windowFor("spring", 2027);
  ok("an unplanned year keeps spring's long-standing dates",
    spring2027.startMonth === 3 && spring2027.startDay === 1 &&
    spring2027.endMonth === 6 && spring2027.endDay === 30,
    JSON.stringify(spring2027));
  // No default may promise the public flow a day no truck rolls.
  const fallDefault = seasons.configFor("fall", 2027);
  ok("the fall default books no later than it services",
    fallDefault.publicBookingThrough <= fallDefault.serviceableThrough);
}

// ---- 2. publicBookingThrough has exactly its intended consumers -----
//
// The field was defined ahead of the availability.js season gate, and
// this block originally pinned "no consumer yet". Stage 1 of
// docs/ASSIGNMENT_WRITER.md (2026-08-31) wired the gate — deliberately,
// which is what this sentinel was for. The pin now runs the other way:
// the gate and its test must read the field, and nobody else may start
// to without saying so here.
{
  const allowed = new Set([
    "seasons.json",
    "server/lib/seasons.js",
    "scripts/test-season-config.mjs",
    "server/lib/availability.js",       // the season gate itself
    "scripts/test-booking-guards.mjs"   // the gate's acceptance test
  ]);
  const searched = [
    "seasons.json",
    ...fs.readdirSync(path.join(ROOT, "server/lib")).map((f) => `server/lib/${f}`),
    ...fs.readdirSync(path.join(ROOT, "scripts")).map((f) => `scripts/${f}`),
    "server/server.js",
    "server/outreach.js",
    "server/outreach.html",
    "js/availability.js",
    "server/lib/availability.js",
    "book.html"
  ];
  const reads = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return false;
    return /publicBooking(From|Through)/.test(fs.readFileSync(abs, "utf8"));
  };
  const unexpected = [...new Set(searched)].filter((rel) => reads(rel) && !allowed.has(rel));
  ok("no consumer of the public booking bounds beyond the season gate and its test",
    unexpected.length === 0, unexpected.join(", "));
  ok("the season gate actually reads the public booking bounds",
    reads("server/lib/availability.js"));
  ok("the gate's acceptance test actually reads the public booking bounds",
    reads("scripts/test-booking-guards.mjs"));
}

// ---- 3. Window boundaries — inclusive on both ends ------------------
//
// Step 1 of the brief established both ends inclusive. Assert that, not
// what seems intuitive, and assert the four dates the brief names.
const outreach = require(path.join(SANDBOX, "server/lib/outreach.js"));
{
  const inFall = (m, d) => outreach.isInSeasonWindow(storedAs(2026, m, d), "fall", 2026);

  ok("Aug 31 2026 is outside fall", inFall(8, 31) === false);
  ok("Sep 1 2026 is inside fall (start inclusive)", inFall(9, 1) === true);
  ok("Nov 6 2026 is inside fall (end inclusive)", inFall(11, 6) === true);
  ok("Nov 7 2026 is outside fall", inFall(11, 7) === false);

  // The 39 days the correction removes.
  ok("Nov 20 2026 no longer counts as fall", inFall(11, 20) === false);
  ok("Dec 15 2026 no longer counts as fall", inFall(12, 15) === false);

  const inSpring = (m, d) => outreach.isInSeasonWindow(storedAs(2026, m, d), "spring", 2026);
  ok("Feb 28 2026 is outside spring", inSpring(2, 28) === false);
  ok("Mar 1 2026 is inside spring (start inclusive)", inSpring(3, 1) === true);
  ok("Jun 30 2026 is inside spring (end inclusive)", inSpring(6, 30) === true);
  ok("Jul 1 2026 is outside spring", inSpring(7, 1) === false);

  // Year gate is unchanged: a 2027 date is never fall 2026.
  ok("a 2027 date is not fall 2026",
    outreach.isInSeasonWindow(storedAs(2027, 10, 1), "fall", 2026) === false);
  // Legacy bookings with no date still don't count.
  ok("a null scheduledFor is not in any window",
    outreach.isInSeasonWindow(null, "fall", 2026) === false);
  ok("an unparseable scheduledFor is not in any window",
    outreach.isInSeasonWindow("not-a-date", "fall", 2026) === false);
}

// ---- 4. The Toronto boundary at 8 PM --------------------------------
//
// The reason this file pins TZ. Both timestamps below are Nov 6/7 in
// UTC terms; only the Toronto reading puts the first one in-window.
{
  ok("8 PM Nov 6 Toronto (stored 2026-11-07T01:00Z) is inside fall",
    outreach.isInSeasonWindow("2026-11-07T01:00:00.000Z", "fall", 2026) === true);
  ok("midnight Nov 7 Toronto (stored 2026-11-07T05:00Z) is outside fall",
    outreach.isInSeasonWindow("2026-11-07T05:00:00.000Z", "fall", 2026) === false);
}

// ---- 5. Every day of 2026, old behaviour vs new ---------------------
//
// The precise claim the brief asks for: identical for every date except
// the 39 days being removed, and spring untouched everywhere.
{
  let springDiffs = 0;
  const fallDiffs = [];
  for (let month = 1; month <= 12; month += 1) {
    const daysInMonth = new Date(2026, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = storedAs(2026, month, day);
      if (outreach.isInSeasonWindow(iso, "spring", 2026) !== inOriginalWindow(2026, month, day, "spring")) {
        springDiffs += 1;
      }
      if (outreach.isInSeasonWindow(iso, "fall", 2026) !== inOriginalWindow(2026, month, day, "fall")) {
        fallDiffs.push(`${month}-${day}`);
      }
    }
  }
  ok("spring 2026 is unchanged on all 365 days", springDiffs === 0, `${springDiffs} day(s) differ`);
  ok("fall 2026 changed on exactly 39 days", fallDiffs.length === 39, `${fallDiffs.length}: ${fallDiffs.join(",")}`);
  ok("the changed days are Nov 7 – Dec 15",
    fallDiffs[0] === "11-7" && fallDiffs[fallDiffs.length - 1] === "12-15",
    fallDiffs.join(","));

  // A year with no block in seasons.json inherits the defaults, and the fall
  // default is the frost stop rather than the old Dec 15. So an unplanned
  // year is deliberately NOT unchanged: it differs from the old hardcoded
  // window on the same 39 days 2026 does, and that is the point — 2027 must
  // not silently reinherit the bug just because nobody has planned it yet.
  // Spring, which the correction never touched, stays identical.
  let springDiffs2027 = 0;
  const fallDiffs2027 = [];
  for (let month = 1; month <= 12; month += 1) {
    const daysInMonth = new Date(2027, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = storedAs(2027, month, day);
      if (outreach.isInSeasonWindow(iso, "spring", 2027) !== inOriginalWindow(2027, month, day, "spring")) {
        springDiffs2027 += 1;
      }
      if (outreach.isInSeasonWindow(iso, "fall", 2027) !== inOriginalWindow(2027, month, day, "fall")) {
        fallDiffs2027.push(`${month}-${day}`);
      }
    }
  }
  ok("spring is unchanged in an unconfigured year", springDiffs2027 === 0,
    `${springDiffs2027} day(s) differ`);
  ok("fall in an unconfigured year drops the same 39 unserviceable days",
    fallDiffs2027.length === 39 &&
    fallDiffs2027[0] === "11-7" &&
    fallDiffs2027[fallDiffs2027.length - 1] === "12-15",
    `${fallDiffs2027.length}: ${fallDiffs2027.join(",")}`);
}

// ---- 6. seasonForBooking — the portal CTA moves with the frost ------
//
// Decision A of the brief, taken deliberately: after Nov 6 a Fall
// Closing is work PJL cannot perform, so the portal offers the coming
// Spring Opening instead of a service that can't be delivered.
{
  ok("Oct 15 2026 still offers fall",
    outreach.seasonForBooking(new Date(2026, 9, 15)) === "fall");
  ok("Nov 6 2026 (last serviceable day) still offers fall",
    outreach.seasonForBooking(new Date(2026, 10, 6)) === "fall");
  ok("Nov 7 2026 offers spring, not a frozen-ground fall closing",
    outreach.seasonForBooking(new Date(2026, 10, 7)) === "spring");
  ok("Nov 20 2026 offers spring",
    outreach.seasonForBooking(new Date(2026, 10, 20)) === "spring");

  // Unchanged everywhere else.
  ok("April 2026 offers spring", outreach.seasonForBooking(new Date(2026, 3, 15)) === "spring");
  ok("August 2026 looks ahead to fall", outreach.seasonForBooking(new Date(2026, 7, 19)) === "fall");
  ok("January 2026 looks ahead to spring", outreach.seasonForBooking(new Date(2026, 0, 10)) === "spring");
  // The default carries the frost stop too, so an unplanned year behaves the
  // same way rather than offering a fall closing nobody can perform.
  ok("an unconfigured year offers spring after Nov 6, not a frozen-ground fall",
    outreach.seasonForBooking(new Date(2027, 10, 20)) === "spring");
  ok("an unconfigured year still offers fall on Nov 6 itself",
    outreach.seasonForBooking(new Date(2027, 10, 6)) === "fall");
}

// ---- 7. deriveBookingState against a real store ---------------------
//
// The consumer the bug actually broke. Fixtures are written into the
// sandbox store, so this exercises the real read path.
const BOOKINGS = path.join(SANDBOX, "server/data/bookings.json");
const PROPERTIES = path.join(SANDBOX, "server/data/properties.json");

function booking(id, propertyId, iso, extra = {}) {
  return {
    id, propertyId, scheduledFor: iso,
    serviceKey: "fall_close_6z", status: "confirmed",
    customerName: "Test Customer", address: "1 Test St",
    ...extra
  };
}

{
  fs.writeFileSync(BOOKINGS, JSON.stringify([
    booking("BK-2026-0001", "P-IN-EARLY", storedAs(2026, 9, 1)),
    booking("BK-2026-0002", "P-IN-LATE", storedAs(2026, 11, 6, 20)),   // 8 PM Nov 6
    booking("BK-2026-0003", "P-OUT-EARLY", storedAs(2026, 8, 31)),
    booking("BK-2026-0004", "P-OUT-LATE", storedAs(2026, 11, 7)),
    booking("BK-2026-0005", "P-TAIL", storedAs(2026, 11, 20)),         // the removed tail
    booking("BK-2026-0006", "P-MID", storedAs(2026, 10, 15)),
    booking("BK-2026-0007", "P-CANCELLED", storedAs(2026, 10, 15), { status: "cancelled" }),
    booking("BK-2026-0008", "P-NOSHOW", storedAs(2026, 10, 15), { status: "no_show" }),
    booking("BK-2026-0009", "P-WRONGSVC", storedAs(2026, 10, 15), { serviceKey: "repair_hourly" }),
    booking("BK-2026-0010", "P-SPRING", storedAs(2026, 4, 20), { serviceKey: "spring_open_6z" })
  ], null, 2));

  const booked = async (propertyId, season = "fall") =>
    (await outreach.deriveBookingState(propertyId, season, 2026)).hasBooking;

  ok("Sep 1 booking counts as booked for fall", await booked("P-IN-EARLY") === true);
  ok("Nov 6 8 PM booking counts as booked for fall", await booked("P-IN-LATE") === true);
  ok("Aug 31 booking does not count", await booked("P-OUT-EARLY") === false);
  ok("Nov 7 booking does not count", await booked("P-OUT-LATE") === false);
  ok("Nov 20 booking no longer counts (was booked before the fix)",
    await booked("P-TAIL") === false);
  ok("a mid-season booking still counts", await booked("P-MID") === true);

  // Behaviour the correction must not have disturbed.
  ok("a cancelled booking still does not count", await booked("P-CANCELLED") === false);
  ok("a no-show booking still does not count", await booked("P-NOSHOW") === false);
  ok("a non-seasonal serviceKey still does not count", await booked("P-WRONGSVC") === false);
  ok("a spring booking still counts for spring", await booked("P-SPRING", "spring") === true);
  ok("a spring booking does not count for fall", await booked("P-SPRING") === false);
  ok("a property with no bookings is not booked", await booked("P-NONE") === false);

  // The returned shape is unchanged for an in-window booking.
  const state = await outreach.deriveBookingState("P-MID", "fall", 2026);
  ok("booked state carries the booking id", state.bookingId === "BK-2026-0006");
  ok("booked state carries the scheduled date", state.scheduledDate === storedAs(2026, 10, 15));
  const none = await outreach.deriveBookingState("P-TAIL", "fall", 2026);
  ok("unbooked state is null-shaped",
    none.hasBooking === false && none.bookingId === null && none.scheduledDate === null);
}

// ---- 8. The admin outreach list classifies on the new window --------
//
// /admin/outreach renders Booked / Not booked and its totals row from
// listCandidates. It displays no date range of its own — the window
// reaches the operator as this classification, so this is where the
// corrected window is verified as "what the view shows".
{
  fs.writeFileSync(PROPERTIES, JSON.stringify([
    { id: "P-MID", code: "PR-0001", customerName: "In Season", address: "1 Mid St",
      customerEmail: "mid@example.com", customerPhone: "9055550001" },
    { id: "P-TAIL", code: "PR-0002", customerName: "Frost Tail", address: "2 Tail St",
      customerEmail: "tail@example.com", customerPhone: "9055550002" },
    { id: "P-NONE", code: "PR-0003", customerName: "Never Booked", address: "3 None St",
      customerEmail: "none@example.com", customerPhone: "9055550003" }
  ], null, 2));

  const { candidates, totals } = await outreach.listCandidates({
    season: "fall", year: 2026, filter: "all"
  });
  const byId = Object.fromEntries(candidates.map((c) => [c.propertyId, c]));

  ok("all three properties are eligible", totals.eligible === 3, String(totals.eligible));
  ok("the mid-season property shows as booked", byId["P-MID"].bookingState.hasBooking === true);
  ok("the Nov 20 property shows as NOT booked", byId["P-TAIL"].bookingState.hasBooking === false);
  ok("the never-booked property shows as not booked", byId["P-NONE"].bookingState.hasBooking === false);
  ok("the booked total counts only the in-window booking", totals.booked === 1, String(totals.booked));

  // The Not-booked filter is the one Patrick sends from. The frost-tail
  // property must now appear in it.
  const notBooked = await outreach.listCandidates({ season: "fall", year: 2026, filter: "not_booked" });
  const ids = notBooked.candidates.map((c) => c.propertyId).sort();
  ok("the Not-booked filter now includes the Nov 20 property",
    ids.join(",") === "P-NONE,P-TAIL", ids.join(","));

  // Eligibility semantics are untouched: absent counts as eligible, and
  // only an explicit false opts a property out.
  fs.writeFileSync(PROPERTIES, JSON.stringify([
    { id: "P-MID", code: "PR-0001", customerName: "In Season", address: "1 Mid St",
      seasonalEligibility: { fallClosing: false } },
    { id: "P-NONE", code: "PR-0003", customerName: "Never Booked", address: "3 None St" }
  ], null, 2));
  const afterOptOut = await outreach.listCandidates({ season: "fall", year: 2026, filter: "all" });
  ok("an explicit fallClosing:false still opts a property out",
    afterOptOut.totals.eligible === 1 &&
    afterOptOut.candidates[0].propertyId === "P-NONE");
}

// ---- 9. Source guards ------------------------------------------------
//
// The consolidation is the point. Fail the build if the dates come back
// into the code, or if outreach.js stops reading the shared config.
{
  const outreachSrc = fs.readFileSync(path.join(ROOT, "server/lib/outreach.js"), "utf8");
  ok("outreach.js reads the shared season config",
    /require\(["']\.\/seasons["']\)/.test(outreachSrc));
  ok("outreach.js declares no season-window constant of its own",
    !/const\s+SEASON_WINDOWS\s*=/.test(outreachSrc));
  ok("outreach.js hardcodes no season month/day pair",
    !/startMonth\s*:\s*\d/.test(outreachSrc));

  const seasonsSrc = fs.readFileSync(path.join(ROOT, "server/lib/seasons.js"), "utf8");
  ok("seasons.js never guesses a window when the config is unreadable",
    !/startMonth\s*:\s*\d/.test(seasonsSrc));
}

// ---- Report ----------------------------------------------------------

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`season config: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`season config: ${pass} assertions passed`);

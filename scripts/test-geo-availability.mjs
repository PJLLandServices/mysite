// Geography-aware availability — the season plan, the day shape, and the
// filter that uses them.
//
//   node scripts/test-geo-availability.mjs
//
// WHAT THIS PROTECTS. server/lib/availability.js has always done
// reachable-from-previous / reachable-to-next travel math. It was inert
// on an empty day: with nothing booked, everything is reachable, so
// availability for an address in Nobleton and one in Scarborough came
// back identical and the first customer to click set the day's anchor.
// The season plan gives each day a shape before anyone books it, and the
// filter measures cheapest-insertion added drive against that shape.
//
// THE ACCEPTANCE CRITERION, from the build order: a Mississauga address
// should see the Etobicoke–Mississauga route day and NOT the Newmarket
// one. That is assertion 1 below, run through the real listAvailableSlots
// rather than a stand-in.
//
// THE REGRESSION IT MUST NOT CAUSE. FLOW-03 (/book.html, real-time
// availability) is marked PASS in docs/FLOW_REGISTER.md. Every caller
// that passes no dayShapes — which is every caller before a plan is
// loaded, and every caller in a season with no plan — must get byte-for-
// byte the behaviour it got before. Assertions 5 and 6.
//
// NO NETWORK. GOOGLE_MAPS_SERVER_KEY is cleared below so distance.js
// takes its Haversine fallback and the numbers are deterministic. The
// fallback writes coordinate pairs into server/data/distance-cache.json,
// which is gitignored runtime data — harmless, and the same file the
// server would warm anyway.
//
// TIMEZONE. Route days are calendar dates in America/Toronto and the
// engine walks local midnights. Pinned before any import that does date
// math, so this passes under a UTC CI container too.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const availability = require(path.join(ROOT, "server/lib/availability.js"));
const geoFilter = require(path.join(ROOT, "server/lib/geo-filter.js"));
const seasonPlans = require(path.join(ROOT, "server/lib/season-plans.js"));

const { listAvailableSlots, expandDaysToRange, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures -------------------------------------------------------
//
// Real coordinates, because the whole claim under test is geographic.
// Two route days drawn from the fall 2026 plan's actual shape: R5 runs
// Etobicoke → Mississauga → Acton, R1 runs Newmarket → Sharon → East
// Gwillimbury. They are about 60 km apart.

const WEST = [
  { code: "P-W1", coords: { lat: 43.7001, lng: -79.5730, source: "google" } },  // Etobicoke
  { code: "P-W2", coords: { lat: 43.5890, lng: -79.6441, source: "google" } },  // Mississauga
  { code: "P-W3", coords: { lat: 43.6320, lng: -79.8710, source: "google" } }   // Acton
];
const NORTH = [
  { code: "P-N1", coords: { lat: 44.0592, lng: -79.4613, source: "google" } },  // Newmarket
  { code: "P-N2", coords: { lat: 44.0980, lng: -79.4430, source: "google" } },  // Sharon
  { code: "P-N3", coords: { lat: 44.1030, lng: -79.4870, source: "google" } }   // East Gwillimbury
];

// A Mississauga caller — Patrick's own worked example from the brief.
const MISSISSAUGA = { lat: 43.5915, lng: -79.6410, source: "google" };
// The same address with the geocoder having failed: geocode.js hands
// back the depot, marked so callers can tell.
const UNGEOCODED = { lat: 44.0592, lng: -79.4613, source: "pjl-base" };

// Pin "now" to a Monday so weekday/weekend maths is stable, then put the
// two route days on the Monday and Tuesday of the following week — far
// enough out to clear leadTimeHours, close enough to sit inside a normal
// scan window.
const NOW = new Date(2026, 8, 14, 9, 0, 0);          // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const WEST_DAY = dayKey(plusDays(7));                 // Mon 21 Sep
const NORTH_DAY = dayKey(plusDays(8));                // Tue 22 Sep

const propertiesByCode = new Map(
  [...WEST, ...NORTH].map((p) => [p.code, { code: p.code, id: p.code, coords: p.coords }])
);

const plan = {
  generatedAt: NOW.toISOString(),
  bucketCap: 5,
  dayCap: 10,
  days: {
    [WEST_DAY]: { label: "R5", morning: WEST.map((p) => p.code), afternoon: [] },
    [NORTH_DAY]: { label: "R1", morning: NORTH.map((p) => p.code), afternoon: [] }
  }
};

const shapes = geoFilter.buildDayShapes({ plan, propertiesByCode, bookings: [] });

const baseArgs = {
  serviceKey: "fall_close_4z",
  bookings: [],
  blocks: [],
  daysAhead: 20,
  hours: DEFAULT_HOURS,
  settings: DEFAULT_SETTINGS,
  // Season gate off: this suite tests GEOGRAPHY in isolation. The real
  // fall 2026 window (public booking opens Sep 28) would gate the fixture
  // days below on its own; the gate has its own acceptance suite in
  // test-booking-guards.mjs, including runs against the live config.
  seasonWindows: () => null,
  now: NOW
};

const datesOf = (slots) => new Set(slots.map((s) => dayKey(new Date(s.start))));

// ---- 1. The acceptance criterion ------------------------------------

const diagnostics = { geoSuppressed: [] };
const filtered = await listAvailableSlots({
  ...baseArgs, customerCoords: MISSISSAUGA, dayShapes: shapes, diagnostics
});
const filteredDates = datesOf(filtered);

ok("Mississauga is offered the west route day",
  filteredDates.has(WEST_DAY),
  `offered: ${[...filteredDates].join(", ") || "nothing"}`);
ok("Mississauga is NOT offered the north route day",
  !filteredDates.has(NORTH_DAY),
  "the Newmarket day was offered to a Mississauga address");
ok("the suppressed day is reported, with its cost",
  diagnostics.geoSuppressed.some((g) => g.date === NORTH_DAY && g.addedDriveMinutes > 15),
  JSON.stringify(diagnostics.geoSuppressed));

// The separation is the thing that makes a single threshold safe.
const west = await geoFilter.addedDriveMinutes(MISSISSAUGA, shapes[WEST_DAY].points);
const north = await geoFilter.addedDriveMinutes(MISSISSAUGA, shapes[NORTH_DAY].points);
ok("insertion cost separates the two days by more than 10x",
  north.minutes > west.minutes * 10,
  `west ${west.minutes} min vs north ${north.minutes} min`);

// The two-pass ranking must pick the same day as measuring every gap.
const westExact = await geoFilter.addedDriveMinutes(MISSISSAUGA, shapes[WEST_DAY].points, { exact: true });
ok("two-pass ranking agrees with measuring every insertion position",
  Math.abs(westExact.minutes - west.minutes) <= 1,
  `exact ${westExact.minutes} vs ranked ${west.minutes}`);

// ---- 2. Days with no planned shape are untouched ---------------------

const unplannedDay = dayKey(plusDays(9));            // Wed 23 Sep, not in the plan
ok("a day with no planned route is still offered",
  filteredDates.has(unplannedDay),
  "the filter suppressed a day it has no opinion about");

// ---- 3. A failed geocode skips the filter ---------------------------

const ungeocoded = await listAvailableSlots({
  ...baseArgs, customerCoords: UNGEOCODED, dayShapes: shapes
});
const ungeocodedDates = datesOf(ungeocoded);
ok("an address that did not geocode is offered every route day",
  ungeocodedDates.has(WEST_DAY) && ungeocodedDates.has(NORTH_DAY),
  "a geocode failure must never narrow availability");

// ---- 4. The filter can be switched off ------------------------------

const disabled = await listAvailableSlots({
  ...baseArgs,
  customerCoords: MISSISSAUGA,
  dayShapes: shapes,
  settings: { ...DEFAULT_SETTINGS, geoMaxAddedDriveMinutes: 0 }
});
ok("geoMaxAddedDriveMinutes: 0 disables the filter",
  datesOf(disabled).has(NORTH_DAY),
  "the off switch did not switch it off");

// ---- 5 & 6. FLOW-03 regression guard --------------------------------

const noShapes = await listAvailableSlots({ ...baseArgs, customerCoords: MISSISSAUGA });
const noShapesNorth = await listAvailableSlots({ ...baseArgs, customerCoords: { ...MISSISSAUGA } });
ok("with no dayShapes the engine behaves exactly as before",
  JSON.stringify(noShapes.map((s) => s.start)) === JSON.stringify(noShapesNorth.map((s) => s.start))
    && datesOf(noShapes).has(NORTH_DAY),
  "passing no plan changed the unfiltered result");
ok("an empty plan is the same as no plan",
  datesOf(await listAvailableSlots({
    ...baseArgs, customerCoords: MISSISSAUGA,
    dayShapes: geoFilter.buildDayShapes({ plan: { days: {} }, propertiesByCode, bookings: [] })
  })).has(NORTH_DAY),
  "an empty plan narrowed availability");

// Every slot the unfiltered engine emits still carries the fields the
// booking page reads. A new field is fine; a missing one is FLOW-03.
const sample = noShapes[0];
ok("slot shape is unchanged for existing callers",
  sample && ["start", "end", "durationMinutes", "serviceKey", "serviceLabel", "dayLabel",
             "timeLabel", "bucketKey", "bucketWindow"].every((k) => k in sample),
  sample ? `missing: ${["start","end","durationMinutes","serviceKey","serviceLabel","dayLabel","timeLabel","bucketKey","bucketWindow"].filter((k)=>!(k in sample)).join(", ")}` : "no slots at all");
ok("filtered slots carry the added-drive cost for admin surfaces",
  filtered.every((s) => "addedDriveMinutes" in s)
    && filtered.some((s) => dayKey(new Date(s.start)) === WEST_DAY && Number.isFinite(s.addedDriveMinutes)),
  "addedDriveMinutes missing from a slot on a planned day");

// ---- 7. "Not in your area" is distinguishable from "full" -----------

const expanded = expandDaysToRange(filtered, {
  from: plusDays(7), to: plusDays(9), hours: DEFAULT_HOURS, now: NOW,
  geoSuppressed: diagnostics.geoSuppressed
});
ok("a geo-suppressed day reports outside_route_area, not no_availability",
  expanded.find((d) => d.date === NORTH_DAY)?.reason === "outside_route_area",
  expanded.find((d) => d.date === NORTH_DAY)?.reason);

// ---- 8. Day shapes ---------------------------------------------------

ok("a planned property with no coordinates is reported, not dropped silently",
  (() => {
    const s = geoFilter.buildDayShapes({
      plan: { days: { [WEST_DAY]: { label: "R5", morning: ["P-W1", "P-GONE"], afternoon: [] } } },
      propertiesByCode, bookings: []
    });
    return s[WEST_DAY].unresolved.length === 1 && s[WEST_DAY].unresolved[0].code === "P-GONE";
  })(), "an unresolvable code must surface on the review screen");

ok("a planned property that has also booked counts once",
  (() => {
    const s = geoFilter.buildDayShapes({
      plan: { days: { [WEST_DAY]: { label: "R5", morning: ["P-W1"], afternoon: [] } } },
      propertiesByCode,
      bookings: [{ start: `${WEST_DAY}T13:00:00`, coords: WEST[0].coords, propertyId: "P-W1" }]
    });
    return s[WEST_DAY].points.length === 1;
  })(), "the same house was counted as two stops");

ok("a booking whose address never resolved adds no geography",
  (() => {
    const s = geoFilter.buildDayShapes({
      plan: { days: { [WEST_DAY]: { label: "R5", morning: ["P-W1"], afternoon: [] } } },
      propertiesByCode,
      bookings: [{ start: `${WEST_DAY}T13:00:00`, coords: UNGEOCODED, propertyId: "X" }]
    });
    return s[WEST_DAY].points.length === 1;
  })(), "the depot was treated as a real stop");

ok("an empty day costs nothing to insert into",
  (await geoFilter.addedDriveMinutes(MISSISSAUGA, [])).minutes === 0);
ok("a candidate with no coordinates returns null, so callers skip rather than refuse",
  (await geoFilter.addedDriveMinutes(null, WEST.map((w) => w.coords))) === null);

// ---- 9. Plan validation ---------------------------------------------

const dup = seasonPlans.validate({
  days: { [WEST_DAY]: { label: "R5", morning: ["P-A", "P-A"], afternoon: [] } }
});
ok("a property planned twice is kept once and warned about",
  dup.plan.days[WEST_DAY].morning.length === 1
    && dup.warnings.some((w) => w.code === "duplicate_stop"),
  JSON.stringify(dup.warnings));

const over = seasonPlans.validate({
  bucketCap: 2,
  days: { [WEST_DAY]: { label: "R5", morning: ["A", "B", "C"], afternoon: [] } }
});
ok("a bucket over its cap warns but still imports",
  over.plan.days[WEST_DAY].morning.length === 3
    && over.warnings.some((w) => w.code === "bucket_over_cap"),
  "Patrick is allowed to decide a bucket holds three");

for (const [label, bad] of [
  ["a plan with no days", { days: {} }],
  ["a date that is not a calendar date", { days: { "2026-02-31": { morning: [] } } }],
  ["a garbled date", { days: { "next tuesday": { morning: [] } } }],
  ["a bucket that is not a list", { days: { [WEST_DAY]: { morning: "P-A" } } }]
]) {
  let threw = false;
  try { seasonPlans.validate(bad); } catch { threw = true; }
  ok(`import refuses ${label}`, threw);
}

ok("real calendar dates are accepted", seasonPlans.isRealDate("2026-09-28"));
ok("impossible calendar dates are refused", !seasonPlans.isRealDate("2026-02-30"));
ok("season+year keys match the seed file", seasonPlans.planKey("fall", 2026) === "fall-2026");

// ---- 9. Booking-made days (Patrick, ads live: "newly booked
// appointments must populate") ----------------------------------------
// A day the plan never routed but a real booking sits on becomes a
// shape of its own: the probe can show it, and the booking page
// measures the next customer against it instead of offering the day to
// anyone at any distance.

const AD_DAY = dayKey(plusDays(9));                   // Wed 23 Sep — not in the plan
// The ad customer booked in Mississauga; the day's whole shape is that
// one house. A second Mississauga caller inserts for pennies; a Keswick
// caller (40+ km the other way) must not share the day.
const adBooking = { start: `${AD_DAY}T13:00:00`, coords: { lat: 43.5890, lng: -79.6441, source: "google" }, propertyId: "P-AD" };
const KESWICK = { lat: 44.240, lng: -79.462, source: "google" };
const shapesWithAd = geoFilter.buildDayShapes({ plan, propertiesByCode, bookings: [adBooking] });
ok("a booking on an unplanned day creates that day's shape",
  Boolean(shapesWithAd[AD_DAY]) && shapesWithAd[AD_DAY].bookingsOnly === true
  && shapesWithAd[AD_DAY].points.length === 1 && shapesWithAd[AD_DAY].bookedCount === 1
  && shapesWithAd[AD_DAY].plannedCount === 0,
  JSON.stringify(shapesWithAd[AD_DAY]));
ok("a booking-made day inherits the plan's bucket cap",
  shapesWithAd[AD_DAY].bucketCap === 5);
ok("planned days are byte-identical with the extra booking elsewhere",
  JSON.stringify(shapesWithAd[WEST_DAY]) === JSON.stringify(shapes[WEST_DAY])
  && JSON.stringify(shapesWithAd[NORTH_DAY]) === JSON.stringify(shapes[NORTH_DAY]));
ok("an unresolved booking on an unplanned day makes no shape",
  !geoFilter.buildDayShapes({ plan, propertiesByCode,
    bookings: [{ start: `${AD_DAY}T13:00:00`, coords: UNGEOCODED }] })[AD_DAY]);
ok("two bookings at the same rounded point on a booking-made day count once",
  geoFilter.buildDayShapes({ plan, propertiesByCode,
    bookings: [adBooking, { ...adBooking, propertyId: "P-AD2" }] })[AD_DAY].points.length === 1);

// The outcome through the REAL engine: a Mississauga caller is offered
// the booking-made day (the booking is a west-side house), while a
// customer far from that booking is suppressed on it but keeps truly
// empty days.
const adDiag = { geoSuppressed: [] };
const adFiltered = await listAvailableSlots({
  ...baseArgs, customerCoords: MISSISSAUGA, dayShapes: shapesWithAd, diagnostics: adDiag
});
ok("a near customer IS offered the booking-made day",
  datesOf(adFiltered).has(AD_DAY));
const farDiag = { geoSuppressed: [] };
const farFiltered = await listAvailableSlots({
  ...baseArgs, customerCoords: KESWICK, dayShapes: shapesWithAd, diagnostics: farDiag
});
ok("a far customer is SUPPRESSED on the booking-made day — no more 80-km day-sharing",
  !datesOf(farFiltered).has(AD_DAY)
  && farDiag.geoSuppressed.some((g) => g.date === AD_DAY),
  JSON.stringify(farDiag.geoSuppressed));
ok("…but the far customer still sees days with nothing on them at all",
  datesOf(farFiltered).size > 0);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-geo-availability: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-geo-availability: ${pass} assertions passed`);
console.log(`  Mississauga → west day +${west.minutes} min (offered) · north day +${north.minutes} min (suppressed)`);

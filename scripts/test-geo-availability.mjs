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

const { listAvailableSlots, expandDaysToRange, recommendDays, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

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

// ---- 10. Customer best-day stars (Patrick: "we never suggest to
//          customers the best possible day for them to book") ---------

// Through the real engine: the Mississauga caller's day rows, spanning
// the planned west day (+7), the suppressed north day (+8), the
// booking-made ad day (+9), and two truly empty days (+10, +11).
const recDays = recommendDays(expandDaysToRange(adFiltered, {
  from: plusDays(7), to: plusDays(11), hours: DEFAULT_HOURS, now: NOW,
  geoSuppressed: adDiag.geoSuppressed
}));
const recRow = (key) => recDays.find((d) => d.date === key);
ok("the booking-made day next door is starred",
  recRow(AD_DAY)?.recommended === true, JSON.stringify(recRow(AD_DAY)));
ok("the planned west day is starred",
  recRow(WEST_DAY)?.recommended === true, JSON.stringify(recRow(WEST_DAY)));
ok("the day next to an existing booking costs no more than the farther planned route",
  // (the estimate rounds to a 5-minute floor, so a tie is legitimate)
  Number.isFinite(recRow(AD_DAY)?.addedDriveMinutes)
  && Number.isFinite(recRow(WEST_DAY)?.addedDriveMinutes)
  && recRow(AD_DAY).addedDriveMinutes <= recRow(WEST_DAY).addedDriveMinutes,
  `ad +${recRow(AD_DAY)?.addedDriveMinutes} vs west +${recRow(WEST_DAY)?.addedDriveMinutes}`);
ok("a truly empty day is offered but never starred — no fake 'best days'",
  recDays.some((d) => d.slots.length && d.slots[0].addedDriveMinutes == null && !d.recommended)
  && recDays.every((d) => !d.recommended || Number.isFinite(d.addedDriveMinutes)),
  JSON.stringify(recDays.map((d) => ({ date: d.date, rec: !!d.recommended, cost: d.addedDriveMinutes }))));
ok("a suppressed day row is untouched by the recommender",
  recRow(NORTH_DAY)?.reason === "outside_route_area" && !recRow(NORTH_DAY)?.recommended);

// The cap, in isolation: five priced days in, exactly the three
// cheapest come back starred, and the array is annotated in place.
const capIn = [40, 10, 25, 5, 30].map((cost, i) => ({
  date: `2026-10-0${i + 1}`, slots: [{ addedDriveMinutes: cost }]
}));
const capOut = recommendDays(capIn);
ok("recommendDays caps at three and picks the cheapest, in place",
  capOut === capIn
  && capIn.filter((d) => d.recommended).map((d) => d.date).sort().join(",")
     === "2026-10-02,2026-10-03,2026-10-04",
  JSON.stringify(capIn.map((d) => ({ date: d.date, rec: !!d.recommended }))));
ok("recommendDays survives an empty or slotless list",
  recommendDays([]).length === 0
  && recommendDays([{ date: "2026-10-01", slots: [], reason: "no_availability" }])[0].recommended === undefined);

// ---- 7b. Bucket-coherent geography — the double-drive fix ------------
//
// Patrick, 2026-09-07, from the load-test data: on one booked-only day
// the crew got Etobicoke at noon, Whitby at 1:30, Etobicoke again at 4,
// Whitby again at 7 — the 401 crossed twice. Cause: the day was scored
// as one blob, so a Whitby caller read "cheap" off the day and could
// book the MORNING even though the morning was the west cluster. Scoring
// each bucket against ITS OWN stops funnels a region into one half.

// A booked-only day whose MORNING already holds a west cluster
// (Etobicoke, from WEST) and whose AFTERNOON holds one east booking.
const BUCKET_DAY = dayKey(plusDays(10));               // Thu 24 Sep, not planned
const etobicokeAM = { start: `${BUCKET_DAY}T09:00:00`, coords: { ...WEST[0].coords }, propertyId: "P-AM" };
const whitbyPM = { start: `${BUCKET_DAY}T13:30:00`, coords: { lat: 43.884, lng: -78.941, source: "google" }, propertyId: "P-PM" };
const WHITBY = { lat: 43.897, lng: -78.930, source: "google" }; // a second Whitby caller
const bucketShapes = geoFilter.buildDayShapes({ plan, propertiesByCode, bookings: [etobicokeAM, whitbyPM] });

ok("the booked day splits into morning/afternoon clusters",
  bucketShapes[BUCKET_DAY].bucketPoints.morning.length === 1
  && bucketShapes[BUCKET_DAY].bucketPoints.afternoon.length === 1,
  JSON.stringify(bucketShapes[BUCKET_DAY].bucketPoints));

const bucketDiag = { geoSuppressed: [] };
const whitbySlots = (await listAvailableSlots({
  ...baseArgs, customerCoords: WHITBY, dayShapes: bucketShapes, diagnostics: bucketDiag
})).filter((s) => dayKey(new Date(s.start)) === BUCKET_DAY);
const bucketsOffered = whitbySlots.map((s) => s.bucketKey);
ok("a Whitby caller is offered the AFTERNOON (its cluster), not the west morning",
  bucketsOffered.includes("afternoon") && !bucketsOffered.includes("morning"),
  `offered buckets: ${bucketsOffered.join(", ") || "none"}`);
ok("the west morning bucket is the one suppressed for the Whitby caller",
  bucketDiag.geoSuppressed.some((g) => g.date === BUCKET_DAY && g.bucket === "morning"),
  JSON.stringify(bucketDiag.geoSuppressed));
ok("the afternoon slot carries an honest low insertion cost against its own cluster",
  Number.isFinite(whitbySlots.find((s) => s.bucketKey === "afternoon")?.addedDriveMinutes)
  && whitbySlots.find((s) => s.bucketKey === "afternoon").addedDriveMinutes <= 15);

// The other direction: an Etobicoke caller lands in the morning, never
// the east afternoon — the west cluster stays west.
const etoDiag = { geoSuppressed: [] };
const etoSlots = (await listAvailableSlots({
  ...baseArgs, customerCoords: { lat: WEST[0].coords.lat, lng: WEST[0].coords.lng, source: "google" },
  dayShapes: bucketShapes, diagnostics: etoDiag
})).filter((s) => dayKey(new Date(s.start)) === BUCKET_DAY);
ok("an Etobicoke caller is offered the MORNING (its cluster), not the east afternoon",
  etoSlots.map((s) => s.bucketKey).includes("morning")
  && !etoSlots.map((s) => s.bucketKey).includes("afternoon"),
  `offered buckets: ${etoSlots.map((s) => s.bucketKey).join(", ") || "none"}`);

// The barbell guard: an empty bucket on a day that already has a cluster
// is NOT a free landing pad for a far region. A Keswick caller (north,
// far from both) gets neither bucket on this west/east day.
const kesDiag = { geoSuppressed: [] };
const kesSlots = (await listAvailableSlots({
  ...baseArgs, customerCoords: KESWICK, dayShapes: bucketShapes, diagnostics: kesDiag
})).filter((s) => dayKey(new Date(s.start)) === BUCKET_DAY);
ok("a far caller gets NEITHER half of a day that already has a geography (no new barbell)",
  kesSlots.length === 0, `offered buckets: ${kesSlots.map((s) => s.bucketKey).join(", ")}`);

// ---- 8. The corridor is elastic, but it stops at 40 minutes ---------
//
// Patrick, 2026-09-07: "as the dates fill up, we allow for drive times
// to widen. we NEVER turn down a customer." When the tight corridor
// leaves an address fewer than GEO_WIDEN_MIN_DAYS bookable days, the
// scan reruns at the next tier — 25, then 40, and no further.
//
// The cap is the second half of the same call, made after a Markham
// address landed on a "West of the 400" day: past 40 minutes we stop
// buying a date with an hour of extra driving and let the OPEN BUCKET
// take the customer instead. Nobody is turned down; the first-available
// card is always on the picker. Every day in this fixture carries the
// NORTH shape, so there are no unplanned days to fall back on — the
// ladder is the only thing between these callers and an empty calendar.

const { GEO_WIDEN_TIERS, GEO_WIDEN_MIN_DAYS } = availability;
const AURORA = { lat: 43.9997, lng: -79.4663, source: "google" };        // +17 min — inside the cap
const RICHMOND_HILL = { lat: 43.8828, lng: -79.4403, source: "google" }; // +61 min — past it

const allNorthPlan = { generatedAt: NOW.toISOString(), bucketCap: 5, dayCap: 10, days: {} };
for (let i = 0; i < 20; i++) { // every day the 20-day scan can reach
  const d = plusDays(i);
  if (d.getDay() === 0) continue; // Sundays are closed
  allNorthPlan.days[dayKey(d)] = { label: "R1", morning: NORTH.map((p) => p.code), afternoon: [] };
}
const allNorthShapes = geoFilter.buildDayShapes({ plan: allNorthPlan, propertiesByCode, bookings: [] });
const anyNorthShape = allNorthShapes[Object.keys(allNorthShapes)[0]];

ok("the ladder stops at 40 minutes — no 60/90-minute detours are on offer",
  Math.max(...GEO_WIDEN_TIERS) === 40, JSON.stringify(GEO_WIDEN_TIERS));

// Inside the cap: widening still rescues a customer the tight corridor
// would have blanked.
const auroraCost = await geoFilter.addedDriveMinutes(AURORA, anyNorthShape.points);
ok("fixture: Aurora costs past the tight corridor but inside the 40-minute cap",
  auroraCost.minutes > 15 && auroraCost.minutes <= 40, `+${auroraCost.minutes} min`);

const wideDiag = { geoSuppressed: [], seasonClosed: [] };
const widened = await listAvailableSlots({
  ...baseArgs, customerCoords: AURORA, dayShapes: allNorthShapes, diagnostics: wideDiag
});
ok("a customer inside the cap still gets days — the corridor widened",
  datesOf(widened).size >= GEO_WIDEN_MIN_DAYS,
  `offered ${datesOf(widened).size} days`);
ok("the widened corridor is reported and is one of the ladder's tiers",
  GEO_WIDEN_TIERS.includes(wideDiag.geoWidenedTo) && wideDiag.geoWidenedTo >= auroraCost.minutes,
  `geoWidenedTo=${wideDiag.geoWidenedTo}`);
ok("widened slots keep their TRUE added-drive cost — the stars still rank honestly",
  widened.every((s) => Number.isFinite(s.addedDriveMinutes) && s.addedDriveMinutes > 15),
  JSON.stringify(widened.slice(0, 2).map((s) => s.addedDriveMinutes)));

// Past the cap: no days at all, however empty the customer's calendar —
// this is the Markham-on-a-west-day case, and the open bucket owns it.
const rhCost = await geoFilter.addedDriveMinutes(RICHMOND_HILL, anyNorthShape.points);
ok("fixture: Richmond Hill costs past the 40-minute cap but inside the service area",
  rhCost.minutes > 40 && rhCost.minutes <= 90, `+${rhCost.minutes} min`);
const overDiag = { geoSuppressed: [] };
const overCap = await listAvailableSlots({
  ...baseArgs, customerCoords: RICHMOND_HILL, dayShapes: allNorthShapes, diagnostics: overDiag
});
ok("past 40 minutes the ladder stops — no day is offered, the open bucket takes them",
  datesOf(overCap).size === 0, `offered: ${[...datesOf(overCap)].join(", ")}`);
ok("and it never reports widening past the cap",
  (overDiag.geoWidenedTo === undefined || overDiag.geoWidenedTo <= 40),
  `geoWidenedTo=${overDiag.geoWidenedTo}`);

// The far end is unchanged: a cross-region address was never routable.
const missCost = await geoFilter.addedDriveMinutes(MISSISSAUGA, anyNorthShape.points);
ok("fixture: Mississauga is far beyond any tier", missCost.minutes > 90, `+${missCost.minutes} min`);
const farDiag2 = { geoSuppressed: [] };
const farWiden = await listAvailableSlots({
  ...baseArgs, customerCoords: MISSISSAUGA, dayShapes: allNorthShapes, diagnostics: farDiag2
});
ok("a cross-region address still gets no days — open bucket is the overflow",
  datesOf(farWiden).size === 0,
  `offered: ${[...datesOf(farWiden)].join(", ")}`);

// A calendar that already offers enough days never widens: the original
// mixed fixture gave Mississauga the west day plus unplanned days at the
// TIGHT corridor, and its diagnostics carry no widening marker.
ok("a calendar with enough days at the tight corridor never widens",
  diagnostics.geoWidenedTo === undefined);

// ---- 9. A MISSING SEASON PLAN MUST NOT SWITCH GEOGRAPHY OFF ----------
//
// The hole that made every corridor fix look like it "wasn't taking."
// buildDayShapes returned {} the moment a plan was absent, and
// dayShapesForSeason turned that into null — which the engine reads as
// "no gate at all." A fresh bot run put Thornhill in a morning that
// already held Newmarket: 88 minutes of added drive against a 15-minute
// cap, allowed because the rule was never consulted (Patrick, 2026-09-09,
// looking at Newmarket → Thornhill → Newmarket on one day: "it still
// isn't taking whatsoever").
//
// The bookings alone are enough to shape a day — that is exactly what the
// booking-only pass already did INSIDE a plan. The plan adds routed stops;
// it was never what made geography apply.

const NEWMARKET_PT = { lat: 44.056, lng: -79.462, source: "google" };
const THORNHILL_PT = { lat: 43.815, lng: -79.420, source: "google" };
const GATE_DAY = "2026-09-23";        // inside the 20-day horizon, and a day the plan never routes
const nmBooking = {
  id: "BK-NM", start: `${GATE_DAY}T08:00:00`, coords: NEWMARKET_PT,
  propertyId: "P-NM", status: "confirmed"
};

// The pair is far apart enough that no tier on the ladder reaches it.
const nmToTh = await geoFilter.addedDriveMinutes(THORNHILL_PT, [NEWMARKET_PT]);
ok("fixture: Thornhill into a Newmarket morning is way past every tier",
  nmToTh.minutes > 40, `+${nmToTh.minutes} min`);

// With NO plan at all, the day still gets a shape from its booking.
const noPlanShapes = geoFilter.buildDayShapes({
  plan: null, propertiesByCode: new Map(), bookings: [nmBooking]
});
ok("a booked day is shaped even with no season plan",
  Boolean(noPlanShapes[GATE_DAY]), Object.keys(noPlanShapes).join(", ") || "(none)");
ok("…and the booking is in it", (noPlanShapes[GATE_DAY]?.points || []).length === 1);
ok("…in the morning bucket, where it was booked",
  (noPlanShapes[GATE_DAY]?.bucketPoints?.morning || []).length === 1);

// Non-vacuity first: with the gate genuinely off, this day IS offered.
// Without this the refusal below would pass for the wrong reason — a day
// outside the horizon is "not offered" too, and that is how an assertion
// quietly stops testing anything.
const gateOffDates = datesOf(await listAvailableSlots({
  ...baseArgs, customerCoords: THORNHILL_PT, bookings: [nmBooking], dayShapes: null
}));
ok("control: with geography off, Thornhill IS offered the Newmarket day",
  gateOffDates.has(GATE_DAY), `offered: ${[...gateOffDates].join(", ")}`);

const gateSlots = await listAvailableSlots({
  ...baseArgs, customerCoords: THORNHILL_PT, bookings: [nmBooking], dayShapes: noPlanShapes
});
const gateDates = datesOf(gateSlots);
ok("with no season plan, geography STILL refuses the far booking",
  !gateDates.has(GATE_DAY), `offered ${GATE_DAY}`);

// An undefined plan must behave the same as a null one — dayShapesForSeason
// can hand over either.
const undefPlanShapes = geoFilter.buildDayShapes({
  propertiesByCode: new Map(), bookings: [nmBooking]
});
ok("an absent plan argument shapes the day too", Boolean(undefPlanShapes[GATE_DAY]));

// And the day nobody has booked stays open to everyone — the fix must not
// close down an empty calendar.
const untouched = "2026-09-24";
ok("a day with no plan and no booking stays open to anyone",
  !noPlanShapes[untouched], "an unbooked day should carry no shape");

// The other half of the hole lived in server.js: dayShapesForSeason
// returned null the moment getPlan came back empty, and null is read by
// the engine as "no gate." Shapes built from bookings are worth nothing if
// the caller never asks for them.
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
const dsAt = SERVER_SRC.indexOf("async function dayShapesForSeason(");
ok("dayShapesForSeason still exists", dsAt !== -1);
const dsBody = dsAt === -1 ? "" : SERVER_SRC.slice(dsAt, SERVER_SRC.indexOf("\n}", dsAt));
ok("a missing season plan no longer returns null instead of shapes",
  !/if \(!plan\) return null;/.test(dsBody));
ok("…it builds shapes from the bookings anyway",
  /buildDayShapes\(\{\s*\n?\s*plan: plan \|\| null/.test(dsBody)
  || dsBody.includes("plan: plan || null"));

// ---- 10. THE AGGREGATE GUARD: no crossing the city inside one day ----
//
// Cause C-D. The per-booking check is MARGINAL — it asks "what does this
// one stop add?" and never looks at the day as a whole. Worse, it is
// ASYMMETRIC, because every route starts and ends at the Newmarket yard:
//
//   Thornhill into a morning holding Newmarket   +88 min  → refused
//   Newmarket into a morning holding Thornhill    +4 min  → allowed
//   Aurora into a day holding both                 +0 min → allowed
//
// So the barbell only ever forms one way round: the far cluster lands
// first, then home-turf customers slot in at +4 apiece and every one of
// them passes. That is why Patrick kept seeing Newmarket → Thornhill →
// Newmarket after several rounds of corridor work.
//
// WHY NOT A TOTAL-DRIVE CAP, which the spec proposed at 150 minutes.
// Measured on real coordinates:
//
//   Newmarket ×2                      commute 10, between stops  5
//   Thornhill ×2 (far, but tight)     commute 94, between stops  5
//   Newmarket → Thornhill             commute 52, between stops 46
//
// Total drive is 99 for the good Thornhill day and 98 for the barbell.
// A total cap cannot tell them apart, and 150 admits both. Every cluster
// pays to get out and back wherever it sits; what makes a day bad is
// crossing the city INSIDE it. So the rule is the longest leg BETWEEN
// consecutive stops, which is 5 for either tight day and 46 for the
// barbell — and which is symmetric, so it catches Newmarket joining a
// Thornhill day exactly as hard as the reverse.

const NM_A = { lat: 44.056, lng: -79.462, source: "google" };   // Newmarket
const NM_B = { lat: 44.048, lng: -79.480, source: "google" };   // Newmarket
const TH_A = { lat: 43.815, lng: -79.420, source: "google" };   // Thornhill
const TH_B = { lat: 43.806, lng: -79.437, source: "google" };   // Thornhill
const AGG_DAY = "2026-09-25";

const booked = (id, coords, hhmm) => ({
  id, start: `${AGG_DAY}T${hhmm}:00`, coords, propertyId: id, status: "confirmed"
});
const shapesFor = (bookings) =>
  geoFilter.buildDayShapes({ plan: null, propertiesByCode: new Map(), bookings });

// The fixture that beats today's engine: a day already holding Thornhill.
const thornhillDay = [booked("BK-TH1", TH_A, "08:00"), booked("BK-TH2", TH_B, "09:00")];

// It passes the marginal check with room to spare — that is the bug.
const marginal = await geoFilter.addedDriveMinutes(NM_A, [TH_A, TH_B]);
ok("fixture: a Newmarket stop looks cheap against a Thornhill day",
  marginal.minutes <= 15, `+${marginal.minutes} min — no longer cheap, fixture is stale`);

const aggDates = datesOf(await listAvailableSlots({
  ...baseArgs, customerCoords: NM_A, bookings: thornhillDay, dayShapes: shapesFor(thornhillDay),
  now: new Date(2026, 8, 14, 9, 0, 0)
}));
ok("a Newmarket customer is NOT offered a Thornhill day",
  !aggDates.has(AGG_DAY),
  `offered ${AGG_DAY} — the barbell is still being composed`);

// The mirror case must still be refused too — this half already worked,
// and must keep working.
const newmarketDay = [booked("BK-NM1", NM_A, "08:00"), booked("BK-NM2", NM_B, "09:00")];
const mirrorDates = datesOf(await listAvailableSlots({
  ...baseArgs, customerCoords: TH_A, bookings: newmarketDay, dayShapes: shapesFor(newmarketDay),
  now: new Date(2026, 8, 14, 9, 0, 0)
}));
ok("…and a Thornhill customer is still not offered a Newmarket day",
  !mirrorDates.has(AGG_DAY), `offered ${AGG_DAY}`);

// A FAR BUT TIGHT DAY IS NOT THE PROBLEM. Patrick must still be able to
// run a full Thornhill route: a second Thornhill customer joins the first.
const tightDates = datesOf(await listAvailableSlots({
  ...baseArgs, customerCoords: TH_B, bookings: [booked("BK-TH1", TH_A, "08:00")],
  dayShapes: shapesFor([booked("BK-TH1", TH_A, "08:00")]),
  now: new Date(2026, 8, 14, 9, 0, 0)
}));
ok("a Thornhill customer CAN join a Thornhill day, far from base though it is",
  tightDates.has(AGG_DAY),
  "the guard is banning legitimate far-side route days");

// And the first booking on an empty day is never refused — somebody has
// to seed a cluster, and a day with no stops has no spread to measure.
const seedDates = datesOf(await listAvailableSlots({
  ...baseArgs, customerCoords: TH_A, bookings: [], dayShapes: shapesFor([]),
  now: new Date(2026, 8, 14, 9, 0, 0)
}));
ok("the first customer of the day is never refused for spread",
  seedDates.size > 0, "an empty calendar is being closed down");

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-geo-availability: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-geo-availability: ${pass} assertions passed`);
console.log(`  Mississauga → west day +${west.minutes} min (offered) · north day +${north.minutes} min (suppressed)`);

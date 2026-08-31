// Booking guards — bucket capacity and the season gate.
// Stage 1 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-booking-guards.mjs
//
// WHAT THIS PROTECTS. Two new refusals in server/lib/availability.js:
//
//   1. BUCKET CAPACITY. A season-plan bucket holds bucketCap jobs
//      (default 5). Before this gate, a day with five planned stops in
//      the morning would still offer a morning slot to a sixth caller —
//      the planned stops aren't bookings yet, so the travel math never
//      saw them. Now the bucket's load is planned stops + unplanned
//      bookings, and a bucket at capacity disappears from availability.
//      The accounting must not charge one house twice: a planned
//      customer who books themselves converts their stop into a booking,
//      and a planned customer asking for their own bucket adds no load.
//
//   2. SEASON GATE. seasons.json's publicBookingThrough finally has its
//      consumer: days after the cutoff emit nothing for seasonal
//      services. Non-seasonal services (repair, retrofit, site visit)
//      book year-round and never consult it.
//
// THE REGRESSION IT MUST NOT CAUSE. FLOW-03 (/book.html) is PASS. Every
// pre-stage-1 shape — no dayShapes, a shape without bucketCap/buckets —
// must produce byte-identical slots. The off-switch is the data's
// absence, same discipline as the geography filter.
//
// NO NETWORK. GOOGLE_MAPS_SERVER_KEY is cleared so distance.js takes its
// Haversine fallback and every number is deterministic.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const availability = require(path.join(ROOT, "server/lib/availability.js"));
const geoFilter = require(path.join(ROOT, "server/lib/geo-filter.js"));
const seasons = require(path.join(ROOT, "server/lib/seasons.js"));

const { listAvailableSlots, expandDaysToRange, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures --------------------------------------------------------
//
// A Newmarket-area cluster so the geography filter, where it runs, is
// never the thing doing the refusing. Capacity scenarios switch the geo
// filter off entirely (geoMaxAddedDriveMinutes: 0) to isolate the gate.

const N1 = { lat: 44.0592, lng: -79.4613, source: "google" };  // Newmarket
const N2 = { lat: 44.0980, lng: -79.4430, source: "google" };  // Sharon
const N3 = { lat: 44.1030, lng: -79.4870, source: "google" };  // East Gwillimbury
const NEWCOMER = { lat: 44.0700, lng: -79.4500, source: "google" };  // not planned anywhere
const STRANGER = { lat: 44.0300, lng: -79.4700, source: "google" };  // unplanned booking

const propertiesByCode = new Map([
  ["P-N1", { code: "P-N1", id: "P-N1", coords: N1 }],
  ["P-N2", { code: "P-N2", id: "P-N2", coords: N2 }],
  ["P-N3", { code: "P-N3", id: "P-N3", coords: N3 }]
]);

// Pin "now" to a Monday; the planned day is the Monday a week out.
const NOW = new Date(2026, 8, 14, 9, 0, 0);          // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const DAY = dayKey(plusDays(7));                      // Mon 21 Sep — the planned day
const FREE_DAY = dayKey(plusDays(8));                 // Tue 22 Sep — no plan

const shapesFor = (plan, bookings = []) =>
  geoFilter.buildDayShapes({ plan, propertiesByCode, bookings });

// Geo filter off and season gate off: these scenarios test capacity,
// not geography and not the live seasons.json (whose real fall window —
// Sep 28 onward — would otherwise gate the fixture days).
const baseArgs = {
  serviceKey: "fall_close_4z",
  bookings: [],
  blocks: [],
  daysAhead: 10,
  hours: DEFAULT_HOURS,
  settings: { ...DEFAULT_SETTINGS, geoMaxAddedDriveMinutes: 0 },
  seasonWindows: () => null,
  now: NOW
};

// Which buckets does `slots` offer on a given date?
const bucketsOn = (slots, date) => new Set(
  slots.filter((s) => dayKey(new Date(s.start)) === date).map((s) => s.bucketKey)
);

// ---- 1. A full bucket disappears; its neighbour survives -------------

const planCap2 = {
  bucketCap: 2,
  days: { [DAY]: { label: "R1", morning: ["P-N1", "P-N2"], afternoon: ["P-N3"] } }
};

{
  const diagnostics = { bucketFull: [] };
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, dayShapes: shapesFor(planCap2), diagnostics
  });
  const offered = bucketsOn(slots, DAY);
  ok("a bucket at capacity is not offered to a new customer",
    !offered.has("morning"), `offered: ${[...offered].join(", ")}`);
  ok("the day's other bucket, with room left, is still offered",
    offered.has("afternoon"), `offered: ${[...offered].join(", ")}`);
  ok("an unplanned day is untouched by the cap",
    bucketsOn(slots, FREE_DAY).has("morning") && bucketsOn(slots, FREE_DAY).has("afternoon"));
  ok("the full bucket is reported with its arithmetic",
    diagnostics.bucketFull.length === 1
      && diagnostics.bucketFull[0].date === DAY
      && diagnostics.bucketFull[0].bucket === "morning"
      && diagnostics.bucketFull[0].planned === 2
      && diagnostics.bucketFull[0].booked === 0
      && diagnostics.bucketFull[0].cap === 2,
    JSON.stringify(diagnostics.bucketFull));
}

// ---- 2. A planned customer is not refused their own bucket -----------

{
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: N1, dayShapes: shapesFor(planCap2)
  });
  ok("a planned customer books into their own full bucket — their stop is already the load",
    bucketsOn(slots, DAY).has("morning"),
    "the plan itself put them there; refusing them is refusing the plan");
}

// ---- 3. A planned stop that booked itself is not counted twice -------

const bookedN1 = [{ start: `${DAY}T09:00:00`, end: `${DAY}T09:30:00`, coords: N1, leadId: "L-N1" }];

{
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: N2, bookings: bookedN1,
    dayShapes: shapesFor(planCap2, bookedN1)
  });
  ok("planned customer N1's own booking does not shrink the bucket for planned customer N2",
    bucketsOn(slots, DAY).has("morning"),
    "one house was charged as a planned stop AND a booking");

  const newcomer = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, bookings: bookedN1,
    dayShapes: shapesFor(planCap2, bookedN1)
  });
  ok("...and the bucket still refuses a newcomer — capacity did not grow either",
    !bucketsOn(newcomer, DAY).has("morning"));
}

// ---- 4. An unplanned booking consumes capacity -----------------------

const planCap3 = {
  bucketCap: 3,
  days: { [DAY]: { label: "R1", morning: ["P-N1", "P-N2"], afternoon: [] } }
};
const strangerBooking = [{ start: `${DAY}T09:00:00`, end: `${DAY}T09:30:00`, coords: STRANGER, leadId: "L-X" }];

{
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, bookings: strangerBooking,
    dayShapes: shapesFor(planCap3, strangerBooking)
  });
  ok("a booking from outside the plan counts against the bucket",
    !bucketsOn(slots, DAY).has("morning"),
    "2 planned + 1 stranger + 1 newcomer must exceed a cap of 3");
  ok("the empty afternoon bucket is unaffected",
    bucketsOn(slots, DAY).has("afternoon"));

  const planned = await listAvailableSlots({
    ...baseArgs, customerCoords: N1, bookings: strangerBooking,
    dayShapes: shapesFor(planCap3, strangerBooking)
  });
  ok("the planned customer still fits — their arrival adds nothing",
    bucketsOn(planned, DAY).has("morning"));
}

// ---- 5. An unresolved planned stop still consumes capacity -----------

{
  const planGhost = {
    bucketCap: 2,
    days: { [DAY]: { label: "R1", morning: ["P-N1", "P-GONE"], afternoon: [] } }
  };
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, dayShapes: shapesFor(planGhost)
  });
  ok("a planned code with no live property still holds its bucket space",
    !bucketsOn(slots, DAY).has("morning"),
    "an unresolved stop is still a job Patrick will spend the morning on");
}

// ---- 6. FLOW-03 regression guard: absent data = old behaviour --------

{
  const baseline = await listAvailableSlots({ ...baseArgs, customerCoords: NEWCOMER });
  const noCap = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER,
    dayShapes: shapesFor({ days: planCap2.days })          // plan without bucketCap
  });
  ok("a plan without a bucketCap gates nothing",
    JSON.stringify(noCap.map((s) => s.start)) === JSON.stringify(baseline.map((s) => s.start)));

  const legacyShape = { [DAY]: { label: "R1", points: [] } };  // pre-stage-1 shape, no buckets
  const legacy = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, dayShapes: legacyShape
  });
  ok("a shape from before stage 1 (no buckets field) gates nothing",
    JSON.stringify(legacy.map((s) => s.start)) === JSON.stringify(baseline.map((s) => s.start)));
  ok("with no dayShapes at all, the engine is untouched",
    baseline.length > 0 && bucketsOn(baseline, DAY).has("morning"));
}

// ---- 7. The season gate ----------------------------------------------

const CUTOFF = dayKey(plusDays(4));                    // Fri 18 Sep

{
  const calls = [];
  const diagnostics = { seasonClosed: [] };
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, daysAhead: 12, diagnostics,
    seasonWindows: (season, year) => {
      calls.push([season, year]);
      return { publicBookingThrough: CUTOFF };
    }
  });
  ok("the gate asks for the service's own season and the scanned year",
    calls.length > 0 && calls[0][0] === "fall" && calls[0][1] === 2026,
    JSON.stringify(calls));
  ok("season config is fetched once per year, not once per day",
    calls.length === 1, `${calls.length} lookups`);
  ok("no slot falls after publicBookingThrough",
    slots.length > 0 && slots.every((s) => dayKey(new Date(s.start)) <= CUTOFF),
    slots.filter((s) => dayKey(new Date(s.start)) > CUTOFF).map((s) => s.start).join(", "));
  ok("days inside the window still book",
    slots.some((s) => dayKey(new Date(s.start)) <= CUTOFF));
  ok("every gated open day is reported",
    diagnostics.seasonClosed.length > 0
      && diagnostics.seasonClosed.every((g) => g.date > CUTOFF && g.publicBookingThrough === CUTOFF),
    JSON.stringify(diagnostics.seasonClosed));

  const expanded = expandDaysToRange(slots, {
    from: plusDays(0), to: plusDays(11), hours: DEFAULT_HOURS, now: NOW,
    seasonClosed: diagnostics.seasonClosed
  });
  const gatedDay = expanded.find((d) => d.date === DAY);  // Mon 21 Sep, past the cutoff
  ok("a season-gated day reports season_closed, not no_availability",
    gatedDay?.reason === "season_closed", gatedDay?.reason);

  ok("a config without publicBookingFrom leaves the front of the season open",
    slots.some((s) => dayKey(new Date(s.start)) === dayKey(plusDays(1))),
    "the day after 'now' should book when only a cutoff is configured");
}

// ---- 7b. The front of the window: booking opens with the routes ------

{
  const OPENS = dayKey(plusDays(3));                   // Thu 17 Sep
  const diagnostics = { seasonClosed: [] };
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, daysAhead: 12, diagnostics,
    seasonWindows: () => ({ publicBookingFrom: OPENS, publicBookingThrough: CUTOFF })
  });
  ok("no slot falls before publicBookingFrom",
    slots.length > 0 && slots.every((s) => dayKey(new Date(s.start)) >= OPENS),
    slots.filter((s) => dayKey(new Date(s.start)) < OPENS).map((s) => s.start).join(", "));
  ok("the window between the two bounds still books",
    slots.some((s) => {
      const k = dayKey(new Date(s.start));
      return k >= OPENS && k <= CUTOFF;
    }));
  ok("nothing books past the cutoff when both bounds are set",
    slots.every((s) => dayKey(new Date(s.start)) <= CUTOFF));
  ok("a too-early day is reported against the OPENING bound",
    diagnostics.seasonClosed.some((g) => g.date < OPENS && g.publicBookingFrom === OPENS)
      && diagnostics.seasonClosed.some((g) => g.date > CUTOFF && g.publicBookingThrough === CUTOFF),
    JSON.stringify(diagnostics.seasonClosed));

  const expanded = expandDaysToRange(slots, {
    from: plusDays(0), to: plusDays(11), hours: DEFAULT_HOURS, now: NOW,
    seasonClosed: diagnostics.seasonClosed
  });
  const early = expanded.find((d) => d.date === dayKey(plusDays(1)));  // Tue 15 Sep
  ok("a not-yet-open day reports season_not_open — different copy from season_closed",
    early?.reason === "season_not_open", early?.reason);
  const late = expanded.find((d) => d.date === DAY);                   // Mon 21 Sep
  ok("...while a past-cutoff day still reports season_closed",
    late?.reason === "season_closed", late?.reason);
}

// ---- 8. Non-seasonal services never consult the season ---------------

{
  let asked = false;
  const slots = await listAvailableSlots({
    ...baseArgs, serviceKey: "sprinkler_repair", customerCoords: NEWCOMER, daysAhead: 12,
    seasonWindows: () => { asked = true; return { publicBookingThrough: CUTOFF }; }
  });
  ok("a repair booking never asks about seasons",
    asked === false);
  ok("...and books past the seasonal cutoff",
    slots.some((s) => dayKey(new Date(s.start)) > CUTOFF));
}

// ---- 9. A broken season config fails soft ----------------------------

{
  const slots = await listAvailableSlots({
    ...baseArgs, customerCoords: NEWCOMER, daysAhead: 12,
    seasonWindows: () => { throw new Error("seasons.json did not load"); }
  });
  ok("a season lookup that throws degrades to ungated availability",
    slots.some((s) => dayKey(new Date(s.start)) > CUTOFF),
    "a config typo must never take the booking page down");
}

// ---- 10. The default wiring reads the real seasons.json --------------

{
  const cfg = seasons.configFor("fall", 2026);
  ok("seasons.json resolves fall 2026 with a publicBookingThrough",
    Boolean(cfg && cfg.publicBookingThrough), JSON.stringify(cfg));
  ok("fall 2026 opens to the public on Sep 28, the first route day",
    cfg.publicBookingFrom === "2026-09-28", cfg.publicBookingFrom);

  // Before the season opens: a mid-September caller sees nothing until
  // Sep 28, even though trucks are serviceable from Sep 1.
  const earlySlots = await listAvailableSlots({
    serviceKey: "fall_close_4z", customerCoords: NEWCOMER,
    bookings: [], blocks: [], daysAhead: 20,
    hours: DEFAULT_HOURS,
    settings: { ...DEFAULT_SETTINGS, geoMaxAddedDriveMinutes: 0 },
    now: NOW                                            // Mon 14 Sep 2026
  });
  ok("with no injected override, no slot is offered before the real opening day",
    earlySlots.length > 0 && earlySlots.every((s) => dayKey(new Date(s.start)) >= cfg.publicBookingFrom),
    earlySlots.filter((s) => dayKey(new Date(s.start)) < cfg.publicBookingFrom).map((s) => s.start).join(", "));
  ok("...and days from Sep 28 onward do book",
    earlySlots.some((s) => dayKey(new Date(s.start)) >= "2026-09-28"));

  const [y, m, d] = cfg.publicBookingThrough.split("-").map(Number);
  const nearEnd = new Date(y, m - 1, d, 8, 0, 0);
  nearEnd.setDate(nearEnd.getDate() - 4);              // four days before the cutoff
  const slots = await listAvailableSlots({
    serviceKey: "fall_close_4z", customerCoords: NEWCOMER,
    bookings: [], blocks: [], daysAhead: 15,
    hours: DEFAULT_HOURS,
    settings: { ...DEFAULT_SETTINGS, geoMaxAddedDriveMinutes: 0 },
    now: nearEnd
  });
  ok("with no injected override, the real cutoff gates the scan",
    slots.length > 0 && slots.every((s) => dayKey(new Date(s.start)) <= cfg.publicBookingThrough),
    slots.filter((s) => dayKey(new Date(s.start)) > cfg.publicBookingThrough).map((s) => s.start).join(", "));
}

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-booking-guards: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-booking-guards: ${pass} assertions passed`);

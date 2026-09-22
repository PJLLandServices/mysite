// A half-day is entered from where the truck is, not from the yard.
//
//   node scripts/test-bucket-endpoints.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-21, with the day preview open —
// six planned stops through North York and downtown Toronto, the new
// house numbered 5 between Casa Loma and York Mills: "its literally
// perfect density on that appointment." The booking page priced it at
// +39 min. The morning (five stops, cap 5) was full, so the engine
// costed the house against the AFTERNOON's stops — as a round trip from
// Newmarket. Newmarket → Forest Hill → Don Mills is thirty-nine extra
// minutes; York Mills → Forest Hill → Don Mills, which is what the truck
// would actually drive, is a handful. The afternoon is now scored from
// the morning's last stop, and the morning is scored as leaving for the
// afternoon's first.
//
// Also pins the plan-screen control for the half-day cap (the other
// half of the same day: a sixth morning stop needs a cap of six).
//
// NO NETWORK: the Haversine fallback, like test-geo-availability.mjs.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const availability = require(path.join(ROOT, "server/lib/availability.js"));
const geoFilter = require(path.join(ROOT, "server/lib/geo-filter.js"));
const seasonPlans = require(path.join(ROOT, "server/lib/season-plans.js"));
const { listAvailableSlots, bucketVerdicts, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixture: Patrick's day, from the preview map ---------------------
const YARD = { lat: 44.0592, lng: -79.4613 };                         // Newmarket
const MORNING = [                                                     // driving order
  { code: "P-T1", coords: { lat: 43.7560, lng: -79.4530, source: "google" } },  // Bathurst Manor
  { code: "P-T2", coords: { lat: 43.7180, lng: -79.4420, source: "google" } },  // Lawrence / Allen
  { code: "P-T3", coords: { lat: 43.6680, lng: -79.3950, source: "google" } },  // ROM
  { code: "P-T4", coords: { lat: 43.6780, lng: -79.4090, source: "google" } },  // Casa Loma
  { code: "P-T6", coords: { lat: 43.7440, lng: -79.4060, source: "google" } }   // York Mills
];
const AFTERNOON = [
  { code: "P-T7", coords: { lat: 43.7290, lng: -79.3440, source: "google" } }   // Don Mills
];
const DUNVEGAN = { lat: 43.6905, lng: -79.4085, source: "google" };  // Forest Hill, between 4 and 6

const NOW = new Date(2026, 8, 14, 9, 0, 0);          // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const ROUTE_DAY = dayKey(plusDays(9));                // Wed 23 Sep

const propertiesByCode = new Map(
  [...MORNING, ...AFTERNOON].map((p) => [p.code, { code: p.code, id: p.code, coords: p.coords }])
);
const plan = {
  generatedAt: NOW.toISOString(),
  bucketCap: 5,
  dayCap: 10,
  days: { [ROUTE_DAY]: { label: "R-Toronto", morning: MORNING.map((p) => p.code), afternoon: AFTERNOON.map((p) => p.code) } }
};
const shapes = geoFilter.buildDayShapes({ plan, propertiesByCode, bookings: [] });
const shape = shapes[ROUTE_DAY];

// ---- 1. The number itself -------------------------------------------

const fromYard = await geoFilter.addedDriveMinutes(DUNVEGAN, shape.bucketPoints.afternoon, { base: YARD, exact: true });
const fromYorkMills = await geoFilter.addedDriveMinutes(DUNVEGAN, shape.bucketPoints.afternoon, {
  base: YARD, exact: true, start: shape.bucketPoints.morning[shape.bucketPoints.morning.length - 1]
});
ok("scored as a round trip from the yard, the afternoon reads expensive (the old +39)",
  fromYard.minutes > DEFAULT_SETTINGS.geoMaxAddedDriveMinutes, `+${fromYard.minutes} min`);
ok("scored from the morning's last stop, the same afternoon reads cheap",
  fromYorkMills.minutes <= DEFAULT_SETTINGS.geoMaxAddedDriveMinutes, `+${fromYorkMills.minutes} min`);
// The Haversine fallback flattens the gap (17 vs 12 offline; Google's road
// times read 39 vs a handful live) — the corridor is what the two
// assertions above pin, so only the direction is asserted here.
ok("...and strictly cheaper", fromYard.minutes > fromYorkMills.minutes,
  `${fromYard.minutes} vs ${fromYorkMills.minutes}`);
const wholeDay = await geoFilter.addedDriveMinutes(DUNVEGAN, shape.points, { base: YARD, exact: true });
ok("the whole day agrees the house is on the way", wholeDay.minutes <= 5, `+${wholeDay.minutes} min`);

// ---- 2. The engine, at the tight corridor -----------------------------

const baseArgs = {
  serviceKey: "fall_close_4z",
  customerCoords: DUNVEGAN,
  bookings: [],
  blocks: [],
  daysAhead: 12,
  hours: DEFAULT_HOURS,
  settings: DEFAULT_SETTINGS,
  seasonWindows: () => null,
  now: NOW
};
{
  const diagnostics = { geoSuppressed: [], seasonClosed: [], bucketFull: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: shapes, diagnostics });
  const v = bucketVerdicts(slots, diagnostics).get(ROUTE_DAY);
  ok("the morning is full at a cap of five", v && v.buckets.morning.status === "full", JSON.stringify(v && v.buckets.morning));
  ok("the afternoon is OPEN at the tight corridor — no widening needed",
    v && v.buckets.afternoon.status === "open" && diagnostics.geoWidenedTo === undefined,
    JSON.stringify({ afternoon: v && v.buckets.afternoon, widened: diagnostics.geoWidenedTo }));
  ok("...with the honest cost on the slot",
    v && v.buckets.afternoon.addedDriveMinutes === fromYorkMills.minutes,
    `${v && v.buckets.afternoon.addedDriveMinutes} vs ${fromYorkMills.minutes}`);
}

// ---- 3. Raising the cap opens the morning, where the house belongs ----

{
  const wider = { ...plan, bucketCap: 6 };
  const widerShapes = geoFilter.buildDayShapes({ plan: wider, propertiesByCode, bookings: [] });
  const diagnostics = { geoSuppressed: [], seasonClosed: [], bucketFull: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: widerShapes, diagnostics });
  const v = bucketVerdicts(slots, diagnostics).get(ROUTE_DAY);
  ok("with six per half-day the morning opens", v && v.buckets.morning.status === "open", JSON.stringify(v && v.buckets.morning));
  ok("...at next to nothing — it is on the way",
    v && v.buckets.morning.addedDriveMinutes <= 5, `+${v && v.buckets.morning.addedDriveMinutes} min`);
}

// ---- 4. The cap is editable from the plan screen ---------------------

{
  ok("season-plans exports setBucketCap", typeof seasonPlans.setBucketCap === "function");
  let refused = null;
  try { await seasonPlans.setBucketCap("fall", 2026, { bucketCap: 0 }); } catch (e) { refused = e.message; }
  ok("a cap of zero is refused before anything is read", /1 to 12/.test(refused || ""), refused);
  const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  ok("PATCH /api/season-plans/:season/:year/caps exists and calls setBucketCap",
    server.includes("/caps$/") && server.includes("seasonPlans.setBucketCap("));
  const html = fs.readFileSync(path.join(ROOT, "server/season-plan.html"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "server/season-plan.js"), "utf8");
  ok("the plan screen has the control and saves through the route",
    html.includes('id="capForm"') && client.includes("`${base()}/caps`") && client.includes("renderCap(plan)"));
}

if (failures.length) {
  console.error(`FAIL test-bucket-endpoints: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-bucket-endpoints — ${pass} assertions`);

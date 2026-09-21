// The elastic corridor widens on the customer's NEXT TWO WEEKS, not on
// the whole horizon.
//
//   node scripts/test-widen-near-window.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-21, fall closings live on the
// site: "customers won't find a time when visiting our website to get a
// fall closing." Read live against the public availability route, a
// Toronto address saw NO weekday at all from Sep 28 to Oct 19 — every
// planned route day refused at the 15-minute corridor — and its first
// offer was a Saturday morning two weeks in. The ladder that exists for
// exactly this ("as the dates fill up, we allow for drive times to
// widen. we NEVER turn down a customer", 2026-09-07) never ran, because
// it counted bookable days across the ENTIRE scan: three empty days a
// month out read as "enough", so the corridor stayed tight over the
// two weeks the customer was actually looking at.
//
// The rule now: scarcity is judged inside the first
// GEO_WIDEN_WINDOW_DAYS (14) offerable days. Fewer than
// GEO_WIDEN_MIN_DAYS there, with geography having refused something,
// and the scan reruns one tier wider — 25, then 40, and no further,
// exactly as before. A customer who already has three days in the next
// fortnight sees nothing change.
//
// NO NETWORK: the Haversine fallback, like test-geo-availability.mjs.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const availability = require(path.join(ROOT, "server/lib/availability.js"));
const geoFilter = require(path.join(ROOT, "server/lib/geo-filter.js"));
const {
  listAvailableSlots, DEFAULT_HOURS, DEFAULT_SETTINGS,
  GEO_WIDEN_TIERS, GEO_WIDEN_MIN_DAYS, GEO_WIDEN_WINDOW_DAYS
} = availability;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixture -----------------------------------------------------------
//
// Two weeks of planned north route days (Newmarket / Sharon / East
// Gwillimbury), then three empty weeks. An Aurora caller costs +17 min
// against that cluster: past the tight corridor, inside the 25 tier.
const NORTH = [
  { code: "P-N1", coords: { lat: 44.0592, lng: -79.4613, source: "google" } },
  { code: "P-N2", coords: { lat: 44.0980, lng: -79.4430, source: "google" } },
  { code: "P-N3", coords: { lat: 44.1030, lng: -79.4870, source: "google" } }
];
const AURORA = { lat: 43.9997, lng: -79.4663, source: "google" };

const NOW = new Date(2026, 8, 14, 9, 0, 0);          // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };

const propertiesByCode = new Map(NORTH.map((p) => [p.code, { code: p.code, id: p.code, coords: p.coords }]));
// Every open day of the customer's first fortnight (today included) is
// a planned north day; the three weeks after are empty.
const days = {};
for (let n = 0; n < 14; n++) {
  const d = plusDays(n);
  if (d.getDay() === 0) continue;
  days[dayKey(d)] = { label: `R${n + 1}`, morning: NORTH.map((p) => p.code), afternoon: [] };
}
const plan = { generatedAt: NOW.toISOString(), bucketCap: 5, dayCap: 10, days };
const shapes = geoFilter.buildDayShapes({ plan, propertiesByCode, bookings: [] });

const baseArgs = {
  serviceKey: "fall_close_4z",
  customerCoords: AURORA,
  bookings: [],
  blocks: [],
  daysAhead: 35,
  hours: DEFAULT_HOURS,
  settings: DEFAULT_SETTINGS,
  seasonWindows: () => null,
  now: NOW
};
const datesOf = (slots) => new Set(slots.map((s) => dayKey(new Date(s.start))));
// The engine's window opens on the first offerable day — today, a
// Monday with no season gate in this fixture.
const nearLimitKey = GEO_WIDEN_WINDOW_DAYS ? dayKey(plusDays(GEO_WIDEN_WINDOW_DAYS)) : "";
const isNear = (key) => key < nearLimitKey;

const cost = await geoFilter.addedDriveMinutes(AURORA, shapes[Object.keys(shapes)[0]].points);
ok("fixture: Aurora costs past the tight corridor and inside the first widen tier",
  cost.minutes > DEFAULT_SETTINGS.geoMaxAddedDriveMinutes && cost.minutes <= GEO_WIDEN_TIERS[0],
  `+${cost.minutes} min`);
ok("the window is a fortnight", GEO_WIDEN_WINDOW_DAYS === 14, String(GEO_WIDEN_WINDOW_DAYS));

// ---- 1. The customer's next two weeks are what decide widening -------

{
  const diagnostics = { geoSuppressed: [], seasonClosed: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: shapes, diagnostics });
  const offered = datesOf(slots);
  const near = [...offered].filter(isNear);
  const far = [...offered].filter((k) => !isNear(k));
  ok("the three empty weeks past the window are offered either way", far.length >= GEO_WIDEN_MIN_DAYS,
    `far days: ${far.length}`);
  ok("the corridor widened — the fortnight had nothing at 15 minutes",
    diagnostics.geoWidenedTo === GEO_WIDEN_TIERS[0], `geoWidenedTo=${diagnostics.geoWidenedTo}`);
  ok("...so the route days in the customer's next two weeks are offered",
    near.length >= GEO_WIDEN_MIN_DAYS, `near days offered: ${near.join(", ") || "none"}`);
  ok("widened slots keep their TRUE added-drive cost",
    slots.filter((s) => isNear(dayKey(new Date(s.start)))).every((s) => s.addedDriveMinutes === cost.minutes),
    JSON.stringify(slots.slice(0, 2).map((s) => s.addedDriveMinutes)));
}

// ---- 2. Enough days in the fortnight → nothing changes ----------------

{
  // Leave three of the fortnight's days unplanned: they are offered at
  // the tight corridor, so no widening, and the planned days stay refused.
  const sparse = { ...plan, days: { ...days } };
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, 3)) delete sparse.days[k];
  const sparseShapes = geoFilter.buildDayShapes({ plan: sparse, propertiesByCode, bookings: [] });
  const diagnostics = { geoSuppressed: [], seasonClosed: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: sparseShapes, diagnostics });
  const offered = datesOf(slots);
  ok("a fortnight that already offers three days never widens",
    diagnostics.geoWidenedTo === undefined, `geoWidenedTo=${diagnostics.geoWidenedTo}`);
  ok("...and the planned days stay refused at the tight corridor",
    keys.slice(3).every((k) => !offered.has(k)), [...offered].join(", "));
}

// ---- 3. The ladder still stops at 40 --------------------------------

{
  const RICHMOND_HILL = { lat: 43.8828, lng: -79.4403, source: "google" }; // far past the cap
  const diagnostics = { geoSuppressed: [], seasonClosed: [] };
  const slots = await listAvailableSlots({ ...baseArgs, customerCoords: RICHMOND_HILL, dayShapes: shapes, diagnostics });
  const near = [...datesOf(slots)].filter(isNear);
  ok("past 40 minutes the fortnight stays closed — the open bucket takes them",
    near.length === 0, `near: ${near.join(", ")}`);
  ok("and widening never reports past the cap",
    diagnostics.geoWidenedTo === undefined || diagnostics.geoWidenedTo <= Math.max(...GEO_WIDEN_TIERS),
    `geoWidenedTo=${diagnostics.geoWidenedTo}`);
}

if (failures.length) {
  console.error(`FAIL test-widen-near-window: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-widen-near-window — ${pass} assertions`);

// The probe answers with the engine's verdict, not its own.
//
//   node scripts/test-probe-verdicts.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-21, on the season-plan probe:
// "i have the ability to book 46 dunvegan rd on thursday 22 but its not
// allowing me to." The probe table read "R11 · +2 min · yes" and the
// Book form under it read "No bookable window on this day". Two readers
// of one question — is this address offered this day? — had drifted:
// the probe judged by whole-day cheapest insertion alone, while the
// booking engine also scores geography per half-day, caps the day's
// spread, and caps each half's capacity. This suite pins the one rule:
// bucketVerdicts() folds ONE engine run per date and half, and the probe
// route reads its "offered" from that.
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
const { listAvailableSlots, bucketVerdicts, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixture: a day whose morning is full and whose afternoon is far --
//
// Five Newmarket stops fill the morning at the plan's cap of 5; the
// afternoon holds one Acton stop, 60 km west. The caller lives two
// streets from the morning cluster.
const NEWMARKET = [
  { code: "P-N1", coords: { lat: 44.0592, lng: -79.4613, source: "google" } },
  { code: "P-N2", coords: { lat: 44.0620, lng: -79.4650, source: "google" } },
  { code: "P-N3", coords: { lat: 44.0560, lng: -79.4580, source: "google" } },
  { code: "P-N4", coords: { lat: 44.0640, lng: -79.4560, source: "google" } },
  { code: "P-N5", coords: { lat: 44.0570, lng: -79.4700, source: "google" } }
];
const ACTON = { code: "P-A1", coords: { lat: 43.6320, lng: -79.8710, source: "google" } };
const CALLER = { lat: 44.0605, lng: -79.4630, source: "google" };

const NOW = new Date(2026, 8, 14, 9, 0, 0);          // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; };
const ROUTE_DAY = dayKey(plusDays(7));                // Mon 21 Sep

const propertiesByCode = new Map(
  [...NEWMARKET, ACTON].map((p) => [p.code, { code: p.code, id: p.code, coords: p.coords }])
);

function planWithCap(bucketCap) {
  return {
    generatedAt: NOW.toISOString(),
    bucketCap,
    dayCap: 10,
    days: {
      [ROUTE_DAY]: { label: "R11", morning: NEWMARKET.map((p) => p.code), afternoon: [ACTON.code] }
    }
  };
}

const baseArgs = {
  serviceKey: "fall_close_4z",
  customerCoords: CALLER,
  bookings: [],
  blocks: [],
  daysAhead: 10,
  hours: DEFAULT_HOURS,
  settings: DEFAULT_SETTINGS,
  seasonWindows: () => null,
  now: NOW
};

// ---- 1. The drift, reproduced -----------------------------------------

{
  const shapes = geoFilter.buildDayShapes({ plan: planWithCap(5), propertiesByCode, bookings: [] });
  const oldProbeRule = await geoFilter.addedDriveMinutes(CALLER, shapes[ROUTE_DAY].points);
  ok("the OLD probe rule (whole-day insertion) calls the day cheap",
    oldProbeRule && oldProbeRule.minutes <= DEFAULT_SETTINGS.geoMaxAddedDriveMinutes,
    `whole-day +${oldProbeRule && oldProbeRule.minutes} min`);

  const diagnostics = { geoSuppressed: [], seasonClosed: [], bucketFull: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: shapes, diagnostics });
  const verdicts = bucketVerdicts(slots, diagnostics);
  const v = verdicts.get(ROUTE_DAY);
  ok("the engine reached the route day", Boolean(v), [...verdicts.keys()].join(", "));
  ok("...and does NOT offer it", v && v.offered === false,
    JSON.stringify(v));
  ok("the morning is refused as FULL, with the numbers",
    v && v.buckets.morning.status === "full" && v.buckets.morning.cap === 5 && v.buckets.morning.planned === 5,
    JSON.stringify(v && v.buckets.morning));
  ok("the afternoon is refused on geography (far or spread), never 'no window'",
    v && (v.buckets.afternoon.status === "far" || v.buckets.afternoon.status === "spread"),
    JSON.stringify(v && v.buckets.afternoon));
  ok("no slot was emitted for the day",
    !slots.some((s) => dayKey(new Date(s.start)) === ROUTE_DAY));
}

// ---- 2. Lift the cap: the same day opens, and the verdict says so ----

{
  const shapes = geoFilter.buildDayShapes({ plan: planWithCap(6), propertiesByCode, bookings: [] });
  const diagnostics = { geoSuppressed: [], seasonClosed: [], bucketFull: [] };
  const slots = await listAvailableSlots({ ...baseArgs, dayShapes: shapes, diagnostics });
  const v = bucketVerdicts(slots, diagnostics).get(ROUTE_DAY);
  ok("with a cap of 6 the day is offered", v && v.offered === true, JSON.stringify(v));
  ok("...through the morning, with its drive cost",
    v && v.buckets.morning.status === "open" && Number.isFinite(v.buckets.morning.addedDriveMinutes),
    JSON.stringify(v && v.buckets.morning));
  ok("the afternoon still reads as geography, not as open",
    v && v.buckets.afternoon.status !== "open", JSON.stringify(v && v.buckets.afternoon));
}

// ---- 3. Verdict folding on its own ------------------------------------

{
  const empty = bucketVerdicts([], {});
  ok("no slots, no diagnostics → no verdicts (the date is past the horizon)", empty.size === 0);

  const folded = bucketVerdicts(
    [{ start: new Date(2026, 9, 22, 12, 0).toISOString(), bucketKey: "afternoon", addedDriveMinutes: 13 }],
    {
      bucketFull: [{ date: "2026-10-22", bucket: "morning", planned: 5, booked: 1, cap: 5 }],
      geoSuppressed: [{ date: "2026-10-21", bucket: "morning", addedDriveMinutes: 34 },
        { date: "2026-10-21", bucket: "afternoon", addedDriveMinutes: 9, reason: "day_too_spread", addedLegMinutes: 41, worstLegMinutes: 46 }],
      seasonClosed: [{ date: "2026-10-31" }]
    }
  );
  const oct22 = folded.get("2026-10-22");
  ok("a slot in one half offers the day", oct22 && oct22.offered === true);
  ok("a full half carries planned + booked + cap",
    oct22 && oct22.buckets.morning.status === "full" && oct22.buckets.morning.booked === 1);
  const oct21 = folded.get("2026-10-21");
  ok("far and spread are told apart",
    oct21 && oct21.buckets.morning.status === "far" && oct21.buckets.afternoon.status === "spread"
      && oct21.buckets.afternoon.addedLegMinutes === 41 && oct21.offered === false);
  const oct31 = folded.get("2026-10-31");
  ok("a season-gated day marks both halves",
    oct31 && oct31.buckets.morning.status === "season" && oct31.buckets.afternoon.status === "season");
}

// ---- 4. The readers use it --------------------------------------------

{
  const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const probe = server.slice(server.indexOf('/probe$/'), server.indexOf("The open bucket (first available)"));
  ok("the probe route runs the real engine once and folds its verdicts",
    probe.includes("listAvailableSlots({") && probe.includes("bucketVerdicts(engineSlots, engineDiagnostics)"));
  ok("the probe's 'offered' is the engine's verdict",
    probe.includes("offered: verdict ? verdict.offered : corridorSaysYes"));
  ok("each day carries its per-half verdicts to the screen", probe.includes("buckets: verdict ? verdict.buckets : null"));

  const client = fs.readFileSync(path.join(ROOT, "server/season-plan.js"), "utf8");
  ok("the table shows a Morning and an Afternoon column",
    client.includes("<th>Morning</th><th>Afternoon</th>") && client.includes("function bucketVerdictText"));
  ok("every route day has a Book button; a refused day says 'Book anyway'",
    client.includes('day.offered ? "Book" : "Book anyway"') && !client.includes("if (day.offered) {"));
}

if (failures.length) {
  console.error(`FAIL test-probe-verdicts: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-probe-verdicts — ${pass} assertions`);

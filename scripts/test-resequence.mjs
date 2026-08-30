// Re-sequencer — stop order inside a bucket, and the noon rule.
//
//   node scripts/test-resequence.mjs
//
// WHAT THIS PROTECTS. Buckets are what the customer is told; the order
// inside one is never communicated, which is what makes it free to
// change. Two rules govern that freedom (spec §6) and both are load-
// bearing:
//
//   1. Reorder WITHIN a bucket, never ACROSS. A customer told "morning"
//      stays in the morning. If this ever slips, the plan silently breaks
//      a promise that has already been sent by email.
//
//   2. The morning must finish before 12:00. When no ordering achieves
//      that, FLAG the day — do not quietly hand back an overrun, and do
//      not "fix" it by moving someone to the afternoon, because that is
//      rule 1.
//
// The travel function is injected, so distances here are exact and the
// expected orderings are arithmetic rather than a guess about Ontario
// traffic. No network, no cache writes.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { sequenceDay, sequencePlan, suggestBucketMoves, onSiteMinutes } =
  require(path.join(ROOT, "server/lib/resequence.js"));
const { PJL_BASE } = require(path.join(ROOT, "server/lib/geocode.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures --------------------------------------------------------
//
// Stops on a grid, so travel is straight-line distance and the cheapest
// order is arithmetic rather than a guess. Base is the origin.
//
// A GRID, NOT A LINE. On a line the day's total is fixed by its extremes
// however the stops are split between buckets, so a line can show that
// ordering works but can never show a bucket move paying off. The grid
// puts one arm north and one east: visiting them alternately costs the
// diagonal twice, which is exactly the R1 failure this module exists to
// surface.
const XY = {
  A: [10, 0], B: [20, 0], C: [30, 0], D: [40, 0], E: [90, 0],   // east arm
  N1: [0, 10], N2: [0, 12]                                        // north arm
};
const at = ([x, y]) => ({ lat: 44 + x / 1000, lng: -79.5 + y / 1000, source: "google" });

function prop(code, xy, zones) {
  return {
    code, id: code, address: `${code} Test St`, town: "Testville",
    coords: at(xy),
    system: { zones: Array.from({ length: zones }, (_, i) => ({ number: i + 1 })) }
  };
}
// Zone counts pick the fall tier: 3 -> 30 min, 6 -> 35, 12 -> 75.
const props = new Map([
  ["A", prop("A", XY.A, 3)], ["B", prop("B", XY.B, 3)],
  ["C", prop("C", XY.C, 3)], ["D", prop("D", XY.D, 3)],
  ["E", prop("E", XY.E, 12)],
  ["N1", prop("N1", XY.N1, 3)], ["N2", prop("N2", XY.N2, 3)],
  ["NOGEO", { code: "NOGEO", id: "NOGEO", address: "No Geo Rd", coords: null, system: { zones: [] } }]
]);

const BASE = { lat: 44, lng: -79.5, source: "google" };
const gx = (c) => Math.round((c.lat - 44) * 1000);
const gy = (c) => Math.round((c.lng + 79.5) * 1000);
const travel = async (a, b) => Math.round(Math.hypot(gx(a) - gx(b), gy(a) - gy(b)));
const opts = { propertiesByCode: props, season: "fall", base: BASE, travel };

// ---- 1. It actually orders --------------------------------------------

const scrambled = await sequenceDay(
  { label: "T1", morning: ["C", "A", "D", "B"], afternoon: [] }, opts);
ok("a scrambled bucket comes back in driving order",
  scrambled.morning.join("") === "ABCD", scrambled.morning.join(","));
ok("driving is the sum of the legs plus the run home",
  scrambled.driveMinutes === 80, String(scrambled.driveMinutes));   // 0->40 out, 40 home

// ---- 2. Rule 1 — buckets are never crossed ----------------------------

const twoBuckets = await sequenceDay(
  { label: "T2", morning: ["D", "A"], afternoon: ["C", "B"] }, opts);
ok("morning keeps exactly its own stops",
  twoBuckets.morning.slice().sort().join("") === "AD", twoBuckets.morning.join(","));
ok("afternoon keeps exactly its own stops",
  twoBuckets.afternoon.slice().sort().join("") === "BC", twoBuckets.afternoon.join(","));
ok("no stop is lost or duplicated",
  [...twoBuckets.morning, ...twoBuckets.afternoon].sort().join("") === "ABCD");

// Even when moving one would plainly be cheaper, sequenceDay must not.
const wouldRatherMove = await sequenceDay(
  { label: "T3", morning: ["A", "E"], afternoon: ["B"] }, opts);
ok("a stop that belongs in the other bucket is still not moved",
  wouldRatherMove.morning.includes("E") && !wouldRatherMove.afternoon.includes("E"),
  "the re-sequencer crossed a bucket boundary");

// ---- 3. Rule 2 — the noon check ---------------------------------------

// Four 30-minute stops plus driving: comfortably inside the morning.
const fits = await sequenceDay({ label: "T4", morning: ["A", "B", "C"], afternoon: [] }, opts);
// 08:00 + (10 drive + 30 work) x3, legs of 10 = 10:00.
ok("a morning that fits reports its end time and no flag",
  fits.morningEndsAt === "10:00" && !fits.flags.some((f) => f.code === "morning_overruns"),
  `${fits.morningEndsAt} flags=${JSON.stringify(fits.flags)}`);

// E is 90 minutes out and a 75-minute job; with three others the morning
// cannot fit however it is ordered.
const overruns = await sequenceDay(
  { label: "T5", morning: ["A", "B", "C", "D", "E"], afternoon: [] }, opts);
const flag = overruns.flags.find((f) => f.code === "morning_overruns");
ok("a morning that cannot fit is flagged", Boolean(flag), JSON.stringify(overruns.flags));
ok("the flag says how late it runs",
  flag && flag.overrunMinutes > 0 && flag.endsAt > "12:00",
  flag ? `${flag.endsAt} +${flag.overrunMinutes}` : "no flag");
ok("flagging does NOT move anyone to the afternoon to make it fit",
  overruns.afternoon.length === 0 && overruns.morning.length === 5,
  "rule 2 was satisfied by breaking rule 1");

// ---- 4. The afternoon chains off wherever the morning ended -----------

const chained = await sequenceDay(
  { label: "T6", morning: ["A", "B"], afternoon: ["C", "D"] }, opts);
ok("the afternoon starts from the morning's last stop, not from base",
  chained.afternoon.join("") === "CD", chained.afternoon.join(","));
ok("the afternoon cannot start before 12:00",
  chained.timeline.find((t) => t.bucket === "afternoon").arriveAt >= "12:00",
  chained.timeline.find((t) => t.bucket === "afternoon").arriveAt);

// ---- 5. Stops without coordinates ------------------------------------

const missing = await sequenceDay(
  { label: "T7", morning: ["C", "NOGEO", "A"], afternoon: [] }, opts);
ok("an unroutable stop is kept, not dropped",
  missing.morning.includes("NOGEO") && missing.morning.length === 3, missing.morning.join(","));
ok("the routable stops around it are still ordered",
  missing.morning.indexOf("A") < missing.morning.indexOf("C"), missing.morning.join(","));
ok("the unroutable stop is flagged",
  missing.flags.some((f) => f.code === "unroutable_stop" && f.propertyCode === "NOGEO"));

// ---- 6. Timeline shape ------------------------------------------------

const timed = await sequenceDay({ label: "T8", morning: ["A", "B"], afternoon: ["C"] }, opts);
ok("every stop gets an arrival estimate", timed.timeline.length === 3);
ok("arrival estimates run forward in time",
  timed.timeline.every((t, i, arr) => i === 0 || arr[i - 1].leaveAt <= t.arriveAt),
  JSON.stringify(timed.timeline.map((t) => `${t.arriveAt}-${t.leaveAt}`)));
ok("on-site minutes come from the zone tier",
  timed.timeline[0].onSiteMinutes === 30 && timed.timeline[0].zones === 3);
ok("a property with no zones on file is marked estimated",
  onSiteMinutes({ system: { zones: [] } }, "fall").estimated === true);

// ---- 7. Suggestions — advice, never an action ------------------------

// Morning holds one stop from each arm, afternoon the rest — so the day
// runs north, east, north, east. Moving the stray east stop into the
// afternoon collapses that into one trip up each arm.
const before = { label: "T9", morning: ["N1", "A"], afternoon: ["N2", "B"] };
const suggestions = await suggestBucketMoves(before, { ...opts, bucketCap: 5 });
ok("a stop in the wrong bucket produces a suggestion",
  suggestions.some((x) => x.propertyCode === "A" && x.from === "morning"),
  JSON.stringify(suggestions));
ok("suggestions are sorted by how much they save",
  suggestions.every((x, i, a) => i === 0 || a[i - 1].savingMinutes >= x.savingMinutes));
ok("suggesting does not mutate the day",
  before.morning.join(",") === "N1,A" && before.afternoon.join(",") === "N2,B",
  "suggestBucketMoves changed the plan it was asked about");
ok("a full target bucket produces no suggestion into it",
  (await suggestBucketMoves({ label: "TA", morning: ["A"], afternoon: ["B", "C", "D"] },
    { ...opts, bucketCap: 3 })).every((x) => x.to !== "afternoon"));

// ---- 8. Whole-plan pass ----------------------------------------------

const { days, timings, flags } = await sequencePlan({
  days: {
    "2026-09-28": { label: "R1", morning: ["C", "A"], afternoon: ["D", "B"] },
    "2026-09-29": { label: "R2", morning: ["A", "B", "C", "D", "E"], afternoon: [] }
  }
}, opts);
ok("every day in a plan is sequenced", Object.keys(days).length === 2);
ok("plan-level flags carry the date and label",
  flags.some((f) => f.code === "morning_overruns" && f.date === "2026-09-29" && f.label === "R2"),
  JSON.stringify(flags));
ok("a stored day carries order only — no derived timing",
  ["timeline", "flags", "driveMinutes", "morningEndsAt", "dayEndsAt", "homeAt", "onSiteMinutes"]
    .every((k) => !(k in days["2026-09-28"])),
  Object.keys(days["2026-09-28"]).join(","));
ok("the derived timing is returned alongside, for display",
  timings["2026-09-28"].timeline.length === 4
    && typeof timings["2026-09-28"].driveMinutes === "number",
  JSON.stringify(Object.keys(timings["2026-09-28"])));

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-resequence: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-resequence: ${pass} assertions passed`);

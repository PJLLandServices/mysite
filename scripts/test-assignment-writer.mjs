// The assignment writer — stage 2 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-assignment-writer.mjs
//
// WHAT THIS PROTECTS. assign() turns planned stops into real, confirmed
// bookings. The stakes: a double-fired assignment books a customer
// twice; a message sent from here would be indistinguishable from
// marketing (touches carry no type until stage 4); and a full-bucket
// booking span would close assigned days to the new customers the whole
// geography-filter architecture exists to admit.
//
// SANDBOXED, LIKE test-season-config. server/lib is copied to a temp
// tree, so bookings.js writes a SANDBOX bookings.json and outreach's
// deriveBookingState reads the same file — which means idempotency is
// tested end to end through the REAL modules: the first assign's
// bookings are what the second assign's preflight reads. No injection
// fakes that loop, and no real data file is ever touched.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

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

// ---- Sandbox ---------------------------------------------------------

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-assign-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const file of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, file), path.join(SANDBOX, file));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));
const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const properties = require(path.join(SANDBOX, "server/lib/properties.js"));
const geoFilter = require(path.join(SANDBOX, "server/lib/geo-filter.js"));
const availability = require(path.join(SANDBOX, "server/lib/availability.js"));

// ---- Fixtures --------------------------------------------------------

const SEASON = "fall";
const YEAR = 2026;
const DAY1 = "2026-10-05";                    // Mon
const DAY2 = "2026-10-06";                    // Tue

const coords = (lat, lng) => ({ lat, lng, source: "google" });
const prop = (id, extra = {}) => ({
  id, code: id,
  customerName: `Customer ${id}`,
  customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`,
  address: `${id} Test St, Newmarket, ON`,
  town: "Newmarket",
  coords: coords(44.05 + Math.random() * 0.001, -79.46),
  system: { zones: [], zoneCount: null },
  ...extra
});
const zones = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));

const FIXTURES = {
  "P-A1": prop("P-A1", { system: { zones: zones(4), zoneCount: null }, coords: coords(44.0592, -79.4613) }),
  // Manual count, no documented zones — the fallback Patrick actually fills.
  "P-A2": prop("P-A2", { system: { zones: [], zoneCount: 6 }, coords: coords(44.0980, -79.4430) }),
  "P-C1": prop("P-C1", { customerId: "cus_commercial", system: { zones: zones(6), zoneCount: null }, coords: coords(44.1030, -79.4870) }),
  "P-NOZONE": prop("P-NOZONE", { system: { zones: [], zoneCount: null } }),
  "P-BOOKED": prop("P-BOOKED", { system: { zones: zones(4), zoneCount: null } }),
  "P-OPTOUT": prop("P-OPTOUT", {
    system: { zones: zones(4), zoneCount: null },
    seasonalOutreach: { [properties.seasonKey(YEAR, SEASON)]: { optOutThisSeason: true, touches: [] } }
  }),
  "P-NOCONTACT": prop("P-NOCONTACT", { customerPhone: "", customerEmail: "", system: { zones: zones(4), zoneCount: null } }),
  "P-DUP": prop("P-DUP", { system: { zones: zones(4), zoneCount: null } })
};

const PLAN = {
  bucketCap: 5,
  days: {
    [DAY1]: {
      label: "R1", territory: "Test turf",
      morning: ["P-A1", "P-A2", "P-NOZONE", "P-BOOKED", "P-DUP"],
      afternoon: ["P-C1", "P-OPTOUT", "P-NOCONTACT"]
    },
    [DAY2]: { label: "R2", territory: "Test north", morning: ["P-DUP"], afternoon: [] }
  }
};

// Sequenced arrivals, injected per day label so the test is exact and
// offline. P-A2 is deliberately ABSENT — its booking must fall back to
// the bucket open. P-DUP's 12:40 is a morning stop sequenced past noon
// (an overrun day) — its record must be CLAMPED inside the morning so
// bucket capacity attribution can't leak into the afternoon.
const STUB_TIMELINES = {
  R1: [
    { propertyCode: "P-A1", bucket: "morning", arriveAt: "08:13" },
    { propertyCode: "P-DUP", bucket: "morning", arriveAt: "12:40" },
    { propertyCode: "P-C1", bucket: "afternoon", arriveAt: "14:00" }
  ],
  R2: []
};

const deps = {
  getPlan: async () => PLAN,
  listProperties: async () => Object.values(FIXTURES),
  getCustomer: async (id) => (id === "cus_commercial" ? { accountType: "commercial" } : { accountType: "residential" }),
  sequenceDay: async (day) => ({ timeline: STUB_TIMELINES[day.label] || [] }),
  actor: "test"
};

// P-BOOKED made their own appointment before the assignment runs — a real
// record in the sandbox store, so the REAL deriveBookingState finds it.
await bookings.createDirect({
  propertyId: "P-BOOKED",
  customerName: "Customer P-BOOKED",
  serviceKey: "fall_close_4z",
  serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor: new Date(2026, 9, 1, 13, 0).toISOString(),
  durationMinutes: 30,
  status: "confirmed"
});

// ---- 1. The first assignment ----------------------------------------

const first = await assignments.assign(SEASON, YEAR, deps);
ok("assign runs against the injected plan", first.ok === true);
ok("every planned stop is accounted for", first.summary.stops === 9, String(first.summary.stops));
ok("the summary adds up: created + settled + skipped = stops",
  first.summary.created + first.summary.settled + first.summary.skipped === first.summary.stops,
  JSON.stringify(first.summary));

const rows = new Map(first.days.flatMap((d) => d.stops).map((r) => [`${r.date}|${r.code}`, r]));
const stored = await bookings.list();
const byProperty = new Map(stored.filter((b) => b.source === "assignment").map((b) => [b.propertyId, b]));

ok("four ready stops became bookings (A1, A2, C1, DUP-once)",
  first.summary.created === 4, JSON.stringify(first.summary));

// -- record shape --
const a1 = byProperty.get("P-A1");
ok("a created booking is confirmed, sourced, and property-linked with no lead",
  a1 && a1.status === "confirmed" && a1.source === "assignment"
  && a1.propertyId === "P-A1" && a1.leadId === null, JSON.stringify(a1));
ok("the assignment block carries what reversal and audit need",
  a1.assignment.season === "fall" && a1.assignment.year === 2026
  && a1.assignment.date === DAY1 && a1.assignment.bucket === "morning"
  && a1.assignment.code === "P-A1" && a1.assignment.batchId === first.batchId);
ok("4 documented zones book the 4z tier", a1.serviceKey === "fall_close_4z", a1.serviceKey);
ok("a stop is scheduled at its SEQUENCED ARRIVAL, not the bucket open",
  new Date(a1.scheduledFor).getHours() === 8 && new Date(a1.scheduledFor).getMinutes() === 13,
  a1.scheduledFor);
ok("duration is the SERVICE minutes, not the bucket length — the bucket must stay open",
  a1.durationMinutes === 30, String(a1.durationMinutes));

const a2 = byProperty.get("P-A2");
ok("a manual zone count (no documented zones) still resolves the tier",
  a2 && a2.serviceKey === "fall_close_6z", a2?.serviceKey);
ok("a stop the sequencer has no arrival for falls back to the bucket open",
  new Date(a2.scheduledFor).getHours() === 8 && new Date(a2.scheduledFor).getMinutes() === 0,
  a2.scheduledFor);

const dup1 = byProperty.get("P-DUP");
ok("a morning stop sequenced past noon is CLAMPED inside its bucket — capacity attribution must not leak",
  new Date(dup1.scheduledFor).getHours() === 11 && new Date(dup1.scheduledFor).getMinutes() === 30,
  dup1.scheduledFor);

const c1 = byProperty.get("P-C1");
ok("a commercial account books the commercial tier table",
  c1 && c1.serviceKey.startsWith("fall_close_commercial"), c1?.serviceKey);
ok("an AFTERNOON stop carries its sequenced arrival too",
  new Date(c1.scheduledFor).getHours() === 14, c1.scheduledFor);

// -- skips --
ok("no zone count -> skipped, named, not booked",
  rows.get(`${DAY1}|P-NOZONE`).outcome === "skipped"
  && rows.get(`${DAY1}|P-NOZONE`).reason === "no_zone_count"
  && !byProperty.has("P-NOZONE"));
ok("a customer with their own booking is settled, and no second booking is created",
  rows.get(`${DAY1}|P-BOOKED`).outcome === "settled" && !byProperty.has("P-BOOKED"));
ok("an opted-out customer is not booked",
  rows.get(`${DAY1}|P-OPTOUT`).outcome === "skipped" && !byProperty.has("P-OPTOUT"));
ok("an unreachable customer is NOT booked — a truck must never surprise a house",
  rows.get(`${DAY1}|P-NOCONTACT`).outcome === "skipped"
  && rows.get(`${DAY1}|P-NOCONTACT`).reason === "no_contact" && !byProperty.has("P-NOCONTACT"));
ok("a property planned on two days books ONCE; the second occurrence says why",
  rows.get(`${DAY1}|P-DUP`).outcome === "created"
  && rows.get(`${DAY2}|P-DUP`).outcome === "skipped"
  && rows.get(`${DAY2}|P-DUP`).reason === "duplicate_in_plan"
  && stored.filter((b) => b.propertyId === "P-DUP").length === 1);

ok("every skip reason renders as a sentence",
  [...first.days.flatMap((d) => d.stops)].filter((r) => r.reason).every((r) =>
    assignments.PREFLIGHT_OUTCOMES[r.reason] || assignments.ASSIGN_OUTCOMES[r.reason]));

// ---- 2. Idempotency, through the real modules ------------------------

const second = await assignments.assign(SEASON, YEAR, deps);
ok("running assign again creates NOTHING — the worst bug this system can have",
  second.summary.created === 0, JSON.stringify(second.summary));
// 6 settled rows for 5 booked properties: P-DUP is planned on two days
// and BOTH its rows now read as settled — the duplicate guard's job is
// done by the store itself once the booking exists.
ok("the first run's bookings now read as settled through the REAL booking-state derivation",
  second.summary.settled === 6, JSON.stringify(second.summary));
ok("the store still holds exactly the first run's records",
  (await bookings.list()).filter((b) => b.source === "assignment").length === 4);

// ---- 2b. Re-anchoring: booking times follow the route -----------------
//
// Patrick reorders the day; the sequenced arrivals move; pristine
// assignment records must move with them — the calendar and the plan
// screen are two views of ONE day, never two different days.

STUB_TIMELINES.R1[0] = { propertyCode: "P-A1", bucket: "morning", arriveAt: "08:45" };
const sync = await assignments.syncAssignedTimes(SEASON, YEAR, deps);
ok("a plan edit re-anchors the moved stop", sync.updated === 1, JSON.stringify(sync));
const a1After = (await bookings.list()).find((b) => b.propertyId === "P-A1");
ok("...to its new sequenced arrival",
  new Date(a1After.scheduledFor).getHours() === 8 && new Date(a1After.scheduledFor).getMinutes() === 45,
  a1After.scheduledFor);
const syncAgain = await assignments.syncAssignedTimes(SEASON, YEAR, deps);
ok("re-syncing with nothing changed touches nothing", syncAgain.updated === 0, JSON.stringify(syncAgain));

// The customer time-window seam: a window stored on a booking reaches
// the sequencer as requestedWindows keyed by the plan code, so the
// customer's ask joins the clock every surface prints.
{
  const a1Booking = (await bookings.list()).find((b) => b.propertyId === "P-A1");
  await bookings.setRequestedWindow(a1Booking.id, { notBefore: "10:00", by: "customer" });
  let seen = null;
  const spyDeps = { ...deps, sequenceDay: async (day, opts) => { seen = opts.requestedWindows; return { timeline: STUB_TIMELINES[day.label] || [] }; } };
  await assignments.syncAssignedTimes(SEASON, YEAR, spyDeps);
  ok("a customer's stored window reaches the sequencer, keyed by their plan code",
    seen && seen["P-A1"] && seen["P-A1"].notBefore === "10:00", JSON.stringify(seen));
  await bookings.setRequestedWindow(a1Booking.id, { notBefore: "", notAfter: "" });
}

// ---- 3. SENDS NOTHING -------------------------------------------------

const source = fs.readFileSync(path.join(SANDBOX, "server/lib/assignments.js"), "utf8");
ok("the writer never requires a notify, mailer, or sms module",
  !/require\("\.\/(notify|mailer|sms)/.test(source));
ok("the writer never calls sendBulk or recordOutreachTouch",
  !source.includes("sendBulk(") && !source.includes("recordOutreachTouch"));

// ---- 4. The buffer / day-shape proof (Part 5 trap) --------------------
//
// A fully-assigned day must look IDENTICAL to the geography filter and
// the capacity gate: every assignment booking's rounded coordinate is
// its own planned stop, so nothing double-counts and the day's shape
// gains no points.

const propertiesByCode = new Map(Object.values(FIXTURES).map((p) => [p.code, p]));
const assignedNow = (await bookings.list())
  .filter((b) => b.status === "confirmed")
  .map((b) => {
    const p = Object.values(FIXTURES).find((f) => f.id === b.propertyId);
    const start = new Date(b.scheduledFor);
    return {
      start: start.toISOString(),
      end: new Date(start.getTime() + b.durationMinutes * 60000).toISOString(),
      coords: p ? p.coords : null,
      leadId: null
    };
  });

const shapesBefore = geoFilter.buildDayShapes({ plan: PLAN, propertiesByCode, bookings: [] });
const shapesAfter = geoFilter.buildDayShapes({ plan: PLAN, propertiesByCode, bookings: assignedNow });
ok("a fully-assigned day's shape is IDENTICAL — no point double-counts",
  JSON.stringify(shapesBefore[DAY1].points) === JSON.stringify(shapesAfter[DAY1].points));
ok("...and its bucket loads are identical, so the capacity gate reads the same",
  JSON.stringify(shapesBefore[DAY1].buckets) === JSON.stringify(shapesAfter[DAY1].buckets)
  && shapesBefore[DAY1].bucketCap === shapesAfter[DAY1].bucketCap);

// A NEW customer can still book into the assigned day's spare capacity:
// morning holds 5 planned (cap 5 — full), afternoon holds 3 (room for
// one more). The assignment bookings sit in the walk as real records.
const NOW = new Date(2026, 9, 1, 9, 0, 0);   // Thu Oct 1 — inside the window
const NEWCOMER = { lat: 44.0700, lng: -79.4500, source: "google" };
const slots = await availability.listAvailableSlots({
  serviceKey: "fall_close_4z",
  customerCoords: NEWCOMER,
  bookings: assignedNow,
  blocks: [],
  daysAhead: 10,
  hours: availability.DEFAULT_HOURS,
  settings: { ...availability.DEFAULT_SETTINGS, geoMaxAddedDriveMinutes: 0 },
  seasonWindows: () => null,
  dayShapes: shapesAfter,
  now: NOW
});
const day1Buckets = new Set(slots.filter((s) => {
  const d = new Date(s.start);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === DAY1;
}).map((s) => s.bucketKey));
ok("an assigned bucket BELOW its cap still takes new customers",
  day1Buckets.has("afternoon"), [...day1Buckets].join(", ") || "nothing offered");
ok("an assigned bucket AT its cap is closed",
  !day1Buckets.has("morning"));

// ---- 5. Unassign — reversible, and only what nobody touched -----------

// Touch two records: one rescheduled, one cancelled.
const dupBooking = (await bookings.list()).find((b) => b.propertyId === "P-DUP");
await bookings.reschedule(dupBooking.id, { scheduledFor: new Date(2026, 9, 7, 8, 0).toISOString(), by: "customer" });
const c1Booking = (await bookings.list()).find((b) => b.propertyId === "P-C1");
await bookings.cancel(c1Booking.id, { by: "customer", reason: "sold the house" });

// A rescheduled record has left the plan's steering — the time sync must
// never drag it back to the route.
const syncAfterTouch = await assignments.syncAssignedTimes(SEASON, YEAR, deps);
const dupAfterSync = await bookings.get(dupBooking.id);
ok("the time sync leaves a rescheduled booking exactly where the customer put it",
  new Date(dupAfterSync.scheduledFor).getDate() === 7, dupAfterSync.scheduledFor);
ok("...and reports nothing to update", syncAfterTouch.updated === 0, JSON.stringify(syncAfterTouch));

const undo = await assignments.unassign(SEASON, YEAR, deps);
ok("unassign finds exactly the assignment records", undo.summary.found === 4, JSON.stringify(undo.summary));
ok("untouched records are removed", undo.summary.removed === 2, JSON.stringify(undo.summary));
ok("a rescheduled booking is KEPT — someone changed it on purpose",
  undo.kept.some((k) => k.bookingId === dupBooking.id && k.reason === "rescheduled"));
ok("a cancelled booking is KEPT — the cancellation is a customer's answer",
  undo.kept.some((k) => k.bookingId === c1Booking.id && k.reason === "status_cancelled"));
ok("P-BOOKED's own (non-assignment) booking is untouched by unassign",
  (await bookings.list()).some((b) => b.propertyId === "P-BOOKED" && !b.source));

// After a clean undo, the freed stops are assignable again — but the
// cancelled customer stays un-booked: their cancellation was an answer.
const third = await assignments.assign(SEASON, YEAR, deps);
ok("after undo, the freed stops book again (A1, A2) — the loop is closed",
  third.summary.created === 2, JSON.stringify(third.summary));
const thirdRows = new Map(third.days.flatMap((d) => d.stops).map((r) => [`${r.date}|${r.code}`, r]));
ok("a customer who CANCELLED their assignment is never auto-booked again",
  thirdRows.get(`${DAY1}|P-C1`).outcome === "skipped"
  && thirdRows.get(`${DAY1}|P-C1`).reason === "assignment_declined",
  JSON.stringify(thirdRows.get(`${DAY1}|P-C1`)));

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-assignment-writer: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-assignment-writer: ${pass} assertions passed`);

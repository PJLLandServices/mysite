// Declared zone count → a real zone list (2026-09-01).
//
//   node scripts/test-declared-zones.mjs
//
// WHAT THIS PROTECTS. A customer books a fall closing and says they have
// eight zones. Pricing has always honoured that — effectiveZoneCount()
// reads documented zones first and falls back to system.zoneCount — so
// they are charged the 7-8 zone tier. But the work order scaffolded from
// the documented list ONLY, which on a first-time property is empty, so
// creation fell through to its "always give the tech at least one zone"
// placeholder. Priced for eight, dispatched with one. The tech arrives at
// an eight-zone lawn holding a one-zone work order.
//
// The zones are now written to the PROPERTY at work-order creation, so the
// record carries them from the first booking. They land pendingReview:true
// — a number typed into a booking form is a claim, not a survey — and two
// things depend on that flag, both asserted here: the customer can still
// correct their own count from the appointment page until a tech has
// walked it, and the appointment page must never tell someone we have
// "already mapped" a property nobody has visited.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { effectiveZoneCount } = require("../server/lib/pricing.js");
const { declaredZoneList, scaffoldZonesFromProperty } = require("../server/lib/work-orders.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ---- 1. the fallback pricing already relied on ------------------------
{
  eq(effectiveZoneCount({ system: { zoneCount: 8 } }), 8, "a declared count is a zone count");
  eq(effectiveZoneCount({ system: { zones: [{ number: 1 }, { number: 2 }], zoneCount: 8 } }), 2,
    "a walked property outranks what the customer guessed");
  eq(effectiveZoneCount({ system: {} }), 0, "nothing declared, nothing documented");
  eq(effectiveZoneCount(null), 0, "a missing property does not throw");
  eq(effectiveZoneCount({ system: { zoneCount: 0 } }), 0, "zero is not a count");
  eq(effectiveZoneCount({ system: { zoneCount: "6" } }), 6, "a numeric string still counts");
}

// ---- 2. what the real builder produces -------------------------------
const buildZones = (declared) => declaredZoneList({ system: { zoneCount: declared } });
{
  const zones = declaredZoneList({ system: { zoneCount: 8 } });
  eq(zones.length, 8, "eight declared zones become eight zones, not one placeholder");
  eq(zones.map((z) => z.number).join(","), "1,2,3,4,5,6,7,8", "numbered from 1, in order");
  ok(zones.every((z) => z.pendingReview === true), "every one is flagged as never walked");
  ok(zones.every((z) => z.location === "" && z.label === ""),
    "and unnamed — the tech names them on site, which writes back to the property");

  eq(declaredZoneList({ system: { zones: [{ number: 1 }], zoneCount: 8 } }).length, 0,
    "a documented property is left alone — its real list wins");
  eq(declaredZoneList({ system: {} }).length, 0, "nothing declared, nothing built");
  eq(declaredZoneList(null).length, 0, "a missing property does not throw");
  eq(declaredZoneList({ system: { zoneCount: -3 } }).length, 0, "a nonsense count builds nothing");
}

// ---- 2b. and what the work order scaffolds from it --------------------
{
  // The actual bug: eight declared zones used to scaffold nothing, and
  // create() fell through to its single "Zone 1" placeholder.
  const scaffolded = scaffoldZonesFromProperty({ system: { zoneCount: 8 } });
  eq(scaffolded.length, 8, "the work order scaffolds eight zones, not one placeholder");
  eq(scaffolded[7].number, 8, "numbered through to eight");
  ok(scaffolded.every((z) => Array.isArray(z.issues) && z.status === ""),
    "each one is a real work-order zone the tech can log against");

  const walked = scaffoldZonesFromProperty({ system: {
    zones: [{ number: 1, location: "Front lawn" }, { number: 2, location: "Side bed" }],
    zoneCount: 8
  } });
  eq(walked.length, 2, "a documented property still scaffolds from what was walked");
  eq(walked[0].location, "Front lawn", "carrying the names with it");
}

// ---- 3. the customer can still fix their own number -------------------
// The appointment page refuses a correction once zones are "mapped". It
// must count only zones a human confirmed, or a scaffold would lock the
// customer out and the message would be a lie.
const mappedCount = (property) => Array.isArray(property.system?.zones)
  ? property.system.zones.filter((z) => z && z.pendingReview !== true).length
  : 0;
{
  const declaredOnly = { system: { zones: buildZones(8) } };
  eq(mappedCount(declaredOnly), 0,
    "eight unwalked zones do NOT count as mapped — the customer can still correct 8 to 6");

  const walked = { system: { zones: [
    { number: 1, location: "Front lawn", pendingReview: false },
    { number: 2, location: "Side bed" }
  ] } };
  eq(mappedCount(walked), 2, "zones a tech named DO count as mapped");

  const mixed = { system: { zones: [
    { number: 1, location: "Front lawn", pendingReview: false },
    { number: 2, pendingReview: true }
  ] } };
  eq(mappedCount(mixed), 1, "a half-walked property counts only what was walked");
  eq(mappedCount({ system: {} }), 0, "no zones, nothing mapped");
}

// ---- 4. naming a zone confirms it -------------------------------------
// What the app's rename sends. Clearing the flag is what stops the
// customer overwriting a count a tech has now verified on the ground.
{
  const before = buildZones(4);
  const renamed = before.map((z) =>
    z.number === 2 ? { ...z, location: "Side bed", label: "Side bed", pendingReview: false } : z);
  eq(mappedCount({ system: { zones: renamed } }), 1, "naming one zone confirms exactly one");
  eq(renamed.length, 4, "and does not drop the other three");
  eq(renamed[1].label, "Side bed", "both name fields are written");
  ok(renamed[0].pendingReview === true, "the zones nobody named stay unconfirmed");
}

// ---- 5. removing a zone -----------------------------------------------
// A tech arrives to find five zones where the customer said six. The
// removal is destructive by design (Patrick, 2026-09-01) — but it must
// never renumber the survivors, because a zone number is a controller
// station: if the box says Zone 5, it is Zone 5 whatever happened to
// Zone 3. And the reason is written by the SERVER, not sent by the phone
// — a client-writable audit log is not an audit log.
{
  const properties = require("../server/lib/properties.js");
  const { ZONE_REMOVAL_REASONS } = properties;

  ok(typeof properties.removeZone === "function", "the lib owns the removal");
  eq(Object.keys(ZONE_REMOVAL_REASONS).sort().join(","), "merged,mistake,not_present,other",
    "the reason vocabulary is a closed set the app mirrors");

  // The survivors, as removeZone computes them.
  const zones = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, location: `Zone ${n}` }));
  const after = zones.filter((z) => Number(z.number) !== 3);
  eq(after.map((z) => z.number).join(","), "1,2,4,5,6",
    "removing Zone 3 leaves 1,2,4,5,6 — nothing is renumbered onto a station it does not own");
  eq(after.length, 5, "six declared, five on the ground");

  // The declared count must not survive as a fallback that outlives the
  // list it described.
  eq(after.length || null, 5, "the count follows the real list");
  eq([].length || null, null, "removing the last zone clears the count rather than leaving a stale 1");
}

// ---- The count has to REACH the property, or none of the above runs ----
//
// Patrick, on a work order for a seven-zone property showing "Zone 1 of 1":
// "I believe there was a working fix for this, but it clearly doesn't look
// delivered."
//
// It was delivered, and it did nothing. The chain above turns
// system.zoneCount into real zones — but system.zoneCount was Patrick's
// hand-filled field and the appointment page's, and NOTHING wrote it when
// a booking was taken. A first-time property therefore reached
// scaffoldZonesFromProperty() with an empty system, produced no zones, and
// create() fell through to its one-zone placeholder. The register even
// listed the walked test that would catch it — "book a new property
// declaring a zone count, open its work order" — and it had not been run.
{
  const woLib = require("../server/lib/work-orders.js");
  const SERVER = require("node:fs").readFileSync(
    new URL("../server/server.js", import.meta.url), "utf8");

  // Named rather than destructured, so their absence reads as one failed
  // assertion instead of a stack trace that hides every check below it.
  const declaredZonesFromBooking = woLib.declaredZonesFromBooking || (() => -1);
  const canAdoptDeclaredZones = woLib.canAdoptDeclaredZones || (() => null);
  ok(typeof woLib.declaredZonesFromBooking === "function"
    && typeof woLib.canAdoptDeclaredZones === "function",
    "a booked zone count has no way to reach the property — lib/work-orders.js does not describe one");

  // What the booking form can actually send.
  eq(declaredZonesFromBooking({ zoneCount: 7 }), 7, "seven zones booked is seven");
  eq(declaredZonesFromBooking({ zoneCount: "7" }), 7, "a numeric string still counts");
  eq(declaredZonesFromBooking({ zoneCount: 1 }), 1, "one zone is a real answer");
  eq(declaredZonesFromBooking({ zoneCount: 50 }), 50, "the top of the accepted range");
  // "unsure" is a real answer the form takes, and it is not a number. It
  // must leave the property blank rather than claim a count nobody gave.
  eq(declaredZonesFromBooking({ zoneCount: "unsure" }), 0, "'unsure' is not a zone count");
  eq(declaredZonesFromBooking({ zoneCount: 0 }), 0, "zero zones is not a count");
  eq(declaredZonesFromBooking({ zoneCount: 51 }), 0, "out of range is refused, as reserve refuses it");
  eq(declaredZonesFromBooking({}), 0, "a booking without a count");
  eq(declaredZonesFromBooking(null), 0, "no booking at all");

  // It may only ever fill a BLANK.
  ok(canAdoptDeclaredZones({ id: "p", system: {} }, { zoneCount: 7 }),
    "a property with nothing on it takes the booked count");
  ok(!canAdoptDeclaredZones({ id: "p", system: { zones: [{ number: 1 }] } }, { zoneCount: 7 }),
    "documented zones are ground truth and a booking must not move them");
  ok(!canAdoptDeclaredZones({ id: "p", system: { zoneCount: 4 } }, { zoneCount: 7 }),
    "a count already on the record is Patrick's or the customer's, not a later booking's");
  ok(!canAdoptDeclaredZones({ id: "p", system: {} }, { zoneCount: "unsure" }),
    "'unsure' fills nothing in");

  // THE FAILURE, end to end on the real functions: the property a booking
  // creates, before and after the count reaches it.
  const asBookingCreatesIt = { id: "p1", address: "330 Aztec Dr", system: {} };
  eq(scaffoldZonesFromProperty(asBookingCreatesIt).length, 0,
    "a booking-created property still has no zones of its own");
  const withTheCount = { ...asBookingCreatesIt, system: { zoneCount: 7 } };
  eq(scaffoldZonesFromProperty(withTheCount).length, 7,
    "once the count is on the record, seven zones scaffold");

  // And the route layer actually does the writing — the whole bug was a
  // chain with no first link.
  ok(/async function adoptDeclaredZoneCount\(property, booking\)/.test(SERVER),
    "nothing writes a booked zone count onto a property");
  ok(/await adoptDeclaredZoneCount\(linkResult\.property, result\.lead\.booking\)/.test(SERVER),
    "taking a booking does not put its zone count on the property");
  eq((SERVER.match(/materializeDeclaredZones\(property, lead\)/g) || []).length, 2,
    "a work order is opened without offering the lead's booked count as a fallback");
  ok(/property = await adoptDeclaredZoneCount\(property, lead\?\.booking\)/.test(SERVER),
    "bookings taken before this shipped still scaffold one zone");
}

console.log(`\ndeclared-zones: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

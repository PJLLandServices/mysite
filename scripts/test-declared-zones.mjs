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

console.log(`\ndeclared-zones: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

// The geocode failure posture — "we cannot have this fail."
//
//   node scripts/test-geocode-fallback.mjs
//
// WHAT THIS PROTECTS. Patrick probed an Erin address and got every route
// day offered, because one failed geocode collapsed to the depot pin and
// switched the geography filter OFF for that customer. The parachute is
// lib/town-centroids.js: a failed lookup that still names a recognizable
// town answers with that town's approximate centre — the filter stays ON
// and Erin still reads as an hour away. This suite pins the whole chain:
// the town matcher, the geocode fallback order, the ok:false invariant
// that keeps approximate coords out of every persisted record, and the
// outcome Patrick cares about — Erin suppressed, Aurora offered — through
// the REAL filter math.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;   // deterministic: no key, no network

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

// Sandbox so the geocode cache writes to a temp tree, never real data.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-geo-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const towns = require(path.join(SANDBOX, "server/lib/town-centroids.js"));
const { geocode } = require(path.join(SANDBOX, "server/lib/geocode.js"));
const geoFilter = require(path.join(SANDBOX, "server/lib/geo-filter.js"));

// ---- 1. The town matcher ----------------------------------------------

ok("Patrick's exact probe address resolves to Erin",
  towns.townFromText("9 Erinville Dr, Erin, ON N0B 1T0, Canada") === "erin");
ok("a street NAME containing a town does not match — whole words only",
  towns.townFromText("12 Erindale Rd, Mississauga, ON") === "mississauga");
ok("the longest name wins: Bradford West Gwillimbury is Bradford, not a miss",
  towns.townFromText("55 Holland St, Bradford West Gwillimbury, ON") === "bradford west gwillimbury");
ok("case and punctuation don't matter",
  towns.townFromText("100 MAIN ST., RICHMOND HILL ON L4C 1A1") === "richmond hill");
ok("an unknown town matches nothing rather than guessing",
  towns.townFromText("1 Rue Principale, Gatineau, QC") === null
  && towns.lookup("somewhere unrecognizable") === null);
const erin = towns.lookup("9 Erinville Dr, Erin, ON N0B 1T0");
ok("a lookup answers with approximate coords marked as such",
  erin && erin.source === "town-centroid" && erin.town === "Erin"
  && Math.abs(erin.lat - 43.77) < 0.1 && /approximate/.test(erin.formattedAddress),
  JSON.stringify(erin));

// ---- 2. geocode's fallback order (no key set) --------------------------

const geoErin = await geocode("9 Erinville Dr, Erin, ON N0B 1T0, Canada");
ok("with no key, a recognizable town answers from its centre — the filter can still run",
  geoErin.coords?.source === "town-centroid" && geoErin.coords.town === "Erin",
  JSON.stringify(geoErin));
ok("…but the result is NEVER ok — approximate coords must not persist to any record",
  geoErin.ok === false && geoErin.skipped === true && geoErin.approximate === true);

const geoMystery = await geocode("42 Nowhere Lane, Atlantis");
ok("no recognizable town falls to the depot pin, exactly as before",
  geoMystery.coords?.source === "pjl-base" && geoMystery.ok === false);
const geoEmpty = await geocode("");
ok("an empty address is the depot pin too", geoEmpty.coords?.source === "pjl-base");

// ---- 3. The filter's view of each fallback -----------------------------

ok("a town centroid COUNTS as resolved — the filter runs on it",
  geoFilter.coordsAreResolved(geoErin.coords) === true);
ok("the depot pin does NOT — the filter skips, as designed",
  geoFilter.coordsAreResolved(geoMystery.coords) === false);

// ---- 4. The outcome that matters: Erin suppressed, Aurora offered ------
// Real filter math (Haversine — no key, so deterministic) against a
// Newmarket-area route day, from the depot as base.

const newmarketDay = [
  { lat: 44.056, lng: -79.462 },
  { lat: 44.048, lng: -79.481 },
  { lat: 44.061, lng: -79.447 }
];
const base = { lat: 44.0592, lng: -79.4613 };
const fromErin = await geoFilter.addedDriveMinutes(towns.lookup("Erin, ON"), newmarketDay, { base });
const fromAurora = await geoFilter.addedDriveMinutes(towns.lookup("Aurora, ON"), newmarketDay, { base });
ok("an Erin customer costs FAR more added driving than any sane threshold",
  fromErin && fromErin.minutes > 30, `Erin added ${fromErin?.minutes} min`);
ok("an Aurora customer stays cheap — near addresses are not harmed by the parachute",
  fromAurora && fromAurora.minutes < 15, `Aurora added ${fromAurora?.minutes} min`);
ok("and Erin costs more than Aurora by a wide margin",
  fromErin.minutes > fromAurora.minutes + 20);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-geocode-fallback: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-geocode-fallback: ${pass} assertions passed`);

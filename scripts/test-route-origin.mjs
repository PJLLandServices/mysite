// Route origin — the yard, and its separation from the geocode fallback.
//
//   node scripts/test-route-origin.mjs
//
// WHAT WENT WRONG. geocode.js exports PJL_BASE as the fallback for
// customer addresses that will not resolve — a deliberately vague
// "Newmarket, ON, Canada" town point, which is the right answer to "where
// is this?" when nobody knows. The route optimiser adopted it as the
// start-and-end anchor because it was the only base-shaped constant
// available, and nobody asked whether it was an address.
//
// It is not. Measured from that centroid, 89 Prospect St was the nearest
// stop on R1 and the Creebridge pair the farthest; from the real yard on
// Cenotaph Blvd the order reverses. Eleven route days were anchored to the
// middle of town, and the output looked entirely plausible the whole time,
// because a route pointed at the wrong start looks exactly like a route
// pointed at the right one.
//
// These assertions exist to keep the two apart.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeOriginLib = require(path.join(ROOT, "server/lib/route-origin.js"));
const { PJL_BASE } = require(path.join(ROOT, "server/lib/geocode.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- The two values are not the same thing ---------------------------

ok("the fallback is still a town centroid, and still says so",
  PJL_BASE.source === "pjl-base" && /Newmarket, ON/.test(PJL_BASE.formattedAddress || ""),
  JSON.stringify(PJL_BASE));

ok("the yard is configured as a street address, not coordinates",
  /^\d+\s+\S/.test(routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS)
    && /Cenotaph/i.test(routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS),
  routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS);

ok("the yard address carries a postal code, so a wrong one is visible by eye",
  /L\d[A-Z]\s?\d[A-Z]\d/i.test(routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS),
  routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS);

// ---- Environment override --------------------------------------------

routeOriginLib.resetRouteOriginCache();
process.env.PJL_ROUTE_ORIGIN = "500 Somewhere Else Rd, Aurora, ON, Canada";
ok("the yard can be moved from the environment without a deploy",
  routeOriginLib.routeOriginAddress() === "500 Somewhere Else Rd, Aurora, ON, Canada",
  routeOriginLib.routeOriginAddress());

process.env.PJL_ROUTE_ORIGIN = "   ";
ok("a blank override falls back to the configured address, not to nothing",
  routeOriginLib.routeOriginAddress() === routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS,
  routeOriginLib.routeOriginAddress());
delete process.env.PJL_ROUTE_ORIGIN;
routeOriginLib.resetRouteOriginCache();

// ---- Failing to locate the yard degrades, and admits it --------------
//
// No Maps key here, so geocode() returns its PJL_BASE fallback and this
// exercises the degraded path exactly as production would on a bad key.

const origin = await routeOriginLib.routeOrigin();
ok("an unlocatable yard still returns usable coordinates",
  Number.isFinite(origin.lat) && Number.isFinite(origin.lng), JSON.stringify(origin));
ok("...and reports that it is a guess rather than presenting it as fact",
  origin.resolved === false, JSON.stringify(origin));
ok("...and carries the address it failed on, so the screen can name it",
  origin.address === routeOriginLib.DEFAULT_ROUTE_ORIGIN_ADDRESS, origin.address);
ok("the degraded anchor is the town centroid",
  origin.lat === PJL_BASE.lat && origin.lng === PJL_BASE.lng, JSON.stringify(origin));

// ---- The re-sequencer uses the yard, not the fallback ----------------

const { sequenceDay } = require(path.join(ROOT, "server/lib/resequence.js"));
const props = new Map([
  ["NEAR", { code: "NEAR", id: "NEAR", address: "near", coords: { lat: 44.10, lng: -79.46 }, system: { zones: [] } }],
  ["FAR", { code: "FAR", id: "FAR", address: "far", coords: { lat: 44.30, lng: -79.46 }, system: { zones: [] } }]
]);
const travel = async (a, b) => Math.round(Math.abs(a.lat - b.lat) * 1000);

// Anchored at 44.00 the near stop is NEAR; anchored at 44.40 it is FAR.
// The finish-nearest-home rule therefore ends the day at a different stop
// depending on the anchor — which is the whole reason a wrong anchor is
// not a cosmetic problem.
const fromSouth = await sequenceDay({ label: "S", morning: ["NEAR", "FAR"], afternoon: [] },
  { propertiesByCode: props, season: "fall", travel, base: { lat: 44.00, lng: -79.46 } });
const fromNorth = await sequenceDay({ label: "N", morning: ["NEAR", "FAR"], afternoon: [] },
  { propertiesByCode: props, season: "fall", travel, base: { lat: 44.40, lng: -79.46 } });
ok("the anchor decides which stop ends the day",
  fromSouth.morning[fromSouth.morning.length - 1] === "NEAR"
    && fromNorth.morning[fromNorth.morning.length - 1] === "FAR",
  `south ended ${fromSouth.morning.join(",")}, north ended ${fromNorth.morning.join(",")}`);

if (failures.length) {
  console.error(`\n✗ test-route-origin: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-route-origin: ${pass} assertions passed`);

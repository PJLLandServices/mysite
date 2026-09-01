// Route map images — the URL the plan screen's day maps are built from.
//
//   node scripts/test-route-map.mjs
//
// The picture itself cannot be asserted without a Maps key and an eye, so
// what is checked here is everything that decides WHICH picture gets
// drawn: the polyline encoder, the cache key, and the marker rules. A
// stale or mislabelled map is worse than no map, because it looks like
// confirmation.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeMap = require(path.join(ROOT, "server/lib/route-map.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Polyline encoder ------------------------------------------------
//
// Checked against the example published in Google's own encoded-polyline
// documentation, so this is verified against the spec rather than against
// itself.

ok("the encoder matches Google's published reference",
  routeMap.encodePath([
    { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }
  ]) === "_p~iF~ps|U_ulLnnqC_mqNvxq`@");

ok("an empty path encodes to an empty string, not to garbage",
  routeMap.encodePath([]) === "");

// ---- Cache key -------------------------------------------------------
//
// The key is the route, not the date. A re-sequenced day must produce a
// different image; a page refresh must not.

const origin = { lat: 44.03, lng: -79.47 };
const A = { number: 1, coords: { lat: 44.05, lng: -79.46 } };
const B = { number: 2, coords: { lat: 44.10, lng: -79.44 } };
const C = { number: 3, coords: { lat: 44.09, lng: -79.48 } };

ok("the same route yields the same key, so a refresh is free",
  routeMap.cacheKey(origin, [A, B, C]) === routeMap.cacheKey(origin, [A, B, C]));

ok("REORDERING the stops changes the key",
  routeMap.cacheKey(origin, [A, B, C]) !== routeMap.cacheKey(origin, [A, C, B]),
  "a re-sequenced day would have served the old picture");

ok("adding a stop changes the key",
  routeMap.cacheKey(origin, [A, B]) !== routeMap.cacheKey(origin, [A, B, C]));

ok("moving the yard changes the key",
  routeMap.cacheKey(origin, [A, B, C])
    !== routeMap.cacheKey({ lat: 43.9, lng: -79.5 }, [A, B, C]),
  "the anchor is drawn on the map, so it belongs in the key");

ok("the key is filename-safe",
  /^[0-9a-f]{32}$/.test(routeMap.cacheKey(origin, [A, B, C])),
  routeMap.cacheKey(origin, [A, B, C]));

// ---- Degrading without a key ----------------------------------------

const hadKey = process.env.GOOGLE_MAPS_SERVER_KEY;
delete process.env.GOOGLE_MAPS_SERVER_KEY;
ok("without a Maps key the module reports itself unavailable",
  routeMap.isConfigured() === false);
// It returns a REASON rather than null. "Route map unavailable" with no
// explanation is a bug report containing no information — the first live
// failure could not be diagnosed from the screen at all, only guessed at.
const noKey = await routeMap.routeMapImage(origin, [A, B, C]);
ok("...and asking for an image returns a reason rather than throwing",
  noKey && !noKey.buffer && typeof noKey.error === "string", JSON.stringify(noKey));
ok("...and the reason names the missing key, so it is actionable",
  /GOOGLE_MAPS_SERVER_KEY/.test(noKey.error), noKey.error);

// Configured, but nothing to draw. A dummy key is enough: the no-stops
// branch returns before any network call, so this never reaches Google.
process.env.GOOGLE_MAPS_SERVER_KEY = "test-key-not-used";
const noStops = await routeMap.routeMapImage(origin, []);
ok("an empty day explains itself rather than failing silently",
  noStops && !noStops.buffer && /no stops/i.test(noStops.error || ""), JSON.stringify(noStops));
delete process.env.GOOGLE_MAPS_SERVER_KEY;
if (hadKey) process.env.GOOGLE_MAPS_SERVER_KEY = hadKey;

// ---- The image cache lives in runtime data, not the repo -------------

ok("images cache under server/data, which is gitignored",
  /server[/\\]data[/\\]route-maps$/.test(routeMap.CACHE_DIR), routeMap.CACHE_DIR);

if (failures.length) {
  console.error(`\n✗ test-route-map: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-route-map: ${pass} assertions passed`);

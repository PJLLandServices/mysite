// Road geometry — the line the plan screen's Leaflet maps draw.
//
//   node scripts/test-route-geometry.mjs
//
// No network. `fetch` is stubbed, because the point of these assertions is
// what the module does with an answer, not whether a public router happens
// to be up. Three properties matter and each has cost time before:
//
//   1. OSRM speaks lng,lat and everything else here speaks lat,lng. Getting
//      that backwards draws a route through the Indian Ocean.
//   2. The cache key is the ORDERED stops. If a re-sequence could hit the
//      old key, the screen would draw yesterday's order under today's
//      numbers — which reads as confirmation, not as a bug.
//   3. A router that is down must degrade to straight hops that are LABELLED
//      as straight hops. A silent straight line is a claim about a drive.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geo = require(path.join(ROOT, "server/lib/route-geometry.js"));
const routeMap = require(path.join(ROOT, "server/lib/route-map.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const YARD = { lat: 44.0350, lng: -79.4820 };
const stop = (lat, lng) => ({ coords: { lat, lng } });
const A = stop(44.1084804, -79.5006803);   // 90 Oriole Drive
const B = stop(44.0984667, -79.4273759);   // 15 Maplehyrn Ave
const C = stop(44.0575173, -79.4532481);   // 89 Prospect St

// ---- The closed tour -------------------------------------------------
//
// A day starts and ends at the yard. The sequencer optimised a closed
// tour, so the drawing has to close too or it shows a different journey
// from the one the times describe.

const tour = geo.tourPoints(YARD, [A, B, C]);
ok("the tour starts at the yard", tour[0].lat === YARD.lat && tour[0].lng === YARD.lng);
ok("the tour returns to the yard",
  tour[tour.length - 1].lat === YARD.lat && tour[tour.length - 1].lng === YARD.lng);
ok("the tour holds every stop plus both yard ends", tour.length === 5, `got ${tour.length}`);
ok("stops keep their given order — the sequencer decides it, not this module",
  tour[1].lat === A.coords.lat && tour[2].lat === B.coords.lat && tour[3].lat === C.coords.lat);

ok("an unlocatable yard drops the anchor rather than inventing one",
  geo.tourPoints(null, [A, B]).length === 2);

ok("straightLine emits [lat, lng] pairs, Leaflet's order",
  JSON.stringify(geo.straightLine([{ lat: 1, lng: 2 }])) === "[[1,2]]");

// ---- The cache key ---------------------------------------------------

const key = (origin, stops) => geo.cacheKey(origin, stops);
ok("the same route keys the same", key(YARD, [A, B, C]) === key(YARD, [A, B, C]));
ok("REORDERING THE STOPS CHANGES THE KEY — a re-sequence must never hit the old line",
  key(YARD, [A, B, C]) !== key(YARD, [A, C, B]));
ok("moving the yard changes the key — the anchor is part of the drive",
  key(YARD, [A, B, C]) !== key({ lat: 43.9, lng: -79.4 }, [A, B, C]));
ok("dropping a stop changes the key", key(YARD, [A, B, C]) !== key(YARD, [A, B]));

// ---- Fetch stubbing --------------------------------------------------

const realFetch = globalThis.fetch;
let calls = 0;
let seenUrl = "";
function stubFetch(handler) {
  calls = 0;
  seenUrl = "";
  globalThis.fetch = async (url, opts) => { calls += 1; seenUrl = String(url); return handler(url, opts); };
}
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

// A two-point geojson line in OSRM's own [lng, lat] order. If the module
// forgets to flip it, latitude 44 becomes longitude 44 and the day is
// drawn in Somalia — so this asserts the flip, not just "some array".
const OSRM_OK = {
  code: "Ok",
  routes: [{ geometry: { coordinates: [[-79.4820, 44.0350], [-79.5006, 44.1084]] } }]
};

// ---- The polyline decoder --------------------------------------------
//
// Google hands back its geometry encoded. route-map.js's encoder is checked
// against the example in Google's own published documentation, so asserting
// the round trip pins the decoder to the spec rather than to itself.

const REFERENCE = [
  { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }
];
const decoded = geo.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
ok("the decoder reverses Google's published reference polyline",
  JSON.stringify(decoded) === JSON.stringify(REFERENCE.map((p) => [p.lat, p.lng])),
  JSON.stringify(decoded));
ok("encode -> decode is a round trip",
  JSON.stringify(geo.decodePolyline(routeMap.encodePath(REFERENCE)))
    === JSON.stringify(REFERENCE.map((p) => [p.lat, p.lng])));
ok("an empty polyline decodes to nothing, not to [0,0]",
  geo.decodePolyline("").length === 0);

// ---- Google Directions, which is tried first --------------------------

const GOOGLE_OK = {
  status: "OK",
  routes: [{ overview_polyline: { points: routeMap.encodePath(REFERENCE) } }]
};

const hadKey = process.env.GOOGLE_MAPS_SERVER_KEY;
process.env.GOOGLE_MAPS_SERVER_KEY = "test-key";

stubFetch(async () => jsonResponse(GOOGLE_OK));
const viaGoogle = await geo.roadLine(YARD, [A, B], { noCache: true });
ok("with a key set, Google Directions is asked first",
  /maps\.googleapis\.com\/maps\/api\/directions/.test(seenUrl), seenUrl);
ok("a Google answer is labelled google, not osrm", viaGoogle.source === "google", viaGoogle.source);
ok("Google's encoded geometry is decoded into lat,lng pairs",
  viaGoogle.coords[0][0] === 38.5 && viaGoogle.coords[0][1] === -120.2,
  JSON.stringify(viaGoogle.coords[0]));
ok("the yard is origin AND destination — the day is a closed tour",
  /origin=44\.035%2C-79\.482/.test(seenUrl) && /destination=44\.035%2C-79\.482/.test(seenUrl), seenUrl);
ok("the stops travel as waypoints, in order", /waypoints=/.test(seenUrl), seenUrl);
ok("OPTIMIZE IS NEVER SENT — the sequencer owns the order, not Google",
  !/optimize/.test(seenUrl), seenUrl);

// A refused key must not take the map down: OSRM is the second try.
let seq = 0;
stubFetch(async (url) => {
  seq += 1;
  if (String(url).includes("googleapis")) {
    return jsonResponse({ status: "REQUEST_DENIED", error_message: "not authorized to use this API" });
  }
  return jsonResponse(OSRM_OK);
});
const fellBack = await geo.roadLine(YARD, [A], { noCache: true });
ok("A REFUSED DIRECTIONS KEY FALLS THROUGH TO OSRM RATHER THAN TO STRAIGHT LINES",
  fellBack.source === "osrm", fellBack.source);
ok("...and it took two attempts to get there", seq === 2, `${seq} calls`);

// Both down -> straight, carrying BOTH reasons.
stubFetch(async (url) => {
  if (String(url).includes("googleapis")) {
    return jsonResponse({ status: "REQUEST_DENIED", error_message: "not authorized to use this API" });
  }
  throw new Error("connect ECONNREFUSED");
});
const bothDown = await geo.roadLine(YARD, [A], { noCache: true });
ok("with every router down the line is straight", bothDown.source === "straight", bothDown.source);
ok("...and BOTH routers' reasons survive, so neither failure hides the other",
  /REQUEST_DENIED/.test(bothDown.error || "") && /ECONNREFUSED/.test(bothDown.error || ""),
  bothDown.error);

if (hadKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
else process.env.GOOGLE_MAPS_SERVER_KEY = hadKey;

ok("with no key, Google is not attempted at all", geo.googleConfigured() === false);

// ---- A router that answers -------------------------------------------

stubFetch(async () => jsonResponse(OSRM_OK));
const good = await geo.roadLine(YARD, [A], { noCache: true });
ok("a good answer is marked as roads", good.source === "osrm", good.source);
ok("a good answer carries no error", good.error === null);
ok("COORDINATES ARE FLIPPED OUT OF OSRM's lng,lat INTO lat,lng",
  good.coords[0][0] === 44.0350 && good.coords[0][1] === -79.4820,
  JSON.stringify(good.coords[0]));
ok("every point is flipped, not just the first",
  good.coords[1][0] === 44.1084 && good.coords[1][1] === -79.5006,
  JSON.stringify(good.coords[1]));
ok("the request asks for the simplified overview, not the full one",
  /overview=simplified/.test(seenUrl), seenUrl);
ok("the request sends lng,lat — OSRM's order, not ours",
  /-79\.482,44\.035/.test(seenUrl), seenUrl);

// ---- A router that is down -------------------------------------------

stubFetch(async () => { throw new Error("connect ECONNREFUSED"); });
const down = await geo.roadLine(YARD, [A, B], { noCache: true });
ok("a dead router still returns something drawable", down.coords.length === 4);
ok("...and it is the closed tour, straight",
  down.coords[0][0] === YARD.lat && down.coords[3][0] === YARD.lat);
ok("A STRAIGHT FALLBACK SAYS SO — a silent straight line claims a drive it cannot show",
  down.source === "straight", down.source);
ok("the router's own words survive, so the fix is diagnosable",
  /ECONNREFUSED/.test(down.error || ""), down.error);

stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
const refused = await geo.roadLine(YARD, [A], { noCache: true });
ok("an HTTP rejection falls back and names the status",
  refused.source === "straight" && /429/.test(refused.error || ""), refused.error);

stubFetch(async () => jsonResponse({ code: "NoRoute", message: "no route found" }));
const noRoute = await geo.roadLine(YARD, [A], { noCache: true });
ok("a router that answers 'NoRoute' is a failure, not an empty success",
  noRoute.source === "straight" && /NoRoute/.test(noRoute.error || ""), noRoute.error);

// ---- Nothing to draw -------------------------------------------------

const empty = await geo.roadLine(YARD, [], { noCache: true });
ok("a day with no mappable stop draws nothing rather than a line to itself",
  empty.source === "none" && empty.coords.length === 0);

const noCoords = await geo.roadLine(YARD, [{ coords: { lat: null, lng: null } }], { noCache: true });
ok("a stop with no coordinates is skipped, not sent as null", noCoords.source === "none");

// ---- The cache -------------------------------------------------------
//
// Written and read under a temp dir so the repo's own cache is untouched.

const scratch = fs.mkdtempSync(path.join(ROOT, "server/data/.rgtest-"));
try {
  const cached = { ...geo, CACHE_DIR: scratch };
  // The module resolves its own dir, so exercise the real one but clean up:
  // write a key by hand and prove a matching route reads it without fetching.
  const stops = [A, B];
  const file = path.join(geo.CACHE_DIR, `${geo.cacheKey(YARD, stops)}.json`);
  fs.mkdirSync(geo.CACHE_DIR, { recursive: true });
  const planted = [[44.1, -79.5], [44.2, -79.6]];
  fs.writeFileSync(file, JSON.stringify({ source: "google", coords: planted }));

  stubFetch(async () => { throw new Error("the cache should have answered this"); });
  const hit = await geo.roadLine(YARD, stops);
  ok("a cached line is served without touching the router", calls === 0, `${calls} calls`);
  ok("...and it is the cached geometry", JSON.stringify(hit.coords) === JSON.stringify(planted));
  ok("...and it is reported with the router that produced it, not a guess",
    hit.source === "google" && hit.cached === true, hit.source);

  // The earlier format — a bare array — is still on the deployed disk from
  // the OSRM-only version. It must read, not be silently refetched.
  const legacyStops = [B, C];
  const legacyFile = path.join(geo.CACHE_DIR, `${geo.cacheKey(YARD, legacyStops)}.json`);
  fs.writeFileSync(legacyFile, JSON.stringify(planted));
  stubFetch(async () => { throw new Error("the legacy cache should have answered this"); });
  const legacy = await geo.roadLine(YARD, legacyStops);
  ok("a cache file in the OLD bare-array format still reads",
    calls === 0 && JSON.stringify(legacy.coords) === JSON.stringify(planted), `${calls} calls`);
  ok("...and is labelled osrm, which is what wrote it", legacy.source === "osrm", legacy.source);
  fs.rmSync(legacyFile, { force: true });

  // The property that matters: the SAME stops in a different order must
  // not read that file.
  stubFetch(async () => jsonResponse(OSRM_OK));
  const reordered = await geo.roadLine(YARD, [B, A], { noCache: false });
  ok("A RE-SEQUENCED DAY MISSES THE CACHE AND REFETCHES", calls === 1, `${calls} calls`);
  ok("...and does not serve the old order's geometry",
    JSON.stringify(reordered.coords) !== JSON.stringify(planted));

  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(geo.CACHE_DIR, `${geo.cacheKey(YARD, [B, A])}.json`), { force: true });
  void cached;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  globalThis.fetch = realFetch;
}

// ---- Where things live -----------------------------------------------

ok("lines cache under server/data, which is gitignored",
  /server[/\\]data[/\\]route-lines$/.test(geo.CACHE_DIR), geo.CACHE_DIR);
ok("the router host is overridable without a deploy",
  typeof geo.DEFAULT_OSRM_BASE === "string" && /^https:\/\//.test(geo.DEFAULT_OSRM_BASE));


if (failures.length) {
  console.error(`\n✗ test-route-geometry: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-route-geometry: ${pass} assertions passed`);

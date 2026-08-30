// Road geometry for a route day — the shape of the drive, nothing else.
//
// The map on /admin/season-plan is Leaflet with CARTO tiles: no key, no
// per-load charge, and OUR numbered pins on top. Google's static markers
// take a SINGLE character, so on a nine-stop day the later stops silently
// lose their number; drawing the markers ourselves removes that limit
// along with the per-map billing. All we still need from a router is the
// line between the stops.
//
// THE LINE ONLY. NEVER THE MINUTES.
//
// Every minute on this screen — arrival times, the noon rule, the
// 15-minute added-drive test that decides who is offered a day — comes
// from Google Distance Matrix, and those numbers are what the customer was
// told. A second router printing its own drive times beside them would put
// two different figures for the same leg on one screen with no way to tell
// which one the booking page believed. That is the R10 bug wearing a new
// hat. OSRM draws the line; Google keeps the clock.
//
// CACHED ON THE ORDERED STOPS, NOT THE DATE — the same rule as
// route-map.js. A re-sequence changes the key and refetches; a refresh
// costs nothing. A stale line drawn through yesterday's order would not
// look broken, it would look like confirmation.
//
// FAILS SOFT. A router that is down must not take the map with it: the
// day falls back to straight hops between the stops, flagged as such, so
// the screen can say the lines are not roads instead of quietly implying
// the drive is a straight line.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const CACHE_DIR = path.join(__dirname, "..", "data", "route-lines");

// The public demo box is a community service, not a production one. Point
// PJL_OSRM_URL at a private instance to move off it without a deploy —
// the same escape hatch PJL_ROUTE_ORIGIN gives the yard.
const DEFAULT_OSRM_BASE = "https://router.project-osrm.org";
const REQUEST_TIMEOUT_MS = 8000;

function osrmBase() {
  return (process.env.PJL_OSRM_URL || DEFAULT_OSRM_BASE).replace(/\/+$/, "");
}

// Number(null) is 0 and Number("") is 0, so a bare isFinite() check calls a
// missing coordinate valid and sends the router to Null Island — a stop off
// the coast of Africa that silently drags the whole day's line with it.
function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usable(point) {
  return Boolean(point && coordinate(point.lat) !== null && coordinate(point.lng) !== null);
}

// Keyed on the coordinates in driving order, plus the yard. Identical to
// route-map.js's key on purpose: the two caches answer the same question
// about the same route and should invalidate together.
function cacheKey(origin, stops) {
  const parts = [origin && usable(origin) ? `${origin.lat},${origin.lng}` : "nobase",
    ...stops.map((s) => `${s.coords.lat},${s.coords.lng}`)];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

// Yard -> stops in order -> yard. The closed tour is the day, and it is
// what the sequencer optimised, so the drawing has to close too.
function tourPoints(origin, stops) {
  const anchored = usable(origin);
  const middle = stops.map((s) => ({ lat: Number(s.coords.lat), lng: Number(s.coords.lng) }));
  if (!anchored) return middle;
  const yard = { lat: Number(origin.lat), lng: Number(origin.lng) };
  return [yard, ...middle, yard];
}

function straightLine(points) {
  return points.map((p) => [p.lat, p.lng]);
}

// OSRM takes lng,lat — the reverse of every other coordinate in this
// codebase. Getting this backwards produces a route through the Indian
// Ocean, which at least fails loudly.
async function fetchOsrm(points) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  // `simplified` is Douglas-Peucker'd server-side: a few hundred points
  // per day instead of a few thousand, which is more than enough shape at
  // the zoom a whole route is viewed at, and a tenth of the payload.
  const url = `${osrmBase()}/route/v1/driving/${coords}`
    + "?overview=simplified&geometries=geojson&steps=false&alternatives=false";

  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Router answered HTTP ${response.status}.`);
  const data = await response.json();
  if (data.code !== "Ok") {
    throw new Error([data.code, data.message].filter(Boolean).join(" — ") || "Router refused the route.");
  }
  const line = data.routes && data.routes[0] && data.routes[0].geometry
    && data.routes[0].geometry.coordinates;
  if (!Array.isArray(line) || line.length < 2) throw new Error("Router returned no geometry.");
  // Back to lat,lng for Leaflet.
  return line.map(([lng, lat]) => [lat, lng]);
}

async function readCache(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length >= 2 ? parsed : null;
  } catch {
    return null;
  }
}

// Returns { coords, source, error, cached }. `coords` is always drawable:
// on any failure it is the straight tour, and `source` says so.
async function roadLine(origin, stops, opts = {}) {
  const clean = (stops || []).filter((s) => s && usable(s.coords));
  if (clean.length < 1) return { coords: [], source: "none", error: null, cached: false };

  const points = tourPoints(origin, clean);
  const fallback = { coords: straightLine(points), source: "straight" };

  const file = path.join(CACHE_DIR, `${cacheKey(origin, clean)}.json`);
  if (!opts.noCache) {
    const hit = await readCache(file);
    if (hit) return { coords: hit, source: "osrm", error: null, cached: true };
  }

  try {
    const coords = await fetchOsrm(points);
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify(coords));
    } catch (err) {
      console.warn("[route-geometry] could not cache line:", err?.message);
    }
    return { coords, source: "osrm", error: null, cached: false };
  } catch (err) {
    // The router's own words, kept. "connect ECONNREFUSED" and "NoRoute"
    // are different problems with different fixes, and collapsing them
    // into "unavailable" is what turned the last map failure into a guess.
    const detail = err?.name === "TimeoutError"
      ? `Router did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
      : (err?.message || "Router request failed.");
    console.warn("[route-geometry] osrm:", detail, "— drawing straight hops");
    return { ...fallback, error: detail, cached: false };
  }
}

module.exports = { roadLine, cacheKey, tourPoints, straightLine, CACHE_DIR, DEFAULT_OSRM_BASE };

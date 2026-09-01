// Road geometry for a route day — the shape of the drive, nothing else.
//
// The map on /admin/season-plan is the Google Maps JavaScript API. The
// geometry, though, is fetched HERE and cached, not asked for by the
// browser: that keeps GOOGLE_MAPS_SERVER_KEY on the server and costs one
// Directions call per route CHANGE rather than one per page view.
//
// Google Directions first, OSRM as the fallback. Directions is what the
// rest of the system already pays for and its geometry matches the basemap
// the line is drawn on; OSRM is kept because it needs no key and covers a
// refused or throttled Directions call without the day losing its shape.
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

function googleConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_KEY);
}

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

// Google returns its geometry as an encoded polyline. This is the inverse of
// route-map.js's encodePath, which is itself checked against the example in
// Google's published documentation — so the pair is verified against the spec
// and the round trip is asserted in the tests.
function decodePolyline(encoded) {
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

// `optimize` is deliberately absent. The re-sequencer decides the order and
// this only draws it; letting Google reshuffle would produce a picture that
// disagrees with the arrival times the customer was told.
async function fetchGoogleDirections(points) {
  const at = (p) => `${p.lat},${p.lng}`;
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", at(points[0]));
  url.searchParams.set("destination", at(points[points.length - 1]));
  if (points.length > 2) {
    url.searchParams.set("waypoints", points.slice(1, -1).map(at).join("|"));
  }
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = await response.json();
  if (data.status !== "OK") {
    // Google names the fix in its own words — "REQUEST_DENIED / This API
    // project is not authorized" is the whole diagnosis. Throwing that away
    // is what turned a five-minute key fix into a day of guessing.
    throw new Error([data.status, data.error_message].filter(Boolean).join(" — "));
  }
  const encoded = data.routes && data.routes[0] && data.routes[0].overview_polyline
    && data.routes[0].overview_polyline.points;
  if (!encoded) throw new Error("Directions returned no geometry.");
  const line = decodePolyline(encoded);
  if (line.length < 2) throw new Error("Directions returned no geometry.");
  return line;
}

// Cache entries are { source, coords }. A bare array is the earlier format,
// still sitting on the deployed disk from the OSRM-only version — read it
// rather than refetching every one of them, and label it as what wrote it.
async function readCache(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed.length >= 2 ? { source: "osrm", coords: parsed } : null;
    }
    if (parsed && Array.isArray(parsed.coords) && parsed.coords.length >= 2) {
      return { source: parsed.source === "google" ? "google" : "osrm", coords: parsed.coords };
    }
    return null;
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
    if (hit) return { coords: hit.coords, source: hit.source, error: null, cached: true };
  }

  const reasons = [];
  for (const attempt of routers(opts)) {
    try {
      const coords = await attempt.run(points);
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(file, JSON.stringify({ source: attempt.name, coords }));
      } catch (err) {
        console.warn("[route-geometry] could not cache line:", err?.message);
      }
      return { coords, source: attempt.name, error: null, cached: false };
    } catch (err) {
      // Each router's own words, kept and carried. "REQUEST_DENIED" and
      // "connect ECONNREFUSED" are different problems with different fixes,
      // and collapsing them into "unavailable" is what turned the last map
      // failure into a guess.
      const detail = err?.name === "TimeoutError"
        ? `did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
        : (err?.message || "request failed");
      console.warn(`[route-geometry] ${attempt.name}:`, detail);
      reasons.push(`${attempt.name}: ${detail}`);
    }
  }
  console.warn("[route-geometry] no router answered — drawing straight hops");
  return { ...fallback, error: reasons.join("; ") || "No router configured.", cached: false };
}

// Google first: it is what the rest of the system already pays for, and its
// geometry matches the basemap the line is drawn on. OSRM covers a refused or
// throttled Directions call without the day losing its shape.
function routers(opts = {}) {
  const list = [];
  if (googleConfigured() && !opts.skipGoogle) list.push({ name: "google", run: fetchGoogleDirections });
  if (!opts.skipOsrm) list.push({ name: "osrm", run: fetchOsrm });
  return list;
}

module.exports = {
  roadLine, cacheKey, tourPoints, straightLine, decodePolyline,
  googleConfigured, CACHE_DIR, DEFAULT_OSRM_BASE
};

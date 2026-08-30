// Route map images for /admin/season-plan.
//
// A day's route has to be visible ON the day, in the list, without opening
// anything. That rules out a modal, and it rules out eleven interactive
// map widgets on one page — each of those is a billable map load and a
// second or two of script, eleven times over, on a page Patrick refreshes
// all day.
//
// So each day is a flat PNG, built server-side:
//
//   1. Ask Directions for the road path through the stops, in OUR order.
//   2. Hand its encoded polyline to Static Maps along with a numbered
//      marker per stop and a home marker for the yard.
//   3. Cache the finished image on disk, keyed by the stops themselves,
//      and serve it through our own route.
//
// THE KEY NEVER LEAVES THE SERVER. The browser asks our endpoint for an
// image; we hold GOOGLE_MAPS_SERVER_KEY. That is also why there is no new
// browser key to configure — the one already set for drive times does
// this too.
//
// CACHING IS KEYED ON THE ROUTE, NOT THE DATE. The cache key is a hash of
// the ordered coordinates, so a re-sequence produces a different key and a
// new image, while a page refresh costs nothing. A stale map showing the
// old order would be worse than no map at all: it would look like
// confirmation.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CACHE_DIR = path.join(__dirname, "..", "data", "route-maps");

const SIZE = "640x360";
const SCALE = 2;                        // legible on a laptop and a phone
const ROUTE_COLOUR = "0x1B4D2E";        // --pjl-green
const HOME_COLOUR = "0xE07B24";         // --pjl-amber

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_KEY);
}

function cacheKey(origin, stops) {
  const parts = [origin ? `${origin.lat},${origin.lng}` : "nobase",
    ...stops.map((s) => `${s.coords.lat},${s.coords.lng}`)];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

// Road geometry for the stops IN THE GIVEN ORDER. optimize is deliberately
// absent: the re-sequencer decides the order and this only draws it, so
// letting Google reshuffle would produce a picture that disagrees with the
// times the customer was told.
async function roadPolyline(origin, stops) {
  if (!isConfigured() || stops.length < 1) return null;
  const point = (c) => `${c.lat},${c.lng}`;
  const start = origin && origin.lat != null ? point(origin) : point(stops[0].coords);
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", start);
  url.searchParams.set("destination", start);
  url.searchParams.set("waypoints", stops.map((s) => point(s.coords)).join("|"));
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);
  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    if (data.status !== "OK") {
      // Google's own words, kept. "REQUEST_DENIED / This API project is not
      // authorized to use this API" is the whole diagnosis, and throwing it
      // away is what turned a five-second fix into a guess.
      const detail = [data.status, data.error_message].filter(Boolean).join(" — ");
      console.warn("[route-map] directions:", detail, "— drawing straight hops");
      return { error: detail };
    }
    return { points: data.routes?.[0]?.overview_polyline?.points || null };
  } catch (err) {
    console.warn("[route-map] directions failed:", err?.message);
    return { error: err?.message || "Directions request failed." };
  }
}

// Google's own encoder, so a straight-line fallback can use the same
// compact `enc:` parameter as a real road path instead of a long list of
// raw coordinates that risks the URL length limit on a big day.
function encodePath(points) {
  let last = [0, 0];
  let out = "";
  const chunk = (v) => {
    let value = v < 0 ? ~(v << 1) : (v << 1);
    let s = "";
    while (value >= 0x20) {
      s += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return s + String.fromCharCode(value + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += chunk(lat - last[0]) + chunk(lng - last[1]);
    last = [lat, lng];
  }
  return out;
}

// Static Maps marker labels take a SINGLE character, so stops past nine
// would silently lose their number. Those get an unlabelled dot and the
// legend beside the map carries the ordering — better than a marker that
// looks like stop 1 when it is stop 10.
function markerParams(origin, stops) {
  const params = [];
  if (origin && origin.lat != null) {
    params.push(`color:${HOME_COLOUR}|label:H|${origin.lat},${origin.lng}`);
  }
  for (const stop of stops) {
    const label = stop.number >= 1 && stop.number <= 9 ? `label:${stop.number}|` : "";
    params.push(`color:${ROUTE_COLOUR}|${label}${stop.coords.lat},${stop.coords.lng}`);
  }
  return params;
}

// Returns { buffer, contentType, cached } or null when Maps is not
// configured. Never throws — a missing map is a missing picture, not a
// broken plan screen.
async function routeMapImage(origin, stops) {
  if (!isConfigured()) return { error: "GOOGLE_MAPS_SERVER_KEY is not set on the server." };
  if (!stops.length) return { error: "This day has no stops with coordinates." };
  const key = cacheKey(origin, stops);
  const file = path.join(CACHE_DIR, `${key}.png`);
  try {
    if (fsSync.existsSync(file)) {
      return { buffer: await fs.readFile(file), contentType: "image/png", cached: true };
    }
  } catch { /* fall through and re-fetch */ }

  const road = await roadPolyline(origin, stops);
  const encoded = (road && road.points) || encodePath([
    ...(origin && origin.lat != null ? [origin] : []),
    ...stops.map((s) => s.coords),
    ...(origin && origin.lat != null ? [origin] : [])
  ]);
  // A straight-hop fallback is a usable map, so it is not an error — but
  // the reason travels with the result so the screen can say the lines
  // are not roads, and why.
  const roadsError = road && road.error ? road.error : null;

  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("size", SIZE);
  url.searchParams.set("scale", String(SCALE));
  url.searchParams.set("maptype", "roadmap");
  url.searchParams.append("path", `color:${ROUTE_COLOUR}ff|weight:4|enc:${encoded}`);
  for (const m of markerParams(origin, stops)) url.searchParams.append("markers", m);
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      // Static Maps answers a rejection with a plain-text explanation.
      // That text names the enabled-API or key-restriction problem
      // outright, so it is passed straight through to the operator.
      let detail = "";
      try { detail = (await response.text()).trim().slice(0, 300); } catch { /* body optional */ }
      console.warn("[route-map] static map", response.status, detail);
      return {
        error: `Google refused the map request (HTTP ${response.status}).`,
        detail: detail || null,
        roadsError
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(file, buffer);
    } catch (err) {
      console.warn("[route-map] could not cache image:", err?.message);
    }
    return { buffer, contentType: "image/png", cached: false, roadsError };
  } catch (err) {
    console.warn("[route-map] static map fetch failed:", err?.message);
    return { error: err?.message || "Static map request failed." };
  }
}

module.exports = { routeMapImage, cacheKey, isConfigured, encodePath, CACHE_DIR };

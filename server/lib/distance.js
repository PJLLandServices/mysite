// Travel-time estimator. Uses Google Distance Matrix API when configured,
// falls back to a Haversine straight-line distance × tunable factor when not.
//
// The availability engine calls this once per (origin, destination) pair when
// computing slot eligibility. Results cache to disk so repeat lookups (same
// pairs, e.g. PJL base -> Newmarket cluster) don't re-bill.
//
// Cache key = "lat1,lng1|lat2,lng2" rounded to 4 decimals (~11m precision).
// That's tight enough that "same customer's house" hits cache even across
// re-geocodes, but loose enough that two visits on the same street block
// share a cache entry.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const CACHE_PATH = path.join(__dirname, "..", "data", "distance-cache.json");

// Average urban+rural Ontario driving speed factor for the Haversine fallback.
// Real driving distance is ~1.3-1.5x straight-line; speed averages ~50 km/h
// on the kind of roads PJL uses. So minutes ≈ (haversine_km × 1.4) / 50 × 60.
// That's roughly 1.68 minutes per km of straight-line distance. Tunable here:
const HAVERSINE_MINUTES_PER_KM = 1.7;
// Minimum travel time even for adjacent stops (parking, equipment swap):
const MIN_TRAVEL_MINUTES = 5;

let cacheMemo = null;

async function loadCache() {
  if (cacheMemo) return cacheMemo;
  try {
    if (!fsSync.existsSync(CACHE_PATH)) {
      cacheMemo = {};
      return cacheMemo;
    }
    cacheMemo = JSON.parse((await fs.readFile(CACHE_PATH, "utf8")) || "{}");
  } catch {
    cacheMemo = {};
  }
  return cacheMemo;
}

async function saveCache() {
  if (!cacheMemo) return;
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cacheMemo, null, 2), "utf8");
  } catch (err) {
    console.error("[distance] Failed to persist cache:", err.message);
  }
}

function key(origin, dest) {
  const r = (n) => Number(n).toFixed(4);
  return `${r(origin.lat)},${r(origin.lng)}|${r(dest.lat)},${r(dest.lng)}`;
}

function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fallbackMinutes(origin, dest) {
  const km = haversineKm(origin, dest);
  return Math.max(MIN_TRAVEL_MINUTES, Math.round(km * HAVERSINE_MINUTES_PER_KM));
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_KEY);
}

// Returns minutes (integer). Always returns a number, never throws.
async function travelMinutes(origin, dest) {
  if (!origin || !dest) return MIN_TRAVEL_MINUTES;
  if (origin.lat === dest.lat && origin.lng === dest.lng) return MIN_TRAVEL_MINUTES;

  const cache = await loadCache();
  const k = key(origin, dest);
  if (cache[k] != null) return cache[k];

  if (!isConfigured()) {
    const minutes = fallbackMinutes(origin, dest);
    cache[k] = minutes;
    saveCache().catch(() => {});
    return minutes;
  }

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", `${dest.lat},${dest.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    const element = data.rows?.[0]?.elements?.[0];
    if (data.status !== "OK" || !element || element.status !== "OK") {
      console.warn("[distance] Google returned", data.status, element?.status, "— using Haversine fallback");
      const minutes = fallbackMinutes(origin, dest);
      cache[k] = minutes;
      saveCache().catch(() => {});
      return minutes;
    }
    const minutes = Math.max(MIN_TRAVEL_MINUTES, Math.round(element.duration.value / 60));
    cache[k] = minutes;
    saveCache().catch(() => {});
    return minutes;
  } catch (error) {
    console.error("[distance] Network error, falling back:", error.message);
    return fallbackMinutes(origin, dest);
  }
}

// Straight-line estimate, no API call and no cache write. The geography
// filter uses this to RANK candidate insertion positions cheaply, then
// confirms only the winning position with travelMinutes() above. Ranking
// 8 positions with Google would bill 24 elements per route day per
// address; ranking them with this bills none, and the winner is the same
// one because the ordering of "which gap does this house fit in" is a
// far coarser judgement than the minutes themselves.
// UNFLOORED travel time — what the road actually costs, before
// MIN_TRAVEL_MINUTES is applied.
//
// travelMinutes() floors every answer at 5 minutes because no visit is
// really shorter: parking, unloading, knocking on a door. That is correct
// for building a schedule and wrong for CHOOSING A ROUTE. Under the floor
// two houses 40 m apart and two 1.5 km apart both cost "5 minutes", so the
// route optimiser cannot tell them apart, and worse, the flooring shifts
// comparisons between whole candidate orders by whole minutes. A
// tiebreaker cannot repair that: it can only settle an exact tie, and the
// distortion is not a tie.
//
// So the re-sequencer orders on THIS, and builds its clock from
// travelMinutes(). Own cache file, because the existing cache holds
// already-floored values that cannot be un-floored after the fact —
// reading them as raw would bake 5 minutes into every short hop, which is
// the bug this exists to avoid. Plan-time only, so the extra lookups
// never land on a customer's booking request.
const RAW_CACHE_PATH = path.join(__dirname, "..", "data", "distance-cache-raw.json");
let rawCacheMemo = null;

async function loadRawCache() {
  if (rawCacheMemo) return rawCacheMemo;
  try {
    if (!fsSync.existsSync(RAW_CACHE_PATH)) { rawCacheMemo = {}; return rawCacheMemo; }
    rawCacheMemo = JSON.parse((await fs.readFile(RAW_CACHE_PATH, "utf8")) || "{}");
  } catch { rawCacheMemo = {}; }
  return rawCacheMemo;
}

async function saveRawCache() {
  if (!rawCacheMemo) return;
  try {
    await fs.mkdir(path.dirname(RAW_CACHE_PATH), { recursive: true });
    await fs.writeFile(RAW_CACHE_PATH, JSON.stringify(rawCacheMemo, null, 2), "utf8");
  } catch (err) {
    console.error("[distance] Failed to persist raw cache:", err.message);
  }
}

// Minutes with no floor applied. Always returns a number, never throws.
// Falls back to an unfloored Haversine estimate when Google is not
// configured or errors — unfloored is the point, so the fallback keeps
// its fractional value rather than rounding up to the minimum.
async function travelMinutesRaw(origin, dest) {
  if (!origin || !dest) return 0;
  if (origin.lat === dest.lat && origin.lng === dest.lng) return 0;

  const cache = await loadRawCache();
  const k = key(origin, dest);
  if (cache[k] != null) return cache[k];

  const unflooredFallback = () => haversineKm(origin, dest) * HAVERSINE_MINUTES_PER_KM;

  if (!isConfigured()) {
    const minutes = unflooredFallback();
    cache[k] = minutes;
    saveRawCache().catch(() => {});
    return minutes;
  }

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", `${dest.lat},${dest.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    const element = data.rows?.[0]?.elements?.[0];
    let minutes;
    if (data.status !== "OK" || !element || element.status !== "OK") {
      console.warn("[distance] raw lookup got", data.status, element?.status, "— using estimate");
      minutes = unflooredFallback();
    } else {
      minutes = element.duration.value / 60;
    }
    cache[k] = minutes;
    saveRawCache().catch(() => {});
    return minutes;
  } catch (error) {
    console.error("[distance] raw lookup network error, estimating:", error.message);
    return unflooredFallback();
  }
}

function estimateMinutes(origin, dest) {
  if (!origin || !dest || origin.lat == null || dest.lat == null) return MIN_TRAVEL_MINUTES;
  return fallbackMinutes(origin, dest);
}

module.exports = { travelMinutes, travelMinutesRaw, estimateMinutes, haversineKm, MIN_TRAVEL_MINUTES, isConfigured };

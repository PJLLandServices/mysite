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

module.exports = { travelMinutes, MIN_TRAVEL_MINUTES, isConfigured };

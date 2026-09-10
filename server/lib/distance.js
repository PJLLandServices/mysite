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
//
// FAILURE POSTURE (Patrick, 2026-09-02: "we cannot have this fail").
// lib/geocode.js was hardened for this; the travel-time half was not, and
// it had the two defects that matter most on a booking request:
//
//   1. NO TIMEOUT. `fetch` with no signal waits as long as Google wants to
//      take. The availability engine makes one of these per candidate slot,
//      awaited in sequence, so ONE hung request holds the whole request
//      open and the customer watches a spinner. Every call now has a hard
//      4-second cap and one retry on a transient failure — an 8-second
//      worst case, then a straight-line estimate and a booking that still
//      works.
//
//   2. GUESSES WERE CACHED AS ANSWERS. When Google was unreachable, over
//      quota, or simply not configured yet, the Haversine estimate was
//      written into the cache — permanently. Nothing ever re-checked it,
//      so a key added later changed nothing for any pair already guessed:
//      the geography filter kept measuring the corridor with straight
//      lines. Only a REAL Google answer is cached now. A fallback is
//      returned and forgotten (it is pure arithmetic — recomputing it
//      costs nothing).
//
// Entries written under the old rule cannot be told apart from good ones
// after the fact — a bare number carries no provenance — so they are
// dropped on load and the file is rewritten without them. That is a
// one-time re-bill of the pairs that are still in use, against a cache
// that would otherwise stay wrong forever.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-json");

const CACHE_PATH = path.join(__dirname, "..", "data", "distance-cache.json");

// Average urban+rural Ontario driving speed factor for the Haversine fallback.
// Real driving distance is ~1.3-1.5x straight-line; speed averages ~50 km/h
// on the kind of roads PJL uses. So minutes ≈ (haversine_km × 1.4) / 50 × 60.
// That's roughly 1.68 minutes per km of straight-line distance. Tunable here:
const HAVERSINE_MINUTES_PER_KM = 1.7;
// Minimum travel time even for adjacent stops (parking, equipment swap):
const MIN_TRAVEL_MINUTES = 5;

// One attempt, and the retry that follows it. Same shape as geocode.js:
// a transient failure gets one more go after a beat, a definitive answer
// (ZERO_RESULTS, REQUEST_DENIED, OVER_QUERY_LIMIT) does not — retrying
// those burns quota to be told the same thing.
const GOOGLE_TIMEOUT_MS = 4000;
const GOOGLE_RETRY_DELAY_MS = 300;

// ---- Cache provenance -------------------------------------------------
//
// An entry is { minutes, source: "google", at }. Anything else — a bare
// number from before this rule, or an entry marked any other way — is a
// guess wearing an answer's clothes, and is dropped rather than served.

function isTrustedEntry(entry) {
  return Boolean(entry)
    && typeof entry === "object"
    && entry.source === "google"
    && Number.isFinite(Number(entry.minutes));
}

function trustedMinutes(cache, k) {
  const entry = cache[k];
  return isTrustedEntry(entry) ? Number(entry.minutes) : null;
}

function remember(cache, k, minutes) {
  cache[k] = { minutes, source: "google", at: new Date().toISOString() };
}

// Returns { clean, dropped }. Called once per cache on load.
function purgeUntrusted(raw, label) {
  const clean = {};
  let dropped = 0;
  for (const [k, entry] of Object.entries(raw || {})) {
    if (isTrustedEntry(entry)) clean[k] = entry;
    else dropped += 1;
  }
  if (dropped) {
    console.warn(`[distance] dropped ${dropped} unprovenanced ${label} cache entr${dropped === 1 ? "y" : "ies"}`
      + " — straight-line estimates are no longer cached as if Google had answered.");
  }
  return { clean, dropped };
}

let cacheMemo = null;

async function loadCache() {
  if (cacheMemo) return cacheMemo;
  let raw = {};
  try {
    if (fsSync.existsSync(CACHE_PATH)) {
      raw = JSON.parse((await fs.readFile(CACHE_PATH, "utf8")) || "{}");
    }
  } catch {
    raw = {};
  }
  const { clean, dropped } = purgeUntrusted(raw, "travel-time");
  cacheMemo = clean;
  if (dropped) saveCache().catch(() => {});
  return cacheMemo;
}

async function saveCache() {
  if (!cacheMemo) return;
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeJsonAtomic(CACHE_PATH, cacheMemo);
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

// ---- The one Google call ----------------------------------------------
//
// Both travelMinutes() and travelMinutesRaw() ask the same question and
// differ only in what they do with the answer, so they ask it in one
// place. Two copies of the request would be two copies of the timeout,
// the retry rule and the status handling — and the version of this file
// that had two copies is the one where only the floored path got the
// error logging right.

async function fetchGoogleJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function matrixUrl(origin, dest) {
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", `${dest.lat},${dest.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);
  return url.toString();
}

// Seconds of driving, or null when Google could not answer. Never throws
// and never waits longer than the budget above.
async function askGoogleSeconds(origin, dest) {
  const url = matrixUrl(origin, dest);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await fetchGoogleJson(url);
      const element = data?.rows?.[0]?.elements?.[0];
      if (data?.status === "OK" && element?.status === "OK"
        && Number.isFinite(Number(element?.duration?.value))) {
        return Number(element.duration.value);
      }
      if (data?.status === "UNKNOWN_ERROR" && attempt === 1) {
        await new Promise((r) => setTimeout(r, GOOGLE_RETRY_DELAY_MS));
        continue;
      }
      console.warn("[distance] Google returned", data?.status, element?.status,
        "— using a straight-line estimate for this pair (not cached)");
      return null;
    } catch (error) {
      // AbortError (our timeout) and network errors are both transient.
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, GOOGLE_RETRY_DELAY_MS));
        continue;
      }
      console.error("[distance] Google unreachable after retry:", error.message,
        "— using a straight-line estimate for this pair (not cached)");
      return null;
    }
  }
  return null;
}

// Returns minutes (integer). Always returns a number, never throws.
async function travelMinutes(origin, dest) {
  if (!origin || !dest) return MIN_TRAVEL_MINUTES;
  if (origin.lat === dest.lat && origin.lng === dest.lng) return MIN_TRAVEL_MINUTES;

  const cache = await loadCache();
  const k = key(origin, dest);
  const cached = trustedMinutes(cache, k);
  if (cached != null) return cached;

  if (!isConfigured()) return fallbackMinutes(origin, dest);

  const seconds = await askGoogleSeconds(origin, dest);
  if (seconds == null) return fallbackMinutes(origin, dest);

  const minutes = Math.max(MIN_TRAVEL_MINUTES, Math.round(seconds / 60));
  remember(cache, k, minutes);
  saveCache().catch(() => {});
  return minutes;
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
  let raw = {};
  try {
    if (fsSync.existsSync(RAW_CACHE_PATH)) {
      raw = JSON.parse((await fs.readFile(RAW_CACHE_PATH, "utf8")) || "{}");
    }
  } catch { raw = {}; }
  const { clean, dropped } = purgeUntrusted(raw, "unfloored travel-time");
  rawCacheMemo = clean;
  if (dropped) saveRawCache().catch(() => {});
  return rawCacheMemo;
}

async function saveRawCache() {
  if (!rawCacheMemo) return;
  try {
    await fs.mkdir(path.dirname(RAW_CACHE_PATH), { recursive: true });
    await writeJsonAtomic(RAW_CACHE_PATH, rawCacheMemo);
  } catch (err) {
    console.error("[distance] Failed to persist raw cache:", err.message);
  }
}

// Minutes with no floor applied. Always returns a number, never throws.
// Falls back to an unfloored Haversine estimate when Google is not
// configured or errors — unfloored is the point, so the fallback keeps
// its fractional value rather than rounding up to the minimum. Like the
// floored path, an estimate is returned and NOT cached.
async function travelMinutesRaw(origin, dest) {
  if (!origin || !dest) return 0;
  if (origin.lat === dest.lat && origin.lng === dest.lng) return 0;

  const cache = await loadRawCache();
  const k = key(origin, dest);
  const cached = trustedMinutes(cache, k);
  if (cached != null) return cached;

  const unflooredFallback = () => haversineKm(origin, dest) * HAVERSINE_MINUTES_PER_KM;

  if (!isConfigured()) return unflooredFallback();

  const seconds = await askGoogleSeconds(origin, dest);
  if (seconds == null) return unflooredFallback();

  const minutes = seconds / 60;
  remember(cache, k, minutes);
  saveRawCache().catch(() => {});
  return minutes;
}

function estimateMinutes(origin, dest) {
  if (!origin || !dest || origin.lat == null || dest.lat == null) return MIN_TRAVEL_MINUTES;
  return fallbackMinutes(origin, dest);
}

module.exports = {
  travelMinutes,
  travelMinutesRaw,
  estimateMinutes,
  haversineKm,
  MIN_TRAVEL_MINUTES,
  isConfigured,
  // Exported for the fail-open suite, which drives the timeout and the
  // cache-provenance rules directly.
  GOOGLE_TIMEOUT_MS
};

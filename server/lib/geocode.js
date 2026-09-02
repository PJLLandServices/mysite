// Google Geocoding API wrapper.
//
// Turns a free-text address ("123 Main St, Newmarket ON") into { lat, lng,
// formattedAddress }. Used to:
//   1. Snap customer addresses to coordinates so the availability engine can
//      compute travel time from the previous booking on the same day.
//   2. Pre-validate addresses on the booking form ("we couldn't find that
//      address — did you mean...").
//
// Reads GOOGLE_MAPS_SERVER_KEY from env (set via Render). If absent, the
// module returns { ok: false, skipped: true } and the caller falls back to a
// PJL-base-coords approximation (Newmarket city centre). That keeps dev
// machines + early local testing working without a billable key.
//
// FAILURE POSTURE (Patrick, 2026-09-02: "we cannot have this fail").
// A geocode that fails no longer collapses straight to the depot pin —
// which read as "unresolved" and switched the geography filter OFF for
// that customer. Three layers now stand between a hiccup and a wrongly
// offered day:
//   1. The lookup itself is tougher: a 4-second timeout and one retry
//     on network errors and Google's transient UNKNOWN_ERROR.
//   2. When Google still can't answer (or there is no key), the address
//     text is matched against lib/town-centroids.js — a hand-kept table
//     of town centres. A recognized town returns APPROXIMATE coords
//     (source "town-centroid", still ok:false so nothing persists
//     them), which keep the geography filter ON with a close-enough
//     answer: Erin still reads as an hour away.
//   3. Only an address with no recognizable town at all falls to the
//     depot pin and skips the filter — and the season-plan probe now
//     says which of these cases happened instead of a bare "could not
//     be geocoded".
//
// Results are cached on disk in server/data/geocode-cache.json. Same address
// in == same coords out, no second API call. Cache survives restarts; only
// the customer's full street address (lower-cased, whitespace-collapsed) is
// the cache key, so PII exposure is identical to leads.json.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const CACHE_PATH = path.join(__dirname, "..", "data", "geocode-cache.json");
const townCentroids = require("./town-centroids");

// PJL base = Newmarket, ON city centre. Used as the start-of-day origin for
// the first appointment of every day, and as the fallback when a customer
// address won't geocode.
const PJL_BASE = {
  lat: 44.0592,
  lng: -79.4613,
  formattedAddress: "Newmarket, ON, Canada",
  source: "pjl-base"
};

let cacheMemo = null;

async function loadCache() {
  if (cacheMemo) return cacheMemo;
  try {
    if (!fsSync.existsSync(CACHE_PATH)) {
      cacheMemo = {};
      return cacheMemo;
    }
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    cacheMemo = JSON.parse(raw || "{}");
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
    console.error("[geocode] Failed to persist cache:", err.message);
  }
}

function normalizeKey(address) {
  return String(address || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_KEY);
}

// Every failure path funnels through here: a recognized town answers
// approximately (the filter stays on), an unrecognized one falls to the
// depot pin (the filter skips, and says so upstream). ok stays false
// either way — approximate coordinates must never persist to a record.
function failedLookup(address, reason, extra = {}) {
  const centroid = townCentroids.lookup(address);
  if (centroid) {
    return { ok: false, skipped: true, approximate: true, reason, coords: centroid, ...extra };
  }
  return { ok: false, skipped: true, reason, coords: PJL_BASE, ...extra };
}

// One Google attempt with a hard timeout — a hung request must not hang
// a customer's availability request behind it.
async function fetchGoogle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address) {
  const key = normalizeKey(address);
  if (!key) return { ok: false, skipped: true, reason: "empty address", coords: PJL_BASE };

  const cache = await loadCache();
  if (cache[key]) {
    return { ok: true, fromCache: true, coords: cache[key] };
  }

  if (!isConfigured()) {
    console.warn("[geocode] GOOGLE_MAPS_SERVER_KEY not set — town-centroid/base fallback in use. THE GEOGRAPHY FILTER IS DEGRADED FOR EVERY ADDRESS until the key is set in Render.");
    return failedLookup(address, "no key");
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "ca");
  url.searchParams.set("components", "country:CA|administrative_area:ON");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  // Two attempts: transient failures (network, timeout, Google's
  // UNKNOWN_ERROR) get one retry after a beat; definitive answers
  // (ZERO_RESULTS, REQUEST_DENIED) don't — retrying those wastes quota.
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await fetchGoogle(url.toString());
      if (data.status === "OK" && Array.isArray(data.results) && data.results.length) {
        const top = data.results[0];
        const coords = {
          lat: top.geometry?.location?.lat,
          lng: top.geometry?.location?.lng,
          formattedAddress: top.formatted_address,
          source: "google"
        };
        cache[key] = coords;
        saveCache().catch(() => {});
        return { ok: true, coords };
      }
      if (data.status === "UNKNOWN_ERROR" && attempt === 1) {
        lastError = data.status;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      console.warn("[geocode] Google returned", data.status, "for", address);
      return failedLookup(address, data.status);
    } catch (error) {
      lastError = error.message;
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      console.error("[geocode] Network/runtime error after retry:", error.message);
    }
  }
  return failedLookup(address, "network", { error: lastError });
}

module.exports = { geocode, PJL_BASE, isConfigured };

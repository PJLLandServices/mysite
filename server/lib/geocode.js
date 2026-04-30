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
// Results are cached on disk in server/data/geocode-cache.json. Same address
// in == same coords out, no second API call. Cache survives restarts; only
// the customer's full street address (lower-cased, whitespace-collapsed) is
// the cache key, so PII exposure is identical to leads.json.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const CACHE_PATH = path.join(__dirname, "..", "data", "geocode-cache.json");

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

async function geocode(address) {
  const key = normalizeKey(address);
  if (!key) return { ok: false, skipped: true, reason: "empty address", coords: PJL_BASE };

  const cache = await loadCache();
  if (cache[key]) {
    return { ok: true, fromCache: true, coords: cache[key] };
  }

  if (!isConfigured()) {
    console.warn("[geocode] GOOGLE_MAPS_SERVER_KEY not set — using PJL base coords as fallback.");
    return { ok: false, skipped: true, reason: "no key", coords: PJL_BASE };
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "ca");
  url.searchParams.set("components", "country:CA|administrative_area:ON");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_SERVER_KEY);

  try {
    const response = await fetch(url.toString());
    const data = await response.json();
    if (data.status !== "OK" || !Array.isArray(data.results) || !data.results.length) {
      console.warn("[geocode] Google returned", data.status, "for", address);
      return { ok: false, skipped: true, reason: data.status, coords: PJL_BASE };
    }
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
  } catch (error) {
    console.error("[geocode] Network/runtime error:", error.message);
    return { ok: false, error: error.message, coords: PJL_BASE };
  }
}

module.exports = { geocode, PJL_BASE, isConfigured };

// Google Analytics Data API (GA4) wrapper — read-only.
//
// Talks to GA4 to answer one question for the admin booking-funnel page:
// how many visitors reached each step of the booking flow, and roughly
// where from. No SDK — this repo's convention (see lib/geocode.js,
// lib/distance.js) is a raw fetch() against Google's REST endpoints, so
// this follows the same shape rather than pulling in @google-analytics/data
// and its gRPC dependency tree.
//
// Auth: a Google Cloud service account (Viewer-only on the GA4 property).
// Its JSON key lives in GA4_SERVICE_ACCOUNT_KEY (Render env var, never
// committed) and its numeric GA4 property lives in GA4_PROPERTY_ID. Node's
// built-in crypto module signs the service-account JWT (RS256) — no new
// dependency for that either.
//
// FAILURE POSTURE: same as geocode.js. Missing/invalid credentials, a
// network error, or Google being unreachable must degrade this one
// reporting page, never crash the server or touch any booking/CRM path.
// isConfigured() lets the caller show a clear "not set up" message instead
// of a stack trace.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CACHE_PATH = path.join(__dirname, "..", "data", "booking-funnel-cache.json");
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min — keeps repeated admin-page loads off the GA4 API quota.
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

let tokenMemo = null; // { accessToken, expiresAt }
let tokenInFlight = null; // dedupes concurrent getAccessToken() calls (the funnel report fires 3 in parallel)
let cacheMemo = null;

function isConfigured() {
  return Boolean(process.env.GA4_SERVICE_ACCOUNT_KEY && process.env.GA4_PROPERTY_ID);
}

function loadServiceAccount() {
  const raw = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GA4_SERVICE_ACCOUNT_KEY is not set");
  let key;
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new Error("GA4_SERVICE_ACCOUNT_KEY isn't valid JSON — re-paste the full key file");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GA4_SERVICE_ACCOUNT_KEY is missing client_email or private_key");
  }
  return key;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds and signs the JWT assertion a service account exchanges for an
// access token (RFC 7523 / Google's server-to-server OAuth flow).
function signAssertion(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

async function fetchAccessToken() {
  const serviceAccount = loadServiceAccount();
  const assertion = signAssertion(serviceAccount);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google rejected the service-account credential");
  }
  tokenMemo = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenMemo.accessToken;
}

// The funnel report fires three requests in parallel (steps/location/service).
// On a cold cache they'd otherwise each see no valid tokenMemo and fetch their
// own — three round trips to Google instead of one. Sharing the in-flight
// promise means the first caller fetches and the other two just await it.
async function getAccessToken() {
  if (tokenMemo && tokenMemo.expiresAt > Date.now() + 60_000) return tokenMemo.accessToken;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = fetchAccessToken().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

async function runReport(body) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `GA4 Data API returned ${response.status}`);
  }
  return data;
}

async function loadCache() {
  if (cacheMemo) return cacheMemo;
  try {
    if (!fsSync.existsSync(CACHE_PATH)) return null;
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    cacheMemo = JSON.parse(raw || "null");
  } catch {
    cacheMemo = null;
  }
  return cacheMemo;
}

async function saveCache(entry) {
  cacheMemo = entry;
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(entry, null, 2), "utf8");
  } catch (err) {
    console.error("[ga4] Failed to persist booking-funnel cache:", err.message);
  }
}

const STEP_ORDER = ["service", "zones", "address", "when", "contact", "confirm"];

// The three params booking_step events carry that this report reads must be
// registered as GA4 custom dimensions (Admin > Custom definitions, Event
// scope) before the Data API will recognize them — step_name, service_key,
// deep_linked. Until that's done Google returns an "invalid dimension"
// error, which surfaces through here as a normal fail-soft `ok:false`.
function dims(days) {
  return {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
    dimensionFilter: {
      filter: { fieldName: "eventName", stringFilter: { value: "booking_step" } }
    }
  };
}

async function fetchFunnel(days) {
  const range = dims(days);

  const [byStep, byLocation, byService] = await Promise.all([
    runReport({ ...range, dimensions: [{ name: "customEvent:step_name" }], metrics: [{ name: "activeUsers" }] }),
    runReport({ ...range, dimensions: [{ name: "city" }, { name: "region" }], metrics: [{ name: "activeUsers" }], limit: 15, orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] }),
    runReport({ ...range, dimensions: [{ name: "customEvent:service_key" }, { name: "customEvent:deep_linked" }], metrics: [{ name: "activeUsers" }] })
  ]);

  const stepCounts = new Map();
  for (const row of byStep.rows || []) {
    const name = row.dimensionValues?.[0]?.value;
    const visitors = Number(row.metricValues?.[0]?.value || 0);
    if (name) stepCounts.set(name, (stepCounts.get(name) || 0) + visitors);
  }
  const steps = STEP_ORDER
    .filter((name) => stepCounts.has(name))
    .map((name) => ({ step_name: name, visitors: stepCounts.get(name) }));

  const locationRows = (byLocation.rows || []).map((row) => {
    const city = row.dimensionValues?.[0]?.value;
    const region = row.dimensionValues?.[1]?.value;
    const label = [city, region].filter((v) => v && v !== "(not set)").join(", ");
    return { location: label || "Unknown", visitors: Number(row.metricValues?.[0]?.value || 0) };
  });

  const serviceMap = new Map();
  for (const row of byService.rows || []) {
    const serviceKey = row.dimensionValues?.[0]?.value || "(none)";
    const deepLinked = row.dimensionValues?.[1]?.value === "true";
    const visitors = Number(row.metricValues?.[0]?.value || 0);
    const existing = serviceMap.get(serviceKey) || { service_key: serviceKey, visitors: 0, deepLinked: 0 };
    existing.visitors += visitors;
    if (deepLinked) existing.deepLinked += visitors;
    serviceMap.set(serviceKey, existing);
  }

  return {
    steps,
    byLocation: locationRows,
    byService: Array.from(serviceMap.values()).sort((a, b) => b.visitors - a.visitors)
  };
}

// Public entry point used by the admin endpoint. Cache key is the day range
// (7/14/30) so each range gets its own 20-minute-fresh snapshot. On a fetch
// failure, serves the last good cache for that range (marked stale) rather
// than a hard error, the same fail-soft posture as geocode.js's town-centroid
// fallback — a temporary Google hiccup shouldn't blank the page.
async function getBookingFunnel(days) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", errors: ["Google Analytics isn't connected yet — the GA4 credential or property ID is missing."] };
  }

  const cache = (await loadCache()) || {};
  const key = String(days);
  const cached = cache[key];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, ...cached.data, asOf: cached.at, stale: false };
  }

  try {
    const data = await fetchFunnel(days);
    const at = Date.now();
    cache[key] = { at, data };
    await saveCache(cache);
    return { ok: true, ...data, asOf: at, stale: false };
  } catch (err) {
    console.error("[ga4] booking-funnel report failed:", err.message);
    if (cached) {
      return { ok: true, ...cached.data, asOf: cached.at, stale: true };
    }
    return { ok: false, reason: "fetch_failed", errors: [err.message || "Couldn't reach Google Analytics."] };
  }
}

module.exports = { isConfigured, getBookingFunnel };

// Google Search Console client — service-account auth with zero dependencies.
//
// Two env vars drive everything (Render dashboard, GitHub secrets, or the
// repo-root .env for local runs):
//
//   GSC_SITE_URL              The Search Console property. Domain properties
//                             look like "sc-domain:pjllandservices.com";
//                             URL-prefix properties look like
//                             "https://www.pjllandservices.com/". Defaults to
//                             the PJL domain property.
//   GSC_SERVICE_ACCOUNT_JSON  The service-account key. Accepts the raw JSON
//                             (what Render and GitHub secrets hold), base64 of
//                             that JSON, or a path to the downloaded .json
//                             file (handy locally — nothing gets copied into
//                             the repo).
//
// The service account (client_email in the key) must be added as a user on
// the property in Search Console → Settings → Users and permissions. "Full"
// permission covers everything this client does; sitemap submission needs
// at least that. The Search Console API must also be enabled on the Google
// Cloud project that owns the key.
//
// Auth is the plain OAuth2 JWT-bearer flow: sign a one-hour assertion with
// the key's RSA private key (node:crypto), trade it at token_uri for an
// access token, cache the token until a minute before it expires. No
// googleapis package, no google-auth-library — the rest of scripts/ is
// dependency-free and this keeps it that way.
//
// What the API can and cannot do, so nobody goes looking for a feature that
// is not there: it can submit sitemaps, inspect a URL's index status, and
// read search analytics (clicks / impressions / position). It CANNOT press
// "Request indexing" — that button is UI-only, with its ~10/day quota.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SITE_URL = "sc-domain:pjllandservices.com";
export const SCOPE = "https://www.googleapis.com/auth/webmasters";
const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class GscError extends Error {
  constructor(message, { status, body, hint } = {}) {
    super(message);
    this.name = "GscError";
    this.status = status;
    this.body = body;
    this.hint = hint;
  }
}

// Same tiny .env parser server.js uses at boot, so `node scripts/gsc.mjs`
// picks up a local .env without the server running. Never overrides a
// variable that is already set in the environment.
export function loadRepoEnv(envPath = path.join(ROOT, ".env")) {
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

// Turn whatever GSC_SERVICE_ACCOUNT_JSON holds into the key object.
// Returns null when the variable is empty so callers can print a setup
// message instead of a stack trace. Throws on garbage.
export function parseServiceAccount(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  let account;
  if (text.startsWith("{")) {
    account = parseJson(text, "GSC_SERVICE_ACCOUNT_JSON");
  } else if (looksLikePath(text) && fs.existsSync(text)) {
    account = parseJson(fs.readFileSync(text, "utf8"), `service-account file ${text}`);
  } else {
    let decoded;
    try {
      decoded = Buffer.from(text, "base64").toString("utf8").trim();
    } catch {
      decoded = "";
    }
    if (!decoded.startsWith("{")) {
      throw new GscError(
        "GSC_SERVICE_ACCOUNT_JSON is not JSON, base64 JSON, or a path to an existing .json file.",
        { hint: "Paste the full contents of the downloaded service-account key file." }
      );
    }
    account = parseJson(decoded, "GSC_SERVICE_ACCOUNT_JSON (base64)");
  }

  for (const field of ["client_email", "private_key"]) {
    if (!account[field] || typeof account[field] !== "string") {
      throw new GscError(`Service-account key is missing "${field}".`, {
        hint: 'Expected a Google service-account key: {"type":"service_account","client_email":…,"private_key":…}.',
      });
    }
  }
  // Render and some shells keep the "\n" escapes literal when the key is
  // pasted through a single-line field. Restore real newlines so the PEM
  // parses.
  account.private_key = account.private_key.replace(/\\n/g, "\n");
  account.token_uri = account.token_uri || "https://oauth2.googleapis.com/token";
  return account;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GscError(`${label} is not valid JSON: ${err.message}`);
  }
}

function looksLikePath(text) {
  return !text.includes("\n") && (text.endsWith(".json") || text.includes("/") || text.includes("\\"));
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build and sign the JWT-bearer assertion. Exposed so the test can verify
// the signature with the matching public key.
export function buildAssertion(account, { now = Math.floor(Date.now() / 1000), scope = SCOPE } = {}) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: account.token_uri,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), account.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(status, body, siteUrl) {
  const message =
    (body && typeof body === "object" && body.error && (body.error.message || body.error_description)) ||
    (body && typeof body === "object" && body.error_description) ||
    (typeof body === "string" ? body : "") ||
    `HTTP ${status}`;
  let hint;
  if (status === 403 && /permission|forbidden/i.test(message)) {
    hint =
      `Add the service account (client_email in the key) as a user on ${siteUrl} in ` +
      "Search Console → Settings → Users and permissions, with Full permission.";
  } else if (status === 403 && /not been used|disabled|API/i.test(message)) {
    hint = "Enable the Google Search Console API on the Cloud project that owns the key.";
  } else if (status === 404 && /site|property/i.test(message)) {
    hint = `Property ${siteUrl} was not found for this account. Check GSC_SITE_URL (domain properties are "sc-domain:example.com").`;
  } else if (status === 401) {
    hint = "The access token was rejected. The key may have been deleted or rotated in Google Cloud.";
  } else if (status === 429) {
    hint = "Quota exhausted — URL inspection allows 2,000 calls/day and 600/min per property.";
  }
  return { message, hint };
}

export function createClient({
  siteUrl = process.env.GSC_SITE_URL || DEFAULT_SITE_URL,
  serviceAccount,
  fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const account =
    typeof serviceAccount === "string" || serviceAccount == null
      ? parseServiceAccount(serviceAccount ?? process.env.GSC_SERVICE_ACCOUNT_JSON)
      : serviceAccount;
  if (!account) {
    throw new GscError("GSC_SERVICE_ACCOUNT_JSON is not set.", {
      hint:
        "Put the service-account key JSON in GSC_SERVICE_ACCOUNT_JSON (Render env, GitHub secret, or " +
        "the repo-root .env), or point that variable at the downloaded .json file for a local run.",
    });
  }
  if (typeof fetchImpl !== "function") throw new GscError("No fetch implementation available.");

  let token = null; // { value, expiresAt }

  async function getAccessToken() {
    const nowSec = now();
    if (token && token.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > nowSec) return token.value;
    const assertion = buildAssertion(account, { now: nowSec });
    const res = await fetchImpl(account.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const body = await readBody(res);
    if (!res.ok || !body || !body.access_token) {
      const { message, hint } = describeError(res.status, body, siteUrl);
      throw new GscError(`Token exchange failed: ${message}`, { status: res.status, body, hint });
    }
    token = { value: body.access_token, expiresAt: nowSec + (Number(body.expires_in) || TOKEN_TTL_SECONDS) };
    return token.value;
  }

  async function request(method, url, payload) {
    const accessToken = await getAccessToken();
    const headers = { authorization: `Bearer ${accessToken}` };
    let body;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(payload);
    }
    const res = await fetchImpl(url, { method, headers, body });
    const data = await readBody(res);
    if (!res.ok) {
      const { message, hint } = describeError(res.status, data, siteUrl);
      throw new GscError(`${method} ${url} → ${res.status}: ${message}`, { status: res.status, body: data, hint });
    }
    return data;
  }

  const siteBase = `${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}`;

  return {
    siteUrl,
    account: { client_email: account.client_email, project_id: account.project_id },
    getAccessToken,

    // Every property the service account can see. Empty means it has not
    // been added to any property yet.
    async listSites() {
      const data = await request("GET", `${WEBMASTERS_BASE}/sites`);
      return (data && data.siteEntry) || [];
    },

    async listSitemaps() {
      const data = await request("GET", `${siteBase}/sitemaps`);
      return (data && data.sitemap) || [];
    },

    // Same thing as the "Add a new sitemap" box in the UI. Idempotent —
    // resubmitting an already-known sitemap just asks Google to re-read it.
    async submitSitemap(feedpath) {
      await request("PUT", `${siteBase}/sitemaps/${encodeURIComponent(feedpath)}`);
      return { siteUrl, feedpath };
    },

    // URL Inspection — the "URL is on Google / not on Google" panel, minus
    // the Request-indexing button. 2,000/day, 600/min.
    async inspectUrl(inspectionUrl, { languageCode = "en-US" } = {}) {
      const data = await request("POST", INSPECTION_URL, { inspectionUrl, siteUrl, languageCode });
      return (data && data.inspectionResult) || data;
    },

    // Performance report. dimensions: "page" | "query" | "date" | "country" | "device".
    async searchAnalytics({
      startDate,
      endDate,
      dimensions = ["page"],
      rowLimit = 25,
      startRow = 0,
      dimensionFilterGroups,
      type = "web",
    }) {
      const payload = { startDate, endDate, dimensions, rowLimit, startRow, type };
      if (dimensionFilterGroups) payload.dimensionFilterGroups = dimensionFilterGroups;
      const data = await request("POST", `${siteBase}/searchAnalytics/query`, payload);
      return (data && data.rows) || [];
    },
  };
}

// Flatten an inspection result into the handful of fields worth printing.
export function summarizeInspection(result) {
  const idx = (result && result.indexStatusResult) || {};
  const mobile = (result && result.mobileUsabilityResult) || {};
  return {
    verdict: idx.verdict || "UNKNOWN",
    coverage: idx.coverageState || "",
    robots: idx.robotsTxtState || "",
    indexing: idx.indexingState || "",
    lastCrawl: idx.lastCrawlTime || "",
    canonicalGoogle: idx.googleCanonical || "",
    canonicalUser: idx.userCanonical || "",
    crawledAs: idx.crawledAs || "",
    mobile: mobile.verdict || "",
    link: (result && result.inspectionResultLink) || "",
  };
}

export function readSitemapUrls(sitemapPath = path.join(ROOT, "sitemap.xml")) {
  const xml = fs.readFileSync(sitemapPath, "utf8");
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

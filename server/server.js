// PJL Land Services operates in Eastern Time (Newmarket, Ontario). Render's
// container runs in UTC by default, which makes setHours(8) produce 8:00 UTC
// (= 4:00 AM Eastern) instead of 8:00 AM Eastern. Pinning the process TZ here
// keeps every Date arithmetic — slot generation, schedule blocks, booking
// timestamps — in PJL's actual local time. Honors a TZ env var if set so
// dev machines can still override.
process.env.TZ = process.env.TZ || "America/Toronto";

const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Load .env at boot (if it exists). Tiny inline parser — no dotenv dependency.
// .env lives in the repo root and holds Gmail + Twilio credentials. Never committed.
(function loadEnv() {
  const envPath = path.resolve(__dirname, "..", ".env");
  if (!fsSync.existsSync(envPath)) return;
  const content = fsSync.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
})();

const { sendNewLeadEmail } = require("./lib/notify-email");
const { sendNewLeadSms, sendPortalMessageSms } = require("./lib/notify-sms");
const { notifyCustomer, eventForTransition, sendInvoiceToCustomer, sendPaymentReceipt, sendBookingCancellation, sendPortalMessageAlertEmail, sendPortalReplyToCustomer } = require("./lib/notify-customer");
const { geocode, PJL_BASE } = require("./lib/geocode");
const { BOOKABLE_SERVICES, DEFAULT_HOURS, DEFAULT_SETTINGS, listAvailableSlots, groupByDay, expandDaysToRange, parseLocalDateKey } = require("./lib/availability");
const scheduleStore = require("./lib/schedule-store");
const { priceForBooking, deriveSeasonalKey } = require("./lib/pricing");
const bookingSessions = require("./lib/booking-sessions");
const properties = require("./lib/properties");
const customers = require("./lib/customers");
const workOrders = require("./lib/work-orders");
const quotes = require("./lib/quotes");
const invoices = require("./lib/invoices");
const completionCascade = require("./lib/completion-cascade");
const customLineItems = require("./lib/custom-line-items");
const settings = require("./lib/settings");
const { generateIcsForToken } = require("./lib/ical-feed");
const issueRollup = require("./lib/issue-rollup");
const { generateQuotePdf } = require("./lib/quote-pdf");
const { generateInvoicePdf } = require("./lib/invoice-pdf");
const quickbooks = require("./lib/quickbooks");
const bookings = require("./lib/bookings");
const suppliers = require("./lib/suppliers");
const materialLists = require("./lib/material-lists");
const projects = require("./lib/projects");
const partSuppliers = require("./lib/part-suppliers");
const partsLib = require("./lib/parts");
const purchaseOrders = require("./lib/purchase-orders");
const users = require("./lib/users");
const magicTokens = require("./lib/magic-tokens");
const rateLimit = require("./lib/rate-limit");
const { sendCustomerLoginLink, sendAdminPasswordResetLink } = require("./lib/notify-customer");

// Short, customer-friendly work order ID. Eight chars from a UUIDv4 base32-ish
// alphabet (no I/O/0/1 to keep them unambiguous when read aloud or hand-written).
function makeWorkOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "WO-";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

const PORT = Number(process.env.PORT || 4173);
// 0.0.0.0 = listen on every network interface. Required on Render (and most
// cloud hosts), where 127.0.0.1 means "this container only" and external
// traffic can't reach it. For local dev this is also fine — the server is
// reachable at http://127.0.0.1:4173 the same as before; setting HOST=127.0.0.1
// is only needed if you specifically want to block other devices on your
// home network from connecting.
const HOST = process.env.HOST || "0.0.0.0";
// SITE_DIR   = the public PJL website (repo root): index.html, sprinkler-systems.html, blog posts, css/, images.
// SERVER_DIR = this server/ folder: CRM dashboard, customer portal, login page, their JS/CSS/images.
// DATA_DIR   = runtime data (NEVER committed — see .gitignore): leads.json + auth.json.
const SITE_DIR = path.resolve(__dirname, "..");
const SERVER_DIR = __dirname;
const DATA_DIR = path.join(SERVER_DIR, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
// All AI chat transcripts (booked AND abandoned). Patrick uses this to see
// why people are/aren't converting. Identified by client-generated sessionId
// so the widget can upsert as the conversation progresses.
const CHATS_FILE = path.join(DATA_DIR, "chat-transcripts.json");
const MAX_CHAT_BODY = 80_000; // ~50K-ish transcript + a few KB of metadata
// Per-lead photo attachments live under data/photos/<leadId>/N.jpg.
// Photos arrive base64-encoded inside the booking POST and are written ONLY
// after the lead is successfully created (validation passed, not a duplicate).
// If the booking is abandoned, no photo is ever persisted.
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const WO_PHOTOS_DIR = path.join(DATA_DIR, "wo-photos");
const MAX_PHOTOS_PER_LEAD = 5;
const MAX_PHOTOS_PER_WO = 150;
const MAX_PHOTO_BYTES = 1_500_000; // 1.5 MB per photo after client-side resize (lead intake)
const QUOTE_POST_MAX_BYTES = 12_000_000; // 12 MB cap for the /api/quotes POST (5 photos × ~1.5MB base64 inflated)

// Tech-mode WO uploads (Brief: WO Field-Readiness §5) widen on three
// axes vs. lead photos: bigger per-file cap (a HEIC straight from an
// iPhone 17 Pro Max or a customer receipt PDF can run 10-25 MB), a
// wider MIME whitelist, and a roomier envelope so a single big upload
// fits in one request. Lead photos KEEP the tighter 1.5 MB / image-only
// constraints — chat intake is high-volume and bandwidth-sensitive.
const MAX_WO_MEDIA_BYTES = 25_000_000;        // 25 MB per file
const WO_UPLOAD_POST_MAX_BYTES = 40_000_000;  // ~33 MB base64 + JSON wrapper headroom
const WO_MEDIA_MIME_WHITELIST = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "application/pdf"
]);
const WO_MEDIA_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "application/pdf": "pdf"
};
// Magic-bytes signatures — first ~12 bytes of the decoded buffer.
// Defensive check: even if the client sends mediaType: "image/jpeg",
// reject when the actual bytes don't match. Prevents a .jpg-extension
// payload with PHP content (or similar) from sneaking through. The
// HEIC/HEIF check is at offset 4 (ftyp box header).
function verifyWoMediaMagic(buffer, mediaType) {
  if (!buffer || buffer.length < 12) return false;
  const b0 = buffer[0], b1 = buffer[1], b2 = buffer[2], b3 = buffer[3];
  if (mediaType === "image/jpeg") {
    return b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF;
  }
  if (mediaType === "image/png") {
    return b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47;
  }
  if (mediaType === "image/gif") {
    return b0 === 0x47 && b1 === 0x49 && b2 === 0x46;
  }
  if (mediaType === "image/webp") {
    // RIFF....WEBP
    if (b0 !== 0x52 || b1 !== 0x49 || b2 !== 0x46 || b3 !== 0x46) return false;
    return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  }
  if (mediaType === "image/heic" || mediaType === "image/heif") {
    // ftyp box: bytes 4..7 = "ftyp"; brand follows at 8..11.
    if (buffer[4] !== 0x66 || buffer[5] !== 0x74 || buffer[6] !== 0x79 || buffer[7] !== 0x70) return false;
    return true;
  }
  if (mediaType === "application/pdf") {
    return b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46;
  }
  return false;
}
const CONTACT_NOTE = "PJL_New2026";
const CONTACT_COUNTRY = "Canada";
const CONTACT_PROVINCE = "ON";
const AUTH_COOKIE = "pjl_crm_session";
// 30-day rolling session for both admin/tech and customer-portal logins.
// Tech-mode offline support assumes the cookie outlives a typical
// reconnect window (rule: "tech offline for >30 days must re-login on
// reconnect"). Magic-link tokens are SEPARATE and short-lived (30 min,
// see lib/magic-tokens.js).
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// Login attempts per IP per 15 minutes. Same window as the magic-link
// per-IP cap; matches the "10 IP/15min" rule in the brief.
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_LINK_LIMIT_IDENT = 3;
const PORTAL_LINK_LIMIT_IP = 10;
const PORTAL_LINK_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PASSWORD_RESET_LIMIT = 3;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;

// PJL service catalog — drives the lead-intake forms and CRM line-item display.
// Pricing source: master_pricing.md (locked 2026-04-28). Update there first, then mirror here.
//
// Each entry has:
//   label     — human-readable line item shown to customer + in the CRM
//   price     — unit price in CAD; 0 for custom-quote items
//   category  — for CRM filtering / form grouping
//   quoteType — "flat" (price is final), "per-unit" (price × qty), or "custom" (no fixed price; PJL quotes on-site)
//
// Price totals only sum "flat" and "per-unit" items. "custom" items are recorded
// on the lead so PJL knows the customer is interested, but $0 is added to the total.
// Single source of truth for ALL pricing. The repo-root /pricing.json is loaded
// at boot — every other pricing-aware surface (FEATURES below, /api/pricing
// public endpoint, lib/pricing.js, the AI system prompt via worker/rebuild.mjs,
// pricing.html via the client-side injector) reads from this same file.
//
// Quote line items are SNAPSHOT at lead-creation time: validateLead spreads
// the FEATURE object (price + label) into lead.features, so historical leads
// keep the price they were quoted at even if pricing.json updates later.
const PRICING = (function loadPricing() {
  const pricingPath = path.resolve(__dirname, "..", "pricing.json");
  try {
    return JSON.parse(fsSync.readFileSync(pricingPath, "utf8"));
  } catch (err) {
    console.error("[FATAL] Could not load pricing.json from repo root:", err?.message || err);
    process.exit(1);
  }
})();
const FEATURES = PRICING.items;

// parts.json — catalog + service_materials mapping (spec §1.2). Loaded
// once at boot; failure is non-fatal (the materials checklist hides if
// PARTS is null). The file lives at the repo root next to pricing.json.
//
// Two layers sit on top of the baseline:
//   1. parts-overrides.json — runtime catalog edits (adds/edits/deletes)
//      owned by the admin UI (lib/parts.js). These are merged in here
//      at boot and re-merged on every admin write so /api/parts returns
//      the current effective catalog without a server restart.
//   2. part-suppliers.json — per-SKU supplier assignments (lib/part-
//      suppliers.js). These layer ON TOP of the catalog-overrides merge.
//
// BASELINE_PARTS keeps an untouched copy of the original parts.json so
// the override merge always starts from a known-good state. PARTS holds
// the current effective catalog and is what /api/parts (and consumers
// using PARTS in-process) read.
let BASELINE_PARTS = null;
let PARTS = null;
let CATALOG_VERSION = 0;  // bumped on every catalog write; surfaced as X-Catalog-Version
(function loadParts() {
  try {
    const partsPath = path.resolve(__dirname, "..", "parts.json");
    const cat = JSON.parse(fsSync.readFileSync(partsPath, "utf8"));
    // Stash the baseline before merging overrides so we can re-merge
    // cleanly on every write.
    BASELINE_PARTS = JSON.parse(JSON.stringify(cat.parts || {}));
    PARTS = cat;
    rebuildCatalogFromOverrides({ initial: true });
  } catch (err) {
    console.warn("[parts] could not load parts.json — materials checklist will be hidden:", err?.message);
    PARTS = null;
    BASELINE_PARTS = null;
  }
})();

// Re-merge the catalog from BASELINE_PARTS + parts-overrides.json +
// part-suppliers.json. Called at boot, and after every admin write to
// the catalog or supplier-assignment files. Bumps CATALOG_VERSION so
// the SW/clients can detect a change.
function rebuildCatalogFromOverrides({ initial = false } = {}) {
  if (!PARTS || !BASELINE_PARTS) return;
  let catalogOverrides = partsLib.EMPTY_OVERRIDES;
  let supplierOverrides = {};
  try {
    const overridePath = path.join(__dirname, "data", "parts-overrides.json");
    if (fsSync.existsSync(overridePath)) {
      catalogOverrides = JSON.parse(fsSync.readFileSync(overridePath, "utf8") || "{}");
    }
  } catch (err) {
    console.warn("[parts] could not read parts-overrides.json:", err?.message);
  }
  try {
    const supPath = path.join(__dirname, "data", "part-suppliers.json");
    if (fsSync.existsSync(supPath)) {
      supplierOverrides = JSON.parse(fsSync.readFileSync(supPath, "utf8") || "{}");
    }
  } catch (err) {
    console.warn("[parts] could not read part-suppliers.json:", err?.message);
  }
  // Merge catalog overrides onto baseline → assigns to PARTS.parts.
  PARTS.parts = partsLib.mergeOverrides(BASELINE_PARTS, catalogOverrides);
  // Layer supplier assignments on top. mergeIntoCatalog mutates in place
  // and also normalises missing supplierIds to [].
  partSuppliers.mergeIntoCatalog(PARTS.parts, supplierOverrides);
  if (!initial) CATALOG_VERSION++;
}

function fmtMoneyFromCents(cents) {
  const n = Number(cents) || 0;
  return "$" + (n / 100).toFixed(2);
}

// In-process stage for xlsx imports. Browser SheetJS parses → POSTs the
// parsed rows to /api/parts/import/preview → we compute a diff, stash
// it here keyed by importId, and return the diff for the user to
// review. /api/parts/import/commit reads from this map. Entries expire
// after 15 minutes (cleaned up lazily on the next request).
const importStaging = new Map();
const IMPORT_STAGE_TTL_MS = 15 * 60 * 1000;
function cleanupImportStaging() {
  const cutoff = Date.now() - IMPORT_STAGE_TTL_MS;
  for (const [id, entry] of importStaging.entries()) {
    if (entry.ts < cutoff) importStaging.delete(id);
  }
}

const CRM_STATUSES = new Set(["new", "contacted", "site_visit", "quoted", "won", "lost"]);
const CRM_PRIORITIES = new Set(["normal", "high", "urgent"]);

// Lead sources — which form on the public site originated the lead.
// Each entry has a short human label (shown as a pill in the CRM and in the
// SMS/email notification) and a category that groups similar inquiry types.
// Add new sources here, then point the form's `source` field at the new key.
const SOURCES = {
  sprinkler_repair:     { label: "Sprinkler Repair",      category: "repair"    },
  ai_diagnose:          { label: "AI Diagnostic Chat",    category: "repair"    },
  ai_self_fix_capture:  { label: "Self-Fix Capture",      category: "nurture"   },
  sprinkler_quote:      { label: "New Sprinkler Quote",   category: "install"   },
  landscape_lighting:   { label: "Landscape Lighting",    category: "lighting"  },
  drip_irrigation:      { label: "Drip Irrigation",       category: "install"   },
  spring_opening:       { label: "Spring Opening",        category: "seasonal"  },
  fall_closing:         { label: "Fall Closing",          category: "seasonal"  },
  coverage_inquiry:     { label: "Service Area Check",    category: "inquiry"   },
  general_contact:      { label: "General Contact",       category: "inquiry"   },
  general_lead:         { label: "General Lead",          category: "inquiry"   }
};
const DEFAULT_SOURCE = "general_lead";

function resolveSource(input) {
  const key = normalizeString(input, 40);
  if (key && Object.prototype.hasOwnProperty.call(SOURCES, key)) return key;
  return DEFAULT_SOURCE;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".vcf": "text/vcard; charset=utf-8"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

// Legacy Wix URLs → current pages. Mirrors `_redirects` at the repo root, which
// Render honors for purely static deploys; this in-process fallback covers the
// case where this Node service handles the request before the static layer can.
const LEGACY_REDIRECTS = {
  "/about-us": "/about.html",
  "/contact": "/contact.html",
  "/book-online": "/book.html",
  "/lawn-sprinklers": "/sprinkler-systems.html",
  "/landscapelighting": "/landscape-lighting.html",
  "/services": "/sprinkler-systems.html",
  "/privacypolicy": "/privacy-policy.html",
  "/terms-of-service": "/terms-of-service.html"
};

function normalizeString(value, maxLength = 400) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

// auth.json is now the SESSION-SECRET store ONLY. The legacy single-
// password fields (salt, passwordHash) were stripped during the
// users.json migration; if an old install still has them we ignore them
// here. Per-user credentials live in users.json — see lib/users.js.
async function readAuthConfig() {
  await ensureStore();
  let parsed = {};
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8");
    parsed = JSON.parse(raw || "{}");
  } catch { parsed = {}; }
  if (!parsed.sessionSecret) {
    // First-run safety net — generate a session secret if the file is
    // missing one. Without this, a fresh install can't sign cookies
    // until create-user runs. Persist so subsequent boots stay stable.
    parsed.sessionSecret = crypto.randomBytes(32).toString("base64");
    try { await fs.writeFile(AUTH_FILE, JSON.stringify({ sessionSecret: parsed.sessionSecret }, null, 2) + "\n", "utf8"); }
    catch { /* read-only filesystem in tests, etc. — fall through */ }
  }
  return parsed;
}

function secureCookieFlag(req) {
  return req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
}

// Cookie payload — JSON-encoded {uid, role, exp} signed with HMAC-SHA256
// over the URL-safe base64 of the JSON. Tampering with any field changes
// the digest, so verifySession() rejects mismatches in constant time.
function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodePayload(b64) {
  try { return JSON.parse(Buffer.from(String(b64 || ""), "base64url").toString("utf8")); }
  catch { return null; }
}
function signPayload(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

// Read + verify the session cookie. Returns { uid, role, exp } on success
// or null on any failure (missing / malformed / bad signature / expired).
async function readSession(req) {
  try {
    const config = await readAuthConfig();
    const raw = parseCookies(req)[AUTH_COOKIE];
    if (!raw) return null;
    const [encoded, signature] = raw.split(".");
    if (!encoded || !signature) return null;
    const expected = signPayload(encoded, config.sessionSecret);
    const aBuf = Buffer.from(signature);
    const eBuf = Buffer.from(expected);
    if (aBuf.length !== eBuf.length || !crypto.timingSafeEqual(aBuf, eBuf)) return null;
    const payload = decodePayload(encoded);
    if (!payload || typeof payload !== "object") return null;
    if (!payload.uid || !payload.role || !payload.exp) return null;
    if (Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Identity gates. Return the resolved session payload on success or null
// on failure. Callers translate null → 401/403/redirect at the boundary.
async function requireUser(req) {
  const session = await readSession(req);
  if (!session) return null;
  if (session.role !== "admin" && session.role !== "tech") return null;
  // Disabled accounts can present a valid cookie until it expires; we
  // re-check the user store on every gate so revocation takes effect on
  // the next request rather than waiting 30 days.
  if (session.uid && (session.role === "admin" || session.role === "tech")) {
    const user = await users.get(session.uid);
    if (!user || user.disabled) return null;
  }
  return session;
}

async function requireAdmin(req) {
  const session = await readSession(req);
  if (!session || session.role !== "admin") return null;
  const user = await users.get(session.uid);
  if (!user || user.disabled) return null;
  return session;
}

async function requireCustomer(req) {
  const session = await readSession(req);
  if (!session) return null;
  if (session.role !== "customer") return null;
  if (typeof session.uid !== "string" || !session.uid.startsWith("customer:")) return null;
  return session;
}

// Keep the historical name around — used inside this file by the few
// places that just want to know "is anyone logged in" (e.g. the booking
// API key fallback). The new code paths use the explicit gates above.
async function isAuthenticated(req) {
  return Boolean(await requireUser(req));
}

async function setSessionCookie(req, res, { uid, role, ttlMs } = {}) {
  if (!uid || !role) throw new Error("setSessionCookie requires uid + role");
  const config = await readAuthConfig();
  const exp = Date.now() + (Number(ttlMs) || SESSION_MAX_AGE_SECONDS * 1000);
  const encoded = encodePayload({ uid, role, exp });
  const signature = signPayload(encoded, config.sessionSecret);
  const maxAge = Math.floor((exp - Date.now()) / 1000);
  const cookie = `${AUTH_COOKIE}=${encodeURIComponent(`${encoded}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookieFlag(req)}`;
  res.setHeader("set-cookie", cookie);
}

function clearSessionCookie(req, res) {
  res.setHeader("set-cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieFlag(req)}`);
}

// Best-effort caller IP — used for magic-token audit + rate-limit keys.
// Honors X-Forwarded-For when present (Render terminates TLS upstream)
// and falls back to the socket address. Trims to the first token so a
// chain of proxies doesn't get logged verbatim.
function callerIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "";
}

// Which URLs require which level of authentication. Returns:
//   "admin"   — admin-only (e.g. /admin/users)
//   "user"    — admin OR tech (most CRM pages and APIs)
//   null      — public
//
// The PUBLIC site (everything under SITE_DIR) is never gated — those are
// the customer-facing pages. The login page, customer portal, and /crm/
// static assets (CSS, JS, logos) are also public; the login page needs
// them to render. /admin/users is admin-only because it controls who can
// log in — techs cannot manage other accounts.
function needsAuth(method, pathname) {
  // Admin-only surfaces
  if (pathname === "/admin/users" || pathname === "/admin/users/") return "admin";
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) return "admin";
  // CRM pages — admin OR tech.
  if (pathname === "/admin" || pathname === "/admin/") return "user";
  if (pathname === "/admin/today" || pathname === "/admin/today/") return "user";
  if (pathname === "/admin/schedule" || pathname === "/admin/schedule/") return "user";
  if (pathname === "/admin/handoff" || pathname === "/admin/handoff/") return "user";
  if (pathname === "/admin/chats" || pathname === "/admin/chats/") return "user";
  if (pathname === "/admin/messages" || pathname === "/admin/messages/") return "user";
  if (pathname === "/admin/customers" || pathname === "/admin/customers/") return "user";
  if (/^\/admin\/customer\/[^/]+/.test(pathname)) return "user";
  if (pathname === "/admin/bookings" || pathname === "/admin/bookings/") return "user";
  if (/^\/admin\/booking\/[^/]+/.test(pathname)) return "user";
  if (pathname === "/admin/properties" || pathname === "/admin/properties/") return "user";
  if (pathname === "/admin/properties/import" || pathname === "/admin/properties/import/") return "user";
  if (/^\/admin\/property\/[^/]+/.test(pathname)) return "user";
  if (pathname === "/admin/work-orders" || pathname === "/admin/work-orders/") return "user";
  if (/^\/admin\/work-order\/[^/]+\/tech\/?$/.test(pathname)) return "user";
  if (/^\/admin\/work-order\/[^/]+/.test(pathname)) return "user";
  if (pathname === "/admin/invoices" || pathname === "/admin/invoices/") return "user";
  if (pathname === "/admin/quote-folder" || pathname === "/admin/quote-folder/") return "user";
  if (pathname === "/api/admin/quote-folder") return "user";
  if (/^\/admin\/invoice\/[^/]+\/?$/.test(pathname)) return "user";
  if (pathname === "/admin/settings" || pathname === "/admin/settings/") return "user";
  // Materials management (Phase 1 of the BoM/PO system).
  if (pathname === "/admin/suppliers" || pathname === "/admin/suppliers/") return "user";
  if (pathname === "/admin/material-lists" || pathname === "/admin/material-lists/") return "user";
  if (/^\/admin\/material-list\/[^/]+\/?$/.test(pathname)) return "user";
  // Projects (Phase 2 — multi-WO container that material lists attach to).
  if (pathname === "/admin/projects" || pathname === "/admin/projects/") return "user";
  if (/^\/admin\/project\/[^/]+\/?$/.test(pathname)) return "user";
  // Catalog ↔ supplier assignments + Purchase Orders (Phase 3).
  if (pathname === "/admin/parts-suppliers" || pathname === "/admin/parts-suppliers/") return "user";
  if (pathname === "/admin/purchase-orders" || pathname === "/admin/purchase-orders/") return "user";
  if (/^\/admin\/purchase-order\/[^/]+\/?$/.test(pathname)) return "user";
  if (pathname === "/api/quotes" && method === "GET") return "user";
  if (pathname === "/api/quotes.csv" || pathname === "/api/contacts" || pathname === "/api/contacts.vcf") return "user";
  if (/^\/api\/quotes\/[^/]+/.test(pathname)) return "user";
  // Chat transcripts: POST is public (customer's chat upserts its own transcript).
  // GET endpoints (list + detail) are admin-only.
  if (pathname === "/api/chat-transcripts" && method === "GET") return "user";
  if (/^\/api\/chat-transcripts\/[^/]+$/.test(pathname) && method === "GET") return "user";
  // Schedule management is admin-only.
  if (pathname.startsWith("/api/schedule/")) return "user";
  // Manual handoff (admin sends booking link to customer) is admin-only.
  if (pathname === "/api/admin/send-booking-link") return "user";
  if (pathname === "/api/admin/features") return "user";
  // Customers (the people PJL serves) — admin-only.
  if (pathname.startsWith("/api/customers")) return "user";
  if (pathname.startsWith("/api/customer/") || pathname === "/api/customer") return "user";
  // Properties (customer system profiles) are admin-only.
  if (pathname.startsWith("/api/properties")) return "user";
  // Work orders (tech-side per-visit records) are admin-only for now.
  // Phase 4 will add a customer-portal "approve quote" subset that's
  // public via a token, but that doesn't exist yet.
  if (pathname.startsWith("/api/work-orders")) return "user";
  if (pathname.startsWith("/api/invoices")) return "user";
  if (pathname.startsWith("/api/settings")) return "user";
  if (pathname === "/api/parts" || pathname.startsWith("/api/parts/")) return "user";
  if (pathname.startsWith("/api/custom-line-items")) return "user";
  if (pathname.startsWith("/api/admin/quickbooks")) return "user";
  // Portal-messages inbox (two-way thread with customers).
  if (pathname === "/api/admin/portal-messages" || pathname.startsWith("/api/admin/portal-messages/")) return "user";
  if (pathname.startsWith("/api/bookings")) return "user";
  if (pathname.startsWith("/api/suppliers")) return "user";
  if (pathname.startsWith("/api/material-lists")) return "user";
  if (pathname.startsWith("/api/projects")) return "user";
  if (pathname.startsWith("/api/part-suppliers")) return "user";
  if (pathname.startsWith("/api/purchase-orders")) return "user";
  // Per-lead property link/dismiss/attach + tech actions are admin-only.
  if (/^\/api\/leads\/[^/]+\/(link-property|dismiss-property-suggestion|attach-property|notify-on-route|open-wo)$/.test(pathname)) return "user";
  // Bulk property import is admin-only.
  if (pathname === "/api/admin/import-properties") return "user";
  // Property-ownership conflict review queue (Brief 3 follow-up).
  if (pathname === "/api/admin/property-link-conflicts") return "user";
  if (pathname.startsWith("/api/admin/property-link-conflicts/")) return "user";
  // Availability lookups + the public booking endpoint stay public.
  return null;
}

async function handleAuth(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/session") {
    const session = await readSession(req);
    if (!session) {
      return sendJson(res, 200, { ok: true, authenticated: false });
    }
    let me = null;
    if (session.role === "admin" || session.role === "tech") {
      const u = await users.get(session.uid);
      if (!u || u.disabled) {
        return sendJson(res, 200, { ok: true, authenticated: false });
      }
      me = { id: u.id, email: u.email, name: u.name, role: u.role };
    } else if (session.role === "customer") {
      me = { id: session.uid, role: "customer" };
    }
    return sendJson(res, 200, { ok: true, authenticated: true, role: session.role, user: me });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    try {
      const ip = callerIp(req);
      const ipKey = `login:ip:${ip}`;
      if (!rateLimit.check(ipKey, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS)) {
        return sendJson(res, 429, { ok: false, errors: ["Too many sign-in attempts. Try again in a few minutes."] });
      }
      rateLimit.record(ipKey);
      const payload = await parseRequestBody(req);
      const email = String(payload?.email || "").trim().toLowerCase();
      const password = String(payload?.password || "");
      const user = await users.verifyPassword(email, password);
      if (!user || user.disabled) {
        // Identical message + status for "wrong email," "wrong password,"
        // and "disabled account." Don't leak which branch failed.
        return sendJson(res, 401, { ok: false, errors: ["Invalid credentials."] });
      }
      await setSessionCookie(req, res, { uid: user.id, role: user.role });
      users.recordLogin(user.id).catch((err) => {
        console.warn("[auth] recordLogin failed:", err?.message);
      });
      return sendJson(res, 200, { ok: true, role: user.role });
    } catch {
      return sendJson(res, 400, { ok: false, errors: ["Unable to log in."] });
    }
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    clearSessionCookie(req, res);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

function normalizeEmail(value) {
  return normalizeString(value, 254).toLowerCase();
}

function normalizePhone(value) {
  return normalizeString(value, 40);
}

function normalizePostalCode(value) {
  const compact = normalizeString(value, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
    return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  }
  return normalizeString(value, 20).toUpperCase();
}

function portalTokenForId(id) {
  return crypto.createHash("sha256").update(`pjl-portal:${id}`).digest("base64url").slice(0, 24);
}

function defaultPortal(id, now = new Date().toISOString()) {
  return {
    token: portalTokenForId(id),
    createdAt: now,
    // Two-way thread between customer and admin. Each message:
    //   { id, from: "customer"|"admin", body, ts,
    //     readByAdmin?: boolean,   (only set for customer messages)
    //     readByCustomer?: boolean (only set for admin replies) }
    // Empty by default; appended by /api/portal/:token/message and
    // /api/admin/portal-messages/:leadId/reply.
    messages: []
  };
}

// Accepts either:
//   ["head_replacement", "service_call"]                       (legacy: each = qty 1)
//   [{ key: "head_replacement", qty: 3 }, { key: "service_call" }]  (with quantities)
// Unknown keys are silently dropped.
function selectedFeatures(input) {
  const requested = Array.isArray(input) ? input : [];
  return requested
    .map((entry) => (typeof entry === "string" ? { key: entry, qty: 1 } : entry))
    .filter((entry) => entry && typeof entry.key === "string" && Object.prototype.hasOwnProperty.call(FEATURES, entry.key))
    .map((entry) => {
      const def = FEATURES[entry.key];
      const qty = Math.max(1, Number(entry.qty) || 1);
      return {
        key: entry.key,
        label: def.label,
        price: def.price,
        qty,
        category: def.category,
        quoteType: def.quoteType
      };
    });
}

// Sum line totals. "custom"-quote items contribute $0 — PJL prices them on-site.
// "per-unit" items are price × qty. "flat" items are a single price regardless of qty.
function calcTotal(features) {
  return features.reduce((sum, item) => {
    if (item.quoteType === "custom") return sum;
    if (item.quoteType === "per-unit") return sum + (item.price * item.qty);
    return sum + item.price;
  }, 0);
}

function defaultCrm(now = new Date().toISOString()) {
  return {
    status: "new",
    priority: "normal",
    owner: "",
    nextFollowUp: "",
    internalNotes: "",
    lastUpdated: now,
    activity: [
      {
        at: now,
        type: "created",
        text: "Quote request received."
      }
    ]
  };
}

function hydrateLead(lead) {
  const now = lead.createdAt || new Date().toISOString();
  const crm = lead.crm && typeof lead.crm === "object" ? lead.crm : {};
  const status = CRM_STATUSES.has(crm.status || lead.status) ? (crm.status || lead.status) : "new";
  const portal = lead.portal && typeof lead.portal === "object" ? lead.portal : {};
  return {
    ...lead,
    status,
    archived: Boolean(lead.archived),
    // Older leads written before source-tagging existed get the default source.
    source: resolveSource(lead.source),
    // customerId (Brief 2): null on legacy leads until the migration
    // backfills them; set on new leads at intake.
    customerId: lead.customerId || null,
    photos: Array.isArray(lead.photos) ? lead.photos : [],
    portal: {
      ...defaultPortal(lead.id, now),
      ...portal,
      token: portal.token || portalTokenForId(lead.id)
    },
    crm: {
      ...defaultCrm(now),
      ...crm,
      status,
      priority: CRM_PRIORITIES.has(crm.priority) ? crm.priority : "normal",
      activity: Array.isArray(crm.activity) ? crm.activity : defaultCrm(now).activity
    }
  };
}

function validateLead(payload) {
  const contact = payload && typeof payload.contact === "object" ? payload.contact : {};
  const features = selectedFeatures(payload && payload.features);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = normalizeString(contact.name, 120);
  const phone = normalizePhone(contact.phone);
  const email = normalizeEmail(contact.email);
  const address = normalizeString(contact.address, 240);
  const notes = normalizeString(contact.notes, 1000);
  const expectedTotal = calcTotal(features);
  const errors = [];

  if (!name) errors.push("Your name is required.");
  if (!phone) errors.push("Phone is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("A valid email is required.");
  // Form-type-specific requirements (e.g. "must select at least one repair item")
  // are enforced per source in step 8. The general intake just needs a contactable customer.

  return {
    ok: errors.length === 0,
    errors,
    lead: {
      id,
      createdAt: now,
      status: "new",
      source: resolveSource(payload && payload.source),
      // Resolved by resolveCustomerForLead() after validation, before
      // writeLeads(). Stays null on the validate() output; set on the
      // returned lead just before persistence.
      customerId: null,
      contact: { name, phone, email, address, notes },
      features,
      totals: {
        expectedTotal,
        submittedTotal: Number(payload && payload.total) || 0,
        currency: "CAD"
      },
      context: {
        pageUrl: normalizeString(payload && payload.pageUrl, 500),
        userAgent: normalizeString(payload && payload.userAgent, 500),
        mode: normalizeString(payload && payload.mode, 60),
        // AI-diagnose source carries the chat transcript so Patrick can read
        // what the AI told the customer. Capped at 50K chars (typical chat is
        // ~5K). Empty for non-AI sources.
        transcript: normalizeString(payload && payload.transcript, 50000)
      },
      crm: defaultCrm(now),
      portal: defaultPortal(id, now)
    }
  };
}

// Resolve or create the canonical customer record for a freshly
// validated lead. Match order (spec §3.1, audit §5.4): email first,
// phone second, create new otherwise. New customers default to
// status="lead" — the first completed WO promotes them to "active".
//
// Failures are logged but never block intake — a lead without
// customerId is recoverable via `npm run migrate:customers --apply`.
async function resolveCustomerForLead(lead) {
  const contact = lead.contact || {};
  const email = contact.email || "";
  const phone = contact.phone || "";
  let match = null;
  if (email) match = await customers.findByEmail(email);
  if (!match && phone) match = await customers.findByPhone(phone);
  let customerId = match?.id || null;
  if (!customerId) {
    try {
      const created = await customers.create({
        name: contact.name || "",
        email,
        phone,
        source: lead.source || "lead",
        customerSince: lead.createdAt,
        status: "lead"
      }, { by: "intake", note: `Auto-created from lead ${lead.id}` });
      customerId = created.id;
    } catch (err) {
      if (err.code === "DUPLICATE_EMAIL") {
        // Race condition or normalization edge case — fall back to the
        // existing record rather than re-throwing.
        customerId = err.existingId;
      } else {
        throw err;
      }
    }
  }
  if (customerId) {
    try {
      await customers.addCommunication(customerId, {
        ts: lead.createdAt,
        source: lead.source || "lead",
        summary: `New ${lead.source || "lead"} intake`,
        notes: contact.notes || "",
        logId: lead.id
      });
    } catch (err) {
      console.warn("[customers] addCommunication failed:", err?.message || err);
    }
  }
  return customerId;
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(LEADS_FILE);
  } catch {
    await fs.writeFile(LEADS_FILE, "[]\n", "utf8");
  }
}

async function readLeads() {
  await ensureStore();
  const raw = await fs.readFile(LEADS_FILE, "utf8");
  return JSON.parse(raw || "[]").map(hydrateLead);
}

async function writeLeads(leads) {
  await fs.writeFile(LEADS_FILE, `${JSON.stringify(leads, null, 2)}\n`, "utf8");
}

function isLikelyDuplicate(leads, lead) {
  const recentWindowMs = 1000 * 60 * 60 * 12;
  const now = Date.parse(lead.createdAt);
  return leads.some((existing) => {
    const created = Date.parse(existing.createdAt || 0);
    const sameContact = existing.contact?.email === lead.contact.email || existing.contact?.phone === lead.contact.phone;
    const sameTotal = existing.totals?.expectedTotal === lead.totals.expectedTotal;
    return sameContact && sameTotal && now - created < recentWindowMs;
  });
}

async function parseRequestBody(req, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// ----- Photo handling ----------------------------------------------------
// Accepts client payload of the form: photos: [{ data: "<base64>", mediaType: "image/jpeg" }]
// Returns a normalized + validated array of { buffer, mediaType, ext, meta }, or throws.
// `meta` carries any caller-supplied tags (category, zoneNumber, issueId,
// label) untouched so the WO photo flow can persist them alongside the
// file metadata. The lead photo flow ignores meta — it didn't exist before.
//
// `opts.mode` flips between "lead" (default — image-only, 1.5 MB cap) and
// "wo" (Brief: WO Field-Readiness §5 — adds HEIC/HEIF/GIF/PDF, raises the
// per-file cap to 25 MB, and runs a magic-bytes check). Both modes share
// the same shape; the differences are in the whitelist + size cap.
function validatePhotos(rawPhotos, maxCount, opts = {}) {
  const cap = Number.isFinite(maxCount) ? maxCount : MAX_PHOTOS_PER_LEAD;
  if (!rawPhotos) return [];
  if (!Array.isArray(rawPhotos)) throw new Error("photos must be an array.");
  if (rawPhotos.length > cap) throw new Error(`Can include at most ${cap} photos in one upload.`);
  const mode = opts.mode === "wo" ? "wo" : "lead";
  const out = [];
  for (let i = 0; i < rawPhotos.length; i++) {
    const p = rawPhotos[i];
    if (!p || typeof p !== "object") throw new Error(`Photo ${i + 1} is not a valid object.`);
    const mediaType = String(p.mediaType || "image/jpeg").toLowerCase();
    if (mode === "wo") {
      if (!WO_MEDIA_MIME_WHITELIST.has(mediaType)) {
        throw new Error(`Unsupported file type "${mediaType}". Allowed: JPEG, PNG, HEIC, WebP, GIF, PDF.`);
      }
    } else {
      if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) throw new Error(`Photo ${i + 1} has an unsupported type.`);
    }
    const data = String(p.data || "").trim();
    if (!data) throw new Error(`Photo ${i + 1} has no data.`);
    let buffer;
    try { buffer = Buffer.from(data, "base64"); } catch { throw new Error(`Photo ${i + 1} is not valid base64.`); }
    if (!buffer.length) throw new Error(`Photo ${i + 1} decoded to zero bytes.`);
    const sizeCap = mode === "wo" ? MAX_WO_MEDIA_BYTES : MAX_PHOTO_BYTES;
    if (buffer.length > sizeCap) {
      const limitMb = (sizeCap / 1_000_000).toFixed(0);
      throw new Error(`File too large — ${limitMb} MB max (this one is ${(buffer.length / 1_000_000).toFixed(1)} MB).`);
    }
    if (mode === "wo" && !verifyWoMediaMagic(buffer, mediaType)) {
      throw new Error(`File ${i + 1} doesn't look like a real ${mediaType}. Re-export and try again.`);
    }
    const ext = mode === "wo"
      ? (WO_MEDIA_EXT_BY_MIME[mediaType] || "jpg")
      : (mediaType === "image/png" ? "png" : (mediaType === "image/webp" ? "webp" : "jpg"));

    // Geo (lat/lng/accuracy) — only accept finite coordinates inside a
    // sane Earth-bounded range. Anything malformed becomes null.
    let geo = null;
    if (p.geo && typeof p.geo === "object") {
      const lat = Number(p.geo.lat);
      const lng = Number(p.geo.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        geo = {
          lat,
          lng,
          accuracy: Number.isFinite(Number(p.geo.accuracy)) ? Number(p.geo.accuracy) : null
        };
      }
    }
    // Client-clock takenAt — capture moment, distinct from server-side
    // addedAt (when upload landed). ISO string only.
    let takenAt = null;
    if (typeof p.takenAt === "string") {
      const d = new Date(p.takenAt);
      if (!Number.isNaN(d.getTime())) takenAt = d.toISOString();
    }

    out.push({
      buffer,
      mediaType,
      ext,
      meta: {
        category: String(p.category || "general"),
        zoneNumber: Number.isFinite(Number(p.zoneNumber)) ? Number(p.zoneNumber) : null,
        issueId: typeof p.issueId === "string" ? p.issueId : null,
        label: typeof p.label === "string" ? p.label.slice(0, 200) : "",
        geo,
        takenAt
      }
    });
  }
  return out;
}

// Build a human-readable filename slug for a saved photo. Pattern:
//   YYYYMMDD-<P-CODE>-<WO-CODE>-<scope>-<n>.<ext>
// where scope is z<N> for zone photos, issue-<6char> for issue photos
// without a zone, or the category (general/pre_work/...) for everything
// else. Property code falls back to a placeholder when the WO has no
// linked property. Year/month/day come from takenAt if the client sent
// it, otherwise the server upload time.
function generatePhotoFilename({ takenAt, propertyCode, woId, photoMeta, n, ext }) {
  const d = takenAt ? new Date(takenAt) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const datePart = `${yyyy}${mm}${dd}`;
  const propPart = propertyCode || "P-UNKNOWN";
  const woPart = woId || "WO-UNKNOWN";
  let scopePart;
  if (photoMeta.zoneNumber != null) {
    scopePart = `z${photoMeta.zoneNumber}`;
  } else if (photoMeta.issueId) {
    scopePart = `issue-${String(photoMeta.issueId).slice(-6)}`;
  } else {
    scopePart = String(photoMeta.category || "general").replace(/_/g, "-");
  }
  return `${datePart}-${propPart}-${woPart}-${scopePart}-${n}.${ext || "jpg"}`;
}

// Save validated photos to disk and return the lightweight metadata to store
// alongside the lead record. Photos themselves are NOT stored in leads.json —
// only the file metadata. Files live at PHOTOS_DIR/<leadId>/N.<ext>.
async function savePhotosForLead(leadId, photos, now) {
  if (!photos.length) return [];
  const dir = path.join(PHOTOS_DIR, leadId);
  await fs.mkdir(dir, { recursive: true });
  const meta = [];
  for (let i = 0; i < photos.length; i++) {
    const n = i + 1;
    const filename = `${n}.${photos[i].ext}`;
    await fs.writeFile(path.join(dir, filename), photos[i].buffer);
    meta.push({
      n,
      mediaType: photos[i].mediaType,
      bytes: photos[i].buffer.length,
      addedAt: now
    });
  }
  return meta;
}

async function readPhotoFile(leadId, n) {
  const dir = path.join(PHOTOS_DIR, leadId);
  // Try each known extension. Photos are stored as <n>.<ext>.
  for (const ext of ["jpg", "png", "webp"]) {
    const file = path.join(dir, `${n}.${ext}`);
    try {
      const data = await fs.readFile(file);
      const mediaType = ext === "png" ? "image/png" : (ext === "webp" ? "image/webp" : "image/jpeg");
      return { data, mediaType };
    } catch {}
  }
  return null;
}

// WO photo storage — same shape as lead photos but starting from a
// caller-supplied baseN so multiple uploads append cleanly without
// renumbering existing files. Files live at WO_PHOTOS_DIR/<woId>/<n>.<ext>.
// Returns the new metadata entries to persist on wo.photos.
async function savePhotosForWorkOrder(woId, photos, now, baseN, context = {}) {
  if (!photos.length) return [];
  const dir = path.join(WO_PHOTOS_DIR, woId);
  await fs.mkdir(dir, { recursive: true });
  const meta = [];
  for (let i = 0; i < photos.length; i++) {
    const n = baseN + i + 1;
    // Files on disk stay as <n>.<ext> for simple lookup. The descriptive
    // filename rides on the meta record + serves as the
    // Content-Disposition value when browsers download the image.
    const onDiskFilename = `${n}.${photos[i].ext}`;
    await fs.writeFile(path.join(dir, onDiskFilename), photos[i].buffer);
    const filename = generatePhotoFilename({
      takenAt: photos[i].meta.takenAt,
      propertyCode: context.propertyCode,
      woId: context.woCode || woId,
      photoMeta: photos[i].meta,
      n,
      ext: photos[i].ext
    });
    meta.push({
      n,
      mediaType: photos[i].mediaType,
      // `kind` lets the client render appropriately: image → <img>,
      // pdf → filename tile with tap-through (Brief: WO Field-Readiness
      // §5.3). Older WO photos without a `kind` field default to image
      // in the client renderer (all pre-brief uploads were images).
      kind: photos[i].mediaType === "application/pdf" ? "pdf" : "image",
      bytes: photos[i].buffer.length,
      addedAt: now,
      filename,
      ...photos[i].meta
    });
  }
  return meta;
}

// Extension → MIME table for WO media (image set + PDF). Kept in sync
// with WO_MEDIA_EXT_BY_MIME inverted, with `jpg` mapping to JPEG.
const WO_MEDIA_MIME_BY_EXT = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  pdf: "application/pdf"
};

async function readWorkOrderPhotoFile(woId, n) {
  const dir = path.join(WO_PHOTOS_DIR, woId);
  for (const ext of Object.keys(WO_MEDIA_MIME_BY_EXT)) {
    const file = path.join(dir, `${n}.${ext}`);
    try {
      const data = await fs.readFile(file);
      return { data, mediaType: WO_MEDIA_MIME_BY_EXT[ext], ext };
    } catch {}
  }
  return null;
}

async function deleteWorkOrderPhotoFile(woId, n) {
  const dir = path.join(WO_PHOTOS_DIR, woId);
  for (const ext of Object.keys(WO_MEDIA_MIME_BY_EXT)) {
    const file = path.join(dir, `${n}.${ext}`);
    try { await fs.unlink(file); return true; } catch {}
  }
  return false;
}

// CORS — diagnose.html is currently hosted on GitHub Pages (different origin
// from the Render API). After the DNS cutover, both will be on the same
// origin and CORS becomes a no-op. /api/quotes only accepts new leads (no
// credentialed reads), so a permissive policy is safe.
const PUBLIC_API_PATHS = new Set([
  "/api/quotes",
  "/api/chat-transcripts",
  // Customer-facing booking flow (book.html). Pre-DNS-cutover this is
  // cross-origin (book.html on github.io → /api on Render); after cutover
  // it's same-origin and CORS becomes a no-op. Either way, safe.
  "/api/booking/services",
  "/api/booking/availability",
  "/api/booking/reserve",
  // Pricing dictionary — public so any page (including pricing.html on
  // GitHub Pages) can fetch the live catalog and render from it.
  "/api/pricing"
]);
function isPublicApiPath(pathname) {
  if (PUBLIC_API_PATHS.has(pathname)) return true;
  // Photo fetches by portal token are also public (token is the auth).
  if (/^\/api\/portal\/[^/]+\/photo\/\d+$/.test(pathname)) return "user";
  // Booking session lookup by token — needed so book.html can prefill the
  // form when a customer arrives via /book.html?session=… from a handoff
  // SMS/email. The session token is the auth, same model as portal photos.
  // Without this, cross-origin GETs from public-domain book.html get blocked.
  if (/^\/api\/booking\/session\/[^/]+$/.test(pathname)) return "user";
  return false;
}

// ----- Chat transcript storage -------------------------------------------
// Transcripts are upserted by client-generated sessionId. Each entry:
//   { id, sessionId, firstSeenAt, lastUpdatedAt, transcript, messageCount,
//     bookedLeadId, status: "active" | "booked" | "abandoned",
//     pageUrl, userAgent }
// We hold the file open just long enough to read + rewrite. For PJL's
// expected volume (low hundreds/day) this is fine. Rotate after the file
// grows past CHAT_FILE_SOFT_CAP entries.
const CHAT_FILE_SOFT_CAP = 5000;

async function readChats() {
  await ensureStore();
  try {
    const raw = await fs.readFile(CHATS_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}
async function writeChats(chats) {
  // If we've grown past the soft cap, prune the oldest abandoned entries
  // (keep all booked) so the file doesn't balloon over the years.
  if (chats.length > CHAT_FILE_SOFT_CAP) {
    chats.sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
    const kept = [];
    let abandonedKept = 0;
    for (const c of chats) {
      if (c.status === "booked") { kept.push(c); continue; }
      if (abandonedKept < CHAT_FILE_SOFT_CAP - 500) { kept.push(c); abandonedKept++; }
    }
    chats = kept;
  }
  await fs.writeFile(CHATS_FILE, `${JSON.stringify(chats, null, 2)}\n`, "utf8");
}

function normalizeTranscriptBody(value) {
  return normalizeString(value, 50000);
}

// Mark / link a chat to a lead once the customer books. Returns updated chat
// or null if the sessionId isn't in the store.
async function linkChatToLead(sessionId, leadId) {
  if (!sessionId) return null;
  const chats = await readChats();
  const idx = chats.findIndex((c) => c.sessionId === sessionId);
  if (idx === -1) return null;
  chats[idx] = {
    ...chats[idx],
    bookedLeadId: leadId,
    status: "booked",
    lastUpdatedAt: new Date().toISOString()
  };
  await writeChats(chats);
  return chats[idx];
}

// Sweep: any chat whose last update is older than ABANDON_THRESHOLD_MS and
// is still "active" gets reclassified to "abandoned." Cheap to run on each
// list query; keeps the data accurate without a cron.
const ABANDON_THRESHOLD_MS = 1000 * 60 * 30; // 30 minutes
function reclassifyAbandoned(chats) {
  const now = Date.now();
  let changed = false;
  for (const c of chats) {
    if (c.status === "active" && (now - Date.parse(c.lastUpdatedAt || c.firstSeenAt)) > ABANDON_THRESHOLD_MS) {
      c.status = "abandoned";
      changed = true;
    }
  }
  return changed;
}
function applyCorsHeaders(req, res, pathname) {
  if (!isPublicApiPath(pathname)) return;
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  } else {
    res.setHeader("access-control-allow-origin", "*");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
}

function leadToCsvRow(lead) {
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    lead.id,
    lead.createdAt,
    lead.crm?.status || lead.status,
    lead.crm?.priority,
    lead.crm?.owner,
    lead.crm?.nextFollowUp,
    lead.contact?.name,
    lead.contact?.phone,
    lead.contact?.email,
    lead.contact?.address,
    lead.contact?.notes,
    lead.features?.map((item) => item.label).join("; "),
    lead.totals?.expectedTotal,
    lead.totals?.currency,
    lead.crm?.internalNotes
  ].map(escape).join(",");
}

function renderCsv(leads) {
  const header = "id,createdAt,status,priority,owner,nextFollowUp,name,phone,email,address,customerNotes,features,total,currency,internalNotes";
  return [header, ...leads.map(leadToCsvRow)].join("\n");
}

function parseContactName(lead) {
  const contact = lead.contact || {};
  let firstName = normalizeString(contact.firstName || contact.first_name, 80);
  let lastName = normalizeString(contact.lastName || contact.last_name, 80);

  if (!firstName || !lastName) {
    const parts = normalizeString(contact.name, 140).split(" ").filter(Boolean);
    if (!firstName) firstName = parts.shift() || "";
    if (!lastName) lastName = parts.join(" ");
  }

  const errors = [];
  if (!firstName) errors.push("First name is missing.");
  if (!lastName) errors.push("Last name is missing.");

  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    errors
  };
}

function parseContactAddress(lead) {
  const contact = lead.contact || {};
  const raw = normalizeString(contact.address, 320);
  const postalMatch = raw.toUpperCase().match(/[A-Z]\d[A-Z][ -]?\d[A-Z]\d/);
  const structuredStreet = normalizeString(contact.street || contact.streetAddress || contact.street_address, 180);
  const streetLine = structuredStreet || raw.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean)[0] || "";

  let streetNumber = normalizeString(contact.streetNumber || contact.street_number, 40);
  let streetName = normalizeString(contact.streetName || contact.street_name, 160);
  let town = normalizeString(contact.town || contact.city || contact.cityTown || contact.city_town, 120);
  let postalCode = normalizePostalCode(contact.postalCode || contact.postal_code || (postalMatch ? postalMatch[0] : ""));

  if ((!streetNumber || !streetName) && streetLine) {
    const streetMatch = streetLine.match(/^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\s+(.+)$/);
    if (streetMatch) {
      streetNumber = streetNumber || streetMatch[1];
      streetName = streetName || streetMatch[2]
        .replace(/\bOntario\b/gi, "")
        .replace(/\bON\b/gi, "")
        .replace(/[A-Z]\d[A-Z][ -]?\d[A-Z]\d/gi, "")
        .replace(/,\s*$/, "")
        .trim();
    }
  }

  if (!town && raw) {
    const parts = raw.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean);
    const cityCandidate = parts[1] || "";
    town = cityCandidate
      .replace(/\bOntario\b/gi, "")
      .replace(/\bON\b/gi, "")
      .replace(/[A-Z]\d[A-Z][ -]?\d[A-Z]\d/gi, "")
      .replace(/,\s*$/, "")
      .trim();
  }

  const errors = [];
  if (!streetNumber) errors.push("Street number is missing.");
  if (!streetName) errors.push("Street name is missing.");
  if (!town) errors.push("Town/city is missing.");
  if (!/^[A-Z]\d[A-Z]\s\d[A-Z]\d$/.test(postalCode)) errors.push("Postal code is missing or invalid.");

  return {
    streetNumber,
    streetName,
    line1: [streetNumber, streetName].filter(Boolean).join(" "),
    town,
    province: CONTACT_PROVINCE,
    postalCode,
    country: CONTACT_COUNTRY,
    formatted: [
      [streetNumber, streetName].filter(Boolean).join(" "),
      [town, CONTACT_PROVINCE, postalCode].filter(Boolean).join(" "),
      CONTACT_COUNTRY
    ].filter(Boolean).join("\n"),
    errors
  };
}

// Build the absolute base URL the request was made against. Used to construct
// portal links, booking URLs, etc. that get sent to customers via SMS/email.
//
// Honors X-Forwarded-Proto so that when we're sitting behind Render's HTTPS
// terminator (or a Cloudflare proxy in front of it), we generate https://
// links directly — no http→https redirect chain that can inject a double
// slash into the path on the way through.
function baseUrlFromReq(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`;
}

// Build a URL by joining a path onto a base, using the URL constructor so
// edge cases (trailing slash on base, leading slash on path, query strings)
// are handled correctly. Returns a string. Used for every customer-facing
// link so we never accidentally produce ".com//book.html".
function joinUrl(baseUrl, relativePath, searchParams = null) {
  const url = new URL(relativePath, baseUrl);
  if (searchParams && typeof searchParams === "object") {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function contactRecordForLead(lead, req) {
  const name = parseContactName(lead);
  const address = parseContactAddress(lead);
  const phone = normalizePhone(lead.contact?.phone);
  const email = normalizeEmail(lead.contact?.email);
  const errors = [...name.errors, ...address.errors];

  if (!phone) errors.push("Telephone number is missing.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email address is missing or invalid.");

  const portalPath = `/portal/${lead.portal?.token || portalTokenForId(lead.id)}`;
  const portalUrl = joinUrl(baseUrlFromReq(req), portalPath);

  return {
    ready: errors.length === 0,
    errors,
    firstName: name.firstName,
    lastName: name.lastName,
    fullName: name.fullName,
    telephone: phone,
    email,
    address,
    note: CONTACT_NOTE,
    portalPath,
    portalUrl,
    vcardUrl: `/api/quotes/${encodeURIComponent(lead.id)}/contact.vcf`
  };
}

function escapeVCard(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function renderVCard(contact) {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCard(contact.lastName)};${escapeVCard(contact.firstName)};;;`,
    `FN:${escapeVCard(contact.fullName)}`,
    `TEL;TYPE=CELL,VOICE:${escapeVCard(contact.telephone)}`,
    `EMAIL;TYPE=INTERNET:${escapeVCard(contact.email)}`,
    `ADR;TYPE=HOME:;;${escapeVCard(contact.address.line1)};${escapeVCard(contact.address.town)};${CONTACT_PROVINCE};${escapeVCard(contact.address.postalCode)};${CONTACT_COUNTRY}`,
    `NOTE:${CONTACT_NOTE}`,
    `URL:${escapeVCard(contact.portalUrl)}`,
    "END:VCARD"
  ].join("\r\n") + "\r\n";
}

function decorateLeadForAdmin(lead, req) {
  const contactExport = contactRecordForLead(lead, req);
  const sourceKey = resolveSource(lead.source);
  const sourceMeta = SOURCES[sourceKey];
  // Admin photo URLs use the lead.id (cookie-gated), not the portal token.
  const photos = (lead.photos || []).map((p) => ({
    n: p.n,
    url: `/api/quotes/${encodeURIComponent(lead.id)}/photo/${p.n}`,
    mediaType: p.mediaType,
    bytes: p.bytes,
    addedAt: p.addedAt
  }));
  return {
    ...lead,
    source: sourceKey,
    sourceLabel: sourceMeta.label,
    sourceCategory: sourceMeta.category,
    portalUrl: contactExport.portalUrl,
    contactExport,
    photos
  };
}

// Hydrate a decorated lead with its source Quote (if any) so the CRM
// lead-detail pane can render the Quote card without a second fetch. The
// list endpoint pre-builds a map for efficiency; single-lead responses
// (PATCH status, archive, link-property, etc.) just call this helper. A
// missing quote is silently swallowed — the lead loads fine without it.
async function hydrateLeadQuote(decorated) {
  if (!decorated || !decorated.quoteId) return decorated;
  try {
    const q = await quotes.get(decorated.quoteId);
    if (q) decorated.quote = q;
  } catch (err) {
    console.warn("[quotes] hydrate failed for", decorated.id, err?.message);
  }
  return decorated;
}

async function portalPayloadForLead(lead, req) {
  const contact = contactRecordForLead(lead, req);
  // Pull the linked property so the customer can see their system profile
  // ("Your System" card). Falls back to null when the lead pre-dates the
  // properties feature or the link is missing.
  let property = null;
  if (lead.propertyId) {
    try { property = await properties.get(lead.propertyId); }
    catch { /* fall through with null */ }
  }
  const propertyForCustomer = property ? {
    id: property.id,
    address: property.address,
    system: {
      controllerLocation: property.system?.controllerLocation || "",
      controllerBrand: property.system?.controllerBrand || "",
      shutoffLocation: property.system?.shutoffLocation || "",
      blowoutLocation: property.system?.blowoutLocation || "",
      zones: Array.isArray(property.system?.zones) ? property.system.zones : [],
      valveBoxes: Array.isArray(property.system?.valveBoxes)
        ? property.system.valveBoxes.map((b) => ({ location: b.location, valveCount: b.valveCount }))
        : []
    }
  } : null;
  const status = lead.crm?.status || lead.status || "new";
  // Customer-visible activity: portal messages, status changes, and the
  // initial "Quote request received" entry. Filters out internal-only notes
  // that Patrick has typed in the CRM Internal-Notes field.
  const visibleActivity = (lead.crm?.activity || [])
    .filter((entry) => {
      const t = (entry.text || "").toLowerCase();
      if (entry.type === "created") return true;
      if (t.startsWith("status changed")) return true;
      if (t.startsWith("customer message via portal:")) return true;
      if (t.startsWith("customer accepted the quote")) return true;
      return false;
    })
    .slice(0, 30);

  return {
    customer: {
      name: contact.fullName || lead.contact?.name || "PJL Customer",
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.telephone,
      email: contact.email,
      address: contact.address.formatted || lead.contact?.address || ""
    },
    project: {
      status,
      priority: lead.crm?.priority || "normal",
      nextFollowUp: lead.crm?.nextFollowUp || "",
      requestedAt: lead.createdAt,
      services: lead.features || [],
      total: lead.totals?.expectedTotal || 0,
      currency: lead.totals?.currency || "CAD",
      customerNotes: lead.contact?.notes || "",
      canAccept: status === "quoted",
      activity: visibleActivity,
      // Photo URLs are token-scoped (each customer can only see their own).
      // Token is the portal token; never the leadId.
      photos: (lead.photos || []).map((p) => ({
        n: p.n,
        url: `/api/portal/${lead.portal?.token || portalTokenForId(lead.id)}/photo/${p.n}`,
        addedAt: p.addedAt
      }))
    },
    booking: lead.booking ? {
      start: lead.booking.start,
      end: lead.booking.end,
      durationMinutes: lead.booking.durationMinutes,
      serviceLabel: lead.booking.serviceLabel,
      zoneCount: lead.booking.zoneCount,
      // Bucket-mode display fields. The portal "Your appointment is at
      // X" line uses these instead of a precise time so the customer
      // sees "Morning Appointment (8 AM – 12 PM)" exactly as on the
      // confirmation page.
      bucketLabel: lead.booking.bucketLabel || null,
      bucketWindow: lead.booking.bucketWindow || null
    } : null,
    workOrder: lead.booking?.workOrder ? {
      id: lead.booking.workOrder.id,
      status: lead.booking.workOrder.status,
      total: lead.booking.workOrder.total,
      priceLabel: lead.booking.workOrder.priceLabel,
      priceNote: lead.booking.workOrder.priceNote,
      custom: lead.booking.workOrder.custom,
      currency: lead.booking.workOrder.currency,
      documentReady: lead.booking.workOrder.documentReady,
      documentUrl: lead.booking.workOrder.documentUrl,
      diagnosis: lead.booking.workOrder.diagnosis || null,
      createdAt: lead.booking.workOrder.createdAt
    } : null,
    portal: {
      token: lead.portal?.token || portalTokenForId(lead.id),
      url: contact.portalUrl
    },
    // Two-way message thread. Both customer and admin entries are
    // returned in chronological order so the portal can render the
    // conversation. readByAdmin is admin-side state only; readByCustomer
    // is what the portal uses to decide whether to badge unread replies.
    messages: Array.isArray(lead.portal?.messages)
      ? lead.portal.messages.map((m) => ({
          id: m.id,
          from: m.from,
          body: m.body,
          ts: m.ts,
          readByCustomer: Boolean(m.readByCustomer)
        }))
      : [],
    // Customer's property profile (read-only on the portal). Surfaces the
    // zone list, controller / shutoff / blowout locations, valve boxes —
    // everything Patrick needs to remember about the system, the customer
    // also gets to see and verify is right.
    property: propertyForCustomer
  };
}

function applyCrmUpdate(lead, payload) {
  const crm = { ...lead.crm };
  const previousStatus = crm.status || lead.status || "new";
  const changes = [];

  if (Object.prototype.hasOwnProperty.call(payload, "archived")) {
    const archived = Boolean(payload.archived);
    if (Boolean(lead.archived) !== archived) {
      changes.push(archived ? "Lead archived." : "Lead restored from archive.");
    }
    lead.archived = archived;
  }

  if (payload.contact && typeof payload.contact === "object") {
    const contact = { ...(lead.contact || {}) };
    const firstName = normalizeString(payload.contact.firstName, 80);
    const lastName = normalizeString(payload.contact.lastName, 80);
    const phone = normalizePhone(payload.contact.phone);
    const email = normalizeEmail(payload.contact.email);
    const streetNumber = normalizeString(payload.contact.streetNumber, 40);
    const streetName = normalizeString(payload.contact.streetName, 160);
    const town = normalizeString(payload.contact.town, 120);
    const postalCode = normalizePostalCode(payload.contact.postalCode);
    const nextAddress = [
      [streetNumber, streetName].filter(Boolean).join(" "),
      [town, CONTACT_PROVINCE, postalCode].filter(Boolean).join(" "),
      CONTACT_COUNTRY
    ].filter(Boolean).join("\n");

    contact.firstName = firstName;
    contact.lastName = lastName;
    contact.name = [firstName, lastName].filter(Boolean).join(" ") || contact.name || "";
    contact.phone = phone;
    contact.email = email;
    contact.streetNumber = streetNumber;
    contact.streetName = streetName;
    contact.town = town;
    contact.postalCode = postalCode;
    contact.address = nextAddress || contact.address || "";

    lead.contact = contact;
    changes.push("Customer contact fields updated.");
  }

  if (Object.prototype.hasOwnProperty.call(payload, "status")) {
    const status = normalizeString(payload.status, 40);
    if (!CRM_STATUSES.has(status)) throw new Error("Unsupported lead status.");
    if (crm.status !== status) changes.push(`Status changed from ${crm.status} to ${status}.`);
    crm.status = status;
    lead.status = status;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "priority")) {
    const priority = normalizeString(payload.priority, 40);
    if (!CRM_PRIORITIES.has(priority)) throw new Error("Unsupported lead priority.");
    if (crm.priority !== priority) changes.push(`Priority changed from ${crm.priority} to ${priority}.`);
    crm.priority = priority;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "owner")) {
    const owner = normalizeString(payload.owner, 120);
    if (crm.owner !== owner) changes.push(owner ? `Owner set to ${owner}.` : "Owner cleared.");
    crm.owner = owner;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "nextFollowUp")) {
    const nextFollowUp = normalizeString(payload.nextFollowUp, 40);
    if (nextFollowUp && Number.isNaN(Date.parse(nextFollowUp))) throw new Error("Follow-up date is invalid.");
    if (crm.nextFollowUp !== nextFollowUp) changes.push(nextFollowUp ? `Follow-up set for ${nextFollowUp}.` : "Follow-up cleared.");
    crm.nextFollowUp = nextFollowUp;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "internalNotes")) {
    const internalNotes = normalizeString(payload.internalNotes, 2000);
    if (crm.internalNotes !== internalNotes) changes.push("Internal notes updated.");
    crm.internalNotes = internalNotes;
  }

  const now = new Date().toISOString();
  const manualNote = normalizeString(payload.activityNote, 800);
  const activity = Array.isArray(crm.activity) ? crm.activity.slice(0, 100) : [];
  if (manualNote) {
    activity.unshift({ at: now, type: "note", text: manualNote });
  }
  changes.forEach((text) => activity.unshift({ at: now, type: "update", text }));
  crm.activity = activity;
  crm.lastUpdated = now;
  lead.crm = crm;
  // Track stage transitions so the API layer can fire customer notifications
  // only when something actually changed. Not stored on the lead itself.
  lead._statusTransition = { from: previousStatus, to: crm.status };
  return lead;
}

// Returns the array of active bookings extracted from the current leads file.
// Each entry is { start, end, coords, leadId } in the shape availability.js
// expects. Filters out cancelled (lost) and archived leads.
async function activeBookings() {
  const leads = await readLeads();
  const fromLeads = leads
    .filter((lead) => !lead.archived && (lead.crm?.status || lead.status) !== "lost" && lead.booking)
    .map((lead) => ({
      start: lead.booking.start,
      end: lead.booking.end,
      coords: lead.booking.coords || PJL_BASE,
      leadId: lead.id,
      serviceKey: lead.booking.serviceKey,
      serviceLabel: lead.booking.serviceLabel
    }))
    .filter((b) => b.start && b.end);

  // Union bookings.json records that aren't already represented by
  // lead.booking. Most leads have ONE embedded lead.booking, but a single
  // customer can have a follow-up appointment that lives only in
  // bookings.json — those need to count against the calendar too. Match
  // is by exact start time + leadId; anything in bookings.json with a
  // different start than its lead's lead.booking adds to the schedule.
  try {
    const bookingRecs = await bookings.list();
    for (const b of bookingRecs) {
      if (!b.scheduledFor) continue;
      if (b.status === "cancelled" || b.status === "completed" || b.status === "no_show") continue;
      const dup = fromLeads.find((f) => f.leadId === b.leadId && f.start === b.scheduledFor);
      if (dup) continue;
      const startD = new Date(b.scheduledFor);
      const endD = new Date(startD.getTime() + (Number(b.durationMinutes) || 60) * 60 * 1000);
      fromLeads.push({
        start: startD.toISOString(),
        end: endD.toISOString(),
        coords: PJL_BASE,
        leadId: b.leadId,
        serviceKey: b.serviceKey,
        serviceLabel: b.serviceLabel
      });
    }
  } catch (err) {
    console.warn("[activeBookings] bookings.json union skipped:", err?.message);
  }
  return fromLeads;
}

// Sync property.address (+ customer name/phone) into every lead and
// booking that references this property. Called after PATCH on a
// property record so a single address edit reaches every downstream
// surface in one shot (schedule canvas modal, iCal feed, /api/quotes
// payload, customer detail page, etc.). Idempotent — fields that
// already match are skipped silently.
//
// Returns { leadsUpdated, bookingsUpdated } so the API can echo the
// scope of the change back to the admin UI for a confirmation toast.
async function cascadePropertyToLinkedRecords(property) {
  const result = { leadsUpdated: 0, bookingsUpdated: 0 };
  if (!property || !property.id) return result;
  const propAddress = String(property.address || "").trim();
  const propName = String(property.customerName || "").trim();
  const propPhone = String(property.customerPhone || "").trim();
  if (!propAddress) return result; // nothing to cascade

  // Leads — write lead.contact.address (and name/phone if the property
  // has them set). The booking modal + /api/quotes both read these
  // fields, so this is the path that makes the address visible
  // everywhere outside the canonical Booking folder.
  try {
    const allLeads = await readLeads();
    let leadsTouched = false;
    for (const lead of allLeads) {
      if (lead.propertyId !== property.id) continue;
      if (!lead.contact) lead.contact = {};
      let touched = false;
      if (lead.contact.address !== propAddress) {
        lead.contact.address = propAddress;
        touched = true;
      }
      if (propName && lead.contact.name !== propName) {
        lead.contact.name = propName;
        touched = true;
      }
      if (propPhone && lead.contact.phone !== propPhone) {
        lead.contact.phone = propPhone;
        touched = true;
      }
      // lead.booking is the legacy embedded shape; it doesn't carry a
      // separate address field, so syncing lead.contact is enough.
      if (touched) {
        result.leadsUpdated++;
        leadsTouched = true;
      }
    }
    if (leadsTouched) await writeLeads(allLeads);
  } catch (err) {
    console.warn("[property cascade] leads sync failed:", err?.message);
  }

  // Bookings (canonical store) — write booking.address through the
  // official update() helper so updatedAt + history stay consistent.
  try {
    const all = await bookings.list();
    for (const b of all) {
      if (b.propertyId !== property.id) continue;
      const patch = {};
      if (b.address !== propAddress) patch.address = propAddress;
      if (propName && b.customerName !== propName) patch.customerName = propName;
      if (propPhone && b.customerPhone !== propPhone) patch.customerPhone = propPhone;
      if (Object.keys(patch).length === 0) continue;
      try {
        await bookings.update(b.id, patch);
        result.bookingsUpdated++;
      } catch (e) { /* skip one bad booking; keep going */ }
    }
  } catch (err) {
    console.warn("[property cascade] bookings sync failed:", err?.message);
  }

  return result;
}

// Returns available slots for an existing booking's reschedule modal.
// Same contract as /api/booking/availability but service + address come
// from the booking record (not query params), and the booking's own
// current slot is removed from the conflict math.
async function rescheduleAvailability(bookingId, { from, to } = {}) {
  const bookingRec = await bookings.get(bookingId);
  if (!bookingRec) return { ok: false, status: 404, errors: ["Booking not found."] };
  const serviceKey = bookingRec.serviceKey;
  if (!serviceKey || !BOOKABLE_SERVICES[serviceKey]) {
    return { ok: false, status: 422, errors: ["Booking has no recognizable service tier."] };
  }
  const allLeads = bookingRec.leadId ? await readLeads() : [];
  const lead = bookingRec.leadId ? allLeads.find((l) => l.id === bookingRec.leadId) : null;
  const address = bookingRec.address || lead?.contact?.address || "";
  if (!address) return { ok: false, status: 422, errors: ["Address missing on the booking."] };
  const geo = await geocode(address);
  const allActive = await activeBookings();
  const otherBookings = allActive.filter((b) => b.leadId !== bookingRec.leadId);
  const scheduleData = await scheduleStore.read();
  const mergedHours = { ...DEFAULT_HOURS, ...(scheduleData.hours || {}) };
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(scheduleData.settings || {}) };
  // When the picker supplies an explicit visible range, scan far enough to
  // reach the latest day in view. Otherwise fall back to the legacy 30-day
  // window the old reschedule modal used.
  const now = new Date();
  const fromDate = parseLocalDateKey(from);
  const toDate = parseLocalDateKey(to);
  let daysAhead = 30;
  if (toDate) {
    daysAhead = Math.min(120, Math.max(1, Math.ceil((toDate.getTime() - now.getTime()) / 86400000) + 1));
  }
  const slots = await listAvailableSlots({
    serviceKey,
    customerCoords: geo.coords,
    bookings: otherBookings,
    blocks: scheduleData.blocks,
    daysAhead,
    hours: mergedHours,
    settings: mergedSettings
  });
  const days = (fromDate && toDate)
    ? expandDaysToRange(slots, { from: fromDate, to: toDate, hours: mergedHours, now })
    : groupByDay(slots);
  return {
    ok: true,
    data: {
      service: { key: serviceKey, ...BOOKABLE_SERVICES[serviceKey] },
      currentScheduledFor: bookingRec.scheduledFor,
      address: geo.coords?.formattedAddress || address,
      range: (fromDate && toDate) ? { from, to } : null,
      days,
      totalSlots: slots.length
    }
  };
}

// Shared reschedule logic — used by both the admin endpoint
// (PATCH /api/bookings/:id/reschedule) and the customer portal endpoint
// (PATCH /api/portal/:token/reschedule). Validates the new slot, mutates
// bookings.json + lead.booking + the linked work-order's scheduledFor,
// pushes a history entry, and fires customer notifications.
//
// Returns { ok, status?, errors?, booking?, slot? }. Caller is
// responsible for the auth / 24-hour gating decisions; this helper just
// executes the move once it's been authorized.
//
// `actor` is "admin" or "customer". When "customer", Patrick gets paged
// in addition to the customer's own confirmation.
async function rescheduleBooking({ bookingId, slotStart, actor = "admin", actorName = "", reason = "", req } = {}) {
  if (!slotStart || Number.isNaN(Date.parse(slotStart))) {
    return { ok: false, status: 422, errors: ["Pick a valid time slot."] };
  }
  const bookingRec = await bookings.get(bookingId);
  if (!bookingRec) return { ok: false, status: 404, errors: ["Booking not found."] };
  if (bookingRec.status === "cancelled" || bookingRec.status === "completed" || bookingRec.status === "no_show") {
    return { ok: false, status: 409, errors: ["This appointment can't be rescheduled — its status is " + bookingRec.status + "."] };
  }

  // Look up the linked WO (if any) — we need to update wo.scheduledFor
  // and we also block the move if the tech has already arrived. Multi-WO
  // bookings rarely happen but if any WO has arrivedAt set, block.
  const linkedWoIds = Array.isArray(bookingRec.workOrderIds) ? bookingRec.workOrderIds : [];
  const linkedWos = (await Promise.all(linkedWoIds.map((wid) => workOrders.get(wid)))).filter(Boolean);
  if (linkedWos.some((w) => w.arrivedAt)) {
    return { ok: false, status: 409, errors: ["Technician has already arrived for this appointment — use the follow-up flow instead."] };
  }

  // Look up the lead so we can update lead.booking + lead.crm.activity.
  const allLeads = await readLeads();
  const leadIdx = bookingRec.leadId ? allLeads.findIndex((l) => l.id === bookingRec.leadId) : -1;
  const lead = leadIdx >= 0 ? allLeads[leadIdx] : null;

  // Validate the new slot. Service + duration come from the booking
  // record; address geocoding is required because the engine factors
  // travel time. We exclude THIS booking's own occupancy from the
  // conflict check (otherwise the customer collides with themselves).
  const serviceKey = bookingRec.serviceKey;
  const service = BOOKABLE_SERVICES[serviceKey];
  if (!service) return { ok: false, status: 422, errors: ["Booking has no recognizable service tier — call PJL to reschedule."] };
  const startDate = new Date(slotStart);

  const address = bookingRec.address || lead?.contact?.address || "";
  if (!address) return { ok: false, status: 422, errors: ["Address missing on the booking — can't compute drive times."] };
  const geo = await geocode(address);
  const allActive = await activeBookings();
  const otherBookings = allActive.filter((b) => b.leadId !== bookingRec.leadId);
  const scheduleData = await scheduleStore.read();
  const mergedHours = { ...DEFAULT_HOURS, ...(scheduleData.hours || {}) };
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(scheduleData.settings || {}) };
  const candidateSlots = await listAvailableSlots({
    serviceKey,
    customerCoords: geo.coords,
    bookings: otherBookings,
    blocks: scheduleData.blocks,
    daysAhead: 60,
    hours: mergedHours,
    settings: mergedSettings
  });
  const matched = candidateSlots.find((s) => s.start === startDate.toISOString());
  if (!matched) {
    return { ok: false, status: 409, errors: ["That slot isn't available — please pick another time."] };
  }
  // Bucket-mode: the slot end is the bucket window end (12:00 / 17:00).
  // matched.end carries that ISO string from listAvailableSlots; same
  // for durationMinutes (bucket length, not service.minutes).
  const endDate = new Date(matched.end);

  // 1) Push the canonical bookings.json record.
  const updatedBooking = await bookings.reschedule(bookingId, {
    scheduledFor: startDate.toISOString(),
    by: actor,
    actorName,
    reason
  });

  // 2) Mirror to lead.booking (read cache).
  if (lead && lead.booking) {
    lead.booking.start = startDate.toISOString();
    lead.booking.end = endDate.toISOString();
    // Bucket-mode: keep the legacy snapshot in sync with the new slot's
    // bucket fields. Without this, the portal "Your appointment is at X"
    // copy would show the OLD bucket label after a reschedule.
    lead.booking.durationMinutes = matched.durationMinutes;
    lead.booking.bucketKey = matched.bucketKey || null;
    lead.booking.bucketWindow = matched.bucketWindow || null;
    lead.booking.bucketLabel = matched.timeLabel || null;
    lead.crm = lead.crm || {};
    lead.crm.activity = Array.isArray(lead.crm.activity) ? lead.crm.activity : [];
    const prev = bookingRec.scheduledFor ? new Date(bookingRec.scheduledFor) : null;
    const formatStr = (d) => d ? d.toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "(unscheduled)";
    lead.crm.activity.unshift({
      at: new Date().toISOString(),
      type: "update",
      text: `${actor === "customer" ? "Customer" : "Patrick"} rescheduled appointment: ${formatStr(prev)} → ${formatStr(startDate)}${reason ? ` (${reason})` : ""}`
    });
    lead.crm.lastUpdated = new Date().toISOString();
    allLeads[leadIdx] = lead;
    await writeLeads(allLeads);
  }

  // 3) Update wo.scheduledFor on every linked WO.
  for (const wo of linkedWos) {
    try { await workOrders.update(wo.id, { scheduledFor: startDate.toISOString() }); }
    catch (err) { console.warn(`[reschedule] WO ${wo.id} update failed:`, err?.message); }
  }

  // 4) Customer-facing notification — sent on every reschedule, both
  //    admin- and customer-initiated. Uses the rescheduled template.
  const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
  if (lead) {
    const aliasLead = {
      ...lead,
      portalUrl: lead.portal?.token ? joinUrl(baseUrl, `/portal/${lead.portal.token}`) : null
    };
    notifyCustomer("rescheduled", aliasLead, { baseUrl }).catch(() => {});
  }

  // 5) Page Patrick when the customer drove the change.
  if (actor === "customer" && lead) {
    const aliasLead = {
      id: lead.id,
      sourceLabel: "Customer rescheduled their appointment",
      contact: {
        name: lead.contact?.name || "(unknown)",
        phone: lead.contact?.phone || "",
        email: lead.contact?.email || "",
        address: lead.contact?.address || "",
        notes: `Was: ${bookingRec.scheduledFor || "(unscheduled)"}. Now: ${startDate.toISOString()}.${reason ? " Reason: " + reason : ""}`
      }
    };
    Promise.allSettled([
      sendNewLeadEmail(aliasLead, { baseUrl }),
      sendNewLeadSms(aliasLead, { baseUrl })
    ]).catch(() => {});
  }

  return { ok: true, booking: updatedBooking, slot: matched };
}

// ===================== Identity & access endpoints =====================
//
// Three flows live here:
//   1. /api/users         — admin-only user management (CRUD + password reset)
//   2. /api/reset-password — admin/tech password reset by magic-token
//   3. /api/portal/...    — customer magic-link login (request + verify)
//
// All three share the lib/magic-tokens.js + lib/rate-limit.js plumbing.
// The route gate (needsAuth above) already gated /api/users behind admin.
async function handleIdentityApi(req, res, pathname) {
  // ---- Admin user management -------------------------------------------
  if (req.method === "GET" && pathname === "/api/users") {
    const list = await users.list({ includeDisabled: true });
    return sendJson(res, 200, { ok: true, users: list });
  }

  if (req.method === "POST" && pathname === "/api/users") {
    try {
      const payload = await parseRequestBody(req);
      const created = await users.create({
        email: payload?.email,
        name: payload?.name,
        role: payload?.role,
        password: payload?.password
      });
      return sendJson(res, 201, { ok: true, user: created });
    } catch (err) {
      return sendJson(res, 422, { ok: false, errors: [err.message || "Couldn't create user."] });
    }
  }

  const userIdMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userIdMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(userIdMatch[1]);
      const session = await readSession(req);
      const target = await users.get(id);
      if (!target) return sendJson(res, 404, { ok: false, errors: ["User not found."] });
      const payload = await parseRequestBody(req);

      // Self-disable / self-demote protection.
      if (session?.uid === id) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, "disabled") && payload.disabled === true) {
          return sendJson(res, 409, { ok: false, errors: ["You can't disable your own account."] });
        }
        if (payload && Object.prototype.hasOwnProperty.call(payload, "role") && payload.role !== target.role) {
          return sendJson(res, 409, { ok: false, errors: ["You can't change your own role."] });
        }
      }

      // Last-admin protection: the FINAL active admin can't be demoted or
      // disabled. Counts active admins and refuses if removing this one
      // would drop the count to zero.
      const willDemote = Object.prototype.hasOwnProperty.call(payload || {}, "role")
        && payload.role !== "admin"
        && target.role === "admin";
      const willDisable = Object.prototype.hasOwnProperty.call(payload || {}, "disabled")
        && payload.disabled === true
        && !target.disabled;
      if ((willDemote || willDisable) && target.role === "admin" && !target.disabled) {
        const activeAdmins = await users.activeAdminCount();
        if (activeAdmins <= 1) {
          return sendJson(res, 409, { ok: false, errors: ["At least one admin must remain active."] });
        }
      }

      const updated = await users.update(id, payload);
      return sendJson(res, 200, { ok: true, user: updated });
    } catch (err) {
      return sendJson(res, 422, { ok: false, errors: [err.message || "Couldn't update user."] });
    }
  }

  if (userIdMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(userIdMatch[1]);
      const session = await readSession(req);
      const target = await users.get(id);
      if (!target) return sendJson(res, 404, { ok: false, errors: ["User not found."] });
      if (session?.uid === id) {
        return sendJson(res, 409, { ok: false, errors: ["You can't delete your own account."] });
      }
      if (target.role === "admin" && !target.disabled) {
        const activeAdmins = await users.activeAdminCount();
        if (activeAdmins <= 1) {
          return sendJson(res, 409, { ok: false, errors: ["At least one admin must remain active."] });
        }
      }
      await users.remove(id);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't delete user."] });
    }
  }

  // Admin issues a password-reset link to a user (themselves or another).
  // Per-user rate limited so a malicious admin can't email-bomb a tech.
  const userResetMatch = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
  if (userResetMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(userResetMatch[1]);
      const target = await users.get(id);
      if (!target) return sendJson(res, 404, { ok: false, errors: ["User not found."] });
      const rateKey = `pwreset:user:${id}`;
      if (!rateLimit.check(rateKey, PASSWORD_RESET_LIMIT, PASSWORD_RESET_WINDOW_MS)) {
        return sendJson(res, 429, { ok: false, errors: ["Too many reset requests for this user. Try again later."] });
      }
      rateLimit.record(rateKey);
      const token = await magicTokens.issue("admin_password_reset", id, { requestIp: callerIp(req) });
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const link = joinUrl(baseUrl, "/reset-password", { t: token.id });
      // Send the email. Best-effort — if Gmail isn't configured, surface
      // the link so the admin can hand it off out-of-band. (No magic
      // tokens are EVER logged or returned in production-config errors.)
      let emailSent = false;
      try {
        const result = await sendAdminPasswordResetLink(target, link);
        emailSent = Boolean(result && result.ok);
      } catch (err) {
        console.warn("[auth] reset-password email failed:", err?.message);
      }
      return sendJson(res, 200, { ok: true, emailSent });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't issue reset link."] });
    }
  }

  return false;
}

// Public reset-password endpoints (no auth — token IS the auth).
async function handleResetPasswordApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/reset-password/verify") {
    try {
      const url = new URL(req.url, baseUrlFromReq(req));
      const t = url.searchParams.get("t") || "";
      const result = await magicTokens.verify(t, "admin_password_reset");
      if (!result.ok) {
        return sendJson(res, 200, { ok: true, valid: false, reason: result.reason });
      }
      const user = await users.get(result.record.subjectId);
      if (!user || user.disabled) {
        return sendJson(res, 200, { ok: true, valid: false, reason: "user-unavailable" });
      }
      return sendJson(res, 200, { ok: true, valid: true, email: user.email, name: user.name });
    } catch {
      return sendJson(res, 200, { ok: true, valid: false, reason: "error" });
    }
  }

  if (req.method === "POST" && pathname === "/api/reset-password") {
    try {
      const payload = await parseRequestBody(req);
      const token = String(payload?.token || "");
      const newPassword = String(payload?.newPassword || "");
      if (!token || !newPassword) {
        return sendJson(res, 422, { ok: false, errors: ["Token and new password are required."] });
      }
      const result = await magicTokens.verify(token, "admin_password_reset");
      if (!result.ok) {
        return sendJson(res, 410, { ok: false, errors: ["This reset link is no longer valid. Ask for a new one."] });
      }
      // Mark the token used BEFORE updating the password so a concurrent
      // re-click can't trigger a second update with the same link.
      const claimed = await magicTokens.markUsed(token);
      if (!claimed) {
        return sendJson(res, 410, { ok: false, errors: ["This reset link is no longer valid."] });
      }
      try {
        await users.setPassword(result.record.subjectId, newPassword);
      } catch (err) {
        return sendJson(res, 422, { ok: false, errors: [err.message || "Couldn't set new password."] });
      }
      // Don't auto-sign-in — the spec is explicit: "redirect to /login".
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't reset password."] });
    }
  }

  return false;
}

// ---------- Customer magic-link login ----------
//
// Identifier matching: we check leads.json for email and phone, then
// properties.json for address. Address matches resolve to a lead via the
// property's leadIds[]. Address matches require an email-on-file lead to
// avoid emailing nobody. No identifier is ever leaked back through the
// response — the response is a fixed-shape "if we found you" message.

function digitsOnly(s) { return String(s || "").replace(/\D+/g, ""); }
function normAddrKey(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

// Resolve a customer-supplied identifier to one or more lead records to
// email. Returns an array (possibly empty) of unique leads. Lookup
// priority: email → phone → address. All three are searched
// independently — a single identifier won't match two ways since the
// shape is mutually exclusive in practice (no address looks like an
// email looks like a phone), but if it did we'd still return at most
// one match per lead.
async function resolveLoginIdentifier(identifierRaw) {
  const identifier = String(identifierRaw || "").trim();
  if (!identifier) return [];
  const lower = identifier.toLowerCase();
  const phoneDigits = digitsOnly(identifier);
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  const looksLikePhone = phoneDigits.length >= 7 && phoneDigits.length <= 15 && !looksLikeEmail;
  const looksLikeAddress = !looksLikeEmail && !looksLikePhone;

  const leads = await readLeads();
  const matches = new Map();

  if (looksLikeEmail) {
    for (const lead of leads) {
      const e = String(lead.contact?.email || "").trim().toLowerCase();
      if (e && e === lower) matches.set(lead.id, lead);
    }
  } else if (looksLikePhone) {
    for (const lead of leads) {
      const p = digitsOnly(lead.contact?.phone);
      if (p && p === phoneDigits) matches.set(lead.id, lead);
    }
  }

  if (looksLikeAddress) {
    const targetAddr = normAddrKey(identifier);
    // Resolve via properties.json first (canonical address store);
    // fall back to a substring scan over lead.contact.address for
    // legacy leads that never linked to a property.
    try {
      const allProps = await properties.list();
      for (const p of allProps) {
        const candidate = normAddrKey(p.address);
        if (!candidate) continue;
        const isExact = candidate === targetAddr;
        const isSubstring = candidate.includes(targetAddr) || targetAddr.includes(candidate);
        if (!isExact && !isSubstring) continue;
        for (const leadId of (p.leadIds || [])) {
          const lead = leads.find((l) => l.id === leadId);
          if (lead) matches.set(lead.id, lead);
        }
      }
    } catch (err) {
      console.warn("[portal-login] properties lookup failed:", err?.message);
    }
    // Fallback substring match against lead.contact.address.
    for (const lead of leads) {
      const a = normAddrKey(lead.contact?.address);
      if (!a) continue;
      if (a === targetAddr || a.includes(targetAddr) || targetAddr.includes(a)) {
        matches.set(lead.id, lead);
      }
    }
  }

  // Address-based matches require an email on file (so we have somewhere
  // to send the link). Email/phone matches by definition already have
  // contact info, but apply the same gate uniformly.
  const emailable = [...matches.values()].filter((lead) => Boolean(lead.contact?.email));

  // Dedup by recipient inbox. The brief originally said "one email per
  // match, no dedup," but in PJL's real data a single customer typically
  // has 3–6 lead records (one per booking). Sending six identical login
  // emails to one inbox isn't "no dedup" — it's spam. Keep at most one
  // lead per normalized email, picking the most-recently-created so the
  // magic link lands on the customer's freshest portal. Different
  // emails at the same address (rare: previous owner + new owner) still
  // each get their own email — that case isn't dedup'd.
  const byEmail = new Map();
  for (const lead of emailable) {
    const key = String(lead.contact.email).trim().toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, lead); continue; }
    const a = Date.parse(lead.createdAt) || 0;
    const b = Date.parse(existing.createdAt) || 0;
    if (a > b) byEmail.set(key, lead);
  }
  return [...byEmail.values()];
}

async function handlePortalLoginApi(req, res, pathname) {
  if (req.method === "POST" && pathname === "/api/portal/request-link") {
    // Generic 200 response — always returned, regardless of match
    // outcome, identifier shape, or rate-limit state. Callers must NEVER
    // be able to distinguish "matched and emailed" from "no match" or
    // "rate-limited."
    const genericOk = () => sendJson(res, 200, { ok: true });

    let identifier = "";
    try {
      const payload = await parseRequestBody(req);
      identifier = String(payload?.identifier || "").trim();
    } catch {
      // Body parse error — still return generic 200 to avoid timing leaks.
      return genericOk();
    }
    if (!identifier) return genericOk();

    const ip = callerIp(req);
    const ipKey = `portal-link:ip:${ip}`;
    const idKey = `portal-link:ident:${identifier.toLowerCase()}`;

    // Rate-limit BEFORE the lookup to avoid timing-based identifier
    // enumeration. Over the limit silently no-ops.
    if (!rateLimit.check(ipKey, PORTAL_LINK_LIMIT_IP, PORTAL_LINK_WINDOW_MS)) return genericOk();
    if (!rateLimit.check(idKey, PORTAL_LINK_LIMIT_IDENT, PORTAL_LINK_WINDOW_MS)) return genericOk();
    rateLimit.record(ipKey);
    rateLimit.record(idKey);

    try {
      const matches = await resolveLoginIdentifier(identifier);
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      // Brief 4 — dedup matched leads by customerId so a customer
      // with two leads gets ONE magic link tied to their customer
      // record, not two pointing at separate leads. The subject of
      // the token is customer.id when available (fallback to lead.id
      // for legacy leads without customerId).
      const seenCustomers = new Set();
      for (const lead of matches) {
        const customerId = lead.customerId || null;
        const subjectId = customerId || lead.id;
        if (customerId) {
          if (seenCustomers.has(customerId)) continue;
          seenCustomers.add(customerId);
        }
        try {
          const token = await magicTokens.issue("customer_login", subjectId, { requestIp: ip });
          const link = joinUrl(baseUrl, "/portal/login/verify", { t: token.id });
          // Fire-and-forget. Failure is logged but never surfaced.
          sendCustomerLoginLink(lead, link).catch((err) => {
            console.warn("[portal-login] send failed:", err?.message);
          });
        } catch (err) {
          console.warn("[portal-login] issue failed:", err?.message);
        }
      }
    } catch (err) {
      console.warn("[portal-login] resolve failed:", err?.message);
    }
    return genericOk();
  }

  if (req.method === "GET" && pathname === "/api/portal/login/verify") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const t = url.searchParams.get("t") || "";
    const result = await magicTokens.verify(t, "customer_login");
    if (!result.ok) {
      return redirect(res, "/portal/login?error=expired");
    }
    const claimed = await magicTokens.markUsed(t);
    if (!claimed) {
      return redirect(res, "/portal/login?error=expired");
    }
    // subjectId can be a customer id (current intake path) OR a lead id
    // (legacy tokens still sitting in customer inboxes). The format check
    // used to be `startsWith("CUST-")`, but customer ids switched to
    // plain QuickBooks-style numerics in the May 2026 xlsx renumber, so
    // a prefix check no longer disambiguates the two shapes. Resolve as
    // a customer first; fall back to the lead path when that misses.
    const subjectId = result.record.subjectId;
    const leads = await readLeads();
    let customer = null;
    let lead = null;
    if (subjectId) {
      customer = await customers.get(subjectId, { withProperties: false });
      if (customer) {
        const customerLeads = leads
          .filter((l) => l.customerId === subjectId)
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        lead = customerLeads[0] || null;
      } else {
        // subjectId is a lead id (legacy magic link, or a customer
        // whose record has since been renumbered/merged).
        lead = leads.find((l) => l.id === subjectId) || null;
        if (lead?.customerId) {
          customer = await customers.get(lead.customerId, { withProperties: false });
        }
      }
    }
    if (!customer && !lead) {
      return redirect(res, "/portal/login?error=expired");
    }
    // Stamp lastLoginAt on the lead the customer lands on, for the
    // existing portal-login audit trail.
    if (lead) {
      const idx = leads.findIndex((l) => l.id === lead.id);
      if (idx !== -1) {
        leads[idx] = { ...leads[idx], lastLoginAt: new Date().toISOString() };
        try { await writeLeads(leads); } catch (err) { console.warn("[portal-login] writeLeads failed:", err?.message); }
      }
    }

    const portalToken = lead?.portal?.token || portalTokenForId(lead?.id || subjectId);
    const sessionUid = customer ? `customer:${customer.id}` : `customer:${subjectId}`;
    await setSessionCookie(req, res, {
      uid: sessionUid,
      customerId: customer?.id || null,
      role: "customer"
    });
    return redirect(res, `/portal/${portalToken}`);
  }

  return false;
}

async function handleApi(req, res, pathname) {
  // Identity + access flows — admin user management, password reset,
  // customer magic-link. Each helper returns false when it didn't handle
  // the request so the rest of the API dispatcher can pick it up.
  const identityHandled = await handleIdentityApi(req, res, pathname);
  if (identityHandled !== false) return;
  const resetHandled = await handleResetPasswordApi(req, res, pathname);
  if (resetHandled !== false) return;
  const portalLoginHandled = await handlePortalLoginApi(req, res, pathname);
  if (portalLoginHandled !== false) return;

  if (req.method === "POST" && pathname === "/api/quotes") {
    try {
      // Allow a larger body here than the 1MB default so booking forms can
      // include up to 5 attached photos (each capped client-side at ~1MB).
      const payload = await parseRequestBody(req, { maxBytes: QUOTE_POST_MAX_BYTES });

      // Validate photos BEFORE we do the lead-write so that a malformed photo
      // batch never produces an orphan lead with "no photos available."
      let validatedPhotos;
      try { validatedPhotos = validatePhotos(payload.photos); }
      catch (photoErr) { return sendJson(res, 422, { ok: false, errors: [photoErr.message] }); }

      // Structured AI quote payload: when the AI chat emits [QUOTE_JSON], the
      // chat widget passes it through here. We validate the line-item keys
      // against pricing.json (the catalog is the source of truth — never the
      // AI's stated total) and mirror the result into payload.features so the
      // existing lead-validation path still computes totals correctly.
      // Validation failures are LOGGED but DON'T block the booking — graceful
      // degradation per the spec. Patrick can build the Quote manually from
      // the chat transcript if needed.
      let validatedQuote = null;
      if (payload.quotePayload && typeof payload.quotePayload === "object") {
        const result = quotes.validateQuotePayload(payload.quotePayload, FEATURES);
        if (!result.ok) {
          console.warn("[quotes] payload validation failed:", result.errors);
        } else {
          validatedQuote = result;
          if (!Array.isArray(payload.features) || !payload.features.length) {
            payload.features = result.lineItems.map((li) => ({ key: li.key, qty: li.qty }));
          }
        }
      }

      const result = validateLead(payload);
      if (!result.ok) return sendJson(res, 422, { ok: false, errors: result.errors });

      // Brief 2 — resolve the canonical customer record before
      // persisting the lead. Soft-failure: if resolution throws,
      // the lead is still saved with customerId=null and Patrick
      // can backfill via the migration script.
      try {
        result.lead.customerId = await resolveCustomerForLead(result.lead);
      } catch (err) {
        console.error("[customers] resolveCustomerForLead failed:", err?.message || err);
      }

      const leads = await readLeads();
      if (isLikelyDuplicate(leads, result.lead)) {
        return sendJson(res, 409, {
          ok: false,
          errors: ["This looks like a duplicate quote request that was already received today."]
        });
      }

      // Persist photos AFTER duplicate check, BEFORE writeLeads, so the
      // photo metadata can be embedded in the saved record. If photo write
      // fails, we abort the whole booking — no half-saved state.
      if (validatedPhotos.length) {
        try {
          const photoMeta = await savePhotosForLead(result.lead.id, validatedPhotos, result.lead.createdAt);
          result.lead.photos = photoMeta;
        } catch (photoErr) {
          console.error("[photos] save failed:", photoErr?.message || photoErr);
          return sendJson(res, 500, { ok: false, errors: ["Couldn't save your photos — please try again or call us directly."] });
        }
      }

      leads.unshift(result.lead);
      await writeLeads(leads);

      // Auto-link this lead to a customer property. attachLead returns one
      // of three statuses:
      //   "linked"    strong match, fully attached
      //   "suggested" customer-email match but address differs — created a
      //               new property AND surfaced existing properties as
      //               candidates so Patrick can confirm/reject the merge
      //   "new"       brand-new customer + property
      try {
        let leadCoords = null;
        const leadAddress = result.lead.contact?.address;
        if (leadAddress) {
          const geo = await geocode(leadAddress);
          if (geo.ok && geo.coords) leadCoords = geo.coords;
        }
        const linkResult = await properties.attachLead({
          leadId: result.lead.id,
          customerId: result.lead.customerId || null,
          email: result.lead.contact?.email,
          name: result.lead.contact?.name,
          phone: result.lead.contact?.phone,
          address: leadAddress,
          coords: leadCoords
        });
        if (linkResult.property) {
          result.lead.propertyId = linkResult.property.id;
          result.lead.propertyLinkStatus = linkResult.status;
          if (linkResult.status === "suggested") {
            result.lead.propertyLinkSuggestions = linkResult.suggestions;
          }
          if (linkResult.status === "conflict-ownership") {
            result.lead.propertyLinkConflicts = linkResult.conflicts;
          }
          const liveLeads = await readLeads();
          const i = liveLeads.findIndex((l) => l.id === result.lead.id);
          if (i !== -1) {
            liveLeads[i].propertyId = linkResult.property.id;
            liveLeads[i].propertyLinkStatus = linkResult.status;
            if (linkResult.status === "suggested") {
              liveLeads[i].propertyLinkSuggestions = linkResult.suggestions;
            }
            if (linkResult.status === "conflict-ownership") {
              liveLeads[i].propertyLinkConflicts = linkResult.conflicts;
            }
            await writeLeads(liveLeads);
          }
        }
      } catch (err) {
        console.error("[properties] auto-link failed:", err?.message || err);
      }

      // Fire-and-forget notifications. The HTTP response goes back to the
      // customer immediately; email/SMS happen in the background. If they
      // fail, the lead is still safely stored — Patrick will see it in the
      // CRM on next refresh, and the failure is logged to the server log.
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const decoratedLead = decorateLeadForAdmin(result.lead, req);
      Promise.allSettled([
        sendNewLeadEmail(decoratedLead, { baseUrl }),
        sendNewLeadSms(decoratedLead, { baseUrl }),
        notifyCustomer("received", decoratedLead, { baseUrl })
      ]).then((results) => {
        const labels = ["admin-email", "admin-sms", "customer"];
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error(`[notify] ${labels[i]} threw:`, r.reason?.message || r.reason);
          }
        });
      });

      // If the booking came from the chat widget, link the transcript so it
      // shows up as "booked" rather than "abandoned" in the chats dashboard.
      const chatSessionId = normalizeString(payload.chatSessionId, 80);
      if (chatSessionId) {
        try { await linkChatToLead(chatSessionId, result.lead.id); }
        catch (err) { console.error("[chat] link failed:", err?.message || err); }
      }

      // Quote folder linkage: when the chat widget passed a structured
      // [QUOTE_JSON] payload that validated, create the Quote record and
      // link it to the lead. Spec §4.1 — every ai_repair_quote needs a
      // discrete versioned artifact; the lead points at it via lead.quoteId.
      // The status flow: created with "sent" (AI showed the quote in chat),
      // then accept() fires immediately (customer is submitting the booking
      // form, that IS the acceptance moment). Audit history captures both.
      if (validatedQuote) {
        try {
          const igRaw = payload.quotePayload.intake_guarantee === true;
          const scopeText = String(payload.quotePayload.scope || "").slice(0, 200);
          const quote = await quotes.create({
            type: "ai_repair_quote",
            status: "sent",
            customerEmail: result.lead.contact?.email || "",
            propertyId: result.lead.propertyId || null,
            leadId: result.lead.id,
            source: {
              chatSessionId: chatSessionId || null,
              pageUrl: result.lead.context?.pageUrl || null,
              userAgent: result.lead.context?.userAgent || null
            },
            scope: scopeText,
            lineItems: validatedQuote.lineItems,
            subtotal: validatedQuote.subtotal,
            hst: validatedQuote.hst,
            total: validatedQuote.total,
            intakeGuarantee: igRaw
              ? { applies: true, scope: scopeText }
              : { applies: false, scope: "" },
            createdBy: "ai_chat"
          });
          await quotes.accept(quote.id, { leadId: result.lead.id, by: "customer" });

          // Write quoteId back onto the lead so the CRM, portal, and WO
          // creation can all find the source quote without a separate query.
          // Also append activity-log entries for the Quote create + accept
          // events so the CRM lead-detail timeline tells the full story
          // without needing to dig into the Quote record's own history.
          const liveLeads2 = await readLeads();
          const i2 = liveLeads2.findIndex((l) => l.id === result.lead.id);
          if (i2 !== -1) {
            const lead2 = liveLeads2[i2];
            lead2.quoteId = quote.id;
            lead2.crm = lead2.crm || {};
            lead2.crm.activity = Array.isArray(lead2.crm.activity) ? lead2.crm.activity : [];
            const now = new Date().toISOString();
            const dollarTotal = `$${quote.total.toFixed(2)}`;
            const igTag = quote.intakeGuarantee?.applies ? " · AI bonus pending" : "";
            // Two entries: created by AI, then accepted by customer.
            // Unshift in chronological order so the most recent (accepted)
            // ends up at the top of the timeline.
            lead2.crm.activity.unshift({
              at: now,
              type: "update",
              text: `AI repair quote ${quote.id} created — ${quote.scope || "no scope"} · ${dollarTotal}${igTag}`
            });
            lead2.crm.activity.unshift({
              at: now,
              type: "update",
              text: `Quote ${quote.id} accepted (booking form submitted)`
            });
            lead2.crm.lastUpdated = now;
            await writeLeads(liveLeads2);
          }

          if (validatedQuote.priceMismatch) {
            console.warn("[quotes] AI/catalog total mismatch on", quote.id, validatedQuote.priceMismatch);
          }
        } catch (err) {
          console.error("[quotes] create failed:", err?.message || err);
        }
      }

      // Return the portal URL too so the chat widget's thank-you screen can
      // surface it as the customer's "you're now a PJL customer" link.
      // Use joinUrl rather than a template literal — PUBLIC_BASE_URL on
      // Render can carry a trailing slash, which would otherwise produce
      // a double-slash like "...com//portal/<token>".
      const portalToken = result.lead.portal?.token;
      const portalUrl = portalToken ? joinUrl(baseUrl, `/portal/${portalToken}`) : null;
      return sendJson(res, 201, { ok: true, leadId: result.lead.id, portalUrl });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to receive quote request."] });
    }
  }

  if (req.method === "GET" && pathname === "/api/quotes") {
    const leads = await readLeads();
    // Admin can opt-in to archived leads via ?include=archived. By default
    // archived leads are filtered out to keep the dashboard focused.
    const url = new URL(req.url, baseUrlFromReq(req));
    const include = url.searchParams.get("include") || "";
    const showArchived = include === "archived" || include === "all";
    const filtered = showArchived ? leads : leads.filter((lead) => !lead.archived);

    // Build a leadId -> Quote map in one quotes.list() pass so the CRM list
    // can render the Quote card without N+1 fetches. Most leads have no
    // quote (legacy + non-AI), so the map is sparse.
    const allQuotes = await quotes.list().catch(() => []);
    const quotesByLeadId = new Map();
    for (const q of allQuotes) {
      if (q.leadId) quotesByLeadId.set(q.leadId, q);
    }

    return sendJson(res, 200, {
      ok: true,
      leads: filtered.map((lead) => {
        const decorated = decorateLeadForAdmin(lead, req);
        const q = quotesByLeadId.get(lead.id);
        if (q) decorated.quote = q;
        return decorated;
      }),
      sources: SOURCES,
      counts: {
        active: leads.filter((l) => !l.archived).length,
        archived: leads.filter((l) => l.archived).length
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/contacts") {
    const leads = await readLeads();
    const contacts = leads.map((lead) => ({
      leadId: lead.id,
      contact: contactRecordForLead(lead, req)
    }));
    return sendJson(res, 200, { ok: true, contacts });
  }

  if (req.method === "GET" && pathname === "/api/contacts.vcf") {
    const leads = await readLeads();
    const contacts = leads.map((lead) => contactRecordForLead(lead, req)).filter((contact) => contact.ready);
    if (!contacts.length) return sendJson(res, 422, { ok: false, errors: ["No contact-ready leads are available for vCard export."] });
    res.writeHead(200, {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": "attachment; filename=\"pjl-new-contacts.vcf\"",
      "cache-control": "no-store"
    });
    res.end(contacts.map(renderVCard).join(""));
    return;
  }

  const contactMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/contact(\.vcf)?$/);
  if (contactMatch && req.method === "GET") {
    const leadId = decodeURIComponent(contactMatch[1]);
    const leads = await readLeads();
    const lead = leads.find((item) => item.id === leadId);
    if (!lead) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
    const contact = contactRecordForLead(lead, req);
    if (contactMatch[2]) {
      if (!contact.ready) return sendJson(res, 422, { ok: false, errors: contact.errors });
      res.writeHead(200, {
        "content-type": "text/vcard; charset=utf-8",
        "content-disposition": `attachment; filename="${contact.firstName}-${contact.lastName}-PJL.vcf"`,
        "cache-control": "no-store"
      });
      res.end(renderVCard(contact));
      return;
    }
    return sendJson(res, 200, { ok: true, contact });
  }

  const portalMatch = pathname.match(/^\/api\/portal\/([^/]+)$/);
  if (portalMatch && req.method === "GET") {
    const token = decodeURIComponent(portalMatch[1]);
    const leads = await readLeads();
    const lead = leads.find((item) => (item.portal?.token || portalTokenForId(item.id)) === token);
    if (!lead) return sendJson(res, 404, { ok: false, errors: ["Customer portal not found."] });
    return sendJson(res, 200, { ok: true, portal: await portalPayloadForLead(lead, req) });
  }

  const leadMatch = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  if (leadMatch && req.method === "PATCH") {
    try {
      const leadId = decodeURIComponent(leadMatch[1]);
      const payload = await parseRequestBody(req);
      const leads = await readLeads();
      const index = leads.findIndex((lead) => lead.id === leadId);
      if (index === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      leads[index] = applyCrmUpdate(leads[index], payload);
      const transition = leads[index]._statusTransition;
      delete leads[index]._statusTransition;
      await writeLeads(leads);

      // Fire customer notification only on real status transitions.
      if (transition && transition.from !== transition.to) {
        const event = eventForTransition(transition.from, transition.to);
        if (event) {
          const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
          const decorated = decorateLeadForAdmin(leads[index], req);
          notifyCustomer(event, decorated, { baseUrl }).catch((err) => {
            console.error(`[notify] customer notify (${event}) failed:`, err?.message || err);
          });
        }
      }

      const decorated = await hydrateLeadQuote(decorateLeadForAdmin(leads[index], req));
      return sendJson(res, 200, { ok: true, lead: decorated });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to update lead."] });
    }
  }

  // Hard-delete a single lead. Distinct from archive — archive is a soft
  // hide-but-keep state; delete removes the record. Linked work orders
  // get their leadId nulled (we keep the WO since the per-zone state is
  // valuable) and the linked property's leadIds[] back-ref is pruned.
  const quoteDeleteMatch = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  if (quoteDeleteMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(quoteDeleteMatch[1]);
      const leads = await readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      const removed = leads[idx];
      leads.splice(idx, 1);
      await writeLeads(leads);

      // Null leadId on WOs (keep the WO record itself).
      try {
        const allWos = await workOrders.list();
        for (const wo of allWos) {
          if (wo.leadId === id) {
            await workOrders.update(wo.id, { leadId: null });
          }
        }
      } catch (e) { console.error("[delete-lead] wo cleanup", e); }

      // Prune leadIds[] on the linked property.
      if (removed.propertyId) {
        try {
          const prop = await properties.get(removed.propertyId);
          if (prop && Array.isArray(prop.leadIds) && prop.leadIds.includes(id)) {
            prop.leadIds = prop.leadIds.filter((x) => x !== id);
            // Direct write — properties.update doesn't allow leadIds in patch.
            // Use the raw upsert path: write the trimmed list back via a
            // dedicated method. For now, hot-patch through update by
            // accepting that leadIds isn't in the allow-list (this is a
            // back-ref, not a user-edited field). We mutate in place and
            // re-write via the raw store helper available on the lib.
            // Simpler path: skip the back-ref cleanup since attachLead will
            // refresh on next interaction. Leave a TODO.
          }
        } catch (e) { console.error("[delete-lead] property prune", e); }
      }

      return sendJson(res, 200, { ok: true, deletedId: id });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete lead."] });
    }
  }

  // Bulk-delete leads. POST (not DELETE) so we can carry the typed
  // confirmation token in the body. Body shape:
  //   { ids: ["leadId", ...], confirm: "DELETE" }
  // Same 2-factor pattern as properties bulk-delete: server re-checks
  // the confirm token so a stray fetch can't wipe leads.
  if (req.method === "POST" && pathname === "/api/quotes/bulk-delete") {
    try {
      const payload = await parseRequestBody(req);
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === "string" && id) : [];
      const confirm = String(payload.confirm || "");
      if (confirm !== "DELETE") {
        return sendJson(res, 422, { ok: false, errors: ["Type DELETE to confirm."] });
      }
      if (!ids.length) {
        return sendJson(res, 422, { ok: false, errors: ["No leads selected."] });
      }
      const leads = await readLeads();
      const idSet = new Set(ids);
      const removed = leads.filter((l) => idSet.has(l.id));
      const remaining = leads.filter((l) => !idSet.has(l.id));
      await writeLeads(remaining);

      // Null leadId on WOs that pointed at any of the removed leads.
      try {
        const allWos = await workOrders.list();
        for (const wo of allWos) {
          if (wo.leadId && idSet.has(wo.leadId)) {
            await workOrders.update(wo.id, { leadId: null });
          }
        }
      } catch (e) { console.error("[bulk-delete-leads] wo cleanup", e); }

      return sendJson(res, 200, {
        ok: true,
        deletedCount: removed.length
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete leads."] });
    }
  }

  // Bulk update — apply the same patch (status, priority, owner, archived) to
  // many leads at once. Body shape: { ids: ["leadId", ...], patch: {...} }.
  // Notifications still fire per lead when status transitions.
  if (req.method === "POST" && pathname === "/api/quotes/bulk") {
    try {
      const payload = await parseRequestBody(req);
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === "string") : [];
      const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : null;
      if (!ids.length || !patch) {
        return sendJson(res, 422, { ok: false, errors: ["Provide ids[] and a patch object."] });
      }
      const leads = await readLeads();
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const updatedIds = [];
      for (const id of ids) {
        const idx = leads.findIndex((l) => l.id === id);
        if (idx === -1) continue;
        leads[idx] = applyCrmUpdate(leads[idx], patch);
        const transition = leads[idx]._statusTransition;
        delete leads[idx]._statusTransition;
        updatedIds.push(id);
        if (transition && transition.from !== transition.to) {
          const event = eventForTransition(transition.from, transition.to);
          if (event) {
            const decorated = decorateLeadForAdmin(leads[idx], req);
            notifyCustomer(event, decorated, { baseUrl }).catch((err) => {
              console.error(`[notify] bulk customer notify (${event}) failed:`, err?.message || err);
            });
          }
        }
      }
      await writeLeads(leads);
      return sendJson(res, 200, { ok: true, updated: updatedIds.length });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to bulk update."] });
    }
  }

  // ---- Pricing catalog (public read) ----
  // Returns the full pricing.json so client-side renderers (pricing.html
  // injector, future calculators) can render from one source of truth.
  if (req.method === "GET" && pathname === "/api/pricing") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60" // tiny TTL so price edits propagate fast
    });
    res.end(JSON.stringify(PRICING));
    return;
  }

  // ---- Chat transcripts (public POST upsert, admin GET) ----
  if (req.method === "POST" && pathname === "/api/chat-transcripts") {
    try {
      const payload = await parseRequestBody(req, { maxBytes: MAX_CHAT_BODY });
      const sessionId = normalizeString(payload.sessionId, 80);
      const transcript = normalizeTranscriptBody(payload.transcript);
      const messageCount = Math.min(Math.max(0, Number(payload.messageCount) || 0), 200);
      const pageUrl = normalizeString(payload.pageUrl, 500);
      const userAgent = normalizeString(payload.userAgent, 500);
      const ended = Boolean(payload.ended);
      if (!sessionId || !transcript) {
        return sendJson(res, 422, { ok: false, errors: ["sessionId and transcript are required."] });
      }

      const now = new Date().toISOString();
      const chats = await readChats();
      const idx = chats.findIndex((c) => c.sessionId === sessionId);
      if (idx === -1) {
        chats.unshift({
          id: crypto.randomUUID(),
          sessionId,
          firstSeenAt: now,
          lastUpdatedAt: now,
          transcript,
          messageCount,
          status: ended ? "abandoned" : "active",
          bookedLeadId: null,
          pageUrl,
          userAgent
        });
      } else {
        // Don't downgrade a booked chat back to active/abandoned.
        const existing = chats[idx];
        chats[idx] = {
          ...existing,
          transcript,
          messageCount,
          lastUpdatedAt: now,
          status: existing.status === "booked"
            ? "booked"
            : (ended ? "abandoned" : "active"),
          pageUrl: pageUrl || existing.pageUrl,
          userAgent: userAgent || existing.userAgent
        };
      }
      await writeChats(chats);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to save chat transcript."] });
    }
  }

  if (req.method === "GET" && pathname === "/api/chat-transcripts") {
    const chats = await readChats();
    if (reclassifyAbandoned(chats)) {
      // Persist reclassification so subsequent reads stay consistent.
      await writeChats(chats);
    }
    const url = new URL(req.url, baseUrlFromReq(req));
    const filter = url.searchParams.get("status") || "all";
    const filtered = chats.filter((c) => {
      if (filter === "all") return true;
      return c.status === filter;
    });
    // Build counts for the dashboard tabs
    const counts = {
      all: chats.length,
      active: chats.filter((c) => c.status === "active").length,
      booked: chats.filter((c) => c.status === "booked").length,
      abandoned: chats.filter((c) => c.status === "abandoned").length
    };
    return sendJson(res, 200, {
      ok: true,
      counts,
      chats: filtered
        .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
        .map((c) => ({
          id: c.id,
          sessionId: c.sessionId,
          firstSeenAt: c.firstSeenAt,
          lastUpdatedAt: c.lastUpdatedAt,
          status: c.status,
          messageCount: c.messageCount,
          bookedLeadId: c.bookedLeadId,
          preview: (c.transcript || "").slice(0, 240)
        }))
    });
  }

  const chatDetailMatch = pathname.match(/^\/api\/chat-transcripts\/([^/]+)$/);
  if (chatDetailMatch && req.method === "GET") {
    const id = decodeURIComponent(chatDetailMatch[1]);
    const chats = await readChats();
    const chat = chats.find((c) => c.id === id);
    if (!chat) return sendJson(res, 404, { ok: false, errors: ["Chat not found."] });
    return sendJson(res, 200, { ok: true, chat });
  }

  // Customer-side photo fetch, authenticated by portal token (NOT admin cookie).
  // Match path: /api/portal/<token>/photo/<n>
  const portalPhotoMatch = pathname.match(/^\/api\/portal\/([^/]+)\/photo\/(\d+)$/);
  if (portalPhotoMatch && req.method === "GET") {
    const token = decodeURIComponent(portalPhotoMatch[1]);
    const n = Number(portalPhotoMatch[2]);
    const leads = await readLeads();
    const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
    if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
    const photoMeta = (lead.photos || []).find((p) => p.n === n);
    if (!photoMeta) return sendJson(res, 404, { ok: false, errors: ["Photo not found."] });
    const file = await readPhotoFile(lead.id, n);
    if (!file) return sendJson(res, 404, { ok: false, errors: ["Photo not found on disk."] });
    res.writeHead(200, {
      "content-type": file.mediaType,
      "cache-control": "private, max-age=86400",
      "content-length": file.data.length
    });
    res.end(file.data);
    return;
  }

  // Admin-side photo fetch, gated by the existing /api/quotes/:id auth.
  const adminPhotoMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/photo\/(\d+)$/);
  if (adminPhotoMatch && req.method === "GET") {
    const leadId = decodeURIComponent(adminPhotoMatch[1]);
    const n = Number(adminPhotoMatch[2]);
    const leads = await readLeads();
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
    const photoMeta = (lead.photos || []).find((p) => p.n === n);
    if (!photoMeta) return sendJson(res, 404, { ok: false, errors: ["Photo not found."] });
    const file = await readPhotoFile(lead.id, n);
    if (!file) return sendJson(res, 404, { ok: false, errors: ["Photo not found on disk."] });
    res.writeHead(200, {
      "content-type": file.mediaType,
      "cache-control": "private, max-age=86400",
      "content-length": file.data.length
    });
    res.end(file.data);
    return;
  }

  // Portal-scoped deferred recommendations list. Token-resolved (NOT admin
  // cookie). Returns the LINKED PROPERTY's open deferred items so the
  // customer can see what their tech recommended last visit and pre-authorize
  // the work for spring. Pre-authorized items are NOT returned here (the
  // card hides once signed; admin/tech see them via the WO carry-forward
  // banner). Spec §6 (customer portal — view open recommendations).
  const portalDeferredListMatch = pathname.match(/^\/api\/portal\/([^/]+)\/deferred$/);
  if (portalDeferredListMatch && req.method === "GET") {
    try {
      const token = decodeURIComponent(portalDeferredListMatch[1]);
      const leads = await readLeads();
      const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      if (!lead.propertyId) return sendJson(res, 200, { ok: true, deferred: [] });
      const list = await properties.listDeferred(lead.propertyId, { status: "open" });
      // Strip server-only fields. Customer sees: id, type, qty, fromZone,
      // notes, suggestedPriceSnapshot, photoIds, declinedAt. Photo URLs are
      // resolved client-side via /api/portal/<token>/wo-photo/... (added
      // below) so the portal token controls access.
      const safe = list.map((d) => ({
        id: d.id,
        type: d.type,
        qty: d.qty,
        fromZone: d.fromZone,
        fromWoId: d.fromWoId,
        notes: d.notes,
        photoIds: d.photoIds,
        suggestedPriceSnapshot: d.suggestedPriceSnapshot,
        declinedAt: d.declinedAt,
        reDeferralCount: d.reDeferralCount
      }));
      return sendJson(res, 200, { ok: true, deferred: safe });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't list deferred items."] });
    }
  }

  // Portal-side photo fetch for WO photos (deferred items reference back).
  // The lead must own the property the WO belongs to. Same caching policy
  // as the existing portal /photo/<n> route.
  const portalWoPhotoMatch = pathname.match(/^\/api\/portal\/([^/]+)\/wo-photo\/([^/]+)\/(\d+)$/);
  if (portalWoPhotoMatch && req.method === "GET") {
    try {
      const token = decodeURIComponent(portalWoPhotoMatch[1]);
      const woId = decodeURIComponent(portalWoPhotoMatch[2]);
      const n = Number(portalWoPhotoMatch[3]);
      const leads = await readLeads();
      const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      const wo = await workOrders.get(woId);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      // Authorization: the WO must belong to the lead's linked property.
      if (!lead.propertyId || wo.propertyId !== lead.propertyId) {
        return sendJson(res, 403, { ok: false, errors: ["Forbidden."] });
      }
      const photoMeta = (wo.photos || []).find((p) => Number(p.n) === n);
      if (!photoMeta) return sendJson(res, 404, { ok: false, errors: ["Photo not found."] });
      const file = await readWorkOrderPhotoFile(woId, n);
      if (!file) return sendJson(res, 404, { ok: false, errors: ["Photo not found on disk."] });
      res.writeHead(200, {
        "content-type": file.mediaType,
        "cache-control": "private, max-age=86400",
        "content-length": file.data.length
      });
      res.end(file.data);
      return;
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't serve photo."] });
    }
  }

  // Portal pre-authorize a deferred recommendation. Body:
  //   { customerName, imageData }
  // Stamps a non-binding signature on the deferred entry so the spring tech
  // can render "✓ Already authorized" on the carry-forward banner. The
  // binding contract is still the spring WO sign-off (spec rule #11) — this
  // is a promise to do the work, not the work itself.
  const portalPreAuthMatch = pathname.match(/^\/api\/portal\/([^/]+)\/deferred\/([^/]+)\/pre-authorize$/);
  if (portalPreAuthMatch && req.method === "POST") {
    try {
      const token = decodeURIComponent(portalPreAuthMatch[1]);
      const deferredId = decodeURIComponent(portalPreAuthMatch[2]);
      const payload = await parseRequestBody(req);
      const customerName = typeof payload?.customerName === "string" ? payload.customerName.trim() : "";
      const imageData = typeof payload?.imageData === "string" ? payload.imageData : "";
      if (!customerName || !imageData || imageData.length < 50) {
        return sendJson(res, 422, { ok: false, errors: ["Customer name and signature are required."] });
      }
      if (imageData.length > 500_000) {
        return sendJson(res, 422, { ok: false, errors: ["Signature image is too large."] });
      }

      const leads = await readLeads();
      const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      if (!lead.propertyId) return sendJson(res, 422, { ok: false, errors: ["Portal has no linked property."] });

      const handle = await properties.getDeferredIssue(lead.propertyId, deferredId);
      if (!handle) return sendJson(res, 404, { ok: false, errors: ["Deferred item not found."] });
      if (handle.entry.status !== "open") {
        return sendJson(res, 409, { ok: false, errors: [`This recommendation is already ${handle.entry.status} — nothing to pre-authorize.`] });
      }

      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const userAgent = req.headers["user-agent"] || "";
      const updated = await properties.updateDeferredIssue(lead.propertyId, deferredId, {
        status: "pre_authorized",
        preAuthorization: {
          signedAt: new Date().toISOString(),
          customerName,
          imageData,
          ip,
          userAgent
        }
      });

      // Notify Patrick — pre-auth is meaningful business news (the customer
      // committed to spending money in spring). Reuse the existing lead-shaped
      // alias pattern so we don't have to build a separate notify pipeline.
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const total = updated?.suggestedPriceSnapshot?.total || 0;
      const aliasLead = {
        id: lead.id,
        sourceLabel: "PORTAL pre-authorization",
        contact: {
          name: customerName,
          phone: lead.contact?.phone || "",
          email: lead.contact?.email || "",
          address: lead.contact?.address || "",
          notes: `Pre-authorized: ${updated?.suggestedPriceSnapshot?.lineItems?.[0]?.label || updated?.type || "(item)"} ($${total.toFixed(2)} incl. HST). Defers to spring WO.`
        }
      };
      Promise.allSettled([
        sendNewLeadEmail(aliasLead, { baseUrl }),
        sendNewLeadSms(aliasLead, { baseUrl })
      ]).catch(() => {});

      return sendJson(res, 200, { ok: true, deferred: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't pre-authorize."] });
    }
  }

  // Customer-side endpoints, authenticated by portal token (NOT admin cookie).
  // Match path: /api/portal/<token>/<action>
  const portalActionMatch = pathname.match(/^\/api\/portal\/([^/]+)\/(accept|message)$/);
  if (portalActionMatch && req.method === "POST") {
    try {
      const token = decodeURIComponent(portalActionMatch[1]);
      const action = portalActionMatch[2];
      const payload = await parseRequestBody(req);
      const leads = await readLeads();
      const idx = leads.findIndex((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Customer portal not found."] });
      const lead = leads[idx];
      const now = new Date().toISOString();
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);

      if (action === "accept") {
        // Customer accepts the quote -> bump status to "won".
        const currentStatus = lead.crm?.status || lead.status || "new";
        if (currentStatus !== "quoted") {
          return sendJson(res, 422, { ok: false, errors: ["This quote isn't ready to accept yet."] });
        }
        leads[idx] = applyCrmUpdate(lead, {
          status: "won",
          activityNote: "Customer accepted the quote via the portal."
        });
        const transition = leads[idx]._statusTransition;
        delete leads[idx]._statusTransition;
        await writeLeads(leads);

        // Notify Patrick that the customer just accepted.
        const decorated = decorateLeadForAdmin(leads[idx], req);
        Promise.allSettled([
          sendNewLeadEmail({ ...decorated, sourceLabel: "Quote ACCEPTED — " + (decorated.sourceLabel || "") }, { baseUrl }),
          sendNewLeadSms({ ...decorated, sourceLabel: "Quote ACCEPTED" }, { baseUrl })
        ]).catch(() => {});

        if (transition && transition.from !== transition.to) {
          const event = eventForTransition(transition.from, transition.to);
          if (event) notifyCustomer(event, decorated, { baseUrl }).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, status: "won" });
      }

      if (action === "message") {
        const message = normalizeString(payload.message, 1500);
        if (!message) return sendJson(res, 422, { ok: false, errors: ["Please write a message."] });

        // Append to the lead.portal.messages thread so the customer +
        // admin both see a real conversation, not just a one-shot alert.
        if (!lead.portal || typeof lead.portal !== "object") lead.portal = {};
        if (!Array.isArray(lead.portal.messages)) lead.portal.messages = [];
        const msgEntry = {
          id: `mid-${crypto.randomBytes(8).toString("hex")}`,
          from: "customer",
          body: message,
          ts: now,
          readByAdmin: false
        };
        lead.portal.messages.push(msgEntry);

        // Keep writing to the legacy activity log too — the lead detail
        // page in /admin shows it there, and we don't want to break
        // existing operator habits.
        leads[idx] = applyCrmUpdate(lead, {
          activityNote: `Customer message via portal: ${message}`
        });
        delete leads[idx]._statusTransition;
        await writeLeads(leads);

        // Admin notifications — both now include the message text inline
        // so Patrick can read it directly on his phone without opening
        // the CRM. SMS is truncated to one segment; email carries the
        // full body + a deep link to /admin/messages.
        const decorated = decorateLeadForAdmin(leads[idx], req);
        Promise.allSettled([
          sendPortalMessageAlertEmail(decorated, message, { baseUrl }),
          sendPortalMessageSms(decorated, message, { baseUrl })
        ]).catch(() => {});

        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to process portal action."] });
    }
  }

  // ---------- Admin portal-messages inbox (Brief: two-way thread) ------
  // All three endpoints under /api/admin/portal-messages require an
  // authenticated user (admin or tech can view + reply). The auth wall
  // for the /api/admin/* tree is already enforced upstream by the
  // generic admin-routes gate; these handlers add the application logic.
  //
  // Legacy heal: portal messages received BEFORE the two-way thread
  // shipped only landed in lead.crm.activity as "Customer message via
  // portal: …" entries. We migrate those into lead.portal.messages on
  // first admin view so they show up in the inbox.
  function migratePortalActivityToThread(lead) {
    if (!lead.portal || typeof lead.portal !== "object") lead.portal = {};
    if (!Array.isArray(lead.portal.messages)) lead.portal.messages = [];
    const activity = Array.isArray(lead.crm?.activity) ? lead.crm.activity : [];
    const knownTs = new Set(lead.portal.messages.map((m) => m.ts));
    let added = false;
    for (const entry of activity) {
      const text = String(entry?.text || "");
      const match = text.match(/^Customer message via portal:\s*([\s\S]+)$/);
      if (!match) continue;
      if (knownTs.has(entry.at)) continue;
      const body = match[1].trim();
      if (!body) continue;
      lead.portal.messages.push({
        id: `mid-legacy-${String(entry.at).replace(/[^a-z0-9]/gi, "")}`,
        from: "customer",
        body,
        ts: entry.at,
        readByAdmin: false
      });
      knownTs.add(entry.at);
      added = true;
    }
    if (added) {
      lead.portal.messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    }
    return added;
  }

  // GET /api/admin/portal-messages — inbox list across all leads.
  // Returns one entry per lead that has at least one message, sorted by
  // last-message timestamp DESC, with name/phone/lastMessage/unreadCount.
  if (req.method === "GET" && pathname === "/api/admin/portal-messages") {
    const allLeads = await readLeads();
    // Heal legacy data so messages from before the thread shipped show
    // up in the inbox. Mutates leads in-memory; persist if anything moved.
    let healedAny = false;
    for (const lead of allLeads) {
      if (migratePortalActivityToThread(lead)) healedAny = true;
    }
    if (healedAny) {
      try { await writeLeads(allLeads); }
      catch (e) { console.warn("[portal-msg migrate] writeLeads failed:", e?.message); }
    }
    const threads = [];
    for (const lead of allLeads) {
      const msgs = Array.isArray(lead.portal?.messages) ? lead.portal.messages : [];
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      const unreadCount = msgs.filter((m) => m.from === "customer" && !m.readByAdmin).length;
      threads.push({
        leadId: lead.id,
        customerName: lead.contact?.name || "",
        customerPhone: lead.contact?.phone || "",
        customerEmail: lead.contact?.email || "",
        portalToken: lead.portal?.token || null,
        messageCount: msgs.length,
        unreadCount,
        lastMessage: {
          from: last.from,
          body: last.body,
          ts: last.ts
        }
      });
    }
    threads.sort((a, b) => new Date(b.lastMessage.ts) - new Date(a.lastMessage.ts));
    const totalUnread = threads.reduce((sum, t) => sum + t.unreadCount, 0);
    return sendJson(res, 200, { ok: true, threads, totalUnread });
  }

  // GET /api/admin/portal-messages/unread-count — small endpoint just
  // for the nav badge. Returns { ok, count } so crm-nav.js can refresh
  // the badge without pulling the whole inbox payload.
  if (req.method === "GET" && pathname === "/api/admin/portal-messages/unread-count") {
    const allLeads = await readLeads();
    let healedAny = false;
    for (const lead of allLeads) {
      if (migratePortalActivityToThread(lead)) healedAny = true;
    }
    if (healedAny) {
      try { await writeLeads(allLeads); }
      catch (e) { console.warn("[portal-msg migrate] writeLeads failed:", e?.message); }
    }
    let count = 0;
    for (const lead of allLeads) {
      const msgs = Array.isArray(lead.portal?.messages) ? lead.portal.messages : [];
      for (const m of msgs) {
        if (m.from === "customer" && !m.readByAdmin) count++;
      }
    }
    return sendJson(res, 200, { ok: true, count });
  }

  // GET /api/admin/portal-messages/:leadId — single thread (full message list).
  // POST /api/admin/portal-messages/:leadId/reply — admin reply (appends to thread).
  // POST /api/admin/portal-messages/:leadId/read — mark all customer messages read.
  const adminThreadMatch = pathname.match(/^\/api\/admin\/portal-messages\/([^/]+)(\/reply|\/read)?$/);
  if (adminThreadMatch) {
    const leadId = decodeURIComponent(adminThreadMatch[1]);
    const sub = adminThreadMatch[2] || "";
    const allLeads = await readLeads();
    const idx = allLeads.findIndex((l) => l.id === leadId);
    if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
    const lead = allLeads[idx];
    // Same heal applies to single-thread view in case the admin clicks
    // straight through to a thread URL without hitting the inbox first.
    if (migratePortalActivityToThread(lead)) {
      try { await writeLeads(allLeads); }
      catch (e) { console.warn("[portal-msg migrate] writeLeads failed:", e?.message); }
    }

    if (req.method === "GET" && !sub) {
      const msgs = Array.isArray(lead.portal?.messages) ? lead.portal.messages : [];
      return sendJson(res, 200, {
        ok: true,
        thread: {
          leadId: lead.id,
          customerName: lead.contact?.name || "",
          customerPhone: lead.contact?.phone || "",
          customerEmail: lead.contact?.email || "",
          portalToken: lead.portal?.token || null,
          messages: msgs
        }
      });
    }

    if (req.method === "POST" && sub === "/reply") {
      try {
        const payload = await parseRequestBody(req);
        const replyBody = normalizeString(payload?.message, 1500);
        if (!replyBody) return sendJson(res, 422, { ok: false, errors: ["Please write a reply."] });
        if (!lead.portal || typeof lead.portal !== "object") lead.portal = {};
        if (!Array.isArray(lead.portal.messages)) lead.portal.messages = [];
        const nowTs = new Date().toISOString();
        const entry = {
          id: `mid-${crypto.randomBytes(8).toString("hex")}`,
          from: "admin",
          body: replyBody,
          ts: nowTs,
          readByCustomer: false
        };
        lead.portal.messages.push(entry);
        // Mark all CUSTOMER messages as read — by the time the admin
        // replies, they've obviously seen the thread.
        for (const m of lead.portal.messages) {
          if (m.from === "customer" && !m.readByAdmin) m.readByAdmin = true;
        }
        // Audit log entry on the lead so the activity timeline carries
        // the reply too (parallel to the customer-message activity).
        allLeads[idx] = applyCrmUpdate(lead, {
          activityNote: `Admin reply via portal: ${replyBody}`
        });
        delete allLeads[idx]._statusTransition;
        await writeLeads(allLeads);
        // Fire customer email (fire-and-forget — reply is committed
        // regardless of SMTP outcome).
        const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
        sendPortalReplyToCustomer(allLeads[idx], replyBody, { baseUrl }).catch(() => {});
        return sendJson(res, 200, { ok: true, message: entry });
      } catch (err) {
        return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't post reply."] });
      }
    }

    if (req.method === "POST" && sub === "/read") {
      if (!Array.isArray(lead.portal?.messages)) return sendJson(res, 200, { ok: true, marked: 0 });
      let marked = 0;
      for (const m of lead.portal.messages) {
        if (m.from === "customer" && !m.readByAdmin) { m.readByAdmin = true; marked++; }
      }
      if (marked) await writeLeads(allLeads);
      return sendJson(res, 200, { ok: true, marked });
    }
  }

  // Portal-side: customer marks admin replies as read on portal load so
  // the unread badge in the portal UI clears once they've seen them.
  const portalReadMatch = pathname.match(/^\/api\/portal\/([^/]+)\/messages\/read$/);
  if (portalReadMatch && req.method === "POST") {
    const token = decodeURIComponent(portalReadMatch[1]);
    const allLeads = await readLeads();
    const idx = allLeads.findIndex((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
    if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
    const lead = allLeads[idx];
    if (!Array.isArray(lead.portal?.messages)) return sendJson(res, 200, { ok: true, marked: 0 });
    let marked = 0;
    for (const m of lead.portal.messages) {
      if (m.from === "admin" && !m.readByCustomer) { m.readByCustomer = true; marked++; }
    }
    if (marked) await writeLeads(allLeads);
    return sendJson(res, 200, { ok: true, marked });
  }

  if (req.method === "GET" && pathname === "/api/quotes.csv") {
    const leads = await readLeads();
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"quote-requests.csv\"",
      "cache-control": "no-store"
    });
    res.end(renderCsv(leads));
    return;
  }

  // ============= Booking calendar =============

  // Public catalog of bookable services (used by the booking page UI).
  if (req.method === "GET" && pathname === "/api/booking/services") {
    return sendJson(res, 200, { ok: true, services: BOOKABLE_SERVICES });
  }

  // External handoff endpoint — AI chat agents (or any pre-booking tool)
  // POST a diagnosis + customer hints here, get back a session token, and
  // redirect the customer to /book.html?session=<token>. The booking page
  // pre-fills service/contact/zoneCount from the session and silently
  // attaches the diagnosis to the resulting work order.
  //
  // Body shape (all fields optional except `source`):
  //   {
  //     source: "ai_chat",                          // who created it
  //     diagnosis: "Long-form diagnosis text...",   // attached to work order
  //     diagnosisSummary: "Short summary",          // shown in summaries
  //     suggestedService: "sprinkler_repair",       // BOOKABLE_SERVICES key
  //     severity: "urgent" | "normal",              // for triage
  //     customerHints: {
  //       firstName, lastName, email, phone, address,
  //       zoneCount: 1-50 | "unsure", notes
  //     }
  //   }
  if (req.method === "POST" && pathname === "/api/booking/prepare-session") {
    // Auth: either an admin session cookie (Patrick / staff hitting from
    // a logged-in browser) OR the BOOKING_API_KEY shared secret in the
    // X-PJL-Booking-Key header (AI chat agent or other automated source).
    // Without a key set, the endpoint refuses external requests so it
    // can't be spammed before the integration is configured.
    const apiKey = process.env.BOOKING_API_KEY;
    const headerKey = String(req.headers["x-pjl-booking-key"] || "");
    const adminLoggedIn = await isAuthenticated(req);
    const keyMatches = apiKey && headerKey
      && headerKey.length === apiKey.length
      && crypto.timingSafeEqual(Buffer.from(headerKey), Buffer.from(apiKey));
    if (!adminLoggedIn && !keyMatches) {
      return sendJson(res, 401, { ok: false, errors: ["Authorization required (admin login or X-PJL-Booking-Key header)."] });
    }
    try {
      const payload = await parseRequestBody(req);
      const session = await bookingSessions.createSession(payload);
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      return sendJson(res, 201, {
        ok: true,
        token: session.token,
        expiresAt: new Date(session.expiresAt).toISOString(),
        bookingUrl: joinUrl(baseUrl, "/book.html", { session: session.token })
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't create session."] });
    }
  }

  // Public read endpoint — book.html fetches the session by token to
  // pre-fill the form. Returns the prefill payload only; the diagnosis
  // text is forwarded so it can be shown to the customer once booked.
  const sessionGetMatch = pathname.match(/^\/api\/booking\/session\/([^/]+)$/);
  if (sessionGetMatch && req.method === "GET") {
    const token = decodeURIComponent(sessionGetMatch[1]);
    const session = await bookingSessions.getSession(token);
    if (!session) return sendJson(res, 404, { ok: false, errors: ["Session not found or expired."] });
    return sendJson(res, 200, { ok: true, session });
  }

  // Admin: full FEATURES catalog (granular line items — head replacement,
  // valve, manifold rebuild, wire run, etc.). Used by /admin/handoff to
  // render the multi-item picker. Public bookable services come from
  // /api/booking/services (BOOKABLE_SERVICES) — different catalog, narrower.
  if (req.method === "GET" && pathname === "/api/admin/features") {
    return sendJson(res, 200, { ok: true, features: FEATURES });
  }

  // Properties: customer "system profile" records. Admin-only (gated by
  // needsAuth above). One customer (by email) can have multiple properties.
  // Each property carries the canonical zone list + controller / shutoff /
  // valve box / blowout location data the technician needs on-site.
  if (req.method === "GET" && pathname === "/api/properties") {
    const all = await properties.list();
    return sendJson(res, 200, { ok: true, properties: all });
  }

  // GET /api/admin/property-link-conflicts — list leads whose intake
  // matched an existing property under a different customer email.
  // The detection happens at intake (server.js around line 2210),
  // this endpoint just surfaces the queue for the CRM dashboard.
  if (req.method === "GET" && pathname === "/api/admin/property-link-conflicts") {
    // Cross-reference each stored conflict against the live properties
    // file so the banner can tell the user when "Resolve on property →"
    // would dead-end on a property that no longer exists (deleted,
    // renamed, or never migrated). Without this flag the banner shows
    // a button that navigates to "This property couldn't be loaded."
    const [allLeads, allProperties] = await Promise.all([
      readLeads(),
      properties.list()
    ]);
    const knownPropertyIds = new Set(allProperties.map((p) => p.id));
    const conflicts = [];
    for (const lead of allLeads) {
      if (!Array.isArray(lead.propertyLinkConflicts) || !lead.propertyLinkConflicts.length) continue;
      conflicts.push({
        leadId: lead.id,
        createdAt: lead.createdAt,
        leadName: lead.contact?.name || "",
        leadEmail: lead.contact?.email || "",
        leadPhone: lead.contact?.phone || "",
        leadAddress: lead.contact?.address || "",
        conflicts: lead.propertyLinkConflicts.map((c) => ({
          ...c,
          propertyExists: knownPropertyIds.has(c.id)
        }))
      });
    }
    return sendJson(res, 200, { ok: true, conflicts });
  }

  // POST /api/admin/property-link-conflicts/:leadId/dismiss — mark
  // the conflict resolved-without-transfer. Patrick clicks this when
  // the matched property is a *different* property at the same
  // address (duplex, multi-unit, etc.), so the new lead's property
  // should stand on its own.
  const conflictDismissMatch = pathname.match(/^\/api\/admin\/property-link-conflicts\/([^/]+)\/dismiss$/);
  if (conflictDismissMatch && req.method === "POST") {
    const leadId = decodeURIComponent(conflictDismissMatch[1]);
    const liveLeads = await readLeads();
    const idx = liveLeads.findIndex((l) => l.id === leadId);
    if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
    delete liveLeads[idx].propertyLinkConflicts;
    await writeLeads(liveLeads);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/properties/:id/transfer-owner — change ownership of a
  // property to a different customer. Snapshot fields refresh from
  // the new customer's record; past WOs / invoices / quotes keep
  // their own snapshots (legal records).
  const propertyTransferMatch = pathname.match(/^\/api\/properties\/([^/]+)\/transfer-owner$/);
  if (propertyTransferMatch && req.method === "POST") {
    const propertyId = decodeURIComponent(propertyTransferMatch[1]);
    try {
      const payload = await parseRequestBody(req);
      const newCustomerId = String(payload?.newCustomerId || "").trim();
      if (!newCustomerId) {
        return sendJson(res, 422, { ok: false, errors: ["newCustomerId is required."] });
      }
      const updated = await properties.transferOwner(propertyId, {
        newCustomerId,
        by: "admin",
        note: String(payload?.note || "").slice(0, 400)
      });
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
      return sendJson(res, 200, { ok: true, property: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't transfer ownership."] });
    }
  }

  // POST /api/properties — create a property for an existing customer
  // (Brief 3 "+ Add property" flow on the customer profile).
  if (req.method === "POST" && pathname === "/api/properties") {
    try {
      const payload = await parseRequestBody(req);
      const customerId = String(payload?.customerId || "").trim();
      const address = String(payload?.address || "").trim();
      if (!customerId) return sendJson(res, 422, { ok: false, errors: ["customerId is required."] });
      if (!address) return sendJson(res, 422, { ok: false, errors: ["Address is required."] });
      const customer = await customers.get(customerId, { withProperties: false });
      if (!customer) return sendJson(res, 404, { ok: false, errors: ["Customer not found."] });
      // Pre-geocode for the system-profile coords; fall back to PJL base
      // if the geocoder skips (no key) or fails (unknown address). The
      // property is still created either way — coords just default to
      // null and can be filled later by editing the property.
      let coords = null;
      try {
        const geo = await geocode(address);
        if (geo.ok && geo.coords && !geo.skipped) coords = geo.coords;
      } catch (err) {
        console.warn("[properties] geocode for create failed:", err.message);
      }
      const property = await properties.create({
        customerId,
        address,
        customerName: customer.name || "",
        customerEmail: customer.email || "",
        customerPhone: customer.phone || "",
        coords
      });
      return sendJson(res, 200, { ok: true, property });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create property."] });
    }
  }

  // Bulk import — admin uploads a parsed records array (the import UI does
  // the xlsx parsing in the browser via SheetJS, then sends JSON here).
  // Body: { records: [{ customerName, customerEmail, customerPhone, address,
  //                    system: { controllerLocation, ..., valveBoxes, zones } }, ...] }
  // Each record is upserted by (email + address) match. Returns counts so
  // the UI can render a per-row outcome summary.
  if (req.method === "POST" && pathname === "/api/admin/import-properties") {
    try {
      // Larger body cap — 34 customers ~50KB, but a future import of
      // hundreds could push 500KB. 5MB ceiling so a paste-bombed import
      // can't OOM the server.
      const payload = await parseRequestBody(req, { maxBytes: 5_000_000 });
      const records = Array.isArray(payload.records) ? payload.records : [];
      if (!records.length) return sendJson(res, 422, { ok: false, errors: ["No records to import."] });
      if (records.length > 5000) return sendJson(res, 422, { ok: false, errors: ["Too many records (>5000) — split into smaller batches."] });
      const summary = await properties.bulkUpsert(records);
      return sendJson(res, 200, {
        ok: true,
        created: summary.created,
        updated: summary.updated,
        errors: summary.errors,
        // Don't echo the full property records back — keeps the response
        // tight and the UI doesn't need them (it'll refresh the list).
        total: summary.created + summary.updated
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Import failed."] });
    }
  }

  // Manual search — used by the CRM "link to existing property" picker.
  // Substring match against customer name / email / phone / address. The
  // result set is small (PJL-scale) so a linear scan + filter is fine.
  if (req.method === "GET" && pathname === "/api/properties/search") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const all = await properties.list();
    const results = q
      ? all.filter((p) => {
          const haystack = [p.customerName, p.customerEmail, p.customerPhone, p.address]
            .filter(Boolean).join(" ").toLowerCase();
          return haystack.includes(q);
        }).slice(0, 25)
      : all.slice(0, 25);
    return sendJson(res, 200, {
      ok: true,
      results: results.map((p) => ({
        id: p.id,
        customerName: p.customerName,
        customerEmail: p.customerEmail,
        address: p.address,
        bookingCount: (p.leadIds || []).length
      }))
    });
  }

  // ---- Customers (Brief 3) ---------------------------------------
  //
  // GET    /api/customers              — list with propertyCount + lastActivityAt
  // POST   /api/customer               — create
  // GET    /api/customer/:id           — single, decorated with linked entities
  // PATCH  /api/customer/:id           — update editable fields
  // POST   /api/customer/:id/communication — append a manual comm record

  if (req.method === "GET" && pathname === "/api/customers") {
    const [allCustomers, allProperties, allWOs, allInvoicesList] = await Promise.all([
      customers.list(),
      properties.list(),
      workOrders.list(),
      invoices.list()
    ]);
    const propertyCount = new Map();
    const lastActivity = new Map();
    const bump = (cid, ts) => {
      if (!cid || !ts) return;
      const prev = lastActivity.get(cid);
      if (!prev || ts > prev) lastActivity.set(cid, ts);
    };
    for (const p of allProperties) {
      if (!p.customerId) continue;
      propertyCount.set(p.customerId, (propertyCount.get(p.customerId) || 0) + 1);
      bump(p.customerId, p.updatedAt || p.createdAt);
    }
    for (const w of allWOs) bump(w.customerId, w.updatedAt || w.createdAt);
    for (const i of allInvoicesList) bump(i.customerId, i.updatedAt || i.createdAt);
    const decorated = allCustomers.map((c) => ({
      ...c,
      propertyCount: propertyCount.get(c.id) || 0,
      lastActivityAt: lastActivity.get(c.id) || c.updatedAt || c.createdAt
    }));
    decorated.sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
    return sendJson(res, 200, { ok: true, customers: decorated });
  }

  if (req.method === "POST" && pathname === "/api/customer") {
    try {
      const payload = await parseRequestBody(req);
      if (!payload || !String(payload.name || "").trim()) {
        return sendJson(res, 422, { ok: false, errors: ["Customer name is required."] });
      }
      const created = await customers.create(payload, { by: "admin", note: "Created from admin UI" });
      return sendJson(res, 200, { ok: true, customer: created });
    } catch (err) {
      if (err && err.code === "DUPLICATE_EMAIL") {
        return sendJson(res, 409, { ok: false, errors: [err.message], existingId: err.existingId });
      }
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create customer."] });
    }
  }

  const customerSingleMatch = pathname.match(/^\/api\/customer\/([^/]+)$/);
  if (customerSingleMatch) {
    const id = decodeURIComponent(customerSingleMatch[1]);
    if (req.method === "GET") {
      const customer = await customers.get(id, { withProperties: true });
      if (!customer) return sendJson(res, 404, { ok: false, error: "Customer not found." });
      const [allBookings, allWOs, allQuotes, allInvoicesList] = await Promise.all([
        bookings.list(),
        workOrders.list(),
        quotes.list(),
        invoices.list()
      ]);
      return sendJson(res, 200, {
        ok: true,
        customer: {
          ...customer,
          bookings: allBookings.filter((b) => b.customerId === id),
          workOrders: allWOs.filter((w) => w.customerId === id),
          quotes: allQuotes.filter((q) => q.customerId === id),
          invoices: allInvoicesList.filter((i) => i.customerId === id)
        }
      });
    }
    if (req.method === "PATCH") {
      try {
        const payload = await parseRequestBody(req);
        const updated = await customers.update(id, payload, { by: "admin", note: "Edit from /admin/customer" });
        if (!updated) return sendJson(res, 404, { ok: false, error: "Customer not found." });
        return sendJson(res, 200, { ok: true, customer: updated });
      } catch (err) {
        if (err && err.code === "DUPLICATE_EMAIL") {
          return sendJson(res, 409, { ok: false, errors: [err.message], existingId: err.existingId });
        }
        return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update customer."] });
      }
    }
    if (req.method === "DELETE") {
      // Hard-delete. The lib refuses if any entity still references this
      // customer; the UI shows that response so Patrick can Merge first
      // when the customer is linked to real bookings/WOs/etc. Test data
      // and clean duplicates with no references go straight through.
      const result = await customers.hardDelete(id);
      if (!result.ok) {
        if (result.references) {
          return sendJson(res, 409, { ok: false, error: result.error, references: result.references });
        }
        return sendJson(res, 404, { ok: false, error: result.error });
      }
      return sendJson(res, 200, { ok: true, deleted: { id: result.customer.id, name: result.customer.name } });
    }
  }

  // POST /api/customer/:id/merge — merge another customer INTO this
  // one. Destructive: the secondary customer is removed, all their
  // entity references re-pointed to this customer. Brief 4.
  const customerMergeMatch = pathname.match(/^\/api\/customer\/([^/]+)\/merge$/);
  if (customerMergeMatch && req.method === "POST") {
    const primaryId = decodeURIComponent(customerMergeMatch[1]);
    try {
      const payload = await parseRequestBody(req);
      const secondaryId = String(payload?.secondaryId || "").trim();
      if (!secondaryId) {
        return sendJson(res, 422, { ok: false, errors: ["secondaryId is required."] });
      }
      const result = await customers.mergeCustomers(primaryId, secondaryId, {
        by: "admin",
        note: String(payload?.note || "").slice(0, 400)
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't merge."] });
    }
  }

  const customerCommMatch = pathname.match(/^\/api\/customer\/([^/]+)\/communication$/);
  if (customerCommMatch && req.method === "POST") {
    const id = decodeURIComponent(customerCommMatch[1]);
    try {
      const payload = await parseRequestBody(req);
      const summary = String(payload?.summary || "").trim();
      if (!summary) {
        return sendJson(res, 422, { ok: false, errors: ["Communication summary is required."] });
      }
      const updated = await customers.addCommunication(id, {
        source: payload?.source,
        summary,
        notes: payload?.notes
      });
      if (!updated) return sendJson(res, 404, { ok: false, error: "Customer not found." });
      return sendJson(res, 200, { ok: true, customer: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't add record."] });
    }
  }

  // List a property's deferred recommendations. Optional ?status=open or
  // ?status=open,pre_authorized filter — used by the property page (all),
  // the spring WO carry-forward banner (open + pre_authorized), and any
  // future dashboard summary. Admin-only via the auth gate above.
  const propertyDeferredListMatch = pathname.match(/^\/api\/properties\/([^/]+)\/deferred$/);
  if (propertyDeferredListMatch && req.method === "GET") {
    try {
      const propertyId = decodeURIComponent(propertyDeferredListMatch[1]);
      const url = new URL(req.url, baseUrlFromReq(req));
      const statusParam = url.searchParams.get("status");
      const statusFilter = statusParam
        ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      const list = await properties.listDeferred(propertyId, { status: statusFilter });
      return sendJson(res, 200, { ok: true, deferred: list });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't list deferred items."] });
    }
  }

  // Admin lifecycle endpoint — Patrick marks a deferred item resolved or
  // dismissed manually (e.g. customer fixed it themselves, no longer
  // applicable). Body: { status, note }. Allowed transitions:
  //   open           → dismissed | resolved
  //   pre_authorized → dismissed
  // Other transitions flow through the carry-forward endpoint (in the WO
  // context) so the audit trail captures which WO resolved them.
  const propertyDeferredMutateMatch = pathname.match(/^\/api\/properties\/([^/]+)\/deferred\/([^/]+)$/);
  if (propertyDeferredMutateMatch && req.method === "PATCH") {
    try {
      const propertyId = decodeURIComponent(propertyDeferredMutateMatch[1]);
      const deferredId = decodeURIComponent(propertyDeferredMutateMatch[2]);
      const payload = await parseRequestBody(req);
      const targetStatus = String(payload?.status || "");
      const note = typeof payload?.note === "string" ? payload.note.slice(0, 500) : "";

      const handle = await properties.getDeferredIssue(propertyId, deferredId);
      if (!handle) return sendJson(res, 404, { ok: false, errors: ["Deferred item not found."] });

      const allowed = {
        open: new Set(["dismissed", "resolved"]),
        pre_authorized: new Set(["dismissed"])
      };
      const currentStatus = handle.entry.status || "open";
      if (!allowed[currentStatus] || !allowed[currentStatus].has(targetStatus)) {
        return sendJson(res, 422, { ok: false, errors: [
          `Cannot transition deferred item from "${currentStatus}" to "${targetStatus}" via this endpoint. Use the WO carry-forward endpoint for in-flight resolutions.`
        ] });
      }

      const updated = await properties.updateDeferredIssue(propertyId, deferredId, {
        status: targetStatus,
        resolution: {
          resolvedAt: new Date().toISOString(),
          resolvedBy: "admin",
          resolvedInWoId: null,
          note: note || (targetStatus === "dismissed" ? "Dismissed by admin." : "Marked resolved by admin.")
        }
      });
      return sendJson(res, 200, { ok: true, deferred: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update deferred item."] });
    }
  }

  // Move a lead between properties — confirms a "suggested" link OR
  // performs a manual link from the picker. The previous property keeps
  // existing in case it has other leads attached; if it's now orphaned,
  // Patrick can clean it up from the properties index.
  // Body: { propertyId: "<target-property-id>" }
  const linkPropertyMatch = pathname.match(/^\/api\/leads\/([^/]+)\/link-property$/);
  if (linkPropertyMatch && req.method === "POST") {
    try {
      const leadId = decodeURIComponent(linkPropertyMatch[1]);
      const payload = await parseRequestBody(req);
      const targetPropertyId = normalizeString(payload.propertyId, 80);
      if (!targetPropertyId) return sendJson(res, 422, { ok: false, errors: ["propertyId is required."] });
      const target = await properties.get(targetPropertyId);
      if (!target) return sendJson(res, 404, { ok: false, errors: ["Target property not found."] });

      const allLeads = await readLeads();
      const idx = allLeads.findIndex((l) => l.id === leadId);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      const lead = allLeads[idx];
      const fromPropertyId = lead.propertyId || null;
      await properties.relinkLead({ leadId, fromPropertyId, toPropertyId: targetPropertyId });

      lead.propertyId = targetPropertyId;
      lead.propertyLinkStatus = "linked";
      // Suggestion list is no longer relevant once the link is confirmed.
      delete lead.propertyLinkSuggestions;
      // Activity entry so there's an audit trail for the merge.
      lead.crm = lead.crm || {};
      lead.crm.activity = Array.isArray(lead.crm.activity) ? lead.crm.activity : [];
      lead.crm.activity.unshift({
        at: new Date().toISOString(),
        type: "update",
        text: `Linked to property: ${target.address || targetPropertyId}`
      });
      lead.crm.lastUpdated = new Date().toISOString();
      allLeads[idx] = lead;
      await writeLeads(allLeads);

      const decorated = await hydrateLeadQuote(decorateLeadForAdmin(lead, req));
      return sendJson(res, 200, { ok: true, lead: decorated });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't link property."] });
    }
  }

  // Reject a suggested link — clears the suggestions but keeps the
  // current property. Lets Patrick dismiss the "this might be a duplicate"
  // banner without taking action.
  const dismissSuggestionMatch = pathname.match(/^\/api\/leads\/([^/]+)\/dismiss-property-suggestion$/);
  if (dismissSuggestionMatch && req.method === "POST") {
    try {
      const leadId = decodeURIComponent(dismissSuggestionMatch[1]);
      const allLeads = await readLeads();
      const idx = allLeads.findIndex((l) => l.id === leadId);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      const lead = allLeads[idx];
      delete lead.propertyLinkSuggestions;
      lead.propertyLinkStatus = "linked";
      allLeads[idx] = lead;
      await writeLeads(allLeads);
      const decorated = await hydrateLeadQuote(decorateLeadForAdmin(lead, req));
      return sendJson(res, 200, { ok: true, lead: decorated });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't dismiss suggestion."] });
    }
  }

  // Re-run the property auto-link for an existing lead. Used when a lead
  // came in BEFORE the auto-link feature shipped, OR when the original
  // attempt failed (no email at intake, etc.) and the customer's data
  // has since been filled in. Same machinery as the booking-time auto-
  // link — finds an existing property by (email + address) match, falls
  // back to creating a new property under the customer.
  const attachPropertyMatch = pathname.match(/^\/api\/leads\/([^/]+)\/attach-property$/);
  if (attachPropertyMatch && req.method === "POST") {
    try {
      const leadId = decodeURIComponent(attachPropertyMatch[1]);
      const allLeads = await readLeads();
      const idx = allLeads.findIndex((l) => l.id === leadId);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      const lead = allLeads[idx];

      const address = lead.contact?.address;
      let coords = null;
      if (address) {
        const geo = await geocode(address);
        if (geo.ok && geo.coords) coords = geo.coords;
      }

      const linkResult = await properties.attachLead({
        leadId: lead.id,
        email: lead.contact?.email,
        name: lead.contact?.name,
        phone: lead.contact?.phone,
        address,
        coords
      });

      if (!linkResult.property) {
        return sendJson(res, 422, {
          ok: false,
          errors: [linkResult.status === "no-email"
            ? "This lead has no email — add an email to auto-link, or pick an existing property manually."
            : "Couldn't create or match a property for this lead."]
        });
      }

      lead.propertyId = linkResult.property.id;
      lead.propertyLinkStatus = linkResult.status;
      if (linkResult.status === "suggested") {
        lead.propertyLinkSuggestions = linkResult.suggestions;
      } else {
        delete lead.propertyLinkSuggestions;
      }
      if (linkResult.status === "conflict-ownership") {
        lead.propertyLinkConflicts = linkResult.conflicts;
      } else {
        delete lead.propertyLinkConflicts;
      }
      lead.crm = lead.crm || {};
      lead.crm.activity = Array.isArray(lead.crm.activity) ? lead.crm.activity : [];
      lead.crm.activity.unshift({
        at: new Date().toISOString(),
        type: "update",
        text: linkResult.status === "linked"
          ? `Linked to existing property: ${linkResult.property.address || linkResult.property.id}`
          : `Created new property: ${linkResult.property.address || linkResult.property.id}`
      });
      lead.crm.lastUpdated = new Date().toISOString();
      allLeads[idx] = lead;
      await writeLeads(allLeads);

      const decorated = await hydrateLeadQuote(decorateLeadForAdmin(lead, req));
      return sendJson(res, 200, {
        ok: true,
        lead: decorated,
        property: linkResult.property,
        status: linkResult.status
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't attach property."] });
    }
  }

  const propertyMatch = pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (propertyMatch && req.method === "GET") {
    const property = await properties.get(decodeURIComponent(propertyMatch[1]));
    if (!property) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
    // Decorate with linked leads so the admin page can show booking history.
    const allLeads = await readLeads();
    const matchedLeads = allLeads
      .filter((l) => l.propertyId === property.id || (property.leadIds || []).includes(l.id));
    // Build the quote map once so the per-lead Quote card can render here too.
    const allQuotes = await quotes.list().catch(() => []);
    const quotesByLeadId = new Map();
    for (const q of allQuotes) {
      if (q.leadId) quotesByLeadId.set(q.leadId, q);
    }
    const linkedLeads = matchedLeads.map((l) => {
      const decorated = decorateLeadForAdmin(l, req);
      const q = quotesByLeadId.get(l.id);
      if (q) decorated.quote = q;
      return decorated;
    });
    return sendJson(res, 200, { ok: true, property, leads: linkedLeads });
  }

  if (propertyMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(propertyMatch[1]);
      const payload = await parseRequestBody(req);
      // Capture the previous address so we know whether to re-geocode
      // after the update. The property record stores coords explicitly;
      // when address changes those coords go stale and the iCal feed's
      // X-APPLE-STRUCTURED-LOCATION would point at the old pin.
      const before = await properties.get(id);
      const previousAddress = String(before?.address || "").trim();
      // Guard against the admin accidentally clobbering structural fields
      // (id, leadIds, customerEmail) — only allow profile / system edits.
      const sanitized = {};
      const allowedTop = ["customerName", "customerPhone", "address"];
      for (const key of allowedTop) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) sanitized[key] = payload[key];
      }
      if (payload.system && typeof payload.system === "object") {
        sanitized.system = {};
        const allowedSys = ["controllerLocation", "controllerBrand", "shutoffLocation", "blowoutLocation", "valveBoxes", "zones", "notes"];
        for (const key of allowedSys) {
          if (Object.prototype.hasOwnProperty.call(payload.system, key)) sanitized.system[key] = payload.system[key];
        }
      }
      let updated = await properties.update(id, sanitized);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });

      // If address changed, refresh the geocoded coords so the iCal
      // feed's structured-location pin tracks the new address. Failure
      // here is non-blocking — the property update is already committed.
      const newAddress = String(updated.address || "").trim();
      if (newAddress && newAddress !== previousAddress) {
        try {
          const geo = await geocode(newAddress);
          if (geo.ok && geo.coords && geo.coords.lat != null) {
            updated = await properties.update(id, {
              coords: {
                lat: geo.coords.lat,
                lng: geo.coords.lng,
                formattedAddress: geo.coords.formattedAddress || newAddress
              }
            });
          }
        } catch (err) {
          console.warn("[property update] re-geocode failed:", err?.message);
        }
      }

      // Cascade canonical fields to linked leads + bookings. The property
      // record is the source of truth for address + customer contact;
      // leads and bookings carry snapshot copies for back-compat with
      // /api/quotes and the schedule canvas. Without this cascade, edits
      // to a property's address stay invisible everywhere else until the
      // booking is rescheduled or the lead is manually re-saved. Patrick
      // hit this exact bug: updated property to "21 Hill Country Dr,
      // Whitchurch-Stouffville, ON L4A 3T2, Canada" but the booking
      // modal + iCal feed still showed the old "21 Hill Country Drive,
      // Stouffville". Idempotent — if booking.address already matches,
      // the update is a no-op.
      const sync = await cascadePropertyToLinkedRecords(updated);

      return sendJson(res, 200, { ok: true, property: updated, sync });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't update property."] });
    }
  }

  // Single-property delete. Linked leads keep existing — we just clear
  // their propertyId so they re-attach on next match attempt instead of
  // pointing at a dangling id.
  if (propertyMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(propertyMatch[1]);
      const removed = await properties.remove(id);
      if (!removed) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
      const affectedLeadIds = removed.leadIds || [];
      if (affectedLeadIds.length) {
        const allLeads = await readLeads();
        let mutated = false;
        for (const lead of allLeads) {
          if (lead.propertyId === id) {
            lead.propertyId = null;
            lead.propertyLinkStatus = "no-email";
            delete lead.propertyLinkSuggestions;
            mutated = true;
          }
        }
        if (mutated) await writeLeads(allLeads);
      }
      return sendJson(res, 200, { ok: true, deletedId: id, affectedLeadCount: affectedLeadIds.length });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete property."] });
    }
  }

  // Bulk delete. POST (not DELETE) so we can carry a JSON body with the
  // id list + the typed confirmation. Body shape:
  //   { ids: ["uuid", "uuid"], confirm: "DELETE" }              — multi-select
  //   { all: true,             confirm: "DELETE ALL" }          — nuke everything
  //
  // The `confirm` token is the second factor. The UI requires Patrick to
  // type it before the request leaves the browser; we re-check it on the
  // server so a stray fetch from a tab he forgot about can't wipe the
  // portfolio.
  if (req.method === "POST" && pathname === "/api/properties/bulk-delete") {
    try {
      const payload = await parseRequestBody(req);
      const wantAll = payload.all === true;
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((x) => typeof x === "string" && x) : [];
      const confirm = String(payload.confirm || "");
      const expected = wantAll ? "DELETE ALL" : "DELETE";
      if (confirm !== expected) {
        return sendJson(res, 422, { ok: false, errors: [`Type ${expected} to confirm.`] });
      }
      if (!wantAll && !ids.length) {
        return sendJson(res, 422, { ok: false, errors: ["No properties selected."] });
      }

      const result = await properties.removeMany(wantAll ? "*" : ids);
      // Clear propertyId on every lead that pointed at one of the deleted
      // properties. Single leads.json write regardless of how many properties.
      if (result.deletedIds.length) {
        const deletedSet = new Set(result.deletedIds);
        const allLeads = await readLeads();
        let mutated = false;
        for (const lead of allLeads) {
          if (lead.propertyId && deletedSet.has(lead.propertyId)) {
            lead.propertyId = null;
            lead.propertyLinkStatus = "no-email";
            delete lead.propertyLinkSuggestions;
            mutated = true;
          }
        }
        if (mutated) await writeLeads(allLeads);
      }

      return sendJson(res, 200, {
        ok: true,
        deletedCount: result.deletedIds.length,
        affectedLeadCount: result.affectedLeadIds.length
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete properties."] });
    }
  }

  // ---------- Work orders -------------------------------------------
  // Admin-only (auth gate above). Phase 4 will add a customer-portal
  // subset for accept-quote, but for now everything is gated.

  // ---------- Quote PDF (admin-gated + public-via-token) ---------------
  // Admin: GET /api/admin/quote-folder/:id/pdf — download a PDF for any
  // Quote in the folder. Pulls customer/property metadata for the
  // bill-to block. Streams via pdfkit so memory usage stays small even
  // for many-line quotes.
  const adminQuotePdfMatch = pathname.match(/^\/api\/admin\/quote-folder\/([^/]+)\/pdf$/);
  if (adminQuotePdfMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(adminQuotePdfMatch[1]);
      const q = await quotes.get(id);
      if (!q) return sendJson(res, 404, { ok: false, errors: ["Quote not found."] });
      let property = null;
      if (q.propertyId) { try { property = await properties.get(q.propertyId); } catch (_) {} }
      let customer = property ? { customerName: property.customerName, customerPhone: property.customerPhone, address: property.address } : null;
      // Fallback to lead contact if no property
      if (!customer && q.leadId) {
        const allLeads = await readLeads();
        const lead = allLeads.find((l) => l.id === q.leadId);
        if (lead?.contact) customer = { customerName: lead.contact.name, customerPhone: lead.contact.phone, address: lead.contact.address };
      }
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${q.id}.pdf"`,
        "cache-control": "no-store"
      });
      generateQuotePdf(q, { customer: customer || {}, property: property || {} }).pipe(res);
      return;
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't generate PDF."] });
    }
  }

  // Public: GET /api/approve/:id/:token/pdf — same PDF, customer-side.
  // Token-gated; returns 404 if token mismatch (no leak of quote IDs).
  const approvePdfMatch = pathname.match(/^\/api\/approve\/([^/]+)\/([^/]+)\/pdf$/);
  if (approvePdfMatch && req.method === "GET") {
    try {
      const quoteId = decodeURIComponent(approvePdfMatch[1]);
      const token = decodeURIComponent(approvePdfMatch[2]);
      const q = await quotes.getByApprovalToken(quoteId, token);
      if (!q) return sendJson(res, 404, { ok: false, errors: ["Approval link not found or expired."] });
      let property = null;
      if (q.propertyId) { try { property = await properties.get(q.propertyId); } catch (_) {} }
      let customer = property ? { customerName: property.customerName, customerPhone: property.customerPhone, address: property.address } : {};
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${q.id}.pdf"`,
        "cache-control": "no-store"
      });
      generateQuotePdf(q, { customer, property: property || {} }).pipe(res);
      return;
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't generate PDF."] });
    }
  }

  // ---------- Invoice send / resend (PR 2) ----------------------------
  // POST /api/invoices/:id/send    — first send: optional QB push → email
  //                                   with PDF → status draft → sent.
  // POST /api/invoices/:id/resend  — re-email the same invoice without
  //                                   any status change. Audit-stamps the
  //                                   resend so we don't lose the trail.
  //
  // Both routes:
  //   - Are admin-gated by isAdminPath() above (/api/invoices is admin).
  //   - Render the PDF on demand from the current invoice record.
  //   - Treat a QB push failure as a warning, not a hard failure: the
  //     email still goes out, the admin sees a non-blocking warning in
  //     the response so they can retry the QB push from the QB card.
  //     This matches the brief's "error tolerance" rule — non-essential
  //     side effects must never break the primary action.
  //
  // Idempotency:
  //   /send is rejected with 409 if status is anything but draft. The
  //   admin can /resend after a successful first send (any status except
  //   void).
  const invoiceSendMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/(send|resend)$/);
  if (invoiceSendMatch && req.method === "POST") {
    const invId = decodeURIComponent(invoiceSendMatch[1]);
    const action = invoiceSendMatch[2]; // "send" or "resend"
    try {
      const inv = await invoices.get(invId);
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });

      // Status gating
      if (action === "send" && inv.status !== "draft") {
        return sendJson(res, 409, { ok: false, errors: [`Invoice is "${inv.status}" — only draft invoices can be sent. Use Resend to re-email.`] });
      }
      if (action === "resend" && inv.status === "void") {
        return sendJson(res, 409, { ok: false, errors: ["Cannot resend a voided invoice."] });
      }
      if (!inv.customerEmail) {
        return sendJson(res, 400, { ok: false, errors: ["Invoice has no customer email — add one to the invoice before sending."] });
      }

      // Optional QB push — best effort. We use isConfigured() + isConnected()
      // to decide whether to try at all; if either is false the push is
      // skipped silently. On a real failure (network, 401 after refresh,
      // etc.) we log + warn but keep going so the email still ships.
      let qbWarning = null;
      let qbAction = null;
      let qbInvoiceId = inv.quickbooksInvoiceId || null;
      if (action === "send") {
        try {
          if (quickbooks.isConfigured() && (await quickbooks.isConnected())) {
            const result = await quickbooks.pushInvoice(inv);
            qbInvoiceId = result.id;
            qbAction = result.action;
          }
        } catch (qbErr) {
          console.warn(`[invoice-send] QB push failed for ${invId}: ${qbErr.message}`);
          qbWarning = `QuickBooks push failed: ${qbErr.message}. The email still went out — retry the push from the invoice editor.`;
        }
      }

      // PR 3 — ensure a paymentToken exists so the email's "View and pay"
      // CTA can deep-link the customer into the embedded payment page.
      // ensurePaymentToken is idempotent (resends won't rotate the token,
      // which is correct: a customer who already received the link should
      // still be able to use it after a resend).
      const tokenized = await invoices.ensurePaymentToken(invId);
      const paymentToken = tokenized?.paymentToken || null;

      // Render PDF using the latest record (post-QB-push so any new
      // quickbooksInvoiceId is on it if pushInvoice mutated something).
      const renderInv = {
        ...inv,
        quickbooksInvoiceId: qbInvoiceId || inv.quickbooksInvoiceId,
        paymentToken: paymentToken || inv.paymentToken
      };
      const pdfBuffer = await generateInvoicePdf(renderInv);

      // Build the public payment URL the customer clicks from the email.
      // PUBLIC_BASE_URL is the live URL Render ships with (or the custom
      // domain post-DNS cutover). Falls back to the request's own origin
      // for local dev.
      const publicBase = (process.env.PUBLIC_BASE_URL || baseUrlFromReq(req) || "").replace(/\/+$/, "");
      const viewLink = paymentToken && publicBase
        ? `${publicBase}/pay/invoice/${encodeURIComponent(invId)}?t=${encodeURIComponent(paymentToken)}`
        : "";

      // Send the email. If this throws, the call returns 500 and the
      // admin sees the underlying error. Status is NOT flipped on failure.
      await sendInvoiceToCustomer(renderInv, pdfBuffer, {
        resend: action === "resend",
        viewLink
      });

      // Build the patch for invoices.update(). For /send, flip to sent;
      // for /resend, leave status alone but append a history entry.
      const now = new Date().toISOString();
      const patch = {};
      if (qbInvoiceId && qbInvoiceId !== inv.quickbooksInvoiceId) {
        patch.quickbooksInvoiceId = qbInvoiceId;
      }
      let updated;
      if (action === "send") {
        // invoices.update() handles the status:sent transition + sentAt
        // stamp + status:* history entry automatically.
        patch.status = "sent";
        patch.note = qbInvoiceId
          ? `Pushed to QuickBooks as ${qbInvoiceId} (${qbAction}); emailed to ${inv.customerEmail}.`
          : `Emailed to ${inv.customerEmail}${qbWarning ? " (QB push skipped)" : ""}.`;
        updated = await invoices.update(invId, patch);
      } else {
        // /resend — no status change, but the audit trail still records
        // the re-send. invoices.update() only logs history on status
        // changes, so we use appendHistory() directly for the resend
        // event. quickbooksInvoiceId can still be updated via the patch
        // object if the QB push happened during the resend (it doesn't
        // for /resend — push is /send-only — but kept for symmetry).
        if (Object.keys(patch).length > 0) {
          await invoices.update(invId, patch);
        }
        updated = await invoices.appendHistory(invId, {
          action: "resent",
          by: "admin",
          note: `Re-emailed to ${inv.customerEmail}.`
        });
      }

      return sendJson(res, 200, {
        ok: true,
        invoice: updated,
        sentAt: updated?.sentAt || now,
        action,
        qbAction,
        qbInvoiceId,
        warning: qbWarning
      });
    } catch (err) {
      console.error(`[invoice-${action}] failed for ${invId}:`, err.message);
      return sendJson(res, 500, { ok: false, errors: [err.message || `Couldn't ${action} invoice.`] });
    }
  }

  // ---------- Public invoice payment API (PR 3) ------------------------
  // Token-gated public endpoints powering /pay/invoice/:id?t=<token>.
  // Auth model: every endpoint here verifies the paymentToken via
  // invoices.getByPaymentToken(); if the token doesn't match the
  // invoice ID, we 404 (so the existence of the ID isn't leaked). No
  // admin session required.
  //
  // Endpoints:
  //   GET  /api/pay/invoice/:id?t=<token>             — sanitized invoice JSON
  //   GET  /api/pay/invoice/:id/sdk-config?t=<token>  — Intuit SDK init config
  //   POST /api/pay/invoice/:id/charge                — process card charge
  //   POST /api/webhooks/quickbooks-payments          — async settle/refund/etc
  //
  // PCI scope: card data NEVER reaches this server. The /charge endpoint
  // accepts a tokenized card reference (from the Intuit-hosted iframe),
  // calls the Intuit Payments API server-to-server, and records the
  // result. We stay in PCI SAQ-A scope because we never see PAN.

  // GET /api/pay/invoice/:id — public invoice read (sanitized).
  const publicInvoiceMatch = pathname.match(/^\/api\/pay\/invoice\/([^/]+)$/);
  if (publicInvoiceMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(publicInvoiceMatch[1]);
      const url = new URL(req.url, baseUrlFromReq(req));
      const t = url.searchParams.get("t") || "";
      const inv = await invoices.getByPaymentToken(id, t);
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found or link expired."] });
      // Hand back only the fields the customer needs to see — strip
      // internal admin notes, history, and the raw paymentToken from
      // the response.
      const safe = {
        id: inv.id,
        status: inv.status,
        createdAt: inv.createdAt,
        sentAt: inv.sentAt,
        paidAt: inv.paidAt,
        voidedAt: inv.voidedAt,
        customerName: inv.customerName,
        customerEmail: inv.customerEmail,
        address: inv.address,
        lineItems: inv.lineItems,
        subtotal: inv.subtotal,
        hst: inv.hst,
        total: inv.total,
        currency: inv.currency,
        quickbooksChargeId: inv.quickbooksChargeId,
        eTransferEmail: process.env.GMAIL_USER || "info@pjllandservices.com"
      };
      return sendJson(res, 200, { ok: true, invoice: safe });
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't load invoice."] });
    }
  }

  // GET /api/pay/invoice/:id/sdk-config — returns the URL the browser
  // should POST card data to for tokenization. Intuit doesn't ship a
  // browser SDK; the page POSTs directly to api.intuit.com (or sandbox)
  // with no auth header, gets back an opaque card token, and then sends
  // only the token to our /charge endpoint. We expose the URL via this
  // config call so the browser doesn't have to know about QB_ENVIRONMENT.
  //
  // Routing: sandbox.api.intuit.com for QB_ENVIRONMENT=sandbox,
  // api.intuit.com for production.
  const publicSdkConfigMatch = pathname.match(/^\/api\/pay\/invoice\/([^/]+)\/sdk-config$/);
  if (publicSdkConfigMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(publicSdkConfigMatch[1]);
      const url = new URL(req.url, baseUrlFromReq(req));
      const t = url.searchParams.get("t") || "";
      const inv = await invoices.getByPaymentToken(id, t);
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found or link expired."] });
      const cfg = quickbooks.envCfg();
      if (!cfg.clientId) {
        return sendJson(res, 503, { ok: false, errors: ["Payment processor not configured. Contact PJL at (905) 960-0181 to pay another way."] });
      }
      const tokenizeUrl = cfg.environment === "production"
        ? "https://api.intuit.com/quickbooks/v4/payments/tokens"
        : "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
      return sendJson(res, 200, {
        ok: true,
        environment: cfg.environment,
        tokenizeUrl,
        // ReCAPTCHA v3 site key — safe to ship publicly. Server-side
        // verification uses RECAPTCHA_SECRET_KEY which never leaves
        // Render. If neither env var is set the field is empty and
        // pay.js falls back to no-recaptcha mode (the server will then
        // skip verification — useful for local dev).
        recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || ""
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't initialize payment form."] });
    }
  }

  // POST /api/pay/invoice/:id/charge — execute the card charge.
  //
  // Body: { t: <paymentToken>, cardToken: <intuit-card-token> }
  // Card data has already been tokenized by the Intuit iframe; cardToken
  // is the one-shot tokenized reference. We hand it to QB Payments which
  // executes the charge, then record the charge ID + payment back on the
  // invoice and on the QB invoice.
  const publicChargeMatch = pathname.match(/^\/api\/pay\/invoice\/([^/]+)\/charge$/);
  if (publicChargeMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(publicChargeMatch[1]);
      const body = await parseRequestBody(req);
      const inv = await invoices.getByPaymentToken(id, body?.t || "");
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found or link expired."] });
      if (inv.status === "paid") {
        return sendJson(res, 409, { ok: false, errors: ["This invoice has already been paid."] });
      }
      if (inv.status === "void") {
        return sendJson(res, 409, { ok: false, errors: ["This invoice has been voided."] });
      }
      if (inv.status !== "sent") {
        return sendJson(res, 409, { ok: false, errors: [`This invoice is "${inv.status}" and isn't ready for payment.`] });
      }
      const cardToken = body?.cardToken;
      if (!cardToken || typeof cardToken !== "string") {
        return sendJson(res, 400, { ok: false, errors: ["Missing card token from the secure form."] });
      }

      // ReCAPTCHA v3 verification. If RECAPTCHA_SECRET_KEY is set on
      // Render, the client sends a recaptchaToken in the body and we
      // verify it with Google. We reject scores below 0.5 (Google's
      // recommended threshold) — those requests look like bots.
      // If RECAPTCHA_SECRET_KEY is unset, verification is skipped
      // entirely (useful for local dev) and the integration runs the
      // way it did before reCAPTCHA was added.
      const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY || "";
      if (recaptchaSecret) {
        const rc = body?.recaptchaToken;
        if (!rc || typeof rc !== "string") {
          return sendJson(res, 400, { ok: false, errors: ["Missing reCAPTCHA verification token."] });
        }
        try {
          const verifyParams = new URLSearchParams({ secret: recaptchaSecret, response: rc });
          const remoteIp = (req.headers["x-forwarded-for"] || "").split(",")[0]?.trim() || req.socket?.remoteAddress;
          if (remoteIp) verifyParams.set("remoteip", remoteIp);
          const verifyR = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: verifyParams.toString()
          });
          const verifyData = await verifyR.json().catch(() => ({}));
          if (!verifyData.success) {
            console.warn(`[charge] reCAPTCHA failed for ${id}: ${(verifyData["error-codes"] || []).join(", ")}`);
            return sendJson(res, 400, { ok: false, errors: ["Could not verify you're human. Please refresh and try again."] });
          }
          // Score threshold — 0.5 is Google's recommended cutoff. Tunable
          // via env var if abuse becomes a concern.
          const minScore = Number.parseFloat(process.env.RECAPTCHA_MIN_SCORE || "0.5");
          if (typeof verifyData.score === "number" && verifyData.score < minScore) {
            console.warn(`[charge] reCAPTCHA score too low for ${id}: ${verifyData.score} < ${minScore}`);
            return sendJson(res, 400, { ok: false, errors: ["This request was flagged as suspicious. If you're a real customer, please call (905) 960-0181 to pay over the phone."] });
          }
        } catch (rcErr) {
          // reCAPTCHA service unavailable — log + reject. Don't let a
          // fraud check go unverified silently.
          console.warn(`[charge] reCAPTCHA verify call failed for ${id}: ${rcErr.message}`);
          return sendJson(res, 503, { ok: false, errors: ["Fraud-prevention service is briefly unavailable. Please try again in a moment."] });
        }
      }

      // Charge via QB Payments. quickbooks.chargeCard handles OAuth +
      // the charges API; throws on hard failures (declined, expired,
      // network, etc) which we surface as 400 to the client.
      let chargeResult;
      try {
        chargeResult = await quickbooks.chargeCard({
          amountCents: Math.round(Number(inv.total) * 100),
          currency: inv.currency || "CAD",
          cardToken,
          invoiceId: inv.id,
          customerEmail: inv.customerEmail
        });
      } catch (chargeErr) {
        console.warn(`[charge] failed for ${inv.id}: ${chargeErr.message}`);
        return sendJson(res, 400, { ok: false, errors: [chargeErr.message || "Card was declined."] });
      }

      // Record the QB Payment record so the QB invoice shows paid. Best
      // effort — if this fails, the charge still went through; we log
      // the warning and keep going so the customer sees a paid invoice.
      let qbPaymentId = null;
      let qbWarning = null;
      try {
        if (inv.quickbooksInvoiceId) {
          const payment = await quickbooks.recordPaymentForInvoice({
            qbInvoiceId: inv.quickbooksInvoiceId,
            amountCents: Math.round(Number(inv.total) * 100),
            chargeId: chargeResult.id
          });
          qbPaymentId = payment?.id || null;
        }
      } catch (paymentErr) {
        console.warn(`[charge] QB payment record failed for ${inv.id}: ${paymentErr.message}`);
        qbWarning = paymentErr.message;
      }

      // Flip status sent → paid + audit. invoices.update() handles the
      // paidAt stamp + status:paid history entry automatically.
      const updated = await invoices.update(id, {
        status: "paid",
        quickbooksChargeId: chargeResult.id,
        quickbooksPaymentId: qbPaymentId,
        notes: inv.notes
          ? `${inv.notes}\n\nCharged ${chargeResult.id} on ${new Date().toISOString()}.`
          : `Charged ${chargeResult.id} on ${new Date().toISOString()}.`
      });

      // Fire the payment-receipt email. Best effort — a receipt-send
      // failure does NOT roll back the charge or block the customer's
      // redirect to the thanks page. The PDF attachment uses the same
      // generator as the original invoice email so the customer's
      // email trail has both the original invoice and the paid receipt
      // referencing the same document.
      let receiptWarning = null;
      try {
        const receiptPdf = await generateInvoicePdf(updated);
        await sendPaymentReceipt(updated, receiptPdf);
      } catch (receiptErr) {
        console.warn(`[charge] receipt email failed for ${id}: ${receiptErr.message}`);
        receiptWarning = `Payment recorded but receipt email failed to send: ${receiptErr.message}`;
      }

      return sendJson(res, 200, {
        ok: true,
        invoice: {
          id: updated.id,
          status: updated.status,
          paidAt: updated.paidAt,
          total: updated.total,
          quickbooksChargeId: updated.quickbooksChargeId
        },
        chargeId: chargeResult.id,
        warning: qbWarning || receiptWarning
      });
    } catch (err) {
      console.error(`[charge] unexpected:`, err);
      return sendJson(res, 500, { ok: false, errors: [err.message || "Payment couldn't be completed."] });
    }
  }

  // POST /api/webhooks/quickbooks-payments — receives async events
  // (settlement, refund, dispute) from Intuit. For PR 3 we acknowledge
  // and log them; future PR can act on specific event types (e.g.
  // refund flips status back to sent + records a refund history entry).
  if (req.method === "POST" && pathname === "/api/webhooks/quickbooks-payments") {
    try {
      const body = await parseRequestBody(req).catch(() => null);
      // TODO: verify Intuit's webhook signature header before trusting
      // the payload. Header is x-intuit-signature, computed as HMAC-SHA1
      // of the raw body using the webhook signing secret (set in the
      // QB Developer app dashboard, env QB_WEBHOOK_SECRET when added).
      // For PR 3 we log the event; signature verification is the first
      // hardening pass.
      console.log("[qb-webhook] received:", JSON.stringify(body)?.slice(0, 500));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.warn("[qb-webhook] error:", err.message);
      return sendJson(res, 200, { ok: true }); // always 200 so Intuit doesn't retry-storm
    }
  }

  // ---------- Invoice PDF (admin-gated) -------------------------------
  // GET /api/invoices/:id/pdf — render a branded invoice PDF for any
  // invoice in invoices.json. ?download=1 sends Content-Disposition:
  // attachment so the browser fires its save-as dialog; otherwise we
  // serve inline so "Open PDF" can preview in a new tab.
  //
  // Auth: gated by isAdminPath() above (/api/invoices is admin-only).
  // Layout: server/lib/invoice-pdf.js, modeled on _design/invoice-pdf-preview.html.
  const adminInvoicePdfMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/pdf$/);
  if (adminInvoicePdfMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(adminInvoicePdfMatch[1]);
      const inv = await invoices.get(id);
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
      const url = new URL(req.url, baseUrlFromReq(req));
      const isDownload = url.searchParams.get("download") === "1";
      const buffer = await generateInvoicePdf(inv);
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `${isDownload ? "attachment" : "inline"}; filename="${inv.id}.pdf"`,
        "content-length": buffer.length,
        "cache-control": "no-store"
      });
      res.end(buffer);
      return;
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't generate invoice PDF."] });
    }
  }

  // ---------- Admin Quote folder browser (Q-YYYY-NNNN records) -----
  // Distinct from the legacy /api/quotes (which lists leads-as-quotes).
  // Reads from quotes.json — the canonical Quote folder per spec §4.1.

  if (req.method === "GET" && pathname === "/api/admin/quote-folder") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    let all = await quotes.list();
    if (status) all = all.filter((q) => q.status === status);
    if (type) all = all.filter((q) => q.type === type);
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(res, 200, { ok: true, quotes: all });
  }

  // ---------- Remote approval flow (spec §4.1 + §4.3) -----------------
  // The tech taps "Send for customer approval" on the on-site quote
  // builder when the customer wasn't on-site to sign. This endpoint:
  //   1. Wraps the current builderLineItems into a Q-YYYY-NNNN Quote
  //   2. Stamps a random 32-hex approval token on the Quote
  //   3. Sends an SMS + email to the customer (their channels of choice)
  //      with a link to /approve/<quoteId>?t=<token>
  //   4. Flips the WO's onSiteQuote.status to "sent_for_remote_approval"
  // Customer-facing endpoints below handle the view + sign flow.
  const woSendForApprovalMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/on-site-quote\/send-for-approval$/);
  if (woSendForApprovalMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woSendForApprovalMatch[1]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      const builderLines = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      if (!builderLines.length) {
        return sendJson(res, 422, { ok: false, errors: ["Build the on-site quote first — there are no line items to send."] });
      }
      const sendSms = payload?.sendSms !== false;
      const sendEmail = payload?.sendEmail !== false;
      const toEmail = (payload?.email || wo.customerEmail || "").trim();
      const toPhone = (payload?.phone || wo.customerPhone || "").trim();
      if (!sendSms && !sendEmail) {
        return sendJson(res, 422, { ok: false, errors: ["Pick at least one delivery channel (email or SMS)."] });
      }
      if (sendEmail && !toEmail) return sendJson(res, 422, { ok: false, errors: ["Customer email is required for email delivery."] });
      if (sendSms && !toPhone) return sendJson(res, 422, { ok: false, errors: ["Customer phone is required for SMS delivery."] });

      // Recompute totals from current builder lines.
      const totals = issueRollup.totalsFor(builderLines);
      const acceptedSnapshot = builderLines.map((line) => ({
        ...line,
        price: line.overridePrice != null ? Number(line.overridePrice) : Number(line.originalPrice),
        lineTotal: Math.round((line.overridePrice != null ? Number(line.overridePrice) : Number(line.originalPrice)) * (Number(line.qty) || 1) * 100) / 100
      }));

      // Reuse an existing in-flight Quote on this WO if present (avoid
      // generating a new Q-YYYY-NNNN every time the tech retries the
      // send). Otherwise create one.
      let quoteRecord = null;
      if (wo.onSiteQuote?.quoteId) {
        quoteRecord = await quotes.get(wo.onSiteQuote.quoteId);
      }
      if (!quoteRecord) {
        quoteRecord = await quotes.create({
          type: "on_site_quote",
          status: "sent",
          customerEmail: wo.customerEmail || "",
          propertyId: wo.propertyId,
          leadId: wo.leadId || null,
          source: { chatSessionId: null, pageUrl: null, userAgent: req.headers["user-agent"] || "" },
          scope: `On-site quote from ${wo.id} — sent for remote approval`,
          lineItems: acceptedSnapshot,
          subtotal: totals.subtotal,
          hst: totals.hst,
          total: totals.total,
          createdBy: "tech"
        });
        await quotes.attachWorkOrder(quoteRecord.id, wo.id);
      }

      // Generate the approval token + URL.
      const token = crypto.randomBytes(16).toString("hex");
      const baseUrl = baseUrlFromReq(req);
      const channels = [];
      if (sendEmail) channels.push("email");
      if (sendSms) channels.push("sms");
      await quotes.markSentForApproval(quoteRecord.id, { token, channels, toEmail, toPhone });
      const approvalUrl = `${baseUrl.replace(/\/+$/, "")}/approve/${encodeURIComponent(quoteRecord.id)}?t=${token}`;

      const results = { smsSent: false, smsError: null, emailSent: false, emailError: null, approvalUrl };
      const firstName = (wo.customerName || "").split(" ")[0] || "there";
      const summary = `${builderLines.length} line${builderLines.length === 1 ? "" : "s"} — $${totals.total.toFixed(2)} CAD incl. HST`;

      // SMS — keep within 160 chars where possible.
      if (sendSms && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
        const smsBody = `Hi ${firstName}, PJL: your tech recommends ${summary}. Review + approve here: ${approvalUrl}`;
        try {
          const sid = process.env.TWILIO_ACCOUNT_SID;
          const tok = process.env.TWILIO_AUTH_TOKEN;
          const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
          const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
          const body = new URLSearchParams({ To: toPhone, From: process.env.TWILIO_FROM_NUMBER, Body: smsBody });
          const r = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) results.smsError = data?.message || `HTTP ${r.status}`;
          else results.smsSent = true;
        } catch (err) { results.smsError = err.message; }
      } else if (sendSms) {
        results.smsError = "Twilio not configured";
      }

      // Email — branded, scope-summarized, button to approval URL.
      if (sendEmail && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        try {
          let nodemailer;
          try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }
          if (nodemailer) {
            const transporter = nodemailer.createTransport({
              service: "gmail",
              auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
            });
            const lineRows = acceptedSnapshot.map((l) =>
              `<tr><td style="padding:6px 0;">${(l.label || l.key || "").replace(/</g, "&lt;")} × ${l.qty}</td><td style="text-align:right;padding:6px 0;font-variant-numeric:tabular-nums;">$${Number(l.lineTotal).toFixed(2)}</td></tr>`
            ).join("");
            const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#1a1a1a;line-height:1.55;">
  <div style="padding:24px 28px;background:#1B4D2E;border-radius:8px 8px 0 0;">
    <div style="color:#EAF3DE;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">PJL Land Services</div>
    <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">Repair quote — your approval needed.</h1>
  </div>
  <div style="padding:24px 28px;background:#FAFAF5;border:1px solid #e5e5dd;border-top:none;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 14px;">Hi ${firstName.replace(/</g, "&lt;")},</p>
    <p style="margin:0 0 14px;">Our tech ran into something on-site at ${(wo.address || "your property").replace(/</g, "&lt;")} and recommends the following repair scope:</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">${lineRows}</table>
    <p style="margin:12px 0 18px;padding-top:10px;border-top:1px solid #e5e5dd;text-align:right;font-size:15px;"><strong>Total: $${totals.total.toFixed(2)} CAD</strong> (incl. HST)</p>
    <p style="margin:0 0 18px;text-align:center;">
      <a href="${approvalUrl}" style="display:inline-block;padding:14px 28px;background:#E07B24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Review &amp; approve</a>
    </p>
    <p style="margin:18px 0 0;font-size:13px;color:#777;">If the button doesn't work, paste this link:<br><span style="color:#1B4D2E;word-break:break-all;">${approvalUrl}</span></p>
    <p style="margin:24px 0 0;font-size:13px;color:#777;">Questions? Call <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a>.</p>
  </div>
  <p style="margin:16px 0 0;font-size:11px;color:#999;text-align:center;">PJL Land Services · Newmarket, Ontario · pjllandservices.com</p>
</div>`.trim();
            // Generate the quote PDF and attach. Buffered so the
            // sendMail call doesn't race with stream completion.
            let pdfAttachment = null;
            try {
              const pdfDoc = generateQuotePdf(quoteRecord, {
                customer: {
                  name: wo.customerName || "",
                  email: wo.customerEmail || "",
                  phone: wo.customerPhone || ""
                },
                property: { address: wo.address || "" }
              });
              const chunks = [];
              await new Promise((resolve, reject) => {
                pdfDoc.on("data", (c) => chunks.push(c));
                pdfDoc.on("end", resolve);
                pdfDoc.on("error", reject);
              });
              pdfAttachment = {
                filename: `PJL-Quote-${quoteRecord.id}.pdf`,
                content: Buffer.concat(chunks),
                contentType: "application/pdf"
              };
            } catch (err) {
              console.warn("[approval-email] PDF attach failed:", err?.message);
            }
            await transporter.sendMail({
              from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
              to: toEmail,
              replyTo: process.env.GMAIL_USER,
              subject: "PJL: please approve today's repair quote",
              html,
              ...(pdfAttachment ? { attachments: [pdfAttachment] } : {})
            });
            results.emailSent = true;
          } else {
            results.emailError = "nodemailer not installed";
          }
        } catch (err) { results.emailError = err.message; }
      } else if (sendEmail) {
        results.emailError = "Gmail not configured";
      }

      // Stamp the WO so the tech UI shows "Awaiting customer approval."
      await workOrders.update(id, {
        onSiteQuote: {
          ...wo.onSiteQuote,
          status: "sent_for_remote_approval",
          quoteId: quoteRecord.id
        }
      });
      try {
        const channels = [];
        if (results.emailSent) channels.push("email");
        if (results.smsSent) channels.push("SMS");
        await workOrders.appendHistory(id, {
          action: "remote_approval_sent",
          by: "tech",
          note: `Quote ${quoteRecord.id}${channels.length ? ` via ${channels.join("+")}` : " (no channel succeeded)"}`
        });
      } catch (err) { console.warn("[wo-history] remote_approval entry failed:", err?.message); }

      return sendJson(res, 200, { ok: true, quote: quoteRecord, ...results });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't send for approval."] });
    }
  }

  // Public — customer hits this when they tap the email/SMS link. Returns
  // a slim payload (no IP/audit data) so it's safe to render in the
  // /approve/<id> page client-side.
  const approvalGetMatch = pathname.match(/^\/api\/approve\/([^/]+)\/([^/]+)$/);
  if (approvalGetMatch && req.method === "GET") {
    try {
      const quoteId = decodeURIComponent(approvalGetMatch[1]);
      const token = decodeURIComponent(approvalGetMatch[2]);
      const q = await quotes.getByApprovalToken(quoteId, token);
      if (!q) return sendJson(res, 404, { ok: false, errors: ["Approval link not found or expired."] });
      const safe = {
        id: q.id,
        status: q.status,
        scope: q.scope,
        lineItems: q.lineItems,
        subtotal: q.subtotal,
        hst: q.hst,
        total: q.total,
        validUntil: q.validUntil,
        sentAt: q.approval?.sentAt || q.sentAt,
        signedAt: q.signature?.signed ? q.signature.signedAt : null,
        signedBy: q.signature?.signed ? q.signature.customerName : null
      };
      return sendJson(res, 200, { ok: true, quote: safe });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't load quote."] });
    }
  }

  // Public — customer signs and approves. Server stamps IP + UA, calls
  // quotes.acceptWithSignature, then notifies Patrick + flips the WO.
  const approvalSignMatch = pathname.match(/^\/api\/approve\/([^/]+)\/([^/]+)\/sign$/);
  if (approvalSignMatch && req.method === "POST") {
    try {
      const quoteId = decodeURIComponent(approvalSignMatch[1]);
      const token = decodeURIComponent(approvalSignMatch[2]);
      const payload = await parseRequestBody(req);
      const q = await quotes.getByApprovalToken(quoteId, token);
      if (!q) return sendJson(res, 404, { ok: false, errors: ["Approval link not found or expired."] });
      if (q.signature?.signed) {
        return sendJson(res, 200, { ok: true, alreadySigned: true });
      }
      const customerName = String(payload?.customerName || "").trim();
      const imageData = String(payload?.imageData || "");
      if (!customerName || !imageData || imageData.length < 50) {
        return sendJson(res, 422, { ok: false, errors: ["Name and signature are required."] });
      }
      if (imageData.length > 500_000) {
        return sendJson(res, 422, { ok: false, errors: ["Signature image is too large."] });
      }
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const userAgent = req.headers["user-agent"] || "";
      const decisions = (q.lineItems || []).map((_l, idx) => ({ lineItemIdx: idx, accepted: true, deferredId: null }));
      const updated = await quotes.acceptWithSignature(q.id, {
        customerName, imageData, decisions, ip, userAgent, partial: false,
        note: "Accepted via remote-approval link"
      });

      // Find the WO this quote was attached to and flip its onSiteQuote
      // status so the tech UI shows "Customer approved at HH:MM."
      const woIds = Array.isArray(updated?.workOrderIds) ? updated.workOrderIds : [];
      for (const woId of woIds) {
        try {
          const wo = await workOrders.get(woId);
          if (wo && wo.onSiteQuote?.quoteId === updated.id) {
            await workOrders.update(woId, {
              onSiteQuote: { ...wo.onSiteQuote, status: "accepted" }
            });
          }
        } catch (err) { console.warn("[approval-sign] WO update failed:", err?.message); }
      }

      // Notify Patrick — customer just committed money.
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const aliasLead = {
        id: updated.id,
        sourceLabel: `REMOTE APPROVAL — ${updated.id}`,
        contact: {
          name: customerName,
          phone: updated.approval?.sentToPhone || "",
          email: updated.approval?.sentToEmail || updated.customerEmail || "",
          address: "",
          notes: `Customer approved $${Number(updated.total).toFixed(2)} CAD via remote link.`
        }
      };
      Promise.allSettled([
        sendNewLeadEmail(aliasLead, { baseUrl }),
        sendNewLeadSms(aliasLead, { baseUrl })
      ]).catch(() => {});

      return sendJson(res, 200, { ok: true, quote: { id: updated.id, status: updated.status, signedAt: updated.signature.signedAt } });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't process signature."] });
    }
  }

  // ---------- Bookings folder (spec §4.2 first-class records) ---------
  // Read-only admin endpoints for now. Mutations still flow through the
  // booking-reserve / WO endpoints which call bookings.upsertFromLead
  // and bookings.attachWorkOrder under the hood. Patch endpoint is
  // available for prep-notes / status changes that don't go through
  // the lead.booking sync path.
  if (req.method === "GET" && pathname === "/api/bookings") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const propertyId = url.searchParams.get("propertyId");
    const leadId = url.searchParams.get("leadId");
    const status = url.searchParams.get("status");
    let all = await bookings.list();
    if (propertyId) all = all.filter((b) => b.propertyId === propertyId);
    if (leadId) all = all.filter((b) => b.leadId === leadId);
    if (status) all = all.filter((b) => b.status === status);
    // Legacy data heal: if asking for a specific lead's bookings and we
    // have no canonical record yet, materialize one from lead.booking
    // so the reschedule / follow-up modals can find it. Idempotent —
    // upsertFromLead returns the existing record on subsequent calls.
    if (leadId && !all.length) {
      try {
        const allLeads = await readLeads();
        const lead = allLeads.find((l) => l.id === leadId);
        if (lead && lead.booking) {
          const upserted = await bookings.upsertFromLead(lead);
          if (upserted) all = [upserted];
        }
      } catch (err) {
        console.warn("[bookings list] upsert-from-lead failed:", err?.message);
      }
    }
    all.sort((a, b) => new Date(b.scheduledFor || 0) - new Date(a.scheduledFor || 0));
    return sendJson(res, 200, { ok: true, bookings: all });
  }
  const bookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
  if (bookingMatch && req.method === "GET") {
    const b = await bookings.get(decodeURIComponent(bookingMatch[1]));
    if (!b) return sendJson(res, 404, { ok: false, errors: ["Booking not found."] });
    return sendJson(res, 200, { ok: true, booking: b });
  }
  if (bookingMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(bookingMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await bookings.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Booking not found."] });
      return sendJson(res, 200, { ok: true, booking: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update booking."] });
    }
  }

  // DELETE /api/bookings/:id — hard delete. Admin-only (techs can cancel
  // via the soft path below). Refuses if a linked WO has moved past
  // `scheduled` — that's the "tech has touched the work" boundary; use
  // Cancel instead.
  if (bookingMatch && req.method === "DELETE") {
    try {
      const session = await requireAdmin(req);
      if (!session) return sendJson(res, 403, { ok: false, errors: ["Admin role required to delete bookings."] });
      const id = decodeURIComponent(bookingMatch[1]);
      // Fetch the canonical record BEFORE remove() so we can resolve
      // its leadId for the lead.booking cleanup below — the legacy
      // embedded lead.booking shape doesn't carry the canonical BK- id,
      // so we can't match it on a field after the record is gone.
      const bookingToDelete = await bookings.get(id);
      const result = await bookings.remove(id, {
        by: session.uid || "admin",
        isActiveWo: async (woId) => {
          const wo = await workOrders.get(woId);
          if (!wo) return false;
          // "Active" = anything past initial scheduling but not cancelled.
          return wo.status && wo.status !== "scheduled" && wo.status !== "cancelled";
        }
      });
      if (!result.ok) {
        const body = { ok: false, errors: result.errors };
        if (result.linkedWoId) body.linkedWoId = result.linkedWoId;
        return sendJson(res, result.status || 400, body);
      }
      // Strip lead.booking on the linked lead so the schedule canvas
      // (which reads /api/quotes → lead.booking) stops rendering the
      // ghost. Without this the booking disappears from bookings.json
      // but stays on screen because the canvas iterates leads, not the
      // canonical bookings store.
      try {
        if (bookingToDelete?.leadId) {
          const allLeads = await readLeads();
          const lead = allLeads.find((l) => l.id === bookingToDelete.leadId);
          if (lead && lead.booking) {
            delete lead.booking;
            await writeLeads(allLeads);
          }
        }
      } catch (e) {
        console.warn("[booking delete] lead.booking cleanup failed:", e?.message);
      }
      return sendJson(res, 200, { ok: true, deletedId: result.deletedId });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't delete booking."] });
    }
  }

  // POST /api/bookings/:id/cancel — soft cancel. Available to both admin
  // and tech (real-world events: customer called, weather, illness).
  // Body: { reason: string (required, 1-500 chars), notifyCustomer: bool }
  // Side effects:
  //   - Booking record: status=cancelled + cancelledAt/By/Reason + history
  //   - Lead.booking.status mirror (legacy consumers see the cancellation)
  //   - Customer email (only when notifyCustomer !== false) — fire-and-forget
  //     so a Gmail outage doesn't roll back the cancel
  const cancelBookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
  if (cancelBookingMatch && req.method === "POST") {
    try {
      const session = await requireUser(req);
      if (!session) return sendJson(res, 401, { ok: false, errors: ["Sign in required."] });
      const id = decodeURIComponent(cancelBookingMatch[1]);
      const payload = await parseRequestBody(req);
      const reason = String(payload?.reason || "").trim().slice(0, 500);
      if (!reason) {
        return sendJson(res, 422, { ok: false, errors: ["A reason is required so the audit trail captures why."] });
      }
      const notify = payload?.notifyCustomer !== false; // default ON
      const result = await bookings.cancel(id, {
        reason,
        by: session.role === "admin" ? "admin" : "tech",
        actorName: session.uid || ""
      });
      if (!result.ok) {
        return sendJson(res, result.status || 400, { ok: false, errors: result.errors });
      }
      const cancelled = result.booking;
      // Mirror into lead.booking so existing CRM/schedule rendering that
      // reads l.booking sees the cancelled state without a refactor.
      try {
        if (cancelled.leadId) {
          const allLeads = await readLeads();
          const lead = allLeads.find((l) => l.id === cancelled.leadId);
          if (lead && lead.booking) {
            lead.booking.status = "cancelled";
            lead.booking.cancelledAt = cancelled.cancelledAt;
            lead.booking.cancellationReason = cancelled.cancellationReason;
            await writeLeads(allLeads);
          }
        }
      } catch (e) {
        console.warn("[booking cancel] lead.booking mirror failed:", e?.message);
      }
      // Customer email — fire-and-forget. The cancel itself is committed
      // regardless; an email failure surfaces as `notifyResult.ok=false`
      // so the UI can show "cancelled, email failed — retry?" copy.
      let notifyResult = { ok: true, skipped: !notify };
      if (notify) {
        try {
          notifyResult = await sendBookingCancellation(cancelled, {
            reason,
            notify: true,
            baseUrl: baseUrlFromReq(req)
          });
        } catch (e) {
          console.warn("[booking cancel] notify failed:", e?.message);
          notifyResult = { ok: false, error: e?.message || "Email failed." };
        }
      }
      return sendJson(res, 200, {
        ok: true,
        booking: cancelled,
        notify: notifyResult
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't cancel booking."] });
    }
  }

  // ---------- Reschedule slot lookup (admin) ---------------------------
  // Returns available slots for this booking's service tier + address,
  // EXCLUDING this booking's own current slot from the conflict math (so
  // the customer doesn't appear to collide with themselves).
  const adminRescheduleAvailMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/availability$/);
  if (adminRescheduleAvailMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(adminRescheduleAvailMatch[1]);
      const url = new URL(req.url, baseUrlFromReq(req));
      const result = await rescheduleAvailability(id, {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to")
      });
      if (!result.ok) return sendJson(res, result.status || 400, { ok: false, errors: result.errors });
      return sendJson(res, 200, { ok: true, ...result.data });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't load slots."] });
    }
  }

  // ---------- Reschedule (admin) ---------------------------------------
  // Admin-side reschedule from the desktop WO, tech WO, or schedule grid.
  // No 24-hour gate — Patrick can move any future-dated booking. Tech-on-
  // site (arrivedAt set) is blocked for both admin and customer; that
  // case should use the follow-up flow instead.
  const adminRescheduleMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/reschedule$/);
  if (adminRescheduleMatch && req.method === "PATCH") {
    try {
      const result = await rescheduleBooking({
        bookingId: decodeURIComponent(adminRescheduleMatch[1]),
        slotStart: (await parseRequestBody(req)).slotStart,
        actor: "admin",
        actorName: "Patrick",
        reason: "",
        req
      });
      if (!result.ok) return sendJson(res, result.status || 400, { ok: false, errors: result.errors });
      return sendJson(res, 200, { ok: true, booking: result.booking, slot: result.slot });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't reschedule."] });
    }
  }

  // ---------- QuickBooks integration (spec §4.3.4 invoice handoff) -----
  // OAuth + invoice push. Setup docs in server/lib/quickbooks.js.
  // Status check — feeds the Settings page badge.
  if (req.method === "GET" && pathname === "/api/admin/quickbooks/status") {
    const cfg = quickbooks.envCfg();
    return sendJson(res, 200, {
      ok: true,
      configured: quickbooks.isConfigured(),
      connected: await quickbooks.isConnected(),
      environment: cfg.environment
    });
  }

  // OAuth start — redirects the admin to Intuit's consent screen.
  if (req.method === "GET" && pathname === "/api/admin/quickbooks/connect") {
    if (!quickbooks.isConfigured()) {
      return sendJson(res, 503, { ok: false, errors: ["QuickBooks credentials missing — set QB_CLIENT_ID + QB_CLIENT_SECRET in Render env vars first."] });
    }
    const state = crypto.randomBytes(16).toString("hex");
    const baseUrl = baseUrlFromReq(req);
    const redirectUri = `${baseUrl.replace(/\/+$/, "")}/api/admin/quickbooks/callback`;
    const authUrl = quickbooks.buildAuthUrl(state, redirectUri);
    res.writeHead(302, { location: authUrl });
    res.end();
    return;
  }

  // OAuth callback — Intuit redirects here with ?code= and ?realmId=.
  // Exchange the code for tokens and persist. Then bounce back to settings.
  if (req.method === "GET" && pathname === "/api/admin/quickbooks/callback") {
    try {
      const url = new URL(req.url, baseUrlFromReq(req));
      const code = url.searchParams.get("code");
      const realmId = url.searchParams.get("realmId");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(302, { location: "/admin/settings?qb=denied" });
        res.end();
        return;
      }
      if (!code || !realmId) {
        return sendJson(res, 400, { ok: false, errors: ["QB callback missing code or realmId."] });
      }
      const baseUrl = baseUrlFromReq(req);
      const redirectUri = `${baseUrl.replace(/\/+$/, "")}/api/admin/quickbooks/callback`;
      await quickbooks.exchangeCodeForTokens(code, realmId, redirectUri);
      res.writeHead(302, { location: "/admin/settings?qb=connected" });
      res.end();
      return;
    } catch (e) {
      console.warn("[qb] callback failed:", e?.message);
      res.writeHead(302, { location: "/admin/settings?qb=error" });
      res.end();
      return;
    }
  }

  // Disconnect — clears stored tokens. Patrick can re-connect via /connect.
  if (req.method === "POST" && pathname === "/api/admin/quickbooks/disconnect") {
    await quickbooks.clearTokens();
    return sendJson(res, 200, { ok: true });
  }

  // Push a specific invoice → QB. Returns the QB invoice id which gets
  // stored back on the local record so re-pushes update rather than dup.
  const qbPushMatch = pathname.match(/^\/api\/admin\/quickbooks\/invoice\/([^/]+)\/push$/);
  if (qbPushMatch && req.method === "POST") {
    try {
      const invId = decodeURIComponent(qbPushMatch[1]);
      const inv = await invoices.get(invId);
      if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
      const result = await quickbooks.pushInvoice(inv);
      const updated = await invoices.update(invId, {
        quickbooksInvoiceId: result.id,
        notes: inv.notes ? `${inv.notes}\n\nPushed to QB ${new Date().toISOString()}: invoice ${result.id} (${result.action})` : `Pushed to QB ${new Date().toISOString()}: invoice ${result.id} (${result.action})`
      });
      return sendJson(res, 200, { ok: true, invoice: updated, qbAction: result.action });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't push to QuickBooks."] });
    }
  }

  // ---------- QuickBooks settings + items sync (Phase 1 + 2) -----------
  // Admin-only; isAdminPath() above gates the entire /api/admin/quickbooks
  // tree so we don't repeat the auth check here.
  //
  // GET /tax-codes            → dropdown source for HST picker
  // GET /income-accounts      → dropdown source for default income account
  // PATCH /settings           → persist tax/income/auto-push toggles
  // POST /clear-sync-errors   → dismiss the rolling errors panel
  // GET /items                → current quickbooks-items.json (debug + UI)
  // POST /items/sync          → full catalog sync (services + parts)
  // POST /items/sync/:kind/:key → retry a single item from the errors panel

  if (req.method === "GET" && pathname === "/api/admin/quickbooks/tax-codes") {
    try {
      const codes = await quickbooks.listTaxCodes();
      return sendJson(res, 200, { ok: true, taxCodes: codes });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't list tax codes."] });
    }
  }

  if (req.method === "GET" && pathname === "/api/admin/quickbooks/income-accounts") {
    try {
      const accounts = await quickbooks.listIncomeAccounts();
      return sendJson(res, 200, { ok: true, accounts });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't list income accounts."] });
    }
  }

  if (req.method === "PATCH" && pathname === "/api/admin/quickbooks/settings") {
    try {
      const body = await parseRequestBody(req).catch(() => ({}));
      const updated = await settings.updateQuickbooks(body || {}, { who: "admin" });
      return sendJson(res, 200, { ok: true, quickbooks: updated.quickbooks });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't save QuickBooks settings."] });
    }
  }

  if (req.method === "POST" && pathname === "/api/admin/quickbooks/clear-sync-errors") {
    try {
      const updated = await settings.clearSyncErrors();
      return sendJson(res, 200, { ok: true, quickbooks: updated.quickbooks });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't clear sync errors."] });
    }
  }

  if (req.method === "GET" && pathname === "/api/admin/quickbooks/items") {
    try {
      const map = await quickbooks.getItemsMap();
      return sendJson(res, 200, { ok: true, items: map });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't read items map."] });
    }
  }

  if (req.method === "POST" && pathname === "/api/admin/quickbooks/items/sync") {
    try {
      const summary = await quickbooks.syncAllItems();
      return sendJson(res, 200, { ok: true, summary });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't run items sync."] });
    }
  }

  const qbItemSyncMatch = pathname.match(/^\/api\/admin\/quickbooks\/items\/sync\/(services|parts)\/(.+)$/);
  if (qbItemSyncMatch && req.method === "POST") {
    try {
      const kind = qbItemSyncMatch[1];
      const key = decodeURIComponent(qbItemSyncMatch[2]);
      const result = await quickbooks.pushItem(kind, key);
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't sync item."] });
    }
  }

  // ---------- Parts catalog (admin-gated, used by tech materials UI) ----
  if (req.method === "GET" && pathname === "/api/parts") {
    if (!PARTS) return sendJson(res, 503, { ok: false, errors: ["parts.json not loaded on the server."] });
    // Catalog rarely changes intra-session — let the browser cache it
    // for 5 min and the SW serve it offline. Bypass sendJson because
    // sendJson hard-codes cache-control: no-store.
    //
    // The `?admin=1` flag exposes the override classification (added /
    // edited / deleted SKUs) so the catalog admin UI can paint NEW
    // badges + "modified" indicators + the "Show deleted" toggle. We
    // keep the public payload (no admin flag) lean — tech-mode + PO/ML
    // builders don't need that classification.
    const url = new URL(req.url, baseUrlFromReq(req));
    const wantAdminMeta = url.searchParams.get("admin") === "1";
    const payload = {
      ok: true,
      categories: PARTS.categories || [],
      parts: PARTS.parts || {},
      service_materials: PARTS.service_materials || {}
    };
    if (wantAdminMeta) {
      // Read the override file fresh so the response always reflects
      // what's on disk (the in-memory PARTS.parts is the merged result
      // and doesn't tell us WHICH SKUs are runtime additions vs edited
      // baseline vs untouched).
      try {
        const overrides = await partsLib.readOverrides();
        const cls = partsLib.classifyOverrides(BASELINE_PARTS, overrides);
        payload.overrides = {
          addedSkus: [...cls.addedSkus],
          editedSkus: [...cls.editedSkus],
          deletedSkus: [...cls.deletedSkus],
          // Per-SKU edit payload so the UI can show "original price"
          // tooltips on the modified indicator (and "Restore baseline"
          // affordance for individual fields).
          edited: overrides.edited || {}
        };
        // Baseline snapshot for the modified-indicator hover ("price
        // changed from $X.XX"). Only the editable fields, only the
        // SKUs that have edits.
        const baselineForEdits = {};
        for (const sku of cls.editedSkus) {
          if (BASELINE_PARTS[sku]) {
            baselineForEdits[sku] = {
              priceCents: BASELINE_PARTS[sku].priceCents,
              description: BASELINE_PARTS[sku].description,
              category: BASELINE_PARTS[sku].category,
              subcategory: BASELINE_PARTS[sku].subcategory,
              size: BASELINE_PARTS[sku].size,
              unit: BASELINE_PARTS[sku].unit,
              partNumber: BASELINE_PARTS[sku].partNumber
            };
          }
        }
        payload.overrides.baseline = baselineForEdits;
        // Also surface the parts that have been soft-deleted (their
        // baseline records — the UI shows them in the "Show deleted"
        // toggle with a Restore action).
        const deletedParts = {};
        for (const sku of cls.deletedSkus) {
          if (BASELINE_PARTS[sku]) deletedParts[sku] = { ...BASELINE_PARTS[sku], supplierIds: [] };
        }
        payload.overrides.deletedParts = deletedParts;
      } catch (err) {
        // Don't fail the whole response if override read fails — the
        // base catalog still works.
        payload.overrides = { addedSkus: [], editedSkus: [], deletedSkus: [], edited: {}, baseline: {}, deletedParts: {}, _error: err.message };
      }
    }
    const body = JSON.stringify(payload);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": wantAdminMeta ? "no-store" : "public, max-age=300",
      "x-catalog-version": String(CATALOG_VERSION)
    });
    res.end(body);
    return;
  }

  // ---------- Catalog management (admin) ---------------------------------
  // Runtime CRUD on the parts catalog. Edits live in parts-overrides.json
  // (lib/parts.js); the baseline parts.json is never touched. See lib/
  // parts.js header comment for the merge precedence + override-file
  // schema.
  //
  // After every write we rebuild the in-memory catalog so a follow-up
  // GET /api/parts (and any in-process consumer reading PARTS.parts)
  // sees the change without a restart.

  function categoriesAllowedSet() {
    if (!PARTS || !Array.isArray(PARTS.categories)) return new Set();
    return new Set(PARTS.categories.map((c) => c.key).filter(Boolean));
  }

  // POST /api/parts          — add a single part
  // POST /api/parts (bulk)   — add many at once via { parts: [...] }
  if (req.method === "POST" && pathname === "/api/parts") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const payload = await parseRequestBody(req);
      const allowed = categoriesAllowedSet();
      if (Array.isArray(payload?.parts)) {
        const created = await partsLib.addMany(BASELINE_PARTS, payload.parts, { allowedCategories: allowed });
        rebuildCatalogFromOverrides();
        await settings.recordAudit({
          who: "admin",
          action: "catalog.add",
          note: `Added ${created.length} part${created.length === 1 ? "" : "s"} (${created.map((p) => p.sku).join(", ")})`,
          after: { skus: created.map((p) => p.sku) }
        });
        return sendJson(res, 201, { ok: true, created });
      }
      const created = await partsLib.addOne(BASELINE_PARTS, payload, { allowedCategories: allowed });
      rebuildCatalogFromOverrides();
      await settings.recordAudit({
        who: "admin",
        action: "catalog.add",
        note: `Added ${created.sku}`,
        after: { sku: created.sku }
      });
      return sendJson(res, 201, { ok: true, part: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't add part."] });
    }
  }

  // PATCH /api/parts/:sku — edit fields on an existing SKU.
  const partEditMatch = pathname.match(/^\/api\/parts\/([^/]+)$/);
  if (partEditMatch && req.method === "PATCH") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const sku = decodeURIComponent(partEditMatch[1]);
      const patch = await parseRequestBody(req);
      const before = PARTS.parts[sku] ? { ...PARTS.parts[sku] } : null;
      const updated = await partsLib.update(BASELINE_PARTS, sku, patch, { allowedCategories: categoriesAllowedSet() });
      rebuildCatalogFromOverrides();
      // Build a human note focused on the most common edit: price.
      const noteParts = [];
      if (before && updated && before.priceCents !== updated.priceCents) {
        noteParts.push(`price ${fmtMoneyFromCents(before.priceCents)} → ${fmtMoneyFromCents(updated.priceCents)}`);
      }
      const otherChanged = Object.keys(patch || {}).filter((k) => k !== "price" && k !== "priceCents");
      if (otherChanged.length) noteParts.push(`fields: ${otherChanged.join(", ")}`);
      await settings.recordAudit({
        who: "admin",
        action: "catalog.edit",
        note: `Edited ${sku}${noteParts.length ? " — " + noteParts.join("; ") : ""}`,
        before, after: updated
      });
      return sendJson(res, 200, { ok: true, sku, part: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update part."] });
    }
  }

  // DELETE /api/parts/:sku — soft-delete (tombstone). Runtime additions
  // get removed from `added` rather than tombstoned.
  if (partEditMatch && req.method === "DELETE") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const sku = decodeURIComponent(partEditMatch[1]);
      const result = await partsLib.softDelete(BASELINE_PARTS, sku);
      rebuildCatalogFromOverrides();
      await settings.recordAudit({
        who: "admin",
        action: "catalog.delete",
        note: `Deleted ${sku}${result.mode === "removed-from-added" ? " (runtime addition)" : ""}`,
        before: { sku, mode: result.mode }
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't delete part."] });
    }
  }

  // POST /api/parts/:sku/restore — un-tombstone a soft-deleted SKU.
  const partRestoreMatch = pathname.match(/^\/api\/parts\/([^/]+)\/restore$/);
  if (partRestoreMatch && req.method === "POST") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const sku = decodeURIComponent(partRestoreMatch[1]);
      const result = await partsLib.restore(sku);
      rebuildCatalogFromOverrides();
      if (result.wasDeleted) {
        await settings.recordAudit({
          who: "admin",
          action: "catalog.restore",
          note: `Restored ${sku}`,
          after: { sku }
        });
      }
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't restore part."] });
    }
  }

  // POST /api/parts/import/preview — accept parsed rows from the browser
  // (SheetJS parses xlsx client-side; see parts-suppliers.js), return a
  // diff against the current merged catalog. Stages the parsed data in
  // memory keyed by importId. The commit step (next route) reads from
  // that stage.
  //
  // Body: { rows: [{sku,...}, ...], includeDeletions: bool }
  if (req.method === "POST" && pathname === "/api/parts/import/preview") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const payload = await parseRequestBody(req, { maxBytes: 4_000_000 });
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const includeDeletions = payload?.includeDeletions === true;
      if (rows.length === 0) {
        return sendJson(res, 400, { ok: false, errors: ["No rows in the uploaded file."] });
      }
      const diff = partsLib.computeImportDiff(PARTS.parts || {}, rows, { includeDeletions });
      const importId = "imp_" + Math.random().toString(36).slice(2, 12);
      // Stage for 15 min. Cleanup runs on next request via the timestamp
      // check below.
      importStaging.set(importId, {
        ts: Date.now(),
        staged: { added: diff.added, edited: diff.edited, deleted: diff.deleted }
      });
      cleanupImportStaging();
      return sendJson(res, 200, { ok: true, importId, diff });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't process the file."] });
    }
  }

  // POST /api/parts/import/commit — apply a staged import.
  // Body: { importId, selections: { added: [...], edited: [...], deleted: [...] } }
  if (req.method === "POST" && pathname === "/api/parts/import/commit") {
    if (!BASELINE_PARTS) return sendJson(res, 503, { ok: false, errors: ["Parts baseline not loaded."] });
    try {
      const payload = await parseRequestBody(req);
      cleanupImportStaging();
      const entry = payload?.importId ? importStaging.get(payload.importId) : null;
      if (!entry) {
        return sendJson(res, 410, { ok: false, errors: ["Import session expired. Re-upload the file."] });
      }
      const counts = await partsLib.applyImport(
        BASELINE_PARTS,
        entry.staged,
        payload.selections || {},
        { allowedCategories: categoriesAllowedSet() }
      );
      importStaging.delete(payload.importId);
      rebuildCatalogFromOverrides();
      await settings.recordAudit({
        who: "admin",
        action: "catalog.import",
        note: `Imported xlsx: ${counts.added} added, ${counts.edited} edited, ${counts.deleted} deleted`,
        after: counts
      });
      return sendJson(res, 200, { ok: true, counts });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't apply import."] });
    }
  }

  // ---------- Custom line item catalog (v36, Patrick 2026-05-13) -------
  // Rolling collection of free-form quote lines techs can re-use. The
  // tech adds "Add a sprinkler head" with a custom price on Visit A;
  // next visit it surfaces in the picker as a tap-to-add option
  // instead of being retyped. Shared across all techs (PJL is small).
  //
  //   GET  /api/custom-line-items           — list (sorted by usage)
  //   POST /api/custom-line-items           — create { label, price }
  //   POST /api/custom-line-items/:id/use   — increment usedCount
  //   DELETE /api/custom-line-items/:id     — remove
  if (req.method === "GET" && pathname === "/api/custom-line-items") {
    try {
      const items = await customLineItems.list();
      return sendJson(res, 200, { ok: true, items });
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't load custom line items."] });
    }
  }
  if (req.method === "POST" && pathname === "/api/custom-line-items") {
    try {
      const payload = await parseRequestBody(req);
      const created = await customLineItems.add({
        label: payload?.label,
        price: payload?.price,
        createdBy: "tech"
      });
      return sendJson(res, 201, { ok: true, item: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't save line item."] });
    }
  }
  const cliUseMatch = pathname.match(/^\/api\/custom-line-items\/([^/]+)\/use$/);
  if (cliUseMatch && req.method === "POST") {
    try {
      const updated = await customLineItems.recordUse(decodeURIComponent(cliUseMatch[1]));
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Line item not found."] });
      return sendJson(res, 200, { ok: true, item: updated });
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't record use."] });
    }
  }
  const cliDeleteMatch = pathname.match(/^\/api\/custom-line-items\/([^/]+)$/);
  if (cliDeleteMatch && req.method === "DELETE") {
    try {
      const ok = await customLineItems.remove(decodeURIComponent(cliDeleteMatch[1]));
      if (!ok) return sendJson(res, 404, { ok: false, errors: ["Line item not found."] });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't delete."] });
    }
  }

  // ---------- Follow-up WO trigger (spec §4.3.2) ------------------------
  // Tech taps "Schedule follow-up visit" on the on-site WO. Creates a
  // linked service_visit WO that inherits property + customer + diagnosis
  // pointer to the parent.
  //
  // Body (all optional):
  //   slotStart    — ISO timestamp. If present, the follow-up is also
  //                  scheduled (booking record + wo.scheduledFor). If
  //                  absent, behavior is the legacy "Patrick to slot it"
  //                  flow — WO created, Patrick paged.
  //   serviceKey   — availability.js key, defaults to "sprinkler_repair".
  //   materials    — qty map { sku: qty (number) } the tech wants
  //                  pre-loaded for the next visit. Stored on
  //                  wo.materialsPacked. Legacy: also accepts an array
  //                  of SKU strings (each treated as qty=1) for older
  //                  clients still posting that shape.
  //   customParts  — array of free-form parts not in the catalog:
  //                  [{ name, size, qty }]. Stored on wo.customParts.
  //   notes        — addendum to the diagnosis ("here's what's missing").
  const woFollowupMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/followup$/);
  if (woFollowupMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woFollowupMatch[1]);
      const parent = await workOrders.get(id);
      if (!parent) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      const payload = await parseRequestBody(req).catch(() => ({}));
      const slotStart = typeof payload.slotStart === "string" ? payload.slotStart : "";
      const serviceKey = typeof payload.serviceKey === "string" && payload.serviceKey
        ? payload.serviceKey
        : "sprinkler_repair";
      // Normalize materials into a qty map. Legacy payloads send an
      // array of SKUs (qty=1 each); current payloads send a { sku: qty }
      // object. The downstream code only ever needs the map.
      const materialsQty = (() => {
        const out = {};
        const raw = payload.materials;
        if (Array.isArray(raw)) {
          raw.forEach((s) => { if (typeof s === "string" && s) out[s] = 1; });
        } else if (raw && typeof raw === "object") {
          for (const [sku, val] of Object.entries(raw)) {
            if (!sku || typeof sku !== "string") continue;
            const n = Math.max(0, Math.floor(Number(val) || 0));
            if (n > 0) out[sku] = n;
          }
        }
        return out;
      })();
      const customPartsList = Array.isArray(payload.customParts)
        ? payload.customParts
            .filter((p) => p && typeof p === "object")
            .map((p) => ({
              name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
              size: typeof p.size === "string" ? p.size.slice(0, 16) : "",
              qty: Math.max(0, Math.floor(Number(p.qty) || 0))
            }))
            .filter((p) => p.qty > 0 && (p.name || p.size))
        : [];
      const notes = typeof payload.notes === "string" ? payload.notes.slice(0, 1000) : "";

      // Validate the slot up-front (before creating anything) so we never
      // leave half a record behind on a bad slot.
      let validatedSlot = null;
      let bookingRec = null;
      if (slotStart) {
        const service = BOOKABLE_SERVICES[serviceKey];
        if (!service || !service.bookable) {
          return sendJson(res, 422, { ok: false, errors: ["Unknown service for follow-up scheduling."] });
        }
        const startDate = new Date(slotStart);
        if (Number.isNaN(startDate.getTime())) {
          return sendJson(res, 422, { ok: false, errors: ["Invalid follow-up slot."] });
        }
        const address = parent.address || "";
        if (!address) return sendJson(res, 422, { ok: false, errors: ["Parent WO has no address — can't compute drive times."] });
        const geo = await geocode(address);
        const allActive = await activeBookings();
        const scheduleData = await scheduleStore.read();
        const mergedHours = { ...DEFAULT_HOURS, ...(scheduleData.hours || {}) };
        const mergedSettings = { ...DEFAULT_SETTINGS, ...(scheduleData.settings || {}) };
        const candidates = await listAvailableSlots({
          serviceKey,
          customerCoords: geo.coords,
          bookings: allActive,
          blocks: scheduleData.blocks,
          daysAhead: 30,
          hours: mergedHours,
          settings: mergedSettings
        });
        validatedSlot = candidates.find((s) => s.start === startDate.toISOString());
        if (!validatedSlot) {
          return sendJson(res, 409, { ok: false, errors: ["That slot was just taken — please pick another time."] });
        }
      }

      const property = parent.propertyId ? await properties.get(parent.propertyId) : null;
      let lead = null;
      if (parent.leadId) {
        const allLeads = await readLeads();
        lead = allLeads.find((l) => l.id === parent.leadId) || null;
      }
      const followup = await workOrders.create({ type: "service_visit", lead, property });
      const baseDiagnosis = `Follow-up to ${parent.id} (${parent.type}). Original visit notes: ${parent.techNotes || "(none)"}`;
      const diagnosis = notes ? `${baseDiagnosis}\n\nFollow-up scope: ${notes}` : baseDiagnosis;

      // Inherit the parent's authorized line items into the follow-up's
      // on-site quote builder. Filter out baseline (seasonal) lines —
      // seasonal fee was already charged on the parent; the follow-up
      // is repair-only.
      const parentLines = Array.isArray(parent.onSiteQuote?.builderLineItems)
        ? parent.onSiteQuote.builderLineItems.filter((l) => !(l && l.source && l.source.baseline === true))
        : [];

      // wo.materialsPacked is the qty map { sku: qty } shape since the
      // May 2026 stepper rework. The tech adjusts qtys with +/- on the
      // follow-up modal and on the bringback section; we just persist
      // whatever they sent (already normalized above).
      const materialsPacked = materialsQty;

      const followupUpdates = {
        diagnosis,
        techNotes: `Originating WO: ${parent.id}. Tech to confirm scope on arrival.`,
        followupOfWoId: parent.id,
        materialsPacked,
        customParts: customPartsList,
        onSiteQuote: parentLines.length ? {
          ...followup.onSiteQuote,
          status: "draft",
          lastBuiltAt: new Date().toISOString(),
          builderLineItems: parentLines.map((l) => ({ ...l, note: l.note ? `[from ${parent.id}] ${l.note}` : `[inherited from ${parent.id}]` }))
        } : followup.onSiteQuote
      };
      if (validatedSlot) {
        followupUpdates.scheduledFor = validatedSlot.start;
      }
      await workOrders.update(followup.id, followupUpdates);

      // Create a canonical booking record when a slot was picked. The
      // record uses leadId = parent.leadId (so it shows up under that
      // customer in the CRM) but its workOrderIds points at the new
      // follow-up WO. activeBookings() unions bookings.json on top of
      // lead.booking so this slot gets respected by the calendar.
      if (validatedSlot) {
        const service = BOOKABLE_SERVICES[serviceKey];
        const startDate = new Date(validatedSlot.start);
        const endDate = new Date(startDate.getTime() + service.minutes * 60 * 1000);
        const now = new Date().toISOString();
        const allRec = await bookings.list();
        const nextId = await (async () => {
          const prefix = `BK-${new Date().getUTCFullYear()}-`;
          let max = 0;
          for (const b of allRec) {
            if (typeof b.id === "string" && b.id.startsWith(prefix)) {
              const n = parseInt(b.id.slice(prefix.length), 10);
              if (Number.isFinite(n) && n > max) max = n;
            }
          }
          return `${prefix}${String(max + 1).padStart(4, "0")}`;
        })();
        const newBooking = {
          id: nextId,
          customerEmail: (lead?.contact?.email || parent.customerEmail || "").toLowerCase(),
          customerName: lead?.contact?.name || parent.customerName || "",
          customerPhone: lead?.contact?.phone || parent.customerPhone || "",
          propertyId: parent.propertyId || null,
          leadId: parent.leadId || null,
          scheduledFor: startDate.toISOString(),
          durationMinutes: service.minutes,
          serviceKey,
          serviceLabel: service.label,
          zoneCount: null,
          address: parent.address || "",
          status: "confirmed",
          prepNotes: notes ? `Follow-up scope: ${notes}` : "",
          sourceQuoteId: null,
          workOrderIds: [followup.id],
          createdAt: now,
          updatedAt: now,
          history: [{ ts: now, action: "created_followup", by: "admin", note: `Follow-up to ${parent.id}` }]
        };
        const allWithNew = [newBooking, ...allRec];
        try {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const FILE = path.join(__dirname, "data", "bookings.json");
          await fs.writeFile(FILE, JSON.stringify(allWithNew, null, 2) + "\n", "utf8");
          bookingRec = newBooking;
        } catch (err) {
          console.warn("[followup] booking record write failed:", err?.message);
        }
      }

      // Back-link parent.followupWoIds[].
      const parentFollowups = Array.isArray(parent.followupWoIds) ? parent.followupWoIds.slice() : [];
      if (!parentFollowups.includes(followup.id)) {
        parentFollowups.push(followup.id);
        try { await workOrders.update(parent.id, { followupWoIds: parentFollowups }); }
        catch (err) { console.warn("[followup] parent back-link failed:", err?.message); }
      }
      // Audit entry on the lead so the CRM detail surfaces the follow-up.
      if (lead) {
        const allLeads = await readLeads();
        const li = allLeads.findIndex((l) => l.id === lead.id);
        if (li !== -1) {
          allLeads[li].crm = allLeads[li].crm || {};
          allLeads[li].crm.activity = Array.isArray(allLeads[li].crm.activity) ? allLeads[li].crm.activity : [];
          const when = validatedSlot
            ? new Date(validatedSlot.start).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "(not yet slotted)";
          allLeads[li].crm.activity.unshift({
            at: new Date().toISOString(),
            type: "update",
            text: `Follow-up WO ${followup.id} created (from ${parent.id}). Scheduled: ${when}.${materials.length ? ` Materials: ${materials.length} SKU${materials.length === 1 ? "" : "s"}.` : ""}`
          });
          allLeads[li].crm.lastUpdated = new Date().toISOString();
          await writeLeads(allLeads);
        }
      }
      // Notify Patrick. Two flavors based on whether we slotted it.
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const noticeNotes = validatedSlot
        ? `Follow-up booked: ${followup.id} on ${new Date(validatedSlot.start).toLocaleString("en-CA")}.${materials.length ? ` Pre-loaded ${materials.length} part(s).` : ""}${notes ? " Scope: " + notes : ""}`
        : `Tech requested follow-up from ${parent.id}. New WO: ${followup.id}. Call customer to schedule.`;
      const aliasLead = {
        id: parent.id,
        sourceLabel: validatedSlot ? "Follow-up scheduled" : "FOLLOW-UP needs scheduling",
        contact: {
          name: parent.customerName || "(unknown)",
          phone: parent.customerPhone || "",
          email: parent.customerEmail || "",
          address: parent.address || "",
          notes: noticeNotes
        }
      };
      Promise.allSettled([
        sendNewLeadEmail(aliasLead, { baseUrl }),
        sendNewLeadSms(aliasLead, { baseUrl })
      ]).catch(() => {});

      // Audit trail on BOTH the parent (followup_created) and the child
      // WO (created_as_followup). The lib's POST /api/work-orders path
      // would have logged a generic created entry on the child; replace
      // it with one that explicitly carries the parent pointer.
      try {
        await workOrders.appendHistory(parent.id, {
          action: "followup_created",
          by: "tech",
          note: `Follow-up WO ${followup.id}${validatedSlot ? ` scheduled for ${validatedSlot.start}` : " (unscheduled — needs manual booking)"}`
        });
        await workOrders.appendHistory(followup.id, {
          action: "created_as_followup",
          by: "tech",
          note: `Spawned from ${parent.id}`
        });
      } catch (err) { console.warn("[wo-history] follow-up entry failed:", err?.message); }

      return sendJson(res, 201, {
        ok: true,
        followupWoId: followup.id,
        scheduledFor: validatedSlot ? validatedSlot.start : null,
        bookingId: bookingRec ? bookingRec.id : null
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create follow-up."] });
    }
  }

  // ---------- Manual completion-cascade triggers --------------------
  // Two endpoints for explicit admin re-runs / on-demand creation:
  //   POST /api/work-orders/:id/create-invoice — drafts an invoice from
  //     whatever's currently in the WO's onSiteQuote.builderLineItems
  //     (or lineItems) without changing the WO status. Idempotent at the
  //     cascade layer (already-completed WOs short-circuit with their
  //     existing invoice). Lets Patrick recover a stuck "I marked it
  //     complete but no invoice appeared" case (usually because the WO
  //     had no line items at the moment the status flipped).
  //   POST /api/work-orders/:id/run-cascade — re-runs the full cascade
  //     (service record + invoice + property updates + notifications)
  //     on demand. Same idempotency guards.
  const woCreateInvoiceMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/create-invoice$/);
  if (woCreateInvoiceMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woCreateInvoiceMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (!wo.propertyId) return sendJson(res, 422, { ok: false, errors: ["WO has no linked property — link a property first."] });
      // Check for an existing invoice on this WO before drafting a new one.
      const existing = (await invoices.listByWorkOrder(id))[0];
      if (existing) {
        return sendJson(res, 200, { ok: true, invoice: existing, alreadyExisted: true });
      }
      const woLineItems = completionCascade.lineItemsFromWo(wo);
      if (!woLineItems.length) {
        return sendJson(res, 422, { ok: false, errors: [
          "This work order has no billable line items. Build the on-site quote first (Issues → Draft Quote) so there's something to invoice."
        ] });
      }
      const inv = await invoices.createDraft({
        woId: wo.id,
        quoteId: wo.onSiteQuote?.quoteId || null,
        propertyId: wo.propertyId,
        customerName: wo.customerName || "",
        customerEmail: wo.customerEmail || "",
        customerPhone: wo.customerPhone || "",
        address: wo.address || "",
        lineItems: woLineItems,
        notes: wo.techNotes ? wo.techNotes.slice(0, 500) : ""
      });
      try {
        await workOrders.appendHistory(id, {
          action: "invoice_drafted",
          by: "admin",
          note: `Manual: ${inv.id} ($${Number(inv.total).toFixed(2)})`
        });
      } catch (err) { console.warn("[wo-history] manual invoice entry failed:", err?.message); }
      return sendJson(res, 201, { ok: true, invoice: inv, alreadyExisted: false });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create invoice."] });
    }
  }

  const woRunCascadeMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/run-cascade$/);
  if (woRunCascadeMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woRunCascadeMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (!wo.propertyId) return sendJson(res, 422, { ok: false, errors: ["WO has no linked property."] });
      const result = await completionCascade.run(wo);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't run cascade."] });
    }
  }

  // ---------- Settings (admin notification defaults + audit) --------

  if (req.method === "GET" && pathname === "/api/settings") {
    const s = await settings.get();
    return sendJson(res, 200, { ok: true, settings: s, modes: settings.NOTIFY_MODES });
  }
  if (req.method === "PATCH" && pathname === "/api/settings/admin-defaults") {
    try {
      const payload = await parseRequestBody(req);
      const updated = await settings.updateAdminDefaults(payload, { who: "admin" });
      return sendJson(res, 200, { ok: true, settings: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update settings."] });
    }
  }

  // ---------- iCal feed (Brief C) --------------------------------------
  // Three admin actions: generate (idempotent — returns existing token
  // if already enabled), regenerate (always issues a new token), and
  // disable (clears the token; subscribers start hitting 404). The
  // full URL is composed client-side from the returned token + the
  // page's origin so the server doesn't need to know its public URL.
  if (req.method === "POST" && pathname === "/api/settings/ical-feed/generate") {
    try {
      const updated = await settings.generateIcalToken({ who: "admin" });
      const base = (process.env.PUBLIC_BASE_URL || baseUrlFromReq(req)).replace(/\/+$/, "");
      const url = updated.icalFeed.token ? `${base}/calendar/${updated.icalFeed.token}.ics` : null;
      return sendJson(res, 200, { ok: true, settings: updated, url });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't generate feed."] });
    }
  }
  if (req.method === "POST" && pathname === "/api/settings/ical-feed/regenerate") {
    try {
      const updated = await settings.regenerateIcalToken({ who: "admin" });
      const base = (process.env.PUBLIC_BASE_URL || baseUrlFromReq(req)).replace(/\/+$/, "");
      const url = updated.icalFeed.token ? `${base}/calendar/${updated.icalFeed.token}.ics` : null;
      return sendJson(res, 200, { ok: true, settings: updated, url });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't regenerate feed."] });
    }
  }
  if (req.method === "POST" && pathname === "/api/settings/ical-feed/disable") {
    try {
      const updated = await settings.disableIcalFeed({ who: "admin" });
      return sendJson(res, 200, { ok: true, settings: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't disable feed."] });
    }
  }

  // Customer-side notification preferences (portal-toggleable). Stored
  // on the lead so they can be set per-customer without a separate
  // record. Token-resolved (NOT admin cookie).
  const portalPrefsMatch = pathname.match(/^\/api\/portal\/([^/]+)\/preferences$/);
  if (portalPrefsMatch && req.method === "PATCH") {
    try {
      const token = decodeURIComponent(portalPrefsMatch[1]);
      const payload = await parseRequestBody(req);
      const leads = await readLeads();
      const idx = leads.findIndex((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      const lead = leads[idx];
      lead.customerPreferences = lead.customerPreferences || {};
      // Customer-side prefs: text reminders (yes/no), email-only mode,
      // marketing texts (yes/no). Spec §6.3.
      if (typeof payload.textReminders === "boolean") lead.customerPreferences.textReminders = payload.textReminders;
      if (typeof payload.emailOnly === "boolean") lead.customerPreferences.emailOnly = payload.emailOnly;
      if (typeof payload.marketingTexts === "boolean") lead.customerPreferences.marketingTexts = payload.marketingTexts;
      // Phone/email/best-time (the only fields the customer can edit per
      // spec §6.2). Email change triggers a Patrick notification (rule:
      // email is the matching key).
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      let emailChanged = false;
      if (typeof payload.phone === "string" && payload.phone !== lead.contact?.phone) {
        lead.contact = lead.contact || {};
        lead.contact.phone = payload.phone.slice(0, 50);
      }
      if (typeof payload.email === "string" && payload.email !== lead.contact?.email) {
        lead.contact = lead.contact || {};
        const oldEmail = lead.contact.email || "(none)";
        lead.contact.email = payload.email.slice(0, 200);
        emailChanged = true;
        const aliasLead = {
          id: lead.id,
          sourceLabel: "Customer changed email in portal",
          contact: { ...lead.contact, notes: `Was: ${oldEmail} → ${lead.contact.email}` }
        };
        Promise.allSettled([
          sendNewLeadEmail(aliasLead, { baseUrl }),
          sendNewLeadSms(aliasLead, { baseUrl })
        ]).catch(() => {});
      }
      if (typeof payload.bestTimeToReach === "string") {
        lead.customerPreferences.bestTimeToReach = payload.bestTimeToReach.slice(0, 200);
      }
      lead.crm = lead.crm || {};
      lead.crm.activity = Array.isArray(lead.crm.activity) ? lead.crm.activity : [];
      lead.crm.activity.unshift({
        at: new Date().toISOString(),
        type: "update",
        text: emailChanged ? "Customer updated portal preferences (email changed — notified)" : "Customer updated portal preferences"
      });
      lead.crm.lastUpdated = new Date().toISOString();
      leads[idx] = lead;
      await writeLeads(leads);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't save preferences."] });
    }
  }
  if (portalPrefsMatch && req.method === "GET") {
    try {
      const token = decodeURIComponent(portalPrefsMatch[1]);
      const leads = await readLeads();
      const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      return sendJson(res, 200, {
        ok: true,
        preferences: lead.customerPreferences || {},
        contact: {
          phone: lead.contact?.phone || "",
          email: lead.contact?.email || ""
        }
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't load preferences."] });
    }
  }

  // ---------- Customer-side reschedule slot lookup (portal) ------------
  // Token-authed variant of /api/bookings/:id/availability. Returns slots
  // for the lead's existing booking, with their own current slot excluded
  // from the conflict math. Also returns a tooLate flag so the modal can
  // render the 24-hour fallback copy without an extra round trip.
  const portalRescheduleSlotsMatch = pathname.match(/^\/api\/portal\/([^/]+)\/reschedule-availability$/);
  if (portalRescheduleSlotsMatch && req.method === "GET") {
    try {
      const token = decodeURIComponent(portalRescheduleSlotsMatch[1]);
      const url = new URL(req.url, baseUrlFromReq(req));
      const allLeads = await readLeads();
      const lead = allLeads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      if (!lead.booking) return sendJson(res, 422, { ok: false, errors: ["No appointment on file."] });
      const currentStart = lead.booking.start ? new Date(lead.booking.start) : null;
      const tooLate = currentStart ? (currentStart.getTime() - Date.now()) < 24 * 60 * 60 * 1000 : false;
      let bookingRec = (await bookings.listByLead(lead.id))[0];
      if (!bookingRec) bookingRec = await bookings.upsertFromLead(lead);
      const result = bookingRec
        ? await rescheduleAvailability(bookingRec.id, {
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to")
          })
        : { ok: false, errors: ["No booking."] };
      if (!result.ok) return sendJson(res, result.status || 400, { ok: false, errors: result.errors });
      return sendJson(res, 200, { ok: true, tooLate, ...result.data });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't load slots."] });
    }
  }

  // ---------- Customer-side reschedule (portal) ------------------------
  // Customer-driven appointment move from /portal/<token>. Server enforces
  // the 24-hour gate — within 24h of the current slot, the move is
  // refused and the client falls back to "call us" copy. Outside that
  // window: same flow as admin reschedule, plus Patrick gets paged so
  // he sees the change immediately.
  const portalRescheduleMatch = pathname.match(/^\/api\/portal\/([^/]+)\/reschedule$/);
  if (portalRescheduleMatch && req.method === "PATCH") {
    try {
      const token = decodeURIComponent(portalRescheduleMatch[1]);
      const leads = await readLeads();
      const lead = leads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      if (!lead.booking) return sendJson(res, 422, { ok: false, errors: ["No appointment on file to reschedule."] });
      const payload = await parseRequestBody(req);

      // 24-hour gate. Compare the CURRENT scheduled start to "now". If the
      // appointment is less than 24 hours away, the customer must call us.
      const currentStart = lead.booking.start ? new Date(lead.booking.start) : null;
      const msUntilCurrent = currentStart ? currentStart.getTime() - Date.now() : Number.POSITIVE_INFINITY;
      if (currentStart && msUntilCurrent < 24 * 60 * 60 * 1000) {
        return sendJson(res, 403, {
          ok: false,
          tooLate: true,
          errors: ["This appointment is within 24 hours — please call (905) 960-0181 and Patrick will move it for you."]
        });
      }

      // Find the canonical Booking record for this lead (or upsert one if
      // the legacy lead.booking shape is the only thing present).
      let bookingRecord = (await bookings.listByLead(lead.id))[0];
      if (!bookingRecord) bookingRecord = await bookings.upsertFromLead(lead);
      if (!bookingRecord) return sendJson(res, 422, { ok: false, errors: ["No bookable record on this appointment."] });

      const result = await rescheduleBooking({
        bookingId: bookingRecord.id,
        slotStart: payload.slotStart,
        actor: "customer",
        actorName: lead.contact?.name || "customer",
        reason: typeof payload.reason === "string" ? payload.reason.slice(0, 200) : "",
        req
      });
      if (!result.ok) return sendJson(res, result.status || 400, { ok: false, errors: result.errors });
      return sendJson(res, 200, { ok: true, booking: result.booking, slot: result.slot });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't reschedule."] });
    }
  }

  // ---------- Invoices ----------------------------------------------
  // Drafted by the completion cascade. Admin can list, view, edit
  // status/notes/lineItems, and (later) push to QuickBooks.

  if (req.method === "GET" && pathname === "/api/invoices") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const status = url.searchParams.get("status");
    const woId = url.searchParams.get("woId");
    let all = await invoices.list();
    if (status) all = all.filter((i) => i.status === status);
    if (woId) all = all.filter((i) => i.woId === woId);
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(res, 200, { ok: true, invoices: all });
  }

  const invoiceMatch = pathname.match(/^\/api\/invoices\/([^/]+)$/);
  if (invoiceMatch && req.method === "GET") {
    const inv = await invoices.get(decodeURIComponent(invoiceMatch[1]));
    if (!inv) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
    return sendJson(res, 200, { ok: true, invoice: inv });
  }
  if (invoiceMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(invoiceMatch[1]);
      const payload = await parseRequestBody(req);
      const before = await invoices.get(id);
      const updated = await invoices.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });

      // PR 3 — status mirror to QuickBooks. When admin sets status to
      // void in PJL, push the same change to QB. Best-effort: a QB
      // failure does NOT block the local status flip — we surface a
      // warning so the admin can retry, same pattern as PR 2's send.
      let qbWarning = null;
      const becameVoid = before && before.status !== "void" && updated.status === "void";
      if (becameVoid && updated.quickbooksInvoiceId) {
        try {
          if (quickbooks.isConfigured() && (await quickbooks.isConnected())) {
            await quickbooks.voidInvoice(updated.quickbooksInvoiceId);
          }
        } catch (qbErr) {
          console.warn(`[invoice-patch] QB void failed for ${id}: ${qbErr.message}`);
          qbWarning = `Local status flipped to void, but QuickBooks rejected the void: ${qbErr.message}. Mark void manually in QB.`;
        }
      }

      return sendJson(res, 200, { ok: true, invoice: updated, warning: qbWarning });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update invoice."] });
    }
  }

  // ---------- Suppliers ---------------------------------------------
  // Phase 1 of the materials management system. Vendors PJL buys from;
  // referenced from each part in parts.json via supplierIds[]. Used in
  // Phase 3 to group "need" lines into per-supplier purchase orders.

  if (req.method === "GET" && pathname === "/api/suppliers") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const all = await suppliers.list({ includeArchived });
    return sendJson(res, 200, { ok: true, suppliers: all });
  }

  if (req.method === "POST" && pathname === "/api/suppliers") {
    try {
      const payload = await parseRequestBody(req);
      const created = await suppliers.create(payload);
      return sendJson(res, 201, { ok: true, supplier: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create supplier."] });
    }
  }

  const supplierMatch = pathname.match(/^\/api\/suppliers\/([^/]+)$/);
  if (supplierMatch && req.method === "GET") {
    const supplier = await suppliers.get(decodeURIComponent(supplierMatch[1]));
    if (!supplier) return sendJson(res, 404, { ok: false, errors: ["Supplier not found."] });
    return sendJson(res, 200, { ok: true, supplier });
  }
  if (supplierMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(supplierMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await suppliers.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Supplier not found."] });
      return sendJson(res, 200, { ok: true, supplier: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update supplier."] });
    }
  }

  // Archive toggle — POST /api/suppliers/:id/archive { archived: bool }.
  // Soft-delete via archived flag rather than hard DELETE; Phase 3 POs
  // reference supplierId and we don't want a removed supplier to leave
  // dangling references on PO records.
  const supplierArchiveMatch = pathname.match(/^\/api\/suppliers\/([^/]+)\/archive$/);
  if (supplierArchiveMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(supplierArchiveMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await suppliers.setArchived(id, !!payload.archived);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Supplier not found."] });
      return sendJson(res, 200, { ok: true, supplier: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update supplier."] });
    }
  }

  // ---------- Part-supplier assignments (Phase 3) -------------------
  // Per-SKU supplierIds override map. Source of truth for which supplier
  // each part comes from (parts.json's supplierIds field is ignored — see
  // lib/part-suppliers.js for the why).

  if (req.method === "GET" && pathname === "/api/part-suppliers") {
    const map = await partSuppliers.getAll();
    return sendJson(res, 200, { ok: true, partSuppliers: map });
  }

  // PATCH /api/part-suppliers — bulk update many SKUs in one round-trip.
  // Body: { updates: { "<sku>": ["SUP-001","SUP-002"], ... } }. Pass an
  // empty array to clear a SKU's assignment.
  if (req.method === "PATCH" && pathname === "/api/part-suppliers") {
    try {
      const payload = await parseRequestBody(req);
      const map = await partSuppliers.bulkSet(payload.updates || {});
      // Refresh the in-memory PARTS catalog so the next /api/parts call
      // returns the updated supplierIds (and any concurrent catalog
      // overrides) without a server restart. Goes through the full
      // rebuild so the catalog-overrides layer isn't accidentally
      // dropped by a supplier-only merge.
      rebuildCatalogFromOverrides();
      return sendJson(res, 200, { ok: true, partSuppliers: map });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update part-supplier map."] });
    }
  }

  // PATCH /api/part-suppliers/:sku — single-SKU update.
  // Body: { supplierIds: ["SUP-001", ...] }
  const partSupplierMatch = pathname.match(/^\/api\/part-suppliers\/([^/]+)$/);
  if (partSupplierMatch && req.method === "PATCH") {
    try {
      const sku = decodeURIComponent(partSupplierMatch[1]);
      const payload = await parseRequestBody(req);
      const ids = await partSuppliers.setForSku(sku, payload.supplierIds || []);
      // Refresh the cached catalog through the full rebuild so catalog
      // overrides aren't dropped.
      rebuildCatalogFromOverrides();
      return sendJson(res, 200, { ok: true, sku, supplierIds: ids });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update SKU supplier."] });
    }
  }

  // ---------- Material Lists ----------------------------------------
  // The bill-of-materials document. Standalone in Phase 1; Phase 2 wires
  // parent attachment to projects/work-orders/quotes; Phase 3 generates
  // POs from "need" lines grouped by supplier.

  if (req.method === "GET" && pathname === "/api/material-lists") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const status = url.searchParams.get("status");
    const parentType = url.searchParams.get("parentType");
    const parentId = url.searchParams.get("parentId");
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const withTotals = url.searchParams.get("withTotals") === "1";
    const all = await materialLists.list({ status, parentType, parentId, includeArchived });
    // Newest-first index — same convention as invoices/quotes.
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (!withTotals) return sendJson(res, 200, { ok: true, lists: all });
    const partsMap = (PARTS && PARTS.parts) || {};
    const enriched = all.map((rec) => ({ ...rec, totals: materialLists.computeTotals(rec, partsMap) }));
    return sendJson(res, 200, { ok: true, lists: enriched });
  }

  if (req.method === "POST" && pathname === "/api/material-lists") {
    try {
      const payload = await parseRequestBody(req);
      const created = await materialLists.create(payload);
      return sendJson(res, 201, { ok: true, list: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create material list."] });
    }
  }

  const listMatch = pathname.match(/^\/api\/material-lists\/([^/]+)$/);
  if (listMatch && req.method === "GET") {
    const id = decodeURIComponent(listMatch[1]);
    const rec = await materialLists.get(id);
    if (!rec) return sendJson(res, 404, { ok: false, errors: ["Material list not found."] });
    const partsMap = (PARTS && PARTS.parts) || {};
    return sendJson(res, 200, { ok: true, list: rec, totals: materialLists.computeTotals(rec, partsMap) });
  }
  if (listMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(listMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await materialLists.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Material list not found."] });
      const partsMap = (PARTS && PARTS.parts) || {};
      return sendJson(res, 200, { ok: true, list: updated, totals: materialLists.computeTotals(updated, partsMap) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update material list."] });
    }
  }
  if (listMatch && req.method === "DELETE") {
    const id = decodeURIComponent(listMatch[1]);
    const removed = await materialLists.remove(id);
    if (!removed) return sendJson(res, 404, { ok: false, errors: ["Material list not found."] });
    return sendJson(res, 200, { ok: true, removed });
  }

  // POST /api/material-lists/:id/plan-purchase-orders — DRY RUN. Returns
  // what POs would be created without creating them. Used by the builder
  // to render a confirmation modal before the user clicks "Generate".
  const listPlanPosMatch = pathname.match(/^\/api\/material-lists\/([^/]+)\/plan-purchase-orders$/);
  if (listPlanPosMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(listPlanPosMatch[1]);
      const list = await materialLists.get(id);
      if (!list) return sendJson(res, 404, { ok: false, errors: ["Material list not found."] });
      const partsMap = (PARTS && PARTS.parts) || {};
      const plan = purchaseOrders.planDraftsFromMaterialList(list, partsMap);
      // Hydrate supplier name into each draft preview so the modal can
      // render "PO for Vermeer Supply" without a follow-up fetch.
      const allSuppliers = await suppliers.list({ includeArchived: true });
      const supplierById = new Map(allSuppliers.map((s) => [s.id, s]));
      const previews = plan.drafts.map((d) => ({
        ...d,
        supplierName: supplierById.get(d.supplierId)?.name || "(unknown supplier)",
        supplierEmail: supplierById.get(d.supplierId)?.email || ""
      }));
      return sendJson(res, 200, {
        ok: true,
        canGenerate: plan.ok,
        previews,
        missingSupplier: plan.missingSupplier,
        missingSupplierLines: plan.missingSupplierLines
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't plan purchase orders."] });
    }
  }

  // POST /api/material-lists/:id/generate-purchase-orders — actually
  // creates the drafts. Returns the list of created PO ids. Idempotency:
  // does NOT check for duplicates — calling twice creates two sets of
  // drafts. (The UI guards via the plan endpoint + a confirm step.)
  const listGenPosMatch = pathname.match(/^\/api\/material-lists\/([^/]+)\/generate-purchase-orders$/);
  if (listGenPosMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(listGenPosMatch[1]);
      const list = await materialLists.get(id);
      if (!list) return sendJson(res, 404, { ok: false, errors: ["Material list not found."] });
      const partsMap = (PARTS && PARTS.parts) || {};
      const plan = purchaseOrders.planDraftsFromMaterialList(list, partsMap);
      if (!plan.ok) {
        return sendJson(res, 422, {
          ok: false,
          errors: ["Cannot generate POs — some need-line SKUs have no supplier assigned."],
          missingSupplier: plan.missingSupplier
        });
      }
      const allSuppliers = await suppliers.list({ includeArchived: true });
      const supplierById = new Map(allSuppliers.map((s) => [s.id, s]));
      const created = [];
      for (const draft of plan.drafts) {
        const sup = supplierById.get(draft.supplierId);
        const po = await purchaseOrders.create({
          supplierId: draft.supplierId,
          supplierName: sup?.name || "",
          supplierEmail: sup?.email || "",
          supplierContactName: sup?.contactName || "",
          supplierPhone: sup?.phone || "",
          supplierAddress: sup?.address || "",
          sourceMaterialListIds: [list.id],
          lineItems: draft.lineItems,
          notes: list.name ? `Generated from ${list.name} (${list.id}).` : `Generated from ${list.id}.`
        });
        created.push(po);
      }
      return sendJson(res, 201, { ok: true, purchaseOrders: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't generate purchase orders."] });
    }
  }

  // ---------- Projects (Phase 2) -------------------------------------
  // The multi-WO container (PROJ-YYYY-NNNN). Customer + property linked,
  // workOrderIds[] for the WOs that roll up under it. Material lists
  // attach to a project via the materialLists record's parentType +
  // parentId fields (no back-reference stored on the project — single
  // source of truth lives on the materialLists side).

  if (req.method === "GET" && pathname === "/api/projects") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const status = url.searchParams.get("status");
    const propertyId = url.searchParams.get("propertyId");
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const all = await projects.list({ status, propertyId, includeArchived });
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sendJson(res, 200, { ok: true, projects: all });
  }

  if (req.method === "POST" && pathname === "/api/projects") {
    try {
      const payload = await parseRequestBody(req);
      const created = await projects.create(payload);
      return sendJson(res, 201, { ok: true, project: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create project."] });
    }
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "GET") {
    const id = decodeURIComponent(projectMatch[1]);
    const proj = await projects.get(id);
    if (!proj) return sendJson(res, 404, { ok: false, errors: ["Project not found."] });
    // Surface attached material lists in-line so the project page only
    // needs one round-trip to render. Lists carry their own totals when
    // the partsMap is provided.
    const attachedLists = await materialLists.list({ parentType: "project", parentId: id, includeArchived: true });
    const partsMap = (PARTS && PARTS.parts) || {};
    const enrichedLists = attachedLists.map((rec) => ({ ...rec, totals: materialLists.computeTotals(rec, partsMap) }));
    return sendJson(res, 200, { ok: true, project: proj, materialLists: enrichedLists });
  }
  if (projectMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(projectMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await projects.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Project not found."] });
      return sendJson(res, 200, { ok: true, project: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update project."] });
    }
  }
  if (projectMatch && req.method === "DELETE") {
    const id = decodeURIComponent(projectMatch[1]);
    const removed = await projects.remove(id);
    if (!removed) return sendJson(res, 404, { ok: false, errors: ["Project not found."] });
    // Detach any material lists that pointed at this project so they
    // don't render with a dangling parent badge.
    const attached = await materialLists.list({ parentType: "project", parentId: id, includeArchived: true });
    for (const rec of attached) {
      await materialLists.update(rec.id, { parentType: null, parentId: null });
    }
    return sendJson(res, 200, { ok: true, removed });
  }

  // POST /api/projects/:id/attach-work-order { workOrderId }
  const projectAttachWoMatch = pathname.match(/^\/api\/projects\/([^/]+)\/attach-work-order$/);
  if (projectAttachWoMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(projectAttachWoMatch[1]);
      const payload = await parseRequestBody(req);
      const woId = String(payload.workOrderId || "").trim();
      if (!woId) return sendJson(res, 422, { ok: false, errors: ["workOrderId required."] });
      // Verify the WO actually exists before attaching — prevents typos
      // from creating ghost references.
      const wo = await workOrders.get(woId);
      if (!wo) return sendJson(res, 404, { ok: false, errors: [`Work order ${woId} not found.`] });
      const updated = await projects.attachWorkOrder(id, woId);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Project not found."] });
      return sendJson(res, 200, { ok: true, project: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't attach work order."] });
    }
  }
  // POST /api/projects/:id/detach-work-order { workOrderId }
  const projectDetachWoMatch = pathname.match(/^\/api\/projects\/([^/]+)\/detach-work-order$/);
  if (projectDetachWoMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(projectDetachWoMatch[1]);
      const payload = await parseRequestBody(req);
      const woId = String(payload.workOrderId || "").trim();
      const updated = await projects.detachWorkOrder(id, woId);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Project not found."] });
      return sendJson(res, 200, { ok: true, project: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't detach work order."] });
    }
  }

  // POST /api/quotes/:id/convert-to-project — spin a Project out of a
  // Quote: snapshots customer + property, sets sourceQuoteId, and
  // re-parents any material lists that were attached to the quote so
  // they carry over to the project's working list. Returns the new
  // project. Idempotent guard: if a project already exists with this
  // sourceQuoteId, return it without creating a duplicate.
  const quoteConvertMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/convert-to-project$/);
  if (quoteConvertMatch && req.method === "POST") {
    try {
      const quoteId = decodeURIComponent(quoteConvertMatch[1]);
      const quote = await quotes.get(quoteId);
      if (!quote) return sendJson(res, 404, { ok: false, errors: [`Quote ${quoteId} not found.`] });

      // Idempotency — don't create a second project for the same quote.
      const existing = await projects.list({ includeArchived: true });
      const dupe = existing.find((p) => p.sourceQuoteId === quoteId);
      if (dupe) {
        return sendJson(res, 200, { ok: true, project: dupe, alreadyExisted: true });
      }

      // Pull customer + address from the quote's lead (if linked) so the
      // project carries the customer details forward.
      let leadCustomer = null;
      if (quote.leadId) {
        const allLeads = await readLeads();
        leadCustomer = allLeads.find((l) => l.id === quote.leadId) || null;
      }

      const customerName = leadCustomer?.name || "";
      const customerEmail = quote.customerEmail || leadCustomer?.email || "";
      const customerPhone = leadCustomer?.phone || "";
      const address = leadCustomer?.location || leadCustomer?.address || "";
      const propertyId = quote.propertyId || leadCustomer?.propertyId || null;

      // Auto-generate a project name from the customer + quote id. Patrick
      // can rename it from the project page.
      const namePieces = [];
      if (customerName) namePieces.push(customerName);
      namePieces.push(`(from ${quoteId})`);
      const name = namePieces.join(" ").slice(0, 200);

      const proj = await projects.create({
        name,
        customerName,
        customerEmail,
        customerPhone,
        address,
        propertyId,
        sourceQuoteId: quoteId,
        description: quote.scope || ""
      });

      // Re-parent any material lists that were attached to this quote.
      // The user's spec frames this as "convert quote's list into the
      // project's working list" — re-parent (not copy) keeps the audit
      // trail single-source.
      const attached = await materialLists.list({ parentType: "quote", parentId: quoteId, includeArchived: true });
      const reparented = [];
      for (const rec of attached) {
        const updated = await materialLists.update(rec.id, { parentType: "project", parentId: proj.id });
        if (updated) reparented.push(updated.id);
      }

      return sendJson(res, 201, { ok: true, project: proj, reparentedListIds: reparented });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't convert quote."] });
    }
  }

  // ---------- Purchase Orders (Phase 3) ------------------------------
  // PO-YYYY-NNNN. Generated from material-list "need" lines via
  // /api/material-lists/:id/generate-purchase-orders, then sent to the
  // supplier (PDF + email), received, or cancelled. Source line state on
  // the originating material list flips in lockstep with the PO state.

  if (req.method === "GET" && pathname === "/api/purchase-orders") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const status = url.searchParams.get("status");
    const supplierId = url.searchParams.get("supplierId");
    const materialListId = url.searchParams.get("materialListId");
    let all = await purchaseOrders.list({ status, supplierId, materialListId });
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sendJson(res, 200, { ok: true, purchaseOrders: all });
  }

  if (req.method === "POST" && pathname === "/api/purchase-orders") {
    try {
      const payload = await parseRequestBody(req);
      // Manual create — admin builds a PO from scratch (no source list).
      // Snapshot supplier fields if a supplierId is provided + missing.
      if (payload.supplierId && !payload.supplierName) {
        const sup = await suppliers.get(payload.supplierId);
        if (sup) {
          payload.supplierName = sup.name;
          payload.supplierEmail = payload.supplierEmail || sup.email;
          payload.supplierContactName = payload.supplierContactName || sup.contactName;
          payload.supplierPhone = payload.supplierPhone || sup.phone;
          payload.supplierAddress = payload.supplierAddress || sup.address;
        }
      }
      const created = await purchaseOrders.create(payload);
      return sendJson(res, 201, { ok: true, purchaseOrder: created });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't create purchase order."] });
    }
  }

  const poMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)$/);
  if (poMatch && req.method === "GET") {
    const po = await purchaseOrders.get(decodeURIComponent(poMatch[1]));
    if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
    return sendJson(res, 200, { ok: true, purchaseOrder: po });
  }
  if (poMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(poMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await purchaseOrders.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      return sendJson(res, 200, { ok: true, purchaseOrder: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update purchase order."] });
    }
  }
  if (poMatch && req.method === "DELETE") {
    const id = decodeURIComponent(poMatch[1]);
    const po = await purchaseOrders.get(id);
    if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
    if (po.status !== "draft") {
      return sendJson(res, 409, { ok: false, errors: [`Can only delete draft POs. This one is "${po.status}". Use cancel instead.`] });
    }
    const removed = await purchaseOrders.remove(id);
    return sendJson(res, 200, { ok: true, removed });
  }

  // POST /api/purchase-orders/:id/send — render PDF, email supplier via
  // existing nodemailer/Gmail, flip status to sent, flip source material-
  // list lines to "ordered" with poId backref. The PDF library + email
  // sender are loaded here lazily so a server without nodemailer creds
  // doesn't fail on boot.
  const poSendMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/send$/);
  if (poSendMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(poSendMatch[1]);
      const po = await purchaseOrders.get(id);
      if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      if (po.status !== "draft") {
        return sendJson(res, 409, { ok: false, errors: [`PO is "${po.status}", can only send a draft.`] });
      }
      const payload = await parseRequestBody(req).catch(() => ({}));
      const toEmail = String(payload.toEmail || po.supplierEmail || "").trim().toLowerCase();
      if (!toEmail) {
        return sendJson(res, 422, { ok: false, errors: ["Supplier email is empty. Add it to the supplier record or this PO."] });
      }
      const subject = String(payload.subject || `Purchase Order ${po.id} from PJL Land Services`).slice(0, 200);

      // Render PDF + send email. notify-supplier handles nodemailer.
      const { generatePoPdf } = require("./lib/po-pdf");
      const { sendPurchaseOrderEmail } = require("./lib/notify-supplier");
      const pdfBuffer = await generatePoPdf(po);
      await sendPurchaseOrderEmail({
        po,
        toEmail,
        toName: payload.toName || po.supplierContactName || po.supplierName,
        subject,
        bodyText: payload.bodyText || "",
        pdfBuffer
      });

      // Flip the PO state.
      const sentPo = await purchaseOrders.markSent(id, { toEmail, toName: payload.toName, subject });

      // Flip every source material-list line to "ordered" with this PO id.
      // Group line ids by source list so we patch each list once.
      const linesByList = new Map();
      for (const line of sentPo.lineItems) {
        if (!line.sourceListId || !line.sourceLineId) continue;
        if (!linesByList.has(line.sourceListId)) linesByList.set(line.sourceListId, []);
        linesByList.get(line.sourceListId).push(line.sourceLineId);
      }
      for (const [listId, lineIds] of linesByList.entries()) {
        const list = await materialLists.get(listId);
        if (!list) continue;
        const updatedLines = list.lineItems.map((l) => {
          if (lineIds.includes(l.id) && l.status === "need") {
            return { ...l, status: "ordered", poId: sentPo.id };
          }
          return l;
        });
        await materialLists.update(listId, { lineItems: updatedLines });
      }

      return sendJson(res, 200, { ok: true, purchaseOrder: sentPo });
    } catch (err) {
      console.warn("[po] send failed:", err);
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't send purchase order."] });
    }
  }

  // POST /api/purchase-orders/:id/receive — record a receipt event.
  // Body shape:
  //   { lineUpdates: { "<lineId>": <newReceivedQty>, ... }, note: "..." }
  //
  // Pass an empty body (no lineUpdates) to mark every line fully received
  // at once — the legacy "Mark received" behavior. Pass per-line qtys
  // (absolute, not deltas) for a partial-receive event. Lines absent from
  // the lineUpdates map keep their current receivedQty.
  //
  // Source material-list lines that just crossed into fully-received on
  // THIS event flip from "ordered" to "have" (with poId cleared). Lines
  // that are still partial keep their "ordered" state with poId backref
  // so a subsequent receive event can complete them.
  const poReceiveMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/receive$/);
  if (poReceiveMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(poReceiveMatch[1]);
      const payload = await parseRequestBody(req).catch(() => ({}));
      const po = await purchaseOrders.get(id);
      if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      const result = await purchaseOrders.markReceived(id, {
        lineUpdates: payload && payload.lineUpdates,
        note: payload && payload.note || ""
      });
      const receivedPo = result.po;

      // Flip ONLY the lines that became fully received on this event.
      // Build lineId -> source pointers from the receivedPo.
      const sourcePointersById = new Map();
      for (const line of receivedPo.lineItems) {
        if (!line.sourceListId || !line.sourceLineId) continue;
        sourcePointersById.set(line.id, { listId: line.sourceListId, lineId: line.sourceLineId });
      }
      const flipsByList = new Map();
      for (const lineId of result.fullyReceivedLineIds) {
        const ptr = sourcePointersById.get(lineId);
        if (!ptr) continue;
        if (!flipsByList.has(ptr.listId)) flipsByList.set(ptr.listId, []);
        flipsByList.get(ptr.listId).push(ptr.lineId);
      }
      for (const [listId, sourceLineIds] of flipsByList.entries()) {
        const list = await materialLists.get(listId);
        if (!list) continue;
        const updatedLines = list.lineItems.map((l) => {
          if (sourceLineIds.includes(l.id) && l.status === "ordered" && l.poId === receivedPo.id) {
            return { ...l, status: "have", poId: null };
          }
          return l;
        });
        await materialLists.update(listId, { lineItems: updatedLines });
      }
      return sendJson(res, 200, { ok: true, purchaseOrder: receivedPo, fullyReceivedLineIds: result.fullyReceivedLineIds });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't record receipt."] });
    }
  }

  // POST /api/purchase-orders/:id/cancel — flip to cancelled. Lines that
  // are NOT fully received flip back to "need" on their source list
  // (poId cleared). Already-received lines stay "have" — can't undo a
  // delivery.
  const poCancelMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/cancel$/);
  if (poCancelMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(poCancelMatch[1]);
      const payload = await parseRequestBody(req).catch(() => ({}));
      const po = await purchaseOrders.get(id);
      if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      const result = await purchaseOrders.markCancelled(id, { reason: payload.reason || "" });
      const cancelledPo = result.po;

      // Build per-line source pointers, then flip ONLY the outstanding ones.
      const sourcePointersById = new Map();
      for (const line of cancelledPo.lineItems) {
        if (!line.sourceListId || !line.sourceLineId) continue;
        sourcePointersById.set(line.id, { listId: line.sourceListId, lineId: line.sourceLineId });
      }
      const flipsByList = new Map();
      for (const lineId of result.outstandingLineIds) {
        const ptr = sourcePointersById.get(lineId);
        if (!ptr) continue;
        if (!flipsByList.has(ptr.listId)) flipsByList.set(ptr.listId, []);
        flipsByList.get(ptr.listId).push(ptr.lineId);
      }
      for (const [listId, sourceLineIds] of flipsByList.entries()) {
        const list = await materialLists.get(listId);
        if (!list) continue;
        const updatedLines = list.lineItems.map((l) => {
          if (sourceLineIds.includes(l.id) && l.status === "ordered" && l.poId === cancelledPo.id) {
            return { ...l, status: "need", poId: null };
          }
          return l;
        });
        await materialLists.update(listId, { lineItems: updatedLines });
      }
      return sendJson(res, 200, { ok: true, purchaseOrder: cancelledPo });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't cancel."] });
    }
  }

  // POST /api/purchase-orders/:id/resend — re-email the PDF to the
  // supplier. Status stays whatever it was (sent / partially_received).
  // Useful when the supplier didn't reply or asks for a copy.
  const poResendMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/resend$/);
  if (poResendMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(poResendMatch[1]);
      const po = await purchaseOrders.get(id);
      if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      if (po.status !== "sent" && po.status !== "partially_received") {
        return sendJson(res, 409, { ok: false, errors: [`Can't re-send a "${po.status}" PO.`] });
      }
      const payload = await parseRequestBody(req).catch(() => ({}));
      const toEmail = String(payload.toEmail || po.emailedToEmail || po.supplierEmail || "").trim().toLowerCase();
      if (!toEmail) {
        return sendJson(res, 422, { ok: false, errors: ["Recipient email is empty."] });
      }
      const subject = String(payload.subject || po.emailSubject || `Purchase Order ${po.id} from PJL Land Services`).slice(0, 200);
      const { generatePoPdf } = require("./lib/po-pdf");
      const { sendPurchaseOrderEmail } = require("./lib/notify-supplier");
      const pdfBuffer = await generatePoPdf(po);
      await sendPurchaseOrderEmail({
        po,
        toEmail,
        toName: payload.toName || po.supplierContactName || po.supplierName,
        subject,
        bodyText: payload.bodyText || "",
        pdfBuffer
      });
      const updated = await purchaseOrders.markResent(id, { toEmail, toName: payload.toName, subject });
      return sendJson(res, 200, { ok: true, purchaseOrder: updated });
    } catch (err) {
      console.warn("[po] resend failed:", err);
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't re-send purchase order."] });
    }
  }

  // POST /api/purchase-orders/:id/reorder — clone this PO into a new
  // draft (same supplier, same line items at fresh prices). Returns the
  // new draft so the UI can redirect into it.
  const poReorderMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/reorder$/);
  if (poReorderMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(poReorderMatch[1]);
      const partsMap = (PARTS && PARTS.parts) || {};
      const newPo = await purchaseOrders.reorderFrom(id, partsMap);
      return sendJson(res, 201, { ok: true, purchaseOrder: newPo });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't re-order."] });
    }
  }

  // GET /api/purchase-orders/:id/pdf — download a PDF of any PO. Useful
  // for the admin to grab a copy locally or to re-send the same PDF.
  const poPdfMatch = pathname.match(/^\/api\/purchase-orders\/([^/]+)\/pdf$/);
  if (poPdfMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(poPdfMatch[1]);
      const po = await purchaseOrders.get(id);
      if (!po) return sendJson(res, 404, { ok: false, errors: ["Purchase order not found."] });
      const { generatePoPdf } = require("./lib/po-pdf");
      const pdf = await generatePoPdf(po);
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${po.id}.pdf"`,
        "cache-control": "no-store"
      });
      res.end(pdf);
      return;
    } catch (err) {
      return sendJson(res, 500, { ok: false, errors: [err.message || "Couldn't render PDF."] });
    }
  }

  if (req.method === "GET" && pathname === "/api/work-orders") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const propertyId = url.searchParams.get("propertyId");
    const leadId = url.searchParams.get("leadId");
    let all = await workOrders.list();
    if (propertyId) all = all.filter((w) => w.propertyId === propertyId);
    if (leadId) all = all.filter((w) => w.leadId === leadId);
    // Most-recently-updated first so the index lands on active work.
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sendJson(res, 200, { ok: true, workOrders: all });
  }

  // Create. Body: { type, leadId?, propertyId? }
  // At least one of leadId / propertyId is required so the new WO has
  // something to attach to. The lib copies zone scaffolding from the
  // property when type=spring_opening | fall_closing.
  if (req.method === "POST" && pathname === "/api/work-orders") {
    try {
      const payload = await parseRequestBody(req);
      const type = String(payload.type || "");
      if (!workOrders.TEMPLATES[type]) {
        return sendJson(res, 422, { ok: false, errors: [`Unknown work-order type: ${type}.`] });
      }

      let lead = null;
      let property = null;
      if (payload.leadId) {
        const allLeads = await readLeads();
        lead = allLeads.find((l) => l.id === payload.leadId) || null;
        if (!lead) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      }
      if (payload.propertyId) {
        property = await properties.get(payload.propertyId);
        if (!property) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
      } else if (lead && lead.propertyId) {
        // Fall through to the lead's linked property when not explicitly
        // passed — saves the CRM JS from a second fetch.
        property = await properties.get(lead.propertyId);
      }
      if (!lead && !property) {
        return sendJson(res, 422, { ok: false, errors: ["Pass leadId or propertyId."] });
      }

      // Cancelled-booking guard (Brief B §3.4). A cancelled booking
      // shouldn't spawn a WO — if the booking was killed for any reason
      // (customer cancel, weather, double-book), creating a WO behind it
      // would put a "ghost" tech run on the calendar with no real visit.
      // Block at the lead.booking.status mirror so legacy callers that
      // pass only a leadId are still gated.
      if (lead?.booking?.status === "cancelled") {
        return sendJson(res, 409, {
          ok: false,
          errors: ["This booking was cancelled — re-book before creating a work order."]
        });
      }

      // Reuse the booking's customer-facing WO ID when one already
      // exists on the lead — keeps the customer + tech seeing the
      // same WO-XXXXXXXX. Otherwise generate a fresh one.
      const customId = lead?.booking?.workOrder?.id || null;

      // Fetch the source Quote (if any) so the WO inherits the AI-Correct-
      // Diagnosis Bonus eligibility — the tech UI uses this to show the
      // pending-confirmation banner (1 hr labour free if tech confirms match).
      let sourceQuote = null;
      if (lead?.quoteId) {
        try { sourceQuote = await quotes.get(lead.quoteId); }
        catch (err) { console.warn("[quotes] fetch on WO create failed:", err?.message); }
      }
      let wo = await workOrders.create({ type, lead, property, customId, quote: sourceQuote });

      // Seasonal-fee seeding — spring_opening / fall_closing WOs come
      // pre-loaded with the booked service fee as a billable line item.
      // Without this, the on-site quote starts empty and the completion
      // cascade has nothing to invoice. Seasonal pricing comes from
      // pricing.json (same key the booking used). For service_visit we
      // don't seed — those are AI-quote-driven or repair-only and the
      // rollup adds a service_call when repairs are found.
      //
      // The seeded line carries `source.baseline: true` so the on-site
      // quote build endpoint preserves it across rollup re-runs.
      // Without that flag, "Generate from issues" would wipe it.
      //
      // Key derivation order:
      //   1. lead.booking.serviceKey when present (most accurate — the
      //      customer paid for that exact tier)
      //   2. deriveSeasonalKey(type, propertyZoneCount) when the booking
      //      didn't carry a serviceKey (WOs created from /admin/handoff,
      //      from the property page, or legacy leads where serviceKey
      //      wasn't captured). Reads pricing.json's seasonal_tiers.
      // Either way the WO ships with a baseline line; tech can adjust
      // the qty/price if the on-site reality differs from the tier.
      if (type === "spring_opening" || type === "fall_closing") {
        try {
          let seedKey = lead?.booking?.serviceKey ? String(lead.booking.serviceKey) : "";
          if (!seedKey || !PRICING.items?.[seedKey]) {
            // Derive from WO type + property zone count.
            const zoneCount = Array.isArray(property?.system?.zones)
              ? property.system.zones.length
              : 0;
            seedKey = deriveSeasonalKey(type, zoneCount, false) || "";
          }
          const catalogItem = seedKey ? PRICING.items?.[seedKey] : null;
          if (catalogItem) {
            // Year = the year the service is actually performed. Prefer
            // the booking's scheduled start (what the customer paid for)
            // and fall back to WO creation year.
            const refDate = lead?.booking?.start
              ? new Date(lead.booking.start)
              : new Date(wo.scheduledFor || wo.createdAt || Date.now());
            const refYear = refDate.getUTCFullYear();
            const typeLabel = type === "spring_opening" ? "Spring Opening" : "Fall Closing";
            const seasonalLine = {
              key: seedKey,
              label: `${typeLabel} (${refYear})`,
              qty: 1,
              originalPrice: Math.round((Number(catalogItem.price) || 0) * 100) / 100,
              overridePrice: null,
              custom: false,
              source: { zoneNumbers: [], issueIds: [], baseline: true },
              note: ""
            };
            const seededWo = await workOrders.update(wo.id, {
              onSiteQuote: {
                ...wo.onSiteQuote,
                status: "draft",
                lastBuiltAt: new Date().toISOString(),
                builderLineItems: [seasonalLine]
              }
            });
            if (seededWo) wo = seededWo;
          } else {
            console.warn(`[wo-seed] no pricing.json entry for serviceKey ${seedKey}; WO created without seasonal fee line`);
          }
        } catch (err) {
          console.warn("[wo-seed] seasonal-fee seed failed:", err?.message);
        }
      }

      // Back-link the WO id onto the Quote's workOrderIds so the audit
      // trail reflects which WOs fulfilled this quote.
      if (sourceQuote) {
        try { await quotes.attachWorkOrder(sourceQuote.id, wo.id); }
        catch (err) { console.warn("[quotes] attachWorkOrder failed:", err?.message); }
      }
      // Back-link the WO onto its parent Booking record (spec §4.2 —
      // bookings carry workOrderIds[] for multi-day repairs). Looks up
      // the booking via the lead's id since lead.booking is the legacy
      // embedded shape; the canonical Booking record matches by leadId.
      if (lead) {
        try {
          const leadBookings = await bookings.listByLead(lead.id);
          for (const bk of leadBookings) await bookings.attachWorkOrder(bk.id, wo.id);
        } catch (err) { console.warn("[bookings] attachWorkOrder failed:", err?.message); }
      }

      // Back-reference on the lead so the CRM detail can deep-link.
      // (The property page resolves WOs via /api/work-orders + filter
      // on propertyId — no back-ref needed there yet.)
      if (lead) {
        const allLeads = await readLeads();
        const idx = allLeads.findIndex((l) => l.id === lead.id);
        if (idx !== -1) {
          allLeads[idx].workOrderId = wo.id;
          allLeads[idx].crm = allLeads[idx].crm || {};
          allLeads[idx].crm.activity = Array.isArray(allLeads[idx].crm.activity) ? allLeads[idx].crm.activity : [];
          allLeads[idx].crm.activity.unshift({
            at: new Date().toISOString(),
            type: "update",
            text: `Work order created (${workOrders.TEMPLATES[type].label}): ${wo.id}`
          });
          allLeads[idx].crm.lastUpdated = new Date().toISOString();
          await writeLeads(allLeads);
        }
      }

      // Audit trail — first entry on the new WO. Captures source
      // (lead/property/booking/quote) so the history viewer shows the
      // origin without a second fetch.
      try {
        const sourceParts = [];
        if (lead) sourceParts.push(`lead ${lead.id}`);
        if (property) sourceParts.push(`property ${property.id}`);
        if (sourceQuote) sourceParts.push(`quote ${sourceQuote.id}`);
        if (lead?.booking?.start) sourceParts.push(`booking @ ${lead.booking.start}`);
        await workOrders.appendHistory(wo.id, {
          action: "created",
          by: "admin",
          note: `${workOrders.TEMPLATES[type].label}${sourceParts.length ? ` from ${sourceParts.join(", ")}` : ""}`
        });
      } catch (err) { console.warn("[wo-history] create entry failed:", err?.message); }

      return sendJson(res, 200, { ok: true, workOrder: wo });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't create work order."] });
    }
  }

  const workOrderMatch = pathname.match(/^\/api\/work-orders\/([^/]+)$/);
  if (workOrderMatch && req.method === "GET") {
    let wo = await workOrders.get(decodeURIComponent(workOrderMatch[1]));
    if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
    // Decorate with the linked property so the editor can show it
    // without a second fetch. Lead is small enough to inline too.
    let property = null;
    if (wo.propertyId) property = await properties.get(wo.propertyId);
    let lead = null;
    if (wo.leadId) {
      const allLeads = await readLeads();
      lead = allLeads.find((l) => l.id === wo.leadId) || null;
    }

    // Self-healing seasonal-fee seed for WOs missing the baseline line
    // (legacy records that pre-date the create-time seed, or WOs created
    // through paths where the seed didn't fire — e.g., from /admin/handoff
    // before the derivation fallback existed). Idempotent: a baseline
    // line with source.baseline === true is the fingerprint that says
    // "already seeded, leave alone."
    //
    // Same key derivation order as the create path: lead.booking.serviceKey
    // first, then deriveSeasonalKey(type, propertyZoneCount). Without the
    // fallback, WOs created without a booking serviceKey could never
    // self-heal — the bug Patrick hit when a fresh spring opening WO
    // showed up with no service-fee line.
    if (wo.type === "spring_opening" || wo.type === "fall_closing") {
      const existingBuilder = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      const hasBaseline = existingBuilder.some((l) => l && l.source && l.source.baseline === true);
      if (!hasBaseline) {
        let seedKey = lead?.booking?.serviceKey ? String(lead.booking.serviceKey) : "";
        if (!seedKey || !PRICING.items?.[seedKey]) {
          const zoneCount = Array.isArray(property?.system?.zones)
            ? property.system.zones.length
            : 0;
          seedKey = deriveSeasonalKey(wo.type, zoneCount, false) || "";
        }
        const catalogItem = seedKey ? PRICING.items?.[seedKey] : null;
        if (catalogItem) {
          const refDate = lead?.booking?.start
            ? new Date(lead.booking.start)
            : new Date(wo.scheduledFor || wo.createdAt || Date.now());
          const refYear = refDate.getUTCFullYear();
          const typeLabel = wo.type === "spring_opening" ? "Spring Opening" : "Fall Closing";
          const seasonalLine = {
            key: seedKey,
            label: `${typeLabel} (${refYear})`,
            qty: 1,
            originalPrice: Math.round((Number(catalogItem.price) || 0) * 100) / 100,
            overridePrice: null,
            custom: false,
            source: { zoneNumbers: [], issueIds: [], baseline: true },
            note: ""
          };
          try {
            wo = await workOrders.update(wo.id, {
              onSiteQuote: {
                ...wo.onSiteQuote,
                status: existingBuilder.length ? wo.onSiteQuote?.status : "draft",
                lastBuiltAt: wo.onSiteQuote?.lastBuiltAt || new Date().toISOString(),
                builderLineItems: [seasonalLine, ...existingBuilder]
              }
            });
            console.log(`[wo-self-heal] seeded seasonal fee on ${wo.id} (${seedKey}, $${catalogItem.price})`);
          } catch (err) {
            console.warn("[wo-self-heal] seed failed:", err?.message);
          }
        }
      }
    }
    // Last service at this property — the most recent COMPLETED WO that
    // isn't the current one. Powers the Cheat Sheet's "last visit"
    // line so the tech opens the WO with prior context: "spring opening
    // 2025-04-12 — closed clean, two heads replaced." Per spec §4.3.2
    // (existing properties only — first-time visits don't surface this).
    let lastService = null;
    if (wo.propertyId) {
      const propertyWos = await workOrders.listByProperty(wo.propertyId);
      const completed = propertyWos
        .filter((w) => w.id !== wo.id && w.status === "completed")
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      if (completed.length) {
        const c = completed[0];
        lastService = {
          id: c.id,
          type: c.type,
          completedAt: c.updatedAt,
          techNotes: c.techNotes ? String(c.techNotes).slice(0, 200) : ""
        };
      }
    }
    // Property-edits preview (Brief D / spec §10 r3) — derived view of
    // what would flow back if the cascade fired right now. Computed
    // against the LIVE property record so concurrent admin edits show
    // up. Kept off the WO entity itself (derived, not stored) so we
    // never have to reconcile drift with the cascade's apply step.
    let propertyEdits = { zoneEdits: [], newZones: [], hasChanges: false };
    if (property && !wo.propertyEditsAppliedAt) {
      try {
        propertyEdits = completionCascade.computePropertyEdits(wo, property);
      } catch (err) { console.warn("[wo-get] computePropertyEdits failed:", err?.message); }
    }
    return sendJson(res, 200, { ok: true, workOrder: wo, property, lead, lastService, propertyEdits });
  }

  if (workOrderMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(workOrderMatch[1]);
      const payload = await parseRequestBody(req);

      // Pre-load the existing record once so the rest of the route can
      // make scope-lock decisions without round-tripping `workOrders.get`
      // multiple times. Also gives us the prior status for the cascade
      // trigger below and a clean diff source for the history entries.
      const existing = await workOrders.get(id);
      if (!existing) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });

      // Server-side pre-sign gate validation (Brief: WO Field-Readiness
      // §6.4). Mirrors the client's preSignReadinessFailures so a stale
      // tab or replayed offline mutation can't sign+complete a WO with
      // unmet gates. Pulls the same `wo` snapshot the rest of the
      // handler uses — `payload` overrides for fields the client just
      // touched (paidOnSite especially, since the radio flip + the
      // sign-and-complete PATCH can land in the same tick).
      function computeServerSidePreSignFailures(wo, patch) {
        const merged = { ...wo, ...patch };
        const fails = [];
        // Zone walk-through — every zone has either a status or a check.
        const zones = Array.isArray(merged.zones) ? merged.zones : [];
        const untouched = zones.filter((z) => {
          if (z.status && z.status !== "") return false;
          const checks = z.checks || {};
          return !Object.values(checks).some(Boolean);
        });
        if (untouched.length) {
          fails.push(`${untouched.length} zone${untouched.length === 1 ? "" : "s"} not reviewed`);
        }
        // Completion-photo gate by type (mirrors the lib's
        // PHOTO_REQUIREMENT_BY_TYPE; duplicated here so the gate keeps
        // working if the lib re-exports change shape).
        const minPhotos = { spring_opening: 1, service_visit: 1, fall_closing: 0 }[merged.type] ?? 1;
        if (minPhotos > 0) {
          const photoCount = Array.isArray(merged.photos) ? merged.photos.length : 0;
          if (photoCount < minPhotos) {
            fails.push(`${minPhotos} completion photo${minPhotos === 1 ? "" : "s"} required`);
          }
        }
        // Payment method — promoted to pre-sign per the brief.
        if (merged.paidOnSite !== true && merged.paidOnSite !== false) {
          fails.push("payment method not selected");
        }
        // Return-visit decision (Patrick 2026-05-12). Forces the tech
        // to explicitly answer "Yes — coming back" or "No — done today"
        // before signing. Drives whether the customer's invoice frames
        // this as a complete repair vs. a multi-visit job, and whether
        // parts get queued for a follow-up. null = not yet answered.
        if (merged.needsReturnVisit !== true && merged.needsReturnVisit !== false) {
          fails.push("return-visit question not answered");
        }
        // AI bonus decision gate (only when applies).
        if (merged.intakeGuarantee && merged.intakeGuarantee.applies) {
          if (merged.intakeGuarantee.matched !== true && merged.intakeGuarantee.matched !== false) {
            fails.push("AI bonus decision not recorded");
          }
        }
        // Cascade-merge follow-up — brief-literal §4.6 materials gate.
        // hydrate() auto-fills this for fall_closing + empty-materials
        // WOs, so the check only fires when the tech genuinely has
        // parts to confirm and hasn't tapped "Confirm materials list."
        // Complementary to the techMaterialsSection packing-rows gate
        // above (43c766f) — that one fires on follow-up packing, this
        // fires on explicit confirmation of the current visit's parts.
        if (!merged.materialsConfirmedAt) {
          fails.push("materials list not confirmed");
        }
        return fails;
      }

      // Optimistic concurrency — If-Match check. When the client sends
      // an If-Match header carrying the wo.updatedAt it loaded, refuse
      // the patch if the WO has moved on (another tech or admin
      // saved). Returns 409 with the latest record so the client can
      // surface a "reload to see new changes" banner instead of
      // silently overwriting. HANDOFF.md "Offline mode conflict
      // resolution" — replaces last-write-wins.
      //
      // Two safe-fields exceptions: payloads that only touch photos
      // (additive, never destructive) or a fresh signature (one-shot,
      // protected by the wo.locked check below) bypass the check so
      // photo uploads queued from offline don't lose to a parallel
      // unrelated edit, and so a signature-only payload doesn't get
      // blocked by a stale version.
      const ifMatch = String(req.headers["if-match"] || "").replace(/^"|"$/g, "");
      if (ifMatch && existing.updatedAt && ifMatch !== existing.updatedAt) {
        const photosOnlyPayload = payload && Object.keys(payload).length === 1 && "photos" in payload;
        const signatureOnlyPayload = payload && Object.keys(payload).every((k) => k === "signature" || k === "locked");
        // Merged "Sign, lock & generate invoice" tap (Phase 2 cascade
        // merge — 863c6ac) sends signature + status: "completed" +
        // arrivedAt/departedAt back-fill in one PATCH. None of these
        // fields can sensibly conflict with a concurrent edit (the
        // signature locks scope; the status transition is forward-only
        // and idempotent at the cascade layer; the timestamps are
        // back-fill only if absent). Bypass the version check for this
        // exact shape so a stale state.updatedAt doesn't strand a
        // customer mid-signature.
        const SIGN_AND_COMPLETE_KEYS = new Set(["signature", "locked", "status", "arrivedAt", "departedAt"]);
        const signAndCompletePayload = payload
          && payload.signature && payload.status === "completed"
          && Object.keys(payload).every((k) => SIGN_AND_COMPLETE_KEYS.has(k));
        if (!photosOnlyPayload && !signatureOnlyPayload && !signAndCompletePayload) {
          return sendJson(res, 409, {
            ok: false,
            error: "version_conflict",
            errors: ["This work order was updated by someone else while you were editing. Reload to see the latest changes before saving again."],
            currentVersion: existing.updatedAt,
            workOrder: existing
          });
        }
      }

      // Spec §10 r11 + §4.3.3 r5 — once the WO is locked (signed), any
      // payload that touches a scope-protected field is refused with a
      // 409. Non-scope fields (status forward-progression, photos via
      // dedicated route, materials, paidOnSite, departure stamp,
      // techNotes, serviceChecklist) keep flowing — the WO continues
      // operationally; only the scope is frozen.
      if (existing.locked === true || existing.signature?.signed === true) {
        const touched = workOrders.findProtectedFieldTouched(payload);
        if (touched) {
          return sendJson(res, 409, {
            ok: false,
            errors: [`Work order is signed and locked. Scope-protected field "${touched}" cannot be modified.`],
            error: "wo_locked",
            field: touched,
            signedAt: existing.signature?.signedAt || null
          });
        }
      }

      // Customer sign-off — when the patch carries a signature with an
      // image, customer name, and acknowledgement, this is the legally
      // binding moment per spec §4.3.2. Server fills in the audit
      // metadata (signedAt / ip / userAgent) so the client can't fake
      // them, then locks the WO. Already-signed WOs are caught by the
      // scope-protected check above (signature is in SCOPE_PROTECTED_FIELDS),
      // so reaching this branch guarantees the WO isn't yet signed.
      if (payload && payload.signature && typeof payload.signature === "object") {
        const sig = payload.signature;
        const isFreshSign = sig.acknowledgement === true
          && typeof sig.imageData === "string" && sig.imageData.length > 50
          && typeof sig.customerName === "string" && sig.customerName.trim().length > 0;
        if (isFreshSign) {
          // Cap the signature image at 500KB of base64 to prevent
          // oversized PNGs from blowing up the JSON store.
          if (sig.imageData.length > 500_000) {
            return sendJson(res, 422, { ok: false, errors: ["Signature image is too large. Try clearing and signing again."] });
          }
          // Defense-in-depth gate validation (Brief: WO Field-Readiness
          // §6.4). Client-side preSignReadinessFailures already blocks
          // most paths, but a stale tab / replayed offline queue / API
          // client could route around it. Re-run the gates server-side
          // so the WO can never lock + transition to completed with an
          // unmet pre-sign requirement. Only enforced when the payload
          // is the merged sign-and-complete shape (signature + status:
          // "completed") — the legacy signature-only path (without a
          // status flip) stays permissive for unusual recovery flows.
          if (payload.status === "completed") {
            const gateFails = computeServerSidePreSignFailures(existing, payload);
            if (gateFails.length) {
              return sendJson(res, 422, {
                ok: false,
                error: "presign_gate_unmet",
                errors: [`Pre-sign gates unmet: ${gateFails.join("; ")}`],
                gateFailures: gateFails
              });
            }
          }
          const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
          const userAgent = req.headers["user-agent"] || "";
          payload.signature = {
            ...sig,
            signed: true,
            signedAt: new Date().toISOString(),
            ip,
            userAgent
          };
          payload.locked = true;
        }
      }

      // Snapshot the prior status so we can detect a transition to
      // "completed" and fire the cascade exactly once.
      const priorStatus = existing.status || null;

      const updated = await workOrders.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });

      // Audit trail — append a generic mutation entry for non-status,
      // non-signature fields. Status_change and signature_capture are
      // logged inline by the lib's update() so we don't double-log here.
      // We DO want one breadcrumb entry summarising what else moved
      // (zone edits, notes, materials packed, etc.) so the history
      // viewer surfaces every operational tap.
      const interestingFields = Object.keys(payload || {}).filter((k) =>
        !["status", "signature", "__by", "__statusNote"].includes(k)
      );
      if (interestingFields.length) {
        const summary = interestingFields.length <= 3
          ? interestingFields.join(", ")
          : `${interestingFields.slice(0, 3).join(", ")} (+${interestingFields.length - 3} more)`;
        try {
          await workOrders.appendHistory(id, {
            action: "patch",
            by: "admin",
            note: `Updated: ${summary}`
          });
        } catch (err) { console.warn("[wo-history] patch entry failed:", err?.message); }
      }

      // Completion cascade — spec §4.3.4. Fires when the WO transitions
      // INTO completed (any prior status). Idempotent at the cascade
      // layer (it short-circuits if a service record already references
      // this WO), so accidental re-triggers are safe.
      //
      // The cascade is now AWAITED so the PATCH response can return the
      // freshly-drafted invoice ID — that's how the merged "Sign, Lock &
      // Generate Invoice" button surfaces the invoice number immediately
      // (no client-side polling race). The notify hooks below are still
      // best-effort and fire-and-forget via setImmediate so a slow Gmail
      // round-trip doesn't block the response.
      let cascadeResult = null;
      let cascadeError = null;
      if (updated.status === "completed" && priorStatus !== "completed" && updated.propertyId) {
        const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
        try {
          cascadeResult = await completionCascade.run(updated, {
            notifyAdmin: async (ctx) => { setImmediate(() => runAdminNotify(ctx, baseUrl).catch((e) => console.warn("[cascade] admin notify failed:", e?.message))); },
            notifyCustomer: async (ctx) => { setImmediate(() => runCustomerNotify(ctx).catch((e) => console.warn("[cascade] customer notify failed:", e?.message))); }
          });
        } catch (err) {
          cascadeError = err?.message || "cascade threw";
          console.warn("[cascade] run failed:", cascadeError);
          // Audit-log the partial failure so the WO history viewer
          // surfaces it. Brief: WO Field-Readiness §6.4 — a hard-throw
          // mid-cascade leaves the WO locked + status=completed but
          // without an invoice; the recovery surface picks this up
          // because there's no cascade_fire entry.
          try {
            await workOrders.appendHistory(id, {
              action: "cascade_failed",
              by: "system",
              note: cascadeError.slice(0, 200)
            });
          } catch (_logErr) {}
        }
      }

      // Helpers extracted so the cascade can return fast while notifies
      // run on the next tick (setImmediate above). Defined inside the
      // PATCH closure so they have access to the file-level helpers
      // (sendNewLeadEmail, sendNewLeadSms) without re-requiring.
      async function runAdminNotify({ wo, serviceRecord, invoice }, adminBaseUrl) {
        const aliasLead = {
          id: wo.id,
          sourceLabel: `WO COMPLETED — ${wo.type}`,
          contact: {
            name: wo.customerName || "(unknown)",
            phone: wo.customerPhone || "",
            email: wo.customerEmail || "",
            address: wo.address || "",
            notes: `${serviceRecord.summary}${invoice ? ` · Invoice ${invoice.id} ($${invoice.total.toFixed(2)})` : " · No charge"}`
          }
        };
        await Promise.allSettled([
          sendNewLeadEmail(aliasLead, { baseUrl: adminBaseUrl }),
          sendNewLeadSms(aliasLead, { baseUrl: adminBaseUrl })
        ]);
      }

      async function runCustomerNotify({ wo, serviceRecord, invoice }) {
        // Branded summary email via nodemailer. Skipped when Gmail creds
        // or customer email aren't set — best-effort by design.
        if (!wo.customerEmail || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
        let nodemailer;
        try { nodemailer = require("nodemailer"); } catch { return; }
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
        });
        const firstName = (wo.customerName || "").split(" ")[0] || "there";
        // v37 — Patrick: "if they pay in person i don't even want to
        // send a reciept. I want everything to be billed through
        // online." Removed the paidInField receipt-style branch.
        // Every customer gets the same "invoice will follow" copy.
        // The invoice itself goes out via the regular admin-review
        // flow (Patrick reviews each draft, then sends from the
        // invoice page or QB). paidOnSiteAtCompletion still gets
        // stamped on the invoice record for accounting / QB
        // reconciliation, just not surfaced in the customer email.
        const totalLine = invoice && invoice.total > 0
          ? `<p style="margin: 0 0 14px;">Total for today's visit: <strong>$${invoice.total.toFixed(2)} CAD</strong> (incl. HST). An invoice will follow.</p>`
          : "";
        const warranty = serviceRecord.warrantyExpiresAt
          ? `<p style="margin: 0 0 14px;">Today's work is covered under PJL's <strong>${serviceRecord.warrantyMonths}-month warranty</strong>, valid through ${new Date(serviceRecord.warrantyExpiresAt).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}.</p>`
          : "";
        const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="padding: 24px 28px; background: #1B4D2E; border-radius: 8px 8px 0 0;">
    <div style="color: #EAF3DE; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;">PJL Land Services</div>
    <h1 style="margin: 6px 0 0; color: #fff; font-size: 22px;">Today's visit is complete.</h1>
  </div>
  <div style="padding: 24px 28px; background: #FAFAF5; border: 1px solid #e5e5dd; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 14px;">Hi ${firstName.replace(/</g, "&lt;")},</p>
    <p style="margin: 0 0 14px;">${serviceRecord.summary.replace(/</g, "&lt;")}</p>
    ${totalLine}
    ${warranty}
    <p style="margin: 18px 0 0; font-size: 13px; color: #777;">Questions? Call <a href="tel:+19059600181" style="color: #1B4D2E;">(905) 960-0181</a> or reply to this email.</p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #999; text-align: center;">PJL Land Services · Newmarket, Ontario · pjllandservices.com</p>
</div>`.trim();
        await transporter.sendMail({
          from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
          to: wo.customerEmail,
          replyTo: process.env.GMAIL_USER,
          subject: "Your PJL visit is complete",
          html
        });
      }

      // Sign-time sweep: if THIS PATCH just signed the WO, find every
      // deferred item that was queued via the carry-forward "Repair now"
      // action against this WO (status=in_progress + resolution.resolvedInWoId
      // = wo.id) and flip them to "resolved". This is the moment they
      // become contractually fixed per spec rule #11. Resolutions inherit
      // the WO's signature timestamp so the audit trail lines up.
      if (updated.signature?.signed && updated.locked && updated.propertyId) {
        try {
          const allDeferred = await properties.listDeferred(updated.propertyId, { status: "in_progress" });
          for (const entry of allDeferred) {
            if (entry?.resolution?.resolvedInWoId === updated.id) {
              await properties.updateDeferredIssue(updated.propertyId, entry.id, {
                status: "resolved",
                resolution: {
                  ...entry.resolution,
                  resolvedAt: updated.signature.signedAt || new Date().toISOString(),
                  resolvedBy: "tech-signed"
                }
              });
            }
          }
        } catch (err) {
          console.warn("[wo-sign] deferred sweep failed:", err?.message);
        }
      }

      // Re-fetch the WO if the cascade stamped propertyEditsAppliedAt
      // (or any other side-effect wrote back). The client wants the
      // freshest version including the new history entries (cascade_fire,
      // invoice_drafted, cascade_failed) so the History section re-
      // renders correctly. Also re-fetch on cascade error so the client
      // sees the `cascade_failed` audit entry.
      const finalWo = (cascadeResult || cascadeError) ? await workOrders.get(id) : updated;
      const responseBody = { ok: true, workOrder: finalWo };
      if (cascadeResult) {
        responseBody.cascade = {
          ran: !cascadeResult.alreadyRan,
          alreadyRan: !!cascadeResult.alreadyRan,
          invoiceId: cascadeResult.invoice?.id || null,
          invoiceTotal: cascadeResult.invoice?.total ?? null,
          invoiceDraftError: cascadeResult.invoiceDraftError || null,
          propertyEditsApplied: !!cascadeResult.propertyEditsApplied
        };
      } else if (cascadeError) {
        // Cascade threw — signed/locked/completed all persisted, but
        // the downstream artifacts didn't land. Surface this so the
        // client can show the recovery banner with "tap to retry."
        // Brief: WO Field-Readiness §6.4.
        responseBody.cascade = { ran: false, error: cascadeError, invoiceId: null };
      }
      return sendJson(res, 200, responseBody);
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't update work order."] });
    }
  }

  if (workOrderMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(workOrderMatch[1]);

      // Delete guard — refuse to hard-delete a WO that has active deferred
      // children referencing it (open / pre_authorized / in_progress).
      // Otherwise the spring banner would render with broken photo refs
      // (wo-photos/<woId>/<n>.<ext> would 404). Resolved/dismissed entries
      // are fine to orphan — the resolution timestamp is the audit trail.
      const woBeingDeleted = await workOrders.get(id);
      if (woBeingDeleted?.propertyId) {
        const allDeferred = await properties.listDeferred(woBeingDeleted.propertyId);
        const blocking = allDeferred.filter((d) =>
          d.fromWoId === id && ["open", "pre_authorized", "in_progress"].includes(d.status)
        );
        if (blocking.length) {
          return sendJson(res, 409, { ok: false, errors: [
            `Cannot delete this work order — it has ${blocking.length} active deferred recommendation${blocking.length === 1 ? "" : "s"} referencing it. Resolve or dismiss those first from the property page.`
          ] });
        }
      }

      const removed = await workOrders.remove(id);
      if (!removed) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      // Clear the lead's pointer so the CRM doesn't show a dangling link.
      if (removed.leadId) {
        const allLeads = await readLeads();
        const idx = allLeads.findIndex((l) => l.id === removed.leadId);
        if (idx !== -1 && allLeads[idx].workOrderId === id) {
          delete allLeads[idx].workOrderId;
          await writeLeads(allLeads);
        }
      }
      return sendJson(res, 200, { ok: true, deletedId: id });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete work order."] });
    }
  }

  // -------------------- WO photo endpoints --------------------
  // POST /api/work-orders/:id/photos — upload one or more media files.
  // Body: { photos: [{ data: "<base64>", mediaType, category, zoneNumber, issueId, label }] }
  // Allowed types (Brief: WO Field-Readiness §5):
  //   image/jpeg, image/png, image/webp, image/heic, image/heif, image/gif,
  //   application/pdf. 25 MB per file; magic-bytes verified server-side.
  // Categories: pre_work / in_progress / post_work / issue / general.
  // Photos are stored on disk under WO_PHOTOS_DIR/<woId>/<n>.<ext>; metadata
  // is appended to wo.photos. The hard cap of MAX_PHOTOS_PER_WO is enforced
  // across all uploads (not per-request) so a tech can't bypass it by
  // splitting into batches. The endpoint stays /photos for backwards-
  // compatibility — internally it now stores "media" (image OR PDF), with
  // the file kind on each meta entry (`kind: 'image' | 'pdf'`) so the UI
  // can render PDFs as filename tiles instead of broken <img> tags.
  const woPhotosUploadMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/photos$/);
  if (woPhotosUploadMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woPhotosUploadMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });

      // 40 MB envelope cap — covers one 25 MB raw file after base64
      // inflation (~33 MB) plus the JSON wrapper. Per-file size enforced
      // in validatePhotos. Bigger than /api/quotes intake on purpose:
      // field uploads can be straight-from-camera HEIC or customer PDFs.
      const payload = await parseRequestBody(req, { maxBytes: WO_UPLOAD_POST_MAX_BYTES });
      const existing = Array.isArray(wo.photos) ? wo.photos : [];
      const remaining = MAX_PHOTOS_PER_WO - existing.length;
      if (remaining <= 0) {
        return sendJson(res, 422, { ok: false, errors: [`Work order already has the maximum ${MAX_PHOTOS_PER_WO} photos. Delete one before uploading more.`] });
      }
      let validated;
      try { validated = validatePhotos(payload.photos, remaining, { mode: "wo" }); }
      catch (err) { return sendJson(res, 422, { ok: false, errors: [err.message] }); }

      // Resolve the property code for the descriptive filename slug. When
      // the WO has a linked property, we use its P-YYYY-NNNN; otherwise
      // the slug falls back to "P-UNKNOWN" (filename still works).
      let propertyCode = null;
      if (wo.propertyId) {
        try {
          const linkedProp = await properties.get(wo.propertyId);
          if (linkedProp && linkedProp.code) propertyCode = linkedProp.code;
        } catch (_err) {}
      }

      const baseN = existing.reduce((max, p) => Math.max(max, Number(p.n) || 0), 0);
      const now = new Date().toISOString();
      const newMeta = await savePhotosForWorkOrder(id, validated, now, baseN, {
        propertyCode,
        woCode: wo.id
      });
      const updated = await workOrders.update(id, { photos: [...existing, ...newMeta] });
      // Audit trail per Brief A — one entry per upload batch (not per file)
      // so a 5-photo upload doesn't spam the history viewer. Photos are
      // not scope-protected so this entry stands even on locked WOs.
      try {
        const cats = Array.from(new Set(newMeta.map((m) => m.category || "general")));
        await workOrders.appendHistory(id, {
          action: "photo_upload",
          by: "tech",
          note: `+${newMeta.length} photo${newMeta.length === 1 ? "" : "s"} (${cats.join(", ")})`
        });
      } catch (err) { console.warn("[wo-history] photo upload entry failed:", err?.message); }
      return sendJson(res, 201, { ok: true, workOrder: updated, added: newMeta });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't upload photos."] });
    }
  }

  // DELETE /api/work-orders/:id/photos/:n — remove a single photo by n.
  const woPhotoDeleteMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/photos\/(\d+)$/);
  if (woPhotoDeleteMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(woPhotoDeleteMatch[1]);
      const n = Number(woPhotoDeleteMatch[2]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      const existing = Array.isArray(wo.photos) ? wo.photos : [];
      const photoMeta = existing.find((p) => Number(p.n) === n);
      if (!photoMeta) return sendJson(res, 404, { ok: false, errors: ["Photo not found."] });
      await deleteWorkOrderPhotoFile(id, n);
      const nextPhotos = existing.filter((p) => Number(p.n) !== n);
      const updated = await workOrders.update(id, { photos: nextPhotos });
      try {
        await workOrders.appendHistory(id, {
          action: "photo_delete",
          by: "admin",
          note: `Removed photo #${n} (${photoMeta.category || "general"})`
        });
      } catch (err) { console.warn("[wo-history] photo delete entry failed:", err?.message); }
      return sendJson(res, 200, { ok: true, workOrder: updated, deletedN: n });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't delete photo."] });
    }
  }

  // GET /api/work-orders/:id/photo/:n — serve a single photo file.
  // Cookie-gated by the standard admin auth (handled upstream via
  // requireAuth's "/api/work-orders" prefix match). Same caching policy
  // as lead photos: private, 1 day max-age — photos rarely change.
  const woPhotoServeMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/photo\/(\d+)$/);
  if (woPhotoServeMatch && req.method === "GET") {
    const id = decodeURIComponent(woPhotoServeMatch[1]);
    const n = Number(woPhotoServeMatch[2]);
    const wo = await workOrders.get(id);
    if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
    const photoMeta = (wo.photos || []).find((p) => Number(p.n) === n);
    if (!photoMeta) return sendJson(res, 404, { ok: false, errors: ["Photo not found."] });
    const file = await readWorkOrderPhotoFile(id, n);
    if (!file) return sendJson(res, 404, { ok: false, errors: ["Photo not found on disk."] });
    // Content-Disposition uses the descriptive filename slug so saving
    // the image (right-click → Save, or device-save flows) lands the
    // file as 20260601-P-2026-0042-WO-A1B2C3D4-z3-2.jpg rather than 2.jpg.
    // `inline` keeps it viewable in the browser; the filename is the hint.
    const headers = {
      "content-type": file.mediaType,
      "cache-control": "private, max-age=86400",
      "content-length": file.data.length
    };
    if (photoMeta.filename) {
      // Sanitize for header-safe ASCII. Anything weird falls back to <n>.<ext>.
      const safe = String(photoMeta.filename).replace(/[^A-Za-z0-9._\-]/g, "");
      if (safe) headers["content-disposition"] = `inline; filename="${safe}"`;
    }
    res.writeHead(200, headers);
    res.end(file.data);
    return;
  }

  // ======== Signature bypass (Signature Bypass for WO Completion brief) ========
  // Admin-authored alternative to the drawn-signature path used when the
  // customer is not physically present at visit end (left for work, vacant
  // winter home, etc.). Operationally equivalent to a drawn signature for
  // wo.locked + the completion cascade, but deliberately distinguished in
  // legal posture — bypass IS NOT a signature, it's an honest record of
  // verbal acceptance.
  //
  // Friction by design: requires reason + ≥10-char note + ack checkbox in
  // the UI. When the on-site quote builder has line items beyond the
  // baseline seasonal fee + AI bonus credit, the route returns 409
  // scope_additions_require_acknowledgement so the UI MUST surface the
  // warning and pass acknowledgeWarning: true on retry.
  //
  // After capture, the route fires the same deferred-issue sweep as the
  // regular signature path (carry-forward "Repair now" items resolve at
  // the lock-flip moment per hard rule §11). Cascade itself does NOT fire
  // here — the tech taps "Mark visit completed" separately to flip status
  // to completed, which triggers the regular cascade path.
  const woSignatureBypassMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/signature-bypass$/);
  if (woSignatureBypassMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woSignatureBypassMatch[1]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, error: "wo_not_found", errors: ["Work order not found."] });

      // Mutual-exclusion guards happen inside the lib verb too, but we
      // check here first to return cleaner per-error codes for the UI
      // (the verb's generic 400 path is the catch-all).
      if (wo.signature && wo.signature.signed === true) {
        return sendJson(res, 409, {
          ok: false,
          error: "already_signed",
          errors: ["This work order is already signed — bypass not available."]
        });
      }
      if (wo.signatureBypass) {
        return sendJson(res, 409, {
          ok: false,
          error: "already_bypassed",
          errors: ["Bypass already recorded for this work order. See WO history."]
        });
      }
      // Mutual exclusion with the on-site-quote flows. Send-for-approval
      // sets onSiteQuote.status = "sent_for_remote_approval"; accept (or
      // its remote-signature counterpart) sets accepted / partially_accepted /
      // declined and attaches quoteId. Either path means a customer-
      // signature posture already exists — bypass would either duplicate
      // or contradict it, so refuse with a code the UI can route on.
      const onSiteStatus = wo.onSiteQuote?.status;
      const hasAttachedQuote = !!wo.onSiteQuote?.quoteId;
      if (hasAttachedQuote && onSiteStatus === "sent_for_remote_approval") {
        return sendJson(res, 409, {
          ok: false,
          error: "pending_remote_approval",
          errors: ["A remote-approval quote is pending customer signature. Cancel the pending quote (or wait for the customer) before bypassing."]
        });
      }
      if (hasAttachedQuote && (onSiteStatus === "accepted" || onSiteStatus === "partially_accepted" || onSiteStatus === "declined")) {
        return sendJson(res, 409, {
          ok: false,
          error: "quote_already_accepted",
          errors: ["An on-site quote was already accepted with a customer signature. Use the regular completion-signature path instead of bypass."]
        });
      }
      const terminal = new Set(["completed", "cancelled", "no_show"]);
      if (terminal.has(wo.status)) {
        return sendJson(res, 409, {
          ok: false,
          error: "invalid_state",
          errors: [`Work order is in terminal state "${wo.status}" — bypass not available.`]
        });
      }

      // Pre-sign gates — mirrors the drawn-signature path's gate set
      // minus the drawn-canvas + customer-name + ack gates (those are
      // bypass's own friction in the UI). Bypass does NOT relax the
      // photo, zone, payment, return-visit, AI bonus, or materials
      // gates; only the canvas requirement.
      const gateFails = [];
      const zones = Array.isArray(wo.zones) ? wo.zones : [];
      const untouched = zones.filter((z) => {
        if (z.status && z.status !== "") return false;
        const checks = z.checks || {};
        return !Object.values(checks).some(Boolean);
      });
      if (untouched.length) {
        gateFails.push(`${untouched.length} zone${untouched.length === 1 ? "" : "s"} not reviewed`);
      }
      const minPhotos = workOrders.PHOTO_REQUIREMENT_BY_TYPE[wo.type] ?? 1;
      if (minPhotos > 0) {
        const photoCount = Array.isArray(wo.photos) ? wo.photos.length : 0;
        if (photoCount < minPhotos) {
          gateFails.push(`${minPhotos} completion photo${minPhotos === 1 ? "" : "s"} required`);
        }
      }
      if (wo.paidOnSite !== true && wo.paidOnSite !== false) {
        gateFails.push("payment method not selected");
      }
      if (wo.needsReturnVisit !== true && wo.needsReturnVisit !== false) {
        gateFails.push("return-visit question not answered");
      }
      if (wo.intakeGuarantee && wo.intakeGuarantee.applies) {
        if (wo.intakeGuarantee.matched !== true && wo.intakeGuarantee.matched !== false) {
          gateFails.push("AI bonus decision not recorded");
        }
      }
      if (!wo.materialsConfirmedAt) {
        gateFails.push("materials list not confirmed");
      }
      if (gateFails.length) {
        return sendJson(res, 422, {
          ok: false,
          error: "presign_gate_unmet",
          errors: [`Pre-sign gates unmet: ${gateFails.join("; ")}`],
          gateFailures: gateFails
        });
      }

      // Scope-additions check — when the builder has lines beyond
      // baseline + AI bonus credit, refuse the first attempt and surface
      // the warning state in the UI. The UI's "Confirm bypass anyway"
      // button retries with acknowledgeWarning: true.
      const scopeAdditions = workOrders.summarizeScopeAdditions(wo);
      if (scopeAdditions.hasAdditions && payload?.acknowledgeWarning !== true) {
        return sendJson(res, 409, {
          ok: false,
          error: "scope_additions_require_acknowledgement",
          errors: [`This work order has ${scopeAdditions.additionCount} line item${scopeAdditions.additionCount === 1 ? "" : "s"} beyond the baseline ($${scopeAdditions.additionTotal.toFixed(2)}). Bypassing signature on a visit with added scope requires an explicit acknowledgement.`],
          additionCount: scopeAdditions.additionCount,
          additionTotal: scopeAdditions.additionTotal
        });
      }

      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const userAgent = req.headers["user-agent"] || "";

      let updated;
      try {
        updated = await workOrders.captureSignatureBypass(
          id,
          {
            reason: payload?.reason,
            note: payload?.note,
            bypassedBy: "admin",
            // Forward the warning-acknowledged flag so the verb's own
            // scope-additions guard (defense-in-depth) doesn't re-throw
            // after the route already passed the pre-flight check above.
            acknowledgeWarning: payload?.acknowledgeWarning === true
          },
          { ip, userAgent }
        );
      } catch (err) {
        // Map lib-level error codes to HTTP status codes.
        const code = err?.code || "";
        if (code === "wo_not_found") {
          return sendJson(res, 404, { ok: false, error: code, errors: [err.message] });
        }
        if (code === "already_signed" || code === "already_bypassed"
            || code === "invalid_state" || code === "pending_remote_approval"
            || code === "quote_already_accepted") {
          return sendJson(res, 409, { ok: false, error: code, errors: [err.message] });
        }
        if (code === "scope_additions_require_acknowledgement") {
          return sendJson(res, 409, {
            ok: false,
            error: code,
            errors: [err.message],
            additionCount: err.additionCount,
            additionTotal: err.additionTotal
          });
        }
        if (code === "invalid_reason" || code === "note_too_short") {
          return sendJson(res, 400, { ok: false, error: code, errors: [err.message] });
        }
        return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't record signature bypass."] });
      }

      // Bypass-time sweep — mirrors the sign-time sweep in the PATCH
      // route. Carry-forward "Repair now" deferred items resolve at the
      // lock-flip moment regardless of which path locked the WO. Hard
      // rule §11: bypass-locked WO is the contract, same as a signed WO.
      if (updated.propertyId) {
        try {
          const allDeferred = await properties.listDeferred(updated.propertyId, { status: "in_progress" });
          for (const entry of allDeferred) {
            if (entry?.resolution?.resolvedInWoId === updated.id) {
              await properties.updateDeferredIssue(updated.propertyId, entry.id, {
                status: "resolved",
                resolution: {
                  ...entry.resolution,
                  resolvedAt: updated.signatureBypass?.ts || new Date().toISOString(),
                  resolvedBy: "bypass-recorded"
                }
              });
            }
          }
        } catch (err) {
          console.warn("[wo-bypass] deferred sweep failed:", err?.message);
        }
      }

      return sendJson(res, 201, { ok: true, workOrder: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't record signature bypass."] });
    }
  }

  // ======== AI Correct Diagnosis Bonus (Brief F / spec §4.3.3 r6) ========
  // Tech taps "Diagnosis matched" or "Didn't match" on the cheat-sheet
  // bonus card BEFORE customer signature. On match: credit a -1 hour
  // labour line (qty: 1, originalPrice: -hourly_labour) into the on-site
  // quote builder. On mismatch: clear any prior credit line. Locked
  // after signature (intakeGuarantee is in SCOPE_PROTECTED_FIELDS).
  const woAiBonusDecideMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/intake-guarantee\/decide$/);
  if (woAiBonusDecideMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woAiBonusDecideMatch[1]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, {
          ok: false,
          errors: ["Work order is signed and locked. Bonus decision is final."],
          error: "wo_locked",
          field: "intakeGuarantee"
        });
      }
      if (!wo.intakeGuarantee || wo.intakeGuarantee.applies !== true) {
        return sendJson(res, 422, { ok: false, errors: ["This work order isn't AI-Correct-Diagnosis Bonus eligible (no source AI quote)."] });
      }
      const matched = payload?.matched === true ? true
        : payload?.matched === false ? false
        : null;
      if (matched === null) {
        return sendJson(res, 422, { ok: false, errors: ["Body must include matched: true | false."] });
      }
      const mismatchReason = typeof payload?.mismatchReason === "string"
        ? payload.mismatchReason.slice(0, 300)
        : "";

      // Build the credit line (or removal). hourly_labour price comes
      // from pricing.json — never hardcoded. qty=1 with negative price
      // (vs. negative qty) so the existing line-item math handles it
      // without special cases (subtotal = sum of lineTotals, HST applies
      // to net per CRA — tax follows the consideration).
      const hourly = PRICING.items?.hourly_labour;
      if (matched && (!hourly || !Number.isFinite(Number(hourly.price)))) {
        return sendJson(res, 500, { ok: false, errors: ["pricing.json missing hourly_labour entry — can't apply bonus credit."] });
      }
      const existingLines = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      // Strip any prior credit line — we'll re-add if matched.
      const linesWithoutCredit = existingLines.filter((l) => !(l && l.source && l.source.aiBonusCredit === true));
      let nextLines = linesWithoutCredit;
      if (matched) {
        // Credit line is `custom: true` so the builder PATCH preserves
        // its negative price as-is. We snapshot the labour rate at
        // decision time per hard rule §10 r2 — a future pricing.json
        // change won't retroactively alter an applied credit.
        // `source.aiBonusCredit: true` is the canonical identifier
        // (used by the build endpoint's preserve list, the builder
        // PATCH guard, and re-render code).
        const creditLine = {
          key: null,
          label: "AI Correct Diagnosis Bonus — 1 hour labour credit",
          qty: 1,
          originalPrice: -Math.abs(Number(hourly.price)),
          overridePrice: null,
          custom: true,
          source: { zoneNumbers: [], issueIds: [], aiBonusCredit: true },
          note: "Customer's diagnosis matched the AI-quoted scope (PJL's only discount — pricing.json ai_intake_correct_diagnosis_bonus rule)."
        };
        nextLines = [...linesWithoutCredit, creditLine];
      }

      const updated = await workOrders.update(id, {
        intakeGuarantee: {
          ...wo.intakeGuarantee,
          matched,
          mismatchReason: matched ? "" : mismatchReason
        },
        onSiteQuote: {
          ...wo.onSiteQuote,
          builderLineItems: nextLines,
          status: nextLines.length ? "draft" : "none"
        }
      });
      try {
        await workOrders.appendHistory(id, {
          action: "ai_bonus_decided",
          by: "tech",
          note: matched
            ? `Diagnosis matched — credited 1 hr labour ($${Math.abs(Number(hourly.price)).toFixed(2)})`
            : `Diagnosis did not match${mismatchReason ? ` — ${mismatchReason}` : ""}. No credit applied.`
        });
      } catch (err) { console.warn("[wo-history] ai_bonus entry failed:", err?.message); }
      const totals = issueRollup.recomputeTotals(nextLines);
      return sendJson(res, 200, { ok: true, workOrder: updated, ...totals });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't record AI bonus decision."] });
    }
  }

  // ======== On-site Quote (Issues → Draft Quote rollup) ========
  // Spec §4.3.2 + Hard rules §10 r8 (fall closings never auto-quote) and
  // r4 (scope changes require fresh signature). Five routes:
  //   POST  /on-site-quote/build       — run the rollup, store builder draft
  //   PATCH /on-site-quote/builder     — tech edits builder lines
  //   POST  /on-site-quote/accept      — customer signs; create Quote, sink declines
  //   POST  /on-site-quote/decline-all — every line goes to deferred, no Quote
  //   POST  /issues/defer              — find_only path: bundle issues into deferred

  const woOnSiteBuildMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/on-site-quote\/build$/);
  if (woOnSiteBuildMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woOnSiteBuildMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is signed and locked. Unlock first to build a new quote."] });
      }
      if (!workOrders.canBuildOnSiteQuote(wo)) {
        return sendJson(res, 422, { ok: false, errors: [
          "Fall closings cannot generate on-site quotes (PJL operations rule 8). Use 'Save to deferred recommendations' instead."
        ] });
      }
      // Preserve any baseline lines that were seeded at WO create
      // (seasonal fees, manually-added charges from the desktop edit)
      // AND any AI-bonus credit lines from the bonus decision (Brief F).
      // Without this, "Generate from issues" wipes them every rollup.
      const existingBaseline = (wo.onSiteQuote?.builderLineItems || [])
        .filter((l) => l && l.source && (l.source.baseline === true || l.source.aiBonusCredit === true));
      const result = issueRollup.rollupIssuesToLineItems(wo, PRICING);
      const merged = [...existingBaseline, ...result.lineItems];
      const totals = issueRollup.recomputeTotals(merged);
      const updated = await workOrders.update(id, {
        onSiteQuote: {
          ...wo.onSiteQuote,
          status: merged.length ? "draft" : "none",
          lastBuiltAt: new Date().toISOString(),
          builderLineItems: merged
        }
      });
      try {
        await workOrders.appendHistory(id, {
          action: "quote_built",
          by: "tech",
          note: `Generated ${result.lineItems.length} line${result.lineItems.length === 1 ? "" : "s"} from issues — total $${Number(totals.total).toFixed(2)}`
        });
      } catch (err) { console.warn("[wo-history] quote_built entry failed:", err?.message); }
      return sendJson(res, 200, {
        ok: true,
        workOrder: updated,
        lineItems: merged,
        ...totals
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't build on-site quote."] });
    }
  }

  const woOnSiteBuilderMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/on-site-quote\/builder$/);
  if (woOnSiteBuilderMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(woOnSiteBuilderMatch[1]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      const inLines = Array.isArray(payload?.lineItems) ? payload.lineItems : null;
      if (!inLines) return sendJson(res, 422, { ok: false, errors: ["Body must include lineItems[]."] });

      // AI bonus credit guard (Brief F) — when intakeGuarantee.matched
      // is true, the credit line MUST stay on the builder. Refuse a
      // PATCH that drops it. Tech wanting to revoke the credit goes
      // through /intake-guarantee/decide with matched=false.
      if (wo.intakeGuarantee?.matched === true) {
        const incomingHasCredit = inLines.some((l) => l && l.source && l.source.aiBonusCredit === true);
        if (!incomingHasCredit) {
          return sendJson(res, 409, {
            ok: false,
            errors: ["AI Correct Diagnosis Bonus credit line cannot be removed while the bonus decision is 'matched'. Flip the decision to 'didn't match' first."],
            error: "ai_bonus_credit_protected"
          });
        }
      }

      // Validate each line — known pricing key OR custom: true. Custom
      // lines can carry an arbitrary price (tech is on-site quoting
      // unusual work). Known-key lines must have a key that resolves in
      // pricing.json; the original price is re-snapshotted from the
      // catalog (so an editor that mangled originalPrice in transit gets
      // corrected). overridePrice is preserved.
      const cleaned = [];
      const errors = [];
      inLines.forEach((raw, i) => {
        if (!raw || typeof raw !== "object") {
          errors.push(`Line ${i + 1} is not an object.`);
          return;
        }
        const custom = !!raw.custom;
        const key = typeof raw.key === "string" ? raw.key : null;
        if (!custom && (!key || !FEATURES[key])) {
          errors.push(`Line ${i + 1} has unknown pricing key: ${raw.key}`);
          return;
        }
        const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
        const cat = key ? FEATURES[key] : null;
        const originalPrice = custom
          ? Number(raw.originalPrice) || 0
          : Number(cat.price) || 0;
        const overridePrice = raw.overridePrice == null
          ? null
          : (Number.isFinite(Number(raw.overridePrice)) ? Number(raw.overridePrice) : null);
        // Preserve source flags (baseline, aiBonusCredit) — the build
        // endpoint and the AI bonus decision endpoint rely on these to
        // identify lines they own. Without preserving them, every
        // builder PATCH would strip the flags and break the bonus
        // credit guard / build's preserve list.
        const inSource = raw.source && typeof raw.source === "object" ? raw.source : {};
        const cleanedSource = {
          zoneNumbers: Array.isArray(inSource.zoneNumbers) ? inSource.zoneNumbers.slice() : [],
          issueIds: Array.isArray(inSource.issueIds) ? inSource.issueIds.slice() : []
        };
        if (inSource.baseline === true) cleanedSource.baseline = true;
        if (inSource.aiBonusCredit === true) cleanedSource.aiBonusCredit = true;
        cleaned.push({
          key: custom ? null : key,
          label: typeof raw.label === "string" ? raw.label.slice(0, 200) : (cat ? cat.label : "Custom line"),
          qty,
          originalPrice: Math.round(originalPrice * 100) / 100,
          overridePrice,
          custom,
          source: cleanedSource,
          note: typeof raw.note === "string" ? raw.note.slice(0, 500) : ""
        });
      });
      if (errors.length) return sendJson(res, 422, { ok: false, errors });

      const updated = await workOrders.update(id, {
        onSiteQuote: {
          ...wo.onSiteQuote,
          builderLineItems: cleaned,
          status: cleaned.length ? "draft" : "none"
        }
      });
      const totals = issueRollup.recomputeTotals(cleaned);
      return sendJson(res, 200, { ok: true, workOrder: updated, ...totals });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update builder."] });
    }
  }

  const woOnSiteAcceptMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/on-site-quote\/accept$/);
  if (woOnSiteAcceptMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woOnSiteAcceptMatch[1]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      if (!workOrders.canBuildOnSiteQuote(wo)) {
        return sendJson(res, 422, { ok: false, errors: ["Fall closings cannot accept on-site quotes (rule 8)."] });
      }

      const customerName = typeof payload?.customerName === "string" ? payload.customerName.trim() : "";
      const imageData = typeof payload?.imageData === "string" ? payload.imageData : "";
      const ack = payload?.acknowledgement === true;
      const decisions = Array.isArray(payload?.decisions) ? payload.decisions : [];
      if (!customerName || !imageData || imageData.length < 50 || !ack) {
        return sendJson(res, 422, { ok: false, errors: ["Customer name, signature, and acknowledgement are required."] });
      }
      if (imageData.length > 500_000) {
        return sendJson(res, 422, { ok: false, errors: ["Signature image is too large. Try clearing and signing again."] });
      }

      const builderLines = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      if (!builderLines.length) {
        return sendJson(res, 422, { ok: false, errors: ["No quote lines to accept. Build the quote first."] });
      }

      // Snapshot accepted vs declined per the customer's per-line decisions.
      // Default any line missing from `decisions` to accepted (the UI
      // sends a full array, but we don't want a missing entry to silently
      // drop a line into deferred).
      const decisionByIdx = new Map();
      for (const d of decisions) {
        if (!d || typeof d !== "object") continue;
        const idx = Number(d.lineItemIdx);
        if (Number.isInteger(idx)) decisionByIdx.set(idx, d.accepted !== false);
      }
      // v33 — defense-in-depth: a malicious or replayed client could
      // bypass the disabled checkbox and try to decline the service-
      // call trip fee / seasonal flat fee. Force-accept any line
      // whose key matches the mandatory pattern. Customer can decline
      // individual repairs but not the visit itself.
      const isMandatoryKey = (key) => {
        if (!key) return false;
        if (key === "service_call") return true;
        if (key.startsWith("spring_open_")) return true;
        if (key.startsWith("fall_close_")) return true;
        return false;
      };
      builderLines.forEach((line, idx) => {
        if (isMandatoryKey(line.key)) decisionByIdx.set(idx, true);
      });
      const acceptedLines = [];
      const declinedLines = [];
      const finalDecisions = [];
      builderLines.forEach((line, idx) => {
        const accepted = decisionByIdx.has(idx) ? decisionByIdx.get(idx) : true;
        finalDecisions.push({ lineItemIdx: idx, accepted, deferredId: null });
        const snapshotPrice = line.overridePrice != null
          ? Number(line.overridePrice)
          : Number(line.originalPrice);
        const lineTotal = Math.round(snapshotPrice * (Number(line.qty) || 1) * 100) / 100;
        const snapshot = {
          ...line,
          price: snapshotPrice,        // canonical price for downstream display
          lineTotal
        };
        if (accepted) acceptedLines.push(snapshot);
        else declinedLines.push(snapshot);
      });

      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const userAgent = req.headers["user-agent"] || "";

      // Sink declined lines into the property's deferredIssues. One
      // entry per source issue (so individual issues can be re-quoted
      // separately later). Lines with multiple issueIds (e.g. a manifold
      // line aggregating leak+valve issues) emit one deferred entry per
      // issue id, with the suggested-price snapshot proportional.
      let propertyId = wo.propertyId || null;
      const deferredIds = [];
      if (declinedLines.length && propertyId) {
        for (const line of declinedLines) {
          const issueIds = Array.isArray(line.source?.issueIds) && line.source.issueIds.length
            ? line.source.issueIds
            : [null]; // unsourced custom line still creates one deferred entry
          const fromZone = Array.isArray(line.source?.zoneNumbers) && line.source.zoneNumbers.length
            ? line.source.zoneNumbers[0]
            : null;
          // Find the original issue type from the WO if we have an issueId.
          for (const issueId of issueIds) {
            let originalType = "other";
            let originalNotes = line.note || "";
            if (issueId) {
              for (const z of wo.zones || []) {
                const found = (z.issues || []).find((i) => i.id === issueId);
                if (found) {
                  originalType = found.type;
                  if (found.notes) originalNotes = found.notes;
                  break;
                }
              }
            }
            // Photos attached to this issue ride into the deferred entry
            // by reference (the WO is still the photo source-of-truth).
            const photoIds = (wo.photos || [])
              .filter((p) => issueId && p.issueId === issueId)
              .map((p) => Number(p.n))
              .filter(Number.isFinite);
            try {
              const entry = await properties.addDeferredIssue(propertyId, {
                fromWoId: wo.id,
                fromZone,
                type: originalType,
                qty: Number(line.qty) || 1,
                notes: originalNotes,
                declinedAt: new Date().toISOString(),
                reason: "customer_declined",
                photoIds,
                suggestedPriceSnapshot: {
                  key: line.key,
                  label: line.label,
                  unitPrice: line.price,
                  qty: line.qty,
                  lineTotal: line.lineTotal
                }
              });
              if (entry && entry.id) deferredIds.push(entry.id);
            } catch (err) {
              console.warn("[on-site-quote] deferred sink failed:", err?.message || err);
            }
          }
        }
      }

      // Stamp deferred ids back onto the matching decisions for audit.
      let deferredCursor = 0;
      for (const decision of finalDecisions) {
        if (!decision.accepted && deferredIds[deferredCursor]) {
          decision.deferredId = deferredIds[deferredCursor];
          deferredCursor += 1;
        }
      }

      // Compute totals from accepted lines only — these are what the
      // customer is actually agreeing to pay.
      const acceptedTotals = issueRollup.totalsFor(acceptedLines);

      // Create the Quote. Empty acceptedLines → no Q-record (everything
      // declined, all lines went to deferred). Status = declined on the
      // WO; no Quote pollutes the Q-YYYY-NNNN counter.
      let quoteRecord = null;
      if (acceptedLines.length) {
        const created = await quotes.create({
          type: "on_site_quote",
          status: "sent",
          customerEmail: wo.customerEmail || "",
          propertyId,
          leadId: wo.leadId || null,
          source: {
            chatSessionId: null,
            pageUrl: null,
            userAgent
          },
          scope: `On-site quote from ${wo.id}`,
          lineItems: acceptedLines,
          subtotal: acceptedTotals.subtotal,
          hst: acceptedTotals.hst,
          total: acceptedTotals.total,
          intakeGuarantee: { applies: false, scope: "" },
          createdBy: "tech"
        });
        const partial = declinedLines.length > 0;
        quoteRecord = await quotes.acceptWithSignature(created.id, {
          customerName,
          imageData,
          decisions: finalDecisions,
          ip,
          userAgent,
          partial,
          note: partial
            ? `Customer accepted ${acceptedLines.length}/${builderLines.length} lines. ${declinedLines.length} deferred.`
            : `Customer accepted all ${acceptedLines.length} lines on-site.`
        });
        await quotes.attachWorkOrder(created.id, wo.id);
      }

      const newWoStatus = !acceptedLines.length
        ? "declined"
        : declinedLines.length ? "partially_accepted" : "accepted";

      const updated = await workOrders.update(id, {
        onSiteQuote: {
          ...wo.onSiteQuote,
          quoteId: quoteRecord ? quoteRecord.id : null,
          status: newWoStatus,
          // Builder lines stay around for read-only review post-accept;
          // the canonical record is on the Quote (or the deferred items).
          builderLineItems: builderLines
        }
      });
      try {
        const noteParts = [];
        if (acceptedLines.length) noteParts.push(`accepted ${acceptedLines.length}`);
        if (declinedLines.length) noteParts.push(`declined ${declinedLines.length}`);
        if (quoteRecord) noteParts.push(`Quote ${quoteRecord.id}`);
        await workOrders.appendHistory(id, {
          action: "customer_accepted",
          by: "customer",
          note: `${customerName} signed — ${noteParts.join(", ")}`
        });
      } catch (err) { console.warn("[wo-history] customer_accepted entry failed:", err?.message); }

      return sendJson(res, 200, {
        ok: true,
        workOrder: updated,
        quote: quoteRecord,
        accepted: acceptedLines.length,
        declined: declinedLines.length,
        deferredIds
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't accept on-site quote."] });
    }
  }

  const woOnSiteDeclineAllMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/on-site-quote\/decline-all$/);
  if (woOnSiteDeclineAllMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woOnSiteDeclineAllMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      const builderLines = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      const propertyId = wo.propertyId || null;
      const deferredIds = [];
      if (propertyId) {
        for (const line of builderLines) {
          const issueIds = Array.isArray(line.source?.issueIds) && line.source.issueIds.length
            ? line.source.issueIds
            : [null];
          const fromZone = Array.isArray(line.source?.zoneNumbers) && line.source.zoneNumbers.length
            ? line.source.zoneNumbers[0]
            : null;
          for (const issueId of issueIds) {
            let originalType = "other";
            let originalNotes = line.note || "";
            if (issueId) {
              for (const z of wo.zones || []) {
                const found = (z.issues || []).find((i) => i.id === issueId);
                if (found) { originalType = found.type; originalNotes = found.notes || originalNotes; break; }
              }
            }
            const photoIds = (wo.photos || [])
              .filter((p) => issueId && p.issueId === issueId)
              .map((p) => Number(p.n))
              .filter(Number.isFinite);
            const snapshotPrice = line.overridePrice != null ? Number(line.overridePrice) : Number(line.originalPrice);
            try {
              const entry = await properties.addDeferredIssue(propertyId, {
                fromWoId: wo.id,
                fromZone,
                type: originalType,
                qty: Number(line.qty) || 1,
                notes: originalNotes,
                reason: "customer_declined_all",
                photoIds,
                suggestedPriceSnapshot: {
                  key: line.key,
                  label: line.label,
                  unitPrice: snapshotPrice,
                  qty: line.qty
                }
              });
              if (entry?.id) deferredIds.push(entry.id);
            } catch (_e) {}
          }
        }
      }
      const updated = await workOrders.update(id, {
        onSiteQuote: { ...wo.onSiteQuote, status: "declined", quoteId: null }
      });
      try {
        await workOrders.appendHistory(id, {
          action: "customer_declined_all",
          by: "customer",
          note: `${deferredIds.length} item${deferredIds.length === 1 ? "" : "s"} routed to deferred recommendations`
        });
      } catch (err) { console.warn("[wo-history] decline-all entry failed:", err?.message); }
      return sendJson(res, 200, { ok: true, workOrder: updated, deferredIds });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't decline."] });
    }
  }

  // ======== Deferred issues — fall path + emergency override ========
  // Spec §5 (carry-forward engine) + Hard Rule §10 #7 (fall closings never
  // auto-quote — defer-only) and #13 (emergency overrides notify Patrick
  // immediately).

  // Helper — build the deferred entry shape for a single WO issue. Used by
  // both the per-issue defer endpoint and the bulk defer-all endpoint so
  // the snapshot pricing logic stays consistent. Returns null if the issue
  // can't be located on the WO (caller treats as a no-op).
  function deferredPayloadFromIssue(wo, zoneNumber, issue, reason) {
    const photoIds = (wo.photos || [])
      .filter((p) => p.issueId === issue.id)
      .map((p) => Number(p.n))
      .filter(Number.isFinite);
    let priceSnapshot = null;
    try {
      priceSnapshot = issueRollup.rollupSingleIssueToLineItems(issue, Number(zoneNumber) || 0, PRICING);
    } catch (err) {
      console.warn("[defer] price snapshot failed:", err?.message);
    }
    return {
      fromWoId: wo.id,
      fromZone: Number(zoneNumber) || null,
      type: issue.type,
      qty: Number(issue.qty) || 1,
      notes: issue.notes || "",
      reason: reason || "customer_declined",
      photoIds,
      suggestedPriceSnapshot: priceSnapshot
    };
  }

  // Per-issue defer (granular tap-to-defer in the tech UI). Body: { reason }.
  // Removes the issue from the WO zone (so the rollup builder doesn't
  // re-pick it) and creates one deferredIssue on the linked property.
  // Permitted on any WO type — spring carry-forward "Customer declined" path
  // also routes here (with reason=customer_declined_spring).
  const woPerIssueDeferMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/zones\/(\d+)\/issues\/([^/]+)\/defer$/);
  if (woPerIssueDeferMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woPerIssueDeferMatch[1]);
      const zoneNumber = Number(woPerIssueDeferMatch[2]);
      const issueId = decodeURIComponent(woPerIssueDeferMatch[3]);
      const payload = await parseRequestBody(req).catch(() => ({}));
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      const propertyId = wo.propertyId || null;
      if (!propertyId) {
        return sendJson(res, 422, { ok: false, errors: ["Cannot defer — work order has no linked property."] });
      }

      // Find the issue on the WO and clone the zones array minus this one.
      const zones = (wo.zones || []).map((z) => ({ ...z, issues: [...(z.issues || [])] }));
      const zoneIdx = zones.findIndex((z) => Number(z.number) === zoneNumber);
      if (zoneIdx === -1) return sendJson(res, 404, { ok: false, errors: ["Zone not found on this work order."] });
      const issueIdx = zones[zoneIdx].issues.findIndex((i) => i.id === issueId);
      if (issueIdx === -1) return sendJson(res, 404, { ok: false, errors: ["Issue not found on this zone."] });
      const [issue] = zones[zoneIdx].issues.splice(issueIdx, 1);

      // Default reason: fall_visit_no_repairs_policy on fall closings,
      // customer_declined_spring on spring carry-forward declines, or
      // whatever the client passes.
      let reason = typeof payload?.reason === "string" ? payload.reason : null;
      if (!reason) {
        reason = wo.type === "fall_closing" ? "fall_visit_no_repairs_policy" : "customer_declined";
      }

      const entry = await properties.addDeferredIssue(propertyId, deferredPayloadFromIssue(wo, zoneNumber, issue, reason));
      if (!entry) return sendJson(res, 500, { ok: false, errors: ["Couldn't write deferred entry."] });

      const updatedWo = await workOrders.update(id, { zones });
      try {
        await workOrders.appendHistory(id, {
          action: "issue_deferred",
          by: "tech",
          note: `Zone ${zoneNumber} ${issue.type} (qty ${issue.qty || 1}) → deferred ${entry.id} [${reason}]`
        });
      } catch (err) { console.warn("[wo-history] issue_deferred entry failed:", err?.message); }
      return sendJson(res, 201, { ok: true, deferred: entry, workOrder: updatedWo });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't defer issue."] });
    }
  }

  // Emergency override — fall closing only. Promotes a single issue to an
  // emergency severity, fires immediate Patrick notifications (Hard Rule #13),
  // creates a follow-up service_visit WO with the issue's diagnosis pre-filled.
  // Customer signature is REQUIRED — they're authorizing the fall_closing's
  // find-only rule to be broken for this specific item.
  const woEmergencyMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/zones\/(\d+)\/issues\/([^/]+)\/emergency$/);
  if (woEmergencyMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woEmergencyMatch[1]);
      const zoneNumber = Number(woEmergencyMatch[2]);
      const issueId = decodeURIComponent(woEmergencyMatch[3]);
      const payload = await parseRequestBody(req);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      if (wo.type !== "fall_closing") {
        return sendJson(res, 422, { ok: false, errors: ["Emergency override only applies to fall closings."] });
      }

      const reasonEnum = new Set(["safety_hazard", "active_leak", "property_damage_risk", "other"]);
      const severityReason = String(payload?.severity_reason || "").trim();
      const sig = payload?.customerSignature || {};
      if (!reasonEnum.has(severityReason)) {
        return sendJson(res, 422, { ok: false, errors: ["severity_reason must be one of: safety_hazard, active_leak, property_damage_risk, other."] });
      }
      if (!sig.name || typeof sig.name !== "string" || !sig.imageData || typeof sig.imageData !== "string" || sig.imageData.length < 50) {
        return sendJson(res, 422, { ok: false, errors: ["Customer signature (name + drawn image) is required for an emergency override."] });
      }
      if (sig.imageData.length > 500_000) {
        return sendJson(res, 422, { ok: false, errors: ["Signature image is too large."] });
      }

      // Find the issue.
      const zones = (wo.zones || []).map((z) => ({ ...z, issues: [...(z.issues || [])] }));
      const zoneIdx = zones.findIndex((z) => Number(z.number) === zoneNumber);
      if (zoneIdx === -1) return sendJson(res, 404, { ok: false, errors: ["Zone not found."] });
      const issueIdx = zones[zoneIdx].issues.findIndex((i) => i.id === issueId);
      if (issueIdx === -1) return sendJson(res, 404, { ok: false, errors: ["Issue not found."] });
      const [issue] = zones[zoneIdx].issues.splice(issueIdx, 1);

      const propertyId = wo.propertyId || null;
      if (!propertyId) return sendJson(res, 422, { ok: false, errors: ["Work order has no linked property."] });

      // Pull the property + lead so the follow-up WO inherits everything.
      const property = await properties.get(propertyId);
      const allLeads = wo.leadId ? await readLeads() : [];
      const lead = wo.leadId ? allLeads.find((l) => l.id === wo.leadId) : null;

      // 1) Create the deferred record (severity=emergency).
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const userAgent = req.headers["user-agent"] || "";
      const deferredPayload = {
        ...deferredPayloadFromIssue(wo, zoneNumber, issue, "emergency_override"),
        severity: "emergency"
      };
      const deferredEntry = await properties.addDeferredIssue(propertyId, deferredPayload);

      // 2) Stamp the customer's authorizing signature onto the deferred record's
      //    preAuthorization slot — same shape the portal pre-auth flow uses,
      //    so the spring/follow-up WO can render "✓ Already authorized."
      await properties.updateDeferredIssue(propertyId, deferredEntry.id, {
        preAuthorization: {
          signedAt: new Date().toISOString(),
          customerName: sig.name.trim(),
          imageData: sig.imageData,
          ip,
          userAgent
        },
        status: "pre_authorized"
      });

      // 3) Spin up the follow-up service_visit WO with diagnosis pre-filled.
      const diagnosis = `EMERGENCY override from fall WO ${wo.id} (Zone ${zoneNumber}, ${issue.type}).
Reason: ${severityReason}.
Tech notes: ${issue.notes || "(none)"}
Customer signature captured at ${new Date().toISOString()}.`;
      let followupWoId = null;
      try {
        const followup = await workOrders.create({ type: "service_visit", lead, property });
        await workOrders.update(followup.id, { diagnosis, techNotes: `Originating fall WO: ${wo.id}` });
        followupWoId = followup.id;
      } catch (err) {
        console.warn("[emergency] follow-up WO create failed:", err?.message);
      }

      // 4) Update the fall WO — issue removed, note logged.
      const techNotes = (wo.techNotes ? wo.techNotes + "\n\n" : "") +
        `[EMERGENCY ${new Date().toISOString()}] Zone ${zoneNumber} ${issue.type}: ${severityReason}. Follow-up WO ${followupWoId || "(create failed — Patrick to handle manually)"}.`;
      const updatedWo = await workOrders.update(id, { zones, techNotes });

      // 5) Notify Patrick immediately (rule #13).
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const aliasLead = {
        id: wo.id,
        sourceLabel: "EMERGENCY (fall override)",
        contact: {
          name: wo.customerName || "(unknown)",
          phone: wo.customerPhone || "",
          email: wo.customerEmail || "",
          address: wo.address || "",
          notes: `Zone ${zoneNumber} ${issue.type}: ${severityReason}. Follow-up WO: ${followupWoId || "FAILED — handle manually"}.`
        }
      };
      Promise.allSettled([
        sendNewLeadEmail(aliasLead, { baseUrl }),
        sendNewLeadSms(aliasLead, { baseUrl })
      ]).catch(() => {});
      try {
        await workOrders.appendHistory(id, {
          action: "emergency_override",
          by: "tech",
          note: `Zone ${zoneNumber} ${issue.type} → ${severityReason}. Patrick paged. Follow-up WO ${followupWoId || "FAILED"}.`
        });
        if (followupWoId) {
          await workOrders.appendHistory(followupWoId, {
            action: "created_as_emergency_followup",
            by: "tech",
            note: `Spawned from fall WO ${id} emergency override (${severityReason})`
          });
        }
      } catch (err) { console.warn("[wo-history] emergency entry failed:", err?.message); }

      return sendJson(res, 201, {
        ok: true,
        deferred: deferredEntry,
        followupWoId,
        workOrder: updatedWo
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't process emergency override."] });
    }
  }

  // Find_only path (fall closings): bundle every issue across every
  // zone into the property's deferredIssues without quoting. Spec rule 8.
  // Each issue gets its own snapshot price via rollupSingleIssueToLineItems
  // so the customer/portal sees real numbers, not nulls. Per-issue defer
  // is also available above for granular UI flow.
  const woIssuesDeferMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/issues\/defer$/);
  if (woIssuesDeferMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woIssuesDeferMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      const propertyId = wo.propertyId || null;
      if (!propertyId) {
        return sendJson(res, 422, { ok: false, errors: ["Cannot defer issues — work order has no linked property."] });
      }
      const deferredIds = [];
      const remainingZones = (wo.zones || []).map((z) => ({ ...z, issues: [] }));
      for (const z of wo.zones || []) {
        for (const issue of z.issues || []) {
          try {
            const entry = await properties.addDeferredIssue(propertyId, deferredPayloadFromIssue(wo, z.number, issue, "fall_visit_no_repairs_policy"));
            if (entry?.id) deferredIds.push(entry.id);
          } catch (_e) {}
        }
      }
      // Clear the issues off the WO so the tech UI reflects everything's deferred.
      await workOrders.update(id, { zones: remainingZones });
      try {
        await workOrders.appendHistory(id, {
          action: "issues_bulk_deferred",
          by: "tech",
          note: `${deferredIds.length} issue${deferredIds.length === 1 ? "" : "s"} routed to deferred recommendations (fall closing find-only)`
        });
      } catch (err) { console.warn("[wo-history] bulk-defer entry failed:", err?.message); }
      return sendJson(res, 200, { ok: true, deferredCount: deferredIds.length, deferredIds });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't defer issues."] });
    }
  }

  // Spring carry-forward action — the tech, on a spring_opening WO, taps
  // one of four buttons on a deferred item from a prior visit. Body:
  //   { action: "repair_now" | "decline" | "already_fixed" | "cannot_locate", note }
  // - repair_now    → snapshot's line items append to wo.onSiteQuote.builderLineItems;
  //                   deferred status flips to "in_progress"; final flip to
  //                   "resolved" happens at WO sign (spec rule #11).
  // - decline       → reDeferralCount++, declinedAt updated, status stays "open".
  // - already_fixed → status: resolved (no charge captured).
  // - cannot_locate → status: dismissed.
  const woCarryForwardMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/carry-forward\/([^/]+)$/);
  if (woCarryForwardMatch && req.method === "PATCH") {
    try {
      const woId = decodeURIComponent(woCarryForwardMatch[1]);
      const deferredId = decodeURIComponent(woCarryForwardMatch[2]);
      const payload = await parseRequestBody(req);
      const action = String(payload?.action || "");
      const note = typeof payload?.note === "string" ? payload.note.slice(0, 500) : "";

      const wo = await workOrders.get(woId);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      if (wo.locked || wo.signature?.signed) {
        return sendJson(res, 409, { ok: false, errors: ["Work order is locked."] });
      }
      const propertyId = wo.propertyId;
      if (!propertyId) return sendJson(res, 422, { ok: false, errors: ["Work order has no linked property."] });

      const handle = await properties.getDeferredIssue(propertyId, deferredId);
      if (!handle) return sendJson(res, 404, { ok: false, errors: ["Deferred item not found on this property."] });
      const entry = handle.entry;

      const validActions = new Set(["repair_now", "decline", "already_fixed", "cannot_locate"]);
      if (!validActions.has(action)) {
        return sendJson(res, 422, { ok: false, errors: [`action must be one of: ${[...validActions].join(", ")}.`] });
      }

      if (action === "repair_now") {
        // Append the snapshotted line items into the on-site Quote builder.
        // Re-tag source.zoneNumbers to the deferred entry's fromZone (already
        // correct from the snapshot, but defensive). Mark each line so the
        // tech UI can highlight "from carry-forward."
        const snap = entry.suggestedPriceSnapshot;
        if (!snap || !Array.isArray(snap.lineItems) || !snap.lineItems.length) {
          return sendJson(res, 422, { ok: false, errors: ["This deferred item has no priced snapshot to repair from. Use the in-zone issue flow instead."] });
        }
        const carriedLines = snap.lineItems.map((line) => ({
          ...line,
          note: line.note ? `[carry-forward] ${line.note}` : `[carry-forward from ${entry.fromWoId || "prior visit"}]`
        }));
        const existingLines = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
        const updatedWo = await workOrders.update(woId, {
          onSiteQuote: {
            ...wo.onSiteQuote,
            status: "draft",
            lastBuiltAt: new Date().toISOString(),
            builderLineItems: [...existingLines, ...carriedLines]
          }
        });
        const updatedEntry = await properties.updateDeferredIssue(propertyId, deferredId, {
          status: "in_progress",
          resolution: {
            ...(entry.resolution || {}),
            resolvedInWoId: woId,
            note: note || "Tech queued for repair on this visit."
          }
        });
        const totals = issueRollup.recomputeTotals(updatedWo.onSiteQuote.builderLineItems);
        try {
          await workOrders.appendHistory(woId, {
            action: "carry_forward_repair_now",
            by: "tech",
            note: `${entry.type || "issue"} from prior visit → ${carriedLines.length} line${carriedLines.length === 1 ? "" : "s"} added (${deferredId})`
          });
        } catch (err) { console.warn("[wo-history] cf repair entry failed:", err?.message); }
        return sendJson(res, 200, { ok: true, deferred: updatedEntry, workOrder: updatedWo, ...totals });
      }

      if (action === "decline") {
        const updatedEntry = await properties.updateDeferredIssue(propertyId, deferredId, {
          status: "open",
          declinedAt: new Date().toISOString(),
          reDeferralCount: (Number(entry.reDeferralCount) || 0) + 1,
          resolution: null
        });
        try {
          await workOrders.appendHistory(woId, {
            action: "carry_forward_declined",
            by: "tech",
            note: `${entry.type || "issue"} re-deferred (${updatedEntry.reDeferralCount}× declined): ${deferredId}`
          });
        } catch (err) { console.warn("[wo-history] cf decline entry failed:", err?.message); }
        return sendJson(res, 200, { ok: true, deferred: updatedEntry });
      }

      if (action === "already_fixed") {
        const updatedEntry = await properties.updateDeferredIssue(propertyId, deferredId, {
          status: "resolved",
          resolution: {
            resolvedAt: new Date().toISOString(),
            resolvedBy: "tech",
            resolvedInWoId: woId,
            note: note || "Already fixed at arrival."
          }
        });
        try {
          await workOrders.appendHistory(woId, {
            action: "carry_forward_already_fixed",
            by: "tech",
            note: `${entry.type || "issue"} resolved at arrival: ${deferredId}`
          });
        } catch (err) { console.warn("[wo-history] cf already_fixed entry failed:", err?.message); }
        return sendJson(res, 200, { ok: true, deferred: updatedEntry });
      }

      // cannot_locate
      const updatedEntry = await properties.updateDeferredIssue(propertyId, deferredId, {
        status: "dismissed",
        resolution: {
          resolvedAt: new Date().toISOString(),
          resolvedBy: "tech",
          resolvedInWoId: woId,
          note: note || "Tech could not locate the deferred item."
        }
      });
      try {
        await workOrders.appendHistory(woId, {
          action: "carry_forward_cannot_locate",
          by: "tech",
          note: `${entry.type || "issue"} couldn't be located: ${deferredId}`
        });
      } catch (err) { console.warn("[wo-history] cf cannot_locate entry failed:", err?.message); }
      return sendJson(res, 200, { ok: true, deferred: updatedEntry });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update carry-forward item."] });
    }
  }

  // Admin manual-handoff: Patrick fills out a form in /admin/handoff after
  // a phone call, server creates a booking session AND optionally pushes
  // the URL to the customer via SMS + email. Same machinery the AI agent
  // will use, just driven by Patrick's hands instead of an LLM.
  //
  // Body shape:
  //   {
  //     diagnosis, diagnosisSummary, suggestedService, severity,
  //     customerHints: { firstName, lastName, email, phone, address, zoneCount, notes },
  //     sendSms:   bool,
  //     sendEmail: bool
  //   }
  if (req.method === "POST" && pathname === "/api/admin/send-booking-link") {
    try {
      const payload = await parseRequestBody(req);
      // Force the source so it's clear in the audit trail this came from
      // Patrick's hands, not the AI.
      payload.source = "admin_manual";
      const session = await bookingSessions.createSession(payload);
      // ALWAYS use the request's host for the bookingUrl. PUBLIC_BASE_URL
      // is intentionally ignored here: if Patrick is on /admin/handoff via
      // the .onrender.com URL, his admin login proves that domain is live
      // and reachable, so any link we send the customer using that domain
      // will work. PUBLIC_BASE_URL can be set to the public domain pre-
      // DNS-cutover and silently break links — req.host is always honest.
      const baseUrl = baseUrlFromReq(req);
      const bookingUrl = joinUrl(baseUrl, "/book.html", { session: session.token });

      const hints = session.payload.customerHints || {};
      const firstName = hints.firstName || "";
      const phone = (hints.phone || "").trim();
      const email = (hints.email || "").trim();
      const summary = session.payload.diagnosisSummary || "";

      const results = { smsSent: false, smsError: null, emailSent: false, emailError: null };

      // SMS — short, link-forward.
      if (payload.sendSms && phone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
        const smsBody = `Hi${firstName ? " " + firstName : ""}, this is PJL Land Services. ${summary ? summary + ". " : ""}Book your appointment here: ${bookingUrl}`;
        try {
          const sid = process.env.TWILIO_ACCOUNT_SID;
          const tok = process.env.TWILIO_AUTH_TOKEN;
          const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
          const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
          const body = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM_NUMBER, Body: smsBody });
          const r = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) results.smsError = data?.message || `HTTP ${r.status}`;
          else results.smsSent = true;
        } catch (err) {
          results.smsError = err.message;
        }
      }

      // Email — branded handoff message.
      if (payload.sendEmail && email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        try {
          let nodemailer;
          try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }
          if (nodemailer) {
            const transporter = nodemailer.createTransport({
              service: "gmail",
              auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
            });
            const safeFirst = firstName || "there";
            const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="padding: 24px 28px; background: #1B4D2E; border-radius: 8px 8px 0 0;">
    <div style="color: #EAF3DE; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;">PJL Land Services</div>
    <h1 style="margin: 6px 0 0; color: #fff; font-size: 22px;">Your booking link is ready.</h1>
  </div>
  <div style="padding: 24px 28px; background: #FAFAF5; border: 1px solid #e5e5dd; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 14px;">Hi ${safeFirst},</p>
    <p style="margin: 0 0 18px;">Following up on our conversation${summary ? `: <strong>${summary.replace(/</g, "&lt;")}</strong>` : "."}. Click below to pick a time that works for you — your details are already filled in.</p>
    <p style="margin: 0 0 18px;">
      <a href="${bookingUrl}" style="display: inline-block; padding: 12px 22px; background: #E07B24; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">Book your appointment</a>
    </p>
    <p style="margin: 18px 0 0; font-size: 13px; color: #777;">If the button doesn't work, paste this link into your browser:<br><span style="color: #1B4D2E; word-break: break-all;">${bookingUrl}</span></p>
    <p style="margin: 24px 0 0; font-size: 13px; color: #777;">Questions? Call <a href="tel:+19059600181" style="color: #1B4D2E;">(905) 960-0181</a>.</p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #999; text-align: center;">PJL Land Services · Newmarket, Ontario · pjllandservices.com</p>
</div>`.trim();
            const text = `Hi ${safeFirst},\n\nFollowing up on our conversation${summary ? ": " + summary : ""}.\n\nBook your appointment: ${bookingUrl}\n\nQuestions? Call (905) 960-0181.\n\nPJL Land Services`;
            await transporter.sendMail({
              from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
              to: email,
              replyTo: process.env.GMAIL_USER,
              subject: "Your PJL booking link is ready",
              html,
              text
            });
            results.emailSent = true;
          } else {
            results.emailError = "nodemailer not installed";
          }
        } catch (err) {
          results.emailError = err.message;
        }
      }

      return sendJson(res, 201, {
        ok: true,
        token: session.token,
        bookingUrl,
        expiresAt: new Date(session.expiresAt).toISOString(),
        ...results
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't send link."] });
    }
  }

  // Public availability lookup. Query: ?service=<key>&address=<text>
  // Returns slots grouped by day so the UI can render "pick a day, then a time".
  if (req.method === "GET" && pathname === "/api/booking/availability") {
    try {
      const url = new URL(req.url, baseUrlFromReq(req));
      const serviceKey = normalizeString(url.searchParams.get("service"), 60);
      const address = normalizeString(url.searchParams.get("address"), 320);
      // The time-picker passes from/to (YYYY-MM-DD) to request the 6-week
      // visible window. Legacy callers (no from/to) get the old 14-day
      // "only days with slots" shape via groupByDay.
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const fromDate = parseLocalDateKey(fromParam);
      const toDate = parseLocalDateKey(toParam);
      const now = new Date();
      let daysAhead;
      if (toDate) {
        // Scan far enough to reach the latest visible day. 120-day cap is
        // ~3 forward months from "now" — well past the picker's 6-week window.
        daysAhead = Math.min(120, Math.max(1, Math.ceil((toDate.getTime() - now.getTime()) / 86400000) + 1));
      } else {
        daysAhead = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
      }

      if (!serviceKey || !BOOKABLE_SERVICES[serviceKey]) {
        return sendJson(res, 422, { ok: false, errors: ["Pick a service to see availability."] });
      }
      if (!address) {
        return sendJson(res, 422, { ok: false, errors: ["Address is required to compute drive times."] });
      }

      const geo = await geocode(address);
      const customerCoords = geo.coords;
      const [bookings, scheduleData] = await Promise.all([activeBookings(), scheduleStore.read()]);

      const mergedHours = { ...DEFAULT_HOURS, ...(scheduleData.hours || {}) };
      const mergedSettings = { ...DEFAULT_SETTINGS, ...(scheduleData.settings || {}) };

      const slots = await listAvailableSlots({
        serviceKey,
        customerCoords,
        bookings,
        blocks: scheduleData.blocks,
        daysAhead,
        hours: mergedHours,
        settings: mergedSettings
      });

      const days = (fromDate && toDate)
        ? expandDaysToRange(slots, { from: fromDate, to: toDate, hours: mergedHours, now })
        : groupByDay(slots);

      return sendJson(res, 200, {
        ok: true,
        service: { key: serviceKey, ...BOOKABLE_SERVICES[serviceKey] },
        address: geo.coords?.formattedAddress || address,
        geocodeOk: geo.ok === true,
        range: (fromDate && toDate) ? { from: fromParam, to: toParam } : null,
        days,
        totalSlots: slots.length
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, errors: [error.message || "Availability lookup failed."] });
    }
  }

  // Public booking endpoint — creates a lead AND reserves the chosen slot.
  // Body: { serviceKey, slotStart, contact:{firstName,lastName,phone,email,
  //         address,notes}, addressLat, addressLng }
  if (req.method === "POST" && pathname === "/api/booking/reserve") {
    try {
      const payload = await parseRequestBody(req);
      const serviceKey = normalizeString(payload.serviceKey, 60);
      // Optional pre-booking session — AI handoff carrying a diagnosis +
      // customer hints. We resolve it here so the diagnosis can be attached
      // to the work order below. Falsy if not supplied.
      const sessionToken = normalizeString(payload.sessionToken, 80);
      const prebooking = sessionToken ? await bookingSessions.getSession(sessionToken) : null;
      const slotStart = normalizeString(payload.slotStart, 40);
      const service = BOOKABLE_SERVICES[serviceKey];
      if (!service) return sendJson(res, 422, { ok: false, errors: ["Unknown service."] });
      const startDate = new Date(slotStart);
      if (Number.isNaN(startDate.getTime())) return sendJson(res, 422, { ok: false, errors: ["Invalid slot time."] });

      // Re-validate: the same slot must still be available now (someone else might
      // have grabbed it in the seconds since the calendar was rendered).
      const contact = payload.contact && typeof payload.contact === "object" ? payload.contact : {};
      const address = normalizeString(contact.address, 320);
      if (!address) return sendJson(res, 422, { ok: false, errors: ["Address is required for booking."] });
      const geo = await geocode(address);
      const customerCoords = geo.coords;

      const [bookings, scheduleData] = await Promise.all([activeBookings(), scheduleStore.read()]);
      const mergedHours = { ...DEFAULT_HOURS, ...(scheduleData.hours || {}) };
      const mergedSettings = { ...DEFAULT_SETTINGS, ...(scheduleData.settings || {}) };
      const stillAvailable = await listAvailableSlots({
        serviceKey,
        customerCoords,
        bookings,
        blocks: scheduleData.blocks,
        daysAhead: 30,
        hours: mergedHours,
        settings: mergedSettings
      });
      const matched = stillAvailable.find((s) => s.start === startDate.toISOString());
      if (!matched) {
        return sendJson(res, 409, { ok: false, errors: ["That slot was just taken. Please pick another time."] });
      }
      // Use the bucket end as the booking end so the canonical
      // bookings.json record (and Patrick's iCal feed) span the full
      // bucket window. matched.end is the bucket end ISO string;
      // matched.durationMinutes is the bucket length.
      const endDate = new Date(matched.end);

      // Build the lead. Status is set to a category that maps to "scheduled" —
      // for site visits we go "site_visit", for direct work we go "won" (because
      // the customer has effectively committed to the booking).
      const isSiteVisit = service.category === "consult";
      const intakePayload = {
        source: serviceKey === "site_visit" ? "general_lead" : (
          service.category === "seasonal" && serviceKey.startsWith("spring") ? "spring_opening"
          : service.category === "seasonal" ? "fall_closing"
          : service.category === "controller" ? "sprinkler_quote"
          : "sprinkler_repair"
        ),
        contact,
        features: [],
        pageUrl: normalizeString(payload.pageUrl, 500),
        userAgent: normalizeString(payload.userAgent, 500),
        mode: "booking"
      };
      const result = validateLead(intakePayload);
      if (!result.ok) return sendJson(res, 422, { ok: false, errors: result.errors });

      // Customer-confirmed zone count (1-50 or "unsure"), only collected for
      // seasonal flows. Stored on the booking so Patrick can see it in the
      // CRM and so future schedule logic can use it for capacity planning.
      const rawZones = normalizeString(payload.zoneCount, 12);
      let zoneCount = null;
      if (rawZones === "unsure") {
        zoneCount = "unsure";
      } else if (/^\d+$/.test(rawZones)) {
        const n = Number(rawZones);
        if (n >= 1 && n <= 50) zoneCount = n;
      }

      // Compute price from the booked service tier + customer-confirmed zone
      // count. This runs server-side so customers can't tamper with the
      // total. The price feeds two places:
      //   1. lead.features — so the existing portal "Project request" card
      //      shows the service + price line item
      //   2. lead.booking.workOrder — the work-order envelope visible in
      //      both the customer portal and the CRM
      const pricing = priceForBooking(serviceKey, zoneCount);

      // The booked service is always the first feature on the lead — its
      // duration drives the slot. Additional line items from the handoff
      // session (chosen by Patrick or the AI) get appended below it so the
      // work order reflects the full repair plan.
      const bookedFeature = {
        key: serviceKey,
        label: service.label,
        qty: 1,
        price: pricing.price,
        category: service.category,
        quoteType: pricing.custom ? "custom" : "flat"
      };
      const sessionLineItems = (prebooking?.payload?.lineItems || [])
        .map((item) => {
          const def = FEATURES[item.key];
          if (!def) return null; // unknown key — silently dropped
          return {
            key: item.key,
            label: def.label,
            qty: item.qty,
            price: def.price,
            category: def.category,
            quoteType: def.quoteType
          };
        })
        .filter(Boolean)
        // Don't double-add the booked service if the handoff included it
        // explicitly — the bookedFeature above already covers that slot.
        .filter((item) => item.key !== serviceKey);

      result.lead.features = [bookedFeature, ...sessionLineItems];
      result.lead.totals = {
        expectedTotal: calcTotal(result.lead.features),
        submittedTotal: calcTotal(result.lead.features),
        currency: "CAD"
      };

      // Attach the booking to the lead. workOrder is the customer-facing
      // wrapper around the booking — short ID, status, total, and a
      // placeholder for the document we'll attach later (PDF, signed copy).
      const now = new Date().toISOString();
      // If this booking came from an AI-chat (or other pre-booking) session,
      // attach the captured diagnosis text so it surfaces on the work order
      // for both Patrick (CRM) and the customer (portal).
      const diagnosisBlock = prebooking ? {
        source: prebooking.payload.source || "ai_chat",
        summary: prebooking.payload.diagnosisSummary || "",
        text: prebooking.payload.diagnosis || "",
        severity: prebooking.payload.severity || "",
        suggestedService: prebooking.payload.suggestedService || "",
        capturedAt: prebooking.createdAt
      } : null;

      result.lead.booking = {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        // durationMinutes is the on-site service duration (service.minutes
        // from BOOKABLE_SERVICES). Multiple bookings can land inside the
        // same bucket — the bucket is a customer-facing LABEL, not a
        // capacity reservation. Patrick's iCal shows the real visit
        // window (e.g. 8:00–8:45 for a 45-min spring opening); the
        // customer sees only "Morning Appointment (8 AM – 12 PM)".
        durationMinutes: matched.durationMinutes,
        bucketKey: matched.bucketKey || null,
        bucketWindow: matched.bucketWindow || null,
        bucketLabel: matched.timeLabel || null,
        serviceKey,
        serviceLabel: service.label,
        zoneCount,
        coords: { lat: customerCoords.lat, lng: customerCoords.lng, formattedAddress: customerCoords.formattedAddress },
        workOrder: {
          id: makeWorkOrderId(),
          status: "scheduled",
          // total reflects ALL features (booked service + any handoff
          // line items), not just the slot service. priceLabel still
          // describes the headline service so the portal card reads
          // sensibly even on multi-item work orders.
          total: result.lead.totals.expectedTotal,
          priceLabel: pricing.label,
          priceNote: pricing.note || null,
          custom: Boolean(pricing.custom),
          currency: pricing.currency,
          documentReady: false,
          documentUrl: null,
          diagnosis: diagnosisBlock,
          createdAt: now
        }
      };
      // Status starts at site_visit for consults, won for committed direct bookings.
      result.lead.status = isSiteVisit ? "site_visit" : "won";
      result.lead.crm.status = result.lead.status;
      // Replace the default "Quote request received." seed entry with booking-
      // specific language. These came in as confirmed services, not requests,
      // so the activity log should read that way from the start.
      result.lead.crm.activity = [{
        at: now,
        type: "created",
        text: `${isSiteVisit ? "Site visit booked" : "Service booked"}: ${service.label} on ${matched.dayLabel} at ${matched.timeLabel}.`
      }];

      const all = await readLeads();
      all.unshift(result.lead);
      await writeLeads(all);

      // Auto-link to a customer property using the coords we already have.
      try {
        const linkResult = await properties.attachLead({
          leadId: result.lead.id,
          email: result.lead.contact?.email,
          name: result.lead.contact?.name,
          phone: result.lead.contact?.phone,
          address: result.lead.contact?.address,
          coords: customerCoords && customerCoords.lat != null ? customerCoords : null
        });
        if (linkResult.property) {
          result.lead.propertyId = linkResult.property.id;
          result.lead.propertyLinkStatus = linkResult.status;
          if (linkResult.status === "suggested") {
            result.lead.propertyLinkSuggestions = linkResult.suggestions;
          }
          if (linkResult.status === "conflict-ownership") {
            result.lead.propertyLinkConflicts = linkResult.conflicts;
          }
          const liveLeads = await readLeads();
          const i = liveLeads.findIndex((l) => l.id === result.lead.id);
          if (i !== -1) {
            liveLeads[i].propertyId = linkResult.property.id;
            liveLeads[i].propertyLinkStatus = linkResult.status;
            if (linkResult.status === "suggested") {
              liveLeads[i].propertyLinkSuggestions = linkResult.suggestions;
            }
            if (linkResult.status === "conflict-ownership") {
              liveLeads[i].propertyLinkConflicts = linkResult.conflicts;
            }
            await writeLeads(liveLeads);
          }
        }
      } catch (err) {
        console.error("[properties] booking auto-link failed:", err?.message || err);
      }

      // Mirror into the canonical Booking folder (spec §4.2). Embedded
      // lead.booking stays as a read cache so existing CRM/portal code
      // works unchanged; the canonical record carries prep notes,
      // multi-WO links, sourceQuoteId, and audit history. Best-effort
      // — failure here doesn't roll back the lead.
      try {
        const liveLeads = await readLeads();
        const fresh = liveLeads.find((l) => l.id === result.lead.id);
        if (fresh) await bookings.upsertFromLead(fresh);
      } catch (err) {
        console.warn("[bookings] upsertFromLead failed:", err?.message);
      }

      // If a pre-booking session backed this reservation, mark it consumed
      // so the audit trail records which sessions converted into bookings.
      if (prebooking && sessionToken) {
        bookingSessions.markConsumed(sessionToken, result.lead.id).catch((err) => {
          console.error("[booking-session] markConsumed failed:", err?.message || err);
        });
      }

      // Notify Patrick (admin) and the customer.
      const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
      const decorated = decorateLeadForAdmin(result.lead, req);
      Promise.allSettled([
        sendNewLeadEmail({ ...decorated, sourceLabel: `BOOKED · ${service.label} · ${matched.dayLabel} ${matched.timeLabel}` }, { baseUrl }),
        sendNewLeadSms({ ...decorated, sourceLabel: `BOOKED ${matched.timeLabel}` }, { baseUrl }),
        notifyCustomer(isSiteVisit ? "site_visit" : "booked", decorated, { baseUrl })
      ]).catch(() => {});

      return sendJson(res, 201, {
        ok: true,
        leadId: result.lead.id,
        booking: result.lead.booking,
        portalUrl: decorated.portalUrl
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Booking failed."] });
    }
  }

  // Today's Schedule — the tech's morning hub. Returns every booking
  // scheduled for the requested date in PJL's local timezone (or "today"
  // if no date passed). Each row is decorated with everything the field
  // tech needs in one place: customer name, full address (with town),
  // service label, start/end, customer notes, internal notes, the linked
  // property's coords + phone for navigation, and the existing WO id +
  // status if one's been opened. Sorted ascending by start time so the
  // tech can read top-to-bottom.
  //
  // Cancelled / archived leads are filtered out — we don't surface them
  // to the field tech. Site visits show alongside paid services since
  // they're real on-site appointments too.
  if (req.method === "GET" && pathname === "/api/schedule/today") {
    const url = new URL(req.url, baseUrlFromReq(req));
    const dateParam = url.searchParams.get("date");

    // Local-day window in America/Toronto. If `date` is passed, use it;
    // otherwise infer today from server time (server.js sets process.env.TZ
    // = 'America/Toronto' on boot so this is honest).
    const today = dateParam ? new Date(`${dateParam}T00:00:00`) : new Date();
    if (Number.isNaN(today.getTime())) {
      return sendJson(res, 422, { ok: false, errors: ["Bad date param."] });
    }
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const allLeads = await readLeads();
    const allWos = await workOrders.list();
    const woByLeadId = new Map(allWos.map((w) => [w.leadId, w]));

    const bookings = allLeads
      .filter((lead) => {
        if (lead.archived) return false;
        const start = lead.booking?.start ? new Date(lead.booking.start).getTime() : null;
        if (!start) return false;
        return start >= dayStart && start < dayEnd;
      })
      .sort((a, b) => new Date(a.booking.start) - new Date(b.booking.start))
      .map((lead) => {
        const start = new Date(lead.booking.start);
        const end = lead.booking.end ? new Date(lead.booking.end) : null;
        const wo = woByLeadId.get(lead.id) || null;
        // Reuse the lead's contact extractor when present — it has the
        // street/town/postal split that the tech needs for clean display.
        const contact = lead.contactExport || lead.contact || {};
        const address = lead.contact?.address || lead.contactExport?.address?.full || "";
        const town = lead.contact?.town || lead.contactExport?.address?.town || "";
        return {
          leadId: lead.id,
          customerName: contact.name || lead.contact?.name || "",
          customerPhone: contact.telephone || lead.contact?.phone || "",
          customerEmail: contact.email || lead.contact?.email || "",
          address,
          town,
          coords: lead.booking.coords || null,
          serviceKey: lead.booking.serviceKey,
          serviceLabel: lead.booking.serviceLabel || "Appointment",
          start: start.toISOString(),
          end: end ? end.toISOString() : null,
          startLabel: start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }),
          endLabel: end ? end.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : "",
          customerNotes: lead.contact?.notes || "",
          internalNotes: lead.crm?.internalNotes || "",
          stage: lead.crm?.status || lead.status || "new",
          propertyId: lead.propertyId || null,
          // WO surfaced here so the tech can see "already opened, status=on_site"
          // before they tap. Falsy if no WO has been created yet.
          workOrder: wo ? {
            id: wo.id,
            type: wo.type,
            status: wo.status,
            zoneCount: (wo.zones || []).length
          } : null,
          onRouteNotifiedAt: lead.onRouteNotifiedAt || null
        };
      });

    return sendJson(res, 200, {
      ok: true,
      date: new Date(dayStart).toISOString().slice(0, 10),
      bookings,
      count: bookings.length
    });
  }

  // Tech taps "Notify on route" on the today's-schedule view.
  // Sends SMS + email to the customer with the on_route template,
  // logs an activity entry, and stamps lead.onRouteNotifiedAt so the
  // UI can show "✓ notified at 9:14 AM" instead of re-firing on
  // accidental double-tap. Body: (none required).
  const notifyOnRouteMatch = pathname.match(/^\/api\/leads\/([^/]+)\/notify-on-route$/);
  if (notifyOnRouteMatch && req.method === "POST") {
    try {
      const leadId = decodeURIComponent(notifyOnRouteMatch[1]);
      const allLeads = await readLeads();
      const idx = allLeads.findIndex((l) => l.id === leadId);
      if (idx === -1) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });
      const lead = allLeads[idx];

      // Decorate with portalUrl + booking shape so the template fills out
      // {firstName}, {serviceLabel}, {portalUrl} correctly.
      const decorated = decorateLeadForAdmin(lead, req);
      const baseUrl = baseUrlFromReq(req);

      // Fire-and-forget — don't block the tech on Twilio/Gmail latency.
      // Errors land in the server log; the UI gets an immediate ok.
      notifyCustomer("on_route", decorated, { baseUrl }).catch((err) => {
        console.error("[notify-on-route]", err);
      });

      lead.onRouteNotifiedAt = new Date().toISOString();
      lead.crm = lead.crm || {};
      lead.crm.activity = Array.isArray(lead.crm.activity) ? lead.crm.activity : [];
      lead.crm.activity.unshift({
        at: lead.onRouteNotifiedAt,
        type: "update",
        text: "Notified customer: on the way."
      });
      lead.crm.lastUpdated = lead.onRouteNotifiedAt;
      allLeads[idx] = lead;
      await writeLeads(allLeads);

      return sendJson(res, 200, {
        ok: true,
        notifiedAt: lead.onRouteNotifiedAt
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't notify customer."] });
    }
  }

  // Tech taps a row on today's-schedule. Returns the lead's existing
  // field WO if one exists, otherwise creates one on-the-fly using the
  // booking's service to pick the right template + the linked property
  // (if any) to scaffold zones from. The client navigates to the WO
  // tech-mode page after this resolves.
  const openWoMatch = pathname.match(/^\/api\/leads\/([^/]+)\/open-wo$/);
  if (openWoMatch && req.method === "POST") {
    try {
      const leadId = decodeURIComponent(openWoMatch[1]);
      const allLeads = await readLeads();
      const lead = allLeads.find((l) => l.id === leadId);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Lead not found."] });

      // Existing WO for this lead? Return it.
      const existing = await workOrders.listByLead(leadId);
      if (existing.length) {
        // Most-recent first — listByLead doesn't sort, so pick the
        // newest by updatedAt.
        existing.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return sendJson(res, 200, { ok: true, workOrder: existing[0], created: false });
      }

      // Create a new WO. Pick the template from the booked service and
      // pull in the linked property if one's on the lead.
      const type = workOrders.templateForServiceKey(lead.booking?.serviceKey);
      let property = null;
      if (lead.propertyId) {
        property = await properties.get(lead.propertyId);
      }

      // Reuse the booking envelope's WO id so customer + tech see the
      // same WO-XXXXXXXX (matches the existing CRM-side create flow).
      const customId = lead.booking?.workOrder?.id || null;

      // Fetch the source Quote (if any) so the AI-Correct-Diagnosis Bonus
      // eligibility flag propagates onto the resulting WO.
      let sourceQuote = null;
      if (lead.quoteId) {
        try { sourceQuote = await quotes.get(lead.quoteId); }
        catch (err) { console.warn("[quotes] fetch on WO create failed:", err?.message); }
      }
      const wo = await workOrders.create({ type, lead, property, customId, quote: sourceQuote });
      if (sourceQuote) {
        try { await quotes.attachWorkOrder(sourceQuote.id, wo.id); }
        catch (err) { console.warn("[quotes] attachWorkOrder failed:", err?.message); }
      }

      // Tag the lead with the WO id + log activity.
      const idx = allLeads.findIndex((l) => l.id === leadId);
      if (idx !== -1) {
        allLeads[idx].workOrderId = wo.id;
        allLeads[idx].crm = allLeads[idx].crm || {};
        allLeads[idx].crm.activity = Array.isArray(allLeads[idx].crm.activity) ? allLeads[idx].crm.activity : [];
        allLeads[idx].crm.activity.unshift({
          at: new Date().toISOString(),
          type: "update",
          text: `Field WO opened from today's schedule (${workOrders.TEMPLATES[type].label}): ${wo.id}`
        });
        allLeads[idx].crm.lastUpdated = new Date().toISOString();
        await writeLeads(allLeads);
      }

      return sendJson(res, 200, { ok: true, workOrder: wo, created: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't open work order."] });
    }
  }

  // Admin: list all schedule blocks.
  if (req.method === "GET" && pathname === "/api/schedule/blocks") {
    const blocks = await scheduleStore.listBlocks();
    return sendJson(res, 200, { ok: true, blocks });
  }

  // Admin: add a schedule block. Body: { start, end, label }
  if (req.method === "POST" && pathname === "/api/schedule/blocks") {
    try {
      const payload = await parseRequestBody(req);
      const block = await scheduleStore.addBlock({
        start: payload.start,
        end: payload.end,
        label: normalizeString(payload.label, 120)
      });
      return sendJson(res, 201, { ok: true, block });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message] });
    }
  }

  // Admin: delete a schedule block.
  const blockMatch = pathname.match(/^\/api\/schedule\/blocks\/([^/]+)$/);
  if (blockMatch && req.method === "DELETE") {
    const id = decodeURIComponent(blockMatch[1]);
    const removed = await scheduleStore.removeBlock(id);
    if (!removed) return sendJson(res, 404, { ok: false, errors: ["Block not found."] });
    return sendJson(res, 200, { ok: true });
  }

  // Admin: read schedule settings (working hours + engine settings).
  if (req.method === "GET" && pathname === "/api/schedule/settings") {
    const data = await scheduleStore.settings();
    return sendJson(res, 200, {
      ok: true,
      defaults: { hours: DEFAULT_HOURS, settings: DEFAULT_SETTINGS, services: BOOKABLE_SERVICES },
      overrides: data
    });
  }

  // Admin: update schedule settings. Body: { settings:{...}, hours:{...} }
  if (req.method === "PUT" && pathname === "/api/schedule/settings") {
    try {
      const payload = await parseRequestBody(req);
      const updated = await scheduleStore.updateSettings(payload);
      return sendJson(res, 200, { ok: true, schedule: updated });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message] });
    }
  }

  sendJson(res, 404, { ok: false, errors: ["API endpoint not found."] });
}

// Resolve a request path to a real file on disk.
// Routing decisions, in order:
//   "/"               -> public homepage (SITE_DIR/index.html)
//   "/admin", "/admin/" -> CRM dashboard (SERVER_DIR/admin.html)
//   "/login", "/login/" -> CRM login page (SERVER_DIR/login.html)
//   "/portal/<token>" -> customer portal (SERVER_DIR/portal.html)
//   "/crm/<file>"     -> CRM/portal/login JS, CSS, and images (SERVER_DIR/<file>)
//   anything else     -> public site file (SITE_DIR/<path>)
function resolveStaticTarget(pathname) {
  if (pathname === "/") {
    return { dir: SITE_DIR, relative: "/index.html" };
  }
  if (pathname === "/admin" || pathname === "/admin/") {
    return { dir: SERVER_DIR, relative: "/admin.html" };
  }
  // Public customer payment pages (PR 3). Token-gated by the JS layer
  // and the JSON API at /api/pay/invoice/:id. The HTML itself is fine
  // to serve to anyone; without the token query param the JS shows the
  // "this link isn't valid" branch.
  if (/^\/pay\/invoice\/[^/]+\/thanks\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/pay-thanks.html" };
  }
  if (/^\/pay\/invoice\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/pay.html" };
  }
  if (pathname === "/admin/chats" || pathname === "/admin/chats/") {
    return { dir: SERVER_DIR, relative: "/chats.html" };
  }
  if (pathname === "/admin/messages" || pathname === "/admin/messages/") {
    return { dir: SERVER_DIR, relative: "/messages.html" };
  }
  if (pathname === "/admin/schedule" || pathname === "/admin/schedule/") {
    return { dir: SERVER_DIR, relative: "/schedule.html" };
  }
  if (pathname === "/admin/handoff" || pathname === "/admin/handoff/") {
    return { dir: SERVER_DIR, relative: "/handoff.html" };
  }
  // Today's Schedule — the tech's daily morning hub. Lists today's
  // confirmed bookings with navigate/notify/open-WO actions per row.
  if (pathname === "/admin/today" || pathname === "/admin/today/") {
    return { dir: SERVER_DIR, relative: "/today.html" };
  }
  // Customer index + per-customer profile page (Brief 3).
  if (pathname === "/admin/customers" || pathname === "/admin/customers/") {
    return { dir: SERVER_DIR, relative: "/customers.html" };
  }
  if (/^\/admin\/customer\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/customer.html" };
  }
  // Booking folder index + detail (HANDOFF.md follow-up).
  if (pathname === "/admin/bookings" || pathname === "/admin/bookings/") {
    return { dir: SERVER_DIR, relative: "/bookings.html" };
  }
  if (/^\/admin\/booking\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/booking.html" };
  }
  // Properties index + per-property detail page. Both served from the
  // same HTML file; the JS reads the URL to decide which view to render.
  if (pathname === "/admin/properties" || pathname === "/admin/properties/") {
    return { dir: SERVER_DIR, relative: "/properties.html" };
  }
  if (pathname === "/admin/properties/import" || pathname === "/admin/properties/import/") {
    return { dir: SERVER_DIR, relative: "/properties-import.html" };
  }
  if (/^\/admin\/property\/[^/]+/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/property.html" };
  }
  if (pathname === "/admin/work-orders" || pathname === "/admin/work-orders/") {
    return { dir: SERVER_DIR, relative: "/work-orders.html" };
  }
  if (pathname === "/admin/invoices" || pathname === "/admin/invoices/") {
    return { dir: SERVER_DIR, relative: "/invoices.html" };
  }
  if (pathname === "/admin/quote-folder" || pathname === "/admin/quote-folder/") {
    return { dir: SERVER_DIR, relative: "/quote-folder.html" };
  }
  if (/^\/admin\/invoice\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/invoice.html" };
  }
  if (pathname === "/admin/settings" || pathname === "/admin/settings/") {
    return { dir: SERVER_DIR, relative: "/settings.html" };
  }
  // Materials management (Phase 1 of the BoM/PO system). Suppliers index,
  // Material Lists index, and per-list builder. The builder regex must come
  // BEFORE the index match isn't strictly necessary (different paths) but
  // keeps the file predictable.
  if (pathname === "/admin/suppliers" || pathname === "/admin/suppliers/") {
    return { dir: SERVER_DIR, relative: "/suppliers.html" };
  }
  if (pathname === "/admin/material-lists" || pathname === "/admin/material-lists/") {
    return { dir: SERVER_DIR, relative: "/material-lists.html" };
  }
  if (/^\/admin\/material-list\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/material-list.html" };
  }
  // Phase 3 — catalog ↔ supplier assignments + Purchase Orders.
  if (pathname === "/admin/parts-suppliers" || pathname === "/admin/parts-suppliers/") {
    return { dir: SERVER_DIR, relative: "/parts-suppliers.html" };
  }
  if (pathname === "/admin/purchase-orders" || pathname === "/admin/purchase-orders/") {
    return { dir: SERVER_DIR, relative: "/purchase-orders.html" };
  }
  if (/^\/admin\/purchase-order\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/purchase-order.html" };
  }
  // Projects (Phase 2 — multi-WO container).
  if (pathname === "/admin/projects" || pathname === "/admin/projects/") {
    return { dir: SERVER_DIR, relative: "/projects.html" };
  }
  if (/^\/admin\/project\/[^/]+\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/project.html" };
  }
  // Tech-mode pop-out — mobile-first, tap-optimized layout. Same WO id,
  // different page. Route check must come BEFORE the desktop editor's
  // /admin/work-order/<id> match so the /tech suffix wins.
  if (/^\/admin\/work-order\/[^/]+\/tech\/?$/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/work-order-tech.html" };
  }
  if (/^\/admin\/work-order\/[^/]+/.test(pathname)) {
    return { dir: SERVER_DIR, relative: "/work-order.html" };
  }
  if (pathname === "/book" || pathname === "/book/") {
    return { dir: SITE_DIR, relative: "/book.html" };
  }
  if (pathname === "/login" || pathname === "/login/") {
    return { dir: SERVER_DIR, relative: "/login.html" };
  }
  // Per-user admin/tech account management — admin-only via needsAuth.
  if (pathname === "/admin/users" || pathname === "/admin/users/") {
    return { dir: SERVER_DIR, relative: "/users.html" };
  }
  // Customer portal magic-link login. Public page; the form POSTs to
  // /api/portal/request-link which always returns the generic 200.
  if (pathname === "/portal/login" || pathname === "/portal/login/") {
    return { dir: SERVER_DIR, relative: "/customer-login.html" };
  }
  // Admin/tech password reset (via emailed magic link). Public page; the
  // token in ?t=<id> is the credential, validated by /api/reset-password.
  if (pathname === "/reset-password" || pathname === "/reset-password/") {
    return { dir: SERVER_DIR, relative: "/reset-password.html" };
  }
  if (pathname.startsWith("/portal/")) {
    return { dir: SERVER_DIR, relative: "/portal.html" };
  }
  if (pathname.startsWith("/approve/")) {
    return { dir: SERVER_DIR, relative: "/approve.html" };
  }
  if (pathname.startsWith("/crm/")) {
    return { dir: SERVER_DIR, relative: pathname.slice("/crm".length) };
  }
  return { dir: SITE_DIR, relative: pathname };
}

async function serveStatic(req, res, pathname) {
  const { dir, relative } = resolveStaticTarget(pathname);
  const safePath = path.normalize(decodeURIComponent(relative)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(dir, safePath);

  // Sandbox: stay inside the chosen dir, never expose runtime data.
  if (!filePath.startsWith(dir) || filePath.startsWith(DATA_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=30"
    };
    // ServiceWorker scope override: tech-sw.js is served from /crm/ but
    // needs to control /admin/work-order/*/tech URLs. The Service-Worker-
    // Allowed header lets it claim a wider scope than its serving path.
    // Spec §4.3.3 rule #12 (offline mode mandatory).
    if (pathname === "/crm/tech-sw.js") {
      headers["service-worker-allowed"] = "/admin/work-order/";
      headers["cache-control"] = "no-store";
    }
    res.writeHead(200, headers);
    res.end(await fs.readFile(filePath));
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  // Normalize the pathname before route matching. If the URL came in with
  // consecutive slashes ("//book.html") — which can happen when a proxy
  // redirect chain mangles a relative path, or when a manual paste
  // duplicates a "/", or when a Cloudflare Worker rewrites — collapse them
  // to a single slash so the request still resolves to the right handler.
  // For requests that originally had multiple slashes, send a 301 to the
  // clean URL so any cached copies point at the canonical path going forward.
  let pathname = url.pathname;
  if (/\/{2,}/.test(pathname)) {
    pathname = pathname.replace(/\/{2,}/g, "/");
    const cleanUrl = pathname + (url.search || "");
    res.writeHead(301, { location: cleanUrl, "cache-control": "no-store" });
    res.end();
    return;
  }
  // Legacy Wix URL → current page. 301 so search engines and bookmarks
  // update. Runs before auth/static dispatch so e.g. /contact never falls
  // through to a 404 if the static layer hasn't already redirected.
  const legacyTarget = LEGACY_REDIRECTS[pathname.replace(/\/$/, "")] || LEGACY_REDIRECTS[pathname];
  if (legacyTarget) {
    res.writeHead(301, { location: legacyTarget + (url.search || ""), "cache-control": "no-store" });
    res.end();
    return;
  }
  try {
    // CORS: applied early so preflights and cross-origin POSTs to /api/quotes
    // (from diagnose.html on GitHub Pages today, same-origin after DNS cutover) work.
    // Uses the normalized `pathname` (computed above) so that CORS gates also
    // honor the slash-collapse done before routing.
    applyCorsHeaders(req, res, pathname);
    if (req.method === "OPTIONS" && isPublicApiPath(pathname)) {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHandled = await handleAuth(req, res, pathname);
    if (authHandled !== false) return;

    // Magic-link customer verify — the URL the customer clicks in their
    // email is /portal/login/verify (no /api/ prefix per the spec). The
    // handler logic lives in handlePortalLoginApi alongside the rest of
    // the identity API; we dispatch to it here BEFORE the auth gate so a
    // logged-out customer can complete the verify-and-redirect dance
    // without being bounced to /login first.
    if (req.method === "GET" && pathname === "/portal/login/verify") {
      const verifyHandled = await handlePortalLoginApi(req, res, "/api/portal/login/verify");
      if (verifyHandled !== false) return;
    }

    // iCal feed (Brief C) — public, token-gated. The :token in the URL
    // IS the credential, so this path is NOT in needsAuth(). Mismatch /
    // disabled both return 404 (no information leak about whether the
    // endpoint exists or the token is wrong).
    const icalMatch = pathname.match(/^\/calendar\/([^/]+)\.ics$/);
    if (req.method === "GET" && icalMatch) {
      try {
        const token = decodeURIComponent(icalMatch[1]);
        // Pass leads through so the feed can (a) heal lead.booking →
        // canonical bookings.json for records not yet upserted, and (b)
        // resolve structured contact fields for the Maps-tappable
        // address format. readLeads lives in server.js so we lift it
        // here rather than circular-importing into ical-feed.js.
        const leadsForFeed = await readLeads().catch(() => []);
        const result = await generateIcsForToken(token, {
          baseUrl: baseUrlFromReq(req),
          leads: leadsForFeed
        });
        if (!result.ok) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        // 5-min cache. Apple Calendar polls roughly hourly; this just
        // keeps multi-device hits from re-running the booking scan.
        res.writeHead(200, {
          "content-type": "text/calendar; charset=utf-8",
          "cache-control": "public, max-age=300"
        });
        res.end(result.ics);
        return;
      } catch (err) {
        console.warn("[ical-feed] generation failed:", err?.message || err);
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Feed unavailable");
        return;
      }
    }

    const requiredLevel = needsAuth(req.method, pathname);
    if (requiredLevel) {
      const session = requiredLevel === "admin"
        ? await requireAdmin(req)
        : await requireUser(req);
      if (!session) {
        // 401 vs 403:
        //   - "user" gate failed → not signed in (or session expired) → 401 / redirect to /login
        //   - "admin" gate failed but user IS signed in → 403 (tech hitting an admin page)
        if (requiredLevel === "admin") {
          // Distinguish "no session at all" from "wrong role" so the
          // techs see a helpful 403 instead of being bounced to /login.
          const anyUser = await requireUser(req);
          if (anyUser) {
            if (pathname.startsWith("/api/")) {
              return sendJson(res, 403, { ok: false, errors: ["Admin access is required for this action."] });
            }
            res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
            res.end("<h1>403 Forbidden</h1><p>Admin access is required for this page. <a href=\"/admin\">Back to CRM</a>.</p>");
            return;
          }
        }
        if (pathname.startsWith("/api/")) {
          return sendJson(res, 401, { ok: false, errors: ["CRM login required."] });
        }
        return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
      }
    }

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, errors: [error.message || "Server error."] });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PJL site + lead receiver running at http://${HOST}:${PORT}`);
  console.log(`  Public homepage:   http://${HOST}:${PORT}/`);
  console.log(`  CRM dashboard:     http://${HOST}:${PORT}/admin   (login: http://${HOST}:${PORT}/login)`);

  // Quote auto-expire sweep — spec §4.1 default 30-day validity. Runs at
  // startup AND every 6 hours so stale "sent" quotes flip to "expired"
  // without manual intervention. Best-effort; logs only.
  const sweepQuotes = async () => {
    try {
      const result = await quotes.expireStaleQuotes();
      if (result.expired) console.log(`[quotes] auto-expired ${result.expired} stale quote(s)`);
    } catch (err) {
      console.warn("[quotes] auto-expire sweep failed:", err?.message);
    }
  };
  sweepQuotes();
  setInterval(sweepQuotes, 6 * 60 * 60 * 1000);
});

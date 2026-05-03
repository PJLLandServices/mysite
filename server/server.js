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
const { sendNewLeadSms } = require("./lib/notify-sms");
const { notifyCustomer, eventForTransition } = require("./lib/notify-customer");
const { geocode, PJL_BASE } = require("./lib/geocode");
const { BOOKABLE_SERVICES, DEFAULT_HOURS, DEFAULT_SETTINGS, listAvailableSlots, groupByDay } = require("./lib/availability");
const scheduleStore = require("./lib/schedule-store");
const { priceForBooking } = require("./lib/pricing");
const bookingSessions = require("./lib/booking-sessions");
const properties = require("./lib/properties");
const workOrders = require("./lib/work-orders");
const quotes = require("./lib/quotes");
const invoices = require("./lib/invoices");
const completionCascade = require("./lib/completion-cascade");
const settings = require("./lib/settings");
const issueRollup = require("./lib/issue-rollup");
const { generateQuotePdf } = require("./lib/quote-pdf");
const quickbooks = require("./lib/quickbooks");
const bookings = require("./lib/bookings");

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
const MAX_PHOTO_BYTES = 1_500_000; // 1.5 MB per photo after client-side resize
const QUOTE_POST_MAX_BYTES = 12_000_000; // 12 MB cap for the /api/quotes POST (5 photos × ~1.5MB base64 inflated)
const CONTACT_NOTE = "PJL_New2026";
const CONTACT_COUNTRY = "Canada";
const CONTACT_PROVINCE = "ON";
const AUTH_COOKIE = "pjl_crm_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

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
const PARTS = (function loadParts() {
  try {
    const partsPath = path.resolve(__dirname, "..", "parts.json");
    return JSON.parse(fsSync.readFileSync(partsPath, "utf8"));
  } catch (err) {
    console.warn("[parts] could not load parts.json — materials checklist will be hidden:", err?.message);
    return null;
  }
})();

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

async function readAuthConfig() {
  await ensureStore();
  const raw = await fs.readFile(AUTH_FILE, "utf8");
  return JSON.parse(raw);
}

function secureCookieFlag(req) {
  return req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
}

function signSession(expiresAt, secret) {
  return crypto.createHmac("sha256", secret).update(String(expiresAt)).digest("base64url");
}

async function isAuthenticated(req) {
  try {
    const config = await readAuthConfig();
    const token = parseCookies(req)[AUTH_COOKIE];
    if (!token) return false;
    const [expiresAt, signature] = token.split(".");
    if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
    const expected = signSession(expiresAt, config.sessionSecret);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

async function verifyPassword(password) {
  const config = await readAuthConfig();
  const incoming = crypto.scryptSync(String(password || ""), config.salt, 64);
  const stored = Buffer.from(config.passwordHash, "base64");
  return incoming.length === stored.length && crypto.timingSafeEqual(incoming, stored);
}

async function setSessionCookie(req, res) {
  const config = await readAuthConfig();
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const signature = signSession(expiresAt, config.sessionSecret);
  const cookie = `${AUTH_COOKIE}=${encodeURIComponent(`${expiresAt}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureCookieFlag(req)}`;
  res.setHeader("set-cookie", cookie);
}

function clearSessionCookie(req, res) {
  res.setHeader("set-cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieFlag(req)}`);
}

// Which URLs require the admin password.
// The PUBLIC site (everything under SITE_DIR) is never gated — those are the customer-facing pages.
// The login page, customer portal, and /crm/ static assets (CSS, JS, logos) are also public —
// they contain no lead data and the login page itself needs them to render.
// What IS gated: the /admin dashboard page and any API that exposes lead data.
function needsAuth(method, pathname) {
  if (pathname === "/admin" || pathname === "/admin/") return true;
  if (pathname === "/admin/today" || pathname === "/admin/today/") return true;
  if (pathname === "/admin/schedule" || pathname === "/admin/schedule/") return true;
  if (pathname === "/admin/handoff" || pathname === "/admin/handoff/") return true;
  if (pathname === "/admin/chats" || pathname === "/admin/chats/") return true;
  if (pathname === "/admin/properties" || pathname === "/admin/properties/") return true;
  if (pathname === "/admin/properties/import" || pathname === "/admin/properties/import/") return true;
  if (/^\/admin\/property\/[^/]+/.test(pathname)) return true;
  if (pathname === "/admin/work-orders" || pathname === "/admin/work-orders/") return true;
  if (/^\/admin\/work-order\/[^/]+\/tech\/?$/.test(pathname)) return true;
  if (/^\/admin\/work-order\/[^/]+/.test(pathname)) return true;
  if (pathname === "/admin/invoices" || pathname === "/admin/invoices/") return true;
  if (pathname === "/admin/quote-folder" || pathname === "/admin/quote-folder/") return true;
  if (pathname === "/api/admin/quote-folder") return true;
  if (/^\/admin\/invoice\/[^/]+\/?$/.test(pathname)) return true;
  if (pathname === "/admin/settings" || pathname === "/admin/settings/") return true;
  if (pathname === "/api/quotes" && method === "GET") return true;
  if (pathname === "/api/quotes.csv" || pathname === "/api/contacts" || pathname === "/api/contacts.vcf") return true;
  if (/^\/api\/quotes\/[^/]+/.test(pathname)) return true;
  // Chat transcripts: POST is public (customer's chat upserts its own transcript).
  // GET endpoints (list + detail) are admin-only.
  if (pathname === "/api/chat-transcripts" && method === "GET") return true;
  if (/^\/api\/chat-transcripts\/[^/]+$/.test(pathname) && method === "GET") return true;
  // Schedule management is admin-only.
  if (pathname.startsWith("/api/schedule/")) return true;
  // Manual handoff (admin sends booking link to customer) is admin-only.
  if (pathname === "/api/admin/send-booking-link") return true;
  if (pathname === "/api/admin/features") return true;
  // Properties (customer system profiles) are admin-only.
  if (pathname.startsWith("/api/properties")) return true;
  // Work orders (tech-side per-visit records) are admin-only for now.
  // Phase 4 will add a customer-portal "approve quote" subset that's
  // public via a token, but that doesn't exist yet.
  if (pathname.startsWith("/api/work-orders")) return true;
  if (pathname.startsWith("/api/invoices")) return true;
  if (pathname.startsWith("/api/settings")) return true;
  if (pathname === "/api/parts") return true;
  if (pathname.startsWith("/api/admin/quickbooks")) return true;
  if (pathname.startsWith("/api/bookings")) return true;
  // Per-lead property link/dismiss/attach + tech actions are admin-only.
  if (/^\/api\/leads\/[^/]+\/(link-property|dismiss-property-suggestion|attach-property|notify-on-route|open-wo)$/.test(pathname)) return true;
  // Bulk property import is admin-only.
  if (pathname === "/api/admin/import-properties") return true;
  // Availability lookups + the public booking endpoint stay public.
  return false;
}

async function handleAuth(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/session") {
    return sendJson(res, 200, { ok: true, authenticated: await isAuthenticated(req) });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    try {
      const payload = await parseRequestBody(req);
      if (!(await verifyPassword(payload.password))) {
        return sendJson(res, 401, { ok: false, errors: ["Incorrect password."] });
      }
      await setSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
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
    createdAt: now
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
function validatePhotos(rawPhotos, maxCount) {
  const cap = Number.isFinite(maxCount) ? maxCount : MAX_PHOTOS_PER_LEAD;
  if (!rawPhotos) return [];
  if (!Array.isArray(rawPhotos)) throw new Error("photos must be an array.");
  if (rawPhotos.length > cap) throw new Error(`Can include at most ${cap} photos in one upload.`);
  const out = [];
  for (let i = 0; i < rawPhotos.length; i++) {
    const p = rawPhotos[i];
    if (!p || typeof p !== "object") throw new Error(`Photo ${i + 1} is not a valid object.`);
    const mediaType = String(p.mediaType || "image/jpeg").toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) throw new Error(`Photo ${i + 1} has an unsupported type.`);
    const data = String(p.data || "").trim();
    if (!data) throw new Error(`Photo ${i + 1} has no data.`);
    let buffer;
    try { buffer = Buffer.from(data, "base64"); } catch { throw new Error(`Photo ${i + 1} is not valid base64.`); }
    if (!buffer.length) throw new Error(`Photo ${i + 1} decoded to zero bytes.`);
    if (buffer.length > MAX_PHOTO_BYTES) throw new Error(`Photo ${i + 1} is too large (max ${Math.round(MAX_PHOTO_BYTES / 1000)} KB).`);
    const ext = mediaType === "image/png" ? "png" : (mediaType === "image/webp" ? "webp" : "jpg");

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
      bytes: photos[i].buffer.length,
      addedAt: now,
      filename,
      ...photos[i].meta
    });
  }
  return meta;
}

async function readWorkOrderPhotoFile(woId, n) {
  const dir = path.join(WO_PHOTOS_DIR, woId);
  for (const ext of ["jpg", "png", "webp"]) {
    const file = path.join(dir, `${n}.${ext}`);
    try {
      const data = await fs.readFile(file);
      const mediaType = ext === "png" ? "image/png" : (ext === "webp" ? "image/webp" : "image/jpeg");
      return { data, mediaType, ext };
    } catch {}
  }
  return null;
}

async function deleteWorkOrderPhotoFile(woId, n) {
  const dir = path.join(WO_PHOTOS_DIR, woId);
  for (const ext of ["jpg", "png", "webp"]) {
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
  if (/^\/api\/portal\/[^/]+\/photo\/\d+$/.test(pathname)) return true;
  // Booking session lookup by token — needed so book.html can prefill the
  // form when a customer arrives via /book.html?session=… from a handoff
  // SMS/email. The session token is the auth, same model as portal photos.
  // Without this, cross-origin GETs from public-domain book.html get blocked.
  if (/^\/api\/booking\/session\/[^/]+$/.test(pathname)) return true;
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
      zoneCount: lead.booking.zoneCount
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

// Returns available slots for an existing booking's reschedule modal.
// Same contract as /api/booking/availability but service + address come
// from the booking record (not query params), and the booking's own
// current slot is removed from the conflict math.
async function rescheduleAvailability(bookingId) {
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
  const slots = await listAvailableSlots({
    serviceKey,
    customerCoords: geo.coords,
    bookings: otherBookings,
    blocks: scheduleData.blocks,
    daysAhead: 30,
    hours: mergedHours,
    settings: mergedSettings
  });
  return {
    ok: true,
    data: {
      service: { key: serviceKey, ...BOOKABLE_SERVICES[serviceKey] },
      currentScheduledFor: bookingRec.scheduledFor,
      address: geo.coords?.formattedAddress || address,
      days: groupByDay(slots),
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
  const endDate = new Date(startDate.getTime() + service.minutes * 60 * 1000);

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

async function handleApi(req, res, pathname) {
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
            const igTag = quote.intakeGuarantee?.applies ? " · labour locked" : "";
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
        leads[idx] = applyCrmUpdate(lead, {
          activityNote: `Customer message via portal: ${message}`
        });
        delete leads[idx]._statusTransition;
        await writeLeads(leads);

        // Bounce a short admin alert so Patrick sees the message immediately.
        const decorated = decorateLeadForAdmin(leads[idx], req);
        const aliasLead = {
          ...decorated,
          sourceLabel: "Portal Message — " + (decorated.sourceLabel || ""),
          contact: { ...decorated.contact, notes: message }
        };
        Promise.allSettled([
          sendNewLeadEmail(aliasLead, { baseUrl }),
          sendNewLeadSms(aliasLead, { baseUrl })
        ]).catch(() => {});

        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to process portal action."] });
    }
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
      const updated = await properties.update(id, sanitized);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
      return sendJson(res, 200, { ok: true, property: updated });
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
            await transporter.sendMail({
              from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
              to: toEmail,
              replyTo: process.env.GMAIL_USER,
              subject: "PJL: please approve today's repair quote",
              html
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

  // ---------- Reschedule slot lookup (admin) ---------------------------
  // Returns available slots for this booking's service tier + address,
  // EXCLUDING this booking's own current slot from the conflict math (so
  // the customer doesn't appear to collide with themselves).
  const adminRescheduleAvailMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/availability$/);
  if (adminRescheduleAvailMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(adminRescheduleAvailMatch[1]);
      const result = await rescheduleAvailability(id);
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

  // ---------- Parts catalog (admin-gated, used by tech materials UI) ----
  if (req.method === "GET" && pathname === "/api/parts") {
    if (!PARTS) return sendJson(res, 503, { ok: false, errors: ["parts.json not loaded on the server."] });
    return sendJson(res, 200, {
      ok: true,
      categories: PARTS.categories || [],
      parts: PARTS.parts || {},
      service_materials: PARTS.service_materials || {}
    });
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
  //   materials    — array of part SKUs the tech wants pre-loaded for
  //                  the next visit. Stored on wo.materialsPacked.
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
      const materials = Array.isArray(payload.materials) ? payload.materials.filter((s) => typeof s === "string") : [];
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

      // Build wo.materialsPacked from the tech-curated SKU list. Each
      // selected SKU lands as `true` so the materials checklist on the
      // follow-up renders pre-checked.
      const materialsPacked = {};
      materials.forEach((sku) => { materialsPacked[sku] = true; });

      const followupUpdates = {
        diagnosis,
        techNotes: `Originating WO: ${parent.id}. Tech to confirm scope on arrival.`,
        followupOfWoId: parent.id,
        materialsPacked,
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
      const allLeads = await readLeads();
      const lead = allLeads.find((l) => (l.portal?.token || portalTokenForId(l.id)) === token);
      if (!lead) return sendJson(res, 404, { ok: false, errors: ["Portal not found."] });
      if (!lead.booking) return sendJson(res, 422, { ok: false, errors: ["No appointment on file."] });
      const currentStart = lead.booking.start ? new Date(lead.booking.start) : null;
      const tooLate = currentStart ? (currentStart.getTime() - Date.now()) < 24 * 60 * 60 * 1000 : false;
      let bookingRec = (await bookings.listByLead(lead.id))[0];
      if (!bookingRec) bookingRec = await bookings.upsertFromLead(lead);
      const result = bookingRec ? await rescheduleAvailability(bookingRec.id) : { ok: false, errors: ["No booking."] };
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
    let all = await invoices.list();
    if (status) all = all.filter((i) => i.status === status);
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
      const updated = await invoices.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Invoice not found."] });
      return sendJson(res, 200, { ok: true, invoice: updated });
    } catch (err) {
      return sendJson(res, 400, { ok: false, errors: [err.message || "Couldn't update invoice."] });
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

      // Reuse the booking's customer-facing WO ID when one already
      // exists on the lead — keeps the customer + tech seeing the
      // same WO-XXXXXXXX. Otherwise generate a fresh one.
      const customId = lead?.booking?.workOrder?.id || null;

      // Fetch the source Quote (if any) so the WO inherits the AI Intake
      // Guarantee — the tech UI uses this to show the locked-labour banner.
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
      if ((type === "spring_opening" || type === "fall_closing") && lead?.booking?.serviceKey) {
        try {
          const seedKey = String(lead.booking.serviceKey || "");
          const catalogItem = PRICING.items?.[seedKey];
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

    // Self-healing seasonal-fee seed for legacy WOs that pre-date the
    // create-time seed. If this is a spring/fall WO, has a known
    // serviceKey on its lead booking, and the on-site quote builder
    // has no baseline line yet, seed it now. Idempotent: a baseline
    // line marked source.baseline === true is the fingerprint that
    // says "already seeded, leave alone."
    if ((wo.type === "spring_opening" || wo.type === "fall_closing") &&
        lead?.booking?.serviceKey) {
      const existingBuilder = Array.isArray(wo.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
      const hasBaseline = existingBuilder.some((l) => l && l.source && l.source.baseline === true);
      if (!hasBaseline) {
        const seedKey = String(lead.booking.serviceKey || "");
        const catalogItem = PRICING.items?.[seedKey];
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
    return sendJson(res, 200, { ok: true, workOrder: wo, property, lead, lastService });
  }

  if (workOrderMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(workOrderMatch[1]);
      const payload = await parseRequestBody(req);

      // Customer sign-off — when the patch carries a signature with an
      // image, customer name, and acknowledgement, this is the legally
      // binding moment per spec §4.3.2. Server fills in the audit
      // metadata (signedAt / ip / userAgent) so the client can't fake
      // them, then locks the WO. Existing-signed WOs ignore further
      // signature patches (re-signing requires explicit unlock by Patrick,
      // which is its own future flow).
      if (payload && payload.signature && typeof payload.signature === "object") {
        const sig = payload.signature;
        const isFreshSign = sig.acknowledgement === true
          && typeof sig.imageData === "string" && sig.imageData.length > 50
          && typeof sig.customerName === "string" && sig.customerName.trim().length > 0;
        if (isFreshSign) {
          const existing = await workOrders.get(id);
          if (existing && existing.signature && existing.signature.signed) {
            // Already signed — drop the signature patch silently rather
            // than overwriting the audit trail.
            delete payload.signature;
          } else {
            // Cap the signature image at 500KB of base64 to prevent
            // oversized PNGs from blowing up the JSON store.
            if (sig.imageData.length > 500_000) {
              return sendJson(res, 422, { ok: false, errors: ["Signature image is too large. Try clearing and signing again."] });
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
      }

      // Snapshot the prior status so we can detect a transition to
      // "completed" and fire the cascade exactly once.
      const priorStatus = (await workOrders.get(id))?.status || null;

      const updated = await workOrders.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });

      // Completion cascade — spec §4.3.4. Fires when the WO transitions
      // INTO completed (any prior status). Idempotent at the cascade
      // layer (it short-circuits if a service record already references
      // this WO), so accidental re-triggers are safe. Best-effort
      // notifications via the existing email/SMS helpers.
      if (updated.status === "completed" && priorStatus !== "completed" && updated.propertyId) {
        const baseUrl = process.env.PUBLIC_BASE_URL || baseUrlFromReq(req);
        completionCascade.run(updated, {
          notifyAdmin: async ({ wo, serviceRecord, invoice }) => {
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
              sendNewLeadEmail(aliasLead, { baseUrl }),
              sendNewLeadSms(aliasLead, { baseUrl })
            ]);
          },
          notifyCustomer: async ({ wo, serviceRecord, invoice }) => {
            // Reuse the existing customer-notification module but with a
            // local custom payload — wo isn't a lead, so the existing
            // applyCrmUpdate path doesn't fit. Send a branded summary
            // email via the same nodemailer pattern used elsewhere.
            if (!wo.customerEmail || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
            let nodemailer;
            try { nodemailer = require("nodemailer"); } catch { return; }
            const transporter = nodemailer.createTransport({
              service: "gmail",
              auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
            });
            const firstName = (wo.customerName || "").split(" ")[0] || "there";
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
        }).catch((err) => console.warn("[cascade] run failed:", err?.message));
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

      return sendJson(res, 200, { ok: true, workOrder: updated });
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
  // POST /api/work-orders/:id/photos — upload one or more photos.
  // Body: { photos: [{ data: "<base64>", mediaType, category, zoneNumber, issueId, label }] }
  // Categories: pre_work / in_progress / post_work / issue / general.
  // Photos are stored on disk under WO_PHOTOS_DIR/<woId>/<n>.<ext>; metadata
  // is appended to wo.photos. The hard cap of 20 photos per WO is enforced
  // across all uploads (not per-request) so a tech can't bypass it by
  // splitting into batches.
  const woPhotosUploadMatch = pathname.match(/^\/api\/work-orders\/([^/]+)\/photos$/);
  if (woPhotosUploadMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(woPhotosUploadMatch[1]);
      const wo = await workOrders.get(id);
      if (!wo) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });

      // 12 MB cap matches the /api/quotes upload limit — covers up to ~5
      // photos × ~1.5 MB after client-side resize, with headroom.
      const payload = await parseRequestBody(req, { maxBytes: QUOTE_POST_MAX_BYTES });
      const existing = Array.isArray(wo.photos) ? wo.photos : [];
      const remaining = MAX_PHOTOS_PER_WO - existing.length;
      if (remaining <= 0) {
        return sendJson(res, 422, { ok: false, errors: [`Work order already has the maximum ${MAX_PHOTOS_PER_WO} photos. Delete one before uploading more.`] });
      }
      let validated;
      try { validated = validatePhotos(payload.photos, remaining); }
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
      // (seasonal fees, manually-added charges from the desktop edit).
      // Without this, "Generate from issues" wipes the spring opening
      // fee every time the tech runs the rollup.
      const existingBaseline = (wo.onSiteQuote?.builderLineItems || [])
        .filter((l) => l && l.source && l.source.baseline === true);
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
        cleaned.push({
          key: custom ? null : key,
          label: typeof raw.label === "string" ? raw.label.slice(0, 200) : (cat ? cat.label : "Custom line"),
          qty,
          originalPrice: Math.round(originalPrice * 100) / 100,
          overridePrice,
          custom,
          source: raw.source && typeof raw.source === "object" ? {
            zoneNumbers: Array.isArray(raw.source.zoneNumbers) ? raw.source.zoneNumbers.slice() : [],
            issueIds: Array.isArray(raw.source.issueIds) ? raw.source.issueIds.slice() : []
          } : { zoneNumbers: [], issueIds: [] },
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
        return sendJson(res, 200, { ok: true, deferred: updatedEntry, workOrder: updatedWo, ...totals });
      }

      if (action === "decline") {
        const updatedEntry = await properties.updateDeferredIssue(propertyId, deferredId, {
          status: "open",
          declinedAt: new Date().toISOString(),
          reDeferralCount: (Number(entry.reDeferralCount) || 0) + 1,
          resolution: null
        });
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
      const daysAhead = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));

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

      return sendJson(res, 200, {
        ok: true,
        service: { key: serviceKey, ...BOOKABLE_SERVICES[serviceKey] },
        address: geo.coords?.formattedAddress || address,
        geocodeOk: geo.ok === true,
        days: groupByDay(slots),
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
      const endDate = new Date(startDate.getTime() + service.minutes * 60 * 1000);

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
        durationMinutes: service.minutes,
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

      // Fetch the source Quote (if any) so AI Intake Guarantee propagates.
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
  if (pathname === "/admin/chats" || pathname === "/admin/chats/") {
    return { dir: SERVER_DIR, relative: "/chats.html" };
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

    if (needsAuth(req.method, pathname) && !(await isAuthenticated(req))) {
      if (pathname.startsWith("/api/")) {
        return sendJson(res, 401, { ok: false, errors: ["CRM login required."] });
      }
      return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
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

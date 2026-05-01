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
const MAX_PHOTOS_PER_LEAD = 5;
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
const FEATURES = {
  // --- Service call ---
  service_call:        { label: "Service call (mobilization + 1 hr labour)",         price: 95,    category: "service",   quoteType: "flat" },
  hourly_labour:       { label: "Additional labour (per hour beyond the first)",     price: 95,    category: "service",   quoteType: "per-unit" },

  // --- Sprinkler head replacement ---
  head_replacement:    { label: "Sprinkler head replacement (any size, any type)",   price: 68,    category: "repair",    quoteType: "per-unit" },
  cap_one_head:        { label: "Cap 1 sprinkler head (goodwill, no charge)",        price: 0,     category: "repair",    quoteType: "flat" },
  cap_multiple_heads:  { label: "Cap 2+ sprinkler heads (labour only)",              price: 0,     category: "repair",    quoteType: "custom" },

  // --- Valves & manifolds ---
  manifold_3valve:     { label: "3-valve manifold rebuild (covers 1-3 valves)",      price: 135,   category: "valve",     quoteType: "flat" },
  manifold_6valve:     { label: "6-valve manifold rebuild (covers 4-6 valves)",      price: 285,   category: "valve",     quoteType: "flat" },
  valve_hunter_pgv:    { label: "Hunter PGV-100G valve (per valve replaced)",        price: 74.95, category: "valve",     quoteType: "per-unit" },

  // --- Controllers (Hunter HPC-400 family) ---
  controller_1_4:      { label: "Smart controller — 1-4 zones (HPC-400)",            price: 595,   category: "controller", quoteType: "flat" },
  controller_5_7:      { label: "Smart controller — 5-7 zones (HPC-400 + PCM-300)",  price: 750,   category: "controller", quoteType: "flat" },
  controller_8_16:     { label: "Smart controller — 8-16 zones (HPC-400 + modules)", price: 1195,  category: "controller", quoteType: "flat" },
  controller_17_plus:  { label: "Smart controller — 17+ zones (custom quote)",       price: 0,     category: "controller", quoteType: "custom" },

  // --- Wire repair ---
  wire_diagnostic:     { label: "Wire diagnostics & simple repair (in valve box)",   price: 187,   category: "wire",      quoteType: "flat" },
  wire_run_100ft:      { label: "Wire run replacement — up to 100 ft",               price: 345,   category: "wire",      quoteType: "flat" },
  wire_run_175ft:      { label: "Wire run replacement — up to 175 ft",               price: 435,   category: "wire",      quoteType: "flat" },
  wire_run_long:       { label: "Wire run replacement — beyond 175 ft (custom)",     price: 0,     category: "wire",      quoteType: "custom" },

  // --- Pipe / mainline ---
  pipe_break_3ft:      { label: "Pipe break repair (up to 3 ft of 1\" pipe)",        price: 120,   category: "pipe",      quoteType: "flat" },
  mainline_repair:     { label: "Mainline repair (custom quote)",                    price: 0,     category: "pipe",      quoteType: "custom" },

  // --- Spring openings ---
  spring_open_4z:      { label: "Spring opening — up to 4 zones residential",        price: 90,    category: "seasonal",  quoteType: "flat" },
  spring_open_8z:      { label: "Spring opening — up to 8 zones residential",        price: 120,   category: "seasonal",  quoteType: "flat" },
  spring_open_commercial: { label: "Spring opening — commercial",                    price: 285,   category: "seasonal",  quoteType: "flat" },

  // --- Fall closings ---
  fall_close_4z:       { label: "Fall closing — up to 4 zones",                      price: 90,    category: "seasonal",  quoteType: "flat" },
  fall_close_6z:       { label: "Fall closing — up to 6 zones",                      price: 95,    category: "seasonal",  quoteType: "flat" },
  fall_close_8z:       { label: "Fall closing — up to 8 zones",                      price: 120,   category: "seasonal",  quoteType: "flat" },
  fall_close_15z:      { label: "Fall closing — up to 15 zones",                     price: 145,   category: "seasonal",  quoteType: "flat" },

  // --- New install / smart upgrades (always custom quote) ---
  new_zone_install:    { label: "New zone install (starts at $575 — custom quote)",  price: 0,     category: "install",   quoteType: "custom" },
  smart_upgrade:       { label: "Smart upgrades / accessories (custom quote)",       price: 0,     category: "install",   quoteType: "custom" },
  hose_bib_install:    { label: "Frost-free exterior hose bib install",              price: 175,   category: "install",   quoteType: "flat" }
};

const CRM_STATUSES = new Set(["new", "contacted", "site_visit", "quoted", "won", "lost"]);
const CRM_PRIORITIES = new Set(["normal", "high", "urgent"]);

// Lead sources — which form on the public site originated the lead.
// Each entry has a short human label (shown as a pill in the CRM and in the
// SMS/email notification) and a category that groups similar inquiry types.
// Add new sources here, then point the form's `source` field at the new key.
const SOURCES = {
  sprinkler_repair:    { label: "Sprinkler Repair",    category: "repair"    },
  ai_diagnose:         { label: "AI Diagnostic Chat",  category: "repair"    },
  sprinkler_quote:     { label: "New Sprinkler Quote", category: "install"   },
  landscape_lighting:  { label: "Landscape Lighting",  category: "lighting"  },
  drip_irrigation:     { label: "Drip Irrigation",     category: "install"   },
  spring_opening:      { label: "Spring Opening",      category: "seasonal"  },
  fall_closing:        { label: "Fall Closing",        category: "seasonal"  },
  coverage_inquiry:    { label: "Service Area Check",  category: "inquiry"   },
  general_contact:     { label: "General Contact",     category: "inquiry"   },
  general_lead:        { label: "General Lead",        category: "inquiry"   }
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
  if (pathname === "/admin/schedule" || pathname === "/admin/schedule/") return true;
  if (pathname === "/admin/handoff" || pathname === "/admin/handoff/") return true;
  if (pathname === "/admin/chats" || pathname === "/admin/chats/") return true;
  if (pathname === "/admin/properties" || pathname === "/admin/properties/") return true;
  if (pathname === "/admin/properties/import" || pathname === "/admin/properties/import/") return true;
  if (/^\/admin\/property\/[^/]+/.test(pathname)) return true;
  if (pathname === "/admin/work-orders" || pathname === "/admin/work-orders/") return true;
  if (/^\/admin\/work-order\/[^/]+\/tech\/?$/.test(pathname)) return true;
  if (/^\/admin\/work-order\/[^/]+/.test(pathname)) return true;
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
  // Per-lead property link/dismiss actions are admin-only.
  if (/^\/api\/leads\/[^/]+\/(link-property|dismiss-property-suggestion)$/.test(pathname)) return true;
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
// Returns a normalized + validated array of { buffer, mediaType, ext }, or throws.
function validatePhotos(rawPhotos) {
  if (!rawPhotos) return [];
  if (!Array.isArray(rawPhotos)) throw new Error("photos must be an array.");
  if (rawPhotos.length > MAX_PHOTOS_PER_LEAD) throw new Error(`A booking can include at most ${MAX_PHOTOS_PER_LEAD} photos.`);
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
    out.push({ buffer, mediaType, ext });
  }
  return out;
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
  "/api/booking/reserve"
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
  return leads
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
          const liveLeads = await readLeads();
          const i = liveLeads.findIndex((l) => l.id === result.lead.id);
          if (i !== -1) {
            liveLeads[i].propertyId = linkResult.property.id;
            liveLeads[i].propertyLinkStatus = linkResult.status;
            if (linkResult.status === "suggested") {
              liveLeads[i].propertyLinkSuggestions = linkResult.suggestions;
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

      // Return the portal URL too so the chat widget's thank-you screen can
      // surface it as the customer's "you're now a PJL customer" link.
      const portalToken = result.lead.portal?.token;
      const portalUrl = portalToken ? `${baseUrl}/portal/${portalToken}` : null;
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
    return sendJson(res, 200, {
      ok: true,
      leads: filtered.map((lead) => decorateLeadForAdmin(lead, req)),
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

      return sendJson(res, 200, { ok: true, lead: decorateLeadForAdmin(leads[index], req) });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Unable to update lead."] });
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

      return sendJson(res, 200, { ok: true, lead: decorateLeadForAdmin(lead, req) });
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
      return sendJson(res, 200, { ok: true, lead: decorateLeadForAdmin(lead, req) });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't dismiss suggestion."] });
    }
  }

  const propertyMatch = pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (propertyMatch && req.method === "GET") {
    const property = await properties.get(decodeURIComponent(propertyMatch[1]));
    if (!property) return sendJson(res, 404, { ok: false, errors: ["Property not found."] });
    // Decorate with linked leads so the admin page can show booking history.
    const allLeads = await readLeads();
    const linkedLeads = allLeads
      .filter((l) => l.propertyId === property.id || (property.leadIds || []).includes(l.id))
      .map((l) => decorateLeadForAdmin(l, req));
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
      const wo = await workOrders.create({ type, lead, property, customId });

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
    const wo = await workOrders.get(decodeURIComponent(workOrderMatch[1]));
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
    return sendJson(res, 200, { ok: true, workOrder: wo, property, lead });
  }

  if (workOrderMatch && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(workOrderMatch[1]);
      const payload = await parseRequestBody(req);
      const updated = await workOrders.update(id, payload);
      if (!updated) return sendJson(res, 404, { ok: false, errors: ["Work order not found."] });
      return sendJson(res, 200, { ok: true, workOrder: updated });
    } catch (error) {
      return sendJson(res, 400, { ok: false, errors: [error.message || "Couldn't update work order."] });
    }
  }

  if (workOrderMatch && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(workOrderMatch[1]);
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
          const liveLeads = await readLeads();
          const i = liveLeads.findIndex((l) => l.id === result.lead.id);
          if (i !== -1) {
            liveLeads[i].propertyId = linkResult.property.id;
            liveLeads[i].propertyLinkStatus = linkResult.status;
            if (linkResult.status === "suggested") {
              liveLeads[i].propertyLinkSuggestions = linkResult.suggestions;
            }
            await writeLeads(liveLeads);
          }
        }
      } catch (err) {
        console.error("[properties] booking auto-link failed:", err?.message || err);
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
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
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
});

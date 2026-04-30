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
  if (pathname === "/api/quotes" && method === "GET") return true;
  if (pathname === "/api/quotes.csv" || pathname === "/api/contacts" || pathname === "/api/contacts.vcf") return true;
  if (/^\/api\/quotes\/[^/]+/.test(pathname)) return true;
  // Schedule management is admin-only.
  if (pathname.startsWith("/api/schedule/")) return true;
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
        mode: normalizeString(payload && payload.mode, 60)
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

async function parseRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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

function baseUrlFromReq(req) {
  return `http://${req.headers.host || `${HOST}:${PORT}`}`;
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
  const portalUrl = `${baseUrlFromReq(req)}${portalPath}`;

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
  return {
    ...lead,
    source: sourceKey,
    sourceLabel: sourceMeta.label,
    sourceCategory: sourceMeta.category,
    portalUrl: contactExport.portalUrl,
    contactExport
  };
}

function portalPayloadForLead(lead, req) {
  const contact = contactRecordForLead(lead, req);
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
      activity: visibleActivity
    },
    portal: {
      token: lead.portal?.token || portalTokenForId(lead.id),
      url: contact.portalUrl
    }
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
      const payload = await parseRequestBody(req);
      const result = validateLead(payload);
      if (!result.ok) return sendJson(res, 422, { ok: false, errors: result.errors });

      const leads = await readLeads();
      if (isLikelyDuplicate(leads, result.lead)) {
        return sendJson(res, 409, {
          ok: false,
          errors: ["This looks like a duplicate quote request that was already received today."]
        });
      }

      leads.unshift(result.lead);
      await writeLeads(leads);

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

      return sendJson(res, 201, { ok: true, leadId: result.lead.id });
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
    return sendJson(res, 200, { ok: true, portal: portalPayloadForLead(lead, req) });
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

      // Customer-confirmed zone count (1-24 or "unsure"), only collected for
      // seasonal flows. Stored on the booking so Patrick can see it in the
      // CRM and so future schedule logic can use it for capacity planning.
      const rawZones = normalizeString(payload.zoneCount, 12);
      let zoneCount = null;
      if (rawZones === "unsure") {
        zoneCount = "unsure";
      } else if (/^\d+$/.test(rawZones)) {
        const n = Number(rawZones);
        if (n >= 1 && n <= 24) zoneCount = n;
      }

      // Attach the booking to the lead.
      result.lead.booking = {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        durationMinutes: service.minutes,
        serviceKey,
        serviceLabel: service.label,
        zoneCount,
        coords: { lat: customerCoords.lat, lng: customerCoords.lng, formattedAddress: customerCoords.formattedAddress }
      };
      // Status starts at site_visit for consults, won for committed direct bookings.
      result.lead.status = isSiteVisit ? "site_visit" : "won";
      result.lead.crm.status = result.lead.status;
      result.lead.crm.activity.unshift({
        at: new Date().toISOString(),
        type: "update",
        text: `Booked online: ${service.label} on ${matched.dayLabel} at ${matched.timeLabel}.`
      });

      const all = await readLeads();
      all.unshift(result.lead);
      await writeLeads(all);

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
  if (pathname === "/admin/schedule" || pathname === "/admin/schedule/") {
    return { dir: SERVER_DIR, relative: "/schedule.html" };
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
  try {
    const authHandled = await handleAuth(req, res, url.pathname);
    if (authHandled !== false) return;

    if (needsAuth(req.method, url.pathname) && !(await isAuthenticated(req))) {
      if (url.pathname.startsWith("/api/")) {
        return sendJson(res, 401, { ok: false, errors: ["CRM login required."] });
      }
      return redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
    } else {
      await serveStatic(req, res, url.pathname);
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

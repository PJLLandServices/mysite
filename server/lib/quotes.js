// Quotes — the discrete Quote folder per the operations spec (PJL_OPERATIONS_DESIGN.md §4.1).
//
// A Quote is a versioned, snapshotted, audit-trailed record of work
// PJL has offered to a customer at a specific price. Two flavours:
//
//   ai_repair_quote — generated in chat from pricing.json, locked-rate
//                     repair work, transcript persisted as the source of
//                     truth. Carries the AI Intake Guarantee flag so techs
//                     honour locked labour on the resulting WO.
//
//   formal_quote    — installs/retrofits with PDF + signature pad. Not
//                     implemented in slice 9.7 — placeholder type only.
//
// Hard rules from the spec (numbered in PJL_OPERATIONS_DESIGN.md §10):
//   2. Quotes snapshot prices at creation. Future pricing.json changes
//      don't alter accepted quotes — line items carry their own price.
//   9. Quotes are versioned, not edited. Revisions create a new Quote
//      with a new id and `supersedesId` pointing at the old one. Slice 9.7
//      doesn't yet emit revisions, but the schema supports them.
//
// The Quote owns the line items. The Lead carries `lead.quoteId` pointing
// here; legacy `lead.features` continues to mirror the line items so the
// existing CRM/email surfaces keep working without a rewrite.
//
// Storage: server/data/quotes.json. Same flat-file pattern as the rest of
// the system. Rotate to SQLite if quote count crosses ~10,000.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "quotes.json");

const STATUSES = ["draft", "sent", "accepted", "partially_accepted", "declined", "expired", "superseded", "cancelled"];
// on_site_quote: tech walks zones on-site, finds issues, builds a quote
// from pricing.json, customer accepts/declines per line. Has its own
// signature canvas (separate from wo.signature) per spec rule 4.
// formal_quote: install/retrofit PDF flow, deferred to a future slice.
const TYPES = ["ai_repair_quote", "formal_quote", "on_site_quote"];
const DEFAULT_VALIDITY_DAYS = 30;
const HST_RATE = 0.13;

// ---- File I/O ---------------------------------------------------------

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(hydrate) : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

// ---- ID generation ---------------------------------------------------

// Q-YYYY-NNNN per the spec. Counter is per-year and seeded from the
// highest existing id when the next quote is created. Single-instance
// Node on Render so no concurrency concern; the readAll-then-writeAll
// pattern is atomic at process scope.
async function nextQuoteId(year) {
  const records = await readAll();
  const prefix = `Q-${year}-`;
  let max = 0;
  for (const q of records) {
    if (typeof q.id === "string" && q.id.startsWith(prefix)) {
      const tail = q.id.slice(prefix.length).replace(/-v\d+$/, "");
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

// ---- Helpers ---------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function plusDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function blankQuote() {
  const created = nowIso();
  return {
    id: "",
    version: 1,
    supersedesId: null,
    status: "draft",
    type: "ai_repair_quote",
    createdAt: created,
    createdBy: "system",

    // Linkage — populated as the Quote moves through the chain.
    customerEmail: "",
    propertyId: null,
    leadId: null,
    bookingId: null,
    workOrderIds: [],

    // Source — for ai_repair_quote, transcript pointer is REQUIRED per spec.
    source: {
      chatSessionId: null,
      pageUrl: null,
      userAgent: null
    },

    // The actual quote — line items snapshot pricing at creation time.
    scope: "",
    lineItems: [],   // [{ key, label, price, qty, lineTotal }]
    subtotal: 0,
    hst: 0,
    total: 0,
    currency: "CAD",

    // AI Intake Guarantee — when set, the resulting WO shows a banner
    // telling the tech "labour locked for [scope] — do not bill additional
    // labour." Anything beyond scope = standard parts + $95/hr, on-site
    // re-quote required.
    intakeGuarantee: {
      applies: false,
      scope: "",
      rule: "Labour locked for diagnosed scope regardless of time on-site. Anything beyond scope = standard parts + $95/hr, requires on-site re-quote."
    },

    // The offer
    sentAt: null,
    validUntil: plusDaysIso(DEFAULT_VALIDITY_DAYS),
    acceptedAt: null,
    declinedAt: null,
    declinedReason: null,
    expiredAt: null,

    // Customer signature for THIS quote. ai_repair_quote acceptance is
    // implicit (customer submits booking form), so this stays empty for
    // that flavour. on_site_quote requires the customer to sign on the
    // tech's device — we capture that signature here, distinct from
    // wo.signature (the WO completion sign-off). Spec rule 4: scope
    // changes after the original sign-off need a fresh signature; this
    // is that fresh signature.
    signature: {
      signed: false,
      customerName: "",
      imageData: "",
      signedAt: null,
      ip: null,
      userAgent: null
    },

    // Per-line accept/decline record at customer-accept time. Each entry
    // points at a lineItems index by snapshot order. Declined items get
    // their own deferredId once the property's deferredIssues entry is
    // created. Empty until accept().
    decisions: [],

    // Audit trail — every status change appends an entry.
    history: [
      { ts: created, action: "created", by: "system", note: "" }
    ]
  };
}

function hydrate(q) {
  const base = blankQuote();
  return {
    ...base,
    ...q,
    source: { ...base.source, ...(q.source || {}) },
    intakeGuarantee: { ...base.intakeGuarantee, ...(q.intakeGuarantee || {}) },
    signature: { ...base.signature, ...(q?.signature || {}) },
    lineItems: Array.isArray(q?.lineItems) ? q.lineItems : [],
    decisions: Array.isArray(q?.decisions) ? q.decisions : [],
    workOrderIds: Array.isArray(q?.workOrderIds) ? q.workOrderIds : [],
    history: Array.isArray(q?.history) ? q.history : []
  };
}

// Validate a structured quote payload from the AI chat (the [QUOTE_JSON]
// token). Each line item key must exist in the live pricing catalog. The
// AI's stated total is recomputed from pricing.json — we trust the catalog,
// not the model. Returns { ok, errors, lineItems, subtotal, hst, total }.
//
// `pricingItems` is the pricing.json `items` map (passed in so quotes.js
// stays decoupled from the server's PRICING global).
function validateQuotePayload(payload, pricingItems) {
  const errors = [];
  const out = { ok: false, errors, lineItems: [], subtotal: 0, hst: 0, total: 0 };
  if (!payload || typeof payload !== "object") {
    errors.push("Quote payload is missing or not an object.");
    return out;
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    errors.push("Quote payload has no line items.");
    return out;
  }

  let subtotal = 0;
  for (const raw of items) {
    const key = String(raw && raw.key || "").trim();
    const qty = Number(raw && raw.qty);
    if (!key) { errors.push("Line item is missing 'key'."); continue; }
    if (!Object.prototype.hasOwnProperty.call(pricingItems, key)) {
      errors.push(`Unknown line item key: ${key}`);
      continue;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Invalid quantity for ${key}: ${raw && raw.qty}`);
      continue;
    }
    const cat = pricingItems[key];
    const price = Number(cat.price) || 0;
    const lineTotal = Math.round(price * qty * 100) / 100;
    out.lineItems.push({
      key,
      label: cat.label || key,
      price,
      qty,
      lineTotal
    });
    subtotal += lineTotal;
  }

  if (errors.length) return out;

  // Round to 2 decimals to avoid float drift creeping into stored totals.
  subtotal = Math.round(subtotal * 100) / 100;
  // HST on subtotal. Spec §1.1 hard rule: tax added at the end, never
  // baked into quoted item prices.
  const hst = Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;

  // If the AI stated a total, log a soft mismatch warning but don't fail.
  // The catalog is the source of truth. We surface the AI's number for
  // observability; we never quote it back to the customer.
  let mismatch = null;
  if (Number.isFinite(Number(payload.total))) {
    const stated = Number(payload.total);
    // The AI's stated total is typically pre-tax (it doesn't quote HST in
    // chat). Match against subtotal first, then total — flag only if BOTH
    // are off by more than $0.01.
    if (Math.abs(stated - subtotal) > 0.01 && Math.abs(stated - total) > 0.01) {
      mismatch = { stated, subtotal, total };
    }
  }

  out.ok = true;
  out.subtotal = subtotal;
  out.hst = hst;
  out.total = total;
  if (mismatch) out.priceMismatch = mismatch;
  return out;
}

// ---- CRUD -----------------------------------------------------------

async function list() {
  return readAll();
}

async function get(id) {
  const records = await readAll();
  return records.find((q) => q.id === id) || null;
}

async function listByLead(leadId) {
  const records = await readAll();
  return records.filter((q) => q.leadId === leadId);
}

async function listByCustomer(email) {
  const records = await readAll();
  const target = String(email || "").trim().toLowerCase();
  return records.filter((q) => (q.customerEmail || "").toLowerCase() === target);
}

// Create a new Quote. Slice 9.7 only emits ai_repair_quote — formal_quote
// is a future phase. The Quote starts in "sent" status (the AI has shown
// it to the customer in chat) unless `status` is explicitly passed.
async function create({
  type = "ai_repair_quote",
  status = "sent",
  customerEmail = "",
  propertyId = null,
  leadId = null,
  source = {},
  scope = "",
  lineItems = [],
  subtotal = 0,
  hst = 0,
  total = 0,
  intakeGuarantee = null,
  createdBy = "system",
  validityDays = DEFAULT_VALIDITY_DAYS
} = {}) {
  if (!TYPES.includes(type)) throw new Error(`Unknown quote type: ${type}`);
  if (!STATUSES.includes(status)) throw new Error(`Unknown quote status: ${status}`);

  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextQuoteId(year);

  const q = blankQuote();
  q.id = id;
  q.type = type;
  q.status = status;
  q.createdBy = createdBy;
  q.customerEmail = String(customerEmail || "").toLowerCase().trim();
  q.propertyId = propertyId;
  q.leadId = leadId;
  q.source = { ...q.source, ...source };
  q.scope = scope || "";
  q.lineItems = lineItems;
  q.subtotal = subtotal;
  q.hst = hst;
  q.total = total;
  if (intakeGuarantee) {
    q.intakeGuarantee = { ...q.intakeGuarantee, ...intakeGuarantee };
  }
  q.validUntil = plusDaysIso(validityDays);
  if (status === "sent") q.sentAt = nowIso();

  q.history.push({
    ts: nowIso(),
    action: status === "sent" ? "sent" : `status:${status}`,
    by: createdBy,
    note: scope || ""
  });

  records.unshift(q);
  await writeAll(records);
  return q;
}

// Mark a quote accepted. Bookings auto-create on acceptance per spec §4.1
// — but the booking creation itself happens upstream in the lead/booking
// handler. This function just flips the status and logs.
async function accept(id, { leadId = null, bookingId = null, by = "customer", note = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status === "accepted") return q; // idempotent

  q.status = "accepted";
  q.acceptedAt = nowIso();
  if (leadId && !q.leadId) q.leadId = leadId;
  if (bookingId && !q.bookingId) q.bookingId = bookingId;
  q.history.push({ ts: nowIso(), action: "accepted", by, note });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Accept an on_site_quote with a captured customer signature. Differs
// from accept() in that it ALSO writes the signature block + decisions
// snapshot, and supports a "partially_accepted" status when some lines
// were declined. Server fills ip + userAgent (never trusts the client).
async function acceptWithSignature(id, {
  customerName,
  imageData,
  decisions,
  ip,
  userAgent,
  by = "customer",
  note = "",
  partial = false
} = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.signature && q.signature.signed) return q; // idempotent — already signed

  const ts = nowIso();
  q.status = partial ? "partially_accepted" : "accepted";
  q.acceptedAt = ts;
  q.signature = {
    signed: true,
    customerName: String(customerName || "").slice(0, 120),
    imageData: String(imageData || ""),
    signedAt: ts,
    ip: String(ip || ""),
    userAgent: String(userAgent || "")
  };
  if (Array.isArray(decisions)) q.decisions = decisions;
  q.history.push({
    ts,
    action: partial ? "partially_accepted" : "accepted",
    by,
    note: note || (partial ? "Customer accepted some line items, declined others." : "")
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

async function decline(id, { reason = "", by = "customer" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  q.status = "declined";
  q.declinedAt = nowIso();
  q.declinedReason = reason;
  q.history.push({ ts: nowIso(), action: "declined", by, note: reason });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Mark a quote expired (past validUntil and not yet accepted/declined).
// Called either explicitly via /api/quotes/:id/expire or in batch from a
// future scheduled task.
async function expire(id, { by = "system" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status !== "sent" && q.status !== "draft") return q;
  q.status = "expired";
  q.expiredAt = nowIso();
  q.history.push({ ts: nowIso(), action: "expired", by, note: "" });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Attach a work-order id to a quote's back-reference list. Called when a
// WO is created from a lead whose quote is accepted, so the Quote can
// surface "fulfilled by WO-XYZ" in the audit trail.
async function attachWorkOrder(id, workOrderId) {
  if (!id || !workOrderId) return null;
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (!Array.isArray(q.workOrderIds)) q.workOrderIds = [];
  if (!q.workOrderIds.includes(workOrderId)) {
    q.workOrderIds.push(workOrderId);
    q.history.push({ ts: nowIso(), action: "wo_attached", by: "system", note: workOrderId });
    records[idx] = q;
    await writeAll(records);
  }
  return q;
}

// Sweep all quotes that are past their validUntil date and still in
// "sent"/"draft" status. Marks them expired with an audit entry. Called
// at server startup AND on a daily interval (server.js sets the timer).
// Returns { expired, considered } so the caller can log it.
async function expireStaleQuotes({ now = new Date() } = {}) {
  const records = await readAll();
  let expired = 0;
  let considered = 0;
  const nowMs = now.getTime();
  for (const q of records) {
    if (q.status !== "sent" && q.status !== "draft") continue;
    considered++;
    if (!q.validUntil) continue;
    const validMs = new Date(q.validUntil).getTime();
    if (Number.isFinite(validMs) && validMs < nowMs) {
      q.status = "expired";
      q.expiredAt = now.toISOString();
      q.history.push({ ts: now.toISOString(), action: "expired", by: "system", note: "Auto-expired (past validUntil)" });
      expired++;
    }
  }
  if (expired) await writeAll(records);
  return { expired, considered };
}

module.exports = {
  STATUSES,
  TYPES,
  DEFAULT_VALIDITY_DAYS,
  HST_RATE,
  validateQuotePayload,
  list,
  get,
  listByLead,
  listByCustomer,
  create,
  accept,
  acceptWithSignature,
  decline,
  expire,
  expireStaleQuotes,
  attachWorkOrder
};

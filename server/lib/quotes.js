// Quotes — the discrete Quote folder per the operations spec (PJL_OPERATIONS_DESIGN.md §4.1).
//
// A Quote is a versioned, snapshotted, audit-trailed record of work
// PJL has offered to a customer at a specific price. Three flavours:
//
//   ai_repair_quote  — generated in chat from pricing.json, locked-rate
//                      parts pricing on repair work, transcript persisted as
//                      the source of truth. Carries the AI-Correct-Diagnosis
//                      Bonus eligibility flag — when the tech confirms the
//                      on-site diagnosis matches the AI-quoted scope, the
//                      customer is credited 1 hr of repair labour free on
//                      the resulting WO. Until tech confirmation, the bonus
//                      is pending and labour bills normally.
//
//   on_site_quote    — tech walks zones on-site, finds issues, builds a
//                      quote from pricing.json, customer accepts/declines
//                      per line. Has its own signature canvas (separate
//                      from wo.signature) per spec rule 4.
//
//   project_proposal — proposal-grade multi-section narrative for
//                      commercial subcontracts, residential installs,
//                      lighting design, renovation coordination, and
//                      change orders. Branch-aware, carries
//                      proposalSections[] (rich text), attachments[]
//                      (maps/diagrams), customRates (snapshotted from
//                      customer.negotiatedRates), and supports BOTH
//                      portal e-sign AND print-sign-PDF-return as
//                      legally binding acceptance paths. Reads its
//                      catalog from server/data/project-rates.json
//                      (internal-only, never exposed publicly) rather
//                      than pricing.json. See Brief 1 (May 2026).
//
// Hard rules from the spec (numbered in PJL_OPERATIONS_DESIGN.md §10):
//   2. Quotes snapshot prices at creation. Future pricing.json changes
//      don't alter accepted quotes — line items carry their own price.
//   9. Quotes are versioned, not edited. Revisions create a new Quote
//      with a new id and `supersedesId` pointing at the old one. The
//      project_proposal type ships with the revision flow live
//      (createRevision); ai_repair / on_site continue to discard-and-
//      re-create per the older slice.
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
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "quotes.json");
const ATTACHMENTS_DIR = path.join(__dirname, "..", "data", "quote-attachments");

const STATUSES = [
  "draft", "sent", "accepted", "partially_accepted",
  "declined", "expired", "superseded", "cancelled",
  // project_proposal-only — set when the customer has uploaded a signed
  // PDF and we're waiting for Patrick to attest it's the real thing.
  "pending_admin_attestation",
  // on_site_quote — tech-only "see what the customer will see" preview.
  // Carries a real approval.token so /approve/<id>?t=... renders the
  // exact customer view, but the /sign endpoint refuses (server-side
  // enforcement) and the page surfaces a PREVIEW banner + neutered
  // submit. Auto-purges after 24h if not converted to "sent".
  "draft_preview"
];
// formal_quote is kept in the enum for back-compat with any historical
// records but is no longer emitted; project_proposal supersedes it.
const TYPES = ["ai_repair_quote", "formal_quote", "on_site_quote", "project_proposal"];

// Branch taxonomy for project_proposal. Five real-world buckets that
// share the skeleton but differ in templated narrative and
// responsibility splits. Brief 1 §3.1A.
const PROPOSAL_BRANCHES = [
  "gc_subcontract",
  "direct_residential",
  "lighting_design",
  "renovation_coordination",
  "change_order"
];

const BILLING_MODES = ["fixed_price", "time_and_material"];

const ACCEPTANCE_METHODS = ["pending", "portal_esign", "pdf_return"];

// Section kinds correspond to the McDonald's Hampshire estimate as the
// reference real-world layout. The proposal builder UI offers these in
// the section nav; `custom` exists as an escape hatch for sections that
// don't fit the standard set.
const PROPOSAL_SECTION_KINDS = [
  "cover_summary",
  "quotation_summary",
  "proposed_scope",
  "infrastructure_list",
  "budget_notice",
  "technical_reference",
  "project_map",
  "line_items",
  "acceptance_block",
  "custom"
];

const ATTACHMENT_KINDS = [
  "site_map",
  "technical_diagram",
  "as_built",
  "reference_photo",
  "other",
  // Used internally when a customer uploads their signed PDF via the
  // /pdf-return flow — kept in the same attachments[] array but
  // displayed separately in the admin attestation UI.
  "signed_pdf_return"
];

const ATTACHMENT_MIME_WHITELIST = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf"
]);

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;        // 25 MB per file
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB per quote

// Once a project_proposal is past draft (sent / accepted /
// pending_admin_attestation / etc.), these fields refuse PATCH with 409.
// Mirrors the work-orders.js SCOPE_PROTECTED_FIELDS pattern. Status
// progression, internal notes, history, and acceptanceEvidence (admin
// attestation lands here) continue to flow.
const SCOPE_PROTECTED_FIELDS = [
  "proposalSections",
  "lineItems",
  "attachments",
  "branch",
  "billingMode",
  "customRates",
  "scope",
  "subtotal",
  "hst",
  "total",
  "type"
];

const DEFAULT_VALIDITY_DAYS = 30;
// Project proposals get a longer default validity — commercial buyers
// commonly compare 2-3 vendors over 60-90 days before sign-off.
const PROPOSAL_DEFAULT_VALIDITY_DAYS = 90;
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

// 8-char base36 random suffix — matches the shape of work-orders.js
// issue ids (iss_<random8>_<ts>). Used for attachment / proposal section
// / task ids on project_proposal quotes and their derived projects.
function random8() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}
function newAttachmentId() { return "att_" + random8(); }
function newSectionId()    { return "sec_" + random8(); }

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
    customerId: null,
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

    // AI Intake Diagnosis Bonus — when set, the resulting WO shows a banner
    // telling the tech "AI-correct-diagnosis bonus applies for [scope] — credit
    // ONE HOUR of repair labour to the customer if the on-site diagnosis matches."
    // Diagnostic + repair labour is otherwise billed normally at $95/hr.
    // Anything beyond the diagnosed scope = standard parts + $95/hr, on-site
    // re-quote required. NOTE: the legacy field name `intakeGuarantee` is kept
    // for backwards compatibility with existing quotes/work orders; semantics
    // now follow the AI-correct-diagnosis bonus policy (see pricing.json
    // ai_intake_correct_diagnosis_bonus).
    intakeGuarantee: {
      applies: false,
      scope: "",
      rule: "AI-correct-diagnosis bonus: if the on-site diagnosis matches the AI-quoted scope, credit the customer ONE HOUR of repair labour free on the diagnosed work. Diagnostic and repair labour otherwise billed at $95/hr. Anything beyond the diagnosed scope = standard parts + $95/hr, requires on-site re-quote."
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

    // Remote approval — when a tech sends an on-site quote to the
    // customer for off-site sign-off (customer wasn't on-site, OR they
    // wanted to think it over). Token authenticates the customer-facing
    // /approve/<id> page; sentVia records which channels fired so the
    // tech UI can show "Sent by SMS at 2:14pm." Cleared when the quote
    // status leaves "sent" (accepted/declined/expired/superseded).
    approval: {
      token: null,
      sentAt: null,
      sentVia: [],            // ["sms", "email"] subset
      sentToEmail: "",
      sentToPhone: ""
    },

    // -------- project_proposal-only fields (Brief 1, May 2026) --------
    // Populated when type === "project_proposal". Stay at their defaults
    // (null/empty) for ai_repair_quote and on_site_quote so the existing
    // flows are untouched.

    // Branch — five real-world buckets (see PROPOSAL_BRANCHES). Drives
    // the proposal builder's templated narrative and the PDF header tag.
    branch: null,

    // billingMode — "fixed_price" or "time_and_material". When T&M, the
    // resulting project locks the customer's labour rate at conversion
    // time (project.labourRateLocked) and uses it for invoice rollup.
    billingMode: null,

    // proposalSections — ordered multi-section narrative. Each section is
    // a kind from PROPOSAL_SECTION_KINDS + title + body (rich text /
    // markdown, sanitized server-side) + optional attachmentIds[] to
    // anchor static media at the section. order field is the canonical
    // sort key; insertion order is the fallback.
    proposalSections: [],

    // attachments — uploaded static media (Google Earth screenshots, CAD
    // drawings, manufacturer schematics). Files live on disk under
    // server/data/quote-attachments/<quoteId>/<attId>.<ext>; this array
    // is the metadata side.
    attachments: [],

    // customRates — per-quote labour-rate snapshot. Captured from the
    // customer's negotiatedRates at creation, then frozen onto the quote
    // for legal-record integrity. Future-extensible (per-foot mainline,
    // per-zone install, etc.) but v1 only carries labour.
    customRates: {
      labour: null
    },

    // acceptanceMethod — "pending" until accepted. Once accepted, locks
    // to "portal_esign" or "pdf_return". The two methods produce
    // different evidence shapes (see acceptanceEvidence) but both
    // legally bind the customer.
    acceptanceMethod: "pending",

    // acceptanceEvidence — method-specific. Portal e-sign mirrors the
    // existing signature{} shape; PDF return captures the uploaded
    // file path, sender email, admin attestation, and timestamps.
    acceptanceEvidence: null,

    // validUntilDate — alias of validUntil for proposals, where the
    // typical default is 90 days. validUntil (above) stays the
    // authoritative field; this field tracks the same value and exists
    // for clarity in the proposal-builder UI.
    validUntilDate: null,

    // revisionOf / supersededBy — quote-revision lineage. When the
    // customer asks for changes on a sent proposal, createRevision()
    // clones to a new Q-YYYY-NNNN with revisionOf pointing at the
    // original; the original gets status: "superseded" and
    // supersededBy back-reference. Chains extend (v3 → v2 → v1).
    revisionOf: null,
    supersededBy: null,

    // Audit trail — every status change appends an entry.
    history: [
      { ts: created, action: "created", by: "system", note: "" }
    ],

    // Bulk-operations soft state. Per Delete-Quotes brief (May 2026):
    // ANY status is eligible for soft-delete from the quote folder. The
    // earlier draft/expired-only restriction lives on the legacy bulk
    // delete-drafts action; the new single-row /api/quotes/:id DELETE
    // route accepts all statuses (Patrick takes responsibility). 30-day
    // Trash retention before purge.
    deletedAt: null,
    // Who deleted it. "admin" fallback when no session uid; mirrors the
    // shape used elsewhere in the audit trail.
    deletedBy: null
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
    approval: { ...base.approval, ...(q?.approval || {}), sentVia: Array.isArray(q?.approval?.sentVia) ? q.approval.sentVia : [] },
    lineItems: Array.isArray(q?.lineItems) ? q.lineItems : [],
    decisions: Array.isArray(q?.decisions) ? q.decisions : [],
    workOrderIds: Array.isArray(q?.workOrderIds) ? q.workOrderIds : [],
    history: Array.isArray(q?.history) ? q.history : [],
    deletedAt: typeof q?.deletedAt === "string" ? q.deletedAt : null,
    deletedBy: typeof q?.deletedBy === "string" ? q.deletedBy : null,
    // project_proposal fields — defensive defaults for legacy records
    // that pre-date the proposal schema.
    branch: q?.branch || null,
    billingMode: q?.billingMode || null,
    proposalSections: Array.isArray(q?.proposalSections) ? q.proposalSections : [],
    attachments: Array.isArray(q?.attachments) ? q.attachments : [],
    customRates: { ...base.customRates, ...(q?.customRates || {}) },
    acceptanceMethod: typeof q?.acceptanceMethod === "string" ? q.acceptanceMethod : "pending",
    acceptanceEvidence: q?.acceptanceEvidence || null,
    validUntilDate: q?.validUntilDate || q?.validUntil || null,
    revisionOf: q?.revisionOf || null,
    supersededBy: q?.supersededBy || null
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

// list() hides soft-deleted quotes by default. /admin/trash passes
// { includeDeleted: true } to see them.
async function list({ includeDeleted = false } = {}) {
  const records = await readAll();
  if (includeDeleted) return records;
  return records.filter((q) => !q.deletedAt);
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

// Create a new Quote. Handles all three flavours (ai_repair_quote,
// on_site_quote, project_proposal). For project_proposal the default
// status is "draft" — Patrick authors sections in the builder before
// sending — and the default validity is 90 days, not 30.
async function create({
  type = "ai_repair_quote",
  status = null,
  customerId = null,
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
  validityDays = null,
  // project_proposal-only
  branch = null,
  billingMode = null,
  proposalSections = null,
  customRates = null
} = {}) {
  if (!TYPES.includes(type)) throw new Error(`Unknown quote type: ${type}`);

  // Per-type defaults — proposals start in draft, other types start sent.
  const isProposal = type === "project_proposal";
  if (status == null) status = isProposal ? "draft" : "sent";
  if (validityDays == null) validityDays = isProposal ? PROPOSAL_DEFAULT_VALIDITY_DAYS : DEFAULT_VALIDITY_DAYS;
  if (!STATUSES.includes(status)) throw new Error(`Unknown quote status: ${status}`);

  if (isProposal) {
    if (branch && !PROPOSAL_BRANCHES.includes(branch)) {
      throw new Error(`Unknown proposal branch: ${branch}`);
    }
    if (billingMode && !BILLING_MODES.includes(billingMode)) {
      throw new Error(`Unknown billing mode: ${billingMode}`);
    }
  }

  // Brief 4 — resolve customerId from email if the caller didn't pass
  // it. Soft-failure: a quote without customerId is still valid (the
  // migration backfill will fix it), but we try to set it now so new
  // records are correctly linked from creation.
  if (!customerId && customerEmail) {
    try {
      const customersLib = require("./customers");
      const match = await customersLib.findByEmail(customerEmail);
      if (match) customerId = match.id;
    } catch (err) { /* tolerate */ }
  }

  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextQuoteId(year);

  const q = blankQuote();
  q.id = id;
  q.type = type;
  q.status = status;
  q.createdBy = createdBy;
  q.customerId = customerId || null;
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
  q.validUntilDate = q.validUntil;
  if (status === "sent") q.sentAt = nowIso();

  if (isProposal) {
    q.branch = branch || null;
    q.billingMode = billingMode || "fixed_price";
    if (Array.isArray(proposalSections) && proposalSections.length) {
      q.proposalSections = proposalSections.map((s, idx) => normalizeProposalSection(s, idx));
    } else {
      q.proposalSections = defaultProposalSections();
    }
    if (customRates && typeof customRates === "object") {
      q.customRates = { ...q.customRates, ...customRates };
    } else if (customerId) {
      // Snapshot from the customer's negotiatedRates if no rates were
      // explicitly passed. Soft-failure: blank rates are fine.
      try {
        const customersLib = require("./customers");
        const cust = await customersLib.get(customerId, { withProperties: false });
        if (cust && cust.negotiatedRates) {
          q.customRates = { ...q.customRates, ...cust.negotiatedRates };
        }
      } catch (_) { /* tolerate */ }
    }
  }

  q.history.push({
    ts: nowIso(),
    action: status === "sent" ? "sent" : `status:${status}`,
    by: createdBy,
    note: scope || (isProposal && branch ? `branch=${branch}` : "")
  });

  records.unshift(q);
  await writeAll(records);
  return q;
}

// Build the default 8-section skeleton for a fresh project_proposal.
// Patrick fills in the body of each section in the builder UI. Order is
// the canonical layout from the McDonald's Hampshire estimate.
function defaultProposalSections() {
  const skeleton = [
    { kind: "cover_summary",      title: "Cover summary" },
    { kind: "quotation_summary",  title: "Quotation summary" },
    { kind: "proposed_scope",     title: "Proposed scope of work" },
    { kind: "infrastructure_list", title: "Infrastructure & materials" },
    { kind: "budget_notice",      title: "Budget & assumptions" },
    { kind: "technical_reference", title: "Technical reference" },
    { kind: "project_map",        title: "Project map" },
    { kind: "line_items",         title: "Itemized pricing" },
    { kind: "acceptance_block",   title: "Acceptance" }
  ];
  return skeleton.map((s, idx) => ({
    id: newSectionId(),
    kind: s.kind,
    title: s.title,
    body: "",
    order: idx,
    attachmentIds: []
  }));
}

function normalizeProposalSection(s, idx) {
  if (!s || typeof s !== "object") s = {};
  const kind = PROPOSAL_SECTION_KINDS.includes(s.kind) ? s.kind : "custom";
  return {
    id: typeof s.id === "string" && s.id.startsWith("sec_") ? s.id : newSectionId(),
    kind,
    title: String(s.title || "").slice(0, 200),
    body: String(s.body || "").slice(0, 40000),
    order: Number.isFinite(Number(s.order)) ? Number(s.order) : idx,
    attachmentIds: Array.isArray(s.attachmentIds)
      ? s.attachmentIds.filter((x) => typeof x === "string" && x.startsWith("att_")).slice(0, 50)
      : []
  };
}

// ---- Lock guard ------------------------------------------------------
//
// A project_proposal is "locked" once it has moved past draft. Edits to
// scope-protected fields (proposalSections, lineItems, attachments,
// branch, billingMode, customRates, subtotal/hst/total, type) refuse
// with 409 at the dispatcher. Non-locked fields (status forward-
// progression, notes, history) keep flowing.

function isProposalLocked(q) {
  if (!q || q.type !== "project_proposal") return false;
  return q.status !== "draft";
}

function findProtectedFieldTouched(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of Object.keys(payload)) {
    if (SCOPE_PROTECTED_FIELDS.includes(key)) return key;
  }
  return null;
}

// ---- Proposal mutators (draft-only) ----------------------------------
//
// updateProposal patches scope-protected fields on a draft proposal.
// Locked proposals throw — caller should catch and 409.

async function updateProposal(id, patch = {}, { by = "admin", note = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.type !== "project_proposal") {
    const err = new Error("updateProposal only applies to project_proposal quotes.");
    err.code = "wrong_quote_type";
    throw err;
  }
  if (isProposalLocked(q)) {
    const touched = findProtectedFieldTouched(patch);
    if (touched) {
      const err = new Error(`Proposal is locked. Field "${touched}" cannot be modified.`);
      err.code = "proposal_locked";
      err.field = touched;
      throw err;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "branch")) {
    if (patch.branch && !PROPOSAL_BRANCHES.includes(patch.branch)) {
      throw new Error(`Unknown proposal branch: ${patch.branch}`);
    }
    q.branch = patch.branch || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "billingMode")) {
    if (patch.billingMode && !BILLING_MODES.includes(patch.billingMode)) {
      throw new Error(`Unknown billing mode: ${patch.billingMode}`);
    }
    q.billingMode = patch.billingMode || "fixed_price";
  }
  if (Array.isArray(patch.proposalSections)) {
    q.proposalSections = patch.proposalSections.map((s, i) => normalizeProposalSection(s, i));
  }
  if (Array.isArray(patch.lineItems)) {
    q.lineItems = patch.lineItems.map(normalizeProposalLineItem);
    const totals = computeProposalTotals(q.lineItems);
    q.subtotal = totals.subtotal;
    q.hst = totals.hst;
    q.total = totals.total;
  }
  if (patch.customRates && typeof patch.customRates === "object") {
    q.customRates = { ...q.customRates, ...patch.customRates };
  }
  if (typeof patch.scope === "string") {
    q.scope = patch.scope.slice(0, 4000);
  }
  if (typeof patch.customerEmail === "string") {
    q.customerEmail = patch.customerEmail.toLowerCase().trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "customerId")) {
    q.customerId = patch.customerId || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "propertyId")) {
    q.propertyId = patch.propertyId || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "leadId")) {
    q.leadId = patch.leadId || null;
  }
  if (typeof patch.validUntilDate === "string") {
    q.validUntilDate = patch.validUntilDate;
    q.validUntil = patch.validUntilDate;
  }

  q.history.push({
    ts: nowIso(),
    action: "proposal_updated",
    by,
    note: note || `Fields: ${Object.keys(patch).join(", ")}`
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Line items on a proposal carry a `source` discriminator so the UI
// knows whether they came from the public pricing catalog, the
// internal project-rates catalog, or were authored ad-hoc.
function normalizeProposalLineItem(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  const source = ["pricing", "project_rates", "custom"].includes(raw.source) ? raw.source : "custom";
  const sourceKey = source === "custom" ? null : (typeof raw.sourceKey === "string" ? raw.sourceKey : null);
  const qty = Number(raw.qty);
  const price = Number(raw.price);
  const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const safePrice = Number.isFinite(price) ? price : 0;
  const unit = typeof raw.unit === "string" ? raw.unit.slice(0, 40) : "";
  return {
    id: typeof raw.id === "string" && raw.id.startsWith("li_") ? raw.id : ("li_" + random8()),
    source,
    sourceKey,
    label: String(raw.label || raw.sourceKey || "Line item").slice(0, 400),
    description: String(raw.description || "").slice(0, 1000),
    unit,
    qty: safeQty,
    price: safePrice,
    priceAtCreation: Number.isFinite(Number(raw.priceAtCreation)) ? Number(raw.priceAtCreation) : safePrice,
    lineTotal: Math.round(safePrice * safeQty * 100) / 100
  };
}

function computeProposalTotals(lineItems) {
  const lines = Array.isArray(lineItems) ? lineItems : [];
  let subtotal = 0;
  for (const li of lines) subtotal += Number(li.lineTotal) || 0;
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
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

// Stamp an approval token + send-channel record on a quote so it can be
// fetched by the customer-facing /approve/<id> page. Token is a 32-char
// random hex string — sufficient entropy that brute-forcing the URL is
// not a practical attack. Channels: ["email"], ["sms"], ["email","sms"],
// or [] (manual share — Patrick copies the URL himself).
async function markSentForApproval(id, { token, channels = [], toEmail = "", toPhone = "" } = {}) {
  if (!id || !token) throw new Error("markSentForApproval needs id + token");
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  const ts = nowIso();
  q.approval = {
    token,
    sentAt: ts,
    sentVia: Array.isArray(channels) ? channels.slice() : [],
    sentToEmail: String(toEmail || "").toLowerCase().trim(),
    sentToPhone: String(toPhone || "").trim()
  };
  // Promote draft → sent on send. Also handle draft_preview → sent so
  // a tech who previewed first can flip the existing record without
  // burning a fresh Q-YYYY-NNNN (Option B preview-to-send conversion).
  const wasPreview = q.status === "draft_preview";
  if (q.status === "draft" || q.status === "draft_preview") q.status = "sent";
  if (!q.sentAt) q.sentAt = ts;
  q.history.push({
    ts, action: "sent_for_approval", by: "tech",
    note: `${wasPreview ? "Promoted from preview, " : ""}via ${q.approval.sentVia.join("+") || "manual"}`
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Look up a quote by its approval token. Returns the matching quote OR
// null. Used by the public /api/approve/:id/:token endpoints.
async function getByApprovalToken(id, token) {
  if (!id || !token) return null;
  const q = await get(id);
  if (!q || !q.approval || !q.approval.token) return null;
  // Constant-time-ish comparison — since strings are short and JS doesn't
  // have a built-in timingSafeEqual for strings, this is the closest we
  // get without dragging in node:crypto for a public file. Adequate for
  // the threat model (token is 32 hex chars, brute force is not viable).
  if (q.approval.token.length !== token.length) return null;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= q.approval.token.charCodeAt(i) ^ token.charCodeAt(i);
  return mismatch === 0 ? q : null;
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
    // Skip soft-deleted quotes — no point expiring something already
    // hidden from the index (Delete-Quotes brief §3.5).
    if (q.deletedAt) continue;
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

// Refresh the snapshotted line items + totals on an existing
// draft / draft_preview quote. Used when the tech edits the builder
// between previews (or between preview and send) — without this, the
// reused-quote path in send-for-approval would ship the stale snapshot
// from the first preview. Refuses on any status past draft to protect
// the audit trail (Hard Rule 4 — accepted quotes are immutable).
async function refreshLineItems(id, { lineItems, subtotal, hst, total } = {}) {
  if (!id) throw new Error("refreshLineItems needs id");
  if (!Array.isArray(lineItems)) throw new Error("refreshLineItems needs lineItems[]");
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status !== "draft" && q.status !== "draft_preview") {
    throw new Error(`Quote ${id} is in status "${q.status}" — line items are frozen.`);
  }
  q.lineItems = lineItems;
  q.subtotal = Number(subtotal) || 0;
  q.hst = Number(hst) || 0;
  q.total = Number(total) || 0;
  q.history.push({
    ts: nowIso(),
    action: "line_items_refreshed",
    by: "tech",
    note: `Refreshed ${q.lineItems.length} line${q.lineItems.length === 1 ? "" : "s"}`
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Mark an existing quote as a tech-only preview. Reuses the same
// approval.token field that markSentForApproval uses, so /approve/<id>
// renders the same customer view — but status stays "draft_preview"
// instead of flipping to "sent", and no sentAt / sentVia is recorded
// (this isn't a customer-facing transmission). Idempotent — calling
// this on an existing draft_preview rotates the token and refreshes
// the timestamp.
async function markAsPreview(id, { token, by = "tech" } = {}) {
  if (!id || !token) throw new Error("markAsPreview needs id + token");
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status === "sent" || q.status === "accepted" || q.status === "partially_accepted") {
    throw new Error(`Quote ${id} is already ${q.status} — can't downgrade to preview.`);
  }
  const ts = nowIso();
  q.status = "draft_preview";
  q.approval = {
    token,
    // previewAt rather than sentAt — this is NOT a customer transmission
    previewAt: ts,
    sentVia: [],
    sentToEmail: "",
    sentToPhone: ""
  };
  q.history.push({
    ts, action: "preview_generated", by,
    note: "Tech-only preview link issued"
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Convert a draft_preview quote into a real sent quote. Used by the
// send-for-approval endpoint when the tech previewed first then sent.
// Rotates the token (so the preview URL is invalidated when the real
// customer URL is generated), flips status to "sent", and stamps
// sentAt + sentVia. Idempotent if already sent — returns the quote
// unchanged. Returns null if the quote isn't found OR isn't in
// draft_preview state (caller should fall back to creating a fresh
// quote in that case).
async function convertPreviewToSent(id, { token, channels = [], toEmail = "", toPhone = "" } = {}) {
  if (!id || !token) throw new Error("convertPreviewToSent needs id + token");
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status !== "draft_preview") return null;
  const ts = nowIso();
  q.status = "sent";
  q.approval = {
    token,
    sentAt: ts,
    sentVia: Array.isArray(channels) ? channels.slice() : [],
    sentToEmail: String(toEmail || "").toLowerCase().trim(),
    sentToPhone: String(toPhone || "").trim()
  };
  if (!q.sentAt) q.sentAt = ts;
  q.history.push({
    ts, action: "sent_for_approval", by: "tech",
    note: `Promoted from preview, via ${q.approval.sentVia.join("+") || "manual"}`
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Sweep abandoned preview quotes. Preview quotes that have been sitting
// in draft_preview state for more than `maxAgeMs` are presumed stale —
// the tech either previewed and walked away, or moved on without
// sending. Soft-delete them so they stay on disk for audit (Hard Rule 4)
// but disappear from the /admin/quote-folder index. Returns
// { swept, considered } so the caller can log.
async function sweepStalePreviewQuotes({ now = new Date(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const records = await readAll();
  let swept = 0;
  let considered = 0;
  const cutoffMs = now.getTime() - maxAgeMs;
  for (const q of records) {
    if (q.status !== "draft_preview") continue;
    if (q.deletedAt) continue;
    considered++;
    const previewMs = q.approval?.previewAt
      ? new Date(q.approval.previewAt).getTime()
      : new Date(q.createdAt).getTime();
    if (Number.isFinite(previewMs) && previewMs < cutoffMs) {
      q.deletedAt = now.toISOString();
      q.deletedBy = "system";
      q.history.push({
        ts: now.toISOString(),
        action: "preview_auto_swept",
        by: "system",
        note: `Abandoned preview, no send within ${Math.round(maxAgeMs / 3600000)}h`
      });
      swept++;
    }
  }
  if (swept) await writeAll(records);
  return { swept, considered };
}

// Hard-remove a quote by id (used by /admin/trash permanent-delete). The
// trash dispatcher checks deletedAt before calling — accepted/sent quotes
// can't get here.
async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

// ---- Soft-delete -----------------------------------------------------
//
// Per the Delete-Quotes brief (May 2026), any quote — regardless of
// status — can be soft-deleted from the /admin/quote-folder index. The
// record stays on disk (Hard Rule 4 — all status changes logged forever)
// and downstream references (bookings, projects, invoices, material
// lists) are NOT modified. 30-day Trash retention before purge.
//
// Idempotency contract: calling softDelete on an already-deleted quote
// (or restore on an already-active one) returns the current record with
// no duplicate history entry. The legacy bulk delete-drafts action
// (lib/bulk-actions.js) layers its draft/expired-only gate on top of
// this verb at the dispatcher; this lib verb itself stays permissive.

async function softDelete(id, { adminId = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) throw new Error("Quote not found");
  if (records[idx].deletedAt) return records[idx]; // idempotent — no duplicate history
  const ts = nowIso();
  const by = String(adminId || "admin").slice(0, 80);
  const next = { ...records[idx], deletedAt: ts, deletedBy: by };
  if (!Array.isArray(next.history)) next.history = [];
  next.history = [...next.history, {
    ts,
    action: "quote_deleted",
    by,
    note: "Quote soft-deleted from index."
  }];
  records[idx] = next;
  await writeAll(records);
  return records[idx];
}

async function restore(id, { adminId = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === id);
  if (idx === -1) throw new Error("Quote not found");
  if (!records[idx].deletedAt) return records[idx]; // idempotent — no duplicate history
  const ts = nowIso();
  const by = String(adminId || "admin").slice(0, 80);
  const next = { ...records[idx], deletedAt: null, deletedBy: null };
  if (!Array.isArray(next.history)) next.history = [];
  next.history = [...next.history, {
    ts,
    action: "quote_restored",
    by,
    note: "Quote restored to index."
  }];
  records[idx] = next;
  await writeAll(records);
  return records[idx];
}

async function listDeleted() {
  const records = await readAll();
  return records.filter((q) => q.deletedAt);
}

async function purgeDeleted({ olderThanMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const records = await readAll();
  const cutoff = Date.now() - olderThanMs;
  const kept = records.filter((q) => {
    if (!q.deletedAt) return true;
    const t = Date.parse(q.deletedAt);
    return !Number.isFinite(t) || t > cutoff;
  });
  const purged = records.length - kept.length;
  if (purged > 0) await writeAll(kept);
  return purged;
}

// ---- Attachments ----------------------------------------------------
//
// Static media uploads on project_proposal quotes. Saved to disk under
// server/data/quote-attachments/<quoteId>/<attId>.<ext>; metadata
// kept on quote.attachments[]. Photos / PDFs only; size capped per file
// and in aggregate.

function extForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "application/pdf") return "pdf";
  return "bin";
}

async function ensureAttachmentDir(quoteId) {
  const dir = path.join(ATTACHMENTS_DIR, quoteId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function addAttachment(quoteId, { buffer, mimeType, filename, kind = "other", caption = "", uploadedBy = "admin" } = {}) {
  if (!buffer || !buffer.length) throw new Error("Attachment has no data.");
  if (!ATTACHMENT_MIME_WHITELIST.has(mimeType)) {
    throw new Error(`Unsupported attachment type: ${mimeType}. Allowed: PNG, JPEG, PDF.`);
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large (${(buffer.length / 1_000_000).toFixed(1)} MB > 25 MB cap).`);
  }
  const safeKind = ATTACHMENT_KINDS.includes(kind) ? kind : "other";

  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) throw new Error(`Quote ${quoteId} not found.`);
  const q = records[idx];

  // Aggregate cap — sum of existing attachment sizes plus the incoming one.
  const existingBytes = (q.attachments || []).reduce((sum, a) => sum + (Number(a.sizeBytes) || 0), 0);
  if (existingBytes + buffer.length > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Adding this file would exceed the 100 MB total attachment cap for this quote.`);
  }

  // Locked-proposal gate — only signed_pdf_return is allowed on a
  // locked proposal (so the customer's PDF return can land), and even
  // then only when status is "sent" (i.e. awaiting acceptance).
  if (q.type === "project_proposal" && isProposalLocked(q)) {
    if (safeKind !== "signed_pdf_return") {
      const err = new Error(`Proposal is locked. Attachments can't be modified.`);
      err.code = "proposal_locked";
      throw err;
    }
  }

  const attId = newAttachmentId();
  const ext = extForMime(mimeType);
  const dir = await ensureAttachmentDir(quoteId);
  const onDiskPath = path.join(dir, `${attId}.${ext}`);
  await fs.writeFile(onDiskPath, buffer);

  const meta = {
    id: attId,
    kind: safeKind,
    filename: String(filename || `${attId}.${ext}`).slice(0, 200),
    mimeType,
    sizeBytes: buffer.length,
    caption: String(caption || "").slice(0, 400),
    order: (q.attachments || []).length,
    uploadedAt: nowIso(),
    uploadedBy: String(uploadedBy || "admin").slice(0, 80)
  };
  q.attachments = Array.isArray(q.attachments) ? q.attachments : [];
  q.attachments.push(meta);
  q.history.push({
    ts: nowIso(),
    action: "attachment_added",
    by: uploadedBy,
    note: `${attId} ${safeKind} ${meta.filename}`
  });
  records[idx] = q;
  await writeAll(records);
  return meta;
}

async function removeAttachment(quoteId, attachmentId, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) throw new Error(`Quote ${quoteId} not found.`);
  const q = records[idx];
  if (q.type === "project_proposal" && isProposalLocked(q)) {
    const err = new Error("Proposal is locked. Attachments can't be removed.");
    err.code = "proposal_locked";
    throw err;
  }
  const attIdx = (q.attachments || []).findIndex((a) => a.id === attachmentId);
  if (attIdx === -1) throw new Error(`Attachment ${attachmentId} not found.`);
  const att = q.attachments[attIdx];
  q.attachments.splice(attIdx, 1);

  // Also remove the attachment id from any section that anchored it.
  for (const s of (q.proposalSections || [])) {
    if (Array.isArray(s.attachmentIds)) {
      s.attachmentIds = s.attachmentIds.filter((x) => x !== attachmentId);
    }
  }

  q.history.push({
    ts: nowIso(),
    action: "attachment_removed",
    by,
    note: `${attachmentId} ${att.filename || ""}`
  });
  records[idx] = q;
  await writeAll(records);

  // Best-effort file removal — log but don't fail the API call if disk
  // cleanup errors (the metadata is already removed).
  try {
    const ext = extForMime(att.mimeType);
    const onDiskPath = path.join(ATTACHMENTS_DIR, quoteId, `${attachmentId}.${ext}`);
    await fs.unlink(onDiskPath);
  } catch (err) {
    console.warn(`[quotes] couldn't delete ${attachmentId} on disk:`, err?.message);
  }
  return { id: attachmentId };
}

async function readAttachmentBuffer(quoteId, attachmentId) {
  const q = await get(quoteId);
  if (!q) return null;
  const att = (q.attachments || []).find((a) => a.id === attachmentId);
  if (!att) return null;
  const ext = extForMime(att.mimeType);
  const onDiskPath = path.join(ATTACHMENTS_DIR, quoteId, `${attachmentId}.${ext}`);
  try {
    const buf = await fs.readFile(onDiskPath);
    return { buffer: buf, meta: att };
  } catch (err) {
    return null;
  }
}

function listAttachments(quote) {
  return Array.isArray(quote?.attachments) ? quote.attachments : [];
}

// ---- Customer rate snapshot ------------------------------------------

async function snapshotRatesFromCustomer(quoteId, customerId) {
  if (!quoteId || !customerId) return null;
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.type !== "project_proposal") return q;
  try {
    const customersLib = require("./customers");
    const cust = await customersLib.get(customerId, { withProperties: false });
    if (cust && cust.negotiatedRates) {
      q.customRates = { ...q.customRates, ...cust.negotiatedRates };
      q.history.push({
        ts: nowIso(),
        action: "rates_snapshotted",
        by: "system",
        note: `from customer ${customerId}`
      });
      records[idx] = q;
      await writeAll(records);
    }
  } catch (_) { /* tolerate */ }
  return q;
}

// ---- Dual acceptance -------------------------------------------------
//
// Two paths to legally bind a project_proposal:
//   1. Portal e-sign — customer hits /approve/<id>?t=<token>, draws a
//      signature, server records acceptanceMethod=portal_esign and
//      mirrors the evidence into signature{} for back-compat with the
//      existing approve.js front-end.
//   2. PDF return — customer downloads the PDF, prints/signs/scans,
//      uploads the signed copy back via /api/approve/<id>/<token>/
//      pdf-return. Status flips to pending_admin_attestation; Patrick
//      attests via /api/admin/quote-folder/<id>/confirm-pdf-acceptance
//      which sets acceptanceMethod=pdf_return and flips status to
//      accepted.
//
// recordPortalSignAcceptance is the proposal-aware wrapper around the
// existing acceptWithSignature path; recordPdfReturnAcceptance is the
// new admin-attestation step.

async function recordPortalSignAcceptance(quoteId, {
  customerName,
  imageData,
  ip,
  userAgent,
  by = "customer",
  note = ""
} = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.acceptanceMethod === "portal_esign" && q.status === "accepted") return q; // idempotent

  const ts = nowIso();
  q.status = "accepted";
  q.acceptedAt = ts;
  q.acceptanceMethod = "portal_esign";
  q.acceptanceEvidence = {
    method: "portal_esign",
    signatureImageDataUrl: String(imageData || ""),
    customerPrintedName: String(customerName || "").slice(0, 120),
    signedAt: ts,
    ip: String(ip || ""),
    userAgent: String(userAgent || ""),
    token: q.approval?.token || null
  };
  // Mirror onto signature{} so the existing PDF renderer + approve.js
  // back-end keeps working without conditionals.
  q.signature = {
    signed: true,
    customerName: q.acceptanceEvidence.customerPrintedName,
    imageData: q.acceptanceEvidence.signatureImageDataUrl,
    signedAt: ts,
    ip: q.acceptanceEvidence.ip,
    userAgent: q.acceptanceEvidence.userAgent
  };
  q.history.push({
    ts,
    action: "accepted",
    by,
    note: note || "Accepted via portal e-sign"
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// Customer uploads their signed PDF — server stages it as an attachment
// of kind "signed_pdf_return" and flips status to pending_admin_attestation.
// The admin attestation step (recordPdfReturnAcceptance below) is what
// actually accepts the quote — this just stages the evidence.
async function stagePdfReturn(quoteId, { buffer, filename, senderEmail = "" } = {}) {
  if (!buffer || !buffer.length) throw new Error("PDF return has no data.");
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Signed PDF too large (${(buffer.length / 1_000_000).toFixed(1)} MB > 25 MB cap).`);
  }
  // Bypass the standard locked-proposal gate by using kind=signed_pdf_return
  // (addAttachment whitelists this kind specifically on locked proposals).
  const att = await addAttachment(quoteId, {
    buffer,
    mimeType: "application/pdf",
    filename: filename || `signed-${quoteId}.pdf`,
    kind: "signed_pdf_return",
    caption: senderEmail ? `Received from ${senderEmail}` : "Customer-returned signed PDF",
    uploadedBy: "customer"
  });

  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) return null;
  const q = records[idx];
  q.status = "pending_admin_attestation";
  q.acceptanceEvidence = {
    method: "pdf_return",
    uploadedPdfAttachmentId: att.id,
    senderEmail: String(senderEmail || "").toLowerCase().trim(),
    receivedAt: nowIso(),
    confirmedBy: null,
    confirmedAt: null,
    adminNote: ""
  };
  q.history.push({
    ts: nowIso(),
    action: "pdf_return_received",
    by: "customer",
    note: senderEmail ? `from ${senderEmail}` : ""
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

async function recordPdfReturnAcceptance(quoteId, { adminUser, adminNote = "", senderEmailOverride = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === quoteId);
  if (idx === -1) return null;
  const q = records[idx];
  if (q.status === "accepted" && q.acceptanceMethod === "pdf_return") return q; // idempotent
  if (!q.acceptanceEvidence || q.acceptanceEvidence.method !== "pdf_return") {
    throw new Error("No PDF return is staged for this quote.");
  }
  const ts = nowIso();
  q.status = "accepted";
  q.acceptedAt = ts;
  q.acceptanceMethod = "pdf_return";
  q.acceptanceEvidence = {
    ...q.acceptanceEvidence,
    senderEmail: senderEmailOverride
      ? String(senderEmailOverride).toLowerCase().trim()
      : q.acceptanceEvidence.senderEmail,
    confirmedBy: String(adminUser || "admin").slice(0, 80),
    confirmedAt: ts,
    adminNote: String(adminNote || "").slice(0, 2000)
  };
  q.history.push({
    ts,
    action: "accepted",
    by: adminUser || "admin",
    note: adminNote || "Accepted via PDF-return — admin attested"
  });
  records[idx] = q;
  await writeAll(records);
  return q;
}

// ---- Revisions ------------------------------------------------------
//
// On a sent project_proposal, customer asks for changes. createRevision
// clones to a new Q-YYYY-NNNN with revisionOf pointing at the original;
// the original gets status: "superseded" + supersededBy back-reference.
// New revision starts in "draft" so Patrick can edit the sections,
// attachments are copied (new ids, same files duplicated on disk), and
// the chain extends (v3 → v2 → v1).

async function createRevision(originalId, { by = "admin", note = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((q) => q.id === originalId);
  if (idx === -1) throw new Error(`Quote ${originalId} not found.`);
  const original = records[idx];
  if (original.type !== "project_proposal") {
    throw new Error("Only project_proposal quotes support revisions.");
  }
  if (original.status === "draft") {
    throw new Error("Original is still a draft — edit it directly rather than creating a revision.");
  }
  if (original.status === "superseded") {
    throw new Error("Original has already been superseded.");
  }

  const year = new Date().getUTCFullYear();
  const newId = await nextQuoteId(year);

  const revision = blankQuote();
  revision.id = newId;
  revision.type = "project_proposal";
  revision.status = "draft";
  revision.createdAt = nowIso();
  revision.createdBy = by;
  revision.version = (Number(original.version) || 1) + 1;
  revision.supersedesId = original.id;
  revision.revisionOf = original.id;
  revision.customerId = original.customerId;
  revision.customerEmail = original.customerEmail;
  revision.propertyId = original.propertyId;
  revision.leadId = original.leadId;
  revision.branch = original.branch;
  revision.billingMode = original.billingMode;
  revision.customRates = { ...original.customRates };
  revision.scope = original.scope;
  revision.proposalSections = (original.proposalSections || []).map((s, i) => ({
    ...s,
    id: newSectionId(),
    order: i,
    attachmentIds: [] // re-anchored below after attachments are copied
  }));
  revision.lineItems = (original.lineItems || []).map((li) => ({
    ...li,
    id: "li_" + random8()
  }));
  const totals = computeProposalTotals(revision.lineItems);
  revision.subtotal = totals.subtotal;
  revision.hst = totals.hst;
  revision.total = totals.total;
  revision.validUntil = plusDaysIso(PROPOSAL_DEFAULT_VALIDITY_DAYS);
  revision.validUntilDate = revision.validUntil;
  revision.history = [
    { ts: revision.createdAt, action: "created", by, note: `Revision of ${original.id}` }
  ];

  // Copy attachments — both metadata (with new ids) AND files on disk.
  // Section attachmentIds are re-mapped in lock-step.
  const idMap = new Map();
  revision.attachments = [];
  for (const att of (original.attachments || [])) {
    if (att.kind === "signed_pdf_return") continue; // don't carry signed PDFs forward
    const newAttId = newAttachmentId();
    idMap.set(att.id, newAttId);
    revision.attachments.push({ ...att, id: newAttId, uploadedAt: revision.createdAt, uploadedBy: by });
    try {
      const ext = extForMime(att.mimeType);
      const oldPath = path.join(ATTACHMENTS_DIR, original.id, `${att.id}.${ext}`);
      const newDir = await ensureAttachmentDir(newId);
      const newPath = path.join(newDir, `${newAttId}.${ext}`);
      const buf = await fs.readFile(oldPath);
      await fs.writeFile(newPath, buf);
    } catch (err) {
      console.warn(`[quotes] revision attachment copy failed for ${att.id}:`, err?.message);
    }
  }
  // Remap section anchor ids.
  for (let i = 0; i < revision.proposalSections.length; i++) {
    const original_sec = original.proposalSections[i];
    if (Array.isArray(original_sec?.attachmentIds)) {
      revision.proposalSections[i].attachmentIds = original_sec.attachmentIds
        .map((oldId) => idMap.get(oldId))
        .filter(Boolean);
    }
  }

  records.unshift(revision);

  // Flip the original to superseded.
  original.status = "superseded";
  original.supersededBy = newId;
  original.history.push({
    ts: nowIso(),
    action: "superseded",
    by,
    note: note || `Replaced by revision ${newId} (v${revision.version})`
  });

  await writeAll(records);
  return revision;
}

module.exports = {
  STATUSES,
  TYPES,
  PROPOSAL_BRANCHES,
  BILLING_MODES,
  ACCEPTANCE_METHODS,
  PROPOSAL_SECTION_KINDS,
  ATTACHMENT_KINDS,
  ATTACHMENT_MIME_WHITELIST,
  SCOPE_PROTECTED_FIELDS,
  DEFAULT_VALIDITY_DAYS,
  PROPOSAL_DEFAULT_VALIDITY_DAYS,
  HST_RATE,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
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
  attachWorkOrder,
  markSentForApproval,
  markAsPreview,
  convertPreviewToSent,
  sweepStalePreviewQuotes,
  refreshLineItems,
  getByApprovalToken,
  remove,
  softDelete,
  restore,
  listDeleted,
  purgeDeleted,
  // project_proposal-specific
  isProposalLocked,
  findProtectedFieldTouched,
  updateProposal,
  defaultProposalSections,
  normalizeProposalSection,
  normalizeProposalLineItem,
  computeProposalTotals,
  addAttachment,
  removeAttachment,
  readAttachmentBuffer,
  listAttachments,
  snapshotRatesFromCustomer,
  recordPortalSignAcceptance,
  stagePdfReturn,
  recordPdfReturnAcceptance,
  createRevision
};

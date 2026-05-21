// Projects — the multi-visit container for named jobs (Smith install,
// Carter renovation, etc.). One project lives at one property and groups
// any number of work orders + material lists under a single name +
// status. Distinct from a Booking (one scheduled appointment) and from
// a Property (the customer's site, persistent forever) — a Project is
// scoped to a specific piece of work.
//
// ID format: PROJ-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN /
// I-YYYY-NNNN / BK-YYYY-NNNN / ML-YYYY-NNNN.
//
// Status enum:
//   planning   — being scoped; no on-site work yet
//   active     — at least one WO scheduled or in flight
//   complete   — all WOs done; nothing outstanding
//   archived   — out of the default index; kept for retrieval
//
// Storage: server/data/projects.json. Same flat-file pattern; rotate to
// SQLite if project count crosses ~10,000 (PJL-scale: never).
//
// Linkage:
//   workOrderIds[]   — WOs that roll up under this project
//   sourceQuoteId    — the Quote this project was converted from (if any)
//   propertyId       — the property this project lives at
//
// Material lists attach to a project via the materialLists record's
// parentType="project" + parentId=projectId fields (no back-reference
// stored here — single source of truth lives on the materialLists side).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "projects.json");

const STATUSES = ["planning", "active", "complete", "archived"];

// Mirrors quotes.js — kept in lockstep. If a new branch is added there,
// update this list too.
const BRANCHES = [
  "gc_subcontract",
  "direct_residential",
  "lighting_design",
  "renovation_coordination",
  "change_order"
];
const BILLING_MODES = ["fixed_price", "time_and_material"];

function random8() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

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

// ---- Helpers ---------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function blankProject() {
  const created = nowIso();
  return {
    id: "",
    name: "",
    status: "planning",

    // Customer + address — denormalized for fast index display. Linked
    // property (when set) is the source of truth; customerId references
    // customers.json (Brief 2); the snapshot fields are the as-quoted
    // record preserved for legal continuity.
    customerId: null,
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    propertyId: null,
    address: "",

    description: "",   // one-paragraph scope ("retrofit front yard, 14 zones")
    notes: "",         // free-form internal notes

    // Linked work orders. Push via attachWorkOrder; remove via
    // detachWorkOrder. Order is insertion order — UI sorts as needed.
    workOrderIds: [],

    // If the project was spun out of a Quote (via convert-to-project),
    // sourceQuoteId points back to it so we can render "from Q-2026-0042"
    // on the project header.
    sourceQuoteId: null,

    // -------- project_proposal enrichment (Brief 1, May 2026) --------
    // Populated when the source quote is a project_proposal. Stay at
    // their defaults (null/empty) when converted from older
    // ai_repair_quote / on_site_quote.

    // Branch — mirrored from the quote at conversion time.
    branch: null,
    // billingMode — "fixed_price" or "time_and_material".
    billingMode: null,
    // labourRateLocked — snapshot of customRates.labour at conversion.
    // For T&M projects this is the rate that bills forever; for
    // fixed-price it's informational only. Immutable after conversion.
    labourRateLocked: null,
    // tasks[] — seeded from the quote's line items (one task per line)
    // and edited by Patrick in the pre-Day-1 review before scheduling
    // (Brief 2 takes over from there). { id, description, sourceLineItemId,
    // status, completedAt?, completedByWoId?, order }
    tasks: [],
    // attachments[] — references to the quote's attachments by id, so
    // the project page can render the same map / diagram thumbnails
    // without re-uploading. { id, sourceQuoteAttachmentId, kind,
    // caption, order }
    attachments: [],
    // proposalSnapshot — frozen copy of the accepted proposal at the
    // moment of conversion. Mirrors sections + line items + totals +
    // branch + acceptanceMethod + customer/property snapshot. Used to
    // render the "accepted proposal" view on the project detail page
    // without re-reading the (possibly archived) quote.
    proposalSnapshot: null,

    // Lifecycle timestamps — auto-stamped on status transitions so the
    // UI can show "Active since Mar 14" without a history scan.
    startedAt: null,    // set when status first flips to "active"
    completedAt: null,  // set when status first flips to "complete"

    createdAt: created,
    updatedAt: created,
    createdBy: "admin",

    history: [
      { ts: created, action: "created", by: "admin", note: "" }
    ]
  };
}

function hydrate(rec) {
  const base = blankProject();
  return {
    ...base,
    ...rec,
    status: STATUSES.includes(rec?.status) ? rec.status : "planning",
    workOrderIds: Array.isArray(rec?.workOrderIds) ? rec.workOrderIds.slice() : [],
    history: Array.isArray(rec?.history) ? rec.history.slice(-200) : [],
    tasks: Array.isArray(rec?.tasks) ? rec.tasks : [],
    attachments: Array.isArray(rec?.attachments) ? rec.attachments : [],
    proposalSnapshot: rec?.proposalSnapshot || null,
    branch: rec?.branch || null,
    billingMode: rec?.billingMode || null,
    labourRateLocked: rec?.labourRateLocked == null ? null : Number(rec.labourRateLocked)
  };
}

async function nextProjectId(year) {
  const records = await readAll();
  const prefix = `PROJ-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function appendHistory(record, entry) {
  record.history = Array.isArray(record.history) ? record.history : [];
  record.history.push({ ts: nowIso(), by: "admin", note: "", ...entry });
  if (record.history.length > 200) record.history = record.history.slice(-200);
}

// ---- CRUD -----------------------------------------------------------

async function list({ status = null, includeArchived = false, propertyId = null } = {}) {
  const records = await readAll();
  return records.filter((r) => {
    if (!includeArchived && r.status === "archived" && status !== "archived") return false;
    if (status && r.status !== status) return false;
    if (propertyId && r.propertyId !== propertyId) return false;
    return true;
  });
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function create({
  name = "",
  customerId = null,
  customerName = "",
  customerEmail = "",
  customerPhone = "",
  propertyId = null,
  address = "",
  description = "",
  notes = "",
  sourceQuoteId = null,
  workOrderIds = [],
  createdBy = "admin"
} = {}) {
  // Brief 4 — auto-resolve customerId from email/phone when the caller
  // didn't pass it. Keeps new records correctly linked from creation.
  if (!customerId && (customerEmail || customerPhone)) {
    try {
      const customersLib = require("./customers");
      const match = customerEmail
        ? await customersLib.findByEmail(customerEmail)
        : await customersLib.findByPhone(customerPhone);
      if (match) customerId = match.id;
    } catch (err) { /* tolerate */ }
  }

  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextProjectId(year);
  const rec = blankProject();
  rec.id = id;
  rec.name = String(name || "").trim().slice(0, 200);
  rec.customerId = customerId || null;
  rec.customerName = String(customerName || "").trim().slice(0, 200);
  rec.customerEmail = String(customerEmail || "").trim().toLowerCase().slice(0, 254);
  rec.customerPhone = String(customerPhone || "").trim().slice(0, 40);
  rec.propertyId = propertyId ? String(propertyId) : null;
  rec.address = String(address || "").trim().slice(0, 400);
  rec.description = String(description || "").slice(0, 2000);
  rec.notes = String(notes || "").slice(0, 4000);
  rec.sourceQuoteId = sourceQuoteId ? String(sourceQuoteId) : null;
  rec.workOrderIds = Array.isArray(workOrderIds) ? workOrderIds.filter(Boolean).map(String) : [];
  rec.createdBy = String(createdBy || "admin").slice(0, 80);
  rec.history = [{ ts: nowIso(), action: "created", by: rec.createdBy, note: rec.name || "" }];
  if (rec.sourceQuoteId) {
    appendHistory(rec, { action: "from_quote", note: rec.sourceQuoteId });
  }
  records.unshift(rec);
  await writeAll(records);
  return rec;
}

// Update top-level fields. Status transitions auto-stamp startedAt /
// completedAt the first time a project enters those states. Archived is
// sticky unless the caller explicitly moves it back to a non-archived
// status (which re-derives via the ordinary status path).
async function update(id, patch = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };

  const allowedTop = ["name", "customerName", "customerEmail", "customerPhone", "address", "description", "notes", "propertyId", "sourceQuoteId"];
  for (const key of allowedTop) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "customerEmail") {
        next.customerEmail = String(patch.customerEmail || "").trim().toLowerCase().slice(0, 254);
      } else if (key === "name" || key === "customerName") {
        next[key] = String(patch[key] || "").trim().slice(0, 200);
      } else if (key === "address") {
        next.address = String(patch.address || "").trim().slice(0, 400);
      } else if (key === "customerPhone") {
        next.customerPhone = String(patch.customerPhone || "").trim().slice(0, 40);
      } else if (key === "description") {
        next.description = String(patch.description || "").slice(0, 2000);
      } else if (key === "notes") {
        next.notes = String(patch.notes || "").slice(0, 4000);
      } else if (key === "propertyId" || key === "sourceQuoteId") {
        next[key] = patch[key] ? String(patch[key]) : null;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const requested = patch.status;
    if (!STATUSES.includes(requested)) {
      throw new Error(`Unknown project status: ${requested}`);
    }
    if (current.status !== requested) {
      next.status = requested;
      // Stamp lifecycle timestamps the first time we enter each state.
      if (requested === "active" && !current.startedAt) next.startedAt = nowIso();
      if (requested === "complete" && !current.completedAt) next.completedAt = nowIso();
      appendHistory(next, { action: `status:${requested}` });
    }
  }

  next.updatedAt = nowIso();

  if (current.name !== next.name) appendHistory(next, { action: "renamed", note: next.name });
  if (current.propertyId !== next.propertyId) {
    appendHistory(next, { action: "property_changed", note: next.propertyId || "(detached)" });
  }

  records[idx] = next;
  await writeAll(records);
  return next;
}

// Create a new Project from an accepted project_proposal quote.
//
// Enriches the standard create() with:
//   - branch, billingMode mirrored from the quote
//   - labourRateLocked snapshotted from quote.customRates.labour (T&M
//     uses this rate; fixed-price keeps it informational)
//   - tasks[] seeded from quote.lineItems — one task per line, status
//     "pending", description = line label, sourceLineItemId set
//   - attachments[] referencing quote.attachments by id (no file copy;
//     the project reads through to the quote's directory)
//   - proposalSnapshot frozen copy of the accepted proposal at this
//     instant (sections + line items + totals + branch + acceptance
//     method + customer/property snapshot)
//
// Idempotent at the caller — the convert-to-project endpoint checks
// for an existing project with sourceQuoteId === quote.id before
// invoking this and returns the existing one if found.
async function createFromProposal(quote, { customerName = "", customerEmail = "", customerPhone = "", address = "", propertyId = null, by = "admin" } = {}) {
  if (!quote) throw new Error("createFromProposal requires a quote.");
  if (quote.type !== "project_proposal") {
    throw new Error("createFromProposal only handles project_proposal quotes.");
  }

  const namePieces = [];
  if (customerName) namePieces.push(customerName);
  namePieces.push(`(from ${quote.id})`);
  const name = namePieces.join(" ").slice(0, 200);

  // Seed tasks from line items.
  const tasks = (quote.lineItems || []).map((li, idx) => ({
    id: "task_" + random8(),
    description: String(li.label || li.sourceKey || `Task ${idx + 1}`).slice(0, 400),
    sourceLineItemId: li.id || null,
    status: "pending",
    completedAt: null,
    completedByWoId: null,
    order: idx
  }));

  // Reference quote attachments (no file copy — the project reads
  // through to the quote directory). signed_pdf_return is the
  // acceptance evidence, not a project artifact — skip it here.
  const attachments = (quote.attachments || [])
    .filter((a) => a.kind !== "signed_pdf_return")
    .map((a, idx) => ({
      id: "att_" + random8(),
      sourceQuoteId: quote.id,
      sourceQuoteAttachmentId: a.id,
      kind: a.kind,
      caption: a.caption || a.filename || "",
      filename: a.filename || "",
      mimeType: a.mimeType || "",
      order: idx
    }));

  // Freeze the proposal snapshot.
  const proposalSnapshot = {
    quoteId: quote.id,
    version: quote.version || 1,
    branch: quote.branch || null,
    billingMode: quote.billingMode || null,
    acceptanceMethod: quote.acceptanceMethod || null,
    acceptedAt: quote.acceptedAt || null,
    customerName,
    customerEmail,
    customerPhone,
    address,
    proposalSections: Array.isArray(quote.proposalSections)
      ? quote.proposalSections.map((s) => ({ ...s, attachmentIds: [...(s.attachmentIds || [])] }))
      : [],
    lineItems: Array.isArray(quote.lineItems) ? quote.lineItems.map((li) => ({ ...li })) : [],
    subtotal: Number(quote.subtotal) || 0,
    hst: Number(quote.hst) || 0,
    total: Number(quote.total) || 0,
    customRates: { ...(quote.customRates || {}) },
    scope: quote.scope || "",
    frozenAt: nowIso()
  };

  // Delegate to the standard create() so the id-generation + file-write
  // path is single-source. Then patch the proposal-only fields.
  const proj = await create({
    name,
    customerName,
    customerEmail,
    customerPhone,
    address,
    propertyId,
    sourceQuoteId: quote.id,
    description: quote.scope || "",
    createdBy: by
  });

  // Patch the proposal-only fields directly on the record.
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === proj.id);
  if (idx === -1) return proj;
  records[idx] = {
    ...records[idx],
    branch: quote.branch || null,
    billingMode: quote.billingMode || null,
    labourRateLocked: Number.isFinite(Number(quote.customRates?.labour))
      ? Number(quote.customRates.labour)
      : null,
    tasks,
    attachments,
    proposalSnapshot
  };
  appendHistory(records[idx], {
    action: "proposal_enriched",
    by,
    note: `tasks=${tasks.length} attachments=${attachments.length} branch=${quote.branch || "none"}`
  });
  await writeAll(records);
  return records[idx];
}

// Push a WO id onto the project's workOrderIds[]. Idempotent — if the
// WO is already attached, returns the project unchanged. Caller is
// responsible for setting the WO's reverse pointer (Phase 2 keeps this
// loose-coupled because WOs don't carry a projectId field yet — the UI
// reads project.workOrderIds[] as the source of truth).
async function attachWorkOrder(id, workOrderId) {
  if (!id || !workOrderId) return null;
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const proj = records[idx];
  if (!Array.isArray(proj.workOrderIds)) proj.workOrderIds = [];
  if (!proj.workOrderIds.includes(workOrderId)) {
    proj.workOrderIds.push(workOrderId);
    proj.updatedAt = nowIso();
    appendHistory(proj, { action: "wo_attached", note: workOrderId });
    records[idx] = proj;
    await writeAll(records);
  }
  return proj;
}

async function detachWorkOrder(id, workOrderId) {
  if (!id || !workOrderId) return null;
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const proj = records[idx];
  const before = (proj.workOrderIds || []).length;
  proj.workOrderIds = (proj.workOrderIds || []).filter((x) => x !== workOrderId);
  if (proj.workOrderIds.length !== before) {
    proj.updatedAt = nowIso();
    appendHistory(proj, { action: "wo_detached", note: workOrderId });
    records[idx] = proj;
    await writeAll(records);
  }
  return proj;
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

// Find projects whose workOrderIds[] contains this WO. Almost always 0
// or 1 — but the schema doesn't enforce uniqueness so callers should
// handle the multi case (display "in 2 projects").
async function listByWorkOrder(workOrderId) {
  if (!workOrderId) return [];
  const records = await readAll();
  return records.filter((r) => Array.isArray(r.workOrderIds) && r.workOrderIds.includes(workOrderId));
}

module.exports = {
  STATUSES,
  BRANCHES,
  BILLING_MODES,
  list,
  get,
  create,
  createFromProposal,
  update,
  attachWorkOrder,
  detachWorkOrder,
  remove,
  listByWorkOrder
};

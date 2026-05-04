// Material Lists — the bill-of-materials document used everywhere PJL
// tracks parts: standalone (Phase 1), attached to a Project / Work Order
// / Quote (Phase 2), turned into one or more Purchase Orders by supplier
// (Phase 3).
//
// Design note: a material list NEVER snapshots descriptions, prices, or
// units. It only stores `{ sku, qty, status, notes }` per line. parts.json
// remains the single source of truth — descriptions/prices are looked up
// at render time and at PO generation time. This is the same discipline
// the rest of the system uses for the parts catalog (see crm-parts.js).
//
// ID format: ML-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN /
// I-YYYY-NNNN / BK-YYYY-NNNN for visual consistency in the admin.
//
// Status enum (whole list):
//   draft        — being built, not yet purchased
//   in_progress  — at least one PO has been emitted; some lines still "need"
//   complete     — every line is "have"; nothing outstanding
//   archived     — out of the default index; kept for retrieval/copy
//
// Line item status enum:
//   need         — outstanding; PO generation pulls these
//   ordered      — on a PO that's been sent (Phase 3 sets this; lineItem.poId backref)
//   have         — on the truck / installed; PO generation skips these
//
// Storage: server/data/material-lists.json. Same flat-file pattern;
// rotate to SQLite if list count crosses ~10,000.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "material-lists.json");

const STATUSES = ["draft", "in_progress", "complete", "archived"];
const LINE_STATUSES = ["need", "ordered", "have"];
const PARENT_TYPES = ["project", "work_order", "quote"];

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

// Per-line stable id. The builder UI needs to track lines by something
// other than array index so add/remove operations don't reorder by accident.
function makeLineId() {
  return "li_" + crypto.randomBytes(6).toString("base64url");
}

function hydrateLine(line) {
  const sku = typeof line?.sku === "string" ? line.sku.trim() : "";
  const qty = Number(line?.qty);
  const safeQty = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
  const status = LINE_STATUSES.includes(line?.status) ? line.status : "need";
  return {
    id: typeof line?.id === "string" && line.id ? line.id : makeLineId(),
    sku,
    qty: safeQty,
    status,
    poId: typeof line?.poId === "string" && line.poId ? line.poId : null,
    notes: typeof line?.notes === "string" ? line.notes.slice(0, 500) : ""
  };
}

function blankList() {
  const created = nowIso();
  return {
    id: "",
    name: "",
    status: "draft",

    // Parent linkage — Phase 1 leaves these null (standalone lists).
    // Phase 2 wires them when a list is built inside a project / WO / quote
    // editor. parentType + parentId are independent so deleting a parent
    // doesn't leave the list dangling — the index page detects "orphaned"
    // by parentId-not-found and shows a fix-up affordance.
    parentType: null,
    parentId: null,

    // Denormalized customer fields — copied from the parent record (when
    // attached) so the index can render "for Smith @ 123 Main St" without
    // a join. Standalone lists let the user type these directly so they're
    // still findable in retrieval.
    customerName: "",
    customerEmail: "",
    address: "",

    notes: "",
    lineItems: [],

    createdAt: created,
    updatedAt: created,
    createdBy: "admin",

    // Audit trail. Every status change + line mutation appends an entry.
    // Capped at 200 entries to bound JSON growth on long-lived lists.
    history: [
      { ts: created, action: "created", by: "admin", note: "" }
    ]
  };
}

function hydrate(rec) {
  const base = blankList();
  const safeStatus = STATUSES.includes(rec?.status) ? rec.status : "draft";
  const safeParentType = PARENT_TYPES.includes(rec?.parentType) ? rec.parentType : null;
  return {
    ...base,
    ...rec,
    status: safeStatus,
    parentType: safeParentType,
    parentId: typeof rec?.parentId === "string" && rec.parentId ? rec.parentId : null,
    name: typeof rec?.name === "string" ? rec.name : "",
    customerName: typeof rec?.customerName === "string" ? rec.customerName : "",
    customerEmail: typeof rec?.customerEmail === "string" ? rec.customerEmail.toLowerCase() : "",
    address: typeof rec?.address === "string" ? rec.address : "",
    notes: typeof rec?.notes === "string" ? rec.notes : "",
    lineItems: Array.isArray(rec?.lineItems) ? rec.lineItems.map(hydrateLine) : [],
    history: Array.isArray(rec?.history) ? rec.history.slice(-200) : []
  };
}

async function nextListId(year) {
  const records = await readAll();
  const prefix = `ML-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Roll up the list's line items into a list-level status. Used after any
// line mutation so the index pill stays in sync with reality.
//   - all "have"        -> complete
//   - any "need"        -> draft  (nothing in flight yet)
//   - any "ordered"     -> in_progress
// archived is sticky — never auto-set/cleared by this rollup.
function deriveStatus(lineItems, currentStatus) {
  if (currentStatus === "archived") return "archived";
  if (!Array.isArray(lineItems) || lineItems.length === 0) return "draft";
  const hasNeed = lineItems.some((l) => l.status === "need");
  const hasOrdered = lineItems.some((l) => l.status === "ordered");
  if (!hasNeed && !hasOrdered) return "complete";
  if (hasOrdered) return "in_progress";
  return "draft";
}

function appendHistory(record, entry) {
  record.history = Array.isArray(record.history) ? record.history : [];
  record.history.push({ ts: nowIso(), by: "admin", note: "", ...entry });
  if (record.history.length > 200) record.history = record.history.slice(-200);
}

// ---- CRUD -----------------------------------------------------------

async function list({ status = null, parentType = null, parentId = null, includeArchived = false } = {}) {
  const records = await readAll();
  return records.filter((r) => {
    if (!includeArchived && r.status === "archived" && status !== "archived") return false;
    if (status && r.status !== status) return false;
    if (parentType && r.parentType !== parentType) return false;
    if (parentId && r.parentId !== parentId) return false;
    return true;
  });
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function listByParent(parentType, parentId) {
  if (!PARENT_TYPES.includes(parentType) || !parentId) return [];
  return list({ parentType, parentId, includeArchived: true });
}

async function create({
  name = "",
  parentType = null,
  parentId = null,
  customerName = "",
  customerEmail = "",
  address = "",
  notes = "",
  lineItems = [],
  createdBy = "admin"
} = {}) {
  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextListId(year);
  const rec = blankList();
  rec.id = id;
  rec.name = String(name || "").trim().slice(0, 200);
  rec.parentType = PARENT_TYPES.includes(parentType) ? parentType : null;
  rec.parentId = parentId && rec.parentType ? String(parentId) : null;
  rec.customerName = String(customerName || "").trim().slice(0, 200);
  rec.customerEmail = String(customerEmail || "").trim().toLowerCase().slice(0, 254);
  rec.address = String(address || "").trim().slice(0, 400);
  rec.notes = String(notes || "").slice(0, 4000);
  rec.createdBy = String(createdBy || "admin").slice(0, 80);
  rec.lineItems = Array.isArray(lineItems) ? lineItems.map(hydrateLine) : [];
  rec.status = deriveStatus(rec.lineItems, rec.status);
  rec.history = [{ ts: nowIso(), action: "created", by: rec.createdBy, note: rec.name || "" }];
  records.unshift(rec);
  await writeAll(records);
  return rec;
}

// Full update — accepts top-level field patches and a wholesale lineItems
// replacement (the builder PATCHes the entire array). Status auto-derives
// from the line items unless the caller explicitly passes a status that's
// either "archived" or matches the derived value (lets the UI nudge an
// otherwise-complete list back to "draft" only via the archive flow).
async function update(id, patch = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };

  const allowedTop = ["name", "customerName", "customerEmail", "address", "notes", "parentType", "parentId"];
  for (const key of allowedTop) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "parentType") {
        next.parentType = PARENT_TYPES.includes(patch.parentType) ? patch.parentType : null;
      } else if (key === "parentId") {
        next.parentId = patch.parentId ? String(patch.parentId) : null;
      } else if (key === "customerEmail") {
        next.customerEmail = String(patch.customerEmail || "").trim().toLowerCase().slice(0, 254);
      } else if (key === "name") {
        next.name = String(patch.name || "").trim().slice(0, 200);
      } else if (key === "customerName") {
        next.customerName = String(patch.customerName || "").trim().slice(0, 200);
      } else if (key === "address") {
        next.address = String(patch.address || "").trim().slice(0, 400);
      } else if (key === "notes") {
        next.notes = String(patch.notes || "").slice(0, 4000);
      }
    }
  }

  let lineItemsChanged = false;
  if (Array.isArray(patch.lineItems)) {
    next.lineItems = patch.lineItems.map(hydrateLine);
    lineItemsChanged = true;
  }

  // Status: archived is sticky-on (must be requested explicitly). Anything
  // else derives from line state. This prevents the UI from accidentally
  // marking a half-built list as "complete" by passing the wrong status.
  if (patch.status === "archived") {
    next.status = "archived";
  } else if (current.status === "archived" && patch.status && patch.status !== "archived") {
    next.status = deriveStatus(next.lineItems, patch.status); // unarchive
  } else {
    next.status = deriveStatus(next.lineItems, current.status);
  }

  next.updatedAt = nowIso();

  // History — log the kind of change. Coalesce multiple line-item edits in
  // the same PATCH into one entry so the audit trail doesn't drown in noise.
  if (lineItemsChanged) {
    appendHistory(next, { action: "lines_updated", note: `${next.lineItems.length} line${next.lineItems.length === 1 ? "" : "s"}` });
  }
  if (current.status !== next.status) {
    appendHistory(next, { action: `status:${next.status}`, note: "" });
  }
  if (current.name !== next.name) {
    appendHistory(next, { action: "renamed", note: next.name });
  }
  if (current.parentType !== next.parentType || current.parentId !== next.parentId) {
    appendHistory(next, {
      action: "parent_changed",
      note: next.parentType ? `${next.parentType}:${next.parentId}` : "detached"
    });
  }

  records[idx] = next;
  await writeAll(records);
  return next;
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

// Compute totals against a parts catalog. Caller passes the parts map
// (catalog.parts from /api/parts). Lines whose SKU isn't found contribute
// 0 to subtotals but still appear in the per-status counts so the UI can
// flag them as "unknown SKU". Prices are in cents (parts.json convention).
function computeTotals(record, partsMap) {
  const totals = {
    lineCount: 0,
    needCount: 0,
    orderedCount: 0,
    haveCount: 0,
    unknownSkuCount: 0,
    needSubtotalCents: 0,
    haveSubtotalCents: 0,
    orderedSubtotalCents: 0,
    grandSubtotalCents: 0
  };
  const lines = Array.isArray(record?.lineItems) ? record.lineItems : [];
  for (const line of lines) {
    totals.lineCount++;
    const part = partsMap && Object.prototype.hasOwnProperty.call(partsMap, line.sku) ? partsMap[line.sku] : null;
    if (!part) totals.unknownSkuCount++;
    const unitCents = part && Number.isFinite(Number(part.priceCents)) ? Number(part.priceCents) : 0;
    const lineCents = unitCents * (Number(line.qty) || 0);
    totals.grandSubtotalCents += lineCents;
    if (line.status === "need")    { totals.needCount++;    totals.needSubtotalCents    += lineCents; }
    if (line.status === "ordered") { totals.orderedCount++; totals.orderedSubtotalCents += lineCents; }
    if (line.status === "have")    { totals.haveCount++;    totals.haveSubtotalCents    += lineCents; }
  }
  return totals;
}

module.exports = {
  STATUSES,
  LINE_STATUSES,
  PARENT_TYPES,
  list,
  get,
  listByParent,
  create,
  update,
  remove,
  computeTotals,
  deriveStatus
};

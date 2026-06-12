// Quote Requests (RFQs) — the "ask for a price" sibling of a Purchase
// Order ("commit to buy"). One RFQ per supplier, generated from a
// material list's "need" lines, emailed as a PDF+CSV pair that shows
// quantities and descriptions but NO prices — the supplier fills those in.
//
// CORE DESIGN RULE: generating / sending / cancelling an RFQ NEVER
// changes material-list line status. Lines stay "need" the whole time —
// an RFQ is a question, not a commitment. Only a PO (purchase-orders.js)
// flips lines to "ordered". Nothing in this module reads or writes
// material-lists data; generation takes the list as a plain argument.
//
// ID format: RFQ-YYYY-NNNN. Per-year counter, mirrors PO-YYYY-NNNN.
//
// Status enum:
//   draft      — generated from a material list, editable, not yet sent
//   sent       — emailed to supplier; documents frozen on disk, lines locked
//   quoted     — supplier replied with prices (Phase B fills quotedPriceCents)
//   applied    — quoted prices pushed into the parts catalog (Phase B)
//   cancelled  — terminal; no source-line cleanup needed (see core rule)
//
// Line shape: { id: "rfqli_…", sku, description, quantity, unit,
// quotedPriceCents }. Description and unit are SNAPSHOTTED at generation
// (resolveLineDescription + part.unit) so a catalog edit after send can't
// change what the supplier was asked about. quotedPriceCents stays null
// in Phase A — it exists so Phase B can record the supplier's reply
// without a schema migration. There is deliberately NO unitPriceCents /
// lineTotalCents here: an RFQ carries no prices of ours, anywhere.
//
// Generation idempotency: re-running generate against the same list
// REFRESHES the lines of an existing DRAFT for the same
// (sourceMaterialListId, supplierId) pair instead of duplicating it.
// Non-draft RFQs are never modified — if the previous one was sent or
// cancelled, a fresh draft is created alongside it.
//
// Storage: server/data/quote-requests.json. Same flat-file pattern as
// the siblings, but writes are ATOMIC (stage to .tmp, fsync, rename —
// the parts.js writeOverrides pattern) so a crash mid-write can't leave
// a truncated store. Sent documents are frozen at
// server/data/quote-requests/files/<RFQ-ID>.pdf|.csv by the caller.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveLineDescription } = require("./format");

const FILE = path.join(__dirname, "..", "data", "quote-requests.json");

const STATUSES = ["draft", "sent", "quoted", "applied", "cancelled"];

const STATUS_LABELS = {
  draft: "Draft",
  sent: "Sent",
  quoted: "Quoted",
  applied: "Applied",
  cancelled: "Cancelled"
};

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

// Atomic write: stage to .tmp, fsync, rename. Prevents partial files on
// a crash mid-write — same pattern as parts.js writeOverrides.
async function writeAll(records) {
  await ensureFile();
  const json = JSON.stringify(records, null, 2) + "\n";
  const tmp = FILE + ".tmp";
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, FILE);
}

// ---- Helpers ---------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function makeRfqLineId() {
  return "rfqli_" + crypto.randomBytes(6).toString("base64url");
}

function hydrateLine(line) {
  const sku = typeof line?.sku === "string" ? line.sku.trim() : "";
  const qty = Number(line?.quantity);
  const quantity = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
  // quotedPriceCents: null = "supplier hasn't quoted yet" (the Phase A
  // resting state). Only a non-negative finite number sticks. NB:
  // null/undefined must STAY null — guard before Number() because
  // Number(null) === 0 would otherwise read as "quoted at $0" (same
  // trap as frozenPriceCents in material-lists.js).
  const rawQuoted = line?.quotedPriceCents;
  const quotedNum = Number(rawQuoted);
  const quotedPriceCents = rawQuoted != null && Number.isFinite(quotedNum) && quotedNum >= 0
    ? Math.floor(quotedNum)
    : null;
  return {
    id: typeof line?.id === "string" && line.id ? line.id : makeRfqLineId(),
    sku,
    // Snapshot taken at generation via resolveLineDescription. 240-char
    // cap matches parts.js's description limit (and PO lines).
    description: typeof line?.description === "string" ? line.description.trim().slice(0, 240) : "",
    quantity,
    // Snapshot of part.unit at generation; "each" matches the parts.js
    // hydration default so legacy/blank lines render sensibly.
    unit: typeof line?.unit === "string" && line.unit.trim() ? line.unit.trim().slice(0, 40) : "each",
    quotedPriceCents
  };
}

function blankRfq() {
  const created = nowIso();
  return {
    id: "",
    status: "draft",

    supplierId: null,
    // Snapshots of supplier fields at create time, like POs — a supplier
    // rename doesn't retroactively change a sent RFQ.
    supplierName: "",
    supplierEmail: "",
    supplierContactName: "",
    supplierPhone: "",
    supplierAddress: "",

    // Single source list backref (ML-YYYY-NNNN). Unlike POs (which can
    // merge several lists), an RFQ is always one list's slice — the
    // (list, supplier) pair is the idempotency key for generation.
    sourceMaterialListId: null,

    lines: [],

    notes: "",                  // free-form; printed on the RFQ PDF

    // Email send state, snapshotted at send time.
    emailedToEmail: "",
    emailedToName: "",
    emailSubject: "",

    sentAt: null,
    quotedAt: null,
    appliedAt: null,
    cancelledAt: null,
    cancelReason: "",

    createdAt: created,
    updatedAt: created,
    createdBy: "admin",

    history: [
      { ts: created, action: "created", by: "admin", note: "" }
    ],

    // Snapshot-on-send paths. When the RFQ transitions draft → sent, the
    // rendered PDF and CSV are written to disk and these are set. Resend
    // re-attaches the stored files byte-identical. Null on drafts;
    // immutable once set.
    pdfPath: null,
    csvPath: null,
    documentsGeneratedAt: null
  };
}

function hydrate(rec) {
  const base = blankRfq();
  return {
    ...base,
    ...rec,
    status: STATUSES.includes(rec?.status) ? rec.status : "draft",
    sourceMaterialListId: typeof rec?.sourceMaterialListId === "string" && rec.sourceMaterialListId ? rec.sourceMaterialListId : null,
    lines: Array.isArray(rec?.lines) ? rec.lines.map(hydrateLine) : [],
    history: Array.isArray(rec?.history) ? rec.history.slice(-200) : [],
    pdfPath: typeof rec?.pdfPath === "string" ? rec.pdfPath : null,
    csvPath: typeof rec?.csvPath === "string" ? rec.csvPath : null,
    documentsGeneratedAt: typeof rec?.documentsGeneratedAt === "string" ? rec.documentsGeneratedAt : null
  };
}

async function nextRfqId(year) {
  const records = await readAll();
  const prefix = `RFQ-${year}-`;
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

async function list({ status = null, supplierId = null, sourceMaterialListId = null } = {}) {
  const records = await readAll();
  return records.filter((r) => {
    if (status && r.status !== status) return false;
    if (supplierId && r.supplierId !== supplierId) return false;
    if (sourceMaterialListId && r.sourceMaterialListId !== sourceMaterialListId) return false;
    return true;
  });
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function create({
  supplierId = null,
  supplierName = "",
  supplierEmail = "",
  supplierContactName = "",
  supplierPhone = "",
  supplierAddress = "",
  sourceMaterialListId = null,
  lines = [],
  notes = "",
  createdBy = "admin"
} = {}) {
  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextRfqId(year);
  const rec = blankRfq();
  rec.id = id;
  rec.supplierId = supplierId ? String(supplierId) : null;
  rec.supplierName = String(supplierName || "").trim().slice(0, 200);
  rec.supplierEmail = String(supplierEmail || "").trim().toLowerCase().slice(0, 254);
  rec.supplierContactName = String(supplierContactName || "").trim().slice(0, 120);
  rec.supplierPhone = String(supplierPhone || "").trim().slice(0, 40);
  rec.supplierAddress = String(supplierAddress || "").trim().slice(0, 400);
  rec.sourceMaterialListId = sourceMaterialListId ? String(sourceMaterialListId) : null;
  rec.lines = Array.isArray(lines) ? lines.map(hydrateLine) : [];
  rec.notes = String(notes || "").slice(0, 4000);
  rec.createdBy = String(createdBy || "admin").slice(0, 80);
  records.unshift(rec);
  await writeAll(records);
  return rec;
}

// Update editable fields — `lines` (full replacement, re-hydrated) and
// `notes`. Line edits are DRAFT-ONLY: once sent, the lines must match
// the documents the supplier received, so any patch touching lines on a
// non-draft throws. Status changes always go through markSent /
// markCancelled so the document-freeze bookkeeping can't be skipped.
//
// Incoming lines that carry an existing line's id keep it (hydrateLine
// preserves provided ids), so the builder UI can track lines across
// saves without them re-keying under it.
async function update(id, patch = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (current.status !== "draft" && Array.isArray(patch.lines)) {
    throw new Error(`Cannot edit lines on a ${current.status} quote request`);
  }
  const next = { ...current };
  let linesChanged = false;
  let notesChanged = false;
  if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
    const newNotes = String(patch.notes == null ? "" : patch.notes).slice(0, 4000);
    if (newNotes !== next.notes) notesChanged = true;
    next.notes = newNotes;
  }
  if (Array.isArray(patch.lines)) {
    next.lines = patch.lines.map(hydrateLine);
    linesChanged = true;
  }
  next.updatedAt = nowIso();
  if (linesChanged) {
    appendHistory(next, { action: "lines_updated", note: `${next.lines.length} line${next.lines.length === 1 ? "" : "s"}` });
  }
  if (notesChanged) {
    appendHistory(next, { action: "notes_updated", note: "" });
  }
  records[idx] = next;
  await writeAll(records);
  return next;
}

// ---- Generation from a material list -------------------------------

// Group a material list's "need" lines by their primary supplier (the
// first entry in part.supplierIds[] — same rule as
// purchase-orders.planDraftsFromMaterialList, so an RFQ and the eventual
// PO always land at the same vendor). PURE: (list, partsMap) -> plan.
// Returns:
//   {
//     ok: bool,                 // at least one group AND no missing suppliers
//     groups: [{ supplierId, lines: [{ sku, description, quantity, unit, quotedPriceCents: null }] }],
//     missingSupplier: [sku],   // need-line SKUs with no supplier assignment
//     missingSupplierLines: [{ sku, qty, lineId }]
//   }
//
// Each line snapshots its description (resolveLineDescription — ML lines
// store no description, so this resolves from the catalog) and unit
// (part.unit || "each"). NO price of any kind is read or stored —
// pricing is exactly what we're asking the supplier for.
function planFromMaterialList(list, partsMap) {
  if (!list || !Array.isArray(list.lineItems)) {
    return { ok: false, groups: [], missingSupplier: [], missingSupplierLines: [] };
  }
  const groups = new Map();   // supplierId -> { supplierId, lines[] }
  const missingSupplier = new Set();
  const missingSupplierLines = [];
  for (const line of list.lineItems) {
    if (line.status !== "need") continue;
    const part = partsMap && partsMap[line.sku];
    const supplierIds = (part && Array.isArray(part.supplierIds)) ? part.supplierIds : [];
    if (!supplierIds.length) {
      missingSupplier.add(line.sku);
      missingSupplierLines.push({ sku: line.sku, qty: line.qty, lineId: line.id });
      continue;
    }
    const primary = supplierIds[0];
    if (!groups.has(primary)) {
      groups.set(primary, { supplierId: primary, lines: [] });
    }
    groups.get(primary).lines.push({
      sku: line.sku,
      description: resolveLineDescription(line, partsMap),
      quantity: Math.max(1, Math.floor(Number(line.qty) || 1)),
      unit: (part && typeof part.unit === "string" && part.unit.trim()) ? part.unit.trim() : "each",
      quotedPriceCents: null
    });
  }
  return {
    ok: groups.size > 0 && missingSupplier.size === 0,
    groups: Array.from(groups.values()),
    missingSupplier: Array.from(missingSupplier),
    missingSupplierLines
  };
}

// Persist a plan. Idempotency rule: for each (sourceMaterialListId,
// supplierId) pair, an existing DRAFT RFQ is REFRESHED (lines replaced
// from the fresh plan, updatedAt bumped, history "regenerated") instead
// of duplicated. Non-draft RFQs are never modified — if the previous
// RFQ for the pair was sent/quoted/applied/cancelled, a new draft is
// created alongside it. Refreshed lines keep their existing line ids
// when the SKU matches, so the detail UI doesn't re-key under the admin.
//
// Supplier contact fields are snapshotted from supplierById (a Map of
// supplierId -> hydrated supplier record; a plain object also works).
// An unknown supplierId still generates — with blank snapshot fields —
// so a catalog/supplier mismatch surfaces as a fixable draft rather
// than silently dropping lines.
//
// Per the core design rule this function MUST NOT read or write
// material-lists data — the list arrives as a plain argument and its
// lines stay "need" regardless of what we persist here.
//
// Returns { created: [rfq], refreshed: [rfq], missingSupplier, missingSupplierLines }.
async function generateFromMaterialList(list, partsMap, supplierById) {
  const plan = planFromMaterialList(list, partsMap);
  const created = [];
  const refreshed = [];

  const lookupSupplier = (sid) => {
    if (!supplierById) return null;
    if (typeof supplierById.get === "function") return supplierById.get(sid) || null;
    return supplierById[sid] || null;
  };

  // Pass 1 — refresh existing drafts in a single read/modify/write so a
  // multi-supplier regenerate can't leave the store half-updated.
  const pendingCreates = [];
  const records = await readAll();
  let anyRefreshed = false;
  for (const group of plan.groups) {
    const idx = records.findIndex((r) =>
      r.status === "draft" &&
      r.sourceMaterialListId === list.id &&
      r.supplierId === String(group.supplierId)
    );
    if (idx === -1) {
      pendingCreates.push(group);
      continue;
    }
    const rec = records[idx];
    // Re-key map: keep an existing line's id when the SKU matches (first
    // occurrence wins; consumed so duplicate SKUs don't share an id).
    const idBySku = new Map();
    for (const l of rec.lines) {
      if (!idBySku.has(l.sku)) idBySku.set(l.sku, l.id);
    }
    rec.lines = group.lines.map((planLine) => {
      const reuseId = idBySku.get(planLine.sku);
      if (reuseId) idBySku.delete(planLine.sku);
      return hydrateLine(reuseId ? { ...planLine, id: reuseId } : planLine);
    });
    rec.updatedAt = nowIso();
    appendHistory(rec, { action: "regenerated", note: `${rec.lines.length} line${rec.lines.length === 1 ? "" : "s"} from ${list.id}` });
    records[idx] = rec;
    refreshed.push(rec);
    anyRefreshed = true;
  }
  if (anyRefreshed) await writeAll(records);

  // Pass 2 — create fresh drafts for pairs with no existing draft.
  // create() re-reads the store, so ids stay sequential after pass 1.
  for (const group of pendingCreates) {
    const supplier = lookupSupplier(group.supplierId) || {};
    const rec = await create({
      supplierId: group.supplierId,
      supplierName: supplier.name || "",
      supplierEmail: supplier.email || "",
      supplierContactName: supplier.contactName || "",
      supplierPhone: supplier.phone || "",
      supplierAddress: supplier.address || "",
      sourceMaterialListId: list.id,
      lines: group.lines
    });
    created.push(rec);
  }

  return {
    created,
    refreshed,
    missingSupplier: plan.missingSupplier,
    missingSupplierLines: plan.missingSupplierLines
  };
}

// ---- Status verbs ----------------------------------------------------

// Mark a draft as sent. Records the email send-state snapshot and the
// stored-document paths. Caller (server.js) is responsible for rendering
// the PDF + CSV, writing them under server/data/quote-requests/files/,
// and sending the email. Per the core rule the caller does NOT touch the
// source material list — its lines stay "need".
//
// `pdfPath` / `csvPath` are repo-relative paths. Once set on a sent RFQ
// they are IMMUTABLE — resend reads these files verbatim so the supplier
// always receives the same bytes.
async function markSent(id, { toEmail, toName, subject, pdfPath, csvPath } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const rec = records[idx];
  if (rec.status !== "draft") {
    throw new Error(`Can only send a draft quote request. This one is "${rec.status}".`);
  }
  if (!rec.lines.length) throw new Error("Can't send a quote request with no lines.");
  rec.status = "sent";
  rec.sentAt = nowIso();
  rec.emailedToEmail = String(toEmail || rec.supplierEmail || "").trim().toLowerCase();
  rec.emailedToName = String(toName || rec.supplierContactName || rec.supplierName || "");
  rec.emailSubject = String(subject || `Request for Quotation ${rec.id}`).slice(0, 200);
  rec.updatedAt = rec.sentAt;
  if (pdfPath) rec.pdfPath = String(pdfPath);
  if (csvPath) rec.csvPath = String(csvPath);
  if (pdfPath || csvPath) rec.documentsGeneratedAt = rec.sentAt;
  appendHistory(rec, { action: "sent", note: rec.emailedToEmail });
  records[idx] = rec;
  await writeAll(records);
  return rec;
}

// Mark a re-send event on a sent (or quoted) RFQ. Doesn't change status —
// just records that the frozen documents were re-emailed and snapshots
// the recipient if it changed. Caller re-attaches the stored files
// byte-identical; nothing is re-rendered.
async function markResent(id, { toEmail, toName, subject } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const rec = records[idx];
  if (rec.status !== "sent" && rec.status !== "quoted") {
    throw new Error(`Can only re-send a sent or quoted quote request. This one is "${rec.status}".`);
  }
  if (toEmail) rec.emailedToEmail = String(toEmail).trim().toLowerCase();
  if (toName) rec.emailedToName = String(toName);
  if (subject) rec.emailSubject = String(subject).slice(0, 200);
  rec.updatedAt = nowIso();
  appendHistory(rec, { action: "resent", note: rec.emailedToEmail });
  records[idx] = rec;
  await writeAll(records);
  return rec;
}

// Record the supplier's returned prices (Phase B quick-grid). Allowed on
// sent and quoted RFQs — never on a draft (you ask first, then record the
// reply) and never after apply/cancel. `priceByLineId` maps line id →
// integer cents, or null to clear a previously-entered price (partial
// quotes are normal: a vendor may only price some lines; apply later
// skips the null ones).
//
// Status follows the data: any priced line → "quoted" (quotedAt stamped
// on the transition), all prices cleared → back to "sent". Unknown line
// ids throw so a stale UI surfaces instead of silently dropping an entry.
async function recordQuotedPrices(id, priceByLineId = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const rec = records[idx];
  if (rec.status !== "sent" && rec.status !== "quoted") {
    throw new Error(`Can only record quoted prices on a sent or quoted request. This one is "${rec.status}".`);
  }
  if (!priceByLineId || typeof priceByLineId !== "object" || Array.isArray(priceByLineId)) {
    throw new Error("priceByLineId must be a { lineId: cents|null } map.");
  }
  const lineById = new Map(rec.lines.map((l) => [l.id, l]));
  for (const [lineId, raw] of Object.entries(priceByLineId)) {
    const line = lineById.get(lineId);
    if (!line) throw new Error(`Unknown line id ${lineId} on ${rec.id}.`);
    if (raw == null) {
      line.quotedPriceCents = null;
      continue;
    }
    // Reject junk BEFORE Number() — Number("")/Number(false)/Number([])
    // are all 0, which would silently record a $0 quote (the same
    // coercion trap as Number(null)). Only a number, or a non-empty
    // numeric string, may proceed to the cents checks.
    if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) {
      throw new Error(`Quoted price for ${line.sku} must be a whole number of cents or null (got ${JSON.stringify(raw)}).`);
    }
    const cents = Number(raw);
    if (!Number.isFinite(cents) || cents < 0 || !Number.isInteger(cents)) {
      throw new Error(`Quoted price for ${line.sku} must be a whole number of cents (got ${raw}).`);
    }
    line.quotedPriceCents = cents;
  }
  const pricedCount = rec.lines.filter((l) => l.quotedPriceCents != null).length;
  const wasQuoted = rec.status === "quoted";
  rec.status = pricedCount > 0 ? "quoted" : "sent";
  if (!wasQuoted && rec.status === "quoted") rec.quotedAt = nowIso();
  if (rec.status === "sent") rec.quotedAt = null;
  rec.updatedAt = nowIso();
  appendHistory(rec, {
    action: "prices_recorded",
    note: `${pricedCount} of ${rec.lines.length} line${rec.lines.length === 1 ? "" : "s"} priced`
  });
  records[idx] = rec;
  await writeAll(records);
  return rec;
}

// Mark a quoted RFQ as applied — the record-side half of apply-to-catalog.
// The CALLER (server.js) performs the actual catalog writes first, via the
// existing parts edit path (partsLib.update → rebuildCatalogFromOverrides
// → audit), then calls this to flip the status. Quoted-only, and the
// status guard is the double-apply protection: a second apply attempt
// throws instead of silently re-writing the catalog. Terminal —
// markCancelled also throws on applied.
async function markApplied(id, { appliedCount = 0, skippedSkus = [] } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const rec = records[idx];
  if (rec.status !== "quoted") {
    throw new Error(`Can only apply a quoted request. This one is "${rec.status}".`);
  }
  if (!(Number(appliedCount) >= 1)) {
    throw new Error("Nothing was applied — at least one quoted price must reach the catalog.");
  }
  rec.status = "applied";
  rec.appliedAt = nowIso();
  rec.updatedAt = rec.appliedAt;
  const skipped = Array.isArray(skippedSkus) && skippedSkus.length
    ? ` (skipped: ${skippedSkus.join(", ")})`
    : "";
  appendHistory(rec, {
    action: "applied",
    note: `${appliedCount} price${appliedCount === 1 ? "" : "s"} → catalog${skipped}`
  });
  records[idx] = rec;
  await writeAll(records);
  return rec;
}

// Cancel an RFQ. Allowed from draft / sent / quoted. Idempotent on an
// already-cancelled record (returns it, no error). Throws on applied —
// the quoted prices are already in the catalog at that point, so
// cancelling would misrepresent where the pricing came from. No source-
// line cleanup exists here by design: the material list never changed.
async function markCancelled(id, { reason = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const rec = records[idx];
  if (rec.status === "applied") {
    throw new Error("Can't cancel an applied quote request — its prices are already in the catalog.");
  }
  if (rec.status === "cancelled") return rec; // idempotent
  rec.status = "cancelled";
  rec.cancelledAt = nowIso();
  rec.cancelReason = String(reason || "").slice(0, 500);
  rec.updatedAt = rec.cancelledAt;
  appendHistory(rec, { action: "cancelled", note: rec.cancelReason });
  records[idx] = rec;
  await writeAll(records);
  return rec;
}

// Hard delete (admin cleanup). Mirrors purchase-orders.remove.
async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  list,
  get,
  create,
  update,
  planFromMaterialList,
  generateFromMaterialList,
  markSent,
  markResent,
  recordQuotedPrices,
  markApplied,
  markCancelled,
  remove
};

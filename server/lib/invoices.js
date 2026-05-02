// Invoices — drafted automatically by the WO completion cascade
// (spec §4.3.4). Local-only for now: ID, line items snapshotted from the
// WO, totals (subtotal + HST), status. QuickBooks sync is a future slice
// — when it lands, this module stores the QB invoice ID + sync timestamps
// alongside the local draft.
//
// ID format: I-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN and
// P-YYYY-NNNN for visual consistency.
//
// Status enum:
//   draft      — created by completion cascade, not yet sent
//   sent       — emailed to customer (or printed/handed over)
//   paid       — payment recorded
//   void       — cancelled (audit-trail kept)
//
// Storage: server/data/invoices.json. Same flat-file pattern; rotate
// to SQLite at ~10k.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "invoices.json");
const HST_RATE = 0.13;

const STATUSES = ["draft", "sent", "paid", "void"];

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

function hydrate(inv) {
  return {
    id: inv?.id || "",
    woId: inv?.woId || null,
    quoteId: inv?.quoteId || null,
    propertyId: inv?.propertyId || null,
    customerName: inv?.customerName || "",
    customerEmail: inv?.customerEmail || "",
    customerPhone: inv?.customerPhone || "",
    address: inv?.address || "",
    status: STATUSES.includes(inv?.status) ? inv.status : "draft",
    lineItems: Array.isArray(inv?.lineItems) ? inv.lineItems : [],
    subtotal: Number(inv?.subtotal) || 0,
    hst: Number(inv?.hst) || 0,
    total: Number(inv?.total) || 0,
    currency: inv?.currency || "CAD",
    notes: inv?.notes || "",
    quickbooksInvoiceId: inv?.quickbooksInvoiceId || null,
    sentAt: inv?.sentAt || null,
    paidAt: inv?.paidAt || null,
    voidedAt: inv?.voidedAt || null,
    createdAt: inv?.createdAt || new Date().toISOString(),
    updatedAt: inv?.updatedAt || new Date().toISOString(),
    history: Array.isArray(inv?.history) ? inv.history : []
  };
}

async function nextInvoiceId(year) {
  const records = await readAll();
  const prefix = `I-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Accepts either pre-normalized invoice lines (with `unitPrice` +
// `lineTotal`) OR raw on-site-quote builder lines (with `originalPrice`/
// `overridePrice`). Both shapes go through this function in different
// code paths so checking all three field names keeps the math right.
function totalsForLines(lines) {
  let subtotal = 0;
  for (const l of lines || []) {
    if (Number.isFinite(Number(l.lineTotal))) {
      subtotal += Number(l.lineTotal);
      continue;
    }
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice)
      : Number(l.originalPrice || l.price || l.unitPrice) || 0;
    subtotal += price * (Number(l.qty) || 1);
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
}

async function list() {
  return readAll();
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function listByWorkOrder(woId) {
  const records = await readAll();
  return records.filter((r) => r.woId === woId);
}

async function listByProperty(propertyId) {
  const records = await readAll();
  return records.filter((r) => r.propertyId === propertyId);
}

// Create a draft invoice from a WO's accepted quote line items. The
// `lineItems` shape is the on-site-quote builder shape (key/label/qty/
// originalPrice/overridePrice). Snapshotted at draft time — future
// pricing.json or quote changes don't alter this invoice.
async function createDraft({
  woId = null,
  quoteId = null,
  propertyId = null,
  customerName = "",
  customerEmail = "",
  customerPhone = "",
  address = "",
  lineItems = [],
  notes = ""
}) {
  const records = await readAll();
  const now = new Date().toISOString();
  const year = new Date().getUTCFullYear();
  const id = await nextInvoiceId(year);
  // Normalize line items into a consistent shape so the invoice page
  // doesn't have to know about builder vs accepted-quote variants.
  const normalized = (lineItems || []).map((l) => {
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice)
      : Number(l.originalPrice || l.price) || 0;
    const qty = Number(l.qty) || 1;
    return {
      key: l.key || null,
      label: l.label || (l.key ? l.key : "Line"),
      qty,
      unitPrice: Math.round(price * 100) / 100,
      lineTotal: Math.round(price * qty * 100) / 100,
      note: l.note || ""
    };
  });
  const totals = totalsForLines(normalized);
  const inv = hydrate({
    id,
    woId,
    quoteId,
    propertyId,
    customerName,
    customerEmail,
    customerPhone,
    address,
    status: "draft",
    lineItems: normalized,
    subtotal: totals.subtotal,
    hst: totals.hst,
    total: totals.total,
    notes,
    createdAt: now,
    updatedAt: now,
    history: [{ ts: now, action: "draft_created", by: "system", note: woId ? `From WO ${woId}` : "" }]
  });
  records.unshift(inv);
  await writeAll(records);
  return inv;
}

async function update(id, patch) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };
  const allowed = ["status", "notes", "quickbooksInvoiceId", "customerName", "customerEmail", "customerPhone", "address"];
  for (const key of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (patch && Array.isArray(patch.lineItems)) {
    next.lineItems = patch.lineItems;
    const totals = totalsForLines(next.lineItems);
    next.subtotal = totals.subtotal;
    next.hst = totals.hst;
    next.total = totals.total;
  }
  if (patch && patch.status === "sent" && !current.sentAt) next.sentAt = new Date().toISOString();
  if (patch && patch.status === "paid" && !current.paidAt) next.paidAt = new Date().toISOString();
  if (patch && patch.status === "void" && !current.voidedAt) next.voidedAt = new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  if (patch && patch.status && patch.status !== current.status) {
    next.history = [...(next.history || []), {
      ts: next.updatedAt, action: `status:${patch.status}`, by: patch.by || "admin", note: patch.note || ""
    }];
  }
  records[idx] = next;
  await writeAll(records);
  return next;
}

module.exports = {
  STATUSES,
  HST_RATE,
  list,
  get,
  listByWorkOrder,
  listByProperty,
  createDraft,
  update
};

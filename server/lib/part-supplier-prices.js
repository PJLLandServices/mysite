// Per-supplier part prices — the same part costs different money
// depending on who we buy it from.
//
// The catalog carries ONE priceCents per SKU, which was fine while every
// part had one supplier. Once the same material list is shopped to two
// suppliers (SiteOne and Central Pro both quote a #12 clamp), a single
// price field can only ever hold the last quote applied — the other
// number is lost. This module stores EVERY supplier's price for a SKU
// side by side; the catalog's own priceCents becomes a derived value.
//
// Storage: server/data/part-supplier-prices.json. Shape:
//   {
//     "SSC8712": {
//       "SUP-001": { "priceCents": 63,  "supplierSku": "SC7712",  "source": "RFQ-2026-0004", "at": "<ISO>" },
//       "SUP-002": { "priceCents": 167, "supplierSku": "SSC8712", "source": "RFQ-2026-0005", "at": "<ISO>" }
//     }
//   }
//
// SUPPLIER PART NUMBERS. The same part is catalogued under a different
// number at each branch — our DS100C is SiteOne's KT010C and Central's
// 100C — but only for SOME parts; plenty match. supplierSku holds theirs
// when it differs or is simply known, and stays absent otherwise, so
// anything printed for a supplier can show the number THEY recognise and
// fall back to ours when we don't have one.
//
// WHICH PRICE THE CATALOG SHOWS (Patrick's ruling, Sept 2026): the
// PRIMARY supplier's. part-suppliers.json holds an ordered supplierIds[]
// per SKU and its first entry is the primary, so mergeIntoCatalog copies
// that supplier's price onto part.priceCents. Every other supplier's
// price rides along in part.supplierPrices for the UI to show. Changing
// which supplier is primary therefore re-prices the part automatically —
// no re-apply needed.
//
// MANUAL EDITS WIN. A price typed into the catalog page writes
// parts-overrides.json with an editedAt stamp. If that stamp is NEWER
// than the supplier price's own `at`, the typed price stays — otherwise
// a later quote would silently undo a correction Patrick made by hand.
//
// Same atomic-write and stable-key-order discipline as its siblings
// (part-suppliers.js, quote-requests.js): a crash mid-write can't leave
// a truncated catalog-pricing file.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "part-supplier-prices.json");

function nowIso() { return new Date().toISOString(); }

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "{}\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Atomic write: stage to .tmp, fsync, rename.
async function writeAll(map) {
  await ensureFile();
  const sorted = {};
  for (const sku of Object.keys(map).sort()) {
    const bySupplier = map[sku] || {};
    const inner = {};
    for (const supplierId of Object.keys(bySupplier).sort()) inner[supplierId] = bySupplier[supplierId];
    if (Object.keys(inner).length) sorted[sku] = inner;
  }
  const json = JSON.stringify(sorted, null, 2) + "\n";
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

async function getAll() {
  return readAll();
}

function normalizeSupplierSku(raw) {
  const value = String(raw == null ? "" : raw).trim();
  return value ? value.slice(0, 64) : null;
}

function normalizeCents(raw) {
  if (raw == null) return null;
  const cents = Number(raw);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return Math.round(cents);
}

// Record one supplier's prices (and their own part numbers) for many
// SKUs in a single write. `bySku` is { sku: cents } or
// { sku: { priceCents, supplierSku } } — mix freely. Returns what
// actually moved so the caller can audit it: { recorded: [{sku,
// fromCents, toCents, fromSupplierSku, toSupplierSku}], unchanged:
// [sku] }. Callers filter out unknown SKUs first — this module knows
// nothing about the catalog.
async function recordSupplierPrices(supplierId, bySku = {}, { source = null, at = null } = {}) {
  const id = String(supplierId || "").trim();
  if (!id) throw new Error("supplierId required");
  const stamp = at || nowIso();
  const map = await readAll();
  const recorded = [];
  const unchanged = [];
  for (const [sku, raw] of Object.entries(bySku)) {
    // Each entry is either a bare cents value or { priceCents,
    // supplierSku } — callers that only know the price stay one-liners.
    const entry = raw && typeof raw === "object" ? raw : { priceCents: raw };
    const cents = normalizeCents(entry.priceCents);
    const supplierSku = normalizeSupplierSku(entry.supplierSku);
    if (cents == null && supplierSku == null) continue;
    const key = String(sku || "").trim();
    if (!key) continue;
    const existing = (map[key] && map[key][id]) || null;
    const fromCents = existing ? normalizeCents(existing.priceCents) : null;
    const fromSku = existing ? normalizeSupplierSku(existing.supplierSku) : null;
    // A price-only write keeps the part number already on file, and the
    // reverse: recording "their number is SC7712" never clears the price.
    const toCents = cents == null ? fromCents : cents;
    const toSku = supplierSku == null ? fromSku : supplierSku;
    if (toCents === fromCents && toSku === fromSku) { unchanged.push(key); continue; }
    if (!map[key]) map[key] = {};
    const rec = { priceCents: toCents, source, at: stamp };
    if (toSku) rec.supplierSku = toSku;
    map[key][id] = rec;
    recorded.push({ sku: key, fromCents, toCents, fromSupplierSku: fromSku, toSupplierSku: toSku });
  }
  if (recorded.length) await writeAll(map);
  return { recorded, unchanged };
}

// The supplier's own number for a part, when we know it. Everything that
// prints for a supplier (RFQ, PO) should ask through this so an unknown
// one falls back to our SKU rather than printing a blank.
function supplierSkuFor(priceMap, sku, supplierId, fallback = null) {
  const rec = priceMap && priceMap[sku] && priceMap[sku][supplierId];
  const theirs = rec ? normalizeSupplierSku(rec.supplierSku) : null;
  return theirs || fallback;
}

// Drop one supplier's price for a SKU (e.g. a part we no longer buy
// there). Returns true when something was removed.
async function clearSupplierPrice(sku, supplierId) {
  const map = await readAll();
  const key = String(sku || "").trim();
  const id = String(supplierId || "").trim();
  if (!map[key] || !map[key][id]) return false;
  delete map[key][id];
  if (!Object.keys(map[key]).length) delete map[key];
  await writeAll(map);
  return true;
}

// Layer supplier prices onto an already-merged catalog. Runs AFTER
// part-suppliers.mergeIntoCatalog, because the primary supplier is
// supplierIds[0] and that is what decides the effective price.
//
// Sets on every part:
//   supplierPrices   { supplierId: { priceCents, supplierSku?, source, at } }
//   priceSupplierId  the supplier whose price is currently showing (or null)
//
// `editedMap` is parts-overrides.json's `edited` block — a hand-typed
// price newer than the quote keeps its place.
function mergeIntoCatalog(parts, priceMap = {}, { editedMap = {} } = {}) {
  if (!parts || typeof parts !== "object") return;
  for (const [sku, part] of Object.entries(parts)) {
    if (!part || typeof part !== "object") continue;
    const bySupplier = priceMap[sku];
    if (!bySupplier || typeof bySupplier !== "object") {
      part.supplierPrices = {};
      part.priceSupplierId = null;
      continue;
    }
    const clean = {};
    for (const [supplierId, rec] of Object.entries(bySupplier)) {
      const cents = normalizeCents(rec && rec.priceCents);
      if (cents == null) continue;
      const entry = { priceCents: cents, source: (rec && rec.source) || null, at: (rec && rec.at) || null };
      const theirSku = normalizeSupplierSku(rec && rec.supplierSku);
      if (theirSku) entry.supplierSku = theirSku;
      clean[supplierId] = entry;
    }
    part.supplierPrices = clean;
    part.priceSupplierId = null;

    const primary = Array.isArray(part.supplierIds) && part.supplierIds.length ? part.supplierIds[0] : null;
    const chosen = primary && clean[primary] ? clean[primary] : null;
    if (!chosen) continue;

    // A price typed by hand after this quote landed stays put.
    const edit = editedMap && editedMap[sku];
    const editedCents = edit ? normalizeCents(edit.priceCents) : null;
    if (editedCents != null && edit.editedAt && chosen.at && String(edit.editedAt) > String(chosen.at)) {
      part.priceSupplierId = null;
      continue;
    }
    part.priceCents = chosen.priceCents;
    part.priceSupplierId = primary;
  }
}

// One-time seed so the store doesn't start empty on a system that has
// already been applying quotes into the single price field. Builds the
// map from every RFQ that reached "applied" — those prices were, by
// definition, the catalog's at some point. Quoted-but-not-applied RFQs
// are deliberately skipped: recording them here would move catalog
// prices without anyone pressing apply.
function seedFromAppliedQuoteRequests(records = []) {
  const map = {};
  const applied = records
    .filter((r) => r && r.status === "applied" && r.supplierId)
    .sort((a, b) => String(a.appliedAt || a.updatedAt || "").localeCompare(String(b.appliedAt || b.updatedAt || "")));
  for (const rfq of applied) {
    for (const line of rfq.lines || []) {
      const cents = normalizeCents(line && line.quotedPriceCents);
      if (cents == null || !line.sku) continue;
      if (!map[line.sku]) map[line.sku] = {};
      map[line.sku][rfq.supplierId] = {
        priceCents: cents,
        source: rfq.id,
        at: rfq.appliedAt || rfq.updatedAt || nowIso()
      };
    }
  }
  return map;
}

async function seedIfEmpty(records = []) {
  if (fsSync.existsSync(FILE)) return { seeded: false, skus: 0 };
  const map = seedFromAppliedQuoteRequests(records);
  await writeAll(map);
  return { seeded: true, skus: Object.keys(map).length };
}

module.exports = {
  FILE,
  getAll,
  recordSupplierPrices,
  supplierSkuFor,
  clearSupplierPrice,
  mergeIntoCatalog,
  seedFromAppliedQuoteRequests,
  seedIfEmpty
};

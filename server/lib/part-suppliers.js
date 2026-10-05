// Per-part supplier overrides — Phase 3.
//
// parts.json carries `supplierIds: []` on every part as a placeholder
// (added in Phase 1) but the catalog file is human-curated for hardware
// spec; rewriting it from the admin UI would either fight its
// column-aligned formatting OR force JSON.stringify-shaped output that
// loses alignment. So this module owns supplier assignments separately.
//
// Storage: server/data/part-suppliers.json. Shape:
//   {
//     "POPO100300": ["SUP-001"],
//     "HSPROS04PRS30": ["SUP-002", "SUP-001"],
//     ...
//   }
// First entry is the PRIMARY supplier (default for PO grouping). Subsequent
// entries are alternates (manually picked at PO time when the primary is
// out-of-stock). Empty array = no supplier assigned, which blocks PO
// generation for any line referencing that SKU.
//
// /api/parts merges this map into its catalog response so consumers see
// the effective supplierIds[] without knowing about this file.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "part-suppliers.json");

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
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAll(map) {
  await ensureFile();
  // Stable key order keeps diffs readable when committed by mistake.
  const sorted = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  await fs.writeFile(FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

// Read the full override map. Used by /api/parts to merge.
async function getAll() {
  return readAll();
}

// Set the supplierIds[] for a single SKU. `ids` is an array; first entry
// is the primary. Empty array deletes the assignment (so the SKU falls
// back to whatever's in parts.json's supplierIds — typically empty too).
async function setForSku(sku, ids) {
  if (!sku || typeof sku !== "string") throw new Error("sku required");
  const map = await readAll();
  const cleaned = (Array.isArray(ids) ? ids : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  // Dedupe while preserving order — the first occurrence wins (so the
  // primary stays primary if duplicates were sent).
  const seen = new Set();
  const deduped = [];
  for (const id of cleaned) {
    if (!seen.has(id)) { seen.add(id); deduped.push(id); }
  }
  if (deduped.length === 0) {
    delete map[sku];
  } else {
    map[sku] = deduped;
  }
  await writeAll(map);
  return deduped;
}

// Bulk update — accepts a partial map (only the SKUs to change). Used by
// the catalog-assignment grid to write multiple changes in one round-trip.
// Pass an empty array for a SKU to clear its assignment.
async function bulkSet(updates) {
  if (!updates || typeof updates !== "object") throw new Error("updates map required");
  const map = await readAll();
  for (const [sku, ids] of Object.entries(updates)) {
    const cleaned = (Array.isArray(ids) ? ids : []).map((x) => String(x || "").trim()).filter(Boolean);
    const seen = new Set();
    const deduped = [];
    for (const id of cleaned) {
      if (!seen.has(id)) { seen.add(id); deduped.push(id); }
    }
    if (deduped.length === 0) delete map[sku];
    else map[sku] = deduped;
  }
  await writeAll(map);
  return map;
}

// ---- Choosing the DEFAULT supplier (Patrick, 2026-10-05) -----------------
//
// "Make this supplier the default" is its own operation, and it is the only
// one the Suppliers page uses. It REORDERS: the chosen supplier moves to
// the front and every other supplier the part already has keeps its place
// behind it. It never drops an alternate — a part that is one fitting with
// two suppliers' offers must survive someone touching its dropdown.
// (setForSku / bulkSet above replace the whole list and are for callers
// that mean exactly that: the API and migrations.)
//
// The rule, once: withPrimary(current, supplierId).
//   supplierId given  → [supplierId, ...current without it]
//   supplierId empty  → [] when the part has at most one supplier (plain
//                       "unassign"); REFUSED when it has alternates, because
//                       clearing the default would silently promote or lose
//                       one of them — the caller must pick which is default.
function withPrimary(current, supplierId) {
  const ids = [];
  for (const x of Array.isArray(current) ? current : []) {
    const id = String(x || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  const chosen = String(supplierId || "").trim();
  if (!chosen) {
    if (ids.length > 1) {
      throw Object.assign(
        new Error(`This part has ${ids.length} suppliers. Pick which one is the default instead of clearing it.`),
        { code: "alternates_present", supplierIds: ids }
      );
    }
    return [];
  }
  return [chosen, ...ids.filter((id) => id !== chosen)];
}

// Set the default supplier for many SKUs in one write. `primaries` is
// { sku: supplierId | "" }. `currentFor(sku)` supplies the part's effective
// supplier list when the override map has no entry for it (the catalog's own
// value). All-or-nothing: one refused SKU writes nothing.
async function setPrimaryBulk(primaries, { currentFor } = {}) {
  if (!primaries || typeof primaries !== "object") throw new Error("primary map required");
  const map = await readAll();
  const next = {};
  for (const [sku, supplierId] of Object.entries(primaries)) {
    const current = Array.isArray(map[sku]) && map[sku].length
      ? map[sku]
      : (typeof currentFor === "function" ? currentFor(sku) : []);
    try { next[sku] = withPrimary(current, supplierId); }
    catch (err) { err.message = `${sku}: ${err.message}`; err.sku = sku; throw err; }
  }
  for (const [sku, ids] of Object.entries(next)) {
    if (ids.length === 0) delete map[sku];
    else map[sku] = ids;
  }
  await writeAll(map);
  return map;
}

// Merge the override map into a parts catalog. Mutates parts in-place
// (faster than copy-on-write at PJL catalog scale; called server-side
// only). Returns the same parts object for chaining.
//
// Effective supplierIds priority: override map > parts.json field > [].
function mergeIntoCatalog(parts, overrideMap) {
  if (!parts || typeof parts !== "object") return parts;
  for (const sku of Object.keys(parts)) {
    const part = parts[sku];
    if (!part) continue;
    const override = overrideMap && overrideMap[sku];
    if (Array.isArray(override) && override.length) {
      part.supplierIds = override.slice();
    } else if (!Array.isArray(part.supplierIds)) {
      part.supplierIds = [];
    }
    // If override is missing or empty, fall back to whatever was on the
    // catalog (which may also be empty — caller will see []).
  }
  return parts;
}

module.exports = {
  getAll,
  setForSku,
  bulkSet,
  withPrimary,
  setPrimaryBulk,
  mergeIntoCatalog
};

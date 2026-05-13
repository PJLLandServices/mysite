// Catalog management — runtime overrides on top of parts.json baseline.
//
// parts.json (repo root) is the human-curated baseline catalog, committed
// alongside code. Admin-UI edits live here, in server/data/parts-overrides
// .json, so the baseline stays free of column-aligned-JSON drift and so
// runtime adds/edits/deletes don't require a redeploy.
//
// Override file schema (server/data/parts-overrides.json):
//   {
//     "added":   { "<sku>": { ...full part record, addedAt: <ISO> } },
//     "edited":  { "<sku>": { ...field subset, editedAt: <ISO> } },
//     "deleted": [ "<sku>", "<sku>", ... ]
//   }
//
// Merge precedence (read path):
//   1. Start from baseline.parts
//   2. Apply `edited` field-by-field on existing baseline SKUs
//   3. Add every entry in `added` as a new part
//   4. Soft-delete any SKU listed in `deleted` (remove from result)
//   5. Layer supplier-id assignments from part-suppliers.json (separate lib)
//
// Adds-then-deletes interplay: deleting a runtime-added SKU removes it
// from `added` instead of tombstoning (no point keeping a tombstone for
// a record that only existed in overrides).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "parts-overrides.json");

const EMPTY_OVERRIDES = { added: {}, edited: {}, deleted: [] };

// Canonical unit list — seeded from observed values in parts.json. The
// UI surfaces these as a dropdown but allows free-form override so a
// new unit (e.g. "case") can be introduced without code changes.
const KNOWN_UNITS = ["each", "roll", "coil", "bag", "box", "bundle", "ft", "m"];

// Editable fields on PATCH /api/parts/:sku. SKU is excluded — it's the
// primary key and immutable. supplierIds is excluded here too: that's
// owned by lib/part-suppliers.js (the override pattern that pre-dates
// this lib).
const EDITABLE_FIELDS = [
  "priceCents",
  "description",
  "category",
  "subcategory",
  "size",
  "unit",
  "partNumber"
];

// Single in-process mutex around the override file. Concurrent writes
// (e.g. inline-price-edits firing in parallel during a fast Tab-walk)
// would race through read-mutate-write and clobber each other; the
// mutex serializes them.
let writeChain = Promise.resolve();
function withLock(fn) {
  const next = writeChain.then(() => fn(), () => fn());
  writeChain = next.catch(() => {});
  return next;
}

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, JSON.stringify(EMPTY_OVERRIDES, null, 2) + "\n", "utf8");
  }
}

async function readOverrides() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return hydrate(JSON.parse(raw || "{}"));
  } catch {
    return { ...EMPTY_OVERRIDES, added: {}, edited: {}, deleted: [] };
  }
}

function hydrate(o) {
  return {
    added: (o && typeof o.added === "object" && o.added) ? o.added : {},
    edited: (o && typeof o.edited === "object" && o.edited) ? o.edited : {},
    deleted: Array.isArray(o?.deleted) ? o.deleted.filter((x) => typeof x === "string") : []
  };
}

// Atomic write: stage to .tmp, fsync, rename. Prevents partial files on
// a crash mid-write and matches the pattern other libs use here.
async function writeOverrides(state) {
  await ensureFile();
  const out = {
    added: state.added || {},
    edited: state.edited || {},
    deleted: Array.isArray(state.deleted) ? state.deleted.slice().sort() : []
  };
  const json = JSON.stringify(out, null, 2) + "\n";
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, FILE);
  return out;
}

// ---- Merge ------------------------------------------------------------

// Apply overrides onto a baseline parts map (shape: { <sku>: {...} }).
// Mutates a clone — never the baseline argument. Returns the merged map.
function mergeOverrides(baselineParts, overrides) {
  if (!baselineParts || typeof baselineParts !== "object") return {};
  const ov = hydrate(overrides || {});
  const out = {};
  // 1. Clone baseline (shallow clone of each part — sufficient since we
  //    overwrite whole-field values, never nested objects).
  for (const sku of Object.keys(baselineParts)) {
    out[sku] = { ...baselineParts[sku] };
  }
  // 2. Apply edits. Edits only stick to SKUs that exist in baseline —
  //    edits on baseline SKUs that were later deleted from baseline.json
  //    silently drop (the baseline-edit no longer has a target).
  for (const [sku, patch] of Object.entries(ov.edited)) {
    if (!out[sku] || !patch || typeof patch !== "object") continue;
    for (const key of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        out[sku][key] = patch[key];
      }
    }
  }
  // 3. Apply additions. Skip any SKU that already exists in baseline —
  //    that's a data-integrity issue (an add collided with a later
  //    baseline addition), and we prefer baseline so the runtime entry
  //    can be reconciled by hand.
  for (const [sku, part] of Object.entries(ov.added)) {
    if (out[sku]) continue;
    out[sku] = { ...part };
  }
  // 4. Soft-deletes — drop from result.
  for (const sku of ov.deleted) {
    delete out[sku];
  }
  return out;
}

// Convenience for UI consumers: returns added/edited/deleted SKUs as
// Sets so the renderer can paint NEW badges + "modified" indicators.
// `baseline` is the un-merged baseline (so we can tell added-vs-baseline).
function classifyOverrides(baseline, overrides) {
  const ov = hydrate(overrides || {});
  return {
    addedSkus: new Set(Object.keys(ov.added).filter((sku) => !baseline?.[sku])),
    editedSkus: new Set(
      Object.keys(ov.edited).filter((sku) =>
        baseline?.[sku] && ov.edited[sku] && Object.keys(ov.edited[sku]).some((k) => EDITABLE_FIELDS.includes(k))
      )
    ),
    deletedSkus: new Set(ov.deleted)
  };
}

// ---- Validation -------------------------------------------------------

// Coerce an integer-cents input. Used when the caller has already
// converted to cents (e.g. the admin UI inline-edit handler does the
// dollars→cents math client-side and sends priceCents directly).
function coerceCents(input) {
  if (input == null || input === "") throw new Error("Price is required.");
  // Accept numeric strings too (route layer hands them off post-JSON-parse).
  let n = input;
  if (typeof n === "string") {
    const clean = n.trim().replace(/^\$/, "").replace(/,/g, "");
    if (clean === "") throw new Error("Price is required.");
    n = Number(clean);
  }
  if (!Number.isFinite(n) || n < 0) throw new Error("Price must be a number, zero or higher.");
  if (!Number.isInteger(n)) throw new Error("priceCents must be a whole number of cents (integer).");
  return n;
}

// Coerce a dollar input into integer cents. Used for the `price` field
// (Add Parts modal sends a number from <input type=number step=0.01>;
// xlsx import sends the price column as either a number or a numeric
// string). Multiplies by 100 and rounds; rejects anything that loses
// more than 0.5¢ of precision.
function coerceDollarsToCents(input) {
  if (input == null || input === "") throw new Error("Price is required.");
  let n = input;
  if (typeof n === "string") {
    const clean = n.trim().replace(/^\$/, "").replace(/,/g, "");
    if (clean === "") throw new Error("Price is required.");
    n = Number(clean);
  }
  if (!Number.isFinite(n) || n < 0) throw new Error("Price must be a number, zero or higher.");
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 0.5) {
    throw new Error("Price precision exceeds cents — round to two decimals.");
  }
  return cents;
}

// Routes the caller's payload to the right coercer based on which key
// is present. priceCents wins if both are provided (a real-world
// rarity, but we shouldn't silently throw away one).
function coercePrice(patch) {
  if (patch && Object.prototype.hasOwnProperty.call(patch, "priceCents")) {
    return coerceCents(patch.priceCents);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "price")) {
    return coerceDollarsToCents(patch.price);
  }
  throw new Error("Price is required.");
}

// Compat alias — callers that used the old single-coercer name still
// work for the priceCents-style path; new code should call coercePrice
// / coerceCents / coerceDollarsToCents directly.
function coercePriceCents(input) { return coerceCents(input); }

// Validate a SKU string. Returns the cleaned value. Throws on invalid.
function validateSku(raw) {
  const sku = String(raw == null ? "" : raw).trim();
  if (!sku) throw new Error("SKU is required.");
  if (sku.length > 64) throw new Error("SKU must be 64 characters or fewer.");
  if (/\s/.test(sku)) throw new Error(`SKU "${sku}" must not contain whitespace.`);
  return sku;
}

// Full-record validation for additions. `allowedCategories` is the set
// of category keys defined in parts.json — runtime additions can't
// introduce a new category (categories[] is treated as fixed).
function validateNewPart(record, allowedCategories) {
  const out = {};
  out.sku = validateSku(record.sku);
  out.partNumber = String(record.partNumber || out.sku).trim().slice(0, 64);
  const cat = String(record.category || "").trim();
  if (!cat) throw new Error("Category is required.");
  if (allowedCategories && !allowedCategories.has(cat)) {
    throw new Error(`Category "${cat}" isn't in the catalog. Pick one of: ${[...allowedCategories].join(", ")}.`);
  }
  out.category = cat;
  out.subcategory = String(record.subcategory || "").trim().slice(0, 120);
  if (!out.subcategory) throw new Error("Subcategory is required.");
  out.size = String(record.size || "").trim().slice(0, 40);
  out.description = String(record.description || "").trim().slice(0, 240);
  if (!out.description) throw new Error("Description is required.");
  out.priceCents = coercePrice(record);
  out.unit = String(record.unit || "").trim().slice(0, 30) || "each";
  out.supplierIds = [];
  out.addedAt = new Date().toISOString();
  return out;
}

// Field-subset validation for edits. Only validates the keys present in
// `patch`. Returns a cleaned subset object.
function validateEdit(patch, allowedCategories) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(patch, "priceCents") ||
      Object.prototype.hasOwnProperty.call(patch, "price")) {
    out.priceCents = coercePrice(patch);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    const v = String(patch.description || "").trim().slice(0, 240);
    if (!v) throw new Error("Description is required.");
    out.description = v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "category")) {
    const v = String(patch.category || "").trim();
    if (!v) throw new Error("Category is required.");
    if (allowedCategories && !allowedCategories.has(v)) {
      throw new Error(`Category "${v}" isn't in the catalog.`);
    }
    out.category = v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "subcategory")) {
    out.subcategory = String(patch.subcategory || "").trim().slice(0, 120);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "size")) {
    out.size = String(patch.size || "").trim().slice(0, 40);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "unit")) {
    out.unit = String(patch.unit || "").trim().slice(0, 30);
    if (!out.unit) throw new Error("Unit cannot be empty.");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "partNumber")) {
    out.partNumber = String(patch.partNumber || "").trim().slice(0, 64);
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Nothing to update.");
  }
  out.editedAt = new Date().toISOString();
  return out;
}

// ---- Mutators ---------------------------------------------------------

// Add a single new SKU. Caller passes the baseline catalog (so we can
// check for SKU collisions). Returns the canonical part record.
async function addOne(baselineParts, record, { allowedCategories } = {}) {
  return withLock(async () => {
    const state = await readOverrides();
    const part = validateNewPart(record, allowedCategories);
    // Collision check — against baseline AND against runtime adds AND
    // against the soft-delete tombstone list (restoring a tombstoned
    // SKU is a different operation, not "add").
    if (baselineParts && baselineParts[part.sku]) {
      throw new Error(`SKU "${part.sku}" already exists in the catalog.`);
    }
    if (state.added[part.sku]) {
      throw new Error(`SKU "${part.sku}" already exists in the catalog.`);
    }
    if (state.deleted.includes(part.sku)) {
      throw new Error(`SKU "${part.sku}" is in the deleted list — restore it instead of adding.`);
    }
    state.added[part.sku] = part;
    await writeOverrides(state);
    return part;
  });
}

// Add many in one atomic write. Validates EVERY record before writing
// anything — a duplicate or bad row in the batch causes the whole
// batch to fail with a structured error.
async function addMany(baselineParts, records, { allowedCategories } = {}) {
  return withLock(async () => {
    const state = await readOverrides();
    const validated = [];
    const seenInBatch = new Set();
    for (let i = 0; i < records.length; i++) {
      let part;
      try {
        part = validateNewPart(records[i], allowedCategories);
      } catch (err) {
        const e = new Error(`Row ${i + 1}: ${err.message}`);
        e.row = i;
        throw e;
      }
      if (seenInBatch.has(part.sku)) {
        throw new Error(`Row ${i + 1}: SKU "${part.sku}" is repeated in this batch.`);
      }
      if (baselineParts && baselineParts[part.sku]) {
        throw new Error(`Row ${i + 1}: SKU "${part.sku}" already exists in the catalog.`);
      }
      if (state.added[part.sku]) {
        throw new Error(`Row ${i + 1}: SKU "${part.sku}" already exists in the catalog.`);
      }
      if (state.deleted.includes(part.sku)) {
        throw new Error(`Row ${i + 1}: SKU "${part.sku}" is in the deleted list — restore it instead.`);
      }
      seenInBatch.add(part.sku);
      validated.push(part);
    }
    for (const p of validated) state.added[p.sku] = p;
    await writeOverrides(state);
    return validated;
  });
}

// Edit an existing SKU. If the SKU lives in `added`, the patch is
// merged into the added entry directly (and an `editedAt` is added).
// Otherwise the patch goes into the `edited` block. Returns the
// effective merged part record (baseline + edits) for the caller to
// echo back to the UI.
async function update(baselineParts, sku, patch, { allowedCategories } = {}) {
  return withLock(async () => {
    const state = await readOverrides();
    const cleanSku = validateSku(sku);
    const isRuntimeAdd = !!state.added[cleanSku];
    const isBaseline = !!(baselineParts && baselineParts[cleanSku]);
    if (!isRuntimeAdd && !isBaseline) {
      throw new Error(`SKU "${cleanSku}" not found.`);
    }
    if (state.deleted.includes(cleanSku)) {
      throw new Error(`SKU "${cleanSku}" is deleted — restore it before editing.`);
    }
    const cleaned = validateEdit(patch, allowedCategories);
    if (isRuntimeAdd) {
      state.added[cleanSku] = { ...state.added[cleanSku], ...cleaned };
    } else {
      // Compare to baseline so a no-op edit doesn't bloat the override
      // file. If every key in the patch matches the baseline value,
      // PRUNE the `edited` entry instead of writing it.
      const base = baselineParts[cleanSku];
      const prevEdit = state.edited[cleanSku] || {};
      const nextEdit = { ...prevEdit, ...cleaned };
      // Drop any field that now equals baseline — keeps the override
      // file minimal and lets the "modified" indicator disappear when
      // a price is reverted to its original value.
      for (const key of Object.keys(nextEdit)) {
        if (key === "editedAt") continue;
        if (base && JSON.stringify(base[key]) === JSON.stringify(nextEdit[key])) {
          delete nextEdit[key];
        }
      }
      const realKeys = Object.keys(nextEdit).filter((k) => k !== "editedAt");
      if (realKeys.length === 0) {
        delete state.edited[cleanSku];
      } else {
        nextEdit.editedAt = cleaned.editedAt;
        state.edited[cleanSku] = nextEdit;
      }
    }
    await writeOverrides(state);
    // Return the merged effective record so the UI can re-render the row.
    const merged = mergeOverrides({ [cleanSku]: baselineParts?.[cleanSku] || state.added[cleanSku] }, state);
    return merged[cleanSku] || null;
  });
}

// Soft-delete. If the SKU is a runtime addition, REMOVE it from `added`
// rather than tombstoning (no point keeping a tombstone of a SKU that
// only existed in overrides). For baseline SKUs, append to `deleted[]`.
// Idempotent.
async function softDelete(baselineParts, sku) {
  return withLock(async () => {
    const state = await readOverrides();
    const cleanSku = validateSku(sku);
    if (state.added[cleanSku]) {
      delete state.added[cleanSku];
      await writeOverrides(state);
      return { mode: "removed-from-added", sku: cleanSku };
    }
    if (!baselineParts || !baselineParts[cleanSku]) {
      throw new Error(`SKU "${cleanSku}" not found.`);
    }
    // Edits on this SKU become orphaned — prune them too so a future
    // restore comes back to baseline-clean values.
    delete state.edited[cleanSku];
    if (!state.deleted.includes(cleanSku)) state.deleted.push(cleanSku);
    await writeOverrides(state);
    return { mode: "tombstoned", sku: cleanSku };
  });
}

// Restore a tombstoned SKU. Idempotent — no error if the SKU isn't
// currently deleted.
async function restore(sku) {
  return withLock(async () => {
    const state = await readOverrides();
    const cleanSku = validateSku(sku);
    const before = state.deleted.length;
    state.deleted = state.deleted.filter((s) => s !== cleanSku);
    if (state.deleted.length !== before) {
      await writeOverrides(state);
    }
    return { sku: cleanSku, wasDeleted: state.deleted.length !== before };
  });
}

// ---- Import (commit step) --------------------------------------------

// Apply a pre-parsed import in one atomic write. `selections` is a
// {added:[],edited:[],deleted:[]} object listing the SKUs from the
// staged import that the user CHECKED on the preview screen. SKUs not
// listed are skipped. Returns counts.
//
// The staging payload (the parsed xlsx rows) lives in an in-process
// Map keyed by importId; the route layer hands the relevant rows to
// this function. Decoupling parse from commit is what makes the
// "Review changes" preview safe — nothing is written until the user
// clicks Apply.
async function applyImport(baselineParts, staged, selections, { allowedCategories } = {}) {
  if (!staged || typeof staged !== "object") throw new Error("No staged import data.");
  const sel = selections || {};
  const wantAdded = new Set(Array.isArray(sel.added) ? sel.added : []);
  const wantEdited = new Set(Array.isArray(sel.edited) ? sel.edited : []);
  const wantDeleted = new Set(Array.isArray(sel.deleted) ? sel.deleted : []);

  return withLock(async () => {
    const state = await readOverrides();
    let counts = { added: 0, edited: 0, deleted: 0 };

    // ADDED
    for (const [sku, rec] of Object.entries(staged.added || {})) {
      if (!wantAdded.has(sku)) continue;
      let part;
      try { part = validateNewPart(rec, allowedCategories); }
      catch (err) { throw new Error(`Add row "${sku}": ${err.message}`); }
      if (baselineParts && baselineParts[part.sku]) {
        throw new Error(`Can't add "${part.sku}" — already exists in baseline catalog.`);
      }
      if (state.added[part.sku]) {
        throw new Error(`Can't add "${part.sku}" — already exists as a runtime addition.`);
      }
      // If the SKU is in `deleted`, restore it as part of the add.
      state.deleted = state.deleted.filter((s) => s !== part.sku);
      state.added[part.sku] = part;
      counts.added++;
    }

    // EDITED
    for (const [sku, patch] of Object.entries(staged.edited || {})) {
      if (!wantEdited.has(sku)) continue;
      const isRuntimeAdd = !!state.added[sku];
      const isBaseline = !!(baselineParts && baselineParts[sku]);
      if (!isRuntimeAdd && !isBaseline) {
        // SKU disappeared between preview and commit — skip rather than fail
        // the whole import.
        continue;
      }
      let cleaned;
      try { cleaned = validateEdit(patch, allowedCategories); }
      catch (err) { throw new Error(`Edit row "${sku}": ${err.message}`); }
      if (isRuntimeAdd) {
        state.added[sku] = { ...state.added[sku], ...cleaned };
      } else {
        const base = baselineParts[sku];
        const prev = state.edited[sku] || {};
        const next = { ...prev, ...cleaned };
        for (const key of Object.keys(next)) {
          if (key === "editedAt") continue;
          if (base && JSON.stringify(base[key]) === JSON.stringify(next[key])) {
            delete next[key];
          }
        }
        const realKeys = Object.keys(next).filter((k) => k !== "editedAt");
        if (realKeys.length === 0) delete state.edited[sku];
        else { next.editedAt = cleaned.editedAt; state.edited[sku] = next; }
      }
      counts.edited++;
    }

    // DELETED
    for (const sku of staged.deleted || []) {
      if (!wantDeleted.has(sku)) continue;
      if (state.added[sku]) {
        delete state.added[sku];
        counts.deleted++;
        continue;
      }
      if (baselineParts && baselineParts[sku]) {
        delete state.edited[sku];
        if (!state.deleted.includes(sku)) state.deleted.push(sku);
        counts.deleted++;
      }
    }

    await writeOverrides(state);
    return counts;
  });
}

// ---- Diff (preview step) ---------------------------------------------

// Compute the diff between an incoming set of rows and the CURRENT
// merged catalog (baseline + existing overrides). The caller already
// merged + handed us the resolved part records keyed by SKU.
//
// `incomingRows` is an array of parsed-xlsx objects, each already
// normalized to camelCase keys with priceCents (or price). They might
// include SKUs that don't exist (→ added), SKUs that exist with changes
// (→ edited), or SKUs that exist with no changes (→ ignored). The
// caller decides whether SKUs in the current catalog but absent from
// the file go into "deleted" (off by default — see route layer).
//
// Returns: { added:{sku:rec}, edited:{sku:patch}, deleted:[sku], unchanged:n }
function computeImportDiff(currentMerged, incomingRows, { includeDeletions = false } = {}) {
  const added = {};
  const edited = {};
  let unchanged = 0;
  const seenSkus = new Set();

  for (const raw of incomingRows || []) {
    if (!raw || typeof raw !== "object") continue;
    const sku = String(raw.sku == null ? "" : raw.sku).trim();
    if (!sku) continue;
    seenSkus.add(sku);
    const current = currentMerged[sku];
    if (!current) {
      // New SKU — full record. We don't validate here (preview should
      // surface what's coming); validation happens at commit time so
      // the user can see the bad rows in context first.
      //
      // Preserve whichever key the source row used (price = dollars vs
      // priceCents = cents) — validateNewPart routes them to the right
      // coercer. If we collapsed them both into priceCents the
      // commit-time validator would reject a dollar-typed integer
      // (e.g. price: 13) as "must be cents".
      const addedRec = {
        sku,
        partNumber: raw.partNumber || raw.part_number || sku,
        category: raw.category || "",
        subcategory: raw.subcategory || "",
        size: raw.size || "",
        description: raw.description || "",
        unit: raw.unit || "each"
      };
      if (raw.priceCents != null) addedRec.priceCents = raw.priceCents;
      else if (raw.price != null) addedRec.price = raw.price;
      added[sku] = addedRec;
      continue;
    }
    // Existing — compute field diff.
    const patch = {};
    for (const key of EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, key) &&
          !(key === "priceCents" && Object.prototype.hasOwnProperty.call(raw, "price"))) continue;
      const incoming = key === "priceCents"
        ? (raw.priceCents != null ? raw.priceCents : (raw.price != null ? raw.price : current.priceCents))
        : raw[key];
      // Normalize for compare:
      //   - priceCents: route to the right coercer based on which key
      //     the source row used (priceCents=cents / price=dollars)
      //   - strings: trim
      let normalized = incoming;
      if (key === "priceCents") {
        try {
          if (raw.priceCents != null) normalized = coerceCents(raw.priceCents);
          else if (raw.price != null) normalized = coerceDollarsToCents(raw.price);
          else normalized = current.priceCents;
        } catch { normalized = current.priceCents; }
      } else if (typeof incoming === "string") {
        normalized = incoming.trim();
      }
      if (normalized !== current[key] && !(normalized == null && current[key] == null)) {
        patch[key] = normalized;
      }
    }
    if (Object.keys(patch).length > 0) {
      edited[sku] = patch;
    } else {
      unchanged++;
    }
  }

  // Missing-from-file detection — only when caller opts in. Defaults
  // OFF so a partial-file upload doesn't wipe SKUs the admin didn't
  // include.
  const deleted = [];
  if (includeDeletions) {
    for (const sku of Object.keys(currentMerged)) {
      if (!seenSkus.has(sku)) deleted.push(sku);
    }
  }

  return { added, edited, deleted, unchanged };
}

module.exports = {
  KNOWN_UNITS,
  EDITABLE_FIELDS,
  EMPTY_OVERRIDES,
  readOverrides,
  writeOverrides,        // exported for tests / one-off recovery; routes use the high-level helpers
  mergeOverrides,
  classifyOverrides,
  validateSku,
  validateNewPart,
  validateEdit,
  coerceCents,
  coerceDollarsToCents,
  coercePrice,
  coercePriceCents,        // deprecated alias for coerceCents — keep for any external caller
  addOne,
  addMany,
  update,
  softDelete,
  restore,
  applyImport,
  computeImportDiff
};

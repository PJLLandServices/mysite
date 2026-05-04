// Suppliers — the vendors PJL buys parts from. The catalog (parts.json)
// references supplier ids via each part's `supplierIds[]` array; PO
// generation in Phase 3 groups a material list's "need" lines by the
// first supplierId on each part to decide how many POs to spin up.
//
// ID format: SUP-### (zero-padded, sequential). No year prefix — supplier
// relationships are persistent, not transactional. Sequence is per-record
// and seeded from the highest existing id when create() runs.
//
// Storage: server/data/suppliers.json. Same flat-file pattern as the
// rest of the system. PJL's supplier list is small (low double-digits at
// most), so flat-file works indefinitely.
//
// Schema (one supplier):
//   {
//     id: "SUP-001",
//     name: "Vermeer Supply",       // PO header / invoice display
//     contactName: "John Smith",     // optional; addressed-to line on POs
//     email: "orders@example.com",   // PO destination — required to send
//     phone: "905-555-1234",         // optional
//     address: "1 Yard Rd, ...",     // optional; printed on PO header
//     notes: "",                     // free-form internal notes
//     archived: false,               // true hides from default lists
//     createdAt, updatedAt
//   }

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "suppliers.json");

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

function hydrate(s) {
  return {
    id: s?.id || "",
    name: typeof s?.name === "string" ? s.name : "",
    contactName: typeof s?.contactName === "string" ? s.contactName : "",
    email: typeof s?.email === "string" ? s.email : "",
    phone: typeof s?.phone === "string" ? s.phone : "",
    address: typeof s?.address === "string" ? s.address : "",
    notes: typeof s?.notes === "string" ? s.notes : "",
    archived: s?.archived === true,
    createdAt: s?.createdAt || nowIso(),
    updatedAt: s?.updatedAt || nowIso()
  };
}

// Sequential ID generator. Reads existing records, finds the highest
// numeric tail in any "SUP-###" id, returns next + 1 zero-padded to 3.
// Pads will grow naturally past 999 (becomes "SUP-1000") without code
// changes — parseInt ignores the padding width.
async function nextSupplierId() {
  const records = await readAll();
  let max = 0;
  for (const s of records) {
    if (typeof s.id === "string" && s.id.startsWith("SUP-")) {
      const n = parseInt(s.id.slice(4), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `SUP-${String(max + 1).padStart(3, "0")}`;
}

// Trim + cap each string field. Defensive — even though the UI enforces
// max-length, an admin pasting a wall of text into notes shouldn't blow
// up the JSON file size.
function normalizePayload(payload) {
  const cap = (val, max) => String(val == null ? "" : val).trim().slice(0, max);
  return {
    name: cap(payload?.name, 200),
    contactName: cap(payload?.contactName, 120),
    email: cap(payload?.email, 254).toLowerCase(),
    phone: cap(payload?.phone, 40),
    address: cap(payload?.address, 400),
    notes: cap(payload?.notes, 2000)
  };
}

// ---- CRUD -----------------------------------------------------------

async function list({ includeArchived = false } = {}) {
  const records = await readAll();
  if (includeArchived) return records;
  return records.filter((s) => !s.archived);
}

async function get(id) {
  const records = await readAll();
  return records.find((s) => s.id === id) || null;
}

async function create(payload) {
  const fields = normalizePayload(payload);
  if (!fields.name) throw new Error("Supplier name is required.");
  const records = await readAll();
  const id = await nextSupplierId();
  const now = nowIso();
  const supplier = hydrate({
    id,
    ...fields,
    archived: false,
    createdAt: now,
    updatedAt: now
  });
  records.push(supplier);
  // Keep alphabetical by name for stable lists in the UI.
  records.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  await writeAll(records);
  return supplier;
}

async function update(id, payload) {
  const records = await readAll();
  const idx = records.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const fields = normalizePayload(payload);
  if (!fields.name) throw new Error("Supplier name is required.");
  const next = {
    ...current,
    ...fields,
    // archived is toggled via separate setArchived() — don't let it sneak
    // through a regular update payload.
    archived: current.archived,
    updatedAt: nowIso()
  };
  records[idx] = next;
  records.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  await writeAll(records);
  return next;
}

async function setArchived(id, archived) {
  const records = await readAll();
  const idx = records.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], archived: !!archived, updatedAt: nowIso() };
  await writeAll(records);
  return records[idx];
}

module.exports = {
  list,
  get,
  create,
  update,
  setArchived
};

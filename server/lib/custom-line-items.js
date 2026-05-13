// Custom line item catalog — rolling collection of free-form quote
// lines that techs can re-use across visits. Patrick 2026-05-13:
// "we should also keep a rolling collection of the 'customer line
// items'." The use case: tech adds "Add a sprinkler head" with a
// custom price on Visit A; next time another tech (or the same one)
// needs to add the same line, it appears in the picker as a tap-to-
// add option instead of being re-typed.
//
// Storage shape (server/data/custom-line-items.json):
//   [{
//     id:         "cli_<8 alnum>",      // generated
//     label:      "Add a sprinkler head",
//     price:      85,                    // unit price (CAD)
//     usedCount:  3,                     // increment on each use
//     lastUsedAt: "2026-05-13T...",      // ISO timestamp
//     createdAt:  "2026-05-13T...",
//     createdBy:  "tech" | "admin"
//   }]
//
// The catalog is shared across all techs (PJL is small — one
// catalog is enough). Sorted by usedCount desc, lastUsedAt desc when
// listed so the most-frequently-used items surface first.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "custom-line-items.json");

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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

function makeId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(8);
  let id = "cli_";
  for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

// Sort: most-used first, ties broken by most-recently-used.
function sortRanking(a, b) {
  const ua = Number(a.usedCount) || 0;
  const ub = Number(b.usedCount) || 0;
  if (ub !== ua) return ub - ua;
  const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
  const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
  return tb - ta;
}

async function list() {
  const all = await readAll();
  return all.slice().sort(sortRanking);
}

async function add({ label, price, createdBy = "tech" }) {
  const cleanLabel = String(label || "").trim().slice(0, 200);
  const cleanPrice = Number.isFinite(Number(price)) ? Math.max(0, Number(price)) : 0;
  if (!cleanLabel) throw new Error("Label is required.");
  if (cleanPrice <= 0) throw new Error("Price must be greater than 0.");
  const all = await readAll();
  // Dedupe by (label, price) — if a tech tries to save the same item
  // twice, increment the existing entry's usedCount instead of
  // adding a near-duplicate row.
  const existing = all.find((r) =>
    String(r.label).trim().toLowerCase() === cleanLabel.toLowerCase()
    && Math.abs(Number(r.price) - cleanPrice) < 0.01
  );
  if (existing) {
    existing.usedCount = (Number(existing.usedCount) || 0) + 1;
    existing.lastUsedAt = new Date().toISOString();
    await writeAll(all);
    return existing;
  }
  const now = new Date().toISOString();
  const record = {
    id: makeId(),
    label: cleanLabel,
    price: Math.round(cleanPrice * 100) / 100,
    usedCount: 1,
    lastUsedAt: now,
    createdAt: now,
    createdBy: createdBy === "admin" ? "admin" : "tech"
  };
  all.push(record);
  await writeAll(all);
  return record;
}

async function recordUse(id) {
  const all = await readAll();
  const rec = all.find((r) => r.id === id);
  if (!rec) return null;
  rec.usedCount = (Number(rec.usedCount) || 0) + 1;
  rec.lastUsedAt = new Date().toISOString();
  await writeAll(all);
  return rec;
}

async function remove(id) {
  const all = await readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  await writeAll(all);
  return true;
}

module.exports = { list, add, recordUse, remove };

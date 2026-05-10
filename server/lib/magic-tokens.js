// Magic tokens — short-lived, single-use credentials for two flows:
//   - "customer_login"          customer self-serve portal access via email
//   - "admin_password_reset"    admin/tech password reset via email
//
// Distinct from the permanent /portal/<token> that's stored on each lead
// and never expires. These are purpose-bound, time-bound, and consumed on
// first verify. Different file, different purpose — do not conflate.
//
// Schema (one token):
//   {
//     id: "mt_<32-hex>",
//     purpose: "customer_login" | "admin_password_reset",
//     subjectId: "<lead id>" or "<USR-NNN>",
//     createdAt, expiresAt,        // both ISO timestamps
//     usedAt,                       // null until first verify(); ISO once consumed
//     requestIp                     // best-effort, recorded for audit
//   }
//
// Storage: server/data/magic-tokens.json. Same flat-file pattern as the
// rest of the system. Sweep() prunes expired or used-and-old entries on
// each issue() so the file doesn't grow forever.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "magic-tokens.json");

// 30-minute TTL — same window for both purposes. Long enough that a
// customer can finish reading the email, short enough that a stolen
// link expires before it's useful.
const MAGIC_TOKEN_TTL_MS = 30 * 60 * 1000;

// How long to keep used-or-expired tokens before sweep deletes them.
// 24h gives us a paper trail for "did this customer click the link?"
// without bloating the file.
const SWEEP_RETENTION_MS = 24 * 60 * 60 * 1000;

const PURPOSES = new Set(["customer_login", "admin_password_reset"]);

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
    return Array.isArray(parsed) ? parsed : [];
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

function newId() {
  return "mt_" + crypto.randomBytes(16).toString("hex");
}

// ---- Public API ------------------------------------------------------

// Issue a new token. Caller passes the purpose, the subject id (lead id
// or user id), and optionally the requesting IP for audit. Returns the
// stored record. Sweep runs opportunistically.
async function issue(purpose, subjectId, options = {}) {
  if (!PURPOSES.has(purpose)) {
    throw new Error(`Unknown magic-token purpose: ${purpose}`);
  }
  if (!subjectId || typeof subjectId !== "string") {
    throw new Error("subjectId is required.");
  }
  await sweep();
  const records = await readAll();
  const now = Date.now();
  const record = {
    id: newId(),
    purpose,
    subjectId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MAGIC_TOKEN_TTL_MS).toISOString(),
    usedAt: null,
    requestIp: typeof options.requestIp === "string" ? options.requestIp.slice(0, 80) : ""
  };
  records.push(record);
  await writeAll(records);
  return record;
}

// Look up a token by id and verify it's valid for `expectedPurpose`.
// Returns the record on success, or { ok:false, reason } on any failure
// (expired / already used / wrong purpose / unknown id). Does NOT mark
// the token as used — call markUsed() after the consuming side-effect
// has succeeded.
async function verify(id, expectedPurpose) {
  if (!id || typeof id !== "string") return { ok: false, reason: "missing" };
  const records = await readAll();
  const record = records.find((r) => r.id === id);
  if (!record) return { ok: false, reason: "unknown" };
  if (record.purpose !== expectedPurpose) return { ok: false, reason: "wrong-purpose" };
  if (record.usedAt) return { ok: false, reason: "used" };
  if (Date.parse(record.expiresAt) < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, record };
}

// Atomically mark a token as used. Caller is responsible for re-checking
// the token's validity inside the same critical section that issues the
// session cookie — the spec calls out that markUsed() must run BEFORE
// the cookie is set so a replay can't slip through during a redirect race.
async function markUsed(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  if (records[idx].usedAt) return false; // already consumed
  records[idx] = { ...records[idx], usedAt: nowIso() };
  await writeAll(records);
  return true;
}

// Delete tokens that are either expired (regardless of used state) older
// than SWEEP_RETENTION_MS, or used and older than SWEEP_RETENTION_MS.
// Idempotent — running twice in a row is the same as running once.
async function sweep() {
  const records = await readAll();
  const now = Date.now();
  const kept = records.filter((r) => {
    const exp = Date.parse(r.expiresAt) || 0;
    const used = r.usedAt ? Date.parse(r.usedAt) : 0;
    // Drop expired tokens older than retention.
    if (exp && (now - exp) > SWEEP_RETENTION_MS) return false;
    // Drop used tokens older than retention.
    if (used && (now - used) > SWEEP_RETENTION_MS) return false;
    return true;
  });
  if (kept.length !== records.length) {
    await writeAll(kept);
  }
  return records.length - kept.length;
}

module.exports = {
  issue,
  verify,
  markUsed,
  sweep,
  MAGIC_TOKEN_TTL_MS,
  PURPOSES: [...PURPOSES]
};

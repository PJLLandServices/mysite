// Users — admin / tech accounts that log in to the CRM. Mirrors the
// suppliers.js shape: flat-file JSON store, sequential USR-NNN ids,
// case-insensitive email uniqueness.
//
// Replaces the legacy single-password gate (server/data/auth.json) with
// per-user credentials so technicians can be onboarded without sharing
// Patrick's password. The auth.json file stays around post-migration but
// only as the session-secret store.
//
// Schema (one user):
//   {
//     id: "USR-001",
//     email: "patrick@pjllandservices.com",   // unique, lowercased
//     name: "Patrick Lalande",
//     role: "admin" | "tech",
//     passwordHash: "<base64 scrypt hash>",
//     passwordSalt: "<base64 random salt>",
//     disabled: false,
//     createdAt, updatedAt,
//     lastLoginAt
//   }
//
// Password hashing reuses the scrypt+salt pattern from setup-password.js.
// Per-user salts are random and never reused.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "users.json");

const ROLES = new Set(["admin", "tech"]);
const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function hydrate(u) {
  return {
    id: u?.id || "",
    email: typeof u?.email === "string" ? u.email.toLowerCase() : "",
    name: typeof u?.name === "string" ? u.name : "",
    role: ROLES.has(u?.role) ? u.role : "tech",
    passwordHash: typeof u?.passwordHash === "string" ? u.passwordHash : "",
    passwordSalt: typeof u?.passwordSalt === "string" ? u.passwordSalt : "",
    disabled: u?.disabled === true,
    createdAt: u?.createdAt || nowIso(),
    updatedAt: u?.updatedAt || nowIso(),
    lastLoginAt: u?.lastLoginAt || null
  };
}

function publicShape(u) {
  if (!u) return null;
  // Strip secrets — never returned over the wire.
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function validateEmail(email) {
  if (!email) throw new Error("Email is required.");
  if (!EMAIL_RE.test(email)) throw new Error("Email looks invalid.");
}

function validateRole(role) {
  if (!ROLES.has(role)) throw new Error(`Role must be one of: ${[...ROLES].join(", ")}.`);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// scrypt(password, salt, 64) — same parameters as setup-password.js so
// migrations can map legacy hashes 1:1.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64");
  const passwordHash = crypto.scryptSync(String(password || ""), salt, 64).toString("base64");
  return { passwordSalt: salt, passwordHash };
}

// Sequential USR-NNN id generator. Same pattern as suppliers.nextSupplierId().
async function nextUserId() {
  const records = await readAll();
  let max = 0;
  for (const u of records) {
    if (typeof u.id === "string" && u.id.startsWith("USR-")) {
      const n = parseInt(u.id.slice(4), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `USR-${String(max + 1).padStart(3, "0")}`;
}

// ---- CRUD -----------------------------------------------------------

async function list({ includeDisabled = true } = {}) {
  const records = await readAll();
  const filtered = includeDisabled ? records : records.filter((u) => !u.disabled);
  return filtered
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map(publicShape);
}

async function get(id) {
  const records = await readAll();
  const found = records.find((u) => u.id === id);
  return publicShape(found);
}

// Internal lookup that includes the password hash + salt — used by
// verifyPassword and setPassword. Never expose this through the HTTP API.
async function getInternal(id) {
  const records = await readAll();
  return records.find((u) => u.id === id) || null;
}

async function getByEmail(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!email) return null;
  const records = await readAll();
  const found = records.find((u) => u.email === email);
  return publicShape(found);
}

async function create({ email, name, role, password } = {}) {
  const cleanEmail = normalizeEmail(email);
  validateEmail(cleanEmail);
  const cleanName = String(name || "").trim().slice(0, 120);
  if (!cleanName) throw new Error("Name is required.");
  const cleanRole = String(role || "tech").trim();
  validateRole(cleanRole);
  validatePassword(password);

  const records = await readAll();
  if (records.some((u) => u.email === cleanEmail)) {
    throw new Error("A user with that email already exists.");
  }
  const id = await nextUserId();
  const now = nowIso();
  const { passwordHash, passwordSalt } = hashPassword(password);
  const user = hydrate({
    id,
    email: cleanEmail,
    name: cleanName,
    role: cleanRole,
    passwordHash,
    passwordSalt,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  });
  records.push(user);
  records.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
  await writeAll(records);
  return publicShape(user);
}

// Subset patch — accepts { name, role, disabled } only. Password resets
// go through setPassword(). Email cannot be updated (we'd have to handle
// magic-token subjectId reassignments and login confusion — out of scope).
async function update(id, payload = {}) {
  const records = await readAll();
  const idx = records.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(payload, "name")) {
    const nextName = String(payload.name || "").trim().slice(0, 120);
    if (!nextName) throw new Error("Name is required.");
    next.name = nextName;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "role")) {
    const nextRole = String(payload.role || "").trim();
    validateRole(nextRole);
    next.role = nextRole;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "disabled")) {
    next.disabled = Boolean(payload.disabled);
  }
  next.updatedAt = nowIso();
  records[idx] = next;
  await writeAll(records);
  return publicShape(next);
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  records.splice(idx, 1);
  await writeAll(records);
  return true;
}

async function disable(id) {
  return update(id, { disabled: true });
}

async function enable(id) {
  return update(id, { disabled: false });
}

async function setPassword(userId, newPassword) {
  validatePassword(newPassword);
  const records = await readAll();
  const idx = records.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  const { passwordHash, passwordSalt } = hashPassword(newPassword);
  records[idx] = {
    ...records[idx],
    passwordHash,
    passwordSalt,
    updatedAt: nowIso()
  };
  await writeAll(records);
  return publicShape(records[idx]);
}

// Verify (email, password). Returns the public-shape user on success or
// null on any mismatch — same return for "wrong email" and "wrong
// password" so callers can't infer which branch failed. Disabled accounts
// match-but-fail at the controller level (we still return the user; the
// caller is responsible for the disabled check so it can log differently).
async function verifyPassword(email, password) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || typeof password !== "string") return null;
  const records = await readAll();
  const found = records.find((u) => u.email === cleanEmail);
  // Always run the scrypt step — even on miss — so the timing of a
  // wrong-email response matches a wrong-password response. Without
  // this an attacker can enumerate valid emails by measuring the
  // response time delta between hashed/unhashed paths.
  const dummySalt = "AAAAAAAAAAAAAAAAAAAAAA==";
  const salt = found ? found.passwordSalt : dummySalt;
  const incoming = crypto.scryptSync(String(password || ""), salt, 64);
  if (!found) return null;
  let stored;
  try { stored = Buffer.from(found.passwordHash || "", "base64"); }
  catch { return null; }
  if (incoming.length !== stored.length || stored.length === 0) return null;
  if (!crypto.timingSafeEqual(incoming, stored)) return null;
  return publicShape(found);
}

async function recordLogin(userId) {
  const records = await readAll();
  const idx = records.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], lastLoginAt: nowIso() };
  await writeAll(records);
  return publicShape(records[idx]);
}

// Admin-count helper for "last admin protection." Counts ENABLED admins
// — disabled admins don't keep the door open.
async function activeAdminCount() {
  const records = await readAll();
  return records.filter((u) => u.role === "admin" && !u.disabled).length;
}

module.exports = {
  list,
  get,
  getByEmail,
  create,
  update,
  remove,
  disable,
  enable,
  setPassword,
  verifyPassword,
  recordLogin,
  activeAdminCount,
  // Constants exported so callers can use the same minimums.
  MIN_PASSWORD_LENGTH,
  ROLES: [...ROLES]
};

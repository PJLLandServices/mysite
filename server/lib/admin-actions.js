// Admin action log — an append-only record of every state-changing request
// made by a signed-in staff account.
//
// WHY THIS EXISTS. Until now the app had no request log at all (the same
// gap the FLOW-21 entry names: "no viewedAt field, no open tracking, no
// app-level request log"). Per-record `history[]` arrays exist, but 17
// call sites in server.js stamp a hardcoded `by: "admin"` rather than the
// account that actually made the change — so with more than one operator
// on the CRM, the records cannot say WHO did a thing. That is tolerable
// when one person is the only one touching it. It stops being tolerable
// the moment a second operator — a second tech, or an agent acting on
// Patrick's behalf from the field — is writing to the same account.
//
// This is the "who did what, when" layer. It does not replace the
// per-record history (that stays the business-readable trail); it is the
// system-wide ledger underneath it.
//
// TWO DESIGN DECISIONS WORTH KNOWING
//
// 1. JSONL, appended — not a JSON array, read-modify-written.
//    Every other store here is a whole-file read-modify-write with no
//    lock. quote-views.js already documents why a high-frequency write
//    must not live in one of those: interleaving a frequent write with a
//    rare important one can drop the important one. A request log is the
//    highest-frequency write in the system, so it gets the treatment that
//    makes that impossible — one `appendFile` per entry, O(1), no read,
//    nothing to interleave. A torn write costs one log line and cannot
//    corrupt an earlier one.
//
// 2. It records WHAT was called, never the payload.
//    Request bodies here carry customer names, addresses, phone numbers,
//    signature images, and on some routes passwords. A log that captured
//    them would be a second copy of the customer database with none of the
//    handling that the first copy gets. So: method, path, the record id,
//    the outcome — enough to answer "who changed this invoice and when",
//    not enough to reconstruct the change. Query strings are stripped for
//    the same reason (they carry status tokens and search terms).
//    The actor is recorded as a `uid`, not an email — the read API joins
//    against users.json to render a name, so the log itself holds no
//    contact data.
//
// Monthly files (admin-actions-YYYY-MM.jsonl) keep any one file bounded
// without ever rewriting or truncating history. Nothing in this module
// deletes or edits an entry; there is no code path that can.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");

// Only state-changing requests are recorded. GETs are reads; logging every
// page load would bury the writes that matter in noise.
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function fileNameForDate(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `admin-actions-${yyyy}-${mm}.jsonl`;
}

function isMutating(method) {
  return MUTATING.has(String(method || "").toUpperCase());
}

// The record a route is acting on, pulled from the path so the log can
// answer "everything that happened to invoice I-2026-0093". Takes the last
// path segment that looks like an identifier rather than a route word —
// ids here are P-2026-0040 / I-2026-0093 / WO-... / uuids / con_....
function refFromPath(pathname) {
  const segments = String(pathname || "").split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (/^[A-Z]{1,3}-\d{4}-\d{3,}$/.test(seg)) return seg;                    // P-2026-0040, I-2026-0093
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return seg; // uuid
    if (/^(con|cust|wo|q)_[A-Za-z0-9]{4,}$/i.test(seg)) return seg;
  }
  return null;
}

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

// Build the entry. Pure — separated from the write so the shape can be
// asserted without touching a filesystem.
function buildEntry({
  ts = new Date().toISOString(),
  uid = null,
  role = null,
  method,
  pathname,
  status = null,
  ms = null,
  ip = null,
  userAgent = null
} = {}) {
  const cleanPath = truncate(String(pathname || "").split("?")[0], 300);
  return {
    ts,
    uid: uid ? truncate(uid, 100) : null,
    role: role ? truncate(role, 20) : null,
    method: truncate(String(method || "").toUpperCase(), 10),
    path: cleanPath,
    ref: refFromPath(cleanPath),
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    ok: Number.isFinite(Number(status)) ? Number(status) < 400 : null,
    ms: Number.isFinite(Number(ms)) ? Math.round(Number(ms)) : null,
    ip: ip ? truncate(ip, 60) : null,
    ua: userAgent ? truncate(userAgent, 200) : null
  };
}

// The data directory is created once per process, not once per request.
// This is the hottest write path in the app — a mkdir on every append is
// a syscall per write for a directory that has existed since boot.
const ensuredDirs = new Set();
async function ensureDir(dataDir) {
  if (ensuredDirs.has(dataDir)) return;
  await fsp.mkdir(dataDir, { recursive: true });
  ensuredDirs.add(dataDir);
}

// Append one entry. Never throws and never rejects — a failure to log must
// not turn into a failed request. Returns the entry written, or null when
// the call was skipped or the write failed.
async function record(input = {}, { dataDir = DEFAULT_DATA_DIR } = {}) {
  try {
    if (!isMutating(input.method)) return null;
    const entry = buildEntry(input);
    const file = path.join(dataDir, fileNameForDate(new Date(entry.ts)));
    await ensureDir(dataDir);
    await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  } catch (err) {
    console.warn("[admin-actions] log write failed:", err?.message);
    return null;
  }
}

// Read back the most recent entries, newest first. `months` bounds how far
// back to look so a query never walks the whole history by accident.
async function list({
  dataDir = DEFAULT_DATA_DIR,
  limit = 200,
  months = 3,
  uid = null,
  ref = null,
  pathContains = null
} = {}) {
  const wanted = [];
  const now = new Date();
  for (let i = 0; i < Math.max(1, months); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    wanted.push(path.join(dataDir, fileNameForDate(d)));
  }

  const entries = [];
  for (const file of wanted) {
    if (!fs.existsSync(file)) continue;
    let raw;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (err) {
      console.warn(`[admin-actions] couldn't read ${path.basename(file)}:`, err?.message);
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (_) {
        // A torn final line from an interrupted append. Skip it; the
        // entries around it are intact, which is the point of JSONL.
      }
    }
  }

  const filtered = entries.filter((e) => {
    if (uid && e.uid !== uid) return false;
    if (ref && e.ref !== ref) return false;
    if (pathContains && !String(e.path || "").includes(pathContains)) return false;
    return true;
  });

  filtered.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return filtered.slice(0, Math.max(1, Math.min(Number(limit) || 200, 2000)));
}

module.exports = {
  record,
  list,
  buildEntry,
  refFromPath,
  isMutating,
  fileNameForDate,
  DEFAULT_DATA_DIR
};

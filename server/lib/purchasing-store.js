"use strict";

// One lock and one commit for purchase orders and material lists
// (Patrick, 2026-10-02: "purchase-order and material-list updates must not
// be able to save only halfway again").
//
// Sending, receiving and cancelling a PO changes two files: the PO in
// purchase-orders.json and its source lines in material-lists.json. They
// used to be written one after the other with nothing between them, so a
// failure on the second write (the 2026-09-27 wholesale-replacement guard
// refusing it, from then until this fix) left a saved PO pointing at list
// lines that never moved — "ordered" on a cancelled PO, or still "ordered"
// after the parts arrived.
//
// Two pieces close that:
//
//   withPurchasingLock — every write to either file, from any route, queues
//     behind every other. The server is one Node process (booking-lock.js
//     states the same assumption), so a promise chain is the whole lock.
//     Re-entrant: a write verb called from inside a locked operation runs
//     inline instead of waiting on itself.
//
//   commitFiles — writes a journal (every file's before AND after bytes)
//     first, then each file atomically (temp file + rename, so no file is
//     ever half-written), then removes the journal. A write that throws
//     puts back every file already written and removes the journal. If the
//     process dies part-way, the journal is still there, and recover()
//     finishes the commit — at boot and before every locked operation — so
//     the two files never stay disagreeing.
//
// recover() only replays a journal whose files still hold either their
// before or their after bytes, and only one it can read in full. One it
// can't read (truncated, corrupt) or that later writes have overtaken is
// never applied: it is set aside unchanged (.corrupt-<time> / .stale-<time>)
// for a person to look at, the data files are left exactly as they are, and
// the problem is written to purchasing-recovery-log.json, the server log,
// and GET /api/purchase-orders (purchasingRecovery). Every recovery, good or
// bad, is recorded there too. Running recover() again changes nothing: the
// journal is removed only after every file holds its target bytes.
//
// Durability: each file is fsync'd before its rename and the directory is
// fsync'd after it, so a write is on disk before the next step starts; the
// journal is removed only after BOTH data files are confirmed written.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const DATA_DIR = path.join(__dirname, "..", "data");
const JOURNAL = path.join(DATA_DIR, "purchasing-journal.json");
const RECOVERY_LOG = path.join(DATA_DIR, "purchasing-recovery-log.json");
const DATA_FILES = new Set(["purchase-orders.json", "material-lists.json"]);

class PurchasingError extends Error {
  constructor(message, { status = 409, code = "purchasing_refused" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- The lock ------------------------------------------------------------

const held = new AsyncLocalStorage();
let queue = Promise.resolve();

function withPurchasingLock(fn) {
  if (held.getStore()) return Promise.resolve().then(fn);
  const run = queue.then(() => held.run(true, () => {
    recover();
    return fn();
  }));
  // One failed operation must not wedge every later one.
  queue = run.then(() => {}, () => {});
  return run;
}

// ---- Atomic file writes --------------------------------------------------

let faultHook = null;
// Tests only: called before each data-file write in a commit with the
// file's base name. Throwing fails that write; an error carrying
// `simulatedCrash: true` stops the commit as a process death would —
// nothing put back, journal left in place.
function _setFaultHookForTests(fn) { faultHook = typeof fn === "function" ? fn : null; }

async function syncDir(dir) {
  let dh = null;
  try { dh = await fsp.open(dir, "r"); await dh.sync(); } catch { /* not supported here */ } finally { if (dh) await dh.close().catch(() => {}); }
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  await syncDir(path.dirname(file));
}

function atomicWriteSync(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}

function readOrNull(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

// writes: [{ file, after }] — files under the data directory.
async function commitFiles(writes) {
  if (!held.getStore()) throw new Error("commitFiles must run inside withPurchasingLock");
  const plan = writes.filter(Boolean).map((w) => ({ file: w.file, before: readOrNull(w.file), after: w.after }))
    .filter((p) => p.before !== p.after);
  if (!plan.length) return;
  await atomicWrite(JOURNAL, JSON.stringify({
    state: "commit",
    at: new Date().toISOString(),
    files: plan.map((p) => ({ name: path.basename(p.file), before: p.before, after: p.after }))
  }));
  const written = [];
  try {
    for (const p of plan) {
      if (faultHook) await faultHook(path.basename(p.file));
      await atomicWrite(p.file, p.after);
      written.push(p);
    }
  } catch (err) {
    if (err && err.simulatedCrash) throw err;
    try {
      for (const p of written.reverse()) await atomicWrite(p.file, p.before == null ? "[]\n" : p.before);
      await fsp.unlink(JOURNAL);
    } catch (rollbackErr) {
      // Couldn't put everything back: point the journal at the before
      // bytes so recovery finishes the rollback — the caller was told this
      // operation failed, and that is what the files will say.
      console.error("[purchasing] rollback incomplete — recovery will finish it:", rollbackErr);
      try {
        const j = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
        j.state = "rollback";
        atomicWriteSync(JOURNAL, JSON.stringify(j));
      } catch (e) {
        console.error("[purchasing] couldn't mark the journal for rollback:", e);
      }
    }
    throw err;
  }
  await fsp.unlink(JOURNAL).catch(() => {});
}

// ---- Recovery ------------------------------------------------------------

function logRecovery(entry) {
  const record = { at: new Date().toISOString(), ...entry };
  let log = [];
  try { log = JSON.parse(fs.readFileSync(RECOVERY_LOG, "utf8")); if (!Array.isArray(log)) log = []; } catch { log = []; }
  log.push(record);
  try { atomicWriteSync(RECOVERY_LOG, JSON.stringify(log.slice(-200), null, 2) + "\n"); } catch (e) { console.error("[purchasing] couldn't write the recovery log:", e); }
  return record;
}

function recoveryLog() {
  try { const log = JSON.parse(fs.readFileSync(RECOVERY_LOG, "utf8")); return Array.isArray(log) ? log : []; } catch { return []; }
}

// Problems a person has to look at: journals recovery would not apply.
function recoveryProblems() {
  return recoveryLog().filter((e) => e.kind === "journal_unreadable" || e.kind === "journal_stale");
}

function setAside(kind, reason) {
  const suffix = kind === "journal_unreadable" ? "corrupt" : "stale";
  const kept = path.join(DATA_DIR, `purchasing-journal.${suffix}-${Date.now()}.json`);
  try { fs.renameSync(JOURNAL, kept); } catch {}
  const entry = logRecovery({ kind, file: path.basename(kept), reason, action: "set aside unapplied; data files left exactly as they were — run scripts/audit-po-list-lines.mjs" });
  console.error(`[purchasing] RECOVERY PROBLEM: ${reason} — journal kept as ${path.basename(kept)}, not applied. Data files untouched. Check with scripts/audit-po-list-lines.mjs.`);
  return { recovered: false, problem: entry };
}

// Leftover temp files from a write a crash cut short. Never a data file.
function removeTempFiles() {
  let names = [];
  try { names = fs.readdirSync(DATA_DIR); } catch { return; }
  for (const n of names) {
    const base = n.replace(/\.tmp-\d+-\d+$/, "");
    if (base !== n && (DATA_FILES.has(base) || base === path.basename(JOURNAL))) {
      try { fs.unlinkSync(path.join(DATA_DIR, n)); } catch {}
    }
  }
}

function recover() {
  removeTempFiles();
  const raw = readOrNull(JOURNAL);
  if (raw == null) return { recovered: false };
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  const files = (j && Array.isArray(j.files) && j.files.length && (j.state === "commit" || j.state === "rollback")) ? j.files : null;
  const shapeOk = files && files.every((f) => f && DATA_FILES.has(path.basename(String(f.name))) &&
    (f.before === null || typeof f.before === "string") && typeof f.after === "string");
  if (!shapeOk) return setAside("journal_unreadable", `the purchasing journal could not be read (${raw.length} bytes${j ? ", wrong shape" : ", not valid JSON"})`);
  const current = files.map((f) => readOrNull(path.join(DATA_DIR, path.basename(String(f.name)))));
  const intact = files.every((f, i) => current[i] === f.before || current[i] === f.after);
  if (!intact) return setAside("journal_stale", "the data files no longer match the purchasing journal (written over since)");
  const forward = j.state !== "rollback";
  const changed = [];
  for (const f of files) {
    const target = path.join(DATA_DIR, path.basename(String(f.name)));
    const want = forward ? f.after : f.before;
    if (want != null && readOrNull(target) !== want) { atomicWriteSync(target, want); changed.push(path.basename(target)); }
  }
  // Only now — every file holds its target bytes, on disk.
  fs.unlinkSync(JOURNAL);
  const entry = logRecovery({ kind: forward ? "completed" : "rolled_back", journalAt: j.at || null, files: files.map((f) => f.name), rewrote: changed });
  console.warn(`[purchasing] recovered an interrupted ${forward ? "commit (completed it)" : "rollback (finished it)"} from ${j.at || "unknown time"}; rewrote ${changed.join(", ") || "nothing"}`);
  return { recovered: true, direction: forward ? "forward" : "back", rewrote: changed, entry };
}

// Read-only check, run at boot after recover(): do any PO and material-list
// line disagree? Catches what no journal can — a split left by the code
// before this fix, or a journal that was lost — and reports it (server log,
// GET /api/purchase-orders). It never changes a record.
let lastCheck = null;
function checkConsistency() {
  const { auditPurchasingLines } = require("./purchasing-audit");
  const at = new Date().toISOString();
  let pos, lists;
  try {
    pos = JSON.parse(readOrNull(path.join(DATA_DIR, "purchase-orders.json")) || "[]");
    lists = JSON.parse(readOrNull(path.join(DATA_DIR, "material-lists.json")) || "[]");
  } catch (err) {
    lastCheck = { at, unreadable: true, disagreements: null, findings: [] };
    console.error(`[purchasing] RECOVERY PROBLEM: a purchasing data file can't be read: ${err.message}`);
    return lastCheck;
  }
  const r = auditPurchasingLines({ purchaseOrders: Array.isArray(pos) ? pos : [], materialLists: Array.isArray(lists) ? lists : [] });
  lastCheck = {
    at,
    disagreements: r.findings.length,
    findings: r.findings.slice(0, 50).map((f) => ({ kind: f.kind, projectId: f.projectId, listId: f.listId, lineId: f.lineId, sku: f.sku, poId: f.poId, poStatus: f.poStatus }))
  };
  if (r.findings.length) {
    console.error(`[purchasing] ${r.findings.length} material-list line(s) disagree with their purchase order — nothing changed; see scripts/audit-po-list-lines.mjs`);
  }
  return lastCheck;
}

// What GET /api/purchase-orders reports: journals recovery would not apply,
// and the boot check's count of disagreeing lines.
function recoveryStatus() {
  return {
    problems: recoveryProblems(),
    disagreements: lastCheck ? lastCheck.disagreements : null,
    checkedAt: lastCheck ? lastCheck.at : null,
    findings: lastCheck ? lastCheck.findings : []
  };
}

module.exports = {
  withPurchasingLock,
  commitFiles,
  atomicWrite,
  recover,
  recoveryLog,
  recoveryProblems,
  checkConsistency,
  recoveryStatus,
  PurchasingError,
  JOURNAL,
  DATA_DIR,
  _setFaultHookForTests
};

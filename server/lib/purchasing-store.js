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
const HOLDS = path.join(DATA_DIR, "purchasing-holds.json");
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
// records: { purchaseOrders: [ids], materialLists: [ids] } — what this
// commit changes. Written FIRST in the journal, so even a journal cut off
// part-way still says which records were in flight (see recover()).
async function commitFiles(writes, records = {}) {
  if (!held.getStore()) throw new Error("commitFiles must run inside withPurchasingLock");
  const plan = writes.filter(Boolean).map((w) => ({ file: w.file, before: readOrNull(w.file), after: w.after }))
    .filter((p) => p.before !== p.after);
  if (!plan.length) return;
  await atomicWrite(JOURNAL, JSON.stringify({
    state: "commit",
    records: {
      purchaseOrders: [...new Set((records.purchaseOrders || []).filter(Boolean).map(String))],
      materialLists: [...new Set((records.materialLists || []).filter(Boolean).map(String))]
    },
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

// The records a journal names, read from its header even when the rest of
// it is cut off or damaged. null = it doesn't say (or can't be read).
function journalRecords(raw, parsed) {
  const ok = (r) => r && Array.isArray(r.purchaseOrders) && Array.isArray(r.materialLists) &&
    [...r.purchaseOrders, ...r.materialLists].every((x) => typeof x === "string") ? r : null;
  if (parsed && parsed.records) return ok(parsed.records);
  const m = /"records":(\{"purchaseOrders":\[[^\]]*\],"materialLists":\[[^\]]*\]\})/.exec(String(raw || "").slice(0, 4096));
  if (!m) return null;
  try { return ok(JSON.parse(m[1])); } catch { return null; }
}

function setAside(kind, reason, records) {
  const suffix = kind === "journal_unreadable" ? "corrupt" : "stale";
  const kept = path.join(DATA_DIR, `purchasing-journal.${suffix}-${Date.now()}.json`);
  try { fs.renameSync(JOURNAL, kept); } catch {}
  // Fail closed: the state of these records can't be proven, so nothing may
  // act on them until a person has looked. If the journal doesn't say which
  // records, every purchase order and material list is held.
  const why = `${reason} — kept as ${path.basename(kept)}`;
  const holds = records && (records.purchaseOrders.length || records.materialLists.length)
    ? [...records.purchaseOrders.map((id) => ({ scope: "purchase_order", id })), ...records.materialLists.map((id) => ({ scope: "material_list", id }))]
    : [{ scope: "all", id: null }];
  addHolds(holds.map((h) => ({ ...h, reason: why, source: kind })));
  const entry = logRecovery({ kind, file: path.basename(kept), reason, held: holds, action: "set aside unapplied; data files left exactly as they were; the records named are held until the office releases them" });
  console.error(`[purchasing] RECOVERY PROBLEM: ${reason} — journal kept as ${path.basename(kept)}, not applied. Data files untouched. Held: ${holds.map((h) => h.scope === "all" ? "ALL purchase orders and material lists" : h.id).join(", ")}.`);
  return { recovered: false, problem: entry };
}

// ---- Recovery holds (fail closed) ------------------------------------------
//
// A hold is set when recovery can't prove what a purchase order and its
// material list should say: a journal that can't be read or no longer
// matches, or — at boot — a PO and list line that disagree. A held record
// can be READ, but nothing may send, receive, cancel, re-order, edit,
// delete or restore it, or order from a held list, so a later action can't
// build on a state nobody has confirmed. No code decides which record is
// right. Holds live in purchasing-holds.json and are released only by the
// office (releaseHold), and only once the records no longer disagree. An
// unreadable holds file holds everything.

function readHolds() {
  const raw = readOrNull(HOLDS);
  if (raw == null) return [];
  try { const h = JSON.parse(raw); if (Array.isArray(h)) return h; } catch {}
  return [{ scope: "all", id: null, reason: "the purchasing hold list (purchasing-holds.json) can't be read", source: "holds_unreadable", at: null }];
}

function addHolds(entries) {
  const holds = readHolds().filter((h) => h.source !== "holds_unreadable");
  const at = new Date().toISOString();
  let added = 0;
  for (const e of entries) {
    if (holds.some((h) => h.scope === e.scope && (h.id || null) === (e.id || null))) continue;
    holds.push({ scope: e.scope, id: e.id || null, reason: e.reason, source: e.source, detail: e.detail || null, at });
    added += 1;
  }
  if (added) atomicWriteSync(HOLDS, JSON.stringify(holds, null, 2) + "\n");
  return added;
}

// The hold, if any, that covers any of these records.
function holdFor({ purchaseOrders = [], materialLists = [] } = {}) {
  const pos = new Set(purchaseOrders.filter(Boolean));
  const lists = new Set(materialLists.filter(Boolean));
  return readHolds().find((h) => h.scope === "all" ||
    (h.scope === "purchase_order" && pos.has(h.id)) ||
    (h.scope === "material_list" && lists.has(h.id))) || null;
}

function holdMessage(h) {
  const what = h.scope === "all" ? "Purchase orders and material lists are"
    : h.scope === "purchase_order" ? `Purchase order ${h.id} is` : `Material list ${h.id} is`;
  return `Recovery required: ${what} locked because an interrupted save left records the system can't prove are correct (${h.reason}). ` +
    "Nothing can send, receive, cancel, re-order or edit it until the office checks the purchase order against its material list and releases the hold. Nothing has been changed automatically.";
}

function assertNotHeld(refs) {
  const h = holdFor(refs);
  if (!h) return;
  const err = new PurchasingError(holdMessage(h), { status: 423, code: "recovery_required" });
  err.hold = h;
  throw err;
}

// What a screen shows for one record: the hold and its message, or null.
function holdInfo(refs) {
  const h = holdFor(refs);
  return h ? { ...h, message: holdMessage(h) } : null;
}

// The office releases a hold once it has checked the records. Refused
// while the PO and list still disagree — that is repaired first, by a
// person, never by this.
function releaseHold({ scope, id = null, by = "admin", note = "", stillDisagrees = () => false } = {}) {
  if (!String(note || "").trim()) throw new PurchasingError("Say what you checked before releasing the hold.", { status: 400, code: "note_required" });
  const holds = readHolds();
  const match = holds.find((h) => h.scope === scope && (h.id || null) === (id || null));
  if (!match) throw new PurchasingError("There is no such recovery hold.", { status: 404, code: "no_hold" });
  const disagreement = stillDisagrees(match);
  if (disagreement) {
    throw new PurchasingError(`The records still disagree (${disagreement}). Repair them first; the hold stays.`, { status: 409, code: "still_disagrees" });
  }
  const kept = holds.filter((h) => h !== match && h.source !== "holds_unreadable");
  atomicWriteSync(HOLDS, JSON.stringify(kept, null, 2) + "\n");
  logRecovery({ kind: "hold_released", scope, id, by, note: String(note).slice(0, 500), hold: match });
  return match;
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
  if (!shapeOk) return setAside("journal_unreadable", `the purchasing journal could not be read (${raw.length} bytes${j ? ", wrong shape" : ", not valid JSON"})`, journalRecords(raw, j));
  const current = files.map((f) => readOrNull(path.join(DATA_DIR, path.basename(String(f.name)))));
  const intact = files.every((f, i) => current[i] === f.before || current[i] === f.after);
  if (!intact) return setAside("journal_stale", "the data files no longer match the purchasing journal (written over since)", journalRecords(raw, j));
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
    addHolds([{ scope: "all", id: null, reason: `a purchasing data file can't be read (${err.message})`, source: "data_unreadable" }]);
    console.error(`[purchasing] RECOVERY PROBLEM: a purchasing data file can't be read: ${err.message} — all purchase orders and material lists held`);
    return lastCheck;
  }
  const r = auditPurchasingLines({ purchaseOrders: Array.isArray(pos) ? pos : [], materialLists: Array.isArray(lists) ? lists : [] });
  lastCheck = {
    at,
    disagreements: r.totals.hold,
    toReview: r.totals.review,
    findings: r.findings.slice(0, 50).map((f) => ({ kind: f.kind, severity: f.severity, projectId: f.projectId, listId: f.listId, lineId: f.lineId, sku: f.sku, poId: f.poId, poStatus: f.poStatus }))
  };
  // Fail closed on contradictions only ("hold"): each list and every PO
  // involved. Quantity reviews are reported, never held — a draft PO's
  // quantity may be edited on purpose. Nothing is changed either way.
  const contradictions = r.findings.filter((f) => f.severity === "hold");
  if (contradictions.length) {
    const holds = [];
    for (const f of contradictions) {
      const reason = `line ${f.lineId} (${f.sku}) on ${f.listId} disagrees with ${f.poId || "its purchase order"}: ${f.kind}`;
      const poIds = new Set([...String(f.poId || "").split(", "), ...(f.claims || []).map((c) => c.poId)]);
      for (const id of poIds) if (id && pos.some((p) => p && p.id === id)) holds.push({ scope: "purchase_order", id, reason, source: f.kind });
      holds.push({ scope: "material_list", id: f.listId, reason, source: f.kind });
    }
    const added = addHolds(holds);
    console.error(`[purchasing] ${contradictions.length} material-list line(s) disagree with their purchase order — nothing changed; those records are held (${added} new hold(s)); see scripts/audit-po-list-lines.mjs`);
  }
  if (r.totals.review) console.warn(`[purchasing] ${r.totals.review} line(s) whose quantities a person should review (not held)`);
  return lastCheck;
}

// What GET /api/purchase-orders reports: journals recovery would not apply,
// and the boot check's count of disagreeing lines.
function recoveryStatus() {
  return {
    holds: readHolds().map((h) => ({ ...h, message: holdMessage(h) })),
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
  readHolds,
  holdFor,
  holdInfo,
  assertNotHeld,
  releaseHold,
  PurchasingError,
  JOURNAL,
  DATA_DIR,
  _setFaultHookForTests
};

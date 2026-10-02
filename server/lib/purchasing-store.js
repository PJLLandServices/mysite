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
// before or their after bytes. One that has been overtaken by later writes
// is set aside (renamed .stale-<time>) and logged, never applied over them.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const DATA_DIR = path.join(__dirname, "..", "data");
const JOURNAL = path.join(DATA_DIR, "purchasing-journal.json");

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
}

function atomicWriteSync(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
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

function recover() {
  const raw = readOrNull(JOURNAL);
  if (raw == null) return { recovered: false };
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  const files = (j && Array.isArray(j.files)) ? j.files : null;
  // A journal that is unreadable, or whose files have since moved on to
  // something else, describes a state that no longer exists — set aside.
  const current = files ? files.map((f) => readOrNull(path.join(DATA_DIR, path.basename(String(f.name))))) : null;
  const intact = files && files.every((f, i) => current[i] === f.before || current[i] === f.after);
  if (!intact) {
    const stale = `${JOURNAL}.stale-${Date.now()}`;
    try { fs.renameSync(JOURNAL, stale); } catch {}
    console.error(`[purchasing] journal did not match the data files — set aside as ${path.basename(stale)}, not applied`);
    return { recovered: false, stale: path.basename(stale) };
  }
  const forward = j.state !== "rollback";
  for (const f of files) {
    const target = path.join(DATA_DIR, path.basename(String(f.name)));
    const want = forward ? f.after : f.before;
    if (want != null && readOrNull(target) !== want) atomicWriteSync(target, want);
  }
  fs.unlinkSync(JOURNAL);
  console.warn(`[purchasing] recovered an interrupted ${forward ? "commit" : "rollback"} from ${j.at || "unknown time"}`);
  return { recovered: true, direction: forward ? "forward" : "back" };
}

module.exports = {
  withPurchasingLock,
  commitFiles,
  atomicWrite,
  recover,
  PurchasingError,
  JOURNAL,
  DATA_DIR,
  _setFaultHookForTests
};

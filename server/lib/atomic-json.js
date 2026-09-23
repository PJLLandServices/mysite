// server/lib/atomic-json.js
//
// Write a JSON store so a reader never sees half of it.
//
// fs.writeFile truncates the file and then streams the new bytes in. A crash,
// a restart, or a full disk in that gap leaves leads.json truncated — and on
// Render, a redeploy can land exactly there. Writing to a sibling temp file
// and renaming it over the target makes the swap atomic within the filesystem:
// a reader sees either every byte of the old file or every byte of the new
// one, never a prefix.
//
// This is not a lock and does not pretend to be. Two writers still lose each
// other's changes — that is what booking-lock.js is for. This narrows a
// different failure: the one where the store survives as garbage.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function writeJsonAtomic(file, value) {
  const body = JSON.stringify(value, null, 2) + "\n";
  // Same directory, so rename() stays inside one filesystem. A temp file in
  // /tmp would make this a copy, and a copy is not atomic.
  //
  // The suffix carries RANDOM bytes, not just pid + clock. Two writes to
  // one store in the same millisecond used to pick the same temp path:
  // both wrote it, the first renamed it away, and the second's rename
  // failed ENOENT and THREW — 372 of 600 concurrent writes, measured. The
  // callers do not expect a write to fail (writeLeads() does not catch),
  // so a booking could be lost to two requests landing in the same tick.
  // Losing one writer's CHANGES to the other is the documented behaviour
  // of this helper; losing the WRITE is not.
  const tmp = path.join(path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, body, "utf8");
    // Windows can briefly deny replacement while a reader has the old
    // file open. Retry the SAME atomic rename; never delete/truncate the
    // destination to get around a sharing violation. Linux is unchanged.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); break; }
      catch (err) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(err.code) || attempt >= 6) throw err;
        await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Serialize read-modify-write on one store, in process.
//
// writeJsonAtomic() keeps the FILE whole; it does not keep two writers'
// CHANGES. Two requests that each readAll(), change a different record
// (or a different field of one record) and writeAll() both succeed, and
// the second silently erases the first. On a work order that is the
// phone's zone edit and the office's note landing in the same second —
// measured 3 of 3 rounds in the fall-closing pressure test (2026-09-22).
//
// serialize(key, fn) runs fn only after every earlier fn queued on the
// same key has settled, so each read-modify-write sees the previous one's
// result. A throw releases the queue for the next caller. The server is a
// single Node process (Render), so an in-process queue is the whole lock.
// NOT re-entrant: a function running under serialize(key) must not call
// serialize(key) again, or it waits on itself.
const queues = new Map();
function serialize(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => fn());
  // Keep the chain alive even when fn throws, but never leak the
  // rejection to the NEXT caller — only to the caller that owns it.
  const tail = current.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return current;
}

// Parse a JSON array store, or throw. A store that exists but does not
// parse is DAMAGED, not empty: answering [] lets the next write save a
// one-record file over every record that was there (fall-closing pressure
// test round 4: work-orders.json went from N records to 1). A missing
// file is the only legitimate empty.
function parseJsonArrayStore(raw, file) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    const e = new Error(`${path.basename(file)} is unreadable (${err.message}) — refusing to treat it as empty.`);
    e.code = "STORE_CORRUPT";
    throw e;
  }
  if (!Array.isArray(parsed)) {
    const e = new Error(`${path.basename(file)} is not a JSON array — refusing to treat it as empty.`);
    e.code = "STORE_CORRUPT";
    throw e;
  }
  return parsed;
}

module.exports = { writeJsonAtomic, serialize, parseJsonArrayStore };

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

module.exports = { writeJsonAtomic };

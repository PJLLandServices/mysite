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

async function writeJsonAtomic(file, value) {
  const body = JSON.stringify(value, null, 2) + "\n";
  // Same directory, so rename() stays inside one filesystem. A temp file in
  // /tmp would make this a copy, and a copy is not atomic.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeJsonAtomic };

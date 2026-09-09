// Atomic JSON file write: stage to a uniquely-named temp file in the same
// directory, then rename over the real file. A crash mid-write leaves the
// old file intact instead of a truncated one, and a reader never sees a
// half-written document.
//
// The temp name carries pid + a counter so two writers staging the same
// file at the same instant cannot collide on the temp path. Serialising
// the writers themselves is the caller's job (see booking-lock.js) —
// this only guarantees each individual write is all-or-nothing.
//
// Consumers: leads.json (server.js), bookings.json, properties.json,
// customers.json, holds.json.
const fs = require("node:fs/promises");
const path = require("node:path");

let counter = 0;

async function writeJsonAtomic(file, value, { pretty = true } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const json = (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + "\n";
  counter = (counter + 1) % 1e9;
  const tmp = `${file}.${process.pid}.${counter}.tmp`;
  await fs.writeFile(tmp, json, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = { writeJsonAtomic };

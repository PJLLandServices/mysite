// Slot holds — the 10-minute reservation a customer gets the moment they
// pick a time on /book.html, before they have typed a name.
//
// A hold is NOT a booking. It occupies one unit of the bucket's capacity
// (the availability engine sees it as a booking-shaped obstacle with the
// same start/end/coords) so nobody else is offered that exact start while
// the customer fills in the contact step. It is:
//   - CREATED by POST /api/booking/hold, after the engine re-validates
//     the slot under the booking lock;
//   - CONSUMED by POST /api/booking/reserve (the hold's token is required
//     for a standard public slot);
//   - RELEASED by POST /api/booking/hold/release (abandon / pick another
//     time / pagehide beacon), or by replacement when the same customer
//     holds a different slot and passes `previousHoldToken`;
//   - EXPIRED after HOLD_TTL_MS. Expired holds are ignored on every read
//     and swept from the file once a minute.
//
// Storage: server/data/holds.json, written atomically. Small and short-
// lived by construction — the sweep keeps it at "holds in flight".
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-json");

const FILE = path.join(__dirname, "..", "data", "holds.json");
const DEFAULT_TTL_MS = 10 * 60 * 1000;

// PJL_HOLD_TTL_MS exists for the test harness (a 10-minute wait is not a
// test). Production never sets it.
function ttlMs() {
  const n = Number(process.env.PJL_HOLD_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

async function readAll() {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(holds) {
  await writeJsonAtomic(FILE, holds);
}

function isLive(h, now = Date.now()) {
  return h && h.token && h.start && Date.parse(h.expiresAt || 0) > now;
}

// Create a hold. `previousToken` (optional) is released in the same write
// — a customer who changes their mind holds one slot, never two.
async function create({ serviceKey, serviceLabel, date, bucketKey, bucketWindow, start, end, coords, address, ip, previousToken = "" }) {
  const now = Date.now();
  const holds = (await readAll()).filter((h) => isLive(h, now) && h.token !== previousToken);
  const hold = {
    token: crypto.randomBytes(18).toString("hex"),
    serviceKey: serviceKey || null,
    serviceLabel: serviceLabel || null,
    date: date || null,
    bucketKey: bucketKey || null,
    bucketWindow: bucketWindow || null,
    start,
    end,
    coords: coords && coords.lat != null ? { lat: coords.lat, lng: coords.lng } : null,
    address: address || null,
    ip: ip || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs()).toISOString()
  };
  holds.push(hold);
  await writeAll(holds);
  return hold;
}

async function get(token) {
  if (!token) return null;
  const holds = await readAll();
  return holds.find((h) => h.token === token && isLive(h)) || null;
}

async function release(token) {
  if (!token) return false;
  const holds = await readAll();
  const next = holds.filter((h) => h.token !== token && isLive(h));
  if (next.length === holds.length) return false;
  await writeAll(next);
  return true;
}

// Same as release — named for the reserve path so the intent reads.
const consume = release;

// Live holds shaped like activeBookings() rows so the engine treats them
// as obstacles. `excludeToken` drops the caller's own hold: a customer's
// hold must not block the customer it was taken for.
async function listActive({ excludeToken = "" } = {}) {
  const now = Date.now();
  return (await readAll())
    .filter((h) => isLive(h, now) && h.token !== excludeToken)
    .map((h) => ({
      start: h.start,
      end: h.end,
      coords: h.coords,
      leadId: null,
      holdToken: h.token,
      serviceKey: h.serviceKey,
      serviceLabel: h.serviceLabel,
      isHold: true
    }));
}

async function sweep() {
  const holds = await readAll();
  const live = holds.filter((h) => isLive(h));
  if (live.length !== holds.length) await writeAll(live);
  return holds.length - live.length;
}

module.exports = { create, get, release, consume, listActive, sweep, ttlMs, FILE, DEFAULT_TTL_MS };

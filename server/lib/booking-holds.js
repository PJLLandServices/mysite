// server/lib/booking-holds.js
//
// A ten-minute claim on a slot while the customer fills in the form.
//
// Reserve is atomic now (lib/booking-lock.js), so two people can no longer
// both be told yes. But the loser still loses AFTER typing their name, phone,
// address and zone count — the slot they picked was never theirs while they
// worked. With ads live and several people on the page at once that is a form
// filled in for nothing, which reads as a broken website.
//
// A hold is the missing step: picking a time takes the slot out of the pool
// for ten minutes, and confirming converts it. Abandon the page and it lapses
// on its own.
//
// EXPIRY IS ENFORCED ON READ, not by the sweeper. The sweeper only keeps the
// file from growing; if it never ran, the answers would still be correct.
// A cleanup job that is load-bearing for correctness is a cleanup job that
// takes bookings down the day it fails.
//
// Holds are counted by activeBookings(), so they occupy capacity AND take
// part in the geography of the day exactly as a real booking would. Anything
// less and the hold would stop a double-book but still let a far-away
// customer seed a clustered day.

const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-json");

const FILE = path.join(__dirname, "..", "data", "holds.json");
const HOLD_MINUTES = 10;

function readAllRaw() {
  if (!fsSync.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fsSync.readFileSync(FILE, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // An unreadable holds file must never stop people booking. Worst case we
    // forget some holds, which costs a re-pick, not a booking.
    console.warn("[holds] unreadable, treating as empty:", err?.message);
    return [];
  }
}

function isLive(hold, now = Date.now()) {
  return Boolean(hold && hold.token && hold.expiresAt && Date.parse(hold.expiresAt) > now);
}

// The only read anything else should use.
function activeHolds(now = Date.now()) {
  return readAllRaw().filter((h) => isLive(h, now));
}

function get(token, now = Date.now()) {
  if (!token) return null;
  return activeHolds(now).find((h) => h.token === token) || null;
}

// Create a hold, optionally releasing one the same customer already had —
// changing your mind about a time must not quietly eat two units of capacity.
async function create({ slotStart, slotEnd, dateKey, bucketKey, coords, serviceKey, releaseToken = "" }, now = Date.now()) {
  const kept = readAllRaw().filter((h) => isLive(h, now) && h.token !== releaseToken);
  const hold = {
    token: crypto.randomBytes(18).toString("base64url"),
    slotStart,
    slotEnd,
    dateKey,
    bucketKey: bucketKey || null,
    serviceKey: serviceKey || null,
    coords: coords || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + HOLD_MINUTES * 60 * 1000).toISOString()
  };
  kept.push(hold);
  await writeJsonAtomic(FILE, kept);
  return hold;
}

// Consume on confirm. Returns the hold when it was live, null otherwise —
// the caller decides whether a missing hold is fatal.
async function consume(token, now = Date.now()) {
  if (!token) return null;
  const all = readAllRaw();
  const hold = all.find((h) => h.token === token);
  const live = isLive(hold, now) ? hold : null;
  const kept = all.filter((h) => h.token !== token && isLive(h, now));
  if (kept.length !== all.length) await writeJsonAtomic(FILE, kept);
  return live;
}

async function release(token, now = Date.now()) {
  return consume(token, now);
}

// Housekeeping only. See the note at the top: correctness does not depend on
// this having run.
async function sweep(now = Date.now()) {
  const all = readAllRaw();
  const kept = all.filter((h) => isLive(h, now));
  if (kept.length !== all.length) await writeJsonAtomic(FILE, kept);
  return all.length - kept.length;
}

// Booking-shaped rows for activeBookings(), so capacity and geography both
// see a held slot as taken.
function asBookingRows(now = Date.now()) {
  return activeHolds(now)
    .filter((h) => h.slotStart && h.slotEnd)
    .map((h) => ({
      start: h.slotStart,
      end: h.slotEnd,
      coords: h.coords || null,
      serviceKey: h.serviceKey || null,
      serviceLabel: "Held",
      holdToken: h.token,
      isHold: true
    }));
}

module.exports = {
  FILE, HOLD_MINUTES,
  activeHolds, get, create, consume, release, sweep, asBookingRows, isLive
};

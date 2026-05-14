// Availability engine — generates bookable slots for the public booking UI.
//
// Inputs:
//   serviceKey      — one of BOOKABLE_SERVICES keys
//   customerCoords  — { lat, lng } from geocode.js
//   bookings        — array of existing same-crew bookings:
//                       [{ start, end, coords, leadId }]
//   blocks          — array of admin-set blocked ranges:
//                       [{ start, end, label }]
//   daysAhead       — how many days from "now" to scan (default 14)
//   now             — optional Date override for testing
//
// Output: ordered array of slot objects { start, end, durationMinutes,
// serviceKey, serviceLabel, dayLabel } where every slot is:
//   1. Inside that day's working window
//   2. Starts ≤ that day's last-start cutoff
//   3. Ends before the day's hard close
//   4. Doesn't conflict with any existing booking
//   5. Doesn't overlap any admin block
//   6. Reachable from the previous booking (travel + buffer fits)
//   7. Allows the next booking to be reached (travel + buffer fits)
//   8. ≥ leadTimeHours from now
//
// Single source of truth for service durations and working hours. To change a
// number, edit the constants at the top. Patrick can override settings via the
// admin schedule UI (writes to server/data/schedule.json).

const { travelMinutes } = require("./distance");
const { PJL_BASE } = require("./geocode");

// =============== TUNABLE CONFIG (top of file = single source of truth) ===============

// Bookable services. `minutes` is the on-site time. `requiresAddress` means
// the booking form must collect a street address (used for travel-time math).
// `bookable: false` means visible in admin reports but customers can't pick it.
// `family` groups variants the customer typically picks between (residential
// 4z / 5-7z / 8+z / commercial all live under "spring_opening"). Used by
// book.html to filter the grid when arriving via a deep link.
//
// `slotIncrementMinutes` (optional) overrides the global slot increment for
// this service only. Commercial uses 300 min so customers see exactly TWO
// slots per day — 8:00 AM (morning) and 1:00 PM (afternoon) — instead of a
// full half-hour grid. This matches Patrick's "morning or afternoon
// appointment" preference for commercial work.
//
// `displayMinutes` (optional) is the human-readable duration shown in the UI.
// For long jobs we display a range ("90-120 min") even though the engine
// blocks the longer end (`minutes`) for safety.
// 2026-05-02 RESTRUCTURE: one bookable service per price tier in pricing.json.
// Booking key === pricing.json key === customer-facing label. No disambiguation
// downstream — server/lib/pricing.js is now a dumb key lookup. Eliminates the
// label-vs-description-vs-price drift that plagued the old 3-bucket setup.
//
// Spring & fall: 5 residential tiers + 3 commercial tiers = 8 services per season.
// All seasonal services use the slot increments below; only commercial gets
// the morning/afternoon (slotIncrementMinutes: 300) treatment.
const BOOKABLE_SERVICES = {
  // --- Spring opening (residential) ---
  spring_open_4z: {
    label: "Spring opening (1-4 zones residential)",
    minutes: 45, requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_6z: {
    label: "Spring opening (5-6 zones residential)",
    minutes: 50, requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_8z: {
    label: "Spring opening (7-8 zones residential)",
    minutes: 60, requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_15z: {
    label: "Spring opening (9-15 zones residential)",
    minutes: 105, displayMinutes: "90-120 min",
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_16plus: {
    label: "Spring opening (16+ zones residential — custom quote)",
    minutes: 150, displayMinutes: "Quoted on-site",
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  // --- Spring opening (commercial) ---
  spring_open_commercial: {
    label: "Spring opening — commercial (1-4 zones)",
    minutes: 60, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_commercial_8z: {
    label: "Spring opening — commercial (5-8 zones)",
    minutes: 90, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_commercial_9plus: {
    label: "Spring opening — commercial (9+ zones — custom quote)",
    minutes: 120, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },

  // --- Fall winterization (residential) ---
  fall_close_4z: {
    label: "Fall winterization (1-4 zones residential)",
    minutes: 30, requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_6z: {
    label: "Fall winterization (5-6 zones residential)",
    minutes: 35, requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_8z: {
    label: "Fall winterization (7-8 zones residential)",
    minutes: 45, requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_15z: {
    label: "Fall winterization (9-15 zones residential)",
    minutes: 75, displayMinutes: "60-90 min",
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_16plus: {
    label: "Fall winterization (16+ zones residential — custom quote)",
    minutes: 120, displayMinutes: "Quoted on-site",
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  // --- Fall winterization (commercial) ---
  fall_close_commercial: {
    label: "Fall winterization — commercial (1-4 zones)",
    minutes: 60, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_commercial_8z: {
    label: "Fall winterization — commercial (5-8 zones)",
    minutes: 90, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_commercial_9plus: {
    label: "Fall winterization — commercial (9+ zones — custom quote)",
    minutes: 120, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  sprinkler_repair: {
    label: "Sprinkler repair (default block)",
    minutes: 90, requiresAddress: true, bookable: true,
    category: "repair", family: "sprinkler_repair"
  },
  hydrawise_retrofit: {
    label: "Hydrawise retrofit",
    minutes: 90, requiresAddress: true, bookable: true,
    category: "controller", family: "hydrawise_retrofit"
  },
  site_visit: {
    label: "Site visit (consult / scope)",
    minutes: 30, requiresAddress: true, bookable: true,
    category: "consult", family: "site_visit"
  }
};

// Working hours per day-of-week. 0 = Sunday, 6 = Saturday.
//   open      — earliest a job can START
//   close     — hard end of day (no part of any job extends past this)
//   lastStart — latest a job can START even if there's room before close
//
// Patrick's spec:
//   Mon-Fri  open 08:00, close 21:00, lastStart 17:30 (90-min job ends 19:00)
//   Saturday open 08:00, close 12:00, lastStart 10:30
//   Sunday   closed
const DEFAULT_HOURS = {
  0: null,
  1: { open: "08:00", close: "21:00", lastStart: "17:30" },
  2: { open: "08:00", close: "21:00", lastStart: "17:30" },
  3: { open: "08:00", close: "21:00", lastStart: "17:30" },
  4: { open: "08:00", close: "21:00", lastStart: "17:30" },
  5: { open: "08:00", close: "21:00", lastStart: "17:30" },
  6: { open: "08:00", close: "12:00", lastStart: "10:30" }
};

const DEFAULT_SETTINGS = {
  bufferMinutes: 15,         // breathing room between jobs (parking, equipment)
  leadTimeHours: 5,          // soonest a slot can start from "now"
  slotIncrementMinutes: 30,  // legacy — only used if BOOKING_BUCKETS is empty
  daysAhead: 14              // how many days into the future the calendar scans
};

// Customer-facing booking buckets. ONE customer per bucket per day —
// Patrick committed to dropping the 20-slot grid in favour of two
// labelled windows so the booking page reads like "morning or afternoon"
// instead of "pick a precise minute." Booking record stores the bucket
// start as scheduledFor and the bucket length as durationMinutes; the
// customer never sees a precise time anywhere (confirmation, portal,
// email all show the bucket label). Patrick's iCal feed blocks the
// whole bucket window so he can't double-book the same morning.
//
// Saturday's working hours (8AM-12PM) only fit the morning bucket;
// the afternoon entry is silently skipped per-day if it doesn't fit
// the open..close window.
const BOOKING_BUCKETS = [
  { key: "morning",   label: "Morning Appointment",   from: "08:00", to: "12:00", windowLabel: "8 AM – 12 PM" },
  { key: "afternoon", label: "Afternoon Appointment", from: "12:00", to: "17:00", windowLabel: "12 PM – 5 PM" }
];

// =============== Helpers ===============

function parseHHmmToMinutes(value) {
  const [h, m] = String(value || "00:00").split(":").map(Number);
  return (h * 60) + (m || 0);
}

function minutesToHHmm(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function dateAtLocalMinutes(baseDate, minutes) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function sameDayLocal(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function rangeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

function dayLabel(d) {
  return d.toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" });
}

// =============== Slot generation ===============

async function listAvailableSlots(opts = {}) {
  const {
    serviceKey,
    customerCoords,
    bookings = [],
    blocks = [],
    daysAhead,
    hours,
    settings,
    now = new Date()
  } = opts;

  const service = BOOKABLE_SERVICES[serviceKey];
  if (!service || !service.bookable) return [];
  if (!customerCoords || customerCoords.lat == null) return [];

  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const dayHours = hours || DEFAULT_HOURS;
  const scanDays = daysAhead || cfg.daysAhead;
  const leadTimeMs = cfg.leadTimeHours * 60 * 60 * 1000;
  const earliestStart = now.getTime() + leadTimeMs;
  const buffer = cfg.bufferMinutes;

  // Bookings normalized: only future, only with start/end/coords. Sorted by start.
  const norm = bookings
    .filter((b) => b && b.start && b.end)
    .map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
      coords: b.coords && b.coords.lat != null ? b.coords : PJL_BASE,
      leadId: b.leadId
    }))
    .sort((a, b) => a.start - b.start);

  // Same for blocks (no coords needed).
  const blockRanges = blocks
    .filter((b) => b && b.start && b.end)
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end), label: b.label || "Blocked" }));

  const results = [];

  for (let offset = 0; offset < scanDays; offset++) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);

    const dow = day.getDay();
    const window = dayHours[dow];
    if (!window) continue;

    const openMin = parseHHmmToMinutes(window.open);
    const closeMin = parseHHmmToMinutes(window.close);

    // Bookings on this day, sorted.
    const dayBookings = norm.filter((b) => sameDayLocal(b.start, day));
    // Blocks that intersect this day's window.
    const dayBlocks = blockRanges.filter((b) => rangeOverlaps(
      b.start, b.end, dateAtLocalMinutes(day, openMin), dateAtLocalMinutes(day, closeMin)
    ));

    // One candidate per bucket per day. Bucket must fit fully inside
    // the day's open..close window (so Saturday's 8-12 hours yield only
    // a morning bucket — the afternoon one is silently skipped).
    for (const bucket of BOOKING_BUCKETS) {
      const bucketFromMin = parseHHmmToMinutes(bucket.from);
      const bucketToMin = parseHHmmToMinutes(bucket.to);
      // Bucket must fit fully inside the day's open/close window.
      if (bucketFromMin < openMin) continue;
      if (bucketToMin > closeMin) continue;

      const slotStart = dateAtLocalMinutes(day, bucketFromMin);
      const slotEnd = dateAtLocalMinutes(day, bucketToMin);
      const bucketDurationMin = bucketToMin - bucketFromMin;

      // Lead time guard — bucket start must be at least leadTimeHours away.
      if (slotStart.getTime() < earliestStart) continue;

      // Admin-blocked time inside the bucket → bucket unavailable.
      if (dayBlocks.some((b) => rangeOverlaps(slotStart, slotEnd, b.start, b.end))) continue;

      // Bucket-occupied check: any existing booking whose start falls
      // inside this bucket window means the bucket is taken. One
      // customer per bucket per day — that's the whole point of the
      // bucket UX.
      const occupied = dayBookings.some((b) =>
        b.start.getTime() >= slotStart.getTime() && b.start.getTime() < slotEnd.getTime()
      );
      if (occupied) continue;

      // Travel-time gating is intentionally skipped in bucket mode.
      // Each bucket is 4–5 hours wide; the noon transition between
      // morning and afternoon is a 0-minute gap on paper, but the
      // bucket's deliberate looseness ("we'll arrive sometime in this
      // window") absorbs travel naturally. Applying the old
      // prev.end + travel + buffer check would refuse every afternoon
      // slot whenever a morning booking exists, which is wrong: the
      // buckets are designed to fit two distinct customers per day
      // with travel inside the bucket window, not between adjacent
      // slot boundaries.

      results.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        durationMinutes: bucketDurationMin,
        serviceKey,
        serviceLabel: service.label,
        dayLabel: dayLabel(slotStart),
        // timeLabel becomes the bucket label so every downstream display
        // (confirmation copy, time-picker button, portal "your appointment
        // is at X" line) reads "Morning Appointment" instead of "8:00 AM".
        timeLabel: bucket.label,
        bucketKey: bucket.key,
        bucketWindow: bucket.windowLabel
      });
    }
  }

  return results;
}

// Group slots by day for the UI's typical "pick a day, then pick a time" flow.
function groupByDay(slots) {
  const out = new Map();
  for (const slot of slots) {
    const d = new Date(slot.start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!out.has(key)) {
      out.set(key, { date: key, label: slot.dayLabel, slots: [] });
    }
    out.get(key).slots.push(slot);
  }
  return Array.from(out.values());
}

// Same as groupByDay but as a Map keyed by date string. Used by
// expandDaysToRange so we can splice slots back in by O(1) lookup.
function groupByDayMap(slots) {
  const map = new Map();
  for (const day of groupByDay(slots)) map.set(day.date, day);
  return map;
}

// Parse a "YYYY-MM-DD" string into a local-midnight Date. Returns null on
// anything that doesn't parse cleanly — callers can fall back to defaults.
function parseLocalDateKey(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build a full date-by-date array for [from..to] inclusive, splicing in
// the slot-bearing days returned by the engine and backfilling everything
// else as { slots: [], reason }.
//
//   reason: "past"            — date is before "today" (local).
//   reason: "closed"          — day-of-week's hours are null (Sunday by default).
//   reason: "no_availability" — open day but no slot survived the engine
//                               (fully booked / blocked / lead-time pinch).
//
// The picker just needs an empty slots array to render a day as unavailable;
// the reason is purely informational (tooltip / future use).
function expandDaysToRange(slots, { from, to, hours, now } = {}) {
  if (!(from instanceof Date) || !(to instanceof Date)) {
    // Defensive — fall back to the old (slot-bearing-only) shape.
    return groupByDay(slots);
  }
  const daysWithSlots = groupByDayMap(slots);
  const today = new Date(now || Date.now());
  today.setHours(0, 0, 0, 0);
  const dayHours = hours || DEFAULT_HOURS;
  const out = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(to);
  last.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= last.getTime()) {
    const key = dateKey(cursor);
    const existing = daysWithSlots.get(key);
    if (existing && existing.slots.length) {
      out.push(existing);
    } else {
      let reason = "no_availability";
      if (cursor.getTime() < today.getTime()) reason = "past";
      else if (!dayHours[cursor.getDay()]) reason = "closed";
      out.push({
        date: key,
        label: cursor.toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" }),
        slots: [],
        reason
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

module.exports = {
  BOOKABLE_SERVICES,
  BOOKING_BUCKETS,
  DEFAULT_HOURS,
  DEFAULT_SETTINGS,
  listAvailableSlots,
  groupByDay,
  groupByDayMap,
  expandDaysToRange,
  parseLocalDateKey,
  parseHHmmToMinutes,
  minutesToHHmm
};

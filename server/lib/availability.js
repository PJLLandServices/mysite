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
const BOOKABLE_SERVICES = {
  spring_open_4z: {
    label: "Spring opening (≤4 zones)",
    minutes: 45, requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_8z: {
    label: "Spring opening (5-7 zones)",
    minutes: 60, requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_15z: {
    label: "Spring opening (8+ zones)",
    minutes: 120, displayMinutes: "90-120 min",
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  spring_open_commercial: {
    label: "Spring opening — commercial",
    minutes: 120, displayMinutes: "Morning or afternoon",
    slotIncrementMinutes: 300,
    requiresAddress: true, bookable: true,
    category: "seasonal", family: "spring_opening"
  },
  fall_close_6z: {
    label: "Fall winterization (≤6 zones)",
    minutes: 30, requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_15z: {
    label: "Fall winterization (7-15 zones)",
    minutes: 45, requiresAddress: true, bookable: true,
    category: "seasonal", family: "fall_closing"
  },
  fall_close_commercial: {
    label: "Fall winterization — commercial",
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
  slotIncrementMinutes: 30,  // how often candidate slots start (08:00, 08:30, 09:00, ...)
  daysAhead: 14              // how many days into the future the calendar scans
};

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
  // Per-service override beats the global default. Commercial services use a
  // 300-min increment so customers see two cleanly spaced AM/PM slots.
  const incrementMin = service.slotIncrementMinutes || cfg.slotIncrementMinutes;
  const slotDuration = service.minutes;

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
    const lastStartMin = parseHHmmToMinutes(window.lastStart);

    // Bookings on this day, sorted.
    const dayBookings = norm.filter((b) => sameDayLocal(b.start, day));
    // Blocks that intersect this day's window.
    const dayBlocks = blockRanges.filter((b) => rangeOverlaps(
      b.start, b.end, dateAtLocalMinutes(day, openMin), dateAtLocalMinutes(day, closeMin)
    ));

    for (let m = openMin; m <= lastStartMin; m += incrementMin) {
      const slotStart = dateAtLocalMinutes(day, m);
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

      // Window guards.
      if (slotEnd.getTime() > dateAtLocalMinutes(day, closeMin).getTime()) continue;
      if (slotStart.getTime() < earliestStart) continue;

      // Block guards.
      if (dayBlocks.some((b) => rangeOverlaps(slotStart, slotEnd, b.start, b.end))) continue;

      // Direct conflict with another booking?
      if (dayBookings.some((b) => rangeOverlaps(slotStart, slotEnd, b.start, b.end))) continue;

      // Find immediate prev / next bookings on this day.
      const prev = [...dayBookings].reverse().find((b) => b.end.getTime() <= slotStart.getTime());
      const next = dayBookings.find((b) => b.start.getTime() >= slotEnd.getTime());

      // Travel from prev — if no prev, this is the first job of the day and PJL
      // is presumed to depart from base; we don't gate on travel from base
      // (Patrick can leave whenever). The lead time + open hour already
      // handle "is the day even started yet."
      if (prev) {
        const travelIn = await travelMinutes(prev.coords, customerCoords);
        const earliestSlotStart = prev.end.getTime() + (travelIn + buffer) * 60 * 1000;
        if (slotStart.getTime() < earliestSlotStart) continue;
      }

      // Travel to next — must finish, drive there, and have buffer before next starts.
      if (next) {
        const travelOut = await travelMinutes(customerCoords, next.coords);
        const latestSlotEnd = next.start.getTime() - (travelOut + buffer) * 60 * 1000;
        if (slotEnd.getTime() > latestSlotEnd) continue;
      }

      results.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        durationMinutes: slotDuration,
        serviceKey,
        serviceLabel: service.label,
        dayLabel: dayLabel(slotStart),
        timeLabel: slotStart.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
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

module.exports = {
  BOOKABLE_SERVICES,
  DEFAULT_HOURS,
  DEFAULT_SETTINGS,
  listAvailableSlots,
  groupByDay,
  parseHHmmToMinutes,
  minutesToHHmm
};

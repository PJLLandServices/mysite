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
//   dayShapes       — optional { "YYYY-MM-DD": { points: [{lat,lng}] } }
//                     from geo-filter.buildDayShapes(). The day's intended
//                     route. A date with a non-empty point set only yields
//                     slots when the customer is cheap to insert into it.
//                     Omit it and the engine behaves exactly as before —
//                     which is what every caller did before the season
//                     plan existed, and what any caller still gets when no
//                     plan is loaded for the season.
//   diagnostics     — optional object; each array the caller provides is
//                     populated:
//                       geoSuppressed: [{ date, label, addedDriveMinutes }]
//                         — "we are not in your area that day"
//                       seasonClosed:  [{ date, publicBookingFrom }] or
//                                      [{ date, publicBookingThrough }]
//                         — the day falls outside the season's public
//                           booking window; the entry names the bound it
//                           hit (before opening vs after the cutoff)
//                       bucketFull:    [{ date, bucket, planned, booked, cap }]
//                         — the bucket's planned stops + unplanned
//                           bookings already fill its capacity
//   seasonWindows   — optional (season, year) => { publicBookingThrough }
//                     override for testing; defaults to
//                     seasons.configFor. See the season gate below.
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
//   9. Cheap to insert into that day's planned route — added drive time
//      ≤ settings.geoMaxAddedDriveMinutes. See dayShapes below.
//  10. Inside the season's public booking window (seasons.json
//      publicBookingFrom .. publicBookingThrough), for seasonal services
//      only
//  11. In a bucket with capacity left, when the day's shape carries a
//      bucketCap from the season plan
//
// Single source of truth for service durations and working hours. To change a
// number, edit the constants at the top. Patrick can override settings via the
// admin schedule UI (writes to server/data/schedule.json).

const { travelMinutes } = require("./distance");
const { PJL_BASE } = require("./geocode");
const geoFilter = require("./geo-filter");
const seasons = require("./seasons");

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
  daysAhead: 14,             // how many days into the future the calendar scans
  // Geography filter. A customer is offered a planned route day only when
  // inserting them costs no more than this much extra driving. 15 min
  // accepts 95.5% of properties that genuinely belong on their day; 20 min
  // accepts 98.5%. Start tight: loosening is one edit, and un-annoying a
  // customer who was double-booked across the region is not.
  // Set to 0 or a negative number to disable the filter entirely.
  geoMaxAddedDriveMinutes: 15
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
    dayShapes = null,
    diagnostics = null,
    seasonWindows = null,
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

  // ---- Season gate setup ---------------------------------------------
  // Seasonal services are publicly bookable only inside the season's
  // [publicBookingFrom .. publicBookingThrough] window (seasons.json).
  // The front holds booking until routes actually run — fall 2026 opens
  // Sep 28, the first planned route day; the back is the frost-stop
  // discipline (fall 2026: Oct 30, keeping Nov 1–6 for admin placement).
  // Only the two seasonal families are gated; repairs, retrofits and site
  // visits book year-round. The lookup FAILS SOFT: a broken seasons.json
  // must degrade to ungated availability, never take the booking page
  // down — the same posture dayShapesForSeason takes when the season plan
  // won't load. Either bound may be absent (null) and then does not gate.
  const seasonName = service.family === "fall_closing" ? "fall"
    : service.family === "spring_opening" ? "spring"
    : null;
  const seasonWindowsFn = seasonWindows || seasons.configFor;
  const seasonBoundsByYear = new Map();
  const seasonBoundsFor = (year) => {
    if (!seasonName) return null;
    if (!seasonBoundsByYear.has(year)) {
      let bounds = null;
      try {
        const cfgSeason = seasonWindowsFn(seasonName, year);
        if (cfgSeason && (cfgSeason.publicBookingFrom || cfgSeason.publicBookingThrough)) {
          bounds = {
            from: cfgSeason.publicBookingFrom || null,
            through: cfgSeason.publicBookingThrough || null
          };
        }
      } catch (err) {
        console.warn("[availability] season window unavailable, no season gate:", err?.message);
      }
      seasonBoundsByYear.set(year, bounds);
    }
    return seasonBoundsByYear.get(year);
  };

  let dayAddedDrive = null;
  for (let offset = 0; offset < scanDays; offset++) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);

    const dow = day.getDay();
    const window = dayHours[dow];
    if (!window) continue;

    // ---- Season gate --------------------------------------------------
    // YYYY-MM-DD strings compare correctly as strings. A gated day emits
    // no buckets at all; the geography filter below never runs for it.
    // The diagnostics entry names the bound it hit, so the calendar can
    // say "booking opens Sep 28" and "the season has wrapped up" as two
    // different things.
    const bounds = seasonBoundsFor(day.getFullYear());
    if (bounds && bounds.from && dateKey(day) < bounds.from) {
      if (diagnostics && Array.isArray(diagnostics.seasonClosed)) {
        diagnostics.seasonClosed.push({ date: dateKey(day), publicBookingFrom: bounds.from });
      }
      continue;
    }
    if (bounds && bounds.through && dateKey(day) > bounds.through) {
      if (diagnostics && Array.isArray(diagnostics.seasonClosed)) {
        diagnostics.seasonClosed.push({ date: dateKey(day), publicBookingThrough: bounds.through });
      }
      continue;
    }

    // ---- Geography filter -------------------------------------------
    // Runs before any slot work: if the customer does not belong on this
    // day's route, no bucket on it should be offered, and there is no
    // point costing out slots we are about to discard.
    //
    // Three ways to be exempt, all deliberate:
    //   - no plan for this date (or an empty shape) — nothing to violate
    //   - the filter is switched off in settings
    //   - the address did not geocode, so we have no honest opinion.
    //     geocode.js hands back the PJL depot on failure; measuring
    //     against that would say every day is cheap. Skipping is the
    //     documented behaviour: never refuse a booking because geocoding
    //     failed.
    // Admin force-book (source: "admin_custom") never reaches this
    // function at all — it bypasses the slot grid entirely — so it is
    // exempt without needing a case here.
    const geoMax = Number(cfg.geoMaxAddedDriveMinutes);
    const shape = dayShapes ? dayShapes[dateKey(day)] : null;
    if (shape && shape.points && shape.points.length
        && Number.isFinite(geoMax) && geoMax > 0
        && geoFilter.coordsAreResolved(customerCoords)) {
      const added = await geoFilter.addedDriveMinutes(customerCoords, shape.points);
      if (added && added.minutes > geoMax) {
        if (diagnostics && Array.isArray(diagnostics.geoSuppressed)) {
          diagnostics.geoSuppressed.push({
            date: dateKey(day),
            label: shape.label || "",
            addedDriveMinutes: added.minutes
          });
        }
        continue;
      }
      dayAddedDrive = added ? added.minutes : null;
    } else {
      dayAddedDrive = null;
    }

    const openMin = parseHHmmToMinutes(window.open);
    const closeMin = parseHHmmToMinutes(window.close);

    // Bookings on this day, sorted.
    const dayBookings = norm.filter((b) => sameDayLocal(b.start, day));
    // Blocks that intersect this day's window.
    const dayBlocks = blockRanges.filter((b) => rangeOverlaps(
      b.start, b.end, dateAtLocalMinutes(day, openMin), dateAtLocalMinutes(day, closeMin)
    ));

    // For each bucket, walk start-times at the configured slot increment
    // (default 30 min) and emit the FIRST candidate that satisfies
    // every constraint — lead time, admin blocks, conflicts with
    // existing bookings, and travel time from prev / to next. Only one
    // slot per bucket per day is surfaced to the customer (labelled
    // "Morning Appointment" or "Afternoon Appointment"), but multiple
    // bookings can still land in the same bucket on subsequent calls —
    // each new caller sees a slot pushed later by travel + duration.
    // When the next candidate would run past bucket.to, the bucket is
    // effectively full and disappears from availability.
    const incrementMin = service.slotIncrementMinutes || cfg.slotIncrementMinutes;
    const slotDuration = service.minutes;

    for (const bucket of BOOKING_BUCKETS) {
      const bucketFromMin = parseHHmmToMinutes(bucket.from);
      const bucketToMin = parseHHmmToMinutes(bucket.to);
      // Bucket must fit fully inside the day's open/close window.
      if (bucketFromMin < openMin) continue;
      if (bucketToMin > closeMin) continue;

      // ---- Bucket capacity (stage 1, docs/ASSIGNMENT_WRITER.md) ------
      // The season plan says how many jobs a bucket holds (bucketCap,
      // default 5) and which stops are already planned into it. The
      // bucket's load is those planned stops PLUS any real booking in the
      // bucket's half of the day that is NOT one of them — a planned
      // customer who books themselves converts their planned stop into a
      // booking, so counting both would charge one house twice. The same
      // rule exempts the requesting customer: if their rounded coordinate
      // is a planned stop of this bucket, their booking adds no load.
      // No shape / no cap / no buckets on the shape → no gate, exactly
      // the pre-stage-1 behaviour.
      if (shape && shape.bucketCap && shape.buckets && shape.buckets[bucket.key]) {
        const planned = shape.buckets[bucket.key];
        const plannedKeys = new Set(planned.keys || []);
        // A booking belongs to the morning bucket when it starts before
        // the afternoon bucket opens, else the afternoon — every same-day
        // booking lands in exactly one bucket, including admin-custom
        // times outside either window.
        const splitMin = parseHHmmToMinutes(BOOKING_BUCKETS[BOOKING_BUCKETS.length - 1].from);
        let extraBooked = 0;
        for (const b of dayBookings) {
          const startMin = (b.start.getHours() * 60) + b.start.getMinutes();
          const bucketOf = startMin < splitMin
            ? BOOKING_BUCKETS[0].key
            : BOOKING_BUCKETS[BOOKING_BUCKETS.length - 1].key;
          if (bucketOf !== bucket.key) continue;
          if (plannedKeys.has(geoFilter.pointKey(b.coords))) continue;
          extraBooked += 1;
        }
        const incoming = geoFilter.coordsAreResolved(customerCoords)
          && plannedKeys.has(geoFilter.pointKey(customerCoords)) ? 0 : 1;
        if (planned.count + extraBooked + incoming > shape.bucketCap) {
          if (diagnostics && Array.isArray(diagnostics.bucketFull)) {
            diagnostics.bucketFull.push({
              date: dateKey(day),
              bucket: bucket.key,
              planned: planned.count,
              booked: extraBooked,
              cap: shape.bucketCap
            });
          }
          continue;
        }
      }

      let emitted = false;
      for (let m = bucketFromMin; m + slotDuration <= bucketToMin && !emitted; m += incrementMin) {
        const slotStart = dateAtLocalMinutes(day, m);
        const slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

        if (slotStart.getTime() < earliestStart) continue;
        if (dayBlocks.some((b) => rangeOverlaps(slotStart, slotEnd, b.start, b.end))) continue;
        if (dayBookings.some((b) => rangeOverlaps(slotStart, slotEnd, b.start, b.end))) continue;

        // Travel from prev booking (anywhere earlier today) + buffer.
        const prev = [...dayBookings].reverse().find((b) => b.end.getTime() <= slotStart.getTime());
        if (prev) {
          const travelIn = await travelMinutes(prev.coords, customerCoords);
          const earliestSlotStart = prev.end.getTime() + (travelIn + buffer) * 60 * 1000;
          if (slotStart.getTime() < earliestSlotStart) continue;
        }

        // Travel to next booking + buffer must fit before the next visit.
        const next = dayBookings.find((b) => b.start.getTime() >= slotEnd.getTime());
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
          // The bucket label is the ONLY customer-visible time on the
          // booking flow / confirmation / portal — precise start times
          // stay server-side for Patrick's scheduling.
          timeLabel: bucket.label,
          bucketKey: bucket.key,
          bucketWindow: bucket.windowLabel,
          // How much extra driving serving this address on this day costs
          // against the planned route. null when the day has no planned
          // shape or the filter was skipped. Admin-facing: the customer
          // never sees it, but the settle board and the standby-fill
          // screen both rank on exactly this number.
          addedDriveMinutes: dayAddedDrive
        });
        emitted = true;
      }
    }
  }

  return results;
}

// Suggest the customer's best days (Patrick, 2026-09-02: "we never
// suggest to customers the best possible day for them to book").
// Ranks offered days by how cheaply this address joins that day's
// existing route — the slot-level addedDriveMinutes the geography gate
// already computed and, until now, threw away on the public path. Only
// days that HAVE a cost are candidates: a day with no shape at all
// costs a dedicated trip, the opposite of the dedicated-routes pitch,
// so an empty calendar gets no fake stars. Marks the top `max` day
// rows with recommended: true (and mirrors the cost at day level for
// the admin probe); returns the same array, annotated in place.
function recommendDays(days, { max = 3 } = {}) {
  const cap = Number(max) > 0 ? Number(max) : 3;
  const candidates = (days || []).filter((d) => d && Array.isArray(d.slots) && d.slots.length
    && Number.isFinite(d.slots[0]?.addedDriveMinutes));
  candidates.sort((a, b) => a.slots[0].addedDriveMinutes - b.slots[0].addedDriveMinutes);
  for (const d of candidates.slice(0, cap)) {
    d.recommended = true;
    d.addedDriveMinutes = d.slots[0].addedDriveMinutes;
  }
  return days;
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
//   reason: "outside_route_area" — the day has a planned route and this
//                               customer is too far off it. A distinct
//                               reason because it needs distinct copy:
//                               "we're in your area on these dates" reads
//                               very differently from a bare empty
//                               calendar, which customers read as "they
//                               have no availability".
//   reason: "season_not_open" — the day falls before the season's
//                               publicBookingFrom. "Booking opens Sep 28"
//                               copy, not "we're full".
//   reason: "season_closed"   — the day falls after the season's
//                               publicBookingThrough cutoff. "The season
//                               has wrapped up" copy, not "we're full".
//
// The picker just needs an empty slots array to render a day as unavailable;
// the reason is purely informational (tooltip / future use).
function expandDaysToRange(slots, { from, to, hours, now, geoSuppressed = [], seasonClosed = [] } = {}) {
  if (!(from instanceof Date) || !(to instanceof Date)) {
    // Defensive — fall back to the old (slot-bearing-only) shape.
    return groupByDay(slots);
  }
  const daysWithSlots = groupByDayMap(slots);
  const suppressed = new Map((geoSuppressed || []).map((g) => [g.date, g]));
  const closedSeason = new Map((seasonClosed || []).map((g) => [g.date, g]));
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
      else if (closedSeason.has(key)) {
        reason = closedSeason.get(key).publicBookingFrom ? "season_not_open" : "season_closed";
      }
      else if (suppressed.has(key)) reason = "outside_route_area";
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
  recommendDays,
  parseLocalDateKey,
  parseHHmmToMinutes,
  minutesToHHmm
};

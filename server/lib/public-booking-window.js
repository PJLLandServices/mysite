// Public booking window — the seasonal gate for customer-facing availability.
//
// seasons.json defines three dates per season. Two of them had no consumer
// before this module existed:
//
//   serviceableFrom      first day a truck rolls
//   serviceableThrough   last day a truck rolls (the hard frost stop in fall)
//   publicBookingThrough last day the PUBLIC flow accepts a self-serve booking
//
// seasons.json says of the third field: "NOTHING CONSUMES THIS FIELD YET. It is
// defined ahead of the seasonal gate planned for server/lib/availability.js."
// This is that gate. It reads the same seasons.json every other seasonal
// surface reads, so there is no second copy of the dates to drift.
//
// WHAT IT FIXES (measured against a live server on 2026-08-30): the booking
// page let a customer pick a FALL CLOSING on 2026-12-26 — fifty days past the
// Nov 6 frost stop — and a SPRING OPENING in December. The availability engine
// scans forward from "now" and never knew what season a service belonged to,
// so every bookable service was offered on every open day inside the scan.
//
// WHERE IT APPLIES — public surfaces only:
//   /api/booking/availability             when no staff session is present
//   /api/portal/:token/reschedule-availability   (always — token, not staff)
//
// Admin and tech keep the full scan window. Patrick placing a job in November
// is deliberate advance scheduling; a customer doing it is a job that cannot
// be performed. That asymmetry is the whole point of publicBookingThrough
// being a separate date from serviceableThrough — fall 2026 reserves Nov 1-6
// for admin placement.
//
// NON-SEASONAL SERVICES ARE NOT GATED. sprinkler_repair, hydrawise_retrofit
// and site_visit run year-round and pass through untouched.
//
// FAILURE MODE — fails CLOSED, deliberately. If seasons.json is missing or
// malformed, seasons.js throws from every accessor and this module lets that
// throw reach the route, which surfaces it as a visible booking error. The
// alternative — skipping the gate when the dates can't be read — silently
// restores the exact defect this module exists to prevent, and does it
// invisibly. A booking outage gets a phone call within the hour; unperformable
// work sold in December is not discovered until November. seasons.json's own
// doctrine is that a silent fallback window must never happen.

const seasons = require("./seasons");
// Single source for the service-key prefixes. outreach.js already owns this
// map for "is this property booked for the season?"; importing it means the
// gate and the outreach candidate list can never disagree about which keys
// are seasonal.
const { SEASONAL_SERVICE_PREFIXES } = require("./outreach");

// Local YYYY-MM-DD. Deliberately not toISOString() — that shifts across
// midnight UTC and would move an 8 PM Toronto slot onto the next day.
// server.js pins process.env.TZ = "America/Toronto" at boot.
function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "fall_close_8z" -> "fall". Returns null for a year-round service, which
// is the signal to leave it alone.
function seasonForServiceKey(serviceKey) {
  const key = String(serviceKey || "");
  for (const [season, prefix] of Object.entries(SEASONAL_SERVICE_PREFIXES)) {
    if (key.startsWith(prefix)) return season;
  }
  return null;
}

// Is this calendar day inside the season's PUBLIC booking window?
//
// Resolved per-day against that day's OWN year, not the year of "now". A
// customer looking in December at a spring service is looking at next
// spring, and gets next spring's window — not this year's, which closed in
// June. Without that, paging forward past New Year would silently offer
// nothing for a season that is genuinely open.
function isPubliclyBookableOn(serviceKey, date) {
  const season = seasonForServiceKey(serviceKey);
  if (!season) return true;                 // year-round service — not gated
  const key = localDateKey(date);
  if (!key) return false;
  const cfg = seasons.configFor(season, Number(key.slice(0, 4)));
  if (!cfg) return false;
  // String compare is safe and exact on zero-padded YYYY-MM-DD.
  return key >= cfg.serviceableFrom && key <= cfg.publicBookingThrough;
}

// Drop out-of-season slots. Applied BEFORE grouping so both response shapes
// (groupByDay for legacy callers, expandDaysToRange for the picker) inherit
// the filter without either needing to know about seasons.
function filterSlots(slots, serviceKey) {
  if (!Array.isArray(slots)) return [];
  if (!seasonForServiceKey(serviceKey)) return slots;
  return slots.filter((s) => isPubliclyBookableOn(serviceKey, new Date(s.start)));
}

// Relabel the picker's per-day `reason` so an out-of-season day says so
// instead of the generic "no_availability". Presentation/diagnostic only —
// filterSlots has already removed the slots. The picker renders any
// slotless day as disabled either way, so this changes no customer-visible
// behaviour today; it makes the response honest for anyone reading it.
function annotateDays(days, serviceKey) {
  if (!Array.isArray(days)) return days;
  if (!seasonForServiceKey(serviceKey)) return days;
  return days.map((day) => {
    if (!day || !day.date) return day;
    if (day.slots && day.slots.length) return day;
    if (isPubliclyBookableOn(serviceKey, parseDayKey(day.date))) return day;
    return { ...day, reason: "out_of_season" };
  });
}

// "2026-11-07" -> local Date at midnight. Same parsing availability.js uses
// for its own date keys.
function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

module.exports = {
  seasonForServiceKey,
  isPubliclyBookableOn,
  filterSlots,
  annotateDays,
  // Test surface.
  localDateKey
};

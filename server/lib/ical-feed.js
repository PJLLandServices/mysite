// iCal feed generator — builds a single .ics document subscribers can
// hit via GET /calendar/<token>.ics. Read-only by design; the token in
// the URL is the credential. No reply / write-back path.
//
// Output rules (Brief C):
//   - Include confirmed bookings only (cancelled/completed/no_show/tentative
//     are filtered out — completed isn't useful in a "what's on the
//     calendar going forward" feed)
//   - Window: now - 90 days .. now + 365 days
//   - Title format: "<ServiceShortName> - <Street>, <City>"
//   - Location: full address, comma-escaped (iOS turns it into a Maps tap)
//   - Description: customer name, zone count, service notes
//   - URL: /admin/work-order/<wo-id> if linked, else /admin/booking/<id>
//   - Toronto timezone via embedded VTIMEZONE block
//
// The UID is stable across reschedules (`BK-YYYY-NNNN@pjllandservices.com`)
// so iCal subscribers update the existing event rather than spawning a
// duplicate.

const bookings = require("./bookings");
const settings = require("./settings");
const { BOOKABLE_SERVICES } = require("./availability");
const {
  escapeIcalValue,
  joinIcal,
  formatLocalDateTime,
  formatUtcDateTime,
  TORONTO_VTIMEZONE
} = require("./ical-format");

// Brief C §3.3 — short title prefix per service family. Falls back to
// the bookable service label if a family doesn't have a short name (so
// new services don't silently break the feed).
const FAMILY_SHORT_NAMES = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  sprinkler_repair: "Sprinkler Repair",
  hydrawise_retrofit: "Hydrawise Install",
  site_visit: "Site Visit"
};

const PAST_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MIN = 60;

// Pull street + city out of a PJL address. Address typically comes in
// as a multi-line string ("21 Hill Country Drive\nStouffville ON L4A 1A1\nCanada")
// but commas also delimit some flows. Strips province + postal off the
// city when present.
function extractStreetAndCity(address) {
  if (!address) return { street: "", city: "" };
  const parts = String(address).split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  const street = parts[0] || "";
  let city = parts[1] || "";
  city = city.replace(/\s+ON\b.*$/i, "").trim();
  return { street, city };
}

// Resolve the human-facing title prefix. Prefers FAMILY_SHORT_NAMES; if
// the service has no family or an unknown one, falls back to the
// bookable service label (trimmed of the parenthetical tier suffix).
function shortServiceName(booking) {
  const svc = BOOKABLE_SERVICES[booking.serviceKey];
  if (svc?.family && FAMILY_SHORT_NAMES[svc.family]) {
    return FAMILY_SHORT_NAMES[svc.family];
  }
  // Strip parenthetical detail ("Spring opening (1-4 zones residential)" -> "Spring opening")
  const label = booking.serviceLabel || svc?.label || "Appointment";
  return label.replace(/\s*\(.*?\)\s*$/, "").trim();
}

// Build the VEVENT block for one booking. Returns an array of lines.
function buildVevent(booking, { baseUrl, now }) {
  const start = new Date(booking.scheduledFor);
  const duration = Number(booking.durationMinutes) || DEFAULT_DURATION_MIN;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const uid = `${booking.id}@pjllandservices.com`;
  const { street, city } = extractStreetAndCity(booking.address);
  const titlePrefix = shortServiceName(booking);
  const locationParts = [street, city].filter(Boolean).join(", ");
  const summary = locationParts
    ? `${titlePrefix} - ${locationParts}`
    : titlePrefix;

  // Description: customer name, zone count, service notes. Each on its
  // own line; iCal joins with literal \n in the property value.
  const descLines = [];
  if (booking.customerName) descLines.push(`Customer: ${booking.customerName}`);
  if (booking.customerPhone) descLines.push(`Phone: ${booking.customerPhone}`);
  if (booking.zoneCount != null && booking.zoneCount !== "") {
    descLines.push(`${booking.zoneCount} zones`);
  }
  if (booking.prepNotes) descLines.push(`Notes: ${booking.prepNotes}`);
  const description = descLines.join("\n");

  // Link target: linked WO if any, otherwise the booking detail page.
  const woId = Array.isArray(booking.workOrderIds) && booking.workOrderIds.length
    ? booking.workOrderIds[0]
    : null;
  const linkPath = woId
    ? `/admin/work-order/${encodeURIComponent(woId)}`
    : `/admin/booking/${encodeURIComponent(booking.id)}`;
  const url = `${baseUrl}${linkPath}`;

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatUtcDateTime(now)}`,
    `DTSTART;TZID=America/Toronto:${formatLocalDateTime(start)}`,
    `DTEND;TZID=America/Toronto:${formatLocalDateTime(end)}`,
    `SUMMARY:${escapeIcalValue(summary)}`
  ];
  if (booking.address) {
    lines.push(`LOCATION:${escapeIcalValue(booking.address)}`);
  }
  if (description) {
    lines.push(`DESCRIPTION:${escapeIcalValue(description)}`);
  }
  lines.push(`URL:${escapeIcalValue(url)}`);
  lines.push("END:VEVENT");
  return lines;
}

// Wrap the events in the calendar envelope. PRODID identifies PJL as the
// generator; X-WR-CALNAME is the display name iOS / Google show in their
// calendar list; X-WR-TIMEZONE is a non-standard hint some clients prefer.
function wrapCalendar(eventLines) {
  return joinIcal([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PJL Land Services//PJL Schedule Feed 1.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:PJL Land Services",
    "X-WR-TIMEZONE:America/Toronto",
    ...TORONTO_VTIMEZONE,
    ...eventLines,
    "END:VCALENDAR",
    "" // trailing CRLF for well-formed file
  ]);
}

// Public entrypoint. Returns:
//   { ok: true, ics: <string>, eventCount }   on success
//   { ok: false, status: 404 }                on token mismatch / disabled
//
// We deliberately return 404 (not 401) on auth failure so the URL leaks
// no information — there's no way to tell from the response whether the
// endpoint exists, whether the token is wrong, or whether the feed is
// disabled.
async function generateIcsForToken(token, { baseUrl = "https://pjllandservices.com" } = {}) {
  const cfg = await settings.get();
  const feed = cfg.icalFeed || {};
  if (!feed.enabled || !feed.token) return { ok: false, status: 404 };
  if (typeof token !== "string" || token.length !== feed.token.length) {
    return { ok: false, status: 404 };
  }
  // Constant-time compare to avoid timing-leak token guesses.
  const a = Buffer.from(feed.token);
  const b = Buffer.from(token);
  const crypto = require("node:crypto");
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, status: 404 };

  const all = await bookings.list();
  const now = new Date();
  const earliest = new Date(now.getTime() - PAST_WINDOW_MS);
  const latest = new Date(now.getTime() + FUTURE_WINDOW_MS);
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");

  const events = [];
  let included = 0;
  for (const b of all) {
    if (b.status !== "confirmed") continue;
    if (!b.scheduledFor) continue;
    const start = new Date(b.scheduledFor);
    if (Number.isNaN(start.getTime())) continue;
    if (start < earliest || start > latest) continue;
    // Skip bookings with no address (rare but possible from legacy data).
    if (!b.address || !String(b.address).trim()) continue;
    events.push(...buildVevent(b, { baseUrl: cleanBase, now }));
    included++;
  }

  const ics = wrapCalendar(events);
  return { ok: true, ics, eventCount: included };
}

module.exports = {
  generateIcsForToken,
  // Exported for unit-style tests + the smoke script.
  FAMILY_SHORT_NAMES,
  extractStreetAndCity,
  shortServiceName,
  buildVevent,
  wrapCalendar
};

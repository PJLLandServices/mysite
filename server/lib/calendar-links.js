// "Add your appointment to your calendar" — Patrick's ask alongside the
// day-before reminder: a booked customer should be able to drop their
// visit into Google, Outlook, or Apple Calendar in one tap.
//
// Three artifacts from one event description:
//   googleUrl(event)   — calendar.google.com prefilled-compose link
//   outlookUrl(event)  — outlook.live.com prefilled-compose link
//   icsText(event)     — a single-VEVENT .ics file (Apple Calendar and
//                        everything else), served by the tokened
//                        endpoints in server.js
//
// THE TIME THE CUSTOMER WAS TOLD, never the internal one. Patrick's
// standing rule: customers never see a precise arrival time — they get
// the bucket ("Morning, 8 AM – 12 PM"), and the sequencer moves the
// real arrival around inside it. So eventForBooking() builds the event
// on the BUCKET's bounds whenever the booking carries a bucket
// (assignment bookings always; public-flow bookings since bucket-mode),
// and falls back to the exact start + duration only for legacy bookings
// that never had one. A calendar block reading 8:13–8:43 would be a
// promise the route optimiser breaks daily.
//
// Pure — no I/O, no env. Tested by scripts/test-calendar-links.mjs.

const { BOOKING_BUCKETS } = require("./availability");

// UTC stamp for ics/google/outlook: 20261001T120000Z. Input is a real
// Date (already an absolute instant); this only formats it.
function utcStamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

// ics TEXT escaping per RFC 5545 §3.3.11 — backslash first, then the
// characters that would otherwise structure the line.
function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Local wall-clock time on the booking's local date → absolute Date.
// process.env.TZ is America/Toronto server-wide, so the Date
// constructor speaks the customer's clock.
function atLocalTime(onDate, hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return new Date(onDate.getFullYear(), onDate.getMonth(), onDate.getDate(), h || 0, m || 0, 0, 0);
}

// One normalized event from a booking-ish record:
//   { scheduledFor | start, durationMinutes, serviceLabel, address,
//     bucketKey?  — "morning" | "afternoon", or assignment.bucket }
// plus { portalUrl } for the description's manage link.
function eventForBooking(booking, { portalUrl = "" } = {}) {
  const startIso = booking?.scheduledFor || booking?.start;
  const start = startIso ? new Date(startIso) : null;
  if (!start || Number.isNaN(start.getTime())) return null;

  const bucketKey = booking?.assignment?.bucket || booking?.bucketKey || null;
  const bucket = bucketKey ? BOOKING_BUCKETS.find((b) => b.key === bucketKey) : null;

  let eventStart, eventEnd;
  if (bucket) {
    eventStart = atLocalTime(start, bucket.from);
    eventEnd = atLocalTime(start, bucket.to);
  } else {
    eventStart = start;
    const minutes = Number(booking?.durationMinutes) > 0 ? Number(booking.durationMinutes) : 60;
    eventEnd = new Date(start.getTime() + minutes * 60 * 1000);
  }

  const serviceLabel = booking?.serviceLabel || "PJL Land Services appointment";
  const details = [
    bucket ? `Arrival window: ${bucket.windowLabel}.` : "",
    portalUrl ? `Manage your appointment: ${portalUrl}` : "",
    "Questions? Call or text PJL Land Services at (905) 960-0181."
  ].filter(Boolean).join("\n");

  return {
    title: `PJL Land Services — ${serviceLabel}`,
    start: eventStart,
    end: eventEnd,
    location: String(booking?.address || "").trim(),
    details,
    uid: `pjl-${booking?.id || booking?.leadId || utcStamp(eventStart)}@pjllandservices.com`
  };
}

function googleUrl(event) {
  if (!event) return "";
  const u = new URL("https://calendar.google.com/calendar/render");
  u.searchParams.set("action", "TEMPLATE");
  u.searchParams.set("text", event.title);
  u.searchParams.set("dates", `${utcStamp(event.start)}/${utcStamp(event.end)}`);
  if (event.details) u.searchParams.set("details", event.details);
  if (event.location) u.searchParams.set("location", event.location);
  return u.toString();
}

function outlookUrl(event) {
  if (!event) return "";
  const u = new URL("https://outlook.live.com/calendar/0/deeplink/compose");
  u.searchParams.set("path", "/calendar/action/compose");
  u.searchParams.set("rru", "addevent");
  u.searchParams.set("subject", event.title);
  // Outlook's deeplink wants ISO 8601 with the zone explicit.
  u.searchParams.set("startdt", event.start.toISOString());
  u.searchParams.set("enddt", event.end.toISOString());
  if (event.details) u.searchParams.set("body", event.details);
  if (event.location) u.searchParams.set("location", event.location);
  return u.toString();
}

function icsText(event) {
  if (!event) return "";
  // CRLF line endings per RFC 5545; UTC times so no VTIMEZONE block is
  // needed and every client agrees on the instant.
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PJL Land Services//Appointment//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(event.uid)}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    event.location ? `LOCATION:${icsEscape(event.location)}` : null,
    event.details ? `DESCRIPTION:${icsEscape(event.details)}` : null,
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n") + "\r\n";
}

// Everything a UI needs, in one call.
function linksForBooking(booking, opts = {}) {
  const event = eventForBooking(booking, opts);
  if (!event) return null;
  return { google: googleUrl(event), outlook: outlookUrl(event), event };
}

module.exports = { eventForBooking, googleUrl, outlookUrl, icsText, linksForBooking, utcStamp, icsEscape };

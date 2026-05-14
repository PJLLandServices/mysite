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

// Build the LOCATION value in the exact form iOS auto-recognizes for
// the Maps tap affordance:
//   "<House Number> <Street Name>, <Town>, ON <Postal Code>, Canada"
// Single-line, comma-separated, province + postal as one segment.
//
// Prefers the lead's structured contact fields (set by applyCrmUpdate
// at intake / edit time); falls back to parsing the booking.address
// blob when the lead is missing structured data (legacy records).
function formatMapsAddress(lead, booking) {
  const c = (lead && lead.contact) || {};
  const sn = String(c.streetNumber || "").trim();
  const sname = String(c.streetName || "").trim();
  const town = String(c.town || "").trim();
  const postal = String(c.postalCode || "").trim();
  if (sn && sname && town) {
    const street = `${sn} ${sname}`;
    const provincePostal = `ON${postal ? " " + postal : ""}`;
    return [street, town, provincePostal, "Canada"].join(", ");
  }
  // Parsing fallback for legacy data without structured contact fields.
  const raw = String(booking?.address || "").trim();
  if (!raw) return "";
  // Split on newlines first (the PJL canonical multi-line form), then
  // commas (already-flattened cases). Filter empties.
  const lines = raw.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  // Detect the "<Town> ON <Postal>" line and split city from province.
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s+(ON\b[\s\S]*)$/i);
    if (m) {
      out.push(m[1].trim());
      out.push(m[2].trim());
    } else {
      // Already comma-separated? Push individual parts.
      const innerCommas = line.split(",").map((p) => p.trim()).filter(Boolean);
      if (innerCommas.length > 1) {
        for (const ic of innerCommas) out.push(ic);
      } else {
        out.push(line);
      }
    }
  }
  return out.join(", ");
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
// `lead` (optional) is the resolved lead record for this booking — we
// prefer its structured contact fields when available so the LOCATION
// renders in the form iOS auto-recognizes for the Maps tap.
function buildVevent(booking, { baseUrl, now, lead = null }) {
  const start = new Date(booking.scheduledFor);
  const duration = Number(booking.durationMinutes) || DEFAULT_DURATION_MIN;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const uid = `${booking.id}@pjllandservices.com`;

  // The Maps-tappable address goes into LOCATION. Title's "<service> -
  // <street>, <city>" tail comes from the same source so the two stay
  // consistent. When the lead has structured contact fields they win;
  // otherwise we parse booking.address.
  const mapsAddress = formatMapsAddress(lead, booking);
  let street = "";
  let city = "";
  if (lead && lead.contact) {
    const c = lead.contact;
    const sn = String(c.streetNumber || "").trim();
    const sname = String(c.streetName || "").trim();
    if (sn && sname) street = `${sn} ${sname}`;
    if (c.town) city = String(c.town).trim();
  }
  if (!street || !city) {
    const parsed = extractStreetAndCity(booking.address);
    if (!street) street = parsed.street;
    if (!city) city = parsed.city;
  }

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
  if (mapsAddress) {
    lines.push(`LOCATION:${escapeIcalValue(mapsAddress)}`);
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
//
// `leads` is the full leads array (passed from server.js because
// readLeads lives there to avoid a circular dep). We use it to:
//   1. Heal lead.booking → canonical bookings.json for any leads whose
//      booking hasn't been upserted yet (fixes "I have 4 bookings but
//      only 2 show up" — see /admin/schedule reads /api/quotes which
//      iterates lead.booking; the feed reads bookings.json which only
//      contains records that went through upsertFromLead).
//   2. Look up the lead per booking so we can format the address from
//      structured contact fields for the iOS Maps tap.
async function generateIcsForToken(token, { baseUrl = "https://pjllandservices.com", leads = [] } = {}) {
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

  // Heal: any lead with a real lead.booking that doesn't have a
  // canonical bookings.json record gets upserted now. Idempotent — if
  // the canonical record exists, upsertFromLead refreshes it without
  // duplicating. Failures are swallowed so one bad lead doesn't break
  // the feed for the rest.
  let initialBookings = await bookings.list();
  const canonicalByLead = new Set(initialBookings.map((b) => b.leadId).filter(Boolean));
  let healed = false;
  for (const lead of leads) {
    if (!lead?.booking?.start) continue;
    if (canonicalByLead.has(lead.id)) continue;
    try {
      const upserted = await bookings.upsertFromLead(lead);
      if (upserted) healed = true;
    } catch (_) { /* skip silently — feed still emits everything else */ }
  }
  const all = healed ? await bookings.list() : initialBookings;

  const leadById = new Map();
  for (const lead of leads) {
    if (lead && lead.id) leadById.set(lead.id, lead);
  }

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
    // No longer skip on empty address — we'll just omit LOCATION if we
    // can't resolve one. The event still shows on Patrick's calendar
    // and the title carries the customer's identifier.
    const lead = b.leadId ? leadById.get(b.leadId) || null : null;
    events.push(...buildVevent(b, { baseUrl: cleanBase, now, lead }));
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
  formatMapsAddress,
  shortServiceName,
  buildVevent,
  wrapCalendar
};

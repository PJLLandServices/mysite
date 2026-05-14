// Low-level iCalendar (RFC 5545) formatting helpers. Hand-rolled because
// pulling in an ical library for ~150 lines of formatting violates the
// "no framework / no transpile" rule the repo lives by.
//
// What this module owns:
//   - escapeIcalValue()    -- escape ; , \ and newlines per RFC 5545 §3.3.11
//   - foldLine()           -- 75-octet line folding with leading-space
//                             continuation (§3.1)
//   - formatLocalDateTime  -- America/Toronto local times as DTSTART/DTEND
//                             values (YYYYMMDDTHHmmss, no Z)
//   - formatUtcDateTime    -- UTC stamps for DTSTAMP (always Z)
//   - TORONTO_VTIMEZONE    -- canned VTIMEZONE block; covers DST through
//                             at least 2099 via the standard EST/EDT rules.

// RFC 5545 §3.3.11 — TEXT property values escape these four character
// sequences. Note: backslash MUST be escaped first or the others
// double-escape. Newlines collapse to literal \n in the output.
function escapeIcalValue(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 §3.1 line-folding. Each "content line" must be ≤ 75 octets;
// longer lines wrap with CRLF + a single leading space so consumers
// stitch them back without inserting whitespace.
//
// We measure octets via TextEncoder so multi-byte UTF-8 (e.g. emoji in
// a customer note) doesn't blow past the 75-octet limit when measured
// in code units. The first line gets the full 75; continuations get 74
// (the leading space is part of the line).
function foldLine(line) {
  if (line.length === 0) return "";
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;
  const dec = new TextDecoder();
  const out = [];
  let pos = 0;
  while (pos < bytes.length) {
    const max = out.length === 0 ? 75 : 74;
    let end = Math.min(pos + max, bytes.length);
    // Don't slice mid-codepoint — back off until the next byte is the
    // start of a UTF-8 sequence (top two bits != 10).
    while (end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--;
    const chunk = dec.decode(bytes.subarray(pos, end));
    out.push((out.length === 0 ? "" : " ") + chunk);
    pos = end;
  }
  return out.join("\r\n");
}

// Build the full feed as a CRLF-delimited string of folded lines.
// Pass an array of plain lines; each gets folded individually.
function joinIcal(lines) {
  return lines.map(foldLine).join("\r\n");
}

// LOCAL Toronto datetime: YYYYMMDDTHHmmss (no Z) paired with TZID=…
// in the property parameter. Caller is responsible for emitting the
// TZID parameter on the line (e.g. DTSTART;TZID=America/Toronto:…).
//
// IMPORTANT: the server is configured with process.env.TZ=America/Toronto
// at boot, so toLocaleString in en-CA returns Toronto wall-clock time.
// We re-parse that into the iCal-required compact format here.
function pad2(n) { return String(n).padStart(2, "0"); }

function formatLocalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  // Build the components using Intl with America/Toronto explicitly so
  // we're not at the mercy of the host TZ env (defence-in-depth).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  // Intl en-CA reports hour=24 at midnight (instead of 00) in some node
  // builds; normalize.
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}${map.month}${map.day}T${hour}${map.minute}${map.second}`;
}

function formatUtcDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  // Always UTC with Z suffix per RFC 5545 §3.3.5 form #2.
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
       + `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

// Canned VTIMEZONE for America/Toronto. Covers the standard US/Canada
// DST rules: spring forward 2nd Sunday of March, fall back 1st Sunday
// of November. Apple Calendar + Google Calendar + Outlook all read
// RRULE-based transitions correctly. No DTSTART manipulation needed —
// the embedded ranges are fixed reference points the BYDAY rules expand.
const TORONTO_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Toronto",
  "X-LIC-LOCATION:America/Toronto",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE"
];

module.exports = {
  escapeIcalValue,
  foldLine,
  joinIcal,
  formatLocalDateTime,
  formatUtcDateTime,
  TORONTO_VTIMEZONE
};

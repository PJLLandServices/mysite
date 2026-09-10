// Add-to-calendar links — Google / Outlook / .ics from one event.
//
//   node scripts/test-calendar-links.mjs
//
// WHAT THIS PROTECTS. The calendar block a customer saves is a written
// promise. Two rules matter more than the formats: the event carries
// the BUCKET window the customer was told (8–12 / 12–5), never the
// sequenced internal arrival — and every timestamp converts to UTC
// correctly from Toronto wall-clock, because a block that lands an hour
// off is worse than no block at all.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cal = require(path.join(ROOT, "server/lib/calendar-links.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 1. The bucket rule ----------------------------------------------
// An assignment booking scheduled internally for 8:13 must produce an
// 8:00–12:00 event — the window the customer was promised.

const assignmentBooking = {
  id: "BK-2026-0042",
  scheduledFor: new Date(2026, 9, 1, 8, 13).toISOString(),   // Oct 1, 8:13 EDT
  durationMinutes: 30,
  serviceLabel: "Fall winterization (7-8 zones residential)",
  address: "44 Aspen Leaf Ct, Aurora, ON L4G 7T3, Canada",
  assignment: { bucket: "morning" }
};
const ev = cal.eventForBooking(assignmentBooking, { portalUrl: "https://pjllandservices.com/a/tok" });
ok("a morning assignment books the FULL bucket, not the sequenced arrival",
  ev.start.getHours() === 8 && ev.start.getMinutes() === 0
  && ev.end.getHours() === 12 && ev.end.getMinutes() === 0,
  `${ev.start.toISOString()} → ${ev.end.toISOString()}`);
ok("the title names the service", /Fall winterization/.test(ev.title) && /PJL/.test(ev.title));
ok("the details carry the window and the manage link",
  /8 AM – 12 PM/.test(ev.details) && /\/a\/tok/.test(ev.details));

const afternoon = cal.eventForBooking({ ...assignmentBooking, assignment: { bucket: "afternoon" },
  scheduledFor: new Date(2026, 9, 1, 13, 40).toISOString() });
ok("an afternoon bucket is 12:00–17:00",
  afternoon.start.getHours() === 12 && afternoon.end.getHours() === 17);

// A self-booked (lead-shaped) record carries bucketKey directly.
const leadStyle = cal.eventForBooking({
  id: "L-1", start: new Date(2026, 9, 1, 8, 0).toISOString(),
  bucketKey: "morning", serviceLabel: "Fall Closing", address: "1 Elm St, Newmarket, ON"
});
ok("a lead booking's bucketKey gets the same treatment",
  leadStyle.start.getHours() === 8 && leadStyle.end.getHours() === 12);

// No bucket at all (legacy): exact start + duration, default 60.
const exact = cal.eventForBooking({ id: "X", start: new Date(2026, 9, 1, 9, 30).toISOString(), durationMinutes: 45 });
ok("no bucket falls back to start + duration",
  exact.start.getHours() === 9 && exact.start.getMinutes() === 30
  && (exact.end - exact.start) === 45 * 60 * 1000);
ok("no duration defaults to an hour",
  (cal.eventForBooking({ id: "X", start: new Date(2026, 9, 1, 9, 0).toISOString() }).end
   - cal.eventForBooking({ id: "X", start: new Date(2026, 9, 1, 9, 0).toISOString() }).start) === 60 * 60 * 1000);
ok("no date at all is null, not a crash", cal.eventForBooking({}) === null && cal.eventForBooking(null) === null);

// ---- 2. UTC conversion (the hour-off bug this file exists to prevent) --
// Oct 1 2026 is EDT (UTC-4): 8:00 Toronto = 12:00Z.

ok("Toronto 8 AM in October stamps as 12:00Z", cal.utcStamp(ev.start) === "20261001T120000Z");
ok("…and the bucket end as 16:00Z", cal.utcStamp(ev.end) === "20261001T160000Z");
// Dec is EST (UTC-5): 8:00 Toronto = 13:00Z.
const winter = cal.eventForBooking({ id: "W", start: new Date(2026, 11, 15, 8, 0).toISOString(), bucketKey: "morning" });
ok("standard time converts with the winter offset", cal.utcStamp(winter.start) === "20261215T130000Z");

// ---- 3. The three formats --------------------------------------------

const g = cal.googleUrl(ev);
ok("the Google link is a prefilled TEMPLATE with the UTC range",
  g.startsWith("https://calendar.google.com/calendar/render")
  && g.includes("action=TEMPLATE") && g.includes("20261001T120000Z%2F20261001T160000Z"));
const o = cal.outlookUrl(ev);
ok("the Outlook link is the compose deeplink with ISO datetimes",
  o.startsWith("https://outlook.live.com/calendar/0/deeplink/compose")
  && o.includes("startdt=") && decodeURIComponent(o).includes("2026-10-01T12:00:00.000Z"));

const ics = cal.icsText(ev);
ok("the ics is one VEVENT with CRLF line endings",
  ics.startsWith("BEGIN:VCALENDAR") && ics.includes("BEGIN:VEVENT")
  && ics.includes("\r\n") && ics.trim().endsWith("END:VCALENDAR"));
ok("the ics carries DTSTART/DTEND in UTC",
  ics.includes("DTSTART:20261001T120000Z") && ics.includes("DTEND:20261001T160000Z"));
ok("commas in the address are escaped per RFC 5545",
  ics.includes("LOCATION:44 Aspen Leaf Ct\\, Aurora\\, ON L4G 7T3\\, Canada"));
ok("the UID is stable and PJL-scoped", ics.includes("UID:pjl-BK-2026-0042@pjllandservices.com"));
ok("newlines in details become \\n literals",
  cal.icsText(cal.eventForBooking(assignmentBooking, { portalUrl: "x" })).includes("\\n"));

// linksForBooking bundles it.
const bundle = cal.linksForBooking(assignmentBooking, { portalUrl: "https://x" });
ok("linksForBooking hands back google + outlook + the event",
  bundle && bundle.google.includes("TEMPLATE") && bundle.outlook.includes("compose") && bundle.event.title === ev.title);
ok("linksForBooking is null-safe", cal.linksForBooking({}) === null);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-calendar-links: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-calendar-links: ${pass} assertions passed`);

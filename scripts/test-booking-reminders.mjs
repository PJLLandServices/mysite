// The day-before reminder for SELF-BOOKED appointments.
//
//   node scripts/test-booking-reminders.mjs
//
// WHAT THIS PROTECTS. Assignment customers get their D−1 text from the
// cadence; self-booked customers get theirs from this sweep — and the
// worst bug either system can have is the same: a double text. So the
// invariants are the cadence's, re-proven here for the new path: once
// ever (marked BEFORE the send, so even a failed send never retries),
// assignment bookings untouched (the cadence owns them), the 9–18
// Toronto window, decision I's "no need to contact" honoured, and the
// bucket window — never an exact time — riding into the message.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-rem-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const reminders = require(path.join(SANDBOX, "server/lib/booking-reminders.js"));

const NOW = new Date(2026, 8, 30, 10, 0);            // Wed Sep 30, 10:00 — inside the window
const TOMORROW = new Date(2026, 9, 1, 13, 0);        // Thu Oct 1, 1 PM

const mk = (over = {}) => bookings.createDirect({
  leadId: "L-AD",
  customerName: "Ad Customer",
  customerPhone: "+19055550190",
  customerEmail: "ad@example.com",
  address: "10 Blue Grass Dr, Aurora, ON",
  serviceKey: "fall_close_4z",
  serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor: TOMORROW.toISOString(),
  durationMinutes: 30,
  status: "confirmed",
  ...over
});

const selfBooked = await mk();
const wrongDay = await mk({ scheduledFor: new Date(2026, 9, 3, 13, 0).toISOString() });
const cancelled = await mk({ status: "cancelled" });
const assigned = await mk({
  source: "assignment", propertyId: "P-1",
  assignment: { season: "fall", year: 2026, batchId: "b", assignedAt: "x", date: "2026-10-01", bucket: "afternoon", code: "P-1" }
});
const silentProp = await mk({ propertyId: "P-SILENT", leadId: null });
const noContact = await mk({ leadId: null, propertyId: "P-2", customerPhone: "", customerEmail: "" });

const LEADS = [{
  id: "L-AD",
  portal: { token: "tok-ad" },
  contact: { name: "Ad Customer", email: "ad@example.com", phone: "+19055550190", address: "10 Blue Grass Dr, Aurora, ON" },
  booking: { start: TOMORROW.toISOString(), serviceLabel: "Fall Closing", bucketKey: "afternoon",
    bucketLabel: "Afternoon Appointment", bucketWindow: "12 PM – 5 PM" }
}];

const sent = [];
const deps = {
  now: NOW,
  leads: LEADS,
  getProperty: async (id) => (id === "P-SILENT" ? { id, commPrefs: { noContactNeeded: true } } : { id, commPrefs: {} }),
  notify: async (event, lead) => { sent.push({ event, lead }); },
  portalUrlFor: (lead) => (lead?.portal?.token ? `https://x/portal/${lead.portal.token}` : "https://x")
};

// ---- 1. The window gate ----------------------------------------------

const early = await reminders.sweepDayBefore({ ...deps, now: new Date(2026, 8, 30, 7, 0) });
ok("outside 9–18 Toronto the sweep waits and marks NOTHING",
  early.waiting === "send_window" && sent.length === 0
  && !(await bookings.get(selfBooked.id)).reminder24);

// ---- 2. One pass: who gets it, who doesn't ---------------------------

const first = await reminders.sweepDayBefore(deps);
ok("exactly the one eligible self-booked customer is messaged (3 due, 2 skipped by name)",
  first.due === 3 && first.sent === 1 && sent.length === 1, JSON.stringify(first));
ok("the notice is the day_before event with the lead's bucket window intact",
  sent.every((s) => s.event === "day_before")
  && sent.some((s) => s.lead.booking.bucketWindow === "12 PM – 5 PM")
  && sent.some((s) => s.lead.portalUrl === "https://x/portal/tok-ad"));
ok("an ASSIGNMENT booking is untouched — the cadence owns its D−1",
  !(await bookings.get(assigned.id)).reminder24
  && !sent.some((s) => s.lead.id === assigned.id));
ok("a booking on another day waits its turn",
  !(await bookings.get(wrongDay.id)).reminder24);
ok("a cancelled booking gets nothing",
  !(await bookings.get(cancelled.id)).reminder24);
ok("decision I holds here too: 'no need to contact' is skipped by name",
  first.skipped.some((s) => s.bookingId === silentProp.id && s.reason === "no_contact_needed"));
ok("no phone AND no email is skipped as no_contact",
  first.skipped.some((s) => s.bookingId === noContact.id && s.reason === "no_contact"));
ok("the mark is on the record with its history line",
  (await bookings.get(selfBooked.id)).reminder24?.sentAt
  && (await bookings.get(selfBooked.id)).history.some((h) => h.action === "reminder_24h"));

// ---- 3. Once, ever ----------------------------------------------------

sent.length = 0;
const second = await reminders.sweepDayBefore(deps);
ok("a second sweep sends nothing — once, ever",
  second.sent === 0 && sent.length === 0, JSON.stringify(second));

// ---- 4. Mark-before-send: a failed send never retries -----------------

const fragile = await mk({ customerEmail: "boom@example.com" });
let threw = 0;
const failing = { ...deps, notify: async () => { threw += 1; throw new Error("twilio down"); } };
const failedPass = await reminders.sweepDayBefore(failing);
ok("the failure is reported, not swallowed",
  failedPass.errors.length === 1 && failedPass.errors[0].bookingId === fragile.id && threw === 1);
ok("…but the mark went down FIRST, so the next sweep does NOT double-text",
  (await bookings.get(fragile.id)).reminder24?.sentAt
  && (await reminders.sweepDayBefore(failing)).errors.length === 0 && threw === 1);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-booking-reminders: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-booking-reminders: ${pass} assertions passed`);

// The appointment page's actions — stage 5 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-appointment-page.mjs
//
// WHAT THIS PROTECTS. The token-addressed page is the customer's whole
// voice in the assign-and-confirm system: confirm, reschedule, cancel.
// The suite runs the real booking store and the REAL cadence engine so
// the claims that matter are proven end to end:
//   - a confirm stops the follow-up messages (steps 2–5) but not the
//     24-hour reminder;
//   - a cancel stops everything;
//   - the 24-hour cutoff and the one-reschedule cap gate the page.
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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-appt-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const propertiesLib = require(path.join(SANDBOX, "server/lib/properties.js"));
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify([
  { id: "P-1", code: "P-1", customerName: "Kristen Holmes", customerPhone: "+19055550100",
    customerEmail: "k@example.com", address: "90 Oriole Drive, East Gwillimbury, ON", town: "East Gwillimbury" },
  { id: "P-2", code: "P-2", customerName: "Charles Schwarz", customerPhone: "+19055550101",
    customerEmail: "c@example.com", address: "1009 Little Cedar Ave, Churchill, ON", town: "Churchill" }
], null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const appointment = require(path.join(SANDBOX, "server/lib/appointment-actions.js"));
const cadence = require(path.join(SANDBOX, "server/lib/assignment-cadence.js"));

const mk = (pid, scheduledFor) => bookings.createDirect({
  propertyId: pid,
  customerName: pid === "P-1" ? "Kristen Holmes" : "Charles Schwarz",
  customerPhone: "+19055550100",
  customerEmail: `${pid.toLowerCase()}@example.com`,
  address: pid === "P-1" ? "90 Oriole Drive, East Gwillimbury, ON" : "1009 Little Cedar Ave, Churchill, ON",
  serviceKey: "fall_close_4z",
  serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor,
  durationMinutes: 30,
  status: "confirmed",
  source: "assignment",
  assignment: {
    season: "fall", year: 2026, batchId: "AS-t", assignedAt: "x",
    date: "2026-10-05", bucket: "morning", code: pid
  }
});
const b1 = await mk("P-1", new Date(2026, 9, 5, 8, 13).toISOString());
const b2 = await mk("P-2", new Date(2026, 9, 5, 9, 2).toISOString());

const NOW = new Date(2026, 8, 20, 10, 0);            // Sun^H Sept 20, well before D

// ---- 1. Tokens --------------------------------------------------------

const token1 = await appointment.ensureToken(b1.id);
ok("ensureToken mints a real token", typeof token1 === "string" && token1.length >= 16);
ok("ensureToken is idempotent — same token every time",
  (await appointment.ensureToken(b1.id)) === token1);
ok("a non-assignment booking gets no token",
  (await appointment.ensureToken("BK-NOPE")) === null);

ok("the token resolves its booking", (await appointment.findByToken(token1))?.id === b1.id);
ok("an unknown token resolves nothing", (await appointment.findByToken("x".repeat(24))) === null);
ok("a short/garbage token is rejected without a scan", (await appointment.findByToken("abc")) === null);

// ---- 2. What the page may offer ---------------------------------------

const open = appointment.summarize(await bookings.get(b1.id), { now: NOW });
ok("a future, unanswered appointment offers all three actions",
  open.state === "open" && open.canConfirm && open.canReschedule && open.canCancel,
  JSON.stringify(open));
ok("the summary speaks the customer's language, not the record's",
  open.firstName === "Kristen" && open.street === "90 Oriole Drive"
  && open.dateLabel.includes("October 5") && /Morning/.test(open.bucketLabel));

const nearNow = new Date(2026, 9, 4, 20, 0);         // 12 hours before
const near = appointment.summarize(await bookings.get(b1.id), { now: nearNow });
ok("inside 24 hours: confirm still works, changes need a phone call",
  near.canConfirm && !near.canReschedule && !near.canCancel && near.insideCutoff);

// ---- 3. Confirm — and the cadence integration -------------------------

const confirmed = await appointment.confirm(token1, { now: NOW });
ok("confirm records the response", confirmed.ok && confirmed.summary.state === "responded"
  && confirmed.summary.respondedVia === "confirm");
const confirmedAgain = await appointment.confirm(token1, { now: NOW });
ok("confirming twice keeps the first answer",
  confirmedAgain.ok
  && (await bookings.get(b1.id)).assignment.outreach.responseVia === "confirm");

// Blast both bookings, then sweep on D−15: the confirmed customer gets
// no follow-up; the silent one does. On D−1 BOTH get the reminder.
const wire = { emails: 0, smses: 0, to: [] };
const deps = {
  sendEmail: async (a) => { wire.emails += 1; wire.to.push(a.to); return { ok: true }; },
  sendSms: async () => { wire.smses += 1; return { ok: true }; }
};
await cadence.blast("fall", 2026, { deps, now: new Date(2026, 8, 10, 10, 0), appointmentPageReady: true });
wire.emails = 0; wire.smses = 0;
await cadence.sweepDue("fall", 2026, { deps, now: new Date(2026, 8, 20, 10, 0), appointmentPageReady: true });
ok("a page confirm STOPS the follow-ups: only the silent customer got step 2",
  !(await bookings.get(b1.id)).assignment.outreach.steps["2"]
  && Boolean((await bookings.get(b2.id)).assignment.outreach.steps["2"]));

// ---- 4. Cancel — BEFORE the D−1 sweep, so rule 5 is provable ----------

const token2 = (await bookings.get(b2.id)).assignment.outreach.token;
ok("the blast minted b2's token on its own", typeof token2 === "string");

const lateCancel = await appointment.cancel(token2, { now: nearNow });
ok("a cancel inside 24 hours is refused with the phone number",
  !lateCancel.ok && /less than 24 hours/.test(lateCancel.errors[0]));

const cancelled = await appointment.cancel(token2, { reason: "selling the house", now: NOW });
ok("a cancel outside the cutoff goes through and says so",
  cancelled.ok && cancelled.summary.state === "cancelled");
const b2After = await bookings.get(b2.id);
ok("the booking is cancelled with the customer's reason kept",
  b2After.status === "cancelled" && b2After.cancellationReason === "selling the house"
  && b2After.assignment.outreach.responseVia === "cancel");

// The D−1 sweep (Oct 4): the confirmed customer's reminder fires —
// nothing stops step 6 — while the cancelled customer's never does.
await cadence.sweepDue("fall", 2026, { deps, now: new Date(2026, 9, 4, 10, 0), appointmentPageReady: true });
ok("nothing stops the 24-hour reminder for a live booking",
  Boolean((await bookings.get(b1.id)).assignment.outreach.steps["6"]));
ok("a page cancel stops everything — the cancelled customer gets no reminder",
  !(await bookings.get(b2.id)).assignment.outreach.steps["6"]);

// ---- 5. The reschedule cap gates the page -----------------------------

await bookings.reschedule(b1.id, { scheduledFor: new Date(2026, 9, 7, 8, 0).toISOString(), by: "customer" });
const capped = appointment.summarize(await bookings.get(b1.id), { now: NOW });
ok("after their one move, the page stops offering reschedule (call us instead)",
  !capped.canReschedule && capped.canConfirm);

// ---- 6. Cancelled and past states are terminal ------------------------

const cancelledView = appointment.summarize(await bookings.get(b2.id), { now: NOW });
ok("a cancelled appointment offers nothing",
  cancelledView.state === "cancelled"
  && !cancelledView.canConfirm && !cancelledView.canReschedule && !cancelledView.canCancel);
const pastView = appointment.summarize(await bookings.get(b1.id), { now: new Date(2026, 9, 20, 10, 0) });
ok("a past appointment offers nothing", pastView.state === "past" && !pastView.canConfirm);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-appointment-page: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-appointment-page: ${pass} assertions passed`);

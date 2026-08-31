// The appointment page's actions — stage 5 of docs/ASSIGNMENT_WRITER.md.
//
// One token-addressed page (/a/<token>) where an assigned customer
// decides: CONFIRM, RESCHEDULE, or CANCEL — the one-link decision from
// stage 3. The token is the credential, like /portal/<token> and
// /rr/<token>; it addresses exactly one booking and grants exactly
// these three actions on it.
//
// This module holds the token lookup and the confirm/cancel actions
// with their gates; RESCHEDULING lives in server.js because it reuses
// the shared rescheduleBooking()/rescheduleAvailability() helpers there
// — the same slot validation the portal uses, which is what makes a
// customer's move compose with the geography filter, the season window,
// and the bucket capacity gate (they all live inside listAvailableSlots).
//
// GATES, portal parity:
//   confirm     — any time, while the booking is confirmed and future.
//   reschedule  — until 24h before the appointment; once per customer
//                 (rescheduleBooking's own customer cap).
//   cancel      — until 24h before the appointment.
//
// Every action records the response (decision F): confirm/reschedule/
// cancel all stop the follow-up cadence (steps 2–5); cancel also stops
// the 24-hour reminder because the booking leaves "confirmed".

const crypto = require("node:crypto");
const bookings = require("./bookings");
const { BOOKING_BUCKETS } = require("./availability");

const CHANGE_CUTOFF_HOURS = 24;

function tokenOf(booking) {
  return booking?.assignment?.outreach?.token || null;
}

async function findByToken(token, { listBookings = bookings.list } = {}) {
  const clean = String(token || "").trim();
  // Tokens are 24 chars of base64url; anything shorter is not worth a
  // store scan (and keeps enumeration attempts cheap to reject).
  if (clean.length < 16) return null;
  const all = await listBookings();
  return all.find((b) => b && b.source === "assignment" && tokenOf(b) === clean) || null;
}

// Mint the booking's appointment token if it doesn't have one yet. The
// blast mints on send; this exists so a test-send (or a pre-blast
// preview) can hand out a REAL working link.
async function ensureToken(bookingId, { getBooking = bookings.get, setOutreach = bookings.setAssignmentOutreach } = {}) {
  const booking = await getBooking(bookingId);
  if (!booking || booking.source !== "assignment") return null;
  const existing = tokenOf(booking);
  if (existing) return existing;
  const token = crypto.randomBytes(18).toString("base64url");
  await setOutreach(bookingId, { token }, { action: "appointment_token_minted", by: "system" });
  return token;
}

function bucketLabelOf(booking) {
  const key = booking?.assignment?.bucket
    || (new Date(booking?.scheduledFor).getHours() < 12 ? "morning" : "afternoon");
  const bucket = BOOKING_BUCKETS.find((b) => b.key === key);
  if (!bucket) return key;
  return `${key === "morning" ? "Morning" : "Afternoon"} (${bucket.windowLabel})`;
}

// Everything the page needs to render, and nothing it shouldn't have:
// first name, the appointment, and what the customer may still do. No
// ids, no phone/email echo — the token holder already knows who they
// are, and a forwarded link shouldn't leak contact details.
function summarize(booking, { now = new Date() } = {}) {
  if (!booking) return null;
  const start = new Date(booking.scheduledFor);
  const msUntil = start.getTime() - now.getTime();
  const past = msUntil <= 0;
  const insideCutoff = msUntil < CHANGE_CUTOFF_HOURS * 60 * 60 * 1000;
  const outreach = booking.assignment?.outreach || {};

  const state = booking.status === "cancelled" ? "cancelled"
    : booking.status === "completed" ? "completed"
    : past ? "past"
    : outreach.respondedAt ? "responded"
    : "open";

  return {
    state,
    respondedVia: outreach.responseVia || null,
    firstName: String(booking.customerName || "").trim().split(/\s+/)[0] || "there",
    serviceLabel: booking.serviceLabel || "Your appointment",
    dateLabel: start.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" }),
    bucketLabel: bucketLabelOf(booking),
    street: String(booking.address || "").split(/[\n,]+/)[0].trim(),
    canConfirm: state === "open" || state === "responded",
    canReschedule: (state === "open" || state === "responded")
      && !insideCutoff
      && (Number(booking.rescheduleCount) || 0) < 1,
    canCancel: (state === "open" || state === "responded") && !insideCutoff,
    insideCutoff
  };
}

// "Yes, that works." Idempotent — confirming twice is one response, and
// a confirm after a reschedule doesn't overwrite how they first
// answered (bookings.markAssignmentResponded keeps the first).
async function confirm(token, { listBookings, markResponded = bookings.markAssignmentResponded, now = new Date() } = {}) {
  const booking = await findByToken(token, { listBookings });
  if (!booking) return { ok: false, status: 404, errors: ["That link doesn't match an appointment."] };
  const summary = summarize(booking, { now });
  if (!summary.canConfirm) {
    return { ok: false, status: 409, errors: ["This appointment can no longer be confirmed here — call us at (905) 960-0181."] };
  }
  const updated = await markResponded(booking.id, { via: "confirm", by: "customer" });
  return { ok: true, booking: updated, summary: summarize(updated, { now }) };
}

// "I no longer need this." Gated at 24 hours like the portal; the
// cancellation itself flips the booking's status, which is what stops
// the whole cadence including the 24-hour reminder (rule 5).
async function cancel(token, { reason = "", listBookings, cancelBooking = bookings.cancel, markResponded = bookings.markAssignmentResponded, now = new Date() } = {}) {
  const booking = await findByToken(token, { listBookings });
  if (!booking) return { ok: false, status: 404, errors: ["That link doesn't match an appointment."] };
  const summary = summarize(booking, { now });
  if (!summary.canCancel) {
    const why = summary.insideCutoff && (summary.state === "open" || summary.state === "responded")
      ? `Your appointment is less than ${CHANGE_CUTOFF_HOURS} hours away — please call us at (905) 960-0181 to cancel.`
      : "This appointment can't be cancelled from this page — call us at (905) 960-0181.";
    return { ok: false, status: 409, errors: [why] };
  }
  // The response mark goes FIRST: if the cancel write fails midway the
  // customer still counted as responded, which only ever errs quiet.
  await markResponded(booking.id, { via: "cancel", by: "customer" });
  const result = await cancelBooking(booking.id, {
    reason: String(reason || "cancelled from the appointment page").slice(0, 300),
    by: "customer"
  });
  if (!result.ok) return { ok: false, status: result.status || 409, errors: result.errors };
  return { ok: true, booking: result.booking, summary: summarize(result.booking, { now }) };
}

module.exports = {
  CHANGE_CUTOFF_HOURS,
  findByToken,
  ensureToken,
  summarize,
  confirm,
  cancel
};

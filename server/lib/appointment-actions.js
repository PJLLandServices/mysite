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
const properties = require("./properties");
const customers = require("./customers");
const { BOOKING_BUCKETS, BOOKABLE_SERVICES } = require("./availability");
const { deriveSeasonalKey, effectiveZoneCount } = require("./pricing");

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

  const live = state === "open" || state === "responded";
  return {
    state,
    respondedVia: outreach.responseVia || null,
    // Full name, per Patrick's review: this is a private per-customer
    // link, not a public page.
    name: String(booking.customerName || "").trim() || "there",
    firstName: String(booking.customerName || "").trim().split(/\s+/)[0] || "there",
    serviceLabel: booking.serviceLabel || "Your appointment",
    dateLabel: start.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" }),
    bucketLabel: bucketLabelOf(booking),
    street: String(booking.address || "").split(/[\n,]+/)[0].trim(),
    freeBucket: Boolean(booking.flexBucket),
    requestedWindow: booking.requestedWindow
      ? { notBefore: booking.requestedWindow.notBefore || null, notAfter: booking.requestedWindow.notAfter || null }
      : null,
    canConfirm: live,
    canReschedule: live && !insideCutoff && (Number(booking.rescheduleCount) || 0) < 1 && !booking.flexBucket,
    canCancel: live && !insideCutoff,
    canFreeBucket: live && !insideCutoff && !booking.flexBucket,
    canSetWindow: live && !insideCutoff && !booking.flexBucket,
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

// THE FREE BUCKET — Patrick's flexible pool. The customer is normally
// home (or can be on short notice); the job runs whenever the crew is
// in the area and the tech calls ahead with an ETA. It counts as a
// response, and it takes the booking out of self-serve rescheduling —
// from here on Patrick places it.
async function freeBucket(token, { listBookings, setFlex = bookings.setFreeBucket, markResponded = bookings.markAssignmentResponded, now = new Date() } = {}) {
  const booking = await findByToken(token, { listBookings });
  if (!booking) return { ok: false, status: 404, errors: ["That link doesn't match an appointment."] };
  const summary = summarize(booking, { now });
  if (!summary.canFreeBucket) {
    return { ok: false, status: 409, errors: ["This appointment can't switch to the free bucket from here — call us at (905) 960-0181."] };
  }
  await markResponded(booking.id, { via: "free_bucket", by: "customer" });
  const updated = await setFlex(booking.id, { by: "customer" });
  return { ok: true, booking: updated, summary: summarize(updated, { now }) };
}

// The customer's own "after X / before Y" for their day. Stored on the
// booking; the sequencer's requestedWindows seam (built and tested in
// the time-windows PR, waiting for exactly this caller) merges it OVER
// the plan's standing constraint — the customer's ask wins. Setting a
// window counts as a response: they're planning around the day.
async function setWindow(token, { notBefore, notAfter, listBookings, setRequestedWindow = bookings.setRequestedWindow, markResponded = bookings.markAssignmentResponded, now = new Date() } = {}) {
  const booking = await findByToken(token, { listBookings });
  if (!booking) return { ok: false, status: 404, errors: ["That link doesn't match an appointment."] };
  const summary = summarize(booking, { now });
  if (!summary.canSetWindow) {
    return { ok: false, status: 409, errors: ["Timing preferences can't be changed from here right now — call us at (905) 960-0181."] };
  }
  let updated;
  try {
    updated = await setRequestedWindow(booking.id, { notBefore, notAfter, by: "customer" });
  } catch (err) {
    return { ok: false, status: 422, errors: [err.message] };
  }
  if (updated.requestedWindow) {
    await markResponded(booking.id, { via: "window", by: "customer" });
  }
  const fresh = await findByToken(token, { listBookings });
  return { ok: true, booking: fresh, summary: summarize(fresh, { now }) };
}

// What the page should say about the customer's system. Three shapes:
//   documented — the techs mapped the zones; the count is ground truth
//                and the page shows it read-only.
//   declared   — we only have a number someone typed (their booking, a
//                past correction, Patrick's manual entry); editable.
//   none       — nothing on file at all; the page asks outright.
// canUpdate mirrors the setZones gate so the page never offers an edit
// the endpoint would refuse.
function zonesInfo(property, summary) {
  const documented = Array.isArray(property?.system?.zones) ? property.system.zones.length : 0;
  const count = effectiveZoneCount(property);
  const live = summary && (summary.state === "open" || summary.state === "responded");
  return {
    count: count || null,
    source: documented > 0 ? "documented" : count > 0 ? "declared" : "none",
    canUpdate: Boolean(live) && documented === 0
  };
}

// "Here's how many zones I actually have." Patrick's follow-up to the
// launch review: many profiles carry only the booking class for the
// customer's category — a tier bracket, not their real system — so the
// page lets the customer set the record straight. The count lands on
// the PROPERTY (system.zoneCount, the same field Patrick fills by
// hand); documented zones always win and make this read-only. The
// booking's tier follows the real number — serviceKey, label, price
// bracket and on-site minutes — through the same deriveSeasonalKey the
// assignment writer booked with. It is NOT a response (nothing was
// said about the date) and it works even inside the 24-hour cutoff:
// it's information, not a move.
async function setZones(token, {
  zoneCount,
  listBookings,
  getProperty = properties.get,
  updateProperty = properties.update,
  getCustomer = (id) => customers.get(id, { withProperties: false }),
  setDeclared = bookings.setDeclaredZones,
  now = new Date()
} = {}) {
  const booking = await findByToken(token, { listBookings });
  if (!booking) return { ok: false, status: 404, errors: ["That link doesn't match an appointment."] };
  const summary = summarize(booking, { now });
  if (summary.state !== "open" && summary.state !== "responded") {
    return { ok: false, status: 409, errors: ["This appointment can't be updated from this page — call us at (905) 960-0181."] };
  }
  const zones = Math.floor(Number(zoneCount) || 0);
  if (!Number.isFinite(Number(zoneCount)) || zones < 1 || zones > 50) {
    return { ok: false, status: 422, errors: ["Please enter a whole number of zones between 1 and 50."] };
  }
  const property = booking.propertyId ? await getProperty(booking.propertyId) : null;
  if (!property) {
    return { ok: false, status: 409, errors: ["We couldn't find your property record — call us at (905) 960-0181 and we'll fix it together."] };
  }
  const documented = Array.isArray(property.system?.zones) ? property.system.zones.length : 0;
  if (documented > 0) {
    return { ok: false, status: 409, errors: [
      `Our technicians have already mapped your system (${documented} zone${documented === 1 ? "" : "s"} on file). If that looks wrong, call or text us at (905) 960-0181.`
    ] };
  }

  // The property is the record of truth — the same field Patrick edits.
  await updateProperty(property.id, { system: { zoneCount: zones } });

  // Re-derive the tier from the real count, the same way assign() did
  // from the old one: accountType decides the table.
  let commercial = false;
  if (property.customerId) {
    try {
      const owner = await getCustomer(property.customerId);
      commercial = owner?.accountType === "commercial";
    } catch { /* unresolvable customer — residential, like assign() */ }
  }
  const woType = String(booking.serviceKey || "").startsWith("spring") ? "spring_opening" : "fall_closing";
  const newKey = deriveSeasonalKey(woType, zones, commercial);
  const service = newKey ? BOOKABLE_SERVICES[newKey] : null;
  const tierChanged = Boolean(service) && newKey !== booking.serviceKey;

  const updated = await setDeclared(booking.id, {
    zoneCount: zones,
    serviceKey: service ? newKey : undefined,
    serviceLabel: service ? service.label : undefined,
    durationMinutes: service ? service.minutes : undefined,
    by: "customer"
  });
  return { ok: true, booking: updated, summary: summarize(updated, { now }), tierChanged };
}

module.exports = {
  CHANGE_CUTOFF_HOURS,
  findByToken,
  ensureToken,
  summarize,
  zonesInfo,
  confirm,
  cancel,
  freeBucket,
  setWindow,
  setZones
};

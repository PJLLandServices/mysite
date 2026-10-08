// Booking lifecycle — the one module that owns what happens to an
// appointment (P-PJL-39, PJL-133; TRD §4).
//
// ONE REAL APPOINTMENT = ONE CANONICAL BOOKING ID. Everything that cancels,
// completes, no-shows or links a work order to a Booking comes through
// here, so that the record, its work orders and its audit trail change
// together and every reader downstream (plan, Today, portal, cadence,
// calendar, capacity) reads one answer.
//
// lib/bookings.js owns the record and its transitions; lib/work-orders.js
// owns the work order. Neither requires the other (a circular require is
// how two "one rules" are born). This module requires both, and is the
// only place a Booking and its work order are written in one step.
//
// What is deliberately NOT here yet (later phases): the lead envelope
// mirror (server.js routes still write lead.booking after calling these,
// until Phase 6 retires it), notifications (the routes send), and the
// completion cascade's call into completeBooking (Phase 4).

const bookings = require("./bookings");
const workOrders = require("./work-orders");

const WO_TERMINAL = new Set(["completed", "cancelled", "no_show"]);

function holdsItsSlot(status) { return bookings.holdsItsSlot(status); }
function isTerminal(status) { return bookings.isTerminal(status); }

// Every work order that belongs to THIS visit of the Booking: the ones
// that name it by bookingId, plus the record's own list filtered by the
// PJL-97 rule (a finished work order from a previous visit is not this
// visit's), de-duplicated.
async function workOrdersForBooking(rec) {
  if (!rec) return [];
  const linked = (await Promise.all((rec.workOrderIds || []).map((id) => Promise.resolve(workOrders.get(id)).catch(() => null)))).filter(Boolean);
  const named = await workOrders.listByBooking(rec.id).catch(() => []);
  const seen = new Set();
  const out = [];
  for (const w of [...bookings.workOrdersForVisit(rec, linked), ...named]) {
    if (!w || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}

// Link both sides: the Booking's workOrderIds and the work order's
// bookingId. Idempotent. The work-order side is best-effort — a Booking
// that names a work order whose record cannot be written is still linked
// from its own side, and the audit (PJL-137) reports the half-link.
async function linkWorkOrder(bookingId, workOrderId, { by = "system" } = {}) {
  if (!bookingId || !workOrderId) return { booking: null, workOrder: null };
  const booking = await bookings.attachWorkOrder(bookingId, workOrderId);
  let workOrder = null;
  try { workOrder = await workOrders.setBookingId(workOrderId, bookingId, { by }); }
  catch (err) { console.warn(`[booking-lifecycle] ${workOrderId} could not be linked to ${bookingId}:`, err?.message); }
  return { booking, workOrder };
}

// A work order is being deleted: every Booking that names it lets go of
// the id (history keeps that it was there). The record stays whatever it
// was — a deleted work order does not cancel a visit.
async function unlinkWorkOrder(workOrderId, { by = "system", note = "" } = {}) {
  if (!workOrderId) return [];
  const touched = [];
  for (const b of await bookings.list()) {
    if (b && (b.workOrderIds || []).includes(workOrderId)) {
      await bookings.detachWorkOrder(b.id, workOrderId, { by, note });
      touched.push(b.id);
    }
  }
  return touched;
}

// The Booking a work order fulfils: by its own bookingId, else the Booking
// whose list names it. Takes the bookings list when the caller has one.
async function resolveBookingForWorkOrder(wo, all = null) {
  if (!wo) return null;
  const list = Array.isArray(all) ? all : await bookings.list();
  if (wo.bookingId) {
    const byId = list.find((b) => b && b.id === wo.bookingId);
    if (byId) return byId;
  }
  return list.find((b) => b && (b.workOrderIds || []).includes(wo.id)) || null;
}

// Cascade the Booking's terminal state onto this visit's open work orders.
// A visit that is not happening has no job to drive to; a job left
// `scheduled` reappears on Today as its own row (day-schedule's union).
async function cascadeToWorkOrders(rec, status, { by, note }) {
  const touched = [];
  for (const wo of await workOrdersForBooking(rec)) {
    if (WO_TERMINAL.has(wo.status) || wo.arrivedAt) continue;   // a visit the tech reached is the tech's to close out
    try {
      await workOrders.update(wo.id, { status, __by: by, __statusNote: note }, { systemWrite: true });
      touched.push(wo.id);
    } catch (err) {
      console.warn(`[booking-lifecycle] ${wo.id} not cascaded to ${status}:`, err?.message);
    }
  }
  return touched;
}

// Cancel: one transition, from every door (Schedule page, the Field app's
// "Not today", the customer's portal and appointment page, the Assistant,
// the admin status menu). The reason code chooses cancelled vs no_show
// (bookings.cancel); this visit's open work orders follow.
async function cancelBooking(id, { reason = "", reasonCode = "", by = "admin", actorName = "", cascadeWorkOrders = true } = {}) {
  const result = await bookings.cancel(id, { reason, reasonCode, by, actorName });
  if (!result.ok) return result;
  const status = result.booking.status;   // cancelled or no_show, chosen by the reason
  const workOrdersCancelled = cascadeWorkOrders
    ? await cascadeToWorkOrders(result.booking, status, { by, note: `Cascade from booking ${status}${reason ? `: ${reason}` : ""}` })
    : [];
  return { ...result, workOrdersCancelled };
}

async function markNoShow(id, { reason = "", by = "tech", actorName = "", cascadeWorkOrders = true } = {}) {
  return cancelBooking(id, { reason: reason || "Nobody home", reasonCode: "no_answer", by, actorName, cascadeWorkOrders });
}

// Complete: the visit happened. Names the work order that fulfilled it and
// links both sides. Idempotent on an already-completed record.
async function completeBooking(id, { workOrderId = null, completedAt = null, by = "system", note = "" } = {}) {
  const result = await bookings.complete(id, { workOrderId, completedAt, by, note });
  if (result.ok && workOrderId && !result.unchanged) {
    try { await workOrders.setBookingId(workOrderId, id, { by }); }
    catch (err) { console.warn(`[booking-lifecycle] ${workOrderId} could not be linked to ${id} on completion:`, err?.message); }
  }
  return result;
}

// The admin status menu (the booking page's dropdown), translated into
// lifecycle operations. It used to PATCH `status` straight onto the record:
// no cancelledAt, no reason, no cascade, and a dead record could be revived.
async function setStatusFromAdmin(id, status, { by = "admin", actorName = "", note = "" } = {}) {
  if (!bookings.STATUSES.has(status)) return { ok: false, status: 422, errors: [`Unknown booking status: ${status}`] };
  const rec = await bookings.get(id);
  if (!rec) return { ok: false, status: 404, errors: ["Booking not found."] };
  if (rec.status === status) return { ok: true, booking: rec, unchanged: true };
  if (isTerminal(rec.status)) {
    return { ok: false, status: 409, code: "terminal", errors: [`This booking is ${rec.status}; a finished or cancelled visit is not reopened from the status menu. Book a new visit instead.`] };
  }
  switch (status) {
    case "cancelled":
      return cancelBooking(id, { reason: note || "Set to cancelled on the booking page", reasonCode: "", by, actorName });
    case "no_show":
      return markNoShow(id, { reason: note || "Marked a no-show on the booking page", by, actorName });
    case "completed": {
      const wos = await workOrdersForBooking(rec);
      const done = wos.find((w) => w.status === "completed") || null;
      return completeBooking(id, { workOrderId: done ? done.id : null, by, note: note || "Marked completed on the booking page" });
    }
    default:
      return bookings.setLiveStatus(id, status, { by, actorName, note });
  }
}

module.exports = {
  holdsItsSlot,
  isTerminal,
  workOrdersForBooking,
  linkWorkOrder,
  unlinkWorkOrder,
  resolveBookingForWorkOrder,
  cancelBooking,
  markNoShow,
  completeBooking,
  setStatusFromAdmin
};

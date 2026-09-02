// Day-before reminders for SELF-BOOKED appointments.
//
// The assignment cadence's step 6 texts every ASSIGNED customer the day
// before their visit — but a customer who booked themselves (the public
// booking page, the ad traffic) got nothing. Patrick, 2026-09-02, with
// ads live: "add the day-before reminder for self booked."
//
// The rules, borrowed from the cadence where they were hard-won:
//   - Once, ever, per booking. The mark (bookings.markReminderSent)
//     goes down BEFORE the send, so a half-failed send errs quiet.
//   - Send window 09:00–18:00 America/Toronto. A missed day stays
//     missed — no 3 AM texts, no day-of backfill.
//   - Assignment bookings are EXCLUDED — the cadence owns them, and a
//     second reminder would be the double-text this whole codebase is
//     built to prevent.
//   - Transactional posture: this is about the customer's own
//     appointment, so seasonal-marketing opt-outs do not block it —
//     the same rule as booking confirmations ("those always send").
//     Decision I's "no need to contact" tick DOES block it: those
//     customers are never messaged, full stop.
//
// Delivery rides notify-customer's `day_before` template through
// notifyCustomer(), so the email and SMS wear the same brand frame,
// spouse-recipient logic, and bucket-not-exact-time rule as every other
// customer notice.
//
// Tested by scripts/test-booking-reminders.mjs.

const bookings = require("./bookings");

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function insideSendWindow(now) {
  const h = now.getHours();
  return h >= 9 && h < 18;
}

// One sweep pass. deps:
//   listBookings — canonical store (bookings.list)
//   leads        — full leads array (readLeads lives in server.js)
//   getProperty  — property lookup for the Decision I gate
//   notify       — notifyCustomer(event, lead)-shaped sender
//   markSent     — bookings.markReminderSent
//   portalUrlFor — (lead) => absolute portal URL, for the template's link
async function sweepDayBefore({
  now = new Date(),
  listBookings = bookings.list,
  leads = [],
  getProperty = null,
  notify,
  markSent = bookings.markReminderSent,
  portalUrlFor = null
} = {}) {
  const result = { due: 0, sent: 0, skipped: [], errors: [] };
  if (!insideSendWindow(now)) { result.waiting = "send_window"; return result; }

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = localDateKey(tomorrow);
  const leadById = new Map(leads.filter((l) => l && l.id).map((l) => [l.id, l]));

  for (const b of await listBookings()) {
    if (!b || b.status !== "confirmed" || !b.scheduledFor) continue;
    if (b.source === "assignment") continue;               // the cadence's job
    if (localDateKey(new Date(b.scheduledFor)) !== tomorrowKey) continue;
    if (b.reminder24?.sentAt) continue;                     // once, ever
    result.due += 1;

    const skip = (reason) => result.skipped.push({ bookingId: b.id, reason });

    // Decision I: a "no need to contact" property is never messaged.
    if (b.propertyId && typeof getProperty === "function") {
      try {
        const property = await getProperty(b.propertyId);
        if (property?.commPrefs?.noContactNeeded === true) { skip("no_contact_needed"); continue; }
        if (property?.deletedAt || property?.archivedAt) { skip("inactive_property"); continue; }
      } catch { /* property unreadable — the send gates below still hold */ }
    }

    const lead = b.leadId ? leadById.get(b.leadId) : null;
    const contact = lead?.contact || {
      name: b.customerName || "",
      email: b.customerEmail || "",
      phone: b.customerPhone || "",
      address: b.address || ""
    };
    if (!String(contact.email || "").trim() && !String(contact.phone || "").trim()) {
      skip("no_contact");
      continue;
    }

    // The template's lead shape: contact + booking (bucket fields kept so
    // the customer sees the window they were promised, never an exact
    // internal time) + the portal link.
    const noticeLead = {
      id: lead?.id || b.id,
      contact,
      portal: lead?.portal,
      portalUrl: typeof portalUrlFor === "function" ? portalUrlFor(lead, b) : (lead?.portalUrl || ""),
      booking: {
        start: b.scheduledFor,
        serviceLabel: b.serviceLabel || (lead?.booking?.serviceLabel || ""),
        bucketKey: lead?.booking?.bucketKey || null,
        bucketLabel: lead?.booking?.bucketLabel || null,
        bucketWindow: lead?.booking?.bucketWindow || null,
        workOrder: lead?.booking?.workOrder || null
      }
    };

    try {
      await markSent(b.id, { channel: "email+sms", by: "reminder-sweep" });   // mark FIRST
      await notify("day_before", noticeLead);
      result.sent += 1;
    } catch (err) {
      result.errors.push({ bookingId: b.id, error: err?.message || String(err) });
    }
  }
  return result;
}

module.exports = { sweepDayBefore, insideSendWindow };

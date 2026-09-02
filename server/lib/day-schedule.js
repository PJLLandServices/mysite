// Day schedule — merges the two independent ways a job can end up on a
// given day into the single list the tech reads.
//
// A job's date can live in three places, and /api/schedule/today
// historically read only one of them:
//
//   1. lead.booking.start   — the public booking flow. Read since day one.
//   2. bookings.json        — mirrored FROM leads (bookings.upsertFromLead
//                             is keyed on leadId), so it adds nothing that
//                             (1) does not already carry.
//   3. workOrder.scheduledFor — a work order created straight from the
//                             CRM's "new work order" form. It gets no lead
//                             booking and no canonical booking. This was
//                             never read.
//
// (3) is how a management company's properties get scheduled: one customer
// record, many addresses, work orders raised directly against each
// property. So an entire commercial customer could be booked for today and
// appear nowhere on today's schedule — in the CRM or the field app
// (FLOW-29).
//
// The merge is additive on purpose. Every lead booking still renders
// exactly as it did before; scheduled work orders are appended and the
// whole list re-sorted by start time. Nothing that used to show stops
// showing.
//
// Pure — no I/O, no dates beyond what it is handed. Tested by
// scripts/test-day-schedule.mjs.
//
// HISTORY, because this module has died once already: written for
// FLOW-29 (Willowridge's properties missing from Today), it was dropped
// in the field-app merge on the reasoning that "no admin surface sets a
// work order's scheduledFor, so a lead-less scheduled work order cannot
// presently exist." That premise was wrong on both halves: the
// work-order page has a schedule/backdate input (server/work-order.js,
// "Patrick backdate scheduledFor…") that PATCHes `scheduledFor` on any
// work order — `scheduledFor` sits in the PATCH allow-list in
// lib/work-orders.js — and records written by any past code path keep
// whatever date they carry regardless of what today's code can produce.
// Patrick confirmed the gap live the day after the revert deployed:
// Willowridge still missing from Today (FLOW-32). Restored 2026-09-01.
// If this union ever looks redundant again, the bar for removing it is
// a walked Today page on a day a directly-scheduled work order exists —
// not code reading.

const WO_TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit",
  build: "Install / Build"
};

// Cancelled and no-show work is not today's work. Everything else shows,
// including already-completed jobs — a tech looking back at today wants to
// see what they finished.
const SKIP_WO_STATUS = new Set(["cancelled", "no_show"]);

// Parse a stored date the way a person means it. A bare "2026-10-02"
// parsed with new Date() lands at UTC midnight — the evening of Oct 1
// in Toronto — which would silently shift the job to the wrong local
// day. Date-only values are treated as LOCAL midnight instead. Full
// ISO datetimes (what the WO page's schedule input writes) parse as-is.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseStored(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (DATE_ONLY_RE.test(text)) {
    const [y, m, d] = text.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const when = new Date(text);
  return Number.isNaN(when.getTime()) ? null : when;
}

// Work orders carry a free-text address and no town of their own. Same
// second-comma-segment convention lib/notify-sms.js uses, so a row reads
// the same wherever it came from.
function townFromAddress(address) {
  const parts = String(address || "").split(",");
  if (parts.length < 2) return "";
  return parts[1]
    .replace(/\b(ON|Ontario|Canada)\b.*/i, "")
    .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i, "")
    .trim();
}

// Project one work order into the same row shape the booking branch emits,
// so the client renders both without branching on source.
function workOrderRow(wo) {
  const start = parseStored(wo.scheduledFor);
  return {
    // No lead, so no lead id. The client keys off the work order and hides
    // notify-on-route, which needs a lead to message.
    leadId: null,
    source: "work_order",
    customerName: wo.customerName || "",
    customerPhone: wo.customerPhone || "",
    customerEmail: wo.customerEmail || "",
    address: wo.address || "",
    town: townFromAddress(wo.address),
    coords: null,
    serviceKey: wo.type,
    serviceLabel: WO_TYPE_LABELS[wo.type] || "Work Order",
    start: start.toISOString(),
    end: null,
    startLabel: start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }),
    endLabel: "",
    customerNotes: wo.customerNotes || "",
    internalNotes: wo.techNotes || "",
    stage: wo.status || "scheduled",
    propertyId: wo.propertyId || null,
    workOrder: {
      id: wo.id,
      type: wo.type,
      status: wo.status,
      zoneCount: (wo.zones || []).length
    },
    onRouteNotifiedAt: null
  };
}

// `bookings` are the already-built lead rows; `allWos` every work order.
// dayStart/dayEnd are epoch ms for the local-day window.
function mergeDaySchedule(bookings, allWos, dayStart, dayEnd) {
  const rows = Array.isArray(bookings) ? bookings : [];
  // A work order already reachable through its lead's booking must not be
  // listed twice, whichever day the lead put it on.
  const seenWoIds = new Set(rows.map((b) => b.workOrder && b.workOrder.id).filter(Boolean));

  const scheduled = (Array.isArray(allWos) ? allWos : [])
    .filter((wo) => {
      if (!wo || !wo.id) return false;
      if (seenWoIds.has(wo.id)) return false;
      if (SKIP_WO_STATUS.has(wo.status)) return false;
      const parsed = parseStored(wo.scheduledFor);
      const when = parsed ? parsed.getTime() : null;
      if (!when) return false;
      return when >= dayStart && when < dayEnd;
    })
    .map(workOrderRow);

  return [...rows, ...scheduled].sort((a, b) => new Date(a.start) - new Date(b.start));
}

module.exports = { mergeDaySchedule, workOrderRow, townFromAddress, parseStored, WO_TYPE_LABELS, SKIP_WO_STATUS };

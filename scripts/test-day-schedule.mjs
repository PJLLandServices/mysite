// Unit tests for the today's-schedule merge (2026-08-31, FLOW-29).
//
// The bug this file exists to prevent: /api/schedule/today read only
// `lead.booking.start`, so a work order created straight from the CRM —
// which has no lead booking at all, only `scheduledFor` — was invisible.
// That is exactly how a management company's properties are scheduled, so
// an entire commercial customer could be booked for today and show up
// nowhere on the day's schedule.
//
// The invariants that matter, in order of how much they'd cost to break:
//   1. Every lead booking still renders. The merge is additive; nothing
//      that used to show may stop showing.
//   2. No job renders twice. A work order reachable through its lead must
//      not also arrive via scheduledFor.
//   3. Work-order rows are the same SHAPE as booking rows, so the field
//      app renders both without branching — but with leadId null, which
//      is what tells the client to hide notify-on-route.
//
// No server, no disk writes. Run: node scripts/test-day-schedule.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { mergeDaySchedule, workOrderRow, townFromAddress } = require("../server/lib/day-schedule.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// A local day window, the same way the endpoint builds it.
const day = new Date(2026, 9, 15); // 15 Oct 2026, local
const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
const dayEnd = dayStart + 24 * 60 * 60 * 1000;
const at = (h, m = 0) => new Date(dayStart + h * 3600e3 + m * 60e3).toISOString();

// Two ordinary residential rows, exactly as the booking branch emits them.
const bookingRows = [
  { leadId: "L-1", source: "booking", start: at(9), address: "12 Maple Ave, Vaughan, ON", workOrder: null },
  { leadId: "L-2", source: "booking", start: at(13), address: "8 Oak Cres, Aurora, ON",
    workOrder: { id: "WO-LEAD", type: "fall_closing", status: "scheduled", zoneCount: 6 } }
];

const wo = (over) => ({
  id: "WO-1", type: "fall_closing", status: "scheduled",
  customerName: "Willowridge Landscaping", customerPhone: "905-555-0100",
  customerEmail: "ops@willowridge.example", address: "40 Bathurst Glen Dr, Vaughan, ON L4J 8G1",
  scheduledFor: at(11), propertyId: "P-77", zones: [{}, {}, {}], techNotes: "gate code 4412",
  customerNotes: "", ...over
});

// ---- 1. the bug: a lead-less work order now shows -------------------
{
  const merged = mergeDaySchedule(bookingRows, [wo()], dayStart, dayEnd);
  eq(merged.length, 3, "the scheduled work order joins the two bookings");
  const row = merged.find((r) => r.workOrder?.id === "WO-1");
  ok(!!row, "the commercial job is on the day's schedule at all");
  eq(row.customerName, "Willowridge Landscaping", "customer name carried through");
  eq(row.leadId, null, "no lead id — there is no lead");
  eq(row.source, "work_order", "row is tagged as coming from a work order");
  eq(row.serviceLabel, "Fall Closing", "type rendered as a human label");
  eq(row.propertyId, "P-77", "property id carried so the tech can open the property");
  eq(row.workOrder.zoneCount, 3, "zone count surfaced for the card badge");
  eq(row.internalNotes, "gate code 4412", "tech notes surface as internal notes");
}

// ---- 2. additive: bookings are never dropped or altered --------------
{
  const merged = mergeDaySchedule(bookingRows, [wo()], dayStart, dayEnd);
  ok(bookingRows.every((b) => merged.includes(b)), "booking rows pass through by identity, unmodified");
  eq(merged.filter((r) => r.source === "booking").length, 2, "both bookings survive the merge");
  eq(mergeDaySchedule(bookingRows, [], dayStart, dayEnd).length, 2,
    "with no scheduled work orders the result is the old list exactly");
}

// ---- 3. no double-listing --------------------------------------------
{
  // WO-LEAD is already on the day via lead L-2. Even with a scheduledFor
  // in the window it must appear once.
  const dupe = wo({ id: "WO-LEAD", scheduledFor: at(13) });
  const merged = mergeDaySchedule(bookingRows, [dupe], dayStart, dayEnd);
  eq(merged.length, 2, "a work order already reachable via its lead is not appended");
  eq(merged.filter((r) => r.workOrder?.id === "WO-LEAD").length, 1, "WO-LEAD listed exactly once");
}

// ---- 4. the day window -----------------------------------------------
{
  const before = wo({ id: "WO-EARLY", scheduledFor: new Date(dayStart - 60e3).toISOString() });
  const after = wo({ id: "WO-LATE", scheduledFor: new Date(dayEnd + 60e3).toISOString() });
  const firstMinute = wo({ id: "WO-MIDNIGHT", scheduledFor: new Date(dayStart).toISOString() });
  const lastMinute = wo({ id: "WO-2359", scheduledFor: new Date(dayEnd - 60e3).toISOString() });
  const merged = mergeDaySchedule([], [before, after, firstMinute, lastMinute], dayStart, dayEnd);
  const ids = merged.map((r) => r.workOrder.id);
  ok(!ids.includes("WO-EARLY"), "yesterday's 11:59pm job is not today's");
  ok(!ids.includes("WO-LATE"), "tomorrow's 12:01am job is not today's");
  ok(ids.includes("WO-MIDNIGHT"), "dayStart is inclusive");
  ok(ids.includes("WO-2359"), "the last minute of the day counts");
}

// ---- 5. what does and does not belong on a schedule -------------------
{
  const statuses = ["scheduled", "on_site", "awaiting_approval", "approved", "completed", "cancelled", "no_show"];
  const wos = statuses.map((status, i) => wo({ id: `WO-${status}`, status, scheduledFor: at(7 + i) }));
  const ids = mergeDaySchedule([], wos, dayStart, dayEnd).map((r) => r.workOrder.id);
  ok(!ids.includes("WO-cancelled"), "cancelled work is not today's work");
  ok(!ids.includes("WO-no_show"), "a no-show is not today's work");
  ok(ids.includes("WO-completed"), "completed jobs still show — the tech looks back at the day");
  ok(ids.includes("WO-on_site"), "in-progress jobs show");
  eq(ids.length, 5, "five of the seven statuses belong on the day");
}

// ---- 6. junk data must not take the schedule down ---------------------
{
  const junk = [
    null,
    { id: "WO-NODATE", type: "fall_closing", status: "scheduled" },
    wo({ id: "WO-BADDATE", scheduledFor: "not a date" }),
    wo({ id: "WO-NOID", scheduledFor: at(10) }),
    wo({ scheduledFor: at(10) })
  ];
  delete junk[3].id;
  delete junk[4].id;
  const merged = mergeDaySchedule(bookingRows, junk, dayStart, dayEnd);
  eq(merged.length, 2, "unparseable and id-less records are skipped, not thrown on");
}

// ---- 7. ordering ------------------------------------------------------
{
  const merged = mergeDaySchedule(bookingRows, [wo({ scheduledFor: at(11) })], dayStart, dayEnd);
  const times = merged.map((r) => new Date(r.start).getTime());
  ok(times.every((t, i) => i === 0 || times[i - 1] <= t), "the merged day reads in time order");
  eq(merged[1].workOrder.id, "WO-1", "the 11am work order slots between the 9am and 1pm bookings");
}

// ---- 8. row shape parity ---------------------------------------------
{
  // The field app renders both kinds of row from the same template, so a
  // work-order row must not be missing keys the booking branch supplies.
  const row = workOrderRow(wo());
  const required = ["leadId", "source", "customerName", "customerPhone", "customerEmail", "address",
    "town", "coords", "serviceKey", "serviceLabel", "start", "end", "startLabel", "endLabel",
    "customerNotes", "internalNotes", "stage", "propertyId", "workOrder", "onRouteNotifiedAt"];
  const missing = required.filter((k) => !(k in row));
  eq(missing.join(","), "", "work-order rows carry every key a booking row does");
  eq(row.onRouteNotifiedAt, null, "never notified — there is no lead to notify from");
  eq(row.end, null, "a work order has no booked end time");
  eq(row.serviceLabel, "Fall Closing", "known type gets its label");
  eq(workOrderRow(wo({ type: "mystery" })).serviceLabel, "Work Order", "unknown type still renders something");
}

// ---- 9. town extraction ----------------------------------------------
{
  eq(townFromAddress("40 Bathurst Glen Dr, Vaughan, ON L4J 8G1"), "Vaughan", "town is the second comma segment");
  eq(townFromAddress("12 Maple Ave, Aurora ON"), "Aurora", "province suffix stripped without a comma");
  eq(townFromAddress("Some Field"), "", "a one-part address yields no town rather than a wrong one");
  eq(townFromAddress(""), "", "empty address is safe");
  eq(townFromAddress(null), "", "null address is safe");
}

// ---- 10. date-only scheduledFor stays on the day the person meant ----
// A bare "2026-10-15" parsed with new Date() is UTC midnight — the
// evening of Oct 14 in Toronto — which would silently shift the job to
// the wrong local day. parseStored treats it as LOCAL midnight.
{
  const { parseStored } = require("../server/lib/day-schedule.js");
  const dateOnlyKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const woDateOnly = { id: "WO-DATEONLY", type: "fall_closing", status: "scheduled",
    customerName: "Date-Only Customer", address: "1 Bare St, Aurora, ON", scheduledFor: dateOnlyKey };
  const merged = mergeDaySchedule([], [woDateOnly], dayStart, dayEnd);
  eq(merged.length, 1, "a date-only scheduledFor lands on ITS OWN local day, not the day before");
  eq(merged[0]?.workOrder?.id, "WO-DATEONLY", "…and it is the right work order");
  eq(parseStored(dateOnlyKey).getHours(), 0, "date-only parses to local midnight");
  ok(parseStored(null) === null, "no date parses to null, not an Invalid Date");
  ok(parseStored("garbage") === null, "an unreadable date parses to null rather than throwing");
}

console.log(`\nday-schedule: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

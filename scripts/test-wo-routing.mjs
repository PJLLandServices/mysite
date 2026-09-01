// How a Today row reaches its work order (field app).
//
//   node scripts/test-wo-routing.mjs
//
// WHAT THIS PROTECTS. Today's schedule carries two kinds of row. A lead
// booking has a leadId and goes through /api/leads/:id/open-wo. An
// ASSIGNMENT booking — written from a season plan, which is how a
// management company's route days get scheduled — has no lead at all and
// its leadId arrives as "". The app used to build the path anyway, which
// produced /api/leads//open-wo: a path matching no route, answered with
// the catch-all 404. Standing on a Willowridge driveway, that read as
// "Couldn't open — API endpoint not found."
//
// So the first thing asserted here is that a lead-less row never routes
// through the lead endpoint. The second is that it does not raise a
// DUPLICATE: POST /api/work-orders has no upsert, so without a look-first
// step a second tap makes a second work order for the same visit — two
// documents and two invoices for one lawn.
//
// The app's mapping from booked service to work-order template is checked
// against the server's real BOOKABLE_SERVICES keys and its own
// templateForServiceKey, so the two cannot drift apart silently.

import { createRequire } from "node:module";
import {
  canStartWorkOrder,
  existingWorkOrderFor,
  isOpenWorkOrder,
  routeForRow,
  rowKey,
  templateForServiceKey
} from "../pjl-field/src/workorder-routing.js";

const require = createRequire(import.meta.url);
const { BOOKABLE_SERVICES } = require("../server/lib/availability.js");
const serverWorkOrders = require("../server/lib/work-orders.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// The two row shapes, exactly as /api/schedule/today emits them.
const leadRow = {
  leadId: "L-77", customerName: "Ali Shian", propertyId: "P-1",
  serviceKey: "fall_close_8z", workOrder: null, start: "2026-10-02T12:10:00.000Z"
};
// Note leadId: "" — an empty string, not null. That is what main's
// canonical branch emits, and what made the old path-building look safe.
const assignmentRow = {
  leadId: "", bookingId: "BK-WILLOW-19", customerName: "Willowridge Landscaping Group Homes",
  propertyId: "P-WETHERSFIELD", serviceKey: "fall_close_commercial", workOrder: null,
  start: "2026-10-02T13:01:00.000Z"
};

// ---- 1. the bug: a lead-less row must never route through a lead -----
{
  const route = routeForRow(assignmentRow);
  eq(route.action, "property", "an assignment booking routes through its property");
  ok(!("leadId" in route), "the property route carries no lead id at all");
  eq(route.propertyId, "P-WETHERSFIELD", "it carries the property to raise the work order against");
  eq(route.type, "fall_closing", "a commercial fall close is still a fall closing");

  // The specific failure, stated as an assertion: an empty leadId must
  // never reach a path segment.
  for (const empty of ["", null, undefined, 0]) {
    eq(routeForRow({ ...assignmentRow, leadId: empty }).action, "property",
      `leadId ${JSON.stringify(empty)} does not route to the lead endpoint`);
  }
}

// ---- 2. the ordinary row is untouched --------------------------------
{
  const route = routeForRow(leadRow);
  eq(route.action, "lead", "a lead booking still goes through its lead");
  eq(route.leadId, "L-77", "with the real lead id");
}

// ---- 3. a row that already has a work order just opens it ------------
{
  const wo = { id: "WO-ABC", type: "fall_closing", status: "on_site" };
  eq(routeForRow({ ...assignmentRow, workOrder: wo }).action, "open", "existing WO opens directly");
  eq(routeForRow({ ...leadRow, workOrder: wo }).workOrder.id, "WO-ABC", "the same for a lead row");
  eq(routeForRow({ ...assignmentRow, propertyId: null }).action, "none",
    "no lead, no property, no work order — nothing to do");
  ok(!canStartWorkOrder({ leadId: "", propertyId: null }), "and the button is not offered");
  ok(canStartWorkOrder(assignmentRow), "an assignment booking CAN start one, via its property");
  ok(canStartWorkOrder(leadRow), "so can a lead booking");
}

// ---- 4. no duplicate work orders -------------------------------------
{
  const openWo = { id: "WO-OPEN", type: "fall_closing", status: "scheduled" };
  const onSite = { id: "WO-ONSITE", type: "fall_closing", status: "on_site" };
  const done = { id: "WO-DONE", type: "fall_closing", status: "completed" };
  const killed = { id: "WO-X", type: "fall_closing", status: "cancelled" };
  const spring = { id: "WO-SPRING", type: "spring_opening", status: "scheduled" };

  eq(existingWorkOrderFor([openWo], "fall_closing")?.id, "WO-OPEN",
    "a second tap reopens the work order the first tap made");
  eq(existingWorkOrderFor([onSite], "fall_closing")?.id, "WO-ONSITE", "a job in progress reopens");
  eq(existingWorkOrderFor([done, killed], "fall_closing"), undefined,
    "last year's completed closing does not block this year's");
  eq(existingWorkOrderFor([spring], "fall_closing"), undefined,
    "a spring opening is not a fall closing");
  eq(existingWorkOrderFor([], "fall_closing"), undefined, "nothing on the property means create");
  eq(existingWorkOrderFor(undefined, "fall_closing"), undefined, "a missing list is not a crash");

  ok(isOpenWorkOrder({ status: "awaiting_approval" }), "awaiting approval is still open work");
  ok(!isOpenWorkOrder({ status: "no_show" }), "a no-show is not open work");
  ok(!isOpenWorkOrder(null), "no work order is not an open work order");
}

// ---- 5. the app's template mapping matches the server's --------------
{
  // Every real bookable service, checked against the server's own
  // resolver. If someone adds a service key with a new prefix, this fails
  // here rather than opening the wrong template on a driveway.
  const keys = Object.keys(BOOKABLE_SERVICES);
  ok(keys.length > 0, "there are bookable services to check");
  let mismatches = [];
  for (const key of keys) {
    const mine = templateForServiceKey(key);
    const theirs = serverWorkOrders.templateForServiceKey(key);
    if (mine !== theirs) mismatches.push(`${key}: app=${mine} server=${theirs}`);
  }
  eq(mismatches.join(" | "), "", "app and server agree on every bookable service key");

  // The commercial keys are the ones this whole change is about.
  eq(templateForServiceKey("fall_close_commercial"), "fall_closing", "commercial fall close");
  eq(templateForServiceKey("fall_close_commercial_9plus"), "fall_closing", "large commercial fall close");
  eq(templateForServiceKey("spring_open_commercial_8z"), "spring_opening", "commercial spring open");
  eq(templateForServiceKey("sprinkler_repair"), "service_visit", "a repair is a service visit");
  eq(templateForServiceKey(""), "service_visit", "an unknown service still opens something");
  eq(templateForServiceKey(undefined), "service_visit", "so does a missing one");
}

// ---- 6. rows must not collide ----------------------------------------
{
  eq(rowKey(leadRow), "L-77", "a lead row is keyed by its lead");
  eq(rowKey(assignmentRow), "BK-WILLOW-19", "an assignment row by its booking id");
  ok(rowKey(leadRow) !== rowKey(assignmentRow), "two rows never share a key");
  // Six lead-less rows on one day must produce six distinct keys, or the
  // list collapses and one spinner drives every card.
  const rows = [leadRow, assignmentRow,
    { ...assignmentRow, bookingId: "BK-2" },
    { ...assignmentRow, bookingId: "BK-3" },
    { leadId: "", bookingId: "", workOrder: { id: "WO-9" }, start: "x" },
    { leadId: "", bookingId: "", workOrder: null, start: "2026-10-02T18:00:00.000Z" }];
  eq(new Set(rows.map(rowKey)).size, rows.length, "every row on a real day keys distinctly");
  eq(rowKey({}), "", "an empty row does not throw");
}

console.log(`\nwo-routing: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

#!/usr/bin/env node
// scripts/test-visit-identity.mjs
//
// A visit is its work order. Only a reschedule of the SAME work order may
// reuse a booking record. A new booking always gets a new visit, and an old
// visit is never re-dated or recycled (Patrick, 2026-09-23).
//
// PR #298's first cut (PJL-97) opened a fresh record only when EVERY work
// order on the customer's live record was finished. Reproduced against
// bookings.upsertFromLead, April's record was MOVED to October, with the
// fall WO appended to it, when:
//   - April's work order was never closed out;
//   - another April work order was still open; or
//   - the fall booking arrived with no work-order id.
// A stale envelope still naming April's finished WO also matched April's
// record as "the same booking" and moved it. Separately, the portal's
// booking-actions, reschedule and cancel routes acted on
// listByLead(lead)[0], the customer's FIRST stored record, which can be
// the old visit.
//
//   1. same WO, new time → the same record moves (a reschedule)
//   2. new WO, old visit finished → a new record; April's closed as
//      completed, date and WOs kept
//   3. new WO, April's WO left open → a new record; April's untouched
//      (date, WOs, status) and FLAGGED for the office on both records
//   4. new WO, another April WO still open → same as 3
//   5. booking with no WO id, April has WOs → a new record, April untouched
//   6. a stale envelope naming April's FINISHED WO → a new record without
//      April's WO; April keeps its date
//   7. a not-yet-opened booking (no WO on either side) moves → reused
//   8. portal: with April's open record stored FIRST, booking-actions and
//      cancel act on the fall visit, never April's
//
// Run: node scripts/test-visit-identity.mjs   (also in build:check)

process.env.TZ = "America/Toronto";
import { bootServer } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const at = (ymd, hh, mm = 0) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d, hh, mm).toISOString(); };
const APRIL = at("2026-04-20", 9);
const FALL = at("2026-10-06", 10);
const MOVED = at("2026-10-08", 10);
const j = (v) => JSON.stringify(v);

const srv = await bootServer({ port: 30000 + Math.floor(Math.random() * 9000) });
try {
  await srv.login();
  const B = srv.lib("bookings.js");
  const recs = (leadId) => srv.data("bookings").filter((r) => r.leadId === leadId);
  const lead = (id, start, woId) => ({
    id, customerId: "C1", propertyId: "P1",
    contact: { name: "Jane Returning", email: `${id}@example.invalid`, phone: "9055550000", address: "1 A St, Newmarket, ON" },
    booking: { start, durationMinutes: 60, serviceKey: "fall_close_4z", ...(woId ? { workOrder: { id: woId } } : {}) }
  });
  // An April visit as it stands on disk, then the fall booking arriving.
  const scenario = async (leadId, { aprilWos, statusOf, fallWoId, fallStart = FALL }) => {
    await B.upsertFromLead(lead(leadId, APRIL, aprilWos[0]));
    for (const w of aprilWos.slice(1)) await B.upsertFromLead(lead(leadId, APRIL, w));
    const april = recs(leadId)[0];
    const before = j({ scheduledFor: april.scheduledFor, workOrderIds: april.workOrderIds });
    await B.upsertFromLead(lead(leadId, fallStart, fallWoId), { isFinishedWo: async (id) => statusOf[id] === "completed" });
    const after = recs(leadId);
    return { april: after.find((r) => r.id === april.id), fall: after.find((r) => r.id !== april.id), all: after, before };
  };
  const untouched = (s) => s.april && j({ scheduledFor: s.april.scheduledFor, workOrderIds: s.april.workOrderIds }) === s.before;

  // 1. a reschedule of the same work order moves the same record
  {
    await B.upsertFromLead(lead("L1", FALL, "WO-F1"));
    await B.upsertFromLead(lead("L1", MOVED, "WO-F1"), { isFinishedWo: async () => false });
    const r = recs("L1");
    ok(r.length === 1 && r[0].scheduledFor === MOVED && j(r[0].workOrderIds) === '["WO-F1"]',
      `1. same WO, new time: the same record moves (${j(r.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
  }
  // 2. new WO, April finished
  {
    const s = await scenario("L2", { aprilWos: ["WO-A2"], statusOf: { "WO-A2": "completed" }, fallWoId: "WO-F2" });
    ok(s.fall && j(s.fall.workOrderIds) === '["WO-F2"]' && s.fall.scheduledFor === FALL, `2. finished April: the fall booking is a new visit (${j(s.all.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
    ok(untouched(s) && s.april.status === "completed", `2. …April kept its date and WO, closed as completed (${s.april?.status})`);
  }
  // 3. new WO, April's WO never closed out
  {
    const s = await scenario("L3", { aprilWos: ["WO-A3"], statusOf: { "WO-A3": "in_progress" }, fallWoId: "WO-F3" });
    ok(s.fall && j(s.fall.workOrderIds) === '["WO-F3"]' && s.fall.scheduledFor === FALL, `3. April left open: the fall booking is STILL a new visit (${j(s.all.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
    ok(untouched(s) && s.april.status === "confirmed", `3. …April is not re-dated, relinked or re-statused (${j(s.april && [s.april.scheduledFor, s.april.workOrderIds, s.april.status])})`);
    ok(s.fall?.officeReview?.reason === "previous_visit_open" && s.fall.officeReview.previousBookingId === s.april?.id
      && j(s.fall.officeReview.openWorkOrderIds) === '["WO-A3"]', `3. …and the office is flagged, on the new visit (${j(s.fall?.officeReview)})`);
    ok((s.april?.history || []).some((h) => h.action === "left_open_for_review"), "3. …and on April's history");
    const listed = await srv.api("GET", "/api/bookings?leadId=L3");
    ok((listed.body.bookings || []).some((b) => b.officeReview?.previousBookingId === s.april?.id),
      "3. …and the Bookings page's API carries the flag");
  }
  // 4. new WO, another April WO still open
  {
    const s = await scenario("L4", { aprilWos: ["WO-A4", "WO-R4"], statusOf: { "WO-A4": "completed", "WO-R4": "scheduled" }, fallWoId: "WO-F4" });
    ok(s.fall && j(s.fall.workOrderIds) === '["WO-F4"]' && untouched(s), `4. an April repair still open: new visit, April untouched (${j(s.all.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
    ok(j(s.fall?.officeReview?.openWorkOrderIds) === '["WO-R4"]', `4. …flagged with the open repair only (${j(s.fall?.officeReview)})`);
  }
  // 5. the fall booking carries no WO id
  {
    const s = await scenario("L5", { aprilWos: ["WO-A5"], statusOf: { "WO-A5": "completed" }, fallWoId: null });
    ok(s.fall && s.fall.scheduledFor === FALL && j(s.fall.workOrderIds) === "[]" && untouched(s),
      `5. no WO id on the booking: new visit, April untouched (${j(s.all.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
  }
  // 6. a stale envelope naming April's FINISHED WO
  {
    const s = await scenario("L6", { aprilWos: ["WO-A6"], statusOf: { "WO-A6": "completed" }, fallWoId: "WO-A6" });
    ok(s.fall && s.fall.scheduledFor === FALL && !(s.fall.workOrderIds || []).includes("WO-A6") && untouched(s),
      `6. an envelope still naming April's finished WO: new visit without it, April keeps its date (${j(s.all.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
  }
  // 6b. …then Open WO attaches a fresh WO to the fall visit (the envelope
  //     still names April's): a later re-sync must not open ANOTHER record
  {
    const fallRec = recs("L6").find((r) => r.scheduledFor === FALL);
    if (fallRec) await B.attachWorkOrder(fallRec.id, "WO-F6-FRESH");
    await B.upsertFromLead(lead("L6", FALL, "WO-A6"), { isFinishedWo: async (id) => id === "WO-A6" });
    const r = recs("L6");
    ok(r.length === 2 && r.filter((x) => x.scheduledFor === FALL).length === 1,
      `6b. re-syncing the stale envelope finds the same fall visit — no duplicate (${j(r.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
  }
  // 6c. the same appointment gains a replacement WO id: one record, not two
  {
    await B.upsertFromLead(lead("L6C", FALL, "WO-OLDID"));
    await B.upsertFromLead(lead("L6C", FALL, "WO-NEWID"), { isFinishedWo: async () => false });
    const r = recs("L6C");
    ok(r.length === 1 && r[0].scheduledFor === FALL, `6c. same start, replaced WO id: the same visit, never a second slot (${j(r.map((x) => [x.scheduledFor, x.workOrderIds]))})`);
  }
  // 7b. a not-yet-opened booking from the PAST is history: never moved
  {
    await B.upsertFromLead(lead("L7B", APRIL, null));
    await B.upsertFromLead(lead("L7B", FALL, null), { isFinishedWo: async () => false });
    const r = recs("L7B");
    ok(r.length === 2 && r.some((x) => x.scheduledFor === APRIL), `7b. a past booking with no WO is not re-dated (${j(r.map((x) => x.scheduledFor))})`);
  }
  // 7. a not-yet-opened booking moves
  {
    // Relative to today: the rule only moves a booking that isn't in the past.
    const soon = new Date(Date.now() + 20 * 86400000); soon.setHours(10, 0, 0, 0);
    const later = new Date(Date.now() + 22 * 86400000); later.setHours(10, 0, 0, 0);
    await B.upsertFromLead(lead("L7", soon.toISOString(), null));
    await B.upsertFromLead(lead("L7", later.toISOString(), null), { isFinishedWo: async () => false });
    const r = recs("L7");
    ok(r.length === 1 && r[0].scheduledFor === later.toISOString(), `7. no WO on either side: the booking moves on its own record (${j(r.map((x) => x.scheduledFor))})`);
  }

  // 8. the portal acts on the fall visit, whatever the storage order
  {
    const LEAD = "lead-visit-identity";
    const TOKEN = "tok-visit-identity-0123456789abcdef";
    srv.writeData("leads", [{
      id: LEAD, createdAt: "2026-03-01T12:00:00Z", status: "won", portal: { token: TOKEN },
      contact: { name: "Jane Returning", email: "visit-identity@example.invalid", address: "1 A St, Newmarket, ON" },
      booking: { start: FALL, end: at("2026-10-06", 10, 45), durationMinutes: 45, serviceKey: "fall_close_4z",
        serviceLabel: "Fall winterization", coords: { lat: 44.05, lng: -79.46 },
        workOrder: { id: "WO-FALL26", status: "scheduled", createdAt: at("2026-08-30", 12) } }
    }]);
    const rec = (id, when, woIds) => ({ id, leadId: LEAD, propertyId: null, customerName: "Jane Returning",
      customerEmail: "visit-identity@example.invalid", address: "1 A St, Newmarket, ON", scheduledFor: when, durationMinutes: 45,
      serviceKey: "fall_close_4z", serviceLabel: "Fall winterization", status: "confirmed", workOrderIds: woIds, history: [], rescheduleCount: 0 });
    // April's never-closed record FIRST, the fall visit second.
    srv.writeData("bookings", [rec("BK-2026-0101", APRIL, ["WO-APRIL26"]), rec("BK-2026-0102", FALL, ["WO-FALL26"])]);
    srv.writeData("work-orders", [
      { id: "WO-APRIL26", leadId: LEAD, type: "spring_opening", status: "in_progress", scheduledFor: APRIL, createdAt: at("2026-04-01", 12), updatedAt: at("2026-04-20", 11), zones: [] },
      { id: "WO-FALL26", leadId: LEAD, type: "fall_closing", status: "scheduled", scheduledFor: FALL, createdAt: at("2026-09-01", 12), updatedAt: at("2026-09-01", 12), zones: [] }
    ]);
    const acts = await srv.api("GET", `/api/portal/${TOKEN}/booking-actions`);
    ok(acts.body.bookingId === "BK-2026-0102", `8. portal booking-actions is about the fall visit (${acts.body.bookingId})`);
    const cancel = await srv.api("POST", `/api/portal/${TOKEN}/cancel`, { reason: "Changed plans", reasonCode: "other" });
    const byId = (id) => srv.data("bookings").find((r) => r.id === id);
    ok(cancel.status === 200 && byId("BK-2026-0102")?.status === "cancelled", `8. portal cancel cancels the fall visit (${cancel.status} ${byId("BK-2026-0102")?.status})`);
    ok(byId("BK-2026-0101")?.status === "confirmed" && byId("BK-2026-0101")?.scheduledFor === APRIL,
      `8. …and never touches April's (${byId("BK-2026-0101")?.status} ${byId("BK-2026-0101")?.scheduledFor})`);
  }
} catch (e) {
  failed += 1;
  console.error(`  FAIL: crashed: ${e?.stack || e}`);
} finally {
  await srv.stop();
}

console.log(`visit-identity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

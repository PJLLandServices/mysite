#!/usr/bin/env node
// scripts/test-ubst-wo-binds-one-booking.mjs — T3 (P-PJL-39: PJL-133/136)
//
// FAIL-FIRST. A Work Order fulfils exactly one Booking, and says which.
//
// Today a Work Order has no bookingId field at all. A work order raised for
// a LEAD is attached to the lead's current record (PJL-93 fix); a work order
// raised against a PROPERTY — the Field app's path for every season-plan
// visit — is attached to nothing, so no season-plan booking ever learns
// which Work Order fulfilled it, and a second property-only POST makes a
// second open job for the same visit. A dead booking blocks a new WO only
// when it is a lead booking (the guard reads lead.booking). Deleting a WO
// leaves its id on the Booking.
//
//   A. property-only WO for a live assignment booking → linked both ways;
//      Today shows one row naming it; a second POST does not make a twin.
//   B. property-only WO against a CANCELLED assignment booking → refused.
//   C. lead WO → wo.bookingId; DELETE of that WO leaves no dead id behind.
//   D. the Work Order shape carries bookingId.
//
// Expected on origin/main @ 305d7e3: 9 of 17 assertions fail (verified
// 2026-10-06): no bookingId on either path; the property-path WO is linked
// to nothing and Today's row for the visit shows no work order; a second
// property POST opens a twin; a cancelled assignment booking does not block
// a new WO; a deleted WO leaves its id on the Booking.
//
// After PJL-133 (Phase 1, the contract): 5 of 17 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-wo-binds-one-booking.mjs

import fs from "node:fs";
import path from "node:path";
import {
  ROOT, bootUbst, reporter, iso,
  makeProperty, seedProperties, seedPlan, bookNow, bookingOnDisk,
  makeLead, seedLeads, healLead, openWoForProperty, openWoForLead, getWo, woOnDisk, todayRows
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-wo-binds-one-booking");
const { ok, j } = R;
const PORT = 4872;
const DAY_A = "2026-10-20", DAY_B = "2026-10-21", DAY_C = "2026-10-22";

const srv = await bootUbst({ port: PORT });
try {
  const PA = makeProperty({ code: "P-WOA", name: "Alice Assignment" });
  const PB = makeProperty({ code: "P-WOB", name: "Bob Cancelled" });
  const PC = makeProperty({ code: "P-WOC", name: "Carol Lead" });
  seedProperties(srv, [PA, PB, PC]);
  await seedPlan(srv, { days: {
    [DAY_A]: { label: "A", morning: ["P-WOA"], afternoon: [] },
    [DAY_B]: { label: "B", morning: ["P-WOB"], afternoon: [] }
  } });

  // ---- A. the Field app's door for a season-plan visit ---------------------
  {
    const b = await bookNow(srv, { code: "P-WOA", date: DAY_A });
    ok("[A] Book now creates the assignment booking", b.outcome === "created" && b.bookingId, j(b.body));
    const w = await openWoForProperty(srv, PA.id);
    ok("[A] POST /api/work-orders {type, propertyId} creates the work order", (w.status === 200 || w.status === 201) && w.wo?.id, j(w.body));
    const wo = w.wo ? await getWo(srv, w.wo.id) : null;
    const rec = b.bookingId ? bookingOnDisk(srv, b.bookingId) : null;
    ok("[A] the work order names the Booking it fulfils (wo.bookingId)", wo && wo.bookingId === b.bookingId, j({ bookingId: wo?.bookingId ?? "(no such field)" }));
    ok("[A] the Booking names the work order (workOrderIds)", rec && (rec.workOrderIds || []).includes(w.wo?.id), j(rec?.workOrderIds));
    const today = await todayRows(srv, DAY_A);
    const mine = today.rows.filter((r) => r.propertyId === PA.id || r.workOrder?.id === w.wo?.id);
    ok("[A] Today shows ONE row for the visit", mine.length === 1, j(mine.map((r) => ({ source: r.source, bookingId: r.bookingId, wo: r.workOrder?.id || null }))));
    ok("[A] …and that row names the work order", mine.length === 1 && mine[0].workOrder?.id === w.wo?.id, j(mine[0]?.workOrder ?? null));
    const twin = await openWoForProperty(srv, PA.id);
    const openForA = (srv.data("work-orders") || []).filter((x) => x.propertyId === PA.id && !["completed", "cancelled", "no_show"].includes(x.status) && !x.deletedAt);
    ok("[A] a second POST for the same visit does not open a second job (refused, or the same work order back)",
      twin.status === 409 || (twin.wo && twin.wo.id === w.wo?.id) || openForA.length === 1,
      j({ status: twin.status, ids: openForA.map((x) => x.id) }));
  }

  // ---- B. a dead assignment booking cannot grow a work order -----------------
  {
    const b = await bookNow(srv, { code: "P-WOB", date: DAY_B });
    ok("[B] Book now creates the assignment booking", b.outcome === "created" && b.bookingId, j(b.body));
    const c = await srv.api("POST", `/api/bookings/${b.bookingId}/cancel`, { reasonCode: "customer_cancelled", notifyCustomer: false });
    ok("[B] the booking is cancelled", c.status === 200, j(c.body));
    const w = await openWoForProperty(srv, PB.id);
    ok("[B] a work order against the property of a cancelled visit is refused (409), as it is for a cancelled lead booking",
      w.status === 409, j({ status: w.status, id: w.wo?.id || null }));
  }

  // ---- C. the lead door, and a deleted work order --------------------------
  {
    const lead = makeLead({ propertyId: PC.id, name: "Carol Lead", address: PC.address, start: iso(DAY_C, 9, 0), woId: "WO-UBSTC001" });
    seedLeads(srv, [lead]);
    const rec = await healLead(srv, lead.id);
    ok("[C] the lead's envelope has a canonical record", Boolean(rec?.id), j(rec));
    const w = await openWoForLead(srv, lead.id);
    ok("[C] POST /api/work-orders {type, leadId} creates the work order", (w.status === 200 || w.status === 201) && w.wo?.id, j(w.body));
    const after = rec?.id ? bookingOnDisk(srv, rec.id) : null;
    ok("[C] the lead's record links the work order (PJL-93, kept)", after && (after.workOrderIds || []).includes(w.wo?.id), j(after?.workOrderIds));
    const wo = w.wo ? await getWo(srv, w.wo.id) : null;
    ok("[C] the work order names the Booking (wo.bookingId)", wo && wo.bookingId === rec?.id, j({ bookingId: wo?.bookingId ?? "(no such field)" }));
    const del = w.wo ? await srv.api("DELETE", `/api/work-orders/${w.wo.id}`) : { status: 0, body: null };
    const gone = w.wo ? !woOnDisk(srv, w.wo.id) || Boolean(woOnDisk(srv, w.wo.id)?.deletedAt) : false;
    const recNow = rec?.id ? bookingOnDisk(srv, rec.id) : null;
    ok("[C] deleting the work order leaves no dead id on the Booking (or the delete is refused)",
      del.status !== 200 || !gone || !(recNow?.workOrderIds || []).includes(w.wo?.id),
      j({ delete: del.status, gone, workOrderIds: recNow?.workOrderIds }));
  }

  // ---- D. the shape ---------------------------------------------------------
  {
    const src = fs.readFileSync(path.join(ROOT, "server", "lib", "work-orders.js"), "utf8");
    const blank = src.slice(src.indexOf("function blankWorkOrder"), src.indexOf("function blankWorkOrder") + 6000);
    ok("[D] blankWorkOrder() carries bookingId", /bookingId\s*:/.test(blank), "work-orders.js has no bookingId field");
    ok("[D] work-orders.js resolves scheduled work by Booking id (a resolveForBooking / byBookingId reader exists)",
      /function (resolveForBooking|workOrderForBooking|listByBooking|byBookingId)/.test(src), "only workOrderForLeadBooking (lead heuristics) exists");
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 5 });

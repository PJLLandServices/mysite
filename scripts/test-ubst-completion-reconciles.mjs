#!/usr/bin/env node
// scripts/test-ubst-completion-reconciles.mjs — T4 (P-PJL-39: PJL-136)
//
// FAIL-FIRST. Completing the Work Order for a Booking completes the Booking,
// and a Work Order that dies (cancelled / no-show on the desk) reconciles it.
//
// Today the completion cascade writes property.serviceRecords, an invoice
// and warranty metadata and never touches bookings.json or the lead
// envelope. A completed visit therefore stays `confirmed`: the plan reads it
// as on_day, the cadence keeps messaging it, the iCal feed keeps it, capacity
// keeps it, and the portal only knows the season is done because PJL-107's
// fix reads serviceRecords instead of the Booking.
//
//   A. assignment booking + property-path WO → Finish → Booking completed,
//      plan stop `done`, Today shows it done, cadence and iCal drop it.
//   B. lead booking + Open WO → Finish → Booking completed; the envelope
//      agrees; the day-before reminder does not fire for a finished visit.
//   C. the desk cancels the WO → the Booking is reconciled.
//
// Expected on origin/main @ 305d7e3: 12 of 23 assertions fail (verified
// 2026-10-06): the Booking never completes, so the plan, Today, the cadence,
// the iCal feed and the day-before reminder all keep treating a finished
// visit as upcoming; a desk-cancelled work order leaves its Booking live.
//
// After PJL-133 (Phase 1, the contract): 12 of 23 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-completion-reconciles.mjs

import { SIGNATURE } from "./lib/field-server.mjs";
import {
  bootUbst, reporter, sleep, iso,
  makeProperty, seedProperties, seedPlan, planStop, bookNow, markMessaged, bookingOnDisk,
  makeLead, seedLeads, healLead, openWoForProperty, getWo, todayRows, deriveState,
  cadenceLiveCount, icalEventIds, reminderWouldFire, holdsItsSlot
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-completion-reconciles");
const { ok, j } = R;
const PORT = 4873;
const DAY_A = "2026-10-20", DAY_B = "2026-10-21", DAY_C = "2026-10-22";
const completeBody = () => ({ status: "completed", signature: SIGNATURE, arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });

const srv = await bootUbst({ port: PORT });
try {
  const PA = makeProperty({ code: "P-DONEA", name: "Alice Done" });
  const PB = makeProperty({ code: "P-DONEB", name: "Bob Lead" });
  const PC = makeProperty({ code: "P-DONEC", name: "Carol Desk" });
  seedProperties(srv, [PA, PB, PC]);
  await seedPlan(srv, { days: {
    [DAY_A]: { label: "A", morning: ["P-DONEA"], afternoon: [] },
    [DAY_C]: { label: "C", morning: ["P-DONEC"], afternoon: [] }
  } });

  // ---- A. the season-plan visit, finished in the field ----------------------
  {
    const b = await bookNow(srv, { code: "P-DONEA", date: DAY_A });
    ok("[A] Book now creates the assignment booking", b.outcome === "created" && b.bookingId, j(b.body));
    if (b.bookingId) await markMessaged(srv, b.bookingId);
    const liveBefore = await cadenceLiveCount(srv);
    const w = await openWoForProperty(srv, PA.id);
    ok("[A] the field opens a work order against the property", (w.status === 200 || w.status === 201) && w.wo?.id, j(w.body));
    await srv.prepClosing(w.wo.id);
    const done = await srv.api("PATCH", `/api/work-orders/${w.wo.id}`, completeBody());
    ok("[A] Finish completes the work order and runs the cascade", done.status === 200 && done.body?.workOrder?.status === "completed", j({ status: done.status, wo: done.body?.workOrder?.status, cascade: Boolean(done.body?.cascade) }));
    await sleep(600);

    const rec = bookingOnDisk(srv, b.bookingId);
    ok("[A] the Booking is completed", rec && rec.status === "completed", j({ status: rec?.status }));
    ok("[A] …with completedAt stamped", rec && typeof rec.completedAt === "string", j({ completedAt: rec?.completedAt ?? null }));
    ok("[A] …and it names the work order that fulfilled it", rec && (rec.workOrderIds || []).includes(w.wo.id), j(rec?.workOrderIds));
    const stop = await planStop(srv, { date: DAY_A, code: "P-DONEA" });
    ok("[A] the plan stop reads done (history), not an open stop", stop.state === "done", j({ inDay: stop.inDay, state: stop.state }));
    const st = await deriveState(srv, PA.id);
    ok("[A] the portal reads the season as complete", st && st.completed === true, j(st));
    const today = await todayRows(srv, DAY_A);
    const mine = today.rows.filter((r) => r.propertyId === PA.id);
    ok("[A] Today shows the visit as finished, with its work order, not as an open stop",
      mine.length === 1 && mine[0].workOrder?.id === w.wo.id && mine[0].workOrder?.status === "completed",
      j(mine.map((r) => ({ stage: r.stage, wo: r.workOrder }))));
    const live = await cadenceLiveCount(srv);
    ok("[A] the cadence stops counting a finished visit", live !== null && liveBefore !== null && live < liveBefore, `live before ${liveBefore}, after ${live}`);
    const feed = await icalEventIds(srv);
    ok("[A] the iCal feed no longer lists a finished visit as upcoming", feed.ok && !feed.ids.includes(b.bookingId), feed.ok ? j(feed.ids) : feed.error);
  }

  // ---- B. the lead visit, finished from Today's Open WO ----------------------
  {
    const lead = makeLead({ propertyId: PB.id, name: "Bob Lead", address: PB.address, start: iso(DAY_B, 9, 0), woId: "WO-UBSTB001" });
    seedLeads(srv, [lead]);
    const rec = await healLead(srv, lead.id);
    ok("[B] the lead's envelope has a canonical record", Boolean(rec?.id), j(rec));
    const opened = await srv.api("POST", `/api/leads/${lead.id}/open-wo`, {});
    const woId = opened.body?.workOrder?.id;
    ok("[B] Today's Open WO opens the visit's work order", opened.status === 200 && woId, j(opened.body));
    await srv.prepClosing(woId);
    const done = await srv.api("PATCH", `/api/work-orders/${woId}`, completeBody());
    ok("[B] Finish completes the work order", done.status === 200 && done.body?.workOrder?.status === "completed", j({ status: done.status, wo: done.body?.workOrder?.status }));
    await sleep(600);

    const after = bookingOnDisk(srv, rec?.id);
    ok("[B] the Booking is completed", after && after.status === "completed", j({ status: after?.status }));
    const leadNow = (srv.data("leads") || []).find((l) => l.id === lead.id);
    ok("[B] the lead envelope agrees (its work-order status is not frozen at scheduled)",
      leadNow?.booking && (leadNow.booking.workOrder?.status === "completed" || !holdsItsSlot(srv, leadNow.booking.status) || leadNow.booking.bookingId),
      j({ envelopeStatus: leadNow?.booking?.status ?? null, envelopeWo: leadNow?.booking?.workOrder?.status ?? null }));
    const today = await todayRows(srv, DAY_B);
    const mine = today.rows.filter((r) => r.leadId === lead.id);
    ok("[B] Today shows the lead's visit with its completed work order (PJL-73, kept)", mine.length === 1 && mine[0].workOrder?.status === "completed", j(mine.map((r) => r.workOrder)));
    const fires = await reminderWouldFire(srv, { bookingId: rec?.id, leadId: lead.id }, DAY_B);
    ok("[B] the day-before reminder does not text a customer whose visit is already finished", fires === false, "the sweep would send a reminder for a completed visit");
  }

  // ---- C. the desk cancels the work order --------------------------------------
  {
    const b = await bookNow(srv, { code: "P-DONEC", date: DAY_C });
    ok("[C] Book now creates the assignment booking", b.outcome === "created" && b.bookingId, j(b.body));
    const w = await openWoForProperty(srv, PC.id);
    ok("[C] a work order is open against the property", (w.status === 200 || w.status === 201) && w.wo?.id, j(w.body));
    const cancelled = await srv.qpatch(w.wo.id, { status: "cancelled" });
    ok("[C] the desk cancels the work order", cancelled.status === 200 && cancelled.body?.workOrder?.status === "cancelled", j({ status: cancelled.status, wo: cancelled.body?.workOrder?.status }));
    await sleep(300);
    const rec = bookingOnDisk(srv, b.bookingId);
    ok("[C] the Booking is reconciled: no longer holding its slot", rec && !holdsItsSlot(srv, rec.status), j({ status: rec?.status }));
    const stop = await planStop(srv, { date: DAY_C, code: "P-DONEC" });
    ok("[C] the plan stop has left the day", !stop.inDay, j({ inDay: stop.inDay, state: stop.state }));
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 12 });

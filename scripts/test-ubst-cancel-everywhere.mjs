#!/usr/bin/env node
// scripts/test-ubst-cancel-everywhere.mjs — T1, the Peter Bazios suite
// (P-PJL-39: PJL-132 fixture; PJL-133/134/135 make it green)
//
// FAIL-FIRST. One real appointment is one Booking, and every door that takes
// it off the calendar must leave the SAME record behind, in a terminal state
// that every reader honours.
//
// Peter Bazios, 2026-10-06: his fall assignment booking was created and the
// customer was messaged (Oct 1). Patrick then "cancelled" it through the
// Schedule page's Delete Permanently. The record was erased, so the plan
// stop read `unassigned` — stop #1 on Oct 7, drawn, sequenced, with a Book
// now button — and the next Assign would have re-booked and re-messaged him.
//
// Six doors, one contract. For each door the booking is created the way an
// assignment booking really is (Book now on a planned stop), marked as
// messaged, and then taken off through that door. Afterwards:
//
//   a. the canonical record still exists, in a terminal state, with
//      cancelledAt and its history;
//   b. the plan stop has left its day and sits in the dropped strip;
//   c. preflight refuses the stop (a recorded no, not a free property);
//   d. a season-wide Assign creates nothing for it and sends nothing;
//   e. Today for that date lists no row for it — and no work-order row;
//   f. the portal state has no upcoming booking AND a recorded "no";
//   g. the cadence no longer counts it; the iCal feed no longer lists it.
//
// Doors: DELETE (booked by mistake) · DELETE {saidNo} (#398) · PATCH status
// (the booking page's Status dropdown) · POST /cancel with a reason code
// (Schedule page Cancel, the Field app's Not today, MCP cancel_booking) ·
// the customer's own appointment page · Season Plan Unassign. Plus the same
// appointment expressed as a LEAD booking, cancelled by PATCH: the slot must
// free and Today must drop it, through the lead pass too.
//
// Expected on origin/main @ 305d7e3: 32 of 101 assertions fail (verified
// 2026-10-06). Every failure is one of the doors doing something different
// from the others: the two deletes and Unassign erase the record and return
// the stop to `unassigned` (Peter); PATCH leaves no cancelledAt and can
// revive a dead record; preflight reads a cancelled assignment as "ready"
// while Assign refuses it; the Schedule-page cancel leaves the work order
// scheduled and the Field app's "came off today" never names a lead-less
// visit; and a lead booking cancelled by PATCH keeps its slot and its Today
// row because both read the envelope.
//
// After PJL-133 (Phase 1, the contract): 34 of 101 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-cancel-everywhere.mjs

import {
  bootUbst, reporter, sleep, SEASON, YEAR, SERVICE_4Z, iso,
  makeProperty, seedProperties, seedPlan, planStop, bookNow, assignSeason, unassignSeason, preflightStop,
  markMessaged, getBooking, bookingOnDisk, appointmentToken, makeLead, seedLeads, healLead,
  openWoForProperty, getWo, todayRows, slotsOn, deriveState, cadenceLiveCount, icalEventIds, holdsItsSlot
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-cancel-everywhere");
const { ok, j } = R;

const PORT = 4871;
const DAYS = {
  DEL_MISTAKE: "2026-10-20",
  DEL_SAIDNO: "2026-10-21",
  PATCH_STATUS: "2026-10-22",
  CANCEL_ROUTE: "2026-10-23",
  APPT_PAGE: "2026-10-26",
  UNASSIGN: "2026-10-27",
  REVIVE: "2026-10-29",
  LEAD_PATCH: "2026-10-28"
};
const CODES = Object.fromEntries(Object.keys(DAYS).map((k) => [k, `P-${k.replace(/_/g, "").slice(0, 8)}`]));

const srv = await bootUbst({ port: PORT });
try {
  // ---- Fixture: seven properties, one plan, one stop each -----------------
  const props = Object.fromEntries(Object.entries(CODES).map(([k, code]) => [k, makeProperty({ code, name: `Customer ${k}` })]));
  seedProperties(srv, Object.values(props));
  const days = {};
  for (const [k, date] of Object.entries(DAYS)) {
    if (k === "LEAD_PATCH") continue;        // the lead fixture is not a plan stop
    days[date] = { label: k, morning: [CODES[k]], afternoon: [] };
  }
  await seedPlan(srv, { days });

  // Book now on each planned stop, then mark it messaged (what a blast or
  // Book now's own confirmation leaves behind, independent of the stub
  // mailer's answer).
  const booked = {};
  for (const k of Object.keys(DAYS)) {
    if (k === "LEAD_PATCH") continue;
    const r = await bookNow(srv, { code: CODES[k], date: DAYS[k] });
    ok(`fixture ${k}: Book now creates the assignment booking`, r.outcome === "created" && r.bookingId, j(r.body));
    if (r.bookingId) {
      await markMessaged(srv, r.bookingId);
      booked[k] = r.bookingId;
    }
  }
  // The Not-today door also has a work order open against the property,
  // the way a tech's morning really looks.
  let cancelRouteWo = null;
  if (booked.CANCEL_ROUTE) {
    const w = await openWoForProperty(srv, props.CANCEL_ROUTE.id);
    ok("fixture CANCEL_ROUTE: a work order is open against the property", w.status === 201 || w.status === 200, j(w.body));
    cancelRouteWo = w.wo;
  }

  const liveBefore = await cadenceLiveCount(srv);

  // ---- The shared contract, asserted after each door ----------------------
  async function assertContract(k, { expectRemoved = false, expectWoCancelled = null } = {}) {
    const code = CODES[k], date = DAYS[k], id = booked[k];
    const label = `[${k}]`;
    if (!id) { ok(`${label} fixture exists`, false, "no booking was created"); return; }

    // a. the record survives, terminal, dated, with history
    const rec = bookingOnDisk(srv, id);
    ok(`${label} a. the canonical record still exists after the door`, Boolean(rec), `${id} is gone from bookings.json`);
    ok(`${label} a. …in a terminal state`, rec && !holdsItsSlot(srv, rec.status), j(rec?.status));
    ok(`${label} a. …with cancelledAt stamped`, rec && typeof rec.cancelledAt === "string" && rec.cancelledAt, j({ status: rec?.status, cancelledAt: rec?.cancelledAt ?? null }));
    ok(`${label} a. …and a history entry naming the removal`,
      rec && (rec.history || []).some((h) => /cancel|no_show|removed|deleted|declin/i.test(`${h.action} ${h.note}`)),
      j((rec?.history || []).map((h) => h.action)));

    // b. the plan stop left its day and is listed as dropped
    const stop = await planStop(srv, { date, code });
    ok(`${label} b. the stop is no longer in the day's buckets`, !stop.inDay, j({ inDay: stop.inDay, state: stop.state, stopNumber: stop.stopNumber }));
    ok(`${label} b. …and is listed in the day's dropped strip with a dead state`,
      Boolean(stop.dropped) && ["cancelled", "no_show", "skipped"].includes(stop.dropped.state), j(stop.dropped));

    // c. preflight refuses it
    const pf = await preflightStop(srv, { code });
    ok(`${label} c. preflight does not read the stop as ready to book`, pf && pf.outcome !== "ready", j(pf));

    // e. Today for that date: no row, and no work-order row either
    const today = await todayRows(srv, date);
    const mine = today.rows.filter((r) => r.propertyId === props[k].id || r.bookingId === id);
    ok(`${label} e. Today lists no row for the property on that date`, mine.length === 0, j(mine.map((r) => ({ source: r.source, bookingId: r.bookingId, wo: r.workOrder?.id }))));
    if (expectRemoved) {
      ok(`${label} e. Today's "came off today" names the removed visit`, today.removed.some((r) => r.bookingId === id), j(today.removed));
    }

    // f. the portal: nothing upcoming, and a recorded no
    const state = await deriveState(srv, props[k].id);
    ok(`${label} f. deriveBookingState: nothing upcoming`, state && state.hasBooking === false, j(state));
    const property = (srv.data("properties") || []).find((p) => p.id === props[k].id) || {};
    const skipped = property.seasonalOutreach?.[`${YEAR}:${SEASON}`]?.optOutThisSeason === true;
    ok(`${label} f. …and the system holds a recorded "no" for the season (a cancelled record or the skip flag)`,
      Boolean(state?.declined) || skipped, j({ declined: state?.declined ?? null, skipped }));

    // g. cadence + iCal
    const live = await cadenceLiveCount(srv);
    ok(`${label} g. the cadence no longer counts it as live`, live !== null && live < liveBefore, `live before ${liveBefore}, now ${live}`);
    const feed = await icalEventIds(srv);
    ok(`${label} g. the iCal feed no longer lists it`, feed.ok && !feed.ids.includes(id), feed.ok ? j(feed.ids) : feed.error);

    // k. the work order, when one was open
    if (expectWoCancelled) {
      const wo = await getWo(srv, expectWoCancelled);
      ok(`${label} k. the open work order was cancelled with the booking`, wo && wo.status === "cancelled", j({ id: wo?.id, status: wo?.status }));
    }
  }

  // ---- Door 1: DELETE, "booked by mistake" --------------------------------
  {
    const r = await srv.api("DELETE", `/api/bookings/${booked.DEL_MISTAKE}`, {});
    // Since PJL-133 the library refuses to erase a booking the customer was
    // told about (409 customer_was_told); until PJL-135 turns the door into a
    // cancellation, the record is left exactly as it was — which the
    // contract below reports.
    ok("[DEL_MISTAKE] the delete route answers", r.status === 200 || r.status === 409, j(r.body));
    await assertContract("DEL_MISTAKE");
  }

  // ---- Door 2: DELETE with saidNo (#398) ---------------------------------
  {
    const r = await srv.api("DELETE", `/api/bookings/${booked.DEL_SAIDNO}`, { saidNo: true });
    ok("[DEL_SAIDNO] the delete route answers", r.status === 200 || r.status === 409, j(r.body));
    await assertContract("DEL_SAIDNO");
  }

  // ---- Door 3: PATCH status (the booking page's Status dropdown) ----------
  {
    const r = await srv.api("PATCH", `/api/bookings/${booked.PATCH_STATUS}`, { status: "cancelled" });
    ok("[PATCH_STATUS] the PATCH route answers", r.status === 200 || r.status === 405 || r.status === 422, j(r.body));
    await assertContract("PATCH_STATUS");
  }

  // ---- Door 3b: the same PATCH cannot revive a dead record (own fixture) ---
  {
    const dead = await srv.api("POST", `/api/bookings/${booked.REVIVE}/cancel`, { reasonCode: "customer_cancelled", notifyCustomer: false });
    ok("[REVIVE] the fixture is cancelled through the real cancel route", dead.status === 200, j(dead.body));
    const revive = await srv.api("PATCH", `/api/bookings/${booked.REVIVE}`, { status: "confirmed" });
    const after = bookingOnDisk(srv, booked.REVIVE);
    ok("[REVIVE] a cancelled booking cannot be revived to confirmed by PATCH",
      revive.status !== 200 || (after && after.status !== "confirmed"), j({ status: revive.status, now: after?.status }));
    // Put it back the way the door found it, so the sweeps below judge a
    // cancelled record and not one this suite revived.
    if (after && after.status === "confirmed") {
      await srv.api("POST", `/api/bookings/${booked.REVIVE}/cancel`, { reasonCode: "customer_cancelled", notifyCustomer: false });
    }
  }

  // ---- Door 4: POST /cancel with a reason code (Schedule Cancel, Not today, MCP) --
  {
    const r = await srv.api("POST", `/api/bookings/${booked.CANCEL_ROUTE}/cancel`, { reasonCode: "customer_cancelled", note: "rang the office", notifyCustomer: false });
    ok("[CANCEL_ROUTE] the cancel route answers", r.status === 200, j(r.body));
    await assertContract("CANCEL_ROUTE", { expectRemoved: true, expectWoCancelled: cancelRouteWo?.id || null });
  }

  // ---- Door 5: the customer's appointment page -----------------------------
  {
    const token = await appointmentToken(srv, booked.APPT_PAGE);
    ok("[APPT_PAGE] the booking has an appointment token", Boolean(token), "ensureToken returned nothing");
    const r = token ? await srv.api("POST", `/api/appointment/${token}/cancel`, { reasonCode: "another_company" }) : { status: 0, body: null };
    ok("[APPT_PAGE] the appointment page cancel answers", r.status === 200, j(r.body));
    await assertContract("APPT_PAGE");
  }

  // ---- Door 6: Season Plan Unassign (last: it sweeps every pristine record) --
  {
    const r = await unassignSeason(srv);
    ok("[UNASSIGN] the unassign route answers", r.status === 200, j(r.body));
    ok("[UNASSIGN] it did not remove a booking the customer was already messaged about",
      !(r.body?.removed || []).some((x) => x.bookingId === booked.UNASSIGN), j(r.body?.removed));
    await assertContract("UNASSIGN");
  }

  // ---- d. A season-wide Assign now creates nothing for any of them ----------
  {
    await sleep(500);                       // let the doors' own alerts land before the count starts
    const sentBefore = srv.outbox().length;
    const run = await assignSeason(srv);
    ok("[ALL] a season-wide Assign answers", run.status === 200, j(run.body?.errors || run.summary));
    const created = run.stops.filter((s) => s.outcome === "created");
    ok("[ALL] d. it creates no booking for a stop whose customer already said no or was taken off",
      created.length === 0, j(created.map((s) => `${s.code}@${s.date}`)));
    await sleep(500);
    const sentByRun = srv.outbox().length - sentBefore;
    ok("[ALL] d. …and nothing was sent by the run", sentByRun === 0, `${sentByRun} outbound entries during the run`);
  }

  // ---- The same appointment as a LEAD booking, cancelled by PATCH ------------
  {
    const date = DAYS.LEAD_PATCH;
    // At 08:00, the first morning slot: while the booking is live the first
    // offered start is later; once it is dead, 08:00 is offered again (the
    // same signal scripts/test-booking-lifecycle.mjs reads).
    const lead = makeLead({ propertyId: props.LEAD_PATCH.id, name: "Lead Customer", address: props.LEAD_PATCH.address, start: iso(date, 8, 0) });
    seedLeads(srv, [lead]);
    const rec = await healLead(srv, lead.id);
    ok("[LEAD_PATCH] the lead's envelope has a canonical record", Boolean(rec?.id), j(rec));
    const starts = (s) => j((s.starts || []).map((x) => x.slice(11, 16)));
    const before = await slotsOn(srv, { date, address: props.LEAD_PATCH.address });
    const todayBefore = await todayRows(srv, date);
    ok("[LEAD_PATCH] before: Today lists the lead's visit", todayBefore.rows.some((r) => r.leadId === lead.id), j(todayBefore.rows.map((r) => r.leadId)));
    const firstBefore = (before.starts || [])[0] || null;

    const r = rec?.id ? await srv.api("PATCH", `/api/bookings/${rec.id}`, { status: "cancelled" }) : { status: 0 };
    ok("[LEAD_PATCH] the PATCH route answers", r.status === 200 || r.status === 405 || r.status === 422, j(r.body));

    const after = await slotsOn(srv, { date, address: props.LEAD_PATCH.address });
    const firstAfter = (after.starts || [])[0] || null;
    ok("[LEAD_PATCH] the 08:00 start is offered again once the booking is dead (capacity reads the Booking, not the lead envelope)",
      before.ok && after.ok && firstAfter && firstAfter < firstBefore,
      before.ok && after.ok ? `first start ${firstBefore?.slice(11, 16)} before, ${firstAfter?.slice(11, 16)} after (${starts(before)} → ${starts(after)})` : `availability: ${before.error || after.error}`);
    const todayAfter = await todayRows(srv, date);
    ok("[LEAD_PATCH] Today no longer lists the lead's visit", !todayAfter.rows.some((r) => r.leadId === lead.id), j(todayAfter.rows.map((r) => ({ leadId: r.leadId, bookingId: r.bookingId }))));
    const leadNow = (srv.data("leads") || []).find((l) => l.id === lead.id);
    ok("[LEAD_PATCH] the lead envelope agrees with the Booking (or no longer carries a status of its own)",
      !leadNow?.booking || !holdsItsSlot(srv, leadNow.booking.status) || leadNow.booking.bookingId, j(leadNow?.booking?.status ?? null));
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 34 });

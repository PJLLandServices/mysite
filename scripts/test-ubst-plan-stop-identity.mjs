#!/usr/bin/env node
// scripts/test-ubst-plan-stop-identity.mjs — T8 (P-PJL-39: PJL-134)
//
// FAIL-FIRST. A Season Plan stop is route metadata attached to a Booking,
// not a second appointment. Once a stop has been booked it carries that
// Booking's id in the stored plan, keeps it through every plan rewrite, and
// never returns to "planned, unbooked" because the record went away.
//
//   A. after Book now the stored plan day carries the bookingId (not only
//      the derived payload); a plan re-import keeps it; a move carries it.
//   B. a route rebuild (reorder, auto-order) creates no second Booking.
//   C. a stop whose Booking was removed never reads `unassigned`: the plan
//      remembers the booking existed, and a Book now on it is refused or
//      explicitly re-books with the old id in its history.
//   D. the stored plan has one owner per stop: a code appears once.
//
// Expected on origin/main @ 305d7e3: 4 of 15 assertions fail (verified
// 2026-10-06): the stored plan carries codes only; a stop whose booking was
// removed reads `unassigned` and Book now quietly books it again.
//
// After PJL-133 (Phase 1, the contract): 4 of 15 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-plan-stop-identity.mjs

import {
  bootUbst, reporter, sleep, SEASON, YEAR,
  makeProperty, seedProperties, seedPlan, getPlan, planStop, storedPlanStop, bookNow, bookingOnDisk
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-plan-stop-identity");
const { ok, j } = R;
const PORT = 4877;
const DAY = "2026-10-20", DAY2 = "2026-10-21";
const base = `/api/season-plans/${SEASON}/${YEAR}`;

const srv = await bootUbst({ port: PORT });
try {
  const PA = makeProperty({ code: "P-IDA", name: "Ida Assigned" });
  const PB = makeProperty({ code: "P-IDB", name: "Ivan Bystander" });
  const PC = makeProperty({ code: "P-IDC", name: "Iris Removed" });
  seedProperties(srv, [PA, PB, PC]);
  await seedPlan(srv, { days: { [DAY]: { label: "R1", morning: ["P-IDA", "P-IDB", "P-IDC"], afternoon: [] }, [DAY2]: { label: "R2", morning: [], afternoon: [] } } });

  // ---- A. identity on the stop ----------------------------------------------
  const a = await bookNow(srv, { code: "P-IDA", date: DAY });
  ok("[A] Book now creates the booking", a.outcome === "created" && a.bookingId, j(a.body));
  const shown = await planStop(srv, { date: DAY, code: "P-IDA" });
  ok("[A] the plan payload shows the stop with its bookingId (derived today)", shown.inDay && shown.bookingId === a.bookingId, j({ state: shown.state, bookingId: shown.bookingId }));
  const stored = storedPlanStop(srv, { date: DAY, code: "P-IDA" });
  ok("[A] the STORED plan day carries the bookingId for the stop", stored && (stored.raw?.bookingId === a.bookingId || stored.placed?.bookingId === a.bookingId || stored.bookingId === a.bookingId),
    j({ raw: stored?.raw, placed: stored?.placed }));

  // a re-import of the same plan keeps it
  const current = await getPlan(srv);
  const reimport = { bucketCap: 5, dayCap: 10, days: Object.fromEntries((current.days || []).map((d) => [d.date, { label: d.label, morning: (d.morning || []).map((s) => s.code), afternoon: (d.afternoon || []).map((s) => s.code) }])) };
  await srv.api("PUT", base, reimport);
  const afterImport = await planStop(srv, { date: DAY, code: "P-IDA" });
  ok("[A] after a plan re-import the stop still names its booking", afterImport.inDay && afterImport.bookingId === a.bookingId, j({ state: afterImport.state, bookingId: afterImport.bookingId }));
  const storedAfter = storedPlanStop(srv, { date: DAY, code: "P-IDA" });
  ok("[A] …and the stored plan still carries it", storedAfter && (storedAfter.raw?.bookingId === a.bookingId || storedAfter.placed?.bookingId === a.bookingId), j({ raw: storedAfter?.raw, placed: storedAfter?.placed }));

  // a move carries it
  const mv = await srv.api("PATCH", `${base}/move`, { propertyCode: "P-IDA", toDate: DAY2, toBucket: "morning" });
  ok("[A] the stop moves to another day", mv.status === 200, j(mv.body?.errors || mv.body?.moved));
  await sleep(300);
  const moved = await planStop(srv, { date: DAY2, code: "P-IDA" });
  const rec = bookingOnDisk(srv, a.bookingId);
  ok("[A] the SAME booking followed the move (id unchanged, date updated)", moved.inDay && moved.bookingId === a.bookingId && rec?.assignment?.date === DAY2, j({ onDay2: moved.inDay, bookingId: moved.bookingId, assignmentDate: rec?.assignment?.date }));
  const bookingsForA = (srv.data("bookings") || []).filter((b) => b.propertyId === PA.id);
  ok("[A] no second booking was created by the move", bookingsForA.length === 1, j(bookingsForA.map((b) => b.id)));

  // ---- B. a route rebuild creates nothing -----------------------------------
  {
    const b = await bookNow(srv, { code: "P-IDB", date: DAY });
    ok("[B] a second stop is booked", b.outcome === "created", j(b.body));
    const before = (srv.data("bookings") || []).length;
    await srv.api("PATCH", `${base}/stop-order`, { date: DAY, bucket: "morning", propertyCode: "P-IDB", direction: "up" });
    await srv.api("PATCH", `${base}/auto-order`, { date: DAY });
    await sleep(300);
    ok("[B] reorder + auto-order created no booking", (srv.data("bookings") || []).length === before, `${before} → ${(srv.data("bookings") || []).length}`);
  }

  // ---- C. a removed booking never makes the stop "unassigned" again ---------
  {
    const c = await bookNow(srv, { code: "P-IDC", date: DAY });
    ok("[C] the stop is booked", c.outcome === "created" && c.bookingId, j(c.body));
    const del = await srv.api("DELETE", `/api/bookings/${c.bookingId}`, {});
    ok("[C] the admin delete answers", del.status === 200, j(del.body));
    const stop = await planStop(srv, { date: DAY, code: "P-IDC" });
    ok("[C] the stop does not read unassigned (planned, never booked) after its booking was removed", stop.state !== "unassigned", j({ inDay: stop.inDay, state: stop.state, dropped: stop.dropped }));
    const again = await bookNow(srv, { code: "P-IDC", date: DAY });
    const recs = (srv.data("bookings") || []).filter((b) => b.propertyId === PC.id);
    ok("[C] Book now on that stop does not silently create a fresh appointment (refused, or the new record names the removed one)",
      again.outcome !== "created" || recs.some((b) => (b.history || []).some((h) => /rebook|previous|removed|deleted/i.test(`${h.action} ${h.note}`))),
      j({ outcome: again.outcome, records: recs.map((b) => ({ id: b.id, history: (b.history || []).map((h) => h.action) })) }));
  }

  // ---- D. one owner per code ---------------------------------------------------
  {
    const all = srv.data("season-plans");
    const plan = all && all[`${SEASON}-${YEAR}`];
    const seen = new Map();
    for (const [date, day] of Object.entries(plan?.days || {})) for (const bucket of ["morning", "afternoon"]) for (const code of day[bucket] || []) seen.set(code, (seen.get(code) || 0) + 1);
    ok("[D] every code appears once in the stored plan", [...seen.values()].every((n) => n === 1), j([...seen.entries()]));
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 4 });

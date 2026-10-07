#!/usr/bin/env node
// scripts/test-ubst-season-walk.mjs — T10 (P-PJL-39: the project's gate)
//
// FAIL-FIRST. One season, walked the way Patrick walks it, on a throwaway
// copy of the system, with ONE invariant asserted after every step:
//
//   every reader agrees with the Booking.
//
// Concretely, after each step:
//   - for every Booking on a walked day, the plan drives it ⇔ it holds its
//     slot, and Today lists it ⇔ it holds its slot;
//   - once Assign has run, every planned stop on a walked day has a Booking
//     or a recorded "no" (cancelled / no-show / skipped) — never "unassigned";
//   - no dated Work Order on a walked day stands without a Booking that names it;
//   - the set of properties Today lists equals the set the driven plan lists.
//
// The walk: import plan → Assign → confirmations → customer answers (confirm,
// time window, cancel) → Patrick's edits (move a stop, delete a booking,
// Status dropdown) → Today → open work orders → finish one → desk-cancel one.
// Each of tonight's four gaps (#390/#397, #395, #398, #399) is a step here,
// so this suite would have failed before each of them shipped.
//
// Expected on origin/main @ 305d7e3: 8 of 108 assertions fail (verified
// 2026-10-06): the stop whose booking Patrick deleted reads `unassigned` on
// every later step while Today no longer lists it (the plan and the truck
// disagree); the finished visit's Booking stays `confirmed`; the
// desk-cancelled work order leaves its Booking live.
//
// After PJL-133 (Phase 1, the contract): 3 of 117 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-season-walk.mjs

import { SIGNATURE } from "./lib/field-server.mjs";
import {
  bootUbst, reporter, sleep, SEASON, YEAR,
  makeProperty, seedProperties, seedPlan, getPlan, assignSeason, markMessaged, appointmentToken,
  bookingOnDisk, openWoForProperty, getWo, todayRows, holdsItsSlot
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-season-walk");
const { ok, j } = R;
const PORT = 4879;
const D1 = "2026-10-20", D2 = "2026-10-21", D3 = "2026-10-22";
const WALKED = [D1, D2, D3];
const base = `/api/season-plans/${SEASON}/${YEAR}`;
const localDay = (isoStr) => { const d = new Date(isoStr); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const srv = await bootUbst({ port: PORT });
try {
  const props = ["P-W1", "P-W2", "P-W3", "P-W4", "P-W5", "P-W6"].map((code) => makeProperty({ code, name: `Walker ${code}` }));
  const byId = new Map(props.map((p) => [p.id, p]));
  const byCode = new Map(props.map((p) => [p.code, p]));
  seedProperties(srv, props);

  // ---- The invariant --------------------------------------------------------
  let assigned = false;
  async function invariant(step) {
    const plan = await getPlan(srv);
    const bookings = srv.data("bookings") || [];
    const wos = srv.data("work-orders") || [];
    for (const date of WALKED) {
      const day = (plan?.days || []).find((d) => d.date === date);
      const planned = [...(day?.morning || []), ...(day?.afternoon || [])];
      const dropped = day?.dropped || [];
      const today = await todayRows(srv, date);
      // bookings on this day
      for (const b of bookings.filter((x) => x.propertyId && localDay(x.scheduledFor) === date)) {
        const live = holdsItsSlot(srv, b.status);
        const stop = planned.find((s) => s.code === byId.get(b.propertyId)?.code);
        const drivenStop = Boolean(stop && stop.bookingState !== "done");
        ok(`${step} · ${date} · ${b.id} (${b.status}): plan drives it ⇔ live`, drivenStop === live, j({ stopState: stop?.bookingState ?? null, live }));
        const row = today.rows.find((r) => r.propertyId === b.propertyId || r.bookingId === b.id);
        ok(`${step} · ${date} · ${b.id} (${b.status}): Today lists it ⇔ live`, Boolean(row) === live, j({ row: row ? { source: row.source, stage: row.stage, wo: row.workOrder?.id || null } : null, live }));
      }
      // plan stops after Assign
      if (assigned) {
        for (const s of planned) {
          ok(`${step} · ${date} · stop ${s.code}: has a Booking or a recorded no (never "unassigned")`, s.bookingState !== "unassigned" && (s.bookingId || s.bookingState === "done"), j({ state: s.bookingState, bookingId: s.bookingId || null }));
        }
        for (const g of dropped) {
          ok(`${step} · ${date} · dropped ${g.code}: carries the reason and the Booking it came from`, ["cancelled", "no_show", "moved", "skipped"].includes(g.state) && (g.bookingId || g.state === "skipped"), j(g));
        }
      }
      // dated work orders on this day
      for (const w of wos.filter((x) => x.scheduledFor && localDay(x.scheduledFor) === date && !["cancelled", "no_show"].includes(x.status))) {
        const named = bookings.some((b) => (b.workOrderIds || []).includes(w.id)) || Boolean(w.bookingId);
        ok(`${step} · ${date} · ${w.id}: a dated work order is named by a Booking`, named, j({ propertyId: w.propertyId, status: w.status }));
      }
      // Today == driven day (once Assign has turned intent into appointments;
      // before that the plan is a list of intentions and Today is rightly empty)
      if (assigned) {
        const todayProps = new Set(today.rows.map((r) => r.propertyId).filter(Boolean));
        const planProps = new Set(planned.filter((s) => s.bookingState !== "done").map((s) => byCode.get(s.code)?.id).filter(Boolean));
        ok(`${step} · ${date}: Today's properties equal the driven plan's`, JSON.stringify([...todayProps].sort()) === JSON.stringify([...planProps].sort()), j({ today: [...todayProps].map((id) => byId.get(id)?.code || id), plan: [...planProps].map((id) => byId.get(id)?.code || id) }));
      }
    }
  }

  // ---- 1. Import the plan -----------------------------------------------------
  await seedPlan(srv, { days: {
    [D1]: { label: "R1", morning: ["P-W1", "P-W2"], afternoon: ["P-W3"] },
    [D2]: { label: "R2", morning: ["P-W4"], afternoon: ["P-W5"] },
    [D3]: { label: "R3", morning: ["P-W6"], afternoon: [] }
  } });
  await invariant("1 import");

  // ---- 2. Assign the season -----------------------------------------------------
  const run = await assignSeason(srv);
  ok("2 assign: every planned stop was booked", run.summary?.created === 6, j(run.summary));
  assigned = true;
  const bookingFor = (code) => (srv.data("bookings") || []).find((b) => b.propertyId === byCode.get(code).id && b.source === "assignment") || null;
  for (const code of ["P-W1", "P-W2", "P-W3", "P-W4", "P-W5", "P-W6"]) { const b = bookingFor(code); if (b) await markMessaged(srv, b.id); }
  await invariant("2 assign");

  // ---- 3. Customers answer -------------------------------------------------------
  {
    const t1 = await appointmentToken(srv, bookingFor("P-W1").id);
    const c = await srv.api("POST", `/api/appointment/${t1}/confirm`, {});
    ok("3 answers: W1 confirms from the appointment page", c.status === 200, j(c.body));
    const t2 = await appointmentToken(srv, bookingFor("P-W2").id);
    const w = await srv.api("POST", `/api/appointment/${t2}/time-window`, { notBefore: "10:00", notAfter: null });
    ok("3 answers: W2 asks for after 10:00", w.status === 200, j(w.body));
    const t3 = await appointmentToken(srv, bookingFor("P-W3").id);
    const x = await srv.api("POST", `/api/appointment/${t3}/cancel`, { reasonCode: "another_company" });
    ok("3 answers: W3 cancels from the appointment page", x.status === 200, j(x.body));
    await sleep(400);
    await invariant("3 answers");
  }

  // ---- 4. Patrick edits the plan ----------------------------------------------------
  {
    const mv = await srv.api("PATCH", `${base}/move`, { propertyCode: "P-W4", toDate: D3, toBucket: "afternoon" });
    ok("4 edits: W4 moves to R3", mv.status === 200, j(mv.body?.errors || mv.body?.moved));
    const del = await srv.api("DELETE", `/api/bookings/${bookingFor("P-W5").id}`, {});
    ok("4 edits: W5's booking is deleted from the Schedule page", del.status === 200, j(del.body));
    const patch = await srv.api("PATCH", `/api/bookings/${bookingFor("P-W6").id}`, { status: "cancelled" });
    ok("4 edits: W6 is cancelled with the Status dropdown", patch.status === 200 || patch.status === 405 || patch.status === 422, j(patch.body));
    await sleep(400);
    await invariant("4 edits");
  }

  // ---- 5. The field: open work orders, finish one, desk-cancel one -----------------
  {
    const today1 = await todayRows(srv, D1);
    const opened = [];
    for (const row of today1.rows) {
      if (!row.propertyId) continue;
      const w = await openWoForProperty(srv, row.propertyId);
      if (w.wo) opened.push({ row, wo: w.wo });
    }
    ok("5 field: a work order opened for every row on R1", opened.length === today1.rows.length && opened.length > 0, j({ rows: today1.rows.length, opened: opened.length }));
    await invariant("5 field · opened");
    if (opened[0]) {
      await srv.prepClosing(opened[0].wo.id);
      const done = await srv.api("PATCH", `/api/work-orders/${opened[0].wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
      ok("5 field: the first visit is finished", done.status === 200 && done.body?.workOrder?.status === "completed", j({ status: done.status, errors: done.body?.errors }));
      const b = bookingOnDisk(srv, opened[0].row.bookingId);
      ok("5 field: its Booking is completed", b && b.status === "completed", j({ status: b?.status }));
    }
    if (opened[1]) {
      const c = await srv.qpatch(opened[1].wo.id, { status: "cancelled" });
      ok("5 field: the second visit's work order is cancelled on the desk", c.status === 200, j(c.body?.errors));
      const b = bookingOnDisk(srv, opened[1].row.bookingId);
      ok("5 field: its Booking is reconciled", b && !holdsItsSlot(srv, b.status), j({ status: b?.status }));
    }
    await sleep(500);
    await invariant("5 field · finished");
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 3 });

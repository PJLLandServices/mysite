#!/usr/bin/env node
// scripts/test-ubst-returning-customer.mjs — T2 (P-PJL-39: PJL-73/97 family,
// PJL-136 makes it green)
//
// FAIL-FIRST. A returning customer's fall visit is a NEW Booking; the spring
// Booking is closed when its own work order completes, not months later when
// the customer happens to re-book; and the fall work order says which
// Booking it fulfils.
//
// What already holds (PJL-97/73/93 fixes, kept here as guards): the fall
// re-booking gets its own record, links only the fall work order, Today and
// Open WO pick the fall job, and a season-plan Assign does not book a second
// fall visit for a property whose lead already booked one.
//
// What does not hold yet: nothing completes the spring Booking when April's
// work order completes, so it reads `confirmed` until the fall re-booking
// closes it as a side effect; and the fall work order carries no bookingId.
//
// Expected on origin/main @ 305d7e3: 2 of 18 assertions fail (verified
// 2026-10-06): the spring Booking stays `confirmed` after April's work order
// completes and its cascade runs; the fall work order has no bookingId.
//
// After PJL-133 (Phase 1, the contract): 2 of 18 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-returning-customer.mjs

import {
  bootUbst, reporter, sleep, iso,
  makeProperty, seedProperties, seedPlan, bookingOnDisk, makeLead, seedLeads, healLead,
  openWoForLead, getWo, todayRows, assignSeason, preflightStop
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-returning-customer");
const { ok, j } = R;
const PORT = 4874;
const SPRING_DAY = "2026-04-20", FALL_DAY = "2026-10-20", PLAN_DAY = "2026-10-21";

const srv = await bootUbst({ port: PORT });
try {
  const P = makeProperty({ code: "P-RETURN", name: "Rhea Returning" });
  seedProperties(srv, [P]);
  // The customer's lead, booked in April for a spring opening.
  const lead = makeLead({ propertyId: P.id, name: "Rhea Returning", address: P.address, start: iso(SPRING_DAY, 9, 0),
    serviceKey: "spring_open_4z", serviceLabel: "Spring opening (1-4 zones residential)", durationMinutes: 45, woId: "WO-UBSTSPR1" });
  seedLeads(srv, [lead]);
  const spring = await healLead(srv, lead.id);
  ok("spring: the April envelope has a canonical record", Boolean(spring?.id), j(spring));

  // April's work order, as the store holds a finished spring job today: a
  // completed spring_opening created and finished in April (a spring Finish
  // needs a completion photo the harness cannot take, and a backdated
  // completion refuses a date before the record's creation). The completion
  // cascade then runs through the real route, as Finish would have run it.
  const w = { wo: { id: "WO-UBSTSPR1" } };
  const aprilWo = {
    id: "WO-UBSTSPR1", type: "spring_opening", status: "completed",
    leadId: lead.id, propertyId: P.id, customerName: lead.contact.name, customerEmail: lead.contact.email, customerPhone: lead.contact.phone,
    address: P.address, scheduledFor: iso(SPRING_DAY, 9, 0),
    zones: P.system.zones.map((z) => ({ ...z, status: "ok", issues: [] })),
    techNotes: "Opened, all zones running.", customerNotes: "Opened, all zones running.",
    arrivedAt: iso(SPRING_DAY, 9, 5), departedAt: iso(SPRING_DAY, 9, 50),
    createdAt: iso(SPRING_DAY, 8, 0), updatedAt: iso(SPRING_DAY, 9, 50), completedAt: iso(SPRING_DAY, 9, 50),
    history: [{ ts: iso(SPRING_DAY, 9, 50), action: "status_change", by: "tech", note: "scheduled → completed" }]
  };
  srv.writeData("work-orders", [...(srv.data("work-orders") || []), aprilWo]);
  const seeded = await getWo(srv, "WO-UBSTSPR1");
  ok("spring: April's completed work order is on file under the envelope's id", seeded && seeded.status === "completed", j({ id: seeded?.id, status: seeded?.status }));
  const cascade = await srv.api("POST", `/api/work-orders/${w.wo.id}/run-cascade`, {});
  ok("spring: the completion cascade ran for April's work order", cascade.status === 200, j(cascade.body?.errors || Object.keys(cascade.body || {})));
  await sleep(500);
  const springAfterWo = bookingOnDisk(srv, spring?.id);
  ok("spring: the Booking is completed WHEN its work order completes — not months later when the customer re-books",
    springAfterWo && springAfterWo.status === "completed", j({ status: springAfterWo?.status }));

  // ---- Fall: the customer books again, from the CRM (book-from-lead) --------
  const reserve = await srv.api("POST", "/api/booking/reserve", {
    leadId: lead.id, serviceKey: "fall_close_4z", slotStart: iso(FALL_DAY, 9, 0), source: "admin_custom", zoneCount: 4,
    contact: { name: lead.contact.name, email: lead.contact.email, phone: lead.contact.phone, address: lead.contact.address }
  });
  ok("fall: the admin book-from-lead reserve answers", reserve.status === 200 || reserve.status === 201, j(reserve.body));
  await sleep(400);
  const records = (srv.data("bookings") || []).filter((b) => b.leadId === lead.id);
  const fall = records.find((b) => b.id !== spring?.id && b.serviceKey === "fall_close_4z") || null;
  ok("fall: a NEW Booking id, not April's record moved", Boolean(fall) && fall.id !== spring?.id, j(records.map((b) => ({ id: b.id, status: b.status, service: b.serviceKey, wos: b.workOrderIds }))));
  const springNow = bookingOnDisk(srv, spring?.id);
  ok("fall: April's record keeps its date and its work order", springNow && springNow.scheduledFor === spring.scheduledFor && (springNow.workOrderIds || []).includes("WO-UBSTSPR1"), j({ scheduledFor: springNow?.scheduledFor, wos: springNow?.workOrderIds }));
  ok("fall: April's record is historical (completed), never live beside the fall visit", springNow && springNow.status === "completed", j({ status: springNow?.status }));
  ok("fall: the fall record does not carry April's work order", fall && !(fall.workOrderIds || []).includes("WO-UBSTSPR1"), j(fall?.workOrderIds));
  ok("fall: the fall record holds its slot", fall && fall.status === "confirmed", j({ status: fall?.status }));

  // ---- The field: Today and Open WO pick the fall job ---------------------------
  const today = await todayRows(srv, FALL_DAY);
  const row = today.rows.find((r) => r.leadId === lead.id) || null;
  ok("Today lists the fall visit once", today.rows.filter((r) => r.leadId === lead.id).length === 1, j(today.rows.map((r) => ({ leadId: r.leadId, wo: r.workOrder?.id }))));
  ok("Today does not hand the tech April's completed work order (PJL-73, kept)", row && (!row.workOrder || row.workOrder.id !== "WO-UBSTSPR1"), j(row?.workOrder ?? null));
  const opened = await srv.api("POST", `/api/leads/${lead.id}/open-wo`, {});
  const fallWoId = opened.body?.workOrder?.id || null;
  ok("Open WO creates the fall work order, not April's", opened.status === 200 && fallWoId && fallWoId !== "WO-UBSTSPR1", j({ id: fallWoId, created: opened.body?.created }));
  const fallWo = fallWoId ? await getWo(srv, fallWoId) : null;
  ok("the fall work order names the fall Booking (wo.bookingId)", fallWo && fall && fallWo.bookingId === fall.id, j({ bookingId: fallWo?.bookingId ?? "(no such field)", fall: fall?.id }));
  const fallNow = fall ? bookingOnDisk(srv, fall.id) : null;
  ok("the fall Booking links only the fall work order", fallNow && (fallNow.workOrderIds || []).includes(fallWoId) && !(fallNow.workOrderIds || []).includes("WO-UBSTSPR1"), j(fallNow?.workOrderIds));

  // ---- The plan: Assign does not make a second fall appointment ------------------
  await seedPlan(srv, { days: { [PLAN_DAY]: { label: "R", morning: ["P-RETURN"], afternoon: [] } } });
  const pf = await preflightStop(srv, { code: "P-RETURN" });
  ok("preflight reads the property as settled (already booked this season)", pf && pf.outcome !== "ready", j(pf));
  const run = await assignSeason(srv);
  const created = run.stops.filter((s) => s.outcome === "created");
  ok("a season-wide Assign creates no second fall visit for a customer who already booked", created.length === 0, j(created));
  const fallRecords = (srv.data("bookings") || []).filter((b) => b.propertyId === P.id && String(b.serviceKey || "").startsWith("fall_close") && b.status === "confirmed");
  ok("exactly one live fall Booking exists for the property", fallRecords.length === 1, j(fallRecords.map((b) => ({ id: b.id, source: b.source }))));
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 2 });

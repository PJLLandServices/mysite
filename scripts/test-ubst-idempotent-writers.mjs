#!/usr/bin/env node
// scripts/test-ubst-idempotent-writers.mjs — T6 (P-PJL-39: PJL-133/135)
//
// FAIL-FIRST. Every booking writer has a defined idempotency rule, a read is
// never a write, a status change is a lifecycle operation, and two writes at
// once never lose each other.
//
//   A. GETs that write: asking for a lead's bookings, the portal's
//      booking-actions preflight and its reschedule availability all heal
//      the envelope into a canonical record today (§3.4.2). A read changes
//      nothing on disk.
//   B. PATCH /api/bookings/:id cannot set a lifecycle status (completed with
//      no cascade, or a revival).
//   C. Reserve's retry receipt is sent by EVERY caller, not only the PJL
//      Assistant (static), and a replayed admin reserve returns the same
//      booking (runtime, kept).
//   D. A follow-up booking is idempotent on (parent, slot): the same request
//      twice does not make two appointments.
//   E. Six concurrent writes to six different bookings all land (the store
//      has no lock today; concurrent writers can lose each other).
//
// Expected on origin/main @ 305d7e3: 12 of 18 assertions fail (verified
// 2026-10-06): three GETs write; PATCH completes and re-dates; no caller but
// the Assistant sends a request id; the follow-up record is a hand-built
// shape; and six concurrent writes to six bookings left ONE on disk.
//
// Run: node scripts/test-ubst-idempotent-writers.mjs

import fs from "node:fs";
import path from "node:path";
import {
  ROOT, bootUbst, reporter, sleep, iso,
  makeProperty, seedProperties, seedPlan, bookNow, bookingOnDisk,
  makeLead, seedLeads, portalTokenFor, openWoForLead
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-idempotent-writers");
const { ok, j } = R;
const PORT = 4876;
const snapshot = (srv) => JSON.stringify(srv.data("bookings") || []);

const srv = await bootUbst({ port: PORT });
try {
  // ---- A. a read is never a write ---------------------------------------------
  {
    const lead = makeLead({ name: "Reader Rhonda", start: iso("2026-10-20", 9, 0) });
    seedLeads(srv, [lead]);
    const before = snapshot(srv);
    await srv.api("GET", `/api/bookings?leadId=${lead.id}`);
    ok("[A] GET /api/bookings?leadId changes nothing on disk", snapshot(srv) === before, `bookings.json grew from ${JSON.parse(before).length} to ${(srv.data("bookings") || []).length} records on a read`);

    const lead2 = makeLead({ name: "Reader Ravi", start: iso("2026-10-21", 9, 0) });
    seedLeads(srv, [lead2]);
    const token = await portalTokenFor(lead2.id);
    const before2 = snapshot(srv);
    await srv.api("GET", `/api/portal/${token}/booking-actions`);
    ok("[A] GET portal booking-actions changes nothing on disk", snapshot(srv) === before2, "the preflight healed the envelope into a new record");
    const lead3 = makeLead({ name: "Reader Rita", start: iso("2026-10-22", 9, 0) });
    seedLeads(srv, [lead3]);
    const token3 = await portalTokenFor(lead3.id);
    const before3 = snapshot(srv);
    await srv.api("GET", `/api/portal/${token3}/reschedule-availability?from=2026-10-22&to=2026-10-29`);
    ok("[A] GET portal reschedule-availability changes nothing on disk", snapshot(srv) === before3, "the availability read healed the envelope into a new record");
  }

  // ---- B. PATCH is not a lifecycle door ---------------------------------------
  {
    const P = makeProperty({ code: "P-IDEMB", name: "Idem B" });
    seedProperties(srv, [P]);
    await seedPlan(srv, { days: { "2026-10-23": { label: "B", morning: ["P-IDEMB"], afternoon: [] } } });
    const b = await bookNow(srv, { code: "P-IDEMB", date: "2026-10-23" });
    ok("[B] fixture booking created", b.outcome === "created", j(b.body));
    const r = await srv.api("PATCH", `/api/bookings/${b.bookingId}`, { status: "completed" });
    const now = bookingOnDisk(srv, b.bookingId);
    ok("[B] PATCH cannot mark a booking completed (that is completeBooking's job, and it fires the cascade)",
      r.status !== 200 || now?.status !== "completed", j({ status: r.status, now: now?.status, serviceRecords: ((srv.data("properties") || []).find((p) => p.id === P.id)?.serviceRecords || []).length }));
    const r2 = await srv.api("PATCH", `/api/bookings/${b.bookingId}`, { scheduledFor: iso("2026-10-30", 9, 0) });
    const now2 = bookingOnDisk(srv, b.bookingId);
    ok("[B] PATCH cannot move a booking's date (that is rescheduleBooking's job)",
      r2.status !== 200 || now2?.scheduledFor === now?.scheduledFor, j({ status: r2.status, scheduledFor: now2?.scheduledFor }));
  }

  // ---- C. retry safety for every reserve caller ----------------------------------
  {
    const callers = ["js/booking.js", "server/schedule.js", "server/admin.js", "pjl-field/src/api.js", "server/season-plan.js"];
    for (const f of callers) {
      const src = (() => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return ""; } })();
      const reserves = /\/api\/booking\/reserve/.test(src);
      if (!reserves) continue;
      ok(`[C] ${f} sends a clientRequestId with its reserve (retry-safe like the Assistant)`, /clientRequestId/.test(src), "no clientRequestId: a lost reply and a retry is a double booking");
    }
    // runtime: the receipt works when it IS sent
    const lead = makeLead({ name: "Retry Rex", start: null, booking: false });
    seedLeads(srv, [lead]);
    const body = { leadId: lead.id, serviceKey: "fall_close_4z", slotStart: iso("2026-10-26", 9, 0), source: "admin_custom", zoneCount: 4, clientRequestId: "ubst-retry-0001",
      contact: { name: lead.contact.name, email: lead.contact.email, phone: lead.contact.phone, address: lead.contact.address } };
    const first = await srv.api("POST", "/api/booking/reserve", body);
    const second = await srv.api("POST", "/api/booking/reserve", body);
    const mine = (srv.data("bookings") || []).filter((b) => b.leadId === lead.id);
    ok("[C] the same admin reserve replayed returns the original and makes one booking (kept)", first.status === second.status && second.body?.replayed === true && mine.length === 1, j({ first: first.status, second: second.status, replayed: second.body?.replayed, records: mine.length, errors: first.body?.errors }));
  }

  // ---- D. a follow-up twice is one appointment ------------------------------------
  {
    const PF = makeProperty({ code: "P-IDEMF", name: "Follow Fiona" });
    seedProperties(srv, [PF]);
    const lead = makeLead({ propertyId: PF.id, name: "Follow Fiona", address: PF.address, start: iso("2026-10-27", 9, 0), woId: "WO-UBSTFU01" });
    seedLeads(srv, [lead]);
    await srv.api("GET", `/api/bookings?leadId=${lead.id}`);
    const w = await openWoForLead(srv, lead.id);
    ok("[D] the parent work order exists", Boolean(w.wo?.id), j(w.body));
    const req = { serviceKey: "sprinkler_repair", slotStart: iso("2026-10-28", 13, 0), source: "admin_custom", notes: "return with the part", clientRequestId: "ubst-followup-0001" };
    const a = await srv.api("POST", `/api/work-orders/${w.wo.id}/followup`, req);
    const b = await srv.api("POST", `/api/work-orders/${w.wo.id}/followup`, req);
    const followups = (srv.data("bookings") || []).filter((x) => x.leadId === lead.id && (x.history || []).some((h) => h.action === "created_followup"));
    ok("[D] the follow-up route answers", a.status === 200 || a.status === 201, j(a.body?.errors || a.body));
    ok("[D] the same follow-up request twice makes ONE follow-up appointment", followups.length <= 1, j({ status: [a.status, b.status], followups: followups.map((x) => ({ id: x.id, start: x.scheduledFor, wos: x.workOrderIds })) }));
    for (const f of followups) {
      ok(`[D] the follow-up record ${f.id} is a full record (customerId, rescheduleCount), written by the library`, f.rescheduleCount !== undefined && Object.prototype.hasOwnProperty.call(f, "customerId"), j({ customerId: f.customerId, rescheduleCount: f.rescheduleCount }));
    }
  }

  // ---- E. concurrent writes do not lose each other ----------------------------------
  {
    const props = Array.from({ length: 6 }, (_, i) => makeProperty({ code: `P-CONC${i}`, name: `Conc ${i}` }));
    seedProperties(srv, props);
    await seedPlan(srv, { days: { "2026-11-04": { label: "E", morning: props.slice(0, 3).map((p) => p.code), afternoon: props.slice(3).map((p) => p.code) } } });
    const ids = [];
    for (const p of props) { const r = await bookNow(srv, { code: p.code, date: "2026-11-04" }); if (r.bookingId) ids.push(r.bookingId); }
    ok("[E] six bookings exist", ids.length === 6, j(ids));
    await Promise.all(ids.map((id, i) => srv.api("PATCH", `/api/bookings/${id}`, { prepNotes: `note ${i}` })));
    await sleep(300);
    const landed = ids.filter((id, i) => bookingOnDisk(srv, id)?.prepNotes === `note ${i}`);
    ok("[E] six concurrent writes all land (no lost update)", landed.length === ids.length, `${landed.length} of ${ids.length} notes survived`);
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 12 });

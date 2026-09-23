#!/usr/bin/env node
// scripts/test-rebook-fresh-record.mjs
//
// A returning customer's fall booking gets its OWN booking record, and a
// booking that still names April's work order never reopens it (PJL-97,
// writer side).
//
// Nothing closes a booking record when its work order completes, so April's
// record stays `confirmed`. bookings.upsertFromLead reused any live record,
// so the fall re-booking moved April's record to October and appended the
// fall WO id, which is the merged record test-merged-booking-readers.mjs
// cleans up after. Now a NEW booking (a work-order id the record has never
// seen, and a different start) gets a fresh record, and a live record whose
// linked work orders are ALL finished is closed as completed — its history
// is April's audit trail. Since 2026-09-23 (Patrick) a live record with
// work still open is not reused either: it is left as it was and flagged
// for the office (test-visit-identity.mjs has the rule in full). A
// reschedule of the same booking is reused exactly as before.
//
// Second, workOrderForLeadBooking step 1: the booking envelope's own WO id
// used to win even when that WO finished before the booking's day (an old
// April booking rescheduled to October keeps April's envelope), so the
// fall card read "View WO" on April's job and Open WO returned it. That
// match is now skipped, and Open WO creates the fall WO under a fresh id
// (create() never reuses a taken id).
//
// Run: node scripts/test-rebook-fresh-record.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const at = (ymd, hh, mm = 0) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
};
const APRIL = at("2026-04-20", 9);
const FALL_DAY = "2026-10-06";

// ---- 1. workOrderForLeadBooking, step 1 ----------------------------------
{
  const { workOrderForLeadBooking: pick } = require("../server/lib/work-orders.js");
  const april = { id: "WO-APRIL26", leadId: "L", type: "spring_opening", status: "completed",
    createdAt: at("2026-04-01", 12), updatedAt: at("2026-04-20", 11), completedAt: at("2026-04-20", 11), scheduledFor: APRIL };
  const staleLead = { id: "L", booking: { start: at(FALL_DAY, 10), serviceKey: "spring_open_4z",
    workOrder: { id: "WO-APRIL26", createdAt: at("2026-04-01", 12) } } };
  ok("an envelope still naming April's FINISHED WO no longer reopens it for an October booking",
    pick(staleLead, [april]) === null, String(pick(staleLead, [april])?.id));
  const today = { ...april, id: "WO-FALL26", type: "fall_closing", completedAt: at(FALL_DAY, 9, 15), updatedAt: at(FALL_DAY, 9, 15), createdAt: at("2026-09-01", 12) };
  const fallLead = { id: "L", booking: { start: at(FALL_DAY, 10), serviceKey: "fall_close_4z", workOrder: { id: "WO-FALL26", createdAt: at("2026-08-30", 12) } } };
  ok("the envelope's own WO finished on the booking's day (even early) still wins",
    pick(fallLead, [april, today])?.id === "WO-FALL26");
  const doneAhead = { ...today, scheduledFor: at(FALL_DAY, 10), completedAt: at("2026-09-23", 14), updatedAt: at("2026-09-23", 14) };
  ok("…and so does one scheduled for the booking's day but finished days AHEAD of it",
    pick(fallLead, [april, doneAhead])?.id === "WO-FALL26");
  const bookings = require("../server/lib/bookings.js");
  ok("the booking-record readers ask the same test (bookings.isPreviousVisitWo)",
    typeof bookings.isPreviousVisitWo === "function"
      && bookings.isPreviousVisitWo(april, at(FALL_DAY, 10)) === true
      && bookings.isPreviousVisitWo(doneAhead, at(FALL_DAY, 10)) === false);
  const noStart = { id: "L", booking: { workOrder: { id: "WO-APRIL26" } } };
  ok("with no booked date there is nothing to judge by: the exact match still wins (unchanged)",
    pick(noStart, [april])?.id === "WO-APRIL26");
}

// ---- 2. The real server ----------------------------------------------------
const LEAD = "lead-rebook-returning";
const srv = await bootServer({ port: 20000 + Math.floor(Math.random() * 20000) });
try {
  ok("a throwaway admin can log in", (await srv.login()) === 200);
  const bookingsLib = srv.lib("bookings.js");
  const aprilLead = () => ({
    id: LEAD, createdAt: "2026-03-01T12:00:00Z", status: "won",
    contact: { name: "Rebook Returning", email: "rebook@example.invalid", address: "100 Davis Dr, Newmarket, ON L3Y 2N1" },
    booking: {
      start: APRIL, end: at("2026-04-20", 9, 45), durationMinutes: 45, serviceKey: "spring_open_4z",
      serviceLabel: "Spring opening (1-4 zones residential)", coords: { lat: 44.05, lng: -79.46 },
      workOrder: { id: "WO-APRIL26", status: "scheduled", createdAt: at("2026-04-01", 12) }
    }
  });
  const aprilWo = (o = {}) => ({ id: "WO-APRIL26", leadId: LEAD, type: "spring_opening", status: "completed",
    scheduledFor: APRIL, arrivedAt: at("2026-04-20", 9, 5), completedAt: at("2026-04-20", 11),
    createdAt: at("2026-04-01", 12), updatedAt: at("2026-04-20", 11), zones: [], ...o });
  async function seedApril({ woStatus = "completed" } = {}) {
    srv.writeData("leads", [aprilLead()]);
    srv.writeData("bookings", []);
    srv.writeData("work-orders", [aprilWo(woStatus === "completed" ? {} : { status: woStatus, completedAt: null })]);
    await bookingsLib.upsertFromLead(aprilLead());   // the April record, as the spring booking left it
  }
  const rebook = () => srv.api("POST", "/api/booking/reserve", {
    leadId: LEAD, serviceKey: "fall_close_4z", slotStart: at(FALL_DAY, 10),
    source: "admin_custom", zoneCount: 4, contact: { address: "100 Davis Dr, Newmarket, ON L3Y 2N1" }
  });

  // 2a. The fall re-booking of a finished spring customer
  await seedApril();
  {
    const r = await rebook();
    ok("the fall re-booking goes through", r.status === 201 || r.body.ok === true, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const recs = srv.data("bookings");
    const aprilRec = recs.find((b) => (b.workOrderIds || []).includes("WO-APRIL26"));
    // The day's times are re-cut in driving order after a booking lands,
    // so the fall record is found by its DAY, not the minute asked for.
    const fallRec = recs.find((b) => b !== aprilRec && new Date(b.scheduledFor).toLocaleDateString("en-CA") === FALL_DAY);
    ok("the fall booking gets its OWN record", recs.length === 2 && fallRec && aprilRec && fallRec.id !== aprilRec.id,
      JSON.stringify(recs.map((b) => [b.id, b.status, b.scheduledFor, b.workOrderIds])));
    ok("…April's record keeps its April date and only April's WO",
      aprilRec?.scheduledFor === APRIL && JSON.stringify(aprilRec?.workOrderIds) === '["WO-APRIL26"]',
      JSON.stringify(aprilRec && [aprilRec.scheduledFor, aprilRec.workOrderIds]));
    ok("…and is closed as completed, with a history entry saying why",
      aprilRec?.status === "completed" && (aprilRec?.history || []).some((h) => h.action === "closed_by_rebook"),
      `${aprilRec?.status} ${JSON.stringify((aprilRec?.history || []).map((h) => h.action))}`);
    ok("…the fall record is confirmed and links only the fall envelope",
      fallRec?.status === "confirmed" && (fallRec?.workOrderIds || []).length === 1 && !fallRec.workOrderIds.includes("WO-APRIL26"),
      JSON.stringify(fallRec && [fallRec.status, fallRec.workOrderIds]));
    const mv = fallRec ? await srv.api("PATCH", `/api/bookings/${fallRec.id}/reschedule`, { slotStart: at("2026-10-08", 10), source: "admin_custom" }) : { status: 0, body: {} };
    ok("…and Patrick can move it", mv.status === 200, `${mv.status} ${JSON.stringify(mv.body).slice(0, 160)}`);
    const aprilWoAfter = srv.data("work-orders").find((w) => w.id === "WO-APRIL26");
    ok("…without touching April's WO", aprilWoAfter?.scheduledFor === APRIL && aprilWoAfter?.status === "completed");
  }

  // 2b. Controls: what must NOT change
  await seedApril({ woStatus: "on_site" });
  {
    const r = await rebook();
    const recs = srv.data("bookings");
    // Patrick, 2026-09-23: open work on the old visit no longer pulls the new
    // booking into it. The fall booking is its own visit; April's record is
    // left exactly as it was and flagged for the office
    // (test-visit-identity.mjs covers the rule in full).
    const aprilRec = recs.find((b) => (b.workOrderIds || []).includes("WO-APRIL26"));
    const fallRec = recs.find((b) => b !== aprilRec);
    ok("a live record with work still OPEN is left alone: the fall booking is its own visit",
      (r.status === 201 || r.body.ok === true) && recs.length === 2 && aprilRec?.scheduledFor === APRIL
        && aprilRec?.status === "confirmed" && fallRec?.officeReview?.previousBookingId === aprilRec?.id,
      `${r.status} ${JSON.stringify(recs.map((b) => [b.status, b.scheduledFor, b.workOrderIds, b.officeReview?.reason]))}`);
  }
  await seedApril({ woStatus: "scheduled" });
  {
    // A reschedule keeps the envelope. The WO is not finished: a FINISHED
    // visit can't be moved, and a booking naming one on another day is a
    // stale envelope, i.e. a new visit (test-visit-identity.mjs, case 6).
    const lead = aprilLead();
    lead.booking.start = at("2026-04-21", 9);
    const rec = await bookingsLib.upsertFromLead(lead, {
      isFinishedWo: async () => false
    });
    ok("control: a reschedule of the SAME booking (same envelope) reuses its record",
      srv.data("bookings").length === 1 && rec?.scheduledFor === lead.booking.start, `${srv.data("bookings").length}`);
  }

  // 2c. Open WO on a booking whose envelope still names April's WO
  await seedApril();
  {
    const leads = srv.data("leads");
    leads[0].booking.start = at(FALL_DAY, 10);           // April's booking moved to October, envelope kept
    leads[0].booking.end = at(FALL_DAY, 10, 45);
    srv.writeData("leads", leads);
    const r = await srv.api("POST", `/api/leads/${LEAD}/open-wo`, {});
    ok("Open WO on a stale envelope creates a new WO instead of reopening April's",
      r.status === 200 && r.body.created === true && r.body.workOrder?.id && r.body.workOrder.id !== "WO-APRIL26",
      `${r.status} created=${r.body.created} id=${r.body.workOrder?.id}`);
    const again = await srv.api("POST", `/api/leads/${LEAD}/open-wo`, {});
    ok("…tapped again, it returns that same new WO",
      again.body.created === false && again.body.workOrder?.id === r.body.workOrder?.id, `${again.body.workOrder?.id}`);
    ok("…and April's id is never written twice",
      srv.data("work-orders").filter((w) => w.id === "WO-APRIL26").length === 1);
    const day = await srv.api("GET", `/api/schedule/today?date=${FALL_DAY}`);
    const row = (day.body.bookings || []).find((b) => b.leadId === LEAD);
    ok("Today's card names the new WO, not April's", row?.workOrder?.id === r.body.workOrder?.id, JSON.stringify(row?.workOrder));
  }
} finally {
  await srv.stop();
}

if (failures.length) {
  console.error(`\n✗ test-rebook-fresh-record: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-rebook-fresh-record: ${passed} assertions passed`);

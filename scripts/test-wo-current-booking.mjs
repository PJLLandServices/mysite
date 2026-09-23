#!/usr/bin/env node
// scripts/test-wo-current-booking.mjs
//
// A returning customer's Today card opens THIS visit's work order
// (fall-closing fix #2).
//
// Nearly every fall stop is a spring customer: one lead, April's opening
// completed on it, and September's closing re-booked onto the same lead
// with a fresh envelope id. Today built `new Map(wos.map(w => [w.leadId, w]))`
// (one WO per lead, whichever came last) and Open WO returned any WO on the
// lead — so the fall stop read "Completed / View WO" for the spring job and
// the closing could not be started from Today.
//
// Asserted against a booted server (temp data, outbound stubbed):
//   1. Today does not show the spring WO on the fall booking's row.
//   2. Open WO CREATES the fall WO, under the booking's envelope id, as a
//      fall closing — and does not reuse the completed spring WO.
//   3. Today then shows the fall WO; Open WO again returns it (no duplicate).
//   4. Once the fall WO is completed, Today shows IT as completed (the
//      finished-today case still works).
// Plus the rule itself (workOrderForLeadBooking) on the edge cases.
//
// Run: node scripts/test-wo-current-booking.mjs   (also in build:check)

import { createRequire } from "node:module";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- the rule, pure ---------------------------------------------------
{
  const { workOrderForLeadBooking: pick } = require("../server/lib/work-orders.js");
  ok(typeof pick === "function", "workOrderForLeadBooking is exported");
  if (typeof pick === "function") {
    const lead = { id: "L1", booking: { workOrder: { id: "WO-FALL", createdAt: "2026-09-01T00:00:00Z" } } };
    const spring = { id: "WO-SPRING", leadId: "L1", status: "completed", createdAt: "2026-04-10T00:00:00Z", updatedAt: "2026-04-10T00:00:00Z" };
    ok(pick(lead, [spring]) === null, "a completed WO from an earlier booking is never reused");
    const fall = { id: "WO-FALL", leadId: "L1", status: "completed", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" };
    ok(pick(lead, [fall, spring])?.id === "WO-FALL", "the envelope's own WO wins, even completed");
    const moved = { id: "WO-OTHER", leadId: "L1", status: "on_site", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" };
    ok(pick(lead, [spring, moved])?.id === "WO-OTHER", "an in-progress WO on the lead is still this job");
    const deleted = { ...fall, deletedAt: "2026-10-06T01:00:00Z" };
    ok(pick(lead, [deleted, spring]) === null, "a deleted WO never counts");
    const legacy = { id: "L2", booking: {} };
    ok(pick(legacy, [{ ...spring, leadId: "L2" }])?.id === "WO-SPRING", "a legacy booking with no envelope keeps the old answer");
    ok(pick(lead, [{ ...spring, leadId: "OTHER" }]) === null, "another lead's WO never counts");
  }
}

// ---- the real routes ----------------------------------------------------
const srv = await bootServer({ port: 4863 });
try {
  await srv.login();
  const DAY = "2026-10-06";
  const ENVELOPE = "WO-FALLRB22";
  const lead = {
    id: "lead-returning-customer",
    createdAt: "2026-03-20T12:00:00Z",
    status: "won",
    contact: { name: "Returning Customer", email: "back@example.com", phone: "9055550111", address: "851 Hilton Blvd, Newmarket, ON" },
    booking: {
      start: `${DAY}T14:00:00.000Z`, end: `${DAY}T14:45:00.000Z`,
      serviceKey: "fall_close_4z", serviceLabel: "Fall winterization (1-4 zones residential)",
      zoneCount: 4,
      workOrder: { id: ENVELOPE, status: "scheduled", createdAt: "2026-09-15T12:00:00.000Z" }
    }
  };
  srv.writeData("leads", [lead]);
  const spring = {
    id: "WO-SPRNG234", leadId: lead.id, type: "spring_opening", status: "completed",
    customerName: "Returning Customer", address: lead.contact.address,
    zones: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }],
    createdAt: "2026-04-10T13:00:00.000Z", updatedAt: "2026-04-10T15:00:00.000Z",
    completedAt: "2026-04-10T15:00:00.000Z", history: []
  };
  srv.writeData("work-orders", [spring]);

  const today = async () => {
    const r = await srv.api("GET", `/api/schedule/today?date=${DAY}`);
    return (r.body.bookings || []).find((b) => b.leadId === lead.id) || null;
  };

  let row = await today();
  ok(Boolean(row), "the fall booking is on Today");
  ok(row?.workOrder?.id !== spring.id, `Today does not show last season's WO on the fall stop (got ${row?.workOrder?.id})`);
  ok(row?.workOrder === null, "…the row reads as not started yet");

  const o1 = await srv.api("POST", `/api/leads/${lead.id}/open-wo`, {});
  ok(o1.status === 200 && o1.body.created === true, `Open WO creates a new WO (status ${o1.status}, created ${o1.body.created})`);
  ok(o1.body.workOrder?.id === ENVELOPE, `…under the booking's envelope id (got ${o1.body.workOrder?.id})`);
  ok(o1.body.workOrder?.type === "fall_closing", `…as a fall closing (got ${o1.body.workOrder?.type})`);
  ok(o1.body.workOrder?.status !== "completed", "…that is not completed");

  row = await today();
  ok(row?.workOrder?.id === ENVELOPE, `Today now shows the fall WO (got ${row?.workOrder?.id})`);
  const o2 = await srv.api("POST", `/api/leads/${lead.id}/open-wo`, {});
  ok(o2.body.created === false && o2.body.workOrder?.id === ENVELOPE, "Open WO again returns the same fall WO");
  ok(srv.data("work-orders").length === 2, "no duplicate WO was made");

  // Finish the fall job: Today shows the finished fall WO, not spring's.
  const wos = srv.data("work-orders").map((w) => (w.id === ENVELOPE
    ? { ...w, status: "completed", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : w));
  srv.writeData("work-orders", wos);
  row = await today();
  ok(row?.workOrder?.id === ENVELOPE && row?.workOrder?.status === "completed", "a finished fall job shows as its own completed WO");
  ok(srv.outbox().length === 0, "nothing was emailed or texted");
} finally {
  await srv.stop();
}

console.log(`wo-current-booking: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

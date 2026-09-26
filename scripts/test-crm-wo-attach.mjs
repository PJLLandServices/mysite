#!/usr/bin/env node
// scripts/test-crm-wo-attach.mjs
//
// A work order raised for a booking is linked to THAT booking's record and
// nothing else (PJL-93; the remaining half after main's create() stopped
// reusing a taken id).
//
// The CRM's new-work-order form (POST /api/work-orders) used to attach the
// new WO to EVERY booking record the lead had:
//   for (const bk of await bookings.listByLead(lead.id)) attachWorkOrder(bk.id, wo.id)
// so a returning customer's fall WO was written onto last spring's closed
// record too, re-creating the two-season record PJL-97 exists to prevent.
// It now links only bookings.recordForLeadBooking(): the live record
// naming the booking envelope, else the live one at the booking's start,
// else the lead's only live record.
//
// Open WO (POST /api/leads/:id/open-wo) also links a WO created under a
// FRESH id (the envelope's id was already taken) to that same record,
// because the record only knows the envelope id and a reschedule would
// otherwise leave the new WO behind on the old date.
//
// Run: node scripts/test-crm-wo-attach.mjs   (also in build:check)

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
const FALL = at("2026-10-06", 10);
const LEAD = "lead-attach-returning";

// ---- 1. The rule -----------------------------------------------------------
{
  const bookings = require("../server/lib/bookings.js");
  const pick = bookings.recordForLeadBooking;
  ok("bookings.js exports recordForLeadBooking", typeof pick === "function");
  if (typeof pick === "function") {
    const lead = { id: "L", booking: { start: FALL, workOrder: { id: "WO-ENV" } } };
    const april = { id: "BK-A", leadId: "L", status: "completed", scheduledFor: at("2026-04-20", 9), workOrderIds: ["WO-APRIL"] };
    const fall = { id: "BK-F", leadId: "L", status: "confirmed", scheduledFor: FALL, workOrderIds: ["WO-ENV"] };
    ok("the live record naming the envelope is the booking's record", pick([april, fall], lead)?.id === "BK-F");
    ok("…found by start when the envelope isn't on it", pick([april, { ...fall, workOrderIds: [] }], lead)?.id === "BK-F");
    ok("a closed record is never it", pick([april], lead) === null);
    ok("another lead's record is never it", pick([{ ...fall, leadId: "OTHER" }], lead) === null);
    ok("a lead with no booking has no record", pick([fall], { id: "L" }) === null);
  }
}

// ---- 2. The real routes -------------------------------------------------------
const srv = await bootServer({ port: 20000 + Math.floor(Math.random() * 20000) });
try {
  ok("a throwaway admin can log in", (await srv.login()) === 200);
  const seed = ({ takenEnvelope = false } = {}) => {
    srv.writeData("leads", [{
      id: LEAD, createdAt: "2026-03-01T12:00:00Z", status: "won",
      contact: { name: "Attach Returning", email: "attach@example.invalid", address: "100 Main St, Newmarket, ON" },
      booking: {
        start: FALL, end: at("2026-10-06", 10, 45), durationMinutes: 45, serviceKey: "fall_close_4z",
        serviceLabel: "Fall winterization (1-4 zones residential)",
        workOrder: { id: "WO-FALL26", status: "scheduled", createdAt: at("2026-08-30", 12) }
      }
    }]);
    srv.writeData("bookings", [
      { id: "BK-2026-0002", leadId: LEAD, status: "confirmed", scheduledFor: FALL, durationMinutes: 45,
        serviceKey: "fall_close_4z", workOrderIds: ["WO-FALL26"], history: [] },
      { id: "BK-2026-0001", leadId: LEAD, status: "completed", scheduledFor: at("2026-04-20", 9), durationMinutes: 45,
        serviceKey: "spring_open_4z", workOrderIds: ["WO-APRIL26"], history: [] }
    ]);
    const wos = [{ id: "WO-APRIL26", leadId: LEAD, type: "spring_opening", status: "completed",
      scheduledFor: at("2026-04-20", 9), completedAt: at("2026-04-20", 11),
      createdAt: at("2026-04-01", 12), updatedAt: at("2026-04-20", 11), zones: [] }];
    // The envelope's id already held (a WO cancelled in the spring), so
    // create() must mint a fresh one.
    if (takenEnvelope) wos.push({ id: "WO-FALL26", leadId: null, type: "fall_closing", status: "cancelled",
      createdAt: at("2026-04-02", 12), updatedAt: at("2026-04-02", 12), zones: [] });
    srv.writeData("work-orders", wos);
  };
  const rec = (id) => srv.data("bookings").find((b) => b.id === id);

  // 2a. CRM create, envelope free
  seed();
  {
    const r = await srv.api("POST", "/api/work-orders", { type: "fall_closing", leadId: LEAD });
    ok("the CRM creates the fall WO", r.status === 200 && r.body.workOrder?.id, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ok("…last spring's closed record is left exactly as it was",
      JSON.stringify(rec("BK-2026-0001")?.workOrderIds) === '["WO-APRIL26"]', JSON.stringify(rec("BK-2026-0001")?.workOrderIds));
    ok("…the fall record links the new WO", (rec("BK-2026-0002")?.workOrderIds || []).includes(r.body.workOrder?.id),
      JSON.stringify(rec("BK-2026-0002")?.workOrderIds));
  }

  // 2b. CRM create, envelope id taken -> fresh id, still only the fall record
  seed({ takenEnvelope: true });
  {
    const r = await srv.api("POST", "/api/work-orders", { type: "fall_closing", leadId: LEAD });
    const id = r.body.workOrder?.id;
    ok("with the envelope id taken, the CRM create gets a fresh id", id && id !== "WO-FALL26", String(id));
    ok("…linked to the fall record", (rec("BK-2026-0002")?.workOrderIds || []).includes(id), JSON.stringify(rec("BK-2026-0002")?.workOrderIds));
    ok("…and not to last spring's", !(rec("BK-2026-0001")?.workOrderIds || []).includes(id), JSON.stringify(rec("BK-2026-0001")?.workOrderIds));
  }

  // 2c. Open WO, envelope id taken -> the fresh-id WO is linked to the fall record
  seed({ takenEnvelope: true });
  {
    const r = await srv.api("POST", `/api/leads/${LEAD}/open-wo`, {});
    const id = r.body.workOrder?.id;
    ok("Open WO creates the fall WO under a fresh id", r.body.created === true && id && id !== "WO-FALL26",
      `created=${r.body.created} id=${id}`);
    ok("…and links it to the fall booking record, so a reschedule moves it",
      (rec("BK-2026-0002")?.workOrderIds || []).includes(id), JSON.stringify(rec("BK-2026-0002")?.workOrderIds));
    ok("…never to last spring's", !(rec("BK-2026-0001")?.workOrderIds || []).includes(id));
    const mv = await srv.api("PATCH", "/api/bookings/BK-2026-0002/reschedule", { slotStart: at("2026-10-08", 10), source: "admin_custom" });
    const moved = srv.data("work-orders").find((w) => w.id === id);
    ok("…moving the fall booking moves that WO", mv.status === 200 && moved?.scheduledFor === at("2026-10-08", 10),
      `${mv.status} ${moved?.scheduledFor}`);
  }
} finally {
  await srv.stop();
}

if (failures.length) {
  console.error(`\n✗ test-crm-wo-attach: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-crm-wo-attach: ${passed} assertions passed`);

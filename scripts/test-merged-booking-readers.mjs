#!/usr/bin/env node
// scripts/test-merged-booking-readers.mjs
//
// A returning customer's fall booking must act on THIS visit's work order,
// never on April's (PJL-97, reader side).
//
// Nothing marks a booking record completed when its work order completes,
// so April's record stays `confirmed`. When the customer re-books for fall,
// bookings.upsertFromLead reuses that live record: it moves scheduledFor to
// October and APPENDS the new work-order id. The record ends up as
// `confirmed ["WO-APRIL","WO-FALL"]`, and live data already holds records
// like that. Every reader that took "the booking's work orders" to mean
// "this visit's" then acted on April's finished job:
//
//   admin reschedule   409 "Technician has already arrived" (April's
//                      arrivedAt), or re-dated April's completed WO onto the
//                      new day, where it appeared as a ghost ✓ stop
//   portal preflight   multi_wo_booking / wo_locked: no online reschedule
//   portal cancel      "already in progress — please call us"
//   iCal feed          the event linked to workOrderIds[0], April's WO
//   Today (canonical)  allWos.find() could name April's WO
//   route re-time      refused, or re-dated April's WO
//   admin delete       refused: "WO-APRIL is already in progress"
//
// One rule now answers "which of this record's work orders belong to the
// visit it describes": bookings.workOrdersForVisit(rec, wos). A WO that
// FINISHED (completed / cancelled / no_show) before the record's day is a
// previous visit's. Everything else, including today's own finished WO,
// still counts. Each reader above calls it (CLAUDE.md: define the rule
// once).
//
// The rule is executed directly, then the real routes run on a booted
// server (scripts/lib/field-server.mjs: temp copy, outbound stubbed).
//
// Run: node scripts/test-merged-booking-readers.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const MOVED = at("2026-10-08", 10);

const aprilWo = (o = {}) => ({
  id: "WO-APRIL26", type: "spring_opening", status: "completed",
  scheduledFor: at("2026-04-20", 9), arrivedAt: at("2026-04-20", 9, 5), completedAt: at("2026-04-20", 11),
  createdAt: at("2026-04-01", 12), updatedAt: at("2026-04-20", 11), zones: [], ...o
});
const fallWo = (o = {}) => ({
  id: "WO-FALL26", type: "fall_closing", status: "scheduled", scheduledFor: FALL,
  createdAt: at("2026-09-01", 12), updatedAt: at("2026-09-01", 12), zones: [], ...o
});

// ---- 1. The rule ----------------------------------------------------------
{
  const bookings = require(path.join(ROOT, "server", "lib", "bookings.js"));
  const rule = bookings.workOrdersForVisit;
  ok("bookings.js exports workOrdersForVisit", typeof rule === "function");
  const ids = (rec, wos) => (typeof rule === "function" ? rule(rec, wos).map((w) => w.id) : "NO RULE");
  const rec = (o = {}) => ({ id: "BK-1", scheduledFor: FALL, workOrderIds: ["WO-APRIL26", "WO-FALL26"], ...o });

  ok("a merged record's visit is the fall WO only", JSON.stringify(ids(rec(), [aprilWo(), fallWo()])) === '["WO-FALL26"]',
    JSON.stringify(ids(rec(), [aprilWo(), fallWo()])));
  ok("the visit's OWN WO, finished early the same day, still counts",
    JSON.stringify(ids(rec(), [aprilWo(), fallWo({ status: "completed", completedAt: at("2026-10-06", 9, 15) })])) === '["WO-FALL26"]');
  ok("a WO cancelled back in the spring is not this visit's",
    JSON.stringify(ids(rec({ workOrderIds: ["WO-FALL26"] }), [fallWo({ status: "cancelled", updatedAt: at("2026-04-02", 9) })])) === "[]");
  ok("a no_show recorded on the day still counts",
    JSON.stringify(ids(rec({ workOrderIds: ["WO-FALL26"] }), [fallWo({ status: "no_show", updatedAt: at("2026-10-06", 10, 30) })])) === '["WO-FALL26"]');
  ok("two live WOs on one visit (a multi-day repair) are both kept, in record order",
    JSON.stringify(ids(rec({ workOrderIds: ["WO-B", "WO-A"] }), [fallWo({ id: "WO-A" }), fallWo({ id: "WO-B" })])) === '["WO-B","WO-A"]');
  ok("an id with no WO behind it is not invented", JSON.stringify(ids(rec(), [fallWo()])) === '["WO-FALL26"]');
  ok("a WO the record does not link is never pulled in",
    JSON.stringify(ids(rec({ workOrderIds: ["WO-FALL26"] }), [fallWo(), fallWo({ id: "WO-STRAY" })])) === '["WO-FALL26"]');
  ok("a record with no date keeps every linked WO (nothing to judge by)",
    JSON.stringify(ids(rec({ scheduledFor: null }), [aprilWo(), fallWo()])) === '["WO-APRIL26","WO-FALL26"]');
  ok("empty / missing inputs give an empty list", JSON.stringify(ids(null, null)) === "[]" && JSON.stringify(ids(rec(), [])) === "[]");
  const asIds = typeof bookings.workOrderIdsForVisit === "function"
    ? bookings.workOrderIdsForVisit(rec({ workOrderIds: ["WO-APRIL26", "WO-ENVELOPE"] }), [aprilWo()])
    : "NO RULE";
  ok("as ids: a previous visit's WO is dropped, an envelope id with no WO yet is kept",
    JSON.stringify(asIds) === '["WO-ENVELOPE"]', JSON.stringify(asIds));
}

// ---- 2. The real routes, on a merged record ------------------------------
const LEAD = "lead-merged-returning";
const TOKEN = "tok-merged-returning-0123456789abcdef";
function writeMerged(srv, { aprilArrived = true, secondLive = false } = {}) {
  srv.writeData("leads", [{
    id: LEAD, createdAt: "2026-03-01T12:00:00Z", status: "won",
    portal: { token: TOKEN },
    contact: { name: "Merged Returning", email: "merged@example.invalid", address: "100 Main St, Newmarket, ON" },
    booking: {
      start: FALL, end: at("2026-10-06", 10, 45), durationMinutes: 45, serviceKey: "fall_close_4z",
      serviceLabel: "Fall winterization (1-4 zones residential)", coords: { lat: 44.05, lng: -79.46 },
      workOrder: { id: "WO-FALL26", status: "scheduled", createdAt: at("2026-08-30", 12) }
    }
  }]);
  srv.writeData("bookings", [{
    id: "BK-2026-0001", leadId: LEAD, propertyId: null, customerName: "Merged Returning",
    customerEmail: "merged@example.invalid", address: "100 Main St, Newmarket, ON",
    scheduledFor: FALL, durationMinutes: 45, serviceKey: "fall_close_4z",
    serviceLabel: "Fall winterization (1-4 zones residential)", status: "confirmed",
    workOrderIds: secondLive ? ["WO-FALL26", "WO-FALL26B"] : ["WO-APRIL26", "WO-FALL26"],
    history: [], rescheduleCount: 0
  }]);
  const wos = [fallWo({ leadId: LEAD }), aprilWo({ leadId: LEAD, arrivedAt: aprilArrived ? aprilWo().arrivedAt : null })];
  if (secondLive) wos.push(fallWo({ id: "WO-FALL26B", leadId: LEAD, createdAt: at("2026-09-02", 12) }));
  srv.writeData("work-orders", wos);
}

const srv = await bootServer({ port: 20000 + Math.floor(Math.random() * 20000) });
try {
  const loginStatus = await srv.login();
  ok("a throwaway admin can log in", loginStatus === 200, String(loginStatus));
  const wo = (id) => srv.data("work-orders").find((w) => w.id === id);

  // 2a. Admin reschedule — April's WO carries arrivedAt (the normal case)
  writeMerged(srv, { aprilArrived: true });
  {
    const r = await srv.api("PATCH", "/api/bookings/BK-2026-0001/reschedule", { slotStart: MOVED, source: "admin_custom" });
    ok("admin reschedule of a merged fall booking succeeds (April's old arrival doesn't block it)",
      r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ok("…April's completed WO keeps its April date", wo("WO-APRIL26")?.scheduledFor === aprilWo().scheduledFor, wo("WO-APRIL26")?.scheduledFor);
    ok("…and stays completed", wo("WO-APRIL26")?.status === "completed");
    ok("…the fall WO moves with the booking", wo("WO-FALL26")?.scheduledFor === MOVED, wo("WO-FALL26")?.scheduledFor);
  }

  // 2b. Admin reschedule — April has no arrivedAt: used to re-date it
  writeMerged(srv, { aprilArrived: false });
  {
    const r = await srv.api("PATCH", "/api/bookings/BK-2026-0001/reschedule", { slotStart: MOVED, source: "admin_custom" });
    ok("admin reschedule (April without arrivedAt) succeeds", r.status === 200, `${r.status}`);
    ok("…and does NOT re-date April's completed WO onto the fall day",
      wo("WO-APRIL26")?.scheduledFor === aprilWo().scheduledFor, wo("WO-APRIL26")?.scheduledFor);
    const day = await srv.api("GET", "/api/schedule/today?date=2026-10-08");
    const rows = (day.body.bookings || []).map((b) => `${b.source}:${b.workOrder?.id || "-"}`);
    ok("Today on the new day has no ghost ✓ stop for April's job",
      !rows.some((r2) => r2.includes("WO-APRIL26")), rows.join(", "));
    ok("…and does show the fall visit", rows.some((r2) => r2.includes("WO-FALL26")), rows.join(", "));
  }

  // 2c. Portal preflight — the customer's own view of the fall booking
  writeMerged(srv, { aprilArrived: true });
  {
    const r = await srv.api("GET", `/api/portal/${TOKEN}/booking-actions`);
    ok("portal preflight: reschedule is offered", r.body.canReschedule === true,
      `${r.status} ${JSON.stringify(r.body.reasons)}`);
    ok("portal preflight: cancel is offered", r.body.canCancel === true, JSON.stringify(r.body.reasons));
  }

  // 2d. Portal cancel
  writeMerged(srv, { aprilArrived: true });
  {
    const r = await srv.api("POST", `/api/portal/${TOKEN}/cancel`, { reason: "Changed plans", reasonCode: "other" });
    ok("portal cancel of a merged fall booking goes through", r.status === 200 && r.body.ok === true,
      `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    ok("…April's completed WO is untouched by the cancel cascade", wo("WO-APRIL26")?.status === "completed", wo("WO-APRIL26")?.status);
    ok("…the fall WO is cancelled with its booking", wo("WO-FALL26")?.status === "cancelled", wo("WO-FALL26")?.status);
  }

  // 2e. A genuine multi-WO visit is still a phone call for the customer
  writeMerged(srv, { secondLive: true });
  {
    const r = await srv.api("GET", `/api/portal/${TOKEN}/booking-actions`);
    ok("two LIVE WOs on one visit still refuse online reschedule (unchanged)",
      r.body.canReschedule === false && r.body.reasons?.reschedule === "multi_wo_booking", JSON.stringify(r.body.reasons));
  }

  // 2f. iCal feed
  writeMerged(srv, { aprilArrived: true });
  {
    // A fall booking in the feed's window: move the fixture to a few days out.
    const soon = new Date(Date.now() + 3 * 86400000);
    soon.setHours(10, 0, 0, 0);
    const recs = srv.data("bookings");
    recs[0].scheduledFor = soon.toISOString();
    srv.writeData("bookings", recs);
    const gen = await srv.api("POST", "/api/settings/ical-feed/generate", {});
    const feedUrl = gen.body.url || gen.body.feedUrl || "";
    const token = (feedUrl.match(/\/calendar\/([^/]+)\.ics/) || [])[1];
    ok("the iCal feed can be switched on", Boolean(token), `${gen.status} ${JSON.stringify(gen.body).slice(0, 160)}`);
    const ics = token ? await (await fetch(`${srv.BASE}/calendar/${token}.ics`)).text() : "";
    const unfolded = ics.replace(/\r?\n[ \t]/g, "");
    ok("the calendar event for the fall visit links the FALL work order",
      unfolded.includes("/admin/work-order/WO-FALL26"), (unfolded.match(/URL[^\r\n]*/) || [""])[0]);
    ok("…and never April's", !unfolded.includes("WO-APRIL26"));
  }

  // 2g. Admin delete of the merged record is not blocked by April's job
  writeMerged(srv, { aprilArrived: true });
  {
    const r = await srv.api("DELETE", "/api/bookings/BK-2026-0001");
    ok("admin delete isn't refused because of LAST season's completed WO",
      !(r.status === 409 && /WO-APRIL26/.test(JSON.stringify(r.body))), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
} finally {
  await srv.stop();
}

// ---- 3. One rule, every reader ----------------------------------------------
{
  const SERVER = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const ICAL = fs.readFileSync(path.join(ROOT, "server", "lib", "ical-feed.js"), "utf8");
  const slice = (from, to) => { const a = SERVER.indexOf(from); const b = SERVER.indexOf(to, a + 1); return a >= 0 ? SERVER.slice(a, b > a ? b : a + 8000) : ""; };
  const retime = slice("async function retimeCustomerBooking(", "async function syncRoutedTimes(");
  ok("route re-timing asks workOrdersForVisit", /workOrdersForVisit\(/.test(retime));
  ok("…and keeps its arrived guard", /w\.arrivedAt\)\) return false/.test(retime));
  ok("the iCal feed asks the same rule", /bookings\.work(Orders|OrderIds)ForVisit\(/.test(ICAL));
  const calls = (SERVER.match(/bookings\.workOrdersForVisit\(/g) || []).length;
  ok("server.js readers all ask the one rule (reschedule, preflight, cancel, retime, Today, delete)", calls >= 6, `${calls} call sites`);
  ok("Today's canonical pass no longer picks with a bare .find over workOrderIds",
    !/allWos\.find\(\(w\) => b\.workOrderIds\.includes\(w\.id\)\)/.test(SERVER));
}

if (failures.length) {
  console.error(`\n✗ test-merged-booking-readers: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-merged-booking-readers: ${passed} assertions passed`);

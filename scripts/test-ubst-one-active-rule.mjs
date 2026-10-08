#!/usr/bin/env node
// scripts/test-ubst-one-active-rule.mjs — T5 (P-PJL-39: PJL-133/138)
//
// FAIL-FIRST. Every reader answers "is this appointment active?" the same
// way — bookings.holdsItsSlot(status) on the canonical record — and never
// from a second store.
//
// The table: for each Booking status, one assignment booking and one lead
// booking on their own days. Then every reader is asked, and its answer is
// compared with the one rule:
//
//   plan stop in the day     ⇔ holdsItsSlot
//   Today lists a row        ⇔ holdsItsSlot
//   capacity holds the slot  ⇔ holdsItsSlot
//   iCal lists the event     ⇔ holdsItsSlot   (tentative is live; the feed drops it today)
//   job finder: on the day   ⇔ holdsItsSlot   (its own list; the lead verdict has no status test)
//   portal: upcoming         ⇔ holdsItsSlot   (envelopeUpcoming is date-only today)
//
// And the divergent case the PATCH door produces: the canonical record is
// cancelled, the lead envelope still says nothing. Every reader must follow
// the record.
//
// Plus a static check: the readers that still spell the dead set out by
// hand (job-finder, day-schedule, appointment-actions, booking-reminders,
// assignment-cadence, ical-feed) call the shared rule instead.
//
// Expected on origin/main @ 305d7e3: 19 of 71 assertions fail (verified
// 2026-10-06): the iCal feed drops tentative; the portal reads a cancelled,
// completed or no-show lead booking as "service scheduled"; the job finder's
// lead verdict has no status test and counts a completed stop as booked; a
// done stop keeps a route number; the PATCH-cancelled lead booking stays on
// Today and keeps its slot; six readers keep their own dead-status lists.
//
// After PJL-133 (Phase 1, the contract): 15 of 71 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-one-active-rule.mjs

import fs from "node:fs";
import path from "node:path";
import {
  ROOT, bootUbst, reporter, sleep, iso, SEASON, YEAR,
  makeProperty, seedProperties, seedPlan, planStop, bookNow, bookingOnDisk,
  makeLead, seedLeads, healLead, todayRows, slotsOn, icalEventIds, findJobs, portalPayload, holdsItsSlot
} from "./lib/ubst-fixtures.mjs";

const R = reporter("test-ubst-one-active-rule");
const { ok, j } = R;
const PORT = 4875;
const STATUSES = ["confirmed", "tentative", "cancelled", "completed", "no_show"];
// One day per status per kind, all weekdays in the fall window.
// Every day inside fall 2026's public booking window (Sep 28 – Oct 30), so
// the capacity reader has slots to count.
const DAYS = {
  assignment: { confirmed: "2026-10-19", tentative: "2026-10-20", cancelled: "2026-10-21", completed: "2026-10-22", no_show: "2026-10-23" },
  lead: { confirmed: "2026-10-26", tentative: "2026-10-27", cancelled: "2026-10-28", completed: "2026-10-29", no_show: "2026-10-30" },
  divergent: "2026-10-15",
  baseline: "2026-10-16"
};
// One address per fixture: bookings.belongsToProperty matches by address as
// its third rung, so two properties at one address read as one customer.
const BASE_ADDRESS = "600 Base St, Newmarket, ON L3Y 6B6, Canada";

const srv = await bootUbst({ port: PORT });
try {
  const bookingsLib = srv.lib("bookings.js");
  // Set a status the way the doors do today (lib update), falling back to
  // the lifecycle ops once update() refuses status (PJL-133).
  async function setStatus(id, status) {
    if (status === "confirmed") return;
    try { await bookingsLib.update(id, { status }); } catch { /* refused: use the ops */ }
    const now = bookingOnDisk(srv, id);
    if (now?.status === status) return;
    if (status === "cancelled" && bookingsLib.cancel) await bookingsLib.cancel(id, { reason: "table", reasonCode: "customer_cancelled", by: "test" });
    if (status === "no_show" && bookingsLib.cancel) await bookingsLib.cancel(id, { reason: "table", reasonCode: "no_answer", by: "test" });
    if (status === "completed" && (bookingsLib.complete || bookingsLib.completeBooking)) await (bookingsLib.complete || bookingsLib.completeBooking)(id, {});
    if (status === "tentative" && bookingsLib.setTentative) await bookingsLib.setTentative(id);
  }

  // ---- Fixtures ---------------------------------------------------------------
  const props = {};
  const days = {};
  for (const s of STATUSES) {
    props[s] = makeProperty({ code: `P-A${s.toUpperCase().slice(0, 6)}`, name: `Assigned ${s}` });
    days[DAYS.assignment[s]] = { label: s, morning: [props[s].code], afternoon: [] };
  }
  seedProperties(srv, Object.values(props));
  await seedPlan(srv, { days });
  const assigned = {};
  for (const s of STATUSES) {
    const r = await bookNow(srv, { code: props[s].code, date: DAYS.assignment[s] });
    ok(`fixture: assignment booking for ${s} created`, r.outcome === "created" && r.bookingId, j(r.body));
    if (r.bookingId) { await setStatus(r.bookingId, s); assigned[s] = r.bookingId; }
  }
  const leads = {};
  for (const s of STATUSES) {
    // At 08:00, the first morning slot, so a live booking visibly moves the
    // first offered start.
    const lead = makeLead({ name: `Lead ${s}`, start: iso(DAYS.lead[s], 8, 0) });
    seedLeads(srv, [lead]);
    const rec = await healLead(srv, lead.id);
    ok(`fixture: lead booking for ${s} has a canonical record`, Boolean(rec?.id), j(rec));
    if (rec?.id) {
      await setStatus(rec.id, s);
      // The envelope mirrors the status the way the cancel routes do, so this
      // half of the table is about readers, not about the mirror.
      const all = srv.data("leads");
      const l = all.find((x) => x.id === lead.id);
      if (l?.booking && s !== "confirmed") { l.booking.status = s; if (s === "cancelled" || s === "no_show") l.booking.cancelledAt = new Date().toISOString(); }
      srv.writeData("leads", all);
      leads[s] = { lead, bookingId: rec.id };
    }
  }
  const baselineSlots = await slotsOn(srv, { date: DAYS.baseline, address: BASE_ADDRESS });

  // ---- The table --------------------------------------------------------------
  const feed = await icalEventIds(srv);
  for (const s of STATUSES) {
    const live = holdsItsSlot(srv, s);
    // assignment half
    {
      const date = DAYS.assignment[s], id = assigned[s], code = props[s].code;
      const stop = await planStop(srv, { date, code });
      // A completed stop may stay on the day as history (`done`), but it is
      // not driven: no stop number, no place in the route.
      const driven = stop.inDay && stop.state !== "done";
      ok(`[assignment ${s}] plan: stop driven on the day ⇔ live`, driven === live, j({ inDay: stop.inDay, state: stop.state, stopNumber: stop.stopNumber }));
      if (stop.state === "done") ok(`[assignment ${s}] plan: a done stop is history, not a numbered stop on the route`, stop.stopNumber == null, j({ stopNumber: stop.stopNumber }));
      const today = await todayRows(srv, date);
      const rows = today.rows.filter((r) => r.propertyId === props[s].id);
      ok(`[assignment ${s}] Today: row ⇔ live`, (rows.length > 0) === live, j(rows.map((r) => r.stage)));
      // Capacity, the way test-booking-lifecycle reads it: a live booking in
      // the morning moves the first offered morning start; a dead one does
      // not. (Slot COUNTS do not change in bucket mode until a bucket fills.)
      const slots = await slotsOn(srv, { date, address: props[s].address });
      if (slots.ok && baselineSlots.ok) {
        const shifted = JSON.stringify(slots.starts.map((x) => x.slice(11, 16))) !== JSON.stringify(baselineSlots.starts.map((x) => x.slice(11, 16)));
        ok(`[assignment ${s}] capacity: the first offered start moves ⇔ live`, shifted === live, `starts ${j(slots.starts.map((x) => x.slice(11, 16)))} vs empty day ${j(baselineSlots.starts.map((x) => x.slice(11, 16)))}`);
      } else ok(`[assignment ${s}] capacity readable`, false, slots.error || baselineSlots.error);
      if (feed.ok) ok(`[assignment ${s}] iCal: listed ⇔ live`, feed.ids.includes(id) === live, j(feed.ids));
      else ok(`[assignment ${s}] iCal feed readable`, false, feed.error);
      const jobs = await findJobs(srv, { q: props[s].customerName, date });
      const stopRow = (jobs.planStops || []).find((p) => p.code === code && p.date === date);
      // A dropped stop is rightly absent from the driven plan the finder reads.
      ok(`[assignment ${s}] job finder: plan stop "booked" ⇔ live`, stopRow ? stopRow.booked === live : !live, j(stopRow));
    }
    // lead half
    if (leads[s]) {
      const { lead, bookingId } = leads[s];
      const date = DAYS.lead[s];
      const today = await todayRows(srv, date);
      const rows = today.rows.filter((r) => r.leadId === lead.id);
      ok(`[lead ${s}] Today: row ⇔ live`, (rows.length > 0) === live, j(rows.map((r) => r.stage)));
      const slots = await slotsOn(srv, { date, address: lead.contact.address });
      if (slots.ok && baselineSlots.ok) {
        const shifted = JSON.stringify(slots.starts.map((x) => x.slice(11, 16))) !== JSON.stringify(baselineSlots.starts.map((x) => x.slice(11, 16)));
        ok(`[lead ${s}] capacity: the first offered start moves ⇔ live`, shifted === live, `starts ${j(slots.starts.map((x) => x.slice(11, 16)))} vs empty day ${j(baselineSlots.starts.map((x) => x.slice(11, 16)))}`);
      }
      if (feed.ok) ok(`[lead ${s}] iCal: listed ⇔ live`, feed.ids.includes(bookingId) === live, j(feed.ids));
      const portal = await portalPayload(srv, lead.id);
      const upcoming = portal.derived?.upcomingBooking ?? (portal.derived?.state === "service_scheduled");
      ok(`[lead ${s}] portal: upcoming ⇔ live`, portal.status === 200 && Boolean(upcoming) === live, j({ status: portal.status, derived: portal.derived }));
      const jobs = await findJobs(srv, { q: lead.contact.name, date });
      const leadRow = (jobs.leads || []).find((l) => l.id === lead.id);
      ok(`[lead ${s}] job finder: lead verdict says on the day ⇔ live`, leadRow && Boolean(leadRow.onDay) === live, j(leadRow));
    }
  }

  // ---- Divergence: canonical cancelled, envelope silent (the PATCH door) ----------
  {
    const lead = makeLead({ name: "Divergent Dan", start: iso(DAYS.divergent, 8, 0) });
    seedLeads(srv, [lead]);
    const rec = await healLead(srv, lead.id);
    await srv.api("PATCH", `/api/bookings/${rec.id}`, { status: "cancelled" });
    const now = bookingOnDisk(srv, rec.id);
    ok("[divergent] the canonical record is cancelled", now?.status === "cancelled", j(now?.status));
    const today = await todayRows(srv, DAYS.divergent);
    ok("[divergent] Today follows the record, not the envelope", !today.rows.some((r) => r.leadId === lead.id), j(today.rows.map((r) => r.leadId)));
    const slots = await slotsOn(srv, { date: DAYS.divergent, address: lead.contact.address });
    if (slots.ok && baselineSlots.ok) {
      const same = JSON.stringify(slots.starts.map((x) => x.slice(11, 16))) === JSON.stringify(baselineSlots.starts.map((x) => x.slice(11, 16)));
      ok("[divergent] capacity follows the record (the 08:00 start is offered again)", same, `starts ${j(slots.starts.map((x) => x.slice(11, 16)))} vs empty day ${j(baselineSlots.starts.map((x) => x.slice(11, 16)))}`);
    }
    const portal = await portalPayload(srv, lead.id);
    ok("[divergent] the portal follows the record", portal.status === 200 && portal.derived?.state !== "service_scheduled", j(portal.derived));
  }

  // ---- Static: no reader spells the dead set out by hand ----------------------------
  {
    const files = ["server/lib/job-finder.js", "server/lib/day-schedule.js", "server/lib/appointment-actions.js", "server/lib/booking-reminders.js", "server/lib/assignment-cadence.js", "server/lib/ical-feed.js"];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      const handRolled = /\[\s*["'](cancelled|completed|no_show)["']\s*,\s*["'](cancelled|completed|no_show)["']|status\s*!==\s*["']confirmed["']|\.status\s*===\s*["'](completed|no_show)["']/.test(src.replace(/\/\/.*$/gm, ""));
      const usesRule = /holdsItsSlot\(/.test(src);
      ok(`[static] ${f} asks the shared rule and keeps no list of its own`, usesRule && !handRolled, `${usesRule ? "calls holdsItsSlot" : "never calls holdsItsSlot"}${handRolled ? "; spells the dead set out by hand" : ""}`);
    }
  }
} catch (err) {
  ok("suite ran to the end", false, (err && err.stack) ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
} finally {
  await srv.stop();
}

R.finish({ expectedFailing: 15 });

#!/usr/bin/env node
// scripts/test-unplanned-settled.mjs
//
// "A bunch of 'not on the plan' are in the queue. Fortunately some have
// found homes, and some have been completed. Can you take a look at why
// 'not on the plan' isn't being found?" — Patrick, 2026-10-04.
//
// The Season Plan board and the Not-on-the-plan tray answered "does this
// customer already have a visit this season" by two different rules.
// The board (gatherBookedRows) finds a booking through the lead the
// property is linked to and keeps a completed stop on the day as done.
// The tray's reader (outreach.deriveBookingState → assessEligibility →
// assignments.unplanned) found a booking only by its propertyId stamp
// and read a completed visit as "not booked" — so a customer whose lead
// was linked after they booked, and a customer whose closing was already
// done, were both offered a route day again.
//
// Pinned here, against the REAL readers over a sandbox store:
//
//   1. bookings.belongsToProperty — one rule, three rungs: the id stamp,
//      the lead link (property.leadIds), the address.
//   2. outreach.seasonSettled — booked OR completed is settled, and
//      assessEligibility says which (already_booked / already_done).
//   3. assignments.unplanned and preflight read that one verdict
//      (outreach.verdictIsSettled) — neither keeps its own string.
//
// Run: node scripts/test-unplanned-settled.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 240) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

// Sandbox copy of the lib tree: the libs resolve their stores relative
// to their own __dirname, so nothing under the real server/data is read
// or written (same pattern as test-season-config / test-season-plan-unplanned).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-settled-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const outreach = require(path.join(SANDBOX, "server/lib/outreach.js"));
const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));
const seasonPlans = require(path.join(SANDBOX, "server/lib/season-plans.js"));
const propertiesLib = require(path.join(SANDBOX, "server/lib/properties.js"));
// The store's own normaliser, so the fixture is shaped exactly as
// properties.create would shape it (a hand-rolled copy would test itself).
const normalizeAddress = typeof propertiesLib.normalizeAddress === "function"
  ? propertiesLib.normalizeAddress
  : (v) => String(v || "").toLowerCase();

const BOOKINGS = path.join(SANDBOX, "server/data/bookings.json");
const PROPERTIES = path.join(SANDBOX, "server/data/properties.json");

// Toronto-local wall clock, stored the way the booking flow stores it.
const at = (month, day, hour = 9) => new Date(2026, month - 1, day, hour, 0, 0).toISOString();

const property = (id, code, name, address, extra = {}) => ({
  id, code, customerName: name, address,
  addressNormalized: normalizeAddress(address),
  customerEmail: `${id.toLowerCase()}@example.com`,
  leadIds: [],
  system: { zones: [1, 2, 3, 4] },
  ...extra
});
const booking = (id, extra = {}) => ({
  id, propertyId: null, leadId: null, address: "",
  scheduledFor: at(10, 15), serviceKey: "fall_close_4z", serviceLabel: "Fall closing",
  status: "confirmed", customerName: "", durationMinutes: 45, workOrderIds: [], history: [],
  ...extra
});

// Six houses. Who the board already shows as having a visit — and who
// the tray must therefore NOT offer a day:
//
//   P-ID     booking stamped with the property id          (always worked)
//   P-LEAD   booking carries only the lead; the property's
//            leadIds names that lead                        ("found a home" — was listed)
//   P-ADDR   booking carries only the customer's address    ("found a home" — was listed)
//   P-DONE   booking stamped with the id, status completed  ("completed" — was listed)
//   P-NONE   nothing at all                                 (the one real gap)
//   P-REPAIR a sprinkler repair in October is not a closing (stays a gap)
//   P-CANCEL booked themselves, then cancelled              ("cancelled" — was listed)
fs.writeFileSync(PROPERTIES, JSON.stringify([
  property("P-ID", "PR-0001", "Stamped", "10 Stamp St, Newmarket, ON"),
  property("P-LEAD", "PR-0002", "Linked Later", "20 Link Ave, Aurora, ON", { leadIds: ["lead-20"] }),
  property("P-ADDR", "PR-0003", "Same House", "30 House Rd, Newmarket, ON"),
  property("P-DONE", "PR-0004", "Already Done", "40 Done Cres, Aurora, ON"),
  property("P-NONE", "PR-0005", "Still Waiting", "50 Gap Blvd, Newmarket, ON"),
  property("P-REPAIR", "PR-0006", "Had A Repair", "60 Fix Lane, Newmarket, ON"),
  property("P-CANCEL", "PR-0007", "Said No", "70 Nope Way, Aurora, ON")
], null, 2));
fs.writeFileSync(BOOKINGS, JSON.stringify([
  booking("BK-ID", { propertyId: "P-ID" }),
  booking("BK-LEAD", { leadId: "lead-20", address: "20 Link Ave, Aurora, ON" }),
  booking("BK-ADDR", { address: "30 House Rd, Newmarket, ON" }),
  booking("BK-DONE", { propertyId: "P-DONE", status: "completed", scheduledFor: at(10, 1) }),
  booking("BK-REPAIR", { propertyId: "P-REPAIR", serviceKey: "sprinkler_repair", serviceLabel: "Sprinkler repair" }),
  booking("BK-CANCEL", { propertyId: "P-CANCEL", status: "cancelled", cancelledAt: at(10, 2),
    cancellationReason: "", removalCode: "another_company" })
], null, 2));

const props = JSON.parse(fs.readFileSync(PROPERTIES, "utf8"));
const byId = Object.fromEntries(props.map((p) => [p.id, p]));

// ---- 1. One rule for "whose booking is this" -----------------------------
{
  const has = typeof bookings.belongsToProperty === "function";
  ok("bookings.belongsToProperty exists — the rule has a name", has, "missing");
  if (has) {
    const b = (id) => JSON.parse(fs.readFileSync(BOOKINGS, "utf8")).find((x) => x.id === id);
    ok("rung 1: the id stamp", bookings.belongsToProperty(b("BK-ID"), byId["P-ID"]) === true);
    ok("rung 2: the lead the property is linked to", bookings.belongsToProperty(b("BK-LEAD"), byId["P-LEAD"]) === true);
    ok("rung 3: the address", bookings.belongsToProperty(b("BK-ADDR"), byId["P-ADDR"]) === true);
    ok("…and a different house is not matched by any rung",
      bookings.belongsToProperty(b("BK-ID"), byId["P-NONE"]) === false
      && bookings.belongsToProperty(b("BK-LEAD"), byId["P-NONE"]) === false
      && bookings.belongsToProperty(b("BK-ADDR"), byId["P-NONE"]) === false);
    ok("…and garbage is false, not a crash",
      bookings.belongsToProperty(null, byId["P-ID"]) === false && bookings.belongsToProperty(b("BK-ID"), null) === false);
    const list = typeof bookings.listForProperty === "function" ? await bookings.listForProperty(byId["P-LEAD"]) : null;
    ok("listForProperty reads by that rule", Array.isArray(list) && list.length === 1 && list[0].id === "BK-LEAD", j(list));
  }
}

// ---- 2. The season-state reader sees every rung ---------------------------
{
  const state = (id) => outreach.deriveBookingState(id, "fall", 2026);
  ok("stamped → booked", (await state("P-ID")).hasBooking === true, j(await state("P-ID")));
  ok("linked through the lead → booked (this is 'found a home')", (await state("P-LEAD")).hasBooking === true, j(await state("P-LEAD")));
  ok("matched by address → booked (this is 'found a home', unlinked)", (await state("P-ADDR")).hasBooking === true, j(await state("P-ADDR")));
  const done = await state("P-DONE");
  ok("completed → not upcoming, but completed", done.hasBooking === false && done.completed === true && done.bookingId === "BK-DONE", j(done));
  const none = await state("P-NONE");
  ok("nothing → nothing", none.hasBooking === false && none.completed === false, j(none));
  const repair = await state("P-REPAIR");
  ok("an October repair is not a fall closing", repair.hasBooking === false && repair.completed === false, j(repair));
  // 2026-10-06: "They have either cancelled or we aren't serving them
  // anymore." A cancelled booking is still UNBOOKED here (outreach may
  // nudge), but the state now says who declined, and why.
  const cancel = await state("P-CANCEL");
  ok("cancelled → not booked, not completed, but DECLINED is named",
    cancel.hasBooking === false && cancel.completed === false
    && cancel.declined?.bookingId === "BK-CANCEL" && cancel.declined?.reasonCode === "another_company", j(cancel));
  ok("never booked → declined is null", none.declined === null, j(none));
  ok("booked → declined is not reported", (await state("P-ID")).declined == null, j(await state("P-ID")));
  ok("the rule has a name: outreach.declinedThisSeason", typeof outreach.declinedThisSeason === "function", "missing");
  if (typeof outreach.declinedThisSeason === "function") {
    const live = { serviceKey: "fall_close_4z", scheduledFor: at(10, 15), status: "confirmed", id: "L" };
    const dead = { serviceKey: "fall_close_4z", scheduledFor: at(10, 15), status: "cancelled", id: "D", cancelledAt: at(10, 1) };
    ok("…a cancellation beside a live re-booking is not a no", outreach.declinedThisSeason([dead, live], "fall", 2026) === null);
    ok("…a no-show counts as a no too", outreach.declinedThisSeason([{ ...dead, status: "no_show" }], "fall", 2026)?.status === "no_show");
    ok("…last spring's cancellation says nothing about this fall",
      outreach.declinedThisSeason([{ ...dead, serviceKey: "spring_open_4z", scheduledFor: at(4, 20) }], "fall", 2026) === null);
  }
}

// ---- 3. Settled is ONE question, with two honest answers -----------------
{
  ok("outreach.seasonSettled exists", typeof outreach.seasonSettled === "function", "missing");
  if (typeof outreach.seasonSettled === "function") {
    ok("booked is settled", outreach.seasonSettled({ hasBooking: true, completed: false }) === true);
    ok("completed is settled", outreach.seasonSettled({ hasBooking: false, completed: true }) === true);
    ok("neither is not", outreach.seasonSettled({ hasBooking: false, completed: false }) === false
      && outreach.seasonSettled(null) === false);
  }
  const verdict = (id) => outreach.assessEligibility(byId[id], { season: "fall", year: 2026 });
  const lead = await verdict("P-LEAD");
  ok("the gauntlet says already_booked for the lead-linked customer",
    lead.ok === false && lead.reason === "already_booked" && lead.bookingId === "BK-LEAD", j(lead));
  const addr = await verdict("P-ADDR");
  ok("…and for the address-matched one", addr.ok === false && addr.reason === "already_booked", j(addr));
  const done = await verdict("P-DONE");
  ok("…and already_done for the completed one — not 'eligible'",
    done.ok === false && done.reason === "already_done" && done.bookingId === "BK-DONE", j(done));
  const none = await verdict("P-NONE");
  ok("the real gap is still eligible", none.ok === true, j(none));
  ok("outreach may still nudge a customer who cancelled — the gauntlet does not settle them",
    (await verdict("P-CANCEL")).ok === true, j(await verdict("P-CANCEL")));
  ok("verdictIsSettled names both answers and nothing else",
    typeof outreach.verdictIsSettled === "function"
    && outreach.verdictIsSettled(lead) && outreach.verdictIsSettled(done)
    && !outreach.verdictIsSettled(none)
    && !outreach.verdictIsSettled({ ok: false, reason: "season_opt_out" }), "verdictIsSettled is wrong or missing");
}

// ---- 4. The tray, end to end, with the REAL gauntlet ----------------------
{
  await seasonPlans.savePlan("fall", 2026, {
    bucketCap: 5, dayCap: 10,
    days: { "2026-10-15": { label: "R1", morning: [], afternoon: [] } }
  });
  const r = await assignments.unplanned("fall", 2026, {});
  ok("the tray answers", r?.ok === true, j(r));
  const placeable = (r?.placeable || []).map((x) => x.code).sort();
  const blocked = (r?.blocked || []).map((x) => `${x.code}:${x.reason}`).sort();
  ok("ONLY the real gaps are offered a day — the repair customer and the never-booked one",
    placeable.join(",") === "PR-0005,PR-0006", placeable.join(","));
  ok("a customer who found a home through the lead is not in the tray", !placeable.includes("PR-0002"), j(placeable));
  ok("a customer who found a home by address is not in the tray", !placeable.includes("PR-0003"), j(placeable));
  ok("a customer whose closing is done is not in the tray", !placeable.includes("PR-0004"), j(placeable));
  ok("…and none of them is reported as a PROBLEM either — settled is silent",
    !blocked.some((b) => /^PR-000[1-4]:/.test(b)), blocked.join(" "));
  ok("a customer who cancelled is NOT offered a day", !placeable.includes("PR-0007"), j(placeable));
  const cancelRow = (r?.blocked || []).find((x) => x.code === "PR-0007");
  ok("…and is named under can't-be-placed, with why",
    cancelRow?.reason === "cancelled_this_season" && cancelRow?.bookingId === "BK-CANCEL"
    && /another company/i.test(cancelRow?.note || ""), j(cancelRow));

  // The preflight reads the same verdict: the done customer is settled
  // on the board, not skipped with a reason the screen cannot explain.
  const plan = { days: { "2026-10-15": { label: "R1", morning: ["PR-0004", "PR-0002", "PR-0005"], afternoon: [] } } };
  const flight = await assignments.preflight("fall", 2026, { getPlan: async () => plan });
  const rows = new Map((flight.days || []).flatMap((d) => d.stops).map((s) => [s.code, s]));
  ok("preflight: the completed customer is settled", rows.get("PR-0004")?.outcome === "settled", j(rows.get("PR-0004")));
  ok("preflight: the lead-linked customer is settled", rows.get("PR-0002")?.outcome === "settled", j(rows.get("PR-0002")));
  ok("preflight: the real gap is ready", rows.get("PR-0005")?.outcome === "ready", j(rows.get("PR-0005")));
}

// ---- 5. Source guards: one rule, every reader -------------------------------
{
  const outreachSrc = read("server/lib/outreach.js");
  const assignSrc = read("server/lib/assignments.js");
  const bookingsSrc = read("server/lib/bookings.js");
  ok("deriveBookingState reads bookings.listForProperty, not the id-only list",
    /async function deriveBookingState\([\s\S]{0,1500}bookings\.listForProperty\(property\)/.test(outreachSrc), "id-only read is back");
  ok("listForProperty is defined by belongsToProperty",
    /async function listForProperty\([\s\S]{0,300}belongsToProperty\(b, property\)/.test(bookingsSrc), "listForProperty grew its own rule");
  ok("assessEligibility asks seasonSettled, not hasBooking alone",
    /if \(seasonSettled\(state\)\)/.test(outreachSrc), "assessEligibility tests hasBooking by hand");
  ok("preflight asks verdictIsSettled",
    /async function preflight\([\s\S]{0,4000}outreach\.verdictIsSettled\(verdict\)/.test(assignSrc), "preflight has its own string");
  ok("unplanned asks verdictIsSettled",
    /async function unplanned\([\s\S]{0,2500}outreach\.verdictIsSettled\(verdict\)/.test(assignSrc), "unplanned has its own string");
  ok("no reader in assignments.js compares the reason string itself",
    !/reason === "already_booked"/.test(assignSrc), "a reader kept its own copy of the rule");
  const ui = read("server/outreach.js");
  ok("the outreach screen shows a completed customer as Done, not Not booked",
    /bookingState\?\.completed[\s\S]{0,200}Done</.test(ui), "no Done badge");
  ok("unplanned reads the declined rule over the property's OWN records (belongsToProperty)",
    /outreach\.declinedThisSeason\(\s*allBookings\.filter\(\(b\) => bookings\.belongsToProperty\(b, property\)\)/.test(assignSrc),
    "unplanned has its own cancelled test");
  ok("deriveBookingState reports declined through the same rule",
    /declined: declinedThisSeason\(mine, season, year\)/.test(outreachSrc), "deriveBookingState grew its own");
  const plan = read("server/season-plan.js");
  ok("the tray explains a cancellation", /cancelled_this_season: "cancelled this season/.test(plan));
  ok("…with the reason given", /row\.note \? ` <em>\(\$\{escapeHtml\(row\.note\)\}\)<\/em>`/.test(plan));
  ok("a chip has a Skip-this-season button that sets the outreach opt-out flag (two presses)",
    /armTwice\(skip, "Press again to SKIP them"[\s\S]{0,600}\/api\/outreach\/opt-out-season[\s\S]{0,300}optOut: true/.test(plan), "no skip button");
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL test-unplanned-settled: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-unplanned-settled — ${pass} assertions`);

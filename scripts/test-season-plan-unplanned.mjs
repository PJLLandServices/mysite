#!/usr/bin/env node
// scripts/test-season-plan-unplanned.mjs
//
// "Additional properties that I am adding aren't backfilling on the Season
// Plan." — Patrick, 2026-09-11.
//
// They couldn't. The plan is a once-a-season import and its own design
// note said the only edit worth having was moving a stop between days.
// Assign books only the codes already on a day. So a property created
// AFTER the import had no way onto a route day — and no way to be
// noticed: not skipped, not a problem, not a warning. It simply did not
// exist to the plan.
//
// Two things end that, pinned here:
//
//   1. season-plans.addStop — put a code on a day it isn't on. Mirror of
//      moveStop (same validation, same "any date grows a day" rule), and
//      it REFUSES a code already in the plan: one operation per state.
//
//   2. assignments.unplanned — every property eligible for the season and
//      on no route day, judged by the SAME gauntlet preflight and assign
//      run. Anything eligible-looking that can't be placed comes back
//      too, with its reason, because "not on the list" is the exact
//      silence this exists to end.
//
// The prior-assignment rule ("once ever, whatever became of it") is now
// one named function that assign() refuses on and unplanned() reports on.
//
// Run: node scripts/test-season-plan-unplanned.mjs  (also in build:check)

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
const j = (v, n = 220) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

// Sandbox copy of the lib, so the plan file this writes is never the
// real one (same pattern as test-season-plan-moves).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-unplanned-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const seasonPlans = require(path.join(SANDBOX, "server/lib/season-plans.js"));
const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));

// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const addStop = async (...a) => {
  if (typeof seasonPlans.addStop !== "function") return { error: "(addStop is missing)" };
  try { return await seasonPlans.addStop(...a); } catch (err) { return { error: err.message }; }
};
const unplanned = async (...a) => {
  if (typeof assignments.unplanned !== "function") return { error: "(unplanned is missing)" };
  try { return await assignments.unplanned(...a); } catch (err) { return { error: err.message }; }
};
const codesOn = (plan, date, bucket) => (plan?.days?.[date]?.[bucket] || []);

try {
  await seasonPlans.savePlan("fall", 2026, {
    bucketCap: 5,
    dayCap: 10,
    days: {
      "2026-10-05": { label: "R1", morning: ["P-1", "P-2"], afternoon: ["P-3"] },
      "2026-10-06": { label: "R2", morning: ["P-4"], afternoon: [] }
    }
  });

  // ---- 1. addStop puts a new code on a day ------------------------------
  {
    const r = await addStop("fall", 2026, { propertyCode: "P-9", toDate: "2026-10-06", toBucket: "afternoon" });
    ok("a property not on the plan can be put on a day", !r.error, r.error);
    ok("…and it is there afterwards",
      codesOn(r.plan, "2026-10-06", "afternoon").includes("P-9"), j(r.plan?.days?.["2026-10-06"]));
    ok("…without disturbing anyone else on that day",
      codesOn(r.plan, "2026-10-06", "morning").includes("P-4"), j(r.plan?.days?.["2026-10-06"]));
    ok("…and says what it did", r.added?.propertyCode === "P-9" && r.added?.to?.date === "2026-10-06"
      && r.added?.createdDay === false, j(r.added));
  }

  // ---- 2. Any calendar date grows a day, like a move does ---------------
  {
    const r = await addStop("fall", 2026, { propertyCode: "P-10", toDate: "2026-11-20", toBucket: "morning" });
    ok("a date the plan never routed becomes a new day", !r.error && r.added?.createdDay === true, r.error || j(r.added));
    ok("…holding the stop", codesOn(r.plan, "2026-11-20", "morning").includes("P-10"), j(r.plan?.days?.["2026-11-20"]));
    const again = await seasonPlans.getPlan("fall", 2026);
    ok("…and it survives a re-read", codesOn(again, "2026-11-20", "morning").includes("P-10"), j(again?.days?.["2026-11-20"]));
  }

  // ---- 3. One operation per state --------------------------------------
  {
    const r = await addStop("fall", 2026, { propertyCode: "P-1", toDate: "2026-10-06", toBucket: "morning" });
    ok("a code already on the plan is REFUSED — that is a move, not an add",
      /already on 2026-10-05/.test(r.error || ""), j(r.error));
    const plan = await seasonPlans.getPlan("fall", 2026);
    ok("…and nothing changed", codesOn(plan, "2026-10-05", "morning").includes("P-1")
      && !codesOn(plan, "2026-10-06", "morning").includes("P-1"), j(plan?.days));
  }

  // ---- 4. Garbage is still garbage -------------------------------------
  {
    ok("no code → refused", /propertyCode/.test((await addStop("fall", 2026, { propertyCode: "", toDate: "2026-10-06", toBucket: "morning" })).error || ""));
    ok("a non-date → refused", /calendar date/.test((await addStop("fall", 2026, { propertyCode: "P-11", toDate: "next tuesday", toBucket: "morning" })).error || ""));
    ok("a non-bucket → refused", /Bucket/.test((await addStop("fall", 2026, { propertyCode: "P-11", toDate: "2026-10-06", toBucket: "evening" })).error || ""));
    ok("no plan for that season → refused with the fix named",
      /import the plan first/.test((await addStop("spring", 2027, { propertyCode: "P-11", toDate: "2027-04-06", toBucket: "morning" })).error || ""));
  }

  // ---- 5. plannedCodes is the one answer to "is it on the plan?" -------
  {
    const plan = await seasonPlans.getPlan("fall", 2026);
    const set = typeof seasonPlans.plannedCodes === "function" ? seasonPlans.plannedCodes(plan) : null;
    ok("plannedCodes covers every day and bucket",
      set && ["P-1", "P-2", "P-3", "P-4", "P-9", "P-10"].every((c) => set.has(c)), j(set ? [...set] : "(missing)"));
    ok("…and nothing that isn't there", set && !set.has("P-99"), "P-99 reported planned");
  }

  // ---- 6. The unplanned list --------------------------------------------
  //
  // Six properties. Two on the plan, one new and fine, one new but opted
  // out, one that had an assignment cancelled, one that booked itself.
  {
    const props = [
      { id: "prop-1", code: "P-1", customerName: "On Plan", address: "1 A St", coords: { lat: 44, lng: -79 }, system: { zones: [1, 2, 3, 4] } },
      { id: "prop-2", code: "P-2", customerName: "Also On Plan", address: "2 A St", system: { zones: [1, 2] } },
      { id: "prop-new", code: "P-NEW", customerName: "Brand New", address: "9 New Rd, Newmarket", coords: { lat: 44.1, lng: -79.4 }, system: { zones: [1, 2, 3, 4, 5, 6] } },
      { id: "prop-out", code: "P-OUT", customerName: "Opted Out", address: "3 A St",
        seasonalOutreach: { "2026:fall": { optOutThisSeason: true } } },
      { id: "prop-declined", code: "P-DEC", customerName: "Said No", address: "4 A St", system: { zones: [1, 2, 3] } },
      { id: "prop-self", code: "P-SELF", customerName: "Booked Themselves", address: "5 A St" },
      { id: "prop-nocode", customerName: "No Code", address: "6 A St" }
    ];
    const bookingsList = [
      { id: "BK-DEC", source: "assignment", status: "cancelled", propertyId: "prop-declined",
        assignment: { season: "fall", year: 2026, code: "P-DEC" } }
    ];
    const assess = async (property, { season, year }) => {
      if (property.seasonalOutreach?.[`${year}:${season}`]?.optOutThisSeason) return { ok: false, reason: "season_opt_out" };
      if (property.id === "prop-self") return { ok: false, reason: "already_booked", bookingId: "BK-SELF" };
      if (!property.customerName) return { ok: false, reason: "missing_name" };
      return { ok: true, customerName: property.customerName, portalToken: "t" };
    };
    const deps = {
      getPlan: async () => ({ days: { "2026-10-05": { morning: ["P-1", "P-2"], afternoon: [] } } }),
      listProperties: async () => props,
      listBookings: async () => bookingsList,
      assessEligibility: assess
    };
    const r = await unplanned("fall", 2026, deps);
    ok("the unplanned list answers at all", r?.ok === true, r?.error || j(r));

    const placeable = (r?.placeable || []).map((x) => x.code);
    ok("a new, eligible property is offered a day", placeable.includes("P-NEW"), j(placeable));
    ok("…with what Assign will need to know",
      (r?.placeable || []).find((x) => x.code === "P-NEW")?.zoneCount === 6, j(r?.placeable));
    ok("a property already on the plan is not offered again", !placeable.includes("P-1") && !placeable.includes("P-2"), j(placeable));
    ok("a customer who booked themselves is settled, not listed",
      !placeable.includes("P-SELF") && !(r?.blocked || []).some((x) => x.code === "P-SELF"), j(r));

    const blocked = r?.blocked || [];
    const by = (code) => blocked.find((x) => x.code === code);
    ok("an opted-out property is SHOWN as blocked, not silently left off",
      by("P-OUT")?.reason === "season_opt_out", j(blocked));
    ok("a cancelled assignment is a no, and says so",
      by("P-DEC")?.reason === "assignment_declined" && by("P-DEC")?.bookingId === "BK-DEC", j(blocked));
    ok("a record with no code is named rather than lost",
      blocked.some((x) => x.reason === "no_code" && x.customerName === "No Code"), j(blocked));
    ok("…and none of the blocked are offered a day", !placeable.some((c) => ["P-OUT", "P-DEC"].includes(c)), j(placeable));

    const none = await unplanned("spring", 2027, { ...deps, getPlan: async () => null });
    ok("no plan → says so instead of pretending everyone is unplanned",
      none?.ok === false && none?.reason === "no_plan" && (none?.placeable || []).length === 0, j(none));
  }

  // ---- 7. One rule for "did they already have one" ----------------------
  {
    const src = read("server/lib/assignments.js");
    ok("the prior-assignment rule is one named function",
      /async function priorAssignmentsFor\(/.test(src), "priorAssignmentsFor is gone");
    ok("…that assign() refuses on",
      /const priorAssignment = await priorAssignmentsFor\(season, year, listBookings\)/.test(src),
      "assign() grew its own copy back");
    ok("…and unplanned() reports on",
      /async function unplanned\([\s\S]{0,1200}await priorAssignmentsFor\(/.test(src),
      "unplanned() has its own copy");
    ok("…judging eligibility with the outreach module's own gauntlet",
      /async function unplanned\([\s\S]{0,600}outreach\.assessEligibility/.test(src),
      "unplanned() invented its own eligibility");
  }

  // ---- 8. The wiring, and that it is LOUD -------------------------------
  {
    const server = read("server/server.js");
    ok("there is an unplanned route", /season-plans[\s\S]{0,40}\/unplanned\$/.test(server), "no unplanned route");
    ok("there is an add route", /season-plans[\s\S]{0,40}\/add\$/.test(server), "no add route");
    ok("…and an add re-sequences the day, like a move does",
      /seasonPlanAddMatch[\s\S]{0,1200}resequencePlanForStorage/.test(server), "an added stop lands unsequenced");

    const html = read("server/season-plan.html");
    ok("the toolbar has a button for it, wearing a count",
      /id="unplannedToggle"/.test(html) && /id="unplannedBadge"/.test(html), "no toolbar entry");
    ok("…and a drawer with a place for the blocked ones too",
      /id="drawerUnplanned"/.test(html) && /id="unplannedBlocked"/.test(html), "no drawer");

    const page = read("server/season-plan.js");
    ok("the page loads the list alongside the plan",
      /render\(data\.plan\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*loadUnplanned\(\);/.test(page) || /render\(data\.plan\);[\s\S]{0,300}loadUnplanned\(\);/.test(page),
      "the list isn't loaded with the plan");
    ok("…offers 'any other date' like the move picker",
      /dayPickerFor[\s\S]{0,2000}__custom/.test(page), "no custom date on the add picker");
    ok("…and says the next step, because adding isn't booking",
      /Run Assign to book it/.test(page), "the toast doesn't say what to do next");
    ok("…and names every blocked reason in plain words",
      ["no_code", "season_opt_out", "previously_assigned", "assignment_declined", "not_eligible", "missing_name"]
        .every((k) => new RegExp(`${k}:`).test(page)),
      "a blocked reason would render as raw snake_case");
  }
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n✗ test-season-plan-unplanned: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-season-plan-unplanned: ${pass} assertions passed`);

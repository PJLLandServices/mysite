// Season-plan stop moves — including moves to dates the plan never routed.
//
//   node scripts/test-season-plan-moves.mjs
//
// WHAT THIS PROTECTS. Patrick's customers ask for specific dates ("keep
// the closing to the very end of the year"), and until 2026-09-02 the
// review screen could only move a stop between days the generator had
// seeded — moveStop threw on any other date. It now grows a new, empty
// route day for an unseeded date and moves the stop there; from then on
// the day behaves like any other (geo shape, Assign, writer). This
// suite pins that: the day is created exactly once, the stop actually
// leaves its source day, existing-day moves are unchanged, garbage
// dates are still refused, and the created day survives a re-save.
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
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-planmove-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const seasonPlans = require(path.join(SANDBOX, "server/lib/season-plans.js"));

await seasonPlans.savePlan("fall", 2026, {
  bucketCap: 5,
  dayCap: 10,
  days: {
    "2026-10-05": { label: "R1", morning: ["P-1", "P-2"], afternoon: ["P-3"] },
    "2026-10-06": { label: "R2", morning: ["P-4"], afternoon: [] }
  }
}, { actor: "test" });

// ---- 1. Existing-day moves are unchanged --------------------------------
{
  const out = await seasonPlans.moveStop("fall", 2026, {
    propertyCode: "P-1", toDate: "2026-10-06", toBucket: "afternoon"
  }, { actor: "test" });
  ok("move to an existing day still works",
    out.plan.days["2026-10-06"].afternoon.includes("P-1")
    && !out.plan.days["2026-10-05"].morning.includes("P-1"));
  ok("existing-day move reports createdDay false", out.moved.createdDay === false);
}

// ---- 2. A date the plan never routed grows a new day --------------------
{
  const out = await seasonPlans.moveStop("fall", 2026, {
    propertyCode: "P-2", toDate: "2026-11-27", toBucket: "morning"
  }, { actor: "test" });
  const day = out.plan.days["2026-11-27"];
  ok("the end-of-season date now exists as a route day", Boolean(day), JSON.stringify(Object.keys(out.plan.days)));
  ok("the stop landed in the asked-for bucket", day && day.morning.includes("P-2"));
  ok("the stop left its source day", !out.plan.days["2026-10-05"].morning.includes("P-2"));
  ok("the new day starts otherwise empty",
    day && day.morning.length === 1 && day.afternoon.length === 0);
  ok("the move reports it created the day", out.moved.createdDay === true);
}

// ---- 3. The created day survives a read and another move ----------------
{
  const plan = await seasonPlans.getPlan("fall", 2026);
  ok("the created day survives a fresh read", Boolean(plan.days["2026-11-27"]));
  const out = await seasonPlans.moveStop("fall", 2026, {
    propertyCode: "P-3", toDate: "2026-11-27", toBucket: "afternoon"
  }, { actor: "test" });
  ok("a second stop joins the created day without creating it again",
    out.moved.createdDay === false
    && out.plan.days["2026-11-27"].afternoon.includes("P-3"));
}

// ---- 4. Garbage is still refused ----------------------------------------
{
  let threw = "";
  try {
    await seasonPlans.moveStop("fall", 2026, { propertyCode: "P-4", toDate: "2026-02-31", toBucket: "morning" });
  } catch (e) { threw = e.message; }
  ok("an impossible calendar date is refused", /Not a calendar date/.test(threw), threw);
  let threw2 = "";
  try {
    await seasonPlans.moveStop("fall", 2026, { propertyCode: "P-NOPE", toDate: "2026-11-30", toBucket: "morning" });
  } catch (e) { threw2 = e.message; }
  ok("a code not in the plan is refused", /not in the fall-2026 plan/.test(threw2), threw2);
  const plan = await seasonPlans.getPlan("fall", 2026);
  ok("the refused unknown-code move left no orphan day behind", !plan.days["2026-11-30"]);
}

// ---- 5. validate() keeps the hand-grown day on a full re-save -----------
{
  const plan = await seasonPlans.getPlan("fall", 2026);
  const { plan: resaved } = await seasonPlans.savePlan("fall", 2026, plan, { actor: "test" });
  ok("a re-save keeps the created day and its stops",
    resaved.days["2026-11-27"]
    && resaved.days["2026-11-27"].morning.includes("P-2")
    && resaved.days["2026-11-27"].afternoon.includes("P-3"));
}

// ---- Report --------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ test-season-plan-moves: ${failures.length} failed, ${pass} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-season-plan-moves: ${pass} assertions passed`);

// Re-dating a route day.
//
//   node scripts/test-day-reschedule.mjs
//
// The case: the weather stays too warm to close systems down, a day cannot
// run, and it has to slide. Only that day slides.
//
// Three properties carry the risk and each is asserted here:
//
//   1. THE STOPS TRAVEL WITH THE DAY. A move that dropped or reordered the
//      day's properties would be silent — the screen would still show a
//      plausible route, on the wrong date, with the wrong stops.
//   2. TWO DAYS CANNOT SHARE A DATE. The store is keyed by date, so an
//      unchecked move would overwrite the day already sitting there and
//      take its stops with it.
//   3. A DAY WITH REAL BOOKINGS IS REFUSED. Today no booking can exist
//      against a planned day, because nothing tells a customer their date
//      yet. The moment the assignment writer lands, moving a day breaks a
//      promise — the guard has to already be here, not be remembered after
//      three customers are stood up.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// THE STORE WRITES TO THE REAL FILE. server/lib/season-plans.js resolves
// server/data/season-plans.json at require time with no injectable path, so
// this test would otherwise overwrite a live season plan on any machine that
// has one — build:check is not part of the deploy build, but it is run
// locally, and "the tests ate the plan" is not a thing to discover later.
//
// So: snapshot the file, restore it in a finally. If it did not exist, it is
// removed again rather than left behind as an empty plan store.
const REAL_FILE = path.join(ROOT, "server", "data", "season-plans.json");
const hadFile = fs.existsSync(REAL_FILE);
const snapshot = hadFile ? fs.readFileSync(REAL_FILE, "utf8") : null;
function restore() {
  if (!hadFile) { fs.rmSync(REAL_FILE, { force: true }); return; }
  fs.writeFileSync(REAL_FILE, snapshot);
}
process.on("exit", restore);

const require = createRequire(import.meta.url);
const plans = require(path.join(ROOT, "server/lib/season-plans.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
async function throws(name, fn, match) {
  try {
    await fn();
    failures.push(`${name} — expected it to refuse, but it succeeded`);
  } catch (err) {
    if (match && !match.test(err.message)) {
      failures.push(`${name} — refused with the wrong reason: ${err.message}`);
      return;
    }
    pass += 1;
  }
}

const SEED = {
  generatedAt: "2026-08-30T00:00:00Z",
  source: "test",
  bucketCap: 5,
  dayCap: 7,
  days: {
    "2026-09-28": { label: "R1", territory: "North home turf",
      morning: ["P-2026-0071", "P-2026-0074"], afternoon: ["P-2026-0107"] },
    "2026-09-29": { label: "R2", territory: "Far north",
      morning: ["P-2026-0002"], afternoon: [] }
  }
};

async function reseed() {
  await plans.savePlan("fall", 2026, JSON.parse(JSON.stringify(SEED)), { actor: "test" });
}

await reseed();

// ---- The ordinary move -----------------------------------------------

const moved = await plans.moveDay("fall", 2026,
  { fromDate: "2026-09-28", toDate: "2026-10-01" }, { actor: "patrick" });

ok("the day is gone from its old date", !moved.plan.days["2026-09-28"]);
ok("the day is on its new date", Boolean(moved.plan.days["2026-10-01"]));
ok("THE STOPS TRAVEL WITH THE DAY, in order",
  JSON.stringify(moved.plan.days["2026-10-01"].morning) === JSON.stringify(["P-2026-0071", "P-2026-0074"])
  && JSON.stringify(moved.plan.days["2026-10-01"].afternoon) === JSON.stringify(["P-2026-0107"]),
  JSON.stringify(moved.plan.days["2026-10-01"]));

// The label is the name of a set of properties in a territory, and Patrick
// talks about days that way. Renumbering on a move would make yesterday's
// sentence about R1 refer to somewhere else.
ok("THE LABEL TRAVELS WITH THE DAY, not with the date",
  moved.plan.days["2026-10-01"].label === "R1", moved.plan.days["2026-10-01"].label);
ok("...and so does the territory",
  moved.plan.days["2026-10-01"].territory === "North home turf");

ok("ONLY THAT DAY MOVED — the rest of the season kept its dates",
  Boolean(moved.plan.days["2026-09-29"])
  && moved.plan.days["2026-09-29"].label === "R2");
ok("the plan still holds the same number of days",
  Object.keys(moved.plan.days).length === 2, String(Object.keys(moved.plan.days).length));

ok("the move is reported back with both dates and the label",
  moved.moved.from === "2026-09-28" && moved.moved.to === "2026-10-01"
  && moved.moved.label === "R1", JSON.stringify(moved.moved));
ok("the move is attributed", moved.plan.updatedBy === "patrick", moved.plan.updatedBy);

// ---- Collisions ------------------------------------------------------

await reseed();
await throws("MOVING ONTO AN OCCUPIED DATE IS REFUSED — it would overwrite that day",
  () => plans.moveDay("fall", 2026, { fromDate: "2026-09-28", toDate: "2026-09-29" }),
  /already holds/);

const afterRefusal = await plans.getPlan("fall", 2026);
ok("...and the refused move changed nothing",
  Boolean(afterRefusal.days["2026-09-28"]) && Boolean(afterRefusal.days["2026-09-29"])
  && afterRefusal.days["2026-09-29"].label === "R2");
ok("...and the day it would have overwritten kept its stops",
  JSON.stringify(afterRefusal.days["2026-09-29"].morning) === JSON.stringify(["P-2026-0002"]));

// The error has to name the day in the way, not just say "taken" — the
// operator's next move is to decide what to do with THAT day.
try {
  await plans.moveDay("fall", 2026, { fromDate: "2026-09-28", toDate: "2026-09-29" });
} catch (err) {
  ok("the collision names the day standing in the way", /R2/.test(err.message), err.message);
}

// ---- Real bookings ---------------------------------------------------

await throws("A DAY CARRYING REAL BOOKINGS IS REFUSED",
  () => plans.moveDay("fall", 2026,
    { fromDate: "2026-09-28", toDate: "2026-10-01", bookedCount: 3 }),
  /3 real bookings/);

await throws("...and the message is singular for one booking",
  () => plans.moveDay("fall", 2026,
    { fromDate: "2026-09-28", toDate: "2026-10-01", bookedCount: 1 }),
  /1 real booking\b/);

const stillThere = await plans.getPlan("fall", 2026);
ok("...and a refused booking-guard move changed nothing",
  Boolean(stillThere.days["2026-09-28"]) && !stillThere.days["2026-10-01"]);

// A PLANNED STOP IS NOT A BOOKING. R1 has three planned properties on it
// and must still move freely — the guard counts bookings, which the caller
// supplies, never the plan's own stops.
const withPlannedStops = await plans.moveDay("fall", 2026,
  { fromDate: "2026-09-28", toDate: "2026-10-01", bookedCount: 0 });
ok("PLANNED STOPS DO NOT BLOCK A MOVE — only real bookings do",
  Boolean(withPlannedStops.plan.days["2026-10-01"]));

// ---- Dates that are not dates ----------------------------------------

await reseed();
await throws("a non-date is refused",
  () => plans.moveDay("fall", 2026, { fromDate: "2026-09-28", toDate: "not-a-date" }),
  /Not a calendar date/);
await throws("Feb 31 is refused rather than rolled into March",
  () => plans.moveDay("fall", 2026, { fromDate: "2026-09-28", toDate: "2026-02-31" }),
  /Not a calendar date/);
await throws("moving a day that is not in the plan is refused",
  () => plans.moveDay("fall", 2026, { fromDate: "2026-12-25", toDate: "2026-12-26" }),
  /not a route day/);
await throws("moving a day onto its own date is refused rather than being a silent no-op",
  () => plans.moveDay("fall", 2026, { fromDate: "2026-09-28", toDate: "2026-09-28" }),
  /already on that date/);

// ---- Weekends --------------------------------------------------------
//
// Allowed — Patrick may choose one — but reported, because landing on a
// Saturday by arithmetic accident reads exactly like choosing one.

await reseed();
const toSaturday = await plans.moveDay("fall", 2026,
  { fromDate: "2026-09-28", toDate: "2026-10-03" });   // Saturday
ok("a weekend date is allowed", Boolean(toSaturday.plan.days["2026-10-03"]));
ok("...and is flagged as a weekend so the screen can say so",
  toSaturday.moved.weekend === true);

await reseed();
const toThursday = await plans.moveDay("fall", 2026,
  { fromDate: "2026-09-28", toDate: "2026-10-01" });   // Thursday
ok("a weekday is not flagged", toThursday.moved.weekend === false);

if (failures.length) {
  console.error(`\n✗ test-day-reschedule: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-day-reschedule: ${pass} assertions passed`);

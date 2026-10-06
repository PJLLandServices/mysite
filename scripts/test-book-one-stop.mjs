#!/usr/bin/env node
// scripts/test-book-one-stop.mjs
//
// "okay, I dragged an appointment into the season plan, but it doesn't
// show booked, or booking or anything like that... but its in the
// seasonal plan." — "i need to be able to just book it regardless too."
// Patrick, 2026-10-06.
//
// A stop dropped onto a day is a planned INTENT; the appointment exists
// only after Assign. That was by design and invisible on the day card.
// Now the card carries Book now on every unassigned stop, and the writer
// takes `only: { code, date }` — the season run, narrowed to one stop:
//
//   1. ONE stop is booked, the others on the plan are left exactly as
//      they were (planned, unbooked).
//   2. The record is the same shape the season run writes (source,
//      assignment block, sequenced time) — one writer, not two.
//   3. Pressed again, the stop is settled; a code not on that day is
//      nothing (the route turns that into a 404 with the name).
//   4. "Regardless": a human's explicit yes overrules the two RECORDED
//      no's (skip-this-season, a cancelled assignment) — and only those.
//      A data gap (no zone count) still refuses, with its reason.
//
// Sandboxed like test-assignment-writer: server/lib is copied so the
// bookings store this writes is never the real one.
//
// Run: node scripts/test-book-one-stop.mjs  (also in build:check)

process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-book-one-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));
const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const properties = require(path.join(SANDBOX, "server/lib/properties.js"));

const SEASON = "fall";
const YEAR = 2026;
const DAY = "2026-10-20";

const zones = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));
const prop = (id, extra = {}) => ({
  id, code: id,
  customerName: `Customer ${id}`,
  customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`,
  address: `${id} Test St, Newmarket, ON`,
  town: "Newmarket",
  coords: { lat: 44.05, lng: -79.46, source: "google" },
  system: { zones: zones(4), zoneCount: null },
  ...extra
});
const FIXTURES = {
  "P-NEW": prop("P-NEW"),
  "P-OTHER": prop("P-OTHER"),
  "P-NOZONE": prop("P-NOZONE", { system: { zones: [], zoneCount: null } }),
  "P-SKIP": prop("P-SKIP", {
    seasonalOutreach: { [properties.seasonKey(YEAR, SEASON)]: { optOutThisSeason: true, touches: [] } }
  }),
  "P-DEC": prop("P-DEC")
};
const PLAN = {
  bucketCap: 5,
  days: {
    [DAY]: { label: "R1", territory: "Test", morning: ["P-NEW", "P-OTHER", "P-NOZONE"], afternoon: ["P-SKIP", "P-DEC"] }
  }
};
const deps = {
  getPlan: async () => PLAN,
  listProperties: async () => Object.values(FIXTURES),
  getCustomer: async () => ({ accountType: "residential" }),
  sequenceDay: async () => ({ timeline: [{ propertyCode: "P-NEW", bucket: "morning", arriveAt: "09:10" }] }),
  actor: "test"
};
// P-DEC's assignment was cancelled earlier this season — the recorded no
// the season run honours.
await bookings.createDirect({
  propertyId: "P-DEC", customerName: "Customer P-DEC",
  serviceKey: "fall_close_4z", serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor: new Date(2026, 9, 2, 9, 0).toISOString(), durationMinutes: 30,
  status: "cancelled", source: "assignment",
  assignment: { season: SEASON, year: YEAR, date: "2026-10-02", bucket: "morning", code: "P-DEC", batchId: "AS-old" }
}, { by: "test" });

const assigned = async () => (await bookings.list()).filter((b) => b.source === "assignment" && bookings.holdsItsSlot(b.status));

// ---- 1. One stop, now ------------------------------------------------------
{
  const before = (await assigned()).length;
  const r = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-NEW", date: DAY } });
  ok("the writer takes only:{code,date} and answers", r?.ok === true, j(r));
  ok("…about exactly that stop", r?.summary?.stops === 1 && r?.stop?.code === "P-NEW", j(r?.summary) + " " + j(r?.stop));
  ok("…and books it", r?.stop?.outcome === "created" && r?.summary?.created === 1, j(r?.stop));
  const after = await assigned();
  ok("exactly one new booking exists", after.length === before + 1, `${before} → ${after.length}`);
  const b = after.find((x) => x.propertyId === "P-NEW");
  ok("it is the season run's own record shape — source, assignment block, confirmed",
    b && b.source === "assignment" && b.status === "confirmed"
    && b.assignment?.season === SEASON && b.assignment?.year === YEAR
    && b.assignment?.date === DAY && b.assignment?.bucket === "morning" && b.assignment?.code === "P-NEW", j(b));
  ok("…timed at its sequenced arrival, like any assigned stop",
    b && new Date(b.scheduledFor).getHours() === 9 && new Date(b.scheduledFor).getMinutes() === 10, b?.scheduledFor);
  ok("the OTHER planned stops were not touched",
    !after.some((x) => ["P-OTHER", "P-NOZONE", "P-SKIP"].includes(x.propertyId)), j(after.map((x) => x.propertyId)));
  ok("the answer names what it was asked", r?.only?.code === "P-NEW" && r?.only?.date === DAY, j(r?.only));
}

// ---- 2. Again: settled; elsewhere: nothing -----------------------------------
{
  const again = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-NEW", date: DAY } });
  ok("pressed again, the stop is settled and nothing new is written",
    again?.stop?.outcome === "settled" && again?.summary?.created === 0, j(again?.stop));
  const nowhere = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-NEW", date: "2026-10-21" } });
  ok("a code not on that day is nothing — no stop, no booking",
    nowhere?.ok === true && nowhere?.stop === null && nowhere?.summary?.stops === 0, j(nowhere?.summary));
  const ghost = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-GHOST", date: DAY } });
  ok("…same for a code the plan never had", ghost?.stop === null && ghost?.summary?.created === 0, j(ghost?.summary));
}

// ---- 3. "Regardless" — a human's yes over a recorded no, never over a gap ---
{
  const skip = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-SKIP", date: DAY } });
  ok("skip-this-season is overruled by an explicit Book now",
    skip?.stop?.outcome === "created" && skip?.stop?.overruled === "season_opt_out", j(skip?.stop));
  const dec = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-DEC", date: DAY } });
  ok("a cancelled assignment is overruled too — this IS 'book by hand'",
    dec?.stop?.outcome === "created" && dec?.stop?.overruled === "assignment_declined", j(dec?.stop));
  const gap = await assignments.assign(SEASON, YEAR, { ...deps, only: { code: "P-NOZONE", date: DAY } });
  ok("a missing zone count still refuses, with its reason",
    gap?.stop?.outcome === "skipped" && gap?.stop?.reason === "no_zone_count" && gap?.summary?.created === 0, j(gap?.stop));

  // The season-wide run keeps honouring both no's for everyone else: the
  // overrule belongs to the press, not to the writer.
  const seasonRun = await assignments.assign(SEASON, YEAR, deps);
  const rows = new Map(seasonRun.days.flatMap((d) => d.stops).map((r) => [r.code, r]));
  ok("a season-wide Assign still books the plain planned stop", rows.get("P-OTHER")?.outcome === "created", j(rows.get("P-OTHER")));
  ok("…and reads the stops booked by hand as settled",
    ["P-NEW", "P-DEC"].every((c) => rows.get(c)?.outcome === "settled"), j([...rows.values()].map((r) => [r.code, r.outcome])));
  // The skip-this-season flag still stands on the property (the gauntlet
  // reads it before the booking), so the season run skips P-SKIP for that
  // reason — and, either way, never writes a second booking for them.
  ok("…the skipped-season flag still stands for the season run, and no second booking is written",
    rows.get("P-SKIP")?.outcome === "skipped" && rows.get("P-SKIP")?.reason === "season_opt_out"
    && (await assigned()).filter((b) => b.propertyId === "P-SKIP").length === 1, j(rows.get("P-SKIP")));
  ok("…and still refuses the zone-less stop", rows.get("P-NOZONE")?.outcome === "skipped" && rows.get("P-NOZONE")?.reason === "no_zone_count");
}

// ---- 4. The wiring -------------------------------------------------------------
{
  const server = read("server/server.js");
  const page = read("server/season-plan.js");
  ok("the assign route reads { code, date } from the body into only",
    /assignRunMatch\[3\] === "assign"[\s\S]{0,900}assignments\.assign\(season, year, only \? \{ actor, only \} : \{ actor \}\)/.test(server), "route ignores the body");
  ok("…and a stop not on that day is a 404 that names it",
    /if \(only && !result\.stop\)[\s\S]{0,200}isn't on the plan for/.test(server), "no 404");
  ok("the plan payload carries each stop's booking state by the plan's own rule",
    /stopState: \(code, date\) => driven\.stateFor\(code, date\)/.test(server) && /stop\.bookingState = \(st && st\.state\) \|\| "unassigned"/.test(server), "no bookingState");
  ok("the day card offers Book now on an unassigned stop only",
    /else if \(stop\.bookingState === "unassigned"\) \{\s*meta\.appendChild\(bookNowControl\(stop, date\)\)/.test(page), "no Book now");
  ok("…two presses, posting that one code and day to the assign route",
    /armTwice\(button, "Press again to BOOK"[\s\S]{0,700}\/assign`[\s\S]{0,300}JSON\.stringify\(\{ code: stop\.code, date \}\)/.test(page), "not two-press or wrong body");
  ok("…and the toast says whether the customer was told", /booked for \$\{prettyDate\(date\)\} and told/.test(page) && /NOT told — /.test(page));
  ok("the route tells the customer after a Book-now booking, through the one confirmation path",
    /result\.stop\.outcome === "created" && result\.stop\.bookingId[\s\S]{0,400}assignmentCadence\.sendConfirmationForBooking\(result\.stop\.bookingId/.test(server), "Book now books silently");
  ok("…with the same skip words the Send confirmation button uses",
    /const CONFIRM_SKIP_WORDS = \{/.test(server) && (server.match(/CONFIRM_SKIP_WORDS\[/g) || []).length >= 2, "two copies of the skip words");
  ok("the drop toast now points at Book now", /press Book now on the stop, or run Assign/.test(page));
  ok("assign's one-stop narrowing is documented where it lives",
    /deps\.only = \{ code, date \}/.test(read("server/lib/assignments.js")));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL test-book-one-stop: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-book-one-stop — ${pass} assertions`);

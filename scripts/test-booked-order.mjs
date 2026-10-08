#!/usr/bin/env node
// scripts/test-booked-order.mjs
//
// Patrick, 2026-10-07, Oct 14 on the board: "If we start off with Cynthia
// like we needed to, first stop, and moved to Richmond Hill, then Woodbridge
// we'd be fine. ... But there's a glitch: wherever a personally booked
// appointment sits, you cannot adjust or re-arrange like you can for the
// season schedule."
//
// He was right on both counts. A self-booked customer is not a plan stop,
// so (a) the arrows never existed for it and (b) on a hand-ordered day
// sequenceWithBookings appended every booked row AFTER the plan stops of
// its half-day — Markham could only ever come after Woodbridge, and the
// optimiser that would have put it first was switched off by the hand
// order. The first arrow press also froze the STORED order, not the one
// on the screen, so the booked rows snapped to the end on that click.
//
// The fix is one rule, season-plans.bucketOrderWithBooked(): where each
// booked customer sits among the plan codes of a half-day. The arrows edit
// that merged list (reorderStop takes `__bk:<key>` tokens too) and the
// sequencer walks it. This pins the rule, both readers, the freeze-as-
// displayed behaviour, and that the positions survive validate().
//
// Sections 2, 3b, 4 and 6 fail on the code before the fix.
//
// Run: node scripts/test-booked-order.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The plan store writes the real file (see test-day-reschedule.mjs for why
// it is snapshotted and restored rather than redirected).
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
const assignments = require(path.join(ROOT, "server/lib/assignments.js"));
const resequence = require(path.join(ROOT, "server/lib/resequence.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 300) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
async function throws(name, fn, match) {
  try { await fn(); failures.push(`${name} — expected a refusal, it succeeded`); }
  catch (err) {
    if (match && !match.test(err.message)) { failures.push(`${name} — wrong reason: ${err.message}`); return; }
    pass += 1;
  }
}
// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const lib = (name) => (typeof plans[name] === "function" ? plans[name]
  : async () => { throw new Error(`${name} is missing`); });

// ---- Oct 14 on a grid. One grid unit = one minute of driving. -----------
// Yard at the origin; Markham east-south, Richmond Hill south, Woodbridge
// south-west. Yard→Markham→Richmond Hill→Woodbridge is the short way
// round; Richmond Hill→Woodbridge→Markham doubles back across the city.
const at = ([x, y]) => ({ lat: 44 + x / 1000, lng: -79.5 + y / 1000 });
const gx = (c) => Math.round((c.lat - 44) * 1000);
const gy = (c) => Math.round((c.lng + 79.5) * 1000);
const travel = async (a, b) => Math.round(Math.hypot(gx(a) - gx(b), gy(a) - gy(b)));
const prop = (code, xy, zones) => ({
  code, id: code, address: `${code} St`, town: "T", coords: at(xy),
  system: { zones: Array.from({ length: zones }, (_, i) => ({ number: i + 1 })) }
});
const byCode = new Map([
  ["VAL", prop("VAL", [30, 10], 3)],
  ["FAN", prop("FAN", [31, 10], 3)],
  ["FRANK", prop("FRANK", [40, -20], 12)]   // 75 min, and not before 11:00
]);
const cynthia = () => ({ bookingId: "BK-1", customerName: "Cynthia", bucket: "morning", coords: at([30, 30]), start: "2026-10-14T12:20:00.000Z" });
const seq = (day, o) => resequence.sequenceDay(day, { ...o, travel, base: at([0, 0]) });
const order = (sequenced) => (sequenced.timeline || []).map((t) => t.propertyCode);

// ---- 1. The rule ---------------------------------------------------------
{
  const f = (...a) => { try { return plans.bucketOrderWithBooked(...a); } catch (e) { return `(${e.message})`; } };
  ok("no stored position → the booked customer rides after the plan stops (the old default)",
    j(f({ morning: ["A", "B"] }, "morning", ["X"])) === j(["A", "B", "__bk:X"]));
  ok("{ before: code } → immediately before that plan stop",
    j(f({ morning: ["A", "B"], bookedOrder: { X: { before: "B" } } }, "morning", ["X"])) === j(["A", "__bk:X", "B"]));
  ok("{ before: null } → at the end, on purpose",
    j(f({ morning: ["A", "B"], bookedOrder: { X: { before: null } } }, "morning", ["X"])) === j(["A", "B", "__bk:X"]));
  ok("a position naming a stop that has LEFT the half-day falls to the end rather than vanishing",
    j(f({ morning: ["A"], bookedOrder: { X: { before: "GONE" } } }, "morning", ["X"])) === j(["A", "__bk:X"]));
  ok("two customers before the same stop keep their own order",
    j(f({ morning: ["A"], bookedOrder: { X: { before: "A" }, Y: { before: "A" } } }, "morning", ["X", "Y"])) === j(["__bk:X", "__bk:Y", "A"]));
  ok("a position for a customer who is no longer on the day is ignored",
    j(f({ morning: ["A"], bookedOrder: { Z: { before: "A" } } }, "morning", [])) === j(["A"]));
  ok("the token helpers agree with the sequencer's mapCode shape",
    typeof plans.bookedToken === "function" && plans.bookedToken("BK-1") === "__bk:BK-1" && plans.isBookedToken("__bk:BK-1") && !plans.isBookedToken("BK-1")
    && plans.bookedKeyOf("__bk:BK-1") === "BK-1");
}

// ---- 2. The sequencer reads the rule on a hand-ordered day ---------------
{
  const storedDay = {
    morning: ["VAL", "FAN", "FRANK"], afternoon: [], manualOrder: true,
    constraints: { FRANK: { notBefore: "11:00" } },
    bookedOrder: { "BK-1": { before: "VAL" } }
  };
  const row = cynthia();
  const { sequenced } = await assignments.sequenceWithBookings({ storedDay, bookedRows: [row], byCode, season: "fall", seq });
  ok("HAND-ORDERED DAY, Cynthia placed first: the drive starts at her door",
    j(order(sequenced)) === j(["__bk:BK-1", "VAL", "FAN", "FRANK"]), j(order(sequenced)));
  ok("…and the day waits for nobody", !(sequenced.flags || []).some((f) => /wait/i.test(f.code || "") || /waiting/i.test(f.message || "")), j(sequenced.flags));
  ok("the row still carries its mapCode", row.mapCode === "__bk:BK-1");

  const pinned = await assignments.sequenceWithBookings({
    storedDay: { ...storedDay, bookedOrder: undefined }, bookedRows: [cynthia()], byCode, season: "fall", seq
  });
  ok("same day with NO position: she rides last, as every day did before (nothing else changed)",
    j(order(pinned.sequenced)) === j(["VAL", "FAN", "FRANK", "__bk:BK-1"]), j(order(pinned.sequenced)));
  ok("the old shape is the worse drive — which is why Patrick could see it",
    pinned.sequenced.driveMinutes > sequenced.driveMinutes, `${pinned.sequenced.driveMinutes} vs ${sequenced.driveMinutes}`);

  const auto = await assignments.sequenceWithBookings({
    storedDay: { ...storedDay, manualOrder: false, bookedOrder: undefined }, bookedRows: [cynthia()], byCode, season: "fall", seq
  });
  ok("an AUTOMATIC day finds that order by itself (the position is only needed once a hand takes over)",
    order(auto.sequenced)[0] === "__bk:BK-1", j(order(auto.sequenced)));
}

// ---- 3. The arrows move a booked customer -------------------------------
const SEED = {
  generatedAt: "2026-08-30T00:00:00Z", source: "test", bucketCap: 5, dayCap: 10,
  days: { "2026-10-14": { label: "R8", morning: ["VAL", "FAN", "FRANK"], afternoon: [], constraints: { FRANK: { notBefore: "11:00" } } } }
};
const reseed = () => plans.savePlan("fall", 2026, JSON.parse(JSON.stringify(SEED)), { actor: "test" });
const shown = ["VAL", "FAN", "FRANK", "__bk:BK-1"];   // what the board showed: booked row last
const press = (propertyCode, direction, currentOrder = shown) => lib("reorderStop")("fall", 2026,
  { date: "2026-10-14", bucket: "morning", propertyCode, direction, currentOrder, bookedKeys: ["BK-1"] }, { actor: "patrick" })
  .catch((e) => ({ error: e.message }));
const day = async () => (await plans.getPlan("fall", 2026)).days["2026-10-14"];
const merged = async () => { try { return plans.bucketOrderWithBooked(await day(), "morning", ["BK-1"]); } catch (e) { return `(${e.message})`; } };

{
  await reseed();
  const r = await press("__bk:BK-1", "up");
  ok("3a. ↑ on the booked row moves it one place earlier",
    j(await merged()) === j(["VAL", "FAN", "__bk:BK-1", "FRANK"]), j(await merged()));
  ok("…the reply says what moved", r.reordered && r.reordered.propertyCode === "__bk:BK-1" && r.reordered.from === 3 && r.reordered.to === 2, j(r.reordered));
  ok("…the day is now hand-ordered", (await day()).manualOrder === true);
  ok("…stored as 'before FRANK', not as a copy of the list", j((await day()).bookedOrder) === j({ "BK-1": { before: "FRANK", rank: 0 } }), j((await day()).bookedOrder));
  ok("…and the plan codes themselves did not move", j((await day()).morning) === j(["VAL", "FAN", "FRANK"]));

  await press("__bk:BK-1", "up");
  await press("__bk:BK-1", "up");
  ok("3b. three presses: Cynthia is first — the order Patrick asked for",
    j(await merged()) === j(["__bk:BK-1", "VAL", "FAN", "FRANK"]), j(await merged()));
  await throws("3c. ↑ when already first is refused in plain words",
    () => lib("reorderStop")("fall", 2026, { date: "2026-10-14", bucket: "morning", propertyCode: "__bk:BK-1", direction: "up", currentOrder: shown, bookedKeys: ["BK-1"] }),
    /booked customer is already first/);

  // A PLAN stop moving past a booked row re-places the booked row too.
  await press("FAN", "up");
  ok("3d. ↑ on FAN hops it over VAL; Cynthia stays first",
    j(await merged()) === j(["__bk:BK-1", "FAN", "VAL", "FRANK"]), j(await merged()));
  ok("…her position now reads 'before FAN'", (await day()).bookedOrder?.["BK-1"]?.before === "FAN");
  await press("__bk:BK-1", "down");
  ok("3e. ↓ on Cynthia puts her between FAN and VAL",
    j(await merged()) === j(["FAN", "__bk:BK-1", "VAL", "FRANK"]), j(await merged()));

  // validate() rebuilds every day on save. The position must survive it.
  await plans.savePlan("fall", 2026, await plans.getPlan("fall", 2026), { actor: "test" });
  ok("3f. a save-and-reload keeps the position (validate copies bookedOrder)",
    j(await merged()) === j(["FAN", "__bk:BK-1", "VAL", "FRANK"]), j(await day()));
  ok("…and a junk position is dropped, a null one kept",
    (() => { const v = plans.validate({ ...SEED, days: { "2026-10-14": { ...SEED.days["2026-10-14"], bookedOrder: { A: { before: null }, B: "junk", C: { before: "X" } } } } });
      return j(v.plan.days["2026-10-14"].bookedOrder) === j({ A: { before: null }, C: { before: "X" } }); })());
  ok("…and a rank is kept through validate as well",
    j(plans.validate({ ...SEED, days: { "2026-10-14": { ...SEED.days["2026-10-14"], bookedOrder: { A: { before: "VAL", rank: 2 }, B: { before: "VAL", rank: -1 } } } } }).plan.days["2026-10-14"].bookedOrder)
      === j({ A: { before: "VAL", rank: 2 }, B: { before: "VAL" } }));

  await throws("3g. a booked customer who is not on this half-day is refused",
    () => lib("reorderStop")("fall", 2026, { date: "2026-10-14", bucket: "morning", propertyCode: "__bk:NOPE", direction: "up", bookedKeys: ["BK-1"] }),
    /booked customer is not in the morning/);
  ok("3h. the old call shape (plan code, no booked keys) still works",
    j((await lib("reorderStop")("fall", 2026, { date: "2026-10-14", bucket: "morning", propertyCode: "FRANK", direction: "up" })).plan.days["2026-10-14"].morning)
      === j(["FAN", "FRANK", "VAL"]));
}

// ---- 4. The first press freezes the day AS DISPLAYED ---------------------
{
  await reseed();
  // Stored: VAL, FAN, FRANK (automatic). The optimiser showed Cynthia
  // first. Patrick presses ↓ on FAN. Before the fix the store's own order
  // was frozen (Cynthia snapped to the end) — on the stored list FAN was
  // second, so the press "worked" and produced a day nobody had seen.
  await press("FAN", "down", ["__bk:BK-1", "VAL", "FAN", "FRANK"]);
  ok("4a. the frozen order is the one on the screen, plus the one move",
    j(await merged()) === j(["__bk:BK-1", "VAL", "FRANK", "FAN"]), j(await merged()));
  ok("…Cynthia did NOT snap to the end", (await merged())[0] === "__bk:BK-1");

  await reseed();
  // Store: VAL, FAN, FRANK. Screen: FRANK, VAL, FAN, Cynthia. ↓ on FRANK.
  // Adopted-then-moved gives VAL, FRANK, FAN; the old code (store order,
  // FRANK already last) refused the press outright.
  await press("FRANK", "down", ["FRANK", "VAL", "FAN", "__bk:BK-1"]);
  ok("4b. a displayed order that differs from the store is adopted first, then moved",
    j(await merged()) === j(["VAL", "FRANK", "FAN", "__bk:BK-1"]), j(await merged()));

  await reseed();
  await press("VAL", "down", ["VAL", "GHOST", "__bk:BK-1", "__bk:STRANGER"]);
  ok("4c. a displayed token the day does not hold is ignored; what the display left out is kept at the end",
    j(await merged()) === j(["__bk:BK-1", "VAL", "FAN", "FRANK"]), j(await merged()));

  // Once hand-ordered, the displayed order is the stored order; a stale
  // page's currentOrder must not overwrite what Patrick already set.
  await press("__bk:BK-1", "down", ["FAN", "FRANK", "VAL", "__bk:BK-1"]);
  ok("4d. on a day already hand-ordered the screen's list is NOT re-adopted",
    j(await merged()) === j(["VAL", "__bk:BK-1", "FAN", "FRANK"]), j(await merged()));
}

// ---- 4½. Two booked customers can swap with each other --------------------
// Patrick, 2026-10-07, minutes after the first version went live: "two
// personally booked appointments can't jump each other now either." Both
// rows read "before FRANK", so a swap wrote the same position for each and
// the merge put them back in arrival order.
{
  await reseed();
  const press2 = (propertyCode, direction, currentOrder) => lib("reorderStop")("fall", 2026,
    { date: "2026-10-14", bucket: "morning", propertyCode, direction, currentOrder, bookedKeys: ["BK-1", "BK-2"] }, { actor: "patrick" })
    .catch((e) => ({ error: e.message }));
  const merged2 = async () => plans.bucketOrderWithBooked(await day(), "morning", ["BK-1", "BK-2"]);
  // Screen: VAL, FAN, FRANK, Cynthia (BK-1), Kirk (BK-2). ↑ on Kirk.
  const r = await press2("__bk:BK-2", "up", ["VAL", "FAN", "FRANK", "__bk:BK-1", "__bk:BK-2"]);
  ok("4½a. ↑ on the second booked customer hops it over the first",
    j(await merged2()) === j(["VAL", "FAN", "FRANK", "__bk:BK-2", "__bk:BK-1"]), `${j(await merged2())} ${j(r.error)}`);
  await press2("__bk:BK-2", "up", null);
  await press2("__bk:BK-1", "up", null);
  ok("4½b. …and again with a plan stop between them: FRANK, Kirk, Cynthia → Kirk, FRANK, Cynthia → Kirk, Cynthia, FRANK",
    j(await merged2()) === j(["VAL", "FAN", "__bk:BK-2", "__bk:BK-1", "FRANK"]), j(await merged2()));
  await press2("__bk:BK-1", "up", null);
  ok("4½c. two booked rows side by side, same plan stop ahead of both: ↑ swaps them",
    j(await merged2()) === j(["VAL", "FAN", "__bk:BK-1", "__bk:BK-2", "FRANK"]), j(await merged2()));
  await press2("__bk:BK-1", "down", null);
  ok("4½d. ↓ swaps them back", j(await merged2()) === j(["VAL", "FAN", "__bk:BK-2", "__bk:BK-1", "FRANK"]), j(await merged2()));
  await plans.savePlan("fall", 2026, await plans.getPlan("fall", 2026), { actor: "test" });
  ok("4½e. the swap survives a save-and-reload", j(await merged2()) === j(["VAL", "FAN", "__bk:BK-2", "__bk:BK-1", "FRANK"]), j((await day()).bookedOrder));
  // Both at the END of the half-day (no plan stop after them) swap too.
  await reseed();
  await press2("__bk:BK-2", "up", ["VAL", "FAN", "FRANK", "__bk:BK-1", "__bk:BK-2"]);
  await press2("__bk:BK-2", "down", null);
  await press2("__bk:BK-1", "down", null);
  ok("4½f. two booked rows at the end of the half-day swap as well",
    j(await merged2()) === j(["VAL", "FAN", "FRANK", "__bk:BK-2", "__bk:BK-1"]), j(await merged2()));
}

// ---- 5. Back to automatic forgets the positions ---------------------------
{
  await reseed();
  await press("__bk:BK-1", "up");
  await lib("clearManualOrder")("fall", 2026, { date: "2026-10-14" }, { actor: "patrick" }).catch(() => null);
  const d = await day();
  ok("5. 'Back to automatic' drops manualOrder AND the booked positions", !d.manualOrder && !d.bookedOrder, j(d));
}

// ---- 6. Every reader holds the rule ---------------------------------------
{
  const page = read("server/season-plan.js");
  const server = read("server/server.js");
  const asg = read("server/lib/assignments.js");
  ok("6a. the page gives a booked row the same arrows as a plan stop",
    /function bookedRow\(b, date, bucket\)/.test(page) && /nudgeControl\(\{ code: b\.mapCode/.test(page));
  ok("6b. the arrows call the row by name, not by its token",
    /stop\.label \|\| stop\.code/.test(page));
  ok("6c. the route hands reorderStop the order the screen is showing and the booked keys on it",
    /currentOrder,\s*bookedKeys/.test(server) && /seasonPlans\.bookedKeyOf\(b\.mapCode\)/.test(server));
  ok("6d. the sequencer places booked rows through the plan store's one rule, not its own append",
    /seasonPlans\.bucketOrderWithBooked\(storedDay \|\| \{\}, "morning"/.test(asg) && !/\.\.\.extra\.morning\]/.test(asg));
  ok("6e. the merged-order rule lives once, in season-plans.js",
    (read("server/lib/season-plans.js").match(/function bucketOrderWithBooked/g) || []).length === 1);
}

restore();
console.log(`test-booked-order: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);

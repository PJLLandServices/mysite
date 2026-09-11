#!/usr/bin/env node
// scripts/test-season-plan-buckets.mjs
//
// Patrick, 2026-09-10, looking at a day on the Season Plan:
//
//   "Why does this display on the 'booked appointments' — lets just
//    display this as 'Morning Appointments' and 'Afternoon Appointments'.
//    Personally booked Appointments are Orange, and our allocated
//    appointments are Green. I am good with that.
//    But if you take a look at the Left Side, it shows 0/10 +1 (which is
//    the customer booked appointment) Just place 1/10 if there is 1
//    appointment, don't bother with the +1."
//
// TWO SYMPTOMS, ONE CAUSE. The screen drew a line between stops the plan
// seeded and appointments customers booked themselves, and that line does
// not exist anywhere else in the system:
//
//   • The day's stops were two half-day blocks PLUS a third "Booked
//     appointments" block holding every customer booking regardless of
//     when in the day it fell — so a 9am booking sat below the afternoon
//     plan, and the morning looked emptier than it was.
//   • The rail read "0/10 +1": planned over the cap, with bookings tacked
//     on afterwards.
//
// The availability engine has ALWAYS counted them together —
// `planned.count + extraBooked + incoming > shape.bucketCap` — so a day
// reading "0/10 +1" was a day the engine considered to hold one job. The
// screen was the only place pretending otherwise.
//
// Now: two blocks, "Morning Appointments" and "Afternoon Appointments",
// each holding both kinds in driving order, each counting one load
// against one cap. The colour keeps saying which is which, because that
// part already worked.
//
// Run: node scripts/test-season-plan-buckets.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "server", "season-plan.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// Lift a function out of the page's own source and run it against a stub
// DOM — the same trick test-app-shell uses, so what is asserted is the
// shipped code rather than a copy of it.
function lift(name, deps = "") {
  const start = SRC.indexOf(`  function ${name}(`);
  if (start < 0) return null;
  const end = SRC.indexOf("\n  }\n", start);
  if (end < start) return null;
  const body = SRC.slice(start, end + 4).replace(/^ {2}/gm, "");
  try { return new Function(`${deps}\n${body}\nreturn ${name};`)(); }
  catch { return null; }
}

const DOM = `
  const made = [];
  const mk = () => ({
    className: "", textContent: "", innerHTML: "", dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; }
  });
  const document = { createElement: () => mk() };
`;
const STUBS = `
  const current = { bucketCap: 5, dayCap: 10 };
  const stopRow = (stop) => ({ kind: "plan", code: stop.code, n: stop.stopNumber });
  const bookedRow = (b) => ({ kind: "booked", code: b.mapCode, n: b.stopNumber });
`;

const lifted = lift("bucketBlock", DOM + STUBS);
// A throw is a FINDING — the old block read day[bucket].length with no
// guard, so a booking-only day crashed it. Reported, not fatal.
const bucketBlock = typeof lifted === "function"
  ? (...a) => { try { return lifted(...a); } catch (err) { return { threw: err.message, children: [] }; } }
  : null;
ok("bucketBlock can still be read out of the page", typeof lifted === "function",
  "the function moved, was renamed, or no longer parses standalone");

if (bucketBlock) {
  // A day with plan stops in both halves and customer bookings in both.
  const day = {
    date: "2026-09-28",
    morning: [{ code: "P-1", stopNumber: 1 }, { code: "P-2", stopNumber: 3 }],
    afternoon: [{ code: "P-3", stopNumber: 5 }],
    booked: [
      { mapCode: "__bk:1", bucket: "morning", stopNumber: 2, customerName: "Morning Customer" },
      { mapCode: "__bk:2", bucket: "afternoon", stopNumber: 4, customerName: "Afternoon Customer" }
    ],
    timeline: []
  };

  const am = bucketBlock(day, "morning");
  const pm = bucketBlock(day, "afternoon");
  const headOf = (b) => b.threw || b.children[0]?.innerHTML || "";
  const countOf = (b) => b.threw || b.children[0]?.children[0]?.textContent || "";
  const rowsOf = (b) => (b.children[1]?.children) || [];

  // ---- 1. What the headings say ------------------------------------
  ok("the morning block is headed 'Morning Appointments'",
    /Morning Appointments/.test(headOf(am)), headOf(am));
  ok("the afternoon block is headed 'Afternoon Appointments'",
    /Afternoon Appointments/.test(headOf(pm)), headOf(pm));

  // ---- 2. A booking lands in ITS OWN half-day -------------------------
  const amRows = rowsOf(am);
  const pmRows = rowsOf(pm);
  ok("the morning holds its own booking, not the day's",
    amRows.filter((r) => r.kind === "booked").length === 1
    && amRows.find((r) => r.kind === "booked")?.code === "__bk:1",
    JSON.stringify(amRows));
  ok("…and the afternoon holds the afternoon one",
    pmRows.filter((r) => r.kind === "booked").length === 1
    && pmRows.find((r) => r.kind === "booked")?.code === "__bk:2",
    JSON.stringify(pmRows));
  ok("planned stops are still there beside them",
    amRows.filter((r) => r.kind === "plan").length === 2
    && pmRows.filter((r) => r.kind === "plan").length === 1,
    JSON.stringify([amRows.length, pmRows.length]));

  // ---- 3. One list, in driving order ----------------------------------
  // A booked customer reads as "stop 2 on this morning", not as a
  // floating extra below the plan.
  ok("the morning reads in driving order, planned and booked interleaved",
    amRows.map((r) => r.n).join(",") === "1,2,3", amRows.map((r) => `${r.kind}:${r.n}`).join(" "));

  // ---- 4. ONE load against ONE cap ------------------------------------
  ok("the morning counts planned + booked together", countOf(am) === "3 / 5", countOf(am));
  ok("…and so does the afternoon", countOf(pm) === "2 / 5", countOf(pm));

  // ---- 5. The empty state survives -------------------------------------
  const quiet = bucketBlock({ date: "2026-09-29", morning: [], afternoon: [], booked: [], timeline: [] }, "morning");
  ok("an empty half-day still says it is open",
    /Open — room for standby/.test(quiet.children[1]?.textContent || ""),
    JSON.stringify(quiet.children[1]?.textContent));

  // ---- 6. A booking-only day is not a special case ----------------------
  // It used to need its own block; now its bookings are simply the only
  // things in their half-days.
  const bookedOnly = bucketBlock({
    date: "2026-09-30", morning: undefined, afternoon: undefined,
    booked: [{ mapCode: "__bk:9", bucket: "morning", stopNumber: 1 }], timeline: []
  }, "morning");
  ok("a day with no plan at all still renders its bookings",
    !bookedOnly.threw && rowsOf(bookedOnly).length === 1 && rowsOf(bookedOnly)[0].kind === "booked",
    bookedOnly.threw ? `it threw: ${bookedOnly.threw}` : JSON.stringify(rowsOf(bookedOnly)));
  ok("…counted like any other", countOf(bookedOnly) === "1 / 5", countOf(bookedOnly));
}

// ---- 7. The rail: one number ------------------------------------------
// Read from source: the rail row is built inline against `current` and a
// live DOM, so what is pinned is that the "+N" idiom is gone and the
// combined load is what gets rendered and what decides "over".
{
  ok("the rail no longer renders a +N afterthought",
    !/is-bk">\+\$\{bookedN\}/.test(SRC) && !/\+\$\{bookedN\} booked/.test(SRC),
    "the +N markup is still in the page");
  ok("…it renders one combined load over the cap",
    /count\.innerHTML = `\$\{dayLoad\}\/\$\{current\.dayCap\}`/.test(SRC),
    "the single-number render is not there");
  ok("…and 'over capacity' is judged on that same number",
    (SRC.match(/\(day\.counts\.total \+ bookedN\) > current\.dayCap/g) || []).length >= 2,
    "the over-capacity test still ignores bookings");
  ok("the separate 'Booked appointments' block is gone",
    !/function bookedBlock\(/.test(SRC) && /function bookedRow\(/.test(SRC),
    "bookedBlock is still defined");
  ok("…and nothing still calls it", !/bookedBlock\(/.test(SRC));
}

if (failures.length) {
  console.error(`\n✗ test-season-plan-buckets: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-season-plan-buckets: ${pass} assertions passed`);

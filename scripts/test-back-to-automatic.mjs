#!/usr/bin/env node
// A hand-ordered day can be handed back.
//
//   node scripts/test-back-to-automatic.mjs      (also in build:check)
//
// "i've self arranged the day and theres no way to have it go back to the
// auto." — Patrick, Oct 14, 2026-10-06.
//
// He was right, and it had been true since the arrows shipped (2026-08-30).
// The Season Plan page draws "ordered by hand · Back to automatic" from
// `day.manualOrder` on the plan it is SENT. The store kept that fact, the
// sequencer honoured it, the route that clears it worked — and
// resolvePlanDay never put it on the day it sends. The page got the
// sequencer's flag ("Ordered by hand — the optimiser is not touching this
// day") and not the fact, so it printed the sentence and never the button.
//
// Every existing suite checked the STORE (plans.days[d].manualOrder) or the
// sequencer's flag. None asked the question the page asks. This one does,
// over HTTP, the way the page gets it:
//
//   1. an automatic day is sent as `manualOrder: false`
//   2. one arrow press and the same day is sent as `manualOrder: true`
//   3. that is the field the page's button is drawn from (read out of
//      season-plan.js, so a rename on either side fails here)
//   4. "Back to automatic" clears it, re-optimises, and says so in the
//      plan it answers with — which is what the page re-renders from
//   5. the fact and the flag can never answer differently for one day
//   6. ONE rule (seasonPlans.isHandOrdered) — nothing outside the store
//      tests the raw field any more
//
// Fails on the code before the fix: 1 and 2 get `undefined`.

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => String(JSON.stringify(v) ?? "(nothing)").slice(0, 260);

const SEASON = "fall", YEAR = 2026;
const HAND = "2026-10-14";   // the day that gets an arrow press
const AUTO = "2026-10-15";   // the day nobody touches
const BASE_PATH = `/api/season-plans/${SEASON}/${YEAR}`;

// Stops strung out due south of the yard, so the optimiser's order is not a
// coin-toss: nearest first, farthest last, then home.
let seq = 0;
function property(code, lat, lng = -79.46) {
  seq += 1;
  const address = `${100 + seq} Test St, Newmarket, ON L3Y 1A1, Canada`;
  return {
    id: `bta-prop-${String(seq).padStart(2, "0")}`, code,
    customerId: null,
    customerEmail: `${code.toLowerCase()}@example.com`,
    customerName: `Customer ${code}`,
    customerPhone: `9055550${String(100 + seq).slice(-3)}`,
    ownerHistory: [], history: [],
    address, addressNormalized: address.toLowerCase(),
    coords: { lat, lng, source: "google", formattedAddress: address },
    system: { zones: Array.from({ length: 4 }, (_, i) => ({ number: i + 1, location: `Zone ${i + 1}` })), zoneCount: null },
    leadIds: [], workOrderIds: [], deferredIssues: [], serviceRecords: [],
    seasonalEligibility: { springOpening: true, fallClosing: true },
    seasonalOutreach: {},
    commPrefs: { seasonalRemindersSMS: true, seasonalRemindersEmail: true, reviewRequestsEmail: true, noContactNeeded: false },
    deletedAt: null, archivedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z"
  };
}

const dayOf = (plan, date) => ((plan && plan.days) || []).find((d) => d && d.date === date) || null;
const codes = (day, bucket) => ((day && day[bucket]) || []).map((s) => s.code);
const flagged = (day) => ((day && day.flags) || []).some((f) => f && f.code === "manual_order");

const srv = await bootServer({ port: 4977 });
try {
  await srv.login();

  srv.writeData("properties", [
    property("H1", 44.00), property("H2", 43.96), property("H3", 43.92), property("H4", 43.88),
    property("A1", 44.00, -79.40), property("A2", 43.96, -79.40)
  ]);
  const put = await srv.api("PUT", BASE_PATH, {
    bucketCap: 5, dayCap: 10, source: "back-to-automatic fixture",
    days: {
      [HAND]: { label: "R8", morning: ["H1", "H2", "H3"], afternoon: ["H4"] },
      [AUTO]: { label: "R9", morning: ["A1", "A2"], afternoon: [] }
    }
  });
  if (put.status !== 200) throw new Error(`plan import failed: HTTP ${put.status} ${j(put.body)}`);

  // ---- 1. An automatic day says so ---------------------------------------
  const first = (await srv.api("GET", BASE_PATH)).body.plan;
  const hand0 = dayOf(first, HAND);
  const auto0 = dayOf(first, AUTO);
  ok(hand0 && auto0, `both days come back (${j((first?.days || []).map((d) => d.date))})`);
  ok(hand0 && hand0.manualOrder === false,
    `1. an untouched day is sent as manualOrder:false (got ${j(hand0?.manualOrder)})`);
  ok(auto0 && auto0.manualOrder === false,
    `1. …and so is the other one (got ${j(auto0?.manualOrder)})`);
  ok(!flagged(hand0) && !flagged(auto0), "1. …neither carries the 'Ordered by hand' flag");
  const optimised = codes(hand0, "morning");
  ok(optimised.length === 3, `the fixture's morning has three stops (${j(optimised)})`);

  // ---- 2. One arrow press, and the page is told ----------------------------
  const moved = optimised[1];
  const press = await srv.api("PATCH", `${BASE_PATH}/stop-order`,
    { date: HAND, bucket: "morning", propertyCode: moved, direction: "up" });
  ok(press.status === 200 && press.body.ok === true, `2. the arrow press is accepted (${press.status} ${j(press.body.errors)})`);
  const hand1 = dayOf(press.body.plan, HAND);
  ok(hand1 && hand1.manualOrder === true,
    `2. the plan the arrow answers with says manualOrder:true (got ${j(hand1?.manualOrder)})`);
  ok(codes(hand1, "morning")[0] === moved,
    `2. …and the stop is where it was put (${j(codes(hand1, "morning"))})`);
  ok(dayOf(press.body.plan, AUTO)?.manualOrder === false,
    "2. …the day nobody touched is still automatic");

  const reread = (await srv.api("GET", BASE_PATH)).body.plan;
  const hand2 = dayOf(reread, HAND);
  ok(hand2 && hand2.manualOrder === true,
    `2. a fresh page load is told the same (got ${j(hand2?.manualOrder)})`);
  ok(flagged(hand2), "2. …alongside the 'Ordered by hand' flag it always got");

  // ---- 3. It is the field the button is drawn from -------------------------
  const page = read("server/season-plan.js");
  const drawn = /if \(day\.(\w+)\) actions\.appendChild\(manualOrderNotice\(day\)\)/.exec(page);
  ok(drawn, "3. the page draws the notice from one field on the day");
  ok(drawn && hand2 && hand2[drawn[1]] === true,
    `3. …and that field (day.${drawn?.[1]}) is true on the hand-ordered day it is sent`);
  ok(drawn && auto0 && auto0[drawn[1]] === false,
    `3. …and false on the automatic one, so the button is not offered where it would do nothing`);
  const notice = page.slice(page.indexOf("function manualOrderNotice"), page.indexOf("function prettyDate"));
  ok(/textContent = "Back to automatic"/.test(notice) && /\/auto-order`/.test(notice)
    && /JSON\.stringify\(\{ date: day\.date \}\)/.test(notice) && /render\(data\.plan\)/.test(notice),
    "3. …the button says 'Back to automatic', PATCHes /auto-order for that date, and re-renders from the answer");

  // ---- 4. Back to automatic ------------------------------------------------
  const back = await srv.api("PATCH", `${BASE_PATH}/auto-order`, { date: HAND });
  ok(back.status === 200 && back.body.ok === true, `4. 'Back to automatic' is accepted (${back.status} ${j(back.body.errors)})`);
  const hand3 = dayOf(back.body.plan, HAND);
  ok(hand3 && hand3.manualOrder === false,
    `4. the plan it answers with says manualOrder:false — the button goes away (got ${j(hand3?.manualOrder)})`);
  ok(!flagged(hand3), "4. …and so does the 'Ordered by hand' line");
  ok(j(codes(hand3, "morning")) === j(optimised),
    `4. …and the day is re-optimised, not left as it was arranged (${j(codes(hand3, "morning"))} vs ${j(optimised)})`);
  const stored = (srv.data("season-plans")[`${SEASON}-${YEAR}`] || {}).days?.[HAND] || {};
  ok(!("manualOrder" in stored) && !("bookedOrder" in stored),
    `4. …nothing of the hand order is left in the store (${j(Object.keys(stored))})`);

  const again = await srv.api("PATCH", `${BASE_PATH}/auto-order`, { date: HAND });
  ok(again.status === 422 && /already optimised automatically/.test(j(again.body.errors)),
    `4. pressed on an automatic day it refuses, in words (${again.status} ${j(again.body.errors)})`);

  // ---- 5. The fact and the flag never disagree ------------------------------
  for (const [name, plan] of [["first load", first], ["after the arrow", press.body.plan], ["fresh load", reread], ["after back-to-automatic", back.body.plan]]) {
    const split = (plan?.days || []).filter((d) => d.manualOrder !== flagged(d));
    ok(split.length === 0, `5. ${name}: manualOrder agrees with the 'Ordered by hand' flag on every day (${j(split.map((d) => d.date))})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}`);
} finally {
  await srv.stop();
}

// ---- 6. One rule ------------------------------------------------------------
{
  const plans = require(path.join(ROOT, "server/lib/season-plans.js"));
  ok(typeof plans.isHandOrdered === "function", "6. season-plans exports isHandOrdered");
  const rule = plans.isHandOrdered || (() => undefined);
  ok(rule({ manualOrder: true }) === true && rule({}) === false && rule(null) === false && rule({ manualOrder: "yes" }) === false,
    "6. …true only for a day the store marked, false for anything else (a missing day included)");
  const offenders = [];
  const files = ["server/server.js", ...fs.readdirSync(path.join(ROOT, "server/lib"))
    .filter((f) => f.endsWith(".js") && f !== "season-plans.js").map((f) => `server/lib/${f}`)];
  for (const rel of files) {
    read(rel).split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/\.manualOrder\b/.test(code)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  ok(offenders.length === 0,
    `6. no server-side reader tests the raw field instead of asking the rule (${offenders.join(", ")})`);
}

console.log(`test-back-to-automatic: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-unplanned-routing.mjs
//
// Patrick, 2026-09-11, on the first cut of "Not on the plan":
//
//   "the only option it has for me is for me to choose the day that it sits
//    on. But it doesn't show me routing etc? our entire implementation of
//    this is so that we can efficiently have driving routes that make
//    sense."
//
// He was right. A day-picker with no drive times asks him to route by
// hand, which is the one job the system exists to do. This pins the fix:
//
//   1. rankDaysForPoint — one named rule that answers, for a property,
//      what the probe answers for a typed address: added drive against
//      every route day, cheapest first, and which one is BEST. The list,
//      the "best day" line and the place action all read it.
//   2. lighterBucket — one named rule for morning vs afternoon.
//   3. unplanned() carries the ranking on each row when given a ranker,
//      and stays correct (unranked, never wrong) without one.
//   4. The place route and the page use those rules and nothing else.
//
// Run: node scripts/test-unplanned-routing.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const geoFilter = require(path.join(ROOT, "server", "lib", "geo-filter.js"));
const assignments = require(path.join(ROOT, "server", "lib", "assignments.js"));

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

// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const rank = async (...a) => {
  if (typeof geoFilter.rankDaysForPoint !== "function") return { error: "(rankDaysForPoint is missing)" };
  try { return await geoFilter.rankDaysForPoint(...a); } catch (err) { return { error: err.message }; }
};
const bucket = (day) => (typeof assignments.lighterBucket === "function"
  ? assignments.lighterBucket(day) : "(lighterBucket is missing)");
const unplanned = async (...a) => {
  if (typeof assignments.unplanned !== "function") return { error: "(unplanned is missing)" };
  try { return await assignments.unplanned(...a); } catch (err) { return { error: err.message }; }
};

// Coordinates far enough apart that straight-line distance orders them
// unambiguously (the fast path in addedDriveMinutes is haversine-based).
const NEWMARKET = { lat: 44.056, lng: -79.461, source: "google" };
const shapes = {
  // A Newmarket day: the property is practically on the route.
  "2026-10-06": { label: "Newmarket", points: [{ lat: 44.05, lng: -79.46 }, { lat: 44.06, lng: -79.47 }], plannedCount: 2, bookedCount: 0 },
  // An Oshawa day: a real detour.
  "2026-10-07": { label: "Oshawa", points: [{ lat: 43.90, lng: -78.86 }, { lat: 43.92, lng: -78.85 }], plannedCount: 2, bookedCount: 0 },
  // An empty day: no shape, no opinion.
  "2026-10-08": { label: "Open", points: [], plannedCount: 0, bookedCount: 0 },
  // Yesterday: history, never an offer.
  "2026-09-01": { label: "Gone", points: [{ lat: 44.05, lng: -79.46 }], plannedCount: 1, bookedCount: 0 }
};
const OPTS = { threshold: 15, tiers: [25, 40], todayKey: "2026-09-12", base: { lat: 44.05, lng: -79.45 } };

// ---- 1. The ranking rule ---------------------------------------------
{
  const r = await rank(NEWMARKET, shapes, OPTS);
  ok("a property with real coordinates can be ranked", r?.rankable === true, r?.error || j(r));
  const dates = (r?.days || []).map((d) => d.date);
  ok("yesterday is not on the list", !dates.includes("2026-09-01"), j(dates));
  ok("the cheapest day reads FIRST", dates[0] === "2026-10-06", j(dates));
  ok("…and the detour reads after it",
    dates.indexOf("2026-10-07") > dates.indexOf("2026-10-06"), j(dates));

  const nm = (r?.days || []).find((d) => d.date === "2026-10-06");
  const os = (r?.days || []).find((d) => d.date === "2026-10-07");
  ok("the nearby day costs less than the far one",
    nm && os && nm.addedDriveMinutes != null && os.addedDriveMinutes != null && nm.addedDriveMinutes < os.addedDriveMinutes,
    j({ nm: nm?.addedDriveMinutes, os: os?.addedDriveMinutes }));
  ok("each day carries its label and stop count for the row to show",
    nm?.label === "Newmarket" && nm?.points === 2, j(nm));

  ok("BEST is the cheapest offered day that has stops on it",
    r?.best?.date === "2026-10-06", j(r?.best));
  // An empty day at +0 is a blank calendar, not "we're already nearby".
  ok("…never an empty day, even though an empty day costs nothing",
    r?.best?.date !== "2026-10-08", j(r?.best));
  const empty = (r?.days || []).find((d) => d.date === "2026-10-08");
  ok("an empty day is still LISTED, offered, at no cost",
    empty && empty.offered === true && empty.addedDriveMinutes === 0, j(empty));
}

// ---- 2. The allowance, and what lies past it -------------------------
{
  // A threshold small enough that the far day is over it.
  const r = await rank(NEWMARKET, shapes, { ...OPTS, threshold: 1 });
  const os = (r?.days || []).find((d) => d.date === "2026-10-07");
  ok("a day over the drive allowance is NOT offered", os && os.offered === false, j(os));
  ok("…but says which widening tier would admit it, or that none would",
    os && ("widensAtMinutes" in os), j(os));
  // With nothing offered that has stops, there is no best — say so
  // rather than pick a bad one.
  const none = await rank(NEWMARKET, {
    "2026-10-07": shapes["2026-10-07"]
  }, { ...OPTS, threshold: 1 });
  ok("no offered day with stops → no best, rather than a bad guess",
    none?.rankable === true && none?.best === null, j(none?.best));
}

// ---- 3. What can't be measured is said, not guessed ------------------
{
  const noCoords = await rank(null, shapes, OPTS);
  ok("no coordinates → not rankable", noCoords?.rankable === false, j(noCoords));
  ok("…and no best is invented", noCoords?.best === null, j(noCoords?.best));
  ok("…but the days are still listed, so a hand pick is possible",
    Array.isArray(noCoords?.days) && noCoords.days.length === 3, j(noCoords?.days?.length));

  // The depot fallback would measure the customer as if they lived at
  // the shop — every day would look cheap. That is the one coordinate
  // that must never rank.
  const depot = await rank({ lat: 44.05, lng: -79.45, source: "pjl-base" }, shapes, OPTS);
  ok("the depot fallback is refused as a ranking point", depot?.rankable === false, j(depot));
}

// ---- 4. Which bucket --------------------------------------------------
{
  ok("the lighter bucket wins", bucket({ morning: ["a", "b"], afternoon: ["c"] }) === "afternoon", j(bucket({ morning: ["a", "b"], afternoon: ["c"] })));
  ok("…and morning on a tie", bucket({ morning: ["a"], afternoon: ["b"] }) === "morning", j(bucket({ morning: ["a"], afternoon: ["b"] })));
  ok("…and morning on an empty day", bucket({ morning: [], afternoon: [] }) === "morning", j(bucket({})));
  ok("a day the plan doesn't have yet answers rather than throwing", bucket(undefined) === "morning", j(bucket(undefined)));
}

// ---- 5. The unplanned list carries the ranking ------------------------
{
  const props = [
    { id: "prop-near", code: "P-NEAR", customerName: "Near", address: "1 Near St", coords: NEWMARKET, system: { zones: [1, 2] } },
    { id: "prop-nocoords", code: "P-NOCO", customerName: "Nowhere", address: "2 Lost Rd", system: { zones: [1] } },
    { id: "prop-on", code: "P-ON", customerName: "On Plan", address: "3 A St", coords: NEWMARKET }
  ];
  const deps = {
    getPlan: async () => ({ days: { "2026-10-06": { morning: ["P-ON"], afternoon: [] } } }),
    listProperties: async () => props,
    listBookings: async () => [],
    assessEligibility: async (p) => ({ ok: true, customerName: p.customerName, portalToken: "t" }),
    rankDays: async (property) => geoFilter.rankDaysForPoint(property.coords, shapes, OPTS)
  };
  const r = await unplanned("fall", 2026, deps);
  ok("the list answers with a ranker", r?.ok === true, r?.error || j(r));
  const near = (r?.placeable || []).find((x) => x.code === "P-NEAR");
  ok("a rankable row carries its best day", near?.rankable === true && near?.best?.date === "2026-10-06", j(near?.best));
  ok("…and its days, cheapest first", Array.isArray(near?.days) && near.days[0]?.date === "2026-10-06", j(near?.days?.map?.((d) => d.date)));
  const lost = (r?.placeable || []).find((x) => x.code === "P-NOCO");
  ok("a row with no coordinates is still LISTED", Boolean(lost), j(r?.placeable?.map?.((x) => x.code)));
  ok("…marked unrankable, with no invented best", lost?.rankable === false && lost?.best === null, j(lost));

  // A ranker that blows up on one property must not take the list down.
  const boom = await unplanned("fall", 2026, {
    ...deps,
    rankDays: async (p) => { if (p.code === "P-NEAR") throw new Error("google down"); return { rankable: false, days: [], best: null }; }
  });
  const hurt = (boom?.placeable || []).find((x) => x.code === "P-NEAR");
  ok("a ranking failure is reported on the row, not thrown at the page",
    boom?.ok === true && hurt?.rankable === false && /google down/.test(hurt?.rankError || ""), j(hurt));

  // Without a ranker the list is exactly what it was — unranked, not wrong.
  const plain = await unplanned("fall", 2026, { ...deps, rankDays: undefined });
  const p = (plain?.placeable || []).find((x) => x.code === "P-NEAR");
  ok("no ranker → rows are unranked, and nothing pretends otherwise",
    plain?.ok === true && p && !("best" in p), j(p));
}

// ---- 6. The wiring: the route and the page use the rules ---------------
{
  const server = read("server/server.js");
  ok("the unplanned route ranks through the one rule",
    /geoFilter\.rankDaysForPoint\(/.test(server), "the route ranks some other way");
  ok("…building the day shapes ONCE per request, not per property",
    /async function unplannedRanker\(/.test(server) && /buildDayShapes\(\{ plan, propertiesByCode: byCode, bookings: active \}\);\s*const rankDays/.test(server),
    "shapes are rebuilt per property");
  ok("…and geocodes a property with no stored coordinates through the cached path",
    /coordsAreResolved\(coords\) && property\.address[\s\S]{0,80}geocodeForRecord\(property\.address\)/.test(server),
    "an un-geocoded property can't be ranked at all");
  ok("there is a place-on-best route",
    /unplanned\\\/place\$\//.test(server), "no place route");
  ok("…that chooses the day by the ranking and the bucket by the one rule",
    /row\.best\.date/.test(server) && /assignments\.lighterBucket\(/.test(server), "the place route routes its own way");
  ok("…re-reading the plan per stop so two properties see each other",
    /for \(const row of targets\)[\s\S]{0,300}await seasonPlans\.getPlan\(season, year\)/.test(server),
    "the second stop can't see the first");
  ok("…adding through addStop, the one write path",
    /unplanned\\\/place[\s\S]{0,2500}seasonPlans\.addStop\(/.test(server), "the place route writes the plan some other way");
  ok("…resequencing ONCE at the end",
    /if \(placed\) \{\s*const stored = await seasonPlans\.getPlan/.test(server), "resequence isn't gated on having placed anything");
  ok("…and never guessing for a property it can't rank",
    /reason: row\.rankable \? "no_offered_day" : "unrankable"/.test(server), "an unrankable property would be placed anyway");

  const page = read("server/season-plan.js");
  ok("the row shows the best day and its cost",
    /Best: \$\{prettyDate\(row\.best\.date\)\}/.test(page) && /\+\$\{row\.best\.addedDriveMinutes\} min/.test(page),
    "no best-day line on the row");
  ok("…and says plainly when it can't rank, instead of a bare picker",
    /no coordinates Google will resolve/.test(page), "an unrankable row looks like every other row");
  ok("the picker's options are in ROUTING order with their cost",
    /function dayPickerFor\(row, ranked\)/.test(page) && /\+\$\{cost\.addedDriveMinutes\} min/.test(page),
    "the picker is still a blind calendar");
  // 2026-09-12: the per-row blind "Place on best day" became "See it on
  // the best day" — the map with the stop on it, then his decision.
  // scripts/test-day-map-preview.mjs pins that flow.
  ok("there is a see-it-on-the-best-day button per row",
    /See it on the best day/.test(page) && /openPreview\(row, date, null\)/.test(page), "no per-row preview button");
  ok("…and one for the lot, armed twice like every send on this page",
    /armTwice\(el\("unplannedPlaceAll"\)/.test(page) && /placeOnBest\("all"/.test(page), "no place-all, or it fires on one press");

  const html = read("server/season-plan.html");
  ok("the drawer has the place-all button", /id="unplannedPlaceAll"/.test(html), "button missing from the markup");
}

if (failures.length) {
  console.error(`\n✗ test-unplanned-routing: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-unplanned-routing: ${pass} assertions passed`);

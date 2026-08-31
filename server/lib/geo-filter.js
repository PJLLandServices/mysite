// Geography filter — "is this address cheap or expensive to insert into
// this particular day?"
//
// This is NOT the corridor math. availability.js already asks whether a
// slot is *reachable* from the previous job and *reaches* the next one:
// a feasibility question, answered against whatever happens to be booked.
// This module asks a cost question — how much extra driving does serving
// this house on this day add to the route — and answers it against the
// day's intended shape, which the season plan supplies before anyone
// books.
//
// THE NUMBER THAT MAKES IT WORK. Measured across the 65 fall-2026
// properties against the 11 planned route days, a property that belongs
// on its day inserts for a median 3.1 min; a property that belongs on a
// different day costs a median 33.6 min. Ten to one. There is no
// threshold-tuning problem here, which is why a single cut at 15 minutes
// is defensible and why no radius check is needed — R5 legitimately spans
// Etobicoke to Acton, 40 km, and cheapest-insertion handles that shape
// correctly on its own where a radius would break it.
//
// COST MODEL. The day is a round trip from base and back:
//
//     base -> stop1 -> stop2 -> ... -> stopN -> base
//
// Inserting candidate C between adjacent points a and b costs
//
//     travel(a, C) + travel(C, b) - travel(a, b)
//
// and the day's added drive is the cheapest such position. An empty day
// costs 0 by definition — there is no shape to violate, so the date is
// offered normally.
//
// TWO-PASS, ON PURPOSE, FOR COST. Ranking every insertion position with
// Google Distance Matrix would bill three elements per position per day
// per address. So positions are ranked with the straight-line estimator
// (free), and only the winning position is re-measured with the real
// travelMinutes(). The ranking is a coarse judgement — which gap does
// this house fall into — and survives the approximation comfortably at a
// 10:1 separation; the number that actually decides the cut is the real
// one. Set `exact: true` to measure every position, which the test
// harness does.

const { travelMinutes, estimateMinutes } = require("./distance");
const { PJL_BASE } = require("./geocode");
const { routeOrigin } = require("./route-origin");

// Two points this close are the same stop for routing purposes. Same
// rounding the distance cache uses (~11 m), so a planned property and
// that property's own booking collapse to one point in the day's shape
// instead of being counted as two houses on the same driveway.
function pointKey(p) {
  return `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`;
}

function usable(p) {
  return Boolean(p) && p.lat != null && p.lng != null
    && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

// A geocode that failed falls back to the PJL depot (geocode.js returns
// coords: PJL_BASE with source "pjl-base"). Filtering on that would
// measure the customer as if they lived at the shop — every day would
// look cheap, and the filter would quietly pass everyone. So an
// unresolved address skips the filter entirely and gets normal
// availability. Invariant 5: a failure never blocks a booking.
function coordsAreResolved(coords) {
  return usable(coords) && coords.source !== "pjl-base";
}

// Build the point set for every planned route day.
//
//   plan              a season plan (season-plans.js shape), or null
//   propertiesByCode  Map "P-2026-0003" -> live property record
//   bookings          [{ start, coords, propertyId }] already active-only
//
// Returns { "YYYY-MM-DD": { points, plannedCount, bookedCount, unresolved } }
// where `unresolved` names planned codes with no live property or no
// coordinates — surfaced on the review screen rather than dropped, so a
// merged-away or un-geocoded property is visible instead of silently
// shrinking the day's shape.
function buildDayShapes({ plan, propertiesByCode, bookings = [] } = {}) {
  const shapes = {};
  if (!plan || !plan.days) return shapes;

  const byCode = propertiesByCode instanceof Map
    ? propertiesByCode
    : new Map(Object.entries(propertiesByCode || {}));

  for (const [dateKey, day] of Object.entries(plan.days)) {
    const points = [];
    const index = new Set();
    const unresolved = [];

    for (const code of [...(day.morning || []), ...(day.afternoon || [])]) {
      const property = byCode.get(code);
      if (!property) { unresolved.push({ code, reason: "no_such_property" }); continue; }
      if (!usable(property.coords)) { unresolved.push({ code, reason: "no_coordinates" }); continue; }
      const key = pointKey(property.coords);
      if (index.has(key)) continue;
      index.add(key);
      points.push({
        lat: Number(property.coords.lat),
        lng: Number(property.coords.lng),
        source: "planned",
        label: code
      });
    }
    const plannedCount = points.length;

    // Per-bucket load, for capacity enforcement (stage 1 of
    // docs/ASSIGNMENT_WRITER.md). Two different numbers on purpose:
    //
    //   count — EVERY planned code in the bucket, resolved or not. An
    //           unresolved stop is still a job Patrick will spend time on;
    //           capacity is about his day, not about geocoding luck.
    //   keys  — pointKeys of the RESOLVED stops only, so availability can
    //           tell "a planned customer's own booking" (same rounded
    //           coordinate — does not add load) from a new customer's
    //           booking (does). The same 4-decimal rounding the shape's
    //           own dedup uses, so the two rules cannot disagree.
    const buckets = {};
    for (const bucketName of ["morning", "afternoon"]) {
      const codes = day[bucketName] || [];
      const keys = [];
      for (const code of codes) {
        const property = byCode.get(code);
        if (property && usable(property.coords)) keys.push(pointKey(property.coords));
      }
      buckets[bucketName] = { count: codes.length, keys };
    }

    // Real bookings already on this date join the same shape. A booking
    // whose coordinates resolve to the depot carries no geography (it is
    // an unresolved address, not a stop at the shop) and is skipped
    // rather than dragging the day's centre of mass to Newmarket.
    for (const booking of bookings) {
      if (!booking || !booking.start) continue;
      if (localDateKey(new Date(booking.start)) !== dateKey) continue;
      if (!coordsAreResolved(booking.coords)) continue;
      const key = pointKey(booking.coords);
      if (index.has(key)) continue;
      index.add(key);
      points.push({
        lat: Number(booking.coords.lat),
        lng: Number(booking.coords.lng),
        source: "booked",
        label: booking.propertyId || booking.leadId || "booking"
      });
    }

    shapes[dateKey] = {
      bucketCap: Number(plan.bucketCap) > 0 ? Number(plan.bucketCap) : null,
      buckets,
      label: day.label || "",
      points,
      plannedCount,
      bookedCount: points.length - plannedCount,
      unresolved
    };
  }
  return shapes;
}

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Cheapest-insertion added drive, in minutes.
//
// Returns { minutes, position, positions } — or null when the candidate
// has no usable coordinates, which callers must read as "skip the filter"
// rather than "refuse".
async function addedDriveMinutes(candidate, points, opts = {}) {
  const { exact = false } = opts;
  if (!usable(candidate)) return null;
  // The day is a round trip from the yard. Measuring it from the geocode
  // fallback instead shifts every insertion cost by however far the yard
  // is from the middle of town.
  const base = opts.base || await routeOrigin();
  const stops = (points || []).filter(usable);
  if (!stops.length) return { minutes: 0, position: 0, positions: 0, emptyDay: true };

  const route = [base, ...stops, base];
  const gaps = route.length - 1;

  if (exact) {
    let best = { minutes: Infinity, position: 0 };
    for (let i = 0; i < gaps; i++) {
      const [ac, cb, ab] = await Promise.all([
        travelMinutes(route[i], candidate),
        travelMinutes(candidate, route[i + 1]),
        travelMinutes(route[i], route[i + 1])
      ]);
      const minutes = Math.max(0, ac + cb - ab);
      if (minutes < best.minutes) best = { minutes, position: i };
    }
    return { minutes: Math.round(best.minutes), position: best.position, positions: gaps, emptyDay: false };
  }

  // Pass 1 — rank every gap with the free estimator.
  let bestIndex = 0;
  let bestEstimate = Infinity;
  for (let i = 0; i < gaps; i++) {
    const estimate = estimateMinutes(route[i], candidate)
      + estimateMinutes(candidate, route[i + 1])
      - estimateMinutes(route[i], route[i + 1]);
    if (estimate < bestEstimate) { bestEstimate = estimate; bestIndex = i; }
  }

  // Pass 2 — measure the winner for real.
  const a = route[bestIndex];
  const b = route[bestIndex + 1];
  const [ac, cb, ab] = await Promise.all([
    travelMinutes(a, candidate),
    travelMinutes(candidate, b),
    travelMinutes(a, b)
  ]);
  return {
    minutes: Math.max(0, Math.round(ac + cb - ab)),
    position: bestIndex,
    positions: gaps,
    emptyDay: false
  };
}

module.exports = {
  buildDayShapes,
  addedDriveMinutes,
  coordsAreResolved,
  pointKey,
  localDateKey
};

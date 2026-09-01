// Re-sequencer — put a route day's stops in a sensible driving order, and
// say when the day does not fit.
//
// WHY. Buckets are what the customer is told: "Tuesday, morning". The
// order INSIDE a bucket is never communicated, which makes it free to
// change — and that freedom is the whole reason the bucket abstraction
// earns its keep. So whenever a day's stop set changes, the order should
// be recomputed rather than left wherever the last edit happened to put
// it. Hand-placing stops one at a time does not produce a good day: it
// produced an R1 that drove to one corner of Newmarket in the morning and
// came back to the same corner in the afternoon, 0.7 km from where it had
// already been.
//
// THE TWO RULES THAT ARE NOT NEGOTIABLE (spec §6):
//
//   1. Reorder WITHIN a bucket freely. Never move a stop ACROSS buckets.
//      A customer told "morning" must still be morning. Only that
//      customer's own request moves them, and this function never does.
//
//   2. The morning sub-route must finish before 12:00. If no ordering
//      achieves that, FLAG the day for Patrick rather than silently
//      handing him an overrun. A plan that quietly runs late is worse
//      than one that admits it cannot fit.
//
// REAL DRIVE TIMES, NOT ESTIMATES. The ordering search runs off a
// precomputed matrix built with distance.js's travelMinutes(), which uses
// Google Distance Matrix where configured. The straight-line estimator is
// deliberately NOT used here: it floors every trip at MIN_TRAVEL_MINUTES
// and reads a 0.7 km hop the same as a 3 km one, so it is blind at
// exactly the neighbourhood scale this function is trying to get right.
// The matrix is (n+1)^2 lookups for a day, disk-cached by coordinate
// pair, so a re-sequence is expensive once and free thereafter. This runs
// at plan time — on import and on a move — never on a customer's booking
// request, so the cost lands where a second of latency does not matter.
//
// NO BUFFER. Patrick's call: the plan's clock is the truth, and the
// engine's bufferMinutes is slack he does not want spent on his own
// planned route. Timings here are drive + on-site only. The engine still
// applies its cushion to anyone booking INTO the day, which is where the
// margin is actually wanted.

const { travelMinutes, travelMinutesRaw, haversineKm, MIN_TRAVEL_MINUTES } = require("./distance");
const { PJL_BASE } = require("./geocode");
const { routeOrigin } = require("./route-origin");
const { BOOKABLE_SERVICES, BOOKING_BUCKETS, parseHHmmToMinutes, minutesToHHmm } = require("./availability");
const { deriveSeasonalKey, effectiveZoneCount } = require("./pricing");

const BUCKETS = ["morning", "afternoon"];

// Above this many stops in one bucket, an exhaustive search stops being
// free (8! = 40320) and we fall back to nearest-neighbour + 2-opt, which
// is within a couple of percent on route shapes this small. The bucket
// cap is 5, so the exact path is what actually runs.
const EXACT_SEARCH_LIMIT = 7;

// TWO CLOCKS, ON PURPOSE.
//
// distance.js floors every trip at MIN_TRAVEL_MINUTES because no visit is
// really shorter than five minutes: parking, unloading, a door. That is
// right for building a schedule and wrong for choosing a route. Under the
// floor, 100 and 106 Lavery Trail (40 m apart) and 748 Morrish Rd (1 km)
// all cost "5 minutes" — so the optimiser cannot see the difference, and
// the flooring shifts whole candidate orders against each other by whole
// minutes. Live, that put Morrish between two neighbours.
//
// A first attempt added a vanishing distance weight to break ties. It was
// not enough and the arithmetic says why: across a day's route the weight
// is worth about 0.004 of a minute, so it can settle an exact tie and
// nothing more. The distortion it needed to beat is measured in minutes.
//
// So ordering runs on travelMinutesRaw() — the unfloored road time — and
// the clock the operator reads is built from travelMinutes(), floored.
// The distance weight stays, now doing only the job it can actually do:
// separating two orders whose raw times are genuinely identical.
const DISTANCE_TIEBREAK_PER_KM = 0.001;

function bucketWindow(key) {
  const b = BOOKING_BUCKETS.find((x) => x.key === key);
  return b ? { from: parseHHmmToMinutes(b.from), to: parseHHmmToMinutes(b.to) } : null;
}

// On-site minutes for a property, from its zone count through the same
// tier table the booking engine and the pricing module use. Documented
// zones win, a declared count (the customer's own number) fills in when
// nothing is mapped — pricing.effectiveZoneCount, the same rule the
// assignment writer books by. A property with no count at all falls to
// the lowest tier — which understates a big system, and is why the plan
// screen marks those stops as estimated.
function onSiteMinutes(property, season) {
  const woType = season === "spring" ? "spring_opening" : "fall_closing";
  const zones = effectiveZoneCount(property);
  const commercial = property?.billingEntity?.accountType === "commercial";
  const key = deriveSeasonalKey(woType, zones, commercial);
  const service = key ? BOOKABLE_SERVICES[key] : null;
  return {
    minutes: service ? service.minutes : 30,
    serviceKey: key || null,
    zones: zones || null,
    estimated: zones === 0
  };
}

// Travel-time matrix over [base, ...stops]. Index 0 is always base.
//
// Two matrices come back deliberately:
//   minutes  what the operator is told — unmodified travel times
//   cost     the same, plus the distance tiebreak, used ONLY to compare
//            candidate orders
// Keeping them apart means the tiebreak can never leak into a displayed
// arrival time.
async function buildMatrix(points, travel, travelRaw) {
  const n = points.length;
  const minutes = Array.from({ length: n }, () => new Array(n).fill(0));
  const cost = Array.from({ length: n }, () => new Array(n).fill(0));
  const jobs = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      jobs.push(travel(points[i], points[j]).then((v) => { minutes[i][j] = v; }));
      jobs.push(travelRaw(points[i], points[j]).then((v) => {
        cost[i][j] = v + haversineKm(points[i], points[j]) * DISTANCE_TIEBREAK_PER_KM;
      }));
    }
  }
  await Promise.all(jobs);
  return { minutes, cost };
}

// Cheapest whole day: base -> morning in order -> afternoon in order ->
// base, searched JOINTLY.
//
// It used to optimise the morning first, open-ended, then the afternoon
// from wherever the morning happened to finish. That is greedy in the
// worst place: a morning free to end anywhere ends wherever its own last
// leg is cheapest, with no idea it must hand off to the afternoon. Live,
// R10's morning ran out to Pickering and the afternoon came back west to
// Scarborough — a round trip bolted onto the end of the day.
//
// At a bucket cap of 5 the joint search is 5! x 5! = 14,400 orders of
// pure arithmetic over a precomputed matrix, so there is no reason to be
// greedy about it. The two-stage path stays for buckets too large to
// enumerate, which the cap does not currently allow.
//
// FINISH CLOSEST TO HOME — the second objective, and why it is needed.
//
// On a tight cluster the first objective says almost nothing. Every order
// of R1's four south-Newmarket stops came out within 0.1 km of every
// other, so "fewest kilometres" was choosing between them on rounding
// noise, and the day ended wherever that noise landed. Total driving is
// simply not a fine enough instrument to shape a day like that.
//
// Patrick's rule, asked and answered: when the driving is a wash, finish
// nearest home. So the search is lexicographic with a tolerance — take
// the cheapest total, then among every order within TOLERANCE of it,
// prefer the one whose last stop is closest to base. Inside the tolerance
// the choice becomes deliberate instead of arbitrary; outside it, a
// genuinely shorter route still wins and the truck takes the longer
// drive home.
// Time windows on a stop: "not before 10:00", "not after 12:30".
//
// The optimiser can see driving minutes and nothing else. A locked gate, a
// customer who is out until one, a north slope better done before the frost
// lifts — none of that is visible to it, and this is how it gets in.
//
// SOFT, NOT REFUSED. When a window cannot be met the day is still sequenced
// and the miss is flagged. A refusal would leave the day unsequenced, which
// is worse than a day that runs with one visible problem on it.
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseWindow(value) {
  if (typeof value !== "string") return null;
  const m = WINDOW_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// { code -> {notBefore, notAfter} } in minutes, dropping anything unparseable
// rather than silently treating it as no constraint at all.
function windowsFor(day) {
  const out = new Map();
  const src = day && day.constraints;
  if (!src || typeof src !== "object") return out;
  for (const [code, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== "object") continue;
    const notBefore = parseWindow(raw.notBefore);
    const notAfter = parseWindow(raw.notAfter);
    if (notBefore == null && notAfter == null) continue;
    out.set(code, { notBefore, notAfter });
  }
  return out;
}

const FINISH_NEAR_BASE_TOLERANCE_MINUTES = 3;

function bestDayOrder(cost, morningIdx, afternoonIdx) {
  if (morningIdx.length <= EXACT_SEARCH_LIMIT && afternoonIdx.length <= EXACT_SEARCH_LIMIT) {
    const mornings = permutations(morningIdx);
    const afternoons = permutations(afternoonIdx);

    let minCost = Infinity;
    for (const m of mornings) {
      for (const a of afternoons) {
        const c = pathCost(cost, 0, [...m, ...a], 0);
        if (c < minCost) minCost = c;
      }
    }

    const ceiling = minCost + FINISH_NEAR_BASE_TOLERANCE_MINUTES;
    let best = { morning: morningIdx, afternoon: afternoonIdx };
    let bestFinalLeg = Infinity;
    let bestCost = Infinity;
    for (const m of mornings) {
      for (const a of afternoons) {
        const seq = [...m, ...a];
        const c = pathCost(cost, 0, seq, 0);
        if (c > ceiling) continue;
        const finalLeg = seq.length ? cost[seq[seq.length - 1]][0] : 0;
        // Nearest finish wins; a tie on that falls back to the cheaper
        // total, so the result is fully determined rather than order-of-
        // enumeration dependent.
        if (finalLeg < bestFinalLeg - 1e-9
          || (Math.abs(finalLeg - bestFinalLeg) < 1e-9 && c < bestCost)) {
          bestFinalLeg = finalLeg;
          bestCost = c;
          best = { morning: m, afternoon: a };
        }
      }
    }
    return best;
  }
  const morning = bestOrder(cost, 0, morningIdx, null);
  const exit = morning.length ? morning[morning.length - 1] : 0;
  return { morning, afternoon: bestOrder(cost, exit, afternoonIdx, 0) };
}

// Choose an order when at least one stop has a time window.
//
// LEXICOGRAPHIC, and the priority order is the whole design:
//
//   1. fewest missed "not after" times   — a missed window is a job not done
//   2. least waiting                     — waiting is unpaid time in a truck
//   3. least driving                     — the old objective, now third
//   4. finishing nearest the yard        — the existing tiebreak, kept
//
// Driving drops to third deliberately. An order that saves four minutes of
// driving and arrives after a gate is locked has not saved anything.
//
// Every candidate is scored by walking the real clock, the same walk that
// produces the printed timeline — so the order chosen and the times shown
// can never come from different arithmetic.
function bestConstrainedOrder(walk, morningIdx, afternoonIdx, cost) {
  let best = null;
  let bestScore = null;
  for (const m of permutations(morningIdx)) {
    for (const a of permutations(afternoonIdx)) {
      const run = walk(m, a);
      const seq = [...m, ...a];
      const score = [
        run.misses.length,
        run.waitedMinutes,
        run.driveMinutes + (seq.length ? cost[seq[seq.length - 1]][0] : 0),
        seq.length ? cost[seq[seq.length - 1]][0] : 0
      ];
      if (bestScore === null || betterScore(score, bestScore)) {
        bestScore = score;
        best = { morning: m, afternoon: a };
      }
    }
  }
  return best || { morning: morningIdx, afternoon: afternoonIdx };
}

// Strictly-better on the first component that differs. A plain < on each in
// turn would let a later component override an earlier one.
function betterScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true;
    if (a[i] > b[i] + 1e-9) return false;
  }
  return false;
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items];
    const [head] = rest.splice(i, 1);
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

function pathCost(matrix, from, order, to) {
  let total = 0;
  let at = from;
  for (const idx of order) { total += matrix[at][idx]; at = idx; }
  if (to != null) total += matrix[at][to];
  return total;
}

// Cheapest order for one bucket, entering from `from` and leaving to `to`.
// Exhaustive while that is cheap; nearest-neighbour + 2-opt above the
// limit, which never happens at a bucket cap of 5 but keeps the function
// honest if the cap is ever raised.
function bestOrder(matrix, from, indices, to) {
  if (indices.length <= 1) return [...indices];
  if (indices.length <= EXACT_SEARCH_LIMIT) {
    let best = null;
    let bestCost = Infinity;
    for (const order of permutations(indices)) {
      const cost = pathCost(matrix, from, order, to);
      if (cost < bestCost) { bestCost = cost; best = order; }
    }
    return best;
  }
  const remaining = new Set(indices);
  const order = [];
  let at = from;
  while (remaining.size) {
    let pick = null;
    let pickCost = Infinity;
    for (const idx of remaining) {
      if (matrix[at][idx] < pickCost) { pickCost = matrix[at][idx]; pick = idx; }
    }
    order.push(pick); remaining.delete(pick); at = pick;
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (pathCost(matrix, from, candidate, to) < pathCost(matrix, from, order, to) - 1e-9) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return order;
}

// Re-sequence one route day.
//
//   day               { label, morning: [code], afternoon: [code] }
//   propertiesByCode  Map code -> live property record
//   season            "spring" | "fall"
//   travel            injectable for tests; defaults to real drive times
//
// Returns the day with each bucket reordered, plus a timeline of arrival
// estimates (admin-facing only — customers never see a minute) and any
// flags the plan screen should show.
async function sequenceDay(day, opts = {}) {
  const { propertiesByCode, season = "fall", travel = travelMinutes } = opts;
  // The yard, not the geocode fallback. PJL_BASE means "we do not know
  // where this is"; anchoring a route to it pointed every day at the
  // middle of Newmarket. Callers may still pass an explicit base — tests
  // do, so their fixtures stay exact.
  const base = opts.base || await routeOrigin();
  // A test that injects a travel function gets the same function for the
  // ordering clock unless it says otherwise, so its fixtures stay exact.
  const travelRaw = opts.travelRaw || (opts.travel ? opts.travel : travelMinutesRaw);
  const byCode = propertiesByCode instanceof Map ? propertiesByCode : new Map(Object.entries(propertiesByCode || {}));
  const flags = [];

  // Only stops we can actually route participate in the ordering. Anything
  // without coordinates keeps its place at the end of its bucket and is
  // flagged: dropping it would quietly shrink the day.
  const routable = {};
  const unroutable = {};
  for (const bucket of BUCKETS) {
    routable[bucket] = [];
    unroutable[bucket] = [];
    for (const code of day[bucket] || []) {
      const property = byCode.get(code);
      if (property && property.coords && property.coords.lat != null) routable[bucket].push({ code, property });
      else {
        unroutable[bucket].push(code);
        flags.push({
          code: "unroutable_stop", bucket, propertyCode: code,
          message: `${code} has no coordinates — left in place and excluded from sequencing.`
        });
      }
    }
  }

  const stops = [...routable.morning, ...routable.afternoon];
  const points = [base, ...stops.map((s) => s.property.coords)];
  const { minutes: matrix, cost } = await buildMatrix(points, travel, travelRaw);
  const indexOf = new Map(stops.map((s, i) => [s.code, i + 1]));   // +1: base is 0

  const morningIdx = routable.morning.map((s) => indexOf.get(s.code));
  const afternoonIdx = routable.afternoon.map((s) => indexOf.get(s.code));

  // MANUAL ORDER. Patrick knows things the optimiser cannot: who is not
  // home before ten, which gate is locked until nine, which north slope is
  // better done before the frost comes off. When he has hand-ordered a day
  // the stored order IS the route, so the search is skipped entirely and
  // the clock is walked over the order as written.
  //
  // It is skipped, not overridden afterwards, because re-optimising and
  // then reapplying his order would compute the timings against a
  // different sequence from the one printed.
  //
  // Everything else still runs: the day is still timed, the noon rule is
  // still checked, and an overrun is still flagged. A manual day is not an
  // unchecked day — it is an unoptimised one.
  const manual = Boolean(day.manualOrder);

  // Walk the clock ONCE, here, and let the search call the same function to
  // score candidates. Two implementations of "when does this day happen" is
  // how the screen ends up printing times the route does not produce — the
  // SEQ-02 lesson, in the module that taught it.
  const windows = { morning: bucketWindow("morning"), afternoon: bucketWindow("afternoon") };

  // THE CUSTOMER SEAM, deliberately built now and unused today.
  //
  // Patrick sets windows on the plan (day.constraints). A customer booking
  // through the pool has no way to ask for one yet — that flow does not
  // exist. When it does, whoever builds it passes the requested windows in
  // here as { code -> {notBefore, notAfter} } and they merge on top of the
  // plan's own, without this module or the plan store changing shape.
  //
  // The customer's request wins over the plan's default on purpose: the plan
  // entry is Patrick's standing guess about a property, the booking is what
  // that customer actually asked for this time.
  const stopWindows = windowsFor(day);
  for (const [code, raw] of Object.entries(opts.requestedWindows || {})) {
    const notBefore = parseWindow(raw && raw.notBefore);
    const notAfter = parseWindow(raw && raw.notAfter);
    if (notBefore == null && notAfter == null) continue;
    const existing = stopWindows.get(code) || {};
    stopWindows.set(code, {
      notBefore: notBefore == null ? (existing.notBefore ?? null) : notBefore,
      notAfter: notAfter == null ? (existing.notAfter ?? null) : notAfter
    });
  }

  function walk(mOrder, aOrder) {
    const timeline = [];
    const ends = {};
    let clock = windows.morning.from;
    let at = 0;
    let driveMinutes = 0;
    let waitedMinutes = 0;
    const misses = [];

    for (const bucket of BUCKETS) {
      const order = bucket === "morning" ? mOrder : aOrder;
      if (clock < windows[bucket].from) clock = windows[bucket].from;
      for (const idx of order) {
        const stop = stops[idx - 1];
        const drive = matrix[at][idx];
        driveMinutes += drive;
        clock += drive;

        // WAITING IS REAL. Arriving before a gate opens does not mean the
        // job starts — it means sitting in the truck. Modelling that is what
        // makes the rest of the day's times true, and what lets an overrun
        // caused by a window actually show up as an overrun.
        const window = stopWindows.get(stop.code);
        if (window && window.notBefore != null && clock < window.notBefore) {
          waitedMinutes += window.notBefore - clock;
          clock = window.notBefore;
        }
        if (window && window.notAfter != null && clock > window.notAfter) {
          misses.push({
            propertyCode: stop.code,
            arriveAt: minutesToHHmm(Math.round(clock)),
            notAfter: minutesToHHmm(window.notAfter),
            overBy: Math.round(clock - window.notAfter)
          });
        }

        const work = onSiteMinutes(stop.property, season);
        timeline.push({
          // Position in the day's drive, 1-based and continuous across both
          // buckets — it is one trip, not two. Display reads this rather
          // than counting rows, so a screen rendering stops in any other
          // order cannot silently disagree with the route.
          stopNumber: timeline.length + 1,
          bucket,
          propertyCode: stop.code,
          address: stop.property.address || "",
          town: stop.property.town || "",
          arriveAt: minutesToHHmm(Math.round(clock)),
          leaveAt: minutesToHHmm(Math.round(clock + work.minutes)),
          driveMinutes: drive,
          onSiteMinutes: work.minutes,
          zones: work.zones,
          zonesEstimated: work.estimated,
          ...(window ? {
            notBefore: window.notBefore == null ? null : minutesToHHmm(window.notBefore),
            notAfter: window.notAfter == null ? null : minutesToHHmm(window.notAfter)
          } : {})
        });
        clock += work.minutes;
        at = idx;
      }
      ends[bucket] = Math.round(clock);
    }
    return { timeline, ends, driveMinutes, waitedMinutes, misses, lastIndex: at };
  }


  // WHEN NOTHING IS CONSTRAINED, THE OLD SEARCH RUNS UNTOUCHED. Windows are
  // rare; every day in the current plan has none. Routing those through a new
  // scorer would risk changing eleven working days to serve a case none of
  // them have, so the constrained search is only reached when a window exists.
  const constrained = stops.some((s) => stopWindows.has(s.code));

  let morningOrder;
  let afternoonOrder;
  if (manual) {
    morningOrder = morningIdx;
    afternoonOrder = afternoonIdx;
  } else if (constrained && morningIdx.length <= EXACT_SEARCH_LIMIT
      && afternoonIdx.length <= EXACT_SEARCH_LIMIT) {
    const best = bestConstrainedOrder(walk, morningIdx, afternoonIdx, cost);
    morningOrder = best.morning;
    afternoonOrder = best.afternoon;
  } else {
    if (constrained) {
      // Above the exact-search limit the joint enumeration is not run at
      // all, so windows cannot be optimised for. Say so rather than let the
      // day look as though they were honoured.
      flags.push({
        code: "windows_not_optimised",
        message: `This day has more than ${EXACT_SEARCH_LIMIT} stops in a bucket, `
          + "so the time windows were not used to choose the order. Any miss is still flagged."
      });
    }
    const chosen = bestDayOrder(cost, morningIdx, afternoonIdx);
    morningOrder = chosen.morning;
    afternoonOrder = chosen.afternoon;
  }

  const walked = walk(morningOrder, afternoonOrder);
  const { timeline, ends, misses, waitedMinutes } = walked;
  let driveMinutes = walked.driveMinutes;
  const homeDrive = stops.length ? matrix[walked.lastIndex][0] : 0;
  driveMinutes += homeDrive;

  if (manual) {
    flags.push({
      code: "manual_order",
      message: "Ordered by hand — the optimiser is not touching this day. "
        + "This also decides which addresses the booking page can cheaply add to it."
    });
  }

  // A window that could not be met. Loud, because the alternative is a day
  // that quietly arrives after the gate is locked.
  for (const miss of misses) {
    flags.push({
      code: "window_missed",
      propertyCode: miss.propertyCode,
      message: `${miss.propertyCode} is set to be done by ${miss.notAfter} but the route `
        + `arrives ${miss.arriveAt}, ${miss.overBy} min late. Move it earlier, `
        + "to another bucket, or to another day."
    });
  }
  if (waitedMinutes >= 15) {
    flags.push({
      code: "window_waiting",
      message: `${waitedMinutes} min of the day is spent waiting for a "not before" time. `
        + "Another order may waste less, or the window may be tighter than it needs to be."
    });
  }

  // Rule 2. Reordering is all this function may do — it must not move
  // anyone to the afternoon to make the morning fit — so when the best
  // order still runs past noon, the day is flagged and Patrick decides.
  if (routable.morning.length && ends.morning > windows.morning.to) {
    flags.push({
      code: "morning_overruns",
      bucket: "morning",
      endsAt: minutesToHHmm(ends.morning),
      overrunMinutes: ends.morning - windows.morning.to,
      message: `Morning finishes ${minutesToHHmm(ends.morning)}, `
        + `${ends.morning - windows.morning.to} min past 12:00. Move a stop to the afternoon or to another day.`
    });
  }

  return {
    ...day,
    morning: [...morningOrder.map((i) => stops[i - 1].code), ...unroutable.morning],
    afternoon: [...afternoonOrder.map((i) => stops[i - 1].code), ...unroutable.afternoon],
    timeline,
    morningEndsAt: routable.morning.length ? minutesToHHmm(ends.morning) : null,
    dayEndsAt: stops.length ? minutesToHHmm(ends.afternoon) : null,
    homeAt: stops.length ? minutesToHHmm(Math.round(ends.afternoon + homeDrive)) : null,
    driveMinutes: Math.round(driveMinutes),
    onSiteMinutes: timeline.reduce((t, s) => t + s.onSiteMinutes, 0),
    flags
  };
}

// Re-sequence every day in a plan.
//
// Returns three things, kept deliberately separate:
//
//   days     STORABLE. The plan's own shape with each bucket reordered
//            and nothing else — no arrival times, no drive totals. Timing
//            is derived from zone counts and drive times that both move,
//            so storing it would bake in a number that goes stale and
//            then disagrees with the screen.
//   timings  per date: timeline, morning end, day end, home, drive total.
//            Recompute on read; show, never save.
//   flags    per date, with the date and label attached so the screen can
//            point at the day that needs Patrick.
async function sequencePlan(plan, opts = {}) {
  const days = {};
  const timings = {};
  const flags = [];
  for (const date of Object.keys(plan.days || {}).sort()) {
    const sequenced = await sequenceDay(plan.days[date], opts);
    const { timeline, flags: dayFlags, morningEndsAt, dayEndsAt, homeAt,
            driveMinutes, onSiteMinutes, ...storable } = sequenced;
    days[date] = storable;
    timings[date] = { timeline, morningEndsAt, dayEndsAt, homeAt, driveMinutes, onSiteMinutes };
    for (const f of dayFlags) flags.push({ ...f, date, label: plan.days[date].label || "" });
  }
  return { days, timings, flags };
}

// Bucket-move SUGGESTIONS — the half the re-sequencer is not allowed to do.
//
// sequenceDay() may only reorder within a bucket, so it cannot fix a day
// whose buckets are wrong: R1 had Ivsbridge in the morning and the two
// Creebridge houses (0.7 km away) in the afternoon, and no amount of
// reordering repairs that — it needs a stop to change bucket, which is a
// decision only Patrick makes.
//
// So: try each stop in the other bucket, keep the move only if it is a
// real improvement that breaks no rule, and RETURN it as a suggestion.
// Nothing here mutates the plan.
//
// A split cluster is not automatically a fault. A dense day has to break
// somewhere, and adjacent stops will straddle any boundary you draw. The
// test is therefore not "are these two close" but "does moving this stop
// actually save driving while staying inside the caps and finishing the
// morning by noon" — which is checkable, rather than a matter of taste.
async function suggestBucketMoves(day, opts = {}) {
  const { bucketCap = 5, minSavingMinutes = 3 } = opts;
  const current = await sequenceDay(day, opts);
  const suggestions = [];

  for (const from of BUCKETS) {
    const to = from === "morning" ? "afternoon" : "morning";
    for (const code of day[from] || []) {
      if ((day[to] || []).length >= bucketCap) continue;
      const candidate = {
        ...day,
        [from]: (day[from] || []).filter((c) => c !== code),
        [to]: [...(day[to] || []), code]
      };
      const moved = await sequenceDay(candidate, opts);

      // Never suggest a move that creates the very problem rule 2 exists
      // to prevent, even when it saves driving.
      const brokeMorning = moved.flags.some((f) => f.code === "morning_overruns")
        && !current.flags.some((f) => f.code === "morning_overruns");
      if (brokeMorning) continue;

      const saving = current.driveMinutes - moved.driveMinutes;
      if (saving >= minSavingMinutes) {
        suggestions.push({
          code: "bucket_move_suggested",
          propertyCode: code,
          from,
          to,
          savingMinutes: saving,
          message: `Moving ${code} from ${from} to ${to} would save ${saving} min of driving. `
            + `The customer would have to agree to the new bucket.`
        });
      }
    }
  }
  suggestions.sort((a, b) => b.savingMinutes - a.savingMinutes);
  return suggestions;
}

module.exports = { sequenceDay, sequencePlan, suggestBucketMoves, onSiteMinutes,
  parseWindow, windowsFor,
  EXACT_SEARCH_LIMIT, FINISH_NEAR_BASE_TOLERANCE_MINUTES };

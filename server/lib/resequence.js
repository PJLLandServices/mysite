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

const { travelMinutes, MIN_TRAVEL_MINUTES } = require("./distance");
const { PJL_BASE } = require("./geocode");
const { BOOKABLE_SERVICES, BOOKING_BUCKETS, parseHHmmToMinutes, minutesToHHmm } = require("./availability");
const { deriveSeasonalKey } = require("./pricing");

const BUCKETS = ["morning", "afternoon"];

// Above this many stops in one bucket, an exhaustive search stops being
// free (8! = 40320) and we fall back to nearest-neighbour + 2-opt, which
// is within a couple of percent on route shapes this small. The bucket
// cap is 5, so the exact path is what actually runs.
const EXACT_SEARCH_LIMIT = 7;

// THE TIE PROBLEM, AND WHY DISTANCE BREAKS IT.
//
// distance.js floors every trip at MIN_TRAVEL_MINUTES (5) — including
// real Google Distance Matrix answers, which are wrapped in a Math.max.
// That floor is right for scheduling: five minutes is parking, unloading
// and knocking on a door, and no visit is shorter than that in practice.
//
// For ORDERING it is fatal. 100 and 106 Lavery Trail are 40 m apart and
// 748 Morrish Rd is 1 km away; all three legs come back as "5 minutes",
// so every arrangement of them costs the same and the search picks an
// arbitrary winner among the ties. Live, that produced
// 100 Lavery -> Morrish -> 106 Lavery: a detour between two neighbours.
//
// So the ordering cost adds a vanishing amount of straight-line distance
// on top of the travel time. Within a tie it decides; against a genuine
// difference it cannot compete. A whole day's route is well under 200 km,
// which at this weight contributes under 0.2 of a minute — far below the
// one-minute granularity travelMinutes reports. The clock the operator
// sees is still built from unmodified travel times; this weight exists
// only inside the comparison.
const DISTANCE_TIEBREAK_PER_KM = 0.001;

function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bucketWindow(key) {
  const b = BOOKING_BUCKETS.find((x) => x.key === key);
  return b ? { from: parseHHmmToMinutes(b.from), to: parseHHmmToMinutes(b.to) } : null;
}

// On-site minutes for a property, from its zone count through the same
// tier table the booking engine and the pricing module use. A property
// with no zones on file falls to the lowest tier — which understates a
// big system, and is why the plan screen marks those stops as estimated.
function onSiteMinutes(property, season) {
  const woType = season === "spring" ? "spring_opening" : "fall_closing";
  const zones = Array.isArray(property?.system?.zones) ? property.system.zones.length : 0;
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
async function buildMatrix(points, travel) {
  const n = points.length;
  const minutes = Array.from({ length: n }, () => new Array(n).fill(0));
  const cost = Array.from({ length: n }, () => new Array(n).fill(0));
  const jobs = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      jobs.push(travel(points[i], points[j]).then((v) => {
        minutes[i][j] = v;
        cost[i][j] = v + haversineKm(points[i], points[j]) * DISTANCE_TIEBREAK_PER_KM;
      }));
    }
  }
  await Promise.all(jobs);
  return { minutes, cost };
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
async function sequenceDay(day, { propertiesByCode, season = "fall", base = PJL_BASE, travel = travelMinutes } = {}) {
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
  const { minutes: matrix, cost } = await buildMatrix(points, travel);
  const indexOf = new Map(stops.map((s, i) => [s.code, i + 1]));   // +1: base is 0

  const morningIdx = routable.morning.map((s) => indexOf.get(s.code));
  const afternoonIdx = routable.afternoon.map((s) => indexOf.get(s.code));

  // Morning first, entering from base. Its exit point is left open — the
  // afternoon is then optimised from wherever the morning actually ended,
  // which is what chains the two halves instead of treating them as two
  // unrelated trips.
  const morningOrder = bestOrder(cost, 0, morningIdx, null);
  const morningExit = morningOrder.length ? morningOrder[morningOrder.length - 1] : 0;
  const afternoonOrder = bestOrder(cost, morningExit, afternoonIdx, 0);

  // Walk the clock. Each bucket starts no earlier than its own window.
  const timeline = [];
  const windows = { morning: bucketWindow("morning"), afternoon: bucketWindow("afternoon") };
  let clock = windows.morning.from;
  let at = 0;
  let driveMinutes = 0;
  const ends = {};

  for (const bucket of BUCKETS) {
    const order = bucket === "morning" ? morningOrder : afternoonOrder;
    if (clock < windows[bucket].from) clock = windows[bucket].from;
    for (const idx of order) {
      const stop = stops[idx - 1];
      const drive = matrix[at][idx];
      driveMinutes += drive;
      clock += drive;
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
        zonesEstimated: work.estimated
      });
      clock += work.minutes;
      at = idx;
    }
    ends[bucket] = Math.round(clock);
  }

  const homeDrive = stops.length ? matrix[at][0] : 0;
  driveMinutes += homeDrive;

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

module.exports = { sequenceDay, sequencePlan, suggestBucketMoves, onSiteMinutes, EXACT_SEARCH_LIMIT };

// Season plans — the route seed the geography filter measures against.
//
// WHY THIS EXISTS. server/lib/availability.js has always done
// reachable-from-previous / reachable-to-next travel math against the
// bookings already on a day. That math is correct and it was inert:
// on an empty day everything is reachable, so the first customer to
// click set the day's anchor wherever they happened to live, and every
// later caller was measured against that accident. Availability for an
// address in Nobleton and an address in Scarborough returned identical
// slots.
//
// The fix is not more math. It is giving each day a shape BEFORE anyone
// books it. That shape is the season plan: the route Patrick intends to
// drive, expressed as property codes per day and bucket.
//
// A PLANNED PROPERTY IS NOT A BOOKING. It contributes its coordinates to
// the day's shape and nothing else — it does not consume capacity, does
// not appear on /admin/today, does not create a work order. When the
// planned customer actually books, the booking joins the shape alongside
// the planned entry; the entry itself stays, so a cancellation does not
// erase the day's geography.
//
// STORAGE. server/data/season-plans.json, on the Render disk, keyed
// "<season>-<year>" to match the ROUTE_PLAN seed file:
//
//   {
//     "fall-2026": {
//       "generatedAt": "2026-08-30T00:00:00Z",
//       "source": "free text — how this plan was generated",
//       "bucketCap": 5,
//       "dayCap": 10,
//       "days": {
//         "2026-09-28": {
//           "label": "R1",
//           "territory": "North home turf",   // optional, display only
//           "frost": "first",                  // optional, display only
//           "morning":   ["P-2026-0003", ...],
//           "afternoon": ["P-2026-0074", ...]
//         }
//       }
//     }
//   }
//
// PROPERTY CODES, NOT IDS. The plan is keyed on the human-facing
// `code` ("P-2026-0003") rather than the uuid `id`, because the plan is
// generated, reviewed and hand-edited by a person against the route
// sheet. The reader resolves codes to live property records and reports
// what it could not resolve rather than dropping it silently — that is
// how the merged-away duplicate P-2026-0040 surfaces as a visible
// warning instead of a stop that quietly stops existing.
//
// CAPS ARE WARNINGS, NOT ERRORS. bucketCap / dayCap describe the plan
// Patrick intends. Exceeding one is worth showing on the review screen;
// it is not a reason to refuse an import, because he is allowed to
// decide a day holds six.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "season-plans.json");

const SEASONS = new Set(["spring", "fall"]);
const BUCKETS = ["morning", "afternoon"];
const DEFAULT_BUCKET_CAP = 5;
const DEFAULT_DAY_CAP = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function planKey(season, year) {
  const s = String(season || "").toLowerCase();
  if (!SEASONS.has(s)) throw new Error(`Unknown season: ${season}`);
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error(`Invalid year: ${year}`);
  return `${s}-${y}`;
}

// "YYYY-MM-DD" -> true only if it is a real calendar date. new Date()
// happily accepts 2026-02-31 and rolls it into March, which would put a
// route day on a date the operator never typed.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRealDate(key) {
  if (!DATE_RE.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) await fs.writeFile(FILE, "{}\n", "utf8");
}

async function read() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt plan file must not take the booking engine down with it.
    // An unreadable plan means "no shape for any day", which degrades to
    // today's behaviour (offer normal availability) rather than to a
    // refusal. Invariant 5: a failure never blocks a booking.
    return {};
  }
}

async function writeAll(all) {
  await ensureFile();
  await fs.writeFile(FILE, `${JSON.stringify(all, null, 2)}\n`, "utf8");
}

// Normalize + check an incoming plan. Throws on anything that would make
// the plan unreadable; collects everything else as a warning so the
// review screen can show it without blocking the import.
//
// Returns { plan, warnings }.
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Plan must be a JSON object.");
  }
  const warnings = [];
  const days = input.days;
  if (!days || typeof days !== "object" || Array.isArray(days)) {
    throw new Error("Plan is missing a `days` object.");
  }

  const bucketCap = Number.isFinite(Number(input.bucketCap)) ? Number(input.bucketCap) : DEFAULT_BUCKET_CAP;
  const dayCap = Number.isFinite(Number(input.dayCap)) ? Number(input.dayCap) : DEFAULT_DAY_CAP;

  const plan = {
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : new Date().toISOString(),
    source: typeof input.source === "string" ? input.source.slice(0, 500) : "",
    bucketCap,
    dayCap,
    days: {}
  };

  const seen = new Map();   // property code -> "YYYY-MM-DD bucket"
  const dateKeys = Object.keys(days).sort();
  if (!dateKeys.length) throw new Error("Plan has no route days.");

  for (const dateKey of dateKeys) {
    if (!isRealDate(dateKey)) throw new Error(`Not a calendar date: "${dateKey}". Expected YYYY-MM-DD.`);
    const src = days[dateKey];
    if (!src || typeof src !== "object") throw new Error(`Day ${dateKey} is not an object.`);

    const day = {
      label: typeof src.label === "string" ? src.label.slice(0, 40) : "",
      morning: [],
      afternoon: []
    };
    if (typeof src.territory === "string" && src.territory) day.territory = src.territory.slice(0, 120);
    // Hand-ordered days keep their order. validate() rebuilds each day from
    // scratch, so anything not copied here is silently dropped on the next
    // save — and a manual order that survives one save and vanishes on the
    // next is worse than one that never worked.
    if (src.manualOrder === true) day.manualOrder = true;
    // Time windows, same reason: validate() rebuilds each day from scratch,
    // so anything not copied here is dropped on the next save. Only "HH:MM"
    // survives — a half-typed value stored as a constraint is a constraint
    // nobody can satisfy.
    if (src.constraints && typeof src.constraints === "object") {
      const kept = {};
      for (const [code, raw] of Object.entries(src.constraints)) {
        if (!raw || typeof raw !== "object") continue;
        const window = {};
        if (TIME_RE.test(String(raw.notBefore || ""))) window.notBefore = raw.notBefore;
        if (TIME_RE.test(String(raw.notAfter || ""))) window.notAfter = raw.notAfter;
        if (Object.keys(window).length) kept[String(code).slice(0, 40)] = window;
      }
      if (Object.keys(kept).length) day.constraints = kept;
    }
    if (typeof src.frost === "string" && src.frost) day.frost = src.frost.slice(0, 40);

    for (const bucket of BUCKETS) {
      const list = src[bucket];
      if (list == null) continue;
      if (!Array.isArray(list)) throw new Error(`Day ${dateKey} ${bucket} must be an array.`);
      for (const raw of list) {
        const code = String(raw || "").trim();
        if (!code) continue;
        // A property on two stops is the duplicate-record failure mode
        // (P-2026-0040 / P-2026-0056 before the merge). Keep the first
        // and warn — dropping both would lose a real stop, and throwing
        // would block an import over something the operator can see and
        // fix on the review screen.
        if (seen.has(code)) {
          warnings.push({
            code: "duplicate_stop",
            propertyCode: code,
            message: `${code} appears twice — kept at ${seen.get(code)}, dropped from ${dateKey} ${bucket}.`
          });
          continue;
        }
        seen.set(code, `${dateKey} ${bucket}`);
        day[bucket].push(code);
      }
    }

    if (day.morning.length > bucketCap) {
      warnings.push({ code: "bucket_over_cap", date: dateKey, bucket: "morning",
        message: `${dateKey} morning holds ${day.morning.length} stops, over the cap of ${bucketCap}.` });
    }
    if (day.afternoon.length > bucketCap) {
      warnings.push({ code: "bucket_over_cap", date: dateKey, bucket: "afternoon",
        message: `${dateKey} afternoon holds ${day.afternoon.length} stops, over the cap of ${bucketCap}.` });
    }
    const total = day.morning.length + day.afternoon.length;
    if (total > dayCap) {
      warnings.push({ code: "day_over_cap", date: dateKey,
        message: `${dateKey} holds ${total} stops, over the day cap of ${dayCap}.` });
    }

    plan.days[dateKey] = day;
  }

  return { plan, warnings };
}

async function getPlan(season, year) {
  const all = await read();
  return all[planKey(season, year)] || null;
}

// Replace the plan for one season+year. `actor` is recorded on the
// stored plan so the review screen can say who last imported it.
async function savePlan(season, year, input, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  const { plan, warnings } = validate(input);
  plan.updatedAt = new Date().toISOString();
  plan.updatedBy = String(actor || "admin").slice(0, 80);
  const all = await read();
  all[key] = plan;
  await writeAll(all);
  return { plan, warnings };
}

async function removePlan(season, year) {
  const key = planKey(season, year);
  const all = await read();
  if (!all[key]) return false;
  delete all[key];
  await writeAll(all);
  return true;
}

// Move one stop to a different day and/or bucket. This is the only
// mutation the review screen needs before assignment goes out, and it
// is deliberately the only one: the plan is regenerated each season, so
// an editor beyond "this house is on the wrong day" is not worth
// building or maintaining.
//
// Returns { plan, warnings, moved: { propertyCode, from, to } }.
async function moveStop(season, year, { propertyCode, toDate, toBucket }, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  const code = String(propertyCode || "").trim();
  if (!code) throw new Error("propertyCode is required.");
  if (!isRealDate(String(toDate || ""))) throw new Error(`Not a calendar date: "${toDate}".`);
  if (!BUCKETS.includes(toBucket)) throw new Error(`Bucket must be one of: ${BUCKETS.join(", ")}.`);

  const all = await read();
  const plan = all[key];
  if (!plan) throw new Error(`No ${key} plan to edit.`);
  if (!plan.days[toDate]) throw new Error(`${toDate} is not a route day in this plan.`);

  let from = null;
  for (const [dateKey, day] of Object.entries(plan.days)) {
    for (const bucket of BUCKETS) {
      const i = (day[bucket] || []).indexOf(code);
      if (i > -1) { day[bucket].splice(i, 1); from = { date: dateKey, bucket }; }
    }
  }
  if (!from) throw new Error(`${code} is not in the ${key} plan.`);

  plan.days[toDate][toBucket] = plan.days[toDate][toBucket] || [];
  plan.days[toDate][toBucket].push(code);

  const { plan: revalidated, warnings } = validate(plan);
  revalidated.updatedAt = new Date().toISOString();
  revalidated.updatedBy = String(actor || "admin").slice(0, 80);
  all[key] = revalidated;
  await writeAll(all);
  return { plan: revalidated, warnings, moved: { propertyCode: code, from, to: { date: toDate, bucket: toBucket } } };
}

// Set or clear a stop's time window.
//
// "Not before 10:00" is a locked gate or a customer who is out until then;
// "not after 12:30" is a promise already made. Both are things the optimiser
// cannot see and Patrick can.
//
// Passing null for either half clears it; clearing both removes the stop's
// entry entirely rather than leaving an empty object behind to be reasoned
// about later.
async function setStopWindow(season, year, { date, propertyCode, notBefore, notAfter }, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  const code = String(propertyCode || "").trim();
  if (!isRealDate(String(date || ""))) throw new Error(`Not a calendar date: "${date}".`);
  if (!code) throw new Error("propertyCode is required.");

  const clean = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    const text = String(value).trim();
    if (!TIME_RE.test(text)) throw new Error(`"${value}" is not a time — ${label} must look like 09:30.`);
    return text;
  };
  const from = clean(notBefore, "not before");
  const to = clean(notAfter, "not after");
  if (from && to && from >= to) {
    throw new Error(`Not before ${from} and not after ${to} leave no time to arrive in.`);
  }

  const all = await read();
  const plan = all[key];
  if (!plan) throw new Error(`No ${key} plan to edit.`);
  const day = plan.days[date];
  if (!day) throw new Error(`${date} is not a route day in this plan.`);
  const onDay = [...(day.morning || []), ...(day.afternoon || [])].includes(code);
  if (!onDay) throw new Error(`${code} is not a stop on ${date}.`);

  day.constraints = day.constraints || {};
  if (!from && !to) delete day.constraints[code];
  else day.constraints[code] = { ...(from ? { notBefore: from } : {}), ...(to ? { notAfter: to } : {}) };
  if (!Object.keys(day.constraints).length) delete day.constraints;

  const { plan: revalidated, warnings } = validate(plan);
  revalidated.updatedAt = new Date().toISOString();
  revalidated.updatedBy = String(actor || "admin").slice(0, 80);
  all[key] = revalidated;
  await writeAll(all);
  return { plan: revalidated, warnings, window: { date, propertyCode: code, notBefore: from, notAfter: to } };
}

// Move one stop up or down inside its own bucket.
//
// The optimiser is very good at the thing it can see — driving minutes —
// and blind to everything it cannot: who is not home before ten, which gate
// is locked until nine, which north-facing slope is better done before the
// frost comes off. This is how that knowledge gets in.
//
// A HAND-ORDERED DAY STOPS BEING OPTIMISED. `manualOrder` is set on the day
// and the sequencer then walks the stored order rather than searching for a
// better one. That is the honest behaviour: an order Patrick set, which the
// next re-sequence silently reverted, would be worse than no feature.
//
// AND IT CHANGES WHO CAN BOOK THAT DAY. geo-filter.js builds the day's
// shape from the stops IN STORED ORDER, and the booking page's added-drive
// test measures the gaps between consecutive stops. Reordering moves those
// gaps, so an address that was a cheap insert may stop being one. That is
// not a bug — the filter is measuring the route that will actually be
// driven — but it is a consequence, and the screen says so.
async function reorderStop(season, year, { date, bucket, propertyCode, direction }, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  const code = String(propertyCode || "").trim();
  if (!isRealDate(String(date || ""))) throw new Error(`Not a calendar date: "${date}".`);
  if (!BUCKETS.includes(bucket)) throw new Error(`Bucket must be one of: ${BUCKETS.join(", ")}.`);
  if (direction !== "up" && direction !== "down") throw new Error('Direction must be "up" or "down".');
  if (!code) throw new Error("propertyCode is required.");

  const all = await read();
  const plan = all[key];
  if (!plan) throw new Error(`No ${key} plan to edit.`);
  const day = plan.days[date];
  if (!day) throw new Error(`${date} is not a route day in this plan.`);

  const list = day[bucket] || [];
  const from = list.indexOf(code);
  if (from < 0) throw new Error(`${code} is not in the ${bucket} of ${date}.`);
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= list.length) {
    throw new Error(`${code} is already ${direction === "up" ? "first" : "last"} in the ${bucket}.`);
  }

  list.splice(from, 1);
  list.splice(to, 0, code);
  day.manualOrder = true;

  const { plan: revalidated, warnings } = validate(plan);
  revalidated.updatedAt = new Date().toISOString();
  revalidated.updatedBy = String(actor || "admin").slice(0, 80);
  all[key] = revalidated;
  await writeAll(all);
  return { plan: revalidated, warnings, reordered: { date, bucket, propertyCode: code, from, to } };
}

// Hand the day back to the optimiser. The order it currently holds is kept
// until the next re-sequence recomputes it, so nothing jumps on the click.
async function clearManualOrder(season, year, { date }, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  if (!isRealDate(String(date || ""))) throw new Error(`Not a calendar date: "${date}".`);
  const all = await read();
  const plan = all[key];
  if (!plan) throw new Error(`No ${key} plan to edit.`);
  const day = plan.days[date];
  if (!day) throw new Error(`${date} is not a route day in this plan.`);
  if (!day.manualOrder) throw new Error(`${day.label || date} is already optimised automatically.`);

  delete day.manualOrder;
  const { plan: revalidated, warnings } = validate(plan);
  revalidated.updatedAt = new Date().toISOString();
  revalidated.updatedBy = String(actor || "admin").slice(0, 80);
  all[key] = revalidated;
  await writeAll(all);
  return { plan: revalidated, warnings };
}

// Re-date one route day, leaving every other day where it is.
//
// The case this exists for: the weather stays too warm to close systems
// down, so a day cannot run and has to slide. Only that day moves — the
// rest of the season keeps its dates, because a warm Monday does not
// necessarily mean a warm Friday.
//
// THE LABEL TRAVELS WITH THE DAY, NOT WITH THE DATE. R1 is the name of a
// set of properties in a territory, and Patrick talks about days that way
// ("R5 is the long-haul west"). Renumbering on a move would make
// yesterday's sentence about R5 refer to somewhere else, so the label
// stays put and the screen sorts by date.
//
// A DAY WITH REAL BOOKINGS ON IT IS REFUSED. Today no booking can exist
// against a planned day — the assignment writer does not exist yet, so no
// customer has ever been told a date. The moment it does, moving a day is
// a promise broken and a batch of emails, and the check has to already be
// here rather than be remembered afterwards. The caller supplies the
// count; this module does not read bookings.
async function moveDay(season, year, { fromDate, toDate, bookedCount = 0 }, { actor = "admin" } = {}) {
  const key = planKey(season, year);
  const from = String(fromDate || "").trim();
  const to = String(toDate || "").trim();
  if (!isRealDate(from)) throw new Error(`Not a calendar date: "${fromDate}".`);
  if (!isRealDate(to)) throw new Error(`Not a calendar date: "${toDate}".`);
  if (from === to) throw new Error("That day is already on that date.");

  const all = await read();
  const plan = all[key];
  if (!plan) throw new Error(`No ${key} plan to edit.`);
  const day = plan.days[from];
  if (!day) throw new Error(`${from} is not a route day in this plan.`);

  if (plan.days[to]) {
    const other = plan.days[to].label || to;
    throw new Error(`${to} already holds ${other}. Move that day first, or pick a free date.`);
  }

  const booked = Number(bookedCount) || 0;
  if (booked > 0) {
    throw new Error(
      `${day.label || from} has ${booked} real booking${booked === 1 ? "" : "s"} on it. `
      + "Moving the day would break a date a customer was already given — reschedule those bookings first."
    );
  }

  delete plan.days[from];
  plan.days[to] = day;

  const { plan: revalidated, warnings } = validate(plan);
  revalidated.updatedAt = new Date().toISOString();
  revalidated.updatedBy = String(actor || "admin").slice(0, 80);
  all[key] = revalidated;
  await writeAll(all);
  return {
    plan: revalidated,
    warnings,
    moved: { label: day.label || null, from, to, weekend: isWeekend(to) }
  };
}

// Saturdays and Sundays are not blocked — Patrick may choose one — but the
// screen says so, because landing on a weekend by arithmetic accident is
// different from landing on one on purpose.
function isWeekend(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

// Flat "which property codes are planned on which date" view, which is
// all the day-shape builder needs.
function codesByDate(plan) {
  const out = new Map();
  if (!plan || !plan.days) return out;
  for (const [dateKey, day] of Object.entries(plan.days)) {
    out.set(dateKey, [...(day.morning || []), ...(day.afternoon || [])]);
  }
  return out;
}

module.exports = {
  moveDay,
  setStopWindow,
  reorderStop,
  clearManualOrder,
  FILE,
  BUCKETS,
  DEFAULT_BUCKET_CAP,
  DEFAULT_DAY_CAP,
  planKey,
  isRealDate,
  read,
  validate,
  getPlan,
  savePlan,
  removePlan,
  moveStop,
  codesByDate
};

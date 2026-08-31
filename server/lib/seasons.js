// Season windows — dumb lookup against seasons.json.
//
// The single authoritative definition of when PJL's seasonal services run.
// Before this module existed the fall window was a hardcoded SEASON_WINDOWS
// constant in server/lib/outreach.js reading Sep 1 - Dec 15; the real fall
// 2026 season stops at Nov 6 (hard frost), so the last 39 days of that window
// were not serviceable. The dates now live in seasons.json, at the repo root
// beside pricing.json / parts.json, so the seasonal gate planned for
// server/lib/availability.js can read the same source instead of carrying a
// second copy that drifts.
//
// Two accessors:
//
//   windowFor(season, year)  -> { startMonth, startDay, endMonth, endDay }
//       The serviceable window as 1-indexed month/day pairs. This is the shape
//       outreach.js's date comparison already spoke, so the comparison logic
//       is unchanged - only where the numbers come from moved.
//
//   configFor(season, year)  -> { serviceableFrom, serviceableThrough,
//                                 publicBookingThrough }
//       The full record as YYYY-MM-DD strings. publicBookingThrough is
//       consumed by the season gate in server/lib/availability.js: days
//       after it emit no public slots for seasonal services.
//
// Both resolve a year with an explicit block in seasons.json `years` first,
// and fall back to the year-agnostic `defaults` otherwise. Those defaults are
// a safe floor rather than a forecast: fall ends on the Nov 6 frost stop, not
// the Dec 15 the old hardcoded constant used, so a year nobody has planned
// yet cannot silently reacquire the bug this module was written to fix. A
// season that genuinely runs later is a season someone plans explicitly.
//
// TIMEZONE: these are plain calendar dates in America/Toronto. Callers compare
// them against local date fields (d.getMonth() + 1, d.getDate()), which is
// honest because server.js pins process.env.TZ = "America/Toronto" at boot.
// Deliberately no Intl here - it would be a second, different way of doing
// what the rest of the codebase already does one way.
//
// FAILURE MODE: a missing or malformed seasons.json does NOT throw at require
// time - outreach.js is required during server boot and a typo in a seasonal
// config must not take the whole CRM down. Instead the error is remembered and
// every accessor throws with it. The admin outreach route surfaces that as a
// visible error; the portal's own try/catch degrades to "not booked", which
// offers a plain booking link rather than a seasonal one. What must never
// happen is a silent fallback window: guessing dates here would answer "this
// customer is not booked" for people who are, and mail them.

const path = require("path");
const fs = require("fs");

const SEASONS = ["spring", "fall"];
const DATE_FIELDS = ["serviceableFrom", "serviceableThrough", "publicBookingThrough"];

let CONFIG = null;
let LOAD_ERROR = null;

// "09-01" or "2026-09-01" -> { month, day }. Returns null if unparseable, or
// if an explicit year prefix disagrees with the block it was found under.
function parseDate(value, expectedYear) {
  const text = String(value == null ? "" : value).trim();
  const withYear = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const withoutYear = /^(\d{2})-(\d{2})$/.exec(text);
  let year = null;
  let month;
  let day;
  if (withYear) {
    year = Number(withYear[1]);
    month = Number(withYear[2]);
    day = Number(withYear[3]);
  } else if (withoutYear) {
    month = Number(withoutYear[1]);
    day = Number(withoutYear[2]);
  } else {
    return null;
  }
  if (expectedYear != null && year != null && year !== expectedYear) return null;
  if (expectedYear != null && year == null) return null;   // year blocks must be explicit
  if (expectedYear == null && year != null) return null;   // defaults must not carry a year
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { month, day };
}

// Sortable within a single season's year. No season wraps a year boundary.
function ordinal(md) { return (md.month * 100) + md.day; }

// Validate one season record and return it normalized, or throw with a path
// the operator can act on ("years.2026.fall.serviceableThrough").
function normalizeSeason(record, where, expectedYear) {
  if (!record || typeof record !== "object") {
    throw new Error(`${where} is missing or not an object`);
  }
  const parsed = {};
  for (const field of DATE_FIELDS) {
    const md = parseDate(record[field], expectedYear);
    if (!md) {
      throw new Error(
        `${where}.${field} is not a valid ` +
        (expectedYear == null ? "MM-DD" : `${expectedYear}-MM-DD`) +
        ` date (got ${JSON.stringify(record[field])})`
      );
    }
    parsed[field] = md;
  }
  if (ordinal(parsed.serviceableFrom) > ordinal(parsed.serviceableThrough)) {
    throw new Error(`${where}.serviceableThrough falls before serviceableFrom`);
  }
  if (ordinal(parsed.publicBookingThrough) > ordinal(parsed.serviceableThrough)) {
    throw new Error(
      `${where}.publicBookingThrough falls after serviceableThrough — ` +
      `the public flow would accept bookings for days no truck rolls`
    );
  }
  if (ordinal(parsed.publicBookingThrough) < ordinal(parsed.serviceableFrom)) {
    throw new Error(`${where}.publicBookingThrough falls before serviceableFrom`);
  }
  return {
    raw: {
      serviceableFrom: String(record.serviceableFrom),
      serviceableThrough: String(record.serviceableThrough),
      publicBookingThrough: String(record.publicBookingThrough)
    },
    parsed
  };
}

(function load() {
  let json;
  try {
    const configPath = path.resolve(__dirname, "..", "..", "seasons.json");
    json = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    LOAD_ERROR = `Could not load seasons.json: ${err?.message || err}`;
    console.error(`[server/lib/seasons.js] ${LOAD_ERROR}`);
    return;
  }
  try {
    const defaults = {};
    for (const season of SEASONS) {
      defaults[season] = normalizeSeason(json?.defaults?.[season], `defaults.${season}`, null);
    }
    const years = {};
    for (const [yearKey, block] of Object.entries(json?.years || {})) {
      if (!/^\d{4}$/.test(yearKey)) {
        throw new Error(`years.${yearKey} is not a four-digit year`);
      }
      const year = Number(yearKey);
      years[year] = {};
      for (const season of SEASONS) {
        years[year][season] = normalizeSeason(
          block?.[season], `years.${yearKey}.${season}`, year
        );
      }
    }
    CONFIG = { defaults, years };
  } catch (err) {
    LOAD_ERROR = `seasons.json is invalid: ${err?.message || err}`;
    console.error(`[server/lib/seasons.js] ${LOAD_ERROR}`);
  }
}());

// Resolve the record for a season+year — explicit year block first, then the
// year-agnostic defaults. Unknown season returns null (the caller decides);
// an unloadable config throws, because a guessed window is worse than none.
function resolve(season, year) {
  if (LOAD_ERROR || !CONFIG) throw new Error(LOAD_ERROR || "seasons.json did not load");
  if (!SEASONS.includes(season)) return null;
  const y = Number(year);
  if (Number.isFinite(y) && CONFIG.years[y]) return CONFIG.years[y][season];
  return CONFIG.defaults[season];
}

// { startMonth, startDay, endMonth, endDay } for the serviceable window, or
// null for an unknown season. 1-indexed months, matching Date#getMonth() + 1.
function windowFor(season, year) {
  const record = resolve(season, year);
  if (!record) return null;
  return {
    startMonth: record.parsed.serviceableFrom.month,
    startDay: record.parsed.serviceableFrom.day,
    endMonth: record.parsed.serviceableThrough.month,
    endDay: record.parsed.serviceableThrough.day
  };
}

// The full season record as written, with dates normalized to YYYY-MM-DD for
// the requested year (a defaults record carries no year of its own).
function configFor(season, year) {
  const record = resolve(season, year);
  if (!record) return null;
  const y = Number(year);
  const stamp = (field) => {
    const md = record.parsed[field];
    if (!Number.isFinite(y)) return record.raw[field];
    return `${y}-${String(md.month).padStart(2, "0")}-${String(md.day).padStart(2, "0")}`;
  };
  return {
    serviceableFrom: stamp("serviceableFrom"),
    serviceableThrough: stamp("serviceableThrough"),
    publicBookingThrough: stamp("publicBookingThrough")
  };
}

// True when this year has its own block rather than inheriting the defaults.
// Lets a caller tell "planned" from "nobody has set this year's frost date".
function hasExplicitYear(year) {
  if (LOAD_ERROR || !CONFIG) throw new Error(LOAD_ERROR || "seasons.json did not load");
  const y = Number(year);
  return Number.isFinite(y) && Boolean(CONFIG.years[y]);
}

module.exports = {
  SEASONS,
  windowFor,
  configFor,
  hasExplicitYear,
  // Test/diagnostic surface.
  loadError: () => LOAD_ERROR
};

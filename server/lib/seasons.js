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
//                                 publicBookingFrom, publicBookingThrough }
//       The full record as YYYY-MM-DD strings. publicBookingFrom and
//       publicBookingThrough are consumed by the season gate in
//       server/lib/availability.js: days outside [from..through] emit no
//       public slots for seasonal services. publicBookingFrom is OPTIONAL
//       in seasons.json and defaults to serviceableFrom — fall 2026 sets
//       it to Sep 28 (the first planned route day) so the public flow
//       cannot book a September date no truck is scheduled to serve.
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
//
// ADMIN OVERRIDES (2026-08-31): the PUBLIC BOOKING window - and only it -
// is editable from /admin/season-plan without touching this repo. Edits
// are stored per season+year in server/data/season-windows.json (the
// Render persistent disk, same place bookings live, so deploys never
// reset them) and layered over seasons.json by configFor(). The
// SERVICEABLE window stays file-only on purpose: the frost stop is a
// planning decision with outreach consequences (windowFor() feeds
// "is this customer already booked?"), not a dial to nudge from a phone.
// An override that violates the serviceable window - hand-edited file,
// or a serviceable season later shortened under it - is IGNORED with a
// warning, so a bad override degrades to seasons.json rather than
// offering days no truck rolls.

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
  // publicBookingFrom is optional: absent means booking opens with the
  // season (serviceableFrom). Present, it holds the public flow back to a
  // later start — fall 2026 uses Sep 28, the first planned route day.
  if (record.publicBookingFrom != null) {
    const md = parseDate(record.publicBookingFrom, expectedYear);
    if (!md) {
      throw new Error(
        `${where}.publicBookingFrom is not a valid ` +
        (expectedYear == null ? "MM-DD" : `${expectedYear}-MM-DD`) +
        ` date (got ${JSON.stringify(record.publicBookingFrom)})`
      );
    }
    parsed.publicBookingFrom = md;
  } else {
    parsed.publicBookingFrom = parsed.serviceableFrom;
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
  if (ordinal(parsed.publicBookingFrom) < ordinal(parsed.serviceableFrom)) {
    throw new Error(`${where}.publicBookingFrom falls before serviceableFrom`);
  }
  if (ordinal(parsed.publicBookingFrom) > ordinal(parsed.publicBookingThrough)) {
    throw new Error(
      `${where}.publicBookingFrom falls after publicBookingThrough — ` +
      `the public booking window would be empty`
    );
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

// ---- Admin overrides for the public booking window -------------------
//
// { "fall-2026": { publicBookingFrom?, publicBookingThrough?,
//                  updatedAt, actor } }
// Values are full YYYY-MM-DD strings matching the key's year. Loaded
// synchronously at require (configFor must stay synchronous — the
// availability season gate calls it inside a hot loop) and kept in
// memory; setPublicBookingWindow writes the file and updates memory in
// one step. Single-process server, so that is the whole story.

const OVERRIDES_FILE = path.resolve(__dirname, "..", "data", "season-windows.json");
let OVERRIDES = {};

(function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) OVERRIDES = parsed;
    }
  } catch (err) {
    console.warn(`[server/lib/seasons.js] could not read season-windows.json — using seasons.json only: ${err?.message}`);
  }
}());

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function overrideKey(season, year) { return `${season}-${year}`; }

// The override merged over a base configFor record, or null when there is
// no override or it is invalid against the base. Validity is re-checked
// on every read, not just at write time, because the file can be edited
// by hand and the serviceable window can change underneath a stored
// override.
function usableOverride(season, year, base) {
  const o = OVERRIDES[overrideKey(season, year)];
  if (!o || typeof o !== "object") return null;
  const from = typeof o.publicBookingFrom === "string" && YMD_RE.test(o.publicBookingFrom)
    ? o.publicBookingFrom : null;
  const through = typeof o.publicBookingThrough === "string" && YMD_RE.test(o.publicBookingThrough)
    ? o.publicBookingThrough : null;
  if (!from && !through) return null;
  const effFrom = from || base.publicBookingFrom;
  const effThrough = through || base.publicBookingThrough;
  // YYYY-MM-DD compares correctly as strings.
  if (effFrom < base.serviceableFrom || effThrough > base.serviceableThrough || effFrom > effThrough) {
    console.warn(
      `[server/lib/seasons.js] ignoring invalid ${overrideKey(season, year)} booking-window override ` +
      `(${effFrom}..${effThrough} vs serviceable ${base.serviceableFrom}..${base.serviceableThrough})`
    );
    return null;
  }
  return { publicBookingFrom: from, publicBookingThrough: through };
}

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

// The season record from seasons.json alone, with dates normalized to
// YYYY-MM-DD for the requested year (a defaults record carries no year of
// its own). No admin override applied — see configFor for the effective
// record.
function baseConfigFor(season, year) {
  const record = resolve(season, year);
  if (!record) return null;
  const y = Number(year);
  const stamp = (field) => {
    const md = record.parsed[field];
    if (!Number.isFinite(y)) {
      // publicBookingFrom may be synthesized from serviceableFrom, so it
      // has no raw text of its own — render the parsed month/day.
      return record.raw[field] || `${String(md.month).padStart(2, "0")}-${String(md.day).padStart(2, "0")}`;
    }
    return `${y}-${String(md.month).padStart(2, "0")}-${String(md.day).padStart(2, "0")}`;
  };
  return {
    serviceableFrom: stamp("serviceableFrom"),
    serviceableThrough: stamp("serviceableThrough"),
    publicBookingFrom: stamp("publicBookingFrom"),
    publicBookingThrough: stamp("publicBookingThrough")
  };
}

// The EFFECTIVE season record: seasons.json with any valid admin override
// of the public booking window merged in. This is what the availability
// season gate consumes.
function configFor(season, year) {
  const base = baseConfigFor(season, year);
  if (!base) return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return base;   // raw MM-DD form — no per-year override
  const o = usableOverride(season, y, base);
  if (!o) return base;
  return {
    ...base,
    publicBookingFrom: o.publicBookingFrom || base.publicBookingFrom,
    publicBookingThrough: o.publicBookingThrough || base.publicBookingThrough
  };
}

// Everything the booking-window editor needs in one read: the effective
// window, what seasons.json alone would say, and the stored override (as
// stored, even the halves currently invalid — the screen should show what
// is set, not silently pretend it isn't).
function publicWindowFor(season, year) {
  const defaults = baseConfigFor(season, year);
  if (!defaults) return null;
  const stored = OVERRIDES[overrideKey(season, Number(year))] || null;
  return {
    effective: configFor(season, year),
    defaults,
    override: stored ? { ...stored } : null
  };
}

// Set (or clear) the public booking window for one season+year from the
// admin UI. Each bound is a full YYYY-MM-DD string, or ""/null to fall
// back to seasons.json for that bound. Throws with an operator-readable
// message on anything invalid; on success writes the store and returns
// the fresh publicWindowFor record.
function setPublicBookingWindow(season, year, { publicBookingFrom, publicBookingThrough } = {}, opts = {}) {
  const y = Number(year);
  if (!Number.isFinite(y)) throw new Error("A four-digit year is required.");
  const base = baseConfigFor(season, y);
  if (!base) throw new Error(`Unknown season "${season}".`);

  const clean = (value, name) => {
    const text = String(value == null ? "" : value).trim();
    if (!text) return null;
    if (!YMD_RE.test(text)) throw new Error(`${name} must be a YYYY-MM-DD date (got "${text}").`);
    if (!text.startsWith(`${y}-`)) throw new Error(`${name} must fall in ${y} (got "${text}").`);
    return text;
  };
  const from = clean(publicBookingFrom, "The opening date");
  const through = clean(publicBookingThrough, "The closing date");

  const effFrom = from || base.publicBookingFrom;
  const effThrough = through || base.publicBookingThrough;
  if (effFrom < base.serviceableFrom) {
    throw new Error(`The season isn't serviceable before ${base.serviceableFrom} — booking can't open earlier than that.`);
  }
  if (effThrough > base.serviceableThrough) {
    throw new Error(`The serviceable season ends ${base.serviceableThrough} — booking can't stay open past it. (Extending the season itself is a seasons.json change.)`);
  }
  if (effFrom > effThrough) {
    throw new Error(`Booking would open ${effFrom} but close ${effThrough} — the window would be empty.`);
  }

  const key = overrideKey(season, y);
  if (!from && !through) {
    delete OVERRIDES[key];
  } else {
    OVERRIDES[key] = {
      ...(from ? { publicBookingFrom: from } : {}),
      ...(through ? { publicBookingThrough: through } : {}),
      updatedAt: new Date().toISOString(),
      actor: String(opts.actor || "admin").slice(0, 120)
    };
  }
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(OVERRIDES, null, 2) + "\n", "utf8");
  return publicWindowFor(season, y);
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
  publicWindowFor,
  setPublicBookingWindow,
  hasExplicitYear,
  // Test/diagnostic surface.
  loadError: () => LOAD_ERROR
};

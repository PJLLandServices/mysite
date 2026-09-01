'use strict';

//
// Fall Closing Territory Export — the shared logic. READ-ONLY, writes NOTHING.
//
// Builds a de-identified JSON summary of properties for offline territory
// analysis: which municipalities hold how many fall-closing properties, how
// big their systems are, and how much fall history each one has.
//
// TWO CALLERS, ONE IMPLEMENTATION:
//   - territory-export-corrected.js  (CLI, stdout, needs shell access)
//   - GET /api/admin/territory-export (admin-gated browser download)
//
// The CLI came first. Its logic moved here rather than being duplicated or
// require()'d from the route, because the script's top level parsed
// process.argv, called process.exit() on a missing file, and wrote to
// stdout — all three are wrong inside an HTTP handler. This module does
// none of that: it takes options, returns an object, and throws
// TerritoryExportError on a fatal. The script and the route each translate
// that into their own idiom (exit 1 / HTTP 500).
//
// PRIVACY. No names, emails, phone numbers, or street addresses leave this
// module. Property ids are replaced by a per-run salted pseudonym, and
// coordinates are rounded to 2 decimals (~1.1 km) — enough to cluster a
// territory, not enough to identify a household. The municipality label is
// the only address-derived field and it is a town name only.
//
// THREE THINGS THIS DOES THAT A NAIVE READ OF properties.json DOES NOT,
// each of which silently corrupts a territory count:
//
//   1. Soft-deleted and archived properties are EXCLUDED. Every other reader
//      in the codebase goes through properties.list(), which drops records
//      carrying deletedAt or archivedAt. Reading the raw file counts trashed
//      and archived properties as live route stops.
//
//   2. Depot pins are treated as MISSING coordinates, not as real ones.
//      geocode() returns PJL_BASE (Newmarket city centre) on every failure
//      path, and records written before that fallback stopped being persisted
//      still carry it. At 2-decimal precision a depot pin lands on 44.06 /
//      -79.46 and is indistinguishable from a genuine downtown-Newmarket
//      property, so it reads as a dense cluster that has no customers in it.
//      Its formattedAddress ("Newmarket, ON, Canada") would also label the
//      row "Newmarket", so that label is suppressed too. Same detection as
//      scripts/audit-property-coords.js.
//
//   3. Coordinates stored as STRINGS are parsed, not discarded. xlsx-imported
//      records store some numeric fields as strings; a typeof check on
//      coords.lat drops those rows into "missing coordinates" and understates
//      coverage. Same coordValue() helper the backfill and audit use.
//
// This module deliberately does NOT require server/lib/properties. That
// module's readAll() calls ensureFile() and can persist one-time id/code
// backfills — a write. Nothing here may write to live customer data, so the
// two filters above are replicated locally against the raw file instead.
// For the same reason every filesystem call below is a read: fsp.readFile
// and fsp.access, never open-for-write, never mkdir.
//

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { PJL_BASE } = require('./geocode');

// server/lib/territory-export.js → server/data
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

const COORD_PRECISION = 2;

// Tight enough that only the literal fallback matches, not a real address
// that happens to be downtown Newmarket. Mirrors audit-property-coords.js.
const BASE_EPSILON = 0.0005;

// Same ~150 km sanity box the backfill and coord audit use.
const SERVICE_CENTRE = { lat: 44.05, lng: -79.46 };
const SERVICE_TOLERANCE_DEG = 1.5;

/** Fatal that the caller renders in its own idiom (exit 1 / HTTP 500). */
class TerritoryExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TerritoryExportError';
  }
}

/* ---------------------------------------------------------------- *
 * Helpers — pure, no I/O.
 * ---------------------------------------------------------------- */

// A string "44.05" is a valid coordinate, not a missing one — xlsx-imported
// records store some numeric fields as strings.
function coordValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const round = (n) => (n === null ? null : Number(n.toFixed(COORD_PRECISION)));

// geocode() returns PJL_BASE on every failure path. Anything that persisted
// it pinned a real customer at the depot.
function isDepotPin(prop) {
  const c = prop?.coords;
  if (!c || typeof c !== 'object') return false;
  if (c.source === 'pjl-base') return true;
  const lat = coordValue(c.lat);
  const lng = coordValue(c.lng);
  if (lat === null || lng === null) return false;
  return Math.abs(lat - PJL_BASE.lat) < BASE_EPSILON
    && Math.abs(lng - PJL_BASE.lng) < BASE_EPSILON;
}

function isOutsideServiceArea(lat, lng) {
  if (lat === null || lng === null) return false;
  return Math.abs(lat - SERVICE_CENTRE.lat) > SERVICE_TOLERANCE_DEG
    || Math.abs(lng - SERVICE_CENTRE.lng) > SERVICE_TOLERANCE_DEG;
}

/**
 * Best-effort municipality label from a Google formatted address,
 * e.g. "123 Main St, Aurora, ON L4G 1A1, Canada" → "Aurora".
 * Cosmetic only — clustering runs on coordinates, never on this.
 * Returns null rather than a guess when the shape doesn't match.
 */
function municipalityLabel(prop) {
  const source = prop?.coords?.formattedAddress || prop?.address || '';
  if (typeof source !== 'string' || !source.trim()) return null;
  const parts = source.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  // Walk back from the end past country and province/postal segments.
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (/canada/i.test(seg)) continue;
    if (/^(ON|Ontario)\b/i.test(seg)) continue;
    if (/^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i.test(seg)) continue;
    return seg;
  }
  return null;
}

/** zones[] wins over the declared zoneCount when both exist. */
function zoneCount(prop) {
  const zones = prop?.system?.zones;
  if (Array.isArray(zones) && zones.length > 0) return zones.length;
  const declared = prop?.system?.zoneCount;
  return Number.isFinite(declared) ? declared : null;
}

// Fall closings in serviceRecords, bucketed by calendar year. UTC is safe
// here: fall closings run Sep–Nov, nowhere near a year boundary where a
// local-vs-UTC day could land the record in the wrong bucket.
function fallClosingsByYear(prop) {
  const records = Array.isArray(prop?.serviceRecords) ? prop.serviceRecords : [];
  const byYear = {};
  for (const r of records) {
    if (!r || r.woType !== 'fall_closing') continue;
    const when = r.completedAt ? new Date(r.completedAt) : null;
    if (!when || Number.isNaN(when.getTime())) continue;
    const y = when.getUTCFullYear();
    byYear[y] = (byYear[y] || 0) + 1;
  }
  return byYear;
}

/**
 * Download filename for a given moment: territory-export-YYYY-MM-DD.json.
 * UTC, matching the export's own `generatedAt` — the two always agree on
 * which day the file is from. (Render runs UTC, so this is also local.)
 */
function exportFilename(when = new Date()) {
  return `territory-export-${when.toISOString().slice(0, 10)}.json`;
}

/* ---------------------------------------------------------------- *
 * The build
 * ---------------------------------------------------------------- */

async function loadJson(dataDir, filename, { required }, notes) {
  const filePath = path.join(dataDir, filename);
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (required) {
        throw new TerritoryExportError(
          `${filePath} not found. server/data/ is gitignored runtime data — this export only ` +
          'works on the instance holding the live data.'
        );
      }
      notes.push(`${filename} not found — dependent fields omitted.`);
      return null;
    }
    throw new TerritoryExportError(`could not read ${filePath} — ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TerritoryExportError(`could not parse ${filePath} — ${err.message}`);
  }
  // Both stores are written as bare arrays. Tolerate a keyed wrapper
  // rather than silently exporting nothing if that ever changes.
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['properties', 'customers', 'items', 'records', 'data']) {
    if (parsed && Array.isArray(parsed[key])) return parsed[key];
  }
  notes.push(`${filename} parsed to an unexpected shape — treated as empty.`);
  return [];
}

/**
 * Build the de-identified territory export.
 *
 * @param {object}  [options]
 * @param {string}  [options.dataDir] directory holding properties.json /
 *                  customers.json. Defaults to server/data.
 * @param {number}  [options.year]    target season year for the per-season
 *                  opt-out flag. Defaults to the current UTC year.
 * @returns {Promise<object>} the export payload (JSON-serializable).
 * @throws  {TerritoryExportError} on a missing/unreadable properties.json.
 */
async function buildTerritoryExport(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;

  // Target season year for the per-season opt-out flag. A property can be
  // skipped for one fall without its eligibility being flipped permanently,
  // and a skipped property is not a stop on this fall's route.
  const targetYear = Number.isFinite(Number(options.year)) && options.year !== null && options.year !== ''
    ? Number(options.year)
    : new Date().getUTCFullYear();
  const SEASON_KEY = `${targetYear}:fall`;

  const notes = [];

  const allProperties = (await loadJson(dataDir, 'properties.json', { required: true }, notes) || [])
    .filter(Boolean);
  const customers = await loadJson(dataDir, 'customers.json', { required: false }, notes);

  /* -------------------------------------------------------------- *
   * Live set — what properties.list() would return.
   * -------------------------------------------------------------- */

  const deletedCount = allProperties.filter((p) => p.deletedAt).length;
  const archivedCount = allProperties.filter((p) => !p.deletedAt && p.archivedAt).length;
  const properties = allProperties.filter((p) => !p.deletedAt && !p.archivedAt);

  if (deletedCount || archivedCount) {
    notes.push(
      `Excluded ${deletedCount} soft-deleted and ${archivedCount} archived propert` +
      `${deletedCount + archivedCount === 1 ? 'y' : 'ies'} — matches properties.list().`
    );
  }

  /* -------------------------------------------------------------- *
   * Customer join — probe rather than assume.
   * The commercial flag lives on the customer record (accountType), so we
   * need whatever field links a property to its customer.
   * -------------------------------------------------------------- */

  const CANDIDATE_JOIN_KEYS = ['customerId', 'customer_id', 'customerID', 'custId', 'ownerId'];
  let joinKey = null;

  for (const key of CANDIDATE_JOIN_KEYS) {
    if (properties.some((p) => p[key])) { joinKey = key; break; }
  }

  if (!joinKey) {
    const sample = properties.find(Boolean) || {};
    notes.push(
      'No property→customer join field found among: ' + CANDIDATE_JOIN_KEYS.join(', ') +
      '. Commercial/residential split unavailable. Top-level property keys present: ' +
      Object.keys(sample).join(', ')
    );
  } else {
    notes.push(`Property→customer join resolved via "${joinKey}".`);
  }

  const customerById = new Map();
  if (customers && joinKey) {
    for (const c of customers) {
      if (c && c.id) customerById.set(c.id, c);
    }
    if (customerById.size === 0) {
      notes.push('customers.json loaded but no records carried an "id" field — commercial split unavailable.');
    }
  }

  // Stable short pseudonym. Salted per-run so ids are not reversible and
  // cannot be dictionary-attacked against a known property-id list. The
  // cost is that refs do not line up between two exports.
  const RUN_SALT = crypto.randomBytes(16).toString('hex');
  const pseudonym = (id) =>
    crypto.createHash('sha256').update(RUN_SALT + String(id)).digest('hex').slice(0, 8);

  /* -------------------------------------------------------------- *
   * Build the export
   * -------------------------------------------------------------- */

  const rows = properties.map((p, i) => {
    const customer = joinKey ? customerById.get(p[joinKey]) : null;

    const depotPinned = isDepotPin(p);
    const rawLat = depotPinned ? null : coordValue(p?.coords?.lat);
    const rawLng = depotPinned ? null : coordValue(p?.coords?.lng);
    const lat = round(rawLat);
    const lng = round(rawLng);
    const hasCoords = lat !== null && lng !== null;

    const coordIssue = depotPinned ? 'depot_pin'
      : !hasCoords ? 'missing'
      : isOutsideServiceArea(rawLat, rawLng) ? 'outside_service_area'
      : null;

    const seasonState = p?.seasonalOutreach?.[SEASON_KEY];

    return {
      ref: pseudonym(p.id || p.code || p.addressNormalized || `row-${i}`),
      lat,
      lng,
      hasCoords,
      // null on a depot pin: the fallback's own "Newmarket, ON, Canada" would
      // otherwise label a failed geocode as a genuine Newmarket property.
      coordIssue,
      municipality: depotPinned ? null : municipalityLabel(p),
      // Opt-out semantics: absent/undefined counts as eligible, matching
      // outreach.listCandidates (`fallClosing !== false`).
      fallEligible: p?.seasonalEligibility?.fallClosing !== false,
      fallEligibilityExplicit: p?.seasonalEligibility?.fallClosing !== undefined,
      // Skipped for THIS fall without eligibility being flipped permanently.
      optedOutThisSeason: seasonState?.optOutThisSeason === true,
      zoneCount: zoneCount(p),
      zoneCountSource: Array.isArray(p?.system?.zones) && p.system.zones.length > 0
        ? 'zones_array'
        : (Number.isFinite(p?.system?.zoneCount) ? 'declared' : 'none'),
      hasAdditionalFallBlowout: p?.seasonalPricing?.hasAdditionalFallBlowout === true,
      accountType: customer
        ? (customer.accountType === 'commercial' ? 'commercial' : 'residential')
        : null,
      fallClosingsByYear: fallClosingsByYear(p),
      serviceRecordCount: Array.isArray(p?.serviceRecords) ? p.serviceRecords.length : 0,
    };
  });

  const withCoords = rows.filter((r) => r.hasCoords).length;
  const depotPinned = rows.filter((r) => r.coordIssue === 'depot_pin').length;

  if (depotPinned) {
    notes.push(
      `${depotPinned} propert${depotPinned === 1 ? 'y is' : 'ies are'} pinned at the PJL depot ` +
      '(failed geocode) — reported as missing coordinates, not as a Newmarket cluster. ' +
      'Fix with scripts/audit-property-coords.js.'
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    seasonYear: targetYear,
    coordPrecisionDecimals: COORD_PRECISION,
    summary: {
      totalPropertiesInFile: allProperties.length,
      excludedDeleted: deletedCount,
      excludedArchived: archivedCount,
      totalProperties: rows.length,
      withCoords,
      missingCoords: rows.length - withCoords,
      depotPinned,
      outsideServiceArea: rows.filter((r) => r.coordIssue === 'outside_service_area').length,
      coordCoveragePct: rows.length
        ? Number(((withCoords / rows.length) * 100).toFixed(1))
        : 0,
      fallEligible: rows.filter((r) => r.fallEligible).length,
      fallEligibilityExplicitlySet: rows.filter((r) => r.fallEligibilityExplicit).length,
      optedOutThisSeason: rows.filter((r) => r.optedOutThisSeason).length,
      everHadFallClosing: rows.filter((r) => Object.keys(r.fallClosingsByYear).length > 0).length,
      municipalityLabelResolved: rows.filter((r) => r.municipality).length,
      accountTypeResolved: rows.filter((r) => r.accountType).length,
    },
    notes,
    properties: rows,
  };
}

module.exports = {
  buildTerritoryExport,
  exportFilename,
  TerritoryExportError,
  DEFAULT_DATA_DIR,
  COORD_PRECISION,
  // Exported for the test suite — the three guards, checkable in isolation.
  _internals: { coordValue, isDepotPin, isOutsideServiceArea, municipalityLabel, zoneCount, fallClosingsByYear },
};

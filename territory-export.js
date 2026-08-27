#!/usr/bin/env node
/**
 * PJL — Fall Closing Territory Export
 *
 * READ-ONLY. Opens two JSON files, writes nothing, calls no APIs.
 * Prints a de-identified JSON blob to stdout for offline analysis.
 *
 * Run from the repo root on the instance where server/data/ lives:
 *
 *     node territory-export.js > territory-export.json
 *
 * Contains no names, emails, phone numbers, or street addresses.
 * Coordinates are rounded to 2 decimal places (~1.1 km) — enough to
 * cluster territories, not enough to identify a household.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'server', 'data');
const COORD_PRECISION = 2;

const notes = [];

function loadJson(filename, { required }) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    if (required) {
      console.error(`FATAL: ${filePath} not found. Run this from the repo root on the instance holding server/data/.`);
      process.exit(1);
    }
    notes.push(`${filename} not found — dependent fields omitted.`);
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Stores may be a bare array or wrapped in a keyed object.
    if (Array.isArray(parsed)) return parsed;
    for (const key of ['properties', 'customers', 'items', 'records', 'data']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    if (parsed && typeof parsed === 'object') return Object.values(parsed);
    notes.push(`${filename} parsed to an unexpected shape — treated as empty.`);
    return [];
  } catch (err) {
    console.error(`FATAL: could not parse ${filePath} — ${err.message}`);
    process.exit(1);
  }
}

const properties = loadJson('properties.json', { required: true });
const customers = loadJson('customers.json', { required: false });

/* ---------------------------------------------------------------- *
 * Customer join — probe rather than assume.
 * The commercial flag lives on the customer record (accountType),
 * so we need whatever field links a property to its customer.
 * ---------------------------------------------------------------- */

const CANDIDATE_JOIN_KEYS = ['customerId', 'customer_id', 'customerID', 'custId', 'ownerId'];
let joinKey = null;

for (const key of CANDIDATE_JOIN_KEYS) {
  if (properties.some((p) => p && p[key])) { joinKey = key; break; }
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

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

// Stable short pseudonym. Salted per-run so IDs are not reversible
// across exports and cannot be dictionary-attacked against a known
// property ID list.
const RUN_SALT = crypto.randomBytes(16).toString('hex');
const pseudonym = (id) =>
  crypto.createHash('sha256').update(RUN_SALT + String(id)).digest('hex').slice(0, 8);

const round = (n) => (typeof n === 'number' && Number.isFinite(n))
  ? Number(n.toFixed(COORD_PRECISION))
  : null;

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

/** Fall closings in serviceRecords, bucketed by calendar year. */
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

/* ---------------------------------------------------------------- *
 * Build the export
 * ---------------------------------------------------------------- */

const rows = properties.filter(Boolean).map((p) => {
  const customer = joinKey ? customerById.get(p[joinKey]) : null;
  const lat = round(p?.coords?.lat);
  const lng = round(p?.coords?.lng);

  return {
    ref: pseudonym(p.id || p.addressNormalized || JSON.stringify(p).slice(0, 64)),
    lat,
    lng,
    hasCoords: lat !== null && lng !== null,
    municipality: municipalityLabel(p),
    // Opt-out semantics: absent/undefined counts as eligible.
    fallEligible: p?.seasonalEligibility?.fallClosing !== false,
    fallEligibilityExplicit: p?.seasonalEligibility?.fallClosing !== undefined,
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

const output = {
  generatedAt: new Date().toISOString(),
  coordPrecisionDecimals: COORD_PRECISION,
  summary: {
    totalProperties: rows.length,
    withCoords,
    missingCoords: rows.length - withCoords,
    coordCoveragePct: rows.length
      ? Number(((withCoords / rows.length) * 100).toFixed(1))
      : 0,
    fallEligible: rows.filter((r) => r.fallEligible).length,
    fallEligibilityExplicitlySet: rows.filter((r) => r.fallEligibilityExplicit).length,
    everHadFallClosing: rows.filter((r) => Object.keys(r.fallClosingsByYear).length > 0).length,
    municipalityLabelResolved: rows.filter((r) => r.municipality).length,
    accountTypeResolved: rows.filter((r) => r.accountType).length,
  },
  notes,
  properties: rows,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');

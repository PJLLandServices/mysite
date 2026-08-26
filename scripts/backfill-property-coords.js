#!/usr/bin/env node
//
// Geocode backfill for live properties missing coordinates.
//
// Roughly 29 live properties carry a complete street address but
// `coords: null`. They were written by the xlsx bulk-import path
// (`properties.bulkUpsert`), which never geocodes — unlike the admin
// create path (server.js POST /api/properties), which does. This fills
// the gap in place using the existing geocoder.
//
// Usage:
//   node scripts/backfill-property-coords.js            (DRY RUN — no API calls, no writes)
//   node scripts/backfill-property-coords.js --apply
//
// DRY RUN resolves from the on-disk cache ONLY. It makes no network
// calls, spends no API quota, and writes nothing — so you can check the
// target count and the address list before committing to a live run.
// Anything not already cached is reported as "would call API".
//
// --apply backs up properties.json + geocode-cache.json first, to:
//   server/data-backup-<UTC stamp>-geocode-backfill/
//
// WHY THIS SCRIPT AND NOT 29 MANUAL RE-SAVES:
// PATCH /api/properties/:id re-geocodes only when the address STRING
// CHANGES (server.js: `if (newAddress && newAddress !== previousAddress)`).
// These records already have correct addresses, so re-saving them in the
// admin is a no-op for coords. There is no manual path that fills them.
//
// ⚠️  THE PJL_BASE TRAP — the single most important line in this file.
// geocode() NEVER returns null and NEVER throws. On EVERY failure path
// (no API key, ZERO_RESULTS, network error, empty address) it returns
// `{ ok: false, skipped: true, coords: PJL_BASE }` where PJL_BASE is
// Newmarket city centre, 44.0592/-79.4613. Writing `geo.coords` without
// checking would stamp city centre onto every unresolvable property —
// and a naive sanity-box check CANNOT catch that, because PJL_BASE is
// the exact centre of the box. That is the "wrong is worse than missing"
// failure: 29 properties silently pinned to a plausible point that is
// not theirs, landing them in the wrong service ring with nothing
// visibly broken. Hence `isRealResult()` below, which demands
// `ok === true` AND a source that is not "pjl-base".

const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "server", "data");
const CACHE_PATH = path.join(DATA, "geocode-cache.json");
const PROPERTIES_PATH = path.join(DATA, "properties.json");

const properties = require(path.join(ROOT, "server", "lib", "properties"));
const { geocode, isConfigured } = require(path.join(ROOT, "server", "lib", "geocode"));

const APPLY = process.argv.includes("--apply");

// Newmarket. Anything further than TOLERANCE_DEG from here in either
// axis is rejected unwritten — roughly a 150 km box, comfortably larger
// than the service area. A previous analysis found imported records
// geocoded to northern Ontario, ~800 km out; those must not land.
const CENTRE = { lat: 44.05, lng: -79.46 };
const TOLERANCE_DEG = 1.5;

// 200ms between API calls. Ample for ~29 records, avoids burst throttling.
const RATE_LIMIT_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors normalizeKey() in server/lib/geocode.js, which does not export
// it. Used ONLY for the dry run's read-only cache probe — the --apply
// path calls geocode() itself and never relies on this. If the key
// format there ever changes, the dry run under-reports cache hits (it
// would show "would call API" for an address that is in fact cached);
// it cannot cause a bad write.
function cacheKey(address) {
  return String(address || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Some numeric fields in xlsx-imported records are stored as STRINGS.
// A string "44.05" is a valid coordinate, not a missing one — treating
// it as missing would cause a needless API call and a needless write.
// Returns a finite number, or null when genuinely absent/unparseable.
function coordValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasCoords(property) {
  const c = property?.coords;
  if (!c || typeof c !== "object") return false;
  return coordValue(c.lat) !== null && coordValue(c.lng) !== null;
}

function needsBackfill(property) {
  if (!String(property?.address || "").trim()) return false;
  return !hasCoords(property);
}

// The PJL_BASE guard. `ok` alone is not enough to be safe against a
// future edit to geocode.js, so the source is checked too.
function isRealResult(geo) {
  if (!geo || geo.ok !== true || geo.skipped === true) return false;
  const c = geo.coords;
  if (!c || typeof c !== "object") return false;
  if (c.source === "pjl-base") return false;
  return coordValue(c.lat) !== null && coordValue(c.lng) !== null;
}

function withinSanityBox(coords) {
  const lat = coordValue(coords.lat);
  const lng = coordValue(coords.lng);
  if (lat === null || lng === null) return false;
  return Math.abs(lat - CENTRE.lat) <= TOLERANCE_DEG
    && Math.abs(lng - CENTRE.lng) <= TOLERANCE_DEG;
}

function label(property) {
  return property.code || property.id || "(no id)";
}

async function readCache() {
  try {
    if (!fsSync.existsSync(CACHE_PATH)) return {};
    const parsed = JSON.parse(await fs.readFile(CACHE_PATH, "utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Backups go INSIDE server/data/ deliberately. On Render only that path
// is a persistent disk mount — a sibling directory lives on the container
// filesystem and is destroyed by the next deploy or restart, which is
// worthless as an undo for a write to live customer data. Two small JSON
// files against a 1 GB disk is a rounding error.
async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA, `BACKUP-${stamp}-geocode-backfill`);
  await fs.mkdir(dir, { recursive: true });
  for (const file of ["properties.json", "geocode-cache.json"]) {
    try {
      await fs.copyFile(path.join(DATA, file), path.join(dir, file));
    } catch {
      /* absent file — nothing to back up */
    }
  }
  return dir;
}

async function main() {
  // ---- Preflight ------------------------------------------------------
  if (!fsSync.existsSync(PROPERTIES_PATH)) {
    console.error(`\n  ABORT — ${PROPERTIES_PATH} does not exist.`);
    console.error("  server/data/* is gitignored; run this where the live data lives.\n");
    process.exit(1);
  }

  const keyPresent = isConfigured();
  if (!keyPresent) {
    console.warn("\n  ⚠️  GOOGLE_MAPS_SERVER_KEY is NOT set.");
    console.warn("     Nothing can be resolved except from the existing cache. Uncached");
    console.warn("     addresses will be reported as failures (reason: no key) and left");
    console.warn("     untouched — no PJL-base coords will be written. Set the key and");
    console.warn("     re-run to resolve the rest.");
  }

  const all = await properties.list(); // excludes deletedAt + archivedAt by default
  const targets = all.filter(needsBackfill);

  console.log(`\n  Live properties (not deleted, not archived): ${all.length}`);
  console.log(`  Targets — address present, coords missing:   ${targets.length}`);

  if (targets.length > 40) {
    console.error(`\n  ABORT — ${targets.length} targets is far more than the expected ~29.`);
    console.error("  Something is wrong with the selection or the data. Investigate first.\n");
    process.exit(1);
  }
  if (!targets.length) {
    console.log("\n  Nothing to do — every live property with an address has coordinates.\n");
    return;
  }

  const cache = await readCache();
  const cachedTargets = targets.filter((p) => Boolean(cache[cacheKey(p.address)]));
  console.log(`  Already in geocode cache (no API call needed):  ${cachedTargets.length}`);
  console.log(`  Would require a live API call:                  ${targets.length - cachedTargets.length}`);

  // ---- Dry run --------------------------------------------------------
  if (!APPLY) {
    console.log("\n  DRY RUN — no API calls, no writes.\n");
    console.log("  Targets:");
    for (const p of targets) {
      const cached = Boolean(cache[cacheKey(p.address)]);
      let note = cached ? "cached" : "would call API";
      if (cached && !withinSanityBox(cache[cacheKey(p.address)])) {
        note = "cached BUT OUTSIDE SANITY BOX — would be rejected";
      }
      console.log(`    ${label(p).padEnd(14)} [${note}]  ${p.address}`);
    }
    reportExistingOutliers(all);
    console.log("\n  Re-run with --apply to geocode and write.\n");
    return;
  }

  // ---- Apply ----------------------------------------------------------
  const backupDir = await backup();
  console.log(`\n  backup: ${backupDir}`);
  console.log("\n  Backfilling...\n");

  const stats = { fromCache: 0, fromApi: 0, failed: 0, rejected: 0, written: 0 };
  const failures = [];
  const rejections = [];

  for (const property of targets) {
    const address = String(property.address || "").trim();
    let geo;
    try {
      geo = await geocode(address);
    } catch (err) {
      // geocode() catches internally, but never trust that from a caller.
      geo = { ok: false, reason: err?.message || "threw" };
    }

    if (!isRealResult(geo)) {
      stats.failed += 1;
      const reason = geo?.reason || geo?.error || (geo?.ok ? "unusable result" : "no result");
      failures.push({ property, address, reason });
      console.log(`    ✗ ${label(property).padEnd(14)} FAILED (${reason})  ${address}`);
      if (!geo?.fromCache) await sleep(RATE_LIMIT_MS);
      continue;
    }

    const coords = geo.coords;
    if (!withinSanityBox(coords)) {
      stats.rejected += 1;
      rejections.push({ property, address, coords });
      console.log(
        `    ⚠ ${label(property).padEnd(14)} REJECTED ${coordValue(coords.lat)},${coordValue(coords.lng)}`
        + ` — outside sanity box  ${address}`
      );
      if (!geo.fromCache) await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (geo.fromCache) stats.fromCache += 1;
    else stats.fromApi += 1;

    // Write via the lib helper, which stamps updatedAt itself. Only
    // `coords` is patched — no other field is touched. Shape matches the
    // PATCH route (server.js): { lat, lng, formattedAddress }, three keys.
    const updated = await properties.update(property.id, {
      coords: {
        lat: coordValue(coords.lat),
        lng: coordValue(coords.lng),
        formattedAddress: coords.formattedAddress || address
      }
    });

    if (!updated) {
      stats.failed += 1;
      if (geo.fromCache) stats.fromCache -= 1;
      else stats.fromApi -= 1;
      failures.push({ property, address, reason: "properties.update returned null (record vanished?)" });
      console.log(`    ✗ ${label(property).padEnd(14)} WRITE FAILED  ${address}`);
      continue;
    }

    stats.written += 1;
    console.log(
      `    ✓ ${label(property).padEnd(14)} ${coordValue(coords.lat)},${coordValue(coords.lng)}`
      + `${geo.fromCache ? " (cache)" : ""}  ${coords.formattedAddress || address}`
    );

    if (!geo.fromCache) await sleep(RATE_LIMIT_MS);
  }

  // ---- Report ---------------------------------------------------------
  console.log("\n  ─────────────────────────────────────────────");
  console.log("  Measure                            Count");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Targets identified                 ${targets.length}`);
  console.log(`  Resolved from cache (no API call)  ${stats.fromCache}`);
  console.log(`  Resolved via API                   ${stats.fromApi}`);
  console.log(`  Failed — no result returned        ${stats.failed}`);
  console.log(`  Rejected — outside sanity box      ${stats.rejected}`);
  console.log(`  Records written                    ${stats.written}`);
  console.log("  ─────────────────────────────────────────────");

  if (failures.length) {
    console.log("\n  FAILURES — need manual attention:");
    for (const f of failures) {
      console.log(`    ${label(f.property)}  [${f.reason}]  ${f.address}`);
    }
  }
  if (rejections.length) {
    console.log("\n  REJECTIONS — geocoded outside the service area, NOT written:");
    for (const r of rejections) {
      console.log(
        `    ${label(r.property)}  got ${coordValue(r.coords.lat)},${coordValue(r.coords.lng)}`
        + ` (${r.coords.formattedAddress || "?"})  for: ${r.address}`
      );
    }
  }
  if (!failures.length && !rejections.length) {
    console.log("\n  No failures, no rejections.");
  }

  // Final coverage, re-read from disk so it reflects what was committed.
  const after = await properties.list();
  const withCoords = after.filter(hasCoords).length;
  console.log(`\n  Coverage across ${after.length} live properties:`);
  console.log(`    with coordinates:    ${withCoords}`);
  console.log(`    still without:       ${after.length - withCoords}`);

  reportExistingOutliers(after);
  console.log("");
}

// Advisory only — never written to, never modified. Flags live records
// whose EXISTING coords sit outside the sanity box (e.g. the northern
// Ontario pins from a previous import). Out of scope for this backfill,
// which only fills missing coords, but worth surfacing since a wrong
// coordinate is exactly what this script exists to avoid creating.
function reportExistingOutliers(list) {
  const outliers = list.filter((p) => hasCoords(p) && !withinSanityBox(p.coords));
  if (!outliers.length) return;
  const plural = outliers.length === 1
    ? "1 live property already carries"
    : `${outliers.length} live properties already carry`;
  console.log(`\n  ADVISORY — ${plural} coords outside the service area`
    + " (NOT touched by this script):");
  for (const p of outliers) {
    console.log(`    ${label(p)}  ${coordValue(p.coords.lat)},${coordValue(p.coords.lng)}  ${p.address}`);
  }
}

main().catch((err) => {
  console.error("\n  Unexpected error:", err);
  process.exit(1);
});

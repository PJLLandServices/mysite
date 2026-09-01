#!/usr/bin/env node
//
// Read-only audit of coordinate quality across live properties.
//
// Coordinates drive proximity routing — the availability engine clusters a
// customer's booking with other jobs near them. So a WRONG coordinate is
// worse than a missing one, and the worst wrong value is the depot itself:
//
//   PJL_BASE = 44.0592, -79.4613 (Newmarket city centre)
//
// geocode() returns PJL_BASE on every failure path. Anything that persisted
// it pinned a real customer at the depot, where it looks close to every job
// in the service area and will slot into any day's route. Because city
// centre sits mid-service-area, no distance check flags it. This audit finds
// those, plus properties with no coordinates at all.
//
// Usage:
//   node scripts/audit-property-coords.js
//
// Writes nothing, calls no API. Safe to run any time.
//
// Exit code is 0 when clean, 1 when anything needs attention, so it can
// gate a cron or a deploy check later if wanted.

const path = require("node:path");
const fsSync = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const PROPERTIES_PATH = path.join(ROOT, "server", "data", "properties.json");
const properties = require(path.join(ROOT, "server", "lib", "properties"));
const { PJL_BASE } = require(path.join(ROOT, "server", "lib", "geocode"));

// Newmarket, and the same ~150 km box the backfill script uses.
const CENTRE = { lat: 44.05, lng: -79.46 };
const TOLERANCE_DEG = 1.5;

// Tight enough that only the literal fallback matches, not a real address
// that happens to be downtown Newmarket.
const BASE_EPSILON = 0.0005;

function coordValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasCoords(p) {
  const c = p?.coords;
  if (!c || typeof c !== "object") return false;
  return coordValue(c.lat) !== null && coordValue(c.lng) !== null;
}

function isDepotPin(p) {
  const c = p?.coords;
  if (!c || typeof c !== "object") return false;
  if (c.source === "pjl-base") return true;
  const lat = coordValue(c.lat);
  const lng = coordValue(c.lng);
  if (lat === null || lng === null) return false;
  return Math.abs(lat - PJL_BASE.lat) < BASE_EPSILON
    && Math.abs(lng - PJL_BASE.lng) < BASE_EPSILON;
}

function isOutsideBox(p) {
  const lat = coordValue(p?.coords?.lat);
  const lng = coordValue(p?.coords?.lng);
  if (lat === null || lng === null) return false;
  return Math.abs(lat - CENTRE.lat) > TOLERANCE_DEG
    || Math.abs(lng - CENTRE.lng) > TOLERANCE_DEG;
}

function label(p) {
  return p.code || p.id || "(no id)";
}

function section(title, rows, render) {
  if (!rows.length) return;
  console.log(`\n  ${title} — ${rows.length}`);
  for (const p of rows) console.log(`    ${label(p).padEnd(14)} ${render(p)}`);
}

async function main() {
  if (!fsSync.existsSync(PROPERTIES_PATH)) {
    console.error(`\n  ABORT — ${PROPERTIES_PATH} does not exist.`);
    console.error("  server/data/* is gitignored; run this where the live data lives.\n");
    process.exit(1);
  }

  const all = await properties.list(); // excludes deletedAt + archivedAt

  const depotPinned = all.filter(isDepotPin);
  const outsideBox = all.filter((p) => hasCoords(p) && !isDepotPin(p) && isOutsideBox(p));
  const missing = all.filter((p) => !hasCoords(p) && String(p.address || "").trim());
  const missingNoAddress = all.filter((p) => !hasCoords(p) && !String(p.address || "").trim());
  const good = all.filter((p) => hasCoords(p) && !isDepotPin(p) && !isOutsideBox(p));

  console.log(`\n  Live properties (not deleted, not archived): ${all.length}`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Good coordinates                   ${good.length}`);
  console.log(`  Pinned at depot (PJL base)         ${depotPinned.length}`);
  console.log(`  Outside service area               ${outsideBox.length}`);
  console.log(`  Missing — has address              ${missing.length}`);
  console.log(`  Missing — no address on record     ${missingNoAddress.length}`);
  console.log("  ─────────────────────────────────────────────");

  section(
    "PINNED AT DEPOT — wrong, and invisible to distance checks",
    depotPinned,
    (p) => `${p.address || "(no address)"}`
  );
  section(
    "OUTSIDE SERVICE AREA — likely mis-geocoded",
    outsideBox,
    (p) => `${coordValue(p.coords.lat)},${coordValue(p.coords.lng)}  ${p.address || "(no address)"}`
  );
  section(
    "MISSING COORDINATES — fixable, run the backfill",
    missing,
    (p) => p.address
  );
  section(
    "NO ADDRESS ON RECORD — nothing to geocode, needs data entry",
    missingNoAddress,
    () => "(no address)"
  );

  const needsAttention = depotPinned.length + outsideBox.length + missing.length + missingNoAddress.length;
  if (!needsAttention) {
    console.log("\n  ✓ Clean — every live property has a plausible coordinate.\n");
    return;
  }

  console.log(`\n  ${needsAttention} propert${needsAttention === 1 ? "y needs" : "ies need"} attention.`);
  if (missing.length) {
    console.log("  → For the missing ones: node scripts/backfill-property-coords.js");
  }
  if (depotPinned.length) {
    console.log("  → Depot pins must be cleared by hand before a re-geocode can");
    console.log("    fill them: the backfill only targets EMPTY coords, so a depot");
    console.log("    pin looks resolved to it and is skipped.");
  }
  console.log("");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n  Unexpected error:", err);
  process.exit(1);
});

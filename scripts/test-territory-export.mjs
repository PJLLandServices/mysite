// Territory export — the three correctness guards, the read-only
// guarantee, the privacy contract, and the admin gate on the download.
//
//   node scripts/test-territory-export.mjs
//
// WHAT THIS COVERS. territory-export-corrected.js was a standalone CLI:
// running it needed shell access to the Render instance. Its logic moved
// into server/lib/territory-export.js so that the CLI and a new admin-gated
// download route (GET /api/admin/territory-export) call ONE implementation
// and cannot drift. This file pins:
//
//   1. The three guards that are the reason the corrected version exists —
//      soft-deleted/archived exclusion, depot-pin detection, string
//      coordinate coercion. Each is asserted on a record built to trip it.
//   2. That the export writes NOTHING. The data directory is checksummed
//      before and after a build, file by file.
//   3. That no name, email, phone or street address reaches the output.
//   4. Source guards on the gate: the path is "admin" in needsAuth(), the
//      route re-checks with requireAdmin, and the response carries
//      Content-Disposition: attachment. Each fails the build if removed.
//   5. That the CLI holds no copy of the logic, and that the superseded
//      territory-export.js is gone.

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const territory = require(path.join(ROOT, "server/lib/territory-export.js"));
const { PJL_BASE } = require(path.join(ROOT, "server/lib/geocode.js"));

// ---- Sandbox --------------------------------------------------------
//
// buildTerritoryExport takes its data directory as an option, so the
// fixtures live in a temp dir. Real customer data is never opened and
// nothing under server/data/ is touched.

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-territory-"));
const DATA_DIR = path.join(SANDBOX, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Identifying strings are seeded into EVERY fixture record so the privacy
// assertions below have something real to catch if a field ever leaks.
const SECRETS = {
  name: "Wilhelmina Fitzgerald-Okonkwo",
  email: "wilhelmina.fitz@example.invalid",
  phone: "905-555-0148",
  street: "417 Bayview Ridge Crescent",
};

function baseProp(overrides = {}) {
  return {
    id: `p-${Math.random().toString(36).slice(2, 10)}`,
    customerId: "c-1",
    customerName: SECRETS.name,
    customerPhone: SECRETS.phone,
    customerEmail: SECRETS.email,
    address: `${SECRETS.street}, Aurora, ON L4G 1A1, Canada`,
    coords: { lat: 44.0, lng: -79.47, formattedAddress: `${SECRETS.street}, Aurora, ON L4G 1A1, Canada` },
    system: { zoneCount: 8 },
    serviceRecords: [],
    ...overrides,
  };
}

const FIXTURE_PROPERTIES = [
  // Live, ordinary, numeric coords.
  baseProp({ id: "p-live-1" }),
  baseProp({ id: "p-live-2", system: { zones: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] } }),
  // GUARD 1 — soft-deleted and archived must not be counted.
  baseProp({ id: "p-deleted", deletedAt: "2026-06-01T00:00:00.000Z" }),
  baseProp({ id: "p-archived", archivedAt: "2026-06-01T00:00:00.000Z" }),
  // Both flags at once — counted as deleted, never double-counted.
  baseProp({ id: "p-deleted-and-archived", deletedAt: "2026-06-01T00:00:00.000Z", archivedAt: "2026-06-02T00:00:00.000Z" }),
  // GUARD 2 — depot pin by coordinate proximity, no source marker.
  baseProp({
    id: "p-depot-coords",
    coords: { lat: PJL_BASE.lat, lng: PJL_BASE.lng, formattedAddress: "Newmarket, ON, Canada" },
  }),
  // GUARD 2 — depot pin declared by source, coords anywhere.
  baseProp({
    id: "p-depot-source",
    coords: { lat: 43.9, lng: -79.2, source: "pjl-base", formattedAddress: "Newmarket, ON, Canada" },
  }),
  // GUARD 3 — xlsx import: coordinates stored as strings.
  baseProp({
    id: "p-string-coords",
    coords: { lat: "44.12", lng: "-79.51", formattedAddress: `${SECRETS.street}, Newmarket, ON L3Y 2B2, Canada` },
  }),
  // No coordinates at all.
  baseProp({ id: "p-no-coords", coords: null }),
  // Well outside the ~150 km box.
  baseProp({
    id: "p-far",
    coords: { lat: 49.28, lng: -123.12, formattedAddress: "Vancouver, BC V6B 1A1, Canada" },
  }),
  // Commercial account + fall history + this-season opt-out.
  baseProp({
    id: "p-commercial",
    customerId: "c-2",
    seasonalEligibility: { fallClosing: true },
    seasonalOutreach: { "2026:fall": { optOutThisSeason: true } },
    seasonalPricing: { hasAdditionalFallBlowout: true },
    serviceRecords: [
      { woType: "fall_closing", completedAt: "2024-10-14T14:00:00.000Z" },
      { woType: "fall_closing", completedAt: "2025-10-20T14:00:00.000Z" },
      { woType: "spring_opening", completedAt: "2025-04-20T14:00:00.000Z" },
      { woType: "fall_closing", completedAt: null },
    ],
  }),
  // Permanently opted out of fall.
  baseProp({ id: "p-opted-out", seasonalEligibility: { fallClosing: false } }),
];

const FIXTURE_CUSTOMERS = [
  { id: "c-1", name: SECRETS.name, email: SECRETS.email, phone: SECRETS.phone, accountType: "residential" },
  { id: "c-2", name: "Bayview Plaza Holdings", email: "ap@example.invalid", accountType: "commercial" },
];

fs.writeFileSync(path.join(DATA_DIR, "properties.json"), JSON.stringify(FIXTURE_PROPERTIES, null, 2));
fs.writeFileSync(path.join(DATA_DIR, "customers.json"), JSON.stringify(FIXTURE_CUSTOMERS, null, 2));

// ---- Read-only: checksum the data directory before and after ---------

function dirChecksums(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    out[entry] = stat.isDirectory()
      ? "<dir>"
      : crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  return out;
}

const before = dirChecksums(DATA_DIR);

const out = await territory.buildTerritoryExport({ dataDir: DATA_DIR, year: 2026 });

const after = dirChecksums(DATA_DIR);

ok("data directory contents unchanged by a build",
  JSON.stringify(before) === JSON.stringify(after),
  `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
ok("no file created in the data directory",
  Object.keys(before).length === Object.keys(after).length && Object.keys(after).length === 2);

// ---- Shape -----------------------------------------------------------

ok("output carries a summary block", out.summary && typeof out.summary === "object");
ok("output carries notes", Array.isArray(out.notes));
ok("output carries per-property rows", Array.isArray(out.properties));
ok("generatedAt is an ISO timestamp", typeof out.generatedAt === "string" && !Number.isNaN(Date.parse(out.generatedAt)));
ok("seasonYear echoes the requested year", out.seasonYear === 2026);
ok("coordinate precision is declared", out.coordPrecisionDecimals === 2);
ok("output is JSON-serializable", (() => { try { JSON.parse(JSON.stringify(out)); return true; } catch { return false; } })());

const byRef = new Map(out.properties.map((r) => [r.ref, r]));
ok("every row carries a ref", out.properties.every((r) => typeof r.ref === "string" && r.ref.length === 8));
ok("refs are unique", byRef.size === out.properties.length);

// ---- GUARD 1: soft-deleted and archived are excluded ------------------

ok("guard 1 — total in file counts every record", out.summary.totalPropertiesInFile === FIXTURE_PROPERTIES.length);
ok("guard 1 — two soft-deleted records excluded", out.summary.excludedDeleted === 2);
ok("guard 1 — one archived record excluded", out.summary.excludedArchived === 1);
ok("guard 1 — a record with both flags counts as deleted only",
  out.summary.excludedDeleted + out.summary.excludedArchived === 3);
ok("guard 1 — live rows are file total minus exclusions",
  out.summary.totalProperties === FIXTURE_PROPERTIES.length - 3);
ok("guard 1 — row count matches the summary", out.properties.length === out.summary.totalProperties);
ok("guard 1 — the exclusion is noted", out.notes.some((n) => /soft-deleted/i.test(n) && /properties\.list\(\)/.test(n)));

// ---- GUARD 2: depot pins are flagged, not treated as real -------------

const depotRows = out.properties.filter((r) => r.coordIssue === "depot_pin");
ok("guard 2 — both depot pins detected", depotRows.length === 2, `found ${depotRows.length}`);
ok("guard 2 — summary counts the depot pins", out.summary.depotPinned === 2);
ok("guard 2 — a depot pin reports no coordinates", depotRows.every((r) => r.lat === null && r.lng === null));
ok("guard 2 — a depot pin is not counted as having coords", depotRows.every((r) => r.hasCoords === false));
ok("guard 2 — the fallback's Newmarket label is suppressed", depotRows.every((r) => r.municipality === null));
ok("guard 2 — no live row sits on the depot coordinate",
  !out.properties.some((r) => r.lat !== null && Math.abs(r.lat - PJL_BASE.lat) < 0.005 && Math.abs(r.lng - PJL_BASE.lng) < 0.005));
ok("guard 2 — the depot pins are noted", out.notes.some((n) => /depot/i.test(n)));

// ---- GUARD 3: string coordinates are parsed, not dropped --------------

const stringCoordRow = out.properties.find((r) => r.lat === 44.12);
ok("guard 3 — a string-typed coordinate becomes a number", Boolean(stringCoordRow));
ok("guard 3 — its longitude parsed too", stringCoordRow && stringCoordRow.lng === -79.51);
ok("guard 3 — it counts as having coordinates", stringCoordRow && stringCoordRow.hasCoords === true);
ok("guard 3 — it is not reported as missing", stringCoordRow && stringCoordRow.coordIssue === null);
ok("guard 3 — the helper accepts a numeric string", territory._internals.coordValue("44.12") === 44.12);
ok("guard 3 — and still rejects a non-numeric one", territory._internals.coordValue("not a number") === null);
ok("guard 3 — and treats empty string as missing", territory._internals.coordValue("") === null);

// ---- Remaining classification ----------------------------------------

ok("a record with no coords block is missing, not depot-pinned",
  out.properties.some((r) => r.coordIssue === "missing"));
ok("a far-away record is flagged outside the service area",
  out.summary.outsideServiceArea === 1);
ok("coordinate coverage is a percentage",
  out.summary.coordCoveragePct >= 0 && out.summary.coordCoveragePct <= 100);
ok("withCoords + missingCoords equals the live row count",
  out.summary.withCoords + out.summary.missingCoords === out.summary.totalProperties);

// ---- Eligibility + season semantics -----------------------------------

ok("absent eligibility counts as eligible",
  out.properties.filter((r) => r.fallEligible).length === out.summary.totalProperties - 1);
ok("an explicit false opts the property out", out.summary.fallEligible === out.summary.totalProperties - 1);
ok("explicitly-set eligibility is counted separately", out.summary.fallEligibilityExplicitlySet === 2);
ok("this-season opt-out is read from the year key", out.summary.optedOutThisSeason === 1);

const otherYear = await territory.buildTerritoryExport({ dataDir: DATA_DIR, year: 2027 });
ok("a different year sees no 2026 season opt-out", otherYear.summary.optedOutThisSeason === 0);
ok("a different year is echoed back", otherYear.seasonYear === 2027);

const defaultYear = await territory.buildTerritoryExport({ dataDir: DATA_DIR });
ok("omitting the year defaults to the current UTC year",
  defaultYear.seasonYear === new Date().getUTCFullYear());

// ---- Zone counts, history, account type -------------------------------

const zonesArrayRow = out.properties.find((r) => r.zoneCountSource === "zones_array");
ok("a zones array wins over the declared count", zonesArrayRow && zonesArrayRow.zoneCount === 12);
ok("a declared count is labelled as declared",
  out.properties.some((r) => r.zoneCountSource === "declared" && r.zoneCount === 8));

const commercialRow = out.properties.find((r) => r.accountType === "commercial");
ok("the commercial account resolves through the customer join", Boolean(commercialRow));
ok("residential accounts resolve too", out.properties.some((r) => r.accountType === "residential"));
ok("the join is noted", out.notes.some((n) => /join resolved via "customerId"/.test(n)));
ok("fall closings bucket by calendar year",
  commercialRow && commercialRow.fallClosingsByYear["2024"] === 1 && commercialRow.fallClosingsByYear["2025"] === 1);
ok("a non-fall record is not counted as a closing",
  commercialRow && Object.values(commercialRow.fallClosingsByYear).reduce((a, b) => a + b, 0) === 2);
ok("a closing with no completedAt is skipped",
  commercialRow && !Object.keys(commercialRow.fallClosingsByYear).includes("undefined"));
ok("serviceRecordCount counts every record, not just closings",
  commercialRow && commercialRow.serviceRecordCount === 4);
ok("the additional-blowout flag survives", commercialRow && commercialRow.hasAdditionalFallBlowout === true);
ok("everHadFallClosing counts the property once", out.summary.everHadFallClosing === 1);

// ---- Privacy ----------------------------------------------------------

// Scan the payload with the pseudonyms masked out. A ref is 8 chars of a
// salted SHA-256, so it is random hex on every run — and a 3-digit street
// number is three hex digits, which a ref hits by chance often enough to
// make an unmasked scan flaky (it went green locally and red in CI on the
// first push). Masking is only sound because a ref cannot itself carry a
// leak: it is a digest, not a copy of any field. That is asserted first,
// so the mask can never hide a real one.
ok("every ref is lowercase hex — a digest, not copied data, so masking it is safe",
  out.properties.every((r) => /^[0-9a-f]{8}$/.test(r.ref)));
ok("no ref equals any identifying value",
  !out.properties.some((r) => Object.values(SECRETS).includes(r.ref)));

const scannable = JSON.stringify(out, (key, value) => (key === "ref" ? "<masked>" : value));
for (const [label, value] of Object.entries(SECRETS)) {
  ok(`no ${label} in the output`, !scannable.includes(value));
}
ok("no street number from the fixture address in the output", !scannable.includes("417"));
ok("no fixture street name in the output", !scannable.includes("Bayview Ridge"));
ok("the municipality label survives", out.properties.some((r) => r.municipality === "Aurora"));
ok("coordinates are rounded to 2 decimals",
  out.properties.every((r) => r.lat === null || Number(r.lat.toFixed(2)) === r.lat));
ok("no row carries a raw property id",
  !out.properties.some((r) => Object.values(r).some((v) => typeof v === "string" && v.startsWith("p-"))));

const second = await territory.buildTerritoryExport({ dataDir: DATA_DIR, year: 2026 });
// Compare the whole list, not just row 0: one row matching by chance is a
// 1-in-4-billion event, but "no row anywhere differs" is not something two
// independently salted runs can produce.
ok("the pseudonym salt is per-run — refs differ between two exports",
  second.properties.some((r, i) => r.ref !== out.properties[i].ref));

// ---- Filename ---------------------------------------------------------

ok("filename is territory-export-YYYY-MM-DD.json",
  /^territory-export-\d{4}-\d{2}-\d{2}\.json$/.test(territory.exportFilename()));
ok("filename tracks the moment it is given",
  territory.exportFilename(new Date("2026-08-27T12:00:00.000Z")) === "territory-export-2026-08-27.json");

// ---- Missing / malformed input ---------------------------------------

{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-territory-empty-"));
  let threw = null;
  try {
    await territory.buildTerritoryExport({ dataDir: emptyDir });
  } catch (err) {
    threw = err;
  }
  ok("a missing properties.json throws rather than exiting the process",
    threw instanceof territory.TerritoryExportError);
  ok("the error names the gitignored data directory", threw && /gitignored/.test(threw.message));
  ok("nothing was created in the empty directory", fs.readdirSync(emptyDir).length === 0);
  fs.rmSync(emptyDir, { recursive: true, force: true });
}

{
  // customers.json absent — the export still builds, minus the split.
  const noCustDir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-territory-nocust-"));
  fs.writeFileSync(path.join(noCustDir, "properties.json"), JSON.stringify(FIXTURE_PROPERTIES));
  const partial = await territory.buildTerritoryExport({ dataDir: noCustDir, year: 2026 });
  ok("a missing customers.json is tolerated", partial.properties.length === out.summary.totalProperties);
  ok("and is noted", partial.notes.some((n) => /customers\.json not found/.test(n)));
  ok("account type is null without customers", partial.properties.every((r) => r.accountType === null));
  fs.rmSync(noCustDir, { recursive: true, force: true });
}

{
  // A keyed wrapper instead of a bare array — tolerated, not silently empty.
  const wrappedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-territory-wrapped-"));
  fs.writeFileSync(path.join(wrappedDir, "properties.json"), JSON.stringify({ properties: FIXTURE_PROPERTIES }));
  const wrapped = await territory.buildTerritoryExport({ dataDir: wrappedDir, year: 2026 });
  ok("a keyed wrapper is unwrapped, not read as empty", wrapped.properties.length === out.summary.totalProperties);
  fs.rmSync(wrappedDir, { recursive: true, force: true });
}

// ---- Source guards ----------------------------------------------------
//
// Each of these fails the build if the corresponding protection is removed.

{
  // The "holds no copy of X" guards below have to read CODE, not prose —
  // both files document the write calls they deliberately avoid, and a
  // guard that matched the comment would fail on its own documentation.
  // Neither file contains "//" inside a string or a regex literal, so a
  // naive strip is exact here; assert that precondition rather than
  // assuming it.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const libRaw = fs.readFileSync(path.join(ROOT, "server/lib/territory-export.js"), "utf8");
  const cliRaw = fs.readFileSync(path.join(ROOT, "territory-export-corrected.js"), "utf8");
  const libSrc = stripComments(libRaw);
  const cliSrc = stripComments(cliRaw);

  ok("comment stripping left the lib's code intact",
    /function buildTerritoryExport/.test(libSrc) && /module\.exports/.test(libSrc));
  ok("comment stripping left the CLI's code intact", /buildTerritoryExport\(\{ year \}\)/.test(cliSrc));

  ok("the lib never requires ./properties (whose readAll can write)",
    !/require\(['"]\.\/properties['"]\)/.test(libSrc));
  ok("the lib opens no write handle",
    !/writeFile|appendFile|mkdir|rmdir|unlink|truncate|createWriteStream/.test(libSrc));
  ok("the lib's only filesystem calls are reads",
    (libSrc.match(/fsp?\.\w+/g) || []).every((call) => /^fsp?\.(readFile|access)$/.test(call)),
    (libSrc.match(/fsp?\.\w+/g) || []).join(", "));
  ok("the lib never calls process.exit", !/process\.exit/.test(libSrc));
  ok("the lib never writes to stdout", !/process\.stdout/.test(libSrc));
  ok("the lib excludes deletedAt and archivedAt",
    /!p\.deletedAt\s*&&\s*!p\.archivedAt/.test(libSrc));
  ok("the lib detects the depot pin against PJL_BASE",
    /PJL_BASE\.lat/.test(libSrc) && /PJL_BASE\.lng/.test(libSrc));
  ok("the lib coerces coordinates through coordValue",
    /function coordValue/.test(libSrc) && /coordValue\(c\.lat\)/.test(libSrc));
  ok("the lib salts its pseudonyms", /randomBytes/.test(libSrc));

  ok("the CLI delegates to the shared lib",
    /require\(['"]\.\/server\/lib\/territory-export['"]\)/.test(cliSrc));
  ok("the CLI holds no copy of the exclusion filter", !/archivedAt/.test(cliSrc));
  ok("the CLI holds no copy of the depot check", !/PJL_BASE/.test(cliSrc));
  ok("the CLI holds no copy of the coordinate coercion", !/coordValue/.test(cliSrc));
  ok("the CLI still accepts --year", /--year/.test(cliSrc));

  ok("the superseded territory-export.js is gone",
    !fs.existsSync(path.join(ROOT, "territory-export.js")));

  const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  ok("the export path is admin-gated in needsAuth",
    /if \(pathname === "\/api\/admin\/territory-export"\) return "admin";/.test(serverSrc));
  ok("the route re-checks with requireAdmin",
    /pathname === "\/api\/admin\/territory-export" && req\.method === "GET"[\s\S]{0,200}?requireAdmin\(req\)/.test(serverSrc));
  ok("the route sends the export as an attachment",
    /content-disposition["']?\s*:\s*`attachment; filename="\$\{territoryExport\.exportFilename\(\)\}"`/.test(serverSrc));
  ok("the route declares JSON",
    /territory-export[\s\S]{0,900}?"content-type": "application\/json; charset=utf-8"/.test(serverSrc));
  ok("the route goes through the shared lib",
    /territoryExport\.buildTerritoryExport\(/.test(serverSrc));

  const settingsSrc = fs.readFileSync(path.join(ROOT, "server/settings.html"), "utf8");
  ok("the settings page links the download",
    /href="\/api\/admin\/territory-export"/.test(settingsSrc));
  ok("the link is plainly labelled",
    /Download territory export \(JSON\)/.test(settingsSrc));
  ok("the link uses the shared button class (48px min touch target)",
    /class="pjl-btn pjl-btn-outline" id="territoryExportLink"/.test(settingsSrc));
}

// ---- Report -----------------------------------------------------------

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`territory export: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`territory export: ${pass} assertions passed`);

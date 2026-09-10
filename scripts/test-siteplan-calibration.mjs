#!/usr/bin/env node
// scripts/test-siteplan-calibration.mjs
//
// Tests for the site-plan scale calibration that the Sprinkler System
// Builder traces areas over (server/sitebuilder.html, /admin/sitebuilder).
//
// WHY THIS IS A BUILD GATE
//
// These numbers go into competitive tenders. A scale error does not produce
// a visibly broken screen — it produces a confidently wrong bid. A
// factor-of-two scale confusion (1:100 read as 1:200) yields a plan that
// looks entirely plausible and a price that is half or double what it
// should be. That failure is invisible to every other check in the build,
// which is exactly why calibration math earns a test and the plain CRUD
// around it does not.
//
// Coverage:
//   1. Calibration math round-trip — derived ft/px is exact
//   2. Verification residual classification — the pass/warn/fail table
//   3. The factor-of-two catch, end to end through the storage layer
//   4. Stated-scale cross-check (advisory) — including "fit to page"
//   5. Serialize/restore fidelity — planRef + traced coords to 3 dp
//   6. Backward compatibility — a version:2 blob loads byte-identically
//   7. Vertex + payload budget — client pre-flight AND the server's cap
//   8. Path traversal — rejected BEFORE any filesystem call
//   9. Recalibration lock + calibration idempotency
//  10. Aggregate sheet-coverage sanity check
//
// Arc densification (brief §3.6) is Phase 2 and is deliberately not covered
// here — a.segments[] does not exist yet.
//
// Isolation: projects.js resolves its store as `<lib dir>/../data/projects.json`,
// so the whole suite runs against COPIES of the two libs in a temp directory.
// It can never read or write real project data, which matters because these
// tests create, mutate and delete records.
//
// Run: node scripts/test-siteplan-calibration.mjs   (also in `npm run build:check`)
//      node scripts/test-siteplan-calibration.mjs --verbose

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");

// ---- Sandbox ----------------------------------------------------------
// site-plan-calibration.js requires nothing but node builtins. projects.js
// requires it by relative path and lazily requires other siblings only from
// verbs this suite never calls. Copying the pair gives a self-contained
// store rooted at <sandbox>/data.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-siteplan-test-"));
const SANDBOX_LIB = path.join(SANDBOX, "lib");
fs.mkdirSync(SANDBOX_LIB, { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
for (const file of ["projects.js", "site-plan-calibration.js"]) {
  fs.copyFileSync(path.join(__dirname, "..", "server", "lib", file), path.join(SANDBOX_LIB, file));
}

const require = createRequire(import.meta.url);
const cal = require(path.join(SANDBOX_LIB, "site-plan-calibration.js"));
const projects = require(path.join(SANDBOX_LIB, "projects.js"));
const PROJECTS_JSON = path.join(SANDBOX, "data", "projects.json");

// ---- Assertions -------------------------------------------------------

let passed = 0;
const failures = [];
let section = "";

function group(title) {
  section = title;
  if (VERBOSE) console.log(`\n${title}`);
}
function ok(cond, label) {
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${section} — ${label}`);
    console.error(`  ✗ FAIL: ${section} — ${label}`);
  }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${label}\n      got  ${a}\n      want ${b}`);
}
async function throwsWithCode(fn, code, label) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) { ok(false, `${label} (expected a throw, got none)`); return null; }
  ok(err.code === code, `${label} (got code ${JSON.stringify(err.code)}, want ${JSON.stringify(code)})`);
  return err;
}

const PNG = Buffer.from("89504e470d0a1a0a" + "00".repeat(512), "hex");

// ══════════════════════════════════════════════════════════════════════
// 1. Calibration math round-trip
// ══════════════════════════════════════════════════════════════════════
group("1. Calibration math round-trip");
{
  // Synthetic page 1000 x 1000 px. Two points 500 px apart, known 100 ft.
  const { ftPerPx, pixelDistance } = cal.deriveFtPerPx({
    p1: { x: 250, y: 500 }, p2: { x: 750, y: 500 }, knownFt: 100
  });
  eq(pixelDistance, 500, "pixel distance is 500");
  eq(ftPerPx, 0.2, "ftPerPx is EXACTLY 0.2 (no float drift)");

  // A third point 250 px away must read 50.0 ft under that scale.
  const v = cal.verifyCalibration({ ftPerPx, p1: { x: 100, y: 100 }, p2: { x: 350, y: 100 }, expectedFt: 50 });
  eq(v.measuredFt, 50, "a 250 px span reads exactly 50.0 ft");
  eq(v.residualPct, 0, "residual is 0%");
  eq(v.state, "passed", "state is passed");

  // Diagonal — the derivation is a plain hypot, so a 3-4-5 triangle is exact.
  const diag = cal.deriveFtPerPx({ p1: { x: 0, y: 0 }, p2: { x: 300, y: 400 }, knownFt: 50 });
  eq(diag.pixelDistance, 500, "diagonal 300x400 px measures 500 px");
  eq(diag.ftPerPx, 0.1, "diagonal calibration derives exactly 0.1 ft/px");

  // DPI independence: the SAME real dimension on a sheet rendered at 3x the
  // resolution must describe the same real-world size.
  const lo = cal.deriveFtPerPx({ p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 100 });
  const hi = cal.deriveFtPerPx({ p1: { x: 0, y: 0 }, p2: { x: 1500, y: 0 }, knownFt: 100 });
  eq(lo.ftPerPx * 1000, hi.ftPerPx * 3000, "a 1000 px sheet and a 3000 px render describe the same width");

  // Degenerate inputs must throw with a human message, never return NaN — a
  // NaN reaching the record poisons the tender silently.
  let threw = false;
  try { cal.deriveFtPerPx({ p1: { x: 10, y: 10 }, p2: { x: 10, y: 10 }, knownFt: 100 }); } catch { threw = true; }
  ok(threw, "two coincident calibration points throw rather than returning Infinity");
  threw = false;
  try { cal.deriveFtPerPx({ p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 0 }); } catch { threw = true; }
  ok(threw, "a zero known distance throws");
}

// ══════════════════════════════════════════════════════════════════════
// 1b. Distance entry — feet, feet-and-inches, and metric
// ══════════════════════════════════════════════════════════════════════
//
// PJL works in feet and inches; everything downstream of calibration is
// feet. The DRAWING varies — Canadian commercial tenders are usually metric.
// This is the one conversion in the system, so it is pinned hard: a units
// slip is the single error class the second-dimension verification CANNOT
// catch, because it scales both measurements equally and agrees with itself.
group("1b. Distance entry");
{
  const FT = 3.280839895013123;
  const cases = [
    ["18.865", 18.865, "ft", "a bare number is decimal FEET — unchanged behaviour"],
    ["9", 9, "ft", "a bare integer is feet"],
    ["18 ft", 18, "ft", "explicit ft"],
    ["18'", 18, "ft", "foot mark"],
    ["18' 10\"", 18 + 10 / 12, "ft_in", "feet and inches"],
    ["18'10\"", 18 + 10 / 12, "ft_in", "feet and inches, no space"],
    ["18-10", 18 + 10 / 12, "ft_in", "construction shorthand 18'-10\""],
    ["18ft 10in", 18 + 10 / 12, "ft_in", "worded feet and inches"],
    ["18' 10-1/2\"", 18 + 10.5 / 12, "ft_in", "mixed fraction inches"],
    ["226.4\"", 226.4 / 12, "in", "inches only"],
    ["226.4 in", 226.4 / 12, "in", "worded inches"],
    ["5.75 m", 5.75 * FT, "m", "metres — the McDonald's Dundalk case"],
    ["5.75m", 5.75 * FT, "m", "metres, no space"],
    ["2.75 metres", 2.75 * FT, "m", "worded metres"],
    ["5750 mm", 5.75 * FT, "mm", "millimetres"],
    ["575 cm", 5.75 * FT, "cm", "centimetres"],
    ["18\u2032 10\u2033", 18 + 10 / 12, "ft_in", "typographic prime marks from a PDF"]
  ];
  for (const [input, wantFt, wantUnit, label] of cases) {
    const r = cal.parseDistance(input);
    ok(Math.abs(r.feet - wantFt) < 1e-9 && r.unit === wantUnit,
       `${JSON.stringify(input)} -> ${wantFt.toFixed(4)} ft [${wantUnit}] — ${label} (got ${r.feet.toFixed(4)} [${r.unit}])`);
  }

  // The standard Ontario parking stall, which is what identified the
  // McDonald's sheet as metric in the first place.
  ok(Math.abs(cal.parseDistance("2.75 m").feet - 9.0223) < 0.0001, "2.75 m is a 9'-0\" stall width");
  ok(Math.abs(cal.parseDistance("5.75 m").feet - 18.8648) < 0.0001, "5.75 m is an 18'-10\" stall depth");

  // Garbage must throw with a message naming what the box accepts — never
  // return NaN, which would become a silently wrong bid.
  for (const bad of ["", "   ", "abc", "0", "-5", "five feet", "18\" 10'", "1/0", "m", "5.75 furlongs"]) {
    let threw = false;
    try { cal.parseDistance(bad); } catch { threw = true; }
    ok(threw, `parseDistance rejects ${JSON.stringify(bad)}`);
  }
  let msg = "";
  try { cal.parseDistance("banana"); } catch (e) { msg = e.message; }
  ok(/feet and inches/.test(msg) && /5\.75 m/.test(msg) && /read as feet/.test(msg),
     "the rejection message names every accepted form");

  // Feet-and-inches formatting, including the rounding boundary.
  eq(cal.formatFeetInches(18.8648), "18'-10.4\"", "18.8648 ft reads as 18'-10.4\"");
  eq(cal.formatFeetInches(9.0223), "9'-0.3\"", "9.0223 ft reads as 9'-0.3\"");
  eq(cal.formatFeetInches(0.5), "0'-6.0\"", "half a foot reads as 6 inches");
  eq(cal.formatFeetInches(11.9975), "12'-0.0\"", "11.9975 ft rounds to 12'-0\", never 11'-12\"");

  // Round-trip: whatever unit it was typed in, the feet are the same number.
  const spellings = ["18.8648", "18' 10.378\"", "5.75 m", "5750 mm"];
  const feet = spellings.map((t) => cal.parseDistance(t).feet);
  ok(Math.max(...feet) - Math.min(...feet) < 0.001,
     "the same measurement typed four different ways lands within 0.001 ft");
}

// ══════════════════════════════════════════════════════════════════════
// 2. Verification residual classification
// ══════════════════════════════════════════════════════════════════════
group("2. Verification residual classification");
{
  const TABLE = [
    [0.1, "passed"], [0.4, "passed"], [0.9, "warned"],
    [1.9, "warned"], [2.1, "failed"], [15.0, "failed"]
  ];
  for (const [residual, want] of TABLE) {
    eq(cal.classifyResidual(residual), want, `${residual}% -> ${want}`);
  }
  // Band edges are business logic, so pin them explicitly.
  eq(cal.classifyResidual(0.499), "passed", "0.499% is still passed");
  eq(cal.classifyResidual(0.5), "warned", "exactly 0.5% tips to warned");
  eq(cal.classifyResidual(2.0), "warned", "exactly 2.0% is still warned");
  eq(cal.classifyResidual(2.0001), "failed", "just past 2.0% is failed");
  eq(cal.classifyResidual(-0.9), "warned", "sign of the residual is irrelevant");

  // Classification runs on the RAW residual, before rounding for storage.
  // Rounding first would let 0.4996% round to 0.5% and silently cross a band.
  const edge = cal.verifyCalibration({
    ftPerPx: 1, p1: { x: 0, y: 0 }, p2: { x: 1004.99, y: 0 }, expectedFt: 1000
  });
  eq(edge.residualPct, 0.499, "residual is stored rounded to 3 dp");
  eq(edge.state, "passed", "...but classified on the raw value, so it stays passed");

  // Verification points must be an independent pair — re-measuring the same
  // two clicks agrees with itself by construction and proves nothing.
  const same = cal.verifyPointsAreIndependent({
    calP1: { x: 100, y: 100 }, calP2: { x: 600, y: 100 },
    verP1: { x: 102, y: 101 }, verP2: { x: 600, y: 400 }
  });
  eq(same.ok, false, "a verify point within 5 px of a calibration point is rejected");
  ok(/different dimension/i.test(same.reason), "...with a message that says why");
  const indep = cal.verifyPointsAreIndependent({
    calP1: { x: 100, y: 100 }, calP2: { x: 600, y: 100 },
    verP1: { x: 100, y: 400 }, verP2: { x: 400, y: 400 }
  });
  eq(indep.ok, true, "a genuinely separate pair is accepted");
}

// ══════════════════════════════════════════════════════════════════════
// 3. The factor-of-two catch, end to end
// ══════════════════════════════════════════════════════════════════════
group("3. Factor-of-two catch (end to end through the storage layer)");
{
  fs.writeFileSync(PROJECTS_JSON, "[]\n", "utf8");
  const proj = await projects.create({ name: "Scale test", address: "1 Test Rd" });
  const page = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "A-101",
    rasterWidthPx: 4000, rasterHeightPx: 3000, renderScale: 6.3131,
    sourceFilename: "tender.pdf", sourceMimeType: "application/pdf", uploadedBy: "USR-001"
  });
  eq(page.calibration.state, "uncalibrated", "a freshly uploaded page starts uncalibrated");
  eq(page.calibration.rotationDeg, 0, "rotationDeg is stored and is 0 (reserved, Phase 1)");
  ok(/^spp_[a-z0-9]{8}$/.test(page.id), "page id matches the spp_ + random8 convention");
  ok(typeof page.sha256 === "string" && page.sha256.length === 64, "sha256 recorded for integrity / dedupe");

  // The sheet's true width dimension is 500 px = 100 ft. Type 200 ft by
  // mistake — a 1:100 sheet read as 1:200 — and the independent 40 ft
  // dimension then measures 80 ft. That is the bid-halving error, and it
  // MUST be refused rather than stored.
  const err = await throwsWithCode(
    () => projects.setSitePlanCalibration(proj.id, page.id, {
      p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 200,
      verify: { p1: { x: 0, y: 900 }, p2: { x: 200, y: 900 }, expectedFt: 40 }
    }, { by: "USR-001" }),
    "verification_failed",
    "a 2x mistyped dimension is REFUSED"
  );
  ok(err && Math.abs(err.residualPct - 100) < 0.001, "...reporting a 100% residual");
  ok(err && /factor of two/i.test(err.message), "...and naming the factor-of-two cause by name");

  const afterFail = await projects.get(proj.id);
  eq(projects.findSitePlanPage(afterFail, page.id).calibration.state, "uncalibrated",
     "the refused calibration was NOT persisted");

  // The same points with the correct 100 ft dimension pass cleanly.
  const good = await projects.setSitePlanCalibration(proj.id, page.id, {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 100,
    verify: { p1: { x: 0, y: 900 }, p2: { x: 200, y: 900 }, expectedFt: 40 }
  }, { by: "USR-001" });
  eq(good.page.calibration.ftPerPx, 0.2, "correct dimensions derive exactly 0.2 ft/px");
  eq(good.page.calibration.verify.state, "passed", "verification passes");
  eq(good.page.calibration.verify.residualPct, 0, "residual is 0%");
  eq(good.page.calibration.calibratedBy, "USR-001", "provenance records who calibrated it");
  ok(!!good.page.calibration.calibratedAt, "...and when");

  // A warned residual is usable ONLY with a recorded acknowledgment.
  const p2 = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "A-102",
    rasterWidthPx: 1000, rasterHeightPx: 1000, renderScale: 1, uploadedBy: "USR-001"
  });
  const warnInput = {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 100,
    verify: { p1: { x: 0, y: 900 }, p2: { x: 200, y: 900 }, expectedFt: 39.6 }   // ~1.0% out
  };
  const warned = await throwsWithCode(
    () => projects.setSitePlanCalibration(proj.id, p2.id, warnInput, { by: "USR-001" }),
    "verification_warned",
    "a warned residual is refused without an acknowledgment"
  );
  ok(warned && /acknowledge/i.test(warned.message), "...and says acknowledgment is what unblocks it");
  const acked = await projects.setSitePlanCalibration(
    proj.id, p2.id, { ...warnInput, acknowledge: true }, { by: "USR-001" }
  );
  eq(acked.page.calibration.verify.state, "warned", "acknowledged: state stays warned (not laundered to passed)");
  eq(acked.page.calibration.verify.acknowledgedBy, "USR-001", "...and who accepted the residual is recorded");
}

// ══════════════════════════════════════════════════════════════════════
// 3b. Metric entry reaches the record as FEET
// ══════════════════════════════════════════════════════════════════════
group("3b. Metric entry stores feet");
{
  fs.writeFileSync(PROJECTS_JSON, "[]\n", "utf8");
  const proj = await projects.create({ name: "Metric tender", address: "Dundalk ON" });
  const page = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "Metric 1:200",
    rasterWidthPx: 5000, rasterHeightPx: 3333, renderScale: 6, uploadedBy: "USR-001"
  });
  // 5.75 m spans 500 px; 2.75 m spans 500*(2.75/5.75) px at the same scale.
  const r = await projects.setSitePlanCalibration(proj.id, page.id, {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownDistance: "5.75 m",
    verify: { p1: { x: 0, y: 900 }, p2: { x: 500 * (2.75 / 5.75), y: 900 }, expectedDistance: "2.75 m" }
  }, { by: "USR-001" });
  const c = r.page.calibration;
  ok(Math.abs(c.knownFt - 18.8648) < 0.0001, `metres in, FEET stored (${c.knownFt.toFixed(4)} ft)`);
  eq(c.knownInput, "5.75 m", "the raw entry is kept as provenance");
  eq(c.knownUnit, "m", "so is the unit it was typed in");
  ok(Math.abs(c.verify.expectedFt - 9.0223) < 0.0001, "the verify distance converts too");
  eq(c.verify.state, "passed", "and the pair verifies clean");
  ok(Math.abs(c.ftPerPx - 18.8648 / 500) < 1e-6, "ftPerPx derives from the CONVERTED feet");

  // The numeric contract still works — nothing that already worked changed.
  const page2 = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "Imperial",
    rasterWidthPx: 1000, rasterHeightPx: 1000, renderScale: 1, uploadedBy: "USR-001"
  });
  const r2 = await projects.setSitePlanCalibration(proj.id, page2.id, {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 100,
    verify: { p1: { x: 0, y: 900 }, p2: { x: 200, y: 900 }, expectedFt: 40 }
  }, { by: "USR-001" });
  eq(r2.page.calibration.ftPerPx, 0.2, "a numeric knownFt still works exactly as before");
  eq(r2.page.calibration.knownInput, null, "…and records no typed input");

  // THE POINT OF ALL THIS: verification cannot catch a units slip, because
  // the error is consistent. Prove it, so nobody later assumes it can.
  const page3 = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "Units trap",
    rasterWidthPx: 5000, rasterHeightPx: 3333, renderScale: 6, uploadedBy: "USR-001"
  });
  const trap = await projects.setSitePlanCalibration(proj.id, page3.id, {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownDistance: "5.75",       // metres typed as FEET
    verify: { p1: { x: 0, y: 900 }, p2: { x: 500 * (2.75 / 5.75), y: 900 }, expectedDistance: "2.75" },
    statedScale: "1:200"
  }, { by: "USR-001" });
  eq(trap.page.calibration.verify.state, "passed",
     "a units slip PASSES verification — it is consistent, so it agrees with itself");
  eq(trap.page.calibration.statedScaleCheck.agrees, false,
     "…and only the printed-scale cross-check catches it");
  ok(trap.page.calibration.statedScaleCheck.deltaPct > 60,
     `…at a ~69.5% delta, the metres-as-feet signature (${trap.page.calibration.statedScaleCheck.deltaPct}%)`);
}

// ══════════════════════════════════════════════════════════════════════
// 4. Stated-scale cross-check (advisory only)
// ══════════════════════════════════════════════════════════════════════
group("4. Stated-scale cross-check");
{
  eq(cal.parseStatedScale("1:200").ftPerPaperInch, 200 / 12, "1:200 -> 200 in per paper inch");
  eq(cal.parseStatedScale(`1"=20'`).ftPerPaperInch, 20, `1"=20' -> 20 ft per paper inch`);
  eq(cal.parseStatedScale(`1/8"=1'`).ftPerPaperInch, 8, `1/8"=1' -> 8 ft per paper inch`);
  eq(cal.parseStatedScale(`3/16" = 1ft`).ftPerPaperInch, 16 / 3, `3/16"=1ft -> 16/3 ft per paper inch`);
  eq(cal.parseStatedScale("not a scale"), null, "unparseable input returns null, not a guess");
  eq(cal.parseStatedScale(""), null, "empty input returns null");

  // A sheet rendered by pdf.js at scale s carries 72*s px per paper inch.
  // At 1"=20' and s=6.3131, ftPerPx should be 20/(72*6.3131).
  const agree = cal.statedScaleCrossCheck({
    statedScale: `1"=20'`, ftPerPx: 20 / (72 * 6.3131), renderScale: 6.3131
  });
  eq(agree.available, true, "cross-check available for a PDF-sourced sheet");
  ok(agree.deltaPct < 0.001, "a to-scale sheet shows ~0% delta");
  eq(agree.agrees, true, "...and reads as agreeing");

  // "Fit to page" export — the drawing was shrunk ~8% on the way out, so the
  // measured scale no longer matches the title block. This is the case the
  // cross-check exists to surface.
  const fitToPage = cal.statedScaleCrossCheck({
    statedScale: `1"=20'`, ftPerPx: 20 / (72 * 6.3131) * 1.085, renderScale: 6.3131
  });
  eq(fitToPage.agrees, false, "a fit-to-page export is flagged");
  ok(Math.abs(fitToPage.deltaPct - 8.5) < 0.1, `...with the delta named (${fitToPage.deltaPct}%)`);
  ok(/exported or printed to-fit/i.test(fitToPage.note), "...and the likely cause explained");

  // A scale misread lands near 50% or 100%, and reads differently.
  const misread = cal.statedScaleCrossCheck({
    statedScale: "1:200", ftPerPx: (200 / 12) / (72 * 6.3131) * 2, renderScale: 6.3131
  });
  ok(misread.deltaPct > 15, "a 2x scale misread shows a large delta");
  ok(/long way off/i.test(misread.note), "...and is called out as such");

  // An image upload has no paper space, so the cross-check is genuinely
  // unavailable rather than invented.
  const img = cal.statedScaleCrossCheck({ statedScale: "1:200", ftPerPx: 0.05, renderScale: null });
  eq(img.available, false, "an image-sourced sheet has no cross-check");
  ok(/came in as an image/i.test(img.reason), "...and says why, rather than reporting a bogus delta");
}

// ══════════════════════════════════════════════════════════════════════
// 5. Serialize/restore fidelity
// ══════════════════════════════════════════════════════════════════════
group("5. Serialize/restore fidelity (planRef + traced coords)");
{
  fs.writeFileSync(PROJECTS_JSON, "[]\n", "utf8");
  const proj = await projects.create({ name: "Round-trip", address: "2 Test Rd" });

  // A version:3 design: one traced area carrying planRef and sub-foot
  // coordinates, one hand-sketched area with neither.
  const v3 = {
    version: 3,
    savedAt: "2026-08-13T14:02:11.000Z",
    inputs: { availGPM: "8", psi: "60" },
    waterSupply: { hosebibTested: true, newSupplyRequired: false, flowSensorRequired: false, installDifficulty: 3 },
    bomOverrides: { edits: {}, removed: {}, custom: [] },
    linkedQuoteId: null,
    areas: [
      {
        name: "Front Bed", mode: "custom", family: "drip",
        planRef: { pageId: "spp_a1b2c3d4" },
        poly: cal.roundPoly([
          { x: 412.0004, y: 1908.5009 }, { x: 3320.5001, y: 1908.4999 },
          { x: 3320.4996, y: 2411.0004 }, { x: 412.0002, y: 2411.0 }
        ])
      },
      { name: "Back Lawn", mode: "rect", L: 60, W: 40, sqft: 2400, avgW: 40, family: "rotor", rotorNoz: "b40" }
    ],
    wcRunOverrides: {}
  };

  const saved = await projects.update(proj.id, { systemDesign: v3 });
  deepEq(saved.systemDesign, v3, "a version:3 design round-trips through the record byte-identically");
  eq(saved.systemDesign.areas[0].planRef.pageId, "spp_a1b2c3d4", "planRef survives the round-trip");
  deepEq(saved.systemDesign.areas[0].poly[0], { x: 412, y: 1908.501 }, "traced coords are stored to 3 dp");
  ok(!("planRef" in saved.systemDesign.areas[1]), "a hand-sketched area carries no planRef at all");

  // Re-read from disk — the blob is opaque to the server, so nothing may
  // normalize, reorder or drop a key on the way back out.
  const reread = await projects.get(proj.id);
  deepEq(reread.systemDesign, v3, "...and survives a full read back from disk");

  // 3 dp is ~0.012 inch. Assert the rounding is a budget measure, not a
  // precision loss that could move a tender.
  const before = { x: 3320.500123, y: 2411.000987 };
  const after = cal.roundPoly([before])[0];
  ok(Math.abs(after.x - before.x) < 0.001 && Math.abs(after.y - before.y) < 0.001,
     "rounding moves a vertex by under 0.001 ft (~0.012 inch)");
}

// ══════════════════════════════════════════════════════════════════════
// 6. Backward compatibility
// ══════════════════════════════════════════════════════════════════════
group("6. Backward compatibility — a version:2 blob loads unchanged");
{
  const proj = await projects.create({ name: "Legacy", address: "3 Test Rd" });

  // Captured shape of a real pre-feature design. No planRef anywhere, and
  // integer-snapped poly coordinates from the 1 ft grid sketch tool.
  const v2 = {
    version: 2,
    savedAt: "2026-07-02T11:20:00.000Z",
    inputs: { availGPM: "8", psi: "60", ceiling: "7.8", spacingFactor: "0.9" },
    waterSupply: { hosebibTested: true, newSupplyRequired: false, flowSensorRequired: false, installDifficulty: 0 },
    bomOverrides: { edits: { "RB-1804": { qty: 12 } }, removed: {}, custom: [] },
    linkedQuoteId: "Q-2026-0042",
    areas: [
      { name: "Front Yard (lawn)", mode: "rect", L: 60, W: 40, sqft: 2400, avgW: 40, family: "rotor", rotorNoz: "b40" },
      { name: "Side Bed", mode: "custom", family: "drip", shapeKind: "circle",
        circle: { cx: 20, cy: 20, r: 12 },
        poly: [{ x: 32, y: 20 }, { x: 20, y: 32 }, { x: 8, y: 20 }, { x: 20, y: 8 }] }
    ],
    wcRunOverrides: { 0: "25" }
  };
  const frozen = JSON.parse(JSON.stringify(v2));

  const saved = await projects.update(proj.id, { systemDesign: v2 });
  deepEq(saved.systemDesign, frozen, "a version:2 blob is stored byte-identically — no key added, none dropped");
  const reread = await projects.get(proj.id);
  deepEq(reread.systemDesign, frozen, "...and reads back byte-identically");
  eq(reread.systemDesign.version, 2, "the version stays 2 — nothing silently migrates it");
  ok(!JSON.stringify(reread.systemDesign).includes("planRef"), "no planRef is injected into a legacy design");
  eq(reread.sitePlan, null, "a legacy project has no sitePlan");

  // The geometry a legacy design depends on must compute identically. This
  // is the same shoelace formula sitebuilder.html's polyArea uses.
  const poly = reread.systemDesign.areas[1].poly;
  const areaOf = (p) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  };
  eq(areaOf(poly), 288, "legacy polygon area computes identically (288 sq ft)");
}

// ══════════════════════════════════════════════════════════════════════
// 7. Vertex + payload budget
// ══════════════════════════════════════════════════════════════════════
group("7. Vertex + payload budget");
{
  eq(cal.VERTEX_SOFT_LIMIT, 3000, "soft warning at 3,000 vertices");
  eq(cal.VERTEX_HARD_LIMIT, 4000, "hard refusal at 4,000 vertices");
  eq(cal.DESIGN_SERVER_MAX_BYTES, 512 * 1024, "server cap is 512 KB");
  eq(cal.DESIGN_PREFLIGHT_MAX_BYTES, 480 * 1024, "client pre-flights 32 KB under it");
  ok(cal.DESIGN_PREFLIGHT_MAX_BYTES < cal.DESIGN_SERVER_MAX_BYTES,
     "the client refuses BEFORE the server would — the user never learns the limit from a failed request");

  eq(cal.classifyVertexBudget(2999), "ok", "2,999 vertices is fine");
  eq(cal.classifyVertexBudget(3000), "warn", "3,000 vertices warns");
  eq(cal.classifyVertexBudget(3999), "warn", "3,999 vertices still only warns");
  eq(cal.classifyVertexBudget(4000), "blocked", "4,000 vertices blocks");

  // A 4,000-vertex design: the vertex ceiling alone must keep the payload
  // comfortably inside the cap, so the pre-flight is a second net and not
  // the thing doing the work.
  const areas4k = [];
  for (let a = 0; a < 4; a++) {
    const poly = [];
    for (let i = 0; i < 1000; i++) poly.push({ x: cal.round3(i * 1.234567), y: cal.round3((i * 7.654321) % 411) });
    areas4k.push({ name: `Traced ${a}`, mode: "custom", family: "drip", planRef: { pageId: "spp_a1b2c3d4" }, poly });
  }
  eq(cal.countVertices(areas4k), 4000, "the fixture really carries 4,000 vertices");
  const blob4k = { version: 3, savedAt: "2026-08-13T00:00:00.000Z", inputs: {}, areas: areas4k, wcRunOverrides: {} };
  const bytes4k = JSON.stringify(blob4k).length;
  ok(cal.preflightDesignSize(bytes4k).ok, `a 4,000-vertex design fits (${Math.round(bytes4k / 1024)} KB)`);

  // Past the pre-flight threshold the client refuses locally, with a message
  // that says what to do and that nothing was lost.
  const over = cal.preflightDesignSize(cal.DESIGN_PREFLIGHT_MAX_BYTES + 1);
  eq(over.ok, false, "one byte over the pre-flight threshold refuses");
  ok(/512 KB/.test(over.message), "...naming the real cap");
  ok(/Nothing has been lost/.test(over.message), "...and telling the user their work is still on screen");

  // And the server's own guard is the backstop, with the documented message.
  const proj = await projects.create({ name: "Oversize", address: "4 Test Rd" });
  const huge = { version: 3, areas: [{ name: "x", blobPad: "y".repeat(520 * 1024) }] };
  let serverErr = null;
  try { await projects.update(proj.id, { systemDesign: huge }); } catch (e) { serverErr = e; }
  ok(serverErr !== null, "the server refuses a design over 512 KB");
  ok(serverErr && /over 512 KB/.test(serverErr.message), "...with the documented message");
  const untouched = await projects.get(proj.id);
  eq(untouched.systemDesign, null, "...and the refused design was not partially written");

  eq(cal.round3(1234.56789), 1234.568, "round3 keeps 3 dp");
  eq(projects.MAX_SITE_PLAN_META_BYTES, 64 * 1024, "sitePlan metadata caps at 64 KB");
}

// ══════════════════════════════════════════════════════════════════════
// 8. Path traversal
// ══════════════════════════════════════════════════════════════════════
group("8. Path traversal on pageId / projectId");
{
  const EVIL = [
    "../../etc/passwd",
    "spp_../..",
    "spp_ABCDEFGH",                 // uppercase — outside the minted alphabet
    "spp_a1b2c3d",                  // one char short
    "spp_a1b2c3d44",                // one char long
    "spp_a1b2c3d4/../../x",
    "..%2f..%2fetc%2fpasswd",
    "spp_a1b2c3d4 .png",       // NUL-byte truncation
    "spp_a1b2c3d4\n",               // trailing newline (unanchored regex bait)
    "spp_a1b2c3d4 ",
    ""
  ];
  for (const bad of EVIL) {
    eq(cal.isValidPageId(bad), false, `isValidPageId rejects ${JSON.stringify(bad)}`);
  }
  ok(cal.isValidPageId("spp_a1b2c3d4"), "a well-formed page id is accepted");

  // The guard must fire BEFORE any path.join — a rejected id must never
  // become a filesystem path, even a non-existent one.
  for (const bad of EVIL) {
    let threw = false;
    try { projects.sitePlanPagePath("PROJ-2026-0001", bad, "image/png"); } catch (e) { threw = e.code === "bad_id"; }
    ok(threw, `sitePlanPagePath refuses ${JSON.stringify(bad)} before touching the filesystem`);
  }
  ok(cal.isValidProjectId("PROJ-2026-0001"), "a well-formed project id is accepted");
  for (const bad of ["../../etc", "PROJ-2026-001", "proj-2026-0001", "PROJ-2026-0001/../.."]) {
    eq(cal.isValidProjectId(bad), false, `isValidProjectId rejects ${JSON.stringify(bad)}`);
    let threw = false;
    try { projects.sitePlanPagePath(bad, "spp_a1b2c3d4", "image/png"); } catch (e) { threw = e.code === "bad_id"; }
    ok(threw, `sitePlanPagePath refuses project id ${JSON.stringify(bad)}`);
  }

  // A valid pair resolves inside the site-plans directory and nowhere else.
  const good = projects.sitePlanPagePath("PROJ-2026-0001", "spp_a1b2c3d4", "image/png");
  ok(good.startsWith(projects.SITE_PLANS_DIR), "a valid pair stays inside server/data/site-plans");
  ok(good.endsWith(path.join("PROJ-2026-0001", "spp_a1b2c3d4.png")), "...at the documented path shape");
}

// ══════════════════════════════════════════════════════════════════════
// 9. Recalibration lock + idempotency
// ══════════════════════════════════════════════════════════════════════
group("9. Recalibration lock + idempotency");
{
  fs.writeFileSync(PROJECTS_JSON, "[]\n", "utf8");
  const proj = await projects.create({ name: "Lock test", address: "5 Test Rd" });
  const page = await projects.addSitePlanPage(proj.id, {
    buffer: PNG, mimeType: "image/png", label: "A-101",
    rasterWidthPx: 4000, rasterHeightPx: 3000, renderScale: 6.3131, uploadedBy: "USR-001"
  });
  const INPUT = {
    p1: { x: 0, y: 0 }, p2: { x: 500, y: 0 }, knownFt: 100,
    verify: { p1: { x: 0, y: 900 }, p2: { x: 200, y: 900 }, expectedFt: 40 },
    statedScale: "1:200"
  };
  const first = await projects.setSitePlanCalibration(proj.id, page.id, INPUT, { by: "USR-001" });
  eq(first.changed, true, "the first calibration writes");
  const historyAfterFirst = (await projects.get(proj.id)).history.length;

  // Re-running with identical values is a clean no-op — no rewrite, and no
  // duplicate history entry.
  const again = await projects.setSitePlanCalibration(proj.id, page.id, INPUT, { by: "USR-001" });
  eq(again.changed, false, "an identical PATCH is a no-op");
  eq((await projects.get(proj.id)).history.length, historyAfterFirst, "...appending no duplicate history entry");
  eq(again.page.calibration.calibratedAt, first.page.calibration.calibratedAt, "...and not even re-stamping the time");

  // Trace areas over the page, then try to re-scale it.
  await projects.update(proj.id, {
    systemDesign: {
      version: 3,
      areas: [
        { name: "Front Bed", mode: "custom", planRef: { pageId: page.id }, poly: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { name: "Rear Lawn", mode: "custom", planRef: { pageId: page.id }, poly: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] },
        { name: "Hand sketch", mode: "rect", L: 10, W: 10 }
      ]
    }
  });
  deepEq(projects.sitePlanDependents(await projects.get(proj.id), page.id), ["Front Bed", "Rear Lawn"],
         "dependents are found by planRef, and hand-sketched areas are not among them");

  const locked = await throwsWithCode(
    () => projects.setSitePlanCalibration(proj.id, page.id, {
      ...INPUT, knownFt: 120     // a DIFFERENT scale
    }, { by: "USR-001" }),
    "calibration_locked",
    "recalibrating a traced-over page is REFUSED"
  );
  ok(locked && /Front Bed/.test(locked.message) && /Rear Lawn/.test(locked.message),
     "...naming every dependent area");
  deepEq(locked.dependents, ["Front Bed", "Rear Lawn"], "...and returning them for the UI");
  eq((await projects.get(proj.id)).sitePlan.pages[0].calibration.knownFt, 100,
     "...leaving the original scale untouched");

  // Idempotency is checked BEFORE the lock: an identical PATCH changes no
  // number a bid depends on, so it must stay a clean no-op even here.
  const idemUnderLock = await projects.setSitePlanCalibration(proj.id, page.id, INPUT, { by: "USR-001" });
  eq(idemUnderLock.changed, false, "an identical PATCH is still a no-op on a locked page (not a 409)");

  // Deleting a traced-over page is refused without force; force keeps the
  // geometry while detaching the reference.
  const refused = await throwsWithCode(
    () => projects.removeSitePlanPage(proj.id, page.id, { by: "USR-001" }),
    "page_has_dependents",
    "deleting a traced-over page is refused without force"
  );
  ok(refused && /Front Bed/.test(refused.message), "...naming the dependent areas");

  const removed = await projects.removeSitePlanPage(proj.id, page.id, { force: true, by: "USR-001" });
  deepEq(removed.detached, ["Front Bed", "Rear Lawn"], "a forced delete reports what it detached");
  const after = await projects.get(proj.id);
  eq(after.sitePlan, null, "the last page removed clears sitePlan");
  ok(!after.systemDesign.areas[0].planRef, "planRef is cleared on the dependent areas");
  eq(after.systemDesign.areas[0].poly.length, 3, "...but the traced geometry is KEPT (it is already in feet)");
  eq(after.systemDesign.areas[2].name, "Hand sketch", "...and untraced areas are untouched");
}

// ══════════════════════════════════════════════════════════════════════
// 10. Aggregate sheet-coverage sanity check
// ══════════════════════════════════════════════════════════════════════
group("10. Aggregate sheet-coverage sanity check");
{
  const page = { rasterWidthPx: 4000, rasterHeightPx: 3000, calibration: { ftPerPx: 0.2 } };
  // 4000 x 3000 px at 0.2 ft/px = 800 x 600 ft = 480,000 sq ft.
  eq(cal.sheetExtentSqFt(page), 480000, "sheet extents derive from the calibrated scale");
  eq(cal.checkSheetCoverage(page, 100000).warn, false, "21% of the sheet does not warn");
  eq(cal.checkSheetCoverage(page, 383000).warn, false, "79.8% of the sheet does not warn");
  eq(cal.checkSheetCoverage(page, 400000).warn, true, "83% of the sheet warns");
  ok(/scale error/i.test(cal.checkSheetCoverage(page, 400000).message), "...naming the likely cause");
  eq(cal.sheetExtentSqFt({ rasterWidthPx: 100, rasterHeightPx: 100, calibration: {} }), 0,
     "an uncalibrated page has no computable extent (and cannot warn)");
}

// ---- Teardown ---------------------------------------------------------

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\nsite-plan calibration: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

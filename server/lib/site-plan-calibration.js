// Site-plan scale calibration — the accuracy core.
//
// ── Why this is a module and not inline in the builder ──────────────────
//
// The numbers in here go into a competitive tender. A scale error does not
// produce a visibly broken screen; it produces a confidently wrong bid. A
// factor-of-two scale confusion (1:100 read as 1:200) yields a plan that
// looks entirely plausible and a bid that is half or double what it should
// be.
//
// So the authoritative derivation lives in ONE place — here — and is
// exercised by scripts/test-siteplan-calibration.mjs on every build:check.
// server.js derives `ftPerPx` and the verification verdict from the raw
// clicked points on the way in; it does NOT accept a client-computed
// `ftPerPx`. The builder UI computes the same numbers live for preview, but
// what gets persisted (and therefore what a bid depends on) is always the
// value this module returned.
//
// Three rules govern everything here. They are correctness requirements,
// not quality-of-life features:
//
//   1. No tracing on an uncalibrated sheet. Hard gate, not a warning.
//   2. Calibration must be independently verified against a SECOND known
//      dimension before the sheet is usable. One control measurement is
//      not a measurement.
//   3. A number a bid depends on is never silently changed. Recalibration
//      after tracing is refused (Phase 1), never applied quietly.
//
// Pure functions only — no fs, no network, no dependencies. Everything
// throws a human-readable Error on bad input rather than returning NaN,
// because a NaN that reaches the UI reads as "0 sq ft" and a NaN that
// reaches the record poisons the tender silently.

"use strict";

// ---- Identity + path-safety ------------------------------------------
//
// Page ids are minted as "spp_" + random8() (lowercase base36, 8 chars),
// matching the att_ / sec_ / li_ / iss_ child-item convention. This regex
// is the ONLY thing standing between a request path segment and a
// path.join — it must be validated BEFORE any filesystem call, never
// after. Anchored, lowercase-only, fixed length: "spp_../..",
// "../../etc/passwd" and "spp_ABCDEFGH" all fail.
const PAGE_ID_RE = /^spp_[a-z0-9]{8}$/;

// Project ids are PROJ-YYYY-NNNN (lib/projects.js nextProjectId).
const PROJECT_ID_RE = /^PROJ-\d{4}-\d{4}$/;

function isValidPageId(id) {
  return typeof id === "string" && PAGE_ID_RE.test(id);
}

function isValidProjectId(id) {
  return typeof id === "string" && PROJECT_ID_RE.test(id);
}

// ---- Thresholds -------------------------------------------------------
//
// Residual bands for the mandatory second-dimension verification. These
// are business logic, not tuning knobs — they are documented in
// SYSTEM_OVERVIEW.md ("Site plan calibration") and changing them changes
// what PJL is willing to bid on.
const RESIDUAL_PASS_MAX_PCT = 0.5;   // < 0.5%      → passed  (green, tracing unlocked)
const RESIDUAL_WARN_MAX_PCT = 2.0;   // 0.5% – 2.0% → warned  (amber, needs acknowledgment)
                                     // > 2.0%      → failed  (red, tracing BLOCKED)

// A verification measurement taken on top of the calibration measurement
// proves nothing — it is the same two clicks and will always agree with
// itself. Verify points must be a genuinely different pair.
const MIN_VERIFY_SEPARATION_PX = 5;

// Aggregate sanity: traced area summing to more than this fraction of the
// sheet's own calibrated extents is the signature of an order-of-magnitude
// scale error. Non-blocking warning — a real site CAN cover most of its
// sheet, it just usually doesn't.
const SHEET_COVERAGE_WARN_FRACTION = 0.8;

// Vertex budget — protects the 512 KB systemDesign cap. Losing an hour of
// tracing to a failed save is unacceptable, so we refuse locally, early,
// with a message that explains the limit.
const VERTEX_SOFT_LIMIT = 3000;      // amber warning, still allowed
const VERTEX_HARD_LIMIT = 4000;      // refuse to add more
const DESIGN_PREFLIGHT_MAX_BYTES = 480 * 1024;  // client refuses above this…
const DESIGN_SERVER_MAX_BYTES = 512 * 1024;     // …32 KB under the server's hard cap

// Stored coordinate precision. 3 dp of a foot is ~0.012 inch — far finer
// than a raster underlay can express, and full float precision would waste
// a meaningful fraction of the 512 KB budget on noise digits.
const COORD_DECIMALS = 3;

// ---- Numeric helpers --------------------------------------------------

function round3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error("Expected a finite number.");
  // Number(v.toFixed(3)) rather than Math.round(v*1000)/1000 — the latter
  // drifts on large coordinates, and traced polys carry large coordinates
  // (hundreds of feet from the page origin) by design.
  return Number(v.toFixed(COORD_DECIMALS));
}

function finitePositive(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return n;
}

function readPoint(pt, label) {
  if (!pt || typeof pt !== "object") throw new Error(`${label} is missing.`);
  const x = Number(pt.x), y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} must have finite x and y pixel coordinates.`);
  }
  return { x, y };
}

function distancePx(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---- Two-point calibration -------------------------------------------
//
// The user clicks two points on a dimension printed on the plan — a stated
// dimension string, a property line, a building face — and types the true
// distance in feet. Everything downstream is this one ratio.
//
// Page world-coordinate model (no rotation in Phase 1):
//     world_ft_x = raster_px_x * ftPerPx
//     world_ft_y = raster_px_y * ftPerPx
// Raster pixel (0,0) maps to world (0,0).
function deriveFtPerPx({ p1, p2, knownFt } = {}) {
  const a = readPoint(p1, "First calibration point");
  const b = readPoint(p2, "Second calibration point");
  const ft = finitePositive(knownFt, "Known distance");
  const px = distancePx(a, b);
  if (px < 1) {
    throw new Error(
      "The two calibration points are on top of each other. Zoom in and click the two ends of a dimension you know."
    );
  }
  return { ftPerPx: ft / px, pixelDistance: px };
}

// ---- Mandatory verification ------------------------------------------
//
// One control measurement is not a measurement. The user clicks a SECOND,
// independent known dimension; we measure it under the derived ftPerPx and
// compare against what they say it should be.
//
// The residual is classified on the RAW value and only then rounded for
// storage — rounding first would let 0.499% round to 0.5% and silently
// cross a band boundary.
function classifyResidual(residualPct) {
  const r = Math.abs(Number(residualPct));
  if (!Number.isFinite(r)) throw new Error("Residual must be a finite number.");
  if (r < RESIDUAL_PASS_MAX_PCT) return "passed";
  if (r <= RESIDUAL_WARN_MAX_PCT) return "warned";
  return "failed";
}

// Reject verification points that sit on top of the calibration points —
// re-measuring the same two clicks agrees with itself by construction and
// proves nothing about the sheet.
function verifyPointsAreIndependent({ calP1, calP2, verP1, verP2 } = {}) {
  const c1 = readPoint(calP1, "First calibration point");
  const c2 = readPoint(calP2, "Second calibration point");
  const v1 = readPoint(verP1, "First verification point");
  const v2 = readPoint(verP2, "Second verification point");
  for (const v of [v1, v2]) {
    for (const c of [c1, c2]) {
      if (distancePx(v, c) < MIN_VERIFY_SEPARATION_PX) {
        return {
          ok: false,
          reason:
            "Verification has to use a different dimension from the one you calibrated on — " +
            "re-measuring the same two points always agrees with itself. Pick a second known " +
            "dimension, ideally on the other axis."
        };
      }
    }
  }
  return { ok: true, reason: "" };
}

function verifyCalibration({ ftPerPx, p1, p2, expectedFt } = {}) {
  const scale = finitePositive(ftPerPx, "ftPerPx");
  const a = readPoint(p1, "First verification point");
  const b = readPoint(p2, "Second verification point");
  const expected = finitePositive(expectedFt, "Expected distance");
  const px = distancePx(a, b);
  if (px < 1) {
    throw new Error(
      "The two verification points are on top of each other. Zoom in and click the two ends of a second known dimension."
    );
  }
  const measuredFt = px * scale;
  const residualPctRaw = (Math.abs(measuredFt - expected) / expected) * 100;
  return {
    measuredFt: round3(measuredFt),
    residualPct: round3(residualPctRaw),
    state: classifyResidual(residualPctRaw),   // classified on the RAW value
    pixelDistance: px
  };
}

// Plain-language reason for a failed verification. Named causes beat
// "verification failed" — the user has to know which of the three likely
// mistakes to go fix.
function failureAdvice(residualPct) {
  const r = Math.abs(Number(residualPct)) || 0;
  const near2x = r > 45 && r < 55;
  const nearHalf = r > 95 && r < 105;
  const parts = [
    `The second dimension came out ${r.toFixed(2)}% off what you said it should be, which is past the 2% limit.`
  ];
  if (near2x || nearHalf) {
    parts.push(
      "An error this close to a factor of two almost always means the scale was read " +
      "one step out (1:100 taken as 1:200, or the sheet exported at half size)."
    );
  }
  parts.push(
    "Likely causes: the dimension you typed doesn't match the one you clicked; the clicks " +
    "weren't precise enough (zoom in and retry); or the sheet isn't drawn to scale."
  );
  return parts.join(" ");
}

// ---- Stated-scale cross-check (advisory only) ------------------------
//
// The title block's printed scale is a CLAIM about the file. The physical
// file is the truth, so the two-point calibration stays authoritative and
// this is offered as a cross-check, never as a gate. Its real job is to
// catch a sheet that was scaled on export or printed to-fit — that shows
// up here immediately as a large delta.
//
// Accepted forms: "1:200", "1\"=20'", "1/8\"=1'", '3/16" = 1ft', "1cm=2m".
// Returns feet of real world per INCH of paper, or null if unparseable.
function parseStatedScale(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/\s+/g, "");

  // Ratio form — "1:200", "1/200". One paper unit = N real units, so one
  // paper INCH is N inches, i.e. N/12 feet.
  const ratio = s.match(/^1[:/](\d+(?:\.\d+)?)$/);
  if (ratio) {
    const n = Number(ratio[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { kind: "ratio", ftPerPaperInch: n / 12, normalized: `1:${ratio[1]}` };
  }

  // Engineering / architectural form — "<paper measure> = <real measure>".
  const eq = s.match(/^(.+?)=(.+)$/);
  if (!eq) return null;
  const paper = parseLength(eq[1]);
  const real = parseLength(eq[2]);
  if (!paper || !real || paper.inches <= 0) return null;
  // real.inches per paper.inches → feet of world per inch of paper.
  return {
    kind: "equation",
    ftPerPaperInch: (real.inches / paper.inches) / 12,
    normalized: raw.slice(0, 40)
  };
}

// "1/8\"", "20'", "1ft", "2m", "1cm" → inches. Handles bare fractions.
function parseLength(text) {
  const t = String(text).trim();
  const m = t.match(/^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(.*)$/);
  if (!m) return null;
  let value;
  if (m[1].includes("/")) {
    const [a, b] = m[1].split("/").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    value = a / b;
  } else {
    value = Number(m[1]);
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].replace(/[^a-z"']/g, "");
  const PER_INCH = {
    "": 1, '"': 1, "in": 1, "ins": 1, "inch": 1, "inches": 1,
    "'": 12, "ft": 12, "feet": 12, "foot": 12,
    "m": 39.3700787402, "cm": 0.3937007874, "mm": 0.0393700787
  };
  const factor = PER_INCH[unit];
  if (factor == null) return null;
  return { inches: value * factor };
}

// Compare the derived ftPerPx against the sheet's printed scale.
//
// The bridge between paper space and raster space is the pdf.js render
// scale: at scale 1.0 one PDF user unit renders to one pixel, and one PDF
// user unit is 1/72 inch. So the raster carries (72 * renderScale) pixels
// per inch of paper.
//
// For a PNG/JPEG upload there is no paper space at all — no renderScale,
// no DPI we can trust — so the cross-check is genuinely unavailable rather
// than merely inconvenient, and we say so instead of inventing a number.
function statedScaleCrossCheck({ statedScale, ftPerPx, renderScale } = {}) {
  const parsed = parseStatedScale(statedScale);
  if (!parsed) {
    return { available: false, reason: "Couldn't read that scale. Try a form like 1:200, 1\"=20', or 1/8\"=1'." };
  }
  const scale = Number(ftPerPx);
  const rs = Number(renderScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { available: false, reason: "Calibrate the sheet first — there's no measured scale to compare against yet." };
  }
  if (!Number.isFinite(rs) || rs <= 0) {
    return {
      available: false,
      statedScale: parsed.normalized,
      reason: "This sheet came in as an image, so there's no paper size to compare a printed scale against. The two-point calibration is the only scale here."
    };
  }
  const pxPerPaperInch = 72 * rs;
  const expectedFtPerPx = parsed.ftPerPaperInch / pxPerPaperInch;
  const deltaPct = (Math.abs(scale - expectedFtPerPx) / expectedFtPerPx) * 100;
  return {
    available: true,
    statedScale: parsed.normalized,
    expectedFtPerPx: expectedFtPerPx,
    measuredFtPerPx: scale,
    deltaPct: round3(deltaPct),
    // Advisory bands. A sheet exported "fit to page" typically lands 3-15%
    // out; a scale misread lands near 50% or 100%.
    agrees: deltaPct < 2,
    note: deltaPct < 2
      ? "Measured scale agrees with the printed scale."
      : deltaPct < 15
        ? "Measured scale is off the printed scale — this sheet was probably exported or printed to-fit. Your two-point calibration is what counts; the title block is just a claim about the file."
        : "Measured scale is a long way off the printed scale. Check you typed the right dimension, and that this is the sheet you think it is."
  };
}

// ---- Aggregate sanity check ------------------------------------------
//
// After each traced area is committed, compare the sum of traced area on a
// page against the page's own calibrated extents. Traced area over 80% of
// the sheet is the signature of an order-of-magnitude scale error — a real
// site can cover most of its sheet, so this warns and does not block.
function sheetExtentSqFt(page) {
  if (!page || !page.calibration) return 0;
  const ftPerPx = Number(page.calibration.ftPerPx);
  const w = Number(page.rasterWidthPx), h = Number(page.rasterHeightPx);
  if (!Number.isFinite(ftPerPx) || ftPerPx <= 0) return 0;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0;
  return w * h * ftPerPx * ftPerPx;
}

function checkSheetCoverage(page, tracedSqFt) {
  const extent = sheetExtentSqFt(page);
  const traced = Number(tracedSqFt) || 0;
  if (extent <= 0) return { warn: false, fraction: 0, extentSqFt: 0 };
  const fraction = traced / extent;
  return {
    warn: fraction > SHEET_COVERAGE_WARN_FRACTION,
    fraction,
    extentSqFt: extent,
    message: `Traced areas on this sheet now total ${Math.round(traced).toLocaleString()} sq ft — ` +
      `${Math.round(fraction * 100)}% of the whole sheet's calibrated extents ` +
      `(${Math.round(extent).toLocaleString()} sq ft). That's usually the signature of a ` +
      `scale error an order of magnitude out. Worth re-checking the calibration before you bid this.`
  };
}

// ---- Vertex + payload budget -----------------------------------------

function classifyVertexBudget(count) {
  const n = Number(count) || 0;
  if (n >= VERTEX_HARD_LIMIT) return "blocked";
  if (n >= VERTEX_SOFT_LIMIT) return "warn";
  return "ok";
}

// The user must never learn about the 512 KB cap from a failed request.
// The builder runs this against the serialized blob before it PATCHes.
function preflightDesignSize(byteLength) {
  const n = Number(byteLength) || 0;
  if (n > DESIGN_PREFLIGHT_MAX_BYTES) {
    return {
      ok: false,
      bytes: n,
      message:
        `This design is ${(n / 1024).toFixed(0)} KB and the project record caps saved designs at ` +
        `${Math.round(DESIGN_SERVER_MAX_BYTES / 1024)} KB. Simplify the most detailed traced areas ` +
        `(fewer points along straight runs) and save again. Nothing has been lost — this refused ` +
        `before sending, so your work is still on screen.`
    };
  }
  return { ok: true, bytes: n, message: "" };
}

// Round a polygon's coordinates for storage. Translation-invariant
// geometry (polyArea / polyPerim / pointInPoly) means large traced
// coordinates are harmless; the rounding is purely a budget measure.
function roundPoly(poly) {
  if (!Array.isArray(poly)) return [];
  return poly.map((p) => ({ x: round3(p.x), y: round3(p.y) }));
}

function countVertices(areas) {
  if (!Array.isArray(areas)) return 0;
  return areas.reduce((sum, a) => sum + (Array.isArray(a && a.poly) ? a.poly.length : 0), 0);
}

module.exports = {
  // identity / path safety
  PAGE_ID_RE,
  PROJECT_ID_RE,
  isValidPageId,
  isValidProjectId,

  // thresholds
  RESIDUAL_PASS_MAX_PCT,
  RESIDUAL_WARN_MAX_PCT,
  MIN_VERIFY_SEPARATION_PX,
  SHEET_COVERAGE_WARN_FRACTION,
  VERTEX_SOFT_LIMIT,
  VERTEX_HARD_LIMIT,
  DESIGN_PREFLIGHT_MAX_BYTES,
  DESIGN_SERVER_MAX_BYTES,
  COORD_DECIMALS,

  // math
  round3,
  distancePx,
  deriveFtPerPx,
  classifyResidual,
  verifyPointsAreIndependent,
  verifyCalibration,
  failureAdvice,
  parseStatedScale,
  statedScaleCrossCheck,
  sheetExtentSqFt,
  checkSheetCoverage,
  classifyVertexBudget,
  preflightDesignSize,
  roundPoly,
  countVertices
};

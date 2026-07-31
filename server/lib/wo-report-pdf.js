// Work Order Service / Inspection Report PDF generator. Branded
// customer-facing document that renders the WO walkthrough as a
// human-readable narrative — what the tech found, what was done, what
// was deferred. Distinct from the quote PDF (financial artifact) and the
// invoice PDF (billing artifact): this is the SERVICE narrative.
//
// Two modes, same renderer:
//   inspection_report — pre-completion. Renders findings only.
//                       Used as evidence attached to send-for-approval
//                       emails when the customer is not on-site.
//   service_report    — post-completion (locked WO). Renders findings,
//                       work performed, dispositions, signature, and
//                       (for fall_closing) the standard liability
//                       disclaimer.
//
// HARD RULES:
//   1. No prices. Anywhere. The financial artifacts are quote + invoice.
//      Dispositions render as words ("Repaired on this visit"), never
//      as priced lines.
//   2. No PVC language. PJL uses HDPE poly pipe. Never "PVC" anywhere.
//   3. No backflow content. PJL is not a certified Ontario backflow
//      tester. Service-specific checklists per work-orders.js
//      SERVICE_CHECKLISTS intentionally omit backflow.
//   4. Brand: Barlow Condensed for headings (falls back to Helvetica-
//      Bold if the TTF is missing). Header lockup reads "PJL Land
//      Services". Tech name hardcoded as "Patrick Lalande" — multi-tech
//      support deferred per brief §6.
//
// Photos render via doc.image(buffer, { fit: [w,h] }). pdfkit scales
// down at embed time — we do NOT pre-process disk copies. JPEGs stay
// as JPEGs in the PDF. Missing files render a "Photo unavailable"
// placeholder block instead of throwing.

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const PJL_GREEN = "#1B4D2E";
const PJL_AMBER = "#E07B24";
const PJL_TEXT = "#1F2A22";
const PJL_MUTED = "#6A6A60";
const PJL_RULE = "#D6D6CC";

// Mirror quote-pdf.js — Barlow Condensed font + dark logo PNG, lazy-
// loaded once per process. Both fall back gracefully if the asset is
// missing (font → Helvetica-Bold; logo → text lockup).
const BARLOW_BOLD_PATH = path.resolve(__dirname, "..", "assets", "fonts", "BarlowCondensed-Bold.ttf");
const LOGO_PNG_PATH = path.resolve(__dirname, "..", "assets", "logo-dark.png");
let _barlowBuf = null;
let _logoBuf = null;
function barlowBuffer() {
  if (_barlowBuf !== null) return _barlowBuf;
  try { _barlowBuf = fsSync.readFileSync(BARLOW_BOLD_PATH); }
  catch { _barlowBuf = false; }
  return _barlowBuf;
}
function logoBuffer() {
  if (_logoBuf !== null) return _logoBuf;
  try { _logoBuf = fsSync.readFileSync(LOGO_PNG_PATH); }
  catch { _logoBuf = false; }
  return _logoBuf;
}
function fontHeading() { return barlowBuffer() ? "Barlow-Bold" : "Helvetica-Bold"; }

const WO_PHOTOS_BASE = path.resolve(__dirname, "..", "data", "wo-photos");

const SERVICE_LABEL = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};

const ISSUE_TYPE_LABEL = {
  broken_head: "Sprinkler head",
  leak: "Leak",
  valve: "Valve",
  wire: "Wire",
  pipe: "Irrigation pipe",
  controller: "Controller",
  other: "Other"
};

const ISSUE_SUBTYPE_LABEL = {
  pgp_4: "Hunter PGP (4\")",
  pgp_6: "Hunter PGP (6\")",
  pgp_12: "Hunter PGP (12\")",
  prospray_4: "Hunter Pro-Spray (4\")",
  prospray_6: "Hunter Pro-Spray (6\")",
  prospray_12: "Hunter Pro-Spray (12\" mulch)",
  i20: "Hunter I-20 rotor",
  mp_rotator: "MP Rotator",
  drip: "Drip emitter",
  pgv_full: "Hunter PGV valve replacement + manifold rebuild",
  solenoid: "Solenoid replacement",
  diaphragm: "Diaphragm rebuild",
  cut: "Control wire cut",
  removed: "Control wire removed",
  no_comms: "Control wire not communicating with controller",
  splice: "Splice failure / waterlogged connector",
  poly_1: "1\" HDPE poly pipe break",
  poly_3_4: "3/4\" HDPE poly pipe break",
  funny: "1/2\" funny pipe break",
  hpc_4: "4-zone Hydrawise controller",
  hpc_8: "8-zone Hydrawise controller",
  hpc_16: "16-zone Hydrawise controller",
  module: "Zone-expansion module",
  rain_sensor: "Rain sensor"
};

const SERVICE_CHECKLIST_LABELS = {
  water_on: "Water turned on at main shut-off",
  controller_programmed: "Controller programmed for season",
  walkthrough_with_customer: "Walk-through with customer (if home)",
  controller_off: "Controller set to off / winter mode",
  water_off: "Water shut off at main",
  compressor_connected: "Compressor connected at blow-out",
  zones_blown_clear: "All zones blown clear",
  compressor_disconnected: "Compressor disconnected",
  system_winterized: "System winterized"
};

// Fall-closing liability disclaimer (brief Appendix). Renders as the
// final body block on the service report when wo.type === fall_closing.
// Per brief: pulled from Patrick's existing language; tweak text here
// if a different wording is desired.
const FALL_CLOSING_DISCLAIMER =
  "PJL Land Services possesses extensive knowledge of plumbing systems and best " +
  "practices for ensuring an efficient and thorough closing. We must inform you " +
  "that we cannot assume liability for any issues that may arise over the winter months.";

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-CA", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/Toronto"
  });
}

function listify(arr) {
  if (!Array.isArray(arr) || !arr.length) return "—";
  return arr.map((v) => String(v).replace(/_/g, " ")).join(", ");
}

function issueLabel(issue) {
  const type = ISSUE_TYPE_LABEL[issue?.type] || "Other";
  const sub = issue?.subtype ? ISSUE_SUBTYPE_LABEL[issue.subtype] || "" : "";
  return sub ? `${type} — ${sub}` : type;
}

// Photo files on disk live at server/data/wo-photos/<woId>/<n>.<ext>.
// We read sync into a Buffer (pdfkit expects buffers or paths) and let
// pdfkit's `fit:` scale at embed time. Returns null if the file is
// missing — caller renders a placeholder block.
// ---- Render derivatives (OOM fix, Jul 2026) --------------------------
// pdfkit's `fit:` only scales the DISPLAYED size — it embeds the original
// JPEG bytes verbatim. Twenty 9 MB phone photos therefore produced a
// ~281 MB PDF, which OOM-killed the 512 MB Render instance on every
// render (send-for-approval, manual snapshot, post-completion
// auto-snapshot).
//
// Fix: render from a cached downscaled derivative instead of the
// original. Photos print at ~140–220 pt wide, so 1400 px is still ~340
// DPI on paper — visually identical, ~96% smaller.
//
// Derivatives are generated by the ASYNC ensurePhotoDerivatives() below
// (sharp is async; generateWoReportPdf is sync) and cached on disk next
// to the original as `<n>@1400.jpeg`. readPhotoSync prefers the
// derivative and silently falls back to the original, so a render that
// skipped the prep step still succeeds — just larger.
const DERIVATIVE_MAX_EDGE = 1400;
const DERIVATIVE_QUALITY = 72;
const derivativePath = (woId, n) =>
  path.join(WO_PHOTOS_BASE, woId, `${n}@${DERIVATIVE_MAX_EDGE}.jpeg`);

function originalPhotoPath(woId, photo) {
  const ext = (photo.ext || photo.mediaType?.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "");
  const candidates = [];
  if (photo.ext) candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.${photo.ext}`));
  candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.${ext}`));
  candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.jpg`));
  candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.jpeg`));
  candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.png`));
  candidates.push(path.join(WO_PHOTOS_BASE, woId, `${photo.n}.webp`));
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

// Generate any missing downscaled derivatives for a WO's photos. Call
// this (and await it) before rendering a report. Idempotent and cached —
// a second render costs nothing. Per-photo failures are swallowed: the
// renderer just falls back to the original for that one photo.
async function ensurePhotoDerivatives(woId, photos) {
  if (!woId || !Array.isArray(photos) || !photos.length) return { made: 0, skipped: 0, failed: 0 };
  let sharp = null;
  try { sharp = require("sharp"); }
  catch (_) { return { made: 0, skipped: photos.length, failed: 0, noSharp: true }; }

  let made = 0, skipped = 0, failed = 0;
  for (const photo of photos) {
    if (!photo || !photo.n || !isPdfRenderableImage(photo)) { skipped++; continue; }
    const dest = derivativePath(woId, photo.n);
    if (fsSync.existsSync(dest)) { skipped++; continue; }
    const src = originalPhotoPath(woId, photo);
    if (!src) { skipped++; continue; }
    try {
      await sharp(src, { failOn: "none" })
        // Bake EXIF orientation into the pixels, then drop metadata. The
        // project rule is never to change how a photo LOOKS — .rotate()
        // with no argument only applies the camera's own orientation tag,
        // which is what every viewer already does. No mirroring, no crop.
        .rotate()
        .resize({ width: DERIVATIVE_MAX_EDGE, height: DERIVATIVE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: DERIVATIVE_QUALITY, mozjpeg: true })
        .toFile(dest);
      made++;
    } catch (err) {
      failed++;
      console.warn(`[wo-report] derivative failed for ${woId}#${photo.n}:`, err?.message);
    }
  }
  return { made, skipped, failed };
}

function readPhotoSync(woId, photo) {
  if (!photo || !photo.n) return null;
  try {
    // Prefer the downscaled derivative; fall back to the original.
    const deriv = derivativePath(woId, photo.n);
    if (fsSync.existsSync(deriv)) return fsSync.readFileSync(deriv);
    const src = originalPhotoPath(woId, photo);
    if (src) return fsSync.readFileSync(src);
  } catch (_) { /* fall through */ }
  return null;
}

// Embed each photo ONCE per document. The same photo appears inline in the
// zone/issue walkthrough AND in the Media Summary grid; without this it was
// embedded twice (36 image objects for 20 photos), roughly doubling the
// file. doc.openImage() returns a reusable image object that pdfkit writes
// as a single XObject however many times it's drawn.
function openPhotoCached(doc, woId, photo) {
  if (!doc.__pjlImgCache) doc.__pjlImgCache = new Map();
  const key = String(photo?.n ?? "");
  if (!key) return null;
  if (doc.__pjlImgCache.has(key)) return doc.__pjlImgCache.get(key);
  let img = null;
  try {
    const buf = readPhotoSync(woId, photo);
    if (buf) img = doc.openImage(buf);
  } catch (_) { img = null; }
  doc.__pjlImgCache.set(key, img);
  return img;
}

// Pdfkit doesn't natively render HEIC. JPEG / PNG are the safe set.
// We feed only those into doc.image(). The upload pipeline allows HEIC
// (mobile-camera) but the renderer placeholders any non-JPEG/PNG.
function isPdfRenderableImage(photo) {
  const mt = (photo?.mediaType || "").toLowerCase();
  return mt.startsWith("image/jpeg") || mt.startsWith("image/png") || mt === "image/jpg";
}

// Disposition resolver. Issues on a service_visit / spring_opening
// flow into the on-site quote builder; deferred issues survive as
// property.deferredIssues entries. The renderer takes both an issue
// record and the WO's overall state to decide what to render. For
// inspection_report mode, the disposition is always "Identified on-site"
// regardless of subsequent fixes.
function dispositionFor(issue, wo, mode) {
  if (mode === "inspection_report") return "Identified on-site";
  if (issue?.resolvedToday === true) return "Repaired on this visit";
  if (issue?.declinedToday === true) return "Customer declined";
  if (issue?.deferred === true) return "Deferred to next visit";
  // Default behaviour by WO type:
  if (wo?.type === "fall_closing") return "Deferred to spring follow-up";
  if (wo?.locked) return "Resolved on this visit";
  return "Identified on-site";
}

// Page footer — rendered on every page. Drops the bottom margin to 0
// around the write so pdfkit's LineWrapper doesn't auto-pagebreak when
// text() lands within the bottom margin (same trick used by
// quote-pdf.js / invoice-pdf.js).
function drawFooter(doc, woId, mode) {
  const restoreBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 38;
  doc.moveTo(60, footerY).lineTo(doc.page.width - 60, footerY)
    .strokeColor(PJL_RULE).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED);
  const title = mode === "service_report" ? "Service Report" : "Inspection Report";
  doc.text(`PJL Land Services · ${title} · ${woId}`,
    60, footerY + 6,
    { width: doc.page.width - 120, align: "left", lineBreak: false });
  doc.text(`Private & Confidential · Page ${doc.bufferedPageRange().start + doc.bufferedPageRange().count}`,
    60, footerY + 6,
    { width: doc.page.width - 120, align: "right", lineBreak: false });
  doc.page.margins.bottom = restoreBottom;
}

// pdfkit doesn't fire a per-page hook out of the box, but every new
// page raises a `pageAdded` event AFTER it switches to the new page.
// We use that to drop a footer onto every page including the first.
function wirePerPageFooter(doc, woId, mode) {
  doc.on("pageAdded", () => {
    // Reset cursor to body so the header band re-renders from a clean
    // starting point on the new page.
    drawFooter(doc, woId, mode);
    doc.x = 60;
    doc.y = 60;
  });
}

function ensureSpace(doc, needed) {
  const limit = doc.page.height - doc.page.margins.bottom - 60; // 60 = footer band
  if (doc.y + needed > limit) doc.addPage();
}

function sectionHeading(doc, label, opts = {}) {
  ensureSpace(doc, 30);
  doc.font(fontHeading()).fontSize(13).fillColor(PJL_GREEN);
  doc.text(label, 60, doc.y, { characterSpacing: 0.8 });
  doc.moveTo(60, doc.y + 2).lineTo(doc.page.width - 60, doc.y + 2)
    .strokeColor(PJL_GREEN).lineWidth(0.7).stroke();
  doc.moveDown(0.4);
  doc.fillColor(PJL_TEXT);
  if (opts.subtle) {
    doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
    doc.text(opts.subtle, 60, doc.y, { width: doc.page.width - 120 });
    doc.fillColor(PJL_TEXT);
    doc.moveDown(0.3);
  }
}

function keyValueRow(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(PJL_MUTED);
  doc.text(label.toUpperCase(), 60, doc.y, { width: 160, continued: false, characterSpacing: 0.8 });
  const startY = doc.y - 11;
  doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
  doc.text(value || "—", 220, startY, { width: doc.page.width - 60 - 220 });
  doc.moveDown(0.2);
}

function ruleLine(doc) {
  doc.moveTo(60, doc.y + 2).lineTo(doc.page.width - 60, doc.y + 2)
    .strokeColor(PJL_RULE).lineWidth(0.4).stroke();
  doc.moveDown(0.3);
}

// Inline photo row — lays out small thumbnails in rows, captioning each
// with its label if present. Used for zone-level photos (indented at the
// zone-card left margin) and issue-level photos (indented under the
// issue bullet). Brief: ~150px max edge for inline thumbs. pdfkit's
// `fit:` preserves aspect (no cropping), so portrait phone photos
// render as ~75×100 inside the 140×100 box instead of getting squished.
function renderPhotoRow(doc, wo, photos, opts = {}) {
  if (!photos || !photos.length) return;
  const x0 = opts.x || 60;
  const thumbW = opts.thumbW || 140;
  const thumbH = opts.thumbH || 100;
  const gap = opts.gap || 10;
  const captionH = opts.captionH || 12;
  const rowH = thumbH + captionH + 4;

  const pageRightX = doc.page.width - 60;
  const availableW = pageRightX - x0;
  const perRow = Math.max(1, Math.floor((availableW + gap) / (thumbW + gap)));

  let i = 0;
  while (i < photos.length) {
    ensureSpace(doc, rowH + 4);
    const rowY = doc.y;
    for (let col = 0; col < perRow && i < photos.length; col++) {
      const p = photos[i];
      const x = x0 + col * (thumbW + gap);
      let buf = null;
      try { buf = openPhotoCached(doc, wo.id, p); } catch (_) { buf = null; }
      if (buf) {
        try {
          doc.image(buf, x, rowY, { fit: [thumbW, thumbH] });
        } catch (_) {
          doc.rect(x, rowY, thumbW, thumbH).fillAndStroke("#F5F5F0", PJL_RULE);
          doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED);
          doc.text("Photo unavailable", x, rowY + thumbH / 2 - 5,
            { width: thumbW, align: "center" });
        }
      } else {
        doc.rect(x, rowY, thumbW, thumbH).fillAndStroke("#F5F5F0", PJL_RULE);
        doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED);
        doc.text("Photo unavailable", x, rowY + thumbH / 2 - 5,
          { width: thumbW, align: "center" });
      }
      if (p.label) {
        doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED);
        doc.text(String(p.label).slice(0, 60), x, rowY + thumbH + 2,
          { width: thumbW, lineBreak: false, ellipsis: true });
      }
      i += 1;
    }
    doc.y = rowY + rowH;
  }
}

// ---- Renderer entry point --------------------------------------------

function generateWoReportPdf({ wo, property = {}, customer = {}, mode, audience = "internal" }) {
  if (!wo || !wo.id) throw new Error("generateWoReportPdf requires a work order with an id.");
  if (mode !== "inspection_report" && mode !== "service_report") {
    throw new Error(`generateWoReportPdf: unknown mode "${mode}".`);
  }
  // audience — "internal" (admin/tech, full audit incl. signature bypass +
  // post-completion corrections) vs "customer" (omits both). Default
  // "internal" keeps every existing call site backwards-compatible.
  if (audience !== "internal" && audience !== "customer") {
    throw new Error(`generateWoReportPdf: unknown audience "${audience}".`);
  }

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    bufferPages: true,
    info: {
      Title: `${mode === "service_report" ? "Service" : "Inspection"} Report — ${wo.id}`,
      Author: "PJL Land Services",
      Subject: `${SERVICE_LABEL[wo.type] || "Visit"} at ${wo.address || property.address || ""}`,
      Keywords: `pjl service report ${wo.id}`
    }
  });

  const barlow = barlowBuffer();
  if (barlow) doc.registerFont("Barlow-Bold", barlow);

  wirePerPageFooter(doc, wo.id, mode);

  // ---- Header (mirrors quote-pdf.js shape) ---------------------------
  // Title left in big green Barlow, "Service Visit" / "Spring Opening
  // YYYY" / "Fall Closing YYYY" sub-line in amber, PJL Land Services
  // address block stacked beneath (3 lines), then Work Order /
  // Conducted on / Tech stacked vertically in light grey. Logo (~160px)
  // sits top-right, same as the quote.
  const PAGE_W = doc.page.width;
  const MARGIN_X = 60;
  const top = 40;
  const LOGO_W = 160;

  const docTitle = mode === "service_report" ? "SERVICE REPORT" : "INSPECTION REPORT";
  doc.font(fontHeading()).fontSize(30).fillColor(PJL_GREEN);
  doc.text(docTitle, MARGIN_X, top, {
    characterSpacing: 1.5,
    width: PAGE_W - MARGIN_X * 2 - LOGO_W - 16,
    lineGap: 0
  });

  // Sub-line — service type with year for seasonal visits.
  const visitIso = wo.arrivedAt || wo.scheduledFor || wo.createdAt || new Date().toISOString();
  const visitYear = String(new Date(visitIso).getFullYear());
  const subContextBase = SERVICE_LABEL[wo.type] || "Visit";
  const subContext = (wo.type === "spring_opening" || wo.type === "fall_closing")
    ? `${subContextBase} ${visitYear}`
    : subContextBase;
  doc.font(fontHeading()).fontSize(15).fillColor(PJL_AMBER);
  doc.text(subContext, MARGIN_X, doc.y - 2, { characterSpacing: 1.2 });

  // PJL Land Services address block — three stacked lines, same copy
  // as the quote PDF.
  let y = doc.y + 4;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
  doc.text("PJL Land Services", MARGIN_X, y);
  y = doc.y + 1;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5", MARGIN_X, y);
  y = doc.y;
  doc.text("info@pjllandservices.com  ·  (905) 960-0181  ·  pjllandservices.com", MARGIN_X, y);

  // Right-side logo — same width + position as quote-pdf.js.
  const logo = logoBuffer();
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
  } else {
    doc.font(fontHeading()).fontSize(22).fillColor(PJL_GREEN);
    doc.text("PJL", PAGE_W - MARGIN_X - 200, top + 6, {
      width: 200, align: "right", characterSpacing: 1
    });
    doc.fontSize(11).fillColor(PJL_GREEN);
    doc.text("LAND SERVICES", PAGE_W - MARGIN_X - 200, top + 32, {
      width: 200, align: "right", characterSpacing: 3
    });
  }

  // Stacked meta rows — left margin, light grey. Mirrors how the quote
  // PDF lays out its "Quote Q-... · Issued ..." line, but Patrick asked
  // for these three to stack vertically instead of running in one row.
  doc.y = Math.max(doc.y, 124);
  doc.x = MARGIN_X;
  doc.moveDown(0.6);
  const scheduledIso = wo.scheduledFor || wo.arrivedAt || wo.createdAt;
  const conductedIso = wo.arrivedAt || wo.departedAt || wo.signature?.signedAt || scheduledIso;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text(`Work Order: ${wo.id}`, MARGIN_X, doc.y, { characterSpacing: 0.2 });
  doc.text(`Conducted on: ${fmtDate(conductedIso)}`, MARGIN_X, doc.y, { characterSpacing: 0.2 });
  doc.text(`Tech: Patrick Lalande`, MARGIN_X, doc.y, { characterSpacing: 0.2 });

  doc.moveDown(0.5);
  ruleLine(doc);
  doc.moveDown(0.4);

  // ---- Location block ------------------------------------------------
  sectionHeading(doc, "Location");
  const customerName = (customer.customerName || customer.name || wo.customerName || "").trim();
  const addr = (property.address || wo.address || "").trim();
  keyValueRow(doc, "Customer", customerName || "—");
  keyValueRow(doc, "Service Address", addr || "—");
  if (property?.lat && property?.lng) {
    keyValueRow(doc, "Coordinates",
      `${Number(property.lat).toFixed(5)}, ${Number(property.lng).toFixed(5)}`);
  }
  const contactBits = [];
  if (wo.customerPhone || customer.customerPhone) contactBits.push(wo.customerPhone || customer.customerPhone);
  if (wo.customerEmail || customer.customerEmail) contactBits.push(wo.customerEmail || customer.customerEmail);
  if (contactBits.length) keyValueRow(doc, "Contact", contactBits.join("  ·  "));
  doc.moveDown(0.5);

  // ---- Cheat-sheet block --------------------------------------------
  sectionHeading(doc, "System Overview");
  const sys = property?.system || {};
  const zoneCount = Array.isArray(sys.zones) ? sys.zones.length : (Array.isArray(wo.zones) ? wo.zones.length : 0);
  keyValueRow(doc, "Zones", zoneCount ? String(zoneCount) : "—");
  const controllerBits = [sys.controllerBrand, sys.controllerLocation].filter(Boolean);
  if (controllerBits.length) keyValueRow(doc, "Controller", controllerBits.join(" — "));
  if (sys.shutoffLocation) keyValueRow(doc, "Shut-off", sys.shutoffLocation);
  if (sys.blowoutLocation) keyValueRow(doc, "Blow-out point", sys.blowoutLocation);
  if (property?.accessNotes) keyValueRow(doc, "Access notes", property.accessNotes);
  doc.moveDown(0.5);

  // ---- Zone walkthrough ---------------------------------------------
  const zones = Array.isArray(wo.zones) ? wo.zones : [];
  if (zones.length) {
    sectionHeading(doc, "Zone Walkthrough",
      { subtle: "Each zone was checked for operation, pressure, coverage, leaks, and head function." });

    zones.forEach((z, idx) => {
      const headerLine = `Zone ${z.number || idx + 1}${z.location ? " — " + z.location : ""}`;
      ensureSpace(doc, 60);
      doc.font(fontHeading()).fontSize(11).fillColor(PJL_TEXT);
      doc.text(headerLine, 60, doc.y);
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
      const meta = [];
      if (Array.isArray(z.sprinklerTypes) && z.sprinklerTypes.length) meta.push(`Heads: ${listify(z.sprinklerTypes)}`);
      if (Array.isArray(z.coverage) && z.coverage.length) meta.push(`Coverage: ${listify(z.coverage)}`);
      if (meta.length) {
        doc.text(meta.join("  ·  "), 60, doc.y + 1, { width: doc.page.width - 120 });
      }

      // Checks — render only the ones that passed (for service_report)
      // OR all five with state for inspection_report. Keep both modes
      // simple visually: just the words.
      const checks = z.checks || {};
      const checkLabels = {
        operated: "Operated",
        pressureGood: "Pressure good",
        coverageGood: "Coverage good",
        noLeaks: "No leaks",
        allHeadsFunctional: "All heads functional"
      };
      const passed = Object.keys(checkLabels).filter((k) => checks[k]);
      if (passed.length) {
        doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
        doc.text(`Checks passed: ${passed.map((k) => checkLabels[k]).join(", ")}`,
          60, doc.y + 2, { width: doc.page.width - 120 });
      }

      // Zone-level photos — attached to this zone but NOT to a specific
      // issue. Renders below the meta/checks line, indented to match
      // the zone card's left margin. Lets the tech document overall
      // zone state (coverage shot, post-fix overview) without tying
      // every photo to a single issue.
      const zonePhotos = (wo.photos || []).filter((p) =>
        Number(p.zoneNumber) === Number(z.number)
        && !p.issueId
        && isPdfRenderableImage(p));
      if (zonePhotos.length) {
        doc.moveDown(0.3);
        renderPhotoRow(doc, wo, zonePhotos, { x: 72, thumbW: 140, thumbH: 100 });
      }

      // Issues nested under the zone
      const issues = Array.isArray(z.issues) ? z.issues : [];
      if (issues.length) {
        doc.moveDown(0.2);
        issues.forEach((issue) => {
          ensureSpace(doc, 40);
          doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
          const qtyBit = (Number(issue.qty) > 1) ? `  ×${issue.qty}` : "";
          doc.text(`• ${issueLabel(issue)}${qtyBit}`, 80, doc.y, { width: doc.page.width - 60 - 80 });
          if (issue.notes) {
            doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
            doc.text(issue.notes, 92, doc.y + 1, { width: doc.page.width - 60 - 92 });
          }
          // Disposition is an INTERNAL status stamp ("Identified on-site",
          // "Repaired on this visit", "Customer declined"). It's audit
          // vocabulary, not customer language, so the customer-audience
          // report shows the finding and its notes without it.
          if (audience === "internal") {
            doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
            doc.text(`Disposition: ${dispositionFor(issue, wo, mode)}`,
              92, doc.y + 1, { width: doc.page.width - 60 - 92 });
          }
          // Inline issue photos — ALL of them, not just the first. The
          // photo-row helper wraps into multiple rows if there are more
          // than fit on a single line, and falls back to a "Photo
          // unavailable" placeholder if a file is missing on disk.
          const issuePhotos = (wo.photos || []).filter((p) =>
            p.issueId === issue.id && isPdfRenderableImage(p));
          if (issuePhotos.length) {
            doc.moveDown(0.2);
            renderPhotoRow(doc, wo, issuePhotos, { x: 92, thumbW: 140, thumbH: 100 });
          }
        });
      }
      if (z.notes) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED);
        doc.text(`Notes: ${z.notes}`, 60, doc.y + 2, { width: doc.page.width - 120 });
      }
      doc.moveDown(0.6);
      ruleLine(doc);
      doc.moveDown(0.2);
    });
  }

  // ---- Service-specific checklist (service_report only) -------------
  if (mode === "service_report") {
    const checklistDef = wo.type === "spring_opening"
      ? ["water_on", "controller_programmed", "walkthrough_with_customer"]
      : wo.type === "fall_closing"
        ? ["controller_off", "water_off", "compressor_connected", "zones_blown_clear", "compressor_disconnected", "system_winterized"]
        : [];
    if (checklistDef.length) {
      sectionHeading(doc, "Service Checklist");
      const sc = wo.serviceChecklist || {};
      checklistDef.forEach((key) => {
        ensureSpace(doc, 16);
        const checked = sc[key] === true;
        const mark = checked ? "✓" : "—";
        doc.font(fontHeading()).fontSize(11).fillColor(checked ? PJL_GREEN : PJL_MUTED);
        doc.text(mark, 60, doc.y, { width: 18, continued: false });
        const labelY = doc.y - 13;
        doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
        doc.text(SERVICE_CHECKLIST_LABELS[key] || key, 84, labelY,
          { width: doc.page.width - 60 - 84 });
        doc.moveDown(0.15);
      });
      doc.moveDown(0.4);
    }
  }

  // ---- Customer notes -----------------------------------------------
  const customerNotes = (wo.customerNotes || "").trim();
  if (customerNotes) {
    sectionHeading(doc, "Notes for the Customer");
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(customerNotes, 60, doc.y, { width: doc.page.width - 120, align: "left" });
    doc.moveDown(0.6);
  }

  // ---- Fall closing disclaimer --------------------------------------
  if (mode === "service_report" && wo.type === "fall_closing") {
    ensureSpace(doc, 90);
    doc.font(fontHeading()).fontSize(11).fillColor(PJL_AMBER);
    doc.text("WINTER LIABILITY NOTICE", 60, doc.y, { characterSpacing: 1 });
    doc.moveTo(60, doc.y + 2).lineTo(doc.page.width - 60, doc.y + 2)
      .strokeColor(PJL_AMBER).lineWidth(0.7).stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(FALL_CLOSING_DISCLAIMER, 60, doc.y,
      { width: doc.page.width - 120, align: "left" });
    doc.moveDown(0.6);
  }

  // ---- Signature block (service_report, INTERNAL audience only) -----
  // Signature bypass exposes the audit reason/note ("customer not home",
  // etc.) — that belongs on the internal copy, never on the document the
  // customer receives. On customer audience the section is omitted
  // entirely (a real customer signature would be theirs to see, but a
  // bypass has no signature, so there is nothing customer-appropriate to
  // render). Gate the whole block.
  if (mode === "service_report" && audience === "internal") {
    sectionHeading(doc, "Customer Sign-Off");
    if (wo.signature && wo.signature.signed && wo.signature.imageData) {
      const m = String(wo.signature.imageData).match(/^data:image\/[a-z]+;base64,(.+)$/);
      if (m) {
        try {
          ensureSpace(doc, 95);
          const buf = Buffer.from(m[1], "base64");
          doc.image(buf, 60, doc.y + 2, { fit: [220, 70] });
          doc.y += 72;
        } catch (_) { /* fall through to text */ }
      }
      doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
      doc.text(`Signed by ${wo.signature.customerName || "—"}`,
        60, doc.y + 4, { width: doc.page.width - 120 });
      if (wo.signature.signedAt) {
        doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
        doc.text(`on ${fmtDateTime(wo.signature.signedAt)}`, 60, doc.y + 1,
          { width: doc.page.width - 120 });
      }
    } else if (wo.signatureBypass) {
      doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
      const reasonLabel = String(wo.signatureBypass.reason || "")
        .replace(/_/g, " ");
      doc.text(`Visit authorized via signature bypass — ${reasonLabel}`,
        60, doc.y + 2, { width: doc.page.width - 120 });
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
      if (wo.signatureBypass.note) {
        doc.text(wo.signatureBypass.note, 60, doc.y + 2,
          { width: doc.page.width - 120 });
      }
      if (wo.signatureBypass.ts) {
        doc.text(`Recorded ${fmtDateTime(wo.signatureBypass.ts)}`,
          60, doc.y + 1, { width: doc.page.width - 120 });
      }
    } else {
      doc.font("Helvetica").fontSize(10).fillColor(PJL_MUTED);
      doc.text("Awaiting signature.", 60, doc.y + 2, { width: doc.page.width - 120 });
    }
    doc.moveDown(0.6);
  }

  // ---- Media Summary ------------------------------------------------
  // Photos in a 3-up square grid grouped by source. Square cells fit
  // both portrait (phone) and landscape (DSLR/overview) photos without
  // wasting the bulk of the cell — pdfkit's `align: "center"` +
  // `valign: "center"` letterbox/pillarbox the image inside the cell
  // so portrait photos don't slide to the left with a huge gap. Page
  // breaks happen at row boundaries (not mid-row) so the bottom of
  // each page packs tight. Group order: zones (numeric) → General
  // (WO-level photos with no zoneNumber).
  const renderablePhotos = (wo.photos || []).filter(isPdfRenderableImage);
  if (renderablePhotos.length) {
    sectionHeading(doc, "Media Summary",
      { subtle: "Field documentation captured during the visit." });

    // Group photos by source. Zone groups are ordered by zone number;
    // WO-level photos (no zoneNumber, or zoneNumber=0) go to a final
    // "General" group.
    const groups = [];
    const zoneNums = Array.from(new Set(
      renderablePhotos
        .map((p) => Number(p.zoneNumber))
        .filter((n) => Number.isFinite(n) && n > 0)
    )).sort((a, b) => a - b);
    for (const num of zoneNums) {
      const z = (wo.zones || []).find((zz) => Number(zz.number) === num);
      groups.push({
        label: `Zone ${num}${z?.location ? " — " + z.location : ""}`,
        photos: renderablePhotos.filter((p) => Number(p.zoneNumber) === num)
      });
    }
    const generalPhotos = renderablePhotos.filter((p) => {
      const n = Number(p.zoneNumber);
      return !Number.isFinite(n) || n <= 0;
    });
    if (generalPhotos.length) {
      groups.push({ label: "General", photos: generalPhotos });
    }
    // Fallback if no photos carry a zoneNumber at all — still render
    // everything under one "Field photos" group instead of dropping
    // the section.
    if (!groups.length) {
      groups.push({ label: "Field photos", photos: renderablePhotos });
    }

    // Grid geometry — 3 square cells across the body width.
    const bodyLeft = 60;
    const bodyRight = doc.page.width - 60;
    const bodyW = bodyRight - bodyLeft;
    const cols = 3;
    const colGap = 12;
    const cellW = Math.floor((bodyW - colGap * (cols - 1)) / cols);
    const cellH = cellW; // square
    const captionH = 24;
    const rowH = cellH + captionH + 8;

    let photoCounter = 0;
    for (const g of groups) {
      // Group heading — tight, just enough room.
      ensureSpace(doc, 24);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
      doc.text(g.label, bodyLeft, doc.y, { width: bodyW });
      doc.moveDown(0.2);

      let col = 0;
      let rowY = doc.y;
      for (const p of g.photos) {
        photoCounter += 1;
        // Page-break at row boundary, never mid-row.
        if (col === 0) {
          ensureSpace(doc, rowH + 4);
          rowY = doc.y;
        }
        const x = bodyLeft + col * (cellW + colGap);
        let buf = null;
        try { buf = openPhotoCached(doc, wo.id, p); } catch (_) { buf = null; }
        // Background tile so portrait photos (narrower than the cell)
        // sit on a clean light-grey field instead of floating in white.
        doc.rect(x, rowY, cellW, cellH).fillAndStroke("#F5F5F0", PJL_RULE);
        if (buf) {
          try {
            doc.image(buf, x, rowY, {
              fit: [cellW, cellH],
              align: "center",
              valign: "center"
            });
          } catch (_) {
            doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
            doc.text("Photo unavailable", x, rowY + cellH / 2 - 5,
              { width: cellW, align: "center" });
          }
        } else {
          doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
          doc.text("Photo unavailable", x, rowY + cellH / 2 - 5,
            { width: cellW, align: "center" });
        }
        // Caption — tight against the cell, two-line cap with ellipsis.
        doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED);
        const captionParts = [`Photo ${photoCounter}`];
        if (p.label) captionParts.push(String(p.label).slice(0, 80));
        doc.text(captionParts.join(" — "), x, rowY + cellH + 3, {
          width: cellW,
          height: captionH - 4,
          ellipsis: true
        });

        col += 1;
        if (col >= cols) {
          col = 0;
          doc.y = rowY + rowH;
        }
      }
      // Advance cursor past the last partial row in this group.
      if (col !== 0) {
        doc.y = rowY + rowH;
      }
      doc.moveDown(0.3);
    }
  }

  // ---- Post-Completion Corrections (service_report, INTERNAL only) ---
  // Admin audit of edits made to this WO after it was signed/bypassed and
  // locked. Derived from wo.history[] "patch" entries whose note records
  // changed field names ("Updated: zones, customerNotes"), kept only when
  // they post-date the completion lock (signature.signedAt or bypass ts).
  // Lock-only toggles are excluded — they are the mechanics of making an
  // edit, not the edit itself. Field names only, no before/after values.
  if (mode === "service_report" && audience === "internal") {
    const lockedAt = (wo.signature && wo.signature.signedAt)
      || (wo.signatureBypass && wo.signatureBypass.ts) || null;
    const corrections = (Array.isArray(wo.history) ? wo.history : [])
      .filter((h) => h && h.action === "patch" && lockedAt && String(h.ts) > String(lockedAt))
      .map((h) => ({
        ts: h.ts,
        by: h.by || "admin",
        fields: String(h.note || "").replace(/^Updated:\s*/i, "")
          .split(/,\s*/).map((s) => s.trim()).filter((f) => f && f !== "locked")
      }))
      .filter((e) => e.fields.length);
    if (corrections.length) {
      ensureSpace(doc, 50);
      sectionHeading(doc, "Post-Completion Corrections");
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
      doc.text("Edits made to this report after completion (internal record).",
        60, doc.y + 2, { width: doc.page.width - 120 });
      doc.moveDown(0.3);
      corrections.forEach((e) => {
        doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
        doc.text(`${fmtDateTime(e.ts)} · ${e.by} · ${e.fields.join(", ")}`,
          60, doc.y + 2, { width: doc.page.width - 120 });
      });
      doc.moveDown(0.6);
    }
  }

  // Footer band on the very first page (pageAdded fires only on new
  // pages — call once manually for page 1).
  drawFooter(doc, wo.id, mode);

  doc.end();
  return doc;
}

// Buffered helper — collects the stream into a Buffer and resolves. Used
// by the snapshotter and email-attachment paths (live-render streams
// directly into the HTTP response instead).
async function renderWoReportBuffer(opts) {
  // Ensure downscaled derivatives exist before rendering, so a buffered
  // render can't balloon to hundreds of MB on a photo-heavy WO.
  try { await ensurePhotoDerivatives(opts?.wo?.id, opts?.wo?.photos || []); }
  catch (_) { /* non-fatal — renderer falls back to originals */ }
  const stream = generateWoReportPdf(opts);
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Render straight to a file. Preferred over renderWoReportBuffer for
// snapshots: piping to a write stream keeps only pdfkit's internal
// buffers in memory, where Buffer.concat held the ENTIRE document twice
// (chunk array + concatenated result) at peak. Returns { path, bytes }.
async function renderWoReportToFile(opts, destPath) {
  if (!destPath) throw new Error("renderWoReportToFile needs a destination path");
  try { await ensurePhotoDerivatives(opts?.wo?.id, opts?.wo?.photos || []); }
  catch (_) { /* non-fatal */ }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const { pipeline } = require("node:stream/promises");
  await pipeline(generateWoReportPdf(opts), fsSync.createWriteStream(destPath));
  const { size } = await fs.stat(destPath);
  return { path: destPath, bytes: size };
}

// Filename builder — used by the snapshotter, the live-render route,
// and email-attachment paths. Date component is YYYY-MM-DD pulled from
// the WO's most-canonical visit date (arrival > scheduled > created).
function reportFilename({ wo, mode }) {
  const tag = mode === "service_report" ? "Service-Report" : "Inspection-Report";
  const visitIso = wo?.arrivedAt || wo?.scheduledFor || wo?.createdAt || new Date().toISOString();
  const ymd = visitIso.slice(0, 10);
  return `PJL-${tag}-${wo?.id || "WO"}-${ymd}.pdf`;
}

module.exports = {
  generateWoReportPdf,
  renderWoReportBuffer,
  renderWoReportToFile,
  ensurePhotoDerivatives,
  reportFilename
};

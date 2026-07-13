// Quote PDF generator. Dispatcher by quote.type:
//
//   ai_repair_quote / on_site_quote / formal_quote / legacy →
//     generateQuotePdf (the one-page branded layout below)
//
//   project_proposal →
//     renderProjectProposalPdf (multi-section narrative with embedded
//     attachments + dual-acceptance block). Brief 1 (May 2026).
//
// Both renderers share the brand palette + Barlow Condensed heading
// font + logo helpers. The dispatcher pattern keeps the existing
// renderer untouched so AI-repair / on-site flows are not at risk.

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

const PJL_GREEN = "#1B4D2E";
const PJL_AMBER = "#E07B24";
const PJL_TEXT = "#1F2A22";
const PJL_MUTED = "#6A6A60";
const HST_RATE = 0.13;

// Brand assets — Barlow Condensed font + dark logo PNG, both shared
// with invoice-pdf.js. Loaded lazily once per process to avoid
// re-reading the files on every PDF render.
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
function fontHeading(doc) { return barlowBuffer() ? "Barlow-Bold" : "Helvetica-Bold"; }

// Logo height at a given render width, from the PNG's IHDR dimensions
// (read once per process). Falls back to the known ~0.574 aspect if the
// buffer is missing/odd so layout math never explodes.
let _logoAspect = null;
function logoHeightAt(width) {
  if (_logoAspect === null) {
    _logoAspect = 0.574;
    const buf = logoBuffer();
    if (buf && buf.length > 24) {
      try {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        if (w > 0 && h > 0) _logoAspect = h / w;
      } catch (_) { /* keep fallback */ }
    }
  }
  return Math.round(width * _logoAspect);
}

// ---- Shared document header (Patrick's layout, 2026-06-12) ------------
//
// One header implementation for every quote-family PDF (one-page,
// project proposal, smart-controller rich layout). Born from a repeat
// spacing bug: per-renderer headers kept printing a full-width company
// contact strip that ran underneath the logo. Structural rules here:
//
//   - The LEFT column (title, eyebrow, issued line, stacked company
//     block) is HARD-CAPPED at the logo column's left edge — it cannot
//     reach the logo no matter how copy grows.
//   - The document id renders UNDER the logo, right-aligned (per
//     Patrick's reference mock), not mixed into the left column.
//   - Company contact info is STACKED on separate short lines, never a
//     single " · "-joined strip.
//
// Returns the y where body content should resume.
function renderPdfHeader(doc, { title, eyebrow = "", idText = "", issuedLine = "" } = {}) {
  const PAGE_W = doc.page.width;
  const MARGIN_X = 60;
  const LOGO_W = 160;
  const GAP = 16;
  const leftWidth = PAGE_W - MARGIN_X * 2 - LOGO_W - GAP; // hard cap — never under the logo
  const top = 40;

  // Title — big green Barlow, left.
  doc.font(fontHeading(doc)).fontSize(30).fillColor(PJL_GREEN);
  doc.text(title, MARGIN_X, top, { characterSpacing: 1.5, width: leftWidth, lineGap: 0 });

  // Right column — logo with the document id right-aligned beneath it.
  const logo = logoBuffer();
  let idY;
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
    idY = top - 12 + logoHeightAt(LOGO_W) + 8;
  } else {
    doc.font(fontHeading(doc)).fontSize(22).fillColor(PJL_GREEN);
    doc.text("PJL", PAGE_W - MARGIN_X - 200, top + 6, { width: 200, align: "right", characterSpacing: 1 });
    doc.fontSize(11);
    doc.text("LAND SERVICES", PAGE_W - MARGIN_X - 200, top + 32, { width: 200, align: "right", characterSpacing: 3 });
    idY = top + 52;
  }
  let rightBottom = idY;
  if (idText) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
    doc.text(idText, PAGE_W - MARGIN_X - 200, idY, { width: 200, align: "right" });
    rightBottom = doc.y;
  }

  // Left column under the title: eyebrow → issued line → stacked
  // company block (name bold, then address / phone / email lines).
  let y = top + 38;
  if (eyebrow) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
    doc.text(eyebrow, MARGIN_X, y, { width: leftWidth, characterSpacing: 0.5 });
    y = doc.y + 2;
  }
  if (issuedLine) {
    doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
    doc.text(issuedLine, MARGIN_X, y, { width: leftWidth });
    y = doc.y + 4;
  }
  doc.font("Helvetica-Bold").fontSize(9).fillColor(PJL_TEXT);
  doc.text("PJL Land Services", MARGIN_X, y, { width: leftWidth });
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5", MARGIN_X, doc.y + 1, { width: leftWidth });
  doc.text("(905) 960-0181", MARGIN_X, doc.y + 1, { width: leftWidth });
  doc.text("info@pjllandservices.com", MARGIN_X, doc.y + 1, { width: leftWidth });

  return Math.max(doc.y, rightBottom) + 14;
}

function fmt(n) {
  const v = Number(n) || 0;
  return "$" + v.toFixed(2);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}

function generateQuotePdf(quote, opts = {}) {
  const customer = opts.customer || {};
  const property = opts.property || {};

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: `PJL Quote ${quote.id}`,
      Author: "PJL Land Services",
      Subject: quote.scope || "Repair quote",
      Keywords: `quote ${quote.id} pjl land services`
    }
  });

  // Register Barlow Condensed if the TTF is committed. Falls back to
  // Helvetica-Bold transparently if it's missing.
  const barlow = barlowBuffer();
  if (barlow) doc.registerFont("Barlow-Bold", barlow);

  // ---- Header (shared layout — see renderPdfHeader) -------------------
  doc.y = renderPdfHeader(doc, {
    title: "QUOTE",
    idText: quote.id,
    issuedLine: `Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? ` · Valid through ${fmtDate(quote.validUntil)}` : ""}`
  });
  doc.x = 60;

  // ---- Bill-to block -------------------------------------------------
  doc.fillColor(PJL_MUTED).fontSize(9)
    .font("Helvetica-Bold")
    .text("BILL TO", 60, doc.y, { characterSpacing: 1 });
  doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(12);
  const billToName = customer.customerName || customer.name || quote.customerEmail || "Customer";
  doc.text(billToName, 60, doc.y + 4);
  if (property.address || customer.address) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(property.address || customer.address);
  }
  const contactBits = [customer.customerPhone || customer.phone, quote.customerEmail].filter(Boolean);
  if (contactBits.length) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(contactBits.join(" · "));
  }

  doc.moveDown(1.5);

  // ---- Scope description --------------------------------------------
  if (quote.scope) {
    doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
      .text("SCOPE", 60, doc.y, { characterSpacing: 1 });
    doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(11)
      .text(quote.scope, 60, doc.y + 4, { width: doc.page.width - 120, align: "left" });
    doc.moveDown(1.2);
  }

  // ---- Line items table ---------------------------------------------
  const colDesc = 60;
  const colQty = 320;
  const colUnit = 380;
  const colTotal = 470;
  const QTY_W = 50, UNIT_W = 80, TOTAL_W = 80;
  // Description column spans colDesc→colQty less a 10pt gutter (reproduces
  // the prior hard-coded 250pt width exactly).
  const DESC_COL_W = colQty - colDesc - 10;
  const ROW_PAD = 8;

  // Single body-line height (Helvetica 10) — the floor for every row so
  // single-line rows keep their exact prior spacing.
  doc.font("Helvetica").fontSize(10);
  const MIN_ROW_H = doc.heightOfString("Ag", { width: DESC_COL_W });

  // The footer band is drawn once at end-of-document ~50pt above the page
  // bottom; reserve room so rows/totals never collide with it.
  const FOOTER_RESERVE = 60;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;

  // Column header — extracted so it repeats on every continuation page.
  // Returns the y of the first row beneath it.
  function drawTableHeader(topY) {
    doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold");
    doc.text("DESCRIPTION", colDesc, topY, { characterSpacing: 1, lineBreak: false });
    doc.text("QTY", colQty, topY, { width: QTY_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.text("UNIT", colUnit, topY, { width: UNIT_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.text("LINE TOTAL", colTotal, topY, { width: TOTAL_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.moveTo(60, topY + 14).lineTo(doc.page.width - 60, topY + 14).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
    return topY + 22;
  }

  // Strip the admin-only "[inherited from WO-XXX]" breadcrumb from
  // line.note for customer-facing PDF output. New writes (post
  // 2026-06-02) store the breadcrumb on source.inheritedFromWoId
  // instead — line.note is clean. This handles legacy polluted records.
  const customerNoteForPdf = (raw) => String(raw || "").replace(/^\[(?:inherited from|from)\s+WO-[A-Z0-9-]+\]\s*/i, "").trim();

  let rowY = drawTableHeader(doc.y + 6);
  for (const line of quote.lineItems || []) {
    const label = line.label || line.key || "Line";
    const qty = Number(line.qty) || 1;
    const unitPrice = Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice)
      : (Number.isFinite(Number(line.price)) ? Number(line.price)
        : Number(line.originalPrice) || 0);
    const lineTotal = Number.isFinite(Number(line.lineTotal)) ? Number(line.lineTotal) : (unitPrice * qty);
    const cleanNote = customerNoteForPdf(line.note);

    // Measure the row (label + optional note) at the description column
    // width, each piece in its own font size, and advance by the measured
    // height. Fixes the fixed-height collision where the number cells
    // reset doc.y to the row top and the next row drew over a wrapped
    // description.
    doc.font("Helvetica").fontSize(10);
    const labelH = doc.heightOfString(label, { width: DESC_COL_W });
    let noteH = 0;
    if (cleanNote) {
      doc.font("Helvetica").fontSize(9);
      noteH = 1 + doc.heightOfString(cleanNote, { width: DESC_COL_W });
    }
    const rowH = Math.max(labelH + noteH, MIN_ROW_H);

    // Break BEFORE drawing when the row won't fit; repeat the column
    // header on the new page.
    if (rowY + rowH > pageBottom()) {
      doc.addPage();
      rowY = drawTableHeader(doc.page.margins.top);
    }

    // All four cells share the same row top `rowY`; the numbers top-align
    // with the FIRST line of the description.
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(label, colDesc, rowY, { width: DESC_COL_W });
    if (cleanNote) {
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED)
        .text(cleanNote, colDesc, rowY + labelH + 1, { width: DESC_COL_W });
    }
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(String(qty), colQty, rowY, { width: QTY_W, align: "right", lineBreak: false });
    doc.text(fmt(unitPrice), colUnit, rowY, { width: UNIT_W, align: "right", lineBreak: false });
    doc.text(fmt(lineTotal), colTotal, rowY, { width: TOTAL_W, align: "right", lineBreak: false });

    rowY += rowH + ROW_PAD;
  }

  // Keep the whole totals block together — never strand a lone "Total
  // CAD" on a page by itself.
  const TOTALS_BLOCK_H = 120;
  if (rowY + TOTALS_BLOCK_H > pageBottom()) {
    doc.addPage();
    rowY = doc.page.margins.top;
  }

  // ---- Totals --------------------------------------------------------
  doc.moveTo(colUnit, rowY).lineTo(doc.page.width - 60, rowY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  rowY += 8;
  const subtotal = Number(quote.subtotal) || 0;
  const hst = Number(quote.hst) || Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Number(quote.total) || Math.round((subtotal + hst) * 100) / 100;

  doc.fillColor(PJL_MUTED).fontSize(10).font("Helvetica");
  doc.text("Subtotal", colUnit, rowY, { width: 80, align: "right" });
  doc.fillColor(PJL_TEXT).text(fmt(subtotal), colTotal, rowY, { width: 80, align: "right" });
  rowY += 16;
  doc.fillColor(PJL_MUTED).text("HST (13%)", colUnit, rowY, { width: 80, align: "right" });
  doc.fillColor(PJL_TEXT).text(fmt(hst), colTotal, rowY, { width: 80, align: "right" });
  rowY += 18;
  doc.moveTo(colUnit, rowY).lineTo(doc.page.width - 60, rowY).strokeColor(PJL_GREEN).lineWidth(1).stroke();
  rowY += 6;
  doc.fillColor(PJL_GREEN).font("Helvetica-Bold").fontSize(13);
  doc.text("Total CAD", colUnit, rowY, { width: 80, align: "right" });
  doc.text(fmt(total), colTotal, rowY, { width: 80, align: "right" });

  rowY += 36;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("Pricing snapshotted at quote creation. Future pricing changes do not alter accepted quotes.", 60, rowY, { width: doc.page.width - 120 });
  rowY = doc.y + 24;

  // ---- Terms block --------------------------------------------------
  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
    .text("TERMS", 60, rowY, { characterSpacing: 1 });
  rowY = doc.y + 4;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
  const terms = [
    "• Warranty: 1 year on repairs, 3 years on full installs.",
    "• Payment due on completion unless otherwise arranged.",
    "• Scope changes discovered on-site require fresh customer sign-off before additional work begins.",
    "• Cancellations within 24 hours of the scheduled visit may incur a service-call fee."
  ];
  for (const t of terms) {
    doc.text(t, 60, rowY, { width: doc.page.width - 120 });
    rowY = doc.y + 2;
  }

  // ---- Signature block ----------------------------------------------
  rowY += 24;
  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
    .text("CUSTOMER SIGNATURE", 60, rowY, { characterSpacing: 1 });
  rowY += 14;

  // If the quote was already signed, embed the signature image; else
  // draw a blank line for ink-signing the printed copy.
  if (quote.signature && quote.signature.signed && quote.signature.imageData) {
    try {
      // imageData is a data URL like "data:image/png;base64,iVBOR..."
      const m = String(quote.signature.imageData).match(/^data:image\/[a-z]+;base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[1], "base64");
        doc.image(buf, 60, rowY, { fit: [220, 60] });
      }
    } catch (_) { /* ignore — fall through to blank line */ }
    rowY += 70;
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(`Signed by ${quote.signature.customerName || "—"}`, 60, rowY);
    if (quote.signature.signedAt) {
      doc.fontSize(9).fillColor(PJL_MUTED)
        .text(`on ${new Date(quote.signature.signedAt).toLocaleString("en-CA")}` +
              (quote.signature.ip ? ` · IP ${quote.signature.ip}` : ""), 60, doc.y);
    }
  } else {
    doc.moveTo(60, rowY + 30).lineTo(280, rowY + 30).strokeColor(PJL_TEXT).lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor(PJL_MUTED).text("Customer signature", 60, rowY + 35);
    doc.moveTo(320, rowY + 30).lineTo(440, rowY + 30).strokeColor(PJL_TEXT).lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor(PJL_MUTED).text("Date", 320, rowY + 35);
  }

  // ---- Footer --------------------------------------------------------
  // Drop bottom margin to 0 around the footer write — pdfkit's
  // LineWrapper auto-pagebreaks when text() is called within the
  // bottom margin, even with lineBreak:false. Same fix as in
  // invoice-pdf.js. Without this we get a spurious page 2 with just
  // the footer at the top.
  const restoreBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 50;
  doc.moveTo(60, footerY).lineTo(doc.page.width - 60, footerY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com",
    60, footerY + 8, { width: doc.page.width - 120, align: "center", lineBreak: false });
  doc.page.margins.bottom = restoreBottom;

  doc.end();
  return doc;
}

// ---- Project Proposal PDF (Brief 1) ----------------------------------
//
// Multi-section narrative for project_proposal quotes. Layout follows
// the McDonald's Hampshire Gate estimate as the visual reference:
//
//   Page 1 — cover. Big "PROPOSAL" header, quote id, branch tag,
//            customer + property block.
//   Body   — proposalSections rendered in order. Each section gets a
//            green section header (Barlow Condensed) + body prose.
//            Attachments anchored to a section are rendered inline at
//            section end (images fit-to-width, PDFs not embedded — a
//            "See attached: <caption>" footnote instead).
//   Totals — subtotal / HST / total just before the acceptance block.
//   Accept — dual-path block: portal e-sign URL/QR (PJL just renders
//            the URL — no QR lib dependency) AND printed signature
//            lines for ink-sign + email-back. Both methods presented.
//   Footer — small print, contact info.

const BRANCH_LABELS = {
  gc_subcontract: "GC Subcontract",
  direct_residential: "Residential",
  lighting_design: "Lighting Design",
  renovation_coordination: "Renovation Coordination",
  change_order: "Change Order"
};

function renderProjectProposalPdf(quote, opts = {}) {
  const customer = opts.customer || {};
  const property = opts.property || {};
  const acceptanceUrl = opts.acceptanceUrl || null;
  const returnEmail = opts.returnEmail || "info@pjllandservices.com";

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: `PJL Proposal ${quote.id}`,
      Author: "PJL Land Services",
      Subject: quote.scope || "Project proposal",
      Keywords: `proposal ${quote.id} pjl land services ${quote.branch || ""}`
    }
  });

  const barlow = barlowBuffer();
  if (barlow) doc.registerFont("Barlow-Bold", barlow);

  const PAGE_W = doc.page.width;
  const MARGIN_X = 60;
  const contentWidth = PAGE_W - MARGIN_X * 2;

  // ---- Cover page header (shared layout — see renderPdfHeader) -------
  const branchLabel = quote.branch ? BRANCH_LABELS[quote.branch] || quote.branch : "";
  const versionTag = (Number(quote.version) || 1) > 1 ? ` · v${quote.version}` : "";
  let y = renderPdfHeader(doc, {
    title: "PROPOSAL",
    eyebrow: branchLabel ? branchLabel.toUpperCase() : "",
    idText: `${quote.id}${versionTag}`,
    issuedLine: `Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? `  ·  Valid through ${fmtDate(quote.validUntil)}` : ""}`
  });
  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
    .text("PREPARED FOR", MARGIN_X, y, { characterSpacing: 1 });
  doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(12);
  const billToName = customer.name || customer.customerName || quote.customerEmail || "Customer";
  doc.text(billToName, MARGIN_X, doc.y + 4);
  if (property.address || customer.address) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(property.address || customer.address);
  }
  const contactBits = [customer.phone || customer.customerPhone, quote.customerEmail].filter(Boolean);
  if (contactBits.length) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(contactBits.join(" · "));
  }
  doc.moveDown(1);

  // ---- Sections -----------------------------------------------------
  const orderedSections = Array.isArray(quote.proposalSections)
    ? [...quote.proposalSections].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    : [];
  // line_items + acceptance_block are auto-rendered after the narrative
  // sections — skip them here to avoid duplication.
  const narrativeSections = orderedSections.filter(
    (s) => s.kind !== "line_items" && s.kind !== "acceptance_block"
  );

  for (const sec of narrativeSections) {
    renderSection(doc, sec, quote, { MARGIN_X, contentWidth });
  }

  // ---- Line items + totals -----------------------------------------
  doc.moveDown(1);
  renderProposalLineItems(doc, quote, { MARGIN_X, contentWidth });

  // ---- Acceptance block --------------------------------------------
  doc.moveDown(1.2);
  renderAcceptanceBlock(doc, quote, {
    MARGIN_X, contentWidth, acceptanceUrl, returnEmail
  });

  // ---- Footer on every page ----------------------------------------
  // pdfkit lets us register an event for new pages — we add a small
  // footer after each addPage, but for the simple proposal flow the
  // body itself flows multi-page automatically so a single end-of-doc
  // contact line is enough.
  const restoreBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 50;
  doc.moveTo(MARGIN_X, footerY).lineTo(PAGE_W - MARGIN_X, footerY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text(
    "PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com",
    MARGIN_X, footerY + 8,
    { width: PAGE_W - MARGIN_X * 2, align: "center", lineBreak: false }
  );
  doc.page.margins.bottom = restoreBottom;

  doc.end();
  return doc;
}

// ---- Section body markup (Brief C2) ----------------------------------
//
// Section bodies are plain strings carrying a CLOSED markup convention.
// No schema, no dependency: a toolbar writes the markers, these functions
// parse them at render time. Existing unmarked bodies fall through a
// byte-identical fast path (see renderSection). Vocabulary:
//   **bold**  __underline__  *italic*
//   "- " bullet, "  - " sub-bullet (2-space indent)
//   "1. " numbered, "  1. " sub-item; blank line = paragraph break
//   \* \_ \- \\ = literal. Max nesting depth 1.

const BODY_FONT_SIZE = 10;
const BODY_LINE_GAP = 2;
const LIST_INDENT_L0 = 16;   // x offset of the glyph from the left margin
const LIST_INDENT_L1 = 34;
const LIST_TEXT_GAP = 14;    // glyph column width; text starts after it
const SECTION_FOOTER_RESERVE = 60;

// Strip the light HTML the pre-C2 renderer tolerated (admin-pasted rich
// text), so a stray tag never reaches the markup parser.
function stripSectionHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Split one LINE of text into styled runs. Pure. Never throws. Unmatched
// markers degrade to literal characters (a stray asterisk must never
// swallow content). Inline parsing is line-scoped — markers never pair
// across a newline.
function parseInlineRuns(text) {
  const s = String(text == null ? "" : text);
  // 1. Tokenize, honouring backslash escapes for * _ - \
  const tokens = [];
  for (let i = 0; i < s.length; ) {
    const c = s[i], n = s[i + 1];
    if (c === "\\" && (n === "*" || n === "_" || n === "-" || n === "\\")) { tokens.push({ lit: n }); i += 2; continue; }
    if (c === "*" && n === "*") { tokens.push({ marker: "**" }); i += 2; continue; }
    if (c === "_" && n === "_") { tokens.push({ marker: "__" }); i += 2; continue; }
    if (c === "*") { tokens.push({ marker: "*" }); i += 1; continue; }
    tokens.push({ lit: c }); i += 1;
  }
  // 2. Pair markers with a stack; unmatched markers stay literal.
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.marker) continue;
    const topIdx = stack.length ? stack[stack.length - 1] : -1;
    if (topIdx >= 0 && tokens[topIdx].marker === t.marker) { tokens[topIdx].paired = true; t.paired = true; stack.pop(); }
    else stack.push(i);
  }
  // 3. Emit runs, toggling state only on paired markers.
  const runs = [];
  let bold = false, italic = false, underline = false, cur = "";
  const flush = () => { if (cur) { runs.push({ text: cur, bold, italic, underline }); cur = ""; } };
  for (const t of tokens) {
    if (t.lit != null) { cur += t.lit; continue; }
    if (!t.paired) { cur += t.marker; continue; }   // unmatched → literal
    flush();
    if (t.marker === "**") bold = !bold;
    else if (t.marker === "__") underline = !underline;
    else if (t.marker === "*") italic = !italic;
  }
  flush();
  if (!runs.length) runs.push({ text: "", bold: false, italic: false, underline: false });
  return runs;
}

// Parse a whole body into blocks. Consecutive non-list lines group into a
// paragraph block (each line keeps its own runs — line-scoped). Numbered
// runs renumber from 1 and restart after any interruption.
//   Block = { type:"paragraph", lines:[{runs}] }
//         | { type:"bullet"|"numbered", level:0|1, index?, runs }
function parseSectionBody(body) {
  const lines = String(body == null ? "" : body).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paraLines = [];
  let l0 = 0, l1 = 0;
  const flushPara = () => {
    while (paraLines.length && paraLines[0].trim() === "") paraLines.shift();
    while (paraLines.length && paraLines[paraLines.length - 1].trim() === "") paraLines.pop();
    if (paraLines.length) blocks.push({ type: "paragraph", lines: paraLines.map((ln) => ({ runs: parseInlineRuns(ln) })) });
    paraLines = [];
  };
  for (const raw of lines) {
    if (raw.trim() === "") { flushPara(); l0 = 0; l1 = 0; continue; }
    const im = raw.match(/^([ \t]*)(.*)$/);
    const level = im[1].replace(/\t/g, "  ").length >= 2 ? 1 : 0;
    const rest = im[2];
    const bulletM = rest.match(/^-\s+(.*)$/);
    const numM = rest.match(/^\d+\.\s+(.*)$/);
    if (bulletM) { flushPara(); l0 = 0; l1 = 0; blocks.push({ type: "bullet", level, runs: parseInlineRuns(bulletM[1]) }); }
    else if (numM) {
      flushPara();
      if (level === 0) { l0 += 1; l1 = 0; blocks.push({ type: "numbered", level: 0, index: l0, runs: parseInlineRuns(numM[1]) }); }
      else { l1 += 1; blocks.push({ type: "numbered", level: 1, index: l1, runs: parseInlineRuns(numM[1]) }); }
    } else { paraLines.push(rest); }
  }
  flushPara();
  return blocks;
}

// True if any block carries real formatting (a list item, or a bold /
// italic / underlined run). Plain bodies return false and take the
// byte-identical fast path.
function bodyHasFormatting(blocks) {
  for (const b of blocks) {
    if (b.type === "bullet" || b.type === "numbered") return true;
    if (b.type === "paragraph") for (const ln of b.lines) for (const r of ln.runs) if (r.bold || r.italic || r.underline) return true;
  }
  return false;
}

function fontForRun(r) {
  if (r.bold && r.italic) return "Helvetica-BoldOblique";
  if (r.bold) return "Helvetica-Bold";
  if (r.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

// 1 -> "a", 26 -> "z", 27 -> "aa" — sub-list ordinals.
function letterOrdinal(n) {
  let x = Math.max(1, Number(n) || 1), s = "";
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(97 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

// Draw a run sequence on one wrapped line starting at (x, doc.y). Font +
// underline switch per run via pdfkit's `continued` chaining; wrapped
// lines hang-indent back to `x`.
function drawRuns(doc, runs, x, width) {
  doc.fontSize(BODY_FONT_SIZE).fillColor(PJL_TEXT);
  const nonEmpty = runs.filter((r) => r.text !== "");
  if (!nonEmpty.length) { doc.font("Helvetica").text(" ", x, doc.y, { width }); return; }
  nonEmpty.forEach((r, i) => {
    doc.font(fontForRun(r));
    const last = i === nonEmpty.length - 1;
    if (i === 0) doc.text(r.text, x, doc.y, { width, continued: !last, underline: !!r.underline, lineGap: BODY_LINE_GAP });
    else doc.text(r.text, { continued: !last, underline: !!r.underline, lineGap: BODY_LINE_GAP });
  });
}

function measureRunsHeight(doc, runs, width) {
  const text = runs.map((r) => r.text).join("") || " ";
  doc.font("Helvetica").fontSize(BODY_FONT_SIZE);
  return doc.heightOfString(text, { width, lineGap: BODY_LINE_GAP });
}

// Draw parsed blocks. List items are measured and kept together across a
// page boundary (never split); paragraphs flow line by line.
function renderBodyBlocks(doc, blocks, { MARGIN_X, contentWidth }) {
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - SECTION_FOOTER_RESERVE;
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const ln of block.lines) drawRuns(doc, ln.runs, MARGIN_X, contentWidth);
      doc.moveDown(0.35);
      continue;
    }
    // bullet / numbered
    const indent = block.level === 1 ? LIST_INDENT_L1 : LIST_INDENT_L0;
    const textX = MARGIN_X + indent + LIST_TEXT_GAP;
    const textW = contentWidth - indent - LIST_TEXT_GAP;
    const h = measureRunsHeight(doc, block.runs, textW);
    const pageInner = pageBottom() - doc.page.margins.top;
    // Keep the whole item together — break before it unless it's taller
    // than a full page (then let it flow rather than loop forever).
    if (doc.y + h > pageBottom() && h <= pageInner) doc.addPage();
    const y0 = doc.y;
    const glyphX = MARGIN_X + indent;
    if (block.type === "bullet" && block.level === 1) {
      // Hollow sub-bullet, vector-drawn: Helvetica's WinAnsi encoding has
      // no U+25E6 (◦) glyph, so a literal one renders as garbage.
      doc.save().circle(glyphX + 3, y0 + BODY_FONT_SIZE * 0.36, 1.8)
        .lineWidth(0.7).strokeColor(PJL_TEXT).stroke().restore();
    } else {
      const glyph = block.type === "bullet"
        ? "•"
        : (block.level === 1 ? letterOrdinal(block.index) + "." : block.index + ".");
      doc.font("Helvetica").fontSize(BODY_FONT_SIZE).fillColor(PJL_TEXT)
        .text(glyph, glyphX, y0, { width: LIST_TEXT_GAP, lineBreak: false });
    }
    doc.y = y0;
    drawRuns(doc, block.runs, textX, textW);
    doc.moveDown(0.15);
  }
}

// Render one narrative section: green section header (Barlow), body
// prose underneath (Helvetica), then any anchored attachments. Page
// break if there isn't room — pdfkit handles continuation automatically
// when text() crosses the bottom margin.
function renderSection(doc, sec, quote, { MARGIN_X, contentWidth }) {
  // Compute section header. If the section is empty (no body, no
  // attachments), skip it — empty placeholder sections in the builder
  // shouldn't print as blank pages in the PDF.
  const hasBody = sec.body && String(sec.body).trim();
  const hasAttachments = Array.isArray(sec.attachmentIds) && sec.attachmentIds.length;
  if (!hasBody && !hasAttachments) return;

  // Avoid orphaned headers — if there's <80pt left on the page, break.
  if (doc.y > doc.page.height - 140) doc.addPage();

  doc.moveDown(0.6);
  doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(15);
  doc.text(String(sec.title || sec.kind || "Section").toUpperCase(), MARGIN_X, doc.y, {
    characterSpacing: 1.2,
    width: contentWidth
  });
  // Underline rule.
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + 60, ruleY).strokeColor(PJL_GREEN).lineWidth(1.5).stroke();
  doc.moveDown(0.4);

  if (hasBody) {
    doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(BODY_FONT_SIZE);
    // Strip the light HTML the old renderer tolerated, then parse the
    // closed markup (Brief C2). A body with no working markup (no lists,
    // no bold/italic/underline) takes the byte-identical fast path so
    // existing plain-text proposals render exactly as before.
    const clean = stripSectionHtml(sec.body);
    const blocks = parseSectionBody(clean);
    if (!bodyHasFormatting(blocks)) {
      const paragraphs = clean.split(/\n\n+/);
      for (const p of paragraphs) {
        doc.text(p.trim(), MARGIN_X, doc.y, { width: contentWidth, lineGap: 2 });
        doc.moveDown(0.4);
      }
    } else {
      renderBodyBlocks(doc, blocks, { MARGIN_X, contentWidth });
    }
  }

  // Render anchored attachments inline at section end. Images get
  // embedded fit-to-width; PDFs surface a "See attached: <caption>"
  // line because pdfkit can't easily merge multi-page PDF inputs.
  if (hasAttachments) {
    for (const attId of sec.attachmentIds) {
      const att = (quote.attachments || []).find((a) => a.id === attId);
      if (!att) continue;
      renderAttachmentInline(doc, att, quote, { MARGIN_X, contentWidth });
    }
  }
}

function renderAttachmentInline(doc, att, quote, { MARGIN_X, contentWidth }) {
  doc.moveDown(0.4);
  if (att.mimeType === "image/png" || att.mimeType === "image/jpeg") {
    try {
      const ext = att.mimeType === "image/png" ? "png" : "jpg";
      const imgPath = path.resolve(
        __dirname, "..", "data", "quote-attachments", quote.id, `${att.id}.${ext}`
      );
      if (fsSync.existsSync(imgPath)) {
        const buf = fsSync.readFileSync(imgPath);
        // Roughly half-page max so multiple attachments don't push the
        // proposal to absurd page counts. pdfkit's fit honours aspect.
        const maxH = 320;
        if (doc.y + maxH > doc.page.height - 80) doc.addPage();
        doc.image(buf, MARGIN_X, doc.y, { fit: [contentWidth, maxH], align: "center" });
        doc.y = doc.y + Math.min(maxH, contentWidth * 0.75) + 4;
        if (att.caption) {
          doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED)
            .text(att.caption, MARGIN_X, doc.y, { width: contentWidth, align: "center" });
          doc.moveDown(0.4);
        }
        return;
      }
    } catch (err) {
      // fall through to caption-only display
    }
  }
  // PDF attachments or fallback for failed image reads.
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED);
  doc.text(`See attached: ${att.caption || att.filename || att.id}`, MARGIN_X, doc.y, {
    width: contentWidth
  });
  doc.moveDown(0.3);
}

function renderProposalLineItems(doc, quote, { MARGIN_X, contentWidth, heading = "ITEMIZED PRICING" }) {
  if (!Array.isArray(quote.lineItems) || !quote.lineItems.length) return;

  if (doc.y > doc.page.height - 200) doc.addPage();

  doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(15);
  doc.text(heading, MARGIN_X, doc.y, { characterSpacing: 1.2 });
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + 60, ruleY).strokeColor(PJL_GREEN).lineWidth(1.5).stroke();
  doc.moveDown(0.4);

  const colDesc = MARGIN_X;
  const colQty = MARGIN_X + 280;
  const colUnit = MARGIN_X + 340;
  const colTotal = MARGIN_X + 420;
  const QTY_W = 50, UNIT_W = 70, TOTAL_W = 80;
  // Description column spans colDesc→colQty less a 20pt gutter so wrapped
  // text can never run into the QTY column (reproduces the prior
  // hard-coded 260pt width exactly at the default geometry).
  const DESC_COL_W = colQty - colDesc - 20;
  const ROW_PAD = 8;

  // Single body-line height (Helvetica 10) — the floor for every row so
  // single-line rows keep their exact prior spacing.
  doc.font("Helvetica").fontSize(10);
  const MIN_ROW_H = doc.heightOfString("Ag", { width: DESC_COL_W });

  // The proposal footer band is drawn once at end-of-document ~50pt above
  // the page bottom; reserve room so rows/totals never collide with it.
  const FOOTER_RESERVE = 60;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;

  // Column header — extracted so it repeats on every continuation page.
  // Returns the y of the first row beneath it.
  function drawTableHeader(topY) {
    doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold");
    doc.text("DESCRIPTION", colDesc, topY, { characterSpacing: 1, lineBreak: false });
    doc.text("QTY", colQty, topY, { width: QTY_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.text("UNIT", colUnit, topY, { width: UNIT_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.text("LINE TOTAL", colTotal, topY, { width: TOTAL_W, align: "right", characterSpacing: 1, lineBreak: false });
    doc.moveTo(MARGIN_X, topY + 14).lineTo(MARGIN_X + contentWidth, topY + 14)
      .strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
    return topY + 22;
  }

  let rowY = drawTableHeader(doc.y + 4);
  for (const li of quote.lineItems) {
    const label = li.label || li.sourceKey || "Line item";
    const qty = Number(li.qty) || 1;
    const price = Number(li.price) || 0;
    const lineTotal = Number(li.lineTotal) || (price * qty);
    const desc = li.description ? String(li.description) : "";

    // Measure the description block (label + optional sub-description) at
    // the description column width, each piece in its own font size, so
    // the row gets exactly the vertical space its wrapped text needs.
    // This is the fix for the fixed-height row collision: the numbers
    // used to reset doc.y back to the row top, so a wrapped description
    // bled over the next row. We now advance by the measured height.
    doc.font("Helvetica").fontSize(10);
    const labelH = doc.heightOfString(label, { width: DESC_COL_W });
    let descH = 0;
    if (desc) {
      doc.font("Helvetica").fontSize(9);
      descH = 1 + doc.heightOfString(desc, { width: DESC_COL_W });
    }
    const rowH = Math.max(labelH + descH, MIN_ROW_H);

    // Break BEFORE drawing when the row won't fit; repeat the column
    // header on the new page.
    if (rowY + rowH > pageBottom()) {
      doc.addPage();
      rowY = drawTableHeader(doc.page.margins.top);
    }

    // All four cells share the same row top `rowY`. The numbers top-align
    // with the FIRST line of the description (not its vertical centre).
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(label, colDesc, rowY, { width: DESC_COL_W });
    if (desc) {
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED)
        .text(desc, colDesc, rowY + labelH + 1, { width: DESC_COL_W });
    }
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(String(qty), colQty, rowY, { width: QTY_W, align: "right", lineBreak: false });
    doc.text(fmt(price) + (li.unit ? `/${li.unit.replace("per_", "")}` : ""),
      colUnit, rowY, { width: UNIT_W, align: "right", lineBreak: false });
    doc.text(fmt(lineTotal), colTotal, rowY, { width: TOTAL_W, align: "right", lineBreak: false });

    rowY += rowH + ROW_PAD;
  }

  // Keep the whole totals block together — never strand a lone "Total
  // CAD" on a page by itself. If it won't fit under the final row, move
  // the entire block to a fresh page.
  const TOTALS_BLOCK_H = 130;
  if (rowY + TOTALS_BLOCK_H > pageBottom()) {
    doc.addPage();
    rowY = doc.page.margins.top;
  }

  // Totals.
  doc.moveTo(colUnit, rowY).lineTo(MARGIN_X + contentWidth, rowY)
    .strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  rowY += 8;
  const subtotal = Number(quote.subtotal) || 0;
  const hst = Number(quote.hst) || Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Number(quote.total) || Math.round((subtotal + hst) * 100) / 100;

  doc.fillColor(PJL_MUTED).fontSize(10).font("Helvetica");
  doc.text("Subtotal", colUnit, rowY, { width: 70, align: "right" });
  doc.fillColor(PJL_TEXT).text(fmt(subtotal), colTotal, rowY, { width: 80, align: "right" });
  rowY += 16;
  doc.fillColor(PJL_MUTED).text("HST (13%)", colUnit, rowY, { width: 70, align: "right" });
  doc.fillColor(PJL_TEXT).text(fmt(hst), colTotal, rowY, { width: 80, align: "right" });
  rowY += 18;
  doc.moveTo(colUnit, rowY).lineTo(MARGIN_X + contentWidth, rowY).strokeColor(PJL_GREEN).lineWidth(1).stroke();
  rowY += 6;
  doc.fillColor(PJL_GREEN).font("Helvetica-Bold").fontSize(13);
  doc.text("Total CAD", colUnit, rowY, { width: 70, align: "right" });
  doc.text(fmt(total), colTotal, rowY, { width: 80, align: "right" });
  doc.y = rowY + 28;

  if (quote.billingMode === "time_and_material") {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED);
    const rate = quote.customRates?.labour;
    const rateLine = Number.isFinite(Number(rate)) ? `Locked labour rate: $${Number(rate).toFixed(2)}/hr.` : "";
    doc.text(
      `Time-and-material billing. Quantities above are estimates; actuals invoiced at the rates shown. ${rateLine}`,
      MARGIN_X, doc.y, { width: contentWidth }
    );
    doc.moveDown(0.4);
  }
}

// `docWord` lets non-proposal callers keep the customer-facing copy
// honest ("this quote" vs "this proposal"); `esignOnly` drops the
// print-sign-return column — the PDF-return staging path is
// project_proposal-only server-side, so offering it on other quote
// types would dead-end the customer.
function renderAcceptanceBlock(doc, quote, { MARGIN_X, contentWidth, acceptanceUrl, returnEmail, docWord = "proposal", esignOnly = false }) {
  if (doc.y > doc.page.height - 260) doc.addPage();

  doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(15);
  doc.text("ACCEPTANCE", MARGIN_X, doc.y, { characterSpacing: 1.2 });
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + 60, ruleY).strokeColor(PJL_GREEN).lineWidth(1.5).stroke();
  doc.moveDown(0.4);

  doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(10);
  doc.text(
    esignOnly
      ? `Accepting this ${docWord} takes a minute — sign online from any device.`
      : `You may accept this ${docWord} in either of two ways — both produce a legally binding acceptance.`,
    MARGIN_X, doc.y, { width: contentWidth }
  );
  doc.moveDown(0.4);

  // Already-accepted branch: show the evidence inline. ai_repair_quote
  // signatures land via acceptWithSignature (no acceptanceMethod field
  // change), so the esignOnly path keys off signature.signed alone.
  if ((quote.acceptanceMethod === "portal_esign" || esignOnly) && quote.signature?.signed) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PJL_GREEN);
    doc.text("Accepted via portal e-sign.", MARGIN_X, doc.y, { width: contentWidth });
    try {
      const m = String(quote.signature.imageData).match(/^data:image\/[a-z]+;base64,(.+)$/);
      if (m) {
        const buf = Buffer.from(m[1], "base64");
        doc.image(buf, MARGIN_X, doc.y + 6, { fit: [220, 60] });
        doc.y = doc.y + 70;
      }
    } catch (_) { /* ignore */ }
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(`Signed by ${quote.signature.customerName || "—"}`, MARGIN_X, doc.y + 4);
    if (quote.signature.signedAt) {
      doc.fontSize(9).fillColor(PJL_MUTED)
        .text(`on ${new Date(quote.signature.signedAt).toLocaleString("en-CA")}` +
              (quote.signature.ip ? ` · IP ${quote.signature.ip}` : ""), MARGIN_X, doc.y);
    }
    return;
  }
  if (quote.acceptanceMethod === "pdf_return" && quote.acceptanceEvidence?.confirmedAt) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PJL_GREEN);
    doc.text("Accepted via signed PDF return.", MARGIN_X, doc.y, { width: contentWidth });
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(
      `Confirmed on ${new Date(quote.acceptanceEvidence.confirmedAt).toLocaleDateString("en-CA")}` +
      (quote.acceptanceEvidence.senderEmail ? ` · returned from ${quote.acceptanceEvidence.senderEmail}` : ""),
      MARGIN_X, doc.y + 4, { width: contentWidth }
    );
    return;
  }

  // Single-option e-sign layout (smart-controller quotes — no PDF-return
  // path exists for ai_repair_quote, so don't offer one).
  if (esignOnly) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PJL_GREEN);
    doc.text("Sign online", MARGIN_X, doc.y, { width: contentWidth });
    doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
    doc.text(
      "Open the link below on any device. Draw your signature on the page and tap Approve — we're notified immediately and will reach out to schedule your install.",
      MARGIN_X, doc.y + 4, { width: contentWidth }
    );
    doc.moveDown(0.4);
    if (acceptanceUrl) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_GREEN);
      doc.text(acceptanceUrl, MARGIN_X, doc.y, { width: contentWidth, link: acceptanceUrl, underline: true });
    } else {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED);
      doc.text("(Your personal signing link arrives by email and text when this quote is sent.)", MARGIN_X, doc.y, { width: contentWidth });
    }
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
    doc.text(
      "Prefer paper, or have questions first? Call (905) 960-0181 or reply to the email this quote arrived in.",
      MARGIN_X, doc.y, { width: contentWidth }
    );
    return;
  }

  // Two-column layout — left = portal e-sign, right = print + return.
  const colWidth = (contentWidth - 20) / 2;
  const leftX = MARGIN_X;
  const rightX = MARGIN_X + colWidth + 20;
  const blockTop = doc.y;

  // ---- Left: portal e-sign ----
  doc.font("Helvetica-Bold").fontSize(11).fillColor(PJL_GREEN);
  doc.text("Option A — Sign online", leftX, blockTop, { width: colWidth });
  doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
  doc.text(
    "Open the link below on any device. Draw your signature on the page and tap Approve. We're notified immediately.",
    leftX, doc.y + 4, { width: colWidth }
  );
  if (acceptanceUrl) {
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(PJL_GREEN);
    doc.text(acceptanceUrl, leftX, doc.y, { width: colWidth, link: acceptanceUrl, underline: true });
  } else {
    doc.moveDown(0.4);
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(PJL_MUTED);
    doc.text("(Acceptance link will be emailed/texted on send.)", leftX, doc.y, { width: colWidth });
  }
  const leftBottom = doc.y;

  // ---- Right: print, sign, return ----
  doc.y = blockTop;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(PJL_GREEN);
  doc.text("Option B — Print, sign, return", rightX, blockTop, { width: colWidth });
  doc.font("Helvetica").fontSize(9).fillColor(PJL_TEXT);
  doc.text(
    `Print this page, sign below, and email a scan back to ${returnEmail}. We'll confirm receipt within one business day.`,
    rightX, doc.y + 4, { width: colWidth }
  );
  doc.moveDown(0.6);

  // Signature line + printed name line + date line.
  const sigY = doc.y + 24;
  doc.moveTo(rightX, sigY).lineTo(rightX + colWidth - 10, sigY).strokeColor(PJL_TEXT).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED)
    .text("Customer signature", rightX, sigY + 3, { width: colWidth });

  const nameY = sigY + 36;
  doc.moveTo(rightX, nameY).lineTo(rightX + colWidth - 10, nameY).strokeColor(PJL_TEXT).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED)
    .text("Printed name", rightX, nameY + 3, { width: colWidth });

  const dateY = nameY + 36;
  doc.moveTo(rightX, dateY).lineTo(rightX + 120, dateY).strokeColor(PJL_TEXT).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(PJL_MUTED)
    .text("Date", rightX, dateY + 3);

  doc.y = Math.max(leftBottom, dateY + 18);
}

// ---- Smart Controller Upgrade PDF (brief 2026-06-12) ------------------
//
// Rich, website-grade layout for ai_repair_quote records that carry a
// narrativeKey (currently only "smart-controller"). Composes the SAME
// section components the proposal renderer uses — renderSection,
// renderProposalLineItems, renderAcceptanceBlock — with sections
// synthesized at render time from the editable content block
// (server/lib/templates/, via quote-narratives.js). No proposal fork:
// the quote stays a plain ai_repair_quote; only the rendering differs.
//
// Layout: cover header (title + logo + prepared-for) → narrative
// sections (why Hydrawise / what's included / warranty & savings /
// technical reference) → "YOUR INVESTMENT" line-items table (from the
// quote's snapshotted lineItems — pricing.json is never read here) →
// e-sign-only acceptance block → footer.

const quoteNarratives = require("./quote-narratives");

function renderSmartControllerPdf(quote, opts = {}) {
  const customer = opts.customer || {};
  const property = opts.property || {};
  const acceptanceUrl = opts.acceptanceUrl || null;

  const header = quoteNarratives.headerFor(quote.narrativeKey) || {
    documentTitle: "Quote", eyebrow: "", headline: "", intro: ""
  };
  const sections = quoteNarratives.sectionsFor(quote.narrativeKey);

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: `PJL Quote ${quote.id} — ${header.documentTitle}`,
      Author: "PJL Land Services",
      Subject: quote.scope || header.documentTitle,
      Keywords: `quote ${quote.id} pjl land services hydrawise smart controller`
    }
  });

  const barlow = barlowBuffer();
  if (barlow) doc.registerFont("Barlow-Bold", barlow);

  const PAGE_W = doc.page.width;
  const MARGIN_X = 60;
  const contentWidth = PAGE_W - MARGIN_X * 2;

  // ---- Cover header (shared layout — see renderPdfHeader) -------------
  let y = renderPdfHeader(doc, {
    title: "QUOTE",
    eyebrow: header.eyebrow || "",
    idText: quote.id,
    issuedLine: `Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? `  ·  Valid through ${fmtDate(quote.validUntil)}` : ""}`
  });
  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
    .text("PREPARED FOR", MARGIN_X, y, { characterSpacing: 1 });
  doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(12);
  const billToName = customer.name || customer.customerName || quote.customerEmail || "Customer";
  doc.text(billToName, MARGIN_X, doc.y + 4);
  if (property.address || customer.address) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(property.address || customer.address);
  }
  const contactBits = [customer.phone || customer.customerPhone, quote.customerEmail].filter(Boolean);
  if (contactBits.length) {
    doc.fontSize(10).fillColor(PJL_MUTED).text(contactBits.join(" · "));
  }

  // Headline + intro from the content block.
  if (header.headline) {
    doc.moveDown(0.8);
    doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(18);
    doc.text(header.headline, MARGIN_X, doc.y, { width: contentWidth });
  }
  if (header.intro) {
    doc.moveDown(0.2);
    doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(10);
    doc.text(header.intro, MARGIN_X, doc.y, { width: contentWidth, lineGap: 2 });
  }
  doc.moveDown(0.6);

  // ---- Narrative sections (reused proposal component) ----------------
  for (const sec of sections) {
    renderSection(doc, sec, quote, { MARGIN_X, contentWidth });
  }

  // ---- Your investment (reused line-items component) ------------------
  doc.moveDown(1);
  renderProposalLineItems(doc, quote, { MARGIN_X, contentWidth, heading: "YOUR INVESTMENT" });

  // ---- Acceptance — e-sign only ---------------------------------------
  doc.moveDown(1.2);
  renderAcceptanceBlock(doc, quote, {
    MARGIN_X, contentWidth, acceptanceUrl,
    docWord: "quote", esignOnly: true
  });

  // ---- Footer ---------------------------------------------------------
  const restoreBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 50;
  doc.moveTo(MARGIN_X, footerY).lineTo(PAGE_W - MARGIN_X, footerY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text(
    "PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com",
    MARGIN_X, footerY + 8,
    { width: PAGE_W - MARGIN_X * 2, align: "center", lineBreak: false }
  );
  doc.page.margins.bottom = restoreBottom;

  doc.end();
  return doc;
}

// ---- Dispatcher ------------------------------------------------------

const _originalGenerateQuotePdf = generateQuotePdf;

function renderQuotePdf(quote, opts = {}) {
  if (quote && quote.type === "project_proposal") {
    return renderProjectProposalPdf(quote, opts);
  }
  if (quote && quote.type === "ai_repair_quote" && quote.narrativeKey) {
    return renderSmartControllerPdf(quote, opts);
  }
  return _originalGenerateQuotePdf(quote, opts);
}

module.exports = {
  generateQuotePdf,            // unchanged — back-compat for existing callers
  renderQuotePdf,              // dispatcher — prefer this for new code
  renderProjectProposalPdf,    // exported for direct invocation if needed
  renderSmartControllerPdf,    // rich controller layout (narrativeKey quotes)
  parseSectionBody,            // Brief C2 markup parser — exported for tests
  parseInlineRuns              // line-scoped inline run parser — exported for tests
};

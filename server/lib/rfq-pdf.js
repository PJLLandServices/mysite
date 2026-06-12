// Request for Quotation PDF generator. Branded, professional document
// the supplier receives as an email attachment — the "ask for a price"
// sibling of po-pdf.js ("commit to buy"). Layout mirrors the PO's
// seven-region structure, minus everything that would make it read like
// an order:
//
//   1. Top accent — 4 pt solid PJL-green rule at the page edge
//   2. Header   — sender brand + contact (left)  /  RFQ identity (right)
//   3. Parties  — Vendor (left)  /  Requested By (right), 50/50 columns
//   4. Items    — 6-column table: # · SKU · Description · Qty · Unit ·
//                 Quoted Unit Price (an EMPTY ruled write-on cell — the
//                 vendor fills it in by hand or in their system)
//   5. (no totals region — an RFQ carries no prices anywhere)
//   6. Notes    — quote-your-best-price ask, referencing the RFQ id +
//                 CSV attachment, explicitly "not a purchase order"
//   7. Footer   — thin band with PJL contact line, every page
//
// Returns Promise<Buffer> so the caller can both stream (HTTP) and
// attach (email) without juggling streams.
//
// Multi-page handling: the header and footer repeat on every page; the
// continuation header uses a condensed `<RFQ-ID> — continued, page N of M`
// label instead of the full sender brand block. Notes appear only on
// the final page.

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

const company = require("./company");
const { formatUnit, formatVendorAddress, resolveLineDescription } = require("./format");

// ---- Constants -------------------------------------------------------

const PAGE_W = 612;             // US Letter, points
const PAGE_H = 792;
const MARGIN_X = 36;            // same page setup as po-pdf.js
const MARGIN_TOP = 28;
const MARGIN_BOTTOM = 28;

const TOP_RULE_HEIGHT = 4;      // region 1

const PJL_GREEN = company.GREEN_HEX;
const INK = "#1F2A22";          // primary text — body / titles
const INK_SECONDARY = "#5A5F58";// secondary text — addresses, labels
const INK_TERTIARY = "#888780"; // tertiary — section labels, hints
const RULE = "#1F2A22";         // hairline rules between rows
const BORDER_HAIR = "#D3D1C7";  // 0.5pt inter-row separators

// Width of the hand-write line inside the Quoted Unit Price column.
// Drawn right-aligned within the column so it lands where a printed
// value would end; ~80pt gives room for "$1,234.56" in pen.
const WRITE_LINE_W = 80;

// Barlow Condensed — same TTF the invoice, quote, and PO PDFs use.
// Falls back to Helvetica-Bold when the font file is missing (local
// dev without assets).
const BARLOW_BOLD_PATH = path.resolve(__dirname, "..", "assets", "fonts", "BarlowCondensed-Bold.ttf");
let _barlowBuf = null;
function barlowBuffer() {
  if (_barlowBuf !== null) return _barlowBuf;
  try {
    _barlowBuf = fsSync.readFileSync(BARLOW_BOLD_PATH);
  } catch {
    _barlowBuf = false;
  }
  return _barlowBuf;
}
function registerFonts(doc) {
  const buf = barlowBuffer();
  if (buf) doc.registerFont("Barlow-Bold", buf);
}
function fontHeading(doc) {
  return barlowBuffer() ? "Barlow-Bold" : "Helvetica-Bold";
}

// ---- Formatters ------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}

// ---- Catalog lookup (description + unit fallback per SKU) ------------
//
// RFQ lines snapshot description + unit at generation, so the catalog is
// only a fallback for blank snapshots / legacy records. The caller passes
// the merged in-memory catalog (PARTS.parts — baseline + overrides); we
// fall back to the on-disk parts.json only when no catalog is provided.
// Same catalogParts(passed) pattern as po-pdf.js / po-csv.js.

let _partsCache = null;
function loadParts() {
  if (_partsCache) return _partsCache;
  try {
    const p = path.resolve(__dirname, "..", "..", "parts.json");
    _partsCache = JSON.parse(fsSync.readFileSync(p, "utf8"));
  } catch {
    _partsCache = { parts: {} };
  }
  return _partsCache;
}

function catalogParts(passed) {
  if (passed && typeof passed === "object") return passed;
  return loadParts().parts || {};
}

// Unit resolution: the snapshot on the line wins; catalog unit is the
// fallback; "each" the last resort (matches the parts.js hydration
// default). Mirrors the description precedence in resolveLineDescription.
function unitForLine(line, catalog) {
  if (line && line.unit) return line.unit;
  const sku = line && line.sku != null ? String(line.sku) : "";
  const part = catalog && Object.prototype.hasOwnProperty.call(catalog, sku) ? catalog[sku] : null;
  return (part && part.unit) || "each";
}

// ---- Table layout (column positions, in points) ----------------------
//
// Built up front so the row renderer can reference the same x-positions
// every row. Description column flexes — its width is whatever remains
// after the fixed columns claim their space. Dropping the PO's LineTotal
// column and widening Unit Price into a write-on cell leaves the RFQ
// description noticeably roomier than the PO's.

function tableLayout() {
  const left = MARGIN_X;
  const right = PAGE_W - MARGIN_X;
  // Fixed columns. quotedPrice is sized so the "QUOTED UNIT PRICE"
  // header fits on one line at 9pt with 0.6 tracking (~102pt).
  const widths = {
    rowNum:      24,
    sku:        110,
    qty:         38,
    unit:        38,
    quotedPrice: 105
  };
  // Gap between columns (visual breathing room).
  const GAP = 8;
  // Compute description width = remaining space.
  const fixedTotal =
    widths.rowNum + widths.sku + widths.qty + widths.unit +
    widths.quotedPrice + GAP * 5;
  const descWidth = right - left - fixedTotal;

  let x = left;
  const xs = {};
  xs.rowNum      = x; x += widths.rowNum + GAP;
  xs.sku         = x; x += widths.sku + GAP;
  xs.desc        = x; x += descWidth + GAP;
  xs.qty         = x; x += widths.qty + GAP;
  xs.unit        = x; x += widths.unit + GAP;
  xs.quotedPrice = x; // last column; no trailing gap

  return { xs, widths, descWidth, left, right };
}

// ---- Region renderers -------------------------------------------------

function drawTopRule(doc) {
  doc.save()
    .rect(0, 0, PAGE_W, TOP_RULE_HEIGHT)
    .fill(PJL_GREEN)
    .restore();
}

function drawHeaderFull(doc, rfq) {
  const headerTop = TOP_RULE_HEIGHT + 24; // ~28 pt from page top to first text line
  // Sender (left)
  doc.font(fontHeading(doc))
    .fontSize(13)
    .fillColor(INK)
    .text(company.NAME, MARGIN_X, headerTop, { lineBreak: false });

  doc.font("Helvetica")
    .fontSize(10)
    .fillColor(INK_SECONDARY);
  let senderY = headerTop + 17;
  doc.text(company.CITY, MARGIN_X, senderY, { lineBreak: false });
  senderY += 13;
  doc.text(company.PHONE, MARGIN_X, senderY, { lineBreak: false });
  senderY += 13;
  doc.text(company.email(), MARGIN_X, senderY, { lineBreak: false });

  // Document identity (right) — right-aligned block. The label is the
  // single loudest "this is not an order" signal on the page.
  const rightWidth = 240;
  const rightX = PAGE_W - MARGIN_X - rightWidth;

  doc.font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(INK_TERTIARY)
    .text("REQUEST FOR QUOTATION", rightX, headerTop, {
      width: rightWidth, align: "right", characterSpacing: 1
    });

  doc.font(fontHeading(doc))
    .fontSize(22)
    .fillColor(INK)
    .text(rfq.id, rightX, headerTop + 15, {
      width: rightWidth, align: "right", lineBreak: false
    });

  doc.font("Helvetica")
    .fontSize(10)
    .fillColor(INK_SECONDARY)
    .text(`Issued ${fmtDate(rfq.createdAt)}`, rightX, headerTop + 44, {
      width: rightWidth, align: "right"
    });

  return headerTop + 70; // y of bottom of full header
}

function drawHeaderCondensed(doc, rfq, pageNum, totalPages) {
  const headerTop = TOP_RULE_HEIGHT + 24;
  doc.font(fontHeading(doc))
    .fontSize(11)
    .fillColor(INK_SECONDARY)
    .text(`${rfq.id} — continued`, MARGIN_X, headerTop, { lineBreak: false });
  doc.font("Helvetica")
    .fontSize(10)
    .fillColor(INK_TERTIARY)
    .text(`Page ${pageNum} of ${totalPages}`,
      PAGE_W - MARGIN_X - 200, headerTop, { width: 200, align: "right", lineBreak: false });
  return headerTop + 24;
}

function drawPartiesBlock(doc, rfq, startY) {
  const colW = (PAGE_W - MARGIN_X * 2 - 24) / 2; // 24pt gutter
  const leftX = MARGIN_X;
  const rightX = leftX + colW + 24;

  // Section labels — the PO's "SHIP TO" becomes "REQUESTED BY": nothing
  // ships on an inquiry, so the right column is who's asking, not a
  // delivery address.
  doc.font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(INK_TERTIARY)
    .text("VENDOR", leftX, startY, { characterSpacing: 1, lineBreak: false });
  doc.text("REQUESTED BY", rightX, startY, { characterSpacing: 1, lineBreak: false });

  let y = startY + 14;
  // Vendor name
  doc.font(fontHeading(doc))
    .fontSize(13)
    .fillColor(INK)
    .text(rfq.supplierName || "(unknown supplier)", leftX, y, { width: colW, lineBreak: false });
  // Requesting company name
  doc.text(company.NAME, rightX, y, { width: colW, lineBreak: false });

  y += 18;
  doc.font("Helvetica").fontSize(10).fillColor(INK_SECONDARY);

  // Vendor details — formatVendorAddress handles the all-caps + postal
  // split; supplier may also have no contact / no email / no phone.
  const vendor = formatVendorAddress({
    contactName: rfq.supplierContactName,
    address: rfq.supplierAddress
  });
  let vendorY = y;
  if (vendor.attn) {
    doc.text(vendor.attn, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }
  for (const line of vendor.lines) {
    doc.text(line, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }
  if (rfq.supplierEmail) {
    doc.text(rfq.supplierEmail, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }
  if (rfq.supplierPhone) {
    doc.text(rfq.supplierPhone, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }

  // Requested-by details — PJL's contact info; email is omitted here
  // (it's already in the header sender block), same as the PO ship-to.
  let reqY = y;
  doc.text(company.CITY, rightX, reqY, { width: colW, lineBreak: false });
  reqY += 13;
  doc.text(company.PHONE, rightX, reqY, { width: colW, lineBreak: false });

  return Math.max(vendorY, reqY) + 6; // y of bottom of parties block
}

function drawTableHeader(doc, y) {
  const { xs, widths } = tableLayout();
  doc.font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(INK_TERTIARY);
  const headerOpts = { characterSpacing: 0.6, lineBreak: false };
  doc.text("#",                 xs.rowNum,      y, { ...headerOpts, width: widths.rowNum });
  doc.text("SKU",               xs.sku,         y, { ...headerOpts, width: widths.sku });
  doc.text("DESCRIPTION",       xs.desc,        y, { ...headerOpts, width: tableLayout().descWidth });
  doc.text("QTY",               xs.qty,         y, { ...headerOpts, width: widths.qty, align: "right" });
  doc.text("UNIT",              xs.unit,        y, { ...headerOpts, width: widths.unit });
  doc.text("QUOTED UNIT PRICE", xs.quotedPrice, y, { ...headerOpts, width: widths.quotedPrice, align: "right" });
  // 1pt bottom border below the header text
  const ruleY = y + 18;
  doc.save()
    .moveTo(MARGIN_X, ruleY).lineTo(PAGE_W - MARGIN_X, ruleY)
    .strokeColor(INK).lineWidth(1).stroke()
    .restore();
  return ruleY + 10; // y of first row
}

function drawTableRow(doc, line, rowNum, rowY, catalog) {
  const { xs, widths, descWidth } = tableLayout();
  const description = resolveLineDescription(line, catalog);
  const unitLabel = formatUnit(unitForLine(line, catalog), line.quantity);

  // Description height drives row height. Compute it before drawing so
  // every cell can align to the same top + the inter-row rule lands at
  // the right y.
  doc.font("Helvetica").fontSize(11);
  const descHeight = doc.heightOfString(description, { width: descWidth });
  const rowHeight = Math.max(descHeight, 14) + 20; // 10pt top + 10pt bottom padding

  const textY = rowY + 10;
  const opts = { lineBreak: false };

  // # — secondary color
  doc.font("Helvetica").fontSize(11).fillColor(INK_SECONDARY);
  doc.text(String(rowNum), xs.rowNum, textY, { ...opts, width: widths.rowNum });

  // SKU — Courier mono, slightly smaller for density
  doc.font("Courier").fontSize(10.5).fillColor(INK);
  doc.text(line.sku || "—", xs.sku, textY, { ...opts, width: widths.sku });

  // Description — wrapping allowed (the only column that wraps)
  doc.font("Helvetica").fontSize(11).fillColor(INK);
  doc.text(description, xs.desc, textY, { width: descWidth });

  // Qty — right-aligned. RFQ lines store `quantity` (not the PO's `qty`).
  doc.font("Helvetica").fontSize(11).fillColor(INK);
  doc.text(String(line.quantity), xs.qty, textY, { ...opts, width: widths.qty, align: "right" });

  // Unit — secondary color
  doc.font("Helvetica").fontSize(11).fillColor(INK_SECONDARY);
  doc.text(unitLabel, xs.unit, textY, { ...opts, width: widths.unit });

  // Quoted unit price — an EMPTY write-on cell: a light hairline the
  // vendor hand-writes (or types) their price onto. No value is ever
  // rendered here; quotedPriceCents lives in the data model only.
  const writeY = textY + 12; // sits where a printed value's baseline would
  const writeX2 = xs.quotedPrice + widths.quotedPrice;
  doc.save()
    .moveTo(writeX2 - WRITE_LINE_W, writeY).lineTo(writeX2, writeY)
    .strokeColor(INK_TERTIARY).lineWidth(0.6).stroke()
    .restore();

  // Hairline inter-row separator at the bottom of THIS row.
  const ruleY = rowY + rowHeight;
  doc.save()
    .moveTo(MARGIN_X, ruleY).lineTo(PAGE_W - MARGIN_X, ruleY)
    .strokeColor(BORDER_HAIR).lineWidth(0.5).stroke()
    .restore();

  return ruleY;
}

// No drawTotals — an RFQ has no prices, so there is nothing to total.
// The notes paragraph carries the ask instead.

function drawNotes(doc, rfq, y) {
  const text = `Please quote your best unit price and lead time for each item above, and reference ${rfq.id} in your reply. This is a request for quotation only — not a purchase order. CSV of line items attached for system entry.${rfq.notes ? "\n\n" + rfq.notes : ""}`;
  doc.font("Helvetica").fontSize(10).fillColor(INK_SECONDARY);
  doc.text(text, MARGIN_X, y, {
    width: PAGE_W - MARGIN_X * 2,
    lineGap: 4
  });
  return doc.y;
}

function drawFooter(doc) {
  // The footer text must finish before the bottom-margin line at
  // (PAGE_H - MARGIN_BOTTOM) = 764. Otherwise pdfkit's LineWrapper
  // auto-paginates, even with lineBreak: false (the overflow check
  // runs before line-break logic). Text is 9pt — keep the baseline
  // well above the margin, with the rule above that.
  const textY = PAGE_H - MARGIN_BOTTOM - 14;  // baseline; 9pt text reaches ~textY+10
  const ruleY = textY - 8;
  doc.save()
    .moveTo(MARGIN_X, ruleY).lineTo(PAGE_W - MARGIN_X, ruleY)
    .strokeColor(BORDER_HAIR).lineWidth(0.5).stroke()
    .restore();

  const text = `${company.NAME} · ${company.CITY} · ${company.PHONE} · ${company.email()}`;
  doc.font("Helvetica").fontSize(9).fillColor(INK_TERTIARY);
  // Pass an explicit height to suppress LineWrapper's height check; the
  // pagination decision is owned by ensureRowFits, not by text overflow.
  doc.text(text, MARGIN_X, textY, {
    width: PAGE_W - MARGIN_X * 2,
    align: "center",
    characterSpacing: 0.4,
    lineBreak: false,
    height: 10
  });
}

// ---- Pagination helper ------------------------------------------------
//
// The pdfkit page-add lifecycle is: when content overflows, the caller
// either appends a `doc.addPage()` or we manage it manually. We choose
// manual — every row renderer returns the y it ended at, and we check
// whether the NEXT row would fit before drawing.

const PAGE_CONTENT_BOTTOM = PAGE_H - MARGIN_BOTTOM - 60; // leaves room for footer

function ensureRowFits(doc, currentY, neededHeight, ctx) {
  if (currentY + neededHeight <= PAGE_CONTENT_BOTTOM) return currentY;
  // Overflow — finalize this page's footer, start a new page, draw
  // the condensed header + table header, return the y where the row
  // should land.
  drawFooter(doc);
  doc.addPage();
  ctx.pageNum += 1;
  drawTopRule(doc);
  const afterHeader = drawHeaderCondensed(doc, ctx.rfq, ctx.pageNum, ctx.totalPages);
  return drawTableHeader(doc, afterHeader + 24);
}

// ---- Main renderer ----------------------------------------------------

function generateRfqPdf(rfq, partsMap) {
  const catalog = catalogParts(partsMap);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
        info: {
          Title: `PJL Request for Quotation ${rfq.id}`,
          Author: company.NAME,
          Subject: `Request for Quotation to ${rfq.supplierName || "supplier"}`,
          Keywords: `request for quotation ${rfq.id} pjl land services`
        },
        autoFirstPage: true
        // bufferPages omitted: defaults to false. We manage pagination
        // manually via ensureRowFits; bufferPages would let us back-edit
        // committed pages, which we don't need.
      });
      registerFonts(doc);

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Two-pass render: first pass measures total pages by counting
      // rows + estimating row heights; second pass renders for real
      // with the correct N-of-M continuation header. We bias slightly
      // optimistic on first pass (estimates description wrap) — close
      // enough for the page indicator. Re-measure if exact M-of-M
      // pagination becomes critical.
      const items = Array.isArray(rfq.lines) ? rfq.lines : [];
      const totalPages = estimateTotalPages(doc, items, catalog);

      // ---- First page ------------------------------------------------
      drawTopRule(doc);
      const afterHeader = drawHeaderFull(doc, rfq);
      const afterParties = drawPartiesBlock(doc, rfq, afterHeader + 16);
      let rowY = drawTableHeader(doc, afterParties + 24);

      const ctx = { rfq, pageNum: 1, totalPages };

      // ---- Rows ------------------------------------------------------
      for (let i = 0; i < items.length; i++) {
        const line = items[i];
        // Estimate height before drawing so we can paginate ahead of
        // overflow.
        doc.font("Helvetica").fontSize(11);
        const description = resolveLineDescription(line, catalog);
        const descHeight = doc.heightOfString(description, { width: tableLayout().descWidth });
        const rowHeight = Math.max(descHeight, 14) + 20;
        rowY = ensureRowFits(doc, rowY, rowHeight, ctx);
        rowY = drawTableRow(doc, line, i + 1, rowY, catalog);
      }

      // ---- Notes (last page only; no totals on an RFQ) ----------------
      // The ask paragraph plus optional rfq.notes fits in ~100pt; if the
      // final-row Y has less remaining, push it onto a new page.
      const trailingHeight = 100;
      rowY = ensureRowFits(doc, rowY, trailingHeight, ctx);

      rowY = drawNotes(doc, rfq, rowY + 18);

      // ---- Footer (this page) ----------------------------------------
      drawFooter(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Estimate total page count up front so the condensed continuation
// header can say "page 2 of 4" on the second page. Approximation:
// row heights estimated against the page width; trailing block fixed at
// 100pt. The estimate runs on a throwaway doc so we don't disturb the
// real render's font/state.
function estimateTotalPages(realDoc, items, catalog) {
  const probe = new PDFDocument({ size: "LETTER", margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X } });
  const { descWidth } = tableLayout();
  const headerSpace = 60 /* top rule + sender */ + 70 /* doc identity */ + 16 + 70 /* parties */ + 24 + 28 /* table header */;
  let used = headerSpace;
  let pages = 1;
  for (let i = 0; i < items.length; i++) {
    probe.font("Helvetica").fontSize(11);
    const description = resolveLineDescription(items[i], catalog);
    const descHeight = probe.heightOfString(description, { width: descWidth });
    const rowHeight = Math.max(descHeight, 14) + 20;
    if (used + rowHeight > PAGE_CONTENT_BOTTOM - MARGIN_TOP) {
      pages += 1;
      used = TOP_RULE_HEIGHT + 24 + 24 /* condensed header */ + 28 /* table header */;
    }
    used += rowHeight;
  }
  // Reserve final page for the trailing notes block
  if (used + 100 > PAGE_CONTENT_BOTTOM - MARGIN_TOP) {
    pages += 1;
  }
  probe.end();
  // Drain the probe (it's a writable stream — leaving it open leaks memory).
  probe.on("data", () => {});
  return pages;
}

module.exports = { generateRfqPdf };

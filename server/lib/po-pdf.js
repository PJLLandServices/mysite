// Purchase Order PDF generator. Branded, professional one-page document
// the supplier receives as an email attachment. Layout follows the
// seven-region structure from the PO Document Redesign brief:
//
//   1. Top accent — 4 pt solid PJL-green rule at the page edge
//   2. Header   — sender brand + contact (left)  /  PO identity (right)
//   3. Parties  — Vendor (left)  /  Ship To (right), 50/50 columns
//   4. Items    — 7-column table: # · SKU · Description · Qty · Unit · UnitPrice · LineTotal
//   5. Totals   — right-aligned subtotal block; HST handled by supplier
//   6. Notes    — single paragraph referencing the PO id + CSV attachment
//   7. Footer   — thin band with PJL contact line, every page
//
// Returns Promise<Buffer> so the caller can both stream (HTTP) and
// attach (email) without juggling streams.
//
// Multi-page handling: the header and footer repeat on every page; the
// continuation header uses a condensed `<PO-ID> — continued, page N of M`
// label instead of the full sender brand block. Totals appear only on
// the final page.

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

const company = require("./company");
const { formatUnit, formatVendorAddress } = require("./format");

// ---- Constants -------------------------------------------------------

const PAGE_W = 612;             // US Letter, points
const PAGE_H = 792;
const MARGIN_X = 36;            // brief §3.1 page setup
const MARGIN_TOP = 28;
const MARGIN_BOTTOM = 28;

const TOP_RULE_HEIGHT = 4;      // brief §3.1 region 1

const PJL_GREEN = company.GREEN_HEX;
const INK = "#1F2A22";          // primary text — body / titles
const INK_SECONDARY = "#5A5F58";// secondary text — addresses, labels
const INK_TERTIARY = "#888780"; // tertiary — section labels, hints
const RULE = "#1F2A22";         // hairline rules between rows
const BORDER_HAIR = "#D3D1C7";  // 0.5pt inter-row separators

// Barlow Condensed — same TTF the invoice and quote PDFs use. Falls
// back to Helvetica-Bold when the font file is missing (local dev
// without assets). The brief calls for a sans-serif body and reserves
// Courier for the SKU column.
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

function fmtCents(c) {
  const v = (Number(c) || 0) / 100;
  return "$" + v.toFixed(2);
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}

// ---- Catalog lookup (description + unit per SKU) ---------------------
//
// PO line items store only `sku + qty + unitPriceCents + sourceListId`.
// Descriptions and units are looked up from parts.json at render time.
// Cached for the process lifetime; a parts.json change requires a server
// restart to take effect — which is fine because once a PO has been sent
// the snapshot-on-send storage layer (see server.js /send handler) holds
// the rendered PDF byte-identically anyway.

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

function descriptionFor(sku) {
  const cat = loadParts();
  const part = cat.parts && cat.parts[sku];
  if (!part) return `(SKU ${sku})`;
  const sizeBit = part.size ? `${part.size} — ` : "";
  return `${sizeBit}${part.description || sku}`;
}

function unitFor(sku) {
  const cat = loadParts();
  const part = cat.parts && cat.parts[sku];
  return (part && part.unit) || "each";
}

// ---- Table layout (column positions, in points) ----------------------
//
// Built up front so the row renderer can reference the same x-positions
// every row. Description column flexes — its width is whatever remains
// after the fixed columns claim their space.

function tableLayout() {
  const left = MARGIN_X;
  const right = PAGE_W - MARGIN_X;
  // Fixed columns (brief §3.1 region 4 widths).
  const widths = {
    rowNum:    24,
    sku:      110,
    qty:       38,
    unit:      38,
    unitPrice: 70,
    lineTotal: 78
  };
  // Gap between columns (visual breathing room).
  const GAP = 8;
  // Compute description width = remaining space.
  const fixedTotal =
    widths.rowNum + widths.sku + widths.qty + widths.unit +
    widths.unitPrice + widths.lineTotal + GAP * 6;
  const descWidth = right - left - fixedTotal;

  let x = left;
  const xs = {};
  xs.rowNum    = x; x += widths.rowNum + GAP;
  xs.sku       = x; x += widths.sku + GAP;
  xs.desc      = x; x += descWidth + GAP;
  xs.qty       = x; x += widths.qty + GAP;
  xs.unit      = x; x += widths.unit + GAP;
  xs.unitPrice = x; x += widths.unitPrice + GAP;
  xs.lineTotal = x; // last column; no trailing gap

  return { xs, widths, descWidth, left, right };
}

// ---- Region renderers -------------------------------------------------

function drawTopRule(doc) {
  doc.save()
    .rect(0, 0, PAGE_W, TOP_RULE_HEIGHT)
    .fill(PJL_GREEN)
    .restore();
}

function drawHeaderFull(doc, po) {
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

  // Document identity (right) — right-aligned block
  const rightWidth = 240;
  const rightX = PAGE_W - MARGIN_X - rightWidth;

  doc.font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(INK_TERTIARY)
    .text("PURCHASE ORDER", rightX, headerTop, {
      width: rightWidth, align: "right", characterSpacing: 1
    });

  doc.font(fontHeading(doc))
    .fontSize(22)
    .fillColor(INK)
    .text(po.id, rightX, headerTop + 15, {
      width: rightWidth, align: "right", lineBreak: false
    });

  doc.font("Helvetica")
    .fontSize(10)
    .fillColor(INK_SECONDARY)
    .text(`Issued ${fmtDate(po.createdAt)}`, rightX, headerTop + 44, {
      width: rightWidth, align: "right"
    });

  return headerTop + 70; // y of bottom of full header
}

function drawHeaderCondensed(doc, po, pageNum, totalPages) {
  const headerTop = TOP_RULE_HEIGHT + 24;
  doc.font(fontHeading(doc))
    .fontSize(11)
    .fillColor(INK_SECONDARY)
    .text(`${po.id} — continued`, MARGIN_X, headerTop, { lineBreak: false });
  doc.font("Helvetica")
    .fontSize(10)
    .fillColor(INK_TERTIARY)
    .text(`Page ${pageNum} of ${totalPages}`,
      PAGE_W - MARGIN_X - 200, headerTop, { width: 200, align: "right", lineBreak: false });
  return headerTop + 24;
}

function drawPartiesBlock(doc, po, startY) {
  const colW = (PAGE_W - MARGIN_X * 2 - 24) / 2; // 24pt gutter
  const leftX = MARGIN_X;
  const rightX = leftX + colW + 24;

  // Section labels
  doc.font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(INK_TERTIARY)
    .text("VENDOR", leftX, startY, { characterSpacing: 1, lineBreak: false });
  doc.text("SHIP TO", rightX, startY, { characterSpacing: 1, lineBreak: false });

  let y = startY + 14;
  // Vendor name
  doc.font(fontHeading(doc))
    .fontSize(13)
    .fillColor(INK)
    .text(po.supplierName || "(unknown supplier)", leftX, y, { width: colW, lineBreak: false });
  // Ship-to name
  doc.text(company.NAME, rightX, y, { width: colW, lineBreak: false });

  y += 18;
  doc.font("Helvetica").fontSize(10).fillColor(INK_SECONDARY);

  // Vendor details — formatVendorAddress handles the all-caps + postal
  // split; supplier may also have no contact / no email / no phone.
  const vendor = formatVendorAddress({
    contactName: po.supplierContactName,
    address: po.supplierAddress
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
  if (po.supplierEmail) {
    doc.text(po.supplierEmail, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }
  if (po.supplierPhone) {
    doc.text(po.supplierPhone, leftX, vendorY, { width: colW, lineBreak: false });
    vendorY += 13;
  }

  // Ship-to details — PJL's contact info; the brief explicitly omits
  // PJL email here (it's already in the header sender block).
  let shipY = y;
  doc.text(company.CITY, rightX, shipY, { width: colW, lineBreak: false });
  shipY += 13;
  doc.text(company.PHONE, rightX, shipY, { width: colW, lineBreak: false });

  return Math.max(vendorY, shipY) + 6; // y of bottom of parties block
}

function drawTableHeader(doc, y) {
  const { xs, widths } = tableLayout();
  doc.font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(INK_TERTIARY);
  const headerOpts = { characterSpacing: 0.6, lineBreak: false };
  doc.text("#",          xs.rowNum,    y, { ...headerOpts, width: widths.rowNum });
  doc.text("SKU",        xs.sku,       y, { ...headerOpts, width: widths.sku });
  doc.text("DESCRIPTION",xs.desc,      y, { ...headerOpts, width: tableLayout().descWidth });
  doc.text("QTY",        xs.qty,       y, { ...headerOpts, width: widths.qty, align: "right" });
  doc.text("UNIT",       xs.unit,      y, { ...headerOpts, width: widths.unit });
  doc.text("UNIT PRICE", xs.unitPrice, y, { ...headerOpts, width: widths.unitPrice, align: "right" });
  doc.text("LINE TOTAL", xs.lineTotal, y, { ...headerOpts, width: widths.lineTotal, align: "right" });
  // 1pt bottom border below the header text
  const ruleY = y + 18;
  doc.save()
    .moveTo(MARGIN_X, ruleY).lineTo(PAGE_W - MARGIN_X, ruleY)
    .strokeColor(INK).lineWidth(1).stroke()
    .restore();
  return ruleY + 10; // y of first row
}

function drawTableRow(doc, line, rowNum, rowY) {
  const { xs, widths, descWidth } = tableLayout();
  const description = descriptionFor(line.sku);
  const unitLabel = formatUnit(unitFor(line.sku), line.qty);

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

  // Optional notes under the description (smaller, secondary color)
  if (line.notes) {
    const noteY = textY + descHeight + 2;
    doc.font("Helvetica").fontSize(9).fillColor(INK_SECONDARY);
    doc.text(line.notes, xs.desc, noteY, { width: descWidth });
  }

  // Qty — right-aligned, tabular feel via Helvetica + tnum-emulation
  doc.font("Helvetica").fontSize(11).fillColor(INK);
  doc.text(String(line.qty), xs.qty, textY, { ...opts, width: widths.qty, align: "right" });

  // Unit — secondary color
  doc.font("Helvetica").fontSize(11).fillColor(INK_SECONDARY);
  doc.text(unitLabel, xs.unit, textY, { ...opts, width: widths.unit });

  // Unit price — right-aligned
  doc.font("Helvetica").fontSize(11).fillColor(INK);
  doc.text(fmtCents(line.unitPriceCents), xs.unitPrice, textY, {
    ...opts, width: widths.unitPrice, align: "right"
  });

  // Line total — right-aligned
  doc.text(fmtCents(line.lineTotalCents), xs.lineTotal, textY, {
    ...opts, width: widths.lineTotal, align: "right"
  });

  // Hairline inter-row separator at the bottom of THIS row.
  const ruleY = rowY + rowHeight;
  doc.save()
    .moveTo(MARGIN_X, ruleY).lineTo(PAGE_W - MARGIN_X, ruleY)
    .strokeColor(BORDER_HAIR).lineWidth(0.5).stroke()
    .restore();

  return ruleY;
}

function drawTotals(doc, po, y) {
  const blockW = 220;
  const x = PAGE_W - MARGIN_X - blockW;

  // Top border
  doc.save()
    .moveTo(x, y).lineTo(x + blockW, y)
    .strokeColor(INK).lineWidth(1).stroke()
    .restore();

  const innerY = y + 12;

  doc.font("Helvetica").fontSize(12).fillColor(INK_SECONDARY);
  doc.text("Subtotal", x, innerY, { width: 100, lineBreak: false });
  doc.font(fontHeading(doc)).fillColor(INK);
  doc.text(fmtCents(po.subtotalCents), x + 100, innerY, {
    width: blockW - 100, align: "right", lineBreak: false
  });

  const hintY = innerY + 22;
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(INK_TERTIARY);
  doc.text("HST calculated at invoice", x, hintY, {
    width: blockW, align: "right", lineBreak: false
  });

  return hintY + 18;
}

function drawNotes(doc, po, y) {
  const text = `Please reference ${po.id} on invoice and packing slip. CSV of line items attached for system entry.${po.notes ? "\n\n" + po.notes : ""}`;
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
  const afterHeader = drawHeaderCondensed(doc, ctx.po, ctx.pageNum, ctx.totalPages);
  return drawTableHeader(doc, afterHeader + 24);
}

// ---- Main renderer ----------------------------------------------------

function generatePoPdf(po) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
        info: {
          Title: `PJL Purchase Order ${po.id}`,
          Author: company.NAME,
          Subject: `Purchase Order to ${po.supplierName || "supplier"}`,
          Keywords: `purchase order ${po.id} pjl land services`
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
      const items = Array.isArray(po.lineItems) ? po.lineItems : [];
      const totalPages = estimateTotalPages(doc, items);

      // ---- First page ------------------------------------------------
      drawTopRule(doc);
      const afterHeader = drawHeaderFull(doc, po);
      const afterParties = drawPartiesBlock(doc, po, afterHeader + 16);
      let rowY = drawTableHeader(doc, afterParties + 24);

      const ctx = { po, pageNum: 1, totalPages };

      // ---- Rows ------------------------------------------------------
      for (let i = 0; i < items.length; i++) {
        const line = items[i];
        // Estimate height before drawing so we can paginate ahead of
        // overflow.
        doc.font("Helvetica").fontSize(11);
        const description = descriptionFor(line.sku);
        const descHeight = doc.heightOfString(description, { width: tableLayout().descWidth });
        const rowHeight = Math.max(descHeight, 14) + 20;
        rowY = ensureRowFits(doc, rowY, rowHeight, ctx);
        rowY = drawTableRow(doc, line, i + 1, rowY);
      }

      // ---- Totals + Notes (last page only) ---------------------------
      // Totals are right-aligned and don't push much height. Notes are
      // a single short paragraph. Together they fit in ~120pt; if the
      // final-row Y has less remaining, push them onto a new page.
      const trailingHeight = 120;
      rowY = ensureRowFits(doc, rowY, trailingHeight, ctx);

      rowY = drawTotals(doc, po, rowY + 18);
      rowY = drawNotes(doc, po, rowY + 14);

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
// 120pt. The estimate runs on a throwaway doc so we don't disturb the
// real render's font/state.
function estimateTotalPages(realDoc, items) {
  const probe = new PDFDocument({ size: "LETTER", margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X } });
  const { descWidth } = tableLayout();
  const headerSpace = 60 /* top rule + sender */ + 70 /* doc identity */ + 16 + 70 /* parties */ + 24 + 28 /* table header */;
  let used = headerSpace;
  let pages = 1;
  for (let i = 0; i < items.length; i++) {
    probe.font("Helvetica").fontSize(11);
    const description = descriptionFor(items[i].sku);
    const descHeight = probe.heightOfString(description, { width: descWidth });
    const rowHeight = Math.max(descHeight, 14) + 20;
    if (used + rowHeight > PAGE_CONTENT_BOTTOM - MARGIN_TOP) {
      pages += 1;
      used = TOP_RULE_HEIGHT + 24 + 24 /* condensed header */ + 28 /* table header */;
    }
    used += rowHeight;
  }
  // Reserve final page for trailing totals + notes
  if (used + 120 > PAGE_CONTENT_BOTTOM - MARGIN_TOP) {
    pages += 1;
  }
  probe.end();
  // Drain the probe (it's a writable stream — leaving it open leaks memory).
  probe.on("data", () => {});
  return pages;
}

module.exports = { generatePoPdf };

// Purchase Order PDF generator. Branded one-page document the supplier
// receives as an email attachment. Mirrors quote-pdf.js layout for visual
// consistency. Returns a Promise<Buffer> so callers can both stream it
// (HTTP response) and attach it (email).
//
// Layout:
//   - Header: PJL green band with PO number + date + "PURCHASE ORDER"
//   - Ship-to (PJL) + Vendor (supplier) blocks side by side
//   - Line items table: SKU / description / qty / unit price / line total
//   - Subtotal block (no HST — supplier invoice will determine tax)
//   - Notes block (if PO has notes)
//   - Footer: PJL contact + URL

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

const PJL_GREEN = "#1B4D2E";
const PJL_TEXT = "#1F2A22";
const PJL_MUTED = "#6A6A60";

function fmtCents(c) {
  const v = (Number(c) || 0) / 100;
  return "$" + v.toFixed(2);
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}

// Lazy-load the catalog. The PDF needs descriptions but lib/po-pdf.js
// shouldn't tightly couple to server.js's PARTS global. Read parts.json
// once at first call; cache for subsequent calls in the same process.
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

// Returns Promise<Buffer> — buffers all PDF chunks so the caller can do
// either pipe-to-response or email-attach without juggling streams.
function generatePoPdf(po) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: `PJL Purchase Order ${po.id}`,
          Author: "PJL Land Services",
          Subject: `Purchase Order to ${po.supplierName || "supplier"}`,
          Keywords: `purchase order ${po.id} pjl land services`
        }
      });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ---- Header band ---------------------------------------------------
      doc.rect(0, 0, doc.page.width, 80).fill(PJL_GREEN);
      doc.fillColor("#EAF3DE")
        .fontSize(10)
        .text("PJL LAND SERVICES", 60, 24, { characterSpacing: 1.5 });
      doc.fillColor("#fff")
        .fontSize(22)
        .font("Helvetica-Bold")
        .text(`Purchase Order ${po.id}`, 60, 38);
      doc.font("Helvetica").fontSize(10).fillColor("#C9DDD0")
        .text(`Issued ${fmtDate(po.createdAt)}${po.sentAt ? ` · Sent ${fmtDate(po.sentAt)}` : ""}`,
          60, 62);

      // ---- Address blocks (Ship-to + Vendor) ----------------------------
      let blockY = 110;
      const colLeftX = 60;
      const colRightX = 320;
      const colWidth = 220;

      doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
        .text("SHIP TO", colLeftX, blockY, { characterSpacing: 1 });
      doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(11);
      doc.text("PJL Land Services", colLeftX, blockY + 14);
      doc.fontSize(10).fillColor(PJL_MUTED);
      doc.text("Newmarket, Ontario", colLeftX, doc.y);
      doc.text("(905) 960-0181", colLeftX, doc.y);
      doc.text("orders@pjllandservices.com", colLeftX, doc.y);

      doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
        .text("VENDOR", colRightX, blockY, { characterSpacing: 1 });
      doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(11);
      doc.text(po.supplierName || "(unknown supplier)", colRightX, blockY + 14, { width: colWidth });
      doc.fontSize(10).fillColor(PJL_MUTED);
      if (po.supplierContactName) doc.text(`Attn: ${po.supplierContactName}`, colRightX, doc.y, { width: colWidth });
      if (po.supplierAddress) doc.text(po.supplierAddress, colRightX, doc.y, { width: colWidth });
      if (po.supplierEmail) doc.text(po.supplierEmail, colRightX, doc.y, { width: colWidth });
      if (po.supplierPhone) doc.text(po.supplierPhone, colRightX, doc.y, { width: colWidth });

      // Move past whichever block ended lower.
      doc.y = Math.max(doc.y, blockY + 90);
      doc.moveDown(1);

      // ---- Line items table ---------------------------------------------
      const tableTop = doc.y + 8;
      const colSku = 60;
      const colDesc = 130;
      const colQty = 360;
      const colUnitPrice = 410;
      const colTotal = 480;
      const tableRight = doc.page.width - 60;

      doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold");
      doc.text("SKU", colSku, tableTop, { characterSpacing: 1 });
      doc.text("DESCRIPTION", colDesc, tableTop, { characterSpacing: 1 });
      doc.text("QTY", colQty, tableTop, { width: 40, align: "right", characterSpacing: 1 });
      doc.text("UNIT", colUnitPrice, tableTop, { width: 60, align: "right", characterSpacing: 1 });
      doc.text("LINE TOTAL", colTotal, tableTop, { width: 70, align: "right", characterSpacing: 1 });
      doc.moveTo(60, tableTop + 14).lineTo(tableRight, tableTop + 14).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();

      let rowY = tableTop + 22;
      doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
      for (const line of po.lineItems || []) {
        const desc = descriptionFor(line.sku);
        const unit = unitFor(line.sku);
        const qtyDisplay = `${line.qty} ${unit}${line.qty !== 1 ? "s" : ""}`;
        // SKU column (mono-ish, smaller)
        doc.font("Courier").fontSize(9).fillColor(PJL_TEXT);
        doc.text(line.sku || "—", colSku, rowY, { width: 60 });
        doc.font("Helvetica").fontSize(10);
        doc.text(desc, colDesc, rowY, { width: 220 });
        const descEndY = doc.y;
        if (line.notes) {
          doc.fontSize(9).fillColor(PJL_MUTED).text(line.notes, colDesc, descEndY + 1, { width: 220 });
          doc.fontSize(10).fillColor(PJL_TEXT);
        }
        doc.text(qtyDisplay, colQty, rowY, { width: 40, align: "right" });
        doc.text(fmtCents(line.unitPriceCents), colUnitPrice, rowY, { width: 60, align: "right" });
        doc.text(fmtCents(line.lineTotalCents), colTotal, rowY, { width: 70, align: "right" });
        rowY = doc.y + 8;
      }

      // ---- Subtotal -----------------------------------------------------
      doc.moveTo(colUnitPrice, rowY).lineTo(tableRight, rowY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
      rowY += 8;
      doc.fillColor(PJL_GREEN).font("Helvetica-Bold").fontSize(13);
      doc.text("Subtotal", colUnitPrice, rowY, { width: 60, align: "right" });
      doc.text(fmtCents(po.subtotalCents), colTotal, rowY, { width: 70, align: "right" });
      rowY += 22;
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
      doc.text("Tax not included — please apply per your invoice. Confirm receipt + ETA when convenient.",
        60, rowY, { width: doc.page.width - 120 });
      rowY = doc.y + 18;

      // ---- Notes block --------------------------------------------------
      if (po.notes) {
        doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold")
          .text("NOTES", 60, rowY, { characterSpacing: 1 });
        doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(10)
          .text(po.notes, 60, doc.y + 4, { width: doc.page.width - 120 });
        rowY = doc.y + 12;
      }

      // ---- Footer --------------------------------------------------------
      const footerY = doc.page.height - 50;
      doc.moveTo(60, footerY).lineTo(doc.page.width - 60, footerY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
      doc.text("PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com",
        60, footerY + 8, { width: doc.page.width - 120, align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generatePoPdf };

// Quote PDF generator (spec §4.1 formal_quote PDF). Branded one-page
// document the customer can save / print / sign. Uses pdfkit — pure JS,
// no native binaries, ~500KB install. Generates a stream the caller
// pipes into the HTTP response or attaches to email.
//
// Layout:
//   - Header: PJL green band with logo text + quote number + date
//   - Bill-to block: customer name / address / email / phone
//   - Scope description (if formal quote with rich scope text)
//   - Line items table: description / qty / unit / total
//   - Totals: subtotal / HST 13% / total CAD
//   - Terms block: standard PJL terms (warranty, payment, scope changes)
//   - Footer: PJL contact + URL
//   - Signature block (always shown, "Customer signature" with line —
//     printed copy can be ink-signed; portal-signed quotes get the
//     image embedded post-sign)

const PDFDocument = require("pdfkit");

const PJL_GREEN = "#1B4D2E";
const PJL_AMBER = "#E07B24";
const PJL_TEXT = "#1F2A22";
const PJL_MUTED = "#6A6A60";
const HST_RATE = 0.13;

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

  // ---- Header band ---------------------------------------------------
  doc.rect(0, 0, doc.page.width, 80).fill(PJL_GREEN);
  doc.fillColor("#EAF3DE")
    .fontSize(10)
    .text("PJL LAND SERVICES", 60, 24, { characterSpacing: 1.5 });
  doc.fillColor("#fff")
    .fontSize(22)
    .font("Helvetica-Bold")
    .text(`Quote ${quote.id}`, 60, 38);
  doc.font("Helvetica").fontSize(10).fillColor("#C9DDD0")
    .text(`Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? ` · Valid through ${fmtDate(quote.validUntil)}` : ""}`,
      60, 62);

  doc.moveDown(2);
  doc.y = 110;

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
  const tableTop = doc.y + 6;
  const colDesc = 60;
  const colQty = 320;
  const colUnit = 380;
  const colTotal = 470;

  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold");
  doc.text("DESCRIPTION", colDesc, tableTop, { characterSpacing: 1 });
  doc.text("QTY", colQty, tableTop, { width: 50, align: "right", characterSpacing: 1 });
  doc.text("UNIT", colUnit, tableTop, { width: 80, align: "right", characterSpacing: 1 });
  doc.text("LINE TOTAL", colTotal, tableTop, { width: 80, align: "right", characterSpacing: 1 });
  doc.moveTo(60, tableTop + 14).lineTo(doc.page.width - 60, tableTop + 14).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
  for (const line of quote.lineItems || []) {
    const label = line.label || line.key || "Line";
    const qty = Number(line.qty) || 1;
    const unitPrice = Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice)
      : (Number.isFinite(Number(line.price)) ? Number(line.price)
        : Number(line.originalPrice) || 0);
    const lineTotal = Number.isFinite(Number(line.lineTotal)) ? Number(line.lineTotal) : (unitPrice * qty);
    doc.text(label, colDesc, rowY, { width: 250 });
    if (line.note) {
      doc.fontSize(9).fillColor(PJL_MUTED).text(line.note, colDesc, doc.y + 1, { width: 250 });
      doc.fontSize(10).fillColor(PJL_TEXT);
    }
    doc.text(String(qty), colQty, rowY, { width: 50, align: "right" });
    doc.text(fmt(unitPrice), colUnit, rowY, { width: 80, align: "right" });
    doc.text(fmt(lineTotal), colTotal, rowY, { width: 80, align: "right" });
    rowY = doc.y + 8;
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
  const footerY = doc.page.height - 50;
  doc.moveTo(60, footerY).lineTo(doc.page.width - 60, footerY).strokeColor(PJL_MUTED).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com",
    60, footerY + 8, { width: doc.page.width - 120, align: "center" });

  doc.end();
  return doc;
}

module.exports = { generateQuotePdf };

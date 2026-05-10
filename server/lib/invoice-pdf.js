// Invoice PDF generator. Branded one-page (multi-page on overflow)
// document the customer receives by email and can also open / download
// from the admin invoice editor. Mirrors quote-pdf.js + po-pdf.js
// conventions but follows the layout in _design/invoice-pdf-preview.html
// (v4 — green-text title on white, green-tint customer band, hairline
// line items, bottom split with totals + status pill).
//
// Returns Promise<Buffer> so the same call site can both stream the PDF
// to an HTTP response AND attach it to an email (PR 2). Mirrors po-pdf.js
// rather than quote-pdf.js for that reason.
//
// Brand fidelity:
//   - Headings (title, totals, section labels, status) use Barlow
//     Condensed Bold (server/assets/fonts/BarlowCondensed-Bold.ttf).
//   - Body text uses Helvetica (pdfkit built-in) — visually
//     indistinguishable from DM Sans at small print sizes and saves
//     shipping a second TTF.
//
// Logo: pdfkit's doc.image() doesn't support SVG natively. Existing
// quote-pdf.js + po-pdf.js use a text wordmark in their headers; this
// file follows that convention. The dark logo SVG is committed at
// server/assets/logo-dark.svg for use in the HTML email body in PR 2.

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

// ---- Brand palette (matches _design/invoice-pdf-preview.html) -------
const GREEN = "#1B4D2E";
const GREEN_TINT = "#F4F8EE";
const TEXT = "#1A1A1A";
const TEXT_MUTED = "#7A7A72";
const BORDER = "#E2E0D4";
const HAIRLINE = "#EFEDE3";
const AMBER = "#E07B24";
const DANGER = "#B23A3A";
const SUCCESS = "#2F7A4A";

const HST_RATE = 0.13;

// ---- Page geometry --------------------------------------------------
// US Letter @ 72pt/in: 612 × 792.
const PAGE_W = 612;
const MARGIN_X = 40;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

// ---- Font registration ----------------------------------------------
// Load the TTF synchronously at module-init time (same pattern as
// po-pdf.js's parts.json sync load). Keeps generateInvoicePdf() purely
// async without needing a top-level await.
const BARLOW_BOLD_PATH = path.resolve(
  __dirname, "..", "assets", "fonts", "BarlowCondensed-Bold.ttf"
);
let _barlowBuf = null;
function barlowBuffer() {
  if (_barlowBuf) return _barlowBuf;
  try { _barlowBuf = fsSync.readFileSync(BARLOW_BOLD_PATH); }
  catch { _barlowBuf = false; }
  return _barlowBuf;
}

// Logo PNG (rasterized once via sharp from server/assets/logo-dark.svg).
// pdfkit's doc.image() takes PNG/JPEG buffers — SVG isn't supported
// without an extra lib, so we ship the rasterized PNG instead.
const LOGO_PNG_PATH = path.resolve(__dirname, "..", "assets", "logo-dark.png");
let _logoBuf = null;
function logoBuffer() {
  if (_logoBuf !== null) return _logoBuf;
  try { _logoBuf = fsSync.readFileSync(LOGO_PNG_PATH); }
  catch { _logoBuf = false; }
  return _logoBuf;
}

// Register the font on a doc. Falls back to Helvetica-Bold if the TTF
// is missing so the generator still renders something rather than
// throwing — an unbranded PDF beats a 500.
function registerFonts(doc) {
  const buf = barlowBuffer();
  if (buf) doc.registerFont("Barlow-Bold", buf);
}
function fontHeading(doc) { return barlowBuffer() ? "Barlow-Bold" : "Helvetica-Bold"; }
function fontBody() { return "Helvetica"; }
function fontBodyBold() { return "Helvetica-Bold"; }

// ---- Currency / date helpers ----------------------------------------
const CAD = new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD"
});
function fmtMoney(n) { return CAD.format(Number(n) || 0); }

// ISO date (YYYY-MM-DD) in America/Toronto. Server-wide TZ is already
// forced in server.js but be explicit here so this lib stands on its
// own if ever re-used.
function fmtDate(input) {
  if (!input) return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
}

// ---- Invoice shape adapter ------------------------------------------
// The preview's data-binding table assumes a richer invoice shape than
// server/lib/invoices.js currently writes. Rather than migrate the
// stored schema in PR 1, derive the structured shape on the fly with
// sensible defaults. PR 2/3 can promote any of these fields into the
// stored record if/when other surfaces need them.
function normalize(raw) {
  const inv = raw || {};
  const billTo = inv.bill_to || {};
  const shipTo = inv.ship_to || null;

  // Bill-to: pull from explicit bill_to.* first, fall back to the flat
  // legacy fields the cascade currently writes.
  const billName = billTo.name || inv.customerName || "";
  const billCompany = billTo.company || "";
  const billPhone = billTo.phone || inv.customerPhone || "";
  const billEmail = billTo.email || inv.customerEmail || "";
  // Address: support either { addr1, city, province, postalCode } OR a
  // single legacy address string. Render whichever is non-empty.
  const billAddrLines = (() => {
    if (billTo.addr1 || billTo.city || billTo.postalCode) {
      const lines = [];
      if (billTo.addr1) lines.push(billTo.addr1);
      if (billTo.addr2) lines.push(billTo.addr2);
      const tail = [billTo.city, billTo.province, billTo.postalCode]
        .filter(Boolean).join(billTo.postalCode ? "  " : ", ");
      if (tail) lines.push(tail);
      return lines;
    }
    const addr = (inv.address || "").trim();
    return addr ? addr.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  })();

  // Ship-to: only render when present AND not identical to bill-to.
  const ship = (() => {
    if (!shipTo) return null;
    const sName = shipTo.name || "";
    const sLines = (() => {
      const lines = [];
      if (shipTo.addr1) lines.push(shipTo.addr1);
      if (shipTo.addr2) lines.push(shipTo.addr2);
      const tail = [shipTo.city, shipTo.province, shipTo.postalCode]
        .filter(Boolean).join(shipTo.postalCode ? "  " : ", ");
      if (tail) lines.push(tail);
      return lines;
    })();
    if (!sName && sLines.length === 0) return null;
    // Drop ship_to when it matches bill_to verbatim — single-column UI.
    if (sName === billName && sLines.join("\n") === billAddrLines.join("\n")) return null;
    return { name: sName, addrLines: sLines };
  })();

  // Line items: support both new and legacy shapes.
  const lineItems = (inv.lineItems || []).map((li) => ({
    name: li.name || li.label || li.key || "Line",
    description: li.description || li.note || "",
    quantity: Number.isFinite(Number(li.quantity)) ? Number(li.quantity)
      : (Number(li.qty) || 1),
    rate: Number.isFinite(Number(li.rate)) ? Number(li.rate)
      : (Number.isFinite(Number(li.unitPrice)) ? Number(li.unitPrice)
        : Number(li.price) || 0),
    amount: Number.isFinite(Number(li.amount)) ? Number(li.amount)
      : (Number.isFinite(Number(li.lineTotal)) ? Number(li.lineTotal)
        : (Number(li.unitPrice) || 0) * (Number(li.qty) || 1))
  }));

  // Totals: prefer stored, recompute if missing.
  const subtotal = Number.isFinite(Number(inv.subtotal)) ? Number(inv.subtotal)
    : lineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const taxRate = Number.isFinite(Number(inv.taxRate)) ? Number(inv.taxRate) : HST_RATE;
  const taxAmount = Number.isFinite(Number(inv.taxAmount)) ? Number(inv.taxAmount)
    : (Number.isFinite(Number(inv.hst)) ? Number(inv.hst)
      : Math.round(subtotal * taxRate * 100) / 100);
  const total = Number.isFinite(Number(inv.total)) ? Number(inv.total)
    : Math.round((subtotal + taxAmount) * 100) / 100;

  // Dates
  const issuedAt = inv.issuedAt || inv.createdAt || new Date().toISOString();
  // Default "Due on completion" → due date equals issued date.
  const dueAt = inv.dueAt || issuedAt;

  // Status
  const status = inv.status || "draft";

  // Note + terms
  const noteToCustomer = inv.noteToCustomer
    || "Thank you for choosing PJL Land Services. Payment due on completion unless otherwise arranged. "
    + "Warranty: 1 year on repairs, 3 years on full installs.";
  const terms = inv.terms || "Due on completion";

  return {
    id: inv.id || "",
    status,
    issuedAt,
    dueAt,
    sentAt: inv.sentAt || null,
    paidAt: inv.paidAt || null,
    billTo: {
      name: billName,
      company: billCompany,
      addrLines: billAddrLines,
      phone: billPhone,
      email: billEmail
    },
    shipTo: ship,
    terms,
    lineItems,
    subtotal,
    taxRate,
    taxAmount,
    total,
    noteToCustomer,
    portalToken: inv.portalToken || null,
    eTransferEmail: inv.eTransferEmail || "info@pjllandservices.com"
  };
}

// ---- Status pill styling --------------------------------------------
// Resolve the visible status label + colour. "Overdue" is derived from
// status=sent + today > dueAt — never stored.
function resolveStatus(inv) {
  const dueAt = new Date(inv.dueAt);
  const isOverdue = inv.status === "sent"
    && dueAt instanceof Date && !Number.isNaN(dueAt.getTime())
    && Date.now() > dueAt.getTime();
  if (isOverdue) return { label: "Overdue", color: DANGER, dateIso: inv.dueAt };
  if (inv.status === "paid")  return { label: "Paid",  color: SUCCESS, dateIso: inv.paidAt || inv.sentAt || inv.dueAt };
  if (inv.status === "sent")  return { label: "Sent",  color: GREEN,   dateIso: inv.sentAt || inv.issuedAt };
  if (inv.status === "void")  return { label: "Void",  color: TEXT_MUTED, dateIso: inv.issuedAt };
  return { label: "Draft", color: TEXT_MUTED, dateIso: inv.issuedAt };
}

// ---- Renderer -------------------------------------------------------

function generateInvoicePdf(rawInvoice) {
  return new Promise((resolve, reject) => {
    try {
      const inv = normalize(rawInvoice);

      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: MARGIN_X, bottom: MARGIN_X, left: MARGIN_X, right: MARGIN_X },
        info: {
          Title: `PJL Invoice ${inv.id}`,
          Author: "PJL Land Services",
          Subject: `Invoice ${inv.id}`,
          Keywords: `invoice ${inv.id} pjl land services`
        }
      });
      registerFonts(doc);

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      drawHeader(doc, inv);
      drawCustomerBand(doc, inv);
      drawDetailsStrip(doc, inv);
      drawLineItems(doc, inv);
      drawBottomSplit(doc, inv);
      drawFooter(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ---- Header ---------------------------------------------------------
// Green "INVOICE" title, company info underneath, dark text wordmark
// on the right (where the preview's <img> lived). White background — no
// full-bleed band.
function drawHeader(doc, inv) {
  const top = 40;
  const leftX = MARGIN_X;
  const rightCol = PAGE_W - MARGIN_X - 200;

  // "INVOICE"
  doc.font(fontHeading(doc)).fontSize(30).fillColor(GREEN);
  doc.text("INVOICE", leftX, top, {
    characterSpacing: 1.5,
    width: CONTENT_W - 200,
    lineGap: 0
  });

  // Company info block — three lines.
  doc.font(fontBodyBold()).fontSize(10).fillColor(TEXT);
  let y = top + 38;
  doc.text("PJL Land Services", leftX, y);
  y = doc.y + 1;
  doc.font(fontBody()).fontSize(9).fillColor(TEXT_MUTED);
  doc.text("1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5", leftX, y);
  y = doc.y;
  doc.text("info@pjllandservices.com  ·  (905) 960-0181  ·  pjllandservices.com", leftX, y);
  y = doc.y + 2;
  doc.fontSize(8).fillColor(TEXT_MUTED);
  doc.text("GST/HST Reg. No. 757080940 RT0001", leftX, y, { characterSpacing: 0.3 });

  // Right side — actual PJL logo PNG (rasterized from logo-dark.svg
  // with .trim() so the PNG bounds equal the visible logo content;
  // no transparent border padding). Width 160pt at 1.74:1 aspect
  // renders the logo at ~160×92pt — matches the size that visually
  // balances the title block on the left without dominating the page.
  // Right edge pinned to PAGE_W - MARGIN_X (= body-content right
  // margin) so it lines up with the customer band, totals column,
  // and footer rule.
  const logo = logoBuffer();
  const LOGO_W = 160;
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
  } else {
    doc.font(fontHeading(doc)).fontSize(22).fillColor(GREEN);
    doc.text("PJL", rightCol, top + 6, {
      width: 200, align: "right", characterSpacing: 1
    });
    doc.fontSize(11).fillColor(GREEN);
    doc.text("LAND SERVICES", rightCol, top + 32, {
      width: 200, align: "right", characterSpacing: 3
    });
  }

  // Reset the cursor below the header content. Left text bottom is
  // ~y=124 (HST line). Logo bottom is ~y=120 (top - 12 + ~92 height).
  // Set to 124 so whichever side is taller, the next section starts
  // immediately after — drawCustomerBand adds its own 4pt top gap.
  doc.y = Math.max(doc.y, 124);
  doc.x = MARGIN_X;
}

// ---- Customer band --------------------------------------------------
// Green-tint background, single or two columns. Optional B2B company
// header on top.
function drawCustomerBand(doc, inv) {
  const padX = MARGIN_X;
  const padY = 14;
  // Tight gap above the band (4pt). drawHeader already sets doc.y to
  // sit just below the header text, so this is just visual breathing
  // room — not a layout buffer.
  const startY = doc.y + 4;
  const billLines = inv.billTo.addrLines || [];
  const shipLines = inv.shipTo?.addrLines || [];
  const hasShip = !!inv.shipTo;
  const hasCompany = !!inv.billTo.company;

  // Estimate band height. Each address line ≈ 13pt; label + name ≈ 26pt.
  const bodyLines = Math.max(billLines.length, shipLines.length);
  const contactLine = (inv.billTo.phone || inv.billTo.email) ? 13 : 0;
  let bandH = padY * 2 + 22 /* label + name */ + bodyLines * 13 + contactLine;
  if (hasCompany) bandH += 20;
  if (bandH < 70) bandH = 70;

  // Background fill (full-width band).
  doc.save();
  doc.rect(0, startY, PAGE_W, bandH).fill(GREEN_TINT);
  doc.restore();
  // Hairline rules top + bottom
  doc.strokeColor(HAIRLINE).lineWidth(0.5);
  doc.moveTo(0, startY).lineTo(PAGE_W, startY).stroke();
  doc.moveTo(0, startY + bandH).lineTo(PAGE_W, startY + bandH).stroke();

  let y = startY + padY;

  // Optional B2B company header.
  if (hasCompany) {
    doc.font(fontHeading(doc)).fontSize(14).fillColor(GREEN);
    doc.text(inv.billTo.company, padX, y, { width: PAGE_W - padX * 2 });
    y = doc.y + 8;
  }

  const colW = hasShip
    ? (PAGE_W - padX * 2 - 40) / 2
    : (PAGE_W - padX * 2);
  const leftX = padX;
  const rightX = padX + colW + 40;

  // Bill-to column
  doc.font(fontBodyBold()).fontSize(8).fillColor(TEXT_MUTED);
  doc.text("BILL TO", leftX, y, { characterSpacing: 1.4 });
  let billY = doc.y + 4;
  doc.font(fontBodyBold()).fontSize(11).fillColor(TEXT);
  doc.text(inv.billTo.name || "—", leftX, billY, { width: colW });
  billY = doc.y + 1;
  doc.font(fontBody()).fontSize(10).fillColor(TEXT);
  for (const line of billLines) {
    doc.text(line, leftX, billY, { width: colW });
    billY = doc.y;
  }
  if (inv.billTo.phone || inv.billTo.email) {
    doc.fontSize(9).fillColor(TEXT_MUTED);
    doc.text([inv.billTo.phone, inv.billTo.email].filter(Boolean).join(" · "),
      leftX, billY + 2, { width: colW });
    billY = doc.y;
  }

  // Ship-to column (B2B only)
  if (hasShip) {
    doc.font(fontBodyBold()).fontSize(8).fillColor(TEXT_MUTED);
    doc.text("SHIP TO", rightX, y, { characterSpacing: 1.4 });
    let shipY = doc.y + 4;
    doc.font(fontBodyBold()).fontSize(11).fillColor(TEXT);
    doc.text(inv.shipTo.name || "—", rightX, shipY, { width: colW });
    shipY = doc.y + 1;
    doc.font(fontBody()).fontSize(10).fillColor(TEXT);
    for (const line of shipLines) {
      doc.text(line, rightX, shipY, { width: colW });
      shipY = doc.y;
    }
  }

  // Move past the band.
  doc.y = startY + bandH + 4;
  doc.x = MARGIN_X;
}

// ---- Details strip --------------------------------------------------
// Four columns: Invoice no., Terms, Invoice date, Due date.
function drawDetailsStrip(doc, inv) {
  const startY = doc.y + 6;
  const pad = 12;
  const cols = 4;
  const colW = (PAGE_W - MARGIN_X * 2) / cols;

  function cell(i, label, value, strong = false) {
    const x = MARGIN_X + i * colW;
    doc.font(fontBodyBold()).fontSize(8).fillColor(TEXT_MUTED);
    doc.text(label, x, startY, { characterSpacing: 1.4, width: colW - 8 });
    doc.font(strong ? fontBodyBold() : fontBody()).fontSize(11).fillColor(TEXT);
    doc.text(value, x, doc.y + 4, { width: colW - 8, features: ["tnum"] });
  }

  cell(0, "INVOICE NO.", inv.id || "—", true);
  cell(1, "TERMS", inv.terms || "—");
  cell(2, "INVOICE DATE", fmtDate(inv.issuedAt));
  cell(3, "DUE DATE", fmtDate(inv.dueAt));

  doc.y = Math.max(doc.y, startY + 36);
  // Hairline below the strip
  doc.strokeColor(HAIRLINE).lineWidth(0.5);
  doc.moveTo(MARGIN_X, doc.y + pad - 6).lineTo(PAGE_W - MARGIN_X, doc.y + pad - 6).stroke();
  doc.y += pad;
  doc.x = MARGIN_X;
}

// ---- Line items -----------------------------------------------------
// Hairline-ruled rows. Header row underlined with a 1.5pt rule (matches
// preview's `.lines__head { border-bottom: 1.5px solid var(--text); }`).
// Auto page break: pdfkit handles overflow; we just check before each
// row and let it advance.
function drawLineItems(doc, inv) {
  const startY = doc.y + 6;
  const colName = MARGIN_X;
  const colQty = PAGE_W - MARGIN_X - 220;
  const colRate = PAGE_W - MARGIN_X - 150;
  const colAmt = PAGE_W - MARGIN_X - 80;
  const nameW = colQty - colName - 14;

  // Header row
  doc.font(fontBodyBold()).fontSize(8).fillColor(TEXT_MUTED);
  doc.text("PRODUCT OR SERVICE", colName, startY, { characterSpacing: 1.4 });
  doc.text("QTY",    colQty,  startY, { width: 60, align: "right", characterSpacing: 1.4 });
  doc.text("RATE",   colRate, startY, { width: 70, align: "right", characterSpacing: 1.4 });
  doc.text("AMOUNT", colAmt,  startY, { width: 80, align: "right", characterSpacing: 1.4 });
  // Underline
  doc.strokeColor(TEXT).lineWidth(1.4);
  doc.moveTo(MARGIN_X, startY + 16).lineTo(PAGE_W - MARGIN_X, startY + 16).stroke();

  let y = startY + 24;
  doc.font(fontBody()).fontSize(10).fillColor(TEXT);

  if (inv.lineItems.length === 0) {
    doc.font(fontBody()).fontSize(10).fillColor(TEXT_MUTED);
    doc.text("No line items recorded.", colName, y, { width: nameW, oblique: true });
    y = doc.y + 8;
  }

  for (const li of inv.lineItems) {
    // Page break safety — leave room for the bottom split.
    if (y > 600) {
      doc.addPage();
      y = MARGIN_X;
    }
    doc.font(fontBody()).fontSize(11).fillColor(TEXT);
    doc.text(li.name, colName, y, { width: nameW });
    let nameEndY = doc.y;
    if (li.description) {
      doc.font(fontBody()).fontSize(9).fillColor(TEXT_MUTED);
      doc.text(li.description, colName, nameEndY + 1, { width: nameW });
      nameEndY = doc.y;
    }
    // Numeric columns sit on the FIRST line of the row, even when the
    // description wraps below — feels right when scanning the column.
    doc.font(fontBody()).fontSize(11).fillColor(TEXT);
    doc.text(String(li.quantity), colQty, y, { width: 60, align: "right", features: ["tnum"] });
    doc.text(fmtMoney(li.rate),   colRate, y, { width: 70, align: "right", features: ["tnum"] });
    doc.text(fmtMoney(li.amount), colAmt,  y, { width: 80, align: "right", features: ["tnum"] });

    const rowEndY = Math.max(nameEndY, y + 14);
    // Hairline rule
    doc.strokeColor(HAIRLINE).lineWidth(0.5);
    doc.moveTo(MARGIN_X, rowEndY + 6).lineTo(PAGE_W - MARGIN_X, rowEndY + 6).stroke();
    y = rowEndY + 14;
  }

  doc.y = y + 2;
  doc.x = MARGIN_X;
}

// ---- Bottom split: Ways to pay (left) + Totals + Status (right) -----
function drawBottomSplit(doc, inv) {
  // If we're too far down the page to fit the bottom split, push it to
  // a new page so it always sits as one block.
  if (doc.y > 640) {
    doc.addPage();
    doc.y = MARGIN_X;
  }
  const startY = doc.y + 14;
  const leftX = MARGIN_X;
  const rightX = PAGE_W - MARGIN_X - 200;
  const leftW = rightX - leftX - 20;
  const rightW = 200;

  // ----- Left side: Ways to pay -----
  doc.font(fontHeading(doc)).fontSize(13).fillColor(GREEN);
  doc.text("Ways to pay", leftX, startY);
  let ly = doc.y + 4;

  doc.font(fontBody()).fontSize(10).fillColor(TEXT);
  doc.text("All major credit cards accepted via the secure payment link below.",
    leftX, ly, { width: leftW });
  ly = doc.y + 4;

  doc.font(fontBodyBold()).fontSize(10).fillColor(TEXT);
  doc.text("E-Transfer: ", leftX, ly, { continued: true });
  doc.font(fontBody()).fillColor(TEXT);
  doc.text(inv.eTransferEmail, { width: leftW });
  ly = doc.y + 14;

  // Note to customer
  doc.font(fontHeading(doc)).fontSize(13).fillColor(GREEN);
  doc.text("Note to customer", leftX, ly);
  ly = doc.y + 4;
  doc.font(fontBody()).fontSize(9.5).fillColor(TEXT_MUTED);
  doc.text(inv.noteToCustomer, leftX, ly, { width: leftW, lineGap: 1 });

  // ----- Right side: Totals + Status -----
  let ry = startY;
  function totalsRow(label, value, opts = {}) {
    const isTotal = !!opts.isTotal;
    if (isTotal) {
      // 1.5pt rule above the total
      doc.strokeColor(TEXT).lineWidth(1.5);
      doc.moveTo(rightX, ry + 4).lineTo(rightX + rightW, ry + 4).stroke();
      ry += 14;
      doc.font(fontHeading(doc)).fontSize(20).fillColor(GREEN);
      doc.text(label, rightX, ry, { width: 90 });
      doc.text(value, rightX + 90, ry, {
        width: rightW - 90, align: "right", features: ["tnum"]
      });
      ry = doc.y + 4;
    } else {
      doc.font(fontBody()).fontSize(10).fillColor(TEXT_MUTED);
      doc.text(label, rightX, ry, { width: 110 });
      doc.font(fontBody()).fontSize(10).fillColor(TEXT);
      doc.text(value, rightX + 110, ry, {
        width: rightW - 110, align: "right", features: ["tnum"]
      });
      ry = doc.y + 4;
      // Hairline rule below each non-total row
      doc.strokeColor(HAIRLINE).lineWidth(0.5);
      doc.moveTo(rightX, ry).lineTo(rightX + rightW, ry).stroke();
      ry += 4;
    }
  }
  totalsRow("Subtotal", fmtMoney(inv.subtotal));
  totalsRow(`HST (ON) @ ${(inv.taxRate * 100).toFixed(0)}%`, fmtMoney(inv.taxAmount));
  totalsRow("Total", fmtMoney(inv.total), { isTotal: true });

  // Status pill
  ry += 8;
  doc.strokeColor(HAIRLINE).lineWidth(0.5);
  doc.moveTo(rightX, ry).lineTo(rightX + rightW, ry).stroke();
  ry += 8;
  const status = resolveStatus(inv);
  doc.font(fontHeading(doc)).fontSize(15).fillColor(status.color);
  doc.text(status.label.toUpperCase(), rightX, ry, {
    characterSpacing: 1.2, width: 90
  });
  doc.font(fontBody()).fontSize(9).fillColor(TEXT_MUTED);
  doc.text(fmtDate(status.dateIso), rightX + 90, ry + 2, {
    width: rightW - 90, align: "right", features: ["tnum"]
  });

  // Move cursor below whichever column ended lower.
  doc.y = Math.max(doc.y, ry + 24);
  doc.x = MARGIN_X;
}

// ---- Footer ---------------------------------------------------------
// Centred contact line at the bottom of every page. We position with
// `lineBreak: false` so pdfkit doesn't try to advance the cursor past
// the bottom margin (which would trigger a spurious extra blank page).
// Drawn manually at the end of the doc — multi-page invoices repeat
// the footer via a `pageAdded` listener registered before content draws.
function drawFooter(doc) {
  // Drop the bottom margin to 0 just for the footer write — pdfkit's
  // LineWrapper checks margin.bottom even when lineBreak: false, and a
  // text() call positioned within the bottom margin will trigger a
  // spurious page break otherwise. Restored after the write.
  const restoreBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 30;
  doc.save();
  doc.strokeColor(HAIRLINE).lineWidth(0.5);
  doc.moveTo(MARGIN_X, y - 10).lineTo(PAGE_W - MARGIN_X, y - 10).stroke();
  doc.font(fontBody()).fontSize(8).fillColor(TEXT_MUTED);
  doc.text(
    "PJL Land Services  ·  GST/HST 757080940 RT0001  ·  info@pjllandservices.com  ·  (905) 960-0181",
    MARGIN_X, y, {
      width: CONTENT_W,
      align: "center",
      characterSpacing: 0.3,
      lineBreak: false
    });
  doc.restore();
  doc.page.margins.bottom = restoreBottom;
}

module.exports = { generateInvoicePdf };

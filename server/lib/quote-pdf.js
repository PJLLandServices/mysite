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

  // ---- Header (matches invoice-pdf.js) -------------------------------
  // Green "QUOTE" title on white at the left, real PJL logo right-aligned
  // to the body content margin (consistent with the customer band, line
  // items, totals, and footer rule on the rest of the page). No more
  // full-bleed green band — this is the same look the invoice PDF ships.
  const PAGE_W = doc.page.width;
  const MARGIN_X = 60; // quote-pdf has historically used 60 (vs invoice's 40)
  const top = 40;
  const leftX = MARGIN_X;
  const LOGO_W = 160;

  doc.font(fontHeading(doc)).fontSize(30).fillColor(PJL_GREEN);
  doc.text("QUOTE", leftX, top, {
    characterSpacing: 1.5,
    width: PAGE_W - MARGIN_X * 2 - LOGO_W - 16,
    lineGap: 0
  });

  // Company info block — three lines.
  doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
  let y = top + 38;
  doc.text("PJL Land Services", leftX, y);
  y = doc.y + 1;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text("1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5", leftX, y);
  y = doc.y;
  doc.text("info@pjllandservices.com  ·  (905) 960-0181  ·  pjllandservices.com", leftX, y);
  y = doc.y + 2;
  doc.fontSize(8).fillColor(PJL_MUTED);
  doc.text(`Quote ${quote.id} · Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? ` · Valid through ${fmtDate(quote.validUntil)}` : ""}`,
    leftX, y, { characterSpacing: 0.3 });

  // Right side — actual PJL logo PNG (rasterized from logo-dark.svg
  // with whitespace trimmed). Same size + position as invoice-pdf.js.
  const logo = logoBuffer();
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
  } else {
    doc.font(fontHeading(doc)).fontSize(22).fillColor(PJL_GREEN);
    doc.text("PJL", PAGE_W - MARGIN_X - 200, top + 6, {
      width: 200, align: "right", characterSpacing: 1
    });
    doc.fontSize(11).fillColor(PJL_GREEN);
    doc.text("LAND SERVICES", PAGE_W - MARGIN_X - 200, top + 32, {
      width: 200, align: "right", characterSpacing: 3
    });
  }

  // Reset cursor below the header content (left text bottom is ~y=124,
  // logo bottom is ~y=120). Tight 6pt gap before bill-to block.
  doc.y = Math.max(doc.y, 124);
  doc.x = leftX;
  doc.moveDown(0.4);

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

  // ---- Cover page header --------------------------------------------
  const top = 40;
  const LOGO_W = 160;
  doc.font(fontHeading(doc)).fontSize(34).fillColor(PJL_GREEN);
  doc.text("PROPOSAL", MARGIN_X, top, {
    characterSpacing: 1.5,
    width: contentWidth - LOGO_W - 16,
    lineGap: 0
  });

  const logo = logoBuffer();
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
  } else {
    doc.font(fontHeading(doc)).fontSize(22).fillColor(PJL_GREEN);
    doc.text("PJL", PAGE_W - MARGIN_X - 200, top + 6, {
      width: 200, align: "right", characterSpacing: 1
    });
    doc.fontSize(11).fillColor(PJL_GREEN);
    doc.text("LAND SERVICES", PAGE_W - MARGIN_X - 200, top + 32, {
      width: 200, align: "right", characterSpacing: 3
    });
  }

  let y = top + 50;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(PJL_TEXT);
  const branchLabel = quote.branch ? BRANCH_LABELS[quote.branch] || quote.branch : "";
  const versionTag = (Number(quote.version) || 1) > 1 ? ` · v${quote.version}` : "";
  doc.text(`${quote.id}${versionTag}${branchLabel ? "  ·  " + branchLabel : ""}`, MARGIN_X, y);
  y = doc.y + 2;
  doc.font("Helvetica").fontSize(9).fillColor(PJL_MUTED);
  doc.text(
    `Issued ${fmtDate(quote.createdAt)}${quote.validUntil ? `  ·  Valid through ${fmtDate(quote.validUntil)}` : ""}`,
    MARGIN_X, y
  );

  // Company contact strip on its own line.
  y = doc.y + 2;
  doc.text("PJL Land Services  ·  1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5  ·  (905) 960-0181  ·  info@pjllandservices.com", MARGIN_X, y);

  // Customer + property block.
  y = Math.max(doc.y, 130) + 14;
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
    doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(10);
    // Sanitize light HTML — strip tags so admin-pasted rich text doesn't
    // explode the PDF. We treat the body as plain text with paragraph
    // breaks (\n\n).
    const plain = String(sec.body)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    const paragraphs = plain.split(/\n\n+/);
    for (const p of paragraphs) {
      doc.text(p.trim(), MARGIN_X, doc.y, { width: contentWidth, lineGap: 2 });
      doc.moveDown(0.4);
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

function renderProposalLineItems(doc, quote, { MARGIN_X, contentWidth }) {
  if (!Array.isArray(quote.lineItems) || !quote.lineItems.length) return;

  if (doc.y > doc.page.height - 200) doc.addPage();

  doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(15);
  doc.text("ITEMIZED PRICING", MARGIN_X, doc.y, { characterSpacing: 1.2 });
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + 60, ruleY).strokeColor(PJL_GREEN).lineWidth(1.5).stroke();
  doc.moveDown(0.4);

  const colDesc = MARGIN_X;
  const colQty = MARGIN_X + 280;
  const colUnit = MARGIN_X + 340;
  const colTotal = MARGIN_X + 420;

  // Table header.
  const tableTop = doc.y + 4;
  doc.fillColor(PJL_MUTED).fontSize(9).font("Helvetica-Bold");
  doc.text("DESCRIPTION", colDesc, tableTop, { characterSpacing: 1 });
  doc.text("QTY", colQty, tableTop, { width: 50, align: "right", characterSpacing: 1 });
  doc.text("UNIT", colUnit, tableTop, { width: 70, align: "right", characterSpacing: 1 });
  doc.text("LINE TOTAL", colTotal, tableTop, { width: 80, align: "right", characterSpacing: 1 });
  doc.moveTo(MARGIN_X, tableTop + 14).lineTo(MARGIN_X + contentWidth, tableTop + 14)
    .strokeColor(PJL_MUTED).lineWidth(0.5).stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor(PJL_TEXT);
  for (const li of quote.lineItems) {
    if (rowY > doc.page.height - 120) {
      doc.addPage();
      rowY = 60;
    }
    const label = li.label || li.sourceKey || "Line item";
    const qty = Number(li.qty) || 1;
    const price = Number(li.price) || 0;
    const lineTotal = Number(li.lineTotal) || (price * qty);
    doc.text(label, colDesc, rowY, { width: 260 });
    if (li.description) {
      doc.fontSize(9).fillColor(PJL_MUTED).text(li.description, colDesc, doc.y + 1, { width: 260 });
      doc.fontSize(10).fillColor(PJL_TEXT);
    }
    doc.text(String(qty) + (li.unit ? "" : ""), colQty, rowY, { width: 50, align: "right" });
    doc.text(fmt(price) + (li.unit ? `/${li.unit.replace("per_", "")}` : ""),
      colUnit, rowY, { width: 70, align: "right" });
    doc.text(fmt(lineTotal), colTotal, rowY, { width: 80, align: "right" });
    rowY = doc.y + 8;
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

function renderAcceptanceBlock(doc, quote, { MARGIN_X, contentWidth, acceptanceUrl, returnEmail }) {
  if (doc.y > doc.page.height - 260) doc.addPage();

  doc.fillColor(PJL_GREEN).font(fontHeading(doc)).fontSize(15);
  doc.text("ACCEPTANCE", MARGIN_X, doc.y, { characterSpacing: 1.2 });
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + 60, ruleY).strokeColor(PJL_GREEN).lineWidth(1.5).stroke();
  doc.moveDown(0.4);

  doc.fillColor(PJL_TEXT).font("Helvetica").fontSize(10);
  doc.text(
    "You may accept this proposal in either of two ways — both produce a legally binding acceptance.",
    MARGIN_X, doc.y, { width: contentWidth }
  );
  doc.moveDown(0.4);

  // Already-accepted branch: show the evidence inline.
  if (quote.acceptanceMethod === "portal_esign" && quote.signature?.signed) {
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

// ---- Dispatcher ------------------------------------------------------

const _originalGenerateQuotePdf = generateQuotePdf;

function renderQuotePdf(quote, opts = {}) {
  if (quote && quote.type === "project_proposal") {
    return renderProjectProposalPdf(quote, opts);
  }
  return _originalGenerateQuotePdf(quote, opts);
}

module.exports = {
  generateQuotePdf,            // unchanged — back-compat for existing callers
  renderQuotePdf,              // new dispatcher — prefer this for new code
  renderProjectProposalPdf     // exported for direct invocation if needed
};

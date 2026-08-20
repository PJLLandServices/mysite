// Plain business letter on PJL letterhead.
//
// Deliberately standalone: this does NOT share code with invoice-pdf.js,
// quote-pdf.js, po-pdf.js, rfq-pdf.js or wo-report-pdf.js, and changing
// it cannot alter a single existing document. Those five renderers draw
// three unrelated designs (see docs/LETTERHEAD_REFACTOR_INVESTIGATION.md);
// unifying them is a redesign, not a refactor. This file is the answer to
// the actual need — "put something on PJL letterhead" — without any of it.
//
// Structure, top to bottom:
//   title → sender identity → logo (right) → date → addressee → rule → body
//
// The letterhead is the house one: geometry transcribed from
// invoice-pdf.js drawHeader, so a letter sits alongside an invoice, a
// quote or the Lewis Honey schedule rather than looking like a different
// company. Verified by extracting text positions from a real invoice
// render and this one — title, sender name, street, contact and GST
// lines all land on identical x/top/size.
//
// The big green title slot is the subject, upper-cased — the same slot
// that reads "INVOICE" on an invoice.
//
// Body is plain text. Blank line = new paragraph. A line starting with
// "- " is a bullet. That is the whole markup vocabulary, on purpose.
//
//   const { generateLetterPdf } = require("./letter-pdf");
//   const pdf = await generateLetterPdf({
//     to: { name: "Jane Smith", company: "Maple Ridge Property Mgmt",
//           lines: ["123 Main St.", "Newmarket, ON  L3Y 1A1"] },
//     subject: "2026 irrigation service agreement",
//     body: "Hi Jane,\n\nHere is the renewal...",
//   });

const PDFDocument = require("pdfkit");
const fsSync = require("node:fs");
const path = require("node:path");

const company = require("./company");

// ---- Identity -------------------------------------------------------
// Sender identity beyond what company.js carries today. company.js owns
// name/city/phone/website/email; a letterhead also needs the street
// address and the GST/HST registration. Kept here rather than pushed
// into company.js so this file cannot perturb the PO/RFQ renderers that
// read from it.
const STREET_LINE = "1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5";
const GST_LINE = "GST/HST Reg. No. 757080940 RT0001";
const CONTACT_EMAIL = "info@pjllandservices.com";

const SIGNER = { name: "Patrick Lalande", title: "PJL Land Services" };

// ---- Palette (matches style.css :root) ------------------------------
const GREEN = company.GREEN_HEX;   // #1B4D2E
const TEXT = "#1A1A1A";
const MUTED = "#7A7A72";
const RULE = "#EFEDE3";
const BAND = "#F4F8EE";     // recipient band fill

// ---- Page geometry --------------------------------------------------
const PAGE_W = 612;                // US Letter @ 72pt/in
const PAGE_H = 792;
const MARGIN_X = 40;               // matches invoice-pdf.js — the house letterhead margin
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BODY_TOP = 72;               // where continuation pages start

// ---- Title fitting --------------------------------------------------
// The title is one line, always. It shrinks to fit rather than wrapping
// onto a second row, which would push the sender block down and unsettle
// the whole letterhead.
//
// TITLE_W runs to 16pt short of the logo's left edge. invoice-pdf.js caps
// at CONTENT_W - 200 (= 332), but its title is always the single word
// "INVOICE" (93.6pt at 30) so the cap never bites there. A letter's title
// is the subject, so it gets the real available width — 24pt more before
// any shrinking starts. Nothing an invoice would print is affected.
const LOGO_W = 160;
const TITLE_W = PAGE_W - MARGIN_X * 2 - LOGO_W - 16;   // 356
const TITLE_MAX = 30;              // matches invoice-pdf.js
const TITLE_MIN = 16;              // below this, wrap instead of shrink
const TITLE_TRACK = 1.5;           // letterspacing at TITLE_MAX
const TITLE_BOTTOM = 76;           // title sits on this line whatever its size
const FOOTER_H = 62;              // reserved band at the page bottom

// ---- Brand assets ---------------------------------------------------
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

// Largest size at or below TITLE_MAX that fits `title` on one line within
// TITLE_W. Letterspacing scales with the size so the tracking stays
// proportional — at TITLE_MAX it is exactly the invoice's 1.5. Returns
// TITLE_MIN if even that overflows, and the caller lets it wrap.
function fitTitle(doc, title) {
  doc.font(fontHeading());
  for (let size = TITLE_MAX; size >= TITLE_MIN; size -= 0.25) {
    const track = TITLE_TRACK * (size / TITLE_MAX);
    doc.fontSize(size);
    // Measure with heightOfString, not widthOfString. pdfkit's LineWrapper
    // does not break where widthOfString says it should — at 23.5pt this
    // title measures 355.95 against a 356 limit and still wraps.
    // heightOfString runs the same wrapper that draws, so it is the only
    // measurement that agrees with the output. One line or keep shrinking.
    const h = doc.heightOfString(title, {
      width: TITLE_W, characterSpacing: track, lineGap: 0
    });
    if (h <= doc.currentLineHeight() * 1.2) return { size, track };
  }
  return { size: TITLE_MIN, track: TITLE_TRACK * (TITLE_MIN / TITLE_MAX) };
}

// Logo aspect from the PNG's IHDR, so a logo re-export can't distort the
// lockup. Falls back to the known 1000×574 ratio.
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
  return width * _logoAspect;
}

// ---- Formatting -----------------------------------------------------
// Letters date in long form ("August 20, 2026"), never ISO.
function fmtLetterDate(input) {
  if (!input) input = new Date();
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    const [y, m, d] = input.trim().split("-").map(Number);
    input = new Date(Date.UTC(y, m - 1, d, 12));
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "long", day: "numeric"
  });
}

// Body text → blocks. Blank line separates paragraphs; a run of "- "
// lines becomes one bullet list. Everything else is a paragraph.
function parseBody(body) {
  const raw = Array.isArray(body) ? body.join("\n\n") : String(body || "");
  const blocks = [];
  let bullets = null;

  const flushBullets = () => {
    if (bullets && bullets.length) blocks.push({ type: "bullets", items: bullets });
    bullets = null;
  };

  for (const chunk of raw.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    for (const line of lines) {
      if (/^[-*]\s+/.test(line)) {
        if (!bullets) bullets = [];
        bullets.push(line.replace(/^[-*]\s+/, ""));
      } else {
        flushBullets();
        // Consecutive non-bullet lines inside one chunk are a single
        // paragraph — a hard-wrapped source file shouldn't become a
        // dozen one-line paragraphs.
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === "para" && prev.pendingJoin) {
          prev.text += " " + line;
        } else {
          blocks.push({ type: "para", text: line, pendingJoin: true });
        }
      }
    }
    flushBullets();
    const last = blocks[blocks.length - 1];
    if (last && last.type === "para") last.pendingJoin = false;
  }
  flushBullets();
  return blocks;
}

// ---- Letterhead -----------------------------------------------------
// The house letterhead, matching invoice-pdf.js drawHeader and the
// Lewis Honey schedule: big green title left, sender identity stacked
// beneath it, logo pinned to the right margin. Geometry is transcribed
// from invoice-pdf.js so a letter sits alongside the rest of PJL's
// paperwork rather than looking like a different company.
//
// The title is the subject, upper-cased — the same slot that reads
// "INVOICE" on an invoice and "SPRINKLER SYSTEM SCHEDULE" on the
// schedule. With no title the sender block moves up to fill the space.
function drawLetterhead(doc, title) {
  const top = 40;

  if (title) {
    const { size, track } = fitTitle(doc, title);
    doc.font(fontHeading()).fontSize(size).fillColor(GREEN);
    // Bottom-aligned to TITLE_BOTTOM, so a shrunken title sits just above
    // the sender block instead of stranding a gap under the page top. At
    // TITLE_MAX this lands on y = top, exactly where the invoice puts it.
    const titleY = TITLE_BOTTOM - doc.currentLineHeight();
    doc.text(title, MARGIN_X, titleY, {
      characterSpacing: track,
      width: TITLE_W,
      lineGap: 0
    });
  }

  // Sender identity — three stacked lines plus the GST registration.
  //
  // The invoice hardcodes this at `top + 38`, which is only safe because
  // its title is always the single word "INVOICE". A letter's title is
  // the subject and can wrap, so flow from the title's real bottom and
  // keep `top + 38` as the floor — a one-line title lands at exactly the
  // invoice's y, a wrapping one pushes the block down instead of
  // printing on top of it.
  let y = title ? Math.max(doc.y + 2, top + 38) : top + 2;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(TEXT);
  doc.text(company.NAME, MARGIN_X, y, { width: TITLE_W });
  y = doc.y + 1;
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text(STREET_LINE, MARGIN_X, y, { width: TITLE_W });
  y = doc.y;
  doc.text(`${CONTACT_EMAIL}  ·  ${company.PHONE}  ·  ${company.WEBSITE}`,
    MARGIN_X, y, { width: TITLE_W });
  y = doc.y + 2;
  doc.fontSize(8).fillColor(MUTED);
  doc.text(GST_LINE, MARGIN_X, y, { characterSpacing: 0.3, width: TITLE_W });

  // Logo, right edge pinned to the content margin so it lines up with
  // the rules and the footer below.
  const logo = logoBuffer();
  if (logo) {
    doc.image(logo, PAGE_W - MARGIN_X - LOGO_W, top - 12, { width: LOGO_W });
  } else {
    doc.font(fontHeading()).fontSize(22).fillColor(GREEN);
    doc.text("PJL", PAGE_W - MARGIN_X - 200, top + 6,
      { width: 200, align: "right", characterSpacing: 1 });
    doc.fontSize(11).fillColor(GREEN);
    doc.text("LAND SERVICES", PAGE_W - MARGIN_X - 200, top + 32,
      { width: 200, align: "right", characterSpacing: 3 });
  }

  // Whichever column is taller wins. 124 is the invoice's floor — the
  // logo bottom sits at top - 12 + ~92.
  return Math.max(doc.y, 124) + 24;
}

// ---- Recipient band -------------------------------------------------
// The full-bleed green-tint band that carries who the document is for —
// same one on the invoice and the Lewis Honey schedule. Geometry from
// invoice-pdf.js drawCustomerBand. Its bottom hairline is the rule that
// separates the header from the body, so nothing else draws one.
//
// Left column is the recipient, right column the date. An optional
// heading (a managing company, "c/o ...") sits above both in green.
function drawRecipientBand(doc, { to = {}, date, heading, label = "PREPARED FOR" }, startY) {
  const padX = MARGIN_X;
  const padY = 14;
  const bandTop = startY;

  // Compose the recipient lines first so the band can be sized to fit.
  const lines = [];
  if (to.attn) lines.push({ text: `Attn: ${to.attn}`, size: 9, muted: true });
  if (to.name) lines.push({ text: to.name, size: 11, bold: true });
  if (to.company) lines.push({ text: to.company, size: to.name ? 10 : 11, bold: !to.name });
  for (const l of (to.lines || [])) lines.push({ text: l, size: 10 });
  const contact = [to.phone, to.email].filter(Boolean).join(" · ");
  if (contact) lines.push({ text: contact, size: 9, muted: true });
  if (!lines.length) lines.push({ text: "To whom it may concern", size: 11, bold: true });

  // Height: padding + label + each line + optional heading.
  let bandH = padY * 2 + 14 + lines.reduce((h, l) => h + l.size + 3, 0);
  if (heading) bandH += 24;
  if (bandH < 78) bandH = 78;

  doc.save();
  doc.rect(0, bandTop, PAGE_W, bandH).fill(BAND);
  doc.restore();
  doc.save();
  doc.strokeColor(RULE).lineWidth(0.5);
  doc.moveTo(0, bandTop).lineTo(PAGE_W, bandTop).stroke();
  doc.moveTo(0, bandTop + bandH).lineTo(PAGE_W, bandTop + bandH).stroke();
  doc.restore();

  let y = bandTop + padY;

  if (heading) {
    doc.font(fontHeading()).fontSize(14).fillColor(GREEN);
    doc.text(heading, padX, y, { width: PAGE_W - padX * 2 });
    y = doc.y + 8;
  }

  const colW = (PAGE_W - padX * 2 - 40) / 2;
  const rightX = padX + colW + 40;
  const labelY = y;

  // Left column — the recipient.
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  doc.text(label, padX, labelY, { characterSpacing: 1.4, width: colW });
  y = doc.y + 4;
  for (const l of lines) {
    doc.font(l.bold ? "Helvetica-Bold" : "Helvetica").fontSize(l.size);
    doc.fillColor(l.muted ? MUTED : TEXT);
    doc.text(l.text, padX, y, { width: colW });
    y = doc.y + 1;
  }

  // Right column — the date.
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  doc.text("DATE", rightX, labelY, { characterSpacing: 1.4, width: colW });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(TEXT);
  doc.text(fmtLetterDate(date), rightX, doc.y + 4, { width: colW });

  return bandTop + bandH + 26;
}

// ---- Body -----------------------------------------------------------
// Plain text, generously leaded. pdfkit paginates on overflow by itself;
// margins.top is set so continuation pages start at BODY_TOP.
function drawBody(doc, blocks, startY) {
  doc.x = MARGIN_X;
  doc.y = startY;

  blocks.forEach((block, i) => {
    if (block.type === "bullets") {
      doc.font("Helvetica").fontSize(10.5).fillColor(TEXT);
      for (const item of block.items) {
        const y0 = doc.y;
        doc.text("•", MARGIN_X + 4, y0, { width: 12, lineBreak: false });
        doc.text(item, MARGIN_X + 20, y0, {
          width: CONTENT_W - 20, align: "left", lineGap: 3
        });
        doc.y += 4;
      }
    } else {
      doc.font("Helvetica").fontSize(10.5).fillColor(TEXT);
      doc.text(block.text, MARGIN_X, doc.y, {
        width: CONTENT_W, align: "left", lineGap: 3.5
      });
    }
    if (i < blocks.length - 1) doc.y += 11;
  });
}

// ---- Sign-off -------------------------------------------------------
function drawSignOff(doc, { closing = "Sincerely,", signer = SIGNER } = {}) {
  const needed = 96;
  if (doc.y + needed > PAGE_H - FOOTER_H) doc.addPage();

  let y = doc.y + 26;
  doc.font("Helvetica").fontSize(10.5).fillColor(TEXT);
  doc.text(closing, MARGIN_X, y, { width: CONTENT_W, lineBreak: false });
  y = doc.y + 34;   // room for a wet signature

  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(TEXT);
  doc.text(signer.name || SIGNER.name, MARGIN_X, y, { width: CONTENT_W, lineBreak: false });
  if (signer.title) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text(signer.title, MARGIN_X, doc.y + 2, { width: CONTENT_W, lineBreak: false });
  }
}

// ---- Footer ---------------------------------------------------------
// Drawn across every page at the end, via bufferPages, so "Page X of Y"
// can know Y. Bottom margin is dropped to 0 for the write — pdfkit's
// LineWrapper checks margin.bottom even with lineBreak:false and would
// otherwise spawn a blank page.
function drawFooters(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  if (total < 1) return;

  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const restoreBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = PAGE_H - 44;
    doc.save()
      .moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y)
      .strokeColor(RULE).lineWidth(0.5).stroke()
      .restore();

    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(
      `${company.NAME}  ·  ${company.PHONE}  ·  ${company.WEBSITE}`,
      MARGIN_X, y + 9,
      { width: CONTENT_W, align: "left", lineBreak: false }
    );
    if (total > 1) {
      doc.text(`Page ${i + 1} of ${total}`, MARGIN_X, y + 9,
        { width: CONTENT_W, align: "right", lineBreak: false });
    }

    doc.page.margins.bottom = restoreBottom;
  }
}

// ---- Entry point ----------------------------------------------------
// Returns Promise<Buffer> — same shape as generateInvoicePdf, so one
// call site can stream it to a response and attach it to an email.
function generateLetterPdf(opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: BODY_TOP, bottom: FOOTER_H, left: MARGIN_X, right: MARGIN_X },
        bufferPages: true,
        info: {
          Title: opts.subject ? `PJL — ${opts.subject}` : "PJL Land Services — Letter",
          Author: company.NAME,
          Subject: opts.subject || "Letter"
        }
      });

      const barlow = barlowBuffer();
      if (barlow) doc.registerFont("Barlow-Bold", barlow);

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Title slot: an explicit title wins, else the subject upper-cased
      // (Barlow Condensed is a display face — it is set in caps on every
      // other PJL document). Neither given → no title, sender block up.
      const title = opts.title !== undefined
        ? opts.title
        : (opts.subject ? String(opts.subject).toUpperCase() : "");

      const afterHead = drawLetterhead(doc, title);
      const afterTo = drawRecipientBand(doc, opts, afterHead);
      drawBody(doc, parseBody(opts.body), afterTo);
      if (opts.signOff !== false) {
        drawSignOff(doc, {
          closing: opts.closing,
          signer: opts.signer || SIGNER
        });
      }
      drawFooters(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateLetterPdf, parseBody };

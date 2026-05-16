// Supplier-facing email — Purchase Order send + resend.
//
// Sends a Purchase Order to a supplier with two attachments:
//   - <PO-ID>.pdf — the formal one-page document for the supplier's records
//   - <PO-ID>.csv — line-item data for direct entry into the supplier's
//     order system (eliminates re-keying from the PDF)
//
// Email body design (PO Document Redesign brief §3.6):
//   - Subject: PO-YYYY-NNNN — PJL Land Services — N items, $TOTAL
//   - From:    "PJL Land Services <{GMAIL_USER}>"  (info@pjllandservices.com)
//   - HTML body contains a "quick-paste table" — a real <table>, not a
//     <pre>, so that highlighting + copying pastes into Excel with the
//     cells separated automatically. This is the entire point of the
//     quick-paste feature.
//   - Plain-text fallback for clients that strip HTML; uses column-
//     aligned text. Loses the column-paste advantage but stays readable.
//
// Reuses GMAIL_USER + GMAIL_APP_PASSWORD already set on Render.
// Reply-to is set to GMAIL_USER so supplier replies land in PJL's inbox.

const company = require("./company");
const { formatUnit } = require("./format");

let nodemailerCache = null;
function getNodemailer() {
  if (nodemailerCache !== null) return nodemailerCache;
  try {
    nodemailerCache = require("nodemailer");
  } catch {
    nodemailerCache = false;
  }
  return nodemailerCache;
}

let transporterCache = null;
function getTransporter() {
  if (transporterCache) return transporterCache;
  const nodemailer = getNodemailer();
  if (!nodemailer) return null;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporterCache = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  return transporterCache;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtCents(c) {
  const v = (Number(c) || 0) / 100;
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 2 }).format(v);
}

// First-name extraction for the greeting. Falls back to "there" if the
// contact name is missing or unparseable. Brief calls for "Hi <FIRST>,".
function firstNameOf(fullName) {
  const s = String(fullName || "").trim();
  if (!s) return "there";
  const first = s.split(/\s+/)[0];
  // Strip trailing punctuation, capitalize. Don't get clever — if the
  // stored name is "ACME LLC", "ACME" is what we use.
  return first.replace(/[,;:.]+$/, "");
}

// Render the quick-paste table — a real HTML <table> styled to look like
// a code block. The styling makes it visually distinct from the
// surrounding prose, but the underlying HTML is structured so Gmail /
// Outlook / Apple Mail preserve the cell boundaries when the user
// highlights and copies it. Pasted into Excel, the SKU / Qty /
// Description columns separate automatically.
//
// `items` is `po.lineItems`. Each row needs `sku`, `qty`, and a
// description — descriptions are looked up via the caller-provided
// `descriptionFor` to keep this module catalog-agnostic.
function renderQuickPasteTable(items, descriptionFor) {
  const headStyle = "text-align:left; padding: 0 12px 6px 0; color: #888780; border-bottom: 0.5px solid #d3d1c7; font-weight: 500;";
  const headStyleLast = "text-align:left; padding: 0 0 6px 0; color: #888780; border-bottom: 0.5px solid #d3d1c7; font-weight: 500;";
  const cellStyle = "padding: 6px 12px 0 0;";
  const cellStyleLast = "padding: 6px 0 0 0;";
  const rows = items.map((line) => {
    const desc = descriptionFor(line.sku);
    return `    <tr>
      <td style="${cellStyle}">${escapeHtml(line.sku || "")}</td>
      <td style="${cellStyle}">${escapeHtml(String(line.qty))}</td>
      <td style="${cellStyleLast}">${escapeHtml(desc)}</td>
    </tr>`;
  }).join("\n");

  return `<table style="
  background: #f5f3ed;
  border: 0.5px solid #d3d1c7;
  border-radius: 6px;
  border-collapse: separate;
  font-family: 'Courier New', Courier, monospace;
  font-size: 12px;
  line-height: 1.65;
  padding: 14px 16px;
  margin: 0 0 16px;
  width: 100%;
">
  <thead>
    <tr>
      <th style="${headStyle}">SKU</th>
      <th style="${headStyle}">QTY</th>
      <th style="${headStyleLast}">DESCRIPTION</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

// Plain-text version of the quick-paste block. Pad each column to a
// fixed width so the table reads as columns even in monospace plain
// text. Loses the column-paste advantage (it's a single string) but
// stays useful for clients that strip HTML.
function renderQuickPasteText(items, descriptionFor) {
  const skuWidth = Math.max(3, ...items.map((l) => String(l.sku || "").length));
  const qtyWidth = Math.max(3, ...items.map((l) => String(l.qty).length));
  const lines = [];
  lines.push("SKU".padEnd(skuWidth) + "  " + "QTY".padEnd(qtyWidth) + "  DESCRIPTION");
  lines.push("-".repeat(skuWidth) + "  " + "-".repeat(qtyWidth) + "  " + "-".repeat(40));
  for (const line of items) {
    const desc = descriptionFor(line.sku);
    lines.push(
      String(line.sku || "").padEnd(skuWidth) + "  " +
      String(line.qty).padEnd(qtyWidth) + "  " +
      desc
    );
  }
  return lines.join("\n");
}

// Subject line per brief §3.6:
//   PO-YYYY-NNNN — PJL Land Services — N items, $TOTAL
function buildSubject(po) {
  const n = (po.lineItems || []).length;
  const total = fmtCents(po.subtotalCents);
  return `${po.id} — ${company.NAME} — ${n} item${n === 1 ? "" : "s"}, ${total}`;
}

// Build the email body — both HTML and plain-text variants from the
// same template. `descriptionFor` is injected by the caller (server.js)
// so this module stays decoupled from parts.json.
function buildPoEmail({ po, toName, customBodyText, descriptionFor }) {
  const greeting = `Hi ${firstNameOf(toName)},`;
  const items = po.lineItems || [];
  const subtotal = fmtCents(po.subtotalCents);

  // ---- Plain text body ------------------------------------------------
  const textBody = [
    greeting,
    "",
    `Please find purchase order ${po.id} attached. Subtotal ${subtotal} before HST.`,
    "",
    "Quick-paste line items for your system:",
    "",
    renderQuickPasteText(items, descriptionFor),
    "",
    "CSV is attached for direct system entry. Full document attached as PDF.",
    "",
    `Please reference ${po.id} on your invoice and packing slip.`,
    "",
    customBodyText ? customBodyText.trim() : "",
    customBodyText ? "" : "",
    "Thanks,",
    "Patrick",
    "",
    "—",
    company.NAME,
    `${company.CITY} · ${company.PHONE}`,
    `${company.email()} · ${company.WEBSITE}`
  ].filter((line) => line !== false).join("\n");

  // ---- HTML body ------------------------------------------------------
  const quickPasteHtml = renderQuickPasteTable(items, descriptionFor);
  const html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; max-width: 600px; color: #1a1a1a; line-height: 1.55; font-size: 14px;">
  <p style="margin: 0 0 14px;">${escapeHtml(greeting)}</p>
  <p style="margin: 0 0 14px;">Please find purchase order <strong>${escapeHtml(po.id)}</strong> attached. Subtotal <strong>${escapeHtml(subtotal)}</strong> before HST.</p>
  <p style="margin: 0 0 8px; color: #555;">Quick-paste line items for your system:</p>
  ${quickPasteHtml}
  <p style="margin: 0 0 14px; color: #555;">CSV is attached for direct system entry. Full document attached as PDF.</p>
  <p style="margin: 0 0 14px;">Please reference <strong>${escapeHtml(po.id)}</strong> on your invoice and packing slip.</p>
  ${customBodyText ? `<p style="margin: 0 0 14px; white-space: pre-wrap;">${escapeHtml(customBodyText)}</p>` : ""}
  <p style="margin: 22px 0 8px;">Thanks,<br>Patrick</p>
  <p style="margin: 14px 0 0; color: #888; font-size: 12px; border-top: 0.5px solid #ddd; padding-top: 12px;">
    ${escapeHtml(company.NAME)}<br>
    ${escapeHtml(company.CITY)} · ${escapeHtml(company.PHONE)}<br>
    <a href="mailto:${escapeHtml(company.email())}" style="color: #1B4D2E;">${escapeHtml(company.email())}</a> ·
    <a href="https://${escapeHtml(company.WEBSITE)}" style="color: #1B4D2E;">${escapeHtml(company.WEBSITE)}</a>
  </p>
</div>`;

  return { text: textBody, html };
}

// Send a PO email. Throws if Gmail isn't configured or the send fails
// so the calling endpoint can return a 500 with the underlying error
// instead of silently flipping the PO state.
//
// Inputs (all required except the customBodyText / subject overrides):
//   po               — full PO record (drives subject, body, attachment names)
//   toEmail          — recipient email (vendor's Attn contact)
//   toName           — vendor contact name (drives "Hi <FIRST>,")
//   pdfBuffer        — bytes of the formal PDF
//   csvBuffer        — bytes of the CSV companion
//   descriptionFor   — function (sku) => string; injected for catalog lookup
//   subject          — optional override; defaults to the brief's pattern
//   bodyText         — optional caller-supplied extra paragraph
async function sendPurchaseOrderEmail({
  po, toEmail, toName, subject, bodyText,
  pdfBuffer, csvBuffer, descriptionFor
}) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("Email is not configured on this server (set GMAIL_USER + GMAIL_APP_PASSWORD).");
  }
  if (!toEmail) throw new Error("Recipient email is required.");
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) throw new Error("PDF attachment is empty.");
  if (!Buffer.isBuffer(csvBuffer) || !csvBuffer.length) throw new Error("CSV attachment is empty.");
  if (typeof descriptionFor !== "function") {
    throw new Error("descriptionFor (sku) => string is required.");
  }

  const fromAddress = process.env.GMAIL_USER;
  const finalSubject = String(subject || buildSubject(po)).slice(0, 200);
  const { text, html } = buildPoEmail({ po, toName, customBodyText: bodyText, descriptionFor });

  const info = await transporter.sendMail({
    from: `"${company.NAME}" <${fromAddress}>`,
    to: toEmail,
    replyTo: fromAddress,
    subject: finalSubject,
    text,
    html,
    attachments: [
      {
        filename: `${po.id}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf"
      },
      {
        filename: `${po.id}.csv`,
        content: csvBuffer,
        contentType: "text/csv; charset=utf-8"
      }
    ]
  });
  console.log("[po-email] Sent", po.id, "to", toEmail, "—", info.messageId);
  return { ok: true, messageId: info.messageId };
}

module.exports = {
  sendPurchaseOrderEmail,
  buildSubject       // exported for tests and for the server's idempotent re-send path
};

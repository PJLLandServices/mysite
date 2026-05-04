// Supplier-facing email — Phase 3.
//
// Sends a Purchase Order to a supplier with the rendered PDF attached.
// Reuses the existing GMAIL_USER + GMAIL_APP_PASSWORD env vars (already
// set on Render — see dns_cutover_pending.md). Throws if creds are
// missing so the calling endpoint can surface a clear error rather than
// silently no-opping.
//
// Reply-to is set to GMAIL_USER so any supplier reply lands in PJL's
// inbox rather than the sender alias.

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

function buildPoEmail({ po, toName, customBodyText }) {
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const lineCount = (po.lineItems || []).length;
  const itemsSummary = `${lineCount} line item${lineCount === 1 ? "" : "s"}, subtotal ${fmtCents(po.subtotalCents)}`;

  // Plain-text body — keeps it clean for email clients that strip HTML
  // and lets PJL eyeball what went out from the Sent folder later.
  const textBody = [
    greeting,
    "",
    `Please find attached PJL purchase order ${po.id}.`,
    "",
    itemsSummary,
    "",
    "Could you confirm receipt and let me know your expected delivery date when convenient?",
    "",
    customBodyText ? customBodyText.trim() : "",
    customBodyText ? "" : "",
    "Thanks,",
    "Patrick at PJL Land Services",
    "(905) 960-0181 · pjllandservices.com"
  ].filter((line) => line !== false).join("\n");

  // HTML body. Same content as text, lightly styled. Inline styles only —
  // no external CSS, since most email clients strip <style> blocks.
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.5;">
  <p style="margin: 0 0 14px;">${escapeHtml(greeting)}</p>
  <p style="margin: 0 0 14px;">Please find attached PJL purchase order <strong>${escapeHtml(po.id)}</strong>.</p>
  <p style="margin: 0 0 14px; color: #555;">${escapeHtml(itemsSummary)}</p>
  <p style="margin: 0 0 14px;">Could you confirm receipt and let me know your expected delivery date when convenient?</p>
  ${customBodyText ? `<p style="margin: 0 0 14px; white-space: pre-wrap;">${escapeHtml(customBodyText)}</p>` : ""}
  <p style="margin: 22px 0 0;">Thanks,<br>Patrick at PJL Land Services<br>(905) 960-0181 · <a href="https://pjllandservices.com">pjllandservices.com</a></p>
</div>`.trim();

  return { text: textBody, html };
}

// Send a PO email. Throws if Gmail isn't configured or the send fails so
// the calling endpoint returns a 500 with the error instead of silently
// flipping the PO to "sent" with no email actually delivered.
async function sendPurchaseOrderEmail({ po, toEmail, toName, subject, bodyText, pdfBuffer }) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("Email is not configured on this server (set GMAIL_USER + GMAIL_APP_PASSWORD).");
  }
  if (!toEmail) throw new Error("Recipient email is required.");
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) throw new Error("PDF attachment is empty.");

  const fromAddress = process.env.GMAIL_USER;
  const finalSubject = String(subject || `Purchase Order ${po.id} from PJL Land Services`).slice(0, 200);
  const { text, html } = buildPoEmail({ po, toName, customBodyText: bodyText });

  const info = await transporter.sendMail({
    from: `"PJL Land Services" <${fromAddress}>`,
    to: toEmail,
    replyTo: fromAddress,
    subject: finalSubject,
    text,
    html,
    attachments: [{
      filename: `${po.id}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf"
    }]
  });
  console.log("[po-email] Sent", po.id, "to", toEmail, "—", info.messageId);
  return { ok: true, messageId: info.messageId };
}

module.exports = { sendPurchaseOrderEmail };

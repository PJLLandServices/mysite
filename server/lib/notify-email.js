// Email notification on new lead intake.
//
// Reads credentials from environment variables (loaded from .env at server boot):
//   GMAIL_USER          — your Google Workspace address (e.g. info@pjllandservices.com)
//   GMAIL_APP_PASSWORD  — a Gmail "app password" (NOT your regular password —
//                         create one at https://myaccount.google.com/apppasswords)
//   NOTIFY_TO_EMAIL     — where the alert goes (defaults to GMAIL_USER)
//   PUBLIC_BASE_URL     — your site's public URL, used to build the CRM link
//                         in the email body (e.g. https://pjllandservices.com).
//                         Defaults to the request host if absent.
//
// If GMAIL_USER or GMAIL_APP_PASSWORD is missing, this module logs a clear
// message to the console and returns { ok: false, skipped: true } — the lead
// intake itself still succeeds. That way the site keeps working before you've
// configured email, and starts emailing the moment you set the env vars.

let nodemailerCache = null;
function getNodemailer() {
  if (nodemailerCache !== null) return nodemailerCache;
  try {
    nodemailerCache = require("nodemailer");
  } catch {
    nodemailerCache = false; // marker: package not installed
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

function moneyText(amount) {
  const value = Number(amount || 0);
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 2 }).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildLeadEmail(lead, baseUrl) {
  const sourceLabel = lead.sourceLabel || lead.source || "General Lead";
  const town = (lead.contact?.address || "").split(",")[1]?.trim() || lead.contact?.address || "";
  const subject = `New PJL Lead — ${sourceLabel} — ${lead.contact?.name || "Unknown"}`;
  // Trailing slash on baseUrl (PUBLIC_BASE_URL env var) would otherwise
  // produce "...com//admin" / "...com//portal/<token>".
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const adminUrl = `${cleanBase}/admin`;
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;

  const featuresHtml = (lead.features || []).map((f) => {
    const qty = f.qty > 1 ? ` × ${f.qty}` : "";
    const price = f.quoteType === "custom" ? "(custom quote)" : moneyText(f.price * (f.qty || 1));
    return `<li>${escapeHtml(f.label)}${qty} — ${escapeHtml(price)}</li>`;
  }).join("") || "<li><em>No specific items selected — see customer notes.</em></li>";

  const notes = lead.contact?.notes ? `<p><strong>Customer notes:</strong><br>${escapeHtml(lead.contact.notes).replace(/\n/g, "<br>")}</p>` : "";

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a;">
  <h2 style="margin: 0 0 8px; font-size: 22px;">New ${escapeHtml(sourceLabel)} lead</h2>
  <p style="margin: 0 0 18px; color: #555;">${escapeHtml(lead.contact?.name || "")} ${town ? `· ${escapeHtml(town)}` : ""}</p>

  <table style="border-collapse: collapse; margin-bottom: 18px;">
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Phone</td><td style="padding: 4px 0;"><a href="tel:${escapeHtml(lead.contact?.phone || "")}">${escapeHtml(lead.contact?.phone || "")}</a></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Email</td><td style="padding: 4px 0;"><a href="mailto:${escapeHtml(lead.contact?.email || "")}">${escapeHtml(lead.contact?.email || "")}</a></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Address</td><td style="padding: 4px 0;">${escapeHtml(lead.contact?.address || "—")}</td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Estimated total</td><td style="padding: 4px 0;"><strong>${escapeHtml(moneyText(lead.totals?.expectedTotal))}</strong></td></tr>
  </table>

  <p style="margin: 0 0 6px;"><strong>Requested:</strong></p>
  <ul style="margin: 0 0 18px; padding-left: 20px;">${featuresHtml}</ul>

  ${notes}

  <p style="margin: 24px 0 0;">
    <a href="${escapeHtml(adminUrl)}" style="display: inline-block; padding: 10px 18px; background: #1f4f6e; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Open in CRM</a>
    &nbsp;
    <a href="${escapeHtml(portalUrl)}" style="display: inline-block; padding: 10px 18px; background: #f1f0e8; color: #1a1a1a; text-decoration: none; border-radius: 6px; font-weight: 600;">Customer portal</a>
  </p>

  <p style="margin: 24px 0 0; font-size: 12px; color: #999;">
    This alert was sent by the PJL Land Services lead receiver. Lead ID: ${escapeHtml(lead.id)}
  </p>
</div>`.trim();

  // Plain-text fallback for email clients that block HTML.
  const textLines = [
    `New ${sourceLabel} lead`,
    `${lead.contact?.name || ""}${town ? " · " + town : ""}`,
    "",
    `Phone:   ${lead.contact?.phone || ""}`,
    `Email:   ${lead.contact?.email || ""}`,
    `Address: ${lead.contact?.address || "—"}`,
    `Total:   ${moneyText(lead.totals?.expectedTotal)}`,
    "",
    "Requested:",
    ...(lead.features || []).map((f) => `  - ${f.label}${f.qty > 1 ? " × " + f.qty : ""}`),
    lead.contact?.notes ? `\nCustomer notes:\n${lead.contact.notes}` : "",
    "",
    `CRM:     ${adminUrl}`,
    `Portal:  ${portalUrl}`
  ];

  return {
    subject,
    html,
    text: textLines.filter(Boolean).join("\n")
  };
}

async function sendNewLeadEmail(lead, { baseUrl } = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email notification (lead still saved).");
    console.warn("[email] Lead:", lead.id, "-", lead.sourceLabel || lead.source, "-", lead.contact?.name);
    return { ok: false, skipped: true };
  }

  const to = process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER;
  const fromAddress = process.env.GMAIL_USER;
  const { subject, html, text } = buildLeadEmail(lead, baseUrl || "");

  try {
    const info = await transporter.sendMail({
      from: `"PJL Lead Receiver" <${fromAddress}>`,
      to,
      replyTo: lead.contact?.email || undefined,
      subject,
      html,
      text
    });
    console.log("[email] Sent lead notification:", info.messageId);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error("[email] Failed to send notification:", error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = { sendNewLeadEmail };

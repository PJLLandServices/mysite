// Customer-facing notifications. Sends an email (and SMS, when a phone is on
// file) to the CUSTOMER as their request moves through the PJL pipeline.
//
// Triggered from server.js on:
//   - lead intake (status implicit "new")        -> "received" template
//   - status transition new -> contacted          -> "reviewed" template
//   - status transition * -> site_visit           -> "site-visit-scheduled" template
//   - status transition * -> quoted               -> "quote-ready" template
//   - status transition * -> won                  -> "booked" template
//
// Only fires on actual transitions — re-saving a lead at the same status
// doesn't re-notify. Lost transitions don't notify (we don't want an
// auto-rejection email).
//
// Reuses the same Gmail + Twilio credentials as the admin notify modules.
// If credentials aren't configured, this module logs and skips silently —
// the underlying CRM action still completes.

let nodemailerCache = null;
function getNodemailer() {
  if (nodemailerCache !== null) return nodemailerCache;
  try { nodemailerCache = require("nodemailer"); } catch { nodemailerCache = false; }
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
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  return transporterCache;
}

function smsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function moneyText(amount) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 })
    .format(Number(amount || 0)).replace("CA", "").trim();
}

// Per-event subject + email body + SMS body. {firstName} / {portalUrl} / {total}
// placeholders are filled in by the caller.
const TEMPLATES = {
  received: {
    subject: "PJL Land Services has received your request",
    headline: "We've got your request.",
    body:
      "Hi {firstName}, this is PJL Land Services confirming we've received your request. " +
      "Patrick personally reviews every inquiry — you'll hear back within one business day. " +
      "If it's urgent, call (905) 960-0181.",
    sms: "PJL Land Services received your request. Patrick will be in touch within 1 business day. Track it: {portalUrl}"
  },
  reviewed: {
    subject: "PJL Land Services has reviewed your request",
    headline: "We've reviewed your request.",
    body:
      "Hi {firstName}, Patrick at PJL Land Services has reviewed your request and will reach out " +
      "to walk through next steps. Your project details are saved in your portal.",
    sms: "PJL has reviewed your request. Patrick will reach out next. Portal: {portalUrl}"
  },
  site_visit: {
    subject: "PJL is scheduling your site visit",
    headline: "Site visit coming up.",
    body:
      "Hi {firstName}, PJL Land Services is preparing for a site visit on your property to scope " +
      "the work properly. Patrick will confirm the exact day and arrival window with you directly.",
    sms: "PJL is scheduling a site visit for your project. Patrick will confirm the day. Portal: {portalUrl}"
  },
  quoted: {
    subject: "Your PJL quote is ready",
    headline: "Your quote is ready.",
    body:
      "Hi {firstName}, your PJL Land Services quote is ready to review. Open your portal to see the " +
      "scope, the price, and accept the quote when you're ready. Estimated total: {total}.",
    sms: "Your PJL quote is ready ({total}). Review and accept in your portal: {portalUrl}"
  },
  booked: {
    subject: "Your PJL booking is confirmed",
    headline: "You're on the schedule.",
    body:
      "Hi {firstName}, your PJL Land Services project is booked. Patrick will follow up with the " +
      "exact day-of arrival window. Thank you for choosing PJL — we'll take great care of your property.",
    sms: "PJL has booked your project. Patrick will confirm day-of arrival window. Portal: {portalUrl}"
  }
};

function fill(template, vars) {
  return Object.keys(vars).reduce(
    (out, key) => out.replace(new RegExp(`\\{${key}\\}`, "g"), vars[key] ?? ""),
    template
  );
}

function buildEmail(event, lead, baseUrl) {
  const tpl = TEMPLATES[event];
  if (!tpl) return null;
  const firstName = lead.contact?.firstName || (lead.contact?.name || "").split(" ")[0] || "there";
  const portalUrl = lead.portalUrl || `${baseUrl}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  const vars = { firstName, portalUrl, total };

  const subject = fill(tpl.subject, vars);
  const headline = fill(tpl.headline, vars);
  const body = fill(tpl.body, vars);

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="padding: 24px 28px; background: #1B4D2E; border-radius: 8px 8px 0 0;">
    <div style="color: #EAF3DE; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;">PJL Land Services</div>
    <h1 style="margin: 6px 0 0; color: #fff; font-size: 22px;">${escapeHtml(headline)}</h1>
  </div>
  <div style="padding: 24px 28px; background: #FAFAF5; border: 1px solid #e5e5dd; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="margin: 0 0 18px;">${escapeHtml(body)}</p>
    <p style="margin: 0 0 18px;">
      <a href="${escapeHtml(portalUrl)}" style="display: inline-block; padding: 11px 20px; background: #E07B24; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">Open your portal</a>
    </p>
    <p style="margin: 24px 0 0; font-size: 13px; color: #777;">
      Questions? Call <a href="tel:+19059600181" style="color: #1B4D2E;">(905) 960-0181</a> or reply to this email.
    </p>
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #999; text-align: center;">
    PJL Land Services · Newmarket, Ontario · pjllandservices.com
  </p>
</div>`.trim();

  const text = [
    headline,
    "",
    body,
    "",
    `Open your portal: ${portalUrl}`,
    "",
    "Questions? Call (905) 960-0181.",
    "PJL Land Services — Newmarket, Ontario"
  ].join("\n");

  return { subject, html, text };
}

function buildSms(event, lead, baseUrl) {
  const tpl = TEMPLATES[event];
  if (!tpl) return "";
  const portalUrl = lead.portalUrl || `${baseUrl}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  return fill(tpl.sms, { portalUrl, total });
}

async function sendCustomerEmail(event, lead, baseUrl) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[customer-email] Skipped (no Gmail config) — event=${event} lead=${lead.id}`);
    return { ok: false, skipped: true };
  }
  const to = (lead.contact?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on lead" };
  const built = buildEmail(event, lead, baseUrl || "");
  if (!built) return { ok: false, skipped: true, reason: `unknown event ${event}` };
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject: built.subject,
      html: built.html,
      text: built.text
    });
    console.log(`[customer-email] event=${event} sent to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[customer-email] event=${event} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

async function sendCustomerSms(event, lead, baseUrl) {
  if (!smsConfigured()) {
    console.warn(`[customer-sms] Skipped (no Twilio config) — event=${event} lead=${lead.id}`);
    return { ok: false, skipped: true };
  }
  const to = (lead.contact?.phone || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no phone on lead" };
  const body = buildSms(event, lead, baseUrl || "");
  if (!body) return { ok: false, skipped: true };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const payload = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_FROM_NUMBER,
    Body: body
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: payload.toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[customer-sms] event=${event} Twilio rejected:`, response.status, data?.message);
      return { ok: false, error: data?.message };
    }
    console.log(`[customer-sms] event=${event} sent to=${to} sid=${data.sid}`);
    return { ok: true, sid: data.sid };
  } catch (error) {
    console.error(`[customer-sms] event=${event} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

// Maps a CRM status transition to an event key. Returns null if the transition
// shouldn't trigger a customer notification.
function eventForTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return null;
  if (toStatus === "contacted") return "reviewed";
  if (toStatus === "site_visit") return "site_visit";
  if (toStatus === "quoted") return "quoted";
  if (toStatus === "won") return "booked";
  return null;
}

// Public API — fire-and-forget. The caller doesn't await this; failures are
// logged but never block the user-facing CRM action.
function notifyCustomer(event, lead, { baseUrl } = {}) {
  return Promise.allSettled([
    sendCustomerEmail(event, lead, baseUrl),
    sendCustomerSms(event, lead, baseUrl)
  ]);
}

module.exports = { notifyCustomer, eventForTransition };

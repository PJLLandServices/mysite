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

// Per-event subject + email body + SMS body. {firstName}, {portalUrl},
// {total}, {serviceLabel}, {dateStr}, {timeStr}, {workOrderId} are
// substituted by the caller with whatever's available on the lead.
//
// Two distinct customer states drive the template choice:
//
//   "request"  — came in via the contact form / general intake. No slot,
//                no work order, no commitment. Language stays in the
//                "we've received your request, will follow up" register.
//
//   "service"  — came in via /book.html with a confirmed slot, work order,
//                and price. Language shifts to "your service is booked /
//                scheduled" — these are confirmed appointments, not
//                requests. Subject lines lead with the booked service so
//                they read clearly in inbox previews.
const TEMPLATES = {
  // --- Request track (general inquiries from contact.html etc.) ---
  received: {
    subject: "PJL Land Services has received your request",
    headline: "We've got your request.",
    body:
      "Hi {firstName}, this is PJL Land Services confirming we've received your request. " +
      "Patrick personally reviews every inquiry — you'll hear back within one business day. " +
      "If it's urgent, call (905) 960-0181.",
    sms: "{namePrefix}PJL Land Services received your request. Patrick will be in touch within 1 business day. Track it: {portalUrl}"
  },
  reviewed: {
    subject: "PJL Land Services has reviewed your request",
    headline: "We've reviewed your request.",
    body:
      "Hi {firstName}, Patrick at PJL Land Services has reviewed your request and will reach out " +
      "to walk through next steps. Your project details are saved in your portal.",
    sms: "{namePrefix}PJL has reviewed your request. Patrick will reach out next. Portal: {portalUrl}"
  },
  quoted: {
    subject: "Your PJL quote is ready",
    headline: "Your quote is ready.",
    body:
      "Hi {firstName}, your PJL Land Services quote is ready to review. Open your portal to see the " +
      "scope, the price, and accept the quote when you're ready. Estimated total: {total}.",
    sms: "{namePrefix}your PJL quote is ready ({total}). Review and accept in your portal: {portalUrl}"
  },

  // --- Service track (confirmed bookings from /book.html) ---
  booked: {
    subject: "Your PJL service is booked — {serviceLabel} on {dateStr}",
    headline: "Your service is booked.",
    body:
      "Hi {firstName}, this confirms your PJL Land Services {serviceLabel} on {dateStr} at {timeStr}. " +
      "Your work order ({workOrderId}) is ready in your portal. We'll send a reminder the day before " +
      "and your technician will keep you updated as they head out to your property. " +
      "If anything changes, call (905) 960-0181 — we're happy to reschedule.",
    sms: "{namePrefix}your PJL service is confirmed: {serviceLabel} on {dateStr} at {timeStr}. Work order {workOrderId}. Details: {portalUrl}"
  },
  site_visit: {
    subject: "Your PJL site visit is scheduled — {dateStr}",
    headline: "Your site visit is scheduled.",
    body:
      "Hi {firstName}, your PJL Land Services site visit is scheduled for {dateStr} at {timeStr}. " +
      "Patrick will walk your property, scope the work, and follow up with a written quote. " +
      "Your work order ({workOrderId}) is in your portal — no charge for the visit.",
    sms: "{namePrefix}your PJL site visit is scheduled: {dateStr} at {timeStr}. Free walkaround. Details: {portalUrl}"
  },
  // Fired manually from the tech's daily-schedule view when they tap
  // "Notify on route" before driving over. Short, direct — the tech is
  // about to be at the door, the customer just needs to know.
  on_route: {
    subject: "PJL is on the way — {serviceLabel}",
    headline: "We're on the way.",
    body:
      "Hi {firstName}, this is PJL Land Services. Patrick is on his way to your property for your " +
      "{serviceLabel}. We'll see you soon — if you need to flag anything (gate codes, dogs, parking), " +
      "just call or text (905) 960-0181.",
    sms: "{namePrefix}PJL is on the way for your {serviceLabel}. See you soon. Questions? (905) 960-0181"
  }
};

function fill(template, vars) {
  return Object.keys(vars).reduce(
    (out, key) => out.replace(new RegExp(`\\{${key}\\}`, "g"), vars[key] ?? ""),
    template
  );
}

// Format a booking start time into customer-facing date/time strings.
// Eastern Time is enforced server-wide via process.env.TZ in server.js,
// so toLocale* will produce the right zone naturally.
function bookingDateTime(lead) {
  const start = lead.booking?.start ? new Date(lead.booking.start) : null;
  if (!start || Number.isNaN(start.getTime())) return { dateStr: "", timeStr: "" };
  return {
    dateStr: start.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" }),
    timeStr: start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
  };
}

function buildEmail(event, lead, baseUrl) {
  const tpl = TEMPLATES[event];
  if (!tpl) return null;
  const rawName = lead.contact?.firstName || (lead.contact?.name || "").split(" ")[0] || "";
  const firstName = rawName || "there";
  // {namePrefix} resolves to "Hi Patrick, " when we know their name and to ""
  // when we don't — keeps SMS / short copy from reading "Hi , your service…".
  const namePrefix = rawName ? `Hi ${rawName}, ` : "";
  // Strip any trailing slash on baseUrl — PUBLIC_BASE_URL on Render can
  // carry one, and we don't want "...com//portal/<token>".
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  const { dateStr, timeStr } = bookingDateTime(lead);
  const serviceLabel = lead.booking?.serviceLabel || "your appointment";
  const workOrderId = lead.booking?.workOrder?.id || "";
  const vars = { firstName, namePrefix, portalUrl, total, dateStr, timeStr, serviceLabel, workOrderId };

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
  const rawName = lead.contact?.firstName || (lead.contact?.name || "").split(" ")[0] || "";
  const namePrefix = rawName ? `Hi ${rawName}, ` : "";
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  const { dateStr, timeStr } = bookingDateTime(lead);
  const serviceLabel = lead.booking?.serviceLabel || "your appointment";
  const workOrderId = lead.booking?.workOrder?.id || "";
  return fill(tpl.sms, { namePrefix, portalUrl, total, dateStr, timeStr, serviceLabel, workOrderId });
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

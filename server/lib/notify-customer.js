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
  // Sent when a booking is rescheduled — fires regardless of who
  // initiated (customer self-serve via portal, or Patrick from the CRM).
  // Customer always gets the confirmation so they have a written record
  // of the new time. Patrick gets paged separately when the customer is
  // the one who moved it (handled in server.js).
  rescheduled: {
    subject: "Your PJL appointment moved to {dateStr}",
    headline: "Your appointment has been rescheduled.",
    body:
      "Hi {firstName}, your PJL Land Services {serviceLabel} has been moved to {dateStr} at {timeStr}. " +
      "Your work order ({workOrderId}) is up to date in your portal. " +
      "If this new time doesn't work, call (905) 960-0181 — we'll find another slot.",
    sms: "{namePrefix}your PJL appointment moved to {dateStr} at {timeStr}. WO {workOrderId}. Details: {portalUrl}. Different time? (905) 960-0181"
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
//
// Bucket-mode: when lead.booking carries bucketLabel ("Morning
// Appointment") + bucketWindow ("8 AM – 12 PM"), we substitute those
// for the precise time so confirmation emails read "your service is
// booked on Tuesday May 14 — Morning Appointment (8 AM – 12 PM)"
// instead of leaking a precise arrival hour. Patrick's rule: customers
// never see a precise time on customer-facing surfaces.
function bookingDateTime(lead) {
  const start = lead.booking?.start ? new Date(lead.booking.start) : null;
  if (!start || Number.isNaN(start.getTime())) return { dateStr: "", timeStr: "" };
  const bucketLabel = lead.booking?.bucketLabel;
  const bucketWindow = lead.booking?.bucketWindow;
  // Bucket replaces the precise time. timeStr is what the {timeStr}
  // template placeholder substitutes, so "...at {timeStr}" reads
  // "...at Morning Appointment (8 AM – 12 PM)" without touching any
  // template body. Legacy bookings without a bucket fall back to the
  // hour:minute display.
  const timeStr = bucketLabel
    ? (bucketWindow ? `${bucketLabel} (${bucketWindow})` : bucketLabel)
    : start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  return {
    dateStr: start.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" }),
    timeStr
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
  // Same publicBaseUrl pattern as the invoice + receipt templates so
  // the embedded logo's absolute src resolves correctly when this
  // email lands in any inbox.
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || baseUrl || "https://pjllandservices.com").replace(/\/+$/, "");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="background: #1B4D2E; border-radius: 8px 8px 0 0; padding: 24px 28px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td valign="middle" style="padding-right: 16px;">
          <h1 style="margin: 0; color: #fff; font-size: 22px; font-weight: 700; line-height: 1.2;">${escapeHtml(headline)}</h1>
        </td>
        <td valign="middle" align="right" width="180" style="width: 180px;">
          <img src="${escapeHtml(publicBaseUrl)}/crm/pjl-logo.svg"
               alt="PJL Land Services"
               width="180"
               style="display:block;border:0;outline:none;text-decoration:none;width:180px;max-width:180px;height:auto;">
        </td>
      </tr>
    </table>
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

// ---- Invoice send (PR 2) -------------------------------------------------
// Customer-facing invoice email with the branded PDF attached. Modeled on
// notify-supplier.js's sendPurchaseOrderEmail. Throws if Gmail isn't
// configured or if the recipient email is missing — the caller (server.js
// /send route) surfaces those as user-facing errors so the admin can fix
// them. This function does NOT mutate the invoice record; the route
// handler is responsible for status / sentAt / audit on success.
//
// Inputs:
//   invoice    — the local PJL invoice record (server/lib/invoices.js shape)
//   pdfBuffer  — Buffer of the rendered PDF (from server/lib/invoice-pdf.js)
//   options    — { resend, viewLink, eTransferEmail }
//                  resend         — when true, subject prefix becomes "Invoice
//                                   reminder:" instead of "Your invoice"
//                  viewLink       — optional URL for the "View and pay" CTA.
//                                   Hidden in the email if absent (PR 2
//                                   default — PR 3 supplies the embedded
//                                   /pay/invoice/:id?t=... URL).
//                  eTransferEmail — recipient e-Transfer address (defaults
//                                   to GMAIL_USER if unset).
//
// Returns { ok: true, messageId } on success, throws on failure.

const fsSync = require("node:fs");
const path = require("node:path");

const TEMPLATE_PATH = path.resolve(__dirname, "templates", "invoice-email.html");
let _templateCache = null;
function loadTemplate() {
  if (_templateCache) return _templateCache;
  const raw = fsSync.readFileSync(TEMPLATE_PATH, "utf8");
  // Split HTML body from text fallback at the <!-- TEXT --> marker.
  const idx = raw.indexOf("<!-- TEXT -->");
  let html, text;
  if (idx === -1) {
    html = raw;
    text = "";
  } else {
    html = raw.slice(0, idx).trim();
    text = raw.slice(idx + "<!-- TEXT -->".length).trim();
  }
  // Strip the leading documentation HTML comment from the rendered body
  // so we don't ship 400-odd bytes of internal docs into every email.
  // Drops only the FIRST <!-- ... --> if it appears at byte 0; downstream
  // comments (used for control flow inside the markup) survive.
  if (html.startsWith("<!--")) {
    const end = html.indexOf("-->");
    if (end !== -1) html = html.slice(end + 3).trim();
  }
  _templateCache = { html, text };
  return _templateCache;
}

// Mustache-lite — replace every {{key}} (or {{a.b}}) with vars[key]. Missing
// keys render as empty strings rather than throwing, which matches the
// "best effort" behaviour of the rest of the notify-customer module.
function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, dotted) => {
    const parts = dotted.split(".");
    let cur = vars;
    for (const p of parts) {
      if (cur == null) return "";
      cur = cur[p];
    }
    return cur == null ? "" : String(cur);
  });
}

function moneyTextCurrency(amount) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(Number(amount || 0));
}

async function sendInvoiceToCustomer(invoice, pdfBuffer, opts = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("Email is not configured on this server (set GMAIL_USER + GMAIL_APP_PASSWORD).");
  }
  const to = (invoice?.customerEmail || "").trim();
  if (!to) throw new Error("Invoice has no customer email — add one to the invoice before sending.");
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error("Invoice PDF buffer is empty.");
  }

  const { html: htmlTpl, text: textTpl } = loadTemplate();
  const firstName = (invoice.customerName || "").trim().split(/\s+/)[0] || "there";
  const totalFormatted = moneyTextCurrency(invoice.total);
  const eTransferEmail = (opts.eTransferEmail || process.env.GMAIL_USER || "info@pjllandservices.com").trim();
  const viewLink = (opts.viewLink || "").trim();
  const viewLinkVisible = viewLink ? "block" : "none";
  // For the plain-text body, render either the link line or a blank.
  const viewLinkText = viewLink
    ? `View and pay online: ${viewLink}\n\n`
    : "";

  // Plain-text payment instructions — duplicated into the HTML "Ways to
  // pay" block so the same copy appears in both formats.
  const paymentInstructionsText =
    `E-Transfer: ${eTransferEmail}\n` +
    `Or pay by credit card via the secure payment link above (when available), ` +
    `or just call (905) 960-0181 and we'll take care of it on the phone.`;
  const paymentInstructionsHtml =
    `<strong>E-Transfer:</strong> <a href="mailto:${escapeHtml(eTransferEmail)}" style="color:#1B4D2E;text-decoration:none;">${escapeHtml(eTransferEmail)}</a><br>` +
    `Credit card payments are accepted via the secure link above (when available). ` +
    `Prefer to pay by phone? Call <a href="tel:+19059600181" style="color:#1B4D2E;text-decoration:none;">(905) 960-0181</a>.`;

  // Public base URL — used to resolve email-embedded image src (logo).
  // PUBLIC_BASE_URL is set on Render (currently the onrender URL,
  // updated to pjllandservices.com after DNS cutover). Email clients
  // need an absolute URL on `<img src>` since they have no way to
  // resolve relative paths.
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || opts.publicBaseUrl || "https://pjllandservices.com").replace(/\/+$/, "");

  const vars = {
    customer: { firstName: escapeHtml(firstName) },
    invoice: {
      number: escapeHtml(invoice.id || ""),
      totalFormatted: escapeHtml(totalFormatted)
    },
    paymentInstructions: paymentInstructionsHtml,
    viewLink: escapeHtml(viewLink),
    viewLinkVisible,
    publicBaseUrl: escapeHtml(publicBaseUrl)
  };
  // Plain-text variant uses non-escaped content (no HTML rendering).
  const textVars = {
    customer: { firstName },
    invoice: { number: invoice.id || "", totalFormatted },
    paymentInstructions: paymentInstructionsText,
    viewLinkText,
    publicBaseUrl
  };

  const html = renderTemplate(htmlTpl, vars);
  const text = renderTemplate(textTpl, textVars);

  const subjectPrefix = opts.resend ? "Invoice reminder" : "Your invoice";
  const subject = `${subjectPrefix} ${invoice.id || ""} — ${totalFormatted} — PJL Land Services`;

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject,
      html,
      text,
      attachments: [{
        filename: `${invoice.id || "invoice"}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf"
      }]
    });
    console.log(`[invoice-email] sent invoice=${invoice.id} to=${to} id=${info.messageId}${opts.resend ? " (resend)" : ""}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[invoice-email] failed for invoice=${invoice.id}:`, error.message);
    throw new Error(`Email send failed: ${error.message}`);
  }
}

// ---- Payment receipt email (PR 3) ---------------------------------------
// Customer-facing payment receipt sent after a successful charge. Uses
// the same template-loading pattern as sendInvoiceToCustomer; same
// transport (Gmail SMTP); same fire-and-throw failure mode (caller
// surfaces the error if Gmail is down).
//
// Triggered from server.js's /api/pay/invoice/:id/charge handler after
// invoices.update({ status: 'paid' }) succeeds. Failure to send the
// receipt does NOT roll back the charge — receipt failure is logged
// and surfaced as a non-blocking warning in the response.
//
// PDF attachment: included. Same shape as sendInvoiceToCustomer's
// attachment so the customer has the original invoice in their email
// trail alongside the receipt confirmation.

const RECEIPT_TEMPLATE_PATH = path.resolve(__dirname, "templates", "payment-receipt-email.html");
let _receiptTemplateCache = null;
function loadReceiptTemplate() {
  if (_receiptTemplateCache) return _receiptTemplateCache;
  const raw = fsSync.readFileSync(RECEIPT_TEMPLATE_PATH, "utf8");
  const idx = raw.indexOf("<!-- TEXT -->");
  let html, text;
  if (idx === -1) {
    html = raw;
    text = "";
  } else {
    html = raw.slice(0, idx).trim();
    text = raw.slice(idx + "<!-- TEXT -->".length).trim();
  }
  if (html.startsWith("<!--")) {
    const end = html.indexOf("-->");
    if (end !== -1) html = html.slice(end + 3).trim();
  }
  _receiptTemplateCache = { html, text };
  return _receiptTemplateCache;
}

async function sendPaymentReceipt(invoice, pdfBuffer, opts = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error("Email is not configured on this server (set GMAIL_USER + GMAIL_APP_PASSWORD).");
  }
  const to = (invoice?.customerEmail || "").trim();
  if (!to) throw new Error("Invoice has no customer email — can't send receipt.");

  const { html: htmlTpl, text: textTpl } = loadReceiptTemplate();
  const firstName = (invoice.customerName || "").trim().split(/\s+/)[0] || "there";
  const totalFormatted = moneyTextCurrency(invoice.total);
  const paidDate = invoice.paidAt
    ? new Date(invoice.paidAt).toLocaleDateString("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric", month: "long", day: "numeric"
      })
    : new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric", month: "long", day: "numeric"
      });
  const chargeId = invoice.quickbooksChargeId || invoice.stripeChargeId || "";
  const confirmationVisible = chargeId ? "table-row" : "none";
  const confirmationLineText = chargeId ? `Confirmation:  ${chargeId}\n` : "";

  // Same publicBaseUrl pattern as sendInvoiceToCustomer — used for the
  // email-embedded logo src. Defaults to the production custom domain
  // so even if PUBLIC_BASE_URL is unset somehow, the email still loads.
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || opts.publicBaseUrl || "https://pjllandservices.com").replace(/\/+$/, "");

  const vars = {
    customer: { firstName: escapeHtml(firstName) },
    invoice: {
      number: escapeHtml(invoice.id || ""),
      totalFormatted: escapeHtml(totalFormatted),
      paidDate: escapeHtml(paidDate),
      chargeId: escapeHtml(chargeId)
    },
    confirmationVisible,
    publicBaseUrl: escapeHtml(publicBaseUrl)
  };
  const textVars = {
    customer: { firstName },
    invoice: {
      number: invoice.id || "",
      totalFormatted,
      paidDate,
      chargeId
    },
    confirmationLineText,
    publicBaseUrl
  };

  const html = renderTemplate(htmlTpl, vars);
  const text = renderTemplate(textTpl, textVars);
  const subject = `Receipt — invoice ${invoice.id || ""} — ${totalFormatted} — PJL Land Services`;

  const attachments = [];
  if (Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
    attachments.push({
      filename: `${invoice.id || "invoice"}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf"
    });
  }

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject,
      html,
      text,
      attachments
    });
    console.log(`[payment-receipt] sent invoice=${invoice.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[payment-receipt] failed for invoice=${invoice.id}:`, error.message);
    throw new Error(`Receipt email send failed: ${error.message}`);
  }
}

// ---- Magic-link login + admin password reset emails --------------------
//
// Both reuse the Gmail transport configured at the top of this file. Same
// branded shell as the lifecycle templates so the sender is recognizable.
// We do NOT log the magic-link URL — only that an email was attempted —
// since logs can leak credentials. The token is short-lived and single-
// use, but defense-in-depth still applies.

function brandedEmail({ headline, bodyHtml, bodyText, ctaLabel, ctaUrl, footerNote, baseUrl }) {
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || baseUrl || "https://pjllandservices.com").replace(/\/+$/, "");
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="background: #1B4D2E; border-radius: 8px 8px 0 0; padding: 24px 28px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td valign="middle" style="padding-right: 16px;">
          <h1 style="margin: 0; color: #fff; font-size: 22px; font-weight: 700; line-height: 1.2;">${escapeHtml(headline)}</h1>
        </td>
        <td valign="middle" align="right" width="180" style="width: 180px;">
          <img src="${escapeHtml(publicBaseUrl)}/crm/pjl-logo.svg" alt="PJL Land Services" width="180" style="display:block;border:0;outline:none;text-decoration:none;width:180px;max-width:180px;height:auto;">
        </td>
      </tr>
    </table>
  </div>
  <div style="padding: 24px 28px; background: #FAFAF5; border: 1px solid #e5e5dd; border-top: none; border-radius: 0 0 8px 8px;">
    <div style="margin: 0 0 18px;">${bodyHtml}</div>
    <p style="margin: 0 0 18px;">
      <a href="${escapeHtml(ctaUrl)}" style="display: inline-block; padding: 11px 20px; background: #E07B24; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">${escapeHtml(ctaLabel)}</a>
    </p>
    <p style="margin: 12px 0 0; font-size: 12px; color: #777; word-break: break-all;">If the button doesn't work, paste this link into your browser:<br>${escapeHtml(ctaUrl)}</p>
    ${footerNote ? `<p style="margin: 18px 0 0; font-size: 13px; color: #777;">${footerNote}</p>` : ""}
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #999; text-align: center;">
    PJL Land Services · Newmarket, Ontario · pjllandservices.com
  </p>
</div>`.trim();

  const text = [
    headline,
    "",
    bodyText,
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    footerNote ? footerNote.replace(/<[^>]+>/g, "") : "",
    "PJL Land Services — Newmarket, Ontario"
  ].filter(Boolean).join("\n");

  return { html, text };
}

// Customer-portal magic-link email. Triggered from
// POST /api/portal/request-link when a matched lead has an email on file.
// `lead` is the canonical lead record; `magicLink` is the absolute URL
// embedding the magic-token id (already built by the caller).
async function sendCustomerLoginLink(lead, magicLink) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[customer-login] Skipped (no Gmail config) — leadId=${lead?.id}`);
    return { ok: false, skipped: true };
  }
  const to = String(lead?.contact?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on lead" };

  const rawName = lead?.contact?.firstName || (lead?.contact?.name || "").split(" ")[0] || "";
  const firstName = rawName || "there";
  const greeting = `Hi ${escapeHtml(firstName)},`;

  const { html, text } = brandedEmail({
    headline: "Sign in to your PJL portal",
    bodyHtml: `
      <p style="margin: 0 0 12px;">${greeting}</p>
      <p style="margin: 0 0 12px;">You asked for a login link to your PJL Land Services portal. Click the button below to sign in. The link is valid for <strong>30 minutes</strong> and can be used once.</p>
    `,
    bodyText: [
      `Hi ${firstName},`,
      "",
      "You asked for a login link to your PJL Land Services portal. The link below is valid for 30 minutes and can be used once."
    ].join("\n"),
    ctaLabel: "Sign in to your portal",
    ctaUrl: magicLink,
    footerNote: `Didn't request this? You can ignore this email — your portal stays private. If the link doesn't work, call us at <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a>.`
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject: "Your PJL Land Services portal login link",
      html,
      text
    });
    console.log(`[customer-login] sent leadId=${lead.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[customer-login] failed leadId=${lead?.id}:`, error.message);
    return { ok: false, error: error.message };
  }
}

// Admin/tech password-reset email. Triggered from
// POST /api/users/:id/reset-password. `user` is the public-shape user
// record from lib/users.js; `magicLink` already embeds the token.
async function sendAdminPasswordResetLink(user, magicLink) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[admin-reset] Skipped (no Gmail config) — userId=${user?.id}`);
    return { ok: false, skipped: true };
  }
  const to = String(user?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on user" };

  const greeting = `Hi ${escapeHtml((user.name || "").split(" ")[0] || "there")},`;
  const { html, text } = brandedEmail({
    headline: "Reset your PJL CRM password",
    bodyHtml: `
      <p style="margin: 0 0 12px;">${greeting}</p>
      <p style="margin: 0 0 12px;">An administrator started a password reset for your PJL CRM account. Click the button below to choose a new password. The link is valid for <strong>30 minutes</strong> and can be used once.</p>
    `,
    bodyText: [
      `Hi ${(user.name || "").split(" ")[0] || "there"},`,
      "",
      "An administrator started a password reset for your PJL CRM account. The link below is valid for 30 minutes and can be used once."
    ].join("\n"),
    ctaLabel: "Choose a new password",
    ctaUrl: magicLink,
    footerNote: `Didn't expect this? Ignore this email — your existing password still works. If you have questions, contact PJL at <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a>.`
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject: "Reset your PJL CRM password",
      html,
      text
    });
    console.log(`[admin-reset] sent userId=${user.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[admin-reset] failed userId=${user?.id}:`, error.message);
    return { ok: false, error: error.message };
  }
}

// Cancellation email — sent when an admin cancels a booking via
// `/admin/schedule`. Matter-of-fact tone (no fall-closing upsell, no
// apology theatre). Caller passes the canonical booking record + the
// reason text the admin entered. `notify` defaults to true; when false
// this returns { ok: true, skipped: true } without touching SMTP — used
// when Patrick unchecks the "Notify customer by email" checkbox.
async function sendBookingCancellation(booking, { reason = "", notify = true, baseUrl } = {}) {
  if (!notify) return { ok: true, skipped: true, reason: "notify=false" };
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[booking-cancel] Skipped (no Gmail config) — bookingId=${booking?.id}`);
    return { ok: false, skipped: true };
  }
  const to = String(booking?.customerEmail || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on booking" };

  const rawName = (booking.customerName || "").split(" ")[0] || "";
  const greeting = rawName ? `Hi ${escapeHtml(rawName)},` : "Hi there,";
  const serviceLabel = booking.serviceLabel || "appointment";
  const start = booking.scheduledFor ? new Date(booking.scheduledFor) : null;
  const dateStr = (start && !Number.isNaN(start.getTime()))
    ? start.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" })
    : "";
  const timeStr = (start && !Number.isNaN(start.getTime()))
    ? start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
    : "";
  const whenText = (dateStr && timeStr)
    ? `<strong>${escapeHtml(dateStr)}</strong> at <strong>${escapeHtml(timeStr)}</strong>`
    : "your scheduled time";
  const reasonText = String(reason || "").trim();
  // Public base URL: a deep link back to the booking page on the public
  // site (book.html) so the customer can re-book in one click if they
  // want. No coupon, no upsell, no pushy CTAs.
  const publicBase = (process.env.PUBLIC_BASE_URL || baseUrl || "https://pjllandservices.com").replace(/\/+$/, "");
  const ctaUrl = `${publicBase}/book.html`;

  const { html, text } = brandedEmail({
    headline: "Your appointment has been cancelled",
    bodyHtml: `
      <p style="margin: 0 0 12px;">${greeting}</p>
      <p style="margin: 0 0 12px;">We've cancelled your ${escapeHtml(serviceLabel)} for ${whenText}.</p>
      ${reasonText ? `<p style="margin: 0 0 12px;"><strong>Reason:</strong> ${escapeHtml(reasonText)}</p>` : ""}
      <p style="margin: 0 0 12px;">If you'd like to re-book a different time, the link below takes you to our online booking page. If you'd rather we sort it out by phone, just give us a call.</p>
    `,
    bodyText: [
      `Hi ${rawName || "there"},`,
      "",
      `We've cancelled your ${serviceLabel}${dateStr ? ` for ${dateStr}` : ""}${timeStr ? ` at ${timeStr}` : ""}.`,
      reasonText ? `Reason: ${reasonText}` : "",
      "",
      "If you'd like to re-book a different time, visit our online booking page. Or call us to sort it out by phone."
    ].filter(Boolean).join("\n"),
    ctaLabel: "Re-book online",
    ctaUrl,
    footerNote: `Questions? Call PJL at <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a> or reply to this email.`,
    baseUrl
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject: `Appointment cancelled — PJL Land Services`,
      html,
      text
    });
    console.log(`[booking-cancel] sent bookingId=${booking.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[booking-cancel] failed bookingId=${booking?.id}:`, error.message);
    return { ok: false, error: error.message };
  }
}

// Admin-side email when a customer sends a portal message. Includes the
// full message text + a CTA link to /admin/messages so Patrick can read
// the message inline AND jump straight to the thread to reply. Goes to
// NOTIFY_TO_EMAIL (or GMAIL_USER fallback) — same recipient as the
// existing new-lead alerts.
async function sendPortalMessageAlertEmail(lead, message, { baseUrl } = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[portal-msg-alert] Skipped (no Gmail config) — leadId=${lead?.id}`);
    return { ok: false, skipped: true };
  }
  const to = process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER;
  if (!to) return { ok: false, skipped: true, reason: "no admin email configured" };
  const customerName = lead?.contact?.name || "A customer";
  const phone = lead?.contact?.phone || "";
  const messagesLink = (process.env.PUBLIC_BASE_URL || baseUrl || "https://pjllandservices.com").replace(/\/+$/, "") + "/admin/messages";
  const { html, text } = brandedEmail({
    headline: "New portal message",
    bodyHtml: `
      <p style="margin: 0 0 12px;"><strong>${escapeHtml(customerName)}</strong>${phone ? ` &middot; ${escapeHtml(phone)}` : ""} sent a message via the customer portal:</p>
      <blockquote style="margin: 0 0 16px; padding: 12px 14px; background: #fff; border-left: 3px solid #1B4D2E; font-style: italic; color: #1A1A1A;">${escapeHtml(message).replace(/\n/g, "<br>")}</blockquote>
      <p style="margin: 0 0 8px;">Reply from the Messages inbox below.</p>
    `,
    bodyText: [
      `${customerName}${phone ? ` (${phone})` : ""} sent a message via the customer portal:`,
      "",
      message,
      "",
      "Reply from the Messages inbox."
    ].join("\n"),
    ctaLabel: "Open Messages inbox",
    ctaUrl: messagesLink,
    footerNote: `Lead ID: ${escapeHtml(lead?.id || "")}`,
    baseUrl
  });
  try {
    const info = await transporter.sendMail({
      from: `"PJL Portal" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: lead?.contact?.email || undefined,
      subject: `Portal message from ${customerName}`,
      html,
      text
    });
    console.log(`[portal-msg-alert] sent leadId=${lead.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[portal-msg-alert] failed leadId=${lead?.id}:`, error.message);
    return { ok: false, error: error.message };
  }
}

// Customer-side email when the admin replies to a portal message.
// Notifies the customer that there's a new message waiting in their
// portal. Body includes the reply text inline so the customer doesn't
// have to log in to see it, but the CTA still opens the portal so they
// can respond in-thread.
async function sendPortalReplyToCustomer(lead, replyBody, { baseUrl } = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[portal-reply] Skipped (no Gmail config) — leadId=${lead?.id}`);
    return { ok: false, skipped: true };
  }
  const to = String(lead?.contact?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on lead" };
  const firstName = lead?.contact?.firstName || (lead?.contact?.name || "").split(" ")[0] || "";
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const publicBase = (process.env.PUBLIC_BASE_URL || baseUrl || "https://pjllandservices.com").replace(/\/+$/, "");
  const portalToken = lead?.portal?.token;
  const portalUrl = portalToken ? `${publicBase}/portal/${portalToken}` : `${publicBase}/portal`;
  const { html, text } = brandedEmail({
    headline: "PJL replied to your message",
    bodyHtml: `
      <p style="margin: 0 0 12px;">${greeting}</p>
      <p style="margin: 0 0 12px;">Patrick at PJL Land Services just sent you a reply via your customer portal:</p>
      <blockquote style="margin: 0 0 16px; padding: 12px 14px; background: #fff; border-left: 3px solid #1B4D2E; font-style: italic; color: #1A1A1A;">${escapeHtml(replyBody).replace(/\n/g, "<br>")}</blockquote>
      <p style="margin: 0 0 8px;">You can continue the conversation in your portal.</p>
    `,
    bodyText: [
      `Hi ${firstName || "there"},`,
      "",
      "Patrick at PJL Land Services just sent you a reply via your customer portal:",
      "",
      replyBody,
      "",
      "You can continue the conversation in your portal."
    ].join("\n"),
    ctaLabel: "Open my portal",
    ctaUrl: portalUrl,
    footerNote: `Questions? Call <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a>.`,
    baseUrl
  });
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to,
      replyTo: process.env.GMAIL_USER,
      subject: "PJL replied to your message",
      html,
      text
    });
    console.log(`[portal-reply] sent leadId=${lead.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[portal-reply] failed leadId=${lead?.id}:`, error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  notifyCustomer,
  eventForTransition,
  sendBookingCancellation,
  sendPortalMessageAlertEmail,
  sendPortalReplyToCustomer,
  sendInvoiceToCustomer,
  sendPaymentReceipt,
  sendCustomerLoginLink,
  sendAdminPasswordResetLink
};

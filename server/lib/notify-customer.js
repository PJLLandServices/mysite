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
//
// All outbound link hosts resolve via resolvePublicBaseUrl() — see
// server/lib/public-base-url.js. PUBLIC_BASE_URL is the authoritative
// source; the helper falls back to https://pjllandservices.com (or a
// localhost URL in non-prod) but never to the request's .onrender.com
// subdomain.

const { resolvePublicBaseUrl } = require("./public-base-url");
const { logSend } = require("./mailer-log");
// Invoice CC assembly (spouse + billing CC, deduped) lives with the rest of
// the billing-party model. Pure helper — billing-parties.js requires no
// siblings, so this is safe at load time.
const { buildInvoiceCcList } = require("./billing-parties");
const { documentFilename } = require("./format");

// The invoice PDF's name, wherever this module attaches one. Same
// convention as the download (server.js invoiceFilename) — deliberately
// so: the file a customer saves out of the email and the one Patrick
// downloads from the CRM must not be two different names for one
// document. Dated from the invoice, never from send time, so a resend
// cannot re-date an August document.
function invoiceAttachmentName(invoice) {
  return documentFilename({
    date: invoice?.sentAt || invoice?.createdAt,
    label: `${invoice?.id || "Invoice"} Invoice`,
    customerName: invoice?.customerName,
    address: invoice?.address
  });
}

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
      "Hi {firstName}, your PJL Land Services {serviceLabel} on {dateStr} at {timeStr} is confirmed. " +
      "Your work order ({workOrderId}) is available in your customer portal. If we run into any issues on our end, " +
      "we'll reach out directly. To make changes, use your portal or call us at (905) 960-0181.",
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
  // Day-before reminder for SELF-BOOKED appointments (Patrick,
  // 2026-09-02: assignment customers get a D−1 text from the cadence;
  // ad customers who booked themselves got nothing the day before).
  // Sent by the booking-reminders sweep — transactional, about their
  // own appointment, so seasonal-marketing opt-outs don't block it;
  // the "no need to contact" tick does.
  day_before: {
    subject: "Reminder: PJL comes tomorrow — {serviceLabel}",
    headline: "We'll see you tomorrow.",
    body:
      "Hi {firstName}, a friendly reminder that PJL Land Services comes tomorrow, {dateStr}, " +
      "for your {serviceLabel} — {timeStr}. Please make sure we can reach what we need to. " +
      "If anything has changed, call or text (905) 960-0181.",
    sms: "{namePrefix}reminder: PJL comes tomorrow ({dateStr}) for your {serviceLabel} — {timeStr}. Anything changed? (905) 960-0181. Details: {portalUrl}"
  },
  // "First available" — the customer joined the open bucket instead of
  // picking a day. No date exists yet, so no {dateStr}/{timeStr}; the
  // promise is the placement message they'll get when Patrick drops
  // them onto a route day (which sends the normal "booked" template).
  standby_joined: {
    subject: "You're on our route list — {serviceLabel}",
    headline: "You're on the list.",
    body:
      "Hi {firstName}, you're in! We've added your {serviceLabel} to our First Available list. " +
      "The next time our crew is working in your neighbourhood, we'll fit you in and confirm your " +
      "exact day ahead of time — usually within a couple of weeks. Nothing else to do for now. " +
      "If any dates absolutely don't work, reply here or call (905) 960-0181 and we'll plan around them.",
    sms: "{namePrefix}you're on PJL's First Available list for your {serviceLabel}. We'll confirm your exact day ahead of time when our crew is in your neighbourhood. Details: {portalUrl}"
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

function buildEmail(event, lead) {
  const tpl = TEMPLATES[event];
  if (!tpl) return null;
  const rawName = lead.contact?.firstName || (lead.contact?.name || "").split(" ")[0] || "";
  const firstName = rawName || "there";
  // {namePrefix} resolves to "Hi Patrick, " when we know their name and to ""
  // when we don't — keeps SMS / short copy from reading "Hi , your service…".
  const namePrefix = rawName ? `Hi ${rawName}, ` : "";
  const cleanBase = resolvePublicBaseUrl();
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  const { dateStr, timeStr } = bookingDateTime(lead);
  const serviceLabel = lead.booking?.serviceLabel || lead.standby?.serviceLabel || "your appointment";
  const workOrderId = lead.booking?.workOrder?.id || "";
  const vars = { firstName, namePrefix, portalUrl, total, dateStr, timeStr, serviceLabel, workOrderId };

  const subject = fill(tpl.subject, vars);
  const headline = fill(tpl.headline, vars);
  const body = fill(tpl.body, vars);
  // publicBaseUrl is the absolute origin used for email-embedded image
  // sources (the logo). Same resolver as the portal link above so the
  // logo and CTA always agree on host.
  const publicBaseUrl = cleanBase;

  // "Add your appointment to your calendar" (Patrick, 2026-09-02) — on
  // every email that names a scheduled visit. Google/Outlook open a
  // prefilled event; the .ics link covers Apple Calendar and the rest,
  // served by the tokened portal endpoint. The event carries the bucket
  // window the customer was told, never an exact internal time
  // (calendar-links.js owns that rule).
  let calendarRowHtml = "";
  let calendarRowText = "";
  if (["booked", "rescheduled", "site_visit", "day_before"].includes(event) && lead.booking?.start) {
    try {
      const calendarLinks = require("./calendar-links");
      const links = calendarLinks.linksForBooking({
        id: lead.id,
        start: lead.booking.start,
        durationMinutes: lead.booking.durationMinutes,
        bucketKey: lead.booking.bucketKey || null,
        serviceLabel: lead.booking.serviceLabel || "",
        address: lead.contact?.address || ""
      }, { portalUrl });
      const portalToken = lead.portal?.token || "";
      const icsUrl = portalToken ? `${cleanBase}/api/portal/${encodeURIComponent(portalToken)}/calendar.ics` : "";
      if (links) {
        calendarRowHtml = `
    <p style="margin: 0 0 18px; font-size: 14px;">
      Add it to your calendar:
      <a href="${escapeHtml(links.google)}" style="color: #1B4D2E; font-weight: 600;">Google</a> ·
      <a href="${escapeHtml(links.outlook)}" style="color: #1B4D2E; font-weight: 600;">Outlook</a>${icsUrl ? ` ·
      <a href="${escapeHtml(icsUrl)}" style="color: #1B4D2E; font-weight: 600;">Apple&nbsp;/&nbsp;other (.ics)</a>` : ""}
    </p>`;
        calendarRowText = `Add it to your calendar: ${links.google}${icsUrl ? `\nApple/other (.ics): ${icsUrl}` : ""}`;
      }
    } catch (err) {
      console.warn("[customer-email] calendar links skipped:", err?.message);
    }
  }

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
    </p>${calendarRowHtml}
    <p style="margin: 24px 0 0; font-size: 13px; color: #777;">
      Questions? Call <a href="tel:+19059600181" style="color: #1B4D2E;">(905) 960-0181</a> or reply to this email.
    </p>
  </div>
  <p style="margin: 16px 0 0; font-size: 12px; color: #888; text-align: center; line-height: 1.5;">
    To view or manage this appointment anytime, visit pjllandservices.com and tap Customer Login in the navigation bar. On mobile, tap the menu icon first.
  </p>
  <p style="margin: 12px 0 0; font-size: 11px; color: #999; text-align: center;">
    PJL Land Services · Newmarket, Ontario · pjllandservices.com
  </p>
</div>`.trim();

  const text = [
    headline,
    "",
    body,
    "",
    `Open your portal: ${portalUrl}`,
    calendarRowText ? "" : null,
    calendarRowText || null,
    "",
    "Questions? Call (905) 960-0181.",
    "PJL Land Services — Newmarket, Ontario"
  ].filter((line) => line !== null).join("\n");

  return { subject, html, text };
}

function buildSms(event, lead) {
  const tpl = TEMPLATES[event];
  if (!tpl) return "";
  const rawName = lead.contact?.firstName || (lead.contact?.name || "").split(" ")[0] || "";
  const namePrefix = rawName ? `Hi ${rawName}, ` : "";
  const cleanBase = resolvePublicBaseUrl();
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;
  const total = moneyText(lead.totals?.expectedTotal);
  const { dateStr, timeStr } = bookingDateTime(lead);
  const serviceLabel = lead.booking?.serviceLabel || lead.standby?.serviceLabel || "your appointment";
  const workOrderId = lead.booking?.workOrder?.id || "";
  return fill(tpl.sms, { namePrefix, portalUrl, total, dateStr, timeStr, serviceLabel, workOrderId });
}

async function sendCustomerEmail(event, lead) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[customer-email] Skipped (no Gmail config) — event=${event} lead=${lead.id}`);
    return { ok: false, skipped: true };
  }
  const to = (lead.contact?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on lead" };
  const built = buildEmail(event, lead);
  if (!built) return { ok: false, skipped: true, reason: `unknown event ${event}` };
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: built.subject,
      html: built.html,
      text: built.text
    });
    console.log(`[customer-email] event=${event} sent to=${to} id=${info.messageId}`);
    await logSend({ kind: "stage_notice", to, ok: true, refId: lead.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[customer-email] event=${event} failed:`, error.message);
    await logSend({ kind: "stage_notice", to, ok: false, error: error.message, refId: lead.id });
    return { ok: false, error: error.message };
  }
}

async function sendCustomerSms(event, lead) {
  if (!smsConfigured()) {
    console.warn(`[customer-sms] Skipped (no Twilio config) — event=${event} lead=${lead.id}`);
    return { ok: false, skipped: true };
  }
  const to = (lead.contact?.phone || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no phone on lead" };
  const body = buildSms(event, lead);
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
function notifyCustomer(event, lead) {
  return Promise.allSettled([
    sendCustomerEmail(event, lead),
    sendCustomerSms(event, lead)
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
  // Amount due ≠ invoice total once anything has been paid against it.
  // The email used to quote the total everywhere, so an invoice with
  // $500 collected on site went out asking for the full $2,260 while the
  // attached PDF and the pay page both said $1,760 — the customer's own
  // documents contradicted each other. "Total" survives where it really
  // means the value of the work; everywhere the copy means "what you
  // owe", it is amountDue.
  const invTotal = Number(invoice.total) || 0;
  const invAmountPaid = Number(invoice.amountPaid) || 0;
  const invAmountDue = invoice.balanceDue == null ? invTotal : Number(invoice.balanceDue) || 0;
  const amountDueFormatted = moneyTextCurrency(invAmountDue);
  const amountPaidFormatted = moneyTextCurrency(invAmountPaid);
  // The template engine does substitution only — no conditionals — so a
  // block that should appear on some invoices is toggled with a display
  // value, the same trick viewLinkVisible already uses below.
  const hasPayments = invAmountPaid > 0 && invAmountDue !== invTotal;
  const paidBlockVisible = hasPayments ? "block" : "none";
  const paidLineText = hasPayments
    ? `Invoice total:     ${totalFormatted}\n` +
      `Payments received: -${amountPaidFormatted}\n` +
      `Amount due:        ${amountDueFormatted}\n\n`
    : "";
  const eTransferEmail = (opts.eTransferEmail || process.env.ETRANSFER_EMAIL || "info@pjllandservices.com").trim();
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
  // Email clients need an absolute URL on `<img src>` since they have no
  // way to resolve relative paths. resolvePublicBaseUrl() honours
  // PUBLIC_BASE_URL when set, otherwise lands on pjllandservices.com.
  const publicBaseUrl = resolvePublicBaseUrl();

  const vars = {
    customer: { firstName: escapeHtml(firstName) },
    invoice: {
      number: escapeHtml(invoice.id || ""),
      totalFormatted: escapeHtml(totalFormatted),
      amountDueFormatted: escapeHtml(amountDueFormatted),
      amountPaidFormatted: escapeHtml(amountPaidFormatted),
      paidBlockVisible
    },
    paymentInstructions: paymentInstructionsHtml,
    viewLink: escapeHtml(viewLink),
    viewLinkVisible,
    publicBaseUrl: escapeHtml(publicBaseUrl)
  };
  // Plain-text variant uses non-escaped content (no HTML rendering).
  const textVars = {
    customer: { firstName },
    invoice: {
      number: invoice.id || "",
      totalFormatted,
      amountDueFormatted,
      amountPaidFormatted,
      paidLineText
    },
    paymentInstructions: paymentInstructionsText,
    viewLinkText,
    publicBaseUrl
  };

  const html = renderTemplate(htmlTpl, vars);
  const text = renderTemplate(textTpl, textVars);

  const subjectPrefix = opts.resend ? "Invoice reminder" : "Your invoice";
  // The subject line is read as "what do I owe", so it carries the amount
  // due. Identical to the total on every invoice with no payments.
  const subject = `${subjectPrefix} ${invoice.id || ""} — ${amountDueFormatted} — PJL Land Services`;

  // Spouse CC — opts.includeSpouse can override the profile flag
  // (true / false / null = use profile default).
  const spouseRecip = await resolveSpouseRecipients(invoice, opts.includeSpouse);
  // Billing CC (addendum, Jul 2026) — the bookkeeper / accounts-payable desk
  // the payer nominated. Read from the invoice's OWN billTo snapshot, never
  // re-resolved live: an issued invoice keeps whatever envelope it was sent
  // with, so editing the property's CC later can't change who was copied on
  // an invoice already sitting in the customer's inbox. Invoice path only —
  // quotes go to the signatory who accepts them, not the payer.
  const billingCc = String(invoice?.billTo?.ccEmail || "").trim().toLowerCase();
  const ccList = buildInvoiceCcList({
    to,
    spouseEmail: spouseRecip.spouseEmail,
    billingCcEmail: billingCc
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      ...(ccList.length ? { cc: ccList } : {}),
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject,
      html,
      text,
      // The invoice PDF always leads. `extraAttachments` carries the
      // optional accompanying letter (a repair summary / written record)
      // built by the caller; anything malformed is dropped rather than
      // handed to nodemailer, so a bad attachment can never stop an
      // invoice from reaching the customer.
      attachments: [
        {
          filename: invoiceAttachmentName(invoice),
          content: pdfBuffer,
          contentType: "application/pdf"
        },
        ...(Array.isArray(opts.extraAttachments) ? opts.extraAttachments : [])
          .filter((a) => a && a.filename && Buffer.isBuffer(a.content) && a.content.length > 0)
      ]
    });
    const extraCount = (Array.isArray(opts.extraAttachments) ? opts.extraAttachments : [])
      .filter((a) => a && a.filename && Buffer.isBuffer(a.content) && a.content.length > 0).length;
    console.log(`[invoice-email] sent invoice=${invoice.id} to=${to}${ccList.length ? ` cc=${ccList.join(",")}` : ""}${extraCount ? ` +${extraCount} attachment(s)` : ""} id=${info.messageId}${opts.resend ? " (resend)" : ""}`);
    await logSend({ kind: "invoice", to, ok: true, refId: invoice.id });
    // Both flags report what actually shipped, not what was configured — an
    // address deduped away (spouse same as the primary recipient, bookkeeper
    // same as the spouse) was NOT copied, and saying otherwise would make the
    // admin UI claim a delivery that never happened. ccSpouse keeps its
    // original meaning (a spouse was copied) rather than turning true for a
    // bookkeeper-only CC.
    const landed = (addr) => Boolean(addr) && ccList.includes(String(addr).trim().toLowerCase());
    return {
      ok: true,
      messageId: info.messageId,
      ccSpouse: landed(spouseRecip.spouseEmail),
      ccBilling: landed(billingCc)
    };
  } catch (error) {
    console.error(`[invoice-email] failed for invoice=${invoice.id}:`, error.message);
    await logSend({ kind: "invoice", to, ok: false, error: error.message, refId: invoice.id });
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
  // email-embedded logo src. resolvePublicBaseUrl() guarantees a usable
  // host even if PUBLIC_BASE_URL is unset.
  const publicBaseUrl = resolvePublicBaseUrl();

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
      filename: invoiceAttachmentName(invoice),
      content: pdfBuffer,
      contentType: "application/pdf"
    });
  }

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject,
      html,
      text,
      attachments
    });
    console.log(`[payment-receipt] sent invoice=${invoice.id} to=${to} id=${info.messageId}`);
    await logSend({ kind: "receipt", to, ok: true, refId: invoice.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[payment-receipt] failed for invoice=${invoice.id}:`, error.message);
    await logSend({ kind: "receipt", to, ok: false, error: error.message, refId: invoice.id });
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

function brandedEmail({ headline, bodyHtml, bodyText, ctaLabel, ctaUrl, footerNote }) {
  const publicBaseUrl = resolvePublicBaseUrl();
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
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
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

// Quote-accepted confirmation — INSTALLATION work only (2026-08-29).
//
// When a customer accepts an installation proposal we now write back to
// them: their approval landed, and we will be in touch to schedule. Before
// this, accepting a proposal sent the customer NOTHING (only Patrick got the
// alert, and only a deposit-enabled quote produced a customer email at all),
// so a homeowner who had just committed to a five-figure installation got
// silence and had no confirmation anything had registered.
//
// Repair work is deliberately excluded — the caller gates on
// quotes.isInstallationQuote(). A repair quote accepted on site is followed
// by the tech doing the work, not by a scheduling conversation, and Patrick
// does not want an approval email going out on that path.
//
// Best-effort like every other notification on the acceptance path: the
// caller wraps it, and a failure here must never disturb the acceptance
// record the customer just created.
async function sendQuoteAcceptedConfirmation(quote, {
  toEmail = "",
  customerName = "",
  approveUrl = "",
  depositAmountText = ""
} = {}) {
  const transporter = getTransporter();
  const to = String(toEmail || quote?.customerEmail || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no customer email" };
  if (!transporter) {
    console.warn(`[quote-accepted] Skipped (no Gmail config) — quoteId=${quote?.id}`);
    await logSend({ kind: "stage_notice", to, ok: false, error: "no Gmail config", refId: quote?.id });
    return { ok: false, skipped: true };
  }

  const rawName = String(customerName || "").trim().split(" ")[0];
  const firstName = rawName || "there";
  const displayId = (quote?.quoteNumberDisplay && String(quote.quoteNumberDisplay).trim()) || quote?.id || "";
  // "proposal" / "estimate" — the same noun the document itself used, so the
  // email doesn't rename the thing they just signed.
  const noun = quote?.branch === "residential_repair" ? "estimate" : "proposal";

  const depositHtml = depositAmountText
    ? `<p style="margin: 0 0 12px;">A deposit invoice for <strong>${escapeHtml(depositAmountText)}</strong> is on its way in a separate email — the installation is scheduled once that's settled.</p>`
    : "";
  const depositText = depositAmountText
    ? `A deposit invoice for ${depositAmountText} is on its way in a separate email — the installation is scheduled once that's settled.`
    : "";

  const { html, text } = brandedEmail({
    headline: "Your approval is in — thank you",
    bodyHtml: `
      <p style="margin: 0 0 12px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin: 0 0 12px;">We've received your signed approval for ${escapeHtml(noun)} <strong>${escapeHtml(displayId)}</strong>. It's on file and your installation is now in our queue.</p>
      ${depositHtml}
      <p style="margin: 0 0 12px;"><strong>What happens next:</strong> we'll be in touch shortly to book your installation dates and walk you through how the work will run on site. Nothing further is needed from you right now.</p>
    `,
    bodyText: [
      `Hi ${firstName},`,
      "",
      `We've received your signed approval for ${noun} ${displayId}. It's on file and your installation is now in our queue.`,
      depositText,
      "",
      "What happens next: we'll be in touch shortly to book your installation dates and walk you through how the work will run on site. Nothing further is needed from you right now."
    ].filter(Boolean).join("\n"),
    ctaLabel: "View your approved " + noun,
    ctaUrl: approveUrl || resolvePublicBaseUrl(),
    footerNote: `Questions before we start? Call us at <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a> or just reply to this email.`
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: `Approval received — ${displayId} · we'll be in touch to schedule`,
      html,
      text
    });
    await logSend({ kind: "stage_notice", to, ok: true, refId: quote?.id });
    console.log(`[quote-accepted] sent quoteId=${quote?.id} to=${to} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    await logSend({ kind: "stage_notice", to, ok: false, error: error.message, refId: quote?.id });
    console.error(`[quote-accepted] failed quoteId=${quote?.id}:`, error.message);
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
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: "Reset your PJL CRM password",
      html,
      text
    });
    console.log(`[admin-reset] sent userId=${user.id} to=${to} id=${info.messageId}`);
    await logSend({ kind: "other", to, ok: true, refId: user.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[admin-reset] failed userId=${user?.id}:`, error.message);
    await logSend({ kind: "other", to, ok: false, error: error.message, refId: user?.id });
    return { ok: false, error: error.message };
  }
}

// Cancellation email — sent when an admin cancels a booking via
// `/admin/schedule`. Matter-of-fact tone (no fall-closing upsell, no
// apology theatre). Caller passes the canonical booking record + the
// reason text the admin entered. `notify` defaults to true; when false
// this returns { ok: true, skipped: true } without touching SMTP — used
// when Patrick unchecks the "Notify customer by email" checkbox.
async function sendBookingCancellation(booking, { reason = "", notify = true } = {}) {
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
  const publicBase = resolvePublicBaseUrl();
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
    footerNote: `Questions? Call PJL at <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a> or reply to this email.`
  });

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: `Appointment cancelled — PJL Land Services`,
      html,
      text
    });
    console.log(`[booking-cancel] sent bookingId=${booking.id} to=${to} id=${info.messageId}`);
    await logSend({ kind: "booking_cancel", to, ok: true, refId: booking.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[booking-cancel] failed bookingId=${booking?.id}:`, error.message);
    await logSend({ kind: "booking_cancel", to, ok: false, error: error.message, refId: booking?.id });
    return { ok: false, error: error.message };
  }
}

// Admin-side email when a customer sends a portal message. Includes the
// full message text + a CTA link to /admin/messages so Patrick can read
// the message inline AND jump straight to the thread to reply. Goes to
// NOTIFY_TO_EMAIL (or GMAIL_USER fallback) — same recipient as the
// existing new-lead alerts.
async function sendPortalMessageAlertEmail(lead, message) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[portal-msg-alert] Skipped (no Gmail config) — leadId=${lead?.id}`);
    return { ok: false, skipped: true };
  }
  const to = process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER;
  if (!to) return { ok: false, skipped: true, reason: "no admin email configured" };
  const customerName = lead?.contact?.name || "A customer";
  const phone = lead?.contact?.phone || "";
  const messagesLink = `${resolvePublicBaseUrl()}/admin/messages`;
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
    footerNote: `Lead ID: ${escapeHtml(lead?.id || "")}`
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
    await logSend({ kind: "other", to, ok: true, refId: lead.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[portal-msg-alert] failed leadId=${lead?.id}:`, error.message);
    await logSend({ kind: "other", to, ok: false, error: error.message, refId: lead?.id });
    return { ok: false, error: error.message };
  }
}

// Customer-side email when the admin replies to a portal message.
// Notifies the customer that there's a new message waiting in their
// portal. Body includes the reply text inline so the customer doesn't
// have to log in to see it, but the CTA still opens the portal so they
// can respond in-thread.
async function sendPortalReplyToCustomer(lead, replyBody) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[portal-reply] Skipped (no Gmail config) — leadId=${lead?.id}`);
    return { ok: false, skipped: true };
  }
  const to = String(lead?.contact?.email || "").trim();
  if (!to) return { ok: false, skipped: true, reason: "no email on lead" };
  const firstName = lead?.contact?.firstName || (lead?.contact?.name || "").split(" ")[0] || "";
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const publicBase = resolvePublicBaseUrl();
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
    footerNote: `Questions? Call <a href="tel:+19059600181" style="color:#1B4D2E;">(905) 960-0181</a>.`
  });
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: "PJL replied to your message",
      html,
      text
    });
    console.log(`[portal-reply] sent leadId=${lead.id} to=${to} id=${info.messageId}`);
    await logSend({ kind: "portal_reply", to, ok: true, refId: lead.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[portal-reply] failed leadId=${lead?.id}:`, error.message);
    await logSend({ kind: "portal_reply", to, ok: false, error: error.message, refId: lead?.id });
    return { ok: false, error: error.message };
  }
}

// ---- Seasonal outreach senders --------------------------------------
//
// Property-driven (NOT lead-driven) bulk-send pipeline for Patrick's
// twice-a-year "time to book your opening / closing" nudge. The outreach
// lib (server/lib/outreach.js) is the orchestrator; these two functions
// are the per-recipient dispatchers. Inputs are primitives (resolved
// contact + composed body) rather than the lead record, since outreach
// composes its own message from a user-typed template, not from one of
// the lifecycle templates above.
//
// Both senders honor the same skip-and-return contract the rest of this
// module uses (config gone → { ok: false, skipped }, missing recipient →
// { ok: false, skipped }, send failure → { ok: false, error }) so the
// outreach orchestrator's per-recipient outcome table is uniform.

// Merge-tag substitution. Brief §3.4 supports {{firstName}},
// {{propertyAddress}}, {{seasonName}}, {{portalLink}}. Keep this regex
// in sync with the README in the compose modal so the recipient
// preview matches what actually gets sent.
function substituteOutreachTags(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{\s*(firstName|propertyAddress|seasonName|portalLink)\s*\}\}/g, (_match, key) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

// Plain-text outreach body → HTML. Preserves paragraph breaks
// (blank-line-separated) and within-paragraph line breaks. Escapes
// HTML so a customer typing "<3" doesn't render as a broken tag.
// Deliberately limited: this is "rich-enough text," not a full
// markdown renderer — keeping the email compose textarea
// expectations honest.
function plainBodyToHtml(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p style="margin: 0 0 14px;">${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Outreach email. `unsubscribeUrlEmail` flips just the email channel;
// `unsubscribeUrlAll` flips both channels (the recipient's "stop
// everything" path). Brief §3.5 mandates both surfaces in the footer.
async function sendOutreachEmail({
  to,
  firstName,
  propertyAddress,
  seasonName,
  portalLink,
  subject,
  emailBody,
  unsubscribeUrlEmail,
  unsubscribeUrlAll,
  // Button text for the portalLink CTA. Marketing outreach keeps the
  // long-standing default; the assignment cadence passes "Open your
  // appointment page" so the button matches where the link goes.
  ctaLabel = "Open your portal"
}) {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, skipped: true, reason: "no_gmail_config" };
  }
  const toAddr = String(to || "").trim();
  if (!toAddr) return { ok: false, skipped: true, reason: "no_email" };

  const vars = {
    firstName: firstName || "there",
    propertyAddress: propertyAddress || "",
    seasonName: seasonName || "",
    portalLink: portalLink || ""
  };
  const renderedSubject = substituteOutreachTags(subject || `Time to book your ${vars.seasonName}`, vars);
  const renderedBody = substituteOutreachTags(emailBody || "", vars);
  const bodyHtml = plainBodyToHtml(renderedBody);

  const publicBase = resolvePublicBaseUrl();
  const footerHtmlLines = [
    `<p style="margin: 24px 0 0; padding-top: 14px; border-top: 1px solid #e5e5dd; font-size: 12px; color: #777;">`,
    `You're receiving this because you're a PJL Land Services customer.<br>`,
    unsubscribeUrlEmail
      ? `To stop seasonal email reminders, <a href="${escapeHtml(unsubscribeUrlEmail)}" style="color:#1B4D2E;">click here</a>. `
      : "",
    unsubscribeUrlAll
      ? `To stop all seasonal reminders (email + SMS), <a href="${escapeHtml(unsubscribeUrlAll)}" style="color:#1B4D2E;">click here</a>.`
      : "",
    `</p>`
  ];
  const footerHtml = footerHtmlLines.join("");
  const footerText = [
    "",
    "---",
    "You're receiving this because you're a PJL Land Services customer.",
    unsubscribeUrlEmail ? `To stop seasonal email reminders: ${unsubscribeUrlEmail}` : "",
    unsubscribeUrlAll ? `To stop all seasonal reminders: ${unsubscribeUrlAll}` : ""
  ].filter((l) => l !== "").join("\n");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a; line-height: 1.55;">
  <div style="background: #1B4D2E; border-radius: 8px 8px 0 0; padding: 24px 28px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td valign="middle" style="padding-right: 16px;">
          <h1 style="margin: 0; color: #fff; font-size: 22px; font-weight: 700; line-height: 1.2;">${escapeHtml(vars.seasonName || "Seasonal reminder")}</h1>
        </td>
        <td valign="middle" align="right" width="180" style="width: 180px;">
          <img src="${escapeHtml(publicBase)}/crm/pjl-logo.svg" alt="PJL Land Services" width="180" style="display:block;border:0;outline:none;text-decoration:none;width:180px;max-width:180px;height:auto;">
        </td>
      </tr>
    </table>
  </div>
  <div style="padding: 24px 28px; background: #FAFAF5; border: 1px solid #e5e5dd; border-top: none; border-radius: 0 0 8px 8px;">
    ${bodyHtml}
    ${portalLink ? `<p style="margin: 0 0 18px;"><a href="${escapeHtml(portalLink)}" style="display: inline-block; padding: 11px 20px; background: #E07B24; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">${escapeHtml(ctaLabel)}</a></p>` : ""}
    <p style="margin: 24px 0 0; font-size: 13px; color: #777;">
      Questions? Call <a href="tel:+19059600181" style="color: #1B4D2E;">(905) 960-0181</a> or reply to this email.
    </p>
    ${footerHtml}
  </div>
  <p style="margin: 16px 0 0; font-size: 11px; color: #999; text-align: center;">
    PJL Land Services · Newmarket, Ontario · pjllandservices.com
  </p>
</div>`.trim();

  const text = [
    renderedBody,
    portalLink ? `\nOpen your portal: ${portalLink}` : "",
    "",
    "Questions? Call (905) 960-0181.",
    footerText,
    "",
    "PJL Land Services — Newmarket, Ontario"
  ].filter((l) => l !== "").join("\n");

  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.CUSTOMER_EMAIL || "info@pjllandservices.com"}>`,
      to: toAddr,
      replyTo: process.env.CUSTOMER_EMAIL || "info@pjllandservices.com",
      subject: renderedSubject,
      html,
      text
    });
    console.log(`[outreach-email] sent to=${toAddr} id=${info.messageId}`);
    await logSend({ kind: "outreach", to: toAddr, ok: true });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[outreach-email] failed:`, error.message);
    await logSend({ kind: "outreach", to: toAddr, ok: false, error: error.message });
    return { ok: false, error: error.message };
  }
}

// Outreach SMS. Twilio handles STOP at the carrier level (no inbound
// webhook needed for v1) but every body still carries the literal
// "Reply STOP to opt out." line so the recipient sees the path.
// Idempotent — if Patrick already typed "STOP" into his template,
// we don't double-append.
async function sendOutreachSms({
  to,
  firstName,
  propertyAddress,
  seasonName,
  portalLink,
  smsBody
}) {
  if (!smsConfigured()) {
    return { ok: false, skipped: true, reason: "no_twilio_config" };
  }
  const toNum = String(to || "").trim();
  if (!toNum) return { ok: false, skipped: true, reason: "no_phone" };

  const vars = {
    firstName: firstName || "there",
    propertyAddress: propertyAddress || "",
    seasonName: seasonName || "",
    portalLink: portalLink || ""
  };
  let body = substituteOutreachTags(smsBody || "", vars);
  if (!body.trim()) {
    // Defensive default if the caller passes an empty body — the
    // recipient still gets a useful message rather than a blank one.
    body = `Hi ${vars.firstName}, time to book your ${vars.seasonName} at ${vars.propertyAddress}. ${vars.portalLink}`;
  }
  // CASL / brief §1: every outreach SMS includes the STOP path. Skip
  // the append when the body already mentions STOP so we don't end up
  // with "Reply STOP to opt out. Reply STOP to opt out."
  if (!/\bSTOP\b/i.test(body)) {
    body = `${body.trim()}\nReply STOP to opt out.`;
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const payload = new URLSearchParams({
    To: toNum,
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
      console.error(`[outreach-sms] Twilio rejected:`, response.status, data?.message);
      return { ok: false, error: data?.message || `Twilio status ${response.status}` };
    }
    console.log(`[outreach-sms] sent to=${toNum} sid=${data.sid}`);
    return { ok: true, sid: data.sid };
  } catch (error) {
    console.error(`[outreach-sms] failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

// ---- Invoice-ready SMS (Invoice SMS brief, May 2026) -------------------
//
// Fires ~5 min after a WO completion cascade drafts an invoice. The SMS
// tells the customer the invoice has been emailed, points them at spam/
// junk if they miss it, and deep-links the portal-invoice view (which
// re-exposes the QB payment link).
//
// Idempotent: re-firing on an invoice with customerSmsSentAt set is a
// no-op. Customer opt-out and missing-phone branches log to invoice
// history (so the admin SMS-status block surfaces the skip reason) but
// don't error.

// Short property label for the SMS body: "123 Main St" — number + street
// only, no city/postal. Reads from the invoice's address snapshot first
// (frozen at cascade time, so it can't drift); falls back to "your
// recent service" when address is blank.
function shortPropertyLabel(invoice) {
  const raw = String(invoice?.address || "").trim();
  if (!raw) return "your recent service";
  // Take the first comma-segment, which is the street piece for "123 Main
  // St, Newmarket ON L3Y 1A1"-style addresses. Cap at 50 chars so the SMS
  // stays in one segment when combined with the rest of the body.
  const street = raw.split(",")[0].trim();
  if (!street) return "your recent service";
  return street.length > 50 ? `${street.slice(0, 47)}…` : street;
}

// Build the SMS body. Property label + portal URL substituted in. One
// segment when the URL is short enough; two-segment fallback is fine
// per the brief.
function buildInvoiceReadySmsBody(invoice, portalUrl) {
  const label = shortPropertyLabel(invoice);
  return (
    `PJL Land Services: Your invoice for ${label} has been emailed to you. ` +
    `If you don't see it, please check spam/junk. ` +
    `View or pay it here: ${portalUrl}`
  );
}

// Look up the customer (if customerId is set on the invoice) and read
// notificationPrefs.textReminders. Default to ALLOWED when the customer
// record is missing — a customer who interacted via a one-shot lead
// without becoming a customer record still has a phone on the invoice
// snapshot, and we honor that. Explicit opt-out (textReminders: false)
// is the only blocking signal.
async function resolveSmsAllowed(invoice) {
  if (!invoice?.customerId) return true;
  try {
    const customers = require("./customers");
    const cust = await customers.get(invoice.customerId);
    if (!cust) return true;
    return cust?.notificationPrefs?.textReminders !== false;
  } catch (_err) {
    return true;
  }
}

// Resolve the spouse-CC recipients for an invoice. Looks up the
// customer record to read copySpouseOnInvoices + spouse contact +
// spouseTextReminders CASL gate.
//
// `includeSpouse` (caller override):
//   - true  → force-include spouse even if profile flag is off
//   - false → force-skip spouse even if profile flag is on
//   - null/undefined → use the profile's copySpouseOnInvoices flag
//
// Returns:
//   { spouseEmail, spousePhone, smsAllowed }
// Where spouseEmail/spousePhone are empty strings when no spouse is
// to be CC'd (callers can do `if (recip.spouseEmail) sendCc(...)`).
// smsAllowed gates ONLY the SMS path — emails ignore it.
// Fire an invoice SMS to the spouse (parallel to the primary send).
// Used by all three SMS paths (ready/reminder/junk-warning). Each
// path passes its own action prefix so the history entry namespace
// matches the primary's (`customer_sms_sent_spouse`, etc.).
//
// Returns { ok, sid?, error?, skipped? } so callers can include the
// spouse-attempt result in their own return value if needed.
async function fireSpouseInvoiceSms(invoice, body, opts) {
  const {
    includeSpouse,
    actionSent,
    actionFailed,
    actionSkipped
  } = opts || {};
  const invoices = require("./invoices");
  const recip = await resolveSpouseRecipients(invoice, includeSpouse);
  // Not flagged for CC (profile flag off + no override true) — no-op,
  // not even a skip entry (the absence of a flag isn't an "event").
  if (!recip.spouseEmail && !recip.spousePhone) return null;
  if (!recip.spousePhone) {
    await invoices.appendHistory(invoice.id, {
      action: actionSkipped,
      by: "system",
      note: "Spouse-CC enabled but no spouse phone on customer record."
    });
    return { ok: true, skipped: "no_spouse_phone" };
  }
  if (!recip.smsAllowed) {
    await invoices.appendHistory(invoice.id, {
      action: actionSkipped,
      by: "system",
      note: "Spouse opted out (notificationPrefs.spouseTextReminders=false)."
    });
    return { ok: true, skipped: "spouse_opted_out" };
  }
  if (!smsConfigured()) {
    return { ok: false, skipped: "no_twilio_config" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const payload = new URLSearchParams({
    To: recip.spousePhone,
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
      const errMsg = String(data?.message || `Twilio HTTP ${response.status}`).slice(0, 300);
      console.error(`[invoice-sms-spouse] invoice=${invoice.id} Twilio rejected:`, response.status, errMsg);
      try {
        await invoices.appendHistory(invoice.id, {
          action: actionFailed,
          by: "system",
          note: `Spouse SMS failed: ${errMsg}`
        });
      } catch (_) {}
      return { ok: false, error: errMsg };
    }
    try {
      await invoices.appendHistory(invoice.id, {
        action: actionSent,
        by: "system",
        note: `Spouse SMS to ${recip.spousePhone} (sid ${data?.sid || "unknown"})`
      });
    } catch (_) {}
    console.log(`[invoice-sms-spouse] invoice=${invoice.id} sent to=${recip.spousePhone} sid=${data?.sid}`);
    return { ok: true, sid: data?.sid };
  } catch (error) {
    const errMsg = String(error?.message || "network/runtime error").slice(0, 300);
    console.error(`[invoice-sms-spouse] invoice=${invoice.id} failed:`, errMsg);
    try {
      await invoices.appendHistory(invoice.id, {
        action: actionFailed,
        by: "system",
        note: `Spouse SMS failed: ${errMsg}`
      });
    } catch (_) {}
    return { ok: false, error: errMsg };
  }
}

async function resolveSpouseRecipients(invoice, includeSpouse) {
  const empty = { spouseEmail: "", spousePhone: "", smsAllowed: false };
  if (!invoice?.customerId) return empty;
  try {
    const customers = require("./customers");
    const cust = await customers.get(invoice.customerId);
    if (!cust) return empty;
    // Decide whether to include based on caller override + profile flag.
    let include;
    if (includeSpouse === true) include = true;
    else if (includeSpouse === false) include = false;
    else include = cust.copySpouseOnInvoices === true;
    if (!include) return empty;
    return {
      spouseEmail: String(cust.spouseEmail || "").trim(),
      spousePhone: String(cust.spousePhone || "").trim(),
      smsAllowed: cust?.notificationPrefs?.spouseTextReminders !== false
    };
  } catch (_err) {
    return empty;
  }
}

// Public API. Reads the invoice fresh at send time (so customer phone
// changes between schedule and fire are picked up; void status aborts).
// Returns one of:
//   { ok: true, skipped: <reason> }   — opted out / no phone / voided / paid
//   { ok: true, sid }                  — Twilio accepted the message
//   { ok: false, error }               — Twilio rejected; history stamped
async function sendInvoiceReadySMS({ invoiceId, includeSpouse } = {}) {
  if (!invoiceId) return { ok: false, error: "missing invoiceId" };
  const invoices = require("./invoices");
  const invoice = await invoices.get(invoiceId);
  if (!invoice) return { ok: false, error: "invoice_not_found" };

  // Idempotency gate — primary fire path + sweep both call this, and a
  // double-fire would surface as a duplicate SMS in the customer's inbox.
  if (invoice.customerSmsSentAt) {
    return { ok: true, skipped: "already_sent" };
  }

  // Voided between schedule and send — abort. The portal view would still
  // show the line items, but a "your invoice is on its way" SMS for a
  // voided invoice is misleading. Log to history so the admin block
  // surfaces the skip.
  if (invoice.status === "void") {
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_skipped_voided",
      by: "system",
      note: "Invoice voided before SMS fired"
    });
    return { ok: true, skipped: "voided" };
  }

  // Paid via some other path (rare — paid-on-site invoices don't get
  // scheduled, but Patrick could mark draft → paid manually). No need to
  // chase payment if it's already in.
  if (invoice.status === "paid") {
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_skipped_paid",
      by: "system",
      note: "Invoice paid before SMS fired"
    });
    return { ok: true, skipped: "paid" };
  }

  const allowed = await resolveSmsAllowed(invoice);
  if (!allowed) {
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_skipped_opted_out",
      by: "system",
      note: "Customer opted out of text reminders"
    });
    return { ok: true, skipped: "opted_out" };
  }

  const to = String(invoice.customerPhone || "").trim();
  if (!to) {
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_skipped_no_phone",
      by: "system",
      note: "No customer phone on invoice"
    });
    return { ok: true, skipped: "no_phone" };
  }

  if (!smsConfigured()) {
    console.warn(`[invoice-sms] Skipped (no Twilio config) — invoice=${invoiceId}`);
    return { ok: false, skipped: "no_twilio_config" };
  }

  // Need a portal token to point the customer somewhere. ensurePortalToken
  // is idempotent so calling it here (instead of relying on the cascade
  // having set it) is safe.
  const tokenized = await invoices.ensurePortalToken(invoiceId);
  const portalToken = tokenized?.portalToken;
  if (!portalToken) {
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_failed",
      by: "system",
      note: "Couldn't mint portalToken"
    });
    return { ok: false, error: "portal_token_failed" };
  }

  const publicBase = resolvePublicBaseUrl();
  const portalUrl = `${publicBase}/portal/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(portalToken)}`;
  const body = buildInvoiceReadySmsBody(invoice, portalUrl);

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
      const errMsg = String(data?.message || `Twilio HTTP ${response.status}`).slice(0, 300);
      console.error(`[invoice-sms] invoice=${invoiceId} Twilio rejected:`, response.status, errMsg);
      await invoices.appendHistory(invoiceId, {
        action: "customer_sms_failed",
        by: "system",
        note: errMsg
      });
      return { ok: false, error: errMsg };
    }
    // Twilio accepted — stamp sent time + history entry. The stamp is the
    // idempotency gate (re-fires no-op above). Update + appendHistory are
    // separate calls; if the second fails, the SMS is still recorded as
    // sent (no duplicate) so the failure mode is benign.
    const sentAt = new Date().toISOString();
    await invoices.update(invoiceId, { customerSmsSentAt: sentAt });
    await invoices.appendHistory(invoiceId, {
      action: "customer_sms_sent",
      by: "system",
      note: `Sent to ${to} (sid ${data?.sid || "unknown"})`
    });
    console.log(`[invoice-sms] invoice=${invoiceId} sent to=${to} sid=${data?.sid}`);
    // Spouse-CC: fire AFTER the primary success (so a primary
    // Twilio failure doesn't leave the spouse hanging without a
    // matching primary). The spouse send is independent — its own
    // history entries, doesn't block or unwind the primary.
    const spouseResult = await fireSpouseInvoiceSms(invoice, body, {
      includeSpouse,
      actionSent: "customer_sms_sent_spouse",
      actionFailed: "customer_sms_failed_spouse",
      actionSkipped: "customer_sms_skipped_spouse"
    });
    return { ok: true, sid: data?.sid, spouse: spouseResult };
  } catch (error) {
    const errMsg = String(error?.message || "network/runtime error").slice(0, 300);
    console.error(`[invoice-sms] invoice=${invoiceId} failed:`, errMsg);
    try {
      await invoices.appendHistory(invoiceId, {
        action: "customer_sms_failed",
        by: "system",
        note: errMsg
      });
    } catch (_logErr) {}
    return { ok: false, error: errMsg };
  }
}

// Sweep recovery path — finds invoices scheduled to send but not yet
// sent and within the max-age window, then fires each. Called on server
// boot (catches pending sends across restarts) and on a recurring
// interval (catches sends whose setTimeout was lost). Best-effort; logs
// only. Returns { considered, fired, skipped } for the caller's logs.
async function sweepPendingInvoiceSMS() {
  const invoices = require("./invoices");
  const settingsLib = require("./settings");
  let settings;
  try { settings = await settingsLib.get(); } catch { settings = null; }
  // Honour the master switch — flipping invoiceSms.enabled off should
  // stop the sweep from picking up already-scheduled records too.
  if (settings?.invoiceSms?.enabled === false) {
    return { considered: 0, fired: 0, skipped: 0 };
  }
  const maxAgeHours = Number(settings?.invoiceSms?.maxAgeHours) > 0
    ? Number(settings.invoiceSms.maxAgeHours)
    : 24;
  const now = Date.now();
  const ceiling = now;
  const floor = now - maxAgeHours * 60 * 60 * 1000;

  let records;
  try { records = await invoices.list(); } catch { records = []; }
  let considered = 0;
  let fired = 0;
  let skipped = 0;
  for (const inv of records) {
    if (!inv?.customerSmsScheduledAt) continue;
    if (inv.customerSmsSentAt) continue;
    const t = Date.parse(inv.customerSmsScheduledAt);
    if (!Number.isFinite(t)) continue;
    considered += 1;
    if (t > ceiling) continue; // not yet due
    if (t < floor) { skipped += 1; continue; } // aged out
    const result = await sendInvoiceReadySMS({ invoiceId: inv.id });
    if (result?.ok && result.sid) fired += 1;
  }
  return { considered, fired, skipped };
}

// ---- Manual invoice reminder SMS (Invoice Reminder brief, May 2026) ----
//
// Admin-triggered follow-up SMS for invoices that are still outstanding
// past the initial auto-fire nudge (sendInvoiceReadySMS). Distinct from
// the auto-fire in three ways:
//   1. Different body — explicitly framed as a friendly reminder.
//   2. Not idempotent on customerSmsSentAt — that flag belongs to the
//      auto-fire. Reminders are governed by customerReminderHistory[]
//      and a 1-hour rate limit (overridable with { force: true }).
//   3. Skip conditions return REASON CODES the API can map to HTTP
//      status (so the UI can render a clear human message and disable
//      the button when the invoice is paid/voided).
//
// All skip / failure paths append a customerReminderHistory entry so the
// admin UI can show "Last reminder attempted on …" even when no SMS
// actually went out (e.g. opted out, no phone). The append-on-skip is
// what gives the UI a complete audit trail per the brief.

const REMINDER_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

// Build the reminder SMS body. Property label + portal URL substituted in.
function buildInvoiceReminderSmsBody(invoice, portalUrl) {
  const label = shortPropertyLabel(invoice);
  return (
    `Friendly reminder from PJL Land Services — your invoice for ${label} is still outstanding. ` +
    `View and pay here: ${portalUrl}. ` +
    `Questions? Call (905) 960-0181.`
  );
}

// Append an entry to invoice.customerReminderHistory. Read-modify-write
// on the parsed array (separate from the email/history audit trail; this
// is a feature-specific log).
async function appendReminderHistoryEntry(invoiceId, entry) {
  const invoices = require("./invoices");
  const current = await invoices.get(invoiceId);
  if (!current) return null;
  const history = Array.isArray(current.customerReminderHistory)
    ? current.customerReminderHistory.slice()
    : [];
  history.push({
    sentAt: entry.sentAt || new Date().toISOString(),
    channel: entry.channel || "sms",
    success: entry.success === true,
    ...(entry.error ? { error: String(entry.error).slice(0, 300) } : {}),
    ...(entry.body ? { body: String(entry.body).slice(0, 500) } : {}),
    ...(entry.reason ? { reason: entry.reason } : {})
  });
  return invoices.update(invoiceId, { customerReminderHistory: history });
}

// Returns one of:
//   { ok: true, sentAt, body, sid }   — Twilio accepted
//   { ok: false, error: "rate_limited", lastSentAt, retryAfterSeconds }
//   { ok: false, error: "voided" | "paid" | "no_phone" | "no_twilio_config"
//                       | "disabled" | "opted_out" | "portal_token_failed"
//                       | "invoice_not_found" | "missing_invoice_id"
//                       | <twilio error msg> }
//
// The server's POST /api/invoices/:id/send-reminder endpoint maps these
// to HTTP status codes (404 for not_found, 429 for rate_limited, 409 for
// the skip conditions, 200 for success, 502 for Twilio failures).
async function sendInvoiceReminderSMS({ invoiceId, force, includeSpouse } = {}) {
  if (!invoiceId) return { ok: false, error: "missing_invoice_id" };
  const invoices = require("./invoices");
  const settingsLib = require("./settings");

  const invoice = await invoices.get(invoiceId);
  if (!invoice) return { ok: false, error: "invoice_not_found" };

  // Master kill switch — same setting governs the auto-fire and manual
  // reminders. Flipping invoiceSms.enabled off should stop both.
  let settings;
  try { settings = await settingsLib.get(); } catch { settings = null; }
  if (settings?.invoiceSms?.enabled === false) {
    return { ok: false, error: "disabled" };
  }

  if (invoice.status === "void") {
    return { ok: false, error: "voided" };
  }
  if (invoice.status === "paid") {
    return { ok: false, error: "paid" };
  }

  // Rate limit — minimum 1 hour between reminders, computed from the
  // most-recent successful reminder in the history. Failed attempts do
  // NOT count toward the gate (so an admin can retry immediately after
  // a Twilio reject). force: true bypasses entirely.
  const history = Array.isArray(invoice.customerReminderHistory)
    ? invoice.customerReminderHistory
    : [];
  if (!force) {
    const lastSuccessful = [...history].reverse().find((h) => h?.success === true);
    if (lastSuccessful?.sentAt) {
      const elapsed = Date.now() - Date.parse(lastSuccessful.sentAt);
      if (Number.isFinite(elapsed) && elapsed < REMINDER_RATE_LIMIT_MS) {
        const retryAfterSeconds = Math.ceil((REMINDER_RATE_LIMIT_MS - elapsed) / 1000);
        return {
          ok: false,
          error: "rate_limited",
          lastSentAt: lastSuccessful.sentAt,
          retryAfterSeconds
        };
      }
    }
  }

  const allowed = await resolveSmsAllowed(invoice);
  if (!allowed) {
    await appendReminderHistoryEntry(invoiceId, {
      success: false,
      reason: "opted_out",
      error: "Customer opted out of text reminders"
    });
    return { ok: false, error: "opted_out" };
  }

  const to = String(invoice.customerPhone || "").trim();
  if (!to) {
    await appendReminderHistoryEntry(invoiceId, {
      success: false,
      reason: "no_phone",
      error: "No customer phone on invoice"
    });
    return { ok: false, error: "no_phone" };
  }

  if (!smsConfigured()) {
    return { ok: false, error: "no_twilio_config" };
  }

  // Defensive: mint a portalToken if one doesn't exist. Should already
  // be present (auto-fire flow + completion cascade both call this), but
  // a manual reminder on an old invoice without one shouldn't 500.
  const tokenized = await invoices.ensurePortalToken(invoiceId);
  const portalToken = tokenized?.portalToken;
  if (!portalToken) {
    await appendReminderHistoryEntry(invoiceId, {
      success: false,
      reason: "portal_token_failed",
      error: "Couldn't mint portalToken"
    });
    return { ok: false, error: "portal_token_failed" };
  }

  const publicBase = resolvePublicBaseUrl();
  const portalUrl = `${publicBase}/portal/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(portalToken)}`;
  const body = buildInvoiceReminderSmsBody(invoice, portalUrl);

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
      const errMsg = String(data?.message || `Twilio HTTP ${response.status}`).slice(0, 300);
      console.error(`[invoice-reminder] invoice=${invoiceId} Twilio rejected:`, response.status, errMsg);
      await appendReminderHistoryEntry(invoiceId, {
        success: false,
        reason: "twilio_failed",
        error: errMsg,
        body
      });
      return { ok: false, error: errMsg };
    }
    const sentAt = new Date().toISOString();
    await appendReminderHistoryEntry(invoiceId, {
      sentAt,
      success: true,
      body
    });
    // Mirror to the invoice audit history so it shows in the full timeline.
    try {
      await invoices.appendHistory(invoiceId, {
        action: "customer_reminder_sent",
        by: "admin",
        note: `Reminder SMS to ${to} (sid ${data?.sid || "unknown"})`
      });
    } catch (_) { /* best-effort */ }
    console.log(`[invoice-reminder] invoice=${invoiceId} sent to=${to} sid=${data?.sid}`);
    // Spouse-CC: fire after primary success. Logs to the invoice's
    // top-level audit history (not customerReminderHistory — that
    // array drives the 1-hour rate-limit gate, which should only
    // track primary sends; the spouse is CC'd, not independent).
    const spouseResult = await fireSpouseInvoiceSms(invoice, body, {
      includeSpouse,
      actionSent: "customer_reminder_sent_spouse",
      actionFailed: "customer_reminder_failed_spouse",
      actionSkipped: "customer_reminder_skipped_spouse"
    });
    return { ok: true, sentAt, body, sid: data?.sid, spouse: spouseResult };
  } catch (error) {
    const errMsg = String(error?.message || "network/runtime error").slice(0, 300);
    console.error(`[invoice-reminder] invoice=${invoiceId} failed:`, errMsg);
    try {
      await appendReminderHistoryEntry(invoiceId, {
        success: false,
        reason: "network_error",
        error: errMsg,
        body
      });
    } catch (_logErr) {}
    return { ok: false, error: errMsg };
  }
}

// ---- Invoice junk-mail warning SMS (Junk-Mail Warning brief, May 2026) -
//
// Fires ~30s after the admin clicks "Send invoice" email — warns the
// customer that the invoice was emailed and to check Junk/Spam if they
// don't see it. Third invoice SMS surface alongside:
//   - sendInvoiceReadySMS        (auto-fire, post-cascade, ONE per WO)
//   - sendInvoiceReminderSMS     (manual, admin button, rate-limited 1h)
// The junk-mail warning is its own field — customerJunkMailWarningSentAt
// — and is RESET to null on each /send call so a re-send fires fresh.
//
// Redundancy guard: if the auto-fire "invoice ready" SMS landed within
// the last 5 min, skip — the auto-fire body already mentions junk/spam
// and a second SMS in that window would be noise.

const JUNK_WARNING_AUTOFIRE_BLACKOUT_MS = 5 * 60 * 1000; // 5 min
const JUNK_WARNING_RATE_LIMIT_MS = 60 * 60 * 1000;        // 1 hour (manual)

function buildInvoiceJunkMailWarningSmsBody(invoice, portalUrl) {
  const label = shortPropertyLabel(invoice);
  return (
    `Heads up from PJL Land Services — we just emailed your invoice for ${label}. ` +
    `If you don't see it within a few minutes, please check your Junk/Spam folder. ` +
    `The invoice is also viewable here: ${portalUrl}. ` +
    `Questions? Call (905) 960-0181.`
  );
}

async function appendJunkMailWarningHistoryEntry(invoiceId, entry) {
  const invoices = require("./invoices");
  const current = await invoices.get(invoiceId);
  if (!current) return null;
  const history = Array.isArray(current.customerJunkMailWarningHistory)
    ? current.customerJunkMailWarningHistory.slice()
    : [];
  history.push({
    sentAt: entry.sentAt || new Date().toISOString(),
    channel: entry.channel || "sms",
    success: entry.success === true,
    ...(entry.error ? { error: String(entry.error).slice(0, 300) } : {}),
    ...(entry.body ? { body: String(entry.body).slice(0, 500) } : {}),
    ...(entry.reason ? { reason: entry.reason } : {})
  });
  return invoices.update(invoiceId, { customerJunkMailWarningHistory: history });
}

// Returns one of:
//   { ok: true, sentAt, body, sid }
//   { ok: false, error: "rate_limited", lastSentAt, retryAfterSeconds }
//   { ok: false, error: "voided" | "paid" | "no_phone" | "no_twilio_config"
//                       | "disabled" | "opted_out" | "portal_token_failed"
//                       | "autofire_recent" | "invoice_not_found"
//                       | "missing_invoice_id" | <twilio error msg> }
//
// `autofire_recent` is unique to this function — skips when the auto-
// fire "invoice ready" SMS already landed within the last 5 min (the
// auto-fire body already mentions junk/spam). `force: true` bypasses
// BOTH the 1-hour manual rate limit AND the autofire blackout.
async function sendInvoiceJunkMailWarningSMS({ invoiceId, force, includeSpouse } = {}) {
  if (!invoiceId) return { ok: false, error: "missing_invoice_id" };
  const invoices = require("./invoices");
  const settingsLib = require("./settings");

  const invoice = await invoices.get(invoiceId);
  if (!invoice) return { ok: false, error: "invoice_not_found" };

  // Master kill switch.
  let settings;
  try { settings = await settingsLib.get(); } catch { settings = null; }
  if (settings?.invoiceSms?.enabled === false) {
    return { ok: false, error: "disabled" };
  }

  if (invoice.status === "void") return { ok: false, error: "voided" };
  if (invoice.status === "paid") return { ok: false, error: "paid" };

  if (!force) {
    // Redundancy with the auto-fire "invoice ready" SMS — if it landed
    // within the last 5 min, skip (its body already says "check spam/
    // junk"). Mostly relevant when the admin manually /send's an
    // invoice within ~5 min of a WO completion firing the auto-fire.
    if (invoice.customerSmsSentAt) {
      const elapsedAutofire = Date.now() - Date.parse(invoice.customerSmsSentAt);
      if (Number.isFinite(elapsedAutofire) && elapsedAutofire < JUNK_WARNING_AUTOFIRE_BLACKOUT_MS) {
        await appendJunkMailWarningHistoryEntry(invoiceId, {
          success: false,
          reason: "autofire_recent",
          error: "Auto-fire 'invoice ready' SMS landed within last 5 min — junk warning redundant"
        });
        return { ok: false, error: "autofire_recent" };
      }
    }
    // Manual rate limit — 1 hour between successful junk-mail warnings.
    // Counts only successful sends so an admin can retry after a
    // Twilio reject without waiting.
    const history = Array.isArray(invoice.customerJunkMailWarningHistory)
      ? invoice.customerJunkMailWarningHistory
      : [];
    const lastSuccessful = [...history].reverse().find((h) => h?.success === true);
    if (lastSuccessful?.sentAt) {
      const elapsed = Date.now() - Date.parse(lastSuccessful.sentAt);
      if (Number.isFinite(elapsed) && elapsed < JUNK_WARNING_RATE_LIMIT_MS) {
        const retryAfterSeconds = Math.ceil((JUNK_WARNING_RATE_LIMIT_MS - elapsed) / 1000);
        return {
          ok: false,
          error: "rate_limited",
          lastSentAt: lastSuccessful.sentAt,
          retryAfterSeconds
        };
      }
    }
  }

  const allowed = await resolveSmsAllowed(invoice);
  if (!allowed) {
    await appendJunkMailWarningHistoryEntry(invoiceId, {
      success: false,
      reason: "opted_out",
      error: "Customer opted out of text reminders"
    });
    return { ok: false, error: "opted_out" };
  }

  const to = String(invoice.customerPhone || "").trim();
  if (!to) {
    await appendJunkMailWarningHistoryEntry(invoiceId, {
      success: false,
      reason: "no_phone",
      error: "No customer phone on invoice"
    });
    return { ok: false, error: "no_phone" };
  }

  if (!smsConfigured()) {
    return { ok: false, error: "no_twilio_config" };
  }

  const tokenized = await invoices.ensurePortalToken(invoiceId);
  const portalToken = tokenized?.portalToken;
  if (!portalToken) {
    await appendJunkMailWarningHistoryEntry(invoiceId, {
      success: false,
      reason: "portal_token_failed",
      error: "Couldn't mint portalToken"
    });
    return { ok: false, error: "portal_token_failed" };
  }

  const publicBase = resolvePublicBaseUrl();
  const portalUrl = `${publicBase}/portal/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(portalToken)}`;
  const body = buildInvoiceJunkMailWarningSmsBody(invoice, portalUrl);

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
      const errMsg = String(data?.message || `Twilio HTTP ${response.status}`).slice(0, 300);
      console.error(`[invoice-junk-warning] invoice=${invoiceId} Twilio rejected:`, response.status, errMsg);
      await appendJunkMailWarningHistoryEntry(invoiceId, {
        success: false,
        reason: "twilio_failed",
        error: errMsg,
        body
      });
      return { ok: false, error: errMsg };
    }
    const sentAt = new Date().toISOString();
    await appendJunkMailWarningHistoryEntry(invoiceId, {
      sentAt,
      success: true,
      body
    });
    // Stamp the "most recent successful warning" pointer + audit-trail
    // entry. Stamping happens AFTER the history append so the history
    // is always the source of truth even if the pointer write fails.
    await invoices.update(invoiceId, { customerJunkMailWarningSentAt: sentAt });
    try {
      await invoices.appendHistory(invoiceId, {
        action: "customer_junk_warning_sent",
        by: "system",
        note: `Junk-mail warning SMS to ${to} (sid ${data?.sid || "unknown"})`
      });
    } catch (_) { /* best-effort */ }
    console.log(`[invoice-junk-warning] invoice=${invoiceId} sent to=${to} sid=${data?.sid}`);
    // Spouse-CC.
    const spouseResult = await fireSpouseInvoiceSms(invoice, body, {
      includeSpouse,
      actionSent: "customer_junk_warning_sent_spouse",
      actionFailed: "customer_junk_warning_failed_spouse",
      actionSkipped: "customer_junk_warning_skipped_spouse"
    });
    return { ok: true, sentAt, body, sid: data?.sid, spouse: spouseResult };
  } catch (error) {
    const errMsg = String(error?.message || "network/runtime error").slice(0, 300);
    console.error(`[invoice-junk-warning] invoice=${invoiceId} failed:`, errMsg);
    try {
      await appendJunkMailWarningHistoryEntry(invoiceId, {
        success: false,
        reason: "network_error",
        error: errMsg,
        body
      });
    } catch (_logErr) {}
    return { ok: false, error: errMsg };
  }
}

module.exports = {
  notifyCustomer,
  // Exposed for tests — the customer-facing wording is contract.
  TEMPLATES,
  eventForTransition,
  sendBookingCancellation,
  sendPortalMessageAlertEmail,
  sendPortalReplyToCustomer,
  sendInvoiceToCustomer,
  sendPaymentReceipt,
  sendCustomerLoginLink,
  sendQuoteAcceptedConfirmation,
  sendAdminPasswordResetLink,
  sendOutreachEmail,
  sendOutreachSms,
  substituteOutreachTags,
  sendInvoiceReminderSMS,
  sendInvoiceJunkMailWarningSMS,
  sendInvoiceReadySMS,
  sweepPendingInvoiceSMS,
  resolveSpouseRecipients
};

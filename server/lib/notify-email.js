// Email notification on new lead intake.
//
// Reads credentials from environment variables (loaded from .env at server boot):
//   GMAIL_USER          — your Google Workspace address (e.g. info@pjllandservices.com)
//   GMAIL_APP_PASSWORD  — a Gmail "app password" (NOT your regular password —
//                         create one at https://myaccount.google.com/apppasswords)
//   NOTIFY_TO_EMAIL     — where the alert goes (defaults to GMAIL_USER)
//   PUBLIC_BASE_URL     — public origin for the CRM link in the email body
//                         (e.g. https://pjllandservices.com). See
//                         server/lib/public-base-url.js for the full
//                         resolution order — env-var-authoritative, dev
//                         localhost fallback, then the canonical PJL domain.
//                         Never falls back to the request host (which on
//                         Render is the *.onrender.com subdomain).
//
// If GMAIL_USER or GMAIL_APP_PASSWORD is missing, this module logs a clear
// message to the console and returns { ok: false, skipped: true } — the lead
// intake itself still succeeds. That way the site keeps working before you've
// configured email, and starts emailing the moment you set the env vars.

const { resolvePublicBaseUrl } = require("./public-base-url");
const { logSend } = require("./mailer-log");

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

function buildLeadEmail(lead) {
  const sourceLabel = lead.sourceLabel || lead.source || "General Lead";
  const town = (lead.contact?.address || "").split(",")[1]?.trim() || lead.contact?.address || "";
  // intakeOutcome (CRM-01, self-intake dedup) — set only by the
  // /api/new-customer handler. "updated_existing" means the submission
  // matched a record already in the CRM and that record was updated;
  // "created_new" means no match and a fresh lead was created. Absent on
  // every other intake path, which keeps those emails byte-identical.
  const outcome = lead.intakeOutcome === "updated_existing"
    ? { updated: true, line: "This submission matched an existing record by email. The existing record was updated — no new lead was created." }
    : lead.intakeOutcome === "created_new"
      ? { updated: false, line: "No existing record matched this email — a new lead was created." }
      : null;
  const subject = outcome?.updated
    ? `PJL Lead Updated — ${sourceLabel} — ${lead.contact?.name || "Unknown"}`
    : `New PJL Lead — ${sourceLabel} — ${lead.contact?.name || "Unknown"}`;
  // resolvePublicBaseUrl strips trailing slashes and never returns the
  // request's .onrender.com host — see public-base-url.js for the order.
  const cleanBase = resolvePublicBaseUrl();
  const adminUrl = `${cleanBase}/admin`;
  const portalUrl = lead.portalUrl || `${cleanBase}/portal/${lead.portal?.token || ""}`;

  const featuresHtml = (lead.features || []).map((f) => {
    const qty = f.qty > 1 ? ` × ${f.qty}` : "";
    const price = f.quoteType === "custom" ? "(custom quote)" : moneyText(f.price * (f.qty || 1));
    return `<li>${escapeHtml(f.label)}${qty} — ${escapeHtml(price)}</li>`;
  }).join("") || "<li><em>No specific items selected — see customer notes.</em></li>";

  const notes = lead.contact?.notes ? `<p><strong>Customer notes:</strong><br>${escapeHtml(lead.contact.notes).replace(/\n/g, "<br>")}</p>` : "";

  // Separate billing party (billing-party brief). Only rendered when the
  // customer asked to bill someone else — the self-billing email stays
  // byte-identical to the pre-feature layout.
  const billing = lead.billing && lead.billing.billTo === "other" ? lead.billing : null;
  const billingRows = billing ? `
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Bill to</td><td style="padding: 4px 0;"><strong>${escapeHtml(billing.name)}</strong></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Billing address</td><td style="padding: 4px 0;">${escapeHtml(billing.address)}</td></tr>
    ${billing.email ? `<tr><td style="padding: 4px 14px 4px 0; color: #777;">Billing email</td><td style="padding: 4px 0;"><a href="mailto:${escapeHtml(billing.email)}">${escapeHtml(billing.email)}</a></td></tr>` : ""}` : "";

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a;">
  <h2 style="margin: 0 0 8px; font-size: 22px;">${outcome?.updated ? `${escapeHtml(sourceLabel)} — existing record updated` : `New ${escapeHtml(sourceLabel)} lead`}</h2>
  <p style="margin: 0 0 18px; color: #555;">${escapeHtml(lead.contact?.name || "")} ${town ? `· ${escapeHtml(town)}` : ""}</p>
  ${outcome ? `<p style="margin: 0 0 18px; padding: 10px 14px; background: ${outcome.updated ? "#eef4f8" : "#f1f0e8"}; border-left: 3px solid #1f4f6e; border-radius: 4px;">${escapeHtml(outcome.line)}</p>` : ""}

  <table style="border-collapse: collapse; margin-bottom: 18px;">
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Phone</td><td style="padding: 4px 0;"><a href="tel:${escapeHtml(lead.contact?.phone || "")}">${escapeHtml(lead.contact?.phone || "")}</a></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Email</td><td style="padding: 4px 0;"><a href="mailto:${escapeHtml(lead.contact?.email || "")}">${escapeHtml(lead.contact?.email || "")}</a></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Address</td><td style="padding: 4px 0;">${escapeHtml(lead.contact?.address || "—")}</td></tr>${billingRows}
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
    outcome?.updated ? `${sourceLabel} — existing record updated` : `New ${sourceLabel} lead`,
    `${lead.contact?.name || ""}${town ? " · " + town : ""}`,
    ...(outcome ? ["", outcome.line] : []),
    "",
    `Phone:   ${lead.contact?.phone || ""}`,
    `Email:   ${lead.contact?.email || ""}`,
    `Address: ${lead.contact?.address || "—"}`,
    ...(billing ? [
      `Bill to: ${billing.name}`,
      `Billing address: ${billing.address}`,
      ...(billing.email ? [`Billing email: ${billing.email}`] : [])
    ] : []),
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

async function sendNewLeadEmail(lead) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email notification (lead still saved).");
    console.warn("[email] Lead:", lead.id, "-", lead.sourceLabel || lead.source, "-", lead.contact?.name);
    return { ok: false, skipped: true };
  }

  const to = process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER;
  const fromAddress = process.env.GMAIL_USER;
  const { subject, html, text } = buildLeadEmail(lead);

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
    await logSend({ kind: "lead_alert", to, ok: true, refId: lead.id });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error("[email] Failed to send notification:", error.message);
    await logSend({ kind: "lead_alert", to, ok: false, error: error.message, refId: lead.id });
    return { ok: false, error: error.message };
  }
}

// --- Call-forward voicemail email -----------------------------------------
// Companion to sendVoicemailAlertSms (notify-sms.js). When Twilio finishes
// transcribing a voicemail it POSTs the text to
// /api/twilio-voice-incoming's transcribeCallback; that route calls this to
// email Patrick the transcription, the caller number, duration, timestamp,
// and a tap-to-listen recording link. If his Gmail transporter can reach
// the audio, we also attach the .mp3 so the voicemail is in his inbox even
// if Twilio later expires the recording.
//
// Reuses the same getTransporter() + NOTIFY_TO_EMAIL destination as the
// lead email above — no new credentials.

// Fetch the voicemail audio from Twilio so we can attach it. Twilio's
// recording media lives at <RecordingUrl>.mp3; we send the account's Basic
// auth so it works whether or not "HTTP auth for media" is enabled. Returns
// a nodemailer attachment object, or null on any failure (we then fall back
// to the link-only email — the recording URL is always in the body).
async function fetchRecordingAttachment(recordingUrl) {
  if (!recordingUrl) return null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const resp = await fetch(`${recordingUrl}.mp3`, {
      headers: { "Authorization": `Basic ${auth}` }
    });
    if (!resp.ok) {
      console.warn("[email] Could not fetch voicemail audio for attachment:", resp.status);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return null;
    // Guard against pathologically large recordings (maxLength is 180s, so
    // this should never trip — but never attach an unbounded blob).
    if (buf.length > 15_000_000) {
      console.warn("[email] Voicemail audio too large to attach; sending link only.");
      return null;
    }
    const sidMatch = String(recordingUrl).match(/(RE[0-9a-f]+)/i);
    const name = `voicemail-${sidMatch ? sidMatch[1] : "recording"}.mp3`;
    return { filename: name, content: buf, contentType: "audio/mpeg" };
  } catch (err) {
    console.warn("[email] Voicemail audio fetch failed:", err.message);
    return null;
  }
}

function buildVoicemailEmail({ from, durationSeconds, listenUrl, transcription, receivedAt }) {
  const caller = String(from || "").trim() || "Unknown number";
  const durNum = Number(durationSeconds);
  const durText = Number.isFinite(durNum) && durNum > 0 ? `${durNum} second${durNum === 1 ? "" : "s"}` : "—";
  const when = (() => {
    const d = receivedAt ? new Date(receivedAt) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });
  })();
  // listenUrl is our server-proxied link (no Twilio login required) — see
  // voicemail-store.js. The raw recordingUrl is used only server-side below
  // to fetch + attach the audio.
  const listen = String(listenUrl || "").trim();
  const transcript = String(transcription || "").trim();
  const transcriptHtml = transcript
    ? escapeHtml(transcript).replace(/\n/g, "<br>")
    : "<em>No transcription available — Twilio couldn't transcribe this recording. Listen to the audio below.</em>";

  const subject = `New voicemail from ${caller}`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; color: #1a1a1a;">
  <h2 style="margin: 0 0 8px; font-size: 22px;">📞 New voicemail</h2>
  <p style="margin: 0 0 18px; color: #555;">From <strong>${escapeHtml(caller)}</strong>${when ? ` · ${escapeHtml(when)}` : ""}</p>

  <table style="border-collapse: collapse; margin-bottom: 18px;">
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Caller</td><td style="padding: 4px 0;"><a href="tel:${escapeHtml(caller)}">${escapeHtml(caller)}</a></td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Duration</td><td style="padding: 4px 0;">${escapeHtml(durText)}</td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color: #777;">Received</td><td style="padding: 4px 0;">${escapeHtml(when || "—")}</td></tr>
  </table>

  <p style="margin: 0 0 6px;"><strong>Transcription</strong> <span style="color:#999; font-weight:400;">(best effort — verify against the audio)</span></p>
  <blockquote style="margin: 0 0 18px; padding: 12px 16px; background: #f1f0e8; border-left: 3px solid #1f4f6e; border-radius: 4px; line-height: 1.5;">
    ${transcriptHtml}
  </blockquote>

  ${listen ? `<p style="margin: 24px 0 0;">
    <a href="${escapeHtml(listen)}" style="display: inline-block; padding: 10px 18px; background: #1f4f6e; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">▶ Listen to voicemail</a>
  </p>` : ""}

  <p style="margin: 24px 0 0; font-size: 12px; color: #999;">
    Sent by the PJL Land Services voicemail handler. Calls forwarded from your Telus line when unanswered.
  </p>
</div>`.trim();

  const textLines = [
    `New voicemail from ${caller}`,
    when ? `Received: ${when}` : "",
    `Duration: ${durText}`,
    "",
    "Transcription (best effort):",
    transcript || "(none — listen to the audio)",
    "",
    listen ? `Listen: ${listen}` : ""
  ];

  return { subject, html, text: textLines.filter(Boolean).join("\n") };
}

async function sendVoicemailEmail({ from, durationSeconds, recordingUrl, listenUrl, transcription, receivedAt } = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping voicemail email (recording still stored by Twilio).");
    return { ok: false, skipped: true };
  }

  const to = process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER;
  const fromAddress = process.env.GMAIL_USER;
  // listenUrl (server-proxied, no-login) goes in the email body; recordingUrl
  // (raw Twilio) is used only here to fetch + attach the audio server-side.
  const { subject, html, text } = buildVoicemailEmail({ from, durationSeconds, listenUrl, transcription, receivedAt });
  const attachment = await fetchRecordingAttachment(recordingUrl);

  try {
    const info = await transporter.sendMail({
      from: `"PJL Voicemail" <${fromAddress}>`,
      to,
      subject,
      html,
      text,
      attachments: attachment ? [attachment] : []
    });
    console.log("[email] Sent voicemail email:", info.messageId, attachment ? "(with audio)" : "(link only)");
    await logSend({ kind: "other", to, ok: true });
    return { ok: true, messageId: info.messageId, attached: Boolean(attachment) };
  } catch (error) {
    console.error("[email] Failed to send voicemail email:", error.message);
    await logSend({ kind: "other", to, ok: false, error: error.message });
    return { ok: false, error: error.message };
  }
}

module.exports = { sendNewLeadEmail, sendVoicemailEmail };

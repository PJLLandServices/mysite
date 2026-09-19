// Klarna financing capture-deadline digest (PJL-34, build order step 5).
//
// ADMIN-facing only — this module never emails or texts a customer. The
// TRD (§8) is explicit: reminders are the whole defense for the 28-day
// clock, and per CLAUDE.md's own incident log (a sweep once emailed the
// entire customer list by mistake) this stays scoped hard to Patrick's
// own inbox/phone, never anything resolved from a quote or customer
// record.
//
// Same GMAIL_USER / GMAIL_APP_PASSWORD credentials as every other module
// here — no new secret. With mail unconfigured this logs and returns
// { ok: false, skipped: true }: the sweep still runs and still marks
// remindersSent (a missing SMTP config must never cause a double-send
// once it's fixed), it just can't deliver anything until Gmail is set up.

const { logSend } = require("./mailer-log");
const testRecipients = require("./test-recipients");

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
  transporterCache = testRecipients.guardTransport(nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  }));
  return transporterCache;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function moneyText(amount) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(amount || 0));
}

// Same resolver shape as notify-warranty.js's teamRecipient() — an env
// var specific to this module, falling back to the shared admin address.
function teamRecipient() {
  return process.env.FINANCING_TO_EMAIL ||
         process.env.NOTIFY_TO_EMAIL ||
         process.env.GMAIL_USER ||
         "info@pjllandservices.com";
}

const BRAND_WRAP = (inner) => `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 580px; color: #1a1a1a; line-height: 1.55;">
${inner}
  <p style="margin: 28px 0 0; padding-top: 16px; border-top: 1px solid #e6e6e6; font-size: 12px; color: #999;">
    PJL Land Services · <a href="tel:+19059600181" style="color:#999;">(905) 960-0181</a> ·
    <a href="mailto:info@pjllandservices.com" style="color:#999;">info@pjllandservices.com</a>
  </p>
</div>`.trim();

const CTA = (href, label) => `
  <p style="margin: 24px 0 0;">
    <a href="${escapeHtml(href)}" style="display:inline-block; padding: 11px 20px; background:#1B4D2E; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;">${escapeHtml(label)}</a>
  </p>`;

async function send({ to, subject, html, text, kind, refId }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[financing] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping "${subject}".`);
    return { ok: false, skipped: true };
  }
  const recipient = String(to || "").trim();
  if (!recipient) {
    console.warn(`[financing] No recipient for "${subject}" — skipping.`);
    return { ok: false, skipped: true, error: "no_recipient" };
  }
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to: recipient,
      replyTo: teamRecipient(),
      subject,
      html,
      text
    });
    await logSend({ kind, to: recipient, ok: true, refId });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[financing] Failed to send "${subject}":`, error.message);
    await logSend({ kind, to: recipient, ok: false, error: error.message, refId });
    return { ok: false, error: error.message };
  }
}

// One digest per sweep pass, listing every quote that JUST crossed a new
// reminder threshold this pass — never the whole standing queue (that's
// what the Pending Financing page is for). An all-clear pass sends
// nothing at all, same discipline as notify-warranty's outstanding
// digest: a "nothing due today" email trains you to stop reading it.
//
// `dueRows`: [{ id, quoteNumberDisplay, customerName, financedTotal,
//               captureBy, daysLeft, thresholdLabel, base }]
async function sendCaptureDeadlineDigest(dueRows) {
  const rows = Array.isArray(dueRows) ? dueRows : [];
  if (!rows.length) return { ok: false, skipped: true, reason: "nothing_due" };
  const base = rows[0]?.base || "";
  const subject = `${rows.length} Klarna financing hold${rows.length === 1 ? "" : "s"} approaching the 28-day capture deadline`;
  const urlFor = (r) => r.invoiceId ? `${base}/admin/invoice/${encodeURIComponent(r.invoiceId)}` : `${base}/admin/quote/${encodeURIComponent(r.id)}/proposal`;
  const bodyRows = rows.map((r) => `
    <tr>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;"><a href="${urlFor(r)}" style="color:#1B4D2E; font-weight:600;">${escapeHtml(r.quoteNumberDisplay)}</a></td>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;">${escapeHtml(r.customerName || "—")}</td>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;">${moneyText(r.financedTotal)}</td>
      <td style="padding:8px 0; border-bottom:1px solid #eee; color:#8a1c1c; font-weight:600;">${escapeHtml(r.thresholdLabel)}</td>
    </tr>`).join("");

  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">⏰ Klarna capture deadline approaching</h2>
  <p style="margin:0 0 18px; color:#555;">Stripe auto-cancels an authorization 28 days after Klarna approved it — after that, the hold is gone and that money has to be collected another way. Capture (or void, if the job's off) before the deadline.</p>
  <table style="border-collapse:collapse; width:100%; font-size:14px;">
    <tr>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Quote</th>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Customer</th>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Amount</th>
      <th style="text-align:left; padding:0 0 8px; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Deadline</th>
    </tr>
    ${bodyRows}
  </table>
${CTA(`${base}/admin/pending-financing`, "Open the Pending Financing queue →")}`);

  const text = [
    `${rows.length} Klarna financing hold(s) approaching the 28-day capture deadline:`,
    ``,
    ...rows.map((r) => `${r.quoteNumberDisplay} — ${r.customerName || "—"} — ${moneyText(r.financedTotal)} — ${r.thresholdLabel}`),
    ``,
    `${base}/admin/pending-financing`
  ].join("\n");

  return send({ to: teamRecipient(), subject, html, text, kind: "other", refId: "financing-capture-digest" });
}

// ---- Webhook-driven alerts (TRD §7/§11) ---------------------------------
//
// Fired the instant Klarna approves or declines a customer at checkout —
// distinct from the deadline digest above, which is a periodic sweep.
// "Approved" is the actual "clear to schedule the job" signal (§7 step
// 4), so it gets both channels immediately rather than waiting for the
// next reminder pass.

function detailUrl(row) {
  return row.invoiceId
    ? `${row.base}/admin/invoice/${encodeURIComponent(row.invoiceId)}`
    : `${row.base}/admin/quote/${encodeURIComponent(row.id)}/proposal`;
}

// row: { id, quoteNumberDisplay, customerName, financedTotal, captureBy, base, invoiceId, signed }
//
// PJL-35: financing can now authorize BEFORE a signature exists (apply-
// before-sign re-sequencing), so "approved" no longer automatically means
// "clear to schedule" — row.signed says which one this actually is. Two
// wordings, same email, rather than always saying "clear to schedule"
// and being wrong every time someone applies before signing.
async function sendAuthorizedAlert(row) {
  const subject = row.signed
    ? `Klarna approved — ${row.quoteNumberDisplay} is clear to schedule`
    : `Klarna approved — ${row.quoteNumberDisplay} still needs a signature`;
  const deadline = row.captureBy ? new Date(row.captureBy).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const statusLine = row.signed
    ? `Stripe is holding ${moneyText(row.financedTotal)} for <strong>${escapeHtml(row.quoteNumberDisplay)}</strong>. This job is clear to schedule.`
    : `Stripe is holding ${moneyText(row.financedTotal)} for <strong>${escapeHtml(row.quoteNumberDisplay)}</strong> — but they haven't signed yet. Not clear to schedule until they do.`;
  const statusText = row.signed
    ? `${moneyText(row.financedTotal)} held, clear to schedule`
    : `${moneyText(row.financedTotal)} held, still waiting on their signature`;
  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">✅ Klarna approved ${escapeHtml(row.customerName || "the customer")}</h2>
  <p style="margin:0 0 18px; color:#555;">${statusLine}</p>
  <p style="margin:0 0 18px; color:#555;">Capture it any time before <strong>${escapeHtml(deadline)}</strong> (28 days from approval) — after that Stripe auto-cancels the hold.</p>
${CTA(detailUrl(row), "Open this quote →")}`);
  const text = `Klarna approved ${row.customerName || "the customer"} for ${row.quoteNumberDisplay} — ${statusText}, capture by ${deadline}. ${detailUrl(row)}`;
  return send({ to: teamRecipient(), subject, html, text, kind: "other", refId: `financing-authorized-${row.id}` });
}

async function sendDeclinedAlert(row) {
  const subject = `Klarna declined ${row.customerName || "the customer"} — ${row.quoteNumberDisplay}`;
  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">⚠ Klarna declined ${escapeHtml(row.customerName || "the customer")}</h2>
  <p style="margin:0 0 18px; color:#555;">Klarna didn't approve <strong>${escapeHtml(row.quoteNumberDisplay)}</strong> at checkout. The quote is still open — nothing auto-cancelled — follow up about another payment method when you're ready.</p>
${CTA(detailUrl(row), "Open this quote →")}`);
  const text = `Klarna declined ${row.customerName || "the customer"} for ${row.quoteNumberDisplay} — quote still open, follow up another way. ${detailUrl(row)}`;
  return send({ to: teamRecipient(), subject, html, text, kind: "other", refId: `financing-declined-${row.id}` });
}

module.exports = { sendCaptureDeadlineDigest, sendAuthorizedAlert, sendDeclinedAlert, teamRecipient };

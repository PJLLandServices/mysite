// Warranty-claim email. Two audiences, one module:
//
//   CUSTOMER  — the acknowledgement on filing, then one email for every
//               status change, then the denial (with its dispute path) and
//               the dispute acknowledgement.
//   TEAM      — info@pjllandservices.com gets the full claim on filing,
//               attachments included, plus an alert when a denial is
//               disputed.
//
// Subject line convention is Patrick's, from the brief: every customer
// email after the first reads
//
//     RE: Warranty Claim File Number — 2026-08-29-00020260001
//
// so a reply threads on the claim number and the number is visible in the
// customer's inbox list without opening anything.
//
// Credentials are the same GMAIL_USER / GMAIL_APP_PASSWORD pair the rest
// of the system uses — no new secrets. With mail unconfigured every
// function here logs and returns { ok: false, skipped: true }: a claim
// must still file, and still be workable in the CRM, on a box with no
// SMTP. Every send is recorded through lib/mailer-log.js so a warranty
// email that silently fails shows up in the email-health panel like any
// other customer-facing send.

const { resolvePublicBaseUrl } = require("./public-base-url");
const { logSend } = require("./mailer-log");
const { STATUS_LABELS, STATUS_CUSTOMER_TEXT } = require("./warranty-claims");

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function moneyText(amount) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(amount || 0));
}

function dateText(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });
}

function firstNameOf(claim) {
  return String(claim?.claimant?.firstName || "").trim() ||
         String(claim?.claimant?.name || "").trim().split(/\s+/)[0] ||
         "there";
}

// The customer's status page. The claim number identifies; the token
// authorizes — see the header of lib/warranty-claims.js.
function statusUrl(claim) {
  const base = resolvePublicBaseUrl();
  return `${base}/warranty-claim-status.html?c=${encodeURIComponent(claim.id)}&t=${encodeURIComponent(claim.statusToken)}`;
}

function teamRecipient() {
  // The brief names info@ explicitly. WARRANTY_TO_EMAIL exists so a future
  // dedicated warranty inbox is an env change, not a code change.
  return process.env.WARRANTY_TO_EMAIL ||
         process.env.NOTIFY_TO_EMAIL ||
         process.env.GMAIL_USER ||
         "info@pjllandservices.com";
}

const BRAND_WRAP = (inner) => `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 580px; color: #1a1a1a; line-height: 1.55;">
${inner}
  <p style="margin: 28px 0 0; padding-top: 16px; border-top: 1px solid #e6e6e6; font-size: 12px; color: #999;">
    PJL Land Services · <a href="tel:+19059600181" style="color:#999;">(905) 960-0181</a> ·
    <a href="mailto:info@pjllandservices.com" style="color:#999;">info@pjllandservices.com</a><br>
    Newmarket, Ontario — sprinkler systems, landscape lighting, and a warranty we actually back up.
  </p>
</div>`.trim();

const CLAIM_BADGE = (claim) => `
  <p style="margin: 0 0 20px; padding: 12px 16px; background: #f1f0e8; border-left: 3px solid #1f4f6e; border-radius: 4px;">
    <span style="display:block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #777;">Warranty claim file number</span>
    <strong style="font-size: 17px; letter-spacing: .02em;">${escapeHtml(claim.id)}</strong>
  </p>`;

const CTA = (href, label) => `
  <p style="margin: 24px 0 0;">
    <a href="${escapeHtml(href)}" style="display:inline-block; padding: 11px 20px; background:#1f4f6e; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;">${escapeHtml(label)}</a>
  </p>`;

// ---- Send helper -------------------------------------------------------
// One place that knows how to talk to nodemailer, so every send in this
// module logs identically and no send can throw into a route handler.
async function send({ to, cc, subject, html, text, attachments, kind, refId, replyTo }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[warranty] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping "${subject}".`);
    return { ok: false, skipped: true };
  }
  const recipient = String(to || "").trim();
  if (!recipient) {
    console.warn(`[warranty] No recipient for "${subject}" — skipping.`);
    return { ok: false, skipped: true, error: "no_recipient" };
  }
  try {
    const info = await transporter.sendMail({
      from: `"PJL Land Services" <${process.env.GMAIL_USER}>`,
      to: recipient,
      cc: cc || undefined,
      replyTo: replyTo || teamRecipient(),
      subject,
      html,
      text,
      attachments: attachments || []
    });
    await logSend({ kind, to: recipient, ok: true, refId });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[warranty] Failed to send "${subject}":`, error.message);
    await logSend({ kind, to: recipient, ok: false, error: error.message, refId });
    return { ok: false, error: error.message };
  }
}

// ---- 1. Customer acknowledgement (on filing) ---------------------------
//
// The wording Patrick specified: received, an allocated department has
// view over it, back to you within 24 hours, check status in the portal,
// call us if it's urgent.
function buildAckEmail(claim) {
  const subject = `Warranty claim received — ${claim.id}`;
  const html = BRAND_WRAP(`
  <h2 style="margin: 0 0 6px; font-size: 22px;">Thank you — we've received your warranty claim.</h2>
  <p style="margin: 0 0 20px; color: #555;">Hi ${escapeHtml(firstNameOf(claim))},</p>
${CLAIM_BADGE(claim)}
  <p style="margin: 0 0 16px;">Your warranty claim has been received and our allocated warranty department now has view over the claim. A member of our team will review it against your original invoice and work order, and <strong>get back to you within 24 hours</strong>.</p>
  <p style="margin: 0 0 16px;">You can follow the status of this claim at any time using the link below. We'll also email you every time the status changes.</p>
${CTA(statusUrl(claim), "View my claim status →")}
  <p style="margin: 24px 0 0; padding: 12px 16px; background: #fff8ec; border-left: 3px solid #d98324; border-radius: 4px;">
    <strong>Need immediate assistance?</strong><br>
    If this is urgent — an active leak, water damage, or a system that can't be shut off — please call us directly at
    <a href="tel:+19059600181" style="color:#1f4f6e; font-weight:600;">(905) 960-0181</a> rather than waiting on the claim.
  </p>
  <h3 style="margin: 28px 0 8px; font-size: 15px;">What you filed</h3>
  <table style="border-collapse: collapse; font-size: 14px;">
    <tr><td style="padding: 4px 14px 4px 0; color:#777;">Invoice reference</td><td style="padding:4px 0;">${escapeHtml(claim.invoiceRef || "—")}</td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color:#777;">Filed</td><td style="padding:4px 0;">${escapeHtml(dateText(claim.createdAt))}</td></tr>
    <tr><td style="padding: 4px 14px 4px 0; color:#777;">Attachments</td><td style="padding:4px 0;">${claim.attachments.length} file${claim.attachments.length === 1 ? "" : "s"}</td></tr>
  </table>
  <blockquote style="margin: 12px 0 0; padding: 12px 16px; background:#f7f7f5; border-radius:6px; color:#333;">${nl2br(claim.description)}</blockquote>`);

  const text = [
    `Thank you — we've received your warranty claim.`,
    ``,
    `Warranty claim file number: ${claim.id}`,
    ``,
    `Your claim has been received and our allocated warranty department now has view over it. A member of our team will review it against your original invoice and work order and get back to you within 24 hours.`,
    ``,
    `Track your claim: ${statusUrl(claim)}`,
    ``,
    `Need immediate assistance? Call (905) 960-0181.`,
    ``,
    `Invoice reference: ${claim.invoiceRef || "—"}`,
    `Filed: ${dateText(claim.createdAt)}`,
    `Attachments: ${claim.attachments.length}`,
    ``,
    claim.description
  ].join("\n");

  return { subject, html, text };
}

async function sendClaimAck(claim) {
  const { subject, html, text } = buildAckEmail(claim);
  return send({
    to: claim.claimant.email,
    subject, html, text,
    kind: "stage_notice",
    refId: claim.id
  });
}

// ---- 2. Team email (on filing) -----------------------------------------
//
// Everything, with the customer's files attached — Patrick should be able
// to triage from his inbox without opening the CRM. The cross-check result
// rides along so "is this even our work?" is answered in the email.
function buildTeamEmail(claim, { context } = {}) {
  const subject = `New warranty claim — ${claim.id} — ${claim.claimant.name || "Unknown"}`;
  const base = resolvePublicBaseUrl();
  const crmUrl = `${base}/admin/warranty-claim/${encodeURIComponent(claim.id)}`;
  const link = claim.link || {};
  const w = link.warranty || null;

  const confidenceColor = link.confidence === "strong" ? "#1b5e20"
                        : link.confidence === "partial" ? "#8a6100"
                        : "#8a1c1c";
  const warrantyLine = !w
    ? `<em>No warranty window could be computed — no matching work order or service record was found. Check manually.</em>`
    : w.active === true
      ? `<strong style="color:#1b5e20;">In warranty</strong> — ${escapeHtml(String(w.months || "?"))} months from ${escapeHtml(dateText(w.completedAt))}, expires ${escapeHtml(dateText(w.expiresAt))}.`
      : w.active === false
        ? `<strong style="color:#8a1c1c;">Outside the warranty window</strong> — expired ${escapeHtml(dateText(w.expiresAt))}. Verify before relying on this.`
        : `<em>Warranty undetermined (${escapeHtml(w.unknownReason || "unknown")}) — the work order has no completion date on file.</em>`;

  const matchRows = `
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Customer</td><td style="padding:4px 0;">${context?.customer ? `${escapeHtml(context.customer.name)} (${escapeHtml(context.customer.id)})` : "<em>no match</em>"}</td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Property</td><td style="padding:4px 0;">${context?.property ? escapeHtml(context.property.address) : "<em>no match</em>"}</td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Invoice</td><td style="padding:4px 0;">${context?.invoice ? `${escapeHtml(context.invoice.id)} · ${escapeHtml(moneyText(context.invoice.total))} · ${escapeHtml(dateText(context.invoice.issuedAt))}` : "<em>no match</em>"}</td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Matched by</td><td style="padding:4px 0;">${escapeHtml((link.matchedBy || []).join(", ") || "nothing")}</td></tr>`;

  const unverified = (link.matchedBy || []).includes("invoice_id_unverified")
    ? `<p style="margin:0 0 16px; padding:10px 14px; background:#fdecea; border-left:3px solid #8a1c1c; border-radius:4px;"><strong>Check this:</strong> the invoice number given matches an invoice that is <em>not</em> on the customer record we matched. Confirm the claimant is entitled to claim against it.</p>`
    : "";

  const history = (context?.serviceRecords || []).length
    ? `<h3 style="margin:24px 0 8px; font-size:15px;">Past service at this property</h3>
       <ul style="margin:0 0 8px; padding-left:20px; font-size:14px;">
       ${context.serviceRecords.map((r) => `<li>${escapeHtml(dateText(r.completedAt))} — ${escapeHtml(r.woType)}${r.summary ? ` · ${escapeHtml(r.summary.slice(0, 120))}` : ""}</li>`).join("")}
       </ul>`
    : "";

  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">🛡️ New warranty claim</h2>
  <p style="margin:0 0 18px; color:#555;">${escapeHtml(claim.claimant.name)} · filed ${escapeHtml(dateText(claim.createdAt))}</p>
${CLAIM_BADGE(claim)}
${unverified}
  <table style="border-collapse:collapse; margin-bottom:18px; font-size:14px;">
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Name</td><td style="padding:4px 0;"><strong>${escapeHtml(claim.claimant.name)}</strong></td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Phone</td><td style="padding:4px 0;"><a href="tel:${escapeHtml(claim.claimant.phone)}">${escapeHtml(claim.claimant.phone)}</a></td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Email</td><td style="padding:4px 0;"><a href="mailto:${escapeHtml(claim.claimant.email)}">${escapeHtml(claim.claimant.email)}</a></td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Property given</td><td style="padding:4px 0;">${escapeHtml(claim.claimant.address || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0; color:#777;">Invoice ref given</td><td style="padding:4px 0;"><strong>${escapeHtml(claim.invoiceRef || "—")}</strong></td></tr>
  </table>

  <h3 style="margin:24px 0 8px; font-size:15px;">Customer's description</h3>
  <blockquote style="margin:0 0 18px; padding:12px 16px; background:#f7f7f5; border-radius:6px;">${nl2br(claim.description)}</blockquote>

  <h3 style="margin:24px 0 8px; font-size:15px;">CRM cross-check <span style="color:${confidenceColor}; font-weight:600;">(${escapeHtml(link.confidence || "none")})</span></h3>
  <table style="border-collapse:collapse; margin-bottom:12px; font-size:14px;">${matchRows}</table>
  <p style="margin:0 0 8px; font-size:14px;">${warrantyLine}</p>
${history}
  <h3 style="margin:24px 0 8px; font-size:15px;">Attachments (${claim.attachments.length})</h3>
  <ul style="margin:0; padding-left:20px; font-size:14px;">
    ${claim.attachments.map((a) => `<li>${escapeHtml(a.kind === "invoice" ? "Invoice copy" : "Evidence")} — ${escapeHtml(a.filename || `file-${a.n}`)} (${(a.bytes / 1000).toFixed(0)} KB)</li>`).join("") || "<li><em>None</em></li>"}
  </ul>
${CTA(crmUrl, "Open claim in the CRM →")}`);

  const text = [
    `New warranty claim — ${claim.id}`,
    ``,
    `${claim.claimant.name} · ${claim.claimant.phone} · ${claim.claimant.email}`,
    `Property: ${claim.claimant.address || "—"}`,
    `Invoice ref given: ${claim.invoiceRef || "—"}`,
    ``,
    `Description:`,
    claim.description,
    ``,
    `Cross-check (${link.confidence || "none"}): matched by ${(link.matchedBy || []).join(", ") || "nothing"}`,
    `Customer: ${context?.customer ? context.customer.name : "no match"}`,
    `Property: ${context?.property ? context.property.address : "no match"}`,
    `Invoice: ${context?.invoice ? context.invoice.id : "no match"}`,
    ``,
    `Attachments: ${claim.attachments.length}`,
    ``,
    `Open in the CRM: ${crmUrl}`
  ].join("\n");

  return { subject, html, text };
}

// `files` is [{ filename, content: Buffer, contentType }] — read off disk
// by the caller, since this module deliberately does no file I/O.
async function sendClaimToTeam(claim, { context, files } = {}) {
  const { subject, html, text } = buildTeamEmail(claim, { context });
  return send({
    to: teamRecipient(),
    subject, html, text,
    // Reply goes to the CUSTOMER: hitting reply on the team alert should
    // start the "RE: Warranty Claim File Number" conversation, not email
    // the team back.
    replyTo: claim.claimant.email || undefined,
    attachments: Array.isArray(files) ? files : [],
    kind: "lead_alert",
    refId: claim.id
  });
}

// ---- 3. Customer status update -----------------------------------------
//
// Fires on EVERY status change. `note` is Patrick's message where the
// status carries one (the questions on info_requested, the explanation on
// denied) and is shown to the customer verbatim.
function buildStatusEmail(claim, { note = "", previousStatus = null } = {}) {
  const label = STATUS_LABELS[claim.status] || claim.status;
  const subject = `RE: Warranty Claim File Number — ${claim.id}`;
  const blurb = STATUS_CUSTOMER_TEXT[claim.status] || "";

  // Per-status extras. Only two states change the shape of the email: a
  // denial has to carry the explanation and the dispute route, and
  // contact_customer is the "we are calling you" promise.
  let extra = "";
  if (claim.status === "denied") {
    extra = `
  <h3 style="margin:24px 0 8px; font-size:15px;">Why this claim was not approved</h3>
  <blockquote style="margin:0 0 18px; padding:12px 16px; background:#fdecea; border-left:3px solid #8a1c1c; border-radius:4px;">${nl2br(note || claim.denial?.reason || "")}</blockquote>
  <p style="margin:0 0 8px;"><strong>If you disagree with this decision, you can dispute it.</strong></p>
  <p style="margin:0 0 8px; font-size:14px; color:#555;">Please note: by disputing, you accept that a service-call fee applies in the event the warranty claim is not accurate for the repairs provided previously, compared to what is being claimed for.</p>
${CTA(statusUrl(claim), "Review or dispute this decision →")}`;
  } else if (claim.status === "contact_customer") {
    extra = `
  <p style="margin:16px 0 0; padding:12px 16px; background:#eef4f8; border-left:3px solid #1f4f6e; border-radius:4px;">
    <strong>We will be contacting you at the first available time.</strong><br>
    Keep an eye on your phone at <strong>${escapeHtml(claim.claimant.phone || "the number on file")}</strong>. If you'd rather reach us first, call <a href="tel:+19059600181" style="color:#1f4f6e;">(905) 960-0181</a>.
  </p>`;
  } else if (note) {
    extra = `
  <h3 style="margin:24px 0 8px; font-size:15px;">Message from our warranty department</h3>
  <blockquote style="margin:0 0 8px; padding:12px 16px; background:#f7f7f5; border-radius:6px;">${nl2br(note)}</blockquote>
  ${claim.status === "info_requested" ? `<p style="margin:8px 0 0; font-size:14px; color:#555;">Simply reply to this email — your reply comes straight to our warranty department with your file number attached.</p>` : ""}`;
  }

  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">Your warranty claim: ${escapeHtml(label)}</h2>
  <p style="margin:0 0 20px; color:#555;">Hi ${escapeHtml(firstNameOf(claim))},</p>
${CLAIM_BADGE(claim)}
  <p style="margin:0 0 8px;">The status of your warranty claim has been updated${previousStatus ? ` from <em>${escapeHtml(STATUS_LABELS[previousStatus] || previousStatus)}</em>` : ""} to <strong>${escapeHtml(label)}</strong>.</p>
  <p style="margin:0 0 16px;">${escapeHtml(blurb)}</p>
${extra}
${claim.status === "denied" ? "" : CTA(statusUrl(claim), "View my claim status →")}`);

  const text = [
    `Your warranty claim: ${label}`,
    ``,
    `Warranty claim file number: ${claim.id}`,
    ``,
    blurb,
    note ? `\n${note}` : "",
    claim.status === "denied"
      ? `\nIf you disagree with this decision you can dispute it. By disputing, you accept that a service-call fee applies in the event the warranty claim is not accurate for the repairs provided previously, compared to what is being claimed for.`
      : "",
    ``,
    `Track your claim: ${statusUrl(claim)}`,
    ``,
    `Questions? Call (905) 960-0181.`
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

async function sendStatusUpdate(claim, { note = "", previousStatus = null } = {}) {
  const { subject, html, text } = buildStatusEmail(claim, { note, previousStatus });
  return send({
    to: claim.claimant.email,
    subject, html, text,
    kind: "stage_notice",
    refId: claim.id
  });
}

// ---- 4. Dispute ---------------------------------------------------------

async function sendDisputeAck(claim) {
  const subject = `RE: Warranty Claim File Number — ${claim.id}`;
  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">Your dispute has been received.</h2>
  <p style="margin:0 0 20px; color:#555;">Hi ${escapeHtml(firstNameOf(claim))},</p>
${CLAIM_BADGE(claim)}
  <p style="margin:0 0 16px;">We've re-opened this warranty claim for review and a member of our team will be in contact with you.</p>
  <p style="margin:0 0 16px; padding:12px 16px; background:#fff8ec; border-left:3px solid #d98324; border-radius:4px; font-size:14px;">
    You accepted that a service-call fee applies in the event the warranty claim is not accurate for the repairs provided previously, compared to what is being claimed for. If the claim is upheld on review, no fee applies.
  </p>
  ${claim.dispute?.reason ? `<h3 style="margin:24px 0 8px; font-size:15px;">What you told us</h3><blockquote style="margin:0; padding:12px 16px; background:#f7f7f5; border-radius:6px;">${nl2br(claim.dispute.reason)}</blockquote>` : ""}
${CTA(statusUrl(claim), "View my claim status →")}`);
  const text = [
    `Your dispute has been received.`,
    ``,
    `Warranty claim file number: ${claim.id}`,
    ``,
    `We've re-opened this warranty claim for review and a member of our team will be in contact with you.`,
    ``,
    `You accepted that a service-call fee applies in the event the warranty claim is not accurate for the repairs provided previously, compared to what is being claimed for. If the claim is upheld on review, no fee applies.`,
    ``,
    `Track your claim: ${statusUrl(claim)}`
  ].join("\n");

  return send({ to: claim.claimant.email, subject, html, text, kind: "stage_notice", refId: claim.id });
}

async function sendDisputeAlert(claim) {
  const base = resolvePublicBaseUrl();
  const crmUrl = `${base}/admin/warranty-claim/${encodeURIComponent(claim.id)}`;
  const subject = `⚠️ Warranty claim DISPUTED — ${claim.id} — ${claim.claimant.name}`;
  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">⚠️ A denied warranty claim has been disputed</h2>
  <p style="margin:0 0 18px; color:#555;">${escapeHtml(claim.claimant.name)} · ${escapeHtml(dateText(claim.dispute?.raisedAt))}</p>
${CLAIM_BADGE(claim)}
  <p style="margin:0 0 8px;"><strong>The customer accepted the service-call fee condition.</strong> The claim is re-opened and back in the queue.</p>
  <h3 style="margin:24px 0 8px; font-size:15px;">Our denial reason</h3>
  <blockquote style="margin:0 0 16px; padding:12px 16px; background:#f7f7f5; border-radius:6px;">${nl2br(claim.denial?.reason || "—")}</blockquote>
  <h3 style="margin:24px 0 8px; font-size:15px;">Their dispute</h3>
  <blockquote style="margin:0 0 16px; padding:12px 16px; background:#fdecea; border-left:3px solid #8a1c1c; border-radius:4px;">${nl2br(claim.dispute?.reason || "(no reason given)")}</blockquote>
${CTA(crmUrl, "Open claim in the CRM →")}`);
  const text = [
    `A denied warranty claim has been disputed — ${claim.id}`,
    ``,
    `${claim.claimant.name} · ${claim.claimant.phone} · ${claim.claimant.email}`,
    `The customer accepted the service-call fee condition. The claim is re-opened.`,
    ``,
    `Our denial reason: ${claim.denial?.reason || "—"}`,
    ``,
    `Their dispute: ${claim.dispute?.reason || "(none given)"}`,
    ``,
    `Open in the CRM: ${crmUrl}`
  ].join("\n");

  return send({
    to: teamRecipient(),
    replyTo: claim.claimant.email || undefined,
    subject, html, text, kind: "lead_alert", refId: claim.id
  });
}

// ---- 5. Outstanding-claims reminder digest ------------------------------
//
// The "constantly be reminded" half of the brief. Sent to the team, not the
// customer. Lists every open claim that hasn't moved in 24h, oldest first.
// Fired by the reminder sweep in server.js; a run with nothing stale sends
// NOTHING (a daily "0 outstanding" email trains you to ignore the alert).
async function sendOutstandingDigest(staleClaims) {
  const claims = Array.isArray(staleClaims) ? staleClaims : [];
  if (!claims.length) return { ok: false, skipped: true, reason: "nothing_stale" };
  const base = resolvePublicBaseUrl();
  const subject = `${claims.length} warranty claim${claims.length === 1 ? "" : "s"} awaiting a status update`;
  const rows = claims.map((c) => `
    <tr>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;"><a href="${base}/admin/warranty-claim/${encodeURIComponent(c.id)}" style="color:#1f4f6e; font-weight:600;">${escapeHtml(c.id)}</a></td>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;">${escapeHtml(c.claimant?.name || "—")}</td>
      <td style="padding:8px 12px 8px 0; border-bottom:1px solid #eee;">${escapeHtml(STATUS_LABELS[c.status] || c.status)}</td>
      <td style="padding:8px 0; border-bottom:1px solid #eee; color:#8a1c1c; font-weight:600;">${escapeHtml(String(c.hoursSinceStatus ?? "?"))}h</td>
    </tr>`).join("");

  const html = BRAND_WRAP(`
  <h2 style="margin:0 0 6px; font-size:22px;">⏰ Warranty claims need a status update</h2>
  <p style="margin:0 0 18px; color:#555;">These claims are open and haven't moved in over 24 hours. Oldest first.</p>
  <table style="border-collapse:collapse; width:100%; font-size:14px;">
    <tr>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Claim</th>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Customer</th>
      <th style="text-align:left; padding:0 12px 8px 0; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Status</th>
      <th style="text-align:left; padding:0 0 8px; color:#777; font-weight:600; border-bottom:2px solid #ddd;">Waiting</th>
    </tr>
    ${rows}
  </table>
${CTA(`${base}/admin/warranty-claims`, "Open the warranty queue →")}`);

  const text = [
    `${claims.length} warranty claim(s) awaiting a status update:`,
    ``,
    ...claims.map((c) => `${c.id} — ${c.claimant?.name || "—"} — ${STATUS_LABELS[c.status] || c.status} — ${c.hoursSinceStatus ?? "?"}h waiting`),
    ``,
    `${base}/admin/warranty-claims`
  ].join("\n");

  return send({ to: teamRecipient(), subject, html, text, kind: "other", refId: "warranty-digest" });
}

module.exports = {
  sendClaimAck,
  sendClaimToTeam,
  sendStatusUpdate,
  sendDisputeAck,
  sendDisputeAlert,
  sendOutstandingDigest,
  statusUrl,
  teamRecipient,
  // Exported for the regression tests — building an email must be testable
  // without a live SMTP transport.
  buildAckEmail,
  buildTeamEmail,
  buildStatusEmail
};

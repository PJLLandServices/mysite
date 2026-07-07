// Google review request sequences (design_handoff_review_request_emails,
// Jul 2026). A 2-email ask that fires after a WO completes:
//
//   WO completed → wait ~7 days → EMAIL 1 (review ask)
//                → wait ~7 days → EMAIL 2 (reminder) unless suppressed
//
// Suppression for email 2 (checked at send time, not schedule time):
//   - CTA in email 1 was clicked (proxy for "left a review" — the
//     handoff README offers GBP-API polling OR click tracking; we track
//     clicks via the /rr/<token> redirect)
//   - customer unsubscribed (review-channel token, see outreach.js)
//   - a NEWER work order exists for the same customer (they rebooked;
//     they'll get a fresh sequence after that job — don't stack asks)
//   - "customer replied to email 1" can't be auto-detected over Gmail
//     SMTP — the admin Cancel button on /admin/review-requests is the
//     manual path for that rule.
//
// Additional rules from the handoff:
//   - one sequence per customer per 6 months, regardless of job count
//     (enforced at creation)
//   - send window Tue–Thu ~10:00 America/Toronto (due times snap
//     forward to the next valid slot; the sweep also refuses to fire
//     outside a sane local-hours window and re-snaps instead)
//
// Scheduling survives restarts: due times are persisted in
// server/data/review-requests.json and a periodic sweep (server.js
// boot) fires whatever is due. No in-memory timers to lose.
//
// The whole feature is OFF until Patrick flips settings.reviewRequests
// .enabled on /admin/review-requests — completions while disabled do
// NOT enqueue (so enabling later can't retro-blast old customers).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolvePublicBaseUrl } = require("./public-base-url");

const FILE = path.join(__dirname, "..", "data", "review-requests.json");
const TEMPLATE_1 = path.join(__dirname, "templates", "review-request-email-1.html");
const TEMPLATE_2 = path.join(__dirname, "templates", "review-request-email-2.html");

// Subjects per the handoff README. {{first_name}} in subject 2 is
// substituted at send time.
const SUBJECT_1 = "A quick word from your sprinkler guys";
const SUBJECT_2 = "Last nudge, {{first_name}} — promise";

// Lowercase, plain-language service names for "your {{service}} wrapped
// up" (handoff README: e.g. "spring opening", "sprinkler repair").
const SERVICE_PHRASES = {
  spring_opening: "spring opening",
  fall_closing: "fall closing",
  service_visit: "sprinkler service",
  build: "irrigation project"
};
const FALLBACK_SERVICE = "sprinkler service";

// Days a due record may age past its slot before we give up on it
// (server down for a long stretch, or the feature was re-enabled after
// weeks off). A month-late "your service wrapped up about a week ago"
// reads as spam — suppress instead.
const MAX_OVERDUE_DAYS = 14;

// Six-month cooldown between sequences for the same customer.
const COOLDOWN_DAYS = 183;

// Gap between messages in a manual "send now" batch — keeps a block of
// Gmail sends from tripping rate/spam heuristics. Matches the seasonal
// outreach engine's pacing; override with GMAIL_PACING_MS.
const SEND_NOW_PACING_MS = Number(process.env.GMAIL_PACING_MS) || 150;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Store (same flat-JSON + tmp-rename idiom as invoices.js) -------

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  await fs.rename(tmp, FILE);
}

function makeId() {
  return `RR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function historyEntry(action, note) {
  return { ts: new Date().toISOString(), action, note: note || "" };
}

// ---- Send-window math (America/Toronto, no deps) ---------------------

const SEND_HOUR = 10;           // ~10:00 local per the handoff
const SEND_DOWS = new Set(["Tue", "Wed", "Thu"]);
// The sweep only fires inside this local-hour band; a due record hit
// outside it (server was down through its slot) re-snaps instead of
// e-mailing someone at 3 a.m.
const FIRE_HOUR_MIN = 9;
const FIRE_HOUR_MAX = 20;

function torontoParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    weekday: parts.weekday,                    // "Tue"
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour === "24" ? "0" : parts.hour),
    mm: Number(parts.minute)
  };
}

// UTC offset (hours, negative for Toronto) in effect at `date`.
function torontoOffsetHours(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    timeZoneName: "shortOffset"
  });
  const tzPart = fmt.formatToParts(date).find((p) => p.type === "timeZoneName");
  const match = /GMT([+-]\d+)/.exec(tzPart?.value || "");
  return match ? Number(match[1]) : -5;
}

// The UTC instant for HH:00 Toronto time on the local calendar day that
// contains `date`. DST-boundary weeks can be off by an hour — harmless
// for a marketing send window.
function torontoSlotUtc(date, hour) {
  const p = torontoParts(date);
  const offset = torontoOffsetHours(date);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, hour - offset, 0, 0));
}

// First Tue/Wed/Thu 10:00 Toronto at or after `from`. Exported for the
// admin page's "next send" preview and for tests.
function nextSendSlot(from) {
  const start = from instanceof Date ? from : new Date(from);
  for (let i = 0; i < 15; i++) {
    const candidate = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    if (!SEND_DOWS.has(torontoParts(candidate).weekday)) continue;
    const slot = torontoSlotUtc(candidate, SEND_HOUR);
    if (slot.getTime() >= start.getTime()) return slot;
  }
  // Unreachable (any 15-day span holds a valid slot) — but never throw
  // from scheduling math.
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
}

function withinFireWindow(now = new Date()) {
  const p = torontoParts(now);
  return SEND_DOWS.has(p.weekday) && p.hh >= FIRE_HOUR_MIN && p.hh < FIRE_HOUR_MAX;
}

// ---- Rendering --------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderTemplate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`
  );
}

function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function servicePhrase(woType) {
  return SERVICE_PHRASES[woType] || FALLBACK_SERVICE;
}

async function buildEmail(which, record, { reviewUrl, unsubscribeUrl }) {
  const templatePath = which === 1 ? TEMPLATE_1 : TEMPLATE_2;
  const raw = await fs.readFile(templatePath, "utf8");
  const vars = {
    first_name: escapeHtml(record.firstName || "there"),
    service: escapeHtml(record.service || FALLBACK_SERVICE),
    logo_url: `${resolvePublicBaseUrl()}/crm/review-email-logo.png`,
    review_url: escapeHtml(reviewUrl),
    unsubscribe_url: escapeHtml(unsubscribeUrl || "")
  };
  const html = renderTemplate(raw, vars);
  const subject = renderTemplate(which === 1 ? SUBJECT_1 : SUBJECT_2, {
    first_name: record.firstName || "there"
  });
  const text = which === 1
    ? [
        `Hi ${record.firstName || "there"} — your ${record.service} wrapped up about a week ago. Hope the system's doing its job.`,
        ``,
        `We don't run ads. We run on word of mouth — and on Google, word of mouth looks like a review. It takes about 60 seconds:`,
        reviewUrl,
        ``,
        `Not 5 stars? Tell us first — (905) 960-0181. We'll make it right.`,
        ``,
        `PJL Land Services · Newmarket, ON · (905) 960-0181`,
        unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""
      ].filter((l) => l !== "").join("\n")
    : [
        `Hi ${record.firstName || "there"} — a couple of weeks back we finished your ${record.service}. If it went well, we'd be grateful for a quick Google review:`,
        reviewUrl,
        ``,
        `Every review helps a neighbour in Newmarket or the GTA pick a crew they can trust. That's the whole pitch.`,
        ``,
        `Already done it? Thank you. We won't email about this again.`,
        ``,
        `PJL Land Services · Newmarket, ON · (905) 960-0181`,
        unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""
      ].filter((l) => l !== "").join("\n");
  return { subject, html, text };
}

// ---- Mail transport (same Gmail creds as every other notify module) --

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

// From: a real person, per the handoff ("not info@ or no-reply@").
// Gmail SMTP forces the authenticated mailbox as the actual sender, so
// the person-ness lives in the display name (configurable in settings).
function fromHeader(settings) {
  const name = settings?.reviewRequests?.fromName || "Patrick from PJL Land Services";
  const addr = process.env.CUSTOMER_EMAIL || process.env.GMAIL_USER || "info@pjllandservices.com";
  return `"${name.replace(/"/g, "")}" <${addr}>`;
}

// ---- URLs -------------------------------------------------------------

// Both emails' review links route through /rr/<token> so a click stamps
// ctaClickedAt (the email-2 suppression proxy) before the 302 to the
// real Google review URL.
function trackedReviewUrl(record) {
  return `${resolvePublicBaseUrl()}/rr/${record.ctaToken}`;
}

async function unsubscribeUrlFor(record) {
  // Review-channel opt-out token lives on the property's commPrefs
  // (same system as seasonal outreach; type=review). Minted lazily.
  if (!record.propertyId) return "";
  try {
    const properties = require("./properties");
    const property = await properties.mintOptOutTokensIfMissing(record.propertyId);
    const token = property?.commPrefs?.optOutTokens?.reviewEmail;
    return token ? `${resolvePublicBaseUrl()}/unsubscribe/${token}?type=review` : "";
  } catch {
    return "";
  }
}

// ---- Creation (called from the completion cascade + backfill) ----------

// Gates, in order. Returns { scheduled, reason, record }.
// opts.anchorAt (ISO string) re-anchors the delay to a past completion
// date — the backfill path. A job completed 10 days ago with a 7-day
// delay is already "due", so it lands on the next send slot from now
// rather than a week out.
// opts.source tags the history entry ("cascade" | "backfill").
async function scheduleForWo(wo, opts = {}) {
  if (!wo || !wo.id) return { scheduled: false, reason: "no_wo" };

  const settingsLib = require("./settings");
  const settings = await settingsLib.get();
  const config = settings.reviewRequests || {};
  if (config.enabled !== true) return { scheduled: false, reason: "disabled" };

  const email = String(wo.customerEmail || "").trim().toLowerCase();
  if (!email) return { scheduled: false, reason: "no_email" };

  // Review-channel opt-out (property-level, same as seasonal prefs).
  if (wo.propertyId) {
    try {
      const properties = require("./properties");
      const property = await properties.get(wo.propertyId);
      if (property?.commPrefs?.reviewRequestsEmail === false) {
        return { scheduled: false, reason: "opted_out" };
      }
    } catch { /* tolerate missing property — WO gate already required one */ }
  }

  const records = await readAll();

  // Idempotent per WO for the EMAIL channel (cascade can re-fire). An SMS
  // record for the same WO does NOT block the email sequence and vice
  // versa — they're independent asks (the SMS path exists precisely to
  // reach customers whose email is filtered).
  if (records.some((r) => r.woId === wo.id && r.channel !== "sms")) {
    return { scheduled: false, reason: "already_scheduled_for_wo" };
  }

  // One EMAIL sequence per customer per 6 months, regardless of job
  // count. Customers without an id are matched by email. SMS sends have
  // their own separate cooldown (see sendSmsRequestsNow).
  const cutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const recent = records.find((r) => {
    if (r.channel === "sms") return false;
    if (new Date(r.createdAt).getTime() < cutoff) return false;
    if (wo.customerId && r.customerId === wo.customerId) return true;
    return r.email === email;
  });
  if (recent) return { scheduled: false, reason: "cooldown_6_months", existingId: recent.id };

  const now = new Date();
  const delayDays = Number.isFinite(Number(config.delayDays)) ? Number(config.delayDays) : 7;
  const anchorMs = opts.anchorAt ? new Date(opts.anchorAt).getTime() : now.getTime();
  const baseMs = Math.max(
    now.getTime(),
    (Number.isFinite(anchorMs) ? anchorMs : now.getTime()) + delayDays * 24 * 60 * 60 * 1000
  );
  const dueAt = nextSendSlot(new Date(baseMs));

  const record = {
    id: makeId(),
    woId: wo.id,
    woType: wo.type || "service_visit",
    customerId: wo.customerId || null,
    propertyId: wo.propertyId || null,
    customerName: wo.customerName || "",
    firstName: firstNameOf(wo.customerName),
    email,
    phone: null,
    service: servicePhrase(wo.type),
    channel: "email",          // "email" | "sms"
    status: "scheduled",       // scheduled | reminder_scheduled | completed | suppressed | cancelled
    suppressReason: null,
    ctaToken: makeToken(),
    ctaClickedAt: null,
    ctaClickCount: 0,
    email1: { dueAt: dueAt.toISOString(), sentAt: null, messageId: null },
    email2: { dueAt: null, sentAt: null, messageId: null },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: [historyEntry("scheduled", `Email 1 due ${dueAt.toISOString()} (WO ${wo.id} completed${opts.source === "backfill" ? "; enqueued via backfill" : ""})`)]
  };
  records.push(record);
  await writeAll(records);
  return { scheduled: true, record };
}

// ---- Mutations --------------------------------------------------------

async function updateRecord(id, mutate) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const record = records[idx];
  mutate(record);
  record.updatedAt = new Date().toISOString();
  records[idx] = record;
  await writeAll(records);
  return record;
}

async function cancel(id, { by = "admin", reason = "" } = {}) {
  return updateRecord(id, (r) => {
    if (r.status === "completed") throw new Error("Sequence already completed.");
    r.status = "cancelled";
    r.suppressReason = reason || "cancelled_by_admin";
    r.history.push(historyEntry("cancelled", `${by}${reason ? ` — ${reason}` : ""}`));
  });
}

// Cancel every pending sequence for a property (unsubscribe path) or a
// customer. Quiet best-effort — callers treat failures as non-fatal.
async function cancelPending({ propertyId = null, customerId = null, reason = "unsubscribed" } = {}) {
  const records = await readAll();
  let changed = 0;
  for (const r of records) {
    if (r.status !== "scheduled" && r.status !== "reminder_scheduled") continue;
    const match = (propertyId && r.propertyId === propertyId) ||
                  (customerId && r.customerId === customerId);
    if (!match) continue;
    r.status = "cancelled";
    r.suppressReason = reason;
    r.updatedAt = new Date().toISOString();
    r.history.push(historyEntry("cancelled", reason));
    changed++;
  }
  if (changed) await writeAll(records);
  return { cancelled: changed };
}

// /rr/<token> click. Stamps the suppression proxy and returns the real
// Google review URL for the 302. Unknown token → null (caller 404s).
async function recordCtaClick(token) {
  if (!token) return null;
  const records = await readAll();
  const record = records.find((r) => r.ctaToken === token);
  if (!record) return null;
  if (!record.ctaClickedAt) {
    record.ctaClickedAt = new Date().toISOString();
    record.history.push(historyEntry("cta_clicked", "Review link opened"));
  }
  record.ctaClickCount = (record.ctaClickCount || 0) + 1;
  record.updatedAt = new Date().toISOString();
  await writeAll(records);
  const settingsLib = require("./settings");
  const settings = await settingsLib.get();
  return settings.reviewRequests?.googleReviewUrl || null;
}

// ---- Send + sweep ------------------------------------------------------

async function sendEmail(which, record, settings) {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, reason: "no_gmail_config" };
  const reviewUrl = trackedReviewUrl(record);
  const unsubscribeUrl = await unsubscribeUrlFor(record);
  const { subject, html, text } = await buildEmail(which, record, { reviewUrl, unsubscribeUrl });
  const info = await transporter.sendMail({
    from: fromHeader(settings),
    to: record.email,
    replyTo: process.env.CUSTOMER_EMAIL || process.env.GMAIL_USER || "info@pjllandservices.com",
    subject,
    html,
    text
  });
  return { ok: true, messageId: info.messageId };
}

// Re-checked at send time for BOTH emails.
async function liveGates(record, settings) {
  if (settings.reviewRequests?.enabled !== true) return "disabled";
  if (!record.email) return "no_email";
  if (record.propertyId) {
    try {
      const properties = require("./properties");
      const property = await properties.get(record.propertyId);
      if (property?.commPrefs?.reviewRequestsEmail === false) return "opted_out";
    } catch { /* tolerate */ }
  }
  return null;
}

// Email-2-only suppression (handoff README list).
async function email2Suppression(record) {
  if (record.ctaClickedAt) return "cta_clicked";
  try {
    const workOrders = require("./work-orders");
    const all = await workOrders.list();
    const newer = all.find((wo) =>
      wo.id !== record.woId &&
      wo.status !== "cancelled" &&
      (record.customerId ? wo.customerId === record.customerId
        : String(wo.customerEmail || "").trim().toLowerCase() === record.email) &&
      new Date(wo.createdAt || 0).getTime() > new Date(record.createdAt).getTime()
    );
    if (newer) return "new_job_booked";
  } catch { /* list failure → don't suppress on a guess */ }
  return null;
}

// ---- SMS channel (Twilio) ---------------------------------------------
//
// For customers whose email is filtered (Yahoo/AOL junk folders, strict
// spam gateways), an email review ask never lands. A text does. This is
// a single-touch, send-now-only path — no reminder text (a nagging
// follow-up text reads worse than an email), and it's independent of the
// email sequence so a customer we already emailed for a filtered inbox
// can still be reached by text for the same job.

function smsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

// Normalize to E.164 for North America. Returns null when the input
// can't be made into a plausible number (so the caller skips instead of
// handing Twilio garbage).
function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    return d.length >= 10 ? `+${d}` : null;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function buildReviewSmsBody(record, url) {
  return (
    `Hi ${record.firstName || "there"}, it's PJL Land Services — thanks again for your ${record.service}. ` +
    `If we did right by you, a quick Google review means a lot to a local crew: ${url}`
  );
}

// Twilio REST send — same shape as notify-customer.js's outreach SMS
// (carrier-level STOP, "Reply STOP to opt out." appended). Returns
// { ok, sid } / { ok:false, reason }.
async function sendReviewSms(record, url) {
  if (!smsConfigured()) return { ok: false, reason: "no_twilio_config" };
  const toNum = normalizePhone(record.phone);
  if (!toNum) return { ok: false, reason: "bad_phone" };
  let body = buildReviewSmsBody(record, url);
  if (!/\bSTOP\b/i.test(body)) body = `${body.trim()}\nReply STOP to opt out.`;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const payload = new URLSearchParams({ To: toNum, From: process.env.TWILIO_FROM_NUMBER, Body: body });
  try {
    const response = await fetch(twilioUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: payload.toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[review-requests] Twilio rejected:", response.status, data?.message);
      return { ok: false, reason: data?.message || `twilio_${response.status}` };
    }
    return { ok: true, sid: data.sid };
  } catch (err) {
    console.error("[review-requests] SMS send failed:", err?.message);
    return { ok: false, reason: err?.message || "twilio_failed" };
  }
}

// An SMS record that still counts (blocks a re-text of the same WO).
function hasActiveSms(records, woId) {
  return records.some((r) =>
    r.woId === woId && r.channel === "sms" &&
    (r.status === "scheduled" || r.status === "completed"));
}

// Prior SMS review sent to this customer within the cooldown. Matched by
// customerId, else by normalized phone. Only completed sends count (a
// failed attempt shouldn't lock the customer out of a retry).
function smsCooldownHit(records, { customerId, phone }) {
  const cutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return records.some((r) => {
    if (r.channel !== "sms" || r.status !== "completed") return false;
    if (new Date(r.createdAt).getTime() < cutoff) return false;
    if (customerId && r.customerId === customerId) return true;
    return phone && r.phone === phone;
  });
}

let sweepInProgress = false;

// Fires anything due. Boot + interval driven from server.js. Returns
// counts for the log line.
async function sweepDue() {
  if (sweepInProgress) return { skipped: true };
  sweepInProgress = true;
  try {
    const now = new Date();
    const records = await readAll();
    const due = records.filter((r) =>
      (r.status === "scheduled" && r.email1.dueAt && new Date(r.email1.dueAt) <= now) ||
      (r.status === "reminder_scheduled" && r.email2.dueAt && new Date(r.email2.dueAt) <= now)
    );
    if (!due.length) return { considered: 0, sent: 0, suppressed: 0 };

    const settingsLib = require("./settings");
    const settings = await settingsLib.get();
    let sent = 0, suppressed = 0, deferred = 0;

    for (const snapshot of due) {
      const which = snapshot.status === "scheduled" ? 1 : 2;
      const slot = which === 1 ? snapshot.email1 : snapshot.email2;

      // Aged out — the slot passed too long ago to still read naturally.
      const overdueMs = now.getTime() - new Date(slot.dueAt).getTime();
      if (overdueMs > MAX_OVERDUE_DAYS * 24 * 60 * 60 * 1000) {
        await updateRecord(snapshot.id, (r) => {
          r.status = "suppressed";
          r.suppressReason = "aged_out";
          r.history.push(historyEntry("suppressed", `Email ${which} slot aged out (${Math.round(overdueMs / 86400000)}d past due)`));
        });
        suppressed++;
        continue;
      }

      // Outside the local send window (server was down through the
      // slot) — re-snap rather than firing at a weird hour/day.
      if (!withinFireWindow(now)) {
        const next = nextSendSlot(now);
        await updateRecord(snapshot.id, (r) => {
          const s = which === 1 ? r.email1 : r.email2;
          s.dueAt = next.toISOString();
          r.history.push(historyEntry("resnapped", `Email ${which} slot missed; moved to ${next.toISOString()}`));
        });
        deferred++;
        continue;
      }

      const gate = await liveGates(snapshot, settings);
      if (gate) {
        // "disabled" just parks the record (it may be re-enabled);
        // opt-outs terminate it.
        if (gate === "opted_out") {
          await updateRecord(snapshot.id, (r) => {
            r.status = "cancelled";
            r.suppressReason = "unsubscribed";
            r.history.push(historyEntry("cancelled", "Review-email opt-out found at send time"));
          });
          suppressed++;
        }
        continue;
      }

      if (which === 2) {
        const why = await email2Suppression(snapshot);
        if (why) {
          await updateRecord(snapshot.id, (r) => {
            r.status = "suppressed";
            r.suppressReason = why;
            r.history.push(historyEntry("suppressed", `Email 2 suppressed: ${why}`));
          });
          suppressed++;
          continue;
        }
      }

      try {
        const result = await sendEmail(which, snapshot, settings);
        if (!result.ok) {
          // Missing mail config — leave the record due; the next sweep
          // after config lands will pick it up (age-out caps the wait).
          continue;
        }
        const reminderDelayDays = Number.isFinite(Number(settings.reviewRequests?.reminderDelayDays))
          ? Number(settings.reviewRequests.reminderDelayDays) : 7;
        await updateRecord(snapshot.id, (r) => {
          if (which === 1) {
            r.email1.sentAt = new Date().toISOString();
            r.email1.messageId = result.messageId || null;
            const due2 = nextSendSlot(new Date(Date.now() + reminderDelayDays * 24 * 60 * 60 * 1000));
            r.email2.dueAt = due2.toISOString();
            r.status = "reminder_scheduled";
            r.history.push(historyEntry("email1_sent", `Reminder due ${due2.toISOString()}`));
          } else {
            r.email2.sentAt = new Date().toISOString();
            r.email2.messageId = result.messageId || null;
            r.status = "completed";
            r.history.push(historyEntry("email2_sent", "Sequence complete"));
          }
        });
        sent++;
        console.log(`[review-requests] sent email ${which} for ${snapshot.id} to ${snapshot.email}`);
      } catch (err) {
        console.warn(`[review-requests] send failed for ${snapshot.id}:`, err?.message);
      }
    }
    return { considered: due.length, sent, suppressed, deferred };
  } finally {
    sweepInProgress = false;
  }
}

// ---- Backfill (load already-completed WOs into the queue) --------------
//
// The cascade only catches completions AFTER the feature shipped; this
// pulls recent history in. Two-step by design: candidates() is a pure
// dry-run the admin reviews, enqueue() only touches the WO ids they
// explicitly checked. Nothing here sends — enqueued records ride the
// same sweep + gates as cascade-created ones.

// When a WO actually completed: the status_change→completed history
// entry, else the cascade_fire breadcrumb, else departure/update stamps.
function woCompletedAt(wo) {
  const h = Array.isArray(wo?.history) ? wo.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]?.action === "status_change" && h[i]?.after === "completed") return h[i].ts;
  }
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]?.action === "cascade_fire") return h[i].ts;
  }
  return wo?.departedAt || wo?.updatedAt || wo?.createdAt || null;
}

async function backfillCandidates({ sinceDays = 60 } = {}) {
  const days = Number.isFinite(Number(sinceDays)) ? Math.min(Math.max(Number(sinceDays), 1), 365) : 60;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const workOrders = require("./work-orders");
  const invoices = require("./invoices");
  const properties = require("./properties");

  const [allWos, allInvoices, records] = await Promise.all([
    workOrders.list(),
    invoices.list().catch(() => []),
    readAll()
  ]);

  const invoiceByWo = new Map();
  for (const inv of allInvoices) {
    if (!inv?.woId || inv.status === "void") continue;
    // Newest non-void invoice wins if a WO somehow has several.
    const prev = invoiceByWo.get(inv.woId);
    if (!prev || String(inv.createdAt || "") > String(prev.createdAt || "")) {
      invoiceByWo.set(inv.woId, inv);
    }
  }

  // Email channel: "already queued" + 6-month cooldown look at EMAIL
  // records only (channel !== "sms"), so a prior text doesn't block an
  // email and vice versa.
  const woIdsWithEmailRecord = new Set(records.filter((r) => r.channel !== "sms").map((r) => r.woId));
  const cooldownCutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const emailRecentByCustomer = new Set();
  const emailRecentByEmail = new Set();
  for (const r of records) {
    if (r.channel === "sms") continue;
    if (new Date(r.createdAt).getTime() < cooldownCutoff) continue;
    if (r.customerId) emailRecentByCustomer.add(r.customerId);
    if (r.email) emailRecentByEmail.add(r.email);
  }

  const completed = allWos
    .filter((wo) => wo.status === "completed" && wo.type !== "build")
    .map((wo) => ({ wo, completedAt: woCompletedAt(wo) }))
    .filter((x) => x.completedAt && new Date(x.completedAt).getTime() >= cutoffMs)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));

  // One ask per customer: candidates are sorted newest-first, so the
  // first time we see a customer is their newest job. Older siblings are
  // flagged (both channels).
  const seenCustomerKeys = new Set();

  // Property review opt-out — fetched once per property, cached.
  const optOutCache = new Map();
  async function reviewOptedOut(propertyId) {
    if (!propertyId) return false;
    if (optOutCache.has(propertyId)) return optOutCache.get(propertyId);
    let out = false;
    try {
      const property = await properties.get(propertyId);
      out = property?.commPrefs?.reviewRequestsEmail === false;
    } catch { /* tolerate */ }
    optOutCache.set(propertyId, out);
    return out;
  }

  const candidates = [];
  for (const { wo, completedAt } of completed) {
    const email = String(wo.customerEmail || "").trim().toLowerCase();
    const phone = normalizePhone(wo.customerPhone);
    const invoice = invoiceByWo.get(wo.id) || null;
    const customerKey = wo.customerId || email || phone;
    const isNewest = customerKey ? !seenCustomerKeys.has(customerKey) : true;
    if (customerKey) seenCustomerKeys.add(customerKey);
    const optedOut = await reviewOptedOut(wo.propertyId);

    // Email eligibility.
    let reason = null;
    if (!email) reason = "no_email";
    else if (woIdsWithEmailRecord.has(wo.id)) reason = "already_queued";
    else if ((wo.customerId && emailRecentByCustomer.has(wo.customerId)) || emailRecentByEmail.has(email)) reason = "cooldown_6_months";
    else if (!isNewest) reason = "newer_job_in_list";
    else if (optedOut) reason = "opted_out";

    // SMS eligibility — independent of email records for the same WO.
    let smsReason = null;
    if (!phone) smsReason = "no_phone";
    else if (optedOut) smsReason = "opted_out";
    else if (hasActiveSms(records, wo.id)) smsReason = "already_texted";
    else if (!isNewest) smsReason = "newer_job_in_list";
    else if (smsCooldownHit(records, { customerId: wo.customerId, phone })) smsReason = "sms_cooldown";

    candidates.push({
      woId: wo.id,
      woType: wo.type,
      customerName: wo.customerName || "",
      email,
      hasPhone: Boolean(phone),
      phoneDisplay: wo.customerPhone || "",
      service: servicePhrase(wo.type),
      completedAt,
      invoiceId: invoice?.id || null,
      invoiceStatus: invoice ? invoice.status : "none",
      invoiceSentAt: invoice?.sentAt || null,
      eligible: !reason,
      reason,
      smsEligible: !smsReason,
      smsReason
    });
  }
  return { sinceDays: days, candidates };
}

// Send Email 1 right now for a freshly-created record and advance it to
// reminder_scheduled. Same state transition as the sweep's email-1
// branch, but bypasses the Tue–Thu slot because the operator explicitly
// asked to send now. Returns { ok, reason }. A missing/failed send
// leaves the record "scheduled" so the sweep still retries it later.
async function deliverEmail1Now(record, settings) {
  const result = await sendEmail(1, record, settings);
  if (!result.ok) return { ok: false, reason: result.reason || "send_failed" };
  const reminderDelayDays = Number.isFinite(Number(settings.reviewRequests?.reminderDelayDays))
    ? Number(settings.reviewRequests.reminderDelayDays) : 7;
  await updateRecord(record.id, (r) => {
    r.email1.sentAt = new Date().toISOString();
    r.email1.messageId = result.messageId || null;
    const due2 = nextSendSlot(new Date(Date.now() + reminderDelayDays * 24 * 60 * 60 * 1000));
    r.email2.dueAt = due2.toISOString();
    r.status = "reminder_scheduled";
    r.history.push(historyEntry("email1_sent", `Sent now (manual batch); reminder due ${due2.toISOString()}`));
  });
  console.log(`[review-requests] send-now email 1 for ${record.id} to ${record.email}`);
  return { ok: true };
}

// Enqueue the explicitly-selected WO ids. Each one re-runs the full
// scheduleForWo gate stack (so a double-submit or a same-customer pair
// degrades to a skip, never a duplicate).
//
// sendNow=true fires Email 1 immediately (paced) instead of parking it
// for the next send slot — the "send a block right now" path. The
// reminder still schedules normally.
async function backfillEnqueue({ woIds = [], by = "admin", sendNow = false } = {}) {
  const settingsLib = require("./settings");
  const settings = await settingsLib.get();
  if (settings.reviewRequests?.enabled !== true) {
    throw new Error("Turn the automation on first — backfilled sequences would never send while it's off.");
  }
  if (sendNow && !getTransporter()) {
    throw new Error("Gmail isn't configured (GMAIL_USER / GMAIL_APP_PASSWORD) — can't send now.");
  }
  const workOrders = require("./work-orders");
  const results = [];
  let firstSend = true;
  for (const rawId of woIds.slice(0, 200)) {
    const woId = String(rawId || "");
    try {
      const wo = await workOrders.get(woId);
      if (!wo) { results.push({ woId, scheduled: false, sent: false, reason: "wo_not_found" }); continue; }
      if (wo.status !== "completed") { results.push({ woId, scheduled: false, sent: false, reason: "not_completed" }); continue; }
      const r = await scheduleForWo(wo, { anchorAt: woCompletedAt(wo), source: "backfill" });
      const entry = {
        woId,
        scheduled: r.scheduled === true,
        sent: false,
        reason: r.scheduled ? null : r.reason,
        recordId: r.record?.id || null,
        email1DueAt: r.record?.email1?.dueAt || null
      };
      if (r.scheduled) {
        try {
          await workOrders.appendHistory(woId, {
            action: "review_request_scheduled",
            by,
            note: `${r.record.id} — backfill${sendNow ? " (send now)" : ""}; email 1 due ${r.record.email1.dueAt}`
          });
        } catch { /* history is best-effort */ }
        if (sendNow) {
          if (!firstSend) await sleep(SEND_NOW_PACING_MS);
          firstSend = false;
          const del = await deliverEmail1Now(r.record, settings);
          entry.sent = del.ok;
          if (!del.ok) entry.reason = del.reason;
        }
      }
      results.push(entry);
    } catch (err) {
      results.push({ woId, scheduled: false, sent: false, reason: err?.message || "enqueue_failed" });
    }
  }
  return {
    enqueued: results.filter((r) => r.scheduled).length,
    sent: results.filter((r) => r.sent).length,
    skipped: results.filter((r) => !r.scheduled).length,
    results
  };
}

// Send a review-request TEXT right now to the selected completed WOs.
// Single-touch, immediate, paced. Each WO runs the SMS gate stack
// (phone present, review opt-out, no active text for the WO, 6-month SMS
// cooldown) — independent of the email sequence, so a customer we
// already emailed for a filtered inbox can still be texted for the same
// job. A failed send marks the record cancelled (reason sms_send_failed)
// so it doesn't block a retry.
async function sendSmsRequestsNow({ woIds = [], by = "admin" } = {}) {
  const settingsLib = require("./settings");
  const settings = await settingsLib.get();
  if (settings.reviewRequests?.enabled !== true) {
    throw new Error("Turn the automation on first — review texts are part of the same automation.");
  }
  if (!smsConfigured()) {
    throw new Error("Texting isn't configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER).");
  }
  const workOrders = require("./work-orders");
  const properties = require("./properties");
  const results = [];
  let first = true;
  for (const rawId of woIds.slice(0, 200)) {
    const woId = String(rawId || "");
    try {
      const wo = await workOrders.get(woId);
      if (!wo) { results.push({ woId, sent: false, reason: "wo_not_found" }); continue; }
      if (wo.status !== "completed") { results.push({ woId, sent: false, reason: "not_completed" }); continue; }

      const phone = normalizePhone(wo.customerPhone);
      const email = String(wo.customerEmail || "").trim().toLowerCase();
      const records = await readAll();

      let reason = null;
      if (!phone) reason = "no_phone";
      else if (hasActiveSms(records, wo.id)) reason = "already_texted";
      else if (smsCooldownHit(records, { customerId: wo.customerId, phone })) reason = "sms_cooldown";
      if (!reason && wo.propertyId) {
        try {
          const property = await properties.get(wo.propertyId);
          if (property?.commPrefs?.reviewRequestsEmail === false) reason = "opted_out";
        } catch { /* tolerate */ }
      }
      if (reason) { results.push({ woId, sent: false, reason }); continue; }

      const now = new Date();
      const record = {
        id: makeId(),
        woId: wo.id,
        woType: wo.type || "service_visit",
        customerId: wo.customerId || null,
        propertyId: wo.propertyId || null,
        customerName: wo.customerName || "",
        firstName: firstNameOf(wo.customerName),
        email,
        phone,
        service: servicePhrase(wo.type),
        channel: "sms",
        status: "scheduled",
        suppressReason: null,
        ctaToken: makeToken(),
        ctaClickedAt: null,
        ctaClickCount: 0,
        email1: { dueAt: null, sentAt: null, messageId: null },
        email2: { dueAt: null, sentAt: null, messageId: null },
        sms: { sentAt: null, sid: null },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        history: [historyEntry("scheduled", `SMS review request (WO ${wo.id} completed)`)]
      };
      // Persist BEFORE sending so the /rr/<token> click target is durable
      // even if the process dies mid-send.
      const all = await readAll();
      all.push(record);
      await writeAll(all);

      if (!first) await sleep(SEND_NOW_PACING_MS);
      first = false;

      const url = trackedReviewUrl(record);
      const send = await sendReviewSms(record, url);
      if (send.ok) {
        await updateRecord(record.id, (r) => {
          r.status = "completed";
          r.sms = { sentAt: new Date().toISOString(), sid: send.sid || null };
          r.history.push(historyEntry("sms_sent", `Text sent${send.sid ? ` (sid ${send.sid})` : ""}`));
        });
        try {
          await workOrders.appendHistory(woId, {
            action: "review_request_scheduled",
            by,
            note: `${record.id} — review text sent to ${phone}`
          });
        } catch { /* best-effort */ }
        console.log(`[review-requests] review text sent for ${record.id} to ${phone}`);
        results.push({ woId, sent: true, reason: null, recordId: record.id });
      } else {
        await updateRecord(record.id, (r) => {
          r.status = "cancelled";
          r.suppressReason = "sms_send_failed";
          r.history.push(historyEntry("cancelled", `SMS send failed: ${send.reason}`));
        });
        results.push({ woId, sent: false, reason: send.reason });
      }
    } catch (err) {
      results.push({ woId, sent: false, reason: err?.message || "send_failed" });
    }
  }
  return {
    sent: results.filter((r) => r.sent).length,
    skipped: results.filter((r) => !r.sent).length,
    results
  };
}

// ---- Admin helpers -----------------------------------------------------

async function list() {
  const records = await readAll();
  // Newest first — the admin page is a "what's in flight" view.
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Test send — renders a sample of either email to the admin's inbox so
// Patrick can see the real thing without waiting a week. No record is
// created; the CTA link points straight at the review URL (no token).
async function sendTest({ which = 1, to = null } = {}) {
  const settingsLib = require("./settings");
  const settings = await settingsLib.get();
  const transporter = getTransporter();
  if (!transporter) throw new Error("Gmail isn't configured (GMAIL_USER / GMAIL_APP_PASSWORD).");
  const recipient = String(to || process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER || "").trim();
  if (!recipient) throw new Error("No test recipient (set NOTIFY_TO_EMAIL or pass an email).");
  const sample = {
    firstName: "Patrick",
    service: "spring opening",
    email: recipient
  };
  const reviewUrl = settings.reviewRequests?.googleReviewUrl || "https://g.page/r/CYxgaMP9EmcbEBM/review";
  const { subject, html, text } = await buildEmail(Number(which) === 2 ? 2 : 1, sample, {
    reviewUrl,
    unsubscribeUrl: `${resolvePublicBaseUrl()}/unsubscribe/sample-test-token?type=review`
  });
  const info = await transporter.sendMail({
    from: fromHeader(settings),
    to: recipient,
    replyTo: process.env.CUSTOMER_EMAIL || process.env.GMAIL_USER || "info@pjllandservices.com",
    subject: `[TEST] ${subject}`,
    html,
    text
  });
  return { ok: true, to: recipient, messageId: info.messageId };
}

module.exports = {
  scheduleForWo,
  sweepDue,
  list,
  cancel,
  cancelPending,
  recordCtaClick,
  sendTest,
  backfillCandidates,
  backfillEnqueue,
  sendSmsRequestsNow,
  nextSendSlot,
  // exported for tests
  withinFireWindow,
  servicePhrase
};

// The assignment writer's messages — stage 3 of docs/ASSIGNMENT_WRITER.md.
//
// Templates for the cadence's four distinct messages:
//
//   assignment  (step 1, the blast)      email + SMS
//   followup    (step 2, D−15)           email + SMS
//   nudge       (steps 3–5, D−10/−7/−5)  email + SMS — Patrick's
//               escalation wording (Part 3 of the spec), copy-edited
//               here as the DEFAULT; he has final edit on every word.
//   reminder24  (step 6, D−1)            SMS only, goes to everyone
//
// NOTHING HERE SENDS. This module stores, validates, and renders text.
// Stage 4 is the only place a rendered message may leave the building,
// and it may not do so before touches carry a `type`.
//
// STORAGE, same layering as the booking window (seasons.js): the
// defaults below are the code's safe baseline; Patrick's edits live in
// server/data/assignment-templates.json on the persistent disk, so they
// survive deploys, and clearing an edit falls back to the default.
//
// MERGE FIELDS are a closed set. A template that references a field not
// in MERGE_FIELDS is REFUSED at save — a typo like {frstName} must fail
// in Patrick's face at edit time, never render literally in a
// customer's text at send time.
//
// ONE LINK, decided by Patrick on stage-3 review: every message carries
// a single {appointmentLink} to the customer's appointment page, where
// THEY decide — confirm, reschedule, or cancel in one place. Two
// separate links doubled the URLs in every SMS (splitting each text
// into extra segments the customer receives as multiple messages) and
// made the customer pick an action before seeing their appointment.
// The link renders as a loud [appointment-link] placeholder until
// stage 5 builds the page and stage 4 supplies real URLs; stage 4 must
// refuse to send any message that still contains a bracketed
// placeholder.

const fs = require("fs");
const path = require("path");
const { BOOKING_BUCKETS } = require("./availability");

const STORE_FILE = path.resolve(__dirname, "..", "data", "assignment-templates.json");

const PJL_PHONE = "(905) 960-0181";

// field -> what the screen's legend says it renders as.
const MERGE_FIELDS = Object.freeze({
  firstName: "The customer's first name (\"Kristen\")",
  name: "The customer's full name",
  street: "The street address, without town (\"90 Oriole Drive\")",
  date: "The appointment date (\"Monday, September 28\")",
  bucket: "The window (\"Morning (8 AM – 12 PM)\")",
  appointmentLink: "Their appointment page — confirm, reschedule, or cancel in one place (built at send time)",
  phone: "The PJL phone number"
});

// key -> { label, channel, hasSubject }
const TEMPLATE_KEYS = Object.freeze({
  assignment_email: { label: "Step 1 — Assignment (email)", channel: "email", hasSubject: true },
  assignment_sms: { label: "Step 1 — Assignment (text)", channel: "sms", hasSubject: false },
  followup_email: { label: "Step 2 — Follow-up (email)", channel: "email", hasSubject: true },
  followup_sms: { label: "Step 2 — Follow-up (text)", channel: "sms", hasSubject: false },
  nudge_email: { label: "Steps 3–5 — The nudge (email)", channel: "email", hasSubject: true },
  nudge_sms: { label: "Steps 3–5 — The nudge (text)", channel: "sms", hasSubject: false },
  reminder24_sms: { label: "Step 6 — 24-hour reminder (text)", channel: "sms", hasSubject: false }
});

const DEFAULT_TEMPLATES = Object.freeze({
  assignment_email: {
    subject: "Your fall sprinkler winterization is booked — {date}",
    body: [
      "Hi {firstName},",
      "",
      "We've scheduled your fall sprinkler winterization:",
      "",
      "{date} — {bucket}",
      "{street}",
      "",
      "Please confirm — or pick a different day — on your appointment page:",
      "{appointmentLink}",
      "",
      "If we don't hear from you, no problem — we'll still arrive as scheduled.",
      "Questions? Call or text us at {phone}.",
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  assignment_sms: {
    body: "PJL Land Services: your fall sprinkler winterization is booked for {date} ({bucket}) at {street}. "
      + "Confirm or make changes: {appointmentLink} Questions? {phone}"
  },
  followup_email: {
    subject: "Please confirm — winterization on {date}",
    body: [
      "Hi {firstName},",
      "",
      "A quick reminder: your fall sprinkler winterization is scheduled for",
      "{date} ({bucket}) at {street}, and we haven't heard a confirmation from you yet.",
      "",
      "Confirm — or make any changes — on your appointment page:",
      "{appointmentLink}",
      "",
      "If nothing changes on your end, we'll still be there as planned.",
      "Call or text {phone} any time.",
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  followup_sms: {
    body: "PJL Land Services: reminder — winterization {date} ({bucket}) at {street}. "
      + "Please confirm or make changes: {appointmentLink} We'll come as planned unless we hear otherwise."
  },
  // Patrick's Part-3 escalation wording, copy-edited but keeping his
  // meaning: we will keep reminding; if your needs changed, tell the
  // booking team; otherwise we keep trying to reach you.
  nudge_email: {
    subject: "We haven't heard from you — winterization on {date}",
    body: [
      "Hi {firstName},",
      "",
      "We've reached out several times about your scheduled fall winterization on",
      "{date} ({bucket}) at {street}, and unfortunately haven't received a",
      "confirmation yet. We'll continue to send reminders until we hear from you.",
      "",
      "We understand customers' needs change. If you no longer require our services,",
      "please make sure you've let our booking team know at {phone} — otherwise we",
      "will continue to make every effort to reach you.",
      "",
      "Confirm, reschedule, or cancel on your appointment page:",
      "{appointmentLink}",
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  nudge_sms: {
    body: "PJL Land Services: we've tried several times to confirm your winterization on {date} at {street}, "
      + "and we'll keep sending reminders. If you no longer need our services, please tell our booking team "
      + "at {phone}. Otherwise: {appointmentLink}"
  },
  reminder24_sms: {
    body: "PJL Land Services: a reminder that your fall sprinkler winterization is tomorrow — "
      + "{date}, {bucket}, at {street}. Questions or changes? Call or text {phone}."
  }
});

// ---- Store ------------------------------------------------------------

let OVERRIDES = {};
(function loadOverrides() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) OVERRIDES = parsed;
    }
  } catch (err) {
    console.warn(`[assignment-messages] could not read template overrides — defaults in use: ${err?.message}`);
  }
}());

function persist() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(OVERRIDES, null, 2) + "\n", "utf8");
}

// Every {placeholder} a text references. Doubled braces are not a thing
// here — templates are plain text with single-brace fields.
function placeholdersIn(text) {
  return [...String(text || "").matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
}

function assertKnownPlaceholders(text, where) {
  for (const field of placeholdersIn(text)) {
    if (!Object.prototype.hasOwnProperty.call(MERGE_FIELDS, field)) {
      throw new Error(
        `${where} references {${field}}, which isn't a merge field. `
        + `Available: ${Object.keys(MERGE_FIELDS).map((f) => `{${f}}`).join(" ")}`
      );
    }
  }
}

// The effective template for a key: Patrick's override or the default.
function templateFor(key) {
  if (!TEMPLATE_KEYS[key]) return null;
  const custom = OVERRIDES[key];
  const base = DEFAULT_TEMPLATES[key];
  if (!custom) return { ...base, source: "default" };
  return {
    subject: TEMPLATE_KEYS[key].hasSubject ? (custom.subject || base.subject) : undefined,
    body: custom.body || base.body,
    source: "custom",
    updatedAt: custom.updatedAt || null,
    actor: custom.actor || null
  };
}

function listTemplates() {
  const out = {};
  for (const key of Object.keys(TEMPLATE_KEYS)) {
    out[key] = {
      ...TEMPLATE_KEYS[key],
      ...templateFor(key),
      default: DEFAULT_TEMPLATES[key]
    };
  }
  return out;
}

// Save Patrick's wording for one template. Empty body (and subject)
// clears the override — back to the default.
function setTemplate(key, { subject, body } = {}, opts = {}) {
  const meta = TEMPLATE_KEYS[key];
  if (!meta) throw new Error(`Unknown template "${key}".`);
  const cleanBody = String(body == null ? "" : body).trim();
  const cleanSubject = meta.hasSubject ? String(subject == null ? "" : subject).trim() : "";

  if (!cleanBody && !cleanSubject) {
    delete OVERRIDES[key];
    persist();
    return templateFor(key);
  }
  if (!cleanBody) throw new Error("The message body can't be empty — clear both fields to go back to the default.");
  if (meta.hasSubject && !cleanSubject) throw new Error("An email needs a subject line.");

  assertKnownPlaceholders(cleanBody, "The body");
  if (meta.hasSubject) assertKnownPlaceholders(cleanSubject, "The subject");

  OVERRIDES[key] = {
    ...(meta.hasSubject ? { subject: cleanSubject } : {}),
    body: cleanBody,
    updatedAt: new Date().toISOString(),
    actor: String(opts.actor || "admin").slice(0, 120)
  };
  persist();
  return templateFor(key);
}

// ---- Rendering ---------------------------------------------------------

function firstNameOf(fullName) {
  const name = String(fullName || "").trim();
  return name ? name.split(/\s+/)[0] : "there";
}

function streetOf(address) {
  const first = String(address || "").split(/[\n,]+/)[0].trim();
  return first || String(address || "").trim();
}

function bucketLabelOf(bucketKey) {
  const bucket = BOOKING_BUCKETS.find((b) => b.key === bucketKey);
  if (!bucket) return bucketKey || "";
  const word = bucket.key === "morning" ? "Morning" : "Afternoon";
  return `${word} (${bucket.windowLabel})`;
}

function dateLabelOf(scheduledFor) {
  const d = new Date(scheduledFor);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
}

// Build the merge context from an assignment booking record. The link
// defaults to a LOUD placeholder — stage 4 must supply the real URL and
// must refuse to send anything still carrying a bracketed placeholder.
function contextForBooking(booking, extra = {}) {
  return {
    firstName: firstNameOf(booking?.customerName),
    name: String(booking?.customerName || "").trim() || "there",
    street: streetOf(booking?.address),
    date: dateLabelOf(booking?.scheduledFor),
    bucket: bucketLabelOf(booking?.assignment?.bucket
      || (new Date(booking?.scheduledFor).getHours() < 12 ? "morning" : "afternoon")),
    appointmentLink: "[appointment-link]",
    phone: PJL_PHONE,
    ...extra
  };
}

function fill(text, context) {
  return String(text || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, field) =>
    Object.prototype.hasOwnProperty.call(context, field) ? String(context[field]) : whole);
}

// Render one template against a context. Returns { subject?, body }.
function render(key, context) {
  const meta = TEMPLATE_KEYS[key];
  if (!meta) throw new Error(`Unknown template "${key}".`);
  const t = templateFor(key);
  return {
    ...(meta.hasSubject ? { subject: fill(t.subject, context) } : {}),
    body: fill(t.body, context)
  };
}

// Render every template against one booking — the preview screen's food.
function renderAllForBooking(booking, extra = {}) {
  const context = contextForBooking(booking, extra);
  const out = {};
  for (const key of Object.keys(TEMPLATE_KEYS)) out[key] = render(key, context);
  return { context, messages: out };
}

module.exports = {
  MERGE_FIELDS,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATES,
  PJL_PHONE,
  listTemplates,
  setTemplate,
  templateFor,
  render,
  renderAllForBooking,
  contextForBooking
};

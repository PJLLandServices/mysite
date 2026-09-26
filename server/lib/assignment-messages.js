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
const { priceForBooking } = require("./pricing");

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
  price: "The customer's price for the service (their profile override, or the tier price)",
  oldDate: "The PREVIOUS date, when a whole route day was moved (\"Monday, September 28\")",
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
  reminder24_sms: { label: "Step 6 — 24-hour reminder (text)", channel: "sms", hasSubject: false },
  daymove_email: { label: "Day moved — re-notify (email)", channel: "email", hasSubject: true },
  daymove_sms: { label: "Day moved — re-notify (text)", channel: "sms", hasSubject: false }
});

// TWO WAYS TO CONFIRM (Patrick, 2026-09-26): press Confirm on the link,
// or reply YES to our text. A reply to the EMAIL does neither — nothing
// reads the inbox — and customers who replied "confirmed" to the email
// kept getting reminders (Frank Mazzuca, Nishka Potter). Every email says so.
const REPLY_NOTE = [
  "Please note: replying to this email does not confirm your appointment —",
  "please use the button, or reply YES to our text message."
];

const DEFAULT_TEMPLATES = Object.freeze({
  // Patrick's wording from the stage-5 live review, lightly tidied. The
  // routing-efficiency pitch is his; keep his meaning when editing.
  assignment_email: {
    subject: "Your fall sprinkler winterization is booked — {date}",
    body: [
      "Hi {firstName},",
      "",
      "PJL Land Services has conveniently scheduled your fall closing:",
      "",
      "{date} — {bucket}",
      "{street}",
      "Your price: {price}",
      "",
      "In our effort to increase day-to-day efficiency, we've created dedicated",
      "routes for our service trucks, so nearby homes are completed together",
      "rather than jumping between towns through our busy season. We trust that",
      "working this way lets us keep providing the same great service without",
      "raising our prices.",
      "",
      "To confirm, tap the button below and press Confirm — or reply YES to our text message.",
      "Need to make a change? The same page lets you:",
      "{appointmentLink}",
      "",
      "Please only choose a different day if no one can be home. We've tried to",
      "account for the requirements customers have shared with us before — if",
      "you have any others, or any restrictions beyond the available options,",
      "call or text us at {phone}.",
      "",
      ...REPLY_NOTE,
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  assignment_sms: {
    // "Reply YES" because customers reply to texts no matter what the text
    // says — lib/sms-inbound.js hears it. The last line tells them the
    // number is automated, so a question goes to Patrick's real number.
    body: "PJL Land Services: your fall sprinkler winterization is booked for {date} ({bucket}) at {street}. "
      + "Reply YES to confirm, or tap to make changes: {appointmentLink} "
      + "This is an automated number - to reach us, call or text {phone}."
  },
  followup_email: {
    subject: "Please confirm — winterization on {date}",
    body: [
      "Hi {firstName},",
      "",
      "A quick reminder: your fall sprinkler winterization is scheduled for",
      "{date} ({bucket}) at {street}, and we haven't heard a confirmation from you yet.",
      "",
      "To confirm, tap the button below and press Confirm — or reply YES to our text message.",
      "To make a change, use the same page:",
      "{appointmentLink}",
      "",
      "If nothing changes on your end, we'll still be there as planned.",
      "Call or text {phone} any time.",
      "",
      ...REPLY_NOTE,
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  followup_sms: {
    body: "PJL Land Services: reminder — winterization {date} ({bucket}) at {street}. "
      + "Reply YES to confirm or tap to change: {appointmentLink} We'll come as planned unless we hear otherwise. "
      + "Automated number - to reach us, call or text {phone}."
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
      "To confirm, tap the button below and press Confirm — or reply YES to our text message.",
      "The same page lets you reschedule or cancel:",
      "{appointmentLink}",
      "",
      ...REPLY_NOTE,
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  nudge_sms: {
    body: "PJL Land Services: we've tried several times to confirm your winterization on {date} at {street}, "
      + "and we'll keep sending reminders. If you no longer need us, please tell our booking team "
      + "at {phone}. Otherwise reply YES, or tap: {appointmentLink}"
  },
  reminder24_sms: {
    body: "PJL Land Services: a reminder that your fall sprinkler winterization is tomorrow — "
      + "{date}, {bucket}, at {street}. Questions or changes? Call or text {phone} "
      + "(please don't reply to this automated message)."
  },
  // Cadence rule 6: the re-notify NAMES THE CHANGE ("was X, now Y")
  // rather than restating the new date as if it were always so.
  daymove_email: {
    subject: "Your appointment has moved — now {date}",
    body: [
      "Hi {firstName},",
      "",
      "Weather and routing sometimes move one of our whole service days, and",
      "yours has moved:",
      "",
      "Was: {oldDate}",
      "Now: {date} — {bucket}",
      "{street}",
      "",
      "Everything else stays the same — same service, same price ({price}).",
      "To confirm the new day, tap the button below and press Confirm — or reply YES to our text.",
      "To make a change, use the same page:",
      "{appointmentLink}",
      "",
      "Questions? Call or text us at {phone}.",
      "",
      ...REPLY_NOTE,
      "",
      "— PJL Land Services"
    ].join("\n")
  },
  daymove_sms: {
    body: "PJL Land Services: your winterization day has MOVED — was {oldDate}, now {date} ({bucket}) "
      + "at {street}. Reply YES to confirm the new day or tap to change: {appointmentLink} "
      + "Automated number - to reach us, call or text {phone}."
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

// ONE-TIME: the "Reply YES" texts (2026-09-25). The text defaults gained
// "Reply YES to confirm" and "this is an automated number" when replies
// to the Twilio number started being heard (lib/sms-inbound.js). Saved
// wording always wins over a default, and saved text wording from the
// original stage-5 setup was still on the live disk — so customers kept
// getting the old texts. Patrick never meant to customise them and asked
// for the new wording everywhere, so the saved TEXT wording for these
// five steps is retired once, here, at load. Emails are untouched.
//
// Nothing is thrown away: each retired override is kept under
// `_retired` with the time. The marker makes this run exactly once, so
// wording Patrick saves AFTER this sticks like it always has.
const REPLY_YES_MIGRATION = "replyYesTexts_2026_09_25";
const REPLY_YES_KEYS = ["assignment_sms", "followup_sms", "nudge_sms", "reminder24_sms", "daymove_sms"];
function retireOldTextWording(store, { now = new Date() } = {}) {
  const migrations = { ...(store._migrations || {}) };
  if (migrations[REPLY_YES_MIGRATION]) return { store, changed: false, retired: [] };
  const next = { ...store, _retired: { ...(store._retired || {}) } };
  const retired = [];
  for (const key of REPLY_YES_KEYS) {
    if (!next[key]) continue;
    next._retired[`${key}@${now.toISOString()}`] = next[key];
    delete next[key];
    retired.push(key);
  }
  migrations[REPLY_YES_MIGRATION] = now.toISOString();
  next._migrations = migrations;
  return { store: next, changed: true, retired };
}
// ONE-TIME, the emails (2026-09-26): same story as the texts. The four
// appointment emails now say "tap the button and press Confirm, or reply
// YES to our text" and that an email reply doesn't confirm; saved email wording from the original setup
// would hide it. Patrick asked for the new wording across the board.
const CONFIRM_BY_TEXT_EMAIL_MIGRATION = "confirmByTextEmails_2026_09_26";
const CONFIRM_BY_TEXT_EMAIL_KEYS = ["assignment_email", "followup_email", "nudge_email", "daymove_email"];
function retireOldEmailWording(store, { now = new Date() } = {}) {
  return retireSaved(store, CONFIRM_BY_TEXT_EMAIL_MIGRATION, CONFIRM_BY_TEXT_EMAIL_KEYS, { now });
}
function retireSaved(store, marker, keys, { now = new Date() } = {}) {
  const migrations = { ...(store._migrations || {}) };
  if (migrations[marker]) return { store, changed: false, retired: [] };
  const next = { ...store, _retired: { ...(store._retired || {}) } };
  const retired = [];
  for (const key of keys) {
    if (!next[key]) continue;
    next._retired[`${key}@${now.toISOString()}`] = next[key];
    delete next[key];
    retired.push(key);
  }
  migrations[marker] = now.toISOString();
  next._migrations = migrations;
  return { store: next, changed: true, retired };
}
try {
  const out = retireOldEmailWording(OVERRIDES);
  if (out.changed) {
    OVERRIDES = out.store;
    if (fs.existsSync(STORE_FILE) || out.retired.length) persist();
    if (out.retired.length) {
      console.log(`[assignment-messages] retired saved email wording for ${out.retired.join(", ")} — the new default emails are now in use (old wording kept under _retired).`);
    }
  }
} catch (err) {
  console.warn(`[assignment-messages] couldn't retire old email wording: ${err?.message}`);
}
try {
  const out = retireOldTextWording(OVERRIDES);
  if (out.changed) {
    OVERRIDES = out.store;
    if (fs.existsSync(STORE_FILE) || out.retired.length) persist();
    if (out.retired.length) {
      console.log(`[assignment-messages] retired saved text wording for ${out.retired.join(", ")} — the new default texts are now in use (old wording kept under _retired).`);
    }
  }
} catch (err) {
  console.warn(`[assignment-messages] couldn't retire old text wording: ${err?.message}`);
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
// An override referencing a merge field that no longer exists (saved
// before a field was renamed — {confirmLink} before the one-link change)
// is IGNORED with a warning: rendering it would put literal braces in a
// customer's message, and the default is always safe.
function templateFor(key) {
  if (!TEMPLATE_KEYS[key]) return null;
  const custom = OVERRIDES[key];
  const base = DEFAULT_TEMPLATES[key];
  if (!custom) return { ...base, source: "default" };
  const unknown = [...placeholdersIn(custom.subject), ...placeholdersIn(custom.body)]
    .filter((f) => !Object.prototype.hasOwnProperty.call(MERGE_FIELDS, f));
  if (unknown.length) {
    console.warn(`[assignment-messages] ignoring saved ${key} — it references retired field(s) {${unknown.join("} {")}}; using the default until it is re-saved`);
    return { ...base, source: "default", staleOverride: true };
  }
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
    // The tier price for the booking's service. Callers holding the
    // PROPERTY pass extra.price from resolveSeasonalPrice() so a
    // per-customer override wins; this is the always-defined fallback.
    price: priceForBooking(booking?.serviceKey || "").label || "Quoted on-site",
    // Only meaningful on a day-move send, where the caller supplies it.
    oldDate: "",
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
  retireOldTextWording,
  retireOldEmailWording,
  REPLY_YES_KEYS,
  CONFIRM_BY_TEXT_EMAIL_KEYS,
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

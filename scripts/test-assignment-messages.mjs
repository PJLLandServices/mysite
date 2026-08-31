// Assignment message templates — stage 3 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-assignment-messages.mjs
//
// WHAT THIS PROTECTS. The words that will reach customers, and the
// guarantees around them:
//
//   1. The default set is COMPLETE — every cadence step has its texts,
//      emails have subjects, and every placeholder in every default is a
//      real merge field. A template with a broken field renders literal
//      braces in a customer's message, which is the embarrassment this
//      file exists to prevent.
//   2. Saving is STRICT — a typo'd {frstName} is refused at edit time.
//   3. Patrick's nudge intent survives the copy-edit: keep reminding,
//      tell the booking team if your needs changed, otherwise we keep
//      trying to reach you.
//   4. Overrides persist, reset restores the default, and NOTHING in the
//      module can send: no notify/mailer/sms require, no sendBulk.
//
// Sandboxed like the other suites — overrides land in the sandbox's own
// data dir, never in real data.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-messages-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const messages = require(path.join(SANDBOX, "server/lib/assignment-messages.js"));

// ---- 1. The default set is complete and clean ------------------------

const EXPECTED_KEYS = [
  "assignment_email", "assignment_sms",
  "followup_email", "followup_sms",
  "nudge_email", "nudge_sms",
  "reminder24_sms",
  "daymove_email", "daymove_sms"
];

ok("every cadence step has its templates — the universe is exactly the spec's",
  JSON.stringify(Object.keys(messages.TEMPLATE_KEYS).sort())
  === JSON.stringify([...EXPECTED_KEYS].sort()),
  Object.keys(messages.TEMPLATE_KEYS).join(", "));

for (const key of EXPECTED_KEYS) {
  const t = messages.DEFAULT_TEMPLATES[key];
  ok(`${key} has a default body`, Boolean(t && t.body && t.body.trim()));
  if (messages.TEMPLATE_KEYS[key].hasSubject) {
    ok(`${key} has a default subject`, Boolean(t.subject && t.subject.trim()));
  }
  const fields = [...String(t.subject || "").matchAll(/\{([a-zA-Z0-9_]+)\}/g),
                  ...String(t.body).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  ok(`every placeholder in ${key} is a real merge field`,
    fields.every((f) => f in messages.MERGE_FIELDS),
    fields.filter((f) => !(f in messages.MERGE_FIELDS)).join(", "));
}

// ONE LINK PER MESSAGE — Patrick's stage-3 review call. Every message
// that asks for an answer carries exactly one {appointmentLink}, where
// the customer decides (confirm / reschedule / cancel). Two links
// doubled the URLs and split each SMS into extra segments.
for (const key of ["assignment_email", "assignment_sms", "followup_email", "followup_sms", "nudge_email", "nudge_sms", "daymove_email", "daymove_sms"]) {
  const links = [...messages.DEFAULT_TEMPLATES[key].body.matchAll(/\{appointmentLink\}/g)].length;
  ok(`${key} carries exactly ONE appointment link`, links === 1, `${links} links`);
  ok(`${key} carries no legacy split links`,
    !/\{(confirmLink|rescheduleLink)\}/.test(messages.DEFAULT_TEMPLATES[key].body));
}
ok("the 24-hour reminder needs no link — it goes to everyone, answered or not",
  !messages.DEFAULT_TEMPLATES.reminder24_sms.body.includes("{appointmentLink}"));

// Patrick's live-review additions: the assignment email carries the
// customer's PRICE and his routing-efficiency pitch, and asks customers
// to move only when no one can be home.
ok("the assignment email shows the customer their price",
  messages.DEFAULT_TEMPLATES.assignment_email.body.includes("{price}"));
ok("the assignment email carries Patrick's dedicated-routes pitch",
  /dedicated\s+routes/i.test(messages.DEFAULT_TEMPLATES.assignment_email.body)
  && /without\s+raising/i.test(messages.DEFAULT_TEMPLATES.assignment_email.body));
ok("...and asks customers to move only if no one can be home",
  /only choose a different day if no one can be home/i.test(messages.DEFAULT_TEMPLATES.assignment_email.body));
ok("{price} is a real merge field with a real fallback",
  "price" in messages.MERGE_FIELDS
  && messages.contextForBooking({ serviceKey: "fall_close_4z" }).price.startsWith("$"));

// Cadence rule 6: the day-move message NAMES THE CHANGE.
ok("the day-move templates say 'was {oldDate}' rather than restating the new date as if it were always so",
  messages.DEFAULT_TEMPLATES.daymove_sms.body.includes("was {oldDate}")
  && messages.DEFAULT_TEMPLATES.daymove_email.body.includes("Was: {oldDate}")
  && messages.DEFAULT_TEMPLATES.daymove_email.body.includes("Now: {date}"));
{
  const ctx = messages.contextForBooking({
    customerName: "Kristen Holmes", serviceKey: "fall_close_4z",
    address: "90 Oriole Drive, East Gwillimbury, ON",
    scheduledFor: new Date(2026, 9, 3, 8, 0).toISOString(),
    assignment: { bucket: "morning" }
  }, { appointmentLink: "https://pjllandservices.com/a/AbCdEf123456", oldDate: "Monday, September 28" });
  const len = messages.render("daymove_sms", ctx).body.length;
  ok(`the day-move SMS fits two segments with both dates spelled out (${len} chars)`, len <= 306, String(len));
}

// The segment budget behind the one-link decision: rendered with a
// realistic link, every SMS fits in at most TWO segments (306 chars
// concatenated), so no step arrives as a pile of split texts.
{
  const sample = messages.contextForBooking({
    customerName: "Kristen Holmes",
    address: "90 Oriole Drive, East Gwillimbury, ON",
    scheduledFor: new Date(2026, 8, 28, 8, 13).toISOString(),
    assignment: { bucket: "morning" }
  }, { appointmentLink: "https://pjllandservices.com/a/AbCdEf123456" });
  for (const key of ["assignment_sms", "followup_sms", "nudge_sms", "reminder24_sms"]) {
    const len = messages.render(key, sample).body.length;
    ok(`${key} fits in two SMS segments with a real link (${len} chars)`, len <= 306, String(len));
  }
}

// ---- 2. Patrick's nudge intent survives the copy-edit -----------------

const nudge = messages.DEFAULT_TEMPLATES.nudge_email.body + " " + messages.DEFAULT_TEMPLATES.nudge_sms.body;
ok("the nudge says the reminders will continue",
  /continue|keep sending|we'll keep/i.test(nudge));
ok("the nudge tells a changed-needs customer to inform the booking team",
  /no longer require/i.test(nudge) && /booking team/i.test(nudge));
ok("the nudge keeps 'every effort to reach you'",
  /every effort to reach/i.test(nudge));

// ---- 3. Rendering -----------------------------------------------------

const BOOKING = {
  id: "BK-2026-0100",
  customerName: "Kristen Holmes",
  address: "90 Oriole Drive, East Gwillimbury, ON L9N 0M2",
  scheduledFor: new Date(2026, 8, 28, 8, 13).toISOString(),
  durationMinutes: 75,
  assignment: { season: "fall", year: 2026, date: "2026-09-28", bucket: "morning", code: "P-1" }
};

const { context, messages: all } = messages.renderAllForBooking(BOOKING);
ok("the context reads the customer, not the record",
  context.firstName === "Kristen" && context.street === "90 Oriole Drive"
  && context.date === "Monday, September 28" && context.bucket === "Morning (8 AM – 12 PM)",
  JSON.stringify(context));

for (const key of EXPECTED_KEYS) {
  const msg = all[key];
  const leftover = [...(msg.subject || "").matchAll(/\{[a-zA-Z0-9_]+\}/g),
                    ...msg.body.matchAll(/\{[a-zA-Z0-9_]+\}/g)];
  ok(`${key} renders with no unfilled {fields}`, leftover.length === 0,
    leftover.map((m) => m[0]).join(", "));
}
ok("a rendered message names the customer's day and window",
  all.assignment_sms.body.includes("Monday, September 28")
  && all.assignment_sms.body.includes("Morning (8 AM – 12 PM)"));
ok("the link renders as a LOUD placeholder until the send step builds real ones",
  all.assignment_sms.body.includes("[appointment-link]"),
  all.assignment_sms.body);
ok("a supplied real link replaces the placeholder",
  messages.render("assignment_sms",
    messages.contextForBooking(BOOKING, { appointmentLink: "https://pjl.example/a/tok" })
  ).body.includes("https://pjl.example/a/tok"));
ok("a nameless record still greets politely, not blankly",
  messages.contextForBooking({ ...BOOKING, customerName: "" }).firstName === "there");

// ---- 4. Saving is strict ----------------------------------------------

let threw = false;
try { messages.setTemplate("assignment_sms", { body: "Hi {frstName}, see you {date}" }); }
catch (err) { threw = /frstName/.test(err.message); }
ok("a typo'd merge field is refused at save time, naming the typo", threw);

threw = false;
try { messages.setTemplate("assignment_email", { subject: "Hello", body: "" }); }
catch { threw = true; }
ok("a subject without a body is refused", threw);

threw = false;
try { messages.setTemplate("no_such_key", { body: "x" }); }
catch { threw = true; }
ok("an unknown template key is refused", threw);

// ---- 5. Overrides persist; reset restores -----------------------------

const saved = messages.setTemplate("reminder24_sms",
  { body: "See you tomorrow {date} at {street}! — PJL, {phone}" }, { actor: "patrick" });
ok("a saved template becomes the effective wording",
  saved.source === "custom"
  && messages.render("reminder24_sms", context).body.startsWith("See you tomorrow Monday"));

const STORE = path.join(SANDBOX, "server/data/assignment-templates.json");
ok("the override is written to disk with its author",
  fs.existsSync(STORE) && JSON.parse(fs.readFileSync(STORE, "utf8")).reminder24_sms.actor === "patrick");

// A fresh process (second sandbox with the store planted) reads it back.
const SANDBOX2 = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-messages2-"));
fs.mkdirSync(path.join(SANDBOX2, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX2, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX2, f));
}
fs.mkdirSync(path.join(SANDBOX2, "server/data"), { recursive: true });
fs.cpSync(STORE, path.join(SANDBOX2, "server/data/assignment-templates.json"));
const messages2 = require(path.join(SANDBOX2, "server/lib/assignment-messages.js"));
ok("Patrick's wording survives a restart",
  messages2.templateFor("reminder24_sms").source === "custom"
  && messages2.templateFor("reminder24_sms").body.startsWith("See you tomorrow"));

const resetTo = messages.setTemplate("reminder24_sms", { subject: "", body: "" });
ok("clearing the fields restores the default",
  resetTo.source === "default"
  && resetTo.body === messages.DEFAULT_TEMPLATES.reminder24_sms.body);

// A stored override that references a RETIRED field (saved before a
// rename, like {confirmLink} before the one-link change) must fall back
// to the default at read time — rendering it would put literal braces
// in a customer's message.
{
  fs.writeFileSync(STORE, JSON.stringify({
    assignment_sms: { body: "Old wording with {confirmLink}", updatedAt: "2026-08-31T00:00:00Z", actor: "patrick" }
  }, null, 2));
  const SANDBOX3 = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-messages3-"));
  fs.mkdirSync(path.join(SANDBOX3, "server"), { recursive: true });
  fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX3, "server/lib"), { recursive: true });
  for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
    fs.cpSync(path.join(ROOT, f), path.join(SANDBOX3, f));
  }
  fs.mkdirSync(path.join(SANDBOX3, "server/data"), { recursive: true });
  fs.cpSync(STORE, path.join(SANDBOX3, "server/data/assignment-templates.json"));
  const messages3 = require(path.join(SANDBOX3, "server/lib/assignment-messages.js"));
  const t = messages3.templateFor("assignment_sms");
  ok("an override with a retired field is ignored — the safe default renders instead",
    t.source === "default" && t.staleOverride === true
    && !messages3.render("assignment_sms", messages3.contextForBooking(BOOKING)).body.includes("{confirmLink}"),
    JSON.stringify(t));
}

// ---- 6. This module cannot send ---------------------------------------

const source = fs.readFileSync(path.join(SANDBOX, "server/lib/assignment-messages.js"), "utf8");
ok("the messages module never requires a notify, mailer, or sms module",
  !/require\("\.\/(notify|mailer|sms|outreach)/.test(source));
ok("the messages module never calls sendBulk",
  !source.includes("sendBulk"));

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-assignment-messages: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-assignment-messages: ${pass} assertions passed`);

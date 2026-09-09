// Nothing is ever sent to a load-test record.
//
// Patrick, 2026-09-09: "the gate that you may have set up to not send text
// messages to the customers numbers, and emails are still pushing through
// *** this is for the test appointments."
//
// He was right, and the reason is worth writing down. The suppression that
// existed lived in exactly ONE place — two call sites inside
// POST /api/booking/reserve — and it silenced only the message sent at the
// moment of booking. Everything a test record touched afterwards went out
// normally: reschedules, cancellations, invoices, portal replies, quote
// SMS, review requests, and the assignment blast itself. Nineteen Twilio
// send sites across five files, five separate mail transports, and one
// gate on one of them.
//
// So the rule moves to where the message LEAVES, and it is one rule:
//
//   Does this address or number belong to a record marked PJLTEST-?
//   Then we do not send. Any channel, any sender, any reason.
//
// TWO DELIBERATE CHOICES.
//
// 1. THE MARKER ALONE DECIDES. Not PJL_TEST_KEY. The reserve bypass needs
//    that env var because it is granting an exemption (skip Turnstile, skip
//    the rate limit) and an exemption should be hard to claim. This is the
//    opposite: it is a REFUSAL to send, and a refusal must not depend on a
//    variable someone is about to remove. Spec item 8 has Patrick deleting
//    PJL_TEST_KEY from Render at the end of the load test — if suppression
//    hung off it, that deletion would silently start messaging every test
//    record still in the store, which is precisely the failure this exists
//    to prevent.
//
// 2. IT KEYS OFF THE RECIPIENT, NOT THE CALLER. Senders hold different
//    things — a lead, an invoice, a work order, a booking, a bare phone
//    number from an AI handoff — and no field is common to all of them.
//    What IS common is that every one of them ends at an email address or
//    a phone number. Matching there covers senders that do not exist yet,
//    which a per-caller check cannot.
//
// THE COST, stated plainly: if a test row carries a REAL person's real
// number, that person receives nothing until the test rows are purged.
// That is the safe direction to fail, and it is temporary — the delete bot
// (lib/purge-test-data.js) removes the rows and the block with them.

const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");

const { DEFAULT_MARKER } = require("./purge-test-data");

const LEADS_FILE = path.join(__dirname, "..", "data", "leads.json");

// Re-read at most this often. A send is not a hot path, but a blast is
// thousands of them and leads.json is the biggest file in the store.
const CACHE_TTL_MS = 30 * 1000;

let cache = null;      // { emails: Set, phones: Set, at: number }

// Phone numbers arrive formatted every way a human can type one:
// "(905) 960-0181", "+19059600181", "905-960-0181". Compare the last ten
// digits, which is the North American number without the country code.
function phoneKey(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

function emailKey(value) {
  return String(value || "").trim().toLowerCase();
}

// Every place a lead can carry the marker. The bot types it into the
// booking form's notes field, which lands in contact.notes; the CRM and
// older records have carried it at the top level too.
function leadIsMarked(lead, marker) {
  if (!lead) return false;
  const haystack = [
    lead.contact?.notes,
    lead.notes,
    lead.crm?.notes,
    lead.contact?.name,
    lead.contact?.email
  ].map((v) => String(v || "")).join(" ");
  return haystack.includes(marker);
}

async function loadBlocked({ marker = DEFAULT_MARKER, now = Date.now() } = {}) {
  if (cache && (now - cache.at) < CACHE_TTL_MS) return cache;
  const emails = new Set();
  const phones = new Set();
  try {
    if (fsSync.existsSync(LEADS_FILE)) {
      const raw = await fs.readFile(LEADS_FILE, "utf8");
      const leads = JSON.parse(raw || "[]");
      for (const lead of Array.isArray(leads) ? leads : []) {
        if (!leadIsMarked(lead, marker)) continue;
        const e = emailKey(lead.contact?.email);
        const p = phoneKey(lead.contact?.phone);
        if (e) emails.add(e);
        if (p) phones.add(p);
      }
    }
  } catch (err) {
    // A store we cannot read is not a licence to start messaging test
    // records. Keep whatever we last knew; only an empty first read gives
    // an empty set, and that matches a store with no test data in it.
    console.warn("[test-recipients] could not read leads.json:", err?.message);
    if (cache) return cache;
  }
  cache = { emails, phones, at: now };
  return cache;
}

// The question every sender asks. Either field may be absent.
async function isTestRecipient({ email, phone, notes } = {}) {
  if (notes && String(notes).includes(DEFAULT_MARKER)) return true;
  const e = emailKey(email);
  const p = phoneKey(phone);
  if (!e && !p) return false;
  const blocked = await loadBlocked();
  // Boolean(), not the raw `&&` chain: with only one field supplied the
  // chain yields undefined for "no match", which is falsy and so behaves
  // correctly at every guard — but leaks a non-boolean to anything that
  // compares strictly. Answer the question with an answer.
  return Boolean((e && blocked.emails.has(e)) || (p && blocked.phones.has(p)));
}

// What a sender returns when it refuses. Shaped like every other "we did
// not send" result in notify-customer.js so callers need no new branch,
// and LOUD in the log — a suppression nobody can see is indistinguishable
// from a delivery failure.
function suppressed(channel, to, ref = "") {
  console.log(`[test-recipient] ${channel} SUPPRESSED to=${String(to).slice(0, 40)}`
    + `${ref ? ` ref=${ref}` : ""} — marked ${DEFAULT_MARKER} record, nothing sent.`);
  return { ok: false, skipped: true, reason: "test_record", suppressed: true };
}

// Tests and the purge bot reset this after changing leads.json.
function resetCache() { cache = null; }

// Wrap a nodemailer transport so every message it carries is checked
// before it leaves. Mutates and returns the transport, so it can be
// applied to one already assigned to a variable.
//
// This is the email half of the rule, and it lives HERE rather than in
// each of the five files that build a transport — that is the whole point:
// a guard on the transport covers senders nobody has written yet.
//
// A refused send resolves with a null messageId rather than throwing.
// Callers log `info.messageId` and read a throw as a delivery failure
// worth retrying; this is neither.
function guardTransport(transporter) {
  if (!transporter || transporter.__pjlTestGuarded) return transporter;
  const sendMail = transporter.sendMail.bind(transporter);
  transporter.sendMail = async function guardedSendMail(message, ...rest) {
    const to = Array.isArray(message?.to) ? message.to.join(",") : message?.to;
    for (const one of String(to || "").split(",")) {
      if (await isTestRecipient({ email: one })) {
        suppressed("email", one, message?.subject || "");
        return { messageId: null, suppressed: true, accepted: [], rejected: [to] };
      }
    }
    return sendMail(message, ...rest);
  };
  transporter.__pjlTestGuarded = true;
  return transporter;
}

module.exports = {
  isTestRecipient,
  guardTransport,
  suppressed,
  resetCache,
  phoneKey,
  emailKey,
  MARKER: DEFAULT_MARKER
};

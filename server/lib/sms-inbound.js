// Texts customers send TO the Twilio number — docs/BOOKING_CONFIRMATION_TRD.md §2–3.
//
// Every automated text goes out from the Twilio (647) number. Nobody
// reads that number, but a text invites a reply, and customers replied:
// "YES", "Confirmed", "Can you come Tuesday?" — into silence. Two of them
// phoned Patrick, which is how we found out (2026-09-25).
//
// This module decides what happens to one inbound text. It is pure apart
// from its injected deps so the whole table is testable without Twilio:
//
//   STOP & friends   → Twilio's own opt-out already blocks and replies.
//                      We turn off the property's seasonal texts so the
//                      CRM agrees, and tell Patrick. No reply from us.
//   START / HELP     → Twilio replies to START itself; HELP gets our line.
//   YES & friends    → does NOT confirm (Patrick, 2026-09-26: "the only
//                      way to accept the appointment is to click Confirm
//                      in the link"). The reply says so, with their own
//                      appointment link when exactly one is theirs.
//   anything else    → forwarded to Patrick's cell, and the customer gets
//                      "this is an automated number — call or text
//                      (905) 960-0181" (at most once per 12 h per number).
//
// Patrick's decisions: forwards go to his cell by text; the auto-reply
// says the number is automated and points to 905-960-0181 (2026-09-25);
// a texted YES no longer confirms — only Confirm on the link does
// (2026-09-26).

const path = require("node:path");
const fsp = require("node:fs/promises");
const { writeJsonAtomic } = require("./atomic-json");

const PJL_PHONE = "(905) 960-0181";
const STORE_FILE = path.resolve(__dirname, "..", "data", "sms-inbound.json");
const AUTO_REPLY_EVERY_MS = 12 * 60 * 60 * 1000;
const KEEP_ROWS = 2000;

// Carrier opt-out words. CANCEL is one of them — it must NEVER cancel an
// appointment: to a carrier it means "stop texting me".
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES START"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const YES_WORDS = new Set([
  "YES", "Y", "YEP", "YUP", "YEAH", "YA", "YES PLEASE", "YES THANKS", "YES THANK YOU",
  "CONFIRM", "CONFIRMED", "I CONFIRM", "CONFIRMING",
  "OK", "OKAY", "K", "SOUNDS GOOD", "PERFECT", "GREAT", "YES CONFIRMED", "YES CONFIRM",
  "👍", "✅", "👌"
]);

const AUTO_REPLY = "PJL Land Services: this is an automated texting system and replies here aren't monitored. "
  + `We've passed your message along. To reach us, please call or text ${PJL_PHONE}.`;
// Patrick replying to a forward lands back on this number. Don't forward
// him his own text; tell him where replies actually need to go.
const OWNER_REPLY = "PJL auto line: replies here don't reach the customer. Text them directly from your phone at the number in the forward.";
// A texted YES doesn't confirm (Patrick, 2026-09-26) — say how to.
const CONFIRM_HOWTO_REPLY = "PJL Land Services: thanks! To confirm, please tap the link in our message and press Confirm "
  + `(a text reply doesn't confirm). Questions? Call or text ${PJL_PHONE}.`;
function appointmentLinkOf(booking, deps = {}) {
  const token = booking?.assignment?.outreach?.token;
  if (!token) return "";
  const base = deps.publicBaseUrl || require("./public-base-url").resolvePublicBaseUrl();
  return `${String(base).replace(/\/+$/, "")}/a/${encodeURIComponent(token)}`;
}
const HELP_REPLY = `PJL Land Services automated texts. To reach us, call or text ${PJL_PHONE}. Reply STOP to opt out.`;

// "Yes!!", "yes.", " YES 👍 " → "YES". Emoji-only answers keep their emoji.
function normalizeWords(body) {
  const raw = String(body || "").trim();
  const stripped = raw
    .replace(/[️‍]/g, "")                 // emoji variation selectors / joiners
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")          // skin tones
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped) return stripped;
  return raw.replace(/[️‍]/g, "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
}

function classify(body) {
  const words = normalizeWords(body);
  if (!words) return "other";
  if (STOP_WORDS.has(words)) return "stop";
  if (START_WORDS.has(words)) return "start";
  if (HELP_WORDS.has(words)) return "help";
  if (YES_WORDS.has(words)) return "yes";
  return "other";
}

// The last ten digits: "+1 (905) 555-0100", "905.555.0100" and
// "19055550100" are one number. Anything shorter matches nothing.
function phoneKey(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

// ---- Store ------------------------------------------------------------

async function readStore(file = STORE_FILE) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendRow(row, file = STORE_FILE) {
  const rows = await readStore(file);
  rows.unshift(row);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, rows.slice(0, KEEP_ROWS));
}

// ---- Who is texting ---------------------------------------------------

// Upcoming assignment appointments on this phone number that the
// appointment page would still let the customer confirm. The page's own
// summarize() decides "live" — cancelled, completed and past all fall
// out — so a text can never confirm something the button couldn't.
async function matchSender(from, { listBookings, listProperties, summarize, now = new Date() }) {
  const key = phoneKey(from);
  if (!key) return { key: "", appointments: [], property: null, name: "" };

  const all = await listBookings();
  const appointments = all.filter((b) => {
    if (!b || b.source !== "assignment" || !b.assignment?.outreach?.token) return false;
    if (phoneKey(b.customerPhone) !== key) return false;
    const s = summarize(b, { now });
    return s && (s.state === "open" || s.state === "responded");
  });

  let property = null;
  try {
    const props = await listProperties();
    const withPhone = props.filter((p) => phoneKey(p.customerPhone) === key);
    const wanted = appointments[0]?.propertyId;
    property = (wanted && withPhone.find((p) => p.id === wanted)) || withPhone[0] || null;
  } catch { /* forwarding still works without a name */ }

  const name = String(appointments[0]?.customerName || property?.customerName || "").trim();
  return { key, appointments, property, name };
}

// ---- The alert Patrick reads on his phone -----------------------------

function forwardText({ from, body, name, property, appointment, note }) {
  const who = name ? `${name} (${from})` : from;
  const where = appointment
    ? ` — ${String(appointment.address || "").split(/[\n,]+/)[0].trim()}, appt ${new Date(appointment.scheduledFor)
      .toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })}`
    : (property ? ` — ${String(property.address || "").split(/[\n,]+/)[0].trim()}` : "");
  const text = String(body || "").trim() || "(no text — picture or blank message)";
  return `Text to PJL auto line from ${who}${where}:\n"${text}"${note ? `\n${note}` : ""}\nReply to them from your phone.`;
}

// ---- The decision -----------------------------------------------------

// Returns { reply, cls, action, forward } and performs the side effects
// (confirm, opt-out, forward, log) through deps. Never throws for a bad
// message — a webhook that errors makes Twilio retry.
async function handleInbound({ from, to = "", body = "", messageSid = "", numMedia = 0 }, deps = {}) {
  const now = deps.now || new Date();
  const file = deps.storeFile || STORE_FILE;
  const rows = await readStore(file);

  // Twilio retries on a slow or failed response; one message is one event.
  if (messageSid && rows.some((r) => r.messageSid === messageSid)) {
    return { reply: null, cls: "duplicate", action: "duplicate", forward: null };
  }

  if (deps.ownerPhone && phoneKey(from) && phoneKey(from) === phoneKey(deps.ownerPhone)) {
    try {
      await appendRow({ id: `SMS-${now.getTime().toString(36)}`, messageSid, from, to, body: String(body || "").slice(0, 1600),
        receivedAt: now.toISOString(), cls: "owner", action: "from_owner", autoReplied: true, forwarded: false }, file);
    } catch { /* logging only */ }
    return { reply: OWNER_REPLY, cls: "owner", action: "from_owner", forward: null };
  }

  const cls = classify(body);
  const who = await matchSender(from, deps);
  const row = {
    id: `SMS-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    messageSid, from, to,
    body: String(body || "").slice(0, 1600),
    numMedia: Number(numMedia) || 0,
    receivedAt: now.toISOString(),
    cls,
    name: who.name || "",
    propertyId: who.property?.id || null,
    matchedBookingIds: who.appointments.map((b) => b.id),
    action: "",
    autoReplied: false,
    forwarded: false
  };

  let reply = null;
  let forward = null;

  if (cls === "stop") {
    // Twilio has already blocked the number and sent the carrier reply.
    if (who.property && deps.updateProperty) {
      try {
        await deps.updateProperty(who.property.id, { commPrefs: { seasonalRemindersSMS: false } });
        row.action = "sms_opted_out";
      } catch (err) { row.action = `opt_out_failed: ${err?.message || err}`; }
    } else {
      row.action = "stop_unmatched";
    }
    forward = forwardText({ ...who, from, body, note: "They texted STOP — Twilio has stopped all texts to this number." });
  } else if (cls === "start") {
    // Twilio re-subscribes the number and replies itself. Seasonal
    // consent in the CRM stays as it was — turning it back on is
    // Patrick's call, not a keyword's.
    row.action = "start";
    forward = forwardText({ ...who, from, body, note: "They texted START (re-subscribed with Twilio). Their CRM text preference was NOT changed." });
  } else if (cls === "help") {
    reply = HELP_REPLY;
    row.action = "help";
  } else if (cls === "yes") {
    // Patrick, 2026-09-26: "the only way to accept the appointment is to
    // click Confirm in the link." A texted YES no longer confirms — it
    // gets a reply that says exactly how, with their own link when we
    // can tell which appointment is theirs. Not forwarded: there's
    // nothing for Patrick to answer.
    const appt = who.appointments.length === 1 ? who.appointments[0] : null;
    const link = appt ? appointmentLinkOf(appt, deps) : "";
    reply = link
      ? `PJL Land Services: thanks! To confirm, please tap this link and press Confirm: ${link} `
        + `(a text reply doesn't confirm). Questions? Call or text ${PJL_PHONE}.`
      : CONFIRM_HOWTO_REPLY;
    row.action = appt ? "told_to_use_link" : "told_to_use_link_unmatched";
  } else {
    forward = forwardText({ ...who, appointment: who.appointments[0], from, body });
    row.action = "forwarded";
  }

  // The "automated number" reply, for anything we didn't answer properly.
  // Once per 12 hours per number: two auto-responders must not ping-pong,
  // and a customer mid-conversation doesn't need it five times.
  if (!reply && cls === "other") {
    const recent = rows.find((r) => r.from && phoneKey(r.from) === who.key && r.autoReplied
      && now.getTime() - new Date(r.receivedAt).getTime() < AUTO_REPLY_EVERY_MS);
    if (!recent) {
      reply = AUTO_REPLY;
      row.autoReplied = true;
    }
  }

  if (forward && deps.sendAlert) {
    try {
      const r = await deps.sendAlert(forward);
      row.forwarded = Boolean(r?.ok);
    } catch (err) {
      console.warn("[sms-inbound] forward to Patrick failed:", err?.message || err);
    }
  }

  try { await appendRow(row, file); } catch (err) {
    console.warn("[sms-inbound] couldn't log the inbound text:", err?.message || err);
  }
  return { reply, cls, action: row.action, forward };
}

module.exports = {
  PJL_PHONE,
  AUTO_REPLY,
  HELP_REPLY,
  OWNER_REPLY,
  CONFIRM_HOWTO_REPLY,
  STORE_FILE,
  classify,
  phoneKey,
  matchSender,
  forwardText,
  handleInbound,
  readStore
};

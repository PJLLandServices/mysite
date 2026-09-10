// The cadence engine — stage 4 of docs/ASSIGNMENT_WRITER.md.
//
// THE ONLY PLACE AN ASSIGNMENT MESSAGE MAY LEAVE THE BUILDING. The
// blast (step 1) fires when Patrick presses the button; steps 2–6 fire
// from the sweep, on their day, inside the send window. The templates
// come from assignment-messages (Patrick's wording), the channel
// senders from notify-customer (the same Gmail/Twilio paths marketing
// outreach uses), and every successful send records a touch WITH
// type: "assignment" — the field this stage added so these sends can
// never be mistaken for marketing.
//
// THE CADENCE, from Part 2 of the spec (D = appointment date, B = blast):
//
//   1  B      assignment   email+SMS   everyone assigned
//   2  D−15   follow-up    email+SMS   non-responders
//   3  D−10   the nudge    email+SMS   non-responders
//   4  D−7    the nudge    email+SMS   non-responders
//   5  D−5    the nudge    email+SMS   non-responders
//   6  D−1    reminder     SMS         EVERYONE with a live booking
//
// THE RULES (Part 2's nine, implemented literally):
//   1. A step fires at most once, ever. The fired-steps record lives on
//      booking.assignment.outreach.steps and is WRITTEN BEFORE the
//      dispatch — a crash between mark and send costs one message
//      (visible, retryable by hand); the other order double-fires,
//      which the spec calls the worst bug this system can have.
//   2. A step whose date has passed when the sweep looks is SKIPPED,
//      not backfilled: a step fires only on its own day.
//   3. A response stops steps 2–5. Nothing stops step 6.
//   4. A reschedule re-anchors automatically: due dates derive from the
//      booking's CURRENT scheduledFor on every sweep.
//   5. A cancellation stops everything — only status "confirmed" is
//      swept.
//   6. Day-move response reset is stage 6's job.
//   7. Send window 09:00–18:00 America/Toronto (server TZ), checked on
//      every dispatch including the blast.
//   8. Opt-outs are honoured at EVERY step through the same channel
//      capability + season opt-out checks sendBulk applies.
//   9. The sweep is a setInterval in server.js like the other six.
//
// THE LINK INTERLOCK. Every message carries the customer's real
// appointment link (minted here, one token per booking). Until the
// appointment page exists (stage 5), sending would text customers a
// dead URL — so blast and sweep both require the caller to assert
// `appointmentPageReady`, and any rendered message still containing a
// bracketed [placeholder] refuses to send. Stage 5 flips the flag in
// server.js.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-json");
const bookings = require("./bookings");
const properties = require("./properties");
const outreach = require("./outreach");
const notify = require("./notify-customer");
const assignmentMessages = require("./assignment-messages");
const { resolveSeasonalPrice } = require("./pricing");
const { resolvePublicBaseUrl } = require("./public-base-url");

const STEPS = Object.freeze([
  { n: 1, template: "assignment", channels: ["email", "sms"], blast: true, stopsOnResponse: false },
  { n: 2, template: "followup", channels: ["email", "sms"], daysBefore: 15, stopsOnResponse: true },
  { n: 3, template: "nudge", channels: ["email", "sms"], daysBefore: 10, stopsOnResponse: true },
  { n: 4, template: "nudge", channels: ["email", "sms"], daysBefore: 7, stopsOnResponse: true },
  { n: 5, template: "nudge", channels: ["email", "sms"], daysBefore: 5, stopsOnResponse: true },
  { n: 6, template: "reminder24", channels: ["sms"], daysBefore: 1, stopsOnResponse: false }
]);

// Sends go out inside business-ish hours only, Toronto time (server.js
// pins process.env.TZ on boot, so getHours() here is honest). This is a
// courtesy rule about when a customer's phone lights up, and it governs
// BOTH the blast and the automated steps 2–6.
//
// 18:00 → 20:00 on 2026-09-10, at Patrick's call. He pressed the blast
// before 9am, was refused, and by the time we worked out why it was past
// six — the rule had cost a whole day of the assignment cadence for no
// customer-facing reason. 8pm is a normal hour to reach a homeowner and
// sits well inside Canadian contact-time norms.
const SEND_WINDOW = Object.freeze({ fromHour: 9, toHour: 20 });   // 09:00–20:00 Toronto

let sendInProgress = false;

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function insideSendWindow(now) {
  const h = now.getHours();
  return h >= SEND_WINDOW.fromHour && h < SEND_WINDOW.toHour;
}

// When the window next opens, as a sentence. The button says this instead
// of letting Patrick arm a send that the server is going to refuse.
function sendWindowNote(now = new Date()) {
  if (insideSendWindow(now)) return null;
  const h = now.getHours();
  const opensToday = h < SEND_WINDOW.fromHour;
  const hh = (n) => `${((n + 11) % 12) + 1}${n < 12 ? " AM" : " PM"}`;
  return opensToday
    ? `Sending opens at ${hh(SEND_WINDOW.fromHour)} today.`
    : `Sending closed at ${hh(SEND_WINDOW.toHour)} — it opens again at ${hh(SEND_WINDOW.fromHour)} tomorrow.`;
}

// ---- The blast ledger ------------------------------------------------
//
// WHY THIS EXISTS. On 2026-09-10 Patrick pressed the blast before 9am,
// the server refused it on the window, and the refusal was written to a
// panel that the next page load erased. Hours later the only honest
// answer to "did anything send?" came from reading his Gmail sent folder.
// The most consequential button in the system left no trace — not of the
// refusal, not of who was skipped and why, not even of having been
// pressed. Every attempt is recorded here now, sent or refused.
const BLAST_LOG = path.join(__dirname, "..", "data", "assignment-blasts.json");

async function readBlastLog() {
  try {
    if (!fsSync.existsSync(BLAST_LOG)) return {};
    const parsed = JSON.parse((await fs.readFile(BLAST_LOG, "utf8")) || "{}");
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

// Never throws: a ledger write that fails must not fail the send it is
// describing, and a send that happened is more important than the note
// about it.
async function recordBlastAttempt(season, year, entry) {
  try {
    const log = await readBlastLog();
    const key = `${season}-${Number(year)}`;
    const history = Array.isArray(log[key]?.history) ? log[key].history : [];
    const row = { at: new Date().toISOString(), ...entry };
    log[key] = { last: row, history: [row, ...history].slice(0, 20) };
    await fs.mkdir(path.dirname(BLAST_LOG), { recursive: true });
    await writeJsonAtomic(BLAST_LOG, log);
  } catch (err) {
    console.warn("[cadence] blast ledger write failed:", err?.message);
  }
}

async function lastBlastFor(season, year) {
  const log = await readBlastLog();
  return log[`${season}-${Number(year)}`]?.last || null;
}

// The date a step is due for a booking: D − daysBefore, as a local
// calendar day. Derived from the CURRENT scheduledFor so a reschedule
// re-anchors with no bookkeeping (rule 4).
function dueDateKeyFor(booking, step) {
  const d = new Date(booking.scheduledFor);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - step.daysBefore);
  return localDateKey(d);
}

function appointmentLinkFor(token) {
  return `${resolvePublicBaseUrl()}/a/${encodeURIComponent(token)}`;
}

function mintToken() {
  return crypto.randomBytes(18).toString("base64url");
}

// Rule 8 — the same gates sendBulk applies, minus already_booked (an
// assignment booking IS the booking, so the full assessEligibility
// gauntlet would refuse everyone it exists for). Season opt-out and
// per-channel consent are re-checked on every step: an opt-out placed
// after the blast stops every later message.
function cadenceGates(property, season, year) {
  if (!property) return { ok: false, reason: "not_found" };
  if (property.deletedAt || property.archivedAt) return { ok: false, reason: "inactive" };
  const key = properties.seasonKey(year, season);
  if (property.seasonalOutreach?.[key]?.optOutThisSeason === true) {
    return { ok: false, reason: "season_opt_out" };
  }
  // Decision I — a "no need to contact" property (Patrick's phrase: a
  // management company he coordinates with directly). Booked like
  // everyone else, messaged NEVER: this gate sits in front of the
  // blast, steps 2–6, and the day-move notice alike, because every
  // send routes through cadenceGates.
  if (property.commPrefs?.noContactNeeded === true) {
    return { ok: false, reason: "no_contact_needed" };
  }
  return { ok: true, capability: outreach.channelCapability(property) };
}

// Render one step's messages for a booking, with the REAL link. Refuses
// to hand back anything still carrying a bracketed placeholder — the
// stage-3 rule this engine is bound by.
function renderStep(booking, step, token, extra = {}) {
  const context = assignmentMessages.contextForBooking(booking, {
    appointmentLink: appointmentLinkFor(token),
    ...extra
  });
  const out = {};
  for (const channel of step.channels) {
    const key = `${step.template}_${channel}`;
    if (!assignmentMessages.TEMPLATE_KEYS[key]) continue;
    const rendered = assignmentMessages.render(key, context);
    const flat = `${rendered.subject || ""}\n${rendered.body}`;
    if (/\[[a-z-]*link\]/i.test(flat)) {
      throw new Error(`${key} still contains a bracketed link placeholder — refusing to send.`);
    }
    out[channel] = rendered;
  }
  return out;
}

// Dispatch one step for one booking. The step is marked fired BEFORE
// the sends go out (rule 1); the results are written after. Returns the
// per-channel outcome. `deps` lets tests capture sends without a wire.
async function sendStepForBooking(booking, step, { season, year, deps = {}, by = "cadence" }) {
  const getProperty = deps.getProperty || properties.get;
  const sendEmail = deps.sendEmail || notify.sendOutreachEmail;
  const sendSms = deps.sendSms || notify.sendOutreachSms;
  const recordTouch = deps.recordTouch || properties.recordOutreachTouch;
  const setOutreach = deps.setAssignmentOutreach || bookings.setAssignmentOutreach;

  const property = booking.propertyId ? await getProperty(booking.propertyId) : null;
  const gate = cadenceGates(property, season, year);
  if (!gate.ok) return { skipped: true, reason: gate.reason };

  const token = booking.assignment.outreach?.token || mintToken();
  // The customer's own price rides into the message: their profile
  // override when one is set, the tier price otherwise.
  let priceExtra = {};
  try {
    const family = season === "spring" ? "spring_opening" : "fall_closing";
    const resolved = resolveSeasonalPrice(property, family);
    if (resolved?.label) priceExtra = { price: resolved.label };
  } catch { /* contextForBooking's tier fallback stands */ }
  const messages = renderStep(booking, step, token, priceExtra);
  const capability = gate.capability;

  const wants = {
    email: step.channels.includes("email") && Boolean(messages.email),
    sms: step.channels.includes("sms") && Boolean(messages.sms)
  };
  // Step 6 is SMS by spec; a customer with no usable SMS gets the email
  // instead — a reminder they can't receive helps nobody, and decision C
  // already promised both channels everywhere else. Recorded as a
  // stage-4 decision in the build log.
  if (step.n === 6 && wants.sms && !capability.sms.possible && capability.emailChannel.possible) {
    const context = assignmentMessages.contextForBooking(booking, {
      appointmentLink: appointmentLinkFor(token)
    });
    messages.email = {
      subject: `Reminder: your appointment is tomorrow — ${context.date}`,
      body: assignmentMessages.render("reminder24_sms", context).body
    };
    wants.email = true;
  }

  const attempted = [];
  if (wants.email && capability.emailChannel.possible) attempted.push("email");
  if (wants.sms && capability.sms.possible) attempted.push("sms");
  if (!attempted.length) {
    return { skipped: true, reason: "no_deliverable_channel" };
  }

  // RULE 1: mark first. A crash after this line loses at most one
  // message and never repeats one.
  await setOutreach(booking.id, {
    token,
    steps: { [String(step.n)]: { at: new Date().toISOString(), attempted } }
  }, { action: `cadence_step_${step.n}`, by, note: attempted.join("+") });

  const unsubscribe = property.optOutTokens
    ? outreach.buildUnsubscribeUrls(property)
    : { email: "", all: "" };

  const sent = [];
  const errors = [];
  if (attempted.includes("email")) {
    const r = await sendEmail({
      to: capability.email,
      firstName: assignmentMessages.contextForBooking(booking).firstName,
      propertyAddress: "",
      seasonName: "",
      portalLink: appointmentLinkFor(token),
      ctaLabel: "Open your appointment page",
      subject: messages.email.subject,
      emailBody: messages.email.body,
      unsubscribeUrlEmail: unsubscribe.email,
      unsubscribeUrlAll: unsubscribe.all
    });
    if (r.ok) sent.push("email");
    else errors.push({ channel: "email", error: r.error || r.reason || "failed" });
  }
  if (attempted.includes("sms")) {
    const r = await sendSms({
      to: capability.phone,
      firstName: assignmentMessages.contextForBooking(booking).firstName,
      propertyAddress: "",
      seasonName: "",
      portalLink: "",
      smsBody: messages.sms.body
    });
    if (r.ok) sent.push("sms");
    else errors.push({ channel: "sms", error: r.error || r.reason || "failed" });
  }

  await setOutreach(booking.id, {
    steps: { [String(step.n)]: {
      at: new Date().toISOString(), attempted, sent,
      ...(errors.length ? { errors } : {})
    } }
  }, { action: `cadence_step_${step.n}_result`, by, note: `sent ${sent.join("+") || "nothing"}` });

  if (sent.length) {
    await recordTouch(property.id, {
      season, year, channels: sent, by,
      messageBatchId: booking.assignment.outreach?.batchId || booking.assignment.batchId || null,
      type: "assignment", step: step.n
    });
  }
  return { sent, errors };
}

// The day-move notice (stage 6, cadence rule 6). Fires ONCE per queued
// move, inside the send window, naming the change ("was X, now Y").
// Same mark-before-send discipline as the numbered steps: the pending
// flag is consumed BEFORE the wire is touched, so a crash loses at most
// one notice and can never repeat one.
async function sendDayMoveForBooking(booking, { season, year, deps = {}, by = "cadence-sweep" }) {
  const getProperty = deps.getProperty || properties.get;
  const sendEmail = deps.sendEmail || notify.sendOutreachEmail;
  const sendSms = deps.sendSms || notify.sendOutreachSms;
  const recordTouch = deps.recordTouch || properties.recordOutreachTouch;
  const setOutreach = deps.setAssignmentOutreach || bookings.setAssignmentOutreach;

  const pending = booking.assignment.outreach?.pendingDayMove;
  if (!pending) return { skipped: true, reason: "nothing_pending" };

  const property = booking.propertyId ? await getProperty(booking.propertyId) : null;
  const gate = cadenceGates(property, season, year);
  if (!gate.ok) {
    // An opted-out (or vanished) customer can't be told — clear the
    // flag so the sweep doesn't retry forever, and leave the skip on
    // the record for the panel to show.
    await setOutreach(booking.id, { pendingDayMove: null, dayMoveNotice: { ...pending, skipped: gate.reason, at: new Date().toISOString() } },
      { action: "day_move_notice_skipped", by, note: gate.reason });
    return { skipped: true, reason: gate.reason };
  }

  const token = booking.assignment.outreach?.token || mintToken();
  const [y, m, d] = String(pending.oldDate).split("-").map(Number);
  const oldDateLabel = new Date(y, m - 1, d).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
  let priceExtra = {};
  try {
    const resolved = resolveSeasonalPrice(property, season === "spring" ? "spring_opening" : "fall_closing");
    if (resolved?.label) priceExtra = { price: resolved.label };
  } catch { /* tier fallback stands */ }
  const step = { n: "daymove", template: "daymove", channels: ["email", "sms"] };
  const messages = renderStep(booking, step, token, { oldDate: oldDateLabel, ...priceExtra });

  const capability = gate.capability;
  const attempted = [];
  if (messages.email && capability.emailChannel.possible) attempted.push("email");
  if (messages.sms && capability.sms.possible) attempted.push("sms");
  if (!attempted.length) {
    await setOutreach(booking.id, { pendingDayMove: null, dayMoveNotice: { ...pending, skipped: "no_deliverable_channel", at: new Date().toISOString() } },
      { action: "day_move_notice_skipped", by, note: "no_deliverable_channel" });
    return { skipped: true, reason: "no_deliverable_channel" };
  }

  // Mark first — consume the pending flag before any send.
  await setOutreach(booking.id, {
    token,
    pendingDayMove: null,
    dayMoveNotice: { ...pending, at: new Date().toISOString(), attempted }
  }, { action: "day_move_notice", by, note: `${pending.oldDate} → ${pending.newDate}, ${attempted.join("+")}` });

  const unsubscribe = property.optOutTokens ? outreach.buildUnsubscribeUrls(property) : { email: "", all: "" };
  const sent = [];
  const errors = [];
  if (attempted.includes("email")) {
    const r = await sendEmail({
      to: capability.email,
      firstName: assignmentMessages.contextForBooking(booking).firstName,
      propertyAddress: "", seasonName: "",
      portalLink: appointmentLinkFor(token),
      ctaLabel: "Open your appointment page",
      subject: messages.email.subject,
      emailBody: messages.email.body,
      unsubscribeUrlEmail: unsubscribe.email,
      unsubscribeUrlAll: unsubscribe.all
    });
    if (r.ok) sent.push("email");
    else errors.push({ channel: "email", error: r.error || r.reason || "failed" });
  }
  if (attempted.includes("sms")) {
    const r = await sendSms({
      to: capability.phone,
      firstName: assignmentMessages.contextForBooking(booking).firstName,
      propertyAddress: "", seasonName: "", portalLink: "",
      smsBody: messages.sms.body
    });
    if (r.ok) sent.push("sms");
    else errors.push({ channel: "sms", error: r.error || r.reason || "failed" });
  }
  await setOutreach(booking.id, {
    dayMoveNotice: { ...pending, at: new Date().toISOString(), attempted, sent, ...(errors.length ? { errors } : {}) }
  }, { action: "day_move_notice_result", by, note: `sent ${sent.join("+") || "nothing"}` });
  if (sent.length) {
    await recordTouch(property.id, {
      season, year, channels: sent, by,
      messageBatchId: booking.assignment.batchId || null,
      type: "assignment", step: 0
    });
  }
  return { sent, errors };
}

// Live, sendable assignment bookings for a season.
async function cadenceBookings(season, year, listBookings) {
  return (await listBookings()).filter((b) =>
    b && b.source === "assignment" && b.assignment
    && b.assignment.season === season && Number(b.assignment.year) === Number(year)
    && b.status === "confirmed");
}

// ---- Step 1: the blast -------------------------------------------------
//
// Patrick presses the button once, at season start (decision E). Every
// live assignment booking whose step 1 has never fired gets the
// assignment message. Running it again sends only to bookings assigned
// since — step 1 obeys rule 1 like every other step.
async function blast(season, year, { deps = {}, by = "patrick", now = new Date(), appointmentPageReady = false } = {}) {
  const listBookings = deps.listBookings || bookings.list;

  // A refusal is an OUTCOME, not a non-event: it is recorded before it is
  // thrown, so "I pressed it and nothing happened" is answerable later.
  const refuse = async (message, code) => {
    await recordBlastAttempt(season, year, { by, outcome: "refused", reason: message });
    const err = new Error(message);
    if (code) err.code = code;
    throw err;
  };

  if (!appointmentPageReady) {
    await refuse("The appointment page isn't live yet — the links in these messages would lead nowhere. (Stage 5 flips this switch.)");
  }
  if (!insideSendWindow(now)) {
    const hh = (n) => `${((n + 11) % 12) + 1}${n < 12 ? " AM" : " PM"}`;
    await refuse(`Sends go out ${hh(SEND_WINDOW.fromHour)} – ${hh(SEND_WINDOW.toHour)} Toronto time`
      + ` — it's ${now.toLocaleTimeString("en-CA")} now.`);
  }
  if (sendInProgress) {
    await refuse("Another assignment send is already running.", "SEND_LOCKED");
  }
  sendInProgress = true;
  try {
    const step = STEPS[0];
    const mine = await cadenceBookings(season, year, listBookings);
    const result = { blasted: 0, alreadyBlasted: 0, skipped: [], errors: [] };
    for (const b of mine) {
      if (b.assignment.outreach?.steps?.["1"]) { result.alreadyBlasted += 1; continue; }
      const outcome = await sendStepForBooking(b, step, { season, year, deps, by });
      if (outcome.skipped) result.skipped.push({ bookingId: b.id, code: b.assignment.code, reason: outcome.reason });
      else if (outcome.sent.length) result.blasted += 1;
      else result.errors.push({ bookingId: b.id, code: b.assignment.code, errors: outcome.errors });
    }
    await recordBlastAttempt(season, year, {
      by,
      outcome: "sent",
      blasted: result.blasted,
      alreadyBlasted: result.alreadyBlasted,
      considered: mine.length,
      skipped: result.skipped,
      errors: result.errors
    });
    return { ok: true, ...result };
  } finally {
    sendInProgress = false;
  }
}

// ---- Steps 2–6: the sweep ----------------------------------------------
//
// Runs every few minutes from server.js. A step dispatches the first
// time the sweep runs inside the window ON ITS DAY (rules 2 and 7);
// yesterday's missed step stays missed.
async function sweepDue(season, year, { deps = {}, now = new Date(), appointmentPageReady = false } = {}) {
  const listBookings = deps.listBookings || bookings.list;
  if (!appointmentPageReady) return { ok: true, sent: 0, waiting: "appointment_page" };
  if (!insideSendWindow(now)) return { ok: true, sent: 0, waiting: "send_window" };
  if (sendInProgress) return { ok: true, sent: 0, waiting: "send_lock" };

  sendInProgress = true;
  try {
    const todayKey = localDateKey(now);
    const mine = await cadenceBookings(season, year, listBookings);
    const result = { ok: true, sent: 0, skipped: 0, errors: 0 };
    for (const b of mine) {
      const outreachState = b.assignment.outreach;
      if (!outreachState?.steps?.["1"]) continue;   // never blasted — the cadence hasn't started
      // Queued day-move notices go out first — "your day changed" beats
      // any reminder about the day.
      if (outreachState.pendingDayMove) {
        const outcome = await sendDayMoveForBooking(b, { season, year, deps });
        if (outcome.skipped) result.skipped += 1;
        else if (outcome.sent && outcome.sent.length) result.sent += 1;
        else result.errors += 1;
      }
      for (const step of STEPS) {
        if (step.blast) continue;
        if (outreachState.steps[String(step.n)]) continue;               // rule 1
        if (step.stopsOnResponse && outreachState.respondedAt) continue; // rule 3
        if (dueDateKeyFor(b, step) !== todayKey) continue;               // rules 2 + 4
        const outcome = await sendStepForBooking(b, step, { season, year, deps, by: "cadence-sweep" });
        if (outcome.skipped) result.skipped += 1;
        else if (outcome.sent && outcome.sent.length) result.sent += 1;
        else result.errors += 1;
      }
    }
    return result;
  } finally {
    sendInProgress = false;
  }
}

// ---- Status — what the panel shows ------------------------------------
async function status(season, year, { deps = {} } = {}) {
  const listBookings = deps.listBookings || bookings.list;
  const mine = await cadenceBookings(season, year, listBookings);
  const summary = {
    bookings: mine.length,
    blasted: 0,
    // Opened their appointment link at least once. Sits between
    // "messaged" and "responded" — the gap where a hesitant customer
    // used to look identical to a wrong phone number.
    seen: 0,
    responded: 0,
    steps: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  };
  for (const b of mine) {
    const o = b.assignment.outreach || {};
    if (o.steps?.["1"]) summary.blasted += 1;
    if (o.seenAt) summary.seen += 1;
    if (o.respondedAt) summary.responded += 1;
    for (const n of Object.keys(o.steps || {})) {
      if (summary.steps[n] != null) summary.steps[n] += 1;
    }
  }
  const now = new Date();
  return {
    ok: true,
    season,
    year: Number(year),
    summary,
    // What the button needs to say "not now, and here's why" BEFORE it is
    // armed, rather than after two presses and a round trip.
    canSendNow: insideSendWindow(now),
    sendWindow: { fromHour: SEND_WINDOW.fromHour, toHour: SEND_WINDOW.toHour },
    sendWindowNote: sendWindowNote(now),
    lastBlast: await lastBlastFor(season, year)
  };
}

module.exports = {
  STEPS,
  SEND_WINDOW,
  blast,
  sweepDue,
  status,
  sendStepForBooking,
  sendDayMoveForBooking,
  renderStep,
  dueDateKeyFor,
  insideSendWindow,
  sendWindowNote,
  lastBlastFor,
  appointmentLinkFor,
  cadenceGates
};

#!/usr/bin/env node
// scripts/test-time-notice.mjs
//
// Patrick, 2026-10-08, holding the email Jaswinder received after he moved
// her ONE stop from Oct 9 to Oct 17 with "Move to…":
//   "Weather and routing sometimes move one of our whole service days,
//    and yours has moved … Now: Saturday, October 17 — Morning (8 AM – 12 PM)"
// "this was the email they received though..." — and then: "I changed it
// to 'after 7:00' but that never got announced … I have selected a
// specific time for this customer, which could happen again. Can we make
// this a thing?"
//
// Three gaps, one workflow (CLAUDE.md: finish the workflow, not the write):
//   1. A single-stop move reused the whole-day notice. Now moves carry a
//      kind, and a stop move gets its own wording (stopmove_*).
//   2. A time window on a stop only steered the route; the customer was
//      never told, and every message still printed the bare half-day.
//      Now saving a window queues a time notice (timeset_*), and EVERY
//      message renders {bucket} through one rule — promisedWindow() —
//      so the time that was set is the time that is stated.
//   3. A window was left behind on the old day when its stop moved. It
//      now travels with the stop.
//
// Sections 2, 3, 4, 5 and 7 fail on the code before the fix.
//
// Run: node scripts/test-time-notice.mjs   (also in build:check)

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
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
};
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };

// Sandbox: real modules, real stores, a throwaway data dir. Only the wire
// (email/SMS) is injected and captured.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-timenotice-"));
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));

const prop = (id) => ({
  id, code: id, customerName: `Customer ${id}`, customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`, address: `${id} French Dr, Orangeville, ON`, town: "Orangeville"
});
const PROPS = ["P-JAS", "P-DAY", "P-CHAIN", "P-FOLLOW", "P-TIME", "P-NEW", "P-FLEX", "P-OWN", "P-BOTH", "P-STEP"].map(prop);
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify(PROPS, null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const cadence = require(path.join(SANDBOX, "server/lib/assignment-cadence.js"));
const messages = require(path.join(SANDBOX, "server/lib/assignment-messages.js"));
const assignments = require(path.join(SANDBOX, "server/lib/assignments.js"));
const plans = require(path.join(SANDBOX, "server/lib/season-plans.js"));
// Missing entirely is a failure to REPORT, not a crash that hides the rest.
for (const n of ["windowLabelOf", "timeLabelOf", "promisedWindow"]) {
  if (typeof messages[n] !== "function") messages[n] = () => `(${n} is missing)`;
}
if (typeof assignments.queueTimeNotice !== "function") assignments.queueTimeNotice = async () => ({ queued: false, reason: "(queueTimeNotice is missing)" });

const wire = { emails: [], smses: [] };
const clearWire = () => { wire.emails.length = 0; wire.smses.length = 0; };
const ALL_STEPS = Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((n) => [n, { at: "2026-09-11T13:00:00Z", attempted: ["email", "sms"], sent: ["email", "sms"] }]));

// The plan the cadence reads windows from. Mutated per section.
let PLAN = { days: {} };
const deps = {
  getPlan: async () => PLAN,
  sendEmail: async (a) => { wire.emails.push(a); return { ok: true }; },
  sendSms: async (a) => { wire.smses.push(a); return { ok: true }; }
};
const now = (day, h = 11) => new Date(2026, 9, day, h, 0);   // October 2026, inside the send window
const sweep = (day) => cadence.sweepDue("fall", 2026, { deps, now: now(day), appointmentPageReady: true });

async function mk(pid, { date = "2026-10-17", bucket = "morning", h = 8, m = 51, messaged = true, flex = false, requestedWindow = null } = {}) {
  const [y, mo, d] = date.split("-").map(Number);
  const b = await bookings.createDirect({
    propertyId: pid, customerName: `Jaswinder ${pid}`, customerPhone: "+19055550100",
    customerEmail: `${pid.toLowerCase()}@example.com`, address: `61 French Dr, Orangeville, ON L9W 2Z2`,
    serviceKey: "fall_close_4z", serviceLabel: "Fall winterization (1-4 zones residential)",
    scheduledFor: new Date(y, mo - 1, d, h, m).toISOString(), durationMinutes: 30,
    status: "confirmed", source: "assignment",
    assignment: { season: "fall", year: 2026, batchId: "AS-t", assignedAt: "x", date, bucket, code: pid }
  });
  if (messaged) await bookings.setAssignmentOutreach(b.id, { token: `tok${pid}`, steps: ALL_STEPS });
  if (flex) await bookings.setFreeBucket(b.id, { by: "customer" });
  if (requestedWindow) {
    const all = JSON.parse(fs.readFileSync(path.join(SANDBOX, "server/data/bookings.json"), "utf8"));
    const rec = all.find((x) => x.id === b.id); rec.requestedWindow = requestedWindow;
    fs.writeFileSync(path.join(SANDBOX, "server/data/bookings.json"), JSON.stringify(all, null, 2));
  }
  return bookings.get(b.id);
}
const fresh = (id) => bookings.get(id);

// ---- 1. The one rule: what time is the customer promised? ---------------
{
  ok("1a. no window → the half-day, as before", messages.windowLabelOf("morning", null) === "Morning (8 AM – 12 PM)", messages.windowLabelOf("morning", null));
  ok("1b. after only → 'Morning, after 7:00 AM'", messages.windowLabelOf("morning", { notBefore: "07:00" }) === "Morning, after 7:00 AM");
  ok("1c. before only → 'Afternoon, before 3:30 PM'", messages.windowLabelOf("afternoon", { notAfter: "15:30" }) === "Afternoon, before 3:30 PM");
  ok("1d. both → 'between 9:00 AM and 9:30 AM' (an exact time is a narrow window)",
    messages.windowLabelOf("morning", { notBefore: "09:00", notAfter: "09:30" }) === "between 9:00 AM and 9:30 AM");
  ok("1e. noon reads 12:00 PM", messages.timeLabelOf("12:00") === "12:00 PM" && messages.timeLabelOf("00:30") === "12:30 AM");
  ok("1f. the customer's own window wins over the plan's (the sequencer's precedence)",
    JSON.stringify(messages.promisedWindow({ requestedWindow: { notBefore: "11:00" } }, { notBefore: "07:00" })) === JSON.stringify({ notBefore: "11:00", notAfter: null }));
  ok("1g. the plan window when the customer set none",
    JSON.stringify(messages.promisedWindow({}, { notAfter: "10:00" })) === JSON.stringify({ notBefore: null, notAfter: "10:00" }));
  const ctx = messages.contextForBooking({ customerName: "A B", assignment: { bucket: "morning" }, scheduledFor: new Date(2026, 9, 17, 8, 51).toISOString() },
    { planWindow: { notBefore: "07:00" }, appointmentLink: "x" });
  ok("1h. {bucket} renders the window; planWindow is not itself a merge field", ctx.bucket === "Morning, after 7:00 AM" && !("planWindow" in ctx), JSON.stringify(ctx));
}

// ---- 2. Jaswinder's exact case: ONE stop moved, then a time set ---------
{
  const jas = await mk("P-JAS", { date: "2026-10-09", bucket: "afternoon", h: 13, m: 5 });
  await bookings.moveAssignmentDay(jas.id, {
    toDate: "2026-10-17", toBucket: "morning", scheduledFor: new Date(2026, 9, 17, 8, 51).toISOString(),
    oldDate: "2026-10-09", queueNotice: true, kind: "stop", by: "patrick"
  });
  ok("2a. a stop move queues a STOP notice", (await fresh(jas.id)).assignment.outreach.pendingDayMove?.kind === "stop",
    JSON.stringify((await fresh(jas.id)).assignment.outreach.pendingDayMove));
  PLAN = { days: { "2026-10-17": { morning: ["P-JAS"], afternoon: [], constraints: { "P-JAS": { notBefore: "07:00" } } } } };
  clearWire();
  await sweep(8);
  const email = wire.emails.find((e) => e.refId === jas.id);
  const sms = wire.smses.find((s) => /P-JAS|French/.test(s.smsBody));
  ok("2b. the email no longer blames 'weather and routing' moving a whole day",
    email && !/whole service days/i.test(email.emailBody) && /moved your appointment/i.test(email.emailBody), email && email.emailBody);
  ok("2c. …it names the change: was Oct 9, now Oct 17",
    email && /Was: Friday, October 9/.test(email.emailBody) && /Now: Saturday, October 17/.test(email.emailBody));
  ok("2d. …and states the time Patrick set, not the bare half-day",
    email && /Saturday, October 17 — Morning, after 7:00 AM/.test(email.emailBody) && !/8 AM – 12 PM/.test(email.emailBody), email && email.emailBody);
  ok("2e. the text says the same", sms && /MOVED — was Friday, October 9, now Saturday, October 17 \(Morning, after 7:00 AM\)/.test(sms.smsBody)
    && !/winterization day has MOVED/.test(sms.smsBody), sms && sms.smsBody);
  const after = await fresh(jas.id);
  ok("2f. the notice records which wording went out, and the time it told",
    after.assignment.outreach.dayMoveNotice?.template === "stopmove"
    && after.assignment.outreach.timeNotice?.told?.notBefore === "07:00", JSON.stringify(after.assignment.outreach));
  ok("2g. the booking history says 'stop moved', not 'route day moved'",
    after.history.some((h) => h.action === "day_moved" && /stop moved/.test(h.note)), JSON.stringify(after.history.slice(-6)));
}

// ---- 3. A whole-day move keeps its own notice; a chain with a stop move is a stop notice
{
  const day = await mk("P-DAY", { date: "2026-10-09" });
  await bookings.moveAssignmentDay(day.id, { toDate: "2026-10-16", scheduledFor: new Date(2026, 9, 16, 8, 30).toISOString(), oldDate: "2026-10-09", queueNotice: true, by: "patrick" });
  ok("3a. a day move (the default kind) stays a day notice", (await fresh(day.id)).assignment.outreach.pendingDayMove?.kind === "day");
  const chain = await mk("P-CHAIN", { date: "2026-10-09" });
  await bookings.moveAssignmentDay(chain.id, { toDate: "2026-10-15", scheduledFor: new Date(2026, 9, 15, 8, 30).toISOString(), oldDate: "2026-10-09", queueNotice: true, kind: "stop", by: "patrick" });
  await bookings.moveAssignmentDay(chain.id, { toDate: "2026-10-16", scheduledFor: new Date(2026, 9, 16, 8, 30).toISOString(), oldDate: "2026-10-15", queueNotice: true, kind: "day", by: "patrick" });
  const p = (await fresh(chain.id)).assignment.outreach.pendingDayMove;
  ok("3b. stop move then day move, still unsent: one STOP notice naming the ORIGINAL date",
    p?.kind === "stop" && p.oldDate === "2026-10-09" && p.newDate === "2026-10-16", JSON.stringify(p));
  PLAN = { days: {} };
  clearWire();
  await sweep(8);
  const dayEmail = wire.emails.find((e) => e.refId === day.id);
  ok("3c. the whole-day notice still goes out in its own words", dayEmail && /whole service days/.test(dayEmail.emailBody), dayEmail && dayEmail.emailBody.slice(0, 200));
  ok("3d. …with the half-day when no time was set", dayEmail && /— Morning \(8 AM – 12 PM\)/.test(dayEmail.emailBody));
}

// ---- 4. followPlanMoves ("Move to…" on one stop) marks the move a stop move
{
  const f = await mk("P-FOLLOW", { date: "2026-10-09" });
  const summary = await assignments.followPlanMoves("fall", 2026, { codes: ["P-FOLLOW"], actor: "patrick" }, {
    getPlan: async () => ({ days: { "2026-10-17": { morning: ["P-FOLLOW"], afternoon: [] } } }),
    listProperties: async () => PROPS,
    sequenceDay: async () => ({ timeline: [{ propertyCode: "P-FOLLOW", arriveAt: "08:51" }] })
  });
  const pending = (await fresh(f.id)).assignment.outreach.pendingDayMove;
  ok("4. the single-stop follow marks its notice kind 'stop'", summary.moved === 1 && pending?.kind === "stop", `${JSON.stringify(summary)} ${JSON.stringify(pending)}`);
}

// ---- 5. Setting a time tells the customer — once, with the final time ----
{
  const t = await mk("P-TIME", { date: "2026-10-20" });
  PLAN = { days: { "2026-10-20": { morning: ["P-TIME"], afternoon: [], constraints: { "P-TIME": { notBefore: "09:30" } } } } };
  const q = await assignments.queueTimeNotice("fall", 2026, { date: "2026-10-20", code: "P-TIME" }, { listProperties: async () => PROPS, actor: "patrick" });
  ok("5a. saving a window on a messaged customer's stop queues a time notice", q.queued === true && Boolean((await fresh(t.id)).assignment.outreach.pendingTimeNotice), JSON.stringify(q));
  // Patrick edits again before the sweep runs: the notice carries the FINAL time.
  PLAN.days["2026-10-20"].constraints["P-TIME"] = { notBefore: "09:00", notAfter: "09:30" };
  await assignments.queueTimeNotice("fall", 2026, { date: "2026-10-20", code: "P-TIME" }, { listProperties: async () => PROPS });
  clearWire();
  await sweep(8);
  const mail = wire.emails.filter((e) => e.refId === t.id);
  const text = wire.smses.filter((s) => /time is set/.test(s.smsBody));
  ok("5b. ONE email and ONE text, stating the final time",
    mail.length === 1 && text.length === 1 && /Tuesday, October 20 — between 9:00 AM and 9:30 AM/.test(mail[0].emailBody)
    && /between 9:00 AM and 9:30 AM/.test(text[0].smsBody), `${mail.length} ${text.length} ${mail[0] && mail[0].emailBody}`);
  ok("5c. the time notice does not ask them to confirm all over again", mail[0] && !/press Confirm/.test(mail[0].emailBody));
  const rec = (await fresh(t.id)).assignment.outreach;
  ok("5d. the flag is consumed and what was told is recorded",
    !rec.pendingTimeNotice && rec.timeNotice?.told?.notBefore === "09:00" && rec.timeNotice?.sent?.length === 2, JSON.stringify(rec.timeNotice));
  clearWire();
  await sweep(8);
  ok("5e. the next sweep sends nothing — once, ever", !wire.emails.some((e) => e.refId === t.id));
  // A change and its undo before the sweep → nothing to say.
  PLAN.days["2026-10-20"].constraints["P-TIME"] = { notBefore: "11:00" };
  await assignments.queueTimeNotice("fall", 2026, { date: "2026-10-20", code: "P-TIME" }, { listProperties: async () => PROPS });
  PLAN.days["2026-10-20"].constraints["P-TIME"] = { notBefore: "09:00", notAfter: "09:30" };
  clearWire();
  await sweep(8);
  ok("5f. changed and changed back before the sweep: the customer hears nothing", !wire.emails.some((e) => e.refId === t.id)
    && !(await fresh(t.id)).assignment.outreach.pendingTimeNotice);
  // Cleared after they were told: they're told the half-day.
  delete PLAN.days["2026-10-20"].constraints;
  await assignments.queueTimeNotice("fall", 2026, { date: "2026-10-20", code: "P-TIME" }, { listProperties: async () => PROPS });
  clearWire();
  await sweep(8);
  const cleared = wire.emails.find((e) => e.refId === t.id);
  ok("5g. a time they WERE told, then cleared: they're told it's back to the half-day",
    cleared && /Tuesday, October 20 — Morning \(8 AM – 12 PM\)/.test(cleared.emailBody), cleared && cleared.emailBody);
}

// ---- 6. Who is NOT told, and the screen hears why -------------------------
{
  await mk("P-NEW", { date: "2026-10-21", messaged: false });
  await mk("P-FLEX", { date: "2026-10-21", flex: true });
  await mk("P-OWN", { date: "2026-10-21", requestedWindow: { notBefore: "11:00" } });
  const q = (code, date = "2026-10-21") => assignments.queueTimeNotice("fall", 2026, { date, code }, { listProperties: async () => PROPS });
  ok("6a. never messaged → not_messaged (their first message will carry the time)", (await q("P-NEW")).reason === "not_messaged");
  ok("6b. free bucket → flexible", (await q("P-FLEX")).reason === "flexible");
  ok("6c. the customer set their own time → customer_window", (await q("P-OWN")).reason === "customer_window");
  ok("6d. no booking on that stop/day → no_booking", (await q("P-OWN", "2026-10-22")).reason === "no_booking");
}

// ---- 7. A pending time change rides the move notice: one message, not two -
{
  const b = await mk("P-BOTH", { date: "2026-10-09" });
  PLAN = { days: { "2026-10-23": { morning: ["P-BOTH"], afternoon: [], constraints: { "P-BOTH": { notAfter: "10:00" } } } } };
  await bookings.moveAssignmentDay(b.id, { toDate: "2026-10-23", scheduledFor: new Date(2026, 9, 23, 8, 40).toISOString(), oldDate: "2026-10-09", queueNotice: true, kind: "stop", by: "patrick" });
  await bookings.setAssignmentOutreach(b.id, { pendingTimeNotice: { date: "2026-10-23", queuedAt: new Date().toISOString() } });
  clearWire();
  await sweep(8);
  const mails = wire.emails.filter((e) => e.refId === b.id);
  ok("7a. exactly one email: the move notice, stating the time", mails.length === 1 && /Morning, before 10:00 AM/.test(mails[0].emailBody), `${mails.length} ${mails[0] && mails[0].emailBody}`);
  clearWire();
  await sweep(8);
  ok("7b. …and the time notice it covered does not follow it", !wire.emails.some((e) => e.refId === b.id)
    && !(await fresh(b.id)).assignment.outreach.pendingTimeNotice);
}

// ---- 8. Every step message states the time that was set -------------------
{
  const s = await mk("P-STEP", { date: "2026-10-24", messaged: false });
  PLAN = { days: { "2026-10-24": { morning: ["P-STEP"], afternoon: [], constraints: { "P-STEP": { notBefore: "09:30" } } } } };
  clearWire();
  const step2 = cadence.STEPS.find((x) => String(x.n) === "2");
  await cadence.sendStepForBooking(await fresh(s.id), step2, { season: "fall", year: 2026, deps, by: "test", now: now(8) });
  ok("8a. a follow-up says 'Morning, after 9:30 AM'", wire.emails.some((e) => e.refId === s.id && /Morning, after 9:30 AM/.test(e.emailBody)),
    wire.emails.map((e) => e.emailBody.slice(0, 300)).join(" | "));
  ok("8b. …and records that as what they were told", (await fresh(s.id)).assignment.outreach.timeNotice?.told?.notBefore === "09:30");
}

// ---- 9. The window travels with its stop ----------------------------------
{
  await plans.savePlan("fall", 2026, {
    generatedAt: "2026-08-30T00:00:00Z", source: "test", bucketCap: 5, dayCap: 10,
    days: {
      "2026-10-09": { label: "R6", morning: [], afternoon: ["P-JAS", "P-X"], constraints: { "P-JAS": { notBefore: "13:30" }, "P-X": { notAfter: "15:00" } } },
      "2026-10-17": { label: "R9", morning: [], afternoon: [] }
    }
  }, { actor: "test" });
  await plans.moveStop("fall", 2026, { propertyCode: "P-JAS", toDate: "2026-10-17", toBucket: "morning" }, { actor: "patrick" });
  const p = await plans.getPlan("fall", 2026);
  ok("9a. the moved stop's window is on its new day", JSON.stringify(p.days["2026-10-17"].constraints) === JSON.stringify({ "P-JAS": { notBefore: "13:30" } }), JSON.stringify(p.days["2026-10-17"]));
  ok("9b. …gone from the old day, and the other stop's window untouched",
    JSON.stringify(p.days["2026-10-09"].constraints) === JSON.stringify({ "P-X": { notAfter: "15:00" } }), JSON.stringify(p.days["2026-10-09"]));
}

// ---- 9½. The appointment page says the same time as the messages ----------
{
  const appt = require(path.join(SANDBOX, "server/lib/appointment-actions.js"));
  const b = { assignment: { bucket: "morning", date: "2026-10-17", code: "P-JAS", season: "fall", year: 2026 }, scheduledFor: new Date(2026, 9, 17, 8, 51).toISOString() };
  ok("9½a. the page label with a plan window matches the email's",
    typeof appt.bucketLabelOf === "function" && appt.bucketLabelOf(b, { notBefore: "07:00" }) === "Morning, after 7:00 AM",
    typeof appt.bucketLabelOf === "function" ? appt.bucketLabelOf(b, { notBefore: "07:00" }) : "(not exported)");
  ok("9½b. …and is the plain half-day without one", typeof appt.bucketLabelOf === "function" && appt.bucketLabelOf(b) === "Morning (8 AM – 12 PM)");
  PLAN = { days: { "2026-10-17": { morning: ["P-JAS"], afternoon: [], constraints: { "P-JAS": { notBefore: "07:00" } } } } };
  const w = cadence.planWindowFor ? await cadence.planWindowFor(b, deps) : null;
  ok("9½c. the cadence finds the plan window for a booking on its plan day", w && w.notBefore === "07:00", JSON.stringify(w));
  const moved = { ...b, scheduledFor: new Date(2026, 9, 21, 13, 0).toISOString() };
  const w2 = cadence.planWindowFor ? await cadence.planWindowFor(moved, deps) : "missing";
  ok("9½d. a booking the customer moved off that day does NOT inherit the old day's window", w2 === null, JSON.stringify(w2));
}

// ---- 10. Every reader is wired ---------------------------------------------
{
  const server = read("server/server.js");
  const page = read("server/season-plan.js");
  const msgPage = read("server/assignment-messages.js");
  ok("10a. saving a window queues the time notice and the reply says whether the customer will be told",
    /assignments\.queueTimeNotice\(season, year/.test(server) && /window: result\.window, timeNotice \}/.test(server));
  ok("10b. the Save toast says whether the customer will hear about it",
    /noteFor\(last\.timeNotice\)/.test(page) && /the customer will be told/.test(page));
  ok("10e. every appointment-page reply carries the promised time",
    (server.match(/bucketLabel: await promisedTimeLabel\(/g) || []).length >= 7, String((server.match(/bucketLabel: await promisedTimeLabel\(/g) || []).length));
  ok("10c. the new messages are editable on the Messages page",
    /stopmove_email/.test(msgPage) && /timeset_email/.test(msgPage));
  ok("10d. {bucket} is built through promisedWindow, once", (read("server/lib/assignment-messages.js").match(/function promisedWindow/g) || []).length === 1
    && /windowLabelOf\(bucketKeyOf\(booking\), promisedWindow\(booking, planWindow\)\)/.test(read("server/lib/assignment-messages.js"))
    && /bucket: promisedLabel\(booking, planWindow\)/.test(read("server/lib/assignment-messages.js")));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`test-time-notice: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);

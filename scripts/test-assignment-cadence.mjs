// The cadence engine — stage 4 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-assignment-cadence.mjs
//
// THE STAKES. This is the module that actually messages customers. The
// spec's own words: a double-fired step is the worst bug this system
// can have. So this suite runs the REAL modules — real bookings store,
// real properties store (touches land in seasonalOutreach), real
// template rendering — and injects ONLY the wire: sendEmail / sendSms
// are captured, never sent.
//
// Every numbered rule from Part 2 of the spec is asserted by name.
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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-cadence-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const propertiesLib = require(path.join(SANDBOX, "server/lib/properties.js"));
const seasonKey = propertiesLib.seasonKey(2026, "fall");

const prop = (id, extra = {}) => ({
  id, code: id,
  customerName: `Customer ${id}`,
  customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`,
  address: `${id} Test St, Newmarket, ON`,
  town: "Newmarket",
  ...extra
});
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify([
  prop("P-1"),
  prop("P-2"),
  prop("P-3"),
  prop("P-OPTOUT", { seasonalOutreach: { [seasonKey]: { optOutThisSeason: true, touches: [] } } }),
  prop("P-EMAILONLY", { customerPhone: "" })
], null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const cadence = require(path.join(SANDBOX, "server/lib/assignment-cadence.js"));
const messages = require(path.join(SANDBOX, "server/lib/assignment-messages.js"));

const D = (day, h = 8, m = 0) => new Date(2026, 9, day, h, m).toISOString();  // October 2026
const mk = (pid, opts = {}) => bookings.createDirect({
  propertyId: pid,
  customerName: `Customer ${pid}`,
  customerPhone: pid === "P-EMAILONLY" ? "" : "+19055550100",
  customerEmail: `${pid.toLowerCase()}@example.com`,
  address: `${pid} Test St, Newmarket, ON`,
  serviceKey: "fall_close_4z",
  serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor: opts.scheduledFor || D(5, 8, 13),
  durationMinutes: 30,
  status: "confirmed",
  source: "assignment",
  assignment: {
    season: "fall", year: 2026, batchId: "AS-test", assignedAt: "x",
    date: opts.date || "2026-10-05", bucket: opts.bucket || "morning", code: pid
  }
});
await mk("P-1");
await mk("P-2", { bucket: "afternoon", scheduledFor: D(5, 12, 53) });
await mk("P-3");
await mk("P-OPTOUT");
await mk("P-EMAILONLY");

// The captured wire.
const wire = { emails: [], smses: [], failNextSms: false };
const deps = {
  sendEmail: async (args) => { wire.emails.push(args); return { ok: true, messageId: "test" }; },
  sendSms: async (args) => {
    if (wire.failNextSms) { wire.failNextSms = false; return { ok: false, error: "twilio down" }; }
    wire.smses.push(args); return { ok: true, sid: "test" };
  }
};

const at = (month, day, h, min = 0) => new Date(2026, month - 1, day, h, min);

// ---- 1. The interlocks -------------------------------------------------

let threw = null;
try { await cadence.blast("fall", 2026, { deps, now: at(9, 10, 10) }); } catch (e) { threw = e.message; }
ok("the blast REFUSES while the appointment page isn't live — no dead links to customers",
  /appointment page/i.test(threw || ""), threw);

threw = null;
try { await cadence.blast("fall", 2026, { deps, now: at(9, 10, 7), appointmentPageReady: true }); }
catch (e) { threw = e.message; }
ok("rule 7: the blast refuses outside 09:00–18:00 Toronto", /9:00/.test(threw || ""), threw);

ok("the sweep outside the window is a quiet no-op",
  (await cadence.sweepDue("fall", 2026, { deps, now: at(9, 20, 8), appointmentPageReady: true })).waiting === "send_window");

// ---- 2. The blast ------------------------------------------------------

const blastResult = await cadence.blast("fall", 2026, {
  deps, now: at(9, 10, 10), appointmentPageReady: true, by: "patrick"
});
ok("the blast messages every reachable assigned customer",
  blastResult.blasted === 4, JSON.stringify(blastResult));
ok("rule 8: an opted-out customer is skipped at the send, not just at assignment",
  blastResult.skipped.some((s) => s.code === "P-OPTOUT" && s.reason === "season_opt_out"));
ok("four emails and three texts went out (P-EMAILONLY has no phone)",
  wire.emails.length === 4 && wire.smses.length === 3,
  `emails ${wire.emails.length}, smses ${wire.smses.length}`);

const p1 = (await bookings.list()).find((b) => b.propertyId === "P-1");
ok("step 1 is recorded on the booking with what was actually sent",
  p1.assignment.outreach.steps["1"].sent.includes("email")
  && p1.assignment.outreach.steps["1"].sent.includes("sms"));
ok("a per-customer appointment token was minted",
  typeof p1.assignment.outreach.token === "string" && p1.assignment.outreach.token.length >= 16);
const p2 = (await bookings.list()).find((b) => b.propertyId === "P-2");
ok("tokens are unique per booking", p1.assignment.outreach.token !== p2.assignment.outreach.token);
ok("the SMS body carries the customer's REAL appointment link, not a placeholder",
  wire.smses.some((s) => s.smsBody.includes(`/a/${p1.assignment.outreach.token}`))
  && !wire.smses.some((s) => s.smsBody.includes("[appointment-link]")));
ok("the email goes out with the appointment-page button",
  wire.emails.every((e) => e.ctaLabel === "Open your appointment page"));

const touchedP1 = await propertiesLib.get("P-1");
const touch = touchedP1.seasonalOutreach[seasonKey].touches.at(-1);
ok("THE TYPE FIELD EXISTS: the touch is typed assignment, step 1 — never mistakable for marketing",
  touch.type === "assignment" && touch.step === 1, JSON.stringify(touch));

wire.emails.length = 0; wire.smses.length = 0;
const again = await cadence.blast("fall", 2026, { deps, now: at(9, 10, 11), appointmentPageReady: true });
ok("rule 1: blasting again sends NOTHING — a step fires at most once, ever",
  again.blasted === 0 && again.alreadyBlasted === 4 && wire.emails.length === 0 && wire.smses.length === 0,
  JSON.stringify(again));

// ---- 3. The sweep: due days, responses, the window ---------------------

// P-2 answers the phone; Patrick one-taps the mark.
await bookings.markAssignmentResponded(p2.id, { via: "manual", by: "patrick" });

// D = Oct 5, so step 2 (D−15) is due Sept 20.
wire.emails.length = 0; wire.smses.length = 0;
const sweep1 = await cadence.sweepDue("fall", 2026, { deps, now: at(9, 20, 9, 5), appointmentPageReady: true });
ok("rule 3: step 2 goes to non-responders only",
  sweep1.sent === 3, JSON.stringify(sweep1));
const p2after = await bookings.get(p2.id);
ok("...the responder's step 2 was never fired",
  !p2after.assignment.outreach.steps["2"]);

wire.emails.length = 0; wire.smses.length = 0;
const sweepAgain = await cadence.sweepDue("fall", 2026, { deps, now: at(9, 20, 15), appointmentPageReady: true });
ok("rule 1 again: the same day's second sweep re-sends nothing",
  sweepAgain.sent === 0 && wire.emails.length === 0);

// ---- 4. Rule 2: a missed day is missed --------------------------------

// Nobody swept on Sept 25 (D−10). On Sept 26 nothing is due.
const sweepLate = await cadence.sweepDue("fall", 2026, { deps, now: at(9, 26, 10), appointmentPageReady: true });
ok("rule 2: a step whose day has passed is SKIPPED, never backfilled",
  sweepLate.sent === 0, JSON.stringify(sweepLate));
ok("...and the missed step stays unfired on the record",
  !(await bookings.get(p1.id)).assignment.outreach.steps["3"]);

// ---- 5. Rules 3+4: reschedule re-anchors; nothing stops step 6 --------

// P-2 (responded) moves to Oct 8. Step 6 must fire Oct 7 — response or not.
// P-3 cancels FIRST, so the Oct 4 sweep also proves rule 5 below.
const p3 = (await bookings.list()).find((b) => b.propertyId === "P-3");
await bookings.cancel(p3.id, { by: "customer", reason: "moved away" });
await bookings.reschedule(p2.id, { scheduledFor: D(8, 12, 0), by: "customer" });
wire.smses.length = 0;
const oldD1 = await cadence.sweepDue("fall", 2026, { deps, now: at(10, 4, 10), appointmentPageReady: true });
const p2onOld = (await bookings.get(p2.id)).assignment.outreach.steps["6"];
ok("rule 4: after a reschedule the 24-hour reminder does NOT fire on the old D−1",
  !p2onOld, JSON.stringify(oldD1));
await cadence.sweepDue("fall", 2026, { deps, now: at(10, 7, 10), appointmentPageReady: true });
ok("rules 3+4: step 6 fires at the NEW D−1, even for a responder — nothing stops step 6",
  Boolean((await bookings.get(p2.id)).assignment.outreach.steps["6"])
  && wire.smses.some((s) => s.smsBody.includes("tomorrow")));

// ---- 6. Rule 5: cancellation stops everything, step 6 included --------
// (P-3 was cancelled before the Oct 4 sweep above — its D−1.)

ok("rule 5: a cancelled booking gets nothing — not even the 24-hour reminder",
  !(await bookings.get(p3.id)).assignment.outreach.steps["6"]);

// P-1 is alive: its step 6 fires on Oct 4 (D−1 for Oct 5).
ok("...while the live booking beside it gets its reminder",
  Boolean((await bookings.get(p1.id)).assignment.outreach.steps["6"]));

// ---- 7. The step-6 email fallback -------------------------------------

const pe = (await bookings.list()).find((b) => b.propertyId === "P-EMAILONLY");
ok("a customer with no phone got the 24-hour reminder BY EMAIL — a reminder they can't receive helps nobody",
  pe.assignment.outreach.steps["6"] && pe.assignment.outreach.steps["6"].sent.includes("email"),
  JSON.stringify(pe.assignment.outreach.steps["6"]));

// ---- 8. Mark-before-send: a failed send is not a re-fire --------------

// Fresh booking, blasted; then its step-2 SMS fails at the wire.
await mk("P-1", { date: "2026-10-20", scheduledFor: D(20, 8, 0) });
// (same property, new booking — P-1's earlier booking is separate)
const late = (await bookings.list()).find((b) => b.assignment?.date === "2026-10-20");
await cadence.blast("fall", 2026, { deps, now: at(9, 30, 10), appointmentPageReady: true });
wire.failNextSms = true;
wire.emails.length = 0;
await cadence.sweepDue("fall", 2026, { deps, now: at(10, 5, 10), appointmentPageReady: true });  // D−15 for Oct 20
const lateStep = (await bookings.get(late.id)).assignment.outreach.steps["2"];
ok("a send failure is RECORDED on the step, email leg still delivered",
  lateStep && lateStep.errors?.length === 1 && lateStep.sent.includes("email"),
  JSON.stringify(lateStep));
const before = wire.smses.length;
await cadence.sweepDue("fall", 2026, { deps, now: at(10, 5, 14), appointmentPageReady: true });
ok("rule 1, the hard way: the failed step is NOT re-fired — marked before sending, visible, retryable by hand",
  wire.smses.length === before
  && (await bookings.get(late.id)).assignment.outreach.steps["2"].errors?.length === 1);

// ---- 9. The placeholder guard -----------------------------------------

messages.setTemplate("followup_sms", { body: "Broken template with a literal [appointment-link] pasted in" });
threw = null;
try { cadence.renderStep(late, cadence.STEPS[1], "tok123"); } catch (e) { threw = e.message; }
ok("a rendered message still carrying a bracketed placeholder REFUSES to send",
  /placeholder/i.test(threw || ""), threw);
messages.setTemplate("followup_sms", { body: "" });   // back to default

// ---- 10. The engine's shape -------------------------------------------

ok("the cadence table is the spec's: blast, D−15, D−10, D−7, D−5, D−1",
  JSON.stringify(cadence.STEPS.map((s) => s.daysBefore ?? "B")) === JSON.stringify(["B", 15, 10, 7, 5, 1]));
ok("steps 1–5 are email+SMS; step 6 is SMS",
  cadence.STEPS.slice(0, 5).every((s) => s.channels.length === 2)
  && cadence.STEPS[5].channels.join() === "sms");
ok("only steps 2–5 stop on response",
  cadence.STEPS.filter((s) => s.stopsOnResponse).map((s) => s.n).join() === "2,3,4,5");

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-assignment-cadence: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-assignment-cadence: ${pass} assertions passed`);

// Texts customers send to the Twilio number — lib/sms-inbound.js.
//
//   node scripts/test-sms-inbound.mjs        (in build:check)
//
// WHY THIS EXISTS. 2026-09-25: customers replied "YES" to the automated
// appointment text, into a number nobody reads. Nothing heard them, the
// "we haven't heard from you" reminders kept coming, and two of them
// phoned Patrick. This suite runs the REAL booking store and the REAL
// appointment-page confirm, so a texted YES is proven to land exactly
// where a tapped Confirm does — and every other text is proven to reach
// Patrick instead of vanishing.
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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-sms-in-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const PROPS = [
  { id: "P-1", code: "P-1", customerName: "Greg Davis", customerPhone: "+19055550100",
    customerEmail: "g@example.com", address: "90 Oriole Drive, East Gwillimbury, ON" },
  { id: "P-2", code: "P-2", customerName: "Pat Manager", customerPhone: "905-555-0199",
    customerEmail: "m@example.com", address: "1 Condo Way, Newmarket, ON" },
  { id: "P-3", code: "P-3", customerName: "Pat Manager", customerPhone: "905-555-0199",
    customerEmail: "m@example.com", address: "2 Condo Way, Newmarket, ON" },
  { id: "P-4", code: "P-4", customerName: "Sam Stopper", customerPhone: "(416) 555-0144",
    customerEmail: "s@example.com", address: "4 Quiet Lane, Aurora, ON" }
];
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify(PROPS, null, 2));

const properties = require(path.join(SANDBOX, "server/lib/properties.js"));
const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const appointment = require(path.join(SANDBOX, "server/lib/appointment-actions.js"));
const sms = require(path.join(SANDBOX, "server/lib/sms-inbound.js"));

const NOW = new Date(2026, 8, 25, 10, 0);
async function mk(p, scheduledFor, extra = {}) {
  const b = await bookings.createDirect({
    propertyId: p.id, customerName: p.customerName, customerPhone: p.customerPhone,
    customerEmail: p.customerEmail, address: p.address,
    serviceKey: "fall_close_4z", serviceLabel: "Fall winterization",
    scheduledFor, durationMinutes: 30, status: "confirmed", source: "assignment",
    assignment: { season: "fall", year: 2026, batchId: "AS-t", assignedAt: "x",
      date: scheduledFor.slice(0, 10), bucket: "morning", code: p.id },
    ...extra
  });
  await appointment.ensureToken(b.id);
  return bookings.get(b.id);
}
const greg = await mk(PROPS[0], new Date(2026, 9, 5, 8, 15).toISOString());
await mk(PROPS[1], new Date(2026, 9, 6, 8, 15).toISOString());
await mk(PROPS[2], new Date(2026, 9, 6, 9, 15).toISOString());
// Greg also has a PAST appointment on the same number — it must not make
// his YES ambiguous.
await mk(PROPS[0], new Date(2026, 8, 1, 8, 15).toISOString());

const STORE = path.join(SANDBOX, "server/data/sms-inbound.json");
const alerts = [];
const deps = (over = {}) => ({
  now: NOW,
  storeFile: STORE,
  listBookings: () => bookings.list(),
  listProperties: () => properties.list(),
  summarize: appointment.summarize,
  confirmByToken: (token, opts) => appointment.confirm(token, { ...opts, now: NOW }),
  updateProperty: (id, patch) => properties.update(id, patch),
  sendAlert: async (body) => { alerts.push(body); return { ok: true }; },
  ...over
});
let sid = 0;
const text = (from, body, over = {}) => sms.handleInbound({ from, body, messageSid: `SM${++sid}`, to: "+16475550000" }, deps(over));

// ---- 1. Keywords ------------------------------------------------------

for (const [body, want] of [
  ["YES", "yes"], ["yes", "yes"], [" Yes!! ", "yes"], ["Y", "yes"], ["Confirmed.", "yes"],
  ["ok", "yes"], ["👍", "yes"], ["👍🏻", "yes"], ["Yes please", "yes"],
  ["STOP", "stop"], ["stop", "stop"], ["Unsubscribe", "stop"],
  ["CANCEL", "stop"],
  ["START", "start"], ["HELP", "help"],
  ["Can you come Tuesday instead?", "other"], ["yes but can you come at 2?", "other"], ["", "other"]
]) {
  ok(`classify(${JSON.stringify(body)}) → ${want}`, sms.classify(body) === want, sms.classify(body));
}
ok("phone numbers match however they're written",
  sms.phoneKey("+1 (905) 555-0100") === sms.phoneKey("905.555.0100")
  && sms.phoneKey("19055550100") === "9055550100");
ok("a short number matches nothing", sms.phoneKey("12345") === "");

// ---- 2. YES from a customer with one upcoming appointment --------------

alerts.length = 0;
const yes = await text("+19055550100", "Yes!");
const gregAfter = await bookings.get(greg.id);
ok("YES confirms the appointment", yes.action === "confirmed", yes.action);
ok("…stamped on the booking as a customer response",
  Boolean(gregAfter.assignment.outreach.respondedAt) && gregAfter.assignment.outreach.responseVia === "sms_reply");
ok("…the page now reads 'responded' (same rule as the button)",
  appointment.summarize(gregAfter, { now: NOW }).state === "responded");
ok("…and the customer state reads 'confirmed' everywhere",
  bookings.customerState(gregAfter) === "confirmed", bookings.customerState(gregAfter));
ok("…the reply thanks them by first name and names the day",
  /thanks Greg/.test(yes.reply) && /Monday, October 5/.test(yes.reply) && /960-0181/.test(yes.reply), yes.reply);
ok("…and does not also send the 'unmonitored' reply", !/automated texting system/.test(yes.reply));
ok("…Patrick is NOT pinged for a clean YES", alerts.length === 0, alerts.join(" | "));
ok("…the booking history records it",
  gregAfter.history.some((h) => h.action === "assignment_responded" && /sms_reply/.test(h.note)));

const again = await text("+19055550100", "yes");
ok("a second YES still answers politely", again.action === "confirmed" && /confirmed/.test(again.reply));
ok("…and keeps the first answer's time",
  (await bookings.get(greg.id)).assignment.outreach.respondedAt === gregAfter.assignment.outreach.respondedAt);

// ---- 3. YES that can't be pinned to one appointment -------------------

alerts.length = 0;
const multi = await text("9055550199", "YES");
ok("YES from a number with two upcoming appointments is NOT auto-confirmed", multi.action === "yes_unmatched", multi.action);
ok("…neither of them was touched",
  (await bookings.list()).filter((b) => b.propertyId === "P-2" || b.propertyId === "P-3")
    .every((b) => !b.assignment.outreach?.respondedAt));
ok("…Patrick gets it, told why", alerts.length === 1 && /2 upcoming appointments/.test(alerts[0]), alerts[0]);
ok("…the customer gets the automated-number reply", /automated texting system/.test(multi.reply) && /960-0181/.test(multi.reply));

alerts.length = 0;
const stranger = await text("+12895550123", "yes");
ok("YES from an unknown number confirms nothing", stranger.action === "yes_unmatched");
ok("…and the reply leaks no name, address or date",
  !/Greg|Oriole|October/.test(stranger.reply || ""), stranger.reply);
ok("…Patrick still sees it", alerts.length === 1 && /\+12895550123/.test(alerts[0]));

// ---- 4. Anything else goes to Patrick ---------------------------------

alerts.length = 0;
const q = await text("+19055550100", "Can you come Tuesday instead?");
ok("a question is forwarded", q.action === "forwarded" && alerts.length === 1);
ok("…naming the customer, the street and the appointment",
  /Greg Davis/.test(alerts[0]) && /90 Oriole Drive/.test(alerts[0]) && /Oct 5/.test(alerts[0]) && /Tuesday instead/.test(alerts[0]), alerts[0]);
ok("…and the customer is told it's an automated number and to use 905-960-0181",
  /automated texting system/.test(q.reply) && /\(905\) 960-0181/.test(q.reply), q.reply);

alerts.length = 0;
const q2 = await text("+19055550100", "Also the gate code is 1234");
ok("a follow-up within 12 h is still forwarded", alerts.length === 1 && /gate code/.test(alerts[0]));
ok("…but the automated reply isn't repeated", q2.reply === null, q2.reply);

const later = await sms.handleInbound({ from: "+19055550100", body: "hello again", messageSid: "SM-later" },
  deps({ now: new Date(NOW.getTime() + 13 * 3600 * 1000) }));
ok("after 12 h the automated reply comes back", /automated texting system/.test(later.reply || ""));

// ---- 5. STOP / START / HELP -------------------------------------------

alerts.length = 0;
const stop = await text("416-555-0144", "STOP");
ok("STOP gets no reply from us (Twilio's own opt-out answers)", stop.reply === null);
ok("…turns off the property's seasonal texts in the CRM",
  (await properties.get("P-4")).commPrefs?.seasonalRemindersSMS === false);
ok("…and tells Patrick", alerts.length === 1 && /STOP/.test(alerts[0]));

const cancelWord = await text("+19055550100", "CANCEL");
ok("CANCEL is a carrier opt-out, never an appointment cancellation",
  cancelWord.cls === "stop" && (await bookings.get(greg.id)).status === "confirmed");

alerts.length = 0;
const start = await text("416-555-0144", "START");
ok("START gets no reply from us and doesn't flip consent back on",
  start.reply === null && (await properties.get("P-4")).commPrefs?.seasonalRemindersSMS === false);
ok("…Patrick is told", alerts.length === 1);

const help = await text("+19055550100", "help");
ok("HELP gets our line", /960-0181/.test(help.reply) && /STOP/.test(help.reply));

// ---- 6. Twilio retries -------------------------------------------------

alerts.length = 0;
const first = await sms.handleInbound({ from: "+12895550999", body: "hi", messageSid: "SM-dup" }, deps());
const retry = await sms.handleInbound({ from: "+12895550999", body: "hi", messageSid: "SM-dup" }, deps());
ok("a retried MessageSid is handled once", first.action === "forwarded" && retry.action === "duplicate" && alerts.length === 1);
ok("…and gets no second reply", retry.reply === null);

// ---- 7. A cancelled appointment can't be confirmed by text -------------

const P5 = { id: "P-5", code: "P-5", customerName: "Dee Gone", customerPhone: "+19055550155",
  customerEmail: "d@example.com", address: "5 Gone Rd, Newmarket, ON" };
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"),
  JSON.stringify([...(await properties.list()), P5], null, 2));
const dead = await mk(P5, new Date(2026, 9, 7, 8, 15).toISOString());
await bookings.cancel(dead.id, { reason: "test", by: "admin" });
alerts.length = 0;
const deadYes = await text("+19055550155", "yes");
ok("YES for a cancelled appointment confirms nothing", deadYes.action === "yes_unmatched", deadYes.action);
ok("…the booking stays cancelled", (await bookings.get(dead.id)).status === "cancelled");

// ---- 8. Patrick replying to a forward --------------------------------

alerts.length = 0;
const owner = await sms.handleInbound({ from: "+1 905 555 0001", body: "Tuesday works", messageSid: "SM-owner" },
  deps({ ownerPhone: "9055550001" }));
ok("Patrick's own reply is not forwarded back to him", alerts.length === 0 && owner.action === "from_owner");
ok("…he's told replies here don't reach the customer", /don't reach the customer/.test(owner.reply || ""));

// ---- 8. The log --------------------------------------------------------

const rows = await sms.readStore(STORE);
ok("every text is logged", rows.length >= 12, String(rows.length));
ok("…with what was done about it", rows.some((r) => r.action === "confirmed") && rows.some((r) => r.action === "sms_opted_out"));

fs.rmSync(SANDBOX, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n✗ test-sms-inbound: ${failures.length} failed, ${pass} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ test-sms-inbound: ${pass} assertions passed`);

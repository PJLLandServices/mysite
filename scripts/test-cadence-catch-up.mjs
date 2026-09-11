#!/usr/bin/env node
// scripts/test-cadence-catch-up.mjs
//
// "I need to send the other emails too." — Patrick, 2026-09-11.
//
// THE HOLE THIS CLOSES. The app password died mid-campaign. The cadence
// ran, marked its steps (rule 1: mark BEFORE sending, so a crash can never
// repeat a message), and every email failed on authentication — while the
// texts went out normally, because Twilio is a different provider.
//
// So each of those customers is on record as having had their step, with
// `sent: ["sms"]` and an email error beside it. The sweep skips a step that
// is already marked. The email was owed, it was knowable from the step
// record, and nothing was ever going to send it.
//
// The rule below reads that gap. What makes it delicate is that a step
// record has THREE states, and only one is owed:
//
//   no record         — never fired. The sweep's own rules own this one.
//   record, no `sent` — marked, result never written. THE CRASH WINDOW:
//                       the wire may have been touched. Retrying here
//                       hands back exactly the double-send that marking
//                       first exists to prevent. Never owed.
//   record + `sent`   — we know what went and what didn't. The difference
//                       is owed.
//
// The suite pins all three, pins that a catch-up re-sends ONLY the missing
// channel (the customer who got the text must not get it twice), and pins
// that the catch-up does not quietly become part of the sweep — an outage
// must not re-send to everyone the moment mail comes back.
//
// Run: node scripts/test-cadence-catch-up.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cadence = require(path.join(ROOT, "server", "lib", "assignment-cadence.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 220) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const owed = (record) => {
  if (typeof cadence.channelsOwed !== "function") return "(channelsOwed is missing)";
  try { return cadence.channelsOwed(record); } catch (err) { return `(threw: ${err.message})`; }
};
const owedFor = (booking) => {
  if (typeof cadence.owedForBooking !== "function") return "(owedForBooking is missing)";
  try { return cadence.owedForBooking(booking); } catch (err) { return `(threw: ${err.message})`; }
};
const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

// ---- 1. The three states of a step record ---------------------------
{
  ok("a step that never fired owes nothing",
    same(owed(null), []) && same(owed(undefined), []), j(owed(null)));

  // THE CRASH WINDOW. Marked, result never written — the send may have
  // gone out and the process died before recording it. Marking first is
  // the whole reason this can't be retried.
  ok("the crash window owes nothing — that is what mark-first buys",
    same(owed({ at: "x", attempted: ["email", "sms"] }), []),
    j(owed({ at: "x", attempted: ["email", "sms"] })));

  ok("a step where everything went owes nothing",
    same(owed({ at: "x", attempted: ["email", "sms"], sent: ["email", "sms"] }), []),
    j(owed({ at: "x", attempted: ["email", "sms"], sent: ["email", "sms"] })));

  // The morning itself: Twilio fine, Gmail refused.
  const partial = { at: "x", attempted: ["email", "sms"], sent: ["sms"], errors: [{ channel: "email", error: "535" }] };
  ok("the text went and the email didn't → the email is owed",
    same(owed(partial), ["email"]), j(owed(partial)));

  ok("nothing went at all → both are owed",
    same(owed({ at: "x", attempted: ["email", "sms"], sent: [] }), ["email", "sms"]),
    j(owed({ at: "x", attempted: ["email", "sms"], sent: [] })));

  // Never owe a channel that was never attempted — step 6 is SMS-only, and
  // owing an email nobody meant to send would invent a message.
  ok("a channel the step never attempted is never owed",
    same(owed({ at: "x", attempted: ["sms"], sent: [] }), ["sms"]),
    j(owed({ at: "x", attempted: ["sms"], sent: [] })));

  ok("junk in the record answers rather than throwing",
    same(owed({}), []) && same(owed("nonsense"), []) && same(owed({ sent: "no" }), []),
    j([owed({}), owed("nonsense"), owed({ sent: "no" })]));
}

// ---- 2. Across a whole booking --------------------------------------
{
  const booking = {
    id: "BK-OWED-1",
    source: "assignment",
    status: "confirmed",
    assignment: {
      season: "fall", year: 2026, code: "P-001",
      outreach: {
        steps: {
          "1": { at: "x", attempted: ["email", "sms"], sent: ["sms"], errors: [{ channel: "email" }] },
          "2": { at: "x", attempted: ["email", "sms"], sent: ["email", "sms"] },
          "3": { at: "x", attempted: ["email", "sms"] }   // crash window
        }
      }
    }
  };
  const list = owedFor(booking);
  ok("one booking reports only the steps that owe something",
    Array.isArray(list) && list.length === 1, j(list));
  ok("…naming the step and the channel",
    Array.isArray(list) && list[0]?.step?.n === 1 && same(list[0]?.channels, ["email"]), j(list?.[0]));

  ok("a booking that owes nothing reports nothing",
    Array.isArray(owedFor({ id: "BK-2", assignment: { outreach: { steps: {} } } }))
    && owedFor({ id: "BK-2", assignment: { outreach: { steps: {} } } }).length === 0, "clean booking still owed");
  ok("a booking with no outreach at all answers rather than throwing",
    Array.isArray(owedFor({ id: "BK-3" })) && owedFor({ id: "BK-3" }).length === 0, j(owedFor({ id: "BK-3" })));
}

// ---- 3. A catch-up sends ONLY what is owed ---------------------------
//
// The customer already got the text. Sending it again because the email
// failed is its own small betrayal.
{
  const booking = {
    id: "BK-CATCH-1",
    source: "assignment",
    status: "confirmed",
    customerName: "Dale Probe",
    customerEmail: "dale@example.com",
    customerPhone: "+15551234567",
    propertyId: "P-1",
    scheduledFor: new Date(Date.now() + 10 * 864e5).toISOString(),
    serviceLabel: "Fall closing",
    assignment: {
      season: "fall", year: 2026, code: "P-001",
      outreach: {
        token: "tok-catch-up-probe-01",
        steps: { "1": { at: "2026-09-10T13:00:00Z", attempted: ["email", "sms"], sent: ["sms"], errors: [{ channel: "email", error: "535" }] } }
      }
    }
  };
  const emails = [];
  const texts = [];
  const writes = [];
  const deps = {
    listBookings: async () => [booking],
    getProperty: async () => ({
      id: "P-1", customerName: "Dale Probe", address: "1 Test Rd, Newmarket, ON",
      customerEmail: "dale@example.com", customerPhone: "+15551234567",
      seasonalEligibility: { fallClosing: true },
      commPrefs: { seasonalEmail: true, seasonalSms: true }
    }),
    sendEmail: async (m) => { emails.push(m); return { ok: true, messageId: "m1" }; },
    sendSms: async (m) => { texts.push(m); return { ok: true }; },
    recordTouch: async () => {},
    setAssignmentOutreach: async (id, patch) => { writes.push(patch); return booking; }
  };

  let result = null;
  if (typeof cadence.catchUpOwed !== "function") {
    result = { ok: false, error: "(catchUpOwed is missing)" };
  } else {
    try {
      result = await cadence.catchUpOwed("fall", 2026, {
        deps, by: "test", appointmentPageReady: true,
        now: new Date("2026-09-11T14:00:00-04:00")   // inside the send window
      });
    } catch (err) { result = { ok: false, error: err.message }; }
  }

  ok("the catch-up runs at all", result?.ok === true, j(result));
  ok("…and counts what was owed", result?.owed === 1, j(result));
  ok("the owed EMAIL is sent", emails.length === 1, `emails=${emails.length}`);
  ok("…and the text that already went is NOT sent again", texts.length === 0, `texts=${texts.length}`);
  ok("…carrying the booking id into the ledger, so a failure is traceable",
    emails[0]?.refId === "BK-CATCH-1", j(emails[0]?.refId));

  // The step record must end up saying BOTH channels went — the result
  // write replaces the step, so a careless merge would erase the SMS.
  const stepWrite = writes.map((w) => w.steps?.["1"]).filter(Boolean).pop();
  ok("the step now records the text AND the email as sent",
    same(stepWrite?.sent, ["sms", "email"]), j(stepWrite));
  ok("…so nothing is owed on it any more", same(owed(stepWrite), []), j(owed(stepWrite)));
  ok("…and it is marked as a catch-up rather than passed off as the original",
    Boolean(stepWrite?.caughtUpAt), j(stepWrite));
  ok("…keeping the ORIGINAL timestamp, because that is when the step fired",
    stepWrite?.at === "2026-09-10T13:00:00Z", j(stepWrite?.at));

  // Rule 1 is not re-run: a catch-up must not re-mark the step, because
  // the record it would overwrite is the evidence the send depends on.
  const marks = writes.filter((w) => w.steps?.["1"] && !("sent" in w.steps["1"]));
  ok("a catch-up does not re-mark the step first", marks.length === 0, j(marks));
}

// ---- 4. A catch-up obeys every gate a normal send obeys --------------
{
  const booking = {
    id: "BK-CATCH-2", source: "assignment", status: "confirmed",
    customerName: "Opted Out", customerEmail: "out@example.com",
    propertyId: "P-2", scheduledFor: new Date(Date.now() + 10 * 864e5).toISOString(),
    assignment: {
      season: "fall", year: 2026, code: "P-002",
      outreach: { token: "tok-catch-up-probe-02",
        steps: { "1": { at: "x", attempted: ["email"], sent: [], errors: [{ channel: "email" }] } } }
    }
  };
  const emails = [];
  const deps = {
    listBookings: async () => [booking],
    // Opted out of the season since the failed send — the same gate the
    // blast and every sweep step run through (cadenceGates).
    getProperty: async () => ({
      id: "P-2", customerName: "Opted Out", address: "2 Test Rd, Newmarket, ON",
      customerEmail: "out@example.com",
      seasonalOutreach: { "2026:fall": { optOutThisSeason: true } },
      commPrefs: { seasonalEmail: true }
    }),
    sendEmail: async (m) => { emails.push(m); return { ok: true }; },
    sendSms: async () => ({ ok: true }),
    recordTouch: async () => {},
    setAssignmentOutreach: async () => booking
  };
  let result = null;
  try {
    result = typeof cadence.catchUpOwed === "function"
      ? await cadence.catchUpOwed("fall", 2026, { deps, by: "test", appointmentPageReady: true, now: new Date("2026-09-11T14:00:00-04:00") })
      : { ok: false };
  } catch (err) { result = { ok: false, error: err.message }; }
  ok("somebody who opted out since the failure is NOT caught up",
    emails.length === 0, `emails=${emails.length}`);
  ok("…and the run still completes rather than erroring out", result?.ok === true, j(result));

  // Outside the send window, a catch-up refuses like any other send.
  const night = typeof cadence.catchUpOwed === "function"
    ? await cadence.catchUpOwed("fall", 2026, { deps, by: "test", appointmentPageReady: true, now: new Date("2026-09-11T03:00:00-04:00") })
    : null;
  ok("a catch-up outside the send window is refused, not sent",
    night?.ok === false && night?.waiting === "send_window", j(night));

  // And it never sends before the appointment page is live — the links
  // would lead nowhere.
  const notReady = typeof cadence.catchUpOwed === "function"
    ? await cadence.catchUpOwed("fall", 2026, { deps, by: "test", appointmentPageReady: false })
    : null;
  ok("…nor before the appointment page is live",
    notReady?.ok === false && notReady?.waiting === "appointment_page", j(notReady));
}

// ---- 5. Look before you send ----------------------------------------
{
  const booking = {
    id: "BK-CATCH-3", source: "assignment", status: "confirmed",
    customerName: "Dry Run", customerEmail: "dry@example.com",
    propertyId: "P-3", scheduledFor: new Date(Date.now() + 10 * 864e5).toISOString(),
    assignment: { season: "fall", year: 2026, code: "P-003",
      outreach: { token: "tok-catch-up-probe-03",
        steps: { "1": { at: "x", attempted: ["email", "sms"], sent: ["sms"] } } } }
  };
  const emails = [];
  const deps = {
    listBookings: async () => [booking],
    getProperty: async () => ({ id: "P-3", address: "3 Test Rd", customerEmail: "dry@example.com" }),
    sendEmail: async (m) => { emails.push(m); return { ok: true }; },
    sendSms: async () => ({ ok: true }),
    recordTouch: async () => {},
    setAssignmentOutreach: async () => booking
  };
  const preview = typeof cadence.catchUpOwed === "function"
    ? await cadence.catchUpOwed("fall", 2026, { deps, dryRun: true, appointmentPageReady: true })
    : null;
  ok("a dry run says who is owed what", preview?.owed === 1, j(preview));
  ok("…naming the customer, not just a count",
    preview?.detail?.[0]?.customerName === "Dry Run" && same(preview?.detail?.[0]?.channels, ["email"]),
    j(preview?.detail?.[0]));
  ok("…and sends absolutely nothing", emails.length === 0, `emails=${emails.length}`);
}

// ---- 6. The wiring, and what it must NOT touch ----------------------
{
  const src = read("server/lib/assignment-cadence.js");
  // THE LINE THAT MUST NOT MOVE. If the sweep ever starts retrying owed
  // steps by itself, an outage re-sends to the whole campaign the moment
  // mail comes back — with nobody deciding that.
  ok("the sweep still skips a step that is already marked (rule 1 intact)",
    /if \(outreachState\.steps\[String\(step\.n\)\]\) continue;\s*\/\/ rule 1/.test(src),
    "the sweep's rule 1 changed — a catch-up must be pressed, never swept");
  ok("…and the catch-up is its own function, not folded into the sweep",
    /async function catchUpOwed\(/.test(src) && !/catchUpOwed\([^)]*\)[\s\S]{0,200}sweepDue/.test(src),
    "catch-up leaked into the sweep");
  ok("the blast still refuses a booking that already has step 1",
    /if \(b\.assignment\.outreach\?\.steps\?\.\["1"\]\) \{ result\.alreadyBlasted/.test(src),
    "the blast would re-send to everyone");

  const server = read("server/server.js");
  ok("there is a catch-up route",
    /catch-up\$\//.test(server), "no catch-up route");
  ok("…where sending needs an admin, and looking only needs a login",
    /catchUpMatch[\s\S]{0,800}requireAdmin/.test(server) && /catchUpMatch[\s\S]{0,400}requireUser/.test(server),
    "the catch-up gates are wrong");

  const page = read("server/season-plan.js");
  ok("the panel shows the number owed",
    /Number\(s\.owed\)/.test(page), "the panel can't see what's owed");
  ok("…hides the button when nothing is owed",
    /catchUp\.hidden = owed === 0/.test(page), "the button shows with nothing to send");
  ok("…and asks twice before sending, like every other send here",
    /armTwice\(el\("catchUpBtn"\)/.test(page), "one press would send to real customers");

  ok("the count and the send come from the same rule",
    /summary\.owed \+= owedForBooking\(b\)/.test(src),
    "the status counts owed messages its own way");
}

// ---- 7. The ledger says a resend was a resend -----------------------
{
  const log = read("server/lib/mailer-log.js");
  ok("a ledger entry can record what it was making good",
    /if \(resendOf\) entry\.resendOf/.test(log), "resends are indistinguishable from first sends");
  const customer = read("server/lib/notify-customer.js");
  ok("…and the outreach email carries the record it was about",
    /kind: "outreach", to: toAddr, ok: true, refId/.test(customer),
    "an outreach failure is an address and nothing else");
  const server = read("server/server.js");
  ok("…and the resend names the attempt it is replacing",
    /resendOf: failure\.ts/.test(server), "the resend doesn't say what it was for");
}

if (failures.length) {
  console.error(`\n✗ test-cadence-catch-up: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-cadence-catch-up: ${pass} assertions passed`);

#!/usr/bin/env node
// scripts/test-test-recipient-gate.mjs
//
// Nothing is ever sent to a load-test record.
//
// Patrick, 2026-09-09: "the gate that you may have set up to not send text
// messages to the customers numbers, and emails are still pushing through
// *** this is for the test appointments."
//
// He was right. The suppression that existed lived in ONE place — two call
// sites inside POST /api/booking/reserve — and silenced only the message
// sent at the moment of booking. Everything a test record touched
// afterwards went out normally: reschedules, cancellations, invoices,
// portal replies, quote SMS, review requests, and the assignment blast
// itself. Nineteen Twilio send sites across five files, five separate mail
// transports, one gate on one of them.
//
// The rule now sits where the message LEAVES (lib/test-recipients.js) and
// this suite pins three things about it:
//
//   1. BEHAVIOUR — a marked record's address and number are refused, and a
//      real customer's are not. Driven through the real notifyCustomer()
//      with the transport and `fetch` replaced, so no message can escape
//      even if the gate is broken.
//   2. THE MARKER ALONE DECIDES — suppression must NOT depend on
//      PJL_TEST_KEY. Spec item 8 has Patrick deleting that variable from
//      Render when the load test ends; if suppression hung off it, that
//      deletion would silently start messaging every test record still in
//      the store. The one assertion here that is about a future mistake.
//   3. COVERAGE — every customer-facing transport and every Twilio site is
//      behind the guard. A behaviour test proves the senders that exist; a
//      lint is what covers the one somebody adds next month.
//
// Run: node scripts/test-test-recipient-gate.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const LEADS = path.join(DATA, "leads.json");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const leadsBackup = fs.existsSync(LEADS) ? fs.readFileSync(LEADS) : null;
const realFetch = globalThis.fetch;
const envBackup = {
  key: process.env.PJL_TEST_KEY,
  sid: process.env.TWILIO_ACCOUNT_SID,
  tok: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM_NUMBER
};

// A marked record and a real customer, side by side. The marked one wears
// a REAL-LOOKING number on purpose: that is the case Patrick hit, and a
// fixture with an obviously-fake number would not test anything.
const MARKED = {
  id: "L-TEST-001",
  contact: {
    name: "Test Row 41", email: "loadtest41@example.com", phone: "(905) 555-0141",
    notes: "PJLTEST-041 — 6 zones, back yard gate code 1234"
  },
  booking: { start: "2026-10-06T12:00:00.000Z", end: "2026-10-06T12:30:00.000Z", serviceLabel: "Fall winterization" }
};
const REAL = {
  id: "L-REAL-001",
  contact: {
    name: "A Real Customer", email: "real.customer@example.com", phone: "905-555-0199",
    notes: "gate code 9999"
  },
  booking: { start: "2026-10-06T13:00:00.000Z", end: "2026-10-06T13:30:00.000Z", serviceLabel: "Fall winterization" }
};

try {
  fs.writeFileSync(LEADS, JSON.stringify([MARKED, REAL], null, 2) + "\n", "utf8");
  const testRecipients = require(path.join(ROOT, "server", "lib", "test-recipients.js"));
  testRecipients.resetCache();

  // ---- 1. Who is a test recipient ------------------------------------
  {
    ok("a marked record's email is refused",
      await testRecipients.isTestRecipient({ email: "loadtest41@example.com" }));
    ok("…case and whitespace do not get round it",
      await testRecipients.isTestRecipient({ email: "  LoadTest41@Example.com " }));
    ok("a marked record's number is refused",
      await testRecipients.isTestRecipient({ phone: "(905) 555-0141" }));
    ok("…however it is written",
      (await testRecipients.isTestRecipient({ phone: "+19055550141" }))
      && (await testRecipients.isTestRecipient({ phone: "905-555-0141" })));
    ok("a real customer's email is NOT refused",
      (await testRecipients.isTestRecipient({ email: "real.customer@example.com" })) === false);
    ok("a real customer's number is NOT refused",
      (await testRecipients.isTestRecipient({ phone: "905-555-0199" })) === false);
    ok("an empty recipient is not refused, so nothing legitimate is caught by accident",
      (await testRecipients.isTestRecipient({})) === false
      && (await testRecipients.isTestRecipient({ email: "", phone: "" })) === false);
  }

  // ---- 2. The marker alone decides -----------------------------------
  // The trap this exists to disarm: PJL_TEST_KEY comes OFF Render at the
  // end of the load test (spec item 8). If suppression depended on it,
  // that deletion would start messaging every test record still stored.
  {
    delete process.env.PJL_TEST_KEY;
    testRecipients.resetCache();
    ok("with PJL_TEST_KEY unset, a marked record is still refused",
      await testRecipients.isTestRecipient({ email: "loadtest41@example.com" }));
    ok("…and by phone too",
      await testRecipients.isTestRecipient({ phone: "9055550141" }));
  }

  // ---- 3. The email transport refuses --------------------------------
  {
    const sent = [];
    const fake = { sendMail: async (msg) => { sent.push(msg.to); return { messageId: "real-send" }; } };
    const guarded = testRecipients.guardTransport(fake);

    const blocked = await guarded.sendMail({ to: "loadtest41@example.com", subject: "Your appointment" });
    ok("a marked address gets no email", sent.length === 0, sent.join(", "));
    ok("…and the refusal looks like a skip, not a delivery",
      blocked.messageId === null && blocked.suppressed === true, JSON.stringify(blocked));

    const delivered = await guarded.sendMail({ to: "real.customer@example.com", subject: "Your appointment" });
    ok("a real customer still gets theirs",
      sent.length === 1 && delivered.messageId === "real-send", sent.join(", "));

    await guarded.sendMail({ to: "real.customer@example.com, loadtest41@example.com", subject: "Both" });
    ok("one marked address in a multi-recipient email stops the whole message",
      sent.length === 1, sent.join(" | "));

    ok("wrapping twice does not double-wrap",
      testRecipients.guardTransport(guarded) === guarded && guarded.__pjlTestGuarded === true);
  }

  // ---- 4. End to end, through the real notifier ----------------------
  // notifyCustomer() is what the booking, reschedule and cancel paths all
  // call. Transport and fetch are replaced, so a broken gate shows up as a
  // recorded send rather than as a real message.
  {
    process.env.TWILIO_ACCOUNT_SID = "AC-test";
    process.env.TWILIO_AUTH_TOKEN = "tok-test";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";

    const smsTo = [];
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes("api.twilio.com")) {
        smsTo.push(new URLSearchParams(opts.body || "").get("To"));
        return { ok: true, json: async () => ({ sid: "SM-test" }) };
      }
      return realFetch(url, opts);
    };

    const notify = require(path.join(ROOT, "server", "lib", "notify-customer.js"));
    await notify.notifyCustomer("booked", MARKED);
    ok("notifyCustomer sends a marked record NO text message",
      smsTo.length === 0, smsTo.join(", "));

    await notify.notifyCustomer("booked", REAL);
    ok("…and still texts a real customer",
      smsTo.length === 1 && String(smsTo[0]).replace(/\D+/g, "").endsWith("9055550199"),
      smsTo.join(", "));
  }

  // ---- 5. Coverage: no unguarded way out -----------------------------
  // The behaviour above proves the senders that exist today. This is what
  // covers the one added next month.
  {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

    const server = read("server/server.js");
    const transports = (server.match(/nodemailer\.createTransport\(\{/g) || []).length;
    const wrapped = (server.match(/guardTransport\(transporter\)/g) || []).length;
    ok("every ad-hoc mail transport in server.js is wrapped",
      transports > 0 && wrapped === transports, `${wrapped} guards for ${transports} transports`);

    for (const rel of ["server/lib/notify-customer.js", "server/lib/review-requests.js", "server/lib/notify-warranty.js"]) {
      ok(`${rel.split("/").pop()} builds its transport through the shared guard`,
        /testRecipients\.guardTransport\(nodemailer\.createTransport\(/.test(read(rel)));
      ok(`${rel.split("/").pop()} does not keep its own copy of the wrapper`,
        !/function guardTransport\(/.test(read(rel)));
    }

    // Every Twilio site that can text a customer sits behind a check.
    for (const rel of ["server/lib/notify-customer.js", "server/lib/review-requests.js", "server/server.js"]) {
      const src = read(rel);
      const sites = (src.match(/api\.twilio\.com\/2010/g) || []).length;
      const checks = (src.match(/isTestRecipient\(/g) || []).length;
      ok(`${rel.split("/").pop()} checks before every Twilio send`,
        checks >= sites, `${checks} checks for ${sites} send sites`);
    }

    // The rule has exactly one home.
    const gate = read("server/lib/test-recipients.js");
    ok("the marker comes from the purge module, not a second literal",
      /require\("\.\/purge-test-data"\)/.test(gate) && !/"PJLTEST-"/.test(gate));
    ok("nothing in the gate consults PJL_TEST_KEY",
      !/PJL_TEST_KEY/.test(gate.replace(/\/\/.*$/gm, "")));
  }
} finally {
  globalThis.fetch = realFetch;
  if (leadsBackup === null) fs.rmSync(LEADS, { force: true });
  else fs.writeFileSync(LEADS, leadsBackup);
  for (const [k, v] of Object.entries({
    PJL_TEST_KEY: envBackup.key, TWILIO_ACCOUNT_SID: envBackup.sid,
    TWILIO_AUTH_TOKEN: envBackup.tok, TWILIO_FROM_NUMBER: envBackup.from
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

if (failures.length) {
  console.error(`\n✗ test-test-recipient-gate: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-test-recipient-gate: ${pass} assertions passed`);

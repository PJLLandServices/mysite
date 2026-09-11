#!/usr/bin/env node
// scripts/test-email-resend.mjs
//
// 2026-09-11, ~09:00. Patrick changed his Google account password.
//
// Google revokes every app password on the account when you do that, and
// every outbound email in this system shares one. Within the hour, 56 sends
// had died on `535-5.7.8 Username and Password not accepted` — customer
// cancellation confirmations among them. Nothing retries. Nothing queues.
// The ledger in lib/mailer-log.js was the only evidence those messages had
// ever been attempted.
//
// Patrick: "can we resend those cancelation emails and such?"
//
// Now we can. This suite pins the three things that make that safe:
//
//   1. OUTSTANDING IS NOT THE SAME AS FAILED. A failure that later went
//      through is history. If the worklist can't tell the difference, the
//      resend sends people a second copy of something they already have.
//      The rule is defined once, in the ledger, and both the panel and the
//      resend read it from there.
//
//   2. THE MESSAGE IS REBUILT, NOT REPLAYED. The ledger keeps the fact of
//      an attempt, never its body. So a resend regenerates from the record
//      that still exists — which means it has to check that the record
//      still SAYS that. Re-sending "your appointment is cancelled" to
//      someone whose booking came back to life is worse than the silence.
//
//   3. NOT EVERYTHING MAY BE RESENT. A magic link is a credential with an
//      expiry; re-issuing one because an old send failed hands out a login
//      by way of an error log. A cadence step belongs to the cadence, which
//      already considers it spent. Both are refused by name.
//
// Run: node scripts/test-email-resend.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mailerLog = require(path.join(ROOT, "server", "lib", "mailer-log.js"));

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

// The ledger reads a real file. Point it at a scratch one for the duration
// and put the original back afterwards, whatever happens — this suite must
// never be the reason a send record is lost.
const LEDGER = path.join(ROOT, "server", "data", "email-log.json");
const BACKUP = `${LEDGER}.resend-test-backup`;
let hadLedger = false;

function seed(entries) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(entries, null, 2), "utf8");
}

// Missing entirely is a failure to REPORT, not a crash that hides the rest.
const outstanding = async (opts) => {
  if (typeof mailerLog.outstandingFailures !== "function") return "(outstandingFailures is missing)";
  try { return await mailerLog.outstandingFailures(opts); } catch (err) { return `(threw: ${err.message})`; }
};
const kinds = () => (Array.isArray(mailerLog.RESENDABLE_KINDS) ? mailerLog.RESENDABLE_KINDS : []);

const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

try {
  hadLedger = fs.existsSync(LEDGER);
  if (hadLedger) fs.copyFileSync(LEDGER, BACKUP);

  // ---- 1. The morning itself -----------------------------------------
  {
    seed([
      { ts: ts(400), kind: "lead_alert", to: "p@pjllandservices.com", ok: true, refId: "L-100" },
      { ts: ts(60), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-2026-0119",
        error: "Invalid login: 535-5.7.8 Username and Password not accepted" },
      { ts: ts(58), kind: "booking_cancel", to: "dan@example.ca", ok: false, refId: "BK-2026-0182",
        error: "Invalid login: 535-5.7.8 Username and Password not accepted" },
      { ts: ts(55), kind: "lead_alert", to: "p@pjllandservices.com", ok: false, refId: "L-200",
        error: "Invalid login: 535-5.7.8 Username and Password not accepted" }
    ]);
    const list = await outstanding();
    ok("the messages that never went out are findable at all",
      Array.isArray(list) && list.length === 3, j(list));
    // Seeded 60, 58 and 55 minutes ago, so the lead alert is the newest.
    ok("…newest first, so the freshest damage reads first",
      Array.isArray(list) && list[0]?.refId === "L-200"
      && list[list.length - 1]?.refId === "BK-2026-0119", j(list?.map?.((f) => f.refId)));
    const sophie = Array.isArray(list) ? list.find((f) => f.refId === "BK-2026-0119") : null;
    ok("…carrying the REAL address, because the resend needs it",
      sophie?.to === "sophie@example.com", j(sophie?.to));
    ok("…and the error, so a human can see it was the password and not the address",
      /535-5\.7\.8/.test(sophie?.error || ""), j(sophie?.error));
    ok("…each with a stable name the panel can hand back",
      Array.isArray(list) && list.every((f) => typeof f.id === "string" && f.id.includes(f.kind)), j(list));
  }

  // ---- 2. Outstanding is not the same as failed ----------------------
  //
  // THE ONE THAT MATTERS. Get this wrong and the resend mails a customer a
  // second copy of something they already received.
  {
    seed([
      { ts: ts(120), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" },
      { ts: ts(30), kind: "booking_cancel", to: "sophie@example.com", ok: true, refId: "BK-1" },
      { ts: ts(120), kind: "booking_cancel", to: "dan@example.ca", ok: false, refId: "BK-2", error: "535" }
    ]);
    const list = await outstanding();
    ok("a failure that later went through drops off the worklist",
      Array.isArray(list) && list.length === 1 && list[0].refId === "BK-2", j(list));

    // The other direction: succeeded once, then broke. Still outstanding.
    seed([
      { ts: ts(200), kind: "booking_cancel", to: "sophie@example.com", ok: true, refId: "BK-1" },
      { ts: ts(30), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" }
    ]);
    const later = await outstanding();
    ok("…but an older success doesn't excuse a newer failure",
      Array.isArray(later) && later.length === 1, j(later));
  }

  // ---- 3. Five attempts at one message are one problem ----------------
  {
    seed([
      { ts: ts(90), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" },
      { ts: ts(80), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" },
      { ts: ts(70), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" }
    ]);
    const list = await outstanding();
    ok("repeated attempts at the same message count once",
      Array.isArray(list) && list.length === 1, j(list));
    ok("…and it's the most recent attempt that's kept",
      Array.isArray(list) && list[0]?.ts > ts(75), j(list?.[0]?.ts));
  }

  // ---- 4. Two customers are never one row ----------------------------
  {
    seed([
      { ts: ts(60), kind: "booking_cancel", to: "sophie@example.com", ok: false, refId: "BK-1", error: "535" },
      { ts: ts(59), kind: "booking_cancel", to: "dan@example.ca", ok: false, refId: "BK-2", error: "535" },
      { ts: ts(58), kind: "lead_alert", to: "p@pjllandservices.com", ok: false, refId: "L-1", error: "535" }
    ]);
    const list = await outstanding();
    ok("different customers stay different rows", Array.isArray(list) && list.length === 3, j(list));
  }

  // ---- 5. Old enough is gone ------------------------------------------
  //
  // Nobody wants a "your appointment is cancelled" note about last spring.
  {
    seed([
      { ts: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(),
        kind: "booking_cancel", to: "old@example.com", ok: false, refId: "BK-OLD", error: "535" },
      { ts: ts(10), kind: "booking_cancel", to: "new@example.com", ok: false, refId: "BK-NEW", error: "535" }
    ]);
    const list = await outstanding();
    ok("a months-old failure isn't offered for resend",
      Array.isArray(list) && list.length === 1 && list[0].refId === "BK-NEW", j(list));
    ok("…though the window is a parameter, not a hard-coded month",
      Array.isArray(await outstanding({ sinceMs: 365 * 24 * 3600 * 1000 }))
      && (await outstanding({ sinceMs: 365 * 24 * 3600 * 1000 })).length === 2, "widening the window found nothing more");
  }

  // ---- 6. What may be resent, and what may not ------------------------
  {
    ok("the cancellation note can be rebuilt", kinds().includes("booking_cancel"), j(kinds()));
    ok("so can Patrick's own lead alert", kinds().includes("lead_alert"), j(kinds()));
    // A magic link is a credential. Re-issuing one because an old send
    // failed hands out a login by way of an error log.
    ok("a magic link is NOT resendable — it's a live credential",
      !kinds().includes("magic_link"), j(kinds()));
    // The cadence owns its own steps and already considers this one spent;
    // resending from here would double-message the customer.
    ok("a cadence step is NOT resendable — the cadence owns it",
      !kinds().includes("outreach"), j(kinds()));

    seed([
      { ts: ts(20), kind: "magic_link", to: "sophie@example.com", ok: false, refId: "L-1", error: "535" },
      { ts: ts(19), kind: "outreach", to: "dan@example.ca", ok: false, refId: "P-1", error: "535" },
      { ts: ts(18), kind: "booking_cancel", to: "amy@example.com", ok: false, refId: "BK-9", error: "535" }
    ]);
    const list = await outstanding();
    ok("the ones we can't rebuild are still SHOWN, not hidden",
      Array.isArray(list) && list.length === 3, j(list));
    ok("…each marked for what it is",
      Array.isArray(list)
      && list.find((f) => f.kind === "magic_link")?.resendable === false
      && list.find((f) => f.kind === "outreach")?.resendable === false
      && list.find((f) => f.kind === "booking_cancel")?.resendable === true,
      j(list.map ? list.map((f) => [f.kind, f.resendable]) : list));
  }

  // ---- 7. The wiring --------------------------------------------------
  {
    const server = read("server/server.js");
    ok("there is a resend route at all",
      /pathname === "\/api\/admin\/email-health\/resend"/.test(server), "the route is gone");
    ok("…behind the admin gate, twice over",
      /pathname\.startsWith\("\/api\/admin\/email-health"\)\) return "admin"/.test(server)
      && /email-health\/resend[\s\S]{0,600}requireAdmin/.test(server),
      "the resend isn't admin-gated");
    ok("…driven by ONE table of rebuilders, not a chain of branches",
      /const EMAIL_RESENDERS = \{/.test(server) && /async function resendFailedEmail\(/.test(server),
      "the dispatch table is gone");
    ok("…which refuses a kind it has no rebuilder for",
      /can't be rebuilt automatically/.test(server), "an unknown kind would fall through");
    ok("…and re-reads the worklist server-side instead of trusting the page",
      /const outstanding = await mailerLog\.outstandingFailures\(\);[\s\S]{0,400}targets/.test(server),
      "the resend trusts the browser's list");
    ok("a live booking is never told it was cancelled",
      /bookingHoldsItsSlot\(booking\.status\)[\s\S]{0,200}again/.test(server),
      "the resend would send a cancellation for a live booking");
    ok("the worklist rides on the health response the panel already reads",
      /outstanding\b[\s\S]{0,200}maskRecipient/.test(server), "the panel gets no worklist");
    ok("…masked there, because the page doesn't need the real address",
      /to: mailerLog\.maskRecipient\(f\.to\)/.test(server), "the browser is handed full addresses");

    const panel = read("server/admin.html");
    ok("the panel shows what never went out",
      /id="emailHealthOutstanding"/.test(panel), "no worklist in the panel");
    ok("…with a button per line and one for the lot",
      /class="eh-resend"/.test(panel) && /id="emailHealthResendAll"/.test(panel), "no resend buttons");
    ok("…and asks before sending the lot",
      /window\.confirm\(/.test(panel), "Resend all fires with no confirmation");
  }
} finally {
  if (hadLedger) {
    fs.copyFileSync(BACKUP, LEDGER);
    fs.unlinkSync(BACKUP);
  } else if (fs.existsSync(LEDGER)) {
    fs.unlinkSync(LEDGER);
  }
}

// ---- 10. The two bugs the first live press found ---------------------
//
// Patrick pressed "Resend all" against 55 outstanding rows and, as far as
// the screen was concerned, nothing happened. Two separate defects.
{
  const server = read("server/server.js");

  // BUG 1. Four of those rows were lead_alert with refIds like
  // BK-2026-0131 — BOOKING ids. `sendNewLeadEmail` is the alert channel
  // for more than new leads: the appointment page raises one through it
  // when a customer cancels, passing a synthetic lead whose id is the
  // booking's. Looking only in leads.json answered "that lead no longer
  // exists" for every cancellation alert — the alert most worth getting
  // back — so the resend genuinely sent nothing.
  ok("a lead_alert falls back to the BOOKING when its ref isn't a lead",
    /lead_alert\(failure\)[\s\S]{0,900}await bookings\.get\(failure\.refId\)/.test(server),
    "a lead_alert carrying a booking id still resolves to nothing");
  ok("…rebuilding the alert the booking actually raised",
    /function alertShapeForBooking\(/.test(server), "no rebuilder for a booking-shaped alert");
  ok("…which names the cancellation rather than reading as a new lead",
    /Customer CANCELLED their assigned appointment/.test(server)
    && /alertShapeForBooking[\s\S]{0,700}cancellationReason/.test(server),
    "the rebuilt alert doesn't say what happened");
  ok("…and still refuses when the id matches nothing at all",
    /no lead or booking with that id/.test(server), "a dead ref would pass silently");

  // BUG 2. The result line rendered at the BOTTOM of the box — under all
  // 55 rows, a screen and a half below the button. Pressing Resend all
  // changed nothing you could see.
  const panel = read("server/admin.html");
  const notePos = panel.indexOf('id="emailHealthResendNote"');
  const listPos = panel.indexOf('id="emailHealthOutstanding"');
  ok("the answer sits ABOVE the list, beside the button that causes it",
    notePos > 0 && listPos > 0 && notePos < listPos,
    `note at ${notePos}, list at ${listPos}`);
  ok("…and says something the moment you press, not only when it finishes",
    /note\("Sending…"\)/.test(panel), "the press has no immediate feedback");
  ok("…and reports a run that resent nothing as a problem, not as success",
    /if \(!results\.length\)[\s\S]{0,160}Nothing outstanding to resend/.test(panel),
    "an empty run would read as '0 sent'");
  ok("the button names how many it can actually rebuild",
    /all\.textContent = "Resend " \+ canSend/.test(panel),
    "'Resend all' over 55 rows promises more than it can do");
}

if (failures.length) {
  console.error(`\n✗ test-email-resend: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-email-resend: ${pass} assertions passed`);

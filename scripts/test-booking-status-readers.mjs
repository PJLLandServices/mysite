#!/usr/bin/env node
// scripts/test-booking-status-readers.mjs
//
// Spec §2.8.3: "Grep every reader of booking.status again after these two
// and list them in FLOW_REGISTER." This is that grep, kept.
//
// CLAUDE.md, the lifecycle rule: "Define the rule once, as a named
// function, and call it from each reader. Two copies of a state test will
// drift." A cancelled appointment held its calendar slot for exactly that
// reason — activeBookings() tested the status in its canonical pass and
// not in its lead-snapshot pass. test-booking-lifecycle.mjs pins the
// BEHAVIOUR that came out of that. This suite pins the SHAPE: that no
// reader has quietly written the dead-status list out by hand again.
//
// The rule lives in lib/bookings.js as DEAD_STATUSES + holdsItsSlot(),
// and server.js reaches it through bookingHoldsItsSlot(). A reader asking
// "is this booking still live?" must go through one of those. Two did not
// and were fixed on 2026-09-09:
//
//   • the change-service-type guard spelled out all three dead states
//     inline — a literal second copy;
//   • the appointment .ics route asked `status !== "confirmed"`, which is
//     narrower than the rule: `tentative` is LIVE in the vocabulary, so a
//     hand-set tentative appointment was refused its own calendar file.
//
// NOT every mention of a status is a copy of the rule, and this suite must
// not pretend otherwise. Two readers legitimately name single states and
// are allow-listed below WITH the reason, because a lint whose exceptions
// are unexplained is a lint people switch off.
//
// Run: node scripts/test-booking-status-readers.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bookings = require(path.join(ROOT, "server", "lib", "bookings.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. The rule itself ---------------------------------------------
{
  ok("lib/bookings.js owns the dead-status set",
    bookings.DEAD_STATUSES instanceof Set && bookings.DEAD_STATUSES.size === 3,
    JSON.stringify([...(bookings.DEAD_STATUSES || [])]));
  ok("…and it is exactly cancelled / completed / no_show",
    ["cancelled", "completed", "no_show"].every((s) => bookings.DEAD_STATUSES.has(s)),
    [...bookings.DEAD_STATUSES].join(", "));
  ok("holdsItsSlot answers false for every dead state",
    [...bookings.DEAD_STATUSES].every((s) => bookings.holdsItsSlot(s) === false));
  ok("…and true for the live ones, tentative included",
    bookings.holdsItsSlot("confirmed") === true && bookings.holdsItsSlot("tentative") === true);
  ok("…treating an absent status as live, the way an old lead reads",
    bookings.holdsItsSlot(undefined) === true && bookings.holdsItsSlot("") === true);
  ok("…and it is case-insensitive, so a hand-edited record cannot slip past",
    bookings.holdsItsSlot("Cancelled") === false && bookings.holdsItsSlot("NO_SHOW") === false);
}

// ---- 2. No reader writes the list out by hand ------------------------
// A line that tests a BOOKING's status against the dead states is asking
// the liveness question the long way. Restricted to booking-shaped
// receivers on purpose: work orders, review requests and projects have
// their own "completed", and a lint that cannot tell them apart is a lint
// that gets switched off.
{
  const files = [
    "server/server.js",
    "server/schedule.js",
    "server/admin.js",
    ...fs.readdirSync(path.join(ROOT, "server", "lib"))
      .filter((f) => f.endsWith(".js") && f !== "bookings.js")
      .map((f) => `server/lib/${f}`)
  ].filter((f) => fs.existsSync(path.join(ROOT, f)));

  // Receivers that hold a booking record. `w`/`wo`/`r`/`patch`/`updated`
  // are deliberately absent — those are other vocabularies.
  // "completed" or "no_show" on a booking receiver is the signature of
  // someone enumerating the dead set. A lone `=== "cancelled"` is NOT:
  // that is a narrower question ("was this specifically cancelled?") and
  // several readers ask it on purpose.
  const BOOKING_RECEIVER = /\b(booking|bookingRec|b|rec|candidate|exact)\s*(\?)?\.status\s*[!=]==?\s*"(completed|no_show)"/;

  // Readers that name states for a reason that is NOT the liveness rule.
  // Each carries its reason. This list is meant to stay short and to be
  // read, not grown.
  const ALLOWED = new Map([
    // Tells the CUSTOMER which sentence to show on their appointment page.
    // "cancelled" and "completed" are two different messages; the liveness
    // rule collapses them into one and so cannot answer this.
    ["server/lib/appointment-actions.js",
      "distinguishes cancelled from completed for the customer's own page"],
    // Asks "has this property been serviced or booked this season?", not
    // "does this hold a slot". A COMPLETED booking means the customer HAS
    // been served, so outreach must not chase them — excluding it here
    // would start chasing serviced customers.
    ["server/lib/outreach.js",
      "seasonal outreach eligibility, deliberately counts completed as served"],
    // The admin calendar KEEPS cancelled rows so it can draw them struck
    // through, and drops the two that are simply not on the day.
    ["server/schedule.js",
      "calendar display: cancelled is rendered, not filtered"],
    // Browser-side CRM. It cannot require server/lib/bookings.js; the
    // server re-checks on every route it calls, so this copy decides a
    // link target, never an outcome.
    ["server/admin.js",
      "client-side; the server re-checks the same rule on the route it calls"]
  ]);

  // A LINE may also opt out, which server.js needs: it is far too big to
  // exempt wholesale, and it holds one reader that legitimately names a
  // single state AFTER asking the shared rule — /api/schedule/today's
  // "what came off today" list, where `completed` means finished rather
  // than removed. The marker sits on the line itself rather than in a
  // list over here, so the reason travels with the code and a new
  // exception has to be written on purpose.
  const EXEMPT_LINE = /\/\/.*\bnot-liveness:/;

  const offenders = [];
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!BOOKING_RECEIVER.test(code)) return;
      // The marker may sit on the line or in the comment block directly
      // above it — a one-line reason is rarely a real one.
      const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      if (EXEMPT_LINE.test(window)) return;
      offenders.push(`${rel}:${i + 1} ${code.trim().slice(0, 90)}`);
    });
  }
  ok("no server-side reader spells out the dead-status list instead of asking the rule",
    offenders.length === 0, offenders.join(" | "));
  // An exempt LINE only narrows an answer the shared rule already gave,
  // so each one must sit within a few lines of a bookingHoldsItsSlot()
  // call. A marker on a line that asks the question by itself is the
  // copy this suite exists to catch, wearing a permission slip.
  {
    const bad = [];
    for (const rel of files) {
      if (ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!EXEMPT_LINE.test(line)) return;
        const near = lines.slice(Math.max(0, i - 8), i + 6).join("\n");
        if (!near.includes("bookingHoldsItsSlot(")) bad.push(`${rel}:${i + 1}`);
      });
    }
    ok("every exempt line still asks the shared rule first",
      bad.length === 0, bad.join(", "));
  }

  ok("every allow-listed exception still carries its reason",
    [...ALLOWED.values()].every((why) => typeof why === "string" && why.length > 30),
    [...ALLOWED.keys()].join(", "));
}

// ---- 3. The readers that decide whether a booking is live ------------
// Named individually, so that if one is deleted or renamed this suite
// says so rather than silently covering five call sites instead of six.
{
  const server = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const calls = (server.match(/bookingHoldsItsSlot\(/g) || []).length;
  ok("server.js still routes its liveness questions through one wrapper",
    calls >= 9, `${calls} references (definition + call sites)`);

  const expected = [
    // The capacity readers, both passes — the original defect.
    "if (!bookingHoldsItsSlot(l.booking.status)) return false;",
    "&& bookingHoldsItsSlot(lead.booking.status))",
    "if (!bookingHoldsItsSlot(b.status)) continue;",
    // The tech's day list, lead pass AND canonical pass (spec §2.8.2, D7).
    "if (!bookingHoldsItsSlot(lead.booking?.status)) return false;",
    "if (!bookingHoldsItsSlot(b.status)) return false;",
    // The five routed through the rule on 2026-09-09.
    "if (!bookingHoldsItsSlot(booking.status)) {",
    "if (!booking || !bookingHoldsItsSlot(booking.status)) {",
    "recs.filter((b) => bookingHoldsItsSlot(b.status));",
    "if (!bookingHoldsItsSlot(bookingRec.status)) {"
  ];
  for (const snippet of expected) {
    ok(`the reader is still on the shared rule: ${snippet.slice(0, 52)}…`,
      server.includes(snippet));
  }

  ok("the wrapper delegates to lib/bookings.js rather than re-defining the set",
    /function bookingHoldsItsSlot\(status\) \{\s*return bookings\.holdsItsSlot\(status\);\s*\}/.test(server));
}

if (failures.length) {
  console.error(`\n✗ test-booking-status-readers: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-booking-status-readers: ${pass} assertions passed`);

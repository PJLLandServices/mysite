#!/usr/bin/env node
// scripts/test-customer-state.mjs
//
// Two changes Patrick asked for the morning after the first assignment
// blast went out (2026-09-11), pinned together because they are the same
// defect seen from two sides: the system knew things about the customer it
// was not showing anyone.
//
// 1. "People came back canceled. We need to prompt them to request why?"
//    The cancel panel had a free-text box labelled "Anything we should
//    know? (optional)". Nobody typed in it. Every cancellation arrived as
//    a bare fact with no reason attached, so there was no way to tell "I
//    already had it done" from "I've gone to someone else" — and those two
//    call for opposite things next February.
//
// 2. "the bookings page shows 'confirmed' but i'd like to see it maybe
//    just say 'sent' first, and then once the customer clicks confirm then
//    it flicks over to confirm."
//    An assignment booking is `confirmed` the moment Patrick books it,
//    because the truck is coming. The customer's acknowledgement is a
//    DIFFERENT question and was never shown.
//
// THE TRAP THIS SUITE EXISTS TO GUARD. The obvious fix for (2) is to add a
// "sent" status. That would be a disaster: `cadenceBookings` selects
// `status === "confirmed"`, so follow-up steps 2-6 would stop dead for
// every customer in the campaign, silently. The fix derives the customer's
// state from the outreach record instead and leaves `status` alone — and
// the assertions below pin that it stays alone.
//
// THE SECOND TRAP. The customer's reason code reaches `bookings.cancel()`,
// which resolves the booking's STATUS from it — and it shares that lookup
// with the TECH vocabulary, where `no_answer` resolves to `no_show`. A
// no-show is a chargeable fact about a visit that happened. A customer's
// phone must never be able to post one about its own booking.
//
// Run: node scripts/test-customer-state.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bookings = require(path.join(ROOT, "server", "lib", "bookings.js"));
const appointmentActions = require(path.join(ROOT, "server", "lib", "appointment-actions.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 200) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};
// Missing entirely is a failure to REPORT, not a crash that hides every
// assertion behind it.
const label = (booking) => {
  if (typeof bookings.customerStateLabel !== "function") return "(customerStateLabel is missing)";
  try { return bookings.customerStateLabel(booking); } catch (err) { return `(threw: ${err.message})`; }
};
const state = (booking) => {
  if (typeof bookings.customerState !== "function") return "(customerState is missing)";
  try { return bookings.customerState(booking); } catch (err) { return `(threw: ${err.message})`; }
};

// Same reason: a vocabulary that isn't there yet must fail the assertion
// that wants it, not take the suite down with it.
const isCustomerReason = (code) => (typeof bookings.isCustomerCancelReason === "function"
  ? bookings.isCustomerCancelReason(code)
  : "(isCustomerCancelReason is missing)");
const outcomeOf = (code) => (typeof bookings.removalOutcome === "function"
  ? bookings.removalOutcome(code)
  : "(removalOutcome is missing)");

const assigned = (outreach, over = {}) => ({
  id: "BK-STATE-PROBE",
  source: "assignment",
  status: "confirmed",
  assignment: { season: "fall", year: 2026, code: "P-001", ...(outreach ? { outreach } : {}) },
  ...over
});

// ---- 1. The customer's state is a different answer from `status` ------
{
  ok("booked by Patrick, not yet messaged → Assigned",
    label(assigned(null)) === "Assigned", label(assigned(null)));

  const sent = assigned({ steps: { "1": { at: "2026-09-10T12:00:00Z" } } });
  ok("messaged, no reply yet → Sent (the whole ask)",
    label(sent) === "Sent", label(sent));
  ok("…and the state code behind the word is the one the pill's class uses",
    state(sent) === "sent", j(state(sent)));
  ok("…and the booking is STILL `confirmed` underneath",
    sent.status === "confirmed" && bookings.holdsItsSlot(sent.status), j(sent.status));

  const opened = assigned({ steps: { "1": { at: "x" } }, seenAt: "2026-09-10T13:00:00Z" });
  ok("opened the link but hasn't answered → still Sent",
    label(opened) === "Sent", label(opened));

  const confirmed = assigned({
    steps: { "1": { at: "x" } }, respondedAt: "2026-09-10T14:00:00Z", responseVia: "confirm"
  });
  ok("tapped confirm → flicks over to Confirmed",
    label(confirmed) === "Confirmed", label(confirmed));
}

// ---- 2. Every way a customer can answer has its own word --------------
{
  const via = (responseVia) => label(assigned({
    steps: { "1": { at: "x" } }, respondedAt: "2026-09-10T14:00:00Z", responseVia
  }));
  ok("picked a different day → Moved", via("reschedule") === "Moved", via("reschedule"));
  ok("asked for a time window → Time requested", via("window") === "Time requested", via("window"));
  ok("joined the free bucket → Any time", via("free_bucket") === "Any time", via("free_bucket"));
  // A reply we don't have a word for still reads as an acknowledgement,
  // because the fact that matters ("they answered") is true either way.
  ok("an unknown reply still counts as answered", via("shrug") === "Confirmed", via("shrug"));
}

// ---- 3. A customer who booked THEMSELVES already said yes -------------
{
  const selfBooked = { id: "BK-SELF", source: "portal", status: "confirmed" };
  ok("a self-booked appointment reads Booked, not Assigned",
    label(selfBooked) === "Booked", label(selfBooked));
  ok("…and one with no source at all doesn't invent a campaign",
    label({ id: "BK-OLD", status: "confirmed" }) === "Booked", label({ id: "BK-OLD", status: "confirmed" }));
  ok("no booking at all answers rather than throwing", label(null) === "Booked", label(null));
}

// ---- 4. A dead booking's own state is the whole answer ----------------
//
// What they did about it before it died is history. The lifecycle word
// wins, for every dead state, in the one place the rule is defined.
{
  for (const [status, word] of [["cancelled", "Cancelled"], ["completed", "Completed"], ["no_show", "No-show"]]) {
    const dead = assigned({ steps: { "1": { at: "x" } }, respondedAt: "x", responseVia: "confirm" }, { status });
    ok(`a ${status} booking reads ${word}, not its old reply`, label(dead) === word, label(dead));
    ok(`…and ${status} is still a dead status to the engine`,
      bookings.holdsItsSlot(status) === false, j(status));
  }
}

// ---- 5. The rule has ONE definition -----------------------------------
//
// CLAUDE.md: two copies of a state test drift. The page must not carry its
// own copy — the server stamps the answer onto the record it sends.
{
  const server = read("server/server.js");
  ok("server.js has a single named helper for it",
    /function withCustomerState\(/.test(server), "withCustomerState is gone");
  ok("…and the bookings list sends the state with every record",
    /bookings: all\.map\(withCustomerState\)/.test(server), "the list route stopped stamping it");
  ok("…as does a single booking",
    /booking: withCustomerState\(b\)/.test(server), "the detail route stopped stamping it");

  const page = read("server/bookings.js");
  ok("the bookings page renders the stamped label",
    /badgeLabel\(b\)/.test(page) && /customerStateLabel \|\|/.test(page),
    "the page went back to deriving its own");
}

// ---- 6. The badge on the bookings page --------------------------------
//
// Lifted out of the page and run against plain objects — the same trick
// test-app-shell uses. If the page stops answering these, the build says
// so before Patrick does.
{
  const src = read("server/bookings.js");
  const grab = (name) => {
    const m = src.match(new RegExp("function " + name + "\\(b\\) \\{[\\s\\S]*?\\n\\}"));
    return m ? m[0] : "";
  };
  const statusHelper = src.match(/function statusBadgeLabel\(status\) \{[\s\S]*?\n\}/);
  let badgeLabel = null;
  let badgeState = null;
  try {
    const built = new Function(`
      ${statusHelper ? statusHelper[0] : "function statusBadgeLabel(s){ return s; }"}
      ${grab("badgeLabel")}
      ${grab("badgeState")}
      return { badgeLabel, badgeState };
    `)();
    badgeLabel = built.badgeLabel;
    badgeState = built.badgeState;
  } catch (err) {
    // Absent means every assertion below fails with a reason.
    badgeLabel = () => `(page helpers missing: ${err.message})`;
    badgeState = () => "(missing)";
  }
  const record = { status: "confirmed", customerState: "sent", customerStateLabel: "Sent" };
  ok("the badge shows the customer's word, not the engine's",
    badgeLabel(record) === "Sent", String(badgeLabel(record)));
  ok("…and the pill's class follows it, so it can be coloured apart",
    badgeState(record) === "sent", String(badgeState(record)));
  // A record from before this change, or from anywhere that doesn't stamp
  // the field, still gets a badge rather than a blank pill.
  ok("a record with no stamped state falls back to its status",
    badgeLabel({ status: "cancelled" }) === "Cancelled", String(badgeLabel({ status: "cancelled" })));
  ok("…and an empty record still says something",
    badgeLabel({}) === "Confirmed", String(badgeLabel({})));

  const css = read("server/bookings.css");
  ok("the Sent pill has a colour of its own",
    /\.bk-card__status--sent\b/.test(css), "no --sent rule in bookings.css");
}

// ---- 7. The cancel panel asks WHY -------------------------------------
{
  const list = typeof bookings.customerCancelReasonList === "function"
    ? bookings.customerCancelReasonList() : [];
  ok("there is a reason list to offer", list.length >= 4, j(list));
  ok("…every entry has a code and words a customer would recognise",
    list.length > 0 && list.every((r) => r && r.code && typeof r.label === "string" && r.label.length > 3),
    j(list));
  const codes = list.map((r) => r.code);
  for (const code of ["already_done", "another_company", "selling", "not_this_year", "other"]) {
    ok(`"${code}" is one of the choices`, codes.includes(code), j(codes));
  }
  ok("…including an escape hatch, so nobody is trapped by the list",
    codes.includes("other"), j(codes));

  ok("the reasons ride on the appointment summary, not in the page",
    Array.isArray(appointmentActions.summarize({
      customerName: "Test", scheduledFor: new Date(Date.now() + 7 * 864e5).toISOString(), status: "confirmed"
    })?.cancelReasons), "summarize() carries no cancelReasons");

  const html = read("server/appointment.html");
  ok("the panel has somewhere to render them",
    /id="cancelReasons"/.test(html), "#cancelReasons is missing");
  ok("…and 'Yes, cancel it' starts disabled, so the ask isn't skippable",
    /id="cancelConfirm"[^>]*\bdisabled\b/.test(html), "the confirm button is live before a reason is picked");
  ok("…with a way out for someone whose DAY is the problem, not the service",
    /id="cancelToReschedule"/.test(html), "no reschedule deflection in the cancel panel");

  const js = read("server/appointment.js");
  ok("the page sends the code it collected",
    /post\("\/cancel", \{ reasonCode: cancelReasonCode/.test(js), "the cancel POST carries no reasonCode");
  ok("…and refuses to send without one",
    /if \(!cancelReasonCode\) return;/.test(js), "the page will still cancel with no reason");
}

// ---- 8. The reason reaches the record, and the alert -------------------
{
  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  const booking = {
    id: "BK-CANCEL-PROBE", source: "assignment", status: "confirmed",
    customerName: "Dale Probe", scheduledFor: future,
    assignment: { season: "fall", year: 2026, code: "P-001",
      outreach: { token: "tok-cancel-probe-0001", steps: { "1": { at: "x" } } } }
  };
  const run = async (payload) => {
    const seen = {};
    const result = await appointmentActions.cancel("tok-cancel-probe-0001", {
      ...payload,
      listBookings: async () => [booking],
      markResponded: async () => booking,
      cancelBooking: async (id, opts) => {
        Object.assign(seen, opts);
        return { ok: true, booking: { ...booking, status: "cancelled" } };
      }
    });
    return { result, seen };
  };

  const tapped = await run({ reasonCode: "another_company" });
  ok("the tapped reason reaches the booking record",
    tapped.seen.reasonCode === "another_company", j(tapped.seen));
  ok("…as words a human can read, not just a code",
    String(tapped.seen.reason || "").includes("another company"), j(tapped.seen.reason));
  ok("…and comes back for Patrick's alert to use",
    tapped.result.reasonLabel === "I'm using another company", j(tapped.result.reasonLabel));

  const both = await run({ reasonCode: "selling", reason: "closing Oct 3" });
  ok("anything they typed rides along with the reason they tapped",
    String(both.seen.reason).includes("selling") && String(both.seen.reason).includes("closing Oct 3"),
    j(both.seen.reason));

  const bare = await run({});
  ok("a cancellation with no reason still goes through",
    bare.result.ok === true && bare.seen.reasonCode === "", j(bare.seen));
  ok("…and says where it came from",
    String(bare.seen.reason).includes("appointment page"), j(bare.seen.reason));
}

// ---- 9. A phone cannot mark its own booking a no-show -----------------
//
// THE SHARP EDGE. `bookings.cancel()` resolves the status from the reason
// code, and the tech vocabulary it shares that lookup with contains
// `no_answer` → `no_show`. Only the customer vocabulary may get through.
{
  ok("the tech's codes are not customer codes",
    isCustomerReason("no_answer") === false && isCustomerReason("no_access") === false,
    "a tech code passes the customer check");
  ok("…and `no_answer` really would resolve to a no-show if it got through",
    outcomeOf("no_answer") === "no_show", j(outcomeOf("no_answer")));

  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  const booking = {
    id: "BK-NOSHOW-PROBE", source: "assignment", status: "confirmed",
    customerName: "Dale Probe", scheduledFor: future,
    assignment: { season: "fall", year: 2026, code: "P-002",
      outreach: { token: "tok-noshow-probe-0001", steps: { "1": { at: "x" } } } }
  };
  let seen = {};
  await appointmentActions.cancel("tok-noshow-probe-0001", {
    reasonCode: "no_answer",
    listBookings: async () => [booking],
    markResponded: async () => booking,
    cancelBooking: async (id, opts) => { seen = opts; return { ok: true, booking }; }
  });
  ok("a tech code posted from the appointment page is dropped",
    seen.reasonCode === "", j(seen));
  ok("…so the booking is cancelled, never marked a no-show",
    outcomeOf(seen.reasonCode) === "cancelled", j(seen.reasonCode));

  // Same door, garbage instead of a real code.
  let seen2 = {};
  await appointmentActions.cancel("tok-noshow-probe-0001", {
    reasonCode: { toString: () => "no_answer" },
    listBookings: async () => [booking],
    markResponded: async () => booking,
    cancelBooking: async (id, opts) => { seen2 = opts; return { ok: true, booking }; }
  });
  ok("…and so is anything that isn't a plain known code",
    seen2.reasonCode === "", j(seen2.reasonCode));
}

// ---- 10. The cadence still selects the customers it has to ------------
//
// The whole reason `status` was left alone. If this ever fails, follow-up
// steps 2-6 have stopped for the entire campaign.
{
  const cadenceSrc = read("server/lib/assignment-cadence.js");
  ok("the cadence still picks up confirmed assignment bookings",
    /status === "confirmed"/.test(cadenceSrc), "cadenceBookings no longer selects on `confirmed`");
  ok("…and `confirmed` is still a live status in the vocabulary",
    bookings.holdsItsSlot("confirmed") === true, "confirmed stopped holding its slot");
  ok("…and STATUSES gained no display-only member",
    Object.keys(bookings.STATUSES || {}).includes("sent") === false, j(Object.keys(bookings.STATUSES || {})));
}

if (failures.length) {
  console.error(`\n✗ test-customer-state: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-customer-state: ${pass} assertions passed`);

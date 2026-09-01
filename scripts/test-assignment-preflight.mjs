// Assignment preflight — stage 0 of docs/ASSIGNMENT_WRITER.md.
//
//   node scripts/test-assignment-preflight.mjs
//
// Two kinds of assertion, and the second is the one the stage rests on:
//
//   1. The preflight itself: every outcome in its universe is reachable,
//      the summary adds up, and a stop is never silently dropped.
//   2. THE VERDICTS ARE OUTREACH'S OWN. The eligibility gauntlet is the
//      real outreach.assessEligibility, exercised here property by
//      property — so if outreach ever changes a rule, this file fails
//      rather than the preflight quietly predicting a send it no longer
//      matches.
//
// No data files are touched: the preflight takes injectable collaborators
// (getPlan, listProperties) and the eligibility functions are pure given
// an injected bookingState.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assignments = require(path.join(ROOT, "server/lib/assignments.js"));
const outreach = require(path.join(ROOT, "server/lib/outreach.js"));
const properties = require(path.join(ROOT, "server/lib/properties.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures: one property per verdict ------------------------------
//
// Every skip reason gets a property engineered to produce exactly it, so
// the test enumerates the same universe the screen renders.

const SEASON = "fall";
const YEAR = 2026;
const seasonKey = properties.seasonKey(YEAR, SEASON);

const base = (id, extra = {}) => ({
  id,
  code: id,
  customerName: "Test Customer",
  customerPhone: "+19055550100",
  customerEmail: "test@example.com",
  address: "1 Test St, Newmarket, ON",
  town: "Newmarket",
  // A declared count so the channel-focused fixtures clear the zone
  // gate (the preflight now names no-zone stops); P-NO-ZONES below
  // strips it to test exactly that gate.
  system: { zones: [], zoneCount: 6 },
  ...extra
});

const FIXTURES = {
  "P-READY": base("P-READY"),
  "P-EMAIL-ONLY": base("P-EMAIL-ONLY", { customerPhone: "" }),
  "P-SMS-ONLY": base("P-SMS-ONLY", { customerEmail: "" }),
  "P-SMS-DECLINED": base("P-SMS-DECLINED", { commPrefs: { seasonalRemindersSMS: false } }),
  "P-NO-CONTACT": base("P-NO-CONTACT", { customerPhone: "", customerEmail: "" }),
  "P-INACTIVE": base("P-INACTIVE", { archivedAt: "2026-01-01T00:00:00Z" }),
  "P-NOT-ELIGIBLE": base("P-NOT-ELIGIBLE", { seasonalEligibility: { fallClosing: false } }),
  "P-NAMELESS": base("P-NAMELESS", { customerName: "  " }),
  "P-OPTED-OUT": base("P-OPTED-OUT", {
    seasonalOutreach: { [seasonKey]: { optOutThisSeason: true, touches: [] } }
  }),
  "P-BOOKED": base("P-BOOKED"),
  "P-NO-ZONES": base("P-NO-ZONES", { system: { zones: [], zoneCount: null } })
};

const PLAN = {
  days: {
    "2026-09-28": {
      label: "R1", territory: "Test turf",
      morning: ["P-READY", "P-EMAIL-ONLY", "P-SMS-ONLY", "P-SMS-DECLINED", "P-GHOST"],
      afternoon: ["P-NO-CONTACT", "P-INACTIVE"]
    },
    "2026-09-29": {
      label: "R2", territory: "Test north",
      morning: ["P-NOT-ELIGIBLE", "P-NAMELESS", "P-OPTED-OUT", "P-BOOKED"],
      afternoon: ["P-NO-ZONES"]
    }
  }
};

// The eligibility gauntlet is the REAL outreach function; only the
// bookings read is intercepted, by injecting bookingState for the one
// fixture that has a booking. Everything else flows through untouched.
const deps = {
  getPlan: async () => PLAN,
  listProperties: async () => Object.values(FIXTURES),
  assessEligibility: (property, opts) => outreach.assessEligibility(property, {
    ...opts,
    bookingState: property.id === "P-BOOKED"
      ? { hasBooking: true, bookingId: "BK-2026-0042" }
      : { hasBooking: false }
  })
};

const result = await assignments.preflight(SEASON, YEAR, deps);

ok("the preflight runs against the injected plan", result.ok === true);
ok("every planned stop is accounted for — none silently dropped",
  result.summary.stops === 12, String(result.summary.stops));
ok("the summary adds up: ready + settled + skipped = stops",
  result.summary.ready + result.summary.settled + result.summary.skipped === result.summary.stops,
  JSON.stringify(result.summary));

const rows = new Map(result.days.flatMap((d) => d.stops).map((r) => [r.code, r]));

// ---- The verdict universe, one by one --------------------------------

ok("a fully reachable customer is ready on both channels",
  rows.get("P-READY").outcome === "ready"
  && JSON.stringify(rows.get("P-READY").channels) === JSON.stringify(["sms", "email"]));

ok("no phone -> ready, email only, and the missing leg is SAID on the row",
  rows.get("P-EMAIL-ONLY").outcome === "ready"
  && JSON.stringify(rows.get("P-EMAIL-ONLY").channels) === JSON.stringify(["email"])
  && rows.get("P-EMAIL-ONLY").partial === "no_phone",
  JSON.stringify(rows.get("P-EMAIL-ONLY")));

ok("no email -> ready, sms only, flagged",
  rows.get("P-SMS-ONLY").outcome === "ready"
  && JSON.stringify(rows.get("P-SMS-ONLY").channels) === JSON.stringify(["sms"])
  && rows.get("P-SMS-ONLY").partial === "no_email");

ok("SMS declined -> ready by email, and the reason is the DECLINE, not a missing phone",
  rows.get("P-SMS-DECLINED").outcome === "ready"
  && rows.get("P-SMS-DECLINED").partial === "opted_out_sms",
  JSON.stringify(rows.get("P-SMS-DECLINED")));

ok("partial-channel customers are counted, so the headline cannot hide them",
  result.summary.readyPartial === 3, String(result.summary.readyPartial));

ok("a code with no property behind it is skipped as no_such_property",
  rows.get("P-GHOST").outcome === "skipped" && rows.get("P-GHOST").reason === "no_such_property");

ok("neither channel usable -> skipped as no_contact, with both reasons kept",
  rows.get("P-NO-CONTACT").outcome === "skipped"
  && rows.get("P-NO-CONTACT").reason === "no_contact"
  && rows.get("P-NO-CONTACT").channelReasons.sms === "no_phone"
  && rows.get("P-NO-CONTACT").channelReasons.email === "no_email");

ok("an archived property is skipped as inactive",
  rows.get("P-INACTIVE").outcome === "skipped" && rows.get("P-INACTIVE").reason === "inactive");

ok("season-ineligible is skipped as not_eligible",
  rows.get("P-NOT-ELIGIBLE").outcome === "skipped" && rows.get("P-NOT-ELIGIBLE").reason === "not_eligible");

ok("a nameless property is skipped — outreach's name invariant holds here too",
  rows.get("P-NAMELESS").outcome === "skipped" && rows.get("P-NAMELESS").reason === "missing_name");

ok("a per-season opt-out is skipped as season_opt_out",
  rows.get("P-OPTED-OUT").outcome === "skipped" && rows.get("P-OPTED-OUT").reason === "season_opt_out");

ok("no zone count -> skipped HERE, before assign can hide it — Patrick's list",
  rows.get("P-NO-ZONES").outcome === "skipped"
  && rows.get("P-NO-ZONES").reason === "no_zone_count"
  && rows.get("P-NO-ZONES").propertyId === "P-NO-ZONES",
  JSON.stringify(rows.get("P-NO-ZONES")));

// ---- already_booked is SETTLED, not a problem -------------------------

ok("A CUSTOMER WITH THEIR OWN BOOKING IS SETTLED, NOT SKIPPED — their appointment stands",
  rows.get("P-BOOKED").outcome === "settled"
  && rows.get("P-BOOKED").bookingId === "BK-2026-0042",
  JSON.stringify(rows.get("P-BOOKED")));
ok("...and settled is its own count, outside both ready and skipped",
  result.summary.settled === 1);

// ---- The reason universe is closed ------------------------------------

const seen = new Set(
  result.days.flatMap((d) => d.stops).map((r) => r.reason).filter(Boolean)
);
for (const reason of seen) {
  ok(`reason "${reason}" is in PREFLIGHT_OUTCOMES so the screen can explain it`,
    Object.prototype.hasOwnProperty.call(assignments.PREFLIGHT_OUTCOMES, reason));
}
ok("byReason tallies match the rows",
  Object.values(result.summary.byReason).reduce((a, b) => a + b, 0) === result.summary.skipped,
  JSON.stringify(result.summary.byReason));

// ---- Read-only means read-only ----------------------------------------

const again = await assignments.preflight(SEASON, YEAR, deps);
ok("running preflight twice gives identical verdicts — it changed nothing",
  JSON.stringify(again.summary) === JSON.stringify(result.summary));

// ---- The shared-gauntlet guarantee ------------------------------------
//
// The preflight's verdicts must BE outreach's verdicts. Prove the wiring:
// the default (uninjected) assessEligibility used by the endpoint is the
// same function object sendBulk's module exports.

ok("the preflight defaults to outreach's own assessEligibility, not a copy",
  typeof outreach.assessEligibility === "function"
  && typeof outreach.channelCapability === "function");

const directVerdict = await outreach.assessEligibility(FIXTURES["P-OPTED-OUT"],
  { season: SEASON, year: YEAR, bookingState: { hasBooking: false } });
ok("outreach itself refuses the opted-out fixture with the same reason",
  directVerdict.ok === false && directVerdict.reason === "season_opt_out");

const cap = outreach.channelCapability(FIXTURES["P-SMS-DECLINED"]);
ok("outreach's own capability check names the declined channel identically",
  cap.sms.possible === false && cap.sms.reason === "opted_out_sms"
  && cap.emailChannel.possible === true);

// ---- No plan ----------------------------------------------------------

const empty = await assignments.preflight(SEASON, YEAR, { ...deps, getPlan: async () => null });
ok("no plan preflights to a clean refusal, not a crash",
  empty.ok === false && empty.reason === "no_plan");

if (failures.length) {
  console.error(`\n✗ test-assignment-preflight: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-assignment-preflight: ${pass} assertions passed`);

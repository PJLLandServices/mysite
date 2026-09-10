// The job finder — "why isn't this customer on the schedule?"
//
//   node scripts/test-job-finder.mjs
//
// WHAT THIS PROTECTS. After three real fixes, the Willowridge symptom
// was still alive because nobody could SEE which store the records were
// in or why the day filter refused them. findJobs is the lantern: it
// searches every store a date can live in and issues one plain-English
// verdict per record. This suite pins the verdicts — right store, right
// day math (including the date-only local-midnight rule), records found
// BY PROPERTY LINK when their own name field is blank, and plan stops
// that were never booked saying exactly that.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { findJobs } = require("../server/lib/job-finder.js");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const DAY = "2026-10-02";
const stores = {
  properties: [
    { id: "P-W1", code: "P-W1", customerId: "cus_willow", customerName: "Willowridge Landscaping",
      address: "400 Ridge Rd, Aurora, ON", town: "Aurora" },
    { id: "P-W2", code: "P-W2", customerId: "cus_willow", customerName: "Willowridge Landscaping",
      address: "88 Crest Blvd, Aurora, ON", town: "Aurora" },
    { id: "P-X", code: "P-X", customerName: "Somebody Else", address: "1 Other St, Barrie, ON" }
  ],
  workOrders: [
    // The classic: raised against the property, name field left blank.
    { id: "WO-1", propertyId: "P-W1", customerName: "", address: "400 Ridge Rd, Aurora, ON",
      type: "fall_closing", status: "scheduled", scheduledFor: "2026-10-02T13:00:00.000Z" },
    // Date-only value — must count as LOCAL Oct 2, not UTC (Oct 1 evening).
    { id: "WO-2", propertyId: "P-W2", customerName: "Willowridge Landscaping",
      type: "fall_closing", status: "scheduled", scheduledFor: "2026-10-02" },
    { id: "WO-3", propertyId: "P-W1", customerName: "", type: "fall_closing",
      status: "scheduled", scheduledFor: null },
    { id: "WO-4", propertyId: "P-W2", customerName: "", type: "fall_closing",
      status: "scheduled", scheduledFor: "2026-10-09T13:00:00.000Z" },
    { id: "WO-5", propertyId: "P-W1", customerName: "", type: "fall_closing",
      status: "cancelled", scheduledFor: "2026-10-02T15:00:00.000Z" },
    { id: "WO-OTHER", propertyId: "P-X", customerName: "Somebody Else",
      type: "service_visit", status: "scheduled", scheduledFor: "2026-10-02T09:00:00.000Z" }
  ],
  bookings: [
    { id: "BK-1", propertyId: "P-W1", customerName: "Willowridge Landscaping",
      status: "confirmed", source: "assignment", scheduledFor: "2026-10-02T12:30:00.000Z" },
    { id: "BK-2", propertyId: "P-W2", customerName: "Willowridge Landscaping",
      status: "cancelled", scheduledFor: "2026-10-02T14:00:00.000Z" }
  ],
  leads: [
    { id: "L-1", customerId: "cus_willow", contact: { name: "Willowridge Landscaping", address: "400 Ridge Rd" },
      archived: true, booking: { start: "2026-10-02T10:00:00.000Z" } },
    { id: "L-2", contact: { name: "Willowridge Landscaping" } }
  ],
  plans: [{
    season: "fall", year: 2026,
    plan: { days: { "2026-10-02": { label: "R3", morning: ["P-W1"], afternoon: ["P-W2"] } } }
  }]
};

const r = findJobs("willowridge", DAY, stores);

// ---- Matching reaches every store, including by property link ---------

ok("both Willowridge properties are found", r.properties.length === 2);
ok("a work order with a BLANK name is found through its property link",
  r.workOrders.some((w) => w.id === "WO-1"), JSON.stringify(r.workOrders.map((w) => w.id)));
ok("another customer's records stay out",
  !r.workOrders.some((w) => w.id === "WO-OTHER") && !r.properties.some((p) => p.id === "P-X"));

// ---- The verdicts say the truth about the day -------------------------

const wo = (id) => r.workOrders.find((w) => w.id === id);
ok("a work order scheduled that day says SHOULD show",
  wo("WO-1").onDay === true && /SHOULD show/.test(wo("WO-1").verdict));
ok("a date-only value counts as ITS OWN local day, and the report names the quirk",
  wo("WO-2").onDay === true && /no time/.test(wo("WO-2").verdict), wo("WO-2").verdict);
ok("a work order with NO date says so, and says what to do",
  wo("WO-3").onDay === false && /NO scheduled date/.test(wo("WO-3").verdict)
  && /set its scheduled date/i.test(wo("WO-3").verdict), wo("WO-3").verdict);
ok("a different day names the day it IS on",
  wo("WO-4").onDay === false && /2026-10-09/.test(wo("WO-4").verdict));
ok("a cancelled work order says it is kept off on purpose",
  wo("WO-5").onDay === false && /cancelled/.test(wo("WO-5").verdict));

const bk = (id) => r.bookings.find((b) => b.id === id);
ok("a confirmed booking on the day says SHOULD show", bk("BK-1").onDay === true);
ok("a cancelled booking says why it is off", /cancelled/.test(bk("BK-2").verdict));

const ld = (id) => r.leads.find((l) => l.id === id);
ok("an archived lead says archived leads never show", /ARCHIVED/.test(ld("L-1").verdict));
ok("a lead with no booking reads as an enquiry", /enquiry/.test(ld("L-2").verdict));

// ---- Plan stops: planned is not booked --------------------------------

const stop = (code) => r.planStops.find((s) => s.code === code);
ok("a planned stop WITH a booking that day points at the booking",
  stop("P-W1").booked === true && /and booked/.test(stop("P-W1").verdict));
ok("a planned stop whose booking was cancelled reads as NEVER BOOKED — run preflight",
  stop("P-W2").booked === false && /NEVER BOOKED/.test(stop("P-W2").verdict)
  && /preflight/.test(stop("P-W2").verdict), stop("P-W2").verdict);

// ---- Empty and blank searches are safe --------------------------------

const empty = findJobs("", DAY, stores);
ok("a blank search returns nothing rather than everything",
  !empty.properties.length && !empty.workOrders.length && !empty.bookings.length);
const none = findJobs("zzz-no-such-customer", DAY, stores);
ok("a miss is a clean empty result",
  !none.properties.length && !none.workOrders.length && !none.leads.length && !none.planStops.length);
const bare = findJobs("willowridge", DAY, {});
ok("missing stores are treated as empty, not a crash", Array.isArray(bare.workOrders));

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-job-finder: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-job-finder: ${pass} assertions passed`);

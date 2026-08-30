// Public booking window — the seasonal gate on customer-facing availability.
//
//   node scripts/test-public-booking-window.mjs
//
// THE BUG. The availability engine scans forward from "now" and never knew
// which season a service belonged to, so every bookable service was offered
// on every open day inside the scan. Measured against a live server on
// 2026-08-30: the booking page offered a FALL CLOSING on 2026-12-26 — fifty
// days past the Nov 6 frost stop — and a SPRING OPENING in December.
// seasons.json had defined publicBookingThrough for exactly this and said of
// it "NOTHING CONSUMES THIS FIELD YET." Now something does.
//
// THE SECOND BUG, found while wiring the first. /api/booking/reserve
// re-validated the chosen slot against a flat 30-day scan while the picker
// offers whatever the visible month holds (to the route's 120-day cap). A
// slot further out than 30 days was never in the re-validation list, so
// every attempt to book one answered 409 "That slot was just taken" — for a
// slot nobody had taken and that could not be booked at any time. Verified
// against a booted server: with the flat 30 restored, an in-season slot 53
// days out is refused slot_taken; with the fix, the same shape books.
//
// THE ASYMMETRY. Staff keep the full scan window. Patrick placing a job in
// November is deliberate advance scheduling; a customer doing it is work
// that cannot be performed. That is why publicBookingThrough (Oct 30 for
// fall 2026) is a separate date from serviceableThrough (Nov 6) — the tail
// is reserved for admin placement.
//
// TIMEZONE. PJL operates in America/Toronto and slot starts are UTC Z
// timestamps, so an 8 PM Oct 30 slot is written 2026-10-31T00:00:00Z and
// must still read as Oct 30. server.js pins process.env.TZ at boot; this
// file is loaded directly by the runner, so it pins the same TZ below,
// before importing anything that does date math.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
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

const gate = require(path.join(ROOT, "server/lib/public-booking-window.js"));
const { BOOKABLE_SERVICES } = require(path.join(ROOT, "server/lib/availability.js"));
const seasons = require(path.join(ROOT, "server/lib/seasons.js"));

// Local-midnight Date from YYYY-MM-DD, matching how the gate parses days.
const D = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// ---- 1. Service -> season, across the WHOLE catalog ------------------
//
// Walked over every bookable key rather than a sample: a new tier added to
// the catalog with a typo'd prefix would be silently ungated, which is the
// failure this section exists to catch.

const bookable = Object.keys(BOOKABLE_SERVICES).filter((k) => BOOKABLE_SERVICES[k].bookable);
ok("catalog still has bookable services", bookable.length > 0);

for (const key of bookable) {
  const season = gate.seasonForServiceKey(key);
  if (key.startsWith("spring_open_")) {
    ok(`${key} -> spring`, season === "spring", `got ${season}`);
  } else if (key.startsWith("fall_close_")) {
    ok(`${key} -> fall`, season === "fall", `got ${season}`);
  } else {
    ok(`${key} is year-round (ungated)`, season === null, `got ${season}`);
  }
}

// The three year-round services, named explicitly. If one of these ever
// starts resolving to a season, repairs stop being bookable in winter.
for (const key of ["sprinkler_repair", "hydrawise_retrofit", "site_visit"]) {
  ok(`${key} is not seasonal`, gate.seasonForServiceKey(key) === null);
}
ok("unknown service key is not seasonal", gate.seasonForServiceKey("nonsense_key") === null);
ok("empty service key is not seasonal", gate.seasonForServiceKey("") === null);

// ---- 2. The fall 2026 boundary, to the day ---------------------------
//
// seasons.json: fall 2026 serviceableFrom 09-01, serviceableThrough 11-06,
// publicBookingThrough 10-30. The gate must cut at the PUBLIC date, not the
// serviceable one — the Nov 1-6 tail is admin-only.

const cfg = seasons.configFor("fall", 2026);
ok("fall 2026 publicBookingThrough is 2026-10-30", cfg.publicBookingThrough === "2026-10-30", cfg.publicBookingThrough);
ok("fall 2026 serviceableThrough is 2026-11-06", cfg.serviceableThrough === "2026-11-06", cfg.serviceableThrough);

ok("fall: Sep 1 (season opens) is bookable", gate.isPubliclyBookableOn("fall_close_8z", D("2026-09-01")));
ok("fall: Aug 31 (day before) is NOT bookable", !gate.isPubliclyBookableOn("fall_close_8z", D("2026-08-31")));
ok("fall: Oct 30 (last public day) IS bookable", gate.isPubliclyBookableOn("fall_close_8z", D("2026-10-30")));
ok("fall: Oct 31 (day after) is NOT bookable", !gate.isPubliclyBookableOn("fall_close_8z", D("2026-10-31")));
ok("fall: Nov 6 (frost stop, admin tail) is NOT publicly bookable",
  !gate.isPubliclyBookableOn("fall_close_8z", D("2026-11-06")));
ok("fall: Dec 26 (the reported defect) is NOT bookable",
  !gate.isPubliclyBookableOn("fall_close_8z", D("2026-12-26")));

// The 8 PM Oct 30 slot. Stored as 2026-10-31T00:00:00Z; must read as Oct 30.
ok("fall: 8 PM Oct 30 stored as a UTC Z timestamp still reads as Oct 30",
  gate.isPubliclyBookableOn("fall_close_8z", new Date("2026-10-31T00:00:00.000Z")));

// ---- 3. Spring, and the per-day year resolution ----------------------
//
// The window is resolved against the DAY's own year, not "now". A customer
// looking in December at a spring service is looking at next spring and must
// get next spring's window; resolving against the current year would answer
// with a season that closed in June and offer nothing.

ok("spring: Mar 1 2026 is bookable", gate.isPubliclyBookableOn("spring_open_4z", D("2026-03-01")));
ok("spring: Jun 30 2026 is bookable", gate.isPubliclyBookableOn("spring_open_4z", D("2026-06-30")));
ok("spring: Jul 1 2026 is NOT bookable", !gate.isPubliclyBookableOn("spring_open_4z", D("2026-07-01")));
ok("spring: Dec 2026 is NOT bookable (the December-spring-opening defect)",
  !gate.isPubliclyBookableOn("spring_open_4z", D("2026-12-15")));
ok("spring: Mar 2027 IS bookable — resolved against 2027, not the current year",
  gate.isPubliclyBookableOn("spring_open_4z", D("2027-03-15")));
ok("fall: Sep 2027 IS bookable — a year with no explicit block inherits defaults",
  gate.isPubliclyBookableOn("fall_close_8z", D("2027-09-15")));
ok("fall: Nov 2027 is NOT bookable — the inherited default is the Nov 6 frost stop, not Dec 15",
  !gate.isPubliclyBookableOn("fall_close_8z", D("2027-11-20")));

// A year-round service is never gated, in any month of any year.
for (const key of ["2026-01-15", "2026-07-04", "2026-12-26", "2028-11-30"]) {
  ok(`sprinkler_repair bookable on ${key}`, gate.isPubliclyBookableOn("sprinkler_repair", D(key)));
}

// ---- 4. filterSlots ---------------------------------------------------

const slot = (iso) => ({ start: iso, end: iso, serviceKey: "fall_close_8z" });
const mixed = [
  slot("2026-09-15T12:00:00.000Z"),
  slot("2026-10-30T12:00:00.000Z"),
  slot("2026-11-07T12:00:00.000Z"),
  slot("2026-12-26T13:00:00.000Z")
];
const kept = gate.filterSlots(mixed, "fall_close_8z");
ok("filterSlots keeps only in-window slots", kept.length === 2, `kept ${kept.length}`);
ok("filterSlots keeps Sep 15", kept.some((s) => s.start.startsWith("2026-09-15")));
ok("filterSlots keeps Oct 30", kept.some((s) => s.start.startsWith("2026-10-30")));
ok("filterSlots drops Nov 7", !kept.some((s) => s.start.startsWith("2026-11-07")));
ok("filterSlots drops Dec 26", !kept.some((s) => s.start.startsWith("2026-12-26")));

const yearRound = gate.filterSlots(mixed, "sprinkler_repair");
ok("filterSlots is identity for a year-round service", yearRound.length === mixed.length);
ok("filterSlots returns the same array reference for a year-round service (no copy)",
  yearRound === mixed);
ok("filterSlots tolerates a non-array", Array.isArray(gate.filterSlots(null, "fall_close_8z")));
ok("filterSlots on an empty list returns empty", gate.filterSlots([], "fall_close_8z").length === 0);

// ---- 5. annotateDays --------------------------------------------------
//
// Diagnostic only — filterSlots has already removed the slots. A day that
// still HAS slots must never be relabelled, or an in-season bookable day
// would be reported as out of season.

const days = [
  { date: "2026-09-15", slots: [{ start: "x" }], reason: undefined },
  { date: "2026-10-30", slots: [], reason: "no_availability" },
  { date: "2026-11-07", slots: [], reason: "no_availability" },
  { date: "2026-12-26", slots: [], reason: "no_availability" }
];
const annotated = gate.annotateDays(days, "fall_close_8z");
const byDate = Object.fromEntries(annotated.map((d) => [d.date, d]));
ok("annotateDays leaves a day that has slots alone", byDate["2026-09-15"].reason === undefined);
ok("annotateDays leaves an in-window empty day as no_availability",
  byDate["2026-10-30"].reason === "no_availability");
ok("annotateDays marks Nov 7 out_of_season", byDate["2026-11-07"].reason === "out_of_season");
ok("annotateDays marks Dec 26 out_of_season", byDate["2026-12-26"].reason === "out_of_season");
ok("annotateDays does not mutate the input", days[2].reason === "no_availability");
ok("annotateDays is identity for a year-round service",
  gate.annotateDays(days, "sprinkler_repair") === days);

// ---- 6. Fails CLOSED when the season config is unreadable -------------
//
// seasons.js throws from every accessor when seasons.json is missing or
// malformed. The gate must let that throw reach the route, which surfaces a
// visible booking error. Swallowing it and skipping the filter would
// silently restore the defect — and do it invisibly, which is worse than a
// booking outage: an outage gets a phone call within the hour, unperformable
// work sold in December is not found until November.

const gateSrc = fs.readFileSync(path.join(ROOT, "server/lib/public-booking-window.js"), "utf8");
ok("gate does not swallow a seasons.js failure with try/catch",
  !/try\s*\{/.test(gateSrc), "a catch here would silently reopen the window");
ok("gate hardcodes no month/day pair of its own",
  !/serviceableThrough\s*:\s*["']\d/.test(gateSrc) && !/publicBookingThrough\s*:\s*["']\d/.test(gateSrc));
ok("gate reads its prefixes from outreach.js rather than redeclaring them",
  /SEASONAL_SERVICE_PREFIXES\s*\}\s*=\s*require\(["']\.\/outreach["']\)/.test(gateSrc)
  && !/const\s+SEASONAL_SERVICE_PREFIXES\s*=/.test(gateSrc));

// ---- 7. Source guards on the wiring in server.js ----------------------
//
// The gate is only worth anything where it is actually called. Each of
// these was verified to fail this file when the line it pins is removed.

const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");

ok("server.js requires the gate", /require\(["']\.\/lib\/public-booking-window["']\)/.test(serverSrc));
ok("the public availability route filters by staff session",
  /const staffSession = await requireUser\(req\);[\s\S]{0,200}publicBookingWindow\.filterSlots\(slots, serviceKey\)/.test(serverSrc),
  "the offer side is ungated");
ok("the reserve route gates the WRITE, not just the offer",
  /isAdmin\s*\?\s*stillAvailable\s*:\s*publicBookingWindow\.filterSlots\(stillAvailable, serviceKey\)/.test(serverSrc),
  "a hand-crafted POST could book past frost");
ok("the reserve route answers out_of_season rather than slot_taken",
  /code:\s*["']out_of_season["']/.test(serverSrc),
  "telling a customer to pick another time is advice that cannot succeed");
ok("the customer reschedule route is gated",
  /reschedule-availability[\s\S]{0,1600}publicOnly:\s*true/.test(serverSrc));
ok("rescheduleAvailability defaults to UNGATED so admin keeps the full window",
  /async function rescheduleAvailability\(bookingId, \{ from, to, publicOnly = false \}/.test(serverSrc));

// The regression that made the gate reachable at all.
ok("the reserve route no longer re-validates against a flat 30-day scan",
  !/const stillAvailable = await listAvailableSlots\(\{[\s\S]{0,200}daysAhead:\s*30,/.test(serverSrc),
  "a slot beyond 30 days would answer slot_taken for a slot nobody took");
ok("the reserve route scans far enough to reach the slot being booked",
  /reserveDaysAhead = Math\.min\(\s*120,/.test(serverSrc));

// ---- Report -----------------------------------------------------------

if (failures.length) {
  console.error(`public booking window: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`public booking window: ${pass} assertions passed`);

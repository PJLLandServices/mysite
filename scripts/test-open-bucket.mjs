// The open bucket — "first available" standby appointments.
//
//   node scripts/test-open-bucket.mjs
//
// WHAT THIS PROTECTS. A standby customer is a commitment WITHOUT a
// calendar entry: a lead carrying `standby` and no `booking`. The Season
// Plan's Open bucket panel ranks each one against the route days with
// the geography filter's own cheapest-insertion math ("on our way
// home") and places them through the existing book-from-lead path. This
// suite pins the lib: ranking order, the past-day and empty-day
// exclusions, the unresolved-coords refusal, the waiting-list filter,
// and the customer-facing template's existence — the reserve endpoint's
// standby branch rides these plus the already-tested lead machinery.
process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const openBucket = require(path.join(ROOT, "server/lib/open-bucket.js"));
const notify = require(path.join(ROOT, "server/lib/notify-customer.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures: three shaped days + one empty + one past ---------------
// Customer sits in Mississauga; the near shape is Mississauga houses,
// the far shape is Keswick. Haversine fallback (no key) keeps numbers
// deterministic.
const MISSISSAUGA = { lat: 43.5915, lng: -79.6410 };
const NEAR = [{ lat: 43.5890, lng: -79.6441 }, { lat: 43.6000, lng: -79.6300 }];
const FAR = [{ lat: 44.2400, lng: -79.4620 }, { lat: 44.2500, lng: -79.4500 }];
const MID = [{ lat: 43.8000, lng: -79.5500 }];

const shapes = {
  "2026-08-01": { label: "PAST", points: NEAR },
  "2026-10-06": { label: "FAR", points: FAR },
  "2026-10-05": { label: "NEAR", points: NEAR },
  "2026-10-07": { label: "MID", points: MID },
  "2026-10-08": { label: "EMPTY", points: [] },
  "2026-10-09": { label: "BOOKED", points: NEAR, bookingsOnly: true }
};

const ranked = await openBucket.rankDaysForCoords(MISSISSAUGA, shapes, {
  max: 3, todayKey: "2026-09-05"
});
ok("cheapest day ranks first and dates break ties",
  ranked.length === 3 && ranked[0].date === "2026-10-05" && ranked[1].date === "2026-10-09",
  JSON.stringify(ranked.map((r) => `${r.date}+${r.addedDriveMinutes}`)));
ok("a past day never ranks", ranked.every((r) => r.date !== "2026-08-01"));
ok("an empty day never ranks — +0 min is a blank calendar, not 'nearby'",
  ranked.every((r) => r.date !== "2026-10-08"));
ok("costs come back finite and ascending",
  ranked.every((r) => Number.isFinite(r.addedDriveMinutes))
  && ranked[0].addedDriveMinutes <= ranked[ranked.length - 1].addedDriveMinutes);
ok("booked-only days carry the flag for the panel's label",
  ranked.find((r) => r.date === "2026-10-09")?.bookingsOnly === true);
ok("the cap holds", (await openBucket.rankDaysForCoords(MISSISSAUGA, shapes, { max: 2, todayKey: "2026-09-05" })).length === 2);
ok("unresolved coordinates rank nothing rather than everything",
  (await openBucket.rankDaysForCoords(null, shapes, { todayKey: "2026-09-05" })).length === 0
  && (await openBucket.rankDaysForCoords({ lat: null }, shapes, { todayKey: "2026-09-05" })).length === 0);
ok("no shapes at all is an empty answer, not a throw",
  (await openBucket.rankDaysForCoords(MISSISSAUGA, null, {})).length === 0);

// ---- The waiting list --------------------------------------------------
const mkLead = (id, extra = {}) => ({
  id,
  standby: { requestedAt: extra.at || "2026-09-05T12:00:00Z", serviceKey: "x", serviceLabel: "Fall Closing" },
  contact: { name: id },
  crm: {},
  ...extra
});
const leads = [
  mkLead("L-2", { at: "2026-09-05T12:00:00Z" }),
  mkLead("L-1", { at: "2026-09-04T09:00:00Z" }),
  mkLead("L-PLACED", { booking: { start: "2026-10-05T13:00:00" } }),
  mkLead("L-ARCHIVED", { archived: true }),
  mkLead("L-LOST", { crm: { status: "lost" } }),
  { id: "L-NORMAL", contact: {}, crm: {} }
];
const waiting = openBucket.waitingLeads(leads);
ok("only unplaced, live standbys wait — placed, archived, lost and normal leads don't",
  waiting.map((l) => l.id).join(",") === "L-1,L-2",
  waiting.map((l) => l.id).join(","));
ok("the bucket is first-in, first-out", waiting[0].id === "L-1");
ok("an empty store is an empty bucket", openBucket.waitingLeads([]).length === 0
  && openBucket.waitingLeads(null).length === 0);

// ---- The customer-facing promise ---------------------------------------
const tpl = notify.TEMPLATES && notify.TEMPLATES.standby_joined;
ok("the standby_joined template exists with email + SMS",
  Boolean(tpl && tpl.subject && tpl.body && tpl.sms));
ok("the template names the service and never promises a date",
  Boolean(tpl) && tpl.body.includes("{serviceLabel}")
  && !tpl.body.includes("{dateStr}") && !tpl.sms.includes("{dateStr}"));
ok("the booked template is untouched — placement still reads as a booking",
  notify.TEMPLATES.booked.subject.includes("{serviceLabel}")
  && notify.TEMPLATES.booked.body.includes("{dateStr}"));

// ---- Report --------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ test-open-bucket: ${failures.length} failed, ${pass} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-open-bucket: ${pass} assertions passed`);

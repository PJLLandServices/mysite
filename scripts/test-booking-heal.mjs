// The lead-booking heal — the bridge between the two booking stores.
//
//   node scripts/test-booking-heal.mjs
//
// WHAT THIS PROTECTS. A booking made through the public flow is born on
// its LEAD; /admin/bookings, and every other canonical-only surface,
// can only see records upsertFromLead materialized into bookings.json.
// The heal used to live solely inside the iCal feed (ran only when a
// calendar client fetched, swallowed failures) — which is how a real
// customer's bookings sat on the schedule and the phone calendar while
// the Bookings page knew nothing about them. bookings.healFromLeads is
// now the one shared loop (feed + boot/interval sweep); this suite pins
// its contract: heals what's missing, touches nothing that exists,
// skips the unlistable, and NAMES its failures instead of eating them.
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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-heal-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));

const LEAD_BOOKED = {
  id: "L-WILLOW",
  customerId: "cus_willow",
  propertyId: "P-WILLOW",
  contact: { name: "Willowridge Landscaping", email: "OFFICE@Willowridge.example",
    phone: "+19055550188", address: "400 Ridge Rd, Aurora, ON" },
  booking: {
    start: new Date(2026, 9, 6, 13, 0).toISOString(),
    durationMinutes: 45,
    serviceKey: "fall_close_8z",
    serviceLabel: "Fall winterization (7-8 zones residential)",
    zoneCount: 8,
    status: "confirmed"
  }
};
const LEAD_NO_START = {
  id: "L-PENDING",
  contact: { name: "Pending Person" },
  booking: { serviceKey: "fall_close_4z" }        // no start — unlistable
};
const LEAD_NO_BOOKING = { id: "L-BROWSING", contact: { name: "Just Browsing" } };
// A lead whose record blows up mid-upsert: the guard reads only
// lead.booking.start, so this gets past it and fails inside the loop.
const LEAD_BROKEN = {
  id: "L-BROKEN",
  booking: { start: new Date(2026, 9, 7, 9, 0).toISOString() },
  get contact() { throw new Error("corrupted contact block"); }
};

// ---- 1. The heal materializes what's missing --------------------------

const first = await bookings.healFromLeads([LEAD_BOOKED, LEAD_NO_START, LEAD_NO_BOOKING]);
ok("one listable lead booking heals into one canonical record",
  first.healed === 1 && first.failures.length === 0, JSON.stringify(first));

const stored = await bookings.list();
ok("exactly one record exists — the no-start and no-booking leads stayed out",
  stored.length === 1, String(stored.length));
const rec = stored[0];
ok("the record carries the lead's booking, contact and links",
  rec.leadId === "L-WILLOW" && rec.customerName === "Willowridge Landscaping"
  && rec.propertyId === "P-WILLOW" && rec.scheduledFor === LEAD_BOOKED.booking.start
  && rec.serviceKey === "fall_close_8z" && rec.durationMinutes === 45
  && rec.customerEmail === "office@willowridge.example" && rec.status === "confirmed",
  JSON.stringify(rec));
ok("the record says where it came from",
  rec.history.some((h) => h.action === "created_from_lead" && h.note.includes("L-WILLOW")));

// ---- 2. Idempotent, and an existing record is left alone --------------

const second = await bookings.healFromLeads([LEAD_BOOKED, LEAD_NO_START]);
ok("a second sweep heals nothing — the record already exists",
  second.healed === 0 && second.failures.length === 0, JSON.stringify(second));
const after = await bookings.list();
ok("no duplicate was created and the existing record was not re-touched",
  after.length === 1 && after[0].updatedAt === rec.updatedAt
  && after[0].history.length === rec.history.length);

// ---- 3. A failure is NAMED, and doesn't sink the rest -----------------

const LEAD_OK2 = {
  id: "L-FINE",
  contact: { name: "Fine Customer" },
  booking: { start: new Date(2026, 9, 8, 8, 0).toISOString(), status: "confirmed" }
};
const mixed = await bookings.healFromLeads([LEAD_BROKEN, LEAD_OK2]);
ok("the broken lead is reported by id and name-less error, not thrown or swallowed",
  mixed.failures.length === 1 && mixed.failures[0].leadId === "L-BROKEN"
  && /corrupted contact block/.test(mixed.failures[0].error),
  JSON.stringify(mixed.failures));
ok("the healthy lead behind it still healed — one bad record can't hide the rest",
  mixed.healed === 1 && (await bookings.list()).some((b) => b.leadId === "L-FINE"));

// ---- 4. Nothing at all is a clean no-op -------------------------------

const idle = await bookings.healFromLeads([]);
ok("an empty lead list is a no-op", idle.healed === 0 && idle.failures.length === 0);
const none = await bookings.healFromLeads();
ok("no argument at all is a no-op too", none.healed === 0 && none.failures.length === 0);

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-booking-heal: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-booking-heal: ${pass} assertions passed`);

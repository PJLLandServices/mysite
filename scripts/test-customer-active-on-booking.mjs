#!/usr/bin/env node
// scripts/test-customer-active-on-booking.mjs
//
// A booked appointment makes someone a customer.
//
// Patrick, 2026-09-08: "if the customer BOOKS an appointment - the customer
// is still coming in as a LEAD ... if they've booked an appointment they are
// active?" He was right. resolveCustomerForLead creates every record with
// status "lead", and the only other writers were the admin edit form and the
// archive path — so someone who booked, paid and had the work done still read
// as a lead until Patrick fixed it by hand.
//
// Two halves, and the second is the one that keeps this fixed:
//   1. promoteCustomerOnBooking is the rule, in one place.
//   2. syncBookingFromLead is the ONLY thing that calls
//      bookings.upsertFromLead, so no booking path can mirror a booking and
//      forget the customer. Section 3 is the lint that holds that line —
//      run it against the old code and it fails on all eight call sites.
//
// Run: node scripts/test-customer-active-on-booking.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["customers.json", "properties.json", "customer-links.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

try {
  fs.writeFileSync(path.join(DATA, "customers.json"), "[]\n");
  const customers = require2(path.join(ROOT, "server", "lib", "customers.js"));
  const { promoteCustomerOnBooking } = require2(path.join(ROOT, "server", "lib", "lead-customer.js"));

  const make = async (status, email) => {
    const c = await customers.create({ name: `T ${status}`, email, status }, { by: "test" });
    return c.id;
  };
  const statusOf = async (id) => (await customers.get(id, { withProperties: false }))?.status;

  // ---- 1. The promotion ------------------------------------------------
  const leadId = await make("lead", "lead@test.local");
  ok("a customer starts as a lead", await statusOf(leadId) === "lead");
  await promoteCustomerOnBooking(leadId, { by: "booking", reason: "Booked fall closing" });
  ok("booking an appointment makes them active", await statusOf(leadId) === "active",
    await statusOf(leadId));

  // Someone written off who books again is, by definition, not lost.
  const lostId = await make("lost", "lost@test.local");
  await promoteCustomerOnBooking(lostId, {});
  ok("a lost customer who books again becomes active", await statusOf(lostId) === "active");

  const inactiveId = await make("inactive", "inactive@test.local");
  await promoteCustomerOnBooking(inactiveId, {});
  ok("an archived customer who books again becomes active", await statusOf(inactiveId) === "active");

  // ---- 2. What it must NOT do -----------------------------------------
  // Every booking edit re-syncs, so this runs constantly. It has to be
  // idempotent and it must not rewrite a record that is already right.
  const activeBefore = await customers.get(leadId, { withProperties: false });
  await promoteCustomerOnBooking(leadId, {});
  const activeAfter = await customers.get(leadId, { withProperties: false });
  ok("re-syncing an active customer changes nothing",
    activeAfter.status === "active" && activeAfter.lastUpdatedAt === activeBefore.lastUpdatedAt,
    `${activeBefore.lastUpdatedAt} → ${activeAfter.lastUpdatedAt}`);

  // A booking is the thing the customer is waiting on. A status nicety must
  // never be able to take one down.
  let threw = false;
  try { await promoteCustomerOnBooking("C-DOES-NOT-EXIST", {}); } catch { threw = true; }
  ok("an unknown customer is a no-op, not an error", !threw);
  let threwNull = false;
  try { await promoteCustomerOnBooking(null, {}); } catch { threwNull = true; }
  ok("a booking with no customer attached is a no-op", !threwNull);

  // ---- 3. THE LINT: no booking path can forget ------------------------
  // This is the assertion that fails on the old code. Before the fix there
  // were eight direct callers and none of them touched the customer.
  const SERVER = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const wrapperAt = SERVER.indexOf("async function syncBookingFromLead(lead) {");
  ok("the booking paths share one wrapper", wrapperAt !== -1);
  const wrapperEnd = SERVER.indexOf("\n}", wrapperAt);
  const wrapperBody = wrapperAt === -1 ? "" : SERVER.slice(wrapperAt, wrapperEnd);
  ok("the wrapper mirrors the booking", wrapperBody.includes("bookings.upsertFromLead("));
  ok("…and promotes the customer in the same breath",
    wrapperBody.includes("promoteCustomerOnBooking("));

  // Count real calls outside the wrapper. Comments mentioning the name are
  // fine; a call is `bookings.upsertFromLead(`.
  const strays = [];
  const lines = SERVER.split("\n");
  const wrapperFirstLine = SERVER.slice(0, wrapperAt).split("\n").length;
  const wrapperLastLine = SERVER.slice(0, wrapperEnd).split("\n").length;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (n >= wrapperFirstLine && n <= wrapperLastLine) return;
    if (line.trim().startsWith("//")) return;
    if (line.includes("bookings.upsertFromLead(")) strays.push(`${n}: ${line.trim()}`);
  });
  ok("nothing mirrors a booking behind the wrapper's back", strays.length === 0,
    strays.join(" | "));

  // ---- 4. The CRM shows the zone count it was told ---------------------
  // A property booked through the public form carries system.zoneCount and
  // an empty system.zones. The panel counted only the documented list, so
  // every freshly booked property read "0 zones" while its work order
  // correctly scaffolded four (Patrick, 2026-09-08).
  const ADMIN = fs.readFileSync(path.join(ROOT, "server", "admin.js"), "utf8");
  ok("the property panel falls back to the declared zone count",
    ADMIN.includes("const declaredZones = Math.floor(Number(property.system?.zoneCount) || 0);")
    && ADMIN.includes("const zones = documentedZones || declaredZones;"));
  ok("…and says so, rather than passing a claim off as a survey",
    ADMIN.includes("zonesAreDeclared") && ADMIN.includes('" (declared)"'));

  // And the wrapper is actually used — a wrapper nobody calls fixes nothing.
  const uses = (SERVER.match(/await syncBookingFromLead\(/g) || []).length;
  ok("every booking path goes through it", uses >= 6, `${uses} call sites`);
} finally {
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-customer-active-on-booking: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-customer-active-on-booking: ${passed} assertions passed`);

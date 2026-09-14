#!/usr/bin/env node
// scripts/test-portal-status-history.mjs
//
// PJL-20 + PJL-21 regression.
//
// The customer portal's derived "your service is..." status and its
// Service History list each independently decided "what's going on with
// this customer" from an incomplete set of sources — the exact "two
// copies of a state test will drift" failure mode this repo's CLAUDE.md
// calls out for lifecycle states, here showing up on booking/service
// status instead of cancellation status.
//
// PJL-20: a customer with a real season-plan booking (bookings.json, the
// mechanism that actually schedules existing/seasonal customers) but no
// lead booking envelope and no Work Order yet still read "your service
// is complete" — confirmed live on two real properties.
//
// PJL-21: an invoice created without a linked Work Order (a normal,
// supported path — invoices.createDraft accepts woId: null) never
// appeared in Service History or anywhere else on the portal, even
// though it existed and might be payable.
//
// Also covers a follow-up sweep finding: a season-plan booking's
// scheduledFor is an internal route/day-schedule timestamp, not a time
// committed to the customer. It must never be surfaced as an exact
// arrival time — not in the Next Visit card, and not via the
// property-token calendar (.ics) download either.
//
// Boots the real server against fixture data and hits the real public
// portal endpoint end-to-end, no stubs.
//
// Run: node scripts/test-portal-status-history.mjs  (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4799;

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures ----------------------------------------------------------
// Everything this suite writes is restored afterwards; nothing else in
// server/data is touched.
fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "properties.json", "bookings.json", "work-orders.json", "invoices.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

// Discover the current season/window the same way the app does, so this
// suite keeps working as seasons open and close instead of rotting on a
// hardcoded date (same discovery pattern as test-booking-lifecycle.mjs).
const require2 = createRequire(import.meta.url);
const outreach = require2(path.join(ROOT, "server", "lib", "outreach.js"));
const seasons = require2(path.join(ROOT, "server", "lib", "seasons.js"));
const season = outreach.seasonForBooking();
const year = new Date().getFullYear();
const win = seasons.windowFor(season, year);
if (!win) {
  console.log("• test-portal-status-history: no season window resolvable right now — nothing to test, skipping.");
  process.exit(0);
}
// A day that is BOTH inside the season window AND strictly in the
// future relative to right now — the calendar.ics route only offers a
// season-plan event when scheduledFor is future-dated, so a window-only
// date (which can land in the past, e.g. right after a window opens)
// would make that assertion pass vacuously regardless of the fix.
const windowStart = new Date(Date.UTC(year, win.startMonth - 1, win.startDay, 16, 0, 0));
const windowEnd = new Date(Date.UTC(year, win.endMonth - 1, win.endDay, 16, 0, 0));
const soon = new Date(Date.now() + 2 * 86400000);
const probeMs = Math.max(soon.getTime(), windowStart.getTime());
if (probeMs > windowEnd.getTime()) {
  console.log("• test-portal-status-history: no future date available inside the current season window — nothing to test, skipping.");
  process.exit(0);
}
const scheduledFor = new Date(probeMs).toISOString();
const serviceKey = `${outreach.SEASONAL_SERVICE_PREFIXES[season]}4z`;

const CUSTOMER_ID = "cust-portal-probe";
const PROPERTY_ID = "prop-portal-probe";
const LEAD_ID = "lead-portal-probe";
const PORTAL_TOKEN = "portal-probe-token-xyz";
const PAST_WO_ID = "WO-PORTAL-PROBE";
const ORPHAN_INVOICE_ID = "I-PORTAL-PROBE-0001";

function writeFixtures() {
  fs.writeFileSync(path.join(DATA, "properties.json"), JSON.stringify([{
    id: PROPERTY_ID,
    customerId: CUSTOMER_ID,
    address: "1 Probe Lane, Newmarket, ON",
    system: { zones: [{ name: "Zone 1" }] }
  }], null, 2));

  fs.writeFileSync(path.join(DATA, "leads.json"), JSON.stringify([{
    id: LEAD_ID,
    customerId: CUSTOMER_ID,
    propertyId: PROPERTY_ID,
    createdAt: "2025-01-01T12:00:00Z",
    status: "won",
    contact: {
      firstName: "Probe", lastName: "Customer",
      email: "portal-probe@example.test", phone: "+19995550100",
      address: "1 Probe Lane, Newmarket, ON"
    },
    portal: { token: PORTAL_TOKEN }
    // Deliberately NO lead.booking — the whole point of PJL-20 is that
    // this customer's upcoming visit is known ONLY via the season plan.
  }], null, 2));

  fs.writeFileSync(path.join(DATA, "bookings.json"), JSON.stringify([{
    id: "BK-PORTAL-PROBE",
    leadId: null,
    propertyId: PROPERTY_ID,
    scheduledFor,
    serviceKey,
    serviceLabel: "Season-plan probe visit",
    status: "confirmed"
  }], null, 2));

  fs.writeFileSync(path.join(DATA, "work-orders.json"), JSON.stringify([{
    id: PAST_WO_ID,
    type: "service_visit",
    status: "completed",
    customerId: CUSTOMER_ID,
    leadId: LEAD_ID,
    propertyId: PROPERTY_ID,
    completedAt: "2026-01-15T15:00:00.000Z",
    scheduledFor: "2026-01-15T14:00:00.000Z",
    createdAt: "2026-01-10T12:00:00.000Z"
    // A past COMPLETED visit — so hasCompletedWork is true on the OLD
    // code too. Without this, old code's derived.state would already
    // read "request_open" rather than the real-world "service_complete"
    // Patrick actually saw; this fixture reproduces his exact scenario.
  }], null, 2));

  // PJL-21: an invoice for completed work with NO woId — a normal,
  // supported creation path that used to leave the invoice invisible
  // everywhere on the portal.
  fs.writeFileSync(path.join(DATA, "invoices.json"), JSON.stringify([{
    id: ORPHAN_INVOICE_ID,
    customerId: CUSTOMER_ID,
    customerEmail: "portal-probe@example.test",
    customerPhone: "+19995550100",
    woId: null,
    projectId: null,
    status: "paid",
    total: 2243,
    amountPaid: 2243,
    balanceDue: 0,
    createdAt: "2026-08-20T15:00:00.000Z"
  }], null, 2));
}

writeFixtures();

// ---- Boot ---------------------------------------------------------------
const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const res = await fetch(`http://127.0.0.1:${PORT}/api/portal/${PORTAL_TOKEN}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  ok("portal fetch succeeds", res.ok && data.ok, `${res.status} ${JSON.stringify(data).slice(0, 200)}`);

  const portal = data.portal || {};

  // ---- PJL-20: header/status must reflect the season-plan booking -------
  ok("derived state is 'service_scheduled', not 'service_complete'",
    portal.derived?.state === "service_scheduled",
    `got ${JSON.stringify(portal.derived)}`);
  ok("derived.upcomingBooking is true",
    portal.derived?.upcomingBooking === true);
  ok("nextVisit is populated from the season-plan booking",
    portal.nextVisit && portal.nextVisit.source === "season_plan",
    JSON.stringify(portal.nextVisit));
  ok("nextVisit carries the season label",
    portal.nextVisit?.serviceLabel === outreach.seasonLabel(season),
    portal.nextVisit?.serviceLabel);
  // A season-plan scheduledFor is an internal route/day-schedule
  // timestamp, not a time PJL has committed to the customer — it must
  // never render as an exact arrival time (Patrick, 2026-09-14, after
  // the portal briefly showed "Wednesday, October 7 at 9:42 a.m." for
  // exactly this kind of booking).
  // The DAY is real, on-the-books information and must show (Patrick,
  // after a first fix over-corrected to "date to be confirmed" for a
  // visit that IS scheduled: "there is a f***ing appointment
  // scheduled"). Only the exact hour/minute must never render — that's
  // the frontend's job (dateOnly: true tells portal.js to format the
  // day and stop there), not something this JSON-level test can see
  // directly, so this checks the contract the frontend relies on.
  ok("nextVisit carries the real date and flags it date-only (no time)",
    portal.nextVisit?.dateOnly === true
      && typeof portal.nextVisit?.start === "string"
      && new Date(portal.nextVisit.start).toISOString().slice(0, 10) === scheduledFor.slice(0, 10),
    JSON.stringify(portal.nextVisit));
  ok("the 'Book a Service' card agrees the property is already booked",
    Array.isArray(portal.bookableProperties)
      && portal.bookableProperties.some((p) => p.propertyId === PROPERTY_ID && p.alreadyBooked === true),
    JSON.stringify(portal.bookableProperties));

  // ---- PJL-21: an invoice with no linked Work Order must still appear ---
  const history = Array.isArray(portal.serviceHistory) ? portal.serviceHistory : [];
  const orphanRow = history.find((h) => h.invoice && h.invoice.id === ORPHAN_INVOICE_ID);
  ok("the Work-Order-less invoice shows up in Service History",
    Boolean(orphanRow), JSON.stringify(history).slice(0, 400));
  ok("...with its invoice data intact (status, amount)",
    Boolean(orphanRow) && orphanRow.invoice.status === "paid" && Number(orphanRow.invoice.total) === 2243,
    JSON.stringify(orphanRow));
  ok("the completed Work Order is still listed too (nothing regressed)",
    history.some((h) => h.id === PAST_WO_ID));

  // ---- Sweep finding: the property-token calendar (.ics) download must
  // not hand the customer's calendar app the same internal route time
  // either — same class of leak as nextVisit, different surface.
  const propertyToken = crypto.createHash("sha256")
    .update(`pjl-portal:${PROPERTY_ID}`).digest("base64url").slice(0, 24);
  const icsRes = await fetch(`http://127.0.0.1:${PORT}/api/portal/${propertyToken}/calendar.ics`, { cache: "no-store" });
  ok("the property-token calendar download refuses rather than exposing the internal time",
    icsRes.status === 404, `got ${icsRes.status}`);
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-portal-status-history: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-portal-status-history: ${passed} assertions passed`);

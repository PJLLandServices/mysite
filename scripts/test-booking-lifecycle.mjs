#!/usr/bin/env node
// scripts/test-booking-lifecycle.mjs
//
// THE INVARIANT: a booking that is no longer live must not hold its slot.
//
// WHY THIS EXISTS. Cancelling an appointment did everything except the
// one thing the customer wanted: it flipped the record, cascaded the work
// order, emailed the customer, paged Patrick — and left the time slot
// occupied. The rule for "does this booking still occupy the calendar"
// existed TWICE inside activeBookings(): the canonical bookings.json pass
// skipped cancelled/completed/no_show, and the lead-snapshot pass never
// looked at the booking's status at all. Both cancel paths write
// `lead.booking.status = "cancelled"`, so every cancellation leaked a
// slot. One definition (bookingHoldsItsSlot) now serves both passes, and
// this suite is what keeps them from drifting apart again.
//
// Patrick, 2026-09-08: "We need to ensure moving forward that every
// portion of these developments ... is built strategically around how
// workflows are required to be built."  A lifecycle state is not done
// when the record flips — it is done when every reader agrees.
//
// HOW. Boots the real server once against fixture data, then rewrites
// leads.json / bookings.json between requests (both are read per-request)
// and asks the PUBLIC availability endpoint what it offers. End-to-end
// through the real engine, no stubs.
//
// Run: node scripts/test-booking-lifecycle.mjs  (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4796;
// The day under test is DISCOVERED, not hardcoded: with empty fixtures we
// ask the engine for the first day it will actually offer, so this suite
// keeps working as seasons open and close instead of rotting on a date.
let DAY = null;
let SLOT_START = null;
const SERVICE = "fall_close_4z";
const ADDRESS = "102 Main St, Newmarket, ON";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures --------------------------------------------------------
// Everything this suite writes is restored afterwards; nothing else in
// server/data is touched.
fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

function leadBooking() {
  return {
    start: SLOT_START,
    end: new Date(new Date(SLOT_START).getTime() + 30 * 60000).toISOString(),
    serviceKey: SERVICE,
    serviceLabel: "Fall winterization (1-4 zones residential)",
    coords: { lat: 44.05, lng: -79.46 }
  };
}

function writeLeadCase(status) {
  const lead = {
    id: "lead-lifecycle-probe",
    createdAt: "2026-09-06T18:00:00Z",
    status: "won",
    contact: { firstName: "Probe", lastName: "Case", address: "100 Main St, Newmarket, ON" }
  };
  if (status !== "none") {
    lead.booking = leadBooking();
    if (status !== "live") lead.booking.status = status;
  }
  fs.writeFileSync(path.join(DATA, "leads.json"), JSON.stringify([lead], null, 2));
  fs.writeFileSync(path.join(DATA, "bookings.json"), JSON.stringify([], null, 2));
}

// The same appointment expressed ONLY as a canonical record (no lead
// snapshot) — the other half of activeBookings, which must answer the
// same way for the same state.
function writeCanonicalCase(status) {
  fs.writeFileSync(path.join(DATA, "leads.json"), JSON.stringify([], null, 2));
  const rec = {
    id: "BK-LIFECYCLE", leadId: null, propertyId: null,
    scheduledFor: SLOT_START, durationMinutes: 30,
    serviceKey: SERVICE, serviceLabel: "Fall winterization (1-4 zones residential)",
    status: status === "live" ? "confirmed" : status
  };
  fs.writeFileSync(path.join(DATA, "bookings.json"),
    JSON.stringify(status === "none" ? [] : [rec], null, 2));
}

// ---- Boot ------------------------------------------------------------
const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

// The first offered morning start on DAY, as "HH:MM", or a marker.
async function firstMorningStart() {
  const url = `http://127.0.0.1:${PORT}/api/booking/availability`
    + `?service=${SERVICE}&address=${encodeURIComponent(ADDRESS)}&from=${DAY}&to=${DAY}`;
  const data = await (await fetch(url, { cache: "no-store" })).json();
  if (!data.ok) return `ERR:${JSON.stringify(data.errors || data).slice(0, 80)}`;
  const day = (data.days || []).find((d) => d.date === DAY);
  const am = (day?.slots || []).find((s) => s.bucketKey === "morning");
  if (!am) return "(none)";
  const d = new Date(am.start);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // ---- 0. Find a day the engine actually offers ----------------------
  fs.writeFileSync(path.join(DATA, "leads.json"), JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(DATA, "bookings.json"), JSON.stringify([], null, 2));
  {
    const now = new Date();
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const to = new Date(now.getTime() + 120 * 86400000);
    const url = `http://127.0.0.1:${PORT}/api/booking/availability`
      + `?service=${SERVICE}&address=${encodeURIComponent(ADDRESS)}&from=${key(now)}&to=${key(to)}`;
    const data = await (await fetch(url, { cache: "no-store" })).json();
    const day = (data.days || []).find((d) => (d.slots || []).some((s2) => s2.bucketKey === "morning"));
    const am = day && day.slots.find((s2) => s2.bucketKey === "morning");
    if (!am) {
      // No bookable morning anywhere in the horizon (season shut, or the
      // calendar is full). Nothing to assert about slot release; say so
      // rather than failing on an unrelated condition.
      console.log("• test-booking-lifecycle: no bookable morning in the next 120 days — nothing to test, skipping.");
      process.exit(0);
    }
    DAY = day.date;
    SLOT_START = am.start;
  }

  // ---- 1. The lead-snapshot pass ------------------------------------
  writeLeadCase("none");
  const freeDay = await firstMorningStart();
  ok("baseline: an empty day opens its morning slot", /^\d\d:\d\d$/.test(freeDay), freeDay);

  writeLeadCase("live");
  const withLive = await firstMorningStart();
  ok("a LIVE booking on the lead holds its slot (the day shifts)",
    withLive !== freeDay, `free ${freeDay} vs live ${withLive}`);

  for (const dead of ["cancelled", "completed", "no_show"]) {
    writeLeadCase(dead);
    const got = await firstMorningStart();
    ok(`a ${dead.toUpperCase()} booking on the lead gives the slot back`,
      got === freeDay, `expected ${freeDay}, got ${got}`);
  }

  // ---- 2. The canonical bookings.json pass ---------------------------
  // Same states, same answers — the two passes share one rule.
  writeCanonicalCase("none");
  const canonFree = await firstMorningStart();
  ok("baseline holds for the canonical pass too", canonFree === freeDay, `${canonFree} vs ${freeDay}`);

  writeCanonicalCase("live");
  const canonLive = await firstMorningStart();
  ok("a LIVE canonical booking holds its slot",
    canonLive !== canonFree, `free ${canonFree} vs live ${canonLive}`);

  for (const dead of ["cancelled", "completed", "no_show"]) {
    writeCanonicalCase(dead);
    const got = await firstMorningStart();
    ok(`a ${dead.toUpperCase()} canonical booking gives the slot back`,
      got === canonFree, `expected ${canonFree}, got ${got}`);
  }

  // ---- 3. The two passes cannot disagree -----------------------------
  // The regression itself: the same state, expressed either way, must
  // produce the same calendar.
  for (const state of ["live", "cancelled"]) {
    writeLeadCase(state);
    const viaLead = await firstMorningStart();
    writeCanonicalCase(state);
    const viaCanonical = await firstMorningStart();
    ok(`a ${state} booking reads the same whether it lives on the lead or the record`,
      viaLead === viaCanonical, `lead ${viaLead} vs canonical ${viaCanonical}`);
  }
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-booking-lifecycle: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-booking-lifecycle: ${passed} assertions passed`);

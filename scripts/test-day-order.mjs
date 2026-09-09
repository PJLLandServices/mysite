#!/usr/bin/env node
// scripts/test-day-order.mjs
//
// The tech's day list must be in driving order, not booking order.
//
// /api/schedule/today sorted by booking.start, and booking.start is just the
// first free 30-minute mark in the bucket in the order people happened to
// book. Only the Season Plan page ever ran the sequencer. So the field app —
// the one Patrick actually drives from — showed Newmarket 08:00, Thornhill
// 09:30, Newmarket 12:00: across the top of the city and back, because that
// is the order three strangers clicked in.
//
// This suite pins the fix AND its honest limit:
//
//   Sections 1-2: WITHIN a bucket, stops come back in driving order, so two
//   Newmarket jobs are never separated by a Thornhill one.
//
//   Section 3: ACROSS buckets nothing moves. A customer promised a morning
//   is not quietly slid into the afternoon to tidy up a route. Which means a
//   morning-Thornhill / afternoon-Newmarket day still drives out and back —
//   that is a COMPOSITION problem the aggregate geography guard fixes, not an
//   ordering problem, and no amount of re-sorting can fix it without breaking
//   the promise the customer was given.
//
// Run: node scripts/test-day-order.mjs
//
// TIMEZONE. Route days are calendar days in America/Toronto and the server
// pins that on boot. Pinned here too, before any import that does date math,
// or a UTC container reads a 09:00 Toronto booking as 13:00 and calls the
// morning the afternoon.
process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4825;
const TEST_KEY = "day-order-suite-key";
const require2 = createRequire(path.join(ROOT, "package.json"));

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "work-orders.json", "properties.json",
  "customers.json", "users.json", "auth.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const write = (n, v) => fs.writeFileSync(path.join(DATA, `${n}.json`), JSON.stringify(v, null, 2) + "\n");

// Real coordinates: the towns from the day Patrick photographed.
const NEWMARKET = { lat: 44.056, lng: -79.462, source: "google" };
const THORNHILL = { lat: 43.815, lng: -79.420, source: "google" };
const DAY = "2026-09-30";

const lead = (id, town, coords, hhmm, name) => ({
  id,
  customerId: `C-${id}`,
  propertyId: `P-${id}`,
  contact: { name, firstName: name, lastName: "Test", address: `${id} Test St, ${town}, ON`, town },
  booking: {
    start: `${DAY}T${hhmm}:00.000-04:00`,
    end: `${DAY}T${hhmm}:35.000-04:00`,
    serviceKey: "fall_close_4z",
    serviceLabel: "Fall winterization",
    status: "confirmed",
    coords
  }
});

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PJL_TEST_KEY: TEST_KEY },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

let cookie = "";
const today = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/schedule/today?date=${DAY}`, { headers: { cookie } });
  const d = await r.json().catch(() => ({}));
  return d.bookings || d.rows || d.day || [];
};
const townsOf = (rows) => rows.map((r) => (r.town || r.address || "").split(",")[0].trim());

try {
  write("bookings", []); write("work-orders", []); write("customers", []); write("properties", []);
  write("leads", []);
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  fs.rmSync(path.join(DATA, "auth.json"), { force: true });
  const users = require2(path.join(ROOT, "server", "lib", "users.js"));
  await users.create({ email: "day@local.test", name: "Day", role: "admin", password: "local-day-pass-123" });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-2000));

  // The field app is logged in — this endpoint is not public.
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "day@local.test", password: "local-day-pass-123" })
  });
  cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => c.split(";")[0].trim()).find((c) => c.startsWith("pjl_crm_session=")) || "";
  if (!cookie) throw new Error("login failed: " + login.status);

  // ---- 1. The sandwich, inside one bucket -----------------------------
  // Booked in the order Newmarket, Thornhill, Newmarket — which is exactly
  // what three strangers clicking produces. All three are MORNING, so
  // sequencing is free to fix it without touching anyone's promise.
  write("leads", [
    lead("L-NM1", "Newmarket", NEWMARKET, "08:00", "Newmarket One"),
    lead("L-TH1", "Thornhill", THORNHILL, "09:30", "Thornhill One"),
    lead("L-NM2", "Newmarket", NEWMARKET, "11:00", "Newmarket Two")
  ]);

  const rows = await today();
  ok("the day comes back with all three stops", rows.length === 3,
    `${rows.length}: ${JSON.stringify(townsOf(rows))}`);
  const towns = townsOf(rows);
  const thIndex = towns.indexOf("Thornhill");
  ok("Thornhill is not sandwiched between the two Newmarket stops",
    thIndex === 0 || thIndex === towns.length - 1,
    `order came back ${towns.join(" → ")}`);
  ok("…and the two Newmarket stops are next to each other",
    Math.abs(towns.indexOf("Newmarket") - towns.lastIndexOf("Newmarket")) === 1,
    towns.join(" → "));

  // ---- 2. Nobody is dropped, and every row keeps its identity ---------
  const ids = rows.map((r) => r.leadId).sort();
  ok("every booking survives the re-ordering",
    ids.join() === ["L-NM1", "L-NM2", "L-TH1"].join(), ids.join());

  // ---- 3. Buckets are a promise, not a suggestion ---------------------
  // Thornhill in the morning, both Newmarkets in the afternoon. The day
  // still drives out and back — and it MUST, because the alternative is
  // moving a customer who was told "morning" into the afternoon.
  write("leads", [
    lead("L-TH2", "Thornhill", THORNHILL, "09:00", "Thornhill Morning"),
    lead("L-NM3", "Newmarket", NEWMARKET, "13:00", "Newmarket Afternoon"),
    lead("L-NM4", "Newmarket", NEWMARKET, "15:00", "Newmarket Late")
  ]);
  const crossRows = await today();
  const morning = crossRows.filter((r) => new Date(r.start).getHours() < 12);
  const afternoon = crossRows.filter((r) => new Date(r.start).getHours() >= 12);
  ok("a morning booking stays in the morning",
    morning.length === 1 && morning[0].leadId === "L-TH2",
    JSON.stringify(morning.map((r) => r.leadId)));
  ok("afternoon bookings stay in the afternoon",
    afternoon.length === 2, JSON.stringify(afternoon.map((r) => r.leadId)));
  ok("the morning stop is still listed first",
    crossRows[0].leadId === "L-TH2", townsOf(crossRows).join(" → "));

  // ---- 4. The TIMES follow the route, not just the list order ----------
  // Ordering alone would hand the tech 8:00, 11:00, 9:30 — the right route
  // with the times jumping around. Patrick: "Start times inside a bucket are
  // provisional." So a new booking re-cuts its whole day, and because every
  // reader sorts by start, the field app, Today, iCal and the route sheet all
  // agree without any of them changing.
  //
  // Driven through a REAL booking, because the re-stamp hangs off
  // syncBookingFromLead — the one wrapper every booking path goes through.
  // Seeding leads.json alone would prove nothing.
  write("leads", [
    lead("L-A", "Newmarket", NEWMARKET, "08:00", "Newmarket A"),
    lead("L-B", "Thornhill", THORNHILL, "08:30", "Thornhill B"),
    lead("L-C", "Newmarket", NEWMARKET, "09:00", "Newmarket C")
  ]);
  const beforeStamps = JSON.parse(fs.readFileSync(path.join(DATA, "leads.json"), "utf8"))
    .map((l) => `${l.id}@${l.booking.start.slice(11, 16)}`).join(" ");

  const slotsRes = await fetch(`http://127.0.0.1:${PORT}/api/booking/availability`
    + `?service=fall_close_4z&address=${encodeURIComponent("100 Davis Dr, Newmarket, ON L3Y 2N1")}`
    + `&zoneCount=4&days=45`);
  const slotsBody = await slotsRes.json().catch(() => ({}));
  const daySlot = (slotsBody.days || [])
    .flatMap((d) => d.slots || [])
    .find((sl) => String(sl.start).slice(0, 10) === DAY);
  ok("the engine still offers this Newmarket customer the Newmarket day",
    Boolean(daySlot), `no ${DAY} slot offered`);

  if (daySlot) {
    const booked = await fetch(`http://127.0.0.1:${PORT}/api/booking/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pjl-test-key": TEST_KEY },
      body: JSON.stringify({
        serviceKey: "fall_close_4z", slotStart: daySlot.start, zoneCount: 4,
        contact: {
          name: "Newmarket D", firstName: "Newmarket", lastName: "D",
          email: "nmd@example.com", phone: "9055550004",
          address: "100 Davis Dr, Newmarket, ON L3Y 2N1",
          notes: "PJLTEST-ORDER-D — day order suite"
        }
      })
    });
    ok("the booking lands", booked.status === 201 || (await booked.clone().json().catch(() => ({}))).ok === true,
      `${booked.status}`);

    const after = JSON.parse(fs.readFileSync(path.join(DATA, "leads.json"), "utf8"))
      .filter((l) => l.booking?.start?.startsWith(DAY) || String(l.booking?.start || "").includes(DAY));
    const stamps = after
      .slice()
      .sort((a, b) => new Date(a.booking.start) - new Date(b.booking.start))
      .map((l) => ({ id: l.id, town: l.contact?.town || "Newmarket" }));
    const townOrder = stamps.map((x) => x.town);
    ok("booking re-cut the day's stamps", 
      JSON.parse(fs.readFileSync(path.join(DATA, "leads.json"), "utf8"))
        .map((l) => `${l.id}@${String(l.booking?.start || "").slice(11, 16)}`).join(" ") !== beforeStamps,
      `unchanged: ${beforeStamps}`);
    const th = townOrder.indexOf("Thornhill");
    ok("…so that Thornhill is no longer sandwiched between Newmarket stops",
      th === -1 || th === 0 || th === townOrder.length - 1,
      townOrder.join(" → "));
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
  console.error(`\n✗ test-day-order: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-day-order: ${passed} assertions passed`);

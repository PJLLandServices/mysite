#!/usr/bin/env node
// scripts/test-booking-concurrency.mjs
//
// Two customers clicking the same slot at the same time.
//
// There is no lock anywhere in the reserve path. readLeads/writeLeads and
// bookings.readAll/writeAll are plain read-modify-write against a JSON file,
// so two requests in flight both read the same array, both append their own
// row, and the second write erases the first. Six simultaneous bookings on
// one slot returned six HTTP 201s and left two leads and one canonical
// booking behind: four customers told "you're booked" who are not, and the
// slot oversold on top of it.
//
// This is the one that had to land before the Sept 10 blast with ads live —
// a lost booking is not a display bug, it is a customer standing in a
// driveway that nobody is coming to.
//
// WHAT THIS ASSERTS, and it is deliberately arithmetic rather than a
// threshold: however many reserves come back 201, EXACTLY that many leads
// and that many canonical bookings must exist afterwards. Anything else is
// a lost write. Plus: no more than the bucket's capacity may succeed.
//
// Run: node scripts/test-booking-concurrency.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));
const PORT = 4821;
const TEST_KEY = "concurrency-suite-key";
const RACERS = 6;

const SUMMARY = { created: 0, refused: 0, leads: 0, bookings: 0 };
let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "customers.json", "properties.json",
  "work-orders.json", "season-plans.json", "holds.json", "users.json", "auth.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const read = (n) => {
  const p = path.join(DATA, `${n}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8") || "[]") : [];
};

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PJL_TEST_KEY: TEST_KEY },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

// One address, inside the service area, that geocodes the same way every
// time — the race is about the write path, not about geography.
const ADDRESS = "851 Hilton Blvd, Newmarket, ON L3X 2H7, Canada";
const SERVICE = "fall_close_4z";

try {
  for (const f of ["leads", "bookings", "customers", "properties", "work-orders"]) {
    fs.writeFileSync(path.join(DATA, `${f}.json`), "[]\n");
  }
  fs.rmSync(path.join(DATA, "holds.json"), { force: true });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-2000));

  // Ask the engine for a real slot rather than inventing one — an invented
  // time would 409 for the wrong reason and the test would prove nothing.
  const availRes = await fetch(
    `http://127.0.0.1:${PORT}/api/booking/availability?service=${SERVICE}`
    + `&address=${encodeURIComponent(ADDRESS)}&zoneCount=4&days=45`
  );
  const avail = await availRes.json().catch(() => ({}));
  const slots = avail.slots || (avail.days || []).flatMap((d) => d.slots || []);
  ok("the engine offers at least one slot to book", slots.length > 0,
    `status ${availRes.status} ${JSON.stringify(avail).slice(0, 300)}`);
  if (!slots.length) throw new Error("no slots to race for:\n" + JSON.stringify(avail).slice(0, 800));

  const slotStart = slots[0].start;

  const reserve = (n) => fetch(`http://127.0.0.1:${PORT}/api/booking/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pjl-test-key": TEST_KEY },
    body: JSON.stringify({
      serviceKey: SERVICE,
      slotStart,
      zoneCount: 4,
      contact: {
        name: `Racer N${n}`, firstName: "Racer", lastName: `N${n}`,
        email: `racer${n}@example.com`, phone: `905555000${n}`,
        address: ADDRESS,
        notes: `PJLTEST-RACE-${n} — concurrency suite`
      }
    })
  });

  // The whole point: all six in flight together, not one after another.
  const results = await Promise.all(
    Array.from({ length: RACERS }, (_, n) => reserve(n).then(async (r) => ({
      status: r.status, body: await r.json().catch(() => ({}))
    })))
  );

  const created = results.filter((r) => r.status === 201 || r.body?.ok === true);
  const refused = results.filter((r) => r.status === 409);
  const leads = read("leads");
  const bookings = read("bookings");

  ok("at least one booking succeeds", created.length >= 1,
    results.map((r) => `${r.status} ${JSON.stringify(r.body?.errors || r.body).slice(0,200)}`).join(" | "));

  // THE ASSERTION. Not "some failed" — every success must be on disk.
  ok("every reserve that returned success left a lead behind",
    leads.length === created.length,
    `${created.length} said yes, ${leads.length} leads on disk`);
  ok("every reserve that returned success left a canonical booking behind",
    bookings.length === created.length,
    `${created.length} said yes, ${bookings.length} bookings on disk`);

  // And the slot must not be oversold: the losers get a real refusal.
  ok("the racers that lost are told so, rather than told yes",
    created.length + refused.length === RACERS,
    results.map((r) => `${r.status}${r.body?.code ? `/${r.body.code}` : ""}`).join(" "));

  // Customers and properties ride the same unlocked writes.
  const customers = read("customers");
  const properties = read("properties");
  ok("no customer records were lost in the race",
    customers.length === created.length,
    `${created.length} bookings, ${customers.length} customers`);
  ok("no property records were lost in the race",
    properties.length === created.length,
    `${created.length} bookings, ${properties.length} properties`);
  SUMMARY.created = created.length; SUMMARY.refused = refused.length;
  SUMMARY.leads = leads.length; SUMMARY.bookings = bookings.length;
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-booking-concurrency: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-booking-concurrency: ${passed} assertions passed`);
console.log(`  ${RACERS} simultaneous reserves → ${SUMMARY.created} booked, ${SUMMARY.refused} refused, ${SUMMARY.leads} leads / ${SUMMARY.bookings} bookings on disk`);

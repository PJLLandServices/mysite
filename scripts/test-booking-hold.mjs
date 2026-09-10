#!/usr/bin/env node
// scripts/test-booking-hold.mjs
//
// The ten minutes between picking a time and confirming it.
//
// Reserve is atomic (test-booking-concurrency.mjs), so two people can no
// longer both be told yes. But the loser still lost AFTER typing their name,
// phone, address and zone count — the slot was never theirs while they filled
// in the form. With ads live and several people on the page that is a form
// filled in for nothing, which reads as a broken website.
//
// A hold takes the slot out of the pool for ten minutes and confirming
// converts it. The assertions that matter:
//   - a held slot stops being offered to anybody else (not merely blocked at
//     the end — OFFERED, because that is where the wasted typing happens)
//   - an expired hold gives the slot straight back, and expiry is decided on
//     READ, so a stalled sweeper cannot make the calendar look full
//   - a public booking with no hold is refused, with a message that sends the
//     customer back to pick rather than telling them to try again
//   - a hold is single-use: replaying the token does not book twice
//   - re-picking releases the previous hold instead of eating two units
//
// Run: node scripts/test-booking-hold.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));
const PORT = 4823;
const TEST_KEY = "hold-suite-key";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "customers.json", "properties.json",
  "work-orders.json", "holds.json"];
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

const ADDRESS = "851 Hilton Blvd, Newmarket, ON L3X 2H7, Canada";
const SERVICE = "fall_close_4z";
const base = `http://127.0.0.1:${PORT}`;

const slotsFor = async () => {
  const r = await fetch(`${base}/api/booking/availability?service=${SERVICE}`
    + `&address=${encodeURIComponent(ADDRESS)}&zoneCount=4&days=45`);
  const d = await r.json().catch(() => ({}));
  return (d.days || []).flatMap((day) => day.slots || []);
};

const hold = (slotStart, releaseToken) => fetch(`${base}/api/booking/hold`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ serviceKey: SERVICE, slotStart, address: ADDRESS, releaseToken })
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const reserve = (slotStart, holdToken, n, extraHeaders = {}) => fetch(`${base}/api/booking/reserve`, {
  method: "POST",
  headers: { "content-type": "application/json", ...extraHeaders },
  body: JSON.stringify({
    serviceKey: SERVICE, slotStart, zoneCount: 4, holdToken,
    contact: {
      name: `Holder ${n}`, firstName: "Holder", lastName: `N${n}`,
      email: `holder${n}@example.com`, phone: `905555111${n}`,
      address: ADDRESS, notes: `PJLTEST-HOLD-${n} — hold suite`
    }
  })
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  for (const f of ["leads", "bookings", "customers", "properties", "work-orders"]) {
    fs.writeFileSync(path.join(DATA, `${f}.json`), "[]\n");
  }
  fs.rmSync(path.join(DATA, "holds.json"), { force: true });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${base}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-2000));

  const before = await slotsFor();
  ok("the engine offers slots to hold", before.length > 0, `${before.length}`);
  const target = before[0].start;

  // ---- 1. Holding takes the slot out of the pool ------------------------
  const first = await hold(target);
  ok("picking a time returns a hold token", first.status === 201 && Boolean(first.body.holdToken),
    `${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
  ok("…with an expiry the customer can be shown", Boolean(first.body.expiresAt));

  const during = await slotsFor();
  ok("a held slot is no longer OFFERED to anyone else",
    !during.some((s) => s.start === target),
    "the next customer would have filled in the whole form for a taken slot");

  // ---- 2. A second person cannot hold or book it ------------------------
  const second = await hold(target);
  ok("a second customer cannot hold the same slot",
    second.status === 409 && second.body.code === "slot_taken",
    `${second.status} ${JSON.stringify(second.body).slice(0, 160)}`);

  // ---- 3. No hold, no public booking ------------------------------------
  const naked = await reserve(target, undefined, 9);
  ok("a public booking with no hold is refused",
    naked.status === 409 && naked.body.code === "hold_required",
    `${naked.status} ${JSON.stringify(naked.body).slice(0, 160)}`);
  ok("…and nothing was written", read("leads").length === 0);

  // ---- 4. The holder books, and the hold is spent -----------------------
  const booked = await reserve(target, first.body.holdToken, 1);
  ok("the holder books the slot they were holding",
    booked.status === 201 || booked.body.ok === true,
    `${booked.status} ${JSON.stringify(booked.body).slice(0, 200)}`);
  ok("…and exactly one lead exists", read("leads").length === 1);
  ok("the hold is consumed, not left lying around",
    read("holds").length === 0, JSON.stringify(read("holds")).slice(0, 160));

  const replay = await reserve(target, first.body.holdToken, 2);
  ok("replaying a spent hold token does not book twice",
    replay.status >= 400 && read("leads").length === 1,
    `${replay.status}, ${read("leads").length} leads`);

  // ---- 5. Expiry is decided on read ------------------------------------
  // Write a hold that lapsed a minute ago straight into the store. If expiry
  // depended on the sweeper having run, this slot would still look taken.
  const remaining = (await slotsFor())[0];
  ok("there is another slot to test expiry with", Boolean(remaining));
  const stale = {
    token: "stale-token-for-the-suite",
    slotStart: remaining.start,
    slotEnd: remaining.end,
    dateKey: String(remaining.start).slice(0, 10),
    bucketKey: remaining.bucketKey || null,
    serviceKey: SERVICE,
    coords: null,
    createdAt: new Date(Date.now() - 20 * 60000).toISOString(),
    expiresAt: new Date(Date.now() - 60000).toISOString()
  };
  fs.writeFileSync(path.join(DATA, "holds.json"), JSON.stringify([stale], null, 2) + "\n");

  const afterExpiry = await slotsFor();
  ok("an expired hold gives the slot straight back",
    afterExpiry.some((s) => s.start === remaining.start),
    "a lapsed hold is still holding the calendar shut");
  const expiredReserve = await reserve(remaining.start, stale.token, 3);
  ok("an expired token is refused with a message about the ten minutes",
    expiredReserve.status === 409 && expiredReserve.body.code === "hold_expired",
    `${expiredReserve.status} ${JSON.stringify(expiredReserve.body).slice(0, 160)}`);

  // ---- 6. Changing your mind releases the first hold --------------------
  fs.writeFileSync(path.join(DATA, "holds.json"), "[]\n");
  const open = await slotsFor();
  const a = open[0].start;
  const b = open.find((s) => s.start !== a)?.start;
  ok("two open slots to swap between", Boolean(b));
  const holdA = await hold(a);
  const holdB = await hold(b, holdA.body.holdToken);
  ok("re-picking gives a new hold", holdB.status === 201 && Boolean(holdB.body.holdToken));
  ok("…and releases the first, rather than eating two units of capacity",
    read("holds").length === 1,
    `${read("holds").length} holds live`);

  const backAgain = await slotsFor();
  ok("the abandoned slot is offered again straight away",
    backAgain.some((s) => s.start === a));

  // ---- 7. The load-test path still works --------------------------------
  // Patrick's bot posts reserve directly. PJL_TEST_KEY is server-side and
  // comes off Render after the blast; until then the bot must keep running.
  fs.writeFileSync(path.join(DATA, "holds.json"), "[]\n");
  const botSlot = (await slotsFor())[0].start;
  const bot = await reserve(botSlot, undefined, 4, { "x-pjl-test-key": TEST_KEY });
  ok("the load-test bot can still book without holding first",
    bot.status === 201 || bot.body.ok === true,
    `${bot.status} ${JSON.stringify(bot.body).slice(0, 160)}`);
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-booking-hold: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-booking-hold: ${passed} assertions passed`);

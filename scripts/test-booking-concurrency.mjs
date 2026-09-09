#!/usr/bin/env node
// scripts/test-booking-concurrency.mjs
//
// THE INVARIANT: a slot is booked by at most as many people as it holds,
// and every booking that was confirmed (HTTP 201) exists on disk.
//
// WHY THIS EXISTS. Reproduced 2026-09-09 against a booted copy of the
// server: six simultaneous POST /api/booking/reserve on one slot returned
// six 201s, and leads.json held TWO of them with ONE canonical booking.
// Reserve is a chain of read-modify-write steps over leads.json,
// customers.json, properties.json and bookings.json; every `await` in
// that chain is a place a second request can interleave, so both see the
// slot free, both write, and the later leads.json write drops the earlier
// lead. Nothing held a slot between the calendar render and Confirm
// either — a customer typing their name for two minutes had no claim on
// the time they were typing towards.
//
// The fix (spec §2.5, Patrick's decision 5, 2026-09-09):
//   - POST /api/booking/hold takes a 10-minute hold when a time is picked;
//     it occupies bucket capacity; reserve REQUIRES it for a public
//     standard slot and consumes it on success.
//   - reserve + hold + the heal sweep run under ONE process-wide mutex
//     (lib/booking-lock.js); every JSON store writes stage-then-rename.
//
// HOW. Boots the real server once (PJL_TEST_KEY set so the anti-bot
// rate limit and notifications stand aside, PJL_HOLD_TTL_MS shortened so
// expiry is testable), rewrites the fixture files between sections, and
// drives the PUBLIC endpoints with real concurrent fetches. No stubs.
//
// Run: node scripts/test-booking-concurrency.mjs  (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4798;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_KEY = "concurrency-suite";
const HOLD_TTL_MS = 6000;
const SERVICE = "fall_close_4z";
const ADDRESS = "102 Main St, Newmarket, ON";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Fixtures --------------------------------------------------------
// Reserve writes five stores. All five are restored afterwards; nothing
// else in server/data is touched.
fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "holds.json", "customers.json", "properties.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
function resetFixtures() {
  for (const f of TOUCHED) fs.writeFileSync(path.join(DATA, f), "[]\n");
}
function readStore(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8") || "[]"); } catch { return []; }
}

// ---- HTTP helpers ----------------------------------------------------
async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pjl-test-key": TEST_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
async function availability({ from, to, hold = "" }) {
  const url = `${BASE}/api/booking/availability?service=${SERVICE}&address=${encodeURIComponent(ADDRESS)}`
    + `&from=${from}&to=${to}${hold ? `&hold=${encodeURIComponent(hold)}` : ""}`;
  return (await fetch(url, { cache: "no-store" })).json();
}
function offeredStarts(data) {
  const out = [];
  for (const d of data.days || []) for (const s of d.slots || []) out.push(s.start);
  return out;
}
let seq = 0;
function reservePayload(slotStart, holdToken, extra = {}) {
  seq += 1;
  return {
    serviceKey: SERVICE,
    slotStart,
    holdToken: holdToken || null,
    zoneCount: "4",
    contact: {
      firstName: "Concurrency",
      lastName: `Probe${seq}`,
      name: `Concurrency Probe${seq}`,
      email: `pjltest-concurrency-${seq}@example.com`,
      phone: `905-555-0${String(100 + seq).slice(-3)}`,
      address: ADDRESS,
      notes: "PJLTEST-concurrency suite"
    },
    ...extra
  };
}
const hold = (slotStart, extra = {}) => post("/api/booking/hold", { serviceKey: SERVICE, address: ADDRESS, slotStart, ...extra });
const reserve = (slotStart, holdToken, extra) => post("/api/booking/reserve", reservePayload(slotStart, holdToken, extra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---- Boot ------------------------------------------------------------
resetFixtures();
const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PJL_TEST_KEY: TEST_KEY,
    PJL_HOLD_TTL_MS: String(HOLD_TTL_MS),
    // Never let this suite talk to Google or send anything.
    GOOGLE_MAPS_SERVER_KEY: "",
    TURNSTILE_SECRET_KEY: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    await sleep(200);
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // ---- 0. Discover offered slots ------------------------------------
  const now = new Date();
  const FROM = dateKey(now);
  const TO = dateKey(new Date(now.getTime() + 120 * 86400000));
  const initial = await availability({ from: FROM, to: TO });
  const starts = offeredStarts(initial);
  if (starts.length < 6) {
    console.log(`• test-booking-concurrency: only ${starts.length} bookable slots in the next 120 days — need 6, skipping.`);
    process.exit(0);
  }
  const SLOT = starts[0];
  const slotDay = dateKey(new Date(SLOT));
  const offeredOn = async (h = "") => offeredStarts(await availability({ from: slotDay, to: slotDay, hold: h }));

  // ---- 1. A public reserve without a hold is refused ----------------
  {
    const r = await reserve(SLOT, null);
    ok("reserve without a hold → 409 hold_required", r.status === 409 && r.data.code === "hold_required", `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    ok("…and writes nothing", readStore("leads.json").length === 0 && readStore("bookings.json").length === 0);
  }

  // ---- 2. Six people pick the same time in the same instant ---------
  let winningToken = null;
  {
    const results = await Promise.all(Array.from({ length: 6 }, () => hold(SLOT)));
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409 && r.data.code === "slot_taken");
    ok("six concurrent holds on one slot → exactly one 201", won.length === 1, `${won.length} won; statuses ${results.map((r) => r.status).join(",")}`);
    ok("…and five 409 slot_taken", lost.length === 5, `${lost.length} lost`);
    winningToken = won[0]?.data?.holdToken || null;
    ok("the winner gets a token, an expiry and the bucket", Boolean(winningToken) && Boolean(won[0]?.data?.expiresAt) && won[0]?.data?.start === SLOT);
    ok("holds.json carries exactly one live hold", readStore("holds.json").length === 1);
    const after = await offeredOn();
    ok("a held slot is no longer offered to others", !after.includes(SLOT), `offered: ${after.join(", ")}`);
    const mine = await offeredOn(winningToken);
    ok("…but is still offered to the holder (hold= excludes their own)", mine.includes(SLOT), `offered: ${mine.join(", ")}`);
  }

  // ---- 3. Six concurrent reserves on that slot, one with the hold ----
  {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => reserve(SLOT, i === 3 ? winningToken : null)));
    const created = results.filter((r) => r.status === 201);
    ok("six concurrent reserves on one slot → exactly one 201", created.length === 1, `statuses ${results.map((r) => `${r.status}:${r.data.code || "ok"}`).join(",")}`);
    ok("…the one with the hold", results[3].status === 201, `${results[3].status} ${results[3].data.code || ""}`);
    ok("…and five refusals", results.filter((r) => r.status === 409).length === 5);
    const leads = readStore("leads.json");
    const bks = readStore("bookings.json");
    ok("leads.json holds exactly the 201s (1)", leads.length === 1, `${leads.length}`);
    ok("bookings.json holds exactly the 201s (1)", bks.length === 1, `${bks.length}`);
    ok("the booking sits on the requested slot", leads[0]?.booking?.start === SLOT && bks[0]?.scheduledFor === SLOT);
    ok("the consumed hold is gone", readStore("holds.json").length === 0);
    const after = await offeredOn();
    ok("a booked slot is not offered again", !after.includes(SLOT));
    const again = await reserve(SLOT, winningToken);
    ok("re-using a consumed hold → 409 hold_expired", again.status === 409 && again.data.code === "hold_expired", `${again.status} ${again.data.code}`);
  }

  // ---- 4. Six concurrent reserves on six DIFFERENT slots -------------
  // THE DATA-LOSS CASE. Six valid bookings fired together must all land:
  // the count of 201s and the count of records on disk must agree.
  // Against the pre-lock server this fails — 6×201, fewer leads.
  resetFixtures();
  {
    const six = starts.slice(0, 6);
    const tokens = [];
    for (const s of six) {
      const h = await hold(s);
      tokens.push(h.status === 201 ? h.data.holdToken : null);
    }
    ok("six sequential holds on six distinct slots all succeed", tokens.every(Boolean), tokens.map((t) => (t ? "ok" : "no")).join(","));
    const results = await Promise.all(six.map((s, i) => reserve(s, tokens[i])));
    const created = results.filter((r) => r.status === 201).length;
    ok("six concurrent reserves on six slots → six 201s", created === 6, `statuses ${results.map((r) => `${r.status}:${r.data.code || "ok"}`).join(",")}`);
    const leads = readStore("leads.json");
    const bks = readStore("bookings.json");
    ok("leads.json holds every confirmed booking (no lost writes)", leads.length === created, `${leads.length} leads for ${created} confirmations`);
    ok("bookings.json holds every confirmed booking", bks.length === created, `${bks.length} records for ${created} confirmations`);
    ok("every lead has its canonical record", leads.every((l) => bks.some((b) => b.leadId === l.id)));
    ok("customers.json is not corrupted", Array.isArray(readStore("customers.json")));
    ok("properties.json is not corrupted", Array.isArray(readStore("properties.json")));
    ok("no hold survives its reserve", readStore("holds.json").length === 0);
  }

  // ---- 5. Expiry --------------------------------------------------------
  resetFixtures();
  {
    const h = await hold(SLOT);
    ok("a fresh hold succeeds", h.status === 201);
    const token = h.data.holdToken;
    ok("the hold advertises the shortened TTL under test", Date.parse(h.data.expiresAt) - Date.now() <= HOLD_TTL_MS + 500);
    ok("held → not offered", !(await offeredOn()).includes(SLOT));
    await sleep(HOLD_TTL_MS + 700);
    ok("expired → offered again without any sweep", (await offeredOn()).includes(SLOT));
    const r = await reserve(SLOT, token);
    ok("reserve with an expired hold → 409 hold_expired", r.status === 409 && r.data.code === "hold_expired", `${r.status} ${r.data.code}`);
    ok("…and writes nothing", readStore("leads.json").length === 0);
  }

  // ---- 6. Release + replace ---------------------------------------------
  resetFixtures();
  {
    const a = await hold(SLOT);
    const rel = await post("/api/booking/hold/release", { holdToken: a.data.holdToken });
    ok("release answers ok + released", rel.status === 200 && rel.data.released === true, JSON.stringify(rel.data));
    ok("released → offered again", (await offeredOn()).includes(SLOT));
    const rel2 = await post("/api/booking/hold/release", { holdToken: a.data.holdToken });
    ok("releasing twice is harmless", rel2.status === 200 && rel2.data.released === false);

    // Change of mind: hold A, then hold B naming A as previous → A gone.
    const first = await hold(SLOT);
    const other = starts.find((s) => s !== SLOT);
    const second = await hold(other, { previousHoldToken: first.data.holdToken });
    ok("re-holding with previousHoldToken succeeds", second.status === 201, `${second.status} ${second.data.code || ""}`);
    ok("…and releases the earlier hold (one customer, one hold)", readStore("holds.json").length === 1 && (await offeredOn()).includes(SLOT));
    const stale = await reserve(SLOT, first.data.holdToken);
    ok("the replaced token no longer reserves", stale.status === 409 && stale.data.code === "hold_expired", `${stale.status} ${stale.data.code}`);
    const wrong = await reserve(SLOT, second.data.holdToken);
    ok("a hold for another slot does not reserve this one → hold_mismatch", wrong.status === 409 && wrong.data.code === "hold_mismatch", `${wrong.status} ${wrong.data.code}`);
  }

  // ---- 7. Standby (open bucket) needs no hold ---------------------------
  resetFixtures();
  {
    const r = await post("/api/booking/reserve", { ...reservePayload(null, null), slotStart: null, standby: true });
    ok("open-bucket reserve still needs no hold", r.status === 201 && r.data.standby === true, `${r.status} ${r.data.code || ""}`);
  }

  // ---- 8. Atomic writes leave no staging files ------------------------
  {
    const leftovers = fs.readdirSync(DATA).filter((f) => /\.tmp$/.test(f));
    ok("no .tmp staging files left behind", leftovers.length === 0, leftovers.join(", "));
  }
} catch (err) {
  failures.push(`suite crashed: ${err?.stack || err}`);
} finally {
  child.kill();
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { try { fs.unlinkSync(p); } catch {} } else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`✗ test-booking-concurrency: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  - " + f);
  if (process.env.DEBUG_LOGS) console.error(logs.slice(-3000));
  process.exit(1);
}
console.log(`✓ test-booking-concurrency: ${passed} assertions passed`);

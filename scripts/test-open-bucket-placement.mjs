#!/usr/bin/env node
// scripts/test-open-bucket-placement.mjs
//
// The overflow that failed on arrival.
//
// Patrick's rule is that we never turn a customer down: past the corridor
// cap they go into the open bucket and get picked up "on our way home". The
// Season Plan ranks each standby customer against the upcoming route days —
// that part works. Placing one did not.
//
// The Book + notify button hard-coded 13:00 as the anchor minute, so the
// placement collided with whatever already sat at 13:00 and came back
// 409 physical_conflict — on exactly the days the panel had just
// recommended. And the geographic re-stamp (#180) made that worse rather
// than better: the afternoon now fills from 12:00 in half-hour steps, so
// 13:00 is precisely where the third afternoon booking lands.
//
// It also asked for no capacity or geography check of its own. A placement
// is a booking; it has to obey the same bucket cap and the same corridor as
// one, or the open bucket becomes a side door into a full day.
//
// TIMEZONE. Route days are calendar days in America/Toronto and the server
// pins that on boot. Pinned here too, before any date math.
process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));
const PORT = 4831;
// Computed, not written down: the server reads the real clock, and a fixed
// date goes into the past (test-day-order's did on 2026-10-01). The next
// weekday at least three days out, inside the fall public window.
const seasonsLib = require2(path.join(ROOT, "server", "lib", "seasons.js"));
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function pickTestDay() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(today); d.setDate(d.getDate() + 3);
  const fall = seasonsLib.publicBookingStatus("fall", dateKey(today));
  const from = fall && (fall.from || fall.startsOn);
  if (from && dateKey(d) < from) { const [y, m, dd] = from.split("-").map(Number); d.setFullYear(y, m - 1, dd); }
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return dateKey(d);
}
const DAY = pickTestDay();
// Toronto's UTC offset on DAY (-04:00 in summer time, -05:00 after the
// November clock change) — the fixture's bookings must sit on local
// afternoon minutes whatever the season.
const OFF = (() => {
  const m = /GMT([+-]\d+)/.exec(new Date(`${DAY}T12:00:00Z`).toLocaleString("en-US", { timeZone: "America/Toronto", timeZoneName: "shortOffset" }));
  const h = m ? Number(m[1]) : -4;
  return `${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
})();
// The admin tail: the first weekday after the public window closes, which
// the engine never offers and the open bucket must still reach.
function pickTailDay() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fall = seasonsLib.publicBookingStatus("fall", dateKey(today));
  if (!fall || !fall.through) return null;
  const [y, m, dd] = fall.through.split("-").map(Number);
  const d = new Date(y, m - 1, dd); d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return dateKey(d) > dateKey(today) ? dateKey(d) : null;
}
const TAIL = pickTailDay();

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "work-orders.json", "properties.json",
  "customers.json", "holds.json", "users.json", "auth.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const write = (n, v) => fs.writeFileSync(path.join(DATA, `${n}.json`), JSON.stringify(v, null, 2) + "\n");
const read = (n) => {
  const p = path.join(DATA, `${n}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8") || "[]") : [];
};

// All Newmarket, so geography is never the reason anything is refused —
// this suite is about the anchor minute and the capacity check.
const NEWMARKET = { lat: 44.056, lng: -79.462, source: "google" };
const booked = (id, hhmm) => ({
  id, customerId: `C-${id}`, propertyId: `P-${id}`,
  contact: { name: `Booked ${id}`, address: `${id} Main St, Newmarket, ON`, town: "Newmarket" },
  booking: {
    start: `${DAY}T${hhmm}:00.000${OFF}`, end: `${DAY}T${hhmm}:30.000${OFF}`,
    serviceKey: "fall_close_4z", serviceLabel: "Fall winterization",
    status: "confirmed", coords: NEWMARKET
  }
});
const standby = (id) => ({
  id, contact: { name: "Standby Sam", firstName: "Standby", lastName: "Sam",
    email: "sam@example.com", phone: "9055550009",
    address: "100 Davis Dr, Newmarket, ON L3Y 2N1", town: "Newmarket" },
  standby: {
    serviceKey: "fall_close_4z", serviceLabel: "Fall winterization",
    zoneCount: 4, requestedAt: "2026-09-09T10:00:00.000Z",
    resolved: true, coords: NEWMARKET
  }
});

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });
const base = `http://127.0.0.1:${PORT}`;
let cookie = "";

const post = (url, body) => fetch(base + url, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body)
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  // The afternoon already runs 12:00, 12:30, 13:00 — which is exactly what
  // the re-stamp produces once three people book an afternoon.
  write("leads", [booked("L-A", "12:00"), booked("L-B", "12:30"), booked("L-C", "13:00"), standby("L-SB")]);
  write("bookings", []); write("work-orders", []); write("customers", []); write("properties", []);
  fs.rmSync(path.join(DATA, "holds.json"), { force: true });
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  fs.rmSync(path.join(DATA, "auth.json"), { force: true });
  const users = require2(path.join(ROOT, "server", "lib", "users.js"));
  await users.create({ email: "ob@local.test", name: "OB", role: "admin", password: "local-ob-pass-123" });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${base}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-2000));

  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ob@local.test", password: "local-ob-pass-123" })
  });
  cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => c.split(";")[0].trim()).find((c) => c.startsWith("pjl_crm_session=")) || "";
  if (!cookie) throw new Error("login failed: " + login.status);

  // ---- 1. The panel still ranks the day ---------------------------------
  const sb = await fetch(`${base}/api/standby`, { headers: { cookie } }).then((r) => r.json());
  ok("the standby customer is waiting in the open bucket", sb.waiting === 1, JSON.stringify(sb).slice(0, 200));

  // ---- 2. THE DEFECT: the hard-coded anchor collides ---------------------
  // This is precisely what the Book + notify button sends today.
  const collide = await post("/api/booking/reserve", {
    leadId: "L-SB", serviceKey: "fall_close_4z",
    slotStart: new Date(`${DAY}T13:00:00.000${OFF}`).toISOString(),
    source: "admin_custom", zoneCount: 4,
    contact: { address: "100 Davis Dr, Newmarket, ON L3Y 2N1" }
  });
  ok("the hard-coded 13:00 anchor collides with the day's third afternoon stop",
    collide.status === 409 && collide.body.code === "physical_conflict",
    `${collide.status} ${JSON.stringify(collide.body).slice(0, 160)}`);
  ok("…and the standby customer is still waiting, unplaced",
    read("leads").find((l) => l.id === "L-SB") && !read("leads").find((l) => l.id === "L-SB").booking);

  // ---- 3. Placement asks the engine instead ------------------------------
  // Exactly what the Book + notify button now does: resolve the slot, then
  // book it through the ordinary book-from-lead path.
  const slot = await post("/api/admin/open-bucket/slot", { leadId: "L-SB", date: DAY });
  ok("the engine hands back a real slot for the recommended day",
    slot.status === 200 && Boolean(slot.body.slotStart),
    `${slot.status} ${JSON.stringify(slot.body).slice(0, 200)}`);
  ok("…and it is NOT the old hard-coded 13:00 anchor",
    slot.body.slotStart !== new Date(`${DAY}T13:00:00.000${OFF}`).toISOString(),
    slot.body.slotStart);
  ok("…it is in the afternoon, which is what 'on our way home' means",
    slot.body.slotStart ? new Date(slot.body.slotStart).getHours() >= 12 : false,
    slot.body.slotStart);
  ok("…on the day that was asked for",
    new Date(slot.body.slotStart).toLocaleDateString("en-CA") === DAY,
    slot.body.slotStart);

  const placed = await post("/api/booking/reserve", {
    leadId: "L-SB", serviceKey: "fall_close_4z",
    slotStart: slot.body.slotStart, source: "admin_custom", zoneCount: 4,
    contact: { address: "100 Davis Dr, Newmarket, ON L3Y 2N1" }
  });
  ok("booking that slot succeeds where the hard-coded one 409'd",
    placed.status === 201 || placed.body.ok === true,
    `${placed.status} ${JSON.stringify(placed.body).slice(0, 200)}`);
  const sbLead = read("leads").find((l) => l.id === "L-SB");
  ok("…the lead now carries a booking", Boolean(sbLead?.booking?.start));
  ok("…and is not stacked on top of an existing stop",
    read("leads").filter((l) => l.booking?.start === sbLead?.booking?.start).length === 1,
    "two bookings share one start time");

  // ---- 4. A placement is a booking, so it obeys the same limits ----------
  // Fill the afternoon to its cap, then ask again. The refusal must name a
  // reason — a 404 from a missing endpoint would satisfy "status >= 400"
  // and prove nothing, which is why this asserts the code.
  // Every half-hour from noon to close, so the afternoon is genuinely full.
  // (bucketCap is a separate lever and comes from the season plan, which this
  // fixture deliberately doesn't have — this asserts the engine's own "no
  // room left", not the cap.)
  const fullAfternoon = ["12:00","12:30","13:00","13:30","14:00",
    "14:30","15:00","15:30","16:00","16:30"]
    .map((hhmm, i) => booked(`L-F${i}`, hhmm));
  write("leads", [...fullAfternoon, standby("L-SB2")]);
  const overCap = await post("/api/admin/open-bucket/slot", { leadId: "L-SB2", date: DAY });
  ok("a physically full afternoon refuses rather than stacking two stops on one minute",
    overCap.status === 409, `${overCap.status} ${JSON.stringify(overCap.body).slice(0, 200)}`);
  ok("…naming the reason, so Patrick can pick the other half or another day",
    overCap.body.code === "no_room",
    JSON.stringify(overCap.body).slice(0, 200));
  ok("…leaving that customer in the open bucket",
    !read("leads").find((l) => l.id === "L-SB2")?.booking);

  // ---- 4b. THE PLACEMENT IS PATRICK'S CALL, NOT THE ENGINE'S ------------
  // Patrick, 2026-10-02: "I have someone in an open bucket, but I cannot
  // place them wherever I want." The open bucket holds exactly the
  // customers the public calendar could not seat; asking the same engine
  // for permission to place them refused the placement for the same
  // reason. Now: the engine's slot when it has one, otherwise the first
  // free half-hour of the half he chose — the corridor, the caps and the
  // season window step aside; a physical double-booking never does.

  // The same full afternoon, but he asks for the MORNING: the morning is
  // empty, so the placement lands there.
  const morning = await post("/api/admin/open-bucket/slot", { leadId: "L-SB2", date: DAY, bucket: "morning" });
  ok("the morning can be asked for", morning.status === 200 && morning.body.bucketKey === "morning",
    `${morning.status} ${JSON.stringify(morning.body).slice(0, 200)}`);
  ok("…and the slot is in it", morning.body.slotStart ? new Date(morning.body.slotStart).getHours() < 12 : false,
    morning.body.slotStart);

  // A customer the engine refuses on GEOGRAPHY: Mississauga against an
  // all-Newmarket day is far past the 90-minute service bound, so the
  // public calendar never offers them this day. The placement goes
  // through anyway, and says it was forced.
  const MISSISSAUGA = { lat: 43.5915, lng: -79.6410, source: "google" };
  const far = {
    ...standby("L-FAR"),
    contact: { name: "Far Fay", firstName: "Far", lastName: "Fay", email: "fay@example.com",
      phone: "9055550010", address: "100 City Centre Dr, Mississauga, ON L5B 2C9", town: "Mississauga" }
  };
  far.standby = { ...far.standby, coords: MISSISSAUGA };
  write("leads", [booked("L-A", "12:00"), booked("L-B", "12:30"), far]);
  const forced = await post("/api/admin/open-bucket/slot", { leadId: "L-FAR", date: DAY });
  ok("a customer the engine refuses on geography is still placed — Patrick decided",
    forced.status === 200 && Boolean(forced.body.slotStart),
    `${forced.status} ${JSON.stringify(forced.body).slice(0, 200)}`);
  ok("…and the answer says it was forced past the filter", forced.body.forced === true, JSON.stringify(forced.body).slice(0, 200));
  ok("…in the afternoon he asked for, on a free half-hour",
    forced.body.slotStart ? new Date(forced.body.slotStart).getHours() >= 13 : false, forced.body.slotStart);
  const farBooked = await post("/api/booking/reserve", {
    leadId: "L-FAR", serviceKey: "fall_close_4z",
    slotStart: forced.body.slotStart, source: "admin_custom", zoneCount: 4,
    contact: { address: "100 City Centre Dr, Mississauga, ON L5B 2C9" }
  });
  ok("…and booking that slot goes through the ordinary admin path",
    farBooked.status === 201 || farBooked.body.ok === true,
    `${farBooked.status} ${JSON.stringify(farBooked.body).slice(0, 200)}`);
  ok("…which clears their standby", !read("leads").find((l) => l.id === "L-FAR")?.standby
    && Boolean(read("leads").find((l) => l.id === "L-FAR")?.booking?.start));

  // A date past the public booking window (Nov 1–6 is the admin tail the
  // window reserves for exactly this) — the engine emits no slot there;
  // the placement still lands.
  // ---- 4c. A SPRING OPENING IS NOT PLACED IN OCTOBER --------------------
  // Patrick, 2026-10-02, holding the email "Your PJL service is booked —
  // Spring opening (1-4 zones residential) on Saturday, October 10":
  // "lol ...wtf." The customer had joined the open bucket for a spring
  // opening (the public page lets a season months away be joined), and
  // the placement booked that service on a fall day without a word.
  const springSam = { ...standby("L-SPR") };
  springSam.standby = { ...springSam.standby, serviceKey: "spring_open_4z", serviceLabel: "Spring opening (1-4 zones residential)" };
  write("leads", [springSam]);
  const wrongSeason = await post("/api/admin/open-bucket/slot", { leadId: "L-SPR", date: DAY });
  ok("a spring service on a fall day is refused, by name",
    wrongSeason.status === 422 && wrongSeason.body.code === "service_out_of_season",
    `${wrongSeason.status} ${JSON.stringify(wrongSeason.body).slice(0, 200)}`);
  ok("…and the same band in the day's season is offered back",
    wrongSeason.body.suggestedServiceKey === "fall_close_4z", JSON.stringify(wrongSeason.body).slice(0, 200));
  const rightSeason = await post("/api/admin/open-bucket/slot", { leadId: "L-SPR", date: DAY, serviceKey: "fall_close_4z" });
  ok("placed as the fall band instead, the slot is found", rightSeason.status === 200 && rightSeason.body.serviceKey === "fall_close_4z",
    `${rightSeason.status} ${JSON.stringify(rightSeason.body).slice(0, 200)}`);
  const asFall = await post("/api/booking/reserve", {
    leadId: "L-SPR", serviceKey: rightSeason.body.serviceKey,
    slotStart: rightSeason.body.slotStart, source: "admin_custom", zoneCount: 4,
    contact: { address: "100 Davis Dr, Newmarket, ON L3Y 2N1" }
  });
  ok("…and books as a fall closing", (asFall.status === 201 || asFall.body.ok === true)
    && read("leads").find((l) => l.id === "L-SPR")?.booking?.serviceKey === "fall_close_4z",
    `${asFall.status} ${JSON.stringify(asFall.body).slice(0, 160)}`);
  // The admin custom-time path is the other door, and it is shut too.
  write("leads", [standby("L-SPR2")]);
  const forcedSpring = await post("/api/booking/reserve", {
    leadId: "L-SPR2", serviceKey: "spring_open_4z",
    slotStart: new Date(`${DAY}T13:00:00.000${OFF}`).toISOString(), source: "admin_custom", zoneCount: 4,
    contact: { address: "100 Davis Dr, Newmarket, ON L3Y 2N1" }
  });
  ok("a force-booked spring opening on a fall day is refused at reserve too",
    forcedSpring.status === 422 && forcedSpring.body.code === "service_out_of_season",
    `${forcedSpring.status} ${JSON.stringify(forcedSpring.body).slice(0, 200)}`);
  ok("…leaving that customer waiting", !read("leads").find((l) => l.id === "L-SPR2")?.booking);
  // The rule itself, on the library.
  const ob = require2(path.join(ROOT, "server", "lib", "open-bucket.js"));
  const av = require2(path.join(ROOT, "server", "lib", "availability.js"));
  const se = require2(path.join(ROOT, "server", "lib", "seasons.js"));
  const fit = (k, d) => ob.serviceForDate(k, d, { services: av.BOOKABLE_SERVICES, configFor: se.configFor });
  ok("a repair fits any date", fit("sprinkler_repair", "2026-10-10").ok === true);
  ok("a fall closing fits a fall date", fit("fall_close_6z", "2026-10-10").ok === true);
  ok("a spring opening in October maps to the same fall band",
    JSON.stringify(fit("spring_open_6z", "2026-10-10")) === JSON.stringify({ ok: false, season: "spring", suggestedKey: "fall_close_6z" }),
    JSON.stringify(fit("spring_open_6z", "2026-10-10")));
  ok("a fall closing in April maps to the same spring band",
    fit("fall_close_commercial_8z", "2026-04-10").suggestedKey === "spring_open_commercial_8z",
    JSON.stringify(fit("fall_close_commercial_8z", "2026-04-10")));
  ok("a seasonal service in the dead of winter has no band to offer",
    fit("spring_open_4z", "2026-01-15").ok === false && fit("spring_open_4z", "2026-01-15").suggestedKey === null,
    JSON.stringify(fit("spring_open_4z", "2026-01-15")));

  if (TAIL) {
    write("leads", [standby("L-SB3")]);
    const tail = await post("/api/admin/open-bucket/slot", { leadId: "L-SB3", date: TAIL });
    ok("a date in the admin-reserved tail is placeable",
      tail.status === 200 && tail.body.forced === true
        && new Date(tail.body.slotStart).toLocaleDateString("en-CA") === TAIL,
      `${tail.status} ${JSON.stringify(tail.body).slice(0, 200)}`);
  } else {
    console.log("  (the fall window's tail is behind us — tail placement not exercised today)");
  }

  // ---- 5. An unknown lead is refused cleanly ----------------------------
  // ---- 6. The button no longer carries an anchor minute of its own ------
  // The resolver is only a fix if the Book + notify button actually asks it.
  const PANEL = fs.readFileSync(path.join(ROOT, "server", "season-plan.js"), "utf8");
  ok("the open-bucket button asks the engine for a slot",
    PANEL.includes('/api/admin/open-bucket/slot'));
  ok("…and no longer builds 13:00 itself",
    !PANEL.includes("13, 0, 0"),
    "the hard-coded anchor is still in season-plan.js");

  const nobody = await post("/api/admin/open-bucket/slot", { leadId: "L-NOPE", date: DAY });
  ok("a lead that isn't waiting is refused, by name",
    nobody.status === 404 && nobody.body.code === "not_waiting",
    `${nobody.status} ${JSON.stringify(nobody.body).slice(0, 160)}`);
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-open-bucket-placement: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-open-bucket-placement: ${passed} assertions passed`);

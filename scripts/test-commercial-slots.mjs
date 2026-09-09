#!/usr/bin/env node
// scripts/test-commercial-slots.mjs
//
// A commercial customer had ONE bookable minute per half-day, and lost the
// half-day when it was taken.
//
// Spec §2.9 / D6: "Keep the 30-min walk; present only the bucket label.
// Remove slotIncrementMinutes: 300."
//
// WHAT WENT WRONG. The six commercial services carried
// `slotIncrementMinutes: 300`, documented as making the customer "see
// exactly TWO slots per day — 8:00 AM and 1:00 PM — instead of a full
// half-hour grid". That is not what it did. The engine already emits at
// most one slot per bucket (the `emitted` flag), so the customer saw two
// slots per day either way. What the 300-minute step actually changed is
// how many START TIMES the engine is allowed to TRY inside a bucket:
//
//   morning  08:00–12:00, step 300  → one candidate, 08:00
//   afternoon 12:00–17:00, step 300 → one candidate, 12:00
//
// So if 08:00 was busy — a booking, a block, travel time from the
// previous stop — the engine did not try 08:30. It abandoned the whole
// morning and told a commercial customer there was nothing that day. The
// geographic re-stamp made the afternoon half of this deterministic
// rather than occasional: the afternoon now fills from 12:00 in half-hour
// steps, so 12:00 is exactly where the first afternoon booking sits.
//
// Same shape as the open bucket's hard-coded 13:00 (2026-09-09): a single
// anchor minute standing in for "the afternoon", and a customer turned
// away the moment something else is on it.
//
// WHAT IS PINNED. The fix must do two things, and the second is why this
// suite is not just one assertion:
//   1. A commercial customer is offered a LATER start in a bucket whose
//      first minute is taken — where a residential customer, walking the
//      same day at 30 minutes, always was.
//   2. Nothing the customer sees on a NORMAL day changes: still one slot
//      per bucket, still 08:00 and 12:00 on an empty day, still the
//      "Morning or afternoon" label. Removing a config value must not
//      quietly turn the commercial flow into a half-hour grid.
//
// No server, no network: the engine is called directly, geography off
// (no dayShapes) and the season gate stubbed, so the only variable is the
// increment.
//
// Run: node scripts/test-commercial-slots.mjs  (also in build:check)

// Route days are calendar dates in America/Toronto and the engine walks
// local midnights. Pinned before any import that does date maths, so this
// passes under a UTC CI container too.
process.env.TZ = "America/Toronto";

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const availability = require(path.join(ROOT, "server/lib/availability.js"));
const { listAvailableSlots, BOOKABLE_SERVICES, DEFAULT_HOURS, DEFAULT_SETTINGS } = availability;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const NOW = new Date(2026, 8, 14, 9, 0, 0);            // Mon 14 Sep 2026, 09:00
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = new Date(NOW); DAY.setDate(DAY.getDate() + 7); DAY.setHours(0, 0, 0, 0);
const DAY_KEY = dayKey(DAY);                            // Mon 21 Sep 2026
const at = (hh, mm) => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), hh, mm, 0);

// One address, used for the customer and for whatever is already booked,
// so travel time is the 5-minute floor and cannot be what moves a slot.
const COORDS = { lat: 44.0592, lng: -79.4613, source: "google" };

const COMMERCIAL = "fall_close_commercial";             // 60 min
const RESIDENTIAL = "fall_close_4z";                    // 30 min

const baseArgs = {
  customerCoords: COORDS,
  blocks: [],
  daysAhead: 20,
  hours: DEFAULT_HOURS,
  settings: DEFAULT_SETTINGS,
  // Geography and the season gate have their own suites. Off here, so the
  // only thing that can suppress a slot is the increment under test.
  seasonWindows: () => null,
  now: NOW
};

const onDay = (slots) => slots.filter((s) => dayKey(new Date(s.start)) === DAY_KEY);
const inBucket = (slots, key) => onDay(slots).filter((s) => s.bucketKey === key);
const hhmm = (s) => {
  const d = new Date(s.start);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const startMinutes = (s) => { const d = new Date(s.start); return (d.getHours() * 60) + d.getMinutes(); };

// ---- 1. An empty day is unchanged -----------------------------------
// The promise the 300-minute step was believed to keep is actually kept
// by the bucket design. If that is true, removing it changes nothing
// here — and if this assertion ever fails, the fix has turned the
// commercial flow into the half-hour grid Patrick does not want.
{
  const slots = await listAvailableSlots({ ...baseArgs, serviceKey: COMMERCIAL, bookings: [] });
  const day = onDay(slots);
  ok("an empty day offers a commercial customer exactly two slots",
    day.length === 2, `${day.length}: ${day.map(hhmm).join(", ")}`);
  ok("…one morning, one afternoon",
    inBucket(slots, "morning").length === 1 && inBucket(slots, "afternoon").length === 1,
    day.map((s) => `${s.bucketKey} ${hhmm(s)}`).join(", "));
  ok("…at the top of each bucket",
    inBucket(slots, "morning").map(hhmm)[0] === "08:00"
    && inBucket(slots, "afternoon").map(hhmm)[0] === "12:00",
    day.map(hhmm).join(", "));
}

// ---- 2. The bucket's first minute is taken --------------------------
// The regression itself. One 08:00 job on the day, at the same address,
// so nothing but the walk decides what comes back.
{
  const bookings = [{ start: at(8, 0), end: at(9, 0), coords: COORDS, leadId: "L-EXISTING" }];

  // Control: residential walks the same day at 30 minutes and is offered
  // a later morning. If this fails, the day itself is unbookable and the
  // commercial assertion below would be vacuous.
  const res = await listAvailableSlots({ ...baseArgs, serviceKey: RESIDENTIAL, bookings });
  const resMorning = inBucket(res, "morning");
  ok("control: a residential customer is still offered a morning",
    resMorning.length === 1, `${resMorning.length} slots`);
  ok("control: …starting after the job already on the books",
    resMorning.length === 1 && startMinutes(resMorning[0]) > 8 * 60, resMorning.map(hhmm).join(", "));

  const com = await listAvailableSlots({ ...baseArgs, serviceKey: COMMERCIAL, bookings });
  const comMorning = inBucket(com, "morning");
  ok("a commercial customer is offered a morning too",
    comMorning.length === 1,
    comMorning.length === 0 ? "the whole morning was abandoned because 08:00 was busy" : `${comMorning.length} slots`);
  ok("…starting after the job already on the books",
    comMorning.length === 1 && startMinutes(comMorning[0]) > 8 * 60, comMorning.map(hhmm).join(", "));
  ok("…and still inside the morning bucket, not spilled into the afternoon",
    comMorning.length === 1 && startMinutes(comMorning[0]) < 12 * 60, comMorning.map(hhmm).join(", "));
  ok("…still ONE morning slot, not a half-hour grid", comMorning.length === 1, `${comMorning.length}`);
}

// ---- 3. The afternoon, which the re-stamp made deterministic --------
// Provisional stamps lay the afternoon out from 12:00 in half-hour steps,
// so 12:00 is precisely where the first afternoon booking lands. Under a
// 300-minute step that made "no commercial afternoon" the normal case on
// any day with afternoon work.
{
  const bookings = [{ start: at(12, 0), end: at(12, 30), coords: COORDS, leadId: "L-PM" }];
  const com = await listAvailableSlots({ ...baseArgs, serviceKey: COMMERCIAL, bookings });
  const pm = inBucket(com, "afternoon");
  ok("a booking at 12:00 does not cost the commercial customer the afternoon",
    pm.length === 1,
    pm.length === 0 ? "the whole afternoon was abandoned because 12:00 was busy" : `${pm.length} slots`);
  ok("…the offer moves later in the same bucket",
    pm.length === 1 && startMinutes(pm[0]) > 12 * 60 && startMinutes(pm[0]) < 17 * 60,
    pm.map(hhmm).join(", "));
}

// ---- 4. What the customer is told is unchanged ----------------------
{
  const commercial = Object.entries(BOOKABLE_SERVICES).filter(([k]) => k.includes("commercial"));
  ok("there are commercial services to check", commercial.length === 6, `${commercial.length}`);
  ok("every one still presents the bucket label, not a duration",
    commercial.every(([, s]) => s.displayMinutes === "Morning or afternoon"),
    commercial.map(([k, s]) => `${k}=${s.displayMinutes}`).join(", "));
  ok("every one still blocks its real on-site time",
    commercial.every(([, s]) => Number(s.minutes) >= 60),
    commercial.map(([k, s]) => `${k}=${s.minutes}`).join(", "));

  // The lint that stops it coming back. A per-service increment is the
  // mechanism this suite exists to remove; if one reappears, the service
  // it is on gets one bookable minute per bucket again.
  const withIncrement = Object.entries(BOOKABLE_SERVICES)
    .filter(([, s]) => s.slotIncrementMinutes != null)
    .map(([k]) => k);
  ok("no service overrides the slot increment any more",
    withIncrement.length === 0, withIncrement.join(", "));
}

if (failures.length) {
  console.error(`\n✗ test-commercial-slots: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-commercial-slots: ${pass} assertions passed`);

#!/usr/bin/env node
// scripts/test-seasonal-handoff.mjs
//
// Guards the seasonal booking handoff key.
//
// POST /api/portal/:token/begin-booking mints a booking session carrying a
// `suggestedService`. js/booking.js only honours that value when it exists in
// BOOKABLE_SERVICES; anything else falls through in silence to the unfiltered
// service catalog, so a bad key doesn't error — it just quietly demotes an
// existing customer's express handoff to the generic menu.
//
// The endpoint used to build the key by hand as `..._${zoneCount}z`, which is
// a real key for exactly four zone counts (4, 6, 8, 15). These assertions pin
// the contract that replaced it: every zone count a property can have, on both
// account types, in both seasons, resolves to a key book.html can act on.
//
// Run: node scripts/test-seasonal-handoff.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const { deriveSeasonalKey } = require(path.join(ROOT, 'server/lib/pricing.js'));
const { BOOKABLE_SERVICES } = require(path.join(ROOT, 'server/lib/availability.js'));
const PRICING = require(path.join(ROOT, 'pricing.json'));

let passed = 0;
const failures = [];
function check(ok, msg) {
  if (ok) passed += 1;
  else failures.push(msg);
}

// Mirrors the endpoint: season string -> WO type passed to deriveSeasonalKey.
const woTypeFor = (season) => (season === 'spring' ? 'spring_opening' : 'fall_closing');

// 1. Every zone count 1..50, both seasons, both account types, resolves to a
//    key that book.html recognises AND can book.
for (const season of ['spring', 'fall']) {
  for (const commercial of [false, true]) {
    for (let zones = 1; zones <= 50; zones += 1) {
      const key = deriveSeasonalKey(woTypeFor(season), zones, commercial);
      const meta = key ? BOOKABLE_SERVICES[key] : null;
      check(
        Boolean(meta && meta.bookable),
        `${season}/${commercial ? 'commercial' : 'residential'}/${zones}z -> ${key || '(null)'} is not a bookable service key`
      );
    }
  }
}

// 2. The key names the season it was asked for. A fall handoff landing a
//    customer on a spring tier is the out-of-season-menu bug in a new place.
for (const commercial of [false, true]) {
  for (let zones = 1; zones <= 50; zones += 1) {
    check(
      deriveSeasonalKey('spring_opening', zones, commercial).startsWith('spring_open'),
      `spring/${zones}z did not produce a spring key`
    );
    check(
      deriveSeasonalKey('fall_closing', zones, commercial).startsWith('fall_close'),
      `fall/${zones}z did not produce a fall key`
    );
  }
}

// 3. The key names the right ACCOUNT TYPE. booking.js locks the service in on
//    a session handoff, so a commercial customer handed a residential key is
//    booked at the residential price with no chance to correct it.
for (let zones = 1; zones <= 50; zones += 1) {
  check(
    /_commercial(_|$)/.test(deriveSeasonalKey('fall_closing', zones, true)),
    `commercial/${zones}z produced a residential key`
  );
  check(
    !/_commercial(_|$)/.test(deriveSeasonalKey('fall_closing', zones, false)),
    `residential/${zones}z produced a commercial key`
  );
}

// 4. The tier matches the bracket pricing.json actually publishes — the key is
//    only useful if it names the tier the customer belongs in.
for (const [group, commercial] of [['residential', false], ['commercial', true]]) {
  for (const row of PRICING.seasonal_tiers[group]) {
    const range = String(row.zones);
    const lo = parseInt(range, 10);
    const hi = range.endsWith('+') ? lo + 6 : parseInt(range.split('-')[1], 10);
    for (let zones = lo; zones <= hi; zones += 1) {
      check(
        deriveSeasonalKey('fall_closing', zones, commercial) === row.key_fall,
        `${group}/${zones}z resolved outside its pricing.json bracket "${range}"`
      );
      check(
        deriveSeasonalKey('spring_opening', zones, commercial) === row.key_spring,
        `${group}/${zones}z resolved outside its pricing.json bracket "${range}"`
      );
    }
  }
}

// 5. The regression itself: hand-built `..._${n}z` keys are NOT valid, which is
//    why the endpoint must not go back to composing them.
const handBuilt = [1, 2, 3, 5, 7, 9, 12, 20].map((n) => `fall_close_${n}z`);
for (const key of handBuilt) {
  check(!BOOKABLE_SERVICES[key], `${key} is unexpectedly bookable — this test's premise needs revisiting`);
}

// 5b. Source guard. Assertions 1-5 exercise deriveSeasonalKey, but the defect
//     was the CALLER composing a key by hand instead of asking the helper. A
//     revert there would pass every test above, so pin the shape out of the
//     server: no seasonal key may be built by string interpolation.
const serverSrc = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
// Deliberately blunt: any single-line template literal that names a seasonal
// key prefix AND interpolates. If a legitimate one ever trips this (a log
// line, say), reword it — the cost of a false positive is low and the cost
// of this defect returning is a silently degraded booking handoff.
const HAND_BUILT_KEY = /`[^`\n]*(?:spring_open|fall_close)[^`\n]*\$\{[^`\n]*`/;
check(
  !HAND_BUILT_KEY.test(serverSrc),
  'server.js composes a seasonal service key by string interpolation — use deriveSeasonalKey(woType, zoneCount, commercial) instead'
);

// 6. An unknown season yields null (the endpoint then sends "", letting the
//    customer pick) rather than a guessed key.
check(deriveSeasonalKey('not_a_season', 6, false) === null, 'unknown WO type should derive no key');

if (failures.length) {
  console.error(`seasonal-handoff: ${passed} passed, ${failures.length} FAILED\n`);
  failures.slice(0, 25).forEach((f) => console.error('  ' + f));
  if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
  process.exit(1);
}
console.log(`seasonal-handoff: ${passed} passed, 0 failed`);

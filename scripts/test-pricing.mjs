#!/usr/bin/env node
// scripts/test-pricing.mjs
//
// Snapshot test for the booking-flow pricing pipeline. Asserts that:
//   1. Every BOOKABLE_SERVICES key in server/lib/availability.js maps to a
//      pricing.json item key OR is one of the documented special cases
//      (sprinkler_repair, hydrawise_retrofit, site_visit).
//   2. priceForBooking() returns the canonical price for every key.
//   3. Custom-quote tiers (16+ residential, 9+ commercial) come back as
//      { price: 0, custom: true } with a "Custom quote" label.
//   4. Special-case keys behave as documented (sprinkler_repair shows the
//      service-call price + note; hydrawise_retrofit returns "Quote on-site";
//      site_visit returns "Free").
//
// Catches: drift between availability.js, pricing.js, and pricing.json. Was
// the source of multiple booking-flow regressions early in the audit
// (overlapping fall buckets, label/price mismatch, hardcoded-vs-canonical
// drift). Run on every `npm run build:check` so any future change to one of
// these three files surfaces breakage immediately.
//
// Modes:
//   node scripts/test-pricing.mjs            # exit 1 if any test fails
//   node scripts/test-pricing.mjs --verbose  # print every assertion

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const { priceForBooking } = require(path.join(ROOT, 'server/lib/pricing.js'));
const PRICING = require(path.join(ROOT, 'pricing.json'));

// Mirror BOOKABLE_SERVICES from server/lib/availability.js. We could load that
// module directly but it pulls in the geocode/distance siblings — easier to
// declare the expected key list here. If you add a new bookable service in
// availability.js, add it here too. The test will then verify it has a
// pricing.json mapping (or is a known special case).
const EXPECTED_BOOKABLE_KEYS = [
  // Spring opening — residential
  'spring_open_4z', 'spring_open_6z', 'spring_open_8z', 'spring_open_15z', 'spring_open_16plus',
  // Spring opening — commercial
  'spring_open_commercial', 'spring_open_commercial_8z', 'spring_open_commercial_9plus',
  // Fall winterization — residential
  'fall_close_4z', 'fall_close_6z', 'fall_close_8z', 'fall_close_15z', 'fall_close_16plus',
  // Fall winterization — commercial
  'fall_close_commercial', 'fall_close_commercial_8z', 'fall_close_commercial_9plus',
  // Repair / retrofit / consult
  'sprinkler_repair', 'hydrawise_retrofit', 'site_visit'
];

const SPECIAL_CASES = {
  sprinkler_repair:   { expectedPriceFromKey: 'service_call', expectsLabelContains: 'service call', expectsNote: true },
  hydrawise_retrofit: { expectedPrice: 0, expectsCustom: true, expectsLabelContains: 'Quote on-site' },
  site_visit:         { expectedPrice: 0, expectsCustom: false, expectsLabelContains: 'Free' }
};

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
    if (VERBOSE) console.log('  OK  ' + msg);
  } else {
    fail++;
    failures.push(msg);
    console.log('  FAIL ' + msg);
  }
}

console.log('test-pricing: validating booking-flow pricing pipeline...');
console.log('');

for (const key of EXPECTED_BOOKABLE_KEYS) {
  const result = priceForBooking(key);
  assert(result && typeof result === 'object',
    `${key}: priceForBooking returns an object`);
  assert(typeof result.price === 'number',
    `${key}: result.price is a number (got ${typeof result.price})`);
  assert(result.currency === 'CAD',
    `${key}: result.currency is "CAD" (got "${result.currency}")`);
  assert(typeof result.label === 'string' && result.label.length > 0,
    `${key}: result.label is a non-empty string (got "${result.label}")`);

  if (SPECIAL_CASES[key]) {
    const sc = SPECIAL_CASES[key];
    if (typeof sc.expectedPrice === 'number') {
      assert(result.price === sc.expectedPrice,
        `${key} (special-case): price === ${sc.expectedPrice} (got ${result.price})`);
    }
    if (sc.expectedPriceFromKey) {
      const expected = PRICING.items[sc.expectedPriceFromKey].price;
      assert(result.price === expected,
        `${key} (special-case): price === pricing.json[${sc.expectedPriceFromKey}].price (${expected}) (got ${result.price})`);
    }
    if (sc.expectsCustom !== undefined) {
      assert(result.custom === sc.expectsCustom,
        `${key} (special-case): custom === ${sc.expectsCustom} (got ${result.custom})`);
    }
    if (sc.expectsLabelContains) {
      assert(result.label.includes(sc.expectsLabelContains),
        `${key} (special-case): label contains "${sc.expectsLabelContains}" (got "${result.label}")`);
    }
    if (sc.expectsNote) {
      assert(typeof result.note === 'string' && result.note.length > 0,
        `${key} (special-case): result.note is a non-empty string`);
    }
    continue;
  }

  // Standard seasonal keys: price must equal pricing.json[key].price
  const item = PRICING.items[key];
  assert(item !== undefined,
    `${key}: pricing.json has an items["${key}"] entry`);
  if (!item) continue;
  assert(result.price === item.price,
    `${key}: priceForBooking returns ${item.price} (got ${result.price})`);
  if (item.quoteType === 'custom') {
    assert(result.custom === true,
      `${key}: custom-quote tier returns custom: true`);
    assert(result.label === 'Custom quote',
      `${key}: custom-quote tier label is "Custom quote" (got "${result.label}")`);
  } else {
    assert(result.custom === false,
      `${key}: flat tier returns custom: false`);
  }
}

// ---- Sanity checks on pricing.json structure ----
assert(typeof PRICING.currency === 'string' && PRICING.currency === 'CAD',
  'pricing.json: top-level currency === "CAD"');
assert(typeof PRICING.items === 'object',
  'pricing.json: items is an object');
assert(Array.isArray(PRICING.seasonal_tiers?.residential) && PRICING.seasonal_tiers.residential.length === 5,
  'pricing.json: seasonal_tiers.residential has 5 tiers');
assert(Array.isArray(PRICING.seasonal_tiers?.commercial) && PRICING.seasonal_tiers.commercial.length === 3,
  'pricing.json: seasonal_tiers.commercial has 3 tiers');
assert(typeof PRICING.water_calculator?.headline_scenario?.annual_savings_cad === 'number',
  'pricing.json: water_calculator.headline_scenario.annual_savings_cad is a number');
assert(typeof PRICING.water_calculator?.manual_cycles_per_season === 'number',
  'pricing.json: water_calculator.manual_cycles_per_season is a number');

// ---- Cross-check: every seasonal_tiers entry references a real item key ----
for (const tier of PRICING.seasonal_tiers.residential) {
  assert(PRICING.items[tier.key_spring] !== undefined,
    `seasonal_tiers.residential["${tier.zones}"]: key_spring="${tier.key_spring}" exists in items`);
  assert(PRICING.items[tier.key_fall] !== undefined,
    `seasonal_tiers.residential["${tier.zones}"]: key_fall="${tier.key_fall}" exists in items`);
}
for (const tier of PRICING.seasonal_tiers.commercial) {
  assert(PRICING.items[tier.key_spring] !== undefined,
    `seasonal_tiers.commercial["${tier.zones}"]: key_spring="${tier.key_spring}" exists in items`);
  assert(PRICING.items[tier.key_fall] !== undefined,
    `seasonal_tiers.commercial["${tier.zones}"]: key_fall="${tier.key_fall}" exists in items`);
}

console.log('');
if (fail === 0) {
  console.log(`test-pricing: PASS — ${pass} assertions, 0 failures.`);
  process.exit(0);
}
console.log(`test-pricing: FAIL — ${pass} pass, ${fail} fail.`);
console.log('Failures:');
failures.forEach(f => console.log('  ' + f));
process.exit(1);

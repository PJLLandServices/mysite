#!/usr/bin/env node
// scripts/lint-town-tiers.mjs
//
// CI gate for the town pages' hero (sprinkler-service-*.html).
//
// Same-day / priority / scheduled-route wording in a town-page hero is
// rendered by js/season.js from its TIER_STATS table, keyed by the page's
// data-tier. Each page also carries that stat as static no-JS fallback
// text, which is a second copy — so this script checks the copy against
// the table, and checks the accuracy rules the component exists to hold:
//
//   1. every town page has the shared hero + season block + auto calculator
//   2. the static [data-scheduling-stat] text equals TIER_STATS[data-tier]
//   3. "same-day" appears in a hero ONLY when data-tier="core"
//   4. no town-page hero mentions the 3-year installation warranty
//   5. no <video> on a town page (static poster only — LCP on mobile)
//   6. js/season.js is loaded in <head>, and no page computes the calendar
//      itself (getMonth) — season.js is the only season logic
//
// Modes:
//   node scripts/lint-town-tiers.mjs            # exit 1 on any failure
//   node scripts/lint-town-tiers.mjs --verbose  # also list every page's tier

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// Load js/season.js in a bare sandbox (no document) and read its table.
function loadSeasonModule() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'season.js'), 'utf8');
  const sandbox = { window: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return sandbox.PJLSeason;
}

const PJLSeason = loadSeasonModule();
const TIERS = Object.keys(PJLSeason.TIER_STATS);

const files = fs.readdirSync(ROOT).filter((f) => /^sprinkler-service-.*\.html$/.test(f)).sort();
const problems = [];
const rows = [];

for (const file of files) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fail = (why) => problems.push(`${file}: ${why}`);

  const hero = (html.match(/<section class="area-hero-v2[\s\S]*?<\/section>/) || [])[0];
  if (!hero) { fail('missing .area-hero-v2 hero'); continue; }
  if (!/<section class="season-block" id="price">/.test(html)) fail('missing .season-block#price');
  if (!/data-seasonal-calc="auto"/.test(html)) fail('calculator is not data-seasonal-calc="auto"');
  if (!/<script src="js\/season\.js"[^>]*><\/script>/.test(html.split('</head>')[0] || '')) fail('js/season.js is not loaded in <head>');
  if (!/<script src="js\/seasonal-zone-calculator\.js" defer>/.test(html)) fail('shared calculator script not loaded');
  if (/getMonth\(\)/.test(html)) fail('page computes the season itself (getMonth) — use js/season.js');

  const tier = (hero.match(/data-tier="([a-z0-9]+)"/) || [])[1];
  if (!tier || !TIERS.includes(tier)) { fail(`data-tier "${tier}" is not one of ${TIERS.join('/')}`); continue; }

  const stat = (hero.match(/<li data-scheduling-stat>([\s\S]*?)<\/li>/) || [])[1];
  const expected = PJLSeason.tierStatHtml(tier);
  if (stat == null) fail('missing <li data-scheduling-stat>');
  else if (stat.trim() !== expected) fail(`scheduling stat "${stat.trim()}" ≠ TIER_STATS.${tier} "${expected}"`);

  const heroSameDay = /same-day|same day/i.test(hero);
  if (heroSameDay && tier !== 'core') fail(`hero says same-day but data-tier="${tier}"`);
  if (!heroSameDay && tier === 'core') fail('data-tier="core" but the hero never says same-day');
  if (/3-year|3 year|three-year/i.test(hero)) fail('hero mentions the 3-year installation warranty');
  if (/<video\b/i.test(html)) fail('town page carries a <video> — static poster only');

  rows.push(`${file.padEnd(42)} ${tier}`);
}

if (VERBOSE) console.log(rows.join('\n'));

if (problems.length === 0) {
  const core = rows.filter((r) => r.endsWith(' core')).length;
  console.log(`lint-town-tiers: PASS — ${files.length} town pages on the shared hero; same-day wording on ${core} core page(s) only.`);
  process.exit(0);
}
console.log(`lint-town-tiers: FAIL — ${problems.length} problem(s):`);
for (const p of problems) console.log('  ' + p);
process.exit(1);

#!/usr/bin/env node
// scripts/sync-seasonal-meta.mjs
//
// Season-driven <title> / meta description on the town pages, switched AT
// BUILD TIME in the source HTML — not in the browser. Google indexes what it
// crawls and treats JS-rewritten titles inconsistently, so the seasonal
// suffix has to be in the file the crawler fetches.
//
// Two jobs, one source of truth (season.config.json):
//
//   1. Rewrite the @@PJL:seasonal-meta marker block in every
//      sprinkler-service-*.html <head> from seasonal-meta.json, choosing the
//      fall / spring / off variant from the config's `meta` windows.
//   2. Stamp season.config.json into js/season.js between its
//      @@PJL:season-config markers, so the hero (which runs synchronously in
//      <head> and cannot fetch) reads the same windows.
//
// Assertions (fail the build): every title ≤ 60 chars before the brand
// suffix, every description 140–160 chars, and "same-day" absent from the
// meta unless the page's hero carries data-tier="core" (the tier is read off
// the page — it is not stored twice).
//
// Modes:
//   node scripts/sync-seasonal-meta.mjs                  # apply for today
//   node scripts/sync-seasonal-meta.mjs --check          # exit 1 if any page or
//                                                        # js/season.js is stale
//   node scripts/sync-seasonal-meta.mjs --season=spring  # force a variant (QA)
//   node scripts/sync-seasonal-meta.mjs --date=2027-03-02
//   node scripts/sync-seasonal-meta.mjs --dry-run        # report only, write nothing
//
// Wired into `npm run build` BEFORE sync-meta-prices.mjs so the resolved
// prices are in place when that script runs its drift check.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const DRY = argv.includes('--dry-run');
const arg = (name) => { const m = argv.find((a) => a.startsWith(`--${name}=`)); return m ? m.slice(name.length + 3) : null; };

const CONFIG_PATH = path.join(ROOT, 'season.config.json');
const META_PATH = path.join(ROOT, 'seasonal-meta.json');
const SEASON_JS = path.join(ROOT, 'js', 'season.js');
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, 'pricing.json'), 'utf8'));
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

const START = '<!-- @@PJL:seasonal-meta-START -->';
const END = '<!-- @@PJL:seasonal-meta-END -->';
const JS_START = '/* @@PJL:season-config-START */';
const JS_END = '/* @@PJL:season-config-END */';

// ---------------------------------------------------------------------------
// Season resolution — `meta` windows, MM-DD inclusive.
// ---------------------------------------------------------------------------
function mmdd(d) { return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function within(key, [from, to]) { return from <= to ? (key >= from && key <= to) : (key >= from || key <= to); }
export function resolveMetaSeason(d = new Date()) {
  const key = mmdd(d);
  if (within(key, CONFIG.fall.meta)) return 'fall';
  if (within(key, CONFIG.spring.meta)) return 'spring';
  return 'off';
}

function parseDateArg(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) throw new Error(`--date must be YYYY-MM-DD, got "${s}"`);
  return new Date(+m[1], +m[2] - 1, +m[3], 12);
}

const forced = arg('season');
if (forced && !['fall', 'spring', 'off'].includes(forced)) throw new Error(`--season must be fall|spring|off, got "${forced}"`);
const today = arg('date') ? parseDateArg(arg('date')) : new Date();
const SEASON = forced || resolveMetaSeason(today);

// --print-season: just the resolved season on stdout (the workflow's commit
// message reads it). No files are touched.
if (argv.includes('--print-season')) { console.log(SEASON); process.exit(0); }

// ---------------------------------------------------------------------------
// Copy assembly
// ---------------------------------------------------------------------------
function fmtMoney(n) {
  const cents = Math.round(n * 100) % 100;
  return cents === 0 ? n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : n.toFixed(2);
}
function resolvePrices(s) {
  return s.replace(/\{\{price:([a-z0-9_]+)\}\}/g, (m, key) => {
    const item = PRICING.items[key];
    if (!item) throw new Error(`seasonal-meta.json: unknown pricing key "${key}"`);
    return fmtMoney(item.price);
  });
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function blockFor(file, page, season) {
  const variant = META.seasonal[season];
  const bareTitle = `Sprinkler Service ${page.town} — ${resolvePrices(variant.titleSuffix)}`;
  const title = bareTitle + META.brand;
  const description = `${page.evergreen} ${resolvePrices(variant.sentence)}`;
  return {
    bareTitle, description,
    html: [
      START,
      `<title>${escText(title)}</title>`,
      `<meta name="description" content="${escAttr(description)}">`,
      `<meta property="og:title" content="${escAttr(bareTitle)}">`,
      `<meta property="og:description" content="${escAttr(description)}">`,
      `<meta name="twitter:title" content="${escAttr(bareTitle)}">`,
      `<meta name="twitter:description" content="${escAttr(description)}">`,
      END,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const files = fs.readdirSync(ROOT).filter((f) => /^sprinkler-service-.*\.html$/.test(f)).sort();
const problems = [];
const stale = [];
const report = [];

for (const file of files) {
  const page = META.pages[file];
  if (!page) { problems.push(`${file}: no entry in seasonal-meta.json`); continue; }
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const s = html.indexOf(START), e = html.indexOf(END);
  if (s === -1 || e === -1 || e < s) { problems.push(`${file}: missing @@PJL:seasonal-meta marker block`); continue; }
  const tier = (html.match(/<section class="area-hero-v2[^>]*data-tier="([a-z0-9]+)"/) || [])[1];
  if (!tier) { problems.push(`${file}: hero has no data-tier — cannot scope same-day`); continue; }

  const { bareTitle, description, html: block } = blockFor(file, page, SEASON);
  if (bareTitle.length > 60) problems.push(`${file}: title is ${bareTitle.length} chars before brand (max 60): "${bareTitle}"`);
  if (description.length < 140 || description.length > 160) problems.push(`${file}: description is ${description.length} chars (need 140–160): "${description}"`);
  if (/same[- ]day/i.test(description + bareTitle) && tier !== 'core') problems.push(`${file}: meta says same-day but hero data-tier="${tier}"`);
  report.push(`${file.padEnd(42)} ${SEASON.padEnd(6)} title ${String(bareTitle.length).padStart(2)}  desc ${description.length}`);

  const next = html.slice(0, s) + block + html.slice(e + END.length);
  if (next !== html) {
    stale.push(file);
    if (!CHECK && !DRY) fs.writeFileSync(path.join(ROOT, file), next);
  }
}

// ---------------------------------------------------------------------------
// js/season.js — stamp the config between its markers
// ---------------------------------------------------------------------------
{
  const js = fs.readFileSync(SEASON_JS, 'utf8');
  const s = js.indexOf(JS_START), e = js.indexOf(JS_END);
  if (s === -1 || e === -1) {
    problems.push('js/season.js: missing @@PJL:season-config markers');
  } else {
    const { _doc, ...windows } = CONFIG;
    const stamped = `${JS_START}\n  // Generated from season.config.json by scripts/sync-seasonal-meta.mjs — edit the JSON.\n  var CONFIG = ${JSON.stringify(windows)};\n  ${JS_END}`;
    const next = js.slice(0, s) + stamped + js.slice(e + JS_END.length);
    if (next !== js) {
      stale.push('js/season.js');
      if (!CHECK && !DRY) fs.writeFileSync(SEASON_JS, next);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`sync-seasonal-meta: season=${SEASON}${forced ? ' (forced)' : ''} date=${mmdd(today)} pages=${files.length}`);
if (argv.includes('--verbose')) console.log(report.join('\n'));

if (problems.length) {
  console.log(`sync-seasonal-meta: FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
if (CHECK) {
  if (stale.length) {
    console.log(`sync-seasonal-meta --check: ${stale.length} file(s) stale for season=${SEASON}:`);
    for (const f of stale) console.log('  ' + f);
    console.log('\nRun `node scripts/sync-seasonal-meta.mjs` (or npm run build) to apply.');
    process.exit(1);
  }
  console.log('sync-seasonal-meta --check: OK — every town page and js/season.js match season.config.json.');
  process.exit(0);
}
console.log(DRY
  ? `sync-seasonal-meta --dry-run: ${stale.length} file(s) would change.`
  : `sync-seasonal-meta: ${stale.length ? 'rewrote ' + stale.length + ' file(s)' : 'no changes — already current'}.`);

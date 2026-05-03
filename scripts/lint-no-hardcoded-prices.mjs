#!/usr/bin/env node
// scripts/lint-no-hardcoded-prices.mjs
//
// CI gate: scans every HTML file for hardcoded $NN amounts that aren't:
//   1. Inside a <span data-price="..."> or <element data-pjl-quote-formula=".."> token
//   2. Inside a <script ...> or <style> block
//      (sync-meta-prices.mjs handles JSON-LD description prose;
//      structured Offer.price fields are managed by sync-prices-html.mjs)
//   3. Inside an HTML <!-- comment -->
//   4. Inside a <meta> or <title> tag (sync-meta-prices.mjs owns those)
//   5. On the explicit allow-list below (legitimate informational refs:
//      DIY freeze-damage cost estimates, comparison ranges, owner-deferred
//      lighting prices, real-but-not-yet-canonical service prices, etc.)
//
// Walks the original file line-by-line with a small state machine so error
// messages report TRUE line numbers, not positions inside a stripped buffer.
//
// Modes:
//   node scripts/lint-no-hardcoded-prices.mjs           # exit 1 if any drift
//   node scripts/lint-no-hardcoded-prices.mjs --verbose # also print line content

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// Pricing values that EXIST as canonical pricing.json items. If one of these
// appears outside the data-price pipeline, that's drift.
const TRACKED_PRICES = [
  '95', '68', '74\\.95', '135', '285', '120', '90', '105', '145', '165', '255',
  '345', '435', '187', '454\\.85', '829\\.70', '679\\.80', '304\\.95', '379\\.90',
  '754\\.75', '575', '585', '549', '749', '175', '185', '195', '210', '225',
  '395', '595', '750', '1,195', '1195', '163', '299', '845', '282', '215'
];
const PRICE_RE = new RegExp('\\$(' + TRACKED_PRICES.join('|') + ')\\b', 'g');

// Allow-list. Each entry: { file, match, reason }.
// `match` is a substring of the offending line. If the line still contains
// that substring, the violation is suppressed. If you remove or rewrite the
// line, the entry stops matching and the linter complains again — forcing
// you to either re-add the entry, fix the price, or tokenize.
const ALLOWLIST = [
  // ---- Comparison costs (DIY-failure / freeze-damage / competitor refs) ----
  { file: 'sprinkler-fall-winterization.html', match: '$400 to $1,800', reason: 'Freeze-damage repair cost (cost of skipping winterization), not a PJL service price.' },
  { file: 'sprinkler-fall-winterization.html', match: '$400-$1,800', reason: 'Freeze-damage repair cost reference (callout heading).' },
  { file: 'sprinkler-fall-winterization.html', match: '$400 to $1,500', reason: 'Frozen-and-cracked valve repair example.' },
  { file: 'sprinkler-fall-winterization.html', match: '$1,000+', reason: 'Cheap insurance against $1,000+ spring repair bills.' },
  { file: 'blog-sprinkler-system-cost-ontario.html', match: '$400 to $1,000', reason: 'Three-year warranty risk-removal estimate.' },
  { file: 'blog-sprinkler-system-cost-ontario.html', match: '$400–$1,000', reason: 'Three-year warranty risk-removal estimate (en-dash variant).' },
  { file: 'blog-sprinkler-system-cost-ontario.html', match: '$400', reason: 'Comparison cost in body prose.' },
  { file: 'blog-signs-sprinkler-needs-repair-newmarket-gta.html', match: '$400', reason: 'DIY-failure cost example.' },
  { file: 'blog-signs-sprinkler-needs-repair-newmarket-gta.html', match: '$900', reason: 'DIY-failure cost example.' },
  { file: 'blog-sprinkler-maintenance-checklist.html', match: '$400', reason: 'Skipping-maintenance cost estimate.' },
  { file: 'blog-sprinkler-maintenance-checklist.html', match: '$30', reason: '"$30-$100 wasted water" estimate (skipping spring start-up).' },
  { file: 'blog-sprinkler-maintenance-checklist.html', match: '$40', reason: '"$20-$40 backflow jacket" hardware-store item, not PJL price.' },
  { file: 'blog-lawn-irrigation-myths-busted-gta.html', match: '$400', reason: 'Comparison cost reference.' },
  { file: 'blog-sprinkler-installation-newmarket.html', match: '$400', reason: 'Comparison cost reference.' },
  { file: 'blog-when-to-turn-on-sprinklers-ontario.html', match: '$900', reason: 'Comparison cost reference.' },
  { file: 'blog-tree-irrigation-newmarket-gta.html', match: '$120', reason: 'Tree irrigation cost reference (informational).' },
  { file: 'blog-spring-sprinkler-opening.html', match: '$45', reason: '"$45-$220 typical repair range" — informational range, not a flat price.' },
  { file: 'blog-spring-sprinkler-opening.html', match: 'Pay the $90', reason: 'Rhetorical "From the truck" quote, intentionally rounded.' },
  { file: 'blog-spring-sprinkler-opening.html', match: '$4,000', reason: 'Hypothetical "system value" reference in og:description, not a service price.' },

  // ---- Real-but-not-yet-canonical PJL services ----
  // These ARE PJL service prices but don't have a pricing.json key (yet).
  // Adding them to pricing.json would be ideal — flag if not done by launch.
  // Pre-reno walk fee — $120 flat consult, NOT in pricing.json (blog-only).
  // Add as `pre_reno_walk` if it should become canonical. Until then,
  // 4 occurrences all allow-listed by the file rule below (no specific
  // substring needed — every $120 in this file is the same fee).
  { file: 'blog-landscape-renovation-sprinkler-prep-gta.html', match: '$120', reason: 'Pre-reno walk fee (NOT in pricing.json — blog-only $120 consult fee. Add as "pre_reno_walk" if it should be canonical).' },
  { file: 'blog-signs-sprinkler-needs-repair-newmarket-gta.html', match: '$120 flat', reason: 'Leak-locate visit (NOT in pricing.json — flat-rate diagnostic, distinct from $120 pipe break repair).' },
  { file: 'blog-signs-sprinkler-needs-repair-newmarket-gta.html', match: '$120 leak locate', reason: 'Leak-locate visit (same).' },

  // ---- Lighting (owner-deferred per cost_guide_owner_owned.md) ----
  { file: 'estimate.html', match: '$245', reason: 'Lighting price-per-fixture (owner-deferred — do not migrate to pricing.json without Patrick).' },
  { file: 'estimate.html', match: '+$165', reason: 'Lighting add-on (owner-deferred).' },
  { file: 'faq.html', match: '$245', reason: 'Lighting price-per-fixture (owner-deferred).' },
  { file: 'landscape-lighting.html', match: '$245', reason: 'Lighting price-per-fixture (owner-deferred).' },
  { file: 'blog-landscape-lighting-newmarket.html', match: '$30', reason: 'Lighting blog comparison ref (owner-deferred).' },
  { file: 'blog-landscape-lighting-newmarket.html', match: '$40', reason: 'Lighting blog comparison ref (owner-deferred).' },

  // ---- estimate.html JS string-literal labels (can\'t carry HTML tokens
  //      because they\'re assigned to the WATER_LABEL JS object). Migrate to
  //      pricing.json on the next install-pricing pass — Patrick is currently
  //      working on install pricing so leave alone. ----
  { file: 'estimate.html', match: '+$225 complexity', reason: 'WATER_LABEL JS string (cannot tokenize). Migrate WATER_LABEL.finished to read pricing.json#extra_water_finished_basement during next install-pricing pass.' },
  { file: 'estimate.html', match: '+$175', reason: 'WATER_LABEL JS string (cannot tokenize). Migrate WATER_LABEL.hosebibnew to read pricing.json#hose_bib_install during next install-pricing pass.' },

  // ---- Service-area info refs (NOT PJL service prices) ----
  { file: 'sprinkler-service-king-city.html', match: '$40', reason: 'Generic city-detail dollar reference, not a PJL price.' },
  { file: 'sprinkler-service-vaughan.html', match: '$40', reason: 'Generic city-detail dollar reference, not a PJL price.' },
  { file: 'terms-of-service.html', match: '$30', reason: 'Generic legal-text dollar reference.' },

  // ---- sprinkler-systems.html JS fallback string. Intentional: when
  //      pricing-injector.js fails to hydrate (offline / pre-cutover), the
  //      seasonal banner falls back to "$90". Documented as the fallback
  //      contract, kept in sync with pricing.json by the comment. ----
  { file: 'sprinkler-systems.html', match: 'Fall back to "$90"', reason: 'JS fallback string (offline/pre-hydrate), kept in sync with pricing.json by comment.' },
  { file: 'sprinkler-systems.html', match: ": '$' + p.price : '$90'", reason: 'JS fallback expression (offline/pre-hydrate).' },

  // ---- Quote-builder legacy file (will be retired) ----
  { file: 'quote-legacy.html', match: '$585', reason: 'Legacy file — retire after install pricing finalizes.' }
];

function isAllowed(file, line) {
  return ALLOWLIST.some(entry => entry.file === file && line.includes(entry.match));
}

// Position-preserving strip: replaces stripped regions with spaces of equal
// length so character positions (and therefore line numbers) match the
// original file exactly. Strips:
//   - <script ...>...</script> (incl. JSON-LD)
//   - <style>...</style>
//   - <!-- HTML comments -->
//   - <meta> tags (managed by sync-meta-prices.mjs)
//   - <title>...</title> (managed by sync-meta-prices.mjs)
//   - Any element with data-price="..." or data-pjl-quote-formula="..."
function stripPreservingPositions(html) {
  const replacers = [
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    /<style\b[^>]*>[\s\S]*?<\/style>/gi,
    /<!--[\s\S]*?-->/g,
    /<meta\b[^>]*>/gi,
    /<title>[^<]*<\/title>/gi,
    /<([a-zA-Z][a-zA-Z0-9]*)\s+[^>]*?(?:data-price|data-pjl-quote-formula)[^>]*?>[^<]*<\/\1>/gi
  ];
  let out = html;
  for (const re of replacers) {
    out = out.replace(re, (match) => {
      // Replace with same-length string of newlines+spaces, preserving
      // newlines so line numbers stay aligned.
      return match.replace(/[^\n]/g, ' ');
    });
  }
  return out;
}

function scanFile(filename, html) {
  const stripped = stripPreservingPositions(html);
  const lines = stripped.split('\n');
  const originalLines = html.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(PRICE_RE);
    if (!matches) continue;
    if (isAllowed(filename, originalLines[i])) continue;
    violations.push({
      file: filename,
      lineNo: i + 1,
      line: originalLines[i].trim().slice(0, 200),
      prices: [...new Set(matches)]
    });
  }
  return violations;
}

const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const allViolations = [];

for (const file of files) {
  const filepath = path.join(ROOT, file);
  const html = fs.readFileSync(filepath, 'utf8');
  allViolations.push(...scanFile(file, html));
}

if (allViolations.length === 0) {
  console.log('lint-no-hardcoded-prices: PASS — every customer-facing price is tokenized or explicitly allow-listed.');
  process.exit(0);
}

console.log(`lint-no-hardcoded-prices: FAIL — ${allViolations.length} hardcoded price(s) found outside the data-price pipeline:`);
console.log('');
for (const v of allViolations) {
  console.log(`  ${v.file}:${v.lineNo}  ${v.prices.join(', ')}`);
  if (VERBOSE) console.log(`     ${v.line}`);
}
console.log('');
console.log('To resolve each violation:');
console.log('  1. Wrap the price in <span data-price="<key>">$NN</span> referencing pricing.json');
console.log('  2. Or add an entry to ALLOWLIST in this script with a short reason string.');
console.log('     (Use for: comparison costs, lighting refs, JS string literals that can\'t carry HTML, etc.)');
process.exit(1);

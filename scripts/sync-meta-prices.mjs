#!/usr/bin/env node
// scripts/sync-meta-prices.mjs
//
// Regenerate hardcoded prices in meta tags / titles / JSON-LD description prose
// from pricing.json. These surfaces can't carry inline data-price tokens (HTML
// attributes can't contain elements), so they need a build-time sync step.
//
// Strategy: PATTERN-BASED replacement, NOT template-based. Each rule pairs a
// context-aware regex (matches the surrounding prose Patrick wrote) with a
// pricing.json key. Only the dollar amount inside the matched fragment gets
// rewritten — the surrounding prose is preserved verbatim. This means Patrick
// can keep editing meta wording in parallel without the script clobbering his
// copy; the script only fights drift on the price NUMBER.
//
// Scope:
//   - <meta name="description" content="...">
//   - <meta property="og:description" content="...">
//   - <meta name="twitter:description" content="...">
//   - <meta property="og:title" content="...">
//   - <meta name="twitter:title" content="...">
//   - <title>...</title>
//   - JSON-LD top-level "description" string fields
//   - "Save up to $NNN/year" water-savings headline (special-case)
//
// Modes:
//   node scripts/sync-meta-prices.mjs              # apply changes
//   node scripts/sync-meta-prices.mjs --check      # dry-run; exit 1 if drift
//   node scripts/sync-meta-prices.mjs --verbose    # print each rewrite
//
// Idempotent: re-running on already-fresh content is a no-op.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');
const VERBOSE = process.argv.includes('--verbose');
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, 'pricing.json'), 'utf8'));

function fmtMoney(n) {
  const cents = Math.round(n * 100) % 100;
  if (cents === 0) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
const priceFor = (key) => {
  const item = PRICING.items[key];
  if (!item) throw new Error(`pricing.json: unknown key "${key}"`);
  return fmtMoney(item.price);
};

// Context-aware rules. Each rule's REGEX itself includes the disambiguating
// context word(s) — the price token can only match if the surrounding prose
// clearly identifies which pricing.json key it belongs to. This avoids the
// hydrawise-vs-fall conflict where both rules wanted to claim a generic
// "from $XX" inside a meta string that happened to mention both topics.
//
// Pattern shape: /(<context-prefix-words>\s+)(\$\d+)/  — group 1 = prefix,
// group 2 = the price token to swap. Idempotency: if the captured price
// already equals the canonical value, the replacement is a no-op.
const RULES = [
  // ----- Hydrawise retrofit pricing
  // Matches: "Retrofit pricing from $595", "retrofit from $595".
  // Hydrawise mentions WITHOUT "retrofit" (e.g. "Hydrawise winter mode") are
  // intentionally NOT matched.
  {
    name: 'hydrawise-retrofit-from',
    re: /\b(retrofit\s+(?:pricing\s+)?from\s+)(\$\d{1,3}(?:,\d{3})*)/gi,
    key: 'controller_1_4'
  },

  // ----- Drip / new zone install
  // Matches: "starting at $575", "starts at $575" — only when "drip" or
  // "new zone" is in the *same fragment* (handled below by tightened pattern).
  {
    name: 'drip-starts-at',
    re: /\b((?:new\s+drip\s+zones?\s+|new\s+zones?\s+|drip\s+zones?\s+)?(?:starting\s+at\s+|starts?\s+at\s+))(\$\d{1,3}(?:,\d{3})*)/gi,
    contextRe: /(drip|new\s+zone|new-zone)/i,
    key: 'new_zone_min'
  },

  // ----- Spring opening — "from $90", "Spring activation from $90", etc.
  // The regex prefix list is what makes this spring-only; broader "from $90"
  // must be paired with one of these spring-specific lead-ins.
  {
    name: 'spring-from',
    re: /\b((?:spring\s+(?:sprinkler\s+)?(?:opening|activation)\s+from\s+|spring\s+activation\s+from\s+|spring\s+service\s+from\s+|seasonal\s+(?:service|care)\s+(?:starts\s+at|from)\s+|opening\s+from\s+))(\$\d{1,3}(?:,\d{3})*)/gi,
    key: 'spring_open_4z'
  },

  // ----- Fall winterization — "from $90", "fall blow-out from $90", etc.
  {
    name: 'fall-from',
    re: /\b((?:fall\s+(?:sprinkler\s+)?(?:winterization|blow-?out|closing|service)\s+(?:from\s+|starts?\s+at\s+)|winterization\s+from\s+|closing\s+from\s+|blow-?out\s+from\s+))(\$\d{1,3}(?:,\d{3})*)/gi,
    key: 'fall_close_4z'
  },

  // ----- "From $XX | …" in titles / og:title (tight pattern: pipe or em-dash
  //       suffix means it's a TITLE-style price, not body prose).
  //       Disambiguated by surrounding "Spring" / "Fall" word in the title.
  {
    name: 'title-spring-from',
    re: /(Spring\s+(?:Sprinkler\s+)?(?:Opening|Activation|Service)\b[^|]*?\bFrom\s+)(\$\d{1,3}(?:,\d{3})*)/g,
    key: 'spring_open_4z'
  },
  {
    name: 'title-fall-from',
    re: /(Fall\s+(?:Sprinkler\s+)?(?:Winterization|Blow-?out|Closing|Service)\b[^|]*?\bFrom\s+)(\$\d{1,3}(?:,\d{3})*)/g,
    key: 'fall_close_4z'
  },

  // ----- Service-area meta: "$90 spring openings" (city pages — inverted
  //       capture order: group 1 IS the dollar amount, group 2 is the suffix
  //       words that disambiguate.
  {
    name: 'service-area-spring-openings',
    re: /(\$\d{1,3}(?:,\d{3})*)(\s+spring\s+openings?)/gi,
    key: 'spring_open_4z',
    captureSlot: 1
  }
];

// Run all rules over a fragment. Returns { newText, count, hits[] }.
function rewriteFragment(text, where) {
  let count = 0;
  const hits = [];
  let out = text;
  for (const rule of RULES) {
    // Optional contextRe is an extra guard — most rules don't need it now
    // that the main regex includes the context word(s) directly.
    if (rule.contextRe && !rule.contextRe.test(out)) continue;
    out = out.replace(rule.re, (match, capA, capB) => {
      const isInverted = rule.captureSlot === 1;
      const oldDollar = isInverted ? capA : capB;
      const canonical = '$' + priceFor(rule.key);
      if (oldDollar === canonical) return match; // already canonical, no-op
      count++;
      hits.push({ rule: rule.name, where, was: oldDollar, now: canonical });
      return isInverted ? canonical + capB : capA + canonical;
    });
  }
  return { newText: out, count, hits };
}

// Special-case: water-savings headline ($580/year) lives in
// pricing.json#water_calculator.headline_scenario.annual_savings_cad —
// not items[*]. Surfaces: index.html callout, floating widget, sprinkler-
// hydrawise.html callout. Only matches "$NNN/year" within "save up to" prose.
function rewriteWaterSavings(text, where) {
  const w = PRICING.water_calculator;
  if (!w || !w.headline_scenario || typeof w.headline_scenario.annual_savings_cad !== 'number') {
    return { newText: text, count: 0, hits: [] };
  }
  const canonical = '$' + w.headline_scenario.annual_savings_cad;
  if (!/save\s+up\s+to/i.test(text)) return { newText: text, count: 0, hits: [] };
  let count = 0;
  const hits = [];
  const newText = text.replace(/(\$)(\d{2,4})(\s*\/\s*year|<small>\s*\/\s*year<\/small>)/gi, (match, dollar, num, suffix) => {
    const found = dollar + num;
    if (found === canonical) return match;
    count++;
    hits.push({ rule: 'water-savings-headline', where, was: found, now: canonical });
    return canonical + suffix;
  });
  return { newText, count, hits };
}

// Per-file processor. Walks meta tags, title, and JSON-LD description fields.
function processHtml(filename, html) {
  const allHits = [];
  let totalChanges = 0;

  // 1. <meta name|property="..." content="...">
  let updated = html.replace(
    /<meta\b([^>]*?)\bcontent="([^"]*)"([^>]*?)>/g,
    (full, before, content, after) => {
      const r = rewriteFragment(content, `${filename}: <meta>`);
      const r2 = rewriteWaterSavings(r.newText, `${filename}: <meta>`);
      totalChanges += r.count + r2.count;
      allHits.push(...r.hits, ...r2.hits);
      return `<meta${before}content="${r2.newText}"${after}>`;
    }
  );

  // 2. <title>...</title>
  updated = updated.replace(/<title>([^<]*)<\/title>/, (full, content) => {
    const r = rewriteFragment(content, `${filename}: <title>`);
    totalChanges += r.count;
    allHits.push(...r.hits);
    return `<title>${r.newText}</title>`;
  });

  // 3. JSON-LD description string fields. Targets ONLY description string
  //    values, not arbitrary prose elsewhere in the JSON. Walks each
  //    <script type="application/ld+json"> block.
  updated = updated.replace(
    /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    (full, body) => {
      const newBody = body.replace(/("description"\s*:\s*")((?:\\"|[^"])*?)(")/g, (full2, p, content, q) => {
        const r = rewriteFragment(content, `${filename}: JSON-LD description`);
        totalChanges += r.count;
        allHits.push(...r.hits);
        return p + r.newText + q;
      });
      return full.replace(body, newBody);
    }
  );

  // 4. Visible body — water-savings headline. The internal "save up to" guard
  //    in rewriteWaterSavings ensures we only match $NNN/year tokens whose
  //    surrounding text says "Save up to" — i.e., the headline copy on
  //    index.html (callout + floating widget) and sprinkler-hydrawise.html.
  //    Random "$580/year" elsewhere in the body would not be touched, since
  //    nothing else on the site uses that phrase.
  if (/save\s+up\s+to/i.test(updated)) {
    const r = rewriteWaterSavings(updated, `${filename}: savings copy`);
    totalChanges += r.count;
    allHits.push(...r.hits);
    updated = r.newText;
  }

  return { newHtml: updated, totalChanges, hits: allHits };
}

// MAIN
const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
let grandChanges = 0;
const allHits = [];
const filesChanged = [];

for (const file of files) {
  const filepath = path.join(ROOT, file);
  const original = fs.readFileSync(filepath, 'utf8');
  const { newHtml, totalChanges, hits } = processHtml(file, original);
  if (totalChanges > 0) {
    grandChanges += totalChanges;
    allHits.push(...hits);
    filesChanged.push({ file, changes: totalChanges });
    if (!CHECK_ONLY) {
      fs.writeFileSync(filepath, newHtml);
    }
  }
}

if (VERBOSE && allHits.length) {
  console.log('=== Hits ===');
  allHits.forEach(h => console.log(`  [${h.rule}] ${h.where}: ${h.was} → ${h.now}`));
}

if (filesChanged.length === 0) {
  console.log('sync-meta-prices: no drift found. All meta-tag prices match pricing.json.');
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`sync-meta-prices --check: ${grandChanges} drift(s) across ${filesChanged.length} file(s):`);
  filesChanged.forEach(({ file, changes }) => console.log(`  ${file} (${changes})`));
  console.log('\nRun without --check to apply.');
  process.exit(1);
}

console.log(`sync-meta-prices: rewrote ${grandChanges} price(s) across ${filesChanged.length} file(s):`);
filesChanged.forEach(({ file, changes }) => console.log(`  ✏ ${file} (${changes})`));

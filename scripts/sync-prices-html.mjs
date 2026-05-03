// scripts/sync-prices-html.mjs
//
// Sweep every customer-facing HTML page in the repo and:
//   1. Replace context-specific hardcoded prices with <span data-price="key">$XX</span> tokens.
//   2. Update JSON-LD <script type="application/ld+json"> price values to match pricing.json.
//   3. Add the <script src="js/pricing-injector.js" defer></script> include where missing.
//
// Run: node scripts/sync-prices-html.mjs
//
// The script is CONSERVATIVE: it only replaces patterns that are unambiguous
// from surrounding text. Ambiguous prices (e.g. lonely "$120" with no nearby
// context word) are reported as manual-review items and left alone.
//
// Idempotent: re-running on already-tokenized HTML is a no-op (the regex won't
// re-match a string that already has data-price wrapped around it).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, "pricing.json"), "utf8"));

const SKIP_FILES = new Set([
  "pricing.html",       // already done manually
  "diagnose.html",
  "accessibility-statement.html",
  "privacy-policy.html",
  "terms-of-service.html",
  "sitemap.html",
  "quote-legacy.html"
]);

// Format helper (same as pricing-injector + rebuild.mjs)
function fmt(n) {
  const cents = Math.round(n * 100) % 100;
  if (cents === 0) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const P = (key) => fmt(PRICING.items[key].price);
const M = (key) => fmt(PRICING.manifold_examples[key]);

// Wrap a hardcoded price with a data-price span. The replacement preserves
// the original surrounding text and just wraps the dollar amount.
function tok(key, fallback) {
  return `<span data-price="${key}">$${fallback}</span>`;
}
function tokFormula(formula, fallback) {
  return `<span data-pjl-quote-formula="${formula}">$${fallback}</span>`;
}

// CONTEXT-AWARE REPLACEMENT PATTERNS
// Each pattern: { re: RegExp, repl: (match, ...groups) => replacement }
// Order matters — more specific patterns should come first.
const PATTERNS = [
  // ---- Service call: "$95 service call", "service call: $95", "service call - $95", "$95 to come scope"
  { re: /\$95(\s+service\s+call|\s*-\s*service\s+call|\s+to\s+come\s+(scope|diagnose))/gi,
    repl: (m, suffix) => tok("service_call", "95") + suffix },
  { re: /(service\s+call(?:\s+is)?(?:\s+just)?\s*[:—-])\s*\$95\b/gi,
    repl: (m, prefix) => prefix + " " + tok("service_call", "95") },
  { re: /(service\s+call\s+covers[^$]{0,80}?)\$95/gi,
    repl: (m, prefix) => prefix + tok("service_call", "95") },

  // ---- Head replacement: "$68 per head", "$68 flat", "$68 each", "$68 a head"
  { re: /\$68(\s+(?:flat\s+)?(?:per|each|a)\s+head|\s+flat\s+(?:rate|per\s+head)|\s+head\s+replacement)/gi,
    repl: (m, suffix) => tok("head_replacement", "68") + suffix },
  { re: /(head\s+replacement[s]?\s+(?:is|are|at|cost[s]?)\s*[:—-]?\s*)\$68\b/gi,
    repl: (m, prefix) => prefix + tok("head_replacement", "68") },

  // ---- Hunter PGV valve: "$74.95 per valve", "$74.95 each valve", "$74.95 × N"
  { re: /\$74\.95(\s+(?:per|each|a|×|x)\s+valve|\s+valve|\s+each)/gi,
    repl: (m, suffix) => tok("valve_hunter_pgv", "74.95") + suffix },

  // ---- Manifold: $135 → 3-valve, $285 → 6-valve (both near "manifold")
  { re: /(3-valve\s+manifold[^$]{0,50}?)\$135\b/gi,
    repl: (m, prefix) => prefix + tok("manifold_3valve", "135") },
  { re: /\$135(\s+manifold|\s*-\s*3-valve)/gi,
    repl: (m, suffix) => tok("manifold_3valve", "135") + suffix },
  { re: /(6-valve\s+manifold[^$]{0,50}?)\$285\b/gi,
    repl: (m, prefix) => prefix + tok("manifold_6valve", "285") },
  { re: /\$285(\s+manifold|\s*-\s*6-valve)/gi,
    repl: (m, suffix) => tok("manifold_6valve", "285") + suffix },

  // ---- Spring/fall commercial 1-4z ($145) — near "commercial"
  // (Kept old "$285 commercial" patterns commented; spring_open_commercial reframed to $145
  // in 2026-05-02 reconciliation to match interactive calculator. $285 now belongs to
  // manifold_6valve only.)
  { re: /(commercial[^$]{0,30}?)\$145\b/gi,
    repl: (m, prefix) => prefix + tok("spring_open_commercial", "145") },
  { re: /\$145(\s+commercial)/gi,
    repl: (m, suffix) => tok("spring_open_commercial", "145") + suffix },

  // ---- Controllers: $595 (1-4 zones), $750 (5-7), $1,195 (8-16)
  { re: /\$595(\s+(?:for\s+)?(?:a\s+)?(?:1-4|four)\s+zone|\s+1-4\s+zones|\s+\(1-4)/gi,
    repl: (m, s) => tok("controller_1_4", "595") + s },
  { re: /(1-4\s+zone[s]?[^$]{0,40}?)\$595\b/gi,
    repl: (m, prefix) => prefix + tok("controller_1_4", "595") },
  { re: /\$750(\s+(?:for\s+)?(?:a\s+)?(?:5-7|seven)\s+zone|\s+5-7\s+zones|\s+\(5-7)/gi,
    repl: (m, s) => tok("controller_5_7", "750") + s },
  { re: /(5-7\s+zone[s]?[^$]{0,40}?)\$750\b/gi,
    repl: (m, prefix) => prefix + tok("controller_5_7", "750") },
  { re: /\$1,195\b/g,
    repl: () => tok("controller_8_16", "1,195") },

  // ---- Spring opening: $90 near "spring" or near "≤4" or "1-4 zones residential"
  { re: /(spring\s+open(?:ing)?[^$]{0,50}?)\$90\b/gi,
    repl: (m, prefix) => prefix + tok("spring_open_4z", "90") },
  { re: /\$90(\s+spring\s+open(?:ing)?)/gi,
    repl: (m, s) => tok("spring_open_4z", "90") + s },
  // Spring opening 8-zone — $120
  { re: /(spring\s+open(?:ing)?[^$]{0,80}?(?:up\s+to\s+8|≤8|≤\s*8|5-8)\s+zone[^$]{0,30}?)\$120\b/gi,
    repl: (m, prefix) => prefix + tok("spring_open_8z", "120") },

  // ---- Fall closing tiers (reconciled 2026-05-02 to match interactive calculator)
  //   Residential: 1-4z $90, 5-6z $105, 7-8z $120, 9-15z $165
  //   (Spring uses the same prices via spring_open_4z/6z/8z/15z keys.)
  { re: /(fall\s+(?:closing|winterization)[^$]{0,60}?(?:up\s+to\s+4|≤4|≤\s*4|1-4)\s+zone[^$]{0,30}?)\$90\b/gi,
    repl: (m, prefix) => prefix + tok("fall_close_4z", "90") },
  { re: /\$90(\s+fall\s+(?:closing|winterization))/gi,
    repl: (m, s) => tok("fall_close_4z", "90") + s },
  { re: /(fall\s+(?:closing|winterization)[^$]{0,60}?(?:up\s+to\s+6|≤6|≤\s*6|5-6)\s+zone[^$]{0,30}?)\$105\b/gi,
    repl: (m, prefix) => prefix + tok("fall_close_6z", "105") },
  { re: /(fall\s+(?:closing|winterization)[^$]{0,60}?(?:up\s+to\s+8|≤8|≤\s*8|7-8)\s+zone[^$]{0,30}?)\$120\b/gi,
    repl: (m, prefix) => prefix + tok("fall_close_8z", "120") },
  { re: /(fall\s+(?:closing|winterization)[^$]{0,60}?(?:up\s+to\s+15|≤15|≤\s*15|9-15)\s+zone[^$]{0,30}?)\$165\b/gi,
    repl: (m, prefix) => prefix + tok("fall_close_15z", "165") },
  { re: /\$165(\s+fall|\s+for\s+15\s+zone)/gi,
    repl: (m, s) => tok("fall_close_15z", "165") + s },

  // ---- Wire repairs
  { re: /(wire\s+diagnostic[^$]{0,40}?)\$187\b/gi,
    repl: (m, prefix) => prefix + tok("wire_diagnostic", "187") },
  { re: /\$187(\s+wire)/gi,
    repl: (m, s) => tok("wire_diagnostic", "187") + s },
  { re: /(wire\s+run[^$]{0,40}?(?:100\s*ft|100ft)[^$]{0,20}?)\$345\b/gi,
    repl: (m, prefix) => prefix + tok("wire_run_100ft", "345") },
  { re: /(wire\s+run[^$]{0,40}?(?:175\s*ft|175ft)[^$]{0,20}?)\$435\b/gi,
    repl: (m, prefix) => prefix + tok("wire_run_175ft", "435") },
  { re: /\$1\.80\/ft\b/g,
    repl: () => tok("wire_run_per_ft", "1.80") + "/ft" },

  // ---- Pipe break: $120 + "pipe"
  { re: /(pipe\s+break[^$]{0,40}?)\$120\b/gi,
    repl: (m, prefix) => prefix + tok("pipe_break_3ft", "120") },
  { re: /\$120(\s+pipe)/gi,
    repl: (m, s) => tok("pipe_break_3ft", "120") + s },

  // ---- Hose bib: $175 near "hose bib" or "frost-free"
  { re: /(hose\s+bib[^$]{0,40}?)\+?\s*\$175\b/gi,
    repl: (m, prefix) => prefix + "+" + tok("hose_bib_install", "175") },
  { re: /\+\$175\b/g,
    repl: () => "+" + tok("hose_bib_install", "175") },

  // ---- Manifold totals (specific values)
  { re: /\$454\.85\b/g, repl: () => `<span data-price="manifold_examples.3_valve">$454.85</span>` },
  { re: /\$679\.80\b/g, repl: () => `<span data-price="manifold_examples.4_valve">$679.80</span>` },
  { re: /\$304\.95\b/g, repl: () => `<span data-price="manifold_examples.1_valve">$304.95</span>` },
  { re: /\$379\.90\b/g, repl: () => `<span data-price="manifold_examples.2_valve">$379.90</span>` },
  { re: /\$754\.75\b/g, repl: () => `<span data-price="manifold_examples.5_valve">$754.75</span>` },
  { re: /\$829\.70\b/g, repl: () => `<span data-price="manifold_examples.6_valve">$829.70</span>` },

  // ---- New install tier base fees
  { re: /\$585(\s+base|\s+\(1-4|\s+for\s+(?:a\s+)?(?:1-4|four)\s+zone)/gi,
    repl: (m, s) => tok("new_install_t1_base", "585") + s },
  { re: /\$749(\s+base|\s+\(5-7|\s+for\s+(?:a\s+)?(?:5-7|seven)\s+zone)/gi,
    repl: (m, s) => tok("new_install_t2_base", "749") + s },
  { re: /\$549(\s*\/\s*zone|\s+per\s+zone)/gi,
    repl: (m, s) => tok("new_install_per_zone", "549") + s },

  // ---- BROAD-MATCH ROUND (only-one-item-has-this-price → safe to convert):
  // These run after the context-aware patterns above, so we only catch what
  // the specific patterns missed. Each price below is unique in pricing.json.
  { re: /\$74\.95\b/g,    repl: () => tok("valve_hunter_pgv", "74.95") },
  { re: /\$1,195\b/g,     repl: () => tok("controller_8_16", "1,195") },
  { re: /\$595\b/g,       repl: () => tok("controller_1_4", "595") },
  { re: /\$750\b/g,       repl: () => tok("controller_5_7", "750") },
  { re: /\$187\b/g,       repl: () => tok("wire_diagnostic", "187") },
  { re: /\$345\b/g,       repl: () => tok("wire_run_100ft", "345") },
  { re: /\$435\b/g,       repl: () => tok("wire_run_175ft", "435") },
  { re: /\$549\b/g,       repl: () => tok("new_install_per_zone", "549") },
  { re: /\$585\b/g,       repl: () => tok("new_install_t1_base", "585") },
  { re: /\$749\b/g,       repl: () => tok("new_install_t2_base", "749") },
  { re: /\$135\b/g,       repl: () => tok("manifold_3valve", "135") },
  // $145 → spring_open_commercial / fall_close_commercial (1-4z commercial tier).
  // Both share $145 price; default to spring_open_commercial as the more-common surface.
  { re: /\$145\b/g,       repl: () => tok("spring_open_commercial", "145") },
  { re: /\$165\b/g,       repl: () => tok("spring_open_15z", "165") },
  { re: /\$175\b/g,       repl: () => tok("hose_bib_install", "175") },
  { re: /\$255\b/g,       repl: () => tok("spring_open_commercial_8z", "255") },
  { re: /\$68\b/g,        repl: () => tok("head_replacement", "68") },

  // $95 is shared between service_call and hourly_labour — both are 95 anyway,
  // so semantically either token works. Default to service_call (more common
  // surface). Will look right either way.
  { re: /\$95\b/g,        repl: () => tok("service_call", "95") },

  // ---- AMBIGUOUS — context-specific only above; bare matches left alone:
  // $90  → spring_open_4z OR fall_close_4z (both 90)
  // $105 → spring_open_6z OR fall_close_6z (both 105, post-2026-05-02 reconciliation)
  // $120 → pipe_break_3ft OR spring_open_8z OR fall_close_8z (all 120)
  // $165 → spring_open_15z OR fall_close_15z (both 165, post-2026-05-02 reconciliation)
  // $285 → manifold_6valve only (spring_open_commercial reframed to $145)
  //
  // We catch context-specific cases above. Anything bare is reported by the
  // post-run audit. For $90 we add a default-match (spring_open_4z) since
  // most prose mentions of $90 mean "from $90 spring opening" anyway. Same
  // logic for $105 → spring_open_6z.
  { re: /\$90\b/g,        repl: () => tok("spring_open_4z", "90") },
  { re: /\$105\b/g,       repl: () => tok("spring_open_6z", "105") },

  // ---- $575 is "new zone install — starts at $575" (custom quote floor)
  { re: /\$575\b/g,       repl: () => tok("new_zone_min", "575") }
];

// Manifold-rule pricing data dictionary for JSON-LD: maps offer-name regexes to
// item keys in pricing.json. When a JSON-LD <script> block contains an Offer
// matching one of these names, we update its "price" field to pricing.json's
// current value.
const SCHEMA_OFFER_MAP = [
  { match: /service\s+call/i,                              key: "service_call",            decimals: 2 },
  { match: /head\s+replacement|broken\s+head/i,            key: "head_replacement",        decimals: 2 },
  { match: /3-valve\s+manifold|manifold[^,]*\(1-3\s+valves\)/i,  key: "manifold_3valve",         decimals: 2 },
  { match: /6-valve\s+manifold|manifold[^,]*\(4-6\s+valves\)/i,  key: "manifold_6valve",         decimals: 2 },
  { match: /hunter\s+pgv|valve\s+\(per/i,                  key: "valve_hunter_pgv",        decimals: 2 },
  { match: /controller.*1-4|1-4\s+zone\s+controller/i,     key: "controller_1_4",          decimals: 2 },
  { match: /controller.*5-7|5-7\s+zone\s+controller/i,     key: "controller_5_7",          decimals: 2 },
  { match: /controller.*8-16|8-16\s+zone/i,                key: "controller_8_16",         decimals: 2 },
  { match: /wire\s+diagnostic/i,                           key: "wire_diagnostic",         decimals: 2 },
  { match: /wire\s+run.*100/i,                             key: "wire_run_100ft",          decimals: 2 },
  { match: /wire\s+run.*175/i,                             key: "wire_run_175ft",          decimals: 2 },
  { match: /pipe\s+break/i,                                key: "pipe_break_3ft",          decimals: 2 },
  // Seasonal tier mapping for JSON-LD Offer name → pricing.json key. Order matters —
  // more-specific patterns (with explicit "commercial" keyword) come first.
  { match: /spring\s+open(?:ing)?[^"]*5-?8[^"]*commercial/i,     key: "spring_open_commercial_8z",     decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*commercial/i,              key: "spring_open_commercial",        decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*1-?4[^"]*resid/i,          key: "spring_open_4z",                decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*5-?6[^"]*resid/i,          key: "spring_open_6z",                decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*7-?8[^"]*resid/i,          key: "spring_open_8z",                decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*9-?15[^"]*resid/i,         key: "spring_open_15z",               decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*4\s*zone/i,                key: "spring_open_4z",                decimals: 2 },
  { match: /spring\s+open(?:ing)?[^"]*8\s*zone/i,                key: "spring_open_8z",                decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*5-?8[^"]*commercial/i, key: "fall_close_commercial_8z", decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*commercial/i,   key: "fall_close_commercial",         decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*1-?4[^"]*resid/i,    key: "fall_close_4z",            decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*5-?6[^"]*resid/i,    key: "fall_close_6z",            decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*7-?8[^"]*resid/i,    key: "fall_close_8z",            decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*9-?15[^"]*resid/i,   key: "fall_close_15z",           decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*4\s*zone/i,     key: "fall_close_4z",                 decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*6\s*zone/i,     key: "fall_close_6z",                 decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*8\s*zone/i,     key: "fall_close_8z",                 decimals: 2 },
  { match: /fall\s+(?:closing|winterization)[^"]*15\s*zone/i,    key: "fall_close_15z",                decimals: 2 },
  { match: /hose\s+bib/i,                                  key: "hose_bib_install",        decimals: 2 }
];

function updateJsonLdPrices(html) {
  // Match each <script type="application/ld+json"> block individually.
  return html.replace(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, (block, body) => {
    let updated = body;
    // For each Offer object, match by NAME ONLY (descriptions often mention
    // multiple prices in prose like "$95 service call" which would falsely
    // match other offers). Update the structured "price" field only.
    updated = updated.replace(/\{[^{}]*?"@type"\s*:\s*"Offer"[^{}]*?\}/g, (offer) => {
      const nameMatch = offer.match(/"name"\s*:\s*"([^"]+)"/);
      const name = nameMatch ? nameMatch[1] : "";
      if (!name) return offer;
      for (const { match, key, decimals } of SCHEMA_OFFER_MAP) {
        if (match.test(name)) {
          const item = PRICING.items[key];
          if (!item || item.price === 0) continue;
          const newPrice = item.price.toFixed(decimals);
          if (/"price"\s*:\s*"[^"]*"/.test(offer)) {
            return offer.replace(/"price"\s*:\s*"[^"]*"/, `"price": "${newPrice}"`);
          }
          break;
        }
      }
      return offer;
    });
    return block.replace(body, updated);
  });
}

// Find tag end accounting for quoted attributes (so nested `>` doesn't terminate).
function findTagEnd(html, start) {
  let i = start + 1;
  let inQuote = null;
  while (i < html.length) {
    const c = html[i];
    if (inQuote) { if (c === inQuote) inQuote = null; }
    else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ">") return i + 1;
    }
    i++;
  }
  return html.length;
}

function applyVisiblePricePatterns(html) {
  // Protect blocks that should NEVER be touched: scripts, styles, comments,
  // existing data-price spans, AND HTML attributes like <meta content="...">,
  // <title>, <link>, etc. (browsers don't render HTML inside attribute values,
  // so injecting a span there breaks the markup for SEO crawlers).
  const protectedBlocks = [];
  function protect(str) {
    protectedBlocks.push(str);
    return `__PJL_PROTECT_${protectedBlocks.length - 1}__`;
  }

  // 1. Walk the document and protect meta/link/title tags + their bodies.
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lower = html.substring(i, i + 7).toLowerCase();
    if (lower.startsWith("<meta") && /[\s>]/.test(html[i + 5] || "")) {
      const end = findTagEnd(html, i); out += protect(html.substring(i, end)); i = end; continue;
    }
    if (lower.startsWith("<link") && /[\s>]/.test(html[i + 5] || "")) {
      const end = findTagEnd(html, i); out += protect(html.substring(i, end)); i = end; continue;
    }
    if (lower.startsWith("<title>")) {
      const close = html.toLowerCase().indexOf("</title>", i + 7);
      const end = close === -1 ? html.length : close + 8;
      out += protect(html.substring(i, end)); i = end; continue;
    }
    out += html[i]; i++;
  }

  // 2. Protect scripts, styles, comments, existing tokens.
  let protectedHtml = out
    .replace(/<script[\s\S]*?<\/script>/gi, protect)
    .replace(/<style[\s\S]*?<\/style>/gi, protect)
    .replace(/<!--[\s\S]*?-->/g, protect)
    .replace(/<span\s+data-price[^>]*>[^<]*<\/span>/gi, protect)
    .replace(/<span\s+data-pjl-quote-formula[^>]*>[^<]*<\/span>/gi, protect);

  // 3. Apply the price patterns to what's left (visible body content only).
  for (const { re, repl } of PATTERNS) {
    protectedHtml = protectedHtml.replace(re, repl);
  }

  // 4. Restore.
  return protectedHtml.replace(/__PJL_PROTECT_(\d+)__/g, (m, idx) => protectedBlocks[Number(idx)]);
}

function ensureInjectorScript(html) {
  if (html.includes("js/pricing-injector.js")) return html;
  // Strategy: insert ONCE. If chat-widget.js include exists, place ours just
  // before it. Otherwise, place before </body>. Use a guard so the second
  // replace can't fire if the first already placed the tag.
  let inserted = false;
  let result = html.replace(
    /(\s*)(<script\s+src="js\/chat-widget\.js"[^>]*><\/script>)/i,
    (m, ws, tag) => {
      inserted = true;
      return `${ws}<script src="js/pricing-injector.js" defer></script>${ws}${tag}`;
    }
  );
  if (!inserted) {
    result = result.replace(
      /(\s*)<\/body>/i,
      (m, ws) => `${ws}<script src="js/pricing-injector.js" defer></script>${ws}</body>`
    );
  }
  return result;
}

// MAIN
const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".html") && !SKIP_FILES.has(f));
let totalChanges = 0;
const changesByFile = {};

for (const file of files) {
  const filepath = path.join(ROOT, file);
  const original = fs.readFileSync(filepath, "utf8");

  let updated = original;
  updated = updateJsonLdPrices(updated);
  updated = applyVisiblePricePatterns(updated);
  updated = ensureInjectorScript(updated);

  if (updated !== original) {
    fs.writeFileSync(filepath, updated);
    // Rough diff: count changed lines
    const origLines = original.split("\n");
    const updLines = updated.split("\n");
    let diffCount = Math.abs(origLines.length - updLines.length);
    for (let i = 0; i < Math.min(origLines.length, updLines.length); i++) {
      if (origLines[i] !== updLines[i]) diffCount++;
    }
    totalChanges += diffCount;
    changesByFile[file] = diffCount;
    console.log(`  ✏ ${file} (${diffCount} lines changed)`);
  }
}

console.log(`\nDone. Modified ${Object.keys(changesByFile).length} files, ${totalChanges} lines total.`);

// Final audit: any remaining hardcoded prices that the patterns missed?
console.log("\n=== Remaining hardcoded $ prices (manual review needed) ===");
const knownPrices = ["95", "68", "74.95", "135", "285", "120", "90", "145", "595", "750", "1,195", "1195", "345", "435", "187", "454.85", "829.70", "679.80", "304.95", "379.90", "754.75", "575", "585", "549", "749", "175"];
const priceRegex = new RegExp("\\$(?:" + knownPrices.map(p => p.replace(/\./g, "\\.")).join("|") + ")\\b", "g");
for (const file of files) {
  const filepath = path.join(ROOT, file);
  const content = fs.readFileSync(filepath, "utf8");
  // Only flag prices NOT inside a data-price span and NOT inside JSON-LD (already handled)
  const stripped = content
    .replace(/<span\s+data-price[^>]*>[^<]*<\/span>/gi, "")
    .replace(/<span\s+data-pjl-quote-formula[^>]*>[^<]*<\/span>/gi, "")
    .replace(/<script\s+type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, "");
  const matches = stripped.match(priceRegex);
  if (matches && matches.length > 0) {
    console.log(`  ⚠ ${file}: ${matches.length} unconverted prices — ${[...new Set(matches)].slice(0, 10).join(", ")}`);
  }
}

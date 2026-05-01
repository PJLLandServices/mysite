// Build the deployable worker.js by:
//   1. Reading pricing.json (the single source of truth)
//   2. Reading system_prompt.md (which uses {{token}} placeholders)
//   3. Substituting tokens from pricing.json into the prompt
//   4. Escaping for use inside a JS template literal
//   5. Splicing the result into worker.js between the existing
//      `const SYSTEM_PROMPT = `...`;` markers
//
// Token resolution:
//   {{service_call}}            → pricing.items.service_call.price
//   {{manifold_examples.3_valve} → pricing.manifold_examples["3_valve"]
//   {{items.service_call.label} → pricing.items.service_call.label
//
// Whole-dollar prices format as integers (95), prices with cents keep
// two decimals (74.95). Customers and the AI both notice rounding so we
// preserve the master form.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'pricing.json');
const PROMPT_PATH = path.join(__dirname, 'system_prompt.md');
const WORKER_PATH = path.join(__dirname, 'worker.js');

const pricing = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));

function formatPrice(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  const cents = Math.round(n * 100) % 100;
  if (cents === 0) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function resolveToken(key) {
  // Dotted lookup
  if (key.includes('.')) {
    const parts = key.split('.');
    let val = pricing;
    for (const p of parts) {
      if (val && typeof val === 'object' && p in val) val = val[p];
      else return null;
    }
    return typeof val === 'number' ? formatPrice(val) : (val == null ? null : String(val));
  }
  // Shorthand for items: {{service_call}} → pricing.items.service_call.price
  if (pricing.items && pricing.items[key]) {
    return formatPrice(pricing.items[key].price);
  }
  return null;
}

let body = fs.readFileSync(PROMPT_PATH, 'utf8');

// Slice from "## WHO YOU ARE" downward (skip the front-matter title + intro).
const start = body.indexOf('## WHO YOU ARE');
if (start === -1) {
  console.error('FATAL: "## WHO YOU ARE" marker not found in system_prompt.md');
  process.exit(1);
}
body = body.slice(start).trimEnd();

// Substitute all {{key}} tokens.
const unresolvedTokens = [];
body = body.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
  const trimmed = key.trim();
  const value = resolveToken(trimmed);
  if (value == null) {
    unresolvedTokens.push(trimmed);
    return match; // leave as-is so it's visible in the deployed prompt
  }
  return value;
});

if (unresolvedTokens.length) {
  console.error('UNRESOLVED TOKENS in system_prompt.md:', [...new Set(unresolvedTokens)]);
  console.error('Aborting deploy — fix the tokens or add the keys to pricing.json.');
  process.exit(1);
}

// Escape for use inside a JS template literal.
const escaped = body
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// Splice into worker.js.
let js = fs.readFileSync(WORKER_PATH, 'utf8');
const reStart = js.indexOf('const SYSTEM_PROMPT = `');
if (reStart === -1) {
  console.error('FATAL: "const SYSTEM_PROMPT = `" marker not found in worker.js');
  process.exit(1);
}
let i = reStart + 'const SYSTEM_PROMPT = `'.length;
while (i < js.length) {
  if (js[i] === '\\') { i += 2; continue; }
  if (js[i] === '`') break;
  i++;
}
const semi = js.indexOf(';', i + 1);
fs.writeFileSync(
  WORKER_PATH,
  js.slice(0, reStart) + 'const SYSTEM_PROMPT = `' + escaped + '`;' + js.slice(semi + 1)
);

console.log(`OK — substituted prompt body (${escaped.length} bytes) into worker.js`);
console.log(`     pricing.json: ${Object.keys(pricing.items).length} items, ${Object.keys(pricing.manifold_examples || {}).length - 1} manifold examples`);

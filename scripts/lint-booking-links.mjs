#!/usr/bin/env node
// scripts/lint-booking-links.mjs
//
// CI gate: every book.html?service=<key> link on the site must name a key
// that book.html actually recognises.
//
// Why this exists. js/booking.js applies ?service= only when the value is
// present in BOOKABLE_SERVICES; anything else falls through in silence to
// the unfiltered service catalog. No console error, no customer-visible
// message, no server log — the link simply doesn't do what it says. That
// made two typos survive from the initial upload to Aug 2026 across the 13
// core service-area pages: ?service=spring_opening (a FAMILY name, not a
// service key) and ?service=fall_winterization (neither — the family is
// fall_closing). Fall visitors clicking "Book your winterization" landed on
// a menu whose first cards were Spring Opening.
//
// The failure is invisible at runtime, so it has to be caught at build time.
//
// Scope: ROOT-level *.html, js/*.js, and server/*.{html,js} — the public
// pages, the shared page scripts, and the logged-in surfaces (the customer
// portal books services too, and its links were outside this gate until the
// portal gained booking routes).
//
// Modes:
//   node scripts/lint-booking-links.mjs            # exit 1 on any bad key
//   node scripts/lint-booking-links.mjs --verbose  # also list every valid key

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const require = createRequire(import.meta.url);
const { BOOKABLE_SERVICES } = require(path.join(ROOT, 'server/lib/availability.js'));

const RECOGNISED = new Set(Object.keys(BOOKABLE_SERVICES));
const BOOKABLE = new Set(
  Object.entries(BOOKABLE_SERVICES).filter(([, m]) => m.bookable).map(([k]) => k)
);

// Matches book.html?service=KEY in href="…", in JS string concatenation, and
// in absolute URLs. Stops at whatever ends the value.
const LINK_RE = /book\.html\?service=([^"'\s&#<>)}]+)/g;

function filesIn(dir, exts) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => (dir ? path.join(dir, f) : f));
}

const files = [
  ...filesIn('', ['.html']),
  ...filesIn('js', ['.js']),
  ...filesIn('server', ['.html', '.js']),
].sort();

const problems = [];
let linkCount = 0;
const seen = new Map();

for (const rel of files) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) {
      const raw = m[1];
      // Skip links whose key is built at runtime (e.g. "…service=" + key).
      if (/[+`$\\]/.test(raw)) continue;
      const key = decodeURIComponent(raw);
      linkCount += 1;
      seen.set(key, (seen.get(key) || 0) + 1);

      if (!RECOGNISED.has(key)) {
        const hint = /-/.test(key)
          ? ' (hyphenated — booking keys use underscores)'
          : Object.keys(BOOKABLE_SERVICES).some((k) => BOOKABLE_SERVICES[k].family === key)
            ? ' (this is a FAMILY name, not a bookable service key)'
            : '';
        problems.push({ rel, line: i + 1, key, why: 'not a key book.html recognises' + hint });
      } else if (!BOOKABLE.has(key)) {
        problems.push({ rel, line: i + 1, key, why: 'key exists but is not bookable' });
      }
    }
  });
}

if (VERBOSE) {
  console.log('Recognised ?service= keys (%d):', RECOGNISED.size);
  [...RECOGNISED].sort().forEach((k) => console.log('  ' + k + (BOOKABLE.has(k) ? '' : '  [not bookable]')));
  console.log('\nKeys linked on the site (%d distinct):', seen.size);
  [...seen.entries()].sort().forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}x  ${k}`));
  console.log('');
}

if (problems.length) {
  console.error(`lint-booking-links: FAIL — ${problems.length} link(s) name a ?service= key book.html can't resolve.\n`);
  for (const p of problems) {
    console.error(`  ${p.rel}:${p.line}  ?service=${p.key}`);
    console.error(`    ${p.why}`);
  }
  console.error('\nA link like this fails SILENTLY at runtime: book.html drops the');
  console.error('filter and renders the full service catalog, so the visitor lands on');
  console.error('a menu that may be the wrong season entirely.\n');
  console.error('Fix by pointing the link at a real key from server/lib/availability.js');
  console.error('(run this script with --verbose to list them).');
  process.exit(1);
}

console.log(
  `lint-booking-links: PASS — ${linkCount} book.html?service= link(s) across ` +
  `${files.length} files, all resolve to bookable services.`
);

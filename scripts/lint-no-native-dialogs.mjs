#!/usr/bin/env node
// scripts/lint-no-native-dialogs.mjs
//
// CI gate for the branded-dialogs migration (PJL-58..PJL-62): fails
// build:check on any NEW native alert()/confirm()/prompt() call in a
// browser-loaded CRM file, outside the explicit ALLOWLIST_FILES below.
//
// The migration moves file by file (see PJL-59/PJL-60/PJL-61). A file
// stays on ALLOWLIST_FILES until every native call in it has been replaced
// with the shared window.pjlDialog.alert()/.confirm()/.prompt() component
// (server/pjl-dialog.js) — then it comes OFF the list here, in the same
// PR that finishes migrating it. That's what keeps the count shrinking:
// remove a file too early and this script starts failing on its own
// leftover native calls; remove it late and nothing enforces the file
// stays clean once it's done.
//
// Scope: server/*.html + server/*.js (flat, not recursive) — the
// browser-loaded surface. Excludes server/server.js and everything under
// server/lib/, which never run in a browser and were never in scope.
//
// Detection: window.pjlDialog.*(...) and window.pjlBulkModal.*(...) calls
// are always allowed (they're the branded replacement). `function
// confirm(...)`-style declarations are allowed too (bulk-modal.js names
// its own helper `confirm`, which is not a call to the native global).
// Comments and string literals are stripped before matching, so prose
// like "replaces window.confirm()" in a code comment doesn't trip this.
// That stripping isn't a full JS parser (division vs. regex-literal `/`
// isn't disambiguated, for instance) — if it ever mis-detects a real line,
// add a fine-grained ALLOWLIST entry below with a reason, same convention
// as scripts/lint-no-hardcoded-prices.mjs.
//
// Modes:
//   node scripts/lint-no-native-dialogs.mjs           # exit 1 if any drift
//   node scripts/lint-no-native-dialogs.mjs --verbose # also print line content

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const VERBOSE = process.argv.includes('--verbose');

// Files still permitted to contain native alert/confirm/prompt calls
// because they haven't been migrated yet. Drop a file from this list in
// the same PR that finishes migrating every call site in it.
//
// Counts below are informational (native-call count as of PJL-60's
// highest-volume-file round landing, 2026-09-21 — plain alert()s only
// remain in these five, confirm()/prompt() are done) — not enforced,
// just so a shrinking list is visible in the diff over time.
const ALLOWLIST_FILES = [
  { file: 'sitebuilder.html', count: 50, reason: 'Not yet migrated — PJL-60/PJL-61 (highest single-file count).' },
  { file: 'work-order-tech.js', count: 32, reason: 'Only alert()s remain — confirm()/prompt() fully migrated (PJL-59 + PJL-60). Rest pending PJL-61.' },
  { file: 'quote-folder.js', count: 29, reason: 'Only alert()s remain — confirm()/prompt() fully migrated (PJL-59 + PJL-60). Rest pending PJL-61.' },
  { file: 'project.js', count: 24, reason: 'Only alert()s remain — confirm()/prompt() fully migrated (PJL-59 + PJL-60). Rest pending PJL-61.' },
  { file: 'work-order.js', count: 21, reason: 'Only alert()s remain — confirm()/prompt() fully migrated (PJL-60). Rest pending PJL-61.' },
  { file: 'quote-proposal-builder.js', count: 10, reason: 'Some call sites already fixed in PJL-59; rest pending PJL-60/PJL-61.' },
  { file: 'settings.js', count: 8, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'customer.js', count: 7, reason: 'Some call sites already fixed in PJL-59; rest pending PJL-60/PJL-61.' },
  { file: 'material-list.js', count: 7, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'invoice.js', count: 6, reason: 'Only alert()s remain — confirm() fully migrated (PJL-59 + PJL-60). Rest pending PJL-61.' },
  { file: 'property.js', count: 5, reason: 'Not yet migrated — PJL-61 (informational alerts).' },
  { file: 'purchase-order.js', count: 5, reason: 'Some call sites already fixed in PJL-59; rest pending PJL-60/PJL-61.' },
  { file: 'work-order-build.js', count: 5, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'admin.js', count: 4, reason: 'Some call sites already fixed in PJL-59; rest pending PJL-60/PJL-61.' },
  { file: 'admin.html', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'customers.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'handoff.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'properties.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'quote-request.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'today.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'work-orders-index.js', count: 3, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'review-requests.html', count: 2, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'appointment.js', count: 2, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'properties-import.js', count: 2, reason: 'Not yet migrated — PJL-61 (informational alerts).' },
  { file: 'schedule.js', count: 2, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'suppliers.js', count: 2, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'users.js', count: 2, reason: 'Some call sites already fixed in PJL-59; rest pending PJL-60/PJL-61.' },
  { file: 'smart-controller-photos.html', count: 1, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'welcome-email.html', count: 1, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'booking.js', count: 1, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'outreach.js', count: 1, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'portal.js', count: 1, reason: 'Not yet migrated — PJL-60/PJL-61.' },
  { file: 'voice-input.js', count: 1, reason: 'Not yet migrated — PJL-61 (informational alerts).' },
  // The 10 highest-stakes calls (customer.js:905, users.js:218,
  // purchase-order.js:553, quote-folder.js:366/399,
  // quote-proposal-builder.js:1794/2320/1120, admin.js:912,
  // work-order-tech.js:4428, project.js:1140 via askConfirm) are migrated
  // in PJL-59. Their files stay above until every OTHER native call in
  // them is also gone — see PJL-60/PJL-61.
];
const ALLOWLIST_FILE_SET = new Set(ALLOWLIST_FILES.map(e => e.file));

// Fine-grained, permanent exceptions (same shape as
// lint-no-hardcoded-prices.mjs's ALLOWLIST): { file, match, reason }.
// `match` is a substring of the offending (original, unstripped) line.
// Empty for now — populate as deliberate, documented exceptions surface
// near the end of the migration (see PRD success criteria: "0 remain, or
// each remaining one is a deliberate, documented exception").
const ALLOWLIST = [];

function isLineAllowed(file, line) {
  return ALLOWLIST.some(entry => entry.file === file && line.includes(entry.match));
}

// window.pjlDialog.*()/window.pjlBulkModal.*() are the branded
// replacement, never a violation. `function confirm(...)` etc. is a
// declaration (bulk-modal.js names its own helper this way), not a call
// to the native global.
const NATIVE_RE = /(?<!pjlDialog\.)(?<!pjlBulkModal\.)(?<!function )(?<!function  )\b(alert|confirm|prompt)\s*\(/g;

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

// Position-preserving: blanks out block/line comments, string- and
// template-literal contents, and regex literals, so matches inside them
// don't count — while keeping line numbers aligned with the original
// file. Regex-literal vs. division `/` is resolved with the standard
// "what token came before it" heuristic (an operator/keyword before `/`
// means a regex starts; an identifier/number/closing-bracket before it
// means division) — not a full parser, but it correctly handles the real
// case that motivated it: an escapeHtml() helper with .replace(/"/g, ...)
// whose regex contains a bare quote character, which a naive quote
// scanner would otherwise misread as the start of a string and lose sync
// with the rest of the file. `${...}` interpolation inside template
// literals is tracked with its own brace-depth stack, so a `}` that
// closes an object literal INSIDE an interpolation doesn't prematurely
// end the template string, and a nested template literal inside an
// interpolation nests correctly too.
function stripJsCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let tail = '';
  const stack = [{ type: 'code' }];

  function pushReal(ch) {
    out += ch;
    if (!/\s/.test(ch)) tail = (tail + ch).slice(-16);
  }
  function markValueEnded() {
    tail = (tail + 'x').slice(-16);
  }
  const OPERATOR_PRECEDERS = new Set('([{,;:=&|!?+-*%^~<>'.split(''));
  const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'do', 'else', 'yield', 'await']);
  function regexAllowedHere() {
    const t = tail.replace(/\s+$/, '');
    if (t === '') return true;
    const last = t[t.length - 1];
    if (OPERATOR_PRECEDERS.has(last)) return true;
    const wordMatch = t.match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (wordMatch) return KEYWORDS.has(wordMatch[0]);
    return false;
  }

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = code[i];
    const c2 = code[i + 1];

    if (frame.type === 'template') {
      if (c === '\\' && i + 1 < n) {
        out += c === '\n' ? '\n' : ' ';
        out += code[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
        continue;
      }
      if (c === '`') {
        out += ' '; i++; stack.pop(); markValueEnded();
        continue;
      }
      if (c === '$' && c2 === '{') {
        out += '  '; i += 2;
        stack.push({ type: 'code', braceDepth: 0, fromTemplate: true });
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    // frame.type === 'code'
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '/' && c2 === '/') {
      out += '  '; i += 2;
      while (i < n && code[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c; out += ' '; i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < n) {
          out += code[i] === '\n' ? '\n' : ' ';
          out += code[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      markValueEnded();
      continue;
    }
    if (c === '`') {
      out += ' '; i++;
      stack.push({ type: 'template' });
      continue;
    }
    if (c === '/' && regexAllowedHere()) {
      out += ' '; i++;
      let inClass = false;
      let terminated = false;
      while (i < n) {
        if (code[i] === '\\' && i + 1 < n) {
          out += code[i] === '\n' ? '\n' : ' ';
          out += code[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        if (code[i] === '\n') break;
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) { out += ' '; i++; terminated = true; break; }
        out += ' '; i++;
      }
      if (terminated) { while (i < n && /[a-zA-Z]/.test(code[i])) { out += ' '; i++; } }
      markValueEnded();
      continue;
    }
    if (frame.fromTemplate) {
      if (c === '{') { frame.braceDepth++; }
      else if (c === '}') {
        if (frame.braceDepth === 0) {
          out += ' '; i++; stack.pop();
          continue;
        }
        frame.braceDepth--;
      }
    }
    pushReal(c);
    i++;
  }
  return out;
}

function scanFile(filename, text, isHtml) {
  let cleaned = isHtml ? stripHtmlComments(text) : text;
  cleaned = stripJsCommentsAndStrings(cleaned);
  const strippedLines = cleaned.split('\n');
  const originalLines = text.split('\n');
  const violations = [];

  for (let i = 0; i < strippedLines.length; i++) {
    if (!NATIVE_RE.test(strippedLines[i])) continue;
    NATIVE_RE.lastIndex = 0;
    const originalLine = originalLines[i];
    if (isLineAllowed(filename, originalLine)) continue;
    violations.push({
      file: filename,
      lineNo: i + 1,
      line: originalLine.trim().slice(0, 200),
    });
  }
  return violations;
}

const htmlFiles = fs.readdirSync(SERVER_DIR).filter(f => f.endsWith('.html'));
const jsFiles = fs.readdirSync(SERVER_DIR).filter(f => f.endsWith('.js') && f !== 'server.js');

const allViolations = [];
for (const file of [...htmlFiles, ...jsFiles]) {
  if (ALLOWLIST_FILE_SET.has(file)) continue;
  const filepath = path.join(SERVER_DIR, file);
  const text = fs.readFileSync(filepath, 'utf8');
  allViolations.push(...scanFile(file, text, file.endsWith('.html')));
}

if (allViolations.length === 0) {
  console.log(`lint-no-native-dialogs: PASS — no new native alert/confirm/prompt calls outside the ${ALLOWLIST_FILES.length}-file migration allowlist.`);
  process.exit(0);
}

console.log(`lint-no-native-dialogs: FAIL — ${allViolations.length} native alert/confirm/prompt call(s) found outside the migration allowlist:`);
console.log('');
for (const v of allViolations) {
  console.log(`  ${v.file}:${v.lineNo}`);
  if (VERBOSE) console.log(`     ${v.line}`);
}
console.log('');
console.log('To resolve each violation:');
console.log('  1. Replace it with window.pjlDialog.alert()/.confirm()/.prompt() (server/pjl-dialog.js) — see PJL-58/PJL-59/PJL-60/PJL-61.');
console.log('  2. If this file is mid-migration, add it to ALLOWLIST_FILES in this script (only if it isn\'t there already).');
console.log('  3. For a deliberate, permanent exception, add a fine-grained entry to ALLOWLIST with a reason.');
process.exit(1);

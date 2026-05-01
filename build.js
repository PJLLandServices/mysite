#!/usr/bin/env node
/**
 * PJL Land Services — partial-include build script.
 *
 * Reads partials from _partials/ and replaces marker blocks in every
 * top-level *.html file. Two flavours:
 *
 *   Plain include (no per-page values):
 *     <!-- @@PJL:footer-START -->
 *     ...current markup...
 *     <!-- @@PJL:footer-END -->
 *
 *   Tokenised include (per-page JSON values get substituted into the
 *   partial template):
 *     <!-- @@PJL:nav-START {"loc":"Newmarket & GTA","status":"Same-day repair available"} -->
 *     ...current markup...
 *     <!-- @@PJL:nav-END -->
 *
 *   In the partial template, write {{loc}}, {{status}} etc. to slot
 *   the per-page values in.
 *
 * Files without markers are skipped. Build is idempotent.
 *
 * Usage:
 *   node build.js              # run build
 *   node build.js --check      # exit non-zero if any file would change
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PARTIALS_DIR = path.join(ROOT, '_partials');

// Each entry: marker name (used in <!-- @@PJL:NAME-START --> tags) → partial filename.
const PARTIALS = [
  ['nav', 'nav.html'],
  ['footer', 'footer.html'],
];

const SKIP_FILES = new Set([
  'quote-legacy.html',
]);

function loadPartial(filename) {
  const full = path.join(PARTIALS_DIR, filename);
  return fs.readFileSync(full, 'utf8').replace(/\n+$/, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Apply {{token}} substitutions to a template string.
// Tokens not found in the values dict are left as-is (visible bug → catchable).
function applyTokens(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return String(values[key]);
    }
    console.warn(`  warning: missing token "${key}"`);
    return match;
  });
}

function processFile(filepath, partials, dryRun) {
  let src = fs.readFileSync(filepath, 'utf8');
  let changed = false;

  for (const [name, content] of partials) {
    // START tag may optionally carry a JSON payload (per-page tokens).
    // Pattern captures the payload (group 1) and the body up through END.
    const startBase = `<!-- @@PJL:${name}-START`;
    const endTag = `<!-- @@PJL:${name}-END -->`;
    const pattern = new RegExp(
      escapeRegex(startBase) + '(\\s+(\\{[^}]*?\\}))?\\s*-->[\\s\\S]*?' + escapeRegex(endTag),
      'g'
    );
    if (!pattern.test(src)) continue;
    pattern.lastIndex = 0;

    src = src.replace(pattern, (match, _full, jsonPayload) => {
      let rendered = content;
      let startTag;
      if (jsonPayload) {
        let tokens;
        try {
          tokens = JSON.parse(jsonPayload);
        } catch (e) {
          console.error(`  ERROR parsing tokens in ${path.basename(filepath)}: ${e.message}`);
          console.error(`  payload was: ${jsonPayload}`);
          process.exit(2);
        }
        rendered = applyTokens(content, tokens);
        // Preserve the JSON payload so the next build can re-render with the same tokens
        startTag = `${startBase} ${jsonPayload} -->`;
      } else {
        startTag = `${startBase} -->`;
      }
      return `${startTag}\n${rendered}\n${endTag}`;
    });
    changed = true;
  }

  // Compare against original to detect actual textual change
  const original = fs.readFileSync(filepath, 'utf8');
  if (src !== original) {
    if (!dryRun) fs.writeFileSync(filepath, src);
    return true;
  }
  return false;
}

function main() {
  const dryRun = process.argv.includes('--check');
  const partials = PARTIALS.map(([name, file]) => [name, loadPartial(file)]);

  const files = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => !SKIP_FILES.has(f))
    .sort();

  const changedFiles = [];
  let scanned = 0;
  for (const f of files) {
    const fp = path.join(ROOT, f);
    if (processFile(fp, partials, dryRun)) changedFiles.push(f);
    scanned += 1;
  }

  if (dryRun) {
    if (changedFiles.length > 0) {
      console.error(`build check: ${changedFiles.length} file(s) out of sync:`);
      changedFiles.forEach((f) => console.error(`  ${f}`));
      process.exit(1);
    }
    console.log(`build check: ${scanned} files scanned, all in sync`);
  } else {
    console.log(`build: ${scanned} scanned, ${changedFiles.length} updated`);
    changedFiles.forEach((f) => console.log(`  ${f}`));
  }
}

main();

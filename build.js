#!/usr/bin/env node
/**
 * PJL Land Services — partial-include build script.
 *
 * Reads partials from _partials/ and replaces marker blocks in every
 * top-level *.html file. Pages declare an include like:
 *
 *   <!-- @@PJL:footer-START -->
 *   ...whatever current footer markup...
 *   <!-- @@PJL:footer-END -->
 *
 * After running `node build.js`, everything between START and END
 * gets replaced with the contents of _partials/footer.html. Files
 * without the marker pair are skipped.
 *
 * Usage:
 *   node build.js              # run build
 *   node build.js --check      # exit non-zero if any file would change
 *
 * Run this BEFORE committing if you've edited a partial.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PARTIALS_DIR = path.join(ROOT, '_partials');

// Each entry: [marker name (used in <!-- @@PJL:NAME-START --> tags), partial filename]
const PARTIALS = [
  ['footer', 'footer.html'],
];

// Files we never touch even if they happen to have markers.
const SKIP_FILES = new Set([
  'quote-legacy.html', // robots-disallowed backup, hands off
]);

function loadPartial(filename) {
  const full = path.join(PARTIALS_DIR, filename);
  let content = fs.readFileSync(full, 'utf8');
  // Strip a trailing newline so we don't accumulate blank lines on each build.
  return content.replace(/\n+$/, '');
}

function processFile(filepath, partials, dryRun) {
  let src = fs.readFileSync(filepath, 'utf8');
  let changed = false;

  for (const [name, content] of partials) {
    const startTag = `<!-- @@PJL:${name}-START -->`;
    const endTag = `<!-- @@PJL:${name}-END -->`;
    // Match start tag, anything (incl. newlines), end tag — non-greedy
    const pattern = new RegExp(
      escapeRegex(startTag) + '[\\s\\S]*?' + escapeRegex(endTag),
      'g'
    );
    if (!pattern.test(src)) continue;
    pattern.lastIndex = 0;
    const replacement = `${startTag}\n${content}\n${endTag}`;
    const next = src.replace(pattern, replacement);
    if (next !== src) {
      changed = true;
      src = next;
    }
  }

  if (changed && !dryRun) {
    fs.writeFileSync(filepath, src);
  }
  return changed;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const dryRun = process.argv.includes('--check');
  const partials = PARTIALS.map(([name, file]) => [name, loadPartial(file)]);

  const files = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => !SKIP_FILES.has(f))
    .sort();

  const changedFiles = [];
  let scannedCount = 0;
  for (const f of files) {
    const fp = path.join(ROOT, f);
    const result = processFile(fp, partials, dryRun);
    scannedCount += 1;
    if (result) changedFiles.push(f);
  }

  if (dryRun) {
    if (changedFiles.length > 0) {
      console.error(`build check: ${changedFiles.length} file(s) out of sync:`);
      changedFiles.forEach((f) => console.error(`  ${f}`));
      process.exit(1);
    }
    console.log(`build check: ${scannedCount} files scanned, all in sync`);
  } else {
    console.log(`build: ${scannedCount} scanned, ${changedFiles.length} updated`);
    changedFiles.forEach((f) => console.log(`  ${f}`));
  }
}

main();

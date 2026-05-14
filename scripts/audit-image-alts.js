#!/usr/bin/env node
/**
 * Image alt-text audit.
 *
 * Scans every root-level *.html file for <img> tags and classifies each
 * one's alt attribute. Reports:
 *   MISSING   — no alt attribute at all (worst — screen readers read the URL)
 *   EMPTY     — alt="" (only valid for purely decorative images; flag for review)
 *   GENERIC   — alt="image", "photo", "picture", "logo", single chars, etc.
 *   FILENAME  — alt looks like a filename ("IMG_1234", "*_edited_edited.png", etc.)
 *   OK        — alt has meaningful descriptive text
 *
 * Run: node scripts/audit-image-alts.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

const GENERIC_ALTS = new Set([
  'image', 'photo', 'picture', 'pic', 'logo', 'icon', 'img', 'photograph',
  '.', '..', '-', 'x', 'banner', 'graphic', 'photo of', 'image of',
]);

const FILENAME_RE = /(^|\s)(IMG[_-]?\d+|DSC[_-]?\d+|[A-Z0-9_-]+_edited(_edited)*|[\w-]+\.(png|jpg|jpeg|gif|webp|svg|mp4))/i;

function classifyAlt(alt) {
  if (alt === null) return 'MISSING';
  const trimmed = alt.trim();
  if (trimmed === '') return 'EMPTY';
  if (GENERIC_ALTS.has(trimmed.toLowerCase())) return 'GENERIC';
  if (FILENAME_RE.test(trimmed)) return 'FILENAME';
  if (trimmed.length < 4) return 'GENERIC';
  return 'OK';
}

function extractImgs(html) {
  const imgs = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const alt = altMatch ? (altMatch[1] !== undefined ? altMatch[1] : altMatch[2]) : null;
    const src = srcMatch ? (srcMatch[1] !== undefined ? srcMatch[1] : srcMatch[2]) : '(no src)';
    imgs.push({ tag, alt, src });
  }
  return imgs;
}

const summary = { MISSING: 0, EMPTY: 0, GENERIC: 0, FILENAME: 0, OK: 0 };
const issuesByFile = {};

for (const f of files) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const imgs = extractImgs(html);
  for (const img of imgs) {
    const cls = classifyAlt(img.alt);
    summary[cls] += 1;
    if (cls !== 'OK') {
      if (!issuesByFile[f]) issuesByFile[f] = [];
      issuesByFile[f].push({ cls, alt: img.alt, src: img.src });
    }
  }
}

console.log('IMAGE ALT-TEXT AUDIT');
console.log('====================');
console.log(`Files scanned: ${files.length}`);
console.log(`Total <img> tags: ${Object.values(summary).reduce((a, b) => a + b, 0)}`);
console.log('');
console.log('Classification:');
console.log(`  OK        ${summary.OK}`);
console.log(`  MISSING   ${summary.MISSING}    (no alt attribute — fix priority)`);
console.log(`  EMPTY     ${summary.EMPTY}    (alt="" — review if image is truly decorative)`);
console.log(`  GENERIC   ${summary.GENERIC}    (e.g., "image", "logo", single chars)`);
console.log(`  FILENAME  ${summary.FILENAME}   (looks like a filename — Wix leftover)`);
console.log('');

const filesWithIssues = Object.keys(issuesByFile).sort();
if (filesWithIssues.length === 0) {
  console.log('No issues found.');
} else {
  console.log(`FILES WITH ISSUES (${filesWithIssues.length}):`);
  console.log('-'.repeat(80));
  for (const f of filesWithIssues) {
    console.log(`\n${f}  (${issuesByFile[f].length} issue${issuesByFile[f].length > 1 ? 's' : ''})`);
    for (const i of issuesByFile[f]) {
      const altDisplay = i.alt === null ? '<no alt>' : `"${i.alt}"`;
      console.log(`  ${i.cls.padEnd(8)} src=${i.src.slice(0, 60)}`);
      console.log(`           alt=${altDisplay.slice(0, 80)}`);
    }
  }
}

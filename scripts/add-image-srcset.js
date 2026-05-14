#!/usr/bin/env node
/**
 * Add srcset/sizes to <img> tags that reference any of the compressed
 * source images, so browsers fetch the smaller @800w / @1280w variants
 * instead of the full-size original.
 *
 * Idempotent: skips tags that already have srcset, and skips already-
 * variant filenames (anything containing "@800w" or "@1280w").
 *
 * Run: node scripts/add-image-srcset.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Images that have been compressed and have @800w and @1280w variants.
// Keep in sync with scripts/compress-images.js DEFAULT_TARGETS.
const TARGETS = [
  'pipe-break-repair.jpg',
  'sprinkler-system-running.jpg',
  'fall-sprinkler-running.jpg',
  'estate-sprinkler-hero.jpg',
  'backyard-sprinkler-running.jpg',
  'leaking-valve-box.jpg',
  'commercial-drip-after.jpg',
  'commercial-valve-manifold.jpg',
  'commercial-drip-before.jpg',
  'hunter-pgp-rotor-action.jpg',
  'hydrawise-display-desktop.png',
  'estate-sprinkler-sunset.jpg',
  'installation-before-after.jpg',
  'tech-valve-box-service.jpg',
];

// Most heroes/featured photos render full-width on mobile and at varying
// widths on desktop. 100vw is the safe default — it slightly over-fetches
// on desktop cards but never under-fetches on mobile (the high-traffic case).
const SIZES = '100vw';

function srcsetFor(filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  return [
    `${base}@800w${ext} 800w`,
    `${base}@1280w${ext} 1280w`,
    `${filename} 2400w`,
  ].join(', ');
}

function updateHtml(html, filename) {
  // Find every <img ...> that has src="<filename>" without srcset on that tag.
  // Use a literal filename match (escape regex specials).
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the entire tag. Note: HTML <img> tags don't have nested >, so
  // [^>]* is safe.
  const tagRe = new RegExp(`<img\\b[^>]*\\bsrc="${escaped}(?:\\?[^"]*)?"[^>]*>`, 'g');
  let count = 0;
  const updated = html.replace(tagRe, (match) => {
    // Skip if this tag already has srcset.
    if (/\bsrcset\s*=/i.test(match)) return match;
    // Insert srcset and sizes right after the src attribute for readability.
    const srcset = srcsetFor(filename);
    const out = match.replace(
      new RegExp(`(\\bsrc="${escaped}(?:\\?[^"]*)?")`),
      `$1 srcset="${srcset}" sizes="${SIZES}"`,
    );
    if (out !== match) count += 1;
    return out;
  });
  return { updated, count };
}

const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

let totalChanges = 0;
const changedFiles = [];

for (const f of htmlFiles) {
  const fp = path.join(ROOT, f);
  let src = fs.readFileSync(fp, 'utf8');
  let fileChanges = 0;
  for (const t of TARGETS) {
    const { updated, count } = updateHtml(src, t);
    if (count > 0) {
      src = updated;
      fileChanges += count;
    }
  }
  if (fileChanges > 0) {
    fs.writeFileSync(fp, src);
    changedFiles.push({ f, fileChanges });
    totalChanges += fileChanges;
  }
}

console.log('IMG srcset injection');
console.log('====================');
console.log(`HTML files scanned: ${htmlFiles.length}`);
console.log(`Files updated: ${changedFiles.length}`);
console.log(`Total <img> tags updated: ${totalChanges}`);
console.log('');
for (const { f, fileChanges } of changedFiles) {
  console.log(`  ${f}  (+${fileChanges})`);
}

#!/usr/bin/env node
// One-shot: insert the Google Search Console verification meta tag into
// every root-level HTML file's <head>. Idempotent: skips files that
// already contain the tag. Preserves each file's existing line endings.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAG = '<meta name="google-site-verification" content="nwkYVX3vsxvqoDPYw--imtdeXQYaWrKSVRnNlRtkeDA">';
const ANCHOR = '<meta charset="UTF-8">';

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

let inserted = 0;
let skippedAlreadyPresent = 0;
let skippedNoAnchor = 0;

for (const f of files) {
  const fp = path.join(ROOT, f);
  const src = fs.readFileSync(fp, 'utf8');

  if (src.includes('google-site-verification')) {
    skippedAlreadyPresent += 1;
    continue;
  }
  if (!src.includes(ANCHOR)) {
    console.warn(`  no <meta charset="UTF-8"> anchor in ${f} — skipping`);
    skippedNoAnchor += 1;
    continue;
  }

  const useCRLF = src.indexOf('\r\n') !== -1;
  const NL = useCRLF ? '\r\n' : '\n';
  const replacement = `${ANCHOR}${NL}${TAG}`;
  const out = src.replace(ANCHOR, replacement);
  fs.writeFileSync(fp, out);
  console.log(`  ${f}`);
  inserted += 1;
}

console.log(
  `done: ${inserted} updated, ${skippedAlreadyPresent} already had tag, ${skippedNoAnchor} missing anchor`,
);

#!/usr/bin/env node
// scripts/seo-site-inventory.mjs
//
// Builds a machine-readable inventory of every served, indexable root page:
// title, meta description, H1, word count, publish date, and — the part the
// gap finder actually needs — how many OTHER pages link to it from their body
// copy (nav/footer partials stripped, see seo-lib.mjs stripPartials).
//
// Writes seo/data/site-inventory.json and prints a summary. Rebuilt on every
// gap analysis, so it is never stale; committing it is optional.
//
// Usage:
//   node scripts/seo-site-inventory.mjs            # write + summary
//   node scripts/seo-site-inventory.mjs --orphans  # pages with <2 body inbound links
//   node scripts/seo-site-inventory.mjs --page blog-hydrawise-offline.html   # one page, full detail
//   node scripts/seo-site-inventory.mjs --stdout   # JSON to stdout, no file

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryFromHtml, withInboundLinks, mdTable, TITLE_MAX, DESCRIPTION_MAX } from './seo-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'seo', 'data', 'site-inventory.json');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

// Same exclusions as generate-sitemap.mjs: not a document, noindex, legacy.
const EXCLUDE = new Set(['quote-legacy.html', '404.html']);

export function buildInventory(root = ROOT) {
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort();
  const pages = [];
  for (const f of files) {
    if (EXCLUDE.has(f)) continue;
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    if (!/<html[\s>]/i.test(html)) continue;
    pages.push(inventoryFromHtml(f, html));
  }
  // Inbound links are counted across ALL pages (a noindex page can still link
  // out), but noindex pages are flagged so the gap finder never targets them.
  return withInboundLinks(pages);
}

function main() {
  const pages = buildInventory();
  const indexable = pages.filter((p) => !p.noindex);

  if (args.includes('--stdout')) { process.stdout.write(JSON.stringify(pages, null, 2) + '\n'); return; }

  const one = flag('--page');
  if (one) {
    const p = pages.find((x) => x.file === one);
    if (!p) { console.error(`No such page: ${one}`); process.exit(1); }
    process.stdout.write(JSON.stringify(p, null, 2) + '\n');
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2) + '\n');

  const byType = {};
  for (const p of indexable) byType[p.type] = (byType[p.type] || 0) + 1;
  console.log(`# Site inventory — ${indexable.length} indexable pages (${pages.length - indexable.length} noindex)\n`);
  console.log(Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(' · ') + '\n');

  if (args.includes('--orphans')) {
    const orphans = indexable.filter((p) => p.inboundBodyLinks < 2 && p.type !== 'legal')
      .sort((a, b) => a.inboundBodyLinks - b.inboundBodyLinks || a.file.localeCompare(b.file));
    console.log(`## Pages with fewer than 2 body inbound links (${orphans.length})\n`);
    console.log(mdTable(['Page', 'Type', 'Inbound (body)', 'Words', 'Title'],
      orphans.map((p) => [p.file, p.type, p.inboundBodyLinks, p.wordCount, p.title])));
    console.log();
  }

  const issues = [];
  for (const p of indexable) {
    if (p.h1Count !== 1) issues.push([p.file, `h1 count = ${p.h1Count}`]);
    if (p.titleCoreLength > TITLE_MAX) issues.push([p.file, `title ${p.titleCoreLength} chars before the brand suffix (max ${TITLE_MAX})`]);
    if (p.descriptionLength > DESCRIPTION_MAX) issues.push([p.file, `description ${p.descriptionLength} chars (max ${DESCRIPTION_MAX})`]);
    if (!p.description) issues.push([p.file, 'no meta description']);
  }
  console.log(`## On-page flags (${issues.length})\n`);
  console.log(issues.length ? mdTable(['Page', 'Flag'], issues) : '_none_');
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

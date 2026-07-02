#!/usr/bin/env node
// scripts/generate-sitemap.mjs
//
// Regenerates sitemap.xml from the set of served, indexable root *.html pages
// so the sitemap can never drift out of sync with the content again.
//
// What it does:
//   1. Scans the repo root for *.html files (non-recursive — same surface the
//      static host serves; server/* internal pages are never listed).
//   2. Excludes: non-document files (no <html> tag, e.g. the Twilio domain-
//      verification token), pages carrying <meta name="robots" ... noindex ...>
//      (auto-detected — this is why irrigation-zone-schedule.html, review.html,
//      new-customer.html and 404.html stay out without a hardcoded list), and
//      the explicit EXCLUDE_FILES list (quote-legacy.html).
//   3. Emits <loc> (index.html -> "/"), a truthful <lastmod> from each file's
//      last git commit date (NOT filesystem mtime, which is meaningless on CI
//      checkouts), and carries over the hand-tuned <changefreq>, <priority>,
//      and <image:image> entries from the existing sitemap. Pages with no prior
//      entry (brand-new pages) get sensible defaults and are reported so they
//      can be curated.
//   4. Sorts deterministically (homepage "/" first, then alphabetical by URL)
//      so repeated runs produce a byte-identical file — required for an
//      idempotent build.
//
// Wired into `npm run build` ahead of the IndexNow ping so search engines
// always receive the fresh file.
//
// Modes:
//   node scripts/generate-sitemap.mjs          # regenerate sitemap.xml
//   node scripts/generate-sitemap.mjs --check   # exit 1 if the file is stale
//                                                # (does not write) — idempotency gate

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');
const DOMAIN = 'https://www.pjllandservices.com';
const CHECK = process.argv.includes('--check');

// Pages that are served (HTTP 200) but must NOT appear in the sitemap and are
// NOT marked noindex. Keep this minimal — noindex detection handles the rest.
const EXCLUDE_FILES = new Set([
  'quote-legacy.html', // robots-disallowed legacy quote builder (intentional)
]);

// Defaults for pages that have no entry in the current sitemap (new pages).
const DEFAULT_CHANGEFREQ = 'monthly';
const DEFAULT_PRIORITY = '0.7';

// ---------------------------------------------------------------------------
// Parse the existing sitemap for hand-tuned metadata (changefreq / priority /
// image entries) keyed by <loc>. The URL list, lastmod, and ordering are
// authoritative from this script; these three fields are curated and carried
// forward so manual SEO tuning survives regeneration.
// ---------------------------------------------------------------------------
function parseExistingMeta() {
  const meta = new Map();
  if (!fs.existsSync(SITEMAP_PATH)) return meta;
  const xml = fs.readFileSync(SITEMAP_PATH, 'utf8');
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (const block of blocks) {
    const loc = (block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1];
    if (!loc) continue;
    const changefreq = (block.match(/<changefreq>\s*([^<]+?)\s*<\/changefreq>/) || [])[1];
    const priority = (block.match(/<priority>\s*([^<]+?)\s*<\/priority>/) || [])[1];
    const lastmod = (block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1];
    const images = [];
    const imgRe = /<image:image>\s*<image:loc>\s*([^<\s]+)\s*<\/image:loc>\s*(?:<image:title>([\s\S]*?)<\/image:title>\s*)?<\/image:image>/g;
    let m;
    while ((m = imgRe.exec(block)) !== null) {
      images.push({ loc: m[1], title: m[2] != null ? m[2].trim() : null });
    }
    meta.set(loc, { changefreq, priority, lastmod, images });
  }
  return meta;
}

// A file is a served, indexable page unless it is a non-document, noindexed,
// or explicitly excluded.
function isIndexablePage(filename, html) {
  if (EXCLUDE_FILES.has(filename)) return false;
  if (!/<html[\s>]/i.test(html)) return false; // e.g. domain-verification token
  // Any <meta name="robots" ...> whose content includes "noindex".
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (/name\s*=\s*["']robots["']/i.test(tag) && /content\s*=\s*["'][^"']*noindex/i.test(tag)) {
      return false;
    }
  }
  return true;
}

function locForFile(filename) {
  return filename === 'index.html' ? `${DOMAIN}/` : `${DOMAIN}/${filename}`;
}

function gitLastmod(filename) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', filename], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (out) return out.slice(0, 10); // YYYY-MM-DD
  } catch {
    /* git unavailable or file untracked — fall through */
  }
  return null;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSitemap() {
  const existing = parseExistingMeta();
  const files = fs
    .readdirSync(ROOT)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .sort();

  const entries = [];
  const newPages = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const filename of files) {
    const html = fs.readFileSync(path.join(ROOT, filename), 'utf8');
    if (!isIndexablePage(filename, html)) continue;

    const loc = locForFile(filename);
    const prev = existing.get(loc);
    // lastmod: git commit date, then any prior sitemap value, then today.
    const lastmod = gitLastmod(filename) || (prev && prev.lastmod) || today;
    const changefreq = (prev && prev.changefreq) || DEFAULT_CHANGEFREQ;
    const priority = (prev && prev.priority) || DEFAULT_PRIORITY;
    const images = (prev && prev.images) || [];
    if (!prev) newPages.push(filename);

    entries.push({ loc, lastmod, changefreq, priority, images, filename });
  }

  // Deterministic order: homepage "/" first, then alphabetical by loc.
  entries.sort((a, b) => {
    if (a.filename === 'index.html') return -1;
    if (b.filename === 'index.html') return 1;
    return a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0;
  });

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!--');
  lines.push('  AUTO-GENERATED by scripts/generate-sitemap.mjs — do not hand-edit the URL list.');
  lines.push('  Regenerated on every `npm run build`. To add a page, just create the .html file');
  lines.push('  (pages with <meta name="robots" ... noindex> are excluded automatically).');
  lines.push('  <changefreq>/<priority>/<image:image> are carried over from the previous file,');
  lines.push('  so you may hand-tune those per page and they survive regeneration.');
  lines.push('-->');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  lines.push('        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">');
  lines.push('');
  for (const e of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${e.loc}</loc>`);
    lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
    lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    lines.push(`    <priority>${e.priority}</priority>`);
    for (const img of e.images) {
      lines.push('    <image:image>');
      lines.push(`      <image:loc>${img.loc}</image:loc>`);
      if (img.title != null) lines.push(`      <image:title>${img.title}</image:title>`);
      lines.push('    </image:image>');
    }
    lines.push('  </url>');
  }
  lines.push('');
  lines.push('</urlset>');

  // Preserve the existing file's line-ending convention to avoid autocrlf churn.
  const useCRLF = fs.existsSync(SITEMAP_PATH) && fs.readFileSync(SITEMAP_PATH, 'utf8').includes('\r\n');
  const NL = useCRLF ? '\r\n' : '\n';
  return { xml: lines.join(NL) + NL, count: entries.length, newPages };
}

function main() {
  const { xml, count, newPages } = buildSitemap();
  const current = fs.existsSync(SITEMAP_PATH) ? fs.readFileSync(SITEMAP_PATH, 'utf8') : null;

  if (CHECK) {
    if (xml !== current) {
      console.error('generate-sitemap: FAIL — sitemap.xml is stale. Run `node scripts/generate-sitemap.mjs`.');
      process.exit(1);
    }
    console.log(`generate-sitemap: check OK — ${count} URLs, sitemap.xml up to date.`);
    return;
  }

  if (xml === current) {
    console.log(`generate-sitemap: ${count} URLs, no change.`);
  } else {
    fs.writeFileSync(SITEMAP_PATH, xml);
    console.log(`generate-sitemap: wrote ${count} URLs to sitemap.xml.`);
  }
  if (newPages.length) {
    console.log(`  note: ${newPages.length} page(s) had no prior sitemap entry — using defaults ` +
      `(changefreq=${DEFAULT_CHANGEFREQ}, priority=${DEFAULT_PRIORITY}):`);
    newPages.forEach((f) => console.log(`    ${f}`));
  }
}

main();

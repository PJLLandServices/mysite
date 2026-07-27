#!/usr/bin/env node
// scripts/generate-sitemap.mjs
//
// Regenerates BOTH sitemaps from the set of served, indexable root *.html
// pages so neither can drift out of sync with the content again:
//
//   sitemap.xml   — the crawler sitemap (full file is generated)
//   sitemap.html  — the human sitemap (only the page-list grid is generated;
//                   the rest of the page is hand-authored and left alone)
//
// Both are driven off one walk of the same page set, so publishing a post can
// never again land it in one sitemap but not the other.
//
// What it does:
//   1. Scans the repo root for *.html files (non-recursive — same surface the
//      static host serves; server/* internal pages are never listed).
//   2. Excludes: non-document files (no <html> tag, e.g. the Twilio domain-
//      verification token), pages carrying <meta name="robots" ... noindex ...>
//      (auto-detected — this is why irrigation-zone-schedule.html, review.html,
//      new-customer.html and 404.html stay out without a hardcoded list), and
//      the explicit EXCLUDE_FILES list (quote-legacy.html).
//   3. sitemap.xml: emits <loc> (index.html -> "/"), a truthful <lastmod> from
//      each file's last git commit date (NOT filesystem mtime, which is
//      meaningless on CI checkouts), and carries over the hand-tuned
//      <changefreq>, <priority>, and <image:image> entries from the existing
//      sitemap. Pages with no prior entry (brand-new pages) get sensible
//      defaults and are reported so they can be curated.
//   4. sitemap.html: rebuilds the <div class="sitemap-grid"> between the
//      @@PJL:sitemap-grid markers — sections, per-section counts, and one <li>
//      per page. Link labels and descriptions are CURATED CONTENT and are
//      carried over from the existing file keyed by href (same contract as
//      changefreq/priority in the XML: hand-tune them in place and they
//      survive regeneration). A page with no prior entry gets a label/desc
//      derived from its <title>/<meta description> and is reported so a human
//      can write something better.
//   5. Sorts deterministically so repeated runs produce byte-identical files —
//      required for an idempotent build.
//
// Wired into `npm run build` ahead of the IndexNow ping so search engines
// always receive the fresh file. It runs AFTER sync-prices-html.mjs, so the
// <span data-price> markup inside sitemap.html descriptions is already synced
// by the time it is carried forward here.
//
// Modes:
//   node scripts/generate-sitemap.mjs          # regenerate both sitemaps
//   node scripts/generate-sitemap.mjs --check   # exit 1 if either is stale
//                                                # (does not write) — idempotency gate

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');
const SITEMAP_HTML_PATH = path.join(ROOT, 'sitemap.html');
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
// sitemap.html (human sitemap) configuration
// ---------------------------------------------------------------------------

// The generated region of sitemap.html. Everything outside these markers —
// <head>, hero, the nav/footer partial markers, the closing note — is
// hand-authored and never touched.
const GRID_START = '<!-- @@PJL:sitemap-grid-START -->';
const GRID_END = '<!-- @@PJL:sitemap-grid-END -->';

// Indexable pages deliberately left off the human sitemap.
const HTML_EXCLUDE_FILES = new Set([
  'sitemap.html', // the page itself — a self-link is noise
]);

// Section layout. A page is claimed by the first section listing it in `files`
// (which also fixes its display order); otherwise by the first section whose
// `match` accepts it. Pattern-matched pages keep the order they already have
// in sitemap.html, with genuinely new ones appended alphabetically — so the
// curated ordering of the Blog and Service Areas lists survives regeneration.
//
// Adding a root page in an existing family (blog-*, sprinkler-service-*) needs
// no change here. Any other new page lands in "Other Pages" with a warning —
// visible rather than silently dropped, which is the drift this generator
// exists to prevent. Add it to the right list below to clear the warning.
const SECTIONS = [
  {
    title: 'Main Pages',
    files: ['index.html', 'about.html', 'process.html', 'reviews.html', 'faq.html', 'contact.html'],
  },
  {
    title: 'Services',
    files: [
      'sprinkler-systems.html',
      'sprinkler-installation.html',
      'sprinkler-hydrawise.html',
      'drip-irrigation.html',
      'commercial-irrigation.html',
      'sprinkler-spring-opening.html',
      'sprinkler-fall-winterization.html',
      'sprinkler-repair.html',
      'diagnose.html',
      'pricing.html',
      'coverage-map.html',
      'landscape-lighting.html',
    ],
  },
  {
    title: 'Book / Quote / Estimate',
    files: ['book.html', 'quote.html', 'estimate.html', 'water-cost-calculator.html'],
  },
  {
    title: 'Service Areas',
    match: (f) => f.startsWith('sprinkler-service-'),
  },
  {
    title: 'Blog',
    files: ['blog.html'],
    match: (f) => f.startsWith('blog-'),
  },
  {
    title: 'Legal &amp; Compliance',
    files: [
      'warranty.html',
      'privacy-policy.html',
      'terms-of-service.html',
      'accessibility-statement.html',
    ],
  },
];

// Bucket for indexable pages no section claims. Never silently dropped.
const FALLBACK_SECTION_TITLE = 'Other Pages';

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

// The single walk both sitemaps are built from: every served, indexable root
// page, alphabetical, as { filename, html }.
function collectIndexablePages() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .sort()
    .map((filename) => ({ filename, html: fs.readFileSync(path.join(ROOT, filename), 'utf8') }))
    .filter(({ filename, html }) => isIndexablePage(filename, html));
}

function buildSitemap(pages) {
  const existing = parseExistingMeta();

  const entries = [];
  const newPages = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const { filename } of pages) {
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

// ---------------------------------------------------------------------------
// sitemap.html — rebuild the page-list grid from the same page set.
// ---------------------------------------------------------------------------

// Harvest the curated link label + description for every page already listed,
// keyed by href. This is the hand-tuned content the generator carries forward.
function parseExistingGrid(gridHtml) {
  const curated = new Map();
  const liRe =
    /<li><a href="([^"]+)">([\s\S]*?)<\/a>(?:<span class="desc">([\s\S]*?)<\/span>)?<\/li>/g;
  let m;
  while ((m = liRe.exec(gridHtml)) !== null) {
    curated.set(m[1], { label: m[2], desc: m[3] != null ? m[3] : '' });
  }
  return curated;
}

// The order pages currently appear in, so curated ordering survives.
function existingOrder(gridHtml) {
  return [...parseExistingGrid(gridHtml).keys()];
}

// Fallback label for a page nobody has curated yet: the distinctive part of
// its <title>, before the " | PJL Land Services …" boilerplate.
function deriveLabel(html, filename) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  if (!title) return filename.replace(/\.html$/, '');
  let label = title.split('|')[0].trim();
  if (label.length > 60) label = label.split('—')[0].trim();
  return htmlText(label) || filename.replace(/\.html$/, '');
}

// Derived text comes from a <title> or a meta attribute, so a bare "&" in it
// is legal there but not in the page body. Escape it without double-escaping
// entities the source already carries.
function htmlText(s) {
  return s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fallback description: the first sentence of the page's meta description.
function deriveDesc(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/name\s*=\s*["']description["']/i.test(tag)) continue;
    // Backreference the opening quote — a plain [^"']* stops at the first
    // apostrophe and truncates any description containing one ("won't" …).
    const content = (tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i) || [])[2];
    if (!content) return '';
    const firstSentence = (content.match(/^[\s\S]*?[.!?](?=\s|$)/) || [content])[0].trim();
    return htmlText(
      firstSentence.length <= 160 ? firstSentence : content.slice(0, 157).trim() + '…'
    );
  }
  return '';
}

function assignSection(filename) {
  for (const section of SECTIONS) {
    if (section.files && section.files.includes(filename)) return section.title;
  }
  for (const section of SECTIONS) {
    if (section.match && section.match(filename)) return section.title;
  }
  return FALLBACK_SECTION_TITLE;
}

function buildSitemapHtml(pages) {
  const current = fs.readFileSync(SITEMAP_HTML_PATH, 'utf8');
  const startAt = current.indexOf(GRID_START);
  const endAt = current.indexOf(GRID_END);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    console.error(
      `generate-sitemap: FAIL — sitemap.html is missing the ${GRID_START} / ${GRID_END} ` +
      'markers that delimit the generated page grid. Restore them and re-run.'
    );
    process.exit(1);
  }
  const gridHtml = current.slice(startAt + GRID_START.length, endAt);
  const curated = parseExistingGrid(gridHtml);
  const order = existingOrder(gridHtml);

  const listed = pages.filter(({ filename }) => !HTML_EXCLUDE_FILES.has(filename));

  // Group into sections, honouring each section's explicit `files` order, then
  // the order pattern-matched pages already had, then new pages alphabetically
  // (`listed` is alphabetical, so a stable sort by rank gives exactly that).
  const bySection = new Map();
  for (const { filename, html } of listed) {
    const title = assignSection(filename);
    if (!bySection.has(title)) bySection.set(title, []);
    bySection.get(title).push({ filename, html });
  }
  const newEntries = [];
  const uncategorised = [];
  for (const [title, items] of bySection) {
    const section = SECTIONS.find((s) => s.title === title);
    const explicit = (section && section.files) || [];
    const rank = (filename) => {
      const i = explicit.indexOf(filename);
      if (i !== -1) return i; // curated position within the section
      const j = order.indexOf(filename);
      return explicit.length + (j === -1 ? order.length : j); // existing order, then new
    };
    items.sort((a, b) => rank(a.filename) - rank(b.filename));
    for (const item of items) {
      if (!curated.has(item.filename)) newEntries.push(item.filename);
      if (title === FALLBACK_SECTION_TITLE) uncategorised.push(item.filename);
    }
  }

  const lines = [];
  const sectionTitles = [...SECTIONS.map((s) => s.title), FALLBACK_SECTION_TITLE];
  for (const title of sectionTitles) {
    const items = bySection.get(title);
    if (!items || !items.length) continue;
    lines.push('');
    lines.push('      <div class="sitemap-section">');
    lines.push(`        <h2>${title}</h2>`);
    lines.push(
      `        <span class="sitemap-section__count">${items.length} ` +
      `${items.length === 1 ? 'page' : 'pages'}</span>`
    );
    lines.push('        <ul>');
    for (const { filename, html } of items) {
      const entry = curated.get(filename) || {
        label: deriveLabel(html, filename),
        desc: deriveDesc(html),
      };
      const desc = entry.desc ? `<span class="desc">${entry.desc}</span>` : '';
      lines.push(`          <li><a href="${filename}">${entry.label}</a>${desc}</li>`);
    }
    lines.push('        </ul>');
    lines.push('      </div>');
  }
  lines.push('');
  lines.push('      ');

  const useCRLF = current.includes('\r\n');
  const NL = useCRLF ? '\r\n' : '\n';
  const grid = lines.join(NL);
  const html = current.slice(0, startAt + GRID_START.length) + grid + current.slice(endAt);
  return { html, current, count: listed.length, newEntries, uncategorised };
}

// Warnings that apply to both modes: pages nobody has curated, and pages no
// section claims. Printed after the OK/FAIL line so they are not buried.
function reportHtmlNotes(page) {
  if (page.uncategorised.length) {
    console.log(
      `  warning: ${page.uncategorised.length} page(s) matched no section and landed in ` +
      `"${FALLBACK_SECTION_TITLE}" on sitemap.html — add them to a SECTIONS list in ` +
      'scripts/generate-sitemap.mjs:'
    );
    page.uncategorised.forEach((f) => console.log(`    ${f}`));
  }
  const uncurated = page.newEntries.filter((f) => !page.uncategorised.includes(f));
  if (uncurated.length) {
    console.log(
      `  note: ${uncurated.length} page(s) had no prior sitemap.html entry — label and ` +
      'description derived from the page; edit them in sitemap.html to curate:'
    );
    uncurated.forEach((f) => console.log(`    ${f}`));
  }
}

function main() {
  const pages = collectIndexablePages();
  const { xml, count, newPages } = buildSitemap(pages);
  const current = fs.existsSync(SITEMAP_PATH) ? fs.readFileSync(SITEMAP_PATH, 'utf8') : null;
  const page = buildSitemapHtml(pages);

  if (CHECK) {
    let stale = false;

    // A page's <lastmod> is derived from its last git-commit date, so the very
    // commit that edits a page can never also ship a sitemap.xml carrying that
    // same commit's date — the date does not exist until the commit is made.
    // That made this gate fail on essentially every content commit and forced a
    // throwaway "refresh sitemap" follow-up commit to turn CI green. In --check
    // we therefore ignore lastmod-only drift (purely cosmetic; regenerated on
    // the next `npm run build`) and fail ONLY on structural drift: a changed URL
    // set or changed <changefreq>/<priority>/<image:image> SEO metadata.
    const stripLastmod = (s) =>
      s == null ? s : s.replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod/>');
    if (xml === current) {
      console.log(`generate-sitemap: check OK — ${count} URLs, sitemap.xml up to date.`);
    } else if (stripLastmod(xml) === stripLastmod(current)) {
      console.log(
        `generate-sitemap: check OK — ${count} URLs (lastmod timestamps differ; ` +
        `refreshed automatically on the next build).`
      );
    } else {
      console.error(
        'generate-sitemap: FAIL — sitemap.xml is structurally stale (URL set or SEO ' +
        'metadata changed). Run `node scripts/generate-sitemap.mjs`.'
      );
      stale = true;
    }

    // sitemap.html has no lastmod equivalent — any drift is structural.
    if (page.html === page.current) {
      console.log(`generate-sitemap: check OK — ${page.count} links, sitemap.html up to date.`);
    } else {
      console.error(
        'generate-sitemap: FAIL — the sitemap.html page grid is stale (page set or section ' +
        'layout changed). Run `node scripts/generate-sitemap.mjs`.'
      );
      stale = true;
    }

    reportHtmlNotes(page);
    if (stale) process.exit(1);
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

  if (page.html === page.current) {
    console.log(`generate-sitemap: ${page.count} links, sitemap.html no change.`);
  } else {
    fs.writeFileSync(SITEMAP_HTML_PATH, page.html);
    console.log(`generate-sitemap: wrote ${page.count} links to sitemap.html.`);
  }
  reportHtmlNotes(page);
}

main();

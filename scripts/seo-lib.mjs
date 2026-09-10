// scripts/seo-lib.mjs
//
// Pure helpers shared by the SEO agent scripts (seo-gsc-pull, seo-site-inventory,
// seo-gap-analysis). No I/O in here — everything takes data in and returns data
// out so scripts/test-seo-tools.mjs can pin the behaviour without credentials.
//
// The playbook this implements lives in seo/README.md. Terms:
//   gap zone   — queries where the site sits at average position 5–20. One good
//                page or one targeted update is what moves these to page 1.
//   movement   — position change vs the previous snapshot, 3+ places either way.
//   body links — internal links counted AFTER stripping the nav/footer partials,
//                because every page links to every service page through the nav
//                and that would make "zero inbound links" impossible to detect.

// ----------------------------------------------------------------- .env parse
// Mirrors the inline loader in server/server.js so the two never disagree.
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// ------------------------------------------------------------ GSC row shaping
// A GSC searchAnalytics row with dimensions ['query','page'] comes back as
// { keys:[query,page], clicks, impressions, ctr, position }. Flatten it.
export function flattenGscRow(row) {
  const [query = '', page = ''] = row.keys || [];
  return {
    query,
    page,
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0),
  };
}

// Collapse query+page rows to one row per query. Position is weighted by
// impressions — an unweighted mean would let a page seen twice at position 3
// drag a query that is really sitting at 15 into the wrong bucket.
export function aggregateByQuery(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    const q = r.query;
    let acc = byQuery.get(q);
    if (!acc) {
      acc = { query: q, clicks: 0, impressions: 0, positionWeight: 0, pages: new Map() };
      byQuery.set(q, acc);
    }
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    acc.positionWeight += r.position * r.impressions;
    if (r.page) acc.pages.set(r.page, (acc.pages.get(r.page) || 0) + r.impressions);
  }
  const out = [];
  for (const acc of byQuery.values()) {
    const impressions = acc.impressions;
    const position = impressions ? acc.positionWeight / impressions : 0;
    // The landing page is the one that collected the most impressions.
    const pages = [...acc.pages.entries()].sort((a, b) => b[1] - a[1]);
    out.push({
      query: acc.query,
      clicks: acc.clicks,
      impressions,
      ctr: impressions ? acc.clicks / impressions : 0,
      position: round2(position),
      page: pages[0] ? pages[0][0] : '',
      pageCount: pages.length,
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
}

export function round2(n) { return Math.round(n * 100) / 100; }

// ------------------------------------------------------------------ gap zone
export function gapZone(queryRows, { minPosition = 5, maxPosition = 20, minImpressions = 1, limit = Infinity } = {}) {
  return queryRows
    .filter((r) => r.position >= minPosition && r.position <= maxPosition && r.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position || a.query.localeCompare(b.query))
    .slice(0, limit);
}

// ------------------------------------------------------------------ movement
// Positive delta = climbed (position number went DOWN). We report the sign the
// way a person reads it: "+4" means four places closer to #1.
export function movement(currentRows, previousRows, { threshold = 3, minImpressions = 1 } = {}) {
  const prev = new Map(previousRows.map((r) => [r.query, r]));
  const out = [];
  for (const cur of currentRows) {
    const p = prev.get(cur.query);
    if (!p) continue;
    if (cur.impressions < minImpressions && p.impressions < minImpressions) continue;
    const delta = round2(p.position - cur.position);
    if (Math.abs(delta) >= threshold) {
      out.push({ query: cur.query, from: p.position, to: cur.position, delta, impressions: cur.impressions, page: cur.page });
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ------------------------------------------------------------- query clusters
// Town names the site targets. Stripping them lets "sprinkler winterization
// aurora" and "sprinkler winterization vaughan" cluster as one topic, which is
// how a "ranked for X variations with no hub page" opportunity surfaces.
export const TOWNS = [
  'acton', 'aurora', 'bolton', 'east gwillimbury', 'erin', 'forest hill', 'innisfil', 'king city',
  'lawrence park', 'markham', 'newmarket', 'north york', 'orangeville', 'richmond hill', 'stouffville',
  'thornhill', 'toronto', 'vaughan', 'bradford', 'barrie', 'keswick', 'georgina', 'holland marsh',
  'etobicoke', 'mississauga', 'oakville', 'pickering', 'whitby', 'ajax', 'oshawa', 'bowmanville',
  'port perry', 'uxbridge', 'brampton', 'caledon', 'halton hills', 'mono', 'york region', 'gta',
  'ontario', 'simcoe', 'durham', 'peel',
];
const STOP = new Set(['a', 'an', 'the', 'in', 'near', 'me', 'my', 'for', 'of', 'to', 'and', 'or', 'on', 'at', 'is', 'how', 'do', 'i', 'it', 'with', 'your', 'you', 'what', 'when', 'why', 'best', 'company', 'companies', 'service', 'services', 'cost', 'price', 'prices']);

export function topicKey(query) {
  let q = String(query).toLowerCase();
  for (const t of TOWNS) q = q.replace(new RegExp(`\\b${t}\\b`, 'g'), ' ');
  const words = q.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))
    .map((w) => w.replace(/(ization|izing|ize|ation|ers|er|ing|s)$/, ''));
  return [...new Set(words)].sort().join(' ');
}

export function clusters(queryRows, { minSize = 3 } = {}) {
  const groups = new Map();
  for (const r of queryRows) {
    const k = topicKey(r.query);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [key, rows] of groups) {
    if (rows.length < minSize) continue;
    const pages = new Set(rows.map((r) => r.page).filter(Boolean));
    out.push({
      key,
      queries: rows.map((r) => r.query),
      impressions: rows.reduce((s, r) => s + r.impressions, 0),
      pages: [...pages],
      landingPageSpread: pages.size,
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

// ------------------------------------------------------------- HTML inventory
export const PARTIAL_MARKERS = ['nav', 'footer', 'analytics'];

// Remove the build-injected partial blocks so link counts reflect what an
// author wrote into the page body, not what every page carries.
export function stripPartials(html) {
  let out = String(html);
  for (const name of PARTIAL_MARKERS) {
    const re = new RegExp(`<!--\\s*@@PJL:${name}-START[\\s\\S]*?@@PJL:${name}-END\\s*-->`, 'g');
    out = out.replace(re, '');
  }
  return out;
}

export function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Brand affixes the site uses in <title>. Length limits apply to what is left
// once these are removed — the same rule scripts/sync-seasonal-meta.mjs
// enforces on the town pages (≤ 60 chars before the brand suffix).
const BRAND_AFFIXES = [
  /\s*[|—–-]\s*PJL Land Services(?:\s+Newmarket\s*&\s*GTA)?\s*$/i,
  /\s*[|—–-]\s*PJL(?:\s+Land)?\s*$/i,
  /^\s*PJL Land Services\s*[|—–-]\s*/i,
];
export function titleCore(title) {
  let t = String(title || '').trim();
  for (const re of BRAND_AFFIXES) t = t.replace(re, '');
  return t.trim();
}

// On-page limits. Titles: ≤ 60 before the brand affix. Descriptions: ≤ 160
// (Google's snippet cut-off; the town pages are additionally held to ≥ 140
// by sync-seasonal-meta, which owns them).
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 160;

export function classifyPage(file) {
  if (/^blog-/.test(file)) return 'blog';
  if (/^sprinkler-service-/.test(file)) return 'area';
  if (/^(sprinkler-|drip-irrigation|landscape-lighting|commercial-irrigation|water-promise|warranty\.html)/.test(file)) return 'service';
  if (/^(privacy-policy|terms-of-service|accessibility-statement)/.test(file)) return 'legal';
  return 'core';
}

// One page → one inventory record. `file` is the bare filename (about.html).
export function inventoryFromHtml(file, html, { domain = 'https://www.pjllandservices.com' } = {}) {
  // Commented-out markup is not on the page. Parse with comments removed so a
  // retired hero left in a comment cannot register as a second <h1>.
  const src = String(html).replace(/<!--(?!\s*@@PJL:)[\s\S]*?-->/g, '');
  const body = stripPartials(src);
  const pick = (re) => { const m = src.match(re); return m ? stripTags(m[1]).trim() : ''; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = (() => {
    const m = src.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i)
      || src.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?>/i);
    return m ? stripTags(m[1]) : '';
  })();
  const h1 = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Count = (src.match(/<h1[\s>]/gi) || []).length;
  const noindex = /<meta\s+name=["']robots["'][^>]*noindex/i.test(src);
  const canonical = (src.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i) || [])[1] || '';
  const datePublished = (src.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const dateModified = (src.match(/"dateModified"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const h2s = [...src.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const text = stripTags(body.replace(/<head[\s\S]*?<\/head>/i, ''));
  const wordCount = text ? text.split(' ').length : 0;

  // Internal links written into the body (partials stripped). Relative
  // same-site hrefs only; anchors, mailto/tel, and external hosts are dropped.
  const links = new Set();
  for (const m of body.matchAll(/<a\s[^>]*href=["']([^"'#?]+)(?:[#?][^"']*)?["']/gi)) {
    let href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      if (!href.startsWith(domain)) continue;
      href = href.slice(domain.length);
    }
    href = href.replace(/^\.?\//, '');
    if (href === '' || href === 'index.html') href = 'index.html';
    if (!/\.html$/i.test(href)) continue;
    if (href === file) continue;
    links.add(href);
  }

  const url = file === 'index.html' ? `${domain}/` : `${domain}/${file}`;
  return {
    file, url, type: classifyPage(file), title, titleLength: title.length, titleCoreLength: titleCore(title).length,
    description, descriptionLength: description.length, h1, h1Count, h2s,
    wordCount, noindex, canonical, datePublished, dateModified,
    links: [...links].sort(),
  };
}

// Given inventory records, attach inbound BODY link counts and sources.
export function withInboundLinks(pages) {
  const inbound = new Map(pages.map((p) => [p.file, []]));
  for (const p of pages) {
    for (const target of p.links) {
      if (inbound.has(target)) inbound.get(target).push(p.file);
    }
  }
  return pages.map((p) => ({ ...p, inboundBodyLinks: inbound.get(p.file).length, inboundFrom: inbound.get(p.file).sort() }));
}

// Map a GSC page URL back to an inventory record (or null).
export function findPage(pages, url) {
  if (!url) return null;
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/^\//, '');
  const file = path === '' ? 'index.html' : path;
  return pages.find((p) => p.file === file) || null;
}

// --------------------------------------------------------------------- dates
export function ymd(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function daysAgo(n, from = new Date()) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() - n);
  return d;
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// ------------------------------------------------------------------- markdown
export function mdTable(headers, rows) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`| ${headers.map(esc).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(esc).join(' | ')} |`);
  return lines.join('\n');
}

export function pct(n) { return `${(Number(n || 0) * 100).toFixed(1)}%`; }

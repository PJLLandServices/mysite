#!/usr/bin/env node
// scripts/seo-gap-analysis.mjs
//
// The deterministic half of the weekly gap analysis. Takes the newest Search
// Console snapshot (seo/data/gsc-*.json), the one before it, and the live site
// inventory, and prints the evidence the seo-gap-finder skill reasons over:
//
//   • gap zone — queries at position 5–20, by impressions, each joined to its
//     landing page (title, body word count, inbound body links) so the
//     "which fix applies" diagnosis is grounded in the actual page
//   • movement — 3+ position changes vs the previous snapshot
//   • clusters — query families (town names stripped) landing on several pages
//     or none, i.e. hub-page candidates
//   • no-page — gap-zone queries whose landing page is not a page we author
//     (the homepage catching a service query, or nothing at all)
//
// It does NOT write the recommendations. Those need judgement about the page
// and the SERP; that is the skill's job. The skill saves the finished report
// to seo/reports/gap-analysis-YYYY-MM-DD.md.
//
// Usage:
//   node scripts/seo-gap-analysis.mjs                # markdown to stdout
//   node scripts/seo-gap-analysis.mjs --top 25       # more gap-zone rows
//   node scripts/seo-gap-analysis.mjs --json         # machine output
//   node scripts/seo-gap-analysis.mjs --snapshot seo/data/gsc-2026-09-14.json --previous seo/data/gsc-2026-09-07.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gapZone, movement, clusters, findPage, mdTable, pct } from './seo-lib.mjs';
import { buildInventory } from './seo-site-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'seo', 'data');
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
const TOP = Number(flag('--top', 15));
const JSON_OUT = args.includes('--json');

function listSnapshots() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter((f) => /^gsc-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .map((f) => path.join(DATA_DIR, f));
}

function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

export function analyse({ current, previous, pages, top = TOP }) {
  const zone = gapZone(current.queries, { limit: top });
  const joined = zone.map((q) => {
    const page = findPage(pages, q.page);
    return {
      ...q,
      landing: page ? page.file : (q.page ? '(not an authored page)' : '(none)'),
      landingType: page ? page.type : '',
      landingTitle: page ? page.title : '',
      landingWords: page ? page.wordCount : '',
      inboundBodyLinks: page ? page.inboundBodyLinks : '',
      noPage: !page || page.file === 'index.html',
    };
  });
  const moved = previous ? movement(current.queries, previous.queries) : [];
  const fams = clusters(gapZone(current.queries, { limit: Infinity }))
    .filter((c) => c.landingPageSpread !== 1)
    .slice(0, 8);
  return { zone: joined, moved, clusters: fams };
}

function main() {
  const snaps = listSnapshots();
  const curPath = flag('--snapshot', snaps[snaps.length - 1]);
  if (!curPath) {
    console.error('No Search Console snapshot found in seo/data/. Run `npm run seo:gsc` first (setup: seo/README.md).');
    process.exit(2);
  }
  const prevPath = flag('--previous', snaps.length > 1 && !flag('--snapshot', null) ? snaps[snaps.length - 2] : null);
  const current = load(curPath);
  const previous = prevPath ? load(prevPath) : null;
  const pages = buildInventory();
  const r = analyse({ current, previous, pages });

  if (JSON_OUT) { process.stdout.write(JSON.stringify({ snapshot: curPath, previous: prevPath, ...r }, null, 2) + '\n'); return; }

  const w = current.window;
  console.log(`# Gap analysis evidence — ${current.site}`);
  console.log(`Snapshot: ${path.relative(ROOT, curPath)} (${w.startDate} → ${w.endDate}, ${w.days} days)` +
    (prevPath ? `\nBaseline: ${path.relative(ROOT, prevPath)}` : '\nBaseline: none yet — movement report starts next week'));
  console.log(`Totals: ${current.totals.queries} queries · ${current.totals.clicks} clicks · ${current.totals.impressions} impressions\n`);

  const allZone = gapZone(current.queries, { limit: Infinity });
  console.log(`## Gap zone (position 5–20) — ${allZone.length} queries, top ${r.zone.length} by impressions\n`);
  console.log(mdTable(
    ['#', 'Query', 'Impr', 'Clicks', 'CTR', 'Pos', 'Landing page', 'Type', 'Words', 'Inbound body links'],
    r.zone.map((q, i) => [i + 1, q.query, q.impressions, q.clicks, pct(q.ctr), q.position, q.landing, q.landingType, q.landingWords, q.inboundBodyLinks]),
  ));

  const noPage = r.zone.filter((q) => q.noPage);
  if (noPage.length) {
    console.log(`\n## Gap-zone queries with no dedicated page (${noPage.length})\n`);
    console.log(noPage.map((q) => `- "${q.query}" — ${q.impressions} impr, pos ${q.position}, lands on ${q.landing}`).join('\n'));
  }

  console.log(`\n## Movement vs baseline (3+ positions) — ${r.moved.length}\n`);
  console.log(r.moved.length
    ? mdTable(['Query', 'From', 'To', 'Δ', 'Impr', 'Page'], r.moved.slice(0, 20).map((m) => [m.query, m.from, m.to, (m.delta > 0 ? '+' : '') + m.delta, m.impressions, m.page.replace(/^https?:\/\/[^/]+\//, '')]))
    : '_nothing moved 3+ places, or no baseline yet_');

  console.log(`\n## Query families spread across pages (hub-page candidates) — ${r.clusters.length}\n`);
  console.log(r.clusters.length
    ? r.clusters.map((c) => `- **${c.key}** — ${c.queries.length} queries, ${c.impressions} impr, ${c.landingPageSpread} landing page(s): ${c.queries.slice(0, 6).map((q) => `"${q}"`).join(', ')}${c.queries.length > 6 ? ', …' : ''}`).join('\n')
    : '_none_');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

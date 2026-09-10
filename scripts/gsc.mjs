#!/usr/bin/env node
// Google Search Console from the terminal (and from CI).
//
//   node scripts/gsc.mjs sites                       properties the key can see
//   node scripts/gsc.mjs sitemaps                    sitemaps Google knows about
//   node scripts/gsc.mjs submit-sitemap [url]        (re)submit sitemap.xml — runs on every push to main
//   node scripts/gsc.mjs inspect <url ...>           index status for specific pages
//   node scripts/gsc.mjs inspect --sitemap           index status for every sitemap URL
//   node scripts/gsc.mjs inspect --file urls.txt     one URL per line
//   node scripts/gsc.mjs analytics [--days 28] [--by page|query|date] [--page <url>] [--limit 25]
//
// Flags:  --json   raw API output instead of the table
//         --site   override GSC_SITE_URL for one run
//
// Credentials come from GSC_SERVICE_ACCOUNT_JSON (the key) or
// GSC_SERVICE_ACCOUNT_FILE (path to the downloaded key file) + GSC_SITE_URL,
// via env, GitHub secret, or the repo-root .env — the same variables
// scripts/seo-gsc-pull.mjs reads. See scripts/lib/gsc-client.mjs.
//
// Exit codes: 0 ok · 1 API refused something · 2 not configured / bad input.
// submit-sitemap exits 0 with a notice when the key is absent so the CI
// workflow stays green on forks and until the secret is added.

import fs from "node:fs";
import {
  createClient,
  isConfigured,
  loadRepoEnv,
  readSitemapUrls,
  summarizeInspection,
  GscError,
  DEFAULT_SITE_URL,
} from "./lib/gsc-client.mjs";

const PUBLIC_ORIGIN = "https://www.pjllandservices.com";
const DEFAULT_SITEMAP = `${PUBLIC_ORIGIN}/sitemap.xml`;
const INSPECT_CONCURRENCY = 4;

loadRepoEnv();

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const key = arg.slice(2);
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--") && !["json", "sitemap"].includes(key)) {
    flags[key] = next;
    i += 1;
  } else {
    flags[key] = true;
  }
}
const command = positional.shift();
const asJson = Boolean(flags.json);

function usage() {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(columns.map((c) => c.label)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => row[c.key])));
}

function shortUrl(url) {
  return url.startsWith(PUBLIC_ORIGIN) ? url.slice(PUBLIC_ORIGIN.length) || "/" : url;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function makeClient() {
  return createClient({ siteUrl: flags.site || process.env.GSC_SITE_URL || DEFAULT_SITE_URL });
}

async function cmdSites() {
  const client = makeClient();
  const sites = await client.listSites();
  if (asJson) return console.log(JSON.stringify(sites, null, 2));
  console.log(`Service account: ${client.account.client_email}`);
  console.log(`Configured property: ${client.siteUrl}`);
  if (sites.length === 0) {
    console.log("\nThe key is valid but has not been added to any Search Console property yet.");
    console.log(`Add ${client.account.client_email} as a Full user on ${client.siteUrl}:`);
    console.log("  Search Console → Settings → Users and permissions → Add user");
    process.exitCode = 1;
    return;
  }
  console.log("");
  printTable(
    sites.map((s) => ({ site: s.siteUrl, level: s.permissionLevel, configured: s.siteUrl === client.siteUrl ? "◀ GSC_SITE_URL" : "" })),
    [
      { key: "site", label: "Property" },
      { key: "level", label: "Permission" },
      { key: "configured", label: "" },
    ]
  );
  if (!sites.some((s) => s.siteUrl === client.siteUrl)) {
    console.log(`\nGSC_SITE_URL (${client.siteUrl}) is not among them — every other command will 403.`);
    process.exitCode = 1;
  }
}

async function cmdSitemaps() {
  const client = makeClient();
  const sitemaps = await client.listSitemaps();
  if (asJson) return console.log(JSON.stringify(sitemaps, null, 2));
  printTable(
    sitemaps.map((s) => ({
      path: s.path,
      submitted: (s.lastSubmitted || "").slice(0, 16).replace("T", " "),
      downloaded: (s.lastDownloaded || "").slice(0, 16).replace("T", " "),
      pending: s.isPending ? "yes" : "",
      urls: (s.contents || []).reduce((n, c) => n + Number(c.submitted || 0), 0),
      indexed: (s.contents || []).reduce((n, c) => n + Number(c.indexed || 0), 0),
      errors: s.errors || 0,
      warnings: s.warnings || 0,
    })),
    [
      { key: "path", label: "Sitemap" },
      { key: "submitted", label: "Submitted" },
      { key: "downloaded", label: "Last read by Google" },
      { key: "pending", label: "Pending" },
      { key: "urls", label: "URLs" },
      { key: "indexed", label: "Indexed" },
      { key: "errors", label: "Err" },
      { key: "warnings", label: "Warn" },
    ]
  );
}

async function cmdSubmitSitemap() {
  if (!isConfigured()) {
    console.log("GSC_SERVICE_ACCOUNT_JSON is not set — skipping the Search Console sitemap ping.");
    return;
  }
  const client = makeClient();
  const feedpath = positional[0] || DEFAULT_SITEMAP;
  await client.submitSitemap(feedpath);
  console.log(`✓ Submitted ${feedpath} to Search Console (${client.siteUrl}).`);
}

async function cmdInspect() {
  let urls = positional;
  if (flags.sitemap) urls = readSitemapUrls();
  if (flags.file) {
    urls = fs
      .readFileSync(String(flags.file), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  urls = urls.map((u) => (u.startsWith("http") ? u : `${PUBLIC_ORIGIN}${u.startsWith("/") ? "" : "/"}${u}`));
  if (urls.length === 0) {
    console.error("inspect: give one or more URLs, --sitemap, or --file <list>.");
    process.exit(2);
  }
  const client = makeClient();
  const results = await mapLimit(urls, INSPECT_CONCURRENCY, async (url) => {
    try {
      const result = await client.inspectUrl(url);
      return { url, result, summary: summarizeInspection(result) };
    } catch (err) {
      if (err instanceof GscError && err.status !== 429 && err.status !== 403) {
        return { url, error: err.message, summary: { verdict: "ERROR", coverage: err.message } };
      }
      throw err;
    }
  });
  if (asJson) return console.log(JSON.stringify(results.map(({ url, result, error }) => ({ url, result, error })), null, 2));

  printTable(
    results.map(({ url, summary }) => ({
      url: shortUrl(url),
      verdict: summary.verdict,
      coverage: summary.coverage,
      crawl: summary.lastCrawl ? summary.lastCrawl.slice(0, 10) : "",
      canonical:
        summary.canonicalGoogle && summary.canonicalGoogle !== url ? `≠ ${shortUrl(summary.canonicalGoogle)}` : summary.canonicalGoogle ? "self" : "",
    })),
    [
      { key: "url", label: "URL" },
      { key: "verdict", label: "Verdict" },
      { key: "coverage", label: "Coverage" },
      { key: "crawl", label: "Last crawl" },
      { key: "canonical", label: "Google canonical" },
    ]
  );
  const counts = results.reduce((acc, r) => {
    acc[r.summary.verdict] = (acc[r.summary.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n${results.length} URL(s): ` +
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ")
  );
  console.log('PASS = "URL is on Google". NEUTRAL = known but not indexed (coverage says why). FAIL = indexed with an error.');
}

async function cmdAnalytics() {
  const days = Number(flags.days || 28);
  const by = String(flags.by || "page");
  const limit = Number(flags.limit || 25);
  // Search Console data lags ~2–3 days; end the window 3 days back so the
  // last rows are not artificially empty.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const client = makeClient();
  const query = {
    startDate: isoDate(start),
    endDate: isoDate(end),
    dimensions: [by],
    rowLimit: limit,
  };
  if (flags.page) {
    const page = String(flags.page).startsWith("http") ? String(flags.page) : `${PUBLIC_ORIGIN}${flags.page}`;
    query.dimensionFilterGroups = [{ filters: [{ dimension: "page", operator: "equals", expression: page }] }];
  }
  const rows = await client.searchAnalytics(query);
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  console.log(`${client.siteUrl} · ${query.startDate} → ${query.endDate} · by ${by}${flags.page ? ` · page ${flags.page}` : ""}\n`);
  printTable(
    rows.map((r) => ({
      key: by === "page" ? shortUrl(r.keys[0]) : r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: `${(r.ctr * 100).toFixed(1)}%`,
      position: r.position.toFixed(1),
    })),
    [
      { key: "key", label: by[0].toUpperCase() + by.slice(1) },
      { key: "clicks", label: "Clicks" },
      { key: "impressions", label: "Impr." },
      { key: "ctr", label: "CTR" },
      { key: "position", label: "Pos." },
    ]
  );
  const totals = rows.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  console.log(`\nTotal over listed rows: ${totals.clicks} clicks · ${totals.impressions} impressions`);
}

const commands = {
  sites: cmdSites,
  sitemaps: cmdSitemaps,
  "submit-sitemap": cmdSubmitSitemap,
  inspect: cmdInspect,
  analytics: cmdAnalytics,
};

async function main() {
  if (!command || flags.help || !commands[command]) {
    usage();
    process.exit(command && !commands[command] ? 2 : 0);
  }
  await commands[command]();
}

main().catch((err) => {
  if (err instanceof GscError) {
    console.error(`✗ ${err.message}`);
    if (err.hint) console.error(`  → ${err.hint}`);
    process.exit(err.status ? 1 : 2);
  }
  console.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(2);
});

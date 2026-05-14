#!/usr/bin/env node
/**
 * IndexNow URL submission.
 *
 * Reads sitemap.xml at the repo root, extracts all <loc> URLs, and POSTs
 * them to the IndexNow API so Bing (and any IndexNow-participating engine)
 * re-crawls within minutes instead of waiting for natural discovery.
 *
 * Usage:
 *   node scripts/indexnow-submit.js              # submit all sitemap URLs
 *   node scripts/indexnow-submit.js url1 url2... # submit only the given URLs
 *
 * Triggered automatically by .github/workflows/indexnow.yml on every push
 * to main. Can also be run locally for one-off pings.
 *
 * The IndexNow key is public by design — Bing verifies ownership by
 * fetching the key file at the site root and checking the key matches.
 * Daily limit is 10,000 URLs per host, far above what this project needs.
 */

const fs = require('fs');
const path = require('path');

const HOST = 'www.pjllandservices.com';
const KEY = 'da726e4d400548f8ae361b5381379b3b';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const SITEMAP_PATH = path.resolve(__dirname, '..', 'sitemap.xml');
const ENDPOINT = 'https://api.indexnow.org/IndexNow';

function readUrlsFromSitemap() {
  if (!fs.existsSync(SITEMAP_PATH)) {
    throw new Error(`sitemap.xml not found at ${SITEMAP_PATH}`);
  }
  const xml = fs.readFileSync(SITEMAP_PATH, 'utf8');
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g);
  const urls = [];
  for (const m of matches) urls.push(m[1]);
  return urls;
}

async function submit(urls) {
  if (urls.length === 0) {
    console.log('No URLs to submit. Exiting.');
    return 0;
  }

  const body = {
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls,
  };

  console.log(`Submitting ${urls.length} URL(s) to IndexNow...`);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`HTTP ${res.status} ${res.statusText}`);
  if (text) console.log(`Body: ${text}`);

  // 200 = OK, 202 = Accepted (key verification pending). Both are success.
  if (res.status === 200 || res.status === 202) {
    console.log(`✓ Successfully submitted ${urls.length} URL(s).`);
    return 0;
  }

  console.error(`✗ IndexNow rejected the submission (HTTP ${res.status}).`);
  // Common codes: 400 bad request, 403 invalid key, 422 host/URL mismatch, 429 rate-limited.
  return 1;
}

async function main() {
  const cliUrls = process.argv.slice(2);
  const urls = cliUrls.length > 0 ? cliUrls : readUrlsFromSitemap();
  const code = await submit(urls);
  process.exit(code);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(2);
});

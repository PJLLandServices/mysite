#!/usr/bin/env node
// scripts/seo-gsc-pull.mjs
//
// Pulls query + page ranking data from Google Search Console and saves a
// dated snapshot to seo/data/gsc-YYYY-MM-DD.json. The gap-finder skill reads
// the newest snapshot; the one before it is the "last week" baseline for the
// movement report.
//
// Auth is a Google service account (no browser OAuth dance, works headless):
//   1. Google Cloud Console → create a project → enable "Google Search Console API"
//   2. IAM → Service Accounts → create one → Keys → add JSON key
//   3. Search Console → Settings → Users and permissions → add the service
//      account's client_email as a user (Full or Restricted, read is enough)
//   4. .env:  GSC_SITE_URL=sc-domain:pjllandservices.com
//             GSC_SERVICE_ACCOUNT_FILE=/absolute/path/to/key.json
//        (or  GSC_SERVICE_ACCOUNT_JSON='{...the whole key file...}')
// Full walkthrough: seo/README.md.
//
// Built-ins only (crypto for the RS256 JWT, fetch for the API) — same rule as
// the rest of scripts/.
//
// Usage:
//   node scripts/seo-gsc-pull.mjs              # 90-day window, save snapshot
//   node scripts/seo-gsc-pull.mjs --days 28    # shorter window
//   node scripts/seo-gsc-pull.mjs --out FILE   # write elsewhere
//   node scripts/seo-gsc-pull.mjs --stdout     # print JSON, do not save

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDotEnv, flattenGscRow, aggregateByQuery, ymd, daysAgo } from './seo-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'seo', 'data');

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
const DAYS = Number(flag('--days', 90));
const OUT = flag('--out', null);
const STDOUT = args.includes('--stdout');

// ---------------------------------------------------------------- env / creds
(function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const [k, v] of Object.entries(parseDotEnv(fs.readFileSync(p, 'utf8')))) {
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:pjllandservices.com';

function loadServiceAccount() {
  if (process.env.GSC_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
  const file = process.env.GSC_SERVICE_ACCOUNT_FILE;
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.error(
    'GSC credentials not configured.\n' +
    '  Set GSC_SERVICE_ACCOUNT_FILE (path to the service-account JSON key) or\n' +
    '  GSC_SERVICE_ACCOUNT_JSON in .env. Setup steps: seo/README.md §Search Console.'
  );
  process.exit(2);
}

// ------------------------------------------------------------------ JWT auth
export function buildJwt({ client_email, private_key }, { scope, now = Math.floor(Date.now() / 1000) }) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({
    iss: client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const data = `${header}.${claims}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), private_key).toString('base64url');
  return `${data}.${sig}`;
}

async function getAccessToken(sa) {
  const assertion = buildJwt(sa, { scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// ----------------------------------------------------------------- API pull
async function queryAll(token, { startDate, endDate }) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`;
  const rows = [];
  const rowLimit = 5000;
  for (let startRow = 0; ; startRow += rowLimit) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['query', 'page'], rowLimit, startRow, type: 'web' }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 403) {
        throw new Error(`HTTP 403 from Search Console for ${SITE_URL}. Is the service account added as a user on that property? ${body}`);
      }
      throw new Error(`Search Console query failed: HTTP ${res.status} ${body}`);
    }
    const page = (await res.json()).rows || [];
    rows.push(...page.map(flattenGscRow));
    if (page.length < rowLimit) break;
  }
  return rows;
}

async function main() {
  const sa = loadServiceAccount();
  // GSC data lags ~2–3 days; asking for "today" returns partial rows.
  const endDate = ymd(daysAgo(3));
  const startDate = ymd(daysAgo(3 + DAYS));
  console.error(`Pulling ${SITE_URL} ${startDate} → ${endDate} (${DAYS} days)…`);

  const token = await getAccessToken(sa);
  const rows = await queryAll(token, { startDate, endDate });
  const queries = aggregateByQuery(rows);

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    site: SITE_URL,
    window: { startDate, endDate, days: DAYS },
    totals: {
      rows: rows.length,
      queries: queries.length,
      clicks: queries.reduce((s, q) => s + q.clicks, 0),
      impressions: queries.reduce((s, q) => s + q.impressions, 0),
    },
    queries,
    rows,
  };

  const json = JSON.stringify(snapshot, null, 2);
  if (STDOUT) { process.stdout.write(json + '\n'); return; }
  const out = OUT ? path.resolve(OUT) : path.join(DATA_DIR, `gsc-${ymd()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json + '\n');
  console.error(`Saved ${path.relative(ROOT, out)} — ${snapshot.totals.queries} queries, ${snapshot.totals.clicks} clicks, ${snapshot.totals.impressions} impressions.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

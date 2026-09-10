// Search Console client — auth and request shape, with no network.
//
//   node scripts/test-gsc-client.mjs
//
// Pins the parts that would fail silently in CI: the three accepted forms of
// GSC_SERVICE_ACCOUNT_JSON (raw JSON, base64, file path — plus the literal
// "\n" that Render's single-line secret field leaves in the PEM), the
// JWT-bearer assertion (verified against the matching public key, with the
// claims Google checks), one token exchange shared across calls, the
// sc-domain property encoded once in the path, sitemap submission as a PUT,
// the inspection body carrying siteUrl, and the 403 hint that tells Patrick
// to add the service account as a user instead of leaving a bare status.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAssertion,
  createClient,
  isConfigured,
  parseServiceAccount,
  serviceAccountFromEnv,
  summarizeInspection,
  GscError,
  SCOPE,
} from "./lib/gsc-client.mjs";

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
async function throws(name, fn, re) {
  try {
    await fn();
    ok(name, false, "did not throw");
  } catch (err) {
    ok(name, re ? re.test(err.message) : true, `threw "${err.message}"`);
    return err;
  }
  return null;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const account = {
  type: "service_account",
  project_id: "pjl-website",
  client_email: "pjl-seo@pjl-website.iam.gserviceaccount.com",
  private_key: privatePem,
  token_uri: "https://oauth2.googleapis.com/token",
};
const SITE = "sc-domain:pjllandservices.com";

// ---- parseServiceAccount -------------------------------------------------

ok("empty → null", parseServiceAccount("") === null && parseServiceAccount(undefined) === null);
ok("raw JSON", parseServiceAccount(JSON.stringify(account)).client_email === account.client_email);
ok(
  "base64 JSON",
  parseServiceAccount(Buffer.from(JSON.stringify(account)).toString("base64")).client_email === account.client_email
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-test-"));
const keyPath = path.join(tmp, "key.json");
fs.writeFileSync(keyPath, JSON.stringify(account));
ok("file path", parseServiceAccount(keyPath).client_email === account.client_email);
ok("GSC_SERVICE_ACCOUNT_FILE honoured", serviceAccountFromEnv({ GSC_SERVICE_ACCOUNT_FILE: keyPath }) === keyPath);
ok(
  "GSC_SERVICE_ACCOUNT_JSON wins over FILE",
  serviceAccountFromEnv({ GSC_SERVICE_ACCOUNT_FILE: keyPath, GSC_SERVICE_ACCOUNT_JSON: "{}" }) === "{}"
);
ok("isConfigured false when both blank", isConfigured({ GSC_SERVICE_ACCOUNT_FILE: "  ", GSC_SERVICE_ACCOUNT_JSON: "" }) === false);
ok("createClient reads FILE from env", createClient({ siteUrl: SITE, serviceAccount: keyPath, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) }).account.client_email === account.client_email);
const escaped = { ...account, private_key: privatePem.replace(/\n/g, "\\n") };
ok("literal \\n restored", parseServiceAccount(JSON.stringify(escaped)).private_key === privatePem);
await throws("garbage rejected", () => parseServiceAccount("not-a-key"), /not JSON, base64 JSON, or a path/);
await throws("missing private_key", () => parseServiceAccount(JSON.stringify({ client_email: "x" })), /missing "private_key"/);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- assertion -----------------------------------------------------------

const NOW = 1_800_000_000;
const jwt = buildAssertion(account, { now: NOW });
const [h, c, s] = jwt.split(".");
const fromB64url = (x) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
ok("header RS256", JSON.parse(fromB64url(h)).alg === "RS256");
const claims = JSON.parse(fromB64url(c));
ok("iss = client_email", claims.iss === account.client_email);
ok("aud = token_uri", claims.aud === account.token_uri);
ok("scope = webmasters", claims.scope === SCOPE);
ok("exp = iat + 3600", claims.iat === NOW && claims.exp === NOW + 3600);
ok("signature verifies", crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, fromB64url(s)));

// ---- client requests -----------------------------------------------------

const calls = [];
let tokenExchanges = 0;
let failNext = null;
const fakeFetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  if (String(url) === account.token_uri) {
    tokenExchanges += 1;
    const params = new URLSearchParams(init.body);
    if (params.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return respond(400, { error: "invalid_grant" });
    const [hh, cc, ss] = params.get("assertion").split(".");
    if (!crypto.verify("RSA-SHA256", Buffer.from(`${hh}.${cc}`), publicKey, fromB64url(ss))) return respond(401, { error: "bad_sig" });
    return respond(200, { access_token: "tok-123", expires_in: 3599, token_type: "Bearer" });
  }
  if (failNext) {
    const f = failNext;
    failNext = null;
    return respond(f.status, f.body);
  }
  if (init.method === "PUT") return respond(204);
  if (String(url).includes("/sites/") && String(url).endsWith("/sitemaps")) return respond(200, { sitemap: [{ path: "https://www.pjllandservices.com/sitemap.xml" }] });
  if (String(url).endsWith("/sites")) return respond(200, { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteFullUser" }] });
  if (String(url).includes("urlInspection")) {
    return respond(200, {
      inspectionResult: {
        inspectionResultLink: "https://search.google.com/search-console/inspect?…",
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          robotsTxtState: "ALLOWED",
          indexingState: "INDEXING_ALLOWED",
          lastCrawlTime: "2026-09-09T13:00:00Z",
          googleCanonical: "https://www.pjllandservices.com/sprinkler-service-newmarket.html",
          userCanonical: "https://www.pjllandservices.com/sprinkler-service-newmarket.html",
          crawledAs: "MOBILE",
        },
        mobileUsabilityResult: { verdict: "PASS" },
      },
    });
  }
  if (String(url).endsWith("/searchAnalytics/query")) return respond(200, { rows: [{ keys: ["https://www.pjllandservices.com/"], clicks: 3, impressions: 40, ctr: 0.075, position: 8.2 }] });
  return respond(404, { error: { message: "unexpected url in test" } });
};

let clock = NOW;
const client = createClient({ siteUrl: SITE, serviceAccount: account, fetchImpl: fakeFetch, now: () => clock });

const sites = await client.listSites();
ok("listSites returns entries", sites.length === 1 && sites[0].siteUrl === SITE);
ok("bearer header sent", calls.at(-1).headers.authorization === "Bearer tok-123");

await client.submitSitemap("https://www.pjllandservices.com/sitemap.xml");
const put = calls.at(-1);
ok("submitSitemap is a PUT", put.method === "PUT");
ok(
  "site + feedpath encoded in path",
  put.url === `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/sitemaps/${encodeURIComponent("https://www.pjllandservices.com/sitemap.xml")}`,
  put.url
);

const inspection = await client.inspectUrl("https://www.pjllandservices.com/sprinkler-service-newmarket.html");
const inspectCall = calls.at(-1);
ok("inspect POSTs to the v1 endpoint", inspectCall.method === "POST" && inspectCall.url === "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
const inspectBody = JSON.parse(inspectCall.body);
ok("inspect body carries siteUrl + inspectionUrl", inspectBody.siteUrl === SITE && inspectBody.inspectionUrl.endsWith("newmarket.html"));
const summary = summarizeInspection(inspection);
ok("summary flattens verdict/coverage/crawl", summary.verdict === "PASS" && summary.coverage === "Submitted and indexed" && summary.lastCrawl.startsWith("2026-09-09"));
ok("summary handles an empty result", summarizeInspection({}).verdict === "UNKNOWN");

const rows = await client.searchAnalytics({ startDate: "2026-08-10", endDate: "2026-09-06", dimensions: ["page"], rowLimit: 10 });
const saCall = calls.at(-1);
ok("analytics POSTs a query", saCall.method === "POST" && saCall.url.endsWith(`/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`));
ok("analytics rows returned", rows.length === 1 && rows[0].clicks === 3);
ok("analytics body has the window + dimensions", (() => { const b = JSON.parse(saCall.body); return b.startDate === "2026-08-10" && b.dimensions[0] === "page" && b.rowLimit === 10; })());

ok("one token exchange for four calls", tokenExchanges === 1, `exchanges=${tokenExchanges}`);
clock = NOW + 3599 - 30; // inside the 60 s refresh margin
await client.listSites();
ok("token refreshed near expiry", tokenExchanges === 2, `exchanges=${tokenExchanges}`);

failNext = { status: 403, body: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:pjllandservices.com'." } } };
const err403 = await throws("403 surfaces as GscError", () => client.listSitemaps(), /sufficient permission/);
ok("403 is a GscError with status", err403 instanceof GscError && err403.status === 403);
ok("403 hint says add the user", /Users and permissions/.test(err403 && err403.hint));

failNext = { status: 429, body: { error: { message: "Quota exceeded" } } };
const err429 = await throws("429 surfaces", () => client.inspectUrl("https://www.pjllandservices.com/"), /Quota/);
ok("429 hint names the quota", /2,000/.test(err429 && err429.hint));

await throws("missing key → setup error, not a stack trace", () => createClient({ serviceAccount: "", fetchImpl: fakeFetch }), /GSC_SERVICE_ACCOUNT_JSON is not set/);

// ---- report ----------------------------------------------------------------

if (failures.length) {
  console.error(`✗ gsc-client: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ gsc-client: ${pass} checks passed`);

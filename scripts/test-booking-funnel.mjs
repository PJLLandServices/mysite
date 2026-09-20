// Booking funnel admin dashboard — GA4 Data API wrapper.
//
//   node scripts/test-booking-funnel.mjs
//
// WHAT THIS PROTECTS. server/lib/ga4.js is the only thing standing between
// the /admin/booking-funnel page and a crash: a missing/invalid credential,
// a slow or erroring GA4 Data API, or Google being briefly unreachable must
// all degrade to a clear {ok:false} the page can show a message for — never
// an unhandled exception, and never a silently fabricated number. This is
// the same fail-soft posture as lib/geocode.js's town-centroid fallback.
//
// NO NETWORK. Every case below stubs global.fetch — this suite never calls
// Google, so it's deterministic and safe in CI. The real GA4 round trip
// (JWT → OAuth token → Data API) still needs a live check once Patrick's
// service account and property ID are both in Render (see PJL-38 in Linear).
//
// ISOLATION. server/lib/ga4.js keeps its access-token and disk-cache state
// in module-level variables, so each scenario below runs in its own child
// process (spawnScenario) rather than sharing one `require` — otherwise an
// earlier assertion's cache/token would silently leak into the next one.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = path.join(ROOT, "server/data/booking-funnel-cache.json");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Every scenario is a small CJS program passed to `node -e`, isolating
// ga4.js's module-level token/cache memo per scenario. Each one prints a
// single JSON line to stdout as its result.
function runScenario(script) {
  fs.rmSync(CACHE_PATH, { force: true });
  const out = execFileSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8" });
  fs.rmSync(CACHE_PATH, { force: true }); // never leave test fixtures behind for the real deploy
  return JSON.parse(out.trim().split("\n").pop());
}

// Every scenario that gets past the "not configured" check signs a real
// JWT locally (crypto, no network) before its stubbed fetch ever runs, so
// it needs a real key pair, not a placeholder string.
function withRealKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    client_email: "test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs1", format: "pem" })
  });
}

// ---- 1. Not configured: no credential, no crash --------------------------

{
  const result = runScenario(`
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    ga4.getBookingFunnel(7).then((r) => console.log(JSON.stringify(r)));
  `);
  ok("missing credential returns ok:false, not a throw", result.ok === false);
  ok("missing credential names the reason", result.reason === "not_configured");
  ok("missing credential gives a customer-safe message, not a stack trace",
    Array.isArray(result.errors) && result.errors.length === 1 && !/at Object|node_modules/.test(result.errors[0]));
}

// ---- 2. Shapes a mocked GA4 response correctly ----------------------------

{
  const key = withRealKey();
  const result = runScenario(`
    process.env.GA4_SERVICE_ACCOUNT_KEY = ${JSON.stringify(key)};
    process.env.GA4_PROPERTY_ID = "123456789";
    global.fetch = async (url, opts) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      const body = JSON.parse(opts.body);
      const dim = body.dimensions[0].name;
      if (dim === "customEvent:step_name") {
        return { ok: true, json: async () => ({ rows: [
          { dimensionValues: [{ value: "confirm" }], metricValues: [{ value: "2" }] },
          { dimensionValues: [{ value: "service" }], metricValues: [{ value: "40" }] },
          { dimensionValues: [{ value: "address" }], metricValues: [{ value: "20" }] }
        ] }) };
      }
      if (dim === "city") {
        return { ok: true, json: async () => ({ rows: [
          { dimensionValues: [{ value: "Newmarket" }, { value: "Ontario" }], metricValues: [{ value: "22" }] },
          { dimensionValues: [{ value: "(not set)" }, { value: "(not set)" }], metricValues: [{ value: "3" }] }
        ] }) };
      }
      return { ok: true, json: async () => ({ rows: [
        { dimensionValues: [{ value: "fall_close_4z" }, { value: "true" }], metricValues: [{ value: "15" }] },
        { dimensionValues: [{ value: "fall_close_4z" }, { value: "false" }], metricValues: [{ value: "5" }] }
      ] }) };
    };
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    ga4.getBookingFunnel(7).then((r) => console.log(JSON.stringify(r)));
  `);
  ok("shaped result is ok", result.ok === true);
  ok("steps come back in flow order, not GA4's row order",
    JSON.stringify(result.steps.map((s) => s.step_name)) === JSON.stringify(["service", "address", "confirm"]),
    JSON.stringify(result.steps));
  ok("step visitor counts are preserved", result.steps[0].visitors === 40 && result.steps[2].visitors === 2);
  ok("(not set) location rows are labelled Unknown, not blank",
    result.byLocation.some((r) => r.location === "Unknown" && r.visitors === 3));
  ok("real city/region rows are joined into one label",
    result.byLocation.some((r) => r.location === "Newmarket, Ontario" && r.visitors === 22));
  ok("service breakdown sums deep-linked and total visitors separately",
    result.byService[0].service_key === "fall_close_4z"
    && result.byService[0].visitors === 20
    && result.byService[0].deepLinked === 15);
}

// ---- 3. Caching: a second call inside the TTL never re-fetches -----------

{
  const key = withRealKey();
  const result = runScenario(`
    process.env.GA4_SERVICE_ACCOUNT_KEY = ${JSON.stringify(key)};
    process.env.GA4_PROPERTY_ID = "123456789";
    let calls = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      calls++;
      return { ok: true, json: async () => ({ rows: [] }) };
    };
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    (async () => {
      await ga4.getBookingFunnel(7);
      const callsAfterFirst = calls;
      await ga4.getBookingFunnel(7);
      console.log(JSON.stringify({ callsAfterFirst, callsAfterSecond: calls }));
    })();
  `);
  ok("second call within the TTL makes zero additional GA4 requests",
    result.callsAfterSecond === result.callsAfterFirst, JSON.stringify(result));
}

// ---- 4. Fail-soft: a later fetch failure serves the last good cache ------

{
  const key = withRealKey();
  const result = runScenario(`
    process.env.GA4_SERVICE_ACCOUNT_KEY = ${JSON.stringify(key)};
    process.env.GA4_PROPERTY_ID = "123456789";
    let fail = false;
    global.fetch = async (url, opts) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      if (fail) throw new Error("simulated network failure");
      return { ok: true, json: async () => ({ rows: [
        { dimensionValues: [{ value: "service" }], metricValues: [{ value: "9" }] }
      ] }) };
    };
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    (async () => {
      const first = await ga4.getBookingFunnel(30); // seed a real cache entry for days=30
      fail = true;
      // Force the cache entry outside its TTL (module-internal cacheMemo
      // isn't reachable from here, so fast-forward the clock instead) so
      // the next call actually attempts a fresh fetch — and hits the
      // simulated failure — rather than short-circuiting to the still-
      // fresh cached copy.
      const realNow = Date.now;
      Date.now = () => realNow() + 30 * 60 * 1000;
      const second = await ga4.getBookingFunnel(30);
      Date.now = realNow;
      console.log(JSON.stringify({ first, second }));
    })();
  `);
  ok("first call (cache empty) reaches Google and succeeds", result.first.ok === true && result.first.stale === false);
  ok("second call, once GA4 starts failing, still returns ok:true from cache",
    result.second.ok === true, JSON.stringify(result.second));
  ok("second call is marked stale so the page can say so", result.second.stale === true);
  ok("stale response still carries the last good numbers, not empty ones",
    result.second.steps.length === 1 && result.second.steps[0].visitors === 9);
}

// ---- 5. Fail-soft: a fetch failure with NO prior cache is a clean ok:false

{
  const key = withRealKey();
  const result = runScenario(`
    process.env.GA4_SERVICE_ACCOUNT_KEY = ${JSON.stringify(key)};
    process.env.GA4_PROPERTY_ID = "123456789";
    global.fetch = async (url) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      throw new Error("simulated network failure");
    };
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    ga4.getBookingFunnel(14).then((r) => console.log(JSON.stringify(r)));
  `);
  ok("cold-cache fetch failure is ok:false, never a throw", result.ok === false);
  ok("cold-cache fetch failure names the reason", result.reason === "fetch_failed");
  ok("cold-cache fetch failure carries the underlying message",
    Array.isArray(result.errors) && /simulated network failure/.test(result.errors[0] || ""));
}

// ---- 6. A rejected/invalid credential is ok:false, not a throw -----------

{
  const result = runScenario(`
    process.env.GA4_SERVICE_ACCOUNT_KEY = "not valid json";
    process.env.GA4_PROPERTY_ID = "123456789";
    const ga4 = require(${JSON.stringify(path.join(ROOT, "server/lib/ga4.js"))});
    ga4.getBookingFunnel(7).then((r) => console.log(JSON.stringify(r)));
  `);
  ok("malformed GA4_SERVICE_ACCOUNT_KEY is ok:false, not a throw", result.ok === false);
  ok("malformed key gives a fixable, plain-English error",
    /valid JSON/i.test((result.errors || [])[0] || ""));
}

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-booking-funnel: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-booking-funnel: ${pass} assertions passed`);

// scripts/lib/test-tripwires.cjs
//
// The one definition of "this environment could reach the real business",
// shared by the harness (scripts/lib/field-server.mjs, before it spawns a
// server) and the stub the server is booted with
// (scripts/lib/stub-outbound.cjs, which refuses to load). Two copies of
// this test would drift; so there is one.
//
// Pure: requiring it patches nothing.

const fs = require("node:fs");
const path = require("node:path");

const PRODUCTION_HOST = /(^|[^a-z0-9-])(www\.)?pjllandservices\.com|\.onrender\.com/i;
const LIVE_KEY = /\b(sk|rk|pk)_live_/;
// Credentials that must be a stub when set at all. Anything real in one of
// these means a real message, charge or API call is one bug away.
const MUST_BE_STUB = ["GMAIL_APP_PASSWORD", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
  "STRIPE_WEBHOOK_SECRET", "QB_CLIENT_ID", "QB_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY",
  "GOOGLE_MAPS_SERVER_KEY", "GOOGLE_MAPS_BROWSER_KEY", "ANTHROPIC_API_KEY",
  "TURNSTILE_SECRET_KEY", "RECAPTCHA_SECRET_KEY", "GA4_SERVICE_ACCOUNT_KEY",
  "GSC_SERVICE_ACCOUNT_JSON", "GSC_SERVICE_ACCOUNT_FILE", "BOOKING_API_KEY"];
// A stub is spelled as one: "stub", "ACstub", "whsec_stub…" — not merely a
// value that happens to contain the word somewhere.
const isStubValue = (v) => /^(ac|whsec_)?stub([_-][a-z0-9_-]*)?$/i.test(String(v));
function unsafeEnvironment(env, serverEntry) {
  const problems = [];
  for (const [key, value] of Object.entries(env)) {
    const v = String(value ?? "");
    if (PRODUCTION_HOST.test(v)) problems.push(`${key} points at production (${v.slice(0, 80)})`);
    if (LIVE_KEY.test(v)) problems.push(`${key} holds a LIVE Stripe key`);
  }
  if (env.STRIPE_SECRET_KEY && !/^sk_test_/.test(env.STRIPE_SECRET_KEY)) problems.push("STRIPE_SECRET_KEY is not a test key");
  if (env.STRIPE_PUBLISHABLE_KEY && !/^pk_test_/.test(env.STRIPE_PUBLISHABLE_KEY)) problems.push("STRIPE_PUBLISHABLE_KEY is not a test key");
  for (const key of MUST_BE_STUB) {
    if (env[key] && !isStubValue(env[key])) problems.push(`${key} is set to something that isn't a stub`);
  }
  if (serverEntry) {
    const dotenv = path.resolve(path.dirname(serverEntry), "..", ".env");
    if (fs.existsSync(dotenv)) problems.push(`a .env file sits beside the server (${dotenv}) — it would load real keys`);
  }
  return problems;
}
module.exports = { unsafeEnvironment, PRODUCTION_HOST };

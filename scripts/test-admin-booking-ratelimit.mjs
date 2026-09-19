// Admin bookings are never rate-limited — the sixth phone-call booking
// of the morning must book.
//
//   node scripts/test-admin-booking-ratelimit.mjs
//
// WHAT THIS PROTECTS. 2026-09-19: Patrick, booking fall closings from
// the CRM, hit the anti-bot per-IP cap (5 submissions / 10 min) on his
// own booking flow and was locked out with "Too many submissions from
// this network." The cap is sized for one household on the public form;
// an authenticated admin or tech burst-booking from one office IP is
// the business working, not an attack. /api/booking/reserve already
// skips Turnstile for admin sessions on the reasoning that the session
// IS the bot filter — the same reasoning now applies to the rate limit.
//
// WHAT MUST NOT LOOSEN. The public path keeps the cap exactly as it
// was, and skipRateLimit skips ONLY the rate limit: the honeypot still
// blocks, and every skipped-past attempt is still recorded against the
// IP so the public bucket's arithmetic never changes.
process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const antiBot = require(path.join(ROOT, "server/lib/anti-bot.js"));
const { checkSubmission, _resetForTests, _RATE_LIMIT_MAX } = antiBot;

// No Turnstile secret in this process — checkSubmission then skips the
// outbound verify and the tests stay network-free and deterministic.
delete process.env.TURNSTILE_SECRET_KEY;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const IP = "203.0.113.7";
const submit = (opts = {}) =>
  checkSubmission({ body: { name: "x" }, ip: IP, userAgent: "test", ...opts });

// ---- 1. The public cap still holds --------------------------------
{
  _resetForTests();
  let verdict = null;
  for (let i = 0; i < _RATE_LIMIT_MAX + 1; i += 1) verdict = await submit();
  ok("the public path still blocks past the cap",
    verdict.ok === false && verdict.reason === "rate_limit", JSON.stringify(verdict));
}

// ---- 2. skipRateLimit books past the cap ---------------------------
{
  _resetForTests();
  for (let i = 0; i < _RATE_LIMIT_MAX + 1; i += 1) await submit();
  const verdict = await submit({ skipRateLimit: true });
  ok("an over-limit IP with skipRateLimit still passes",
    verdict.ok === true, JSON.stringify(verdict));
}

// ---- 3. The skip is ONLY the rate limit ----------------------------
{
  _resetForTests();
  const verdict = await checkSubmission({
    body: { name: "x", contact_website: "http://spam.example" }, // honeypot field
    ip: IP,
    userAgent: "test",
    skipRateLimit: true
  });
  ok("the honeypot still blocks a skipRateLimit submission",
    verdict.ok === false && verdict.reason === "honeypot", JSON.stringify(verdict));
}

// ---- 4. Skipped-past attempts still count against the IP -----------
{
  _resetForTests();
  for (let i = 0; i < _RATE_LIMIT_MAX; i += 1) await submit({ skipRateLimit: true });
  const verdict = await submit(); // public attempt no. MAX+1 from this IP
  ok("admin attempts still fill the bucket the public path reads",
    verdict.ok === false && verdict.reason === "rate_limit", JSON.stringify(verdict));
}

// ---- 5. Source guard: the reserve route wires the skip -------------
{
  const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const route = serverSrc.slice(
    serverSrc.indexOf('pathname === "/api/booking/reserve"')
  );
  const gate = route.slice(0, route.indexOf("serviceKey"));
  ok("/api/booking/reserve skips the rate limit for admin sessions",
    gate.includes("skipRateLimit: isAdmin || isLoadTest"),
    "without it an admin's sixth booking in ten minutes 429s again");
  ok("/api/booking/reserve still skips Turnstile for admin sessions",
    gate.includes("skipTurnstile: isAdmin || isLoadTest"));
}

if (failures.length) {
  console.error(`FAIL test-admin-booking-ratelimit: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-admin-booking-ratelimit — ${pass} assertions`);

// Unit tests for the proposal phone gate's stateless core
// (server/lib/proposal-unlock.js). Run: node scripts/test-proposal-unlock.mjs
//
// Covers the §5 acceptance checklist for normalization + the cookie's
// single-quote scoping. No server needed — these are pure functions.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pu = require("../server/lib/proposal-unlock.js");

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---- §3.3 / §5 normalization — every one of these unlocks (905) 960-0181
const STORED = "(905) 960-0181";
const target = pu.normalizePhone(STORED);
eq(target, "9059600181", "stored normalizes to 10 digits");

const unlockers = [
  "9059600181",
  "905-960-0181",
  "(905) 960-0181",
  "905.960.0181",
  "+1 905 960 0181",
  "1-905-960-0181",
  "905 960 0181  ", // trailing whitespace
];
for (const input of unlockers) {
  const res = pu.evaluatePhone(input, [STORED]);
  ok(res.matched && !res.malformed && !res.noStored, `unlocks with input "${input}"`);
}

// A WRONG 10-digit number is rejected (real attempt, not malformed).
{
  const res = pu.evaluatePhone("9059600182", [STORED]);
  ok(!res.matched && !res.malformed && !res.noStored, "wrong 10-digit number rejected as a real attempt");
}

// A 9-digit input is MALFORMED (must not consume an attempt).
{
  const res = pu.evaluatePhone("905960018", [STORED]);
  ok(res.malformed === true, "9-digit input flagged malformed");
}
// Empty / junk input → malformed.
ok(pu.evaluatePhone("", [STORED]).malformed, "empty input malformed");
ok(pu.evaluatePhone("abc", [STORED]).malformed, "non-numeric input malformed");

// No phone on record → noStored (page Patrick, generic failure).
{
  const res = pu.evaluatePhone("9059600181", []);
  ok(res.noStored === true && !res.matched, "no stored phone → noStored");
  const res2 = pu.evaluatePhone("9059600181", ["", "  ", "12"]); // none valid
  ok(res2.noStored === true, "only-invalid stored phones → noStored");
}

// Multiple phones on record — ANY unlocks (primary or spouse).
{
  const stored = ["(905) 960-0181", "416-555-9999"];
  ok(pu.evaluatePhone("4165559999", stored).matched, "spouse/second phone unlocks");
  ok(pu.evaluatePhone("9059600181", stored).matched, "primary phone unlocks");
  ok(!pu.evaluatePhone("6470000000", stored).matched, "unrelated number does not unlock");
}

// Leading-1 / +1 collapse: an 11-digit stored value with country code still
// matches a bare 10-digit typed value (last-10 on both sides).
{
  const res = pu.evaluatePhone("9059600181", ["1-905-960-0181"]);
  ok(res.matched, "11-digit stored (leading 1) matches bare 10-digit typed");
}

// ---- §3.4 unlock cookie — scoped to ONE quote, 24h, tamper-evident ----
const SECRET = "test-secret-do-not-use-in-prod";
const NOW = 1_800_000_000_000; // fixed clock for determinism

{
  const cookieA = pu.mintCookieValue("Q-2026-0228", SECRET, { now: NOW });
  // Opens the quote it was minted for.
  ok(pu.verifyCookieValue(cookieA, "Q-2026-0228", SECRET, { now: NOW }), "cookie opens its own quote");
  // Does NOT open a different quote (§3.4 — scoped to one quote).
  ok(!pu.verifyCookieValue(cookieA, "Q-2026-0301", SECRET, { now: NOW }), "cookie for Q-A does NOT open Q-B");
  // Expired cookie (25h later) → rejected.
  ok(!pu.verifyCookieValue(cookieA, "Q-2026-0228", SECRET, { now: NOW + 25 * 60 * 60 * 1000 }), "expired cookie rejected");
  // Still valid at 23h.
  ok(pu.verifyCookieValue(cookieA, "Q-2026-0228", SECRET, { now: NOW + 23 * 60 * 60 * 1000 }), "cookie still valid at 23h");
  // Wrong secret → rejected (forged signature).
  ok(!pu.verifyCookieValue(cookieA, "Q-2026-0228", "other-secret", { now: NOW }), "cookie under wrong secret rejected");
  // Tampered payload (flip a char in the encoded part) → rejected.
  const tampered = "x" + cookieA.slice(1);
  ok(!pu.verifyCookieValue(tampered, "Q-2026-0228", SECRET, { now: NOW }), "tampered cookie rejected");
  // Garbage input → false, never throws.
  ok(!pu.verifyCookieValue("", "Q-2026-0228", SECRET, { now: NOW }), "empty cookie rejected");
  ok(!pu.verifyCookieValue("no-dot-here", "Q-2026-0228", SECRET, { now: NOW }), "malformed cookie rejected");
}

console.log(`\nproposal-unlock: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

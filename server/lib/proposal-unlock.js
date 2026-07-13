// Proposal phone gate — the stateless pieces (Phone-Gated Proposal Access
// brief, 2026-07).
//
// A `project_proposal` document sits behind an unguessable URL token PLUS
// a phone-number challenge. This module holds the two pure, side-effect-
// free pieces of that gate so they can be unit-tested in isolation:
//
//   1. Phone normalization + comparison (§3.3 of the brief).
//   2. The unlock-cookie mint / verify.
//
// HONEST SECURITY NOTE (put nowhere customer-facing): a phone number is
// NOT a secret. This gate defeats ACCIDENTAL disclosure — a forwarded
// email, a shared screenshot, a link pasted into a group chat. It does
// not defeat a motivated attacker who knows the customer. The URL token
// is what provides unguessability; the phone provides "this is the right
// human." Both, or neither is worth much.
//
// The cookie construction deliberately MIRRORS the session cookie in
// server.js (base64url(JSON) payload + HMAC-SHA256 signature, verified in
// constant time). It is NOT the session cookie and NOT a magic-link token
// (magic-tokens.js) — different name, different payload, different
// lifetime. Do not conflate the three.

const crypto = require("node:crypto");

// Distinct cookie name so it can never collide with the session cookie
// (pjl_crm_session) or anything else.
const COOKIE_NAME = "pjl_proposal_unlock";

// 24h — long enough to read it, show a spouse, come back after dinner;
// short enough that a borrowed phone doesn't hold access for a month.
const TTL_MS = 24 * 60 * 60 * 1000;

// Brute-force ceiling: 5 real attempts per quote per hour, then a rolling
// 1-hour lock (see the rate-limit wiring in server.js). Ten digits with a
// known area code is not a large space, so this is the only place a real
// attacker gets a foothold.
const ATTEMPT_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

// ---- Phone normalization (§3.3) --------------------------------------
//
// Strip EVERYTHING that isn't a digit, then — if more than 10 digits
// remain — keep the LAST 10. That drops a leading country code (1 / +1)
// so "+1 905 960 0181", "1-905-960-0181", and "9059600181" all collapse
// to the same "9059600181".
//
// Applied to BOTH sides of the comparison: the customer's typed input AND
// every phone stored on the record. Fewer than 10 digits after this is
// treated as malformed by the caller (a typo, not an attack) — this
// function just returns whatever digits it found; length-checking is the
// caller's job so it can decide not to spend a rate-limit attempt on it.
function normalizePhone(input) {
  const digits = String(input == null ? "" : input).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// True when a normalized phone is a usable 10-digit number.
function isCompletePhone(normalized) {
  return typeof normalized === "string" && normalized.length === 10;
}

// Build the set of comparison keys from a list of raw stored phones.
// Each is normalized the same way as the typed input; anything that
// doesn't yield a full 10 digits is dropped. An empty set means "this
// customer has no usable phone on record" — the caller pages Patrick and
// returns a generic failure (§3.6), because the customer is locked out of
// their own document and no input can ever match.
function buildPhoneKeySet(rawPhones) {
  const set = new Set();
  for (const raw of Array.isArray(rawPhones) ? rawPhones : [rawPhones]) {
    const key = normalizePhone(raw);
    if (isCompletePhone(key)) set.add(key);
  }
  return set;
}

// Does the typed phone match ANY stored phone? Returns a small result
// object rather than a bare boolean so the caller can branch on the three
// distinct outcomes without re-deriving them:
//   { malformed: true }                     typed < 10 digits — don't spend an attempt
//   { malformed: false, noStored: true }    customer has no phone on file — page Patrick
//   { malformed: false, matched: bool }     a real attempt; matched or not
function evaluatePhone(typedInput, rawStoredPhones) {
  const typed = normalizePhone(typedInput);
  if (!isCompletePhone(typed)) {
    return { malformed: true, noStored: false, matched: false };
  }
  const keys = buildPhoneKeySet(rawStoredPhones);
  if (keys.size === 0) {
    return { malformed: false, noStored: true, matched: false };
  }
  return { malformed: false, noStored: false, matched: keys.has(typed) };
}

// ---- Unlock cookie ----------------------------------------------------

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
function b64urlDecode(b64) {
  try { return JSON.parse(Buffer.from(String(b64 || ""), "base64url").toString("utf8")); }
  catch { return null; }
}
function sign(encoded, secret) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

// Mint the cookie VALUE (not the full Set-Cookie header — server.js adds
// the flags so it can reuse secureCookieFlag()). Payload is scoped to a
// single quote: unlocking Q-A grants nothing on Q-B. `now` is injectable
// for tests.
function mintCookieValue(quoteId, secret, { ttlMs = TTL_MS, now = Date.now() } = {}) {
  if (!quoteId) throw new Error("mintCookieValue requires a quoteId");
  if (!secret) throw new Error("mintCookieValue requires the session secret");
  const encoded = b64urlEncode({ scope: "proposal", quoteId: String(quoteId), exp: now + ttlMs });
  return `${encoded}.${sign(encoded, secret)}`;
}

// Verify a cookie value against ONE quote id. Returns true only when the
// signature is valid, the scope is "proposal", the quoteId matches
// EXACTLY, and it hasn't expired. Constant-time signature comparison, same
// as the session cookie. Any malformed input → false, never throws.
function verifyCookieValue(value, quoteId, secret, { now = Date.now() } = {}) {
  try {
    if (!value || !quoteId || !secret) return false;
    const dot = String(value).indexOf(".");
    if (dot === -1) return false;
    const encoded = String(value).slice(0, dot);
    const signature = String(value).slice(dot + 1);
    if (!encoded || !signature) return false;
    const expected = sign(encoded, secret);
    const aBuf = Buffer.from(signature);
    const eBuf = Buffer.from(expected);
    if (aBuf.length !== eBuf.length || !crypto.timingSafeEqual(aBuf, eBuf)) return false;
    const payload = b64urlDecode(encoded);
    if (!payload || typeof payload !== "object") return false;
    if (payload.scope !== "proposal") return false;
    if (String(payload.quoteId) !== String(quoteId)) return false;
    if (!(Number(payload.exp) > now)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  COOKIE_NAME,
  TTL_MS,
  ATTEMPT_LIMIT,
  WINDOW_MS,
  normalizePhone,
  isCompletePhone,
  buildPhoneKeySet,
  evaluatePhone,
  mintCookieValue,
  verifyCookieValue
};

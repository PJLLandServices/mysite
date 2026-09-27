// server/lib/photo-links.js
//
// A signed link to ONE work-order photo, for places that have no staff
// session — the customer status-update email is the first.
//
// Why not the admin route: /api/work-orders/:id/photo/:n needs a staff
// session cookie. An email lands in an inbox; there is no session and
// there never will be.
//
// Why not the customer's portal token: that token unlocks the customer's
// WHOLE property portal — service history, reports, everything. The
// status-update recipient is whatever address the office types, which is
// not always the owner (a property manager, a contractor). Putting the
// portal token in an <img src> would hand portal access to anyone the
// email is sent or forwarded to.
//
// So the credential is scoped to exactly what the email shows:
//
//   { scope: "wo-photo", woId, n, exp }  →  base64url  .  HMAC-SHA256
//
// signed with the session secret. A link for photo 3 cannot fetch photo
// 4; a link for one work order cannot fetch another's; it expires. A
// leaked or forwarded email leaks those photos and nothing else.
//
// This is deliberately the same construction as the proposal-unlock
// cookie (lib/proposal-unlock.js) — one signing model in the codebase,
// not a second one — with the same constant-time comparison and the same
// "any malformed input is false, never a throw" contract.
//
// Trade-off, named: the secret is the session secret, so rotating it
// breaks every photo in every previously sent email. That is the same
// trade proposal-unlock already makes.

const crypto = require("node:crypto");

const SCOPE = "wo-photo";

// Long enough that a status update opened weeks later still shows its
// photos; short enough that a link is not a permanent credential.
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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

// The value that goes in ?s=. Scoped to ONE photo on ONE work order.
function mint(woId, n, secret, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!woId) throw new Error("photo-links.mint requires a woId");
  if (!Number.isInteger(Number(n)) || Number(n) < 1) throw new Error("photo-links.mint requires a photo number");
  if (!secret) throw new Error("photo-links.mint requires the session secret");
  const encoded = b64urlEncode({ scope: SCOPE, woId: String(woId), n: Number(n), exp: now + ttlMs });
  return `${encoded}.${sign(encoded, secret)}`;
}

// True only when the signature is valid AND the scope, work order and
// photo number all match EXACTLY AND it has not expired. Anything else —
// including every malformed input — is false.
function verify(value, woId, n, secret, { now = Date.now() } = {}) {
  try {
    if (!value || !woId || !secret) return false;
    const str = String(value);
    const dot = str.indexOf(".");
    if (dot === -1) return false;
    const encoded = str.slice(0, dot);
    const signature = str.slice(dot + 1);
    if (!encoded || !signature) return false;
    const expected = sign(encoded, secret);
    const aBuf = Buffer.from(signature);
    const eBuf = Buffer.from(expected);
    if (aBuf.length !== eBuf.length || !crypto.timingSafeEqual(aBuf, eBuf)) return false;
    const payload = b64urlDecode(encoded);
    if (!payload || typeof payload !== "object") return false;
    if (payload.scope !== SCOPE) return false;
    if (String(payload.woId) !== String(woId)) return false;
    if (Number(payload.n) !== Number(n)) return false;
    if (!(Number(payload.exp) > now)) return false;
    return true;
  } catch {
    return false;
  }
}

// The path the email uses. Kept here so the route and every caller build
// it one way.
function pathFor(woId, n, value) {
  return `/api/photo-link/${encodeURIComponent(woId)}/${encodeURIComponent(n)}?s=${encodeURIComponent(value)}`;
}

module.exports = { SCOPE, DEFAULT_TTL_MS, mint, verify, pathFor };

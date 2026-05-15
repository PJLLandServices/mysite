// Anti-bot defense layer for public lead-intake endpoints. Five checks in
// cost order — the cheap ones (honeypot, time-trap) short-circuit before
// the per-IP rate-limit lookup and the outbound Turnstile verify call.
//
//   1. Honeypot     — `contact_website` field; any non-empty value is a
//                     silent 400. Real users never see the input.
//   2. Time-trap    — `_ts` hidden field carries Date.now() from form-
//                     render time. <2.5s rejects (bot autofill); >30 days
//                     rejects (stale token from a tab someone left open).
//   3. Rate-limit   — 5 submissions / 10 min sliding window per IP.
//                     Bounded in-memory Map with LRU eviction at 10k keys.
//   4. Email norm.  — Gmail dot-trick + plus-suffix collapsed for dedupe.
//                     Original kept on contact.email; canonical form is
//                     returned so the caller can stash it in
//                     contact.emailNormalized.
//   5. Turnstile    — Cloudflare Managed challenge. Only runs if
//                     TURNSTILE_SECRET_KEY is set (so local dev still
//                     works). Token comes in as `cfTurnstileResponse`.
//
// Every rejection writes a single line to server/data/bot-blocked.log
// (append-only, rotated at 5 MB). The log lives behind DATA_DIR so it's
// never served publicly. IPs are kept 30 days per the maintenance doc.
//
// Module is sync except for `checkSubmission`, which awaits the Turnstile
// fetch + the bot-blocked.log write. Callers wire it into the request
// handler BEFORE the heavyweight validateLead/notify path:
//
//   const verdict = await antiBot.checkSubmission({ body, ip, userAgent });
//   if (!verdict.ok) return sendJson(res, verdict.status, verdict.responseBody);
//   // verdict.normalizedEmail goes onto the lead record alongside contact.email.

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(SERVER_DIR, "data");
const LOG_FILE = path.join(DATA_DIR, "bot-blocked.log");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// Time-trap window. Bots autofill in ms; humans take seconds. 2.5s is the
// sweet spot — fast typers and password managers still pass; bots don't.
// The upper bound rejects forms loaded into long-lived browser tabs, which
// otherwise carry a Turnstile token that's expired anyway.
const MIN_FORM_TIME_MS = 2500;
const MAX_FORM_TIME_MS = 30 * 24 * 60 * 60 * 1000;

// Per-IP rate-limit. Window is sliding (we track first-event-in-window
// timestamp and a count). Cap 5/10min is generous for one household
// submitting from two devices but stops same-IP burst-spam dead.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const RATE_MAP_CAP = 10000;

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const ipBuckets = new Map();

function nowMs() { return Date.now(); }

// LRU-ish eviction: when we hit the cap, drop the bucket with the oldest
// windowStart. Map iteration is insertion-ordered in V8, but we re-insert
// on every record() so the "freshest" key floats to the back — meaning
// the first key in the iterator is the stalest. Bounded memory.
function recordIpHit(ip) {
  if (!ip) return { count: 0, windowStart: nowMs() };
  const now = nowMs();
  let bucket = ipBuckets.get(ip);
  if (bucket && now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = null;
  }
  if (!bucket) {
    bucket = { count: 0, windowStart: now };
  } else {
    ipBuckets.delete(ip);
  }
  bucket.count += 1;
  ipBuckets.set(ip, bucket);
  if (ipBuckets.size > RATE_MAP_CAP) {
    const oldestKey = ipBuckets.keys().next().value;
    if (oldestKey !== undefined) ipBuckets.delete(oldestKey);
  }
  return bucket;
}

function isOverLimit(bucket) {
  return bucket.count > RATE_LIMIT_MAX;
}

// Reset hook — exposed for test harnesses only. Production never calls.
function _resetForTests() {
  ipBuckets.clear();
}

// Gmail collapses dots in the local-part and ignores +suffix tags, so
// `kennybenny2004@gmail.com`, `k.enn.y.b.en.n.y2004@gmail.com`, and
// `kennybenny2004+spam@gmail.com` all route to the same inbox. We
// canonicalize for dedupe; the customer-visible field still holds the
// original spelling so we don't surprise them.
//
// Non-Gmail addresses get lower-cased only — every other provider treats
// dots and plus-suffixes as significant.
function normalizeEmailForDedupe(email) {
  if (!email || typeof email !== "string") return "";
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at < 1 || at === trimmed.length - 1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const stripped = local.split("+")[0].replace(/\./g, "");
    if (!stripped) return trimmed;
    return `${stripped}@gmail.com`;
  }
  return trimmed;
}

// Best-effort log rotation. If the current log is bigger than the cap,
// we rename it to .1 (overwriting any previous .1) before the next append.
// Single-tier rotation on purpose — the log is forensic, not regulatory,
// and bots-per-day is small enough that one rotated copy holds plenty of
// history. Throws are swallowed: a logging failure must NOT block the
// actual rejection path.
async function rotateIfNeeded() {
  try {
    const st = await fsp.stat(LOG_FILE);
    if (st.size < LOG_ROTATE_BYTES) return;
    const rotated = `${LOG_FILE}.1`;
    try { await fsp.unlink(rotated); } catch (_) { /* no prior rotation */ }
    await fsp.rename(LOG_FILE, rotated);
  } catch (_) {
    // File doesn't exist yet — no rotation needed.
  }
}

async function logBlocked({ ip, userAgent, reason, payload }) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await rotateIfNeeded();
    const snippet = (() => {
      try { return JSON.stringify(payload).slice(0, 500); }
      catch (_) { return "[unserializable]"; }
    })();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: ip || "",
      ua: (userAgent || "").slice(0, 240),
      reason,
      payload: snippet
    }) + "\n";
    await fsp.appendFile(LOG_FILE, line, "utf8");
  } catch (err) {
    // Forensics log is best-effort. A failure here must NOT cascade into
    // the rejection path — we still want to block the bot.
    // eslint-disable-next-line no-console
    console.warn("[anti-bot] log write failed:", err?.message || err);
  }
}

// Cloudflare Turnstile verify. Returns { ok: true } if the token is good,
// { ok: false } otherwise. Network or non-2xx errors fall through to
// { ok: false } — better to reject than to silently accept.
async function verifyTurnstile({ token, ip, secret }) {
  try {
    const params = new URLSearchParams();
    params.set("secret", secret);
    params.set("response", token);
    if (ip) params.set("remoteip", ip);
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    if (data && data.success === true) return { ok: true };
    return { ok: false, error: (data && data["error-codes"] && data["error-codes"].join(",")) || "unknown" };
  } catch (err) {
    return { ok: false, error: err?.message || "network" };
  }
}

// Pull the honeypot and time-trap values out of the body without caring
// where the caller put them. Supports both nested-inside-contact and
// top-level positioning so we don't constrain how each form structures
// its payload.
function readDefenseFields(body) {
  if (!body || typeof body !== "object") return { honeypot: "", ts: null, token: "" };
  const contact = (body.contact && typeof body.contact === "object") ? body.contact : {};
  const honeypot = String(body.contact_website || contact.contact_website || "").trim();
  const tsRaw = body._ts ?? contact._ts ?? null;
  const ts = (typeof tsRaw === "number" && Number.isFinite(tsRaw)) ? tsRaw
    : (typeof tsRaw === "string" && /^\d+$/.test(tsRaw)) ? Number(tsRaw)
    : null;
  const token = String(body.cfTurnstileResponse || body["cf-turnstile-response"] || "").trim();
  return { honeypot, ts, token };
}

// Build the JSON body returned to the client on rejection. Honeypot is
// silent on purpose (returning a discriminating error teaches the bot
// what to avoid next time). Everything else surfaces a friendly message
// with the phone number so a false-positive doesn't strand a real
// customer.
function rejectionResponse(reason) {
  const phone = "(905) 960-0181";
  switch (reason) {
    case "honeypot":
      return { status: 400, body: { ok: false, errors: [] } };
    case "time_trap_fast":
      return { status: 400, body: { ok: false, errors: [`Submission rejected. Please try again or call ${phone}.`] } };
    case "time_trap_stale":
      return { status: 400, body: { ok: false, errors: [`Your session expired. Please refresh the page and try again, or call ${phone}.`] } };
    case "rate_limit":
      return { status: 429, body: { ok: false, errors: [`Too many submissions from this network. If this is a mistake, please call ${phone}.`] } };
    case "turnstile_missing":
    case "turnstile_failed":
      return { status: 400, body: { ok: false, errors: [`We couldn't verify your submission. Please refresh and try again, or call ${phone}.`] } };
    default:
      return { status: 400, body: { ok: false, errors: [`Submission rejected. Please try again or call ${phone}.`] } };
  }
}

// Main entry point. `body` is the already-parsed JSON, `ip` and
// `userAgent` come from the request, `opts.skipTurnstile` lets the chat-
// widget path opt out (its multi-turn conversation is its own bot
// filter — a sophisticated chat-engaging bot has already cleared a
// higher bar than Turnstile would). Returns:
//   { ok: true, normalizedEmail }                     — pass
//   { ok: false, status, responseBody, reason }       — block
async function checkSubmission({ body, ip, userAgent, skipTurnstile = false }) {
  const { honeypot, ts, token } = readDefenseFields(body);

  // 1. Honeypot — cheapest check, runs first.
  if (honeypot) {
    await logBlocked({ ip, userAgent, reason: "honeypot", payload: body });
    const r = rejectionResponse("honeypot");
    return { ok: false, status: r.status, responseBody: r.body, reason: "honeypot" };
  }

  // 2. Time-trap. Missing `_ts` (null or 0) is allowed — older clients
  // and chat-widget pages that load before js/anti-bot.js bootstraps
  // send 0; we don't want to block them. Bots that ARE sending a real
  // timestamp trip on the bound check.
  if (typeof ts === "number" && ts > 0) {
    const elapsed = nowMs() - ts;
    if (elapsed < MIN_FORM_TIME_MS) {
      await logBlocked({ ip, userAgent, reason: "time_trap_fast", payload: body });
      const r = rejectionResponse("time_trap_fast");
      return { ok: false, status: r.status, responseBody: r.body, reason: "time_trap_fast" };
    }
    if (elapsed > MAX_FORM_TIME_MS) {
      await logBlocked({ ip, userAgent, reason: "time_trap_stale", payload: body });
      const r = rejectionResponse("time_trap_stale");
      return { ok: false, status: r.status, responseBody: r.body, reason: "time_trap_stale" };
    }
  }

  // 3. Rate-limit. We record EVERY attempt (including ones we ultimately
  // bounce on Turnstile below) so a bot can't burn through Turnstile
  // verifications by failing them in a tight loop.
  const bucket = recordIpHit(ip);
  if (isOverLimit(bucket)) {
    await logBlocked({ ip, userAgent, reason: "rate_limit", payload: body });
    const r = rejectionResponse("rate_limit");
    return { ok: false, status: r.status, responseBody: r.body, reason: "rate_limit" };
  }

  // 4. Turnstile. Skipped when TURNSTILE_SECRET_KEY isn't set (so local
  // dev still works without a Cloudflare account) or when the caller
  // signals a UX path that already vetted the user (e.g. the AI-chat
  // session, which itself required multiple back-and-forth turns).
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (secret && !skipTurnstile) {
    if (!token) {
      await logBlocked({ ip, userAgent, reason: "turnstile_missing", payload: body });
      const r = rejectionResponse("turnstile_missing");
      return { ok: false, status: r.status, responseBody: r.body, reason: "turnstile_missing" };
    }
    const verdict = await verifyTurnstile({ token, ip, secret });
    if (!verdict.ok) {
      await logBlocked({
        ip, userAgent, reason: "turnstile_failed",
        payload: { ...body, _turnstileError: verdict.error }
      });
      const r = rejectionResponse("turnstile_failed");
      return { ok: false, status: r.status, responseBody: r.body, reason: "turnstile_failed" };
    }
  }

  // 5. Email normalization — informational, not a reject path. Callers
  // attach this to the lead record so future dedupe can collapse
  // Gmail-dot-trick variants of the same underlying inbox.
  const rawEmail = body?.contact?.email || "";
  const normalizedEmail = normalizeEmailForDedupe(rawEmail);

  return { ok: true, normalizedEmail };
}

module.exports = {
  checkSubmission,
  normalizeEmailForDedupe,
  // Test-only surface area — production code shouldn't reach for these.
  _resetForTests,
  _MIN_FORM_TIME_MS: MIN_FORM_TIME_MS,
  _RATE_LIMIT_MAX: RATE_LIMIT_MAX,
  _RATE_WINDOW_MS: RATE_WINDOW_MS
};

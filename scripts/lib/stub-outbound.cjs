// scripts/lib/stub-outbound.cjs
//
// Preloaded (`node --require`) into a server a test boots. Nothing leaves
// the machine: every email, SMS and Stripe call is written to the JSONL
// file at $PJL_STUB_OUTBOX instead, and any other outbound host is
// refused (geocoding and distance already fail open by design).
//
//   email  → nodemailer.createTransport() returns a transport that logs
//   sms    → fetch("https://api.twilio.com/…") answers a fake 201
//   stripe → fetch("https://api.stripe.com/…") answers a fake object
//
// TRIPWIRES (Phase 1 E2E, 2026-09-26). The stub refuses to load at all —
// the server never starts — when anything in the environment could reach
// the real business:
//
//   * a production host (pjllandservices.com, *.onrender.com) anywhere in
//     the environment, e.g. PUBLIC_BASE_URL or GMAIL_USER
//   * a live Stripe key (sk_live_ / rk_live_ / pk_live_), or a Stripe key
//     that isn't a test key
//   * a Twilio, Gmail, QuickBooks, Google, Anthropic, captcha or webhook
//     credential that isn't a stub
//   * a .env file beside the server it is about to boot (server.js loads
//     one at boot; on a machine with real keys in it, every key the
//     harness didn't set would come from there)
//
// And below fetch, every TCP/TLS socket to a non-loopback address is
// refused, so http.request, https.request, SMTP or any library with its
// own client is caught too — not just fetch.
//
// Stripe outcomes a test can set per intent (or "*" for every call), in
// $PJL_STUB_OUTBOX.stripe as JSONL {id, mode}:
//   succeeded    the customer's card was approved (also: $OUTBOX.succeeded)
//   declined     requires_payment_method + last_payment_error card_declined
//   processing   the reader never finished (a Tap to Pay that timed out)
//   unreachable  the request never reaches Stripe (network timeout)
//
// Test-only. Never required by the server itself.

const fs = require("node:fs");
const OUTBOX = process.env.PJL_STUB_OUTBOX;
if (!OUTBOX) throw new Error("stub-outbound: PJL_STUB_OUTBOX is not set");

function log(entry) {
  fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// ---- tripwires (scripts/lib/test-tripwires.cjs) ---------------------
const { unsafeEnvironment, PRODUCTION_HOST } = require("./test-tripwires.cjs");
{
  const problems = unsafeEnvironment(process.env, process.argv[1]);
  if (problems.length) {
    log({ channel: "tripwire", problems });
    throw new Error(`stub-outbound: refusing to start a test server:\n  - ${problems.join("\n  - ")}`);
  }
}

// Below fetch: no socket to anywhere but this machine.
const net = require("node:net");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = null;
  if (first && typeof first === "object") host = first.path ? null : String(first.host || "localhost");
  else if (typeof first === "number" || /^\d+$/.test(String(first))) host = typeof args[1] === "string" ? args[1] : "localhost";
  if (host !== null && !LOOPBACK.has(host)) {
    log({ channel: "refused", via: "socket", host, production: PRODUCTION_HOST.test(host) });
    const err = new Error(`stub-outbound: socket to ${host} refused in tests`);
    err.code = "ECONNREFUSED";
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
};

// ---- email ----------------------------------------------------------
const nodemailer = require("nodemailer");
nodemailer.createTransport = function createStubTransport() {
  return {
    sendMail: async (msg) => {
      log({ channel: "email", to: String(msg.to || ""), cc: msg.cc || "", subject: String(msg.subject || ""),
        text: String(msg.text || ""), html: String(msg.html || "") });
      return { messageId: `<stub-${Date.now()}-${Math.random().toString(36).slice(2)}@stub>`, accepted: [msg.to] };
    },
    verify: async () => true,
    close: () => {}
  };
};

// ---- sms + stripe + everything else ----------------------------------
const realFetch = globalThis.fetch;
let stripeSeq = 0;
const intents = new Map();
// The last mode a test set for this intent id (or "*"), if any.
function modeFor(id) {
  let mode = null;
  try {
    for (const line of fs.readFileSync(`${OUTBOX}.stripe`, "utf8").split("\n")) {
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id === id) mode = m.mode;
    }
  } catch {}
  return mode;
}
function formToObject(body) {
  const out = {};
  if (!body) return out;
  for (const [k, v] of new URLSearchParams(String(body))) out[k] = v;
  return out;
}
globalThis.fetch = async function stubFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.hostname === "api.twilio.com") {
    const form = formToObject(init.body);
    log({ channel: "sms", to: form.To || "", body: form.Body || "" });
    return new Response(JSON.stringify({ sid: `SMstub${Date.now()}`, status: "queued" }),
      { status: 201, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "api.stripe.com") {
    const form = formToObject(init.body);
    const method = init.method || "GET";
    const existingId = url.pathname.match(/payment_intents\/(pi_[A-Za-z0-9_]+)/)?.[1] || null;
    if (modeFor("*") === "unreachable" || (existingId && modeFor(existingId) === "unreachable")) {
      log({ channel: "stripe", method, path: url.pathname, form, unreachable: true });
      throw new TypeError("fetch failed (stub: Stripe unreachable — connect ETIMEDOUT)");
    }
    log({ channel: "stripe", method, path: url.pathname, form });
    let obj = existingId ? intents.get(existingId) : null;
    if (!obj) {
      stripeSeq += 1;
      const id = existingId || `pi_stub_${stripeSeq}`;
      obj = { id, object: "payment_intent", status: "requires_payment_method",
        amount: Number(form.amount || 0), currency: form.currency || "cad",
        client_secret: `${id}_secret_stub`, metadata: {} };
      for (const [k, v] of Object.entries(form)) {
        const m = k.match(/^metadata\[(.+)\]$/); if (m) obj.metadata[m[1]] = v;
      }
      obj.payment_method_types = Object.keys(form).filter((k) => /^payment_method_types\[\d+\]$/.test(k)).map((k) => form[k]);
      intents.set(id, obj);
    }
    if (/\/cancel$/.test(url.pathname)) obj.status = "canceled";
    // A test "confirms" an intent (the customer tapping Pay) by listing its
    // id in $PJL_STUB_OUTBOX.succeeded — the way Stripe would report it.
    let succeeded = [];
    try { succeeded = fs.readFileSync(`${OUTBOX}.succeeded`, "utf8").split("\n"); } catch {}
    const mode = modeFor(obj.id);
    if (mode === "declined" && obj.status !== "canceled" && obj.status !== "succeeded") {
      obj.status = "requires_payment_method";
      obj.last_payment_error = { type: "card_error", code: "card_declined", decline_code: "generic_decline",
        message: "Your card was declined.", payment_method: { card: { brand: "visa", last4: "0002" } } };
    }
    if (mode === "processing" && obj.status !== "canceled" && obj.status !== "succeeded") obj.status = "processing";
    if ((succeeded.includes(obj.id) || mode === "succeeded") && obj.status !== "canceled") {
      obj.status = "succeeded";
      obj.latest_charge = { id: `ch_${obj.id}`, status: "succeeded",
        // An in-person intent reports its card the way Stripe does for one.
        payment_method_details: (obj.payment_method_types || []).includes("card_present")
          ? { type: "card_present", card_present: { brand: "visa", last4: "4242" } }
          : { card: { brand: "visa", last4: "4242", checks: {} } } };
    }
    return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  }
  log({ channel: "refused", url: url.href, host: url.hostname, production: PRODUCTION_HOST.test(url.hostname) });
  throw new TypeError(`stub-outbound: outbound request to ${url.hostname} refused in tests`);
};

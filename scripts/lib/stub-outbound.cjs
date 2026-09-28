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
// Email delivery a test can make fail: one recipient address per line in
// $PJL_STUB_OUTBOX.email-fail (sendMail then rejects, as a bounce would).
//
// Stripe outcomes a test can set per intent (or "*" for every call), in
// $PJL_STUB_OUTBOX.stripe as JSONL {id, mode}:
//   succeeded    the customer's card was approved (also: $OUTBOX.succeeded)
//   canceled     the intent was cancelled at Stripe (never chargeable again)
//   declined     requires_payment_method + last_payment_error card_declined
//   processing   the reader never finished (a Tap to Pay that timed out)
//   unreachable  the request never reaches Stripe (network timeout)
//
// QuickBooks Accounting, SANDBOX host only (sandbox-quickbooks.api.intuit.com;
// the production host stays refused). A test that sets QB_CLIENT_ID /
// QB_CLIENT_SECRET to "stub" and writes a stub token file gets a small
// QuickBooks whose payments live in $PJL_STUB_OUTBOX.qb-store.json, so they
// survive a server restart the way QuickBooks' own would:
//   GET  …/invoice/<id>   → the invoice with a CustomerRef, and LinkedTxn
//                           listing every stub payment applied to it
//   GET  …/payment/<id>   → that payment
//   POST …/payment[?requestid=…] → a created Payment, logged as channel
//        "quickbooks". A repeat of a requestid already seen answers the
//        ORIGINAL response and creates nothing — Intuit's documented
//        requestid behaviour.
// $PJL_STUB_OUTBOX.quickbooks holds comma-separated modes:
//   fail              POST …/payment answers 500 and creates nothing
//   accept-drop       POST …/payment creates the payment, then the
//                     response is lost (the request "times out")
//   ignore-requestid  requestid is not honoured (a second payment is made)
//   no-linkedtxn      the invoice read omits LinkedTxn (a blind lookup)
//   lookup-fail       GET …/payment/<id> fails (the network drops)
// Anything else it does not model answers 400.
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
      // A test can make delivery to an address FAIL, the way a bounced
      // mailbox or an SMTP outage would: one address per line in
      // $PJL_STUB_OUTBOX.email-fail.
      let failing = [];
      try { failing = fs.readFileSync(`${OUTBOX}.email-fail`, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch {}
      if (failing.includes(String(msg.to || "").trim())) {
        log({ channel: "email-failed", to: String(msg.to || ""), subject: String(msg.subject || "") });
        throw new Error("stub: 550 mailbox unavailable");
      }
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
// Intent ids never repeat for the life of a test, even across a server
// restart (srv.restart): real Stripe ids are unique, and a reused one would
// read as the same payment everywhere it is used as a key.
let stripeSeq = 0;
try { stripeSeq = Number(fs.readFileSync(`${OUTBOX}.stripe-seq`, "utf8")) || 0; } catch {}
const intents = new Map();
// The last mode a test set for this intent id (or "*"), if any.
// ---- the QuickBooks stub (see the header) -------------------------------
const QB_STORE = `${OUTBOX}.qb-store.json`;
function qbStore() {
  try { return JSON.parse(fs.readFileSync(QB_STORE, "utf8")); } catch { return { seq: 0, payments: [], requests: {} }; }
}
function qbModes() {
  try { return new Set(fs.readFileSync(`${OUTBOX}.quickbooks`, "utf8").split(",").map((m) => m.trim()).filter(Boolean)); } catch { return new Set(); }
}
function quickbooksStub(url, init) {
  const method = init.method || "GET";
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = { _raw: String(init.body).slice(0, 400) }; }
  const modes = qbModes();
  const store = qbStore();
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const requestid = url.searchParams.get("requestid");
  const invoiceGet = url.pathname.match(/^\/v3\/company\/[^/]+\/invoice\/([^/]+)$/);
  if (method === "GET" && invoiceGet) {
    const id = decodeURIComponent(invoiceGet[1]);
    log({ channel: "quickbooks", method, path: url.pathname });
    const linked = modes.has("no-linkedtxn") ? [] : store.payments
      .filter((p) => (p.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === id)))
      .map((p) => ({ TxnId: p.Id, TxnType: "Payment" }));
    return json(200, { Invoice: { Id: id, SyncToken: "0", CustomerRef: { value: "qbcust_stub" }, LinkedTxn: linked } });
  }
  const paymentGet = url.pathname.match(/^\/v3\/company\/[^/]+\/payment\/([^/]+)$/);
  if (method === "GET" && paymentGet) {
    log({ channel: "quickbooks", method, path: url.pathname, failed: modes.has("lookup-fail") });
    if (modes.has("lookup-fail")) throw new TypeError("fetch failed (stub: QuickBooks lookup dropped)");
    const p = store.payments.find((x) => x.Id === decodeURIComponent(paymentGet[1]));
    return p ? json(200, { Payment: p }) : json(400, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } });
  }
  if (method === "POST" && /^\/v3\/company\/[^/]+\/payment$/.test(url.pathname)) {
    if (requestid && store.requests[requestid] && !modes.has("ignore-requestid")) {
      log({ channel: "quickbooks", method, path: url.pathname, requestid, body, deduped: true });
      return json(200, store.requests[requestid]);
    }
    const failing = modes.has("fail");
    log({ channel: "quickbooks", method, path: url.pathname, requestid, body, failed: failing, dropped: !failing && modes.has("accept-drop") });
    if (failing) return json(500, { Fault: { Error: [{ Message: "stub: QuickBooks unavailable", code: "500" }] } });
    store.seq += 1;
    const payment = { Id: `qbpay_stub_${store.seq}`, TotalAmt: Number(body?.TotalAmt), CustomerRef: body?.CustomerRef, PrivateNote: body?.PrivateNote || "", Line: body?.Line || [] };
    store.payments.push(payment);
    if (requestid) store.requests[requestid] = { Payment: payment };
    fs.writeFileSync(QB_STORE, JSON.stringify(store));
    if (modes.has("accept-drop")) throw new TypeError("fetch failed (stub: QuickBooks accepted the payment, the response was lost)");
    return json(200, { Payment: payment });
  }
  log({ channel: "quickbooks", method, path: url.pathname, body, unmodelled: true });
  return json(400, { Fault: { Error: [{ Message: "stub: not modelled", code: "400" }] } });
}

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
    // The Idempotency-Key is logged so a test can see which retry key a
    // create used (the stub itself does not replay keys the way Stripe does).
    log({ channel: "stripe", method, path: url.pathname, form, idempotencyKey: init.headers?.["Idempotency-Key"] || null });
    // Terminal (Tap to Pay): the reader's connection token and its one
    // Location, the shapes Stripe answers with.
    if (url.pathname === "/v1/terminal/connection_tokens") {
      return new Response(JSON.stringify({ object: "terminal.connection_token", secret: `pst_test_stub_${Date.now()}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/v1/terminal/locations") {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "tml_stub", object: "terminal.location", display_name: "PJL truck (stub)" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    let obj = existingId ? intents.get(existingId) : null;
    if (!obj) {
      stripeSeq += 1;
      fs.writeFileSync(`${OUTBOX}.stripe-seq`, String(stripeSeq));
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
    // Stripe (or the reader) cancelled it — e.g. a Tap to Pay collection abandoned.
    if (mode === "canceled" && obj.status !== "succeeded") obj.status = "canceled";
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
  if (url.hostname === "sandbox-quickbooks.api.intuit.com") return quickbooksStub(url, init);
  log({ channel: "refused", url: url.href, host: url.hostname, production: PRODUCTION_HOST.test(url.hostname) });
  throw new TypeError(`stub-outbound: outbound request to ${url.hostname} refused in tests`);
};

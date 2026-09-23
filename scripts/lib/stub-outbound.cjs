// scripts/lib/stub-outbound.cjs
//
// Preloaded (`node --require`) into a server a test boots. Nothing leaves
// the machine: every email, SMS and Stripe call is written to the JSONL
// file at $PJL_STUB_OUTBOX instead, and any other outbound HTTP host is
// refused (geocoding and distance already fail open by design).
//
//   email  → nodemailer.createTransport() returns a transport that logs
//   sms    → fetch("https://api.twilio.com/…") answers a fake 201
//   stripe → fetch("https://api.stripe.com/…") answers a fake object
//
// Test-only. Never required by the server itself.

const fs = require("node:fs");
const OUTBOX = process.env.PJL_STUB_OUTBOX;
if (!OUTBOX) throw new Error("stub-outbound: PJL_STUB_OUTBOX is not set");

function log(entry) {
  fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

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
    log({ channel: "stripe", method: init.method || "GET", path: url.pathname, form });
    stripeSeq += 1;
    const id = url.pathname.match(/payment_intents\/(pi_[A-Za-z0-9_]+)/)?.[1] || `pi_stub_${stripeSeq}`;
    const obj = {
      id, object: "payment_intent", status: "requires_payment_method",
      amount: Number(form.amount || 0), currency: form.currency || "cad",
      client_secret: `${id}_secret_stub`, metadata: {}
    };
    for (const [k, v] of Object.entries(form)) {
      const m = k.match(/^metadata\[(.+)\]$/); if (m) obj.metadata[m[1]] = v;
    }
    return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  }
  log({ channel: "refused", url: url.href });
  throw new TypeError(`stub-outbound: outbound request to ${url.hostname} refused in tests`);
};

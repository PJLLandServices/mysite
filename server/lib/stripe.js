// Stripe Payments — the card rail for /pay/invoice/:id (Stripe migration,
// Jul 2026). Replaces QuickBooks Payments as the processor; QuickBooks
// remains the ledger. After a Stripe payment succeeds the server still
// creates a QBO Payment record against the pushed invoice, so the books
// close exactly as they did before — only the money path changed.
//
// NO SDK DEPENDENCY. Stripe's Node library is not installed and must not
// be: the "no new dependency, no build step" constraint still holds. This
// module speaks the REST API directly over `fetch`. Two things to know if
// you have only ever used the SDK:
//
//   1. Request bodies are **form-encoded**, not JSON, and nested objects
//      use bracket notation (`metadata[invoiceId]=I-2026-0044`).
//   2. Amounts are integer minor units — cents — same as the QB Payments
//      code this replaces, so `amountCents` flows through unchanged.
//
// PCI scope is unchanged and still SAQ-A-EP (Hard Rule 23): the card is
// entered into a Stripe-hosted iframe (Payment Element) and confirmed
// browser-side against Stripe. PAN, CVC and expiry never reach this
// process. This module only ever handles PaymentIntent ids, which are
// opaque references.

const crypto = require("node:crypto");

const API_BASE = "https://api.stripe.com/v1";

// ---- Configuration ----------------------------------------------------
// STRIPE_SECRET_KEY       sk_live_… / sk_test_… — server only, never shipped.
// STRIPE_PUBLISHABLE_KEY  pk_live_… / pk_test_… — safe in the browser.
// STRIPE_WEBHOOK_SECRET   whsec_…  — signature key for /api/webhooks/stripe.
// STRIPE_API_VERSION      optional pin (e.g. "2025-06-30.basil"). Left
//                         UNSET by default so the account's own default
//                         version applies: pinning a version string this
//                         codebase cannot verify against the live account
//                         would fail every request at once. Set it once
//                         you have confirmed a version in the dashboard.
function secretKey() { return process.env.STRIPE_SECRET_KEY || ""; }
function publishableKey() { return process.env.STRIPE_PUBLISHABLE_KEY || ""; }
function webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ""; }

function isConfigured() { return Boolean(secretKey() && publishableKey()); }

// Live vs test is derived from the key prefix, never from a separate env
// var that could disagree with it. Surfaced so the pay page can show a
// test-mode banner and so logs are unambiguous about which account moved.
function isLiveMode() { return secretKey().startsWith("sk_live_"); }

// Guard against the classic misconfiguration: a live secret key paired
// with a test publishable key (or vice versa). The symptom otherwise is
// an opaque "No such payment_intent" at confirm time, long after the
// customer has typed their card in.
function keyModeMismatch() {
  if (!isConfigured()) return false;
  const secretLive = secretKey().startsWith("sk_live_");
  const pubLive = publishableKey().startsWith("pk_live_");
  return secretLive !== pubLive;
}

// ---- Form encoding ----------------------------------------------------
// Stripe's bracket notation: { metadata: { invoiceId: "I-1" } } becomes
// `metadata[invoiceId]=I-1`. Null/undefined values are dropped rather
// than sent as the string "null".
function encodeForm(obj, prefix = "", params = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item == null) return;
        if (typeof item === "object") encodeForm(item, `${field}[${i}]`, params);
        else params.append(`${field}[${i}]`, String(item));
      });
    } else if (typeof value === "object") {
      encodeForm(value, field, params);
    } else {
      params.append(field, String(value));
    }
  }
  return params;
}

// ---- Structured failure ----------------------------------------------
// Mirrors the shape `quickbooks.chargeCard` throws, so the route layer
// records and maps both processors through one code path. `err.message`
// is operator-facing and must never be shown to a customer — server.js
// maps `errorCode` / `declineCode` to customer copy.
function paymentFailure(message, detail = {}) {
  const err = new Error(message);
  err.isPaymentFailure = true;
  err.processor = "stripe";
  // Stripe's `code` ("card_declined", "expired_card", …) and, when the
  // issuer supplied one, the finer-grained `decline_code`
  // ("insufficient_funds", "incorrect_zip", …). The decline_code is the
  // interesting one for AVS: "incorrect_zip" is the address failure.
  err.errorCode = detail.errorCode || null;
  err.declineCode = detail.declineCode || null;
  err.errorType = detail.errorType || null;
  err.errorMessage = detail.errorMessage || null;
  // Stripe's request id (`req_…`) — the equivalent of intuit_tid, and
  // what Stripe support asks for.
  err.processorRef = detail.processorRef || null;
  err.httpStatus = Number.isFinite(Number(detail.httpStatus)) ? Number(detail.httpStatus) : null;
  err.paymentIntentId = detail.paymentIntentId || null;
  err.chargeId = detail.chargeId || null;
  err.cardBrand = detail.cardBrand || null;
  err.cardLast4 = detail.cardLast4 || null;
  err.avsStreet = detail.avsStreet || null;
  err.avsZip = detail.avsZip || null;
  err.cvcMatch = detail.cvcMatch || null;
  return err;
}

async function stripeRequest(method, path, body = null, { idempotencyKey = null } = {}) {
  if (!secretKey()) {
    throw paymentFailure("Stripe is not configured — set STRIPE_SECRET_KEY in Render env vars.");
  }
  if (keyModeMismatch()) {
    throw paymentFailure("Stripe key mismatch — STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are from different modes (one live, one test).");
  }
  const headers = { Authorization: `Bearer ${secretKey()}` };
  const version = process.env.STRIPE_API_VERSION || "";
  if (version) headers["Stripe-Version"] = version;
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  // Idempotency-Key makes CREATE calls safe to repeat. Note this protects
  // the PaymentIntent *creation*, not the capture — Hard Rule 22 still
  // stands, and nothing in this module retries on its own.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let r;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? encodeForm(body).toString() : undefined
    });
  } catch (netErr) {
    throw paymentFailure(`Stripe request failed to reach the API: ${netErr.message}`, {
      errorCode: "network_error"
    });
  }

  const requestId = r.headers.get("request-id") || null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = data?.error || {};
    const facts = cardFactsFrom(e.payment_intent?.latest_charge || e.charge || null);
    throw paymentFailure(
      `Stripe ${method} ${path} failed (HTTP ${r.status}): ${e.message || "unknown error"}`,
      {
        ...facts,
        errorCode: e.code || null,
        declineCode: e.decline_code || null,
        errorType: e.type || null,
        errorMessage: String(e.message || "").slice(0, 500),
        processorRef: requestId,
        httpStatus: r.status,
        paymentIntentId: e.payment_intent?.id || null,
        chargeId: typeof e.payment_intent?.latest_charge === "string"
          ? e.payment_intent.latest_charge
          : e.payment_intent?.latest_charge?.id || null
      }
    );
  }
  return { data, requestId };
}

// Pull card identity + verification results off an expanded Charge.
// Stripe reports AVS as `checks.address_line1_check` /
// `checks.address_postal_code_check` with values "pass" | "fail" |
// "unavailable" | "unchecked" — the direct analogue of Intuit's
// avsStreet / avsZip, and the reason the billing-address work carried
// over from the QuickBooks integration unchanged.
function cardFactsFrom(charge) {
  if (!charge || typeof charge !== "object") {
    return { cardBrand: null, cardLast4: null, avsStreet: null, avsZip: null, cvcMatch: null };
  }
  const card = charge.payment_method_details?.card || {};
  const checks = card.checks || {};
  const last4 = String(card.last4 || "");
  return {
    cardBrand: card.brand || null,
    cardLast4: /^\d{4}$/.test(last4) ? last4 : null,
    avsStreet: checks.address_line1_check || null,
    avsZip: checks.address_postal_code_check || null,
    cvcMatch: checks.cvc_check || null
  };
}

// ---- PaymentIntents ---------------------------------------------------

// Create the PaymentIntent the browser's Payment Element confirms
// against. Returns the intent (its `client_secret` is what the browser
// needs) — the client secret is scoped to this one intent and is safe to
// hand to the token-bearing customer, but must not be logged.
//
// `idempotencyKey` is derived from invoice + amount by the caller, so a
// double-tap on a flaky connection reuses one intent instead of minting
// two chargeable ones.
async function createPaymentIntent({
  amountCents,
  currency = "CAD",
  invoiceId,
  customerEmail = "",
  description = "",
  idempotencyKey = null
}) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw paymentFailure("Payment amount must be a positive number of cents.");
  }
  // Stripe wants a lowercase ISO code; the invoice stores "CAD".
  const body = {
    amount: Math.round(amountCents),
    currency: String(currency || "CAD").toLowerCase(),
    // EXPLICIT method list, deliberately not automatic_payment_methods.
    // The first live intent (Jul 2026) proved that "automatic" pulls in
    // whatever the Stripe account has enabled — which included Klarna, a
    // buy-now-pay-later redirect flow nobody chose to offer on PJL
    // invoices. Redirect methods also route the customer back through
    // the thanks page without the confirm POST, leaving the webhook as
    // the only finalizer. Card only: it carries Apple Pay / Google Pay
    // once the domain is verified with Stripe. Link was offered briefly
    // and removed at Patrick's request (Jul 2026) — its "save my
    // information" block dominated the mobile form. Must stay in sync
    // with `paymentMethodTypes` in pay.js — the Element and the intent
    // have to agree or confirmPayment errors mid-flow. Adding a method
    // back (Link, Klarna, ACH/PAD) is a deliberate two-file change plus
    // a thanks-page verification pass, not a toggle.
    payment_method_types: ["card"],
    description: description || (invoiceId ? `PJL invoice ${invoiceId}` : undefined),
    // metadata is how a Stripe dashboard row or payout line is traced
    // back to a PJL invoice during reconciliation.
    metadata: { invoiceId: invoiceId || "", source: "pjl-pay-page" }
  };
  if (customerEmail) body.receipt_email = customerEmail;
  const { data } = await stripeRequest("POST", "/payment_intents", body, { idempotencyKey });
  return data;
}

// Re-read an intent from Stripe with its charge expanded. This is the
// ONLY acceptable source of truth for "did the customer actually pay" —
// the browser's word is not evidence, because anyone holding the payment
// token can POST whatever they like to the confirm endpoint.
async function retrievePaymentIntent(paymentIntentId) {
  if (!paymentIntentId || typeof paymentIntentId !== "string") {
    throw paymentFailure("Missing Stripe payment intent id.");
  }
  const { data, requestId } = await stripeRequest(
    "GET",
    `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`
  );
  return { intent: data, requestId };
}

// Cancel an intent that will never be paid — used when an invoice's
// amount changed underneath an open intent, so a stale client secret
// can't be confirmed for the old total.
async function cancelPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const { data } = await stripeRequest(
    "POST",
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`
  );
  return data;
}

// Flatten an intent into the fields the invoice attempt log records.
function summarizeIntent(intent, requestId = null) {
  const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
    ? intent.latest_charge
    : null;
  const lastError = intent?.last_payment_error || null;
  return {
    paymentIntentId: intent?.id || null,
    status: intent?.status || null,
    amountCents: Number.isFinite(Number(intent?.amount)) ? Number(intent.amount) : null,
    currency: (intent?.currency || "").toUpperCase() || null,
    chargeId: charge?.id || (typeof intent?.latest_charge === "string" ? intent.latest_charge : null),
    processorRef: requestId,
    errorCode: lastError?.code || null,
    declineCode: lastError?.decline_code || null,
    errorMessage: lastError?.message ? String(lastError.message).slice(0, 500) : null,
    ...cardFactsFrom(charge)
  };
}

// ---- Webhook signature verification -----------------------------------
// Stripe signs with `Stripe-Signature: t=<unix>,v1=<hex hmac>`, where the
// signed payload is `${t}.${rawBody}` and the key is the endpoint's
// whsec_. The RAW bytes matter — re-serializing parsed JSON changes them
// and the signature will never match.
//
// Unlike the QuickBooks webhook this replaces (which had a standing TODO
// and trusted its payload outright), this one refuses anything it cannot
// verify. A webhook that flips invoices to paid is not somewhere to leave
// an unauthenticated path open.
function verifyWebhookSignature(rawBody, signatureHeader, { toleranceSeconds = 300, nowSeconds = null } = {}) {
  const secret = webhookSecret();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set — refusing to trust an unverified webhook.");
  const parts = String(signatureHeader || "")
    .split(",")
    .map((p) => p.split("=", 2))
    .filter((p) => p.length === 2);
  const timestamp = parts.find((p) => p[0].trim() === "t")?.[1];
  const signatures = parts.filter((p) => p[0].trim() === "v1").map((p) => p[1]);
  if (!timestamp || !signatures.length) throw new Error("Malformed or missing Stripe-Signature header.");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const matched = signatures.some((sig) => {
    const buf = Buffer.from(String(sig).trim(), "utf8");
    return buf.length === expectedBuf.length && crypto.timingSafeEqual(buf, expectedBuf);
  });
  if (!matched) throw new Error("Stripe webhook signature mismatch.");

  // Replay window. Stripe's own libraries default to 5 minutes.
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : nowSeconds;
  if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
    throw new Error("Stripe webhook timestamp is outside the replay tolerance.");
  }
  return JSON.parse(rawBody);
}

// ---- Terminal (Tap to Pay on iPhone) ---------------------------------
//
// A connection token is what the Terminal SDK on the phone trades for the
// right to talk to Stripe directly. It is SHORT-LIVED and scoped to
// Terminal — it is not the secret key and cannot be used to move money on
// its own — but it is still minted here, server-side, and never derived
// on the device.
//
// This is the ONLY place the field app is allowed near Stripe, and the
// reason the "app never talks to Stripe" rule survives Tap to Pay: card
// data goes from the customer's card to Apple's secure element to Stripe.
// It never reaches our code, which is what keeps this out of PCI scope.
//
// Requires Terminal to be enabled on the account. Until Stripe switches it
// on this returns their error verbatim rather than a guess.
async function createTerminalConnectionToken() {
  const { data } = await stripeRequest("POST", "/terminal/connection_tokens", {});
  if (!data || !data.secret) {
    throw paymentFailure("Stripe returned no connection token secret.");
  }
  return { secret: data.secret, location: data.location || null };
}

module.exports = {
  isConfigured,
  isLiveMode,
  keyModeMismatch,
  publishableKey,
  webhookSecret,
  createPaymentIntent,
  retrievePaymentIntent,
  cancelPaymentIntent,
  createTerminalConnectionToken,
  summarizeIntent,
  cardFactsFrom,
  verifyWebhookSignature,
  // Exported for the unit tests in scripts/test-stripe.mjs.
  encodeForm,
  paymentFailure
};

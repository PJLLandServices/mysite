// Tests for server/lib/stripe.js — the pure parts: form encoding,
// webhook signature verification, intent summarization, card facts.
// No network, no keys. Wired into `npm run build:check` alongside the
// other test-*.mjs scripts.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const stripe = require("../server/lib/stripe.js");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${label}`);
}

// ---- encodeForm --------------------------------------------------------
{
  const params = stripe.encodeForm({
    amount: 129781,
    currency: "cad",
    automatic_payment_methods: { enabled: true },
    metadata: { invoiceId: "I-2026-0044", source: "pjl-pay-page" },
    skipped: null
  });
  const s = params.toString();
  assert(s.includes("amount=129781"), "encodeForm: flat number");
  assert(s.includes("automatic_payment_methods%5Benabled%5D=true"), "encodeForm: nested bracket notation");
  assert(s.includes("metadata%5BinvoiceId%5D=I-2026-0044"), "encodeForm: metadata bracket");
  assert(!s.includes("skipped"), "encodeForm: null dropped, not sent as 'null'");
}
{
  const params = stripe.encodeForm({ expand: ["latest_charge", "customer"] });
  const s = decodeURIComponent(params.toString());
  assert(s.includes("expand[0]=latest_charge") && s.includes("expand[1]=customer"), "encodeForm: arrays index");
}

// ---- verifyWebhookSignature --------------------------------------------
{
  const secret = "whsec_testsecret";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  const t = 1_753_800_000;
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");

  const ok = stripe.verifyWebhookSignature(body, `t=${t},v1=${sig}`, { nowSeconds: t + 10 });
  assert(ok?.id === "evt_1", "webhook: valid signature parses event");

  let threw = false;
  try { stripe.verifyWebhookSignature(body, `t=${t},v1=${"0".repeat(64)}`, { nowSeconds: t + 10 }); }
  catch { threw = true; }
  assert(threw, "webhook: wrong signature rejected");

  threw = false;
  try { stripe.verifyWebhookSignature(body, `t=${t},v1=${sig}`, { nowSeconds: t + 3600 }); }
  catch { threw = true; }
  assert(threw, "webhook: stale timestamp rejected (replay)");

  threw = false;
  try { stripe.verifyWebhookSignature(body + " ", `t=${t},v1=${sig}`, { nowSeconds: t + 10 }); }
  catch { threw = true; }
  assert(threw, "webhook: byte-changed body rejected");

  // Multiple v1 entries — Stripe sends several during secret rotation.
  const ok2 = stripe.verifyWebhookSignature(body, `t=${t},v1=${"f".repeat(64)},v1=${sig}`, { nowSeconds: t + 10 });
  assert(ok2?.id === "evt_1", "webhook: any matching v1 among several passes");

  threw = false;
  try {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    stripe.verifyWebhookSignature(body, `t=${t},v1=${sig}`, { nowSeconds: t + 10 });
  } catch { threw = true; }
  assert(threw, "webhook: refuses to verify with no secret configured");
}

// ---- summarizeIntent / cardFactsFrom ------------------------------------
{
  const intent = {
    id: "pi_123",
    status: "succeeded",
    amount: 129781,
    currency: "cad",
    metadata: { invoiceId: "I-2026-0044" },
    latest_charge: {
      id: "ch_456",
      payment_method_details: {
        card: {
          brand: "amex",
          last4: "1005",
          checks: {
            address_line1_check: "pass",
            address_postal_code_check: "pass",
            cvc_check: "pass"
          }
        }
      }
    }
  };
  const s = stripe.summarizeIntent(intent, "req_789");
  assert(s.paymentIntentId === "pi_123", "summarize: intent id");
  assert(s.chargeId === "ch_456", "summarize: charge id from expanded charge");
  assert(s.amountCents === 129781, "summarize: amount in cents");
  assert(s.currency === "CAD", "summarize: currency upcased");
  assert(s.cardBrand === "amex" && s.cardLast4 === "1005", "summarize: card facts");
  assert(s.avsStreet === "pass" && s.avsZip === "pass", "summarize: AVS checks");
  assert(s.processorRef === "req_789", "summarize: request id carried");
}
{
  const s = stripe.summarizeIntent({
    id: "pi_x", status: "requires_payment_method", amount: 500, currency: "cad",
    latest_charge: "ch_string_only",
    last_payment_error: { code: "card_declined", decline_code: "incorrect_zip", message: "Your card was declined." }
  });
  assert(s.chargeId === "ch_string_only", "summarize: unexpanded charge id string");
  assert(s.errorCode === "card_declined" && s.declineCode === "incorrect_zip", "summarize: last_payment_error codes");
  assert(s.cardBrand === null, "summarize: no card facts without expanded charge");
}
{
  const empty = stripe.cardFactsFrom(null);
  assert(empty.cardBrand === null && empty.avsZip === null, "cardFacts: null-safe");
}

// ---- paymentFailure shape ----------------------------------------------
{
  const err = stripe.paymentFailure("boom", {
    errorCode: "card_declined", declineCode: "insufficient_funds",
    processorRef: "req_1", httpStatus: 402
  });
  assert(err.isPaymentFailure === true, "failure: flagged");
  assert(err.processor === "stripe", "failure: processor tag");
  assert(err.declineCode === "insufficient_funds", "failure: decline code");
  assert(err.httpStatus === 402, "failure: http status numeric");
}

// ---- key-mode mismatch ---------------------------------------------------
{
  process.env.STRIPE_SECRET_KEY = "sk_live_abc";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_abc";
  assert(stripe.keyModeMismatch() === true, "keys: live secret + test publishable flagged");
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_abc";
  assert(stripe.keyModeMismatch() === false, "keys: matched modes pass");
  assert(stripe.isLiveMode() === true, "keys: live mode detected from sk_live_");
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  assert(stripe.isConfigured() === false, "keys: unset means not configured");
}

// ---- Terminal connection token ----------------------------------------
//
// The one route the field app is allowed to call. These are the properties
// that keep Tap to Pay out of PCI scope and out of a tech's hands by
// accident; the network call itself is Stripe's and is not exercised here.
{
  assert(typeof stripe.createTerminalConnectionToken === "function",
    "terminal: the lib mints connection tokens");

  // No key configured must FAIL, not fall through to an anonymous call.
  const savedSecret = process.env.STRIPE_SECRET_KEY;
  const savedPub = process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  let refused = false;
  try { await stripe.createTerminalConnectionToken(); }
  catch (err) { refused = /not configured/i.test(err.message || ""); }
  assert(refused, "terminal: refuses to mint without STRIPE_SECRET_KEY");
  if (savedSecret) process.env.STRIPE_SECRET_KEY = savedSecret;
  if (savedPub) process.env.STRIPE_PUBLISHABLE_KEY = savedPub;

  // The route is the only Stripe surface the app may reach, and it is
  // staff-gated. Read from server.js rather than restated, so deleting the
  // gate fails here rather than in the field.
  const serverSrc = readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const routeAt = serverSrc.indexOf('pathname === "/api/terminal/connection-token"');
  assert(routeAt > 0, "terminal: the connection-token route exists");
  const routeBlock = serverSrc.slice(routeAt, routeAt + 900);
  assert(/requireAdmin\(req\)/.test(routeBlock),
    "terminal: the connection-token route is staff-gated");
  assert(!/secretKey|STRIPE_SECRET_KEY/.test(routeBlock),
    "terminal: the route never hands out the secret key");

  // The app must reach Stripe through this route and nothing else. A
  // publishable key or a secret in the app bundle would mean card data or
  // account credentials on a phone.
  const appSrc = readFileSync(new URL("../pjl-field/src/api.js", import.meta.url), "utf8");
  assert(!/sk_live|sk_test|pk_live|pk_test/.test(appSrc),
    "terminal: no Stripe key is shipped in the app");
}

// ---- Terminal Location -------------------------------------------------
//
// A Tap to Pay reader is associated with a Location at CONNECT time, so
// without this id the app cannot bring the reader up at all. The rule
// worth pinning is the refusal: an account with several Locations must
// NOT have one picked for it, because a payment filed against the wrong
// site is a quiet error nobody catches until reconciliation.
{
  assert(typeof stripe.resolveTerminalLocationId === "function",
    "location: the lib resolves a Terminal location");

  const savedLoc = process.env.STRIPE_TERMINAL_LOCATION_ID;
  const savedSecret = process.env.STRIPE_SECRET_KEY;

  // Configured id wins, and short-circuits before any network call —
  // which is also why this assertion can run with no key at all.
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_TERMINAL_LOCATION_ID = "tml_configured";
  assert(await stripe.resolveTerminalLocationId() === "tml_configured",
    "location: STRIPE_TERMINAL_LOCATION_ID is used when set");

  // Whitespace-only is not a value. Without this, a stray space in a
  // Render env var would look configured and be sent to Stripe as an id.
  process.env.STRIPE_TERMINAL_LOCATION_ID = "   ";
  let refusedBlank = false;
  try { await stripe.resolveTerminalLocationId(); }
  catch (err) { refusedBlank = /not configured/i.test(err.message || ""); }
  assert(refusedBlank,
    "location: a blank STRIPE_TERMINAL_LOCATION_ID falls through, it does not count as set");

  // No key and no configured id must fail rather than call anonymously.
  delete process.env.STRIPE_TERMINAL_LOCATION_ID;
  let refused = false;
  try { await stripe.resolveTerminalLocationId(); }
  catch (err) { refused = /not configured/i.test(err.message || ""); }
  assert(refused, "location: refuses to look up without STRIPE_SECRET_KEY");

  if (savedLoc) process.env.STRIPE_TERMINAL_LOCATION_ID = savedLoc;
  else delete process.env.STRIPE_TERMINAL_LOCATION_ID;
  if (savedSecret) process.env.STRIPE_SECRET_KEY = savedSecret;

  // The several-locations refusal, read from the source: it is the
  // assertion that cannot be exercised without a live Stripe account,
  // and the one whose absence would be silent and expensive.
  const libSrc = readFileSync(new URL("../server/lib/stripe.js", import.meta.url), "utf8");
  const fnAt = libSrc.indexOf("async function resolveTerminalLocationId");
  assert(fnAt > 0, "location: the resolver exists in the lib");
  const fnBlock = libSrc.slice(fnAt, fnAt + 1400);
  assert(/locations\.length === 1/.test(fnBlock),
    "location: exactly one Location is used without configuration");
  assert(/STRIPE_TERMINAL_LOCATION_ID/.test(fnBlock),
    "location: several Locations point the reader at the env var instead of guessing");
  assert(!/locations\[0\]\.id;?\s*\n\s*}\s*$/.test(fnBlock),
    "location: no unconditional first-location fallback");

  // The route must hand back both halves. One without the other leaves
  // the app holding a token it cannot connect with.
  const serverSrc2 = readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const routeAt2 = serverSrc2.indexOf('pathname === "/api/terminal/connection-token"');
  const routeBlock2 = serverSrc2.slice(routeAt2, routeAt2 + 1200);
  assert(/resolveTerminalLocationId\(\)/.test(routeBlock2),
    "location: the connection-token route resolves the location");
  assert(/locationId/.test(routeBlock2),
    "location: the route returns locationId alongside the secret");
}

console.log(`\ntest-stripe: ${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

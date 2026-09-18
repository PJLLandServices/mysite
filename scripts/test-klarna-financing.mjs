#!/usr/bin/env node
// scripts/test-klarna-financing.mjs — Klarna financing tests (PJL-34).
// Covers build order step 1 (data model, settings, eligibility/gross-up
// math, the lifecycle state machine) and step 2 (applying a Stripe
// webhook event to that state machine — see scripts/test-stripe.mjs for
// the low-level Stripe function tests, createPaymentLink/
// capturePaymentIntent/deactivatePaymentLink).
//
//   1. computeGrossUp — matches the TRD's worked example, rejects bad input
//   2. isEligible — residential + in-range only; hard-blocks commercial;
//      respects the Settings enabled/min/max
//   3. financedAmountForQuote — whole total, or the deposit-paired balance
//   4. canTransition / ALLOWED_TRANSITIONS — the financing state machine
//   5. quotes.js integration — updateFinancingLifecycle + transitionFinancing
//      against the real store (backed up and restored, never left dirty)
//   6. settings.js integration — hydrate defaults + updateFinancing
//      validation/clamping + audit trail
//   7. applyWebhookEvent — the webhook -> state machine bridge (step 2):
//      declined/expired/voided read the event body directly; authorized
//      re-fetches from Stripe (global.fetch mocked, never a live call)
//   8. onQuoteAccepted — the acceptance hook (step 3)
//   9. enableFinancingForQuote / disableFinancingForQuote — the "Enable
//      financing" admin action (step 4): grosses up every line item's
//      price server-side, snapshots the original for undo, draft-only,
//      not idempotent (calling enable twice is refused, not a silent
//      double gross-up)
//  10. captureFinancingAuthorization / voidFinancingAuthorization (step
//      4b): the admin Capture/Void actions on an authorized hold — full
//      and partial capture, the over-amount and wrong-stage refusals, and
//      void's two Stripe branches (deactivate the link before checkout,
//      cancel the authorization after)
//
// Per CLAUDE.md's lifecycle-state rule, this file is the "pin it with a
// test that fails on the OLD code" step for the financing state machine —
// section 4 in particular exists to catch an illegal jump (e.g.
// captured -> link_sent) that would otherwise ship silently.
//
// Run: node scripts/test-klarna-financing.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };
const throws = async (fn, label) => {
  try { await fn(); failed += 1; console.error("  FAIL:", label, "(did not throw)"); }
  catch { passed += 1; }
};

// Required against the REAL repo tree (not a sandbox copy, unlike
// test-quote-views.mjs) — quotes.js has too large an internal dependency
// surface to cherry-pick safely. The real quotes.json/settings.json are
// backed up below and restored in the finally block, same discipline as
// scripts/test-booking-lifecycle.mjs.
const require = createRequire(import.meta.url);
const klarna = require(path.join(ROOT, "server", "lib", "klarna.js"));
const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
const settings = require(path.join(ROOT, "server", "lib", "settings.js"));

const QUOTES_FILE = path.join(ROOT, "server", "data", "quotes.json");
const SETTINGS_FILE = path.join(ROOT, "server", "data", "settings.json");
const CUSTOMERS_FILE = path.join(ROOT, "server", "data", "customers.json");
const originalQuotes = fs.existsSync(QUOTES_FILE) ? fs.readFileSync(QUOTES_FILE, "utf8") : null;
const originalSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8") : null;
const originalCustomers = fs.existsSync(CUSTOMERS_FILE) ? fs.readFileSync(CUSTOMERS_FILE, "utf8") : null;

function restoreFixtures() {
  if (originalQuotes === null) { try { fs.unlinkSync(QUOTES_FILE); } catch {} }
  else fs.writeFileSync(QUOTES_FILE, originalQuotes, "utf8");
  if (originalSettings === null) { try { fs.unlinkSync(SETTINGS_FILE); } catch {} }
  else fs.writeFileSync(SETTINGS_FILE, originalSettings, "utf8");
  if (originalCustomers === null) { try { fs.unlinkSync(CUSTOMERS_FILE); } catch {} }
  else fs.writeFileSync(CUSTOMERS_FILE, originalCustomers, "utf8");
}

const FEE = { feePercent: 0.0599, feeFixedCents: 30 };

try {
  // 1 — computeGrossUp
  {
    const { subtotal, total } = klarna.computeGrossUp(10000, FEE);
    ok(Math.abs(subtotal - 10726.33) < 0.01, `gross-up subtotal matches the worked example (got ${subtotal})`);
    ok(Math.abs(total - 12120.75) < 0.01, `gross-up total matches the worked example (got ${total})`);

    // Round-trip sanity: back out Klarna's fee and PJL's HST remittance
    // and land on the original target net — the exact discipline the
    // formula exists to guarantee. This is deliberately a tight tolerance
    // (not a hand-picked dollar figure) so a future formula edit that
    // drifts the math even by cents fails loudly here, not in the TRD's
    // prose.
    const feeCharged = round2(FEE.feePercent * total + FEE.feeFixedCents / 100);
    const receivedFromStripe = round2(total - feeCharged);
    const hstOwed = round2(subtotal * 0.13);
    const actualNet = round2(receivedFromStripe - hstOwed);
    ok(Math.abs(actualNet - 10000) < 0.01, `full round-trip nets exactly $10,000 (got ${actualNet})`);

    await throws(async () => klarna.computeGrossUp(0, FEE), "zero target net rejected");
    await throws(async () => klarna.computeGrossUp(-500, FEE), "negative target net rejected");
    await throws(async () => klarna.computeGrossUp(10000, { feePercent: 5.99, feeFixedCents: 30 }), "feePercent as a whole number (5.99, not 0.0599) rejected");
    await throws(async () => klarna.computeGrossUp(10000, { feePercent: 0, feeFixedCents: 30 }), "zero feePercent rejected");
  }

  // 2 — isEligible
  {
    const set = { enabled: true, minTotal: 1500, maxTotal: 17500 };
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 10000, settings: set }) === true, "residential, in range: eligible");
    ok(klarna.isEligible({ accountType: "commercial", financedAmount: 10000, settings: set }) === false, "commercial: never eligible, even in range");
    ok(klarna.isEligible({ accountType: "commercial", financedAmount: 10000, settings: { ...set, minTotal: 0, maxTotal: 999999 } }) === false, "commercial: never eligible under ANY range");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 1499.99, settings: set }) === false, "below floor: not eligible");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 1500, settings: set }) === true, "at floor: eligible");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 17500, settings: set }) === true, "at ceiling: eligible");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 17500.01, settings: set }) === false, "above ceiling: not eligible");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: 10000, settings: { ...set, enabled: false } }) === false, "kill switch off: not eligible regardless of amount/type");
    ok(klarna.isEligible({ accountType: "residential", financedAmount: NaN, settings: set }) === false, "non-numeric amount: not eligible");
    ok(klarna.isEligible({ accountType: undefined, financedAmount: 10000, settings: set }) === false, "missing accountType: not eligible");
  }

  // 3 — financedAmountForQuote
  {
    const noDeposit = { total: 12122.87, deposit: { enabled: false, amount: 0 } };
    ok(klarna.financedAmountForQuote(noDeposit) === 12122.87, "no-deposit quote: whole total is financed");

    const paired = { total: 16000, deposit: { enabled: true, amount: 6000 } };
    ok(klarna.financedAmountForQuote(paired) === 10000, "deposit-paired quote: only the balance is financed");

    const overpaid = { total: 5000, deposit: { enabled: true, amount: 9000 } };
    ok(klarna.financedAmountForQuote(overpaid) === 0, "financed amount never goes negative");
  }

  // 4 — canTransition / ALLOWED_TRANSITIONS
  {
    ok(klarna.canTransition("not_offered", "link_sent") === true, "not_offered -> link_sent is legal");
    ok(klarna.canTransition("link_sent", "authorized") === true, "link_sent -> authorized is legal");
    ok(klarna.canTransition("link_sent", "declined") === true, "link_sent -> declined is legal");
    ok(klarna.canTransition("declined", "link_sent") === true, "declined -> link_sent (retry) is legal");
    ok(klarna.canTransition("authorized", "captured") === true, "authorized -> captured is legal");
    ok(klarna.canTransition("authorized", "partially_captured") === true, "authorized -> partially_captured is legal");
    ok(klarna.canTransition("authorized", "expired") === true, "authorized -> expired is legal");
    ok(klarna.canTransition("authorized", "voided") === true, "authorized -> voided is legal");

    // The illegal jumps a real bug would actually produce — this is the
    // "pin it with a test that fails on the old code" check: a mutator
    // with no transition guard would let every one of these through.
    ok(klarna.canTransition("captured", "link_sent") === false, "captured -> link_sent is illegal (terminal)");
    ok(klarna.canTransition("not_offered", "authorized") === false, "not_offered -> authorized is illegal (skips the link)");
    ok(klarna.canTransition("expired", "authorized") === false, "expired -> authorized is illegal (stale authorization)");
    ok(klarna.canTransition("voided", "captured") === false, "voided -> captured is illegal");
    ok(klarna.canTransition("declined", "captured") === false, "declined -> captured is illegal (skips authorization)");
  }

  // 5 — quotes.js integration (real store, backed up above, restored below)
  {
    fs.mkdirSync(path.dirname(QUOTES_FILE), { recursive: true });
    fs.writeFileSync(QUOTES_FILE, JSON.stringify([
      { id: "Q-2026-9001", total: 12122.87, deposit: { enabled: false, amount: 0 } },
      { id: "Q-2026-9002", total: 16000, deposit: { enabled: true, amount: 6000, balance: 10000 } }
    ], null, 2) + "\n", "utf8");

    const hydrated = await quotes.get("Q-2026-9001");
    ok(hydrated.financing.stage === "not_offered", "legacy/new quote hydrates financing.stage to not_offered");
    ok(Array.isArray(hydrated.financing.remindersSent) && hydrated.financing.remindersSent.length === 0, "hydrated financing.remindersSent defaults to []");

    // Legal path, end to end, through the real transitionFinancing + storage.
    await klarna.transitionFinancing("Q-2026-9001", "link_sent", {
      eligible: true, enabled: true, financedAmount: { subtotal: 10728.20, total: 12122.87 },
      paymentLinkId: "plink_test_1", paymentLinkUrl: "https://buy.stripe.com/test_1"
    }, { by: "test" });
    let q = await quotes.get("Q-2026-9001");
    ok(q.financing.stage === "link_sent", "transitionFinancing moved stage to link_sent");
    ok(q.financing.paymentLinkId === "plink_test_1", "transitionFinancing wrote the payment link id");
    ok(q.history.some((h) => h.action === "financing_lifecycle" && h.note.includes("link_sent")), "history logs the financing_lifecycle transition");

    const authorizedAt = new Date().toISOString();
    await klarna.transitionFinancing("Q-2026-9001", "authorized", {
      authorizationId: "pi_test_1", authorizedAt, captureBy: new Date(Date.now() + 28 * 86400000).toISOString()
    }, { by: "system", note: "klarna approved" });
    q = await quotes.get("Q-2026-9001");
    ok(q.financing.stage === "authorized", "link_sent -> authorized applied");
    ok(q.financing.authorizationId === "pi_test_1", "authorizationId stored");

    // Illegal jump is refused, and refusal leaves the record untouched.
    let threw = false;
    try { await klarna.transitionFinancing("Q-2026-9001", "link_sent", {}, { by: "test" }); }
    catch { threw = true; }
    ok(threw, "illegal transition (authorized -> link_sent) throws");
    q = await quotes.get("Q-2026-9001");
    ok(q.financing.stage === "authorized", "record unchanged after a refused transition");

    await klarna.transitionFinancing("Q-2026-9001", "captured", {
      capturedAt: new Date().toISOString(), capturedAmountCents: 1212287
    }, { by: "admin", note: "captured" });
    q = await quotes.get("Q-2026-9001");
    ok(q.financing.stage === "captured", "authorized -> captured applied");
    ok(q.financing.capturedAmountCents === 1212287, "capturedAmountCents stored");

    await throws(async () => klarna.transitionFinancing("Q-2026-9001", "voided", {}, { by: "test" }), "captured is terminal — voided after captured throws");

    await throws(async () => quotes.updateFinancingLifecycle("Q-2026-9001", { stage: "not_a_real_stage" }), "unknown stage rejected by the storage primitive itself");

    await throws(async () => klarna.transitionFinancing("Q-NOPE-0000", "link_sent", {}), "transitionFinancing on a missing quote throws");
  }

  // 6 — settings.js integration
  {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({}, null, 2), "utf8");
    let s = await settings.get();
    ok(s.financing.enabled === true, "financing settings default to enabled");
    ok(s.financing.minTotal === 1500 && s.financing.maxTotal === 17500, "financing settings default to the $1,500-$17,500 range");
    ok(s.financing.feePercent === 0.0599 && s.financing.feeFixedCents === 30, "financing settings default to Klarna's fee");

    await settings.updateFinancing({ minTotal: 2000, maxTotal: 20000, feePercent: 0.065, feeFixedCents: 35 }, { who: "test", note: "adjust" });
    s = await settings.get();
    ok(s.financing.minTotal === 2000 && s.financing.maxTotal === 20000, "updateFinancing applies valid min/max");
    ok(s.financing.feePercent === 0.065 && s.financing.feeFixedCents === 35, "updateFinancing applies valid fee values");
    ok(s.audit[0].action === "financing", "settings audit trail records the financing change");

    // Guardrails: a self-contradictory or nonsensical patch is refused,
    // not silently stored.
    await settings.updateFinancing({ maxTotal: 1000 }, { who: "test" }); // below current minTotal (2000)
    s = await settings.get();
    ok(s.financing.maxTotal === 20000, "maxTotal below minTotal is rejected, prior value kept");

    await settings.updateFinancing({ feePercent: 5.99 }, { who: "test" }); // whole number, not a fraction
    s = await settings.get();
    ok(s.financing.feePercent === 0.065, "feePercent >= 1 (a whole-number typo) is rejected, prior value kept");

    // hydrate() defensive default: an inverted range stored some other way
    // (hand-edited file, old bug) still resolves to something usable
    // rather than making every quote ineligible.
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ financing: { enabled: true, minTotal: 9000, maxTotal: 5000 } }, null, 2), "utf8");
    s = await settings.get();
    ok(s.financing.maxTotal > s.financing.minTotal, "hydrate() refuses to serve an inverted min/max range");
  }

  // 7 — applyWebhookEvent (build order step 2): the webhook -> state
  // machine bridge. payment_intent.payment_failed and .canceled read
  // straight off the event body (no network, low-stakes per klarna.js's
  // own comment); amount_capturable_updated re-fetches from Stripe
  // (money-adjacent judgment), so global.fetch is mocked for that one —
  // same technique as scripts/test-stripe.mjs, never a live call.
  {
    fs.writeFileSync(QUOTES_FILE, JSON.stringify([
      { id: "Q-2026-9101", total: 5000, deposit: { enabled: false, amount: 0 } },
      { id: "Q-2026-9102", total: 5000, deposit: { enabled: false, amount: 0 } },
      { id: "Q-2026-9103", total: 5000, deposit: { enabled: false, amount: 0 } },
      { id: "Q-2026-9104", total: 5000, deposit: { enabled: false, amount: 0 } }
    ], null, 2) + "\n", "utf8");

    // (a) payment_intent.payment_failed on a link_sent quote -> declined
    await klarna.transitionFinancing("Q-2026-9101", "link_sent", { paymentLinkId: "plink_a" });
    let r = await klarna.applyWebhookEvent("payment_intent.payment_failed", {
      id: "pi_a", metadata: { quoteId: "Q-2026-9101", source: "pjl-klarna" }
    });
    ok(r.action === "declined", "payment_failed on link_sent -> declined");
    let q = await quotes.get("Q-2026-9101");
    ok(q.financing.stage === "declined" && q.financing.declinedAt, "declined stage + declinedAt persisted");

    // Redelivery of the same event is a no-op, not a re-decline or an error.
    r = await klarna.applyWebhookEvent("payment_intent.payment_failed", {
      id: "pi_a", metadata: { quoteId: "Q-2026-9101", source: "pjl-klarna" }
    });
    ok(r.action === "noop", "redelivered payment_failed after already-declined is a no-op, not an error");

    // (b) payment_intent.canceled, reason "automatic" on an authorized quote -> expired
    await klarna.transitionFinancing("Q-2026-9102", "link_sent", { paymentLinkId: "plink_b" });
    await klarna.transitionFinancing("Q-2026-9102", "authorized", { authorizationId: "pi_b", authorizedAt: new Date().toISOString() });
    r = await klarna.applyWebhookEvent("payment_intent.canceled", {
      id: "pi_b", metadata: { quoteId: "Q-2026-9102", source: "pjl-klarna" }, cancellation_reason: "automatic"
    });
    ok(r.action === "expired", "canceled with reason=automatic -> expired");
    q = await quotes.get("Q-2026-9102");
    ok(q.financing.stage === "expired" && q.financing.expiredAt, "expired stage + expiredAt persisted");
    ok(!q.financing.voidedAt, "expiring never stamps voidedAt");

    // (c) payment_intent.canceled, reason "requested_by_customer" (our own
    // admin-void stamp, per stripe.js's cancelPaymentIntent) -> voided
    await klarna.transitionFinancing("Q-2026-9103", "link_sent", { paymentLinkId: "plink_c" });
    await klarna.transitionFinancing("Q-2026-9103", "authorized", { authorizationId: "pi_c", authorizedAt: new Date().toISOString() });
    r = await klarna.applyWebhookEvent("payment_intent.canceled", {
      id: "pi_c", metadata: { quoteId: "Q-2026-9103", source: "pjl-klarna" }, cancellation_reason: "requested_by_customer"
    });
    ok(r.action === "voided", "canceled with reason=requested_by_customer -> voided (admin action)");
    q = await quotes.get("Q-2026-9103");
    ok(q.financing.stage === "voided" && q.financing.voidedAt, "voided stage + voidedAt persisted");
    ok(!q.financing.expiredAt, "voiding never stamps expiredAt");

    // (d) payment_intent.amount_capturable_updated -> authorized, re-fetches from Stripe
    {
      const savedSecret = process.env.STRIPE_SECRET_KEY;
      const savedPub = process.env.STRIPE_PUBLISHABLE_KEY;
      process.env.STRIPE_SECRET_KEY = "sk_test_fake";
      process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "pi_d", status: "requires_capture" })
      });
      try {
        await klarna.transitionFinancing("Q-2026-9104", "link_sent", { paymentLinkId: "plink_d" });
        r = await klarna.applyWebhookEvent("payment_intent.amount_capturable_updated", {
          id: "pi_d", metadata: { quoteId: "Q-2026-9104", source: "pjl-klarna" }
        });
        ok(r.action === "authorized", "amount_capturable_updated -> authorized");
        q = await quotes.get("Q-2026-9104");
        ok(q.financing.stage === "authorized", "authorized stage persisted");
        ok(q.financing.authorizationId === "pi_d", "authorizationId comes from the RE-FETCHED intent, not just the event body");
        ok(!!q.financing.captureBy, "captureBy (28-day deadline) is set");
        const daysOut = (new Date(q.financing.captureBy) - new Date(q.financing.authorizedAt)) / 86400000;
        ok(Math.abs(daysOut - 28) < 0.01, "captureBy is exactly 28 days after authorizedAt");

        // Redelivery is a no-op — already authorized, never re-authorized.
        r = await klarna.applyWebhookEvent("payment_intent.amount_capturable_updated", {
          id: "pi_d", metadata: { quoteId: "Q-2026-9104", source: "pjl-klarna" }
        });
        ok(r.action === "noop", "redelivered amount_capturable_updated after already-authorized is a no-op");
      } finally {
        global.fetch = originalFetch;
        if (savedSecret) process.env.STRIPE_SECRET_KEY = savedSecret; else delete process.env.STRIPE_SECRET_KEY;
        if (savedPub) process.env.STRIPE_PUBLISHABLE_KEY = savedPub; else delete process.env.STRIPE_PUBLISHABLE_KEY;
      }
    }

    // (e) no quoteId / unknown quote -> skipped, never throws
    r = await klarna.applyWebhookEvent("payment_intent.payment_failed", { id: "pi_x", metadata: {} });
    ok(r.action === "skipped", "event with no quoteId in metadata is skipped, not an error");
    r = await klarna.applyWebhookEvent("payment_intent.payment_failed", { id: "pi_y", metadata: { quoteId: "Q-NOPE-9999" } });
    ok(r.action === "skipped", "event for an unknown quote is skipped, not an error");
  }

  // 8 — onQuoteAccepted (build order step 3): the acceptance hook.
  // Section 4's SAFETY INVARIANT gets its own explicit checks here: a
  // quote is a no-op unless financing.enabled === true, and even then
  // gets re-verified (not just trusted) before anything reaches Stripe.
  {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      financing: { enabled: true, minTotal: 1500, maxTotal: 17500, feePercent: 0.0599, feeFixedCents: 30 }
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([
      { id: "CUST-RES-1", name: "Jamie Residential", email: "jamie@example.com", accountType: "residential" },
      { id: "CUST-COM-1", name: "Acme Property Co", email: "billing@acme.example.com", accountType: "commercial" }
    ], null, 2) + "\n", "utf8");
    fs.writeFileSync(QUOTES_FILE, JSON.stringify([
      { id: "Q-ACC-1", total: 10000, customerId: "CUST-RES-1", deposit: { enabled: false, amount: 0 } },
      { id: "Q-ACC-2", total: 10000, customerId: "CUST-RES-1", deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "not_offered" } },
      { id: "Q-ACC-3", total: 10000, customerId: "CUST-COM-1", deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "not_offered" } },
      { id: "Q-ACC-4", total: 16000, customerId: "CUST-RES-1", deposit: { enabled: true, amount: 6000 },
        financing: { enabled: true, stage: "not_offered" } },
      { id: "Q-ACC-5", total: 500, customerId: "CUST-RES-1", deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "not_offered" } },
      { id: "Q-ACC-6", total: 10000, customerId: "CUST-RES-1", deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "not_offered" } }
    ], null, 2) + "\n", "utf8");

    // (a) SAFETY INVARIANT — no financing block at all -> no-op, no Stripe
    // reachable (STRIPE_SECRET_KEY is unset here, so any attempted call
    // would throw "not configured" before ever touching the network;
    // this assertion is the behavioural half of that guarantee).
    let r = await klarna.onQuoteAccepted("Q-ACC-1", { by: "test" });
    ok(r.skipped === "not_enabled", "a quote with no financing.enabled is a pure no-op (the load-bearing safety invariant)");
    let q = await quotes.get("Q-ACC-1");
    ok(q.financing.stage === "not_offered", "untouched quote's financing stage never moves");

    const savedSecret = process.env.STRIPE_SECRET_KEY;
    const savedPub = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
    const originalFetch = global.fetch;
    try {
      // (b) enabled + eligible residential quote -> creates the link
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "plink_acc_2", url: "https://buy.stripe.com/test_acc2" })
      });
      r = await klarna.onQuoteAccepted("Q-ACC-2", { by: "test" });
      ok(r.ok === true, "eligible + enabled quote: onQuoteAccepted succeeds");
      q = await quotes.get("Q-ACC-2");
      ok(q.financing.stage === "link_sent", "stage moves to link_sent");
      ok(q.financing.paymentLinkId === "plink_acc_2" && q.financing.paymentLinkUrl === "https://buy.stripe.com/test_acc2", "payment link id/url stored");
      ok(q.financing.financedAmount?.total === 10000, "financedAmount.total is the whole quote (no deposit)");
      ok(q.financing.pairedWithDeposit === false, "not paired with a deposit");
      ok(typeof r.warning === "string", "no Gmail config in this sandbox -> a warning is surfaced (email not silently swallowed)");

      // (c) idempotency — calling again is alreadyRan, no second link
      r = await klarna.onQuoteAccepted("Q-ACC-2", { by: "test" });
      ok(r.alreadyRan === true, "re-running onQuoteAccepted on an already-started quote is a no-op");

      // (d) commercial customer — enabled=true (as if someone forced it),
      // but re-verification at acceptance time hard-blocks it anyway.
      // No fetch mock swap needed: isEligible rejects before Stripe is reached.
      r = await klarna.onQuoteAccepted("Q-ACC-3", { by: "test" });
      ok(r.skipped === "no_longer_eligible", "commercial customer is blocked even if enabled were somehow true");
      q = await quotes.get("Q-ACC-3");
      ok(q.financing.stage === "not_offered", "commercial quote's stage never advances");
      ok(q.history.some((h) => h.action === "financing_lifecycle" && h.note.includes("no longer eligible")), "the skip is recorded in the quote's history for Patrick to find");

      // (e) deposit-paired quote — only the balance is financed
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "plink_acc_4", url: "https://buy.stripe.com/test_acc4" })
      });
      r = await klarna.onQuoteAccepted("Q-ACC-4", { by: "test" });
      ok(r.ok === true, "deposit-paired quote: onQuoteAccepted succeeds");
      q = await quotes.get("Q-ACC-4");
      ok(q.financing.financedAmount?.total === 10000, "financedAmount is the BALANCE (16000 - 6000), not the whole total");
      ok(q.financing.pairedWithDeposit === true, "pairedWithDeposit recorded for the balance-only financing");
      ok(q.deposit.enabled === true && q.deposit.stage == null, "the deposit object itself is untouched by the financing hook (independent, parallel hooks)");

      // (f) amount fell out of range before acceptance (e.g. partial
      // acceptance shrank the total) -> re-verification skips, not a
      // forced offer at a stale amount.
      r = await klarna.onQuoteAccepted("Q-ACC-5", { by: "test" });
      ok(r.skipped === "no_longer_eligible", "an amount that fell below the floor is re-checked, not trusted from enable-time");

      // (g) Stripe failure — the link creation itself errors. Stage must
      // NOT advance (no link_sent with no real Stripe link behind it).
      global.fetch = async () => ({
        ok: false, status: 402, headers: { get: () => null },
        json: async () => ({ error: { message: "Your card was declined.", code: "card_declined" } })
      });
      r = await klarna.onQuoteAccepted("Q-ACC-6", { by: "test" });
      ok(r.ok === false && typeof r.warning === "string", "a Stripe failure surfaces as a warning, not a thrown exception");
      q = await quotes.get("Q-ACC-6");
      ok(q.financing.stage === "not_offered", "a failed link creation never advances the stage");
      ok(q.history.some((h) => h.action === "financing_lifecycle" && h.note.includes("Klarna payment link failed")), "the failure is recorded in history, not silently dropped");
    } finally {
      global.fetch = originalFetch;
      if (savedSecret) process.env.STRIPE_SECRET_KEY = savedSecret; else delete process.env.STRIPE_SECRET_KEY;
      if (savedPub) process.env.STRIPE_PUBLISHABLE_KEY = savedPub; else delete process.env.STRIPE_PUBLISHABLE_KEY;
    }
  }
  // 9 — enableFinancingForQuote / disableFinancingForQuote (build order
  // step 4): the "Enable financing" admin action.
  {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      financing: { enabled: true, minTotal: 1500, maxTotal: 17500, feePercent: 0.0599, feeFixedCents: 30 }
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([
      { id: "CUST-RES-1", name: "Jamie Residential", email: "jamie@example.com", accountType: "residential" },
      { id: "CUST-COM-1", name: "Acme Property Co", email: "billing@acme.example.com", accountType: "commercial" }
    ], null, 2) + "\n", "utf8");
    const lineItemsFor = () => ([
      { key: "a", label: "Item A", price: 6000, qty: 1, lineTotal: 6000 },
      { key: "b", label: "Item B", price: 2000, qty: 2, lineTotal: 4000 }
    ]);
    fs.writeFileSync(QUOTES_FILE, JSON.stringify([
      { id: "Q-ENA-1", status: "draft", customerId: "CUST-RES-1", lineItems: lineItemsFor(), subtotal: 10000, hst: 1300, total: 11300 },
      { id: "Q-ENA-2", status: "sent", customerId: "CUST-RES-1", lineItems: lineItemsFor(), subtotal: 10000, hst: 1300, total: 11300 },
      { id: "Q-ENA-3", status: "draft", customerId: "CUST-COM-1", lineItems: lineItemsFor(), subtotal: 10000, hst: 1300, total: 11300 },
      { id: "Q-ENA-4", status: "draft", customerId: "CUST-RES-1", lineItems: [{ key: "a", label: "Small job", price: 200, qty: 1, lineTotal: 200 }], subtotal: 200, hst: 26, total: 226 },
      // Deposit ALREADY enabled before financing is enabled — mirrors
      // the real bug caught by driving the actual browser UI: the
      // existing deposit-threshold feature can auto-enable a deposit
      // before "Enable financing" is ever clicked, and pairedWithDeposit
      // has to reflect that, not just deposit-enabled-after-the-fact.
      { id: "Q-ENA-5", status: "draft", customerId: "CUST-RES-1", lineItems: lineItemsFor(), subtotal: 10000, hst: 1300, total: 11300,
        deposit: { enabled: true, configured: true, type: "percent", value: 40, amount: 4520, balance: 6780,
          dueLabel: "due at scheduling", balanceLabel: "due on completion", stage: null, snapshot: null, depositInvoiceId: null, balanceInvoiceId: null } }
    ], null, 2) + "\n", "utf8");

    // (a) draft + eligible -> succeeds, prices scale, undo snapshot taken
    let updated = await klarna.enableFinancingForQuote("Q-ENA-1", { by: "test" });
    ok(updated.financing.enabled === true && updated.financing.eligible === true, "enable succeeds on a draft, eligible, residential quote");
    const expectedGrossUp = klarna.computeGrossUp(10000, { feePercent: 0.0599, feeFixedCents: 30 });
    ok(Math.abs(updated.subtotal - expectedGrossUp.subtotal) < 0.01, `quote subtotal is grossed up to match computeGrossUp (got ${updated.subtotal})`);
    ok(Math.abs(updated.total - expectedGrossUp.total) < 0.01, `quote total is grossed up to match computeGrossUp (got ${updated.total})`);
    const sumOfLines = round2(updated.lineItems.reduce((s, li) => s + (Number(li.lineTotal) || 0), 0));
    ok(Math.abs(sumOfLines - updated.subtotal) < 0.005, `line items sum EXACTLY to the new subtotal, no rounding drift (sum=${sumOfLines}, subtotal=${updated.subtotal})`);
    ok(updated.lineItems[0].lineTotal > 6000 && updated.lineItems[1].lineTotal > 4000, "every line item's price/lineTotal scaled up, none left at the original price");
    ok(updated.financing.undo && updated.financing.undo.subtotal === 10000 && updated.financing.undo.total === 11300, "the original (pre-gross-up) subtotal/total is snapshotted for undo");
    ok(JSON.stringify(updated.financing.undo.lineItems) === JSON.stringify(lineItemsFor()), "the original line items are snapshotted verbatim");
    ok(updated.history.some((h) => h.action === "financing_lifecycle" && h.note.includes("grossed up")), "the price change is recorded in the quote's history");

    // (b) calling enable again is refused, not a silent double gross-up
    await throws(async () => klarna.enableFinancingForQuote("Q-ENA-1", { by: "test" }), "enabling an already-enabled quote is refused (never double-grosses-up)");
    let stillOnce = await quotes.get("Q-ENA-1");
    ok(Math.abs(stillOnce.subtotal - expectedGrossUp.subtotal) < 0.01, "a refused re-enable leaves the price exactly where it was");

    // (c) frozen (non-draft) quote -> refused, price untouched
    await throws(async () => klarna.enableFinancingForQuote("Q-ENA-2", { by: "test" }), "enable on a sent (non-draft) quote is refused — pricing is frozen");
    let frozen = await quotes.get("Q-ENA-2");
    ok(frozen.subtotal === 10000 && frozen.financing.enabled === false, "a refused enable on a frozen quote leaves it completely untouched");

    // (d) commercial customer -> refused with a clear reason, price untouched
    let threw = null;
    try { await klarna.enableFinancingForQuote("Q-ENA-3", { by: "test" }); }
    catch (err) { threw = err; }
    ok(threw && /commercial/i.test(threw.message), `commercial quote is refused with a commercial-specific reason (got: ${threw?.message})`);
    let commercial = await quotes.get("Q-ENA-3");
    ok(commercial.subtotal === 10000 && commercial.financing.enabled === false, "a refused enable on a commercial quote leaves it completely untouched");

    // (e) amount below the floor -> refused with a clear reason
    threw = null;
    try { await klarna.enableFinancingForQuote("Q-ENA-4", { by: "test" }); }
    catch (err) { threw = err; }
    ok(threw && /floor|below/i.test(threw.message), `below-floor quote is refused with a range-specific reason (got: ${threw?.message})`);

    // (f) disable restores the EXACT original pricing
    const disabled = await klarna.disableFinancingForQuote("Q-ENA-1", { by: "test" });
    ok(disabled.subtotal === 10000 && disabled.total === 11300, "disable restores the exact original subtotal/total");
    ok(JSON.stringify(disabled.lineItems) === JSON.stringify(lineItemsFor()), "disable restores the exact original line items");
    ok(disabled.financing.enabled === false && disabled.financing.eligible === false && disabled.financing.undo === null, "financing block is fully cleared after disable, not just enabled:false");
    ok(disabled.history.some((h) => h.note === "Financing removed — original pricing restored"), "the removal is recorded in the quote's history");

    // (g) disable when never enabled -> refused
    await throws(async () => klarna.disableFinancingForQuote("Q-ENA-1", { by: "test" }), "disabling a quote with no financing enabled is refused, not a silent no-op");

    // (h) re-enabling after a clean disable works again (not permanently stuck)
    const reEnabled = await klarna.enableFinancingForQuote("Q-ENA-1", { by: "test" });
    ok(reEnabled.financing.enabled === true, "a quote can be enabled again after a clean disable");

    // (i) REGRESSION (caught by driving the real browser UI, not by any
    // synthetic test): a quote whose deposit is ALREADY enabled before
    // "Enable financing" is clicked must be stored as pairedWithDeposit,
    // and its financedAmount must be the BALANCE (post-gross-up total
    // minus the deposit, which itself gets recomputed off the new
    // grossed-up total by the existing refreshLineItems machinery) —
    // never the whole grossed-up total.
    const paired = await klarna.enableFinancingForQuote("Q-ENA-5", { by: "test" });
    ok(paired.financing.pairedWithDeposit === true, "pairedWithDeposit is recorded when the deposit was already enabled at enable-time");
    const expectedDepositAfter = round2(paired.total * 0.4);
    const expectedBalanceAfter = round2(paired.total - expectedDepositAfter);
    ok(Math.abs(paired.deposit.amount - expectedDepositAfter) < 0.01, `deposit amount recomputed off the NEW grossed-up total (got ${paired.deposit.amount}, expected ~${expectedDepositAfter})`);
    ok(Math.abs(paired.financing.financedAmount.total - expectedBalanceAfter) < 0.01, `financedAmount is the BALANCE, not the whole grossed-up total (got ${paired.financing.financedAmount.total}, expected ~${expectedBalanceAfter})`);
    ok(paired.financing.financedAmount.total < paired.total, "financed amount is strictly less than the quote's full total when paired with a deposit");
  }

  // 10 — captureFinancingAuthorization / voidFinancingAuthorization (step 4b)
  {
    fs.writeFileSync(QUOTES_FILE, JSON.stringify([
      { id: "Q-CAP-1", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_cap_1",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-CAP-2", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_cap_2",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-CAP-3", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_cap_3",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-CAP-4", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "link_sent", paymentLinkId: "plink_cap_4" } },
      { id: "Q-CAP-5", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_cap_5",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-CAP-6", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_cap_6",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-VOID-1", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "link_sent", paymentLinkId: "plink_void_1" } },
      { id: "Q-VOID-2", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "authorized", authorizationId: "pi_void_2",
          authorizedAt: new Date().toISOString(), captureBy: new Date(Date.now() + 28 * 86400000).toISOString(),
          financedAmount: { subtotal: 8849.56, total: 10000 } } },
      { id: "Q-VOID-3", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: true, stage: "captured", capturedAmountCents: 1000000, capturedAt: new Date().toISOString() } },
      { id: "Q-VOID-4", total: 10000, deposit: { enabled: false, amount: 0 },
        financing: { enabled: false, stage: "not_offered" } }
    ], null, 2) + "\n", "utf8");

    const savedSecret = process.env.STRIPE_SECRET_KEY;
    const savedPub = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
    const originalFetch = global.fetch;
    try {
      // (a) full capture -> captured, capturedAmountCents stored
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "pi_cap_1", status: "succeeded", latest_charge: "ch_cap_1" })
      });
      let r = await klarna.captureFinancingAuthorization("Q-CAP-1", { amountCents: 1000000, by: "test" });
      ok(r.quote.financing.stage === "captured", "full capture (amount === authorized) moves stage to captured");
      ok(r.quote.financing.capturedAmountCents === 1000000, "capturedAmountCents stores the full amount");
      ok(!!r.quote.financing.capturedAt, "capturedAt is stamped");
      let q = await quotes.get("Q-CAP-1");
      ok(q.financing.stage === "captured", "captured stage persisted to the store");

      // (b) partial capture -> partially_captured (terminal, same as full)
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "pi_cap_2", status: "succeeded", latest_charge: "ch_cap_2" })
      });
      r = await klarna.captureFinancingAuthorization("Q-CAP-2", { amountCents: 400000, by: "test" });
      ok(r.quote.financing.stage === "partially_captured", "partial capture (amount < authorized) moves stage to partially_captured");
      ok(r.quote.financing.capturedAmountCents === 400000, "capturedAmountCents stores only what was actually captured");

      // (c) capturing more than was authorized is refused before Stripe is called
      await throws(async () => klarna.captureFinancingAuthorization("Q-CAP-3", { amountCents: 1500000, by: "test" }),
        "capturing more than the authorized amount is refused");
      q = await quotes.get("Q-CAP-3");
      ok(q.financing.stage === "authorized", "a refused over-amount capture leaves the stage untouched");

      // (d) wrong stage (link_sent, no authorization yet) is refused
      await throws(async () => klarna.captureFinancingAuthorization("Q-CAP-4", { amountCents: 1000000, by: "test" }),
        "capture on a link_sent (not yet authorized) quote is refused");

      // (e) Stripe returns a non-succeeded status -> throws, stage untouched
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "pi_cap_5", status: "requires_action" })
      });
      await throws(async () => klarna.captureFinancingAuthorization("Q-CAP-5", { amountCents: 1000000, by: "test" }),
        "a capture that doesn't come back succeeded throws, nothing is recorded");
      q = await quotes.get("Q-CAP-5");
      ok(q.financing.stage === "authorized", "a non-succeeded capture response leaves the stage untouched");

      // (f) Stripe call itself fails (declined/network) -> throws, stage untouched
      global.fetch = async () => ({
        ok: false, status: 402, headers: { get: () => null },
        json: async () => ({ error: { message: "The authorization has expired.", code: "payment_intent_unexpected_state" } })
      });
      await throws(async () => klarna.captureFinancingAuthorization("Q-CAP-6", { amountCents: 1000000, by: "test" }),
        "a Stripe capture failure throws rather than silently recording a capture");
      q = await quotes.get("Q-CAP-6");
      ok(q.financing.stage === "authorized", "a failed Stripe capture call leaves the stage untouched");

      // (g) void from link_sent -> deactivates the payment link, stage voided
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "plink_void_1", active: false })
      });
      let v = await klarna.voidFinancingAuthorization("Q-VOID-1", { by: "test" });
      ok(v.financing.stage === "voided", "void from link_sent moves stage to voided");
      ok(!!v.financing.voidedAt, "voidedAt is stamped");

      // (h) void from authorized -> cancels the PaymentIntent, stage voided
      global.fetch = async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: "pi_void_2", status: "canceled", cancellation_reason: "requested_by_customer" })
      });
      v = await klarna.voidFinancingAuthorization("Q-VOID-2", { by: "test" });
      ok(v.financing.stage === "voided", "void from authorized moves stage to voided");
      q = await quotes.get("Q-VOID-2");
      ok(q.financing.stage === "voided", "voided stage persisted to the store");

      // (i) void on a terminal stage (already captured) is refused
      await throws(async () => klarna.voidFinancingAuthorization("Q-VOID-3", { by: "test" }),
        "void on an already-captured (terminal) quote is refused — money already moved");
      q = await quotes.get("Q-VOID-3");
      ok(q.financing.stage === "captured", "a refused void leaves a captured quote's stage untouched");

      // (j) void on a quote that was never offered financing is refused
      await throws(async () => klarna.voidFinancingAuthorization("Q-VOID-4", { by: "test" }),
        "void on a not_offered quote is refused — nothing to void");
    } finally {
      global.fetch = originalFetch;
      if (savedSecret) process.env.STRIPE_SECRET_KEY = savedSecret; else delete process.env.STRIPE_SECRET_KEY;
      if (savedPub) process.env.STRIPE_PUBLISHABLE_KEY = savedPub; else delete process.env.STRIPE_PUBLISHABLE_KEY;
    }
  }

  // Source check — every klarna admin route is ADMIN-ONLY (the fence in
  // needsAuth AND the route's own requireAdmin check), read from source
  // rather than restated so a refactor that drops either layer fails here.
  {
    const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
    ok(/klarna\\\/\(enable\|disable\)\$\/\.test\(pathname\)\) return "admin"/.test(serverSrc),
      "needsAuth fences the klarna enable/disable paths as admin-only");
    ok(/klarna\\\/capture\$\/\.test\(pathname\)\) return "admin"/.test(serverSrc),
      "needsAuth fences the klarna capture path as admin-only");
    ok(/klarna\\\/void\$\/\.test\(pathname\)\) return "admin"/.test(serverSrc),
      "needsAuth fences the klarna void path as admin-only");

    const enableAt = serverSrc.indexOf('pathname.match(/^\\/api\\/admin\\/quotes\\/([^/]+)\\/klarna\\/enable$/)');
    ok(enableAt > 0, "the enable route exists");
    const enableBlock = serverSrc.slice(enableAt, enableAt + 700);
    ok(/const session = await requireAdmin\(req\);/.test(enableBlock) && /if \(!session\) return sendJson\(res, 403/.test(enableBlock),
      "the enable route checks requireAdmin's answer, not just its own existence");

    const disableAt = serverSrc.indexOf('pathname.match(/^\\/api\\/admin\\/quotes\\/([^/]+)\\/klarna\\/disable$/)');
    ok(disableAt > 0, "the disable route exists");
    const disableBlock = serverSrc.slice(disableAt, disableAt + 700);
    ok(/const session = await requireAdmin\(req\);/.test(disableBlock) && /if \(!session\) return sendJson\(res, 403/.test(disableBlock),
      "the disable route checks requireAdmin's answer, not just its own existence");

    const captureAt = serverSrc.indexOf('pathname.match(/^\\/api\\/admin\\/invoices\\/([^/]+)\\/klarna\\/capture$/)');
    ok(captureAt > 0, "the capture route exists");
    const captureBlock = serverSrc.slice(captureAt, captureAt + 900);
    ok(/const session = await requireAdmin\(req\);/.test(captureBlock) && /if \(!session\) return sendJson\(res, 403/.test(captureBlock),
      "the capture route checks requireAdmin's answer, not just its own existence");

    const voidAt = serverSrc.indexOf('pathname.match(/^\\/api\\/admin\\/quotes\\/([^/]+)\\/klarna\\/void$/)');
    ok(voidAt > 0, "the void route exists");
    const voidBlock = serverSrc.slice(voidAt, voidAt + 700);
    ok(/const session = await requireAdmin\(req\);/.test(voidBlock) && /if \(!session\) return sendJson\(res, 403/.test(voidBlock),
      "the void route checks requireAdmin's answer, not just its own existence");
  }
} finally {
  restoreFixtures();
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

console.log(`\nklarna-financing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

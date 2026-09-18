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
const originalQuotes = fs.existsSync(QUOTES_FILE) ? fs.readFileSync(QUOTES_FILE, "utf8") : null;
const originalSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8") : null;

function restoreFixtures() {
  if (originalQuotes === null) { try { fs.unlinkSync(QUOTES_FILE); } catch {} }
  else fs.writeFileSync(QUOTES_FILE, originalQuotes, "utf8");
  if (originalSettings === null) { try { fs.unlinkSync(SETTINGS_FILE); } catch {} }
  else fs.writeFileSync(SETTINGS_FILE, originalSettings, "utf8");
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
} finally {
  restoreFixtures();
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

console.log(`\nklarna-financing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

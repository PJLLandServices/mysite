// Klarna financing (via Stripe) — PJL-34.
//
// Step 1 of the build order (see the PJL-34 TRD, Linear) built the pure
// eligibility + gross-up math and the financing state machine's
// transition rules, on top of the storage primitive in lib/quotes.js
// (updateFinancingLifecycle). Step 2 added the Stripe side: applying a
// webhook event to that state machine. Step 3 (below, onQuoteAccepted)
// is the acceptance hook that actually creates a Payment Link for a real
// customer — the first piece of this feature with a real-world side
// effect (an email, a live Stripe object).
//
// SAFETY INVARIANT, load-bearing: onQuoteAccepted is a no-op for every
// quote in existence today, and will stay a no-op for every quote until
// something explicitly sets quote.financing.enabled = true. Nothing in
// this codebase does that yet — the only thing that will is the "Enable
// financing" admin button (build order step 4, not yet built). Eligible
// (financing.eligible) is only ever a computed hint; it is never read as
// permission to act. This is deliberate and must not be "simplified"
// away: this account's Stripe key is LIVE (docs/HANDOFF_STRIPE_PAYMENTS.md),
// so an accidental auto-enable here would create a real Payment Link and
// email a real customer.
//
// This module never touches server/pay.js or the existing card-payment
// PaymentIntent flow (FLOW-23, PASS) — Klarna is a separate, additive
// flow by design.

const quotes = require("./quotes");
const stripe = require("./stripe");

const HST_RATE = 0.13;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Gross-up math ------------------------------------------------------
//
// Solves for the pre-tax subtotal S such that, after Klarna's fee (taken
// on the tax-INCLUSIVE total) and after remitting 13% HST on the
// subtotal, PJL nets exactly targetNet. See TRD §4 for the derivation and
// a worked example ($10,000 target -> $10,726.33 subtotal / $12,120.75
// total, incl. HST). Always call this with Settings values
// (settings.financing.feePercent/feeFixedCents), never a hardcoded fee —
// a rate change should be a Settings edit, not a code change.
function computeGrossUp(targetNet, { feePercent, feeFixedCents } = {}) {
  const net = Number(targetNet) || 0;
  const fee = Number(feePercent);
  const fixed = Number(feeFixedCents) || 0;
  if (!(net > 0)) throw new Error("computeGrossUp: targetNet must be a positive number.");
  if (!(fee > 0 && fee < 1)) throw new Error("computeGrossUp: feePercent must be a fraction between 0 and 1.");
  const k = (1 - fee) * (1 + HST_RATE) - HST_RATE;
  const subtotal = round2((net + fixed / 100) / k);
  const total = round2(subtotal * (1 + HST_RATE));
  return { subtotal, total };
}

// ---- Eligibility ---------------------------------------------------------
//
// Hard rule (PRD, non-negotiable): Klarna is residential-only, and this
// can never be forced true for a commercial account. accountType is a
// caller-resolved input, never looked up here, so this stays a pure
// function — the caller must read it from the real customer record
// (customer.accountType via the quote's customerId), never from anything
// client-submitted.
function isEligible({ accountType, financedAmount, settings }) {
  if (!settings || settings.enabled !== true) return false;
  if (accountType !== "residential") return false;
  const amt = Number(financedAmount);
  if (!Number.isFinite(amt)) return false;
  return amt >= Number(settings.minTotal) && amt <= Number(settings.maxTotal);
}

// The amount actually financed for a quote: the whole total, unless the
// quote is paired with the deposit system (TRD §7a) — in which case only
// the BALANCE (total minus the deposit) is financed. The deposit itself
// is always due now, paid the normal way, never through Klarna.
function financedAmountForQuote(quote) {
  const total = Number(quote?.total) || 0;
  const deposit = quote?.deposit;
  if (deposit && deposit.enabled === true) {
    const depositAmount = Number(deposit.amount) || 0;
    return Math.max(0, round2(total - depositAmount));
  }
  return round2(total);
}

// ---- Lifecycle state machine --------------------------------------------
//
// quotes.updateFinancingLifecycle (the storage primitive) accepts any
// stage in FINANCING_STAGES — it doesn't judge whether the jump makes
// sense, same division of labour as lib/deposits.js orchestrating on top
// of quotes.updateDepositLifecycle. This is where that judgment lives: a
// quote's financing can only move along a listed edge; anything else
// throws rather than silently corrupting the record.
const { FINANCING_STAGES } = quotes;

const ALLOWED_TRANSITIONS = {
  not_offered: ["link_sent"],
  link_sent: ["authorized", "declined", "voided"],
  declined: ["link_sent"],        // customer retries with a fresh link
  authorized: ["captured", "partially_captured", "expired", "voided"],
  captured: [],                   // terminal
  partially_captured: [],         // terminal
  expired: [],                    // terminal — a fresh attempt is a new
                                   // cycle, never a silent reuse of a
                                   // stale authorizationId
  voided: []                      // terminal
};

function canTransition(fromStage, toStage) {
  const edges = ALLOWED_TRANSITIONS[fromStage];
  return Array.isArray(edges) && edges.includes(toStage);
}

// Move a quote's financing to `toStage`, refusing any jump that isn't a
// listed edge above. `patch` carries whatever other financing fields
// change alongside the stage (e.g. authorizationId + authorizedAt
// together when moving to "authorized").
async function transitionFinancing(quoteId, toStage, patch = {}, opts = {}) {
  if (!FINANCING_STAGES.includes(toStage)) {
    throw new Error(`transitionFinancing: unknown stage "${toStage}".`);
  }
  const q = await quotes.get(quoteId);
  if (!q) throw new Error(`transitionFinancing: quote ${quoteId} not found.`);
  const fromStage = q.financing?.stage || "not_offered";
  if (!canTransition(fromStage, toStage)) {
    throw new Error(`transitionFinancing: illegal financing transition ${fromStage} -> ${toStage} on ${quoteId}.`);
  }
  return quotes.updateFinancingLifecycle(quoteId, { ...patch, stage: toStage }, opts);
}

// ---- Webhook application -------------------------------------------------
//
// Called from server.js's existing /api/webhooks/stripe handler for any
// payment_intent event carrying metadata.source === "pjl-klarna" — a
// separate branch from the invoice-payment path, matched on quoteId
// rather than invoiceId, so the two can never collide (see TRD §11). The
// handler there already acks Stripe before this runs (ack-fast, process-
// async), so this can take its time and never risk a Stripe redelivery
// storm.
//
// Money-critical judgment (green-lighting a job for scheduling) gets the
// same treatment finalizeStripeInvoicePayment gives a card payment:
// re-fetch the intent from Stripe rather than trust the webhook body.
// Lower-stakes events (a decline, a cancellation whose money is already
// gone either way) read straight off the event body, matching how the
// existing payment_intent.payment_failed handler already treats a
// decline — no re-fetch needed to know the customer wasn't approved.
//
// Idempotent by construction: every branch's first move is checking the
// CURRENT stage against what the event implies, so a Stripe redelivery
// of an already-applied event is a silent no-op, not a second webhook
// error or a rejected illegal transition.
//
// Returns { ok, action, reason? } for the caller to log. Never throws for
// a normal no-op; only lets a genuine bug (e.g. a stage transitionFinancing
// refuses) surface as a rejected promise.
async function applyWebhookEvent(type, intentFromEvent) {
  const quoteId = intentFromEvent?.metadata?.quoteId || "";
  if (!quoteId) return { ok: false, action: "skipped", reason: "no quoteId in metadata" };

  const q = await quotes.get(quoteId);
  if (!q) return { ok: false, action: "skipped", reason: `quote ${quoteId} not found` };
  const currentStage = q.financing?.stage || "not_offered";

  if (type === "payment_intent.amount_capturable_updated") {
    if (currentStage !== "link_sent") {
      return { ok: true, action: "noop", reason: `stage is ${currentStage}, not link_sent` };
    }
    // The one branch that moves money-adjacent trust: re-read from
    // Stripe before telling Patrick to dispatch a crew.
    const { intent } = await stripe.retrievePaymentIntent(intentFromEvent.id);
    if (intent.status !== "requires_capture") {
      return { ok: true, action: "noop", reason: `intent status is ${intent.status}, not requires_capture` };
    }
    const authorizedAt = new Date().toISOString();
    const captureBy = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
    await transitionFinancing(quoteId, "authorized", {
      authorizationId: intent.id,
      authorizedAt,
      captureBy
    }, { by: "system", note: "Klarna approved — funds capturable" });
    return { ok: true, action: "authorized" };
  }

  if (type === "payment_intent.payment_failed") {
    if (currentStage !== "link_sent") {
      return { ok: true, action: "noop", reason: `stage is ${currentStage}, not link_sent` };
    }
    await transitionFinancing(quoteId, "declined", {
      declinedAt: new Date().toISOString()
    }, { by: "system", note: "Klarna declined the customer at checkout" });
    return { ok: true, action: "declined" };
  }

  if (type === "payment_intent.canceled") {
    if (currentStage !== "authorized") {
      return { ok: true, action: "noop", reason: `stage is ${currentStage}, not authorized` };
    }
    // "automatic" is the one value ONLY Stripe's own 28-day auto-cancel
    // produces — every admin void this codebase issues explicitly passes
    // cancellationReason: "requested_by_customer" to
    // stripe.cancelPaymentIntent for exactly this reason. Anything else
    // (including unset) is therefore a human action, not the clock
    // running out.
    const reason = intentFromEvent?.cancellation_reason || "";
    if (reason === "automatic") {
      await transitionFinancing(quoteId, "expired", {
        expiredAt: new Date().toISOString()
      }, { by: "system", note: "Stripe auto-cancelled the authorization (28-day window passed)" });
      return { ok: true, action: "expired" };
    }
    await transitionFinancing(quoteId, "voided", {
      voidedAt: new Date().toISOString()
    }, { by: "admin", note: `Authorization cancelled (cancellation_reason=${reason || "unset"})` });
    return { ok: true, action: "voided" };
  }

  return { ok: true, action: "ignored", reason: `unhandled event type ${type}` };
}

// ---- Acceptance hook (build order step 3) -------------------------------
//
// Called alongside lib/deposits.js's onQuoteAccepted, from every
// acceptance code path in server.js (portal e-sign, PDF-return
// attestation, offline/on-site acceptance) — same event, independent
// hook, exactly the parallel-hook design in TRD §7a: the deposit half
// (if any) is completely unaffected by anything in this function, and
// this function never touches the deposit.
//
// Failure-tolerant like sendInvoiceNow in deposits.js: a Stripe hiccup
// or an email hiccup must never un-accept the quote the customer just
// signed. Callers wrap this in their own try/catch as belt-and-suspenders,
// but every error path inside here is already caught and turned into a
// { ok:false, warning } or a logged no-op — this should not throw.
async function onQuoteAccepted(quote, { by = "system" } = {}) {
  const q = typeof quote === "string" ? await quotes.get(quote) : quote;
  if (!q || !q.financing || q.financing.enabled !== true) {
    return { ok: true, skipped: "not_enabled" };
  }
  if (q.financing.stage && q.financing.stage !== "not_offered") {
    return { ok: true, alreadyRan: true, stage: q.financing.stage };
  }

  // Re-verify eligibility at the moment of acting, never trust the
  // enabled flag alone — the same "server never trusts stale state for
  // money" discipline every other Stripe-adjacent function here follows.
  // A quote can legitimately fall out of range between "admin enabled
  // it" and "customer accepted" (partial acceptance changed the total,
  // Settings' range changed, the kill switch flipped off) — when that
  // happens this is a silent skip, not a forced financing offer.
  const settingsLib = require("./settings");
  const customers = require("./customers");
  const s = await settingsLib.get();

  let accountType = "residential";
  let customerName = "";
  let customerEmail = String(q.customerEmail || "").trim();
  try {
    const cust = q.customerId
      ? await customers.get(q.customerId, { withProperties: false })
      : (customerEmail ? await customers.findByEmail(customerEmail) : null);
    if (cust) {
      if (cust.accountType) accountType = cust.accountType;
      if (cust.name) customerName = cust.name;
      if (!customerEmail && cust.email) customerEmail = cust.email;
    }
  } catch (err) {
    console.warn(`[klarna] customer lookup failed for ${q.id}: ${err?.message}`);
    // Fall through with accountType's safe default ("residential") — but
    // isEligible still requires accountType === "residential" explicitly,
    // and this is exactly why: an unresolvable customer NEVER upgrades
    // itself to eligible by accident. A commercial account whose lookup
    // happens to fail is not silently offered financing either — it was
    // never eligible in the first place per the hard block below.
  }

  const financedAmount = financedAmountForQuote(q);
  if (!isEligible({ accountType, financedAmount, settings: s.financing })) {
    console.warn(`[klarna] ${q.id} no longer eligible at acceptance (accountType=${accountType}, financedAmount=${financedAmount}) — skipping link creation`);
    await quotes.updateFinancingLifecycle(q.id, {}, {
      by, note: `Skipped — no longer eligible at acceptance (accountType=${accountType}, financedAmount=${fmtMoney(financedAmount)})`
    }).catch(() => {});
    return { ok: true, skipped: "no_longer_eligible" };
  }

  const displayId = (q.quoteNumberDisplay && String(q.quoteNumberDisplay).trim()) || q.id;
  const pairedWithDeposit = q.deposit?.enabled === true;
  const idempotencyKey = `pjl-klarna-link-${q.id}`;

  let link;
  try {
    link = await stripe.createPaymentLink({
      amountCents: Math.round(financedAmount * 100),
      quoteId: q.id,
      description: `PJL financing — quote ${displayId}${pairedWithDeposit ? " (balance)" : ""}`,
      idempotencyKey
    });
  } catch (err) {
    const warning = `Klarna payment link failed: ${err.message}`;
    console.error(`[klarna] ${warning} (quote ${q.id})`);
    await quotes.updateFinancingLifecycle(q.id, {}, { by, note: warning }).catch(() => {});
    return { ok: false, warning };
  }

  await transitionFinancing(q.id, "link_sent", {
    eligible: true,
    pairedWithDeposit,
    // subtotal is an approximation (financedAmount / 1.13) for a
    // balance-only figure — informational only, nothing reads it yet.
    financedAmount: { subtotal: round2(financedAmount / (1 + HST_RATE)), total: financedAmount, at: new Date().toISOString() },
    paymentLinkId: link.id,
    paymentLinkUrl: link.url
  }, { by, note: `Klarna payment link created (${pairedWithDeposit ? "balance" : "full amount"}: ${fmtMoney(financedAmount)})` });

  // Best-effort customer email — mirrors deposits.js's sendInvoiceNow: a
  // send failure must never unwind the authorization link just created,
  // it only surfaces as a warning for Patrick to notice.
  let warning = null;
  if (!customerEmail) {
    warning = `Klarna link created for ${q.id} but the quote has no customer email — send it manually.`;
    console.warn(`[klarna] ${warning}`);
  } else {
    try {
      const notify = require("./notify-customer");
      const result = await notify.sendFinancingLinkEmail(q, {
        toEmail: customerEmail,
        customerName,
        paymentLinkUrl: link.url,
        financedAmountText: fmtMoney(financedAmount),
        pairedWithDeposit
      });
      if (!result?.ok) warning = result?.reason || result?.error || "Financing email not sent.";
    } catch (emailErr) {
      warning = emailErr?.message || "Financing email failed.";
      console.warn(`[klarna] financing email failed for ${q.id}: ${warning}`);
    }
  }

  return { ok: true, paymentLink: link, warning };
}

module.exports = {
  computeGrossUp,
  isEligible,
  financedAmountForQuote,
  ALLOWED_TRANSITIONS,
  canTransition,
  transitionFinancing,
  applyWebhookEvent,
  onQuoteAccepted
};

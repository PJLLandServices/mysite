// Klarna financing (via Stripe) — PJL-34.
//
// Step 1 of the build order (see the PJL-34 TRD, Linear): pure eligibility
// + gross-up math, and the financing state machine's transition rules, on
// top of the storage primitive in lib/quotes.js (updateFinancingLifecycle).
// No Stripe calls live here yet — those land in step 2, once
// server/lib/stripe.js gains createPaymentLink / capturePaymentIntent /
// deactivatePaymentLink. This module never touches server/pay.js or the
// existing card-payment PaymentIntent flow (FLOW-23, PASS) — Klarna is a
// separate, additive flow by design.

const quotes = require("./quotes");

const HST_RATE = 0.13;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Gross-up math ------------------------------------------------------
//
// Solves for the pre-tax subtotal S such that, after Klarna's fee (taken
// on the tax-INCLUSIVE total) and after remitting 13% HST on the
// subtotal, PJL nets exactly targetNet. See TRD §4 for the derivation and
// a worked example ($10,000 target -> $10,728.20 subtotal / $12,122.87
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

module.exports = {
  computeGrossUp,
  isEligible,
  financedAmountForQuote,
  ALLOWED_TRANSITIONS,
  canTransition,
  transitionFinancing
};

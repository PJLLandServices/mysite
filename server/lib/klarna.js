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
// Resolve the customer bits eligibility and the acceptance email need,
// tolerating a missing/unresolvable customer record rather than
// throwing. Shared by onQuoteAccepted and enableFinancingForQuote so
// there is exactly one place that decides "what accountType does this
// quote's customer have" — never two copies that could drift (the same
// discipline CLAUDE.md's lifecycle-state rule asks for).
async function resolveCustomerBits(q) {
  const customers = require("./customers");
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
    // Fall through with the safe default ("residential") — but isEligible
    // still requires accountType === "residential" explicitly, and this
    // is exactly why: an unresolvable customer NEVER upgrades itself to
    // eligible by accident. A commercial account whose lookup happens to
    // fail is not silently offered financing either — it was never
    // eligible in the first place per the hard block in isEligible.
  }
  return { accountType, customerName, customerEmail };
}

// A human-readable reason a quote isn't eligible right now, for the
// admin UI's error message — isEligible itself stays a plain boolean so
// it's trivial to test, this is just English wrapped around the same
// checks in the same order.
function describeIneligibility({ accountType, financedAmount, settings }) {
  if (!settings || settings.enabled !== true) return "Financing is turned off in Settings right now.";
  if (accountType !== "residential") return "Klarna doesn't support commercial customers — this quote can never be offered financing.";
  const amt = Number(financedAmount);
  if (!Number.isFinite(amt) || amt <= 0) return "This quote doesn't have a financeable amount yet.";
  if (amt < Number(settings.minTotal)) return `The financed amount (${fmtMoney(amt)}) is below the ${fmtMoney(settings.minTotal)} floor.`;
  if (amt > Number(settings.maxTotal)) return `The financed amount (${fmtMoney(amt)}) is above the ${fmtMoney(settings.maxTotal)} ceiling.`;
  return "Not eligible.";
}

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
  const s = await settingsLib.get();
  const { accountType, customerName, customerEmail } = await resolveCustomerBits(q);

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

// ---- "Enable financing" admin action (build order step 4) ---------------
//
// The single button Patrick asked for: checks eligibility, grosses up
// every line item's price (TRD §4 — the whole point of dividing rather
// than adding is that this needs to happen exactly once, correctly),
// and marks the quote financing.enabled = true so onQuoteAccepted picks
// it up automatically once the customer accepts. This is the ONLY place
// in the codebase that sets financing.enabled = true — see the safety-
// invariant comment at the top of this file, which this function is the
// other half of.
//
// Draft-only, same rule as quotes.refreshLineItems: line items are
// frozen the moment a quote is sent, so pricing can't change out from
// under a customer who already has the PDF. Not idempotent on purpose —
// calling this twice on an already-enabled quote would gross up an
// already-grossed-up price. Call disableFinancingForQuote first to
// change anything.
async function enableFinancingForQuote(quoteId, { by = "admin" } = {}) {
  const q = await quotes.get(quoteId);
  if (!q) throw new Error(`Quote ${quoteId} not found.`);
  if (q.status !== "draft" && q.status !== "draft_preview") {
    throw new Error(`Quote ${quoteId} is in status "${q.status}" — pricing is frozen, financing can only be enabled on a draft.`);
  }
  if (q.financing?.enabled === true) {
    throw new Error(`Financing is already enabled on ${quoteId}. Remove it first if you need to change anything.`);
  }

  const settingsLib = require("./settings");
  const s = await settingsLib.get();
  const { accountType } = await resolveCustomerBits(q);

  // Eligibility is checked against the CURRENT (pre-gross-up) financed
  // amount — the ~7% the gross-up adds is never large enough to cross
  // the $1,500/$17,500 band in a way that matters, and checking pre-
  // gross-up means the error message a commercial customer or an
  // out-of-range quote gets is about the price Patrick actually typed,
  // not a number he never entered.
  const financedAmountBefore = financedAmountForQuote(q);
  if (!isEligible({ accountType, financedAmount: financedAmountBefore, settings: s.financing })) {
    throw new Error(describeIneligibility({ accountType, financedAmount: financedAmountBefore, settings: s.financing }));
  }

  const currentSubtotal = Number(q.subtotal) || 0;
  const grossUp = computeGrossUp(currentSubtotal, s.financing);
  const factor = currentSubtotal > 0 ? grossUp.subtotal / currentSubtotal : 1;

  const originalLineItems = Array.isArray(q.lineItems) ? q.lineItems : [];
  const scaledLineItems = originalLineItems.map((li) => {
    const qty = Number(li.qty) || 1;
    const newLineTotal = round2((Number(li.lineTotal) || 0) * factor);
    return { ...li, price: round2(newLineTotal / qty), lineTotal: newLineTotal };
  });
  // Rounding every line item independently can leave the sum a cent or
  // two off the target subtotal — correct it on the LAST line item so
  // the total the customer sees always matches the formula exactly,
  // never "close enough."
  const scaledSum = round2(scaledLineItems.reduce((sum, li) => sum + (Number(li.lineTotal) || 0), 0));
  const drift = round2(grossUp.subtotal - scaledSum);
  if (drift !== 0 && scaledLineItems.length > 0) {
    const last = scaledLineItems[scaledLineItems.length - 1];
    last.lineTotal = round2(last.lineTotal + drift);
    last.price = round2(last.lineTotal / (Number(last.qty) || 1));
  }

  const newHst = round2(grossUp.subtotal * HST_RATE);
  const newTotal = round2(grossUp.subtotal + newHst);
  const updated = await quotes.refreshLineItems(quoteId, {
    lineItems: scaledLineItems, subtotal: grossUp.subtotal, hst: newHst, total: newTotal
  });

  const financedAmountAfter = financedAmountForQuote(updated);
  // Caught by actually running this in a browser, not by the unit tests:
  // a quote that crosses the deposit threshold gets its deposit toggled
  // on automatically (existing behaviour, unrelated to this feature) —
  // so by the time "Enable financing" is clicked, q.deposit.enabled may
  // already be true. pairedWithDeposit has to reflect THAT, or the
  // stored record disagrees with what financedAmountForQuote just used
  // to compute financedAmountAfter two lines up.
  const pairedWithDeposit = updated.deposit?.enabled === true;
  const final = await quotes.updateFinancingLifecycle(quoteId, {
    eligible: true,
    enabled: true,
    pairedWithDeposit,
    financedAmount: { subtotal: grossUp.subtotal, total: financedAmountAfter, at: new Date().toISOString() },
    grossUp: { targetNet: currentSubtotal, feePercent: s.financing.feePercent, feeFixedCents: s.financing.feeFixedCents, at: new Date().toISOString() },
    undo: { lineItems: originalLineItems, subtotal: currentSubtotal, total: Number(q.total) || 0 }
  }, {
    by,
    note: `Financing enabled — price grossed up ${fmtMoney(currentSubtotal)} -> ${fmtMoney(grossUp.subtotal)} subtotal` +
      (pairedWithDeposit ? ` (financing covers the ${fmtMoney(financedAmountAfter)} balance, deposit unaffected)` : "")
  });

  return final;
}

// Undo enableFinancingForQuote — restores the exact pre-gross-up pricing
// from the snapshot it took, then clears the financing block back to
// blank. Draft-only, same reasoning as enable. Throws if financing was
// never enabled (nothing to undo) rather than silently no-op-ing, so a
// UI bug that calls this twice is visible immediately.
async function disableFinancingForQuote(quoteId, { by = "admin" } = {}) {
  const q = await quotes.get(quoteId);
  if (!q) throw new Error(`Quote ${quoteId} not found.`);
  if (q.status !== "draft" && q.status !== "draft_preview") {
    throw new Error(`Quote ${quoteId} is in status "${q.status}" — pricing is frozen, financing can't be changed.`);
  }
  if (q.financing?.enabled !== true || !q.financing?.undo) {
    throw new Error(`Financing isn't enabled on ${quoteId} — nothing to remove.`);
  }

  const { lineItems, subtotal, total } = q.financing.undo;
  const hst = round2(subtotal * HST_RATE);
  await quotes.refreshLineItems(quoteId, { lineItems, subtotal, hst, total });

  return quotes.updateFinancingLifecycle(quoteId, {
    eligible: false,
    enabled: false,
    financedAmount: null,
    grossUp: null,
    undo: null
  }, { by, note: "Financing removed — original pricing restored" });
}

// ---- Capture / void (build order step 4b) --------------------------------
//
// The two admin actions once a customer's Klarna checkout has already
// authorized: collect the money (capture) once the job is done, or cancel
// the hold (void) if it never should have gone through. Both are the only
// things allowed to touch a "link_sent" or "authorized" quote from here on
// — no auto-capture (TRD §8, Patrick's decision: a job that never happened
// must never silently get paid for).
//
// Capture the authorization — the only function in this module that moves
// real money. `amountCents` may be less than the full authorized amount
// (a partial capture, e.g. the job scope shrank); Stripe releases the
// remainder back to the customer automatically and that release can't be
// undone, so a partial capture is terminal, same as a full one.
async function captureFinancingAuthorization(quoteId, { amountCents, by = "admin" } = {}) {
  const q = await quotes.get(quoteId);
  if (!q) throw new Error(`Quote ${quoteId} not found.`);
  const fin = q.financing || {};
  if (fin.stage !== "authorized") {
    throw new Error(`Quote ${quoteId} financing is "${fin.stage || "not_offered"}" — capture is only allowed from "authorized".`);
  }
  const amt = Math.round(Number(amountCents));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("Capture amount must be a positive number of cents.");
  }
  const fullCents = Math.round((Number(fin.financedAmount?.total) || 0) * 100);
  if (amt > fullCents) {
    throw new Error(`Cannot capture ${fmtMoney(amt / 100)} — only ${fmtMoney(fullCents / 100)} was authorized.`);
  }

  const idempotencyKey = `pjl-klarna-capture-${quoteId}-${amt}`;
  let intent;
  try {
    intent = await stripe.capturePaymentIntent(fin.authorizationId, { amountToCaptureCents: amt, idempotencyKey });
  } catch (err) {
    throw new Error(`Klarna capture failed in Stripe: ${err.message}`);
  }
  if (intent?.status !== "succeeded") {
    throw new Error(`Stripe capture did not succeed (status: ${intent?.status || "unknown"}) — nothing was recorded.`);
  }

  const isFull = amt >= fullCents;
  const stage = isFull ? "captured" : "partially_captured";
  const updated = await transitionFinancing(quoteId, stage, {
    capturedAmountCents: amt,
    capturedAt: new Date().toISOString(),
    captureChargeId: (intent.latest_charge && intent.latest_charge.id) || intent.latest_charge || null
  }, {
    by,
    note: `Klarna authorization captured — ${fmtMoney(amt / 100)} of ${fmtMoney(fullCents / 100)}` +
      (isFull ? "" : " (partial — remainder released back to the customer)")
  });

  return { quote: updated, capturedAmountCents: amt, intent };
}

// Void — cancels a hold that should never be collected. Branches on
// what's actually live in Stripe: before the customer completes checkout
// there's only a Payment Link to deactivate (no PaymentIntent exists
// yet); after Klarna approves them, it's a real manual-capture
// authorization that has to be explicitly cancelled. Always passes
// cancellationReason: "requested_by_customer" to cancelPaymentIntent —
// applyWebhookEvent's payment_intent.canceled branch relies on exactly
// that string to tell an admin void apart from Stripe's own 28-day
// auto-expiry ("automatic"). This function transitions the quote itself
// rather than waiting for that webhook, so the later webhook delivery is
// just a no-op confirmation (currentStage is already "voided" by then).
async function voidFinancingAuthorization(quoteId, { by = "admin" } = {}) {
  const q = await quotes.get(quoteId);
  if (!q) throw new Error(`Quote ${quoteId} not found.`);
  const fin = q.financing || {};
  const stage = fin.stage;

  if (stage === "authorized") {
    try {
      await stripe.cancelPaymentIntent(fin.authorizationId, { cancellationReason: "requested_by_customer" });
    } catch (err) {
      throw new Error(`Couldn't cancel the Klarna authorization in Stripe: ${err.message}`);
    }
  } else if (stage === "link_sent") {
    try {
      if (fin.paymentLinkId) await stripe.deactivatePaymentLink(fin.paymentLinkId);
    } catch (err) {
      throw new Error(`Couldn't deactivate the Klarna payment link in Stripe: ${err.message}`);
    }
  } else {
    throw new Error(`Quote ${quoteId} financing is "${stage || "not_offered"}" — nothing to void.`);
  }

  return transitionFinancing(quoteId, "voided", {
    voidedAt: new Date().toISOString()
  }, {
    by,
    note: stage === "authorized"
      ? "Klarna authorization cancelled by admin"
      : "Klarna payment link deactivated by admin (never completed)"
  });
}

module.exports = {
  computeGrossUp,
  isEligible,
  describeIneligibility,
  financedAmountForQuote,
  ALLOWED_TRANSITIONS,
  canTransition,
  transitionFinancing,
  applyWebhookEvent,
  onQuoteAccepted,
  enableFinancingForQuote,
  disableFinancingForQuote,
  captureFinancingAuthorization,
  voidFinancingAuthorization
};

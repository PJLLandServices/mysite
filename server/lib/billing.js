// What a work order bills — ONE calculation, used by every reader.
//
// Before this, three places each did their own "load the property → ask
// whether the account is commercial → re-resolve the seasonal fee (frozen
// once signed) → turn a price-pending line into its suggestion" and then
// used the result their own way:
//
//   * Finish        — completion-cascade.run, which drafts the invoice
//   * Generate      — POST /api/work-orders/:id/create-invoice
//   * the preview   — GET /api/work-orders/:id `seasonalFee`, what the tech
//                     sees before tapping Finish
//
// They agreed only because three copies happened to match. Any one of
// them changing alone would have the tech shown one price, Finish billing a
// second and "Generate invoice now" a third — the drift CLAUDE.md warns
// about. billingFor(wo) is now the only way to ask, and those three call
// it. (The lock points — signature and bypass — PRICE the fee rather than
// read it, through pricing.pricedQuoteForLock, but load their inputs through
// the same billingInputs() below.)
//
// billingFor(wo) → {
//   lines,       exactly the lines an invoice for this work order bills
//                (price-pending fee → its SUGGESTED amount, PJL-96)
//   correctedQuote  the WO's onSiteQuote with the seasonal fee as it bills
//                now, when that differs from what is stored (else null) —
//                what an UNLOCKED work order is corrected to
//   total,       invoices.totalsForLines(lines).total
//   noCharge,    lines exist and total $0 (fall-closing fix #8)
//   fee,         the seasonal fee, or null on a non-seasonal WO:
//                { changed, before, after, zoneCount, commercial, pending,
//                  lockedAtSigning }
//   error        set when the fee could not be re-resolved; the lines are
//                then the WO's own, unchanged (the old behaviour of all
//                three callers)
// }
//
// Pure read: it never writes the work order. The cascade decides whether
// to store correctedQuote (only while the WO is not signature-locked).

const pricing = require("./pricing");

const SEASONAL = new Set(["fall_closing", "spring_opening"]);

// Pull line items from the WO. Priority:
//   1. wo.onSiteQuote.builderLineItems (the customer-accepted lines)
//   2. wo.lineItems (legacy / additional repairs)
//   3. [] (no charge — spring opening with nothing to bill, etc.)
function lineItemsFromWo(wo) {
  if (Array.isArray(wo?.onSiteQuote?.builderLineItems) && wo.onSiteQuote.builderLineItems.length) {
    return wo.onSiteQuote.builderLineItems;
  }
  if (Array.isArray(wo?.lineItems) && wo.lineItems.length) return wo.lineItems;
  return [];
}

// The inputs every seasonal price needs: the LIVE property record and
// whether its owner is a commercial account. `property` may be passed when
// the caller already holds the live record.
async function billingInputs(wo, { property } = {}) {
  const prop = property !== undefined ? property : (wo?.propertyId ? await require("./properties").get(wo.propertyId) : null);
  const commercial = await require("./customers").isCommercialAccount(prop?.customerId || wo?.customerId || null);
  return { property: prop || null, commercial };
}

async function billingFor(wo, { property } = {}) {
  const invoices = require("./invoices");
  const workOrders = require("./work-orders");
  let billWo = wo;
  let fee = null;
  let error = null;
  if (wo && SEASONAL.has(wo.type)) {
    try {
      const inputs = await billingInputs(wo, { property });
      const refresh = pricing.refreshSeasonalBaseline(wo, inputs.property, { commercial: inputs.commercial, frozen: workOrders.isScopeFrozen(wo) });
      if (refresh.changed) billWo = { ...wo, onSiteQuote: { ...(wo.onSiteQuote || {}), builderLineItems: refresh.lines } };
      fee = {
        changed: refresh.changed === true,
        before: refresh.before || null,
        after: refresh.after || null,
        zoneCount: refresh.zoneCount || 0,
        commercial: inputs.commercial,
        pending: refresh.pending === true || refresh.customQuote === true,
        lockedAtSigning: refresh.lockedAtSigning === true
      };
    } catch (err) {
      error = err?.message || String(err);
      console.warn(`[billing] seasonal fee re-resolve failed for ${wo?.id}: ${error}`);
    }
  }
  const lines = pricing.billableLines(billWo, lineItemsFromWo(billWo));
  const total = lines.length ? invoices.totalsForLines(lines).total : 0;
  return {
    lines, total, noCharge: lines.length > 0 && !(total > 0), fee, error,
    correctedQuote: billWo !== wo ? billWo.onSiteQuote : null
  };
}

module.exports = { billingFor, billingInputs, lineItemsFromWo };

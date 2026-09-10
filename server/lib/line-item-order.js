// Line-item display order (2026-08).
//
// Patrick sets the sequence line items appear in on the quotation — moving
// the Hunter Hydrawise flow meter, the controller or the mainline to the top
// of the stack, independent of the order they were created in or their zone
// number. That sequence has to reach the customer PDF and the HTML proposal
// page identically.
//
// WHY AN EXPLICIT FIELD RATHER THAN ARRAY POSITION
//
// Array position looks like the obvious place to keep order, and it is the
// wrong one: `mergeQuoteLines()` in sitebuilder.html rebuilds the array in
// canonical order (mainline, controller, Zone 1..N, then manual lines) every
// time "Generate quote" re-syncs a design. Order held as position is thrown
// away by that re-sync; order held as a property survives it, because the
// merge carries a matched line's own fields across (`Object.assign({},
// prev, …)`).
//
// DISPLAY ONLY
//
// `order` is never read by the totals, the deposit figures, QuickBooks or
// the invoice — computeProposalTotals sums lineTotal across the array, which
// is a sum and not a scan, so no arrangement can move a number. Zone numbers
// and zone labels are likewise untouched: a label like "Zone 7 — Front lawn"
// is a frozen string by the time it reaches lineItems (it is generated once
// from the Site Builder's own zones array), so moving a line cannot renumber
// anything.
//
// This module has NO dependencies on purpose — quote-pdf.js deliberately
// avoids requiring quotes.js to stay clear of a lib require cycle, and both
// renderers need this.

// Sort key for one line: its explicit `order` when it has a finite one,
// otherwise its position in the array. The fallback is what lets a legacy
// record that pre-dates the field render in exactly the order it always did,
// with no migration — its lines simply keep array order until the next save
// stamps real values on them.
function orderKey(li, idx) {
  const n = Number(li && li.order);
  return Number.isFinite(n) ? n : idx;
}

// The quote's line items in display order.
//
// Returns a NEW array — renderers are handed the live quote record, so
// sorting in place would mutate stored data as a side effect of drawing a
// page. Array position is the tiebreaker, which makes the sort total and
// deterministic even if two lines somehow carry the same `order`.
function orderedLineItems(quote) {
  const items = Array.isArray(quote && quote.lineItems) ? quote.lineItems : [];
  return items
    .map((li, idx) => ({ li, idx }))
    .sort((a, b) => (orderKey(a.li, a.idx) - orderKey(b.li, b.idx)) || (a.idx - b.idx))
    .map((e) => e.li);
}

// Same order, but each entry keeps the index it occupies in the STORED
// array. The proposal builder needs this: its row inputs address
// `state.quote.lineItems[i]` directly, so a table drawn in display order
// still has to wire every control to the underlying array slot.
function orderedLineItemsWithIndex(quote) {
  const items = Array.isArray(quote && quote.lineItems) ? quote.lineItems : [];
  return items
    .map((li, idx) => ({ li, idx }))
    .sort((a, b) => (orderKey(a.li, a.idx) - orderKey(b.li, b.idx)) || (a.idx - b.idx));
}

module.exports = { orderedLineItems, orderedLineItemsWithIndex, orderKey };

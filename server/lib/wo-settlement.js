// How a visit was settled, when it was settled some way other than an
// invoice for it (P-PJL-22 D).
//
// Today's one kind: "paid_in_full" — the customer prepaid (a season plan,
// a prepaid package), so the visit is complete with NOTHING to collect.
// It is not No Charge: No Charge is derived from lines that total $0 and
// means the visit cost nothing; Paid in Full means it was paid for, before.
// The visit keeps its real lines and value for the office.
//
//   wo.settlement = { type: "paid_in_full", reference, by, at }
//
// Set and cleared only by an admin (PUT/DELETE /api/work-orders/:id/settlement,
// work-orders.setSettlement). A technician never sees it: techView() takes it
// off every JSON response a tech session receives and leaves only
// `paymentHandledByOffice: true`, so the tech's screens say "Payment: handled
// by the office" and nothing about the arrangement.
//
// Accounting (docs/INVOICE_DELIVERY_TTP.md §3): the visit creates NO
// QuickBooks transaction. That is correct when the prepayment was booked as
// a sale when it was paid, and double-books nothing otherwise; Patrick
// confirms which before this is relied on for a deposit-style plan.

const TYPES = new Set(["paid_in_full"]);

// THE rule for "this visit is settled by prepayment". Every reader asks it.
function isPaidInFull(rec) {
  return Boolean(rec && rec.settlement && rec.settlement.type === "paid_in_full");
}

function normalizeSettlement(raw) {
  if (!raw || typeof raw !== "object" || !TYPES.has(raw.type)) return null;
  return {
    type: raw.type,
    reference: String(raw.reference || "").slice(0, 300),
    by: String(raw.by || ""),
    at: raw.at || null
  };
}

// A technician's copy of any JSON payload: every object carrying a
// `settlement` loses it (and its history lines), and says only that the
// office handles payment. Walks the payload because work orders ride inside
// other responses (a day's schedule, a booking, a completion result).
function techView(payload, depth = 0) {
  if (!payload || typeof payload !== "object" || depth > 8) return payload;
  if (Array.isArray(payload)) return payload.map((x) => techView(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "settlement") continue;
    if (k === "paidInFull") continue;
    out[k] = v && typeof v === "object" ? techView(v, depth + 1) : v;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "settlement") && isPaidInFull(payload)) {
    out.paymentHandledByOffice = true;
    if (Array.isArray(out.history)) out.history = out.history.filter((h) => !String(h?.action || "").startsWith("settlement_"));
  }
  // A completion result (the cascade) tells the tech's app "nothing to
  // collect" without naming why.
  if (payload.paidInFull === true) out.nothingToCollect = true;
  return out;
}

module.exports = { TYPES, isPaidInFull, normalizeSettlement, techView };

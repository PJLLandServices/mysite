// What the customer is signing for — the visit as the customer reads it.
//
// A customer on a driveway, 2026-10-01, signing and paying: "I don't even
// know what I'm signing for." The sign-off screen showed one fee line under
// the signature pad and the invoice screen only a total. This is the page
// Patrick turns the phone around to show.
//
// ONE SOURCE OF NUMBERS, the invoice's own:
//   * Before Finish there is no invoice yet. The lines come from
//     billing.billingFor(wo), the SAME call Finish drafts the invoice from,
//     converted by invoices.draftLinesFrom and totalled by
//     invoices.totalsForLines, exactly as createDraft does. What the
//     customer is shown before signing is the invoice billed after.
//   * After Finish the invoice exists, and it is read as stored: lines,
//     subtotal, HST, total, paid, owing. Nothing is re-derived.
//
// A PRICE PJL CONFIRMS AFTER THE VISIT SHOWS NO NUMBER (PJL-96: a custom
// size, or a commercial account without its own price). The draft carries a
// suggestion for the office; the customer never sees it — not as a line, a
// subtotal or a total, before or after Finish.
//
// What it leaves alone: tech notes (written for next spring's tech, not
// for the customer), photos, and anything internal on the work order. It is
// a pure read: nothing here writes.

const { WO_TYPE_LABELS } = require("./day-schedule");

// The app's repair vocabulary (pjl-field ZoneStage REPAIR_TYPES), as a
// customer reads it.
const REPAIR_LABELS = {
  broken_head: "Sprinkler head",
  leak: "Leak / pipe break",
  valve: "Valve leak",
  zone_revamp: "Zone revamp",
  other: "Other repair"
};

const STATUS_LABELS = {
  working_well: "Checked — working",
  ok: "Checked — working",
  repair_required: "Repair needed next season",
  other: "Checked — see notes with PJL"
};

const AUTHORIZATION = {
  priced: "By signing, you confirm PJL Land Services carried out the work listed here and authorize the charges shown.",
  pending: "By signing, you confirm PJL Land Services carried out the work listed here. PJL confirms the price after the visit and sends the invoice."
};

function zonesFor(wo) {
  return (Array.isArray(wo?.zones) ? wo.zones : [])
    .filter((z) => z && z.number != null)
    .map((z) => {
      const repairs = [...new Set((Array.isArray(z.issues) ? z.issues : [])
        .map((i) => REPAIR_LABELS[i?.type] || null).filter(Boolean))];
      return {
        number: Number(z.number),
        location: String(z.location || z.label || "").trim(),
        statusLabel: z.status ? (STATUS_LABELS[z.status] || "Checked") : "Not checked yet",
        repairs
      };
    })
    .sort((a, b) => a.number - b.number);
}

// Lines as the customer reads them; with no amounts when PJL sets the price.
function customerLines(lines, pending) {
  return (lines || []).map((l) => ({
    label: l.label || "Line",
    qty: Number(l.qty) || 1,
    unitPrice: pending ? null : Number(l.unitPrice) || 0,
    lineTotal: pending ? null : Number(l.lineTotal) || 0
  }));
}

async function customerSummaryFor(wo, deps = {}) {
  const invoices = deps.invoices || require("./invoices");
  const billing = deps.billing || require("./billing");

  const active = (await invoices.listByWorkOrder(wo.id)).find((r) => r && r.status !== "void") || null;
  let money;
  if (active) {
    const pending = active.priceUnconfirmed === true || invoices.isPriceUnconfirmed(active);
    money = {
      source: "invoice",
      invoiceId: active.id,
      invoiceStatus: active.status || null,
      pricePending: pending,
      lines: customerLines(active.lineItems, pending),
      subtotal: pending ? null : Number(active.subtotal) || 0,
      hst: pending ? null : Number(active.hst) || 0,
      total: pending ? null : Number(active.total) || 0,
      amountPaid: pending ? null : Number(active.amountPaid) || 0,
      balanceDue: pending ? null : (active.balanceDue == null ? Number(active.total) || 0 : Number(active.balanceDue) || 0)
    };
  } else {
    const bill = await billing.billingFor(wo);
    const normalized = invoices.draftLinesFrom(bill.lines);
    const confirm = invoices.priceConfirmForLines(bill.lines, normalized);
    const pending = confirm?.required === true || bill.fee?.pending === true;
    const totals = invoices.totalsForLines(normalized);
    money = {
      source: "preview",
      invoiceId: null,
      invoiceStatus: null,
      pricePending: pending,
      noCharge: bill.noCharge === true,
      lines: customerLines(normalized, pending),
      subtotal: pending ? null : totals.subtotal,
      hst: pending ? null : totals.hst,
      total: pending ? null : totals.total,
      amountPaid: pending ? null : 0,
      balanceDue: pending ? null : totals.total
    };
  }

  return {
    workOrderId: wo.id,
    customerName: wo.customerName || "",
    address: wo.address || "",
    serviceLabel: WO_TYPE_LABELS[wo.type] || "Service visit",
    visitDate: wo.completedAt || wo.arrivedAt || wo.scheduledFor || null,
    zones: zonesFor(wo),
    ...money,
    authorization: money.pricePending ? AUTHORIZATION.pending : AUTHORIZATION.priced
  };
}

module.exports = { customerSummaryFor, REPAIR_LABELS, STATUS_LABELS };

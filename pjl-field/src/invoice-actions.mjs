// What the invoice screen may offer, from one rule (P-PJL-22 C).
//
// The phone used to decide "can money be taken here?" inline
// (InvoiceScreen's payableHere), with a copy of the server's rule that only
// knew "Bill later" vs "Paid on site". This is that rule, once, mirroring
// the server's invoices.payBlockReason / openForOnSitePayment /
// switchToCollectNow, so the buttons cannot offer what the server refuses
// or hide what it allows:
//
//   - Collect payment now (paidOnSiteAtCompletion) — Tap to Pay and Take
//     payment now work on the DRAFT; nothing has to be emailed first.
//   - Send invoice / bill later — no payment on the draft until it is
//     sent, or until an admin presses "Take payment now instead"
//     (onSitePayment.openedAt), which opens it exactly like Collect now.
//   - Sent / part paid — payable.
//   - Paid, void, or a price PJL has not confirmed — nothing to collect,
//     nothing to send.
//
// Pure: no React, no network, so scripts/test-collect-payment-now.mjs runs
// it as is.

export function invoiceActions(invoice, { role = null } = {}) {
  const none = { tapToPay: false, takePayment: false, send: false, recordPayment: false, takePaymentInstead: false, billLater: false };
  if (!invoice) return none;
  const owing = Number(invoice.balanceDue);
  const settled = invoice.status === 'paid'
    || (Number(invoice.amountPaid) > 0 && Number.isFinite(owing) && owing <= 0.01);
  if (settled || invoice.status === 'void' || invoice.priceUnconfirmed === true) return none;

  const draft = (invoice.status || 'draft') === 'draft' && !invoice.sentAt;
  const openOnSite = Boolean(invoice.onSitePayment?.openedAt) || invoice.paidOnSiteAtCompletion === true;
  const payable = !draft || openOnSite;
  const billLater = draft && !openOnSite;
  return {
    tapToPay: payable,
    takePayment: payable,
    send: true,
    recordPayment: true,
    takePaymentInstead: billLater && role === 'admin',
    billLater,
  };
}

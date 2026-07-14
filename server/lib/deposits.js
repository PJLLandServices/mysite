// Threshold-deposit invoicing lifecycle (Jul 2026 brief).
//
// Orchestrates the flow that starts when a deposit-enabled quote is
// accepted:
//
//   1. Acceptance      → deposit invoice created + emailed immediately;
//                        amounts snapshotted onto the quote
//                        (stage: awaiting_deposit).
//   2. Deposit paid    → balance invoice created as a HELD draft that
//                        shows the original grand total, the deposit
//                        paid (negative credit line, with date +
//                        invoice reference), and the remaining balance
//                        (stage: deposit_paid). T&M quotes skip this —
//                        their balance can't be known until completion,
//                        so the credit line is appended to the T&M
//                        rollup by the completion cascade instead.
//   3. Completion      → the held balance invoice becomes the project's
//                        final invoice (the cascade reuses it instead of
//                        drafting a new one) and is auto-sent when
//                        settings.deposits.autoSendBalanceOnCompletion
//                        is on (stage: awaiting_balance_payment).
//   4. Deposit voided  → quote reverts to awaiting_deposit and a held
//                        balance invoice is voided + unlinked.
//
// No-deposit quotes are deliberately NOT given an invoice at acceptance:
// the long-standing completion cascade already creates the single final
// invoice when the work completes, which is exactly the "due on
// completion" outcome the brief asks for.
//
// Every entry point is idempotent and failure-tolerant — an email or QB
// hiccup must never un-accept a quote or block a payment recording.

const quotes = require("./quotes");
const invoices = require("./invoices");
const settingsLib = require("./settings");

const HST_RATE = 0.13;
const round2 = (n) => Math.round(n * 100) / 100;
const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The deposit amount is a TAX-INCLUSIVE dollar figure (e.g. 25% of the grand
// total incl. HST), but invoice lines are pre-tax and the invoice module
// adds 13% on top. Find the pre-tax line price whose price+HST rounds to
// exactly the target. For percent deposits this is exact by construction
// (x% of subtotal ×1.13 = x% of total); for odd fixed amounts the ±1¢
// probe catches rounding edges.
function preTaxForTotal(targetTotal) {
  const target = round2(targetTotal);
  const guess = round2(target / (1 + HST_RATE));
  for (const cand of [guess, round2(guess - 0.01), round2(guess + 0.01)]) {
    if (round2(cand + round2(cand * HST_RATE)) === target) return cand;
  }
  return guess; // off by ≤1¢ — the invoice's own total is authoritative
}

function depositValueBit(dep) {
  return dep.type === "fixed" ? fmtMoney(dep.value) : `${Number(dep.value) || 0}%`;
}

async function customerBitsForQuote(q) {
  const bits = {
    customerId: q.customerId || null,
    customerEmail: q.customerEmail || "",
    customerName: "",
    customerPhone: "",
    address: ""
  };
  try {
    const customers = require("./customers");
    const cust = q.customerId
      ? await customers.get(q.customerId, { withProperties: false })
      : (q.customerEmail ? await customers.findByEmail(q.customerEmail) : null);
    if (cust) {
      bits.customerId = bits.customerId || cust.id;
      bits.customerName = cust.name || "";
      bits.customerPhone = cust.phone || "";
      bits.customerEmail = bits.customerEmail || cust.email || "";
    }
  } catch (_) { /* tolerate — invoice still drafts with what the quote has */ }
  try {
    if (q.propertyId) {
      const properties = require("./properties");
      const prop = await properties.get(q.propertyId);
      if (prop?.address) bits.address = prop.address;
    }
  } catch (_) { /* tolerate */ }
  return bits;
}

// Email an invoice to the customer with the pay link — the same recipe
// as POST /api/invoices/:id/send (QB push best-effort → payment token →
// PDF → email → status "sent"), callable from the acceptance hook and
// the completion cascade. Returns { ok, invoice, warning } and NEVER
// throws for QB/send problems: on email failure the invoice simply
// stays draft and the warning says so.
async function sendInvoiceNow(invoiceId, { resend = false } = {}) {
  const inv = await invoices.get(invoiceId);
  if (!inv) return { ok: false, warning: `Invoice ${invoiceId} not found.` };
  if (!resend && inv.status !== "draft") return { ok: true, invoice: inv, alreadySent: true };
  if (!inv.customerEmail) return { ok: false, invoice: inv, warning: `Invoice ${inv.id} has no customer email — send it manually once one is set.` };

  let qbWarning = null;
  let qbInvoiceId = inv.quickbooksInvoiceId || null;
  try {
    const quickbooks = require("./quickbooks");
    if (quickbooks.isConfigured() && (await quickbooks.isConnected())) {
      const result = await quickbooks.pushInvoice(inv);
      qbInvoiceId = result.id;
    }
  } catch (qbErr) {
    qbWarning = `QuickBooks push failed: ${qbErr.message}`;
    console.warn(`[deposits] QB push failed for ${invoiceId}: ${qbErr.message}`);
  }

  try {
    const tokenized = await invoices.ensurePaymentToken(invoiceId);
    const paymentToken = tokenized?.paymentToken || null;
    const renderInv = {
      ...inv,
      quickbooksInvoiceId: qbInvoiceId || inv.quickbooksInvoiceId,
      paymentToken: paymentToken || inv.paymentToken
    };
    const { generateInvoicePdf } = require("./invoice-pdf");
    const pdfBuffer = await generateInvoicePdf(renderInv);
    const { resolvePublicBaseUrl } = require("./public-base-url");
    const viewLink = paymentToken
      ? `${resolvePublicBaseUrl()}/pay/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(paymentToken)}`
      : "";
    const { sendInvoiceToCustomer } = require("./notify-customer");
    await sendInvoiceToCustomer(renderInv, pdfBuffer, { resend, viewLink });
    const patch = {
      status: "sent",
      note: `Emailed to ${inv.customerEmail}${inv.invoiceRole !== "standard" ? ` (${inv.invoiceRole} invoice)` : ""}${qbWarning ? " (QB push failed)" : ""}.`
    };
    if (qbInvoiceId && qbInvoiceId !== inv.quickbooksInvoiceId) patch.quickbooksInvoiceId = qbInvoiceId;
    const updated = await invoices.update(invoiceId, patch);
    return { ok: true, invoice: updated, warning: qbWarning };
  } catch (err) {
    console.warn(`[deposits] send failed for ${invoiceId}: ${err.message}`);
    return { ok: false, invoice: inv, warning: `Invoice ${inv.id} drafted but the email failed (${err.message}) — send it from the invoice page.` };
  }
}

// Acceptance hook. Called after a quote flips to accepted (portal
// e-sign, PDF-return attestation). No-op unless deposit.enabled.
// Creates + sends the deposit invoice, snapshots the amounts, sets
// stage awaiting_deposit. Idempotent via deposit.depositInvoiceId.
async function onQuoteAccepted(quote, { by = "system" } = {}) {
  const q = typeof quote === "string" ? await quotes.get(quote) : quote;
  if (!q || !q.deposit || q.deposit.enabled !== true) return { ok: true, skipped: "no_deposit" };
  if (q.deposit.depositInvoiceId) {
    return { ok: true, alreadyRan: true, depositInvoiceId: q.deposit.depositInvoiceId };
  }

  // Recompute from the stored total — belt-and-suspenders on top of the
  // save-time recompute; this is the figure that gets snapshotted.
  const figures = quotes.computeDepositFigures(q.total, q.deposit);
  if (!(figures.amount > 0)) return { ok: true, skipped: "zero_deposit" };

  const bits = await customerBitsForQuote(q);
  const valueBit = depositValueBit(q.deposit);
  const displayId = (q.quoteNumberDisplay && q.quoteNumberDisplay.trim()) || q.id;
  const preTax = preTaxForTotal(figures.amount);

  const inv = await invoices.createDraft({
    quoteId: q.id,
    propertyId: q.propertyId || null,
    ...bits,
    lineItems: [{
      key: "quote_deposit",
      label: `Deposit — ${valueBit} of quote ${displayId} (total ${fmtMoney(q.total)} incl. HST)`,
      qty: 1,
      price: preTax,
      note: `Deposit ${q.deposit.dueLabel || "due at scheduling"}. Balance of ${fmtMoney(figures.balance)} ${q.deposit.balanceLabel || "due on completion"}.`
    }],
    notes: `Deposit invoice for accepted quote ${q.id}.`,
    invoiceRole: "deposit"
  });

  await quotes.updateDepositLifecycle(q.id, {
    stage: "awaiting_deposit",
    snapshot: { amount: figures.amount, balance: figures.balance, grandTotal: Number(q.total) || 0 },
    depositInvoiceId: inv.id
  }, { by, note: `Deposit invoice ${inv.id} created (${fmtMoney(inv.total)})` });

  const sendResult = await sendInvoiceNow(inv.id);
  return { ok: true, depositInvoice: sendResult.invoice || inv, warning: sendResult.warning || null };
}

// Build the held balance invoice for a fixed-price quote: the original
// line items + a negative deposit-credit line, so the customer sees the
// full job, what they already paid (with date + invoice reference), and
// the remaining balance — and the totals math flows through the normal
// subtotal/HST pipeline.
async function createBalanceInvoice(q, depositInv, { depositPaid = true, projectId = null } = {}) {
  const bits = await customerBitsForQuote(q);
  const displayId = (q.quoteNumberDisplay && q.quoteNumberDisplay.trim()) || q.id;
  const creditLabel = depositPaid
    ? `Less deposit paid — invoice ${depositInv.id}${depositInv.paidAt ? ` (paid ${String(depositInv.paidAt).slice(0, 10)})` : ""}`
    : `Less deposit — invoice ${depositInv.id} (due separately)`;
  const lineItems = [
    ...(Array.isArray(q.lineItems) ? q.lineItems : []).map((li) => ({
      key: li.sourceKey || li.key || "custom",
      label: li.label,
      qty: li.qty,
      price: li.price,
      lineTotal: li.lineTotal,
      note: li.description || li.note || ""
    })),
    {
      key: "deposit_credit",
      label: creditLabel,
      qty: 1,
      price: -Number(depositInv.subtotal || 0),
      lineTotal: -Number(depositInv.subtotal || 0)
    }
  ];
  return invoices.createDraft({
    quoteId: q.id,
    projectId,
    propertyId: q.propertyId || null,
    ...bits,
    lineItems,
    notes: `Balance invoice for quote ${displayId} — original total ${fmtMoney(q.deposit?.snapshot?.grandTotal || q.total)} incl. HST, deposit ${fmtMoney(depositInv.total)}${depositPaid ? " paid" : " invoiced separately"}.`,
    invoiceRole: "balance",
    depositMeta: {
      quoteId: q.id,
      depositInvoiceId: depositInv.id,
      depositAmount: Number(depositInv.total) || 0,
      depositPaidAt: depositInv.paidAt || null,
      grandTotal: Number(q.deposit?.snapshot?.grandTotal) || Number(q.total) || 0
    },
    holdUntilCompletion: true
  });
}

// Paid hook. Call after ANY invoice flips to paid; no-ops unless the
// invoice is a deposit invoice on a deposit-enabled quote. Creates the
// held balance invoice (fixed-price) and moves the stage forward.
async function onInvoicePaid(invoice) {
  const inv = typeof invoice === "string" ? await invoices.get(invoice) : invoice;
  if (!inv || inv.invoiceRole === "balance") {
    // A paid balance invoice closes the loop.
    if (inv && inv.invoiceRole === "balance" && inv.quoteId) {
      try {
        const q = await quotes.get(inv.quoteId);
        if (q?.deposit?.enabled && q.deposit.balanceInvoiceId === inv.id && q.deposit.stage !== "closed") {
          await quotes.updateDepositLifecycle(q.id, { stage: "closed" }, { note: `Balance invoice ${inv.id} paid — paid in full` });
        }
      } catch (err) { console.warn("[deposits] close-stage failed:", err?.message); }
    }
    return { ok: true, skipped: "not_deposit" };
  }
  if (inv.invoiceRole !== "deposit" || !inv.quoteId) return { ok: true, skipped: "not_deposit" };

  const q = await quotes.get(inv.quoteId);
  if (!q || !q.deposit || q.deposit.enabled !== true) return { ok: true, skipped: "quote_missing" };
  if (q.deposit.depositInvoiceId !== inv.id) return { ok: true, skipped: "stale_deposit_invoice" };
  if (q.deposit.balanceInvoiceId) {
    // Balance already exists (e.g. completion override ran first) —
    // just make sure the stage reflects the payment.
    if (q.deposit.stage === "awaiting_deposit") {
      await quotes.updateDepositLifecycle(q.id, { stage: "deposit_paid" }, { note: `Deposit invoice ${inv.id} paid` });
    }
    return { ok: true, alreadyRan: true, balanceInvoiceId: q.deposit.balanceInvoiceId };
  }

  // T&M quotes: the true balance is only knowable at completion (actual
  // hours + materials), so no balance invoice yet — the completion
  // cascade appends the deposit credit to the T&M rollup instead.
  if (q.billingMode === "time_and_material") {
    await quotes.updateDepositLifecycle(q.id, { stage: "deposit_paid" }, {
      note: `Deposit invoice ${inv.id} paid — balance invoiced from the T&M rollup at completion`
    });
    return { ok: true, tAndM: true };
  }

  const balanceInv = await createBalanceInvoice(q, inv, { depositPaid: true });
  await quotes.updateDepositLifecycle(q.id, {
    stage: "deposit_paid",
    balanceInvoiceId: balanceInv.id
  }, { note: `Deposit paid — balance invoice ${balanceInv.id} (${fmtMoney(balanceInv.total)}) created and held until completion` });
  return { ok: true, balanceInvoice: balanceInv };
}

// Void hook. Call after ANY invoice is voided; no-ops unless it's the
// quote's live deposit invoice. Reverts the stage to awaiting_deposit
// and voids + unlinks a still-held balance invoice (§6: "deposit invoice
// voided → revert status and remove any held balance invoice").
async function onInvoiceVoided(invoice) {
  const inv = typeof invoice === "string" ? await invoices.get(invoice) : invoice;
  if (!inv || inv.invoiceRole !== "deposit" || !inv.quoteId) return { ok: true, skipped: "not_deposit" };
  const q = await quotes.get(inv.quoteId);
  if (!q?.deposit?.enabled || q.deposit.depositInvoiceId !== inv.id) return { ok: true, skipped: "not_linked" };

  if (q.deposit.balanceInvoiceId) {
    try {
      const bal = await invoices.get(q.deposit.balanceInvoiceId);
      if (bal && bal.status === "draft") {
        await invoices.voidInvoice(bal.id, { reason: `Deposit invoice ${inv.id} was voided — balance invoice withdrawn.`, by: "system" });
      }
    } catch (err) { console.warn("[deposits] balance void failed:", err?.message); }
  }
  await quotes.updateDepositLifecycle(q.id, {
    stage: "awaiting_deposit",
    balanceInvoiceId: null
  }, { note: `Deposit invoice ${inv.id} voided — reverted to awaiting deposit; held balance invoice removed` });
  return { ok: true };
}

// Completion helper for the project-final cascade. Returns the deposit
// context for a project's source quote, or null when deposits aren't in
// play (covers legacy quotes and disabled deposits).
async function depositContextForQuote(sourceQuoteId) {
  if (!sourceQuoteId) return null;
  try {
    const q = await quotes.get(sourceQuoteId);
    if (!q?.deposit || q.deposit.enabled !== true) return null;
    let depositInv = null;
    let balanceInv = null;
    if (q.deposit.depositInvoiceId) depositInv = await invoices.get(q.deposit.depositInvoiceId);
    if (q.deposit.balanceInvoiceId) balanceInv = await invoices.get(q.deposit.balanceInvoiceId);
    return { quote: q, deposit: q.deposit, depositInvoice: depositInv, balanceInvoice: balanceInv };
  } catch (err) {
    console.warn("[deposits] context lookup failed:", err?.message);
    return null;
  }
}

async function autoSendBalanceEnabled() {
  try {
    const s = await settingsLib.get();
    return s?.deposits?.autoSendBalanceOnCompletion === true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  preTaxForTotal,
  sendInvoiceNow,
  onQuoteAccepted,
  onInvoicePaid,
  onInvoiceVoided,
  createBalanceInvoice,
  depositContextForQuote,
  autoSendBalanceEnabled
};

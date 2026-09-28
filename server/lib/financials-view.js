// server/lib/financials-view.js
//
// The read model behind the project workspace's Financials tab (step 5 of
// the Project Workspace PRD, 2026-09-28). Read-only: the tab shows this and
// acts on nothing — recording a payment, sending, revising or voiding an
// invoice stay on the classic invoice pages until this screen has been
// walked on a real job (PRD R5; decision 4, "does raise the invoice live
// here?", is answered read-first, as Change Orders was).
//
// Every figure and sentence the tab shows is decided HERE, from rules that
// already exist, so the screen can never draw a second answer:
//
//   which invoices are the job's   → projects.invoicesForProject (Fix B)
//   whether one counts at all      → projects.isLiveInvoice (void never does)
//   what each one has received/owes → the invoice's own ledger-derived
//                                    amountPaid / balanceDue
//   the signed contract            → projects.describeAgreement
//   the deposit and where it stands → quote.deposit (Fix A keeps it honest)
//   what the job would bill today  → the billing preview the final invoice
//                                    bills from (Fix B: one parts catalog)
//   what is holding billing        → projects.completionPreflight's own
//                                    blockers, passed in, never re-derived
//
// Pure: describeFinancials() takes records and returns the model, so a test
// can run it over any fixture. Money is added up in cents.

const cents = (n) => Math.round((Number(n) || 0) * 100);
const dollars = (c) => Math.round(c) / 100;
const fmt = (n) => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_LABEL = {
  draft: "Draft — not sent",
  sent: "Sent",
  partially_paid: "Part paid",
  paid: "Paid",
  void: "Void"
};
const ROLE_LABEL = { deposit: "Deposit", balance: "Balance", standard: "Invoice" };
const DEPOSIT_STAGE_LABEL = {
  awaiting_deposit: "Waiting for the deposit",
  deposit_paid: "Deposit paid",
  awaiting_balance_payment: "Balance invoiced — waiting for payment",
  closed: "Paid in full"
};
// The completion checks that are about money. Anything else (tasks, the
// final work order, …) belongs to the Overview.
const MONEY_BLOCKERS = new Set([
  "deposit_unpaid",
  "deposit_balance_predates_revision",
  "revision_unsigned",
  "approved_scr_no_revision",
  "no_labour_rate"
]);

function invoiceRow(inv, { finalInvoiceId, methodLabels }) {
  const live = inv.status !== "void";
  const issued = live && inv.status !== "draft";
  const held = live && inv.status === "draft" && inv.holdUntilCompletion === true;
  const role = inv.invoiceRole || "standard";
  const isFinal = finalInvoiceId && inv.id === finalInvoiceId;
  const openExceptions = (inv.paymentExceptions || []).filter((e) => e && e.status === "open");
  // "Paid" is the office's word as well as the ledger's: an invoice marked
  // paid owes nothing, and when the recorded payments fall short of it the
  // tab says so rather than calling the difference owed.
  const unrecordedC = inv.status === "paid" ? Math.max(0, cents(inv.total) - cents(inv.amountPaid)) : 0;
  let note = null;
  if (!live) note = "Void — not owed, kept for the record.";
  else if (held) note = "Held until the job is complete — not sent to the customer yet.";
  else if (inv.status === "draft") note = "A draft — not sent to the customer yet.";
  else if (unrecordedC > 0) note = `Marked paid — ${fmt(dollars(unrecordedC))} of it isn't recorded as a payment.`;
  if (openExceptions.length) {
    note = `${note ? `${note} ` : ""}${openExceptions.length === 1 ? "A payment" : `${openExceptions.length} payments`} on this invoice need reconciling.`;
  }
  return {
    id: inv.id,
    role,
    roleLabel: isFinal && role === "standard" ? "Final invoice" : (ROLE_LABEL[role] || "Invoice"),
    status: inv.status,
    statusLabel: held ? "Held until completion" : (STATUS_LABEL[inv.status] || inv.status),
    live,
    issued,
    held,
    total: dollars(cents(inv.total)),
    amountPaid: dollars(cents(inv.amountPaid)),
    // A void invoice owes nothing, whatever its arithmetic says; nor does
    // one marked paid.
    owed: live && inv.status !== "paid" ? dollars(cents(inv.balanceDue)) : 0,
    createdAt: inv.createdAt || null,
    sentAt: inv.sentAt || null,
    paidAt: inv.paidAt || null,
    needsReconciliation: openExceptions.length > 0,
    payments: (inv.payments || []).map((p) => ({
      id: p.id,
      invoiceId: inv.id,
      amount: dollars(cents(p.amount)),
      method: p.method,
      methodLabel: methodLabels[p.method] || p.method || "Payment",
      receivedAt: p.receivedAt || null
    })),
    note,
    href: `/admin/invoice/${encodeURIComponent(inv.id)}`
  };
}

function depositFor(quote, rows) {
  const dep = quote?.deposit;
  if (!dep || dep.enabled !== true || !dep.stage) return null;
  const amount = dollars(cents(dep.snapshot?.amount ?? dep.amount));
  const inv = rows.find((r) => r.id === dep.depositInvoiceId) || null;
  const stageLabel = DEPOSIT_STAGE_LABEL[dep.stage] || dep.stage;
  let sentence;
  if (!inv) {
    sentence = `A deposit of ${fmt(amount)} is due, but its invoice isn't on this job.`;
  } else if (!inv.live) {
    sentence = `The deposit invoice ${inv.id} was voided — no deposit is being collected.`;
  } else if (dep.stage === "awaiting_deposit") {
    sentence = inv.amountPaid > 0
      ? `Deposit of ${fmt(amount)}: ${fmt(inv.amountPaid)} received on ${inv.id}, ${fmt(inv.owed)} still owed. It counts once it is paid in full.`
      : `Deposit of ${fmt(amount)} on ${inv.id} — ${inv.issued ? "sent, not paid yet" : "not sent yet"}.`;
  } else {
    sentence = `Deposit of ${fmt(amount)} paid on ${inv.id}${inv.paidAt ? ` (${String(inv.paidAt).slice(0, 10)})` : ""}.`;
  }
  return {
    amount,
    stage: dep.stage,
    stageLabel,
    counted: dep.stage !== "awaiting_deposit",
    invoiceId: inv ? inv.id : dep.depositInvoiceId || null,
    balanceInvoiceId: dep.balanceInvoiceId || null,
    sentence
  };
}

function previewFor(billing) {
  if (!billing) return null;
  if (billing.error) {
    return { billingMode: billing.billingMode || null, error: billing.error, code: billing.code || null };
  }
  const tm = billing.billingMode === "time_and_material";
  return {
    billingMode: billing.billingMode,
    subtotal: dollars(cents(billing.subtotal)),
    hst: dollars(cents(billing.hst)),
    total: dollars(cents(billing.total)),
    totalHours: tm ? Number(billing.totalHours) || 0 : null,
    rate: tm ? Number(billing.rate) || 0 : null,
    unknownSkus: Array.isArray(billing.unknownSkus) ? billing.unknownSkus : [],
    lineItems: (billing.lineItems || []).map((li) => ({
      label: li.label,
      qty: Number(li.qty) || 0,
      price: dollars(cents(li.price)),
      lineTotal: dollars(cents(li.lineTotal))
    })),
    note: billing.note || null
  };
}

// The model. Inputs are the records the route read; nothing here reads a
// store.
function describeFinancials({ project, agreement, invoices = [], depositQuote = null, billing = null, blockers = [], methodLabels = {} }) {
  const proj = project || {};
  const tm = proj.billingMode === "time_and_material";
  const rows = invoices.map((inv) => invoiceRow(inv, { finalInvoiceId: proj.finalInvoiceId || null, methodLabels }));
  const live = rows.filter((r) => r.live);
  const issued = live.filter((r) => r.issued);
  const drafts = live.filter((r) => !r.issued);

  const invoicedC = issued.reduce((s, r) => s + cents(r.total), 0);
  const receivedC = live.reduce((s, r) => s + cents(r.amountPaid), 0);
  const owedC = issued.reduce((s, r) => s + cents(r.owed), 0);
  const draftC = drafts.reduce((s, r) => s + cents(r.total), 0);

  const governing = agreement?.governing || null;
  // "Not yet invoiced" is only a fact on a fixed-price job with a signed
  // contract: a T&M job's total is known from its hours at completion.
  const notYetInvoiced = !tm && governing ? dollars(Math.max(0, cents(governing.total) - invoicedC)) : null;

  const payments = live
    .flatMap((r) => r.payments)
    .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));

  const holds = (blockers || []).filter((b) => b && MONEY_BLOCKERS.has(b.key)).map((b) => ({ key: b.key, message: b.message }));
  const reconcile = rows.filter((r) => r.needsReconciliation).map((r) => r.id);

  return {
    projectId: proj.id || null,
    billingMode: tm ? "time_and_material" : "fixed_price",
    billingModeLabel: tm ? "Time & materials" : "Fixed price",
    contract: governing ? {
      id: governing.id,
      version: governing.version,
      subtotal: governing.subtotal,
      total: governing.total,
      href: governing.href
    } : null,
    pendingRevision: agreement?.pending ? { id: agreement.pending.id, total: agreement.pending.total } : null,
    totals: {
      invoiced: dollars(invoicedC),
      received: dollars(receivedC),
      owed: dollars(owedC),
      notYetInvoiced,
      drafts: { count: drafts.length, total: dollars(draftC) },
      issuedCount: issued.length,
      voidCount: rows.length - live.length
    },
    deposit: depositFor(depositQuote, rows),
    invoices: rows,
    payments,
    reconcile,
    preview: previewFor(billing),
    holds,
    classicHref: proj.id ? `/admin/project/${encodeURIComponent(proj.id)}` : null
  };
}

// The job's billing in one line — the workspace header's "Billing" card
// and its next-action prompt (2026-09-28). Decided from the SAME model the
// Financials tab shows, so the header can never say "$3,390 outstanding"
// for a held balance invoice the tab says nobody owes yet.
//   none     — nothing invoiced
//   owed     — money owed on invoices sent to the customer
//   settled  — nothing owed now, but more of the job is still to invoice
//              or to send (a paid deposit, a held balance)
//   paid     — everything invoiced is paid and nothing is left to invoice
// actionInvoice: the invoice the next step is about — the oldest sent one
// still owing, else an unsent (not held) draft for the office to send.
function billingSummary(model) {
  const t = model.totals;
  const live = model.invoices.filter((r) => r.live);
  const owing = live.find((r) => r.issued && r.owed > 0);
  const toSend = live.find((r) => !r.issued && !r.held && r.total > 0);
  const action = owing || toSend || null;
  const paidDates = live.filter((r) => r.paidAt).map((r) => r.paidAt).sort();
  const lastPaid = paidDates.length ? paidDates[paidDates.length - 1] : null;
  const leftToInvoice = t.notYetInvoiced !== null && t.notYetInvoiced > 0;
  let kind;
  let hint;
  if (!live.length) {
    kind = "none";
    hint = "not invoiced yet";
  } else if (t.owed > 0) {
    kind = "owed";
    hint = leftToInvoice ? `owed now · ${fmt(t.notYetInvoiced)} not invoiced yet` : "owed now";
  } else if (leftToInvoice || live.some((r) => !r.issued)) {
    kind = "settled";
    hint = `${fmt(t.received)} received · ${leftToInvoice ? `${fmt(t.notYetInvoiced)} not invoiced yet` : "the rest not sent yet"}`;
  } else {
    kind = "paid";
    hint = lastPaid ? `paid in full · ${String(lastPaid).slice(0, 10)}` : "nothing owed";
  }
  const lastPaidInvoice = live.find((r) => r.paidAt === lastPaid) || null;
  return {
    kind,
    owed: t.owed,
    received: t.received,
    hint,
    // Shaped like the workspace's InvoiceSummary, for the next-action rule.
    actionInvoice: action ? {
      id: action.id, status: action.status, invoiceRole: action.role,
      total: action.total, amountPaid: action.amountPaid, balanceDue: action.owed, paidAt: action.paidAt
    } : kind === "paid" && lastPaidInvoice ? {
      id: lastPaidInvoice.id, status: "paid", invoiceRole: lastPaidInvoice.role,
      total: lastPaidInvoice.total, amountPaid: lastPaidInvoice.amountPaid, balanceDue: 0, paidAt: lastPaid
    } : null
  };
}

module.exports = { describeFinancials, billingSummary, MONEY_BLOCKERS, STATUS_LABEL, DEPOSIT_STAGE_LABEL };

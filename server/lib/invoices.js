// Invoices — drafted automatically by the WO completion cascade
// (spec §4.3.4). Local-only for now: ID, line items snapshotted from the
// WO, totals (subtotal + HST), status. QuickBooks sync is a future slice
// — when it lands, this module stores the QB invoice ID + sync timestamps
// alongside the local draft.
//
// ID format: I-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN and
// P-YYYY-NNNN for visual consistency.
//
// Status enum:
//   draft      — created by completion cascade, not yet sent
//   sent       — emailed to customer (or printed/handed over)
//   paid       — payment recorded
//   void       — cancelled (audit-trail kept)
//
// Storage: server/data/invoices.json. Same flat-file pattern; rotate
// to SQLite at ~10k.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "invoices.json");
const { writeJsonAtomic, serialize, parseJsonArrayStore } = require("./atomic-json");
// Tombstone log for hard-deleted void invoices (feature-invoice-void-delete-
// brief.md, 2026-07). Append-only, never pruned, never edited. Deliberately
// EXCLUDED from the customer-delete referential scan (that scan lists files
// explicitly in customers.hardDelete — this file is not among them), so a
// tombstone can never re-block deleting the customer it belonged to.
const DELETED_FILE = path.join(__dirname, "..", "data", "deleted-invoices.json");
const HST_RATE = 0.13;

const STATUSES = ["draft", "sent", "partially_paid", "paid", "void"];

// Payment methods. card_qb is the online QuickBooks card charge; klarna is
// a Klarna-via-Stripe capture (PJL-34) — recorded automatically when an
// admin captures a financing authorization, same as card_qb is recorded
// automatically by the Stripe pay-page flow. The rest are recorded by
// hand after the money arrives some other way.
const PAYMENT_METHODS = ["cash", "e_transfer", "cheque", "card_qb", "klarna", "other"];
const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  e_transfer: "e-Transfer",
  cheque: "Cheque",
  card_qb: "Card",
  klarna: "Klarna (financed)",
  other: "Other"
};

// Money helper — every amount in this module rounds to cents the same way.
// Float drift on a balance is the difference between "$0.00 due" and a
// customer being asked to pay one more cent.
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Normalize one payment record. Amounts are forced positive: a refund or a
// correction is a DELETE of the payment, not a negative amount, so the
// ledger can never silently net out to something unexplainable.
// Accompanying-letter shape. `enabled` is the deliberate on/off switch:
// a body can sit saved on the record without being attached to anything,
// so drafting one is never the same act as deciding to send it.
function normalizeLetter(raw) {
  if (!raw || typeof raw !== "object") {
    return { enabled: false, subject: "", body: "", updatedAt: null, updatedBy: null };
  }
  return {
    enabled: raw.enabled === true,
    subject: String(raw.subject || "").trim().slice(0, 200),
    body: String(raw.body || "").slice(0, 20000),
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null
  };
}

// Work-order report attachment (Aug 2026). The customer already receives
// this PDF when the visit completes; this is the option to send it AGAIN
// alongside the invoice, for the case where the invoice is the thing they
// actually open.
//
// Same `enabled` discipline as the letter: choosing which report and
// deciding to attach it are two separate acts, so a selection can sit on
// the record without being sent. Off unless ticked — an invoice never
// grows an attachment on its own.
//
// woId + snapshotId together name ONE frozen render. Storing the snapshot
// id rather than "the latest" is deliberate: what gets attached must be
// the copy that was chosen, not whatever the work order has re-rendered
// since.
function normalizeWoReport(raw) {
  if (!raw || typeof raw !== "object") {
    return { enabled: false, woId: null, snapshotId: null, updatedAt: null, updatedBy: null };
  }
  const woId = String(raw.woId || "").trim() || null;
  const snapshotId = String(raw.snapshotId || "").trim() || null;
  return {
    // Enabled is only meaningful with something to attach — a tick with no
    // snapshot behind it would send an invoice that silently lost its
    // report.
    enabled: raw.enabled === true && Boolean(woId) && Boolean(snapshotId),
    woId,
    snapshotId,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null
  };
}

function normalizePayment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const amount = round2(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const method = PAYMENT_METHODS.includes(raw.method) ? raw.method : "other";
  return {
    id: String(raw.id || "").trim() || ("pmt_" + crypto.randomBytes(4).toString("hex")),
    amount,
    method,
    receivedAt: raw.receivedAt || new Date().toISOString(),
    receivedBy: String(raw.receivedBy || "admin").slice(0, 80),
    notes: String(raw.notes || "").slice(0, 500)
  };
}

// Sum of recorded payments. Single source of truth for "how much has come in".
function amountPaidOf(inv) {
  const list = Array.isArray(inv?.payments) ? inv.payments : [];
  return round2(list.reduce((a, p) => a + (Number(p?.amount) || 0), 0));
}

// What the customer still owes — and therefore what the pay-online page is
// allowed to charge. Never negative: an overpayment shows as $0 due, not a
// negative charge.
function balanceDueOf(inv) {
  return Math.max(0, round2((Number(inv?.total) || 0) - amountPaidOf(inv)));
}

// Derive the status from the money, without clobbering the states that
// aren't about money (draft / void) or regressing a manual "paid".
// Tolerance: a balance within a cent counts as settled.
function statusForPayments(inv, currentStatus) {
  if (currentStatus === "void") return currentStatus;
  // A draft paid IN FULL is paid — the money is in, and "Draft — not sent
  // yet" with Send and Take payment still live invited a second charge
  // (fall-closing fix #3). A PART-paid draft stays a draft: Patrick still
  // reviews and sends it, and the send-time re-derive picks up the money.
  // A NEVER-SENT invoice (a draft, or one that left draft only because
  // money covered it) is paid when the money covers it and a draft
  // otherwise. So a payment deleted or corrected down puts it back in
  // Patrick's drafts for review — it used to read "paid" with $0 received,
  // or "partially_paid", which /send refuses (fall-closing #3, round 2).
  const neverSent = !inv?.sentAt && (currentStatus === "draft" || currentStatus === "paid" || currentStatus === "partially_paid");
  if (neverSent) {
    const total = Number(inv?.total) || 0;
    return total > 0 && amountPaidOf(inv) >= round2(total - 0.01) ? "paid" : "draft";
  }
  const paid = amountPaidOf(inv);
  const total = Number(inv?.total) || 0;
  if (paid <= 0) return currentStatus === "partially_paid" ? "sent" : currentStatus;
  if (paid >= round2(total - 0.01)) return "paid";
  return "partially_paid";
}

// Invoice disclaimers — keyed by stable slug, rendered verbatim below
// the line items in both the admin editor and the customer PDF.
// (feature-per-property-seasonal-pricing-brief.md §3.6 + §3.7).
// Adding a new disclaimer means adding one key + body here; the
// rendering surfaces look the array up by slug.
//
// The fall_additional_plumbing disclaimer is attached by the completion
// cascade when a fall_closing WO completes for a property flagged with
// seasonalPricing.hasAdditionalFallBlowout === true. The text is
// Patrick's verbatim language (tightened em-dashes, "cabana / additional"
// spacing fixed) — do not paraphrase.
const INVOICE_DISCLAIMERS = {
  fall_additional_plumbing: {
    title: "Fall Closing Notice — Additional Plumbing / Cabana Blow-Out",
    body:
      "We would like to confirm that the fall closing of the cabana / additional " +
      "plumbing attached to your sprinkler system water main has been completed. " +
      "While PJL Land Services possesses extensive knowledge of plumbing systems " +
      "and best practices for ensuring an efficient and thorough closing, we must " +
      "inform you that we cannot assume liability for any issues that may arise " +
      "over the winter months."
  }
};

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

// A damaged file THROWS rather than reading as [] — an empty answer
// would let the next save write a one-invoice file over all of them.
async function readAll() {
  await ensureFile();
  const raw = await fs.readFile(FILE, "utf8");
  return parseJsonArrayStore(raw, FILE).map(hydrate);
}

// Atomic write: stage to .tmp, rename over the real file. Prevents a
// partial invoices.json if the process dies mid-write — matters more now
// that remove() rewrites the file after appending a tombstone (a torn
// invoices.json with an already-written tombstone would be recoverable,
// but a torn write on any path is worth avoiding). Matches parts.js.
//
// The temp name used to be a fixed `invoices.json.tmp`: two writes in the
// same tick shared it, and one rename failed ENOENT. writeJsonAtomic gives
// every write its own temp file, and withStoreLock (module.exports)
// serializes each read-modify-write so neither save erases the other.
async function writeAll(records) {
  await ensureFile();
  await writeJsonAtomic(FILE, records);
}
const withStoreLock = (fn) => (...args) => serialize(FILE, () => fn(...args));

// Append one entry to the tombstone log, atomically. Read-modify-write
// under the same flat-file model as the rest of the module; the log is
// tiny (deletions are rare + deliberate) so the full-rewrite cost is a
// non-issue. Throws on any failure so remove() can abort BEFORE it
// touches invoices.json — no deletion without an audit record.
async function appendDeletedTombstone(entry) {
  await fs.mkdir(path.dirname(DELETED_FILE), { recursive: true });
  let existing = [];
  try {
    const raw = await fsSync.existsSync(DELETED_FILE)
      ? await fs.readFile(DELETED_FILE, "utf8")
      : "[]";
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    // A corrupt/unreadable tombstone file must not silently swallow the
    // new record — surface it so the delete aborts and the operator can
    // look, rather than overwriting a damaged audit log.
    throw new Error("deleted-invoices.json is unreadable — aborting delete to protect the audit log.");
  }
  existing.push(entry);
  const tmp = DELETED_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
  await fs.rename(tmp, DELETED_FILE);
}

function hydrate(inv) {
  // Derive the money once per read. amountPaid / balanceDue are always
  // recomputed from the ledger, so a stale value written into invoices.json
  // (by an older build, or by hand) self-heals on the next read.
  const normalizedPayments = Array.isArray(inv?.payments)
    ? inv.payments.map(normalizePayment).filter(Boolean)
    : [];
  const paidSoFar = round2(normalizedPayments.reduce((a, p) => a + p.amount, 0));
  const out = {
    id: inv?.id || "",
    woId: inv?.woId || null,
    quoteId: inv?.quoteId || null,
    // projectId — written by createDraft since the project cascade, but
    // previously dropped by this read normalizer. Passed through so the
    // portal can attach a project's deposit/final invoices to its card
    // (JOB-002 Part B). Pure passthrough; nothing money-related derives
    // from it.
    projectId: inv?.projectId || null,
    propertyId: inv?.propertyId || null,
    customerId: inv?.customerId || null,
    customerName: inv?.customerName || "",
    customerEmail: inv?.customerEmail || "",
    customerPhone: inv?.customerPhone || "",
    address: inv?.address || "",
    // Bill-to snapshot (billing-party brief §3.3). Set once at draft time
    // by createDraft — override-or-fallback from the customer record's
    // billingName/billingAddress/billingEmail. The PDF and the QB push
    // read THIS, never the live customer. null on legacy invoices, which
    // fall back to the flat customer* fields everywhere (no behaviour
    // change). Editable via update() only while status === "draft".
    billTo: inv?.billTo && typeof inv.billTo === "object" ? {
      name: String(inv.billTo.name || ""),
      // careOf — the party the invoice is addressed THROUGH (management
      // company on a commercial c/o account). Renders as a "c/o …" line
      // under the entity name. Empty on residential / direct-billed.
      careOf: String(inv.billTo.careOf || ""),
      address: String(inv.billTo.address || ""),
      email: String(inv.billTo.email || ""),
      // ccEmail — an extra address copied on the invoice email (bookkeeper
      // / per-site accounts payable). Snapshotted here with the rest of the
      // envelope, so a later edit to the property's or customer's CC never
      // changes who was copied on an invoice that already went out.
      // Absent on invoices drafted before the addendum → "" → no CC.
      ccEmail: String(inv.billTo.ccEmail || "")
    } : null,
    status: STATUSES.includes(inv?.status) ? inv.status : "draft",
    // Threshold-deposit brief (Jul 2026). invoiceRole distinguishes the
    // deposit invoice (sent at acceptance) and the balance invoice
    // (created when the deposit is paid, held to completion) from
    // ordinary invoices. depositMeta is the balance invoice's display
    // record of the deposit already paid — original grand total, deposit
    // amount, date, and the deposit invoice id. holdUntilCompletion
    // blocks /send until the project-completion cascade clears it.
    invoiceRole: ["standard", "deposit", "balance"].includes(inv?.invoiceRole) ? inv.invoiceRole : "standard",
    depositMeta: inv?.depositMeta && typeof inv.depositMeta === "object" ? {
      quoteId: inv.depositMeta.quoteId || null,
      depositInvoiceId: inv.depositMeta.depositInvoiceId || null,
      depositAmount: Number(inv.depositMeta.depositAmount) || 0,
      depositPaidAt: inv.depositMeta.depositPaidAt || null,
      grandTotal: Number(inv.depositMeta.grandTotal) || 0
    } : null,
    holdUntilCompletion: inv?.holdUntilCompletion === true,
    // Accompanying letter (repair summary / report). Optional prose that
    // rides along with the invoice email as a second PDF attachment on
    // PJL letterhead. Carries NO financial content — it never touches
    // line items, totals, tax or the QuickBooks push, and an invoice
    // without one behaves exactly as before.
    letter: normalizeLetter(inv?.letter),
    // Optional second attachment: the frozen work-order report. See
    // normalizeWoReport — off unless deliberately ticked.
    woReport: normalizeWoReport(inv?.woReport),
    lineItems: Array.isArray(inv?.lineItems) ? inv.lineItems : [],
    subtotal: Number(inv?.subtotal) || 0,
    hst: Number(inv?.hst) || 0,
    total: Number(inv?.total) || 0,
    currency: inv?.currency || "CAD",
    notes: inv?.notes || "",
    // Payment ledger (Jul 2026). Append-only in practice: corrections go
    // through PATCH/DELETE on a specific payment id so the audit trail keeps
    // its shape. amountPaid / balanceDue are DERIVED on every read rather
    // than stored, so a hand-edited invoices.json can never leave a balance
    // that disagrees with its own ledger. balanceDue is what the pay-online
    // page is allowed to charge — never `total`.
    payments: normalizedPayments,
    amountPaid: paidSoFar,
    balanceDue: Math.max(0, round2((Number(inv?.total) || 0) - paidSoFar)),
    quickbooksInvoiceId: inv?.quickbooksInvoiceId || null,
    paymentToken: inv?.paymentToken || null,
    quickbooksChargeId: inv?.quickbooksChargeId || null,
    quickbooksPaymentId: inv?.quickbooksPaymentId || null,
    // Stripe migration (Jul 2026): Stripe processes the card; QuickBooks
    // stays the ledger (quickbooksInvoiceId/quickbooksPaymentId above are
    // still live — the QBO Payment record is still created after a
    // successful Stripe charge). stripePaymentIntentId is the open
    // intent for this invoice — persisted so a page reload reuses one
    // intent instead of minting chargeable duplicates, and so the paid
    // flip can verify the intent it expects. stripeChargeId is the
    // settled charge (ch_/py_) from the successful payment.
    stripePaymentIntentId: inv?.stripePaymentIntentId || null,
    // The open Tap to Pay on iPhone intent (card_present), on its own slot
    // because the pay page's `card` intent is a different kind.
    stripeTerminalIntentId: inv?.stripeTerminalIntentId || null,
    stripeChargeId: inv?.stripeChargeId || null,
    sentAt: inv?.sentAt || null,
    paidAt: inv?.paidAt || null,
    voidedAt: inv?.voidedAt || null,
    // Void audit (feature-invoice-void-delete-brief.md). Set together by
    // voidInvoice(). voidReason is optional per Patrick's steer — the
    // mandatory reason lives on the DELETE step / tombstone, not here.
    voidedBy: inv?.voidedBy || null,
    voidReason: inv?.voidReason || "",
    // Price revisions (invoice-revise, Sep 2026). Each entry is a
    // snapshot of what the customer was previously shown so the
    // original document is never lost. Only sent / partially_paid
    // invoices can be revised (see revise()). revisedAt = ts of the
    // latest revision. notifiedAt on an entry = when the "revised
    // invoice" email/SMS went out for it (null until Patrick clicks
    // Send revised invoice).
    revisions: Array.isArray(inv?.revisions) ? inv.revisions.map((r) => ({
      ts: r?.ts || null,
      by: r?.by || "admin",
      reason: String(r?.reason || ""),
      previousLineItems: Array.isArray(r?.previousLineItems) ? r.previousLineItems : [],
      previousSubtotal: Number(r?.previousSubtotal) || 0,
      previousHst: Number(r?.previousHst) || 0,
      previousTotal: Number(r?.previousTotal) || 0,
      newTotal: Number(r?.newTotal) || 0,
      notifiedAt: r?.notifiedAt || null
    })) : [],
    revisedAt: inv?.revisedAt || null,
    // Whether the originating WO had paidOnSite=true at cascade time.
    // Persisted so the customer email + the invoice page can reshape
    // copy ("Thanks, payment received in the field") vs the default
    // "Invoice attached, due in N days." Patrick still reviews before
    // sending or marking paid — this flag is informational, not a
    // status accelerant. Brief C / spec §4.3.2.
    paidOnSiteAtCompletion: inv?.paidOnSiteAtCompletion === true,
    // Opened for payment ON SITE by signed-in staff (fall-closing fix #3).
    // Stamped by openForOnSitePayment() only; its presence is what lets a
    // DRAFT be paid on the customer's pay page. null = never opened.
    onSitePayment: (inv?.onSitePayment && typeof inv.onSitePayment === "object" && inv.onSitePayment.openedAt)
      ? { openedAt: String(inv.onSitePayment.openedAt), by: String(inv.onSitePayment.by || "") }
      : null,
    // Invoice-ready SMS scheduling (Invoice SMS brief, May 2026).
    // customerSmsScheduledAt — when the SMS should fire (set by cascade);
    //   null means "no SMS scheduled" (paid-on-site, opted out, etc.).
    // customerSmsSentAt — when the SMS actually fired. Idempotency gate.
    // portalToken — gates /api/portal/invoice/:id?t=<token> read-only view.
    //   Separate from paymentToken (which gates the embedded payment
    //   page) so the surfaces have independent secrets.
    customerSmsScheduledAt: inv?.customerSmsScheduledAt || null,
    customerSmsSentAt: inv?.customerSmsSentAt || null,
    portalToken: inv?.portalToken || null,
    // Disclaimer keys (not text — text lives in INVOICE_DISCLAIMERS).
    // Dedupe via Set on read so re-fires can never produce duplicates.
    // Unknown keys are silently dropped — adding a new disclaimer
    // requires adding its text to the constant first, otherwise the
    // rendering surfaces would render an empty block.
    disclaimers: Array.isArray(inv?.disclaimers)
      ? Array.from(new Set(inv.disclaimers.filter((k) => typeof k === "string" && INVOICE_DISCLAIMERS[k])))
      : [],
    // Card-charge attempt log (QB Payments AVS brief, Jul 2026).
    // Append-only, never pruned (Hard Rule 4). EVERY call to the QB
    // Payments charges API lands here — success and failure alike —
    // carrying Intuit's error code, verbatim message, and `intuitTid`.
    // Before this existed a failed charge left no trace anywhere Patrick
    // could see: the customer said "it won't go through" and there was
    // nothing to look at but Render logs. Written only by
    // appendPaymentAttempt(); update()'s allowlist deliberately excludes
    // it so no ordinary patch can rewrite the log.
    paymentAttempts: Array.isArray(inv?.paymentAttempts) ? inv.paymentAttempts : [],
    // PJL-96: a price PJL has not set yet. Written by createDraft when the
    // seasonal fee line arrives as a SUGGESTION (a custom size, or a
    // commercial account with no price of its own); confirmed by
    // confirmPrice(). null for every other invoice.
    priceConfirm: normalizePriceConfirm(inv?.priceConfirm),
    // The work order behind this invoice changed in price after the
    // customer accepted it and awaits their new signature (Patrick,
    // 2026-09-26). While set, nothing is payable, sent or texted. Written
    // only by setScopeHold(), driven by workOrders.awaitsNewSignature.
    scopeHold: inv?.scopeHold && inv.scopeHold.since ? { woId: inv.scopeHold.woId || null, since: inv.scopeHold.since } : null,
    createdAt: inv?.createdAt || new Date().toISOString(),
    updatedAt: inv?.updatedAt || new Date().toISOString(),
    history: Array.isArray(inv?.history) ? inv.history : []
  };
  // Derived, never stored: the one answer every surface reads.
  out.priceUnconfirmed = isPriceUnconfirmed(out);
  return out;
}

// ---- Price confirmation (PJL-96) --------------------------------------
//
// Patrick's rulings: a custom size (16+ residential, 9+ commercial) and a
// commercial account without its own price are priced BY PATRICK. The
// invoice drafts with a suggested amount prefilled (pricing.
// suggestSeasonalPrice) and flagged; until he confirms it the invoice is
// never payable, never sent and never texted.
function normalizePriceConfirm(raw) {
  if (!raw || typeof raw !== "object" || raw.required !== true) return null;
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : round2(Number(v)));
  return {
    required: true,
    reason: raw.reason === "commercial_unpriced" ? "commercial_unpriced" : "custom_size",
    suggestedAmount: num(raw.suggestedAmount),
    basis: String(raw.basis || "").slice(0, 300),
    lineIndex: Number.isInteger(raw.lineIndex) ? raw.lineIndex : null,
    lineKey: raw.lineKey || null,
    confirmedAt: raw.confirmedAt || null,
    confirmedBy: raw.confirmedBy || null,
    confirmedAmount: num(raw.confirmedAmount)
  };
}

// THE rule for "is this invoice's price still Patrick's to set?". Also
// honours drafts made before PJL-96, whose custom line carried only the
// "Custom quote — Patrick to price" note (and the booked tier's price).
function isPriceUnconfirmed(inv) {
  if (!inv || inv.status === "void") return false;
  if (inv.priceConfirm?.confirmedAt) return false;
  if (inv.priceConfirm?.required === true) return true;
  if (inv.status === "paid") return false;
  const noted = (inv.lineItems || []).filter((l) => l && l.note);
  if (!noted.length) return false;
  const prefix = legacyCustomNotePrefix();
  return Boolean(prefix) && noted.some((l) => String(l.note).startsWith(prefix));
}

// THE rule for "does this invoice's customer text go out by itself?" — no,
// when PJL sets the price (PJL-96: a custom size, a commercial account
// without its own price, or a pre-PJL-96 placeholder draft). Before
// Confirm price the number is not his yet; after, confirming and telling
// the customer are separate actions (Patrick, 2026-09-26): he uses Send
// when he is ready. The automatic "invoice ready" text never fires for
// such an invoice, and nothing re-arms it. Read by the completion
// cascade (scheduling), sendInvoiceReadySMS (sending) and confirmPrice.
function isPriceSetByPjl(inv) {
  if (!inv) return false;
  return inv.priceConfirm?.required === true || isPriceUnconfirmed(inv);
}

// Read lazily and tolerantly: hydrate() runs on every read, and suites
// that sandbox this module alone (without pricing.js) must still load it.
function legacyCustomNotePrefix() {
  try { return require("./pricing").CUSTOM_QUOTE_NOTE_PREFIX || null; } catch { return null; }
}

// The index of the line Patrick is confirming: the one createDraft
// recorded (checked against its key), or a pre-PJL-96 placeholder line.
function priceConfirmLineIndex(inv) {
  const lines = inv?.lineItems || [];
  const pc = inv?.priceConfirm;
  if (pc && Number.isInteger(pc.lineIndex) && lines[pc.lineIndex] && (!pc.lineKey || lines[pc.lineIndex].key === pc.lineKey)) return pc.lineIndex;
  if (pc?.lineKey) {
    const byKey = lines.findIndex((l) => l?.key === pc.lineKey);
    if (byKey !== -1) return byKey;
  }
  const prefix = legacyCustomNotePrefix();
  let pendingNotes = [];
  try { pendingNotes = Object.values(require("./pricing").PRICE_PENDING_NOTES || {}); } catch { /* sandboxed */ }
  return lines.findIndex((l) => (prefix && String(l?.note || "").startsWith(prefix)) || pendingNotes.includes(l?.note));
}

async function nextInvoiceId(year) {
  const records = await readAll();
  const prefix = `I-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Accepts either pre-normalized invoice lines (with `unitPrice` +
// `lineTotal`) OR raw on-site-quote builder lines (with `originalPrice`/
// `overridePrice`). Both shapes go through this function in different
// code paths so checking all three field names keeps the math right.
function totalsForLines(lines) {
  let subtotal = 0;
  for (const l of lines || []) {
    if (Number.isFinite(Number(l.lineTotal))) {
      subtotal += Number(l.lineTotal);
      continue;
    }
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice)
      : Number(l.originalPrice || l.price || l.unitPrice) || 0;
    subtotal += price * (Number(l.qty) || 1);
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
}

async function list() {
  return readAll();
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

// The invoice that currently bills a work order: any status but void.
function activeInvoiceForWorkOrder(records, woId) {
  if (!woId) return null;
  return (Array.isArray(records) ? records : []).find((r) => r && r.woId === woId && r.status !== "void") || null;
}

async function listByWorkOrder(woId) {
  const records = await readAll();
  return records.filter((r) => r.woId === woId);
}

// Accepts one quoteId or an array — the Job tabs Invoice resolution
// (2026-09-21) needs to check a whole revision chain, since a deposit
// invoice is usually raised against whichever revision was actually
// accepted, not necessarily the CURRENT one a project's pointer resolves
// to today.
async function listByQuote(quoteIdOrIds) {
  const ids = new Set(Array.isArray(quoteIdOrIds) ? quoteIdOrIds : [quoteIdOrIds]);
  const records = await readAll();
  return records.filter((r) => ids.has(r.quoteId));
}

async function listByProperty(propertyId) {
  const records = await readAll();
  return records.filter((r) => r.propertyId === propertyId);
}

// Create a draft invoice from a WO's accepted quote line items. The
// `lineItems` shape is the on-site-quote builder shape (key/label/qty/
// originalPrice/overridePrice). Snapshotted at draft time — future
// pricing.json or quote changes don't alter this invoice.
async function createDraft({
  woId = null,
  quoteId = null,
  projectId = null,
  propertyId = null,
  customerId = null,
  customerName = "",
  customerEmail = "",
  customerPhone = "",
  address = "",
  lineItems = [],
  notes = "",
  paidOnSiteAtCompletion = false,
  disclaimers = [],
  invoiceRole = "standard",
  depositMeta = null,
  holdUntilCompletion = false
}) {
  // Brief 4 — auto-resolve customerId from email/phone if missing.
  // The completion cascade passes wo.customerId directly post-Brief 2,
  // but invoices created via other paths benefit from the fallback.
  if (!customerId && (customerEmail || customerPhone)) {
    try {
      const customersLib = require("./customers");
      const match = customerEmail
        ? await customersLib.findByEmail(customerEmail)
        : await customersLib.findByPhone(customerPhone);
      if (match) customerId = match.id;
    } catch (err) { /* tolerate */ }
  }

  // Bill-to snapshot (billing-party brief §3.8) — override-or-fallback,
  // resolved ONCE here so every draft path (WO cascade, project-final
  // cascade, manual) gets the same rule. The customer record's
  // billingName/billingAddress/billingEmail win when set; otherwise the
  // snapshot mirrors the contact fields (self-billing). Later edits to
  // the customer's billing fields do NOT rewrite this snapshot.
  let billingName = "";
  let billingAddress = "";
  let billingEmail = "";
  let billingCareOf = "";
  let billingCcEmail = "";
  if (customerId) {
    try {
      const customersLib = require("./customers");
      const cust = await customersLib.get(customerId, { withProperties: false });
      // Bill-to is DERIVED from the (property, customer) pair so a managed
      // commercial site bills its own legal entity "c/o" the management
      // company. Residential / self-billed accounts resolve exactly as
      // before. See lib/billing-parties.js for the rule.
      let propForBilling = null;
      if (propertyId) {
        try { propForBilling = await require("./properties").get(propertyId); }
        catch (_) { /* tolerate — fall back to customer-only resolution */ }
      }
      const parties = require("./billing-parties")
        .resolveBillTo(propForBilling, cust, { fallbackAddress: address });
      billingName = parties.name;
      billingAddress = parties.address;
      billingEmail = parties.email;
      billingCareOf = parties.careOf;
      billingCcEmail = parties.ccEmail;
    } catch (err) { /* tolerate — snapshot falls back to contact fields */ }
  }
  const billTo = {
    name: billingName || customerName || "",
    careOf: billingCareOf,
    address: billingAddress || address || "",
    email: billingEmail || customerEmail || "",
    // No fallback: a CC that was never configured must stay empty. There is
    // no sensible "default second recipient" for an invoice.
    ccEmail: billingCcEmail
  };

  const records = await readAll();
  // ONE ACTIVE INVOICE PER WORK ORDER, decided here because this runs under
  // the store lock (createDraft is exported as withStoreLock(createDraft)):
  // no caller's timing can slip a second one past it. Two taps of
  // "Generate invoice now", or one racing the completion cascade, made two
  // invoices for one visit (probe 2026-09-23, 5/5). A VOIDED invoice doesn't
  // count, so void-and-regenerate works; the explicit revision path,
  // revise(), edits the same invoice in place and never comes here.
  // Callers treat wo_already_invoiced as "use existingInvoiceId".
  if (woId) {
    const existing = activeInvoiceForWorkOrder(records, woId);
    if (existing) {
      throw Object.assign(new Error(`Work order ${woId} already has invoice ${existing.id}.`),
        { code: "wo_already_invoiced", existingInvoiceId: existing.id });
    }
  }
  const now = new Date().toISOString();
  const year = new Date().getUTCFullYear();
  const id = await nextInvoiceId(year);
  // Normalize line items into a consistent shape so the invoice page
  // doesn't have to know about builder vs accepted-quote variants.
  const normalized = (lineItems || []).map((l) => {
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice)
      : Number(l.originalPrice || l.price) || 0;
    const qty = Number(l.qty) || 1;
    return {
      key: l.key || null,
      label: l.label || (l.key ? l.key : "Line"),
      qty,
      unitPrice: Math.round(price * 100) / 100,
      lineTotal: Math.round(price * qty * 100) / 100,
      note: l.note || ""
    };
  });
  const totals = totalsForLines(normalized);
  // PJL-96: a SUGGESTED seasonal fee line (pricing.billableLines) — the
  // price is Patrick's to confirm. The suggestion is prefilled; the invoice
  // is flagged, and stays unpayable / unsent / untexted until he does.
  const suggestedIdx = (lineItems || []).findIndex((l) => l && l.priceStatus === "suggested");
  const priceConfirm = suggestedIdx === -1 ? null : {
    required: true,
    reason: lineItems[suggestedIdx].priceReason,
    suggestedAmount: normalized[suggestedIdx].unitPrice,
    basis: lineItems[suggestedIdx].suggestion?.basis || "",
    lineIndex: suggestedIdx,
    lineKey: normalized[suggestedIdx].key,
    confirmedAt: null, confirmedBy: null, confirmedAmount: null
  };
  const inv = hydrate({
    priceConfirm,
    id,
    woId,
    quoteId,
    projectId,
    sourceProjectId: projectId,
    propertyId,
    customerId,
    customerName,
    customerEmail,
    customerPhone,
    address,
    billTo,
    status: "draft",
    lineItems: normalized,
    subtotal: totals.subtotal,
    hst: totals.hst,
    total: totals.total,
    notes,
    paidOnSiteAtCompletion: paidOnSiteAtCompletion === true,
    disclaimers: Array.isArray(disclaimers) ? disclaimers : [],
    invoiceRole,
    depositMeta,
    holdUntilCompletion: holdUntilCompletion === true,
    createdAt: now,
    updatedAt: now,
    history: [{
      ts: now,
      action: "draft_created",
      by: "system",
      note: (() => {
        const baseNote = paidOnSiteAtCompletion === true
          ? (woId ? `From WO ${woId} — paid on-site at completion` : "Paid on-site at completion")
          : (woId ? `From WO ${woId}` : "");
        const validDisclaimers = (Array.isArray(disclaimers) ? disclaimers : [])
          .filter((k) => typeof k === "string" && INVOICE_DISCLAIMERS[k]);
        if (!validDisclaimers.length) return baseNote;
        const disclaimerNote = `disclaimer${validDisclaimers.length === 1 ? "" : "s"} attached: ${validDisclaimers.join(", ")}`;
        return baseNote ? `${baseNote} · ${disclaimerNote}` : disclaimerNote;
      })()
    }]
  });
  records.unshift(inv);
  await writeAll(records);
  return inv;
}

async function update(id, patch) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  // PJL-96: an invoice whose price Patrick has not confirmed is never
  // issued — not by /send, a bulk "mark sent", or a manual status patch.
  if (patch && patch.status === "sent" && current.status === "draft" && isPriceUnconfirmed(current)) {
    const err = new Error("Confirm this invoice's price before it goes to the customer.");
    err.code = "price_unconfirmed";
    throw err;
  }
  const next = { ...current };
  const allowed = ["status", "notes", "quickbooksInvoiceId", "quickbooksChargeId", "quickbooksPaymentId", "stripePaymentIntentId", "stripeTerminalIntentId", "stripeChargeId", "paymentToken", "portalToken", "customerSmsScheduledAt", "customerSmsSentAt", "customerReminderHistory", "customerJunkMailWarningSentAt", "customerJunkMailWarningHistory", "customerName", "customerEmail", "customerPhone", "address", "holdUntilCompletion"];
  for (const key of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  // billTo is a financial snapshot — editable ONLY while the invoice is
  // still a draft. Once sent/paid/void the bill-to is part of the issued
  // document and locks (same principle as line items on a signed WO).
  if (patch && Object.prototype.hasOwnProperty.call(patch, "billTo")) {
    if (current.status !== "draft") {
      throw new Error("Bill-to can only be edited while the invoice is a draft.");
    }
    const raw = patch.billTo && typeof patch.billTo === "object" ? patch.billTo : {};
    next.billTo = {
      name: String(raw.name || "").trim().slice(0, 200),
      careOf: String(raw.careOf || "").trim().slice(0, 200),
      address: String(raw.address || "").trim().slice(0, 400),
      email: String(raw.email || "").trim().toLowerCase().slice(0, 254),
      // A billTo patch that omits ccEmail keeps the snapshotted one rather
      // than silently dropping the bookkeeper — the invoice edit UI only
      // surfaces name/address/email.
      ccEmail: String(
        (Object.prototype.hasOwnProperty.call(raw, "ccEmail") ? raw.ccEmail : current.billTo?.ccEmail) || ""
      ).trim().toLowerCase().slice(0, 254)
    };
  }
  // Letter — editable on any invoice that is not void. Unlike billTo it
  // is not part of the issued financial document, so it does not lock at
  // send; a report can legitimately be written or corrected after the
  // invoice has gone out. Every write re-stamps who and when.
  if (patch && Object.prototype.hasOwnProperty.call(patch, "letter")) {
    if (current.status === "void") {
      throw new Error("Can't edit the letter on a void invoice.");
    }
    const incoming = normalizeLetter(patch.letter);
    next.letter = {
      ...incoming,
      updatedAt: new Date().toISOString(),
      updatedBy: patch.letterBy || "admin"
    };
  }
  // The report attachment follows the letter's rule: it is not part of the
  // issued financial document, so it does not lock at send — Patrick can
  // decide to attach the report on a resend. Void still blocks, because a
  // void invoice sends nothing.
  if (patch && Object.prototype.hasOwnProperty.call(patch, "woReport")) {
    if (current.status === "void") {
      throw new Error("Can't change the report attachment on a void invoice.");
    }
    next.woReport = {
      ...normalizeWoReport(patch.woReport),
      updatedAt: new Date().toISOString(),
      updatedBy: patch.woReportBy || "admin"
    };
  }
  if (patch && Array.isArray(patch.lineItems)) {
    next.lineItems = patch.lineItems;
    const totals = totalsForLines(next.lineItems);
    next.subtotal = totals.subtotal;
    next.hst = totals.hst;
    next.total = totals.total;
  }
  // Disclaimers — merge via Set so a re-fire of the completion cascade
  // (or a manual admin add of a different key in the future) never
  // produces duplicates. Unknown keys are dropped on hydrate.
  if (patch && Array.isArray(patch.disclaimers)) {
    const merged = new Set([
      ...(Array.isArray(current.disclaimers) ? current.disclaimers : []),
      ...patch.disclaimers.filter((k) => typeof k === "string" && INVOICE_DISCLAIMERS[k])
    ]);
    next.disclaimers = Array.from(merged);
  }
  if (patch && patch.status === "sent" && !current.sentAt) next.sentAt = new Date().toISOString();
  if (patch && patch.status === "paid" && !current.paidAt) next.paidAt = new Date().toISOString();
  if (patch && patch.status === "void" && !current.voidedAt) next.voidedAt = new Date().toISOString();

  // Re-derive the status from the ledger when an invoice is SENT.
  // statusForPayments only ran on payment mutations, so cash collected
  // on site — recorded while the invoice was still a draft, which is the
  // normal order of events — left the invoice sitting at "sent" with a
  // balance owing. It should read partially_paid (or paid, if the
  // on-site payment covered the whole thing).
  //
  // Deliberately scoped to the sent transition: re-deriving on EVERY
  // update would fight a manual "paid" that an admin set on an invoice
  // with no payment records, which is a legitimate thing to do.
  if (patch && patch.status === "sent") {
    next.status = statusForPayments(next, "sent");
    if (next.status === "paid" && !next.paidAt) next.paidAt = new Date().toISOString();
  }
  next.updatedAt = new Date().toISOString();
  if (patch && patch.status && patch.status !== current.status) {
    next.history = [...(next.history || []), {
      ts: next.updatedAt, action: `status:${patch.status}`, by: patch.by || "admin", note: patch.note || ""
    }];
  }
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Generate (and persist) a paymentToken for the public /pay/invoice/:id?t=
// route if the invoice doesn't already have one. Idempotent — second
// call on the same invoice returns the same token. Returns the updated
// record. The token is a 32-char hex string (16 random bytes), enough
// entropy to be unguessable without rate-limiting.
const cryptoMod = require("node:crypto");
// Can the customer's pay page take a card for this invoice right now?
// ONE rule, read by the public invoice read, sdk-config and payment-intent
// routes, so the page never shows a card form the server would refuse
// (fall-closing fix #3). Sent / part-paid invoices, as always — plus a
// DRAFT that signed-in staff opened for payment on site.
//
// payBlockReason is the same rule with its reason: null when payable,
// otherwise "void" | "paid" | "price_unconfirmed" | "not_issued".
// PJL-96 added "price_unconfirmed" — a price Patrick has not confirmed is
// never payable, sent invoice or not. (A no-charge reason, if one is ever
// needed, slots in beside it; today a $0 visit drafts no invoice at all.)
function payBlockReason(inv) {
  if (!inv) return "not_issued";
  if (inv.status === "void") return "void";
  if (inv.status === "paid") return "paid";
  if (inv.scopeHold?.since) return "awaiting_signature";
  if (isPriceUnconfirmed(inv)) return "price_unconfirmed";
  if (inv.status === "sent" || inv.status === "partially_paid") return null;
  if (inv.status === "draft" && Boolean(inv.onSitePayment?.openedAt)) return null;
  return "not_issued";
}

function isPayableOnline(inv) {
  return payBlockReason(inv) === null;
}

// The tech taps "Take payment now" with the customer beside them.
//
// A draft is Patrick's to review before it goes out, and for a customer
// who is billed ("Bill later" at sign-off) it stays that way: refused,
// nothing stamped. A visit signed off "Paid on site" — the new-customer
// path, pay before the tech leaves — is opened for payment WITHOUT being
// emailed: status stays draft (so it still sits in Patrick's list), and
// the stamp lets the pay page take the card. A full payment then flips it
// to paid through the ledger.
async function openForOnSitePayment(id, { by = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, code: "not_found", errors: ["Invoice not found."] };
  const inv = records[idx];
  if (inv.status === "paid") return { ok: false, status: 409, code: "already_paid", errors: ["This invoice is already paid."] };
  if (inv.status === "void") return { ok: false, status: 409, code: "void", errors: ["This invoice has been voided."] };
  // Nothing to pay on a $0 invoice — no link, no card form (fall-closing #8).
  if (!(Number(inv.total) > 0)) return { ok: false, status: 409, code: "no_charge", errors: ["This visit is no charge — there is nothing to pay."] };
  // A custom-quote tier line still carries a placeholder price until
  // Patrick prices it (fall-closing #7 round 2): never charge that.
  // PJL-96: the same for any price not yet confirmed (a custom size, or a
  // commercial account without its own price) — one rule, isPriceUnconfirmed.
  if (inv.scopeHold?.since) {
    return { ok: false, status: 409, code: "awaiting_signature", errors: ["The work order's scope changed after the customer signed. They need to sign the revised work order before anything is charged. Nothing was charged."] };
  }
  if (isPriceUnconfirmed(inv)) {
    return { ok: false, status: 409, code: "needs_pricing", errors: ["PJL confirms this visit's price before the customer pays — the office sends the invoice once it's set. Nothing was charged."] };
  }
  if (inv.status === "draft" && !inv.onSitePayment?.openedAt) {
    if (inv.paidOnSiteAtCompletion !== true) {
      return {
        ok: false, status: 409, code: "needs_review",
        errors: ["This visit was signed off as \"Bill later\", so the invoice waits for Patrick's review before the customer can pay it. Nothing was charged."]
      };
    }
    inv.onSitePayment = { openedAt: new Date().toISOString(), by: String(by || "") };
    inv.history = Array.isArray(inv.history) ? inv.history : [];
    inv.history.push({ ts: inv.onSitePayment.openedAt, action: "opened_for_on_site_payment", by: String(by || "admin"), note: "Opened for card payment on site (not emailed)." });
  }
  if (!inv.paymentToken) inv.paymentToken = cryptoMod.randomBytes(16).toString("hex");
  inv.updatedAt = new Date().toISOString();
  records[idx] = inv;
  await writeAll(records);
  return { ok: true, invoice: hydrate(inv) };
}

// Patrick confirms the price (PJL-96) — the suggested amount as it stands,
// or his own (`amount`, dollars). The line takes the confirmed price and
// loses its "PJL confirms the price" note (the customer's invoice must
// not say it is pending), the totals are recomputed, and the status is
// re-derived from any money already recorded. From here the invoice is an
// ordinary one: payable on the usual rules, sendable, textable.
//
// The "invoice ready" text is NOT released by confirming (Patrick,
// 2026-09-26, replacing the 2026-09-23 auto-release): confirming the
// price and telling the customer are separate actions. A pending
// automatic text is cancelled here, and isPriceSetByPjl keeps it from
// ever being scheduled again. The office sends the invoice with Send.
//
// A different amount is accepted only on a DRAFT; a price already issued
// to the customer (an invoice sent before PJL-96) changes through Revise.
async function confirmPrice(id, { amount = null, by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, code: "not_found", errors: ["Invoice not found."] };
  const current = records[idx];
  if (current.status === "void") return { ok: false, status: 409, code: "void", errors: ["This invoice has been voided."] };
  if (!isPriceUnconfirmed(current)) {
    return current.priceConfirm?.confirmedAt
      ? { ok: true, invoice: current, alreadyConfirmed: true }
      : { ok: false, status: 409, code: "not_required", errors: ["This invoice has no price waiting to be confirmed."] };
  }
  const lineIdx = priceConfirmLineIndex(current);
  if (lineIdx === -1) {
    return { ok: false, status: 409, code: "line_missing", errors: ["Couldn't find the line to price — edit the lines, then confirm."] };
  }
  const lines = (current.lineItems || []).map((l) => ({ ...l }));
  const line = lines[lineIdx];
  const qty = Number(line.qty) || 1;
  let unit = Number(line.unitPrice) || 0;
  if (amount !== null && amount !== undefined && amount !== "") {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, status: 422, code: "bad_amount", errors: ["The price must be a positive amount."] };
    if (current.status !== "draft" && round2(n) !== round2(unit)) {
      return { ok: false, status: 409, code: "use_revise", errors: ["This invoice has already gone to the customer — change its price with Revise."] };
    }
    unit = round2(n);
  }
  if (!(unit > 0)) return { ok: false, status: 422, code: "bad_amount", errors: ["Enter the price for this visit."] };
  lines[lineIdx] = { ...line, unitPrice: unit, lineTotal: round2(unit * qty), note: "" };
  const now = new Date().toISOString();
  const totals = totalsForLines(lines);
  const next = { ...current, lineItems: lines, subtotal: totals.subtotal, hst: totals.hst, total: totals.total };
  next.amountPaid = amountPaidOf(next);
  next.balanceDue = balanceDueOf(next);
  next.status = statusForPayments(next, current.status);
  if (next.status === "paid" && !next.paidAt) next.paidAt = now;
  const pc = current.priceConfirm || { required: true, reason: "custom_size", suggestedAmount: Number(line.unitPrice) || null, basis: "", lineIndex: lineIdx, lineKey: line.key || null };
  next.priceConfirm = { ...pc, required: true, lineIndex: lineIdx, lineKey: line.key || null, confirmedAt: now, confirmedBy: String(by || "admin"), confirmedAmount: unit };
  const cancelledText = Boolean(current.customerSmsScheduledAt && !current.customerSmsSentAt);
  if (cancelledText) next.customerSmsScheduledAt = null;
  next.updatedAt = now;
  const suggested = pc.suggestedAmount != null ? ` (suggested $${Number(pc.suggestedAmount).toFixed(2)})` : "";
  next.history = [...(current.history || []), {
    ts: now, action: "price_confirmed", by: String(by || "admin"),
    note: `Price confirmed at $${unit.toFixed(2)}${suggested} · nothing sent to the customer — use Send when ready`
  }];
  if (cancelledText) {
    next.history.push({ ts: now, action: "customer_sms_cancelled_price_set_by_pjl", by: "system",
      note: "Automatic invoice text cancelled — PJL set this price; the office sends the invoice." });
  }
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: hydrate(next) };
}

// Hold or release the work order's active invoice while the WO awaits the
// customer's new signature on a revised scope. `hold` true/false; returns
// the invoice, or null when the WO has none. Idempotent.
async function setScopeHold(woId, hold, { by = "system" } = {}) {
  const records = await readAll();
  const inv = activeInvoiceForWorkOrder(records, woId);
  if (!inv) return null;
  const idx = records.indexOf(inv);
  const on = Boolean(inv.scopeHold && inv.scopeHold.since);
  if (on === Boolean(hold)) return hydrate(inv);
  const now = new Date().toISOString();
  const next = { ...inv, scopeHold: hold ? { woId, since: now } : null, updatedAt: now };
  next.history = [...(inv.history || []), {
    ts: now, action: hold ? "scope_hold_on" : "scope_hold_off", by,
    note: hold
      ? "Held: the work order's price changed after the customer signed — nothing is charged or sent until they sign the revised work order"
      : "Released: the revised work order is accepted"
  }];
  records[idx] = next;
  await writeAll(records);
  return hydrate(next);
}

async function ensurePaymentToken(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  if (records[idx].paymentToken) return records[idx];
  const token = cryptoMod.randomBytes(16).toString("hex");
  records[idx] = {
    ...records[idx],
    paymentToken: token,
    updatedAt: new Date().toISOString()
  };
  await writeAll(records);
  return records[idx];
}

// Look up an invoice by its public paymentToken — used by the public
// /pay/invoice/:id?t=<token> page to verify access. Returns null if the
// token doesn't match any invoice (so the page 404s rather than leaking
// the existence of the ID).
async function getByPaymentToken(id, token) {
  if (!token || typeof token !== "string") return null;
  const records = await readAll();
  const inv = records.find((r) => r.id === id);
  if (!inv) return null;
  if (!inv.paymentToken) return null;
  // Constant-time-ish compare via Buffer equals — overkill for this use
  // case but cheap and the right reflex for token comparison.
  const a = Buffer.from(inv.paymentToken);
  const b = Buffer.from(token);
  if (a.length !== b.length) return null;
  if (!cryptoMod.timingSafeEqual(a, b)) return null;
  return inv;
}

// Generate (and persist) a portalToken for the public /portal/invoice/:id?t=
// read-only view. Mirrors ensurePaymentToken — idempotent, 32-char hex.
// Distinct token from paymentToken so the portal and payment surfaces
// can be revoked independently if a leak is ever discovered.
async function ensurePortalToken(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  if (records[idx].portalToken) return records[idx];
  const token = cryptoMod.randomBytes(16).toString("hex");
  records[idx] = {
    ...records[idx],
    portalToken: token,
    updatedAt: new Date().toISOString()
  };
  await writeAll(records);
  return records[idx];
}

// Look up an invoice by its public portalToken — used by
// /api/portal/invoice/:id?t=<token> to verify access. Returns null on
// missing/wrong token so the route 401s without leaking ID existence.
async function getByPortalToken(id, token) {
  if (!token || typeof token !== "string") return null;
  const records = await readAll();
  const inv = records.find((r) => r.id === id);
  if (!inv) return null;
  if (!inv.portalToken) return null;
  const a = Buffer.from(inv.portalToken);
  const b = Buffer.from(token);
  if (a.length !== b.length) return null;
  if (!cryptoMod.timingSafeEqual(a, b)) return null;
  return inv;
}

// Append a single history entry without touching status / line items.
// Used by the /resend route in server.js so re-emails get a clean audit
// trail without going through update() (which only logs on status
// transitions). Returns the updated invoice record, or null if not found.
async function appendHistory(id, entry) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = { ...records[idx] };
  next.history = [...(next.history || []), {
    ts: entry?.ts || now,
    action: entry?.action || "note",
    by: entry?.by || "admin",
    note: entry?.note || ""
  }];
  next.updatedAt = now;
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Append one card-charge attempt to the invoice (QB Payments AVS brief,
// §4.3). Called by the /charge route on BOTH outcomes, before anything
// else is written — a charge that succeeded but whose paid-flip failed
// still leaves a record, and so does a decline.
//
// Append-only and allowlisted field by field. Two reasons for the
// allowlist rather than a spread: it is the structural guarantee that no
// PAN, CVC, expiry, or card token can ever be persisted here even if a
// caller passes one by mistake (PCI SAQ-A-EP — see Hard Rule 23), and it
// keeps the record shape stable for the admin invoice view.
//
// `cardBrand` + `cardLast4` come from the MASKED number Intuit echoes
// back on the charge response. Brand and last four are storable; the PAN
// never reaches this process at all.
const PAYMENT_ATTEMPT_OUTCOMES = ["success", "failure"];

async function appendPaymentAttempt(id, attempt) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const cap = (v, n) => (v == null ? null : String(v).slice(0, n));
  const outcome = PAYMENT_ATTEMPT_OUTCOMES.includes(attempt?.outcome) ? attempt.outcome : "failure";
  const last4 = String(attempt?.cardLast4 || "");
  const entry = {
    ts: attempt?.ts || now,
    outcome,
    // Which rail processed the attempt. Records written before the
    // Stripe migration have no processor field and used Intuit-named
    // columns (intuitCode/intuitMessage/intuitTid) — those hydrate
    // verbatim and stay readable; treat a missing processor as
    // "quickbooks" when displaying.
    processor: attempt?.processor === "stripe" ? "stripe" : "quickbooks",
    amount: Number(attempt?.amount) || 0,
    currency: attempt?.currency || "CAD",
    chargeId: cap(attempt?.chargeId, 100),
    chargeStatus: cap(attempt?.chargeStatus, 40),
    // null / "" must stay null — Number(null) is 0, which would record a
    // pre-flight failure (no HTTP call made) as an HTTP 0 response.
    httpStatus: attempt?.httpStatus != null && attempt.httpStatus !== "" && Number.isFinite(Number(attempt.httpStatus))
      ? Number(attempt.httpStatus)
      : null,
    // The processor's own error code and verbatim message — Intuit's
    // "PMT-2002" or Stripe's "card_declined". The message is stored
    // UNMODIFIED for Patrick — it is the raw gateway string that must
    // never reach the customer. declineCode is Stripe's finer-grained
    // issuer reason ("insufficient_funds", "incorrect_zip") when the
    // issuer supplied one; null on QuickBooks records.
    errorCode: cap(attempt?.errorCode ?? attempt?.intuitCode, 40),
    declineCode: cap(attempt?.declineCode, 40),
    errorMessage: cap(attempt?.errorMessage ?? attempt?.intuitMessage, 500),
    // The processor-side reference to quote to support: intuit_tid on
    // QuickBooks records, the req_… request id on Stripe records.
    processorRef: cap(attempt?.processorRef ?? attempt?.intuitTid, 100),
    // Stripe payment intent (pi_…) the attempt belongs to, when known.
    paymentIntentId: cap(attempt?.paymentIntentId, 100),
    // What the CUSTOMER was actually shown, so a support call can start
    // from the same words they read on their phone.
    customerMessage: cap(attempt?.customerMessage, 300),
    cardBrand: cap(attempt?.cardBrand, 40),
    cardLast4: /^\d{4}$/.test(last4) ? last4 : null,
    // AVS + CVC verification results — the whole point of collecting a
    // billing street address. Stripe reports pass/fail/unavailable/
    // unchecked; Intuit reported Pass/Fail. "avsStreet" failing while
    // "avsZip" passes is the signature of the Amex pattern the AVS
    // brief was written for.
    avsStreet: cap(attempt?.avsStreet, 20),
    avsZip: cap(attempt?.avsZip, 20),
    cvcMatch: cap(attempt?.cvcMatch, 20)
  };

  const next = { ...records[idx] };
  next.paymentAttempts = [...(next.paymentAttempts || []), entry];
  // Mirror into history[] so the existing invoice audit trail shows the
  // attempt inline with sends, voids and status flips — Patrick reads
  // that timeline, not a separate array.
  const summary = outcome === "success"
    ? `Card charge approved${entry.chargeId ? ` (${entry.chargeId})` : ""}.`
    : `Card charge declined${entry.errorCode ? ` [${entry.errorCode}${entry.declineCode ? `/${entry.declineCode}` : ""}]` : ""}${entry.errorMessage ? `: ${entry.errorMessage}` : "."}${entry.processorRef ? ` (ref ${entry.processorRef})` : ""}`;
  next.history = [...(next.history || []), {
    ts: entry.ts,
    action: `payment_attempt:${outcome}`,
    by: "customer",
    note: summary.slice(0, 500)
  }];
  next.updatedAt = now;
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Revise the line items on a SENT invoice (invoice-revise, Sep 2026).
// Use case: the customer negotiated the price after the invoice went out.
// Rules:
//   sent / partially_paid → allowed. Previous lines + totals are
//                   snapshotted into revisions[] so the original document
//                   is never lost. The new total can't drop below what has
//                   already been paid (that would be a refund, not a
//                   revision). Status is re-derived from the ledger after
//                   the change (a partial payment can become "paid" when
//                   the price drops to match it).
//   draft         → 409: a draft has no customer-facing document yet; just
//                   edit it (or regenerate from the WO).
//   paid          → 409: money already moved — that's a refund/credit memo.
//   void          → 409.
// `lineItems` is the same shape createDraft normalizes to (label/qty/
// unitPrice[/note]); we re-normalize + recompute totals here. A reason is
// REQUIRED — it goes in the audit trail and into the revised-invoice email.
// Does NOT notify the customer: that's a separate explicit step
// (markRevisionNotified + the /send-revision route in server.js).
function normalizeLineItems(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : []).map((l) => {
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice)
      : Number(l.unitPrice ?? l.originalPrice ?? l.price) || 0;
    const qty = Number(l.qty) || 1;
    return {
      key: l.key || null,
      label: String(l.label || (l.key ? l.key : "Line")).trim().slice(0, 200) || "Line",
      qty,
      unitPrice: Math.round(price * 100) / 100,
      lineTotal: Math.round(price * qty * 100) / 100,
      note: String(l.note || "").slice(0, 500)
    };
  });
}

function fmtMoneyPlain(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

async function revise(id, { lineItems, reason = "", by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, code: "not_found", errors: ["Invoice not found."] };
  const current = records[idx];
  if (current.status === "paid") {
    return { ok: false, status: 409, code: "invoice_paid", errors: ["A paid invoice can't be revised — issue a refund or credit memo instead."] };
  }
  if (current.status === "void") {
    return { ok: false, status: 409, code: "invoice_void", errors: ["A voided invoice can't be revised."] };
  }
  if (current.status !== "sent" && current.status !== "partially_paid") {
    return { ok: false, status: 409, code: "invoice_not_sent", errors: ["Only a sent invoice can be revised. A draft can simply be edited before sending."] };
  }
  const trimmedReason = String(reason || "").trim().slice(0, 500);
  if (!trimmedReason) {
    return { ok: false, status: 400, code: "reason_required", errors: ["A reason is required — it's recorded in the audit log and shown to the customer."] };
  }
  const normalized = normalizeLineItems(lineItems);
  if (!normalized.length) {
    return { ok: false, status: 400, code: "no_lines", errors: ["A revised invoice needs at least one line item."] };
  }
  // Negative unit prices are allowed (a "Negotiated discount" line is the
  // natural way to show a price cut); the invoice as a whole can't go
  // below zero, or below what the customer has already paid.
  for (const l of normalized) {
    if (!Number.isFinite(l.unitPrice) || !Number.isFinite(l.qty) || l.qty <= 0) {
      return { ok: false, status: 400, code: "bad_line", errors: [`Line "${l.label}" has an invalid quantity or price.`] };
    }
  }
  const totals = totalsForLines(normalized);
  if (totals.subtotal < 0) {
    return { ok: false, status: 400, code: "negative_total", errors: ["The revised total can't be below $0.00."] };
  }
  const paidAlready = amountPaidOf(current);
  if (paidAlready > 0 && totals.total < round2(paidAlready - 0.01)) {
    return { ok: false, status: 409, code: "below_amount_paid", errors: [`The customer has already paid ${fmtMoneyPlain(paidAlready)} — the revised total can't be less than that. Record a refund instead.`] };
  }
  const now = new Date().toISOString();
  const next = { ...current };
  next.revisions = [...(current.revisions || []), {
    ts: now,
    by,
    reason: trimmedReason,
    previousLineItems: current.lineItems || [],
    previousSubtotal: current.subtotal,
    previousHst: current.hst,
    previousTotal: current.total,
    newTotal: totals.total,
    notifiedAt: null
  }];
  next.revisedAt = now;
  next.lineItems = normalized;
  next.subtotal = totals.subtotal;
  next.hst = totals.hst;
  next.total = totals.total;
  next.amountPaid = amountPaidOf(next);
  next.balanceDue = balanceDueOf(next);
  next.status = statusForPayments(next, current.status);
  if (next.status === "paid" && !next.paidAt) next.paidAt = now;
  next.updatedAt = now;
  next.history = [...(next.history || []), {
    ts: now,
    action: "revised",
    by,
    note: `Total ${fmtMoneyPlain(current.total)} → ${fmtMoneyPlain(totals.total)} — ${trimmedReason}`
  }];
  if (next.status !== current.status) {
    next.history.push({ ts: now, action: `status:${next.status}`, by: "system", note: "Re-derived from payments after revision." });
  }
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: next };
}

// Stamp notifiedAt on the latest revision after the revised-invoice
// email/SMS goes out. Idempotent; no-op if there are no revisions.
async function markRevisionNotified(id, { channel = "email", by = "admin", note = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = { ...records[idx] };
  const revs = [...(next.revisions || [])];
  if (revs.length) {
    const last = { ...revs[revs.length - 1], notifiedAt: revs[revs.length - 1].notifiedAt || now };
    revs[revs.length - 1] = last;
  }
  next.revisions = revs;
  next.updatedAt = now;
  next.history = [...(next.history || []), {
    ts: now,
    action: channel === "sms" ? "revision_sms_sent" : "revision_sent",
    by,
    note
  }];
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Original (first-issued) total, or null if never revised. Used by the
// PDF + email + customer surfaces to say "replaces the invoice for $X".
function originalTotal(inv) {
  const revs = Array.isArray(inv?.revisions) ? inv.revisions : [];
  return revs.length ? Number(revs[0].previousTotal) || 0 : null;
}

// Void an invoice (feature-invoice-void-delete-brief.md §4.2). Follows the
// bookings.cancel() shape — returns { ok, status } rather than throwing so
// the route maps codes to HTTP cleanly.
//
//   draft | sent  → void (allowed)
//   paid          → refused (409 invoice_paid). A paid invoice is a
//                   financial fact; a genuine error there is a QB
//                   credit-memo conversation, out of scope.
//   void          → idempotent: returns the existing record, no duplicate
//                   history entry (matches cascade idempotency style).
//
// `reason` is OPTIONAL (Patrick: the mandatory reason belongs to the
// DELETE step). When supplied it is stored as voidReason and pre-fills the
// delete modal. Voiding also cancels any pending-unsent invoice SMS so a
// customer never gets a payment nudge for a voided invoice.
async function voidInvoice(id, { reason = "", by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, code: "not_found", errors: ["Invoice not found."] };
  const current = records[idx];

  if (current.status === "void") {
    return { ok: true, invoice: current, alreadyVoid: true };
  }
  if (current.status === "paid") {
    return {
      ok: false,
      status: 409,
      code: "invoice_paid",
      errors: ["A paid invoice can't be voided here — that's a QuickBooks credit-memo. Only draft or sent invoices can be voided."]
    };
  }
  // Money has already come in against this invoice. Voiding would erase the
  // record of a payment we actually received, so the payments have to be
  // reversed deliberately first — that way the reversal is its own audited
  // decision rather than a side effect of voiding.
  const paidAlready = amountPaidOf(current);
  if (paidAlready > 0) {
    return {
      ok: false,
      status: 409,
      code: "invoice_has_payments",
      errors: [`This invoice has $${paidAlready.toFixed(2)} in recorded payments. Reverse them before voiding.`]
    };
  }
  // Only draft / sent remain (paid + void handled above), but guard the
  // enum explicitly so a future status can't fall through to void.
  if (current.status !== "draft" && current.status !== "sent") {
    return { ok: false, status: 409, code: "invalid_status", errors: [`Can't void a "${current.status}" invoice.`] };
  }

  const now = new Date().toISOString();
  const trimmedReason = String(reason || "").trim();
  const next = { ...current };
  next.status = "void";
  next.voidedAt = now;
  next.voidedBy = by;
  next.voidReason = trimmedReason;
  next.updatedAt = now;
  const history = [...(current.history || []), {
    ts: now,
    action: "voided",
    by,
    note: trimmedReason
  }];

  // Cancel a pending-unsent invoice SMS. Clearing customerSmsScheduledAt
  // short-circuits the 2-min sweep's `if (!scheduledAt) continue` guard;
  // the setTimeout path already aborts on status==="void" — belt and
  // suspenders. Only touch it when there's actually a pending schedule.
  if (current.customerSmsScheduledAt && !current.customerSmsSentAt) {
    next.customerSmsScheduledAt = null;
    history.push({
      ts: now,
      action: "customer_sms_cancelled_voided",
      by,
      note: "Pending invoice SMS cancelled — invoice voided."
    });
  }

  next.history = history;
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: next };
}

// Hard-delete a VOID invoice, writing a permanent tombstone first
// (feature-invoice-void-delete-brief.md §4.2). This is the single sanctioned
// deviation from Hard Rule 4: the operational record leaves invoices.json,
// but a frozen snapshot (+ reasons, actor, timestamp) is appended to
// deleted-invoices.json, which is never pruned. Returns { ok, status, code }.
//
// Guards (all refuse with a specific code the UI maps to targeted copy):
//   - not found                         → 404 not_found
//   - status !== "void"                 → 409 invoice_not_void (void-first
//                                         is the ONLY road to deletion)
//   - empty reason                      → 400 reason_required (the tombstone
//                                         reason is the permanent record)
//   - has QB id, no qbVoidConfirmed     → 409 qb_push_exists (QBO is the
//                                         legal ledger; confirm the manual
//                                         QBO void before diverging locally)
async function remove(id, { reason = "", by = "admin", qbVoidConfirmed = false } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, code: "not_found", errors: ["Invoice not found."] };
  const current = records[idx];

  if (current.status !== "void") {
    return {
      ok: false,
      status: 409,
      code: "invoice_not_void",
      errors: ["Only a voided invoice can be deleted. Void it first (with a reason), then delete."]
    };
  }
  const trimmedReason = String(reason || "").trim();
  if (!trimmedReason) {
    return { ok: false, status: 400, code: "reason_required", errors: ["A deletion reason is required — it's the permanent audit record."] };
  }
  if (current.quickbooksInvoiceId && qbVoidConfirmed !== true) {
    return {
      ok: false,
      status: 409,
      code: "qb_push_exists",
      errors: ["This invoice was pushed to QuickBooks. Void it in QBO first, then retry with confirmation."]
    };
  }

  const now = new Date().toISOString();
  const tombstone = {
    id: current.id,
    deletedAt: now,
    deletedBy: by,
    reason: trimmedReason,
    voidReason: current.voidReason || "",
    qbInvoiceId: current.quickbooksInvoiceId || null,
    qbVoidConfirmed: qbVoidConfirmed === true,
    // Complete frozen snapshot of the record as it existed at deletion,
    // history[] included. This IS the audit trail post-deletion.
    snapshot: current
  };

  // Tombstone FIRST — if this throws, we abort before mutating
  // invoices.json. A crash BETWEEN the two writes leaves a tombstone for a
  // still-present invoice (harmless; a retry re-tombstones + removes).
  await appendDeletedTombstone(tombstone);

  records.splice(idx, 1);
  await writeAll(records);
  return { ok: true, deletedId: id, tombstone };
}

// ---- Payment ledger ---------------------------------------------------
//
// Payments are allowed on draft as well as sent/partially_paid: cash is
// routinely collected on site BEFORE the invoice is drafted, and refusing
// to record it until the invoice is sent is what pushed people to fake it
// with a negative line item. Void is the only hard block.
//
// Every mutation appends to the invoice history, so the ledger can be
// reconstructed even if a payment is later corrected or reversed.
const PAYABLE_STATUSES = new Set(["draft", "sent", "partially_paid", "paid"]);

async function addPayment(id, { amount, method, receivedAt, notes, by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, errors: ["Invoice not found."] };
  const current = records[idx];
  if (current.status === "void") {
    return { ok: false, status: 409, code: "invoice_void", errors: ["Can't record a payment against a void invoice."] };
  }
  if (!PAYABLE_STATUSES.has(current.status)) {
    return { ok: false, status: 409, code: "bad_status", errors: [`Can't record a payment on a "${current.status}" invoice.`] };
  }
  const payment = normalizePayment({ amount, method, receivedAt, notes, receivedBy: by });
  if (!payment) {
    return { ok: false, status: 422, code: "bad_amount", errors: ["Payment amount must be a positive number."] };
  }
  if (method && !PAYMENT_METHODS.includes(method)) {
    return { ok: false, status: 422, code: "bad_method", errors: [`Unknown payment method "${method}". Use one of: ${PAYMENT_METHODS.join(", ")}.`] };
  }
  // Overpayment guard — a cent of tolerance for rounding, otherwise refuse.
  // Recording more than is owed is nearly always a typo, and it would drive
  // balanceDue to 0 while hiding the discrepancy.
  const balance = balanceDueOf(current);
  if (payment.amount > round2(balance + 0.01)) {
    return {
      ok: false, status: 422, code: "over_balance",
      errors: [`Payment of $${payment.amount.toFixed(2)} exceeds the balance due of $${balance.toFixed(2)}.`]
    };
  }

  const next = { ...current, payments: [...(current.payments || []), payment] };
  next.amountPaid = amountPaidOf(next);
  next.balanceDue = balanceDueOf(next);
  next.status = statusForPayments(next, current.status);
  if (next.status === "paid" && !next.paidAt) next.paidAt = new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  next.history = [...(current.history || []), {
    ts: next.updatedAt,
    action: "payment_recorded",
    by,
    note: `${PAYMENT_METHOD_LABELS[payment.method] || payment.method} $${payment.amount.toFixed(2)} — balance now $${next.balanceDue.toFixed(2)}${payment.notes ? ` · ${payment.notes}` : ""}`
  }];
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: hydrate(next), payment };
}

async function updatePayment(id, paymentId, patch = {}, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, errors: ["Invoice not found."] };
  const current = records[idx];
  if (current.status === "void") {
    return { ok: false, status: 409, code: "invoice_void", errors: ["Can't edit payments on a void invoice."] };
  }
  const list = Array.isArray(current.payments) ? current.payments : [];
  const pIdx = list.findIndex((p) => p.id === paymentId);
  if (pIdx === -1) return { ok: false, status: 404, errors: ["Payment not found."] };
  const before = list[pIdx];
  const merged = normalizePayment({ ...before, ...patch, id: before.id, receivedBy: before.receivedBy });
  if (!merged) return { ok: false, status: 422, code: "bad_amount", errors: ["Payment amount must be a positive number."] };
  if (patch.method && !PAYMENT_METHODS.includes(patch.method)) {
    return { ok: false, status: 422, code: "bad_method", errors: [`Unknown payment method "${patch.method}".`] };
  }
  // Balance excluding THIS payment, so an edit is checked against what the
  // rest of the ledger leaves owing.
  const others = list.filter((p) => p.id !== paymentId);
  const balanceWithoutThis = Math.max(0, round2((Number(current.total) || 0) - round2(others.reduce((a, p) => a + p.amount, 0))));
  if (merged.amount > round2(balanceWithoutThis + 0.01)) {
    return {
      ok: false, status: 422, code: "over_balance",
      errors: [`Payment of $${merged.amount.toFixed(2)} exceeds the $${balanceWithoutThis.toFixed(2)} left owing on this invoice.`]
    };
  }

  const nextPayments = [...list];
  nextPayments[pIdx] = merged;
  const next = { ...current, payments: nextPayments };
  next.amountPaid = amountPaidOf(next);
  next.balanceDue = balanceDueOf(next);
  next.status = statusForPayments(next, current.status);
  if (next.status !== "paid") next.paidAt = null;
  next.updatedAt = new Date().toISOString();
  next.history = [...(current.history || []), {
    ts: next.updatedAt,
    action: "payment_updated",
    by,
    note: `$${before.amount.toFixed(2)} → $${merged.amount.toFixed(2)} (${PAYMENT_METHOD_LABELS[merged.method] || merged.method}) — balance now $${next.balanceDue.toFixed(2)}`
  }];
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: hydrate(next), payment: merged };
}

async function removePayment(id, paymentId, { by = "admin", reason = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, errors: ["Invoice not found."] };
  const current = records[idx];
  if (current.status === "void") {
    return { ok: false, status: 409, code: "invoice_void", errors: ["Can't edit payments on a void invoice."] };
  }
  const list = Array.isArray(current.payments) ? current.payments : [];
  const gone = list.find((p) => p.id === paymentId);
  if (!gone) return { ok: false, status: 404, errors: ["Payment not found."] };

  const next = { ...current, payments: list.filter((p) => p.id !== paymentId) };
  next.amountPaid = amountPaidOf(next);
  next.balanceDue = balanceDueOf(next);
  next.status = statusForPayments(next, current.status);
  // Reversing the payment that settled the invoice un-settles it.
  if (next.status !== "paid") next.paidAt = null;
  next.updatedAt = new Date().toISOString();
  next.history = [...(current.history || []), {
    ts: next.updatedAt,
    action: "payment_reversed",
    by,
    note: `Reversed ${PAYMENT_METHOD_LABELS[gone.method] || gone.method} $${gone.amount.toFixed(2)}${reason ? ` — ${reason}` : ""} — balance now $${next.balanceDue.toFixed(2)}`
  }];
  records[idx] = next;
  await writeAll(records);
  return { ok: true, invoice: hydrate(next), removed: gone };
}

module.exports = {
  STATUSES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  addPayment: withStoreLock(addPayment),
  updatePayment: withStoreLock(updatePayment),
  removePayment: withStoreLock(removePayment),
  amountPaidOf,
  balanceDueOf,
  // Exported for the balance-surface regression tests: the send-time
  // re-derive is the rule that decides whether a customer who paid a
  // deposit on site sees "partially paid" or a stale "sent".
  statusForPayments,
  HST_RATE,
  INVOICE_DISCLAIMERS,
  PAYMENT_ATTEMPT_OUTCOMES,
  DELETED_FILE,
  list,
  get,
  listByWorkOrder,
  totalsForLines,
  listByQuote,
  listByProperty,
  createDraft: withStoreLock(createDraft),
  activeInvoiceForWorkOrder,
  update: withStoreLock(update),
  appendHistory: withStoreLock(appendHistory),
  appendPaymentAttempt: withStoreLock(appendPaymentAttempt),
  voidInvoice: withStoreLock(voidInvoice),
  revise: withStoreLock(revise),
  markRevisionNotified: withStoreLock(markRevisionNotified),
  originalTotal,
  remove: withStoreLock(remove),
  ensurePaymentToken: withStoreLock(ensurePaymentToken),
  openForOnSitePayment: withStoreLock(openForOnSitePayment),
  isPayableOnline,
  // PJL-96
  payBlockReason,
  isPriceUnconfirmed,
  isPriceSetByPjl,
  confirmPrice: withStoreLock(confirmPrice),
  setScopeHold: withStoreLock(setScopeHold),
  getByPaymentToken,
  ensurePortalToken: withStoreLock(ensurePortalToken),
  getByPortalToken
};

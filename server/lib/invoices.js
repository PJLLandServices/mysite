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
// Tombstone log for hard-deleted void invoices (feature-invoice-void-delete-
// brief.md, 2026-07). Append-only, never pruned, never edited. Deliberately
// EXCLUDED from the customer-delete referential scan (that scan lists files
// explicitly in customers.hardDelete — this file is not among them), so a
// tombstone can never re-block deleting the customer it belonged to.
const DELETED_FILE = path.join(__dirname, "..", "data", "deleted-invoices.json");
const HST_RATE = 0.13;

const STATUSES = ["draft", "sent", "partially_paid", "paid", "void"];

// Payment methods. card_qb is the online QuickBooks card charge; the rest
// are recorded by hand after the money arrives some other way.
const PAYMENT_METHODS = ["cash", "e_transfer", "cheque", "card_qb", "other"];
const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  e_transfer: "e-Transfer",
  cheque: "Cheque",
  card_qb: "Card",
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
  if (currentStatus === "draft" || currentStatus === "void") return currentStatus;
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

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(hydrate) : [];
  } catch {
    return [];
  }
}

// Atomic write: stage to .tmp, rename over the real file. Prevents a
// partial invoices.json if the process dies mid-write — matters more now
// that remove() rewrites the file after appending a tombstone (a torn
// invoices.json with an already-written tombstone would be recoverable,
// but a torn write on any path is worth avoiding). Matches parts.js.
async function writeAll(records) {
  await ensureFile();
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  await fs.rename(tmp, FILE);
}

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
  return {
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
    stripeChargeId: inv?.stripeChargeId || null,
    sentAt: inv?.sentAt || null,
    paidAt: inv?.paidAt || null,
    voidedAt: inv?.voidedAt || null,
    // Void audit (feature-invoice-void-delete-brief.md). Set together by
    // voidInvoice(). voidReason is optional per Patrick's steer — the
    // mandatory reason lives on the DELETE step / tombstone, not here.
    voidedBy: inv?.voidedBy || null,
    voidReason: inv?.voidReason || "",
    // Whether the originating WO had paidOnSite=true at cascade time.
    // Persisted so the customer email + the invoice page can reshape
    // copy ("Thanks, payment received in the field") vs the default
    // "Invoice attached, due in N days." Patrick still reviews before
    // sending or marking paid — this flag is informational, not a
    // status accelerant. Brief C / spec §4.3.2.
    paidOnSiteAtCompletion: inv?.paidOnSiteAtCompletion === true,
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
    createdAt: inv?.createdAt || new Date().toISOString(),
    updatedAt: inv?.updatedAt || new Date().toISOString(),
    history: Array.isArray(inv?.history) ? inv.history : []
  };
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

async function listByWorkOrder(woId) {
  const records = await readAll();
  return records.filter((r) => r.woId === woId);
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
  const inv = hydrate({
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
  const next = { ...current };
  const allowed = ["status", "notes", "quickbooksInvoiceId", "quickbooksChargeId", "quickbooksPaymentId", "stripePaymentIntentId", "stripeChargeId", "paymentToken", "portalToken", "customerSmsScheduledAt", "customerSmsSentAt", "customerReminderHistory", "customerJunkMailWarningSentAt", "customerJunkMailWarningHistory", "customerName", "customerEmail", "customerPhone", "address", "holdUntilCompletion"];
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
  addPayment,
  updatePayment,
  removePayment,
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
  listByProperty,
  createDraft,
  update,
  appendHistory,
  appendPaymentAttempt,
  voidInvoice,
  remove,
  ensurePaymentToken,
  getByPaymentToken,
  ensurePortalToken,
  getByPortalToken
};

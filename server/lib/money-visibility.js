"use strict";

// Who may see a job's money (Patrick, 2026-10-02): "Financial amounts and
// the Financials tab must be office-only. A technician may see an
// operational notice that office billing attention is required, but no
// contract, invoice, payment, outstanding, or reconciliation amounts."
//
// ONE rule — canSeeMoney — and one set of redactions, applied by the
// server to every /api/projects/* read before it leaves. The screens never
// decide this: a technician's browser is simply never sent the figures.
//
// Scope: the project workspace (/api/projects/*: the list, the header, the
// Overview, Financials, billing preview, Change Orders, the completion
// check and the raw change-request list). The classic invoice pages and
// /api/invoices are NOT covered here — the field app reads an invoice's
// amount to take payment on site — and that boundary is reported, not
// silently assumed.

// The office: an admin account. A technician is role "tech".
function canSeeMoney(session) {
  return Boolean(session && session.role === "admin");
}

const OFFICE_NOTICE = "Billing needs the office's attention.";
const OFFICE_ONLY = "Office only";

// Keys that hold a contract, quote, invoice or payment amount anywhere in
// a project-side payload. A key ending in "Cents" is money too.
const MONEY_KEYS = new Set([
  "total", "subtotal", "hst", "tax", "price", "unitPrice", "lineTotal",
  "amount", "amountPaid", "balanceDue", "owed", "received", "invoiced",
  "unresolved", "notYetInvoiced", "estimatedTotal", "netChangeSubtotal",
  "netChangeTotal", "grandTotal", "balance", "labourRateLocked",
  "negotiatedLabourRate", "rate", "deposit", "depositAmount"
]);
const isMoneyKey = (k) => MONEY_KEYS.has(k) || /Cents$/.test(k);

// Dollar figures inside prose (a proposal section that says "$5,650.00
// includes…"): the words stay — the crew needs the scope — the amount goes.
const DOLLARS_RE = /\$\s?-?\d[\d,]*(?:\.\d+)?/g;
function maskAmounts(text) {
  return typeof text === "string" ? text.replace(DOLLARS_RE, "[office only]") : text;
}

// A deep copy with every money field set to null (kept, so a screen can
// tell "office only" from "missing"), and any dollar figure in its text
// masked. Use redactText for a sentence that is ABOUT an amount.
function stripMoney(value) {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (typeof value === "string") return maskAmounts(value);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isMoneyKey(k) && (typeof v === "number" || (v && typeof v === "object") || typeof v === "string") ? null : stripMoney(v);
  }
  return out;
}

// A sentence with any dollar figure in it is an amount; a technician gets
// the office notice instead of a sentence with the number blanked out.
const AMOUNT_RE = /\$\s?-?\d|\(\s*\$?\d[\d,]*\.\d{2}\s*\)|\b\d[\d,]*\.\d{2}\b/;
function redactText(text, fallback = OFFICE_NOTICE) {
  return typeof text === "string" && AMOUNT_RE.test(text) ? fallback : text;
}

// Completion blockers that are about money. Their sentences quote amounts
// or point at the Financials tab, so a technician gets the notice instead.
const MONEY_BLOCKER_KEYS = new Set([
  "deposit_unpaid", "payment_reconciliation_required",
  "deposit_balance_predates_revision", "no_labour_rate"
]);
function redactBlockers(blockers) {
  return (blockers || []).map((b) => {
    const money = MONEY_BLOCKER_KEYS.has(b.key);
    const out = { ...b, message: money ? OFFICE_NOTICE : redactText(b.message) };
    if (money && "href" in b) { out.href = null; out.tab = null; }
    return out;
  });
}

// Which version is signed stays (id, version, status, dates); every amount
// on it — total, subtotal, HST — goes.
function redactAgreementVersion(v) {
  return v ? stripMoney(v) : v;
}

function agreementForTech(a) {
  if (!a) return a;
  return {
    ...a,
    original: redactAgreementVersion(a.original),
    governing: redactAgreementVersion(a.governing),
    pending: redactAgreementVersion(a.pending),
    versions: (a.versions || []).map(redactAgreementVersion),
    netChangeSubtotal: null,
    netChangeTotal: null
  };
}

// Is there anything about this job's money the office must deal with?
// The notice a technician sees is a yes/no — never the amount behind it.
function needsOfficeAttention(financialsModel) {
  return Boolean(financialsModel && (
    (financialsModel.reconciliation || []).length ||
    (financialsModel.holds || []).length
  ));
}

// ---- Per-route redactions ------------------------------------------

function overviewForTech(ov, { attention }) {
  const action = ov.status.nextAction;
  const moneyAction = /reconcile payment|collect payment/i.test(action.headline) ||
    (action.href && /\/admin\/invoice\/|\/financials$/.test(action.href));
  return {
    ...ov,
    viewer: { canSeeMoney: false },
    status: {
      ...ov.status,
      nextAction: moneyAction
        ? { headline: "Office billing attention needed", detail: "The office is dealing with billing on this job — nothing for the crew to do here.", tone: "waiting" }
        : { ...action, detail: redactText(action.detail) },
      blockers: redactBlockers(ov.status.blockers)
    },
    materials: {
      ...ov.materials,
      // A price warning's sentence quotes dollars; the kind and part stay.
      exceptions: ov.materials.exceptions.map((e) => ({ ...e, detail: redactText(e.detail, "") }))
    },
    changeOrders: {
      ...ov.changeOrders,
      agreement: {
        governing: redactAgreementVersion(ov.changeOrders.agreement.governing),
        pending: redactAgreementVersion(ov.changeOrders.agreement.pending),
        netChangeTotal: null
      },
      holds: (ov.changeOrders.holds || []).map((h) => ({ ...h, message: MONEY_BLOCKER_KEYS.has(h.key) ? OFFICE_NOTICE : redactText(h.message) })),
      billingBlocked: ov.changeOrders.billingBlocked ? { key: ov.changeOrders.billingBlocked.key, message: OFFICE_NOTICE } : null
    },
    financials: {
      restricted: true,
      attention: Boolean(attention),
      notice: attention ? "Office billing attention required." : null
    }
  };
}

function changeOrdersForTech(model) {
  return {
    ...model,
    agreement: agreementForTech(model.agreement),
    billingBlocked: model.billingBlocked ? { key: model.billingBlocked.key, message: OFFICE_NOTICE } : null,
    holds: (model.holds || []).map((h) => ({ ...h, message: MONEY_BLOCKER_KEYS.has(h.key) ? OFFICE_NOTICE : redactText(h.message) })),
    changes: (model.changes || []).map((c) => ({ ...stripMoney(c), next: redactText(c.next), description: c.description })),
    viewer: { canSeeMoney: false }
  };
}

// GET /api/projects/:id — the workspace header and every tab's project.
function projectDetailForTech(payload, { attention }) {
  const p = payload.project || {};
  return {
    ...payload,
    project: {
      ...p,
      labourRateLocked: null,
      proposalSnapshot: p.proposalSnapshot ? stripMoney(p.proposalSnapshot) : p.proposalSnapshot,
      scopeChangeRequests: stripMoney(p.scopeChangeRequests || [])
    },
    linkedQuote: payload.linkedQuote ? stripMoney(payload.linkedQuote) : payload.linkedQuote,
    agreement: agreementForTech(payload.agreement),
    invoiceSummary: null,
    billing: { kind: attention ? "attention" : "restricted", hint: attention ? "Office billing attention required." : OFFICE_ONLY, owed: null, received: null, unresolved: null, actionInvoice: null },
    viewer: { canSeeMoney: false }
  };
}

// GET /api/projects — the list and the Dashboard.
function projectListForTech(payload) {
  return {
    ...payload,
    projects: (payload.projects || []).map((p) => ({
      ...p,
      labourRateLocked: null,
      proposalSnapshot: p.proposalSnapshot ? stripMoney(p.proposalSnapshot) : p.proposalSnapshot,
      scopeChangeRequests: stripMoney(p.scopeChangeRequests || []),
      agreement: agreementForTech(p.agreement)
    })),
    totals: null,
    viewer: { canSeeMoney: false }
  };
}

module.exports = {
  canSeeMoney,
  stripMoney,
  maskAmounts,
  redactText,
  redactBlockers,
  agreementForTech,
  needsOfficeAttention,
  overviewForTech,
  changeOrdersForTech,
  projectDetailForTech,
  projectListForTech,
  OFFICE_NOTICE,
  OFFICE_ONLY,
  MONEY_KEYS
};

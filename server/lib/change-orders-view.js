// server/lib/change-orders-view.js
//
// The read model behind the project workspace's Change Orders tab
// (PR 3 of the Change Orders work, 2026-09-27). Read-only: the tab shows
// this and acts on nothing — sending, recording the customer's answer,
// withdrawing and generating the revised quote stay on the classic
// project page, behind the office-only routes.
//
// Everything the tab displays is decided HERE, from rules that already
// exist, so the screen can never draw a second answer:
//
//   which changes are still open  → projects.scopeChangeStage (the one
//                                   rule the Overview count, completion
//                                   check and status email share)
//   which quote the job is billed on, and the revision awaiting a
//   signature                     → quotes.describeChain, via
//                                   projects.resolveProjectQuote
//   what is holding completion    → projects.completionPreflight's own
//                                   blockers, passed in, never re-derived
//
// Pure: describeChangeOrders() takes records and returns the model, so a
// test can run it over any fixture.

const quotesLib = require("./quotes");

const cents = (n) => Math.round((Number(n) || 0) * 100);
const dollars = (c) => Math.round(c) / 100;

// Blockers the tab is about. Anything else (tasks, final WO, …) belongs to
// the Overview, not here.
const CHANGE_BLOCKERS = new Set([
  "scope_changes_unresolved",
  "approved_scr_no_revision",
  "revision_unsigned",
  "deposit_balance_predates_revision"
]);

function quoteSummary(q, role) {
  if (!q) return null;
  return {
    id: q.id,
    version: Number(q.version) || 1,
    status: q.status,
    role,
    signed: quotesLib.isSignedAgreement(q),
    acceptedAt: q.acceptedAt || null,
    subtotal: dollars(cents(q.subtotal)),
    total: dollars(cents(q.total)),
    href: `/admin/quote/${encodeURIComponent(q.id)}/proposal`
  };
}

// Where a change actually stands, one step past its own status: an
// executed change's fate is its revised quote's.
function phaseOf(scr, proj, chainInfo, byId, stageOf, revisionStateOf) {
  const stage = stageOf(scr, proj);
  if (stage === "in_review" && scr.sendInFlight) {
    // An interrupted send (saved before the email went; see
    // projects.sendScopeChangeRequest): nobody knows whether it arrived.
    return { phase: "in_review", label: "Delivery uncertain", next: `A send to ${scr.sendInFlight.to || "the customer"} was interrupted before its result was saved, so nobody can tell whether it arrived. The office checks and records whether it went; it will not be sent again until then.` };
  }
  if (stage === "in_review") {
    const attempts = Array.isArray(scr.sendAttempts) ? scr.sendAttempts : [];
    const last = attempts[attempts.length - 1];
    return last && last.ok === false
      // The recorded reason already reads as a sentence ("The email did not
      // go: …", "The customer has no email address …") — shown as written.
      ? { phase: "in_review", label: "Not sent", next: `Not sent — ${String(last.reason || "no reason was recorded").replace(/\.?\s*$/, ".")} The office can fix it and send again, or record the customer's answer by hand.` }
      : { phase: "in_review", label: "Draft", next: "Waiting on the office to review and send it to the customer." };
  }
  if (stage === "awaiting_customer") {
    return { phase: "awaiting_customer", label: "Awaiting customer", next: "Sent to the customer. Waiting on their answer." };
  }
  if (stage === "awaiting_revision") {
    return { phase: "awaiting_revision", label: "Approved — needs revised quote", next: "The customer approved it. The office generates the revised quote for their signature; until then the job is still billed on the signed agreement." };
  }
  switch (scr.status) {
    case "approved":
      // Only a time & material job reaches here (scopeChangeStage).
      return { phase: "approved_tm", label: "Approved", next: "Approved. Time & material — billed as the hours it takes." };
    case "rejected":
      return { phase: "rejected", label: "Declined by customer", next: "Not going ahead. Not in the price." };
    case "withdrawn":
      return { phase: "withdrawn", label: "Withdrawn", next: "Withdrawn by the office. Not in the price." };
    case "executed_under_revision": {
      // projects.scopeChangeRevisionState — the SAME rule the withdraw guard
      // uses, so the tab and the guard can never disagree about whether a
      // change is signed, still awaiting a signature, or out of the price.
      const { state, quote } = revisionStateOf(scr, chainInfo);
      const gov = chainInfo.governing;
      if (state === "missing") return { phase: "revision_missing", label: "Revision not found", next: `Revised quote ${scr.linkedRevisionQuoteId || "?"} is not on file.` };
      if (state === "signed") {
        return { phase: "signed", label: "Signed", next: `In the signed agreement ${quote.id} (v${Number(quote.version) || 1}) — billed at completion.` };
      }
      if (state === "unsigned") {
        return quote.status === "draft"
          ? { phase: "awaiting_signature", label: "In revised quote (draft)", next: `In revised quote ${quote.id}, still a draft — the office sends it for the customer's signature. Completion is held until it is signed or declined.` }
          : { phase: "awaiting_signature", label: "Awaiting signature", next: `In revised quote ${quote.id}, waiting on the customer's signature. Completion is held until it is signed or declined.` };
      }
      return { phase: "revision_declined", label: "Revision not signed", next: `The customer did not sign revised quote ${quote.id}. Not in the price — the job stays on ${gov ? gov.id : "its signed agreement"}.` };
    }
    default:
      return { phase: String(scr.status || "unknown"), label: String(scr.status || "Unknown"), next: "" };
  }
}

function describeChangeOrders({ project, chainInfo, blockers = [], stageOf, describeAgreement, revisionStateOf }) {
  const proj = project || {};
  const info = chainInfo || { chain: [], governing: null, pending: null };
  const byId = new Map((info.chain || []).map((q) => [q.id, q]));
  // Revisions linked from a change but outside the project's chain (should
  // not happen; shown honestly as "not found" rather than guessed at).
  // The agreement is projects.describeAgreement's — the same answer the
  // workspace header shows. Roles for the version list come from it too.
  const agreement = describeAgreement(info);
  const original = agreement.original ? byId.get(agreement.original.id) : null;
  const governing = info.governing || null;
  const pending = info.pending || null;

  const versions = (info.chain || []).map((q) => {
    let role = q.status;
    if (original && q.id === original.id) role = "original";
    if (governing && q.id === governing.id) role = original && q.id === original.id ? "original_governing" : "governing";
    if (pending && q.id === pending.id) role = "pending";
    return quoteSummary(q, role);
  });

  const changes = (proj.scopeChangeRequests || []).map((s) => {
    const p = phaseOf(s, proj, info, byId, stageOf, revisionStateOf);
    const attempts = Array.isArray(s.sendAttempts) ? s.sendAttempts : [];
    const woId = s.capturedFromWoId || null;
    const rev = s.linkedRevisionQuoteId ? byId.get(s.linkedRevisionQuoteId) : null;
    return {
      id: s.id,
      description: s.description || "",
      status: s.status,
      phase: p.phase,
      phaseLabel: p.label,
      next: p.next,
      // THE shared rule (projects.scopeChangeStage) — the same answer the
      // Overview count, the completion check and the status email give. A
      // change already in a revised quote is not "open" by that rule; the
      // unsigned revision holds the job instead (holds[] below).
      open: stageOf(s, proj) !== null,
      capturedBy: s.capturedBy || null,
      capturedAt: s.capturedAt || null,
      capturedFromWoId: woId,
      photos: (Array.isArray(s.photoIds) ? s.photoIds : []).map((n) => ({
        n: String(n),
        // Staff-session photo route; without the work order the number
        // alone points nowhere, so no link is invented.
        href: woId ? `/api/work-orders/${encodeURIComponent(woId)}/photo/${encodeURIComponent(n)}` : null
      })),
      lineItems: (s.suggestedLineItems || []).map((li) => ({
        label: li.label || "",
        qty: Number(li.qty) || 0,
        price: dollars(cents(li.price)),
        lineTotal: dollars(cents(li.lineTotal))
      })),
      estimatedTotal: dollars(cents(s.estimatedTotal)),
      sent: s.sentAt ? { at: s.sentAt, by: s.sentBy || null, to: s.draftEmail?.to || null } : null,
      sendAttempts: attempts.map((a) => ({ at: a.at || null, by: a.by || null, to: a.to || null, ok: a.ok === true, reason: a.reason || null })),
      decision: s.resolvedAt ? {
        as: s.resolvedAs || null,
        // Older records carry no decisionSource: say so rather than guess.
        source: s.decisionSource || null,
        recordedBy: s.recordedBy || null,
        at: s.resolvedAt,
        note: s.resolutionNote || ""
      } : null,
      revision: s.linkedRevisionQuoteId ? {
        id: s.linkedRevisionQuoteId,
        version: rev ? Number(rev.version) || 1 : null,
        status: rev ? rev.status : null,
        signed: rev ? quotesLib.isSignedAgreement(rev) : false,
        href: `/admin/quote/${encodeURIComponent(s.linkedRevisionQuoteId)}/proposal`
      } : null
    };
  });

  const count = (fn) => changes.filter(fn).length;
  const holds = (blockers || [])
    .filter((b) => CHANGE_BLOCKERS.has(b.key))
    .map((b) => ({ key: b.key, message: b.message }));
  // A deposit job whose balance was built from an older version is held
  // until the office corrects it — the signed revision is NOT invoiced
  // automatically, and the tab must not suggest it will be.
  const depositHold = holds.find((h) => h.key === "deposit_balance_predates_revision") || null;
  const billingBlocked = depositHold ? {
    key: depositHold.key,
    message: `Billing is on hold until the office corrects the deposit balance. ${depositHold.message} The signed revision will not be invoiced automatically.`
  } : null;
  if (billingBlocked) {
    for (const c of changes) {
      if (c.phase === "signed") {
        c.next = "In the signed agreement — but billing is on hold until the office corrects the deposit balance. It will not be invoiced automatically.";
      }
    }
  }

  return {
    projectId: proj.id || null,
    billingMode: proj.billingMode || null,
    agreement: {
      original: quoteSummary(original, "original"),
      governing: quoteSummary(governing, "governing"),
      pending: quoteSummary(pending, "pending"),
      // Newest signed minus original (describeAgreement) — never a sum.
      netChangeSubtotal: agreement.netChangeSubtotal,
      netChangeTotal: agreement.netChangeTotal,
      versions
    },
    billingBlocked,
    summary: {
      total: changes.length,
      open: count((c) => c.open),
      awaitingOffice: count((c) => c.phase === "in_review" || c.phase === "awaiting_revision"),
      awaitingCustomer: count((c) => c.phase === "awaiting_customer"),
      awaitingSignature: count((c) => c.phase === "awaiting_signature"),
      signed: count((c) => c.phase === "signed")
    },
    holds,
    changes,
    classicHref: proj.id ? `/admin/project/${encodeURIComponent(proj.id)}` : null
  };
}

module.exports = { describeChangeOrders, CHANGE_BLOCKERS };

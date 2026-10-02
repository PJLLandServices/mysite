"use strict";

// "What do I need to do next?" — the one call at the top of the project
// Overview (2026-10-02, stage 6 of the Project Workspace).
//
// This used to live in the browser (admin-app/src/lib/nextAction.ts) and
// read the raw project there: it counted tasks itself and, on a job whose
// tasks were all done, said "Complete and invoice" without asking the
// completion check — so it could send the office to complete a job the
// server would refuse to complete (an unsigned revision, an unpaid
// deposit, a payment still being reconciled).
//
// It now runs on the server over answers the server already owns, and
// decides nothing of its own:
//   progress  — projects.computeProjectMetrics (the Tasks tab's numbers)
//   invoice   — financials-view billingSummary().actionInvoice (the
//               Financials tab's choice of the invoice the next step is
//               about: one still owing, else a draft to send; never a
//               held balance invoice)
//   blockers  — projects.completionPreflight().blockers (what the
//               completion route itself refuses on)
//   quote / design — the project route's linkedQuote and siteBuilderSummary
// No pricing, scheduling or lifecycle transition happens here.

const ACCEPTED_STATES = new Set(["accepted", "partially_accepted"]);
const LIVE_QUOTE_STATES = new Set(["sent", "pending_admin_attestation"]);

// The tab that explains each completion blocker. Every key the preflight
// raises is listed; one it does not know falls back to the classic
// project page, which shows every blocker with its override.
const BLOCKER_TAB = {
  scope_changes_unresolved: "changes",
  approved_scr_no_revision: "changes",
  revision_unsigned: "changes",
  deposit_balance_predates_revision: "financials",
  deposit_unpaid: "financials",
  payment_reconciliation_required: "financials",
  no_labour_rate: "financials"
};

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("CA$", "$");
}

function blockerHref(projectId, key) {
  const tab = BLOCKER_TAB[key];
  return tab ? `/app/projects/${projectId}/${tab}` : `/admin/project/${projectId}`;
}

function nextAction({ project, progress, quote = null, invoice = null, design = null, blockers = [] }) {
  const id = encodeURIComponent(project.id);
  const done = Number(progress && progress.doneTasks) || 0;
  const total = Number(progress && progress.totalTasks) || 0;
  const remaining = total - done;
  const visits = (project.workOrderIds || []).length;

  if (project.status === "archived") {
    return { headline: "Archived", detail: "This job is archived. Nothing is outstanding.", tone: "done" };
  }

  // An invoice marked Paid with its payments short outranks everything:
  // what the customer owes isn't known, so it must not be chased as a
  // balance (that could charge them twice). The office reconciles it on
  // the invoice page (payment reconciliation, 2026-09-28).
  if (invoice && invoice.reconciliationRequired) {
    return {
      headline: "Reconcile payment",
      detail: `${invoice.id} is marked Paid, but ${fmtMoney(invoice.unresolved)} of it isn't recorded as a payment. Record the missing payment, or correct the status to Partially paid.`,
      href: `/admin/invoice/${encodeURIComponent(invoice.id)}`,
      ctaLabel: "Open invoice",
      tone: "act"
    };
  }

  // Money owed outranks everything else on a finished job — it's the only
  // thing left that costs something to forget.
  if (invoice && Number(invoice.balanceDue) > 0) {
    return {
      headline: "Collect payment",
      detail: `${invoice.id} — ${fmtMoney(invoice.balanceDue)} outstanding${invoice.status === "draft" ? ", invoice not sent yet" : ""}`,
      href: `/admin/invoice/${encodeURIComponent(invoice.id)}`,
      ctaLabel: "Open invoice",
      tone: invoice.status === "draft" ? "act" : "waiting"
    };
  }

  if (project.status === "complete") {
    return {
      headline: "Complete",
      detail: invoice && invoice.paidAt ? "Invoiced and paid in full." : "Work is done and nothing is outstanding.",
      tone: "done"
    };
  }

  // A design exists when it has traced areas. Stations are what it
  // produces from them, and a design with areas but no stations is
  // half-drawn rather than absent — the line below still points at it.
  if (!design || !design.areaCount) {
    return {
      headline: "Start the system design",
      detail: "No zones laid out yet — the design drives the parts list and the proposal.",
      href: `/app/projects/${id}/design`,
      ctaLabel: "Open System Design",
      tone: "act"
    };
  }

  if (!quote && !(project.proposalSnapshot && project.proposalSnapshot.acceptedAt)) {
    return {
      headline: "Build the proposal",
      detail: `${design.stationCount} station${design.stationCount === 1 ? "" : "s"} across ` +
              `${design.valveCount} valve${design.valveCount === 1 ? "" : "s"} designed, ` +
              `but no proposal raised yet.`,
      href: `/app/projects/${id}/scope`,
      ctaLabel: "Open Proposal",
      tone: "act"
    };
  }

  // A proposalSnapshot is frozen at conversion — its presence means a
  // proposal WAS accepted and this job is sold, even if the currently
  // linked quote is a fresh draft revision raised afterwards. Reading only
  // the live quote's status would tell a crew mid-install to "send the
  // proposal" on a job they're already building (PR #286).
  const sold = Boolean(project.proposalSnapshot && project.proposalSnapshot.acceptedAt);

  if (quote && !sold && !ACCEPTED_STATES.has(quote.status)) {
    if (LIVE_QUOTE_STATES.has(quote.status) || quote.confirmed === true) {
      return {
        headline: "Awaiting customer acceptance",
        detail: `Proposal ${quote.id} v${quote.version} is with the customer.`,
        href: `/app/projects/${id}/scope`,
        ctaLabel: "Open Proposal",
        tone: "waiting"
      };
    }
    return {
      headline: "Send the proposal",
      detail: `Proposal ${quote.id} v${quote.version} is still a draft.`,
      href: `/app/projects/${id}/scope`,
      ctaLabel: "Open Proposal",
      tone: "act"
    };
  }

  if (!visits) {
    return {
      headline: "Schedule installation",
      detail: `No installation date assigned${total ? ` · ${remaining} task${remaining === 1 ? "" : "s"} remaining` : ""}`,
      href: "/admin/schedule",
      ctaLabel: "Open the schedule",
      tone: "act"
    };
  }

  if (remaining > 0) {
    return {
      headline: "Finish the install",
      detail: `${remaining} of ${total} task${total === 1 ? "" : "s"} still outstanding across ${visits} visit${visits === 1 ? "" : "s"}.`,
      href: `/app/projects/${id}/tasks`,
      ctaLabel: "Open Tasks",
      tone: "act"
    };
  }

  if (!invoice) {
    // The work is done — but completion is the server's call. If the
    // completion check would refuse, say what it refuses on instead of
    // sending the office to a button that won't work.
    const first = (blockers || [])[0];
    if (first) {
      return {
        headline: "Clear what's holding completion",
        detail: (blockers.length > 1 ? `${first.message} (and ${blockers.length - 1} more)` : first.message),
        href: blockerHref(id, first.key),
        ctaLabel: "See why",
        tone: "act"
      };
    }
    return {
      headline: "Complete and invoice",
      detail: "Every task is done — run the completion cascade to raise the final invoice.",
      href: `/admin/project/${id}`,
      ctaLabel: "Open closeout",
      tone: "act"
    };
  }

  return {
    headline: "Nothing outstanding",
    detail: invoice.paidAt ? `${invoice.id} paid in full.` : `${invoice.id} settled.`,
    tone: "done"
  };
}

module.exports = { nextAction, BLOCKER_TAB };

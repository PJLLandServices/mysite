import type { InvoiceSummary, LinkedQuote, ProjectDetail, SiteBuilderSummary } from "./api.ts";
// Explicit .ts extensions: this module is pure logic with no DOM, so
// scripts/test-next-action.mjs runs it directly under Node's type
// stripping. Vite resolves these identically.
import { money, taskProgress } from "./format.ts";

/* "What do I need to do next?" — the question the overview has to answer
   before any other.

   This reads state the server already reports; it does not decide
   anything the backend hasn't already decided. Every branch below is a
   plain reading of records that exist (is there a design, is the
   proposal accepted, is a visit booked, are tasks outstanding, is money
   owed) — no pricing, no scheduling rules, no lifecycle transitions.
   Those all stay server-side where they belong. */

export interface NextAction {
  /** The imperative — what to actually do. */
  headline: string;
  /** The evidence behind it, so the call is never mysterious. */
  detail: string;
  /** Where to go to do it: a workspace tab, or a classic screen. */
  href?: string;
  ctaLabel?: string;
  /** waiting = the ball is in someone else's court. */
  tone: "act" | "waiting" | "done";
}

const ACCEPTED_STATES = new Set(["accepted", "partially_accepted"]);
const LIVE_QUOTE_STATES = new Set(["sent", "pending_admin_attestation"]);

export function nextAction(
  project: ProjectDetail,
  quote: LinkedQuote | null | undefined,
  invoice: InvoiceSummary | null | undefined,
  design: SiteBuilderSummary | null | undefined
): NextAction {
  const id = encodeURIComponent(project.id);
  const { done, total } = taskProgress(project.tasks);
  const remaining = total - done;
  const visits = (project.workOrderIds || []).length;

  if (project.status === "archived") {
    return { headline: "Archived", detail: "This job is archived. Nothing is outstanding.", tone: "done" };
  }

  // Money owed outranks everything else on a finished job — it's the
  // only thing left that costs something to forget.
  if (invoice && Number(invoice.balanceDue) > 0) {
    return {
      headline: "Collect payment",
      detail: `${invoice.id} — ${money(invoice.balanceDue)} outstanding${invoice.status === "draft" ? ", invoice not sent yet" : ""}`,
      href: `/admin/invoice/${encodeURIComponent(invoice.id)}`,
      ctaLabel: "Open invoice",
      tone: invoice.status === "draft" ? "act" : "waiting"
    };
  }

  if (project.status === "complete") {
    return {
      headline: "Complete",
      detail: invoice?.paidAt ? "Invoiced and paid in full." : "Work is done and nothing is outstanding.",
      tone: "done"
    };
  }

  if (!design || !design.zoneCount) {
    return {
      headline: "Start the system design",
      detail: "No zones laid out yet — the design drives the parts list and the proposal.",
      href: `/app/projects/${id}/design`,
      ctaLabel: "Open System Design",
      tone: "act"
    };
  }

  if (!quote && !project.proposalSnapshot?.acceptedAt) {
    return {
      headline: "Build the proposal",
      detail: `${design.zoneCount} zones designed, but no proposal raised yet.`,
      href: `/app/projects/${id}/scope`,
      ctaLabel: "Open Proposal",
      tone: "act"
    };
  }

  // A proposalSnapshot is frozen at conversion — its presence means a
  // proposal WAS accepted and this job is sold, even if the currently
  // linked quote is a fresh draft revision raised afterwards. Reading
  // only the live quote's status would tell a crew mid-install to "send
  // the proposal" on a job they're already building.
  const sold = Boolean(project.proposalSnapshot?.acceptedAt);

  if (quote && !sold && !ACCEPTED_STATES.has(quote.status)) {
    if (isWithCustomer(quote)) {
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

function isWithCustomer(quote: LinkedQuote) {
  return LIVE_QUOTE_STATES.has(quote.status) || quote.confirmed === true;
}

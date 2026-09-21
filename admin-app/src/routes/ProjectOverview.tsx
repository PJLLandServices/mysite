import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, type ProjectStatus } from "../lib/api";
import { BRANCH_LABELS, PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, money, shortDate, taskProgress } from "../lib/format";
import { nextAction } from "../lib/nextAction";
import { PageBody, PageHeader } from "../shell/AppShell";
import { Button, Card, CardHeader, ErrorNote, LoadingRows, Stat, StatusPill, cx } from "../ui/primitives";

/* The project workspace. The old page put every field of every related
   record on one scroll; this is the summary a person needs to answer
   "what is this job, where does it stand, and what do I do next" — with
   the detail one click away rather than one thousand pixels away. */

const TABS = [
  { to: ".", label: "Overview", end: true },
  { to: "design", label: "System Design" },
  { to: "scope", label: "Proposal" },
  { to: "tasks", label: "Tasks" },
  { to: "materials", label: "Materials" },
  { to: "records", label: "Daily Records" },
  { to: "changes", label: "Change Orders" },
  { to: "financials", label: "Financials" },
  { to: "closeout", label: "Closeout" }
];

export function ProjectWorkspace() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => projectsApi.get(id),
    enabled: !!id
  });

  if (isLoading) {
    return (
      <PageBody>
        <LoadingRows rows={5} />
      </PageBody>
    );
  }
  if (error) {
    return (
      <PageBody>
        <ErrorNote>{(error as Error).message}</ErrorNote>
      </PageBody>
    );
  }
  if (!data) return null;

  const p = data.project;
  const status = (p.status || "planning") as ProjectStatus;
  const { done, total } = taskProgress(p.tasks);
  const value = data.linkedQuote?.total ?? p.proposalSnapshot?.total;
  const invoice = data.invoiceSummary;
  const design = data.siteBuilderSummary;
  const goTab = (tab: string) => navigate(`/app/projects/${encodeURIComponent(p.id)}/${tab}`);

  const billing = invoice
    ? Number(invoice.balanceDue) > 0
      ? { value: money(invoice.balanceDue), hint: "outstanding", tone: "money" as const }
      : { value: "Paid", hint: invoice.paidAt ? shortDate(invoice.paidAt) : "nothing outstanding", tone: "default" as const }
    : { value: "—", hint: "not invoiced yet", tone: "muted" as const };

  return (
    <>
      {/* Identity and the section nav stay put while a long section
          scrolls — you should never lose track of which job you're in. */}
      <div className="sticky top-0 lg:top-0 z-30 bg-surface border-b border-line">
        <PageHeader
          backTo="/app/projects"
          backLabel="Projects"
          eyebrow={p.id}
          title={p.name || "(untitled project)"}
          meta={
            <>
              <StatusPill tone={PROJECT_STATUS_TONES[status]}>{PROJECT_STATUS_LABELS[status] || status}</StatusPill>
              {p.branch && BRANCH_LABELS[p.branch] ? <span>{BRANCH_LABELS[p.branch]}</span> : null}
              {p.customerName ? <span>· {p.customerName}</span> : null}
              {p.address ? <span className="truncate">· {p.address}</span> : null}
            </>
          }
          actions={
            <>
              {/* Temporary escape hatch during the rebuild — deliberately
                  quiet, and it goes away once every tab is migrated. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (window.location.href = `/admin/project/${encodeURIComponent(p.id)}`)}
              >
                Open in classic
              </Button>
              <Button variant="primary">Log an update</Button>
            </>
          }
        />

        {/* Section nav rides with the header. */}
        <div className="border-t border-line">
          <div className="mx-auto max-w-[1180px] px-2 lg:px-6 overflow-x-auto">
            <nav className="flex gap-1 min-w-max" aria-label="Project sections">
              {TABS.map((t) => (
                <NavLink
                  key={t.label}
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cx(
                      "whitespace-nowrap border-b-2 px-2.5 py-3 font-display text-[13px] font-semibold uppercase tracking-[0.02em] transition-colors",
                      isActive ? "border-accent-500 text-brand-700" : "border-transparent text-ink-muted hover:text-brand-700"
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      </div>

      {/* The four figures that answer "where does this stand" — each one
          the way into the section behind it. */}
      <div className="bg-surface border-b border-line">
        <div className="mx-auto max-w-[1180px] px-4 lg:px-8 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Contract value" value={value ? money(value) : "—"} tone={value ? "money" : "muted"} onClick={() => goTab("scope")} />
          <Stat
            label="Project progress"
            value={total ? `${done} of ${total} tasks` : "No tasks yet"}
            tone={total ? "default" : "muted"}
            progress={total ? done / total : undefined}
            onClick={() => goTab("tasks")}
          />
          <Stat
            label="System design"
            value={design?.zoneCount ? `${design.zoneCount} zones` : "Not started"}
            tone={design?.zoneCount ? "default" : "muted"}
            hint={design?.lastSavedAt ? `saved ${shortDate(design.lastSavedAt)}` : undefined}
            onClick={() => goTab("design")}
          />
          <Stat label="Billing" value={billing.value} tone={billing.tone} hint={billing.hint} onClick={() => goTab("financials")} />
        </div>
      </div>

      <PageBody>
        <Outlet context={data} />
      </PageBody>
    </>
  );
}

/* Overview tab — what this job is, where it stands, what happens next. */
export function ProjectOverviewTab() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["project", id], queryFn: () => projectsApi.get(id), enabled: !!id });
  if (!data) return null;

  const p = data.project;
  const quote = data.linkedQuote;
  const snap = p.proposalSnapshot;
  const journal = (p.journalEntries || []).slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const action = nextAction(p, quote, data.invoiceSummary, data.siteBuilderSummary);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        {/* ── Next action ───────────────────────────────────────────
            The single most useful thing on the screen for a live job. */}
        <Card
          className={cx(
            "border-l-4",
            action.tone === "act" ? "border-l-accent-500" : action.tone === "waiting" ? "border-l-info-600" : "border-l-brand-500"
          )}
        >
          <div className="px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {action.tone === "waiting" ? "Waiting on" : action.tone === "done" ? "Status" : "Next action"}
              </span>
              <p className="font-display text-[20px] font-bold leading-tight text-ink">{action.headline}</p>
              <p className="text-[13px] text-ink-muted mt-0.5">{action.detail}</p>
            </div>
            {action.href ? (
              <Button
                variant={action.tone === "act" ? "primary" : "secondary"}
                onClick={() => {
                  if (action.href!.startsWith("/app/")) navigate(action.href!);
                  else window.location.href = action.href!;
                }}
              >
                {action.ctaLabel || "Open"}
              </Button>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Scope"
            actions={
              <Button size="sm" onClick={() => navigate(`/app/projects/${encodeURIComponent(p.id)}/scope`)}>
                Open scope
              </Button>
            }
          />
          <div className="px-4 py-3.5">
            {p.description ? (
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{p.description}</p>
            ) : (
              <p className="text-ink-muted">
                No scope description recorded yet — add one so the crew and the customer read the same job.
              </p>
            )}
            {/* The design and proposal already know the shape of the job;
                surface that rather than leaving the card thin. */}
            {data.siteBuilderSummary?.zoneCount || quote?.lineItems?.length ? (
              <p className="mt-2 text-[13px] text-ink-muted">
                {data.siteBuilderSummary?.zoneCount ? `${data.siteBuilderSummary.zoneCount}-zone system` : null}
                {data.siteBuilderSummary?.zoneCount && quote?.lineItems?.length ? " · " : null}
                {quote?.lineItems?.length ? `${quote.lineItems.length} line items on the proposal` : null}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent activity" meta={journal.length ? `${journal.length} entries` : undefined} />
          {journal.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="font-display text-[16px] font-semibold text-ink">No project updates have been recorded.</p>
              <p className="text-sm text-ink-muted mt-1 max-w-prose mx-auto">
                Log the first site update, note, photo or customer communication.
              </p>
              <Button variant="primary" className="mt-4">
                Log an update
              </Button>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {journal.slice(0, 5).map((e) => (
                  <li key={e.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold text-ink">{e.by || "PJL"}</span>
                      <span className="text-[12px] text-ink-muted">{shortDate(e.ts)}</span>
                    </div>
                    <p className="mt-0.5 text-sm text-ink/90 line-clamp-3">{e.note}</p>
                  </li>
                ))}
              </ul>
              <div className="px-4 py-3 border-t border-line">
                <Button size="sm" onClick={() => navigate(`/app/projects/${encodeURIComponent(p.id)}/records`)}>
                  All daily records
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        {/* ── Approved proposal ─────────────────────────────────────
            The document, not the money — the value already has its own
            figure in the summary above. */}
        <Card>
          <CardHeader title={snap ? "Approved proposal" : "Proposal"} />
          <div className="px-4 py-3.5">
            {quote || snap ? (
              <>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Proposal</dt>
                    <dd className="font-medium text-right">
                      {quote?.id || snap?.quoteId}
                      {quote?.version ? ` · v${quote.version}` : snap?.version ? ` · v${snap.version}` : ""}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">{snap?.acceptedAt ? "Accepted" : "Status"}</dt>
                    <dd className="font-medium text-right">
                      {snap?.acceptedAt ? shortDate(snap.acceptedAt) : quote?.status || "—"}
                    </dd>
                  </div>
                </dl>
                <Button
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => {
                    const qid = quote?.id || snap?.quoteId;
                    if (qid) {
                      window.location.href = `/admin/quote/${encodeURIComponent(qid)}/proposal?project=${encodeURIComponent(p.id)}`;
                    }
                  }}
                >
                  Open proposal
                </Button>
              </>
            ) : (
              <p className="text-ink-muted">No proposal raised for this job yet.</p>
            )}
          </div>
        </Card>

        {/* ── Customer ──────────────────────────────────────────────
            Contact ACTIONS. The company name and job address are already
            in the header above, so repeating them here wastes the card. */}
        <Card>
          <CardHeader title="Customer" />
          <div className="px-4 py-3.5 space-y-2 text-sm">
            {p.customerName ? (
              <div>
                <span className="block font-display text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
                  Primary contact
                </span>
                <span className="font-semibold">{p.customerName}</span>
              </div>
            ) : null}
            {p.customerPhone ? (
              <a href={`tel:${p.customerPhone}`} className="flex items-center gap-2 min-h-11 font-medium text-brand-700 hover:text-brand-800">
                {p.customerPhone}
              </a>
            ) : null}
            {p.customerEmail ? (
              <a href={`mailto:${p.customerEmail}`} className="flex items-center gap-2 min-h-11 font-medium text-brand-700 hover:text-brand-800 break-all">
                {p.customerEmail}
              </a>
            ) : null}
            {!p.customerPhone && !p.customerEmail ? (
              <p className="text-ink-muted">No contact details on this job.</p>
            ) : null}
            <div className="pt-1 flex flex-wrap gap-2">
              {p.customerId ? (
                <a
                  href={`/admin/customer/${encodeURIComponent(p.customerId)}`}
                  className="text-[13px] font-semibold text-brand-700 hover:text-brand-800"
                >
                  Customer record →
                </a>
              ) : null}
              {p.propertyId ? (
                <a
                  href={`/admin/property/${encodeURIComponent(p.propertyId)}`}
                  className="text-[13px] font-semibold text-brand-700 hover:text-brand-800"
                >
                  Property →
                </a>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* Tabs still to be built out. Each one names the workflow it will carry
   and offers the classic screen meanwhile — a placeholder that is
   honest about what it is, never a dead end. */
export function PendingTab({ title, body, legacyHref }: { title: string; body: string; legacyHref?: string }) {
  const { id = "" } = useParams();
  return (
    <Card>
      <CardHeader title={title} />
      <div className="px-4 py-8 text-center">
        <p className="text-ink-muted max-w-prose mx-auto">{body}</p>
        <Button
          className="mt-4"
          onClick={() => (window.location.href = legacyHref || `/admin/project/${encodeURIComponent(id)}`)}
        >
          Open in classic CRM
        </Button>
      </div>
    </Card>
  );
}

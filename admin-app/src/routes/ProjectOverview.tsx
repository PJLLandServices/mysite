import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, type ProjectStatus } from "../lib/api";
import { BRANCH_LABELS, PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, money, shortDate, taskProgress } from "../lib/format";
import { PageBody, PageHeader } from "../shell/AppShell";
import { Button, Card, CardHeader, ErrorNote, LoadingRows, Stat, StatusPill, cx } from "../ui/primitives";

/* The project workspace. The old page put every field of every related
   record on one scroll; this is the summary a person needs to answer
   "where is this job" plus tabs into the detail. Nothing is hidden —
   it's one click away instead of one thousand pixels away. */

const TABS = [
  { to: ".", label: "Overview", end: true },
  { to: "design", label: "System Design" },
  { to: "scope", label: "Scope & Proposal" },
  { to: "tasks", label: "Tasks" },
  { to: "materials", label: "Materials" },
  { to: "records", label: "Daily Records" },
  { to: "changes", label: "Change Orders" },
  { to: "financials", label: "Financials" },
  { to: "closeout", label: "Closeout" }
];

export function ProjectWorkspace() {
  const { id = "" } = useParams();
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

  return (
    <>
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
            <Button onClick={() => (window.location.href = `/admin/project/${encodeURIComponent(p.id)}`)}>
              Open in classic
            </Button>
            <Button variant="primary">Log an update</Button>
          </>
        }
      />

      {/* The figures that answer the question without a click. */}
      <div className="bg-surface border-b border-line">
        <div className="mx-auto max-w-[1180px] px-4 lg:px-8 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Contract value" value={value ? money(value) : "—"} tone="money" />
          <Stat label="Tasks" value={total ? `${done} of ${total}` : "—"} />
          <Stat
            label="Design"
            value={data.siteBuilderSummary ? `${data.siteBuilderSummary.zoneCount} zones` : "Not started"}
            tone={data.siteBuilderSummary ? "default" : "muted"}
          />
          <Stat
            label={invoice?.balanceDue ? "Balance due" : "Invoice"}
            value={
              invoice
                ? invoice.balanceDue
                  ? money(invoice.balanceDue)
                  : invoice.paidAt
                    ? "Paid"
                    : money(invoice.total)
                : "—"
            }
            tone={invoice?.balanceDue ? "money" : "default"}
          />
        </div>
      </div>

      {/* Workspace tabs — horizontal scroll on a phone, never a wrapped
          pile of links. */}
      <div className="bg-surface border-b border-line">
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
                    isActive
                      ? "border-accent-500 text-brand-700"
                      : "border-transparent text-ink-muted hover:text-brand-700"
                  )
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>

      <PageBody>
        <Outlet context={data} />
      </PageBody>
    </>
  );
}

/* Overview tab — the job's current state in plain terms. */
export function ProjectOverviewTab() {
  const { id = "" } = useParams();
  const { data } = useQuery({ queryKey: ["project", id], queryFn: () => projectsApi.get(id), enabled: !!id });
  if (!data) return null;

  const p = data.project;
  const quote = data.linkedQuote;
  const journal = (p.journalEntries || []).slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader title="Scope" />
          <div className="px-4 py-3.5">
            {p.description ? (
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{p.description}</p>
            ) : (
              <p className="text-ink-muted">No scope description recorded.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Recent activity"
            meta={journal.length ? `${journal.length} entries` : undefined}
            actions={<Button size="sm">Add entry</Button>}
          />
          {journal.length === 0 ? (
            <p className="px-4 py-6 text-center text-ink-muted">Nothing logged yet.</p>
          ) : (
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
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Quote" />
          <div className="px-4 py-3.5">
            {quote ? (
              <>
                <p className="text-sm">
                  <span className="font-semibold">v{quote.version}</span> — {quote.status}
                </p>
                {quote.total ? (
                  <p className="mt-1 font-display text-[22px] font-bold text-brand-700">{money(quote.total)}</p>
                ) : null}
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    (window.location.href = `/admin/quote/${encodeURIComponent(quote.id)}/proposal?project=${encodeURIComponent(p.id)}`)
                  }
                >
                  Open proposal
                </Button>
              </>
            ) : (
              <p className="text-ink-muted">No quote linked yet.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Customer" />
          <div className="px-4 py-3.5 space-y-1 text-sm">
            <p className="font-semibold">{p.customerName || "—"}</p>
            {p.customerEmail ? <p className="text-ink-muted break-all">{p.customerEmail}</p> : null}
            {p.customerPhone ? (
              <a href={`tel:${p.customerPhone}`} className="block text-brand-700 font-medium">
                {p.customerPhone}
              </a>
            ) : null}
            {p.address ? <p className="text-ink-muted pt-1">{p.address}</p> : null}
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

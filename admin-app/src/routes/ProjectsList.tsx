import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, type ProjectStatus, type ProjectSummary } from "../lib/api";
import {
  BRANCH_LABELS,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_TONES,
  money,
  relativeDay,
  taskProgress,
  projectPercentComplete
} from "../lib/format";
import { PageBody, PageHeader } from "../shell/AppShell";
import { Button, Card, EmptyState, ErrorNote, LoadingRows, StatusPill, TextInput, cx } from "../ui/primitives";

const FILTERS: Array<{ key: ProjectStatus | "all"; label: string }> = [
  { key: "active", label: "Active" },
  { key: "planning", label: "Planning" },
  { key: "complete", label: "Complete" },
  { key: "all", label: "All" }
];

/* A job's one-line answer to "where is this?" — the figure a person
   actually scans for. Money when there's a price, progress once work
   has started. */
function ProgressCell({ project }: { project: ProjectSummary }) {
  const { done, total } = taskProgress(project.tasks);
  if (!total) return <span className="text-ink-muted">—</span>;
  // The COUNT labels the row; the PERCENTAGE draws the bar, and it is the
  // server's own figure — a task at 60% moves it, which done/total cannot.
  const pct = projectPercentComplete(project.tasks);
  return (
    <div className="min-w-[104px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">
          {done}/{total}
        </span>
        <span className="text-[12px] text-ink-muted">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-canvas overflow-hidden">
        <div
          className={cx("h-full rounded-full", pct === 100 ? "bg-brand-500" : "bg-accent-500")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const status = (project.status || "planning") as ProjectStatus;
  const total = project.proposalSnapshot?.total;

  return (
    <Link
      to={`/app/projects/${encodeURIComponent(project.id)}`}
      className="group block border-b border-line last:border-b-0 hover:bg-brand-50/60 focus-visible:bg-brand-50"
    >
      {/* One row on desktop; a stacked card on a phone. Same data, same
          order of importance, no horizontal scrolling in a truck. */}
      <div className="px-4 py-3.5 lg:px-5 grid gap-x-4 gap-y-2 grid-cols-[1fr_auto] lg:grid-cols-[minmax(0,2.2fr)_150px_128px_116px_104px] lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink truncate group-hover:text-brand-700">
              {project.name || "(untitled project)"}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-muted">
            <span className="font-mono text-[12px]">{project.id}</span>
            {project.customerName ? <span className="truncate">· {project.customerName}</span> : null}
            {project.address ? <span className="truncate hidden sm:inline">· {project.address}</span> : null}
          </div>
        </div>

        <div className="justify-self-end lg:justify-self-start">
          <StatusPill tone={PROJECT_STATUS_TONES[status]}>{PROJECT_STATUS_LABELS[status] || status}</StatusPill>
          {project.branch && BRANCH_LABELS[project.branch] ? (
            <span className="mt-1 hidden lg:block text-[12px] text-ink-muted truncate">{BRANCH_LABELS[project.branch]}</span>
          ) : null}
        </div>

        <div className="col-span-2 lg:col-span-1 flex items-center justify-between gap-4 lg:block">
          <ProgressCell project={project} />
          {/* The contract value has its own column on desktop; on a phone
              it rides alongside progress rather than disappearing. */}
          {total ? (
            <span className="lg:hidden font-display text-[16px] font-bold text-brand-700">{money(total)}</span>
          ) : null}
        </div>

        <div className="hidden lg:block text-right lg:text-left">
          {total ? (
            <span className="font-display text-[17px] font-bold text-brand-700">{money(total)}</span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </div>

        <div className="hidden lg:block text-[13px] text-ink-muted">{relativeDay(project.updatedAt)}</div>
      </div>
    </Link>
  );
}

export function ProjectsList() {
  const [filter, setFilter] = useState<ProjectStatus | "all">("active");
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list
  });

  const visible = useMemo(() => {
    const all = data || [];
    const q = search.trim().toLowerCase();
    return all.filter((p) => {
      if (filter !== "all" && (p.status || "planning") !== filter) return false;
      if (filter === "all" && p.status === "archived") return false;
      if (!q) return true;
      return [p.id, p.name, p.customerName, p.address].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [data, filter, search]);

  const counts = useMemo(() => {
    const all = data || [];
    return {
      active: all.filter((p) => p.status === "active").length,
      planning: all.filter((p) => p.status === "planning").length,
      complete: all.filter((p) => p.status === "complete").length,
      all: all.filter((p) => p.status !== "archived").length
    } as Record<ProjectStatus | "all", number>;
  }, [data]);

  return (
    <>
      <PageHeader
        title="Projects"
        meta={data ? <span>{counts.active} active · {counts.planning} planning</span> : null}
        actions={
          <Button variant="primary" onClick={() => (window.location.href = "/admin/projects")}>
            New project
          </Button>
        }
      />

      <PageBody>
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2">
          {/* Scrolls rather than clipping on a phone — four filters plus
              their counts don't fit 390px, and a cut-off control reads
              as broken. */}
          <div className="flex shrink-0 self-start max-w-full overflow-x-auto rounded-[var(--radius-control)] border border-line-strong bg-surface p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={cx(
                  "min-h-9 rounded-[6px] px-3 font-display text-[13px] font-semibold uppercase tracking-[0.05em] transition-colors",
                  filter === f.key ? "bg-brand-700 text-white" : "text-ink-muted hover:text-brand-700"
                )}
              >
                {f.label}
                {data ? <span className="ml-1.5 opacity-70">{counts[f.key] ?? 0}</span> : null}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-[200px]">
            <TextInput
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by job, customer, address, or ID"
              aria-label="Search projects"
            />
          </div>
        </div>

        <Card>
          {/* Column headers earn their space only on desktop. */}
          <div className="hidden lg:grid grid-cols-[minmax(0,2.2fr)_150px_128px_116px_104px] gap-x-4 px-5 py-2.5 border-b border-line bg-canvas/60">
            {["Job", "Status", "Tasks", "Value", "Updated"].map((h) => (
              <span key={h} className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {h}
              </span>
            ))}
          </div>

          {isLoading ? <LoadingRows /> : null}
          {error ? <ErrorNote>{(error as Error).message}</ErrorNote> : null}
          {!isLoading && !error && visible.length === 0 ? (
            <EmptyState
              title={search ? "Nothing matches that search" : "No projects here yet"}
              body={
                search
                  ? "Try the job name, the customer, or the project ID."
                  : "Projects appear here when a quote is accepted, or when you start one by hand."
              }
            />
          ) : null}
          {visible.map((p) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </Card>
      </PageBody>
    </>
  );
}

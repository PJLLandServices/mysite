import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "../lib/api";
import { money, relativeDay, taskProgress } from "../lib/format";
import { PageBody, PageHeader } from "../shell/AppShell";
import { Card, CardHeader, LoadingRows, Stat, StatusPill } from "../ui/primitives";
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES } from "../lib/format";
import type { ProjectStatus } from "../lib/api";

export function Dashboard() {
  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });

  const all = data || [];
  const active = all.filter((p) => p.status === "active");
  const planning = all.filter((p) => p.status === "planning");
  const openValue = active.reduce((sum, p) => sum + (Number(p.proposalSnapshot?.total) || 0), 0);
  const openTasks = active.reduce((sum, p) => {
    const { done, total } = taskProgress(p.tasks);
    return sum + (total - done);
  }, 0);

  return (
    <>
      <PageHeader title="Dashboard" meta={<span>What's on right now</span>} />
      <PageBody>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Active jobs", value: String(active.length) },
            { label: "In planning", value: String(planning.length) },
            { label: "Work outstanding", value: `${openTasks} tasks` },
            { label: "Active contract value", value: money(openValue), tone: "money" as const }
          ].map((s) => (
            <Card key={s.label} className="px-4 py-3.5">
              <Stat label={s.label} value={s.value} tone={s.tone} />
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader title="Active jobs" actions={<Link to="/app/projects" className="text-[13px] font-semibold text-brand-700">All projects →</Link>} />
          {isLoading ? <LoadingRows rows={3} /> : null}
          {!isLoading && active.length === 0 ? (
            <p className="px-4 py-8 text-center text-ink-muted">Nothing active right now.</p>
          ) : null}
          <ul className="divide-y divide-line">
            {active.slice(0, 8).map((p) => {
              const { done, total } = taskProgress(p.tasks);
              const status = (p.status || "planning") as ProjectStatus;
              return (
                <li key={p.id}>
                  <Link
                    to={`/app/projects/${encodeURIComponent(p.id)}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-brand-50/60"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{p.name || p.id}</p>
                      <p className="text-[13px] text-ink-muted truncate">
                        {p.customerName || "—"} · updated {relativeDay(p.updatedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {total ? (
                        <span className="text-[13px] text-ink-muted tabular-nums">
                          {done}/{total}
                        </span>
                      ) : null}
                      <StatusPill tone={PROJECT_STATUS_TONES[status]}>{PROJECT_STATUS_LABELS[status]}</StatusPill>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </PageBody>
    </>
  );
}

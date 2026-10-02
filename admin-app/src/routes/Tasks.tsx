import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { metricsApi, projectsApi, tasksApi, type ProjectTask } from "../lib/api";
import { shortDate } from "../lib/format";
import {
  Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote,
  LoadingRows, Stat, StatusPill, TextInput, cx, type Tone
} from "../ui/primitives";

/* Tasks — the backbone connecting the estimate to completed work.
 *
 * Patrick's split, 2026-09-25: technicians capture on site through the
 * field app; this is where he PLANS and REVIEWS. Task status is the one
 * thing both sides write, and there is only one underlying record — the
 * project's. The office writes it through
 * POST /api/projects/:id/tasks/:taskId/progress, which calls the same
 * mutator the field path calls, so the status invariant lives in one
 * place for both doors.
 *
 * Every figure on this screen is the SERVER's. The job's percentage comes
 * from /metrics; nothing here averages anything. That is the rule for
 * this whole phase, and the progress bar that disagreed with the server
 * is why it is written down.
 */

const STATUS_LABEL: Record<ProjectTask["status"], string> = {
  pending: "Not started",
  in_progress: "In progress",
  done: "Done"
};
const STATUS_TONE: Record<ProjectTask["status"], Tone> = {
  pending: "neutral",
  in_progress: "progress",
  done: "good"
};

/* Who finished it, and where. A task closed out from the desk has no
   visit to name, and saying so is more honest than leaving it blank. */
function completionNote(t: ProjectTask): string | null {
  if (t.status !== "done") return null;
  const when = t.completedAt ? shortDate(t.completedAt) : null;
  const where = t.completedByWoId ? `on ${t.completedByWoId}` : "from the office";
  return when ? `Finished ${when} · ${where}` : `Finished ${where}`;
}

function TaskRow({
  task,
  projectId,
  busy,
  onSetProgress,
  onDelete,
  onRename
}: {
  task: ProjectTask;
  projectId: string;
  busy: boolean;
  onSetProgress: (t: ProjectTask, percent: number) => void;
  onDelete: (t: ProjectTask) => void;
  onRename: (t: ProjectTask, description: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const pct = task.status === "done" ? 100 : Number(task.percentComplete) || 0;
  const note = completionNote(task);
  void projectId;

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); onRename(task, draft.trim()); setEditing(false); }}
            >
              <TextInput
                value={draft}
                autoFocus
                aria-label="Task description"
                onChange={(e) => setDraft(e.target.value)}
                className="max-w-[420px]"
              />
              <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>Save</Button>
              <Button type="button" size="sm" onClick={() => { setDraft(task.description); setEditing(false); }}>
                Cancel
              </Button>
            </form>
          ) : (
            <p className="font-semibold text-ink break-words">{task.description}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
            <StatusPill tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</StatusPill>
            <span className="tabular-nums font-semibold text-ink">{pct}%</span>
            {note ? <span>· {note}</span> : null}
            {task.sourceLineItemId ? <span>· from the proposal</span> : null}
          </div>
          {task.notes ? <p className="mt-1 text-[13px] text-ink-muted whitespace-pre-wrap">{task.notes}</p> : null}
          <div className="mt-2 h-1.5 max-w-[320px] rounded-full bg-canvas overflow-hidden">
            <div
              className={cx("h-full rounded-full", pct >= 100 ? "bg-brand-500" : "bg-accent-500")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* No shrink-0 here: with six controls on a row this is what
            pushed 91px off the side of a phone. Desk-first is the decision,
            but a screen you cannot glance at on site is still broken. */}
        <div className="flex flex-wrap items-center gap-2">
          {task.status === "done" ? (
            <Button size="sm" disabled={busy} onClick={() => onSetProgress(task, 60)}>
              Reopen
            </Button>
          ) : (
            <>
              {/* The office's job here is correcting and finishing, not
                  logging a day, so the steps are coarse — but all of them
                  show, and in both directions. Patrick asked to be able to
                  CORRECT from the desk, and a control that only advances
                  cannot fix a task that was ticked too far. */}
              {[25, 50, 75].filter((s) => s !== pct).map((s) => (
                <Button key={s} size="sm" disabled={busy} onClick={() => onSetProgress(task, s)}>
                  {s}%
                </Button>
              ))}
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onSetProgress(task, 100)}>
                Mark done
              </Button>
            </>
          )}
          {/* A finished task is locked on the server; offering Edit would
              be offering a 409. */}
          {task.status !== "done" && !editing ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(task)}>Remove</Button>
        </div>
      </div>
    </li>
  );
}

export function TasksTab() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | {
    title: string; body: string; confirmLabel: string; destructive?: boolean; run: () => void;
  }>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["project", id], queryFn: () => projectsApi.get(id), enabled: !!id
  });
  // The job's own figures, from the server's calculation. Kept as its own
  // query so a task write refreshes it without re-reading the whole job.
  const { data: metrics } = useQuery({
    queryKey: ["project-metrics", id], queryFn: () => metricsApi.get(id), enabled: !!id
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project", id] });
    qc.invalidateQueries({ queryKey: ["project-metrics", id] });
  };
  const onError = (e: unknown) => setError((e as Error).message || "That didn't work.");

  const add = useMutation({
    mutationFn: (description: string) => tasksApi.add(id, { description }),
    onSuccess: () => { setAdding(""); setError(null); refresh(); },
    onError
  });
  const setProgress = useMutation({
    mutationFn: ({ taskId, percent }: { taskId: string; percent: number }) =>
      tasksApi.setProgress(id, taskId, percent),
    onSuccess: () => { setError(null); refresh(); },
    onError
  });
  const rename = useMutation({
    mutationFn: ({ taskId, description }: { taskId: string; description: string }) =>
      tasksApi.update(id, taskId, { description }),
    onSuccess: () => { setError(null); refresh(); },
    onError
  });
  const remove = useMutation({
    mutationFn: (taskId: string) => tasksApi.remove(id, taskId),
    onSuccess: () => { setError(null); refresh(); },
    onError
  });
  const restore = useMutation({
    mutationFn: (taskId: string) => tasksApi.restore(id, taskId),
    onSuccess: () => { setError(null); refresh(); },
    onError
  });
  const seed = useMutation({
    mutationFn: () => tasksApi.seedFromQuote(id),
    onSuccess: () => { setError(null); refresh(); },
    onError
  });

  const busy = add.isPending || setProgress.isPending || rename.isPending
    || remove.isPending || restore.isPending || seed.isPending;

  if (isLoading) return <Card><LoadingRows rows={4} /></Card>;
  if (!data) return null;

  const tasks = (data.project.tasks || []) as ProjectTask[];
  // Archived tasks are off the list and out of every figure. They are kept
  // below, greyed, because the crew's daily logs and photos point at them
  // — losing sight of them is how a work order ends up referring to
  // something nobody can find.
  const archived = tasks.filter((t) => t.archivedAt);
  const ordered = tasks
    .filter((t) => !t.archivedAt)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  const hasQuote = Boolean(data.project.sourceQuoteId);

  const askDelete = (t: ProjectTask) => {
    // Whether this deletes or archives is the server's call — it is the
    // only side that can see the crew's daily logs and photos. So the
    // question states the RULE rather than guessing the outcome.
    const worked = (Number(t.percentComplete) || 0) > 0 || t.status !== "pending";
    setConfirm({
      title: "Remove this task?",
      body: worked
        ? `"${t.description}" has work logged against it, so it will be archived rather than deleted — it comes off the job's list and out of the figures, but the crew's daily records and photos still point at it.`
        : `"${t.description}" comes off this job's list. If anything has ever been logged against it, it is archived instead of deleted and nothing the crew recorded is lost.`,
      confirmLabel: worked ? "Archive it" : "Remove task",
      destructive: true,
      run: () => remove.mutate(t.id)
    });
  };

  const askRestore = (t: ProjectTask) =>
    setConfirm({
      title: "Put this task back on the list?",
      body: `"${t.description}" returns to the job at ${t.status === "done" ? 100 : Number(t.percentComplete) || 0}% — exactly where it was. Nothing the crew logged was ever removed, so nothing needs rebuilding.`,
      confirmLabel: "Restore it",
      run: () => restore.mutate(t.id)
    });

  const askProgress = (t: ProjectTask, percent: number) => {
    // Finishing and reopening are the two that change what the job says
    // is outstanding, so they ask. Nudging to 25/50/75 does not.
    if (t.status === "done" && percent < 100) {
      setConfirm({
        title: "Reopen this task?",
        body: `"${t.description}" is marked finished. Reopening puts it back to ${percent}% and clears its completion date — including the visit it was credited to.`,
        confirmLabel: "Reopen it",
        run: () => setProgress.mutate({ taskId: t.id, percent })
      });
      return;
    }
    if (percent >= 100) {
      setConfirm({
        title: "Mark this task done?",
        body: `"${t.description}" will be recorded as finished from the office — no visit is credited, because there wasn't one.`,
        confirmLabel: "Mark it done",
        run: () => setProgress.mutate({ taskId: t.id, percent })
      });
      return;
    }
    setProgress.mutate({ taskId: t.id, percent });
  };

  return (
    <div className="space-y-4">
      {/* The job's figures, the server's numbers. "1 of 4 tasks" and
          "75% complete" are different questions and both are shown,
          because a job of part-finished tasks answers them differently. */}
      <Card>
        <CardHeader title="Tasks" meta={metrics?.lastWorkDate ? `Last worked ${shortDate(metrics.lastWorkDate)}` : undefined} />
        <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Complete" value={`${metrics?.percentComplete ?? 0}%`} progress={(metrics?.percentComplete ?? 0) / 100} />
          <Stat label="Tasks done" value={`${metrics?.doneTasks ?? 0} of ${metrics?.totalTasks ?? 0}`} />
          <Stat label="Days logged" value={metrics?.daysLogged ?? 0} hint="from the crew's visits" />
          <Stat label="Person-hours" value={metrics?.totalPersonHours ?? 0} hint="clocked in the field" />
        </div>
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card>
        <CardHeader
          title="The list"
          meta={ordered.length ? `${ordered.length} task${ordered.length === 1 ? "" : "s"}, in order` : undefined}
          actions={
            !ordered.length && hasQuote ? (
              <Button size="sm" disabled={busy} onClick={() => seed.mutate()}>
                Build from the proposal
              </Button>
            ) : null
          }
        />

        {ordered.length ? (
          <ul className="divide-y divide-line">
            {ordered.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                projectId={id}
                busy={busy}
                onSetProgress={askProgress}
                onDelete={askDelete}
                onRename={(task, description) => description && rename.mutate({ taskId: task.id, description })}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No tasks on this job yet"
            body={hasQuote
              ? "Build the list from the accepted proposal, or add them one at a time below."
              : "Add the first one below. Tasks are what the crew ticks off on site."}
          />
        )}

        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line"
          onSubmit={(e) => { e.preventDefault(); if (adding.trim()) add.mutate(adding.trim()); }}
        >
          <TextInput
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Add a task — what has to be done"
            aria-label="Add a task"
            className="flex-1 min-w-[220px]"
          />
          <Button type="submit" variant="primary" disabled={!adding.trim() || busy}>Add task</Button>
        </form>
      </Card>

      {archived.length ? (
        <Card>
          <CardHeader
            title="Archived"
            meta={`${archived.length} task${archived.length === 1 ? "" : "s"} off the list — kept because the crew's records point at them`}
          />
          <ul className="divide-y divide-line">
            {archived.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-muted line-through break-words">{t.description}</p>
                  <p className="mt-0.5 text-[13px] text-ink-muted">
                    Archived {t.archivedAt ? shortDate(t.archivedAt) : ""}
                    {t.archivedBy ? ` by ${t.archivedBy}` : ""}
                    {t.archivedReason ? ` — ${t.archivedReason}` : ""}
                  </p>
                </div>
                {/* An archive done by mistake has to be undoable here — the
                    alternative is editing the project file by hand. */}
                <Button size="sm" disabled={busy} onClick={() => askRestore(t)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="text-[13px] text-ink-muted">
        The crew updates these on site through the field app — this is the same list, not a copy of it.
      </p>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        destructive={confirm?.destructive}
        onConfirm={() => { confirm?.run(); setConfirm(null); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

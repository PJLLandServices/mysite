import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dailyRecordsApi } from "../lib/api.ts";
import { shortDate } from "../lib/format.ts";
import type { DailyRecordDay, DailySession, ProblemStatus, ProjectProblem } from "../lib/api.ts";
import {
  Button, Card, CardHeader, EmptyState, ErrorNote, Field, LoadingRows, Stat, StatusPill, TextInput
} from "../ui/primitives.tsx";

/* Daily Records — the day-by-day record of work, and the only place an
   office correction can be made or read.
 *
 * Patrick set seven requirements for this screen, all of them about the
 * same thing: a corrected number must never look like an uncorrected
 * one. Show recorded AND effective times. Label corrections. Say who,
 * when and why. Show the original crew count beside the corrected one.
 * Require a reason. Refresh the hours straight away. And explain the
 * lock when a day's hours are already final.
 *
 * The reason all seven matter together: the whole point of #315 was that
 * the field's original figure survives an office correction. If the
 * screen shows only the effective value, that protection is real but
 * invisible, which for the person reading it is the same as not being
 * there.
 *
 * Every number on this page comes from the server
 * (lib/daily-records.js over lib/session-hours.js). Nothing here
 * multiplies hours by anything. */

/* Clock times display in Toronto, because that is where the crew was
   standing. Stored as UTC; a session that started at 8am must read 8am. */
function clockTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Toronto" });
}

function dayHeading(workDate: string | null): string {
  if (!workDate) return "Undated day";
  // Noon avoids the date sliding a day on a timezone boundary.
  return new Date(workDate + "T12:00:00").toLocaleDateString("en-CA", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

function hrs(n: number): string {
  return `${n.toFixed(2)} person-hrs`;
}

/* The <input type="datetime-local"> value for a stored UTC instant, in
   Toronto time — so the box opens showing the time the crew actually
   clocked, not its UTC equivalent. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(d).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/* Back the other way: a Toronto wall-clock string to a UTC instant.
   Done by measuring the zone's real offset for THAT date rather than
   assuming one, so a correction made in December and a correction made
   in July are both right. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const guess = new Date(value + "Z");           // read as if UTC
  if (Number.isNaN(guess.getTime())) return null;
  const shown = new Date(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(guess).replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, "$3-$1-$2T$4:$5:$6Z"));
  const offset = guess.getTime() - shown.getTime();
  return new Date(guess.getTime() + offset).toISOString();
}

/* ── One session row ──────────────────────────────────────────────── */

function SessionRow({
  session, day, onCorrect, busy
}: {
  session: DailySession;
  day: DailyRecordDay;
  onCorrect: (kind: "times" | "labourers", s: DailySession) => void;
  busy: boolean;
}) {
  const clockCorrected = session.correctedFields.some((f) => f === "inAt" || f === "outAt");
  const crewCorrected = session.correctedFields.includes("labourersOnSite");

  return (
    <li className="border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[15px] font-semibold text-ink">
          {clockTime(session.effective.inAt)} – {session.open ? "still on site" : clockTime(session.effective.outAt)}
        </span>
        {/* The recorded time, struck through, ONLY where it differs.
            Showing "8:00 8:00" on every unchanged row would make the
            marking meaningless on the rows that matter. */}
        {clockCorrected ? (
          <span className="text-[13px] text-ink-muted">
            recorded <s>{clockTime(session.recorded.inAt)} – {clockTime(session.recorded.outAt)}</s>
          </span>
        ) : null}
        {session.corrected ? <StatusPill tone="warn">Corrected</StatusPill> : null}
        {session.open ? <StatusPill tone="progress">On site now</StatusPill> : null}
      </div>

      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-ink-muted">
        <span>
          <strong className="text-ink">{session.effective.labourersOnSite}</strong>
          {session.effective.labourersOnSite === 1 ? " person" : " people"} on site
        </span>
        {crewCorrected ? (
          <span>recorded <s>{session.recorded.labourersOnSite}</s></span>
        ) : null}
        <span>·</span>
        <span>
          <strong className="text-ink">{hrs(session.personHours)}</strong>
          {session.personHours !== session.recordedPersonHours ? (
            <> (was <s>{session.recordedPersonHours.toFixed(2)}</s>)</>
          ) : null}
        </span>
        {session.startedBy ? <><span>·</span><span>started by {session.startedBy}</span></> : null}
      </div>

      {session.note ? <p className="mt-1 text-[13px] text-ink-muted">{session.note}</p> : null}

      {/* Who corrected it, when, and why — on the row, not behind a
          tooltip. An audit trail nobody can see is a record, not an
          explanation. */}
      {session.corrections.length ? (
        <ul className="mt-2 space-y-1 border-l-2 border-amber-300 pl-3">
          {session.corrections.map((c, i) => (
            <li key={i} className="text-[13px] text-ink-muted">
              <span className="text-ink">{c.by || "Someone"}</span> changed{" "}
              {c.field === "labourersOnSite" ? "the crew count" : c.field === "inAt" ? "the clock-in" : "the clock-out"}{" "}
              from <s>{c.field === "labourersOnSite" ? String(c.from) : clockTime(c.from as string)}</s>{" "}
              to <strong className="text-ink">
                {c.field === "labourersOnSite" ? String(c.to) : clockTime(c.to as string)}
              </strong>
              {c.at ? <> on {new Date(c.at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</> : null}
              {c.reason ? <> — “{c.reason}”</> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {day.canCorrect ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onCorrect("times", session)} disabled={busy}>Correct clock times</Button>
          <Button size="sm" onClick={() => onCorrect("labourers", session)} disabled={busy}>Correct crew count</Button>
        </div>
      ) : null}
    </li>
  );
}

/* ── The correction form ──────────────────────────────────────────────
   A reason is required BEFORE the button works, not discovered after
   submitting. The server refuses without one either way; making the
   form agree means nobody types out two times and then loses them to a
   rule they were never told. */

function CorrectionForm({
  kind, session, onCancel, onSubmit, busy, error
}: {
  kind: "times" | "labourers";
  session: DailySession;
  onCancel: () => void;
  onSubmit: (body: { inAt?: string; outAt?: string; count?: number; reason: string }) => void;
  busy: boolean;
  error: string | null;
}) {
  const [inAt, setInAt] = useState(toLocalInput(session.effective.inAt));
  const [outAt, setOutAt] = useState(toLocalInput(session.effective.outAt));
  const [count, setCount] = useState(String(session.effective.labourersOnSite));
  const [reason, setReason] = useState("");

  const reasonOk = reason.trim().length >= 3;

  const submit = () => {
    if (!reasonOk) return;
    if (kind === "labourers") {
      onSubmit({ count: Math.max(1, Math.floor(Number(count) || 1)), reason: reason.trim() });
      return;
    }
    const body: { inAt?: string; outAt?: string; reason: string } = { reason: reason.trim() };
    const nextIn = fromLocalInput(inAt);
    const nextOut = fromLocalInput(outAt);
    if (nextIn && nextIn !== session.effective.inAt) body.inAt = nextIn;
    if (nextOut && nextOut !== session.effective.outAt) body.outAt = nextOut;
    onSubmit(body);
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3" data-testid="correction-form">
      <p className="mb-2 text-[13px] text-ink-muted">
        The crew’s original figures stay on the record. This adds a correction against them.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === "times" ? (
          <>
            <Field label="Clock in">
              <TextInput type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} data-testid="correct-in" />
            </Field>
            <Field label="Clock out">
              <TextInput type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} data-testid="correct-out" />
            </Field>
          </>
        ) : (
          <Field label="People on site" hint={`The crew recorded ${session.recorded.labourersOnSite}.`}>
            <TextInput type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} data-testid="correct-count" />
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label="Reason" hint="Required. This is what the record will say in six months.">
            <TextInput
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Crew left at 11, clocked out late"
              data-testid="correct-reason"
            />
          </Field>
        </div>
      </div>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={!reasonOk || busy} data-testid="correct-save">
          {busy ? "Saving…" : "Save correction"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        {!reasonOk ? (
          <span className="text-[13px] text-ink-muted" data-testid="reason-required">
            Give a reason to save.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ── Problems ─────────────────────────────────────────────────────────
 *
 * Patrick: "The problem should belong to the project, with a link to
 * the daily record where it was discovered. Daily Records shows: 'This
 * problem was discovered Tuesday during this work session.' Project
 * Overview shows: 'This problem remains open and still needs
 * resolution.' Resolving it later doesn't rewrite Tuesday's record."
 *
 * So a resolved problem still appears under the day it was found on,
 * showing its CURRENT status. Hiding it once resolved would quietly
 * rewrite what that day was like.
 *
 * The page never tests the status itself — `needsAttention` comes from
 * the one rule in lib/project-problems.js. A second copy here is how
 * "monitoring" ends up counted as resolved on one screen and not the
 * other. */

const PROBLEM_TONE: Record<ProblemStatus, "danger" | "warn" | "good"> = {
  open: "danger",
  monitoring: "warn",
  resolved: "good"
};
const PROBLEM_LABEL: Record<ProblemStatus, string> = {
  open: "Open",
  monitoring: "Monitoring",
  resolved: "Resolved"
};

function ProblemRow({
  problem, onSetStatus, busy, showDiscovery
}: {
  problem: ProjectProblem;
  onSetStatus: (p: ProjectProblem, status: ProblemStatus) => void;
  busy: boolean;
  showDiscovery?: boolean;
}) {
  return (
    <li className="border-t border-line py-3 first:border-t-0" data-testid="problem-row">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <StatusPill tone={PROBLEM_TONE[problem.status]}>{PROBLEM_LABEL[problem.status]}</StatusPill>
        <span className="font-display text-[15px] font-semibold text-ink">{problem.title}</span>
      </div>
      {problem.description ? (
        <p className="mt-1 whitespace-pre-wrap text-[14px] text-ink">{problem.description}</p>
      ) : null}

      <p className="mt-1 text-[13px] text-ink-muted">
        {showDiscovery && problem.discovery.workDate
          ? <>Discovered {dayHeading(problem.discovery.workDate)}</>
          : <>Discovered here</>}
        {problem.discovery.reportedBy ? <> by {problem.discovery.reportedBy}</> : null}
      </p>

      {/* Resolving appends. The discovery line above is untouched by it. */}
      {problem.resolution ? (
        <p className="mt-1 border-l-2 border-emerald-300 pl-3 text-[13px] text-ink-muted">
          Resolved by <span className="text-ink">{problem.resolution.by || "someone"}</span>
          {" on "}{shortDate(problem.resolution.at)} — “{problem.resolution.note}”
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        {(["open", "monitoring", "resolved"] as ProblemStatus[])
          .filter((st) => st !== problem.status)
          .map((st) => (
            <Button key={st} size="sm" disabled={busy} onClick={() => onSetStatus(problem, st)}
              data-testid={`problem-to-${st}`}>
              {st === "resolved" ? "Resolve…" : st === "monitoring" ? "Monitor" : "Re-open"}
            </Button>
          ))}
      </div>
    </li>
  );
}

/* ── The tab ──────────────────────────────────────────────────────── */

export function DailyRecordsTab() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<null | { kind: "times" | "labourers"; woId: string; session: DailySession }>(null);
  const [error, setError] = useState<string | null>(null);
  const [raising, setRaising] = useState<null | { woId: string; workDate: string | null }>(null);
  const [problemTitle, setProblemTitle] = useState("");
  const [problemDetail, setProblemDetail] = useState("");
  const [resolving, setResolving] = useState<null | { problem: ProjectProblem; status: ProblemStatus }>(null);
  const [resolveNote, setResolveNote] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["daily-records", id], queryFn: () => dailyRecordsApi.get(id), enabled: !!id
  });

  /* After a correction the hours must move on screen straight away —
     Patrick's sixth requirement. Invalidating the project's metrics too
     keeps the workspace header honest in the same beat, rather than
     leaving two figures for the same job disagreeing until a reload. */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["daily-records", id] });
    qc.invalidateQueries({ queryKey: ["project-metrics", id] });
    qc.invalidateQueries({ queryKey: ["project", id] });
  };

  const correct = useMutation({
    mutationFn: (v: { kind: "times" | "labourers"; woId: string; sessionId: string; body: Record<string, unknown> }) =>
      v.kind === "times"
        ? dailyRecordsApi.correctTimes(v.woId, v.sessionId, v.body as { inAt?: string; outAt?: string; reason: string })
        : dailyRecordsApi.correctLabourers(v.woId, v.sessionId, v.body as { count: number; reason: string }),
    onSuccess: () => { setError(null); setEditing(null); refresh(); },
    onError: (e: unknown) => setError((e as Error).message || "That correction was refused.")
  });

  const raiseProblem = useMutation({
    mutationFn: (v: { woId: string; workDate: string | null }) =>
      dailyRecordsApi.addProblem(id, {
        title: problemTitle.trim(),
        description: problemDetail.trim(),
        discoveredOnWoId: v.woId,
        discoveredWorkDate: v.workDate
      }),
    onSuccess: () => {
      setError(null); setRaising(null); setProblemTitle(""); setProblemDetail(""); refresh();
    },
    onError: (e: unknown) => setError((e as Error).message || "Couldn't record that problem.")
  });

  const changeProblem = useMutation({
    mutationFn: (v: { problemId: string; status: ProblemStatus; note: string }) =>
      dailyRecordsApi.setProblemStatus(id, v.problemId, { status: v.status, note: v.note }),
    onSuccess: () => { setError(null); setResolving(null); setResolveNote(""); refresh(); },
    onError: (e: unknown) => setError((e as Error).message || "Couldn't update that problem.")
  });

  // Resolving needs a note, so it opens a prompt; the other two moves
  // are immediate. The server refuses a note-less resolve either way —
  // this is the form agreeing with it rather than finding out after.
  const onSetStatus = (problem: ProjectProblem, status: ProblemStatus) => {
    setError(null);
    if (status === "resolved") { setResolving({ problem, status }); setResolveNote(""); return; }
    changeProblem.mutate({ problemId: problem.id, status, note: "" });
  };

  if (isLoading) return <Card><LoadingRows /></Card>;

  const days = data?.days || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Daily records"
          meta={data?.correctedDays ? `${data.correctedDays} day${data.correctedDays === 1 ? "" : "s"} corrected` : undefined}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Days logged" value={String(data?.daysLogged ?? 0)} />
          <Stat label="Person-hours" value={(data?.totalPersonHours ?? 0).toFixed(2)} />
          <Stat label="Photos" value={String(days.reduce((s, d) => s + d.photoCount, 0))} />
          {/* The count comes from the server's one rule — a "monitoring"
              problem is NOT resolved and is counted here. */}
          <Stat label="Problems open" value={String(data?.openProblems ?? 0)} />
        </div>
      </Card>

      {!days.length ? (
        <Card>
          <EmptyState
            title="No days logged yet"
            body="Days appear here as the crew clocks in and out on the field app. Hours are calculated from those clock times — they are never typed in."
          />
        </Card>
      ) : null}

      {days.map((day) => (
        <Card key={day.woId}>
          <CardHeader
            title={dayHeading(day.workDate)}
            meta={
              <span>
                {hrs(day.personHours)}
                {day.hoursCorrected ? (
                  <> · <span className="text-ink-muted">was <s>{day.recordedPersonHours.toFixed(2)}</s></span></>
                ) : null}
                {" · "}{day.tasksDoneToday} task{day.tasksDoneToday === 1 ? "" : "s"} done
                {" · "}{day.photoCount} photo{day.photoCount === 1 ? "" : "s"}
              </span>
            }
            actions={day.locked ? <StatusPill tone="neutral">Final</StatusPill> : null}
          />

          {/* The lock, explained. Requirement seven: a day whose hours
              cannot be corrected has to say WHY, in the place the button
              would otherwise be. */}
          {!day.canCorrect && day.lockReason ? (
            <p
              className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted"
              data-testid="lock-reason"
            >
              {day.lockReason}
            </p>
          ) : null}

          <ul className="mb-1">
            {day.sessions.map((s) => (
              <div key={s.id}>
                <SessionRow
                  session={s}
                  day={day}
                  busy={correct.isPending}
                  onCorrect={(kind, session) => { setError(null); setEditing({ kind, woId: day.woId, session }); }}
                />
                {editing && editing.session.id === s.id ? (
                  <CorrectionForm
                    kind={editing.kind}
                    session={s}
                    busy={correct.isPending}
                    error={error}
                    onCancel={() => { setEditing(null); setError(null); }}
                    onSubmit={(body) =>
                      correct.mutate({ kind: editing.kind, woId: editing.woId, sessionId: s.id, body })}
                  />
                ) : null}
              </div>
            ))}
          </ul>

          {!day.sessions.length ? (
            <p className="text-[13px] text-ink-muted">No clock times on this day.</p>
          ) : null}

          {day.notes ? (
            <div className="mt-3 border-t border-line pt-3">
              <h4 className="font-display text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
                Notes from the day
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-[14px] text-ink">{day.notes}</p>
            </div>
          ) : null}

          {/* The crew's photos, from the SAME store and the same URL the
              classic page uses — wo.photos written by
              savePhotosForWorkOrder(). Not a second upload path. */}
          {day.photos.length ? (
            <div className="mt-3 border-t border-line pt-3">
              <h4 className="font-display text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
                Photos from the day
              </h4>
              <ul className="mt-2 flex flex-wrap gap-2" data-testid="day-photos">
                {day.photos.map((ph) => (
                  <li key={ph.n}>
                    <a href={ph.url} target="_blank" rel="noopener noreferrer"
                       title={ph.caption || `Photo ${ph.n}`}>
                      {ph.kind === "pdf" ? (
                        <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-line bg-surface-sunken text-[12px] text-ink-muted">
                          PDF
                        </span>
                      ) : (
                        <img src={ph.url} alt={ph.caption || `Photo ${ph.n} from this day`}
                             loading="lazy"
                             className="h-20 w-20 rounded-lg border border-line object-cover" />
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Problems DISCOVERED on this day. A resolved one still shows
              here, with its current status — resolving it later does not
              rewrite what this day was like. */}
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-display text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
                Problems found this day
              </h4>
              <Button size="sm" data-testid={`raise-problem-${day.woId}`}
                onClick={() => { setError(null); setRaising({ woId: day.woId, workDate: day.workDate }); setProblemTitle(""); setProblemDetail(""); }}>
                Record a problem
              </Button>
            </div>

            {day.problemsFound.length ? (
              <ul className="mt-1">
                {day.problemsFound.map((pr) => (
                  <ProblemRow key={pr.id} problem={pr} busy={changeProblem.isPending} onSetStatus={onSetStatus} />
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-ink-muted">Nothing recorded for this day.</p>
            )}

            {raising && raising.woId === day.woId ? (
              <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3" data-testid="problem-form">
                <p className="mb-2 text-[13px] text-ink-muted">
                  This stays with the job until somebody deals with it. It will always show
                  that it was found on this day.
                </p>
                <div className="space-y-3">
                  <Field label="What is the problem">
                    <TextInput value={problemTitle} onChange={(e) => setProblemTitle(e.target.value)}
                      placeholder="e.g. Rock shelf under the east bed" data-testid="problem-title" />
                  </Field>
                  <Field label="Any detail" hint="Optional.">
                    <TextInput value={problemDetail} onChange={(e) => setProblemDetail(e.target.value)}
                      placeholder="What you saw, and what it might mean" data-testid="problem-detail" />
                  </Field>
                </div>
                {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" data-testid="problem-save"
                    disabled={problemTitle.trim().length < 3 || raiseProblem.isPending}
                    onClick={() => raiseProblem.mutate({ woId: day.woId, workDate: day.workDate })}>
                    {raiseProblem.isPending ? "Saving…" : "Record it"}
                  </Button>
                  <Button onClick={() => { setRaising(null); setError(null); }} disabled={raiseProblem.isPending}>Cancel</Button>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ))}

      {/* Resolving needs an account of HOW. "Resolved" with no note is a
          record that answers the wrong question in six months, so the
          server refuses it and the form asks for it first. */}
      {resolving ? (
        <Card>
          <CardHeader title={`Resolve: ${resolving.problem.title}`} />
          <Field label="How was it resolved" hint="Required. This is what the record will say later.">
            <TextInput value={resolveNote} onChange={(e) => setResolveNote(e.target.value)}
              placeholder="e.g. Rerouted the lateral around the shelf" data-testid="resolve-note" />
          </Field>
          {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" data-testid="resolve-save"
              disabled={resolveNote.trim().length < 3 || changeProblem.isPending}
              onClick={() => changeProblem.mutate({
                problemId: resolving.problem.id, status: "resolved", note: resolveNote.trim()
              })}>
              {changeProblem.isPending ? "Saving…" : "Mark resolved"}
            </Button>
            <Button onClick={() => { setResolving(null); setError(null); }} disabled={changeProblem.isPending}>Cancel</Button>
            {resolveNote.trim().length < 3 ? (
              <span className="text-[13px] text-ink-muted" data-testid="resolve-note-required">
                Say how it was resolved to save.
              </span>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* The whole job's problems, newest discovery first. The per-day
          blocks above answer "what happened that day"; this answers
          "what is still outstanding" — Patrick's two contexts, one
          record. */}
      {data?.problems?.length ? (
        <Card>
          <CardHeader
            title="Problems on this job"
            meta={`${data.openProblems} still need attention`}
          />
          <ul data-testid="all-problems">
            {data.problems.map((pr) => (
              <ProblemRow key={pr.id} problem={pr} busy={changeProblem.isPending}
                onSetStatus={onSetStatus} showDiscovery />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

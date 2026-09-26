import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dailyRecordsApi } from "../lib/api.ts";
import type { DailyRecordDay, DailySession } from "../lib/api.ts";
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

/* ── The tab ──────────────────────────────────────────────────────── */

export function DailyRecordsTab() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<null | { kind: "times" | "labourers"; woId: string; session: DailySession }>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (isLoading) return <Card><LoadingRows /></Card>;

  const days = data?.days || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Daily records"
          meta={data?.correctedDays ? `${data.correctedDays} day${data.correctedDays === 1 ? "" : "s"} corrected` : undefined}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Days logged" value={String(data?.daysLogged ?? 0)} />
          <Stat label="Person-hours" value={(data?.totalPersonHours ?? 0).toFixed(2)} />
          <Stat label="Photos" value={String(days.reduce((s, d) => s + d.photoCount, 0))} />
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
        </Card>
      ))}
    </div>
  );
}

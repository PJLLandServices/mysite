import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { overviewApi, projectsApi, type OverviewFinancials, type ProjectStatus } from "../lib/api";
import { BRANCH_LABELS, OFFICE_ONLY, PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, money, shortDate } from "../lib/format";
import { PageBody, PageHeader } from "../shell/AppShell";
import { Button, Card, CardHeader, ErrorNote, LoadingRows, Stat, StatusPill, cx } from "../ui/primitives";
import { EXCEPTION_LABEL, EXCEPTION_TONE } from "./Materials";
import { PROBLEM_LABEL, PROBLEM_TONE } from "./DailyRecords";

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
  // Progress is computeProjectMetrics' — the Tasks tab's own figures.
  const prog = data.progress;
  // The contract is what the customer SIGNED — the server's
  // describeAgreement, the same answer the Change Orders tab shows. No
  // fallback here: a second source would be a second interpretation.
  const value = data.agreement?.governing?.total;
  // Contract, invoice and payment amounts are office-only (2026-10-02): the
  // server sends a technician nulls and canSeeMoney false. The Financials
  // tab is not offered to them at all.
  const canSeeMoney = data.viewer?.canSeeMoney !== false;
  const tabs = canSeeMoney ? TABS : TABS.filter((t) => t.to !== "financials");
  const design = data.siteBuilderSummary;
  const goTab = (tab: string) => navigate(`/app/projects/${encodeURIComponent(p.id)}/${tab}`);

  // Billing is the server's answer (financials-view billingSummary) — the
  // same model the Financials tab shows. A settled DEPOSIT is not a settled
  // job, and a held balance invoice nobody has been sent is not owed: the
  // server decides which it is and says so in the hint.
  const b = data.billing;
  const billing = b && b.kind === "attention"
    ? { value: "Office attention", hint: b.hint, tone: "default" as const, warnHint: true }
    : b && b.kind === "restricted"
    ? { value: OFFICE_ONLY, hint: "billing is handled by the office", tone: "muted" as const }
    : b && b.kind === "reconcile"
    ? { value: "⚠ Reconcile", hint: b.hint, tone: "default" as const, warnHint: true }
    : !b || b.kind === "none"
    ? { value: "—", hint: b?.hint || "not invoiced yet", tone: "muted" as const }
    : b.kind === "owed"
      ? { value: money(b.owed), hint: b.hint, tone: "money" as const }
      : b.kind === "settled"
        ? { value: "None owed", hint: b.hint, tone: "default" as const }
        : { value: "Paid", hint: b.hint, tone: "default" as const };

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
              {tabs.map((t) => (
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
          {/* A job with nothing signed says so — never "$0", which would read
              as a signed contract worth nothing. */}
          <Stat
            label="Contract value"
            value={!canSeeMoney && data.agreement?.governing ? OFFICE_ONLY : value !== undefined && value !== null ? money(value) : "Not signed"}
            tone={value !== undefined && value !== null ? "money" : "muted"}
            hint={!canSeeMoney && data.agreement?.governing
              ? "signed — the amount is office-only"
              : value !== undefined && value !== null
              ? (data.agreement?.pending ? `with HST · revision ${data.agreement.pending.id} awaiting signature` : "with HST, signed")
              : (data.agreement?.pending ? `quote ${data.agreement.pending.id} awaiting signature` : "no signed agreement yet")}
            onClick={() => goTab("scope")}
          />
          <Stat
            label="Project progress"
            value={prog && prog.totalTasks ? `${prog.doneTasks} of ${prog.totalTasks} tasks` : "No tasks yet"}
            tone={prog && prog.totalTasks ? "default" : "muted"}
            progress={prog && prog.totalTasks ? prog.percentComplete / 100 : undefined}
            onClick={() => goTab("tasks")}
          />
          {/* Stations lead, because that is what the controller is sized on
              and what the proposal raises a line for. Valves and areas sit
              in the hint — two valves on one terminal are two valves, and
              the tile has to be able to say both numbers. */}
          <Stat
            label="System design"
            value={design?.stationCount
              ? `${design.stationCount} station${design.stationCount === 1 ? "" : "s"}`
              : (design?.areaCount ? `${design.areaCount} area${design.areaCount === 1 ? "" : "s"} drawn` : "Not started")}
            tone={design?.areaCount ? "default" : "muted"}
            hint={[
              design?.valveCount ? `${design.valveCount} valve${design.valveCount === 1 ? "" : "s"}` : null,
              design?.areaCount && design?.stationCount ? `${design.areaCount} area${design.areaCount === 1 ? "" : "s"}` : null,
              design?.lastSavedAt ? `saved ${shortDate(design.lastSavedAt)}` : null
            ].filter(Boolean).join(" · ") || undefined}
            onClick={() => goTab("design")}
          />
          <Stat label="Billing" value={billing.value} tone={billing.tone} hint={billing.hint} warnHint={"warnHint" in billing && billing.warnHint} onClick={() => goTab("financials")} />
        </div>
      </div>

      <PageBody>
        <Outlet context={data} />
      </PageBody>
    </>
  );
}

/* Overview tab — READ-ONLY command centre over the five tabs (stage 6 of
 * the Project Workspace, 2026-10-02).
 *
 * Every figure, label and sentence here comes from GET …/overview
 * (server/lib/project-overview.js), which copies it out of the read model
 * of the tab it summarises — computeProjectMetrics, the Daily Records,
 * Materials, Change Orders and Financials models, the completion check and
 * the server's next-action rule. Nothing is added up, filtered by status or
 * decided in this file: a number shown here is the number its tab shows.
 * Nothing here edits a record either — each card links to the tab that
 * does. */

function OvCard({ title, href, linkLabel, testId, tone, children }: {
  title: string; href: string; linkLabel: string; testId: string; tone?: "danger" | "warn"; children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Card className={cx(tone === "danger" ? "border-l-4 border-l-danger-500" : tone === "warn" ? "border-l-4 border-l-accent-500" : "")}>
      <div data-testid={testId}>
        <CardHeader
          title={title}
          actions={
            <a
              href={href}
              data-testid={`${testId}-link`}
              onClick={(e) => { e.preventDefault(); navigate(href); }}
              className="text-[13px] font-semibold text-brand-700 hover:text-brand-800 whitespace-nowrap"
            >
              {linkLabel} →
            </a>
          }
        />
        <div className="px-4 py-3.5 space-y-3">{children}</div>
      </div>
    </Card>
  );
}

/* One labelled figure. `value` is already the server's figure, formatted —
   or a sentence saying what is missing, never a stand-in zero. */
function Fig({ label, value, hint, testId, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; testId?: string; tone?: "danger" | "muted" }) {
  return (
    <div className="min-w-0">
      <span className="block text-[12px] text-ink-muted">{label}</span>
      <span
        data-testid={testId}
        className={cx("block font-display text-[17px] font-bold leading-tight break-words",
          tone === "danger" ? "text-danger-700" : tone === "muted" ? "text-ink-muted" : "text-ink")}
      >
        {value}
      </span>
      {hint ? <span className="block text-[12px] text-ink-muted break-words">{hint}</span> : null}
    </div>
  );
}

const hours = (n: number) => n.toFixed(2);

export function ProjectOverviewTab() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const project = useQuery({ queryKey: ["project", id], queryFn: () => projectsApi.get(id), enabled: !!id });
  const { data: ov, isLoading, error } = useQuery({
    queryKey: ["project-overview", id],
    queryFn: () => overviewApi.get(id),
    enabled: !!id
  });

  if (isLoading) return <LoadingRows rows={6} />;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;
  if (!ov) return null;

  const p = project.data?.project;
  const { status, tasks, dailyRecords: dr, materials: mat, changeOrders: co, financials: fin } = ov;
  const action = status.nextAction;
  // A technician's Financials is the restricted shape: no amounts, only
  // whether the office has billing to deal with (office-only, 2026-10-02).
  const restricted = "restricted" in fin && fin.restricted === true;
  const finFull = restricted ? null : (fin as OverviewFinancials);
  const reconciling = Boolean(finFull && finFull.reconciliation.length > 0);
  const go = (href: string) => (href.startsWith("/app/") ? navigate(href) : (window.location.href = href));

  return (
    <div className="space-y-4" data-testid="overview">
      {/* ── Project status: stage, progress, the one next step, and what
          blocks completion — all the server's. */}
      <Card
        className={cx(
          "border-l-4",
          action.tone === "act" ? "border-l-accent-500" : action.tone === "waiting" ? "border-l-info-600" : "border-l-brand-500"
        )}
      >
        <div className="px-4 py-3.5" data-testid="ov-status">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
            <span>Stage: <span className="font-semibold text-ink" data-testid="ov-stage">{status.stageLabel}</span></span>
            <span data-testid="ov-progress">
              {status.hasTasks ? <>· <span className="font-semibold text-ink">{status.percentComplete}%</span> complete</> : "· No tasks yet"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {action.tone === "waiting" ? "Waiting on" : action.tone === "done" ? "Status" : "Next action"}
              </span>
              <p className="font-display text-[20px] font-bold leading-tight text-ink" data-testid="ov-next">{action.headline}</p>
              <p className="text-[13px] text-ink-muted mt-0.5 break-words" data-testid="ov-next-detail">{action.detail}</p>
            </div>
            {action.href ? (
              <Button variant={action.tone === "act" ? "primary" : "secondary"} onClick={() => go(action.href!)}>
                {action.ctaLabel || "Open"}
              </Button>
            ) : null}
          </div>
          {status.blockers.length ? (
            <div className="mt-3 rounded-[var(--radius-control)] border border-danger-500/30 bg-danger-50 px-3 py-2.5" data-testid="ov-blockers" role="alert">
              <p className="text-[13px] font-semibold text-danger-700">
                Completion is blocked — {status.blockers.length} {status.blockers.length === 1 ? "thing" : "things"} to clear
              </p>
              <ul className="mt-1 space-y-1">
                {status.blockers.map((b) => (
                  <li key={b.key} className="text-[13px] text-danger-700 break-words" data-testid="ov-blocker" data-key={b.key}>
                    {b.message}{" "}
                    {b.href ? (
                      <a href={b.href} onClick={(e) => { e.preventDefault(); go(b.href!); }} className="font-semibold underline whitespace-nowrap">See why</a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {/* Payment reconciliation outranks every other card: what the
          customer owes is not determined until the office reconciles it. */}
      {finFull && reconciling ? (
        <div className="rounded-[var(--radius-card)] border border-danger-500/40 bg-danger-50 px-4 py-3" data-testid="ov-reconciliation" role="alert">
          <p className="font-display text-[15px] font-bold text-danger-700">⚠ Payment reconciliation required · {money(finFull.totals.unresolved)} unresolved</p>
          {finFull.reconciliation.map((r) => (
            <p key={r.invoiceId} className="mt-1 text-[13px] text-danger-700 break-words">{r.sentence}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Tasks ─────────────────────────────────────────────── */}
        <OvCard title="Tasks" href={tasks.href} linkLabel="Open Tasks" testId="ov-tasks">
          {tasks.total || tasks.archived ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Fig label="Open" value={tasks.open} testId="ov-tasks-open" />
                <Fig label="Completed" value={tasks.done} testId="ov-tasks-done" />
                <Fig label="Archived" value={tasks.archived} testId="ov-tasks-archived" />
              </div>
              {tasks.total ? (
                <div>
                  <div className="flex justify-between text-[13px]">
                    <span className="text-ink-muted">Overall progress</span>
                    <span className="font-semibold" data-testid="ov-tasks-pct">{tasks.percentComplete}%</span>
                  </div>
                  <span className="mt-1 block h-1.5 rounded-full bg-canvas overflow-hidden">
                    <span className={cx("block h-full rounded-full", tasks.percentComplete >= 100 ? "bg-brand-500" : "bg-accent-500")} style={{ width: `${Math.min(100, tasks.percentComplete)}%` }} />
                  </span>
                </div>
              ) : <p className="text-[13px] text-ink-muted">Every task on this job is archived — none are on the list.</p>}
            </>
          ) : (
            <p className="text-ink-muted" data-testid="ov-tasks-empty">No tasks on this job yet.</p>
          )}
          {!tasks.tracksDueDates ? (
            <p className="text-[12px] text-ink-muted">Tasks carry no due dates, so nothing is shown as overdue.</p>
          ) : null}
        </OvCard>

        {/* ── Daily Records ─────────────────────────────────────── */}
        <OvCard title="Daily Records" href={dr.href} linkLabel="Open Daily Records" testId="ov-daily" tone={dr.openProblems ? "warn" : undefined}>
          {dr.daysLogged ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Fig label="Latest workday" value={dr.lastWorkDate ? shortDate(dr.lastWorkDate) : "—"} testId="ov-daily-last"
                   hint={dr.latestDay ? `${hours(dr.latestDay.personHours)} person-hours${dr.latestDay.openSession ? " · crew still clocked in" : ""}` : undefined} />
              <Fig label="Effective person-hours" value={hours(dr.totalPersonHours)} testId="ov-daily-hours"
                   hint={`${dr.daysLogged} day${dr.daysLogged === 1 ? "" : "s"} logged${dr.correctedDays ? ` · ${dr.correctedDays} corrected` : ""}`} />
              <Fig label="Problems to deal with" value={dr.openProblems} testId="ov-daily-problems" tone={dr.openProblems ? "danger" : undefined} />
            </div>
          ) : (
            <p className="text-ink-muted" data-testid="ov-daily-empty">No days logged yet — nobody has clocked in on this job.</p>
          )}
          {!dr.daysLogged && dr.openProblems ? (
            <Fig label="Problems to deal with" value={dr.openProblems} testId="ov-daily-problems" tone="danger" />
          ) : null}
          {dr.problems.length ? (
            <ul className="space-y-1" data-testid="ov-daily-problem-list">
              {dr.problems.map((pr) => (
                <li key={pr.id} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                  <StatusPill tone={PROBLEM_TONE[pr.status]}>{PROBLEM_LABEL[pr.status]}</StatusPill>
                  <span className="break-words">{pr.title}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {dr.latestDay?.notes ? (
            <p className="text-[13px] break-words" data-testid="ov-daily-note">
              <span className="text-ink-muted">Crew note, {dr.latestDay.workDate ? shortDate(dr.latestDay.workDate) : "latest day"}: </span>{dr.latestDay.notes}
            </p>
          ) : null}
          {dr.latestEntry ? (
            <p className="text-[13px] break-words line-clamp-3" data-testid="ov-daily-entry">
              <span className="text-ink-muted">Latest update{dr.latestEntry.by ? ` by ${dr.latestEntry.by}` : ""}, {shortDate(dr.latestEntry.ts)}: </span>{dr.latestEntry.note}
            </p>
          ) : null}
        </OvCard>

        {/* ── Materials ─────────────────────────────────────────── */}
        <OvCard title="Materials" href={mat.href} linkLabel="Open Materials" testId="ov-materials" tone={mat.exceptionCount ? "warn" : undefined}>
          {mat.listCount || mat.skuCount ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Fig label="Material lists" value={mat.listCount} hint="what's required, per list" testId="ov-mat-lists" />
              <Fig label="Received" value={mat.receivedUnits} hint="units, all POs" testId="ov-mat-received" />
              <Fig label="Used on site" value={mat.usedUnits} hint="units, all days" testId="ov-mat-used" />
              <Fig label="Project balance" value={mat.balanceUnits} hint="received − used" testId="ov-mat-balance" />
            </div>
          ) : (
            <p className="text-ink-muted" data-testid="ov-mat-empty">No material lists, receipts or materials used on this job yet.</p>
          )}
          {mat.exceptionCount ? (
            <div data-testid="ov-mat-exceptions">
              <p className="text-[13px] font-semibold">{mat.exceptionCount} to look at</p>
              <ul className="mt-1 space-y-1">
                {mat.exceptions.map((e, i) => (
                  <li key={`${e.kind}-${e.sku}-${i}`} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                    <StatusPill tone={EXCEPTION_TONE[e.kind]}>{EXCEPTION_LABEL[e.kind]}</StatusPill>
                    <span className="break-words">{e.name || e.sku}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </OvCard>

        {/* ── Change Orders ─────────────────────────────────────── */}
        <OvCard title="Change Orders" href={co.href} linkLabel="Open Change Orders" testId="ov-changes"
                tone={co.holds.length || co.billingBlocked ? "danger" : co.open ? "warn" : undefined}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Fig label="Open" value={co.total ? co.open : "None"} tone={co.total ? undefined : "muted"} testId="ov-co-open"
                 hint={co.total ? `${co.total} in all · ${co.signed} signed` : "no change orders on this job"} />
            <Fig label="With the customer" value={co.awaitingCustomer + co.awaitingSignature > 0
                   ? `${co.awaitingCustomer} deciding · ${co.awaitingSignature} to sign` : "Nothing waiting"}
                 tone={co.awaitingCustomer + co.awaitingSignature > 0 ? undefined : "muted"} testId="ov-co-customer" />
            <Fig label="Signed agreement" testId="ov-co-signed"
                 value={!co.agreement.governing ? "Nothing signed" : co.agreement.governing.total == null ? "Signed" : money(co.agreement.governing.total)}
                 tone={co.agreement.governing ? undefined : "muted"}
                 hint={!co.agreement.governing
                   ? undefined
                   : co.agreement.governing.total == null
                     ? `${co.agreement.governing.id} v${co.agreement.governing.version} · amount office-only`
                     : `${co.agreement.governing.id} v${co.agreement.governing.version}, with HST${co.agreement.netChangeTotal ? ` · ${co.agreement.netChangeTotal > 0 ? "+" : "−"}${money(Math.abs(co.agreement.netChangeTotal))} changes` : ""}`} />
          </div>
          {co.agreement.pending ? (
            <p className="text-[13px]" data-testid="ov-co-pending">
              Revised quote <span className="font-semibold">{co.agreement.pending.id} v{co.agreement.pending.version}</span>{co.agreement.pending.total == null ? "" : ` (${money(co.agreement.pending.total)})`} is not signed yet.
            </p>
          ) : null}
          {co.billingBlocked || co.holds.length ? (
            <ul className="space-y-1" data-testid="ov-co-holds">
              {co.billingBlocked ? <li className="text-[13px] text-danger-700 break-words">{co.billingBlocked.message}</li> : null}
              {co.holds.filter((h) => h.key !== co.billingBlocked?.key).map((h) => (
                <li key={h.key} className="text-[13px] text-danger-700 break-words">{h.message}</li>
              ))}
            </ul>
          ) : null}
        </OvCard>

        {/* ── Financials ────────────────────────────────────────── */}
        {finFull ? (
        <OvCard title="Financials" href={finFull.href} linkLabel="Open Financials" testId="ov-financials"
                tone={reconciling || finFull.holds.length ? "danger" : undefined}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Fig label="Signed contract" testId="ov-fin-contract"
                 value={finFull.contract ? money(finFull.contract.total) : "Not signed"} tone={finFull.contract ? undefined : "muted"}
                 hint={finFull.contract ? `with HST${finFull.billingMode === "time_and_material" ? " · an estimate" : ""}` : "no signed agreement yet"} />
            <Fig label="Invoiced" testId="ov-fin-invoiced"
                 value={finFull.totals.issuedCount ? money(finFull.totals.invoiced) : "Nothing invoiced"} tone={finFull.totals.issuedCount ? undefined : "muted"}
                 hint={finFull.totals.drafts.count ? `${finFull.totals.drafts.count} not sent yet` : undefined} />
            <Fig label="Payments received" testId="ov-fin-received"
                 value={finFull.totals.received || finFull.totals.issuedCount ? money(finFull.totals.received) : "Nothing received"} tone={finFull.totals.received || finFull.totals.issuedCount ? undefined : "muted"}
                 hint="recorded payments only" />
            <Fig label="Outstanding" testId="ov-fin-owed"
                 value={!finFull.totals.owedDetermined ? "Not determined" : finFull.totals.issuedCount ? money(finFull.totals.owed) : "—"}
                 tone={!finFull.totals.owedDetermined ? "danger" : finFull.totals.issuedCount ? undefined : "muted"}
                 hint={!finFull.totals.owedDetermined ? `until ${money(finFull.totals.unresolved)} is reconciled` : finFull.totals.issuedCount ? undefined : "nothing sent to the customer"} />
            <Fig label="Not yet invoiced" testId="ov-fin-notyet"
                 value={finFull.totals.notYetInvoiced !== null ? money(finFull.totals.notYetInvoiced) : "—"} tone={finFull.totals.notYetInvoiced !== null ? undefined : "muted"}
                 hint={finFull.totals.notYetInvoiced !== null ? undefined : finFull.billingMode === "time_and_material" ? "billed from hours and materials" : "no signed contract"} />
            <Fig label="Deposit" testId="ov-fin-deposit"
                 value={finFull.deposit ? finFull.deposit.stageLabel : "No deposit"} tone={finFull.deposit ? undefined : "muted"}
                 hint={finFull.deposit ? `${money(finFull.deposit.amount)} · ${finFull.deposit.counted ? "counted" : "not counted yet"}` : undefined} />
          </div>
          {finFull.holds.length ? (
            <ul className="space-y-1" data-testid="ov-fin-holds">
              {finFull.holds.map((h) => <li key={h.key} className="text-[13px] text-danger-700 break-words">{h.message}</li>)}
            </ul>
          ) : null}
        </OvCard>
        ) : (
          /* A technician: billing is the office's. The card says whether
             the office has something to deal with — never an amount. */
          <Card className={restricted && "attention" in fin && fin.attention ? "border-l-4 border-l-accent-500" : ""}>
            <div data-testid="ov-financials-restricted">
              <CardHeader title="Billing" meta={OFFICE_ONLY} />
              <div className="px-4 py-3.5">
                {"attention" in fin && fin.attention ? (
                  <p className="font-semibold text-ink" data-testid="ov-billing-attention">{fin.notice}</p>
                ) : (
                  <p className="text-ink-muted">Billing on this job is handled by the office. Nothing for the crew to do here.</p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* ── Customer — contact ACTIONS only; no figures. */}
        {p ? (
          <Card>
            <CardHeader title="Customer" />
            <div className="px-4 py-3.5 space-y-2 text-sm">
              {p.customerName ? <span className="block font-semibold">{p.customerName}</span> : null}
              {p.customerPhone ? (
                <a href={`tel:${p.customerPhone}`} className="flex items-center gap-2 min-h-11 font-medium text-brand-700 hover:text-brand-800">{p.customerPhone}</a>
              ) : null}
              {p.customerEmail ? (
                <a href={`mailto:${p.customerEmail}`} className="flex items-center gap-2 min-h-11 font-medium text-brand-700 hover:text-brand-800 break-all">{p.customerEmail}</a>
              ) : null}
              {!p.customerPhone && !p.customerEmail ? <p className="text-ink-muted">No contact details on this job.</p> : null}
              <div className="pt-1 flex flex-wrap gap-3">
                {p.customerId ? <a href={`/admin/customer/${encodeURIComponent(p.customerId)}`} className="text-[13px] font-semibold text-brand-700 hover:text-brand-800">Customer record →</a> : null}
                {p.propertyId ? <a href={`/admin/property/${encodeURIComponent(p.propertyId)}`} className="text-[13px] font-semibold text-brand-700 hover:text-brand-800">Property →</a> : null}
              </div>
            </div>
          </Card>
        ) : null}
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

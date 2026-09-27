import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { changeOrdersApi } from "../lib/api.ts";
import type { AgreementVersion, ChangeOrder, ChangePhase } from "../lib/api.ts";
import { money, shortDate } from "../lib/format.ts";
import { Card, CardHeader, EmptyState, ErrorNote, LoadingRows, Stat, StatusPill } from "../ui/primitives.tsx";
import type { Tone } from "../ui/primitives.tsx";

/* Change Orders — READ-ONLY (PR 3 of the Change Orders work, 2026-09-27).
 *
 * What changed on the job, where each change stands, what the customer
 * has actually signed, and what is holding completion. Nothing here acts:
 * sending, recording the customer's answer, withdrawing and generating the
 * revised quote stay on the classic project page, behind the office-only
 * routes, until this screen has been walked on a real job (R5).
 *
 * Every figure, label and sentence comes from the server
 * (lib/change-orders-view.js). Which changes are open is the ONE shared
 * rule the Overview count, the completion check and the status email use;
 * the signed agreement is the quote chain's own answer. Nothing is summed
 * or re-derived here. */

const PHASE_TONE: Record<ChangePhase, Tone> = {
  in_review: "neutral",
  awaiting_customer: "progress",
  awaiting_revision: "warn",
  awaiting_signature: "progress",
  signed: "good",
  revision_declined: "neutral",
  revision_missing: "danger",
  rejected: "neutral",
  withdrawn: "neutral",
  approved_tm: "good"
};

const ROLE_LABEL: Record<string, string> = {
  original: "Original agreement",
  original_governing: "Signed agreement",
  governing: "Current signed agreement",
  pending: "Waiting for signature"
};

function signedChange(n: number) {
  if (n === 0) return "No change";
  return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
}

function VersionRow({ v }: { v: AgreementVersion }) {
  const label = ROLE_LABEL[v.role] || v.status.replace(/_/g, " ");
  const tone: Tone = v.role === "governing" || v.role === "original_governing" ? "good" : v.role === "pending" ? "progress" : "neutral";
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-4 py-2 first:border-t-0">
      <StatusPill tone={tone}>{label}</StatusPill>
      <a className="font-medium text-ink underline" href={v.href}>{v.id}</a>
      <span className="text-[13px] text-ink-muted">v{v.version}</span>
      <span className="text-[13px] text-ink-muted">· {v.status.replace(/_/g, " ")}</span>
      <span className="text-[14px] text-ink">{money(v.subtotal)} <span className="text-[12px] text-ink-muted">before HST</span></span>
      {v.acceptedAt ? <span className="text-[13px] text-ink-muted">· signed {shortDate(v.acceptedAt)}</span> : null}
    </li>
  );
}

function decisionText(c: ChangeOrder): string | null {
  const d = c.decision;
  if (!d) return null;
  const when = shortDate(d.at);
  if (d.as === "withdrawn_by_office" || d.as === "withdrawn_by_admin") {
    return `Withdrawn by ${d.recordedBy || "the office"} · ${when}`;
  }
  const what = d.as === "approved_by_customer" ? "Customer approved" : d.as === "rejected_by_customer" ? "Customer declined" : (d.as || "Decided");
  if (d.source === "customer") return `${what} directly · ${when}`;
  if (d.source === "recorded_by_office") return `${what} — recorded by ${d.recordedBy || "the office"} · ${when}`;
  // Recorded before attribution was kept (2026-09-27): say so, don't guess.
  return `${what} · ${when} (recorded before who-entered-it was kept)`;
}

function ChangeCard({ c }: { c: ChangeOrder }) {
  const failed = c.sendAttempts.filter((a) => !a.ok);
  const decision = decisionText(c);
  return (
    <li className="border-t border-line px-4 py-4 first:border-t-0" data-testid="change-order" data-change-id={c.id} data-phase={c.phase}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <StatusPill tone={PHASE_TONE[c.phase] || "neutral"}>{c.phaseLabel}</StatusPill>
        <span className="font-display text-[15px] font-semibold text-ink">{c.description || "(no description)"}</span>
      </div>
      <p className="mt-1 text-[14px] text-ink" data-testid="change-next">{c.next}</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-muted">
        <span>{c.id}</span>
        {c.capturedAt ? <span>· raised {shortDate(c.capturedAt)}{c.capturedBy ? ` by ${c.capturedBy}` : ""}</span> : null}
        {c.capturedFromWoId ? (
          <span>· from <a className="underline" href={`/admin/work-order/${encodeURIComponent(c.capturedFromWoId)}`}>{c.capturedFromWoId}</a></span>
        ) : null}
        <span>· estimate <strong className="text-ink">{money(c.estimatedTotal)}</strong> before HST</span>
      </div>

      {c.lineItems.length ? (
        <table className="mt-2 w-full text-[13px]">
          <tbody>
            {c.lineItems.map((li, i) => (
              <tr key={i} className="border-t border-line">
                <td className="py-1 pr-3 text-ink">{li.label}</td>
                <td className="py-1 pr-3 text-ink-muted">{li.qty} × {money(li.price)}</td>
                <td className="py-1 text-right text-ink">{money(li.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <ul className="mt-2 space-y-1 border-l-2 border-line pl-3 text-[13px] text-ink-muted">
        {failed.map((a, i) => (
          <li key={`f${i}`} className="text-warn-600">
            ⚠ Not sent{a.at ? ` ${shortDate(a.at)}` : ""}{a.by ? ` (${a.by})` : ""}: {a.reason || "no reason recorded"}
          </li>
        ))}
        {c.sent ? <li>Emailed to {c.sent.to || "the customer"} · {shortDate(c.sent.at)}{c.sent.by ? ` by ${c.sent.by}` : ""}</li> : null}
        {decision ? <li>{decision}{c.decision?.note ? ` — “${c.decision.note}”` : ""}</li> : null}
        {c.revision ? (
          <li>
            Revised quote <a className="underline" href={c.revision.href}>{c.revision.id}</a>
            {c.revision.version ? ` (v${c.revision.version})` : ""}
            {c.revision.status ? ` · ${c.revision.status.replace(/_/g, " ")}` : ""}
          </li>
        ) : null}
      </ul>

      {c.photos.length ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="change-photos">
          {c.photos.map((p) => p.href ? (
            <a key={p.n} href={p.href} target="_blank" rel="noreferrer">
              <img src={p.href} alt={`Photo ${p.n}`} loading="lazy" className="h-16 w-16 rounded-md border border-line object-cover" />
            </a>
          ) : (
            <span key={p.n} className="text-[12px] text-ink-muted">Photo {p.n}</span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function ChangeOrdersTab() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-change-orders", id],
    queryFn: () => changeOrdersApi.get(id),
    enabled: !!id
  });

  if (isLoading) return <Card><LoadingRows /></Card>;
  if (error || !data) return <Card><ErrorNote>{(error as Error)?.message || "Couldn't load the change orders."}</ErrorNote></Card>;

  const { agreement, summary, holds, changes } = data;
  const open = changes.filter((c) => c.open);
  const inRevision = changes.filter((c) => !c.open && c.phase === "awaiting_signature");
  const closed = changes.filter((c) => !c.open && c.phase !== "awaiting_signature");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Change orders"
          meta="Read-only"
          actions={data.classicHref ? (
            <a className="text-[13px] text-ink-muted underline" href={data.classicHref}>Act on these in the classic project page</a>
          ) : undefined}
        />
        <div className="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-4">
          <Stat label="Open" value={String(summary.open)} hint="need the office or the customer" />
          <Stat label="Waiting on customer" value={String(summary.awaitingCustomer + summary.awaitingSignature)} hint="an answer or a signature" />
          <Stat label="Signed" value={String(summary.signed)} hint="in the agreement" />
          <Stat
            label="Signed changes"
            tone="money"
            value={agreement.netChangeSubtotal === null ? "—" : signedChange(agreement.netChangeSubtotal)}
            hint="before HST, vs the original"
          />
        </div>
      </Card>

      {holds.length ? (
        <Card>
          <CardHeader title="Holding completion" meta={`${holds.length}`} />
          <ul className="space-y-2 px-4 py-3" data-testid="change-holds">
            {holds.map((h) => (
              <li key={h.key} className="text-[14px] text-ink">
                <StatusPill tone="warn">Hold</StatusPill> <span className="ml-1">{h.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="The agreement" meta="What the customer has signed" />
        {agreement.governing ? (
          <>
            <p className="px-4 pb-1 pt-3 text-[14px] text-ink" data-testid="agreement-line">
              Billed on <strong>{agreement.governing.id}</strong> (v{agreement.governing.version}) —{" "}
              <strong>{money(agreement.governing.subtotal)}</strong> before HST
              {agreement.original && agreement.original.id !== agreement.governing.id
                ? <>, up from {money(agreement.original.subtotal)} on {agreement.original.id}</>
                : null}
              .
              {agreement.pending
                ? <> Revision <strong>{agreement.pending.id}</strong> ({money(agreement.pending.subtotal)}) is waiting for the customer's signature.</>
                : null}
            </p>
            <ul data-testid="agreement-versions">
              {agreement.versions.map((v) => <VersionRow key={v.id} v={v} />)}
            </ul>
          </>
        ) : (
          <EmptyState title="No signed agreement on this job" body="Change orders are priced against a signed proposal. Time & material jobs bill the hours instead." />
        )}
      </Card>

      <Card>
        <CardHeader title="Open" meta={open.length ? String(open.length) : undefined} />
        {open.length ? (
          <ul data-testid="changes-open">{open.map((c) => <ChangeCard key={c.id} c={c} />)}</ul>
        ) : (
          <p className="px-4 py-3 text-[14px] text-ink-muted">Nothing waiting on the office or the customer.</p>
        )}
      </Card>

      {inRevision.length ? (
        <Card>
          <CardHeader title="In a revised quote" meta="Waiting for the customer's signature" />
          <ul data-testid="changes-in-revision">{inRevision.map((c) => <ChangeCard key={c.id} c={c} />)}</ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Settled" meta={closed.length ? String(closed.length) : undefined} />
        {closed.length ? (
          <ul data-testid="changes-closed">{closed.map((c) => <ChangeCard key={c.id} c={c} />)}</ul>
        ) : (
          <p className="px-4 py-3 text-[14px] text-ink-muted">No signed, declined or withdrawn changes yet.</p>
        )}
      </Card>
    </div>
  );
}

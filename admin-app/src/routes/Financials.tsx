import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { financialsApi } from "../lib/api.ts";
import type { FinancialsInvoice } from "../lib/api.ts";
import { money, shortDate } from "../lib/format.ts";
import { Card, CardHeader, EmptyState, ErrorNote, LoadingRows, Stat, StatusPill } from "../ui/primitives.tsx";
import type { Tone } from "../ui/primitives.tsx";

/* Financials — READ-ONLY (step 5 of the Project Workspace PRD, 2026-09-28).
 *
 * The signed contract, what has been invoiced, received and is owed now,
 * the deposit and where it stands, every invoice and payment, and what the
 * job would bill today. Nothing here acts: recording a payment, sending,
 * revising or voiding an invoice stay on the classic invoice pages until
 * this screen has been walked on a real job (R5).
 *
 * Every figure, label and sentence comes from the server
 * (lib/financials-view.js): the job's invoices are projects.
 * invoicesForProject's, a void invoice is never owed, and the totals are
 * added up there in cents. Nothing is summed or re-derived here. */

function statusTone(inv: FinancialsInvoice): Tone {
  if (!inv.live) return "neutral";
  if (inv.reconciliationRequired) return "danger";
  if (inv.status === "paid") return "good";
  if (inv.held || inv.status === "draft") return "neutral";
  if (inv.status === "partially_paid") return "progress";
  return "warn";
}

function InvoiceRow({ inv }: { inv: FinancialsInvoice }) {
  return (
    <li
      className={`border-t border-line px-4 py-3 first:border-t-0 ${inv.live ? "" : "opacity-70"}`}
      data-testid="fin-invoice"
      data-invoice-id={inv.id}
      data-live={inv.live ? "1" : "0"}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <StatusPill tone={statusTone(inv)}>{inv.statusLabel}</StatusPill>
        <a className="font-display text-[15px] font-semibold text-ink underline" href={inv.href}>{inv.id}</a>
        <span className="text-[13px] text-ink-muted">{inv.roleLabel}</span>
        {inv.needsReconciliation ? <StatusPill tone="danger">Needs reconciling</StatusPill> : null}
        {inv.unresolved > 0 ? (
          <span data-testid="fin-unrecorded-pill"><StatusPill tone="danger">{money(inv.unresolved)} not recorded</StatusPill></span>
        ) : null}
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-[13px] sm:max-w-[520px]">
        <div>
          <span className="block text-ink-muted">Total</span>
          <span className="text-ink">{money(inv.total)}</span>
        </div>
        <div>
          <span className="block text-ink-muted">Received</span>
          <span className="text-ink">{money(inv.amountPaid)}</span>
        </div>
        <div>
          <span className="block text-ink-muted">{inv.reconciliationRequired ? "Unresolved" : "Owed"}</span>
          {inv.reconciliationRequired ? (
            <span className="font-semibold text-danger-700" data-testid="fin-invoice-unresolved">{money(inv.unresolved)}</span>
          ) : (
            <span className={(inv.owed ?? 0) > 0 && inv.issued ? "font-semibold text-ink" : "text-ink"} data-testid="fin-invoice-owed">{money(inv.owed ?? 0)}</span>
          )}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-muted">
        {inv.createdAt ? <span>made {shortDate(inv.createdAt)}</span> : null}
        {inv.sentAt ? <span>· sent {shortDate(inv.sentAt)}</span> : null}
        {inv.paidAt ? <span>· paid {shortDate(inv.paidAt)}</span> : null}
      </div>
      {inv.note ? (
        <p className={`mt-1 text-[13px] ${inv.reconciliationRequired ? "font-semibold text-danger-700" : "text-ink-muted"}`}>{inv.note}</p>
      ) : null}
    </li>
  );
}

export function FinancialsTab() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-financials", id],
    queryFn: () => financialsApi.get(id),
    enabled: !!id
  });

  if (isLoading) return <Card><LoadingRows /></Card>;
  if (error || !data) return <Card><ErrorNote>{(error as Error)?.message || "Couldn't load the financials."}</ErrorNote></Card>;

  const { contract, totals, deposit, invoices, payments, preview, holds } = data;
  const tm = data.billingMode === "time_and_material";

  return (
    <div className="space-y-4">
      {/* Payment reconciliation — first on the tab, red. An invoice marked
          Paid with its recorded payments short: the ledger's received, the
          unresolved gap, the status, and that what the customer owes is not
          determined until it is reconciled. Resolved on the invoice page. */}
      {data.reconciliation.length ? (
        <Card className="border-2 border-danger-500 bg-danger-50">
          <CardHeader title="⚠ Payment reconciliation required" meta={`${money(totals.unresolved)} unresolved`} />
          <ul className="space-y-3 px-4 py-3" data-testid="fin-unrecorded">
            {data.reconciliation.map((u) => (
              <li key={u.invoiceId} className="text-[14px] text-ink" data-testid="fin-reconciliation" data-invoice-id={u.invoiceId}>
                <StatusPill tone="danger">{money(u.unresolved)} not recorded</StatusPill>{" "}
                <a className="ml-1 font-semibold underline" href={`/admin/invoice/${encodeURIComponent(u.invoiceId)}`}>{u.invoiceId}</a>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <div><dt className="text-[12px] text-ink-muted">Received</dt><dd className="font-semibold">{money(u.received)}</dd></div>
                  <div><dt className="text-[12px] text-ink-muted">Unresolved</dt><dd className="font-semibold text-danger-700">{money(u.unresolved)}</dd></div>
                  <div><dt className="text-[12px] text-ink-muted">Status</dt><dd className="font-semibold">{u.status}</dd></div>
                  <div><dt className="text-[12px] text-ink-muted">Customer amount owed</dt><dd className="font-semibold">{u.customerOwes}</dd></div>
                </dl>
                <p className="mt-2 text-[13px]">{u.sentence}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Financials"
          meta={`${data.billingModeLabel} · Read-only`}
          actions={data.classicHref ? (
            <a className="text-[13px] text-ink-muted underline" href={data.classicHref}>Record payments on the classic pages</a>
          ) : undefined}
        />
        <div className="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-4" data-testid="fin-totals">
          <Stat
            label="Signed contract"
            tone={contract ? "money" : "muted"}
            value={contract ? money(contract.total) : "Not signed"}
            hint={contract
              ? tm
                ? `with HST · an estimate — billed from hours and materials`
                : `with HST · ${contract.id} v${contract.version}`
              : tm ? "billed from hours and materials" : "no signed agreement yet"}
          />
          <Stat label="Invoiced" value={money(totals.invoiced)} hint={`${totals.issuedCount} sent${totals.drafts.count ? ` · ${totals.drafts.count} not sent yet` : ""}`} />
          <Stat label="Received" tone="money" value={money(totals.received)} hint={payments.length ? `${payments.length} payment${payments.length === 1 ? "" : "s"}` : "nothing received yet"} />
          {/* While a payment is unresolved, what the customer owes is not
              determined — the server says so (totals.owedDetermined). */}
          <Stat
            label="Owed now"
            tone={totals.owedDetermined ? "default" : "muted"}
            value={totals.owedDetermined ? money(totals.owed) : "Not determined"}
            hint={!totals.owedDetermined
              ? `until ${money(totals.unresolved)} is reconciled${totals.owed > 0 ? ` · ${money(totals.owed)} owed on other invoices` : ""}`
              : totals.notYetInvoiced !== null && totals.notYetInvoiced > 0
                ? `${money(totals.notYetInvoiced)} of the contract not invoiced yet`
                : "on invoices sent to the customer"}
          />
        </div>
      </Card>

      {holds.length ? (
        <Card className="border-l-4 border-l-danger-500">
          <CardHeader title="Holding billing" meta={String(holds.length)} />
          <ul className="space-y-2 px-4 py-3" data-testid="fin-holds">
            {holds.map((h) => (
              <li key={h.key} className="text-[14px] text-ink">
                <StatusPill tone="warn">Hold</StatusPill> <span className="ml-1">{h.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {data.reconcile.length ? (
        <Card className="border-l-4 border-l-danger-500">
          <p className="px-4 py-3 text-[14px] text-ink" data-testid="fin-reconcile">
            <StatusPill tone="danger">Needs reconciling</StatusPill>{" "}
            A card payment on {data.reconcile.join(", ")} was more than was owed. Resolve it on the invoice page.
          </p>
        </Card>
      ) : null}

      {deposit ? (
        <Card>
          <CardHeader title="Deposit" meta={deposit.stageLabel} />
          <p className="px-4 py-3 text-[14px] text-ink" data-testid="fin-deposit">
            <StatusPill tone={deposit.counted ? "good" : "warn"}>{deposit.counted ? "Counted" : "Not counted yet"}</StatusPill>
            <span className="ml-2">{deposit.sentence}</span>
          </p>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Invoices" meta={invoices.length ? String(invoices.length) : undefined} />
        {invoices.length ? (
          <ul data-testid="fin-invoices">{invoices.map((inv) => <InvoiceRow key={inv.id} inv={inv} />)}</ul>
        ) : (
          <EmptyState title="No invoices on this job yet" body={tm ? "A time & materials job is invoiced from its hours and materials when it is complete." : "The final invoice is made when the job is complete."} />
        )}
      </Card>

      <Card>
        <CardHeader title="Payments received" meta={payments.length ? String(payments.length) : undefined} />
        {payments.length ? (
          <ul data-testid="fin-payments">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 border-t border-line px-4 py-2 text-[14px] first:border-t-0">
                <span className="font-semibold text-ink">{money(p.amount)}</span>
                <span className="text-ink-muted">{p.methodLabel}</span>
                <span className="text-ink-muted">· {p.invoiceId}</span>
                {p.receivedAt ? <span className="text-ink-muted">· {shortDate(p.receivedAt)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[14px] text-ink-muted">No payments recorded on this job.</p>
        )}
      </Card>

      {preview ? (
        <Card>
          <CardHeader title="If it were billed today" meta={tm ? "Hours and materials so far" : "What the final invoice bills from"} />
          {preview.error ? (
            <p className="px-4 py-3 text-[14px] text-ink" data-testid="fin-preview-error">
              <StatusPill tone="warn">Can't bill yet</StatusPill> <span className="ml-1">{preview.error}</span>
            </p>
          ) : (
            <div className="px-4 py-3" data-testid="fin-preview">
              <p className="text-[14px] text-ink">
                <strong>{money(preview.total ?? 0)}</strong> with HST ({money(preview.subtotal ?? 0)} before HST)
                {tm && preview.totalHours !== null && preview.totalHours !== undefined
                  ? <> · {preview.totalHours} hrs at {money(preview.rate ?? 0)}/hr</>
                  : null}
              </p>
              {preview.unknownSkus && preview.unknownSkus.length ? (
                <p className="mt-1 text-[13px] text-warn-600">⚠ No price for: {preview.unknownSkus.join(", ")} — the job can't be invoiced until these are priced.</p>
              ) : null}
              {preview.note ? <p className="mt-1 text-[13px] text-ink-muted">{preview.note}</p> : null}
              {preview.lineItems && preview.lineItems.length ? (
                <table className="mt-2 w-full text-[13px]">
                  <tbody>
                    {preview.lineItems.map((li, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="py-1 pr-3 text-ink">{li.label}</td>
                        <td className="py-1 pr-3 text-ink-muted">{li.qty} × {money(li.price)}</td>
                        <td className="py-1 text-right text-ink">{money(li.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

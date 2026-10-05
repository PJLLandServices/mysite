import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { materialsApi } from "../lib/api.ts";
import type { MaterialExceptionKind, StockRow } from "../lib/api.ts";
import { money, shortDate } from "../lib/format.ts";
import { Card, CardHeader, EmptyState, LoadingRows, Stat, StatusPill } from "../ui/primitives.tsx";

/* Materials — what the job needs, what arrived, what went into the
   ground, and what is left.
 *
 * Patrick set the shape (2026-09-27), and one rule governs the whole
 * screen:
 *
 *   "Do not add required quantities or dollar totals across multiple
 *    lists, because a later design list may repeat the earlier BOM.
 *    Show those totals per list. Physical stock can be shown
 *    project-wide by aggregating actual PO receipts by SKU and
 *    subtracting onsite consumption once."
 *
 * So the page has two kinds of number and never mixes them:
 *
 *   PLANNING is per list. Re-syncing the System Builder after
 *   purchasing creates a SECOND list repeating the same BOM, so a
 *   project-wide "required" total would double-count a job quoted once.
 *
 *   STOCK is physical. A fitting arrived once and was used once however
 *   many documents mention it, so those aggregate — and consumption is
 *   subtracted exactly once.
 *
 * Every figure comes from the server. Nothing is re-added here. */

const LIST_TONE: Record<string, "neutral" | "progress" | "good" | "warn"> = {
  draft: "neutral",
  in_progress: "progress",
  complete: "good",
  archived: "neutral"
};

export const EXCEPTION_LABEL: Record<MaterialExceptionKind, string> = {
  unplanned: "Unplanned material",
  over_consumed: "More used than received",
  unknown_sku: "Unknown SKU",
  price_unavailable: "No price available"
};

export const EXCEPTION_TONE: Record<MaterialExceptionKind, "danger" | "warn" | "neutral"> = {
  unplanned: "warn",
  over_consumed: "danger",
  unknown_sku: "warn",
  price_unavailable: "neutral"
};

/* The balance reads as a plain number, but a NEGATIVE one is a fact
   worth noticing: more went into the ground than ever came through the
   door. It is never hidden and never clamped to zero. */
function balanceText(row: StockRow): string {
  if (row.projectBalance === 0) return "0";
  return row.projectBalance > 0 ? String(row.projectBalance) : `${row.projectBalance}`;
}

function RequiredCell({ row }: { row: StockRow }) {
  if (row.requiredAmbiguous) {
    // Deliberately not a total. Two lists asking for the same SKU is
    // one requirement stated twice as often as it is two requirements,
    // and nothing in the data says which.
    return (
      <span className="text-ink-muted" title="On more than one list — shown per list rather than added up">
        {row.requiredByList.map((r) => `${r.qty} (${r.listId})`).join(" · ")}
      </span>
    );
  }
  return <span>{row.required}</span>;
}

export function MaterialsTab() {
  const { id = "" } = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ["project-materials", id],
    queryFn: () => materialsApi.get(id),
    enabled: !!id
  });

  if (isLoading) return <Card><LoadingRows /></Card>;

  const planning = data?.planning || [];
  const stock = data?.stock || [];
  const exceptions = data?.exceptions || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Materials" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Material lists" value={String(data?.summary.listCount ?? 0)} />
          {/* The server's words: one list's units, or "Per list — N lists" (never a sum). */}
          <Stat label="Required" value={data?.summary.required.display ?? "None"} hint={data?.summary.required.hint} />
          <Stat label="Ordered" value={String(data?.summary.orderedUnits ?? 0)} hint="units on purchase orders, no drafts" />
          <Stat label="Received" value={String(data?.summary.receivedUnits ?? 0)} hint="units, all POs" />
          <Stat label="Used on site" value={String(data?.summary.usedUnits ?? 0)} hint="units, all days" />
          <Stat label="Project balance" value={String(data?.summary.balanceUnits ?? 0)} hint="received − used" />
        </div>
      </Card>

      {/* ── 1. Planning and purchasing — each list SEPARATELY ────────── */}
      <Card>
        <CardHeader
          title="Planning and purchasing"
          meta="Each list on its own — never added together"
        />
        {!planning.length ? (
          <EmptyState
            title="No material lists yet"
            body="A list is created from the System Builder design, or by hand on the material-list page."
          />
        ) : (
          <>
            <p className="mb-3 text-[13px] text-ink-muted">
              A design re-sync after purchasing creates a new list rather than overwriting the
              purchased one, so a job can hold several. Their quantities and totals are
              <strong className="text-ink"> not</strong> summed: a later list usually repeats the
              earlier bill of materials.
            </p>
            <ul data-testid="planning-lists">
              {planning.map((l) => (
                <li key={l.id} className="border-t border-line py-3 first:border-t-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <StatusPill tone={LIST_TONE[l.status] || "neutral"}>{l.status.replace("_", " ")}</StatusPill>
                    <a className="font-display text-[15px] font-semibold text-ink underline" href={l.href}>
                      {l.name}
                    </a>
                    <span className="text-[13px] text-ink-muted">{l.id}</span>
                    {l.createdAt ? <span className="text-[13px] text-ink-muted">· {shortDate(l.createdAt)}</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-muted">
                    <span>{l.totals.lineCount} line{l.totals.lineCount === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span>{l.totals.needCount} to buy</span>
                    <span>·</span>
                    <span>{l.totals.orderedCount} ordered</span>
                    <span>·</span>
                    <span>{l.totals.haveCount} have</span>
                    <span>·</span>
                    {/* The server's own total for THIS list. */}
                    <span><strong className="text-ink">{money(l.totals.grandSubtotalCents / 100)}</strong> this list</span>
                  </div>
                  {l.poIds.length ? (
                    <div className="mt-1 text-[13px] text-ink-muted">
                      Purchase orders:{" "}
                      {l.poIds.map((po, i) => (
                        <span key={po}>
                          {i > 0 ? ", " : ""}
                          <a className="underline" href={`/admin/purchase-order/${encodeURIComponent(po)}`}>{po}</a>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {l.totals.priceUnavailableCount || l.totals.unknownSkuCount ? (
                    <p className="mt-1 text-[13px] text-ink-muted">
                      {l.totals.unknownSkuCount ? `${l.totals.unknownSkuCount} unknown SKU. ` : ""}
                      {l.totals.priceUnavailableCount
                        ? `${l.totals.priceUnavailableCount} without a price, counting as $0 in this total.`
                        : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {/* ── 2. Project stock — physical, so aggregated ───────────────── */}
      <Card>
        <CardHeader
          title="Project stock"
          meta="Received and used, by part — wherever it physically sits"
        />
        {!stock.length ? (
          <EmptyState title="Nothing received or used yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]" data-testid="stock-table">
              <thead>
                <tr className="text-left text-[12px] uppercase tracking-[0.07em] text-ink-muted">
                  <th className="py-2 pr-3 font-semibold">Part</th>
                  <th className="py-2 pr-3 font-semibold">Required</th>
                  <th className="py-2 pr-3 font-semibold">Ordered</th>
                  <th className="py-2 pr-3 font-semibold">Received</th>
                  <th className="py-2 pr-3 font-semibold">Used on site</th>
                  <th className="py-2 font-semibold">Project balance</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((row) => (
                  <tr key={row.sku} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium text-ink">{row.name || row.sku}</span>
                      {row.name ? <span className="block text-[12px] text-ink-muted">{row.sku}</span> : null}
                      {!row.known ? (
                        <StatusPill tone="warn">not in the catalog</StatusPill>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3"><RequiredCell row={row} /></td>
                    <td className="py-2 pr-3" data-testid={`ordered-${row.sku}`}>{row.ordered}</td>
                    <td className="py-2 pr-3">{row.received}</td>
                    <td className="py-2 pr-3">{row.usedOnsite}</td>
                    <td className={`py-2 font-semibold ${row.projectBalance < 0 ? "text-rose-700" : "text-ink"}`}>
                      {balanceText(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[13px] text-ink-muted">
              Balance is received minus used on site. It counts what the job holds wherever it is —
              the shop, the site or the truck — not what any list calls “have”.
            </p>
          </div>
        )}
      </Card>

      {/* ── 3. Exceptions — flagged, never blocking ──────────────────── */}
      <Card>
        <CardHeader
          title="Exceptions"
          meta={exceptions.length ? `${exceptions.length} to look at` : undefined}
        />
        {!exceptions.length ? (
          <p className="text-[14px] text-ink-muted">Nothing to flag — usage matches what was bought.</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-ink-muted">
              These never stop a technician recording what they actually used, and none of it is
              added to a material list automatically.
            </p>
            <ul data-testid="exceptions">
              {exceptions.map((e, i) => (
                <li key={`${e.kind}-${e.sku}-${i}`} className="border-t border-line py-3 first:border-t-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <StatusPill tone={EXCEPTION_TONE[e.kind]}>{EXCEPTION_LABEL[e.kind]}</StatusPill>
                    <span className="font-medium text-ink">{e.name || e.sku}</span>
                    {e.name ? <span className="text-[13px] text-ink-muted">{e.sku}</span> : null}
                  </div>
                  <p className="mt-1 text-[14px] text-ink">{e.detail}</p>
                  {/* The work order, date, quantity and note behind it —
                      so the office can go and ask about the actual day. */}
                  {e.entries.length ? (
                    <ul className="mt-1 space-y-1 border-l-2 border-amber-300 pl-3">
                      {e.entries.map((en, j) => (
                        <li key={j} className="text-[13px] text-ink-muted">
                          <strong className="text-ink">{en.qty}</strong> on{" "}
                          {en.workDate ? shortDate(en.workDate) : "an undated day"} ·{" "}
                          <a className="underline" href={`/admin/work-order/${encodeURIComponent(en.woId)}`}>{en.woId}</a>
                          {en.note ? <> — “{en.note}”</> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

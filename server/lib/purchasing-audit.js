"use strict";

// Where a purchase order and the material-list line it was ordered for
// disagree (2026-10-02). READ-ONLY: it reports, it never writes.
//
// From 2026-09-27 (688550c) until the one-commit fix in purchasing.js, the
// second half of a PO's save — moving its list lines — could be refused
// after the PO itself had saved. What that leaves behind, and the one
// repair that would make each line agree with its PO (the same rule
// purchasing.js lineMove applies on every send / receive / cancel):
//
//   received_still_ordered  the PO line arrived in full; the list line is
//                           still "ordered" on it        → have (price kept)
//   cancelled_still_ordered the PO was cancelled before this line arrived;
//                           the list line is still "ordered" on it
//                                                         → need (price lock off)
//   sent_never_marked       the PO is out with the supplier; the list line
//                           it was ordered for still says "need"
//                                                         → ordered on the PO
//                                                           (price = PO line's)
//   received_never_marked   the PO line arrived in full; the list line
//                           never left "need"            → have (price = PO line's)
//   po_missing / not_on_po / ordered_on_draft
//                           the list line names a PO that doesn't exist,
//                           doesn't carry it, or was never sent
//                                                         → no automatic repair;
//                                                           a person decides
//
// Self-contained on purpose (no require): scripts/audit-po-list-lines.mjs
// can hand this exact function to a browser, so the check run against the
// live site is this code, not a copy of it.

function auditPurchasingLines({ purchaseOrders = [], materialLists = [] } = {}) {
  const fully = (pl) => (Number(pl.receivedQty) || 0) >= (Number(pl.qty) || 0);
  const poById = new Map(purchaseOrders.map((p) => [p.id, p]));
  const listById = new Map(materialLists.map((l) => [l.id, l]));
  const findings = [];
  const notes = [];

  const describe = (list, line, po, pl, kind, repair, repairText) => ({
    kind,
    projectId: list.parentType === "project" ? list.parentId || null : null,
    listId: list.id,
    listName: list.name || "",
    lineId: line.id,
    sku: line.sku,
    line: { status: line.status || "need", poId: line.poId || null, frozenPriceCents: line.frozenPriceCents == null ? null : line.frozenPriceCents },
    poId: po ? po.id : (line.poId || null),
    poStatus: po ? po.status : null,
    poLine: pl ? { id: pl.id, qty: Number(pl.qty) || 0, receivedQty: Number(pl.receivedQty) || 0, unitPriceCents: Number(pl.unitPriceCents) || 0 } : null,
    repair,
    repairText
  });

  // 1. Every list line that says "ordered" — on what, and should it still?
  for (const list of materialLists) {
    for (const line of list.lineItems || []) {
      if (line.status !== "ordered") continue;
      const po = poById.get(line.poId);
      if (!po) {
        findings.push(describe(list, line, null, null, "po_missing", null, `Says ordered on ${line.poId || "(no PO)"}, which doesn't exist — a person decides.`));
        continue;
      }
      const pl = (po.lineItems || []).find((x) => x.sourceListId === list.id && x.sourceLineId === line.id);
      if (!pl) {
        findings.push(describe(list, line, po, null, "not_on_po", null, `Says ordered on ${po.id}, but ${po.id} has no line for it — a person decides.`));
        continue;
      }
      if (fully(pl)) {
        findings.push(describe(list, line, po, pl, "received_still_ordered", { status: "have", poId: null },
          `Mark "have" and clear the PO link; keep the price it was bought at.`));
      } else if (po.status === "cancelled") {
        findings.push(describe(list, line, po, pl, "cancelled_still_ordered", { status: "need", poId: null, frozenPriceCents: null },
          `Mark "need", clear the PO link and release the price lock, so it can be ordered again.`));
      } else if (po.status === "draft") {
        findings.push(describe(list, line, po, pl, "ordered_on_draft", null, `Says ordered on ${po.id}, which was never sent — a person decides.`));
      }
    }
  }

  // 2. Every sent PO line — does the list line it was ordered for know?
  for (const po of purchaseOrders) {
    if (po.status === "draft") continue;
    for (const pl of po.lineItems || []) {
      if (!pl.sourceListId || !pl.sourceLineId) continue;
      const list = listById.get(pl.sourceListId);
      const line = list && (list.lineItems || []).find((l) => l.id === pl.sourceLineId);
      if (!line) {
        notes.push({ kind: "source_missing", poId: po.id, poStatus: po.status, listId: pl.sourceListId, lineId: pl.sourceLineId, sku: pl.sku });
        continue;
      }
      const status = line.status || "need";
      if (status !== "need" || line.poId) continue;
      if (fully(pl)) {
        findings.push(describe(list, line, po, pl, "received_never_marked", { status: "have", poId: null, frozenPriceCents: Number(pl.unitPriceCents) || 0 },
          `Mark "have" at ${po.id}'s price — it arrived on ${po.id}.`));
      } else if (po.status === "sent" || po.status === "partially_received") {
        findings.push(describe(list, line, po, pl, "sent_never_marked", { status: "ordered", poId: po.id, frozenPriceCents: Number(pl.unitPriceCents) || 0 },
          `Mark "ordered" on ${po.id} at its price — it is out with the supplier.`));
      }
    }
  }

  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    findings,
    notes,
    totals: {
      projects: uniq(findings.map((f) => f.projectId)).length,
      materialLists: uniq(findings.map((f) => f.listId)).length,
      purchaseOrders: uniq(findings.map((f) => f.poId)).length,
      lines: findings.length,
      repairable: findings.filter((f) => f.repair).length,
      needsAPerson: findings.filter((f) => !f.repair).length
    }
  };
}

// Plain-text report — also self-contained, for the same reason.
function formatPurchasingAudit(result) {
  const t = result.totals;
  const out = [];
  out.push("PO / material-list consistency check (read-only — nothing was changed)");
  out.push(`Affected: ${t.projects} project(s), ${t.materialLists} material list(s), ${t.purchaseOrders} purchase order(s), ${t.lines} line(s)`);
  out.push(`  repairable by rule: ${t.repairable}   needs a person: ${t.needsAPerson}`);
  for (const f of result.findings) {
    out.push("");
    out.push(`[${f.kind}] project ${f.projectId || "(none)"} · list ${f.listId}${f.listName ? ` "${f.listName}"` : ""} · line ${f.lineId} (${f.sku})`);
    out.push(`  PO ${f.poId || "(none)"}: ${f.poStatus || "not found"}${f.poLine ? ` — line ${f.poLine.receivedQty}/${f.poLine.qty} received` : ""}`);
    out.push(`  list line now: ${f.line.status}${f.line.poId ? ` on ${f.line.poId}` : ""}${f.line.frozenPriceCents != null ? `, price locked ${f.line.frozenPriceCents}¢` : ""}`);
    out.push(`  repair: ${f.repairText}${f.repair ? `  ${JSON.stringify(f.repair)}` : ""}`);
  }
  if (result.notes.length) {
    out.push("");
    out.push(`For information (not a disagreement): ${result.notes.length} sent PO line(s) whose source list line no longer exists:`);
    for (const n of result.notes) out.push(`  ${n.poId} (${n.poStatus}) → list ${n.listId} line ${n.lineId} (${n.sku})`);
  }
  return out.join("\n");
}

module.exports = { auditPurchasingLines, formatPurchasingAudit };

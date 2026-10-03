"use strict";

// The ONE definition of "a purchase order and its material list agree"
// (2026-10-02, revised 2026-10-03). READ-ONLY: it classifies, it never
// writes.
//
// Used, unchanged, by:
//   • purchasing-store.checkConsistency() — the boot check that puts
//     recovery holds on anything it finds with severity "hold";
//   • scripts/audit-po-list-lines.mjs — the read-only audit, which embeds
//     THIS function's source in the browser snippet (so the snippet runs
//     this code, not a copy). scripts/test-purchasing-matrix.mjs proves the
//     embedded copy answers identically for every state in the matrix.
// purchasing.js lineMove (the live send / receive / cancel rule) is held to
// it by the same matrix test: every transition it makes from an agreeing
// state lands on a state this calls agreeing.
//
// The model. The PO line is the record of what was ordered, what arrived
// (receivedQty) and at what price (unitPriceCents) — never rewritten by
// anything on the list side. A PO line "claims" the list line its
// sourceListId + sourceLineId point at. For each list line L (quantity Q),
// across its non-draft claims:
//   open       — on a sent / partially received PO, still outstanding.
//                At most ONE may exist.
//   completed  — on a PO that isn't cancelled, arrived in full. Any number
//                may exist (6 on one order, the other 4 on a later one).
//   cancelled  — on a cancelled PO (what arrived on it still counts).
//   received   = Σ arrived on all of them; remaining = Q − received.
// L agrees with its POs when:
//   • "ordered" on P   ⇔ P holds the one open claim;
//   • "have"           ⇔ nothing is open and received ≥ Q (or no PO has ever
//                        claimed it — stock already on hand);
//   • "need" (no PO)   ⇔ nothing is open and received < Q — the rest is
//                        what PO generation orders (stillToOrder).
// A purchase-order line whose list or list line no longer exists is
// historical evidence the checker can't place: on a sent, received or
// cancelled PO it is a contradiction ("source_missing", the PO held); on a
// draft it is a mistake to fix before sending ("draft_source_missing").
//
// Severity:
//   "hold"     — the records contradict each other: which one is right
//                can't be proven. The boot check holds them
//                (purchasing-store).
//   "review"   — the records agree on state, but the quantities or prices
//                don't add up. A person should look; nothing is held.
//   "reviewed" — a missing source the office has reviewed (released its
//                hold with a note). Still a disagreement, still reported
//                and counted; no longer held. Nothing can repair it — the
//                list line is gone — so the review is the only way out of
//                the hold, and it never turns into "agrees".
// Repairable by rule ONLY when the repair changes nothing but the list
// line's status / poId / frozenPriceCents, every PO record already holds
// exactly what arrived and at what price (none is touched), the list's
// locked price is empty or equal to the PO price, the quantities add up,
// and — for any repair that locks a price — every receipt behind the line
// came at that ONE price (and, for "ordered", the open order is at it too).
// Mixed prices are never turned into one price by rule. A cancelled PO with part of the line delivered is "needs a person"
// whenever the list still points at it.
//
// Self-contained on purpose (no require, no outside names).

function auditPurchasingLines({ purchaseOrders = [], materialLists = [] } = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const poById = new Map();
  for (const p of purchaseOrders) if (p && p.id) poById.set(p.id, p);
  const listById = new Map();
  for (const l of materialLists) if (l && l.id) listById.set(l.id, l);
  const findings = [];
  const notes = [];   // kept for the result's shape; every case is now a finding
  const PERSON = "Needs a person — the records can't show which is right.";

  // Every PO line, by the list line it claims; and every claim whose list
  // or line is gone.
  const claimsByLine = new Map();     // "listId|lineId" -> [claim]
  for (const po of purchaseOrders) {
    if (!po || !po.id) continue;
    const poStatus = po.status || "draft";
    if (poStatus === "draft" && po.deletedAt) continue;   // a draft in the Trash orders nothing
    for (const pl of po.lineItems || []) {
      if (!pl || !pl.sourceListId || !pl.sourceLineId) continue;
      const qty = Math.max(0, num(pl.qty));
      const claim = {
        poId: po.id, poStatus, poLineId: pl.id || null, sku: pl.sku || "", qty,
        receivedQty: Math.min(qty, Math.max(0, num(pl.receivedQty))),
        unitPriceCents: num(pl.unitPriceCents)
      };
      claim.outstandingQty = claim.qty - claim.receivedQty;
      const list = listById.get(pl.sourceListId);
      const exists = Boolean(list && (list.lineItems || []).some((l) => l && l.id === pl.sourceLineId));
      if (!exists) {
        const what = list ? `line ${pl.sourceLineId} of list ${pl.sourceListId}` : `list ${pl.sourceListId}`;
        const base = {
          severity: poStatus === "draft" ? "review" : "hold", repairable: false, repair: null,
          projectId: list && list.parentType === "project" ? (list.parentId || null) : null,
          listId: pl.sourceListId, listName: list ? (list.name || "") : "", listMissing: !list,
          lineId: pl.sourceLineId, sku: claim.sku, poId: po.id, poStatus,
          line: null, quantities: { needed: null, received: claim.receivedQty, onOrder: poStatus === "sent" || poStatus === "partially_received" ? claim.outstandingQty : 0, remaining: null },
          claims: [{ poId: po.id, poStatus, qty: claim.qty, receivedQty: claim.receivedQty, outstandingQty: claim.outstandingQty, unitPriceCents: claim.unitPriceCents }]
        };
        if (poStatus === "draft") {
          findings.push({ ...base, kind: "draft_source_missing",
            repairText: `Draft ${po.id} is for ${what}, which no longer exists. Nothing was bought on it; it can't be sent until the line is removed from the draft or the draft is deleted.` });
        } else if (pl.sourceMissingAcknowledged) {
          // The office's review does NOT make the records agree — the list
          // line is still gone and this purchase is still on no job. It is
          // reported, and counted, as reviewed-but-unresolved; it is only
          // no longer held.
          const a = pl.sourceMissingAcknowledged;
          findings.push({ ...base, kind: "source_missing_reviewed", severity: "reviewed",
            reviewed: { by: a.by || null, at: a.at || null, note: a.note || "" },
            repairText: `${po.id} (${poStatus}) — ordered ${claim.qty}, received ${claim.receivedQty}, at ${claim.unitPriceCents}¢ — is for ${what}, which no longer exists. ` +
              `Reviewed by ${a.by || "the office"}${a.at ? ` on ${a.at}` : ""}: "${a.note || ""}". Still not on any job; the review does not make the records agree. ` +
              "It can be received or cancelled to record what happened, but not re-ordered." });
        } else {
          findings.push({ ...base, kind: "source_missing",
            repairText: `${po.id} (${poStatus}) — ordered ${claim.qty}, received ${claim.receivedQty}, at ${claim.unitPriceCents}¢ — is for ${what}, which no longer exists, so this purchase can't be placed on any job. The PO is locked until the office reviews it. ${PERSON}` });
        }
        continue;
      }
      const key = pl.sourceListId + "|" + pl.sourceLineId;
      if (!claimsByLine.has(key)) claimsByLine.set(key, []);
      claimsByLine.get(key).push(claim);
    }
  }

  const finding = (ctx, kind, severity, repair, text) => {
    findings.push({
      kind, severity, repairable: Boolean(repair), repair: repair || null, repairText: text,
      projectId: ctx.list.parentType === "project" ? (ctx.list.parentId || null) : null,
      listId: ctx.list.id, listName: ctx.list.name || "", listMissing: false,
      lineId: ctx.line.id, sku: ctx.line.sku || "",
      poId: ctx.poId,
      poStatus: ctx.poId && poById.has(ctx.poId) ? (poById.get(ctx.poId).status || "draft") : null,
      line: { status: ctx.status, qty: ctx.qty, poId: ctx.line.poId || null, frozenPriceCents: ctx.frozen },
      quantities: { needed: ctx.qty, received: ctx.received, onOrder: ctx.onOrder, remaining: ctx.qty - ctx.received },
      claims: ctx.claims.map((c) => ({ poId: c.poId, poStatus: c.poStatus, qty: c.qty, receivedQty: c.receivedQty, outstandingQty: c.outstandingQty, unitPriceCents: c.unitPriceCents }))
    });
  };

  for (const list of materialLists) {
    if (!list || !list.id) continue;
    for (const line of list.lineItems || []) {
      if (!line || !line.id) continue;
      const claims = (claimsByLine.get(list.id + "|" + line.id) || []).filter((c) => c.poStatus !== "draft");
      const status = ["need", "ordered", "have"].includes(line.status) ? line.status : "need";
      const qty = Math.max(0, num(line.qty) || 1);
      const frozen = line.frozenPriceCents == null ? null : num(line.frozenPriceCents);
      const received = claims.reduce((n, c) => n + c.receivedQty, 0);
      const open = claims.filter((c) => (c.poStatus === "sent" || c.poStatus === "partially_received") && c.outstandingQty > 0);
      const completed = claims.filter((c) => c.poStatus !== "cancelled" && c.outstandingQty <= 0);
      const cancelledPartial = claims.filter((c) => c.poStatus === "cancelled" && c.receivedQty > 0 && c.outstandingQty > 0);
      const onOrder = open.reduce((n, c) => n + c.outstandingQty, 0);
      // Prices behind what arrived. One price → a repair may lock it; more
      // than one → no single price is true for the line.
      const receiptPrices = [...new Set(claims.filter((c) => c.receivedQty > 0).map((c) => c.unitPriceCents))];
      const onePrice = receiptPrices.length === 1 ? receiptPrices[0] : null;
      const mixed = receiptPrices.length > 1;
      const priceList = () => claims.filter((c) => c.receivedQty > 0).map((c) => `${c.receivedQty} at ${c.unitPriceCents}¢ on ${c.poId}`).join(", ");
      const ctx = { list, line, status, qty, frozen, received, onOrder, claims, poId: line.poId || (open[0] && open[0].poId) || null };
      const lockOk = (price) => frozen == null || frozen === price;
      const dup = claims.some((c, i) => claims.findIndex((d) => d.poId === c.poId) !== i);
      const ahead = (poId) => (list.history || []).find((h) => h && (h.action === "po_received" || h.action === "po_cancelled") &&
        String(h.note || "").startsWith(poId + ":"));

      if (dup) { finding(ctx, "duplicate_claim_on_po", "hold", null, `Two lines on one purchase order are both for this list line. ${PERSON}`); continue; }
      if (open.length > 1) {
        ctx.poId = open.map((c) => c.poId).join(", ");
        finding(ctx, "multiple_open_orders", "hold", null, `More than one open purchase order is for this list line (${open.map((c) => `${c.poId}: ${c.outstandingQty} outstanding`).join("; ")}). ${PERSON}`);
        continue;
      }
      if (status === "need" && line.poId) { finding(ctx, "need_with_po", "hold", null, `The line says "need" but also names ${line.poId}. ${PERSON}`); continue; }
      const o = open[0] || null;

      if (status === "ordered") {
        const p = poById.get(line.poId);
        if (!p) { ctx.poId = line.poId || null; finding(ctx, "po_missing", "hold", null, `Says ordered on ${line.poId || "(no PO)"}, which doesn't exist. ${PERSON}`); continue; }
        if ((p.status || "draft") === "draft") { ctx.poId = p.id; finding(ctx, "ordered_on_draft", "hold", null, `Says ordered on ${p.id}, which was never sent. ${PERSON}`); continue; }
        const c = claims.find((x) => x.poId === p.id);
        ctx.poId = p.id;
        if (!c) { finding(ctx, o ? "points_to_other_po" : "not_on_po", "hold", null, `Says ordered on ${p.id}, but ${p.id} has no line for it${o ? ` — ${o.poId} is the open order` : ""}. ${PERSON}`); continue; }
        if (o && o.poId !== p.id) { finding(ctx, "points_to_other_po", "hold", null, `Says ordered on ${p.id} (${c.poStatus}), but the open order for it is ${o.poId}. ${PERSON}`); continue; }
        if (o && o.poId === p.id) {
          // The open order — agrees. Quantities: short, or more than needed
          // once something has arrived.
          if (received + o.outstandingQty < qty) finding(ctx, "quantity_short", "review", null, `${received} received + ${o.outstandingQty} on order on ${p.id} is less than the ${qty} the list needs. A person should check the quantity.`);
          else if (received >= qty) finding(ctx, "quantity_over", "review", null, `All ${qty} needed have already arrived (${received}), yet ${o.outstandingQty} more are on order on ${p.id}. A person should check before more arrives.`);
          else if (received > 0 && received + o.outstandingQty > qty) finding(ctx, "quantity_over", "review", null, `${received} already arrived, and ${p.id} has ${o.outstandingQty} more on order — ${received + o.outstandingQty - qty} more than the ${qty} the list needs. A person should check.`);
          continue;
        }
        // The list still points at P, which is no longer open.
        if (c.poStatus === "cancelled" && c.receivedQty > 0 && c.outstandingQty > 0) {
          finding(ctx, "cancelled_partial_still_ordered", "hold", null,
            `${p.id} was cancelled after ${c.receivedQty} of ${c.qty} arrived (at ${c.unitPriceCents}¢ each); the list still says ordered. ${received} received, ${Math.max(0, qty - received)} still to order. Needs a person to confirm what remains — not changed by rule.`);
          continue;
        }
        if (received >= qty) {
          const ok = !mixed && onePrice != null && lockOk(onePrice);
          finding(ctx, "received_still_ordered", "hold",
            ok ? { status: "have", poId: null, frozenPriceCents: onePrice } : null,
            ok ? `All ${qty} arrived (${priceList()}): mark "have" at the one price paid, ${onePrice}¢.`
               : mixed ? `All ${qty} arrived, but at different prices (${priceList()}); the list can lock only one price, so no single price is set by rule. ${PERSON}`
               : `All ${qty} arrived, but the list's locked price (${frozen}¢) differs from what was paid. ${PERSON}`);
          continue;
        }
        // Less than the line arrived and nothing is open: the rest is still
        // to order. The arrivals stay on their POs.
        const ok = lockOk(c.unitPriceCents);
        finding(ctx, c.poStatus === "cancelled" ? "cancelled_still_ordered" : "completed_still_ordered", "hold",
          ok ? { status: "need", poId: null, frozenPriceCents: null } : null,
          ok ? `${p.id} is ${c.poStatus === "cancelled" ? "cancelled" : "complete"} with ${received} of ${qty} arrived in all: mark "need" — ${qty - received} still to order. What arrived, and its price, stays on the PO records.`
             : `${p.id} is no longer open, but the list's locked price differs from it. ${PERSON}`);
        continue;
      }

      if (status === "have") {
        if (o) { ctx.poId = o.poId; finding(ctx, ahead(o.poId) ? "list_ahead_of_po" : "have_but_po_outstanding", "hold", null, `The list says "have", but ${o.poId} (${o.poStatus}) still has ${o.outstandingQty} of ${o.qty} outstanding. ${PERSON}`); continue; }
        if (!claims.length) continue;   // stock already on hand — no purchase order involved
        if (received >= qty) {
          if (mixed) { ctx.poId = completed.concat(claims).find((c) => c.receivedQty > 0).poId; finding(ctx, "mixed_receipt_prices", "review", null, `All ${qty} arrived at different prices (${priceList()}), but the list locks one price${frozen != null ? ` (${frozen}¢)` : ""} for all ${qty}. The PO records hold the true cost; a person should check the list's figure.`); }
          continue;   // agrees
        }
        ctx.poId = (completed[0] || claims[claims.length - 1]).poId;
        if (completed.length) finding(ctx, "quantity_short", "review", null, `The list says "have" ${qty}, but only ${received} arrived on its purchase orders. A person should check the quantity.`);
        else finding(ctx, "have_without_delivery", "hold", null, `The list says "have", but its purchase orders were cancelled with only ${received} of ${qty} delivered. ${PERSON}`);
        continue;
      }

      // status === "need", on no PO.
      if (o) {
        ctx.poId = o.poId;
        const h = ahead(o.poId);
        if (h) { finding(ctx, "list_ahead_of_po", "hold", null, `The list recorded ${o.poId} as ${h.action === "po_received" ? "received" : "cancelled"} (${h.ts || "?"}), but ${o.poId} is still ${o.poStatus} with ${o.outstandingQty} outstanding. ${PERSON}`); continue; }
        const covered = received + o.outstandingQty >= qty;
        const onePriceOk = receiptPrices.every((pr) => pr === o.unitPriceCents);
        const ok = covered && onePriceOk;
        finding(ctx, "sent_never_marked", "hold",
          ok ? { status: "ordered", poId: o.poId, frozenPriceCents: o.unitPriceCents } : null,
          ok ? `${o.poId} is out with the supplier (${o.outstandingQty} outstanding at ${o.unitPriceCents}¢): mark "ordered" on it, its price locked as the price on order.`
             : !covered ? `${o.poId} is out with the supplier, but ${received} received + ${o.outstandingQty} on order don't cover the ${qty} needed. ${PERSON}`
             : `${o.poId} is out with the supplier at ${o.unitPriceCents}¢, but what already arrived came at a different price (${priceList()}); the list can lock only one price, so none is set by rule. ${PERSON}`);
        continue;
      }
      if (received >= qty && claims.length) {
        ctx.poId = (completed[0] || claims[claims.length - 1]).poId;
        if (!completed.length) { finding(ctx, "need_but_all_arrived", "hold", null, `The list says "need", but all ${qty} already arrived on cancelled purchase orders. ${PERSON}`); continue; }
        const ok = !mixed && onePrice != null;
        finding(ctx, "received_never_marked", "hold",
          ok ? { status: "have", poId: null, frozenPriceCents: onePrice } : null,
          ok ? `All ${qty} arrived (${priceList()}): mark "have" at the one price paid, ${onePrice}¢.`
             : `All ${qty} arrived, but at different prices (${priceList()}); the list can lock only one price, so no single price is set by rule. ${PERSON}`);
        continue;
      }
      // Agrees: nothing open; qty − received is what PO generation orders.
    }
  }

  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const held = findings.filter((f) => f.severity === "hold");
  const reviewed = findings.filter((f) => f.severity === "reviewed");
  return {
    findings,
    notes,
    totals: {
      projects: uniq(findings.map((f) => f.projectId)).length,
      materialLists: uniq(findings.map((f) => f.listId)).length,
      purchaseOrders: uniq(findings.flatMap((f) => String(f.poId || "").split(", "))).length,
      lines: findings.length,
      hold: held.length,
      review: findings.length - held.length - reviewed.length,
      reviewed: reviewed.length,
      repairable: findings.filter((f) => f.repairable).length,
      needsAPerson: findings.filter((f) => !f.repairable && f.severity !== "reviewed").length
    }
  };
}

// Plain-text report — also self-contained, for the same reason.
function formatPurchasingAudit(result) {
  const t = result.totals;
  const out = [];
  out.push("PO / material-list consistency check (read-only — nothing was changed)");
  out.push(`Affected: ${t.projects} project(s), ${t.materialLists} material list(s), ${t.purchaseOrders} purchase order(s), ${t.lines} line(s)`);
  out.push(`  records disagree (would be held): ${t.hold}   quantity to review: ${t.review}`);
  out.push(`  repairable by rule: ${t.repairable}   needs a person: ${t.needsAPerson}`);
  out.push(`  reviewed by the office, still unresolved (list gone, on no job): ${t.reviewed}`);
  for (const f of result.findings) {
    out.push("");
    out.push(`[${f.kind}] ${f.severity === "hold" ? "RECORDS DISAGREE" : f.severity === "reviewed" ? "RECORDS DISAGREE — REVIEWED, NOT HELD" : "REVIEW"} · ${f.repairable ? "repairable by rule" : f.severity === "reviewed" ? "no repair possible" : "needs a person"}`);
    out.push(`  project ${f.projectId || "(none)"} · list ${f.listId}${f.listName ? ` "${f.listName}"` : ""} · line ${f.lineId} (${f.sku})`);
    if (f.line) {
      out.push(`  list line now: ${f.line.status} ×${f.line.qty}${f.line.poId ? ` on ${f.line.poId}` : ""}${f.line.frozenPriceCents != null ? `, price locked ${f.line.frozenPriceCents}¢` : ""}`);
      out.push(`  quantities: needed ${f.quantities.needed} · received ${f.quantities.received} · on order ${f.quantities.onOrder} · still to order ${Math.max(0, f.quantities.remaining - f.quantities.onOrder)}`);
    } else {
      out.push(`  ${f.listMissing ? "material list" : "list line"} not found — ${f.listMissing ? "the list" : "the line"} was deleted or never existed`);
    }
    for (const c of f.claims) {
      out.push(`  ${c.poId} (${c.poStatus}): ordered ${c.qty}, received ${c.receivedQty}, outstanding ${c.outstandingQty}, at ${c.unitPriceCents}¢ each`);
    }
    out.push(`  ${f.repairable ? "repair" : "action"}: ${f.repairText}${f.repair ? `  ${JSON.stringify(f.repair)}` : ""}`);
  }
  return out.join("\n");
}

module.exports = { auditPurchasingLines, formatPurchasingAudit };

"use strict";

// The ONE definition of "a purchase order and its material list agree"
// (2026-10-02). READ-ONLY: it classifies, it never writes.
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
// sourceListId + sourceLineId point at. For each list line L (qty Q):
//   received   = Σ arrived on every non-draft claim (cancelled ones too)
//   remaining  = Q − received          (what is still to be ordered)
//   active     = the claims on POs that are not cancelled (sent, partially
//                received, received). At most ONE may exist; cancelled
//                claims can sit beside it (a partial delivery, then the
//                rest re-ordered).
// L agrees with its POs when:
//   • L is "ordered" on P            ⇔ P is the active claim and its line is
//                                       still outstanding;
//   • L is "have"                    ⇔ the active claim arrived in full (or
//                                       there are no claims at all — stock
//                                       already on hand);
//   • L is "need" (and on no PO)     ⇔ no active claim is outstanding or
//                                       done, and something remains to order.
//
// Severity:
//   "hold"   — the records contradict each other: which one is right can't
//              be proven. The boot check holds both (purchasing-store).
//   "review" — the records agree on state, but the quantities don't add up
//              (e.g. fewer ordered or received than the list needs). A
//              person should look; nothing is held — a draft PO's quantity
//              can be edited on purpose.
// Repairable by rule ONLY when the repair changes nothing but the list
// line's status / poId / frozenPriceCents, the PO line already records
// exactly what arrived and at what price (it is never touched), the list
// line's locked price is either empty or equal to that PO line's price (so
// no price is lost), and the quantities add up. Anything else: "needs a
// person". A cancelled PO with part of the line delivered is ALWAYS "needs
// a person" (Patrick, 2026-10-02).
//
// Self-contained on purpose (no require, no outside names).

function auditPurchasingLines({ purchaseOrders = [], materialLists = [] } = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const poById = new Map();
  for (const p of purchaseOrders) if (p && p.id) poById.set(p.id, p);
  const listById = new Map();
  for (const l of materialLists) if (l && l.id) listById.set(l.id, l);

  // Every PO line, by the list line it claims. Drafts are kept apart: a
  // draft has not been sent, so it says nothing about the list yet.
  const claimsByLine = new Map();     // "listId|lineId" -> [claim]
  const notes = [];
  const findings = [];
  for (const po of purchaseOrders) {
    if (!po || !po.id) continue;
    const seen = new Map();
    for (const pl of po.lineItems || []) {
      if (!pl || !pl.sourceListId || !pl.sourceLineId) continue;
      const key = pl.sourceListId + "|" + pl.sourceLineId;
      const qty = Math.max(0, num(pl.qty));
      const claim = {
        poId: po.id,
        poStatus: po.status || "draft",
        poLineId: pl.id || null,
        sku: pl.sku || "",
        qty,
        receivedQty: Math.min(qty, Math.max(0, num(pl.receivedQty))),
        unitPriceCents: num(pl.unitPriceCents)
      };
      claim.outstandingQty = claim.qty - claim.receivedQty;
      seen.set(key, (seen.get(key) || 0) + 1);
      if (!claimsByLine.has(key)) claimsByLine.set(key, []);
      claimsByLine.get(key).push(claim);
      const list = listById.get(pl.sourceListId);
      if (!list || !(list.lineItems || []).some((l) => l && l.id === pl.sourceLineId)) {
        notes.push({ kind: "source_missing", poId: po.id, poStatus: claim.poStatus, listId: pl.sourceListId, lineId: pl.sourceLineId, sku: claim.sku });
      }
    }
    for (const [key, n] of seen) {
      if (n > 1) {
        const [listId, lineId] = key.split("|");
        notes.push({ kind: "duplicate_claim_on_po", poId: po.id, listId, lineId, count: n });
      }
    }
  }

  const finding = (ctx, kind, severity, repair, text) => {
    findings.push({
      kind,
      severity,
      repairable: Boolean(repair),
      repair: repair || null,
      repairText: text,
      projectId: ctx.list.parentType === "project" ? (ctx.list.parentId || null) : null,
      listId: ctx.list.id,
      listName: ctx.list.name || "",
      lineId: ctx.line.id,
      sku: ctx.line.sku || "",
      poId: ctx.poId,
      poStatus: ctx.poId && poById.has(ctx.poId) ? (poById.get(ctx.poId).status || "draft") : null,
      line: { status: ctx.status, qty: ctx.qty, poId: ctx.line.poId || null, frozenPriceCents: ctx.frozen },
      quantities: { needed: ctx.qty, received: ctx.received, onOrder: ctx.onOrder, remaining: ctx.qty - ctx.received },
      claims: ctx.claims.map((c) => ({ poId: c.poId, poStatus: c.poStatus, qty: c.qty, receivedQty: c.receivedQty, outstandingQty: c.outstandingQty, unitPriceCents: c.unitPriceCents }))
    });
  };
  const PERSON = "Needs a person — the records can't show which is right.";

  for (const list of materialLists) {
    if (!list || !list.id) continue;
    for (const line of list.lineItems || []) {
      if (!line || !line.id) continue;
      const all = claimsByLine.get(list.id + "|" + line.id) || [];
      const claims = all.filter((c) => c.poStatus !== "draft");
      const status = ["need", "ordered", "have"].includes(line.status) ? line.status : "need";
      const qty = Math.max(0, num(line.qty) || 1);
      const frozen = line.frozenPriceCents == null ? null : num(line.frozenPriceCents);
      const received = claims.reduce((n, c) => n + c.receivedQty, 0);
      const active = claims.filter((c) => c.poStatus !== "cancelled");
      const live = active.filter((c) => (c.poStatus === "sent" || c.poStatus === "partially_received") && c.outstandingQty > 0);
      const done = active.filter((c) => c.outstandingQty <= 0);
      const cancelledPartial = claims.filter((c) => c.poStatus === "cancelled" && c.receivedQty > 0 && c.outstandingQty > 0);
      const onOrder = live.reduce((n, c) => n + c.outstandingQty, 0);
      const ctx = { list, line, status, qty, frozen, received, onOrder, claims, poId: line.poId || (active[0] && active[0].poId) || null };
      const priceKept = (c) => frozen == null || frozen === c.unitPriceCents;
      const dup = claims.some((c, i) => claims.findIndex((d) => d.poId === c.poId) !== i);

      // Records the history on the list itself says moved, while the PO
      // didn't — the list's half of a save landed, the PO's half was lost.
      const ahead = (poId) => (list.history || []).find((h) => h && (h.action === "po_received" || h.action === "po_cancelled") &&
        String(h.note || "").startsWith(poId + ":"));

      if (dup) {
        finding(ctx, "duplicate_claim_on_po", "hold", null, `Two lines on one purchase order are both for this list line. ${PERSON}`);
        continue;
      }
      if (active.length > 1) {
        ctx.poId = active.map((c) => c.poId).join(", ");
        finding(ctx, "multiple_active_claims", "hold", null, `More than one purchase order that isn't cancelled is for this list line (${active.map((c) => c.poId + " " + c.poStatus).join(", ")}). ${PERSON}`);
        continue;
      }
      if (status === "need" && line.poId) {
        finding(ctx, "need_with_po", "hold", null, `The line says "need" but also names ${line.poId}. ${PERSON}`);
        continue;
      }

      const a = active[0] || null;
      if (status === "ordered") {
        const p = poById.get(line.poId);
        if (!p) { ctx.poId = line.poId || null; finding(ctx, "po_missing", "hold", null, `Says ordered on ${line.poId || "(no PO)"}, which doesn't exist. ${PERSON}`); continue; }
        if ((p.status || "draft") === "draft") { ctx.poId = p.id; finding(ctx, "ordered_on_draft", "hold", null, `Says ordered on ${p.id}, which was never sent. ${PERSON}`); continue; }
        const c = claims.find((x) => x.poId === p.id);
        ctx.poId = p.id;
        if (!c) { finding(ctx, a ? "points_to_other_po" : "not_on_po", "hold", null, `Says ordered on ${p.id}, but ${p.id} has no line for it${a ? ` — ${a.poId} does` : ""}. ${PERSON}`); continue; }
        if (c.poStatus === "cancelled") {
          if (a) {
            finding(ctx, "points_to_other_po", "hold", null, `Says ordered on ${p.id}, which was cancelled, while ${a.poId} (${a.poStatus}) is the order for it now. ${PERSON}`);
          } else if (c.receivedQty > 0 && c.outstandingQty > 0) {
            finding(ctx, "cancelled_partial_still_ordered", "hold", null,
              `${p.id} was cancelled after ${c.receivedQty} of ${c.qty} arrived (at ${c.unitPriceCents}¢ each); the list still says ordered. ${received} received, ${qty - received} still to order. Needs a person to confirm what remains — not changed by rule.`);
          } else if (c.outstandingQty <= 0) {
            finding(ctx, "received_still_ordered", "hold",
              priceKept(c) && received >= qty ? { status: "have", poId: null, frozenPriceCents: c.unitPriceCents } : null,
              priceKept(c) && received >= qty ? `All ${c.qty} arrived on ${p.id} before it was cancelled: mark "have", keep the price paid (${c.unitPriceCents}¢).` : `Everything on ${p.id}'s line arrived, but the quantities or the locked price don't match. ${PERSON}`);
          } else {
            const ok = priceKept(c) && received === 0;
            finding(ctx, "cancelled_still_ordered", "hold",
              ok ? { status: "need", poId: null, frozenPriceCents: null } : null,
              ok ? `${p.id} was cancelled before anything arrived: mark "need" (all ${qty} still to order) and release the price lock — the price stays on ${p.id}'s record.` : `${p.id} was cancelled, but other receipts or a different locked price are involved. ${PERSON}`);
          }
          continue;
        }
        // p is the active claim.
        if (c.outstandingQty > 0) {
          if (received + c.outstandingQty < qty) finding(ctx, "quantity_short", "review", null, `${received} received + ${c.outstandingQty} on order on ${p.id} is less than the ${qty} the list needs. A person should check the quantity.`);
          else if (received >= qty) finding(ctx, "quantity_over", "review", null, `All ${qty} needed have already arrived (${received}), yet ${c.outstandingQty} more are on order on ${p.id}. A person should check before more arrives.`);
          else if (cancelledPartial.length && received + c.outstandingQty > qty) finding(ctx, "quantity_over", "review", null, `${received} already arrived on a cancelled order, and ${p.id} has ${c.outstandingQty} more on order — ${received + c.outstandingQty - qty} more than the ${qty} the list needs. It looks like what arrived was ordered again; a person should check.`);
          continue; // agrees
        }
        const ok = priceKept(c) && received >= qty;
        finding(ctx, "received_still_ordered", "hold",
          ok ? { status: "have", poId: null, frozenPriceCents: c.unitPriceCents } : null,
          ok ? `All ${c.qty} arrived on ${p.id}: mark "have" and keep the price paid (${c.unitPriceCents}¢).` : `${p.id}'s line arrived in full, but ${received} received is short of the ${qty} needed, or the locked price differs. ${PERSON}`);
        continue;
      }

      if (status === "have") {
        if (a && live.length) {
          ctx.poId = a.poId;
          finding(ctx, ahead(a.poId) ? "list_ahead_of_po" : "have_but_po_outstanding", "hold", null,
            `The list says "have", but ${a.poId} (${a.poStatus}) still has ${a.outstandingQty} of ${a.qty} outstanding. ${PERSON}`);
          continue;
        }
        if (!claims.length) continue; // stock already on hand — no purchase order involved
        if (a) {
          // The active order arrived in full; a draft PO's quantity may have
          // been edited, so a shortfall is for review, not a contradiction.
          if (received < qty) { ctx.poId = a.poId; finding(ctx, "quantity_short", "review", null, `The list says "have" ${qty}, but only ${received} arrived on its purchase orders. A person should check the quantity.`); }
          continue; // agrees
        }
        if (received < qty) {
          ctx.poId = claims[claims.length - 1].poId;
          finding(ctx, "have_without_delivery", "hold", null,
            `The list says "have", but its purchase orders were cancelled with only ${received} of ${qty} delivered. ${PERSON}`);
        }
        continue; // all of it arrived before the cancellation: agrees
      }

      // status === "need", on no PO.
      if (a && live.length) {
        ctx.poId = a.poId;
        const h = ahead(a.poId);
        if (h) {
          finding(ctx, "list_ahead_of_po", "hold", null,
            `The list recorded ${a.poId} as ${h.action === "po_received" ? "received" : "cancelled"} (${h.ts || "?"}), but ${a.poId} is still ${a.poStatus} with ${a.outstandingQty} outstanding. ${PERSON}`);
          continue;
        }
        const ok = received + a.outstandingQty >= qty && frozen == null;
        finding(ctx, "sent_never_marked", "hold",
          ok ? { status: "ordered", poId: a.poId, frozenPriceCents: a.unitPriceCents } : null,
          ok ? `${a.poId} is out with the supplier (${a.outstandingQty} outstanding, ${a.receivedQty} arrived): mark "ordered" on it, price locked at its ${a.unitPriceCents}¢.` : `${a.poId} is out with the supplier, but the quantities don't cover the ${qty} needed. ${PERSON}`);
        continue;
      }
      if (a && done.length) {
        ctx.poId = a.poId;
        const ok = received >= qty;
        finding(ctx, "received_never_marked", "hold",
          ok ? { status: "have", poId: null, frozenPriceCents: a.unitPriceCents } : null,
          ok ? `${a.poId} arrived in full (${received} of ${qty} received in all): mark "have" at the price paid on ${a.poId} (${a.unitPriceCents}¢).` : `${a.poId} arrived, but ${received} received doesn't cover the ${qty} needed. ${PERSON}`);
        continue;
      }
      if (claims.length && received >= qty) {
        ctx.poId = claims[claims.length - 1].poId;
        finding(ctx, "need_but_all_arrived", "hold", null, `The list says "need", but all ${qty} already arrived on cancelled purchase orders. ${PERSON}`);
        continue;
      }
      // Agrees: nothing active; remaining = qty − received is what
      // generating a PO from this list orders.
    }
  }

  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const held = findings.filter((f) => f.severity === "hold");
  return {
    findings,
    notes,
    totals: {
      projects: uniq(findings.map((f) => f.projectId)).length,
      materialLists: uniq(findings.map((f) => f.listId)).length,
      purchaseOrders: uniq(findings.flatMap((f) => String(f.poId || "").split(", "))).length,
      lines: findings.length,
      hold: held.length,
      review: findings.length - held.length,
      repairable: findings.filter((f) => f.repairable).length,
      needsAPerson: findings.filter((f) => !f.repairable).length
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
  for (const f of result.findings) {
    out.push("");
    out.push(`[${f.kind}] ${f.severity === "hold" ? "RECORDS DISAGREE" : "REVIEW"} · ${f.repairable ? "repairable by rule" : "needs a person"}`);
    out.push(`  project ${f.projectId || "(none)"} · list ${f.listId}${f.listName ? ` "${f.listName}"` : ""} · line ${f.lineId} (${f.sku})`);
    out.push(`  list line now: ${f.line.status} ×${f.line.qty}${f.line.poId ? ` on ${f.line.poId}` : ""}${f.line.frozenPriceCents != null ? `, price locked ${f.line.frozenPriceCents}¢` : ""}`);
    out.push(`  quantities: needed ${f.quantities.needed} · received ${f.quantities.received} · on order ${f.quantities.onOrder} · still to order ${Math.max(0, f.quantities.remaining - f.quantities.onOrder)}`);
    for (const c of f.claims) {
      out.push(`  ${c.poId} (${c.poStatus}): ordered ${c.qty}, received ${c.receivedQty}, outstanding ${c.outstandingQty}, at ${c.unitPriceCents}¢ each`);
    }
    out.push(`  ${f.repairable ? "repair" : "action"}: ${f.repairText}${f.repair ? `  ${JSON.stringify(f.repair)}` : ""}`);
  }
  if (result.notes.length) {
    out.push("");
    out.push(`For information (${result.notes.length}):`);
    for (const n of result.notes) {
      out.push(n.kind === "source_missing"
        ? `  ${n.poId} (${n.poStatus}) points at list ${n.listId} line ${n.lineId} (${n.sku}), which no longer exists`
        : `  ${n.poId} has ${n.count} lines for list ${n.listId} line ${n.lineId}`);
    }
  }
  return out.join("\n");
}

module.exports = { auditPurchasingLines, formatPurchasingAudit };

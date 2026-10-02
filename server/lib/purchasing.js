"use strict";

// Send, receive and cancel a purchase order — the PO and the material-list
// lines it was ordered for, moved together or not at all (2026-10-02).
//
// Each operation, under the shared purchasing lock (purchasing-store.js):
//   1. reads both files as stored;
//   2. applies the PO transition to a copy — an illegal one throws here,
//      before anything is written;
//   3. works out every affected list line from the PO's resulting state
//      (lineMove, below) — the one rule for what a source line becomes;
//   4. (send only) renders and emails, still holding the lock, so a
//      second click waits and then finds the PO already sent;
//   5. commits both files in one journalled commit.
// Asking for something already done (a repeat receive of the same
// quantities, a repeat cancel) finds nothing to change and writes nothing.
//
// The list side changes ONLY a line's status, poId and frozenPriceCents,
// and only on a line the PO's own line points at (sourceListId +
// sourceLineId) — and, past "sent", only while that line points back at
// this PO. Every other line and every other record is written back
// byte-for-byte. The 2026-09-27 guard in materialLists.update() (no
// wholesale replacement of a bought-from list's lines) is untouched: this
// path never replaces a line array, and nothing else can reach it.

const { withPurchasingLock, commitFiles, PurchasingError, assertNotHeld } = require("./purchasing-store");
const purchaseOrders = require("./purchase-orders");
const materialLists = require("./material-lists");

const PO = purchaseOrders._internal;
const ML = materialLists._internal;

const clone = (v) => JSON.parse(JSON.stringify(v));

function isFullyReceived(poLine) {
  return (Number(poLine.receivedQty) || 0) >= (Number(poLine.qty) || 0);
}

// What one source line becomes, given the PO's state after the event.
// null = leave it exactly as it is.
//   • a fully-received PO line: its source line, ordered on THIS PO, → have
//     (the frozen price stays — it is what was paid);
//   • an outstanding line on a cancelled PO: ordered on THIS PO → need,
//     price lock released, so it can be ordered again;
//   • sending: an outstanding line still "need" and on no PO → ordered on
//     this PO, price frozen at the PO line's price.
// A line ordered on a different PO, or already received, is never moved.
function lineMove(po, poLine, line, event) {
  if (po.status === "draft") return null;
  const onThisPo = line.status === "ordered" && line.poId === po.id;
  if (isFullyReceived(poLine)) return onThisPo ? { status: "have", poId: null } : null;
  if (po.status === "cancelled") return onThisPo ? { status: "need", poId: null, frozenPriceCents: null } : null;
  if (event === "sent" && line.status === "need" && !line.poId) {
    return { status: "ordered", poId: po.id, frozenPriceCents: Number(poLine.unitPriceCents) || 0 };
  }
  return null;
}

// Why a source line was left alone when the PO says it should have moved
// — reported back, never guessed at.
function leftReason(po, poLine, line) {
  if (po.status === "draft") return null;
  const onThisPo = line.status === "ordered" && line.poId === po.id;
  if (isFullyReceived(poLine)) {
    if (line.status === "have") return null;
    return line.status === "ordered" ? `ordered on ${line.poId}` : "still marked need";
  }
  if (po.status === "cancelled") return null;
  if (onThisPo) return null;
  return line.status === "ordered" ? `already ordered on ${line.poId}` : line.status === "have" ? "already received" : "on no purchase order";
}

// Every list line this PO touches, worked out on copies of the stored
// records. Returns the lists to write (changed ones only) and what moved.
function planListMoves(po, listsRaw, event) {
  const working = new Map();          // listId -> { idx, rec (copy), moved }
  const moved = [];
  const notMoved = [];
  for (const poLine of po.lineItems) {
    if (!poLine.sourceListId || !poLine.sourceLineId) continue;
    const idx = listsRaw.findIndex((r) => r && r.id === poLine.sourceListId);
    if (idx === -1) { notMoved.push({ listId: poLine.sourceListId, lineId: poLine.sourceLineId, sku: poLine.sku, reason: "material list not found" }); continue; }
    if (!working.has(poLine.sourceListId)) working.set(poLine.sourceListId, { idx, rec: clone(listsRaw[idx]), moved: 0 });
    const w = working.get(poLine.sourceListId);
    const li = (w.rec.lineItems || []).findIndex((l) => l && l.id === poLine.sourceLineId);
    if (li === -1) { notMoved.push({ listId: w.rec.id, lineId: poLine.sourceLineId, sku: poLine.sku, reason: "line not on the list" }); continue; }
    const line = ML.hydrateLine(w.rec.lineItems[li]);
    const move = lineMove(po, poLine, line, event);
    if (!move) {
      const reason = leftReason(po, poLine, line);
      if (reason) notMoved.push({ listId: w.rec.id, lineId: line.id, sku: line.sku, reason });
      continue;
    }
    // Only the three purchasing fields; everything else on the line stays.
    w.rec.lineItems[li] = { ...w.rec.lineItems[li], ...move };
    w.moved += 1;
    moved.push({ listId: w.rec.id, lineId: line.id, sku: line.sku, from: line.status, to: move.status });
  }
  const changedLists = [];
  for (const w of working.values()) {
    if (!w.moved) continue;
    const prevStatus = ML.hydrate(listsRaw[w.idx]).status;
    const nextStatus = ML.deriveStatus(w.rec.lineItems.map(ML.hydrateLine), prevStatus);
    w.rec.status = nextStatus;
    w.rec.updatedAt = ML.nowIso();
    ML.appendHistory(w.rec, { action: `po_${event}`, note: `${po.id}: ${w.moved} line${w.moved === 1 ? "" : "s"}` });
    if (prevStatus !== nextStatus) ML.appendHistory(w.rec, { action: `status:${nextStatus}`, note: "" });
    changedLists.push(w);
  }
  return { changedLists, moved, notMoved };
}

// Before a send (2026-10-02): every list line the PO claims must still be
// waiting to be ordered — "need", on no PO, with no other live or received
// PO claiming it — or already ordered on THIS PO (a retry). A line on
// another order, or already received, or claimed twice on this PO, refuses
// the whole send before anything is written or emailed, so a send can never
// leave a list line claimed by two orders (purchasing-audit
// multiple_active_claims / have_but_po_outstanding).
function assertLinesOrderable(po, posRaw, listsRaw) {
  const problems = [];
  const seen = new Set();
  for (const pl of po.lineItems) {
    if (!pl.sourceListId || !pl.sourceLineId) continue;
    const key = pl.sourceListId + "|" + pl.sourceLineId;
    if (seen.has(key)) { problems.push(`${pl.sku}: two lines on ${po.id} are for the same list line`); continue; }
    seen.add(key);
    const list = listsRaw.find((r) => r && r.id === pl.sourceListId);
    const raw = list && (list.lineItems || []).find((l) => l && l.id === pl.sourceLineId);
    if (!raw) continue;   // the list line is gone — nothing to keep in step (reported by the audit)
    const line = ML.hydrateLine(raw);
    const mine = line.status === "ordered" && line.poId === po.id;
    if (!mine && !(line.status === "need" && !line.poId)) {
      problems.push(`${pl.sku} on ${list.id}: ${line.status === "ordered" ? `already ordered on ${line.poId}` : line.status === "have" ? "already received" : `marked need but linked to ${line.poId}`}`);
      continue;
    }
    const other = posRaw.find((p) => p && p.id !== po.id && p.status !== "draft" && p.status !== "cancelled" &&
      (p.lineItems || []).some((l) => l && l.sourceListId === pl.sourceListId && l.sourceLineId === pl.sourceLineId));
    if (other) { problems.push(`${pl.sku} on ${list.id}: ${other.id} (${other.status}) is already the order for it`); continue; }
    // Never re-order what already arrived (2026-10-02): once part of a line
    // has been delivered (on a cancelled PO), this order may bring the line
    // up to its quantity and no further. Ordering more than needed with
    // nothing yet delivered (a pack size) is the office's call and allowed.
    const c = purchaseOrders.commitmentsByListLine(posRaw, pl.sourceListId, { excludePoId: po.id }).get(pl.sourceLineId);
    const already = c ? c.received : 0;
    if (already > 0 && already + (Number(pl.qty) || 0) > line.qty) {
      problems.push(`${pl.sku} on ${list.id}: ${already} of ${line.qty} already arrived, so ordering ${pl.qty} more would re-order what came — order at most ${Math.max(0, line.qty - already)}`);
    }
  }
  if (problems.length) {
    throw new PurchasingError(`Can't send ${po.id} — these material-list lines aren't waiting to be ordered: ${problems.join("; ")}. Remove them from this draft, or check the list.`, { status: 409, code: "lines_not_orderable" });
  }
}

// The one commit path for send / receive / cancel.
//   apply(po)            — the PO transition on a copy; throws if illegal
//   beforeCommit(stored, po) — send's render + email; may patch po; runs
//                          only once everything has validated
async function transact(poId, event, apply, beforeCommit = null) {
  return withPurchasingLock(async () => {
    const posRaw = await PO.readRaw();
    const idx = posRaw.findIndex((r) => r && r.id === poId);
    if (idx === -1) return null;
    const stored = PO.hydrate(posRaw[idx]);
    // A recovery hold on this PO or any list it touches: refuse before
    // anything — the state it would build on is unconfirmed.
    assertNotHeld(purchaseOrders.poRefs(stored));
    const po = PO.hydrate(clone(posRaw[idx]));
    const t = apply(po);
    const listsRaw = await ML.readRaw();
    const plan = planListMoves(po, listsRaw, event);
    if (!t.changed && !plan.changedLists.length) {
      return { ...t, po: stored, changed: false, moved: [], notMoved: plan.notMoved };
    }
    if (beforeCommit) await beforeCommit(stored, po);
    for (const w of plan.changedLists) listsRaw[w.idx] = w.rec;
    if (t.changed) posRaw[idx] = po;
    await commitFiles([
      plan.changedLists.length ? { file: materialLists.FILE, after: ML.serialize(listsRaw) } : null,
      t.changed ? { file: purchaseOrders.FILE, after: PO.serialize(posRaw) } : null
    ], { purchaseOrders: [po.id], materialLists: plan.changedLists.map((w) => w.rec.id) });
    return { ...t, po: t.changed ? po : stored, changed: true, moved: plan.moved, notMoved: plan.notMoved };
  });
}

// Sending (2026-10-02). Exactly-once email delivery can't be guaranteed —
// the server can die after the supplier's mail server accepts the message
// and before anything is saved, and nothing here can see past that moment.
// So, as for change requests (2026-09-27), the send is claimed ON DISK
// before the email goes:
//   1. validate the transition and every list line it will move;
//   2. save sendInFlight on the PO (its own commit);
//   3. deliver(draft) — render + email; returns { pdfPath, csvPath };
//   4. save the outcome: sent + the list lines (one commit, clearing the
//      mark), or — if delivery threw — the failed attempt, mark cleared.
// If the process dies anywhere between 2 and 4, the mark survives and the
// next send is refused as delivery_uncertain until the office records
// whether the email went (resolveUncertainPoSend).
//
// The guarantee is exactly this: NO AUTOMATIC duplicate after an
// uncertain delivery — the system never re-sends on its own. It is not
// "at most one email": if the office records "it didn't go" and sends
// again, and the first email had in fact arrived, the supplier has two.
// That is the office's informed choice, and the PO page says so.
async function sendPurchaseOrder(poId, { toEmail, toName, subject, by = "admin" } = {}, deliver = null) {
  return withPurchasingLock(async () => {
    const posRaw = await PO.readRaw();
    const idx = posRaw.findIndex((r) => r && r.id === poId);
    if (idx === -1) return null;
    const stored = PO.hydrate(posRaw[idx]);
    assertNotHeld(purchaseOrders.poRefs(stored));
    const probe = PO.hydrate(clone(posRaw[idx]));
    PO.transitionSent(probe, { toEmail, toName, subject, by });   // throws if it can't be sent
    const listsNow = await ML.readRaw();                           // every list readable
    assertLinesOrderable(probe, posRaw, listsNow);                 // every line still waiting to be ordered
    planListMoves(probe, listsNow, "sent");

    const inFlight = { at: PO.nowIso(), by, to: probe.emailedToEmail };
    const marked = clone(posRaw[idx]);
    marked.sendInFlight = inFlight;
    marked.updatedAt = inFlight.at;
    posRaw[idx] = marked;
    await commitFiles([{ file: purchaseOrders.FILE, after: PO.serialize(posRaw) }],
      { purchaseOrders: [poId], materialLists: purchaseOrders.poRefs(stored).materialLists });

    let docs = {};
    let failure = null;
    if (deliver) {
      try { docs = (await deliver(stored)) || {}; } catch (err) { failure = err; }
    }
    if (failure) {
      const reason = `The email did not go: ${String(failure && failure.message || failure).slice(0, 300)}`;
      await transact(poId, "settle", (po) => {
        po.sendInFlight = null;
        po.sendAttempts = [...(po.sendAttempts || []), { at: PO.nowIso(), by, to: inFlight.to, ok: false, reason }];
        po.updatedAt = PO.nowIso();
        PO.appendHistory(po, { action: "send_failed", note: reason });
        return { changed: true };
      });
      throw new PurchasingError(reason, { status: 502, code: "delivery_failed" });
    }
    return transact(poId, "sent", (po) => PO.transitionSent(po, {
      toEmail, toName, subject, by, inFlight, pdfPath: docs.pdfPath, csvPath: docs.csvPath
    }));
  });
}

// The office's answer to an interrupted send: "sent" (the email did
// arrive — the PO becomes sent, dated when the send started, and its list
// lines are ordered on it, in one commit) or "not_sent" (it did not — the
// PO stays a draft and can be sent). Either way the interrupted attempt
// stays on record. Nothing is emailed here.
async function resolveUncertainPoSend(poId, { outcome, by = "admin", docs = {} } = {}) {
  if (outcome !== "sent" && outcome !== "not_sent") {
    throw new PurchasingError("Say whether the email went: sent or not_sent.", { status: 400, code: "bad_outcome" });
  }
  return transact(poId, outcome === "sent" ? "sent" : "settle", (po) => {
    const f = po.sendInFlight;
    if (!f) throw new PurchasingError("There is no interrupted send to settle.", { status: 409, code: "no_uncertain_send" });
    const settled = { interrupted: true, settledBy: by, settledAt: PO.nowIso() };
    if (outcome === "sent") {
      PO.transitionSent(po, { toEmail: f.to, by: f.by || by, inFlight: f, subject: po.emailSubject || undefined, pdfPath: docs.pdfPath, csvPath: docs.csvPath });
      po.sentAt = f.at || po.sentAt;
      const last = po.sendAttempts[po.sendAttempts.length - 1];
      Object.assign(last, { at: f.at || last.at, reason: `Interrupted send — ${by} confirmed the email arrived`, outcome: "confirmed_delivered", ...settled });
      PO.appendHistory(po, { action: "send_confirmed", by, note: `interrupted send (started ${f.at || "?"}) confirmed DELIVERED by ${by}` });
    } else {
      po.sendInFlight = null;
      po.sendAttempts = [...(po.sendAttempts || []), { at: f.at, by: f.by || by, to: f.to || null, ok: false, reason: `Interrupted send — ${by} confirmed it did not arrive`, outcome: "confirmed_not_delivered", ...settled }];
      po.updatedAt = PO.nowIso();
      PO.appendHistory(po, { action: "send_failed", by, note: `interrupted send (started ${f.at || "?"}) confirmed NOT delivered by ${by}` });
    }
    return { changed: true };
  });
}

async function receivePurchaseOrder(poId, { lineUpdates = null, note = "" } = {}) {
  return transact(poId, "received", (po) => PO.transitionReceived(po, { lineUpdates, note }));
}

async function cancelPurchaseOrder(poId, { reason = "" } = {}) {
  return transact(poId, "cancelled", (po) => PO.transitionCancelled(po, { reason }));
}

// The office releases a recovery hold once it has checked the records
// (purchasing-store.js). Refused while the read-only audit still finds the
// held PO or list disagreeing — that is repaired first, by a person.
async function releaseRecoveryHold({ scope, id = null, note = "", by = "admin" } = {}) {
  const { releaseHold } = require("./purchasing-store");
  const { auditPurchasingLines } = require("./purchasing-audit");
  return withPurchasingLock(async () => {
    const r = auditPurchasingLines({ purchaseOrders: await PO.readRaw(), materialLists: await ML.readRaw() });
    return releaseHold({
      scope, id, note, by,
      stillDisagrees: (h) => {
        const involves = (f) => h.scope === "all" || (h.scope === "material_list" && f.listId === h.id) ||
          (h.scope === "purchase_order" && (String(f.poId || "").split(", ").includes(h.id) || (f.claims || []).some((c) => c.poId === h.id)));
        const hits = r.findings.filter((f) => f.severity === "hold" && involves(f));
        return hits.length ? hits.slice(0, 3).map((f) => `${f.listId} line ${f.lineId} ${f.kind}`).join("; ") : false;
      }
    });
  });
}

module.exports = {
  assertLinesOrderable,
  releaseRecoveryHold,
  sendPurchaseOrder,
  resolveUncertainPoSend,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  lineMove,
  planListMoves,
  PurchasingError
};

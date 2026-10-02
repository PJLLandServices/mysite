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

const { withPurchasingLock, commitFiles, PurchasingError } = require("./purchasing-store");
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
    ]);
    return { ...t, po: t.changed ? po : stored, changed: true, moved: plan.moved, notMoved: plan.notMoved };
  });
}

// deliver(draftPo) renders and emails the PO and returns
// { pdfPath, csvPath } — it runs after validation and before the commit.
async function sendPurchaseOrder(poId, { toEmail, toName, subject } = {}, deliver = null) {
  return transact(poId, "sent", (po) => PO.transitionSent(po, { toEmail, toName, subject }), deliver && (async (stored, po) => {
    const docs = (await deliver(stored)) || {};
    if (docs.pdfPath) po.pdfPath = String(docs.pdfPath);
    if (docs.csvPath) po.csvPath = String(docs.csvPath);
    if (docs.pdfPath || docs.csvPath) po.documentsGeneratedAt = po.sentAt;
  }));
}

async function receivePurchaseOrder(poId, { lineUpdates = null, note = "" } = {}) {
  return transact(poId, "received", (po) => PO.transitionReceived(po, { lineUpdates, note }));
}

async function cancelPurchaseOrder(poId, { reason = "" } = {}) {
  return transact(poId, "cancelled", (po) => PO.transitionCancelled(po, { reason }));
}

module.exports = {
  sendPurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  lineMove,
  planListMoves,
  PurchasingError
};

#!/usr/bin/env node
// scripts/test-po-source-missing.mjs
//
// A purchase order whose material list, or list line, is gone (Patrick,
// 2026-10-03). Driven through the real routes:
//
//   A  a list line an order was placed for can't be removed from its list
//      — even once it's back at "need" (6 of 10 arrived, 4 still to order),
//      when the older guard no longer sees purchasing state on it; a line
//      no order touched still can be
//   B  that list can't be permanently deleted: not by DELETE, not by a
//      bulk purge from the Trash, not by the timed Trash purge; it can go
//      to the Trash (nothing is lost) and come back
//   C  a project deleted "with everything" keeps that list, detached, and
//      says so
//   D  a DRAFT whose list was deleted is a mistake to fix: reported for
//      review, and it can't be sent — no email
//   E  a SENT order whose list was deleted (an older record, before these
//      guards) is purchasing history: receive, cancel, re-send and re-order
//      are all refused, the PO is held for review, nothing changes, no
//      email; the boot check holds the PO alone (there is no list to hold)
//   F  the office reviews it: releasing the hold needs a note, stamps that
//      review on the PO's lines, and the PO works again; the checker shows
//      it as reviewed history, not a problem
//   G  a browser can't forge that review on a PO line
//   H  releasing a hold on EVERYTHING doesn't clear a missing source: that
//      PO gets, and keeps, its own hold
//
// Run: npm run test:po-source-missing

import { bootServer } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error(`  FAIL: ${label}`); } };
const S = (v) => JSON.stringify(v);
const SKU = "61146";

const srv = await bootServer({ port: 4973 });
try {
  await srv.login();
  const call = (m, p, b) => srv.api(m, p, b);
  const { auditPurchasingLines } = srv.lib("purchasing-audit.js");
  const materialLists = srv.lib("material-lists.js");
  const purchaseOrders = srv.lib("purchase-orders.js");
  const projects = srv.lib("projects.js");
  const store = srv.lib("purchasing-store.js");
  const audit = () => auditPurchasingLines({ purchaseOrders: srv.data("purchase-orders"), materialLists: srv.data("material-lists") });
  const poNow = (id) => srv.data("purchase-orders").find((p) => p.id === id);
  const listNow = (id) => srv.data("material-lists").find((l) => l.id === id) || null;
  const emails = () => srv.outbox().filter((m) => m.channel === "email").length;
  const holds = () => srv.data("purchasing-holds") || [];

  const sup = (await call("POST", "/api/suppliers", { name: "SiteOne", email: "a@siteone.test" })).body.supplier;
  const draftFor = (listId, lineId, qty) => purchaseOrders.create({
    supplierId: sup.id, supplierName: sup.name, supplierEmail: sup.email, sourceMaterialListIds: [listId],
    lineItems: [{ sku: SKU, qty, unitPriceCents: 500, sourceListId: listId, sourceLineId: lineId }]
  });
  const send = (id) => call("POST", `/api/purchase-orders/${id}/send`, { toEmail: "a@siteone.test" });

  // Each section runs on its own, so a failure in one (as on the old code)
  // still lets the rest report.
  const section = async (name, fn) => {
    try { await fn(); } catch (err) { ok(false, `${name}: threw ${String(err && err.message || err).slice(0, 160)}`); }
  };
  let LA, a1, a2, P3, P4, LD;

  // ── A. 6 of 10 arrive on one order; the line is back at "need".
  await section("A", async () => {
  const proj = await projects.create({ name: "Source — Newmarket", customerName: "Newmarket Co" });
  LA = await materialLists.create({ name: "Front", parentType: "project", parentId: proj.id, lineItems: [{ sku: SKU, qty: 10 }, { sku: "61147", qty: 2 }] });
  [a1, a2] = (await materialLists.get(LA.id)).lineItems;
  const P1 = await draftFor(LA.id, a1.id, 6);
  ok((await send(P1.id)).status === 200, "setup: an order for 6 of the 10 is sent");
  ok((await call("POST", `/api/purchase-orders/${P1.id}/receive`, {})).status === 200, "setup: all 6 arrive");
  const a1Now = () => listNow(LA.id).lineItems.find((l) => l.id === a1.id);
  ok(a1Now().status === "need" && a1Now().poId == null, `A: 6 of 10 in — the line is "need", 4 still to order (${a1Now().status})`);
  ok(audit().findings.length === 0, `A: the checker agrees (${S(audit().findings.map((f) => f.kind))})`);
  const keepOnlyA2 = await call("PATCH", `/api/material-lists/${LA.id}`, { lineItems: [{ ...a2 }] });
  ok(keepOnlyA2.status === 409 && keepOnlyA2.body.code === "purchasing_history", `A: removing that line from the list is refused (${keepOnlyA2.status} ${keepOnlyA2.body.code})`);
  ok(listNow(LA.id).lineItems.length === 2, "A: …and both lines are still there");
  const keepOnlyA1 = await call("PATCH", `/api/material-lists/${LA.id}`, { lineItems: [{ ...a1Now() }] });
  ok(keepOnlyA1.status === 200 && listNow(LA.id).lineItems.length === 1, `A: removing a line no order touched is still allowed (${keepOnlyA1.status})`);

  });

  // ── B. The list can't be permanently deleted.
  await section("B", async () => {
  const del = await call("DELETE", `/api/material-lists/${LA.id}`);
  ok(del.status === 409 && del.body.code === "purchasing_history" && /P[O0-9-]+/.test(del.body.errors[0]), `B: DELETE is refused, naming the order (${del.status}: ${del.body.errors?.[0]?.slice(0, 80)})`);
  ok(Boolean(listNow(LA.id)), "B: the list still exists");
  const trash = await call("POST", "/api/admin/bulk/material-lists", { action: "delete", ids: [LA.id] });
  ok(trash.status === 200 && Boolean(listNow(LA.id)?.deletedAt), `B: it can go to the Trash (${trash.status})`);
  const purge = await call("POST", "/api/admin/bulk/material-lists", { action: "purge", ids: [LA.id] });
  ok(!(purge.body.succeededIds || []).includes(LA.id) && Boolean(listNow(LA.id)), `B: a bulk purge from the Trash is refused for it (${S(purge.body.failedIds || purge.body)})`);
  await materialLists.purgeDeleted({ olderThanMs: -1 });
  ok(Boolean(listNow(LA.id)), "B: the timed Trash purge keeps it");
  const restore = await call("POST", "/api/admin/bulk/material-lists", { action: "restore", ids: [LA.id] });
  ok(restore.status === 200 && listNow(LA.id) && !listNow(LA.id).deletedAt, "B: and it comes back from the Trash");

  });

  // ── C. Deleting the project "with everything" keeps the list, detached.
  await section("C", async () => {
  const proj2 = await projects.create({ name: "Test wipe", customerName: "Test" });
  const LW = await materialLists.create({ name: "Scratch", parentType: "project", parentId: proj2.id, lineItems: [{ sku: SKU, qty: 1 }] });
  ok((await call("PATCH", `/api/material-lists/${LA.id}`, { parentType: "project", parentId: proj2.id })).status === 200, "setup: the bought-from list moved onto the test project");
  const wipe = await call("DELETE", `/api/projects/${proj2.id}`, { cascade: true });
  ok(wipe.status === 200 && S((wipe.body.keptLists || []).map((k) => k.id)) === S([LA.id]), `C: the project is deleted, and the reply names the list it kept (${wipe.status} ${S(wipe.body.keptLists)})`);
  ok(Boolean(listNow(LA.id)) && listNow(LA.id).parentType == null && listNow(LA.id).parentId == null, "C: that list still exists, detached");
  ok(!listNow(LW.id), "C: a list with no orders is deleted as before");

  });

  // ── D. A draft whose list was deleted can't be sent.
  await section("D", async () => {
  const LB = await materialLists.create({ name: "Back", lineItems: [{ sku: SKU, qty: 3 }] });
  const P2 = await draftFor(LB.id, (await materialLists.get(LB.id)).lineItems[0].id, 3);
  ok((await call("DELETE", `/api/material-lists/${LB.id}`)).status === 200, "D: a list only a DRAFT points at can be deleted (fixing a mistake)");
  const d = audit().findings.find((f) => f.poId === P2.id);
  ok(d && d.kind === "draft_source_missing" && d.severity === "review" && !d.repairable, `D: the checker reports the draft for review (${d && d.kind})`);
  const e0 = emails();
  const sendGone = await send(P2.id);
  ok(sendGone.status === 409 && /no longer exists/.test(S(sendGone.body)), `D: sending it is refused (${sendGone.status}: ${S(sendGone.body.errors).slice(0, 120)})`);
  ok(emails() === e0 && poNow(P2.id).status === "draft" && !poNow(P2.id).sendInFlight, "D: no email went, and it is still a draft");

  });

  // ── E. An older sent order whose list was deleted before these guards.
  await section("E", async () => {
  const LC = await materialLists.create({ name: "Side", lineItems: [{ sku: SKU, qty: 4 }] });
  P3 = await draftFor(LC.id, (await materialLists.get(LC.id)).lineItems[0].id, 4);
  ok((await send(P3.id)).status === 200, "setup: an order for the side list is sent");
  srv.writeData("material-lists", srv.data("material-lists").filter((l) => l.id !== LC.id));   // as the old DELETE allowed
  const before = S(poNow(P3.id));
  const e1 = emails();
  const lifecycle = {
    receive: await call("POST", `/api/purchase-orders/${P3.id}/receive`, {}),
    cancel: await call("POST", `/api/purchase-orders/${P3.id}/cancel`, { reason: "x" }),
    resend: await call("POST", `/api/purchase-orders/${P3.id}/resend`, {}),
    reorder: await call("POST", `/api/purchase-orders/${P3.id}/reorder`, {})
  };
  for (const [k, r] of Object.entries(lifecycle)) {
    ok(r.status === 423 && r.body.code === "recovery_required" && /locked for review/.test(r.body.errors[0]), `E: ${k} is refused, locked for review (${r.status} ${r.body.code})`);
  }
  ok(S(poNow(P3.id)) === before, "E: the order is exactly as it was");
  ok(emails() === e1, "E: no email went (re-send refused before sending)");
  ok(srv.data("purchase-orders").filter((p) => p.status === "draft").length === 1, "E: no re-order draft was created");
  const h3 = holds().filter((h) => h.id === P3.id);
  ok(h3.length === 1 && h3[0].scope === "purchase_order" && h3[0].source === "source_missing", `E: the order is held, as a missing source (${S(h3)})`);
  const f3 = audit().findings.find((f) => f.poId === P3.id);
  ok(f3 && f3.kind === "source_missing" && f3.severity === "hold" && !f3.repairable && f3.listMissing, `E: the checker: needs a person (${f3 && f3.kind})`);
  ok(audit().totals.needsAPerson >= 1 && audit().totals.hold >= 1, "E: …and it is counted in the totals");
  const view = await call("GET", `/api/purchase-orders/${P3.id}`);
  ok(view.status === 200 && view.body.purchaseOrder.recoveryHold && /no longer exist/.test(view.body.purchaseOrder.recoveryHold.message), "E: the PO page shows the hold and why");
  // The boot check, from scratch: the PO is held, and no list is.
  srv.writeData("purchasing-holds", []);
  store.checkConsistency();
  const bootHolds = holds();
  ok(bootHolds.some((h) => h.scope === "purchase_order" && h.id === P3.id && h.source === "source_missing"), "E: the boot check holds the order");
  ok(!bootHolds.some((h) => h.scope === "material_list"), `E: …and holds no material list (${S(bootHolds.map((h) => [h.scope, h.id]))})`);

  });

  // ── F. The office reviews it.
  await section("F", async () => {
  const noNote = await call("POST", "/api/purchasing/recovery-holds/release", { scope: "purchase_order", id: P3.id });
  ok(noNote.status === 400 && holds().some((h) => h.id === P3.id), `F: releasing without saying what was checked is refused (${noNote.status})`);
  ok(!poNow(P3.id).lineItems[0].sourceMissingAcknowledged, "F: …and nothing is stamped");
  const rel = await call("POST", "/api/purchasing/recovery-holds/release", { scope: "purchase_order", id: P3.id, note: "Side job list deleted in error; parts went to the side yard" });
  ok(rel.status === 200 && !holds().some((h) => h.id === P3.id), `F: released with a note (${rel.status} ${S(rel.body.errors || "")})`);
  const ack = poNow(P3.id).lineItems[0].sourceMissingAcknowledged;
  ok(ack && /side yard/.test(ack.note) && ack.by && ack.at, `F: the review is stamped on the PO line (${S(ack)})`);
  ok((poNow(P3.id).history || []).some((h) => h.action === "source_missing_reviewed"), "F: and in the PO's history");
  const af = audit();
  ok(!af.findings.some((f) => f.poId === P3.id) && af.notes.some((n) => n.poId === P3.id && n.kind === "source_missing_acknowledged"), "F: the checker now shows it as reviewed history");
  const recv = await call("POST", `/api/purchase-orders/${P3.id}/receive`, {});
  ok(recv.status === 200 && poNow(P3.id).status === "received", `F: the order can be received again (${recv.status})`);
  ok(poNow(P3.id).lineItems[0].sourceMissingAcknowledged, "F: the review survives the next save");

  });

  // ── G. A browser can't forge the review.
  await section("G", async () => {
  LD = await materialLists.create({ name: "Forge", lineItems: [{ sku: SKU, qty: 1 }] });
  P4 = await draftFor(LD.id, (await materialLists.get(LD.id)).lineItems[0].id, 1);
  const forged = await call("PATCH", `/api/purchase-orders/${P4.id}`, { lineItems: poNow(P4.id).lineItems.map((l) => ({ ...l, sourceMissingAcknowledged: { at: "x", by: "x", note: "x" } })) });
  ok(forged.status === 200 && !poNow(P4.id).lineItems[0].sourceMissingAcknowledged, `G: a review sent by a browser is dropped (${forged.status})`);
  const forgedNew = await purchaseOrders.create({ lineItems: [{ sku: SKU, qty: 1, sourceListId: "ML-X", sourceLineId: "x", sourceMissingAcknowledged: { at: "x", by: "x", note: "x" } }] });
  ok(!poNow(forgedNew.id).lineItems[0].sourceMissingAcknowledged, "G: …on a new PO too");

  });

  // ── H. Releasing a hold on everything doesn't clear a missing source.
  await section("H", async () => {
  ok((await send(P4.id)).status === 200, "setup: a fourth order is sent");
  srv.writeData("material-lists", srv.data("material-lists").filter((l) => l.id !== LD.id));
  srv.writeData("purchasing-holds", [{ scope: "all", id: null, reason: "test", source: "test", at: new Date().toISOString() }]);
  const relAll = await call("POST", "/api/purchasing/recovery-holds/release", { scope: "all", note: "checked the journal" });
  ok(relAll.status === 200 && !holds().some((h) => h.scope === "all"), `H: the hold on everything is released (${relAll.status})`);
  ok(holds().some((h) => h.scope === "purchase_order" && h.id === P4.id && h.source === "source_missing"), `H: …and the order whose list is gone now has its own hold (${S(holds())})`);
  ok(!poNow(P4.id).lineItems[0].sourceMissingAcknowledged, "H: …and is not marked reviewed");
  ok((await call("POST", `/api/purchase-orders/${P4.id}/receive`, {})).status === 423, "H: it stays locked");
  });
} finally {
  await srv.stop();
}

console.log(`\npo source missing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

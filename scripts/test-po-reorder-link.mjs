#!/usr/bin/env node
// scripts/test-po-reorder-link.mjs
//
// A re-order keeps its material-list link (Patrick, 2026-10-02: "A re-order
// losing its material-list link is a lifecycle defect").
//
// Before: purchaseOrders.reorderFrom() built the new PO with
// sourceMaterialListIds: [] and every line's sourceListId/sourceLineId null —
// "re-orders aren't tied to a list". But a job's materials (received, and
// soon ordered) are found THROUGH that link, so parts that arrived on a
// re-order counted nowhere: the job looked short of material it had.
//
// Walked through the real routes — send, receive (partial), cancel,
// re-order, send, receive — on a project's material list:
//   1. the original PO is linked to the list and the project's materials;
//   2. a re-order carries the same list link, on the PO and on each line;
//   3. its receipts count toward the project's received stock;
//   4. sending / receiving / cancelling the re-order moves ONLY the list
//      lines that point at it (the guards on poId still hold);
//   5. a partial receipt then cancellation of the original keeps what
//      arrived and frees the rest;
//   6. an existing re-order saved WITHOUT the link (made before this fix) is
//      left exactly as it is — not guessed, not reassigned.
//
// Run: npm run test:po-reorder-link

import fs from "node:fs";
import path from "node:path";
import { bootServer, j } from "./e2e/lib/journey.mjs";

// Full-length — journey.mjs j() cuts at 300 characters, fine for a
// label, useless for proving two files are identical.
const S = (v) => JSON.stringify(v);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4967 });
try {
  await srv.login();
  const projects = srv.lib("projects.js");
  const materialLists = srv.lib("material-lists.js");
  const purchaseOrders = srv.lib("purchase-orders.js");

  const proj = await projects.create({ name: "Re-order link — Keswick", customerName: "Keswick Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const list = await materialLists.create({
    name: "Front yard", parentType: "project", parentId: proj.id,
    lineItems: [{ sku: "61146", qty: 10 }, { sku: "61147", qty: 4 }]
  });
  const lineOf = async (sku) => (await materialLists.get(list.id)).lineItems.find((l) => l.sku === sku);
  const L1 = await lineOf("61146");
  const L2 = await lineOf("61147");

  // The original PO, exactly as the "generate purchase orders" step writes
  // it (planDraftsFromMaterialList): linked to the list, each line to its
  // source line.
  let p1 = await purchaseOrders.create({
    supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [list.id],
    lineItems: [
      { sku: "61146", qty: 10, unitPriceCents: 1000, lineTotalCents: 10000, sourceListId: list.id, sourceLineId: L1.id, description: "DryConn" },
      { sku: "61147", qty: 4, unitPriceCents: 500, lineTotalCents: 2000, sourceListId: list.id, sourceLineId: L2.id, description: "Part two" }
    ]
  });
  // Every route call is itself a check — on the old code the receive and
  // cancel routes answered 400 — and the walk carries on, so one run shows
  // every step that is wrong.
  const api = async (method, p, body) => {
    const r = await srv.api(method, p, body);
    ok(r.status < 300, `route: ${method} ${p.replace(/PO-\d+-\d+/, "PO")} succeeds (${r.status}${r.status >= 300 ? " " + S(r.body?.errors) : ""})`);
    return r.body || {};
  };
  const materials = async () => api("GET", `/api/projects/${encodeURIComponent(proj.id)}/materials`);
  const stock = async (sku) => (await materials()).stock.find((r) => r.sku === sku) || null;

  // 1. Send the original: the list lines go "ordered" on it.
  p1 = (await api("POST", `/api/purchase-orders/${p1.id}/send`, { toEmail: "orders@siteone.test" })).purchaseOrder;
  ok((await lineOf("61146")).status === "ordered" && (await lineOf("61146")).poId === p1.id, "1: sending the original marks its list lines ordered on it");

  // 5a. A partial receipt: 6 of 10 arrive.
  const p1Line1 = p1.lineItems.find((l) => l.sku === "61146");
  await api("POST", `/api/purchase-orders/${p1.id}/receive`, { lineUpdates: { [p1Line1.id]: 6 } });
  ok((await stock("61146"))?.received === 6, `5: 6 of 10 received count on the project (${(await stock("61146"))?.received})`);
  // 5b. Cancel the rest: what arrived stays, the rest goes back to "need".
  await api("POST", `/api/purchase-orders/${p1.id}/cancel`, { reason: "Supplier short" });
  ok((await stock("61146"))?.received === 6, "5: cancelling keeps the 6 that arrived");
  ok((await lineOf("61146")).status === "need" && (await lineOf("61146")).poId === null && (await lineOf("61147")).status === "need",
    "5: cancelling frees the outstanding lines back to need");

  // 2. Re-order the cancelled PO.
  let p2 = (await api("POST", `/api/purchase-orders/${p1.id}/reorder`)).purchaseOrder || {};
  ok((p2.history || []).length >= 0 && p2.id && p2.id !== p1.id && p2.status === "draft", `2: the re-order is a new draft PO (${p2?.id} ${p2?.status})`);
  ok(S(p2.sourceMaterialListIds) === S([list.id]), `2: the re-order keeps the material-list link (${j(p2.sourceMaterialListIds)})`);
  ok(p2.lineItems.every((l) => l.sourceListId === list.id) &&
     p2.lineItems.find((l) => l.sku === "61146")?.sourceLineId === L1.id &&
     p2.lineItems.find((l) => l.sku === "61147")?.sourceLineId === L2.id,
     `2: …and each line keeps its source line (${j(p2.lineItems.map((l) => [l.sku, l.sourceListId, l.sourceLineId]))})`);
  ok((p2.history || []).some((h) => h.action === "reorder_of" && h.note === p1.id), "2: the re-order still records which PO it came from");
  ok((await materials()).stock.find((r) => r.sku === "61146")?.received === 6, "2: a draft re-order adds no stock");

  // 4. Send the re-order: the freed list lines are ordered on IT.
  p2 = (await api("POST", `/api/purchase-orders/${p2.id}/send`, { toEmail: "orders@siteone.test" })).purchaseOrder || p2;
  ok((await lineOf("61146")).status === "ordered" && (await lineOf("61146")).poId === p2.id, "4: sending the re-order marks the list lines ordered on the re-order");

  // 3. Receive the re-order: its units count toward the project.
  await api("POST", `/api/purchase-orders/${p2.id}/receive`, {});
  const s1 = await stock("61146");
  // The re-order of a cancelled PO asks only for what didn't arrive
  // (2026-10-02): 4 of the 10, not all 10 again.
  ok(p2.lineItems.find((l) => l.sku === "61146")?.qty === 4, `3: the re-order asks only for the 4 that didn't arrive (${p2.lineItems.find((l) => l.sku === "61146")?.qty})`);
  ok(s1?.received === 10 && (s1.receivedFromPoIds || []).includes(p2.id) && (s1.receivedFromPoIds || []).includes(p1.id),
    `3: the project counts the re-order's receipts — 6 + 4 = 10, from both POs (${j(s1 && { received: s1.received, from: s1.receivedFromPoIds })})`);
  ok((await lineOf("61146")).status === "have", "3: receiving the re-order completes the list line");

  // 4b. A second re-order, sent then cancelled before anything arrives,
  // moves only its own lines and adds nothing.
  let p3 = (await api("POST", `/api/purchase-orders/${p1.id}/reorder`)).purchaseOrder || {};
  p3 = (await api("POST", `/api/purchase-orders/${p3.id}/send`, { toEmail: "orders@siteone.test" })).purchaseOrder || p3;
  ok((await lineOf("61146")).status === "have" && (await lineOf("61146")).poId === null,
    "4: sending another re-order does not touch a line already received on the first");
  await api("POST", `/api/purchase-orders/${p3.id}/cancel`, { reason: "Not needed" });
  ok((await stock("61146"))?.received === 10 && (await lineOf("61146")).status === "have",
    "4: cancelling it adds nothing and leaves the received line alone");

  // 7. Two POs from ONE list (two suppliers), sent one after the other, then
  //    the first received in full. On the old code the second send and the
  //    receipt were refused by the 2026-09-27 guard once the list was bought
  //    from — the PO saved, its list lines stuck.
  {
    const list2 = await materialLists.create({ name: "Back yard", parentType: "project", parentId: proj.id,
      lineItems: [{ sku: "61146", qty: 2 }, { sku: "61147", qty: 3 }] });
    const A = (await materialLists.get(list2.id)).lineItems[0];
    const B = (await materialLists.get(list2.id)).lineItems[1];
    const line2 = async (id) => (await materialLists.get(list2.id)).lineItems.find((l) => l.id === id);
    const poA = await purchaseOrders.create({ supplierName: "SiteOne", supplierEmail: "a@siteone.test", sourceMaterialListIds: [list2.id],
      lineItems: [{ sku: "61146", qty: 2, unitPriceCents: 1000, lineTotalCents: 2000, sourceListId: list2.id, sourceLineId: A.id }] });
    const poB = await purchaseOrders.create({ supplierName: "Ewing", supplierEmail: "b@ewing.test", sourceMaterialListIds: [list2.id],
      lineItems: [{ sku: "61147", qty: 3, unitPriceCents: 700, lineTotalCents: 2100, sourceListId: list2.id, sourceLineId: B.id }] });
    await api("POST", `/api/purchase-orders/${poA.id}/send`, { toEmail: "a@siteone.test" });
    await api("POST", `/api/purchase-orders/${poB.id}/send`, { toEmail: "b@ewing.test" });
    ok((await line2(A.id)).poId === poA.id && (await line2(B.id)).status === "ordered" && (await line2(B.id)).poId === poB.id,
      "7: a second PO sent from the same list marks its own line ordered");
    ok((await line2(B.id)).frozenPriceCents === 700, "7: …with that PO's price frozen on it");
    await api("POST", `/api/purchase-orders/${poA.id}/receive`, {});
    ok((await line2(A.id)).status === "have" && (await line2(A.id)).poId === null && (await line2(A.id)).frozenPriceCents === 1000,
      "7: receiving the first in full completes its line and keeps the price paid");
    ok((await line2(B.id)).status === "ordered" && (await line2(B.id)).poId === poB.id, "7: …and leaves the other supplier's line alone");
    // The 2026-09-27 rule still stands for everything else.
    let refused = null;
    try { await materialLists.update(list2.id, { lineItems: [{ sku: "61146", qty: 9 }] }); } catch (e) { refused = e.code; }
    ok(refused === "line_items_locked", `7: replacing a bought-from list's lines wholesale is still refused (${refused})`);
  }

  // 6. A re-order saved before this fix — no link — stays exactly as it is.
  // (Section 7's back-yard list received 2 more of 61146, so the baseline
  // is read here rather than assumed.)
  const before = (await stock("61146"))?.received;
  const legacy = await purchaseOrders.create({
    supplierName: "SiteOne", sourceMaterialListIds: [],
    lineItems: [{ sku: "61146", qty: 3, unitPriceCents: 1000, lineTotalCents: 3000, sourceListId: null, sourceLineId: null }],
    notes: `Re-order of ${p1.id}.`
  });
  const legacyFile = path.join(srv.DATA, "purchase-orders.json");
  {
    const all = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    const r = all.find((x) => x.id === legacy.id);
    r.status = "received";
    r.lineItems[0].receivedQty = 3;
    fs.writeFileSync(legacyFile, JSON.stringify(all, null, 2));
  }
  const s2 = await stock("61146");
  ok(s2?.received === before && before === 12 && !(s2.receivedFromPoIds || []).includes(legacy.id),
    `6: an old re-order with no link is not counted on the job — not guessed from its note (${s2?.received})`);
  const after = await purchaseOrders.get(legacy.id);
  ok(S(after.sourceMaterialListIds) === "[]" && after.lineItems[0].sourceListId === null,
    "6: …and it is not silently reassigned to the list");
} catch (err) {
  failed += 1;
  console.error("  FAIL: crashed —", err && err.stack || err);
} finally {
  await srv.stop();
}

console.log(`\npo re-order link: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-materials-required-ordered.mjs
//
// REQUIRED AND ORDERED on the Materials tab and the Overview (Patrick,
// 2026-10-05). Driven through the real routes.
//
// Required:
//   * one active material list → that list's required units;
//   * several → "Per list — N lists", no project total (a later list may
//     repeat an earlier one's bill of materials); an archived list is not
//     active;
//   * per-part required stays what the tab can state truthfully.
// Ordered — units actually ordered through purchase orders:
//   * sent, partly received and received POs count their quantity;
//   * a draft counts nothing;
//   * a cancelled PO counts only what arrived;
//   * a re-order (which keeps its list link) counts;
//   * the same PO line is never counted twice — a PO linked to two of the
//     job's lists, or by both its own link and its lines, counts once;
//   * another job's PO counts nothing here.
// One server calculation (purchase-orders.lineCommitment), so the
// Materials tab, the Overview and still-to-order can't disagree.
//
// Run: npm run test:materials-required-ordered   (also in build:check)

import { bootServer } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error(`  FAIL: ${label}`); } };
const S = (v) => JSON.stringify(v);

const srv = await bootServer({ port: 4976 });
try {
  await srv.login();
  const call = (m, p, b) => srv.api(m, p, b);
  const projects = srv.lib("projects.js");
  const ml = srv.lib("material-lists.js");
  const pos = srv.lib("purchase-orders.js");
  const proj = await projects.create({ name: "Required/Ordered — Aurora", customerName: "Aurora Co" });
  const other = await projects.create({ name: "Another job", customerName: "Other Co" });
  const tab = async () => (await call("GET", `/api/projects/${proj.id}/materials`)).body;
  const ov = async () => (await call("GET", `/api/projects/${proj.id}/overview`)).body;
  const row = (m, sku) => m.stock.find((r) => r.sku === sku) || null;
  const agree = async (label) => {
    const m = await tab(); const o = await ov();
    ok(S(o.materials.required) === S(m.summary.required) && o.materials.orderedUnits === m.summary.orderedUnits && o.materials.onOrderUnits === m.summary.onOrderUnits,
      `${label}: the Overview shows the Materials tab's own required and ordered (${S(o.materials.required)} / ${o.materials.orderedUnits})`);
    ok(m.summary.orderedUnits === m.stock.reduce((n, r) => n + r.ordered, 0), `${label}: the ordered total is the parts' ordered added once`);
    return m;
  };
  const mkPo = (list, lines, extra = {}) => pos.create({ supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [list.id],
    lineItems: lines.map(([line, qty]) => ({ sku: line.sku, qty, unitPriceCents: 500, sourceListId: list.id, sourceLineId: line.id })), ...extra });
  const send = (po) => call("POST", `/api/purchase-orders/${po.id}/send`, { toEmail: "orders@siteone.test" });

  // ── Required ───────────────────────────────────────────────────────
  let m = await agree("no list");
  ok(m.summary.required.kind === "none" && m.summary.required.display === "None", `no list: Required is "None" (${S(m.summary.required)})`);
  const A = await ml.create({ name: "Front yard", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61146", qty: 10 }, { sku: "405010", qty: 4 }, { sku: "408010", qty: 6 }] });
  const [a1, a2, a3] = (await ml.get(A.id)).lineItems;
  m = await agree("one list");
  ok(m.summary.required.kind === "one_list" && m.summary.required.units === 20 && m.summary.required.display === "20" && /Front yard/.test(m.summary.required.hint),
    `one active list: Required is that list's 20 units (${S(m.summary.required)})`);
  ok(row(m, "61146").required === 10 && row(m, "405010").required === 4, "…and each part's required is the list's");
  const B = await ml.create({ name: "Front yard — redesign", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61146", qty: 12 }, { sku: "1401010", qty: 3 }] });
  m = await agree("two lists");
  ok(m.summary.required.kind === "per_list" && m.summary.required.units === null && m.summary.required.display === "Per list — 2 lists",
    `two active lists: "Per list — 2 lists", no total (${S(m.summary.required)})`);
  ok(row(m, "61146").required === null && row(m, "61146").requiredAmbiguous && S(row(m, "61146").requiredByList.map((r) => r.qty).sort()) === S([10, 12]),
    "…a part on both lists shows both figures, not a sum (10 · 12, never 22)");
  ok(row(m, "405010").required === 4 && row(m, "1401010").required === 3, "…a part on one list still shows that list's figure");
  ok(m.summary.required.units !== 35 && m.summary.required.units !== 20, "…and no project total is invented (not 20 + 15 = 35)");
  await ml.update(B.id, { status: "archived" });
  m = await agree("second list archived");
  ok(m.summary.required.kind === "one_list" && m.summary.required.units === 20, `an archived list is not active: back to one list, 20 (${S(m.summary.required)})`);

  // ── Ordered ────────────────────────────────────────────────────────
  m = await agree("nothing ordered");
  ok(m.summary.orderedUnits === 0, "nothing ordered yet: 0");
  const P1 = await mkPo(A, [[a1, 10]]);
  m = await agree("a draft");
  ok(m.summary.orderedUnits === 0 && row(m, "61146").ordered === 0, `a draft PO counts nothing (${m.summary.orderedUnits})`);
  ok((await send(P1)).status === 200, "setup: the order for 10 is sent");
  m = await agree("sent");
  ok(row(m, "61146").ordered === 10 && row(m, "61146").onOrder === 10 && m.summary.orderedUnits === 10, `sent: 10 ordered, 10 on order (${row(m, "61146").ordered})`);
  const pl1 = (await pos.get(P1.id)).lineItems[0].id;
  ok((await call("POST", `/api/purchase-orders/${P1.id}/receive`, { lineUpdates: { [pl1]: 6 } })).status === 200, "setup: 6 of 10 arrive");
  m = await agree("partly received");
  ok(row(m, "61146").ordered === 10 && row(m, "61146").onOrder === 4 && row(m, "61146").received === 6, `partly received: still 10 ordered (4 on order, 6 received) (${S([row(m, "61146").ordered, row(m, "61146").onOrder, row(m, "61146").received])})`);
  ok((await call("POST", `/api/purchase-orders/${P1.id}/cancel`, { reason: "short" })).status === 200, "setup: the rest is cancelled");
  m = await agree("cancelled after 6");
  ok(row(m, "61146").ordered === 6 && row(m, "61146").onOrder === 0 && row(m, "61146").received === 6, `cancelled: only the 6 that arrived count as ordered (${row(m, "61146").ordered})`);
  const re = await call("POST", `/api/purchase-orders/${P1.id}/reorder`);
  const R1 = re.body && re.body.purchaseOrder;
  ok(re.status === 201 && R1 && R1.lineItems[0].qty === 4, `setup: re-order for the 4 still needed (${re.status} ${R1 && R1.lineItems[0].qty})`);
  m = await agree("re-order drafted");
  ok(row(m, "61146").ordered === 6, "the re-order as a draft counts nothing yet");
  ok((await send(R1)).status === 200, "setup: the re-order is sent");
  m = await agree("re-order sent");
  ok(row(m, "61146").ordered === 10 && S(row(m, "61146").orderedOnPoIds.sort()) === S([P1.id, R1.id].sort()), `the re-order keeps its link and counts: 6 + 4 = 10, from both POs (${S(row(m, "61146").orderedOnPoIds)})`);
  ok((await call("POST", `/api/purchase-orders/${R1.id}/receive`, {})).status === 200, "setup: the 4 arrive");
  m = await agree("re-order received");
  ok(row(m, "61146").ordered === 10 && row(m, "61146").received === 10 && row(m, "61146").onOrder === 0, "received in full: 10 ordered, 10 received");
  // A PO linked to two of the job's lists, and by both its own link and its lines: counted once.
  const C = await ml.create({ name: "Back yard", parentType: "project", parentId: proj.id, lineItems: [{ sku: "405010", qty: 2 }] });
  const [c1] = (await ml.get(C.id)).lineItems;
  const P2 = await pos.create({ supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [A.id, C.id],
    lineItems: [{ sku: "405010", qty: 4, unitPriceCents: 300, sourceListId: A.id, sourceLineId: a2.id }, { sku: "405010", qty: 2, unitPriceCents: 300, sourceListId: C.id, sourceLineId: c1.id }] });
  ok((await send(P2)).status === 200, "setup: one PO for both lists' 405010 (4 + 2) is sent");
  m = await agree("one PO, two lists");
  ok(row(m, "405010").ordered === 6 && S(row(m, "405010").orderedOnPoIds) === S([P2.id]), `one PO linked to two of the job's lists counts each line once: 6, not 12 (${row(m, "405010").ordered})`);
  // A PO whose own list link is missing but whose line names the job's list still belongs here; once.
  const P3 = await pos.create({ supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [],
    lineItems: [{ sku: "408010", qty: 6, unitPriceCents: 410, sourceListId: A.id, sourceLineId: a3.id }] });
  ok((await send(P3)).status === 200, "setup: a PO linked only through its line is sent");
  m = await agree("linked through its line");
  ok(row(m, "408010").ordered === 6, `a PO linked only through its line counts, once (${row(m, "408010").ordered})`);
  // Another job's PO counts nothing here.
  const X = await ml.create({ name: "Other job list", parentType: "project", parentId: other.id, lineItems: [{ sku: "61146", qty: 50 }] });
  const [x1] = (await ml.get(X.id)).lineItems;
  const PX = await mkPo(X, [[x1, 50]]);
  ok((await send(PX)).status === 200, "setup: another job's order for 50 is sent");
  m = await agree("another job's order");
  ok(row(m, "61146").ordered === 10 && m.summary.orderedUnits === 22, `another job's PO doesn't count here (61146 still 10; total 10 + 6 + 6 = 22) (${m.summary.orderedUnits})`);
  // The same arithmetic still-to-order uses.
  const c = pos.commitmentsByListLine(srv.data("purchase-orders"), A.id);
  const viaCommit = [a1, a2, a3].map((l) => (c.get(l.id) || { received: 0, onOrder: 0 })).reduce((n, x) => n + x.received + x.onOrder, 0);
  ok(viaCommit === 10 + 4 + 6, `still-to-order's own figures for the list (received + on order) add to the same ordered units (${viaCommit})`);
  ok(m.summary.receivedUnits === 10 && m.summary.onOrderUnits === 12, `received 10; on order 6 (405010) + 6 (408010) = 12 (${m.summary.receivedUnits} / ${m.summary.onOrderUnits})`);
  // Screens print the server's words.
  const o = await ov();
  ok(o.materials.required.display === "Per list — 2 lists", `with Front yard and Back yard active: "Per list — 2 lists" (${o.materials.required.display})`);
} finally {
  await srv.stop();
}

console.log(`\nmaterials required/ordered: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

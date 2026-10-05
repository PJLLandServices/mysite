#!/usr/bin/env node
// scripts/test-po-remainder-paths.mjs
//
// "Need" after a part-delivered cancellation is safe ONLY if nothing ever
// orders the delivered parts again (Patrick, 2026-10-02). Required 10,
// 6 arrived on a cancelled order, the list line back at "need": every
// path that proposes a quantity must propose exactly 4 — and never 10
// again, however often it is reopened, regenerated or double-clicked.
// Driven through the real routes:
//
//   A  PO generation: plan and generate, assigned supplier and one
//      supplier (both suppliers), reopened and repeated
//   B  re-order of the cancelled PO; again; after a Generate drafted it
//   C  double-clicks on Generate and on Re-order (sent together)
//   D  quote requests (RFQs): plan and generate, assigned and shopped; an
//      RFQ raised for 10 BEFORE the delivery, answered after it; quote
//      comparison; apply the cheapest; the PO made from it orders 4
//   E  the 4 arrive: 10 received in all, the line "have"; nothing more is
//      proposed anywhere
//   F  the send gate: a hand-made order for 10 more is refused
//   G  cancellation and re-order after a quoted purchase: a second list
//      quoted, ordered, cancelled before anything came, re-ordered,
//      3 arrive, cancelled, re-ordered for 7, arrives — 10, "have"
// After every step: the shared classifier (purchasing-audit) finds no
// contradiction.
//
// Run: npm run test:po-remainder-paths

import { bootServer, j } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error(`  FAIL: ${label}`); } };
const S = (v) => JSON.stringify(v);
const SKU = "61146";

const srv = await bootServer({ port: 4972 });
try {
  await srv.login();
  const call = (m, p, b) => srv.api(m, p, b);
  const { auditPurchasingLines } = srv.lib("purchasing-audit.js");
  const materialLists = srv.lib("material-lists.js");
  const projects = srv.lib("projects.js");
  const agrees = (label) => {
    const r = auditPurchasingLines({ purchaseOrders: srv.data("purchase-orders"), materialLists: srv.data("material-lists") });
    const bad = r.findings.filter((f) => f.severity === "hold" || f.kind === "quantity_over");
    ok(bad.length === 0, `${label}: the PO and list agree, nothing ordered twice (${S(r.findings.map((f) => [f.kind, f.sku]))})`);
  };

  // Two suppliers; the part is bought from either.
  const A = (await call("POST", "/api/suppliers", { name: "SiteOne", email: "a@siteone.test" })).body.supplier.id;
  const B = (await call("POST", "/api/suppliers", { name: "Ewing", email: "b@ewing.test" })).body.supplier.id;
  ok((await call("PATCH", `/api/part-suppliers/${SKU}`, { supplierIds: [A, B] })).status === 200, "setup: the part is assigned to both suppliers");
  const proj = await projects.create({ name: "Remainder — Newmarket", customerName: "Newmarket Co" });
  const L = await materialLists.create({ name: "Front", parentType: "project", parentId: proj.id, lineItems: [{ sku: SKU, qty: 10 }] });
  const lineId = (await materialLists.get(L.id)).lineItems[0].id;
  const listLine = (listId = L.id) => srv.data("material-lists").find((l) => l.id === listId).lineItems[0];

  const planQty = async (listId, supplierId) => {
    const r = await call("POST", `/api/material-lists/${listId}/plan-purchase-orders`, supplierId ? { supplierId } : {});
    return (r.body?.previews || []).flatMap((d) => d.lineItems || []).filter((l) => l.sku === SKU).map((l) => l.qty);
  };
  const rfqPlanQty = async (listId, shop) => {
    const r = await call("POST", `/api/material-lists/${listId}/plan-quote-requests${shop ? "?shop=all" : ""}`);
    return (r.body?.previews || []).flatMap((p) => p.lines || []).filter((l) => l.sku === SKU).map((l) => l.quantity);
  };
  const draftsFor = (listId) => srv.data("purchase-orders").filter((p) => p.status === "draft" && (p.sourceMaterialListIds || []).includes(listId));
  const draftedQty = (listId) => draftsFor(listId).flatMap((p) => p.lineItems).filter((l) => l.sku === SKU).reduce((n, l) => n + l.qty, 0);
  const sendPo = (id, email = "a@siteone.test") => call("POST", `/api/purchase-orders/${id}/send`, { toEmail: email });

  // ── D (part 1): an RFQ raised for all 10, BEFORE anything is ordered.
  ok(S(await rfqPlanQty(L.id)) === S([10]), `D: before any order, an RFQ asks for all 10 (${S(await rfqPlanQty(L.id))})`);
  const earlyRfq = (await call("POST", `/api/material-lists/${L.id}/generate-quote-requests`, {})).body?.created?.[0];
  ok(earlyRfq && earlyRfq.lines[0].quantity === 10, "D: the early RFQ is drafted for 10");
  ok((await call("POST", `/api/quote-requests/${earlyRfq.id}/send`, { toEmail: "a@siteone.test" })).status === 200, "D: the early RFQ is sent");

  // The first order: 10, sent; 6 arrive; the rest cancelled.
  const gen1 = await call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, {});
  const P1 = gen1.body?.purchaseOrders?.[0];
  ok(gen1.status === 201 && P1.lineItems[0].qty === 10, `setup: the first order is for 10 (${gen1.status})`);
  ok((await sendPo(P1.id)).status === 200, "setup: sent");
  ok((await call("POST", `/api/purchase-orders/${P1.id}/receive`, { lineUpdates: { [P1.lineItems[0].id]: 6 } })).status === 200, "setup: 6 of 10 arrive");
  ok((await call("POST", `/api/purchase-orders/${P1.id}/cancel`, { reason: "Supplier short" })).status === 200, "setup: the rest is cancelled");
  ok(listLine().status === "need" && listLine().qty === 10, `the list line is "need", quantity 10 (${listLine().status} ×${listLine().qty})`);
  agrees("after the part-delivered cancellation");

  // ── A. PO generation proposes 4 — every way, every time.
  for (let i = 1; i <= 3; i++) {
    ok(S(await planQty(L.id)) === S([4]), `A: plan (assigned), opened ${i}× — proposes 4 (${S(await planQty(L.id))})`);
    ok(S(await planQty(L.id, A)) === S([4]), `A: plan (everything from SiteOne), opened ${i}× — 4`);
    ok(S(await planQty(L.id, B)) === S([4]), `A: plan (everything from Ewing), opened ${i}× — 4`);
  }

  // ── C. Double-click on Generate: one draft for 4, never two.
  const [g1, g2] = await Promise.all([
    call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, {}),
    call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, {})
  ]);
  ok(S([g1.status, g2.status].sort()) === S([201, 422]), `C: two Generates at once — one drafts, one finds nothing to order (${g1.status}, ${g2.status})`);
  ok(draftedQty(L.id) === 4 && draftsFor(L.id).length === 1, `C: exactly one draft, for 4 (${draftedQty(L.id)} on ${draftsFor(L.id).length})`);
  // Reopened and regenerated with the draft in place: nothing more.
  ok(S(await planQty(L.id)) === S([]), `A: with the 4 drafted, the plan proposes nothing (${S(await planQty(L.id))})`);
  ok(S(await planQty(L.id, B)) === S([]), "A: …from either supplier");
  const g3 = await call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, { supplierId: B });
  ok(g3.status === 422 && g3.body?.code === "nothing_to_order", `A: generating again, from the other supplier too, drafts nothing (${g3.status})`);
  // ── B. Re-order of the cancelled PO, with the 4 already drafted: nothing.
  const rr = await call("POST", `/api/purchase-orders/${P1.id}/reorder`);
  ok(rr.status === 409 && draftedQty(L.id) === 4, `B: re-ordering the cancelled PO adds nothing while the 4 are drafted (${rr.status})`);
  // Remove the draft; re-order instead — 4, once; double-click — still once.
  await call("DELETE", `/api/purchase-orders/${draftsFor(L.id)[0].id}`);
  ok(S(await planQty(L.id)) === S([4]), "A: with the draft deleted, the plan proposes 4 again — not 10");
  const [r1, r2] = await Promise.all([call("POST", `/api/purchase-orders/${P1.id}/reorder`), call("POST", `/api/purchase-orders/${P1.id}/reorder`)]);
  ok(S([r1.status, r2.status].sort()) === S([201, 409]), `B/C: two Re-orders at once — one drafts, one finds nothing (${r1.status}, ${r2.status})`);
  ok(draftedQty(L.id) === 4 && draftsFor(L.id).length === 1, `B: the re-order is for 4 (${draftedQty(L.id)})`);
  await call("DELETE", `/api/purchase-orders/${draftsFor(L.id)[0].id}`);
  agrees("after the drafts were removed");

  // ── D (part 2): RFQs ask for 4 now; the early RFQ for 10 can't order 10.
  ok(S(await rfqPlanQty(L.id)) === S([4]), `D: an RFQ planned now asks for 4 (${S(await rfqPlanQty(L.id))})`);
  ok(S(await rfqPlanQty(L.id, true)) === S([4, 4]), `D: shopped to both suppliers — 4 each (${S(await rfqPlanQty(L.id, true))})`);
  const shop = await call("POST", `/api/material-lists/${L.id}/generate-quote-requests`, { shopAll: true });
  const shopRfqs = [...(shop.body?.created || []), ...(shop.body?.refreshed || [])];
  ok(shop.status === 201 && shopRfqs.length === 2 && shopRfqs.every((r) => r.lines[0].quantity === 4), `D: the shopped RFQs are drafted for 4 (${S(shopRfqs.map((r) => r.lines[0].quantity))})`);
  // The early RFQ (asked for 10) is answered now, cheapest.
  const early = srv.data("quote-requests").find((r) => r.id === earlyRfq.id);
  ok((await call("PATCH", `/api/quote-requests/${earlyRfq.id}`, { quotedPrices: { [early.lines[0].id]: 9000 } })).status === 200, "D: the early RFQ's reply is recorded (90.00 each)");
  const cmp = await call("GET", `/api/material-lists/${L.id}/quote-comparison`);
  const row = (cmp.body?.rows || []).find((r) => r.sku === SKU);
  ok(row && row.cheapest?.priceCents === 9000 && row.cheapest?.rfqId === earlyRfq.id, `D: the comparison ranks the unit price (${S(row && row.cheapest)})`);
  const applied = await call("POST", `/api/material-lists/${L.id}/apply-cheapest-quotes`);
  ok(applied.status === 200 && (applied.body?.applied || []).some((a) => a.sku === SKU && a.toCents === 9000), `D: applying the cheapest writes the unit price to the catalog (${applied.status})`);
  ok(srv.data("purchase-orders").filter((p) => p.status !== "cancelled").length === 0 && draftsFor(L.id).length === 0, "D: applying a quote creates no purchase order");
  ok(S(await planQty(L.id)) === S([4]), `D: after applying the quote for 10, the order proposed is still 4 (${S(await planQty(L.id))})`);
  const gq = await call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, {});
  const P2 = gq.body?.purchaseOrders?.[0];
  ok(gq.status === 201 && P2.lineItems[0].qty === 4 && P2.lineItems[0].unitPriceCents === 9000, `D: the PO made from the quote is 4 at the quoted 90.00 (${P2 && S([P2.lineItems[0].qty, P2.lineItems[0].unitPriceCents])})`);
  agrees("after the quoted PO was drafted");

  // ── E. The 4 arrive: 10 in all, "have"; nothing more anywhere.
  ok((await sendPo(P2.id)).status === 200, "E: the order for 4 is sent");
  agrees("with the 4 on order");
  ok(S(await planQty(L.id)) === S([]) && S(await rfqPlanQty(L.id)) === S([]), "E: with the 4 on order, no plan or RFQ proposes more");
  ok((await call("POST", `/api/purchase-orders/${P2.id}/receive`, {})).status === 200, "E: the 4 arrive");
  const mat = await call("GET", `/api/projects/${encodeURIComponent(proj.id)}/materials`);
  const got = (mat.body?.stock || []).find((s) => s.sku === SKU)?.received;
  ok(got === 10, `E: 6 + 4 = 10 received in all (${got})`);
  ok(listLine().status === "have", `E: the list line is "have" (${listLine().status})`);
  agrees("after the 4 arrived");
  ok(S(await planQty(L.id)) === S([]) && S(await rfqPlanQty(L.id)) === S([]), "E: nothing more is proposed by PO or RFQ planning");
  const g4 = await call("POST", `/api/material-lists/${L.id}/generate-purchase-orders`, {});
  ok(g4.status === 422, `E: Generate finds nothing to order (${g4.status})`);
  const r3 = await call("POST", `/api/purchase-orders/${P1.id}/reorder`);
  ok(r3.status === 201 && !(r3.body?.purchaseOrder?.lineItems || []).some((l) => l.sourceLineId === lineId),
    `E: re-ordering the old cancelled PO now is a repeat purchase that claims no list line (${r3.status})`);
  if (r3.body?.purchaseOrder) await call("DELETE", `/api/purchase-orders/${r3.body.purchaseOrder.id}`);

  // ── F. The send gate, whatever made the order. A list still needing the
  // rest, with a hand-made order for the full 10 claiming the line.
  {
    const M = await materialLists.create({ name: "Side", parentType: "project", parentId: proj.id, lineItems: [{ sku: SKU, qty: 10 }] });
    const mLine = (await materialLists.get(M.id)).lineItems[0].id;
    const Q1 = (await call("POST", `/api/material-lists/${M.id}/generate-purchase-orders`, { supplierId: A })).body.purchaseOrders[0];
    await sendPo(Q1.id);
    await call("POST", `/api/purchase-orders/${Q1.id}/receive`, { lineUpdates: { [Q1.lineItems[0].id]: 6 } });
    await call("POST", `/api/purchase-orders/${Q1.id}/cancel`, {});
    const hand = await call("POST", "/api/purchase-orders", { supplierName: "SiteOne", supplierEmail: "a@siteone.test", sourceMaterialListIds: [M.id],
      lineItems: [{ sku: SKU, qty: 10, unitPriceCents: 9000, lineTotalCents: 90000, sourceListId: M.id, sourceLineId: mLine }] });
    const before = S(srv.data("material-lists")) + S(srv.outbox().length);
    const sent = await sendPo(hand.body.purchaseOrder.id);
    ok(sent.status === 409 && sent.body?.code === "lines_not_orderable" && /re-order what came/.test(sent.body?.errors?.[0] || ""),
      `F: a hand-made order for 10 after 6 arrived is refused at send (${sent.status} ${(sent.body?.errors || [])[0]?.slice(0, 90)})`);
    ok(S(srv.data("material-lists")) + S(srv.outbox().length) === before, "F: …before anything is saved or emailed");
    await call("PATCH", `/api/purchase-orders/${hand.body.purchaseOrder.id}`, { lineItems: [{ ...srv.data("purchase-orders").find((p) => p.id === hand.body.purchaseOrder.id).lineItems[0], qty: 4 }] });
    ok((await sendPo(hand.body.purchaseOrder.id)).status === 200, "F: corrected to 4, it sends");
    agrees("after the corrected hand-made order");
  }

  // ── G. Cancellation and re-order after a quoted purchase.
  {
    const N = await materialLists.create({ name: "Back", parentType: "project", parentId: proj.id, lineItems: [{ sku: SKU, qty: 10 }] });
    const nLine = () => srv.data("material-lists").find((l) => l.id === N.id).lineItems[0];
    const rq = (await call("POST", `/api/material-lists/${N.id}/generate-quote-requests`, {})).body.created[0];
    await call("POST", `/api/quote-requests/${rq.id}/send`, { toEmail: "a@siteone.test" });
    const rqRec = srv.data("quote-requests").find((r) => r.id === rq.id);
    await call("PATCH", `/api/quote-requests/${rq.id}`, { quotedPrices: { [rqRec.lines[0].id]: 8500 } });
    await call("POST", `/api/material-lists/${N.id}/apply-cheapest-quotes`);
    const O1 = (await call("POST", `/api/material-lists/${N.id}/generate-purchase-orders`, {})).body.purchaseOrders[0];
    ok(O1.lineItems[0].qty === 10 && O1.lineItems[0].unitPriceCents === 8500, "G: the quoted purchase is 10 at the quoted 85.00");
    await sendPo(O1.id);
    await call("POST", `/api/purchase-orders/${O1.id}/cancel`, { reason: "wrong branch" });
    ok(nLine().status === "need", "G: cancelled before anything came — the line needs all 10");
    const O2 = (await call("POST", `/api/purchase-orders/${O1.id}/reorder`)).body.purchaseOrder;
    ok(O2.lineItems[0].qty === 10, `G: re-ordered — all 10 (${O2.lineItems[0].qty})`);
    await sendPo(O2.id);
    await call("POST", `/api/purchase-orders/${O2.id}/receive`, { lineUpdates: { [O2.lineItems[0].id]: 3 } });
    await call("POST", `/api/purchase-orders/${O2.id}/cancel`, {});
    agrees("G: 3 arrived, then cancelled");
    ok(S(await planQty(N.id)) === S([7]) && S(await rfqPlanQty(N.id)) === S([7]), `G: PO and RFQ planning now propose 7 (${S(await planQty(N.id))} / ${S(await rfqPlanQty(N.id))})`);
    const O3 = (await call("POST", `/api/purchase-orders/${O2.id}/reorder`)).body.purchaseOrder;
    ok(O3.lineItems[0].qty === 7, `G: re-ordering that one asks for the 7 that didn't come (${O3.lineItems[0].qty})`);
    const again = await call("POST", `/api/purchase-orders/${O1.id}/reorder`);
    ok(again.status === 409, `G: re-ordering the FIRST cancelled order too adds nothing — the 7 are drafted (${again.status})`);
    await sendPo(O3.id);
    await call("POST", `/api/purchase-orders/${O3.id}/receive`, {});
    const n = (await call("GET", `/api/projects/${encodeURIComponent(proj.id)}/materials`)).body;
    ok(nLine().status === "have", `G: 3 + 7 = 10 arrived; the line is "have" (${nLine().status})`);
    agrees("G: after the re-ordered 7 arrived");
    ok(S(await planQty(N.id)) === S([]), "G: nothing more proposed");
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: crashed —", err && err.stack || err);
} finally {
  await srv.stop();
}

console.log(`\npo remainder paths: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Quote-request shopping + cheapest-price comparison.
//
// The money question this guards: when the SAME material list is shopped
// to several suppliers, "go with the cheapest" has to actually be the
// cheapest. Applying RFQs one at a time is last-write-wins, so the order
// you happen to click in would otherwise decide the catalog price — and
// the catalog price feeds every material list and every bid built on one.
//
// Pure-logic test: planFromMaterialList and compareQuotes take plain
// arguments and touch no files, so nothing here can reach real data.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const qr = require(path.join(here, "..", "server", "lib", "quote-requests.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const PARTS = {
  AAA: { unit: "each", supplierIds: ["SUP-1"] },
  BBB: { unit: "each", supplierIds: ["SUP-2"] },
  CCC: { unit: "roll", supplierIds: [] }            // deliberately unassigned
};
const LIST = {
  id: "ML-2026-0001",
  lineItems: [
    { id: "l1", sku: "AAA", qty: 10, status: "need" },
    { id: "l2", sku: "BBB", qty: 4,  status: "need" },
    { id: "l3", sku: "CCC", qty: 2,  status: "need" },
    { id: "l4", sku: "AAA", qty: 99, status: "ordered" }   // not a need line
  ]
};

// ---- assigned mode is untouched -----------------------------------------
{
  const p = qr.planFromMaterialList(LIST, PARTS);
  eq("assigned mode still splits by primary supplier", p.groups.map(g => g.supplierId).sort(), ["SUP-1", "SUP-2"]);
  eq("assigned mode still blocks on an unassigned SKU", p.missingSupplier, ["CCC"]);
  check("assigned mode is not ok while a SKU is unassigned", p.ok === false);
  eq("assigned mode reports its mode", p.mode, "assigned");
  const s1 = p.groups.find(g => g.supplierId === "SUP-1");
  eq("assigned mode gives each supplier only its own lines", s1.lines.map(l => l.sku), ["AAA"]);
  check("ordered lines are never quoted", !p.groups.some(g => g.lines.some(l => l.sku === "AAA" && l.quantity === 99)));
}

// ---- shop mode ----------------------------------------------------------
{
  const p = qr.planFromMaterialList(LIST, PARTS, { shopSupplierIds: ["SUP-1", "SUP-2"] });
  eq("shop mode reports its mode", p.mode, "shop");
  check("shop mode is ok even though CCC has no supplier assigned", p.ok === true);
  eq("shop mode blocks nothing", p.missingSupplier, []);
  eq("shop mode asks every supplier", p.groups.map(g => g.supplierId), ["SUP-1", "SUP-2"]);
  for (const g of p.groups) {
    eq(`shop mode sends the WHOLE list to ${g.supplierId}`, g.lines.map(l => l.sku).sort(), ["AAA", "BBB", "CCC"]);
  }
  check("shop mode ignores which supplier the catalog lists",
    p.groups[0].lines.some(l => l.sku === "BBB") && p.groups[1].lines.some(l => l.sku === "AAA"));
  check("each supplier gets its own line objects, not shared references",
    p.groups[0].lines[0] !== p.groups[1].lines[0]);
  eq("quantities survive", p.groups[0].lines.find(l => l.sku === "AAA").quantity, 10);
  check("no price of ours is ever put in an outgoing line",
    p.groups.every(g => g.lines.every(l => l.quotedPriceCents === null && !("unitPriceCents" in l))));
  check("nothing in an outgoing line names a supplier or where it came from",
    p.groups.every(g => g.lines.every(l =>
      Object.keys(l).sort().join(",") === "description,quantity,quotedPriceCents,sku,unit")),
    JSON.stringify(Object.keys(p.groups[0].lines[0]).sort()));
  eq("duplicate supplier ids collapse", 
     qr.planFromMaterialList(LIST, PARTS, { shopSupplierIds: ["SUP-1", "SUP-1"] }).groups.length, 1);
  check("an empty shop list falls back to assigned mode",
    qr.planFromMaterialList(LIST, PARTS, { shopSupplierIds: [] }).mode === "assigned");
  check("a list with no need lines cannot be shopped",
    qr.planFromMaterialList({ id: "ML-X", lineItems: [{ id: "a", sku: "AAA", qty: 1, status: "ordered" }] },
      PARTS, { shopSupplierIds: ["SUP-1"] }).ok === false);
}

// ---- comparison ---------------------------------------------------------
const rfqA = {
  id: "RFQ-2026-0001", supplierId: "SUP-1", supplierName: "Supplier One",
  status: "quoted", sourceMaterialListId: "ML-2026-0001",
  lines: [
    { id: "x1", sku: "AAA", description: "Part A", unit: "each", quantity: 10, quotedPriceCents: 1000 },
    { id: "x2", sku: "BBB", description: "Part B", unit: "each", quantity: 4,  quotedPriceCents: 900 },
    { id: "x3", sku: "CCC", description: "Part C", unit: "roll", quantity: 2,  quotedPriceCents: null }
  ]
};
const rfqB = {
  id: "RFQ-2026-0002", supplierId: "SUP-2", supplierName: "Supplier Two",
  status: "quoted", sourceMaterialListId: "ML-2026-0001",
  lines: [
    { id: "y1", sku: "AAA", description: "Part A", unit: "each", quantity: 10, quotedPriceCents: 800 },
    { id: "y2", sku: "BBB", description: "Part B", unit: "each", quantity: 4,  quotedPriceCents: 1200 },
    { id: "y3", sku: "CCC", description: "Part C", unit: "roll", quantity: 2,  quotedPriceCents: 5000 }
  ]
};
{
  const c = qr.compareQuotes([rfqA, rfqB], { listId: "ML-2026-0001" });
  const bySku = Object.fromEntries(c.rows.map(r => [r.sku, r]));
  eq("the cheapest AAA is Supplier Two", bySku.AAA.cheapest.supplierName, "Supplier Two");
  eq("the cheapest AAA price", bySku.AAA.cheapest.priceCents, 800);
  eq("the cheapest BBB is Supplier One", bySku.BBB.cheapest.supplierName, "Supplier One");
  check("the winner is not simply the last RFQ recorded",
    bySku.AAA.cheapest.rfqId !== bySku.BBB.cheapest.rfqId,
    "different suppliers should win different SKUs");
  eq("a SKU only one supplier answered has no comparison", bySku.CCC.comparable, false);
  eq("but its single quote is still the cheapest known", bySku.CCC.cheapest.priceCents, 5000);
  eq("spread is per unit", bySku.AAA.spreadCents, 200);
  eq("saving is spread x quantity", bySku.AAA.savingCents, 2000);
  check("rows are ordered by what the choice is worth", c.rows[0].sku === "AAA", c.rows[0].sku);
  eq("only answered RFQs are considered", c.rfqs.map(r => r.id).sort(), ["RFQ-2026-0001", "RFQ-2026-0002"]);
}
{
  const draft = { ...rfqA, id: "RFQ-2026-0003", status: "draft" };
  const cancelled = { ...rfqB, id: "RFQ-2026-0004", status: "cancelled",
    lines: rfqB.lines.map(l => ({ ...l, quotedPriceCents: 1 })) };
  const c = qr.compareQuotes([rfqA, rfqB, draft, cancelled], { listId: "ML-2026-0001" });
  check("a draft carries no reply and is ignored", !c.rfqs.some(r => r.id === "RFQ-2026-0003"));
  check("a withdrawn quote cannot win", !c.rfqs.some(r => r.id === "RFQ-2026-0004"));
  eq("so the cheapest AAA is unchanged", c.rows.find(r => r.sku === "AAA").cheapest.priceCents, 800);
}
{
  const other = { ...rfqB, id: "RFQ-2026-0009", sourceMaterialListId: "ML-2026-0002",
    lines: rfqB.lines.map(l => ({ ...l, quotedPriceCents: 1 })) };
  const c = qr.compareQuotes([rfqA, other], { listId: "ML-2026-0001" });
  eq("a quote for a different material list never leaks in",
    c.rows.find(r => r.sku === "AAA").cheapest.priceCents, 1000);
}
{
  const tieA = { ...rfqA, lines: [{ id: "t1", sku: "AAA", quantity: 1, quotedPriceCents: 500 }] };
  const tieB = { ...rfqB, lines: [{ id: "t2", sku: "AAA", quantity: 1, quotedPriceCents: 500 }] };
  const c = qr.compareQuotes([tieA, tieB], { listId: "ML-2026-0001" });
  eq("a tie keeps the first supplier rather than flapping", c.rows[0].cheapest.supplierId, "SUP-1");
  eq("a tie is worth nothing", c.rows[0].savingCents, 0);
}
{
  const applied = { ...rfqA, status: "applied" };
  const c = qr.compareQuotes([applied, rfqB], { listId: "ML-2026-0001" });
  check("an already-applied quote still counts — its prices were real",
    c.rows.find(r => r.sku === "BBB").cheapest.rfqId === "RFQ-2026-0001");
}
{
  eq("no quotes at all is an empty comparison, not a crash",
    qr.compareQuotes([], { listId: "ML-X" }).rows.length, 0);
  eq("garbage in is an empty comparison", qr.compareQuotes(null).rows.length, 0);
}

console.log(`\nrfq shopping: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

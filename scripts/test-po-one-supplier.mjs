#!/usr/bin/env node
// Generate purchase orders — one order to one supplier vs the split.
//
// The money question this guards: grouping a material list by each part's
// assigned supplier splits one shopping trip across two branches, and both
// suppliers' volume discounts are all-or-nothing (SiteOne's $290 job
// credit, Central Pro's $176.20 order discount, Sept 2026). A split order
// can therefore cost MORE than buying the lot at the dearer branch, and
// the old dialog gave no way to say "put it all on one PO".
//
// Every assertion about one-supplier mode fails against the old
// planDraftsFromMaterialList, which took no options, always grouped by
// part.supplierIds[0], and always blocked on an unassigned SKU.
//
// Pure-logic test: planDraftsFromMaterialList takes plain arguments and
// touches no files.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const po = require(path.join(here, "..", "server", "lib", "purchase-orders.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const SITEONE = "SUP-002";
const CENTRAL = "SUP-001";

// Real shape of the Sept 2026 list: some parts assigned to each branch,
// both suppliers' prices on file, and one SKU nobody is assigned to.
const PARTS = {
  SSC8712:  { sku: "SSC8712",  unit: "each", priceCents: 167, supplierIds: [SITEONE, CENTRAL],
              supplierPrices: { [SITEONE]: { priceCents: 167 }, [CENTRAL]: { priceCents: 63 } } },
  "207CD500": { sku: "207CD500", unit: "spool", priceCents: 29741, supplierIds: [CENTRAL, SITEONE],
              supplierPrices: { [CENTRAL]: { priceCents: 29741 }, [SITEONE]: { priceCents: 21400 } } },
  ODDBALL:  { sku: "ODDBALL",  unit: "each", priceCents: 500, supplierIds: [] }   // deliberately unassigned
};
const LIST = {
  id: "ML-2026-0015",
  name: "Dundalk",
  lineItems: [
    { id: "l1", sku: "SSC8712",  qty: 150, status: "need" },
    { id: "l2", sku: "207CD500", qty: 2,   status: "need" },
    { id: "l3", sku: "ODDBALL",  qty: 1,   status: "need" }
  ]
};

// ---- Split mode (the old behaviour, unchanged) -----------------------
{
  const plan = po.planDraftsFromMaterialList(LIST, PARTS);
  eq("split makes one draft per supplier", plan.drafts.length, 2);
  eq("unassigned SKU still blocks the split", plan.missingSupplier, ["ODDBALL"]);
  check("split is not generatable while a SKU is unassigned", plan.ok === false);
  const siteone = plan.drafts.find((d) => d.supplierId === SITEONE);
  const central = plan.drafts.find((d) => d.supplierId === CENTRAL);
  eq("clamps go to their primary (SiteOne)", siteone.lineItems.map((l) => l.sku), ["SSC8712"]);
  eq("wire goes to its primary (Central)", central.lineItems.map((l) => l.sku), ["207CD500"]);
  eq("split prices off the catalog", siteone.lineItems[0].unitPriceCents, 167);
}

// ---- One order, all from Central Pro ---------------------------------
{
  const plan = po.planDraftsFromMaterialList(LIST, PARTS, { forceSupplierId: CENTRAL });
  eq("one supplier means one draft", plan.drafts.length, 1);
  eq("that draft is the chosen supplier's", plan.drafts[0].supplierId, CENTRAL);
  eq("every need line is on it", plan.drafts[0].lineItems.map((l) => l.sku).sort(), ["207CD500", "ODDBALL", "SSC8712"]);
  // The unassigned SKU is no longer a blocker: the supplier was named.
  eq("naming the supplier clears the blocker", plan.missingSupplier, []);

  // Priced from CENTRAL'S quote, not the catalog price (which is the
  // primary supplier's and would be SiteOne's money on a Central order).
  const clamp = plan.drafts[0].lineItems.find((l) => l.sku === "SSC8712");
  eq("clamp priced from Central's quote", clamp.unitPriceCents, 63);
  eq("clamp line total follows", clamp.lineTotalCents, 63 * 150);
  const wire = plan.drafts[0].lineItems.find((l) => l.sku === "207CD500");
  eq("wire priced from Central's quote", wire.unitPriceCents, 29741);

  // A line this supplier never quoted falls back to the catalog price and
  // is named, so the dialog can warn before the total is trusted.
  const odd = plan.drafts[0].lineItems.find((l) => l.sku === "ODDBALL");
  eq("unquoted line falls back to catalog price", odd.unitPriceCents, 500);
  eq("unquoted line is reported", plan.unpricedForSupplier, ["ODDBALL"]);
}

// ---- One order, all from SiteOne -------------------------------------
{
  const plan = po.planDraftsFromMaterialList(LIST, PARTS, { forceSupplierId: SITEONE });
  eq("SiteOne gets a single draft", plan.drafts.length, 1);
  const clamp = plan.drafts[0].lineItems.find((l) => l.sku === "SSC8712");
  const wire = plan.drafts[0].lineItems.find((l) => l.sku === "207CD500");
  eq("clamp at SiteOne's price", clamp.unitPriceCents, 167);
  eq("wire at SiteOne's price", wire.unitPriceCents, 21400);
  // Same list, same quantities, different branch — the totals really do
  // differ, which is the whole reason the choice exists.
  const total = plan.drafts[0].subtotalCents;
  const centralTotal = po.planDraftsFromMaterialList(LIST, PARTS, { forceSupplierId: CENTRAL }).drafts[0].subtotalCents;
  check("the two suppliers' totals differ", total !== centralTotal, `both ${total}`);
}

// ---- Lines that aren't "need" are never ordered ----------------------
{
  const ordered = { ...LIST, lineItems: LIST.lineItems.map((l) => ({ ...l, status: "have" })) };
  const plan = po.planDraftsFromMaterialList(ordered, PARTS, { forceSupplierId: CENTRAL });
  eq("nothing to order when no line is need", plan.drafts.length, 0);
}

console.log(`po one-supplier: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Parts picker rows — one row per real fitting, and the default part
// decides everything the row shows and adds (P-PJL-35 M2a, FLOW-48).
//
// Patrick's rules, pinned:
//   - Part numbers linked as the same fitting (verified) are ONE row.
//     A member waiting for review, or hidden after an edit, stays separate.
//   - The row's description, part #, price, supplier chip and main Add
//     come from the fitting's DEFAULT part; switching the default switches
//     all of them. The price is never simply the cheapest.
//   - Every supplier offer is listed. Only an offer that adding its part #
//     really reaches can be added; a different supplier for the same part #
//     is disabled with "Supplier selection coming next" (material-list
//     lines and PO routing are unchanged in M2a). Archived → not addable.
//   - Search finds the row by any member's part # or any supplier's #.
//
// Uses the SAME file the browser loads (server/picker-rows.js).
//
// Run: node scripts/test-picker-rows.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let PR;
try { PR = require(path.join(ROOT, "server", "picker-rows.js")); }
catch (err) { console.log(`FAIL  server/picker-rows.js could not be loaded: ${err.message}`); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const SITEONE = "SUP-002", CENTRAL = "SUP-001", OLD = "SUP-009";
const SUPPLIERS = {
  [SITEONE]: { id: SITEONE, name: "SiteOne Landscape Supply", shortName: "SiteOne", archived: false, logo: { hash: "a".repeat(64) } },
  [CENTRAL]: { id: CENTRAL, name: "Central Pro Supply", shortName: "Central", archived: false, logo: null },
  [OLD]: { id: OLD, name: "Old Supply Co", shortName: "", archived: true, logo: null }
};
const photo = (groupId, defaultSku, chosen = false) => ({ groupId, fittingDefaultSku: defaultSku, fittingDefaultChosen: chosen, thumb: "/t.webp" });

// The production case: the same Hunter Pro-Spray 12" under SiteOne's and
// Central's numbers, linked as one fitting.
function catalog(defaultSku = "HSPROS12SIPRS30") {
  return [
    { sku: "HSPROS12SIPRS30", partNumber: "HSPROS12SIPRS30", description: "Hunter Pro-Spray 12\" pop PRS w/ side inlet", size: "12\"", category: "sprinkler_heads",
      priceCents: 2331, unit: "each", supplierIds: [SITEONE], supplierPrices: { [SITEONE]: { priceCents: 2331, supplierSku: "HSPROS12SIPRS30" } },
      photoState: "verified", photo: photo("PG-0001", defaultSku) },
    { sku: "PROS12SIPRS30", partNumber: "PROS12SIPRS30", description: "Hunter 12 in. Spray 30 PSI Press Regulated w/ Side Inlet", size: "12\"", category: "sprinkler_heads",
      priceCents: 2339, unit: "each", supplierIds: [CENTRAL], supplierPrices: { [CENTRAL]: { priceCents: 2339, supplierSku: "PROS-12-SI-PRS30" } },
      photoState: "verified", photo: photo("PG-0001", defaultSku) },
    // A single part number carried by two suppliers (one SKU, alternate supplier).
    { sku: "405010", partNumber: "405010", description: "PVC tee 1\" FxFxF", size: "1\"", category: "fittings",
      priceCents: 285, unit: "each", supplierIds: [SITEONE, CENTRAL], supplierPrices: { [SITEONE]: { priceCents: 285 }, [CENTRAL]: { priceCents: 262, supplierSku: "CT-405010" } },
      photoState: "none", photo: null },
    // Linked to the Pro-Spray fitting but edited since → NOT merged.
    { sku: "PROS12SIPRS30X", partNumber: "PROS12SIPRS30X", description: "Hunter Pro-Spray 12 (edited)", category: "sprinkler_heads",
      priceCents: 2400, unit: "each", supplierIds: [OLD], supplierPrices: {}, photoState: "changed", photo: null },
    { sku: "VB7081101", partNumber: "VB7081101", description: "Valve box 7\" round", category: "valves",
      priceCents: 1275, unit: "each", supplierIds: [], supplierPrices: {}, photoState: "none", photo: null }
  ];
}

// ---- 1. One row per fitting ---------------------------------------------------
{
  const rows = PR.buildRows(catalog());
  const fit = rows.find((r) => r.groupId === "PG-0001");
  check("rows: the two Pro-Spray part numbers are ONE row", fit && fit.members.length === 2 && rows.filter((r) => r.groupId === "PG-0001").length === 1);
  check("rows: 5 parts → 4 rows (the fitting counted once)", rows.length === 4, String(rows.length));
  check("rows: an edited member (photo hidden) stays its own row", rows.some((r) => r.key === "sku:PROS12SIPRS30X"));
  check("rows: a part with no photo is its own row", rows.some((r) => r.key === "sku:405010"));
}

// ---- 2. The default part decides the row ---------------------------------------
{
  const a = PR.buildRows(catalog("HSPROS12SIPRS30")).find((r) => r.groupId === "PG-0001");
  check("default: SiteOne's part is shown when it's the default", a.defaultPart.sku === "HSPROS12SIPRS30" && a.defaultPart.priceCents === 2331);
  check("default: the default part is listed first", a.members[0].sku === "HSPROS12SIPRS30");
  const b = PR.buildRows(catalog("PROS12SIPRS30")).find((r) => r.groupId === "PG-0001");
  check("default switched: description switches", b.defaultPart.description.startsWith("Hunter 12 in."));
  check("default switched: part # switches (main Add adds this)", b.defaultPart.sku === "PROS12SIPRS30");
  check("default switched: price switches to that part's", b.defaultPart.priceCents === 2339);
  const chipA = PR.chipFor(a, SUPPLIERS), chipB = PR.chipFor(b, SUPPLIERS);
  check("default switched: the chip follows the default part's supplier", chipA.supplierId === SITEONE && chipB.supplierId === CENTRAL);
  check("chip: '+1' — one other supplier behind the fitting", chipA.more === 1 && chipB.more === 1);
  // The price shown is the default part's even when another is cheaper.
  const cheaperElsewhere = catalog("PROS12SIPRS30");
  cheaperElsewhere[0].priceCents = 100; // SiteOne's part is now much cheaper
  const c = PR.buildRows(cheaperElsewhere).find((r) => r.groupId === "PG-0001");
  check("price: never the cheapest — the default part's price", c.defaultPart.priceCents === 2339);
}

// ---- 3. Offers ---------------------------------------------------------------
{
  const fit = PR.buildRows(catalog()).find((r) => r.groupId === "PG-0001");
  const offers = PR.offersFor(fit, SUPPLIERS);
  const so = offers.find((o) => o.supplierId === SITEONE), ce = offers.find((o) => o.supplierId === CENTRAL);
  check("offers: one per supplier across the fitting's part numbers", offers.length === 2);
  check("offers: SiteOne's is the Default and can be added (adds its part #)", so.isDefault && so.canAdd && so.sku === "HSPROS12SIPRS30");
  check("offers: Central's can be added — it adds Central's own part #", ce.canAdd && !ce.isDefault && ce.sku === "PROS12SIPRS30" && ce.priceCents === 2339);
  check("offers: each keeps its own supplier part #", ce.supplierSku === "PROS-12-SI-PRS30");

  const tee = PR.buildRows(catalog()).find((r) => r.key === "sku:405010");
  const t = PR.offersFor(tee, SUPPLIERS);
  const alt = t.find((o) => o.supplierId === CENTRAL);
  check("offers: same part #, alternate supplier → shown with its price", alt && alt.priceCents === 262 && alt.supplierSku === "CT-405010");
  check("offers: …but its Add is disabled: 'Supplier selection coming next'", alt.canAdd === false && alt.reason === "Supplier selection coming next");
  check("offers: the part's own default supplier can be added", t.find((o) => o.supplierId === SITEONE).canAdd === true);
  check("offers: no internal milestone name reaches the interface", !JSON.stringify(t).includes("M2"));

  const edited = PR.buildRows(catalog()).find((r) => r.key === "sku:PROS12SIPRS30X");
  const e = PR.offersFor(edited, SUPPLIERS)[0];
  check("offers: an archived supplier is shown but not addable", e.canAdd === false && e.reason === "Supplier archived");
  const vb = PR.offersFor(PR.buildRows(catalog()).find((r) => r.key === "sku:VB7081101"), SUPPLIERS);
  check("offers: a part with no supplier can still be added, as today", vb.length === 1 && vb[0].canAdd && vb[0].supplierId === null);
  check("chip: no supplier → no chip supplier", PR.chipFor(PR.buildRows(catalog()).find((r) => r.key === "sku:VB7081101"), SUPPLIERS).supplierId === null);
}

// ---- 4. Search and in-list --------------------------------------------------------
{
  const rows = PR.buildRows(catalog());
  const hits = (q) => rows.filter((r) => PR.rowMatches(r, q)).map((r) => r.key);
  check("search: SiteOne's part # finds the fitting", hits("HSPROS12").includes("fit:PG-0001"));
  check("search: Central's part # finds the SAME row", hits("PROS12SIPRS30").filter((k) => k === "fit:PG-0001").length === 1);
  check("search: a supplier's own # finds it", hits("PROS-12-SI").includes("fit:PG-0001"));
  check("search: words across members all count", hits("pro-spray 12").includes("fit:PG-0001"));
  const fit = rows.find((r) => r.groupId === "PG-0001");
  check("in list: counts every part # in the fitting", PR.qtyInList(fit, [{ sku: "HSPROS12SIPRS30", qty: 2 }, { sku: "PROS12SIPRS30", qty: 3 }, { sku: "405010", qty: 9 }]) === 5);
  check("monogram: two words → two letters", PR.monogram({ name: "Central Pro Supply" }) === "CP" && PR.monogram({ shortName: "SiteOne" }) === "S");
}

console.log(`\ntest-picker-rows: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

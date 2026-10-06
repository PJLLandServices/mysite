#!/usr/bin/env node
// scripts/test-part-merged-into.mjs
//
// ONE PHYSICAL PART, ONE CATALOG RECORD (Patrick, 2026-10-05 — Step B of
// the duplicate-fittings work).
//
// 45 fittings exist twice: "405007" (hand-entered, Central) and "405-007"
// (SiteOne import). The duplicate is RETIRED behind a reversible marker,
// never deleted: lib/parts.js `merged` + canonicalSku(), published through
// lib/part-alias so every door answers the same way.
//
// What this file proves (his list):
//   1. B does not appear as a separate picker row;
//   2. searching B finds A;
//   3. a stale add of B resolves to A;
//   4. an import of B updates A's supplier offer and never recreates B;
//   5. creating a part with a retired number is refused;
//   6. the System Builder resolves aliases;
//   7. PO generation from A uses the chosen supplier's own part number;
//   8. historical records are untouched;
// plus: the merge is reversible, chains are refused, a merge target can't
// be deleted, and no catalog data is migrated by this change.
//
// Against the pre-change code: mergeInto / canonicalSku / part-alias do not
// exist and every section fails.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const attempt = async (fn) => { try { return { value: await fn() }; } catch (err) { return { err }; } };

const CP = "SUP-001", SO = "SUP-002";
const A = "405007", B = "405-007";
const BASE = {
  [A]: { sku: A, partNumber: A, category: "fittings", subcategory: "PVC Tee", size: "0.75\"", description: "PVC tee 0.75\" FxFxF", priceCents: 410, unit: "each", supplierIds: [] },
  "408007": { sku: "408007", partNumber: "408007", category: "fittings", subcategory: "PVC Elbow", size: "0.75\"", description: "PVC elbow 0.75\" 90° FxF", priceCents: 131, unit: "each", supplierIds: [] }
};
const B_RECORD = { sku: B, partNumber: B, category: "fittings", subcategory: "PVC Tee", size: "0.75\"", description: "Tee PVC 3/4 in. Fipt", priceCents: 276, unit: "each" };

fs.mkdirSync(DATA, { recursive: true });
const FILES = ["parts-overrides.json", "material-lists.json", "part-supplier-prices.json", "part-suppliers.json", "purchase-orders.json", "quote-requests.json"];
const backups = Object.fromEntries(FILES.map((f) => [f, fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f)) : null]));
const read = (f) => (fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f), "utf8") : null);

try {
  for (const f of FILES) if (fs.existsSync(path.join(DATA, f))) fs.rmSync(path.join(DATA, f));
  let partsLib, partAlias, partSuppliers, partPrices, ml, po, PR, format;
  try {
    partsLib = require(path.join(ROOT, "server", "lib", "parts.js"));
    partAlias = require(path.join(ROOT, "server", "lib", "part-alias.js"));
    partSuppliers = require(path.join(ROOT, "server", "lib", "part-suppliers.js"));
    partPrices = require(path.join(ROOT, "server", "lib", "part-supplier-prices.js"));
    ml = require(path.join(ROOT, "server", "lib", "material-lists.js"));
    po = require(path.join(ROOT, "server", "lib", "purchase-orders.js"));
    PR = require(path.join(ROOT, "server", "picker-rows.js"));
    format = require(path.join(ROOT, "server", "lib", "format.js"));
  } catch (err) { ok("the modules load (lib/part-alias.js exists)", false, err.message); throw err; }
  const has = typeof partsLib.mergeInto === "function" && typeof partsLib.canonicalSku === "function";
  ok("the rule exists once: parts.mergeInto / unmerge / canonicalSku, published through part-alias", has && typeof partsLib.unmerge === "function" && typeof partAlias.canonical === "function");
  if (!has) throw new Error("pre-change code");

  // The effective catalog, built the way server.js builds it.
  const effective = async () => {
    const ov = await partsLib.readOverrides();
    const parts = partsLib.mergeOverrides(BASE, ov);
    partSuppliers.mergeIntoCatalog(parts, await partSuppliers.getAll());
    partPrices.mergeIntoCatalog(parts, JSON.parse(read("part-supplier-prices.json") || "{}"), { editedMap: ov.edited || {} });
    partAlias.publish(partsLib.aliasMap(ov));
    return parts;
  };

  // ---- Before: two records, as production has them today ------------------
  await partsLib.addOne(BASE, B_RECORD, {});
  await partSuppliers.bulkSet({ [A]: [CP], [B]: [SO] });
  let parts = await effective();
  ok("before: A and B are two catalog parts with one supplier each", !!parts[A] && !!parts[B] && parts[A].supplierIds.join() === CP && parts[B].supplierIds.join() === SO);

  // History that must never move: a list with a purchased line for A, written as the PO flow leaves it.
  const hist = await ml.create({ name: "History", lineItems: [{ id: "li_h", sku: A, qty: 15 }] });
  {
    const all = JSON.parse(read("material-lists.json"));
    const rec = all.find((r) => r.id === hist.id);
    rec.lineItems[0] = { ...rec.lineItems[0], status: "ordered", poId: "PO-HIST", frozenPriceCents: 410 };
    rec.status = "in_progress";
    fs.writeFileSync(path.join(DATA, "material-lists.json"), JSON.stringify(all, null, 2));
  }
  fs.writeFileSync(path.join(DATA, "purchase-orders.json"), JSON.stringify([{ id: "PO-HIST", status: "sent", supplierId: CP, lineItems: [{ id: "poli_1", sku: A, qty: 15, description: "PVC tee 0.75\" FxFxF", unitPriceCents: 410, sourceListId: hist.id, sourceLineId: "li_h" }] }], null, 2));
  fs.writeFileSync(path.join(DATA, "quote-requests.json"), JSON.stringify([{ id: "RFQ-HIST", status: "applied", supplierId: SO, lines: [{ id: "rfqli_1", sku: A, description: "PVC tee 0.75\" FxFxF", quantity: 15, unit: "each", quotedPriceCents: 276 }] }], null, 2));
  const histBefore = { ml: read("material-lists.json"), po: read("purchase-orders.json"), rfq: read("quote-requests.json") };

  // ---- The fold + retire, as the migration will do it ----------------------
  // (supplier offer and supplier assignment are their own stores; mergeInto writes only the marker)
  await partPrices.recordSupplierPrices(SO, { [A]: { priceCents: 276, supplierSku: B } }, { source: "merged from " + B, at: "2026-09-12T00:00:00.000Z" });
  await partSuppliers.bulkSet({ [A]: [CP, SO] });
  const overridesBefore = read("parts-overrides.json");
  const marker = await partsLib.mergeInto(BASE, B, A, { by: "Patrick Lalande", supplierId: SO });
  const overridesAfterMerge = read("parts-overrides.json");
  parts = await effective();

  console.log("1-2. picker");
  ok("the marker is reversible: it keeps where B went, whose number it is, and B's whole record", marker.into === A && marker.supplierId === SO && marker.origin === "added" && marker.record && marker.record.description === "Tee PVC 3/4 in. Fipt" && marker.by === "Patrick Lalande");
  ok("B is no longer a catalog part; A is, and carries B as an alias", !parts[B] && !!parts[A] && JSON.stringify(parts[A].aliases) === JSON.stringify([B]));
  ok("A kept its part number, description, default supplier and price", parts[A].sku === A && parts[A].description === "PVC tee 0.75\" FxFxF" && parts[A].supplierIds[0] === CP && parts[A].priceCents === 410, JSON.stringify([parts[A].supplierIds, parts[A].priceCents]));
  ok("A holds both suppliers' offers; SiteOne's part number for it is B", parts[A].supplierIds.join() === [CP, SO].join() && parts[A].supplierPrices[SO].supplierSku === B && parts[A].supplierPrices[SO].priceCents === 276);
  const rows = PR.buildRows(Object.values(parts));
  const rowA = rows.find((r) => r.members.some((p) => p.sku === A));
  ok("1. the picker has ONE row for the fitting — no row for B", !!rowA && !rows.some((r) => r.members.some((p) => p.sku === B)) && rows.length === 2, String(rows.length));
  ok("2. searching B's number finds A", PR.rowMatches(rowA, B) && PR.rowMatches(rowA, "405-007") && PR.rowMatches(rowA, A));
  ok("...and a different number still doesn't", !PR.rowMatches(rowA, "405-010"));
  const offers = PR.offersFor(rowA, { [CP]: { id: CP, name: "Central Pro Supply" }, [SO]: { id: SO, name: "SiteOne" } });
  ok("the supplier sheet shows both offers, Central as default, SiteOne under its own number", offers.length === 2 && offers.some((o) => o.supplierId === CP && o.isDefault && o.canAdd) && offers.some((o) => o.supplierId === SO && o.supplierSku === B && o.priceCents === 276 && !o.isDefault), JSON.stringify(offers.map((o) => [o.supplierId, o.supplierSku, o.priceCents, o.isDefault])));

  console.log("3. stale tab adds B");
  ok("canonicalSku: B answers A; A answers itself; an unknown number answers itself", partAlias.canonical(B) === A && partAlias.canonical(A) === A && partAlias.canonical("ZZZ") === "ZZZ" && partsLib.canonicalSku(B, await partsLib.readOverrides()) === A);
  let list = await ml.create({ name: "Stale tab", lineItems: [{ id: "tmp_1", sku: B, qty: 2 }] });
  ok("a NEW list created with B stores A", list.lineItems.length === 1 && list.lineItems[0].sku === A && list.lineItems[0].qty === 2, JSON.stringify(list.lineItems));
  list = await ml.update(list.id, { lineItems: [...list.lineItems, { id: "tmp_2", sku: B, qty: 3, status: "need", poId: null, notes: "" }], baseUpdatedAt: list.updatedAt });
  ok("3. a stale add of B onto a list that has A becomes ONE line for A, quantities added", list.lineItems.length === 1 && list.lineItems[0].sku === A && list.lineItems[0].qty === 5, JSON.stringify(list.lineItems));
  list = await ml.update(list.id, { lineItems: [{ ...list.lineItems[0], status: "have" }, { id: "tmp_3", sku: B, qty: 1, status: "need", poId: null, notes: "" }], baseUpdatedAt: list.updatedAt });
  ok("...but it is not folded into a Have line — it stays its own Need line, as A", list.lineItems.length === 2 && list.lineItems.every((l) => l.sku === A) && list.lineItems[1].status === "need", JSON.stringify(list.lineItems));
  {
    // The purchased line on the history list is never rewritten, even if a
    // stale save echoes it and adds B beside it.
    const h = await ml.get(hist.id);
    const saved = await ml.update(h.id, { lineItems: [...h.lineItems, { id: "tmp_4", sku: B, qty: 1, status: "need", poId: null, notes: "" }], baseUpdatedAt: h.updatedAt });
    ok("a purchased line for A is left exactly as stored; the stale B beside it becomes a new Need line for A", saved.lineItems[0].status === "ordered" && saved.lineItems[0].poId === "PO-HIST" && saved.lineItems[0].frozenPriceCents === 410 && saved.lineItems[0].qty === 15 && saved.lineItems[1].sku === A && saved.lineItems[1].status === "need", JSON.stringify(saved.lineItems));
    // put the history list back for the untouched check below
    fs.writeFileSync(path.join(DATA, "material-lists.json"), histBefore.ml);
  }

  console.log("4. import");
  const mergedMarkers = (await partsLib.readOverrides()).merged;
  const diff = partsLib.computeImportDiff(parts, [
    { sku: B, description: "Tee PVC 3/4 in. Fipt", category: "fittings", price: 2.61 },
    { sku: "NEW-1", description: "Brand new part", category: "fittings", subcategory: "PVC Tee", size: "1", unit: "each", price: 1 },
    { sku: "408007", priceCents: 140 }
  ], { includeDeletions: true, merged: mergedMarkers });
  ok("the import preview does NOT list B as an added part", !diff.added[B] && !!diff.added["NEW-1"]);
  ok("...it lists B as an offer update on A: SiteOne, new price", diff.aliased && diff.aliased[B] && diff.aliased[B].into === A && diff.aliased[B].supplierId === SO && diff.aliased[B].priceCents === 261, JSON.stringify(diff.aliased));
  ok("...and a deletions pass does not propose deleting A just because the file used B", !diff.deleted.includes(A));
  // commit, as the route does it
  const counts = await partsLib.applyImport(BASE, { added: { ...diff.added, [B]: B_RECORD }, edited: diff.edited, deleted: [] }, { added: ["NEW-1", B], edited: ["408007"], deleted: [] }, {});
  await partPrices.recordSupplierPrices(SO, { [A]: { priceCents: diff.aliased[B].priceCents, supplierSku: B } }, { source: "import" });
  parts = await effective();
  ok("4. committing the import updates A's SiteOne offer (2.76 → 2.61) and does NOT recreate B — even if a stale preview asked to add it", !parts[B] && parts[A].supplierPrices[SO].priceCents === 261 && parts[A].supplierPrices[SO].supplierSku === B && counts.added === 1 && !!parts["NEW-1"], JSON.stringify([counts, parts[A].supplierPrices[SO]]));
  ok("...A's default supplier and displayed price are unchanged by a SiteOne price", parts[A].supplierIds[0] === CP && parts[A].priceCents === 410);
  const SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ok("the import routes stage aliased rows and record them as supplier offers on the canonical part", /computeImportDiff\(PARTS\.parts \|\| \{\}, rows, \{ includeDeletions, merged: mergedMarkers \}\)/.test(SRC) && /bySupplier\.get\(row\.supplierId\)\[row\.into\] = \{ priceCents: row\.priceCents, supplierSku: alias \}/.test(SRC));

  console.log("5. a retired number can't become a part again");
  let r = await attempt(() => partsLib.addOne(BASE, B_RECORD, {}));
  ok("5. adding a part with B's number is refused, and says where it went", r.err && r.err.code === "sku_merged" && r.err.into === A && /was merged into 405007/.test(r.err.message), r.err && r.err.message);
  r = await attempt(() => partsLib.addMany(BASE, [{ ...B_RECORD }], {}));
  ok("...in a batch add too", r.err && r.err.code === "sku_merged");
  r = await attempt(() => partsLib.restore(B));
  ok("...and it can't be 'restored' around the marker", r.err && r.err.code === "sku_merged");
  r = await attempt(() => partsLib.softDelete(BASE, A));
  ok("the canonical part can't be deleted while a number is merged into it", r.err && r.err.code === "merge_target", r.err && r.err.message);
  r = await attempt(() => partsLib.mergeInto(BASE, "408007", B, {}));
  ok("no chains: nothing can be merged into a retired number", !!r.err, r.err && r.err.message);
  r = await attempt(() => partsLib.mergeInto(BASE, A, "408007", {}));
  ok("no chains: a merge target can't itself be retired", r.err && r.err.code === "merge_chain", r.err && r.err.message);
  r = await attempt(() => partsLib.mergeInto(BASE, B, A, {}));
  ok("merging the same number twice is refused", r.err && r.err.code === "already_merged");
  r = await attempt(() => partsLib.mergeInto(BASE, "NOPE", A, {}));
  ok("merging a number that isn't a part is refused", !!r.err && /not found/.test(r.err.message));

  console.log("6. System Builder");
  const SB = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"), "utf8");
  const fnSrc = (SB.match(/function canonSku\(s\)\{[^\n]*\n/) || [""])[0] + (SB.match(/function canonicalizeBomOverrides\(\)\{[\s\S]*?\n\}/) || [""])[0];
  ok("the System Builder reads the alias map from /api/parts and canonicalises a design's BOM overrides on load", /PARTS_MERGED=\(j&&j\.merged\)\|\|\{\}; canonicalizeBomOverrides\(\)/.test(SB) && (SB.match(/canonicalizeBomOverrides\(\);/g) || []).length >= 2 && fnSrc.length > 100);
  {
    const ctx = { PARTS_MERGED: { [B]: A }, bomOverrides: { edits: { [B]: { qty: 4 }, "405010": { sku: B, qty: 2 } }, removed: { [B]: true }, custom: [{ sku: B, qty: 3 }, { sku: "408007", qty: 1 }] } };
    vm.createContext(ctx);
    vm.runInContext(fnSrc + "\ncanonicalizeBomOverrides(); this.__out = bomOverrides;", ctx);
    const o = ctx.__out;
    ok("6. a saved design naming B (as an edited line, a replacement, a removal or a custom line) reads as A", o.edits[A] && o.edits[A].qty === 4 && !o.edits[B] && o.edits["405010"].sku === A && o.removed[A] === true && !o.removed[B] && o.custom[0].sku === A && o.custom[1].sku === "408007", JSON.stringify(o));
  }

  console.log("7. PO generation");
  parts = await effective();
  const forPo = await ml.create({ name: "Order it", lineItems: [{ id: "li_po", sku: A, qty: 10 }] });
  let plan = po.planDraftsFromMaterialList(forPo, parts, {});
  ok("split by assigned supplier: A goes to its default (Central) at the catalog price, under A's own number", plan.drafts.length === 1 && plan.drafts[0].supplierId === CP && plan.drafts[0].lineItems[0].sku === A && plan.drafts[0].lineItems[0].unitPriceCents === 410 && format.resolveSupplierSku(plan.drafts[0].lineItems[0], parts, CP) === A);
  plan = po.planDraftsFromMaterialList(forPo, parts, { forceSupplierId: SO });
  ok("7. one order from SiteOne: A is priced from SiteOne's offer and the document prints SiteOne's number (B)", plan.drafts[0].supplierId === SO && plan.drafts[0].lineItems[0].sku === A && plan.drafts[0].lineItems[0].unitPriceCents === 261 && format.resolveSupplierSku(plan.drafts[0].lineItems[0], parts, SO) === B && plan.unpricedForSupplier.length === 0, JSON.stringify(plan.drafts[0].lineItems[0]));
  plan = po.planDraftsFromMaterialList({ id: "ML-RAW", lineItems: [{ id: "li_x", sku: B, qty: 2, status: "need" }] }, parts, {});
  ok("a line that somehow still holds B plans as A — never 'no supplier'", plan.ok && plan.drafts[0].lineItems[0].sku === A && plan.missingSupplier.length === 0, JSON.stringify(plan));
  const qr = require(path.join(ROOT, "server", "lib", "quote-requests.js"));
  const rfqPlan = qr.planFromMaterialList({ id: "ML-RAW", lineItems: [{ id: "li_x", sku: B, qty: 2, status: "need" }] }, parts, {});
  ok("...and quotes as A", JSON.stringify(rfqPlan).includes(`"sku":"${A}"`) && !JSON.stringify(rfqPlan).includes(`"sku":"${B}"`), JSON.stringify(rfqPlan).slice(0, 200));
  const pm = require(path.join(ROOT, "server", "lib", "project-materials.js"));
  const model = pm.describeProject({ lists: [{ id: "ML-1", name: "x", status: "draft", createdAt: "2026-10-01", lineItems: [{ sku: A, qty: 10, status: "need" }] }], purchaseOrders: [{ id: "PO-1", status: "received", sourceMaterialListIds: ["ML-1"], lineItems: [{ sku: B, qty: 10, receivedQty: 10 }] }], buildWos: [{ id: "WO-1", dailyLog: { workDate: "2026-10-02", materialsConsumed: [{ partSku: B, qty: 4 }] } }], partsMap: { [A]: { name: "tee", priceCents: 410 } } });
  ok("project materials: received and used under B count against A — one row, no split", model.stock.length === 1 && model.stock[0].sku === A && model.stock[0].received === 10 && model.stock[0].usedOnsite === 4, JSON.stringify(model.stock.map((s) => [s.sku, s.received, s.usedOnsite])));
  ok("...and so does what was ORDERED under B (the shared purchasing calculation)", typeof po.orderedBySku !== "function" || (() => { const m = po.orderedBySku([{ id: "PO-9", status: "sent", lineItems: [{ sku: B, qty: 6, receivedQty: 0 }] }]); return m.has(A) && !m.has(B); })());
  const WO = fs.readFileSync(path.join(ROOT, "server", "lib", "work-orders.js"), "utf8");
  ok("work-order doors (packed, consumed, next-day) store the canonical part", (WO.match(/partAlias\.canonical\(/g) || []).length >= 3);

  console.log("8. history");
  ok("8. the purchased list line, the PO and the RFQ are byte-identical after the merge, the import and the planning", read("material-lists.json").includes('"poId": "PO-HIST"') && read("purchase-orders.json") === histBefore.po && read("quote-requests.json") === histBefore.rfq && JSON.stringify(JSON.parse(read("material-lists.json")).find((x) => x.id === hist.id)) === JSON.stringify(JSON.parse(histBefore.ml).find((x) => x.id === hist.id)));
  ok("mergeInto wrote only the catalog overrides (the marker) — B's record moved into it, nothing else changed there", (() => { const b = JSON.parse(overridesBefore), a = JSON.parse(overridesAfterMerge); return !!b.added[B] && !a.added[B] && a.merged[B].record.description === b.added[B].description && JSON.stringify(a.edited) === JSON.stringify(b.edited) && JSON.stringify(a.deleted) === JSON.stringify(b.deleted); })());
  ok("the merge routes are admin-only, refuse a referenced number, and write an audit entry", /partMergeMatch && req\.method === "POST"[\s\S]{0,200}requireAdmin\(req\)/.test(SRC) && /code: "sku_referenced"/.test(SRC) && /action: "catalog\.merge"/.test(SRC) && /action: "catalog\.unmerge"/.test(SRC));
  ok("/api/parts publishes the alias map, and the server republishes it on every catalog rebuild", /merged: PARTS\.merged \|\| \{\}/.test(SRC) && /PARTS\.merged = partsLib\.aliasMap\(catalogOverrides\);\s*partAlias\.publish\(PARTS\.merged\);/.test(SRC));

  console.log("9. reversible");
  const un = await partsLib.unmerge(B);
  parts = await effective();
  ok("unmerge puts B back exactly as it was; A keeps the offers it gained", un.into === A && !!parts[B] && parts[B].description === "Tee PVC 3/4 in. Fipt" && parts[B].priceCents === 276 && !parts[A].aliases && parts[A].supplierPrices[SO].supplierSku === B && partAlias.canonical(B) === B, JSON.stringify(parts[B]));
  r = await attempt(() => partsLib.unmerge(B));
  ok("unmerging a part that isn't merged is refused", r.err && r.err.code === "not_merged");
  ok("an override file written before this change (no merged section) still reads", JSON.stringify(partsLib.mergeOverrides(BASE, { added: {}, edited: {}, deleted: [] })) === JSON.stringify(BASE) && partsLib.canonicalSku(B, { added: {}, edited: {}, deleted: [] }) === B);
} catch (err) {
  if (!/pre-change code/.test(err.message)) ok("the suite ran to the end", false, err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err.message);
} finally {
  for (const [f, b] of Object.entries(backups)) {
    const p = path.join(DATA, f);
    if (b === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, b);
  }
  try { require(path.join(ROOT, "server", "lib", "part-alias.js")).publish({}); } catch {}
}

console.log(`\npart merged-into: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

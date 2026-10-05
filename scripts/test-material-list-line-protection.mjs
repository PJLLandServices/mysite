#!/usr/bin/env node
// scripts/test-material-list-line-protection.mjs
//
// THE MATERIAL LIST SAVE DEFECT (Patrick, 2026-10-03, priority #1).
//
// The builder saves the WHOLE list on every edit. From 2026-09-27 the
// store refused any lineItems write once ANY line was have/ordered/on a
// PO/price-locked — so after the first "Have" every add, quantity change,
// removal and rename came back 400, the screen kept showing the change,
// and a reload lost it. The PO send/receive/cancel flips used the same
// write and threw the same way.
//
// The rule now (lib/material-lists.js):
//   * protectedLineViolations(current, patchLines) — a line is protected
//     by PURCHASING PROVENANCE only (ordered, or carrying poId / a frozen
//     purchase price). Its sku, qty, status, poId and frozenPriceCents
//     must come back exactly as stored and it may not be dropped; its
//     notes may change. A hand-marked "have" line is planning: editable,
//     removable, toggleable. Nobody but purchasing may introduce
//     purchasing state on a line.
//   * the PO door is purchasing.js (#367): send / receive / cancel commit
//     the PO and its list lines together, and every line move is held to
//     purchasingTransitionError — only need→ordered, ordered→have (price
//     kept), ordered→need (price released).
//   * a line with receipts behind it (#367) can't be dropped or re-SKU'd,
//     even once it's back at "need"; its quantity stays editable.
//   * baseUpdatedAt — a stale client is refused (stale_list), nothing is
//     written; a client that sends none is served as before.
//
// Run against the pre-fix store (PJL_TEST_LIB_DIR pointing at the old
// lib), the "after Have" assertions all fail with line_items_locked.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DIR = process.env.PJL_TEST_LIB_DIR || path.join(ROOT, "server", "lib");
const DATA = path.join(ROOT, "server", "data");
// The PO door writes these too; each is put back exactly as it was.
const FILES = ["material-lists.json", "purchase-orders.json", "purchasing-holds.json", "purchasing-journal.json", "purchasing-recovery-log.json"];

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const tryUpdate = async (ml, id, patch, opts) => { try { return { list: await ml.update(id, patch, opts) }; } catch (err) { return { err }; } };
const tryFlip = async (ml, id, fn) => { try { return { list: await ml.flipLines(id, fn) }; } catch (err) { return { err }; } };
const shape = (l) => l.lineItems.map((x) => `${x.sku}×${x.qty}:${x.status}${x.poId ? "@" + x.poId : ""}${x.frozenPriceCents != null ? "$" + x.frozenPriceCents : ""}`).join(",");
// What the builder sends: its last server copy, edited, plus the version it edited.
const builderPatch = (list, edit) => { const copy = JSON.parse(JSON.stringify(list)); edit(copy); return { name: copy.name, notes: copy.notes, lineItems: copy.lineItems, baseUpdatedAt: list.updatedAt }; };

fs.mkdirSync(DATA, { recursive: true });
const backups = new Map(FILES.map((f) => [f, fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f)) : null]));
try {
  const ml = require(path.join(LIB_DIR, "material-lists.js"));
  const pos = require(path.join(LIB_DIR, "purchase-orders.js"));
  const purchasing = require(path.join(LIB_DIR, "purchasing.js"));
  const get = (id) => ml.get(id);

  // ---- 1. The seven steps ------------------------------------------------
  console.log("1. add A → Have → add B → reload");
  let list = await ml.create({ name: "Field list" });
  let r = await tryUpdate(ml, list.id, builderPatch(list, (c) => c.lineItems.push({ id: "tmp_a", sku: "1401010", qty: 1, status: "need", poId: null, notes: "" })));
  ok("2. add A saves", !r.err, r.err && r.err.message); list = r.list || list;
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems[0].status = "have"; }));
  ok("3. mark A Have saves (status complete)", !r.err && r.list.status === "complete", r.err && r.err.message); list = r.list || list;
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => c.lineItems.push({ id: "tmp_b", sku: "1406010", qty: 1, status: "need", poId: null, notes: "" })));
  ok("4-5. add B after A is Have SAVES", !r.err, r.err && r.err.message.slice(0, 100)); list = r.list || list;
  list = await get(list.id);
  ok("6-7. reload: B is present", list.lineItems.some((l) => l.sku === "1406010") && list.lineItems.length === 2, shape(list));

  // ---- 2. Manual Have is planning: Patrick's explicit sequence ---------
  console.log("2. manual Have: qty change, add, remove, reload after each");
  const A = () => list.lineItems.find((l) => l.sku === "1401010");
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems.find((l) => l.sku === "1401010").qty = 7; }));
  list = await get(list.id);
  ok("change A's quantity while A is Have → persisted", !r.err && A().qty === 7 && A().status === "have", (r.err && r.err.message) || shape(list));
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => c.lineItems.push({ id: "tmp_c", sku: "405010", qty: 2, status: "need", poId: null, notes: "" })));
  list = await get(list.id);
  ok("add another material → persisted", !r.err && list.lineItems.length === 3, (r.err && r.err.message) || shape(list));
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems.find((l) => l.sku === "1401010").notes = "on the truck"; }));
  list = await get(list.id);
  ok("note on the Have line → persisted", !r.err && A().notes === "on the truck", r.err && r.err.message);
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems.find((l) => l.sku === "1401010").status = "need"; }));
  list = await get(list.id);
  ok("Have → Need toggle → persisted", !r.err && A().status === "need", r.err && r.err.message);
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems.find((l) => l.sku === "1401010").status = "have"; }));
  list = await get(list.id);
  ok("...and back to Have", !r.err && A().status === "have", r.err && r.err.message);
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.name = "Field list renamed"; }));
  list = await get(list.id);
  ok("rename with the lines echoed (what the builder sends) → persisted", !r.err && list.name === "Field list renamed", r.err && r.err.message);
  r = await tryUpdate(ml, list.id, builderPatch(list, () => {}));
  ok("identical lines re-sent → accepted", !r.err, r.err && r.err.message); list = await get(list.id);
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems = c.lineItems.filter((l) => l.sku !== "405010"); }));
  list = await get(list.id);
  ok("remove a Need line → persisted", !r.err && !list.lineItems.some((l) => l.sku === "405010"), r.err && r.err.message);
  r = await tryUpdate(ml, list.id, builderPatch(list, (c) => { c.lineItems = c.lineItems.filter((l) => l.sku !== "1401010"); }));
  list = await get(list.id);
  ok("remove the manual-Have line A → persisted", !r.err && !A(), (r.err && r.err.message) || shape(list));
  {
    // Several quick adds, each built on the previous response (the client serialises saves).
    let cur = list, okAll = true;
    for (const sku of ["405010", "408010", "1429010"]) { const rr = await tryUpdate(ml, cur.id, builderPatch(cur, (c) => c.lineItems.push({ id: "tmp_" + sku, sku, qty: 1, status: "need", poId: null, notes: "" }))); if (rr.err) { okAll = false; break; } cur = rr.list; }
    list = await get(list.id);
    ok("three quick adds in a row → all persisted", okAll && ["405010", "408010", "1429010"].every((s) => list.lineItems.some((l) => l.sku === s)), shape(list));
  }

  // ---- 3. Purchased lines are protected ------------------------------
  // Combined with #367: the PO door is the real one — purchasing.js send /
  // receive / cancel on real purchase orders (no email: deliver = null),
  // which commits the PO and its list lines together.
  console.log("3. receive A through a PO: purchasing-controlled fields are protected");
  const attempt = async (fn) => { try { return { v: await fn() }; } catch (err) { return { err }; } };
  let po = await ml.create({ name: "PO list", lineItems: [{ id: "li_a", sku: "1401010", qty: 4 }, { id: "li_b", sku: "1406010", qty: 2 }, { id: "li_c", sku: "405010", qty: 1 }] });
  const draftFor = (listId, lines) => pos.create({ supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [listId],
    lineItems: lines.map(([lineId, sku, qty, price]) => ({ sku, qty, unitPriceCents: price, sourceListId: listId, sourceLineId: lineId })) });
  const send = (id) => purchasing.sendPurchaseOrder(id, { toEmail: "orders@siteone.test" }, null);
  const PO1 = await draftFor(po.id, [["li_a", "1401010", 4, 203], ["li_b", "1406010", 2, 203]]);
  const PO2 = await draftFor(po.id, [["li_c", "405010", 1, 397]]);
  let rr = await attempt(() => send(PO1.id)); po = await get(po.id);
  ok("PO door: send flips need → ordered with PO and frozen price", !rr.err && shape(po) === `1401010×4:ordered@${PO1.id}$203,1406010×2:ordered@${PO1.id}$203,405010×1:need`, (rr.err && rr.err.message) || shape(po));
  rr = await attempt(() => send(PO2.id)); po = await get(po.id);
  ok("PO door: a SECOND PO against the same list flips its line too", !rr.err && po.lineItems[2].poId === PO2.id, rr.err && rr.err.message);
  const refused = async (label, edit) => { const r2 = await tryUpdate(ml, po.id, builderPatch(po, edit)); const after = await get(po.id); ok(label + " → refused, nothing written", r2.err && r2.err.code === "line_items_locked" && shape(after) === shape(po), (r2.err && r2.err.message.slice(0, 100)) || "accepted: " + shape(after)); return r2.err; };
  await refused("PATCH changes an ordered line's qty", (c) => { c.lineItems[0].qty = 9; });
  await refused("PATCH changes an ordered line's sku", (c) => { c.lineItems[0].sku = "408010"; });
  await refused("PATCH flips an ordered line to need", (c) => { c.lineItems[0].status = "need"; c.lineItems[0].poId = null; c.lineItems[0].frozenPriceCents = null; });
  await refused("PATCH flips an ordered line to have", (c) => { c.lineItems[0].status = "have"; c.lineItems[0].poId = null; });
  await refused("PATCH changes an ordered line's PO", (c) => { c.lineItems[0].poId = "PO-9"; });
  await refused("PATCH changes an ordered line's frozen price", (c) => { c.lineItems[0].frozenPriceCents = 1; });
  const eRemove = await refused("PATCH removes an ordered line", (c) => { c.lineItems = c.lineItems.filter((l) => l.id !== "li_a"); });
  ok("the refusal names the line and what changed", eRemove && /1401010: removed/.test(eRemove.message) && eRemove.blockingSkus.includes("1401010"), eRemove && eRemove.message);
  await refused("System Builder-style wholesale replacement on a purchased list", (c) => { c.lineItems = [{ sku: "NEW1", qty: 1 }]; });
  r = await tryUpdate(ml, po.id, builderPatch(po, (c) => { c.lineItems[0].notes = "left at the gate"; c.lineItems.push({ id: "tmp_d", sku: "408010", qty: 3, status: "need", poId: null, notes: "" }); }));
  po = await get(po.id);
  ok("PATCH: a note on an ordered line AND a new need line beside it → saved, the ordered line intact", !r.err && po.lineItems[0].notes === "left at the gate" && po.lineItems[0].status === "ordered" && po.lineItems[0].frozenPriceCents === 203 && po.lineItems.length === 4, (r.err && r.err.message) || shape(po));
  rr = await attempt(() => purchasing.receivePurchaseOrder(PO1.id)); po = await get(po.id);
  ok("PO door: receive flips ordered → have, frozen price KEPT, PO cleared", !rr.err && po.lineItems[0].status === "have" && po.lineItems[0].poId === null && po.lineItems[0].frozenPriceCents === 203, rr.err && rr.err.message);
  ok("…and the note made while it was on order survives the receipt", po.lineItems[0].notes === "left at the gate");
  await refused("PATCH changes a RECEIVED line's frozen price", (c) => { c.lineItems[0].frozenPriceCents = 100; });
  await refused("PATCH changes a RECEIVED line's qty", (c) => { c.lineItems[0].qty = 1; });
  await refused("PATCH removes a RECEIVED line", (c) => { c.lineItems = c.lineItems.filter((l) => l.id !== "li_a"); });
  await refused("PATCH toggles a RECEIVED line back to need (would release the purchase price)", (c) => { c.lineItems[0].status = "need"; c.lineItems[0].frozenPriceCents = null; });
  r = await tryUpdate(ml, po.id, builderPatch(po, (c) => { c.lineItems[0].notes = "counted"; }));
  po = await get(po.id);
  ok("PATCH: a note on a received line → saved", !r.err && po.lineItems[0].notes === "counted", r.err && r.err.message);
  rr = await attempt(() => purchasing.cancelPurchaseOrder(PO2.id)); po = await get(po.id);
  ok("PO door: cancel flips ordered → need and releases the price", !rr.err && po.lineItems[2].status === "need" && po.lineItems[2].frozenPriceCents === null, rr.err && rr.err.message);
  r = await tryUpdate(ml, po.id, builderPatch(po, (c) => { c.lineItems[2].qty = 6; }));
  ok("...and that line is editable again", !r.err && r.list.lineItems[2].qty === 6, r.err && r.err.message); po = r.list || po;

  // ---- 4. Nobody but purchasing introduces purchasing state ----------
  console.log("4. the PATCH route cannot forge purchasing state");
  await refused("PATCH adds a NEW line already marked ordered with a PO", (c) => c.lineItems.push({ id: "tmp_x", sku: "1429010", qty: 1, status: "ordered", poId: "PO-7", frozenPriceCents: 50, notes: "" }));
  await refused("PATCH adds a NEW line marked have with a frozen price", (c) => c.lineItems.push({ id: "tmp_y", sku: "1429010", qty: 1, status: "have", poId: null, frozenPriceCents: 50, notes: "" }));
  await refused("PATCH puts a PO id on an existing need line", (c) => { c.lineItems[2].poId = "PO-7"; c.lineItems[2].status = "ordered"; c.lineItems[2].frozenPriceCents = 1; });

  // ---- 5. The PO door only takes purchasing transitions --------------
  // One rule (purchasingTransitionError); purchasing.js checks every move
  // it commits against it.
  console.log("5. the PO door is narrow");
  const T = ml.purchasingTransitionError;
  const L0 = { id: "x", sku: "405010", qty: 2, status: "need", poId: null, frozenPriceCents: null, notes: "" };
  const LO = { ...L0, status: "ordered", poId: "PO-1", frozenPriceCents: 300 };
  const LH = { ...L0, status: "have", poId: null, frozenPriceCents: 300 };
  ok("legal: need → ordered (PO + price)", T(L0, LO) === null);
  ok("legal: ordered → have (price kept, PO cleared)", T(LO, LH) === null);
  ok("legal: ordered → need (price released)", T(LO, L0) === null);
  ok("refused: need → have through the door", !!T(L0, { ...L0, status: "have" }));
  ok("refused: need → ordered without a PO id", !!T(L0, { ...L0, status: "ordered", frozenPriceCents: 5 }));
  ok("refused: received → need (would release a paid price)", !!T(LH, L0));
  ok("refused: changing a qty through the door", !!T(L0, { ...L0, qty: 99 }));
  ok("refused: changing a frozen price without a status change", !!T(LH, { ...LH, frozenPriceCents: 1 }));
  ok("refused: receiving with a different frozen price", !!T(LO, { ...LH, frozenPriceCents: 999 }));
  const PSRC = fs.readFileSync(path.join(LIB_DIR, "purchasing.js"), "utf8");
  ok("purchasing.js checks every list move it commits against that rule", /materialLists\.purchasingTransitionError\(/.test(PSRC) && /code: "purchasing_transition_invalid"/.test(PSRC));

  // ---- 6. Stale-write protection ------------------------------------
  console.log("6. baseUpdatedAt");
  const fresh = await get(list.id);
  r = await tryUpdate(ml, fresh.id, { notes: "tab A", baseUpdatedAt: fresh.updatedAt });
  ok("a matching base is accepted", !r.err && r.list.notes === "tab A", r.err && r.err.message);
  r = await tryUpdate(ml, fresh.id, builderPatch(fresh, (c) => { c.notes = "tab B, edited the older version"; }));
  const afterStale = await get(fresh.id);
  ok("a stale base is refused with stale_list and nothing is written", r.err && r.err.code === "stale_list" && afterStale.notes === "tab A" && /changed elsewhere/.test(r.err.message), (r.err && r.err.message) || afterStale.notes);
  r = await tryUpdate(ml, fresh.id, { notes: "older client, no base" });
  ok("a client that sends no base is served as before", !r.err && r.list.notes === "older client, no base", r.err && r.err.message);
  {
    // A PO send moves the version: the builder's next whole-list save on the old version is refused as stale, so it cannot overwrite the send.
    const before = await get(po.id);
    await new Promise((res) => setTimeout(res, 5));   // updatedAt is millisecond-stamped
    const PO3 = await draftFor(po.id, [["li_c", "405010", 6, 397]]);
    await send(PO3.id);
    const flipped = await get(po.id);
    const r3 = await tryUpdate(ml, po.id, builderPatch(before, (c) => c.lineItems.push({ id: "tmp_z", sku: "1429010", qty: 1, status: "need", poId: null, notes: "" })));
    const after = await get(po.id);
    ok("a builder save made on the version before a PO send is refused as stale (409), the send stands", r3.err && r3.err.code === "stale_list" && shape(after) === shape(flipped) && after.lineItems[2].poId === PO3.id, (r3.err && r3.err.message) || shape(after));
  }

  // ---- 7. server.js wiring (static) ----------------------------------
  console.log("7. server wiring");
  const SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ok("send, receive and cancel go through the one PO door (purchasing.js)", /purchasing\.sendPurchaseOrder\(/.test(SRC) && /purchasing\.receivePurchaseOrder\(/.test(SRC) && /purchasing\.cancelPurchaseOrder\(/.test(SRC));
  ok("no server-side caller replaces lineItems through update() any more", !/materialLists\.update\([^)]*lineItems/.test(SRC));
  ok("the PATCH route answers 409 for stale_list and line_items_locked", /err\.code === "stale_list" \|\| err\.code === "line_items_locked"/.test(SRC) && /conflict \? 409 : 400/.test(SRC));
  const CLIENT = fs.readFileSync(path.join(ROOT, "server", "material-list.js"), "utf8");
  ok("the builder sends baseUpdatedAt on its save and its unload flush", (CLIENT.match(/baseUpdatedAt: state\.list\.updatedAt/g) || []).length === 2);
  ok("Add on a part already on the list as a purchased line (ordered, received or price-locked) starts a new Need line instead of bumping the purchased one",
    /function isPurchased\(line\)[\s\S]{0,200}line\.status === "ordered" \|\| !!line\.poId \|\| line\.frozenPriceCents != null/.test(CLIENT) && /lines\.find\(\(l\) => l\.sku === sku && !isPurchased\(l\)\)/.test(CLIENT));
  ok("on 409 stale_list the builder keeps the edit on screen, shows the message and a Reload button — no automatic reload", /data\.code === "stale_list"/.test(CLIENT) && /changed elsewhere\. Your latest change wasn.t saved\. Reload to continue\./.test(CLIENT) && /saveReload\.hidden = !state\.staleList/.test(CLIENT) && !/if \(state\.staleList\)[^\n]*location\.reload/.test(CLIENT));

  // ---- 8. Combined with #367: a line with purchase history -----------
  // 6 of 10 arrive on one order; the line is "need" again (4 still to
  // order) and no longer looks purchased to the line rule above — but it
  // has receipts behind it, so it can't be dropped or turned into another
  // part. Its quantity, notes and a hand "have" stay editable.
  console.log("8. a line with receipts behind it (#367 + #375)");
  let h = await ml.create({ name: "History list", lineItems: [{ id: "li_h", sku: "1401010", qty: 10 }, { id: "li_m", sku: "405010", qty: 1, status: "have" }] });
  const PO4 = await draftFor(h.id, [["li_h", "1401010", 6, 250]]);
  await send(PO4.id);
  await purchasing.receivePurchaseOrder(PO4.id);
  h = await get(h.id);
  const H = () => h.lineItems.find((l) => l.id === "li_h");
  ok("6 of 10 in on a completed order → the line is need, on no order (4 still to order)", H().status === "need" && H().poId === null && H().frozenPriceCents === null, shape(h));
  ok("…stillToOrder says 4", pos.stillToOrder(H(), pos.commitmentsByListLine(await pos.list({}), h.id)) === 4);
  const hist = async (label, edit, expectCode) => { const r4 = await tryUpdate(ml, h.id, builderPatch(h, edit)); const after = await get(h.id);
    if (expectCode) ok(label + ` → refused (${expectCode}), nothing written`, r4.err && r4.err.code === expectCode && shape(after) === shape(h), (r4.err && (r4.err.code + " " + r4.err.message.slice(0, 80))) || "accepted: " + shape(after));
    else ok(label + " → saved", !r4.err, r4.err && r4.err.message);
    h = await get(h.id); };
  await hist("drop the line with receipts behind it", (c) => { c.lineItems = c.lineItems.filter((l) => l.id !== "li_h"); }, "purchasing_history");
  await hist("turn it into another part (sku)", (c) => { c.lineItems.find((l) => l.id === "li_h").sku = "408010"; }, "purchasing_history");
  await hist("change its quantity to 12", (c) => { c.lineItems.find((l) => l.id === "li_h").qty = 12; });
  ok("…still to order follows: 12 − 6 = 6", pos.stillToOrder(H(), pos.commitmentsByListLine(await pos.list({}), h.id)) === 6);
  await hist("a note on it", (c) => { c.lineItems.find((l) => l.id === "li_h").notes = "6 on the truck"; });
  await hist("edit the manual Have line beside it (qty 3) and add another part", (c) => { c.lineItems.find((l) => l.id === "li_m").qty = 3; c.lineItems.push({ id: "tmp_n", sku: "408010", qty: 2, status: "need", poId: null, notes: "" }); });
  ok("…both saved", h.lineItems.find((l) => l.id === "li_m").qty === 3 && h.lineItems.some((l) => l.sku === "408010"), shape(h));
  await hist("remove the manual Have line", (c) => { c.lineItems = c.lineItems.filter((l) => l.id !== "li_m"); });
  ok("the receipt is still on the PO record, at its price", (await pos.get(PO4.id)).lineItems[0].receivedQty === 6 && (await pos.get(PO4.id)).lineItems[0].unitPriceCents === 250);
} finally {
  for (const [f, b] of backups) {
    const p = path.join(DATA, f);
    if (b === null) { if (fs.existsSync(p)) fs.rmSync(p); } else fs.writeFileSync(p, b);
  }
}

console.log(`\nmaterial-list line protection: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
//   * flipLines(id, fn) — the PO door, the only path that sets
//     ordered/poId/frozen, and only need→ordered, ordered→have (price
//     kept), ordered→need (price released).
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
const store = path.join(DATA, "material-lists.json");
const backup = fs.existsSync(store) ? fs.readFileSync(store) : null;
try {
  const ml = require(path.join(LIB_DIR, "material-lists.js"));
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
  console.log("3. receive A through a PO: purchasing-controlled fields are protected");
  let po = await ml.create({ name: "PO list", lineItems: [{ id: "li_a", sku: "1401010", qty: 4 }, { id: "li_b", sku: "1406010", qty: 2 }, { id: "li_c", sku: "405010", qty: 1 }] });
  r = await tryFlip(ml, po.id, (l) => l.id !== "li_c" ? { ...l, status: "ordered", poId: "PO-1", frozenPriceCents: 203 } : l);
  ok("PO door: send flips need → ordered with PO and frozen price", !r.err && shape(r.list) === "1401010×4:ordered@PO-1$203,1406010×2:ordered@PO-1$203,405010×1:need", (r.err && r.err.message) || shape(r.list || po)); po = r.list || po;
  r = await tryFlip(ml, po.id, (l) => l.id === "li_c" ? { ...l, status: "ordered", poId: "PO-2", frozenPriceCents: 397 } : l);
  ok("PO door: a SECOND PO against the same list flips its line too", !r.err && r.list.lineItems[2].poId === "PO-2", r.err && r.err.message); po = r.list || po;
  const refused = async (label, edit) => { const rr = await tryUpdate(ml, po.id, builderPatch(po, edit)); const after = await get(po.id); ok(label + " → refused, nothing written", rr.err && rr.err.code === "line_items_locked" && shape(after) === shape(po), (rr.err && rr.err.message.slice(0, 100)) || "accepted: " + shape(after)); return rr.err; };
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
  // receive PO-1
  r = await tryFlip(ml, po.id, (l) => l.poId === "PO-1" ? { ...l, status: "have", poId: null } : l);
  ok("PO door: receive flips ordered → have, frozen price KEPT, PO cleared", !r.err && r.list.lineItems[0].status === "have" && r.list.lineItems[0].poId === null && r.list.lineItems[0].frozenPriceCents === 203, r.err && r.err.message); po = r.list || po;
  await refused("PATCH changes a RECEIVED line's frozen price", (c) => { c.lineItems[0].frozenPriceCents = 100; });
  await refused("PATCH changes a RECEIVED line's qty", (c) => { c.lineItems[0].qty = 1; });
  await refused("PATCH removes a RECEIVED line", (c) => { c.lineItems = c.lineItems.filter((l) => l.id !== "li_a"); });
  await refused("PATCH toggles a RECEIVED line back to need (would release the purchase price)", (c) => { c.lineItems[0].status = "need"; c.lineItems[0].frozenPriceCents = null; });
  r = await tryUpdate(ml, po.id, builderPatch(po, (c) => { c.lineItems[0].notes = "counted"; }));
  po = await get(po.id);
  ok("PATCH: a note on a received line → saved", !r.err && po.lineItems[0].notes === "counted", r.err && r.err.message);
  // cancel PO-2
  r = await tryFlip(ml, po.id, (l) => l.poId === "PO-2" ? { ...l, status: "need", poId: null, frozenPriceCents: null } : l);
  ok("PO door: cancel flips ordered → need and releases the price", !r.err && r.list.lineItems[2].status === "need" && r.list.lineItems[2].frozenPriceCents === null, r.err && r.err.message); po = r.list || po;
  r = await tryUpdate(ml, po.id, builderPatch(po, (c) => { c.lineItems[2].qty = 6; }));
  ok("...and that line is editable again", !r.err && r.list.lineItems[2].qty === 6, r.err && r.err.message); po = r.list || po;

  // ---- 4. Nobody but purchasing introduces purchasing state ----------
  console.log("4. the PATCH route cannot forge purchasing state");
  await refused("PATCH adds a NEW line already marked ordered with a PO", (c) => c.lineItems.push({ id: "tmp_x", sku: "1429010", qty: 1, status: "ordered", poId: "PO-7", frozenPriceCents: 50, notes: "" }));
  await refused("PATCH adds a NEW line marked have with a frozen price", (c) => c.lineItems.push({ id: "tmp_y", sku: "1429010", qty: 1, status: "have", poId: null, frozenPriceCents: 50, notes: "" }));
  await refused("PATCH puts a PO id on an existing need line", (c) => { c.lineItems[2].poId = "PO-7"; c.lineItems[2].status = "ordered"; c.lineItems[2].frozenPriceCents = 1; });

  // ---- 5. The PO door only takes purchasing transitions --------------
  console.log("5. the PO door is narrow");
  const badFlip = async (label, fn) => { const rr = await tryFlip(ml, po.id, fn); const after = await get(po.id); ok(label + " → refused by the door, nothing written", rr.err && rr.err.code === "purchasing_transition_invalid" && shape(after) === shape(po), (rr.err && rr.err.message) || "accepted: " + shape(after)); };
  await badFlip("need → have through the door", (l) => l.id === "li_c" ? { ...l, status: "have" } : l);
  await badFlip("need → ordered without a PO id", (l) => l.id === "li_c" ? { ...l, status: "ordered", frozenPriceCents: 5 } : l);
  await badFlip("received → need through the door (would release a paid price)", (l) => l.id === "li_a" ? { ...l, status: "need", frozenPriceCents: null } : l);
  await badFlip("changing a qty through the door", (l) => l.id === "li_c" ? { ...l, qty: 99 } : l);
  await badFlip("changing a frozen price without a status change", (l) => l.id === "li_a" ? { ...l, frozenPriceCents: 1 } : l);
  await badFlip("receiving with a different frozen price", (l) => l.id === "li_b" ? { ...l, status: "have", poId: null, frozenPriceCents: 999 } : l);

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
    // A PO flip moves the version: the builder's next whole-list save on the old version is refused as stale, so it cannot overwrite the flip.
    const before = await get(po.id);
    const flipped = await ml.flipLines(po.id, (l) => l.id === "li_c" ? { ...l, status: "ordered", poId: "PO-3", frozenPriceCents: 397 } : l);
    const rr = await tryUpdate(ml, po.id, builderPatch(before, (c) => c.lineItems.push({ id: "tmp_z", sku: "1429010", qty: 1, status: "need", poId: null, notes: "" })));
    const after = await get(po.id);
    ok("a builder save made on the version before a PO flip is refused as stale (409), the flip stands", rr.err && rr.err.code === "stale_list" && shape(after) === shape(flipped), (rr.err && rr.err.message) || shape(after));
  }

  // ---- 7. server.js wiring (static) ----------------------------------
  console.log("7. server wiring");
  const SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ok("the three PO flips (send, receive, cancel) go through flipLines", (SRC.match(/materialLists\.flipLines\(/g) || []).length === 3);
  ok("no server-side caller replaces lineItems through update() any more", !/materialLists\.update\([^)]*lineItems/.test(SRC));
  ok("the PATCH route answers 409 for stale_list and line_items_locked", /err\.code === "stale_list" \|\| err\.code === "line_items_locked"/.test(SRC) && /conflict \? 409 : 400/.test(SRC));
  const CLIENT = fs.readFileSync(path.join(ROOT, "server", "material-list.js"), "utf8");
  ok("the builder sends baseUpdatedAt on its save and its unload flush", (CLIENT.match(/baseUpdatedAt: state\.list\.updatedAt/g) || []).length === 2);
  ok("on 409 stale_list the builder keeps the edit on screen, shows the message and a Reload button — no automatic reload", /data\.code === "stale_list"/.test(CLIENT) && /changed elsewhere\. Your latest change wasn.t saved\. Reload to continue\./.test(CLIENT) && /saveReload\.hidden = !state\.staleList/.test(CLIENT) && !/if \(state\.staleList\)[^\n]*location\.reload/.test(CLIENT));
} finally {
  if (backup === null) { if (fs.existsSync(store)) fs.rmSync(store); }
  else fs.writeFileSync(store, backup);
}

console.log(`\nmaterial-list line protection: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

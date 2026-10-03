#!/usr/bin/env node
// scripts/test-purchasing-matrix.mjs
//
// The state matrix for "does a purchase order agree with its material
// list" (Patrick, 2026-10-02). One classifier — server/lib/purchasing-audit
// — is the definition; this pins it, and pins everything that has to agree
// with it:
//
//   1. MATRIX — every PO state (draft, sent, partially received with this
//      line part-arrived, partially received with this line complete,
//      received, cancelled with nothing / part / all of the line arrived)
//      against every list-line state (need, need-but-linked, ordered on
//      this PO, ordered on another live PO, ordered on a PO that doesn't
//      exist, have), plus the extra cases: duplicate links on one PO, two
//      live POs, a list ahead of its PO, quantities short / over, the
//      remainder of a partial delivery re-ordered. Each has its expected
//      kind, severity (hold = records disagree; review = quantities) and
//      whether it is repairable by rule.
//   2. ONE DEFINITION — the browser snippet the live audit runs
//      (scripts/audit-po-list-lines.mjs --browser) is executed for every
//      case and must print exactly what the server module prints.
//   3. REPAIRS — every "repairable by rule" repair, applied, leaves that
//      line agreeing, changes no PO record, and keeps received and
//      remaining quantities and every price.
//   4. THE LIVE RULE AGREES — send / receive / cancel (purchasing.js
//      lineMove) and re-order from a consistent state only ever land on
//      states the classifier calls agreeing; and a send that would claim
//      a line twice is refused.
//   5. NO RE-ORDER OF WHAT ARRIVED — after a partial delivery is cancelled,
//      generating POs from the list orders only what is still to come.
//   6. OPEN vs COMPLETED ORDERS (2026-10-03) — 6 received on one completed
//      PO and 4 on another is history, not a contradiction; only two OPEN
//      orders for one line are. Same price and different prices; the line
//      "need" with 4 still to order after the first 6; "have" after all 10.
//   7. MIXED PRICES — no repair ever locks one price on a line whose
//      receipts came at different prices; that is "needs a person".
//   8. MISSING SOURCES — a PO line whose list, or list line, is gone: a
//      draft is a mistake to fix (review, can't be sent); a sent, partly
//      received, received or cancelled PO is purchasing history (hold,
//      needs a person, counted in the totals); once the office reviews it,
//      a note.
//
// Run: node scripts/test-purchasing-matrix.mjs [--print]   (--print: the
// matrix as a table)

import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The missing-source checks write recovery holds to the store's holds
// file; whatever was there before is put back after each one.
import fs from "node:fs";
const HOLDS_FILE = path.join(ROOT, "server", "data", "purchasing-holds.json");
const HOLDS_BEFORE = fs.existsSync(HOLDS_FILE) ? fs.readFileSync(HOLDS_FILE) : null;
const clearHolds = () => { if (HOLDS_BEFORE) fs.writeFileSync(HOLDS_FILE, HOLDS_BEFORE); else fs.rmSync(HOLDS_FILE, { force: true }); };
const { auditPurchasingLines, formatPurchasingAudit } = require(path.join(ROOT, "server/lib/purchasing-audit.js"));
const purchasing = require(path.join(ROOT, "server/lib/purchasing.js"));
const purchaseOrders = require(path.join(ROOT, "server/lib/purchase-orders.js"));
const materialLists = require(path.join(ROOT, "server/lib/material-lists.js"));
const PO = purchaseOrders._internal;
const ML = materialLists._internal;

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error(`  FAIL: ${label}`); } };
const S = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(S(v));

// ── Building blocks ─────────────────────────────────────────────────────
const PRICE = 500;
const line = (status, { poId = null, frozen = status === "need" ? null : PRICE, qty = 10, id = "L" } = {}) =>
  ({ id, sku: "61146", qty, status, poId, frozenPriceCents: frozen, notes: "" });
const list = (lines, history = []) => ({ id: "ML-1", name: "Front", parentType: "project", parentId: "PRJ-1", status: "in_progress", lineItems: lines, history });
const claim = (lineId, qty, receivedQty, { id = "pl", price = PRICE } = {}) =>
  ({ id, sku: "61146", qty, receivedQty, unitPriceCents: price, sourceListId: "ML-1", sourceLineId: lineId });
const po = (id, status, lineItems) => ({ id, status, lineItems });

// The PO states, as (status, this line's receipt). PF has a second,
// still-outstanding line so the PO itself is partially received.
const PO_STATES = {
  "draft":                   (id = "P") => po(id, "draft", [claim("L", 10, 0)]),
  "sent":                    (id = "P") => po(id, "sent", [claim("L", 10, 0)]),
  "part-recvd, line part":   (id = "P") => po(id, "partially_received", [claim("L", 10, 4)]),
  "part-recvd, line full":   (id = "P") => po(id, "partially_received", [claim("L", 10, 10), { ...claim("OTHER", 3, 0, { id: "pl2" }) }]),
  "received":                (id = "P") => po(id, "received", [claim("L", 10, 10)]),
  "cancelled, none arrived": (id = "P") => po(id, "cancelled", [claim("L", 10, 0)]),
  "cancelled, part arrived": (id = "P") => po(id, "cancelled", [claim("L", 10, 4)]),
  "cancelled, all arrived":  (id = "P") => po(id, "cancelled", [claim("L", 10, 10)])
};
const LIST_STATES = {
  "need":            () => ({ lines: [line("need")], extra: [] }),
  "need, linked":    () => ({ lines: [line("need", { poId: "P" })], extra: [] }),
  "ordered on P":    () => ({ lines: [line("ordered", { poId: "P" })], extra: [] }),
  "ordered on Q":    () => ({ lines: [line("ordered", { poId: "Q" })], extra: [po("Q", "sent", [claim("L", 10, 0, { id: "q1" })])] }),
  "ordered on gone": () => ({ lines: [line("ordered", { poId: "GONE" })], extra: [] }),
  "have":            () => ({ lines: [line("have")], extra: [] })
};

// Expected: [kind | "agrees", severity, repairable]
const A = ["agrees", null, false];
const H = (kind, repairable = false) => [kind, "hold", repairable];
const R = (kind) => [kind, "review", false];
const EXPECT = {
  "need": {
    "draft": A, "sent": H("sent_never_marked", true), "part-recvd, line part": H("sent_never_marked", true),
    "part-recvd, line full": H("received_never_marked", true), "received": H("received_never_marked", true),
    "cancelled, none arrived": A, "cancelled, part arrived": A, "cancelled, all arrived": H("need_but_all_arrived")
  },
  "need, linked": Object.fromEntries(Object.keys(PO_STATES).map((k) => [k, H("need_with_po")])),
  "ordered on P": {
    "draft": H("ordered_on_draft"), "sent": A, "part-recvd, line part": A,
    "part-recvd, line full": H("received_still_ordered", true), "received": H("received_still_ordered", true),
    "cancelled, none arrived": H("cancelled_still_ordered", true), "cancelled, part arrived": H("cancelled_partial_still_ordered"),
    "cancelled, all arrived": H("received_still_ordered", true)
  },
  "ordered on Q": {
    // P complete for the line (all 10 in) + Q still open for 10 more: one
    // open order, so not a contradiction — but 10 more than needed.
    "draft": A, "sent": H("multiple_open_orders"), "part-recvd, line part": H("multiple_open_orders"),
    "part-recvd, line full": R("quantity_over"), "received": R("quantity_over"),
    "cancelled, none arrived": A, "cancelled, part arrived": R("quantity_over"), "cancelled, all arrived": R("quantity_over")
  },
  "ordered on gone": Object.fromEntries(Object.keys(PO_STATES).map((k) => [k, H("po_missing")])),
  "have": {
    "draft": A, "sent": H("have_but_po_outstanding"), "part-recvd, line part": H("have_but_po_outstanding"),
    "part-recvd, line full": A, "received": A,
    "cancelled, none arrived": H("have_without_delivery"), "cancelled, part arrived": H("have_without_delivery"),
    "cancelled, all arrived": A
  }
};

// Extra cases beyond the grid.
const EXTRA = [
  ["duplicate links on one PO", { purchaseOrders: [po("P", "sent", [claim("L", 10, 0), claim("L", 10, 0, { id: "pl-dup" })])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("duplicate_claim_on_po")],
  ["two live POs, list on neither", { purchaseOrders: [po("P", "sent", [claim("L", 10, 0)]), po("Q", "sent", [claim("L", 10, 0, { id: "q" })])], materialLists: [list([line("need")])] }, H("multiple_open_orders")],
  ["ordered on P, P has no line for it", { purchaseOrders: [po("P", "sent", [claim("OTHER", 3, 0)])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("not_on_po")],
  ["list recorded P cancelled; P still sent", { purchaseOrders: [po("P", "sent", [claim("L", 10, 0)])], materialLists: [list([line("need")], [{ ts: "2026-10-01T10:00:00Z", action: "po_cancelled", note: "P: 1 line" }])] }, H("list_ahead_of_po")],
  ["list recorded P received; P still sent", { purchaseOrders: [po("P", "sent", [claim("L", 10, 0)])], materialLists: [list([line("have")], [{ ts: "2026-10-01T10:00:00Z", action: "po_received", note: "P: 1 line" }])] }, H("list_ahead_of_po")],
  ["ordered 8 of the 10 needed", { purchaseOrders: [po("P", "sent", [claim("L", 8, 0)])], materialLists: [list([line("ordered", { poId: "P" })])] }, R("quantity_short")],
  ["ordered 12 for 10 (pack size)", { purchaseOrders: [po("P", "sent", [claim("L", 12, 0)])], materialLists: [list([line("ordered", { poId: "P" })])] }, A],
  ["received 8 of the 10 needed, list have", { purchaseOrders: [po("P", "received", [claim("L", 8, 8)])], materialLists: [list([line("have")])] }, R("quantity_short")],
  ["stock on hand, no PO", { purchaseOrders: [], materialLists: [list([line("have")])] }, A],
  ["partial cancelled, then ALL 10 re-ordered (what arrived ordered again)", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 4)]), po("P2", "sent", [claim("L", 10, 0, { id: "r" })])], materialLists: [list([line("ordered", { poId: "P2" })])] }, R("quantity_over")],
  ["partial cancelled + remainder re-ordered, list on the re-order", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 4)]), po("P2", "sent", [claim("L", 6, 0, { id: "r" })])], materialLists: [list([line("ordered", { poId: "P2" })])] }, A],
  ["partial cancelled + remainder re-ordered, list still on the cancelled PO", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 4)]), po("P2", "sent", [claim("L", 6, 0, { id: "r" })])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("points_to_other_po")],
  ["partial cancelled + remainder received, list have", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 4)]), po("P2", "received", [claim("L", 6, 6, { id: "r" })])], materialLists: [list([line("have")])] }, A],
  ["partial cancelled + remainder received, list still need", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 4)]), po("P2", "received", [claim("L", 6, 6, { id: "r" })])], materialLists: [list([line("need")])] }, H("received_never_marked", true)],
  ["locked price differs from the PO's", { purchaseOrders: [po("P", "received", [claim("L", 10, 10)])], materialLists: [list([line("ordered", { poId: "P", frozen: 999 })])] }, H("received_still_ordered", false)],
  ["PO line points at a list line that's gone (the list's own line unaffected)", { purchaseOrders: [po("P", "sent", [{ ...claim("GONE-LINE", 2, 0) }])], materialLists: [list([line("need")])] }, A],

  // ── 6. Open vs completed orders. Line L needs 10.
  //    P: 6 ordered, 6 received (complete). Q: 4 ordered.
  ["6 in on P (complete), list need — 4 still to order", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)])], materialLists: [list([line("need")])] }, A],
  ["6 in on P + 4 in on Q, same price, list have", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q" })])], materialLists: [list([line("have")])] }, A],
  ["6 in on P + 4 in on Q, P part of a partly received PO, list have", { purchaseOrders: [po("P", "partially_received", [claim("L", 6, 6), claim("OTHER", 3, 0, { id: "o" })]), po("Q", "received", [claim("L", 4, 4, { id: "q" })])], materialLists: [list([line("have")])] }, A],
  ["6 in on P + 4 in on Q, different prices, list have", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q", price: 600 })])], materialLists: [list([line("have", { frozen: 600 })])] }, R("mixed_receipt_prices")],
  ["6 in on P + 4 on order on Q, list ordered on Q", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "sent", [claim("L", 4, 0, { id: "q" })])], materialLists: [list([line("ordered", { poId: "Q" })])] }, A],
  ["6 in on P + 4 on order on Q, different prices, list ordered on Q", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "sent", [claim("L", 4, 0, { id: "q", price: 600 })])], materialLists: [list([line("ordered", { poId: "Q", frozen: 600 })])] }, A],
  ["6 in on P + 4 on order on Q, list still on completed P", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "sent", [claim("L", 4, 0, { id: "q" })])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("points_to_other_po")],
  ["6 in on P (complete), list still ordered on P", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("completed_still_ordered", true)],
  ["6 + 4 in, same price, list still ordered on Q", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q" })])], materialLists: [list([line("ordered", { poId: "Q" })])] }, H("received_still_ordered", true)],
  ["6 + 4 in, same price, list still need", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q" })])], materialLists: [list([line("need")])] }, H("received_never_marked", true)],
  ["two OPEN orders: 6 on P + 4 on Q, both sent, list on Q", { purchaseOrders: [po("P", "sent", [claim("L", 6, 0)]), po("Q", "sent", [claim("L", 4, 0, { id: "q" })])], materialLists: [list([line("ordered", { poId: "Q" })])] }, H("multiple_open_orders")],
  ["two OPEN orders: both part-received, list on P", { purchaseOrders: [po("P", "partially_received", [claim("L", 6, 2)]), po("Q", "partially_received", [claim("L", 4, 1, { id: "q" })])], materialLists: [list([line("ordered", { poId: "P" })])] }, H("multiple_open_orders")],
  ["6 in on P (complete) + TWO open orders for the rest", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "sent", [claim("L", 4, 0, { id: "q" })]), po("R", "sent", [claim("L", 4, 0, { id: "r" })])], materialLists: [list([line("ordered", { poId: "Q" })])] }, H("multiple_open_orders")],

  // ── 7. Mixed prices: never one price by rule.
  ["MIXED 6 @500 + 4 @600, list still ordered on Q", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q", price: 600 })])], materialLists: [list([line("ordered", { poId: "Q", frozen: 600 })])] }, H("received_still_ordered", false)],
  ["MIXED 6 @500 + 4 @600, list still need", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q", price: 600 })])], materialLists: [list([line("need")])] }, H("received_never_marked", false)],
  ["MIXED 6 @500 cancelled part + 4 @600, list need", { purchaseOrders: [po("P", "cancelled", [claim("L", 10, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q", price: 600 })])], materialLists: [list([line("need")])] }, H("received_never_marked", false)],
  ["MIXED 6 @500 + 4 @600, list have locked at 500", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q", price: 600 })])], materialLists: [list([line("have", { frozen: 500 })])] }, R("mixed_receipt_prices")],
  ["one price, list unlocked (null), still ordered on Q", { purchaseOrders: [po("P", "received", [claim("L", 6, 6)]), po("Q", "received", [claim("L", 4, 4, { id: "q" })])], materialLists: [list([line("ordered", { poId: "Q", frozen: null })])] }, H("received_still_ordered", true)]
];

// ── The browser snippet, run as the browser would run it ───────────────
const SNIPPET = execFileSync(process.execPath, [path.join(ROOT, "scripts/audit-po-list-lines.mjs"), "--browser"], { encoding: "utf8" });
async function runSnippet(state) {
  const printed = [];
  const urls = [];
  const ctx = vm.createContext({
    console: { log: (t) => printed.push(String(t)) },
    location: { host: "matrix.test" },
    fetch: async (url, opts) => {
      urls.push({ url, method: (opts && opts.method) || "GET" });
      const body = url.startsWith("/api/purchase-orders") ? { purchaseOrders: state.purchaseOrders }
        : url.startsWith("/api/admin/trash/") ? { ok: true, resource: "material-lists", records: state.materialLists.filter((l) => l.deletedAt) }
        : { lists: state.materialLists.filter((l) => !l.deletedAt) };
      return { ok: true, status: 200, json: async () => clone(body) };
    }
  });
  await vm.runInContext(SNIPPET, ctx);
  return { text: printed[0] || "", urls };
}

const rows = [];
async function check(name, state, [kind, severity, repairable]) {
  const before = S(state);
  const r = auditPurchasingLines(clone(state));
  const f = r.findings.find((x) => x.lineId === "L") || null;
  const got = f ? [f.kind, f.severity, f.repairable] : ["agrees", null, false];
  ok(S(got) === S([kind, severity, repairable]), `${name}: expected ${S([kind, severity, repairable])}, got ${S(got)}`);
  ok(S(state) === before, `${name}: the classifier changed nothing it read`);
  rows.push({ name, got });

  // 2. one definition: the snippet prints exactly the module's report.
  const snip = await runSnippet(state);
  const expected = formatPurchasingAudit(r) + "\nSource: matrix.test — " + state.purchaseOrders.length + " purchase orders, " + state.materialLists.length + " material lists (" + state.materialLists.filter((l) => l.deletedAt).length + " of them in the Trash)";
  ok(snip.text === expected, `${name}: the browser snippet prints the same report as the server classifier`);
  ok(snip.urls.length === 3 && snip.urls.every((u) => u.method === "GET" && u.url.startsWith("/api/")), `${name}: the snippet made only three same-site GETs`);

  // 3. a repair by rule leaves the line agreeing, changes no PO, keeps
  //    the quantities and the price paid.
  if (f && f.repairable) {
    const fixed = clone(state);
    const L = fixed.materialLists[0].lineItems.find((x) => x.id === "L");
    Object.assign(L, f.repair);
    const after = auditPurchasingLines(fixed);
    ok(!after.findings.some((x) => x.lineId === "L" && x.severity === "hold"), `${name}: the repair leaves the line agreeing (${S(after.findings.map((x) => x.kind))})`);
    ok(S(fixed.purchaseOrders) === S(state.purchaseOrders), `${name}: the repair touches no purchase order`);
    ok(Object.keys(f.repair).every((k) => ["status", "poId", "frozenPriceCents"].includes(k)), `${name}: the repair changes only status / poId / locked price`);
    const prices = new Set(state.purchaseOrders.flatMap((p) => p.lineItems.map((x) => x.unitPriceCents)));
    ok(f.repair.frozenPriceCents == null || prices.has(f.repair.frozenPriceCents), `${name}: any price the repair locks is one a PO actually records`);
    ok(f.line.frozenPriceCents == null || f.repair.frozenPriceCents === f.line.frozenPriceCents || f.repair.status === "need",
      `${name}: the repair never replaces a locked price with a different one`);
    // 7. Every receipt behind a line a repair marks "have" came at the one
    //    price it locks — mixed prices are never made one by rule.
    const receiptPrices = new Set(state.purchaseOrders.filter((p) => p.status !== "draft").flatMap((p) => p.lineItems)
      .filter((x) => x.sourceLineId === "L" && x.receivedQty > 0).map((x) => x.unitPriceCents));
    ok(f.repair.status !== "have" || (receiptPrices.size === 1 && receiptPrices.has(f.repair.frozenPriceCents)),
      `${name}: a "have" repair locks the single price every receipt came at (${S([...receiptPrices])} → ${f.repair.frozenPriceCents})`);
    ok(f.repair.frozenPriceCents == null || [...receiptPrices].every((p) => p === f.repair.frozenPriceCents),
      `${name}: no repair locks a price that differs from any receipt (${S([...receiptPrices])} → ${f.repair.frozenPriceCents})`);
  }
}

// ── 1–3: the grid and the extras ────────────────────────────────────────
for (const [ls, mk] of Object.entries(LIST_STATES)) {
  for (const [ps, mkPo] of Object.entries(PO_STATES)) {
    const { lines, extra } = mk();
    const state = { purchaseOrders: [mkPo("P"), ...extra], materialLists: [list(lines)] };
    await check(`list ${ls} × PO ${ps}`, state, EXPECT[ls][ps]);
  }
}
for (const [name, state, exp] of EXTRA) await check(name, state, exp);
// Every partial-cancel case is "needs a person" whenever it is a finding.
ok(rows.filter((r) => /cancelled, part arrived/.test(r.name) && r.got[0] !== "agrees").every((r) => r.got[2] === false),
  "every finding involving a cancelled, part-delivered PO is 'needs a person'");

// ── 4. The live rule lands only on agreeing states ─────────────────────
function step(state, poId, event, apply) {
  const p = state.purchaseOrders.find((x) => x.id === poId);
  const h = PO.hydrate(clone(p));
  apply(h);
  const plan = purchasing.planListMoves(h, state.materialLists, event, state.purchaseOrders);
  for (const w of plan.changedLists) state.materialLists[w.idx] = w.rec;
  state.purchaseOrders[state.purchaseOrders.indexOf(p)] = h;
  return state;
}
const clean = (state, label) => {
  const r = auditPurchasingLines(clone(state));
  ok(r.findings.length === 0, `live rule: ${label} — agrees (${S(r.findings.map((f) => f.kind))})`);
};
const fresh = (qty = 10) => ({
  purchaseOrders: [PO.hydrate({ id: "P", status: "draft", lineItems: [claim("L", qty, 0)] })],
  materialLists: [ML.hydrate(list([line("need", { qty })]))]
});
const send = (s, id = "P") => step(s, id, "sent", (h) => PO.transitionSent(h, { toEmail: "x@y.test" }));
const recv = (s, upd, id = "P") => step(s, id, "received", (h) => PO.transitionReceived(h, { lineUpdates: upd }));
const cancel = (s, id = "P") => step(s, id, "cancelled", (h) => PO.transitionCancelled(h, {}));
{
  let s = fresh(); clean(s, "a draft");
  send(s); clean(s, "sent");
  recv(s, { pl: 4 }); clean(s, "4 of 10 arrived");
  recv(s, null); clean(s, "the rest arrived");
}
{
  let s = fresh(); send(s); cancel(s); clean(s, "sent, then cancelled before anything arrived");
}
{
  let s = fresh(); send(s); recv(s, { pl: 4 }); cancel(s);
  clean(s, "4 of 10 arrived, then cancelled");
  const L = ML.hydrateLine(s.materialLists[0].lineItems[0]);
  ok(L.status === "need", "live rule: after a part-delivered cancel the line is 'need' — for the rest");
  // 5. Generating POs from the list now orders only what is still to come.
  const plan = purchaseOrders.planDraftsFromMaterialList(ML.hydrate(s.materialLists[0]), { 61146: { priceCents: PRICE, supplierIds: ["SUP"] } },
    { committed: purchaseOrders.commitmentsByListLine(s.purchaseOrders, "ML-1") });
  const ordered = plan.drafts.flatMap((d) => d.lineItems).filter((l) => l.sourceLineId === "L").map((l) => l.qty);
  ok(S(ordered) === S([6]), `no re-order of what arrived: generating from the list orders 6, not 10 (${S(ordered)})`);
  const before = purchaseOrders.planDraftsFromMaterialList(ML.hydrate(s.materialLists[0]), { 61146: { priceCents: PRICE, supplierIds: ["SUP"] } });
  ok(before.drafts[0].lineItems[0].qty === 10, "…(the old arithmetic, without what arrived, would have ordered all 10 again)");
  // The remainder ordered, sent and received: agrees at every step.
  s.purchaseOrders.push(PO.hydrate({ id: "P2", status: "draft", lineItems: [claim("L", 6, 0, { id: "r" })] }));
  clean(s, "the remainder drafted");
  send(s, "P2"); clean(s, "the remainder sent");
  recv(s, null, "P2"); clean(s, "the remainder arrived — 4 + 6 = 10");
  ok(ML.hydrateLine(s.materialLists[0].lineItems[0]).status === "have", "live rule: the line ends 'have'");
}
{
  // A PO with two lines, one arriving in full first.
  const s = {
    purchaseOrders: [PO.hydrate({ id: "P", status: "draft", lineItems: [claim("L", 10, 0), claim("M", 2, 0, { id: "pm" })] })],
    materialLists: [ML.hydrate(list([line("need"), line("need", { id: "M", qty: 2 })]))]
  };
  send(s); recv(s, { pl: 10 }); clean(s, "two lines, one complete");
  recv(s, null); clean(s, "two lines, both complete");
}
{
  // A send that would claim a line already on another live PO, or already
  // received, or twice on one PO, is refused before anything moves.
  const refuse = (state, label) => {
    let code = null;
    try { purchasing.assertLinesOrderable(PO.hydrate(state.purchaseOrders[0]), state.purchaseOrders, state.materialLists); } catch (e) { code = e.code; }
    ok(code === "lines_not_orderable", `live rule: sending is refused — ${label} (${code})`);
  };
  refuse({ purchaseOrders: [po("P", "draft", [claim("L", 10, 0)]), po("Q", "sent", [claim("L", 10, 0, { id: "q" })])], materialLists: [list([line("ordered", { poId: "Q" })])] }, "the line is already ordered on another PO");
  refuse({ purchaseOrders: [po("P", "draft", [claim("L", 10, 0)])], materialLists: [list([line("have")])] }, "the line is already received");
  refuse({ purchaseOrders: [po("P", "draft", [claim("L", 10, 0), claim("L", 10, 0, { id: "d" })])], materialLists: [list([line("need")])] }, "two lines of the PO claim the same list line");
  refuse({ purchaseOrders: [po("P", "draft", [claim("L", 10, 0)]), po("Q", "sent", [claim("L", 10, 0, { id: "q" })])], materialLists: [list([line("need")])] }, "another live PO already claims the line, though the list lost track");
}

// ── 6/7 continued: mixed prices are never repaired, whatever the state ──
{
  const mixedRows = rows.filter((r) => r.name.startsWith("MIXED"));
  ok(mixedRows.length === 4 && mixedRows.every((r) => r.got[2] === false), `every mixed-price case is "needs a person" (${S(mixedRows.map((r) => r.got))})`);
  // Exhaustively: P (6 @500) and Q (4 @600) in every PO state × every list
  // state — no finding anywhere offers a repair that locks a price.
  let tried = 0, offered = [];
  for (const [ps, mkP] of Object.entries(PO_STATES)) for (const [qs, mkQ] of Object.entries(PO_STATES)) {
    for (const ls of ["need", "ordered on P", "have"]) {
      const P = mkP("P"); P.lineItems[0] = { ...P.lineItems[0], qty: 6, receivedQty: Math.min(6, P.lineItems[0].receivedQty) };
      const Q = mkQ("Q"); Q.lineItems = Q.lineItems.map((x) => ({ ...x, id: "q-" + x.id, unitPriceCents: 600 })); Q.lineItems[0] = { ...Q.lineItems[0], qty: 4, receivedQty: Math.min(4, Q.lineItems[0].receivedQty) };
      const st = { purchaseOrders: [P, Q], materialLists: [list([LIST_STATES[ls]().lines[0]])] };
      const both = [P, Q].every((p) => p.status !== "draft" && p.lineItems[0].receivedQty > 0);
      if (!both) continue;
      tried += 1;
      for (const f of auditPurchasingLines(st).findings) if (f.repair && f.repair.frozenPriceCents != null) offered.push(`${ps} + ${qs} / ${ls}: ${f.kind}`);
    }
  }
  ok(tried > 20 && offered.length === 0, `mixed prices: ${tried} combinations, no repair locks a price (${S(offered.slice(0, 3))})`);
}

// ── 6 continued: the live rule through two orders for one line ─────────
for (const secondPrice of [PRICE, 600]) {
  const tag = secondPrice === PRICE ? "same price" : "different prices";
  const s = fresh();
  s.purchaseOrders[0].lineItems[0].qty = 6;
  send(s);
  const short = auditPurchasingLines(clone(s)).findings;
  ok(S(short.map((f) => [f.kind, f.severity])) === S([["quantity_short", "review"]]), `${tag}: the first order, for 6 of 10, sent — no contradiction; 6 on order for 10 needed is flagged for review (${S(short.map((f) => f.kind))})`);
  recv(s, null); clean(s, `${tag}: 6 of 10 arrived on it — complete`);
  const after6 = ML.hydrateLine(s.materialLists[0].lineItems[0]);
  ok(after6.status === "need" && after6.poId == null, `${tag}: after the first 6 the line is "need" on no order (${after6.status})`);
  const c = purchaseOrders.commitmentsByListLine(s.purchaseOrders, "ML-1");
  ok(purchaseOrders.stillToOrder(after6, c) === 4, `${tag}: exactly 4 still to order (${purchaseOrders.stillToOrder(after6, c)})`);
  const plan = purchaseOrders.planDraftsFromMaterialList(ML.hydrate(s.materialLists[0]), { 61146: { priceCents: secondPrice, supplierIds: ["SUP"] } }, { committed: c });
  ok(S(plan.drafts.flatMap((d) => d.lineItems).map((l) => l.qty)) === S([4]), `${tag}: generating from the list proposes 4`);
  // The send gate: 4 more is allowed (P is complete, not open); 5 is not.
  const draft = (qty) => PO.hydrate({ id: "Q", status: "draft", lineItems: [claim("L", qty, 0, { id: "q", price: secondPrice })] });
  let code = null;
  try { purchasing.assertLinesOrderable(draft(4), s.purchaseOrders, s.materialLists); } catch (e) { code = e.code; }
  ok(code === null, `${tag}: sending the second order for 4 is allowed — the first is complete, not open (${code})`);
  code = null;
  try { purchasing.assertLinesOrderable(draft(5), s.purchaseOrders, s.materialLists); } catch (e) { code = e.code; }
  ok(code === "lines_not_orderable", `${tag}: an order for 5 would re-order what came — refused (${code})`);
  s.purchaseOrders.push(draft(4));
  send(s, "Q"); clean(s, `${tag}: the second order, for 4, sent`);
  recv(s, null, "Q");
  const end = ML.hydrateLine(s.materialLists[0].lineItems[0]);
  ok(end.status === "have" && end.poId == null, `${tag}: all 10 arrived — the line is "have" (${end.status})`);
  const r = auditPurchasingLines(clone(s));
  if (secondPrice === PRICE) ok(r.findings.length === 0, `${tag}: all 10 in — agrees (${S(r.findings.map((f) => f.kind))})`);
  else {
    ok(S(r.findings.map((f) => [f.kind, f.severity, f.repairable])) === S([["mixed_receipt_prices", "review", false]]),
      `${tag}: all 10 in — no contradiction, but the mixed prices are flagged for a person (${S(r.findings.map((f) => f.kind))})`);
    ok(S(s.purchaseOrders.map((p) => [p.id, p.lineItems[0].receivedQty, p.lineItems[0].unitPriceCents])) === S([["P", 6, 500], ["Q", 4, 600]]),
      `${tag}: each PO keeps what arrived on it and at what price`);
  }
}

// ── 8. Missing sources ──────────────────────────────────────────────────
{
  const SRC_STATES = { "draft": [0, "draft"], "sent": [0, "sent"], "partially received": [4, "partially_received"], "received": [10, "received"], "cancelled": [4, "cancelled"] };
  for (const [gone, mkClaim] of [["list", () => ({ ...claim("L", 10, 0), sourceListId: "ML-GONE" })], ["line", () => claim("L-GONE", 10, 0)]]) {
    for (const [label, [got, status]] of Object.entries(SRC_STATES)) {
      const st = { purchaseOrders: [po("P", status, [{ ...mkClaim(), receivedQty: got }])], materialLists: [list([line("need", { id: "OTHER" })])] };
      const r = auditPurchasingLines(clone(st));
      const f = r.findings.find((x) => x.poId === "P");
      const want = status === "draft" ? ["draft_source_missing", "review", false] : ["source_missing", "hold", false];
      ok(f && S([f.kind, f.severity, f.repairable]) === S(want), `missing ${gone} × PO ${label}: ${S(want)} (${S(f && [f.kind, f.severity, f.repairable])})`);
      ok(r.totals.lines === 1 && r.totals.needsAPerson === 1 && r.totals.purchaseOrders === 1 && r.totals[want[1]] === 1,
        `missing ${gone} × PO ${label}: counted in the totals (${S(r.totals)})`);
      ok(f && f.quantities.received === got && f.claims[0].unitPriceCents === PRICE, `missing ${gone} × PO ${label}: the report keeps what arrived and its price`);
      ok(f && f.listMissing === (gone === "list"), `missing ${gone} × PO ${label}: says whether the list or just the line is gone`);
      const text = formatPurchasingAudit(r);
      ok(/no longer exists/.test(text) && (status === "draft" ? /can't be sent/.test(text) : /locked until the office reviews it/.test(text)),
        `missing ${gone} × PO ${label}: the report says ${status === "draft" ? "the draft can't be sent" : "the PO is locked for review"}`);
      // Reviewed by the office: a note, not a finding.
      if (status !== "draft") {
        const ack = clone(st); ack.purchaseOrders[0].lineItems[0].sourceMissingAcknowledged = { at: "2026-10-03T12:00:00Z", by: "patrick", note: "Old job, deleted by mistake; parts used" };
        const ra = auditPurchasingLines(ack);
        ok(ra.findings.length === 0 && ra.notes.length === 1 && ra.notes[0].kind === "source_missing_acknowledged", `missing ${gone} × PO ${label}: once reviewed, a note only`);
      }
      // A draft with a missing source can't be sent.
      if (status === "draft") {
        let code = null, msg = "";
        try { purchasing.assertLinesOrderable(PO.hydrate(st.purchaseOrders[0]), st.purchaseOrders, st.materialLists); } catch (e) { code = e.code; msg = e.message; }
        ok(code === "lines_not_orderable" && /no longer/.test(msg), `missing ${gone} × draft: sending is refused (${code})`);
      }
      // A non-draft one is locked before any lifecycle step.
      if (status !== "draft") {
        const before = S(st);
        let code = null;
        const { readHolds } = require(path.join(ROOT, "server/lib/purchasing-store.js"));
        try { purchaseOrders.assertSourcesPresent(PO.hydrate(st.purchaseOrders[0]), st.materialLists); } catch (e) { code = e.code; }
        ok(code === "recovery_required" && readHolds().some((h) => h.scope === "purchase_order" && h.id === "P" && h.source === "source_missing"),
          `missing ${gone} × PO ${label}: any further action is refused and the PO is held (${code})`);
        ok(S(st) === before, `missing ${gone} × PO ${label}: nothing is changed`);
        const ackd = clone(st); ackd.purchaseOrders[0].lineItems[0].sourceMissingAcknowledged = { at: "x", by: "y", note: "z" };
        let code2 = null;
        try { purchaseOrders.assertSourcesPresent(PO.hydrate(ackd.purchaseOrders[0]), ackd.materialLists); } catch (e) { code2 = e.code; }
        ok(code2 === null, `missing ${gone} × PO ${label}: once reviewed, the source check passes`);
        clearHolds();
      }
    }
  }
}

{
  // A draft in the Trash orders nothing: its missing source isn't reported.
  const st = { purchaseOrders: [{ ...po("P", "draft", [{ ...claim("L", 10, 0), sourceListId: "ML-GONE" }]), deletedAt: "2026-10-01T00:00:00Z" }], materialLists: [list([line("need", { id: "OTHER" })])] };
  ok(auditPurchasingLines(st).findings.length === 0, "missing list × draft in the Trash: not reported");
}

if (process.argv.includes("--print")) {
  const kinds = Object.keys(PO_STATES);
  const cell = (g) => g[0] === "agrees" ? "agrees" : `${g[0]} · ${g[1] === "hold" ? "HOLD" : "review"} · ${g[2] ? "rule" : "person"}`;
  console.log(`| list ↓ / PO → | ${kinds.join(" | ")} |`);
  console.log(`|---|${kinds.map(() => "---").join("|")}|`);
  for (const ls of Object.keys(LIST_STATES)) {
    console.log(`| ${ls} | ${kinds.map((k) => cell(rows.find((r) => r.name === `list ${ls} × PO ${k}`).got)).join(" | ")} |`);
  }
  console.log("");
  for (const [name] of EXTRA) console.log(`- ${name}: ${cell(rows.find((r) => r.name === name).got)}`);
}

console.log(`\npurchasing matrix: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

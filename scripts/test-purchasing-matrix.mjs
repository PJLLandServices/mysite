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
    "draft": A, "sent": H("multiple_active_claims"), "part-recvd, line part": H("multiple_active_claims"),
    "part-recvd, line full": H("multiple_active_claims"), "received": H("multiple_active_claims"),
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
  ["two live POs, list on neither", { purchaseOrders: [po("P", "sent", [claim("L", 10, 0)]), po("Q", "sent", [claim("L", 10, 0, { id: "q" })])], materialLists: [list([line("need")])] }, H("multiple_active_claims")],
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
  ["PO line points at a list line that's gone", { purchaseOrders: [po("P", "sent", [{ ...claim("GONE-LINE", 2, 0) }])], materialLists: [list([line("need")])] }, A]
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
      const body = url.startsWith("/api/purchase-orders") ? { purchaseOrders: state.purchaseOrders } : { lists: state.materialLists };
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
  const expected = formatPurchasingAudit(r) + "\nSource: matrix.test — " + state.purchaseOrders.length + " purchase orders, " + state.materialLists.length + " material lists (Trash not included)";
  ok(snip.text === expected, `${name}: the browser snippet prints the same report as the server classifier`);
  ok(snip.urls.length === 2 && snip.urls.every((u) => u.method === "GET" && u.url.startsWith("/api/")), `${name}: the snippet made only two same-site GETs`);

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
  const plan = purchasing.planListMoves(h, state.materialLists, event);
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
    { received: purchaseOrders.receivedByListLine(s.purchaseOrders, "ML-1") });
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

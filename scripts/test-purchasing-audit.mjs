#!/usr/bin/env node
// scripts/test-purchasing-audit.mjs
//
// The read-only PO / material-list audit (server/lib/purchasing-audit.js):
// every kind of disagreement is found, each repair is the one the
// one-commit rule (purchasing.js lineMove) would have made, agreeing lines
// are not reported, and the audit never changes its input.
//
// Run: node scripts/test-purchasing-audit.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { auditPurchasingLines, formatPurchasingAudit } = require("../server/lib/purchasing-audit.js");
const { lineMove } = require("../server/lib/purchasing.js");

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error(`  FAIL: ${label}`); } };
const S = (v) => JSON.stringify(v);

const L = (id, status, poId = null, frozenPriceCents = null) => ({ id, sku: `S-${id}`, qty: 4, status, poId, frozenPriceCents });
const P = (id, status, lines) => ({ id, status, lineItems: lines.map(([lineId, qty, receivedQty]) => ({ id: `pl-${lineId}`, sku: `S-${lineId}`, qty, receivedQty, unitPriceCents: 250, sourceListId: "ML-1", sourceLineId: lineId })) });

const materialLists = [{
  id: "ML-1", name: "Front", parentType: "project", parentId: "PRJ-1",
  lineItems: [
    L("ok-ordered", "ordered", "PO-SENT", 250),     // agrees: outstanding on a sent PO
    L("ok-have", "have", null, 250),                // agrees: received
    L("recv-stuck", "ordered", "PO-RECV", 250),     // received in full, still ordered
    L("canc-stuck", "ordered", "PO-CANC", 250),     // cancelled before arrival, still ordered
    L("canc-got", "ordered", "PO-CANC", 250),       // arrived in full before the cancel, still ordered
    L("sent-need", "need"),                          // PO out, list never told
    L("recv-need", "need"),                          // arrived, list never told
    L("ghost", "ordered", "PO-NOPE", 250),           // names a PO that doesn't exist
    L("not-on", "ordered", "PO-SENT", 250),          // PO-SENT has no line for it
    L("draft", "ordered", "PO-DRAFT", 250)           // ordered on a PO never sent
  ]
}, {
  // The list's half of a receipt saved; the PO's half lost.
  id: "ML-3", name: "Ahead", parentType: "project", parentId: "PRJ-1",
  history: [{ ts: "2026-10-01T00:00:00Z", action: "po_received", note: "PO-LOST: 1 line" }],
  lineItems: [L("ahead", "have", null, 250)]
}, { id: "ML-2", name: "Other", parentType: "work_order", parentId: "WO-1", lineItems: [] }];
const purchaseOrders = [
  P("PO-SENT", "sent", [["ok-ordered", 4, 0], ["sent-need", 4, 0]]),
  P("PO-RECV", "received", [["recv-stuck", 4, 4], ["recv-need", 4, 4], ["ok-have", 4, 4]]),
  P("PO-CANC", "cancelled", [["canc-stuck", 4, 1], ["canc-got", 4, 4]]),
  P("PO-DRAFT", "draft", [["draft", 4, 0]]),
  { id: "PO-LOST", status: "sent", lineItems: [{ id: "pl-ahead", sku: "S-ahead", qty: 4, receivedQty: 0, unitPriceCents: 250, sourceListId: "ML-3", sourceLineId: "ahead" }] },
  { id: "PO-GONE", status: "sent", lineItems: [{ id: "x", sku: "S-x", qty: 1, receivedQty: 0, unitPriceCents: 1, sourceListId: "ML-9", sourceLineId: "nope" }] }
];

const input = S({ purchaseOrders, materialLists });
const r = auditPurchasingLines({ purchaseOrders, materialLists });
ok(S({ purchaseOrders, materialLists }) === input, "the audit does not change what it reads");
const by = Object.fromEntries(r.findings.map((f) => [f.lineId, f]));
const expect = {
  "recv-stuck": ["received_still_ordered", { status: "have", poId: null }],
  "canc-stuck": ["cancelled_still_ordered", { status: "need", poId: null, frozenPriceCents: null }],
  "canc-got": ["received_still_ordered", { status: "have", poId: null }],
  "sent-need": ["sent_never_marked", { status: "ordered", poId: "PO-SENT", frozenPriceCents: 250 }],
  "recv-need": ["received_never_marked", { status: "have", poId: null, frozenPriceCents: 250 }],
  "ghost": ["po_missing", null],
  "not-on": ["not_on_po", null],
  "draft": ["ordered_on_draft", null],
  "ahead": ["list_ahead_of_po", null]
};
for (const [lineId, [kind, repair]] of Object.entries(expect)) {
  ok(by[lineId] && by[lineId].kind === kind, `${lineId}: found as ${kind} (${by[lineId]?.kind})`);
  ok(by[lineId] && S(by[lineId].repair) === S(repair), `${lineId}: repair ${S(repair)} (${S(by[lineId]?.repair)})`);
}
ok(!by["ok-ordered"] && !by["ok-have"], "lines that agree with their PO are not reported");
ok(r.findings.length === Object.keys(expect).length, `exactly the disagreeing lines are reported (${r.findings.length})`);
ok(r.notes.length === 1 && r.notes[0].poId === "PO-GONE", "a sent PO line whose list line is gone is noted for information, not as a disagreement");
ok(S(r.totals) === S({ projects: 1, materialLists: 2, purchaseOrders: 6, lines: 9, repairable: 5, needsAPerson: 4 }), `totals (${S(r.totals)})`);
ok(r.findings.every((f) => f.projectId === "PRJ-1"), "each finding names its project");

// Each repair is exactly what the one-commit rule makes of the same line.
for (const lineId of ["recv-stuck", "canc-stuck", "canc-got"]) {
  const f = by[lineId];
  const po = purchaseOrders.find((p) => p.id === f.poId);
  const pl = po.lineItems.find((l) => l.sourceLineId === lineId);
  const line = materialLists[0].lineItems.find((l) => l.id === lineId);
  ok(S(lineMove(po, pl, line, "received")) === S(f.repair), `${lineId}: the audit's repair matches purchasing.lineMove`);
}
ok(S(lineMove(purchaseOrders[0], purchaseOrders[0].lineItems[1], materialLists[0].lineItems[5], "sent")) === S(by["sent-need"].repair),
  "sent-need: the audit's repair matches what sending moves");

const text = formatPurchasingAudit(r);
ok(/read-only — nothing was changed/.test(text) && /Affected: 1 project\(s\), 2 material list\(s\), 6 purchase order\(s\), 9 line\(s\)/.test(text), "the report states the totals and that nothing was changed");

console.log(`\npurchasing audit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Unit tests for line-item display order on the quotation (2026-08).
//
// Patrick arranges the stack — flow meter, controller or mainline to the top,
// anywhere he wants — independent of creation order or zone number, and that
// sequence has to reach the PDF and the HTML proposal page identically.
//
// The invariants that matter most here are the NEGATIVE ones: reordering is
// display-only, so it must not move a zone number, a quantity, a price, the
// subtotal, the HST or the total, and it must not rename or renumber a zone.
// Those are asserted directly rather than assumed.
//
// No server, no disk writes. Run: node scripts/test-line-item-order.mjs

import { createRequire } from "node:module";
import zlib from "node:zlib";
const require = createRequire(import.meta.url);
const { orderedLineItems, orderedLineItemsWithIndex } = require("../server/lib/line-item-order.js");
const { normalizeProposalLineItems, normalizeProposalLineItem } = require("../server/lib/quotes.js");
const { renderProjectProposalPdf } = require("../server/lib/quote-pdf.js");
const { buildProposalData } = require("../server/lib/proposal-data.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
const labels = (arr) => arr.map((l) => l.label).join(" | ");

// ---- the sort ---------------------------------------------------------
const arranged = {
  lineItems: [
    { label: "Mainline", order: 2 },
    { label: "Controller", order: 0 },
    { label: "Zone 7", order: 1 }
  ]
};
eq(labels(orderedLineItems(arranged)), "Controller | Zone 7 | Mainline", "explicit order drives the sequence");

// A record that pre-dates the field renders exactly as it always did.
const legacy = { lineItems: [{ label: "a" }, { label: "b" }, { label: "c" }] };
eq(labels(orderedLineItems(legacy)), "a | b | c", "no order anywhere: array position preserved");

// Mixed — a half-migrated record must still be deterministic.
const mixed = { lineItems: [{ label: "a" }, { label: "b", order: -1 }, { label: "c" }] };
eq(labels(orderedLineItems(mixed)), "b | a | c", "explicit order sorts against positional fallback");

// Duplicate order values must not shuffle non-deterministically.
const dupes = { lineItems: [{ label: "x", order: 1 }, { label: "y", order: 1 }, { label: "z", order: 0 }] };
eq(labels(orderedLineItems(dupes)), "z | x | y", "duplicate order: array position breaks the tie");

// Renderers get the live quote record — sorting must not mutate it.
const live = { lineItems: [{ label: "Mainline", order: 2 }, { label: "Controller", order: 0 }] };
const before = live.lineItems.map((l) => l.label).join(",");
orderedLineItems(live);
eq(live.lineItems.map((l) => l.label).join(","), before, "sorting does not mutate the stored array");

eq(orderedLineItems({}).length, 0, "missing lineItems tolerated");
eq(orderedLineItems(null).length, 0, "null quote tolerated");

// The builder needs the STORED index to stay attached to each row.
const withIdx = orderedLineItemsWithIndex(arranged);
eq(withIdx.map((e) => e.idx).join(","), "1,2,0", "stored index rides along with the display order");

// ---- storage: normalizeProposalLineItems ------------------------------
// The case that motivated an explicit field: a Site Builder re-sync appends a
// brand-new zone to a stack that has already been arranged by hand.
const resynced = normalizeProposalLineItems([
  { label: "Mainline", order: 2, price: 100, qty: 1 },
  { label: "Controller", order: 0, price: 50, qty: 1 },
  { label: "Zone 7", order: 1, price: 10, qty: 1 },
  { label: "Zone 8", price: 10, qty: 1 }            // new — no order yet
]);
eq(labels(resynced), "Controller | Zone 7 | Mainline | Zone 8", "arrangement survives; a new line appends last");
eq(resynced.map((l) => l.order).join(","), "0,1,2,3", "orders renumber densely to 0..n-1");

// Several new lines keep their relative arrival order at the end.
const twoNew = normalizeProposalLineItems([
  { label: "first new" }, { label: "arranged", order: 0 }, { label: "second new" }
]);
eq(labels(twoNew), "arranged | first new | second new", "multiple new lines append in arrival order");

const legacySave = normalizeProposalLineItems([{ label: "a" }, { label: "b" }, { label: "c" }]);
eq(labels(legacySave), "a | b | c", "a legacy set keeps its order and gets stamped");
eq(legacySave.map((l) => l.order).join(","), "0,1,2", "legacy set stamped 0..n-1, nothing moves");
// projects.js seeds scope-change lines with the SINGLE-item normalizer, which
// has no index to work from. Such a line must arrive with NO opinion about
// order so it appends behind an arranged stack instead of claiming the top.
const seeded = normalizeProposalLineItem({ label: "SCR add" });
ok(!Object.prototype.hasOwnProperty.call(seeded, "order"),
   "a line normalized without an index carries no order key");
eq(labels(normalizeProposalLineItems([
  { label: "Flow meter", order: 0 }, { label: "Zone 7", order: 1 },
  normalizeProposalLineItem({ label: "SCR add A" }), normalizeProposalLineItem({ label: "SCR add B" })
])), "Flow meter | Zone 7 | SCR add A | SCR add B",
   "scope-change lines append behind an arranged stack, in order");

eq(normalizeProposalLineItems([]).length, 0, "empty set tolerated");
eq(normalizeProposalLineItems(null).length, 0, "non-array tolerated");

// ---- display-only: the money and the zones cannot move ----------------
const stack = [
  { label: "Zone 7 — Front lawn", qty: 3, price: 410.5, unit: "per_zone" },
  { label: "Hunter Hydrawise flow meter", qty: 1, price: 780 },
  { label: "System mainline", qty: 1, price: 1250.25 },
  { label: "Smart controller", qty: 1, price: 965 }
];
const asCreated = normalizeProposalLineItems(stack);
// Flow meter to the top, mainline second — the motion Patrick asked for.
const rearranged = normalizeProposalLineItems([
  { ...asCreated[1], order: 0 },
  { ...asCreated[2], order: 1 },
  { ...asCreated[3], order: 2 },
  { ...asCreated[0], order: 3 }
]);
eq(labels(rearranged), "Hunter Hydrawise flow meter | System mainline | Smart controller | Zone 7 — Front lawn",
   "the flow meter moves to the top of the stack");

const sum = (arr) => Math.round(arr.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100;
eq(sum(rearranged), sum(asCreated), "subtotal is identical after reordering");
const byLabel = (arr) => arr
  .map((l) => `${l.label}::${l.qty}@${l.price}=${l.lineTotal}`)
  .sort().join("\n");
eq(byLabel(rearranged), byLabel(asCreated), "every line keeps its qty, unit price and line total");
eq(rearranged.map((l) => l.label).sort().join("|"), asCreated.map((l) => l.label).sort().join("|"),
   "no line is renamed, added or dropped — zone labels untouched");
ok(rearranged.some((l) => l.label === "Zone 7 — Front lawn"), "\"Zone 7\" is still Zone 7 after moving to last");

// ---- the PDF renders in the arranged order ----------------------------
function renderToBuffer(quote) {
  return new Promise((resolve, reject) => {
    const doc = renderProjectProposalPdf(quote, { customer: { name: "GreenTree Construction Inc." }, property: {} });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
// Visible text out of a pdfkit document (Flate content streams; the standard
// fonts write plain-ASCII hex inside TJ arrays).
function pdfText(buf) {
  const s = buf.toString("latin1");
  let i = 0, out = "";
  for (;;) {
    const a = s.indexOf("stream", i);
    if (a < 0) break;
    let b = a + "stream".length;
    if (s[b] === "\r") b++;
    if (s[b] === "\n") b++;
    const e = s.indexOf("endstream", b);
    if (e < 0) break;
    let raw = buf.subarray(b, e);
    try { raw = zlib.inflateSync(raw); } catch { i = e + 9; continue; }
    for (const m of raw.toString("latin1").matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], "hex").toString("latin1");
      out += "\n";
    }
    i = e + 9;
  }
  return out;
}
const baseQuote = {
  id: "Q-2026-0067", version: 1, type: "project_proposal", branch: "gc_subcontract",
  status: "draft", createdAt: "2026-08-10T14:00:00.000Z", validUntil: "2026-11-08",
  scope: "Stack order", customerEmail: "ap@greentree.example",
  proposalSections: [], attachments: [], deposit: { enabled: false },
  pdfOptions: { lineItems: "itemized", showAttachments: true, showProjectMap: true },
  subtotal: 3227.75, hst: 419.61, total: 3647.36
};
// Row order in the PDF = the order the labels appear in the extracted text.
// Probes are ASCII-safe substrings: pdfkit writes WinAnsi, where an em dash
// is byte 0x97 and does not survive the latin1 round-trip this extractor
// does. The full label is asserted intact on the record itself above.
const WANT = ["Zone 7", "Hunter Hydrawise flow meter", "System mainline", "Smart controller"];
function rowSequence(text, wanted) {
  return wanted
    .map((label) => ({ label, at: text.indexOf(label) }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((e) => e.label)
    .join(" | ");
}

const createdText = pdfText(await renderToBuffer({ ...baseQuote, lineItems: asCreated }));
const movedText = pdfText(await renderToBuffer({ ...baseQuote, lineItems: rearranged }));

eq(rowSequence(createdText, WANT), "Zone 7 | Hunter Hydrawise flow meter | System mainline | Smart controller",
   "PDF renders the as-created order");
eq(rowSequence(movedText, WANT), "Hunter Hydrawise flow meter | System mainline | Smart controller | Zone 7",
   "PDF renders the arranged order — flow meter first");
for (const label of WANT) ok(movedText.includes(label), `PDF still contains "${label}" verbatim`);
ok(movedText.includes("Subtotal") && movedText.includes("Total CAD"), "totals block still renders");

// A record with no order at all renders exactly as it did before the field.
const noOrder = pdfText(await renderToBuffer({ ...baseQuote, lineItems: stack }));
eq(rowSequence(noOrder, WANT), "Zone 7 | Hunter Hydrawise flow meter | System mainline | Smart controller",
   "legacy record with no order renders unchanged");

// ---- the HTML proposal page uses the same order -----------------------
const parties = { customer: { name: "GreenTree Construction Inc." }, property: { address: "Dundalk, ON" } };
const dCreated = buildProposalData({ ...baseQuote, lineItems: asCreated }, { ...parties, templateKey: "irrigation" });
const dMoved = buildProposalData({ ...baseQuote, lineItems: rearranged }, { ...parties, templateKey: "irrigation" });
eq(dCreated.schedule.rows.map((r) => r.cls).join(" | "),
   "Zone 7 — Front lawn | Hunter Hydrawise flow meter | System mainline | Smart controller",
   "proposal page: as-created order");
eq(dMoved.schedule.rows.map((r) => r.cls).join(" | "),
   "Hunter Hydrawise flow meter | System mainline | Smart controller | Zone 7 — Front lawn",
   "proposal page: same arranged order as the PDF");
eq(dMoved.schedule.subtotal, dCreated.schedule.subtotal, "proposal page subtotal unchanged by reordering");
eq(dMoved.schedule.hst, dCreated.schedule.hst, "proposal page HST unchanged by reordering");
eq(dMoved.schedule.total, dCreated.schedule.total, "proposal page total unchanged by reordering");
// Qty travels with the line, not the slot.
eq(dMoved.schedule.rows.find((r) => r.cls === "Zone 7 — Front lawn").qty,
   dCreated.schedule.rows.find((r) => r.cls === "Zone 7 — Front lawn").qty,
   "a moved line keeps its own Qty");

// ---- the builder's own copy of the sort ------------------------------
//
// quote-proposal-builder.js runs in the browser and cannot require
// lib/line-item-order.js, so it carries its own comparator. Duplication is
// the real risk in this feature: if the two ever disagree, the editor and
// the PDF show different orders — exactly what this change exists to
// prevent. So pull the SHIPPED functions out of the file and run them
// against the same fixtures the server side was checked with.
import { readFileSync } from "node:fs";
const builderSrc = readFileSync(new URL("../server/quote-proposal-builder.js", import.meta.url), "utf8");
function extractFn(name) {
  const start = builderSrc.indexOf(`  function ${name}(`);
  ok(start >= 0, `builder source still defines ${name}()`);
  const end = builderSrc.indexOf("\n  }\n", start);
  return builderSrc.slice(start, end + 4);
}
const builderState = { quote: { status: "draft", lineItems: [] } };
let rerenders = 0, dirtied = 0;
const builderScope = new Function(
  "state", "renderLineItems", "markDirty",
  `${extractFn("orderedLinesWithIndex")}\n${extractFn("moveLineItem")}\n` +
  "return { orderedLinesWithIndex, moveLineItem };"
)(builderState, () => { rerenders++; }, () => { dirtied++; });

// Same fixture as the server-side sort, same expected sequence.
builderState.quote.lineItems = arranged.lineItems.map((l) => ({ ...l }));
eq(builderScope.orderedLinesWithIndex().map((e) => e.li.label).join(" | "),
   labels(orderedLineItems(arranged)),
   "builder's sort agrees with lib/line-item-order.js on an arranged stack");
builderState.quote.lineItems = legacy.lineItems.map((l) => ({ ...l }));
eq(builderScope.orderedLinesWithIndex().map((e) => e.li.label).join(" | "),
   labels(orderedLineItems(legacy)), "builder's sort agrees on a legacy record");
builderState.quote.lineItems = dupes.lineItems.map((l) => ({ ...l }));
eq(builderScope.orderedLinesWithIndex().map((e) => e.li.label).join(" | "),
   labels(orderedLineItems(dupes)), "builder's sort agrees on duplicate order values");

// Moving: the flow meter starts last and is walked to the top.
const seq = () => builderScope.orderedLinesWithIndex().map((e) => e.li.label).join(" | ");
builderState.quote.lineItems = [
  { label: "Zone 7", order: 0 }, { label: "Mainline", order: 1 },
  { label: "Controller", order: 2 }, { label: "Flow meter", order: 3 }
];
const flowIdx = 3;
builderScope.moveLineItem(flowIdx, -1);
eq(seq(), "Zone 7 | Mainline | Flow meter | Controller", "move up swaps with the line above");
builderScope.moveLineItem(flowIdx, -1);
builderScope.moveLineItem(flowIdx, -1);
eq(seq(), "Flow meter | Zone 7 | Mainline | Controller", "walked to the top of the stack");
ok(rerenders === 3 && dirtied === 3, "each move re-renders and marks the draft dirty");

// Clamped at the ends — no wrap, no throw, no spurious save.
builderScope.moveLineItem(flowIdx, -1);
eq(seq(), "Flow meter | Zone 7 | Mainline | Controller", "move up at the top is a no-op");
eq(rerenders, 3, "a clamped move does not re-render");
eq(dirtied, 3, "a clamped move does not mark dirty");

// A legacy record with no order values at all must still move.
builderState.quote.lineItems = [{ label: "a" }, { label: "b" }, { label: "c" }];
builderScope.moveLineItem(2, -1);
eq(seq(), "a | c | b", "a record with no order values still reorders");

// Draft-only, matching the server's scope lock on lineItems.
builderState.quote.status = "sent";
const sentBefore = seq();
builderScope.moveLineItem(0, 1);
eq(seq(), sentBefore, "reordering is refused once the proposal leaves draft");

// ---- summary ----------------------------------------------------------
console.log(`\nline-item order: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

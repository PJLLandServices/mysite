// Unit tests for the auto-generated proposal page (Proposal HTML brief,
// 2026-07). Covers the pure data→HTML pipeline: proposal-data.js (adapter)
// + proposal-html.js (generator) + proposal-templates.js (copy + tokens).
// No server needed. Run: node scripts/test-proposal-html.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildProposalData, fmtMoney, fmtDate } = require("../server/lib/proposal-data.js");
const { renderSprinklerProposal } = require("../server/lib/proposal-html.js");
const templates = require("../server/lib/proposal-templates.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ---- formatting helpers ----------------------------------------------
eq(fmtMoney(7317), "$7,317.00", "money: thousands + cents");
eq(fmtMoney(8268.21), "$8,268.21", "money: keeps cents");
eq(fmtMoney(0), "$0.00", "money: zero");
eq(fmtMoney(1234567.5), "$1,234,567.50", "money: millions");
eq(fmtDate("2026-07-12T14:00:00.000Z"), "July 12, 2026", "date: ISO → Month D, YYYY (no TZ shift)");
eq(fmtDate("2026-10-10"), "October 10, 2026", "date: date-only");
eq(fmtDate(""), "", "date: empty");

// ---- template registry -----------------------------------------------
ok(templates.isKnownTemplate("irrigation"), "irrigation template is known");
ok(!templates.isKnownTemplate("nope"), "unknown template rejected");
ok(templates.listTemplates().some((t) => t.key === "irrigation" && t.theme === "sprinkler"), "listTemplates includes irrigation/sprinkler");

// ---- a realistic under-$10k proposal (no deposit) --------------------
const baseQuote = {
  id: "Q-2026-0226", version: 1, type: "project_proposal",
  createdAt: "2026-07-12T14:00:00.000Z", validUntil: "2026-10-10",
  subtotal: 7317.00, hst: 951.21, total: 8268.21,
  deposit: { enabled: false }, pdfOptions: { lineItems: "itemized" },
  lineItems: [
    { label: "Lawn zones", description: "Rotary heads · turf", qty: 3 },
    { label: "Conduit", description: "Under retaining wall", qty: 15, unit: "per_ft" }
  ]
};
const parties = {
  customer: { name: "Chris Ingram", phone: "9059600181", address: "851 Norsan Ct, Newmarket ON", email: "c@x.com" },
  property: { address: "851 Norsan Ct, Newmarket ON" }
};

const d1 = buildProposalData(baseQuote, { ...parties, templateKey: "irrigation" });
eq(d1.payment.mode, "total-due", "under threshold → total-due");
eq(d1.schedule.rows.length, 2, "schedule row per line item");
eq(d1.schedule.rows[1].qty, "15 ft", "qty formats unit (per_ft → ft)");
eq(d1.schedule.total, "$8,268.21", "total money-formatted");
eq(d1.meta.docKicker, "Irrigation System  ·  Q-2026-0226", "kicker = label · quote#");
ok(d1.hero.facts.some((f) => f.v === "Chris Ingram"), "hero fact: prepared for");

const html1 = renderSprinklerProposal(d1);
ok(html1.startsWith("<!DOCTYPE html>"), "renders a full document");
ok(html1.includes("Chris Ingram"), "customer name embedded");
ok(html1.includes("851 Norsan Ct"), "property address in hero sub (token resolved)");
ok(html1.includes("$8,268.21"), "total appears");
ok(html1.includes("valid through October 10, 2026") || html1.includes("October 10, 2026"), "validThrough token resolved in clause");
ok(html1.includes("Total due"), "no-deposit → total-due panel");
ok(!html1.includes("{{"), "no unresolved {{tokens}}");
ok(html1.includes("data:image/svg+xml;base64,"), "logo embedded (self-contained)");

// ---- a ≥$10k proposal WITH a 25% deposit -----------------------------
const depQuote = {
  ...baseQuote, id: "Q-2026-0301", subtotal: 12000, hst: 1560, total: 13560,
  deposit: { enabled: true, type: "percent", value: 25, amount: 3390, balance: 10170, dueLabel: "due at scheduling", balanceLabel: "due on completion" }
};
const d2 = buildProposalData(depQuote, { ...parties, templateKey: "irrigation" });
eq(d2.payment.mode, "deposit", "at/above threshold → deposit split");
eq(d2.payment.deposit.amount, "$3,390.00", "deposit amount");
eq(d2.payment.balance.amount, "$10,170.00", "balance amount");
ok(d2.payment.deposit.when.includes("25%"), "deposit 'when' shows percent");
const html2 = renderSprinklerProposal(d2);
ok(html2.includes("$3,390.00") && html2.includes("$10,170.00"), "deposit + balance both render");

// ---- robustness: hero photo, summary mode, empty line items ----------
const d3 = buildProposalData({ ...baseQuote, pdfOptions: { lineItems: "summary" } }, { ...parties, templateKey: "irrigation" });
eq(d3.schedule.rows.length, 1, "summary mode → single collapsed row");
const d4 = buildProposalData({ ...baseQuote, lineItems: [] }, { ...parties, templateKey: "irrigation" });
eq(d4.schedule.rows.length, 1, "no line items → single collapsed row");
const d5 = buildProposalData(baseQuote, { customer: {}, property: {}, templateKey: "irrigation", heroPhoto: "data:image/jpeg;base64,AAAA" });
ok(renderSprinklerProposal(d5).includes("url('data:image/jpeg;base64,AAAA')"), "hero photo embedded in inline style");
ok(!renderSprinklerProposal(d5).includes("undefined"), "no 'undefined' leaks when customer/property empty");
// unknown template key falls back to irrigation rather than throwing
ok(buildProposalData(baseQuote, { ...parties, templateKey: "does-not-exist" }).schedule.rows.length === 2, "unknown template key falls back gracefully");

// ---- report -----------------------------------------------------------
console.log(`\nproposal-html tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Unit tests for the auto-generated proposal page (Proposal HTML brief,
// 2026-07). Covers the pure data→HTML pipeline: proposal-data.js (adapter)
// + proposal-html.js (generator) + proposal-templates.js (copy + tokens).
// No server needed. Run: node scripts/test-proposal-html.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildProposalData, fmtMoney, fmtDate } = require("../server/lib/proposal-data.js");
const { renderSprinklerProposal, renderLightingProposal } = require("../server/lib/proposal-html.js");
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
// Pricing disclaimer under the schedule — guards against à-la-carte discount asks.
ok(/priced only as part of the .*complete system/.test(html1) && /stand-alone line/.test(html1),
  "schedule carries the 'priced as part of complete system' disclaimer");
ok(d1.schedule.countNote.includes("complete system"), "disclaimer present on the schedule data");
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

// ---- seasonal care (spring opening + fall closing, by zone count) -----
function proposalWithZones(zoneLines) {
  const items = [{ label: "System mainline", qty: 1, price: 749 }];
  for (let i = 1; i <= zoneLines; i++) items.push({ label: `Zone ${i} — Area`, description: "Rotary heads · 6 heads", qty: 1, price: 549 });
  const sub = items.reduce((s, l) => s + l.price, 0);
  return { id: "Q-Z", type: "project_proposal", createdAt: "2026-07-14", validUntil: "2026-10-12", subtotal: sub, hst: sub * 0.13, total: sub * 1.13, deposit: { enabled: false }, pdfOptions: { lineItems: "itemized" }, lineItems: items };
}
function seasonalFor(zoneLines) {
  return buildProposalData(proposalWithZones(zoneLines), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" }).seasonal;
}
eq(seasonalFor(4).spring.value, "$90.00", "4 zones → $90 spring opening");
eq(seasonalFor(4).fall.value, "$90.00", "4 zones → $90 fall closing (same tier price)");
eq(seasonalFor(5).spring.value, "$105.00", "5 zones → $105 (tier 5-6)");
eq(seasonalFor(8).spring.value, "$120.00", "8 zones → $120 (tier 7-8)");
eq(seasonalFor(12).spring.value, "$165.00", "12 zones → $165 (tier 9-15)");
ok(seasonalFor(16).custom && seasonalFor(16).spring.value === "By quote", "16+ zones → custom 'By quote'");
eq(seasonalFor(0), null, "no identifiable zones → no seasonal block");
eq(seasonalFor(5).zones, 5, "seasonal reports the zone count");
// The block renders and resolves the {{zoneCount}} token in its note.
{
  const html = renderSprinklerProposal(buildProposalData(proposalWithZones(5), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" }));
  ok(html.includes("Spring opening") && html.includes("Fall closing"), "both seasonal services render");
  ok(html.includes("per spring visit") && html.includes("per fall visit"), "each service priced per visit (not combined)");
  ok(/two separate services/i.test(html) && /not the two combined/i.test(html), "note states the two services are separate, priced each");
  ok(html.includes("5-zone"), "zoneCount token resolved in the seasonal note");
  ok(!/id="seasonal"[\s\S]*\{\{/.test(html), "no unresolved tokens in the seasonal section");
}

// ---- flow meter: conditional copy across sections --------------------
function proposalWithMainline(mainlineDesc) {
  return {
    id: "Q-F", type: "project_proposal", createdAt: "2026-07-14", validUntil: "2026-10-12",
    subtotal: 1000, hst: 130, total: 1130, deposit: { enabled: false }, pdfOptions: { lineItems: "itemized" },
    lineItems: [
      { label: "System mainline", description: mainlineDesc, qty: 1, price: 749 },
      { label: "Zone 1 — Front", description: "Rotary heads · 6 heads", qty: 1, price: 549 }
    ]
  };
}
// WITH flow meter → mainline wording carries "flow-meter" → scope lists the flow sensor.
{
  const d = buildProposalData(proposalWithMainline("New dedicated-supply mainline · Hunter Hydrawise flow-meter & leak detection"), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" });
  ok(d.scope.includes.some((i) => /flow sensor/i.test(i)), "flow present → scope lists the flow sensor");
  ok(!d.scope.includes.some((i) => /controller and flow/i.test(i)), "controller line no longer hardcodes flow sensor");
}
// WITHOUT flow meter → no flow wording anywhere in the scope.
{
  const d = buildProposalData(proposalWithMainline("New dedicated-supply mainline off the water meter"), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" });
  ok(!d.scope.includes.some((i) => /flow[\s-]?(meter|sensor)/i.test(i)), "no flow meter → scope has zero flow-sensor mentions");
  const html = renderSprinklerProposal(d);
  ok(!/flow[\s-]?(meter|sensor)/i.test(html), "no flow meter → generated HTML has no flow-meter/sensor wording at all");
}

// ---- how-it-works cards adapt to the system --------------------------
function proposalWithZoneDescs(descs) {
  const li = [{ label: "System mainline", description: "New dedicated-supply mainline off the water meter", qty: 1, price: 749 }];
  descs.forEach((dsc, i) => li.push({ label: `Zone ${i + 1} — Area`, description: dsc, qty: 1, price: 549 }));
  const s = li.reduce((a, x) => a + x.price, 0);
  return { id: "Q-C", type: "project_proposal", createdAt: "2026-07-14", validUntil: "2026-10-12", subtotal: s, hst: s * 0.13, total: s * 1.13, deposit: { enabled: false }, pdfOptions: { lineItems: "itemized" }, lineItems: li };
}
function cardsFor(descs) {
  return buildProposalData(proposalWithZoneDescs(descs), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" }).system.cards.map((c) => `${c.title} :: ${c.body}`);
}
{
  // No drip → no drip wording; spray heads advertised as pressure-regulated @ 30 PSI.
  const noDrip = cardsFor(["Rotary heads · 6 heads", "Pop-up spray heads · 5 heads"]);
  eq(noDrip.length, 4, "no-drip system → 4 cards");
  ok(!noDrip.some((c) => /drip|root.zone/i.test(c)), "no-drip system → cards never mention drip");
  ok(noDrip.some((c) => /pressure-regulated/i.test(c) && /30 psi/i.test(c)), "spray present → pressure-regulated heads @ 30 PSI advertised");
  // Spray + drip → both pressure-regulation stories, still 4 cards.
  const both = cardsFor(["Pop-up spray heads · 5 heads", "Root-zone drip line"]);
  eq(both.length, 4, "spray+drip system → 4 cards");
  ok(both.some((c) => /drip/i.test(c) && /pressure regulator/i.test(c)), "drip present → drip pressure-regulator mentioned");
  ok(both.some((c) => /30 psi/i.test(c)), "spray present → 30 PSI still advertised");
  // Gear-rotor-only → no false 30 PSI / pressure-regulated-head claim.
  const rotorOnly = cardsFor(["Rotary heads · 8 heads"]);
  ok(!rotorOnly.some((c) => /30 psi/i.test(c) || /pressure-regulated (spray )?heads?/i.test(c)), "gear-rotor-only → no 30 PSI / pressure-regulated-head claim");
  // Full HTML for a no-drip job has zero drip wording.
  const html = renderSprinklerProposal(buildProposalData(proposalWithZoneDescs(["Rotary heads · 6 heads"]), { customer: { name: "X" }, property: { address: "Y" }, templateKey: "irrigation" }));
  ok(!/\bdrip\b/i.test(html), "no-drip job → generated HTML never says 'drip'");
}

// ---- lighting (dark "after dark" theme) ------------------------------
// The lighting template builds a different data shape: a fixture schedule
// with per-fixture Each/Line pricing, Fixtures (not Zones) hero facts, a
// dark theme, and a CTA close. Copy comes from proposal-lighting.json.
ok(templates.isKnownTemplate("lighting"), "lighting template is known");
ok(templates.listTemplates().some((t) => t.key === "lighting" && t.theme === "lighting"), "listTemplates includes lighting/lighting");

function lightingQuote(lines, opts = {}) {
  const lineItems = lines.map(([label, description, qty, price]) => ({
    label, description, qty, price, lineTotal: qty * price
  }));
  const subtotal = lineItems.reduce((n, li) => n + li.lineTotal, 0);
  const hst = +(subtotal * 0.13).toFixed(2), total = +(subtotal + hst).toFixed(2);
  const q = {
    id: opts.id || "Q-2026-0228", version: 1, type: "project_proposal",
    createdAt: "2026-07-13T14:00:00.000Z", validUntil: "2026-10-11",
    subtotal, hst, total, lineItems,
    deposit: opts.deposit === false
      ? { enabled: false }
      : { enabled: true, type: "percent", value: 25, amount: +(total * 0.25).toFixed(2), balance: +(total * 0.75).toFixed(2), dueLabel: "due at scheduling", balanceLabel: "due on completion" }
  };
  return q;
}
const lightParties = {
  customer: { name: "Chris Ingram", phone: "9059600181", address: "851 Norsan Ct, Newmarket ON" },
  property: { address: "851 Norsan Ct, Newmarket ON" }
};

{
  const q = lightingQuote([
    ["Large", "BIG SCOPE WIDE", 2, 295],
    ["Medium", "SCOPE", 16, 245],
    ["Small", "MINI SCOPE", 18, 225],
    ["Recessed", "HYVE 22", 8, 265]
  ]);
  const d = buildProposalData(q, { ...lightParties, templateKey: "lighting" });
  eq(d.theme, "lighting", "lighting template → lighting theme");
  eq(d.schedule.rows.length, 4, "one schedule row per fixture class");
  eq(d.schedule.rows[0].each, "$295.00", "fixture row shows per-unit price (Each)");
  eq(d.schedule.rows[0].line, "$590.00", "fixture row shows extended price (Line = qty×each)");
  eq(d.schedule.subtotalLabel, "Subtotal  —  44 fixtures", "subtotal label counts total fixtures");
  ok(d.hero.facts.some((f) => f.k === "Fixtures" && f.v === "44"), "hero fact: Fixtures = total qty (not Zones)");
  eq(d.payment.mode, "deposit", "≥ threshold lighting quote → deposit/balance split");

  const html = renderLightingProposal(d);
  ok(html.startsWith("<!DOCTYPE html>"), "lighting renders a full document");
  ok(html.includes("after dark"), "hero accent copy present");
  ok(html.includes("In-Lite"), "In-Lite system copy present");
  ok(html.includes("$12,068.40"), "lighting total appears");
  ok(html.includes("BIG SCOPE WIDE") && html.includes("HYVE 22"), "In-Lite fixture codes in schedule");
  ok(html.includes('class="cta"') && html.includes("tel:+19059600181"), "CTA close links to phone");
  ok(html.includes("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABW8"), "lighting uses the amber logo asset");
  ok(!html.includes("{{"), "lighting: no unresolved tokens");
  // Singular fixture count reads naturally.
  const dOne = buildProposalData(lightingQuote([["Small", "MINI SCOPE", 1, 225]], { deposit: false }), { ...lightParties, templateKey: "lighting" });
  eq(dOne.schedule.subtotalLabel, "Subtotal  —  1 fixture", "subtotal label singularizes at 1 fixture");
}

// ---- report -----------------------------------------------------------
console.log(`\nproposal-html tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

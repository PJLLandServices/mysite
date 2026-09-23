#!/usr/bin/env node
// scripts/test-closing-price.mjs
//
// The closing bills the zones actually walked, at the account's real tier
// (fall-closing fix #7).
//
// Pressure test: booked at 4 zones, the tech recorded 6, and the invoice
// still billed the 1-4 tier — the seasonal line is snapshotted when the WO
// is opened and the cascade billed the snapshot. And resolveSeasonalPrice
// hard-coded deriveSeasonalKey(..., false), so a 6-zone COMMERCIAL site was
// seeded at the residential 5-6 tier instead of the commercial 5-8 tier.
//
// Every expected price here is READ from pricing.json (Hard Rule 21) —
// nothing is typed. Booted server, temp data, outbound stubbed.
//
//   A. 4 booked → 6 walked bills the 5-6 tier; the WO's own line agrees;
//      the app's preview says so before Finish
//   B. a commercial account resolves the commercial tier, at seed and bill
//   C. a per-property override still wins over the walked count
//   D. the resolver's defaults are unchanged for every other caller
//
// Run: node scripts/test-closing-price.mjs   (also in build:check)

import fs from "node:fs";
import { createRequire } from "node:module";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
const price = (key) => PRICING.items[key].price;
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const lineKey = (l) => l?.key;
const linePrice = (l) => Number(l?.overridePrice ?? l?.originalPrice ?? l?.unitPrice ?? l?.price);
const seasonalLine = (lines) => (lines || []).find((l) => /^fall_close_/.test(l?.key || ""));
const extra = [{ number: 5, location: "Side yard", status: "working_well" }, { number: 6, location: "Back fence", status: "working_well" }];

const srv = await bootServer({ port: 4867 });
try {
  await srv.login();
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;

  // ---- A. 4 booked, 6 walked ----------------------------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    ok(lineKey(seasonalLine(f.wo.onSiteQuote?.builderLineItems)) === "fall_close_4z", "control: seeded at the booked 1-4 tier");
    await srv.prepClosing(f.wo.id, { extraZones: extra });
    const g = await srv.api("GET", `/api/work-orders/${f.wo.id}`);
    ok(g.body.seasonalFee?.changed === true && g.body.seasonalFee?.zoneCount === 6, `the app is told before Finish (${JSON.stringify(g.body.seasonalFee)})`);
    ok(g.body.seasonalFee?.atFinish?.price === price("fall_close_6z"), "…with the 5-6 tier's price");
    await complete(f.wo.id);
    await sleep(300);
    const line = seasonalLine(invoiceFor(f.wo.id)?.lineItems);
    ok(lineKey(line) === "fall_close_6z", `the invoice bills the 5-6 tier (got ${lineKey(line)})`);
    ok(linePrice(line) === price("fall_close_6z"), `…at its pricing.json price (got ${linePrice(line)})`);
    // Round 2: the WO was signed — its quote is the customer's record and is
    // not rewritten after signing; the history says what the invoice did.
    const doneWo = srv.data("work-orders").find((w) => w.id === f.wo.id);
    ok(lineKey(seasonalLine(doneWo?.onSiteQuote?.builderLineItems)) === "fall_close_4z", "the signed work order's quote is left as signed");
    ok((doneWo?.history || []).some((h) => h.action === "seasonal_fee_reresolved" && /fall_close_6z/.test(h.note) && /invoice only/.test(h.note)),
      "…and its history records the re-priced invoice line");
  }

  // ---- B. commercial ------------------------------------------------------
  {
    const f = await srv.fixture({ zones: 6, accountType: "commercial" });
    ok(lineKey(seasonalLine(f.wo.onSiteQuote?.builderLineItems)) === "fall_close_commercial_8z",
      `a 6-zone commercial site is seeded at the commercial 5-8 tier (got ${lineKey(seasonalLine(f.wo.onSiteQuote?.builderLineItems))})`);
    await srv.prepClosing(f.wo.id);
    await complete(f.wo.id);
    await sleep(300);
    const line = seasonalLine(invoiceFor(f.wo.id)?.lineItems);
    ok(lineKey(line) === "fall_close_commercial_8z" && linePrice(line) === price("fall_close_commercial_8z"),
      `…and billed there (got ${lineKey(line)} ${linePrice(line)})`);
  }

  // ---- C. a per-property override still wins ------------------------------
  {
    const f0 = await srv.fixture({ zones: 4 });
    const overridePrice = price("fall_close_4z") + 7; // any grandfathered number that is NOT a tier
    const u = await srv.api("PATCH", `/api/properties/${f0.prop.id}`, { seasonalPricing: { fallClosingPrice: overridePrice } });
    ok(u.status === 200, "set a per-property fall price");
    const w = await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: f0.prop.id });
    const id = w.body.workOrder.id;
    await srv.prepClosing(id, { extraZones: extra });
    await complete(id);
    await sleep(300);
    const line = seasonalLine(invoiceFor(id)?.lineItems) || (invoiceFor(id)?.lineItems || [])[0];
    ok(linePrice(line) === overridePrice, `the property's own rate is billed, not the 5-6 tier (got ${linePrice(line)})`);
  }

  // ---- E (round 2). custom-quote sizes are never billed flat -------------
  {
    const f = await srv.fixture({ zones: 15 });
    await srv.prepClosing(f.wo.id, { extraZones: [{ number: 16, location: "X16", status: "working_well" }], paidOnSite: true });
    const g = await srv.api("GET", `/api/work-orders/${f.wo.id}`);
    ok(g.body.seasonalFee?.customQuote === true && g.body.seasonalFee?.atFinish?.custom === true,
      `booked 15, walked 16: the tech's preview says custom (${JSON.stringify(g.body.seasonalFee?.atFinish)})`);
    await complete(f.wo.id);
    await sleep(300);
    const i = invoiceFor(f.wo.id);
    const line = seasonalLine(i?.lineItems) || (i?.lineItems || [])[0];
    ok(/^Custom quote — Patrick to price/.test(line?.note || ""), `the draft line is flagged for Patrick (note: ${line?.note})`);
    const link = await srv.api("POST", `/api/invoices/${i.id}/payment-link`, {});
    ok(link.status === 409 && link.body.code === "needs_pricing", `…and can't be charged on site at the placeholder price (${link.status} ${link.body.code})`);
  }
  {
    const f = await srv.fixture({ zones: 16 });
    await srv.prepClosing(f.wo.id);
    const g = await srv.api("GET", `/api/work-orders/${f.wo.id}`);
    ok(g.body.seasonalFee?.customQuote === true, "16 zones from the start: the preview says custom, not free");
    const before = srv.outbox().length;
    await complete(f.wo.id);
    await sleep(900);
    const alert = srv.outbox().slice(before).find((m) => /WO COMPLETED/.test(m.subject));
    const txt = String(alert?.html || "").replace(/<[^>]+>/g, " ");
    ok(/No invoice drafted — price this visit/.test(txt) && !/No charge/.test(txt), "Patrick's alert says 'price this visit', not 'No charge'");
  }
} finally {
  await srv.stop();
}

// ---- D. the resolver, pure ------------------------------------------------
{
  const { resolveSeasonalPrice, refreshSeasonalBaseline } = require("../server/lib/pricing.js");
  const six = { system: { zones: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n })) } };
  ok(resolveSeasonalPrice(six, "fall_closing").key === "fall_close_6z", "defaults unchanged: residential, property's zones");
  ok(resolveSeasonalPrice(six, "fall_closing", { commercial: true }).key === "fall_close_commercial_8z", "commercial picks the commercial table");
  ok(resolveSeasonalPrice(six, "fall_closing", { zoneCount: 9 }).key === "fall_close_15z", "the walked count beats the property's");
  ok(typeof refreshSeasonalBaseline === "function", "refreshSeasonalBaseline is exported");
  if (typeof refreshSeasonalBaseline === "function") {
    const wo = (over) => ({ type: "fall_closing", zones: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, kind: "zone" })),
      onSiteQuote: { builderLineItems: [{ key: "fall_close_4z", originalPrice: price("fall_close_4z"), overridePrice: over, source: { baseline: true } },
        { key: "fall_additional_plumbing", originalPrice: 12, source: { baseline: true, propertyAdditionalFallBlowout: true } }] } });
    const r = refreshSeasonalBaseline(wo(null), {}, {});
    ok(r.changed && r.lines[0].key === "fall_close_6z" && r.lines[1].originalPrice === 12, "only the seasonal line moves");
    ok(refreshSeasonalBaseline(wo(50), {}, {}).changed === false, "a hand-priced line on the WO is left alone");
    const big = { ...wo(null), zones: Array.from({ length: 20 }, (_, i) => ({ number: i + 1 })) };
    const rb = refreshSeasonalBaseline(big, {}, {});
    ok(rb.customQuote === true && rb.after?.custom === true && rb.after?.price === null, "a custom-quote tier is reported as custom, not given a flat price");
    ok(rb.lines[0].custom === true && /^Custom quote — Patrick to price/.test(rb.lines[0].note) && rb.lines[0].originalPrice === price("fall_close_4z"),
      "…its draft line is flagged for Patrick (not zeroed, not silently billed)");
    const unseeded = { type: "fall_closing", zones: Array.from({ length: 16 }, (_, i) => ({ number: i + 1 })), onSiteQuote: { builderLineItems: [] } };
    ok(refreshSeasonalBaseline(unseeded, {}, {}).customQuote === true, "a custom-size job with no seeded line says custom, not free");
  }
  const closing = fs.readFileSync(new URL("../pjl-field/src/screens/ClosingScreen.js", import.meta.url), "utf8");
  ok(/fee\?\.changed && fee\.atFinish && \(fee\.current \|\| fee\.atFinish\.custom\)/.test(closing) && /The price follows the zones/.test(closing),
    "the app shows the price change before Finish");
  ok(/custom quote — Patrick to price/.test(closing), "…and says 'custom — Patrick to price' for a custom-quote size");
  const api = fs.readFileSync(new URL("../pjl-field/src/api.js", import.meta.url), "utf8");
  ok(/seasonalFee: d\.seasonalFee \|\| null/.test(api), "the app keeps the server's preview on the fresh read");
}

console.log(`closing-price: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

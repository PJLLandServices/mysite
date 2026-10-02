#!/usr/bin/env node
// "Generate invoice now" on a closing Patrick prices himself.
//
//   node scripts/test-create-invoice-custom-size.mjs
//
// WHAT THIS PROTECTS. Two fixes meet in POST /api/work-orders/:id/create-invoice:
//
//   - PJL-96: a custom-size closing (16+ residential, 9+ commercial) carries a
//     price-PENDING seasonal fee line — no price on the work order — which is
//     billed at a SUGGESTED amount Patrick confirms.
//   - PJL-100 #7: a no-charge visit (lines totalling $0) is refused 409
//     no_charge, so a $0 invoice can't be drafted and emailed.
//
// A pending line has no price, so judged on the RAW work-order lines a custom
// size looks exactly like a no-charge stop. The route must judge the lines it
// would actually bill — after the PJL-96 re-price turns the pending line into
// its suggestion. Otherwise "Generate invoice now" refuses every custom-size
// closing as "no charge", and the no-charge flag hides it from the office's
// "Needs invoice" list.
import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 260);

// The suggestion rule, recomputed from pricing.json (never typed): the
// per-zone slope of the last two priced tiers, extended past the top one.
function expectedSuggestion(group, zones) {
  const priced = PRICING.seasonal_tiers[group]
    .map((t) => ({ hi: t.zones.endsWith("+") ? Infinity : Number(t.zones.split("-").pop()), lo: parseInt(t.zones, 10), price: PRICING.items[t.key_fall].price, custom: PRICING.items[t.key_fall].quoteType === "custom" }))
    .filter((t) => !t.custom && t.price > 0 && Number.isFinite(t.hi));
  const tier = priced.find((t) => zones >= t.lo && zones <= t.hi);
  if (tier) return tier.price;
  const [prev, top] = priced.slice(-2);
  return Math.round(top.price + (zones - top.hi) * ((top.price - prev.price) / (top.hi - prev.hi)));
}

const srv = await bootServer({ port: 4923 });
try {
  await srv.login();
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });

  const f = await srv.fixture({ zones: 18, phone: "9055550183" });
  await srv.prepClosing(f.wo.id);
  const done = await complete(f.wo.id);
  ok(done.status === 200, `the 18-zone closing completes (${done.status})`);
  await sleep(1200);

  // The cascade drafted the suggested invoice. Take it away, the way a desk
  // void-and-regenerate would leave the WO, so "Generate invoice now" runs.
  const drafted = srv.data("invoices").find((i) => i.woId === f.wo.id);
  ok(Boolean(drafted), "the cascade drafted an invoice for the custom size");
  srv.writeData("invoices", srv.data("invoices").filter((i) => i.woId !== f.wo.id));

  const gen = await srv.api("POST", `/api/work-orders/${f.wo.id}/create-invoice`, {});
  ok(gen.status !== 409 && gen.body.code !== "no_charge",
    `"Generate invoice now" is NOT refused as no charge (got ${gen.status} ${gen.body.code || ""})`);
  const inv = gen.body.invoice || srv.data("invoices").find((i) => i.woId === f.wo.id);
  ok(inv && Number(inv.total) > 0, `…it drafts a priced invoice (total ${inv?.total})`);
  const fee = (inv?.lineItems || []).find((l) => /^fall_close_/.test(l?.key || ""));
  ok(fee && Number(fee.unitPrice) === expectedSuggestion("residential", 18),
    `…at the suggested price from pricing.json (${fee?.unitPrice} vs ${expectedSuggestion("residential", 18)})`);
  ok(inv && inv.priceConfirm && inv.priceConfirm.confirmedAt == null,
    `…still waiting for Patrick to confirm it (${j(inv?.priceConfirm)})`);

  const g = await srv.api("GET", `/api/work-orders/${f.wo.id}`);
  ok(g.body.workOrder && g.body.workOrder.noCharge !== true,
    `the work order is not flagged no-charge (${g.body.workOrder?.noCharge})`);
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}`);
} finally {
  await srv.stop();
}

console.log(`create-invoice-custom-size: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-price-confirm.mjs
//
// PJL-96 (rulings 2, 3 and 4). A closing Patrick prices himself is billed
// at a SUGGESTED price he confirms — and until he does, nothing is payable,
// sent or texted.
//
// WHAT BROKE (verified on origin/main fcf506ae):
//   * A property already known to be 16+ residential (or 9+ commercial)
//     was seeded with NO fee line, so the completion drafted no invoice at
//     all and the service record read "no charge".
//   * Booked 4, walked 16: the draft kept the BOOKED tier's $90 under a
//     "Patrick to price" note — the customer was still texted "your
//     invoice is ready", /send emailed it, and it was then payable online.
//   * A commercial account with no price of its own was billed the
//     commercial tier with no flag. Ruling 2: that tier is only a
//     suggestion.
//
// WHAT THIS PINS (booted server, temp data, email/SMS/Stripe stubbed):
//   A. The suggestion is the tier-slope rule, computed HERE from
//      pricing.json independently of the code under test.
//   B. 18 zones known at booking: the work order carries a price-PENDING
//      line (no number), completion drafts an invoice prefilled with the
//      suggestion, flagged; not payable, no link, no send, no text, and the
//      customer's completion email names no price. Patrick confirms →
//      payable, sendable, and the held text is re-armed.
//   C. Commercial, no price of its own: suggested (the tier price),
//      unconfirmed, not payable. 10 commercial zones: the slope.
//   D. Commercial with a per-property price: billed that price, confirmed.
//   E. Booked 4, walked 16: suggested at the 16-zone slope, not $90.
//   F. A draft made before PJL-96 (placeholder note only) is held too.
//   G. The office confirm is admin-only; the app hides pay actions.
//
// Run: node scripts/test-price-confirm.mjs   (also in build:check)

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 260);

// ---- The expected suggestion, from pricing.json, independently ----------
// Last two priced tiers (custom tiers skipped), each at its upper bound;
// extend the slope past the top one; round to the dollar. Inside a priced
// tier, that tier's price.
function expectedSuggestion(group, zones) {
  const priced = PRICING.seasonal_tiers[group]
    .map((t) => ({ hi: t.zones.endsWith("+") ? Infinity : Number(t.zones.split("-").pop()), lo: parseInt(t.zones, 10), price: PRICING.items[t.key_fall].price, custom: PRICING.items[t.key_fall].quoteType === "custom" }))
    .filter((t) => !t.custom && t.price > 0 && Number.isFinite(t.hi));
  const tier = priced.find((t) => zones >= t.lo && zones <= t.hi);
  if (tier) return tier.price;
  const [prev, top] = priced.slice(-2);
  return Math.round(top.price + (zones - top.hi) * ((top.price - prev.price) / (top.hi - prev.hi)));
}
const feeLine = (lines) => (lines || []).find((l) => /^fall_close_/.test(l?.key || ""));
const walk = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, location: `Zone ${from + i}`, status: "working_well" }));

const srv = await bootServer({ port: 4871 });
try {
  await srv.login();
  // The invoice-ready text fires on its timer at once, so a held text shows.
  srv.writeData("settings", { invoiceSms: { enabled: true, delayMinutes: 0, maxAgeHours: 24 } });
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;
  const getInv = async (id) => (await srv.api("GET", `/api/invoices/${id}`)).body.invoice;

  // ---- A. the rule itself ------------------------------------------------
  const lib = srv.lib("pricing.js");
  ok(typeof lib.suggestSeasonalPrice === "function", "pricing exports suggestSeasonalPrice");
  if (typeof lib.suggestSeasonalPrice === "function") {
    const r16 = lib.suggestSeasonalPrice("fall_closing", 16, "residential");
    const c10 = lib.suggestSeasonalPrice("fall_closing", 10, "commercial");
    ok(r16?.amount === expectedSuggestion("residential", 16), `16 residential zones: the tier slope (${r16?.amount} vs ${expectedSuggestion("residential", 16)})`);
    ok(c10?.amount === expectedSuggestion("commercial", 10), `10 commercial zones: the tier slope (${c10?.amount} vs ${expectedSuggestion("commercial", 10)})`);
    ok(/plus \d+ zones? at \$[\d.]+\/zone/.test(r16?.basis || "") && /16 zones: suggested \$/.test(r16?.basis || ""), `the arithmetic is shown (${r16?.basis})`);
    ok(lib.suggestSeasonalPrice("fall_closing", 6, "commercial")?.amount === expectedSuggestion("commercial", 6), "inside a priced tier the suggestion is that tier's price");
  }

  // ---- B. 18 zones known at booking ---------------------------------------
  {
    const f = await srv.fixture({ zones: 18, phone: "9055550182" });
    const seeded = feeLine(f.wo.onSiteQuote?.builderLineItems);
    ok(seeded && seeded.priceStatus === "pending", `18 zones: the work order is seeded with a price-pending fee line (${j(seeded)})`);
    ok(seeded && seeded.originalPrice == null && !("suggestion" in seeded), "…carrying no price and no suggested number");
    await srv.prepClosing(f.wo.id);
    const g = await srv.api("GET", `/api/work-orders/${f.wo.id}`);
    ok(g.body.seasonalFee?.atFinish?.pending === true && g.body.seasonalFee?.atFinish?.price === null,
      `the tech's preview says price pending, with no number (${j(g.body.seasonalFee?.atFinish)})`);
    const before = srv.outbox().length;
    const done = await complete(f.wo.id);
    ok(done.status === 200, `the closing completes (${done.status})`);
    await sleep(1200);
    const inv = invoiceFor(f.wo.id);
    ok(Boolean(inv), "an invoice IS drafted (before: none, and the visit read 'no charge')");
    const want = expectedSuggestion("residential", 18);
    ok(feeLine(inv?.lineItems)?.unitPrice === want, `…prefilled with the suggestion (${feeLine(inv?.lineItems)?.unitPrice} vs ${want})`);
    const full = inv ? await getInv(inv.id) : null;
    ok(full?.priceUnconfirmed === true && full?.priceConfirm?.reason === "custom_size", `…flagged: price not confirmed (${j(full?.priceConfirm)})`);
    if (inv) {
      const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
      ok(link.status === 409 && link.body.code === "needs_pricing", `no pay link while unconfirmed (${link.status} ${link.body.code})`);
      const send = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
      ok(send.status === 409 && send.body.code === "price_unconfirmed", `not sendable while unconfirmed (${send.status} ${send.body.code})`);
      const after = srv.outbox().slice(before);
      ok(!after.some((m) => m.channel === "sms" && /5550182/.test(m.to)), `the customer is not texted (${j(after.filter((m) => m.channel === "sms"))})`);
      const custMail = after.find((m) => m.channel === "email" && m.to === f.cust.email);
      ok(custMail && /PJL will confirm the price/.test(custMail.html) && !/Total for today/.test(custMail.html),
        "the customer's completion email names no price");
      const rec = await getInv(inv.id);
      ok(rec.customerSmsScheduledAt && !rec.customerSmsSentAt && (rec.history || []).some((h) => h.action === "customer_sms_held_price_unconfirmed"),
        "the invoice text is HELD, not consumed");

      // Patrick confirms — his own price (any amount; this one is computed).
      await srv.login({ role: "tech" });
      const techTry = await srv.api("POST", `/api/invoices/${inv.id}/confirm-price`, { amount: want });
      ok(techTry.status === 403, `a tech can't set the price (${techTry.status})`);
      await srv.login();
      const t0 = Date.now();
      const conf = await srv.api("POST", `/api/invoices/${inv.id}/confirm-price`, { amount: want + 9 });
      ok(conf.status === 200 && conf.body.invoice?.priceUnconfirmed === false, `Patrick confirms the price (${conf.status} ${j(conf.body.errors)})`);
      const line = feeLine(conf.body.invoice?.lineItems);
      ok(line?.unitPrice === want + 9 && line?.note === "", "…the line carries his price and no 'pending' note");
      ok(Date.parse(conf.body.invoice?.customerSmsScheduledAt) >= t0 - 1000 && !conf.body.invoice?.customerSmsSentAt,
        "…and the held text is re-armed for the normal schedule");
      const send2 = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
      ok(send2.status === 200, `a confirmed price is sendable (${send2.status})`);
      const sent = await getInv(inv.id);
      const page = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${sent.paymentToken}`);
      ok(page.body.invoice?.payable === true, "…and payable");
    }
  }

  // ---- C. commercial, no price of its own --------------------------------
  for (const zones of [6, 10]) {
    const f = await srv.fixture({ zones, accountType: "commercial" });
    const seeded = feeLine(f.wo.onSiteQuote?.builderLineItems);
    ok(seeded?.priceStatus === "pending" && seeded?.priceReason === "commercial_unpriced",
      `commercial ${zones} zones: seeded price pending, not at the tier (${j(seeded)})`);
    await srv.prepClosing(f.wo.id);
    await complete(f.wo.id);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    const want = expectedSuggestion("commercial", zones);
    ok(feeLine(inv?.lineItems)?.unitPrice === want, `commercial ${zones} zones: suggested ${want} (got ${feeLine(inv?.lineItems)?.unitPrice})`);
    const full = inv ? await getInv(inv.id) : null;
    ok(full?.priceUnconfirmed === true && full?.priceConfirm?.reason === "commercial_unpriced", "…unconfirmed");
    if (inv) {
      ok((await srv.api("POST", `/api/invoices/${inv.id}/send`, {})).status === 409, "…and can't be sent");
      await srv.lib("invoices.js").ensurePaymentToken(inv.id);
      const tok = (await getInv(inv.id)).paymentToken;
      const page = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${tok}`);
      ok(page.body.invoice?.payable === false, "…or paid");
      const intent = await srv.api("POST", `/api/pay/invoice/${inv.id}/payment-intent`, { t: tok });
      ok(intent.status === 409 && intent.body.code === "price_unconfirmed", `the card route refuses it too (${intent.status} ${intent.body.code})`);
    }
  }

  // ---- D. commercial with its own price ------------------------------------
  {
    const f0 = await srv.fixture({ zones: 6, accountType: "commercial" });
    const own = PRICING.items.fall_close_commercial.price + 11; // any number that is NOT a tier
    await srv.api("PATCH", `/api/properties/${f0.prop.id}`, { seasonalPricing: { fallClosingPrice: own } });
    const w = await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: f0.prop.id });
    const id = w.body.workOrder.id;
    ok(feeLine(w.body.workOrder.onSiteQuote?.builderLineItems)?.priceStatus !== "pending", "commercial with its own price: seeded confirmed");
    await srv.prepClosing(id);
    await complete(id);
    await sleep(300);
    const inv = invoiceFor(id);
    const line = (inv?.lineItems || [])[0];
    ok(line?.unitPrice === own, `…billed its own price (${line?.unitPrice} vs ${own})`);
    const full = inv ? await getInv(inv.id) : null;
    ok(full?.priceUnconfirmed === false, "…confirmed, nothing for Patrick to set");
    if (inv) ok((await srv.api("POST", `/api/invoices/${inv.id}/send`, {})).status === 200, "…and sendable as usual");
  }

  // ---- E. booked 4, walked 16 ---------------------------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id, { extraZones: walk(5, 16) });
    await complete(f.wo.id);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    const want = expectedSuggestion("residential", 16);
    ok(feeLine(inv?.lineItems)?.unitPrice === want, `booked 4, walked 16: suggested ${want}, not the booked tier (got ${feeLine(inv?.lineItems)?.unitPrice})`);
    const full = inv ? await getInv(inv.id) : null;
    ok(full?.priceUnconfirmed === true, "…unconfirmed");
    if (inv) ok((await srv.api("POST", `/api/invoices/${inv.id}/send`, {})).status === 409, "…and not sendable (it was: 200, then payable)");
  }

  // ---- F. a draft made before PJL-96 ---------------------------------------
  {
    const invoices = srv.lib("invoices.js");
    const legacy = await invoices.createDraft({ customerName: "Legacy Placeholder",
      lineItems: [{ key: "fall_close_16plus", label: "Fall Closing (2026)", qty: 1, originalPrice: PRICING.items.fall_close_4z.price, note: "Custom quote — Patrick to price (16 zones)" }] });
    const got = await getInv(legacy.id);
    ok(got.priceUnconfirmed === true && invoices.payBlockReason(got) === "price_unconfirmed", "a pre-PJL-96 placeholder draft is held too");
    const conf = await srv.api("POST", `/api/invoices/${legacy.id}/confirm-price`, {});
    ok(conf.status === 200 && conf.body.invoice?.priceUnconfirmed === false, `…and can be confirmed as it stands (${conf.status} ${j(conf.body.errors)})`);
  }

  // ---- G. the app ---------------------------------------------------------
  const screen = fs.readFileSync(new URL("../pjl-field/src/screens/InvoiceScreen.js", import.meta.url), "utf8");
  ok(/const priceUnconfirmed = invoice\?\.priceUnconfirmed === true/.test(screen)
    && /priceUnconfirmed \? \(\s*<Text style=\{styles\.note\}>PJL confirms the price/.test(screen),
    "the app's invoice screen offers no Send / Take payment / Record while unconfirmed");
  ok(/priceUnconfirmed \? 'Set by PJL after the visit'/.test(screen), "…and shows no suggested number");
} finally {
  if (failed) console.error(srv.logs().split("\n").filter((l) => /error|warn|fail/i.test(l)).slice(-15).join("\n"));
  await srv.stop();
}

const lint = spawnSync(process.execPath, [new URL("./lint-no-hardcoded-prices.mjs", import.meta.url).pathname], { encoding: "utf8" });
ok(lint.status === 0, "lint-no-hardcoded-prices stays green");

console.log(`price-confirm: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

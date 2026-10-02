#!/usr/bin/env node
// scripts/test-price-before-signing.mjs
//
// PJL-96 (ruling 1). The work order the customer SIGNS carries the price
// the invoice bills — priced from the zones recorded before the signature
// (or the nobody-home bypass) freezes it — and nothing re-prices it after.
//
// WHAT BROKE (verified on origin/main fcf506ae): the fee was re-resolved
// only at completion, after the lock, so the invoice billed the zones
// walked while the signed work order kept the BOOKED price (probe: signed
// fall_close_4z $90, invoiced fall_close_6z $105). And the office's
// manual "create invoice" billed the stale booked tier.
//
// WHAT THIS PINS (booted server, temp data, email/SMS/Stripe stubbed;
// every expected price read from pricing.json):
//   A. Customer signs (sign + complete in one PATCH, carrying If-Match):
//      booked 4, walked 6 → the signed WO's fee line is the 5-6 tier,
//      stamped priced-at-lock, and equals the invoice line.
//   B. Nobody home (bypass): the fee is priced at the bypass; zones edited
//      AFTER the lock do not move it — the invoice bills what was signed.
//   C. A custom size at signing: the signed line is price pending (no
//      number); the invoice carries the suggestion, unconfirmed.
//   D. The manual create-invoice route re-prices like the cascade.
//   E. The sign-off screen shows the server's price, and "PJL confirms the
//      price" (no number) for a size PJL prices.
//
// Run: node scripts/test-price-before-signing.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 260);
// The residential fall tier holding n zones, read off pricing.json's ranges.
function fallTier(n) {
  for (const t of PRICING.seasonal_tiers.residential) {
    const lo = parseInt(t.zones, 10);
    const hi = t.zones.endsWith("+") ? Infinity : Number(t.zones.split("-").pop());
    if (n >= lo && n <= hi) return { key: t.key_fall, price: PRICING.items[t.key_fall].price };
  }
  return null;
}
const feeLine = (lines) => (lines || []).find((l) => /^fall_close_/.test(l?.key || ""));
const walk = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, location: `Zone ${from + i}`, status: "working_well" }));

const srv = await bootServer({ port: 4873 });
try {
  await srv.login();
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;
  const woRecord = (id) => srv.data("work-orders").find((w) => w.id === id);
  const now = () => new Date().toISOString();

  // ---- A. the customer signs --------------------------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    const booked = feeLine(f.wo.onSiteQuote?.builderLineItems);
    ok(booked?.key === fallTier(4).key, "control: seeded at the booked tier");
    await srv.prepClosing(f.wo.id, { extraZones: walk(5, 6) });
    // Sign + complete in ONE PATCH, with the If-Match the app sends.
    const r = await srv.qpatch(f.wo.id, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
    ok(r.status === 200, `the customer signs and the visit completes (${r.status} ${j(r.body.errors)})`);
    await sleep(300);
    const signed = feeLine(woRecord(f.wo.id)?.onSiteQuote?.builderLineItems);
    const want = fallTier(6);
    ok(signed?.key === want.key && signed?.originalPrice === want.price,
      `the SIGNED work order carries the walked tier (${j({ key: signed?.key, price: signed?.originalPrice })} vs ${j(want)})`);
    ok(Boolean(signed?.source?.pricedAtLock) && signed?.source?.recordedZones === 6, "…priced at the lock, from 6 recorded zones");
    const billed = feeLine(invoiceFor(f.wo.id)?.lineItems);
    ok(billed?.key === signed?.key && billed?.unitPrice === signed?.originalPrice,
      `the invoice line equals the signed line (${j({ key: billed?.key, price: billed?.unitPrice })})`);
    ok(!(woRecord(f.wo.id)?.history || []).some((h) => h.action === "seasonal_fee_reresolved" && /invoice only/.test(h.note)),
      "nothing was re-priced after signing (no 'invoice only' re-resolve)");
  }

  // ---- B. nobody home: bypass, then zones change -------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id, { extraZones: walk(5, 6) });
    const b = await srv.api("POST", `/api/work-orders/${f.wo.id}/signature-bypass`, { reason: "customer_not_home", note: "" });
    ok(b.status === 201 || b.status === 200, `bypass locks the work order (${b.status})`);
    const locked = feeLine(woRecord(f.wo.id)?.onSiteQuote?.builderLineItems);
    ok(locked?.key === fallTier(6).key && Boolean(locked?.source?.pricedAtLock), `the bypass priced the fee at the lock (${j(locked)})`);
    // Zones are not scope-protected; an edit after the lock must not move
    // the price the work order was locked with.
    const cur = woRecord(f.wo.id);
    const more = await srv.qpatch(f.wo.id, { zones: [...cur.zones, ...walk(7, 9)] });
    ok(more.status === 200, `a zone edit after the lock is accepted (${more.status})`);
    const done = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed" });
    ok(done.status === 200, `the visit completes (${done.status})`);
    await sleep(300);
    const billed = feeLine(invoiceFor(f.wo.id)?.lineItems);
    ok(billed?.key === locked?.key && billed?.unitPrice === locked?.originalPrice,
      `…and the invoice bills what was locked, not the 9 zones added later (${j({ key: billed?.key, price: billed?.unitPrice })})`);
  }

  // ---- C. a custom size at signing ----------------------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id, { extraZones: walk(5, 16) });
    const r = await srv.qpatch(f.wo.id, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
    ok(r.status === 200, `signs (${r.status})`);
    await sleep(300);
    const signed = feeLine(woRecord(f.wo.id)?.onSiteQuote?.builderLineItems);
    ok(signed?.priceStatus === "pending" && signed?.originalPrice == null && !("suggestion" in signed),
      `16 zones: the signed line is price PENDING, with no number (${j(signed)})`);
    const inv = invoiceFor(f.wo.id);
    ok(inv?.priceConfirm?.required === true && feeLine(inv?.lineItems)?.unitPrice > 0,
      "…the invoice carries the suggestion, unconfirmed");
  }

  // ---- D. the office's manual create-invoice ------------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id, { extraZones: walk(5, 6) });
    const ci = await srv.api("POST", `/api/work-orders/${f.wo.id}/create-invoice`, {});
    const line = feeLine(ci.body.invoice?.lineItems);
    ok(ci.status === 201 && line?.key === fallTier(6).key && line?.unitPrice === fallTier(6).price,
      `create-invoice bills the walked tier, not the booked one (${ci.status} ${j(line)})`);
  }

  // ---- E. the sign-off screen ---------------------------------------------
  const signOff = fs.readFileSync(new URL("../pjl-field/src/screens/closing/SignOffStage.js", import.meta.url), "utf8");
  ok(/getWorkOrder\(wo\.id\)/.test(signOff) && /d\?\.seasonalFee/.test(signOff), "sign-off reads the server's fee preview");
  ok(/PJL confirms the price after the visit/.test(signOff), "…says 'PJL confirms the price' for a size PJL prices");
  ok(!/suggestion|suggested/i.test(signOff.replace(/\/\/.*$/gm, "")), "…and never shows a suggested number to the customer");
} finally {
  if (failed) console.error(srv.logs().split("\n").filter((l) => /error|warn|fail/i.test(l)).slice(-15).join("\n"));
  await srv.stop();
}

console.log(`price-before-signing: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

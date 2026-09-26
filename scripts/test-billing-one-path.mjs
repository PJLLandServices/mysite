#!/usr/bin/env node
// scripts/test-billing-one-path.mjs
//
// What a work order bills has ONE answer: billing.billingFor(wo). Finish,
// "Generate invoice now" and the technician's pre-Finish preview all ask
// it, and nothing else prepares a price on its own.
//
// Before, each of the three assembled the price itself: load the property,
// ask whether the account is commercial, re-resolve the seasonal fee
// (frozen once signed), turn a price-pending line into its suggestion. The
// copies matched only by care. Patrick: "I don't want separate pricing
// logic patched independently in Finish, Generate Invoice, payment, etc."
//
//   A. the duplicated preparation is gone: outside lib/billing.js (and
//      lib/pricing.js itself) nothing calls refreshSeasonalBaseline or
//      billableLines, and lineItemsFromWo has one definition
//   B. for the same work order, in every pricing state, the preview, the
//      invoice Finish drafts and the invoice "Generate invoice now" drafts
//      carry ONE fee, and that is billingFor's:
//        walked more zones than booked · a custom size (price pending →
//        suggestion) · a commercial account (pending) · a per-property
//        rate · a $0 per-property rate (no charge: no invoice either way)
//   C. billingFor never writes the work order
//
// Run: node scripts/test-billing-one-path.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
const code = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const j = (v) => JSON.stringify(v);

// ---- A. one path ---------------------------------------------------------------
{
  const billing = read("server/lib/billing.js");
  ok(/async function billingFor\(/.test(billing), "A. server/lib/billing.js defines billingFor");
  for (const file of ["server/server.js", "server/lib/completion-cascade.js", "server/lib/invoices.js"]) {
    const src = code(read(file));
    ok(!/refreshSeasonalBaseline\(/.test(src), `A. ${file} does not re-resolve the seasonal fee itself`);
    ok(!/billableLines\(/.test(src), `A. ${file} does not build billable lines itself`);
  }
  const defs = ["server/server.js", "server/lib/completion-cascade.js", "server/lib/billing.js"]
    .filter((f) => /function lineItemsFromWo\(/.test(read(f)));
  ok(j(defs) === '["server/lib/billing.js"]', `A. lineItemsFromWo has one definition (${j(defs)})`);
  const cascade = code(read("server/lib/completion-cascade.js"));
  const server = code(read("server/server.js"));
  ok(/billingFor\(/.test(cascade), "A. Finish (completion cascade) asks billingFor");
  const ci = server.slice(server.indexOf("const woCreateInvoiceMatch"), server.indexOf("const woRunCascadeMatch"));
  ok(/billingFor\(/.test(ci), "A. Generate invoice now asks billingFor");
  const get = server.slice(server.indexOf("let seasonalFee = null;"), server.indexOf("let seasonalFee = null;") + 2500);
  ok(/billingFor\(/.test(get), "A. the technician's preview asks billingFor");
}

// ---- B. one answer ---------------------------------------------------------------
const srv = await bootServer({ port: 23000 + Math.floor(Math.random() * 9000) });
try {
  await srv.login();
  const billing = (() => { try { return srv.lib("billing.js"); } catch { return null; } })();
  const now = () => new Date().toISOString();
  const walk = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, location: `Zone ${from + i}`, status: "ok" }));
  const fee = (lines) => (lines || []).find((l) => /^fall_close/.test(l?.key || "")) || null;
  const price = (l) => (l ? Number(l.unitPrice ?? l.overridePrice ?? l.originalPrice) : null);
  let n = 0;

  // Two identical work orders per case: one finished by the tech (the cascade
  // drafts the invoice), one never finished, invoiced from the desk.
  async function twin(setup) {
    const out = [];
    for (let k = 0; k < 2; k++) {
      n += 1;
      const f = await srv.fixture({ zones: setup.booked, phone: `90555530${String(n).padStart(2, "0")}`, accountType: setup.accountType || "residential" });
      if (setup.rate !== undefined) {
        const p = await srv.api("PATCH", `/api/properties/${f.prop.id}`, { seasonalPricing: { fallClosingPrice: setup.rate } });
        if (p.status !== 200) {
          const props = srv.data("properties");
          const i = props.findIndex((x) => x.id === f.prop.id);
          props[i] = { ...props[i], seasonalPricing: { ...(props[i].seasonalPricing || {}), fallClosingPrice: setup.rate } };
          srv.writeData("properties", props);
        }
      }
      await srv.prepClosing(f.wo.id, { extraZones: setup.walked > setup.booked ? walk(setup.booked + 1, setup.walked) : [] });
      out.push(f);
    }
    return out;
  }

  const cases = [
    { name: "booked 4, walked 6", booked: 4, walked: 6 },
    { name: "a custom size: booked 4, walked 17", booked: 4, walked: 17 },
    { name: "a commercial account, 6 zones", booked: 6, walked: 6, accountType: "commercial" },
    { name: "a per-property rate", booked: 4, walked: 4, rate: 77 },
    { name: "a $0 per-property rate (no charge)", booked: 4, walked: 4, rate: 0, noCharge: true }
  ];
  for (const c of cases) {
    const [a, b] = await twin(c);
    const woBefore = srv.data("work-orders").find((w) => w.id === a.wo.id);
    const bill = billing?.billingFor ? await billing.billingFor(woBefore) : null;
    const woAfterRead = srv.data("work-orders").find((w) => w.id === a.wo.id);
    if (c === cases[0]) ok(j(woBefore) === j(woAfterRead), "C. billingFor never writes the work order");
    const preview = (await srv.api("GET", `/api/work-orders/${a.wo.id}`)).body.seasonalFee;

    const fin = await srv.api("PATCH", `/api/work-orders/${a.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
    await sleep(700);
    const finished = srv.data("invoices").find((i) => i.woId === a.wo.id) || null;
    const gen = await srv.api("POST", `/api/work-orders/${b.wo.id}/create-invoice`, {});
    const generated = gen.body.invoice || null;

    if (c.noCharge) {
      ok(fin.status === 200 && !finished, `B. ${c.name}: Finish drafts no invoice (${finished?.total})`);
      ok(gen.status === 409 && gen.body.code === "no_charge", `B. ${c.name}: Generate refuses it as no charge (${gen.status} ${gen.body.code})`);
      ok(bill?.noCharge === true, `B. ${c.name}: billingFor says no charge (${bill?.noCharge})`);
      ok(preview && Number(preview.atFinish?.price) === 0, `B. ${c.name}: the preview shows $0 (${j(preview?.atFinish)})`);
      continue;
    }
    const fFee = fee(finished?.lineItems), gFee = fee(generated?.lineItems), bFee = fee(bill?.lines);
    ok(fFee && gFee && fFee.key === gFee.key && price(fFee) === price(gFee),
      `B. ${c.name}: Finish and Generate bill the same fee (${j([fFee?.key, price(fFee)])} vs ${j([gFee?.key, price(gFee)])})`);
    ok(bFee && bFee.key === fFee?.key && price(bFee) === price(fFee),
      `B. ${c.name}: …and it is billingFor's (${j([bFee?.key, price(bFee)])})`);
    ok(Number(finished?.total) === Number(generated?.total) && Number(generated?.total) === Number(bill?.total),
      `B. ${c.name}: …same invoice total (${finished?.total} / ${generated?.total})`);
    // The preview tells the tech the price, or that PJL will price it.
    const pv = preview?.atFinish || null;
    const pending = bFee?.priceStatus === "suggested";
    ok(pending ? pv?.pending === true && pv?.price == null : pv && pv.key === fFee?.key && Number(pv.price) === price(fFee),
      `B. ${c.name}: the tech's preview agrees (${j(pv)} vs ${j([fFee?.key, price(fFee)])})`);
  }
} catch (e) {
  failed += 1;
  console.error(`  FAIL: crashed: ${e?.stack || e}`);
} finally {
  await srv.stop();
}

console.log(`billing-one-path: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

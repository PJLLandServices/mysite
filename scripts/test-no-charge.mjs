#!/usr/bin/env node
// scripts/test-no-charge.mjs
//
// A no-charge stop costs the customer nothing, and says so
// (fall-closing fix #8).
//
// Pressure test: a no-charge closing drafted a $0 invoice, opened a $0
// invoice screen with "Take payment" prefilled 0.00, allowed a payment
// link, and scheduled the customer's "your invoice is ready" text — the
// cascade checked that there WERE lines, not that they added up to
// anything. And Patrick's completion alert read "Estimated total $0.00 /
// No specific items selected" on every completion, billed or not.
//
// Booted server, temp data, email/SMS/Stripe stubbed:
//   A. a $0 property completes with NO invoice, no invoice text, no payment
//      prompt, and the app is told it was no charge (also on a retry)
//   B. a billed closing's alert carries its real total and its lines
//   C. a $0 invoice made by hand can't be opened for payment
//   D. the app lands on "No charge — done"
//
// Run: node scripts/test-no-charge.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const srv = await bootServer({ port: 4868 });
try {
  await srv.login();
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  const alerts = () => srv.outbox().filter((m) => m.channel === "email" && /WO COMPLETED/.test(m.subject));

  // ---- A. a $0 property ---------------------------------------------------
  {
    const f0 = await srv.fixture({ zones: 4 });
    await srv.api("PATCH", `/api/properties/${f0.prop.id}`, { seasonalPricing: { fallClosingPrice: 0 } });
    const w = await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: f0.prop.id });
    const id = w.body.workOrder.id;
    await srv.prepClosing(id);
    const before = srv.outbox().length;
    const c = await complete(id);
    await sleep(900);
    ok(c.status === 200, `the no-charge closing completes (${c.status})`);
    ok(!srv.data("invoices").some((i) => i.woId === id), "no invoice is drafted");
    ok(c.body.cascade?.invoiceId == null && c.body.cascade?.noCharge === true, `the app is told: no charge (${JSON.stringify(c.body.cascade)})`);
    const after = srv.outbox().slice(before);
    ok(!after.some((m) => m.channel === "sms" && m.to && !/5555550100/.test(m.to)), "no text goes to the customer");
    const cust = after.find((m) => m.channel === "email" && m.to.includes(f0.cust.email));
    ok(Boolean(cust), "the customer still gets their completion email");
    ok(!/Total for today's visit/.test(strip(cust?.html)), "…with no $0 total and no 'invoice will follow'");
    const alert = after.find((m) => /WO COMPLETED/.test(m.subject));
    ok(alert && !/No specific items selected/.test(strip(alert.html)), "Patrick's alert does not say 'No specific items selected'");
    ok(alert && /No charge/.test(strip(alert.html)), "…it says the visit was no charge");
    const retry = await srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed" });
    ok(retry.body.cascade?.noCharge === true && retry.body.cascade?.invoiceId == null, "a Finish retry is told the same");
  }

  // ---- B. a billed closing's alert tells the truth ------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id);
    const before = srv.outbox().length;
    const c = await complete(f.wo.id);
    await sleep(900);
    const inv = srv.data("invoices").find((i) => i.woId === f.wo.id);
    ok(inv && inv.total > 0, "control: a priced closing still drafts its invoice");
    ok(c.body.cascade?.noCharge === false, "…and is not called no charge");
    const alert = srv.outbox().slice(before).find((m) => /WO COMPLETED/.test(m.subject));
    const body = strip(alert?.html);
    ok(body.includes(`$${inv.total.toFixed(2)}`) && !/Estimated total \$0\.00/.test(body),
      `Patrick's alert shows the real total, not $0.00 (${(body.match(/Estimated total \S+/) || [""])[0]})`);
    ok(!/No specific items selected/.test(body), "…and the billed lines, not 'No specific items selected'");
  }

  // ---- C. a hand-made $0 invoice is not payable -----------------------------
  {
    const inv = await srv.lib("invoices.js").createDraft({ customerName: "Courtesy", lineItems: [{ label: "Courtesy closing", qty: 1, unitPrice: 0 }], paidOnSiteAtCompletion: true });
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 409 && link.body.code === "no_charge", `no payment link for $0 (${link.status} ${link.body.code})`);
  }
} finally {
  await srv.stop();
}

// ---- the invoice text and the app -----------------------------------------
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const notify = read("server/lib/notify-customer.js");
  const fn = notify.slice(notify.indexOf("async function sendInvoiceReadySMS"));
  ok(/if \(!\(Number\(invoice\.total\) > 0\)\)[\s\S]{0,300}skipped: "no_charge"/.test(fn.slice(0, 2500)),
    "sendInvoiceReadySMS refuses a $0 invoice");
  const closing = read("pjl-field/src/screens/ClosingScreen.js");
  const app = read("pjl-field/App.js");
  ok(/const noCharge = !invoiceId && data\?\.cascade\?\.noCharge === true;/.test(closing), "the closing screen reads the no-charge answer");
  ok(/else if \(noCharge\) setJob\(\{ kind: JOB\.NO_CHARGE/.test(app) && /<NoChargeScreen/.test(app), "the app lands on No charge — done");
  ok(/No charge — done/.test(read("pjl-field/src/screens/NoChargeScreen.js")), "…which says so");
  const requireFromApp = createRequire(path.join(ROOT, "pjl-field/package.json"));
  let babel = null;
  try { babel = requireFromApp("@babel/core"); } catch {}
  ok(Boolean(babel), "the app dependencies are installed (npm ci in pjl-field)");
  if (babel) {
    for (const rel of ["pjl-field/App.js", "pjl-field/src/screens/NoChargeScreen.js", "pjl-field/src/screens/ClosingScreen.js"]) {
      try { babel.parse(read(rel), { filename: rel, parserOpts: { sourceType: "module", plugins: ["jsx"] }, babelrc: false, configFile: false }); ok(true, rel); }
      catch (e) { ok(false, `${rel} parses: ${e.message}`); }
    }
  }
}

console.log(`no-charge: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

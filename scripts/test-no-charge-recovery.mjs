#!/usr/bin/env node
// scripts/test-no-charge-recovery.mjs
//
// A no-charge stop is FINISHED, not broken (PJL-100 #7).
//
// Fix #8 made a $0 closing create no invoice at all — the service record
// and the report are the visit's record. But every reader that asks "does
// this signed work order have an invoice?" still read that as a failure:
//   - the work-order list's "Needs invoice" filter listed every no-charge
//     stop, forever;
//   - the tech page's recovery banner said "Cascade fired, but no draft
//     invoice landed. Try Generate invoice now.";
//   - that button (POST /api/work-orders/:id/create-invoice) drafted a $0
//     invoice, and POST /api/invoices/:id/send then EMAILED THE CUSTOMER
//     A $0 INVOICE — the exact thing Fix #8 set out to stop.
//
// Booted server (scripts/lib/field-server.mjs), temp data, email/SMS/Stripe
// stubbed:
//   A. a completed no-charge stop reads noCharge on both work-order GETs
//   B. create-invoice refuses it (409 no_charge) and drafts nothing
//   C. a $0 invoice that exists anyway (made by hand, or older data) is
//      never sent or re-sent — nothing reaches the customer
//   D. a billed closing is unchanged: create-invoice answers with the
//      invoice on file, and send still emails it
//   E. the list filter and the tech banner read noCharge
//
// Run: node scripts/test-no-charge-recovery.mjs   (also in build:check)

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

const srv = await bootServer({ port: 4911 });
try {
  await srv.login();
  const complete = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  const invoiceMailsTo = (email) => srv.outbox().filter((m) => m.channel === "email" && m.to.includes(email) && /invoice/i.test(m.subject));

  // ---- A + B. the no-charge stop -----------------------------------------
  const f0 = await srv.fixture({ zones: 4 });
  await srv.api("PATCH", `/api/properties/${f0.prop.id}`, { seasonalPricing: { fallClosingPrice: 0 } });
  const w0 = await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: f0.prop.id });
  const id0 = w0.body.workOrder.id;
  await srv.prepClosing(id0);
  const c0 = await complete(id0);
  await sleep(900);
  ok(c0.status === 200 && c0.body.cascade?.noCharge === true, `setup: the $0 closing completes as no charge (${c0.status} ${JSON.stringify(c0.body.cascade)})`);

  const one = await srv.api("GET", `/api/work-orders/${id0}`);
  ok(one.body.workOrder?.noCharge === true, `A. GET /api/work-orders/:id says noCharge (got ${one.body.workOrder?.noCharge})`);
  const list = await srv.api("GET", "/api/work-orders");
  const row = (list.body.workOrders || []).find((w) => w.id === id0);
  ok(row && row.noCharge === true, `A. GET /api/work-orders lists it with noCharge (got ${row?.noCharge})`);

  const gen = await srv.api("POST", `/api/work-orders/${id0}/create-invoice`, {});
  ok(gen.status === 409 && gen.body.code === "no_charge", `B. "Generate invoice now" is refused 409 no_charge (got ${gen.status} ${gen.body.code || ""} ${gen.body.invoice?.id || ""})`);
  ok(!srv.data("invoices").some((i) => i.woId === id0), "B. …and no invoice is drafted");

  // ---- C. a $0 invoice that exists anyway ----------------------------------
  {
    const invoicesLib = srv.lib("invoices.js");
    const zero = await invoicesLib.createDraft({
      woId: "WO-HANDMADE0", propertyId: f0.prop.id, customerId: f0.cust.id,
      customerName: f0.cust.name, customerEmail: f0.cust.email, address: f0.prop.address,
      lineItems: [{ label: "Courtesy check", qty: 1, originalPrice: 0 }]
    });
    const before = invoiceMailsTo(f0.cust.email).length;
    const send = await srv.api("POST", `/api/invoices/${zero.id}/send`, {});
    ok(send.status === 409 && send.body.code === "no_charge", `C. sending a $0 invoice is refused 409 no_charge (got ${send.status} ${send.body.code || ""})`);
    const resend = await srv.api("POST", `/api/invoices/${zero.id}/resend`, {});
    ok(resend.status === 409 && resend.body.code === "no_charge", `C. re-sending it is refused too (got ${resend.status} ${resend.body.code || ""})`);
    await sleep(400);
    ok(invoiceMailsTo(f0.cust.email).length === before, `C. no $0 invoice email reaches the customer (got ${invoiceMailsTo(f0.cust.email).length - before})`);
  }

  // ---- D. a billed closing is unchanged -------------------------------------
  {
    const f1 = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f1.wo.id);
    const c1 = await complete(f1.wo.id);
    await sleep(900);
    const invId = c1.body.cascade?.invoiceId;
    ok(c1.status === 200 && invId, `D. a billed closing drafts its invoice (${c1.status} ${invId})`);
    const got = await srv.api("GET", `/api/work-orders/${f1.wo.id}`);
    ok(got.body.workOrder?.noCharge !== true, "D. …and is not marked noCharge");
    const again = await srv.api("POST", `/api/work-orders/${f1.wo.id}/create-invoice`, {});
    ok(again.status === 200 && again.body.alreadyExisted === true && again.body.invoice?.id === invId, `D. create-invoice still answers with the invoice on file (${again.status})`);
    const send = await srv.api("POST", `/api/invoices/${invId}/send`, {});
    await sleep(600);
    ok(send.status === 200, `D. a billed invoice still sends (${send.status} ${JSON.stringify(send.body.errors || "")})`);
    ok(invoiceMailsTo(f1.cust.email).length >= 1, "D. …and reaches the customer (the stub)");
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

// ---- E. the readers ------------------------------------------------------
{
  const index = fs.readFileSync(path.join(ROOT, "server/work-orders-index.js"), "utf8");
  const needs = index.slice(index.indexOf('currentStatus === "needs_invoice"'), index.indexOf('currentStatus === "unlocked"'));
  ok(/noCharge/.test(needs), "E. the \"Needs invoice\" filter leaves no-charge work orders out");
  const tech = fs.readFileSync(path.join(ROOT, "server/work-order-tech.js"), "utf8");
  const banner = tech.slice(tech.indexOf("function renderCascadeRecovery"), tech.indexOf("function renderCascadeRecovery") + 1500);
  ok(/noCharge/.test(banner), "E. the tech page's recovery banner does not offer \"Generate invoice now\" on a no-charge visit");
}

console.log(`\nno-charge-recovery: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-finish-after-crash.mjs
//
// A Finish retry after a crashed completion finishes the job (PJL-100 #2).
//
// Fix #4 answers a retried "complete" on an already-completed work order by
// LOOKING UP the invoice the first attempt drafted. But when the first
// attempt completed the work order and then never ran its cascade — the
// server restarted mid-request (a Render deploy) or the cascade threw —
// and the phone lost the response, the retry answered 200
// { alreadyRan: true, invoiceId: null }: "done", with no invoice, no
// service record and no customer email behind it, and nothing on the phone
// saying so.
//
// Booted server (scripts/lib/field-server.mjs), temp data, email/SMS stubbed:
//   A. a work order left completed with no cascade: the phone's retry runs
//      the cascade — one invoice, one service record, one customer email —
//      and hands back the invoice
//   B. two such retries at once still make exactly one of each
//   C. a retry after a completion that DID cascade is unchanged: same
//      invoice, nothing new drafted or sent
//
// Run: node scripts/test-finish-after-crash.mjs   (also in build:check)

import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4917 });
try {
  await srv.login();
  const invoicesFor = (id) => srv.data("invoices").filter((i) => i.woId === id);
  const recordsFor = (propId, id) => ((srv.data("properties").find((p) => p.id === propId) || {}).serviceRecords || []).filter((s) => s.woId === id);
  const customerMails = (email) => srv.outbox().filter((m) => m.channel === "email" && m.to.includes(email) && /complete|summary/i.test(m.subject));
  // What the phone sends for a job its re-read shows as already completed.
  const retry = (id) => srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed" });

  // The first Finish reached the server and completed the work order, then
  // the process died before the cascade (or the cascade threw): signed,
  // locked, completed, and nothing else.
  async function completedWithoutCascade() {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id);
    const all = srv.data("work-orders");
    const wo = all.find((w) => w.id === f.wo.id);
    const now = new Date().toISOString();
    Object.assign(wo, {
      status: "completed", completedAt: now, departedAt: now, arrivedAt: now, locked: true,
      signature: { ...(wo.signature || {}), ...SIGNATURE, signed: true, signedAt: now }
    });
    srv.writeData("work-orders", all);
    return f;
  }

  // ---- A. one retry --------------------------------------------------------
  {
    const f = await completedWithoutCascade();
    const r = await retry(f.wo.id);
    await sleep(900);
    ok(r.status === 200, `A. the retry is answered (${r.status})`);
    ok(invoicesFor(f.wo.id).length === 1, `A. the retry drafts the invoice (got ${invoicesFor(f.wo.id).length})`);
    ok(r.body.cascade?.invoiceId && r.body.cascade.invoiceId === invoicesFor(f.wo.id)[0]?.id, `A. …and hands it back to the phone (${JSON.stringify(r.body.cascade)})`);
    ok(recordsFor(f.prop.id, f.wo.id).length === 1, `A. one service record (got ${recordsFor(f.prop.id, f.wo.id).length})`);
    ok(customerMails(f.cust.email).length === 1, `A. the customer gets their completion email, once (got ${customerMails(f.cust.email).length})`);
  }

  // ---- B. two retries at once ------------------------------------------------
  {
    const f = await completedWithoutCascade();
    const [r1, r2] = await Promise.all([retry(f.wo.id), retry(f.wo.id)]);
    await sleep(900);
    ok(r1.status === 200 && r2.status === 200, `B. both retries answered (${r1.status}, ${r2.status})`);
    ok(invoicesFor(f.wo.id).length === 1, `B. exactly one invoice (got ${invoicesFor(f.wo.id).length})`);
    ok(recordsFor(f.prop.id, f.wo.id).length === 1, `B. exactly one service record (got ${recordsFor(f.prop.id, f.wo.id).length})`);
    ok(customerMails(f.cust.email).length === 1, `B. exactly one customer email (got ${customerMails(f.cust.email).length})`);
    ok(r1.body.cascade?.invoiceId && r1.body.cascade.invoiceId === r2.body.cascade?.invoiceId, "B. both get the same invoice id");
  }

  // ---- C. a normal lost-response retry is unchanged ---------------------------
  {
    const f = await srv.fixture({ zones: 4 });
    await srv.prepClosing(f.wo.id);
    const first = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE,
      arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    await sleep(900);
    const r = await retry(f.wo.id);
    await sleep(600);
    ok(first.status === 200 && r.status === 200, `C. first Finish and retry both 200 (${first.status}, ${r.status})`);
    ok(r.body.cascade?.invoiceId === first.body.cascade?.invoiceId && invoicesFor(f.wo.id).length === 1, "C. the retry returns the same invoice and drafts no other");
    ok(customerMails(f.cust.email).length === 1, `C. still one customer email (got ${customerMails(f.cust.email).length})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`\nfinish-after-crash: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

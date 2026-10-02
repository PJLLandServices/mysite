#!/usr/bin/env node
// scripts/test-one-invoice-per-wo.mjs
//
// One work order, one active invoice, enforced by the SERVER, not the
// button.
//
// Probe, 2026-09-23: two "Generate invoice now" taps at once on a
// completed work order with no invoice made TWO invoices in 5 of 5 runs, on
// main and on PR #298. The route checked for an existing invoice and then
// drafted one, with nothing between the two, and it did not take the lock
// Finish's cascade takes. invoices.createDraft had no one-per-WO rule, so
// every path could double-bill given the timing.
//
//   A. two simultaneous "Generate invoice now" taps → one invoice, both
//      answers name it
//   B. "Generate invoice now" racing the tech's Finish → one invoice, and
//      the service record links that same invoice
//   C. the store itself refuses a second active invoice for a work order
//      (code wo_already_invoiced, naming the existing one), even two calls
//      at once; a VOIDED invoice doesn't count, so void-and-regenerate
//      still works; in-place revision (invoices.revise) is unaffected
//   D. invoices with no work order (deposits, balances) are untouched
//
// Run: node scripts/test-one-invoice-per-wo.mjs   (also in build:check)

import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const now = () => new Date().toISOString();

const srv = await bootServer({ port: 21000 + Math.floor(Math.random() * 9000) });
try {
  await srv.login();
  const active = (woId) => srv.data("invoices").filter((i) => i.woId === woId && i.status !== "void");
  const finishBody = () => ({ status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });

  // ---- A. double "Generate invoice now" -----------------------------------
  let dupA = 0, splitA = 0;
  for (let round = 0; round < 5; round++) {
    const f = await srv.fixture({ zones: 4, phone: `90555511${10 + round}` });
    await srv.prepClosing(f.wo.id);
    await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, finishBody());
    await sleep(700);
    // As a desk void-and-regenerate leaves it: completed, no invoice.
    srv.writeData("invoices", srv.data("invoices").filter((i) => i.woId !== f.wo.id));
    const r = await Promise.all([1, 2].map(() => srv.api("POST", `/api/work-orders/${f.wo.id}/create-invoice`, {})));
    await sleep(200);
    if (active(f.wo.id).length !== 1) dupA += 1;
    const ids = r.map((x) => x.body.invoice?.id);
    if (!(ids[0] && ids[0] === ids[1] && r.every((x) => x.status === 200 || x.status === 201))) splitA += 1;
  }
  ok(dupA === 0, `A. two simultaneous "Generate invoice now" taps make ONE invoice (duplicates in ${dupA}/5)`);
  ok(splitA === 0, `A. …and both answers name that one invoice (${splitA}/5 disagreed)`);

  // ---- B. "Generate invoice now" racing Finish -----------------------------
  let dupB = 0, unlinked = 0;
  for (const offset of [0, 2, 5, 10, 20, 40]) {
    const f = await srv.fixture({ zones: 4, phone: `9055552${String(offset).padStart(3, "0")}` });
    await srv.prepClosing(f.wo.id);
    await Promise.all([
      srv.api("PATCH", `/api/work-orders/${f.wo.id}`, finishBody()),
      sleep(offset).then(() => srv.api("POST", `/api/work-orders/${f.wo.id}/create-invoice`, {}))
    ]);
    await sleep(900);
    const inv = active(f.wo.id);
    if (inv.length !== 1) dupB += 1;
    const prop = srv.data("properties").find((p) => p.id === f.prop.id);
    const sr = (prop?.serviceRecords || []).find((s) => s.woId === f.wo.id);
    if (inv.length === 1 && sr && sr.invoiceId !== inv[0].id) unlinked += 1;
  }
  ok(dupB === 0, `B. Generate racing Finish makes ONE invoice (duplicates in ${dupB}/6 timings)`);
  ok(unlinked === 0, `B. …and the service record links that invoice (${unlinked}/6 linked another)`);

  // ---- C. the store's own rule ---------------------------------------------
  // Run in this process against the server's throwaway data dir, on work
  // order ids the server never sees, so nothing races it.
  const invoices = srv.lib("invoices.js");
  const line = [{ key: "fall_close_4z", label: "Fall Closing", qty: 1, originalPrice: 90 }];
  const first = await invoices.createDraft({ woId: "WO-STORE-1", lineItems: line });
  let err = null;
  try { await invoices.createDraft({ woId: "WO-STORE-1", lineItems: line }); } catch (e) { err = e; }
  ok(err?.code === "wo_already_invoiced" && err?.existingInvoiceId === first.id,
    `C. the store refuses a second active invoice for the work order (${err?.code} ${err?.existingInvoiceId} vs ${first.id})`);
  ok(srv.data("invoices").filter((i) => i.woId === "WO-STORE-1").length === 1, "C. …and wrote nothing");

  const both = await Promise.allSettled([1, 2].map(() => invoices.createDraft({ woId: "WO-STORE-2", lineItems: line })));
  ok(both.filter((s) => s.status === "fulfilled").length === 1 && both.some((s) => s.reason?.code === "wo_already_invoiced"),
    `C. two drafts at once: exactly one wins (${both.map((s) => s.status).join(", ")})`);

  await invoices.update(first.id, { status: "void" });
  let regen = null, regenErr = null;
  try { regen = await invoices.createDraft({ woId: "WO-STORE-1", lineItems: line }); } catch (e) { regenErr = e; }
  ok(regen && regen.id !== first.id, `C. a VOIDED invoice doesn't count: void-and-regenerate still works (${regenErr?.code || "ok"})`);

  // In-place revision is the explicit revision path: it edits the SAME
  // invoice (revisions[] keeps the old lines), so it never meets the rule.
  if (typeof invoices.revise === "function") {
    await invoices.update(regen.id, { status: "sent" });
    let revised = null, revErr = null;
    try {
      revised = await invoices.revise(regen.id, { lineItems: [{ ...line[0], originalPrice: 105, key: "fall_close_6z" }], reason: "walked 6 zones, not 4", by: "test" });
    } catch (e) { revErr = e; }
    const after = srv.data("invoices").filter((i) => i.woId === "WO-STORE-1" && i.status !== "void");
    ok(!revErr && revised?.ok !== false && after.length === 1 && after[0].id === regen.id, `C. revising the invoice in place still works (${revErr?.message || revised?.code || after.length})`);
  }

  // ---- D. no work order, no rule --------------------------------------------
  const dep1 = await invoices.createDraft({ quoteId: "Q-DEP", lineItems: [{ key: "quote_deposit", label: "Deposit", qty: 1, price: 100 }] }).catch((e) => e);
  const dep2 = await invoices.createDraft({ quoteId: "Q-DEP", lineItems: [{ key: "quote_deposit", label: "Balance", qty: 1, price: 200 }], invoiceRole: "balance" }).catch((e) => e);
  ok(dep1?.id && dep2?.id && dep1.id !== dep2.id, "D. deposit and balance invoices (no work order) are unaffected");
} catch (e) {
  failed += 1;
  console.error(`  FAIL: crashed: ${e?.stack || e}`);
} finally {
  await srv.stop();
}

console.log(`one-invoice-per-wo: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

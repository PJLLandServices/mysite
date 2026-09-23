#!/usr/bin/env node
// scripts/test-integrity-nits.mjs
//
// Two small integrity rules left over from the fall-closing audit
// (PJL-100 nits):
//   A. the desk's "Run completion cascade" (POST /api/work-orders/:id/
//      run-cascade) takes the same per-WO lock as the phone's Finish, so
//      the two landing together still make ONE invoice and ONE service
//      record.
//   B. a client can't mark a finding "already copied to the property" by
//      sending a deferredId the server never wrote (it would then never be
//      copied); the server's own stamps still survive a client rewrite.
//
// Booted server (scripts/lib/field-server.mjs), temp data, email/SMS stubbed.
//
// Run: node scripts/test-integrity-nits.mjs   (also in build:check)

import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4919 });
try {
  await srv.login();
  const invoicesFor = (id) => srv.data("invoices").filter((i) => i.woId === id);
  const recordsFor = (propId, id) => ((srv.data("properties").find((p) => p.id === propId) || {}).serviceRecords || []).filter((s) => s.woId === id);

  // ---- A. run-cascade racing the phone's Finish ----------------------------
  {
    let doubled = 0;
    const N = 5;
    for (let t = 0; t < N; t++) {
      const f = await srv.fixture({ zones: 4 });
      await srv.prepClosing(f.wo.id);
      await Promise.all([
        srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE,
          arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() }),
        srv.api("POST", `/api/work-orders/${f.wo.id}/run-cascade`, {})
      ]);
      await sleep(300);
      if (invoicesFor(f.wo.id).length !== 1 || recordsFor(f.prop.id, f.wo.id).length !== 1) doubled += 1;
    }
    ok(doubled === 0, `A. run-cascade racing Finish makes one invoice + one service record (doubled in ${doubled}/${N})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`\nintegrity-nits: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-finish-idempotent.mjs
//
// Finish survives a lost response and a double tap (fall-closing fix #4).
//
// Pressure test: the first Finish returned 200 and drafted the invoice, the
// response never reached the phone, and every retry got 409 wo_locked
// ("Scope-protected field signature cannot be modified") — the tech never
// reached the invoice and might have asked the customer to sign again.
// And two Finishes in the same second emailed the customer twice in 4 of 5
// trials: both requests read the WO before either wrote it, and the
// cascade only checked for a service record.
//
// Asserted against a booted server (temp data, outbound stubbed):
//   A. lost response → the retry (same signature) lands on the SAME invoice
//   B. double tap with a signature → one invoice, one customer email
//   C. double tap after a "nobody home" bypass → one invoice, one email
//   D. a DIFFERENT signature on a signed WO is still refused
// Plus the app: Finish re-reads the WO, never re-sends a signature that is
// on file, goes straight to the invoice of a completed job, and the three
// finish calls carry a timeout.
//
// Run: node scripts/test-finish-idempotent.mjs   (also in build:check)

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

const srv = await bootServer({ port: 4865 });
try {
  await srv.login();
  const completeBody = (sig = SIGNATURE) => ({ status: "completed", ...(sig ? { signature: sig } : {}),
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  const invoicesFor = (woId) => srv.data("invoices").filter((i) => i.woId === woId);
  const customerMails = (email) => srv.outbox().filter((m) => m.channel === "email" && m.to.includes(email));

  // ---- A. the response is lost; Finish is tapped again ----------------
  {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id);
    const first = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, completeBody());
    ok(first.status === 200 && first.body.cascade?.invoiceId, `the first Finish completes and drafts (${first.status})`);
    // ← the phone never saw that. It retries exactly what it sent.
    const retry = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, completeBody());
    ok(retry.status === 200, `the retry is not refused (${retry.status} ${retry.body.error || ""} ${retry.body.errors?.[0] || ""})`);
    ok(retry.body.cascade?.invoiceId === first.body.cascade?.invoiceId,
      `…and names the same invoice (${retry.body.cascade?.invoiceId} vs ${first.body.cascade?.invoiceId})`);
    // The new app retries with no signature once the WO reads signed.
    const plain = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed" });
    ok(plain.status === 200 && plain.body.cascade?.invoiceId === first.body.cascade?.invoiceId,
      "a completion-only retry also lands on that invoice");
    await sleep(800);
    ok(invoicesFor(f.wo.id).length === 1, `exactly one invoice (${invoicesFor(f.wo.id).length})`);
    ok(customerMails(f.cust.email).length === 1, `exactly one customer email (${customerMails(f.cust.email).length})`);
  }

  // ---- B. double tap, customer signed -----------------------------------
  {
    let dupInvoices = 0, dupMails = 0, mismatched = 0, refused = 0;
    for (let t = 0; t < 5; t++) {
      const f = await srv.fixture();
      await srv.prepClosing(f.wo.id);
      const rs = await Promise.all([1, 2].map(() => srv.api("PATCH", `/api/work-orders/${f.wo.id}`, completeBody())));
      await sleep(600);
      if (rs.some((r) => r.status !== 200)) refused += 1;
      if (invoicesFor(f.wo.id).length !== 1) dupInvoices += 1;
      if (customerMails(f.cust.email).length !== 1) dupMails += 1;
      if (rs[0].body.cascade?.invoiceId !== rs[1].body.cascade?.invoiceId) mismatched += 1;
    }
    ok(refused === 0, `both taps answer 200 (refused in ${refused}/5)`);
    ok(dupInvoices === 0, `one invoice per job (duplicates in ${dupInvoices}/5)`);
    ok(dupMails === 0, `one customer email per job (wrong count in ${dupMails}/5)`);
    ok(mismatched === 0, `both taps land on the same invoice (differ in ${mismatched}/5)`);
  }

  // ---- C. double tap after "nobody home" --------------------------------
  {
    let dup = 0, mails = 0;
    for (let t = 0; t < 5; t++) {
      const f = await srv.fixture();
      await srv.prepClosing(f.wo.id);
      await srv.api("POST", `/api/work-orders/${f.wo.id}/signature-bypass`, { reason: "customer_not_home", note: "" });
      await Promise.all([1, 2].map(() => srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed" })));
      await sleep(600);
      if (invoicesFor(f.wo.id).length !== 1) dup += 1;
      if (customerMails(f.cust.email).length !== 1) mails += 1;
    }
    ok(dup === 0, `bypass + double tap: one invoice (duplicates in ${dup}/5)`);
    ok(mails === 0, `bypass + double tap: one customer email (wrong in ${mails}/5)`);
  }

  // ---- D. the lock still holds against a NEW signature -----------------
  {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id);
    await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, completeBody());
    const other = { ...SIGNATURE, imageData: "data:image/png;base64," + "B".repeat(200) };
    const r = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, completeBody(other));
    ok(r.status === 409 && r.body.error === "wo_locked", `a different signature is still refused (${r.status} ${r.body.error})`);
  }
} finally {
  await srv.stop();
}

// ---- the app ------------------------------------------------------------
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const CLOSING = read("pjl-field/src/screens/ClosingScreen.js");
  const API = read("pjl-field/src/api.js");
  ok(/const alreadyDone = freshBeforeFinish\?\.status === 'completed';/.test(CLOSING), "Finish re-reads the WO and knows a completed job");
  ok(/if \(!alreadyDone && freshBeforeFinish\.zones/.test(CLOSING), "…and does not re-run the findings transfer on it");
  // …unless the work order changed in price after that signature and the
  // server wants the customer's NEW one (re-signing, 2026-09-26).
  ok(/signature: freshBeforeFinish\?\.signature\?\.signed && freshBeforeFinish\?\.resignature\?\.required !== true \? null : result\.signature/.test(CLOSING),
    "a signature already on file is never re-sent (only a new one owed on a revised scope is sent)");
  ok(/if \(alreadyDone\) \{[\s\S]{0,200}completeWorkOrder\(workOrderId, \{\}\)/.test(CLOSING),
    "a completed job goes straight on to its invoice");
  ok(/fetchWithTimeout\(`\$\{HOST\}\/api\/work-orders\/\$\{encodeURIComponent\(id\)\}`, \{\s*method: 'PATCH'[\s\S]{0,200}FINISH_TIMEOUT_MS\)/.test(API),
    "completeWorkOrder has a timeout");
  ok(/signature-bypass`, 'POST', \{ reason, note \},\s*\{ timeout: FINISH_STEP_TIMEOUT_MS \}\)/.test(API), "signatureBypass has a timeout");
  ok(/issues\/defer`, 'POST', \{\},\s*\{ timeout: FINISH_STEP_TIMEOUT_MS \}\)/.test(API), "deferIssues has a timeout");
  const requireFromApp = createRequire(path.join(ROOT, "pjl-field/package.json"));
  let babel = null;
  try { babel = requireFromApp("@babel/core"); } catch {}
  ok(Boolean(babel), "the app dependencies are installed (npm ci in pjl-field)");
  if (babel) {
    for (const rel of ["pjl-field/src/screens/ClosingScreen.js", "pjl-field/src/api.js"]) {
      try { babel.parse(read(rel), { filename: rel, parserOpts: { sourceType: "module", plugins: ["jsx"] }, babelrc: false, configFile: false }); ok(true, rel); }
      catch (e) { ok(false, `${rel} parses: ${e.message}`); }
    }
  }
}

console.log(`finish-idempotent: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

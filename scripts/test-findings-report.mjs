#!/usr/bin/env node
// scripts/test-findings-report.mjs
//
// A closing's findings stay on the customer's Service Report
// (fall-closing fix #5).
//
// The app calls /issues/defer before completing. That route MOVED every
// finding to the property's deferred recommendations and cleared it off
// the work order — and the Service Report renders from the work order's
// zones. So the tech flagged a broken head, the report said "4 zones
// winterized", and the email said "anything the technician flagged is in
// your Service Report". Worse, a throw from addDeferredIssue was swallowed
// and the issue cleared anyway: silent data loss.
//
// Asserted against a booted server (temp data, outbound stubbed):
//   A. after defer + complete, the finding is still on the WO, in the
//      report PDF (pdftotext), in the customer email's summary, AND on the
//      property's deferred list — once, however often defer is retried.
//   B. a forced addDeferredIssue failure (damaged properties.json) keeps
//      the finding on the WO, unstamped, and the next call transfers it.
//   C. a deferred finding kept on a WO is never quoted by the rollup.
//
// Run: node scripts/test-findings-report.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const NOTE = "cracked rotor by driveway";
let pdftotext = true;
try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { pdftotext = false; }

const srv = await bootServer({ port: 4866 });
try {
  await srv.login();
  const woOf = (id) => srv.data("work-orders").find((w) => w.id === id);
  const propOf = (id) => srv.data("properties").find((p) => p.id === id);
  const issuesOf = (id) => (woOf(id)?.zones || []).flatMap((z) => z.issues || []);

  // ---- A. the finding survives defer + complete ------------------------
  {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id, { issues: true });
    const d1 = await srv.api("POST", `/api/work-orders/${f.wo.id}/issues/defer`, {});
    ok(d1.status === 200 && d1.body.deferredCount === 1, `defer copies the finding (${d1.status} ${d1.body.deferredCount})`);
    ok(issuesOf(f.wo.id).some((i) => i.notes === NOTE), "…and it is still on the work order");
    ok(issuesOf(f.wo.id).every((i) => i.deferredId), "…stamped with its deferred id");
    const d2 = await srv.api("POST", `/api/work-orders/${f.wo.id}/issues/defer`, {});
    ok(d2.status === 200 && d2.body.deferredCount === 0, "a retried defer copies nothing twice");
    ok((propOf(f.prop.id)?.deferredIssues || []).length === 1, `the property carries it forward once (${(propOf(f.prop.id)?.deferredIssues || []).length})`);

    const c = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE,
      arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    ok(c.status === 200, `the closing completes (${c.status})`);
    await sleep(1200);
    ok(issuesOf(f.wo.id).some((i) => i.notes === NOTE), "the completed WO still lists the finding");

    const snaps = woOf(f.wo.id)?.reportSnapshots || [];
    const pdf = snaps[snaps.length - 1]?.path;
    ok(pdf && fs.existsSync(pdf), "the completion wrote a Service Report PDF");
    if (pdf && fs.existsSync(pdf) && pdftotext) {
      const text = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
      ok(text.includes(NOTE), "the Service Report PDF shows the finding (pdftotext)");
      ok(!/4 zones winterized/.test(text), "…and does not claim a clean visit");
    } else if (!pdftotext) {
      console.log("  (pdftotext not installed — PDF text check skipped)");
    }
    const mail = srv.outbox().find((m) => m.channel === "email" && m.to.includes(f.cust.email));
    const body = (mail?.text || "") + (mail?.html || "");
    ok(/1 issue found across 4 zones/.test(body), "the customer email's summary names the finding");
    ok(!/4 zones winterized/.test(body), "…not \"4 zones winterized\"");
    const d3 = await srv.api("POST", `/api/work-orders/${f.wo.id}/issues/defer`, {});
    ok(d3.body.deferredCount === 0 && (propOf(f.prop.id)?.deferredIssues || []).length === 1,
      "the old app's defer-on-every-Finish stays a no-op after completion");
  }

  // ---- B. a failed transfer never loses the finding --------------------
  {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id, { issues: true });
    const good = fs.readFileSync(path.join(srv.DATA, "properties.json"), "utf8");
    fs.writeFileSync(path.join(srv.DATA, "properties.json"), good.slice(0, Math.floor(good.length / 2)));
    const d = await srv.api("POST", `/api/work-orders/${f.wo.id}/issues/defer`, {});
    fs.writeFileSync(path.join(srv.DATA, "properties.json"), good);
    ok(issuesOf(f.wo.id).some((i) => i.notes === NOTE), "a failed addDeferredIssue keeps the finding on the WO");
    ok(issuesOf(f.wo.id).every((i) => !i.deferredId), "…unstamped, so it is not mistaken for transferred");
    ok(d.status === 200 && (d.body.notTransferred || []).length === 1, `…and the response names it (${d.status} ${JSON.stringify(d.body.notTransferred || d.body.errors)})`);
    const again = await srv.api("POST", `/api/work-orders/${f.wo.id}/issues/defer`, {});
    ok(again.body.deferredCount === 1 && (propOf(f.prop.id)?.deferredIssues || []).length === 1,
      "the next call transfers it, once");
  }
} finally {
  await srv.stop();
}

// ---- C. a kept, deferred finding is never quoted ------------------------
{
  const issueRollup = require("../server/lib/issue-rollup.js");
  const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
  const wo = (deferredId) => ({ type: "service_visit", zones: [{ number: 1, issues: [{ id: "iss_1", type: "broken_head", qty: 1, notes: "", ...(deferredId ? { deferredId } : {}) }] }] });
  const live = issueRollup.rollupIssuesToLineItems(wo(null), PRICING).lineItems.length;
  const kept = issueRollup.rollupIssuesToLineItems(wo("def_x"), PRICING).lineItems.length;
  ok(live > 0, "control: an open finding is quoted on a service visit");
  ok(kept === 0, `a deferred finding kept on the WO is not quoted (${kept} lines)`);
}

// ---- D. the app only calls defer for findings not yet copied -----------
{
  const CLOSING = fs.readFileSync(new URL("../pjl-field/src/screens/ClosingScreen.js", import.meta.url), "utf8");
  ok(/z\.issues\?\.some\(i => !i\.deferredId\)\)\) await deferIssues/.test(CLOSING),
    "the app calls defer only while a finding is still uncopied");
}

console.log(`findings-report: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

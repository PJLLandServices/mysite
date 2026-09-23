#!/usr/bin/env node
// scripts/test-defer-races.mjs
//
// A finding reaches next spring exactly once, and copying it never erases
// anything else (PJL-100 #4 + #5).
//
// Fix #5 made the copy "copy, don't move" (the finding stays on the visit,
// stamped `deferredId`). Left open, measured 10/10 on main:
//   - two overlapping copies (a retried Finish, the web button and the
//     phone at once) both saw the finding unstamped: it landed on the
//     property TWICE;
//   - the defer routes wrote back the whole zones array read before the
//     copy, so a zone edit saved meanwhile was ERASED;
//   - a copy that failed was reported (notTransferred) but never retried —
//     the finding stayed on the report and never reached the spring list.
//
// Booted server (scripts/lib/field-server.mjs), temp data, email/SMS stubbed:
//   A. two bulk defers at once → one copy on the property
//   B. a bulk defer racing an office zone edit → the edit survives, the
//      finding is stamped
//   C. a per-issue defer racing the bulk defer → one copy
//   D. an emergency override racing the bulk defer → one copy
//   E. a copy that fails is reported and left unstamped; completing the
//      fall closing copies it (the cascade retries), once
//
// Run: node scripts/test-defer-races.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4915 });
try {
  await srv.login();
  const copiesOf = (propId, woId) => ((srv.data("properties").find((p) => p.id === propId) || {}).deferredIssues || [])
    .filter((d) => d.fromWoId === woId).length;
  const woOnDisk = (id) => srv.data("work-orders").find((w) => w.id === id);
  // A fall closing with one finding on zone 1, every gate answered.
  async function closingWithFinding() {
    const f = await srv.fixture({ zones: 3 });
    await srv.prepClosing(f.wo.id, { issues: true });
    const wo = woOnDisk(f.wo.id);
    const issue = wo.zones[0].issues[0];
    return { ...f, id: f.wo.id, issueId: issue.id };
  }
  const bulk = (id) => srv.api("POST", `/api/work-orders/${id}/issues/defer`, {});

  // ---- A. two bulk defers at once --------------------------------------
  {
    let doubled = 0;
    const N = 6;
    for (let t = 0; t < N; t++) {
      const c = await closingWithFinding();
      await Promise.all([bulk(c.id), bulk(c.id)]);
      if (copiesOf(c.prop.id, c.id) !== 1) doubled += 1;
    }
    ok(doubled === 0, `A. two overlapping bulk defers copy the finding once (twice in ${doubled}/${N})`);
  }

  // ---- B. a bulk defer racing a zone edit ----------------------------------
  {
    let lost = 0, unstamped = 0;
    const N = 6;
    for (let t = 0; t < N; t++) {
      const c = await closingWithFinding();
      const cur = woOnDisk(c.id);
      const edited = cur.zones.map((z, i) => (i === 1 ? { ...z, notes: `office note ${t}` } : z));
      await Promise.all([bulk(c.id), srv.api("PATCH", `/api/work-orders/${c.id}`, { zones: edited })]);
      const after = woOnDisk(c.id);
      if (after.zones[1]?.notes !== `office note ${t}`) lost += 1;
      if (!after.zones[0]?.issues?.[0]?.deferredId) unstamped += 1;
    }
    ok(lost === 0, `B. a zone edit saved during the copy survives (erased in ${lost}/${N})`);
    ok(unstamped === 0, `B. …and the finding is still stamped (unstamped in ${unstamped}/${N})`);
  }

  // ---- C. per-issue defer racing the bulk defer ------------------------------
  {
    let doubled = 0;
    const N = 6;
    for (let t = 0; t < N; t++) {
      const c = await closingWithFinding();
      await Promise.all([
        bulk(c.id),
        srv.api("POST", `/api/work-orders/${c.id}/zones/1/issues/${encodeURIComponent(c.issueId)}/defer`, {})
      ]);
      if (copiesOf(c.prop.id, c.id) !== 1) doubled += 1;
    }
    ok(doubled === 0, `C. a per-issue defer racing the bulk defer copies once (twice in ${doubled}/${N})`);
  }

  // ---- D. emergency override racing the bulk defer ---------------------------
  {
    let doubled = 0;
    const N = 4;
    for (let t = 0; t < N; t++) {
      const c = await closingWithFinding();
      await Promise.all([
        bulk(c.id),
        srv.api("POST", `/api/work-orders/${c.id}/zones/1/issues/${encodeURIComponent(c.issueId)}/emergency`, {
          severity_reason: "active_leak", customerSignature: { name: "Jane Customer", imageData: SIGNATURE.imageData }
        })
      ]);
      if (copiesOf(c.prop.id, c.id) !== 1) doubled += 1;
    }
    ok(doubled === 0, `D. an emergency override racing the bulk defer copies once (twice in ${doubled}/${N})`);
  }

  // ---- E. a failed copy is retried at completion -------------------------------
  {
    const c = await closingWithFinding();
    const propsFile = path.join(srv.DATA, "properties.json");
    const good = fs.readFileSync(propsFile);
    fs.writeFileSync(propsFile, '[{"id":"torn');                 // the property write fails
    const d = await bulk(c.id);
    fs.writeFileSync(propsFile, good);
    ok(Array.isArray(d.body.notTransferred) && d.body.notTransferred.length === 1, `E. the failed copy is reported (${d.status} ${JSON.stringify(d.body.notTransferred || d.body.errors || null).slice(0, 120)})`);
    ok(!woOnDisk(c.id).zones[0].issues[0].deferredId, "E. …and left unstamped, still on the visit");
    const done = await srv.api("PATCH", `/api/work-orders/${c.id}`, { status: "completed", signature: SIGNATURE,
      arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    await sleep(900);
    ok(done.status === 200, `E. the closing completes (${done.status})`);
    ok(copiesOf(c.prop.id, c.id) === 1, `E. completing it copies the finding to the property (copies: ${copiesOf(c.prop.id, c.id)})`);
    ok(Boolean(woOnDisk(c.id).zones[0].issues[0].deferredId), "E. …and stamps it on the visit");
    // A second pass (a re-run) copies nothing more.
    await srv.api("POST", `/api/work-orders/${c.id}/run-cascade`, {});
    await sleep(300);
    ok(copiesOf(c.prop.id, c.id) === 1, `E. a re-run does not copy it again (copies: ${copiesOf(c.prop.id, c.id)})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`\ndefer-races: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-task-progress-agrees.mjs
//
// THE PROGRESS BAR AND THE SERVER HAVE TO MEAN THE SAME THING.
//
// `computeProjectMetrics()` in server/lib/projects.js is the source of
// truth for how far along a job is, and its rule is cumulative:
//
//     a task's completion is 100 when its status is done,
//     otherwise its own percentComplete,
//     and the job's figure is the AVERAGE of those.
//
// `percentComplete` leads and `status` follows — addTaskProgress() sets
// the status FROM the percentage (0 = pending, 1-99 = in_progress,
// 100 = done), never the reverse.
//
// The rebuilt app drew its bar from `done / total` instead, which reports
// a task logged at 60% as ZERO. On a four-task job with every task at
// 75%, the server said 75% complete and the bar sat empty. This is the
// `zoneCount: areas.length` defect again in a different corner: a figure
// the server already computes properly, re-derived in the browser by a
// different rule, disagreeing in silence.
//
// The browser cannot call /metrics once per project on a 40-job list, so
// the rule is MIRRORED in admin-app/src/lib/format.ts. A mirror that is
// never held up against the original is just a second opinion — so this
// runs BOTH over the same task records and fails if they ever diverge.
//
// Section A lifts the real TypeScript function out of format.ts and runs
// it. Section B runs the REAL server function over REAL projects built
// through lib/projects.js. Section C puts them side by side.
//
// Run: node scripts/test-task-progress-agrees.mjs

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

// ---- A. the browser's rule, lifted from the real source -----------------
//
// Lifted rather than re-typed here: a copy of the rule written into this
// file would pass forever while the shipped one rotted. The guards below
// mean a rename or a rewrite fails the extraction loudly instead of
// quietly testing nothing.

const FORMAT_SRC = fs.readFileSync(path.join(ROOT, "admin-app", "src", "lib", "format.ts"), "utf8");

function liftPercentComplete() {
  const start = FORMAT_SRC.indexOf("export function projectPercentComplete(");
  assert.ok(start > 0, "projectPercentComplete is gone from format.ts — the app no longer mirrors the server rule");
  // The function ends at the first line that is exactly "}" at column 0.
  const rest = FORMAT_SRC.slice(start);
  const endRel = rest.indexOf("\n}\n");
  assert.ok(endRel > 0, "could not find the end of projectPercentComplete");
  let body = rest.slice(0, endRel + 3);

  // Strip the TypeScript so plain node can run it. Narrow, targeted
  // removals — not a general transpiler — and every one is asserted to
  // have left the ARITHMETIC untouched below.
  body = body
    .replace(/^export /, "")
    .replace(/:\s*Array<\{[^}]*\}>\s*\|\s*undefined/g, "")   // the parameter's type
    .replace(/\)\s*:\s*number\s*\{/, ") {")                   // the return type
    .replace(/\(t:\s*\{[^}]*\}\)/g, "(t)");                   // the inner callback's type

  // The extraction must not have eaten the rule itself.
  ok("the lifted rule still tests for a done task", /=== "done" \? 100/.test(body), body.slice(0, 200));
  ok("the lifted rule still falls back to percentComplete", /percentComplete/.test(body), body.slice(0, 200));
  ok("the lifted rule still AVERAGES rather than counts", /\/ list\.length/.test(body), body.slice(0, 200));

  const fn = new Function(`${body}\nreturn projectPercentComplete;`)();
  assert.equal(typeof fn, "function", "lifted value is not a function");
  return fn;
}

const browserRule = liftPercentComplete();

// ---- the cases, in Patrick's terms --------------------------------------
//
// Each is a real shape a job takes. The fourth is the regression: a crew
// two-thirds of the way through every task on the list.
const CASES = [
  { name: "a job with no tasks yet", tasks: [], expect: 0 },
  { name: "nothing started", tasks: [p(0), p(0), p(0)], expect: 0 },
  { name: "everything finished", tasks: [d(), d(), d()], expect: 100 },
  { name: "four tasks, every one three-quarters done", tasks: [p(75), p(75), p(75), p(75)], expect: 75 },
  { name: "one finished, one half done, two not started", tasks: [d(), p(50), p(0), p(0)], expect: 38 },
  { name: "a single task most of the way there", tasks: [p(90)], expect: 90 },
  { name: "a legacy done task carrying no percentComplete", tasks: [{ id: "t", status: "done" }], expect: 100 },
  { name: "a legacy done task beside a partial one", tasks: [{ id: "t", status: "done" }, p(40)], expect: 70 },
  { name: "thirds, which do not divide evenly", tasks: [p(100), p(0), p(0)], expect: 33 }
];

function p(pct) {
  return { id: "t" + pct + Math.random(), status: pct >= 100 ? "done" : pct > 0 ? "in_progress" : "pending", percentComplete: pct };
}
function d() { return { id: "d" + Math.random(), status: "done", percentComplete: 100 }; }

for (const c of CASES) {
  const got = browserRule(c.tasks);
  ok(`the app: ${c.name} reads ${c.expect}%`, got === c.expect, `got ${got}`);
}

// The specific thing that was wrong, stated as its own assertion so the
// regression cannot come back disguised as a rounding change.
ok(
  "a task in progress is no longer reported as not started",
  browserRule([p(60)]) === 60,
  `got ${browserRule([p(60)])}`
);
ok(
  "...and the old done/total rule really would have said zero",
  Math.round(([p(60)].filter((t) => t.status === "done").length / 1) * 100) === 0
);

// ---- B + C. the same records through the REAL server function -----------

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "work-orders.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const fp = path.join(DATA, f);
  backups.set(f, fs.existsSync(fp) ? fs.readFileSync(fp) : null);
}

try {
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));

  for (const c of CASES) {
    // Build the job for real: create it, add its tasks, then drive each
    // one to its percentage through addTaskProgress — the same call the
    // field app makes. Nothing is hand-written into the store, so the
    // status/percentComplete invariant is the server's, not mine.
    const proj = await projects.create({ name: `Progress probe — ${c.name}`, customerName: "Progress Co" });
    for (const t of c.tasks) {
      const added = await projects.addTask(proj.id, { description: "task" });
      const target = t.status === "done" && t.percentComplete === undefined ? 100 : (Number(t.percentComplete) || 0);
      if (target > 0) await projects.addTaskProgress(proj.id, added.id, target, null, { by: "test" });
    }

    const metrics = await projects.computeProjectMetrics(proj.id);
    const stored = (await projects.get(proj.id)).tasks || [];

    ok(
      `the server: ${c.name} reads ${c.expect}%`,
      metrics.percentComplete === c.expect,
      `got ${metrics.percentComplete}`
    );
    // The agreement itself, over the records the API actually returns.
    ok(
      `...and the app agrees, on the server's own records`,
      browserRule(stored) === metrics.percentComplete,
      `app ${browserRule(stored)} vs server ${metrics.percentComplete}`
    );
    // The count label stays a count — it is a different question and must
    // not have been quietly folded into the percentage.
    const doneCount = stored.filter((t) => t.status === "done").length;
    ok(
      `...and "X of Y" still counts finished tasks (${doneCount} of ${stored.length})`,
      doneCount === metrics.doneTasks && stored.length === metrics.totalTasks,
      `${doneCount}/${stored.length} vs ${metrics.doneTasks}/${metrics.totalTasks}`
    );
  }

  // The one that proves the two rules are not simply the same rule: a job
  // where counting and averaging MUST give different answers.
  {
    const proj = await projects.create({ name: "Progress probe — the disagreement", customerName: "Progress Co" });
    for (let i = 0; i < 4; i++) {
      const t = await projects.addTask(proj.id, { description: "task " + i });
      await projects.addTaskProgress(proj.id, t.id, 75, null, { by: "test" });
    }
    const metrics = await projects.computeProjectMetrics(proj.id);
    const stored = (await projects.get(proj.id)).tasks || [];
    const oldRule = Math.round((stored.filter((t) => t.status === "done").length / stored.length) * 100);

    ok("the server calls a job of four three-quarter tasks 75% complete", metrics.percentComplete === 75, `got ${metrics.percentComplete}`);
    ok("the app now says 75% too", browserRule(stored) === 75, `got ${browserRule(stored)}`);
    ok("and the rule it replaced would have drawn an EMPTY bar", oldRule === 0, `got ${oldRule}`);
  }
} finally {
  for (const [f, buf] of backups) {
    const fp = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(fp)) fs.rmSync(fp); }
    else fs.writeFileSync(fp, buf);
  }
}

console.log(`\ntask progress agrees: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

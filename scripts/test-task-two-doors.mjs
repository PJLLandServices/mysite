#!/usr/bin/env node
// scripts/test-task-two-doors.mjs
//
// ONE TASK RECORD, TWO DOORS.
//
// Patrick, setting the split between the field app and the workspace:
//
//   Field app          technicians clock in/out, update task progress,
//                      record daily work, photos, parts used, issues.
//   Project Workspace  Patrick plans and assigns tasks, reviews daily
//                      records and labour, approves change orders,
//                      manages materials, prepares billing.
//   Both               "task status should synchronize immediately, but
//                      there must be only one underlying task record."
//
// Until 2026-09-25 there was only ONE door. `/api/work-orders/:woId/
// tasks-done` writes the day's log line and then flips the project's
// master task — right order, one record — but it needs a work order, so a
// task could not be corrected or finished from the desk at all.
//
// `POST /api/projects/:id/tasks/:taskId/progress` is the second door onto
// the SAME record. The danger in a second door is obvious: two writers,
// two ideas of what "done" means, and a task that reads 100% on a phone
// and 60% in the office. So this executes both, alternately, against one
// task, and checks after every single write that:
//
//   1. there is still exactly ONE task record with that id,
//   2. both doors report the same percentage for it,
//   3. status follows the percentage by the server's invariant
//      (0 pending / 1-99 in_progress / 100 done) whichever door moved it,
//   4. the office door does NOT invent a work session — an office
//      correction is not a day's work, and hours are money.
//
// Run: node scripts/test-task-two-doors.mjs

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4831;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "work-orders.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* not up yet */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // ---- the door is gated like everything else under /api/projects -----
  {
    const r = await fetch(`${BASE}/api/projects/PROJ-1/tasks/task_x/progress`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent: 50 })
    });
    ok("the office progress route requires a session", r.status === 401 || r.status === 302 || r.status === 403, `status ${r.status}`);
  }

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "two-doors@local.test", name: "Two Doors", role: "admin", password: "two-doors-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "two-doors@local.test", password: "two-doors-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(cookie), String(login.status));
  const H = { cookie, "content-type": "application/json" };

  // ---- a real job, a real build work order, one real task -------------
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  const proj = await projects.create({ name: "Two doors — Aurora install", customerName: "Aurora Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const task = await projects.addTask(proj.id, { description: "Trench the mainline" });

  // A build-mode WO — the kind a multi-day install actually runs on. It
  // requires its parent project, which is exactly the link this test is
  // about: the WO reads the project's task and the project's task is
  // authoritative.
  const wo = await workOrders.create({
    type: "build",
    project: await projects.get(proj.id),
    workDate: "2026-09-25"
  });
  ok("a build work order exists for the job", Boolean(wo && wo.id), JSON.stringify(wo || null).slice(0, 160));

  // ---- helpers: read the task through EACH door ------------------------
  const throughProject = async () => {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks`, { headers: H });
    const j = await r.json();
    return (j.tasks || []).filter((t) => t.id === task.id);
  };
  const throughWorkOrder = async () => {
    // What the field app sees: the project task is authoritative and the WO
    // route reads it to decide the remaining percentage.
    const p = await projects.get(proj.id);
    return (p.tasks || []).filter((t) => t.id === task.id);
  };
  const sessionCount = async () => {
    const w = await workOrders.get(wo.id);
    return ((w && w.dailyLog && w.dailyLog.sessions) || []).length;
  };

  const expectedStatus = (pct) => (pct >= 100 ? "done" : pct > 0 ? "in_progress" : "pending");

  // After EVERY write: one record, both doors agreeing, status following.
  async function assertConsistent(label, expectPct) {
    const viaProject = await throughProject();
    const viaWo = await throughWorkOrder();
    ok(`${label}: exactly one task record carries that id`, viaProject.length === 1 && viaWo.length === 1,
      `project ${viaProject.length}, wo-side ${viaWo.length}`);
    const a = viaProject[0], b = viaWo[0];
    if (!a || !b) return;
    ok(`${label}: both doors report ${expectPct}%`,
      a.percentComplete === expectPct && b.percentComplete === expectPct,
      `project ${a.percentComplete}, wo-side ${b.percentComplete}`);
    ok(`${label}: status follows the percentage ("${expectedStatus(expectPct)}")`,
      a.status === expectedStatus(expectPct) && b.status === a.status,
      `${a.status} / ${b.status}`);
  }

  await assertConsistent("a new task", 0);

  // ---- 1. the FIELD door moves it -------------------------------------
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: task.id, percentDelta: 40 })
    });
    ok("the field app can log 40% done today", r.ok, `status ${r.status} ${(await r.clone().text()).slice(0, 160)}`);
    await assertConsistent("after the field logged 40%", 40);
  }

  // ---- 2. the OFFICE door corrects it ---------------------------------
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 75 })
    });
    const j = await r.json();
    ok("the office can set it to 75% without a work order", r.ok && j.ok, `status ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    await assertConsistent("after the office corrected it to 75%", 75);
    // The job's own figure rides back with it, from the server's own
    // calculation — the screen never works out what the change did.
    ok("...and the response carries the job's percentage from the server",
      j.metrics && j.metrics.percentComplete === 75, JSON.stringify(j.metrics || null));
  }

  // ---- 3. an office correction is not a day's work ---------------------
  ok("the office door invented no work session", (await sessionCount()) === 0, `sessions ${await sessionCount()}`);

  // ---- 4. the field door picks up where the office left off -----------
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: task.id, percentDelta: 25 })
    });
    ok("the field app can finish it from 75%", r.ok, `status ${r.status}`);
    await assertConsistent("after the field finished it", 100);
    const t = (await throughProject())[0];
    ok("a task finished on a visit records WHICH visit", t.completedByWoId === wo.id, String(t.completedByWoId));
    ok("...and when", Boolean(t.completedAt), String(t.completedAt));
  }

  // ---- 5. the office can roll a finished task back --------------------
  //
  // The correction path Patrick asked for: something was ticked off that
  // is not actually done. Rolling back below 100 must clear the completion
  // stamp, or the job keeps a completedAt for work that is outstanding.
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 60 })
    });
    ok("the office can reopen a task that was ticked off in error", r.ok, `status ${r.status}`);
    await assertConsistent("after the office reopened it", 60);
    const t = (await throughProject())[0];
    ok("reopening clears the completion date", t.completedAt === null, String(t.completedAt));
    ok("...and the visit it was credited to", t.completedByWoId === null, String(t.completedByWoId));
  }

  // ---- 6. the office can close it out, honestly ------------------------
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 100 })
    });
    ok("the office can finish a task from the desk", r.ok, `status ${r.status}`);
    await assertConsistent("after the office finished it", 100);
    const t = (await throughProject())[0];
    ok("it is dated", Boolean(t.completedAt), String(t.completedAt));
    // The honest part: no visit is credited, because there wasn't one.
    ok("...and credited to NO visit, because there wasn't one", t.completedByWoId === null, String(t.completedByWoId));
    ok("and still no work session was invented", (await sessionCount()) === 0);
  }

  // ---- 7. the door refuses nonsense -----------------------------------
  {
    const bad = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 140 })
    });
    ok("a percentage over 100 is refused", bad.status === 400, `status ${bad.status}`);
    const none = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(task.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({})
    });
    ok("a body with neither percent nor percentDelta is refused", none.status === 400, `status ${none.status}`);
    const ghost = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/task_nope/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 50 })
    });
    ok("an unknown task is a 404, not a silent no-op", ghost.status === 404, `status ${ghost.status}`);
    // And none of that moved the record.
    await assertConsistent("after three refused writes", 100);
  }

  // ---- 8. the job's percentage is the server's, throughout ------------
  {
    const t2 = await projects.addTask(proj.id, { description: "Set the controller" });
    await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(t2.id)}/progress`, {
      method: "POST", headers: H, body: JSON.stringify({ percent: 50 })
    });
    const m = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/metrics`, { headers: H });
    const mj = await m.json();
    // One task at 100, one at 50 → 75. A screen counting finished tasks
    // would say 50, which is the bug this phase exists to not repeat.
    ok("one finished task and one half-done reads 75% on the job",
      mj.metrics && mj.metrics.percentComplete === 75, JSON.stringify(mj.metrics || null));
    ok("...while the COUNT of finished tasks is still 1 of 2",
      mj.metrics.doneTasks === 1 && mj.metrics.totalTasks === 2,
      `${mj.metrics.doneTasks}/${mj.metrics.totalTasks}`);
  }
} finally {
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\ntask two doors: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

#!/usr/bin/env node
// scripts/test-task-history-protected.mjs
//
// OFFICE CORRECTIONS MUST NOT ERASE FIELD HISTORY.
//
// Patrick, reviewing the Tasks tab before merge — five rules, each one
// executed below:
//
//   1. Changing 40% to 20% updates the current task but preserves who
//      changed it, when, and that it came from the office.
//   2. Removing a task with work-order activity ARCHIVES it rather than
//      deleting its history.
//   3. A task may be permanently deleted only if nothing has ever
//      referenced it.
//   4. Reopening clears the completion state without deleting prior work
//      logs or recorded hours.
//   5. The new project-level route uses the same authentication and
//      project-access checks as the work-order route.
//
// Rules 2 and 3 did not hold when he asked. `removeTask()` spliced the
// record out of the array and refused only when the task was DONE — so a
// task at 40%, with the crew's daily-log lines and task-anchored photos
// pointing at its id, could be erased from the office and leave those
// references dangling against an id that existed nowhere.
//
// Archiving means the record stops COUNTING while everything that points
// at it still lands. So the sharp end of this file is not "is there an
// archivedAt field" — it is: after archiving, does every reader agree the
// task is gone, and does every reference still resolve?
//
// Run: node scripts/test-task-history-protected.mjs

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4835;
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

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "history@local.test", name: "Patrick Lyons", role: "admin", password: "history-probe-12345" });
  await users.create({ email: "tech@local.test", name: "A Technician", role: "tech", password: "tech-probe-12345" });

  const signIn = async (email, password) => {
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    return (r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""])
      .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  };
  const adminCookie = await signIn("history@local.test", "history-probe-12345");
  const techCookie = await signIn("tech@local.test", "tech-probe-12345");
  ok("both an admin and a tech can sign in", Boolean(adminCookie) && Boolean(techCookie));
  const H = { cookie: adminCookie, "content-type": "application/json" };

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  const proj = await projects.create({ name: "History — Aurora install", customerName: "Aurora Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const worked = await projects.addTask(proj.id, { description: "Trench the mainline" });
  const pristine = await projects.addTask(proj.id, { description: "Typed this by mistake" });
  const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-25" });

  const progressUrl = (taskId) =>
    `${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(taskId)}/progress`;
  const taskNow = async (taskId) =>
    ((await projects.get(proj.id)).tasks || []).find((t) => t.id === taskId);

  // ── RULE 5 · the same gate as the work-order route ────────────────
  //
  // Both are `needsAuth() === "user"`, which admits admin and tech and
  // refuses everyone else. There is no per-project ACL anywhere in this
  // system — it is single-tenant and staff-only — so "same project-access
  // checks" means exactly this, and the test says so rather than implying
  // a permission model that does not exist.
  {
    const woRoute = `${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`;
    const anonProj = await fetch(progressUrl(worked.id), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent: 10 })
    });
    const anonWo = await fetch(woRoute, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: worked.id, percentDelta: 10 })
    });
    ok("signed out, the office route refuses", anonProj.status >= 400, `status ${anonProj.status}`);
    ok("...exactly as the work-order route does", anonWo.status >= 400 && anonWo.status === anonProj.status,
      `office ${anonProj.status} vs field ${anonWo.status}`);

    const techProj = await fetch(progressUrl(worked.id), {
      method: "POST", headers: { cookie: techCookie, "content-type": "application/json" },
      body: JSON.stringify({ percent: 0 })
    });
    const techWo = await fetch(woRoute, {
      method: "POST", headers: { cookie: techCookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: worked.id, percentDelta: 0 })
    });
    ok("a signed-in tech is admitted by both routes alike",
      techProj.ok === techWo.ok, `office ${techProj.status} vs field ${techWo.status}`);
  }

  // ── the crew does a day's work ────────────────────────────────────
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: worked.id, percentDelta: 40 })
    });
    ok("the crew logs 40% from the field", r.ok, `status ${r.status}`);
  }
  // ...and clocks real hours against the job.
  {
    const started = await workOrders.startSession(wo.id, { labourersOnSite: 2, by: "tech" });
    const sid = started?.session?.id || started?.id || (await workOrders.get(wo.id)).dailyLog.sessions[0].id;
    await workOrders.endSession(wo.id, sid, { by: "tech" }).catch(() => {});
    const m = await projects.computeProjectMetrics(proj.id);
    ok("the job has recorded hours and a logged day", m.daysLogged >= 1, JSON.stringify(m).slice(0, 200));
  }
  const hoursBefore = (await projects.computeProjectMetrics(proj.id)).totalPersonHours;
  const logLinesBefore = ((await workOrders.get(wo.id)).dailyLog.tasksCompletedToday || []).length;

  // ── RULE 1 · 40% → 20% keeps who, when, and that it was the office ─
  {
    const before = (await projects.get(proj.id)).history.length;
    const r = await fetch(progressUrl(worked.id), {
      method: "POST", headers: H, body: JSON.stringify({ percent: 20 })
    });
    ok("the office can correct 40% down to 20%", r.ok, `status ${r.status}`);
    const t = await taskNow(worked.id);
    ok("the task now reads 20%", t.percentComplete === 20, String(t.percentComplete));

    const hist = (await projects.get(proj.id)).history;
    ok("the correction is written to the audit trail", hist.length > before, `${before} → ${hist.length}`);
    const entry = [...hist].reverse().find((h) => h.action === "task_progress" && String(h.note).includes(worked.id));
    ok("the entry exists for this task", Boolean(entry), JSON.stringify(hist.slice(-2)));
    if (entry) {
      ok("...it records WHO, by name and not a uid",
        entry.by === "Patrick Lyons", String(entry.by));
      ok("...it records WHEN", Boolean(entry.ts) && !Number.isNaN(Date.parse(entry.ts)), String(entry.ts));
      ok("...it records that the change came from the OFFICE, not a visit",
        /via manual/.test(String(entry.note)), String(entry.note));
      ok("...and what the change actually was (-20% → 20%)",
        /-20% → 20%/.test(String(entry.note)), String(entry.note));
    }
    // The earlier field entry is still there — a correction adds, never
    // overwrites.
    const fieldEntry = hist.find((h) => h.action === "task_progress" && /\+40% → 40% via /.test(String(h.note)));
    ok("the crew's original +40% entry is untouched", Boolean(fieldEntry),
      JSON.stringify(hist.filter((h) => h.action === "task_progress").map((h) => h.note)));
  }

  // ── RULE 3 · a task nothing ever touched really is deleted ─────────
  //
  // "Referenced" means something happened TO THE WORK. Planning is not a
  // reference: a task you typed wrong and renamed is still a typo, and if
  // renaming made it undeletable the list would fill with archived
  // mistakes nobody could clear. This caught a real flaw in the first cut
  // of the rule, which counted `task_updated` as activity.
  {
    const typo = await projects.addTask(proj.id, { description: "Mianline" });
    await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(typo.id)}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ description: "Mainline" })
    });
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(typo.id)}`,
      { method: "DELETE", headers: H });
    const j = await r.json();
    ok("renaming a task does not make it undeletable", r.ok && j.removed === typo.id, JSON.stringify(j));
    ok("...it is deleted, not archived", j.archived === null, JSON.stringify(j));
  }

  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(pristine.id)}`,
      { method: "DELETE", headers: H });
    const j = await r.json();
    ok("a never-touched task deletes outright", r.ok && j.removed === pristine.id, JSON.stringify(j));
    ok("...and is not archived instead", j.archived === null, JSON.stringify(j));
    ok("...and really is gone from the record",
      !((await projects.get(proj.id)).tasks || []).some((t) => t.id === pristine.id));
  }

  // ── RULE 2 · a task with field activity is ARCHIVED, not deleted ───
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(worked.id)}`,
      { method: "DELETE", headers: H });
    const j = await r.json();
    ok("a task with field activity is archived, not deleted", r.ok && j.archived === worked.id, JSON.stringify(j));
    ok("...and the response says so", j.removed === null, JSON.stringify(j));
    ok("...and gives the reasons it was kept",
      Array.isArray(j.reasons) && j.reasons.some((x) => /daily-log/.test(x)), JSON.stringify(j.reasons));

    const t = await taskNow(worked.id);
    ok("THE RECORD IS STILL THERE", Boolean(t), "the task was spliced out — references now dangle");
    if (t) {
      ok("...stamped with when it was archived", Boolean(t.archivedAt), String(t.archivedAt));
      ok("...and by whom, by name", t.archivedBy === "Patrick Lyons", String(t.archivedBy));
      ok("...and why", /daily-log/.test(String(t.archivedReason)), String(t.archivedReason));
      ok("...with its progress intact", t.percentComplete === 20, String(t.percentComplete));
    }

    // Everything that pointed at it still resolves.
    const woNow = await workOrders.get(wo.id);
    const lines = woNow.dailyLog.tasksCompletedToday || [];
    ok("the crew's daily-log line still points at a task that exists",
      lines.some((l) => l.taskId === worked.id) && Boolean(t), `${lines.length} lines`);
    ok("...and no daily-log line was removed", lines.length === logLinesBefore, `${logLinesBefore} → ${lines.length}`);
  }

  // ── an archived task stops counting, for EVERY reader ──────────────
  {
    const m = await projects.computeProjectMetrics(proj.id);
    ok("archived: the job's task count drops to 0", m.totalTasks === 0, JSON.stringify(m).slice(0, 160));
    ok("...and its percentage with it", m.percentComplete === 0, String(m.percentComplete));
    ok("...but the recorded hours are untouched", m.totalPersonHours === hoursBefore,
      `${hoursBefore} → ${m.totalPersonHours}`);
    ok("...and so are the days logged", m.daysLogged >= 1, String(m.daysLogged));

    const listed = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks`, { headers: H })).json();
    ok("the tasks endpoint leaves it off the list", !(listed.tasks || []).some((t) => t.id === worked.id),
      JSON.stringify((listed.tasks || []).map((t) => t.id)));
    const withArchived = await (await fetch(
      `${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks?includeArchived=1`, { headers: H })).json();
    ok("...but hands it over when asked for explicitly",
      (withArchived.tasks || []).some((t) => t.id === worked.id));

    // Neither door may move an archived task.
    const office = await fetch(progressUrl(worked.id), {
      method: "POST", headers: H, body: JSON.stringify({ percent: 90 })
    });
    ok("the office cannot move an archived task", office.status === 409, `status ${office.status}`);
    const field = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: worked.id, percentDelta: 10 })
    });
    ok("...and neither can the field", field.status === 409, `status ${field.status}`);
    ok("...so it is still at 20%", (await taskNow(worked.id)).percentComplete === 20);

    // Archiving twice is refused rather than silently re-stamped.
    const again = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/tasks/${encodeURIComponent(worked.id)}`,
      { method: "DELETE", headers: H });
    ok("archiving an archived task is refused", !again.ok, `status ${again.status}`);
  }

  // ── RULE 4 · reopening clears completion, keeps the work logs ──────
  {
    const t2 = await projects.addTask(proj.id, { description: "Set the controller" });
    // Finished on a real visit, with a real daily-log line behind it.
    const done = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: t2.id, percentDelta: 100 })
    });
    ok("the crew finishes a task on a visit", done.ok, `status ${done.status}`);
    const before = await taskNow(t2.id);
    ok("...and it is credited to that visit", before.completedByWoId === wo.id, String(before.completedByWoId));

    const logsBefore = ((await workOrders.get(wo.id)).dailyLog.tasksCompletedToday || [])
      .filter((l) => l.taskId === t2.id).length;
    const hrsBefore = (await projects.computeProjectMetrics(proj.id)).totalPersonHours;

    const r = await fetch(progressUrl(t2.id), { method: "POST", headers: H, body: JSON.stringify({ percent: 60 }) });
    ok("the office reopens it", r.ok, `status ${r.status}`);
    const after = await taskNow(t2.id);
    ok("the completion date is cleared", after.completedAt === null, String(after.completedAt));
    ok("...and the credited visit with it", after.completedByWoId === null, String(after.completedByWoId));
    ok("...and it reads 60%", after.percentComplete === 60, String(after.percentComplete));

    const logsAfter = ((await workOrders.get(wo.id)).dailyLog.tasksCompletedToday || [])
      .filter((l) => l.taskId === t2.id).length;
    ok("the crew's work log for that task SURVIVES the reopen", logsAfter === logsBefore,
      `${logsBefore} → ${logsAfter}`);
    const hrsAfter = (await projects.computeProjectMetrics(proj.id)).totalPersonHours;
    ok("...and the recorded hours are untouched", hrsAfter === hrsBefore, `${hrsBefore} → ${hrsAfter}`);
    const woHist = (await workOrders.get(wo.id)).history.filter((h) => String(h.note).includes(t2.id));
    ok("...and the work order's own history still names it", woHist.length > 0, String(woHist.length));
  }

  // ── re-seeding from the quote must not wipe archived tasks ─────────
  //
  // seedTasksFromQuote REPLACES the task array. Before archiving existed
  // that was harmless; now it is the one operation that could quietly
  // undo all of the above.
  {
    const p = await projects.get(proj.id);
    const archivedIds = (p.tasks || []).filter((t) => t.archivedAt).map((t) => t.id);
    ok("there is an archived task to protect", archivedIds.length === 1, JSON.stringify(archivedIds));
    const seeded = await projects.seedTasksFromQuote(proj.id, {
      id: "Q-TEST-1", lineItems: [{ id: "li_1", label: "Install mainline" }, { id: "li_2", label: "Commission" }]
    });
    const stillThere = (seeded.tasks || []).filter((t) => archivedIds.includes(t.id));
    ok("re-seeding from the proposal does NOT wipe the archived task",
      stillThere.length === archivedIds.length,
      `${archivedIds.length} archived before, ${stillThere.length} after`);
    const m = await projects.computeProjectMetrics(proj.id);
    ok("...and the archived one still does not count", m.totalTasks === 2, JSON.stringify(m).slice(0, 160));
  }
} finally {
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\ntask history protected: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

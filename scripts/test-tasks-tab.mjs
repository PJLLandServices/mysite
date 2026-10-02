#!/usr/bin/env node
// scripts/test-tasks-tab.mjs
//
// THE TASKS TAB — where Patrick plans, against what the crew actually did.
//
// Patrick's split, 2026-09-25: "Field app: technicians clock in/out,
// update task progress, record daily work... Project Workspace: you plan
// and assign tasks, review daily records and labour... Both: task status
// should synchronize immediately, but there must be only one underlying
// task record."
//
// So the thing worth executing in a browser is not "does the list
// render". It is:
//
//   1. The crew logs progress from the field, and THIS SCREEN shows it —
//      no copy, no second record, no refresh ritual.
//   2. Patrick corrects it from the desk, and the field's view of the
//      same task moves with it.
//   3. Every figure on the screen is the server's. The job's percentage
//      comes from /metrics; a screen that averages its own is the bug of
//      2026-09-25 wearing a new hat.
//   4. The things that change what a job says is outstanding — finishing
//      a task, reopening one, removing one — ask first, in the app's own
//      dialog and not a native confirm().
//
// Real server, real projects and work orders through the real libraries,
// real built bundle, real browser. No mocked API.
//
// Run: node scripts/test-tasks-tab.mjs
//      (Playwright — its own npm script, not in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4833;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const sandboxChromium = "/opt/pw-browsers/chromium";
  if (fs.existsSync(sandboxChromium)) return { executablePath: sandboxChromium };
  return {};
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "work-orders.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

const distIndex = path.join(ROOT, "server", "app-dist", "index.html");
ok("the built app shell is committed", fs.existsSync(distIndex));

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

let browser = null;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* not up yet */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "tasks-tab@local.test", name: "Tasks Tab", role: "admin", password: "tasks-tab-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "tasks-tab@local.test", password: "tasks-tab-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(rawCookie), String(login.status));
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);
  const H = { cookie: rawCookie, "content-type": "application/json" };

  // ---- a real job with a real crew ------------------------------------
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  const proj = await projects.create({ name: "Tasks tab — Newmarket install", customerName: "Newmarket Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const t1 = await projects.addTask(proj.id, { description: "Trench the mainline" });
  const t2 = await projects.addTask(proj.id, { description: "Set the valve boxes" });
  const t3 = await projects.addTask(proj.id, { description: "Program the controller" });
  const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-25" });

  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // A native dialog would hang the run; catching it is also how we prove
  // the app is not using one.
  const nativeDialogs = [];
  page.on("dialog", (d) => { nativeDialogs.push(d.message()); d.dismiss().catch(() => {}); });

  const tasksUrl = `${BASE}/app/projects/${encodeURIComponent(proj.id)}/tasks`;

  // ---- 1. the tab is real, and lists the real tasks -------------------
  {
    await page.goto(tasksUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("text=The list", { timeout: 10000 });
    const text = await page.locator("main").innerText();
    ok("the tab is no longer a placeholder", !/rebuilt for the field/i.test(text), text.slice(0, 300));
    ok("it lists the job's real tasks",
      /Trench the mainline/.test(text) && /Set the valve boxes/.test(text) && /Program the controller/.test(text),
      text.slice(0, 400));
    ok("a new task reads as not started", /not started/i.test(text), text.slice(0, 400));
    ok("the job reads 0% with nothing done", /\b0%/.test(text), text.slice(0, 400));
    ok("...and 0 of 3 tasks", /0 of 3/.test(text), text.slice(0, 400));
  }

  // ---- 2. the crew logs progress; THIS screen shows it -----------------
  //
  // The synchronisation Patrick asked for, executed rather than assumed:
  // the write goes through the FIELD route, and the office screen is then
  // loaded fresh and has to agree.
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/tasks-done`, {
      method: "POST", headers: H, body: JSON.stringify({ taskId: t1.id, percentDelta: 40 })
    });
    ok("the crew can log 40% from the field", r.ok, `status ${r.status}`);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=The list", { timeout: 10000 });
    const text = await page.locator("main").innerText();
    ok("the office screen shows the crew's 40%", /40%/.test(text), text.slice(0, 500));
    ok("...and that task now reads in progress", /in progress/i.test(text), text.slice(0, 500));
    // 40 + 0 + 0 over three tasks = 13%. A screen counting FINISHED tasks
    // would still say 0 — which is exactly the defect this phase exists
    // not to repeat.
    ok("the job's own percentage is the server's (13%, not 0%)", /\b13%/.test(text), text.slice(0, 500));
    ok("...while the task COUNT is still 0 of 3", /0 of 3/.test(text), text.slice(0, 500));
  }

  // ---- 3. person-hours and days come from the field, and are shown ----
  {
    const text = await page.locator("main").innerText();
    ok("the tab reports days logged", /days logged/i.test(text), text.slice(0, 500));
    ok("...and person-hours, named as clocked in the field",
      /person-hours/i.test(text) && /clocked in the field/i.test(text), text.slice(0, 600));
  }

  // ---- 4. Patrick corrects it from the desk ---------------------------
  {
    // Nudging to a coarse step does not interrogate him.
    await page.locator("li", { hasText: "Trench the mainline" }).getByRole("button", { name: "75%" }).click();
    await page.waitForFunction(() => /75%/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    const text = await page.locator("main").innerText();
    ok("a coarse correction applies without a dialog", /75%/.test(text), text.slice(0, 400));

    // ...and the FIELD's view of the same record moved with it.
    const p = await projects.get(proj.id);
    const stored = (p.tasks || []).find((t) => t.id === t1.id);
    ok("the field's view of that task moved too", stored.percentComplete === 75, String(stored.percentComplete));
    ok("there is still exactly one record for it",
      (p.tasks || []).filter((t) => t.id === t1.id).length === 1);
  }

  // ---- 5. finishing a task asks first, in the app's own dialog --------
  {
    await page.locator("li", { hasText: "Trench the mainline" }).getByRole("button", { name: "Mark done" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    const dlg = await page.locator('[role="alertdialog"]').innerText();
    ok("marking a task done asks first", /mark this task done/i.test(dlg), dlg.slice(0, 300));
    ok("...and says no visit is credited, because there wasn't one",
      /no visit is credited/i.test(dlg), dlg.slice(0, 300));

    // Escape cancels, and nothing moved.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    ok("Escape closes the dialog", (await page.locator('[role="alertdialog"]').count()) === 0);
    const afterCancel = (await projects.get(proj.id)).tasks.find((t) => t.id === t1.id);
    ok("...and cancelling changed nothing", afterCancel.percentComplete === 75, String(afterCancel.percentComplete));

    // Now go through with it.
    await page.locator("li", { hasText: "Trench the mainline" }).getByRole("button", { name: "Mark done" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    await page.getByRole("button", { name: "Mark it done" }).click();
    await page.waitForFunction(() => /1 of 3/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    const text = await page.locator("main").innerText();
    ok("the task is finished", /1 of 3/.test(text), text.slice(0, 400));
    ok("...and it says it was finished from the office", /from the office/i.test(text), text.slice(0, 600));

    const stored = (await projects.get(proj.id)).tasks.find((t) => t.id === t1.id);
    ok("the record credits no visit, honestly", stored.completedByWoId === null, String(stored.completedByWoId));
    ok("...and is dated", Boolean(stored.completedAt));
  }

  // ---- 6. reopening says what it undoes -------------------------------
  {
    await page.locator("li", { hasText: "Trench the mainline" }).getByRole("button", { name: "Reopen" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    const dlg = await page.locator('[role="alertdialog"]').innerText();
    ok("reopening a finished task asks first", /reopen this task/i.test(dlg), dlg.slice(0, 300));
    ok("...and warns it clears the completion date", /clears its completion date/i.test(dlg), dlg.slice(0, 300));
    await page.getByRole("button", { name: "Reopen it" }).click();
    await page.waitForFunction(() => /0 of 3/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    const stored = (await projects.get(proj.id)).tasks.find((t) => t.id === t1.id);
    ok("the completion date is cleared", stored.completedAt === null, String(stored.completedAt));
  }

  // ---- 7. planning: add, rename, remove --------------------------------
  {
    await page.getByPlaceholder("Add a task — what has to be done").fill("Backfill and rake");
    await page.getByRole("button", { name: "Add task" }).click();
    await page.waitForFunction(() => /Backfill and rake/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    ok("a task can be added from the desk", true);
    const after = (await projects.get(proj.id)).tasks;
    ok("...and it is on the job's own record", after.some((t) => t.description === "Backfill and rake"));

    // Rename an unfinished task.
    const row = page.locator("li", { hasText: "Backfill and rake" });
    await row.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Task description").fill("Backfill, rake and seed");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => /Backfill, rake and seed/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    ok("a task can be renamed", true);

    // A FINISHED task is locked on the server — so the screen must not
    // offer an Edit that would come back a 409.
    await page.locator("li", { hasText: "Set the valve boxes" }).getByRole("button", { name: "Mark done" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    await page.getByRole("button", { name: "Mark it done" }).click();
    await page.waitForFunction(() => /1 of 4/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    const doneRow = page.locator("li", { hasText: "Set the valve boxes" });
    ok("a finished task offers no Edit, because the server locks it",
      (await doneRow.getByRole("button", { name: "Edit" }).count()) === 0);
    ok("...but it can still be reopened", (await doneRow.getByRole("button", { name: "Reopen" }).count()) === 1);

    // Removing asks, and says what survives.
    await page.locator("li", { hasText: "Backfill, rake and seed" }).getByRole("button", { name: "Remove" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    const dlg = await page.locator('[role="alertdialog"]').innerText();
    ok("removing a task asks first", /remove this task/i.test(dlg), dlg.slice(0, 300));
    // This one was typed and renamed at the desk, never worked on — so the
    // question offers a real removal and promises nothing is lost if it
    // turns out otherwise.
    ok("...and promises the crew's records survive either way",
      /nothing the crew recorded is lost/i.test(dlg), dlg.slice(0, 400));
    await page.getByRole("button", { name: "Remove task" }).click();
    await page.waitForFunction(() => !/Backfill, rake and seed/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });
    ok("a never-worked task is really gone", true);
  }

  // ---- 7b. a task the crew worked on is ARCHIVED, and says so ---------
  //
  // The half-done one carries the field's daily-log line. Removing it must
  // offer archiving, in those words, and then keep it visible as archived
  // rather than vanishing it.
  {
    const row = page.locator("li", { hasText: "Program the controller" });
    await row.getByRole("button", { name: "50%" }).click();
    // Waiting for "50%" in the page text would match the BUTTON on every
    // unfinished row and pass instantly — wait on the record instead, then
    // reload so the screen is reading what the server actually holds.
    for (let i = 0; i < 50; i++) {
      const t = (await projects.get(proj.id)).tasks.find((x) => x.id === t3.id);
      if (t && t.percentComplete === 50) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const at50 = (await projects.get(proj.id)).tasks.find((x) => x.id === t3.id);
    ok("the desk moved that task to 50%", at50 && at50.percentComplete === 50, String(at50 && at50.percentComplete));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=The list", { timeout: 10000 });
    await page.locator("li", { hasText: "Program the controller" }).getByRole("button", { name: "Remove" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    const dlg = await page.locator('[role="alertdialog"]').innerText();
    ok("removing a worked task offers to ARCHIVE it", /archived rather than deleted/i.test(dlg), dlg.slice(0, 400));
    ok("...and says the crew's records still point at it",
      /still point at it/i.test(dlg), dlg.slice(0, 400));
    await page.getByRole("button", { name: "Archive it" }).click();
    await page.waitForSelector("text=Archived", { timeout: 10000 });
    const text = await page.locator("main").innerText();
    ok("it moves to an Archived section rather than disappearing",
      /Archived/.test(text) && /Program the controller/.test(text), text.slice(0, 700));
    ok("...which says why it was kept", /daily-log|progress logged|status/i.test(text), text.slice(-600));

    const stored = (await projects.get(proj.id)).tasks.find((t) => t.id === t3.id);
    ok("the record survives on the job", Boolean(stored) && Boolean(stored.archivedAt), JSON.stringify(stored || null).slice(0, 200));
    ok("...attributed to a person, not 'admin'", stored.archivedBy === "Tasks Tab", String(stored.archivedBy));
  }

  // ---- 7c. an accidental archive is undoable from the screen ----------
  {
    const row = page.locator("li", { hasText: "Program the controller" });
    await row.getByRole("button", { name: "Restore" }).click();
    await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
    const dlg = await page.locator('[role="alertdialog"]').innerText();
    ok("restoring asks first", /put this task back on the list/i.test(dlg), dlg.slice(0, 300));
    ok("...and says it comes back exactly where it was",
      /50%/.test(dlg) && /nothing needs rebuilding/i.test(dlg), dlg.slice(0, 400));
    await page.getByRole("button", { name: "Restore it" }).click();
    await page.waitForFunction(
      () => !/Archived/.test(document.querySelector("main")?.innerText || ""), { timeout: 10000 });

    const stored = (await projects.get(proj.id)).tasks.find((t) => t.id === t3.id);
    ok("the task is back on the job", stored && !stored.archivedAt, JSON.stringify(stored || null).slice(0, 160));
    ok("...at the progress it had", stored.percentComplete === 50, String(stored.percentComplete));
    const text = await page.locator("main").innerText();
    ok("...and it is back in the working list, not the archive",
      /Program the controller/.test(text) && !/Archived/.test(text), text.slice(0, 600));
  }

  // ---- 8. no native dialogs, anywhere ---------------------------------
  ok("the app never used a native alert/confirm/prompt", nativeDialogs.length === 0, nativeDialogs.join(" | "));

  // ---- 9. it still reads at phone width -------------------------------
  {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=The list", { timeout: 10000 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("nothing overflows a phone's width", overflow <= 1, `overflow ${overflow}px`);
    const text = await page.locator("main").innerText();
    ok("the list still reads on a phone", /Trench the mainline/.test(text), text.slice(0, 300));
  }

  ok("no page errors anywhere in the walk", pageErrors.length === 0, pageErrors.join(" | "));
  await ctx.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\ntasks tab: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

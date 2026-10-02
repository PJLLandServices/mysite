#!/usr/bin/env node
// scripts/test-workspace-handoff.mjs
//
// THE CLASSIC PROJECT PAGE HAS TO SAY WHERE THE NEW ONE IS.
//
// Patrick, after walking the Tasks release (#307): "the screen in this
// screenshot has not changed. It is still the classic project page, and
// it cannot display partial task progress — only checked or unchecked...
// we failed to make the transition obvious. You were sent back to an
// unchanged classic screen with no indication that the new Tasks
// interface lives somewhere else."
//
// He was right, and it is a bug in the TRANSITION rather than in either
// screen. Two pages for one job, both reachable, neither mentioning the
// other — so a shipped change looks like nothing happened, and the
// natural link from everywhere goes to the older one.
//
// Why the classic page stays the default: six of the workspace's nine
// tabs are still placeholders. Redirecting every project click there
// today would trade this confusion for a worse one — clicking Materials
// and finding a stub where the classic page has the real list. So the
// classic page keeps its job and gains a signpost, and the default moves
// when the tabs are real.
//
// What this pins:
//   1. The band exists, on a real project page, naming what moved.
//   2. Both links carry THIS job's id — a handoff to the wrong job, or
//      to a generic index, is worse than none.
//   3. They actually land on the workspace, which actually renders.
//   4. The Tasks list carries its own pointer, at the exact spot the
//      difference shows: this list cannot say 60%.
//   5. It survives phone width, where Patrick often reads.
//
// Run: node scripts/test-workspace-handoff.mjs
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
const PORT = 4837;
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
const TOUCHED = ["projects.json", "users.json"];
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
  await users.create({ email: "handoff@local.test", name: "Handoff Probe", role: "admin", password: "handoff-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "handoff@local.test", password: "handoff-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(rawCookie), String(login.status));
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);

  // A real job with a PARTLY finished task — the exact case the classic
  // page cannot draw and the workspace can.
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const proj = await projects.create({ name: "Handoff — Dundalk install", customerName: "Dundalk Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const t = await projects.addTask(proj.id, { description: "System mainline" });
  await projects.addTaskProgress(proj.id, t.id, 75, null, { by: "test" });
  await projects.addTask(proj.id, { description: "Trees" });

  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const classicUrl = `${BASE}/admin/project/${encodeURIComponent(proj.id)}`;
  const wsUrl = `/app/projects/${encodeURIComponent(proj.id)}`;

  // ---- 1. the band is there, and says what moved ----------------------
  {
    await page.goto(classicUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#projWorkspaceBand", { state: "visible", timeout: 10000 });
    const text = await page.locator("#projWorkspaceBand").innerText();
    ok("the classic project page carries a workspace band", text.length > 0);
    ok("...naming what actually moved there", /tasks/i.test(text) && /system design/i.test(text), text.slice(0, 300));
    ok("...and why this page looks unchanged",
      /done or not done/i.test(text), text.slice(0, 300));
    ok("...with the action as a real button, not a footnote",
      await page.locator("#projWorkspaceLink").evaluate((el) => el.classList.contains("pjl-btn-primary")));

    // Above the fold: the whole complaint was not noticing it.
    const box = await page.locator("#projWorkspaceBand").boundingBox();
    ok("the band is visible without scrolling", Boolean(box) && box.y < 600, JSON.stringify(box));
  }

  // ---- 2. the links carry THIS job ------------------------------------
  {
    const href = await page.locator("#projWorkspaceLink").getAttribute("href");
    ok("the band links to this job's workspace", href === wsUrl, String(href));
    const tasksHref = await page.locator("#projTasksWorkspaceLink").getAttribute("href");
    ok("the Tasks list links to this job's Tasks tab", tasksHref === `${wsUrl}/tasks`, String(tasksHref));
    // A handoff to a generic index would be worse than none.
    ok("neither link is a generic index",
      href !== "/app" && href !== "/app/projects" && tasksHref !== "/app/projects", `${href} / ${tasksHref}`);
  }

  // ---- 3. the Tasks list says it cannot show partial progress ---------
  //
  // This is where Patrick got burned: the classic list drew his 75% task
  // as an unticked box, and nothing on the row hinted otherwise.
  {
    const panel = page.locator("#projTasksPanel");
    if (await panel.count()) {
      await panel.evaluate((el) => { el.open = true; });
      await page.waitForTimeout(200);
      const t2 = await panel.innerText();
      ok("the Tasks panel points at the workspace for partial progress",
        /partial progress/i.test(t2), t2.slice(0, 400));
    } else {
      ok("the Tasks panel points at the workspace for partial progress", false, "no tasks panel rendered");
    }
  }

  // ---- 4. it actually lands, and the workspace actually renders -------
  {
    await page.click("#projWorkspaceLink");
    await page.waitForURL(`**${wsUrl}`, { timeout: 15000 });
    ok("clicking the band lands on this job's workspace", page.url().endsWith(wsUrl), page.url());
    await page.waitForSelector("text=Contract value", { timeout: 15000 });
    const wsText = await page.locator("main").innerText();
    ok("...and the workspace renders this job", /Handoff — Dundalk install/.test(wsText), wsText.slice(0, 300));

    // And the Tasks link lands on the tab that shows the 75%.
    await page.goto(classicUrl, { waitUntil: "networkidle" });
    // The Tasks panel opens collapsed, which is right — the pointer is
    // there for the moment you go looking at tasks, not before.
    await page.locator("#projTasksPanel").evaluate((el) => { el.open = true; });
    await page.waitForSelector("#projTasksWorkspaceLink", { state: "visible", timeout: 10000 });
    await page.click("#projTasksWorkspaceLink");
    await page.waitForURL(`**${wsUrl}/tasks`, { timeout: 15000 });
    await page.waitForSelector("text=The list", { timeout: 15000 });
    const taskText = await page.locator("main").innerText();
    ok("the Tasks link lands on the tab that can show partial progress",
      /75%/.test(taskText), taskText.slice(0, 400));
    // 75 + 0 over two tasks = 38%. The classic page would say 0 of 2.
    ok("...where the job reads 38%, not 0", /\b38%/.test(taskText), taskText.slice(0, 400));
  }

  // ---- 5. and the way back is still there -----------------------------
  {
    const backHref = await page.locator('a:has-text("classic")').first().getAttribute("href").catch(() => null);
    const wsBody = await page.locator("main").innerText();
    ok("the workspace still offers a way back to classic",
      Boolean(backHref) || /classic/i.test(wsBody), String(backHref));
  }

  // ---- 6. phone width -------------------------------------------------
  {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(classicUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#projWorkspaceBand", { state: "visible", timeout: 10000 });
    const box = await page.locator("#projWorkspaceBand").boundingBox();
    ok("the band is still visible on a phone", Boolean(box) && box.height > 0, JSON.stringify(box));
    const btn = await page.locator("#projWorkspaceLink").boundingBox();
    ok("...and its button is reachable, not off the side",
      Boolean(btn) && btn.x >= 0 && btn.x + btn.width <= 391, JSON.stringify(btn));
    ok("...and tappable", Boolean(btn) && btn.height >= 40, JSON.stringify(btn));
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("the band adds no horizontal overflow", overflow <= 1, `overflow ${overflow}px`);
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

console.log(`\nworkspace handoff: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

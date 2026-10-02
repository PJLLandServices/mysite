#!/usr/bin/env node
// scripts/test-corrected-hours-on-screen.mjs
//
// THE CORRECTED NUMBER HAS TO REACH THE SCREEN.
//
// The server-side protections are pinned by
// scripts/test-session-hours-protected.mjs. This one asks the only
// question that test cannot: after the office corrects a session, does
// the number PATRICK LOOKS AT change?
//
// It exists because the first cut of that change got this wrong in a way
// every server-side assertion passed through. The classic project page
// was rewired to stop recalculating hours and read the server's figure
// instead — but personHours is a SIBLING of workOrder in the API
// response, and the page's loader does `.map((d) => d.workOrder)`. The
// field was dropped on the floor. The API served 9.00, the test asserted
// 9.00 on the API, and the page would have drawn 0.00 person-hrs on
// every day of every build job.
//
// A total that is served correctly and displayed wrongly is worse than
// one that is simply wrong, because everything upstream looks healthy.
// So this walk reads the rendered text.
//
// Run: node scripts/test-corrected-hours-on-screen.mjs
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
const PORT = 4841;
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
  await users.create({ email: "screen@local.test", name: "Marguerite Sowande", role: "admin", password: "screen-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "screen@local.test", password: "screen-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("the office can sign in", login.ok && Boolean(rawCookie), String(login.status));
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);
  const H = { cookie: rawCookie, "content-type": "application/json" };

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));
  const proj = await projects.create({ name: "Screen — Holland Landing install", customerName: "Holland Landing Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
  // The classic page reads project.workOrderIds[] as the source of truth
  // for which days belong to this job — creating the WO does not set it.
  await projects.attachWorkOrder(proj.id, wo.id);

  // 8am–noon Toronto, three on site. The field's answer: 12.00 person-hrs.
  const store = path.join(DATA, "work-orders.json");
  {
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    const rec = all.find((w) => w.id === wo.id);
    rec.dailyLog.sessions = [{
      id: "SESS-A",
      inAt: "2026-09-24T12:00:00.000Z",
      outAt: "2026-09-24T16:00:00.000Z",
      labourersOnSite: 3,
      labourerNote: "",
      startedBy: "Tobias Vantol"
    }];
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
  }

  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const classicUrl = `${BASE}/admin/project/${encodeURIComponent(proj.id)}`;
  const openDailyLog = async () => {
    await page.goto(classicUrl, { waitUntil: "networkidle" });
    const panel = page.locator("#projDailyLogPanel");
    await panel.waitFor({ state: "attached", timeout: 10000 });
    await panel.evaluate((el) => { el.open = true; });
    await page.waitForTimeout(300);
    return (await panel.innerText()).replace(/\s+/g, " ");
  };

  // ---- 1. the field's figure is on screen -----------------------------
  {
    const text = await openDailyLog();
    ok("the day list shows the field's 12.00 person-hrs", /12\.00 person-hrs/.test(text), text.slice(0, 300));
    // THIS is the assertion the dropped-field bug fails: it drew 0.00.
    ok("...and not a zero from a field that never arrived", !/0\.00 person-hrs/.test(text), text.slice(0, 300));
  }

  // ---- 2. an office correction moves the number the office reads ------
  //
  // The crew left at 11, not noon. 3 hours × 3 on site = 9.00.
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/sessions/SESS-A/times`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ outAt: "2026-09-24T15:00:00.000Z", reason: "Crew left at 11, clocked out late" })
    });
    ok("the office correction is accepted", r.ok, `status ${r.status}`);

    const text = await openDailyLog();
    ok("the day list now shows the CORRECTED 9.00 person-hrs", /9\.00 person-hrs/.test(text), text.slice(0, 300));
    ok("...and the uncorrected 12.00 is gone from the screen", !/12\.00 person-hrs/.test(text), text.slice(0, 300));
  }

  // ---- 3. the workspace is fed the same figure ------------------------
  //
  // Two screens, one job, one figure. The workspace Overview does not
  // show person-hours on screen YET — that tile arrives with the Overview
  // screen, which Patrick put LAST in the build order (Tasks → Daily
  // Records → Materials → Change Orders → Financials → Overview). So the
  // check here is on the data the workspace reads, not on a tile that
  // does not exist. When the Overview tile lands, this becomes a text
  // assertion like the two above.
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/metrics`, { headers: { cookie: rawCookie } });
    const j = await r.json().catch(() => ({}));
    const hours = j?.metrics?.totalPersonHours ?? j?.totalPersonHours;
    ok("the workspace's own metrics report the corrected 9 person-hours", hours === 9, JSON.stringify(j).slice(0, 300));

    // And the workspace still renders without error on this job.
    await page.goto(`${BASE}/app/projects/${encodeURIComponent(proj.id)}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Contract value", { timeout: 15000 });
    const wsText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    ok("...and the workspace nowhere reports the uncorrected 12",
      !/12(\.\d+)? person-hour/i.test(wsText), wsText.slice(0, 300));
  }

  // ---- 4. a correction did not invent a second day --------------------
  {
    const text = await openDailyLog();
    const days = (text.match(/person-hrs/g) || []).length;
    ok("the job still shows exactly one logged day", days === 1, `${days} day rows`);
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

console.log(`\ncorrected hours on screen: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

#!/usr/bin/env node
// scripts/test-app-shell-rebuild.mjs
//
// The rebuilt front end (2026-09-21), end to end.
//
// Patrick: "Treat the existing application as a functional prototype,
// not the final interface. Preserve its data models, APIs, calculations
// and business rules, but rebuild the user interface from a clean
// foundation... Build the replacement interface alongside it, migrate
// one workflow at a time and remove an old screen only after the
// replacement has been tested."
//
// So this test is the "after the replacement has been tested" half. It
// boots the REAL server, logs in as a real admin, creates real projects
// through the real library, and then drives the REAL built bundle in a
// real browser — no mocked API, no hand-rolled fixtures of the server's
// own responses.
//
// What it pins:
//   1. /app is behind the same staff login as /admin — the new door is
//      not a looser one.
//   2. /app and a deep link like /app/projects/PROJ-… both serve the
//      app shell, so a refresh or a pasted link lands on the right
//      screen instead of a 404.
//   3. The hashed bundles serve from /app-assets/ with the right
//      content types (a JS bundle served as text/html is a white page).
//   4. The Projects list renders REAL projects from /api/projects, with
//      the real status, customer and task progress.
//   5. Filters and search operate on that real data.
//   6. A project opens into the workspace, showing the real contract
//      value and the tabs, without a page navigation.
//   7. The classic CRM is untouched: /admin/projects still serves the
//      old page, byte-identically routed.
//
// Run: node scripts/test-app-shell-rebuild.mjs
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
const PORT = 4823;
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

// The built bundle has to exist before any of this means anything —
// a stale or missing server/app-dist is the one failure mode that
// would make every other assertion below vacuously pass.
const distIndex = path.join(ROOT, "server", "app-dist", "index.html");
ok("built app shell is committed at server/app-dist/index.html", fs.existsSync(distIndex));
const distHtml = fs.existsSync(distIndex) ? fs.readFileSync(distIndex, "utf8") : "";
const assetMatch = distHtml.match(/\/app-assets\/(assets\/[^"']+\.js)/);
ok("shell references a hashed JS bundle under /app-assets/", Boolean(assetMatch), distHtml.slice(0, 200));

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

  // ---- 1. the new door is gated like the old one ----------------------
  {
    const r = await fetch(`${BASE}/app`, { redirect: "manual" });
    ok("/app requires a login (no session -> redirect)", r.status === 302 || r.status === 303, `status ${r.status}`);
    const rDeep = await fetch(`${BASE}/app/projects`, { redirect: "manual" });
    ok("/app/projects requires a login too", rDeep.status === 302 || rDeep.status === 303, `status ${rDeep.status}`);
  }

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "app-shell-probe@local.test", name: "App Shell Probe", role: "admin", password: "app-shell-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "app-shell-probe@local.test", password: "app-shell-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(rawCookie), `${login.status}`);
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);

  // ---- 2. real projects, through the real library ----------------------
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const active = await projects.create({
    name: "Rebuild probe — active install",
    customerName: "Greentree Construction",
    address: "101 Symington St, Southgate, ON",
    status: "planning"
  });
  await projects.update(active.id, { status: "active", buildTracking: true });
  // Three tasks, one done — a real progress figure the list must show.
  await projects.addTask(active.id, { description: "Mainline" });
  await projects.addTask(active.id, { description: "Zone 1" });
  const t3 = await projects.addTask(active.id, { description: "Controller" });
  const addedTasks = (await projects.get(active.id)).tasks || [];
  if (addedTasks[0]) await projects.markTaskComplete(active.id, addedTasks[0].id, {}).catch(() => {});
  void t3;

  const planning = await projects.create({
    name: "Rebuild probe — planning job",
    customerName: "Hillcrest Property Group",
    address: "22 Maple Ave, Newmarket, ON"
  });

  // ---- 3. shell + assets serve correctly with a session ---------------
  {
    const shell = await fetch(`${BASE}/app`, { headers: { cookie: rawCookie } });
    const body = await shell.text();
    ok("/app serves the app shell when signed in", shell.ok && body.includes('id="root"'), `status ${shell.status}`);
    ok("shell is HTML", (shell.headers.get("content-type") || "").includes("text/html"));

    const deep = await fetch(`${BASE}/app/projects/${encodeURIComponent(active.id)}`, { headers: { cookie: rawCookie } });
    const deepBody = await deep.text();
    ok("a deep link serves the same shell (client routing survives refresh)", deep.ok && deepBody.includes('id="root"'), `status ${deep.status}`);

    if (assetMatch) {
      const js = await fetch(`${BASE}/app-assets/${assetMatch[1].replace(/^assets\//, "assets/")}`);
      const ct = js.headers.get("content-type") || "";
      ok("the JS bundle serves from /app-assets/", js.ok, `status ${js.status}`);
      ok("the JS bundle serves as JavaScript, not HTML", /javascript/.test(ct), ct);
    }
  }

  // ---- 4. the classic CRM is untouched --------------------------------
  {
    const classic = await fetch(`${BASE}/admin/projects`, { headers: { cookie: rawCookie } });
    const body = await classic.text();
    ok("/admin/projects still serves the existing CRM page", classic.ok && body.includes("projects.js"), `status ${classic.status}`);
  }

  // ---- 5. drive the real built app in a real browser -------------------
  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/app/projects`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Rebuild probe — active install", { timeout: 10000 }).catch(() => {});

  const listText = await page.locator("main").innerText();
  ok("Projects list renders a real project from /api/projects", listText.includes("Rebuild probe — active install"));
  ok("the real customer name is shown", listText.includes("Greentree Construction"));
  ok("real task progress is shown (1 of 3 done)", /1\/3/.test(listText), listText.slice(0, 400));

  // The Active filter is the default; the planning job should be hidden
  // until the filter changes — real filtering over real records.
  ok("planning job is filtered out of the default Active view", !listText.includes("Rebuild probe — planning job"));
  await page.click('button:has-text("Planning")');
  await page.waitForTimeout(150);
  const planningText = await page.locator("main").innerText();
  ok("Planning filter reveals the planning job", planningText.includes("Rebuild probe — planning job"));
  ok("Planning filter hides the active job", !planningText.includes("Rebuild probe — active install"));

  // Search operates on the same real records.
  await page.click('button:has-text("All")');
  await page.fill('input[type="search"]', "Hillcrest");
  await page.waitForTimeout(150);
  const searchText = await page.locator("main").innerText();
  ok("search matches on customer name", searchText.includes("Rebuild probe — planning job"));
  ok("search excludes non-matches", !searchText.includes("Rebuild probe — active install"));

  // ---- 6. into the project workspace, client-side ---------------------
  await page.fill('input[type="search"]', "");
  await page.waitForTimeout(150);
  await page.click(`text=Rebuild probe — active install`);
  await page.waitForSelector("text=Contract value", { timeout: 10000 });
  let wsText = await page.locator("main").innerText();
  ok("opening a project lands on its workspace", wsText.includes("Rebuild probe — active install"));
  ok("the workspace shows the project id", wsText.includes(active.id));
  ok("the workspace shows real task counts", /1 of 3/.test(wsText), wsText.slice(0, 500));
  // Tab labels are uppercased by CSS, so innerText reads "SYSTEM DESIGN".
  ok("workspace tabs are present", /system design/i.test(wsText) && /closeout/i.test(wsText), wsText.slice(0, 500));
  ok("navigating into a project did not leave the app", page.url().includes("/app/projects/"));

  // ---- 6a. a sold job is never told to "send the proposal" -----------
  // A project carrying a proposalSnapshot came from an ACCEPTED
  // proposal. If a revision is raised afterwards the linked quote goes
  // back to draft — reading only that status told a crew mid-install to
  // go and send a proposal on a job they were already building.
  {
    const projectsLib = require(path.join(ROOT, "server", "lib", "projects.js"));
    const sold = await projectsLib.create({ name: "Rebuild probe — sold job", customerName: "Sold Co" });
    await projectsLib.update(sold.id, { status: "active" });
    // Write the snapshot the way conversion does (it isn't a writable
    // field through update()).
    const storePath = path.join(DATA, "projects.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    for (const rec of store) {
      if (rec.id !== sold.id) continue;
      rec.status = "active";
      rec.proposalSnapshot = { quoteId: "Q-SOLD-1", version: 2, total: 18400, acceptedAt: "2026-09-10T12:00:00Z", proposalSections: [] };
      rec.systemDesign = { areas: [{ aid: "a1" }, { aid: "a2" }], version: 1 };
      rec.history = [{ ts: "2026-09-09T12:00:00Z", action: "system_design_saved", by: "t", note: "" }];
    }
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    await page.goto(`${BASE}/app/projects/${encodeURIComponent(sold.id)}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Contract value", { timeout: 10000 });
    await page.waitForTimeout(250);
    const soldText = await page.locator("main").innerText();
    ok(
      "a sold job is never told to send the proposal",
      !/send the proposal/i.test(soldText),
      soldText.slice(0, 500)
    );
    ok(
      "a sold job with no visits booked asks for a date",
      /schedule installation/i.test(soldText),
      soldText.slice(0, 500)
    );
  }

  // Back to the active probe job for the remaining overview checks.
  await page.goto(`${BASE}/app/projects/${encodeURIComponent(active.id)}`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Contract value", { timeout: 10000 });
  await page.waitForTimeout(250);
  wsText = await page.locator("main").innerText();

  // ---- 6b. the overview answers "what do I do next" ------------------
  // Patrick, on the first cut: "Right now the overview tells me what the
  // project contains, but not what needs to happen next. For an active
  // project, this is the most important information." This job is active
  // with no design and no proposal, so the honest next step is the
  // design — and the card has to say so, with the evidence.
  ok("the overview leads with a Next action", /next action/i.test(wsText), wsText.slice(0, 600));
  ok("the next action is derived from real state (no design yet)", /start the system design/i.test(wsText), wsText.slice(0, 600));

  // The contract value appears ONCE — as a summary figure. Patrick:
  // "Remove the duplicated $24,680.33. It appears as both Contract Value
  // and Quote Value."
  const valueOccurrences = (wsText.match(/Contract value/gi) || []).length;
  ok("contract value is labelled once, in the summary", valueOccurrences === 1, `found ${valueOccurrences}`);

  // The four summary figures are the way into their sections.
  ok("summary carries the four figures", /contract value/i.test(wsText) && /project progress/i.test(wsText) && /system design/i.test(wsText) && /billing/i.test(wsText));
  await page.click('button:has-text("Project progress")');
  await page.waitForTimeout(200);
  ok("clicking a summary figure opens its section", page.url().endsWith("/tasks"), page.url());
  await page.goBack();
  await page.waitForTimeout(200);

  // Empty activity state does the asking, with the action in it.
  const overviewText = await page.locator("main").innerText();
  ok(
    "empty activity state invites the first entry",
    /no project updates have been recorded/i.test(overviewText),
    overviewText.slice(0, 600)
  );

  // One word for the customer-facing document. Patrick: "Pick one term
  // consistently... I'd use Proposal."
  ok("the document is called a proposal, not a quote", !/\bquote\b/i.test(overviewText), overviewText.slice(0, 800));

  // A tab switch is client-side: the URL changes, the shell does not
  // reload, and the pending tabs are honest rather than dead.
  await page.click('a:has-text("Change Orders")');
  await page.waitForTimeout(200);
  ok("a tab switch is client-side routing", page.url().endsWith("/changes"));
  const tabText = await page.locator("main").innerText();
  ok("an unbuilt tab names its workflow and offers the classic screen", /Change orders/i.test(tabText) && /classic CRM/i.test(tabText));

  ok("no page errors in the rebuilt app", pageErrors.length === 0, pageErrors.join(" | "));

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

console.log(`\napp shell rebuild: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

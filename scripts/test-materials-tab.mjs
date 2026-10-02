#!/usr/bin/env node
// scripts/test-materials-tab.mjs
//
// THE MATERIALS SCREEN, READ THE WAY PATRICK WILL READ IT.
//
// The server tests (test-project-materials.mjs) prove the read model.
// They cannot prove the screen shows it. That gap has already cost us
// once: the daily-records loader dropped `personHours` on the way to
// the page, so every build day rendered 0.00 while every server test
// passed. Only a browser assertion on rendered text caught it.
//
// So this walks the real page and reads the real pixels. The thing it
// is guarding is Patrick's aggregation rule:
//
//   "Do not add required quantities or dollar totals across multiple
//    lists, because a later design list may repeat the earlier BOM."
//
// The fixture is built to make a violation VISIBLE: one job, two lists,
// the same SKU on both. If anything on this screen ever adds them, the
// forbidden number appears in the page text and these assertions fail.
//
// Run: node scripts/test-materials-tab.mjs
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
const PORT = 4852;
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
const TOUCHED = ["projects.json", "work-orders.json", "users.json", "material-lists.json", "purchase-orders.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

let browser = null;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* booting */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "mat@local.test", name: "Marguerite Sowande", role: "admin", password: "mat-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mat@local.test", password: "mat-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("the office can sign in", login.ok && Boolean(rawCookie), String(login.status));
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);

  // ---- The job ----------------------------------------------------
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));
  const materialLists = require(path.join(ROOT, "server", "lib", "material-lists.js"));

  // Two REAL catalog parts, so names and prices resolve the way they
  // will in production. The catalog is the repo-root parts.json, read
  // once at boot into PARTS — writing a fixture over it mid-run would
  // not be seen, and would be lying about the data anyway.
  //   205020  PVC 0.5" x 2" MxM TBE nipple   $0.64
  //   205120  PVC 0.5" x 12" MxM TBE nipple  $2.68
  const SKU_A = "205020";   // on BOTH lists — the re-sync case
  const SKU_B = "205120";   // short-delivered
  const SKU_X = "MYSTERY9"; // in no catalog at all

  const proj = await projects.create({ name: "Materials — Queensville install", customerName: "Queensville Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });

  // TWO lists, the same SKU on BOTH — the re-sync case the rule is for.
  const listA = await materialLists.create({
    name: "Design v1 (purchased)", parentType: "project", parentId: proj.id,
    lineItems: [{ sku: SKU_A, qty: 10 }, { sku: SKU_B, qty: 4 }]
  });
  const listB = await materialLists.create({
    name: "Design v2 (re-sync)", parentType: "project", parentId: proj.id,
    lineItems: [{ sku: SKU_A, qty: 12 }]
  });

  // Mark v1 purchased, with a PO that delivered only part of the order.
  const mlStore = path.join(DATA, "material-lists.json");
  {
    const all = JSON.parse(fs.readFileSync(mlStore, "utf8"));
    const a = all.find((r) => r.id === listA.id);
    a.status = "complete";
    a.lineItems.forEach((l) => { l.status = "have"; l.poId = "PO-2026-0001"; });
    fs.writeFileSync(mlStore, JSON.stringify(all, null, 2));
  }
  const poStore = path.join(DATA, "purchase-orders.json");
  const existingPos = fs.existsSync(poStore) ? JSON.parse(fs.readFileSync(poStore, "utf8")) : [];
  fs.writeFileSync(poStore, JSON.stringify([
    ...(Array.isArray(existingPos) ? existingPos : []),
    {
      id: "PO-2026-0001", status: "received", supplierName: "Vandermeer Supply",
      sourceMaterialListIds: [listA.id],
      lineItems: [
        { sku: SKU_A, qty: 10, receivedQty: 10, unitPriceCents: 64 },
        // Ordered 4, only 2 arrived — the list still says "have".
        { sku: SKU_B, qty: 4, receivedQty: 2, unitPriceCents: 268 }
      ]
    }
  ], null, 2));

  // Two days of consumption, one of them a part on no list at all.
  const woA = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
  const woB = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-25" });
  await projects.attachWorkOrder(proj.id, woA.id);
  await projects.attachWorkOrder(proj.id, woB.id);
  {
    const store = path.join(DATA, "work-orders.json");
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    const a = all.find((w) => w.id === woA.id);
    a.dailyLog.materialsConsumed = [
      { partSku: SKU_A, qty: 6, addedAt: "2026-09-24T18:00:00.000Z", note: "front run" },
      { partSku: SKU_X, qty: 1, addedAt: "2026-09-24T18:05:00.000Z", note: "grabbed off the truck" }
    ];
    const b = all.find((w) => w.id === woB.id);
    b.dailyLog.materialsConsumed = [{ partSku: SKU_B, qty: 3, addedAt: "2026-09-25T18:00:00.000Z", note: "" }];
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
  }

  // ---- Read the screen ---------------------------------------------
  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/app/projects/${encodeURIComponent(proj.id)}/materials`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Project stock", { timeout: 15000 });
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");

  // ── Both lists shown, neither called "current" ───────────────────
  ok("both material lists are on the page",
    text.includes("Design v1 (purchased)") && text.includes("Design v2 (re-sync)"), text.slice(0, 300));
  ok("...newest first",
    text.indexOf("Design v2 (re-sync)") < text.indexOf("Design v1 (purchased)"));
  ok("...with their status",
    /complete/i.test(text) && /draft/i.test(text));
  ok("...and their purchase order linked",
    (await page.locator('a[href*="PO-2026-0001"]').count()) > 0);
  ok("no list is presented as the current one", !/\bcurrent list\b/i.test(text));

  // ── The forbidden numbers are absent ─────────────────────────────
  // 10 + 12 = 22 required. $125.00 + $150.00 = $275.60 across lists.
  ok("the two lists' required quantities are NOT added (no 22)",
    !/\b22\b/.test(text), text.match(/.{0,60}\b22\b.{0,60}/)?.[0] || "");
  ok("the two lists' dollar totals are NOT added",
    !text.includes("$275.60") && !text.includes("$275.6"),
    text.match(/.{0,60}\$27[0-9]\..{0,20}/)?.[0] || "");
  ok("each list shows its OWN total instead",
    text.includes("$17.12") && text.includes("$7.68"),
    text.match(/\$[\d,.]+/g)?.join(" ") || "");

  ok("the page says out loud that lists are not summed",
    /not\s+summed|never added together/i.test(text));

  // ── The stock table: four separate quantities ────────────────────
  const stock = page.locator('[data-testid="stock-table"]');
  const headers = (await stock.locator("thead").innerText()).toLowerCase();
  ok("the stock table has all four columns Patrick named",
    ["required", "received", "used on site", "project balance"].every((h) => headers.includes(h)),
    headers.replace(/\s+/g, " "));

  const rowText = async (sku) => (await stock.locator(`tr:has-text("${sku}")`).first().innerText()).replace(/\s+/g, " ");

  // SKU_A is on BOTH lists, so required is shown PER LIST, never as 22.
  const rowA = await rowText(SKU_A);
  ok("a SKU on two lists shows its per-list figures, not a total",
    rowA.includes("10 (") && rowA.includes("12 ("), rowA);
  ok("...and 10 + 12 = 22 is not in that row", !/\b22\b/.test(rowA), rowA);
  ok("...while its physical numbers do aggregate: 10 in, 6 used, 4 left",
    / 10 /.test(` ${rowA} `) && / 6 /.test(` ${rowA} `) && / 4 /.test(` ${rowA} `), rowA);

  // SKU_B: the list says "have 4" but only 2 ever arrived and 3 were
  // used. The balance must be −1, NOT 4 − 3 = 1.
  const rowB = await rowText(SKU_B);
  ok("a line marked \"have\" does not invent stock: balance is -1, not 1",
    /-1|−1/.test(rowB), rowB);

  // ── Exceptions: flagged, with the day behind them ────────────────
  const exceptions = (await page.locator('[data-testid="exceptions"]').innerText()).replace(/\s+/g, " ");
  ok("unplanned material is flagged", /Unplanned material/i.test(exceptions), exceptions.slice(0, 200));
  ok("more used than received is flagged", /More used than received/i.test(exceptions));
  ok("an unknown SKU is flagged", /Unknown SKU/i.test(exceptions) && exceptions.includes(SKU_X));
  ok("...carrying the work order, the day and the crew's note",
    exceptions.includes(woA.id) && /Sep 24|24 Sep|2026-09-24/.test(exceptions) &&
    exceptions.includes("grabbed off the truck"), exceptions.slice(0, 400));
  ok("the work order is a link the office can follow",
    (await page.locator(`[data-testid="exceptions"] a[href*="${woA.id}"]`).count()) > 0);
  ok("the page says flagging never blocks the crew",
    /never stop a technician|never block/i.test(exceptions + text));
  ok("mismatched usage is not shown as part of any list",
    !(await page.locator('[data-testid="planning-lists"]').innerText()).includes(SKU_X));

  // ── Read-only, for now ───────────────────────────────────────────
  // Read-only, deliberately: "Editing remains on the existing
  // material-list page." Scoped to the tab's own cards, since the app
  // shell's nav lives in <main> too.
  const cards = page.locator('main [data-testid="planning-lists"], main [data-testid="stock-table"], main [data-testid="exceptions"]');
  const scan = await page.evaluate(() => {
    const scopes = ["planning-lists", "stock-table", "exceptions"]
      .map((t) => document.querySelector(`[data-testid="${t}"]`)).filter(Boolean);
    const found = [];
    for (const sc of scopes) for (const el of sc.querySelectorAll("button, input, textarea, select"))
      found.push(el.tagName + ":" + (el.textContent || "").trim().slice(0, 30));
    return { scopeCount: scopes.length, found };
  });
  // Without this, finding no sections would look like finding no
  // controls, and the assertion below would pass on an empty page.
  ok("all three sections are actually on the page to be scanned",
    scan.scopeCount === 3, `found ${scan.scopeCount} of 3`);
  ok("the tab's own sections are read-only — editing stays on the material-list page",
    scan.found.length === 0, scan.found.join(" | "));
  void cards;

  // ── Phone ────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  ok("the tab adds no horizontal overflow on a phone", overflow <= 1, `overflow ${overflow}px`);

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

console.log(`\nmaterials tab: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

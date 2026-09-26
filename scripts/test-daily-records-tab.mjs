#!/usr/bin/env node
// scripts/test-daily-records-tab.mjs
//
// THE CORRECTION, PERFORMED THE WAY PATRICK WILL PERFORM IT.
//
// #315 protected the record: an office correction keeps the crew's
// original figure, stamps who/when/why, and bills the corrected value.
// Its acceptance was backend tests, and Patrick was right to say so:
//
//   "You cannot perform the proposed acceptance walk yet. There is no
//    screen for entering a clock correction, so asking you to 'correct
//    that day's clock-out' is premature. The backend tests are the
//    acceptance evidence for this PR. The complete user walkthrough
//    belongs after the Daily Records screen exists."
//
// This is that walkthrough, driven through the actual UI — no API call
// and no file editing anywhere in it. It checks the seven things he
// required of the screen:
//
//   1. Show recorded AND effective clock times.
//   2. Clearly label corrected entries.
//   3. Show who corrected them, when and why.
//   4. Display the original labourer count and the corrected count.
//   5. Require a reason before submitting.
//   6. Immediately refresh person-hours after correction.
//   7. Explain why correction is locked when hours were already final.
//
// They are one requirement wearing seven hats: a corrected number must
// never be able to pass for an uncorrected one. #315 made that true in
// the data; if the screen shows only the effective value, the
// protection is real and invisible, which to the person reading it is
// the same as absent.
//
// Run: node scripts/test-daily-records-tab.mjs
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
const PORT = 4843;
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
  await users.create({ email: "desk@local.test", name: "Marguerite Sowande", role: "admin", password: "desk-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "desk@local.test", password: "desk-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("the office can sign in", login.ok && Boolean(rawCookie), String(login.status));
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));
  const proj = await projects.create({ name: "Records — Sharon Heights install", customerName: "Sharon Heights Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });

  // Two days. The first is correctable; the second is signed off, so it
  // must refuse and SAY WHY (requirement 7).
  const woA = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
  const woB = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-23" });
  await projects.attachWorkOrder(proj.id, woA.id);
  await projects.attachWorkOrder(proj.id, woB.id);

  const store = path.join(DATA, "work-orders.json");
  {
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    // 8am–noon Toronto, three on site: the crew's own figures, 12.00.
    const a = all.find((w) => w.id === woA.id);
    a.dailyLog.sessions = [{
      id: "SESS-A", inAt: "2026-09-24T12:00:00.000Z", outAt: "2026-09-24T16:00:00.000Z",
      labourersOnSite: 3, labourerNote: "", startedBy: "Tobias Vantol"
    }];
    a.dailyLog.dailyNotes = "Trenched the front mainline. Rock at the driveway edge.";
    // The signed-off day.
    const b = all.find((w) => w.id === woB.id);
    b.dailyLog.sessions = [{
      id: "SESS-B", inAt: "2026-09-23T12:00:00.000Z", outAt: "2026-09-23T15:00:00.000Z",
      labourersOnSite: 2, labourerNote: "", startedBy: "Tobias Vantol"
    }];
    b.locked = true;
    b.signature = { signed: true, signedAt: "2026-09-23T20:00:00.000Z" };
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
  }

  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const tabUrl = `${BASE}/app/projects/${encodeURIComponent(proj.id)}/records`;
  const open = async () => {
    await page.goto(tabUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Daily records", { timeout: 15000 });
    return (await page.locator("main").innerText()).replace(/\s+/g, " ");
  };

  // ── Before: the crew's figures, as recorded ────────────────────────
  let text = await open();
  ok("the tab lists the logged days", /september 24/i.test(text) && /september 23/i.test(text), text.slice(0, 300));
  ok("...with the crew's 12.00 person-hrs on the correctable day", /12\.00 person-hrs/i.test(text), text.slice(0, 400));
  ok("...and the day's notes", /Rock at the driveway edge/.test(text), text.slice(0, 500));
  // Case-insensitive: the pill renders uppercase, so /Corrected/ would
  // never match and this check would pass no matter what was on screen.
  ok("nothing is marked corrected yet", !/\bcorrected\b/i.test(text), text.slice(0, 300));

  // ── REQUIREMENT 7 · the locked day explains itself ─────────────────
  {
    const lock = await page.locator('[data-testid="lock-reason"]').first().innerText();
    ok("the signed-off day says WHY it cannot be corrected",
      /signed off/i.test(lock) && /final/i.test(lock), lock);
    ok("...and offers no correction button on that day",
      (await page.locator('button:has-text("Correct clock times")').count()) === 1,
      "expected exactly one correctable day");
  }

  // ── REQUIREMENT 5 · a reason is required BEFORE submitting ─────────
  await page.locator('button:has-text("Correct clock times")').first().click();
  await page.waitForSelector('[data-testid="correction-form"]', { timeout: 10000 });
  {
    const saveDisabled = await page.locator('[data-testid="correct-save"]').isDisabled();
    ok("with no reason typed, Save is refused", saveDisabled);
    ok("...and the screen says a reason is needed",
      await page.locator('[data-testid="reason-required"]').isVisible());

    await page.fill('[data-testid="correct-reason"]', "ok");
    ok("a two-character reason is still refused",
      await page.locator('[data-testid="correct-save"]').isDisabled(), "too-short reason accepted");
  }

  // ── The correction itself, typed into the form ─────────────────────
  {
    await page.fill('[data-testid="correct-reason"]', "Crew left at 11, clocked out late");
    // 8:00 → 11:00 Toronto on the same day. Three on site ⇒ 9.00.
    await page.fill('[data-testid="correct-out"]', "2026-09-24T11:00");
    ok("with a real reason, Save is allowed",
      !(await page.locator('[data-testid="correct-save"]').isDisabled()));
    await page.click('[data-testid="correct-save"]');
    await page.waitForSelector('[data-testid="correction-form"]', { state: "detached", timeout: 15000 });
  }

  // ── REQUIREMENT 6 · the hours move straight away, no reload ────────
  {
    await page.waitForFunction(
      () => /9\.00 person-hrs/i.test(document.querySelector("main")?.innerText || ""),
      undefined, { timeout: 15000 }
    ).catch(() => {});
    const live = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    ok("the day's hours refresh to 9.00 WITHOUT a reload", /9\.00 person-hrs/i.test(live), live.slice(0, 400));
    // The JOB total is both days: day A now 9.00 plus day B's untouched
    // 6.00. Asserting 9.00 here was wrong about the number, not about
    // the behaviour — what matters is that it moved from 18.00 to 15.00
    // in the same render as the row.
    ok("...and the job's total refreshes with them", /person-hours 15\.00/i.test(live), live.slice(0, 400));
  }

  // ── REQUIREMENTS 1-3 · both versions, labelled, with who/when/why ──
  text = await open();
  ok("R1 · the effective clock time is shown", /8:00 a\.m\. – 11:00 a\.m\./.test(text) || /8:00 AM – 11:00 AM/.test(text), text.slice(0, 500));
  ok("R1 · the RECORDED clock time is shown beside it", /recorded 8:00 a\.m\. – 12:00 p\.m\./i.test(text) || /recorded 8:00 AM – 12:00 PM/i.test(text), text.slice(0, 600));
  ok("R2 · the entry is labelled Corrected", /\bcorrected\b/i.test(text), text.slice(0, 400));
  ok("R3 · it names WHO corrected it", /Marguerite Sowande/.test(text), text.slice(0, 700));
  ok("R3 · ...and WHY", /Crew left at 11, clocked out late/.test(text), text.slice(0, 700));
  ok("R3 · ...and WHEN", /on Sep \d+/.test(text), text.slice(0, 700));
  ok("the old total is still readable as 'was 12.00'", /was 12\.00/i.test(text), text.slice(0, 500));

  // ── REQUIREMENT 4 · original vs corrected crew count ───────────────
  {
    await page.locator('button:has-text("Correct crew count")').first().click();
    await page.waitForSelector('[data-testid="correction-form"]', { timeout: 10000 });
    const hint = (await page.locator('[data-testid="correction-form"]').innerText()).replace(/\s+/g, " ");
    ok("the crew-count form states what the crew recorded", /recorded 3/i.test(hint), hint.slice(0, 300));
    await page.fill('[data-testid="correct-count"]', "2");
    await page.fill('[data-testid="correct-reason"]', "Third hand left for the Keswick call");
    await page.click('[data-testid="correct-save"]');
    await page.waitForSelector('[data-testid="correction-form"]', { state: "detached", timeout: 15000 });

    text = await open();
    ok("R4 · the corrected count is shown", /2 people on site/i.test(text), text.slice(0, 500));
    ok("R4 · ...with the crew's original 3 beside it", /recorded 3/i.test(text), text.slice(0, 500));
    // 3 hours × 2 = 6.00.
    ok("the hours follow the crew count too", /6\.00 person-hrs/i.test(text), text.slice(0, 500));
    ok("...and both corrections are listed, not just the last",
      /the crew count/.test(text) && /the clock-out/.test(text), text.slice(0, 900));
  }

  // ── The server agrees with the screen ──────────────────────────────
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/metrics`, { headers: { cookie: rawCookie } });
    const j = await r.json();
    const total = j?.metrics?.totalPersonHours ?? j?.totalPersonHours;
    // Day A corrected to 6.00, day B untouched at 3h × 2 = 6.00.
    ok("the project metrics agree with the screen", total === 12, String(total));

    const w = await workOrders.get(woA.id);
    const s = w.dailyLog.sessions[0];
    ok("the crew's ORIGINAL figures are still on the record",
      s.original.labourersOnSite === 3 && s.original.outAt === "2026-09-24T16:00:00.000Z",
      JSON.stringify(s.original));
    ok("...and the day still has exactly one session",
      w.dailyLog.sessions.length === 1, String(w.dailyLog.sessions.length));
  }

  // ── Phone width, where Patrick often reads ─────────────────────────
  {
    await page.setViewportSize({ width: 390, height: 780 });
    await open();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("the tab adds no horizontal overflow on a phone", overflow <= 1, `overflow ${overflow}px`);
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

console.log(`\ndaily records tab: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

// The appointment page, in a real browser, on a phone-sized screen.
//
//   node scripts/test-appointment-page-ui.mjs      (npm run test:appointment-page-ui)
//
// WHY THIS EXISTS. 2026-09-25: two customers phoned Patrick to say the
// "Confirm this appointment" button didn't work. It did — the POST saved
// — but appointment.css gave .ap-btn/.ap-badge an explicit `display`,
// which beats the browser's own `[hidden] { display: none }`. So after
// the tap the button stayed exactly where it was, and the "Confirmed"
// badge appeared at the top of the page, scrolled off-screen. Every
// other customer page carried the `[hidden]` polyfill; this one didn't.
//
// test-appointment-page.mjs proves the SERVER answers correctly. This
// proves the CUSTOMER SEES it: it boots the real server on a sandbox copy,
// seeds assignment bookings, and taps the real buttons at 390x664.
//
// Needs Chromium (PW_CHROMIUM=/path, or `npx playwright install chromium`).
// Kept out of build:check for that reason, like test-pjl-dialog.mjs; the
// static half of the guard (scripts/lint-hidden-polyfill.mjs) is in it.
process.env.TZ = "America/Toronto";

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Sandbox: a copy of the server with its own data dir ---------------

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-appt-ui-"));
for (const entry of ["server", "seasons.json", "pricing.json", "parts.json", "season.config.json", "package.json"]) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(SANDBOX, entry), {
    recursive: true,
    filter: (src) => !src.startsWith(path.join(ROOT, "server", "data") + path.sep)
  });
}
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(SANDBOX, "node_modules"), "dir");
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify([
  { id: "P-1", code: "P-1", customerName: "Kristen Holmes", customerPhone: "+19055550100",
    customerEmail: "k@example.com", address: "90 Oriole Drive, East Gwillimbury, ON", town: "East Gwillimbury" }
], null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const appointment = require(path.join(SANDBOX, "server/lib/appointment-actions.js"));

async function seed(hoursAhead) {
  const when = new Date(Date.now() + hoursAhead * 3600 * 1000);
  const b = await bookings.createDirect({
    propertyId: "P-1",
    customerName: "Kristen Holmes",
    customerPhone: "+19055550100",
    customerEmail: "k@example.com",
    address: "90 Oriole Drive, East Gwillimbury, ON",
    serviceKey: "fall_close_4z",
    serviceLabel: "Fall winterization",
    scheduledFor: when.toISOString(),
    durationMinutes: 30,
    status: "confirmed",
    source: "assignment",
    assignment: { season: "fall", year: when.getFullYear(), batchId: "AS-ui", assignedAt: "x",
      date: when.toISOString().slice(0, 10), bucket: "morning", code: "P-1" }
  });
  return appointment.ensureToken(b.id);
}
const farToken = await seed(10 * 24);      // ten days out — every action open
const nearToken = await seed(12);          // inside the 24-hour cutoff

// ---- Boot the real server ---------------------------------------------

const PORT = 4300 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ["server/server.js"], {
  cwd: SANDBOX,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "development", PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}` },
  stdio: ["ignore", "ignore", "pipe"]
});
let serverErr = "";
server.stderr.on("data", (d) => { serverErr += d; });
const BASE = `http://127.0.0.1:${PORT}`;
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/appointment/${farToken}`); if (r.ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server never came up:\n${serverErr.slice(-2000)}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const inViewport = async (sel) => {
    if (!(await page.locator(sel).count())) return false;
    const box = await page.locator(sel).boundingBox();
    if (!box) return false;
    const vh = page.viewportSize().height;
    return box.y >= 0 && box.y + box.height <= vh;
  };

  // ---- 1. First open: nothing hidden is showing -----------------------
  await page.goto(`${BASE}/a/${farToken}`);
  await page.waitForSelector("#details:not([hidden])");
  ok("the empty status badge does not render on first open",
    !(await page.locator("#badge").isVisible()));
  ok("the Confirm button is showing", await page.locator("#confirmBtn").isVisible());
  ok("the confirmation note starts hidden", !(await page.locator("#doneNote").isVisible()));

  // ---- 2. Tap Confirm: the customer SEES it worked --------------------
  await page.locator("#confirmBtn").scrollIntoViewIfNeeded();
  await page.locator("#confirmBtn").tap();
  await page.waitForTimeout(900);   // the smooth scroll settles
  ok("after Confirm, the Confirm button is gone",
    !(await page.locator("#confirmBtn").isVisible()));
  ok("after Confirm, a 'you're confirmed' note is visible",
    await page.locator("#doneNote").isVisible());
  ok("…and it is on screen, not scrolled away", await inViewport("#doneNote"),
    (await page.locator("#doneNote").count()) ? JSON.stringify(await page.locator("#doneNote").boundingBox()) : "no #doneNote");
  const note = (await page.locator("#doneNote").count()) ? ((await page.locator("#doneNote").textContent()) || "") : "";
  ok("…and it names the day", /confirmed/i.test(note) && /\w+day,/.test(note), note);

  // ---- 3. Reopen the link: still confirmed, no button -----------------
  await page.reload();
  await page.waitForSelector("#details:not([hidden])");
  ok("on reopen, the Confirmed badge shows",
    await page.locator("#badge").isVisible()
      && /confirmed/i.test((await page.locator("#badge").textContent()) || ""));
  ok("on reopen, no Confirm button", !(await page.locator("#confirmBtn").isVisible()));

  // ---- 4. Inside 24 hours: refused actions aren't offered -------------
  await page.goto(`${BASE}/a/${nearToken}`);
  await page.waitForSelector("#details:not([hidden])");
  ok("inside 24h, Confirm is still offered", await page.locator("#confirmBtn").isVisible());
  for (const id of ["cancelBtn", "rescheduleBtn", "windowBtn"]) {
    ok(`inside 24h, #${id} is not shown`, !(await page.locator(`#${id}`).isVisible()));
  }

  ok("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  if (browser) await browser.close();
  server.kill();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n✗ appointment page UI — ${failures.length} failed, ${pass} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ appointment page UI — ${pass} assertions passed`);

#!/usr/bin/env node
// scripts/test-workspace-builder-route.mjs
//
// THE SYSTEM BUILDER, AS A JOB'S OWN FULL-SCREEN ROUTE.
//
// Patrick, deciding the integration: "a full-screen project route with
// return to the same project. The System Design tab should show the saved
// design summary and an Open System Builder action. Hide the workspace
// sidebar while building. Keep a compact project name, truthful save
// status and Back to Project control visible."
//
// Hand-off, not embedding. Which makes the URL the joint, and a joint is
// where things come apart. Four ways this could go quietly wrong:
//
//   1. /app/projects/<id>/design/build falls through to the React shell
//      and renders an empty workspace instead of the builder. The route
//      has to be matched BEFORE the /app catch-all, and nothing about the
//      rendered page tells you which one you got until you look.
//
//   2. The builder doesn't know which job it is in. It used to read
//      ?project=<id>; on this route the job is in the PATH.
//
//   3. The save status lies. It is printed in two places now — the
//      project panel and the workspace bar — and two copies of a status
//      test drift. This is the `activeBookings()` lesson in CLAUDE.md.
//
//   4. An exit loses a design. Back to Project, browser Back, refresh and
//      closing the tab are FOUR ways out and there is no draft kept on
//      the page. Patrick made all four an acceptance requirement.
//
// And the one that closes the loop: returning after a save has to show
// what was saved. A stale summary after a successful save is how "it is
// still saying 13 zones" happens.
//
// Everything here runs against the REAL server, a REAL project created
// through lib/projects.js, and the REAL built bundle in a real browser.
// No mocked API and no hand-rolled copy of the server's own responses.
//
// Run: node scripts/test-workspace-builder-route.mjs
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
const PORT = 4827;
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

/* A real design: three traced areas, no site plan sheet needed. At a
   17.5 GPM ceiling it packs onto FIVE stations; drop the ceiling to 9 and
   it becomes SEVEN. That difference is the test for "the summary refreshes
   after a save" — a number that actually moves, produced by the engine
   rather than asserted into existence. */
const baseDesign = (ceiling) => ({
  version: 9,
  inputs: { availGPM: "18", psi: "60", supply: '1"', ceiling: String(ceiling), spacingFactor: "1" },
  waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
  linkedQuoteId: null, wcRunOverrides: {},
  areas: [
    { aid: "a_front", name: "Front lawn", family: "rotor", rotorNoz: "b40", mode: "rect", L: 60, W: 30, sqft: 1800, avgW: 30 },
    { aid: "a_back", name: "Back lawn", family: "rotor", rotorNoz: "b40", mode: "rect", L: 80, W: 40, sqft: 3200, avgW: 40 },
    { aid: "a_beds", name: "Front beds", family: "drip", mode: "rect", L: 40, W: 4, sqft: 160, avgW: 4 }
  ],
  routing: {}
});

/* Dundalk's shape, on a sheet: one traced Trees area, split into TWO
   physical valves, wired to ONE controller station. The saved-plan readout
   has to say "2 valves, one station" on that line and nowhere else — a
   list that prints "1 valve" on every row teaches you to stop reading it. */
const SPLIT_PAGE = "spp_ws_route";
const treeAt = (x, y) => ({ x, y, type: "ring", dia: 4 });
const splitDesign = () => ({
  version: 9,
  inputs: { availGPM: "18", psi: "60", ceiling: "17.5", spacingFactor: "1" },
  waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
  linkedQuoteId: null, wcRunOverrides: {},
  areas: [
    { aid: "a_lawn", name: "Front lawn", family: "rotor", rotorNoz: "b40", mode: "custom",
      planRef: { pageId: SPLIT_PAGE },
      poly: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 60 }, { x: 20, y: 60 }] },
    { aid: "a_trees", name: "Trees", family: "trees", mode: "custom", planRef: { pageId: SPLIT_PAGE },
      poly: [{ x: 40, y: 100 }, { x: 170, y: 100 }, { x: 170, y: 140 }, { x: 40, y: 140 }],
      trees: [treeAt(50, 120), treeAt(62, 120), treeAt(74, 120), treeAt(86, 120), treeAt(96, 120),
              treeAt(130, 120), treeAt(152, 120)] }
  ],
  routing: { [SPLIT_PAGE]: {
    poc: { x: 100, y: 160 }, main: [],
    manifolds: [{ x: 40, y: 90, id: "m_west" }, { x: 170, y: 90, id: "m_east" }],
    pins: {},
    splits: { "z:a_trees:0": { ax: 100, ay: 60, bx: 100, by: 180, shareStation: true } }
  } }
});

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

// Without a current bundle every React assertion below is vacuous — it
// would be testing a build from before the System Design tab existed.
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

  // ---- 1. the route is gated exactly like the rest of the workspace ----
  {
    const r = await fetch(`${BASE}/app/projects/PROJ-1/design/build`, { redirect: "manual" });
    ok("the builder route requires a login", r.status === 302 || r.status === 303, `status ${r.status}`);
  }

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "ws-route-probe@local.test", name: "WS Route Probe", role: "admin", password: "ws-route-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ws-route-probe@local.test", password: "ws-route-probe-12345" })
  });
  const rawCookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(rawCookie), `${login.status}`);
  const cookieValue = rawCookie.slice("pjl_crm_session=".length);

  // ---- 2. a real project with a real saved design ---------------------
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const job = await projects.create({
    name: "Workspace route — Dunvegan install",
    customerName: "Dunvegan Property Group",
    address: "46 Dunvegan Rd, Toronto, ON",
    status: "planning"
  });
  await projects.update(job.id, { status: "active", systemDesign: baseDesign(17.5) });

  const fresh = await projects.create({ name: "Workspace route — not designed yet", customerName: "Blank Co" });

  const split = await projects.create({ name: "Workspace route — shared split station", customerName: "Dundalk Co" });
  await projects.update(split.id, { systemDesign: splitDesign() });

  // The server's own summary, straight from the API the tab reads. If this
  // is wrong, every number on the screen below is wrong for the same reason.
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(job.id)}`, { headers: { cookie: rawCookie } });
    const j = await r.json();
    const sb = j.siteBuilderSummary || {};
    ok("the API reports the design's real station count", sb.stationCount === 5, JSON.stringify(sb).slice(0, 200));
    ok("...and its valve count", sb.valveCount === 5, JSON.stringify(sb).slice(0, 200));
    ok("...and its area count", sb.areaCount === 3, JSON.stringify(sb).slice(0, 200));
    ok("...and carries the saved plan station by station", Array.isArray(sb.stations) && sb.stations.length === 5,
      JSON.stringify(sb.stations || null).slice(0, 200));
    ok("stations are numbered from 1, the way a controller face is",
      (sb.stations || [])[0]?.station === 1, JSON.stringify((sb.stations || [])[0] || null));

    const rs = await fetch(`${BASE}/api/projects/${encodeURIComponent(split.id)}`, { headers: { cookie: rawCookie } });
    const js = await rs.json();
    const ss = js.siteBuilderSummary || {};
    // Patrick's regression, in his terms: one station, two valves.
    ok("a shared split station counts as ONE station and TWO valves",
      ss.stationCount === 2 && ss.valveCount === 3, JSON.stringify(ss).slice(0, 200));
    const trees = (ss.stations || []).find((s) => s.name === "Trees");
    ok("...and the saved plan puts both valves on that one station's line",
      trees && trees.valves === 2, JSON.stringify(trees || null));
    // The station list has to ADD UP to the valve total, or one of the two
    // numbers on the screen is decoration.
    ok("the station list's valves sum to the valve count",
      (ss.stations || []).reduce((t, s) => t + s.valves, 0) === ss.valveCount,
      JSON.stringify(ss.stations || null).slice(0, 300));
  }

  // ---- 3. the route serves the BUILDER, not the React shell ------------
  {
    const r = await fetch(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design/build`, { headers: { cookie: rawCookie } });
    const body = await r.text();
    ok("the builder route serves the System Builder page", r.ok && body.includes("Sprinkler System Builder"), `status ${r.status}`);
    // The failure this guards against is silent: falling through to the
    // catch-all renders an EMPTY workspace, which looks like a bug in the
    // tab rather than a routing mistake.
    ok("...and not the React app shell", !body.includes('id="root"'));
    ok("the builder route is served the versioned engine",
      /sitebuilder-engine\.js\?v=/.test(body), body.slice(0, 120));

    // The tab's own URL is still the React shell — the builder took one
    // path, not the whole branch.
    const tab = await fetch(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design`, { headers: { cookie: rawCookie } });
    const tabBody = await tab.text();
    ok("the System Design TAB is still the React shell", tab.ok && tabBody.includes('id="root"'));

    // And the classic address still serves the same page, unchanged.
    const classic = await fetch(`${BASE}/admin/sitebuilder?project=${encodeURIComponent(job.id)}`, { headers: { cookie: rawCookie } });
    const classicBody = await classic.text();
    ok("the classic builder address still works", classic.ok && classicBody.includes("Sprinkler System Builder"));
  }

  browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // ---- 4. the System Design tab: the summary and the way in ------------
  {
    await page.goto(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Saved plan", { timeout: 10000 }).catch(() => {});
    const text = await page.locator("main").innerText();

    ok("the tab is no longer a placeholder", !/moves into this workspace next/i.test(text), text.slice(0, 300));
    ok("the tab names the three counts separately",
      /stations/i.test(text) && /valves/i.test(text) && /areas/i.test(text), text.slice(0, 400));
    ok("the tab shows the real saved counts", /\b5\b/.test(text) && /\b3\b/.test(text), text.slice(0, 400));
    ok("the tab offers the builder", /open system builder/i.test(text), text.slice(0, 400));
    ok("the tab lists the saved plan station by station", /ST\s*1/i.test(text) && /ST\s*5/i.test(text), text.slice(0, 600));
    ok("the saved plan names the real areas", /Front lawn/.test(text) && /Front beds/.test(text), text.slice(0, 600));

    const classicHref = await page.locator('a:has-text("classic builder")').first().getAttribute("href");
    ok("the classic builder link is kept, pointed at this job",
      classicHref === `/admin/sitebuilder?project=${encodeURIComponent(job.id)}`, String(classicHref));

    // A job with no design says so, and still offers the way in.
    await page.goto(`${BASE}/app/projects/${encodeURIComponent(fresh.id)}/design`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const blank = await page.locator("main").innerText();
    ok("a job with no design says so rather than printing zeros",
      /no design drawn/i.test(blank), blank.slice(0, 400));
    ok("...and still offers a way to start one", /start the design/i.test(blank), blank.slice(0, 400));

    // The shared split station, rendered by the real bundle.
    await page.goto(`${BASE}/app/projects/${encodeURIComponent(split.id)}/design`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Saved plan", { timeout: 10000 }).catch(() => {});
    const splitText = await page.locator("main").innerText();
    ok("a shared split station reads as two valves on one station",
      /2 valves, one station/i.test(splitText), splitText.slice(0, 600));
    ok("...and it says so on the Trees line only",
      (splitText.match(/valves, one station/gi) || []).length === 1, splitText.slice(0, 600));
  }

  // ---- 5. Open System Builder lands on the full-screen route -----------
  {
    await page.goto(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design`, { waitUntil: "networkidle" });
    await page.waitForSelector('button:has-text("Open System Builder")', { timeout: 10000 });
    await page.click('button:has-text("Open System Builder")');
    await page.waitForSelector("#wsBar", { timeout: 15000 });
    ok("Open System Builder navigates to the job's builder route",
      page.url().endsWith(`/app/projects/${encodeURIComponent(job.id)}/design/build`), page.url());
  }

  // ---- 6. workspace chrome: compact, truthful, and no sidebar ----------
  {
    await page.waitForFunction(() => window.appReady === true || document.getElementById("wsStatus")?.textContent !== "Loading…",
      { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    ok("the page is in workspace mode", await page.evaluate(() => document.body.classList.contains("ws")));

    // The workspace sidebar is the React app's, and the builder is not the
    // React app — so "hidden while building" means it is not there at all.
    // Assert that as the fact it is, not as a CSS rule.
    ok("the workspace sidebar is not on screen while building",
      await page.evaluate(() => !document.querySelector('nav[aria-label="Main"]')));

    // The tall standalone header goes; the compact bar stays put.
    const headerVisible = await page.evaluate(() => {
      const h = document.querySelector("body > header");
      return h ? getComputedStyle(h).display !== "none" : false;
    });
    ok("the standalone page header is gone in workspace mode", headerVisible === false);
    const barBox = await page.locator("#wsBar").boundingBox();
    ok("the workspace bar is visible", Boolean(barBox) && barBox.height > 0, JSON.stringify(barBox));
    ok("...and compact — it is a bar, not a banner", barBox.height <= 96, `height ${barBox?.height}`);
    ok("...and sticky, so the save status survives scrolling",
      await page.evaluate(() => getComputedStyle(document.getElementById("wsBar")).position === "sticky"));

    // The job, read from the PATH — there is no ?project= on this URL.
    ok("the URL carries no ?project= query", !page.url().includes("project="), page.url());
    const name = await page.locator("#wsName").innerText();
    ok("the bar names the job it belongs to", /Dunvegan install/.test(name), name);
    ok("...and its customer", /Dunvegan Property Group/.test(name), name);

    const backText = await page.locator("#wsBackBtn").innerText();
    ok("the bar offers Back to Project", /back to project/i.test(backText), backText);

    // ...and nothing else. The phone note costs vertical drawing surface
    // and has nothing to say to somebody who is already on a desktop.
    ok("the phone notice does not appear on a desktop",
      await page.evaluate(() => getComputedStyle(document.getElementById("wsPhoneNote")).display === "none"));

    // Truthful: nothing has been touched, so it must not say "unsaved".
    const status0 = await page.locator("#wsStatus").innerText();
    ok("a freshly opened design reads as saved, not unsaved", /^Saved /.test(status0), status0);
    ok("...and the project panel agrees, to the letter",
      (await page.locator("#projectBar").innerText()).includes(status0),
      `${status0} vs ${(await page.locator("#projectBar").innerText()).slice(0, 160)}`);

    // The design actually restored — otherwise "saved" above is a statement
    // about an empty canvas.
    const areaCount = await page.evaluate(() => (typeof areas !== "undefined" ? areas.length : -1));
    ok("the job's saved design restored from the path alone", areaCount === 3, `areas ${areaCount}`);
  }

  // ---- 7. the status tells the truth once you change something ---------
  {
    // The panels open collapsed; click the heading, the way a person does.
    await page.click('#ceiling >> xpath=ancestor::div[contains(@class,"panel")]/h2');
    await page.waitForSelector("#ceiling", { state: "visible", timeout: 10000 });
    await page.fill("#ceiling", "9");
    await page.dispatchEvent("#ceiling", "input");
    await page.waitForTimeout(400);
    const status = await page.locator("#wsStatus").innerText();
    ok("editing the design flips the bar to unsaved", /unsaved changes/i.test(status), status);
    ok("...and marks it, so it reads as a warning rather than a note",
      await page.evaluate(() => document.getElementById("wsStatus").classList.contains("unsaved")));
    ok("...and the project panel says the same thing",
      /unsaved changes/i.test(await page.locator("#projectBar").innerText()));
  }

  // ---- 8. every exit is guarded -----------------------------------------
  {
    // (a) refresh / browser Back / closing the tab all leave through
    //     beforeunload. Execute the real handler rather than reading the
    //     source: dispatch a cancelable beforeunload and see whether the
    //     page objects.
    const guarded = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    ok("refresh, browser Back and closing the tab are guarded while dirty", guarded === true);

    // (b) Back to Project asks first, and staying means staying.
    await page.click("#wsBackBtn");
    await page.waitForSelector(".pjl-dialog-backdrop", { timeout: 5000 });
    const dlg = await page.locator(".pjl-dialog-backdrop").innerText();
    ok("Back to Project warns about unsaved work", /leave without saving/i.test(dlg), dlg.slice(0, 300));
    ok("...and says what is lost", /not saved to the project/i.test(dlg), dlg.slice(0, 300));

    await page.click('.pjl-dialog-backdrop button:has-text("Stay here")');
    await page.waitForTimeout(400);
    ok("choosing to stay does not navigate", page.url().endsWith("/design/build"), page.url());
    ok("...and the unsaved work is still here",
      await page.evaluate(() => document.getElementById("ceiling").value === "9"));

    // (c) A confirmed departure must not then be asked about AGAIN by the
    //     browser — being asked twice for one exit reads like the first
    //     answer didn't take.
    const asksTwice = await page.evaluate(() => {
      leavingDeliberately = true;
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      const answer = e.defaultPrevented;
      leavingDeliberately = false;
      return answer;
    });
    ok("a departure already confirmed is not queried a second time", asksTwice === false);
  }

  // ---- 9. save, return, and the summary tells the new truth -------------
  {
    await page.click("#saveBtn");
    await page.waitForFunction(() => /^Saved /.test(document.getElementById("wsStatus")?.textContent || ""), { timeout: 15000 });
    const status = await page.locator("#wsStatus").innerText();
    ok("saving flips the bar back to saved", /^Saved /.test(status), status);

    // Nothing to warn about now, so Back to Project goes straight through.
    const clean = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    ok("a saved design does not warn on the way out", clean === false);

    await page.click("#wsBackBtn");
    await page.waitForURL(`**/app/projects/${encodeURIComponent(job.id)}/design`, { timeout: 15000 });
    ok("Back to Project returns to the SAME job's System Design tab",
      page.url().endsWith(`/app/projects/${encodeURIComponent(job.id)}/design`), page.url());

    await page.waitForSelector("text=Saved plan", { timeout: 10000 });
    await page.waitForTimeout(400);
    const text = await page.locator("main").innerText();
    // The ceiling went from 17.5 to 9, so the engine packs the same three
    // areas onto SEVEN stations instead of five. That is the number that
    // has to have moved — a summary that still says five is the "it is
    // still saying 13 zones" bug wearing a new hat.
    ok("returning after a save shows the NEW station count", /\b7\b/.test(text), text.slice(0, 500));
    ok("...and the new valve count", /\b7\b/.test(text), text.slice(0, 500));
    ok("...with the area count unchanged, because the areas did not change",
      /\b3\b/.test(text), text.slice(0, 500));
    ok("...and the saved plan grew to match", /ST\s*7/i.test(text), text.slice(0, 700));
    ok("...and it is recorded as saved just now", /last saved today/i.test(text), text.slice(0, 300));

    // The server agrees — the screen is not showing a number it invented.
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(job.id)}`, { headers: { cookie: rawCookie } });
    const sb = (await r.json()).siteBuilderSummary || {};
    ok("the server's own summary reports the same new counts",
      sb.stationCount === 7 && sb.valveCount === 7 && sb.areaCount === 3, JSON.stringify(sb).slice(0, 200));
  }

  // ---- 10. reading the plan works at phone width ------------------------
  {
    const phone = await ctx.newPage();
    const phoneErrors = [];
    phone.on("pageerror", (e) => phoneErrors.push(String(e)));
    await phone.setViewportSize({ width: 390, height: 780 });

    await phone.goto(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design`, { waitUntil: "networkidle" });
    await phone.waitForSelector("text=Saved plan", { timeout: 10000 });
    const text = await phone.locator("main").innerText();
    ok("the summary reads on a phone", /stations/i.test(text) && /\b7\b/.test(text), text.slice(0, 400));
    ok("the saved plan reads on a phone", /ST\s*1/i.test(text) && /Front lawn/.test(text), text.slice(0, 500));

    // Nothing may run off the side of a phone — a plan you have to scroll
    // sideways to read is a plan you don't read.
    const overflow = await phone.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("nothing overflows the phone's width", overflow <= 1, `overflow ${overflow}px`);

    // Drawing stays a desktop job THIS PHASE, and the builder says so
    // rather than handing someone a 390px canvas.
    await phone.goto(`${BASE}/app/projects/${encodeURIComponent(job.id)}/design/build`, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("#wsPhoneNote", { timeout: 10000 });
    const noteShown = await phone.evaluate(() =>
      getComputedStyle(document.getElementById("wsPhoneNote")).display !== "none");
    ok("the builder tells a phone that drawing is a desktop job", noteShown === true);
    const noteText = await phone.locator("#wsPhoneNote").innerText();
    ok("...and points back at what DOES read on a phone", /system design tab/i.test(noteText), noteText.slice(0, 200));
    const noteHref = await phone.locator("#wsPhoneNoteLink").getAttribute("href");
    ok("...on this job, not in general",
      noteHref === `/app/projects/${encodeURIComponent(job.id)}/design`, String(noteHref));

    // And the way out is still reachable at that width — a Back control
    // pushed off screen is the bug Patrick called out on the Help Centre.
    const backBox = await phone.locator("#wsBackBtn").boundingBox();
    ok("Back to Project is reachable at phone width",
      Boolean(backBox) && backBox.x >= 0 && backBox.x + backBox.width <= 390, JSON.stringify(backBox));

    ok("no page errors at phone width", phoneErrors.length === 0, phoneErrors.join(" | "));
    await phone.close();
  }

  // ---- 11. the classic route still behaves as it always did -------------
  {
    await page.goto(`${BASE}/admin/sitebuilder?project=${encodeURIComponent(job.id)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    ok("the classic route is NOT in workspace mode",
      await page.evaluate(() => !document.body.classList.contains("ws")));
    const backHref = await page.locator("#sbBackLink").getAttribute("href");
    ok("...and still sends you back to the classic project page",
      backHref === `/admin/project/${encodeURIComponent(job.id)}`, String(backHref));
    ok("...and still loads the same job's design",
      await page.evaluate(() => typeof areas !== "undefined" && areas.length === 3));
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

console.log(`\nworkspace builder route: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

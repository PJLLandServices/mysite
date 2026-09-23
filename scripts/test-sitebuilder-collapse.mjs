#!/usr/bin/env node
// scripts/test-sitebuilder-collapse.mjs
//
// THE BUILDER OPENS CLOSED.
//
// A real job is twenty areas long. Opened out, the page was several screens
// of form fields to scroll past to reach the one you came for — and on a
// phone, in a driveway, that is the whole screen. So every major section
// and every area card now loads closed.
//
// The one exception is the Project panel, and it is not collapsible at all:
// it holds the project name, the saved-state line, the SAVE TO PROJECT
// button, and the warning shown when a design could not be read. Hiding it
// hides the thing you act with and the thing that tells you not to. That is
// asserted here, on both viewports, because it is the part of this change
// that could quietly do harm.
//
//   npm run test:sitebuilder-collapse

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { v8WithSplits } from "./fixtures/v8-split-designs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

const page_html = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"));
const engine = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js"));
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page_html); }
  if (p === "/admin/sitebuilder-engine.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(engine); }
  if (p === "/api/projects/PROJ-TEST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, project: {
      id: "PROJ-TEST", name: "Collapse test", customerName: "", customerEmail: "", propertyId: null,
      systemDesign: v8WithSplits } }));
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/?project=PROJ-TEST`;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { executablePath: "/opt/pw-browsers/chromium" });

async function look(viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForFunction("appReady === true", null, { timeout: 30000 });
  const seen = await pg.evaluate(() => {
    const panels = [...document.querySelectorAll('.wrap > .panel')].map((p) => ({
      title: (p.querySelector(':scope > h2') || {}).textContent || "(none)",
      id: p.id || "",
      collapsed: p.classList.contains('collapsed'),
      collapsible: p.classList.contains('collapsible')
    }));
    const cards = [...document.querySelectorAll('#areas > .areacard')];
    return {
      panels,
      areaCount: cards.length,
      openAreas: cards.filter((c) => !c.classList.contains('collapsed')).length,
      saveVisible: !!(document.getElementById('saveBtn') && document.getElementById('saveBtn').offsetParent !== null),
      // How tall the page is, which is the whole point of the change.
      docHeight: document.documentElement.scrollHeight
    };
  });
  await ctx.close();
  console.log(`\n  ${label} — ${seen.areaCount} areas, page ${seen.docHeight}px tall`);
  return seen;
}

const desktop = await look({ width: 1280, height: 900 }, "desktop 1280x900");
check("every area card starts closed", desktop.openAreas === 0, `${desktop.openAreas} open of ${desktop.areaCount}`);
check("the design still loaded (this is not an empty page)", desktop.areaCount > 0, `${desktop.areaCount} areas`);
for (const p of desktop.panels) {
  if (p.id === "projectPanel") {
    check("the Project panel is NOT collapsible", !p.collapsible);
    check("...and is not collapsed", !p.collapsed);
  } else {
    check(`"${p.title.trim()}" starts closed`, p.collapsed);
  }
}
check("Save to project is visible", desktop.saveVisible);

const mobile = await look({ width: 390, height: 844 }, "mobile 390x844 (iPhone-ish)");
check("[mobile] every area card starts closed", mobile.openAreas === 0, `${mobile.openAreas} open of ${mobile.areaCount}`);
check("[mobile] every section but Project starts closed",
      mobile.panels.every((p) => p.id === "projectPanel" ? !p.collapsed : p.collapsed),
      JSON.stringify(mobile.panels.filter((p) => p.id !== "projectPanel" && !p.collapsed).map((p) => p.title)));
check("[mobile] Save to project is visible", mobile.saveVisible);
check("[mobile] the page is short enough to take in at once",
      mobile.docHeight < 2600, `${mobile.docHeight}px`);

// Open all / Close all, and that opening is still possible at all.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForFunction("appReady === true", null, { timeout: 30000 });
  const r = await pg.evaluate(() => {
    const open = () => [...document.querySelectorAll('#areas > .areacard')].filter((c) => !c.classList.contains('collapsed')).length;
    const start = open();
    expandAllAreas(true); const all = open();
    expandAllAreas(false); const none = open();
    toggleAreaCollapse(0); const one = open();
    return { start, all, none, one, total: areas.length };
  });
  await ctx.close();
  check("[mobile] Open all opens every area", r.all === r.total, `${r.all} of ${r.total}`);
  check("[mobile] Close all closes them again", r.none === 0, String(r.none));
  check("[mobile] tapping one area's header opens just that one", r.one === 1, String(r.one));
}

await browser.close(); srv.close();
console.log(`\nsitebuilder collapse: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

#!/usr/bin/env node
// scripts/test-dialog-above-overlays.mjs
//
// A MODAL MUST BE REACHABLE FROM WHEREVER IT WAS OPENED.
//
// pjlDialog sat at z-index 720. The System Builder's master plan is a
// full-screen overlay at 9999, so every dialog opened from inside it —
// remove split, one valve per box, a failed save, the material-list
// confirm — rendered UNDERNEATH the plan. The page then blocked waiting
// on an answer to a question that could not be seen or clicked.
//
// From the outside that is indistinguishable from the editor freezing,
// which is how it was reported: "i cannot do anything to any of these
// zones." Nothing threw, nothing logged, every test passed.
//
// So this asserts REACHABILITY, not a number: with the master plan open,
// the pixel at the centre of the confirm button must belong to that
// button. A z-index assertion alone would pass against a dialog sitting
// behind an opaque overlay.
//
//   npm run test:dialog-above-overlays

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

const file = (p, t) => ({ body: fs.readFileSync(path.join(ROOT, "server", p)), type: t });
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const send = (f) => { res.writeHead(200, { "Content-Type": f.type + "; charset=utf-8" }); res.end(f.body); };
  if (p === "/") return send(file("sitebuilder.html", "text/html"));
  if (p === "/admin/sitebuilder-engine.js") return send(file("sitebuilder-engine.js", "text/javascript"));
  if (p === "/admin/sitebuilder-help.js") return send(file("sitebuilder-help.js", "text/javascript"));
  if (p === "/crm/pjl-dialog.js") return send(file("pjl-dialog.js", "text/javascript"));
  if (p === "/crm/pjl-dialog.css") return send(file("pjl-dialog.css", "text/css"));
  if (p === "/api/projects/PROJ-TEST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, project: {
      id: "PROJ-TEST", name: "Dialog stacking", customerName: "", customerEmail: "", propertyId: null,
      sitePlan: { pages: [{ id: "pg1", label: "Sheet 1", rasterWidthPx: 3000, rasterHeightPx: 2000,
        calibration: { state: "calibrated", ftPerPx: 0.1, verify: { state: "passed", residualPct: 0.1 } } }] },
      systemDesign: v8WithSplits } }));
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/?project=PROJ-TEST`;
const browser = await chromium.launch(process.env.PW_CHROMIUM
  ? { executablePath: process.env.PW_CHROMIUM } : { executablePath: "/opt/pw-browsers/chromium" });

// ── A. The ceiling ───────────────────────────────────────────────────
console.log("\nA. Nothing in the app may out-stack a modal");
{
  const css = fs.readFileSync(path.join(ROOT, "server", "pjl-dialog.css"), "utf8");
  const dlg = Number((css.match(/\.pjl-dialog-backdrop\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
  check("the dialog backdrop declares a z-index", Number.isFinite(dlg), String(dlg));

  // Every z-index the builder and its stylesheets claim.
  const others = [];
  for (const f of ["sitebuilder.html", "pjl-dialog.css"]) {
    const src = fs.readFileSync(path.join(ROOT, "server", f), "utf8");
    for (const m of src.matchAll(/z-index:\s*(\d+)/g)) {
      const n = Number(m[1]);
      if (f === "pjl-dialog.css" && n === dlg) continue;   // the dialog's own layers
      others.push(n);
    }
  }
  const tallest = Math.max(...others);
  check("a modal out-stacks everything else in the builder", dlg > tallest, `dialog ${dlg} vs tallest other ${tallest}`);
  // 9999 is the master plan. Naming it keeps the reason legible if the
  // numbers ever move.
  check("...including the master plan overlay at 9999", dlg > 9999, String(dlg));
}

// ── B. Reachable with the master plan open ───────────────────────────
console.log("\nB. A dialog opened from inside the master plan can be answered");
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const pg = await ctx.newPage();
  const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForFunction("appReady === true", null, { timeout: 30000 });
  await pg.evaluate(() => openMasterPlan("pg1"));
  await pg.waitForTimeout(500);
  check("the master plan is open and covering the page",
        await pg.evaluate(() => { const o = document.getElementById("mpOverlay");
          return !!o && getComputedStyle(o).display !== "none"; }));

  // Ask a real question, the way Remove split does, and leave it open.
  await pg.evaluate(() => { window.__answer = pjlDialog.confirm(
    "Put Trees back on one valve? Its B half loses its box assignment.",
    { title: "Remove split", icon: "warning", confirmLabel: "Remove split" }); });
  await pg.waitForTimeout(350);

  const seen = await pg.evaluate(() => {
    const back = document.querySelector(".pjl-dialog-backdrop");
    if (!back) return { there: false };
    const btns = [...back.querySelectorAll("button")];
    const confirm = btns[btns.length - 1];
    const r = confirm.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const mpZ = Number(getComputedStyle(document.getElementById("mpOverlay")).zIndex) || 0;
    return { there: true, label: (confirm.textContent || "").trim(),
             onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
             hit: top === confirm || confirm.contains(top),
             actually: top ? top.tagName + "." + (top.className || "") : "nothing",
             dlgZ: Number(getComputedStyle(back).zIndex) || 0, mpZ };
  });
  check("the dialog is in the DOM", seen.there);
  check("its confirm button is on screen", seen.onScreen, JSON.stringify(seen));
  // THE ONE THAT MATTERS. At 720 this was the master plan, not the button.
  check("...and the pixel at its centre belongs to the BUTTON, not the plan",
        seen.hit, seen.actually);
  check("...because the dialog out-stacks the master plan",
        seen.dlgZ > seen.mpZ, `${seen.dlgZ} vs ${seen.mpZ}`);

  // And it really answers — a click gets through, not just a hit test.
  const btns = await pg.$$(".pjl-dialog-backdrop button");
  await btns[btns.length - 1].click({ timeout: 5000 });
  check("clicking it resolves the question", (await pg.evaluate(() => window.__answer)) === true);
  check("...and the dialog closes", !(await pg.evaluate(() => !!document.querySelector(".pjl-dialog-backdrop"))));
  check("the master plan is still open underneath",
        await pg.evaluate(() => { const o = document.getElementById("mpOverlay");
          return !!o && getComputedStyle(o).display !== "none"; }));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── C. Above the help centre too ─────────────────────────────────────
console.log("\nC. And above the help centre, which is itself above the plan");
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const pg = await ctx.newPage();
  const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForFunction("appReady === true", null, { timeout: 30000 });
  await pg.evaluate(() => openMasterPlan("pg1"));
  await pg.waitForTimeout(400);
  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(300);
  await pg.evaluate(() => { window.__a2 = pjlDialog.alert("Something to say.", { title: "Heads up" }); });
  await pg.waitForTimeout(300);
  const over = await pg.evaluate(() => {
    const back = document.querySelector(".pjl-dialog-backdrop");
    const b = back && back.querySelector("button");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: top === b || b.contains(top),
             actually: top ? top.tagName + "." + (top.className || "") : "nothing",
             dlgZ: Number(getComputedStyle(back).zIndex) || 0,
             helpZ: Number(getComputedStyle(document.getElementById("hcOverlay")).zIndex) || 0 };
  });
  check("a dialog raised over the open help centre is clickable", over && over.hit, over && over.actually);
  check("...because it out-stacks it as well", over && over.dlgZ > over.helpZ,
        over && `${over.dlgZ} vs ${over.helpZ}`);
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

await browser.close(); srv.close();
console.log(`\ndialog stacking: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

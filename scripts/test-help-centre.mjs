#!/usr/bin/env node
// scripts/test-help-centre.mjs
//
// The help centre IN A BROWSER. test-help-coverage.mjs proves the registry
// is complete and consistent; this proves the thing Patrick actually uses
// works — the tooltips get stamped onto real buttons, the panel opens over
// a live design without disturbing it, and typing his own words finds the
// entry he needs.
//
// The acceptance test written into the PRD before any of this was built:
//
//   "Could Patrick have answered the 13-stations question himself, in
//    under a minute, without asking anyone?"
//
// Section D is that question, asked of the running page.
//
//   npm run test:help-centre

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

const pageHtml = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"));
const engine = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js"));
const helpJs = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-help.js"));
let serveHelp = true;                       // section F turns this off

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const send = (b, t) => { res.writeHead(200, { "Content-Type": t + "; charset=utf-8" }); res.end(b); };
  if (p === "/") return send(pageHtml, "text/html");
  if (p === "/admin/sitebuilder-engine.js") return send(engine, "text/javascript");
  if (p === "/admin/sitebuilder-help.js") {
    if (!serveHelp) { res.writeHead(404); return res.end(""); }
    return send(helpJs, "text/javascript");
  }
  if (p === "/api/projects/PROJ-TEST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, project: {
      id: "PROJ-TEST", name: "Help centre test", customerName: "", customerEmail: "",
      propertyId: null, systemDesign: v8WithSplits } }));
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/?project=PROJ-TEST`;
const browser = await chromium.launch(process.env.PW_CHROMIUM
  ? { executablePath: process.env.PW_CHROMIUM } : { executablePath: "/opt/pw-browsers/chromium" });

async function open_(viewport) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage();
  const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForTimeout(500);
  return { ctx, pg, errs };
}

// ── A. Tooltips are stamped onto the real buttons ────────────────────
console.log("\nA. The toolbar gets its labels from the registry");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  const rail = await pg.evaluate(() => [...document.querySelectorAll('#mpTools [data-help]')]
    .map((b) => ({ id: b.getAttribute("data-help"), tip: b.getAttribute("data-tip") || "", aria: b.getAttribute("aria-label") || "" })));
  check("every toolbar button carries a data-help id", rail.length >= 13, String(rail.length));
  const blank = rail.filter((b) => !b.tip || !b.aria);
  check("every one of them got a tooltip AND a label", !blank.length, blank.map((b) => b.id).join(", "));

  const split = rail.find((b) => b.id === "split");
  check("the Split tool's tooltip is the corrected one", split && /their own controller station/.test(split.tip), split && split.tip.slice(0, 60));
  check("...and no longer claims they are wired as one station",
        split && !/wired as one station/i.test(split.tip));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── B. The panel opens over a live design ────────────────────────────
console.log("\nB. Opening help does not disturb the builder");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  const probe = () => ({ zones: (typeof LAST_ZONES === "undefined" ? -1 : LAST_ZONES.length),
                         areas: (typeof areas === "undefined" ? -1 : areas.length) });
  const before = await pg.evaluate(probe);
  check("the fixture really did load a design to disturb", before.areas > 0 && before.zones > 0, JSON.stringify(before));
  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(250);
  const open = await pg.evaluate(() => ({
    on: !!document.querySelector("#hcOverlay.on"),
    cards: document.querySelectorAll(".hc-card").length,
    focused: document.activeElement && document.activeElement.id
  }));
  check("the overlay opens", open.on);
  check("it lists every entry to begin with", open.cards >= 30, String(open.cards));
  check("the search box takes focus", open.focused === "hcQ", String(open.focused));

  const after = await pg.evaluate(probe);
  check("the design underneath is untouched",
        after.zones === before.zones && after.areas === before.areas,
        JSON.stringify([before, after]));
  check("the builder is still in the DOM behind it", await pg.evaluate(() => !!document.getElementById("mpTools")));

  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(150);
  check("Escape closes it", !(await pg.evaluate(() => !!document.querySelector("#hcOverlay.on"))));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── C. Search works on the page, in his words ────────────────────────
console.log("\nC. Searching in Patrick's own words");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  await pg.evaluate(() => mpHelpOpen());
  const top = async (q) => {
    await pg.fill("#hcQ", q);
    await pg.waitForTimeout(120);
    return pg.evaluate(() => {
      const c = document.querySelector(".hc-card");
      return c ? { id: c.id.replace(/^hc-/, ""), heading: c.querySelector("h3").textContent } : null;
    });
  };
  for (const [q, want] of [
    ["consecutively", "shared-station"],
    ["zine", "station-vs-valve-vs-area"],
    ["vowels", "valve-concept"],
    ["two valves one station", "shared-station"],
    ["across the driveway", "split"]
  ]) {
    const r = await top(q);
    check(`typing "${q}" puts ${want} first`, r && r.id === want, r ? r.id : "(nothing)");
  }
  const none = await top("qqzzxx");
  check("a query that matches nothing says so rather than showing everything",
        !none && await pg.evaluate(() => /Nothing matched/.test(document.getElementById("hcResults").textContent)));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── D. The PRD's acceptance test, on the running page ────────────────
console.log("\nD. The 13-stations question, answered without asking anyone");
{
  const { ctx, pg, errs } = await open_({ width: 390, height: 844 });   // a phone
  await pg.evaluate(() => mpHelpOpen());
  await pg.fill("#hcQ", "why did my station count go up");
  await pg.waitForTimeout(150);
  const answer = await pg.evaluate(() => {
    const c = document.querySelector(".hc-card");
    return c ? { id: c.id.replace(/^hc-/, ""), text: c.textContent } : null;
  });
  check("the first result is the entry about splitting", answer && answer.id === "what-splitting-does", answer && answer.id);
  check("it says plainly that a new split gives TWO stations",
        answer && /two separate controller stations/i.test(answer.text));
  check("it says how to get back to one", answer && /wire both valves back to one station/i.test(answer.text));
  check("it warns that older designs behave the opposite way", answer && /older designs/i.test(answer.text));

  // On a phone, one-handed (PRD R5).
  const fits = await pg.evaluate(() => {
    const p = document.querySelector(".hc-panel"), r = p.getBoundingClientRect();
    return { w: Math.round(r.width), vw: window.innerWidth,
             overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  check("the panel fills a phone screen without sideways scrolling",
        fits.w <= fits.vw + 1 && !fits.overflow, JSON.stringify(fits));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── E. The wrong sentence is gone from the running page ──────────────
console.log("\nE. The sentence that caused this is nowhere on screen");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  const body = await pg.evaluate(() => document.body.innerHTML);
  check("no live copy says a split is wired as one station",
        !/heads on each side get their own valve[^<]*wired together as one station/i.test(body));
  check("the old Help paragraph is gone", !(await pg.evaluate(() => !!document.getElementById("mpHint"))));
  check("the Help sidebar now offers the centre instead",
        await pg.evaluate(() => /Open the help centre/.test(document.body.textContent)));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── F. A missing registry degrades, it does not break ────────────────
console.log("\nF. Without the registry the builder still runs");
{
  serveHelp = false;
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  check("the builder still starts", await pg.evaluate(() => !!document.getElementById("mpTools")));
  check("the design still loaded", await pg.evaluate(() => typeof areas !== "undefined" && areas.length > 0));
  // The fatal one is the ENGINE. A missing sentence must never take the
  // page down — it cannot put a wrong number in a bid.
  const fatal = errs.filter((e) => /SystemBuilderHelp|HELP|Cannot read/.test(e));
  check("nothing throws over the missing help", !fatal.length, fatal[0]);
  serveHelp = true;
  await ctx.close();
}

await browser.close(); srv.close();
console.log(`\nhelp centre: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

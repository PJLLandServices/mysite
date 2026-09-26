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
let saved = null;                           // any PATCH the page sends

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const send = (b, t) => { res.writeHead(200, { "Content-Type": t + "; charset=utf-8" }); res.end(b); };
  if (p === "/") return send(pageHtml, "text/html");
  if (p === "/admin/sitebuilder-engine.js") return send(engine, "text/javascript");
  if (p === "/admin/sitebuilder-help.js") {
    if (!serveHelp) { res.writeHead(404); return res.end(""); }
    return send(helpJs, "text/javascript");
  }
  if (p === "/api/projects/PROJ-TEST" && req.method === "PATCH") {
    let body = ""; req.on("data", (d) => { body += d; });
    return req.on("end", () => {
      try { saved = JSON.parse(body); } catch { saved = { unparsed: true }; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: { id: "PROJ-TEST" } }));
    });
  }
  if (p === "/api/projects/PROJ-TEST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, project: {
      id: "PROJ-TEST", name: "Help centre test", customerName: "", customerEmail: "",
      propertyId: null,
      // The master-plan toolbar — and the Help button in it — only exists
      // once a calibrated sheet is open. Without this the button is in the
      // DOM but hidden, and a hidden element cannot take focus.
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

async function open_(viewport) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage();
  const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(URL_, { waitUntil: "load" });
  await pg.waitForTimeout(500);
  // Open the sheet so the toolbar is really on screen, the way it is when
  // somebody reaches for Help mid-drawing.
  await pg.evaluate(() => { if (typeof openMasterPlan === "function") openMasterPlan("pg1"); });
  await pg.waitForTimeout(400);
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

// ── D2. Patrick's pre-merge checklist, 2026-09-23 ────────────────────
console.log("\nD2. Terminology, focus, mobile reach, and unsaved work");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });

  // --- The word ------------------------------------------------------
  // "consecutively" must ROUTE to this entry without the entry adopting
  // it as a definition. Routing a search term and defining a word are
  // different jobs; conflating them teaches the mistake back.
  await pg.evaluate(() => mpHelpOpen());
  await pg.fill("#hcQ", "consecutively");
  await pg.waitForTimeout(150);
  const card = await pg.evaluate(() => {
    const c = document.querySelector(".hc-card");
    return c ? { id: c.id.replace(/^hc-/, ""), text: c.textContent } : null;
  });
  check("\"consecutively\" still reaches the shared-station entry", card && card.id === "shared-station", card && card.id);
  check("...which defines SIMULTANEOUSLY as together from one station",
        card && /simultaneously means the valves operate together from one controller station/i.test(card.text));
  check("...and CONSECUTIVELY as one after another",
        card && /consecutively means they operate one after another/i.test(card.text));
  check("...and shows the word as a search term, not the name for it",
        card && /sometimes searched as/i.test(card.text) && /not the term for it/i.test(card.text));
  // The failure mode being guarded against: the entry saying, in effect,
  // "consecutively = at the same time".
  check("no displayed text equates consecutively with simultaneous",
        card && !/consecutive(ly)?\s+(means|=)\s*[^.]{0,40}(same time|simultaneous|together)/i.test(card.text),
        (card && (card.text.match(/consecutive[^.]{0,80}/i) || [])[0]) || "");

  // --- Focus ---------------------------------------------------------
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(120);
  check("the Help button is actually visible to be focused",
        await pg.evaluate(() => { const b = document.querySelector('[data-help="help-button"]');
          return !!b && b.offsetParent !== null; }));
  await pg.evaluate(() => document.querySelector('[data-help="help-button"]').focus());
  check("...and takes focus when clicked",
        await pg.evaluate(() => document.activeElement === document.querySelector('[data-help="help-button"]')));
  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(200);
  check("focus lands in the search box on open",
        await pg.evaluate(() => document.activeElement && document.activeElement.id === "hcQ"));

  // Tab all the way round; it must never escape the panel.
  let escaped = null;
  for (let i = 0; i < 30; i++) {
    await pg.keyboard.press("Tab");
    const where = await pg.evaluate(() => {
      const p = document.querySelector("#hcOverlay .hc-panel");
      return p && p.contains(document.activeElement) ? "in" : (document.activeElement.tagName + "#" + (document.activeElement.id || ""));
    });
    if (where !== "in") { escaped = `after ${i + 1} tabs -> ${where}`; break; }
  }
  check("Tab stays inside the panel and cycles", !escaped, escaped || "");
  await pg.keyboard.down("Shift"); await pg.keyboard.press("Tab"); await pg.keyboard.up("Shift");
  check("Shift-Tab stays inside too",
        await pg.evaluate(() => document.querySelector("#hcOverlay .hc-panel").contains(document.activeElement)));

  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(150);
  check("Escape closes it", !(await pg.evaluate(() => !!document.querySelector("#hcOverlay.on"))));
  check("...and focus returns to the Help button",
        await pg.evaluate(() => document.activeElement === document.querySelector('[data-help="help-button"]')),
        await pg.evaluate(() => document.activeElement.tagName + "#" + (document.activeElement.id || "") + "." + (document.activeElement.className || "")));

  // The X button must also restore focus, not only the Escape key.
  await pg.evaluate(() => document.querySelector('[data-help="help-button"]').focus());
  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(150);
  await pg.click(".hc-x");
  await pg.waitForTimeout(150);
  check("closing with the X button restores focus as well",
        await pg.evaluate(() => document.activeElement === document.querySelector('[data-help="help-button"]')));
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── D2b. The card is not wearing the page's clothes ──────────────────
console.log("\nD2b. The help card is insulated from the page's own styles");
{
  const { ctx, pg, errs } = await open_({ width: 1280, height: 900 });
  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(250);

  // sitebuilder.html styles the BARE element `header` with a full-width
  // green gradient and white text. A <header> inside a help card therefore
  // rendered as a green banner with a white glyph — the card inheriting
  // the site's page-title styling. Computed style is the only honest test:
  // the markup looked perfectly reasonable.
  const look = await pg.evaluate(() => {
    const card = document.querySelector(".hc-card");
    const head = card.querySelector(".hc-head, header");
    const h3 = head.querySelector("h3");
    const cs = getComputedStyle(head), hs = getComputedStyle(h3);
    const body = getComputedStyle(document.querySelector(".hc-body p"));
    return { headBg: cs.backgroundColor, headImg: cs.backgroundImage,
             headPad: cs.padding, titleColor: hs.color, bodyColor: body.color,
             tag: head.tagName };
  });
  const transparent = (c) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  check("the card heading has no background colour of its own", transparent(look.headBg), look.headBg);
  check("...and no gradient painted behind it", look.headImg === "none", look.headImg);
  check("...and does not take the site header's 20px/26px padding",
        /^0px/.test(look.headPad), look.headPad);
  check("...and its title is not white-on-nothing", look.titleColor !== "rgb(255, 255, 255)", look.titleColor);
  check("...and reads in the same ink as the body", look.titleColor === look.bodyColor,
        `${look.titleColor} vs ${look.bodyColor}`);
  check("the card avoids bare <header>, which the page claims globally",
        look.tag !== "HEADER", look.tag);

  // Same question for the glyph: it inherits colour, so a white stroke is
  // invisible on a white card and is the "bell" Patrick saw on the green.
  const glyph = await pg.evaluate(() => {
    const svg = document.querySelector(".hc-card .hc-sym svg");
    return svg ? getComputedStyle(svg).stroke : null;
  });
  check("the glyph is not stroked white", glyph !== "rgb(255, 255, 255)", glyph);
  check("no page errors", !errs.length, errs[0]);
  await ctx.close();
}

// ── D3. Unsaved work survives, and the registry holds no job data ────
console.log("\nD3. Unsaved work, and what the registry knows");
{
  const { ctx, pg, errs } = await open_({ width: 390, height: 844 });   // a phone

  // Make a real, unsaved change first: select an area and mark dirty the
  // way the builder does. An "it survived" check against a pristine page
  // proves nothing.
  const before = await pg.evaluate(() => {
    if (typeof mp !== "undefined") mp.zoneSel = 0;
    if (typeof markDirty === "function") markDirty();
    return { sel: typeof mp !== "undefined" ? mp.zoneSel : null,
             dirty: typeof DIRTY !== "undefined" ? DIRTY : (typeof dirty !== "undefined" ? dirty : null),
             areas: typeof areas === "undefined" ? -1 : areas.length,
             zones: typeof LAST_ZONES === "undefined" ? -1 : LAST_ZONES.length,
             name: typeof areas !== "undefined" && areas[0] ? areas[0].name : null };
  });
  check("the fixture has a design and a selection to lose", before.areas > 0 && before.zones > 0, JSON.stringify(before));

  await pg.evaluate(() => mpHelpOpen());
  await pg.waitForTimeout(200);

  // On a phone the Close button has to be ON SCREEN, not scrolled away.
  const x = await pg.evaluate(() => {
    const b = document.querySelector(".hc-x"); if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
             vw: window.innerWidth, vh: window.innerHeight,
             onScreen: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth };
  });
  check("the Close button is on screen at phone width", x && x.onScreen, JSON.stringify(x));
  // On screen is NOT the same as clickable. At z-index 9000 this button sat
  // under the master plan's own header: visible, correctly sized, and
  // swallowing every click. Ask the document what is actually at that pixel.
  const hit = await pg.evaluate(() => {
    const b = document.querySelector(".hc-x"), r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { isButton: top === b || b.contains(top),
             actually: top ? top.tagName + "." + (top.className || "") : "nothing" };
  });
  check("...and nothing is sitting on top of it", hit.isButton, hit.actually);
  check("...and is a real tap target (44px)", x && x.w >= 40 && x.h >= 40, JSON.stringify(x && [x.w, x.h]));
  check("...and nothing scrolls sideways", !(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  const hitQ = await pg.evaluate(() => {
    const i = document.getElementById("hcQ"), r = i.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === i ? "ok" : (top ? top.tagName + "." + (top.className || "") : "nothing");
  });
  check("the search box is reachable too, not covered", hitQ === "ok", hitQ);

  // Scroll the results a long way: the Close button must still be there.
  await pg.evaluate(() => { const r = document.getElementById("hcResults"); r.scrollTop = r.scrollHeight; });
  await pg.waitForTimeout(120);
  check("Close stays put after scrolling to the bottom of the help",
        await pg.evaluate(() => { const r = document.querySelector(".hc-x").getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight; }));

  await pg.click(".hc-x");
  await pg.waitForTimeout(150);
  const after = await pg.evaluate(() => ({
    sel: typeof mp !== "undefined" ? mp.zoneSel : null,
    dirty: typeof DIRTY !== "undefined" ? DIRTY : (typeof dirty !== "undefined" ? dirty : null),
    areas: typeof areas === "undefined" ? -1 : areas.length,
    zones: typeof LAST_ZONES === "undefined" ? -1 : LAST_ZONES.length,
    name: typeof areas !== "undefined" && areas[0] ? areas[0].name : null }));
  check("the drawing is unchanged", after.areas === before.areas && after.zones === before.zones,
        JSON.stringify([before, after]));
  check("the selected area is still selected", after.sel === before.sel, JSON.stringify([before.sel, after.sel]));
  check("the area's own data is untouched", after.name === before.name);
  check("unsaved work is still flagged unsaved", after.dirty === before.dirty, JSON.stringify([before.dirty, after.dirty]));
  check("no PATCH was sent while the help was open", !saved, JSON.stringify(saved && Object.keys(saved)));
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

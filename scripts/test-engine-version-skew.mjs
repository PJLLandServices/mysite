#!/usr/bin/env node
// scripts/test-engine-version-skew.mjs
//
// THE PAGE AND ITS ENGINE MUST BE THE SAME DEPLOY, AND MUST SAY SO WHEN
// THEY ARE NOT.
//
// The System Builder's maths lives in server/sitebuilder-engine.js, loaded
// by the page as a separate file. The page calls into it by name, so a
// browser holding an older engine against a newer page throws on the first
// call it does not recognise. That happened: the page began calling
// ENGINE.splitStationRule(), a cached engine did not have it, restoreState()
// threw — and the page fell through to startEmptyDesign(), showing an EMPTY
// builder, with a live "Save to project" button, for a project whose design
// was sitting fine on the server. One click from replacing it with nothing.
//
// Two defences, both asserted here:
//
//   A. It cannot go stale. The engine is served no-cache AND its URL is
//      version-stamped, the same two guards /crm/ assets already had. It
//      was missing both, being served from /admin/.
//
//   B. If it goes stale anyway, the page says so and REMOVES the save.
//      An unreadable design and an empty design must never look the same.
//
//   npm run test:engine-skew

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { v8WithSplits } from "./fixtures/v8-split-designs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The name the page calls into the engine for. Removing it from the
// engine's exports is what "an older engine" means, in the only sense that
// matters here.
const NEEDED = "splitStationRule";

let pass = 0; const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};
const launch = () => chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { executablePath: "/opt/pw-browsers/chromium" });

// ── A. The server cannot serve a cacheable, unstamped engine ─────────
console.log("\nA. The engine cannot go stale in the first place");
{
  const srv = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  check("the engine is served no-cache",
        /pathname === "\/admin\/sitebuilder-engine\.js"[\s\S]{0,400}?cache-control"\]\s*=\s*"no-cache"/.test(srv));
  check("its URL is version-stamped like the /crm/ assets",
        /admin\\\/sitebuilder-engine/.test(srv) &&
        /stampAssetVersions/.test(srv));
  // Run the stamper rather than read it: lift the regex out of the source
  // and apply it, so this asserts behaviour rather than the shape of a line.
  // server.js is NOT imported here — importing it starts the whole server.
  const m = srv.match(/\.replace\(\s*(\/[^\n]*?\/g),/);
  check("the stamping regex can be lifted from server.js", !!m);
  if (m) {
    const body = m[1].slice(1, m[1].lastIndexOf("/"));
    const re = new RegExp(body, "g");
    check("it matches the engine's script tag",
          re.test('<script src="/admin/sitebuilder-engine.js"></script>'));
    re.lastIndex = 0;
    check("...and still matches the /crm/ assets it always did",
          re.test('<link rel="stylesheet" href="/crm/crm.css">'));
  }
}

// ── B. A stale engine is reported, and the save is withdrawn ─────────
console.log("\nB. If it goes stale anyway, the page refuses to pretend");
const page_html = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"));
const fresh = fs.readFileSync(path.join(ROOT, "server", "sitebuilder-engine.js"), "utf8");

// The stale engine is SYNTHESISED, not fetched from a commit. An earlier
// version of this test took the engine from origin/main~1 — which stopped
// being stale the moment this fix merged and main moved on, so the test
// quietly started asserting nothing. A stale engine is not "an old commit",
// it is "an engine missing something the page calls", so that is what is
// built: the current engine with one export removed.
const stale = fresh.replace(new RegExp(`\\b${NEEDED},\\s*`), "");
check(`the page calls ENGINE.${NEEDED}`,
      new RegExp(`ENGINE\\.${NEEDED}\\(`).test(page_html.toString()));
check("the stale engine really is missing it",
      stale !== fresh && !new RegExp(`\\b${NEEDED},`).test(stale), "the export was not removed");

async function open(engine, { withDesign }) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page_html); }
    if (p === "/admin/sitebuilder-engine.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(engine); }
    if (p === "/api/projects/PROJ-TEST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, project: {
        id: "PROJ-TEST", name: "Skew test", customerName: "", customerEmail: "", propertyId: null,
        systemDesign: withDesign ? v8WithSplits : null } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    await pg.goto(`http://127.0.0.1:${srv.address().port}/?project=PROJ-TEST`, { waitUntil: "load" });
    await pg.waitForFunction("appReady === true", null, { timeout: 30000 });
    return await pg.evaluate(() => ({
      unreadable: typeof designUnreadable !== "undefined" && designUnreadable === true,
      hasSaveButton: !!document.getElementById("saveBtn"),
      noteShown: !!(document.getElementById("designUnreadableNote") &&
                    !document.getElementById("designUnreadableNote").hidden),
      noteText: (document.getElementById("designUnreadableNote") || {}).innerText || "",
      areas: (typeof areas !== "undefined" ? areas.length : -1)
    }));
  } finally { await browser.close(); srv.close(); }
}

{
  const bad = await open(stale, { withDesign: true });
  check("a stale engine is detected rather than swallowed", bad.unreadable, JSON.stringify(bad));
  check("the Save button is GONE, not merely disabled", !bad.hasSaveButton);
  check("a warning is shown", bad.noteShown);
  check("...that says this is not the project's design", /not it|could not be opened/i.test(bad.noteText), bad.noteText.slice(0, 90));
  check("...and tells Patrick to hard-refresh", /Shift/.test(bad.noteText));
}

const good = await open(fresh, { withDesign: true });
check("a matching engine opens the design normally", !good.unreadable && good.areas > 0, JSON.stringify(good));
check("...and the Save button is there", good.hasSaveButton);

const empty = await open(fresh, { withDesign: false });
check("a project with NO saved design is not called unreadable", !empty.unreadable);
check("...and can still be saved", empty.hasSaveButton);

console.log(`\nengine version skew: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }

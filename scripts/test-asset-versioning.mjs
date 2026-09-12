#!/usr/bin/env node
// scripts/test-asset-versioning.mjs
//
// 2026-09-11. Three deploys, three times: "it's not doing anything."
//
// Each time the server had the new code and Patrick's browser had the old
// season-plan.js. The server sends `no-cache` for /crm/*.js — and
// Cloudflare's Browser Cache TTL rewrote it to four hours on the wire, so
// a hard refresh before the deploy finished pinned the previous day's file
// for the afternoon. The fix that survives anyone's CDN settings: every
// CRM script and stylesheet URL in served HTML carries ?v=<deploy stamp>,
// so a deploy is a new URL and no cache can hand back the old file.
//
// This pins the stamping rule and proves it on a booted server.
//
// Run: node scripts/test-asset-versioning.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 220) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

// Lift the pure stamping function out of server.js and run it against
// plain strings — the same trick test-app-shell uses. Absent means every
// assertion fails with a reason, not a crash.
const src = read("server/server.js");
let stamp = null;
{
  const m = src.match(/function stampAssetVersions\(html, version = ASSET_VERSION\) \{[\s\S]*?\n\}/);
  try {
    stamp = m
      ? new Function(`const ASSET_VERSION = "TESTSTAMP"; ${m[0]} return stampAssetVersions;`)()
      : null;
  } catch (err) {
    stamp = null;
    failures.push(`stampAssetVersions could not be lifted — ${err.message}`);
  }
}
const run = (html, v) => (stamp ? stamp(html, v) : "(stampAssetVersions is missing)");

// ---- 1. The rule ------------------------------------------------------
{
  ok("a CRM script gets the stamp",
    run('<script src="/crm/season-plan.js"></script>', "abc123") === '<script src="/crm/season-plan.js?v=abc123"></script>',
    j(run('<script src="/crm/season-plan.js"></script>', "abc123")));
  ok("…and a CRM stylesheet",
    run('<link rel="stylesheet" href="/crm/season-plan.css">', "abc123") === '<link rel="stylesheet" href="/crm/season-plan.css?v=abc123">',
    j(run('<link rel="stylesheet" href="/crm/season-plan.css">', "abc123")));
  ok("…with single quotes too",
    run("<script src='/crm/admin.js'></script>", "x") === "<script src='/crm/admin.js?v=x'></script>",
    j(run("<script src='/crm/admin.js'></script>", "x")));
  ok("the stamp defaults to the process's own version when none is given",
    /\?v=TESTSTAMP/.test(run('<script src="/crm/a.js"></script>')), j(run('<script src="/crm/a.js"></script>')));
}

// ---- 2. What it must leave alone --------------------------------------
{
  // A service worker's registration URL must not change between loads,
  // or the browser installs a second worker beside the first.
  const sw = '<script src="/crm/tech-sw.js"></script>';
  ok("the service worker is never stamped", run(sw, "x") === sw, j(run(sw, "x")));

  // A URL that already carries a query has its own reason for it.
  const already = '<script src="/crm/a.js?v=old"></script>';
  ok("an already-versioned URL is left as it is", run(already, "new") === already, j(run(already, "new")));
  const query = '<link href="/crm/a.css?theme=dark">';
  ok("…and so is any other query", run(query, "x") === query, j(run(query, "x")));

  // Only the CRM tree; the public site keeps its own caching.
  const pub = '<script src="/js/site.js"></script><link href="/css/site.css">';
  ok("public-site assets are untouched", run(pub, "x") === pub, j(run(pub, "x")));
  const img = '<img src="/crm/pjl-logo.svg">';
  ok("images are untouched", run(img, "x") === img, j(run(img, "x")));
  const ext = '<script src="https://cdn.example/x.js"></script>';
  ok("external scripts are untouched", run(ext, "x") === ext, j(run(ext, "x")));
  // A CRM path mentioned in running text or an inline string is not a
  // src=/href= attribute and must not be rewritten.
  const inline = '<script>navigator.serviceWorker.register("/crm/tech-sw.js")</script><p>see /crm/help.js</p>';
  ok("an inline mention is not an attribute and is left alone", run(inline, "x") === inline, j(run(inline, "x")));
}

// ---- 3. Idempotent and empty-safe -------------------------------------
{
  const once = run('<script src="/crm/a.js"></script>', "x");
  ok("stamping twice is one stamp", run(once, "x") === once, j(run(once, "x")));
  ok("an empty stamp changes nothing", run('<script src="/crm/a.js"></script>', "") === '<script src="/crm/a.js"></script>',
    j(run('<script src="/crm/a.js"></script>', "")));
  ok("a page with nothing to stamp comes back unchanged", run("<p>hello</p>", "x") === "<p>hello</p>", j(run("<p>hello</p>", "x")));
}

// ---- 4. Defined once, applied where every CRM page is sent --------------
{
  ok("the version is defined once", (src.match(/const ASSET_VERSION =/g) || []).length === 1, "ASSET_VERSION defined 0 or 2+ times");
  ok("…from the deploy's commit when Render provides one",
    /process\.env\.RENDER_GIT_COMMIT/.test(src), "the stamp ignores the deploy commit");
  ok("the static sender stamps every CRM .html it serves",
    /ext === "\.html" && dir === SERVER_DIR[\s\S]{0,200}stampAssetVersions\(raw\)/.test(src),
    "CRM pages are sent without stamping");
  ok("…sending the stamped body's own length, not the file's",
    /headers\["content-length"\] = Buffer\.byteLength\(body\)/.test(src), "content-length would be the disk size");
  ok("…and still no-store on the page itself",
    /"cache-control": ext === "\.html" \? "no-store"/.test(src), "the HTML page became cacheable");
}

// ---- 5. On a booted server: the login page, which needs no session -------
{
  const port = 8130 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RENDER_GIT_COMMIT: "deadbeefcafe0000" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/booking/services`);
      booted = r.ok;
    } catch { /* not yet */ }
  }
  ok("the server boots with the stamping in place", booted, "no response from /api/booking/services");
  if (booted) {
    try {
      const a = await fetch(`http://127.0.0.1:${port}/login`);
      const html = await a.text();
      ok("/login is served", a.status === 200, `status ${a.status}`);
      ok("…with its script versioned by the deploy commit",
        /src="\/crm\/login\.js\?v=deadbeefca"/.test(html), j(html.match(/\/crm\/login\.js[^"]*/)?.[0]));
      ok("…and its stylesheet",
        /href="\/crm\/login\.css\?v=deadbeefca"/.test(html), j(html.match(/\/crm\/login\.css[^"]*/)?.[0]));
      ok("…the logo image untouched",
        /src="\/crm\/pjl-logo\.svg"/.test(html), j(html.match(/\/crm\/pjl-logo\.svg[^"]*/)?.[0]));
      ok("…and the page itself still no-store",
        /no-store/.test(a.headers.get("cache-control") || ""), j(a.headers.get("cache-control")));
      ok("…with a content-length that matches the stamped body",
        Number(a.headers.get("content-length")) === Buffer.byteLength(html), `${a.headers.get("content-length")} vs ${Buffer.byteLength(html)}`);
      const b = await fetch(`http://127.0.0.1:${port}/login`);
      const html2 = await b.text();
      ok("two requests carry the same stamp", html === html2, "the stamp moved between requests");
      // The asset itself still answers, with the query ignored.
      const js = await fetch(`http://127.0.0.1:${port}/crm/login.js?v=deadbeefca`);
      ok("the versioned asset URL serves the file", js.status === 200 && /javascript/.test(js.headers.get("content-type") || ""), `status ${js.status}`);
    } catch (err) {
      failures.push(`boot probe threw — ${err.message}`);
    }
  }
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
}

if (failures.length) {
  console.error(`\n✗ test-asset-versioning: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-asset-versioning: ${pass} assertions passed`);

// scripts/lib/system-design-capture.mjs
//
// Runs the fixtures through the System Builder engine AS IT LIVES IN THE
// PAGE, and returns the raw capture.
//
// The engine is browser-resident: it reads the GPM ceiling and the spacing
// factor out of two form fields, and it is declared inside sitebuilder.html's
// one big <script>. So the only honest way to record what it currently
// answers is to load the real page and call the real functions.
//
// This deliberately does NOT go through the renderer. compute() interleaves
// the maths with innerHTML writes; calling plan() / computeZonePlan() /
// buildBOM() directly is the calculation path with the painting left out —
// which is exactly the seam the extraction cuts along.
//
// No server, no login, no records. The page is served from disk by a
// throwaway static server and every API call is stubbed, because a
// calculation engine has nothing to do with authentication or stored data.
// PARTS_MAP is injected from the frozen catalog snapshot so prices are
// fixed to the cent.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = path.join(ROOT, "server", "sitebuilder.html");
const PARTS = path.join(ROOT, "scripts", "fixtures", "system-design-parts.json");

export function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const fallback = "/opt/pw-browsers/chromium";
  if (fs.existsSync(fallback)) return { executablePath: fallback };
  return {};
}

/**
 * Serve sitebuilder.html at "/" and its sibling scripts from server/, so an
 * extracted engine loaded with <script src="..."> resolves. Everything else
 * answers with an empty JSON object: the page's start-up fetches (project
 * list, parts) then fall through to their own empty-state paths instead of
 * hanging.
 */
function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const name = url.pathname === "/" ? "sitebuilder.html" : path.basename(url.pathname);
    const file = path.join(ROOT, "server", name);
    if (/\.(html|js|css)$/.test(name) && file.startsWith(path.join(ROOT, "server")) && fs.existsSync(file)) {
      const type = name.endsWith(".html") ? "text/html"
        : name.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * @param {Array} fixtures  from scripts/fixtures/system-design-fixtures.mjs
 * @param {object} opts
 * @param {(page:import('playwright').Page)=>Promise<void>} [opts.onReady]
 * @returns {Promise<{engine:string, capturedAt:string, fixtures:Array}>}
 */
export async function captureFromPage(fixtures, opts = {}) {
  const partsSnapshot = JSON.parse(fs.readFileSync(PARTS, "utf8")).parts;
  const { server, port } = await startStaticServer();
  const browser = await chromium.launch(chromiumLaunchOpts());
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    // initApp() is async; it finishes by flipping appReady.
    // `appReady` is a top-level `let`, so it is a global LEXICAL binding, not a
    // property of window — readable by name from an evaluated function, but
    // invisible as window.appReady.
    await page.waitForFunction("appReady === true", null, { timeout: 20000 });
    if (opts.onReady) await opts.onReady(page);

    const out = [];
    for (const fx of fixtures) {
      out.push(await page.evaluate(runFixtureInPage, { fx, parts: partsSnapshot }));
    }
    if (errors.length) throw new Error("page errors during capture:\n  " + errors.join("\n  "));
    return { engine: "in-page (server/sitebuilder.html)", capturedAt: new Date().toISOString(), fixtures: out };
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Runs INSIDE the page. Drives the engine's three entry points and returns
 * every number they produce.
 *
 * Note this reaches the engine only through the names the page already
 * declares — no private copy, no re-implementation. Whatever the page's
 * plan() does today is what lands in the golden file.
 */
/* c8 ignore start — executes in the browser, not in Node */
function runFixtureInPage({ fx, parts }) {
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // The two globals the engine reads out of the DOM.
  document.getElementById("ceiling").value = String(fx.inputs.ceiling);
  document.getElementById("spacingFactor").value = String(fx.inputs.spacingFactor);

  // Design state.
  areas = clone(fx.areas);
  routing = clone(fx.routing || {});
  valveGroupModes = clone(fx.valveGroupModes || {});
  PARTS_MAP = parts;

  // The calculation path, renderer left out.
  LAST_PLANS = areas.map((a) => ({ area: a, plan: plan(a) }));
  LAST_ZONES = computeZonePlan();
  const bom = buildBOM(parts);

  const areaOut = areas.map((a, i) => ({
    aid: a.aid,
    name: a.name,
    // ensureArea() migrates legacy designs in place; record what it settled
    // on so a migration drift is visible on its own, not only downstream.
    resolvedFamily: a.family,
    materialCents: areaMaterialCents(a, LAST_PLANS[i].plan),
    plan: LAST_PLANS[i].plan
  }));

  return {
    id: fx.id,
    why: fx.why,
    inputs: fx.inputs,
    areas: areaOut,
    zones: LAST_ZONES,
    stations: { count: stationCount(), zones: stationZones(), peakGPM: peakStationGPM() },
    bom,
    totals: {
      areaCount: areas.length,
      valveCount: LAST_ZONES.length,
      stationCount: stationCount(),
      headCount: LAST_PLANS.reduce(
        (t, x) => t + ((x.plan.heads && x.plan.heads.length) || 0), 0
      ),
      totalGPM: LAST_PLANS.reduce((t, x) => t + (x.plan.totalGPM || 0), 0),
      bomSubtotalCents: bom.subtotalCents,
      areaMaterialCentsTotal: areaOut.reduce((t, a) => t + a.materialCents, 0)
    }
  };
}
/* c8 ignore stop */

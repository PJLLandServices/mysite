#!/usr/bin/env node
// scripts/ui-audit.js
//
// Captures every admin page at four viewport widths for layout audit.
// Output lands in audit/captures/ as PNGs + a self-contained gallery
// (index.html). Re-runnable: clears prior captures at the start so the
// folder always reflects the most recent run.
//
// Prereqs:
//   1. `npm start` running on http://127.0.0.1:4173 (separate terminal)
//   2. `npx playwright install chromium` (one-time per machine)
//   3. AUDIT_USER + AUDIT_PASS env vars set to an admin account in
//      server/data/users.json. (Brief 01 assumed a single password;
//      the live system uses per-user accounts, so both vars are required.)
//
// Usage:
//   AUDIT_USER=admin@example.com AUDIT_PASS=secret npm run audit:ui
//
// Exit codes: 0 = ran end-to-end (some pages may have been skipped with
// warnings); non-zero = configuration / connectivity / login failure.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(REPO_ROOT, "audit");
const CAPTURES_DIR = path.join(AUDIT_DIR, "captures");
const STORAGE_STATE = path.join(AUDIT_DIR, ".auth-state.json");
const DATA_DIR = path.join(REPO_ROOT, "server", "data");

const BASE_URL = process.env.AUDIT_BASE_URL || "http://127.0.0.1:4173";
const PAGE_TIMEOUT_MS = 15_000;

const VIEWPORTS = [
  { label: "iphone-17-pro-max", width: 440, height: 956 },
  { label: "ipad-portrait", width: 820, height: 1180 },
  { label: "macbook-14", width: 1512, height: 982 },
  { label: "desktop", width: 1920, height: 1080 },
];

// Index/list pages — no ID lookup needed.
const INDEX_PAGES = [
  ["today", "/admin/today"],
  ["crm", "/admin"],
  ["schedule", "/admin/schedule"],
  ["handoff", "/admin/handoff"],
  ["properties", "/admin/properties"],
  ["projects", "/admin/projects"],
  ["work-orders", "/admin/work-orders"],
  ["quote-folder", "/admin/quote-folder"],
  ["invoices", "/admin/invoices"],
  ["material-lists", "/admin/material-lists"],
  ["purchase-orders", "/admin/purchase-orders"],
  ["chats", "/admin/chats"],
  ["suppliers", "/admin/suppliers"],
  ["parts-suppliers", "/admin/parts-suppliers"],
  ["settings", "/admin/settings"],
];

// Detail pages — resolve a representative ID from the corresponding
// entity file (most recently updated record).
//   [slug, dataFile, urlBuilder(id)]
const DETAIL_PAGES = [
  ["property", "properties.json", (id) => `/admin/property/${id}`],
  ["project", "projects.json", (id) => `/admin/project/${id}`],
  ["work-order-desktop", "work-orders.json", (id) => `/admin/work-order/${id}`],
  ["work-order-tech", "work-orders.json", (id) => `/admin/work-order/${id}/tech`],
  ["invoice", "invoices.json", (id) => `/admin/invoice/${id}`],
  ["material-list", "material-lists.json", (id) => `/admin/material-list/${id}`],
  ["purchase-order", "purchase-orders.json", (id) => `/admin/purchase-order/${id}`],
];

const DISABLE_ANIMATIONS_CSS =
  "*, *::before, *::after { animation-duration: 0s !important; " +
  "animation-delay: 0s !important; transition-duration: 0s !important; " +
  "transition-delay: 0s !important; scroll-behavior: auto !important; " +
  "caret-color: transparent !important; }";

// ---- Utilities ---------------------------------------------------------

function fail(msg, code = 1) {
  console.error("");
  console.error("❌ " + msg);
  process.exit(code);
}

function fmtSecs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(str, n) {
  str = String(str);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function pickLatestRecord(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const copy = records.filter((r) => r && typeof r === "object" && r.id);
  if (copy.length === 0) return null;
  copy.sort((a, b) => {
    const aKey = a.updatedAt || a.createdAt || "";
    const bKey = b.updatedAt || b.createdAt || "";
    if (aKey === bKey) return 0;
    return aKey < bKey ? 1 : -1;
  });
  return copy[0];
}

async function readJsonOrEmpty(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function checkDevServer() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/login`, (res) => {
      res.resume();
      resolve(typeof res.statusCode === "number");
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000);
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function clearCaptureDir() {
  await fsp.mkdir(CAPTURES_DIR, { recursive: true });
  const entries = await fsp.readdir(CAPTURES_DIR);
  for (const name of entries) {
    if (name === "index.html" || name.endsWith(".png")) {
      await fsp.rm(path.join(CAPTURES_DIR, name)).catch(() => {});
    }
  }
}

// ---- Login + storage state ---------------------------------------------

async function loginAndPersist() {
  const email = (process.env.AUDIT_USER || "").trim();
  const password = process.env.AUDIT_PASS || "";
  if (!email) fail("AUDIT_USER env var not set — required (admin email in users.json).");
  if (!password) fail("AUDIT_PASS env var not set — required (admin password).");

  // Discard any stale storage state from a previous run.
  await fsp.rm(STORAGE_STATE, { force: true }).catch(() => {});

  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const response = await context.request.post(`${BASE_URL}/api/login`, {
      data: { email, password },
      headers: { "content-type": "application/json" },
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => "");
      await context.close();
      await browser.close();
      fail(
        `Login failed (${response.status()}) — check AUDIT_USER / AUDIT_PASS. ` +
          (body ? `Server said: ${body.slice(0, 200)}` : "")
      );
    }
    const data = await response.json().catch(() => ({}));
    if (!data || data.ok !== true) {
      await context.close();
      await browser.close();
      fail(`Login response not ok — check AUDIT_USER / AUDIT_PASS. Body: ${JSON.stringify(data)}`);
    }
    console.log(`[login] authenticated as ${email}`);
    await fsp.mkdir(path.dirname(STORAGE_STATE), { recursive: true });
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await context.close();
    await browser.close();
  }
}

// ---- Capture -----------------------------------------------------------

async function capturePage(browser, viewport, slug, urlPath) {
  const t0 = Date.now();
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  // Disable animations / transitions to avoid timing flakes.
  await context.addInitScript((css) => {
    const inject = () => {
      if (document.getElementById("__pjl_audit_disable_anim")) return;
      const style = document.createElement("style");
      style.id = "__pjl_audit_disable_anim";
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
      inject();
    }
  }, DISABLE_ANIMATIONS_CSS);

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  const url = `${BASE_URL}${urlPath}`;
  let note = "";
  let status = null;
  try {
    const response = await page.goto(url, { waitUntil: "networkidle" });
    status = response ? response.status() : null;
    if (status != null && (status < 200 || status >= 400)) {
      note = ` [status ${status}]`;
    }
  } catch (err) {
    // networkidle can hang on slow background fetches. Fall back to load.
    note = " [networkidle-timeout]";
    try {
      await page.waitForLoadState("load", { timeout: 5_000 });
    } catch {
      // Capture whatever rendered.
    }
  }

  // Re-assert animation-disable in case the page injected anything.
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS }).catch(() => {});

  const outFile = path.join(CAPTURES_DIR, `${slug}__${viewport.label}.png`);
  let captured = false;
  try {
    await page.screenshot({ path: outFile, fullPage: true });
    captured = true;
  } catch (err) {
    note += ` [screenshot failed: ${(err && err.message ? err.message : "unknown").slice(0, 80)}]`;
  }

  await context.close();

  console.log(
    `[capture] ${pad(viewport.label, 18)} · ${pad(urlPath, 40)} · ${fmtSecs(
      Date.now() - t0
    )}${note}`
  );

  return { captured, note };
}

// ---- Gallery -----------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function gallerySection(slug, urlPath) {
  const caps = VIEWPORTS.map((v) => {
    const file = `${slug}__${v.label}.png`;
    const exists = fs.existsSync(path.join(CAPTURES_DIR, file));
    return `      <div class="cap${exists ? "" : " missing"}">
        <span>${escapeHtml(v.label)} · ${v.width}×${v.height}${exists ? "" : " · MISSING"}</span>
        ${exists ? `<a href="${escapeHtml(file)}" target="_blank"><img src="${escapeHtml(file)}" alt="${escapeHtml(slug)} ${escapeHtml(v.label)}" loading="lazy"></a>` : ""}
      </div>`;
  }).join("\n");
  return `  <section id="${escapeHtml(slug)}">
    <h2>${escapeHtml(slug)} <small>${escapeHtml(urlPath)}</small></h2>
    <div class="row">
${caps}
    </div>
  </section>`;
}

async function writeGallery(pages, timestamp, summary) {
  const sections = pages.map((p) => gallerySection(p.slug, p.urlPath)).join("\n");
  const warningsHtml = summary.warnings.length
    ? `<ul class="warnings">${summary.warnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("")}</ul>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>PJL UI Audit — ${escapeHtml(timestamp)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; background: #fafaf6; color: #1a1a1a; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 32px 0 8px; font-size: 16px; display: flex; gap: 12px; align-items: baseline; }
  h2 small { color: #888; font-weight: normal; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .meta { color: #666; font-size: 13px; margin-bottom: 12px; }
  .toc { font-size: 13px; margin: 16px 0 24px; line-height: 1.7; }
  .toc a { margin-right: 12px; color: #2a64a8; text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .row { display: flex; flex-wrap: wrap; gap: 12px; }
  .cap { flex: 1 1 300px; max-width: 480px; border: 1px solid #ccc; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .cap.missing { background: #fff5f5; border-color: #f0c0c0; min-height: 60px; }
  .cap img { width: 100%; display: block; }
  .cap span { display: block; font-size: 12px; padding: 4px 6px; background: #eee; border-bottom: 1px solid #ddd; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cap.missing span { background: #fde0e0; color: #8a2a2a; }
  ul.warnings { background: #fff8e1; border: 1px solid #f0d57b; padding: 8px 16px 8px 28px; margin: 12px 0 24px; font-size: 13px; }
</style></head>
<body>
<h1>PJL UI Audit</h1>
<div class="meta">Captured ${escapeHtml(timestamp)} · ${summary.captureCount} captures · ${summary.skipped} skipped · ${summary.warnings.length} warnings</div>
<div class="toc">${pages.map((p) => `<a href="#${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a>`).join("")}</div>
${warningsHtml}
${sections}
</body></html>
`;
  await fsp.writeFile(path.join(CAPTURES_DIR, "index.html"), html, "utf8");
}

// ---- Main --------------------------------------------------------------

async function main() {
  console.log(`[ui-audit] base url: ${BASE_URL}`);

  const reachable = await checkDevServer();
  if (!reachable) {
    fail(
      `Cannot reach ${BASE_URL} — is \`npm start\` running on port 4173? ` +
        `(Override with AUDIT_BASE_URL=http://...)`
    );
  }

  await clearCaptureDir();
  await loginAndPersist();

  // Resolve detail-page IDs from server/data.
  const dataCache = new Map();
  const detailIds = {};
  const warnings = [];
  for (const [slug, file] of DETAIL_PAGES) {
    if (!dataCache.has(file)) {
      dataCache.set(file, await readJsonOrEmpty(path.join(DATA_DIR, file)));
    }
    const latest = pickLatestRecord(dataCache.get(file));
    if (!latest) {
      const msg = `No usable record in server/data/${file} — skipping ${slug}.`;
      warnings.push(msg);
      console.warn(`[skip] ${msg}`);
      detailIds[slug] = null;
    } else {
      detailIds[slug] = latest.id;
    }
  }

  // Build the page list.
  const pages = [];
  for (const [slug, urlPath] of INDEX_PAGES) {
    pages.push({ slug, urlPath });
  }
  for (const [slug, _file, builder] of DETAIL_PAGES) {
    if (detailIds[slug]) {
      pages.push({ slug, urlPath: builder(detailIds[slug]) });
    }
  }

  // Single shared browser; per-capture context so storage state + viewport
  // are clean each time and SW caches can't leak between pages.
  const browser = await chromium.launch();
  let captureCount = 0;
  let skipped = 0;
  try {
    for (const p of pages) {
      for (const v of VIEWPORTS) {
        const { captured, note } = await capturePage(browser, v, p.slug, p.urlPath);
        if (captured) {
          captureCount++;
        } else {
          skipped++;
          warnings.push(`${p.slug} @ ${v.label}: capture failed${note}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  const timestamp = new Date().toISOString().replace("T", " ").replace(/\..+$/, " UTC");
  await writeGallery(pages, timestamp, { captureCount, skipped, warnings });

  console.log("");
  console.log(`Done. ${captureCount} captures · ${skipped} skipped · ${warnings.length} warnings`);
  console.log(`  Output:  ${CAPTURES_DIR}`);
  console.log(`  Gallery: ${path.join(CAPTURES_DIR, "index.html")}`);
  for (const w of warnings) console.log(`    ! ${w}`);
}

main().catch((err) => {
  console.error("");
  console.error("Audit run failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});

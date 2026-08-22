#!/usr/bin/env node
// Render a .docx to PNG page images so it can be looked at.
//
//   node scripts/render-docx.js file.docx [outdir]
//
// LibreOffice cannot load any file in the Claude Code container, so the
// usual soffice --convert-to pdf route is unavailable. docx-preview
// renders the actual OOXML in Chromium — table widths, borders, shading
// and fonts included — which is what a layout check needs.
//
// Dev tool. Not wired into build:check; it needs playwright + chromium.

const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const src = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(src), "render");
  if (!src || !fs.existsSync(src)) {
    console.error("Usage: node scripts/render-docx.js <file.docx> [outdir]");
    process.exit(1);
  }
  const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
  fs.mkdirSync(outDir, { recursive: true });

  // Read the bundles straight off disk — both packages restrict their
  // "exports" map, so require.resolve() on a dist path throws.
  const NM = path.join(__dirname, "..", "node_modules");
  const lib = fs.readFileSync(path.join(NM, "docx-preview/dist/docx-preview.js"), "utf8");
  const jszip = fs.readFileSync(path.join(NM, "jszip/dist/jszip.min.js"), "utf8");
  const b64 = fs.readFileSync(src).toString("base64");

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });

  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#888} .docx-wrapper{background:#888;padding:20px}</style>
    <div id="c"></div>`);
  await page.addScriptTag({ content: jszip });
  await page.addScriptTag({ content: lib });

  const count = await page.evaluate(async (data) => {
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await window.docx.renderAsync(buf, document.getElementById("c"), null, {
      className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false,
      breakPages: true, renderHeaders: true, renderFooters: true
    });
    return document.querySelectorAll("section.docx").length;
  }, b64);

  console.log(`rendered ${count} page section(s)`);
  const sections = await page.$$("section.docx");
  for (let i = 0; i < sections.length; i++) {
    const out = path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`);
    await sections[i].screenshot({ path: out });
    console.log("  " + out);
  }
  if (!sections.length) {
    const out = path.join(outDir, "page-01.png");
    await page.screenshot({ path: out, fullPage: true });
    console.log("  (no page sections — full-page shot) " + out);
  }
  await browser.close();
})();

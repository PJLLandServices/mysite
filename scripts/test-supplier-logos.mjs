#!/usr/bin/env node
// Supplier logos (P-PJL-35 M2a, FLOW-48).
//
// Patrick: use the supplier's official logo; "preserve transparency and
// aspect ratio; resize only, never crop". And an ordinary edit on the
// Suppliers page must never drop the logo or the short name.
//
// The supplier store is exercised on a COPY of lib/suppliers.js in a temp
// folder (it writes ../data/suppliers.json relative to itself), so this can
// never touch real data.
//
// Run: node scripts/test-supplier-logos.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");
const { processLogo, createSupplierLogos, logoUrl } = require(path.join(ROOT, "server", "lib", "supplier-logos.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); }
}

// ---- 1. Resize only ------------------------------------------------------------
{
  // A wide transparent logo, 2258×460 like Central Pro Supply's navy PNG,
  // with a coloured mark touching the far left and right edges.
  const W = 2258, H = 460;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="0" y="100" width="300" height="260" fill="#0b2345"/><rect x="${W - 300}" y="100" width="300" height="260" fill="#0b2345"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const out = await processLogo(png, sharp);
  const m = await sharp(out.png).metadata();
  check("logo: resized to fit 600×200", out.width <= 600 && out.height <= 200, `${out.width}x${out.height}`);
  check("logo: aspect ratio kept", Math.abs(out.width / out.height - W / H) < 0.02, `${(out.width / out.height).toFixed(3)} vs ${(W / H).toFixed(3)}`);
  check("logo: transparency kept (PNG with alpha)", m.format === "png" && m.hasAlpha === true);
  const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  check("logo: never cropped — the mark still touches both edges", alphaAt(0, Math.floor(info.height / 2)) > 200 && alphaAt(info.width - 1, Math.floor(info.height / 2)) > 200);
  check("logo: transparent corners stay transparent", alphaAt(0, 0) === 0 && alphaAt(info.width - 1, info.height - 1) === 0);

  const small = await sharp({ create: { width: 120, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const s = await processLogo(small, sharp);
  check("logo: a small logo is never enlarged", s.width === 120 && s.height === 40);

  const svgLogo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 162 46"><path d="M0 0H162V46H0Z" fill="#78A22F"/></svg>`);
  const sv = await processLogo(svgLogo, sharp);
  check("logo: an official SVG is accepted and keeps its shape", sv.sourceFormat === "svg" && Math.abs(sv.width / sv.height - 162 / 46) < 0.05, `${sv.width}x${sv.height}`);

  await rejects("logo: a non-image is refused", () => processLogo(Buffer.from("hello"), sharp), /image/i);
  await rejects("logo: an empty upload is refused", () => processLogo(Buffer.alloc(0), sharp), /empty/i);
  const src = fs.readFileSync(path.join(ROOT, "server", "lib", "supplier-logos.js"), "utf8").replace(/\/\/.*$/gm, "");
  check("logo: no crop/trim/extract/flip in the module", !/\.(extract|trim|flip|flop|affine)\(/.test(src) && !/\.rotate\(\s*[^)\s]/.test(src));
  check("logo: URL is content-addressed", logoUrl({ hash: out.hash }) === `/api/supplier-logos/${out.hash}.png` && logoUrl({ hash: "../x" }) === null);
}

// ---- 2. The store --------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supplier-logos-"));
  try {
    fs.mkdirSync(path.join(tmp, "lib"));
    fs.copyFileSync(path.join(ROOT, "server", "lib", "suppliers.js"), path.join(tmp, "lib", "suppliers.js"));
    const suppliers = require(path.join(tmp, "lib", "suppliers.js"));
    const logos = createSupplierLogos({ dataDir: path.join(tmp, "data"), sharp });

    const s = await suppliers.create({ name: "SiteOne Landscape Supply", shortName: "SiteOne", email: "orders@example.test" });
    check("store: short name saved on create", s.shortName === "SiteOne");
    const logo = await logos.save(await sharp({ create: { width: 300, height: 90, channels: 4, background: "#78a22f" } }).png().toBuffer());
    await suppliers.setLogo(s.id, logo);
    check("store: logo file written", fs.existsSync(logos.logoPath(logo.hash)));

    // An ordinary edit from an older form that sends no shortName / logo.
    const edited = await suppliers.update(s.id, { name: "SiteOne Landscape Supply", email: "new@example.test" });
    check("store: an ordinary edit keeps the logo", edited.logo && edited.logo.hash === logo.hash);
    check("store: an edit without shortName keeps the short name", edited.shortName === "SiteOne");
    const renamed = await suppliers.update(s.id, { name: "SiteOne Landscape Supply", shortName: "SiteOne LS" });
    check("store: an edit WITH shortName changes it (and keeps the logo)", renamed.shortName === "SiteOne LS" && renamed.logo && renamed.logo.hash === logo.hash);
    const cleared = await suppliers.setLogo(s.id, null);
    check("store: the logo can be removed", cleared.logo === null);
    const bad = await suppliers.setLogo(s.id, { hash: "../../etc/passwd" });
    check("store: a malformed logo record is dropped", bad.logo === null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\ntest-supplier-logos: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

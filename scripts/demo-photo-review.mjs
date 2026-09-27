#!/usr/bin/env node
// Fill a LOCAL data folder with mocked AI photo results so the Photo Review
// tab (P-PJL-35 M3b) can be walked without any AI run. The real backfill
// engine runs; only the AI, the web pages and the images are fake — every
// image is a grey placeholder stamped "MOCK PHOTO" with its SKU, so nothing
// here can be mistaken for a real product photo.
//
//   node scripts/demo-photo-review.mjs --data-dir server/data
//
// Refuses to run on Render. The fitting pairs are deliberately artificial
// (they exist to exercise the "Fittings to confirm" screen).

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const dataDir = arg("--data-dir");
if (!dataDir) { console.error("Pass --data-dir <folder>."); process.exit(2); }
if (process.env.RENDER || process.env.RENDER_SERVICE_ID) { console.error("Refusing to run on Render."); process.exit(2); }
const DIR = path.resolve(ROOT, dataDir);
fs.mkdirSync(DIR, { recursive: true });

const sharp = require("sharp");
const ev = require(path.join(ROOT, "server/lib/photo-evidence.js"));
const pp = require(path.join(ROOT, "server/lib/part-photos.js"));
const { createBackfill } = require(path.join(ROOT, "server/lib/photo-backfill.js"));
const ai = require(path.join(ROOT, "server/lib/photo-ai.js"));

const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, "parts.json"), "utf8"));
const catalog = Object.fromEntries((Array.isArray(RAW.parts) ? RAW.parts : Object.values(RAW.parts)).map((p) => [p.sku, p]));
const store = pp.createPartPhotos({ dataDir: DIR, sharp });

const V = (over = {}) => Object.fromEntries(ev.VISION_KEYS.map((k) => [k, { result: over[k] || "pass", reason: over[k] ? `Mock: ${k} is ${over[k]}.` : "Mock: matches." }]));
const page = (visible) => `<html><body><h1>${visible}</h1></body></html>`;
const WEB = {};
const off = (domain, sku, n = 1) => `https://www.${domain}/p/${sku.toLowerCase()}-${n}`;
function cand(domain, sku, n, visible) { const u = off(domain, sku, n); WEB[u] = page(visible); return { pageUrl: u, imageUrl: `${u}.jpg`, partNumberAsShown: "" }; }

// [sku, { pass: finderResult }, vision overrides, compare]
const PLAN = {
  HCHPC400: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "HCHPC400", candidates: [cand("hunterirrigation.com", "HCHPC400", 1, "Hydrawise HCHPC400 controller")] } },
  HCX2400: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "HCHPC400", candidates: [cand("hunterirrigation.com", "HCX2400", 1, "Controller HCX2400 HCHPC400")] } },
  HSPGPADJ: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand("hunterirrigation.com", "HSPGPADJ", 1, "PGP-ADJ rotor")] },
              2: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand("siteone.com", "HSPGPADJ", 1, "Item HSPGPADJ Mfr PGP-ADJ")] } },
  PGV100G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV100G", candidates: [cand("hunterirrigation.com", "PGV100G", 1, "PGV100G globe valve"), cand("hunterirrigation.com", "PGV100G", 2, "PGV100G globe valve")] }, vision: V({ size: "unknown" }) },
  HCPCM300: { 1: null, 2: { manufacturer: "Hunter", manufacturerPartNumber: "PCM-300", candidates: [cand("siteone.com", "HCPCM300", 1, "Pro-C module PCM-300")] } },
  HCPCM900: { 1: null, 2: { manufacturer: "Hunter", manufacturerPartNumber: "PCM-300", candidates: [cand("centralpros.com", "HCPCM900", 1, "Pro-C module PCM-300")] } },
  LDQ0812100: { 1: null, 2: { manufacturer: "Rain Bird", manufacturerPartNumber: "", candidates: [cand("siteone.com", "LDQ0812100", 1, "Rain Bird LDQ0812100 drip tube"), cand("centralpros.com", "LDQ0812100", 1, "LDQ0812100")] }, vision: V({ pack: "unknown" }) },
  RBN10H: { 1: { manufacturer: "Rain Bird", manufacturerPartNumber: "RBN10H", candidates: [cand("rainbird.com", "RBN10H", 1, "RBN10H nozzle")] }, vision: V({ type: "fail" }) },
  VB10RND: {},
  POPO100300: { 1: { manufacturer: "Oil Creek", manufacturerPartNumber: "POPO100300", candidates: [cand("oilcreekplastics.com", "POPO100300", 1, "POPO100300 utility pipe")] } },
  BL37070: { 1: { manufacturer: "Blu-Lock", manufacturerPartNumber: "BL37070", candidates: [cand("hydrorain.com", "BL37070", 1, "Blu-Lock SX elbow")] } },
  205020: { 2: { candidates: [cand("siteone.com", "205020", 1, 'PVC nipple 1/2" x 2" MxM TBE'), cand("centralpros.com", "205020", 1, '1/2" PVC nipple 2" MxM TBE')] } },
  1401007: { 2: { candidates: [cand("siteone.com", "1401007", 1, 'Poly tee 3/4"'), cand("siteone.com", "1401007", 2, 'Poly tee 3/4"'), cand("siteone.com", "1401007", 3, 'Poly tee 3/4"')] } },
  DUVB60: { 2: { candidates: [cand("siteone.com", "DUVB60", 1, '6" round valve box'), cand("centralpros.com", "DUVB60", 1, '6" round valve box')] }, compare: "fail" },
  408005: { 2: { candidates: [cand("siteone.com", "408005", 1, 'PVC elbow 1/2" 90 FxF')] } },
  1435007: { 2: { candidates: [cand("centralpros.com", "1435007", 1, 'Poly female adapter 3/4" IxF')] }, vision: V({ ends: "unknown" }) },
  SC6712: {}
};

async function mockImage(url) {
  const sku = (url.match(/\/p\/([^/]+?)-\d+/) || [])[1] || "?";
  const n = (url.match(/-(\d+)\.jpg$/) || [])[1] || "1";
  const host = new URL(url).hostname.replace(/^www\./, "");
  const shade = 150 + (n * 25) % 80;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${n === "2" ? 1200 : 700}">
    <rect width="100%" height="100%" fill="#fff"/>
    <rect x="250" y="120" width="400" height="${n === "2" ? 760 : 300}" rx="40" fill="rgb(${shade},${shade},${shade - 10})"/>
    <text x="450" y="${n === "2" ? 980 : 520}" font-family="Arial" font-size="56" font-weight="700" text-anchor="middle" fill="#B71C1C">MOCK PHOTO ${n}</text>
    <text x="450" y="${n === "2" ? 1050 : 590}" font-family="Arial" font-size="40" text-anchor="middle" fill="#333">${sku.toUpperCase()} · ${host}</text>
  </svg>`;
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), finalUrl: url };
}

const fake = {
  passesFor: ai.passesFor,
  async find(part, pass) { const f = (PLAN[part.sku] || {})[pass]; return { manufacturer: "", manufacturerPartNumber: "", notes: f ? "" : `mock: nothing on pass ${pass}`, candidates: [], ...(f || {}) }; },
  async verify(part) { return (PLAN[part.sku] || {}).vision || V(); },
  async compare(part) { return { result: (PLAN[part.sku] || {}).compare || "pass", reason: "Mock comparison." }; }
};
const getParts = () => store.mergeInto(structuredClone(catalog));
const bf = createBackfill({
  dataDir: DIR, store, ai: fake, getParts,
  manufacturers: (RAW.manufacturers || []).map((m) => ({ key: m.key, label: m.label || m.name || m.key })),
  fetchPage: async (u) => { if (!WEB[u]) throw Object.assign(new Error("404"), { status: 404 }); return { html: WEB[u], finalUrl: u }; },
  fetchImage: mockImage
});
await bf.load();
await bf.start({ skus: Object.keys(PLAN).map(String), autoApprove: true, label: "DEMO (mocked)" });
await bf.idle();
const g = await bf.applyGrouping();
const s = bf.status();
console.log(JSON.stringify({ dataDir: DIR, run: s.run.counts, catalog: s.catalog, autoLinked: g.applied.length, fittingsToConfirm: (await bf.fittingsToConfirm()).length }, null, 2));

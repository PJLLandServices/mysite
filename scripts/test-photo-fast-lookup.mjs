#!/usr/bin/env node
// Fast Product Lookup + image-quality gate (Patrick, Sep 28 2026; P-PJL-35).
//
// No network, no model. Fixtures modelled on SiteOne's real markup (search
// tiles, Product JSON-LD, an og:image thumbnail beside a __zoom gallery
// image) drive the real lookup, the real quality gate, the real store and
// the real runner. What it guards:
//
//   - the gate: <300px or blurry → never stored; <800px or soft → "low",
//     never Confident; ≥800 sharp → ok/good. Thresholds pinned.
//   - URL ranking: the larger member of a picture's family is tried before
//     its thumbnail URL; SiteOne's "image-thumb__N__zoom" is not a thumb.
//   - the store: a source larger than 1200px gets a 2000 copy and keeps its
//     original bytes; a small source is never upscaled; the 160/480/1200 set
//     and the square tile are unchanged; `full` URL only when the copy exists.
//   - the lookup: exact-code hits are chosen by title or slug, a description
//     hit must match type, every size (whole tokens: 2 in. ≠ 24 in.), ends
//     and material; the slug/JSON-LD code becomes "identified" only when the
//     page's visible text prints it.
//   - the runner: a fast-path hit makes NO finder call; a generic part with
//     one fast-path source gets exactly one finder pass (the last) for a
//     second source; a low-resolution best photo caps Confident at TBD with
//     the reason spelled out; a page whose only image is tiny records the
//     skip; the dry-run benchmark writes nothing to the stores, includes
//     live parts, skips grouping, and refuses any list but the plan's.
//
// Run: node scripts/test-photo-fast-lookup.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");

let ev, ai, bf, pp, pq, fl;
try {
  ev = require(path.join(ROOT, "server", "lib", "photo-evidence.js"));
  ai = require(path.join(ROOT, "server", "lib", "photo-ai.js"));
  bf = require(path.join(ROOT, "server", "lib", "photo-backfill.js"));
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
  pq = require(path.join(ROOT, "server", "lib", "photo-quality.js"));
  fl = require(path.join(ROOT, "server", "lib", "photo-fast-lookup.js"));
} catch (err) { console.log(`FAIL  modules could not be loaded: ${err.message}`); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pjl-fast-"));
const V = (over = {}) => Object.fromEntries(ev.VISION_KEYS.map((k) => [k, { result: over[k] || "pass", reason: "" }]));

// ---- images -----------------------------------------------------------------
// A sharp "product photo": plain background, textured subject in the middle.
const PNG = new Map();
async function photo(width, height, seedText = "x", { blur = 0 } = {}) {
  const key = `${width}x${height}|${seedText}|${blur}`;
  if (PNG.has(key)) return PNG.get(key);
  const h = crypto.createHash("sha256").update(seedText).digest();
  const channels = 3;
  const data = Buffer.alloc(width * height * channels, 245);
  const sx = Math.floor(width * 0.3), sy = Math.floor(height * 0.25), sw = Math.floor(width * 0.4), sh = Math.floor(height * 0.5);
  let seed = h.readUInt32LE(0) || 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24; };
  for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) { const i = (y * width + x) * channels; const v = rnd(); data[i] = v; data[i + 1] = 255 - v; data[i + 2] = (v * 7) & 255; }
  let img = sharp(data, { raw: { width, height, channels } });
  if (blur) img = img.blur(blur);
  const png = await img.png().toBuffer();
  PNG.set(key, png);
  return png;
}

// ---- 1. The gate ---------------------------------------------------------------
{
  const g = pq.gradeImage;
  check("gate: 96×96 → reject (too small)", g({ width: 96, height: 96, sharpness: 900 }).grade === "reject" && /too small/.test(g({ width: 96, height: 96 }).reason));
  check("gate: 299px → reject, 300px sharp → low", g({ width: 299, height: 200, sharpness: 500 }).grade === "reject" && g({ width: 300, height: 200, sharpness: 500 }).grade === "low");
  check("gate: 515px sharp → low (under 800), reason names the size", g({ width: 515, height: 515, sharpness: 400 }).grade === "low" && /515×515.*under 800/.test(g({ width: 515, height: 515, sharpness: 400 }).reason));
  check("gate: 800px sharp → ok; 1000px → good; 1600 → good", g({ width: 800, height: 600, sharpness: 300 }).grade === "ok" && g({ width: 1000, height: 1000, sharpness: 300 }).grade === "good" && g({ width: 1600, height: 1200, sharpness: 300 }).grade === "good");
  check("gate: the longest side counts (600×1200 is good)", g({ width: 600, height: 1200, sharpness: 300 }).grade === "good");
  check("gate: 1200px blurry (sharpness 8) → reject", g({ width: 1200, height: 1200, sharpness: 8 }).grade === "reject" && /blurry/.test(g({ width: 1200, height: 1200, sharpness: 8 }).reason));
  check("gate: 1200px soft (sharpness 80) → low, reason says soft focus", g({ width: 1200, height: 1200, sharpness: 80 }).grade === "low" && /soft focus/.test(g({ width: 1200, height: 1200, sharpness: 80 }).reason));
  check("gate: no sharpness reading → judged on size alone", g({ width: 1200, height: 900, sharpness: null }).grade === "good");
  check("gate: thresholds as agreed (800 / 1000 / 300)", pq.MIN_LONGEST === 800 && pq.GOOD_LONGEST === 1000 && pq.REJECT_LONGEST === 300);
  const conf = { tier: "confident", reason: "Part number on the product page and the photo matches." };
  check("cap: low quality turns Confident into TBD with the reason", pq.qualityCap(conf, g({ width: 515, height: 515, sharpness: 400 })).tier === "tbd" && /515×515/.test(pq.qualityCap(conf, g({ width: 515, height: 515, sharpness: 400 })).reason));
  check("cap: ok/good leave Confident alone; TBD/not confident untouched", pq.qualityCap(conf, g({ width: 900, height: 900, sharpness: 400 })).tier === "confident" && pq.qualityCap({ tier: "tbd", reason: "x" }, g({ width: 96, height: 96 })).tier === "tbd");

  // Measured sharpness on synthetic images: sharp texture vs the same
  // image blurred vs a 96px thumbnail blown up.
  const sharpPng = await photo(1000, 800, "s");
  const blurred = await photo(1000, 800, "s", { blur: 6 });
  const upscaled = await sharp(await sharp(sharpPng).resize(96, 77).png().toBuffer()).resize(1000, 800).png().toBuffer();
  const s1 = await pq.sharpnessOf(sharpPng, sharp), s2 = await pq.sharpnessOf(blurred, sharp), s3 = await pq.sharpnessOf(upscaled, sharp);
  check("sharpness: textured photo above the sharp line", s1 > pq.SHARP_MIN, `sharp=${s1.toFixed(0)}`);
  check("sharpness: heavily blurred copy falls under the blur line", s2 < pq.BLUR_REJECT, `blurred=${s2.toFixed(0)}`);
  check("sharpness: a 96px thumbnail blown up to 1000px reads as blurry", s3 < pq.BLUR_REJECT, `upscaled=${s3.toFixed(0)}`);
}

// ---- 2. URL ranking -------------------------------------------------------------
const SO = "https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/CA/Hunter/itemImage/246619";
const THUMB = `${SO}/image-thumb__246619__thumbnail/86012-1.3f0f6eeb/86012-1.3f0f6eeb.jpg`;
const PDP = `${SO}/image-thumb__246619__pdpIcon/86012-1.eb5e15f8/86012-1.eb5e15f8.jpg`;
const ZOOM = `${SO}/image-thumb__246619__zoom/86012-1.1432910b/86012-1.1432910b.jpg`;
const OTHER = "https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/Rain%20Bird/itemImage/249939/image-thumb__249939__thumbnail/90747-2.aa11bb22/90747-2.aa11bb22.jpg";
{
  check("family: the three SiteOne variants share one family key", pq.familyKeyOf(THUMB) === pq.familyKeyOf(ZOOM) && pq.familyKeyOf(ZOOM) === pq.familyKeyOf(PDP) && pq.familyKeyOf(ZOOM) === "86012-1", pq.familyKeyOf(ZOOM));
  check("family: a different item is a different family", pq.familyKeyOf(OTHER) !== pq.familyKeyOf(ZOOM));
  check("family: _800x800 / -large / @2x suffixes strip to the same picture", pq.familyKeyOf("https://x.com/i/pgv-100g_800x800.jpg") === pq.familyKeyOf("https://x.com/i/pgv-100g-large.jpg") && pq.familyKeyOf("https://x.com/i/pgv-100g@2x.jpg") === "pgv-100g");
  const hint = (u) => pq.imageUrlHints(u).sizeHint;
  check("hints: zoom > pdpIcon = thumbnail (the 'image-thumb' container word is ignored)", hint(ZOOM) > hint(PDP) && hint(THUMB) <= hint(PDP) && hint(THUMB) < 500, `${hint(ZOOM)} ${hint(PDP)} ${hint(THUMB)}`);
  check("hints: explicit dimensions win", hint("https://x.com/i/a_1600x1600.jpg") === 1600 && hint("https://x.com/i/w_640/a.jpg") === 640 && hint("https://x.com/i/a-96x96.jpg") === 96);
  check("hints: a URL that says nothing is 0", hint("https://x.com/i/a.jpg") === 0);
  const html = `<html><head><meta property="og:image" content="${THUMB}"></head><body>
    <img class="lazyOwl disable-zoom" width="200px" height="200px" data-src="${PDP}" data-zoom-image="${ZOOM}">
    <img class="product-tile" src="${OTHER}"><img src="https://www.siteone.com/logo.png"></body></html>`;
  const ranked = pq.rankImageUrls([{ url: THUMB, via: "og:image" }, { url: OTHER, via: "img" }], { html, pageUrl: "https://www.siteone.com/en/x/p/86012", max: 6, skip: ev.IMG_SKIP });
  check("rank: the zoom member comes before the og:image thumbnail it upgrades", ranked[0].url === ZOOM && ranked[0].upgradedFrom === THUMB && ranked[0].via === "og:image:larger", JSON.stringify(ranked.map((r) => r.url.slice(-40))));
  check("rank: the thumbnail itself stays as a fallback, after its larger kin", ranked.findIndex((r) => r.url === THUMB) > ranked.findIndex((r) => r.url === ZOOM));
  check("rank: another picture keeps its place; logos never appear", ranked.some((r) => r.url === OTHER) && !ranked.some((r) => /logo/.test(r.url)));
  check("collect: finds attribute, absolute and srcset image URLs, https only", pq.collectImageUrls(`<img srcset="/a-320w.jpg 320w, /a-1200w.jpg 1200w"><a href="http://x.com/plain.jpg">x</a><script>{"img":"https://cdn.x.com/p/img_2000x2000.jpg"}</script>`, "https://x.com/p").sort().join() === "https://cdn.x.com/p/img_2000x2000.jpg,https://x.com/a-1200w.jpg,https://x.com/a-320w.jpg");
}

// ---- 3. The store: full copy, original kept, never upscaled ------------------
{
  const big = await photo(1600, 1200, "big");
  const out = await pp.processImage(big, sharp);
  check("store: a 1600px source gets the 2000 copy at its own size (no upscale)", out.sizes.includes(2000) && (await sharp(out.variants[2000]).metadata()).width === 1600);
  check("store: the 160/480/1200 set is unchanged", [160, 480, 1200].every((s) => out.variants[s]) && (await sharp(out.variants[1200]).metadata()).width === 1200);
  check("store: source dimensions, sharpness and grade recorded", out.source.width === 1600 && out.source.height === 1200 && out.source.format === "png" && out.quality.grade === "good" && out.sharpness > pq.SHARP_MIN);
  check("store: the original bytes are kept as-is", out.orig && out.orig.ext === "png" && out.orig.buffer.equals(big));
  const small = await pp.processImage(await photo(1000, 800, "small"), sharp);
  check("store: a 1000px source has NO 2000 copy and no `full` URL", !small.sizes.includes(2000) && pp.photoUrls("a".repeat(64), { sizes: small.sizes }).full === null);
  check("store: `full` URL only when the 2000 copy exists", pp.photoUrls("a".repeat(64), { sizes: out.sizes }).full === `/api/part-photos/${"a".repeat(64)}/2000.webp` && pp.photoUrls("a".repeat(64)).full === null);
  const tiny = await pp.processImage(await sharp(await photo(1000, 800, "t")).resize(96, 77).png().toBuffer(), sharp);
  check("store: a 96px source is graded reject and every copy stays 96px (never enlarged)", tiny.quality.grade === "reject" && (await sharp(tiny.variants[1200]).metadata()).width === 96 && !tiny.sizes.includes(2000));
  check("store: 1200/2000 copies use the higher WebP quality", pp.LARGE_QUALITY >= 85);
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const saved = await store.saveCandidateImage(big);
  check("store: saveCandidateImage writes 2000.webp and orig.png beside the others and reports the quality", fs.existsSync(store.imagePath(saved.hash, 2000)) && fs.existsSync(path.join(dir, "part-photos", saved.hash, "orig.png")) && saved.imageSource.width === 1600 && saved.quality.grade === "good" && saved.sizes.includes(2000));
  const look = await store.inspect(await photo(515, 515, "pdp"));
  check("store: inspect() measures without saving", look.width === 515 && look.quality.grade === "low" && !fs.existsSync(path.join(dir, "part-photos", crypto.createHash("sha256").update(await photo(515, 515, "pdp")).digest("hex"))));
  // The thumbnail is derived from the source, not from a stored copy, and
  // the stored copies are untouched by it.
  const before1200 = fs.readFileSync(store.imagePath(saved.hash, 1200));
  for (const s of ["t160", "t320"]) fs.rmSync(store.imagePath(saved.hash, s));
  await store.ensureThumb(saved.hash, "t160");
  check("store: regenerating the tile leaves the 1200 and 2000 copies byte-identical", fs.readFileSync(store.imagePath(saved.hash, 1200)).equals(before1200) && fs.existsSync(store.imagePath(saved.hash, 2000)) && (await sharp(fs.readFileSync(store.imagePath(saved.hash, "t160"))).metadata()).width === 160);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4. The lookup on SiteOne-shaped fixtures ---------------------------------
const SEARCH = `<html><body>
  <a href="/search?text=HCPCM300">Result for &#034;HCPCM300&#034;</a>
  <a href="/pcm300-hunter-plug-in-expansion-module-pcm-300-for-pro-c-hpc-3-station/p/86012"></a>
  <a href="/pcm300-hunter-plug-in-expansion-module-pcm-300-for-pro-c-hpc-3-station/p/86012">3 Options</a>
  <a href="/pcm300-hunter-plug-in-expansion-module-pcm-300-for-pro-c-hpc-3-station/p/86012">Hunter Plug-In Expansion Module PCM-300 for Pro-C &amp; HPC 3 Station</a>
  <a href="/1401-007-poly-insert-tee-34-in-x-34-in-x-34-in/p/29419">Poly Insert Tee 3/4 in. x 3/4 in. x 3/4 in.</a>
  <a href="/5024pvcn-sch-80-pvc-nipple-12-in-x-24-in-mipt-threaded-both-ends/p/44791">Sch 80 PVC Nipple 1/2 in. x 24 in. MIPT Threaded Both Ends</a>
  <a href="/437-211-sch-40-pvc-reducer-bushing-flush-style-1-12-in-x-1-in-spigot-x-socket/p/112310">Sch 40 PVC Reducer Bushing Flush Style 1-1/2 in. x 1 in. Spigot x Socket</a>
</body></html>`;
const PAGE = `<html><head><title>PCM-300 | SiteOne</title><meta property="og:image" content="${THUMB}">
  <script type="application/ld+json">{"@context":"http://schema.org","@type":"Product","name":"Hunter Plug-In Expansion Module PCM-300 for Pro-C & HPC 3 Station","sku":"86012","mpn":"PCM-300","brand":{"@type":"Brand","name":"Hunter"},"image":"${PDP}"}</script></head>
  <body><header><nav><a href="/">Home</a></nav></header>
  <h1>Hunter Plug-In Expansion Module PCM-300 for Pro-C &amp; HPC 3 Station</h1>
  <img class="lazyOwl disable-zoom" width="200px" height="200px" data-src="${PDP}" data-zoom-image="${ZOOM}">
  <div class="specification"><div class="specHeading">Number of Stations</div><div class="specData">3 Stations</div></div>
  <div class="specification"><div class="specHeading">Station Type</div><div class="specData">Expansion</div></div>
  <div class="product-tile"><img class="product-tile-image" src="${OTHER}"></div>
  </body></html>`;
{
  const res = fl.siteone.parseResults(SEARCH);
  check("siteone: result tiles parsed once each, with the title (not '3 Options'), slug and code", res.length === 4 && res[0].title.startsWith("Hunter Plug-In") && res[0].slugCode === "pcm300" && res[1].slugCode === "1401" && res[1].slug.startsWith("1401-007-poly"));
  const n = fl.namesOurNumber;
  check("names: exact code in the slug (1401-007) matches our 1401-007", n(res[1], ["1401-007"]) && !n(res[1], ["1401-010"]));
  check("names: the supplier's code PCM300 opens the slug → a hit for HCPCM300's supplier key", n(res[0], ["HCPCM300", "PCM300"]) && !n(res[0], ["HCPCM900"]));
  check("names: a title token match counts too", n({ title: "Rain Bird R12H nozzle", slug: "rain-bird-nozzle", slugCode: "rain" }, ["R12H"]));
  check("names: nothing under 4 characters ever matches", !n({ title: "12Q", slug: "12q-x", slugCode: "12q" }, ["12Q"]));
  const t = fl.titleMatchesSpec;
  const nipple = { description: 'PVC 0.5" × 2" MxM TBE nipple', size: '0.5"' };
  check("spec: 1/2 in. x 24 in. nipple does NOT match our 1/2 x 2 (whole-token sizes)", !t("Sch 80 PVC Nipple 1/2 in. x 24 in. MIPT Threaded Both Ends", nipple));
  check("spec: 1/2 in. x 2 in. PVC nipple matches", t("Sch 80 PVC Nipple 1/2 in. x 2 in. MIPT Threaded Both Ends", nipple));
  const tee = { description: "Poly insert tee 3/4\"", size: '0.75"' };
  check("spec: poly insert tee 3/4 matches the SiteOne title; a PVC tee does not (material)", t("Poly Insert Tee 3/4 in. x 3/4 in. x 3/4 in.", tee) && !t("Sch 40 PVC Tee 3/4 in. Socket", tee));
  check("spec: a different size never matches", !t("Poly Insert Tee 1 in. x 1 in. x 1 in.", tee));
  check("query: description → supplier-friendly words with sizes as 'x in.'", fl.descriptionQuery(nipple) === "PVC 1/2 in. x 2 in. MxM TBE nipple" && fl.descriptionQuery({ description: "Poly Pipe 3/4 in. x 400 ft. Non-NSF 100 PSI (price per roll)" }) === "Poly Pipe 3/4 in. x 400 ft. Non-NSF 100 PSI");
  const ld = fl.productJsonLd(PAGE);
  check("page: Product JSON-LD read (name, sku, brand, image)", ld && ld.sku === "86012" && ld.brand === "Hunter" && ld.image === PDP);
  check("page: title from <h1>, spec rows from heading/data pairs", fl.pageTitle(PAGE).startsWith("Hunter Plug-In") && fl.pageSpecs(PAGE).some((r) => r.label === "Number of Stations" && r.value === "3 Stations"));

  // The lookup end to end on a fake web.
  const WEB = {
    "https://www.siteone.com/en/search?text=HCPCM300": SEARCH.replace(/<a href="\/1401[\s\S]*?<\/a>\s*<a href="\/5024[\s\S]*?<\/a>\s*<a href="\/437[\s\S]*?<\/a>/, ""),
    "https://www.siteone.com/en/search?text=PCM300": SEARCH,
    "https://www.siteone.com/en/pcm300-hunter-plug-in-expansion-module-pcm-300-for-pro-c-hpc-3-station/p/86012": PAGE
  };
  const fetches = [];
  const lookup = fl.createFastLookup({ fetchPage: async (u) => { fetches.push(u); if (!WEB[u]) throw new Error("The page couldn't be read (HTTP 404)."); return { html: WEB[u], finalUrl: u }; } });
  const part = { sku: "HCPCM300", partNumber: "HCPCM300", description: "Pro-C 3-station expansion module", manufacturer: "hunter", manufacturerLabel: "Hunter", category: "controllers", supplierSkus: ["PCM300"] };
  const out = await lookup.lookup(part, { kind: "branded" });
  check("lookup: one product page, chosen from the exact-code search, with ranked images (zoom first)", out.candidates.length === 1 && out.candidates[0].pageUrl.endsWith("/p/86012") && out.candidates[0].images[0].url === ZOOM && out.candidates[0].images.length <= 4, JSON.stringify(out.candidates[0] && out.candidates[0].images.map((i) => i.url.slice(-30))));
  check("lookup: the page's supplier sku, title and specs come along", out.candidates[0].supplierSku === "86012" && /PCM-300/.test(out.candidates[0].title) && out.candidates[0].specs.length === 2 && out.candidates[0].partNumberAsShown === "PCM300");
  check("lookup: an mpn that is simply one of OUR numbers (the supplier code PCM300) is not 'identified'", out.identified === null);
  const plain = fl.createFastLookup({ fetchPage: async (u) => { const html = WEB[u]; if (!html) throw new Error("HTTP 404"); return { html, finalUrl: u }; } });
  const out3 = await plain.lookup({ ...part, supplierSkus: [] }, { kind: "branded" });
  check("lookup: the JSON-LD mpn becomes 'identified' when the page's visible text prints it and it isn't ours", out3.candidates.length === 1 && out3.identified && out3.identified.manufacturerPartNumber === "PCM-300" && out3.identified.manufacturer === "Hunter", JSON.stringify(out3.identified));
  const noMpnText = fl.createFastLookup({ fetchPage: async (u) => { const html = WEB[u]; if (!html) throw new Error("HTTP 404"); return { html: u.endsWith("/p/86012") ? html.replace('"mpn":"PCM-300"', '"mpn":"PCM-300-XYZ"') : html, finalUrl: u }; } });
  const out2 = await noMpnText.lookup({ ...part, supplierSkus: [] }, { kind: "branded" });
  check("lookup: an mpn the visible text does NOT print is not 'identified'", out2.candidates.length === 1 && out2.identified === null);
  check("lookup: stops after the first hit — one search, one page", fetches.length === 2, JSON.stringify(fetches));
  check("lookup: sources report their status (SupplyHouse blocked, Central no catalog)", out.sources.find((s) => s.id === "supplyhouse").status === "blocked" && out.sources.find((s) => s.id === "centralpros").status === "unavailable" && out.sources.find((s) => s.id === "siteone").status === "ok");
  const miss = await lookup.lookup({ sku: "NOPE1", partNumber: "NOPE1", description: "Widget", manufacturer: "", supplierSkus: [] }, { kind: "generic" });
  check("lookup: a miss says so and records each search", miss.candidates.length === 0 && miss.notes.some((n) => /no product page found/.test(n)) && miss.searches.length >= 1 && miss.searches[0].fetch === "failed");
}

// ---- 5. The runner: fast path, gate, cap, dry run ------------------------------
const PRODUCT = "https://www.siteone.com/en/pcm300-hunter-plug-in-expansion-module-pcm-300-for-pro-c-hpc-3-station/p/86012";
const TEE_PAGE = "https://www.siteone.com/en/1401-007-poly-insert-tee-34-in-x-34-in-x-34-in/p/29419";
const TEE_IMG = "https://www.siteone.com/medias/tee/image-thumb__1__zoom/29419-1.abc/29419-1.abc.jpg";
const TEE_SMALL = "https://www.siteone.com/medias/tee/image-thumb__1__thumbnail/29419-1.def/29419-1.def.jpg";
const LOW_PAGE = "https://www.siteone.com/en/lowres-hunter-thing/p/555";
const LOW_IMG = "https://www.siteone.com/medias/low/image-thumb__2__zoom/555-1.abc/555-1.abc.jpg";
const TINY_PAGE = "https://www.siteone.com/en/tiny-hunter-thing/p/777";
const OPEN_WEB = "https://www.plumbing-example.com/tee-34";
const IMAGES = {
  [ZOOM]: [1200, 1000], [PDP]: [515, 515], [THUMB]: [96, 96], [OTHER]: [96, 96],
  [TEE_IMG]: [1000, 1000], [TEE_SMALL]: [96, 96], [LOW_IMG]: [515, 515],
  "https://www.siteone.com/medias/tiny/image-thumb__3__thumbnail/777-1.abc/777-1.abc.jpg": [96, 96],
  "https://img.plumbing-example.com/tee.jpg": [900, 900]
};
const teePage = (img, small) => `<html><head><meta property="og:image" content="${small}"></head><body><h1>Poly Insert Tee 3/4 in. x 3/4 in. x 3/4 in. insert barb</h1><img class="lazyOwl disable-zoom" width="200px" height="200px" data-src="${small}" data-zoom-image="${img}"></body></html>`;
const WEB = {
  "https://www.siteone.com/en/search?text=HCPCM300": SEARCH,
  "https://www.siteone.com/en/search?text=PCM300": SEARCH,
  [PRODUCT]: PAGE,
  "https://www.siteone.com/en/search?text=1401-007": SEARCH,
  [TEE_PAGE]: teePage(TEE_IMG, TEE_SMALL),
  "https://www.siteone.com/en/search?text=LOWRES1": `<a href="/lowres-hunter-thing/p/555">Hunter LOWRES1 thing</a>`,
  [LOW_PAGE]: `<html><body><h1>Hunter LOWRES1 thing</h1><img class="product-image" src="${LOW_IMG}"></body></html>`,
  "https://www.siteone.com/en/search?text=TINY1": `<a href="/tiny-hunter-thing/p/777">Hunter TINY1 thing</a>`,
  [TINY_PAGE]: `<html><body><h1>Hunter TINY1 thing</h1><img class="product-image" src="https://www.siteone.com/medias/tiny/image-thumb__3__thumbnail/777-1.abc/777-1.abc.jpg"></body></html>`,
  [OPEN_WEB]: `<html><body><h1>3/4" poly insert tee, barbed</h1><img class="product" src="https://img.plumbing-example.com/tee.jpg"></body></html>`
};
const CATALOG = {
  HCPCM300: { sku: "HCPCM300", partNumber: "HCPCM300", description: "Pro-C 3-station expansion module", category: "controllers", manufacturer: "hunter", supplierPrices: { "SUP-002": { supplierSku: "PCM300" } } },
  "1401-007": { sku: "1401-007", partNumber: "1401-007", description: "Poly insert tee 3/4\"", category: "fittings", manufacturer: "", size: "0.75\"" },
  LOWRES1: { sku: "LOWRES1", partNumber: "LOWRES1", description: "Hunter LOWRES1 thing", category: "valves", manufacturer: "hunter" },
  TINY1: { sku: "TINY1", partNumber: "TINY1", description: "Hunter TINY1 thing", category: "valves", manufacturer: "hunter" },
  NOWHERE: { sku: "NOWHERE", partNumber: "NOWHERE", description: "Hunter unlisted thing", category: "valves", manufacturer: "hunter" }
};
function harness(dir, over = {}) {
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const catalog = over.catalog || CATALOG;
  const counts = { find: {}, verify: {}, compare: {}, pages: 0, images: 0, afterRun: 0 };
  const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
  const fake = {
    passesFor: ai.passesFor,
    async find(part, pass, usage) {
      inc(counts.find, part.sku); (counts.findPasses ||= {})[part.sku] = [...((counts.findPasses || {})[part.sku] || []), pass];
      if (usage) usage({ input_tokens: 150000, output_tokens: 3000, server_tool_use: { web_search_requests: 4, web_fetch_requests: 2 } });
      if (part.sku === "1401-007" && pass === 3) return { manufacturer: "", manufacturerPartNumber: "", notes: "open web", candidates: [{ pageUrl: OPEN_WEB, imageUrl: "", partNumberAsShown: "" }] };
      return { manufacturer: "", manufacturerPartNumber: "", notes: "nothing", candidates: [] };
    },
    async verify(part, bytes, mt, usage) { inc(counts.verify, part.sku); if (usage) usage({ input_tokens: 2500, output_tokens: 200 }); return V(); },
    async compare(part, a, b, mt, usage) { inc(counts.compare, part.sku); if (usage) usage({ input_tokens: 4000, output_tokens: 100 }); return { result: "pass", reason: "same tee" }; }
  };
  const fetchPage = async (u) => { counts.pages++; if (!WEB[u]) throw new Error("The page couldn't be read (HTTP 404)."); return { html: WEB[u], finalUrl: u }; };
  const fast = fl.createFastLookup({ fetchPage });
  let clock = 1_000_000;
  const b = bf.createBackfill({
    dataDir: dir, store, ai: fake, fastLookup: over.noFast ? null : fast,
    getParts: () => store.mergeInto(structuredClone(catalog)),
    manufacturers: [{ key: "hunter", label: "Hunter" }],
    fetchPage,
    fetchImage: async (u) => { counts.images++; const d = IMAGES[u]; if (!d) throw new Error("The image couldn't be downloaded (HTTP 404)."); return { buffer: await photo(d[0], d[1], u), finalUrl: u }; },
    now: () => clock, sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    afterRun: async () => { counts.afterRun++; },
    finderDefault: true // this suite exercises the finder fallback; the engine default is off (Patrick, Sep 28 2026)
  });
  return { b, store, counts, parts: () => store.mergeInto(structuredClone(catalog)), catalog };
}
{
  const dir = tmp();
  const h = harness(dir);
  await h.b.start({ skus: ["HCPCM300", "1401-007", "LOWRES1", "TINY1", "NOWHERE"], autoApprove: false }); await h.b.idle();
  const run = h.b._state().run;
  const it = run.items.HCPCM300;
  check("fast hit: NO finder call for the branded part", !h.counts.find.HCPCM300 && it.work.found.via === "fast" && it.work.found.candidates[0].pass === 0 && it.work.found.candidates[0].via === "fast:siteone");
  check("fast hit: the zoom image was saved (1200×1000, good); the thumbnail and pdpIcon of the same picture were not downloaded", it.work.checked.filter((c) => c.hash).length === 1 && it.work.checked[0].imageSource.width === 1200 && it.work.checked[0].quality.grade === "good" && it.work.checked[0].source.imageUrl === ZOOM && it.work.checked[0].source.upgradedFrom === THUMB, JSON.stringify(it.work.checked.map((c) => [c.source.imageUrl.slice(-30), c.imageSource])));
  check("fast hit: the related-product thumbnail on the page was measured and skipped, and the page says so", it.work.pages[0].skipped === 1 && /1 image skipped: too small \(96×96/.test(it.work.pages[0].note), it.work.pages[0].note);
  check("fast hit: supplier code on the page → part number pass → Confident (held for review, auto-approve off)", it.result.tier === "confident" && it.result.live === false && it.result.via === "fast" && h.counts.verify.HCPCM300 === 1);
  check("fast hit: usage counts one supplier search, two pages (search + product, the product page read once), two image downloads, one Claude call, no web searches", it.usage.fastSearches === 1 && it.usage.pageFetches === 2 && it.usage.imageFetches === 2 && it.usage.calls === 1 && it.usage.in === 2500 && it.usage.searches === 0, JSON.stringify(it.usage));
  check("fast hit: wall time recorded", typeof it.ms === "number" && it.ms >= 0 && it.startedAt && it.finishedAt);
  const tee = run.items["1401-007"];
  check("generic with one fast-path source: exactly ONE finder pass, the last (open web), for a second source", h.counts.find["1401-007"] === 1 && JSON.stringify(h.counts.findPasses["1401-007"]) === "[3]" && tee.work.found.via === "fast+ai");
  check("generic: fast-path page + open-web page → spec, photo and second source agree → Confident", tee.result.tier === "confident" && tee.work.cross.result === "pass" && tee.work.checked.filter((c) => c.hash).length === 2 && h.counts.compare["1401-007"] === 1);
  const low = run.items.LOWRES1;
  check("quality cap: every check passed but the only photo is 515px → TBD, reason names the size", low.result.tier === "tbd" && low.result.qualityCapped === true && /515×515/.test(low.result.reason) && /needs|needed/.test(low.result.reason), low.result.reason);
  check("quality cap: the low candidate is kept for review, graded low", low.work.tier.candidates.length === 1 && low.work.tier.candidates[0].quality.grade === "low" && low.work.tier.candidates[0].tier === "tbd");
  const tiny = run.items.TINY1;
  check("tiny only: nothing stored, no vision call → Needs research, and the reason says the image was skipped as too small", tiny.result.tier === "needs_research" && !h.counts.verify.TINY1 && /too small \(96×96/.test(tiny.result.reason) && tiny.work.pages[0].images === 0 && tiny.work.pages[0].skipped === 1, tiny.result.reason);
  const none = run.items.NOWHERE;
  check("fast miss: the finder runs its passes as before (1 then 2) and the notes say the fast path found nothing", JSON.stringify(h.counts.findPasses.NOWHERE) === "[1,2]" && none.work.found.via === "ai" && none.work.found.notes[0].startsWith("fast path:"));
  const st = h.b.status().run;
  check("status: the fast-path split and per-part timing are on the run", st.fast.hits === 3 && st.fast.fastAndAi === 1 && st.fast.aiOnly === 1 && st.timing.parts === 5, JSON.stringify(st.fast));
  const s = h.store.readStoresSync();
  const g = s.groups[s.links.HCPCM300.groupId];
  check("store: the candidate carries source dims, sizes and grade; the review card can show them", g.candidates[0].imageSource.width === 1200 && g.candidates[0].quality.grade === "good" && Array.isArray(g.candidates[0].sizes));
  // Approving it keeps the quality facts on the photo.
  await h.store.approveCandidate("HCPCM300", h.parts().HCPCM300, g.candidates[0].hash, { by: "patrick" });
  const merged = h.parts();
  check("approve: the live photo reports its source size and grade and no `full` (source ≤1200)", merged.HCPCM300.photo.source.width === 1200 && merged.HCPCM300.photo.quality.grade === "good" && merged.HCPCM300.photo.full === null && merged.HCPCM300.photo.large.endsWith("/1200.webp"));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Without a fast lookup the runner behaves exactly as before.
  const dir = tmp();
  const h = harness(dir, { noFast: true });
  await h.b.start({ skus: ["HCPCM300"], autoApprove: false }); await h.b.idle();
  const it = h.b._state().run.items.HCPCM300;
  check("no fast lookup injected: finder passes 1 and 2 run, nothing found → needs research, via 'ai'", JSON.stringify(h.counts.findPasses.HCPCM300) === "[1,2]" && it.result.tier === "needs_research" && it.work.found.via === "ai" && !it.work.fast);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // The dry-run benchmark.
  const dir = tmp();
  const h = harness(dir);
  await rejects("benchmark: a part no run has processed is refused", () => h.b.startBenchmark({ by: "patrick", skus: ["HCPCM300", "1401-007"] }), /no earlier run processed it/);
  // Process them once (a normal run), so they qualify — then HCPCM300 goes
  // live (Patrick's upload), as the wave parts did on production, so the
  // benchmark has a live part to compare against.
  await h.b.start({ skus: ["HCPCM300", "1401-007", "LOWRES1", "TINY1"], autoApprove: false }); await h.b.idle();
  await h.store.setPhoto("HCPCM300", h.catalog.HCPCM300, await photo(1000, 800, "patrick"), { by: "patrick", source: { method: "upload" } });
  const before = JSON.stringify(h.store.readStoresSync());
  const afterRunBefore = h.counts.afterRun;
  const plan = h.b.benchmarkPlan({ skus: ["HCPCM300", "1401-007", "LOWRES1"] });
  check("benchmark plan: rows say which are live and processed; dry run, auto-approve off", plan.dryRun === true && plan.autoApprove === false && plan.rows.find((r) => r.sku === "HCPCM300").live === true && plan.rows.find((r) => r.sku === "HCPCM300").processedBefore === true && plan.problems.length === 0 && plan.fastSources.length === 4);
  await rejects("benchmark: a list in a different order is refused", () => h.b.startBenchmark({ by: "patrick", skus: ["1401-007", "HCPCM300", "LOWRES1"] }), /differs from the plan/);
  await rejects("benchmark: an extra part that no run processed is refused", () => h.b.startBenchmark({ by: "patrick", skus: [...plan.skus, "NOWHERE"] }), /no earlier run processed it/);
  check("benchmark plan: the list is canonical (agreed order, then alphabetical) whatever order was asked", JSON.stringify(h.b.benchmarkPlan({ skus: ["LOWRES1", "1401-007", "HCPCM300"] }).skus) === JSON.stringify(plan.skus));
  await rejects("benchmark: a part outside the catalog is refused", () => h.b.startBenchmark({ by: "patrick", skus: ["GHOST"] }), /not in the catalog/);
  check("…and none of those started anything", h.b._state().run.status === "done");
  await h.b.startBenchmark({ by: "patrick", skus: plan.skus });
  const run = h.b._state().run;
  check("benchmark: dry run flagged, auto-approve off, the LIVE part is included (not skipped)", run.options.dryRun === true && run.options.autoApprove === false && run.benchmark.skus.length === 3 && run.order.includes("HCPCM300"));
  await h.b.idle();
  check("benchmark: every part ran to a verdict, the live one too", run.items.HCPCM300.result.tier === "confident" && run.items.HCPCM300.result.dryRun === true && run.items.HCPCM300.result.tier !== "skipped" && run.items.LOWRES1.result.qualityCapped === true);
  check("benchmark: NOTHING changed in the photo stores", JSON.stringify(h.store.readStoresSync()) === before);
  check("benchmark: grouping / catalog rebuild did not run", h.counts.afterRun === afterRunBefore);
  const st = h.b.status().run;
  check("benchmark: the report rows carry path, verdict, chosen photo size + grade, usage and seconds", st.benchmark.rows.length === 3 && st.benchmark.rows.every((r) => r.via && r.tier && typeof r.ms === "number" && r.usage) && st.benchmark.rows.find((r) => r.sku === "HCPCM300").chosen.imageSource.width === 1200 && st.benchmark.rows.find((r) => r.sku === "HCPCM300").livePhoto.width === 1000);
  check("benchmark: the baseline is the earlier (non-dry) run's usage split", st.benchmark.baseline && st.benchmark.baseline.usageByKind && st.benchmark.baseline.runId !== run.id);
  const plan2 = h.b.wavePlan();
  check("benchmark parts stay excluded from the next wave (already processed)", !plan2.skus.some((s) => plan.skus.includes(s)));
  check("the live photo Patrick set is untouched by the benchmark", h.parts().HCPCM300.photo.approvedBy === "patrick" && h.parts().HCPCM300.photo.source.width === 1000);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-photo-fast-lookup: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

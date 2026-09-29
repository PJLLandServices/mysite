#!/usr/bin/env node
// Quality upgrade of live photos (Patrick, Sep 28 2026; P-PJL-35).
//
// No network, no model. A fake web serves a SiteOne-shaped product page
// whose og:image is a 96px thumbnail and whose gallery carries the 1200px
// zoom of the SAME picture. What it guards:
//
//   - only a live photo under the threshold is considered; ≥800px is left alone
//   - deterministic = same page, same picture family, measured larger, sharp,
//     and PROVEN the same picture (similarity); it is stored, not made live
//   - review = uploaded photo (no page), page without a larger copy, a larger
//     copy that is a different picture, or one that is still too small
//   - apply takes exactly the list shown; it moves the photo hash and NOTHING
//     else: tier, approvedBy/At, links, fitting, AI result all unchanged; the
//     old hash goes to the history; source keeps its page and records the
//     upgrade; a photo changed since the plan is skipped, never overwritten
//   - never upscaled: a 1000px zoom stays 1000px, no 2000 copy
//   - "keep as is" removes a row from the review queue
//
// Run: node scripts/test-photo-quality-upgrade.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");

let pp, pq, qu;
try {
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
  pq = require(path.join(ROOT, "server", "lib", "photo-quality.js"));
  qu = require(path.join(ROOT, "server", "lib", "photo-quality-upgrade.js"));
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pjl-quality-"));

// One "picture" per seed at 1200px; smaller sizes are RESIZED from it, so
// they really are the same picture (as SiteOne's variants are).
const BASE = new Map();
async function base(seed) {
  if (BASE.has(seed)) return BASE.get(seed);
  const width = 1200, height = 1200, channels = 3;
  const h = crypto.createHash("sha256").update(seed).digest();
  const data = Buffer.alloc(width * height * channels, 250);
  let s = h.readUInt32LE(0) || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
  // A few big blocks of colour plus a textured band — enough structure for
  // a correlation to mean something at 24×24.
  const blocks = 6;
  for (let by = 0; by < blocks; by++) for (let bx = 0; bx < blocks; bx++) {
    const c = [rnd(), rnd(), rnd()];
    if ((bx + by) % 3 === 0) continue;
    for (let y = 150 + by * 150; y < 150 + by * 150 + 140; y++) for (let x = 150 + bx * 150; x < 150 + bx * 150 + 140; x++) { const i = (y * width + x) * channels; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
  }
  for (let y = 60; y < 110; y++) for (let x = 60; x < 1140; x++) { const i = (y * width + x) * channels; const v = rnd(); data[i] = v; data[i + 1] = v; data[i + 2] = v; }
  const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  BASE.set(seed, png);
  return png;
}
const sized = async (seed, px) => sharp(await base(seed)).resize(px, px).jpeg({ quality: 90 }).toBuffer();

const SO = "https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/CA/X/itemImage/1";
// (SiteOne's real mid-size copy is "__pdpIcon", which the shared skip list
// drops as an icon — so a 515px copy that IS considered needs a neutral
// variant name here.)
const fam = (id) => ({
  thumb: `${SO}/image-thumb__1__thumbnail/${id}-1.aaaa1111/${id}-1.aaaa1111.jpg`,
  pdp: `${SO}/image-thumb__1__medium/${id}-1.bbbb2222/${id}-1.bbbb2222.jpg`,
  zoom: `${SO}/image-thumb__1__zoom/${id}-1.cccc3333/${id}-1.cccc3333.jpg`
});
const A = fam("86012"), B = fam("29419"), C = fam("55555"), D = fam("77777"), E = fam("99999");
const page = (f, { zoom = true, pdp = false } = {}) => `<html><head><meta property="og:image" content="${f.thumb}"></head><body><h1>x</h1>
  <img class="lazyOwl disable-zoom" width="200px" height="200px" data-src="${pdp ? f.pdp : f.thumb}"${zoom ? ` data-zoom-image="${f.zoom}"` : ""}></body></html>`;
const PAGES = {
  "https://www.siteone.com/en/a/p/1": page(A),                       // upgrade: zoom is the same picture
  "https://www.siteone.com/en/b/p/2": page(B, { zoom: false }),      // review: no larger copy
  "https://www.siteone.com/en/c/p/3": page(C),                       // review: zoom is a DIFFERENT picture
  "https://www.siteone.com/en/d/p/4": page(D, { zoom: false, pdp: true }), // review: only a 515px copy
  "https://www.siteone.com/en/e/p/5": page(E)                        // upgrade: zoom only 1000px → never upscaled
};
const IMAGES = {
  [A.thumb]: ["a", 96], [A.zoom]: ["a", 1200],
  [B.thumb]: ["b", 96],
  [C.thumb]: ["c", 96], [C.zoom]: ["other", 1200],
  [D.thumb]: ["d", 96], [D.pdp]: ["d", 515],
  [E.thumb]: ["e", 96], [E.zoom]: ["e", 1000]
};

async function harness(dir) {
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const catalog = {
    A1: { sku: "A1", partNumber: "A1", description: "Module A" }, A2: { sku: "A2", partNumber: "A2", description: "Module A (alt code)" },
    B1: { sku: "B1", partNumber: "B1", description: "Tee B" }, C1: { sku: "C1", partNumber: "C1", description: "Elbow C" },
    D1: { sku: "D1", partNumber: "D1", description: "Nipple D" }, E1: { sku: "E1", partNumber: "E1", description: "Valve E" },
    U1: { sku: "U1", partNumber: "U1", description: "Uploaded U" }, BIG: { sku: "BIG", partNumber: "BIG", description: "Already fine" }
  };
  const parts = () => store.mergeInto(structuredClone(catalog));
  const fetches = { pages: 0, images: 0 };
  const q = qu.createQualityUpgrade({
    dataDir: dir, store, sharp, getParts: parts,
    fetchPage: async (u) => { fetches.pages++; if (!PAGES[u]) throw new Error("The page couldn't be read (HTTP 404)."); return { html: PAGES[u], finalUrl: u }; },
    fetchImage: async (u) => { fetches.images++; const d = IMAGES[u]; if (!d) throw new Error("The image couldn't be downloaded (HTTP 404)."); return { buffer: await sized(d[0], d[1]), finalUrl: u }; }
  });
  // Live photos as the AI + Patrick's approval leave them: an ai-reviewed
  // group keeps the candidate's page and image URL as its source.
  async function liveFromPage(sku, seed, px, f, pageUrl) {
    const saved = await store.saveCandidateImage(await sized(seed, px));
    await store.recordAiResult(sku, catalog[sku], { tier: "tbd", kind: "generic", reason: "x", runId: "R1", candidates: [{ hash: saved.hash, width: saved.width, height: saved.height, sizes: saved.sizes, imageSource: saved.imageSource, quality: saved.quality, source: { pageUrl, imageUrl: f.thumb, domain: "www.siteone.com", pass: 2, official: false, imageVia: "og:image" }, checks: {}, tier: "tbd" }], chosen: 0 });
    await store.approveCandidate(sku, catalog[sku], saved.hash, { by: "Patrick Lalande" });
    return saved.hash;
  }
  const hashes = {};
  hashes.A = await liveFromPage("A1", "a", 96, A, "https://www.siteone.com/en/a/p/1");
  const { links } = await store.snapshot();
  await store.linkToGroup("A2", catalog.A2, links.A1.groupId, { by: "Patrick Lalande" }); // A2 shares the fitting
  hashes.B = await liveFromPage("B1", "b", 96, B, "https://www.siteone.com/en/b/p/2");
  hashes.C = await liveFromPage("C1", "c", 96, C, "https://www.siteone.com/en/c/p/3");
  hashes.D = await liveFromPage("D1", "d", 96, D, "https://www.siteone.com/en/d/p/4");
  hashes.E = await liveFromPage("E1", "e", 96, E, "https://www.siteone.com/en/e/p/5");
  await store.setPhoto("U1", catalog.U1, await sized("u", 447), { by: "Patrick Lalande", source: { method: "upload" } });
  await store.setPhoto("BIG", catalog.BIG, await sized("big", 1000), { by: "Patrick Lalande", source: { method: "upload" } });
  return { store, q, parts, catalog, hashes, fetches };
}

// ---- similarity ---------------------------------------------------------------
{
  const s1 = await qu.similarity(await sized("a", 96), await sized("a", 1200), sharp);
  const s2 = await qu.similarity(await sized("a", 96), await sized("other", 1200), sharp);
  check("similarity: the same picture at 96px and 1200px correlates strongly", s1 >= qu.SIMILARITY_MIN, `sim=${s1.toFixed(3)}`);
  check("similarity: a different picture does not", s2 < qu.SIMILARITY_MIN, `sim=${s2.toFixed(3)}`);
}

// ---- the plan -------------------------------------------------------------------
const dir = tmp();
const h = await harness(dir);
{
  const before = await h.store.snapshot();
  const cands = await h.q.candidates();
  check("candidates: the six live photos under 800px, not the 1000px one", cands.length === 6 && !cands.some((c) => c.skus.includes("BIG")), JSON.stringify(cands.map((c) => c.skus)));
  check("candidates: a shared fitting lists both SKUs once", cands.find((c) => c.skus.includes("A1")).skus.join() === "A1,A2");
  const plan = await h.q.buildPlan({ by: "patrick" });
  check("plan: done, six rows, two deterministic upgrades, four for review", plan.plan.status === "done" && plan.counts.planned === 6 && plan.counts.upgrade === 2 && plan.counts.review === 4, JSON.stringify(plan.counts));
  const row = (sku) => [...plan.upgrades, ...plan.review].find((r) => r.skus.includes(sku));
  const a = row("A1");
  check("A: upgrade — same family, same picture, 1200×1200 good, stored as a candidate image (not live)", a.decision === "upgrade" && a.upgrade.source.width === 1200 && a.upgrade.quality.grade === "good" && a.upgrade.similarity >= qu.SIMILARITY_MIN && a.upgrade.imageUrl === A.zoom && fs.existsSync(h.store.imagePath(a.upgrade.hash, 1200)), JSON.stringify(a));
  check("A: the live photo is still the 96px one after planning", (await h.store.snapshot()).groups[a.groupId].photo.hash === h.hashes.A);
  const e = row("E1");
  check("E: upgrade to the 1000px zoom — kept at 1000px, no 2000 copy (never upscaled)", e.decision === "upgrade" && e.upgrade.source.width === 1000 && !e.upgrade.sizes.includes(2000) && e.upgrade.quality.grade === "good");
  check("B: review — the page exposes no larger copy", row("B1").decision === "review" && /no larger copy/.test(row("B1").reason), row("B1").reason);
  check("C: review — the larger copy is a different picture (similarity below the line)", row("C1").decision === "review" && /doesn't match/.test(row("C1").reason), row("C1").reason);
  check("D: review — the only larger copy is 515px, still low", row("D1").decision === "review" && /still low resolution/.test(row("D1").reason), row("D1").reason);
  check("U: review — uploaded by hand, no page on record", row("U1").decision === "review" && /uploaded by hand/.test(row("U1").reason));
  check("plan: the stores are untouched by planning", JSON.stringify(await h.store.snapshot()) === JSON.stringify(before));
  check("plan: fetch budget — one page per photo with a page (5), at most a few images", h.fetches.pages === 5 && h.fetches.images >= 4 && h.fetches.images <= 8, JSON.stringify(h.fetches));
}

// ---- apply ------------------------------------------------------------------------
{
  const s = await h.q.summary();
  const expected = s.upgrades.map((r) => r.upgrade.hash);
  await rejects("apply: a list in another order is refused", () => h.q.apply({ by: "patrick", hashes: [...expected].reverse() }), /differs from the plan/);
  await rejects("apply: a shortened list is refused", () => h.q.apply({ by: "patrick", hashes: expected.slice(0, 1) }), /differs from the plan/);
  const before = await h.store.snapshot();
  const gA = before.groups[s.upgrades.find((r) => r.skus.includes("A1")).groupId];
  const out = await h.q.apply({ by: "patrick", hashes: expected });
  check("apply: both upgrades applied, nothing skipped", out.applied.length === 2 && out.skipped.length === 0, JSON.stringify(out));
  const after = await h.store.snapshot();
  const gA2 = after.groups[gA.id];
  const a = s.upgrades.find((r) => r.skus.includes("A1"));
  check("A: the photo is now the 1200px copy with its size and grade", gA2.photo.hash === a.upgrade.hash && gA2.photo.source.width === 1200 && gA2.photo.quality.grade === "good" && gA2.photo.width === 1200);
  check("A: tier, approvedBy, approvedAt, AI result and label are exactly as before", gA2.tier === gA.tier && gA2.approvedBy === "Patrick Lalande" && gA2.approvedAt === gA.approvedAt && JSON.stringify(gA2.ai) === JSON.stringify(gA.ai) && gA2.label === gA.label && JSON.stringify(gA2.review) === JSON.stringify(gA.review));
  check("A: links (both SKUs, fingerprints, link tiers, first-linked order) untouched", JSON.stringify(after.links) === JSON.stringify(before.links));
  check("A: the old hash is in the history as a quality upgrade", gA2.history.some((x) => x.hash === h.hashes.A && x.replacedBy === "quality-upgrade" && x.by === "patrick"));
  check("A: source keeps its page and method, points at the larger image, records what it was upgraded from", gA2.source.pageUrl === gA.source.pageUrl && gA2.source.method === "ai-reviewed" && gA2.source.imageUrl === A.zoom && gA2.source.upgradedFrom.hash === h.hashes.A && gA2.source.upgradedFrom.imageUrl === A.thumb);
  const merged = h.parts();
  check("A: the catalog shows the new size on both SKUs of the fitting, still verified, still Patrick's", merged.A1.photoState === "verified" && merged.A2.photoState === "verified" && merged.A1.photo.width === 1200 && merged.A2.photo.width === 1200 && merged.A1.photo.approvedBy === "Patrick Lalande" && merged.A1.photo.full === null && merged.A1.photo.quality.grade === "good");
  check("A: the old files stay on disk (content-addressed, in the history)", fs.existsSync(h.store.imagePath(h.hashes.A, 1200)));
  const gE = after.groups[s.upgrades.find((r) => r.skus.includes("E1")).groupId];
  check("E: 1000px copy live, no upscale anywhere", gE.photo.source.width === 1000 && gE.photo.width === 1000 && !(gE.photo.sizes || []).includes(2000));
  const s2 = await h.q.summary();
  check("after apply: no deterministic upgrade left, both rows marked applied, review rows unchanged", s2.upgrades.length === 0 && s2.counts.applied === 2 && s2.review.length === 4);
  await rejects("apply again: nothing left", () => h.q.apply({ by: "patrick", hashes: [] }), /no deterministic upgrades/);
}

// ---- a photo that changed since the plan is skipped, never overwritten ----------
{
  const dir2 = tmp();
  const h2 = await harness(dir2);
  const plan = await h2.q.buildPlan({ by: "patrick" });
  const a = plan.upgrades.find((r) => r.skus.includes("A1"));
  // Patrick uploads his own photo for A1 after the plan was built.
  await h2.store.setPhoto("A1", h2.catalog.A1, await sized("patrick", 900), { by: "Patrick Lalande", source: { method: "upload" } });
  const s = await h2.q.summary();
  check("changed photo: the row drops out of the applicable list", !s.upgrades.some((r) => r.groupId === a.groupId));
  // Even a stale list sent straight to the store is refused.
  const res = await h2.store.upgradePhotoQuality(a.groupId, { fromHash: a.current.hash, to: a.upgrade, imageUrl: a.upgrade.imageUrl, by: "patrick" });
  check("changed photo: the store skips the upgrade instead of overwriting Patrick's upload", res.skipped && /changed since/.test(res.skipped) && (await h2.store.snapshot()).groups[a.groupId].source.method === "upload");
  // Keep as is.
  const b = plan.review.find((r) => r.skus.includes("B1"));
  await h2.q.resolveReview(b.groupId, { action: "keep", by: "patrick" });
  const s3 = await h2.q.summary();
  check("keep as is: the row leaves the review queue; the photo is untouched", !s3.review.some((r) => r.groupId === b.groupId) && (await h2.store.snapshot()).groups[b.groupId].photo.hash === h2.hashes.B);
  await rejects("keep as is: only review rows can be kept", () => h2.q.resolveReview("PG-9999", { action: "keep", by: "patrick" }), /isn't in the quality review queue/);
  // A restart reads the plan back from disk.
  const q3 = qu.createQualityUpgrade({ dataDir: dir2, store: h2.store, sharp, getParts: h2.parts, fetchPage: async () => { throw new Error("no"); }, fetchImage: async () => { throw new Error("no"); } });
  const s4 = await q3.summary();
  check("restart: the plan and the kept row survive on disk", s4.plan && s4.plan.id === plan.plan.id && !s4.review.some((r) => r.groupId === b.groupId) && s4.upgrades.length === 1);
  fs.rmSync(dir2, { recursive: true, force: true });
}
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\ntest-photo-quality-upgrade: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

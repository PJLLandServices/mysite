#!/usr/bin/env node
// Resolution restoration of stored photos (Patrick, Sep 28 + Oct 1 2026;
// P-PJL-35). No network, no model. A fake web serves SiteOne-shaped pages
// whose og:image is a 96px thumbnail and whose gallery carries the 1200px
// zoom of the SAME picture.
//
// THE RULE under test (photo-quality-upgrade.restorationDecision): a stored
// image under 800px is restored to a larger copy only when that copy is on
// the same stored source page, in the same picture family, ≥ 800px, has
// strictly more native pixels, and correlates ≥ 0.98 with the stored image.
// On that path a soft or blurry grade does not block — it is recorded.
//
// What it guards:
//   - live photos AND the review candidates the Review tab shows are covered
//   - the seven audited candidates (111BC ×2, 205120 ×3, TLCOUP ×2), with the
//     soft and the blurry one, all restore 96 → 1200 and keep their tier,
//     their evidence checks, their order, their group's tier/reason/AI result
//   - a TBD candidate stays TBD; a Not-confident one stays Not confident
//   - correlation under 0.98 → held for review, never automatic
//   - different family, different source page, under 800px, not strictly
//     more pixels → no restoration; nothing is ever enlarged by us
//   - apply takes exactly the list shown; a record changed since the plan is
//     skipped, never overwritten
//   - no model, no finder, no web search: only the stored pages are read
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

let pp, pq, qu, review;
try {
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
  pq = require(path.join(ROOT, "server", "lib", "photo-quality.js"));
  qu = require(path.join(ROOT, "server", "lib", "photo-quality-upgrade.js"));
  review = require(path.join(ROOT, "server", "lib", "photo-review.js"));
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
const clone = (o) => JSON.parse(JSON.stringify(o));

// One "picture" per seed at 1200px; every other size is RESIZED from it, so
// the sizes really are the same picture (as SiteOne's variants are).
const BASE = new Map();
async function base(seed) {
  if (BASE.has(seed)) return BASE.get(seed);
  const width = 1200, height = 1200, channels = 3;
  const h = crypto.createHash("sha256").update(seed).digest();
  const data = Buffer.alloc(width * height * channels, 250);
  let s = h.readUInt32LE(0) || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
  for (let by = 0; by < 6; by++) for (let bx = 0; bx < 6; bx++) {
    const c = [rnd(), rnd(), rnd()];
    if ((bx + by) % 3 === 0) continue;
    for (let y = 150 + by * 150; y < 150 + by * 150 + 140; y++) for (let x = 150 + bx * 150; x < 150 + bx * 150 + 140; x++) { const i = (y * width + x) * channels; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
  }
  for (let y = 60; y < 110; y++) for (let x = 60; x < 1140; x++) { const i = (y * width + x) * channels; const v = rnd(); data[i] = v; data[i + 1] = v; data[i + 2] = v; }
  const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  BASE.set(seed, png);
  return png;
}
// spec: [seed, px, { blur, pad }]. blur 2 = "soft" (edge ~75), blur 5 =
// "blurry" (edge ~21) at 1200px; pad 0.02 = the picture inside a padded
// square, which drops the correlation with the unpadded original to ~0.95
// (the Rain Bird store's canvas thumbnails).
const MADE = new Map();
async function make([seed, px, opt = {}]) {
  const key = JSON.stringify([seed, px, opt]);
  if (MADE.has(key)) return MADE.get(key);
  let b = await base(seed);
  if (opt.blur) b = await sharp(b).blur(opt.blur).png().toBuffer();
  let out;
  if (opt.pad) {
    const inner = Math.round(px * (1 - 2 * opt.pad));
    out = await sharp({ create: { width: px, height: px, channels: 3, background: "#ffffff" } }).composite([{ input: await sharp(b).resize(inner, inner).toBuffer(), left: Math.round((px - inner) / 2), top: Math.round((px - inner) / 2) }]).jpeg({ quality: 90 }).toBuffer();
  } else out = await sharp(b).resize(px, px).jpeg({ quality: 90 }).toBuffer();
  MADE.set(key, out);
  return out;
}

const SO = "https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/CA/X/itemImage/1";
// (SiteOne's real mid-size copy is "__pdpIcon", which the shared skip list
// drops as an icon — so a mid-size copy that IS considered needs a neutral
// variant name here.)
const fam = (id) => ({
  thumb: `${SO}/image-thumb__1__thumbnail/${id}.aaaa1111/${id}.aaaa1111.jpg`,
  mid: `${SO}/image-thumb__1__medium/${id}.bbbb2222/${id}.bbbb2222.jpg`,
  zoom: `${SO}/image-thumb__1__zoom/${id}.cccc3333/${id}.cccc3333.jpg`
});
const P = (slug, n) => `https://www.siteone.com/en/${slug}/p/${n}`;
const page = (...imgs) => `<html><head><meta property="og:image" content="${imgs[0]}"></head><body><h1>x</h1>${imgs.slice(1).map((u, i) => `<img class="lazyOwl disable-zoom" width="200px" height="200px" data-src="${imgs[0]}" data-zoom-image="${u}" id="i${i}">`).join("")}</body></html>`;

// ---- live fixtures -----------------------------------------------------------
const A = fam("86012-1"), B = fam("29419-1"), C = fam("55555-1"), D = fam("77777-1"), E = fam("99999-1"),
  S = fam("41000-1"), Y = fam("42000-1"), H = fam("43000-1"), X = fam("44000-1"), F = fam("45000-1"), FOTHER = fam("45999-9"), G = fam("46000-1");
// ---- the seven audited review candidates ------------------------------------
const C111a = fam("550020004431-sss"), C111b = fam("29191-1");
const C205a = fam("755483-1"), C205b = fam("101777-1"), C205c = fam("101777-2");
const CTLa = fam("drip-micro-93933-1-891123"), CTLb = fam("93933-1");
const CNC = fam("60000-1");
const PG = {
  a: P("a", 1), b: P("b", 2), c: P("c", 3), d: P("d", 4), e: P("e", 5), s: P("s", 6), y: P("y", 7), h: P("h", 8), x: P("x", 9), xOther: P("x-other", 10), f: P("f", 11), g: P("g", 12),
  p111: P("111bc-nds-standard-valve-box-round-10-in", 29191), p205a: P("p-12-12-nipple-molded-tbe", 755483), p205b: P("5012pvcn-sch-80-pvc-nipple", 101777), ptl: P("tlcoup-netafim-techline-insert-coupling-17-mm", 93933), pnc: P("nc", 60000)
};
const PAGES = {
  [PG.a]: page(A.thumb, A.zoom),                 // restore
  [PG.b]: page(B.thumb),                         // review: no larger copy
  [PG.c]: page(C.thumb, C.zoom),                 // review: zoom is a DIFFERENT picture
  [PG.d]: page(D.thumb, D.mid),                  // review: only a 515px copy (under 800)
  [PG.e]: page(E.thumb, E.zoom),                 // restore: zoom is 1000px → never upscaled
  [PG.s]: page(S.thumb, S.zoom),                 // restore: zoom is SOFT, same picture
  [PG.y]: page(Y.thumb, Y.zoom),                 // restore: zoom is BLURRY, same picture
  [PG.h]: page(H.thumb, H.zoom),                 // held: padded thumb vs unpadded zoom → match ~0.95
  [PG.x]: page(X.thumb),                         // the stored page has no larger copy…
  [PG.xOther]: page(X.thumb, X.zoom),            // …another page does: never read
  [PG.f]: page(F.thumb, FOTHER.zoom),            // the same picture at 1200px, but under ANOTHER family name
  [PG.g]: page(G.thumb, G.zoom),                 // the "zoom" has no more pixels than the thumbnail
  [PG.p111]: page(C111b.thumb, C111b.zoom, C111a.zoom) + `<img class="product-image" src="${C111a.thumb}">`,
  [PG.p205a]: page(C205a.thumb, C205a.zoom),
  [PG.p205b]: page(C205b.thumb, C205b.zoom, C205c.zoom) + `<img class="product-image" src="${C205c.thumb}">`,
  [PG.ptl]: page(CTLb.thumb, CTLb.zoom, CTLa.zoom) + `<img class="product-image" src="${CTLa.thumb}">`,
  [PG.pnc]: page(CNC.thumb, CNC.zoom)
};
const IMAGES = {
  [A.thumb]: ["a", 96], [A.zoom]: ["a", 1200],
  [B.thumb]: ["b", 96],
  [C.thumb]: ["c", 96], [C.zoom]: ["other", 1200],
  [D.thumb]: ["d", 96], [D.mid]: ["d", 515],
  [E.thumb]: ["e", 96], [E.zoom]: ["e", 1000],
  [S.thumb]: ["s", 96], [S.zoom]: ["s", 1200, { blur: 2 }],
  [Y.thumb]: ["y", 96], [Y.zoom]: ["y", 1200, { blur: 5 }],
  [H.thumb]: ["h", 96, { pad: 0.02 }], [H.zoom]: ["h", 1200],
  [X.thumb]: ["x", 96], [X.zoom]: ["x", 1200],
  [F.thumb]: ["f", 96], [FOTHER.zoom]: ["f", 1200],
  [G.thumb]: ["g", 96], [G.zoom]: ["g", 96],
  [C111a.thumb]: ["111-drawing", 96], [C111a.zoom]: ["111-drawing", 1200],
  [C111b.thumb]: ["111-photo", 96], [C111b.zoom]: ["111-photo", 1200],
  [C205a.thumb]: ["205-a", 96], [C205a.zoom]: ["205-a", 1200],
  [C205b.thumb]: ["205-b", 96], [C205b.zoom]: ["205-b", 1200, { blur: 2 }],   // the SOFT one (audit: edge 72)
  [C205c.thumb]: ["205-c", 96], [C205c.zoom]: ["205-c", 1200],
  [CTLa.thumb]: ["tl-a", 96], [CTLa.zoom]: ["tl-a", 1200],
  [CTLb.thumb]: ["tl-b", 96], [CTLb.zoom]: ["tl-b", 1200, { blur: 5 }],       // the BLURRY one (audit: edge 28)
  [CNC.thumb]: ["nc", 96], [CNC.zoom]: ["nc", 1200]
};
const VISION_FAIL = { productShot: { result: "fail", reason: "a dimension drawing" } };
const CHECKS = (extra = {}) => ({ partNumber: { result: "pass", reason: "", matched: "X" }, specMatch: { result: "pass", reason: "" }, vision: { size: { result: "unknown", reason: "" }, ...extra }, crossSource: { result: "unknown", reason: "No second, independent source." } });
// [sku, groupTier, [[family, pageUrl, candidateTier, checks]…]] — as the runs left them.
const REVIEW = [
  ["111BC", "tbd", [[C111a, PG.p111, "not_confident", CHECKS(VISION_FAIL)], [C111b, PG.p111, "tbd", CHECKS()]]],
  ["205120", "tbd", [[C205a, PG.p205a, "not_confident", CHECKS(VISION_FAIL)], [C205b, PG.p205b, "not_confident", CHECKS(VISION_FAIL)], [C205c, PG.p205b, "tbd", CHECKS()]]],
  ["TLCOUP", "tbd", [[CTLa, PG.ptl, "tbd", CHECKS()], [CTLb, PG.ptl, "tbd", CHECKS()]]],
  ["NC1", "not_confident", [[CNC, PG.pnc, "not_confident", CHECKS(VISION_FAIL)]]]
];

async function harness(dir) {
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const catalog = {};
  for (const s of ["A1", "A2", "B1", "C1", "D1", "E1", "S1", "Y1", "H1", "X1", "F1", "G1", "U1", "BIG", "111BC", "205120", "TLCOUP", "NC1"]) catalog[s] = { sku: s, partNumber: s, description: `Part ${s}` };
  const parts = () => store.mergeInto(structuredClone(catalog));
  const fetched = { pages: [], images: [] };
  const q = qu.createQualityUpgrade({
    dataDir: dir, store, sharp, getParts: parts,
    fetchPage: async (u) => { fetched.pages.push(u); if (!PAGES[u]) throw new Error("The page couldn't be read (HTTP 404)."); return { html: PAGES[u], finalUrl: u }; },
    fetchImage: async (u) => { fetched.images.push(u); const d = IMAGES[u]; if (!d) throw new Error("The image couldn't be downloaded (HTTP 404)."); return { buffer: await make(d), finalUrl: u }; }
  });
  const candOf = async (f, pageUrl, tier, checks) => {
    const saved = await store.saveCandidateImage(await make(IMAGES[f.thumb]));
    return { hash: saved.hash, width: saved.width, height: saved.height, sizes: saved.sizes, imageSource: saved.imageSource, sharpness: saved.sharpness, quality: saved.quality, source: { pageUrl, imageUrl: f.thumb, domain: "www.siteone.com", pass: 2, official: false, imageVia: "og:image" }, checks, tier };
  };
  // A live photo as the AI + Patrick's approval leave it.
  async function liveFromPage(sku, f, pageUrl) {
    const c = await candOf(f, pageUrl, "tbd", CHECKS());
    await store.recordAiResult(sku, catalog[sku], { tier: "tbd", kind: "generic", reason: "x", runId: "R1", candidates: [c], chosen: 0 });
    await store.approveCandidate(sku, catalog[sku], c.hash, { by: "Patrick Lalande" });
    return c.hash;
  }
  const hashes = {};
  hashes.A = await liveFromPage("A1", A, PG.a);
  await store.linkToGroup("A2", catalog.A2, (await store.snapshot()).links.A1.groupId, { by: "Patrick Lalande" });
  for (const [sku, f, pg] of [["B1", B, PG.b], ["C1", C, PG.c], ["D1", D, PG.d], ["E1", E, PG.e], ["S1", S, PG.s], ["Y1", Y, PG.y], ["H1", H, PG.h], ["X1", X, PG.x], ["F1", F, PG.f], ["G1", G, PG.g]]) hashes[sku] = await liveFromPage(sku, f, pg);
  await store.setPhoto("U1", catalog.U1, await make(["u", 447]), { by: "Patrick Lalande", source: { method: "upload" } });
  await store.setPhoto("BIG", catalog.BIG, await make(["big", 1000]), { by: "Patrick Lalande", source: { method: "upload" } });
  // The review candidates, exactly as a run records them (not approved).
  hashes.review = {};
  for (const [sku, groupTier, cands] of REVIEW) {
    const list = [];
    for (const [f, pg, tier, checks] of cands) list.push(await candOf(f, pg, tier, checks));
    await store.recordAiResult(sku, catalog[sku], { tier: groupTier, kind: "generic", reason: groupTier === "tbd" ? "Some checks couldn't be confirmed — needs a look." : "Not confident: the photo doesn't match (productShot).", runId: "R2", identified: { manufacturer: "NDS", manufacturerPartNumber: sku }, candidates: list, chosen: list.length - 1, pages: [{ url: cands[0][1], domain: "www.siteone.com", fetch: "ok", partNumber: "pass", images: list.length }] });
    hashes.review[sku] = list.map((c) => c.hash);
  }
  return { store, q, parts, catalog, hashes, fetched };
}

// ---- 1. the rule, as a table ------------------------------------------------------
{
  const d = (cur, prop, sim) => qu.restorationDecision({ current: { width: cur, height: cur }, proposed: { width: prop[0], height: prop[1], quality: prop[2] || pq.gradeImage({ width: prop[0], height: prop[1], sharpness: 300 }) }, similarity: sim });
  check("rule: 96 → 1200, match 0.999 → restore", d(96, [1200, 1200], 0.999).restore === true);
  check("rule: the line is exactly 0.98 — 0.98 restores, 0.979 is held, never automatic", d(96, [1200, 1200], 0.98).restore === true && d(96, [1200, 1200], 0.979).restore === false && d(96, [1200, 1200], 0.979).held === true && qu.RESTORE_SIMILARITY_MIN === 0.98);
  check("rule: under 0.85 is simply not the same picture (not held)", d(96, [1200, 1200], 0.75).restore === false && d(96, [1200, 1200], 0.75).held === false);
  check("rule: proposed 799px → no; 800px → yes", d(96, [799, 799], 0.999).restore === false && /under 800/.test(d(96, [799, 799], 0.999).reason) && d(96, [800, 600], 0.999).restore === true);
  check("rule: not strictly more native pixels → no", d(700, [700, 700], 1).restore === false && /not larger/.test(d(700, [700, 700], 1).reason));
  check("rule: a stored image already ≥ 800px is never touched", d(800, [1200, 1200], 1).restore === false);
  const soft = pq.gradeImage({ width: 1200, height: 1200, sharpness: 70 }), blurry = pq.gradeImage({ width: 1200, height: 1200, sharpness: 20 });
  check("rule: a SOFT or BLURRY larger original still restores — and the reason says so", soft.grade === "low" && blurry.grade === "reject" && d(96, [1200, 1200, soft], 0.999).restore === true && /soft, recorded/.test(d(96, [1200, 1200, soft], 0.999).reason) && d(96, [1200, 1200, blurry], 0.999).restore === true && /blurry, recorded/.test(d(96, [1200, 1200, blurry], 0.999).reason));
  check("the quality gate itself is unchanged: a blurry NEW image is still a reject, a soft one still caps Confident", blurry.grade === "reject" && pq.qualityCap({ tier: "confident", reason: "x" }, soft).tier === "tbd");
  // fixtures behave as calibrated
  const s1 = await qu.similarity(await make(["a", 96]), await make(["a", 1200]), sharp);
  const s2 = await qu.similarity(await make(["c", 96]), await make(["other", 1200]), sharp);
  const s3 = await qu.similarity(await make(["h", 96, { pad: 0.02 }]), await make(["h", 1200]), sharp);
  const s4 = await qu.similarity(await make(["tl-b", 96]), await make(["tl-b", 1200, { blur: 5 }]), sharp);
  check("fixtures: same picture ≥ 0.98; different picture < 0.85; padded thumbnail in between; blurry original still ≥ 0.98", s1 >= 0.98 && s2 < 0.85 && s3 >= 0.85 && s3 < 0.98 && s4 >= 0.98, [s1, s2, s3, s4].map((x) => x.toFixed(3)).join(" "));
  const gSoft = (await pp.inspectImage(await make(["205-b", 1200, { blur: 2 }]), sharp)).quality.grade, gBlur = (await pp.inspectImage(await make(["tl-b", 1200, { blur: 5 }]), sharp)).quality.grade;
  check("fixtures: the soft zoom grades 'low', the blurry zoom grades 'reject'", gSoft === "low" && gBlur === "reject", `${gSoft} ${gBlur}`);
}

// ---- 2. the plan --------------------------------------------------------------------
const dir = tmp();
const h = await harness(dir);
const before = await h.store.snapshot();
const plan = await h.q.buildPlan({ by: "patrick" });
const row = (sku, hash) => [...plan.upgrades, ...plan.review].find((r) => r.skus.includes(sku) && (!hash || r.current.hash === hash));
{
  check("plan: BIG (1000px) and anything ≥ 800px is not considered", ![...plan.upgrades, ...plan.review].some((r) => r.skus.includes("BIG")));
  check("plan: 12 live photos + 8 review candidates under 800px were examined", plan.counts.planned === 20 && plan.counts.live.upgrade + plan.counts.live.review === 12 && plan.counts.candidates.upgrade + plan.counts.candidates.review === 8, JSON.stringify(plan.counts));
  check("plan: live — A, E, S, Y restore; B, C, D, U, H, X, F, G need a look", ["A1", "E1", "S1", "Y1"].every((s) => row(s).decision === "upgrade") && ["B1", "C1", "D1", "U1", "H1", "X1", "F1", "G1"].every((s) => row(s).decision === "review") && plan.counts.live.upgrade === 4 && plan.counts.live.review === 8);
  check("plan: all seven audited candidates restore (111BC ×2, 205120 ×3, TLCOUP ×2), plus the Not-confident group's one", plan.counts.candidates.upgrade === 8 && plan.counts.candidates.review === 0 && h.hashes.review["111BC"].every((x) => row("111BC", x).decision === "upgrade") && h.hashes.review["205120"].every((x) => row("205120", x).decision === "upgrade") && h.hashes.review["TLCOUP"].every((x) => row("TLCOUP", x).decision === "upgrade") && row("NC1").decision === "upgrade");
  check("plan: every restoration is 96 → 1200 (E: → 1000) with match ≥ 0.98", plan.upgrades.every((r) => r.current.longest === 96 && r.upgrade.similarity >= 0.98 && r.upgrade.source.width >= 800) && row("E1").upgrade.source.width === 1000);
  check("plan: the soft and blurry originals are in — grade recorded as measured (live S/Y, candidates 205120 b / TLCOUP b)", row("S1").upgrade.quality.grade === "low" && row("Y1").upgrade.quality.grade === "reject" && row("205120", h.hashes.review["205120"][1]).upgrade.quality.grade === "low" && row("TLCOUP", h.hashes.review.TLCOUP[1]).upgrade.quality.grade === "reject" && /soft, recorded/.test(row("S1").reason) && /blurry, recorded/.test(row("Y1").reason));
  check("H: match under 0.98 → HELD for review with the larger copy kept for the look, not restored", row("H1").decision === "review" && row("H1").held && row("H1").held.similarity >= 0.85 && row("H1").held.similarity < 0.98 && /held for your eye/.test(row("H1").reason) && !row("H1").upgrade, JSON.stringify(row("H1").held && row("H1").held.similarity));
  check("C: a different picture → no restoration, not held", row("C1").decision === "review" && !row("C1").held && /doesn't match/.test(row("C1").reason), row("C1").reason);
  check("D: the only larger copy is 515px → no restoration", row("D1").decision === "review" && /still under 800 px \(515×515\)/.test(row("D1").reason), row("D1").reason);
  check("G: a 'larger' copy with no more pixels → no restoration", row("G1").decision === "review" && /not larger than the stored image/.test(row("G1").reason), row("G1").reason);
  check("F: the same picture under a DIFFERENT family name on the page → not considered", row("F1").decision === "review" && /no larger copy of this picture/.test(row("F1").reason) && !h.fetched.images.includes(FOTHER.zoom));
  check("X: the larger copy lives on a DIFFERENT page → never read, no restoration", row("X1").decision === "review" && !h.fetched.pages.includes(PG.xOther) && !h.fetched.images.includes(X.zoom));
  check("U: uploaded by hand → no page on record → review", row("U1").decision === "review" && /uploaded by hand/.test(row("U1").reason));
  check("B: the page exposes no larger copy → review", row("B1").decision === "review" && /no larger copy/.test(row("B1").reason));
  check("plan: only the stored source pages were read — nothing searched, nothing else fetched", h.fetched.pages.every((u) => Object.values(PG).includes(u) && u !== PG.xOther) && h.fetched.pages.length === new Set(h.fetched.pages).size + (h.fetched.pages.length - new Set(h.fetched.pages).size));
  check("plan: building it changed nothing in the stores", JSON.stringify(await h.store.snapshot()) === JSON.stringify(before));
  const src = fs.readFileSync(path.join(ROOT, "server", "lib", "photo-quality-upgrade.js"), "utf8");
  check("no model: the module has no AI client, finder or web-search code at all", !/require\(["']\.\/photo-ai["']\)|anthropic|web_search|\.find\(part|ai\.(find|verify|compare)/i.test(src));
  check("candidate rows carry what must stay: the candidate's tier and the group's tier", row("111BC", h.hashes.review["111BC"][0]).current.candidateTier === "not_confident" && row("111BC", h.hashes.review["111BC"][1]).current.candidateTier === "tbd" && row("NC1").current.groupTier === "not_confident" && row("111BC").kind === "candidate" && row("A1").kind === "live");
}

// ---- 3. apply: only the image changes -------------------------------------------------
{
  const s = await h.q.summary();
  const expected = s.upgrades.map((r) => r.upgrade.hash);
  await rejects("apply: a list in another order is refused", () => h.q.apply({ by: "patrick", hashes: [...expected].reverse() }), /differs from the plan/);
  await rejects("apply: a shortened list is refused", () => h.q.apply({ by: "patrick", hashes: expected.slice(0, 3) }), /differs from the plan/);
  const b4 = await h.store.snapshot();
  const partsBefore = h.parts();
  const queuesBefore = review.buildReviewQueues({ parts: partsBefore, groups: b4.groups, links: b4.links });
  const out = await h.q.apply({ by: "patrick", hashes: expected });
  check("apply: 4 live + 8 candidate restorations, nothing skipped", out.applied.length === 12 && out.skipped.length === 0 && out.applied.filter((a) => a.kind === "live").length === 4 && out.applied.filter((a) => a.kind === "candidate").length === 8, JSON.stringify(out.skipped));
  const after = await h.store.snapshot();
  const partsAfter = h.parts();
  check("apply: links (every SKU's group, fingerprint, tier, order) are untouched", JSON.stringify(after.links) === JSON.stringify(b4.links));

  // The seven audited candidates + the Not-confident group's one.
  let allKept = true, allRestored = true, detail = "";
  for (const [sku, groupTier, cands] of REVIEW) {
    const gid = after.links[sku].groupId, g0 = b4.groups[gid], g1 = after.groups[gid];
    if (g1.tier !== groupTier || g1.tier !== g0.tier || g1.reason !== g0.reason || JSON.stringify(g1.ai) !== JSON.stringify(g0.ai) || g1.updatedAt !== g0.updatedAt || JSON.stringify(g1.photo || null) !== JSON.stringify(g0.photo || null) || g1.approvedBy !== g0.approvedBy) { allKept = false; detail += ` group ${sku}`; }
    if (g1.candidates.length !== g0.candidates.length) { allKept = false; detail += ` count ${sku}`; }
    for (let i = 0; i < cands.length; i++) {
      const c0 = g0.candidates[i], c1 = g1.candidates[i], zoom = cands[i][0].zoom;
      if (c1.tier !== c0.tier || c1.tier !== cands[i][2] || JSON.stringify(c1.checks) !== JSON.stringify(c0.checks) || c1.runId !== c0.runId || c1.foundAt !== c0.foundAt || c1.forSku !== c0.forSku || c1.source.pageUrl !== c0.source.pageUrl || c1.source.pass !== c0.source.pass || c1.source.domain !== c0.source.domain) { allKept = false; detail += ` cand ${sku}#${i}`; }
      if (c1.hash === c0.hash || c1.imageSource.width !== 1200 || c1.width !== 1200 || c1.source.imageUrl !== zoom || c1.source.restoredFrom.hash !== c0.hash || c1.source.restoredFrom.width !== 96 || !fs.existsSync(h.store.imagePath(c1.hash, 1200))) { allRestored = false; detail += ` img ${sku}#${i}`; }
    }
    if (partsAfter[sku].photoState !== partsBefore[sku].photoState || partsAfter[sku].photoState !== groupTier || partsAfter[sku].photo !== null) { allKept = false; detail += ` state ${sku}`; }
  }
  check("candidates: 111BC ×2, 205120 ×3, TLCOUP ×2 (+NC1) are now 1200×1200, restored from their 96px thumbnails", allRestored, detail);
  check("candidates: tier, evidence checks, order, run, source page, the group's tier/reason/AI result/updatedAt and the part's state are all exactly as before", allKept, detail);
  const g205 = after.groups[after.links["205120"].groupId], gtl = after.groups[after.links.TLCOUP.groupId], g111 = after.groups[after.links["111BC"].groupId];
  check("candidates: the soft one records 'low' and the blurry one records 'reject' — restored anyway, grade kept", g205.candidates[1].quality.grade === "low" && gtl.candidates[1].quality.grade === "reject" && g205.candidates[1].imageSource.width === 1200 && gtl.candidates[1].imageSource.width === 1200);
  check("111BC: the dimension drawing is 1200×1200 now and STILL Not confident; the product photo is still To be determined", g111.candidates[0].tier === "not_confident" && g111.candidates[0].checks.vision.productShot.result === "fail" && g111.candidates[0].imageSource.width === 1200 && g111.candidates[1].tier === "tbd" && partsAfter["111BC"].photoState === "tbd");
  check("NC1: a Not-confident part stays Not confident, in the Not-confident queue", partsAfter.NC1.photoState === "not_confident" && after.groups[after.links.NC1.groupId].tier === "not_confident");
  const queuesAfter = review.buildReviewQueues({ parts: partsAfter, groups: after.groups, links: after.links });
  check("review queues: same cards in the same queues, same candidate order and tiers — only the images are larger", JSON.stringify(queuesAfter.tbd.map((c) => [c.sku, c.tier, c.aiTier, c.reason, c.candidates.map((x) => [x.tier, JSON.stringify(x.checks)])])) === JSON.stringify(queuesBefore.tbd.map((c) => [c.sku, c.tier, c.aiTier, c.reason, c.candidates.map((x) => [x.tier, JSON.stringify(x.checks)])])) && JSON.stringify(queuesAfter.notConfident.map((c) => c.sku)) === JSON.stringify(queuesBefore.notConfident.map((c) => c.sku)) && queuesAfter.needsResearch.length === queuesBefore.needsResearch.length);
  const card111 = queuesAfter.tbd.find((c) => c.sku === "111BC");
  check("review card: shows the source size, the grade and that it was restored from the thumbnail", card111.candidates.every((c) => c.imageSource.width === 1200 && c.quality && c.source.restoredFrom && c.source.restoredFrom.width === 96));

  // Live photos.
  const gA0 = b4.groups[after.links.A1.groupId], gA = after.groups[after.links.A1.groupId];
  check("live A: 1200px photo; tier, approvedBy, approvedAt, AI result, review record unchanged; old hash in the history", gA.photo.source.width === 1200 && gA.tier === gA0.tier && gA.approvedBy === "Patrick Lalande" && gA.approvedAt === gA0.approvedAt && JSON.stringify(gA.ai) === JSON.stringify(gA0.ai) && JSON.stringify(gA.review) === JSON.stringify(gA0.review) && gA.history.some((x) => x.hash === h.hashes.A && x.replacedBy === "quality-upgrade") && gA.source.pageUrl === gA0.source.pageUrl && gA.source.upgradedFrom.hash === h.hashes.A);
  check("live A: both SKUs of the fitting show it, still verified, still Patrick's", partsAfter.A1.photo.width === 1200 && partsAfter.A2.photo.width === 1200 && partsAfter.A1.photoState === "verified" && partsAfter.A1.photo.approvedBy === "Patrick Lalande");
  const gS = after.groups[after.links.S1.groupId], gY = after.groups[after.links.Y1.groupId];
  check("live S and Y: soft and blurry originals restored to 1200px, grade recorded on the photo, approval untouched", gS.photo.source.width === 1200 && gS.photo.quality.grade === "low" && gY.photo.source.width === 1200 && gY.photo.quality.grade === "reject" && gS.approvedBy === "Patrick Lalande" && gY.tier === b4.groups[after.links.Y1.groupId].tier);
  check("live H, C, D, F, X, G, B, U: untouched", ["H1", "C1", "D1", "F1", "X1", "G1", "B1", "U1"].every((s) => JSON.stringify(after.groups[after.links[s].groupId]) === JSON.stringify(b4.groups[after.links[s].groupId])));
  // Never enlarged by us: no stored copy of a restored image is wider than its native width.
  let neverEnlarged = true;
  for (const r of s.upgrades) {
    const native = r.upgrade.source.width;
    for (const size of [160, 480, 1200, 2000]) { const p = h.store.imagePath(r.upgrade.hash, size); if (p && fs.existsSync(p) && (await sharp(fs.readFileSync(p)).metadata()).width > native) neverEnlarged = false; }
  }
  const gE = after.groups[after.links.E1.groupId];
  check("never upscaled: every stored copy is at most the native size (E stays 1000px, no 2000 copy)", neverEnlarged && gE.photo.source.width === 1000 && gE.photo.width === 1000 && !(gE.photo.sizes || []).includes(2000));
  const s2 = await h.q.summary();
  check("after apply: nothing left to apply, 12 rows marked applied, the 8 review rows unchanged", s2.upgrades.length === 0 && s2.counts.applied === 12 && s2.review.length === 8);
  await rejects("apply again: nothing left", () => h.q.apply({ by: "patrick", hashes: [] }), /no deterministic upgrades/);
  check("apply: still only the stored pages were ever read; images fetched are thumbnails' larger kin only", h.fetched.pages.every((u) => Object.values(PG).includes(u)) && !h.fetched.pages.includes(PG.xOther));
}

// ---- 4. changed since the plan → skipped, never overwritten ---------------------------
{
  const dir2 = tmp();
  const h2 = await harness(dir2);
  const plan2 = await h2.q.buildPlan({ by: "patrick" });
  const a = plan2.upgrades.find((r) => r.skus.includes("A1"));
  // (a) Patrick uploads his own photo for a live part.
  await h2.store.setPhoto("A1", h2.catalog.A1, await make(["patrick", 900]), { by: "Patrick Lalande", source: { method: "upload" } });
  // (b) Patrick approves a TLCOUP candidate: the part goes live.
  const tl = plan2.upgrades.filter((r) => r.skus.includes("TLCOUP"));
  await h2.store.approveCandidate("TLCOUP", h2.catalog.TLCOUP, tl[0].current.hash, { by: "Patrick Lalande" });
  // (c) Patrick rejects 111BC's result: its candidates are rejected.
  const c111 = plan2.upgrades.filter((r) => r.skus.includes("111BC"));
  await h2.store.rejectAiResult("111BC", h2.catalog["111BC"], { by: "Patrick Lalande", reason: "wrong box" });
  const s = await h2.q.summary();
  check("changed: the uploaded live photo, the approved part's candidates and the rejected candidates all drop out of the applicable list", !s.upgrades.some((r) => r.groupId === a.groupId || r.skus.includes("TLCOUP") || r.skus.includes("111BC")) && s.upgrades.some((r) => r.skus.includes("205120")));
  const r1 = await h2.store.upgradePhotoQuality(a.groupId, { fromHash: a.current.hash, to: a.upgrade, imageUrl: a.upgrade.imageUrl, by: "patrick" });
  const r2 = await h2.store.restoreCandidateImage(tl[1].groupId, { fromHash: tl[1].current.hash, to: tl[1].upgrade, imageUrl: tl[1].upgrade.imageUrl, by: "patrick" });
  const r3 = await h2.store.restoreCandidateImage(c111[0].groupId, { fromHash: c111[0].current.hash, to: c111[0].upgrade, imageUrl: c111[0].upgrade.imageUrl, by: "patrick" });
  check("changed: even a stale request straight to the store is skipped — upload kept, live part untouched, rejected candidate untouched", /changed since/.test(r1.skipped || "") && /went live/.test(r2.skipped || "") && /rejected/.test(r3.skipped || ""), JSON.stringify([r1, r2, r3]));
  const snap = await h2.store.snapshot();
  check("changed: Patrick's upload and his approval are exactly as he left them", snap.groups[a.groupId].source.method === "upload" && snap.groups[tl[0].groupId].photo.hash === tl[0].current.hash && snap.groups[tl[0].groupId].approvedBy === "Patrick Lalande");
  // A candidate whose larger copy is already a candidate of the same part.
  const five = plan2.upgrades.filter((r) => r.skus.includes("205120"));
  const gid = five[0].groupId;
  await h2.store.restoreCandidateImage(gid, { fromHash: five[0].current.hash, to: five[0].upgrade, imageUrl: five[0].upgrade.imageUrl, by: "patrick" });
  const dup = await h2.store.restoreCandidateImage(gid, { fromHash: five[1].current.hash, to: five[0].upgrade, imageUrl: five[0].upgrade.imageUrl, by: "patrick" });
  check("a larger copy that is already one of the part's candidates is not added twice", /already a candidate/.test(dup.skipped || ""));
  // Keep as is — by row id (live = group id; candidate = group:hash).
  const bRow = plan2.review.find((r) => r.skus.includes("B1"));
  await h2.q.resolveReview(bRow.id, { action: "keep", by: "patrick" });
  check("keep as is: the row leaves the review list; the photo is untouched", !(await h2.q.summary()).review.some((r) => r.id === bRow.id) && (await h2.store.snapshot()).groups[bRow.groupId].photo.hash === h2.hashes.B1);
  await rejects("keep as is: only review rows can be kept", () => h2.q.resolveReview("PG-9999", { action: "keep", by: "patrick" }), /isn't in the quality review queue/);
  const q3 = qu.createQualityUpgrade({ dataDir: dir2, store: h2.store, sharp, getParts: h2.parts, fetchPage: async () => { throw new Error("no"); }, fetchImage: async () => { throw new Error("no"); } });
  const s4 = await q3.summary();
  check("restart: the plan and the kept row survive on disk", s4.plan && s4.plan.id === plan2.plan.id && !s4.review.some((r) => r.id === bRow.id));
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ---- 5. the shared "what the Review tab shows" rule -------------------------------------
{
  const g = { candidates: [{ hash: "1" }, { hash: "2" }, { hash: "3" }, { hash: "4" }, { hash: "5" }], rejectedHashes: ["4"] };
  check("visibleCandidates: the last three not rejected, oldest first — the one rule the card and the plan share", JSON.stringify(review.visibleCandidates(g).map((c) => c.hash)) === JSON.stringify(["2", "3", "5"]) && review.visibleCandidates(null).length === 0);
}
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\ntest-photo-quality-upgrade: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

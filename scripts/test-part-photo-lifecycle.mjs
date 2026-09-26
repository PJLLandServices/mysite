#!/usr/bin/env node
// Part photos — the safety rule, end to end (Linear P-PJL-35, FLOW-47).
//
// Patrick checks a part number once and then recognises the part by its
// picture. So the question this file guards is not "does a photo show?"
// but "can a photo that should NOT show ever reach the picker?":
//
//   - a To-be-determined candidate (group or link) never reaches /api/parts
//   - a Not-confident group shows nothing
//   - a part edited after its photo was matched hides the photo until it
//     is reconfirmed — whichever write path did the edit
//   - a missing image file shows nothing rather than a broken picture
//   - one photo per real fitting: two SKUs in one group share it, and
//     replacing it replaces it for both
//   - images are only resized: never mirrored, never rotated by us
//   - a pasted URL cannot make the server read a private address
//
// Runs in temp directories with fake network functions. It cannot reach
// real data or the internet.
//
// Run: node scripts/test-part-photo-lifecycle.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");

let lib;
try { lib = require(path.join(ROOT, "server", "lib", "part-photos.js")); }
catch (err) { console.log(`FAIL  server/lib/part-photos.js could not be loaded: ${err.message}`); process.exit(1); }
const { photoStateFor, mergeIntoCatalog, fingerprintOf, isPublicAddress, fetchImageSafely, processImage, createPartPhotos, normalizeThumbs, findSubjectRegion } = lib;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); }
}

const HASH = "a".repeat(64);
const part = (sku, extra = {}) => ({ sku, partNumber: sku, description: `Part ${sku}`, ...extra });
const linkFor = (p, groupId, linkTier = "confirmed") => ({ groupId, linkTier, fingerprint: fingerprintOf(p) });
const group = (tier, withPhoto = true) => ({ id: "PG-0001", tier, photo: withPhoto ? { hash: HASH, width: 800, height: 600 } : null });
const onDisk = () => true;

// ---- 1. The rule, state by state ------------------------------------------
{
  const p = part("405010");
  const links = { "405010": linkFor(p, "PG-0001") };
  const cases = [
    ["approved group, confirmed link", group("approved"), links, "verified"],
    ["AI-confident group", group("confident"), links, "verified"],
    ["To-be-determined group WITH a candidate photo on disk", group("tbd"), links, "tbd"],
    ["Not-confident group", group("not_confident"), links, "not_confident"],
    ["group with no photo", group("approved", false), links, "none"],
    ["approved group, To-be-determined LINK", group("approved"), { "405010": linkFor(p, "PG-0001", "tbd") }, "tbd"],
    ["unlinked part", group("approved"), {}, "none"],
  ];
  for (const [name, g, l, want] of cases) {
    const got = photoStateFor("405010", p, { "PG-0001": g }, l, onDisk).state;
    check(`state: ${name} → ${want}`, got === want, `got ${got}`);
  }
  check("state: image file missing → none, never a broken picture",
    photoStateFor("405010", p, { "PG-0001": group("approved") }, links, () => false).state === "none");
  check("state: malformed hash → none",
    photoStateFor("405010", p, { "PG-0001": { ...group("approved"), photo: { hash: "../../etc" } } }, links, onDisk).state === "none");
}

// ---- 2. The merge exposes a photo ONLY when verified ----------------------
{
  const parts = { A: part("A"), B: part("B"), C: part("C"), D: part("D") };
  const groups = {
    "PG-0001": group("approved"),
    "PG-0002": { id: "PG-0002", tier: "tbd", photo: { hash: "b".repeat(64) } },
    "PG-0003": { id: "PG-0003", tier: "not_confident", photo: null }
  };
  const links = {
    A: linkFor(parts.A, "PG-0001"), B: linkFor(parts.B, "PG-0001"),
    C: linkFor(parts.C, "PG-0002"), D: linkFor(parts.D, "PG-0003")
  };
  mergeIntoCatalog(parts, groups, links, onDisk);
  check("merge: verified part gets a thumbnail URL", parts.A.photo && parts.A.photo.thumb === `/api/part-photos/${HASH}/t160.webp` && parts.A.photo.thumb2x === `/api/part-photos/${HASH}/t320.webp`);
  check("merge: verified part gets large + mobile URLs",
    parts.A.photo.large.endsWith("/1200.webp") && parts.A.photo.largeMobile.endsWith("/480.webp"));
  check("merge: TBD part has photo:null", parts.C.photo === null && parts.C.photoState === "tbd");
  check("merge: TBD candidate hash appears NOWHERE in the payload",
    !JSON.stringify(parts).includes("b".repeat(64)));
  check("merge: Not-confident part has photo:null", parts.D.photo === null && parts.D.photoState === "not_confident");
  check("merge: shared fitting — A and B show the SAME photo", parts.A.photo.thumb === parts.B.photo.thumb);
  check("merge: shared fitting — each names the other", parts.A.photo.sharedWith.join() === "B" && parts.B.photo.sharedWith.join() === "A");
}

// ---- 3. An edited part hides its photo, whichever path edited it ----------
{
  const before = part("1406010", { description: "Poly insert elbow 90° 1\"" });
  const groups = { "PG-0001": group("approved") };
  const links = { "1406010": linkFor(before, "PG-0001") };
  const partNumberEdit = { ...before, partNumber: "1406-012" };
  const descriptionEdit = { ...before, description: "Poly insert elbow 90° 1-1/4\"" };
  const priceEdit = { ...before, priceCents: 999, supplierIds: ["SUP-9"] };
  const whitespaceOnly = { ...before, description: "  Poly insert elbow   90° 1\" " };
  check("edit: part number changed → photo hidden", photoStateFor("1406010", partNumberEdit, groups, links, onDisk).state === "changed");
  check("edit: description changed → photo hidden", photoStateFor("1406010", descriptionEdit, groups, links, onDisk).state === "changed");
  check("edit: price / supplier change keeps the photo", photoStateFor("1406010", priceEdit, groups, links, onDisk).state === "verified");
  check("edit: whitespace/case-only change keeps the photo", photoStateFor("1406010", whitespaceOnly, groups, links, onDisk).state === "verified");
}

// ---- 4. Soft-delete / restore round trip -----------------------------------
{
  const p = part("VB7081101");
  const groups = { "PG-0001": group("approved") };
  const links = { VB7081101: linkFor(p, "PG-0001") };
  const deleted = {}; // a soft-deleted part is absent from the merged catalog
  mergeIntoCatalog(deleted, groups, links, onDisk);
  check("delete: merge of a catalog without the part does not throw", true);
  const restored = { VB7081101: { ...p } };
  mergeIntoCatalog(restored, groups, links, onDisk);
  check("restore: the photo comes back with the part", restored.VB7081101.photoState === "verified");
}

// ---- 5. Images are only resized --------------------------------------------
{
  // 40x20 image: left half red, right half blue.
  const W = 40, H = 20, raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (x < W / 2) raw[i] = 255; else raw[i + 2] = 255;
  }
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const out = await processImage(png, sharp);
  const back = await sharp(out.variants[160]).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * back.info.width + x) * back.info.channels; return [back.data[i], back.data[i + 1], back.data[i + 2]]; };
  const left = px(2, 10), right = px(back.info.width - 3, 10);
  check("image: proportions kept (40x20 stays 2:1)", back.info.width === 40 && back.info.height === 20, `${back.info.width}x${back.info.height}`);
  check("image: not enlarged beyond the original", out.width === 40);
  check("image: not mirrored (red stays left, blue stays right)", left[0] > 200 && left[2] < 60 && right[2] > 200 && right[0] < 60);
  check("image: three sizes produced", Object.keys(out.variants).sort().join() === "1200,160,480");

  // A phone photo stored sideways with an EXIF "rotate 90" flag displays
  // upright everywhere. Dropping EXIF without honouring it would turn it
  // sideways — so the output must keep the DISPLAYED shape (20 wide, 40 tall).
  const tagged = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const t = await processImage(tagged, sharp);
  const tm = await sharp(t.variants[1200]).metadata();
  check("image: EXIF-rotated phone photo keeps its displayed orientation", tm.width === 20 && tm.height === 40, `${tm.width}x${tm.height}`);

  const src = fs.readFileSync(path.join(ROOT, "server", "lib", "part-photos.js"), "utf8").replace(/\/\/.*$/gm, "");
  check("image: no flip / flop / angled rotate anywhere in the module",
    !/\.(flip|flop|affine)\(/.test(src) && !/\.trim\(\s*[{\d]/.test(src) && !/\.rotate\(\s*[^)\s]/.test(src));
  check("image: the ONLY region cut is the thumbnail's plain-background trim",
    (src.match(/\.extract\(/g) || []).length === 1 && /\.extract\(found\.region\)/.test(src));
  await rejects("image: a non-image is refused", () => processImage(Buffer.from("not an image"), sharp), /image/i);
}

// ---- 6. A pasted URL cannot reach inside the network -----------------------
{
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    check(`network: ${ip} is refused`, !isPublicAddress(ip));
  }
  for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4004:c1b::64"]) {
    check(`network: ${ip} is allowed`, isPublicAddress(ip));
  }
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
  const imageResponse = (bytes, type = "image/png") => new Response(bytes, { status: 200, headers: { "content-type": type } });
  const tiny = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();

  await rejects("fetch: http:// refused", () => fetchImageSafely("http://example.com/a.png", { lookup: publicLookup, fetchImpl: async () => imageResponse(tiny) }), /https/);
  await rejects("fetch: a hostname that resolves privately is refused", () => fetchImageSafely("https://intranet.example/a.png", { lookup: privateLookup, fetchImpl: async () => imageResponse(tiny) }), /public/);
  await rejects("fetch: a literal metadata IP is refused", () => fetchImageSafely("https://169.254.169.254/latest", { lookup: publicLookup, fetchImpl: async () => imageResponse(tiny) }), /public/);
  let hops = 0;
  const redirectToPrivate = async () => { hops++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x.png" } }); };
  await rejects("fetch: a redirect to a private address is refused", () => fetchImageSafely("https://cdn.example/a.png", { lookup: publicLookup, fetchImpl: redirectToPrivate }), /public/);
  await rejects("fetch: an HTML page is refused", () => fetchImageSafely("https://cdn.example/page", { lookup: publicLookup, fetchImpl: async () => imageResponse("<html>", "text/html") }), /isn't an image/);
  await rejects("fetch: an SVG is refused", () => fetchImageSafely("https://cdn.example/a.svg", { lookup: publicLookup, fetchImpl: async () => imageResponse("<svg/>", "image/svg+xml") }), /isn't an image/);
  await rejects("fetch: an oversized image is refused", () => fetchImageSafely("https://cdn.example/big.png", { lookup: publicLookup, maxBytes: 10, fetchImpl: async () => imageResponse(tiny) }), /too large/);
  const ok = await fetchImageSafely("https://cdn.example/a.png", { lookup: publicLookup, fetchImpl: async () => imageResponse(tiny) });
  check("fetch: a public https image is accepted", ok.buffer.length === tiny.length);
}

// ---- 7. The store, on disk --------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-photos-"));
  try {
    const store = createPartPhotos({ dataDir: dir, sharp });
    const tee = part("405010", { description: "PVC tee 1\" FIPT" });
    const teeCentral = part("CT-405010", { description: "PVC tee 1\" FIPT (Central)" });
    const img1 = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#c00" } }).png().toBuffer();
    const img2 = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#00c" } }).png().toBuffer();

    const first = await store.setPhoto("405010", tee, img1, { by: "patrick", source: { method: "upload" } });
    await store.linkToGroup("CT-405010", teeCentral, first.groupId, { by: "patrick" });
    let parts = { "405010": { ...tee }, "CT-405010": { ...teeCentral } };
    store.mergeInto(parts);
    check("store: first photo shows for the SKU it was set on", parts["405010"].photoState === "verified");
    check("store: 'same fitting' SKU shows the same photo", parts["CT-405010"].photo && parts["CT-405010"].photo.thumb === parts["405010"].photo.thumb);
    check("store: image files written for all three sizes",
      [160, 480, 1200, "t160", "t320"].every((s) => fs.existsSync(store.imagePath(first.hash, s))));

    const second = await store.setPhoto("CT-405010", teeCentral, img2, { by: "patrick", source: { method: "upload" } });
    parts = { "405010": { ...tee }, "CT-405010": { ...teeCentral } };
    store.mergeInto(parts);
    check("store: replacing the photo on one SKU replaces it for the whole fitting",
      second.groupId === first.groupId && parts["405010"].photo.thumb.includes(second.hash));
    const snap = await store.snapshot();
    check("store: the replaced photo is kept in the group's history", snap.groups[first.groupId].history.some((h) => h.hash === first.hash));
    check("store: no filename is stored as evidence", !JSON.stringify(snap).includes("filename"));

    const edited = { ...tee, partNumber: "405-010-X" };
    parts = { "405010": { ...edited } };
    store.mergeInto(parts);
    check("store: after an edit the photo hides", parts["405010"].photoState === "changed" && parts["405010"].photo === null);
    await store.reconfirm("405010", edited, { by: "patrick" });
    parts = { "405010": { ...edited } };
    store.mergeInto(parts);
    check("store: reconfirming brings it back", parts["405010"].photoState === "verified");

    await store.removeGroupPhoto(first.groupId, { by: "patrick" });
    parts = { "405010": { ...edited }, "CT-405010": { ...teeCentral } };
    store.mergeInto(parts);
    check("store: removing the photo removes it for every SKU in the fitting",
      parts["405010"].photo === null && parts["CT-405010"].photo === null);

    check("store: path traversal in the image route is refused", store.imagePath("../../server", 160) === null && store.imagePath(HASH, 9999) === null);

    const log = fs.readFileSync(path.join(dir, "part-photos-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("store: every change is in the audit log", ["photo.set", "link.set", "link.reconfirm", "photo.remove"].every((a) => log.some((e) => e.action === a)));

    fs.writeFileSync(path.join(dir, "part-photo-links.json"), "{ not json");
    await rejects("store: a damaged store is refused, never treated as empty",
      () => store.linkToGroup("405010", tee, first.groupId, { by: "patrick" }), /refusing to treat it as empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 8. Normalized tile thumbnails (Patrick, Sep 26 2026) ------------------
// Tall/narrow parts ran out of the picker tile. The tile now uses a square
// thumbnail: part found on a plain background, a margin of original pixels
// kept around it, fitted whole and centred (contain, never cover).
{
  // Bounding box of "not background" pixels in a decoded thumbnail.
  async function subjectIn(webp, bg = [255, 255, 255], tol = 40) {
    const { data, info } = await sharp(webp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (Math.abs(data[i] - bg[0]) > tol || Math.abs(data[i + 1] - bg[1]) > tol || Math.abs(data[i + 2] - bg[2]) > tol) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { w: info.width, h: info.height, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  const svg = (w, h, body, bg = "#fff") => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`)).png().toBuffer();

  // A 1:6 Pro-Spray-like body in the middle of a WIDE white photo.
  const tall = await svg(900, 1200, `<rect x="420" y="60" width="60" height="1080" rx="8" fill="#222"/><rect x="405" y="40" width="90" height="50" fill="#8a5a3c"/>`);
  const t = await normalizeThumbs(tall, sharp);
  const ts = await subjectIn(t.variants[160]);
  check("thumb: output is an exact 160×160 square", ts.w === 160 && ts.h === 160, `${ts.w}x${ts.h}`);
  check("thumb: 320 (retina) variant is 320×320", (await sharp(t.variants[320]).metadata()).width === 320);
  check("thumb: plain background was trimmed", t.trimmed === true);
  check("thumb: tall part is centred", Math.abs(ts.cx - 79.5) <= 2 && Math.abs(ts.cy - 79.5) <= 2, JSON.stringify(ts));
  check("thumb: tall part is fully inside, not touching the edge", ts.y0 >= 3 && ts.y1 <= 156 && ts.x0 >= 3 && ts.x1 <= 156, JSON.stringify(ts));
  check("thumb: tall part fills the tile height (not a sliver in a wide photo)", ts.y1 - ts.y0 >= 120, `height ${ts.y1 - ts.y0}`);
  const partRatio = 90 / 1100, drawnRatio = (ts.x1 - ts.x0 + 1) / (ts.y1 - ts.y0 + 1);
  check("thumb: aspect ratio preserved (contain, not stretched)", Math.abs(drawnRatio - partRatio) < 0.05, `drawn ${drawnRatio.toFixed(3)} vs part ${partRatio.toFixed(3)}`);

  // A 5:1 dripline coil — wide.
  const wide = await svg(1400, 1400, `<rect x="100" y="640" width="1200" height="240" rx="20" fill="#6a4424"/>`);
  const ws = await subjectIn((await normalizeThumbs(wide, sharp)).variants[160]);
  check("thumb: wide part centred and fills the tile width", Math.abs(ws.cx - 79.5) <= 2 && Math.abs(ws.cy - 79.5) <= 2 && ws.x1 - ws.x0 >= 120, JSON.stringify(ws));

  // White PVC fitting on white: dark outline plus a FAINT rim (within the
  // background tolerance) just outside it. The kept region must include
  // the rim — that is what the margin of original pixels is for.
  const W = 600, H = 400;
  const raw = Buffer.alloc(W * H * 3, 255);
  const paint = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) raw.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3); };
  paint(196, 146, 404, 254, 244);     // faint rim, 4px wide (reads as background)
  paint(200, 150, 400, 250, 180);     // outline
  paint(202, 152, 398, 248, 250);     // white body
  const fr = findSubjectRegion(raw, W, H, 3);
  check("thumb: white-on-white fitting found", fr.trimmed && fr.subject.left === 200 && fr.subject.width === 200, JSON.stringify(fr.subject));
  check("thumb: kept region includes the faint rim outside the outline (never crops the part)",
    fr.region.left <= 196 && fr.region.top <= 146 && fr.region.left + fr.region.width >= 404 && fr.region.top + fr.region.height >= 254, JSON.stringify(fr.region));

  // Part touching the photo's edge: nothing beyond the photo to trim, and nothing of the part lost.
  const edge = await svg(400, 800, `<rect x="0" y="0" width="120" height="800" fill="#333"/>`);
  const er = findSubjectRegion((await sharp(edge).removeAlpha().raw().toBuffer()), 400, 800, 3);
  check("thumb: a part touching the edge is kept whole", er.region.left === 0 && er.region.top === 0 && er.region.height === 800 && er.region.width >= 120, JSON.stringify(er.region));

  // A busy background (a part photographed on a workbench) is never trimmed.
  const noise = Buffer.alloc(300 * 300 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + (i >> 3) * 104729) % 256;
  const nr = findSubjectRegion(noise, 300, 300, 3);
  check("thumb: busy background → no trim, whole photo kept", nr.trimmed === false && nr.region.width === 300 && nr.region.height === 300);
  const noisePng = await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer();
  const nm = await sharp((await normalizeThumbs(noisePng, sharp)).variants[160]).metadata();
  check("thumb: busy photo still becomes a bounded 160×160 tile", nm.width === 160 && nm.height === 160);

  // Transparent PNG: flattened onto white, part centred.
  const transparent = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect x="120" y="100" width="60" height="700" fill="#1b4d2e"/></svg>`)).png().toBuffer();
  const trs = await subjectIn((await normalizeThumbs(transparent, sharp)).variants[160]);
  check("thumb: transparent PNG part centred on white", Math.abs(trs.cx - 79.5) <= 2 && trs.y1 - trs.y0 >= 120, JSON.stringify(trs));

  // A photo saved before normalized thumbnails existed gets them on first request.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-photos-thumb-"));
  try {
    const store = createPartPhotos({ dataDir: dir, sharp });
    const p = part("PROS12SIPRS30");
    const saved = await store.setPhoto("PROS12SIPRS30", p, tall, { by: "patrick", source: { method: "upload" } });
    for (const s of ["t160", "t320"]) fs.rmSync(store.imagePath(saved.hash, s));
    await store.ensureThumb(saved.hash, "t160");
    check("thumb: an older photo gets its normalized thumbnails on first request",
      fs.existsSync(store.imagePath(saved.hash, "t160")) && fs.existsSync(store.imagePath(saved.hash, "t320")));
    const back = await subjectIn(fs.readFileSync(store.imagePath(saved.hash, "t160")));
    check("thumb: the backfilled thumbnail is centred and inside the tile", Math.abs(back.cx - 79.5) <= 2 && back.y0 >= 3 && back.y1 <= 156, JSON.stringify(back));
    check("thumb: the large views are the untouched photo (not trimmed)",
      (await sharp(fs.readFileSync(store.imagePath(saved.hash, 1200))).metadata()).width === 900);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 9. Thumbnail safeguards: concurrent first requests, and failure ------
{
  const tallPhoto = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#fff"/><rect x="420" y="60" width="60" height="1080" fill="#222"/></svg>`)).png().toBuffer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-photos-safe-"));
  try {
    const store = createPartPhotos({ dataDir: dir, sharp });
    const p = part("PROS04PRS30");
    const saved = await store.setPhoto("PROS04PRS30", p, tallPhoto, { by: "patrick", source: { method: "upload" } });
    const hashDir = path.dirname(store.imagePath(saved.hash, 160));

    // (1) An older photo with no tile thumbnails, hit by 8 requests at once.
    for (const s of ["t160", "t320"]) fs.rmSync(store.imagePath(saved.hash, s));
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.resolveImageFile(saved.hash, i % 2 ? "t320" : "t160")));
    check("concurrent: all 8 simultaneous first requests succeed", results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)));
    check("concurrent: none of them fell back — the thumbnails were made", results.every((r) => r.value && r.value.fallback === false));
    const expected = (await normalizeThumbs(fs.readFileSync(store.imagePath(saved.hash, 1200)), sharp)).variants;
    check("concurrent: the t160 on disk is complete and identical to a single generation",
      Buffer.compare(fs.readFileSync(store.imagePath(saved.hash, "t160")), expected[160]) === 0);
    check("concurrent: the t320 on disk is complete and identical to a single generation",
      Buffer.compare(fs.readFileSync(store.imagePath(saved.hash, "t320")), expected[320]) === 0);
    check("concurrent: no half-written temp files left behind", !fs.readdirSync(hashDir).some((f) => f.endsWith(".tmp")), fs.readdirSync(hashDir).join(","));
    const again = await store.resolveImageFile(saved.hash, "t160");
    check("concurrent: a later request just serves the file (idempotent)", again.fallback === false && again.path === store.imagePath(saved.hash, "t160"));

    // (2a) Generation fails for an older photo (its 1200 source is unreadable):
    // the tile gets the plain resized photo instead, never an error.
    for (const s of ["t160", "t320"]) fs.rmSync(store.imagePath(saved.hash, s));
    fs.writeFileSync(store.imagePath(saved.hash, 1200), "not an image");
    const f160 = await store.resolveImageFile(saved.hash, "t160");
    const f320 = await store.resolveImageFile(saved.hash, "t320");
    check("fallback: t160 falls back to the plain 160 photo", f160.fallback === true && f160.path === store.imagePath(saved.hash, 160) && fs.existsSync(f160.path));
    check("fallback: t320 falls back to the plain 480 photo", f320.fallback === true && f320.path === store.imagePath(saved.hash, 480) && fs.existsSync(f320.path));
    const fm = await sharp(fs.readFileSync(f160.path)).metadata();
    check("fallback: the fallback is a real, readable image (not a broken one)", fm.format === "webp" && fm.width > 0);

    // (2b) Generation fails at upload time: the photo still saves and shows.
    const failingSharp = (...args) => { const s = sharp(...args); s.raw = () => { throw new Error("simulated thumbnail failure"); }; return s; };
    const processed = await processImage(tallPhoto, failingSharp);
    check("fallback: a failed thumbnail does not fail the photo (variants still made)", processed.thumbs === null && [160, 480, 1200].every((s) => processed.variants[s]));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "part-photos-fail-"));
    try {
      const failStore = createPartPhotos({ dataDir: dir2, sharp: failingSharp });
      const q = part("PROS06SIPRS30");
      const s2 = await failStore.setPhoto("PROS06SIPRS30", q, tallPhoto, { by: "patrick", source: { method: "upload" } });
      const parts = { PROS06SIPRS30: { ...q } };
      failStore.mergeInto(parts);
      check("fallback: the part is still verified in the picker catalog", parts.PROS06SIPRS30.photoState === "verified" && !!parts.PROS06SIPRS30.photo);
      const r = await failStore.resolveImageFile(s2.hash, "t160");
      check("fallback: its tile serves the plain photo", r.fallback === true && fs.existsSync(r.path));
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ntest-part-photo-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

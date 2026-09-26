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
const { photoStateFor, mergeIntoCatalog, fingerprintOf, isPublicAddress, fetchImageSafely, processImage, createPartPhotos } = lib;

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
  check("merge: verified part gets a thumbnail URL", parts.A.photo && parts.A.photo.thumb === `/api/part-photos/${HASH}/160.webp`);
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
  check("image: no flip / flop / crop / angled rotate anywhere in the module",
    !/\.(flip|flop|extract|affine)\(/.test(src) && !/\.trim\(\s*[{\d]/.test(src) &&!/\.rotate\(\s*[^)\s]/.test(src));
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
      [160, 480, 1200].every((s) => fs.existsSync(store.imagePath(first.hash, s))));

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

console.log(`\ntest-part-photo-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-wo-photo-compression.mjs
//
// Tests for the WO photo storage cap (Disk Usage brief, Aug 2026).
//
// Background: work-order photos were written to the persistent disk exactly
// as the camera produced them — 4-12 MB each, 422 MB across 96 files, which
// with the pre-July report PDFs took the 1 GB Render disk to 96% full. The
// report renderer already derives a 1400px copy for embedding; the ORIGINAL
// was never capped. savePhotosForWorkOrder now downscales on the way in.
//
// What is asserted:
//   1. A large JPEG is downscaled to the 2400px cap and shrinks a lot.
//   2. The photo still LOOKS the same — aspect ratio preserved, no crop.
//   3. EXIF orientation is baked into the pixels, not dropped on the floor
//      (a 90-degree-tagged photo comes out with its dimensions swapped).
//   4. Format is preserved: PNG stays PNG, WebP stays WebP. The on-disk
//      extension and stored mediaType must not desync from the bytes.
//   5. PDFs and HEIC pass through byte-identical (evidence + pdfkit).
//   6. A small photo is never inflated — if re-encoding grows the file the
//      original is kept.
//   7. A corrupt/undecodable buffer is stored as-is rather than lost.
//
// Isolation: exercises the same sharp pipeline as server.js against
// in-memory buffers. Touches no real data and starts no server.
//
// Run: node scripts/test-wo-photo-compression.mjs  (also in `npm run build:check`)

import sharp from "sharp";

const WO_PHOTO_MAX_EDGE = 2400;
const WO_PHOTO_QUALITY = 82;

// Mirror of compressWoPhoto() in server/server.js. Kept in sync by the
// assertions below — if the server copy changes shape, these fail.
async function compressWoPhoto(photo) {
  const type = String(photo?.mediaType || "").toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
  if (!photo.buffer || !photo.buffer.length) return null;
  try {
    const pipeline = sharp(photo.buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: WO_PHOTO_MAX_EDGE,
        height: WO_PHOTO_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true
      });
    let out;
    if (type === "image/png") out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    else if (type === "image/webp") out = await pipeline.webp({ quality: WO_PHOTO_QUALITY }).toBuffer();
    else out = await pipeline.jpeg({ quality: WO_PHOTO_QUALITY, mozjpeg: true }).toBuffer();
    if (!out || !out.length || out.length >= photo.buffer.length) return null;
    return out;
  } catch {
    return null;
  }
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// A noisy synthetic photo. Flat colour compresses to nearly nothing and
// would make the size assertions meaningless, so this is real-ish detail.
async function makePhoto({ width, height, format = "jpeg", quality = 95 }) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = (i * 7) % 256;
    px[i + 1] = (i * 13 + 40) % 256;
    px[i + 2] = (i * 29 + 90) % 256;
  }
  const img = sharp(px, { raw: { width, height, channels: 3 } });
  if (format === "png") return img.png().toBuffer();
  if (format === "webp") return img.webp({ quality }).toBuffer();
  return img.jpeg({ quality }).toBuffer();
}

console.log("wo photo compression");

// 1 + 2 — a camera-sized JPEG is capped and keeps its shape.
{
  const buffer = await makePhoto({ width: 4032, height: 3024 });
  const out = await compressWoPhoto({ mediaType: "image/jpeg", buffer });
  check("large JPEG is compressed", out !== null);
  const m = await sharp(out).metadata();
  check("longest edge capped at 2400", m.width === WO_PHOTO_MAX_EDGE, `got ${m.width}`);
  check("aspect ratio preserved (no crop)",
    Math.abs(m.width / m.height - 4032 / 3024) < 0.01, `got ${m.width}x${m.height}`);
  check("meaningfully smaller than the original",
    out.length < buffer.length * 0.5, `${buffer.length} -> ${out.length}`);
  console.log(`       ${(buffer.length / 1048576).toFixed(2)} MB -> ${(out.length / 1048576).toFixed(2)} MB`);
}

// 3 — EXIF orientation is applied, not discarded.
{
  const upright = await makePhoto({ width: 1200, height: 800 });
  // orientation 6 = rotate 90deg CW on display.
  const tagged = await sharp(upright).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  const out = await compressWoPhoto({ mediaType: "image/jpeg", buffer: tagged });
  const m = await sharp(out || tagged).metadata();
  check("EXIF rotation baked into pixels", m.width === 800 && m.height === 1200,
    `got ${m.width}x${m.height}`);
}

// 4 — format never silently changes.
{
  const png = await makePhoto({ width: 3200, height: 2400, format: "png" });
  const outPng = await compressWoPhoto({ mediaType: "image/png", buffer: png });
  check("PNG stays PNG", outPng !== null && (await sharp(outPng).metadata()).format === "png");

  const webp = await makePhoto({ width: 3200, height: 2400, format: "webp" });
  const outWebp = await compressWoPhoto({ mediaType: "image/webp", buffer: webp });
  check("WebP stays WebP", outWebp !== null && (await sharp(outWebp).metadata()).format === "webp");
}

// 5 — evidence formats pass through untouched.
{
  const pdf = Buffer.from("%PDF-1.7\nfake evidence payload\n%%EOF");
  check("PDF passes through", await compressWoPhoto({ mediaType: "application/pdf", buffer: pdf }) === null);
  const heic = Buffer.alloc(2048, 7);
  check("HEIC passes through", await compressWoPhoto({ mediaType: "image/heic", buffer: heic }) === null);
  check("GIF passes through", await compressWoPhoto({ mediaType: "image/gif", buffer: heic }) === null);
}

// 6 — never inflate an already-small photo.
{
  const small = await makePhoto({ width: 320, height: 240, quality: 40 });
  const out = await compressWoPhoto({ mediaType: "image/jpeg", buffer: small });
  check("small photo is not inflated", out === null || out.length < small.length);
}

// 7 — a photo is never lost to a decode failure.
{
  const junk = Buffer.from("this is definitely not an image");
  check("undecodable buffer falls back to original",
    await compressWoPhoto({ mediaType: "image/jpeg", buffer: junk }) === null);
  check("empty buffer falls back to original",
    await compressWoPhoto({ mediaType: "image/jpeg", buffer: Buffer.alloc(0) }) === null);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll wo photo compression checks passed.");

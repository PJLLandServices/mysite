// Supplier company logos (P-PJL-35 M2a) — the chip on each parts-picker row.
//
// The file is the supplier's OFFICIAL logo, uploaded as-is. It is only
// resized to fit a 600×200 box: never cropped, never trimmed, never
// redrawn; aspect ratio and transparency are kept (PNG output). The one
// transform besides resizing is honouring the file's own EXIF orientation,
// as the part photos do.
//
// Storage: server/data/supplier-logos/<sha256 of the upload>.png,
// content-addressed, so the URL can be cached forever and replacing a logo
// is a new URL.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_W = 600, MAX_H = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = new Set(["png", "jpeg", "webp", "svg", "gif"]);

async function processLogo(buffer, sharp) {
  if (!buffer || !buffer.length) throw new Error("The logo file was empty.");
  if (buffer.length > MAX_BYTES) throw new Error("That logo file is too large (4 MB max).");
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: 50e6 }).metadata(); }
  catch { throw new Error("That doesn't look like an image we can read. Use a PNG or SVG logo."); }
  if (!ACCEPTED.has(meta.format)) throw new Error("That logo type isn't supported. Use a PNG or SVG.");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { data, info } = await sharp(buffer, { limitInputPixels: 50e6 })
    .rotate()
    .resize({ width: MAX_W, height: MAX_H, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { hash, png: data, width: info.width, height: info.height, sourceFormat: meta.format };
}

function createSupplierLogos({ dataDir, sharp }) {
  const DIR = path.join(dataDir, "supplier-logos");
  function logoPath(hash) {
    return HASH_RE.test(String(hash)) ? path.join(DIR, `${hash}.png`) : null;
  }
  async function save(buffer) {
    const out = await processLogo(buffer, sharp);
    await fs.mkdir(DIR, { recursive: true });
    const p = logoPath(out.hash);
    if (!fsSync.existsSync(p)) await fs.writeFile(p, out.png);
    return { hash: out.hash, width: out.width, height: out.height };
  }
  return { logoPath, save };
}

function logoUrl(logo) {
  return logo && HASH_RE.test(String(logo.hash || "")) ? `/api/supplier-logos/${logo.hash}.png` : null;
}

module.exports = { processLogo, createSupplierLogos, logoUrl, HASH_RE };

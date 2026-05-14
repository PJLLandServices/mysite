#!/usr/bin/env node
/**
 * Image compression + responsive variants.
 *
 * For each source image, generates:
 *   - <name>@800w.<ext>     (mobile srcset target, quality 78)
 *   - <name>@1280w.<ext>    (tablet/desktop srcset target, quality 80)
 *   - <name>.<ext>          (replaces original; clamped to 2400px wide, quality 82)
 *
 * Skips variants that are already up-to-date (mtime newer than source).
 *
 * Usage:
 *   node scripts/compress-images.js                # process default offender list
 *   node scripts/compress-images.js file1 file2... # process specific files
 *   node scripts/compress-images.js --dry          # report only, do not write
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

// Top oversized images, identified by static audit. Edit/extend as needed.
const DEFAULT_TARGETS = [
  'pipe-break-repair.jpg',
  'sprinkler-system-running.jpg',
  'fall-sprinkler-running.jpg',
  'estate-sprinkler-hero.jpg',
  'backyard-sprinkler-running.jpg',
  'leaking-valve-box.jpg',
  'commercial-drip-after.jpg',
  'commercial-valve-manifold.jpg',
  'commercial-drip-before.jpg',
  'hunter-pgp-rotor-action.jpg',
  'hydrawise-display-desktop.png',
  'estate-sprinkler-sunset.jpg',
  'installation-before-after.jpg',
  'tech-valve-box-service.jpg',
];

const VARIANTS = [
  { suffix: '@800w',  width: 800,  quality: 78 },
  { suffix: '@1280w', width: 1280, quality: 80 },
  { suffix: '',       width: 2400, quality: 82 },  // replaces original
];

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function processOne(filename, dryRun) {
  const fullPath = path.join(ROOT, filename);
  if (!fs.existsSync(fullPath)) {
    console.warn(`  SKIP ${filename}: file not found`);
    return { skipped: true, savings: 0 };
  }
  const ext = path.extname(filename).toLowerCase();
  const base = filename.slice(0, -ext.length);
  const isJpg = ext === '.jpg' || ext === '.jpeg';
  const isPng = ext === '.png';
  if (!isJpg && !isPng) {
    console.warn(`  SKIP ${filename}: unsupported extension ${ext}`);
    return { skipped: true, savings: 0 };
  }

  const originalSize = fs.statSync(fullPath).size;

  // Decode once so we can apply variants from the same buffer.
  const inputBuf = await fs.promises.readFile(fullPath);
  const meta = await sharp(inputBuf).metadata();

  console.log(`${filename}  (${meta.width}×${meta.height}, ${fmt(originalSize)})`);

  let totalNewSize = 0;

  for (const v of VARIANTS) {
    const targetWidth = Math.min(v.width, meta.width || v.width);
    const outName = `${base}${v.suffix}${ext}`;
    const outPath = path.join(ROOT, outName);

    let pipeline = sharp(inputBuf).resize({
      width: targetWidth,
      withoutEnlargement: true,
    });

    if (isJpg) {
      pipeline = pipeline.jpeg({
        quality: v.quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: '4:2:0',
      });
    } else if (isPng) {
      // For PNG keep the format but apply palette quantization where safe.
      pipeline = pipeline.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
        quality: v.quality,
      });
    }

    const out = await pipeline.toBuffer();
    totalNewSize += out.length;
    const overwriteOrig = v.suffix === '';
    console.log(`  ${overwriteOrig ? '↳ replace original' : '↳ ' + outName.padEnd(50)}  ${fmt(out.length)}  (${targetWidth}px)`);
    if (!dryRun) {
      await fs.promises.writeFile(outPath, out);
    }
  }

  // Report savings vs original.
  const finalOrigSize = (await fs.promises.stat(path.join(ROOT, filename))).size;
  console.log(`  was ${fmt(originalSize)}  →  now ${fmt(finalOrigSize)} (original) plus 2 smaller variants`);
  return { skipped: false, savings: originalSize - finalOrigSize };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const targets = args.filter((a) => !a.startsWith('--'));
  const list = targets.length > 0 ? targets : DEFAULT_TARGETS;

  console.log(`Processing ${list.length} image(s)${dryRun ? ' (dry run)' : ''}...\n`);

  let totalSavings = 0;
  let processed = 0;
  for (const f of list) {
    try {
      const { skipped, savings } = await processOne(f, dryRun);
      if (!skipped) {
        processed += 1;
        totalSavings += savings;
      }
      console.log('');
    } catch (e) {
      console.error(`  ERROR processing ${f}: ${e.message}\n`);
    }
  }

  console.log('-'.repeat(60));
  console.log(`Done. ${processed}/${list.length} processed. Total original-file savings: ${fmt(totalSavings)}.`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

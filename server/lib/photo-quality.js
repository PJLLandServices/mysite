// Photo quality — the deterministic image-quality gate (Patrick, Sep 28 2026).
//
// "I do not want blurry or low-resolution product photos saved." Before an
// image can be a strong candidate, let alone approved:
//
//   imageUrlHints / familyKeyOf / rankImageUrls
//       Prefer the highest-resolution asset a product page offers. Sites
//       publish one picture under several URLs (SiteOne: image-thumb__N__
//       thumbnail 96px / __pdpIcon 515px / __zoom 1200px, same "86012-1"
//       family). A thumbnail URL is never used when a larger member of the
//       same family is on the page. The hints only ORDER the downloads;
//       the measured pixels decide.
//   sharpnessOf
//       Edge strength: the mean of the strongest 0.1% of |Laplacian| values
//       on a ≤512px greyscale working copy. Unlike whole-frame variance it
//       does not punish a small product on a large white field (a nozzle
//       render scored 85 by variance but 150 by edge strength). Measured
//       2026-09-28 on SiteOne's PCM-300 zoom: native 309; gaussian blur
//       σ1.5 155, σ3 45; a 300px source upscaled to 1200 ~120; a 96px
//       thumbnail blown up to 1200 ~19; a sharp 200px render on 1200px of
//       white 150, the same blurred 32.
//   gradeImage
//       reject  — obviously too small (< REJECT_LONGEST) or blurry: never
//                 stored as a candidate, noted in the diagnostics.
//       low     — under MIN_LONGEST on the longest side, or soft: kept as a
//                 candidate marked "low quality — review needed"; can never
//                 back a Confident result (qualityCap).
//       ok/good — ≥ MIN_LONGEST and sharp; good from GOOD_LONGEST up.
//
// Thresholds, from the live catalog on 2026-09-28 (100 live photos: 30 were
// 96px SiteOne thumbnails, 53 were under 800px; the same pages carried a
// 1200px zoom image): source at least ~800px on its longest side, 1000+
// preferred, as Patrick asked. No model, no network in this file.

const MIN_LONGEST = 800;      // below this: low quality, review needed, never Confident
const GOOD_LONGEST = 1000;    // "preferably 1000–1600+ when available"
const REJECT_LONGEST = 300;   // obviously too small: not a candidate at all
const SHARP_MIN = 90;         // edge strength below this: soft (low)
const BLUR_REJECT = 40;       // and below this: blurry (reject)
const WORK_SIZE = 512;
const EDGE_FRACTION = 0.001;  // the strongest 0.1% of edges decide

// Edge strength on a greyscale copy no larger than WORK_SIZE (never
// enlarged): the mean of the strongest EDGE_FRACTION of absolute Laplacian
// (4-neighbour) responses. A sharp edge anywhere in the frame scores; a
// smear scores nowhere. Tiny images are caught by the size gate first.
async function sharpnessOf(buffer, sharp) {
  const { data, info } = await sharp(buffer, { limitInputPixels: 50e6 })
    .rotate().greyscale()
    .resize({ width: WORK_SIZE, height: WORK_SIZE, fit: "inside", withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  if (w < 3 || h < 3) return 0;
  const n = (w - 2) * (h - 2);
  const lap = new Uint16Array(n);
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      lap[k++] = Math.abs(-4 * data[i] + data[i - 1] + data[i + 1] + data[i - w] + data[i + w]);
    }
  }
  lap.sort(); // ascending (typed arrays sort numerically)
  const count = Math.max(16, Math.floor(n * EDGE_FRACTION));
  let sum = 0;
  for (let i = n - count; i < n; i++) sum += lap[i];
  return sum / count;
}

function gradeImage({ width, height, sharpness = null } = {}) {
  const w = Number(width) || 0, h = Number(height) || 0;
  const longest = Math.max(w, h);
  const s = sharpness == null ? null : Number(sharpness);
  const dims = `${w}×${h}`;
  if (!longest) return { grade: "reject", longest, width: w, height: h, sharpness: s, reason: "no readable dimensions" };
  if (longest < REJECT_LONGEST) return { grade: "reject", longest, width: w, height: h, sharpness: s, reason: `too small (${dims}, under ${REJECT_LONGEST} px)` };
  if (s !== null && s < BLUR_REJECT) return { grade: "reject", longest, width: w, height: h, sharpness: s, reason: `blurry (${dims}, sharpness ${s.toFixed(0)})` };
  const reasons = [];
  if (longest < MIN_LONGEST) reasons.push(`low resolution (${dims}, under ${MIN_LONGEST} px)`);
  if (s !== null && s < SHARP_MIN) reasons.push(`soft focus (sharpness ${s.toFixed(0)})`);
  if (reasons.length) return { grade: "low", longest, width: w, height: h, sharpness: s, reason: reasons.join("; ") };
  return { grade: longest >= GOOD_LONGEST ? "good" : "ok", longest, width: w, height: h, sharpness: s, reason: `${dims}, sharp` };
}

// A Confident result needs an ok/good photo. Low quality holds the part at
// To be determined with the reason spelled out; the evidence checks that
// produced the tier are untouched (this runs AFTER tierFor).
function qualityCap(tier, quality) {
  if (!tier || !quality) return tier;
  if (tier.tier === "confident" && quality.grade !== "ok" && quality.grade !== "good") {
    return { ...tier, tier: "tbd", reason: `Every check passed, but the best photo is ${quality.reason} — a sharper, larger image is needed before it can go live.`, qualityCapped: true };
  }
  return tier;
}

// ------------------------------------------------------------- URL hints

const SMALL_WORDS = /(^|[^a-z])(thumb|thumbnail|thumbs|icon|icons|pdpicon|small|mini|tiny|swatch|preview|sm|xs)([^a-z]|$)/i;
const LARGE_WORDS = /(^|[^a-z])(zoom|large|xlarge|original|originals|full|fullsize|master|hires|hi-res|xl|xxl|big|huge)([^a-z]|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|$)/i;

function decodedPath(url) {
  try { const u = new URL(url); return decodeURIComponent(u.pathname) + (u.search || ""); } catch { return String(url || ""); }
}
// What the URL says about the size, as an ordering hint only. Explicit
// dimensions (800x800, w_800, 1200w, width=1200) win; otherwise words
// (zoom/large/original vs thumb/icon/small). 0 = says nothing.
function imageUrlHints(url) {
  const p = decodedPath(url);
  const parts = p.split("/").filter(Boolean);
  // SiteOne (SAP Commerce) names every variant "image-thumb__<id>__<variant>",
  // so the container word "thumb" says nothing; only the variant does.
  const tail = parts.slice(-3).join("/").replace(/image-thumb__\d+__/gi, "variant-");
  let dim = 0;
  for (const m of tail.matchAll(/(\d{2,4})x(\d{2,4})/gi)) dim = Math.max(dim, Math.max(+m[1], +m[2]));
  for (const m of tail.matchAll(/(?:[_\-/]w_?|[?&]w(?:idth)?=|width=)(\d{2,4})(?!\d)/gi)) dim = Math.max(dim, +m[1]);
  for (const m of tail.matchAll(/[_\-@](\d{3,4})w?\.(?:jpe?g|png|webp)/gi)) dim = Math.max(dim, +m[1]);
  let sizeHint = dim ? Math.min(dim, 4000) : 0;
  if (!dim && LARGE_WORDS.test(tail)) sizeHint = 1500;
  if (SMALL_WORDS.test(tail)) sizeHint = dim ? Math.min(sizeHint, 400) : 100;
  return { sizeHint, family: familyKeyOf(url) };
}
// One picture published at several sizes shares a "family": the filename
// with size tokens, content hashes and variant words removed. SiteOne's
// three variants of 86012-1 all key to "86012-1"; unrelated images do not.
function familyKeyOf(url) {
  const p = decodedPath(url).split("?")[0];
  let name = (p.split("/").pop() || "").toLowerCase();
  name = name.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
  name = name.replace(/\.[0-9a-f]{6,}$/g, "").replace(/[-_][0-9a-f]{8,}$/g, "");
  name = name.replace(/[-_]?\d{2,4}x\d{2,4}/g, "").replace(/[-_@]\d{3,4}w?$/g, "").replace(/@\dx$/g, "");
  name = name.replace(/[-_](thumb|thumbnail|icon|small|mini|tiny|medium|large|xlarge|zoom|original|full|master|hires|xl|sm|md|lg)$/g, "");
  return name.replace(/[-_.]+$/g, "");
}

// Every image-looking URL on the page (attributes, srcset, inline JSON),
// absolute, https only, skipping logos/icons/sprites. Used to find the
// larger members of a product image's family.
function collectImageUrls(html, pageUrl, { skip = null } = {}) {
  const s = String(html || "");
  const out = new Set();
  const add = (raw) => {
    if (!raw) return;
    let abs;
    try { abs = new URL(String(raw).trim().replace(/&amp;/g, "&"), pageUrl); } catch { return; }
    if (abs.protocol !== "https:") return;
    const u = abs.toString();
    if (!IMAGE_EXT.test(u)) return;
    if (skip && skip.test(u)) return;
    out.add(u);
  };
  for (const m of s.matchAll(/(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>()\\]*)?/gi)) add(m[0].startsWith("//") ? "https:" + m[0] : m[0]);
  for (const m of s.matchAll(/(?:src|href|content|data-[a-z0-9-]+)\s*=\s*["'](\/[^"']+?\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["']/gi)) add(m[1]);
  for (const m of s.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) for (const c of m[1].split(",")) add(c.trim().split(/\s+/)[0]);
  return [...out];
}

// images: the trusted extraction (og:image, JSON-LD, product <img>), in
// trust order. Returns the URLs to TRY, best first: for each image's
// family, the largest-hinted member found anywhere on the page comes
// before the image itself; families keep their trust order; duplicates
// dropped; at most `max`.
function rankImageUrls(images, { html = "", pageUrl = "", max = 4, skip = null } = {}) {
  const all = html ? collectImageUrls(html, pageUrl, { skip }) : [];
  const hintOf = new Map();
  const hint = (u) => { if (!hintOf.has(u)) hintOf.set(u, imageUrlHints(u)); return hintOf.get(u); };
  const out = [];
  const seen = new Set();
  const push = (url, via, note) => { if (!url || seen.has(url)) return; seen.add(url); out.push({ url, via, sizeHint: hint(url).sizeHint, ...(note ? { upgradedFrom: note } : {}) }); };
  for (const im of images || []) {
    const h = hint(im.url);
    const family = h.family
      ? all.filter((u) => u !== im.url && hint(u).family === h.family && hint(u).sizeHint > h.sizeHint).sort((a, b) => hint(b).sizeHint - hint(a).sizeHint)
      : [];
    for (const u of family) push(u, `${im.via}:larger`, im.url);
    push(im.url, im.via);
  }
  return out.slice(0, max);
}

module.exports = {
  MIN_LONGEST, GOOD_LONGEST, REJECT_LONGEST, SHARP_MIN, BLUR_REJECT, WORK_SIZE,
  sharpnessOf, gradeImage, qualityCap,
  imageUrlHints, familyKeyOf, collectImageUrls, rankImageUrls
};

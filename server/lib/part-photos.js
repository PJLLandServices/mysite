// Part photos — one verified product photo per real-world fitting.
//
// Patrick checks a part number once and from then on recognises the part
// by its picture (Linear P-PJL-35). So a wrong-but-plausible photo is worse
// than none, and the whole module is organised around ONE rule:
// photoStateFor() decides whether a photo may be shown, and every reader
// (the /api/parts merge that feeds the picker, the photo admin page, the
// review screen in M3) asks it rather than testing fields itself.
//
// Storage (all under DATA_DIR, i.e. the Render disk):
//   part-photo-groups.json  { "PG-0001": group }  one per real fitting
//   part-photo-links.json   { sku: link }          which fitting a SKU is
//   part-photos/<sha256>/{160,480,1200}.webp       content-addressed images
//   part-photos-log.jsonl                          append-only audit trail
//
// Why groups: SiteOne and Central can each sell the same 1" PVC tee under
// their own SKU. Both SKUs link to one group, so they share one photo, and
// replacing it replaces it for every SKU that means that fitting.
//
// Why the link carries a fingerprint: when a part's number or description
// is edited, the photo was matched to something that no longer exists.
// Rather than hook every write path that can edit a part (PATCH, xlsx
// import, and whatever comes next), the link remembers what the part was
// when it was matched, and the rule compares. A drifted part hides its
// photo until Patrick reconfirms it — no write path can forget to do that.
//
// Images: only resized. No crop, no flip, no mirror, no rotation of our
// own (CLAUDE.local.md). The one transform is honouring the file's OWN
// EXIF orientation flag, because the re-encode drops EXIF: without it a
// phone photo that displays upright would come out sideways. So the
// output displays exactly as the original did.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const dns = require("node:dns");
const { writeJsonAtomic, withStoreLocks } = require("./atomic-json");

const SIZES = [160, 480, 1200];
const HASH_RE = /^[a-f0-9]{64}$/;
// Group tiers. "approved" = Patrick set or approved it. "confident" = the
// M3 AI checks all passed. Only those two ever reach the picker.
const SHOWABLE_GROUP_TIERS = new Set(["approved", "confident"]);
// Link tiers. "confirmed" = Patrick linked it. "confident" = M3 grouping
// passed. "tbd" waits on the review screen.
const SHOWABLE_LINK_TIERS = new Set(["confirmed", "confident"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- the rule

function norm(s) {
  return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
}

// What the part WAS when its photo was matched. Only the identity fields:
// a price or supplier change does not change what the part looks like.
function fingerprintOf(part) {
  if (!part) return "";
  return `${norm(part.partNumber || part.sku)}|${norm(part.description)}`;
}

// THE rule. Returns { state, group } where state is one of:
//   verified       — may be shown
//   none           — no photo yet (not linked, or the group has none)
//   tbd            — something is waiting on the review screen
//   not_confident  — no reliable photo exists
//   changed        — the part was edited after the photo was matched
// Only "verified" carries a photo. The order matters: a To-be-determined
// LINK hides even a verified group's photo, because the question "is this
// SKU really that fitting?" was never answered.
function photoStateFor(sku, part, groups, links, fileExists) {
  const link = links && links[sku];
  if (!link || !part) return { state: "none", group: null };
  const group = groups && groups[link.groupId];
  if (!group) return { state: "none", group: null };
  if (!SHOWABLE_LINK_TIERS.has(link.linkTier)) return { state: "tbd", group };
  if (link.fingerprint !== fingerprintOf(part)) return { state: "changed", group };
  if (group.tier === "not_confident") return { state: "not_confident", group };
  if (group.tier === "tbd") return { state: "tbd", group };
  if (!SHOWABLE_GROUP_TIERS.has(group.tier) || !group.photo) return { state: "none", group };
  if (!HASH_RE.test(group.photo.hash || "")) return { state: "none", group };
  if (fileExists && !fileExists(group.photo.hash)) return { state: "none", group };
  return { state: "verified", group };
}

// thumb / thumb2x are the normalized square tile images (part found,
// centred, contained); largeMobile / large are the untouched photo.
function photoUrls(hash) {
  const base = `/api/part-photos/${hash}`;
  return { thumb: `${base}/t160.webp`, thumb2x: `${base}/t320.webp`, largeMobile: `${base}/480.webp`, large: `${base}/1200.webp` };
}

// Attach `photo` and `photoState` to every part, in place. Pure apart from
// the fileExists callback. Candidate images are never exposed here: a part
// that is not "verified" gets photo: null and nothing else.
// "Default for this fitting" (P-PJL-35 M2a). When several part numbers
// are the same real fitting, the picker shows ONE row, and that row's
// description, part #, price, supplier chip and main Add all come from the
// fitting's default part. The rule, in order:
//   1. the default Patrick chose on the Part photos page, if it is still a
//      visible member of the fitting;
//   2. otherwise the canonical part: the one from the original catalog
//      (parts.json) when exactly one member is;
//   3. otherwise the member that was in the fitting first (earliest link),
//      i.e. the part the others were linked TO;
//   4. ties by part number.
// Never "whichever part received the photo", and never a supplier rule.
function fittingDefaultFor(group, memberSkus, links, isBaseline) {
  if (!memberSkus.length) return { sku: null, chosen: false };
  if (group && group.defaultSku && memberSkus.includes(group.defaultSku)) return { sku: group.defaultSku, chosen: true };
  const baseline = isBaseline ? memberSkus.filter((s) => isBaseline(s)) : [];
  if (baseline.length === 1) return { sku: baseline[0], chosen: false };
  const pool = baseline.length > 1 ? baseline : memberSkus;
  const at = (s) => (links[s] && links[s].firstLinkedAt) || (links[s] && links[s].at) || "";
  // Two links can share one millisecond (PJL-105): then the order they were
  // written in decides (firstLinkSeq, see keepFirstLinked), not the SKU.
  // Records written before the sequence existed fall back to the SKU.
  const seq = (s) => (links[s] && Number.isFinite(links[s].firstLinkSeq) ? links[s].firstLinkSeq : null);
  const bySeq = (a, b) => (seq(a) !== null && seq(b) !== null && seq(a) !== seq(b) ? seq(a) - seq(b) : 0);
  const sorted = [...pool].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : bySeq(a, b) || a.localeCompare(b)));
  return { sku: sorted[0], chosen: false };
}

function mergeIntoCatalog(parts, groups, links, fileExists, { isBaseline } = {}) {
  const states = {};
  for (const [sku, part] of Object.entries(parts || {})) {
    states[sku] = photoStateFor(sku, part, groups, links, fileExists);
  }
  // Which visible parts share each verified group — "same fitting as".
  const byGroup = {};
  for (const [sku, st] of Object.entries(states)) {
    if (st.state === "verified") (byGroup[links[sku].groupId] ||= []).push(sku);
  }
  const defaults = {};
  for (const [groupId, members] of Object.entries(byGroup)) {
    defaults[groupId] = fittingDefaultFor(groups[groupId], members, links, isBaseline);
  }
  for (const [sku, part] of Object.entries(parts || {})) {
    const st = states[sku];
    part.photoState = st.state;
    if (st.state !== "verified") { part.photo = null; continue; }
    const g = st.group;
    const groupId = links[sku].groupId;
    part.photo = {
      groupId,
      ...photoUrls(g.photo.hash),
      width: g.photo.width || null,
      height: g.photo.height || null,
      method: (g.source && g.source.method) || null,
      sourceDomain: (g.source && g.source.domain) || null,
      approvedBy: g.approvedBy || null,
      approvedAt: g.approvedAt || null,
      sharedWith: byGroup[groupId].filter((s) => s !== sku).sort(),
      // Only VERIFIED members are part of the picker's one-row fitting; a
      // member waiting for review or hidden after an edit stays its own row.
      fittingDefaultSku: defaults[groupId].sku,
      fittingDefaultChosen: defaults[groupId].chosen
    };
  }
  return parts;
}

// ------------------------------------------------------- safe URL fetching

// Anything that is not the public internet. An image URL is fetched BY THE
// SERVER, so a URL pointing at localhost or the cloud metadata address
// would make the server read its own insides.
const BLOCKED = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) BLOCKED.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]
]) BLOCKED.addSubnet(addr, bits, "ipv6");

function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !BLOCKED.check(ip, "ipv6");
  }
  return !BLOCKED.check(ip, "ipv4");
}

async function assertPublicHost(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("That address isn't on the public internet.");
    return;
  }
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error("That website couldn't be found."); }
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new Error("That address isn't on the public internet.");
  }
}

// Fetch an image from a URL Patrick pasted (and, in M3, one the AI found).
// https only, public addresses only (re-checked on every redirect), image
// content only, capped size and time.
// Best-effort browser-like headers (Patrick, Sep 27 2026): some sites refuse
// a bare Node fetch. This is ordinary request shaping only — no proxies, no
// browser automation, nothing that works around a challenge page.
const BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "accept-language": "en-CA,en;q=0.9"
});

async function fetchImageSafely(rawUrl, {
  fetchImpl = globalThis.fetch,
  lookup = dns.promises.lookup,
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = 10_000,
  maxRedirects = 3
} = {}) {
  let url;
  try { url = new URL(String(rawUrl || "").trim()); } catch { throw new Error("That isn't a valid link."); }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:") throw new Error("Only https:// image links are accepted.");
    if (url.username || url.password) throw new Error("Links with a login in them aren't accepted.");
    await assertPublicHost(url.hostname, lookup);
    const res = await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "image/*", ...BROWSER_HEADERS }
    });
    if (res.status >= 300 && res.status < 400) {
      if (hop >= maxRedirects) throw new Error("That link redirects too many times.");
      const loc = res.headers.get("location");
      if (!loc) throw new Error("That link redirects nowhere.");
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) {
      const e = new Error(`The image couldn't be downloaded (HTTP ${res.status}).`);
      e.transient = res.status === 429 || res.status >= 500;
      throw e;
    }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("image/") || type.includes("svg")) {
      throw new Error("That link isn't an image. Use the link to the picture itself.");
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("That image is too large (8 MB max).");
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error("That image is too large (8 MB max).");
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), finalUrl: url.toString() };
  }
}

// Fetch a product PAGE for the deterministic part-number check (M3). The
// same protections as fetchImageSafely — https only, public addresses only
// (re-checked on every redirect), capped size and time — but HTML only.
// The server reads the page itself: the part number must be found in what
// WE downloaded, never in what a model says it saw.
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
async function fetchPageSafely(rawUrl, {
  fetchImpl = globalThis.fetch,
  lookup = dns.promises.lookup,
  maxBytes = MAX_PAGE_BYTES,
  timeoutMs = 15_000,
  maxRedirects = 5
} = {}) {
  let url;
  try { url = new URL(String(rawUrl || "").trim()); } catch { throw new Error("That isn't a valid link."); }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:") throw new Error("Only https:// pages are read.");
    if (url.username || url.password) throw new Error("Links with a login in them aren't read.");
    await assertPublicHost(url.hostname, lookup);
    const res = await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/xhtml+xml", ...BROWSER_HEADERS }
    });
    if (res.status >= 300 && res.status < 400) {
      if (hop >= maxRedirects) throw new Error("That page redirects too many times.");
      const loc = res.headers.get("location");
      if (!loc) throw new Error("That page redirects nowhere.");
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) {
      const e = new Error(`The page couldn't be read (HTTP ${res.status}).`);
      e.transient = res.status === 429 || res.status >= 500;
      throw e;
    }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("html")) throw new Error("That link isn't a web page.");
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) break; // the product text is near the top; keep what we have
      chunks.push(Buffer.from(chunk));
    }
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: url.toString() };
  }
}

// ------------------------------------------------------- image processing

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "tiff", "heif"]);

// Resize only. `.rotate()` with NO argument applies the file's own EXIF
// orientation and nothing else — it never adds a rotation or a flip — so
// the result displays exactly as the original. No flip, flop or
// rotate(angle) appears in this module, and the only extract is
// normalizeThumbs' plain-background trim; the test pins both.
async function processImage(buffer, sharp) {
  if (!buffer || !buffer.length) throw new Error("The image was empty.");
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: 50e6 }).metadata(); }
  catch { throw new Error("That doesn't look like an image we can read. Try a JPG or PNG."); }
  if (!ACCEPTED_FORMATS.has(meta.format)) throw new Error("That image type isn't supported. Try a JPG or PNG.");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const variants = {};
  let width = null, height = null;
  for (const size of SIZES) {
    const { data, info } = await sharp(buffer, { limitInputPixels: 50e6 })
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    variants[size] = data;
    if (size === 1200) { width = info.width; height = info.height; }
  }
  // The square tile thumbnail is an improvement, not a requirement: if it
  // can't be made, the photo still saves and the tile falls back to the
  // plain resized photo (resolveImageFile).
  let thumbs = null;
  try { thumbs = await normalizeThumbs(buffer, sharp); }
  catch (err) { console.warn("[part-photos] normalized thumbnail failed; tile will use the plain photo:", err?.message); }
  return { hash, variants, width, height, thumbs: thumbs ? thumbs.variants : null, thumbInfo: thumbs ? { trimmed: thumbs.trimmed } : null };
}

// ------------------------------------------------- normalized thumbnails
//
// The picker tile is a square. A tall, narrow part (a Pro-Spray body) shot
// on a wide white background comes out as a sliver if the whole photo is
// fitted, and ran out of the tile before #321. So the TILE uses its own
// normalized square thumbnail (Patrick, Sep 26 2026):
//
//   1. find the part: only when the photo's border is a plain, even
//      background (BG_UNIFORM_MIN of border pixels within BG_TOLERANCE of
//      its median colour). A busy background is never trimmed.
//   2. keep the part's bounding box PLUS a margin of original pixels
//      (THUMB_MARGIN of its longer side) — so a white fitting's faint
//      edge on white stays inside the frame even if it read as background.
//   3. fit that, whole, into a square canvas: contain, centred, padded with
//      the photo's own background colour. Aspect ratio kept; never cover.
//
// What is removed is only plain border well outside the part; the part is
// never cut (the test proves the kept region always contains every
// non-background pixel). The large 480/1200 views are untouched.
const THUMB_SIZES = [160, 320];
const THUMB_MARGIN = 0.08;
const BG_TOLERANCE = 16;
const BG_UNIFORM_MIN = 0.92;
const THUMB_WORK_MAX = 2000;

// data: raw RGB pixels. Returns { trimmed, region, subject, background }.
function findSubjectRegion(data, width, height, channels = 3) {
  const full = { left: 0, top: 0, width, height };
  const at = (x, y) => { const i = (y * width + x) * channels; return [data[i], data[i + 1], data[i + 2]]; };
  const border = [];
  const stepX = Math.max(1, Math.floor(width / 400)), stepY = Math.max(1, Math.floor(height / 400));
  for (let x = 0; x < width; x += stepX) { border.push(at(x, 0), at(x, height - 1)); }
  for (let y = 0; y < height; y += stepY) { border.push(at(0, y), at(width - 1, y)); }
  const median = (k) => { const v = border.map((p) => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [median(0), median(1), median(2)];
  const isBg = (p) => Math.abs(p[0] - bg[0]) <= BG_TOLERANCE && Math.abs(p[1] - bg[1]) <= BG_TOLERANCE && Math.abs(p[2] - bg[2]) <= BG_TOLERANCE;
  const share = border.filter(isBg).length / border.length;
  if (share < BG_UNIFORM_MIN) return { trimmed: false, region: full, subject: null, background: null };

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (Math.abs(data[i] - bg[0]) > BG_TOLERANCE || Math.abs(data[i + 1] - bg[1]) > BG_TOLERANCE || Math.abs(data[i + 2] - bg[2]) > BG_TOLERANCE) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { trimmed: false, region: full, subject: null, background: bg };
  const subject = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const margin = Math.ceil(Math.max(subject.width, subject.height) * THUMB_MARGIN) + 1;
  const left = Math.max(0, minX - margin), top = Math.max(0, minY - margin);
  const right = Math.min(width, maxX + 1 + margin), bottom = Math.min(height, maxY + 1 + margin);
  return { trimmed: true, region: { left, top, width: right - left, height: bottom - top }, subject, background: bg };
}

async function normalizeThumbs(buffer, sharp) {
  // Honour EXIF orientation only (as processImage does), flatten any
  // transparency onto white, and work at a bounded size.
  const { data, info } = await sharp(buffer, { limitInputPixels: 50e6 })
    .rotate()
    .resize({ width: THUMB_WORK_MAX, height: THUMB_WORK_MAX, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const found = findSubjectRegion(data, info.width, info.height, info.channels);
  const bg = found.background || [255, 255, 255];
  const variants = {};
  for (const size of THUMB_SIZES) {
    variants[size] = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      // The ONE region cut in this module: plain background outside the
      // part + margin, as computed above. Never inside the part.
      .extract(found.region)
      .resize({ width: size, height: size, fit: "contain", position: "centre", background: { r: bg[0], g: bg[1], b: bg[2] } })
      .webp({ quality: 82 })
      .toBuffer();
  }
  return { variants, trimmed: found.trimmed, region: found.region, subject: found.subject, workSize: { width: info.width, height: info.height } };
}

// ------------------------------------------------------------ the store

function createPartPhotos({ dataDir, sharp }) {
  const GROUPS_FILE = path.join(dataDir, "part-photo-groups.json");
  const LINKS_FILE = path.join(dataDir, "part-photo-links.json");
  const IMG_DIR = path.join(dataDir, "part-photos");
  const LOG_FILE = path.join(dataDir, "part-photos-log.jsonl");

  // A missing store is empty. A store that exists but doesn't parse is
  // DAMAGED: treating it as empty would let the next write erase every
  // photo (the same rule as atomic-json's parseJsonArrayStore).
  function parseMap(raw, file) {
    let v;
    try { v = JSON.parse(raw); }
    catch (err) {
      const e = new Error(`${path.basename(file)} is unreadable (${err.message}) — refusing to treat it as empty.`);
      e.code = "STORE_CORRUPT"; throw e;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      const e = new Error(`${path.basename(file)} is not a JSON object — refusing to treat it as empty.`);
      e.code = "STORE_CORRUPT"; throw e;
    }
    return v;
  }
  function readMapSync(file) {
    if (!fsSync.existsSync(file)) return {};
    return parseMap(fsSync.readFileSync(file, "utf8"), file);
  }
  async function readMap(file) {
    let raw;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (err) { if (err.code === "ENOENT") return {}; throw err; }
    return parseMap(raw, file);
  }

  // size: 160 | 480 | 1200 (the photo, resized) or "t160" | "t320" (the
  // normalized square thumbnail).
  function imagePath(hash, size) {
    if (!HASH_RE.test(String(hash))) return null;
    const s = String(size);
    if (SIZES.includes(Number(s))) return path.join(IMG_DIR, hash, `${Number(s)}.webp`);
    if (/^t(160|320)$/.test(s)) return path.join(IMG_DIR, hash, `${s}.webp`);
    return null;
  }

  async function writeFileAtomic(p, buf) {
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, p);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // One generation per photo at a time. Simultaneous first requests for
  // the same older photo (the picker asks for t160 and t320 together)
  // share ONE in-flight build instead of racing two writers to one file.
  const thumbBuilds = new Map();

  // Photos saved before normalized thumbnails existed have no t160/t320.
  // Make them on first request from the stored 1200 image (EXIF already
  // applied there), so nothing has to be re-uploaded.
  async function ensureThumb(hash, size) {
    const p = imagePath(hash, size);
    if (!p || !/^t(160|320)$/.test(String(size))) return p;
    if (fsSync.existsSync(p)) return p;
    const src = imagePath(hash, 1200);
    if (!src || !fsSync.existsSync(src)) return p;
    let build = thumbBuilds.get(hash);
    if (!build) {
      build = (async () => {
        const made = await normalizeThumbs(await fs.readFile(src), sharp);
        for (const s of THUMB_SIZES) {
          const out = imagePath(hash, `t${s}`);
          if (!fsSync.existsSync(out)) await writeFileAtomic(out, made.variants[s]);
        }
      })().finally(() => thumbBuilds.delete(hash));
      thumbBuilds.set(hash, build);
    }
    await build;
    return p;
  }

  // Which file to serve for a requested image. A tile thumbnail (t160/t320)
  // that is missing and can't be made falls back to the plain resized photo
  // of similar size — the tile's contain styling keeps it whole and inside
  // the tile — so a verified part never shows a broken image. `fallback`
  // tells the route not to cache it forever under the thumbnail's URL.
  async function resolveImageFile(hash, size) {
    const p = imagePath(hash, size);
    if (!p) return null;
    if (!/^t(160|320)$/.test(String(size))) return { path: p, fallback: false };
    try {
      await ensureThumb(hash, size);
      if (fsSync.existsSync(p)) return { path: p, fallback: false };
    } catch (err) {
      console.warn(`[part-photos] thumbnail ${size} for ${hash.slice(0, 12)} failed; serving the plain photo:`, err?.message);
    }
    return { path: imagePath(hash, size === "t320" ? 480 : 160), fallback: true };
  }
  function fileExists(hash) {
    return fsSync.existsSync(path.join(IMG_DIR, hash, "160.webp"));
  }

  // Synchronous, for rebuildCatalogFromOverrides (which is synchronous).
  function readStoresSync() {
    return { groups: readMapSync(GROUPS_FILE), links: readMapSync(LINKS_FILE) };
  }
  function mergeInto(parts, opts = {}) {
    const { groups, links } = readStoresSync();
    return mergeIntoCatalog(parts, groups, links, fileExists, opts);
  }

  async function log(entry) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  }

  async function saveImage(processed) {
    const dir = path.join(IMG_DIR, processed.hash);
    await fs.mkdir(dir, { recursive: true });
    for (const size of SIZES) {
      const p = path.join(dir, `${size}.webp`);
      if (!fsSync.existsSync(p)) await fs.writeFile(p, processed.variants[size]);
    }
    for (const size of THUMB_SIZES) {
      const p = path.join(dir, `t${size}.webp`);
      if (!fsSync.existsSync(p) && processed.thumbs) await fs.writeFile(p, processed.thumbs[size]);
    }
  }

  function nextGroupId(groups) {
    let max = 0;
    for (const id of Object.keys(groups)) {
      const n = Number(String(id).replace(/^PG-/, ""));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `PG-${String(max + 1).padStart(4, "0")}`;
  }

  // Every write holds BOTH stores' locks: a photo change touches a group
  // and (for a first photo) a link, and the two must not interleave with
  // another request's link change.
  function mutate(fn) {
    return withStoreLocks([GROUPS_FILE, LINKS_FILE], async () => {
      const groups = await readMap(GROUPS_FILE);
      const links = await readMap(LINKS_FILE);
      const out = await fn(groups, links);
      await fs.mkdir(dataDir, { recursive: true });
      await writeJsonAtomic(GROUPS_FILE, groups);
      await writeJsonAtomic(LINKS_FILE, links);
      return out;
    });
  }

  function linkRecord(part, by) {
    return { linkTier: "confirmed", linkedBy: by, fingerprint: fingerprintOf(part), at: new Date().toISOString() };
  }
  // When a SKU first joined its fitting. Reconfirming or re-uploading the
  // photo must not make it "newer" — the fitting default's rule 3 reads it.
  // firstLinkSeq (PJL-105) is the ORDER links were first written in — a
  // counter, so two links in the same millisecond still have a first and a
  // second. Every link write runs under mutate()'s locks, so the next
  // number is simply one past the highest on file.
  function keepFirstLinked(prev, groupId, rec, links) {
    const same = prev && prev.groupId === groupId;
    const first = same ? (prev.firstLinkedAt || prev.at) : rec.at;
    const nextSeq = () => 1 + Object.values(links || {}).reduce((m, l) => (Number.isFinite(l && l.firstLinkSeq) ? Math.max(m, l.firstLinkSeq) : m), 0);
    const firstLinkSeq = same ? (Number.isFinite(prev.firstLinkSeq) ? prev.firstLinkSeq : undefined) : nextSeq();
    return { ...rec, firstLinkedAt: first, ...(firstLinkSeq !== undefined ? { firstLinkSeq } : {}) };
  }

  // Set Patrick's photo for the fitting this SKU is. If the SKU already
  // belongs to a group, the GROUP's photo changes — every SKU that is the
  // same fitting changes with it, which is the point. Otherwise a new
  // group is created for it.
  //
  // `source.method` is "upload" or "url". A filename is deliberately NOT
  // kept: a filename is never evidence of what an image shows.
  async function setPhoto(sku, part, buffer, { by, source }) {
    if (!part) throw new Error("Unknown part.");
    const processed = await processImage(buffer, sharp);
    await saveImage(processed);
    return mutate(async (groups, links) => {
      const now = new Date().toISOString();
      let groupId = links[sku] && groups[links[sku].groupId] ? links[sku].groupId : null;
      if (!groupId) {
        groupId = nextGroupId(groups);
        groups[groupId] = { id: groupId, label: part.description || sku, createdAt: now, history: [] };
      }
      const g = groups[groupId];
      if (g.photo && g.photo.hash !== processed.hash) {
        (g.history ||= []).push({ hash: g.photo.hash, replacedAt: now, replacedBy: by });
      }
      g.photo = { hash: processed.hash, width: processed.width, height: processed.height };
      g.tier = "approved";
      g.source = { method: source.method, ...(source.imageUrl ? { imageUrl: source.imageUrl, domain: new URL(source.imageUrl).hostname } : {}) };
      g.approvedBy = by;
      g.approvedAt = now;
      g.updatedAt = now;
      links[sku] = keepFirstLinked(links[sku], groupId, { groupId, ...linkRecord(part, by) }, links);
      const sharedWith = Object.keys(links).filter((s) => s !== sku && links[s].groupId === groupId);
      await log({ action: "photo.set", sku, groupId, hash: processed.hash, method: source.method, by, sharedWith });
      return { groupId, hash: processed.hash, sharedWith };
    });
  }

  async function setPhotoFromUrl(sku, part, imageUrl, { by, fetchOptions } = {}) {
    const { buffer, finalUrl } = await fetchImageSafely(imageUrl, fetchOptions);
    return setPhoto(sku, part, buffer, { by, source: { method: "url", imageUrl: finalUrl } });
  }

  // "This SKU is the same fitting as that one": share its group and photo.
  async function linkToGroup(sku, part, groupId, { by }) {
    if (!part) throw new Error("Unknown part.");
    return mutate(async (groups, links) => {
      if (!groups[groupId]) throw new Error("That photo group doesn't exist.");
      const previous = links[sku] ? links[sku].groupId : null;
      links[sku] = keepFirstLinked(links[sku], groupId, { groupId, ...linkRecord(part, by) }, links);
      await log({ action: "link.set", sku, groupId, previous, by });
      return { groupId, previous };
    });
  }

  async function unlink(sku, { by }) {
    return mutate(async (groups, links) => {
      const previous = links[sku] ? links[sku].groupId : null;
      delete links[sku];
      // A part that leaves the fitting stops being its chosen default.
      if (previous && groups[previous] && groups[previous].defaultSku === sku) delete groups[previous].defaultSku;
      await log({ action: "link.remove", sku, previous, by });
      return { previous };
    });
  }

  // After a part is edited its photo hides ("changed"). Reconfirming says
  // "I looked, it's still the right picture" and records the new identity.
  async function reconfirm(sku, part, { by }) {
    if (!part) throw new Error("Unknown part.");
    return mutate(async (groups, links) => {
      if (!links[sku]) throw new Error("That part has no photo to reconfirm.");
      links[sku] = keepFirstLinked(links[sku], links[sku].groupId, { ...links[sku], ...linkRecord(part, by) }, links);
      await log({ action: "link.reconfirm", sku, groupId: links[sku].groupId, by });
      return { groupId: links[sku].groupId };
    });
  }

  // Remove the photo from a whole group (every SKU sharing it). The image
  // files stay on disk — content-addressed and possibly shared — and the
  // group keeps its history for the audit trail.
  async function removeGroupPhoto(groupId, { by }) {
    return mutate(async (groups, links) => {
      const g = groups[groupId];
      if (!g) throw new Error("That photo group doesn't exist.");
      const now = new Date().toISOString();
      if (g.photo) (g.history ||= []).push({ hash: g.photo.hash, removedAt: now, removedBy: by });
      g.photo = null;
      g.tier = "none";
      g.updatedAt = now;
      const skus = Object.keys(links).filter((s) => links[s].groupId === groupId);
      await log({ action: "photo.remove", groupId, skus, by });
      return { groupId, skus };
    });
  }

  // ---- M3: AI photo inventory -----------------------------------------
  // Store a candidate image (resize only, content-addressed). Never live by
  // itself: it only becomes a photo through recordAiResult (Confident +
  // auto-approve) or Patrick's approval on the review page.
  async function saveCandidateImage(buffer) {
    const processed = await processImage(buffer, sharp);
    await saveImage(processed);
    return { hash: processed.hash, width: processed.width, height: processed.height };
  }

  // The stored bytes of a candidate (for the vision check).
  async function readCandidateImage(hash, size = 1200) {
    const p = imagePath(hash, size);
    if (!p) throw new Error("Bad image hash.");
    return fs.readFile(p);
  }

  // Record what the AI backfill decided for one SKU.
  //   result: { tier: confident|tbd|not_confident, kind, reason, runId,
  //             identified, candidates: [{ hash, width, height, source, checks, tier }],
  //             chosen: index of the best candidate or -1 }
  //   autoApprove: only then can a Confident result go live.
  // Safety: a fitting that already has a LIVE photo (Patrick's, or an
  // earlier auto-approval) is never touched — the AI never overwrites a
  // photo. To-be-determined and Not-confident results never go live.
  async function recordAiResult(sku, part, result, { autoApprove = false } = {}) {
    if (!part) throw new Error("Unknown part.");
    const { tier } = result;
    if (!["confident", "tbd", "not_confident"].includes(tier)) throw new Error(`Unknown tier: ${tier}`);
    return mutate(async (groups, links) => {
      const now = new Date().toISOString();
      const existing = links[sku] && groups[links[sku].groupId];
      if (existing && existing.photo && SHOWABLE_GROUP_TIERS.has(existing.tier)) {
        return { skipped: "already has a live photo", groupId: links[sku].groupId };
      }
      let groupId = existing ? links[sku].groupId : null;
      if (!groupId) {
        groupId = nextGroupId(groups);
        groups[groupId] = { id: groupId, label: part.description || sku, createdAt: now, history: [] };
      }
      const g = groups[groupId];
      if (!links[sku]) {
        // The SKU's own link to its photo group — not a claim that it is the
        // same fitting as anything else.
        links[sku] = keepFirstLinked(null, groupId, { groupId, linkTier: "confident", linkedBy: "auto:self", fingerprint: fingerprintOf(part), at: now }, links);
      }
      // An image Patrick rejected never comes back as a candidate (M3b).
      const rejected = new Set(g.rejectedHashes || []);
      const byHash = new Map((g.candidates || []).filter((c) => !rejected.has(c.hash)).map((c) => [c.hash, c]));
      for (const c of result.candidates || []) {
        if (!HASH_RE.test(String(c.hash || "")) || rejected.has(c.hash)) continue;
        byHash.set(c.hash, { hash: c.hash, width: c.width || null, height: c.height || null, source: c.source || {}, checks: c.checks || {}, tier: c.tier || null, runId: result.runId || null, foundAt: now, forSku: sku });
      }
      g.candidates = [...byHash.values()].slice(-12);
      g.ai = { tier, kind: result.kind || null, reason: result.reason || "", runId: result.runId || null, identified: result.identified || null, proposedBrand: result.proposedBrand || null, pages: Array.isArray(result.pages) ? result.pages.slice(0, 6) : [], at: now, forSku: sku };
      const chosen = result.chosen >= 0 ? (result.candidates || [])[result.chosen] : null;
      let live = false;
      const chosenRejected = !!(chosen && rejected.has(chosen.hash));
      if (tier === "confident" && autoApprove && chosen && !chosenRejected && HASH_RE.test(String(chosen.hash || ""))) {
        if (g.photo && g.photo.hash !== chosen.hash) (g.history ||= []).push({ hash: g.photo.hash, replacedAt: now, replacedBy: "auto:confident" });
        g.photo = { hash: chosen.hash, width: chosen.width || null, height: chosen.height || null };
        g.tier = "confident";
        g.source = { method: "ai", ...(chosen.source || {}) };
        g.approvedBy = "auto:confident";
        g.approvedAt = now;
        g.autoApprovedRun = result.runId || null;
        live = true;
      } else if (tier === "not_confident") {
        g.tier = "not_confident";
        g.reason = result.reason || "No reliable photo found.";
      } else {
        // TBD, or Confident while auto-approve is off: waits for Patrick.
        g.tier = "tbd";
        g.reason = chosenRejected ? "It found a photo you rejected before — needs a look." : tier === "confident" ? "Passed every check — waiting for your review (auto-approve is off)." : (result.reason || "Needs a look.");
      }
      g.updatedAt = now;
      await log({ action: "ai.result", sku, groupId, tier, live, autoApprove, runId: result.runId || null, candidates: (result.candidates || []).length });
      return { groupId, tier, live };
    });
  }

  // Automatic same-fitting link (manufacturer + manufacturer part # on
  // official pages — decided by photo-evidence.groupingDecision). Moves `sku`
  // into `targetSku`'s fitting. A photo Patrick approved himself is never
  // moved away from by automation; an AI auto-approved one can be, because
  // the two SKUs are the same fitting and get one photo (the SKU's old group
  // and its photo stay on file, unchanged).
  async function autoLinkSameFitting(sku, part, targetSku, { reason }) {
    if (!part) throw new Error("Unknown part.");
    return mutate(async (groups, links) => {
      const target = links[targetSku];
      if (!target || !groups[target.groupId]) return { skipped: "target has no fitting" };
      const own = links[sku] && groups[links[sku].groupId];
      const ownIsPatricks = own && own.photo && SHOWABLE_GROUP_TIERS.has(own.tier) && !String(own.approvedBy || "").startsWith("auto:");
      if (own && links[sku].groupId !== target.groupId && ownIsPatricks) return { skipped: "has its own photo, approved by Patrick" };
      // Both already show a live photo: the same image may merge; two
      // DIFFERENT live photos are never silently collapsed — Patrick picks.
      const tg = groups[target.groupId];
      const liveHash = (g) => (g && g.photo && SHOWABLE_GROUP_TIERS.has(g.tier) ? g.photo.hash : null);
      if (own && links[sku].groupId !== target.groupId && liveHash(own)) {
        if (!liveHash(tg)) return { skipped: "only this part has a live photo — link the other way", propose: false };
        if (liveHash(own) !== liveHash(tg)) return { skipped: "both have different live photos", propose: true };
      }
      if (links[sku] && links[sku].linkTier === "confirmed" && links[sku].linkedBy && !String(links[sku].linkedBy).startsWith("auto:") && links[sku].groupId !== target.groupId) {
        return { skipped: "Patrick linked it to a different fitting" };
      }
      const previous = links[sku] ? links[sku].groupId : null;
      links[sku] = keepFirstLinked(links[sku], target.groupId, { groupId: target.groupId, linkTier: "confident", linkedBy: "auto:mfr-part", fingerprint: fingerprintOf(part), at: new Date().toISOString() }, links);
      await log({ action: "link.auto", sku, groupId: target.groupId, previous, reason });
      return { groupId: target.groupId, previous };
    });
  }

  // ---- M3b: Patrick's review of AI results ---------------------------
  // Approve one of the AI's candidate images for this SKU's fitting. It
  // becomes an "approved" photo exactly as if Patrick had uploaded it, and
  // the SKU's link is re-recorded as his (confirmed, current fingerprint).
  async function approveCandidate(sku, part, hash, { by }) {
    if (!part) throw new Error("Unknown part.");
    if (!HASH_RE.test(String(hash || ""))) throw new Error("Choose a photo to approve.");
    return mutate(async (groups, links) => {
      const groupId = links[sku] && groups[links[sku].groupId] ? links[sku].groupId : null;
      const g = groupId && groups[groupId];
      const cand = g && (g.candidates || []).find((c) => c.hash === hash);
      if (!cand) throw new Error("That photo isn't one of this part's candidates.");
      if (!fileExists(hash)) throw new Error("That photo's file is missing — ask for a new search.");
      const now = new Date().toISOString();
      if (g.photo && g.photo.hash !== hash) (g.history ||= []).push({ hash: g.photo.hash, replacedAt: now, replacedBy: by });
      g.photo = { hash, width: cand.width || null, height: cand.height || null };
      g.tier = "approved";
      g.source = { method: "ai-reviewed", ...(cand.source || {}) };
      g.approvedBy = by;
      g.approvedAt = now;
      delete g.autoApprovedRun;
      delete g.reason;
      g.review = { action: "approved", by, at: now, hash };
      g.updatedAt = now;
      links[sku] = keepFirstLinked(links[sku], groupId, { groupId, ...linkRecord(part, by) }, links);
      const sharedWith = Object.keys(links).filter((s) => s !== sku && links[s].groupId === groupId);
      await log({ action: "review.approve", sku, groupId, hash, by, sharedWith });
      return { groupId, hash, sharedWith };
    });
  }

  // Reject the AI's result for this SKU: none of its candidates is right.
  // Rejected images are remembered so a later run can never auto-approve
  // them. Rejecting an AUTO-APPROVED photo also takes down every other
  // photo that went live by the same rule (same kind) in the same run and
  // sends it back to "To be determined" — the M3 plan's safety net.
  // A photo Patrick approved himself is not rejected here (Remove photo).
  async function rejectAiResult(sku, part, { by, reason = "" }) {
    if (!part) throw new Error("Unknown part.");
    return mutate(async (groups, links) => {
      const groupId = links[sku] && groups[links[sku].groupId] ? links[sku].groupId : null;
      const g = groupId && groups[groupId];
      if (!g || !g.ai) throw new Error("This part has no AI result to reject.");
      const live = !!(g.photo && SHOWABLE_GROUP_TIERS.has(g.tier));
      const auto = live && String(g.approvedBy || "").startsWith("auto:");
      if (live && !auto) throw new Error("This photo was approved by a person — use Remove photo instead.");
      const now = new Date().toISOString();
      const note = `Rejected by ${by}${reason ? `: ${reason}` : ""}`;
      const rejected = new Set(g.rejectedHashes || []);
      for (const c of g.candidates || []) rejected.add(c.hash);
      if (g.photo) rejected.add(g.photo.hash);
      g.rejectedHashes = [...rejected];
      if (g.photo) (g.history ||= []).push({ hash: g.photo.hash, removedAt: now, removedBy: by, reason: note });
      const runId = g.autoApprovedRun || null;
      const kind = g.ai.kind || null;
      g.photo = null;
      g.tier = "not_confident";
      g.reason = note;
      g.review = { action: "rejected", by, at: now, reason };
      delete g.autoApprovedRun;
      g.updatedAt = now;
      const sentBack = [];
      if (auto && runId) {
        for (const [id, other] of Object.entries(groups)) {
          if (id === groupId || other.autoApprovedRun !== runId || other.approvedBy !== "auto:confident") continue;
          if (!other.photo || !SHOWABLE_GROUP_TIERS.has(other.tier) || (other.ai && other.ai.kind) !== kind) continue;
          (other.history ||= []).push({ hash: other.photo.hash, removedAt: now, removedBy: by, reason: `Sent back: ${sku}'s auto-approval in the same run was rejected` });
          other.photo = null;
          other.tier = "tbd";
          other.reason = `Sent back for re-checking — another ${kind || ""} auto-approval in the same run (${sku}) was rejected.`.replace("  ", " ");
          delete other.autoApprovedRun;
          other.updatedAt = now;
          sentBack.push({ groupId: id, skus: Object.keys(links).filter((s) => links[s].groupId === id) });
        }
      }
      await log({ action: "review.reject", sku, groupId, by, reason, wasAutoApproved: auto, runId, sentBack });
      return { groupId, wasAutoApproved: auto, sentBack };
    });
  }

  // Patrick's deliberate "Default for this fitting". Only a part that is
  // linked to this fitting (confirmed) can be chosen.
  async function setFittingDefault(groupId, sku, part, { by }) {
    if (!part) throw new Error("Unknown part.");
    return mutate(async (groups, links) => {
      const g = groups[groupId];
      if (!g) throw new Error("That fitting doesn't exist.");
      const link = links[sku];
      if (!link || link.groupId !== groupId) throw new Error("That part isn't linked to this fitting.");
      if (!SHOWABLE_LINK_TIERS.has(link.linkTier) || link.fingerprint !== fingerprintOf(part)) {
        throw new Error("That part's link needs confirming before it can be the default.");
      }
      const previous = g.defaultSku || null;
      g.defaultSku = sku;
      g.updatedAt = new Date().toISOString();
      await log({ action: "fitting.default", groupId, sku, previous, by });
      return { groupId, defaultSku: sku, previous };
    });
  }

  async function snapshot() {
    return { groups: await readMap(GROUPS_FILE), links: await readMap(LINKS_FILE) };
  }

  return {
    imagePath, ensureThumb, resolveImageFile, fileExists, readStoresSync, mergeInto, snapshot,
    setPhoto, setPhotoFromUrl, linkToGroup, unlink, reconfirm, removeGroupPhoto, setFittingDefault,
    saveCandidateImage, readCandidateImage, recordAiResult, autoLinkSameFitting,
    approveCandidate, rejectAiResult
  };
}

module.exports = {
  createPartPhotos,
  photoStateFor, mergeIntoCatalog, fingerprintOf, photoUrls, fittingDefaultFor,
  isPublicAddress, fetchImageSafely, fetchPageSafely, processImage, normalizeThumbs, findSubjectRegion,
  SIZES, HASH_RE
};

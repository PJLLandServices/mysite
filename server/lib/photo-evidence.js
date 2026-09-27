// Photo evidence — the deterministic half of the M3 photo inventory
// (P-PJL-35). Everything here is plain code over plain inputs: no network,
// no model. The AI finds candidates and grades pictures; THIS file decides
// what that evidence is worth, so the rules can be read, tested and never
// argued with by a model.
//
//   normalizePartNumber / visibleProductText / partNumberOnPage
//       Is the exact part number in the page's VISIBLE PRODUCT TEXT?
//       Harmless formatting (spaces, dashes, case, punctuation) is ignored;
//       URLs, filenames, image alt text, link text, <title>, scripts and
//       styles never count (Patrick, Sep 27 2026).
//   parseSpec / pageMatchesSpec
//       For generic fittings: does the page describe the same fitting?
//   tierFor
//       Confident / To be determined / Not confident, from the checks.
//   pickCalibrationSample
//       The deliberate mixed sample for the first run (8 branded, 7 generic).
//   groupingDecision
//       Auto-link only on same manufacturer + same manufacturer part #,
//       backed by an official manufacturer page; everything else → review.

// Official manufacturer domains (subdomains included). The part-number check
// accepts any page it fetched itself, but only these count as "official"
// for the search's first pass and for automatic same-fitting links.
const MANUFACTURER_DOMAINS = {
  hunter: ["hunterirrigation.com", "hunterindustries.com"],
  rainbird: ["rainbird.com"],
  netafim: ["netafim.com", "netafimusa.com"],
  blulock: ["husqvarna-water.com", "hydrorain.com"],
  oilcreek: ["oilcreekplastics.com"],
  dawn: ["dawnindustries.com"],
  watts: ["watts.com"]
};
// Supplier sites: the search's second pass.
const SUPPLIER_DOMAINS = ["siteone.com", "centralpros.com"];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
function domainMatches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}
function isOfficialManufacturerPage(url, manufacturer) {
  const host = hostOf(url);
  return !!host && (MANUFACTURER_DOMAINS[manufacturer] || []).some((d) => domainMatches(host, d));
}

// ---------------------------------------------------------------- part #

// Uppercase alphanumerics only: "pgp-adj", "PGP ADJ" and "PGP.ADJ" are all
// "PGPADJ".
function normalizePartNumber(s) {
  return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
// Below this length a "match" is too easy to be evidence ("12Q", "1").
const MIN_PART_NUMBER_LENGTH = 4;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", times: "x", reg: "", trade: "" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : " ";
  });
}

// The words a person reads on the page, and nothing else. Removed first,
// with everything inside them: <head> (so <title> and meta), <script>,
// <style>, <noscript>, <template>, <svg>, comments, and <a>…</a> — link
// text never counts. Then every tag goes, which drops every attribute: a
// URL, an img src/filename or alt text can never reach the result.
function visibleProductText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["head", "script", "style", "noscript", "template", "svg", "a"]) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  }
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

// Does any of `partNumbers` appear in the visible text? Compared on
// normalized WHOLE-TOKEN runs (1–4 consecutive tokens), so "PGP-ADJ",
// "PGP ADJ" and "pgp adj" match PGPADJ, but "PGPADJ04" and "PGP ADJUSTABLE"
// do not — a bare substring test would find part numbers inside other
// words and codes.
function partNumberOnPage(html, partNumbers) {
  const wanted = [...new Set((partNumbers || []).map(normalizePartNumber).filter((p) => p.length >= MIN_PART_NUMBER_LENGTH))];
  if (!wanted.length) return { result: "unknown", reason: "No part number long enough to check.", matched: null };
  const text = visibleProductText(html);
  const tokens = text.split(" ").map(normalizePartNumber).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let n = 0; n < 4 && i + n < tokens.length; n++) {
      joined += tokens[i + n];
      if (wanted.includes(joined)) return { result: "pass", reason: "Exact part number in the page's visible text.", matched: joined };
      if (joined.length > 40) break;
    }
  }
  return { result: "fail", reason: "The part number is not in the page's visible product text.", matched: null };
}

// Supplier-code mapping (Patrick, Sep 27 2026). Our catalog number is often
// a distributor/internal code (HSPGPADJ) that the manufacturer's page never
// prints; the manufacturer prints its own model (PGP-ADJ). The code maps to
// the model ONLY when one product page on a known supplier or the official
// manufacturer site shows BOTH in its visible product text — never from the
// URL, filename, alt text, metadata, hidden code or the model's say-so.
function supplierCodeMapping(html, pageUrl, ours, theirs, manufacturer) {
  const host = hostOf(pageUrl);
  const trusted = SUPPLIER_DOMAINS.some((d) => domainMatches(host, d)) || isOfficialManufacturerPage(pageUrl, manufacturer);
  if (!trusted) return { result: "unknown", reason: "Not a supplier or manufacturer page." };
  const o = partNumberOnPage(html, ours), t = partNumberOnPage(html, theirs);
  if (o.result === "pass" && t.result === "pass" && o.matched !== t.matched) {
    return { result: "pass", reason: `${o.matched} → ${t.matched} shown together on ${host}.`, ours: o.matched, theirs: t.matched, pageUrl };
  }
  return { result: "unknown", reason: "The page doesn't show both numbers in its product text." };
}

// ------------------------------------------------------------ generic spec

const TYPE_WORDS = {
  tee: ["tee", "tees"],
  elbow: ["elbow", "elbows", "ell", "90"],
  coupling: ["coupling", "coupler", "couplings"],
  adapter: ["adapter", "adaptor", "adapters"],
  bushing: ["bushing", "bushings"],
  nipple: ["nipple", "nipples"],
  cap: ["cap", "caps"],
  plug: ["plug", "plugs"],
  cross: ["cross"],
  union: ["union"],
  valve: ["valve", "valves"],
  box: ["box", "boxes"],
  saddle: ["saddle"],
  clamp: ["clamp", "clamps"]
};
const END_WORDS = {
  female: ["fipt", "fpt", "fip", "female", "fxf", "fxfxf", "threaded"],
  male: ["mipt", "mpt", "mip", "male", "mxm"],
  insert: ["insert", "barb", "barbed", "ixf", "ixm", "ixi"],
  slip: ["slip", "socket", "sxs", "sxsxs"]
};
const FRACTIONS = { "0.25": "1/4", "0.375": "3/8", "0.5": "1/2", "0.75": "3/4", "1.25": "1-1/4", "1.5": "1-1/2", "2.5": "2-1/2" };
// One canonical spelling for a pipe size, so `.5"`, `0.5"`, `1/2"`, `1/2 in`
// and `½` all compare equal (Patrick, Sep 27 2026): decimals become the
// trade fraction where one exists, a bare fraction stays, mixed numbers
// read "1-1/4". Deterministic — no model involved.
const VULGAR = { "¼": "1/4", "½": "1/2", "¾": "3/4", "⅜": "3/8", "⅛": "1/8" };
function normalizeSize(size) {
  let s = String(size == null ? "" : size).toLowerCase().replace(/["″”]|inch(es)?|\bin\b/g, "").replace(/[¼½¾⅜⅛]/g, (m) => " " + VULGAR[m]).trim();
  s = s.replace(/\s+/g, " ").replace(/^(\d+) (\d+\/\d+)$/, "$1-$2").replace(/\s*x\s*/g, "x").trim();
  if (!s) return "";
  if (/^\d*\.\d+$/.test(s)) { const d = (s.startsWith(".") ? "0" : "") + s; return FRACTIONS[d] || String(Number(d)); }
  if (/^\d+$/.test(s)) return String(Number(s));
  if (/^\d+\/\d+$/.test(s) || /^\d+-\d+\/\d+$/.test(s)) return s;
  return s;
}
function sameSize(a, b) { return normalizeSize(a) !== "" && normalizeSize(a) === normalizeSize(b); }
function sizeForms(size) {
  const canon = normalizeSize(size);
  const forms = new Set([canon]);
  const dec = Object.keys(FRACTIONS).find((d) => FRACTIONS[d] === canon || d === canon);
  if (dec) { forms.add(dec); forms.add(FRACTIONS[dec]); forms.add(FRACTIONS[dec].replace("-", " ")); forms.add(dec.replace(/^0/, "")); }
  const raw = String(size).replace(/["″]|in\b|inch(es)?/gi, "").trim();
  if (raw) forms.add(raw);
  return [...forms].filter(Boolean);
}

// What our record says the fitting is, in words a page could also use.
function parseSpec(part) {
  const text = `${part.description || ""} ${part.size || ""}`.toLowerCase();
  const words = text.replace(/[^a-z0-9./\- ]/g, " ").split(/\s+/);
  const type = Object.keys(TYPE_WORDS).find((t) => TYPE_WORDS[t].some((w) => w !== "90" && words.includes(w))) || null;
  const ends = Object.keys(END_WORDS).filter((e) => END_WORDS[e].some((w) => words.includes(w)));
  const sizes = [];
  for (const m of text.matchAll(/(\d+-\d\/\d|\d+\s\d\/\d|\d+\/\d+|\d*\.\d+|\d+|[¼½¾⅜⅛])\s*(?:"|″|”|in\b|inch)/g)) sizes.push(normalizeSize(m[1]));
  if (!sizes.length && part.size) sizes.push(normalizeSize(part.size));
  return { type, ends, sizes: [...new Set(sizes.filter(Boolean))] };
}

// Known-brand recovery (Patrick, Sep 27 2026). A catalog row with a blank
// manufacturer whose description clearly names a brand we know is treated
// as a PROPOSED brand for the branded path — the official manufacturer
// page still has to prove the product, and the catalog field is never
// rewritten. Word-boundary matches on the description only.
const BRAND_WORDS = {
  hunter: [/\bhunter\b/i],
  rainbird: [/\brain ?bird\b/i],
  netafim: [/\bnetafim\b/i],
  blulock: [/\bblu[ -]?lock\b/i],
  oilcreek: [/\boil ?creek\b/i],
  dawn: [/\bdawn\b/i],
  watts: [/\bwatts\b/i]
};
function proposedBrand(part) {
  if (!part || String(part.manufacturer || "").trim()) return null;
  const d = String(part.description || "");
  for (const [key, res] of Object.entries(BRAND_WORDS)) if (res.some((re) => re.test(d))) return key;
  return null;
}
function effectiveManufacturer(part) {
  const own = String((part && part.manufacturer) || "").trim();
  return own || proposedBrand(part) || "";
}

// ---------------------------------------------------- product images
// Once the finder has named a product page, OUR server reads the page's
// HTML and collects product-image candidates from trusted structures, in
// order of trust: og:image / twitter:image, Product JSON-LD `image`, then
// product-ish <img> elements (itemprop="image", or inside an element whose
// class/id says product/gallery/main). Logos, icons, sprites, svg, tiny
// images and tracking pixels are skipped. These are CANDIDATES only: they
// still go through the safe downloader and the vision check.
const IMG_SKIP = /logo|icon|sprite|favicon|badge|banner|placeholder|spacer|pixel|tracking|avatar|flag|payment|social|\.svg(\?|$)|\.gif(\?|$)|data:/i;
function absolutize(u, base) {
  try { const url = new URL(String(u).trim().replace(/&amp;/g, "&"), base); return url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}
function pickSrcset(srcset) {
  let best = null, bestW = -1;
  for (const cand of String(srcset).split(",")) {
    const [u, d] = cand.trim().split(/\s+/);
    const w = d && /w$/.test(d) ? parseInt(d, 10) : d && /x$/.test(d) ? parseFloat(d) * 1000 : 0;
    if (u && w > bestW) { best = u; bestW = w; }
  }
  return best;
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}
// `keys`: our part number(s) and the manufacturer's model — an <img> whose
// src filename or alt names one of them is a product image even without
// gallery markers (Hunter's model pages: `/PGV-100G.jpeg`, alt "PGV-100-G").
// Large declared images (≥300×300) count too. The skip list still wins.
const MIN_LARGE = 300;
function extractProductImages(html, pageUrl, { max = 4, keys = [] } = {}) {
  const s = String(html || "");
  const out = [];
  const seen = new Set();
  const wanted = [...new Set((keys || []).map(normalizePartNumber).filter((k) => k.length >= MIN_PART_NUMBER_LENGTH))];
  const namesKey = (text) => { const n = normalizePartNumber(String(text || "")); return !!n && wanted.some((k) => n.includes(k)); };
  const push = (u, via) => {
    const abs = u && absolutize(u, pageUrl);
    if (!abs || seen.has(abs) || IMG_SKIP.test(abs)) return;
    seen.add(abs); out.push({ url: abs, via });
  };
  // 1. Open Graph / Twitter cards (product pages almost always set these).
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    if (["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src"].includes(key)) push(attr(tag, "content"), key);
  }
  // 2. Product JSON-LD `image` (string, array, ImageObject, or nested @graph).
  for (const m of s.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [];
    (function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); nodes.push(n); if (n["@graph"]) walk(n["@graph"]); })(data);
    for (const n of nodes) {
      const type = [].concat(n["@type"] || []).map(String);
      if (!type.some((t) => /product/i.test(t))) continue;
      const imgs = [].concat(n.image || []);
      for (const im of imgs) push(typeof im === "string" ? im : im && (im.url || im.contentUrl), "json-ld");
    }
  }
  // 3. Product-ish <img> elements. Skip the header/nav/footer, and anything
  //    declared tiny.
  const body = s.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, " ");
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const w = parseInt(attr(tag, "width") || "0", 10), h = parseInt(attr(tag, "height") || "0", 10);
    if ((w && w < 120) || (h && h < 120)) continue;
    const marker = `${attr(tag, "itemprop") || ""} ${attr(tag, "class") || ""} ${attr(tag, "id") || ""} ${attr(tag, "data-zoom-image") || ""} ${attr(tag, "alt") || ""}`;
    const productish = /itemprop|product|gallery|main-image|hero|zoom|primary|pdp/i.test(marker) || /^\s*image\s*$/i.test(attr(tag, "itemprop") || "");
    const src = attr(tag, "data-zoom-image") || attr(tag, "data-large") || (attr(tag, "srcset") && pickSrcset(attr(tag, "srcset"))) || attr(tag, "data-src") || attr(tag, "src");
    if (!src) continue;
    const fileName = (() => { try { return decodeURIComponent(new URL(src, pageUrl).pathname.split("/").pop() || ""); } catch { return String(src).split("/").pop() || ""; } })();
    const named = wanted.length && (namesKey(fileName) || namesKey(attr(tag, "alt")));
    const large = w >= MIN_LARGE && h >= MIN_LARGE;
    if (!productish && !named && !large) continue;
    push(src, productish ? "img" : named ? "img:part-number" : "img:large");
  }
  return out.slice(0, max);
}

// pass = the page names the same type, every size, and every end type;
// unknown = it doesn't clearly say. Text never FAILS a fitting on its own —
// pages are written loosely; the photo check is what can say "wrong part".
function pageMatchesSpec(html, spec) {
  if (!spec || !spec.type) return { result: "unknown", reason: "Our record doesn't name the fitting type." };
  const text = " " + visibleProductText(html).toLowerCase().replace(/[^a-z0-9./\- ]/g, " ").replace(/\s+/g, " ") + " ";
  const has = (w) => text.includes(` ${w} `) || text.includes(` ${w}"`);
  const typeOk = TYPE_WORDS[spec.type].some(has);
  const sizesOk = spec.sizes.every((sz) => sizeForms(sz).some((f) => text.includes(` ${f.toLowerCase()}`)));
  const endsOk = spec.ends.every((e) => END_WORDS[e].some(has));
  if (typeOk && sizesOk && endsOk) return { result: "pass", reason: "The page names the same fitting type, size and ends." };
  const missing = [!typeOk && "type", !sizesOk && "size", !endsOk && "ends"].filter(Boolean).join(", ");
  return { result: "unknown", reason: `The page doesn't clearly state the ${missing}.` };
}

// ------------------------------------------------------------------ tiers

// The vision checks that must all pass. Size is graded where visible; an
// "unknown" size only holds a part at To be determined.
const VISION_KEYS = ["productShot", "type", "ends", "reducing", "angle", "material", "pack", "size"];

function visionSummary(vision) {
  if (!vision) return { result: "unknown", failed: [], unknown: VISION_KEYS };
  const failed = VISION_KEYS.filter((k) => vision[k] && vision[k].result === "fail");
  const unknown = VISION_KEYS.filter((k) => !vision[k] || vision[k].result === "unknown");
  return { result: failed.length ? "fail" : unknown.length ? "unknown" : "pass", failed, unknown };
}

// Deterministic. Branded: part # on page + photo. Generic: the triple check
// (spec on page, photo, a second source agreeing). "n/a" counts as pass for
// vision attributes that don't apply (e.g. angle on a straight coupling).
function tierFor({ kind, hasCandidate, partNumber, vision, specMatch, crossSource }) {
  if (!hasCandidate) return { tier: "not_confident", reason: "No usable product photo was found." };
  const v = visionSummary(vision);
  const checks = kind === "branded" ? [partNumber, { result: v.result }] : [specMatch, { result: v.result }, crossSource];
  const results = checks.map((c) => (c && c.result) || "unknown");
  if (results.includes("fail")) {
    const why = [];
    if (kind === "branded" && partNumber && partNumber.result === "fail") why.push("the part number isn't on the product page");
    if (v.failed.length) why.push(`the photo doesn't match (${v.failed.join(", ")})`);
    if (kind === "generic" && crossSource && crossSource.result === "fail") why.push("a second source disagrees");
    return { tier: "not_confident", reason: `Not confident: ${why.join("; ") || "a check failed"}.` };
  }
  if (results.every((r) => r === "pass")) return { tier: "confident", reason: kind === "branded" ? "Part number on the product page and the photo matches." : "Spec, photo and a second source all agree." };
  return { tier: "tbd", reason: "Some checks couldn't be confirmed — needs a look." };
}

// --------------------------------------------------------- calibration pick

const SHAPES = ["tee", "elbow", "coupling", "adapter", "bushing", "nipple", "cap", "plug", "valve", "box", "saddle", "clamp"];
function shapeOf(part) { return parseSpec(part).type || "other"; }
function endsOf(part) { return parseSpec(part).ends.join("+") || "none"; }

// A deliberate, diverse, reproducible sample: round-robin across
// manufacturers + categories for branded parts, and across shapes +
// connection types for generic ones, so both confidence paths get tested
// on different geometry. Parts that are already live are left alone.
function materialOf(part) {
  const d = String(part.description || "").toLowerCase();
  return /\bpvc\b/.test(d) ? "pvc" : /\bpoly\b/.test(d) ? "poly" : "other";
}
// Hunter and Rain Bird are most of the branded catalog; lead with them.
const BRAND_PRIORITY = ["hunter", "rainbird", "netafim", "oilcreek", "dawn", "blulock", "watts"];

function pickCalibrationSample(parts, { branded = 8, generic = 7, isLive = () => false } = {}) {
  const pool = (parts || []).filter((p) => p && p.sku && !isLive(p)).sort((a, b) => a.sku.localeCompare(b.sku));
  const rank = (m) => { const i = BRAND_PRIORITY.indexOf(m); return i < 0 ? 99 : i; };
  const brandedPool = pool.filter((p) => MANUFACTURER_DOMAINS[p.manufacturer])
    .sort((a, b) => rank(a.manufacturer) - rank(b.manufacturer) || a.sku.localeCompare(b.sku));
  const genericPool = pool.filter((p) => !MANUFACTURER_DOMAINS[p.manufacturer] && shapeOf(p) !== "other");
  // Pass 1: one per A, each with a new B; pass 2: a second per A only for a
  // new (A,B) pair; pass 3: fill in order. A = the axis spread first.
  function spread(list, keyA, keyB, n) {
    const picked = [], perA = new Map(), seenB = new Set(), seenPair = new Set();
    for (const pass of [1, 2, 3]) {
      for (const p of list) {
        if (picked.length >= n) break;
        if (picked.includes(p)) continue;
        const a = keyA(p), b = keyB(p), pair = a + "|" + b;
        if (pass === 1 && ((perA.get(a) || 0) >= 1 || seenB.has(b))) continue;
        if (pass === 2 && ((perA.get(a) || 0) >= 2 || seenPair.has(pair))) continue;
        picked.push(p); perA.set(a, (perA.get(a) || 0) + 1); seenB.add(b); seenPair.add(pair);
      }
    }
    return picked;
  }
  // Branded: Hunter and Rain Bird are most of the catalog, so each gets 3
  // slots on DIFFERENT categories (heads, valves, drip, controllers…); the
  // rest go to other manufacturers, one each, on categories not yet used.
  const b = [];
  const usedCats = new Map();
  const pickFrom = (list, n, distinctFromAll) => {
    const cats = new Set();
    for (const p of list) {
      if (b.length >= branded || n <= 0) break;
      if (cats.has(p.category) || (distinctFromAll && usedCats.has(p.category))) continue;
      b.push(p); cats.add(p.category); usedCats.set(p.category, true); n--;
    }
  };
  const quota = Math.max(1, Math.floor(Math.min(3, branded / 2.5)));
  for (const m of ["hunter", "rainbird"]) pickFrom(brandedPool.filter((p) => p.manufacturer === m), quota, false);
  const otherMfrs = [...new Set(brandedPool.map((p) => p.manufacturer))].filter((m) => m !== "hunter" && m !== "rainbird");
  for (const m of otherMfrs) pickFrom(brandedPool.filter((p) => p.manufacturer === m), 1, true);
  for (const m of otherMfrs) pickFrom(brandedPool.filter((p) => p.manufacturer === m && !b.includes(p)), 1, false);
  for (const p of brandedPool) { if (b.length >= branded) break; if (!b.includes(p)) b.push(p); }
  // Generic: spread across shapes, materials and connection types — PVC and
  // poly interleaved so neither dominates.
  const byMaterial = { pvc: [], poly: [], other: [] };
  for (const p of genericPool) byMaterial[materialOf(p)].push(p);
  const interleaved = [];
  for (let i = 0; i < genericPool.length; i++) for (const m of ["pvc", "poly", "other"]) if (byMaterial[m][i]) interleaved.push(byMaterial[m][i]);
  const g = spread(interleaved, shapeOf, (p) => materialOf(p) + ":" + endsOf(p), generic);
  return {
    branded: b,
    generic: g,
    skus: [...b, ...g].map((p) => p.sku)
  };
}

// ---------------------------------------------------------- backfill wave
// A controlled wave (Patrick, Sep 27 2026): `size` parts that nothing has
// touched yet, deliberately mixed — half branded (round-robin across
// manufacturer × category) and half generic (round-robin across category
// × shape × material) — never simply the first N. Deterministic: the same
// catalog always gives the same wave. `isExcluded` removes live parts,
// parts waiting for review, and anything a calibration already processed.
function pickWave(parts, { size = 30, isExcluded = () => false } = {}) {
  const pool = (parts || []).filter((p) => p && p.sku && !isExcluded(p)).sort((a, b) => a.sku.localeCompare(b.sku));
  const branded = pool.filter((p) => MANUFACTURER_DOMAINS[effectiveManufacturer(p)]);
  const generic = pool.filter((p) => !MANUFACTURER_DOMAINS[effectiveManufacturer(p)]);
  const rank = (m) => { const i = BRAND_PRIORITY.indexOf(m); return i < 0 ? 99 : i; };
  // Round-robin over ordered buckets: one from each bucket per lap.
  const roundRobin = (list, keyOf, orderBuckets, n) => {
    const buckets = new Map();
    for (const p of list) { const k = keyOf(p); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(p); }
    const keys = [...buckets.keys()].sort(orderBuckets);
    const out = [];
    for (let lap = 0; out.length < n && keys.some((k) => buckets.get(k).length > lap); lap++) {
      for (const k of keys) { if (out.length >= n) break; const b = buckets.get(k); if (b[lap]) out.push(b[lap]); }
    }
    return out;
  };
  const half = Math.ceil(size / 2);
  const wantBranded = Math.min(half, branded.length);
  const wantGeneric = Math.min(size - wantBranded, generic.length);
  const fillBranded = Math.min(branded.length, size - wantGeneric); // if generic is short, branded fills
  const b = roundRobin(branded, (p) => `${effectiveManufacturer(p)}|${p.category || ""}`,
    (x, y) => { const [mx, cx] = x.split("|"), [my, cy] = y.split("|"); return rank(mx) - rank(my) || cx.localeCompare(cy); }, fillBranded);
  const g = roundRobin(generic, (p) => `${p.category || ""}|${shapeOf(p)}|${materialOf(p)}`, (x, y) => x.localeCompare(y), size - b.length);
  return { branded: b, generic: g, skus: [...b, ...g].map((p) => p.sku) };
}

// ---------------------------------------------------------------- grouping

// Two parts are the same fitting AUTOMATICALLY only when both were matched
// to the same manufacturer and the same manufacturer part number, on an
// official manufacturer page. Anything weaker — including identical specs
// on generic fittings — is only ever a proposal for "Fittings to confirm".
function groupingDecision(a, b) {
  const sameMfr = a.manufacturer && a.manufacturer === b.manufacturer;
  const na = normalizePartNumber(a.manufacturerPartNumber), nb = normalizePartNumber(b.manufacturerPartNumber);
  const sameNumber = na.length >= MIN_PART_NUMBER_LENGTH && na === nb;
  const official = a.officialPage === true && b.officialPage === true;
  if (sameMfr && sameNumber && official) return { action: "auto-link", reason: "Same manufacturer and manufacturer part number on official pages." };
  const sa = parseSpec(a.part || {}), sb = parseSpec(b.part || {});
  const sameSpec = sa.type && sa.type === sb.type && JSON.stringify(sa.sizes.map(normalizeSize)) === JSON.stringify(sb.sizes.map(normalizeSize)) && JSON.stringify(sa.ends) === JSON.stringify(sb.ends);
  if ((sameMfr && sameNumber) || sameSpec) return { action: "propose", reason: sameSpec ? "Same fitting type, size and ends." : "Same manufacturer part number, but not confirmed on an official page." };
  return { action: "none" };
}

module.exports = {
  MANUFACTURER_DOMAINS, SUPPLIER_DOMAINS, MIN_PART_NUMBER_LENGTH, VISION_KEYS,
  hostOf, isOfficialManufacturerPage,
  normalizePartNumber, visibleProductText, partNumberOnPage, supplierCodeMapping,
  normalizeSize, sameSize, sizeForms, proposedBrand, effectiveManufacturer, extractProductImages,
  parseSpec, pageMatchesSpec, tierFor, visionSummary,
  pickCalibrationSample, pickWave, groupingDecision, shapeOf, endsOf, materialOf
};

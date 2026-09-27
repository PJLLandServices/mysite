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
const FRACTIONS = { "0.25": "1/4", "0.5": "1/2", "0.75": "3/4", "1.25": "1-1/4", "1.5": "1-1/2", "2.5": "2-1/2" };
function sizeForms(size) {
  const s = String(size).replace(/["″]|in\b|inch(es)?/gi, "").trim();
  const forms = new Set([s]);
  const dec = Object.keys(FRACTIONS).find((d) => d === s || FRACTIONS[d] === s || FRACTIONS[d].replace("-", " ") === s);
  if (dec) { forms.add(dec); forms.add(FRACTIONS[dec]); forms.add(FRACTIONS[dec].replace("-", " ")); forms.add(dec.replace(/^0/, "")); }
  return [...forms].filter(Boolean);
}

// What our record says the fitting is, in words a page could also use.
function parseSpec(part) {
  const text = `${part.description || ""} ${part.size || ""}`.toLowerCase();
  const words = text.replace(/[^a-z0-9./\- ]/g, " ").split(/\s+/);
  const type = Object.keys(TYPE_WORDS).find((t) => TYPE_WORDS[t].some((w) => w !== "90" && words.includes(w))) || null;
  const ends = Object.keys(END_WORDS).filter((e) => END_WORDS[e].some((w) => words.includes(w)));
  const sizes = [];
  for (const m of text.matchAll(/(\d+-\d\/\d|\d+\/\d+|\d*\.\d+|\d+)\s*(?:"|″|in\b|inch)/g)) sizes.push(m[1]);
  if (!sizes.length && part.size) sizes.push(String(part.size));
  return { type, ends, sizes: [...new Set(sizes)] };
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
  const sameSpec = sa.type && sa.type === sb.type && JSON.stringify(sa.sizes) === JSON.stringify(sb.sizes) && JSON.stringify(sa.ends) === JSON.stringify(sb.ends);
  if ((sameMfr && sameNumber) || sameSpec) return { action: "propose", reason: sameSpec ? "Same fitting type, size and ends." : "Same manufacturer part number, but not confirmed on an official page." };
  return { action: "none" };
}

module.exports = {
  MANUFACTURER_DOMAINS, SUPPLIER_DOMAINS, MIN_PART_NUMBER_LENGTH, VISION_KEYS,
  hostOf, isOfficialManufacturerPage,
  normalizePartNumber, visibleProductText, partNumberOnPage, supplierCodeMapping,
  parseSpec, pageMatchesSpec, tierFor, visionSummary,
  pickCalibrationSample, groupingDecision, shapeOf, endsOf
};

// Fast Product Lookup (Patrick, Sep 28 2026) — resolve a part through a
// supplier's own search and product page BEFORE spending a Claude
// web-search finder call. Deterministic: plain fetches through the safe
// page fetcher, plain parsing. What it produces are CANDIDATE pages and
// ranked image URLs in exactly the shape the finder produces, so the
// check → verify → cross → tier steps (the evidence rules) run unchanged.
//
// Preferred source order (Patrick): SupplyHouse, SiteOne, Central Pro
// Supply, then the official manufacturer site. What the probes found on
// 2026-09-28, from a plain server-side fetch:
//   supplyhouse.com  — HTTP 403 for every URL, robots.txt included: an
//                      edge rule against non-browser clients. Recorded as
//                      "blocked"; no proxies or bypasses (Patrick's rule).
//   siteone.com      — server-rendered search (/en/search?text=…) with
//                      product links and titles; product pages carry
//                      Product JSON-LD, spec rows and a __zoom image.
//   centralpros.com  — a marketing site (events, training, Bectran credit
//                      login); no public product catalog or search results
//                      in the HTML. Recorded as "no public catalog".
//   manufacturer     — no site-search adapter yet; the AI finder's pass 1
//                      still covers official pages.
// Each source's status is reported per part so a miss is never a mystery.
//
// Selecting a result is a HINT, never evidence: the slug's leading token,
// a title match or "only result for our exact SKU" only decide which page
// to fetch. The part-number rule (photo-evidence.partNumberOnPage, visible
// text only), the spec match, the vision check and the quality gate then
// judge the page and its pictures exactly as they judge the finder's.

const ev = require("./photo-evidence");
const { rankImageUrls } = require("./photo-quality");

const SOURCES = [
  { id: "supplyhouse", label: "SupplyHouse", domain: "supplyhouse.com", status: "blocked", note: "HTTP 403 to non-browser clients (probe 2026-09-28)" },
  { id: "siteone", label: "SiteOne", domain: "siteone.com", status: "ok" },
  { id: "centralpros", label: "Central Pro Supply", domain: "centralpros.com", status: "unavailable", note: "no public product catalog or search results in the page HTML (probe 2026-09-28)" },
  { id: "manufacturer", label: "official manufacturer site", status: "unavailable", note: "no site-search adapter; the finder's first pass covers official pages" }
];
const MAX_RESULTS_PER_QUERY = 5;
// One product page per part: a second page from the SAME supplier is not
// an independent source (the generic cross-check needs another domain, and
// the finder's last pass supplies it), and a branded page that prints our
// number needs no company. "At most 1–2 strong candidate images" is then
// MAX_IMAGES_PER_PAGE from that page.
const MAX_PRODUCT_PAGES = 1;
const MAX_IMAGES_PER_PAGE = 2;

function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function decode(s) { return ev.visibleProductText(`<p>${s}</p>`); }

// ---- SiteOne -------------------------------------------------------------
const siteone = {
  id: "siteone",
  searchUrl: (q) => `https://www.siteone.com/en/search?text=${encodeURIComponent(q)}`,
  // Product tiles link to /<slug>/p/<id>; the same href appears with an
  // empty anchor, "N Options" and the product title — keep the title.
  parseResults(html) {
    const seen = new Map();
    for (const m of String(html || "").matchAll(/<a\b[^>]*href="((?:https:\/\/www\.siteone\.com)?(\/[^"]*?\/p\/\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const path = m[2];
      const text = decode(stripTags(m[3]));
      if (!text || /^\d+ options?$/i.test(text)) continue;
      if (!seen.has(path)) {
        // Tiles link "/<slug>/p/<id>"; the canonical page lives under /en/.
        const canonical = path.startsWith("/en/") ? path : `/en${path}`;
        const slug = (canonical.match(/^\/en\/([^/]+)\/p\/\d+/) || [])[1] || "";
        seen.set(path, { url: `https://www.siteone.com${canonical}`, title: text, slug, slugCode: (slug.match(/^([^-]+)/) || [])[1] || "" });
      }
    }
    return [...seen.values()].slice(0, MAX_RESULTS_PER_QUERY);
  }
};
const ADAPTERS = { siteone };

// ---- product page facts (any site) ----------------------------------------
function productJsonLd(html) {
  for (const m of String(html || "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [];
    (function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); nodes.push(n); if (n["@graph"]) walk(n["@graph"]); })(data);
    const p = nodes.find((n) => [].concat(n["@type"] || []).some((t) => /product/i.test(String(t))));
    if (p) return { name: p.name || "", sku: p.sku || p.productID || "", mpn: p.mpn || p.model || "", brand: (p.brand && (p.brand.name || p.brand)) || "", image: p.image || null };
  }
  return null;
}
function pageTitle(html) {
  const h1 = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) { const t = decode(stripTags(h1[1])); if (t) return t; }
  const og = String(html || "").match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || String(html || "").match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  return og ? decode(og[1]) : "";
}
// Visible specification rows: <dt>/<dd>, table rows, or label/value
// element pairs whose class says spec/attribute. Best effort; only used
// for the review card and the description-query match.
function pageSpecs(html) {
  const s = String(html || "");
  const out = [];
  const add = (k, v) => { k = decode(stripTags(k)); v = decode(stripTags(v)); if (k && v && k.length < 60 && v.length < 120 && !out.some((r) => r.label === k)) out.push({ label: k, value: v }); };
  for (const m of s.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) add(m[1], m[2]);
  for (const m of s.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi)) add(m[1], m[2]);
  for (const m of s.matchAll(/class="[^"]*spec(?:ification)?[^"]*heading[^"]*"[^>]*>([\s\S]*?)<\/\w+>\s*<\w+\b[^>]*class="[^"]*spec(?:ification)?[^"]*data[^"]*"[^>]*>([\s\S]*?)<\/\w+>/gi)) add(m[1], m[2]);
  return out.slice(0, 20);
}

// ---- choosing what to fetch -------------------------------------------------
const MATERIAL_WORDS = { pvc: /\bpvc\b/i, poly: /\bpoly(ethylene)?\b/i, brass: /\bbrass\b/i, stainless: /\bstainless\b|\bss\b/i, nylon: /\bnylon\b/i };
function materialOf(text) { return Object.keys(MATERIAL_WORDS).find((k) => MATERIAL_WORDS[k].test(text)) || null; }

// Our part numbers, normalised. A result title/slug NAMES our part when a
// token of it equals one of ours, or the slug's leading code is contained
// in ours (SiteOne slugs open with the manufacturer's code: "pcm300-…" for
// our HCPCM300, "1401-007-…" for 1401-007).
function namesOurNumber(result, keys) {
  const wanted = keys.map(ev.normalizePartNumber).filter((k) => k.length >= ev.MIN_PART_NUMBER_LENGTH);
  if (!wanted.length) return false;
  const tokens = String(result.title || "").split(/\s+/).map(ev.normalizePartNumber).filter(Boolean);
  if (tokens.some((t) => wanted.includes(t))) return true;
  // The slug opens with the code, hyphenated as the maker writes it:
  // "1401-007-poly-insert-tee…", "hc150flow-hunter-…", "pcm300-hunter-…"
  // (our supplier code for HCPCM300). The code must END at a slug token:
  // the first n tokens, joined, equal one of ours. "1449-005-…" is not
  // 1449-007, and "pp075x400nsf125-…" is not PP075X400.
  const slugTokens = String(result.slug || result.slugCode || "").split("-").filter(Boolean);
  let acc = "";
  for (const tok of slugTokens.slice(0, 4)) {
    acc += ev.normalizePartNumber(tok);
    if (acc.length >= ev.MIN_PART_NUMBER_LENGTH && wanted.includes(acc)) return true;
  }
  return false;
}
// For a generic fitting the title must describe the SAME fitting: type,
// every size, the ends our record names, and the material when ours names
// one (Patrick's representative-photo rule). A supplier SKU is not needed.
function titleMatchesSpec(title, part) {
  const spec = ev.parseSpec(part);
  if (!spec.type) return false;
  const t = ` ${String(title || "").toLowerCase().replace(/["″”]/g, " in ").replace(/[^a-z0-9./\- ]/g, " ").replace(/\s+/g, " ")} `;
  const has = (w) => t.includes(` ${w} `);
  const typeOk = ev.TYPE_WORDS[spec.type].some(has) || (spec.type === "elbow" && /\b90\b/.test(t));
  // A size is a whole token: "2 in." must not be satisfied by "24 in.".
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sizesOk = spec.sizes.every((sz) => ev.sizeForms(sz).some((f) => new RegExp(`(^| )${esc(f.toLowerCase())}(?= |$)`).test(t)));
  // Ends must be the SAME set: a title that names ends our record doesn't
  // (spigot x socket against our unstated threads) is a different fitting
  // until proven otherwise, and vice versa. The bare word "threaded" names
  // no side, so it is ignored here (it still counts in the evidence rule).
  const titleEnds = Object.keys(ev.END_WORDS).filter((e) => ev.END_WORDS[e].filter((w) => w !== "threaded").some(has)).sort().join("+");
  const endsOk = titleEnds === [...spec.ends].sort().join("+");
  const ourMaterial = materialOf(`${part.description || ""}`);
  const materialOk = !ourMaterial || !!MATERIAL_WORDS[ourMaterial].test(title || "");
  return typeOk && sizesOk && endsOk && materialOk;
}
// Description → a search query a supplier understands: strip our internal
// notes, spell sizes as "3/4 in.".
function descriptionQuery(part) {
  let d = String(part.description || "").replace(/\([^)]*\)/g, " ").replace(/[×]/g, " x ");
  d = d.replace(/(\d+(?:\.\d+)?|\d+\/\d+|\d+-\d+\/\d+)\s*(?:"|″|”|in\b\.?|inch(?:es)?)/gi, (m, n) => `${ev.normalizeSize(n)} in.`);
  d = d.replace(/\b(ins|ins\.|insert)\b/gi, "insert").replace(/\bx\b/gi, "x").replace(/\s+/g, " ").trim();
  return d.split(" ").slice(0, 10).join(" ");
}

function createFastLookup({ fetchPage, adapters = ADAPTERS, sources = SOURCES, log = () => {} }) {
  if (typeof fetchPage !== "function") throw new Error("createFastLookup needs fetchPage.");

  // One part → { candidates, identified, notes, searches, sources }.
  // `part` is the runner's enriched part (manufacturer, supplierSkus…).
  // `fetchPage` may be overridden per call (the runner passes its counting,
  // caching fetcher so the check step re-reads the same page for free).
  async function lookup(part, { kind = "generic", maxPages = MAX_PRODUCT_PAGES, fetchPage: get = fetchPage } = {}) {
    const keys = [...new Set([part.partNumber, part.sku, ...(part.supplierSkus || [])].filter(Boolean))];
    const out = { candidates: [], identified: null, notes: [], searches: [], sources: sources.map((s) => ({ id: s.id, status: s.status, note: s.note || "" })) };
    const exactQueries = keys;
    const descQuery = descriptionQuery(part);
    const fetchedPages = new Set();
    for (const src of sources) {
      if (src.status !== "ok" || !adapters[src.id]) continue;
      const ad = adapters[src.id];
      const queries = [...exactQueries.map((q) => ({ q, kind: "exact" })), ...(descQuery ? [{ q: descQuery, kind: "description" }] : [])];
      for (const { q, kind: qk } of queries) {
        if (out.candidates.length >= maxPages) break;
        const rec = { source: src.id, query: q, queryKind: qk, fetch: "ok", results: 0, chosen: 0, note: "" };
        out.searches.push(rec);
        let html;
        try { ({ html } = await get(ad.searchUrl(q))); }
        catch (err) { rec.fetch = "failed"; rec.note = String(err.message || err).slice(0, 120); if (err.transient) throw err; continue; }
        const results = ad.parseResults(html);
        rec.results = results.length;
        // Which results are worth a page fetch, best first.
        let picks;
        if (qk === "exact") picks = results.filter((r) => namesOurNumber(r, keys));
        else picks = kind === "generic" ? results.filter((r) => titleMatchesSpec(r.title, part)) : results.filter((r) => namesOurNumber(r, keys));
        if (!picks.length && qk === "exact" && results.length === 1 && kind === "branded") picks = results; // the only answer to our exact code
        if (!picks.length) { rec.note = results.length ? "no result names our part" : "no results"; continue; }
        for (const r of picks) {
          if (out.candidates.length >= maxPages) break;
          if (fetchedPages.has(r.url)) continue;
          fetchedPages.add(r.url);
          let page;
          try { page = await get(r.url); }
          catch (err) { if (err.transient) throw err; out.notes.push(`${src.id}: ${r.url} — ${String(err.message || err).slice(0, 80)}`); continue; }
          const pageUrl = page.finalUrl || r.url;
          const ld = productJsonLd(page.html);
          const title = pageTitle(page.html) || (ld && ld.name) || r.title;
          // The page's JSON-LD mpn/model is a hint; it becomes "identified"
          // only when the page's visible text prints it and it isn't simply
          // one of our own numbers. (The slug is not used for this: its
          // first token is often a series, not a model.)
          const hintCodes = [ld && ld.mpn].filter(Boolean);
          let identified = null;
          for (const code of hintCodes) {
            const on = ev.partNumberOnPage(page.html, [code]);
            if (on.result === "pass" && !keys.map(ev.normalizePartNumber).includes(on.matched)) { identified = { manufacturer: (ld && ld.brand) || part.manufacturerLabel || "", manufacturerPartNumber: String(code), via: `${src.id} page text` }; break; }
          }
          const ours = ev.partNumberOnPage(page.html, keys);
          const images = rankImageUrls(ev.extractProductImages(page.html, pageUrl, { keys: [...keys, ...hintCodes], max: 4 }), { html: page.html, pageUrl, max: MAX_IMAGES_PER_PAGE + 2 });
          rec.chosen++;
          out.candidates.push({
            pageUrl, imageUrl: "", images, maxImages: MAX_IMAGES_PER_PAGE, partNumberAsShown: ours.result === "pass" ? ours.matched : "",
            pass: 0, source: src.id, domain: ev.hostOf(pageUrl), official: ev.isOfficialManufacturerPage(pageUrl, part.manufacturer),
            title, supplierSku: (ld && ld.sku) || "", specs: pageSpecs(page.html), queryKind: qk
          });
          if (identified && !out.identified) out.identified = identified;
        }
      }
    }
    if (!out.candidates.length) out.notes.push("fast path: no product page found on the available sources");
    log({ action: "fast-lookup", sku: part.sku, candidates: out.candidates.length, searches: out.searches.length });
    return out;
  }

  return { lookup, sources, adapters };
}

module.exports = { createFastLookup, SOURCES, ADAPTERS, siteone, productJsonLd, pageTitle, pageSpecs, namesOurNumber, titleMatchesSpec, descriptionQuery, MAX_PRODUCT_PAGES, MAX_IMAGES_PER_PAGE };

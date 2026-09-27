#!/usr/bin/env node
// Part photos M3a — the AI backfill engine, fully mocked (P-PJL-35, FLOW-49).
//
// No model, no network: a fake AI and fake page/image fetches drive the real
// evidence rules, the real store and the real runner. What it guards:
//
//   - the part-number rule: harmless formatting is ignored, but the number
//     must be in the page's VISIBLE product text — never the URL, filename,
//     image alt text, link text, <title>, meta or scripts
//   - every tier path: branded Confident / TBD / Not confident, generic
//     triple check Confident / TBD / Not confident, and "nothing found"
//   - the vision check sees only the image and our spec (no URL, no page)
//   - auto-approve OFF → nothing goes live; TBD and Not confident are never
//     live even with it ON; a live photo is never overwritten
//   - stop/restart: finished steps are not redone, a step that was running
//     runs again, a partly verified SKU keeps its verified candidates
//   - temporary failures (429) retry with backoff; permanent ones stop the
//     SKU and it can be retried alone; at most 2 SKUs in flight
//   - grouping: auto-link ONLY on same manufacturer + manufacturer part # on
//     official pages; everything else is a proposal
//   - the calibration sample on the real catalog: 8 branded + 7 generic
//
// Run: node scripts/test-photo-backfill.mjs [--report]  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");
const REPORT = process.argv.includes("--report");

let ev, ai, bf, pp;
try {
  ev = require(path.join(ROOT, "server", "lib", "photo-evidence.js"));
  ai = require(path.join(ROOT, "server", "lib", "photo-ai.js"));
  bf = require(path.join(ROOT, "server", "lib", "photo-backfill.js"));
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
} catch (err) { console.log(`FAIL  photo backfill modules could not be loaded: ${err.message}`); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pjl-backfill-"));
const V = (over = {}) => Object.fromEntries(ev.VISION_KEYS.map((k) => [k, { result: over[k] || "pass", reason: "" }]));

// ---- 1. Part-number rule -------------------------------------------------
{
  const n = ev.normalizePartNumber;
  check("normalize: dashes/spaces/case", n("PGP-ADJ") === "PGPADJ" && n("pgp adj") === "PGPADJ" && n(" P.G.P/adj ") === "PGPADJ");
  const page = (body) => `<html><body><h1>${body}</h1></body></html>`;
  check("'PGP-ADJ' on page matches PGPADJ", ev.partNumberOnPage(page("Hunter PGP-ADJ rotor"), ["PGPADJ"]).result === "pass");
  check("'pgp adj' on page matches PGP-ADJ", ev.partNumberOnPage(page("the pgp adj rotor"), ["PGP-ADJ"]).result === "pass");
  check("'PGPADJ04' does not match PGPADJ", ev.partNumberOnPage(page("Model PGPADJ04"), ["PGPADJ"]).result === "fail");
  check("'PGP-ADJ-04' does not match PGPADJ", ev.partNumberOnPage(page("Model PGP-ADJ-04"), ["PGPADJ"]).result === "fail");
  check("'PGP ADJUSTABLE' does not match PGPADJ", ev.partNumberOnPage(page("PGP ADJUSTABLE rotor"), ["PGPADJ"]).result === "fail");
  check("a number inside another code does not match", ev.partNumberOnPage(page("SKU XPGV100G2"), ["PGV-100G"]).result === "fail");
  check("entities decoded before matching", ev.partNumberOnPage(page("PGV&nbsp;100G"), ["PGV-100G"]).result === "pass");
  check("too-short numbers are 'unknown', never pass", ev.partNumberOnPage(page("10H nozzle"), ["10H"]).result === "unknown");

  const hidden = `<html><head><title>PGV-100G</title><meta name="description" content="PGV-100G">
    <script type="application/ld+json">{"sku":"PGV-100G"}</script></head>
    <body><!-- PGV-100G --><nav><a href="/p/pgv-100g">PGV-100G</a></nav>
    <img src="/img/PGV-100G.jpg" alt="PGV-100G" title="PGV-100G"><div data-sku="PGV-100G"></div>
    <script>var sku = "PGV-100G";</script><style>.PGV-100G{}</style><noscript>PGV-100G</noscript>
    <template>PGV-100G</template><svg><text>PGV-100G</text></svg>
    <h1>PGV 1" globe valve</h1><p>Glass-filled nylon.</p></body></html>`;
  check("URL / filename / alt / link text / title / meta / script never count", ev.partNumberOnPage(hidden, ["PGV-100G"]).result === "fail",
    JSON.stringify(ev.visibleProductText(hidden)));
  check("…and the same number in visible text does count", ev.partNumberOnPage(hidden.replace("<p>Glass", "<p>Model PGV-100G. Glass"), ["PGV-100G"]).result === "pass");
}

// ---- 2. Tier table ---------------------------------------------------------
{
  const P = { result: "pass" }, F = { result: "fail" }, U = { result: "unknown" };
  const t = (o) => ev.tierFor({ hasCandidate: true, ...o }).tier;
  check("no candidate → not confident", ev.tierFor({ kind: "branded", hasCandidate: false }).tier === "not_confident");
  check("branded: part # pass + photo pass → confident", t({ kind: "branded", partNumber: P, vision: V() }) === "confident");
  check("branded: n/a vision attributes still pass", t({ kind: "branded", partNumber: P, vision: V({ angle: "n/a", reducing: "n/a" }) }) === "confident");
  check("branded: part # unknown → TBD", t({ kind: "branded", partNumber: U, vision: V() }) === "tbd");
  check("branded: photo attribute unknown → TBD", t({ kind: "branded", partNumber: P, vision: V({ size: "unknown" }) }) === "tbd");
  check("branded: part # fail → not confident", t({ kind: "branded", partNumber: F, vision: V() }) === "not_confident");
  check("branded: photo fail → not confident", t({ kind: "branded", partNumber: P, vision: V({ ends: "fail" }) }) === "not_confident");
  check("generic: spec + photo + second source → confident", t({ kind: "generic", specMatch: P, vision: V(), crossSource: P }) === "confident");
  check("generic: no second source → TBD", t({ kind: "generic", specMatch: P, vision: V(), crossSource: U }) === "tbd");
  check("generic: spec unclear → TBD", t({ kind: "generic", specMatch: U, vision: V(), crossSource: P }) === "tbd");
  check("generic: second source disagrees → not confident", t({ kind: "generic", specMatch: P, vision: V(), crossSource: F }) === "not_confident");
  check("generic: part # is NOT what makes a generic confident", t({ kind: "generic", partNumber: P, vision: V() }) === "tbd");
  check("missing vision → TBD, never confident", t({ kind: "branded", partNumber: P, vision: null }) === "tbd");
}

// ---- 3. Grouping rule --------------------------------------------------------
{
  const g = (a, b) => ev.groupingDecision(a, b).action;
  const hunter = (mpn, official = true, extra = {}) => ({ manufacturer: "hunter", manufacturerPartNumber: mpn, officialPage: official, part: { description: "PGP rotor" }, ...extra });
  check("same mfr + same mfr part # (formatting differs) + official → auto-link", g(hunter("PGP-ADJ"), hunter("pgpadj")) === "auto-link");
  check("same number, one page unofficial → proposal only", g(hunter("PGP-ADJ"), hunter("PGP-ADJ", false)) === "propose");
  check("same number, different manufacturer → no link", g(hunter("PGPADJ"), { ...hunter("PGPADJ"), manufacturer: "rainbird" }) === "none");
  check("different number → no link", g(hunter("PGP-ADJ"), hunter("PGP-04")) === "none");
  check("short/missing number never auto-links", g(hunter(""), hunter("")) === "none" && g(hunter("PG1"), hunter("PG1")) === "none");
  const tee = { manufacturer: "", manufacturerPartNumber: "", officialPage: false, part: { description: "Poly insert tee 3/4\"" } };
  check("generic fittings with the same spec → proposal, never auto-link", g(tee, { ...tee }) === "propose");
  check("same generic spec even with 'official' flags → still proposal", g({ ...tee, officialPage: true }, { ...tee, officialPage: true }) === "propose");
}

// ---- 4. photo-ai against a fake Anthropic client --------------------------
{
  const calls = [];
  const queue = [];
  const client = { messages: { create: async (p) => { calls.push(JSON.parse(JSON.stringify(p))); const next = queue.shift(); if (next instanceof Error) throw next; return next; } } };
  const done = (obj) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 5 } });
  let usageSeen = 0;
  const A = ai.createPhotoAI({ client, onUsage: () => usageSeen++ });
  const hunterPart = { sku: "PGPADJ", partNumber: "PGP-ADJ", description: "PGP rotor", manufacturer: "hunter", manufacturerLabel: "Hunter", supplierSkus: ["HSPGPADJ"] };
  const genericPart = { sku: "1401007", partNumber: "1401007", description: "Poly tee 3/4\"", manufacturer: "" };

  queue.push(done({ manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [], notes: "" }));
  await A.find(hunterPart, 1);
  const tools1 = calls[0].tools;
  check("pass 1 searches only the manufacturer's domains", tools1.every((t) => JSON.stringify(t.allowed_domains) === JSON.stringify(ev.MANUFACTURER_DOMAINS.hunter)));
  check("pass 1 has web search + web fetch", tools1.map((t) => t.name).sort().join() === "web_fetch,web_search");
  check("finder asks for structured JSON", calls[0].output_config.format.type === "json_schema");
  check("finder user text carries our and the supplier's numbers", calls[0].messages[0].content.includes("PGP-ADJ") && calls[0].messages[0].content.includes("HSPGPADJ"));
  queue.push(done({ manufacturer: "", manufacturerPartNumber: "", candidates: [], notes: "" }));
  await A.find(genericPart, 2);
  check("pass 2 searches only SiteOne + Central", calls[1].tools.every((t) => JSON.stringify(t.allowed_domains) === JSON.stringify(ev.SUPPLIER_DOMAINS)));
  queue.push(done({ manufacturer: "", manufacturerPartNumber: "", candidates: [], notes: "" }));
  await A.find(genericPart, 3);
  check("pass 3 (generic only) is the open web", calls[2].tools.every((t) => !t.allowed_domains));
  check("passes: branded 1→2, generic 2→3", JSON.stringify(A.passesFor(hunterPart)) === "[1,2]" && JSON.stringify(A.passesFor(genericPart)) === "[2,3]");

  calls.length = 0;
  queue.push({ stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }], usage: {} });
  queue.push(done({ manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [], notes: "" }));
  const r = await A.find(hunterPart, 1);
  check("pause_turn is resumed with the paused content", calls.length === 2 && calls[1].messages.at(-1).role === "assistant" && r.manufacturerPartNumber === "PGP-ADJ");

  queue.push({ stop_reason: "refusal", content: [], usage: {} });
  try { await A.find(hunterPart, 1); check("refusal throws", false); } catch (e) { check("refusal is a permanent error, not 'no photo'", e.permanent === true && !bf.isTransient(e)); }
  queue.push({ stop_reason: "max_tokens", content: [], usage: {} });
  try { await A.find(hunterPart, 1); check("max_tokens throws", false); } catch (e) { check("max_tokens is transient", bf.isTransient(e)); }
  queue.push({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: {} });
  try { await A.find(hunterPart, 1); check("bad JSON throws", false); } catch (e) { check("invalid JSON is transient", bf.isTransient(e)); }
  queue.push(Object.assign(new Error("rate limited"), { status: 429 }));
  try { await A.find(hunterPart, 1); check("429 throws", false); } catch (e) { check("API 429 is transient", bf.isTransient(e)); }

  calls.length = 0;
  queue.push(done(V()));
  let perCall = 0;
  await A.verify({ ...hunterPart, pageUrl: "https://www.hunterirrigation.com/x", imageUrl: "https://x/pgp.jpg" }, Buffer.from("IMAGEBYTES"), "image/webp", () => perCall++);
  const v = calls[0];
  const vText = JSON.stringify({ system: v.system, messages: v.messages.map((m) => ({ ...m, content: m.content.map((c) => c.type === "image" ? { type: "image" } : c) })) });
  check("verify sends exactly one image + our spec", v.messages[0].content.filter((c) => c.type === "image").length === 1);
  check("verify never sees a URL, filename or page text", !/https?:|\.jpe?g|\.png|pageUrl|imageUrl|hunterirrigation/i.test(vText), vText);
  check("verify has no web tools", !v.tools);
  check("usage reported globally and per call", usageSeen > 0 && perCall === 1);
  check("no API key → clear error, no SDK load", (() => { try { ai.createAnthropicClient({ apiKey: "" }); return false; } catch (e) { return /ANTHROPIC_API_KEY/.test(e.message); } })());

  // The web-search probe: exactly one call, tool capped at one use, honest
  // about what came back. Patrick approved one such call on production.
  {
    const seen = [];
    const mk = (reply) => ({ messages: { create: async (p) => { seen.push(p); if (reply instanceof Error) throw reply; return reply; } } });
    const good = { stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20, server_tool_use: { web_search_requests: 1 } }, content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "today's date Toronto" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://example.com", title: "x" }] },
      { type: "text", text: "It is Saturday." }] };
    const pr = await ai.probeWebSearch({ client: mk(good) });
    check("probe: success reports the tool ran once", pr.ok === true && pr.toolCalled && pr.toolResultReturned && pr.webSearchRequests === 1 && pr.resultCount === 1 && /Saturday/.test(pr.answer));
    check("probe: exactly one API call, tool capped at one use, no structured output", seen.length === 1 && seen[0].tools.length === 1 && seen[0].tools[0].max_uses === 1 && !seen[0].output_config);
    check("probe: the query has nothing to do with the catalog", !/hunter|rain ?bird|pgp|sku|part/i.test(seen[0].messages[0].content));
    const disabled = { stop_reason: "end_turn", usage: { server_tool_use: { web_search_requests: 0 } }, content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      { type: "text", text: "I couldn't search." }] };
    const pd = await ai.probeWebSearch({ client: mk(disabled) });
    check("probe: a tool-result error is reported, not ok", pd.ok === false && pd.toolResultError === "unavailable" && pd.toolCalled);
    const pe = await ai.probeWebSearch({ client: mk(Object.assign(new Error("400 web search is not enabled for this organization"), { status: 400 })) });
    check("probe: an API error is reported with status and message, never thrown", pe.ok === false && pe.apiError.status === 400 && /not enabled/.test(pe.apiError.message));
    const pn = await ai.probeWebSearch({ client: mk({ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "no tool" }] }) });
    check("probe: an answer without a search is NOT a pass", pn.ok === false && !pn.toolCalled);
  }

  // Structured outputs accept only a subset of JSON Schema. The first
  // production calibration (2026-09-27) failed every part at the first call
  // with "For 'array' type, property 'maxItems' is not supported" — a 400
  // before any tokens. Keep every schema inside the supported subset.
  const SUPPORTED = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "description", "const"]);
  function schemaOffenders(schema, at, out = []) {
    for (const [k, v] of Object.entries(schema)) {
      if (!SUPPORTED.has(k)) out.push(`${at}.${k}`);
      if (k === "properties") for (const [pk, pv] of Object.entries(v)) schemaOffenders(pv, `${at}.${pk}`, out);
      else if (k === "items") schemaOffenders(v, `${at}.items`, out);
    }
    return out;
  }
  const offenders = [];
  for (const [name, s] of Object.entries({ finder: ai.FINDER_SCHEMA, verify: ai.VERIFY_SCHEMA, compare: ai.COMPARE_SCHEMA })) schemaOffenders(s, name, offenders);
  check("schemas use only keywords structured outputs support (no maxItems/minItems/pattern/min/max…)", offenders.length === 0, offenders.join(", "));
  check("every object schema closes additionalProperties", [ai.FINDER_SCHEMA, ai.VERIFY_SCHEMA, ai.COMPARE_SCHEMA, ai.FINDER_SCHEMA.properties.candidates.items].every((s) => s.additionalProperties === false));
  check("the schema check catches the exact bug", schemaOffenders({ type: "object", properties: { candidates: { type: "array", maxItems: 3, items: { type: "string" } } } }, "x").join() === "x.candidates.maxItems");
}

// ---- 5. Runner end-to-end on a mocked web ----------------------------------
const HUNTER = "https://www.hunterirrigation.com/en-metric/irrigation-product";
const html = (visible, hidden = "") => `<html><head><title>${hidden}</title></head><body><nav><a href="#">${hidden}</a></nav><h1>${visible}</h1><img alt="${hidden}" src="/${hidden}.jpg"></body></html>`;
const WEB = {
  [`${HUNTER}/pgp-adj`]: html("PGP-ADJ adjustable rotor, 4 in. pop-up"),
  [`${HUNTER}/pgv`]: html('PGV 1" globe valve', "PGV-100G"),
  [`${HUNTER}/pro-spray`]: html("Pro-Spray PROS-04 4 in. spray body"),
  "https://www.rainbird.com/products/rbn": html("RBN10H nozzle"),
  "https://www.siteone.com/en/rb-xfd": html("Rain Bird XFD-09-12 dripline"),
  "https://www.siteone.com/en/tee": html('Poly Insert Tee 3/4" barb'),
  "https://www.centralpros.com/tee": html('3/4" Insert Tee, poly, barbed'),
  "https://www.siteone.com/en/elbow": html('PVC Elbow 1/2" slip x slip'),
  "https://www.centralpros.com/elbow": html('1/2" PVC Elbow, socket (slip)'),
  "https://www.plumbing-example.com/coupling": html('PVC Coupling 1" slip')
};
const cand = (pageUrl, img) => ({ pageUrl, imageUrl: `https://img.example.com/${img}.jpg`, partNumberAsShown: "" });
const CATALOG = {
  PGPADJ:   { sku: "PGPADJ", partNumber: "PGP-ADJ", description: "PGP 4\" rotor adjustable", category: "sprinkler_heads", manufacturer: "hunter" },
  PGPADJB:  { sku: "PGPADJB", partNumber: "PGPADJ", description: "PGP rotor adjustable (supplier dup)", category: "sprinkler_heads", manufacturer: "hunter" },
  PGV100G:  { sku: "PGV100G", partNumber: "PGV-100G", description: "PGV 1\" valve", category: "valves", manufacturer: "hunter" },
  HSPROS04: { sku: "HSPROS04", partNumber: "HSPROS04", description: "Pro-Spray 4\" body", category: "sprinkler_heads", manufacturer: "hunter" },
  RBN10H:   { sku: "RBN10H", partNumber: "RBN10H", description: "Rain Bird 10H nozzle", category: "nozzles", manufacturer: "rainbird" },
  RBXFD1:   { sku: "RBXFD1", partNumber: "RBXFD100", description: "XFD dripline 100'", category: "drip", manufacturer: "rainbird" },
  RBXFD2:   { sku: "RBXFD2", partNumber: "XFD-09-12-500", description: "XFD dripline 500'", category: "drip", manufacturer: "rainbird" },
  NOPE:     { sku: "NOPE", partNumber: "RB-GONE-1", description: "Discontinued thing", category: "misc", manufacturer: "rainbird" },
  TEE34:    { sku: "TEE34", partNumber: "1401007", description: "Poly insert tee 3/4\"", category: "fittings", manufacturer: "" },
  TEE34B:   { sku: "TEE34B", partNumber: "1401007B", description: "Poly insert tee 3/4\"", category: "fittings", manufacturer: "" },
  ELB12:    { sku: "ELB12", partNumber: "406005", description: "PVC elbow 1/2\" slip", category: "fittings", manufacturer: "" },
  CPL1:     { sku: "CPL1", partNumber: "429010", description: "PVC coupling 1\" slip", category: "fittings", manufacturer: "" },
  LIVE1:    { sku: "LIVE1", partNumber: "PGJ-04", description: "PGJ rotor", category: "sprinkler_heads", manufacturer: "hunter" }
};
// What the (fake) finder reports, per SKU and pass.
const FIND = {
  PGPADJ:   { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand(`${HUNTER}/pgp-adj`, "pgp")] } },
  PGPADJB:  { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand(`${HUNTER}/pgp-adj`, "pgp-b")] } },
  PGV100G:  { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV-100G", candidates: [cand(`${HUNTER}/pgv`, "pgv")] } },
  HSPROS04: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PROS-04", candidates: [cand(`${HUNTER}/pro-spray`, "pros")] } },
  RBN10H:   { 1: { manufacturer: "Rain Bird", manufacturerPartNumber: "RBN10H", candidates: [cand("https://www.rainbird.com/products/rbn", "rbn")] } },
  RBXFD1:   { 1: null, 2: { manufacturer: "Rain Bird", manufacturerPartNumber: "XFD-09-12", candidates: [cand("https://www.siteone.com/en/rb-xfd", "xfd1")] } },
  RBXFD2:   { 1: null, 2: { manufacturer: "Rain Bird", manufacturerPartNumber: "XFD-09-12", candidates: [cand("https://www.siteone.com/en/rb-xfd", "xfd2")] } },
  NOPE:     {},
  TEE34:    { 2: { candidates: [cand("https://www.siteone.com/en/tee", "tee-s1"), cand("https://www.centralpros.com/tee", "tee-cp")] } },
  TEE34B:   { 2: { candidates: [cand("https://www.siteone.com/en/tee", "tee-b")] } },
  ELB12:    { 2: { candidates: [cand("https://www.siteone.com/en/elbow", "elb-s1"), cand("https://www.centralpros.com/elbow", "elb-cp")] } },
  CPL1:     { 2: null, 3: { candidates: [cand("https://www.plumbing-example.com/coupling", "cpl")] } }
};
const VISION = { RBN10H: V({ type: "fail" }) };
const COMPARE = { TEE34: "pass", ELB12: "fail" };

async function pngFor(url) {
  const h = crypto.createHash("sha256").update(url).digest();
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r: h[0], g: h[1], b: h[2] } } }).png().toBuffer();
}

function harness(dir, over = {}) {
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const catalog = over.catalog || CATALOG;
  const counts = { find: {}, verify: {}, compare: {}, fetchPage: 0 };
  const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
  let inFlight = 0; const peak = { v: 0 };
  const fake = {
    passesFor: ai.passesFor,
    async find(part, pass) {
      inc(counts.find, part.sku); inFlight++; peak.v = Math.max(peak.v, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (over.find) { const o = await over.find(part, pass); if (o !== undefined) return o; }
      const f = (FIND[part.sku] || {})[pass];
      return { manufacturer: "", manufacturerPartNumber: "", notes: f ? "" : `nothing on pass ${pass}`, candidates: [], ...(f || {}) };
    },
    async verify(part, bytes, mediaType) {
      inc(counts.verify, part.sku);
      if (over.verify) { const o = await over.verify(part, bytes); if (o !== undefined) return o; }
      return VISION[part.sku] || V();
    },
    async compare(part) { inc(counts.compare, part.sku); return { result: COMPARE[part.sku] || "unknown", reason: "mock" }; }
  };
  let clock = 1_000_000;
  const b = bf.createBackfill({
    dataDir: dir, store, ai: fake,
    getParts: () => store.mergeInto(structuredClone(catalog)),
    manufacturers: [{ key: "hunter", label: "Hunter" }, { key: "rainbird", label: "Rain Bird" }],
    fetchPage: async (url) => { counts.fetchPage++; if (over.fetchPage) { const o = await over.fetchPage(url); if (o !== undefined) return o; }
      if (!WEB[url]) throw Object.assign(new Error("404"), { status: 404 }); return { html: WEB[url], finalUrl: url }; },
    fetchImage: async (url) => ({ buffer: await pngFor(url), finalUrl: url }),
    now: () => clock, sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    concurrency: over.concurrency || 2,
    afterRun: over.afterRun || null
  });
  return { b, store, counts, peak, catalog, parts: () => store.mergeInto(structuredClone(catalog)), clock: () => clock };
}
const RUN_SKUS = Object.keys(FIND);

// 5a. Calibration-style run: auto-approve OFF → nothing goes live.
const report = [];
{
  const dir = tmp();
  const h = harness(dir);
  // LIVE1 already has Patrick's photo (approved via a confident+autoApprove record).
  const liveBuf = await pngFor("live1");
  const saved = await h.store.saveCandidateImage(liveBuf);
  await h.store.recordAiResult("LIVE1", CATALOG.LIVE1, { tier: "confident", candidates: [{ ...saved, source: {} }], chosen: 0 }, { autoApprove: true });
  const liveBefore = (await h.store.snapshot()).groups[(await h.store.snapshot()).links.LIVE1.groupId].photo.hash;
  check("fixture: LIVE1 is live", h.parts().LIVE1.photoState === "verified");

  await h.b.start({ skus: [...RUN_SKUS, "LIVE1"], autoApprove: false, label: "calibration" });
  await h.b.idle();
  const st = h.b._state().run;
  check("already-live SKU is never queued", !st.order.includes("LIVE1"));
  check("every SKU finished", st.order.every((s) => st.items[s].step === "done"), JSON.stringify(Object.fromEntries(st.order.map((s) => [s, st.items[s].step + ":" + st.items[s].lastError]))));
  const tiers = Object.fromEntries(st.order.map((s) => [s, st.items[s].result.tier]));
  const expect = { PGPADJ: "confident", PGPADJB: "confident", PGV100G: "not_confident", HSPROS04: "tbd", RBN10H: "not_confident",
    RBXFD1: "tbd", RBXFD2: "tbd", NOPE: "not_confident", TEE34: "confident", TEE34B: "tbd", ELB12: "not_confident", CPL1: "tbd" };
  for (const [sku, t] of Object.entries(expect)) check(`tier ${sku} = ${t}`, tiers[sku] === t, `got ${tiers[sku]} (${st.items[sku].result.reason})`);
  const parts = h.parts();
  check("auto-approve OFF: no AI photo is live", RUN_SKUS.every((s) => parts[s].photoState !== "verified"));
  check("auto-approve OFF: Confident waits as TBD with a clear reason", parts.PGPADJ.photoState === "tbd" && /auto-approve is off/.test((await h.store.snapshot()).groups[(await h.store.snapshot()).links.PGPADJ.groupId].reason));
  check("Not confident shows as not_confident", parts.PGV100G.photoState === "not_confident" && parts.NOPE.photoState === "not_confident");
  check("LIVE1's photo untouched", (await h.store.snapshot()).groups[(await h.store.snapshot()).links.LIVE1.groupId].photo.hash === liveBefore);
  check("generic: compare only runs with two independent sources", h.counts.compare.TEE34 === 1 && h.counts.compare.ELB12 === 1 && !h.counts.compare.TEE34B && !h.counts.compare.CPL1);
  check("branded never uses the open web", !Object.keys(FIND).filter((s) => CATALOG[s].manufacturer).some((s) => st.items[s].work.found && st.items[s].work.found.candidates.some((c) => c.pass === 3)));
  check("branded found on official site stops after pass 1", h.counts.find.PGPADJ === 1);
  check("RBXFD falls through to pass 2 (supplier)", h.counts.find.RBXFD1 === 2 && st.items.RBXFD1.work.found.candidates[0].pass === 2);
  check("PGV-100G only in URL/alt/title/link → part # fail", st.items.PGV100G.work.checked[0].partNumber.result === "fail");
  check("HSPROS04: only the manufacturer's number on page → unknown", st.items.HSPROS04.work.checked[0].partNumber.result === "unknown");
  check("candidates stored on the group with their checks", (() => { const s = h.store.readStoresSync(); const g = s.groups[s.links.TEE34.groupId]; return g.candidates.length === 2 && g.candidates.every((c) => c.checks && c.source.domain); })());
  check("every AI result is logged", fs.readFileSync(path.join(dir, "part-photos-log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"ai.result"')).length === 13); // 12 + LIVE1's fixture
  check("progress counts add up", (() => { const c = h.b.status().run.counts; return c.total === 12 && c.done === 12 && c.live === 0 && c.review + c.noReliable === 12; })(), JSON.stringify(h.b.status().run.counts));
  check("never more than 2 SKUs in flight", h.peak.v <= 2 && h.peak.v >= 2, `peak ${h.peak.v}`);
  for (const sku of st.order) report.push({ sku, kind: CATALOG[sku].manufacturer ? "branded" : "generic", off: tiers[sku], reason: st.items[sku].result.reason,
    pn: !CATALOG[sku].manufacturer ? "n/a" : st.items[sku].work.checked && st.items[sku].work.checked[0] && st.items[sku].work.checked[0].partNumber ? st.items[sku].work.checked[0].partNumber.result : "-",
    spec: st.items[sku].work.checked && st.items[sku].work.checked[0] && st.items[sku].work.checked[0].specMatch ? st.items[sku].work.checked[0].specMatch.result : "-",
    cross: st.items[sku].work.cross ? st.items[sku].work.cross.result : "-" });

  // 5b. Second run, auto-approve ON: only Confident goes live.
  await h.b.start({ skus: RUN_SKUS, autoApprove: true, label: "after calibration" });
  await h.b.idle();
  const p2 = h.parts();
  const liveNow = RUN_SKUS.filter((s) => p2[s].photoState === "verified").sort();
  check("auto-approve ON: exactly the Confident SKUs go live", JSON.stringify(liveNow) === JSON.stringify(["PGPADJ", "PGPADJB", "TEE34"]), liveNow.join());
  check("TBD never live, even with auto-approve ON", ["HSPROS04", "RBXFD1", "RBXFD2", "TEE34B", "CPL1"].every((s) => p2[s].photoState === "tbd"));
  check("Not confident never live, even with auto-approve ON", ["PGV100G", "RBN10H", "NOPE", "ELB12"].every((s) => p2[s].photoState === "not_confident"));
  const g2 = h.store.readStoresSync();
  const liveG = g2.groups[g2.links.PGPADJ.groupId];
  check("auto-approved photo is marked as such", liveG.approvedBy === "auto:confident" && liveG.source.method === "ai" && liveG.tier === "confident");
  check("history kept: previous run archived", h.b._state().history.length === 1);
  for (const r of report) r.on = p2[r.sku].photoState === "verified" ? "LIVE" : "not live";

  // A third run over the same SKUs: live ones are not even queued.
  await h.b.start({ skus: RUN_SKUS, autoApprove: true });
  check("live SKUs are skipped on later runs", !h.b._state().run.order.includes("PGPADJ") && !h.b._state().run.order.includes("TEE34"));
  await h.b.idle();

  // A Confident result for a SKU that went live meanwhile never replaces it.
  const beforeHash = g2.groups[g2.links.PGPADJ.groupId].photo.hash;
  const other = await h.store.saveCandidateImage(await pngFor("other"));
  const res = await h.store.recordAiResult("PGPADJ", CATALOG.PGPADJ, { tier: "confident", candidates: [{ ...other, source: {} }], chosen: 0 }, { autoApprove: true });
  const g3 = h.store.readStoresSync();
  check("recordAiResult never overwrites a live photo", res.skipped && g3.groups[g3.links.PGPADJ.groupId].photo.hash === beforeHash);

  // 5c. Grouping.
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5c'. Grouping. Auto-link needs same mfr + mfr part # on official pages,
// AND must not silently collapse two DIFFERENT live photos.
const pairIn = (x, a, b) => x.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a) || (p.sku === a && p.into === b) || (p.sku === b && p.into === a));
{
  // Neither live yet (auto-approve OFF) → auto-link.
  const dir = tmp();
  const h = harness(dir);
  await h.b.start({ skus: RUN_SKUS, autoApprove: false });
  await h.b.idle();
  const gr = await h.b.applyGrouping();
  check("neither live: same Hunter part # on the official page → auto-link", gr.applied.length === 1 && pairIn(gr.applied, "PGPADJ", "PGPADJB"), JSON.stringify(gr.applied));
  check("same Rain Bird number from a SUPPLIER page → proposal only", pairIn(gr.proposals, "RBXFD1", "RBXFD2"));
  check("same generic spec → proposal only", pairIn(gr.proposals, "TEE34", "TEE34B"));
  const s = h.store.readStoresSync();
  check("auto-linked SKU now shares the fitting", s.links.PGPADJB.groupId === s.links.PGPADJ.groupId && s.links.PGPADJB.linkedBy === "auto:mfr-part");
  check("proposed SKUs stay separate", s.links.RBXFD1.groupId !== s.links.RBXFD2.groupId && s.links.TEE34.groupId !== s.links.TEE34B.groupId);
  check("grouping is audit-logged", fs.readFileSync(path.join(dir, "part-photos-log.jsonl"), "utf8").includes('"link.auto"'));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Both live with DIFFERENT AI photos → Fittings to confirm, no link.
  const dir = tmp();
  const h = harness(dir);
  await h.b.start({ skus: ["PGPADJ", "PGPADJB"], autoApprove: true });
  await h.b.idle();
  const p0 = h.parts();
  check("fixture: both live, different photos", p0.PGPADJ.photoState === "verified" && p0.PGPADJB.photoState === "verified" && p0.PGPADJ.photo.thumb !== p0.PGPADJB.photo.thumb);
  const gr = await h.b.applyGrouping();
  const s = h.store.readStoresSync();
  check("both live, different photos → proposal, not auto-link", gr.applied.length === 0 && pairIn(gr.proposals, "PGPADJ", "PGPADJB") && s.links.PGPADJ.groupId !== s.links.PGPADJB.groupId, JSON.stringify(gr));
  check("…and each keeps its own photo", h.parts().PGPADJ.photo.thumb === p0.PGPADJ.photo.thumb && h.parts().PGPADJB.photo.thumb === p0.PGPADJB.photo.thumb);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Both live with the SAME stored image → auto-link.
  const dir = tmp();
  const same = { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand(HUNTER + "/pgp-adj", "pgp")], notes: "" };
  const h = harness(dir, { find: (part, pass) => (part.sku === "PGPADJB" && pass === 1 ? same : undefined) });
  await h.b.start({ skus: ["PGPADJ", "PGPADJB"], autoApprove: true });
  await h.b.idle();
  const gr = await h.b.applyGrouping();
  const s = h.store.readStoresSync();
  check("both live, same image hash → auto-link", gr.applied.length === 1 && s.links.PGPADJ.groupId === s.links.PGPADJB.groupId, JSON.stringify(gr));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Only one live (AI) → allowed, and the one without a photo joins it.
  const dir = tmp();
  const h = harness(dir);
  await h.b.start({ skus: ["PGPADJ"], autoApprove: true }); await h.b.idle();
  await h.b.start({ skus: ["PGPADJB"], autoApprove: false }); await h.b.idle();
  const r1 = await h.store.autoLinkSameFitting("PGPADJ", CATALOG.PGPADJ, "PGPADJB", { reason: "test" });
  check("the live one is never moved onto a fitting without a photo", r1.skipped && !r1.propose);
  const r2 = await h.store.autoLinkSameFitting("PGPADJB", CATALOG.PGPADJB, "PGPADJ", { reason: "test" });
  check("one live AI photo → the other joins it and shows it", !r2.skipped && h.parts().PGPADJB.photo && h.parts().PGPADJB.photo.sharedWith.includes("PGPADJ"));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5d. Patrick's own photos and links are never touched by automation.
{
  const dir = tmp();
  const h = harness(dir);
  await h.store.setPhoto("PGPADJB", CATALOG.PGPADJB, await pngFor("patricks"), { by: "patrick", source: { method: "upload" } });
  await h.b.start({ skus: RUN_SKUS, autoApprove: false });
  await h.b.idle();
  const before = h.store.readStoresSync();
  check("fixture: PGPADJB has Patrick's photo and was not re-queued", h.parts().PGPADJB.photoState === "verified" && !h.b._state().run.order.includes("PGPADJB"));
  const res = await h.store.autoLinkSameFitting("PGPADJB", CATALOG.PGPADJB, "PGPADJ", { reason: "test" });
  check("Patrick's photo is never auto-moved", res.skipped && h.store.readStoresSync().links.PGPADJB.groupId === before.links.PGPADJB.groupId);
  const res2 = await h.store.autoLinkSameFitting("PGPADJ", CATALOG.PGPADJ, "PGPADJB", { reason: "test" });
  check("a part with no live photo joins Patrick's fitting", !res2.skipped && h.parts().PGPADJ.photo.approvedBy === "patrick");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5e. Supplier-code mapping: HSPGPADJ → SiteOne page → PGP-ADJ → Hunter.
{
  const M = ev.supplierCodeMapping;
  const both = html("Hunter PGP Adjustable Rotor. Item # HSPGPADJ. Mfr. Part # PGP-ADJ.");
  check("mapping: both numbers visible on a SiteOne page → pass", M(both, "https://www.siteone.com/en/hspgpadj", ["HSPGPADJ"], ["PGP-ADJ"], "hunter").result === "pass");
  check("mapping: our code only in URL/alt/title/link → no mapping", M(html("Hunter PGP Adjustable Rotor. Mfr. Part # PGP-ADJ.", "HSPGPADJ"), "https://www.siteone.com/en/hspgpadj", ["HSPGPADJ"], ["PGP-ADJ"], "hunter").result === "unknown");
  check("mapping: unknown site never maps", M(both, "https://www.random-shop.com/p", ["HSPGPADJ"], ["PGP-ADJ"], "hunter").result === "unknown");
  check("mapping: manufacturer number missing → no mapping", M(html("Item # HSPGPADJ rotor"), "https://www.siteone.com/x", ["HSPGPADJ"], ["PGP-ADJ"], "hunter").result === "unknown");

  WEB["https://www.siteone.com/en/hspgpadj"] = both;
  WEB["https://www.siteone.com/en/hspgpadj-alt-only"] = html("Hunter PGP Adjustable Rotor. Mfr. Part # PGP-ADJ.", "HSPGPADJX");
  const map = {
    HSPGPADJ:  { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand(HUNTER + "/pgp-adj", "pgp")] },
                 2: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand("https://www.siteone.com/en/hspgpadj", "so")] } },
    HSPGPADJX: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand(HUNTER + "/pgp-adj", "pgp")] },
                 2: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [cand("https://www.siteone.com/en/hspgpadj-alt-only", "so")] } }
  };
  const catalog = { ...CATALOG,
    HSPGPADJ:  { sku: "HSPGPADJ", partNumber: "HSPGPADJ", description: "PGP 4\" rotor adjustable", category: "sprinkler_heads", manufacturer: "hunter" },
    HSPGPADJX: { sku: "HSPGPADJX", partNumber: "HSPGPADJX", description: "PGP 4\" rotor adjustable", category: "sprinkler_heads", manufacturer: "hunter" } };
  const dir = tmp();
  const h = harness(dir, { catalog, find: (part, pass) => (map[part.sku] ? { notes: "", ...(map[part.sku][pass] || { candidates: [] }) } : undefined) });
  await h.b.start({ skus: ["HSPGPADJ", "HSPGPADJX"], autoApprove: true });
  await h.b.idle();
  const st = h.b._state().run;
  const pn = st.items.HSPGPADJ.work.checked[0].partNumber;
  check("HSPGPADJ → SiteOne → PGP-ADJ → official Hunter page = Confident", st.items.HSPGPADJ.result.tier === "confident" && h.parts().HSPGPADJ.photoState === "verified", JSON.stringify(st.items.HSPGPADJ.result));
  check("…the mapping page is recorded as the evidence", pn.result === "pass" && pn.mappedVia === "https://www.siteone.com/en/hspgpadj");
  check("our code only in hidden page parts → stays TBD", st.items.HSPGPADJX.result.tier === "tbd" && h.parts().HSPGPADJX.photoState === "tbd");
  check("mapping search runs once per SKU, only when needed", h.counts.find.HSPGPADJ === 2 && h.counts.find.HSPGPADJX === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}


// 6. Stop / restart.
{
  const dir = tmp();
  let hangVerify = true, verifySeen = 0;
  const A = harness(dir, { concurrency: 1, verify: (part) => {
    if (part.sku === "TEE34" && hangVerify) { verifySeen++; if (verifySeen === 2) return new Promise(() => {}); }
    return undefined;
  } });
  await A.b.start({ skus: ["PGPADJ", "TEE34", "TEE34B"], autoApprove: false });
  for (let i = 0; i < 500 && verifySeen < 2; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50)); // let the partial save land
  check("setup: process 'stopped' mid-verify on TEE34", verifySeen === 2);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "part-photos-backfill.json"), "utf8"));
  check("disk: PGPADJ done, TEE34 at verify, TEE34B queued", onDisk.run.items.PGPADJ.step === "done" && onDisk.run.items.TEE34.step === "verify" && onDisk.run.items.TEE34B.step === "queued",
    JSON.stringify(Object.fromEntries(Object.entries(onDisk.run.items).map(([k, v]) => [k, v.step]))));
  check("disk: TEE34's first verified candidate was kept", onDisk.run.items.TEE34.work.checked.filter((c) => c.vision).length === 1);

  hangVerify = false;
  const B = harness(dir);
  await B.b.resume();
  await B.b.idle();
  const st = B.b._state().run;
  check("after restart everything finishes", st.status === "done" && st.order.every((s) => st.items[s].step === "done"));
  check("finished SKU not redone", !B.counts.find.PGPADJ && !B.counts.verify.PGPADJ);
  check("interrupted SKU resumes at its step (no new search, no refetch)", !B.counts.find.TEE34 && B.counts.verify.TEE34 === 1);
  check("resumed SKU reaches the same tier as an uninterrupted run", st.items.TEE34.result.tier === "confident");
  check("queued SKU ran normally", B.counts.find.TEE34B === 1 && st.items.TEE34B.result.tier === "tbd");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. Retries and failures.
{
  const dir = tmp();
  let n429 = 0;
  const h = harness(dir, {
    fetchPage: (url) => { if (url.endsWith("/pgp-adj") && n429 < 2) { n429++; throw Object.assign(new Error("429 Too Many Requests"), { status: 429, transient: true }); } },
    find: (part) => {
      if (part.sku === "HSPROS04") throw Object.assign(new Error("The model declined this request."), { permanent: true });
      if (part.sku === "RBN10H") throw Object.assign(new Error("overloaded"), { status: 529 });
    }
  });
  const t0 = h.clock();
  await h.b.start({ skus: ["PGPADJ", "HSPROS04", "RBN10H"], autoApprove: false });
  await h.b.idle();
  const st = h.b._state().run;
  check("429 twice then OK → finishes", st.items.PGPADJ.step === "done" && st.items.PGPADJ.result.tier === "confident" && n429 === 2);
  check("backoff waited 5s then 30s", h.clock() - t0 >= 35_000, `${h.clock() - t0}ms`);
  check("permanent error → SKU marked error, not retried", st.items.HSPROS04.step === "error" && st.items.HSPROS04.failedStep === "find" && h.counts.find.HSPROS04 === 1);
  check("transient 3× → gives up with the reason", st.items.RBN10H.step === "error" && h.counts.find.RBN10H === 3 && /overloaded/.test(st.items.RBN10H.lastError));
  check("an error SKU is not a 'no photo' result", !h.store.readStoresSync().links.HSPROS04);
  check("run finishes around errors", st.status === "done" && h.b.status().run.counts.error === 2);
  await rejects("retry refuses a SKU that isn't in error", () => h.b.retry("PGPADJ"), /error state/);
  fs.rmSync(dir, { recursive: true, force: true });

  // Retry a single SKU after the cause is gone.
  const dir2 = tmp();
  let refuse = true;
  const h2 = harness(dir2, { find: (part) => { if (refuse && part.sku === "HSPROS04") throw Object.assign(new Error("declined"), { permanent: true }); } });
  await h2.b.start({ skus: ["HSPROS04"] }); await h2.b.idle();
  refuse = false;
  await h2.b.retry("HSPROS04"); await h2.b.idle();
  check("retry of one SKU completes it", h2.b._state().run.items.HSPROS04.step === "done" && h2.b._state().run.items.HSPROS04.result.tier === "tbd");
  fs.rmSync(dir2, { recursive: true, force: true });
}

// 8. Pause / resume, one run at a time, damaged state.
{
  const dir = tmp();
  let hPause = null;
  const h = harness(dir, { concurrency: 1, find: async (part) => { if (part.sku === "PGPADJ") await hPause.b.pause(); } });
  hPause = h;
  await h.b.start({ skus: ["PGPADJ", "PGPADJB", "TEE34"] });
  await h.b.idle();
  const st = h.b._state().run;
  check("pause stops new work", st.status === "paused" && st.items.TEE34.step === "queued");
  await rejects("a second run can't start while one is paused", () => h.b.start({ skus: ["CPL1"] }), /already in progress/);
  await h.b.resume(); await h.b.idle();
  check("resume finishes the run", h.b._state().run.status === "done");
  fs.writeFileSync(path.join(dir, "part-photos-backfill.json"), "{ broken");
  const again = harness(dir);
  await rejects("damaged state file is never treated as empty", () => again.b.load(), /unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 9. Calibration sample on the real catalog.
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, "parts.json"), "utf8"));
const realParts = Array.isArray(REAL.parts) ? REAL.parts : Object.values(REAL.parts);
const sample = ev.pickCalibrationSample(realParts, { branded: 8, generic: 7 });
{
  check("calibration: 8 branded + 7 generic = 15 distinct", sample.branded.length === 8 && sample.generic.length === 7 && new Set(sample.skus).size === 15);
  check("calibration: branded all have an official manufacturer site", sample.branded.every((p) => ev.MANUFACTURER_DOMAINS[p.manufacturer]));
  check("calibration: generic have none", sample.generic.every((p) => !ev.MANUFACTURER_DOMAINS[p.manufacturer]));
  const count = (m) => sample.branded.filter((p) => p.manufacturer === m).length;
  check("calibration: 3 Hunter + 3 Rain Bird + 2 others", count("hunter") === 3 && count("rainbird") === 3 && sample.branded.length - 6 === 2);
  check("calibration: Hunter picks span different categories", new Set(sample.branded.filter((p) => p.manufacturer === "hunter").map((p) => p.category)).size === 3);
  check("calibration: generic spans ≥5 shapes", new Set(sample.generic.map(ev.shapeOf)).size >= 5, sample.generic.map(ev.shapeOf).join());
  const mats = sample.generic.map((p) => /\bpvc\b/i.test(p.description) ? "pvc" : /\bpoly\b/i.test(p.description) ? "poly" : "other");
  check("calibration: both PVC and poly fittings", mats.includes("pvc") && mats.includes("poly"));
  const liveSku = sample.skus[0];
  const s2 = ev.pickCalibrationSample(realParts, { branded: 8, generic: 7, isLive: (p) => p.sku === liveSku });
  check("calibration: live parts are excluded", !s2.skus.includes(liveSku) && s2.skus.length === 15);
  check("calibration: reproducible", JSON.stringify(ev.pickCalibrationSample(realParts, {}).skus) === JSON.stringify(sample.skus));
}

// ---- 10. The calibration run (M3c): the only start door, hard-limited ----
{
  const dir = tmp();
  let afterRuns = [];
  const h = harness(dir, { afterRun: async (run) => { afterRuns.push(run.status); } });
  // LIVE1 already has a photo → never in the sample.
  const saved = await h.store.saveCandidateImage(await pngFor("live1"));
  await h.store.recordAiResult("LIVE1", CATALOG.LIVE1, { tier: "confident", candidates: [{ ...saved, source: {} }], chosen: 0 }, { autoApprove: true });
  const plan = h.b.calibrationPlan();
  check("calibration plan: auto-approve is OFF, at most 15 parts, ≤8 branded, ≤7 generic", plan.autoApprove === false && plan.skus.length <= 15 && plan.counts.branded <= 8 && plan.counts.generic <= 7 && plan.skus.length === plan.rows.length, JSON.stringify(plan.counts));
  check("calibration plan: a part with a live photo is excluded", !plan.skus.includes("LIVE1"));
  check("calibration plan: mixed kinds", plan.counts.branded > 0 && plan.counts.generic > 0);
  const e = plan.estimate;
  const rowsMax = plan.rows.reduce((n, r) => n + r.calls.finderMax + r.calls.verifyMax + r.calls.compareMax, 0);
  check("calibration plan: the estimate adds up (branded ≤3 finder, generic ≤2 finder, ≤3 vision each, compare for generic only)",
    e.apiCalls.max === rowsMax && e.webSearches.max === e.finderCalls.max * 6 && plan.rows.every((r) => r.calls.finderMax === (r.kind === "branded" ? 3 : 2) && r.calls.compareMax === (r.kind === "generic" ? 1 : 0)), JSON.stringify(e));
  const st = await h.b.startCalibration({ by: "patrick" });
  await rejects("calibration: a second start while one is active is refused", () => h.b.startCalibration({ by: "patrick" }), /already active/);
  await rejects("calibration: the general start is refused too while active", () => h.b.start({ skus: ["PGPADJ"], autoApprove: true }), /already in progress/);
  const run = h.b._state().run;
  check("calibration: the run is exactly the plan's SKUs, labelled, auto-approve off, attributed", JSON.stringify(run.order.slice().sort()) === JSON.stringify(plan.skus.slice().sort()) && run.label === "Calibration" && run.options.autoApprove === false && run.calibration.by === "patrick" && st.run.calibration.skus.length === plan.skus.length);
  await h.b.idle();
  const parts = h.parts();
  const done = h.b._state().run;
  check("calibration: every sample part finished", done.status === "done" && done.order.every((s) => ["done", "error"].includes(done.items[s].step)));
  check("calibration: Confident results exist but NOTHING went live", done.order.some((s) => done.items[s].result && done.items[s].result.tier === "confident") && done.order.every((s) => parts[s].photoState !== "verified"));
  const g = h.store.readStoresSync();
  check("calibration: no group touched by the run holds a live photo", done.order.every((s) => { const gr = g.links[s] && g.groups[g.links[s].groupId]; return !gr || !gr.photo; }));
  check("calibration: only sample parts were processed", Object.keys(h.counts.find).every((s) => plan.skus.includes(s)) && !h.counts.find.LIVE1);
  check("calibration: LIVE1's photo untouched", parts.LIVE1.photoState === "verified");
  check("calibration: afterRun ran once, when the run was done", afterRuns.length === 1 && afterRuns[0] === "done");
  check("calibration: status reports it", h.b.status().run.calibration && h.b.status().run.calibration.skus.length === plan.skus.length && h.b.status().run.autoApprove === false);
  // Done → a new calibration may start again (and re-queues the not-live ones).
  await h.b.startCalibration({ by: "patrick" });
  check("calibration: can run again once the previous run is done", h.b._state().run.status === "running");
  await h.b.idle();
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // A refused or failed AI call can never make anything live.
  const dir = tmp();
  const h = harness(dir, { find: (part) => {
    if (part.sku === "PGPADJ") throw Object.assign(new Error("The model declined this request."), { permanent: true });
    if (part.sku === "TEE34") throw Object.assign(new Error("overloaded"), { status: 529 });
  }, verify: (part) => { if (part.sku === "PGV100G") throw Object.assign(new Error("vision refused"), { permanent: true }); } });
  await h.b.startCalibration({ by: "patrick" }); await h.b.idle();
  const run = h.b._state().run, parts = h.parts(), s = h.store.readStoresSync();
  const errored = run.order.filter((x) => run.items[x].step === "error");
  check("calibration: refused / failed calls end as errors, not results", errored.includes("PGPADJ") && errored.includes("TEE34") && errored.includes("PGV100G"));
  check("calibration: an errored part has no link and no photo", errored.every((x) => !s.links[x]) && errored.every((x) => parts[x].photoState === "none"));
  check("calibration: errors are listed on the status", h.b.status().run.errors.length === errored.length && h.b.status().run.errors.every((e) => e.error));
  check("calibration: still nothing live at all", run.order.every((x) => parts[x].photoState !== "verified"));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Nothing to calibrate → refuse.
  const dir = tmp();
  const catalog = { LIVE1: CATALOG.LIVE1 };
  const h = harness(dir, { catalog });
  const saved = await h.store.saveCandidateImage(await pngFor("live1"));
  await h.store.recordAiResult("LIVE1", CATALOG.LIVE1, { tier: "confident", candidates: [{ ...saved, source: {} }], chosen: 0 }, { autoApprove: true });
  await rejects("calibration: refuses when every sample part is already live", () => h.b.startCalibration({ by: "patrick" }), /Nothing to calibrate/);
  check("…and no run was created", !h.b._state().run);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // A run interrupted by a restart/deploy does NOT continue by itself.
  const dir = tmp();
  let hung = 0;
  const A = harness(dir, { concurrency: 1, find: (part) => { if (part.sku === "TEE34") { hung++; return new Promise(() => {}); } } });
  await A.b.start({ skus: ["PGPADJ", "TEE34"], autoApprove: false });
  for (let i = 0; i < 300 && !hung; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  check("setup: process 'died' with the run running", JSON.parse(fs.readFileSync(path.join(dir, "part-photos-backfill.json"), "utf8")).run.status === "running");
  const B = harness(dir);
  await B.b.load();
  const st = B.b.status().run;
  check("restart: the run is shown as paused/interrupted, not running", st.status === "paused" && !!st.interruptedAt);
  await new Promise((r) => setTimeout(r, 60));
  check("restart: nothing ran on its own", Object.keys(B.counts.find).length === 0);
  await B.b.resume(); await B.b.idle();
  check("restart: Resume finishes it", B.b._state().run.status === "done" && B.counts.find.TEE34 === 1 && !B.counts.find.PGPADJ);
  fs.rmSync(dir, { recursive: true, force: true });
}


{
  // On the REAL catalog (143 parts) the plan is exactly the 15-part sample.
  const dir = tmp();
  const h = harness(dir, { catalog: Object.fromEntries(realParts.map((p) => [p.sku, p])) });
  const plan = h.b.calibrationPlan();
  check("calibration plan on the real catalog: exactly the 15-part sample, 8 branded + 7 generic", plan.skus.length === 15 && plan.counts.branded === 8 && plan.counts.generic === 7 && JSON.stringify(plan.skus) === JSON.stringify(sample.skus), plan.skus.join(","));
  check("calibration plan on the real catalog: worst case ≤ 15 finder + 45 vision + 7 compare", plan.estimate.finderCalls.max === 8 * 3 + 7 * 2 && plan.estimate.verifyCalls.max === 45 && plan.estimate.compareCalls.max === 7 && plan.estimate.apiCalls.max === 38 + 45 + 7);
  fs.rmSync(dir, { recursive: true, force: true });
}

if (REPORT) {
  console.log("\nMocked verification results (auto-approve OFF → ON)");
  console.log("SKU        kind     part#    spec     2nd src  tier            OFF      ON");
  for (const r of report) console.log(`${r.sku.padEnd(10)} ${r.kind.padEnd(8)} ${r.pn.padEnd(8)} ${r.spec.padEnd(8)} ${r.cross.padEnd(8)} ${r.off.padEnd(15)} not live ${r.on}   ${r.reason}`);
  console.log("\nCalibration sample (real catalog)");
  for (const p of [...sample.branded, ...sample.generic]) console.log(`${p.sku.padEnd(12)} ${(p.manufacturer || "generic").padEnd(9)} ${String(p.category).padEnd(16)} ${ev.shapeOf(p).padEnd(9)} ${p.description}`);
}

console.log(`\ntest-photo-backfill: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

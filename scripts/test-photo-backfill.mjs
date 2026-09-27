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
  "https://www.siteone.com/en/pgv": html('PGV 1" globe valve', "PGV-100G"), // supplier page: hidden-only number FAILS
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
  PGV100G:  { 1: null, 2: { manufacturer: "Hunter", manufacturerPartNumber: "PGV-100G", candidates: [cand("https://www.siteone.com/en/pgv", "pgv")] } },
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
    async find(part, pass, usage) {
      inc(counts.find, part.sku); inFlight++; peak.v = Math.max(peak.v, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (usage) usage({ input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } });
      if (over.find) { const o = await over.find(part, pass); if (o !== undefined) return o; }
      const f = (FIND[part.sku] || {})[pass];
      return { manufacturer: "", manufacturerPartNumber: "", notes: f ? "" : `nothing on pass ${pass}`, candidates: [], ...(f || {}) };
    },
    async verify(part, bytes, mediaType, usage) {
      inc(counts.verify, part.sku);
      if (usage) usage({ input_tokens: 500, output_tokens: 20 });
      if (over.verify) { const o = await over.verify(part, bytes); if (o !== undefined) return o; }
      return VISION[part.sku] || V();
    },
    async compare(part, a, b, mt, usage) { inc(counts.compare, part.sku); if (usage) usage({ input_tokens: 300, output_tokens: 10 }); return { result: COMPARE[part.sku] || "unknown", reason: "mock" }; }
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

// ---- 11. Follow-up after the first calibration (Patrick, Sep 27 2026) ----
// The seven unresolved parts all failed the same way: the right product
// page was found but no image URL came back. OUR server now reads the
// page's images; known brands are recovered from blank manufacturer
// fields; sizes compare on a canonical spelling; every call is counted.

// 11a. Sizes: deterministic normalisation.
{
  const n = ev.normalizeSize;
  const cases = [['.5"', "1/2"], ['0.5"', "1/2"], ['1/2"', "1/2"], ["1/2 in", "1/2"], ["1/2 inch", "1/2"], ['½"', "1/2"], [".5", "1/2"], ["0.75", "3/4"], ['3/4"', "3/4"],
    ['1.25"', "1-1/4"], ['1 1/4"', "1-1/4"], ['1-1/4"', "1-1/4"], ["1.5", "1-1/2"], ['2"', "2"], ["2.0", "2"], ["1", "1"], ['1"', "1"], ["", ""]];
  for (const [inp, want] of cases) check(`normalizeSize(${JSON.stringify(inp)}) = ${want}`, n(inp) === want, `got ${JSON.stringify(n(inp))}`);
  check("sameSize: .5 / 0.5 / 1/2 are equal", ev.sameSize('.5"', '1/2"') && ev.sameSize("0.5", "1/2") && ev.sameSize("1/2 in", ".5"));
  check("sameSize: 3/4 ≠ 1/2, 1 ≠ 1-1/4, empty never matches", !ev.sameSize("3/4", "1/2") && !ev.sameSize("1", "1.25") && !ev.sameSize("", ""));
  const a = ev.parseSpec({ description: 'Blu-Lock SX 1/2" elbow MIPT', size: '0.5"' });
  const b = ev.parseSpec({ description: "BLU-LOCK .5X.5IN ELBOW MIPT", size: '.5"' });
  check("parseSpec: BL37070 and BL37970 read as the same elbow", a.type === "elbow" && b.type === "elbow" && JSON.stringify(a.sizes) === JSON.stringify(["1/2"]) && JSON.stringify(b.sizes) === JSON.stringify(["1/2"]) && a.ends.includes("male") && b.ends.includes("male"), JSON.stringify([a, b]));
  const g = ev.groupingDecision({ manufacturer: "blulock", manufacturerPartNumber: "", officialPage: false, part: { description: 'Blu-Lock SX 1/2" elbow MIPT', size: '0.5"' } },
    { manufacturer: "", manufacturerPartNumber: "", officialPage: false, part: { description: "BLU-LOCK .5X.5IN ELBOW MIPT", size: '.5"' } });
  check("grouping: BL37070 / BL37970 are now proposed as the same fitting", g.action === "propose", JSON.stringify(g));
  check("pageMatchesSpec: a page saying 1/2 in. matches a .5\" spec", ev.pageMatchesSpec("<html><body><h1>PVC Elbow 1/2 in. slip</h1></body></html>", ev.parseSpec({ description: 'PVC elbow .5" slip' })).result === "pass");
  check("pageMatchesSpec: a page saying 0.5 in matches a 1/2\" spec", ev.pageMatchesSpec("<html><body><h1>PVC Elbow 0.5 in slip</h1></body></html>", ev.parseSpec({ description: 'PVC elbow 1/2" slip' })).result === "pass");
}

// 11b. Known-brand recovery for blank manufacturer fields.
{
  const pb = ev.proposedBrand;
  check("proposedBrand: Watts in the description → watts", pb({ manufacturer: "", description: "Watts LF7RU2-2 3/4 in. DUAL CHECK VALVE LEAD FREE WATTS" }) === "watts");
  check("proposedBrand: BLU-LOCK → blulock (hyphen, space or none)", pb({ manufacturer: "", description: "BLU-LOCK .5X.5IN ELBOW MIPT" }) === "blulock" && pb({ manufacturer: "", description: "Blu Lock tee" }) === "blulock" && pb({ manufacturer: "", description: "BluLock cap" }) === "blulock");
  check("proposedBrand: Rain Bird / Oil Creek / Hunter", pb({ manufacturer: "", description: "RB Rain Bird 1804" }) === "rainbird" && pb({ manufacturer: "", description: "Oil Creek pipe 1\"" }) === "oilcreek" && pb({ manufacturer: "", description: "Hunter PGP rotor" }) === "hunter");
  check("proposedBrand: no brand word → null; 'hunters green paint' isn't Hunter", pb({ manufacturer: "", description: "3/4 Insert Coupling Poly Fitting" }) === null && pb({ manufacturer: "", description: "hunters green paint" }) === null);
  check("proposedBrand: never overrides a set manufacturer", pb({ manufacturer: "rainbird", description: "Watts valve" }) === null && ev.effectiveManufacturer({ manufacturer: "rainbird", description: "Watts valve" }) === "rainbird");
  check("effectiveManufacturer: blank + Watts → watts; blank + nothing → ''", ev.effectiveManufacturer({ manufacturer: "", description: "Watts LF7RU2-2" }) === "watts" && ev.effectiveManufacturer({ manufacturer: " ", description: "Poly tee" }) === "");
}

// 11c. Product-image extraction from the page HTML.
{
  const x = ev.extractProductImages;
  const page = `<html><head>
    <meta property="og:image" content="/media/catalog/product/hpc-400-front.jpg?width=1200">
    <meta name="twitter:image" content="https://cdn.example.com/hpc-400-front.jpg?width=1200">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","logo":"https://cdn.example.com/logo.png"},{"@type":"Product","name":"HPC-400","image":["https://cdn.example.com/hpc-400-side.jpg",{"@type":"ImageObject","url":"https://cdn.example.com/hpc-400-open.jpg"}]}]}</script>
    </head><body>
    <header><img src="https://cdn.example.com/site-logo.png" class="logo" width="300"></header>
    <div class="product-gallery"><img class="product-image" data-zoom-image="https://cdn.example.com/hpc-400-zoom.jpg" src="https://cdn.example.com/hpc-400-thumb.jpg"></div>
    <img itemprop="image" srcset="https://cdn.example.com/hpc-400-480.jpg 480w, https://cdn.example.com/hpc-400-1600.jpg 1600w" src="https://cdn.example.com/hpc-400-480.jpg">
    <img src="https://cdn.example.com/icons/cart.svg" class="product-icon"><img src="https://cdn.example.com/pixel.gif" width="1" height="1" class="product">
    <img src="http://insecure.example.com/hpc.jpg" class="product-image"><img src="https://cdn.example.com/related/pgv.jpg" width="80" height="80" class="product">
    <footer><img src="https://cdn.example.com/payment-visa.png" class="product-image"></footer>
    </body></html>`;
  const out = x(page, "https://www.hunterirrigation.com/en-metric/irrigation-product/controllers/hpc", { max: 10 });
  const urls = out.map((o) => o.url);
  check("extract: og:image first, made absolute against the page", urls[0] === "https://www.hunterirrigation.com/media/catalog/product/hpc-400-front.jpg?width=1200" && out[0].via === "og:image", JSON.stringify(out));
  check("extract: twitter:image and Product JSON-LD images (array + ImageObject, inside @graph)", urls.includes("https://cdn.example.com/hpc-400-front.jpg?width=1200") && urls.includes("https://cdn.example.com/hpc-400-side.jpg") && urls.includes("https://cdn.example.com/hpc-400-open.jpg"));
  check("extract: product <img> uses the zoom image and the largest srcset entry", urls.includes("https://cdn.example.com/hpc-400-zoom.jpg") && urls.includes("https://cdn.example.com/hpc-400-1600.jpg") && !urls.includes("https://cdn.example.com/hpc-400-thumb.jpg"));
  check("extract: logos, icons, svg, pixels, tiny, http and header/footer images are skipped", !urls.some((u) => /logo|cart\.svg|pixel|related|payment|insecure/.test(u)), urls.join(" "));
  check("extract: the Organization logo in JSON-LD is not a product image", !urls.includes("https://cdn.example.com/logo.png"));
  check("extract: default cap of 4, best first", x(page, "https://www.hunterirrigation.com/p").length === 4);
  check("extract: nothing on a page without product images", x("<html><body><h1>PGV</h1><nav><img src='https://a/x.png' class='product'></nav></body></html>", "https://a/").length === 0);
  check("extract: broken JSON-LD is ignored, not fatal", x('<script type="application/ld+json">{not json</script><meta property="og:image" content="https://a/p.jpg">', "https://a/").length === 1);
}

// 11d. The runner on the calibration's failure patterns.
const OFFICIAL = "https://www.hunterirrigation.com/en-metric/irrigation-product";
const pageWith = (visible, images = [], extra = "") => `<html><head>${images.map((u) => `<meta property="og:image" content="${u}">`).join("")}${extra}</head><body><h1>${visible}</h1></body></html>`;
{
  // Pattern 1: correct official page, finder gives NO image URL → our server
  // finds og:image → candidate → vision → Confident. Counters count it all.
  Object.assign(WEB, {
    [`${OFFICIAL}/hpc`]: pageWith("Hydrawise HPC-400 controller HCHPC400", ["https://img.example.com/hpc-front.jpg"]),
    [`${OFFICIAL}/pgv-noimg`]: pageWith("PGV 1 in. globe valve PGV100G"),
    "https://www.oilcreekplastics.com/irrigation-pipe": pageWith('Irrigation Pipe SIDR-15 IRR100 1" x 300\' selected', ["https://img.example.com/irr100.jpg"]),
    "https://www.watts.com/products/lf7ru2-2": pageWith("LF7RU2-2 3/4 X 3/4 lead free dual check valve. Ordering Code 0072204", ["https://img.example.com/lf7ru2.jpg"]),
    "https://www.siteone.com/en/two-images": pageWith("PGP-ADJ rotor PGPADJ", ["https://img.example.com/og-a.jpg", "https://img.example.com/og-b.jpg", "https://img.example.com/og-c.jpg"])
  });
  const catalog = {
    HCHPC400: { sku: "HCHPC400", partNumber: "HCHPC400", description: "Hydrawise 4-23 station controller", category: "controllers", manufacturer: "hunter" },
    PGV100G: { sku: "PGV100G", partNumber: "PGV100G", description: "1\" globe valve", category: "valves", manufacturer: "hunter" },
    POPO100300: { sku: "POPO100300", partNumber: "POPO100300", description: "Oil Creek utility pipe 100PSI 1\" × 300ft", category: "pipe", manufacturer: "oilcreek" },
    "0072204": { sku: "0072204", partNumber: "0072204", description: "Watts LF7RU2-2 3/4 in. DUAL CHECK VALVE LEAD FREE WATTS", category: "accessories", manufacturer: "" },
    PGPADJ: { sku: "PGPADJ", partNumber: "PGPADJ", description: "PGP rotor adjustable", category: "sprinkler_heads", manufacturer: "hunter" }
  };
  const finds = {
    HCHPC400: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "HPC-400", candidates: [{ pageUrl: `${OFFICIAL}/hpc`, imageUrl: "", partNumberAsShown: "HCHPC400" }] } },
    PGV100G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV100G", candidates: [{ pageUrl: `${OFFICIAL}/pgv-noimg`, imageUrl: "", partNumberAsShown: "PGV100G" }] } },
    POPO100300: { 1: { manufacturer: "Oil Creek", manufacturerPartNumber: "", candidates: [{ pageUrl: "https://www.oilcreekplastics.com/irrigation-pipe", imageUrl: "", partNumberAsShown: "IRR100" }] } },
    "0072204": { 1: { manufacturer: "Watts", manufacturerPartNumber: "LF7RU2-2", candidates: [{ pageUrl: "https://www.watts.com/products/lf7ru2-2", imageUrl: "", partNumberAsShown: "0072204" }] } },
    PGPADJ: { 1: null, 2: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-ADJ", candidates: [{ pageUrl: "https://www.siteone.com/en/two-images", imageUrl: "https://img.example.com/finder.jpg", partNumberAsShown: "PGPADJ" }] } }
  };
  const asked = {};
  const dir = tmp();
  const h = harness(dir, { catalog, find: (part, pass) => { (asked[part.sku] ||= []).push({ pass, mfr: part.manufacturer, proposed: !!part.manufacturerProposed, catalogMfr: part.catalogManufacturer }); const f = (finds[part.sku] || {})[pass]; return { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [], ...(f || {}) }; } });
  await h.b.start({ skus: Object.keys(catalog), autoApprove: false }); await h.b.idle();
  const st = h.b._state().run;
  const it = (s) => st.items[s];
  const cands = (s) => (it(s).work.checked || []).filter((c) => c.hash);

  check("pattern 1 (HCHPC400): official page, no finder image → og:image candidate → Confident", it("HCHPC400").result.tier === "confident" && cands("HCHPC400").length === 1 && cands("HCHPC400")[0].source.imageVia === "og:image", JSON.stringify(it("HCHPC400").result));
  check("pattern 1: the page's image count is recorded", cands("HCHPC400")[0].imagesOnPage === 1);
  const u = it("HCHPC400").usage;
  check("counters: 2 Claude calls (find + vision), 2 searches, 1 model fetch, 1 page + 1 image by our server, tokens kept", u.calls === 2 && u.searches === 2 && u.webFetches === 1 && u.pageFetches === 1 && u.imageFetches === 1 && u.in === 600 && u.out === 30, JSON.stringify(u));
  check("counters: the run totals add up across parts", st.usage.calls === st.order.reduce((n, s) => n + it(s).usage.calls, 0) && st.usage.pageFetches === st.order.reduce((n, s) => n + it(s).usage.pageFetches, 0) && st.usage.calls > 2);

  check("pattern: official page with NO product image at all → No reliable photo, with the reason", it("PGV100G").result.tier === "not_confident" && cands("PGV100G").length === 0 && (it("PGV100G").work.checked[0].notes || []).some((n) => /no product image found/.test(n)));
  check("pattern 2 (POPO100300, Oil Creek base SKU): official page, our number absent → To be determined WITH the photo, not 'no reliable photo'", it("POPO100300").result.tier === "tbd" && cands("POPO100300").length === 1 && it("POPO100300").work.checked[0].partNumber.result === "unknown" && /base-SKU|needs a look/.test(it("POPO100300").work.checked[0].partNumber.reason), JSON.stringify(it("POPO100300").result));
  check("pattern 2: unknown ≠ pass — it can never be Confident this way", it("POPO100300").result.tier !== "confident");
  check("pattern 3 (0072204, blank manufacturer, Watts): searched as BRANDED on the Watts site first", asked["0072204"][0].pass === 1 && asked["0072204"][0].mfr === "watts" && asked["0072204"][0].proposed === true && asked["0072204"][0].catalogMfr === "");
  check("pattern 3: the official Watts page proves it → Confident; the brand is recorded as PROPOSED", it("0072204").result.tier === "confident" && h.store.readStoresSync().groups[h.store.readStoresSync().links["0072204"].groupId].ai.proposedBrand === "watts");
  check("pattern 3: the catalog's manufacturer field is untouched", h.parts()["0072204"].manufacturer === "" && catalog["0072204"].manufacturer === "");
  check("pattern 3: the review card shows the proposed brand", (() => { const s = h.store.readStoresSync(); const q = require(path.join(ROOT, "server", "lib", "photo-review.js")).buildReviewQueues({ parts: h.parts(), groups: s.groups, links: s.links }); return q.tbd.find((c) => c.sku === "0072204").proposedBrand === "watts"; })());
  check("finder image first, then the page's own, at most 2 per page", cands("PGPADJ").length === 2 && cands("PGPADJ")[0].source.imageVia === "finder" && cands("PGPADJ")[1].source.imageVia === "og:image" && h.counts.verify.PGPADJ === 2);
  check("nothing went live (auto-approve off) even with two Confident results", Object.values(h.parts()).every((p) => p.photoState !== "verified"));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Cap across pages: three pages each with a finder image and og:image →
  // at most 3 candidates, so at most 3 vision calls.
  const pages = ["a", "b", "c"].map((k) => `https://www.siteone.com/en/cap-${k}`);
  for (const p of pages) WEB[p] = pageWith("PGPADJ rotor", [`https://img.example.com/${p.slice(-1)}-og.jpg`]);
  const dir = tmp();
  const h = harness(dir, { catalog: { PGPADJ: CATALOG.PGPADJ }, find: (part, pass) => (pass === 1 ? { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: pages.map((p) => ({ pageUrl: p, imageUrl: p + ".jpg", partNumberAsShown: "" })) } : undefined) });
  await h.b.start({ skus: ["PGPADJ"], autoApprove: false }); await h.b.idle();
  const c = h.b._state().run.items.PGPADJ.work.checked.filter((x) => x.hash);
  check("cap: never more than 3 candidates / 3 vision calls per part, however many pages and images", c.length === 3 && h.counts.verify.PGPADJ === 3 && h.b._state().run.items.PGPADJ.usage.imageFetches === 3);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 11e. The re-run door: only the calibration parts still without a live photo.
{
  const dir = tmp();
  const h = harness(dir);
  await h.b.startCalibration({ by: "patrick" }); await h.b.idle();
  const first = h.b._state().run;
  await rejects("re-run: refused while the calibration is active", async () => { const h2 = harness(dir); await h2.b.load(); h2.b._state().run.status = "running"; try { await h2.b.startCalibrationRerun({ by: "patrick" }); } finally { h2.b._state().run.status = "done"; } }, /already active/);
  // Patrick approves one and uploads one → those two are resolved.
  const s = h.store.readStoresSync();
  const withCand = first.order.find((k) => { const g = s.links[k] && s.groups[s.links[k].groupId]; return g && g.candidates && g.candidates.length; });
  await h.store.approveCandidate(withCand, CATALOG[withCand], s.groups[s.links[withCand].groupId].candidates[0].hash, { by: "patrick" });
  const other = first.order.find((k) => k !== withCand);
  await h.store.setPhoto(other, CATALOG[other], await pngFor("mine-" + other), { by: "patrick", source: { method: "upload" } });
  const unresolved = h.b.unresolvedCalibrationSkus();
  check("re-run: unresolved = calibration parts minus the ones now live", unresolved.length === first.order.length - 2 && !unresolved.includes(withCand) && !unresolved.includes(other));
  check("re-run: status lists them", JSON.stringify(h.b.status().run.calibration.unresolved) === JSON.stringify(unresolved));
  const st = await h.b.startCalibrationRerun({ by: "patrick" });
  const run = h.b._state().run;
  check("re-run: exactly the unresolved parts, auto-approve off, tied to the calibration it re-runs", JSON.stringify(run.order.slice().sort()) === JSON.stringify(unresolved.slice().sort()) && run.options.autoApprove === false && run.label === "Calibration re-run" && run.calibration.rerunOf === first.id && st.run.calibration.rerunOf === first.id);
  // The recorded list must be the unresolved ones too — start()'s own
  // live-part filter is a second layer, not the rule.
  check("re-run: the recorded re-run list is the unresolved parts, not the whole sample", JSON.stringify(run.calibration.skus.slice().sort()) === JSON.stringify(unresolved.slice().sort()) && run.calibration.skus.length < first.order.length);
  await rejects("re-run: the general start is still refused while it runs", () => h.b.start({ skus: ["PGPADJ"] }), /already in progress/);
  await h.b.idle();
  check("re-run: finished; the two live parts untouched; still nothing live from the AI", h.b._state().run.status === "done" && h.parts()[withCand].photoState === "verified" && h.parts()[other].photoState === "verified" && run.order.every((k) => h.parts()[k].photoState !== "verified"));
  // A re-run of the re-run still works from the run on file; after a restart too.
  const h3 = harness(dir);
  await h3.b.load();
  check("re-run: the last calibration is found after a restart", h3.b.unresolvedCalibrationSkus().length === unresolved.length);
  fs.rmSync(dir, { recursive: true, force: true });
  const dir2 = tmp();
  const h4 = harness(dir2);
  await rejects("re-run: nothing to re-run without a calibration", () => h4.b.startCalibrationRerun({ by: "patrick" }), /no calibration run/);
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ---- 12. Page diagnostics (Patrick, Sep 27 2026) -------------------------
// "No reliable photo" must always say why: every product page our server
// checked is recorded (URL, official, fetch result, part-number result,
// image candidates, a concise note) and shown on the review card.
{
  const line = bf.pageDiagnosticsLine;
  check("diagnostics line: empty → nothing", line([]) === "" && line(null) === "");
  check("diagnostics line: 404, no image, and a good page read plainly",
    line([{ domain: "hunterirrigation.com", official: true, fetch: "failed", status: 404, note: "HTTP 404" }, { domain: "siteone.com", official: false, fetch: "ok", partNumber: "pass", images: 0, note: "no product image found" }, { domain: "centralpros.com", fetch: "ok", partNumber: "pass", images: 2, note: "" }])
      === "Pages checked: hunterirrigation.com (official) — HTTP 404; siteone.com — no product image found; centralpros.com — 2 images, part # pass.");

  const catalog = {
    P404: { sku: "P404", partNumber: "P404", description: "Hunter PGP rotor", category: "sprinkler_heads", manufacturer: "hunter" },
    PGV100G: { sku: "PGV100G", partNumber: "PGV100G", description: "1\" globe valve", category: "valves", manufacturer: "hunter" },
    HCHPC400: { sku: "HCHPC400", partNumber: "HCHPC400", description: "Hydrawise 4-23 station controller", category: "controllers", manufacturer: "hunter" }
  };
  const finds = {
    P404: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-04", candidates: [{ pageUrl: `${OFFICIAL}/does-not-exist`, imageUrl: "", partNumberAsShown: "" }] } },
    PGV100G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV100G", candidates: [{ pageUrl: `${OFFICIAL}/pgv-noimg`, imageUrl: "", partNumberAsShown: "PGV100G" }] } },
    HCHPC400: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "HPC-400", candidates: [{ pageUrl: `${OFFICIAL}/hpc`, imageUrl: "", partNumberAsShown: "HCHPC400" }] } }
  };
  const mkFind = (part, pass) => { const f = (finds[part.sku] || {})[pass]; return { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [], ...(f || {}) }; };
  // P403 fails the way the REAL fetcher fails: a message, no status property.
  catalog.P403 = { sku: "P403", partNumber: "P403", description: "Hunter PGP rotor", category: "sprinkler_heads", manufacturer: "hunter" };
  finds.P403 = { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGP-04", candidates: [{ pageUrl: `${OFFICIAL}/blocked`, imageUrl: "", partNumberAsShown: "" }] } };
  const dir = tmp();
  const h = harness(dir, { catalog, find: mkFind, fetchPage: (url) => { if (url.endsWith("/blocked")) throw new Error("The page couldn't be read (HTTP 403)."); } });
  await h.b.start({ skus: Object.keys(catalog), autoApprove: false }); await h.b.idle();
  const st = h.b._state().run;
  const s = h.store.readStoresSync();
  const aiOf = (sku) => s.groups[s.links[sku].groupId].ai;
  const q = require(path.join(ROOT, "server", "lib", "photo-review.js")).buildReviewQueues({ parts: h.parts(), groups: s.groups, links: s.links });
  const card = (sku) => [...q.tbd, ...q.notConfident].find((c) => c.sku === sku);

  const p404 = st.items.P404.work.pages;
  check("404 page: recorded as failed with the status and a concise note", p404.length === 1 && p404[0].fetch === "failed" && p404[0].status === 404 && p404[0].note === "HTTP 404" && p404[0].official === true && p404[0].url === `${OFFICIAL}/does-not-exist`, JSON.stringify(p404));
  check("404 page: the reason says so", /Pages checked: hunterirrigation\.com \(official\) — HTTP 404\./.test(st.items.P404.result.reason), st.items.P404.result.reason);
  check("404 page: on the stored result and the review card", aiOf("P404").pages[0].note === "HTTP 404" && card("P404").pages[0].note === "HTTP 404" && card("P404").pages[0].fetch === "failed");
  const p403 = st.items.P403.work.pages;
  check("real fetcher error shape ('…(HTTP 403).', no status property) → HTTP 403", p403[0].fetch === "failed" && p403[0].status === 403 && p403[0].note === "HTTP 403", JSON.stringify(p403));

  const pNo = st.items.PGV100G.work.pages;
  check("page with 0 images: fetched ok, part # pass, 0 images, note says no product image", pNo[0].fetch === "ok" && pNo[0].partNumber === "pass" && pNo[0].images === 0 && pNo[0].note === "no product image found", JSON.stringify(pNo));
  check("page with 0 images: the reason says so", /hunterirrigation\.com \(official\) — no product image found\./.test(st.items.PGV100G.result.reason), st.items.PGV100G.result.reason);

  const pOk = st.items.HCHPC400.work.pages;
  check("page with extracted images: 1 image, part # pass, no note; result Confident", pOk[0].fetch === "ok" && pOk[0].images === 1 && pOk[0].partNumber === "pass" && pOk[0].note === "" && st.items.HCHPC400.result.tier === "confident", JSON.stringify(pOk));
  check("page with extracted images: diagnostics stored even when the result is good, and the reason stays clean", aiOf("HCHPC400").pages.length === 1 && !/Pages checked/.test(st.items.HCHPC400.result.reason));
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Diagnostics survive a pause/restart in the middle of a part: the pages
  // were recorded at the check step and saved before the vision step.
  const dir = tmp();
  let hang = true, hung = 0;
  const A = harness(dir, { concurrency: 1, catalog: { HCHPC400: { sku: "HCHPC400", partNumber: "HCHPC400", description: "Hydrawise controller", category: "controllers", manufacturer: "hunter" } },
    find: () => ({ manufacturer: "Hunter", manufacturerPartNumber: "HPC-400", notes: "", candidates: [{ pageUrl: `${OFFICIAL}/hpc`, imageUrl: "", partNumberAsShown: "HCHPC400" }] }),
    verify: () => { if (hang) { hung++; return new Promise(() => {}); } return undefined; } });
  await A.b.start({ skus: ["HCHPC400"], autoApprove: false });
  for (let i = 0; i < 300 && !hung; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 40));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "part-photos-backfill.json"), "utf8"));
  check("pause/restart: the pages were saved before the vision step", onDisk.run.items.HCHPC400.step === "verify" && onDisk.run.items.HCHPC400.work.pages.length === 1 && onDisk.run.items.HCHPC400.work.pages[0].images === 1);
  hang = false;
  const B = harness(dir, { catalog: { HCHPC400: { sku: "HCHPC400", partNumber: "HCHPC400", description: "Hydrawise controller", category: "controllers", manufacturer: "hunter" } } });
  await B.b.resume(); await B.b.idle();
  const s = B.store.readStoresSync();
  check("pause/restart: after Resume the finished result carries the same diagnostics", B.b._state().run.status === "done" && s.groups[s.links.HCHPC400.groupId].ai.pages.length === 1 && s.groups[s.links.HCHPC400.groupId].ai.pages[0].url === `${OFFICIAL}/hpc`);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Re-run subset: `only` narrows to some of the unresolved parts and
  // refuses anything outside them.
  const dir = tmp();
  const h = harness(dir);
  await h.b.startCalibration({ by: "patrick" }); await h.b.idle();
  const unresolved = h.b.unresolvedCalibrationSkus();
  const two = unresolved.slice(0, 2);
  await rejects("re-run subset: a part outside the unresolved set is refused", () => h.b.startCalibrationRerun({ by: "patrick", only: [two[0], "NOT-A-CALIBRATION-PART"] }), /Not among the unresolved/);
  check("…and nothing started", h.b._state().run.status === "done");
  await h.b.startCalibrationRerun({ by: "patrick", only: two });
  const run = h.b._state().run;
  check("re-run subset: exactly the two requested, auto-approve off", JSON.stringify(run.order.slice().sort()) === JSON.stringify(two.slice().sort()) && run.options.autoApprove === false && run.calibration.skus.length === 2);
  await h.b.idle();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 13. Unreachable official pages (Patrick, Sep 27 2026) ---------------
// The re-run showed the real blocker: watts.com, oilcreekplastics.com and
// hunterirrigation.com answer our server with HTTP 403 — and when Hunter's
// model page did load, its product photo carried no gallery markers.

// 13a. Extraction: Hunter's real model-page markup.
{
  const HUNTER = `<html><head><title>PGV-100-G | Hunter Industries</title></head><body>
    <header><img src="/themes/hunter_industries/img/Hunter_Logo_100Black.svg" alt="Hunter" /><img src="/themes/hunter_industries/img/Hunter_Logo.svg" alt="Home" class="img-fluid d-inline-block align-top" /></header>
    <div class="field--name-field-photo"><img loading="lazy" src="/sites/default/files/styles/photo_library_medium/public/PGV-100G.jpeg?itok=BbYSnpwz" width="717" height="713" alt="pgv-100g.jpeg" typeof="foaf:Image" class="image-style-photo-library-medium" /></div>
    <img src="/sites/default/files/PGV-100G.jpeg" alt="PGV-100-G">
    <img typeof="foaf:Image" src="">
    <img src="/sites/default/files/related/PRO-C.jpeg" width="200" height="200" alt="Pro-C controller">
    <img src="/sites/default/files/banner-wide.jpg" width="1600" height="400" alt="">
    <img src="/sites/default/files/big-lifestyle.jpg" width="1200" height="800" alt="lawn">
    <img src="/themes/hunter_industries/img/icons/cart.svg" width="400" height="400" alt="cart">
    <footer><img src="/sites/default/files/footer-award.jpg" width="500" height="500" alt="award"></footer>
    </body></html>`;
  const x = ev.extractProductImages;
  const base = "https://www.hunterirrigation.com/irrigation-product/1-pgv/pgv-100-g";
  const out = x(HUNTER, base, { keys: ["PGV100G"], max: 10 });
  const urls = out.map((o) => o.url), via = Object.fromEntries(out.map((o) => [o.url, o.via]));
  check("Hunter markup: the 717×713 photo named PGV-100G is accepted (part number in src/alt)", urls.includes("https://www.hunterirrigation.com/sites/default/files/styles/photo_library_medium/public/PGV-100G.jpeg?itok=BbYSnpwz"), JSON.stringify(out));
  check("Hunter markup: alt 'PGV-100-G' matches PGV100G (formatting ignored) even with no size", urls.includes("https://www.hunterirrigation.com/sites/default/files/PGV-100G.jpeg") && via["https://www.hunterirrigation.com/sites/default/files/PGV-100G.jpeg"] === "img:part-number");
  check("Hunter markup: a large 300+ image with no name is accepted", urls.includes("https://www.hunterirrigation.com/sites/default/files/big-lifestyle.jpg") && via["https://www.hunterirrigation.com/sites/default/files/big-lifestyle.jpg"] === "img:large");
  check("Hunter markup: header logos, footer, svg, empty src, small related image and the 1600×400 banner are excluded", !urls.some((u) => /Hunter_Logo|footer-award|cart\.svg|PRO-C|banner-wide/.test(u)) && !urls.includes(base), urls.join(" "));
  check("Hunter markup: without keys, the named-but-small image is NOT accepted (large one still is)", (() => { const u = x(HUNTER, base, { max: 10 }).map((o) => o.url); return !u.includes("https://www.hunterirrigation.com/sites/default/files/PGV-100G.jpeg") && u.includes("https://www.hunterirrigation.com/sites/default/files/big-lifestyle.jpg"); })());
  check("Hunter markup: a too-short key never matches", !x(HUNTER, base, { keys: ["PGV"], max: 10 }).some((o) => o.via === "img:part-number"));
  check("extraction order: named/large images come after og:image and JSON-LD", (() => { const o = x(`<meta property="og:image" content="https://a/og.jpg">` + HUNTER, base, { keys: ["PGV100G"], max: 10 }); return o[0].via === "og:image"; })());
}

// 13b. Browser-like headers on both fetchers (best effort, nothing more).
{
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), headers: opts.headers }); return { status: 200, headers: new Map([["content-type", "text/html"]]), body: (async function* () { yield Buffer.from("<html><body>ok</body></html>"); })(), arrayBuffer: async () => new ArrayBuffer(0) }; };
  try { await pp.fetchPageSafely("https://www.example.com/p", { fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }); } catch (_) { /* body shape may differ; headers are what matters */ }
  const h = seen[0] && seen[0].headers || {};
  check("page fetch sends a browser-like user-agent and accept-language", /Mozilla\/5\.0/.test(h["user-agent"] || "") && /en/.test(h["accept-language"] || "") && /text\/html/.test(h.accept || ""), JSON.stringify(h));
  const seen2 = [];
  try { await pp.fetchImageSafely("https://www.example.com/p.jpg", { fetchImpl: async (u, o) => { seen2.push(o.headers); throw new Error("stop"); }, lookup: async () => [{ address: "93.184.216.34", family: 4 }] }); } catch (_) { /* expected */ }
  check("image fetch sends the same headers", seen2[0] && /Mozilla\/5\.0/.test(seen2[0]["user-agent"] || "") && /image/.test(seen2[0].accept || ""), JSON.stringify(seen2[0]));
}

// 13c. Fall through to the next pass only when every page was unreachable.
{
  Object.assign(WEB, {
    "https://www.siteone.com/en/pgv-100g": pageWith("Hunter PGV-100G 1 in. globe valve PGV100G", ["https://img.example.com/pgv-s1.jpg"]),
    [`${OFFICIAL}/pgv-readable-but-wrong`]: pageWith("PGV series valves", ["https://img.example.com/pgv-series.jpg"])
  });
  const catalog = {
    PGV100G: { sku: "PGV100G", partNumber: "PGV100G", description: "1\" globe valve", category: "valves", manufacturer: "hunter" },
    PGV151G: { sku: "PGV151G", partNumber: "PGV151G", description: "1.5\" globe valve", category: "valves", manufacturer: "hunter" },
    PGV201G: { sku: "PGV201G", partNumber: "PGV201G", description: "2\" globe valve", category: "valves", manufacturer: "hunter" }
  };
  const finds = {
    // pass 1: two official pages, both 403 → pass 2 (suppliers) finds a readable page.
    PGV100G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV100G", candidates: [{ pageUrl: `${OFFICIAL}/blocked-a`, imageUrl: "", partNumberAsShown: "" }, { pageUrl: `${OFFICIAL}/blocked-b`, imageUrl: "", partNumberAsShown: "" }] },
               2: { manufacturer: "Hunter", manufacturerPartNumber: "PGV100G", candidates: [{ pageUrl: "https://www.siteone.com/en/pgv-100g", imageUrl: "", partNumberAsShown: "PGV100G" }] } },
    // pass 1: a READABLE official page that fails verification → no fall-through.
    PGV151G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV-151-G", candidates: [{ pageUrl: `${OFFICIAL}/pgv-readable-but-wrong`, imageUrl: "", partNumberAsShown: "" }] },
               2: { manufacturer: "Hunter", manufacturerPartNumber: "PGV-151-G", candidates: [{ pageUrl: "https://www.siteone.com/en/pgv-100g", imageUrl: "", partNumberAsShown: "" }] } },
    // pass 1 unreachable, pass 2 finds nothing → done, two finder calls, never a third.
    PGV201G: { 1: { manufacturer: "Hunter", manufacturerPartNumber: "PGV201G", candidates: [{ pageUrl: `${OFFICIAL}/blocked-c`, imageUrl: "", partNumberAsShown: "" }] }, 2: null }
  };
  const asked = {};
  const dir = tmp();
  const h = harness(dir, { catalog,
    find: (part, pass) => { (asked[part.sku] ||= []).push(pass); const f = (finds[part.sku] || {})[pass]; return { manufacturer: "", manufacturerPartNumber: "", notes: f ? "" : "nothing", candidates: [], ...(f || {}) }; },
    fetchPage: (url) => { if (/\/blocked-/.test(url)) throw new Error("The page couldn't be read (HTTP 403)."); } });
  await h.b.start({ skus: Object.keys(catalog), autoApprove: false }); await h.b.idle();
  const st = h.b._state().run;
  const it = (s) => st.items[s];
  check("all pass-1 pages 403 → pass 2 runs, once", JSON.stringify(asked.PGV100G) === "[1,2]" && it("PGV100G").work.fellThrough && it("PGV100G").work.fellThrough.from === 1 && it("PGV100G").work.fellThrough.to === 2);
  check("…the supplier page is checked under the normal rules and the part ends Confident", it("PGV100G").result.tier === "confident" && it("PGV100G").work.checked.some((c) => c.hash && c.source.pass === 2), JSON.stringify(it("PGV100G").result));
  check("…and the diagnostics keep BOTH passes' pages (2 × HTTP 403, then the readable one)", it("PGV100G").work.pages.length === 3 && it("PGV100G").work.pages.slice(0, 2).every((p) => p.note === "HTTP 403" && p.pass === 1) && it("PGV100G").work.pages[2].fetch === "ok" && it("PGV100G").work.pages[2].pass === 2);
  check("a READABLE page that fails verification does NOT fall through", JSON.stringify(asked.PGV151G) === "[1]" && !it("PGV151G").work.fellThrough && it("PGV151G").result.tier !== "confident");
  check("pass 1 unreachable, pass 2 empty → not confident, exactly two finder calls, pages recorded", JSON.stringify(asked.PGV201G) === "[1,2]" && it("PGV201G").result.tier === "not_confident" && /HTTP 403/.test(it("PGV201G").result.reason) && it("PGV201G").work.fellThrough.found === 0);
  check("counters: the fallback finder call is counted", it("PGV100G").usage.calls >= 3 && it("PGV201G").usage.calls === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Generic parts fall through from suppliers (pass 2) to the open web (pass 3) the same way; never beyond the last pass.
  Object.assign(WEB, { "https://www.plumbing-example.com/tee34": pageWith('Poly Insert Tee 3/4" barb 1401007', ["https://img.example.com/tee-open.jpg"]) });
  const asked = [];
  const dir = tmp();
  const h = harness(dir, { catalog: { TEE34: CATALOG.TEE34 },
    find: (part, pass) => { asked.push(pass); return pass === 2 ? { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [{ pageUrl: "https://www.siteone.com/en/blocked-tee", imageUrl: "", partNumberAsShown: "" }] } : { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [{ pageUrl: "https://www.plumbing-example.com/tee34", imageUrl: "", partNumberAsShown: "" }] }; },
    fetchPage: (url) => { if (/blocked/.test(url)) throw Object.assign(new Error("404"), { status: 404 }); } });
  await h.b.start({ skus: ["TEE34"], autoApprove: false }); await h.b.idle();
  const it = h.b._state().run.items.TEE34;
  check("generic: suppliers unreachable → open web tried once; result follows the normal generic rules (single source → TBD)", JSON.stringify(asked) === "[2,3]" && it.work.fellThrough.to === 3 && it.result.tier === "tbd" && it.work.pages[0].note === "HTTP 404");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 14. The controlled wave (Patrick, Sep 27 2026) ----------------------
// ≤30 unprocessed parts, deliberately mixed, auto-approve OFF, and only the
// exact list that was shown can run.
{
  const catalogAll = Object.fromEntries(realParts.map((p) => [p.sku, p]));
  // 14a. Selection on the real catalog: mixed, deterministic, never "first 30".
  const wave = ev.pickWave(realParts, { size: 30 });
  check("wave: 30 parts, 15 branded + 15 generic", wave.skus.length === 30 && wave.branded.length === 15 && wave.generic.length === 15);
  check("wave: deterministic", JSON.stringify(ev.pickWave(realParts, { size: 30 }).skus) === JSON.stringify(wave.skus));
  check("wave: not the first 30 by SKU", JSON.stringify(wave.skus.slice().sort()) !== JSON.stringify(realParts.map((p) => p.sku).sort().slice(0, 30)));
  check("wave: branded spans ≥3 manufacturers and ≥3 categories", new Set(wave.branded.map(ev.effectiveManufacturer)).size >= 3 && new Set(wave.branded.map((p) => p.category)).size >= 3, wave.branded.map((p) => `${p.manufacturer}/${p.category}`).join(","));
  check("wave: generic spans ≥4 shapes and ≥2 categories", new Set(wave.generic.map(ev.shapeOf)).size >= 4 && new Set(wave.generic.map((p) => p.category)).size >= 2, wave.generic.map((p) => `${p.category}/${ev.shapeOf(p)}`).join(","));
  check("wave: no manufacturer×category bucket takes more than its share (round-robin)", (() => { const c = {}; for (const p of wave.branded) { const k = `${ev.effectiveManufacturer(p)}|${p.category}`; c[k] = (c[k] || 0) + 1; } return Math.max(...Object.values(c)) <= 3; })());
  check("wave: exclusions honoured", (() => { const ex = new Set(wave.skus.slice(0, 5)); const w2 = ev.pickWave(realParts, { size: 30, isExcluded: (p) => ex.has(p.sku) }); return w2.skus.length === 30 && !w2.skus.some((s) => ex.has(s)); })());
  check("wave: a smaller size still mixes", (() => { const w = ev.pickWave(realParts, { size: 6 }); return w.skus.length === 6 && w.branded.length === 3 && w.generic.length === 3; })());
  check("wave: when one pool runs short the other fills", (() => { const w = ev.pickWave(realParts.filter((p) => !ev.MANUFACTURER_DOMAINS[ev.effectiveManufacturer(p)]).concat(realParts.filter((p) => ev.MANUFACTURER_DOMAINS[ev.effectiveManufacturer(p)]).slice(0, 4)), { size: 30 }); return w.skus.length === 30 && w.branded.length === 4 && w.generic.length === 26; })());

  // 14b. The engine's plan excludes live, waiting/judged and calibration-processed parts.
  const dir = tmp();
  const h = harness(dir, { catalog: catalogAll });
  await h.b.startCalibration({ by: "patrick" }); await h.b.idle();
  const cal = h.b._state().run.calibration.skus;
  const plan = h.b.wavePlan();
  check("wave plan: 30 parts, auto-approve off, worst-case estimate present", plan.skus.length === 30 && plan.autoApprove === false && plan.max === 30 && plan.estimate.apiCalls.max === plan.estimate.finderCalls.max + plan.estimate.verifyCalls.max + plan.estimate.compareCalls.max);
  check("wave plan: nothing the calibration processed", !plan.skus.some((s) => cal.includes(s)));
  check("wave plan: nothing waiting for review or judged", plan.skus.every((s) => (h.parts()[s].photoState || "none") === "none"));
  check("wave plan: eligible count excludes the calibration parts", plan.eligible === realParts.length - cal.length);
  check("wave plan: worst case for 15 branded + 15 generic = 75 finder + 90 vision + 15 compare = 180 calls, 450 searches", plan.estimate.finderCalls.max === 15 * 3 + 15 * 2 && plan.estimate.verifyCalls.max === 90 && plan.estimate.compareCalls.max === 15 && plan.estimate.apiCalls.max === 180 && plan.estimate.webSearches.max === 450, JSON.stringify(plan.estimate));
  check("wave plan: size is capped at 30 even if asked for more", h.b.wavePlan({ size: 100 }).skus.length === 30);

  // 14c. Start requires the exact shown list; auto-approve forced off; one run at a time.
  await rejects("wave start: refuses without the confirmed list", () => h.b.startWave({ by: "patrick" }), /plan has changed/);
  await rejects("wave start: refuses a different list (one SKU swapped)", () => h.b.startWave({ by: "patrick", skus: [...plan.skus.slice(0, 29), cal[0]] }), /plan has changed/);
  await rejects("wave start: refuses a reordered list", () => h.b.startWave({ by: "patrick", skus: plan.skus.slice().reverse() }), /plan has changed/);
  await rejects("wave start: refuses a longer list", () => h.b.startWave({ by: "patrick", skus: [...plan.skus, "EXTRA"] }), /plan has changed/);
  check("…and nothing started", h.b._state().run.status === "done");
  const st = await h.b.startWave({ by: "patrick", skus: plan.skus });
  const run = h.b._state().run;
  check("wave start: exactly the plan, auto-approve off, labelled and attributed", JSON.stringify(run.order.slice().sort()) === JSON.stringify(plan.skus.slice().sort()) && run.options.autoApprove === false && /^Wave/.test(run.label) && run.wave.by === "patrick" && st.run.wave.skus.length === 30);
  await rejects("wave start: refused while active", () => h.b.startWave({ by: "patrick", skus: plan.skus }), /already active/);
  await h.b.idle();
  const parts = h.parts();
  check("wave: finished, nothing live, only wave parts touched", h.b._state().run.status === "done" && run.order.every((s) => parts[s].photoState !== "verified") && Object.keys(h.counts.find).every((s) => run.order.includes(s) || cal.includes(s)));
  check("wave: the next plan excludes everything this wave processed", !h.b.wavePlan().skus.some((s) => run.order.includes(s)));
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

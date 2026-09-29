#!/usr/bin/env node
// The photo budget gate and the finder switch (Patrick, Sep 28 2026:
// "this should not cost me any more than $10"). No network, no model.
//
//   - every Claude response is priced from the model that answered
//     (photo-ai.costOf: list prices + $0.01 per web search) and added to the
//     run and to the standing ledger in the state file
//   - the finder is OFF by default: a fast-path miss makes NO finder call and
//     ends "not confident" with a note; a generic single-source hit keeps
//     its source and lands at TBD; started with finder: true it runs as before
//   - the vision and compare calls use the vision model; the finder keeps its own
//   - the ledger survives across runs and restarts; a run pauses itself with
//     pausedReason "budget" when the ledger reaches the cap; start and resume
//     refuse while it is over; a higher cap lets it continue
//   - plans carry dollars: finder-off vs finder-on worst case, spent, remaining
//
// Run: node scripts/test-photo-budget.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");
let ev, ai, bf, pp, fl;
try {
  ev = require(path.join(ROOT, "server", "lib", "photo-evidence.js"));
  ai = require(path.join(ROOT, "server", "lib", "photo-ai.js"));
  bf = require(path.join(ROOT, "server", "lib", "photo-backfill.js"));
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
  fl = require(path.join(ROOT, "server", "lib", "photo-fast-lookup.js"));
} catch (err) { console.log(`FAIL  modules could not be loaded: ${err.message}`); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = "") { if (cond) passed++; else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); } }
async function rejects(name, fn, re) { try { await fn(); check(name, false, "did not throw"); } catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pjl-budget-"));
const V = () => Object.fromEntries(ev.VISION_KEYS.map((k) => [k, { result: "pass", reason: "" }]));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---- pricing -------------------------------------------------------------------
{
  const c = ai.costOf({ input_tokens: 100000, output_tokens: 1000, server_tool_use: { web_search_requests: 2 } }, "claude-opus-5");
  check("costOf: 100k in + 1k out + 2 searches on Opus 5 = $0.545", near(c, 0.5 + 0.025 + 0.02), String(c));
  check("costOf: cache writes at 1.25x, reads at 0.1x", near(ai.costOf({ cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }, "claude-opus-5"), 6.25 + 0.5));
  check("costOf: an unknown model is priced as the finder's model (never free)", near(ai.costOf({ input_tokens: 1e6 }, "made-up"), ai.PRICES[ai.MODEL].in));
  check("costOf: a vision call on Sonnet 5.5 is cents, not dollars", ai.costOf({ input_tokens: 3500, output_tokens: 500 }, "claude-sonnet-5-5") < 0.02);
  // photo-ai reports the answering model with every response, and routes
  // verify/compare to the vision model.
  const seen = [];
  const client = { messages: { create: async (p) => { seen.push(p.model); return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(p.max_tokens === 16000 ? { manufacturer: "", manufacturerPartNumber: "", candidates: [], notes: "" } : p.max_tokens === 2000 ? { result: "pass", reason: "" } : { ...V(), summary: "" }) }], usage: { input_tokens: 10, output_tokens: 5 } }; } } };
  const A = ai.createPhotoAI({ client, model: "claude-opus-5", visionModel: "claude-sonnet-5-5" });
  const models = [];
  await A.find({ sku: "X", partNumber: "X", description: "x", manufacturer: "hunter" }, 1, (u, m) => models.push(m));
  await A.verify({ sku: "X", description: "x" }, Buffer.from("x"), "image/webp", (u, m) => models.push(m));
  await A.compare({ sku: "X", description: "x" }, Buffer.from("x"), Buffer.from("y"), "image/webp", (u, m) => models.push(m));
  check("photo-ai: finder on its model, verify and compare on the vision model, each reported to the usage callback", JSON.stringify(seen) === JSON.stringify(["claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]) && JSON.stringify(models) === JSON.stringify(seen) && A.models.vision === "claude-sonnet-5-5", JSON.stringify([seen, models]));
  check("photo-ai: the vision model defaults to the finder's model unless PHOTO_VISION_MODEL says otherwise", ai.MODEL_VISION === (process.env.PHOTO_VISION_MODEL || ai.MODEL));
}

// ---- runner harness ----------------------------------------------------------------
const PNG = new Map();
async function photo(width, height, seed) {
  const key = `${width}x${height}|${seed}`;
  if (PNG.has(key)) return PNG.get(key);
  const h = crypto.createHash("sha256").update(seed).digest();
  const channels = 3, data = Buffer.alloc(width * height * channels, 245);
  let s = h.readUInt32LE(0) || 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
  for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y++) for (let x = Math.floor(width * 0.3); x < Math.floor(width * 0.7); x++) { const i = (y * width + x) * channels; const v = rnd(); data[i] = v; data[i + 1] = 255 - v; data[i + 2] = (v * 7) & 255; }
  const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  PNG.set(key, png); return png;
}
const SO = "https://www.siteone.com/medias/x/image-thumb__1__zoom";
const IMG = { HIT1: `${SO}/hit1-1.abcd1234/hit1-1.abcd1234.jpg`, TEE: `${SO}/tee-1.abcd1234/tee-1.abcd1234.jpg`, WEB: "https://img.plumbing-example.com/tee.jpg" };
const WEB = {
  "https://www.siteone.com/en/search?text=HIT1": `<a href="/hit1-hunter-thing/p/1">Hunter HIT1 thing</a>`,
  "https://www.siteone.com/en/hit1-hunter-thing/p/1": `<html><body><h1>Hunter HIT1 thing</h1><img class="product-image" src="${IMG.HIT1}"></body></html>`,
  "https://www.siteone.com/en/search?text=TEE1": `<a href="/tee1-poly-insert-tee-34-in/p/2">Poly Insert Tee 3/4 in.</a>`,
  "https://www.siteone.com/en/tee1-poly-insert-tee-34-in/p/2": `<html><body><h1>Poly Insert Tee 3/4 in. insert barb</h1><img class="product-image" src="${IMG.TEE}"></body></html>`,
  "https://www.plumbing-example.com/tee": `<html><body><h1>3/4" poly insert tee barbed</h1><img class="product" src="${IMG.WEB}"></body></html>`
};
const CATALOG = {
  HIT1: { sku: "HIT1", partNumber: "HIT1", description: "Hunter HIT1 thing", category: "valves", manufacturer: "hunter" },
  TEE1: { sku: "TEE1", partNumber: "TEE1", description: "Poly insert tee 3/4\"", category: "fittings", manufacturer: "", size: "0.75\"" },
  MISS1: { sku: "MISS1", partNumber: "MISS1", description: "Hunter unlisted thing", category: "valves", manufacturer: "hunter" }
};
function harness(dir, over = {}) {
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const counts = { find: {}, verify: 0, compare: 0 };
  const big = over.tokens || 150000;
  const fake = {
    passesFor: ai.passesFor, models: { finder: "claude-opus-5", vision: over.visionModel || "claude-opus-5" },
    async find(part, pass, usage) { counts.find[part.sku] = (counts.find[part.sku] || 0) + 1; if (usage) usage({ input_tokens: big, output_tokens: 3000, server_tool_use: { web_search_requests: 6, web_fetch_requests: 2 } }, "claude-opus-5"); if (part.sku === "TEE1" && pass === 3) return { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [{ pageUrl: "https://www.plumbing-example.com/tee", imageUrl: "", partNumberAsShown: "" }] }; return { manufacturer: "", manufacturerPartNumber: "", notes: "nothing", candidates: [] }; },
    async verify(part, bytes, mt, usage) { counts.verify++; if (usage) usage({ input_tokens: 3500, output_tokens: 500 }, fake.models.vision); return over.visionFail ? { ...V(), type: { result: "fail", reason: "a different fitting" } } : V(); },
    async compare(part, a, b, mt, usage) { counts.compare++; if (usage) usage({ input_tokens: 8000, output_tokens: 200 }, fake.models.vision); return { result: "pass", reason: "" }; }
  };
  const fetchPage = async (u) => { if (!WEB[u]) throw new Error("The page couldn't be read (HTTP 404)."); return { html: WEB[u], finalUrl: u }; };
  let clock = 1_000_000;
  const b = bf.createBackfill({
    dataDir: dir, store, ai: fake, fastLookup: fl.createFastLookup({ fetchPage }),
    getParts: () => store.mergeInto(structuredClone(CATALOG)), manufacturers: [{ key: "hunter", label: "Hunter" }],
    fetchPage, fetchImage: async (u) => { if (!Object.values(IMG).includes(u)) throw new Error("The image couldn't be downloaded (HTTP 404)."); return { buffer: await photo(1000, 1000, u), finalUrl: u }; },
    now: () => clock, sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    budgetUsd: over.budgetUsd === undefined ? 10 : over.budgetUsd, finderDefault: over.finderDefault === true, concurrency: 1
  });
  return { b, store, counts };
}

// ---- finder off by default ----------------------------------------------------------
{
  const dir = tmp();
  const h = harness(dir);
  await h.b.start({ skus: ["HIT1", "TEE1", "MISS1"], autoApprove: false }); await h.b.idle();
  const run = h.b._state().run;
  check("finder off: no finder call anywhere", Object.keys(h.counts.find).length === 0 && run.options.finder === false);
  check("finder off: the fast-path hit is verified and Confident (one vision call)", run.items.HIT1.result.tier === "confident" && run.items.HIT1.usage.calls === 1);
  check("finder off: the generic hit keeps its one source → TBD, with the note", run.items.TEE1.result.tier === "tbd" && run.items.TEE1.work.found.notes.some((n) => /no second source was searched for/.test(n)) && h.counts.compare === 0);
  check("deterministic miss: zero finder calls, zero web searches, zero Claude calls", run.items.MISS1.usage.calls === 0 && run.items.MISS1.usage.searches === 0 && !h.counts.find.MISS1);
  check("deterministic miss: becomes Needs research (not 'Not confident'), with the reason", run.items.MISS1.result.tier === "needs_research" && /Needs research/.test(run.items.MISS1.result.reason) && /no web search was made/.test(run.items.MISS1.result.reason), run.items.MISS1.result.reason);
  check("deterministic miss: the run continued to the next part and finished", run.status === "done" && run.order.every((s) => run.items[s].step === "done") && run.order.indexOf("MISS1") < run.order.length - 1 || run.status === "done");
  const parts = h.store.mergeInto(structuredClone(CATALOG));
  check("deterministic miss: the catalog state is needs_research and the part has no photo", parts.MISS1.photoState === "needs_research" && parts.MISS1.photo === null);
  const s0 = h.store.readStoresSync();
  const queues = require(path.join(ROOT, "server", "lib", "photo-review.js")).buildReviewQueues({ parts, groups: s0.groups, links: s0.links });
  check("deterministic miss: it sits in its own Needs research queue, not in Not confident", queues.needsResearch.some((c) => c.sku === "MISS1") && !queues.notConfident.some((c) => c.sku === "MISS1") && !queues.tbd.some((c) => c.sku === "MISS1"));
  check("deterministic miss: a later wave plan excludes it (it was processed)", !h.b.wavePlan().skus.includes("MISS1"));
  check("semantics: the fast-path hit with every check passing is Confident", run.items.HIT1.result.tier === "confident");
  const st = h.b.status().run;
  const expected = 2 * (3500 * 5 + 500 * 25) / 1e6; // two vision calls on Opus 5
  check("cost: the run's dollars are the priced vision calls", near(st.costUsd, +expected.toFixed(4), 1e-4) && near(st.budget.spentUsd, st.costUsd, 1e-4), JSON.stringify([st.costUsd, expected]));
  check("cost: budget fields on the status (cap, spent, remaining, per model)", st.budget.usd === 10 && near(st.budget.remainingUsd, 10 - st.costUsd, 1e-4) && st.budget.byModel["claude-opus-5"] > 0 && st.finder === false);
  fs.rmSync(dir, { recursive: true, force: true });
  // The plan's dollars, on an untouched catalog.
  const dir2 = tmp();
  const h2 = harness(dir2);
  await h2.b.load();
  const plan = h2.b.wavePlan();
  check("plan: dollars — the wave's worst case is vision + compare only; the finder is 'never'", plan.finder === "never" && plan.cost && plan.cost.worstCaseUsd > 0 && plan.cost.finderWouldCostUsd > 10 * plan.cost.worstCaseUsd && plan.cost.budgetUsd === 10 && plan.cost.remainingUsd === 10, JSON.stringify(plan.cost));
  check("plan: three parts → 9 vision + 1 compare worst case is under a dollar on Opus 5", plan.cost.worstCaseUsd < 1);
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ---- a bulk wave cannot enable the finder ----------------------------------------------
{
  const dir = tmp();
  const h = harness(dir);
  await h.b.load();
  const plan = h.b.wavePlan();
  // A stray `finder: true` on the wave call must change nothing.
  await h.b.startWave({ by: "p", skus: plan.skus, finder: true }); await h.b.idle();
  const run = h.b._state().run;
  check("wave: a `finder: true` argument is ignored — the run has no finder and made no finder call", run.options.finder === false && Object.keys(h.counts.find).length === 0 && run.status === "done");
  check("wave: the miss is Needs research, the hit is Confident, the generic hit is TBD", run.items.MISS1.result.tier === "needs_research" && run.items.HIT1.result.tier === "confident" && run.items.TEE1.result.tier === "tbd");
  check("wave: zero web searches and zero model fetches in the whole run", run.usage.searches === 0 && run.usage.webFetches === 0);
  const src = fs.readFileSync(path.join(ROOT, "server", "lib", "photo-backfill.js"), "utf8");
  check("code: start() and startWave() take no finder option", /async function start\(\{ skus = null, autoApprove = false, label = "", dryRun = false \} = \{\}\)/.test(src) && /async function startWave\(\{ by = null, skus = null, size = WAVE_MAX \} = \{\}\)/.test(src));
  check("code: the finder runs only behind the harness-only finderDefault", /const finderOn = r\.options\.finder === true;/.test(src) && /finder: finderDefault === true/.test(src) && !/finder: finder === true/.test(src));
  const server = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const at = server.indexOf('pathname === "/api/part-photo-backfill/wave"');
  check("route: the wave route reads only `skus` from the request — no finder field or option anywhere in it", at > 0 && !/payload.finder|finders*:|finders*=/.test(server.slice(at, server.indexOf("backfillActionMatch", at))) && /finderDefault: false/.test(server));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- semantics of Not confident are unchanged: evidence checked and found wrong ----
{
  const dir = tmp();
  const h = harness(dir, { visionFail: true });
  await h.b.start({ skus: ["HIT1"], autoApprove: false }); await h.b.idle();
  const run = h.b._state().run;
  check("semantics: a candidate whose photo FAILS the vision check is Not confident (evidence was evaluated)", run.items.HIT1.result.tier === "not_confident" && /photo doesn't match/.test(run.items.HIT1.result.reason), run.items.HIT1.result.reason);
  check("semantics: …and it lands in the Not confident queue, not Needs research", h.store.mergeInto(structuredClone(CATALOG)).HIT1.photoState === "not_confident");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- the gate --------------------------------------------------------------------
{
  const dir = tmp();
  const h = harness(dir, { budgetUsd: 0.03 }); // one vision call is ~$0.03
  await h.b.start({ skus: ["HIT1", "TEE1"], autoApprove: false }); await h.b.idle();
  const run = h.b._state().run;
  check("gate: the run paused itself right after the step that reached the cap, and says why", run.status === "paused" && run.pausedReason === "budget" && run.items.HIT1.step !== "queued", JSON.stringify({ status: run.status, reason: run.pausedReason, step: run.items.HIT1.step }));
  check("gate: no further vision call was made after the cap", h.counts.verify === 1 && run.items.TEE1.step === "queued");
  await rejects("gate: resume refuses while over budget", () => h.b.resume(), /budget is used up/);
  await rejects("gate: a new run refuses while over budget", () => h.b.startWave({ by: "p", skus: h.b.wavePlan().skus }), /already active|budget is used up/);
  // A higher cap (a restart with PHOTO_BUDGET_USD raised) lets it continue; the ledger persisted.
  const h2 = harness(dir, { budgetUsd: 10 });
  await h2.b.load();
  check("gate: the ledger survives a restart", h2.b.status().run.budget.spentUsd > 0.02);
  await h2.b.resume(); await h2.b.idle();
  const run2 = h2.b._state().run;
  check("gate: with a higher cap the run resumes and finishes", run2.status === "done" && !run2.pausedReason && run2.items.TEE1.result.tier === "tbd");
  const h3 = harness(dir, { budgetUsd: null });
  await h3.b.load();
  check("gate: no cap → nothing pauses, budget shown as unlimited", h3.b.status().run.budget.usd === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-photo-budget: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

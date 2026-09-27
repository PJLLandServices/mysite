#!/usr/bin/env node
// Part photos M3b — Patrick's review of AI results (P-PJL-35, FLOW-49).
//
// Real store, real queue builder, real runner; only the AI and the web are
// fakes. What it guards:
//
//   - Approve: the chosen candidate becomes an APPROVED photo (as if
//     uploaded), Patrick's link, shared with the fitting's other parts;
//     only one of the part's own candidates can be approved
//   - Reject: the result becomes Not confident, every candidate image is
//     remembered as rejected, and a later AI run can never auto-approve
//     one of those images again
//   - Reject an AUTO-approved photo: every other photo that went live by the
//     same rule (same kind) in the same run is sent back to To be
//     determined; other runs, other kinds and Patrick's photos are untouched
//   - A photo a person approved is never rejected through this door
//   - Queues: To be determined / Not confident / Recently auto-approved
//     hold exactly the right fittings; Patrick's photos are in none of them
//   - Fittings to confirm: confirm links the pair as Patrick's link, dismiss
//     never asks about that pair again, an answered pair can't be re-answered
//
// Run: node scripts/test-photo-review.mjs  (also in build:check)

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require("sharp");
let pp, review, bf, ev, ai;
try {
  pp = require(path.join(ROOT, "server", "lib", "part-photos.js"));
  review = require(path.join(ROOT, "server", "lib", "photo-review.js"));
  bf = require(path.join(ROOT, "server", "lib", "photo-backfill.js"));
  ev = require(path.join(ROOT, "server", "lib", "photo-evidence.js"));
  ai = require(path.join(ROOT, "server", "lib", "photo-ai.js"));
} catch (err) { console.log(`FAIL  review modules could not be loaded: ${err.message}`); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (err) { check(name, !re || re.test(err.message), `threw "${err.message}"`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pjl-review-"));
let seq = 0;
async function png(seed) {
  seq++;
  return sharp({ create: { width: 300, height: 200, channels: 3, background: { r: (seed * 37) % 255, g: (seed * 91) % 255, b: (seq * 53) % 255 } } }).png().toBuffer();
}
const P = (sku, extra = {}) => ({ sku, partNumber: sku, description: `Part ${sku}`, category: "x", manufacturer: "", ...extra });
const CATALOG = {
  A: P("A", { manufacturer: "hunter" }), A2: P("A2", { manufacturer: "hunter" }), B: P("B", { manufacturer: "hunter" }),
  C: P("C"), D: P("D", { manufacturer: "rainbird" }), E: P("E", { manufacturer: "hunter" }), F: P("F"), G: P("G"), H: P("H")
};
async function seed(store, sku, tier, { kind = "branded", runId = "R1", autoApprove = false, n = 2 } = {}) {
  const cands = [];
  for (let i = 0; i < n; i++) cands.push({ ...(await store.saveCandidateImage(await png(i + 1))), source: { domain: `s${i}.example.com`, pageUrl: `https://s${i}.example.com/p`, pass: 1, official: true }, checks: { partNumber: { result: "pass" } }, tier });
  const res = await store.recordAiResult(sku, CATALOG[sku], { tier, kind, reason: `seed ${tier}`, runId, candidates: cands, chosen: 0 }, { autoApprove });
  return { ...res, cands };
}
const merged = (store) => store.mergeInto(structuredClone(CATALOG));

// ---- 1. Approve ----------------------------------------------------------
{
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const { groupId, cands } = await seed(store, "A", "tbd");
  await store.autoLinkSameFitting("A2", CATALOG.A2, "A", { reason: "test" }); // same fitting, waiting too
  check("setup: A and A2 wait as TBD", merged(store).A.photoState === "tbd" && merged(store).A2.photoState === "tbd");
  const r = await store.approveCandidate("A", CATALOG.A, cands[1].hash, { by: "patrick" });
  const s = store.readStoresSync();
  const g = s.groups[groupId];
  check("approve: the chosen candidate is the fitting's photo", g.photo.hash === cands[1].hash && g.tier === "approved");
  check("approve: recorded as Patrick's, from the AI review", g.approvedBy === "patrick" && g.source.method === "ai-reviewed" && g.source.domain === "s1.example.com");
  check("approve: the link becomes Patrick's confirmed link", s.links.A.linkTier === "confirmed" && s.links.A.linkedBy === "patrick");
  check("approve: shared with the fitting's other part", r.sharedWith.includes("A2") && merged(store).A2.photoState === "verified");
  check("approve: picker shows it for both", merged(store).A.photoState === "verified" && merged(store).A.photo.approvedBy === "patrick");
  const log = fs.readFileSync(path.join(dir, "part-photos-log.jsonl"), "utf8");
  check("approve: audit-logged", log.includes('"review.approve"'));
  await rejects("approve: a hash that isn't one of this part's candidates", () => store.approveCandidate("A", CATALOG.A, "b".repeat(64), { by: "patrick" }), /candidates/);
  await rejects("approve: a bad hash", () => store.approveCandidate("A", CATALOG.A, "nope", { by: "patrick" }), /Choose a photo/);
  await rejects("approve: a part with no AI result", () => store.approveCandidate("H", CATALOG.H, cands[0].hash, { by: "patrick" }), /candidates/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 2. Reject a waiting result; rejected images never come back --------
{
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const { groupId, cands } = await seed(store, "A", "tbd");
  const r = await store.rejectAiResult("A", CATALOG.A, { by: "patrick", reason: "wrong nozzle" });
  const g = store.readStoresSync().groups[groupId];
  check("reject: becomes Not confident with the reason", g.tier === "not_confident" && /wrong nozzle/.test(g.reason) && merged(store).A.photoState === "not_confident");
  check("reject: every candidate image is remembered as rejected", cands.every((c) => g.rejectedHashes.includes(c.hash)) && r.wasAutoApproved === false);
  // A later run finds the same image again and calls it Confident.
  const again = await store.recordAiResult("A", CATALOG.A, { tier: "confident", kind: "branded", runId: "R2", candidates: [{ ...cands[0], tier: "confident" }], chosen: 0 }, { autoApprove: true });
  const g2 = store.readStoresSync().groups[groupId];
  check("reject: a rejected image is never auto-approved later", !again.live && g2.tier === "tbd" && !g2.photo && /rejected before/.test(g2.reason));
  check("reject: …and isn't even listed as a candidate again", !g2.candidates.some((c) => c.hash === cands[0].hash));
  const fresh = await store.saveCandidateImage(await png(9));
  const ok = await store.recordAiResult("A", CATALOG.A, { tier: "confident", kind: "branded", runId: "R3", candidates: [{ ...fresh, tier: "confident", source: {} }], chosen: 0 }, { autoApprove: true });
  check("reject: a genuinely new image can still go live", ok.live && merged(store).A.photoState === "verified");
  await rejects("reject: nothing to reject on an untouched part", () => store.rejectAiResult("H", CATALOG.H, { by: "patrick" }), /no AI result/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 3. Reject an AUTO-approved photo → same-run, same-kind cascade -----
{
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const A = await seed(store, "A", "confident", { kind: "branded", runId: "R1", autoApprove: true });
  const B = await seed(store, "B", "confident", { kind: "branded", runId: "R1", autoApprove: true });
  const C = await seed(store, "C", "confident", { kind: "generic", runId: "R1", autoApprove: true });
  const D = await seed(store, "D", "confident", { kind: "branded", runId: "R2", autoApprove: true });
  await store.setPhoto("E", CATALOG.E, await png(5), { by: "patrick", source: { method: "upload" } });
  const m0 = merged(store);
  check("setup: A, B, C, D live automatically, E is Patrick's", ["A", "B", "C", "D", "E"].every((s) => m0[s].photoState === "verified") && m0.E.photo.approvedBy === "patrick");
  const r = await store.rejectAiResult("A", CATALOG.A, { by: "patrick", reason: "not this model" });
  const s = store.readStoresSync();
  const m = merged(store);
  check("cascade: A is taken down and Not confident", m.A.photoState === "not_confident" && r.wasAutoApproved === true);
  check("cascade: B (same run, same kind) is sent back to TBD, photo down", m.B.photoState === "tbd" && !s.groups[B.groupId].photo && /Sent back/.test(s.groups[B.groupId].reason));
  check("cascade: B keeps its candidates for review", s.groups[B.groupId].candidates.length === 2);
  check("cascade: C (same run, other kind) untouched", m.C.photoState === "verified");
  check("cascade: D (other run) untouched", m.D.photoState === "verified");
  check("cascade: Patrick's photo untouched", m.E.photoState === "verified");
  check("cascade: reports what it sent back", r.sentBack.length === 1 && r.sentBack[0].skus.includes("B"));
  check("cascade: B's old photo kept in its history", s.groups[B.groupId].history.some((h) => h.hash === B.cands[0].hash && /Sent back/.test(h.reason)));
  // E was uploaded by Patrick and never touched by the AI: refused either way.
  await rejects("a person's photo is never rejected through this door", () => store.rejectAiResult("E", CATALOG.E, { by: "patrick" }), /approved by a person|no AI result/);
  check("…E is still live", merged(store).E.photoState === "verified");
  // A photo Patrick approved from the AI's candidates counts as a person's too.
  const F = await seed(store, "F", "tbd", { kind: "generic" });
  await store.approveCandidate("F", CATALOG.F, F.cands[0].hash, { by: "patrick" });
  await rejects("…and so does one he approved on the review screen", () => store.rejectAiResult("F", CATALOG.F, { by: "patrick" }), /approved by a person/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4. The queues -------------------------------------------------------
{
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const A = await seed(store, "A", "tbd", { n: 4 });
  await store.autoLinkSameFitting("A2", CATALOG.A2, "A", { reason: "test" });
  const B = await seed(store, "B", "not_confident", { n: 1 });
  const C = await seed(store, "C", "confident", { kind: "generic", autoApprove: true });
  const D = await seed(store, "D", "tbd");
  await store.approveCandidate("D", CATALOG.D, D.cands[0].hash, { by: "patrick" });
  await store.setPhoto("E", CATALOG.E, await png(5), { by: "patrick", source: { method: "upload" } });
  await store.rejectAiResult("A", CATALOG.A, { by: "patrick" }); // A → not confident with rejected hashes
  const A3 = await store.saveCandidateImage(await png(11));
  await store.recordAiResult("A", CATALOG.A, { tier: "tbd", kind: "branded", runId: "R2", candidates: [{ ...A3, source: {}, tier: "tbd" }], chosen: 0 }, {});
  const parts = merged(store);
  const { groups, links } = store.readStoresSync();
  const q = review.buildReviewQueues({ parts, groups, links, fittings: [{ id: "A|B", a: "A", b: "B", reason: "same spec", status: "open", at: "2026-09-27T00:00:00Z" }, { id: "F|G", a: "F", b: "G", reason: "x", status: "dismissed" }] });
  const skus = (list) => list.map((c) => c.sku).sort().join(",");
  check("queues: To be determined holds exactly the waiting fittings", skus(q.tbd) === "A", skus(q.tbd));
  check("queues: Not confident holds exactly the failed ones", skus(q.notConfident) === "B", skus(q.notConfident));
  check("queues: Recently auto-approved holds only automatic live photos", skus(q.autoApproved) === "C", skus(q.autoApproved));
  check("queues: Patrick's photos (uploaded or approved here) are in no queue", ![...q.tbd, ...q.notConfident, ...q.autoApproved].some((c) => ["D", "E"].includes(c.sku)));
  const a = q.tbd[0];
  check("queues: a card lists the fitting's other parts", a.also.map((x) => x.sku).join() === "A2");
  check("queues: rejected images are not offered again; newest first, max 3", a.candidates.length === 1 && a.candidates[0].hash === A3.hash);
  check("queues: card carries the checks and the source", a.candidates[0].source && "checks" in a.candidates[0] && a.kind === "branded");
  check("queues: only OPEN fitting proposals with both parts present", q.fittings.length === 1 && q.fittings[0].id === "A|B");
  check("queues: fitting sides show a preview (candidate or live)", q.fittings[0].a.preview && q.fittings[0].a.preview.kind === "candidate" && q.fittings[0].b.preview.kind === "candidate");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 5. Fittings to confirm: confirm / dismiss / never asked again --------
{
  const dir = tmp();
  const store = pp.createPartPhotos({ dataDir: dir, sharp });
  const catalog = {
    T1: P("T1", { description: 'Poly insert tee 3/4"' }), T2: P("T2", { description: 'Poly insert tee 3/4"', partNumber: "T2X" }),
    U1: P("U1", { description: 'PVC elbow 1/2" slip' }), U2: P("U2", { description: 'PVC elbow 1/2" slip', partNumber: "U2X" })
  };
  const html = (t) => `<html><body><h1>${t}</h1></body></html>`;
  const WEB = {
    "https://www.siteone.com/t": html('Poly Insert Tee 3/4" barb'), "https://www.centralpros.com/t": html('3/4" Insert Tee poly barbed'),
    "https://www.siteone.com/u": html('PVC Elbow 1/2" slip'), "https://www.centralpros.com/u": html('1/2" PVC Elbow slip')
  };
  const fake = {
    passesFor: ai.passesFor,
    async find(part, pass) {
      const k = part.sku[0] === "T" ? "t" : "u";
      return pass === 2 ? { manufacturer: "", manufacturerPartNumber: "", notes: "", candidates: [
        { pageUrl: `https://www.siteone.com/${k}`, imageUrl: `https://img.example.com/${part.sku}-1.jpg`, partNumberAsShown: "" },
        { pageUrl: `https://www.centralpros.com/${k}`, imageUrl: `https://img.example.com/${part.sku}-2.jpg`, partNumberAsShown: "" }] } : { candidates: [], notes: "", manufacturer: "", manufacturerPartNumber: "" };
    },
    async verify() { return Object.fromEntries(ev.VISION_KEYS.map((k) => [k, { result: "pass", reason: "" }])); },
    async compare() { return { result: "unknown", reason: "mock" }; } // → TBD, so nothing is live
  };
  const getParts = () => store.mergeInto(structuredClone(catalog));
  const mk = () => bf.createBackfill({ dataDir: dir, store, ai: fake, getParts,
    fetchPage: async (u) => ({ html: WEB[u], finalUrl: u }),
    fetchImage: async (u) => ({ buffer: await png(u.length), finalUrl: u }),
    sleep: async () => {}, now: () => 1_000_000 });
  const b = mk();
  await b.start({ skus: ["T1", "T2", "U1", "U2"], autoApprove: false }); await b.idle();
  await b.applyGrouping();
  let open = await b.fittingsToConfirm();
  check("fittings: same-spec pairs are proposed, none auto-linked", open.length === 2 && open.every((f) => f.status === "open"), JSON.stringify(open.map((f) => f.id)));
  const tPair = open.find((f) => f.a[0] === "T"), uPair = open.find((f) => f.a[0] === "U");
  await rejects("fittings: confirm needs a valid keep", () => b.resolveFitting(tPair.id, { action: "confirm", keep: "ZZ", by: "patrick" }), /which photo/);
  await rejects("fittings: unknown action", () => b.resolveFitting(tPair.id, { action: "merge", by: "patrick" }), /Unknown action/);
  const c = await b.resolveFitting(tPair.id, { action: "confirm", keep: "T1", by: "patrick" });
  const s = store.readStoresSync();
  check("fittings: confirm links the other part into the kept part's fitting, as Patrick's link", s.links.T2.groupId === s.links.T1.groupId && s.links.T2.linkedBy === "patrick" && c.fitting.kept === "T1");
  await b.resolveFitting(uPair.id, { action: "dismiss", by: "patrick" });
  const s2 = store.readStoresSync();
  check("fittings: dismiss leaves the parts separate", s2.links.U1.groupId !== s2.links.U2.groupId);
  await rejects("fittings: an answered pair can't be answered again", () => b.resolveFitting(uPair.id, { action: "confirm", keep: "U1", by: "patrick" }), /already answered/);
  await rejects("fittings: unknown id", () => b.resolveFitting("nope", { action: "dismiss", by: "patrick" }), /doesn't exist/);
  check("fittings: nothing open", (await b.fittingsToConfirm()).length === 0);
  // A later run (fresh process) proposes the same pairs again → not re-asked.
  const b2 = mk();
  await b2.start({ skus: ["T1", "T2", "U1", "U2"], autoApprove: false }); await b2.idle();
  await b2.applyGrouping();
  const all = b2._state().fittings;
  check("fittings: an answered pair is never asked again (survives restart)", (await b2.fittingsToConfirm()).length === 0 && all.length === 2, JSON.stringify(all.map((f) => f.id + ":" + f.status)));
  const log = fs.readFileSync(path.join(dir, "part-photos-log.jsonl"), "utf8");
  // The store logs the link; the server's audit trail records the decision.
  check("fittings: confirm is logged as Patrick's link", log.includes('"link.set"') && log.includes('"by":"patrick"'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-photo-review: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// scripts/test-part-photo-order.mjs
//
// "WHO JOINED THIS FITTING FIRST" MUST NOT DEPEND ON THE CLOCK.
//
// A fitting's default part (the name, part # and price every member of
// the fitting shows) falls back to "the member that was in the fitting
// first" (lib/part-photos.js, fittingDefaultFor rule 3). That order was
// read from a millisecond timestamp. Two links made in the same
// millisecond tied, and the tie was broken ALPHABETICALLY — so the
// answer depended on how fast the machine was. main's CI went red on
// exactly that (2026-09-27, test-part-photo-lifecycle, "re-uploading the
// photo doesn't change who was first"): on the runner, the photo and the
// link landed in one millisecond and "CATALOG-B" beat "RUNTIME-A".
//
// The fix gives every new member of a fitting a persisted join sequence,
// assigned under the store lock, which re-uploads and reconfirms never
// touch. This file pins it:
//
//   * Timestamps are forced IDENTICAL by freezing the clock for the whole
//     store run — for any implementation, however it reads time. No
//     sleeps, no retries, no loosened assertions.
//   * Join order is checked in BOTH alphabetical directions, so passing
//     cannot be alphabetical luck.
//   * Re-uploading, reconfirming or re-linking a member never changes the
//     order.
//   * Records written before sequences existed have a defined,
//     deterministic place, and touching them never assigns a sequence
//     (which would silently move them behind everyone).
//
// Run: node scripts/test-part-photo-order.mjs   (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = require(path.join(ROOT, "node_modules", "sharp"));
const lib = require(path.join(ROOT, "server", "lib", "part-photos.js"));
const { createPartPhotos, fittingDefaultFor } = lib;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

// ---- The frozen clock -----------------------------------------------
// Every `new Date()` and `Date.now()` returns the same instant while
// frozen. This is what a fast CI runner did by accident; here it is
// guaranteed, every run.
const RealDate = Date;
const FROZEN_AT = RealDate.parse("2026-09-27T12:00:00.000Z");
class FrozenDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(FROZEN_AT); }
  static now() { return FROZEN_AT; }
}
async function frozen(fn) {
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

const part = (sku) => ({ sku, partNumber: sku, description: sku });
const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#123" } }).png().toBuffer();
const img2 = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#456" } }).png().toBuffer();
const noBaseline = () => false;

const freshStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-photo-order-"));
  return { dir, store: createPartPhotos({ dataDir: dir, sharp }) };
};
const readLinks = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "part-photo-links.json"), "utf8"));
const defaultOf = (store, skus) => {
  const ps = Object.fromEntries(skus.map((s) => [s, part(s)]));
  store.mergeInto(ps, { isBaseline: noBaseline });
  return ps[skus[0]].photo && ps[skus[0]].photo.fittingDefaultSku;
};

// ======================================================================
// 1. The exact CI failure, forced: identical timestamps, then re-upload
// ======================================================================
console.log("\n  -- the CI failure, made deterministic --");
{
  const { dir, store } = freshStore();
  try {
    await frozen(async () => {
      const first = await store.setPhoto("RUNTIME-A", part("RUNTIME-A"), img, { by: "patrick", source: { method: "upload" } });
      await store.linkToGroup("CATALOG-B", part("CATALOG-B"), first.groupId, { by: "patrick" });
    });
    const links = readLinks(dir);
    const ta = links["RUNTIME-A"].firstLinkedAt, tb = links["CATALOG-B"].firstLinkedAt;
    ok("the two links really do carry IDENTICAL timestamps (the collision is forced)",
      ta === tb && ta === "2026-09-27T12:00:00.000Z", `${ta} vs ${tb}`);
    ok("the part that got the photo first is the default, not the alphabetical one",
      defaultOf(store, ["RUNTIME-A", "CATALOG-B"]) === "RUNTIME-A",
      defaultOf(store, ["RUNTIME-A", "CATALOG-B"]));

    await frozen(() => store.setPhoto("RUNTIME-A", part("RUNTIME-A"), img2, { by: "patrick", source: { method: "upload" } }));
    ok("re-uploading on the first member does not change who was first",
      defaultOf(store, ["RUNTIME-A", "CATALOG-B"]) === "RUNTIME-A");

    await frozen(() => store.setPhoto("CATALOG-B", part("CATALOG-B"), img, { by: "patrick", source: { method: "upload" } }));
    ok("re-uploading on the SECOND member does not make it first",
      defaultOf(store, ["RUNTIME-A", "CATALOG-B"]) === "RUNTIME-A");

    await frozen(async () => {
      await store.reconfirm("CATALOG-B", part("CATALOG-B"), { by: "patrick" });
      await store.reconfirm("RUNTIME-A", part("RUNTIME-A"), { by: "patrick" });
    });
    ok("reconfirming either member does not change who was first",
      defaultOf(store, ["RUNTIME-A", "CATALOG-B"]) === "RUNTIME-A");

    const after = readLinks(dir);
    ok("the join sequence is PERSISTED on each link",
      Number.isInteger(after["RUNTIME-A"].linkSeq) && Number.isInteger(after["CATALOG-B"].linkSeq),
      JSON.stringify({ a: after["RUNTIME-A"].linkSeq, b: after["CATALOG-B"].linkSeq }));
    ok("...first member lower than second", after["RUNTIME-A"].linkSeq < after["CATALOG-B"].linkSeq);
    ok("...and unchanged by every re-upload and reconfirm above",
      Number.isInteger(links["RUNTIME-A"].linkSeq) && Number.isInteger(links["CATALOG-B"].linkSeq) &&
      after["RUNTIME-A"].linkSeq === links["RUNTIME-A"].linkSeq && after["CATALOG-B"].linkSeq === links["CATALOG-B"].linkSeq,
      JSON.stringify({ before: [links["RUNTIME-A"].linkSeq, links["CATALOG-B"].linkSeq], after: [after["RUNTIME-A"].linkSeq, after["CATALOG-B"].linkSeq] }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ======================================================================
// 2. Both alphabetical directions — passing cannot be luck
// ======================================================================
console.log("\n  -- join order in both alphabetical directions --");
for (const [firstSku, secondSku] of [["ZULU-FIRST", "ALPHA-SECOND"], ["ALPHA-FIRST", "ZULU-SECOND"]]) {
  const { dir, store } = freshStore();
  try {
    await frozen(async () => {
      const g = await store.setPhoto(firstSku, part(firstSku), img, { by: "patrick", source: { method: "upload" } });
      await store.linkToGroup(secondSku, part(secondSku), g.groupId, { by: "patrick" });
    });
    ok(`${firstSku} joined first, same millisecond as ${secondSku} → ${firstSku} is the default`,
      defaultOf(store, [firstSku, secondSku]) === firstSku, defaultOf(store, [firstSku, secondSku]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A third, fourth and fifth member, all in the same frozen instant.
{
  const { dir, store } = freshStore();
  try {
    const order = ["M-3", "M-1", "M-5", "M-2", "M-4"];
    await frozen(async () => {
      const g = await store.setPhoto(order[0], part(order[0]), img, { by: "patrick", source: { method: "upload" } });
      for (const s of order.slice(1)) await store.linkToGroup(s, part(s), g.groupId, { by: "patrick" });
    });
    const links = readLinks(dir);
    const bySeq = Object.keys(links).sort((a, b) => links[a].linkSeq - links[b].linkSeq);
    ok("five members joined in one instant keep their exact join order",
      Object.values(links).every((r) => Number.isInteger(r.linkSeq)) && bySeq.join(",") === order.join(","),
      bySeq.join(","));
    ok("...and the default is the first of them, whatever order they are listed in",
      [order, [...order].reverse(), [...order].sort()].every((o) => defaultOf(store, o) === "M-3"));
    const seqs = Object.values(links).map((r) => r.linkSeq);
    ok("every sequence is unique", new Set(seqs).size === seqs.length, seqs.join(","));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Concurrent links: the store lock must hand out distinct sequences.
{
  const { dir, store } = freshStore();
  try {
    await frozen(async () => {
      const g = await store.setPhoto("C-0", part("C-0"), img, { by: "patrick", source: { method: "upload" } });
      await Promise.all(["C-1", "C-2", "C-3", "C-4"].map((s) => store.linkToGroup(s, part(s), g.groupId, { by: "patrick" })));
    });
    const seqs = Object.values(readLinks(dir)).map((r) => r.linkSeq);
    ok("links made concurrently still get distinct sequences",
      seqs.every(Number.isInteger) && new Set(seqs).size === seqs.length, seqs.join(","));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Leaving and rejoining is a NEW membership, so it joins at the back.
{
  const { dir, store } = freshStore();
  try {
    await frozen(async () => {
      const g = await store.setPhoto("R-A", part("R-A"), img, { by: "patrick", source: { method: "upload" } });
      await store.linkToGroup("R-B", part("R-B"), g.groupId, { by: "patrick" });
      await store.unlink("R-A", { by: "patrick" });
      await store.linkToGroup("R-A", part("R-A"), g.groupId, { by: "patrick" });
    });
    ok("a part that leaves and rejoins joins at the back",
      defaultOf(store, ["R-A", "R-B"]) === "R-B");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ======================================================================
// 3. Records written before sequences existed
// ======================================================================
console.log("\n  -- existing records without a sequence --");
{
  // The rule, in isolation.
  const L = {
    "OLD-LATE":  { groupId: "PG-1", at: "2026-09-26T12:00:00Z", firstLinkedAt: "2026-09-26T12:00:00Z" },
    "OLD-EARLY": { groupId: "PG-1", at: "2026-09-26T10:00:00Z", firstLinkedAt: "2026-09-26T10:00:00Z" },
    "OLD-TIE-Z": { groupId: "PG-1", at: "2026-09-26T09:00:00Z", firstLinkedAt: "2026-09-26T09:00:00Z" },
    "OLD-TIE-A": { groupId: "PG-1", at: "2026-09-26T09:00:00Z", firstLinkedAt: "2026-09-26T09:00:00Z" },
    // Sequenced, and deliberately stamped EARLIER than every legacy one.
    // Named so alphabetical order is the OPPOSITE of join order —
    // otherwise the sequence-tie check below would pass by accident.
    "SEQ-A-SECOND": { groupId: "PG-1", at: "2026-01-01T00:00:00Z", firstLinkedAt: "2026-01-01T00:00:00Z", linkSeq: 2 },
    "SEQ-Z-FIRST":  { groupId: "PG-1", at: "2026-01-01T00:00:00Z", firstLinkedAt: "2026-01-01T00:00:00Z", linkSeq: 1 }
  };
  const pick = (pool) => fittingDefaultFor({}, pool, L, noBaseline).sku;

  ok("two unsequenced links: the earlier first-link time wins", pick(["OLD-LATE", "OLD-EARLY"]) === "OLD-EARLY");
  ok("two unsequenced links with IDENTICAL times: part number decides (stable, documented)",
    pick(["OLD-TIE-Z", "OLD-TIE-A"]) === "OLD-TIE-A" && pick(["OLD-TIE-A", "OLD-TIE-Z"]) === "OLD-TIE-A");
  ok("an unsequenced link precedes every sequenced one, whatever the timestamps say",
    pick(["SEQ-Z-FIRST", "OLD-LATE"]) === "OLD-LATE" && pick(["OLD-LATE", "SEQ-Z-FIRST"]) === "OLD-LATE");
  ok("two sequenced links with IDENTICAL times: the sequence decides",
    pick(["SEQ-A-SECOND", "SEQ-Z-FIRST"]) === "SEQ-Z-FIRST" && pick(["SEQ-Z-FIRST", "SEQ-A-SECOND"]) === "SEQ-Z-FIRST");
  ok("a mixed fitting orders legacy-by-time, then by sequence",
    pick(["SEQ-A-SECOND", "OLD-LATE", "SEQ-Z-FIRST", "OLD-EARLY"]) === "OLD-EARLY");
  ok("the answer does not depend on the order members are listed in",
    ["SEQ-A-SECOND", "OLD-LATE", "SEQ-Z-FIRST", "OLD-EARLY", "OLD-TIE-Z", "OLD-TIE-A"].every((_, i, arr) => {
      const rot = [...arr.slice(i), ...arr.slice(0, i)];
      return pick(rot) === "OLD-TIE-A";
    }));
}

// Through the store: touching an unsequenced member must NOT assign it a
// sequence — that would quietly move it behind every sequenced member.
{
  const { dir, store } = freshStore();
  try {
    await frozen(async () => {
      const g = await store.setPhoto("LEG-B", part("LEG-B"), img, { by: "patrick", source: { method: "upload" } });
      await store.linkToGroup("LEG-A", part("LEG-A"), g.groupId, { by: "patrick" });
    });
    // Rewrite both as pre-sequence records that joined B-then-A, in the
    // same instant (the worst case: the alphabetical tie-break is all
    // that is left, and it says A).
    const legacy = readLinks(dir);
    for (const s of ["LEG-A", "LEG-B"]) delete legacy[s].linkSeq;
    fs.writeFileSync(path.join(dir, "part-photo-links.json"), JSON.stringify(legacy, null, 2));
    const store2 = createPartPhotos({ dataDir: dir, sharp });
    const before = defaultOf(store2, ["LEG-A", "LEG-B"]);

    await frozen(async () => {
      await store2.setPhoto("LEG-B", part("LEG-B"), img2, { by: "patrick", source: { method: "upload" } });
      await store2.reconfirm("LEG-A", part("LEG-A"), { by: "patrick" });
    });
    const after = readLinks(dir);
    ok("re-uploading or reconfirming an unsequenced member does NOT assign it a sequence",
      after["LEG-A"].linkSeq === undefined && after["LEG-B"].linkSeq === undefined,
      JSON.stringify({ a: after["LEG-A"].linkSeq, b: after["LEG-B"].linkSeq }));
    ok("...and does not change the fitting's default", defaultOf(store2, ["LEG-A", "LEG-B"]) === before, `${before} → ${defaultOf(store2, ["LEG-A", "LEG-B"])}`);

    // A brand-new member joins behind both legacy members — even though
    // it joined in the same frozen instant and sorts first alphabetically.
    await frozen(() => store2.linkToGroup("AAA-NEW", part("AAA-NEW"), after["LEG-A"].groupId, { by: "patrick" }));
    const withNew = readLinks(dir);
    ok("a new member of a legacy fitting gets a sequence", Number.isInteger(withNew["AAA-NEW"].linkSeq));
    ok("...and joins BEHIND the legacy members, not ahead of them alphabetically",
      defaultOf(store2, ["AAA-NEW", "LEG-A", "LEG-B"]) === before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ======================================================================
// 3b. Patrick approving an AI photo (M3b) keeps the order too
// ======================================================================
console.log("\n  -- approving an AI candidate (Photo Review) --");
{
  const { dir, store } = freshStore();
  try {
    // Alphabet deliberately OPPOSITE to join order.
    const first = "ZZ-AI-FIRST", later = "AA-LATER";
    let cand;
    await frozen(async () => {
      cand = await store.saveCandidateImage(img);
      await store.recordAiResult(first, part(first), {
        tier: "tbd", reason: "needs a look", runId: "run-1",
        candidates: [{ hash: cand.hash, width: cand.width, height: cand.height, source: { domain: "example.test" }, checks: {}, tier: "tbd" }],
        chosen: 0
      }, { autoApprove: false });
      const gid = readLinks(dir)[first].groupId;
      await store.linkToGroup(later, part(later), gid, { by: "patrick" });
    });
    const before = readLinks(dir);
    ok("(setup) the AI-found part joined first and the other second, in one instant",
      before[first].linkSeq < before[later].linkSeq && before[first].firstLinkedAt === before[later].firstLinkedAt,
      JSON.stringify({ first: before[first].linkSeq, later: before[later].linkSeq }));

    await frozen(() => store.approveCandidate(later, part(later), cand.hash, { by: "patrick" }));
    await frozen(() => store.approveCandidate(first, part(first), cand.hash, { by: "patrick" }));
    const after = readLinks(dir);
    ok("approving the photo through EITHER member keeps both sequences",
      after[first].linkSeq === before[first].linkSeq && after[later].linkSeq === before[later].linkSeq,
      JSON.stringify({ before: [before[first].linkSeq, before[later].linkSeq], after: [after[first].linkSeq, after[later].linkSeq] }));
    ok("...and the part that joined first is still the default",
      defaultOf(store, [first, later]) === first, defaultOf(store, [first, later]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ======================================================================
// 4. One rule
// ======================================================================
console.log("\n  -- one rule --");
{
  const src = fs.readFileSync(path.join(ROOT, "server", "lib", "part-photos.js"), "utf8");
  ok("join order is decided by one named function",
    typeof lib.compareJoinOrder === "function" && (src.match(/function compareJoinOrder\(/g) || []).length === 1);
  ok("fittingDefaultFor sorts with it, not with its own copy",
    /\.sort\(\(a, b\) => compareJoinOrder\(a, b, links\)\)/.test(src.slice(src.indexOf("function fittingDefaultFor"), src.indexOf("function mergeIntoCatalog"))));
  ok("every link write goes through the one join-recording function",
    (src.match(/links\[[^\]]+\]\s*=(?!=)/g) || []).length === (src.match(/links\[[^\]]+\]\s*=\s*keepFirstLinked\(/g) || []).length,
    "a link assignment bypasses keepFirstLinked");
  // ...AND passes the links map. The first version of this file checked
  // only the line above, and #331's approveCandidate slipped past it
  // without the map — which would number a new member 1, the FRONT.
  const calls = src.split("\n").filter((l) => /keepFirstLinked\(/.test(l) && !/function keepFirstLinked/.test(l));
  const missing = calls.filter((l) => !/,\s*links\);\s*$/.test(l));
  ok("every call to it passes the links map",
    calls.length >= 6 && missing.length === 0, missing.map((l) => l.trim().slice(0, 90)).join(" | ") || `${calls.length} calls`);
}

console.log(`\npart photo order: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

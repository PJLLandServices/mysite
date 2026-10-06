#!/usr/bin/env node
// scripts/test-merge-duplicates.mjs
//
// THE DUPLICATE-FITTINGS MIGRATION TOOL (Patrick, 2026-10-06 — Step C).
//
// lib/part-merge-duplicates.js folds each approved B into its A: the
// supplier offer, the supplier, the photo, then parts.mergeInto. This file
// proves what he asked for, on seeded stores with the real libraries:
//
//    1. a dry run writes nothing — not one byte, not one file;
//    2. drift from the approved plan is detected and refuses the apply
//       (an unapproved twin pair, a new reference to B, a QuickBooks
//       mapping on B, two live photos with no pick);
//    3. a stale fingerprint is refused, with nothing written;
//    4. the backup is taken before the first write (a failing first step
//       leaves the backup and an untouched catalog);
//    5. the backup is read back and verified (a tampered copy is refused);
//    6. pilot only: any pair but 405007 ← 405-007, or more than one pair,
//       is refused;
//    7. after the apply the retired number resolves to A everywhere;
//    8. B cannot be recreated;
//    9. a SiteOne import naming B updates A's offer instead of creating B;
//   10. A's supplier alternates survive Suppliers-page edits;
//   11. the backup restores the exact A/B state (rollback).
// Plus: the production plan constants, same-supplier repricing and the
// photo move (batch-authorized instance), and history untouched.
//
// Against the pre-change code lib/part-merge-duplicates.js does not exist
// and every section fails.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// MERGE_DUPLICATES_TEST_ROOT points the suite at another checkout (used once
// to prove it fails on the pre-change code without touching its stores).
const ROOT = process.env.MERGE_DUPLICATES_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const attempt = async (fn) => { try { return { value: await fn() }; } catch (err) { return { err }; } };
const readJson = (f, fb) => (fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) : fb);
const writeJson = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2) + "\n");

const CP = "SUP-001", SO = "SUP-002";
const A = "405007", B = "405-007";
const H1 = "a".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);
const PART = (sku, extra) => ({ sku, partNumber: sku, category: "fittings", unit: "each", supplierIds: [], ...extra });
const BASE = {
  [A]: PART(A, { subcategory: "PVC Tee", size: "0.75\"", description: "PVC tee 0.75\" FxFxF", priceCents: 410 }),
  "448005": PART("448005", { subcategory: "PVC Cap", size: "0.5\"", description: "PVC cap 0.5\" slip", priceCents: 78 }),
  "439101": PART("439101", { subcategory: "PVC Reducing Bushing", size: "0.75\"", description: "PVC reducing bushing 0.75\" x 0.5\"", priceCents: 105 }),
  "1401102": PART("1401102", { subcategory: "Poly Insert Tee", size: "1\"", description: "Poly insert tee 1\"", priceCents: 203 }),
  "408007": PART("408007", { subcategory: "PVC Elbow", size: "0.75\"", description: "PVC elbow 0.75\" 90°", priceCents: 131 })
};
const ADDED = {
  [B]: PART(B, { subcategory: "PVC Tee", size: "0.75\"", description: "Tee PVC 3/4 in. Fipt", priceCents: 276, addedAt: "2026-09-12T14:00:00.000Z" }),
  "448-005": PART("448-005", { subcategory: "PVC Cap", size: "0.5\"", description: "Cap PVC 1/2 in. Slip", priceCents: 73, addedAt: "2026-09-12T14:00:00.000Z" }),
  "439-101": PART("439-101", { subcategory: "PVC Reducing Bushing", size: "0.75\"", description: "Bushing PVC 3/4 x 1/2", priceCents: 98, addedAt: "2026-09-12T14:00:00.000Z" }),
  "1401-102": PART("1401-102", { subcategory: "Poly Insert Tee", size: "0.75\"", description: "Tee insert 1 in.", priceCents: 143, addedAt: "2026-09-12T14:00:00.000Z" })
};
const PLAN = { version: "test-plan", approved: [[A, B], ["448005", "448-005"], ["439101", "439-101"]], held: [["1401102", "1401-102"]], photoPicks: { "439101": "A" }, pilot: [[A, B]] };

// ---- harness: back up the real stores, seed ours, restore at the end -------
fs.mkdirSync(DATA, { recursive: true });
const FILES = ["parts-overrides.json", "part-suppliers.json", "part-supplier-prices.json", "part-photo-groups.json", "part-photo-links.json", "part-photos-log.jsonl", "material-lists.json", "purchase-orders.json", "quote-requests.json", "projects.json", "work-orders.json", "invoices.json", "quickbooks-items.json", "merge-duplicates-journal.json"];
const backups = Object.fromEntries(FILES.map((f) => [f, fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f)) : null]));
const preexistingBackupDirs = new Set(fs.readdirSync(DATA).filter((n) => /^BACKUP-.*-merge-duplicates$/.test(n)));
const photoDirs = [H1, H2, H3].map((h) => path.join(DATA, "part-photos", h));

function seed() {
  for (const f of FILES) if (fs.existsSync(path.join(DATA, f))) fs.rmSync(path.join(DATA, f));
  writeJson("parts-overrides.json", { added: ADDED, edited: {}, deleted: [], merged: {} });
  writeJson("part-suppliers.json", { [A]: [CP], [B]: [SO], "448005": [SO], "448-005": [SO], "439101": [CP], "439-101": [SO], "1401102": [CP], "1401-102": [SO], "408007": [CP] });
  writeJson("part-supplier-prices.json", {
    [B]: { [SO]: { priceCents: 276, source: "import", at: "2026-09-12T14:00:00.000Z" } },
    "448005": { [SO]: { priceCents: 78, source: "RFQ-2026-0002", at: "2026-06-01T12:00:00.000Z" } },
    "448-005": { [SO]: { priceCents: 73, source: "import", at: "2026-09-12T14:00:00.000Z" } },
    "439101": { [CP]: { priceCents: 105, source: "RFQ-2026-0003", at: "2026-06-01T12:00:00.000Z" }, [SO]: { priceCents: 98, supplierSku: "439-101", source: "RFQ-2026-0007", at: "2026-09-21T15:00:00.000Z" } },
    "439-101": { [SO]: { priceCents: 98, source: "import", at: "2026-09-12T14:00:00.000Z" } }
  });
  // lib/part-photos.fingerprintOf: lower-cased "partNumber|description".
  const fp = (sku) => `${sku}|${(BASE[sku] || ADDED[sku]).description}`.toLowerCase();
  writeJson("part-photo-groups.json", {
    "PG-0035": { tier: "approved", photo: { hash: H1, sizes: [160, 480, 1200] }, defaultSku: "448-005", approvedBy: "Patrick", approvedAt: "2026-09-20T00:00:00.000Z" },
    "PG-0080": { tier: "approved", photo: { hash: H2, sizes: [160, 480, 1200] }, approvedBy: "Patrick", approvedAt: "2026-09-20T00:00:00.000Z" },
    "PG-0018": { tier: "approved", photo: { hash: H3, sizes: [160, 480, 1200] }, approvedBy: "Patrick", approvedAt: "2026-09-20T00:00:00.000Z" }
  });
  writeJson("part-photo-links.json", {
    "448-005": { groupId: "PG-0035", linkTier: "confirmed", linkedBy: "Patrick", fingerprint: fp("448-005"), at: "2026-09-20T00:00:00.000Z", firstLinkedAt: "2026-09-20T00:00:00.000Z", firstLinkSeq: 1 },
    "439101": { groupId: "PG-0080", linkTier: "confirmed", linkedBy: "Patrick", fingerprint: fp("439101"), at: "2026-09-20T00:00:00.000Z", firstLinkedAt: "2026-09-20T00:00:00.000Z", firstLinkSeq: 2 },
    "439-101": { groupId: "PG-0018", linkTier: "confirmed", linkedBy: "Patrick", fingerprint: fp("439-101"), at: "2026-09-20T00:00:00.000Z", firstLinkedAt: "2026-09-20T00:00:00.000Z", firstLinkSeq: 3 }
  });
  for (const d of photoDirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "160.webp"), "not-really-webp"); }
  writeJson("material-lists.json", [{ id: "ML-HIST", name: "History", status: "active", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z",
    lines: [{ id: "l1", sku: A, qty: 4, status: "ordered", poId: "PO-HIST", frozenPriceCents: 410, notes: "" }] }]);
  writeJson("purchase-orders.json", [{ id: "PO-HIST", status: "sent", supplierId: CP, lineItems: [{ sku: A, description: "PVC tee 0.75\" FxFxF", qty: 4, unitPriceCents: 410 }] }]);
  writeJson("quickbooks-items.json", { services: {}, parts: { [A]: { qbItemId: "17", lastSyncedAt: "2026-08-01T00:00:00.000Z" } } });
}

// Everything under server/data, byte for byte — "zero writes" means this
// is identical before and after.
function snapshotDir(dir = DATA, rel = "") {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(p);
    if (st.isDirectory()) Object.assign(out, snapshotDir(p, r));
    else out[r] = { size: st.size, mtimeMs: st.mtimeMs, sha: require("node:crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex") };
  }
  return out;
}
const sameDir = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const backupDirsNow = () => fs.readdirSync(DATA).filter((n) => /^BACKUP-.*-merge-duplicates$/.test(n) && !preexistingBackupDirs.has(n));

try {
  // Load first, seed second: on the pre-change code this fails before a
  // single store is touched.
  let lib, partsLib, partAlias, partSuppliers, partPrices, partPhotosLib, partRefs, ml;
  try {
    lib = require(path.join(ROOT, "server", "lib", "part-merge-duplicates.js"));
    partRefs = require(path.join(ROOT, "server", "lib", "part-references.js"));
    partsLib = require(path.join(ROOT, "server", "lib", "parts.js"));
    partAlias = require(path.join(ROOT, "server", "lib", "part-alias.js"));
    partSuppliers = require(path.join(ROOT, "server", "lib", "part-suppliers.js"));
    partPrices = require(path.join(ROOT, "server", "lib", "part-supplier-prices.js"));
    partPhotosLib = require(path.join(ROOT, "server", "lib", "part-photos.js"));
    ml = require(path.join(ROOT, "server", "lib", "material-lists.js"));
  } catch (err) { ok("the modules load (lib/part-merge-duplicates.js and lib/part-references.js exist)", false, err.message); throw new Error("pre-change code"); }
  ok("the tool exists: create / discoverPairs and the approved-plan constants", typeof lib.create === "function" && typeof lib.discoverPairs === "function" && Array.isArray(lib.APPROVED_PAIRS));
  seed();

  console.log("0. the production plan is exactly what was approved");
  ok("45 approved pairs, every one a dash-twin, no number used twice", lib.APPROVED_PAIRS.length === 45 && lib.APPROVED_PAIRS.every(([a, b]) => lib.twinKey(a) === lib.twinKey(b) && a !== b) && new Set(lib.APPROVED_PAIRS.flat()).size === 90);
  ok("the two size-conflict pairs are held, not approved", JSON.stringify(lib.HELD_PAIRS) === JSON.stringify([["1401102", "1401-102"], ["1436211", "1436-211"]]) && !lib.APPROVED_PAIRS.some(([a]) => a === "1401102" || a === "1436211"));
  ok("photo picks: keep A for 439101, HC-075-FLOW, HC-100-FLOW; use B for 439211", JSON.stringify(lib.PHOTO_PICKS) === JSON.stringify({ "439101": "A", "439211": "B", "HC-075-FLOW": "A", "HC-100-FLOW": "A" }));
  ok("the pilot is 405007 ← 405-007 and nothing else", JSON.stringify(lib.PILOT_PAIRS) === JSON.stringify([["405007", "405-007"]]));
  ok("the backup covers every store a merge touches", ["parts-overrides.json", "part-suppliers.json", "part-supplier-prices.json", "part-photo-groups.json", "part-photo-links.json"].every((f) => lib.BACKUP_FILES.includes(f)));

  // The effective catalog, built the way server.js builds it.
  const partPhotos = partPhotosLib.createPartPhotos({ dataDir: DATA, sharp: null });
  let PARTS = {};
  const rebuild = () => {
    const ov = partsLib.hydrate ? partsLib.hydrate(readJson("parts-overrides.json", {})) : readJson("parts-overrides.json", { added: {}, edited: {}, deleted: [], merged: {} });
    const parts = partsLib.mergeOverrides(BASE, ov);
    partSuppliers.mergeIntoCatalog(parts, readJson("part-suppliers.json", {}));
    partPrices.mergeIntoCatalog(parts, readJson("part-supplier-prices.json", {}), { editedMap: ov.edited || {} });
    partPhotos.mergeInto(parts, { isBaseline: (sku) => !!BASE[sku] });
    partAlias.publish(partsLib.aliasMap(ov));
    PARTS = parts;
  };
  rebuild();
  const deps = (over = {}) => ({
    dataDir: DATA, baseline: () => BASE, catalog: () => PARTS,
    partsLib, partSuppliers, partSupplierPrices: partPrices, partPhotos, partPhotosLib, partAlias,
    references: (sku) => partRefs.findPartReferences(DATA, sku),
    quickbooksItems: async () => readJson("quickbooks-items.json", { parts: {} }),
    rebuild, plan: PLAN, ...over
  });
  const tool = lib.create(deps());
  const pairIn = (plan, a) => plan.pairs.find((p) => p.a === a);

  console.log("1. dry run: read only");
  const before = snapshotDir();
  let plan = await tool.dryRun();
  ok("1. a dry run writes nothing under server/data (no file, no byte, no mtime)", sameDir(before, snapshotDir()) && backupDirsNow().length === 0);
  ok("the plan is clean: 3 ready, 1 held, no drift, prerequisites present", plan.ok && plan.counts.ready === 3 && plan.counts.held === 1 && plan.drift.length === 0 && plan.prerequisites.stepA_supplierPreservation && plan.prerequisites.stepB_aliases && plan.prerequisites.stepB_aliasMapPublished, JSON.stringify(plan.drift));
  ok("the held pair is listed with both sizes and excluded from the apply list", plan.held[0].a === "1401102" && plan.held[0].size.a === "1\"" && plan.held[0].size.b === "0.75\"" && !plan.pairs.some((p) => p.a === "1401102"));
  ok("the fingerprint is a sha256 and the same state gives the same fingerprint", /^[0-9a-f]{64}$/.test(plan.fingerprint) && (await tool.dryRun()).fingerprint === plan.fingerprint);
  ok("the catalog counts: 9 parts now, 6 after all ready pairs", plan.catalog.parts === 9 && plan.catalog.afterAllReady === 6 && plan.catalog.twinsFound === 4);
  const pilot = pairIn(plan, A);
  ok("pilot before/after: CP 4.10 stays the price; SO 2.76 joins as an offer named 405-007; suppliers CP → CP+SO; default CP", pilot.status === "ready" && pilot.before.a.priceCents === 410 && pilot.after.a.priceCents === 410 && pilot.after.a.supplierIds.join() === `${CP},${SO}` && pilot.after.a.supplierPrices[SO].priceCents === 276 && pilot.after.a.supplierPrices[SO].supplierSku === B && pilot.after.a.supplierPrices[SO].at === "2026-09-12T14:00:00.000Z" && pilot.priceAction.kind === "record" && pilot.photoAction.kind === "none" && pilot.after.b.retired && pilot.after.b.into === A, JSON.stringify(pilot.after));
  ok("the pilot is reported on its own, and the tool says pilot-only", plan.pilot.length === 1 && plan.pilot[0].a === A && plan.pilotOnly === true && plan.pilot[0].steps.length === 4);
  const same = pairIn(plan, "448005");
  ok("same-supplier pair: B's newer SiteOne price wins (0.78 → 0.73), A joins B's fitting and becomes its default", same.priceAction.kind === "record" && same.priceChange && same.priceChange.from === 78 && same.priceChange.to === 73 && same.after.a.supplierIds.join() === SO && same.photoAction.kind === "link" && same.photoAction.groupId === "PG-0035" && same.photoAction.becomesDefault === true && same.after.a.photo.state === "verified" && same.after.a.photo.groupId === "PG-0035", JSON.stringify(same.after));
  const pick = pairIn(plan, "439101");
  ok("a newer quote already on A is kept (Sep 21 over Sep 12), and the approved photo pick keeps A's own photo", pick.priceAction.kind === "keep" && pick.after.a.supplierPrices[SO].priceCents === 98 && pick.after.a.supplierPrices[SO].at === "2026-09-21T15:00:00.000Z" && pick.photoAction.kind === "none" && /approved pick/.test(pick.photoAction.why) && pick.after.a.photo.groupId === "PG-0080");
  ok("A in QuickBooks is fine; B in QuickBooks is checked per pair", pilot.quickbooks.a === true && pilot.quickbooks.b === false);
  const fp0 = plan.fingerprint;

  console.log("2. drift");
  await partsLib.addOne(BASE, { ...PART("408-007", { subcategory: "PVC Elbow", size: "0.75\"", description: "Elbow PVC", priceCents: 120 }) }, {}); rebuild();
  let p2 = await tool.dryRun();
  ok("2a. an unapproved twin pair in the catalog is drift (and the fingerprint moves)", !p2.ok && p2.unexpected.length === 1 && p2.unexpected[0].b === "408-007" && p2.drift.some((d) => /unexpected twins 408007 \/ 408-007/.test(d)) && p2.fingerprint !== fp0);
  let r = await attempt(() => tool.apply({ fingerprint: p2.fingerprint, pairs: [[A, B]] }));
  ok("...and the apply is refused even with the matching fingerprint", r.err && r.err.code === "drift" && backupDirsNow().length === 0);
  await partsLib.softDelete(BASE, "408-007"); rebuild();
  p2 = await tool.dryRun();
  ok("removing it clears the drift", p2.ok && p2.unexpected.length === 0);
  const mlBefore = fs.readFileSync(path.join(DATA, "material-lists.json"), "utf8");
  const lists = JSON.parse(mlBefore); lists.push({ id: "ML-NEW", name: "Stale tab", status: "active", lines: [{ id: "x", sku: B, qty: 1, status: "need" }] }); writeJson("material-lists.json", lists);
  p2 = await tool.dryRun();
  ok("2b. a reference to B that appeared since the audit blocks that pair", !p2.ok && pairIn(p2, A).status === "blocked" && /referenced \(1 in materialLists\)/.test(pairIn(p2, A).reasons.join()) && pairIn(p2, "448005").status === "ready");
  fs.writeFileSync(path.join(DATA, "material-lists.json"), mlBefore);
  const qbBefore = readJson("quickbooks-items.json", {}); writeJson("quickbooks-items.json", { ...qbBefore, parts: { ...qbBefore.parts, [B]: { qbItemId: "99" } } });
  p2 = await tool.dryRun();
  ok("2c. a QuickBooks mapping on B blocks that pair", !p2.ok && /QuickBooks item mapping \(99\)/.test(pairIn(p2, A).reasons.join()));
  writeJson("quickbooks-items.json", qbBefore);
  const noPick = lib.create(deps({ plan: { ...PLAN, photoPicks: {} } }));
  p2 = await noPick.dryRun();
  ok("2d. two live photos with no approved pick block that pair", !p2.ok && /both parts have a live photo .* no pick was approved/.test(pairIn(p2, "439101").reasons.join()) && pairIn(p2, A).status === "ready");
  const flipped = lib.create(deps({ plan: { ...PLAN, approved: [[B, A], ["448005", "448-005"], ["439101", "439-101"]] } }));
  p2 = await flipped.dryRun();
  ok("2e. a plan that keeps the newer number is orientation drift", !p2.ok && p2.orientation.length === 1 && /orientation/.test(p2.drift.join()));
  ok("the clean plan is back to the same fingerprint after every probe", (await tool.dryRun()).fingerprint === fp0);

  console.log("3. stale fingerprint");
  await partPrices.recordSupplierPrices(SO, { [B]: 280 }, { source: "import", at: "2026-10-01T00:00:00.000Z" }); rebuild();
  const beforeStale = snapshotDir();
  r = await attempt(() => tool.apply({ fingerprint: fp0, pairs: [[A, B]] }));
  ok("3. applying yesterday's fingerprint after B's price moved is refused, nothing written, no backup taken", r.err && r.err.code === "stale_fingerprint" && r.err.expected !== fp0 && sameDir(beforeStale, snapshotDir()) && backupDirsNow().length === 0, r.err && r.err.message);
  await partPrices.recordSupplierPrices(SO, { [B]: 276 }, { source: "import", at: "2026-09-12T14:00:00.000Z" }); rebuild();
  ok("putting the price back gives the original fingerprint again", (await tool.dryRun()).fingerprint === fp0);
  r = await attempt(() => tool.apply({ pairs: [[A, B]] }));
  ok("no fingerprint at all is refused the same way", r.err && r.err.code === "stale_fingerprint");

  console.log("6. pilot only");
  const beforePilot = snapshotDir();
  r = await attempt(() => tool.apply({ fingerprint: fp0, pairs: [["448005", "448-005"]] }));
  ok("6a. a ready pair that is not the pilot is refused", r.err && r.err.code === "pilot_only" && r.err.pilot[0][0] === A);
  r = await attempt(() => tool.apply({ fingerprint: fp0, pairs: [[A, B], ["448005", "448-005"]] }));
  ok("6b. the pilot plus one more is refused", r.err && r.err.code === "pilot_only");
  r = await attempt(() => tool.apply({ fingerprint: fp0, pairs: [] }));
  ok("6c. no pairs is refused", r.err && r.err.code === "pairs_required");
  ok("...and none of that wrote anything or took a backup", sameDir(beforePilot, snapshotDir()) && backupDirsNow().length === 0);
  ok("the server route never authorizes the batch (no batchAuthorized in server.js), and both routes are admin-only", !/batchAuthorized/.test(SRC) && /merge-duplicates\/dry-run" \|\| pathname === "\/api\/parts\/merge-duplicates\/apply"\)\) \{\s*const session = await requireAdmin\(req\)/.test(SRC) && /action: "catalog\.merge-duplicates"/.test(SRC));

  console.log("4. backup before the first write");
  const failing = lib.create(deps({ partSupplierPrices: { ...partPrices, recordSupplierPrices: async () => { throw new Error("disk full (simulated)"); } } }));
  const beforeFail = snapshotDir();
  r = await attempt(() => failing.apply({ fingerprint: fp0, pairs: [[A, B]] }));
  const failDirs = backupDirsNow();
  const onlyBackupChanged = (() => { const now = snapshotDir(); const changed = Object.keys({ ...beforeFail, ...now }).filter((k) => JSON.stringify(beforeFail[k]) !== JSON.stringify(now[k])); return changed.every((k) => failDirs.some((d) => k.startsWith(d + "/"))); })();
  ok("4. when the first write fails, the backup already exists and the stores are untouched", r.err && /disk full/.test(r.err.message) && r.err.code === "apply_failed" && failDirs.length === 1 && r.err.backupDir.endsWith(failDirs[0]) && onlyBackupChanged, r.err && r.err.message);
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, failDirs[0], "manifest.json"), "utf8"));
  ok("the manifest names every store with its byte count and sha256, and records the ones that don't exist yet", manifest.files.length === lib.BACKUP_FILES.length && manifest.files.filter((f) => f.present).every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0) && manifest.files.find((f) => f.name === "merge-duplicates-journal.json").present === false);
  ok("no journal entry was written for the failed attempt", !fs.existsSync(path.join(DATA, "merge-duplicates-journal.json")));
  fs.rmSync(path.join(DATA, failDirs[0]), { recursive: true, force: true });

  console.log("5. the backup is read back and verified");
  const probe = tool.backupStores("2026-10-06T00:00:00.000Z");
  ok("5a. a fresh backup verifies: every present file hashes as recorded, parses, and matches the live store", tool.verifyBackup(probe.dir).checked.filter((c) => c.present).length >= 5);
  fs.writeFileSync(path.join(probe.dir, "part-suppliers.json"), "{}\n");
  r = await attempt(() => tool.verifyBackup(probe.dir));
  ok("5b. a tampered copy is refused", r.err && r.err.code === "backup_failed" && /does not read back with the recorded hash/.test(r.err.message));
  fs.rmSync(path.join(probe.dir, "parts-overrides.json"));
  r = await attempt(() => tool.verifyBackup(probe.dir));
  ok("5c. a missing copy is refused", r.err && r.err.code === "backup_failed" && /missing/.test(r.err.message));
  fs.rmSync(probe.dir, { recursive: true, force: true });
  r = await attempt(() => { const d = tool.backupStores("2026-10-06T00:00:01.000Z"); fs.writeFileSync(path.join(DATA, "part-suppliers.json"), fs.readFileSync(path.join(DATA, "part-suppliers.json"), "utf8") + "\n"); try { return tool.verifyBackup(d.dir); } finally { fs.rmSync(d.dir, { recursive: true, force: true }); } });
  ok("5d. a live store that changed between copy and check is refused", r.err && r.err.code === "backup_failed" && /changed while the backup/.test(r.err.message));
  seed(); rebuild();
  ok("(stores re-seeded; fingerprint unchanged)", (await tool.dryRun()).fingerprint === fp0);

  console.log("7–11. the pilot apply");
  const preApply = { a: pairIn(await tool.dryRun(), A).before.a, b: pairIn(await tool.dryRun(), A).before.b };
  const histBefore = { ml: fs.readFileSync(path.join(DATA, "material-lists.json"), "utf8"), po: fs.readFileSync(path.join(DATA, "purchase-orders.json"), "utf8") };
  const result = await tool.apply({ fingerprint: fp0, pairs: [[A, B]], by: "Patrick" });
  ok("the pilot applies: one pair, every verification check passes, a backup dir is named", result.ok && result.applied.length === 1 && result.applied[0].verification.every((c) => c.ok) && /BACKUP-.*-merge-duplicates$/.test(result.backupDir) && fs.existsSync(path.join(result.backupDir, "manifest.json")), JSON.stringify(result.applied[0] && result.applied[0].verification.filter((c) => !c.ok)));
  ok("the four steps ran in order: offer, supplier assignment, photo (skipped), retire", result.applied[0].steps.map((s) => s.step).join(",") === "supplier-offer,supplier-assignment,photo-link,retire" && result.applied[0].steps[2].skipped);
  const parts = PARTS;
  ok("7. B resolves to A everywhere: alias map, canonicalSku, the Material List door, and B is gone from the catalog", partAlias.canonical(B) === A && partsLib.canonicalSku(B, readJson("parts-overrides.json", {})) === A && !parts[B] && parts[A].aliases.includes(B) && ml.canonicalizeIncomingLines([{ id: "tmp_1", sku: B, qty: 2, status: "need" }], [])[0].sku === A);
  ok("A kept its default supplier and price, gained SiteOne behind it, and SiteOne's offer names 405-007", parts[A].supplierIds.join() === `${CP},${SO}` && parts[A].priceCents === 410 && parts[A].priceSupplierId === null && parts[A].supplierPrices[SO].priceCents === 276 && parts[A].supplierPrices[SO].supplierSku === B && parts[A].supplierPrices[SO].at === "2026-09-12T14:00:00.000Z");
  ok("the other approved pairs are untouched (pilot only)", !!parts["448-005"] && !!parts["439-101"] && !!parts["1401-102"]);
  r = await attempt(() => partsLib.addOne(BASE, { ...ADDED[B] }, {}));
  ok("8. B cannot be recreated", r.err && r.err.code === "sku_merged" && r.err.into === A);
  r = await attempt(() => partsLib.restore(B));
  ok("...nor restored as a part", r.err && r.err.code === "sku_merged");
  const diff = partsLib.computeImportDiff(parts, [{ sku: B, partNumber: B, category: "fittings", subcategory: "PVC Tee", size: "0.75\"", description: "Tee PVC 3/4 in. Fipt", priceCents: 261, unit: "each", supplierId: SO }], { merged: readJson("parts-overrides.json", {}).merged });
  ok("9. an import row naming B is 'aliased' to A, never 'added'", diff.aliased && diff.aliased[B] && diff.aliased[B].into === A && !(diff.added && diff.added[B]), JSON.stringify(Object.keys(diff)));
  await partPrices.recordSupplierPrices(SO, { [A]: { priceCents: 261, supplierSku: B } }, { source: "import" }); rebuild();
  ok("...and committing it moves A's SiteOne offer (2.76 → 2.61) with B still as the supplier part #, A's price unchanged", PARTS[A].supplierPrices[SO].priceCents === 261 && PARTS[A].supplierPrices[SO].supplierSku === B && PARTS[A].priceCents === 410 && !PARTS[B]);
  await partSuppliers.setPrimaryBulk({ [A]: SO }, { currentFor: (s) => PARTS[s] ? PARTS[s].supplierIds : [] }); rebuild();
  ok("10. choosing SiteOne as default on the Suppliers page keeps Central as the alternate (and re-prices to the SiteOne offer)", PARTS[A].supplierIds.join() === `${SO},${CP}` && PARTS[A].priceCents === 261);
  await partSuppliers.setPrimaryBulk({ [A]: CP }, { currentFor: (s) => PARTS[s] ? PARTS[s].supplierIds : [] }); rebuild();
  ok("...and back to Central keeps SiteOne", PARTS[A].supplierIds.join() === `${CP},${SO}` && PARTS[A].priceCents === 410);
  r = await attempt(() => partSuppliers.setPrimaryBulk({ [A]: "" }, { currentFor: (s) => PARTS[s] ? PARTS[s].supplierIds : [] }));
  ok("...and clearing the default on the two-supplier part is refused", r.err && r.err.code === "alternates_present");
  ok("history: the purchased list line and the PO are byte-identical", fs.readFileSync(path.join(DATA, "material-lists.json"), "utf8") === histBefore.ml && fs.readFileSync(path.join(DATA, "purchase-orders.json"), "utf8") === histBefore.po);
  const journal = readJson("merge-duplicates-journal.json", []);
  ok("the journal holds the pair, the before/after, the backup dir, the fingerprint and the verification", journal.length === 1 && journal[0].pair.a === A && journal[0].before.b.sku === B && journal[0].after.b.retired && journal[0].backupDir === result.backupDir && journal[0].fingerprint === fp0 && journal[0].verification.length >= 9);
  const after = await tool.dryRun();
  ok("a dry run after the pilot is clean: the pilot shows as done, the other two ready, no drift, a new fingerprint", after.ok && pairIn(after, A).status === "done" && after.counts.done === 1 && after.counts.ready === 2 && after.fingerprint !== fp0, JSON.stringify(after.drift));
  r = await attempt(() => tool.apply({ fingerprint: after.fingerprint, pairs: [[A, B]] }));
  ok("applying the pilot twice is refused (already done)", r.err && r.err.code === "pair_not_ready" && /done/.test(r.err.message));

  console.log("11. rollback from the backup");
  const man = JSON.parse(fs.readFileSync(path.join(result.backupDir, "manifest.json"), "utf8"));
  for (const f of man.files) {
    const live = path.join(DATA, f.name);
    if (f.present) fs.copyFileSync(path.join(result.backupDir, f.name), live);
    else if (fs.existsSync(live)) fs.rmSync(live);
  }
  rebuild();
  const rolled = await tool.dryRun();
  const rb = pairIn(rolled, A);
  ok("11. copying the backup back restores A and B exactly (both live, same suppliers, prices, offers, photo state), alias map empty, journal gone", !!PARTS[B] && JSON.stringify(rb.before.a) === JSON.stringify(preApply.a) && JSON.stringify(rb.before.b) === JSON.stringify(preApply.b) && partAlias.canonical(B) === B && !fs.existsSync(path.join(DATA, "merge-duplicates-journal.json")), JSON.stringify([rb.before.a, preApply.a]));
  ok("...and the dry run fingerprint is the pre-apply one again", rolled.fingerprint === fp0);
  fs.rmSync(result.backupDir, { recursive: true, force: true });

  console.log("batch (library-level authorization only): same-supplier repricing and the photo move");
  const batch = lib.create(deps({ batchAuthorized: true }));
  const bp = await batch.dryRun();
  ok("a batch-authorized instance says so", bp.pilotOnly === false);
  const bres = await batch.apply({ fingerprint: bp.fingerprint, pairs: [["448005", "448-005"], ["439101", "439-101"]], by: "test" });
  ok("two non-pilot pairs apply when the batch is authorized, every check passing", bres.ok && bres.applied.length === 2 && bres.applied.every((x) => x.ok), JSON.stringify(bres.applied.map((x) => x.verification.filter((c) => !c.ok))));
  ok("448005: priced 0.73 from the newer SiteOne offer, linked to B's fitting PG-0035 and now its default", PARTS["448005"].priceCents === 73 && PARTS["448005"].photoState === "verified" && readJson("part-photo-links.json", {})["448005"].groupId === "PG-0035" && readJson("part-photo-groups.json", {})["PG-0035"].defaultSku === "448005" && readJson("part-photo-links.json", {})["448005"].linkTier === "confirmed");
  ok("the fitting's approval is untouched (approvedBy, tier, photo hash)", (() => { const g = readJson("part-photo-groups.json", {})["PG-0035"]; return g.tier === "approved" && g.approvedBy === "Patrick" && g.photo.hash === H1; })());
  ok("439101: keeps its own photo PG-0080 and its Sep 21 quote; 439-101's link is left as history", readJson("part-photo-links.json", {})["439101"].groupId === "PG-0080" && PARTS["439101"].supplierPrices[SO].at === "2026-09-21T15:00:00.000Z" && PARTS["439101"].supplierPrices[SO].supplierSku === "439-101" && !!readJson("part-photo-links.json", {})["439-101"]);
  const bafter = await batch.dryRun();
  ok("after the batch the plan is clean: 2 done, the rolled-back pilot ready again, the held pair still live", bafter.ok && bafter.counts.done === 2 && bafter.counts.ready === 1 && !!PARTS["1401-102"] && !!PARTS["1401102"], JSON.stringify({ counts: bafter.counts, drift: bafter.drift }));
  for (const d of backupDirsNow()) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
} catch (err) {
  if (!/pre-change code/.test(err.message)) ok("the suite ran to the end", false, err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err.message);
} finally {
  for (const d of backupDirsNow()) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
  for (const d of photoDirs) fs.rmSync(d, { recursive: true, force: true });
  if (fs.existsSync(path.join(DATA, "part-photos")) && fs.readdirSync(path.join(DATA, "part-photos")).length === 0) fs.rmdirSync(path.join(DATA, "part-photos"));
  for (const [f, b] of Object.entries(backups)) {
    const p = path.join(DATA, f);
    if (b === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else if (!fs.existsSync(p) || !fs.readFileSync(p).equals(b)) fs.writeFileSync(p, b);
  }
  try { require(path.join(ROOT, "server", "lib", "part-alias.js")).publish({}); } catch {}
}

console.log(`\nmerge duplicates: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

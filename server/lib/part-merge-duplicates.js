// Duplicate fittings → one part each (Patrick, 2026-10-05; Step C of the
// duplicate-fittings work, after Step A `part-suppliers.withPrimary` and
// Step B `parts.mergeInto` / `lib/part-alias`).
//
// 45 fittings exist twice in the catalog: "405007" (older, Central Pro) and
// "405-007" (added 2026-09-12 by the SiteOne import). This module is the
// migration tool that folds each B into its A, and it is deliberately
// boring:
//
//   dryRun()   READS ONLY. Recomputes the pair set from the catalog as it is
//              now, checks every approved pair against what was approved,
//              computes the exact before/after for each, and signs the whole
//              thing with a fingerprint. Any difference from the approved plan
//              is DRIFT and the plan refuses (ok: false) — it never guesses.
//   apply()    Needs the fingerprint of a dry run of the CURRENT state (stale
//              → refused, nothing written). Backs the stores up first and
//              proves the backup reads back. Then, per pair: B's supplier
//              offer onto A (the retired number becomes that supplier's part
//              number), B's supplier onto A behind A's default, B's photo onto
//              A through the existing same-fitting link, and finally
//              parts.mergeInto. History (lists, POs, RFQs, projects, work
//              orders, invoices, PDFs, audit) is never touched — a pair whose B
//              is referenced anywhere is refused before any of that.
//
// PILOT ONLY. Until a later change flips `batchAuthorized`, apply() accepts
// exactly one pair — the pilot (405007 ← 405-007) — and refuses anything
// else. The other 44 wait for Patrick's go after he has tested the pilot on
// production.
//
// Everything this module needs from the server is injected (create(deps)),
// so the test runs it against seeded stores with no server.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ---- The approved plan (scratchpad/duplicate-fittings-dry-run-design.md,
// approved by Patrick 2026-10-05). A = kept, B = retired. Order = the table.
const PLAN_VERSION = "duplicates-2026-10-05-v1";
const APPROVED_PAIRS = [
  ["405005", "405-005"], ["405007", "405-007"], ["405015", "405-015"],
  ["408005", "408-005"], ["408007", "408-007"], ["408015", "408-015"],
  ["439101", "439-101"], ["439211", "439-211"],
  ["448005", "448-005"], ["448007", "448-007"], ["450005", "450-005"], ["450007", "450-007"],
  ["1401007", "1401-007"], ["1401010", "1401-010"], ["1401012", "1401-012"], ["1401015", "1401-015"],
  ["1402007", "1402-007"], ["1402101", "1402-101"], ["1403007", "1403-007"],
  ["1406007", "1406-007"], ["1406010", "1406-010"], ["1406012", "1406-012"], ["1406015", "1406-015"],
  ["1407101", "1407-101"], ["1407130", "1407-130"],
  ["1429007", "1429-007"], ["1429010", "1429-010"], ["1429012", "1429-012"], ["1429015", "1429-015"],
  ["1429168", "1429-168"], ["1429211", "1429-211"], ["1429212", "1429-212"],
  ["1435007", "1435-007"], ["1435010", "1435-010"],
  ["1436007", "1436-007"], ["1436010", "1436-010"], ["1436015", "1436-015"], ["1436131", "1436-131"], ["1436212", "1436-212"],
  ["1449007", "1449-007"], ["1449010", "1449-010"],
  ["RS025T", "RS-025T"],
  ["HC-075-FLOW", "HC075FLOW"], ["HC-100-FLOW", "HC100FLOW"], ["HC-150-FLOW", "HC150FLOW"]
];
// Same fitting, conflicting size fields — verify from supplier data first.
const HELD_PAIRS = [["1401102", "1401-102"], ["1436211", "1436-211"]];
// Both twins have their own live photo: which one the merged part shows.
const PHOTO_PICKS = { "439101": "A", "439211": "B", "HC-075-FLOW": "A", "HC-100-FLOW": "A" };
const PILOT_PAIRS = [["405007", "405-007"]];
const PRODUCTION_PLAN = { version: PLAN_VERSION, approved: APPROVED_PAIRS, held: HELD_PAIRS, photoPicks: PHOTO_PICKS, pilot: PILOT_PAIRS };

// The stores a merge can touch, and therefore the ones the backup holds.
const BACKUP_FILES = [
  "parts-overrides.json", "part-suppliers.json", "part-supplier-prices.json",
  "part-photo-groups.json", "part-photo-links.json", "quickbooks-items.json",
  "merge-duplicates-journal.json"
];
const JOURNAL_FILE = "merge-duplicates-journal.json";

// ---- small helpers ---------------------------------------------------------

function twinKey(sku) { return String(sku || "").replace(/-/g, "").toUpperCase(); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = stable(value[k]);
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stable(value)); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}
function refusal(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
function normalizePairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map((p) => (Array.isArray(p) ? [String(p[0] || "").trim(), String(p[1] || "").trim()] : [String((p && p.a) || "").trim(), String((p && p.b) || "").trim()]));
}
function samePair(x, y) { return x[0] === y[0] && x[1] === y[1]; }

// ---- pure: the twins the catalog holds right now ---------------------------

// Every pair of live parts whose numbers are equal once the dashes are
// stripped. A = the baseline part, or the earlier-added one. Anything else
// (three-way, two baseline parts, no dates to order by) is reported, not
// decided.
function discoverPairs(parts, { isBaseline = () => false, addedAt = () => null } = {}) {
  const byKey = new Map();
  for (const sku of Object.keys(parts || {})) {
    const k = twinKey(sku);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(sku);
  }
  const pairs = [], odd = [];
  for (const [key, skus] of byKey.entries()) {
    if (skus.length < 2) continue;
    if (skus.length > 2) { odd.push({ key, skus: skus.slice().sort(), reason: `${skus.length} parts share this number` }); continue; }
    const [x, y] = skus;
    const bx = !!isBaseline(x), by = !!isBaseline(y);
    let a = null, b = null, reason = null;
    if (bx && !by) { a = x; b = y; }
    else if (by && !bx) { a = y; b = x; }
    else if (!bx && !by) {
      const ax = String(addedAt(x) || ""), ay = String(addedAt(y) || "");
      if (ax && ay && ax !== ay) { a = ax < ay ? x : y; b = ax < ay ? y : x; }
      else reason = "neither part is from the baseline catalog and their added dates don't order them";
    } else reason = "both parts are baseline catalog parts";
    if (reason) { odd.push({ key, skus: [x, y].sort(), reason }); continue; }
    pairs.push({ key, a, b });
  }
  pairs.sort((p, q) => p.key.localeCompare(q.key));
  return { pairs, odd };
}

// ---- the tool --------------------------------------------------------------

function create(deps) {
  const {
    dataDir,
    baseline,            // () => BASELINE_PARTS (sku → part)
    catalog,             // () => effective PARTS.parts (after every merge layer)
    partsLib, partSuppliers, partSupplierPrices, partPhotos, partPhotosLib, partAlias,
    references,          // (sku) => { total, summary, ... }
    quickbooksItems,     // async () => { parts: { sku: {...} } }
    rebuild,             // () => void — server's rebuildCatalogFromOverrides
    now = () => new Date().toISOString(),
    plan = PRODUCTION_PLAN,
    batchAuthorized = false
  } = deps || {};
  if (!dataDir || typeof baseline !== "function" || typeof catalog !== "function") throw new Error("part-merge-duplicates: dataDir, baseline() and catalog() are required");
  for (const name of ["partsLib", "partSuppliers", "partSupplierPrices", "partPhotos", "partPhotosLib", "partAlias"]) {
    if (!deps[name]) throw new Error(`part-merge-duplicates: ${name} is required`);
  }
  const file = (name) => path.join(dataDir, name);

  // Every store read in one place, read-only (no ensureFile — a dry run must
  // never create a file).
  function readStores() {
    const overrides = readJson(file("parts-overrides.json"), { added: {}, edited: {}, deleted: [], merged: {} });
    return {
      overrides: { added: overrides.added || {}, edited: overrides.edited || {}, deleted: overrides.deleted || [], merged: overrides.merged || {} },
      suppliers: readJson(file("part-suppliers.json"), {}),
      prices: readJson(file("part-supplier-prices.json"), {}),
      groups: readJson(file("part-photo-groups.json"), {}),
      links: readJson(file("part-photo-links.json"), {})
    };
  }

  function photoOf(sku, part, groups, links) {
    if (!part) return { state: "none", groupId: null, hash: null, tier: null };
    const { state, group } = partPhotosLib.photoStateFor(sku, part, groups, links, partPhotos.fileExists);
    const link = links[sku];
    return {
      state,
      groupId: link ? link.groupId : null,
      hash: group && group.photo ? group.photo.hash || null : null,
      tier: group ? group.tier || null : null,
      defaultSku: group ? group.defaultSku || null : null
    };
  }

  function slice(sku, part, stores, origin) {
    if (!part) return null;
    const added = stores.overrides.added[sku], edited = stores.overrides.edited[sku];
    return {
      sku, partNumber: part.partNumber || null, description: part.description || "", size: part.size || "",
      category: part.category || "", subcategory: part.subcategory || "", manufacturer: part.manufacturer || "",
      priceCents: part.priceCents == null ? null : Number(part.priceCents), priceSupplierId: part.priceSupplierId || null,
      supplierIds: Array.isArray(part.supplierIds) ? part.supplierIds.slice() : [],
      supplierPrices: clone(stores.prices[sku] || {}),
      origin, addedAt: added ? added.addedAt || null : null, editedAt: edited ? edited.editedAt || null : null,
      photo: photoOf(sku, part, stores.groups, stores.links),
      aliases: Array.isArray(part.aliases) ? part.aliases.slice() : []
    };
  }

  // The supplier offer B carries: its stored supplier price under its own
  // supplier, or failing that the catalog price it was added with.
  function offerOf(b, partB, stores) {
    const supplierId = partB && Array.isArray(partB.supplierIds) && partB.supplierIds[0] ? partB.supplierIds[0] : null;
    if (!supplierId) return null;
    const stored = stores.prices[b] && stores.prices[b][supplierId];
    if (stored && stored.priceCents != null) return { supplierId, priceCents: Number(stored.priceCents), at: stored.at || null, source: stored.source || null, from: "supplier price" };
    if (partB.priceCents == null) return { supplierId, priceCents: null, at: null, source: null, from: "none" };
    const added = stores.overrides.added[b];
    return { supplierId, priceCents: Number(partB.priceCents), at: (added && added.addedAt) || null, source: "catalog price", from: "catalog" };
  }

  // Everything one merge will do, computed without writing. Returns the
  // pair's status, the reasons it is blocked, and the exact before/after.
  async function planPair([a, b], ctx) {
    const { parts, base, stores, qb, merged } = ctx;
    const partA = parts[a], partB = parts[b];
    const originOf = (sku) => (base[sku] ? "baseline" : stores.overrides.added[sku] ? "added" : stores.overrides.merged[sku] ? "retired" : "missing");
    const out = { a, b, status: "ready", reasons: [], before: { a: slice(a, partA, stores, originOf(a)), b: slice(b, partB, stores, originOf(b)) }, after: null, steps: [] };
    const block = (why) => { out.status = "blocked"; out.reasons.push(why); };

    if (merged[b] === a) {
      out.status = "done";
      out.after = { a: slice(a, partA, stores, originOf(a)), b: { sku: b, retired: true, into: a, marker: clone(stores.overrides.merged[b]) } };
      return out;
    }
    if (merged[b] && merged[b] !== a) block(`${b} is already merged into ${merged[b]}, not ${a}`);
    if (merged[a]) block(`${a} is itself retired (merged into ${merged[a]})`);
    if (!partA) block(`${a} is not a live catalog part`);
    if (!partB) block(`${b} is not a live catalog part`);
    if (out.status !== "ready") return out;

    if (twinKey(a) !== twinKey(b)) block(`${a} and ${b} are not the same number once dashes are stripped`);
    if ((partA.category || "") !== (partB.category || "") || (partA.subcategory || "") !== (partB.subcategory || "")) block(`category/subcategory differ (${partA.category}/${partA.subcategory} vs ${partB.category}/${partB.subcategory})`);
    if (!base[a] && !stores.overrides.added[a]) block(`${a} is neither a baseline part nor a runtime addition`);
    if (base[b] || (stores.overrides.added[a] && stores.overrides.added[b] && String(stores.overrides.added[a].addedAt || "") > String(stores.overrides.added[b].addedAt || ""))) block(`orientation: ${b} is older than ${a} — the approved plan keeps the older number`);

    // History: a number anything still points at is never retired.
    const refsB = references(b);
    out.referencesB = refsB;
    if (refsB.total > 0) block(`${b} is referenced (${refsB.summary}) — new references since the audit`);
    // QuickBooks: B must have no item mapping (sync reads the baseline only).
    if (qb.parts && qb.parts[b]) block(`${b} has a QuickBooks item mapping (${qb.parts[b].qbItemId || "?"})`);
    out.quickbooks = { a: !!(qb.parts && qb.parts[a]), b: !!(qb.parts && qb.parts[b]) };

    // Supplier offer.
    const offer = offerOf(b, partB, stores);
    if (!offer) block(`${b} has no supplier assigned — nothing to fold into ${a}`);
    if (out.status !== "ready") return out;
    const existing = stores.prices[a] && stores.prices[a][offer.supplierId];
    let priceAction;
    if (offer.priceCents == null) priceAction = { kind: "none", why: `${b} has no price` };
    else if (existing && existing.priceCents != null && String(existing.at || "") >= String(offer.at || "")) {
      priceAction = { kind: existing.supplierSku ? "keep" : "keep-number", why: `${a} already has a newer ${offer.supplierId} quote (${existing.at || "undated"} ≥ ${offer.at || "undated"})`, existing: clone(existing) };
    } else priceAction = { kind: "record", why: existing ? `${b}'s ${offer.supplierId} price (${offer.at || "undated"}) is newer than ${a}'s (${existing.at || "undated"})` : `${a} has no ${offer.supplierId} offer yet` };
    out.offer = offer;
    out.priceAction = priceAction;

    // Supplier assignment: A keeps its list, B's supplier joins behind it.
    const supplierIdsAfter = partA.supplierIds.includes(offer.supplierId) ? partA.supplierIds.slice() : [...partA.supplierIds, offer.supplierId];

    // Photo.
    const phA = out.before.a.photo, phB = out.before.b.photo;
    let photoAction = { kind: "none", why: "neither part has a live photo" };
    if (phB.state === "verified" && phA.state !== "verified") photoAction = { kind: "link", groupId: phB.groupId, why: `${a} joins ${b}'s fitting ${phB.groupId}` };
    else if (phA.state === "verified" && phB.state !== "verified") photoAction = { kind: "none", why: `${a} keeps its own photo ${phA.groupId}` };
    else if (phA.state === "verified" && phB.state === "verified") {
      if (phA.groupId === phB.groupId) photoAction = { kind: "none", why: `already the same fitting ${phA.groupId}` };
      else {
        const pick = plan.photoPicks[a];
        if (pick === "A") photoAction = { kind: "none", why: `approved pick: keep ${a}'s photo ${phA.groupId}` };
        else if (pick === "B") photoAction = { kind: "link", groupId: phB.groupId, why: `approved pick: use ${b}'s photo ${phB.groupId}` };
        else block(`both parts have a live photo (${phA.groupId} vs ${phB.groupId}) and no pick was approved`);
      }
    }
    if (photoAction.kind === "link" && stores.groups[photoAction.groupId] && stores.groups[photoAction.groupId].defaultSku === b) photoAction.becomesDefault = true;
    out.photoAction = photoAction;
    if (out.status !== "ready") return out;

    // Simulate the after-state with the real merge rules.
    const overrides2 = clone(stores.overrides);
    overrides2.merged[b] = { into: a, supplierId: offer.supplierId, origin: stores.overrides.added[b] ? "added" : "baseline" };
    if (overrides2.added[b]) delete overrides2.added[b];
    else delete overrides2.edited[b];
    const suppliers2 = clone(stores.suppliers);
    suppliers2[a] = supplierIdsAfter;
    const prices2 = clone(stores.prices);
    if (priceAction.kind === "record") {
      if (!prices2[a]) prices2[a] = {};
      prices2[a][offer.supplierId] = { priceCents: offer.priceCents, supplierSku: b, source: `merged ${b}`, at: offer.at || now() };
    } else if (priceAction.kind === "keep-number") {
      prices2[a][offer.supplierId] = { ...prices2[a][offer.supplierId], supplierSku: b };
    }
    const parts2 = partsLib.mergeOverrides(base, overrides2);
    partSuppliers.mergeIntoCatalog(parts2, suppliers2);
    partSupplierPrices.mergeIntoCatalog(parts2, prices2, { editedMap: overrides2.edited });
    const links2 = clone(stores.links), groups2 = clone(stores.groups);
    if (photoAction.kind === "link") {
      links2[a] = { groupId: photoAction.groupId, linkTier: "confirmed", fingerprint: partPhotosLib.fingerprintOf(parts2[a]) };
      if (photoAction.becomesDefault) groups2[photoAction.groupId].defaultSku = a;
    }
    const after = slice(a, parts2[a], { overrides: overrides2, suppliers: suppliers2, prices: prices2, groups: groups2, links: links2 }, originOf(a));
    out.after = { a: after, b: { sku: b, retired: true, into: a, supplierId: offer.supplierId, origin: overrides2.merged[b].origin } };
    if (after.supplierIds[0] !== out.before.a.supplierIds[0]) block(`default supplier would change (${out.before.a.supplierIds[0] || "none"} → ${after.supplierIds[0] || "none"})`);
    if (parts2[b]) block(`${b} would still be a live part after the merge`);
    out.priceChange = out.before.a.priceCents !== after.priceCents ? { from: out.before.a.priceCents, to: after.priceCents } : null;
    out.steps = [
      priceAction.kind === "record" ? `record ${offer.supplierId} offer on ${a}: ${offer.priceCents}¢, supplier part # ${b} (dated ${offer.at || "now"})`
        : priceAction.kind === "keep-number" ? `note supplier part # ${b} on ${a}'s existing ${offer.supplierId} quote (price and date kept)`
        : `keep ${a}'s ${offer.supplierId} offer as is (${priceAction.why})`,
      supplierIdsAfter.length !== partA.supplierIds.length ? `suppliers on ${a}: ${partA.supplierIds.join("+") || "none"} → ${supplierIdsAfter.join("+")} (default ${supplierIdsAfter[0]} unchanged)` : `suppliers on ${a} unchanged (${supplierIdsAfter.join("+")})`,
      photoAction.kind === "link" ? `link ${a} to fitting ${photoAction.groupId}${photoAction.becomesDefault ? " and make it the fitting's default" : ""}` : `photo: ${photoAction.why}`,
      `retire ${b} into ${a} (reversible marker; ${b} stays searchable as ${a}'s alias)`
    ];
    return out;
  }

  async function dryRun() {
    const base = baseline() || {};
    const parts = catalog() || {};
    const stores = readStores();
    const merged = partsLib.aliasMap(stores.overrides);
    const qb = (await quickbooksItems()) || { parts: {} };
    const ctx = { parts, base, stores, qb, merged };

    const discovered = discoverPairs(parts, { isBaseline: (sku) => !!base[sku], addedAt: (sku) => (stores.overrides.added[sku] || {}).addedAt || null });
    const approved = normalizePairs(plan.approved), held = normalizePairs(plan.held);
    const known = [...approved, ...held];
    const pairs = [];
    for (const pair of approved) pairs.push(await planPair(pair, ctx));
    const heldOut = held.map(([a, b]) => ({ a, b, status: "held", live: { a: !!parts[a], b: !!parts[b] }, size: { a: parts[a] ? parts[a].size || "" : null, b: parts[b] ? parts[b].size || "" : null } }));
    const unexpected = discovered.pairs
      .filter((d) => !known.some((k) => (k[0] === d.a && k[1] === d.b) || (k[0] === d.b && k[1] === d.a)))
      .map((d) => ({ a: d.a, b: d.b, reason: "a twin pair the approved plan does not name" }));
    const orientation = discovered.pairs
      .filter((d) => known.some((k) => k[0] === d.b && k[1] === d.a))
      .map((d) => ({ a: d.a, b: d.b, reason: `the catalog says ${d.a} is the older number; the plan keeps ${d.b}` }));

    const drift = [];
    for (const p of pairs) if (p.status === "blocked") drift.push(`${p.a} ← ${p.b}: ${p.reasons.join("; ")}`);
    for (const u of unexpected) drift.push(`unexpected twins ${u.a} / ${u.b}: ${u.reason}`);
    for (const o of orientation) drift.push(`orientation ${o.a} / ${o.b}: ${o.reason}`);
    for (const o of discovered.odd) drift.push(`${o.skus.join(" / ")}: ${o.reason}`);
    for (const h of heldOut) if (!h.live.a || !h.live.b) drift.push(`held pair ${h.a} / ${h.b}: not both live (held pairs must stay untouched)`);

    const prerequisites = {
      stepA_supplierPreservation: typeof partSuppliers.withPrimary === "function" && typeof partSuppliers.setPrimaryBulk === "function",
      stepB_aliases: typeof partsLib.mergeInto === "function" && typeof partsLib.canonicalSku === "function" && typeof partAlias.canonical === "function" && typeof partAlias.current === "function",
      stepB_aliasMapPublished: (() => { try { return stableJson(partAlias.current()) === stableJson(merged); } catch { return false; } })()
    };
    for (const [k, v] of Object.entries(prerequisites)) if (!v) drift.push(`prerequisite missing: ${k}`);

    const counts = { approved: pairs.length, ready: 0, done: 0, blocked: 0, held: heldOut.length };
    for (const p of pairs) counts[p.status] = (counts[p.status] || 0) + 1;
    const pilotPairs = normalizePairs(plan.pilot);
    const pilot = pairs.filter((p) => pilotPairs.some((pp) => samePair(pp, [p.a, p.b])));

    const fingerprintBody = {
      planVersion: plan.version,
      pairs: pairs.map((p) => ({ a: p.a, b: p.b, status: p.status, reasons: p.reasons, before: p.before, after: p.after, priceAction: p.priceAction || null, photoAction: p.photoAction || null, quickbooks: p.quickbooks || null, referencesB: p.referencesB ? p.referencesB.total : null })),
      held: heldOut, unexpected, orientation, odd: discovered.odd, merged, catalogParts: Object.keys(parts).length
    };
    const fingerprint = sha256(stableJson(fingerprintBody));
    const applyCount = counts.ready;
    return {
      ok: drift.length === 0,
      planVersion: plan.version,
      at: now(),
      fingerprint,
      counts,
      catalog: { parts: Object.keys(parts).length, afterAllReady: Object.keys(parts).length - applyCount, twinsFound: discovered.pairs.length },
      prerequisites,
      pairs, held: heldOut, unexpected, orientation, odd: discovered.odd,
      pilot: pilot.map((p) => ({ a: p.a, b: p.b, status: p.status, reasons: p.reasons, before: p.before, after: p.after, steps: p.steps, priceAction: p.priceAction, photoAction: p.photoAction })),
      pilotOnly: !batchAuthorized,
      drift,
      errors: drift.length ? [`${drift.length} difference(s) from the approved plan — nothing will be applied until the plan is re-approved.`] : []
    };
  }

  // ---- backup ----------------------------------------------------------------

  function backupStores(stamp) {
    const dir = path.join(dataDir, `BACKUP-${stamp.replace(/[:.]/g, "-")}-merge-duplicates`);
    if (fs.existsSync(dir)) throw refusal("backup_exists", `Backup folder already exists: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const name of BACKUP_FILES) {
      const src = file(name);
      if (!fs.existsSync(src)) { files.push({ name, present: false }); continue; }
      const bytes = fs.readFileSync(src);
      fs.writeFileSync(path.join(dir, name), bytes);
      files.push({ name, present: true, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = { kind: "merge-duplicates backup", at: stamp, dataDir, files, restore: "copy each present file back over server/data/<name>; delete the ones marked present: false; then restart or rebuild the catalog" };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { dir, manifest };
  }

  // Prove the backup is usable: every file listed in the manifest reads
  // back with the recorded hash, parses as JSON, and still matches the live
  // store it was copied from (nothing moved between copy and check).
  function verifyBackup(dir, { compareLive = true } = {}) {
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw refusal("backup_failed", `No manifest in ${dir}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const checked = [];
    for (const entry of manifest.files || []) {
      if (!entry.present) { checked.push({ name: entry.name, present: false, ok: true }); continue; }
      const p = path.join(dir, entry.name);
      if (!fs.existsSync(p)) throw refusal("backup_failed", `Backup file missing: ${entry.name}`);
      const bytes = fs.readFileSync(p);
      const hash = sha256(bytes);
      if (hash !== entry.sha256) throw refusal("backup_failed", `Backup file ${entry.name} does not read back with the recorded hash`);
      if (bytes.length !== entry.bytes) throw refusal("backup_failed", `Backup file ${entry.name} has ${bytes.length} bytes, manifest says ${entry.bytes}`);
      try { JSON.parse(bytes.toString("utf8") || "{}"); } catch (err) { throw refusal("backup_failed", `Backup file ${entry.name} is not valid JSON (${err.message})`); }
      if (compareLive) {
        const live = file(entry.name);
        if (!fs.existsSync(live) || sha256(fs.readFileSync(live)) !== hash) throw refusal("backup_failed", `Live store ${entry.name} changed while the backup was being taken`);
      }
      checked.push({ name: entry.name, present: true, bytes: bytes.length, sha256: hash, ok: true });
    }
    return { dir, checked };
  }

  function appendJournal(entry) {
    const p = file(JOURNAL_FILE);
    const list = readJson(p, []);
    const arr = Array.isArray(list) ? list : [];
    arr.push(entry);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + "\n");
    fs.renameSync(tmp, p);
    return entry;
  }

  // ---- apply -------------------------------------------------------------------

  async function apply({ fingerprint, pairs, by = "admin" } = {}) {
    const wanted = normalizePairs(pairs);
    if (!wanted.length) throw refusal("pairs_required", "Name the pair(s) to apply, e.g. [[\"405007\",\"405-007\"]].");
    const pilotPairs = normalizePairs(plan.pilot);
    if (!batchAuthorized) {
      const onlyPilot = wanted.length === 1 && pilotPairs.some((pp) => samePair(pp, wanted[0]));
      if (!onlyPilot) throw refusal("pilot_only", `Only the pilot pair (${pilotPairs.map((p) => `${p[0]} ← ${p[1]}`).join(", ")}) may be applied until the batch is explicitly authorized.`, { pilot: pilotPairs });
    }
    const approvedPairs = normalizePairs(plan.approved);
    for (const w of wanted) if (!approvedPairs.some((ap) => samePair(ap, w))) throw refusal("not_approved", `${w[0]} ← ${w[1]} is not in the approved plan.`);

    // The plan is recomputed from the stores as they are NOW; the caller's
    // fingerprint must be of exactly this state.
    const current = await dryRun();
    if (!fingerprint || fingerprint !== current.fingerprint) {
      throw refusal("stale_fingerprint", "The dry run you are applying no longer matches production. Run the dry run again, read it, then apply with its fingerprint.", { expected: current.fingerprint, given: fingerprint || null });
    }
    if (current.drift.length) throw refusal("drift", `The plan has drifted from what was approved: ${current.drift.join(" | ")}`, { drift: current.drift });
    const todo = wanted.map((w) => current.pairs.find((p) => samePair([p.a, p.b], w)));
    for (const p of todo) if (p.status !== "ready") throw refusal("pair_not_ready", `${p.a} ← ${p.b} is ${p.status}${p.reasons.length ? ` (${p.reasons.join("; ")})` : ""}.`);

    // Backup first, and prove it reads back, before anything is written.
    const stamp = now();
    const backup = backupStores(stamp);
    let verified;
    try { verified = verifyBackup(backup.dir); }
    catch (err) { err.backupDir = backup.dir; throw err; }

    const applied = [];
    for (const p of todo) {
      const base = baseline();
      const partA = catalog()[p.a];
      const steps = [];
      const offer = p.offer;
      try {
        if (p.priceAction.kind === "record") {
          const r = await partSupplierPrices.recordSupplierPrices(offer.supplierId, { [p.a]: { priceCents: offer.priceCents, supplierSku: p.b } }, { source: `merged ${p.b}`, at: offer.at || stamp });
          steps.push({ step: "supplier-offer", ok: true, recorded: r.recorded });
        } else if (p.priceAction.kind === "keep-number") {
          const existing = p.priceAction.existing;
          const r = await partSupplierPrices.recordSupplierPrices(offer.supplierId, { [p.a]: { supplierSku: p.b } }, { source: existing.source || null, at: existing.at || stamp });
          steps.push({ step: "supplier-offer", ok: true, recorded: r.recorded, note: "price and date kept" });
        } else steps.push({ step: "supplier-offer", ok: true, skipped: p.priceAction.why });

        if (p.after.a.supplierIds.join() !== p.before.a.supplierIds.join()) {
          await partSuppliers.bulkSet({ [p.a]: p.after.a.supplierIds });
          steps.push({ step: "supplier-assignment", ok: true, supplierIds: p.after.a.supplierIds });
        } else steps.push({ step: "supplier-assignment", ok: true, skipped: "unchanged" });

        if (p.photoAction.kind === "link") {
          const r = await partPhotos.linkToGroup(p.a, partA, p.photoAction.groupId, { by: `${by} (merge ${p.b} → ${p.a})` });
          steps.push({ step: "photo-link", ok: true, groupId: p.photoAction.groupId, previous: r.previous });
          if (p.photoAction.becomesDefault) {
            await partPhotos.setFittingDefault(p.photoAction.groupId, p.a, partA, { by: `${by} (merge ${p.b} → ${p.a})` });
            steps.push({ step: "photo-default", ok: true, groupId: p.photoAction.groupId, defaultSku: p.a });
          }
        } else steps.push({ step: "photo-link", ok: true, skipped: p.photoAction.why });

        const marker = await partsLib.mergeInto(base, p.b, p.a, { by, supplierId: offer.supplierId });
        steps.push({ step: "retire", ok: true, marker: { into: marker.into, origin: marker.origin, supplierId: marker.supplierId, at: marker.at } });
      } catch (err) {
        err.code = err.code || "apply_failed";
        err.backupDir = backup.dir;
        err.steps = steps;
        err.pair = [p.a, p.b];
        throw err;
      }
      if (typeof rebuild === "function") rebuild();

      // Verify what every reader now sees.
      const parts = catalog() || {};
      const stores = readStores();
      const a2 = parts[p.a];
      const checks = [
        ["B is no longer a live part", !parts[p.b]],
        ["B resolves to A", partAlias.canonical(p.b) === p.a && partsLib.canonicalSku(p.b, stores.overrides) === p.a],
        ["A lists B as an alias", !!a2 && Array.isArray(a2.aliases) && a2.aliases.includes(p.b)],
        ["A's default supplier is unchanged", !!a2 && (a2.supplierIds[0] || null) === (p.before.a.supplierIds[0] || null)],
        ["A's supplier list is as planned", !!a2 && a2.supplierIds.join() === p.after.a.supplierIds.join()],
        ["A's price is as planned", !!a2 && a2.priceCents === p.after.a.priceCents],
        ["B's number is on A's offer from that supplier", p.priceAction.kind === "none" || (!!a2 && !!a2.supplierPrices[offer.supplierId] && a2.supplierPrices[offer.supplierId].supplierSku === p.b)],
        ["A's photo is as planned", (() => { const ph = photoOf(p.a, a2, stores.groups, stores.links); return ph.state === p.after.a.photo.state && ph.groupId === p.after.a.photo.groupId; })()],
        ["the marker keeps B's record for unmerge", !!stores.overrides.merged[p.b] && stores.overrides.merged[p.b].into === p.a && (stores.overrides.merged[p.b].origin !== "added" || !!stores.overrides.merged[p.b].record)]
      ].map(([check, ok]) => ({ check, ok }));
      const afterSlice = slice(p.a, a2, stores, p.after.a.origin);
      const entry = appendJournal({ at: stamp, by, pair: { a: p.a, b: p.b }, planVersion: plan.version, fingerprint, backupDir: backup.dir, before: p.before, after: { a: afterSlice, b: p.after.b }, steps, verification: checks });
      applied.push({ a: p.a, b: p.b, steps, verification: checks, ok: checks.every((c) => c.ok), after: afterSlice, journal: entry.at });
    }
    const allOk = applied.every((x) => x.ok);
    return { ok: allOk, code: allOk ? undefined : "post_apply_verification_failed", applied, backupDir: backup.dir, backup: verified, fingerprintApplied: fingerprint, at: stamp };
  }

  return { dryRun, apply, verifyBackup, backupStores, readStores, plan, BACKUP_FILES, JOURNAL_FILE };
}

module.exports = {
  create, discoverPairs, twinKey, stableJson, sha256,
  PLAN_VERSION, APPROVED_PAIRS, HELD_PAIRS, PHOTO_PICKS, PILOT_PAIRS, PRODUCTION_PLAN, BACKUP_FILES, JOURNAL_FILE
};

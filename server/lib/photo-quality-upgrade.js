// Quality upgrade of LIVE photos (Patrick, Sep 28 2026).
//
// 53 of the 100 live photos were saved from small sources (30 of them the
// 96×96 SiteOne og:image thumbnail) while the same product page carried a
// 1200×1200 copy of the SAME picture. This is a quality replacement, never
// a new product-identification decision:
//
//   plan    For every live photo under the quality threshold, re-read the
//           product page it came from and look for a LARGER member of the
//           same image family (photo-quality.familyKeyOf — SiteOne's
//           "86012-1" under __thumbnail / __pdpIcon / __zoom). Download it,
//           measure it (size + sharpness), and prove it is the same
//           picture by comparing it with the current photo (normalised
//           correlation of small greyscale copies). Only a same-family,
//           same-picture, ok/good-grade copy is "deterministic". Everything
//           else — an uploaded or link-pasted photo with no page on record,
//           a page with no larger copy, a larger copy that doesn't match or
//           is still too small — goes to the Quality review queue.
//           The larger copy is stored as a content-addressed image (not
//           live) so the review tab can show before/after.
//   apply   Under the store's locks, and only for the exact list of
//           upgrades the plan showed: the group's photo hash moves to the
//           larger copy; the old hash goes to the group's history as
//           "quality-upgrade"; tier, approvedBy, approvedAt, links, fitting
//           membership and the AI result are untouched; `source` keeps its
//           page and method and records what it was upgraded from.
//   review  "Keep as is" marks a review row answered; replacing a photo by
//           hand uses the existing upload door.
//
// Never upscales: the store's processImage makes 2000 only from a source
// larger than 1200, and a copy that measures under the threshold is not
// an upgrade. No model anywhere in this file.

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { writeJsonAtomic, serialize } = require("./atomic-json");
const pq = require("./photo-quality");
const ev = require("./photo-evidence");

const SIMILARITY_MIN = 0.85;   // normalised correlation of 24×24 greyscale copies
const MAX_MEMBERS_TRIED = 3;
const SHOWABLE = new Set(["approved", "confident"]);

// How alike two images are, as the Pearson correlation of their 24×24
// greyscale copies (aspect ignored — both are the same picture at
// different sizes, so both squash the same way). 1 = identical.
async function similarity(bufA, bufB, sharp) {
  const small = async (b) => (await sharp(b, { limitInputPixels: 50e6 }).rotate().flatten({ background: "#ffffff" }).greyscale().resize(24, 24, { fit: "fill" }).raw().toBuffer());
  const [a, b] = await Promise.all([small(bufA), small(bufB)]);
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (!da || !db) return da === db ? 1 : 0;
  return num / Math.sqrt(da * db);
}

function createQualityUpgrade({ dataDir, store, getParts, fetchPage, fetchImage, sharp, now = () => Date.now(), log = () => {} }) {
  const FILE = path.join(dataDir, "part-photo-quality.json");
  let state = null;
  let building = null;

  async function load() {
    if (state) return state;
    try { state = JSON.parse(await fs.readFile(FILE, "utf8")); }
    catch (err) {
      if (err.code !== "ENOENT") throw new Error(`part-photo-quality.json is unreadable (${err.message}) — refusing to treat it as empty.`);
      state = { plan: null, reviewed: {} };
    }
    return state;
  }
  function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    return serialize(FILE, async () => { await fs.mkdir(dataDir, { recursive: true }); await writeJsonAtomic(FILE, snapshot); });
  }
  const longestOf = (photo) => {
    const s = photo && photo.source;
    return Math.max((s && s.width) || 0, (s && s.height) || 0, (photo && photo.width) || 0, (photo && photo.height) || 0);
  };

  // The live photos under the threshold, as the plan will consider them.
  async function candidates() {
    const { groups, links } = await store.snapshot();
    const parts = getParts() || {};
    const membersOf = {};
    for (const [sku, l] of Object.entries(links || {})) (membersOf[l.groupId] ||= []).push(sku);
    const out = [];
    for (const [groupId, g] of Object.entries(groups || {})) {
      if (!g.photo || !g.photo.hash || !SHOWABLE.has(g.tier)) continue;
      const skus = (membersOf[groupId] || []).filter((s) => parts[s] && parts[s].photoState === "verified").sort();
      if (!skus.length) continue;
      const longest = longestOf(g.photo);
      if (longest >= pq.MIN_LONGEST) continue;
      out.push({ groupId, g, skus, longest });
    }
    return out;
  }

  async function planOne({ groupId, g, skus, longest }) {
    const src = g.source || {};
    const row = {
      groupId, skus, label: g.label || skus[0],
      current: { hash: g.photo.hash, width: g.photo.width || null, height: g.photo.height || null, longest, method: src.method || null, imageUrl: src.imageUrl || null, pageUrl: src.pageUrl || null, domain: src.domain || null, approvedBy: g.approvedBy || null, approvedAt: g.approvedAt || null, tier: g.tier },
      decision: "review", reason: "", upgrade: null, tried: []
    };
    if (!src.pageUrl || !src.imageUrl) { row.reason = src.method === "upload" ? "uploaded by hand — no product page on record" : "no product page on record for this photo"; return row; }
    let page;
    try { page = await fetchPage(src.pageUrl); }
    catch (err) { row.reason = `the product page couldn't be read (${String(err.message || err).slice(0, 80)})`; return row; }
    const pageUrl = page.finalUrl || src.pageUrl;
    const family = pq.familyKeyOf(src.imageUrl);
    if (!family) { row.reason = "the current image URL has no recognisable picture family"; return row; }
    const curHint = pq.imageUrlHints(src.imageUrl).sizeHint;
    const members = pq.collectImageUrls(page.html, pageUrl, { skip: ev.IMG_SKIP })
      .filter((u) => u !== src.imageUrl && pq.familyKeyOf(u) === family)
      .sort((a, b) => pq.imageUrlHints(b).sizeHint - pq.imageUrlHints(a).sizeHint)
      // A member the URL says is smaller is not worth a download; one the
      // URL says nothing about is — the measurement decides.
      .filter((u) => { const h = pq.imageUrlHints(u).sizeHint; return h === 0 || h >= curHint; })
      .slice(0, MAX_MEMBERS_TRIED);
    if (!members.length) { row.reason = "the product page exposes no larger copy of this picture"; return row; }
    let current;
    try { current = await store.readCandidateImage(g.photo.hash, 160); }
    catch { row.reason = "the current photo's file is missing"; return row; }
    for (const url of members) {
      const t = { url, width: null, height: null, grade: null, similarity: null, note: "" };
      row.tried.push(t);
      let img;
      try { img = await fetchImage(url); } catch (err) { t.note = `download failed (${String(err.message || err).slice(0, 60)})`; continue; }
      const look = await store.inspect(img.buffer);
      t.width = look.width; t.height = look.height; t.grade = look.quality.grade;
      if (look.quality.grade === "reject") { t.note = look.quality.reason; continue; }
      if (Math.max(look.width, look.height) <= longest) { t.note = "not larger than the current photo"; continue; }
      const sim = await similarity(current, img.buffer, sharp);
      t.similarity = +sim.toFixed(3);
      if (sim < SIMILARITY_MIN) { t.note = `doesn't match the current picture (similarity ${sim.toFixed(2)})`; continue; }
      if (look.quality.grade === "low") { t.note = `still ${look.quality.reason}`; continue; }
      const saved = await store.saveCandidateImage(img.buffer);
      row.upgrade = { hash: saved.hash, imageUrl: img.finalUrl || url, width: saved.width, height: saved.height, sizes: saved.sizes, source: saved.imageSource, sharpness: saved.sharpness, quality: saved.quality, similarity: t.similarity };
      row.decision = "upgrade";
      row.reason = `same picture, ${saved.imageSource.width}×${saved.imageSource.height} (${saved.quality.grade}), similarity ${t.similarity}`;
      return row;
    }
    row.reason = `no usable larger copy: ${row.tried.map((t) => t.note).filter(Boolean).join("; ") || "nothing passed"}`;
    return row;
  }

  // Build (or rebuild) the plan. Slow (one page and 1–3 images per photo),
  // so it runs once and is cached; `progress` is readable while it runs.
  async function buildPlan({ by = null } = {}) {
    await load();
    if (building) return building;
    building = (async () => {
      const list = await candidates();
      const id = "QU-" + new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(2).toString("hex");
      state.plan = { id, by, status: "building", at: new Date(now()).toISOString(), total: list.length, done: 0, rows: [] };
      await save();
      for (const c of list) {
        let row;
        try { row = await planOne(c); }
        catch (err) { row = { groupId: c.groupId, skus: c.skus, label: c.g.label || c.skus[0], current: { hash: c.g.photo.hash, longest: c.longest, approvedBy: c.g.approvedBy || null, tier: c.g.tier }, decision: "review", reason: `error: ${String(err.message || err).slice(0, 120)}`, upgrade: null, tried: [] }; }
        state.plan.rows.push(row);
        state.plan.done += 1;
        await save();
      }
      state.plan.status = "done";
      state.plan.finishedAt = new Date(now()).toISOString();
      await save();
      log({ action: "quality-upgrade.plan", id, by, ...counts(state.plan) });
      return summary();
    })().finally(() => { building = null; });
    return building;
  }
  function counts(plan) {
    const rows = plan ? plan.rows : [];
    return { total: plan ? plan.total : 0, planned: rows.length, upgrade: rows.filter((r) => r.decision === "upgrade").length, review: rows.filter((r) => r.decision === "review").length };
  }
  // Rows still meaningful now: an upgrade row whose photo has since changed
  // is dropped; a review row Patrick has already answered is dropped.
  async function summary() {
    await load();
    const plan = state.plan;
    if (!plan) return { plan: null, upgrades: [], review: [], counts: counts(null) };
    const { groups } = await store.snapshot();
    const live = (r) => groups[r.groupId] && groups[r.groupId].photo && groups[r.groupId].photo.hash === r.current.hash;
    const upgrades = plan.rows.filter((r) => r.decision === "upgrade" && live(r));
    const review = plan.rows.filter((r) => r.decision === "review" && live(r) && !(state.reviewed || {})[r.groupId]);
    return {
      plan: { id: plan.id, by: plan.by, status: plan.status, at: plan.at, finishedAt: plan.finishedAt || null, total: plan.total, done: plan.done, building: !!building },
      counts: { ...counts(plan), applicable: upgrades.length, openReview: review.length, applied: plan.rows.filter((r) => r.applied).length },
      upgrades, review
    };
  }

  // Apply the deterministic upgrades — exactly the hashes the plan shows,
  // in its order, or nothing.
  async function apply({ by = null, hashes = null } = {}) {
    const s = await summary();
    const expected = s.upgrades.map((r) => r.upgrade.hash);
    if (!expected.length) throw new Error("There are no deterministic upgrades to apply.");
    if (!Array.isArray(hashes) || JSON.stringify(hashes.map(String)) !== JSON.stringify(expected)) {
      throw new Error("The upgrade list differs from the plan shown — reload the plan and confirm the exact list.");
    }
    const applied = [], skipped = [];
    for (const r of s.upgrades) {
      const res = await store.upgradePhotoQuality(r.groupId, { fromHash: r.current.hash, to: r.upgrade, imageUrl: r.upgrade.imageUrl, by });
      if (res.skipped) { skipped.push({ groupId: r.groupId, reason: res.skipped }); continue; }
      const row = state.plan.rows.find((x) => x.groupId === r.groupId);
      if (row) row.applied = { by, at: new Date(now()).toISOString() };
      applied.push({ groupId: r.groupId, skus: r.skus, from: { hash: r.current.hash, longest: r.current.longest }, to: { hash: r.upgrade.hash, width: r.upgrade.source.width, height: r.upgrade.source.height, grade: r.upgrade.quality.grade } });
    }
    await save();
    log({ action: "quality-upgrade.apply", by, applied: applied.length, skipped: skipped.length });
    return { applied, skipped };
  }

  async function resolveReview(groupId, { action, by = null }) {
    await load();
    if (action !== "keep") throw new Error("Unknown action.");
    if (!state.plan || !state.plan.rows.some((r) => r.groupId === groupId && r.decision === "review")) throw new Error("That photo isn't in the quality review queue.");
    (state.reviewed ||= {})[groupId] = { action, by, at: new Date(now()).toISOString() };
    await save();
    log({ action: "quality-upgrade.review.keep", groupId, by });
    return state.reviewed[groupId];
  }

  return { load, candidates, buildPlan, summary, apply, resolveReview, similarity: (a, b) => similarity(a, b, sharp), SIMILARITY_MIN, _state: () => state };
}

module.exports = { createQualityUpgrade, similarity, SIMILARITY_MIN };

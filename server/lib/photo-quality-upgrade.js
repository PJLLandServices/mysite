// Resolution restoration of stored photos (Patrick, Sep 28 + Oct 1 2026).
//
// 53 of the 100 live photos, and the candidates waiting on the Review tab,
// were saved from small sources — most of them the 96×96 SiteOne og:image
// thumbnail — while the very same product page carried a 1200×1200 copy of
// the SAME picture. Restoring the larger native copy is a matter of image
// resolution only. It is kept strictly apart from photo/evidence approval:
//
//   THE RULE (restorationDecision — one place, every caller)
//   A stored image may be restored deterministically when ALL are true:
//     - its native size is under 800 px on the longest side;
//     - the proposed copy is 800 px or more on the longest side;
//     - the proposed copy is on the SAME stored source page;
//     - it belongs to the same picture family (photo-quality.familyKeyOf);
//     - the same-picture correlation is ≥ 0.98 (RESTORE_SIMILARITY_MIN);
//     - it has strictly more native pixels;
//     - it is the file the page serves — we never upscale anything;
//     - no model, finder or web search is involved (this file has none).
//   On this path — and only this path — a soft or blurry grade does NOT
//   block: a soft 1200px original beats a 96px derivative of the same file.
//   The grade is still measured and recorded on the restored image. The
//   quality gate for NEW or DIFFERENT candidate images is untouched.
//   A larger same-family copy that correlates under 0.98 (the Rain Bird
//   store's padded squares against their unpadded originals) is HELD for
//   Patrick's eye, never restored automatically.
//
//   WHAT IT COVERS
//     live photos        the group's photo (kind "live")
//     review candidates  the candidates shown on To-be-determined and
//                        Not-confident cards (kind "candidate") — the same
//                        selection the Review tab shows (photo-review
//                        .visibleCandidates), so what Patrick reviews is
//                        what gets restored.
//
//   WHAT APPLYING CHANGES
//     live       the group's photo hash → the larger copy. Tier, approvedBy,
//                approvedAt, links, fitting and the AI result untouched;
//                the old hash goes to the history (part-photos
//                .upgradePhotoQuality).
//     candidate  that ONE candidate's image asset. Its tier, its evidence
//                checks, its place in the list, the group's tier, reason,
//                AI result, links and approvals are untouched: a TBD
//                candidate stays TBD, a Not-confident one stays Not
//                confident (part-photos.restoreCandidateImage).
//   Only for the exact list the plan showed; a record that changed since
//   the plan was built is skipped, never overwritten.
//
//   A HELD ROW PATRICK CONFIRMED BY EYE (Oct 2 2026 — restoreHeld)
//   VB7RND, 000001 and ESPSM3 were held: the same Rain Bird file, stored
//   on a padded square canvas, against its unpadded original. He compared
//   each pair and confirmed the same photograph. For that ONE row, on his
//   say, the held copy goes through the very same swap as Apply (swapImage)
//   — so page provenance, approval, tier, links and history are kept, and
//   the record notes it was confirmed by eye with the measured match. The
//   0.98 line, the correlation and the plan are not changed by this door.

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { writeJsonAtomic, serialize } = require("./atomic-json");
const pq = require("./photo-quality");
const ev = require("./photo-evidence");
const { visibleCandidates } = require("./photo-review");

const SIMILARITY_MIN = 0.85;          // below: not the same picture at all
const RESTORE_SIMILARITY_MIN = 0.98;  // at or above: deterministic restoration
const MAX_MEMBERS_TRIED = 3;
const SHOWABLE = new Set(["approved", "confident"]);
const REVIEW_TIERS = new Set(["tbd", "not_confident"]);

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

// THE rule. `current` and `proposed` are native dimensions; `proposed.quality`
// is the gate's grade of the proposed file (recorded, never a blocker here).
// Returns { restore, held, reason }.
function restorationDecision({ current, proposed, similarity: sim }) {
  const cw = Number(current && current.width) || 0, ch = Number(current && current.height) || 0;
  const pw = Number(proposed && proposed.width) || 0, ph = Number(proposed && proposed.height) || 0;
  const dims = `${pw}×${ph}`;
  if (Math.max(cw, ch) >= pq.MIN_LONGEST) return { restore: false, held: false, reason: "the stored image is already 800 px or more" };
  if (!pw || !ph) return { restore: false, held: false, reason: "the larger copy has no readable dimensions" };
  if (!(pw * ph > cw * ch)) return { restore: false, held: false, reason: "not larger than the stored image" };
  if (Math.max(pw, ph) < pq.MIN_LONGEST) return { restore: false, held: false, reason: `still under ${pq.MIN_LONGEST} px (${dims})` };
  if (!(sim >= SIMILARITY_MIN)) return { restore: false, held: false, reason: `doesn't match the stored picture (match ${Number(sim).toFixed(2)})` };
  if (sim < RESTORE_SIMILARITY_MIN) return { restore: false, held: true, reason: `probably the same picture (match ${sim.toFixed(3)}), but under the ${RESTORE_SIMILARITY_MIN} line — held for your eye` };
  const q = proposed.quality;
  const soft = q && q.grade !== "good" && q.grade !== "ok" ? ` — the source itself is ${/blurry/.test(q.reason || "") ? "blurry" : "soft"}, recorded` : "";
  return { restore: true, held: false, reason: `same picture (match ${sim.toFixed(3)}), ${dims}${soft}` };
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
  const nativeOf = (rec) => {
    const s = rec && (rec.source && rec.source.width ? rec.source : rec.imageSource);
    return { width: (s && s.width) || (rec && rec.width) || 0, height: (s && s.height) || (rec && rec.height) || 0 };
  };
  const longestOf = (rec) => { const n = nativeOf(rec); return Math.max(n.width, n.height); };
  const isLive = (g) => !!(g && g.photo && g.photo.hash && SHOWABLE.has(g.tier));

  // Every stored image under the threshold that the plan considers: live
  // photos, then the review candidates the Review tab shows.
  async function candidates() {
    const { groups, links } = await store.snapshot();
    const parts = getParts() || {};
    const membersOf = {};
    for (const [sku, l] of Object.entries(links || {})) (membersOf[l.groupId] ||= []).push(sku);
    const out = [];
    for (const [groupId, g] of Object.entries(groups || {})) {
      const members = (membersOf[groupId] || []).filter((s) => parts[s]).sort();
      if (!members.length) continue;
      if (isLive(g)) {
        const skus = members.filter((s) => parts[s].photoState === "verified");
        if (!skus.length) continue;
        const native = nativeOf(g.photo);
        if (Math.max(native.width, native.height) >= pq.MIN_LONGEST) continue;
        const src = g.source || {};
        out.push({ kind: "live", id: groupId, groupId, skus, label: g.label || skus[0], hash: g.photo.hash, native, imageUrl: src.imageUrl || null, pageUrl: src.pageUrl || null, domain: src.domain || null, method: src.method || null,
          keep: { tier: g.tier, approvedBy: g.approvedBy || null, approvedAt: g.approvedAt || null } });
      } else if (g.ai && REVIEW_TIERS.has(g.tier)) {
        for (const c of visibleCandidates(g)) {
          if (longestOf(c) >= pq.MIN_LONGEST) continue;
          const src = c.source || {};
          out.push({ kind: "candidate", id: `${groupId}:${c.hash}`, groupId, skus: members, label: g.label || members[0], hash: c.hash, native: nativeOf(c), imageUrl: src.imageUrl || null, pageUrl: src.pageUrl || null, domain: src.domain || null, method: "ai-candidate",
            keep: { groupTier: g.tier, candidateTier: c.tier || null } });
        }
      }
    }
    return out;
  }

  async function planOne(t) {
    const row = {
      id: t.id, kind: t.kind, groupId: t.groupId, skus: t.skus, label: t.label,
      current: { hash: t.hash, width: t.native.width || null, height: t.native.height || null, longest: Math.max(t.native.width, t.native.height), method: t.method, imageUrl: t.imageUrl, pageUrl: t.pageUrl, domain: t.domain, ...t.keep },
      decision: "review", reason: "", upgrade: null, held: null, tried: []
    };
    if (!t.pageUrl || !t.imageUrl) { row.reason = t.method === "upload" ? "uploaded by hand — no product page on record" : "no product page on record for this image"; return row; }
    let page;
    try { page = await fetchPage(t.pageUrl); }
    catch (err) { row.reason = `the product page couldn't be read (${String(err.message || err).slice(0, 80)})`; return row; }
    const pageUrl = page.finalUrl || t.pageUrl;
    const family = pq.familyKeyOf(t.imageUrl);
    if (!family) { row.reason = "the stored image URL has no recognisable picture family"; return row; }
    const curHint = pq.imageUrlHints(t.imageUrl).sizeHint;
    // Only images the stored source page itself exposes, only this picture's family.
    const members = pq.collectImageUrls(page.html, pageUrl, { skip: ev.IMG_SKIP })
      .filter((u) => u !== t.imageUrl && pq.familyKeyOf(u) === family)
      .sort((a, b) => pq.imageUrlHints(b).sizeHint - pq.imageUrlHints(a).sizeHint)
      // A member the URL says is smaller is not worth a download; one the
      // URL says nothing about is — the measurement decides.
      .filter((u) => { const h = pq.imageUrlHints(u).sizeHint; return h === 0 || h >= curHint; })
      .slice(0, MAX_MEMBERS_TRIED);
    if (!members.length) { row.reason = "the product page exposes no larger copy of this picture"; return row; }
    let current;
    try { current = await store.readCandidateImage(t.hash, 160); }
    catch { row.reason = "the stored image's file is missing"; return row; }
    for (const url of members) {
      const tr = { url, width: null, height: null, grade: null, similarity: null, note: "" };
      row.tried.push(tr);
      let img;
      try { img = await fetchImage(url); } catch (err) { tr.note = `download failed (${String(err.message || err).slice(0, 60)})`; continue; }
      const look = await store.inspect(img.buffer);
      tr.width = look.width; tr.height = look.height; tr.grade = look.quality.grade;
      const sim = await similarity(current, img.buffer, sharp);
      tr.similarity = +sim.toFixed(3);
      const d = restorationDecision({ current: t.native, proposed: { width: look.width, height: look.height, quality: look.quality }, similarity: sim });
      tr.note = d.reason;
      if (!d.restore && !d.held) continue;
      // Stored (content-addressed, not live, not a candidate) so the Review
      // tab can show before/after; never enlarged by processImage.
      const saved = await store.saveCandidateImage(img.buffer);
      const proposal = { hash: saved.hash, imageUrl: img.finalUrl || url, width: saved.width, height: saved.height, sizes: saved.sizes, source: saved.imageSource, sharpness: saved.sharpness, quality: saved.quality, similarity: tr.similarity };
      if (d.restore) { row.upgrade = proposal; row.decision = "upgrade"; row.reason = d.reason; return row; }
      if (!row.held) row.held = { ...proposal, reason: d.reason };
    }
    row.reason = row.held ? row.held.reason : `no usable larger copy: ${row.tried.map((x) => x.note).filter(Boolean).join("; ") || "nothing passed"}`;
    return row;
  }

  // Build (or rebuild) the plan. Slow (one page and 1–3 images per image),
  // so it runs once and is cached; `progress` is readable while it runs.
  async function buildPlan({ by = null } = {}) {
    await load();
    if (building) return building;
    building = (async () => {
      const list = await candidates();
      const id = "QU-" + new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(2).toString("hex");
      state.plan = { id, by, status: "building", at: new Date(now()).toISOString(), total: list.length, done: 0, rows: [] };
      await save();
      for (const t of list) {
        let row;
        try { row = await planOne(t); }
        catch (err) { row = { id: t.id, kind: t.kind, groupId: t.groupId, skus: t.skus, label: t.label, current: { hash: t.hash, longest: Math.max(t.native.width, t.native.height), ...t.keep }, decision: "review", reason: `error: ${String(err.message || err).slice(0, 120)}`, upgrade: null, held: null, tried: [] }; }
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
    const of = (kind, decision) => rows.filter((r) => (r.kind || "live") === kind && r.decision === decision).length;
    return {
      total: plan ? plan.total : 0, planned: rows.length,
      upgrade: rows.filter((r) => r.decision === "upgrade").length, review: rows.filter((r) => r.decision === "review").length,
      held: rows.filter((r) => r.decision === "review" && r.held).length,
      live: { upgrade: of("live", "upgrade"), review: of("live", "review") },
      candidates: { upgrade: of("candidate", "upgrade"), review: of("candidate", "review") }
    };
  }
  // Rows still meaningful now. An upgrade row whose stored image has since
  // changed is dropped; a review row Patrick has already answered is dropped.
  async function summary() {
    await load();
    const plan = state.plan;
    if (!plan) return { plan: null, upgrades: [], review: [], counts: counts(null) };
    const { groups } = await store.snapshot();
    const stillThere = (r) => {
      const g = groups[r.groupId];
      if (!g) return false;
      if ((r.kind || "live") === "live") return isLive(g) && g.photo.hash === r.current.hash;
      return !isLive(g) && REVIEW_TIERS.has(g.tier) && visibleCandidates(g).some((c) => c.hash === r.current.hash);
    };
    const upgrades = plan.rows.filter((r) => r.decision === "upgrade" && !r.applied && stillThere(r));
    const review = plan.rows.filter((r) => r.decision === "review" && !r.applied && stillThere(r) && !(state.reviewed || {})[r.id || r.groupId]);
    return {
      plan: { id: plan.id, by: plan.by, status: plan.status, at: plan.at, finishedAt: plan.finishedAt || null, total: plan.total, done: plan.done, building: !!building },
      counts: { ...counts(plan), applicable: upgrades.length, applicableLive: upgrades.filter((r) => (r.kind || "live") === "live").length, applicableCandidates: upgrades.filter((r) => r.kind === "candidate").length, openReview: review.length, applied: plan.rows.filter((r) => r.applied).length, confirmed: plan.rows.filter((r) => r.applied && r.applied.basis === "visual").length },
      upgrades, review
    };
  }

  // THE swap, for both doors (Apply and restoreHeld): the row's stored image
  // becomes `proposal`, and only the image changes (see the header).
  // `confirmed` is set only when Patrick's eye, not the 0.98 line, decided.
  function swapImage(r, proposal, by, confirmed = null) {
    const args = { fromHash: r.current.hash, to: proposal, imageUrl: proposal.imageUrl, by, ...(confirmed ? { confirmed } : {}) };
    return (r.kind || "live") === "live" ? store.upgradePhotoQuality(r.groupId, args) : store.restoreCandidateImage(r.groupId, args);
  }
  const appliedRecord = (r, proposal) => ({ id: r.id || r.groupId, kind: r.kind || "live", groupId: r.groupId, skus: r.skus, from: { hash: r.current.hash, longest: r.current.longest }, to: { hash: proposal.hash, width: proposal.source.width, height: proposal.source.height, grade: proposal.quality.grade } });

  // Apply the deterministic restorations — exactly the hashes the plan
  // shows, in its order, or nothing.
  async function apply({ by = null, hashes = null } = {}) {
    const s = await summary();
    const expected = s.upgrades.map((r) => r.upgrade.hash);
    if (!expected.length) throw new Error("There are no deterministic upgrades to apply.");
    if (!Array.isArray(hashes) || JSON.stringify(hashes.map(String)) !== JSON.stringify(expected)) {
      throw new Error("The upgrade list differs from the plan shown — reload the plan and confirm the exact list.");
    }
    const applied = [], skipped = [];
    for (const r of s.upgrades) {
      const res = await swapImage(r, r.upgrade, by);
      if (res.skipped) { skipped.push({ id: r.id || r.groupId, kind: r.kind || "live", groupId: r.groupId, reason: res.skipped }); continue; }
      const row = state.plan.rows.find((x) => (x.id || x.groupId) === (r.id || r.groupId));
      if (row) row.applied = { by, at: new Date(now()).toISOString() };
      applied.push(appliedRecord(r, r.upgrade));
    }
    await save();
    log({ action: "quality-upgrade.apply", by, applied: applied.length, skipped: skipped.length });
    return { applied, skipped };
  }

  // "Same photo — use the larger copy": ONE held row, on Patrick's say after
  // he compared the two images. `hash` must be the held copy the card
  // showed. A row he already kept, a row whose stored image has changed
  // since the plan, and a row with no held copy are all refused — nothing
  // is ever overwritten. Never called for a list; never automatic.
  async function restoreHeld(id, { by = null, hash = null } = {}) {
    const s = await summary();
    const r = s.review.find((x) => (x.id || x.groupId) === id);
    if (!r) throw new Error("That photo isn't in the quality review queue.");
    if (!r.held || !r.held.hash) throw new Error("No larger copy is held for that photo — there is nothing to restore.");
    if (String(hash || "") !== r.held.hash) throw new Error("The larger copy differs from the one shown — reload and confirm again.");
    const confirmed = { basis: "visual", similarity: r.held.similarity };
    const res = await swapImage(r, r.held, by, confirmed);
    if (res.skipped) throw new Error(`Nothing was changed: ${res.skipped}.`);
    const row = state.plan.rows.find((x) => (x.id || x.groupId) === id);
    if (row) row.applied = { by, at: new Date(now()).toISOString(), basis: "visual" };
    await save();
    log({ action: "quality-upgrade.restore-held", id, by, similarity: r.held.similarity });
    return { ...appliedRecord(r, r.held), ...confirmed };
  }

  // "Keep as is" for a review row; `id` is the row id (the group id for a
  // live photo, "<group>:<hash>" for a candidate).
  async function resolveReview(id, { action, by = null }) {
    await load();
    if (action !== "keep") throw new Error("Unknown action.");
    if (!state.plan || !state.plan.rows.some((r) => (r.id || r.groupId) === id && r.decision === "review")) throw new Error("That photo isn't in the quality review queue.");
    (state.reviewed ||= {})[id] = { action, by, at: new Date(now()).toISOString() };
    await save();
    log({ action: "quality-upgrade.review.keep", id, by });
    return state.reviewed[id];
  }

  return { load, candidates, buildPlan, summary, apply, restoreHeld, resolveReview, similarity: (a, b) => similarity(a, b, sharp), SIMILARITY_MIN, RESTORE_SIMILARITY_MIN, _state: () => state };
}

module.exports = { createQualityUpgrade, similarity, restorationDecision, SIMILARITY_MIN, RESTORE_SIMILARITY_MIN };

// Photo Review queues (P-PJL-35 M3b) — what the Review tab on
// Materials → Part photos shows. Pure: reads the merged catalog and the
// photo stores, decides nothing about photos (photoStateFor already did).
//
//   tbd           AI result waiting for Patrick (includes Confident while
//                 auto-approve was off, and photos sent back for re-checking)
//   notConfident  the AI found nothing reliable (Patrick can still upload)
//   autoApproved  live photos that went live automatically, newest first —
//                 the "Recently auto-approved" glance
//   fittings      open same-fitting proposals from the backfill runs
//
// One card per photo GROUP (a fitting), shown on the SKU the AI searched
// for, with every SKU that shares the group listed.

const AUTO_APPROVED_LIMIT = 60;

function supplierSkusOf(part) {
  return [...new Set(Object.values(part.supplierPrices || {}).map((v) => v && v.supplierSku).filter(Boolean))];
}

function partCard(part) {
  return {
    sku: part.sku, partNumber: part.partNumber || "", description: part.description || "", size: part.size || "",
    manufacturer: part.manufacturer || "", category: part.category || "", supplierSkus: supplierSkusOf(part),
    photoState: part.photoState || "none", photo: part.photo || null
  };
}

function candidateCard(c) {
  const s = c.source || {};
  return {
    hash: c.hash, width: c.width || null, height: c.height || null, tier: c.tier || null,
    source: { domain: s.domain || "", pageUrl: s.pageUrl || "", pass: s.pass || null, official: !!s.official },
    checks: c.checks || {}
  };
}

function buildReviewQueues({ parts, groups, links, fittings = [], photoUrl }) {
  const out = { tbd: [], notConfident: [], needsResearch: [], autoApproved: [], fittings: [] };
  const membersOf = {};
  for (const [sku, l] of Object.entries(links || {})) (membersOf[l.groupId] ||= []).push(sku);
  for (const [groupId, g] of Object.entries(groups || {})) {
    if (!g.ai) continue; // only fittings the AI has worked on
    const members = (membersOf[groupId] || []).filter((s) => parts[s]).sort();
    if (!members.length) continue;
    const sku = members.includes(g.ai.forSku) ? g.ai.forSku : members[0];
    const part = parts[sku];
    const rejected = new Set(g.rejectedHashes || []);
    const card = {
      groupId, sku, part: partCard(part), also: members.filter((s) => s !== sku).map((s) => partCard(parts[s])),
      tier: g.tier || "none", kind: g.ai.kind || null, aiTier: g.ai.tier || null, proposedBrand: g.ai.proposedBrand || null,
      pages: Array.isArray(g.ai.pages) ? g.ai.pages : [],
      reason: g.reason || g.ai.reason || "", identified: g.ai.identified || null, runId: g.ai.runId || null, at: g.updatedAt || g.ai.at || null,
      candidates: (g.candidates || []).filter((c) => !rejected.has(c.hash)).slice(-3).reverse().map(candidateCard),
      photo: g.photo ? { hash: g.photo.hash, url: photoUrl ? photoUrl(g.photo.hash) : null } : null,
      approvedBy: g.approvedBy || null, approvedAt: g.approvedAt || null
    };
    const live = part.photoState === "verified";
    if (live && String(g.approvedBy || "").startsWith("auto:")) out.autoApproved.push(card);
    else if (!live && g.tier === "tbd") out.tbd.push(card);
    else if (!live && g.tier === "not_confident") out.notConfident.push(card);
    else if (!live && g.tier === "needs_research") out.needsResearch.push(card);
  }
  const byAt = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
  out.tbd.sort((a, b) => (b.candidates.length ? 1 : 0) - (a.candidates.length ? 1 : 0) || a.sku.localeCompare(b.sku));
  out.notConfident.sort((a, b) => a.sku.localeCompare(b.sku));
  out.needsResearch.sort((a, b) => a.sku.localeCompare(b.sku));
  out.autoApproved.sort((a, b) => String(b.approvedAt || "").localeCompare(String(a.approvedAt || "")));
  out.autoApproved = out.autoApproved.slice(0, AUTO_APPROVED_LIMIT);
  for (const f of fittings) {
    if (f.status !== "open" || !parts[f.a] || !parts[f.b]) continue;
    const side = (sku) => {
      const g = links[sku] && groups[links[sku].groupId];
      const live = parts[sku].photoState === "verified" && parts[sku].photo;
      const best = !live && g && (g.candidates || []).length ? g.candidates[g.candidates.length - 1] : null;
      return { ...partCard(parts[sku]), groupId: links[sku] ? links[sku].groupId : null,
        preview: live ? { kind: "live", hash: g && g.photo ? g.photo.hash : null } : best ? { kind: "candidate", hash: best.hash } : null };
    };
    out.fittings.push({ id: f.id, reason: f.reason, at: f.at, a: side(f.a), b: side(f.b) });
  }
  out.fittings.sort(byAt);
  return out;
}

module.exports = { buildReviewQueues, AUTO_APPROVED_LIMIT };

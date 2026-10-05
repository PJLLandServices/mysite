// Deleting and re-filing one work-order photo (PJL-110, PJL-111).
//
// Pure functions over a work order; the routes in server.js run them under
// the per-work-order photo lock (field-photo-uploads.run) and write the
// result. Nothing here touches disk.
//
// DELETE IS FOR GOOD (Patrick, 2026-10-04: hard delete). The file goes and
// the photo leaves wo.photos, so every reader that lists wo.photos — the
// customer report, the status-update email strip, the daily record, the
// admin and tech pages, the portal — stops showing it with no change of
// its own. What stays is a TOMBSTONE in wo.removedPhotos: { n,
// clientUploadId, removedAt, by }, no bytes. It is what keeps the deletion
// true afterwards:
//   - a photo NUMBER is never handed out again (nextBaseN). Numbers are
//     baked into signed email links and the report's cached derivative
//     (<n>@1400.jpeg); reusing one showed the deleted photo's cached copy,
//     or a stranger photo behind an old link.
//   - an upload with a deleted clientUploadId is ignored (field-photo-
//     uploads.newPhotos), so a phone that retries an upload it already
//     deleted can never bring the photo back (the in-flight race).
// References held outside wo.photos — findings copied to the property
// (deferred photoIds) — are cleared by the route, in the same lock.

const ZONE_LABEL = /^zone_\d+$/;

// THE rule for "is this photo on the work order", by number or by the
// phone's upload id. One function, so the delete route, the move route and
// the phone's retries cannot disagree about which photo is meant.
function findPhoto(wo, { n = null, clientUploadId = null } = {}) {
  const photos = Array.isArray(wo?.photos) ? wo.photos : [];
  if (clientUploadId) {
    const byUpload = photos.find((p) => p.clientUploadId === clientUploadId);
    if (byUpload) return byUpload;
  }
  if (n != null && Number.isFinite(Number(n))) return photos.find((p) => Number(p.n) === Number(n)) || null;
  return null;
}

function wasRemoved(wo, { n = null, clientUploadId = null } = {}) {
  const removed = Array.isArray(wo?.removedPhotos) ? wo.removedPhotos : [];
  return removed.some((r) => (clientUploadId && r.clientUploadId === clientUploadId)
    || (n != null && r.n != null && Number(r.n) === Number(n)));
}

// The highest photo number this work order has EVER used, removed ones
// included. New photos are numbered after it.
function nextBaseN(wo) {
  const all = [...(Array.isArray(wo?.photos) ? wo.photos : []), ...(Array.isArray(wo?.removedPhotos) ? wo.removedPhotos : [])];
  return all.reduce((max, p) => Math.max(max, Number(p?.n) || 0), 0);
}

// The zones a photo may be filed under: the visit's own zone rows (not the
// valve-box or controller rows, which are not zones a customer reads).
function visitZoneNumbers(wo) {
  return (Array.isArray(wo?.zones) ? wo.zones : [])
    .filter((z) => (z?.kind || "zone") === "zone" && Number.isFinite(Number(z?.number)) && Number(z.number) > 0)
    .map((z) => Number(z.number));
}

const whereLabel = (zoneNumber) => (zoneNumber == null ? "whole visit" : `Zone ${zoneNumber}`);
const zoneOf = (photo) => (Number.isFinite(Number(photo?.zoneNumber)) && Number(photo.zoneNumber) > 0 ? Number(photo.zoneNumber) : null);

// The finding a photo is attached to, and the zone that finding is in.
function findingOf(wo, issueId) {
  if (!issueId) return null;
  for (const z of Array.isArray(wo?.zones) ? wo.zones : []) {
    const issue = (z.issues || []).find((i) => i.id === issueId);
    if (issue) return { issue, zoneNumber: Number(z.number) };
  }
  return null;
}

// Returns { photo, photos, removedPhotos, alreadyRemoved, note }.
// `photo` is the meta that was removed (null when there was nothing to
// remove). An unknown or already-removed photo is not an error: a queued
// delete that is retried after a lost response must acknowledge cleanly.
// A delete by upload id for a photo that never arrived still leaves its
// tombstone, so the upload cannot land afterwards.
function removePhoto(wo, ref, { at = new Date().toISOString(), by = "tech" } = {}) {
  const photos = Array.isArray(wo?.photos) ? wo.photos : [];
  const removedPhotos = Array.isArray(wo?.removedPhotos) ? wo.removedPhotos : [];
  const photo = findPhoto(wo, ref);
  if (!photo) {
    const known = wasRemoved(wo, ref);
    const tombstone = !known && ref.clientUploadId ? [{ n: null, clientUploadId: ref.clientUploadId, removedAt: at, by }] : [];
    return { photo: null, photos, removedPhotos: [...removedPhotos, ...tombstone], alreadyRemoved: true, note: null };
  }
  const zone = zoneOf(photo);
  return {
    photo,
    photos: photos.filter((p) => p !== photo),
    removedPhotos: [...removedPhotos, { n: Number(photo.n), clientUploadId: photo.clientUploadId || null, removedAt: at, by }],
    alreadyRemoved: false,
    note: `Removed photo #${photo.n} (${whereLabel(zone)}, ${photo.category || "general"})`
  };
}

// Re-file a photo under another zone of this visit, or the whole visit
// (zoneNumber null). Same file, same number, same signed links.
// A photo attached to a finding in another zone comes off the finding
// (Patrick, D-A3: detach and say so) — `detached` names it.
// Returns { error } | { photo, photos, from, to, unchanged, detached, note }.
function movePhoto(wo, ref, zoneNumber) {
  const to = zoneNumber == null || zoneNumber === "" ? null : Number(zoneNumber);
  if (to !== null && !(Number.isInteger(to) && visitZoneNumbers(wo).includes(to))) {
    return { error: "zone_not_on_visit", message: `Zone ${zoneNumber} is not on this visit.` };
  }
  const photo = findPhoto(wo, ref);
  if (!photo) return wasRemoved(wo, ref) ? { alreadyRemoved: true } : { error: "photo_not_found", message: "Photo not found." };
  const from = zoneOf(photo);
  const finding = findingOf(wo, photo.issueId);
  const detach = finding && finding.zoneNumber !== to ? finding : null;
  if (from === to && !detach) return { photo, photos: wo.photos, from, to, unchanged: true, detached: null, note: null };
  const moved = { ...photo, zoneNumber: to };
  if (to === null) delete moved.zoneNumber;
  // The label is the zone's own tag (zone_3); a label the tech or office
  // wrote (water_off, a caption) is theirs and stays.
  if (ZONE_LABEL.test(String(photo.label || ""))) {
    if (to === null) delete moved.label;
    else moved.label = `zone_${to}`;
  }
  if (detach) delete moved.issueId;
  const photos = wo.photos.map((p) => (p === photo ? moved : p));
  const detached = detach ? { issueId: detach.issue.id, type: detach.issue.type || null, deferredId: detach.issue.deferredId || null } : null;
  return {
    photo: moved, photos, from, to, unchanged: false, detached,
    note: `Moved photo #${photo.n} from ${whereLabel(from)} to ${whereLabel(to)}${detached ? `; taken off the ${detached.type || "finding"} finding` : ""}`
  };
}

// A finding copied to the property (deferred entry) lists its photos by
// number. Returns the entry's photoIds without `n`, or null when `n` is
// not among them (nothing to write).
function photoIdsWithout(entry, n) {
  const ids = Array.isArray(entry?.photoIds) ? entry.photoIds : [];
  const kept = ids.filter((x) => Number(x) !== Number(n));
  return kept.length === ids.length ? null : kept;
}

module.exports = { findPhoto, wasRemoved, nextBaseN, visitZoneNumbers, removePhoto, movePhoto, photoIdsWithout };

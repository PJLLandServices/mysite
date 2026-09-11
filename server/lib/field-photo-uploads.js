// A persisted client id makes a lost upload response safe to retry. The
// per-work-order lock prevents two requests from selecting the same photo n.
const locks = new Map();
async function run(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  locks.set(id, current);
  try { return await current; }
  finally { if (locks.get(id) === current) locks.delete(id); }
}
function newPhotos(photos, existing) {
  if (!Array.isArray(photos)) return photos; // Existing validator reports it.
  const seen = new Set(existing.map(p => p.clientUploadId).filter(Boolean));
  return photos.filter(p => {
    if (!p?.clientUploadId) return true;
    if (typeof p.clientUploadId !== 'string' || !/^field-[a-zA-Z0-9-]{1,100}$/.test(p.clientUploadId)) {
      throw new Error('Invalid field photo upload identifier.');
    }
    if (seen.has(p.clientUploadId)) return false;
    seen.add(p.clientUploadId);
    return true;
  });
}
module.exports = { run, newPhotos };

// When the closing screen shows its yellow sync notice.
//
// Every tap records on the phone first and then uploads, so for a moment
// one change is always "pending". Showing the notice for that made it slide
// in and out on every tap and the screen jump (Patrick, 2026-09-25). The
// queue records an error for a key only when an upload attempt fails, and
// clears it on success (offline/queue.mjs), so "pending with an error" is
// exactly "the upload did not go through" — the only time the notice has
// something to say. The header's "On phone · N pending" covers the normal
// wait, in place. Covered by scripts/test-closing-sync-notice.mjs.
//
//   'conflict' — the office changed the same thing: Keep mine / Use office's
//   'pending'  — recorded here but not uploaded: no signal, sign-in, refusal
//   null       — nothing to say
export function syncNoticeFor(state) {
  if (!state) return null;
  if (state.error?.code === 'conflict') return 'conflict';
  if (state.pending > 0 && state.error) return 'pending';
  return null;
}

// Finish's button while it sends what is left (PJL-113): what, and how
// much, counting down as it goes — never a bare spinner. `p` is
// queue.progress (offline/field.js fieldProgress).
const mbText = bytes => (bytes >= 100000 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
export function finishProgressText(p) {
  if (!p || (!p.photos && !p.changes)) return 'Finishing…';
  const parts = [];
  if (p.photos) parts.push(`Uploading ${p.photos} photo${p.photos === 1 ? '' : 's'}${p.bytes ? ` · ${mbText(p.bytes)} left` : ''}`);
  if (p.changes) parts.push(`${p.photos ? '' : 'Sending '}${p.changes} change${p.changes === 1 ? '' : 's'}`);
  return `${parts.join(' · ')}…`;
}

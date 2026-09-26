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

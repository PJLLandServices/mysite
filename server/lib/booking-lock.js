// ONE process-wide async mutex for everything that reserves calendar
// capacity: the public/admin reserve route, the slot-hold route, and the
// lead→booking heal sweep.
//
// WHY. Reserve is "read leads → decide the slot is free → write leads →
// write customers → write properties → write bookings", each step a
// separate read-modify-write of a JSON file. Two requests interleaving
// through that chain both see the slot free, both write, and the second
// writer's leads.json silently drops the first's lead. Six concurrent
// POSTs on one slot produced six 201s, two leads and one booking record
// (reproduced 2026-09-09). Node is single-threaded but every `await` is
// a yield; the only cure is to make the whole chain one critical section.
//
// The lock is a promise chain (same shape as parts.js's withLock). It is
// NOT re-entrant: nothing inside a locked section may call withBookingLock
// again, or it deadlocks. Keep network work (geocode, Distance Matrix)
// OUTSIDE the section where possible so the queue drains quickly.
//
// One Render container is the only consumer, so an in-process lock is the
// whole story. If PJL ever runs two instances this becomes a file lock.
let chain = Promise.resolve();
let depth = 0;

function withBookingLock(fn) {
  const run = chain.then(async () => {
    depth += 1;
    try { return await fn(); } finally { depth -= 1; }
  });
  chain = run.catch(() => {});
  return run;
}

// Diagnostics for tests: true while a section is executing.
function isLocked() { return depth > 0; }

module.exports = { withBookingLock, isLocked };

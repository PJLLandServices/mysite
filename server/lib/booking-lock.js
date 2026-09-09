// server/lib/booking-lock.js
//
// One booking at a time.
//
// Reserve reads leads.json, appends, writes it back; then does the same for
// customers, properties and bookings. Nothing held the file in between, so
// two requests in flight both read the same array, both append their own row,
// and the second write erased the first. Six simultaneous reserves on one
// slot returned six HTTP 201s and left two leads and one canonical booking:
// four customers told "you're booked" who were not in the system at all
// (measured 2026-09-09, scripts/test-booking-concurrency.mjs).
//
// The server is a single Node process, so a promise-chain mutex is enough —
// there is no second instance to coordinate with. If PJL ever runs more than
// one web instance this has to become a real lock (a lockfile with O_EXCL, or
// a database), and that is a load-bearing assumption worth stating out loud.
//
// HELD FOR THE WHOLE REQUEST, not just the write. The check ("is this slot
// still free?") and the act ("take it") have to be one indivisible step, or
// the check is just a slower guess.
//
// A stuck handler must never take bookings down with it: every acquisition
// carries a watchdog that releases the lock and logs loudly if a holder
// overruns. A double-booking is bad; a booking page that has stopped
// accepting anyone at all, silently, during an ad campaign, is worse.

const DEFAULT_TIMEOUT_MS = 20000;

function createLock(name = "lock", { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let tail = Promise.resolve();
  let held = 0;

  // Resolves once it is this caller's turn. The returned function is the
  // release, and it is safe to call more than once.
  function acquire() {
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const wait = tail.then(() => {
      held += 1;
      let done = false;
      const watchdog = setTimeout(() => {
        if (done) return;
        console.error(`[${name}] holder overran ${timeoutMs}ms — releasing so bookings keep working`);
        done = true;
        release();
      }, timeoutMs);
      if (typeof watchdog.unref === "function") watchdog.unref();
      return () => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        held -= 1;
        release();
      };
    });
    tail = tail.then(() => mine, () => mine);
    return wait;
  }

  // The reserve handler returns from a dozen places and throws from more, so
  // an explicit finally around it would mean re-indenting several hundred
  // lines of live booking code. Tying the release to the response instead is
  // both smaller and harder to get wrong: every path out of an HTTP handler
  // ends with the response closing, including the ones that throw.
  async function holdUntilResponse(res) {
    const release = await acquire();
    let released = false;
    const once = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", once);
    res.once("close", once);
    return once;
  }

  return { acquire, holdUntilResponse, get depth() { return held; } };
}

module.exports = { createLock, DEFAULT_TIMEOUT_MS };

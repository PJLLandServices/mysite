// scripts/lib/delay-scope-hold.cjs
//
// TEST PRELOAD. Slows the invoice-hold write by a fixed amount so the
// race that hid behind machine speed becomes deterministic.
//
// The scope-hold defect was invisible on a fast disk: the work order's
// route replied while `invoices.setScopeHold()` was still in flight, and
// the write usually landed before anything looked. Under CI load it did
// not, and for that window an invoice the system had reported as held
// was still payable.
//
// Rather than test that with a stopwatch and hope, this makes the hold
// write take PJL_DELAY_SCOPE_HOLD_MS milliseconds. If the route does not
// await it, the response returns first, every time, on every machine.
// If it does await it, the response cannot come back sooner than the
// delay. Either way the answer is the same on a loaded CI runner and on
// a quiet laptop.
//
// Preloaded with --require (or NODE_OPTIONS) ahead of server.js, and a
// no-op unless the env var is set, so it cannot affect anything else.

const path = require("node:path");

const ms = Number(process.env.PJL_DELAY_SCOPE_HOLD_MS || 0);
if (Number.isFinite(ms) && ms > 0) {
  // process.argv[1] is the server.js this preload was attached to, which
  // may be a temp-dir copy — resolve the lib beside it so we patch the
  // very module instance the server will use, not a second copy.
  const invoicesPath = path.join(path.dirname(process.argv[1]), "lib", "invoices.js");
  const invoices = require(invoicesPath);
  const real = invoices.setScopeHold;
  if (typeof real === "function") {
    invoices.setScopeHold = async function delayedSetScopeHold(...args) {
      await new Promise((r) => setTimeout(r, ms));
      return real.apply(this, args);
    };
  }
}

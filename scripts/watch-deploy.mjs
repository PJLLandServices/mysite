#!/usr/bin/env node
// scripts/watch-deploy.mjs
//
// Measure a Render deploy from the outside.
//
// The service has a persistent disk, so there is no zero-downtime
// swap: the old instance must fully let go before the new one starts.
// That means the customer-visible outage IS the deploy gap Patrick was
// chasing — the ~5m40s between "Deploying" and "Running npm start".
//
// Polls /healthz and reports:
//
//   * when the live instance last answered 200 (old version serving)
//   * whether it ever answers 503 "shutting down" — which is the
//     SIGTERM handler RUNNING IN PRODUCTION. Before the fix it could
//     not, because the signal never reached node: the old instance
//     served 200 right up until Render force-killed it. Seeing a 503,
//     or a clean drop straight after one, is the fix working on the
//     real box rather than on a laptop.
//   * the outage window, and when the new instance answers again
//
// It cannot read the Render dashboard's own "Deploying" / "Running npm
// start" timestamps — those need the dashboard. This measures the thing
// those timestamps bracket.
//
// Run: node scripts/watch-deploy.mjs [--url https://…] [--minutes 15]

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const URL_BASE = argOf("--url", "https://www.pjllandservices.com");
const MAX_MIN = Number(argOf("--minutes", "15"));
const HEALTH = `${URL_BASE.replace(/\/$/, "")}/healthz`;
const POLL_MS = 1000;

const stamp = () => new Date().toLocaleTimeString("en-CA", { hour12: false });
const secs = (ms) => (ms / 1000).toFixed(1) + "s";

async function probe() {
  const t0 = Date.now();
  try {
    const r = await fetch(HEALTH, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const body = (await r.text()).trim().slice(0, 40);
    return { status: r.status, body, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, body: String(err?.name || err?.message || "unreachable"), ms: Date.now() - t0 };
  }
}

console.log(`watching ${HEALTH}`);
console.log(`polling every ${POLL_MS}ms for up to ${MAX_MIN} minutes — deploy now\n`);

let lastState = null;
let healthyUntil = null;     // last moment the OLD instance answered 200
let drainSeenAt = null;      // first 503 "shutting down"
let downFrom = null;         // first non-200
let backAt = null;
const deadline = Date.now() + MAX_MIN * 60000;

while (Date.now() < deadline) {
  const r = await probe();
  const state = r.status === 200 ? "up" : r.status === 503 ? "draining" : "down";

  if (state !== lastState) {
    console.log(`${stamp()}  ${state.toUpperCase().padEnd(8)} status=${r.status} ${r.body ? `"${r.body}"` : ""}`);
    if (state === "draining" && !drainSeenAt) {
      drainSeenAt = Date.now();
      console.log("           ^ the SIGTERM handler is running on the real instance");
    }
    if (state !== "up" && !downFrom) downFrom = Date.now();
    if (state === "up" && downFrom && !backAt) {
      backAt = Date.now();
      console.log(`\n=== back up after ${secs(backAt - downFrom)} ===`);
      if (drainSeenAt) {
        console.log("    a 503 \"shutting down\" was seen — the SIGTERM handler RAN on the real instance");
      } else {
        console.log("    NO 503 seen — the instance went straight from 200 to unreachable,");
        console.log("    which is what an instance that never received SIGTERM looks like");
      }
      console.log(`    the app itself listens in under a second once started`);
      // Deliberately NOT compared against the 5m40s from the Render log:
      // that figure is "Deploying" to "Running npm start", a different
      // window from the outside-visible outage measured here. Compare
      // runs of THIS script against each other, which is why the
      // verification is two deploys measured the same way.
      console.log("    compare this against another run of this script, not against the Render log\n");
      break;
    }
    lastState = state;
  }
  if (state === "up") healthyUntil = Date.now();
  await new Promise((r2) => setTimeout(r2, POLL_MS));
}

if (!downFrom) {
  console.log(`\nNo outage seen in ${MAX_MIN} minutes — either the deploy has not started yet, or it finished between polls.`);
} else if (!backAt) {
  console.log(`\nStill down after ${secs(Date.now() - downFrom)} — that is longer than expected; check the Render logs.`);
}

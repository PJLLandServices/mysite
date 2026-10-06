#!/usr/bin/env node
// scripts/test-memory-log.mjs
//
// Tests for server/lib/memory-log.js — the `[mem]` lines that let an
// out-of-memory restart be traced to a climb or to a request.
//
// Isolation: a fake clock and a fake memory reading. Starts no server and
// no timer.
//
// Run: node scripts/test-memory-log.mjs  (also in `npm run build:check`)

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createMemoryLog, routeLabel } = require("../server/lib/memory-log.js");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const MB = 1024 * 1024;
function rig() {
  const state = { rss: 200 * MB, t: 0, lines: [] };
  const mem = createMemoryLog({
    memoryUsage: () => ({ rss: state.rss, heapUsed: 80 * MB, external: 10 * MB }),
    now: () => state.t,
    log: (line) => state.lines.push(line)
  });
  return { state, mem };
}

// 1. Heartbeat: first sample, then once a minute, not every sample.
{
  const { state, mem } = rig();
  mem.sample();
  for (let i = 1; i <= 12; i++) { state.t = i * 5000; mem.sample(); }
  const beats = state.lines.filter((l) => /^\[mem\] rss=/.test(l));
  check("heartbeat prints on the first sample and again after a minute", beats.length === 2, JSON.stringify(state.lines));
  check("heartbeat carries rss, heap, external and open count", beats[0] === "[mem] rss=200MB heap=80MB external=10MB open=0", beats[0]);
}

// 2. Jump: a rise between two samples names the open requests.
{
  const { state, mem } = rig();
  mem.sample();
  mem.requestStarted("post", "/api/work-orders/WO-2026-0123/photos");
  state.t = 5000; state.rss = 290 * MB;
  mem.sample();
  const jump = state.lines.find((l) => l.includes("jump"));
  check("a jump is logged with its size", !!jump && jump.includes("jump +90MB"), jump);
  check("a jump names the open request and its age", !!jump && jump.includes("POST /api/work-orders/WO-2026-0123/photos (5s)"), jump);
}

// 3. A jump with nothing open says so, rather than printing an empty list.
{
  const { state, mem } = rig();
  mem.sample();
  state.t = 5000; state.rss = 260 * MB;
  mem.sample();
  check("a jump with no open request points at background work", state.lines.some((l) => l.includes("open: none (background work)")), JSON.stringify(state.lines));
}

// 4. A small rise is not a jump.
{
  const { state, mem } = rig();
  mem.sample();
  state.t = 5000; state.rss = 220 * MB;
  mem.sample();
  check("a rise under the threshold is not logged as a jump", !state.lines.some((l) => l.includes("jump")));
}

// 5. Heavy request: logged at finish, once, and only when memory grew.
{
  const { state, mem } = rig();
  const done = mem.requestStarted("POST", "/api/work-orders/WO-1/photos");
  state.t = 3200; state.rss = 285 * MB;
  done(); done();
  const heavy = state.lines.filter((l) => l.includes("heavy request"));
  check("a request that grew memory is logged once", heavy.length === 1, JSON.stringify(state.lines));
  check("the heavy line names the route, growth and duration", heavy[0]?.includes("POST /api/work-orders/WO-1/photos +85MB in 3.2s"), heavy[0]);
  check("a finished request is no longer open", mem.openCount() === 0);

  const quiet = mem.requestStarted("GET", "/healthz");
  quiet();
  check("a request that did not grow memory logs nothing", state.lines.filter((l) => l.includes("heavy request")).length === 1);
}

// 6. Tokens never reach the log; short ids do; the query string never does.
{
  const label = routeLabel("get", "/approve/3f9a8c1e7b2d4f6a9c0e1b2d3f4a5b6c7d8e");
  check("a long opaque path segment is masked", label === "GET /approve/:token", label);
  check("a short id is kept", routeLabel("GET", "/api/work-orders/WO-2026-0123") === "GET /api/work-orders/WO-2026-0123");
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nmemory-log: all checks passed");

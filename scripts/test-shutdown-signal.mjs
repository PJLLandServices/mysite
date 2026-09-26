#!/usr/bin/env node
// scripts/test-shutdown-signal.mjs
//
// SIGTERM HAS TO REACH NODE, OR THE DEPLOY WAITS OUT THE WHOLE GRACE.
//
// THE SYMPTOM Patrick brought: a deploy that used to finish in about 97
// seconds started taking 6–7 minutes. The build was not slow — cache 6s,
// npm install 448ms, build 28s. The gap was ~5m40s between Render
// printing "Deploying" and running npm start, and once npm start ran the
// app listened in under a second.
//
// THE CAUSE, measured rather than guessed. Render signals the
// container's entry process, which is `npm start`. With
//
//     "start": "node server/server.js"
//
// npm runs that through a shell, so the tree is
//
//     npm  →  sh -c "node server/server.js"  →  node
//
// npm forwards SIGTERM to its DIRECT child. That child is the shell,
// which dies without passing it on, and node is re-parented to init and
// keeps running — measured: still alive after 30s, still answering HTTP
// 200, and its own shutdown handler never logged a line because it
// never got the signal. This service has a persistent disk, so Render
// cannot start the new instance until the old one lets go: it waits out
// the configured shutdown grace and then SIGKILLs. A 300s grace plus
// boot is the ~5m40s.
//
// THE FIX is one word:
//
//     "start": "exec node server/server.js"
//
// `exec` REPLACES the shell with node, so node is npm's direct child and
// gets the signal. The graceful handler in server.js was always correct
// — it drains connections, clears the sweeps, finishes queued store
// writes and exits, well inside 8s. It simply never ran.
//
// WHAT THIS TEST PINS. Not the shape of package.json — the BEHAVIOUR:
// send SIGTERM to `npm start` the way Render does, and node must
// actually receive it and exit promptly. It fails on the old script
// (node survives 30s, zero shutdown lines) and passes on the new one
// (exits in ~0.1s, having logged its drain).
//
// Run: node scripts/test-shutdown-signal.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4869;
const WAIT_MS = 15000;   // far longer than the app's own 8s grace

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The node server, found by an EXACT /proc cmdline match so nothing
// matches this script's own command line. (An earlier version of this
// probe used `pgrep -f`, which matched itself and reported every
// variant as a survivor — a test that could not fail.)
function serverPids() {
  const out = [];
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let raw;
    try { raw = fs.readFileSync(`/proc/${e}/cmdline`, "utf8"); } catch { continue; }
    const parts = raw.split("\0").filter(Boolean);
    if (parts.length === 2 && /(^|\/)node$/.test(parts[0]) && parts[1] === "server/server.js") {
      out.push(Number(e));
    }
  }
  return out;
}

if (!fs.existsSync("/proc/self/cmdline")) {
  console.log("  skip  this check reads /proc, which this platform does not provide");
  console.log("\nshutdown signal: skipped");
  process.exit(0);
}

const logPath = path.join(os.tmpdir(), `pjl-shutdown-probe-${process.pid}.log`);
const logFd = fs.openSync(logPath, "w");
let child = null;

try {
  // The start script as it actually ships — this is the thing under test.
  const startScript = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.start;
  console.log(`  (start script under test: ${JSON.stringify(startScript)})`);

  child = spawn("npm", ["start"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", logFd, logFd]
  });

  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    await sleep(200);
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch { /* booting */ }
  }
  ok("the server comes up under `npm start`", up);

  const pids = serverPids();
  const nodePid = pids[0];
  ok("...as exactly one node process", pids.length === 1 && Boolean(nodePid), `pids: ${JSON.stringify(pids)}`);

  // node's parent should BE npm. If a shell sits between them, npm's
  // forwarded SIGTERM dies with the shell.
  let parentPid = null;
  if (nodePid) {
    const stat = fs.readFileSync(`/proc/${nodePid}/stat`, "utf8");
    parentPid = Number((stat.split(") ")[1] || "").split(" ")[1]);
  }
  ok("node is npm's DIRECT child, with no shell in between",
    parentPid === child.pid,
    `node's parent is ${parentPid}, npm is ${child.pid} — a shell in between swallows the signal`);

  // What Render does: signal the entry process.
  const t0 = Date.now();
  process.kill(child.pid, "SIGTERM");

  let alive = true;
  for (let i = 0; i < WAIT_MS / 100 && alive; i++) {
    await sleep(100);
    alive = nodePid ? serverPids().includes(nodePid) : false;
  }
  const elapsed = (Date.now() - t0) / 1000;

  ok("SIGTERM to `npm start` actually stops the server",
    !alive,
    `node still alive ${WAIT_MS / 1000}s after SIGTERM — on Render this is what makes the platform wait out the whole shutdown grace before it can start the new instance`);
  ok(`...and promptly (${elapsed.toFixed(2)}s, well inside the 8s grace)`,
    !alive && elapsed < 10, `took ${elapsed.toFixed(2)}s`);

  const log = fs.readFileSync(logPath, "utf8");
  ok("the server's own shutdown handler ran",
    /\[shutdown\] SIGTERM received/.test(log),
    "no [shutdown] line — the signal never reached node");
  ok("...and it exited through the graceful path, not a timeout",
    /\[shutdown\] exiting/.test(log) || /all connections closed/.test(log),
    log.split("\n").filter((l) => l.includes("[shutdown]")).join(" | ") || "(no shutdown lines)");
  ok("...and nothing is left listening",
    await fetch(`http://127.0.0.1:${PORT}/api/booking/services`).then(() => false).catch(() => true));
} finally {
  for (const p of serverPids()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  if (child) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  try { fs.closeSync(logFd); } catch { /* already closed */ }
  try { fs.rmSync(logPath, { force: true }); } catch { /* fine */ }
}

console.log(`\nshutdown signal: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

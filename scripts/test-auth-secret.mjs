#!/usr/bin/env node
// scripts/test-auth-secret.mjs
//
// "The server would not accept the session cookie it just issued."
//
// That line came out of `scripts/purge-test-data.mjs` on CI, intermittently,
// including on a run of main itself (run 517, e9d0cad). It was read as a
// flaky test. It is not: it is what a fresh install does.
//
// `readAuthConfig()` is called on EVERY request that touches a session, and
// it mints a session secret when auth.json has not got one. It minted a NEW
// random secret per call. On a store without one, several requests arrive
// before the first write lands — each generating its own, each writing it,
// the last write winning and retroactively invalidating every cookie signed
// with any of the others.
//
// The fix is that the generated secret is held for the life of the process.
// So the property to pin is not "ten concurrent logins survive" — that is a
// race, and a test of a race is a coin toss on a loaded CI box. It is the
// thing underneath: ASKING TWICE GIVES THE SAME ANSWER. If it does, no
// number of concurrent callers can disagree; if it does not, they always
// eventually will.
//
// Three assertions, all deterministic, all driving the real server:
//   1. A secret-less store gets one written on the first request that
//      touches a session.
//   2. That write keeps the rest of auth.json instead of replacing the file
//      with a single key.
//   3. Emptying the secret and asking again returns the SAME secret.
//
// 2 and 3 both fail on the unfixed server. Run:
//   node scripts/test-auth-secret.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const AUTH = path.join(DATA, "auth.json");
const PORT = 4799;
const KEEP = "do not lose this";

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// auth.json is the real one, not a fixture. Put it back exactly as found,
// pass or fail.
const original = fs.existsSync(AUTH) ? fs.readFileSync(AUTH, "utf8") : null;
const restore = () => {
  if (original === null) fs.rmSync(AUTH, { force: true });
  else fs.writeFileSync(AUTH, original, "utf8");
};

// A store that has everything EXCEPT a secret. The neighbouring key is how
// assertion 2 catches the write that used to replace the whole file.
const emptyTheSecret = () =>
  fs.writeFileSync(AUTH, JSON.stringify({ keepMe: KEEP }, null, 2) + "\n", "utf8");

// One request that reaches readAuthConfig, then wait for the write it
// triggers. `/api/session` qualifies with no cookie at all — readSession
// reads the config before it looks for one. Booting the server does NOT
// read auth.json, and neither does the public readiness probe, so without
// this there is no first-run write to inspect.
async function touchSessionPath() {
  await fetch(`http://127.0.0.1:${PORT}/api/session`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      const parsed = JSON.parse(fs.readFileSync(AUTH, "utf8"));
      if (parsed.sessionSecret) return parsed;
    } catch { /* mid-write — look again */ }
  }
  return null;
}

let server;
try {
  fs.mkdirSync(DATA, { recursive: true });
  emptyTheSecret();

  server = spawn("node", [path.join(ROOT, "server", "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  server.stdout.on("data", (d) => { logs += d; });
  server.stderr.on("data", (d) => { logs += d; });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch { /* not yet */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // ---- 1 + 2. The first-run write ----------------------------------------
  const first = await touchSessionPath();
  ok("a secret-less store gets one written on the first session request",
    first !== null && typeof first.sessionSecret === "string" && first.sessionSecret.length > 0,
    "no sessionSecret appeared in auth.json");
  ok("the first-run write keeps the rest of auth.json",
    first !== null && first.keepMe === KEEP,
    "the generated secret was written over the whole file");

  // ---- 3. Asking twice gives the same answer -----------------------------
  //
  // The whole bug in one assertion. Sequential, so there is no race to lose:
  // if the second answer differs from the first, then two callers racing the
  // first write get different secrets, and whichever writes last silently
  // invalidates the other's cookies. The unfixed server mints a fresh
  // random secret here every time.
  emptyTheSecret();
  const second = await touchSessionPath();
  ok("asking again returns the secret already issued, not a new one",
    first !== null && second !== null && second.sessionSecret === first.sessionSecret,
    first && second
      ? `first ${String(first.sessionSecret).slice(0, 8)}… then ${String(second.sessionSecret).slice(0, 8)}… — cookies signed with the first no longer verify`
      : "no secret to compare");
} catch (err) {
  failures.push(`harness: ${err.message}`);
} finally {
  if (server) server.kill();
  restore();
}

if (failures.length) {
  console.log(`\n✗ test-auth-secret: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n✓ test-auth-secret: ${passed} assertions passed`);

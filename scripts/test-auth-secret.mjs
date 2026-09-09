#!/usr/bin/env node
// scripts/test-auth-secret.mjs
//
// "The server would not accept the session cookie it just issued."
//
// That line came out of `scripts/purge-test-data.mjs` on CI, intermittently,
// on a run of main itself — and it is not a test artefact. It is what a
// fresh install does.
//
// `readAuthConfig()` is read on EVERY request that touches a session, and
// it mints a session secret when auth.json has not got one. It minted a
// NEW random secret per call. On a fresh store several requests arrive
// before the first write lands, so each generates its own, each writes it,
// and the last write wins — retroactively invalidating every cookie signed
// with any of the others. The user is handed a session that stops
// verifying a moment later, with nothing in the logs to say why.
//
// Two assertions, both driving the real server over HTTP:
//   1. The first-run write keeps the rest of auth.json instead of
//      replacing the file with a single key.
//   2. Cookies issued concurrently, with no secret on disk, all still
//      verify — they were all signed with the same one.
//
// Both fail on the unfixed server. Run:
//   node scripts/test-auth-secret.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const AUTH = path.join(DATA, "auth.json");
const USERS = path.join(DATA, "users.json");
const require2 = createRequire(path.join(ROOT, "package.json"));
const PORT = 4799;

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// Anything we move aside goes back, pass or fail — this is the real data
// directory, not a fixture copy.
const saved = new Map();
for (const f of [AUTH, USERS]) {
  saved.set(f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
}
const restore = () => {
  for (const [f, body] of saved) {
    if (body === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, body, "utf8");
  }
};

const EMAIL = "auth-race@local.test";
const PASSWORD = "local-auth-race-pass-123";

let server;
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(USERS, "[]\n", "utf8");
  // A fresh install: no secret yet, but the file is NOT empty — the
  // neighbouring key is how assertion 2 catches the clobbering write.
  fs.writeFileSync(AUTH, JSON.stringify({ keepMe: "do not lose this" }, null, 2) + "\n", "utf8");

  const users = require2(path.join(ROOT, "server", "lib", "users.js"));
  await users.create({ email: EMAIL, name: "Auth Race", role: "admin", password: PASSWORD });

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

  // ---- 1. The first-run write keeps the rest of the file -----------------
  //
  // Checked here, in the quiet after boot, rather than at the end: the
  // second phase deliberately rewrites this file, and a test that reads it
  // back while the server may be part-way through its own write is testing
  // its own race, not the server's.
  //
  // ONE request first, and it has to be one that touches a session —
  // booting the server does not read auth.json, and neither does the public
  // readiness probe above, so without this the file is still untouched and
  // there is no first-run write to inspect.
  await fetch(`http://127.0.0.1:${PORT}/api/session`);
  await new Promise((r) => setTimeout(r, 300));
  const firstRun = JSON.parse(fs.readFileSync(AUTH, "utf8"));
  ok("a session secret was persisted on first run",
    typeof firstRun.sessionSecret === "string" && firstRun.sessionSecret.length > 0);
  ok("the first-run write keeps the rest of auth.json",
    firstRun.keepMe === "do not lose this",
    "the generated secret was written over the whole file");

  // ---- 2. Concurrent logins with no secret on disk -----------------------
  //
  // Empty the secret HERE, with the server already up and its first-run
  // write settled — the readiness polls above are requests too, and one of
  // them persisting a secret closes the window this is trying to open.
  fs.writeFileSync(AUTH, JSON.stringify({ keepMe: "do not lose this" }, null, 2) + "\n", "utf8");
  //
  // Ten at once, because one at a time never races. Every cookie handed out
  // has to still verify afterwards: they cannot have been signed with
  // different secrets.
  const logins = await Promise.all(Array.from({ length: 10 }, () => fetch(
    `http://127.0.0.1:${PORT}/api/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    }
  )));
  const cookies = logins.map((r) => (r.headers.get("set-cookie") || "").split(";")[0]).filter(Boolean);
  ok("every concurrent login is answered with a session cookie",
    cookies.length === 10, `${cookies.length} of 10`);

  const verdicts = await Promise.all(cookies.map(async (cookie) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { cookie } });
    const body = await res.json().catch(() => ({}));
    return body.authenticated === true;
  }));
  const accepted = verdicts.filter(Boolean).length;
  ok("the server accepts every session cookie it just issued",
    accepted === cookies.length,
    `${accepted} of ${cookies.length} verified — the rest were signed with a secret that was overwritten`);

  // And the store settled on exactly one secret.
  const after = JSON.parse(fs.readFileSync(AUTH, "utf8"));
  ok("a session secret is on disk after the burst",
    typeof after.sessionSecret === "string" && after.sessionSecret.length > 0);
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

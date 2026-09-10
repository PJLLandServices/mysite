#!/usr/bin/env node
// scripts/test-session-stores-atomic.mjs
//
// "The server refuses the session cookie it just issued."
//
// scripts/test-auth-secret.mjs caught half of this: readAuthConfig() used
// to mint a NEW session secret per call, so concurrent callers disagreed
// about how a cookie was signed. That was fixed by holding one secret for
// the life of the process. The symptom did not go away — CI kept
// producing a login that succeeds followed by 401s on every request after
// it (test-booking-lifecycle, run 34353768853: four × "ERR:401" on the
// tech's day list, with the login assertion in the SAME block passing).
//
// The other half is the WRITE, in the two stores every gated request
// reads:
//
//   users.json — requireUser()/requireAdmin() re-read the user store on
//     every request so a disabled account loses access immediately. And
//     /api/login fires users.recordLogin() WITHOUT awaiting it, so a
//     write to users.json is in flight at exactly the moment the client
//     makes its next request. `fs.writeFile` truncates the destination
//     and then fills it: a reader landing in that window gets "" and
//     JSON.parse("" || "[]") hands it an EMPTY USER LIST. The session is
//     valid, the signature verifies, and the user has vanished — 401.
//
//   auth.json — same non-atomic write for the session secret itself. A
//     truncated read there is worse than transient: readAuthConfig() sees
//     no secret, mints one, and WRITES IT, so every cookie already issued
//     is invalid from then on. That is the four-in-a-row shape.
//
// The fix is the one lib/atomic-json.js already applies to bookings,
// customers, properties and leads (2026-09-09, PR #176): write a temp
// file, then rename. A rename is atomic — a reader sees the whole old
// file or the whole new one, never a hole. These two stores were simply
// missed.
//
// WHAT IS PINNED, and why it is not a coin toss. Two properties:
//   1. Deterministic — the update LANDS BY RENAME. The destination file's
//      inode changes across a write. An in-place truncate-and-fill keeps
//      the same inode, so this fails on the old code every time.
//   2. End-to-end — log in and immediately drive a session-gated endpoint,
//      repeatedly, while recordLogin's write is in flight. No request may
//      come back 401. This is the CI failure itself.
//
// Run: node scripts/test-session-stores-atomic.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const USERS = path.join(DATA, "users.json");
const AUTH = path.join(DATA, "auth.json");
const PORT = 4801;
const KEEP = "do not lose this";

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
// Both files are the real ones, not fixtures. Put them back exactly as
// found, pass or fail.
const backups = new Map();
for (const p of [USERS, AUTH]) backups.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
const restore = () => {
  for (const [p, buf] of backups) {
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
};

const inode = (p) => fs.statSync(p).ino;
const seedUsers = (n) => {
  const many = Array.from({ length: n }, (_, i) => ({
    id: `USR-${String(i + 1).padStart(3, "0")}`,
    email: `atomicity-probe-${i}@local.test`,
    name: `Probe ${i}`,
    role: "tech",
    passwordHash: "h".repeat(88),
    passwordSalt: "s".repeat(24),
    disabled: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastLoginAt: null
  }));
  fs.writeFileSync(USERS, JSON.stringify(many, null, 2) + "\n", "utf8");
};

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  const require2 = createRequire(import.meta.url);
  const users = require2(path.join(ROOT, "server", "lib", "users.js"));

  // ---- 1. users.json lands by rename ---------------------------------
  // recordLogin() is the write /api/login fires and does not await. It
  // must replace the file, not hollow it out and refill it.
  seedUsers(40);
  const beforeIno = inode(USERS);
  await users.recordLogin("USR-001");
  ok("a users.json write replaces the file instead of truncating it",
    inode(USERS) !== beforeIno, "same inode — the store was written in place");
  ok("…and the store still holds every user", JSON.parse(fs.readFileSync(USERS, "utf8")).length === 40);

  // ---- 2. no reader ever sees an empty user store --------------------
  // The gate calls users.get() on EVERY request. If one read in a
  // thousand comes back empty, one request in a thousand is a 401 on a
  // perfectly good session — and the customer sees a login screen.
  {
    let sawMissing = 0;
    let reads = 0;
    for (let round = 0; round < 300; round++) {
      const writing = users.recordLogin("USR-001");
      const seen = await Promise.all(Array.from({ length: 8 }, () => users.get("USR-002")));
      await writing;
      for (const u of seen) { reads += 1; if (!u) sawMissing += 1; }
    }
    ok("a user never disappears while the store is being written",
      sawMissing === 0, `${sawMissing} of ${reads} reads found no user`);
  }

  // ---- 2b. two writes in the same tick both land ---------------------
  // The temp file writeJsonAtomic renames into place used to be named
  // pid + Date.now(). Two writes to one store in the same millisecond
  // therefore picked the SAME temp path: both wrote it, the first renamed
  // it away, and the second's rename failed ENOENT and threw. writeLeads()
  // does not catch, so that is a lead or a booking lost to two requests
  // landing in the same tick. Measured on the old suffix: 372 of 600.
  {
    const { writeJsonAtomic } = require2(path.join(ROOT, "server", "lib", "atomic-json.js"));
    const scratch = path.join(DATA, "atomicity-probe-store.json");
    let rejected = 0;
    let writes = 0;
    try {
      for (let round = 0; round < 60; round++) {
        const results = await Promise.allSettled([
          writeJsonAtomic(scratch, { round, writer: "a" }),
          writeJsonAtomic(scratch, { round, writer: "b" }),
          writeJsonAtomic(scratch, { round, writer: "c" })
        ]);
        for (const r of results) { writes += 1; if (r.status === "rejected") rejected += 1; }
      }
      ok("concurrent writes to one store all succeed",
        rejected === 0, `${rejected} of ${writes} writes threw`);
      ok("…leaving one whole, parseable file",
        Boolean(JSON.parse(fs.readFileSync(scratch, "utf8")).writer));
      ok("…and no temp files behind",
        fs.readdirSync(DATA).filter((f) => f.endsWith(".tmp")).length === 0);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }

  // ---- 3. auth.json lands by rename ----------------------------------
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  {
    // A store that has everything EXCEPT a secret, so the next
    // session-touching request writes one. /api/session reaches
    // readAuthConfig with no cookie at all.
    fs.writeFileSync(AUTH, JSON.stringify({ keepMe: KEEP }, null, 2) + "\n", "utf8");
    const beforeAuthIno = inode(AUTH);
    await fetch(`http://127.0.0.1:${PORT}/api/session`);
    let parsed = null;
    for (let i = 0; i < 40 && !parsed?.sessionSecret; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try { parsed = JSON.parse(fs.readFileSync(AUTH, "utf8")); } catch { /* mid-write */ }
    }
    ok("the session secret gets written", Boolean(parsed?.sessionSecret));
    ok("an auth.json write replaces the file instead of truncating it",
      inode(AUTH) !== beforeAuthIno, "same inode — the secret store was written in place");
    ok("…keeping the rest of auth.json", parsed?.keepMe === KEEP);
  }

  // ---- 4. the CI failure itself --------------------------------------
  // A valid session, driven against a session-gated endpoint while a
  // write to users.json is in flight — which is what /api/login leaves
  // behind every time, since it fires recordLogin() without awaiting it.
  // The gate re-reads the user store on every request, so a truncated
  // read there is a 401 on a perfectly good cookie. Every request must be
  // answered; none may be refused. This is test-booking-lifecycle's
  // section 4, hammered.
  //
  // ONE login, deliberately: /api/login is rate-limited to 10 attempts per
  // IP, and a suite that trips its own rate limiter would be measuring
  // that instead of this.
  {
    fs.writeFileSync(USERS, "[]\n", "utf8");
    const probe = await users.create({
      email: "atomicity-probe@local.test", name: "Atomicity Probe",
      role: "admin", password: "atomicity-probe-1234"
    });
    const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "atomicity-probe@local.test", password: "atomicity-probe-1234" })
    });
    const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
      .map((c) => String(c).split(";")[0])
      .find((c) => c.startsWith("pjl_crm_session=")) || "";
    ok("the throwaway admin logs in", login.ok && Boolean(cookie), `${login.status}`);

    const day = "2026-10-06";
    let refused = 0;
    let requests = 0;
    for (let round = 0; round < 120 && cookie; round++) {
      const writing = users.recordLogin(probe.id);
      const answers = await Promise.all(Array.from({ length: 6 }, () =>
        fetch(`http://127.0.0.1:${PORT}/api/schedule/today?date=${day}`, { headers: { cookie } })
          .then((r) => r.status)));
      await writing;
      for (const status of answers) { requests += 1; if (status === 401) refused += 1; }
    }
    ok("the server never refuses the session cookie it just issued",
      refused === 0, `${refused} of ${requests} gated requests came back 401`);
  }
} finally {
  child.kill("SIGKILL");
  restore();
}

if (failures.length) {
  console.error(`\n✗ test-session-stores-atomic: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-session-stores-atomic: ${passed} assertions passed`);

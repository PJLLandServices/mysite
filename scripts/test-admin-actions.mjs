// Admin action log — what it records, what it deliberately does not, and
// the source guards on the hook that feeds it.
//
//   node scripts/test-admin-actions.mjs
//
// WHAT THIS COVERS. The log exists so that with more than one operator on
// the CRM — a second tech, or an agent acting from the field — the system
// can say who changed what. That is only true if the guarantees below
// hold, so each is pinned here:
//
//   1. State-changing requests are recorded; reads are not.
//   2. The log NEVER holds a request body, a query string, or an email.
//      It is a record of what was called, not a second copy of the
//      customer database. Identifying strings are seeded into the inputs
//      so the privacy assertions have something real to catch.
//   3. Appends are appends — an entry is never rewritten, and a torn line
//      costs one entry rather than the file.
//   4. record() never throws, whatever it is handed. A log failure must
//      not be able to fail a request.
//   5. Source guards on the wiring: the hook sits inside the auth gate
//      (the one place with a resolved session), it is fire-and-forget, it
//      reads ip/user-agent synchronously, and the read route is admin-
//      gated twice. Each fails the build if removed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const actions = require(path.join(ROOT, "server/lib/admin-actions.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Seeded into every input below, so a leak has something to catch on.
const SECRETS = {
  email: "randy.state@example.invalid",
  phone: "905-555-0148",
  name: "Randy State",
  street: "88 Kingsmere Avenue",
  token: "sk-live-notarealtoken-abcdef123456"
};

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-actions-"));
const DATA_DIR = path.join(SANDBOX, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const read = (file) =>
  fs.readFileSync(path.join(DATA_DIR, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---- 1. Mutating vs read ---------------------------------------------

for (const m of ["POST", "PATCH", "PUT", "DELETE", "post", "delete"]) {
  ok(`${m} is mutating`, actions.isMutating(m) === true);
}
for (const m of ["GET", "HEAD", "OPTIONS", "", null, undefined]) {
  ok(`${String(m)} is not mutating`, actions.isMutating(m) === false);
}

{
  const written = await actions.record(
    { uid: "u1", role: "admin", method: "GET", pathname: "/api/invoices" },
    { dataDir: DATA_DIR }
  );
  ok("a GET writes nothing", written === null);
  ok("no log file created by a read", fs.readdirSync(DATA_DIR).length === 0);
}

// ---- 2. What a real entry holds --------------------------------------

{
  const entry = await actions.record({
    uid: "u_patrick",
    role: "admin",
    method: "PATCH",
    // A query string carrying a token + an email, exactly what must not
    // survive into the log.
    pathname: `/api/properties/P-2026-0040?token=${SECRETS.token}&q=${encodeURIComponent(SECRETS.email)}`,
    status: 200,
    ms: 42,
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0 (iPhone)"
  }, { dataDir: DATA_DIR });

  ok("a mutating request is recorded", entry !== null);
  ok("actor uid recorded", entry.uid === "u_patrick");
  ok("role recorded", entry.role === "admin");
  ok("method recorded", entry.method === "PATCH");
  ok("status recorded", entry.status === 200);
  ok("ok derived from status", entry.ok === true);
  ok("duration recorded", entry.ms === 42);
  ok("ip recorded", entry.ip === "203.0.113.9");

  ok("query string stripped from the path", entry.path === "/api/properties/P-2026-0040", entry.path);
  ok("record id extracted", entry.ref === "P-2026-0040", String(entry.ref));

  const serialized = JSON.stringify(entry);
  for (const [label, secret] of Object.entries(SECRETS)) {
    ok(`no ${label} in the entry`, !serialized.includes(secret));
  }

  const onDisk = fs.readFileSync(path.join(DATA_DIR, actions.fileNameForDate(new Date())), "utf8");
  for (const [label, secret] of Object.entries(SECRETS)) {
    ok(`no ${label} on disk`, !onDisk.includes(secret));
  }
}

// ---- 3. Failures are recorded too, and derive ok:false ----------------

{
  const entry = await actions.record({
    uid: "u_tech", role: "tech", method: "POST",
    pathname: "/api/work-orders/8f3a1b2c-1111-4222-8333-444455556666/service-fee-waiver",
    status: 403
  }, { dataDir: DATA_DIR });
  ok("a refused request is still logged", entry !== null);
  ok("a 403 derives ok:false", entry.ok === false);
  ok("uuid extracted as the record id",
    entry.ref === "8f3a1b2c-1111-4222-8333-444455556666", String(entry.ref));
}

// ---- 4. Appends are appends ------------------------------------------

{
  const file = actions.fileNameForDate(new Date());
  const before = read(file);
  await actions.record({ uid: "u1", role: "admin", method: "DELETE", pathname: "/api/properties/P-2026-0056", status: 200 }, { dataDir: DATA_DIR });
  const after = read(file);
  ok("append adds exactly one line", after.length === before.length + 1);
  ok("earlier entries are byte-identical after an append",
    JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before));
  ok("the module exposes no way to delete or edit an entry",
    typeof actions.remove === "undefined" && typeof actions.update === "undefined" &&
    typeof actions.clear === "undefined" && typeof actions.truncate === "undefined");
}

// ---- 5. record() never throws ----------------------------------------

{
  const nasty = [
    { method: "POST" },                                    // nothing else
    { method: "POST", pathname: null },
    { method: "POST", pathname: "/x", status: "not-a-number" },
    { method: "POST", pathname: "/x", ms: NaN },
    { method: "POST", pathname: "/x".repeat(5000) },
    {}
  ];
  let threw = false;
  for (const input of nasty) {
    try { await actions.record(input, { dataDir: DATA_DIR }); }
    catch (_) { threw = true; }
  }
  ok("record() never throws on malformed input", threw === false);

  // A regular file used as a directory — fails with ENOTDIR immediately.
  // (Deliberately not a path under /proc: mkdir there BLOCKS rather than
  // erroring in some sandboxes, which hangs the suite instead of testing
  // it.)
  const notADir = path.join(SANDBOX, "i-am-a-file");
  fs.writeFileSync(notADir, "x", "utf8");
  let unwritable = false;
  let unwritableResult = "not set";
  try {
    unwritableResult = await actions.record(
      { method: "POST", pathname: "/x", status: 200 },
      { dataDir: notADir }
    );
  } catch (_) { unwritable = true; }
  ok("record() swallows an unwritable directory", unwritable === false);
  ok("an unwritable directory returns null", unwritableResult === null);

  const longPath = await actions.record(
    { method: "POST", pathname: `/api/${"z".repeat(5000)}`, status: 200 },
    { dataDir: DATA_DIR }
  );
  ok("an absurd path is truncated, not stored whole", longPath.path.length <= 300);
}

// ---- 6. Reading back --------------------------------------------------

{
  const all = await actions.list({ dataDir: DATA_DIR, limit: 100 });
  ok("list returns entries", all.length > 0);
  ok("newest first", all.length < 2 || all[0].ts >= all[1].ts);

  const byRef = await actions.list({ dataDir: DATA_DIR, ref: "P-2026-0056" });
  ok("filter by record id", byRef.length === 1 && byRef[0].method === "DELETE");

  const byUid = await actions.list({ dataDir: DATA_DIR, uid: "u_tech" });
  ok("filter by actor", byUid.length === 1 && byUid[0].role === "tech");

  const byPath = await actions.list({ dataDir: DATA_DIR, pathContains: "/api/properties" });
  ok("filter by path substring", byPath.length === 2, String(byPath.length));

  ok("limit is capped", (await actions.list({ dataDir: DATA_DIR, limit: 999999 })).length <= 2000);
}

// A torn final line — an append interrupted mid-write — must cost one
// entry, not the file. This is the whole reason for JSONL over a JSON
// array, so it gets an explicit test.
{
  const file = path.join(DATA_DIR, actions.fileNameForDate(new Date()));
  const goodCount = (await actions.list({ dataDir: DATA_DIR, limit: 2000 })).length;
  fs.appendFileSync(file, '{"ts":"2026-08-29T00:00:00.000Z","uid":"u1","meth', "utf8");
  const afterTear = await actions.list({ dataDir: DATA_DIR, limit: 2000 });
  ok("a torn line is skipped, the rest survive", afterTear.length === goodCount, String(afterTear.length));
}

{
  const empty = await actions.list({ dataDir: path.join(SANDBOX, "nope") });
  ok("a missing log directory reads as empty, not an error", Array.isArray(empty) && empty.length === 0);
}

// ---- 7. Monthly rollover ---------------------------------------------

{
  const jan = actions.fileNameForDate(new Date("2026-01-15T00:00:00Z"));
  const feb = actions.fileNameForDate(new Date("2026-02-01T00:00:00Z"));
  ok("file name is per month", jan === "admin-actions-2026-01.jsonl", jan);
  ok("a new month is a new file", jan !== feb);
  ok("months are zero-padded", actions.fileNameForDate(new Date("2026-09-01T00:00:00Z")) === "admin-actions-2026-09.jsonl");
}

// ---- 8. Source guards on the wiring ----------------------------------
//
// The lib being correct is not enough — it has to actually be called, from
// the right place, in the right way. These read server.js.

{
  const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");

  ok("the hook is wired in", server.includes("adminActions.record({"));
  ok("the lib is required", server.includes('require("./lib/admin-actions")'));

  // The hook must sit AFTER the gate resolves a session — that is what
  // makes an actor available at all. If it drifts above the gate, the
  // session is not resolved yet and every entry loses its uid.
  // Anchored on the success-path hook's own comment, not on
  // `isMutating(req.method)` — the refusal logger below uses that same
  // call, so a bare search finds the wrong block.
  const gateIdx = server.indexOf("const requiredLevel = needsAuth(req.method, pathname);");
  const hookIdx = server.indexOf("Admin action log. This gate is the ONE place");
  ok("the success-path hook exists", hookIdx !== -1);
  ok("the hook lives inside the auth gate", gateIdx !== -1 && hookIdx > gateIdx);

  // Fire-and-forget. An awaited log write puts the log on the critical
  // path of every write request.
  ok("the log write is not awaited", !server.includes("await adminActions.record("));

  // Recorded on finish, so the status code is the real one.
  ok("recorded on response finish", server.includes('res.once("finish"'));

  // ip + user-agent are read synchronously, before the listener can
  // outlive the socket — the trap recordQuoteView() documents.
  const hookBlock = server.slice(hookIdx, hookIdx + 1200);
  ok("ip is captured before the listener",
    hookBlock.indexOf("const actorIp = callerIp(req)") < hookBlock.indexOf('res.once("finish"'));
  ok("user-agent is captured before the listener",
    hookBlock.indexOf("const actorUa =") < hookBlock.indexOf('res.once("finish"'));

  // A signed-in operator refused an admin-only action is logged too. That
  // event never reaches the success-path hook — the gate rejects first —
  // so it has its own call, and it is the one an audit reader most wants.
  const refusalIdx = server.indexOf("A signed-in operator REFUSED an admin-only action");
  ok("refused admin-only actions are logged", refusalIdx !== -1);
  const refusalBlock = server.slice(refusalIdx, refusalIdx + 900);
  ok("the refusal log records status 403", refusalBlock.includes("status: 403"));
  ok("the refusal log names the real actor", refusalBlock.includes("uid: anyUser.uid"));
  ok("the refusal log is not awaited", !refusalBlock.includes("await adminActions.record("));
  ok("the refusal log is gated to mutating requests",
    refusalBlock.includes("adminActions.isMutating(req.method)"));

  // The read route is admin-only, twice over.
  ok("action-log path is admin in needsAuth",
    /if \(pathname === "\/api\/admin\/action-log"\) return "admin";/.test(server));
  ok("the read route re-checks requireAdmin",
    /pathname === "\/api\/admin\/action-log"\)[\s\S]{0,200}requireAdmin\(req\)/.test(server));
  ok("the read route is GET-only",
    server.includes('req.method === "GET" && pathname === "/api/admin/action-log"'));
}

// ---- Result -----------------------------------------------------------

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nadmin-actions: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`admin-actions: ${pass} assertions passed`);

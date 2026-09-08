#!/usr/bin/env node
// scripts/test-purge-test-data.mjs
//
// The load-test purge: remove every record the booking bot made, and
// everything those bookings created — properties, customers, work orders,
// invoices — without touching a single real one.
//
// Patrick, 2026-09-08: "can you build a delete bot that deletes all these
// booked appointments, and everything that they have created?"
//
// THE DANGEROUS PART, and what these assertions exist for: the purge
// reaches into every store at once. A customer or property is removed
// ONLY when every lead pointing at it is itself in the purge — a test
// booking made against a REAL customer must take the booking and leave
// the customer standing. That case is assertion 6.
//
// Boots the real server against fixture data and drives the real endpoint.
// Run: node scripts/test-purge-test-data.mjs  (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));
const PORT = 4797;

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "work-orders.json", "invoices.json",
  "quotes.json", "projects.json", "customers.json", "properties.json", "users.json", "auth.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const write = (n, v) => fs.writeFileSync(path.join(DATA, `${n}.json`), JSON.stringify(v, null, 2) + "\n");
const read = (n) => {
  const p = path.join(DATA, `${n}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8") || "[]") : [];
};

// ---- Fixtures --------------------------------------------------------
// Two bot leads (marked), and one REAL lead that shares a customer with
// nothing and must survive untouched. Plus a real customer who happens to
// have a bot booking against them — the trap.
function seed() {
  write("leads", [
    { id: "L-BOT1", customerId: "C-BOT", propertyId: "P-BOT",
      contact: { firstName: "Test", lastName: "Customer47", notes: "PJLTEST-047 — bot" },
      booking: { start: "2026-10-20T12:00:00Z" } },
    { id: "L-BOT2", customerId: "C-BOT", propertyId: "P-BOT",
      contact: { firstName: "Test", lastName: "Customer48", notes: "PJLTEST-048 — bot" } },
    // THE TRAP. The bot booked an address the server matched to a customer
    // Patrick already had, so this marked lead carries a REAL customerId and
    // a REAL propertyId. Sweeping every customerId a marked lead names would
    // delete Peter Ross and his property along with the bot's junk.
    { id: "L-BOT3", customerId: "C-REAL", propertyId: "P-REAL",
      contact: { firstName: "Test", lastName: "Customer49", notes: "PJLTEST-049 — bot" },
      booking: { start: "2026-10-23T12:00:00Z" } },
    // Peter's own lead. It is unmarked, so it is what keeps him alive.
    { id: "L-REAL", customerId: "C-REAL", propertyId: "P-REAL",
      contact: { firstName: "Peter", lastName: "Ross", notes: "Real customer, do not touch" } }
  ]);
  write("customers", [{ id: "C-BOT", name: "Test Customer47" }, { id: "C-REAL", name: "Peter Ross" }]);
  write("properties", [{ id: "P-BOT", code: "P-9001" }, { id: "P-REAL", code: "P-0001" }]);
  write("bookings", [
    { id: "BK-BOT", leadId: "L-BOT1", customerId: "C-BOT", scheduledFor: "2026-10-20T12:00:00Z" },
    // The bot's booking against Peter. Anchored to a marked lead, so it goes.
    { id: "BK-BOT3", leadId: "L-BOT3", customerId: "C-REAL", scheduledFor: "2026-10-23T12:00:00Z" },
    // Anchored to no lead at all. Nothing marks it as the bot's, so the
    // purge leaves it for a human rather than guessing.
    { id: "BK-ORPHAN", leadId: null, customerId: "C-REAL", propertyId: "P-REAL", scheduledFor: "2026-10-21T12:00:00Z" },
    { id: "BK-REAL", leadId: "L-REAL", customerId: "C-REAL", scheduledFor: "2026-10-22T12:00:00Z" }
  ]);
  write("work-orders", [
    { id: "WO-BOT", leadId: "L-BOT1", customerId: "C-BOT" },
    { id: "WO-BOT3", leadId: "L-BOT3", customerId: "C-REAL" },
    { id: "WO-REAL", leadId: "L-REAL", customerId: "C-REAL" }
  ]);
  write("invoices", [
    { id: "INV-BOT", customerId: "C-BOT", status: "draft" },
    { id: "INV-BOT3", leadId: "L-BOT3", customerId: "C-REAL", status: "draft" },
    { id: "INV-REAL", customerId: "C-REAL", status: "sent" }
  ]);
  write("quotes", [{ id: "Q-BOT", customerId: "C-BOT" }]);
  write("projects", []);
}

const users = require2(path.join(ROOT, "server", "lib", "users.js"));

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

async function purge(cookie, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/purge-test-data`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  seed();
  write("users", []);
  fs.rmSync(path.join(DATA, "auth.json"), { force: true });
  await users.create({ email: "purge@local.test", name: "Purge", role: "admin", password: "local-purge-pass-123" });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // 1. Anonymous is refused.
  const anon = await purge(null, { confirm: "PURGE TEST DATA" });
  ok("an anonymous caller cannot purge", anon.status === 401 || anon.status === 403, `status ${anon.status}`);
  ok("…and nothing was deleted by the attempt", read("leads").length === 4);

  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "purge@local.test", password: "local-purge-pass-123" })
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("login failed: " + login.status);

  // 2. Dry run is the default and deletes nothing.
  const dry = await purge(cookie, {});
  ok("a call with no confirm token is a dry run", dry.body.dryRun === true);
  ok("the dry run finds all three bot leads", dry.body.counts?.leads === 3, JSON.stringify(dry.body.counts));
  ok("the dry run names what it would remove",
    dry.body.counts?.["work-orders"] === 2 && dry.body.counts?.invoices === 2 && dry.body.counts?.bookings === 2,
    JSON.stringify(dry.body.counts));
  ok("the dry run counts one customer and one property, not two",
    dry.body.counts?.customers === 1 && dry.body.counts?.properties === 1,
    JSON.stringify(dry.body.counts));
  ok("the dry run deleted nothing at all",
    read("leads").length === 4 && read("bookings").length === 4 && read("invoices").length === 3);

  // 3. A too-short marker is refused — "P" would match everything.
  const loose = await purge(cookie, { marker: "P", confirm: "PURGE TEST DATA" });
  ok("a dangerously short marker is refused", loose.status === 422);
  ok("…and deleted nothing", read("leads").length === 4);

  // 4. The live purge.
  const live = await purge(cookie, { confirm: "PURGE TEST DATA" });
  ok("the live purge reports it ran", live.body.ok === true && live.body.dryRun === false);
  ok("every bot lead is gone", read("leads").map((l) => l.id).join() === "L-REAL",
    read("leads").map((l) => l.id).join());
  ok("the bot's work orders are gone, the real one stays",
    read("work-orders").map((w) => w.id).join() === "WO-REAL",
    read("work-orders").map((w) => w.id).join());
  ok("the bot's invoices are gone, the real one stays",
    read("invoices").map((i) => i.id).join() === "INV-REAL",
    read("invoices").map((i) => i.id).join());
  ok("the bot's booking against the real customer is gone",
    !read("bookings").some((b) => b.id === "BK-BOT3"));
  ok("the bot's quote is gone", read("quotes").length === 0);
  ok("the bot's customer is gone", !read("customers").some((c) => c.id === "C-BOT"));
  ok("the bot's property is gone", !read("properties").some((p) => p.id === "P-BOT"));

  // 5. THE TRAP: a MARKED bot lead named C-REAL/P-REAL as its customer and
  //    property. Both must survive, because Peter's own unmarked lead still
  //    needs them — the bot's booking, work order and invoice go, the person
  //    stays. Delete the survival guard in the endpoint and these fail.
  ok("the REAL customer survives a bot lead pointing at them",
    read("customers").some((c) => c.id === "C-REAL"),
    read("customers").map((c) => c.id).join());
  ok("the REAL property survives a bot lead pointing at it",
    read("properties").some((p) => p.id === "P-REAL"),
    read("properties").map((p) => p.id).join());
  ok("the real customer's own booking survives",
    read("bookings").some((b) => b.id === "BK-REAL"));
  ok("the real customer's own work order survives",
    read("work-orders").some((w) => w.id === "WO-REAL"));
  ok("the real customer's sent invoice survives",
    read("invoices").some((i) => i.id === "INV-REAL"));
  // A booking anchored to no lead is nobody's to guess about — left standing.
  ok("a booking with no lead behind it is left alone",
    read("bookings").some((b) => b.id === "BK-ORPHAN"));

  // 6. Re-running is a no-op, not an error.
  const again = await purge(cookie, { confirm: "PURGE TEST DATA" });
  ok("re-running finds nothing left", again.body.ok === true && (again.body.counts?.leads || 0) === 0);
  ok("…and the real records are still intact",
    read("leads").length === 1 && read("customers").length === 1 && read("invoices").length === 1);
  ok("…including the property and the orphan booking",
    read("properties").length === 1 && read("bookings").length === 2);

  // 7. The runner Patrick actually types. The endpoint being right is no
  //    use if the script in front of it is broken, so drive the real CLI.
  seed();
  const runner = (extra = []) => new Promise((resolve) => {
    const p = spawn("node", [path.join(ROOT, "scripts", "purge-test-data.mjs"),
      `--base=http://127.0.0.1:${PORT}`, ...extra], {
      cwd: ROOT,
      env: { ...process.env, PJL_ADMIN_EMAIL: "purge@local.test", PJL_ADMIN_PASSWORD: "local-purge-pass-123" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
  });

  const noCreds = await new Promise((resolve) => {
    const p = spawn("node", [path.join(ROOT, "scripts", "purge-test-data.mjs"), `--base=http://127.0.0.1:${PORT}`], {
      cwd: ROOT,
      env: { ...process.env, PJL_ADMIN_EMAIL: "", PJL_ADMIN_PASSWORD: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
  });
  ok("the runner stops when no admin credentials are set", noCreds.code === 2, noCreds.out.slice(0, 200));

  const cliDry = await runner();
  ok("the runner defaults to a dry run", /dry run/i.test(cliDry.out) && cliDry.code === 0, cliDry.out.slice(-400));
  ok("the runner's dry run names the counts", /appointments \/ leads/.test(cliDry.out), cliDry.out.slice(-400));
  ok("the runner's dry run deleted nothing", read("leads").length === 4);

  const cliLive = await runner(["--confirm"]);
  ok("the runner deletes when told to", cliLive.code === 0 && /Removed:/.test(cliLive.out), cliLive.out.slice(-400));
  ok("…and it took the bot's records", read("leads").map((l) => l.id).join() === "L-REAL");
  ok("…and it still left the real customer standing",
    read("customers").some((c) => c.id === "C-REAL"));
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-purge-test-data: ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-purge-test-data: ${passed} assertions passed`);

// scripts/lib/field-server.mjs
//
// Boot the REAL server against a throwaway copy, for the fall-closing
// suites. Nothing it does can reach real data or a real customer:
//
//   * server/ is copied (minus data/) into a temp root, the rest of the
//     repo is symlinked beside it, so every lib resolves its store to the
//     temp server/data — never the repo's.
//   * scripts/lib/stub-outbound.cjs is preloaded: email, SMS and Stripe are
//     written to an outbox file, every other outbound host is refused.
//   * TRIPWIRES: it will not boot with a production host, a live Stripe
//     key, a non-stub credential or a .env file in the environment (the
//     same check runs here before spawning and again inside the stub), and
//     it never links the repo's .env into the copy.
//   * srv.ledger() accounts for every outbound message: each step names
//     what it expects to send, and anything else fails the test.
//
// Usage:
//   const srv = await bootServer({ port: 4861 });
//   await srv.login();                     // throwaway admin
//   const r = await srv.api("GET", "/api/work-orders");
//   srv.outbox()                           // [{channel, to, subject, …}]
//   srv.data("work-orders")                // parsed JSON store
//   const L = srv.ledger();                // outbound accounting, see below
//   await L.expect("finish", [{ channel: "email", to: /cust/, subject: /invoice/i }]);
//   srv.stripeMode(intentId, "declined")   // approved / declined / processing / unreachable
//   await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: intent } });
//   await srv.stop();                      // kills it and removes the copy

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB = path.join(ROOT, "scripts", "lib", "stub-outbound.cjs");
const { unsafeEnvironment, PRODUCTION_HOST } = createRequire(import.meta.url)("./test-tripwires.cjs");

// A base URL a test is about to drive must be this machine. Exported for any
// script that talks to a server it didn't boot through bootServer.
export function assertLocalBase(url) {
  const u = new URL(url);
  if (PRODUCTION_HOST.test(u.hostname)) throw new Error(`refusing to run a test against production (${u.hostname})`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(`refusing to run a test against a non-local server (${u.hostname})`);
  }
  return url;
}

export async function bootServer({ port, env = {} } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-field-server-"));
  for (const entry of fs.readdirSync(ROOT)) {
    if (entry === "server" || entry === ".git") continue;
    // server.js loads ../.env at boot. Never hand it the repo's.
    if (/^\.env($|\.)/.test(entry) && entry !== ".env.example") continue;
    fs.symlinkSync(path.join(ROOT, entry), path.join(TMP, entry));
  }
  fs.cpSync(path.join(ROOT, "server"), path.join(TMP, "server"), {
    recursive: true,
    filter: (src) => !src.startsWith(path.join(ROOT, "server", "data"))
  });
  const DATA = path.join(TMP, "server", "data");
  fs.mkdirSync(DATA, { recursive: true });
  // Pricing overrides live in data/ on the real box; the repo ships one.
  const rates = path.join(ROOT, "server", "data", "project-rates.json");
  if (fs.existsSync(rates)) fs.copyFileSync(rates, path.join(DATA, "project-rates.json"));
  const OUTBOX = path.join(TMP, "outbox.jsonl");
  fs.writeFileSync(OUTBOX, "");

  const WEBHOOK_SECRET = "whsec_stub_e2e";
  const childEnv = {
    PATH: process.env.PATH, HOME: TMP, TZ: "America/Toronto",
    PORT: String(port), HOST: "127.0.0.1",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PJL_STUB_OUTBOX: OUTBOX,
    GMAIL_USER: "stub@pjl.test", GMAIL_APP_PASSWORD: "stub",
    TWILIO_ACCOUNT_SID: "ACstub", TWILIO_AUTH_TOKEN: "stub", TWILIO_FROM_NUMBER: "+15555550100",
    STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_PUBLISHABLE_KEY: "pk_test_stub",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...env
  };
  const BASE = assertLocalBase(`http://127.0.0.1:${port}`);
  // First tripwire, before anything starts. The stub runs the same check
  // again inside the child, so a caller that skips this still can't boot.
  const problems = unsafeEnvironment(childEnv, path.join(TMP, "server", "server.js"));
  if (problems.length) {
    fs.rmSync(TMP, { recursive: true, force: true });
    throw new Error(`refusing to boot a test server:\n  - ${problems.join("\n  - ")}`);
  }

  const child = spawn(process.execPath, ["--require", STUB, path.join(TMP, "server", "server.js")], {
    cwd: TMP, env: childEnv, stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  let exited = null;
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  child.on("exit", (code) => { exited = code ?? "signal"; });
  let up = false;
  for (let i = 0; i < 100 && !up && exited === null; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {}
  }
  if (!up) {
    child.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
    throw new Error(`server never came up${exited !== null ? ` (exited ${exited})` : ""}:\n` + logs.slice(-2000));
  }

  const require = createRequire(path.join(TMP, "server", "server.js"));
  let cookie = "";
  const srv = {
    TMP, DATA, BASE, OUTBOX,
    logs: () => logs,
    lib: (name) => require(path.join(TMP, "server", "lib", name)),
    data: (name) => {
      const p = path.join(DATA, `${name}.json`);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
    },
    writeData: (name, value) => fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(value, null, 2)),
    outbox: () => fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    async login({ role = "admin" } = {}) {
      const users = srv.lib("users.js");
      const email = `${role}-${Date.now()}@pjl.test`;
      // The user is written from THIS process while the server process may
      // still be creating its own empty users.json at boot (users.js
      // ensureFile is check-then-write, not atomic across processes), which
      // can wipe the record just written. So re-create it if it's gone and
      // retry, and fail loudly: a silent 401 here surfaced later as
      // "CRM login required" on an unrelated call.
      let status = 0;
      for (let attempt = 0; attempt < 5 && status !== 200; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 150));
        if (!(await users.getByEmail(email).catch(() => null))) {
          await users.create({ email, name: `Test ${role}`, role, password: "field-test-12345" });
        }
        const r = await fetch(`${BASE}/api/login`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "field-test-12345" })
        });
        status = r.status;
        cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
      }
      if (status !== 200) throw new Error(`test login failed (HTTP ${status})`);
      return status;
    },
    async api(method, p, body, headers = {}) {
      if (!String(p).startsWith("/")) throw new Error(`srv.api takes a path on the test server, not ${p}`);
      const r = await fetch(BASE + p, {
        method,
        headers: { "content-type": "application/json", accept: "application/json", cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = { _text: text.slice(0, 400) }; }
      return { status: r.status, body: json, headers: r.headers };
    },
    // The customer tapping Pay on the Stripe form: the next time the
    // server re-reads this intent from (stubbed) Stripe, it has succeeded.
    stripeSucceed(intentId) { fs.appendFileSync(`${OUTBOX}.succeeded`, `${intentId}\n`); },
    // What (stubbed) Stripe reports next for this intent, or "*" for every
    // call: "succeeded" | "declined" | "processing" | "unreachable" | null.
    stripeMode(intentId, mode) { fs.appendFileSync(`${OUTBOX}.stripe`, JSON.stringify({ id: intentId, mode }) + "\n"); },
    // A Stripe event, signed the way Stripe signs one (or with `secret`,
    // to prove a forged one is refused).
    async stripeWebhook(event, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
      const raw = JSON.stringify({ id: `evt_stub_${crypto.randomUUID()}`, object: "event", ...event });
      const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex");
      const r = await fetch(`${BASE}/api/webhooks/stripe`, {
        method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${sig}` }, body: raw
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    // Outbound accounting. Every entry the server writes to the outbox from
    // here on must be claimed by an expectation, step by step:
    //
    //   const L = srv.ledger();
    //   await L.expect("finish", [
    //     { channel: "email", to: /jane/, subject: /invoice/i },       // exactly one
    //     { channel: "stripe", method: "GET", n: "*" },                 // any number
    //   ]);
    //   await L.expect("confirm price", []);                           // nothing at all
    //   L.close()  → problems that were never claimed
    //
    // Matchers: channel, to, subject, text (email text+html or SMS body),
    // method, path, host — a string (contained) or a RegExp — and n: a
    // number, "*" (0+), "+" (1+) or [min, max]. Entries are claimed in
    // order by the first matcher that fits. A production-host entry is a
    // failure even when claimed.
    ledger() {
      let cursor = srv.outbox().length;
      const all = [];
      const fits = (want, have) => want === undefined || (want instanceof RegExp ? want.test(String(have ?? "")) : String(have ?? "").includes(String(want)));
      const matches = (m, e) => m.channel === e.channel
        && fits(m.to, e.to) && fits(m.subject, e.subject)
        && fits(m.text, e.channel === "email" ? `${e.text}\n${e.html}` : e.body)
        && fits(m.method, e.method) && fits(m.path, e.path) && fits(m.host, e.host || e.url);
      const range = (n) => n === "*" ? [0, Infinity] : n === "+" ? [1, Infinity] : Array.isArray(n) ? n : [n ?? 1, n ?? 1];
      const show = (e) => `${e.channel}${e.to ? ` to ${e.to}` : ""}${e.subject ? ` "${e.subject}"` : ""}${e.body ? ` "${String(e.body).slice(0, 80)}"` : ""}${e.method ? ` ${e.method} ${e.path}` : ""}${e.url || e.host ? ` ${e.url || e.host}` : ""}`;
      const showM = (m) => Object.entries(m).filter(([k]) => k !== "n").map(([k, v]) => `${k}=${v}`).join(" ");
      const tally = (entries, matchers) => {
        const counts = matchers.map(() => 0);
        const unexpected = [];
        for (const e of entries) {
          const i = matchers.findIndex((m, j) => counts[j] < range(m.n)[1] && matches(m, e));
          if (i < 0) unexpected.push(e); else counts[i] += 1;
        }
        const missing = matchers.map((m, j) => counts[j] < range(m.n)[0] ? `${showM(m)} (${counts[j]} of ${range(m.n)[0]})` : null).filter(Boolean);
        return { unexpected, missing };
      };
      return {
        problems: all,
        async expect(label, matchers, { timeoutMs = 5000, settleMs = 400 } = {}) {
          const deadline = Date.now() + timeoutMs;
          let entries = srv.outbox().slice(cursor);
          while (tally(entries, matchers).missing.length && Date.now() < deadline) {
            await sleep(100);
            entries = srv.outbox().slice(cursor);
          }
          await sleep(settleMs); // anything extra a step sends lands here
          entries = srv.outbox().slice(cursor);
          cursor += entries.length;
          const t = tally(entries, matchers);
          const errors = [
            ...t.missing.map((m) => `${label}: expected ${m}`),
            ...t.unexpected.map((e) => `${label}: UNEXPECTED outbound ${show(e)}`),
            ...entries.filter((e) => e.production).map((e) => `${label}: PRODUCTION host contacted ${show(e)}`)
          ];
          all.push(...errors);
          return { ok: errors.length === 0, errors, entries };
        },
        close() {
          const rest = srv.outbox().slice(cursor);
          cursor += rest.length;
          const errors = rest.map((e) => `after the last step: UNEXPECTED outbound ${show(e)}`);
          all.push(...errors);
          return errors;
        }
      };
    },
    // A customer + property (+ declared zones) + a fall-closing WO on it.
    async fixture({ zones = 4, email = "cust@example.com", name = "Jane Customer", phone = "9055550100", accountType = "residential", address = "851 Hilton Blvd, Newmarket, ON" } = {}) {
      const customers = srv.lib("customers.js");
      const unique = Math.random().toString(36).slice(2, 7);
      const cust = await customers.create({ name, email: email ? `${unique}.${email}` : "", phone, accountType });
      const p = await srv.api("POST", "/api/properties", { customerId: cust.id, address });
      const prop = p.body.property;
      if (!prop) throw new Error("property create failed: " + JSON.stringify(p.body).slice(0, 300));
      if (zones) {
        const zs = Array.from({ length: zones }, (_, i) => ({ number: i + 1, location: `Zone ${i + 1}` }));
        await srv.api("PATCH", `/api/properties/${prop.id}`, { system: { ...prop.system, zones: zs } });
      }
      const w = await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: prop.id });
      if (!w.body.workOrder) throw new Error("wo create failed: " + JSON.stringify(w.body).slice(0, 300));
      return { cust, prop, wo: w.body.workOrder };
    },
    // PATCH with the If-Match the app would send.
    async qpatch(id, patch) {
      const g = await srv.api("GET", `/api/work-orders/${id}`);
      return srv.api("PATCH", `/api/work-orders/${id}`, patch, { "if-match": g.body.workOrder?.updatedAt || "" });
    },
    // Answer every closing gate the way a finished visit would.
    async prepClosing(id, { extraZones = [], issues = false, paidOnSite = false } = {}) {
      const wo = (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
      const zones = [...wo.zones.map((z, i) => ({ ...z, status: "ok",
        issues: (issues && i === 0) ? [{ type: "broken_head", qty: 2, notes: "cracked rotor by driveway" }] : (z.issues || []) })), ...extraZones];
      let r = await srv.qpatch(id, { zones });
      if (r.status !== 200) throw new Error("zones patch " + r.status + " " + JSON.stringify(r.body).slice(0, 300));
      r = await srv.qpatch(id, { paidOnSite, needsReturnVisit: false, waterShutoffBy: "tech", backFlush: "no",
        serviceChecklist: { controller_off: true, water_off: true, compressor_disconnected: true, system_winterized: true } });
      if (r.status !== 200) throw new Error("answers patch " + r.status + " " + JSON.stringify(r.body).slice(0, 300));
      return r.body.workOrder;
    },
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  };
  return srv;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The customer's signature as the app sends it.
export const SIGNATURE = { acknowledgement: true, imageData: "data:image/png;base64," + "A".repeat(200), customerName: "Jane Customer" };

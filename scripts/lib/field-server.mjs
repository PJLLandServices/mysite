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
//
// Usage:
//   const srv = await bootServer({ port: 4861 });
//   await srv.login();                     // throwaway admin
//   const r = await srv.api("GET", "/api/work-orders");
//   srv.outbox()                           // [{channel, to, subject, …}]
//   srv.data("work-orders")                // parsed JSON store
//   await srv.stop();                      // kills it and removes the copy

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function bootServer({ port, env = {} } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-field-server-"));
  for (const entry of fs.readdirSync(ROOT)) {
    if (entry === "server" || entry === ".git") continue;
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

  const child = spawn(process.execPath, ["--require", path.join(ROOT, "scripts", "lib", "stub-outbound.cjs"),
    path.join(TMP, "server", "server.js")], {
    cwd: TMP,
    env: {
      PATH: process.env.PATH, HOME: TMP, TZ: "America/Toronto",
      PORT: String(port), HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      PJL_STUB_OUTBOX: OUTBOX,
      GMAIL_USER: "stub@pjl.test", GMAIL_APP_PASSWORD: "stub",
      TWILIO_ACCOUNT_SID: "ACstub", TWILIO_AUTH_TOKEN: "stub", TWILIO_FROM_NUMBER: "+15555550100",
      STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_PUBLISHABLE_KEY: "pk_test_stub",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const BASE = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {}
  }
  if (!up) { child.kill(); throw new Error("server never came up:\n" + logs.slice(-2000)); }

  const require = createRequire(path.join(TMP, "server", "server.js"));
  let cookie = "";
  const srv = {
    TMP, DATA, BASE,
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
      await users.create({ email, name: `Test ${role}`, role, password: "field-test-12345" });
      const r = await fetch(`${BASE}/api/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "field-test-12345" })
      });
      cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
      return r.status;
    },
    async api(method, p, body, headers = {}) {
      const r = await fetch(BASE + p, {
        method,
        headers: { "content-type": "application/json", accept: "application/json", cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = { _text: text.slice(0, 400) }; }
      return { status: r.status, body: json, headers: r.headers };
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

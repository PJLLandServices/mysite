#!/usr/bin/env node
// scripts/test-e2e-tripwires.mjs
//
// The safety floor under every journey test (Phase 1 E2E, 2026-09-26).
// A test server must be unable to reach the real business, and a test
// must notice anything it sends that it didn't mean to:
//
//   A. bootServer refuses a production host anywhere in the environment
//      (PUBLIC_BASE_URL, GMAIL_USER, …) and never drives a non-local base
//   B. …refuses live Stripe keys and non-test Stripe keys
//   C. …refuses real-looking Twilio / Gmail / QuickBooks / Google / webhook
//      credentials
//   D. the stub refuses the same things on its own, so a script that boots
//      server.js without the harness still can't start with them
//   E. no .env reaches the test server: the harness never links it, and
//      the stub refuses to boot beside one (server.js loads ../.env)
//   F. below fetch: http(s).request and raw sockets to anything but this
//      machine are refused and logged, production flagged
//   G. Stripe outcomes a test can set: declined / processing / unreachable;
//      a signed webhook is accepted, a forged one refused
//   H. srv.ledger(): an unexpected email fails the step, an expected one
//      passes, a missing one fails, and a production entry fails even when
//      claimed
//
// Run: node scripts/test-e2e-tripwires.mjs   (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootServer, assertLocalBase, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "scripts", "lib", "stub-outbound.cjs");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const refusesToBoot = async (env, label, why) => {
  let srv = null, err = null;
  try { srv = await bootServer({ port: 4881, env }); } catch (e) { err = e; }
  if (srv) await srv.stop();
  ok(err && why.test(err.message), `${label} (${err ? err.message.split("\n")[1]?.trim() : "it booted"})`);
};

// ---- A. production hosts ----------------------------------------------------
await refusesToBoot({ PUBLIC_BASE_URL: "https://www.pjllandservices.com" }, "A. PUBLIC_BASE_URL at production", /production/);
await refusesToBoot({ GMAIL_USER: "patrick@pjllandservices.com" }, "A. the real mailbox as sender", /production/);
await refusesToBoot({ PJL_OSRM_URL: "https://pjl-crm.onrender.com" }, "A. the Render host", /production/);
{
  let threw = null;
  try { assertLocalBase("https://www.pjllandservices.com/login"); } catch (e) { threw = e; }
  ok(threw && /production/.test(threw.message), "A. assertLocalBase refuses the live site");
  threw = null;
  try { assertLocalBase("https://staging.example.com"); } catch (e) { threw = e; }
  ok(threw && /non-local/.test(threw.message), "A. …and any other non-local server");
  ok(assertLocalBase("http://127.0.0.1:4881") === "http://127.0.0.1:4881", "A. …and lets this machine through");
}

// ---- B. Stripe keys -----------------------------------------------------------
await refusesToBoot({ STRIPE_SECRET_KEY: "sk_live_51abcdef" }, "B. a live secret key", /LIVE Stripe key|not a test key/);
await refusesToBoot({ STRIPE_SECRET_KEY: "rk_live_51abcdef" }, "B. a live restricted key", /LIVE Stripe key/);
await refusesToBoot({ STRIPE_PUBLISHABLE_KEY: "pk_live_51abcdef" }, "B. a live publishable key", /LIVE Stripe key/);
await refusesToBoot({ STRIPE_SECRET_KEY: "sk_51something" }, "B. a key that isn't a test key", /not a test key/);

// ---- C. other credentials -------------------------------------------------------
await refusesToBoot({ TWILIO_AUTH_TOKEN: "real-looking-auth-token" }, "C. a real-looking Twilio token", /TWILIO_AUTH_TOKEN/);
await refusesToBoot({ TWILIO_ACCOUNT_SID: "ACreal-looking-account" }, "C. a real-looking Twilio SID", /TWILIO_ACCOUNT_SID/);
await refusesToBoot({ GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }, "C. a Gmail app password", /GMAIL_APP_PASSWORD/);
await refusesToBoot({ TWILIO_AUTH_TOKEN: "not-a-stub-token" }, "C. a value that merely contains the word \"stub\"", /TWILIO_AUTH_TOKEN/);
await refusesToBoot({ QB_CLIENT_SECRET: "real-secret" }, "C. a QuickBooks secret", /QB_CLIENT_SECRET/);
await refusesToBoot({ GOOGLE_MAPS_SERVER_KEY: "AIzaReal" }, "C. a Google Maps key", /GOOGLE_MAPS_SERVER_KEY/);
await refusesToBoot({ STRIPE_WEBHOOK_SECRET: "whsec_real" }, "C. a real webhook signing secret", /STRIPE_WEBHOOK_SECRET/);

// ---- D. the stub on its own ---------------------------------------------------------
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-tripwire-"));
const runStub = (env, code, entry = null) => {
  const outbox = path.join(SCRATCH, `outbox-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(outbox, "");
  const args = ["--require", STUB, ...(entry ? [entry] : ["-e", code])];
  const r = spawnSync(process.execPath, args, {
    env: { PATH: process.env.PATH, PJL_STUB_OUTBOX: outbox, ...env }, encoding: "utf8", timeout: 20000
  });
  const lines = fs.readFileSync(outbox, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, lines };
};
{
  let r = runStub({ STRIPE_SECRET_KEY: "sk_live_x" }, "console.log('STARTED')");
  ok(r.status !== 0 && !r.out.includes("STARTED") && /refusing to start/.test(r.out), "D. the stub alone refuses a live key before the server runs");
  ok(r.lines.some((l) => l.channel === "tripwire"), "D. …and records why in the outbox");
  r = runStub({ PUBLIC_BASE_URL: "https://pjllandservices.com" }, "console.log('STARTED')");
  ok(r.status !== 0 && !r.out.includes("STARTED"), "D. …and a production base URL");
  r = runStub({}, "console.log('STARTED')");
  ok(r.status === 0 && r.out.includes("STARTED"), `D. a clean environment starts (${r.status} ${r.out.slice(0, 200)})`);
}

// ---- E. .env ---------------------------------------------------------------------------
{
  // A server entry with a .env beside it (server.js reads ../.env).
  const fakeRoot = fs.mkdtempSync(path.join(SCRATCH, "root-"));
  fs.mkdirSync(path.join(fakeRoot, "server"));
  const entry = path.join(fakeRoot, "server", "server.js");
  fs.writeFileSync(entry, "console.log('STARTED')");
  fs.writeFileSync(path.join(fakeRoot, ".env"), "STRIPE_SECRET_KEY=sk_live_from_dotenv\n");
  let r = runStub({}, null, entry);
  ok(r.status !== 0 && !r.out.includes("STARTED") && /\.env/.test(r.out), "E. the stub refuses to boot a server with a .env beside it");
  fs.rmSync(path.join(fakeRoot, ".env"));
  r = runStub({}, null, entry);
  ok(r.status === 0 && r.out.includes("STARTED"), "E. …and boots it once the .env is gone");

  // The harness never links the repo's .env into its copy. If there isn't
  // one, plant a canary for the duration (never overwrite a real one).
  const repoEnv = path.join(ROOT, ".env");
  const planted = !fs.existsSync(repoEnv);
  if (planted) fs.writeFileSync(repoEnv, "PJL_TRIPWIRE_CANARY=1\n");
  try {
    const srv = await bootServer({ port: 4882 });
    try {
      ok(!fs.existsSync(path.join(srv.TMP, ".env")), "E. the harness's server copy has no .env even when the repo has one");
      ok(fs.existsSync(path.join(srv.TMP, ".env.example")) || !fs.existsSync(path.join(ROOT, ".env.example")), "E. …(.env.example is still linked)");
    } finally { await srv.stop(); }
  } finally {
    if (planted) fs.rmSync(repoEnv, { force: true });
  }
}

// ---- F. sockets below fetch -------------------------------------------------------------
{
  // Every target can't resolve or route (.invalid, RFC 5737 TEST-NET), so
  // even a harness WITHOUT these tripwires reaches nothing — the live
  // hostname is only ever a suffix here, enough for the production flag.
  const r = runStub({}, `
    const https = require("node:https"), http = require("node:http"), net = require("node:net");
    const done = [];
    const settle = (tag) => (e) => { done.push(tag + ":" + (e && e.code)); if (done.length === 4) { console.log(done.join(",")); process.exit(0); } };
    https.get("https://www.pjllandservices.com.invalid/api/health").on("error", settle("https"));
    http.get("http://192.0.2.1/").on("error", settle("http"));
    net.connect(465, "smtp.gmail.invalid").on("error", settle("net"));
    fetch("https://example.invalid/").catch(settle("fetch"));
    setTimeout(() => { console.log("TIMEOUT " + done.join(",")); process.exit(1); }, 8000);
  `);
  ok(r.status === 0, `F. every non-local request fails fast (${r.out.trim().slice(0, 200)})`);
  const refused = r.lines.filter((l) => l.channel === "refused");
  ok(refused.some((l) => l.host === "www.pjllandservices.com.invalid" && l.production === true), "F. https.request to the live site is refused and flagged production");
  ok(refused.some((l) => l.host === "192.0.2.1"), "F. http.request to a bare IP is refused");
  ok(refused.some((l) => l.host === "smtp.gmail.invalid"), "F. a raw SMTP socket is refused");
  ok(refused.some((l) => /example\.invalid/.test(l.url || "")), "F. fetch to anything else is refused");
}

// ---- G. Stripe outcomes + webhooks, and H. the ledger -----------------------------------
const srv = await bootServer({ port: 4883 });
try {
  await srv.login();
  // G. modes, straight at the stubbed Stripe from inside the server's process
  // is not reachable from here — drive them through the stub directly.
  const r = runStub({}, `
    const fs = require("node:fs");
    const post = (p, body) => fetch("https://api.stripe.com" + p, { method: "POST", body: new URLSearchParams(body).toString() }).then((x) => x.json());
    const get = (id) => fetch("https://api.stripe.com/v1/payment_intents/" + id).then((x) => x.json());
    (async () => {
      const a = await post("/v1/payment_intents", { amount: "1000", currency: "cad" });
      const b = await post("/v1/payment_intents", { amount: "1000", currency: "cad" });
      const c = await post("/v1/payment_intents", { amount: "1000", currency: "cad" });
      const d = await post("/v1/payment_intents", { amount: "1000", currency: "cad" });
      const mode = (id, m) => fs.appendFileSync(process.env.PJL_STUB_OUTBOX + ".stripe", JSON.stringify({ id, mode: m }) + "\\n");
      mode(a.id, "succeeded"); mode(b.id, "declined"); mode(c.id, "processing"); mode(d.id, "unreachable");
      const out = { a: (await get(a.id)).status, b: await get(b.id), c: (await get(c.id)).status };
      try { await get(d.id); out.d = "reached"; } catch (e) { out.d = e.message; }
      console.log(JSON.stringify(out));
    })();
  `);
  let out = {};
  try { out = JSON.parse(r.out.trim().split("\n").pop()); } catch {}
  ok(out.a === "succeeded", `G. "succeeded" approves the card (${out.a})`);
  ok(out.b?.status === "requires_payment_method" && out.b?.last_payment_error?.code === "card_declined", `G. "declined" reports card_declined (${out.b?.status})`);
  ok(out.c === "processing", `G. "processing" is a reader that never finished (${out.c})`);
  ok(/unreachable|ETIMEDOUT|fetch failed/.test(out.d || ""), `G. "unreachable" never reaches Stripe (${out.d})`);

  const good = await srv.stripeWebhook({ type: "payment_intent.created", data: { object: { id: "pi_x", metadata: {} } } });
  ok(good.status === 200, `G. a webhook signed with the test secret is accepted (${good.status})`);
  const forged = await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_x", metadata: {} } } }, { secret: "whsec_stub_forged" });
  ok(forged.status === 400, `G. a forged webhook is refused (${forged.status})`);
  {
    let threw = null;
    try { await srv.api("GET", "https://www.pjllandservices.com.invalid/api/work-orders"); } catch (e) { threw = e; }
    ok(threw !== null, "A. srv.api refuses a full URL (it only drives the test server)");
  }

  // H. the ledger, against a real closing that emails the customer.
  const L = srv.ledger();
  const f = await srv.fixture();
  await srv.prepClosing(f.wo.id);
  let step = await L.expect("setup", []);
  ok(step.ok, `H. a quiet step passes (${step.errors.join("; ")})`);
  const now = new Date().toISOString();
  await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
  step = await L.expect("finish, expecting nothing", []);
  ok(!step.ok && step.errors.some((e) => /UNEXPECTED outbound email to .*cust@example\.com/.test(e)), "H. an email the step didn't expect fails it");

  const L2 = srv.ledger();
  const g = await srv.fixture();
  await srv.prepClosing(g.wo.id);
  await srv.api("PATCH", `/api/work-orders/${g.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
  step = await L2.expect("finish", [
    { channel: "email", to: "cust@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);
  ok(step.ok, `H. the same step passes when it names what it sends (${step.errors.join("; ")})`);
  step = await L2.expect("nothing more", [{ channel: "sms", to: "+1", n: 1 }], { timeoutMs: 300, settleMs: 50 });
  ok(!step.ok && step.errors.some((e) => /expected channel=sms/.test(e)), "H. an expected message that never came fails the step");

  fs.appendFileSync(srv.OUTBOX, JSON.stringify({ channel: "refused", url: "https://www.pjllandservices.com/", host: "www.pjllandservices.com", production: true }) + "\n");
  step = await L2.expect("production", [{ channel: "refused", n: "*" }], { settleMs: 50 });
  ok(!step.ok && step.errors.some((e) => /PRODUCTION host contacted/.test(e)), "H. a production entry fails even when a matcher claims it");
  fs.appendFileSync(srv.OUTBOX, JSON.stringify({ channel: "sms", to: "+19055550100", body: "late" }) + "\n");
  ok(L2.close().some((e) => /UNEXPECTED outbound sms/.test(e)), "H. close() catches anything after the last step");
} finally {
  await srv.stop();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`e2e-tripwires: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

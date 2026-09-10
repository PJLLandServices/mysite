#!/usr/bin/env node
// scripts/test-mailer-log.mjs — JOB-008 send-ledger tests.
//
//   1. logSend persists ok/fail entries with the right fields
//   2. recipient masking
//   3. healthSummary(): 7-day counts by kind, recentFailures order +
//      masking, and lastSuccessAt overall + per kind — the outage tell
//   4. pruning: age + entry-count caps
//   5. failure alert: ONE SMS attempt per window for customer-facing
//      failures; none for admin-kind (lead_alert) failures
//   6. logSend never throws (bad inputs)
//
// Isolation: mailer-log resolves its store as `<lib>/../data/email-log.json`
// and requires ./rate-limit + ./notify-sms relative to itself — all copied
// into a temp sandbox, with notify-sms's export patched to count alert
// attempts BEFORE mailer-log destructures it at require time.
//
// Run: node scripts/test-mailer-log.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-mailer-log-"));
fs.mkdirSync(path.join(SB, "lib"), { recursive: true });
fs.mkdirSync(path.join(SB, "data"), { recursive: true });
for (const f of ["mailer-log.js", "rate-limit.js", "notify-sms.js", "public-base-url.js"]) {
  fs.copyFileSync(path.join(ROOT, "server", "lib", f), path.join(SB, "lib", f));
}
const require = createRequire(import.meta.url);

// Patch the sandbox notify-sms BEFORE mailer-log destructures its export.
const notifySms = require(path.join(SB, "lib", "notify-sms.js"));
let alertCalls = [];
notifySms.sendEmailFailureAlertSms = async (body) => { alertCalls.push(body); return { ok: true, sid: "TEST" }; };

const mailerLog = require(path.join(SB, "lib", "mailer-log.js"));
const FILE = path.join(SB, "data", "email-log.json");

// 1 + 2 — persistence and masking
{
  await mailerLog.logSend({ kind: "invoice", to: "jane@example.com", ok: true, refId: "I-1" });
  await mailerLog.logSend({ kind: "lead_alert", to: "patrick@pjl.com", ok: false, error: "auth fail" });
  const entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  ok(entries.length === 2, "two entries persisted");
  ok(entries[0].ok === true && entries[0].kind === "invoice" && entries[0].refId === "I-1", "ok entry fields");
  ok(entries[1].ok === false && entries[1].error === "auth fail", "fail entry fields");
  ok(mailerLog.maskRecipient("jane@example.com") === "j***@example.com", "masking");
  ok(mailerLog.maskRecipient("") === "(no address)", "masking empty");
}

// 5 — alerting: lead_alert failure above did NOT alert (it has its own
// SMS redundancy); customer-facing kinds do, once per window
{
  ok(alertCalls.length === 0, "admin-kind failure does not SMS");
  await mailerLog.logSend({ kind: "magic_link", to: "cust@example.com", ok: false, error: "SMTP down", refId: "L1" });
  ok(alertCalls.length === 1, "customer-facing failure SMSes once");
  ok(alertCalls[0].includes("c***@example.com") && !alertCalls[0].includes("cust@example.com"), "SMS masks the recipient");
  await mailerLog.logSend({ kind: "completion", to: "two@example.com", ok: false, error: "SMTP down" });
  ok(alertCalls.length === 1, "second failure in the same hour: no second SMS");
}

// 3 — healthSummary
{
  const s = await mailerLog.healthSummary();
  ok(s.last7d.invoice?.sent === 1 && s.last7d.invoice?.failed === 0, "7d invoice bucket");
  ok(s.last7d.magic_link?.failed === 1 && s.last7d.completion?.failed === 1 && s.last7d.lead_alert?.failed === 1, "7d failure buckets by kind");
  ok(typeof s.lastSuccessAt === "string" && s.lastSuccessByKind.invoice === s.lastSuccessAt, "lastSuccessAt overall + per kind");
  ok(!("magic_link" in s.lastSuccessByKind), "failed-only kind has no lastSuccess entry");
  ok(s.recentFailures[0].kind === "completion" && s.recentFailures[0].to === "t***@example.com", "recent failures newest-first, masked");
}

// 4 — pruning
{
  const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  const stuffed = Array.from({ length: 5100 }, (_, i) => ({ ts: new Date(Date.now() - i * 1000).toISOString(), kind: "other", to: "x@y.z", ok: true }));
  stuffed.push({ ts: old, kind: "other", to: "old@y.z", ok: true });
  fs.writeFileSync(FILE, JSON.stringify(stuffed, null, 2) + "\n");
  await mailerLog.logSend({ kind: "other", to: "new@y.z", ok: true });
  const after = JSON.parse(fs.readFileSync(FILE, "utf8"));
  ok(after.length <= 5001, `entry cap enforced (got ${after.length})`);
  ok(!after.some((e) => e.ts === old), "age cap enforced");
}

// 6 — never throws / never rejects
{
  let threw = false;
  try { await mailerLog.logSend(); await mailerLog.logSend({ kind: "nonsense", to: null, ok: "yes" }); } catch { threw = true; }
  ok(!threw, "bad input tolerated");
  const entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const last = entries[entries.length - 1];
  ok(last.kind === "other" && last.ok === true, "unknown kind coerced to other, truthy ok coerced to boolean");
}

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\nmailer-log: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

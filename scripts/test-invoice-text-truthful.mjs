#!/usr/bin/env node
// scripts/test-invoice-text-truthful.mjs
//
// The automatic "invoice ready" text never tells a customer their invoice
// was emailed when it wasn't (Patrick, 2026-09-27; found by E2E journey 1).
//
// WHAT BROKE: five minutes after a "Bill later" Finish, the customer was
// texted "Your invoice for <street> has been emailed to you. If you don't
// see it, please check spam/junk. View or pay it here: …". Nothing had been
// emailed: a Bill-later invoice is a draft until Patrick reviews and Sends
// it, and the texted portal page showed it with no Pay button.
//
// THE RULE (notify-customer.sendInvoiceReadySMS): the text goes only for an
// invoice that has actually been emailed (sentAt). An unsent draft is
// skipped, the skip is on the invoice's history, and the pending schedule
// is cleared so the 2-minute sweep can't send it later either. The customer
// is texted when the invoice really goes out: Send's own "we just emailed
// your invoice" text (unchanged).
//
//   A. Bill later, the text on its timer (set to fire at once): no text,
//      the skip is recorded, nothing left scheduled
//   B. the customer's completion email still says an invoice will follow
//   C. Send emails the invoice, as before
//   D. the rule is in the one sender the timer AND the sweep both call
//
// Run: node scripts/test-invoice-text-truthful.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 240);

// ---- D. one rule, in the one sender ---------------------------------------------
{
  const src = fs.readFileSync(new URL("../server/lib/notify-customer.js", import.meta.url), "utf8");
  const at = src.indexOf("async function sendInvoiceReadySMS(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  const guard = body.indexOf("!invoice.sentAt");
  const twilio = body.indexOf("api.twilio.com");
  ok(guard > 0 && twilio > 0 && guard < twilio, "D. sendInvoiceReadySMS refuses an unsent invoice before anything reaches Twilio");
  const sweep = src.slice(src.indexOf("async function sweepPendingInvoiceSMS("));
  ok(/sendInvoiceReadySMS\(/.test(sweep.slice(0, 2000)), "D. …and the 2-minute sweep goes through that same sender");
}

const srv = await bootServer({ port: 4926 });
try {
  await srv.login();
  // The invoice-ready timer fires at once, so the text would show here.
  srv.writeData("settings", { invoiceSms: { enabled: true, delayMinutes: 0, maxAgeHours: 24 } });
  const f = await srv.fixture({ zones: 4, email: "truthful@example.com", phone: "9055550161" });
  await srv.prepClosing(f.wo.id, { paidOnSite: false });
  const mark = srv.outbox().length;
  const now = new Date().toISOString();
  const done = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
  ok(done.status === 200, `setup: a Bill-later closing finishes (${done.status})`);
  await sleep(1200);
  const inv = srv.data("invoices").find((i) => i.woId === f.wo.id);
  ok(inv?.status === "draft" && !inv?.sentAt, `setup: its invoice is an unsent draft (${inv?.status})`);

  // ---- A. no untrue text ----------------------------------------------------------
  const texts = srv.outbox().slice(mark).filter((m) => m.channel === "sms");
  ok(!texts.some((m) => /emailed/i.test(m.body)), `A. no text says the invoice was emailed (${j(texts.map((m) => m.body))})`);
  ok(texts.length === 0, `A. no invoice text at all while nothing has been emailed (${texts.length})`);
  ok((inv?.history || []).some((h) => h.action === "customer_sms_skipped_not_emailed"), `A. the skip is on the invoice's history (${j((inv?.history || []).map((h) => h.action))})`);
  ok(!inv?.customerSmsScheduledAt && !inv?.customerSmsSentAt, `A. nothing is left scheduled for the sweep to send later (${j([inv?.customerSmsScheduledAt, inv?.customerSmsSentAt])})`);

  // ---- B. the completion email still promises the invoice --------------------------
  const mail = srv.outbox().slice(mark).find((m) => m.channel === "email" && m.to === f.cust.email);
  ok(mail && /An invoice will follow/.test(mail.html), "B. the completion email still says an invoice will follow");

  // ---- C. Send is unchanged ----------------------------------------------------------
  const mark2 = srv.outbox().length;
  const sent = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
  ok(sent.status === 200 && sent.body.invoice?.status === "sent", `C. Send emails the invoice (${sent.status})`);
  await sleep(600);
  ok(srv.outbox().slice(mark2).some((m) => m.channel === "email" && m.to === f.cust.email && /Your invoice/.test(m.subject)), "C. …the invoice email goes out");
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`invoice-text-truthful: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

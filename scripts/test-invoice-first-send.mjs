#!/usr/bin/env node
// scripts/test-invoice-first-send.mjs
//
// INV-SEND-01 (P-PJL-22, requirement A): the invoice PDF a customer is
// emailed says what the invoice IS, never "DRAFT".
//
// The defect (Patrick, 2026-10-05, a customer's phone): the first email of
// every invoice carried a PDF stamped DRAFT. /api/invoices/:id/send rendered
// the PDF from the record while it was still a draft, emailed it, and only
// then flipped the status to sent. Two neighbours of the same rule, found
// while reproducing it:
//   - a sent invoice "due on completion" is stamped OVERDUE the moment it is
//     drawn: invoices store no due date, so the PDF's due date is the
//     creation instant and any later render is "past due". Every resend says
//     OVERDUE.
//   - a part-paid invoice is stamped DRAFT: resolveStatus() names sent, paid
//     and void, and everything else falls through to Draft.
//
// What must hold:
//   A1. the first-send PDF is the customer copy as it will be once sent:
//       the stamp below, dated the send, no DRAFT, no OVERDUE.
//   A2. the status is committed only after the email succeeds; a failed
//       email leaves the invoice a draft, unsent, with no "sent" history.
//   A3. a resend says the same stamp, still not OVERDUE on the day.
//   A4. a part-paid invoice's PDF does not say DRAFT.
//
// A1, A3 and A4 FAIL on main at 9d36363f (DRAFT / OVERDUE / DRAFT). A2 passes
// there and is pinned so the fix cannot break it.
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
// Run: node scripts/test-invoice-first-send.mjs

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";
import { readPdf } from "./lib/pdf-text.mjs";

// ---- Customer-facing wording (PROPOSED — awaiting Patrick's approval) ----
// One place, so the approved words are a one-line change.
const STAMP_UNPAID = "PAYMENT DUE";
const STAMP_PART_PAID = "PART PAID";
const NEVER = ["DRAFT", "OVERDUE"];

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());

const srv = await bootServer({ port: 4951 });
try {
  await srv.login();
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;
  const draftFor = async ({ paidOnSite = false } = {}) => {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const now = new Date().toISOString();
    const c = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
    if (c.status !== 200) throw new Error(`closing failed ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    if (!inv) throw new Error("the cascade drafted no invoice");
    return inv;
  };
  // The emails carrying this invoice's PDF (the completion email to the
  // same customer carries the report, not the invoice).
  const invoiceMails = (inv) => srv.outbox().filter((m) => m.channel === "email" && m.to.includes(inv.customerEmail)
    && (m.attachments || []).some((a) => a.filename.includes(inv.id)));
  // The invoice PDF of the newest of them.
  const lastPdfTo = (inv) => {
    const mail = invoiceMails(inv).pop();
    const att = mail?.attachments?.find((a) => a.filename.includes(inv.id));
    return att ? { mail, ...readPdf(fs.readFileSync(att.path)) } : { mail, text: "", links: [] };
  };
  const stampOf = (text) => {
    // The stamp is the line after "Total"'s amount block: the last line in
    // the heading font that is a known status word, followed by a date.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i > 0; i--) if (/^\d{4}-\d{2}-\d{2}$/.test(lines[i]) && /^[A-Z ]+$/.test(lines[i - 1])) return { label: lines[i - 1], date: lines[i] };
    return { label: null, date: null };
  };

  // ---- A1. first send ----------------------------------------------------
  {
    const inv = await draftFor();
    ok(inv.status === "draft", `setup: a drafted invoice (${inv.status})`);
    const r = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    ok(r.status === 200, `A1. /send succeeds (${r.status} ${r.body?.errors?.[0] || ""})`);
    const pdf = lastPdfTo(inv);
    ok(pdf.mail && pdf.text.length > 0, "A1. the customer email carries the invoice PDF");
    for (const w of NEVER) ok(!pdf.text.includes(w), `A1. the first-send PDF does not say ${w}`);
    const stamp = stampOf(pdf.text);
    ok(stamp.label === STAMP_UNPAID, `A1. the first-send PDF is stamped "${STAMP_UNPAID}" (got "${stamp.label}")`);
    ok(stamp.date === today, `A1. …dated the send (${stamp.date} vs ${today})`);
    const after = srv.data("invoices").find((i) => i.id === inv.id);
    ok(after.status === "sent" && after.sentAt, `A1. the invoice is sent once the email went (${after.status})`);

    // ---- A3. resend, same day -------------------------------------------------
    const rr = await srv.api("POST", `/api/invoices/${inv.id}/resend`, {});
    ok(rr.status === 200, `A3. /resend succeeds (${rr.status})`);
    const again = lastPdfTo(inv);
    for (const w of NEVER) ok(!again.text.includes(w), `A3. the resent PDF does not say ${w}`);
    ok(stampOf(again.text).label === STAMP_UNPAID, `A3. the resent PDF is stamped "${STAMP_UNPAID}" (got "${stampOf(again.text).label}")`);
  }

  // ---- A2. a failed email leaves the draft --------------------------------
  {
    const inv = await draftFor();
    fs.writeFileSync(`${srv.OUTBOX}.email-fail`, `${inv.customerEmail}\n`);
    const r = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    fs.rmSync(`${srv.OUTBOX}.email-fail`, { force: true });
    ok(r.status >= 400, `A2. a bounced email fails the send (${r.status})`);
    const after = srv.data("invoices").find((i) => i.id === inv.id);
    ok(after.status === "draft", `A2. the invoice stays a draft (${after.status})`);
    ok(!after.sentAt, "A2. …with no sentAt");
    ok(!(after.history || []).some((h) => /sent/.test(String(h.action || "")) && !/sms|junk/.test(String(h.action || ""))), "A2. …and no sent line in its history");
    ok(invoiceMails(inv).length === 0, "A2. no invoice reached the customer");
    const retry = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    ok(retry.status === 200, `A2. the same invoice can be sent once the email works (${retry.status})`);
    for (const w of NEVER) ok(!lastPdfTo(inv).text.includes(w), `A2. the retried send's PDF does not say ${w}`);
  }

  // ---- A4. part paid --------------------------------------------------------
  {
    const inv = await draftFor();
    await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    const half = Math.round(Number(inv.total) * 50) / 100;
    const p = await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: half, method: "cheque" });
    ok(p.status === 201, `setup: a part payment (${p.status} ${p.body?.errors?.[0] || ""})`);
    ok(srv.data("invoices").find((i) => i.id === inv.id).status === "partially_paid", "setup: the invoice is part paid");
    await srv.api("POST", `/api/invoices/${inv.id}/resend`, {});
    const pdf = lastPdfTo(inv);
    for (const w of NEVER) ok(!pdf.text.includes(w), `A4. a part-paid invoice's PDF does not say ${w}`);
    ok(stampOf(pdf.text).label === STAMP_PART_PAID, `A4. it is stamped "${STAMP_PART_PAID}" (got "${stampOf(pdf.text).label}")`);
  }
  // ---- A5. the project-completion email --------------------------------------
  // It attached the invoice by treating generateInvoicePdf as a stream
  // (`pdfDoc.on("data")`); the renderer returns a Promise<Buffer>, so the
  // TypeError was caught and every project-completion email went out with
  // NO invoice PDF. Structural, because no suite completes a project end to
  // end: every caller awaits the Buffer.
  {
    const src = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
    const streamUse = /const (\w+) = (?:invoicePdf\.)?generateInvoicePdf\([^)]*\);\s*[\s\S]{0,200}?\1\.on\(/.test(src);
    ok(!streamUse, "A5. no caller treats generateInvoicePdf as a stream (the project-completion email loses its invoice)");
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`invoice-first-send: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

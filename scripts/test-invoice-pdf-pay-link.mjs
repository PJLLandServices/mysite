#!/usr/bin/env node
// scripts/test-invoice-pdf-pay-link.mjs
//
// INV-LINK-01 (P-PJL-22, requirement B): the invoice PDF's "payment link
// below" is a real, clickable link, to PJL's own pay page.
//
// The defect: the PDF has always said "All major credit cards accepted via
// the secure payment link below." and drawn no link at all (never built:
// git -S finds no doc.link/paymentToken in server/lib/invoice-pdf.js, and
// normalize() drops the paymentToken every caller passes in). The email has
// a "View and pay" button; the PDF, which is what gets printed, forwarded
// and opened later, points at nothing.
//
// What must hold:
//   B1. the PDF a customer is emailed has exactly one link annotation, to
//       PJL's stable pay page /pay/invoice/<id>?t=<paymentToken> on the
//       public base URL — never a Stripe URL — and the link text is printed.
//   B2. through that link an unpaid invoice takes a card (payable, the card
//       form initialises, a charge can start).
//   B3. once paid, the SAME link reads Paid and starts no charge; a paid
//       invoice's PDF carries the same link.
//   B4. no other state exposes a collectible payment through the link:
//       held (holdUntilCompletion), reconciliation (marked paid, ledger
//       short), a $0 invoice, an unsent Bill-later draft.
//
// B1 FAILS on main at 9d36363f (no link). B2–B4 pass there and are pinned:
// adding a link must not widen what the page will charge.
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
// Run: node scripts/test-invoice-pdf-pay-link.mjs

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";
import { readPdf } from "./lib/pdf-text.mjs";

// ---- Customer-facing wording (PROPOSED — awaiting Patrick's approval) ----
const LINK_LABEL = "View and pay online";
const PAID_LINK_LABEL = "View this invoice online";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4953 });
try {
  await srv.login();
  const stored = (id) => srv.data("invoices").find((i) => i.id === id);
  const drafted = async ({ paidOnSite = false } = {}) => {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const now = new Date().toISOString();
    await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
    await sleep(300);
    return srv.data("invoices").find((i) => i.woId === f.wo.id);
  };
  const invoicePdf = (inv) => {
    const mail = srv.outbox().filter((m) => m.channel === "email" && (m.attachments || []).some((a) => a.filename.includes(inv.id))).pop();
    const att = mail?.attachments.find((a) => a.filename.includes(inv.id));
    return att ? readPdf(fs.readFileSync(att.path)) : { text: "", links: [] };
  };
  const payState = async (id, t) => {
    const pub = await srv.api("GET", `/api/pay/invoice/${id}?t=${t}`);
    const sdk = await srv.api("GET", `/api/pay/invoice/${id}/sdk-config?t=${t}`);
    const pi = await srv.api("POST", `/api/pay/invoice/${id}/payment-intent`, { t });
    return { invoice: pub.body.invoice, payable: pub.body.invoice?.payable === true, sdk: sdk.status, pi: pi.status, piBody: pi.body };
  };

  // ---- B1 + B2. the emailed PDF links to the pay page, which takes a card ---
  const inv = await drafted();
  const s = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
  ok(s.status === 200, `setup: sent (${s.status})`);
  const t = stored(inv.id).paymentToken;
  ok(Boolean(t), "setup: the invoice has a payment token");
  const pdf = invoicePdf(inv);
  const expected = `${srv.BASE}/pay/invoice/${encodeURIComponent(inv.id)}?t=${encodeURIComponent(t)}`;
  ok(pdf.links.length === 1, `B1. the PDF has one clickable link (${pdf.links.length})`);
  ok(pdf.links[0]?.uri === expected, `B1. …to PJL's pay page (${pdf.links[0]?.uri || "none"})`);
  ok(!pdf.links.some((l) => /stripe\.com|intuit|quickbooks/i.test(l.uri)), "B1. never a processor's URL");
  ok(pdf.text.includes(LINK_LABEL), `B1. the link is printed as "${LINK_LABEL}"`);
  ok(/link below/.test(pdf.text) ? pdf.links.length > 0 : true, "B1. the PDF never promises a link it does not draw");

  const open = await payState(inv.id, t);
  ok(open.payable && open.sdk === 200 && open.pi === 200, `B2. unpaid: the link takes a card (payable ${open.payable}, sdk ${open.sdk}, intent ${open.pi})`);

  // ---- B3. paid through it: the same link reads Paid, takes nothing ----------
  if (open.piBody.paymentIntentId) {
    srv.stripeSucceed(open.piBody.paymentIntentId);
    const ch = await srv.api("POST", `/api/pay/invoice/${inv.id}/charge`, { t, paymentIntentId: open.piBody.paymentIntentId });
    ok(ch.status === 200 && ch.body.invoice?.status === "paid", `setup: paid by card (${ch.status} ${ch.body.invoice?.status})`);
  }
  const paid = await payState(inv.id, t);
  ok(paid.invoice?.status === "paid", `B3. the same link reads Paid (${paid.invoice?.status})`);
  ok(!paid.payable && paid.pi === 409, `B3. …and starts no second charge (payable ${paid.payable}, intent ${paid.pi})`);
  await srv.api("POST", `/api/invoices/${inv.id}/resend`, {});
  const paidPdf = invoicePdf(inv);
  ok(paidPdf.links.length === 1 && paidPdf.links[0].uri === expected, "B3. a paid invoice's PDF carries the same link");
  ok(paidPdf.text.includes(PAID_LINK_LABEL) && !paidPdf.text.includes(LINK_LABEL), `B3. …labelled "${PAID_LINK_LABEL}", not as a way to pay`);

  // ---- B4. nothing else is collectible through the link ------------------------
  const invoices = srv.lib("invoices.js");
  {
    // An unsent Bill-later draft.
    const d = await drafted({ paidOnSite: false });
    const tok = (await invoices.ensurePaymentToken(d.id)).paymentToken;
    const st = await payState(d.id, tok);
    ok(!st.payable && st.pi === 409, `B4. an unsent Bill-later draft takes no card (payable ${st.payable}, intent ${st.pi})`);
  }
  {
    // Held until the project completes.
    const d = await drafted({ paidOnSite: false });
    const list = srv.data("invoices");
    Object.assign(list.find((i) => i.id === d.id), { holdUntilCompletion: true });
    srv.writeData("invoices", list);
    const tok = (await invoices.ensurePaymentToken(d.id)).paymentToken;
    const st = await payState(d.id, tok);
    ok(!st.payable && st.pi === 409, `B4. a held invoice takes no card (payable ${st.payable}, intent ${st.pi})`);
  }
  {
    // Reconciliation: marked paid before the ledger existed, nothing recorded.
    const d = await drafted({ paidOnSite: false });
    const list = srv.data("invoices");
    Object.assign(list.find((i) => i.id === d.id), { status: "paid", sentAt: new Date().toISOString(), paidAt: new Date().toISOString(), payments: [], amountPaid: 0 });
    srv.writeData("invoices", list);
    const tok = (await invoices.ensurePaymentToken(d.id)).paymentToken;
    const st = await payState(d.id, tok);
    ok(!st.payable && st.pi === 409, `B4. an invoice in reconciliation takes no card (payable ${st.payable}, intent ${st.pi})`);
  }
  {
    // A $0 invoice (an old record, or made by hand): nothing to collect.
    const d = await drafted({ paidOnSite: false });
    const list = srv.data("invoices");
    Object.assign(list.find((i) => i.id === d.id), { status: "sent", sentAt: new Date().toISOString(), total: 0, subtotal: 0, taxAmount: 0, balanceDue: 0,
      lineItems: (list.find((i) => i.id === d.id).lineItems || []).map((l) => ({ ...l, unitPrice: 0, lineTotal: 0 })) });
    srv.writeData("invoices", list);
    const tok = (await invoices.ensurePaymentToken(d.id)).paymentToken;
    const st = await payState(d.id, tok);
    ok(st.pi === 409, `B4. a $0 invoice starts no charge (intent ${st.pi})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`invoice-pdf-pay-link: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
// scripts/test-onsite-payment.mjs
//
// "Take payment now" takes a card on a new invoice (fall-closing fix #3).
//
// The cascade drafts the invoice; the pay page showed the card form and
// Apple Pay; the customer tapped Pay and got `This invoice is "draft" and
// isn't ready for payment.` New customers could not pay by card on site,
// and the "Send invoice" workaround skipped Patrick's review and failed
// outright when Add Stop had no email.
//
// THE PATH CHOSEN (one rule, invoices.isPayableOnline):
//   * A visit signed off "Paid on site" (the new-customer path): tapping
//     Take payment opens the draft for payment ON SITE — stamped, not
//     emailed, still a draft in Patrick's list — and the pay page takes
//     the card. A full payment flips it to paid.
//   * A visit signed off "Bill later" (existing / commercial customers):
//     the draft waits for Patrick. The link is refused, and even a pay
//     link minted some other way shows no card form and takes no charge.
// Also in this area: a fully paid draft reads Paid; "Send again" uses
// /resend; the invoice screen re-reads when the app returns from Safari.
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
//
// Run: node scripts/test-onsite-payment.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4864 });
try {
  await srv.login();
  const complete = async (id) => srv.api("PATCH", `/api/work-orders/${id}`, {
    status: "completed", signature: SIGNATURE, arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString()
  });
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;
  const tokenOf = (url) => new URL(url).searchParams.get("t");

  // ---- A. new customer, NO email, "Paid on site" -----------------------
  {
    const f = await srv.fixture({ email: "" });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const c = await complete(f.wo.id);
    ok(c.status === 200, `the closing completes (${c.status})`);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    ok(inv?.status === "draft", `the cascade drafted the invoice (${inv?.status})`);

    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 200 && link.body.url, `Take payment gets a pay link (${link.status} ${link.body.errors?.[0] || ""})`);
    const t = link.body.url ? tokenOf(link.body.url) : "";
    const afterOpen = invoiceFor(f.wo.id);
    ok(afterOpen?.status === "draft", "opening it for payment does not send it — still a draft in Patrick's list");
    ok(Boolean(afterOpen?.onSitePayment?.openedAt), "…stamped as opened for payment on site");

    const pub = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${t}`);
    ok(pub.body.invoice?.payable === true, "the pay page is told it may take a card");
    const sdk = await srv.api("GET", `/api/pay/invoice/${inv.id}/sdk-config?t=${t}`);
    ok(sdk.status === 200, `the card form initialises (${sdk.status})`);
    const pi = await srv.api("POST", `/api/pay/invoice/${inv.id}/payment-intent`, { t });
    ok(pi.status === 200 && pi.body.clientSecret, `Pay is accepted, not "draft isn't ready" (${pi.status} ${pi.body.errors?.[0] || ""})`);

    if (pi.body.paymentIntentId) {
      srv.stripeSucceed(pi.body.paymentIntentId);
      const ch = await srv.api("POST", `/api/pay/invoice/${inv.id}/charge`, { t, paymentIntentId: pi.body.paymentIntentId });
      ok(ch.status === 200 && ch.body.invoice?.status === "paid", `the card payment lands and the invoice is paid (${ch.status} ${ch.body.invoice?.status})`);
    }
    const staff = await srv.api("GET", `/api/invoices/${inv.id}`);
    ok(staff.body.invoice?.status === "paid" && Number(staff.body.invoice?.balanceDue) === 0,
      `the invoice screen's read says Paid, nothing owing (${staff.body.invoice?.status})`);
    const custMail = srv.outbox().filter((m) => m.channel === "email" && m.to && m.to !== "stub@pjl.test" && !/info@pjl/i.test(m.to));
    ok(custMail.length === 0, "no customer email was needed, or sent");
  }

  // ---- B. "Bill later": Patrick's review stays intact ------------------
  {
    const f = await srv.fixture({ email: "billed@example.com" });
    await srv.prepClosing(f.wo.id, { paidOnSite: false });
    await complete(f.wo.id);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 409 && link.body.code === "needs_review", `a Bill-later draft is not opened for payment (${link.status} ${link.body.code})`);
    ok(invoiceFor(f.wo.id)?.status === "draft" && !invoiceFor(f.wo.id)?.onSitePayment, "…and is left exactly as a draft for review");

    // A pay link minted some other way still must not show a card form it
    // would refuse.
    const withToken = await srv.lib("invoices.js").ensurePaymentToken(inv.id);
    const t = withToken.paymentToken;
    const pub = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${t}`);
    ok(pub.body.invoice?.payable === false, "the pay page is told NOT to show the card form");
    const sdk = await srv.api("GET", `/api/pay/invoice/${inv.id}/sdk-config?t=${t}`);
    ok(sdk.status === 409, `the card form does not initialise (${sdk.status})`);
    const pi = await srv.api("POST", `/api/pay/invoice/${inv.id}/payment-intent`, { t });
    ok(pi.status === 409, `and no charge can be started (${pi.status})`);

    // Send, then "Send again": /send refuses a non-draft, /resend works.
    const s1 = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    ok(s1.status === 200, `Patrick sends it (${s1.status} ${s1.body.errors?.[0] || ""})`);
    const again = await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    ok(again.status === 409, "…a second /send is refused (why Send again must not use it)");
    const re = await srv.api("POST", `/api/invoices/${inv.id}/resend`, {});
    ok(re.status === 200, `…and /resend re-emails it (${re.status} ${re.body.errors?.[0] || ""})`);
    const sentLink = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(sentLink.status === 200, "once sent, Take payment works as it always did");
  }

  // ---- C. money recorded by hand on a draft ---------------------------
  {
    const f = await srv.fixture({ email: "" });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    await complete(f.wo.id);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    const half = Math.round(inv.total * 50) / 100;
    await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: half, method: "cash", receivedAt: new Date().toISOString() });
    ok(invoiceFor(f.wo.id)?.status === "draft", "a PART payment on a draft leaves it a draft for Patrick");
    const rest = Math.round((inv.total - half) * 100) / 100;
    const r = await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: rest, method: "e_transfer", receivedAt: new Date().toISOString() });
    ok(r.body.invoice?.status === "paid", `the payment that settles it flips it to Paid (${r.body.invoice?.status})`);

    // Round 2 (breaker): a never-sent invoice whose money goes away goes
    // back to Patrick's drafts — not "paid" with $0 in, not a partially_paid
    // that /send refuses.
    const pid = r.body.invoice?.payments?.at(-1)?.id;
    const down = await srv.api("PATCH", `/api/invoices/${inv.id}/payments/${pid}`, { amount: 1 });
    ok(down.status === 200 && invoiceFor(f.wo.id)?.status === "draft", `a payment corrected down puts a never-sent invoice back to draft (${invoiceFor(f.wo.id)?.status})`);
    const all = invoiceFor(f.wo.id).payments || [];
    for (const p of all) await srv.api("DELETE", `/api/invoices/${inv.id}/payments/${p.id}`);
    const now = invoiceFor(f.wo.id);
    ok(now.status === "draft" && !now.paidAt, `every payment reversed: draft, not "paid" with $0 received (${now.status})`);
  }
  {
    const f = await srv.fixture({ email: "" });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    await complete(f.wo.id);
    await sleep(300);
    const inv = invoiceFor(f.wo.id);
    const p = await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: inv.total, method: "cash", receivedAt: new Date().toISOString() });
    ok(p.body.invoice?.status === "paid", "control: full cash on a draft reads Paid");
    const pid = p.body.invoice?.payments?.at(-1)?.id;
    await srv.api("DELETE", `/api/invoices/${inv.id}/payments/${pid}`);
    ok(invoiceFor(f.wo.id)?.status === "draft", `the cash reversed: back to draft (${invoiceFor(f.wo.id)?.status})`);
  }
} finally {
  await srv.stop();
}

// ---- the app: invoice screen -------------------------------------------
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const SCREEN = read("pjl-field/src/screens/InvoiceScreen.js");
  const API = read("pjl-field/src/api.js");
  ok(/export const resendInvoice = \(id\) =>\s*sendJson\(`\/api\/invoices\/\$\{encodeURIComponent\(id\)\}\/resend`/.test(API),
    "the app has a resend call");
  ok(/alreadySent\(invoice\) \|\| sentAt\) await resendInvoice\(invoiceId\)/.test(SCREEN),
    "Send again uses /resend for an invoice that already went out");
  ok(/AppState\.addEventListener\('change'/.test(SCREEN) && /getInvoice\(invoiceId\)\.then\(setInvoice\)/.test(SCREEN),
    "the invoice screen re-reads when the app comes back from Safari");
  ok(/invoice\?\.status === 'paid'/.test(SCREEN) && /owing <= 0\.01/.test(SCREEN),
    "a settled invoice reads Paid and offers no Send / Take payment");
  ok(/paidOnSiteAtCompletion !== true/.test(SCREEN), "Take payment is not offered on a Bill-later draft");
  const requireFromApp = createRequire(path.join(ROOT, "pjl-field/package.json"));
  let babel = null;
  try { babel = requireFromApp("@babel/core"); } catch {}
  ok(Boolean(babel), "the app dependencies are installed (npm ci in pjl-field)");
  if (babel) {
    for (const rel of ["pjl-field/src/screens/InvoiceScreen.js", "pjl-field/src/api.js"]) {
      try {
        babel.parse(read(rel), { filename: rel, parserOpts: { sourceType: "module", plugins: ["jsx"] }, babelrc: false, configFile: false });
        ok(true, rel);
      } catch (e) { ok(false, `${rel} parses: ${e.message}`); }
    }
  }
}

console.log(`onsite-payment: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

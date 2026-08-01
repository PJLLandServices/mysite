#!/usr/bin/env node
// Regression tests for the "customer sees the balance, not the total"
// fixes (Aug 2026).
//
// The bug this guards against: an invoice with money already collected
// (cash on site, recorded before the invoice was even sent) showed the
// full total on every customer-facing surface while Stripe was set up to
// charge only the outstanding balance. The pay page offered
// "Pay $2,260.00" against a $1,760.00 card charge.
//
// Pure-function tests only — no server, no network. Each one pins a
// specific surface's arithmetic or template output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? " — " + detail : ""}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------
// 1. Ledger arithmetic + the send-time status re-derive (lib/invoices)
// ---------------------------------------------------------------------
const invoices = require(path.join(root, "server", "lib", "invoices.js"));

{
  // The exact shape of Daniel's I-2026-0057.
  const daniel = { total: 2260, payments: [{ id: "pmt_1", amount: 500, method: "cash" }] };
  eq("amountPaid sums the ledger", invoices.amountPaidOf(daniel), 500);
  eq("balanceDue = total - paid", invoices.balanceDueOf(daniel), 1760);

  // Send-time re-derive: this is the case the old code got wrong —
  // cash recorded while still a draft, then sent.
  eq("draft + payment, on send -> partially_paid",
    invoices.statusForPayments(daniel, "sent"), "partially_paid");

  // Paid in full on site -> straight to paid on send.
  const settled = { total: 2260, payments: [{ id: "p", amount: 2260, method: "cash" }] };
  eq("fully paid on site, on send -> paid", invoices.statusForPayments(settled, "sent"), "paid");
  eq("fully paid balance is zero", invoices.balanceDueOf(settled), 0);

  // No payments -> untouched. This is the no-regression case.
  const clean = { total: 903.83, payments: [] };
  eq("no payments -> stays sent", invoices.statusForPayments(clean, "sent"), "sent");
  eq("no payments -> balance equals total", invoices.balanceDueOf(clean), 903.83);
  eq("no payments -> amountPaid zero", invoices.amountPaidOf(clean), 0);

  // Draft and void are never re-derived by status alone.
  eq("draft stays draft", invoices.statusForPayments(daniel, "draft"), "draft");
  eq("void stays void", invoices.statusForPayments(daniel, "void"), "void");

  // Overpayment never produces a negative charge.
  eq("overpayment floors at zero",
    invoices.balanceDueOf({ total: 100, payments: [{ id: "p", amount: 150 }] }), 0);

  // Within-a-cent tolerance counts as settled.
  eq("penny short still settles",
    invoices.statusForPayments({ total: 100, payments: [{ id: "p", amount: 99.995 }] }, "sent"), "paid");

  // partially_paid must remain a payable state — the payment-intent
  // route gates on this set, and excluding it would lock a deposit
  // customer out of paying the rest online.
  ok("partially_paid is a valid status", invoices.STATUSES.includes("partially_paid"));
}

// ---------------------------------------------------------------------
// 2. Client surfaces read balanceDue, not total
// ---------------------------------------------------------------------
const payJs = readFileSync(path.join(root, "server", "pay.js"), "utf8");
const portalJs = readFileSync(path.join(root, "server", "portal-invoice.js"), "utf8");

ok("pay.js charge button uses the balance", /\$chargeBtnAmount\.textContent\s*=\s*fmt\(balanceDue\)/.test(payJs));
ok("pay.js no longer prints the total on the charge button", !/\$chargeBtnAmount\.textContent\s*=\s*fmt\(inv\.total\)/.test(payJs));
ok("pay.js derives balanceDue with a total fallback", /inv\.balanceDue\s*==\s*null\s*\?\s*total\s*:/.test(payJs));
ok("pay.js hides the form when nothing is owed", /balanceDue\s*<=\s*0/.test(payJs));
ok("portal quotes the balance on the Pay button", /Pay \$\{escapeHtml\(fmtMoney\(pinvDue\)\)\}/.test(portalJs));
ok("portal no longer quotes the total on the Pay button", !/Pay \$\{escapeHtml\(fmtMoney\(invoice\.total\)\)\}/.test(portalJs));
ok("portal hides the pay section when nothing is owed", /pinvDue\s*<=\s*0/.test(portalJs));

// The ledger rows must exist in both templates, and start hidden so a
// zero-payment invoice renders exactly as it did before.
const payHtml = readFileSync(path.join(root, "server", "pay.html"), "utf8");
const portalHtml = readFileSync(path.join(root, "server", "portal-invoice.html"), "utf8");
for (const [label, html, ids] of [
  ["pay page", payHtml, ["payAmountPaidRow", "payAmountDue"]],
  ["portal", portalHtml, ["pinvAmountPaidRow", "pinvAmountDue"]]
]) {
  for (const id of ids) ok(`${label} has #${id}`, html.includes(`id="${id}"`));
  ok(`${label} ledger rows start hidden`, new RegExp(`id="${ids[0]}"[^>]*hidden`).test(html));
}

// ---------------------------------------------------------------------
// 3. Public API payloads carry the scalars but never the raw ledger
// ---------------------------------------------------------------------
const serverJs = readFileSync(path.join(root, "server", "server.js"), "utf8");
const payloadCount = (serverJs.match(/balanceDue: inv\.balanceDue == null \? inv\.total : Number\(inv\.balanceDue\)/g) || []).length;
eq("both public payloads expose balanceDue", payloadCount, 2);
eq("both public payloads expose amountPaid",
  (serverJs.match(/amountPaid: Number\(inv\.amountPaid\) \|\| 0/g) || []).length, 2);
// payments[] carries staff uids and internal notes — never public.
ok("public payloads do not expose the raw payments array",
  !/payments: inv\.payments/.test(serverJs));
ok("payment-intent admits partially_paid",
  /inv\.status !== "sent" && inv\.status !== "partially_paid"/.test(serverJs));

// ---------------------------------------------------------------------
// 4. Email template + variable wiring
// ---------------------------------------------------------------------
const emailTpl = readFileSync(path.join(root, "server", "lib", "templates", "invoice-email.html"), "utf8");
const notify = readFileSync(path.join(root, "server", "lib", "notify-customer.js"), "utf8");

ok("email header quotes the amount due", emailTpl.includes("{{invoice.amountDueFormatted}} · due on completion"));
ok("email body quotes the amount due", /for\s*\n?\s*<strong>\{\{invoice\.amountDueFormatted\}\}<\/strong> is attached/.test(emailTpl));
ok("plain-text body quotes the amount due", emailTpl.includes("for {{invoice.amountDueFormatted}} is attached as a PDF."));
ok("plain-text body carries the breakdown slot", emailTpl.includes("{{invoice.paidLineText}}"));
ok("breakdown block is display-toggled", emailTpl.includes("display:{{invoice.paidBlockVisible}}"));
ok("breakdown block still shows the true invoice total", emailTpl.includes("Invoice total"));
ok("subject line uses the amount due", /subject = `\$\{subjectPrefix\} \$\{invoice\.id \|\| ""\} — \$\{amountDueFormatted\}/.test(notify));
ok("notify derives amountDue with a total fallback", /invoice\.balanceDue == null \? invTotal : Number\(invoice\.balanceDue\)/.test(notify));

// Render the template the way notify-customer does, for both cases.
function render(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, dotted) => {
    let cur = vars;
    for (const p of dotted.split(".")) { if (cur == null) return ""; cur = cur[p]; }
    return cur == null ? "" : String(cur);
  });
}
{
  const withPayment = render(emailTpl, {
    customer: { firstName: "Daniel" },
    invoice: {
      number: "I-2026-0057", totalFormatted: "$2,260.00", amountDueFormatted: "$1,760.00",
      amountPaidFormatted: "$500.00", paidBlockVisible: "block", paidLineText: "Amount due: $1,760.00\n\n"
    }
  });
  ok("rendered email shows $1,760.00", withPayment.includes("$1,760.00"));
  ok("rendered email keeps $2,260.00 as the invoice total", withPayment.includes("$2,260.00"));
  ok("rendered email shows the breakdown", withPayment.includes("display:block"));
  ok("rendered email leaves no unsubstituted vars", !/\{\{/.test(withPayment));

  const noPayment = render(emailTpl, {
    customer: { firstName: "Someone" },
    invoice: {
      number: "I-2026-0058", totalFormatted: "$903.83", amountDueFormatted: "$903.83",
      amountPaidFormatted: "$0.00", paidBlockVisible: "none", paidLineText: ""
    }
  });
  ok("unpaid email hides the breakdown", noPayment.includes("display:none"));
  ok("unpaid email quotes the one figure", noPayment.includes("$903.83"));
  ok("unpaid email leaves no unsubstituted vars", !/\{\{/.test(noPayment));
  ok("unpaid email has no stray minus line", !noPayment.includes("-$0.00\n"));
}

// ---------------------------------------------------------------------
console.log(`\ninvoice balance surfaces: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(1);
}

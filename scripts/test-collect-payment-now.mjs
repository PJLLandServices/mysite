#!/usr/bin/env node
// scripts/test-collect-payment-now.mjs
//
// TTP-COLLECT-01 (P-PJL-22, requirement C): choosing how the customer pays
// at sign-off, and Tap to Pay on iPhone without sending the invoice first.
//
// The defect (Patrick, 2026-10-05, two houses): Tap to Pay would not come up
// until the invoice had been emailed. The sign-off question offered "Paid on
// site" / "Bill later"; "Paid on site" reads as "they have already paid", so
// with the customer standing there unpaid the honest-sounding answer was
// "Bill later" — which hides Tap to Pay and Take payment now
// (InvoiceScreen payableHere) and makes the server refuse a card
// (invoices.openForOnSitePayment → needs_review) until the invoice is sent.
//
// What must hold:
//   C1. the choice reads "Collect payment now" / "Send invoice / bill later"
//       on every surface that asks it (the field app, the tech web page, the
//       office work-order page) and in the server's sign-off blocker.
//   C2. Collect payment now → Tap to Pay and Take payment now work on the
//       DRAFT, nothing emailed (server: terminal-intent and payment-link).
//   C3. Bill later → both refused until something explicit happens.
//   C4. "Take payment now instead" (admin only): switches a Bill-later
//       draft to collect now, still a draft, still not emailed, with who and
//       when in its history; Tap to Pay then works. A tech is refused.
//   C5. the switch never gets past the existing guards: a price PJL has not
//       confirmed, a paid or void invoice, a $0 invoice are still refused.
//   C6. the phone's buttons come from ONE rule (pjl-field/src/invoice-actions.mjs)
//       that the invoice screen uses: Collect now → Tap to Pay before Send;
//       Bill later → no Tap to Pay, and "Take payment now instead" for an
//       admin only.
//
// C1, C4, C6 FAIL on main at 9d36363f (old labels; no route; no module).
// C2, C3, C5 pass there and are pinned.
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
// Run: node scripts/test-collect-payment-now.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ---- Customer/tech-facing wording (Patrick, 2026-10-05) ---------------------
const COLLECT = "Collect payment now";
const BILL = "Send invoice / bill later";
const INSTEAD = "Take payment now instead";
// The new route (PROPOSED).
const SWITCH = (id) => `/api/invoices/${id}/collect-now`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- C1. the words, everywhere the question is asked ---------------------------
{
  const surfaces = {
    "field app sign-off": "pjl-field/src/screens/closing/SignOffStage.js",
    "tech web page": "server/work-order-tech.html",
    "office work-order page": "server/work-order.html"
  };
  for (const [name, file] of Object.entries(surfaces)) {
    const src = read(file);
    ok(src.includes(COLLECT) && src.includes(BILL), `C1. ${name} asks "${COLLECT}" / "${BILL}"`);
    ok(!/['">]\s*(Paid on site|Bill later|Yes — paid in the field|No — invoice to follow)\s*['"<]/.test(src), `C1. ${name} no longer offers the old labels`);
  }
  for (const file of ["server/server.js", "server/work-order-tech.js", "server/work-order.js"]) {
    ok(!read(file).includes("paid on site or bill later"), `C1. ${file}'s sign-off blocker uses the new words`);
  }
}

// ---- C6. one rule for the phone's buttons -----------------------------------------
{
  let actions = null;
  try { ({ invoiceActions: actions } = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/invoice-actions.mjs")).href)); }
  catch (err) { ok(false, `C6. pjl-field/src/invoice-actions.mjs exports invoiceActions (${err.code || err.message})`); }
  if (typeof actions === "function") {
    const draft = { status: "draft", total: 100, balanceDue: 100, amountPaid: 0 };
    const collect = { ...draft, paidOnSiteAtCompletion: true };
    const bill = { ...draft, paidOnSiteAtCompletion: false };
    const a = actions(collect, { role: "admin" });
    ok(a.tapToPay && a.takePayment && a.send && !a.takePaymentInstead, `C6. Collect payment now: Tap to Pay and Take payment now before Send (${JSON.stringify(a)})`);
    const b = actions(bill, { role: "admin" });
    ok(!b.tapToPay && !b.takePayment && b.takePaymentInstead && b.send, `C6. Bill later (admin): no Tap to Pay, "${INSTEAD}" offered (${JSON.stringify(b)})`);
    const bt = actions(bill, { role: "tech" });
    ok(!bt.tapToPay && !bt.takePayment && !bt.takePaymentInstead, `C6. Bill later (tech): nothing to collect, no switch (${JSON.stringify(bt)})`);
    const switched = actions({ ...bill, onSitePayment: { openedAt: "2026-10-05T12:00:00Z" } }, { role: "admin" });
    ok(switched.tapToPay && switched.takePayment && !switched.takePaymentInstead, "C6. after the switch: Tap to Pay");
    ok(actions({ ...bill, status: "sent", sentAt: "x" }, { role: "admin" }).tapToPay, "C6. a sent invoice: Tap to Pay");
    const paid = actions({ ...collect, status: "paid", balanceDue: 0, amountPaid: 100 }, { role: "admin" });
    ok(!paid.tapToPay && !paid.takePayment && !paid.send && !paid.takePaymentInstead, "C6. paid: nothing to collect");
    const unpriced = actions({ ...bill, priceUnconfirmed: true }, { role: "admin" });
    ok(!unpriced.tapToPay && !unpriced.takePayment && !unpriced.takePaymentInstead && !unpriced.send, "C6. price not confirmed: nothing to collect or send");
  }
  const screen = read("pjl-field/src/screens/InvoiceScreen.js");
  ok(/from ['"]\.\.\/invoice-actions\.mjs['"]/.test(screen) && /invoiceActions\(/.test(screen), "C6. the invoice screen uses invoiceActions (no second copy of the rule)");
  ok(screen.includes(INSTEAD), `C6. the invoice screen offers "${INSTEAD}"`);
}

// ---- C2–C5. the server ----------------------------------------------------------
const srv = await bootServer({ port: 4955 });
try {
  await srv.login();
  const stored = (id) => srv.data("invoices").find((i) => i.id === id);
  const drafted = async ({ paidOnSite }) => {
    const f = await srv.fixture();
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const now = new Date().toISOString();
    await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now, departedAt: now });
    await sleep(300);
    return srv.data("invoices").find((i) => i.woId === f.wo.id);
  };
  const invoiceMails = (inv) => srv.outbox().filter((m) => m.channel === "email" && (m.attachments || []).some((a) => a.filename.includes(inv.id)));

  // C2. Collect payment now
  {
    const inv = await drafted({ paidOnSite: true });
    const tap = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
    ok(tap.status === 200 && tap.body.clientSecret, `C2. Collect payment now: Tap to Pay starts on the draft (${tap.status} ${tap.body.code || ""})`);
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 200, `C2. …and Take payment now (${link.status})`);
    ok(stored(inv.id).status === "draft" && invoiceMails(inv).length === 0, "C2. …without sending the invoice");
  }

  // C3 + C4. Bill later, then the admin switch
  {
    const inv = await drafted({ paidOnSite: false });
    const tap = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
    ok(tap.status === 409 && tap.body.code === "needs_review", `C3. Bill later: Tap to Pay refused (${tap.status} ${tap.body.code})`);
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 409, `C3. …and Take payment now (${link.status})`);

    await srv.login({ role: "tech" });
    const techTry = await srv.api("POST", SWITCH(inv.id), {});
    ok(techTry.status === 403, `C4. a tech cannot switch it (${techTry.status})`);
    await srv.login();
    const sw = await srv.api("POST", SWITCH(inv.id), {});
    ok(sw.status === 200, `C4. ${INSTEAD}: the admin switch (${sw.status} ${sw.body?.errors?.[0] || ""})`);
    const after = stored(inv.id);
    ok(after.status === "draft" && !after.sentAt, `C4. still a draft, not sent (${after.status})`);
    ok(invoiceMails(inv).length === 0, "C4. nothing emailed");
    const h = (after.history || []).find((x) => x.action === "switched_to_collect_now");
    ok(h && h.by && h.ts, `C4. history says who switched it and when (${JSON.stringify(h || null)})`);
    const tap2 = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
    ok(tap2.status === 200 && tap2.body.clientSecret, `C4. Tap to Pay then starts (${tap2.status} ${tap2.body.code || ""})`);
  }

  // C5. the guards still hold through the switch
  {
    const inv = await drafted({ paidOnSite: false });
    const list = srv.data("invoices");
    Object.assign(list.find((i) => i.id === inv.id), { priceConfirm: { required: true, reason: "custom_size" } });
    srv.writeData("invoices", list);
    const sw = await srv.api("POST", SWITCH(inv.id), {});
    const tap = await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
    ok(sw.status === 409 && tap.status === 409, `C5. a price PJL has not confirmed: no switch, no charge (${sw.status}, ${tap.status})`);
  }
  {
    const inv = await drafted({ paidOnSite: false });
    const list = srv.data("invoices");
    Object.assign(list.find((i) => i.id === inv.id), { status: "void", voidedAt: new Date().toISOString() });
    srv.writeData("invoices", list);
    const sw = await srv.api("POST", SWITCH(inv.id), {});
    ok(sw.status === 409, `C5. a void invoice cannot be switched (${sw.status})`);
  }
  {
    const inv = await drafted({ paidOnSite: false });
    await srv.api("POST", `/api/invoices/${inv.id}/send`, {});
    const sw = await srv.api("POST", SWITCH(inv.id), {});
    ok(sw.status === 409, `C5. a sent invoice needs no switch — refused, nothing changed (${sw.status})`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`collect-payment-now: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

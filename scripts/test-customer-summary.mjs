#!/usr/bin/env node
// scripts/test-customer-summary.mjs
//
// "I don't even know what I'm signing for" — a customer on a driveway,
// 2026-10-01, at the moment of signing and paying. Patrick: "I want the
// ability, immediately when somebody says that, to pull up the invoice."
//
// WHAT WAS MISSING: the sign-off screen showed a single "Closing fee" line
// below the signature pad, and the invoice screen showed only the total.
// Nothing listed the work done or the charges, item by item, in a form the
// customer could read.
//
// THE RULE: GET /api/work-orders/:id/customer-summary is the customer's
// view of a visit. Before Finish it previews the invoice from
// billing.billingFor (the SAME call Finish drafts the invoice from); after
// Finish it reads the invoice itself. So the summary shown before signing
// is the invoice billed after — and a price PJL confirms after the visit
// shows no number at all, in either state.
//
// Run: node scripts/test-customer-summary.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 300);
const walk = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, location: `Zone ${from + i}`, status: "working_well" }));
const now = () => new Date().toISOString();

// ---- the app opens it from both places --------------------------------------
{
  const read = (p) => { try { return fs.readFileSync(new URL(`../pjl-field/src/${p}`, import.meta.url), "utf8"); } catch { return ""; } };
  const api = read("api.js");
  const sheet = read("screens/CustomerSummary.js");
  const signOff = read("screens/closing/SignOffStage.js");
  const invoice = read("screens/InvoiceScreen.js");
  ok(/\/api\/work-orders\/\$\{encodeURIComponent\(workOrderId\)\}\/customer-summary/.test(api), "app: getCustomerSummary reads the server's summary");
  ok(/getCustomerSummary\(/.test(sheet) && /<Modal\b/.test(sheet), "app: the customer view is a full-screen sheet fed by the server");
  ok(/<CustomerSummary\b/.test(signOff) && /what they're signing/i.test(signOff), "app: the sign-off screen opens it ('what they're signing')");
  ok(/<CustomerSummary\b/.test(invoice) && /Show the customer/i.test(invoice), "app: the invoice screen opens it ('Show the customer')");
  ok(sheet && !/\$\s?\d/.test(sheet), "app: the sheet types no price — every amount comes from the server");
}

const srv = await bootServer({ port: 4952 });
try {
  await srv.login();
  const summary = (id) => srv.api("GET", `/api/work-orders/${id}/customer-summary`);
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId) || null;

  // ---- 1 before signing: the invoice to come, line by line ----------------
  const f = await srv.fixture({ zones: 4, name: "Debra Calandra" });
  await srv.prepClosing(f.wo.id, { extraZones: walk(5, 6), issues: true });
  const before = await summary(f.wo.id);
  const b = before.body.summary;
  ok(before.status === 200 && before.body.ok && b, `1: the summary answers before signing (${before.status} ${j(before.body)})`);
  ok(b?.source === "preview" && b?.invoiceId === null, `1: …as a preview, no invoice yet (${j({ source: b?.source, invoiceId: b?.invoiceId })})`);
  ok(b?.customerName === "Debra Calandra" && /Hilton Blvd/.test(b?.address || "") && b?.serviceLabel === "Fall Closing", `1: …names the customer, property and service (${j({ n: b?.customerName, a: b?.address, s: b?.serviceLabel })})`);
  ok(Array.isArray(b?.zones) && b.zones.length === 6 && b.zones.every((z) => z.number && z.statusLabel), `1: …lists the 6 zones walked, each with what was found (${j(b?.zones)})`);
  ok(b?.zones?.[0]?.repairs?.includes("Sprinkler head"), `1: …and the repair noted on zone 1 for next season (${j(b?.zones?.[0])})`);
  ok(b?.pricePending === false && Array.isArray(b?.lines) && b.lines.length > 0 && b.lines.every((l) => l.label && Number.isFinite(l.lineTotal)), `1: …the charges, item by item (${j(b?.lines)})`);
  ok(Number.isFinite(b?.subtotal) && Number.isFinite(b?.hst) && Math.abs(b.subtotal + b.hst - b.total) < 0.011, `1: …with subtotal + HST = total (${j({ s: b?.subtotal, h: b?.hst, t: b?.total })})`);
  ok(typeof b?.authorization === "string" && /authori[sz]e/i.test(b.authorization), "1: …and the statement the signature makes");

  // ---- 2 sign: what they were shown is what they are billed ---------------
  const r = await srv.qpatch(f.wo.id, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
  ok(r.status === 200, `2: the customer signs and the visit completes (${r.status} ${j(r.body.errors)})`);
  await sleep(300);
  const inv = invoiceFor(f.wo.id);
  ok(inv && b && inv.total === b.total && inv.subtotal === b.subtotal && inv.hst === b.hst, `2: the invoice bills exactly the total they were shown (${j({ shown: b?.total, billed: inv?.total })})`);
  ok(inv && b?.lines && JSON.stringify(inv.lineItems.map((l) => [l.label, l.qty, l.lineTotal])) === JSON.stringify(b.lines.map((l) => [l.label, l.qty, l.lineTotal])), "2: …line for line");

  // ---- 3 after signing: the invoice itself --------------------------------
  const after = (await summary(f.wo.id)).body.summary;
  ok(after?.source === "invoice" && after?.invoiceId === inv?.id, `3: after Finish it reads the invoice (${j({ source: after?.source, id: after?.invoiceId })})`);
  ok(after?.total === inv?.total && after?.balanceDue === inv?.balanceDue && after?.amountPaid === (inv?.amountPaid || 0), `3: …total, paid and owing as the invoice has them (${j({ t: after?.total, due: after?.balanceDue, paid: after?.amountPaid })})`);
  ok(after?.zones?.length === 6, "3: …still with the work done");

  // ---- 4 a price PJL confirms after the visit shows no number -------------
  const c = await srv.fixture({ zones: 4 });
  await srv.prepClosing(c.wo.id, { extraZones: walk(5, 16) });
  const pend = (await summary(c.wo.id)).body.summary;
  ok(pend?.pricePending === true && pend.total === null && pend.subtotal === null && (pend.lines || []).every((l) => l.lineTotal === null && l.unitPrice === null),
    `4: a custom size before signing: no amount anywhere (${j(pend && { p: pend.pricePending, t: pend.total, lines: pend.lines })})`);
  await srv.qpatch(c.wo.id, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
  await sleep(300);
  const pendAfter = (await summary(c.wo.id)).body.summary;
  ok(pendAfter?.source === "invoice" && pendAfter.pricePending === true && pendAfter.total === null && (pendAfter.lines || []).every((l) => l.lineTotal === null),
    `4: …nor after Finish, while the invoice's price is unconfirmed (${j(pendAfter && { s: pendAfter.source, p: pendAfter.pricePending, t: pendAfter.total })})`);

  // ---- 5 refusals --------------------------------------------------------
  const missing = await summary("WO-nope");
  ok(missing.status === 404, `5: an unknown work order is 404 (${missing.status})`);
  const anon = await fetch(`http://127.0.0.1:4952/api/work-orders/${f.wo.id}/customer-summary`);
  ok(anon.status === 401 || anon.status === 403, `5: signed out is refused (${anon.status})`);
} finally {
  await srv.stop();
}

console.log(`\ncustomer summary: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

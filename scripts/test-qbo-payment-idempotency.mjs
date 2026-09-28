#!/usr/bin/env node
// scripts/test-qbo-payment-idempotency.mjs
//
// QuickBooks item 2 (Patrick, 2026-09-28): it is always safe to repeat a
// QuickBooks payment-sync attempt. One distinct PJL/Stripe payment creates at
// most one QuickBooks payment.
//
// WHAT BROKE: quickbooks.recordPaymentForInvoice POSTed a new Payment every
// time it was called — no requestid, no look for an earlier one. Its comment
// claimed "idempotent at the QB end via the chargeId pinned in the payment's
// privateNote"; QuickBooks does not dedupe on a note. So any repeat — a retry
// after QuickBooks accepted the payment but the response was lost, a call
// after a restart that lost the stored QuickBooks payment id — made a second
// QuickBooks payment for the same money.
//
// THE RULE, two layers, each enough on its own:
//   1. a deterministic requestid from the source payment (the Stripe payment
//      id): QuickBooks answers a repeat with the ORIGINAL response (Intuit's
//      documented requestid behaviour — no retention window is published,
//      and it is not guaranteed while the first request is still in flight);
//   2. before creating, read the payments already linked to the QuickBooks
//      invoice (Invoice.LinkedTxn) and reuse the one carrying this source
//      payment's marker (or, for one written before this rule, its Stripe
//      charge id). If that lookup can't be completed, nothing is created.
//
// QuickBooks here is the stub's sandbox host, with a store that survives a
// server restart (scripts/lib/stub-outbound.cjs). Nothing leaves the machine.
//
// Run: node scripts/test-qbo-payment-idempotency.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootServer, finish, invoiceFor, payLink, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---- one rule, in one place --------------------------------------------------------
{
  const qb = fs.readFileSync(new URL("../server/lib/quickbooks.js", import.meta.url), "utf8");
  const fn = qb.slice(qb.indexOf("async function recordPaymentForInvoice("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  ok(/requestid=/.test(body) && /paymentRequestId\(/.test(body), "structure: the payment POST carries a deterministic requestid");
  ok(/findPaymentForSource\(/.test(body) && body.indexOf("findPaymentForSource(") < body.indexOf('method: "POST"'), "structure: …and looks for an earlier payment before it creates one");
  ok(!/Idempotent\s*\n?\/\/\s*at the QB end via the chargeId/.test(qb), "structure: the old \"idempotent via the privateNote\" claim is gone");
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  ok(/sourceRef:\s*summary\.paymentIntentId/.test(server), "structure: the finalizer names the Stripe payment as the source");
}

const QB_ENV = { QB_CLIENT_ID: "stub", QB_CLIENT_SECRET: "stub", QB_ENVIRONMENT: "sandbox" };
const srv = await bootServer({ port: 4950, env: QB_ENV });
try {
  srv.writeData("quickbooks", { access_token: "stub", refresh_token: "stub", realmId: "stub-realm", expires_at: Date.now() + 864e5, refresh_expires_at: Date.now() + 864e6 });
  await srv.login();

  // A repeat of the sync, as a later attempt makes it: the server copy's own
  // QuickBooks library in a NEW process with no memory of the first — the
  // same clean environment and stub (tripwires included) the server gets —
  // against the same stubbed QuickBooks.
  const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib", "stub-outbound.cjs");
  const qbLib = {
    async recordPaymentForInvoice(args) {
      const code = `require(${JSON.stringify(path.join(srv.TMP, "server", "lib", "quickbooks.js"))}).recordPaymentForInvoice(${JSON.stringify(args)})
        .then((r) => process.stdout.write(JSON.stringify({ ok: true, r })), (e) => process.stdout.write(JSON.stringify({ ok: false, error: e.message })));`;
      const out = spawnSync(process.execPath, ["--require", STUB, "-e", code], {
        cwd: srv.TMP, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: srv.TMP, TZ: "America/Toronto", PJL_STUB_OUTBOX: srv.OUTBOX, ...QB_ENV }
      });
      let res;
      try { res = JSON.parse(out.stdout.slice(out.stdout.lastIndexOf('{"ok"'))); } catch { throw new Error(`sync process: ${out.stderr.slice(-600)}`); }
      if (!res.ok) throw new Error(res.error);
      return res.r;
    }
  };

  let n = 0;
  async function visit(label) {
    n += 1;
    const f = await srv.fixture({ zones: 4, email: `qbi${n}@example.com`, name: `Qbi ${label}`, phone: `90555509${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite: true });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    const inv = invoiceFor(srv, f.wo.id);
    const link = await payLink(srv, inv.id);
    const v = { label, inv, t: link.token, qbId: `qbinv_${label}` };
    const all = srv.data("invoices");
    all.find((i) => i.id === inv.id).quickbooksInvoiceId = v.qbId;
    srv.writeData("invoices", all);
    return v;
  }
  const payIntent = (v) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/payment-intent`, { t: v.t });
  const confirm = (v, pi) => srv.api("POST", `/api/pay/invoice/${v.inv.id}/charge`, { t: v.t, paymentIntentId: pi });
  const hook = (v, pi) => srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi, object: "payment_intent", metadata: { invoiceId: v.inv.id } } } });
  const cash = (v, amount) => srv.api("POST", `/api/invoices/${v.inv.id}/payments`, { amount, method: "cash" });
  const read = async (v) => (await srv.api("GET", `/api/invoices/${v.inv.id}`)).body.invoice;
  const settle = () => sleep(700);
  const store = () => { try { return JSON.parse(fs.readFileSync(`${srv.OUTBOX}.qb-store.json`, "utf8")); } catch { return { payments: [] }; } };
  // QuickBooks' side of the truth: payments that exist, linked to this invoice.
  const qbPaymentsFor = (qbId) => store().payments.filter((p) => (p.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === qbId)));
  const posts = (from, qbId) => srv.outbox().slice(from).filter((e) => e.channel === "quickbooks" && e.method === "POST" && /\/payment$/.test(e.path)
    && (e.body?.Line || []).some((l) => (l.LinkedTxn || []).some((t) => t.TxnId === qbId)));
  async function cardPays(v) {
    const pi = (await payIntent(v)).body.paymentIntentId;
    srv.stripeSucceed(pi);
    const c = await confirm(v, pi);
    return { pi, c };
  }

  // ---- 1 normal first post ----------------------------------------------------------
  const a = await visit("A");
  let aPi;
  {
    const m0 = srv.outbox().length;
    ({ pi: aPi } = await cardPays(a));
    const r = await read(a);
    const p = posts(m0, a.qbId);
    ok(p.length === 1 && p[0].requestid === `pjl-pay-${aPi}`, `1: one QuickBooks payment, posted with the requestid pjl-pay-<Stripe payment> (${p.length} ${p[0]?.requestid})`);
    ok(qbPaymentsFor(a.qbId).length === 1 && money(qbPaymentsFor(a.qbId)[0].TotalAmt) === money(a.inv.total), `1: QuickBooks holds exactly one payment, for the amount applied (${qbPaymentsFor(a.qbId).length})`);
    ok(new RegExp(`\\[pjl:${aPi}\\]`).test(qbPaymentsFor(a.qbId)[0]?.PrivateNote || ""), `1: the payment carries the source marker (${qbPaymentsFor(a.qbId)[0]?.PrivateNote})`);
    ok(r.quickbooksPaymentId === qbPaymentsFor(a.qbId)[0]?.Id, `1: PJL records the QuickBooks payment id (${r.quickbooksPaymentId})`);
  }

  // ---- 2 exact retry: the same sync, again ------------------------------------------
  {
    const m0 = srv.outbox().length;
    const again = await qbLib.recordPaymentForInvoice({ qbInvoiceId: a.qbId, amountCents: Math.round(a.inv.total * 100), chargeId: `ch_${aPi}`, sourceRef: aPi });
    ok(qbPaymentsFor(a.qbId).length === 1 && again.id === qbPaymentsFor(a.qbId)[0].Id, `2: repeating the sync returns the same QuickBooks payment (${qbPaymentsFor(a.qbId).length} ${again.id})`);
    ok(posts(m0, a.qbId).length === 0, `2: …found by the lookup, without posting again (${posts(m0, a.qbId).length})`);
  }

  // ---- 3 duplicate Stripe delivery -----------------------------------------------------
  {
    const m0 = srv.outbox().length;
    await hook(a, aPi); await hook(a, aPi); await confirm(a, aPi); await settle();
    ok(posts(m0, a.qbId).length === 0 && qbPaymentsFor(a.qbId).length === 1, `3: webhook ×2 and a second confirm post nothing (${posts(m0, a.qbId).length})`);
  }

  // ---- 4 QuickBooks accepts, the response is lost (a timeout) -----------------------
  const b = await visit("B");
  let bPi;
  {
    srv.quickbooksMode("accept-drop");
    ({ pi: bPi } = await cardPays(b));
    srv.quickbooksMode(null);
    const r = await read(b);
    ok(qbPaymentsFor(b.qbId).length === 1 && !r.quickbooksPaymentId && r.status === "paid",
      `4: QuickBooks has the payment but PJL never heard back — no id recorded, the invoice still Paid (${qbPaymentsFor(b.qbId).length} ${r.quickbooksPaymentId})`);
    // The repeat a retry would make:
    const m0 = srv.outbox().length;
    const again = await qbLib.recordPaymentForInvoice({ qbInvoiceId: b.qbId, amountCents: Math.round(b.inv.total * 100), chargeId: `ch_${bPi}`, sourceRef: bPi });
    ok(qbPaymentsFor(b.qbId).length === 1 && again.id === qbPaymentsFor(b.qbId)[0].Id && posts(m0, b.qbId).length === 0,
      `4: repeating after the lost response finds that payment — still one (${qbPaymentsFor(b.qbId).length} ${again.id})`);
  }

  // ---- 5 the server restarts between QuickBooks accepting and PJL recording it ------
  const c = await visit("C");
  {
    srv.quickbooksMode("accept-drop");
    const { pi } = await cardPays(c);
    srv.quickbooksMode(null);
    await srv.restart();
    await srv.login();
    ok(qbPaymentsFor(c.qbId).length === 1 && !(await read(c)).quickbooksPaymentId, `5: after the restart QuickBooks has it and PJL has no id (${qbPaymentsFor(c.qbId).length})`);
    const m0 = srv.outbox().length;
    await hook(c, pi); await confirm(c, pi); await settle();
    ok(posts(m0, c.qbId).length === 0, `5: redelivery after the restart posts nothing (${posts(m0, c.qbId).length})`);
    const again = await qbLib.recordPaymentForInvoice({ qbInvoiceId: c.qbId, amountCents: Math.round(c.inv.total * 100), chargeId: `ch_${pi}`, sourceRef: pi });
    ok(qbPaymentsFor(c.qbId).length === 1 && again.id === qbPaymentsFor(c.qbId)[0].Id, `5: a sync after the restart reuses the one QuickBooks payment (${qbPaymentsFor(c.qbId).length})`);
  }

  // ---- 6 each layer is enough on its own ----------------------------------------------
  const d = await visit("D");
  {
    const src = `pi_layer_${Date.now()}`;
    const args = { qbInvoiceId: d.qbId, amountCents: 5000, chargeId: `ch_${src}`, sourceRef: src };
    // 6a the lookup is blind (no LinkedTxn): requestid alone holds
    srv.quickbooksMode("no-linkedtxn");
    const first = await qbLib.recordPaymentForInvoice(args);
    const m0 = srv.outbox().length;
    const second = await qbLib.recordPaymentForInvoice(args);
    const dedup = srv.outbox().slice(m0).filter((e) => e.channel === "quickbooks" && e.deduped);
    ok(qbPaymentsFor(d.qbId).length === 1 && second.id === first.id && dedup.length === 1, `6a: with the lookup blind, the requestid alone returns the original payment (${qbPaymentsFor(d.qbId).length} dedup ${dedup.length})`);
    // 6b QuickBooks ignores requestid: the lookup alone holds
    srv.quickbooksMode("ignore-requestid");
    const third = await qbLib.recordPaymentForInvoice(args);
    ok(qbPaymentsFor(d.qbId).length === 1 && third.id === first.id, `6b: with requestid ignored, the lookup alone finds it (${qbPaymentsFor(d.qbId).length})`);
    // 6c the lookup can't finish (network drops): never create when unsure
    srv.quickbooksMode("lookup-fail");
    let threw = false;
    const m1 = srv.outbox().length;
    try { await qbLib.recordPaymentForInvoice(args); } catch { threw = true; }
    ok(threw && posts(m1, d.qbId).length === 0 && qbPaymentsFor(d.qbId).length === 1, `6c: an uncertain lookup refuses to post, rather than risk a second (${threw} ${posts(m1, d.qbId).length})`);
    srv.quickbooksMode(null);
  }

  // ---- 7 a payment posted before this rule is still recognised -----------------------
  const e = await visit("E");
  {
    const src = `pi_legacy_${Date.now()}`;
    const st = store();
    st.seq = (st.seq || 0) + 1;
    st.payments.push({ Id: `qbpay_legacy_${st.seq}`, TotalAmt: 50, CustomerRef: { value: "qbcust_stub" }, PrivateNote: `Auto-recorded from QB Payments charge ch_${src}`, Line: [{ Amount: 50, LinkedTxn: [{ TxnId: e.qbId, TxnType: "Invoice" }] }] });
    st.requests = st.requests || {};
    fs.writeFileSync(`${srv.OUTBOX}.qb-store.json`, JSON.stringify(st));
    const m0 = srv.outbox().length;
    const r = await qbLib.recordPaymentForInvoice({ qbInvoiceId: e.qbId, amountCents: 5000, chargeId: `ch_${src}`, sourceRef: src });
    ok(qbPaymentsFor(e.qbId).length === 1 && r.id === `qbpay_legacy_${st.seq}` && posts(m0, e.qbId).length === 0, `7: an older payment (charge id in its note, no requestid) is found, not duplicated (${qbPaymentsFor(e.qbId).length} ${r.id})`);
    // …and a DIFFERENT Stripe payment on the same invoice is its own payment
    const other = await qbLib.recordPaymentForInvoice({ qbInvoiceId: e.qbId, amountCents: 2500, chargeId: `ch_${src}_2`, sourceRef: `${src}_2` });
    ok(qbPaymentsFor(e.qbId).length === 2 && other.id !== r.id, `7: a different Stripe payment is posted normally (${qbPaymentsFor(e.qbId).length})`);
  }

  // ---- 8 partial payment: part cash, the card for the balance ------------------------
  const f = await visit("F");
  {
    const part = money(f.inv.total * 0.4);
    await cash(f, part);
    const m0 = srv.outbox().length;
    const { pi } = await cardPays(f);
    const p = posts(m0, f.qbId);
    ok(p.length === 1 && money(p[0].body?.TotalAmt) === money(f.inv.total - part) && p[0].requestid === `pjl-pay-${pi}`, `8: a partial card payment posts once, for what it applied (${p.length} ${p[0]?.body?.TotalAmt})`);
  }

  // ---- 9 overpayment: only the amount applied (#349) --------------------------------
  const g = await visit("G");
  {
    const pi = (await payIntent(g)).body.paymentIntentId;
    const part = money(g.inv.total * 0.4);
    await cash(g, part);
    const m0 = srv.outbox().length;
    srv.stripeSucceed(pi);
    await confirm(g, pi); await hook(g, pi); await settle();
    const p = posts(m0, g.qbId);
    ok(p.length === 1 && money(p[0].body?.TotalAmt) === money(g.inv.total - part), `9: an overpayment posts once, the applied amount only (${p.length} ${p[0]?.body?.TotalAmt})`);
    const again = await qbLib.recordPaymentForInvoice({ qbInvoiceId: g.qbId, amountCents: Math.round((g.inv.total - part) * 100), chargeId: `ch_${pi}`, sourceRef: pi });
    ok(qbPaymentsFor(g.qbId).length === 1 && again.id === qbPaymentsFor(g.qbId)[0].Id, `9: …and repeating it is still one (${j(qbPaymentsFor(g.qbId).map((p) => [p.Id, p.PrivateNote]))} ${j(again)})`);
  }

  // ---- 10 a reversed Stripe payment stays ignored (#348) -----------------------------
  {
    const r0 = await read(a);
    await srv.api("DELETE", `/api/invoices/${a.inv.id}/payments/${r0.payments[0].id}`, { reason: "refunded in Stripe dashboard" });
    const m0 = srv.outbox().length;
    await hook(a, aPi); await confirm(a, aPi); await settle();
    ok(posts(m0, a.qbId).length === 0 && qbPaymentsFor(a.qbId).length === 1, `10: the reversed payment redelivered posts nothing to QuickBooks (${posts(m0, a.qbId).length})`);
  }

  ok(!srv.outbox().some((x) => x.channel === "refused" && /intuit/.test(x.host || "")), "no real Intuit host was contacted");
} finally {
  await srv.stop();
}

console.log(`\nquickbooks payment idempotency: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

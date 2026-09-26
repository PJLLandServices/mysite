#!/usr/bin/env node
// scripts/test-resign-reprice.mjs
//
// After a customer re-signs a changed scope, the invoice bills what they
// signed for (Patrick, 2026-09-26).
//
// WHAT BROKE (verified on main c87e82ae, found by the E2E journeys in #322):
// the new signature released the invoice's payment/send hold, but nothing
// re-priced the invoice. It kept the OLD scope's lines and became payable
// and sendable again:
//   signed 4 zones → revised and re-signed at 6 → still billed the 4-zone price
//   signed 6 zones → revised and re-signed at 4 → still billed the 6-zone price
//                                                 (an overcharge)
//
// THE RULE (the "resignature" listener in server.js, when the new
// acceptance lands, BEFORE the hold is released):
//   A/B. an unsent draft with nothing paid is re-priced IN PLACE to the
//        re-locked scope — same invoice, no second one; the previous lines
//        and total are kept on the invoice (scopeReconciliations + history)
//   C.   a SENT invoice is never silently rewritten: it is flagged
//        "revision required" and payment, Send, Resend, Tap to Pay and the
//        pay page stay blocked; Patrick's Revise clears it, and the audit
//        trail keeps both the flag and the revision
//   D.   an invoice with money already recorded is flagged, not rewritten
//   E.   retrying the signature (and re-running the reconcile) changes
//        nothing twice: one invoice, one reconciliation entry
//   F.   nothing reaches the customer from the re-price or the flag
//   G.   the original signature is kept (priorAcceptances), unchanged rule
//   H.   the office invoice page shows "Revision required" exactly when the
//        server says so
//   I.   a custom-size price Patrick CONFIRMED stands when the scope comes
//        back to what was signed (not reset to the suggestion)
//   J.   a custom size that really changes (16 → 18 zones) is re-priced to
//        the new suggestion and needs his confirmation again — held, not
//        charged at either number meanwhile
//
// Booted server, temp data, email/SMS/Stripe stubbed (nothing leaves).
//
// Run: node scripts/test-resign-reprice.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

const PRICING = JSON.parse(fs.readFileSync(new URL("../pricing.json", import.meta.url), "utf8"));
const price = (key) => PRICING.items[key].price;
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 260);
const NEW_SIGNATURE = { acknowledgement: true, imageData: "data:image/png;base64," + "D".repeat(230), customerName: "Jane Customer (revised)" };

// ---- H. the office invoice page ------------------------------------------------
{
  const html = fs.readFileSync(new URL("../server/invoice.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../server/invoice.js", import.meta.url), "utf8");
  ok(/id="invoiceRevisionRequiredCard"[^>]*hidden/.test(html), "H. the invoice page has a hidden \"Revision required\" card");
  ok(/card\.hidden = hold\?\.reason !== "revision_required"/.test(js) && /renderRevisionRequiredCard\(inv\);/.test(js), "H. …shown exactly when the server flags it");
}

const srv = await bootServer({ port: 4925 });
try {
  await srv.login();
  const HST = srv.lib("invoices.js").HST_RATE;
  const withTax = (sub) => Math.round((sub + Math.round(sub * HST * 100) / 100) * 100) / 100;
  const get = async (id) => (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
  const invoicesFor = (woId) => srv.data("invoices").filter((i) => i.woId === woId);
  const active = (woId) => invoicesFor(woId).find((i) => i.status !== "void") || null;
  const fee = (inv) => (inv?.lineItems || []).find((l) => /^fall_close_/.test(l?.key || "")) || null;
  const now = () => new Date().toISOString();
  // "Reload and save again" on a race with the post-completion report
  // refresh (PJL-103), as the office does. Every other refusal returns.
  const edit = async (id, patch) => {
    for (let k = 0; k < 12; k++) {
      const r = await srv.qpatch(id, patch);
      if (!(r.status === 409 && r.body?.error === "version_conflict")) return r;
      await sleep(250);
    }
    return srv.qpatch(id, patch);
  };
  // A finished, signed closing with `zones` zones and its invoice.
  let n = 0;
  async function signedClosing(zones, { paidOnSite = true } = {}) {
    n += 1;
    const f = await srv.fixture({ zones, email: `resign${n}@example.com`, phone: `90555504${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const done = await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "completed", signature: SIGNATURE, arrivedAt: now(), departedAt: now() });
    if (done.status !== 200) throw new Error(`finish ${done.status} ${j(done.body)}`);
    await sleep(300);
    return { f, id: f.wo.id, inv: active(f.wo.id), original: (await get(f.wo.id)).signature };
  }
  // Unlock, change the zone count, re-lock, and have the customer sign.
  async function reviseAndResign(id, toZones, { sign = true } = {}) {
    const un = await srv.api("POST", `/api/work-orders/${id}/unlock`, { reason: "The customer's system changed after they signed" });
    if (un.status !== 200) throw new Error(`unlock ${un.status}`);
    const zones = (await get(id)).zones;
    const next = toZones > zones.length
      ? [...zones, ...Array.from({ length: toZones - zones.length }, (_, i) => ({ number: zones.length + i + 1, location: `Zone ${zones.length + i + 1}`, status: "ok", kind: "zone" }))]
      : zones.slice(0, toZones);
    const r = await edit(id, { zones: next });
    if (r.body.workOrder?.resignature?.required !== true) throw new Error(`no resignature flag ${r.status} ${j(r.body)}`);
    const relock = await srv.api("POST", `/api/work-orders/${id}/relock`, {});
    if (relock.status !== 200) throw new Error(`relock ${relock.status}`);
    if (!sign) return null;
    return srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now(), departedAt: now() });
  }

  // ---- A. draft, signed 4 → re-signed 6 -------------------------------------
  {
    const c = await signedClosing(4);
    ok(fee(c.inv)?.key === "fall_close_4z" && c.inv.total === withTax(price("fall_close_4z")), `A. setup: a draft at the 1-4 zone price (${c.inv?.total})`);
    const mark = srv.outbox().length;
    const s = await reviseAndResign(c.id, 6);
    ok(s.status === 200, `A. the customer re-signs for 6 zones (${s.status} ${j(s.body.errors)})`);
    await sleep(200);
    const inv = active(c.id);
    ok(inv?.id === c.inv.id, `A. the SAME invoice is re-priced, not a new one (${inv?.id} vs ${c.inv.id})`);
    ok(invoicesFor(c.id).length === 1, `A. …and there is still one invoice for the visit (${invoicesFor(c.id).length})`);
    ok(fee(inv)?.key === "fall_close_6z" && fee(inv)?.unitPrice === price("fall_close_6z"), `A. it bills the 5-6 zone price the customer signed (${j(fee(inv))})`);
    ok(inv?.total === withTax(price("fall_close_6z")) && Number(inv?.balanceDue) === inv?.total, `A. total and balance follow (${inv?.total} / ${inv?.balanceDue})`);
    ok(!inv?.scopeHold, "A. the hold is released once it matches");
    const rec = (inv?.scopeReconciliations || [])[0];
    ok(rec && rec.action === "repriced" && rec.previousTotal === c.inv.total && fee({ lineItems: rec.previousLineItems })?.key === "fall_close_4z",
      `A. the original lines and total are kept on the invoice (${j(rec)})`);
    ok((inv?.history || []).some((h) => h.action === "repriced_to_signed_scope"), "A. …and the history says why");
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 200, `A. payment opens again, for the new price (${link.status} ${link.body.code})`);
    const page = await srv.api("GET", `/api/pay/invoice/${inv.id}?t=${encodeURIComponent(new URL(link.body.url).searchParams.get("t"))}`);
    ok(Number(page.body.invoice?.balanceDue ?? page.body.balanceDue) === withTax(price("fall_close_6z")), "A. the pay page asks for the 6-zone total");
    const wo = await get(c.id);
    ok((wo.priorAcceptances || []).some((p) => p.signature?.imageData === c.original.imageData), "G. the original signature is kept");
    ok(!srv.outbox().slice(mark).some((m) => m.channel !== "stripe" && m.to && m.to.includes(`resign${n}@`)), "F. nothing is sent to the customer by the re-price");

    // E. retry the same signature request, and re-run the reconcile
    const again = await srv.api("PATCH", `/api/work-orders/${c.id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now(), departedAt: now() });
    ok(again.status < 500, `E. retrying the signature request is answered (${again.status})`);
    const lib = srv.lib("invoices.js");
    // What the server's listener passes: the signed scope's billable lines.
    const signedLines = (await srv.lib("billing.js").billingFor(srv.data("work-orders").find((w) => w.id === c.id))).lines;
    const direct = typeof lib.reconcileToSignedScope === "function"
      ? await lib.reconcileToSignedScope(c.id, { lineItems: signedLines, by: "test" }) : null;
    ok(direct?.action === "matches", `E. reconciling again finds nothing to do (${direct?.action})`);
    await sleep(300);
    const after = active(c.id);
    ok(invoicesFor(c.id).length === 1 && after.total === inv.total && (after.scopeReconciliations || []).length === 1,
      `E. …one invoice, same total, one reconciliation (${invoicesFor(c.id).length} · ${after.total} · ${(after.scopeReconciliations || []).length})`);
  }

  // ---- B. draft, signed 6 → re-signed 4 (the overcharge) ---------------------
  {
    const c = await signedClosing(6);
    ok(fee(c.inv)?.key === "fall_close_6z", "B. setup: a draft at the 5-6 zone price");
    const s = await reviseAndResign(c.id, 4);
    ok(s.status === 200, `B. the customer re-signs for 4 zones (${s.status})`);
    await sleep(200);
    const inv = active(c.id);
    ok(inv?.id === c.inv.id && fee(inv)?.key === "fall_close_4z" && inv.total === withTax(price("fall_close_4z")),
      `B. the same invoice now bills the 1-4 zone price — no overcharge (${j([inv?.id, fee(inv)?.key, inv?.total])})`);
    ok(!inv?.scopeHold && (await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {})).status === 200, "B. and it is payable again");
  }

  // ---- C. a SENT invoice is flagged, never silently rewritten ---------------
  {
    const c = await signedClosing(4, { paidOnSite: false });
    const sent = await srv.api("POST", `/api/invoices/${c.inv.id}/send`, {});
    ok(sent.status === 200 && sent.body.invoice?.status === "sent", `C. setup: the 4-zone invoice was sent (${sent.status})`);
    const before = srv.data("invoices").find((i) => i.id === c.inv.id);
    const mark = srv.outbox().length;
    const s = await reviseAndResign(c.id, 6);
    ok(s.status === 200, `C. the customer re-signs for 6 zones (${s.status})`);
    await sleep(200);
    let inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(JSON.stringify(inv.lineItems) === JSON.stringify(before.lineItems) && inv.total === before.total, `C. the sent invoice is NOT rewritten (${inv.total})`);
    ok(inv.scopeHold?.reason === "revision_required" && inv.scopeHold?.requiredTotal === withTax(price("fall_close_6z")),
      `C. it is flagged for revision, naming the signed total (${j(inv.scopeHold)})`);
    const full = (await srv.api("GET", `/api/invoices/${inv.id}`)).body.invoice;
    ok(full?.scopeHold?.reason === "revision_required", "C. the office sees the flag on the invoice");
    const doors = [
      ["pay link", await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {})],
      ["Tap to Pay", await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {})],
      ["Resend", await srv.api("POST", `/api/invoices/${inv.id}/resend`, {})],
      ["the pay page", await srv.api("POST", `/api/pay/invoice/${inv.id}/payment-intent`, { t: inv.paymentToken })]
    ];
    for (const [what, r] of doors) ok(r.status === 409 && r.body.code === "revision_required", `C. no ${what} while a revision is required (${r.status} ${r.body.code})`);
    ok(!srv.outbox().slice(mark).some((m) => m.channel !== "stripe" && m.to && m.to.includes(c.f.cust.email.split("@")[0])), "F. nothing is sent to the customer by the flag");
    ok(!srv.outbox().slice(mark).some((m) => m.channel === "stripe" && m.method === "POST" && m.path === "/v1/payment_intents"), "C. …and no charge is started");

    // E. the flag is idempotent too
    const retry = await srv.api("PATCH", `/api/work-orders/${c.id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now(), departedAt: now() });
    ok(retry.status < 500, `E. retrying the signature on a flagged invoice is answered (${retry.status})`);
    inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(inv.total === before.total && (inv.history || []).filter((h) => h.action === "revision_required_after_resignature").length === 1,
      "E. …the flag is recorded once and the invoice still isn't rewritten");

    // Patrick revises it to the signed scope → the hold clears.
    const lines = inv.lineItems.map((l) => (/^fall_close_/.test(l.key || "") ? { ...l, key: "fall_close_6z", label: "Fall Closing (2026) — 6 zones", unitPrice: price("fall_close_6z") } : l));
    const rev = await srv.api("POST", `/api/invoices/${inv.id}/revise`, { lineItems: lines, reason: "Two more zones added; the customer signed the revised work order" });
    ok(rev.status === 200 && rev.body.invoice?.total === withTax(price("fall_close_6z")), `C. Patrick revises it to the signed scope (${rev.status} ${j(rev.body.errors)})`);
    inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(!inv.scopeHold, `C. the revision clears the hold (${j(inv.scopeHold)})`);
    ok((inv.revisions || []).length === 1 && inv.revisions[0].previousTotal === before.total, "C. the revision keeps what was sent (audit)");
    ok((inv.history || []).some((h) => h.action === "revision_required_after_resignature") && (inv.history || []).some((h) => h.action === "revision_resolved"),
      "C. the history keeps the flag and its resolution");
    const open = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(open.status === 200, `C. payment opens again after the revision (${open.status} ${open.body.code})`);
  }

  // ---- D. money already recorded: flagged, not rewritten --------------------
  {
    const c = await signedClosing(4);
    const cash = await srv.api("POST", `/api/invoices/${c.inv.id}/payments`, { amount: 20, method: "cash", receivedAt: now() });
    ok(cash.status < 300, "D. setup: a cash deposit on the draft");
    const before = srv.data("invoices").find((i) => i.id === c.inv.id);
    const s = await reviseAndResign(c.id, 6);
    ok(s.status === 200, `D. the customer re-signs for 6 zones (${s.status})`);
    await sleep(200);
    const inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(inv.total === before.total && JSON.stringify(inv.lineItems) === JSON.stringify(before.lineItems) && inv.scopeHold?.reason === "revision_required",
      `D. an invoice with money on it is flagged, not rewritten (${j([inv.total, inv.scopeHold])})`);
    ok((inv.payments || []).length === 1, "D. the recorded payment is untouched");
  }

  // ---- I/J. a custom size Patrick priced -----------------------------------
  const suggest = (zones) => srv.lib("pricing.js").suggestSeasonalPrice("fall_closing", zones, "residential")?.amount;
  {
    const c = await signedClosing(16);
    const theirs = suggest(16) + 15;
    const conf = await srv.api("POST", `/api/invoices/${c.inv.id}/confirm-price`, { amount: theirs });
    ok(conf.status === 200 && conf.body.invoice?.total === withTax(theirs), `I. setup: Patrick confirms his own price for 16 zones (${conf.status})`);
    await srv.api("POST", `/api/work-orders/${c.id}/unlock`, { reason: "Checking a zone the tech wasn't sure about" });
    const zones = (await get(c.id)).zones;
    let r = await edit(c.id, { zones: [...zones, { number: 17, location: "Zone 17", status: "ok", kind: "zone" }] });
    ok(r.body.workOrder?.resignature?.required === true, "I. a 17th zone needs a new signature");
    r = await edit(c.id, { zones });
    ok(r.body.workOrder?.resignature?.required === false, "I. taking it back out restores what was signed");
    await sleep(200);
    const inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(inv.total === withTax(theirs) && fee(inv)?.unitPrice === theirs, `I. Patrick's confirmed price stands, not the suggestion (${fee(inv)?.unitPrice} vs ${theirs})`);
    ok(inv.priceConfirm?.confirmedAt && !inv.scopeHold, "I. …still confirmed, and released");
  }
  {
    const c = await signedClosing(16);
    const theirs = suggest(16) + 15;
    await srv.api("POST", `/api/invoices/${c.inv.id}/confirm-price`, { amount: theirs });
    const s = await reviseAndResign(c.id, 18);
    ok(s.status === 200, `J. the customer re-signs for 18 zones (${s.status})`);
    await sleep(200);
    const inv = (await srv.api("GET", `/api/invoices/${c.inv.id}`)).body.invoice;
    ok(fee(inv)?.unitPrice === suggest(18) && inv.priceUnconfirmed === true, `J. re-priced to the 18-zone suggestion, to be confirmed (${fee(inv)?.unitPrice} vs ${suggest(18)}, unconfirmed=${inv.priceUnconfirmed})`);
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 409 && link.body.code === "needs_pricing", `J. …and not payable until Patrick confirms it (${link.status} ${link.body.code})`);
    ok((inv.scopeReconciliations || [])[0]?.previousTotal === withTax(theirs), "J. his earlier confirmed price is kept in the audit trail");
  }

  // ---- still held before the signature --------------------------------------
  {
    const c = await signedClosing(4);
    await reviseAndResign(c.id, 6, { sign: false });
    await sleep(200);
    const inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(fee(inv)?.key === "fall_close_4z" && inv.scopeHold?.since && inv.scopeHold?.reason !== "revision_required",
      `re-locked but unsigned: not re-priced yet, still awaiting the signature (${j(inv.scopeHold)})`);
    const link = await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {});
    ok(link.status === 409 && link.body.code === "awaiting_signature", `…payment refused as awaiting signature (${link.body.code})`);
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
  console.error(srv.logs().slice(-2000));
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`resign-reprice: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

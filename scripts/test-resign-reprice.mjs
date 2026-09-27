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
// Patrick's rulings on #325 (2026-09-26):
//   K.   Revise releases a "revision required" hold only at or BELOW the
//        amount the customer signed (a discount needs no new signature);
//        ABOVE it the hold stays; the history records signed vs revised and
//        whether it matched or was discounted
//   L.   while held — awaiting the signature OR awaiting a revision — EVERY
//        way of taking or recording money refuses: pay page, pay link, Take
//        payment, Tap to Pay, cash, cheque, e-transfer, card recorded by
//        hand, other, Klarna capture, correcting a payment, a manual
//        "Paid"/"Partially paid"/"Sent"; each reopens only once the invoice
//        is legitimately reconciled
//   N.   a card payment opened BEFORE the hold (pay page left open, Tap to
//        Pay armed) is cancelled at Stripe when the hold goes on
//   M.   a signed scope that bills nothing follows the No Charge rules: an
//        untouched draft is voided and the visit reads No Charge (never a
//        $0 invoice); a sent one can't be "revised" to $0 — it is voided,
//        and then reads No Charge
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

// ---- L. no payment-recording route can forget the hold ---------------------------
// Every call that records money in server.js either asks the hold rule under
// the store lock (refuseWhileHeld), or is one of the two finalizers that
// record money ALREADY moved at the processor (Stripe, Klarna — the Klarna
// route asks paymentHoldFor before it captures anything).
{
  const src = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const calls = [...src.matchAll(/invoices\.(addPayment|updatePayment)\(/g)].map((m) => {
    const fnAt = src.lastIndexOf("\nasync function ", m.index);
    const fn = src.slice(fnAt + 16, src.indexOf("(", fnAt + 16));
    const call = src.slice(m.index, src.indexOf(");", m.index));
    return { fn, guarded: /refuseWhileHeld:\s*true/.test(call) };
  });
  const unguarded = calls.filter((c) => !c.guarded && !["finalizeStripeInvoicePayment", "finalizeKlarnaCapture"].includes(c.fn));
  ok(calls.length >= 4 && unguarded.length === 0, `L. every payment-recording call asks the hold, or is a processor finalizer (${JSON.stringify(unguarded)})`);
  const kAt = src.indexOf("const klarnaCaptureMatch");
  const klarna = src.slice(kAt, src.indexOf("finalizeKlarnaCapture(inv, quote", kAt));
  ok(/invoices\.paymentHoldFor\(inv\)/.test(klarna), "L. the Klarna capture route asks the hold before capturing");
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

  // ---- helpers for the payment doors -----------------------------------------
  const METHODS = ["cash", "cheque", "e_transfer", "card_qb", "other"];
  async function everyPaymentDoor(inv, label, want) {
    const rec = srv.data("invoices").find((i) => i.id === inv.id);
    const doors = [];
    for (const method of METHODS) {
      doors.push([`record ${method}`, await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: 10, method, receivedAt: now(), notes: "" })]);
    }
    doors.push(["Take payment / pay link", await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {})]);
    doors.push(["Tap to Pay", await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {})]);
    doors.push(["Klarna capture", await srv.api("POST", `/api/admin/invoices/${inv.id}/klarna/capture`, { amountCents: 1000 })]);
    doors.push(["manual Paid", await srv.api("PATCH", `/api/invoices/${inv.id}`, { status: "paid" })]);
    doors.push(["manual Partially paid", await srv.api("PATCH", `/api/invoices/${inv.id}`, { status: "partially_paid" })]);
    if (rec.status === "draft") doors.push(["manual Sent", await srv.api("PATCH", `/api/invoices/${inv.id}`, { status: "sent" })]);
    if (rec.paymentToken) doors.push(["the pay page", await srv.api("POST", `/api/pay/invoice/${inv.id}/payment-intent`, { t: rec.paymentToken })]);
    if ((rec.payments || []).length) {
      doors.push(["correcting a payment", await srv.api("PATCH", `/api/invoices/${inv.id}/payments/${rec.payments[0].id}`, { amount: 5 })]);
    }
    for (const [what, r] of doors) ok(r.status === 409 && r.body.code === want, `${label}: ${what} refused (${r.status} ${r.body.code})`);
    const after = srv.data("invoices").find((i) => i.id === inv.id);
    ok((after.payments || []).length === (rec.payments || []).length && after.status === rec.status && after.total === rec.total,
      `${label}: …and nothing was recorded, marked or changed (${(after.payments || []).length} payments, ${after.status})`);
  }

  // ---- K. Revise vs the signed amount ----------------------------------------
  {
    const c = await signedClosing(4, { paidOnSite: false });
    await srv.api("POST", `/api/invoices/${c.inv.id}/send`, {});
    await reviseAndResign(c.id, 6);
    await sleep(200);
    let inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    const signed = withTax(price("fall_close_6z"));
    ok(inv.scopeHold?.reason === "revision_required" && inv.scopeHold.requiredTotal === signed, "K. setup: a sent invoice flagged at the signed 6-zone total");
    const at = (sub) => inv.lineItems.map((l) => (/^fall_close_/.test(l.key || "") ? { ...l, key: "fall_close_6z", unitPrice: sub } : l));

    // ABOVE the signed amount: the hold stays.
    let rev = await srv.api("POST", `/api/invoices/${inv.id}/revise`, { lineItems: at(price("fall_close_6z") + 20), reason: "Added a surcharge" });
    inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(rev.status === 200 && rev.body.stillHeld === true && /MORE than/.test(rev.body.warning || ""), `K. revising ABOVE the signed amount is saved but says it stays held (${rev.body.warning})`);
    ok(inv.scopeHold?.reason === "revision_required", "K. …the hold stays: the customer never authorized the higher amount");
    ok((inv.history || []).some((h) => h.action === "revision_above_signed" && h.note.includes(`signed $${signed.toFixed(2)}`)), "K. …and the history records signed vs revised");
    await everyPaymentDoor(inv, "K. above the signed amount", "revision_required");
    const send = await srv.api("POST", `/api/invoices/${inv.id}/resend`, {});
    ok(send.status === 409 && send.body.code === "revision_required", `K. …and Resend refuses (${send.body.code})`);

    // BELOW (a discount): released, recorded as discounted.
    rev = await srv.api("POST", `/api/invoices/${inv.id}/revise`, { lineItems: at(price("fall_close_6z") - 10), reason: "Goodwill discount" });
    inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(rev.status === 200 && rev.body.stillHeld === false && !inv.scopeHold, `K. revising BELOW the signed amount releases it (${j(inv.scopeHold)})`);
    const resolved = (inv.history || []).find((h) => h.action === "revision_resolved");
    ok(resolved && /discounted \$[\d.]+ below the signed amount/.test(resolved.note) && resolved.note.includes(`signed $${signed.toFixed(2)}`),
      `K. …and the history says it was discounted, with both amounts (${resolved?.note})`);
    const paid = await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: 10, method: "cash", receivedAt: now() });
    ok(paid.status === 201, `L. once legitimately revised, cash can be recorded again (${paid.status} ${paid.body.code})`);
  }

  // ---- L. every payment path while AWAITING the signature ----------------------
  {
    const c = await signedClosing(4);
    const opened = await srv.api("POST", `/api/invoices/${c.inv.id}/payment-link`, {});
    ok(opened.status === 200, "L. setup: a paid-on-site draft, opened for payment on site");
    await reviseAndResign(c.id, 6, { sign: false });
    await sleep(200);
    await everyPaymentDoor(c.inv, "L. awaiting the new signature", "awaiting_signature");
    const s2 = await srv.api("PATCH", `/api/work-orders/${c.id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now(), departedAt: now() });
    ok(s2.status === 200, "L. the customer signs");
    await sleep(200);
    const cash = await srv.api("POST", `/api/invoices/${c.inv.id}/payments`, { amount: withTax(price("fall_close_6z")), method: "cash", receivedAt: now() });
    ok(cash.status === 201 && cash.body.invoice?.status === "paid", `L. once re-priced to what was signed, payment works again (${cash.status} ${cash.body.invoice?.status})`);
  }

  // ---- L. every payment path while a REVISION is required (money on file) ------
  {
    const c = await signedClosing(4);
    await srv.api("POST", `/api/invoices/${c.inv.id}/payments`, { amount: 20, method: "cash", receivedAt: now() });
    await reviseAndResign(c.id, 6);
    await sleep(200);
    const inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok(inv.scopeHold?.reason === "revision_required", "L. setup: a part-paid invoice flagged for revision");
    await everyPaymentDoor(inv, "L. revision required", "revision_required");
    // A part-paid DRAFT is a flagged draft (Patrick: only an unsent, UNPAID
    // draft re-prices by itself), so it takes the rare-case path — and that
    // path must not be a dead end: reverse the deposit (reversing is not
    // taking money, so it stays allowed while held), Void, Generate invoice
    // from the signed work order, record the deposit again.
    const reverse = await srv.api("DELETE", `/api/invoices/${inv.id}/payments/${inv.payments[0].id}`, { reason: "Re-recording on the corrected invoice" });
    ok(reverse.status === 200, `L. the deposit can be reversed while held (${reverse.status} ${reverse.body.code})`);
    const v = await srv.api("POST", `/api/invoices/${inv.id}/void`, { reason: "Superseded by the revised work order" });
    ok(v.status === 200, `L. …then Void (${v.status} ${j(v.body.errors)})`);
    const gen = await srv.api("POST", `/api/work-orders/${c.id}/create-invoice`, {});
    const fresh = gen.body.invoice;
    ok(gen.status < 300 && fresh && fresh.id !== inv.id && fee(fresh)?.key === "fall_close_6z" && fresh.total === withTax(price("fall_close_6z")) && !fresh.scopeHold,
      `L. …then Generate invoice bills the signed 6-zone scope, unheld (${gen.status} ${j([fresh?.id, fee(fresh)?.key, fresh?.total])})`);
    ok(invoicesFor(c.id).filter((i) => i.status !== "void").length === 1, "L. …still one active invoice for the visit");
    const more = await srv.api("POST", `/api/invoices/${fresh?.id}/payments`, { amount: 20, method: "cash", receivedAt: now() });
    ok(more.status === 201, `L. …and the deposit is recorded again on it (${more.status} ${more.body.code})`);
  }

  // ---- N. a card payment opened before the hold is cancelled -------------------
  {
    const c = await signedClosing(4);
    const link = await srv.api("POST", `/api/invoices/${c.inv.id}/payment-link`, {});
    const t = new URL(link.body.url).searchParams.get("t");
    const page = await srv.api("POST", `/api/pay/invoice/${c.inv.id}/payment-intent`, { t });
    const tap = await srv.api("POST", `/api/invoices/${c.inv.id}/terminal-intent`, {});
    ok(page.status === 200 && tap.status === 200, "N. setup: the customer's pay page and the tech's reader both have an open intent");
    await reviseAndResign(c.id, 6, { sign: false });
    await sleep(200);
    const cancels = srv.outbox().filter((e) => e.channel === "stripe" && e.method === "POST" && /\/cancel$/.test(e.path)).map((e) => e.path);
    ok(cancels.includes(`/v1/payment_intents/${page.body.paymentIntentId}/cancel`) && cancels.includes(`/v1/payment_intents/${tap.body.paymentIntentId}/cancel`),
      `N. both are cancelled at Stripe when the hold goes on (${j(cancels)})`);
    const inv = srv.data("invoices").find((i) => i.id === c.inv.id);
    ok((inv.history || []).filter((h) => h.action === "payment_intent_cancelled_while_held").length === 2, "N. …and the history says so");
  }

  // ---- M. the signed scope bills nothing → No Charge, never a $0 invoice ---------
  {
    const setZero = (propId) => srv.api("PATCH", `/api/properties/${propId}`, { seasonalPricing: { fallClosingPrice: 0 } });
    const c = await signedClosing(4);
    const z = await setZero(c.f.prop.id);
    ok(z.status === 200, "M. setup: Patrick sets this property's fall price to $0 after the first signature");
    const s = await reviseAndResign(c.id, 5);
    ok(s.status === 200, `M. the customer re-signs the revised (now $0) work order (${s.status})`);
    await sleep(300);
    ok(!active(c.id), `M. the untouched draft is voided — no $0 invoice (${j(invoicesFor(c.id).map((i) => [i.status, i.total]))})`);
    ok(invoicesFor(c.id).every((i) => i.total > 0), "M. …and none was ever written at $0");
    const wo = (await srv.api("GET", `/api/work-orders/${c.id}`)).body.workOrder;
    ok(wo?.noCharge === true, `M. the visit reads No Charge (${wo?.noCharge})`);
    const gen = await srv.api("POST", `/api/work-orders/${c.id}/create-invoice`, {});
    ok(gen.status === 409 && gen.body.code === "no_charge", `M. "Generate invoice" refuses it as no charge (${gen.status} ${gen.body.code})`);

    const d = await signedClosing(4, { paidOnSite: false });
    await srv.api("POST", `/api/invoices/${d.inv.id}/send`, {});
    await setZero(d.f.prop.id);
    await reviseAndResign(d.id, 5);
    await sleep(300);
    let inv = srv.data("invoices").find((i) => i.id === d.inv.id);
    ok(inv.status === "sent" && inv.scopeHold?.reason === "revision_required" && inv.scopeHold.requiredTotal === 0, `M. a SENT invoice is flagged, not rewritten (${j([inv.status, inv.scopeHold?.requiredTotal])})`);
    const zeroLines = inv.lineItems.map((l) => ({ ...l, unitPrice: 0 }));
    const rev = await srv.api("POST", `/api/invoices/${inv.id}/revise`, { lineItems: zeroLines, reason: "No charge after all" });
    inv = srv.data("invoices").find((i) => i.id === d.inv.id);
    ok(rev.body.stillHeld === true && inv.scopeHold?.reason === "revision_required", "M. a $0 revision doesn't release it — there is no $0 invoice to collect on");
    const v = await srv.api("POST", `/api/invoices/${inv.id}/void`, { reason: "The revised work order is no charge" });
    ok(v.status === 200, `M. Patrick voids it (${v.status})`);
    await sleep(200);
    const wo2 = (await srv.api("GET", `/api/work-orders/${d.id}`)).body.workOrder;
    ok(wo2?.noCharge === true && !active(d.id), `M. …and the visit reads No Charge (${wo2?.noCharge})`);
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

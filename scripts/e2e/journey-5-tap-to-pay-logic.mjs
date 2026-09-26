#!/usr/bin/env node
// scripts/e2e/journey-5-tap-to-pay-logic.mjs
//
// JOURNEY 5 — Tap to Pay on iPhone: everything the SERVER decides around
// the physical tap. The NFC tap itself is the one piece that needs a real
// iPhone; here Stripe is stubbed to report what the reader would.
//
// Eligibility — which invoices may start a Tap to Pay charge (the same
// on-site rule as the pay link, invoices.openForOnSitePayment):
//   · a paid-on-site draft               → yes, for the server's balance
//   · a Bill-later draft                 → no: waits for Patrick's review
//   · a price PJL hasn't confirmed       → no; after Confirm price → yes
//   · a revised scope awaiting signature → no
//   · part-paid in cash                  → yes, for the REMAINING balance
//   · paid / void                        → no
//   · a tech, or no session              → no (admin only), and the same
//                                          for the reader's connection token
//
// Finalization — the reader reports back; the server re-reads Stripe:
//   · approved → paid once, "Tap to Pay on iPhone" in the ledger, card
//     facts from the in-person card, one receipt
//   · the customer never tapped (reader timed out) → refused, nothing
//     recorded; the next tap reuses the SAME intent
//   · declined → refused; another card on the same intent pays it
//   · reader dropped mid-processing → refused while processing (see the
//     FINDING below on what a second tap does then)
//   · Stripe unreachable at finalize → not paid; the retry settles it
//   · finalized twice, then Stripe's webhook → still one payment
//   · another invoice's approved intent → refused
//
// Run: node scripts/e2e/journey-5-tap-to-pay-logic.mjs

import { bootServer, journey, finish, invoiceFor, feeLine, withTax, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-5 Tap to Pay eligibility + finalization (no NFC)");
const srv = await bootServer({ port: 4935 });
const L = srv.ledger();
const READS = { channel: "stripe", method: "GET", path: /^\/v1\/payment_intents\/pi_/, n: "*" };
const CREATE = (n = 1) => ({ channel: "stripe", method: "POST", path: "/v1/payment_intents", n });
try {
  await srv.login();
  await J.sent(L, "boot", []);
  let n = 0;
  async function closing(label, { zones = 4, paidOnSite = true } = {}) {
    n += 1;
    const f = await srv.fixture({ zones, email: `tap${n}@example.com`, name: `Tap ${label}`, phone: `90555503${String(n).padStart(2, "0")}` });
    await srv.prepClosing(f.wo.id, { paidOnSite });
    const done = await finish(srv, f.wo.id);
    if (done.status !== 200) throw new Error(`${label}: finish ${done.status} ${j(done.body)}`);
    await J.sent(L, `${label}: finish`, [
      { channel: "email", to: f.cust.email, subject: /complete/i },
      { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
    ]);
    return { f, inv: invoiceFor(srv, f.wo.id), email: f.cust.email };
  }
  const start = (inv) => srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {});
  const finalize = (inv, pi) => srv.api("POST", `/api/invoices/${inv.id}/terminal-intent/finalize`, { paymentIntentId: pi });
  const read = async (inv) => (await srv.api("GET", `/api/invoices/${inv.id}`)).body.invoice;
  const lastCreateForm = () => srv.outbox().filter((e) => e.channel === "stripe" && e.method === "POST" && e.path === "/v1/payment_intents").pop()?.form || {};

  // ---- eligibility -------------------------------------------------------------
  J.step("eligible: paid-on-site draft");
  const ok1 = await closing("paid-on-site");
  const s1 = await start(ok1.inv);
  J.ok(s1.status === 200 && s1.body.clientSecret && s1.body.amountCents === Math.round(ok1.inv.total * 100), `an intent for the server's balance (${s1.status} ${s1.body.amountCents})`);
  const form1 = lastCreateForm();
  J.ok(form1["payment_method_types[0]"] === "card_present" && form1["metadata[source]"] === "pjl-field-taptopay", `an in-person intent, marked Tap to Pay (${j([form1["payment_method_types[0]"], form1["metadata[source]"]])})`);
  await J.sent(L, "eligible", [CREATE(1), READS]);

  J.step("not eligible: Bill later");
  const later = await closing("bill-later", { paidOnSite: false });
  const s2 = await start(later.inv);
  J.ok(s2.status === 409 && s2.body.code === "needs_review", `refused for Patrick's review (${s2.status} ${s2.body.code})`);
  await J.sent(L, "bill later", []);   // no Stripe call (its invoice text is on a 5-minute timer)

  J.step("not eligible until the price is confirmed");
  const custom = await closing("custom", { zones: 16 });
  const s3 = await start(custom.inv);
  J.ok(s3.status === 409 && s3.body.code === "needs_pricing", `refused: price not confirmed (${s3.status} ${s3.body.code})`);
  const suggested = feeLine((await read(custom.inv)).lineItems)?.unitPrice;
  const conf = await srv.api("POST", `/api/invoices/${custom.inv.id}/confirm-price`, { amount: suggested });
  J.ok(conf.status === 200, `Patrick confirms (${conf.status})`);
  const s3b = await start(custom.inv);
  J.ok(s3b.status === 200 && s3b.body.amountCents === Math.round(withTax(srv, suggested) * 100), `…then Tap to Pay can take the confirmed price (${s3b.status} ${s3b.body.amountCents})`);
  await J.sent(L, "custom", [CREATE(1), READS]);

  J.step("not eligible: revised scope awaiting signature");
  const resign = await closing("resign");
  const un = await srv.api("POST", `/api/work-orders/${resign.f.wo.id}/unlock`, { reason: "Customer asked for another zone to be added" });
  J.ok(un.status === 200, `unlocked (${un.status})`);
  let add;
  for (let k = 0; k < 12; k++) {   // "reload and save again" on a version race (PJL-103)
    const wo = (await srv.api("GET", `/api/work-orders/${resign.f.wo.id}`)).body.workOrder;
    add = await srv.qpatch(resign.f.wo.id, { zones: [...wo.zones, { number: 5, location: "Zone 5", status: "ok", kind: "zone" }] });
    if (!(add.status === 409 && add.body?.error === "version_conflict")) break;
    await sleep(250);
  }
  J.ok(add.status === 200 && add.body.workOrder?.resignature?.required === true, `a zone added: new signature needed (${add.status})`);
  const s4 = await start(resign.inv);
  J.ok(s4.status === 409 && s4.body.code === "awaiting_signature", `refused until the customer signs again (${s4.status} ${s4.body.code})`);
  await J.sent(L, "resign", []);

  J.step("part-paid in cash");
  const part = await closing("part-paid");
  const cash = await srv.api("POST", `/api/invoices/${part.inv.id}/payments`, { amount: 40, method: "cash", receivedAt: new Date().toISOString() });
  J.ok(cash.status === 200 || cash.status === 201, `a cash deposit (${cash.status})`);
  const s5 = await start(part.inv);
  const remaining = Math.round((part.inv.total - 40) * 100);
  J.ok(s5.status === 200 && s5.body.amountCents === remaining, `the tap is for the remaining balance only (${s5.body.amountCents} vs ${remaining})`);
  await J.sent(L, "part-paid", [CREATE(1), READS]);

  J.step("not eligible: void");
  const voided = await closing("void");
  const v = await srv.api("POST", `/api/invoices/${voided.inv.id}/void`, { reason: "Duplicate visit entered by mistake" });
  J.ok(v.status === 200, `voided (${v.status})`);
  const s6 = await start(voided.inv);
  J.ok(s6.status === 409 && s6.body.code === "void", `a void invoice starts no charge (${s6.status} ${s6.body.code})`);
  await J.sent(L, "void", []);

  J.step("staff only");
  const anon = await fetch(`${srv.BASE}/api/invoices/${ok1.inv.id}/terminal-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  J.ok(anon.status === 401 || anon.status === 403, `no session: refused (${anon.status})`);
  const tok = await srv.api("POST", "/api/terminal/connection-token", {});
  J.ok(tok.status === 200 && /^pst_test_/.test(tok.body.secret || "") && tok.body.locationId === "tml_stub", `admin: the reader gets its connection token and Location (${tok.status} ${tok.body.locationId})`);
  await srv.login({ role: "tech" });
  const techStart = await start(ok1.inv);
  const techTok = await srv.api("POST", "/api/terminal/connection-token", {});
  J.ok(techStart.status === 403 && techTok.status === 403, `a tech can't start a charge or connect the reader (${techStart.status} ${techTok.status})`);
  await srv.login();
  await J.sent(L, "staff only", [
    { channel: "stripe", method: "POST", path: "/v1/terminal/connection_tokens" },
    { channel: "stripe", method: "GET", path: "/v1/terminal/locations" }
  ]);

  // ---- finalization --------------------------------------------------------------
  J.step("the customer never tapped (reader timed out)");
  const pi1 = s1.body.paymentIntentId;
  const early = await finalize(ok1.inv, pi1);
  J.ok(early.status === 409 && early.body.code === "not_verified", `refused: Stripe has no payment (${early.status} ${early.body.code})`);
  let r1 = await read(ok1.inv);
  J.ok(r1.status !== "paid" && !(r1.payments || []).length, "nothing recorded");
  const again = await start(ok1.inv);
  J.ok(again.status === 200 && again.body.paymentIntentId === pi1, `the next tap reuses the same intent (${again.body.paymentIntentId})`);
  await J.sent(L, "never tapped", [READS]);   // no second intent

  J.step("declined, then another card");
  srv.stripeMode(pi1, "declined");
  const dec = await finalize(ok1.inv, pi1);
  J.ok(dec.status === 409, `a declined card is refused (${dec.status})`);
  J.ok((await read(ok1.inv)).status !== "paid", "still owing");
  const retap = await start(ok1.inv);
  J.ok(retap.status === 200 && retap.body.paymentIntentId === pi1, "another card: same intent");
  srv.stripeMode(pi1, "succeeded");

  J.step("Stripe unreachable at finalize");
  srv.stripeMode("*", "unreachable");
  const down = await finalize(ok1.inv, pi1);
  J.ok(down.status === 502 && (await read(ok1.inv)).status !== "paid", `not paid while Stripe can't be read (${down.status})`);
  srv.stripeMode("*", null);

  J.step("approved");
  const paid = await finalize(ok1.inv, pi1);
  J.ok(paid.status === 200 && paid.body.invoice?.status === "paid" && !paid.body.alreadyPaid, `the retry settles it (${paid.status} ${j(paid.body.errors)})`);
  r1 = await read(ok1.inv);
  J.ok((r1.payments || []).length === 1 && /Tap to Pay on iPhone/.test(r1.payments[0].notes || ""), `one payment, recorded as Tap to Pay (${j(r1.payments?.[0]?.notes)})`);
  const att = (r1.paymentAttempts || []).find((x) => x.outcome === "success");
  J.ok(att?.cardBrand === "visa" && att?.cardLast4 === "4242", `the in-person card's facts are kept (${j([att?.cardBrand, att?.cardLast4])})`);
  await J.sent(L, "declined → approved", [
    { channel: "email", to: ok1.email, subject: /receipt|payment/i },
    { channel: "stripe", method: "GET", path: /^\/v1\/payment_intents\/pi_/, n: "+" }
  ]);

  J.step("duplicates");
  const twice = await finalize(ok1.inv, pi1);
  J.ok(twice.status === 200 && twice.body.alreadyPaid === true, `finalized twice: harmless (${twice.status})`);
  const hook = await srv.stripeWebhook({ type: "payment_intent.succeeded", data: { object: { id: pi1, object: "payment_intent", metadata: { invoiceId: ok1.inv.id } } } });
  J.ok(hook.status === 200, "Stripe's webhook for it is acknowledged");
  await sleep(500);
  J.ok(((await read(ok1.inv)).payments || []).length === 1, "…still ONE payment");
  const paidStart = await start(ok1.inv);
  J.ok(paidStart.status === 409 && paidStart.body.code === "already_paid", `a paid invoice starts no charge (${paidStart.status} ${paidStart.body.code})`);
  const wrong = await finalize(part.inv, pi1);
  J.ok(wrong.status === 409 && (await read(part.inv)).status !== "paid", `another invoice's approved intent pays nothing here (${wrong.status})`);
  await J.sent(L, "duplicates", [READS]);   // no second receipt

  J.step("reader dropped mid-processing");
  const pi5 = s5.body.paymentIntentId;
  srv.stripeMode(pi5, "processing");
  const proc = await finalize(part.inv, pi5);
  J.ok(proc.status === 409 && (await read(part.inv)).status !== "paid", `not paid while Stripe says processing (${proc.status})`);
  const tapWhileProcessing = await start(part.inv);
  const mintedSecond = tapWhileProcessing.status === 200 && tapWhileProcessing.body.paymentIntentId !== pi5;
  const cancelledFirst = srv.outbox().some((e) => e.channel === "stripe" && e.path === `/v1/payment_intents/${pi5}/cancel`);
  J.finding(!(mintedSecond && !cancelledFirst),
    "Tap to Pay: tapping again while the first intent is still PROCESSING creates a second intent without cancelling the first — if the first then completes, the customer can be charged twice (it would surface only as the manual-refund warning)");
  await J.sent(L, "processing", [CREATE(mintedSecond ? 1 : 0), READS,
    { channel: "stripe", method: "POST", path: /\/cancel$/, n: [0, 1] }]);
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

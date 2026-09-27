#!/usr/bin/env node
// scripts/e2e/journey-6-unlock-resign.mjs
//
// JOURNEY 6 — a signed, finished 4-zone closing is unlocked and two zones
// are added. The customer signed for 4; they must sign again before they
// can be charged or sent anything for 6 (Patrick, 2026-09-26).
//
//   finished + signed (4)  → a draft invoice for the 1-4 zone tier
//   unlock (Patrick)       → a reason is required; nothing to the customer
//   a note, no new zones   → no new signature needed
//   add zones 5 and 6      → "new signature needed"; the original is kept;
//                            the invoice is HELD: no pay link, no Tap to
//                            Pay, no Send, no cascade re-run, no new invoice
//   the customer's portal  → no Pay button while held
//   re-lock (Patrick)      → the 5-6 zone price freezes now; still held
//   the customer re-signs  → the app's Finish sends the new signature; the
//                            original is in priorAcceptances; hold released
//   billing                → what is charged/sent should be the price the
//                            customer just signed for (FINDING: the invoice
//                            keeps the OLD scope's price, in both directions
//                            — undercharge when zones are added, OVERCHARGE
//                            when they're removed)
//
// Run: node scripts/e2e/journey-6-unlock-resign.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, finish, reopen,
  invoiceFor, invoicesFor, feeLine, priceOf, withTax, dayOut, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-6 unlock · scope change · re-sign · hold · new signature");
const srv = await bootServer({ port: 4936 });
const L = srv.ledger();
const NEW_SIGNATURE = { acknowledgement: true, imageData: "data:image/png;base64," + "C".repeat(240), customerName: "Rhea Resign (revised)" };
try {
  await srv.login();
  const PHONE = "9055550146";
  const get = async (id) => (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
  // The office's "Reload and save again" on a version race with the
  // post-completion report refresh (PJL-103). Every other refusal returns.
  const edit = async (id, patch) => {
    for (let k = 0; k < 12; k++) {
      const r = await srv.qpatch(id, patch);
      if (!(r.status === 409 && r.body?.error === "version_conflict")) return r;
      await sleep(250);
    }
    return srv.qpatch(id, patch);
  };

  J.step("book, sign and finish 4 zones");
  const { lead } = await book(srv, { serviceKey: "fall_close_4z", zoneCount: 4, day: dayOut(13),
    contact: { name: "Rhea Resign", email: "rhea@example.com", phone: PHONE, address: "16700 Bayview Ave, Newmarket, ON L3X 1W1" } });
  await J.sent(L, "booking", [
    { channel: "email", to: "rhea@example.com", subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);
  const wo = await openWorkOrder(srv, lead.id);
  await walkTheSystem(srv, wo.id, { walked: 4, paidOnSite: true });
  const done = await finish(srv, wo.id);
  J.ok(done.status === 200, `finished and signed (${done.status})`);
  const inv = invoiceFor(srv, wo.id);
  J.ok(feeLine(inv?.lineItems)?.key === "fall_close_4z" && inv?.total === withTax(srv, priceOf("fall_close_4z")), `invoiced at the 1-4 zone tier (${inv?.total})`);
  const original = (await get(wo.id)).signature;
  await J.sent(L, "finish", [
    { channel: "email", to: "rhea@example.com", subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);

  J.step("unlock");
  const noReason = await srv.api("POST", `/api/work-orders/${wo.id}/unlock`, { reason: "oops" });
  J.ok(noReason.status >= 400, `unlocking needs a real reason (${noReason.status})`);
  const un = await srv.api("POST", `/api/work-orders/${wo.id}/unlock`, { reason: "Customer showed us two more zones behind the garage" });
  J.ok(un.status === 200 && un.body.workOrder?.locked === false, `Patrick unlocks it (${un.status})`);
  let r = await edit(wo.id, { techNotes: "Two zones behind the garage were missed on the first walk." });
  J.ok(r.status === 200 && r.body.workOrder?.resignature?.required !== true, "a note alone needs no new signature");
  await J.sent(L, "unlock", []);   // nothing to the customer

  J.step("add zones 5 and 6");
  const four = (await get(wo.id)).zones;
  r = await edit(wo.id, { zones: [...four,
    { number: 5, location: "Behind garage (east)", status: "ok", kind: "zone" },
    { number: 6, location: "Behind garage (west)", status: "ok", kind: "zone" }] });
  J.ok(r.status === 200 && r.body.workOrder?.resignature?.required === true, `a new signature is needed (${r.status} ${j(r.body.workOrder?.resignature)})`);
  J.ok(r.body.workOrder?.signature?.imageData === original?.imageData, "the customer's original signature is still on file");
  await sleep(300);
  J.ok(Boolean(invoiceFor(srv, wo.id)?.scopeHold?.since), `the invoice is held (${j(invoiceFor(srv, wo.id)?.scopeHold)})`);
  const checks = [
    ["pay link", await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {}), "code", "awaiting_signature"],
    ["Tap to Pay", await srv.api("POST", `/api/invoices/${inv.id}/terminal-intent`, {}), "code", "awaiting_signature"],
    ["Send", await srv.api("POST", `/api/invoices/${inv.id}/send`, {}), "code", "awaiting_signature"],
    ["cascade re-run", await srv.api("POST", `/api/work-orders/${wo.id}/run-cascade`, {}), "error", "resign_required"],
    ["a new invoice", await srv.api("POST", `/api/work-orders/${wo.id}/create-invoice`, {}), "error", "resign_required"]
  ];
  for (const [what, res, field, want] of checks) J.ok(res.status === 409 && res.body[field] === want, `no ${what} (${res.status} ${res.body[field]})`);
  const back = await reopen(srv, wo.id);
  J.ok(back.opensInvoice && back.invoice?.id === inv.id, "reopening from the day still lands on the invoice");
  const held = srv.data("invoices").find((i) => i.id === inv.id);
  if (held?.portalToken) {
    const view = (await srv.api("GET", `/api/portal/invoice/${inv.id}?t=${held.portalToken}`)).body.invoice;
    J.ok(view && view.payUrl === null, `the customer's portal shows no Pay button (${j(view?.payUrl)})`);
  } else {
    J.ok(!held?.paymentToken, "no pay token exists for the customer to use");
  }
  await J.sent(L, "held", []);   // not one Stripe call, email or text

  J.step("re-lock");
  const relock = await srv.api("POST", `/api/work-orders/${wo.id}/relock`, {});
  const relocked = relock.body.workOrder;
  J.ok(relock.status === 200 && relocked?.locked === true, `Patrick re-locks the revised scope (${relock.status})`);
  const fee6 = feeLine(relocked?.onSiteQuote?.builderLineItems);
  J.ok(fee6?.key === "fall_close_6z" && fee6?.source?.recordedZones === 6, `the 5-6 zone price is frozen now (${j(fee6)})`);
  J.ok(relocked?.resignature?.required === true, "…and the customer still has to sign");
  J.ok((await srv.api("POST", `/api/invoices/${inv.id}/payment-link`, {})).body.code === "awaiting_signature", "still held");
  await J.sent(L, "re-lock", []);

  J.step("the customer re-signs");
  // What the app's Finish sends when resignature.required (ClosingScreen).
  const now = new Date().toISOString();
  const resign = await srv.api("PATCH", `/api/work-orders/${wo.id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now, departedAt: now });
  const signed = resign.body.workOrder || await get(wo.id);
  J.ok(resign.status === 200 && signed?.resignature?.required === false && signed?.resignature?.satisfiedBy === "signature", `the new signature satisfies it (${resign.status} ${j(signed?.resignature)})`);
  J.ok(signed?.signature?.customerName === NEW_SIGNATURE.customerName, "the new signature is the one on the work order");
  J.ok((signed?.priorAcceptances || []).some((p) => p.signature?.imageData === original?.imageData), "the original 4-zone signature is kept");
  await sleep(400);
  const after = invoiceFor(srv, wo.id);
  J.ok(!after?.scopeHold, "the invoice hold is released");
  J.ok(invoicesFor(srv, wo.id).filter((i) => i.status !== "void").length === 1, `one live invoice for the visit (${invoicesFor(srv, wo.id).length})`);

  J.step("what is charged is what was signed");
  const billed = feeLine(after?.lineItems);
  const matchesSigned = billed?.key === "fall_close_6z" && after?.total === withTax(srv, priceOf("fall_close_6z"));
  J.finding(matchesSigned,
    `after the customer re-signs for 6 zones, the invoice still bills ${billed?.key} ($${after?.total}) — the price frozen at re-lock (${fee6?.key}) never reaches the invoice, so the pay link and Send would charge the OLD scope`);
  const link = await srv.api("POST", `/api/invoices/${after.id}/payment-link`, {});
  J.ok(link.status === 200, `payment opens again after the new signature (${link.status} ${link.body.code})`);
  await J.sent(L, "released", [], { settleMs: 800 });

  // The other direction: signed for 6, two zones turn out not to exist.
  J.step("signed for 6, reduced to 4");
  const g = await srv.fixture({ zones: 6, email: "fewer@example.com", name: "Fewer Zones", phone: "9055550147" });
  await srv.prepClosing(g.wo.id, { paidOnSite: true });
  J.ok((await finish(srv, g.wo.id)).status === 200, "finished and signed for 6");
  const inv6 = invoiceFor(srv, g.wo.id);
  J.ok(feeLine(inv6?.lineItems)?.key === "fall_close_6z", `invoiced at the 5-6 zone tier (${inv6?.total})`);
  await J.sent(L, "fewer: finish", [
    { channel: "email", to: g.cust.email, subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);
  await srv.api("POST", `/api/work-orders/${g.wo.id}/unlock`, { reason: "Zones 5 and 6 are the neighbour's system, not theirs" });
  const six = (await get(g.wo.id)).zones;
  r = await edit(g.wo.id, { zones: six.slice(0, 4) });
  J.ok(r.status === 200 && r.body.workOrder?.resignature?.required === true, `removing zones needs a new signature too (${r.status})`);
  const relock4 = await srv.api("POST", `/api/work-orders/${g.wo.id}/relock`, {});
  J.ok(feeLine(relock4.body.workOrder?.onSiteQuote?.builderLineItems)?.key === "fall_close_4z", "re-lock freezes the 1-4 zone price");
  const now2 = new Date().toISOString();
  const re4 = await srv.api("PATCH", `/api/work-orders/${g.wo.id}`, { status: "completed", signature: NEW_SIGNATURE, arrivedAt: now2, departedAt: now2 });
  J.ok(re4.status === 200, `the customer signs for 4 (${re4.status})`);
  await sleep(400);
  const after4 = invoiceFor(srv, g.wo.id);
  const pay4 = await srv.api("POST", `/api/invoices/${after4.id}/payment-link`, {});
  J.ok(pay4.status === 200, "payment is open again");
  J.finding(feeLine(after4?.lineItems)?.key === "fall_close_4z",
    `…and would OVERCHARGE: signed for 4 zones, the payable invoice still bills ${feeLine(after4?.lineItems)?.key} ($${after4?.total} instead of $${withTax(srv, priceOf("fall_close_4z"))})`);
  await J.sent(L, "fewer: released", [], { settleMs: 800 });
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();

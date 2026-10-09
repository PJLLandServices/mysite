#!/usr/bin/env node
// scripts/test-referral-credit.mjs
//
// "Send a neighbour or friend our way": the referrer's 10% (Patrick,
// 2026-10-09). Every welcome email promises "When a neighbour or friend
// books with us, you get 10% off your seasonal service charge", and nothing
// behind it existed. The rules it pins:
//
//   * the REFERRER gets the credit; the new customer pays the normal price
//   * 10% (pricing.json credits.referral_percent) of the SEASONAL SERVICE
//     CHARGE only, as its own line; HST on the lower amount
//   * one credit per referral, one per visit, oldest first
//   * "Has to be mentioned prior to processing! If I create the invoice
//     it's not available": a referral can't be added or changed on a visit
//     that has an invoice, and a credit is claimed when an invoice is MADE
//   * ONE rule for a credit's state (CLAUDE.md lifecycle): applied while a
//     live invoice carries it; voiding that invoice hands it back
//   * a credit is never used twice, even when two visits preview it
//   * recording one is the office's (admin) call
//
// Part 1 is the pure rule. Part 2 drives a real server on temp data with
// email, SMS and Stripe stubbed (scripts/lib/field-server.mjs).
//
// Run: node scripts/test-referral-credit.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, "pricing.json"), "utf8"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 300);
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---- 1. the rule ------------------------------------------------------------
let referrals = null;
try { referrals = require(path.join(ROOT, "server", "lib", "referrals.js")); } catch (_) {}
const pricing = require(path.join(ROOT, "server", "lib", "pricing.js"));
ok(referrals, "server/lib/referrals.js exists");
ok(typeof pricing.referralCreditPercent === "function" && pricing.referralCreditPercent() === PRICING.credits?.referral_percent,
  `the percent comes from pricing.json credits.referral_percent through pricing.referralCreditPercent (${PRICING.credits?.referral_percent})`);
const FEE = PRICING.items.fall_close_4z.price;
const PCT = PRICING.credits?.referral_percent;

if (referrals) {
  const fee = { key: "fall_close_4z", label: "Fall closing", qty: 1, originalPrice: FEE, overridePrice: null, source: { baseline: true } };
  const repair = { key: "head_replacement", label: "Head", qty: 2, originalPrice: PRICING.items.head_replacement.price, overridePrice: null };
  const wo = { id: "WO-D2", type: "fall_closing", customerId: "CUST-D" };
  const ref = (id, at, extra = {}) => ({ id, referrerCustomerId: "CUST-D", referredCustomerId: `CUST-${id}`, recordedAt: at, removedAt: null, appliedInvoiceId: null, ...extra });
  const base = { wo, lines: [fee, repair], invoices: [], percent: PCT, nameOf: () => "Sarah Mitchell" };

  const line = referrals.creditLineFor({ ...base, records: [ref("R2", "2026-10-02"), ref("R1", "2026-10-01")] });
  ok(line && line.originalPrice === -money(FEE * PCT / 100), `10% of the seasonal charge ONLY, not the repair (${line?.originalPrice})`);
  ok(line && line.referralCreditId === "R1", "the oldest credit is used first");
  ok(line && /Referral credit 10%/.test(line.label) && /Sarah M\./.test(line.label) && !/Mitchell/.test(line.label),
    `the line names the neighbour by first name and initial (${line?.label})`);
  ok(referrals.creditLineFor({ ...base, wo: { ...wo, type: "service_call" }, records: [ref("R1", "x")] }) === null, "a service call earns no credit — seasonal visits only");
  ok(referrals.creditLineFor({ ...base, records: [] }) === null, "a customer who referred nobody gets nothing");
  ok(referrals.creditLineFor({ ...base, lines: [{ ...fee, priceStatus: "pending", originalPrice: null }], records: [ref("R1", "x")] }) === null,
    "a fee still waiting on Patrick's price takes no credit (it waits for a priced visit)");
  ok(referrals.creditLineFor({ ...base, lines: [{ ...fee, originalPrice: 0 }], records: [ref("R1", "x")] }) === null, "a $0 (No Charge) visit takes no credit");

  const inv = (id, woId, status = "draft") => ({ id, woId, status });
  const s = (r, invs) => referrals.creditState(r, new Map(invs.map((i) => [i.id, i])));
  ok(s(ref("R1", "x"), []) === "available", "state: unused → available");
  ok(s(ref("R1", "x", { appliedInvoiceId: "I-1" }), [inv("I-1", "WO-D1")]) === "applied", "state: on a live invoice → applied");
  ok(s(ref("R1", "x", { appliedInvoiceId: "I-1" }), [inv("I-1", "WO-D1", "void")]) === "available", "state: its invoice voided → available again");
  ok(s(ref("R1", "x", { appliedInvoiceId: "I-gone" }), []) === "available", "state: a claim whose invoice was never written → available");
  ok(s(ref("R1", "x", { removedAt: "t" }), []) === "removed", "state: taken back → removed");

  const usedElsewhere = referrals.creditLineFor({ ...base, records: [ref("R1", "x", { appliedInvoiceId: "I-1" })], invoices: [inv("I-1", "WO-D1")] });
  ok(usedElsewhere === null, "a credit another visit's invoice holds is not offered again");
  const own = referrals.creditLineFor({ ...base, wo: { ...wo, id: "WO-D1" }, records: [ref("R1", "x", { appliedInvoiceId: "I-1" }), ref("R2", "y")], invoices: [inv("I-1", "WO-D1")] });
  ok(own && own.referralCreditId === "R1", "an invoiced visit keeps re-reading the credit ITS invoice claimed, never a new one");
  const invoicedNoCredit = referrals.creditLineFor({ ...base, wo: { ...wo, id: "WO-D1" }, records: [ref("R2", "y")], invoices: [inv("I-1", "WO-D1")] });
  ok(invoicedNoCredit === null, "a visit invoiced without a credit never gets one added after the fact");
}

// ---- wiring: one path for every reader ---------------------------------------
{
  const billing = fs.readFileSync(path.join(ROOT, "server", "lib", "billing.js"), "utf8");
  const inv = fs.readFileSync(path.join(ROOT, "server", "lib", "invoices.js"), "utf8");
  ok(/referrals"\)\.creditLineForWorkOrder\(/.test(billing), "billing.billingFor adds the credit — the preview, the summary, Finish and Generate all read it there");
  ok(/referrals"\)\.claimForInvoice\(/.test(inv), "invoices.createDraft claims the credit under the invoice lock");
  const lib = referrals ? fs.readFileSync(path.join(ROOT, "server", "lib", "referrals.js"), "utf8") : "";
  ok(!/\b10\s*\/\s*100\b|\*\s*0\.1\b/.test(lib), "no 10% typed into the code — it is pricing.json's");
}

// ---- the app: the sign-off asks, and shows the credit -------------------------
{
  const read = (f) => { try { return fs.readFileSync(path.join(ROOT, "pjl-field", "src", f), "utf8"); } catch { return ""; } };
  const signOff = read("screens/closing/SignOffStage.js");
  const section = read("screens/closing/ReferralSection.js");
  const api = read("api.js");
  ok(/<ReferralSection wo=\{wo\} role=\{role\}/.test(signOff) && signOff.indexOf("<ReferralSection") < signOff.indexOf("Finish and invoice"),
    "the sign-off shows the Referral section, before Finish and invoice");
  ok(/export const setReferral = /.test(api) && /\/referral`, 'PUT'/.test(api) && /export const getReferral = /.test(api), "the app reads and records referrals through the server");
  ok(/label="Referred by"/.test(section) && /lockedReason === 'invoiced'/.test(section) && /role === 'admin'/.test(section),
    "\"Referred by\" is a select row, locked once invoiced, the office's to set");
  ok(/view\.credit/.test(section) && !/\*\s*0\.1|\/\s*10\b/.test(section), "the credit shown is the server's figure — the phone works nothing out");
  // format.js imports the app's api module, so it can't load under plain
  // node: run its money() on its own.
  const fmt = read("format.js");
  const body = fmt.slice(fmt.indexOf("export const money"), fmt.indexOf("export const shortDate")).replace(/export const money\s*=/, "return");
  const money = new Function(body.replace(/;\s*$/, ""))();
  ok(money(-9) === "-$9.00" && money(9) === "$9.00" && money(null) === null, `a credit line reads -$9.00, not $-9.00 (${money(-9)})`);
}

// ---- 2. end to end on a real server -------------------------------------------
{
  const { bootServer, book, openWorkOrder, walkTheSystem, finish, invoiceFor, invoicesFor, dayOut, springDay, withTax } = await import("./e2e/lib/journey.mjs");
  const srv = await bootServer({ port: 4961 });
  try {
    await srv.login();
    const summary = async (woId) => (await srv.api("GET", `/api/work-orders/${woId}/customer-summary`)).body.summary;
    const creditOf = (lines) => (lines || []).find((l) => /Referral credit/.test(l.label || "")) || null;

    // Dave is a customer; Sarah is new and says Dave sent her.
    const dave = await book(srv, { serviceKey: "fall_close_4z", zoneCount: 4, day: dayOut(10),
      contact: { name: "Dave Kowalski", email: "dave@example.com", phone: "9055550161", address: "41 Prospect St, Newmarket, ON L3Y 3T1" } });
    const d1 = await openWorkOrder(srv, dave.lead.id);
    const sarah = await book(srv, { serviceKey: "fall_close_4z", zoneCount: 4, day: dayOut(11),
      contact: { name: "Sarah Mitchell", email: "sarah@example.com", phone: "9055550162", address: "17 Main St N, Newmarket, ON L3Y 3Z3" } });
    const s1 = await openWorkOrder(srv, sarah.lead.id);
    ok(d1.customerId && s1.customerId && d1.customerId !== s1.customerId, `two customers (${d1.customerId}, ${s1.customerId})`);

    const found = await srv.api("GET", `/api/work-orders/${s1.id}/referral-candidates?q=kowal`);
    ok(found.status === 200 && (found.body.candidates || []).some((c) => c.customerId === d1.customerId), `searching "kowal" finds Dave (${j(found.body)})`);
    const notSelf = await srv.api("GET", `/api/work-orders/${s1.id}/referral-candidates?q=sarah`);
    ok(!(notSelf.body.candidates || []).some((c) => c.customerId === s1.customerId), "Sarah can't pick herself");

    const put = await srv.api("PUT", `/api/work-orders/${s1.id}/referral`, { referrerCustomerId: d1.customerId });
    ok(put.status === 200 && put.body.referredBy?.customerId === d1.customerId && put.body.locked === false,
      `Patrick records "referred by Dave" on Sarah's visit (${put.status} ${j(put.body)})`);
    const self = await srv.api("PUT", `/api/work-orders/${s1.id}/referral`, { referrerCustomerId: s1.customerId });
    ok(self.status === 409, `a customer can't refer themselves (${self.status})`);

    // Sarah pays the normal price.
    await walkTheSystem(srv, s1.id, { walked: 4 });
    const sPrev = await summary(s1.id);
    ok(sPrev && !creditOf(sPrev.lines) && sPrev.subtotal === FEE, `Sarah's preview has no credit — she pays the normal price (${j(sPrev?.lines)})`);
    await finish(srv, s1.id);
    const sInv = invoiceFor(srv, s1.id);
    ok(sInv && sInv.subtotal === FEE && !creditOf(sInv.lineItems), `Sarah's invoice is the full fall closing (${sInv?.subtotal})`);
    const late = await srv.api("PUT", `/api/work-orders/${s1.id}/referral`, { referrerCustomerId: null });
    ok(late.status === 409 && late.body.code === "invoiced", `after her invoice exists the referral can't be changed (${late.status} ${late.body.code})`);
    const lateView = await srv.api("GET", `/api/work-orders/${s1.id}/referral`);
    ok(lateView.body.locked === true && lateView.body.lockedReason === "invoiced", "…and the app is told it's locked");

    // Dave's visit: 10% off the fall closing.
    await walkTheSystem(srv, d1.id, { walked: 4 });
    const dPrev = await summary(d1.id);
    const want = money(FEE * PCT / 100);
    ok(dPrev && creditOf(dPrev.lines)?.lineTotal === -want && dPrev.subtotal === money(FEE - want),
      `Dave's "What am I signing for?" shows the credit line −${want} and the lower subtotal (${j(dPrev?.lines)} ${dPrev?.subtotal})`);
    const dView = await srv.api("GET", `/api/work-orders/${d1.id}/referral`);
    ok(dView.body.credit?.amount === want && (dView.body.referred || []).some((r) => r.usedHere), `the app is told this visit uses Dave's credit (${j(dView.body)})`);
    await finish(srv, d1.id);
    const dInv = invoiceFor(srv, d1.id);
    ok(dInv && dInv.subtotal === money(FEE - want) && dInv.total === withTax(srv, FEE - want) && creditOf(dInv.lineItems)?.lineTotal === -want,
      `Dave's invoice: fall closing − ${want}, HST on the lower amount (${dInv?.subtotal} / ${dInv?.total})`);
    const refs = srv.data("referrals");
    ok(refs.length === 1 && refs[0].appliedInvoiceId === dInv?.id, `the credit is claimed by that invoice (${j(refs)})`);

    // One per referral: Dave's next visit pays full.
    const spring = await book(srv, { leadId: dave.lead.id, serviceKey: "spring_open_4z", zoneCount: 4, day: springDay(),
      contact: { name: "Dave Kowalski", email: "dave@example.com", phone: "9055550161", address: "41 Prospect St, Newmarket, ON L3Y 3T1" } });
    const d2 = await openWorkOrder(srv, spring.lead.id);
    ok(d2.customerId === d1.customerId && d2.id !== d1.id, `Dave's spring visit is his (${d2.customerId})`);
    await walkTheSystem(srv, d2.id, { walked: 4 });
    ok(!creditOf((await summary(d2.id))?.lines), "the credit is used once: Dave's next visit has none");

    // Void the invoice that used it: the credit comes back, by the one rule.
    const voided = await srv.api("POST", `/api/invoices/${dInv.id}/void`, { reason: "test" });
    ok(voided.status === 200, `void Dave's fall invoice (${voided.status})`);
    ok(creditOf((await summary(d2.id))?.lines)?.lineTotal === -money(PRICING.items.spring_open_4z.price * PCT / 100),
      "with that invoice void, the credit is available again — Dave's spring visit previews it");

    // Both visits now preview the same credit; the first invoice made takes it.
    const regen = await srv.api("POST", `/api/work-orders/${d1.id}/create-invoice`, {});
    const d1Again = invoiceFor(srv, d1.id);
    ok((regen.status === 200 || regen.status === 201) && creditOf(d1Again?.lineItems), `regenerating the fall invoice claims it again (${regen.status} ${j(d1Again?.lineItems)})`);
    ok(!creditOf((await summary(d2.id))?.lines), "…and the spring preview drops it at once");
    // A spring opening also needs a completion photo and a visit note.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const up = await srv.api("POST", `/api/work-orders/${d2.id}/photos`, { photos: [{ mediaType: "image/png", data: PNG, category: "general", clientUploadId: `field-up-${Date.now()}` }] });
    ok(up.status === 200 || up.status === 201, `the spring completion photo uploads (${up.status} ${j(up.body.errors)})`);
    await srv.qpatch(d2.id, { customerNotes: "System opened, all zones running." });
    const d2Done = await finish(srv, d2.id);
    ok(d2Done.status === 200, `Dave's spring visit finishes (${d2Done.status} ${j(d2Done.body.errors)})`);
    const d2Inv = invoiceFor(srv, d2.id);
    ok(d2Inv && !creditOf(d2Inv.lineItems) && d2Inv.subtotal === PRICING.items.spring_open_4z.price, `the spring invoice bills in full — never the same credit twice (${j(d2Inv && { s: d2Inv.subtotal, l: d2Inv.lineItems })})`);
    ok(invoicesFor(srv, d1.id).filter((i) => i.status !== "void").length === 1, "one live invoice for the fall visit");

    // The claim guard itself: a second invoice offering a credit already held is refused it.
    const claim = await srv.lib("referrals.js").claimForInvoice([srv.data("referrals")[0].id], { invoiceId: "I-TEST", woId: d2.id, invoiceRecords: srv.data("invoices") });
    ok(claim.claimed.length === 0 && claim.refused.length === 1, `a credit held by a live invoice can't be claimed again (${j(claim)})`);

    // The office's call: a tech can't record one.
    await srv.login({ role: "tech" });
    const tech = await srv.api("PUT", `/api/work-orders/${d2.id}/referral`, { referrerCustomerId: s1.customerId });
    ok(tech.status === 403, `a tech can't record a referral (${tech.status})`);
    const techRead = await srv.api("GET", `/api/work-orders/${d2.id}/referral`);
    ok(techRead.status === 200, `…but can see it (${techRead.status})`);
  } catch (err) {
    failed += 1;
    console.error("  CRASH:", err?.stack || err);
    console.error(srv.logs().slice(-1500));
  } finally {
    await srv.stop().catch(() => {});
  }
}

console.log(`test-referral-credit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

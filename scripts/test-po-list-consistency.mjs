#!/usr/bin/env node
// scripts/test-po-list-consistency.mjs
//
// A purchase order and its material-list lines save together or not at
// all (Patrick, 2026-10-02: "purchase-order and material-list updates must
// not be able to save only halfway again").
//
// Before: each route saved the PO, then the list lines, as two separate
// writes. From 2026-09-27 the second write was refused whenever the list
// had been bought from — receive-in-full and cancel answered 400 with the
// PO already saved, and a second PO from the same list answered 500 after
// the supplier had been emailed — leaving lines "ordered" on cancelled or
// received POs. Retries appended history and could email twice.
//
// Walked through the real routes, with the read-only audit
// (server/lib/purchasing-audit.js) asserting after every step that no PO
// and list line disagree:
//    1  first send
//    2  a second PO sent from a list whose other line is already ordered
//    3  partial receipt            4  full receipt
//    5  cancellation before receipt
//    6  cancellation after a partial receipt — what arrived is kept
//    7  re-order after cancellation, keeping the project and list link
//    8  repeated send / receive / cancel — nothing written twice,
//       nothing counted twice, the supplier emailed once
//    9  two sends at the same moment — one wins, one email
//   10  a write failing on EITHER file — both files exactly as before;
//       a crash between the two — finished on the next operation;
//       a retry after any of these — counted once
//   11  unrelated purchased lines and POs — byte-for-byte unchanged
//   12  the 2026-09-27 wholesale-replacement guard still refuses
//
// Run: npm run test:po-list-consistency

import fs from "node:fs";
import path from "node:path";
import { bootServer, j } from "./e2e/lib/journey.mjs";

// Full-length — journey.mjs j() cuts at 300 characters, fine for a
// label, useless for proving two files are identical.
const S = (v) => JSON.stringify(v);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const srv = await bootServer({ port: 4968 });
const PO_FILE = path.join(srv.DATA, "purchase-orders.json");
const ML_FILE = path.join(srv.DATA, "material-lists.json");
const JOURNAL = path.join(srv.DATA, "purchasing-journal.json");
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const bytes = () => ({ po: read(PO_FILE), ml: read(ML_FILE) });
const rawList = (id) => JSON.parse(read(ML_FILE) || "[]").find((r) => r.id === id);
const rawPo = (id) => JSON.parse(read(PO_FILE) || "[]").find((r) => r.id === id);
const rawLine = (listId, lineId) => (rawList(listId)?.lineItems || []).find((l) => l.id === lineId);
const emailsFor = (poId) => srv.outbox().filter((m) => JSON.stringify(m).includes(poId)).length;

try {
  await srv.login();
  const projects = srv.lib("projects.js");
  const materialLists = srv.lib("material-lists.js");
  const purchaseOrders = srv.lib("purchase-orders.js");
  const { auditPurchasingLines } = srv.lib("purchasing-audit.js");
  const audit = () => auditPurchasingLines({ purchaseOrders: JSON.parse(read(PO_FILE) || "[]"), materialLists: JSON.parse(read(ML_FILE) || "[]") });
  const clean = (label) => {
    const r = audit();
    ok(r.findings.length === 0, `${label}: no PO and list line disagree (${j(r.findings.map((f) => [f.kind, f.poId, f.sku]))})`);
  };
  const call = async (method, p, body) => srv.api(method, p, body);
  const must = async (method, p, body) => {
    const r = await call(method, p, body);
    ok(r.status < 300, `route: ${method} ${p.replace(/PO-\d+-\d+/, "PO")} succeeds (${r.status}${r.status >= 300 ? " " + S(r.body?.errors) : ""})`);
    return r.body || {};
  };
  const send = (po) => call("POST", `/api/purchase-orders/${po.id}/send`, { toEmail: "orders@siteone.test" });
  const lineOf = async (listId, sku) => (await materialLists.get(listId)).lineItems.find((l) => l.sku === sku);
  const poFor = (list, lines, extra = {}) => purchaseOrders.create({
    supplierName: "SiteOne", supplierEmail: "orders@siteone.test", sourceMaterialListIds: [list.id],
    lineItems: lines.map(([line, price]) => ({ sku: line.sku, qty: line.qty, unitPriceCents: price, lineTotalCents: price * line.qty, sourceListId: list.id, sourceLineId: line.id })),
    ...extra
  });

  const proj = await projects.create({ name: "PO consistency — Aurora", customerName: "Aurora Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const received = async (sku) => {
    const r = await call("GET", `/api/projects/${encodeURIComponent(proj.id)}/materials`);
    return (r.body?.stock || []).find((s) => s.sku === sku)?.received ?? 0;
  };

  // ── 11 (setup). An unrelated list on the same job, already bought from:
  // u1 received, u2 ordered, u3 never ordered. Nothing below may touch it.
  const listU = await materialLists.create({ name: "Side yard", parentType: "project", parentId: proj.id,
    lineItems: [{ sku: "61150", qty: 5 }, { sku: "61151", qty: 2 }, { sku: "61152", qty: 1 }] });
  const [u1, u2] = (await materialLists.get(listU.id)).lineItems;
  const poU = await poFor(listU, [[u1, 300], [u2, 400]]);
  await must("POST", `/api/purchase-orders/${poU.id}/send`, { toEmail: "orders@siteone.test" });
  await must("POST", `/api/purchase-orders/${poU.id}/receive`, { lineUpdates: { [(await purchaseOrders.get(poU.id)).lineItems[0].id]: 5 } });
  const listUBefore = S(rawList(listU.id));
  const poUBefore = S(rawPo(poU.id));
  const unrelatedUnchanged = (label) => {
    ok(S(rawList(listU.id)) === listUBefore, `${label}: the unrelated list is byte-for-byte unchanged`);
    ok(S(rawPo(poU.id)) === poUBefore, `${label}: the unrelated PO is byte-for-byte unchanged`);
  };

  // The job's main list.
  const listA = await materialLists.create({ name: "Front yard", parentType: "project", parentId: proj.id,
    lineItems: [{ sku: "61146", qty: 10 }, { sku: "61147", qty: 4 }, { sku: "61148", qty: 2 }] });
  const [a1, a2, a3] = (await materialLists.get(listA.id)).lineItems;

  // ── 1. First send.
  const poA3 = await poFor(listA, [[a3, 900]]);
  let r = await send(poA3);
  ok(r.status === 200, `1: the first send succeeds (${r.status})`);
  ok((await lineOf(listA.id, "61148")).status === "ordered" && (await lineOf(listA.id, "61148")).poId === poA3.id && (await lineOf(listA.id, "61148")).frozenPriceCents === 900,
    "1: its list line is ordered on it, price frozen at the PO's");
  ok(rawPo(poA3.id).status === "sent", "1: the PO is sent");
  clean("1"); unrelatedUnchanged("1");

  // ── 2. A second PO from the same list, while a3 is already ordered.
  const a3Bytes = S(rawLine(listA.id, a3.id));
  const po1 = await poFor(listA, [[a1, 1000], [a2, 500]]);
  r = await send(po1);
  ok(r.status === 200, `2: a second PO sent from a list already bought from succeeds (${r.status} ${j(r.body?.errors)})`);
  ok((await lineOf(listA.id, "61146")).poId === po1.id && (await lineOf(listA.id, "61147")).poId === po1.id, "2: its own lines are ordered on it");
  ok(S(rawLine(listA.id, a3.id)) === a3Bytes, "2: the line already ordered on the other PO is byte-for-byte unchanged");
  clean("2"); unrelatedUnchanged("2");

  // ── 8a. Sending again: refused, nothing written, no second email.
  let before = bytes();
  const sentEmails = emailsFor(po1.id);
  r = await send(po1);
  ok(r.status === 409, `8: sending a sent PO again is refused (${r.status})`);
  ok(S(bytes()) === S(before), "8: …and writes nothing");
  ok(emailsFor(po1.id) === sentEmails && sentEmails === 1, `8: …and the supplier was emailed once (${emailsFor(po1.id)})`);

  // ── 3. Partial receipt: 6 of 10.
  const po1Line1 = rawPo(po1.id).lineItems.find((l) => l.sku === "61146");
  r = await call("POST", `/api/purchase-orders/${po1.id}/receive`, { lineUpdates: { [po1Line1.id]: 6 } });
  ok(r.status === 200 && rawPo(po1.id).status === "partially_received", `3: a partial receipt is recorded (${r.status} ${rawPo(po1.id)?.status})`);
  ok((await lineOf(listA.id, "61146")).status === "ordered" && (await lineOf(listA.id, "61146")).poId === po1.id, "3: the part-arrived line stays ordered on the PO");
  ok(await received("61146") === 6, `3: the job counts 6 received (${await received("61146")})`);
  clean("3"); unrelatedUnchanged("3");

  // ── 8b. The same partial receipt again: nothing new.
  before = bytes();
  r = await call("POST", `/api/purchase-orders/${po1.id}/receive`, { lineUpdates: { [po1Line1.id]: 6 } });
  ok(r.status === 200, `8: repeating the same receipt is accepted (${r.status})`);
  ok(S(bytes()) === S(before), "8: …and writes nothing (no second history entry)");
  ok(await received("61146") === 6, "8: …and counts nothing twice");

  // ── 4. Full receipt of the first PO.
  r = await call("POST", `/api/purchase-orders/${poA3.id}/receive`, {});
  ok(r.status === 200 && rawPo(poA3.id).status === "received", `4: a full receipt is recorded (${r.status} ${j(r.body?.errors)})`);
  const a3now = await lineOf(listA.id, "61148");
  ok(a3now.status === "have" && a3now.poId === null && a3now.frozenPriceCents === 900, `4: its line is "have", the price paid kept (${j(a3now)})`);
  ok(await received("61148") === 2, "4: the job counts it received");
  clean("4"); unrelatedUnchanged("4");

  // ── 8c. Full receipt again: accepted, nothing new.
  before = bytes();
  r = await call("POST", `/api/purchase-orders/${poA3.id}/receive`, {});
  ok(r.status === 200, `8: repeating a full receipt is accepted (${r.status} ${j(r.body?.errors)})`);
  ok(S(bytes()) === S(before), "8: …and writes nothing");
  ok(await received("61148") === 2, "8: …and counts nothing twice");

  // ── 6. Cancel after the partial receipt: the 6 stay, the rest is freed.
  const a3BytesAfterReceipt = S(rawLine(listA.id, a3.id));
  r = await call("POST", `/api/purchase-orders/${po1.id}/cancel`, { reason: "Supplier short" });
  ok(r.status === 200 && rawPo(po1.id).status === "cancelled", `6: cancelling after a partial receipt succeeds (${r.status} ${j(r.body?.errors)})`);
  ok(await received("61146") === 6, "6: what arrived (6) is kept");
  const a1c = await lineOf(listA.id, "61146"), a2c = await lineOf(listA.id, "61147");
  ok(a1c.status === "need" && a1c.poId === null && a1c.frozenPriceCents === null && a2c.status === "need" && a2c.poId === null,
    `6: the outstanding lines go back to need, unlinked, price lock released (${j([a1c, a2c])})`);
  ok(S(rawLine(listA.id, a3.id)) === a3BytesAfterReceipt, "6: the received line from the other PO is byte-for-byte unchanged");
  clean("6"); unrelatedUnchanged("6");

  // ── 8d. Cancel again: nothing new.
  before = bytes();
  r = await call("POST", `/api/purchase-orders/${po1.id}/cancel`, { reason: "again" });
  ok(r.status === 200 && S(bytes()) === S(before), `8: repeating a cancel writes nothing (${r.status})`);

  // ── 7. Re-order after the cancellation.
  r = await call("POST", `/api/purchase-orders/${po1.id}/reorder`);
  const po2 = r.body?.purchaseOrder || {};
  ok(r.status === 201 && po2.status === "draft", `7: the re-order is a new draft (${r.status})`);
  ok(S(po2.sourceMaterialListIds) === S([listA.id]) && (po2.lineItems || []).every((l) => l.sourceListId === listA.id) &&
     po2.lineItems?.find((l) => l.sku === "61146")?.sourceLineId === a1.id, "7: it keeps the material-list link, PO and lines");
  ok((rawPo(po2.id)?.history || []).some((h) => h.action === "reorder_of" && h.note === po1.id), "7: …and the record of what it re-orders, in the same save");
  r = await send(po2);
  ok(r.status === 200 && (await lineOf(listA.id, "61146")).poId === po2.id, `7: sending it orders the freed lines on it (${r.status})`);
  r = await call("POST", `/api/purchase-orders/${po2.id}/receive`, {});
  ok(r.status === 200 && (await lineOf(listA.id, "61146")).status === "have", `7: receiving it completes them (${r.status})`);
  ok(await received("61146") === 16, `7: the job counts both POs — 6 + 10 = 16 (${await received("61146")})`);
  const proj2 = await call("GET", `/api/projects/${encodeURIComponent(proj.id)}/materials`);
  ok((proj2.body?.stock || []).find((s) => s.sku === "61146")?.receivedFromPoIds?.includes(po2.id), "7: the re-order is linked to the project's materials");
  clean("7"); unrelatedUnchanged("7");

  // ── 5. Cancel before anything arrives.
  const listB = await materialLists.create({ name: "Back yard", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61149", qty: 3 }] });
  const [b1] = (await materialLists.get(listB.id)).lineItems;
  const poB = await poFor(listB, [[b1, 200]]);
  await must("POST", `/api/purchase-orders/${poB.id}/send`, { toEmail: "orders@siteone.test" });
  r = await call("POST", `/api/purchase-orders/${poB.id}/cancel`, { reason: "Wrong part" });
  const b1c = await lineOf(listB.id, "61149");
  ok(r.status === 200 && b1c.status === "need" && b1c.poId === null && b1c.frozenPriceCents === null, `5: cancelling before receipt frees the line (${r.status} ${j(b1c)})`);
  ok(await received("61149") === 0, "5: …and counts nothing received");
  clean("5"); unrelatedUnchanged("5");

  // ── 9. Two sends of one draft at the same moment.
  const listC = await materialLists.create({ name: "Pump pad", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61153", qty: 1 }] });
  const [c1] = (await materialLists.get(listC.id)).lineItems;
  const poC = await poFor(listC, [[c1, 5000]]);
  const both = await Promise.all([send(poC), send(poC)]);
  const codes = both.map((x) => x.status).sort();
  ok(S(codes) === S([200, 409]), `9: two sends at once — one sends, one is refused (${j(codes)})`);
  ok(emailsFor(poC.id) === 1, `9: …and the supplier is emailed once (${emailsFor(poC.id)})`);
  ok((rawPo(poC.id)?.history || []).filter((h) => h.action === "sent").length === 1, "9: …and the PO records one send");
  clean("9"); unrelatedUnchanged("9");

  // ── 12. The 2026-09-27 guard still refuses a wholesale line replacement.
  let refused = null;
  try { await materialLists.update(listA.id, { lineItems: [{ sku: "61146", qty: 99 }] }); } catch (e) { refused = e.code; }
  ok(refused === "line_items_locked", `12: replacing a bought-from list's lines wholesale is still refused (${refused})`);
  r = await call("PATCH", `/api/material-lists/${listA.id}`, { lineItems: [{ sku: "61146", qty: 99 }] });
  ok(r.status >= 400 && (await lineOf(listA.id, "61146")).qty === 10, `12: …through the route too (${r.status})`);

  // ── 10. Failures part-way through a save. Run in this process against
  // the same files, with the server idle; the fault hook fails the write
  // of a named file the way a full disk or a refused write would.
  let purchasing = null, store = null;
  try { purchasing = srv.lib("purchasing.js"); store = srv.lib("purchasing-store.js"); } catch { /* old code */ }
  ok(Boolean(purchasing && store), "10: there is one commit path for a PO and its list lines");
  if (purchasing && store) {
    // Fail the nth write of `name` (1 = the first) from now on.
    const failOn = (name, { crash = false, nth = 1 } = {}) => {
      let seen = 0;
      store._setFaultHookForTests((file) => {
        if (file !== name || ++seen !== nth) return;
        const e = new Error(`injected failure writing ${file}`); if (crash) e.simulatedCrash = true; throw e;
      });
    };
    const attempt = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
    const listF = await materialLists.create({ name: "Fault list", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61154", qty: 4 }, { sku: "61155", qty: 2 }] });
    const [f1, f2] = (await materialLists.get(listF.id)).lineItems;
    const poF = await poFor(listF, [[f1, 100], [f2, 100]]);

    // Send writes twice: first the PO's sendInFlight mark (before any
    // email), then the outcome — the PO and its list lines together.
    const sendF = () => purchasing.sendPurchaseOrder(poF.id, { toEmail: "orders@siteone.test" }, async () => ({}));
    // (a) The mark itself fails to save: nothing changed, nothing emailed.
    before = bytes();
    failOn("purchase-orders.json", { nth: 1 });
    let e1 = await attempt(sendF);
    store._setFaultHookForTests(null);
    ok(e1 && /injected/.test(e1) && S(bytes()) === S(before) && !fs.existsSync(JOURNAL), `10: send — the in-flight mark failing to save leaves both files exactly as before (${e1})`);
    // (b) The outcome fails to save, on either file, after the email went:
    // the list and PO are put back to the marked draft — they agree — and
    // the PO is "delivery uncertain": it can't be emailed again blind.
    for (const [name, nth] of [["material-lists.json", 1], ["purchase-orders.json", 2]]) {
      if (name === "purchase-orders.json") await purchasing.resolveUncertainPoSend(poF.id, { outcome: "not_sent" });
      const mlBefore = read(ML_FILE);
      failOn(name, { nth });
      const err = await attempt(sendF);
      store._setFaultHookForTests(null);
      const p = rawPo(poF.id);
      ok(err && /injected/.test(err), `10: send — the outcome's ${name} write failing reports the failure (${err})`);
      ok(read(ML_FILE) === mlBefore && p.status === "draft" && p.sendInFlight && !fs.existsSync(JOURNAL),
        `10: …the list is exactly as before and the PO is a draft marked in flight — no half-saved send (${p.status}, ${S(p.sendInFlight)})`);
      clean(`10 send/${name}`);
      const retry = await attempt(sendF);
      ok(/interrupted before its result was saved/.test(retry || ""), `10: …so a retry is refused as delivery uncertain, not emailed again (${retry})`);
    }
    // The office checks: it went.
    await purchasing.resolveUncertainPoSend(poF.id, { outcome: "sent", by: "office@pjl.test" });
    ok(rawPo(poF.id).status === "sent" && !rawPo(poF.id).sendInFlight && (await lineOf(listF.id, "61154")).poId === poF.id,
      "10: recording that it went saves the PO sent and its lines ordered, together");
    clean("10 send settled");

    for (const [verb, run] of [
      ["receive", () => purchasing.receivePurchaseOrder(poF.id, {})]
    ]) {
      for (const name of ["material-lists.json", "purchase-orders.json"]) {
        before = bytes();
        failOn(name);
        const err = await attempt(run);
        store._setFaultHookForTests(null);
        ok(err && /injected/.test(err), `10: ${verb} with the ${name} write failing reports the failure (${err})`);
        ok(S(bytes()) === S(before), `10: …and BOTH files are exactly as before`);
        ok(!fs.existsSync(JOURNAL), "10: …and no commit is left half-done");
        clean(`10 ${verb}/${name}`);
      }
      const err = await attempt(run);
      ok(err === null, `10: retrying the ${verb} afterwards succeeds (${err})`);
      clean(`10 ${verb} retry`);
    }
    const pf = rawPo(poF.id);
    ok(pf.status === "received" && pf.lineItems.every((l) => l.receivedQty === l.qty), `10: after the retries the PO is received once — ${j(pf.lineItems.map((l) => [l.qty, l.receivedQty]))}`);
    ok(pf.history.filter((h) => h.action === "sent").length === 1 && pf.history.filter((h) => /status:received|receipt_recorded/.test(h.action)).length === 1,
      "10: …with one send and one receipt in its history");
    ok(S(pf.sendAttempts.map((a) => [a.ok, a.outcome])) === S([[false, "confirmed_not_delivered"], [true, "confirmed_delivered"]]),
      `10: …and every interrupted attempt kept on record (${S(pf.sendAttempts.map((a) => [a.ok, a.outcome]))})`);
    ok((await lineOf(listF.id, "61154")).status === "have" && (await lineOf(listF.id, "61155")).status === "have", "10: …and both list lines have it");
    ok(await received("61154") === 4, `10: the job counts 4 received, not 8 (${await received("61154")})`);

    // Cancel, failing each side, then retried.
    const listG = await materialLists.create({ name: "Cancel list", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61156", qty: 3 }] });
    const [g1] = (await materialLists.get(listG.id)).lineItems;
    const poG = await poFor(listG, [[g1, 100]]);
    await purchasing.sendPurchaseOrder(poG.id, { toEmail: "orders@siteone.test" }, async () => ({}));
    for (const name of ["material-lists.json", "purchase-orders.json"]) {
      before = bytes();
      failOn(name);
      const err = await attempt(() => purchasing.cancelPurchaseOrder(poG.id, { reason: "x" }));
      store._setFaultHookForTests(null);
      ok(err && S(bytes()) === S(before), `10: cancel with the ${name} write failing leaves both files exactly as before`);
      clean(`10 cancel/${name}`);
    }
    ok((await attempt(() => purchasing.cancelPurchaseOrder(poG.id, { reason: "x" }))) === null && rawPo(poG.id).status === "cancelled" &&
       (await lineOf(listG.id, "61156")).status === "need", "10: retrying the cancel succeeds, both sides agree");
    clean("10 cancel retry");

    // A crash between the two writes: the list saved, the PO didn't.
    const listH = await materialLists.create({ name: "Crash list", parentType: "project", parentId: proj.id, lineItems: [{ sku: "61157", qty: 1 }] });
    const [h1] = (await materialLists.get(listH.id)).lineItems;
    const poH = await poFor(listH, [[h1, 100]]);
    failOn("purchase-orders.json", { crash: true, nth: 2 });   // the outcome commit: list written, PO not
    await attempt(() => purchasing.sendPurchaseOrder(poH.id, { toEmail: "orders@siteone.test" }, async () => ({})));
    store._setFaultHookForTests(null);
    ok(fs.existsSync(JOURNAL) && audit().findings.length > 0, "10: a crash between the writes leaves the files disagreeing — with the journal to finish it");
    // The server's next purchasing operation finishes it first.
    r = await call("PATCH", `/api/material-lists/${listB.id}`, { notes: "touched after the crash" });
    ok(!fs.existsSync(JOURNAL), "10: the next operation finishes the interrupted commit");
    ok(rawPo(poH.id).status === "sent" && rawLine(listH.id, h1.id).status === "ordered" && rawLine(listH.id, h1.id).poId === poH.id,
      "10: …so the PO is sent and its line ordered on it");
    clean("10 crash recovered");

    // A journal overtaken by later writes is set aside, never applied.
    before = bytes();
    fs.writeFileSync(JOURNAL, JSON.stringify({ state: "commit", files: [{ name: "purchase-orders.json", before: "[]\n", after: "[]\n" }] }));
    const rec = store.recover();
    ok(rec.problem && rec.problem.kind === "journal_stale" && S(bytes()) === S(before) && !fs.existsSync(JOURNAL), `10: a stale journal is set aside, reported, without touching the data (${j(rec)})`);
  }
  unrelatedUnchanged("end");
  clean("end");
} catch (err) {
  failed += 1;
  console.error("  FAIL: crashed —", err && err.stack || err);
} finally {
  await srv.stop();
}

console.log(`\npo / list consistency: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

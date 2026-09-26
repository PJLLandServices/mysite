#!/usr/bin/env node
// scripts/test-resign-scope.mjs
//
// Re-signing after a priced-scope change (Patrick, 2026-09-26).
//
// THE RULE: when a signed (or bypass-accepted) work order is unlocked and
// changed in a way that affects what the customer pays, the customer must
// sign again. The original acceptance is kept; the revised work order is
// marked as needing a new signature; when the revised scope is re-locked,
// its price is set and frozen then, and the new signature is still
// required before normal completion or payment. Changes that don't touch
// price (tech notes, zone labels) never need one.
//
// WHAT BROKE (verified on the parent):
//   * An unlocked signed WO could have zones added and be re-locked with
//     nothing asking the customer to sign again. The invoice stayed
//     payable and sendable throughout.
//   * A new signature on an unlocked WO silently REPLACED the customer's
//     original one. Nothing kept it, and no history entry recorded it.
//
// WHAT THIS PINS (booted server, temp data, email/SMS/Stripe stubbed):
//   A. notes and zone labels on an unlocked signed WO: no new signature
//   B. adding a zone: marked, history says why, invoice held (no pay link,
//      no send, no Tap to Pay, no cascade re-run, no new invoice)
//   C. putting the zone back clears it; changing it again re-marks it
//   D. re-lock freezes the revised price (5 zones) and still needs the
//      signature; the scope stays locked
//   E. the new signature: accepted through the lock, the original kept in
//      priorAcceptances, the hold released
//   F. before completion: a bypass-accepted WO unlocked and changed will
//      not finish without a new acceptance; a new bypass satisfies it
//   G. a new signature on an unlocked WO archives the first, never
//      overwrites it
//
// Run: node scripts/test-resign-scope.mjs   (also in build:check)

import { bootServer, SIGNATURE, sleep } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const j = (v) => JSON.stringify(v)?.slice(0, 240);
const NEW_SIGNATURE = { acknowledgement: true, imageData: "data:image/png;base64," + "B".repeat(220), customerName: "Jane Customer (revised)" };

const srv = await bootServer({ port: 4917 });
try {
  await srv.login();
  const get = async (id) => (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;
  const invoiceFor = (woId) => srv.data("invoices").find((i) => i.woId === woId && i.status !== "void") || null;
  const zoneCount = (wo) => (wo.zones || []).filter((z) => (z.kind || "zone") === "zone").length;
  const feeLine = (wo) => (wo.onSiteQuote?.builderLineItems || []).find((l) => /^fall_close_/.test(l?.key || ""));
  // An edit to an already-completed WO refreshes its report PDF in the
  // background (server.js "post-completion auto-snapshot"), and that write
  // lands on the WO a moment later. On a slow runner the NEXT edit's
  // If-Match can race it and get 409 version_conflict. That is correct: it
  // is the "reload and save again" the office sees. So an edit here does
  // what a person does, and re-reads and saves again on version_conflict
  // only. Every other refusal is returned as-is.
  const edit = async (woId, patch) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await srv.qpatch(woId, patch);
      if (!(res.status === 409 && res.body?.error === "version_conflict")) return res;
      await sleep(250);
    }
    return srv.qpatch(woId, patch);
  };

  // A finished, signed 4-zone closing ("Bill later") with its invoice.
  const f = await srv.fixture({ zones: 4 });
  const id = f.wo.id;
  await srv.prepClosing(id);
  const done = await srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: SIGNATURE,
    arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
  ok(done.status === 200, `setup: the closing is signed and completed (${done.status})`);
  await sleep(500);
  const inv0 = invoiceFor(id);
  ok(Boolean(inv0), "setup: its invoice is drafted");
  const signedFirst = await get(id);
  const originalImage = signedFirst.signature?.imageData;
  const unlock = await srv.api("POST", `/api/work-orders/${id}/unlock`, { reason: "Customer asked for a fifth zone to be added" });
  ok(unlock.status === 200 && unlock.body.workOrder?.locked === false, `setup: admin unlocks it (${unlock.status})`);

  // ---- A. changes that don't touch price --------------------------------
  let r = await edit(id, { techNotes: "Customer mentioned the side gate sticks." });
  ok(r.status === 200 && r.body.workOrder?.resignature?.required !== true, `A. a tech note needs no new signature (${j(r.body.workOrder?.resignature)})`);
  const relabelled = (await get(id)).zones.map((z, i) => (i === 0 ? { ...z, location: "Front lawn by the maple" } : z));
  r = await edit(id, { zones: relabelled });
  ok(r.status === 200 && r.body.workOrder?.resignature?.required !== true, `A. renaming a zone needs no new signature (${j(r.body.workOrder?.resignature)})`);

  // ---- B. adding a zone changes the price --------------------------------
  const four = (await get(id)).zones;
  const five = [...four, { number: 5, location: "Zone 5", status: "ok", kind: "zone" }];
  r = await edit(id, { zones: five });
  let wo = r.body.workOrder;
  ok(r.status === 200 && wo?.resignature?.required === true, `B. adding a zone marks it as needing a new signature (${r.status} ${j(wo?.resignature)})`);
  ok((wo?.history || []).some((h) => h.action === "resignature_required"), "B. …and the history says why");
  ok(wo?.signature?.imageData === originalImage, "B. …the original signature is still on file");
  await sleep(200);
  ok(Boolean(invoiceFor(id)?.scopeHold?.since), `B. the invoice is held (${j(invoiceFor(id)?.scopeHold)})`);
  const link = await srv.api("POST", `/api/invoices/${inv0.id}/payment-link`, {});
  ok(link.status === 409 && link.body.code === "awaiting_signature", `B. no pay link (${link.status} ${link.body.code})`);
  const tap = await srv.api("POST", `/api/invoices/${inv0.id}/terminal-intent`, {});
  ok(tap.status === 409 && tap.body.code === "awaiting_signature", `B. no Tap to Pay charge (${tap.status} ${tap.body.code})`);
  const send = await srv.api("POST", `/api/invoices/${inv0.id}/send`, {});
  ok(send.status === 409 && send.body.code === "awaiting_signature", `B. not sendable (${send.status} ${send.body.code})`);
  const rerun = await srv.api("POST", `/api/work-orders/${id}/run-cascade`, {});
  ok(rerun.status === 409 && rerun.body.error === "resign_required", `B. no cascade re-run (${rerun.status} ${rerun.body.error})`);
  const gen = await srv.api("POST", `/api/work-orders/${id}/create-invoice`, {});
  ok(gen.status === 409 && gen.body.error === "resign_required", `B. no invoice for the unsigned revised scope (${gen.status} ${gen.body.error})`);

  // ---- C. back to what was signed, then changed again ---------------------
  r = await edit(id, { zones: four });
  ok(r.status === 200 && r.body.workOrder?.resignature?.required === false, `C. putting the zone back clears it (${j(r.body.workOrder?.resignature)})`);
  await sleep(200);
  ok(!invoiceFor(id)?.scopeHold, "C. …and releases the invoice");
  r = await edit(id, { zones: five });
  ok(r.body.workOrder?.resignature?.required === true, "C. adding it again marks it again");

  // ---- D. re-lock freezes the revised price ---------------------------------
  const relock = await srv.api("POST", `/api/work-orders/${id}/relock`, {});
  wo = relock.body.workOrder;
  ok(relock.status === 200 && wo?.locked === true, `D. the revised scope re-locks (${relock.status})`);
  ok(wo?.resignature?.required === true && Boolean(wo?.resignature?.pricedAtRelock), `D. …its price is frozen at re-lock and the new signature is still needed (${j(wo?.resignature)})`);
  ok(feeLine(wo)?.source?.recordedZones === 5 && zoneCount(wo) === 5, `D. …priced from the 5 zones walked (${j(feeLine(wo)?.source)})`);
  const frozen = await edit(id, { onSiteQuote: { ...wo.onSiteQuote, builderLineItems: [] } });
  ok(frozen.status === 409 && frozen.body.error === "wo_locked", `D. the re-locked priced scope can't be edited (${frozen.status} ${frozen.body.error})`);
  await sleep(200);
  ok(Boolean(invoiceFor(id)?.scopeHold?.since), "D. the invoice stays held until the customer signs");

  // ---- E. the customer signs the revised work order -----------------------
  const resign = await srv.api("PATCH", `/api/work-orders/${id}`, { status: "completed", signature: NEW_SIGNATURE });
  wo = resign.body.workOrder || await get(id);
  ok(resign.status === 200, `E. the new signature is accepted through the lock (${resign.status} ${j(resign.body.errors)})`);
  ok(wo?.resignature?.required === false && wo?.resignature?.satisfiedBy === "signature", `E. …it satisfies the requirement (${j(wo?.resignature)})`);
  ok(wo?.signature?.customerName === NEW_SIGNATURE.customerName, "E. …the new signature is the one on the work order");
  const prior = wo?.priorAcceptances || [];
  ok(prior.length === 1 && prior[0].signature?.imageData === originalImage, `E. …and the ORIGINAL signature is kept in priorAcceptances (${prior.length})`);
  ok((wo?.history || []).some((h) => h.action === "resignature_captured"), "E. …the history records it");
  ok(wo?.locked === true && feeLine(wo)?.source?.recordedZones === 5, "E. the price frozen at re-lock is the one signed");
  await sleep(200);
  ok(!invoiceFor(id)?.scopeHold, "E. the invoice hold is released");

  // ---- F. before completion, with a bypass --------------------------------
  {
    const g = await srv.fixture({ zones: 4 });
    const gid = g.wo.id;
    await srv.prepClosing(gid);
    const by = await srv.api("POST", `/api/work-orders/${gid}/signature-bypass`, { reason: "customer_not_home", note: "left at the door" });
    ok(by.status < 300 && by.body.workOrder?.locked === true, `F. setup: accepted by bypass (${by.status})`);
    await srv.api("POST", `/api/work-orders/${gid}/unlock`, { reason: "Tech found an extra zone on the side yard" });
    const cur = (await get(gid)).zones;
    const more = await edit(gid, { zones: [...cur, { number: 5, location: "Side yard", status: "ok", kind: "zone" }] });
    ok(more.body.workOrder?.resignature?.required === true, "F. the extra zone needs a new acceptance");
    const blocked = await srv.api("PATCH", `/api/work-orders/${gid}`, { status: "completed", arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    ok(blocked.status === 409 && blocked.body.error === "resign_required", `F. it won't finish without one (${blocked.status} ${blocked.body.error})`);
    ok(!invoiceFor(gid), "F. …and nothing is invoiced");
    const again = await srv.api("POST", `/api/work-orders/${gid}/signature-bypass`, { reason: "customer_not_home", note: "revised scope, customer away" });
    const gw = again.body.workOrder || await get(gid);
    ok(again.status < 300 && gw?.resignature?.required === false && gw?.resignature?.satisfiedBy === "bypass", `F. a new admin bypass satisfies it (${again.status} ${j(gw?.resignature)})`);
    ok((gw?.priorAcceptances || []).length === 1 && Boolean(gw.priorAcceptances[0].signatureBypass), "F. …the first bypass is kept in priorAcceptances");
    const fin = await srv.api("PATCH", `/api/work-orders/${gid}`, { status: "completed", arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    ok(fin.status === 200, `F. then it finishes normally (${fin.status} ${j(fin.body.errors)})`);
  }

  // ---- G. a new signature on an unlocked WO never overwrites the first ----
  {
    const h = await srv.fixture({ zones: 3 });
    const hid = h.wo.id;
    await srv.prepClosing(hid);
    await srv.api("PATCH", `/api/work-orders/${hid}`, { status: "completed", signature: SIGNATURE,
      arrivedAt: new Date().toISOString(), departedAt: new Date().toISOString() });
    const first = (await get(hid)).signature?.imageData;
    await srv.api("POST", `/api/work-orders/${hid}/unlock`, { reason: "Re-sign after the customer asked to see it again" });
    const again = await srv.api("PATCH", `/api/work-orders/${hid}`, { signature: NEW_SIGNATURE });
    const hw = again.body.workOrder || await get(hid);
    ok(again.status === 200 && hw?.signature?.customerName === NEW_SIGNATURE.customerName, `G. an unlocked WO takes a new signature (${again.status})`);
    ok((hw?.priorAcceptances || [])[0]?.signature?.imageData === first, "G. …and the first signature is archived, not overwritten");
    ok((hw?.history || []).some((e) => e.action === "signature_replaced"), "G. …with a history entry");
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: suite crashed —", err.stack || err.message);
  console.error(srv.logs().slice(-2000));
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`resign-scope: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

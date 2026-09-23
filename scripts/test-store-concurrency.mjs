#!/usr/bin/env node
// scripts/test-store-concurrency.mjs
//
// Two saves at once must not wipe a work order (fall-closing fix #1).
//
// The pressure test (2026-09-22) ran the phone's PATCH, the office's PATCH
// and a photo upload against one work order in the same second. techNotes
// were lost in 3 of 3 rounds, and in round 4 work-orders.json was left
// unparseable: readAll() answered [] instead of failing, GET
// /api/work-orders returned 0 jobs, and the next POST wrote a one-record
// file over every work order there was.
//
// Three stores the closing touches share that shape — work orders,
// invoices, properties (which also carries the deferred issues). For each:
//
//   1. 50+ rounds of concurrent read-modify-writes on DIFFERENT fields and
//      DIFFERENT records. Every write must survive, the file must parse
//      after every round. Arithmetic, not a threshold: one lost write fails.
//   2. A deliberately corrupt file makes reads and writes FAIL LOUDLY, and
//      the corrupt bytes are left exactly as they were (no save over them).
//
// Isolation: the libs resolve their store as `<lib>/../data/*.json`, so the
// suite runs against copies in a temp directory and never touches real data.
//
// Run: node scripts/test-store-concurrency.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-store-concurrency-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
for (const f of ["work-orders.js", "invoices.js", "properties.js", "customers.js",
  "billing-parties.js", "atomic-json.js"]) {
  fs.copyFileSync(path.join(ROOT, "server", "lib", f), path.join(SANDBOX, "lib", f));
}
const DATA = (n) => path.join(SANDBOX, "data", n);
for (const n of ["work-orders.json", "invoices.json", "properties.json", "customers.json"]) {
  fs.writeFileSync(DATA(n), "[]\n");
}
const workOrders = require(path.join(SANDBOX, "lib", "work-orders.js"));
const invoices = require(path.join(SANDBOX, "lib", "invoices.js"));
const properties = require(path.join(SANDBOX, "lib", "properties.js"));

const ROUNDS = 60;
const parses = (n) => { try { JSON.parse(fs.readFileSync(DATA(n), "utf8")); return true; } catch { return false; } };
const leftoverTmp = () => fs.readdirSync(path.join(SANDBOX, "data")).filter((f) => f.endsWith(".tmp"));

try {
  // ---- 1. work orders: concurrent edits to one job and its neighbour --
  {
    const lead = { id: "L-RACE", customerId: "1", contact: { name: "Race Test", email: "r@example.com", phone: "", address: "1 Test St" } };
    const A = await workOrders.create({ type: "fall_closing", lead });
    const B = await workOrders.create({ type: "fall_closing", lead });
    // A pile of other jobs that must still be there at the end — the
    // round-4 failure mode was every OTHER work order disappearing.
    await Promise.all(Array.from({ length: 8 }, () => workOrders.create({ type: "service_visit", lead })));
    let lost = 0, torn = 0;
    for (let t = 0; t < ROUNDS; t++) {
      await Promise.all([
        workOrders.update(A.id, { techNotes: `A-${t}` }),           // the phone
        workOrders.update(A.id, { customerNotes: `office-${t}` }),  // the office, same job
        workOrders.update(B.id, { techNotes: `B-${t}` }),           // another job
        workOrders.appendHistory(A.id, { type: "note", note: `h-${t}` }) // photo route / audit trail
      ]);
      if (!parses("work-orders.json")) torn += 1;
      const a = await workOrders.get(A.id);
      const b = await workOrders.get(B.id);
      const hist = (a?.history || []).some((h) => h.note === `h-${t}`);
      if (a?.techNotes !== `A-${t}` || a?.customerNotes !== `office-${t}` || b?.techNotes !== `B-${t}` || !hist) lost += 1;
    }
    ok(lost === 0, `work orders: no lost write across ${ROUNDS} concurrent rounds (lost in ${lost})`);
    ok(torn === 0, `work orders: file parsed after every round (torn ${torn})`);
    ok((await workOrders.list()).length === 10, "work orders: every other job is still there");

    // Concurrent creates: N succeed ⇒ N on disk.
    const made = await Promise.all(Array.from({ length: 20 }, () => workOrders.create({ type: "service_visit", lead })));
    const all = await workOrders.list();
    ok(made.every((w) => all.some((x) => x.id === w.id)), "work orders: 20 concurrent creates all persisted");
  }

  // ---- 2. invoices: the fixed `invoices.json.tmp` name collided --------
  {
    const made = await Promise.all(Array.from({ length: 25 }, (_, i) => invoices.createDraft({
      customerName: `Inv ${i}`, lineItems: [{ label: "Line", qty: 1, unitPrice: 10 }]
    }).then((r) => r, (e) => ({ error: e }))));
    ok(made.every((r) => !r.error), `invoices: 25 concurrent drafts all succeeded (${made.filter((r) => r.error).map((r) => r.error.message)[0] || "ok"})`);
    const on = await invoices.list();
    ok(on.length === 25, `invoices: exactly 25 on disk (got ${on.length})`);
    const [x, y] = on;
    let lost = 0;
    for (let t = 0; t < ROUNDS; t++) {
      await Promise.all([
        invoices.update(x.id, { notes: `x-${t}` }),
        invoices.update(x.id, { customerPhone: `905-${t}` }),
        invoices.update(y.id, { notes: `y-${t}` })
      ]);
      const gx = await invoices.get(x.id), gy = await invoices.get(y.id);
      if (gx?.notes !== `x-${t}` || gx?.customerPhone !== `905-${t}` || gy?.notes !== `y-${t}`) lost += 1;
    }
    ok(lost === 0, `invoices: no lost write across ${ROUNDS} rounds (lost in ${lost})`);
  }

  // ---- 3. properties: defer-issues vs a property PATCH ----------------
  {
    const p = await properties.create({ customerId: "1", address: "2 Test St", customerName: "Prop Race" });
    const q = await properties.create({ customerId: "1", address: "3 Test St", customerName: "Prop Race" });
    let lost = 0;
    for (let t = 0; t < ROUNDS; t++) {
      await Promise.all([
        properties.addDeferredIssue(p.id, { type: "broken_head", notes: `d-${t}`, zoneNumber: 1 }),
        properties.update(p.id, { notes: `n-${t}` }),
        properties.update(q.id, { notes: `q-${t}` })
      ]);
      const gp = await properties.get(p.id), gq = await properties.get(q.id);
      const deferredHere = (gp?.deferredIssues || []).length === t + 1;
      if (!deferredHere || gp?.notes !== `n-${t}` || gq?.notes !== `q-${t}`) lost += 1;
    }
    ok(lost === 0, `properties: no lost defer/PATCH across ${ROUNDS} rounds (lost in ${lost})`);
  }

  ok(leftoverTmp().length === 0, `no temp files left behind (${leftoverTmp().join(",")})`);

  // ---- 4. a damaged store fails loudly and is never saved over --------
  for (const [name, lib, write] of [
    ["work-orders.json", workOrders, () => workOrders.create({ type: "service_visit", lead: { id: "L2", contact: { name: "X" } } })],
    ["invoices.json", invoices, () => invoices.createDraft({ customerName: "X", lineItems: [] })],
    ["properties.json", properties, () => properties.create({ customerId: "1", address: "9 X St", customerName: "X" })]
  ]) {
    const CORRUPT = '[{"id":"WO-KEEP","type":"fall_closing"}, {"id": "WO-TORN", "zo';
    fs.writeFileSync(DATA(name), CORRUPT);
    let readErr = null, writeErr = null;
    try { await lib.list(); } catch (e) { readErr = e; }
    try { await write(); } catch (e) { writeErr = e; }
    ok(readErr && /unreadable/.test(readErr.message), `${name}: a corrupt file makes list() throw (got ${readErr ? readErr.message : "[] silently"})`);
    ok(Boolean(writeErr), `${name}: a corrupt file refuses the next save`);
    ok(fs.readFileSync(DATA(name), "utf8") === CORRUPT, `${name}: the damaged bytes were NOT overwritten (recoverable by hand)`);
    // Truncated to nothing is damage too, not "no records".
    fs.writeFileSync(DATA(name), "");
    let emptyErr = null;
    try { await lib.list(); } catch (e) { emptyErr = e; }
    ok(Boolean(emptyErr), `${name}: a zero-byte file is damage, not an empty store`);
    fs.writeFileSync(DATA(name), "[]\n");
  }
  // A missing file is the one legitimate empty.
  fs.rmSync(DATA("work-orders.json"));
  ok((await workOrders.list()).length === 0, "a missing work-orders.json is created empty, not an error");
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

// ---- 5. the real routes: phone PATCH + office PATCH + photo upload ----
// The exact pressure-test scenario, through HTTP against a booted server
// (temp data dir, outbound stubbed). 50 rounds, no lost write.
{
  const srv = await bootServer({ port: 4862 });
  try {
    await srv.login();
    const cust = await srv.lib("customers.js").create({ name: "Race Customer", email: "race@example.com", phone: "9055550100" });
    const prop = (await srv.api("POST", "/api/properties", { customerId: cust.id, address: "851 Hilton Blvd, Newmarket, ON" })).body.property;
    const A = (await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: prop.id })).body.workOrder;
    const B = (await srv.api("POST", "/api/work-orders", { type: "fall_closing", propertyId: prop.id })).body.workOrder;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let lost = 0;
    for (let t = 0; t < 50; t++) {
      const ga = (await srv.api("GET", `/api/work-orders/${A.id}`)).body.workOrder;
      const gb = (await srv.api("GET", `/api/work-orders/${B.id}`)).body.workOrder;
      const cid = `field-race-${t}`;
      await Promise.all([
        srv.api("PATCH", `/api/work-orders/${A.id}`, { techNotes: `A-${t}` }, { "if-match": ga?.updatedAt || "" }),
        srv.api("PATCH", `/api/work-orders/${B.id}`, { techNotes: `B-${t}` }, { "if-match": gb?.updatedAt || "" }),
        srv.api("POST", `/api/work-orders/${A.id}/photos`, { photos: [{ mediaType: "image/png", data: png, category: "general", clientUploadId: cid }] })
      ]);
      let wos = [];
      try { wos = srv.data("work-orders"); } catch { lost += 1; continue; }
      const a = wos.find((w) => w.id === A.id), b = wos.find((w) => w.id === B.id);
      if (a?.techNotes !== `A-${t}` || b?.techNotes !== `B-${t}` || !(a?.photos || []).some((p) => p.clientUploadId === cid)) lost += 1;
    }
    ok(lost === 0, `HTTP: PATCH + PATCH + photo upload, 50 rounds, no lost write (lost in ${lost})`);
    const list = await srv.api("GET", "/api/work-orders");
    ok((list.body.workOrders || []).length === 2, `HTTP: both work orders still listed (got ${(list.body.workOrders || []).length})`);
    ok(srv.outbox().length === 0, "HTTP: nothing was emailed or texted by the race");
  } finally {
    await srv.stop();
  }
}

console.log(`store-concurrency: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

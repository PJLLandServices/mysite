#!/usr/bin/env node
// scripts/test-photo-markup.mjs
//
// A marked-up photo, server side (PJL-112). Booted server
// (scripts/lib/field-server.mjs), temp data, nothing sent.
//
//   A. a markup is a new photo linked to its original (by number or by the
//      original's upload id), filed where the original is — zone, finding,
//      label from the SERVER's copy — and the original is untouched.
//   B. one markup per original (D-B2): a second replaces the first, which
//      is deleted like any photo (file, tombstone, history).
//   C. the customer sees the markup in the original's place (D-B1):
//      customerPhotos, the report's customer audience, and the findings
//      copied to the property. The office's internal report keeps both.
//   D. the pair travels together: moving the original moves its markup;
//      deleting the original deletes its markup; deleting the markup keeps
//      the original.
//   E. a markup whose original is gone: deleted → dropped with a
//      tombstone (neither comes back); never there → refused.
//   F. the switches: the session advertises photoMarkup, and photoShrink
//      is OFF unless FIELD_PHOTO_SHRINK=1 — shrinking ships on its own.
//
// Every check fails on the server before PJL-112 (markupOf was dropped).
//
// Run: node scripts/test-photo-markup.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "./lib/field-server.mjs";

const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const photo = (cid, meta = {}) => ({ mediaType: "image/png", data: png, category: "issue", clientUploadId: cid, ...meta });

async function run(env, fn) {
  const srv = await bootServer({ port: env.port, env: env.env || {} });
  try { await fn(srv); }
  catch (err) { failed += 1; console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`); }
  finally {
    ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
    await srv.stop();
  }
}

await run({ port: 4941 }, async (srv) => {
  await srv.login({ role: "tech" });
  const s = (await srv.api("GET", "/api/session")).body;
  ok(s.fieldOffline?.photoMarkup === 1, "F. the session advertises photoMarkup");
  ok(s.fieldOffline?.photoShrink === 0, `F. shrinking is off unless switched on (${s.fieldOffline?.photoShrink})`);

  const f = await srv.fixture({ zones: 3 });
  const id = f.wo.id;
  const W = srv.lib("work-orders.js");
  const wo = () => srv.data("work-orders").find((w) => w.id === id);
  const byCid = (cid) => wo().photos.find((p) => p.clientUploadId === cid);
  const dir = path.join(srv.DATA, "wo-photos", id);
  const upload = (p) => srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [p] });

  // A finding on zone 1, and its photo.
  await W.update(id, { zones: (await W.get(id)).zones.map((z) => (Number(z.number) === 1 ? { ...z, issues: [{ id: "iss_m1", type: "broken_head", qty: 1 }] } : z)) });
  await upload(photo("field-o-1", { zoneNumber: 1, label: "zone_1", issueId: "iss_m1" }));
  const orig = byCid("field-o-1");
  const origBefore = JSON.stringify(orig);

  // ---- A. linked and filed ---------------------------------------------------
  let r = await upload(photo("field-m-1", { markupOf: { n: orig.n }, zoneNumber: 3, label: "wrong", issueId: null }));
  const m1 = byCid("field-m-1");
  ok(r.status === 201 && m1 && m1.markupOf === orig.n, `A. the markup is a new photo naming its original (#${m1?.markupOf})`);
  ok(m1.zoneNumber === 1 && m1.issueId === "iss_m1" && m1.label === "zone_1", `A. filed where the original is, from the server's copy — not the phone's (${m1.zoneNumber}, ${m1.issueId}, ${m1.label})`);
  ok(m1.markupOfUpload === "field-o-1", "A. and it knows the original's upload id");
  ok(JSON.stringify(byCid("field-o-1")) === origBefore && fs.existsSync(path.join(dir, `${orig.n}.png`)), "A. the original is untouched");
  ok((wo().history || []).some((h) => h.action === "photo_markup" && new RegExp(`#${orig.n} as #${m1.n}`).test(h.note)), "A. history records the markup");

  // ---- B. one markup per original ---------------------------------------------
  r = await upload(photo("field-m-2", { markupOf: { clientUploadId: "field-o-1" } }));
  const m2 = byCid("field-m-2");
  ok(r.status === 201 && m2?.markupOf === orig.n, "B. a second markup links by the original's upload id");
  ok(!byCid("field-m-1"), "B. …and replaces the first");
  ok(!fs.existsSync(path.join(dir, `${m1.n}.png`)), "B. the replaced markup's file is gone");
  ok((wo().removedPhotos || []).some((t) => t.clientUploadId === "field-m-1"), "B. with a tombstone, so it cannot come back");
  ok((wo().history || []).some((h) => h.action === "photo_markup" && /replacing markup/.test(h.note)), "B. history says which markup it replaced");
  r = await upload(photo("field-m-1", { markupOf: { n: orig.n } }));
  ok(!byCid("field-m-1"), "B. a late retry of the replaced markup is dropped");

  // ---- C. what the customer sees -------------------------------------------------
  const E = srv.lib("wo-photo-edits.js");
  const seen = E.customerPhotos(wo().photos).map((p) => p.n);
  ok(seen.includes(m2.n) && !seen.includes(orig.n), `C. customerPhotos shows the markup in place of the original (${seen})`);
  ok(wo().photos.some((p) => p.n === orig.n), "C. the original stays on the work order for the office");
  const { deferredPayloadFromIssue } = srv.lib("wo-findings.js");
  const fresh = await W.get(id);
  const payload = deferredPayloadFromIssue(fresh, 1, fresh.zones.find((z) => Number(z.number) === 1).issues[0], "customer_declined", { items: {} });
  ok(payload.photoIds.includes(m2.n) && !payload.photoIds.includes(orig.n), `C. a finding copied to the property carries the markup, not the original (${payload.photoIds})`);
  // The report itself: which photos each audience draws.
  const pdf = srv.lib("wo-report-pdf.js");
  const drawn = (audience) => new Promise((resolve, reject) => {
    const seenN = new Set();
    const fsMod = require("node:fs");
    const orig = fsMod.readFileSync;
    // Count the photos the renderer opens, by their path.
    fsMod.readFileSync = function (p, ...rest) { const m = /wo-photos\/[^/]+\/(\d+)(?:@\d+)?\.(?:png|jpe?g)$/.exec(String(p)); if (m) seenN.add(Number(m[1])); return orig.call(this, p, ...rest); };
    try {
      const stream = pdf.generateWoReportPdf({ wo: fresh, property: {}, customer: {}, mode: "service_report", audience });
      stream.on("data", () => {}); stream.on("end", () => { fsMod.readFileSync = orig; resolve([...seenN]); }); stream.on("error", (e) => { fsMod.readFileSync = orig; reject(e); });
    } catch (e) { fsMod.readFileSync = orig; reject(e); }
  });
  const customer = await drawn("customer");
  const internal = await drawn("internal");
  ok(customer.includes(m2.n) && !customer.includes(orig.n), `C. the customer's report draws the markup, not the original (${customer})`);
  ok(internal.includes(m2.n) && internal.includes(orig.n), `C. the office's internal report draws both (${internal})`);

  // ---- D. the pair travels together ------------------------------------------------
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/${orig.n}`, { zoneNumber: 2 });
  ok(r.status === 200 && byCid("field-o-1").zoneNumber === 2 && byCid("field-m-2").zoneNumber === 2, "D. moving the original moves its markup");
  ok(!byCid("field-o-1").issueId && !byCid("field-m-2").issueId, "D. both come off the zone-1 finding (D-A3)");
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-m-2`);
  ok(r.status === 200 && !byCid("field-m-2") && byCid("field-o-1"), "D. removing the markup keeps the original");
  await upload(photo("field-m-3", { markupOf: { n: orig.n } }));
  const m3 = byCid("field-m-3");
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/${orig.n}`);
  ok(r.status === 200 && !byCid("field-o-1") && !byCid("field-m-3"), "D. deleting the original deletes its markup with it");
  ok(!fs.existsSync(path.join(dir, `${m3.n}.png`)), "D. …file and all");
  ok((wo().history || []).some((h) => h.action === "photo_delete" && /with its markup/.test(h.note)), "D. history says so");

  // ---- E. orphans ---------------------------------------------------------------------
  r = await upload(photo("field-m-4", { markupOf: { clientUploadId: "field-o-1" } }));
  ok(r.status === 200 && !byCid("field-m-4"), `E. a markup arriving after its original was deleted is dropped (${r.status})`);
  ok((wo().removedPhotos || []).some((t) => t.clientUploadId === "field-m-4"), "E. with a tombstone");
  r = await upload(photo("field-m-5", { markupOf: { clientUploadId: "field-never" } }));
  ok(r.status === 422 && r.body.error === "markup_original_missing", `E. a markup of a photo that was never here is refused (${r.status})`);
});

await run({ port: 4943, env: { FIELD_PHOTO_SHRINK: "1" } }, async (srv) => {
  await srv.login({ role: "tech" });
  ok((await srv.api("GET", "/api/session")).body.fieldOffline?.photoShrink === 1, "F. FIELD_PHOTO_SHRINK=1 switches shrinking on, with no app change");
});

console.log(`photo-markup: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

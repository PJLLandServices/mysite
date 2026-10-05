#!/usr/bin/env node
// scripts/test-photo-delete-move.mjs
//
// Deleting and re-filing a work-order photo, server side (PJL-110/111).
// Booted server (scripts/lib/field-server.mjs), temp data, nothing sent.
//
//   A. delete is for good: the photo leaves wo.photos, its file AND the
//      report's cached copy leave the disk, both photo routes 404, history
//      names the zone and who.
//   B. a deleted photo stays deleted: a retried delete acknowledges (200,
//      alreadyRemoved), its number is never handed out again, and an
//      upload carrying its upload id cannot bring it back.
//   C. the in-flight race: a delete by upload id that arrives BEFORE the
//      upload leaves a tombstone, and the late upload is dropped.
//   D. move keeps the photo: same number, same file, re-filed under the
//      new zone (label too), history photo_move; "whole visit" works; a
//      zone not on the visit is refused.
//   E. a finding's photo moved to another zone comes off the finding, and
//      off the property's copy of it (D-A3); delete clears the property's
//      copy as well, and later copies (wo-findings) never list it.
//   F. a tech session can do both; the session advertises photoEdit.
//
// Every check here fails on the code before PJL-110: the routes by upload
// id and PATCH did not exist, delete answered 404 on a retry, and numbers
// were reused.
//
// Run: node scripts/test-photo-delete-move.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { bootServer } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
// A 1×1 PNG — real magic bytes, so the upload validator accepts it.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const photo = (cid, meta = {}) => ({ mediaType: "image/png", data: png, category: "issue", clientUploadId: cid, ...meta });

const srv = await bootServer({ port: 4917 });
try {
  await srv.login();
  const f = await srv.fixture({ zones: 3 });
  const id = f.wo.id;
  const wo = () => srv.data("work-orders").find((w) => w.id === id);
  const dir = path.join(srv.DATA, "wo-photos", id);
  const upload = (p) => srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [p] });

  let r = await upload(photo("field-a-1", { zoneNumber: 1, label: "zone_1" }));
  ok(r.status === 201, `setup: upload 1 (${r.status})`);
  r = await upload(photo("field-a-2", { zoneNumber: 2, label: "zone_2" }));
  ok(r.status === 201, `setup: upload 2 (${r.status})`);
  const second = wo().photos.find((p) => p.clientUploadId === "field-a-2");
  ok(second && Number(second.n) === 2, "setup: the second photo is #2");

  // ---- A. delete is for good ---------------------------------------------
  // The report's downscaled copy, as lib/wo-report-pdf.js would have left it.
  fs.writeFileSync(path.join(dir, "2@1400.jpeg"), "x");
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/2`);
  ok(r.status === 200 && r.body.deletedN === 2, `A. delete #2 answers 200 (${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);
  ok(!wo().photos.some((p) => Number(p.n) === 2), "A. #2 is off the work order");
  ok(!fs.readdirSync(dir).some((name) => name === "2.png" || name.startsWith("2@")), `A. the file and the report's copy are gone (${fs.readdirSync(dir).join(", ")})`);
  ok((await srv.api("GET", `/api/work-orders/${id}/photo/2`)).status === 404, "A. the photo route 404s");
  const del = (wo().history || []).filter((h) => h.action === "photo_delete").pop();
  ok(del && /#2/.test(del.note) && /Zone 2/.test(del.note) && del.by && del.by !== "tech", `A. history names the photo, the zone and who (${JSON.stringify(del)})`);

  // ---- B. stays deleted ---------------------------------------------------
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/2`);
  ok(r.status === 200 && r.body.alreadyRemoved === true, `B. a retried delete acknowledges (${r.status})`);
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-a-2`);
  ok(r.status === 200 && r.body.alreadyRemoved === true, `B. the same delete by upload id acknowledges (${r.status})`);
  // #2 was the highest number: the old code numbered the next photo from
  // the photos still listed, and handed #2 out again.
  r = await upload(photo("field-a-3", { zoneNumber: 3, label: "zone_3" }));
  const third = wo().photos.find((p) => p.clientUploadId === "field-a-3");
  ok(third && Number(third.n) === 3, `B. the next photo is #3, never the deleted #2 (got #${third?.n})`);
  r = await upload(photo("field-a-2", { zoneNumber: 2 }));
  ok(r.status === 200 && !wo().photos.some((p) => p.clientUploadId === "field-a-2"), `B. re-uploading the deleted photo cannot bring it back (${r.status})`);

  // ---- C. the in-flight race ---------------------------------------------
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-race-1`);
  ok(r.status === 200 && r.body.alreadyRemoved === true, `C. delete before the upload lands answers 200 (${r.status})`);
  ok((wo().removedPhotos || []).some((t) => t.clientUploadId === "field-race-1"), "C. it leaves a tombstone");
  r = await upload(photo("field-race-1", { zoneNumber: 1 }));
  ok(!wo().photos.some((p) => p.clientUploadId === "field-race-1"), "C. the late upload is dropped");

  // ---- D. move ------------------------------------------------------------
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/upload/field-a-3`, { zoneNumber: 1 });
  let moved = wo().photos.find((p) => p.clientUploadId === "field-a-3");
  ok(r.status === 200 && moved.zoneNumber === 1 && Number(moved.n) === 3 && moved.label === "zone_1", `D. moved to Zone 1, same number, label follows (${r.status} ${JSON.stringify(moved)})`);
  ok(fs.existsSync(path.join(dir, "3.png")), "D. the file is untouched");
  const mv = (wo().history || []).filter((h) => h.action === "photo_move").pop();
  ok(mv && /Zone 3 to Zone 1/.test(mv.note), `D. history photo_move from → to (${mv?.note})`);
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/3`, { zoneNumber: 1 });
  ok(r.status === 200 && r.body.unchanged === true, "D. moving to where it already is is a no-op");
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/3`, { zoneNumber: null });
  moved = wo().photos.find((p) => Number(p.n) === 3);
  ok(r.status === 200 && moved.zoneNumber == null && moved.label == null, `D. "whole visit" clears the zone (${JSON.stringify(moved)})`);
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/3`, { zoneNumber: 99 });
  ok(r.status === 422 && wo().photos.find((p) => Number(p.n) === 3).zoneNumber == null, `D. a zone not on the visit is refused (${r.status})`);
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/2`, { zoneNumber: 1 });
  ok(r.status === 200 && r.body.alreadyRemoved === true, "D. moving a deleted photo acknowledges");

  // ---- E. findings --------------------------------------------------------
  const W = srv.lib("work-orders.js");
  const P = srv.lib("properties.js");
  const current = await W.get(id);
  const zones = current.zones.map((z) => (Number(z.number) === 1 ? { ...z, issues: [{ id: "iss_e1", type: "broken_head", qty: 1, notes: "cracked" }] } : z));
  await W.update(id, { zones });
  r = await upload(photo("field-e-1", { zoneNumber: 1, label: "zone_1", issueId: "iss_e1" }));
  r = await upload(photo("field-e-2", { zoneNumber: 1, label: "zone_1", issueId: "iss_e1" }));
  const e1 = wo().photos.find((p) => p.clientUploadId === "field-e-1");
  const e2 = wo().photos.find((p) => p.clientUploadId === "field-e-2");
  ok(e1?.issueId === "iss_e1" && e2?.issueId === "iss_e1", "setup: two photos on the finding");
  const entry = await P.addDeferredIssue(f.prop.id, { fromWoId: id, fromZone: 1, type: "broken_head", qty: 1, photoIds: [Number(e1.n), Number(e2.n)] });
  await W.stampDeferredIds(id, [{ zone: 1, issueId: "iss_e1", deferredId: entry.id }]);
  const deferred = async () => (await P.listDeferred(f.prop.id)).find((d) => d.id === entry.id);

  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/${e1.n}`, { zoneNumber: 2 });
  const e1after = wo().photos.find((p) => p.clientUploadId === "field-e-1");
  ok(r.status === 200 && e1after.zoneNumber === 2 && !e1after.issueId, `E. moved off its finding's zone, it comes off the finding (${JSON.stringify(e1after)})`);
  ok(r.body.detached?.issueId === "iss_e1", "E. the answer names the finding it came off");
  ok(!(await deferred()).photoIds.map(Number).includes(Number(e1.n)), `E. and the property's copy of the finding drops it (${JSON.stringify((await deferred()).photoIds)})`);
  ok((await deferred()).photoIds.map(Number).includes(Number(e2.n)), "E. the finding's other photo stays");
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-e-2`);
  ok(r.status === 200 && !(await deferred()).photoIds.map(Number).includes(Number(e2.n)), "E. a deleted photo leaves the property's copy too");
  const { deferredPayloadFromIssue } = srv.lib("wo-findings.js");
  const fresh = await W.get(id);
  const payload = deferredPayloadFromIssue(fresh, 1, fresh.zones.find((z) => Number(z.number) === 1).issues[0], "customer_declined", { items: {} });
  ok(payload.photoIds.length === 0, `E. a later copy of the finding lists neither (${JSON.stringify(payload.photoIds)})`);

  // ---- F. tech session ----------------------------------------------------
  await srv.login({ role: "tech" });
  const s = await srv.api("GET", "/api/session");
  ok(s.body.fieldOffline?.photoEdit === 1, "F. the session advertises photoEdit");
  r = await upload(photo("field-f-1", { zoneNumber: 1, label: "zone_1" }));
  r = await srv.api("PATCH", `/api/work-orders/${id}/photos/upload/field-f-1`, { zoneNumber: 3 });
  ok(r.status === 200, `F. a tech can move a photo (${r.status})`);
  r = await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-f-1`);
  ok(r.status === 200 && !wo().photos.some((p) => p.clientUploadId === "field-f-1"), `F. a tech can delete a photo (${r.status})`);
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

console.log(`photo-delete-move: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

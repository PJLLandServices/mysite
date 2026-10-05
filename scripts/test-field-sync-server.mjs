#!/usr/bin/env node
// scripts/test-field-sync-server.mjs
//
// The two server rules the faster field sync stands on (PJL-113). Booted
// server (scripts/lib/field-server.mjs), temp data, nothing sent.
//
//   A. The owner check. A request naming the account its queued work
//      belongs to (x-pjl-field-owner) is refused (403 owner_mismatch) under
//      any other session — what the phone's session read before every
//      change was for. The session advertises it (ownerCheck).
//   B. The If-Match rule (workOrders.versionMatches). A version the phone
//      read still matches after writes that only touched photos or history
//      (a photo upload, its history line, a photo delete or move): those
//      cannot clash with a zone save. Any other write since — an office
//      save — is still a 409. A PATCH that carries `photos` gets no
//      allowance.
//
// Both fail on the server before PJL-113: the header was ignored, and a
// photo upload made the next zone save a 409.
//
// Run: node scripts/test-field-sync-server.mjs   (also in build:check)

import { bootServer } from "./lib/field-server.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const srv = await bootServer({ port: 4933 });
try {
  await srv.login({ role: "tech" });
  const me = (await srv.api("GET", "/api/session")).body;
  ok(me.fieldOffline?.ownerCheck === 1, "A. the session advertises ownerCheck");
  const f = await srv.fixture({ zones: 2 });
  const id = f.wo.id;
  const get = async () => (await srv.api("GET", `/api/work-orders/${id}`)).body.workOrder;

  // ---- A. owner check ------------------------------------------------------
  let wo = await get();
  let r = await srv.api("PATCH", `/api/work-orders/${id}`, { techNotes: "someone else's" }, { "if-match": wo.updatedAt, "x-pjl-field-owner": "U-SOMEONE-ELSE" });
  ok(r.status === 403 && r.body.error === "owner_mismatch", `A. another account's queued work is refused (${r.status} ${r.body.error})`);
  ok((await get()).techNotes !== "someone else's", "A. and nothing was written");
  r = await srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [{ mediaType: "image/png", data: png, clientUploadId: "field-own-1" }] }, { "x-pjl-field-owner": "U-SOMEONE-ELSE" });
  ok(r.status === 403, `A. so is another account's photo (${r.status})`);
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { techNotes: "mine" }, { "if-match": wo.updatedAt, "x-pjl-field-owner": me.user.id });
  ok(r.status === 200, `A. the signed-in account's own work goes through (${r.status})`);

  // ---- B. If-Match across photo and history writes ---------------------------
  wo = await get();
  const seen = wo.updatedAt;
  r = await srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [{ mediaType: "image/png", data: png, clientUploadId: "field-v-1", zoneNumber: 1 }] });
  ok(r.status === 201, "setup: a photo upload (and its history line)");
  ok((await get()).updatedAt !== seen, "setup: the photo changed the record's version");
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { customerNotes: "after a photo" }, { "if-match": seen });
  ok(r.status === 200, `B. a zone save read before a photo upload still matches (${r.status} ${r.body.error || ""})`);

  wo = await get();
  const before = wo.updatedAt;
  await srv.api("PATCH", `/api/work-orders/${id}/photos/upload/field-v-1`, { zoneNumber: 2 });
  await srv.api("DELETE", `/api/work-orders/${id}/photos/upload/field-v-1`);
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { techNotes: "after a move and a delete" }, { "if-match": before });
  ok(r.status === 200, `B. …and after a photo move and delete (${r.status})`);

  wo = await get();
  const stale = wo.updatedAt;
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { backFlush: "yes" }, { "if-match": stale }); // the office
  await srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [{ mediaType: "image/png", data: png, clientUploadId: "field-v-2" }] });
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { customerNotes: "stale" }, { "if-match": stale });
  ok(r.status === 409 && r.body.error === "version_conflict", `B. an office save in between is still a clash, photos or not (${r.status})`);

  wo = await get();
  const beforePhoto = wo.updatedAt;
  await srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [{ mediaType: "image/png", data: png, clientUploadId: "field-v-3" }] });
  r = await srv.api("PATCH", `/api/work-orders/${id}`, { photos: [], customerNotes: "wipe" }, { "if-match": beforePhoto });
  ok(r.status === 409, `B. a PATCH carrying photos gets no allowance — it could erase a photo it never saw (${r.status})`);
  ok((await get()).photos.some((p) => p.clientUploadId === "field-v-3"), "B. and the photo is still there");
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`field-sync-server: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
// scripts/test-photo-races.mjs
//
// Every writer of a work order's photo list takes the same per-WO photo
// lock (PJL-100 #1).
//
// Fix #1 round 2 put the upload route and the delete route under
// fieldPhotoUploads.run(woId). One writer was left outside it: the build
// "mark task done" route (POST /api/work-orders/:id/tasks-done), which
// saves attached photos and then writes back `photos: [...existing, ...new]`
// from a copy read BEFORE the save — numbering the new files from that
// same stale copy. Racing an ordinary upload on the same work order, both
// pick the same photo number: one file overwrites the other on disk and
// one photo's metadata is lost.
//
// Booted server (scripts/lib/field-server.mjs), temp data, nothing sent.
//   A. 10 rounds of { photo upload, tasks-done with a photo } in parallel
//      on one build work order: both photos land, with distinct numbers.
//   B. the tasks-done photo block runs under the per-WO photo lock.
//
// Run: node scripts/test-photo-races.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
// A 1×1 PNG — real magic bytes, so the upload validator accepts it.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const srv = await bootServer({ port: 4913 });
try {
  await srv.login();
  const f = await srv.fixture({ zones: 2 });
  // A build work order (they are project-scoped; the route that makes them
  // needs a whole project, so write one through the sandbox's own lib).
  const built = await srv.lib("work-orders.js").create({
    type: "build", property: f.prop, project: { id: "PRJ-PHOTO-RACE", name: "Photo race" }, workDate: "2026-09-23"
  });
  const id = built?.id;
  ok(Boolean(id), "setup: a build work order");

  let lost = 0, dupN = 0, badStatus = 0;
  const ROUNDS = 10;
  for (let t = 0; t < ROUNDS; t++) {
    const [up, done] = await Promise.all([
      srv.api("POST", `/api/work-orders/${id}/photos`, { photos: [{ mediaType: "image/png", data: png, category: "general", clientUploadId: `field-up-${t}` }] }),
      srv.api("POST", `/api/work-orders/${id}/tasks-done`, { taskId: `task_race${t}`, percentDelta: 10, photos: [{ mediaType: "image/png", data: png }] })
    ]);
    if (up.status >= 300) { badStatus += 1; if (t === 0) console.error(`    upload refused: ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`); }
    const wo = srv.data("work-orders").find((w) => w.id === id);
    const photos = wo?.photos || [];
    const upOne = photos.some((p) => p.clientUploadId === `field-up-${t}`);
    const taskOne = photos.some((p) => p.taskId === `task_race${t}`);
    if (!upOne || !taskOne) lost += 1;
    const ns = photos.map((p) => Number(p.n));
    if (new Set(ns).size !== ns.length) dupN += 1;
    void done;
  }
  ok(badStatus === 0, `A. every upload is accepted (refused in ${badStatus}/${ROUNDS})`);
  ok(lost === 0, `A. both photos land every round (one lost in ${lost}/${ROUNDS})`);
  ok(dupN === 0, `A. no two photos share a number, so no file overwrote another (duplicates in ${dupN}/${ROUNDS})`);
  const final = srv.data("work-orders").find((w) => w.id === id);
  ok((final?.photos || []).length === ROUNDS * 2, `A. ${ROUNDS * 2} photos at the end (got ${(final?.photos || []).length})`);
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}

// ---- B. source guard ------------------------------------------------------
{
  const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const start = server.indexOf("const tasksDoneMatch");
  const block = server.slice(start, server.indexOf("savePhotosForWorkOrder(", start));
  ok(/fieldPhotoUploads\.run\(\s*woId/.test(block), "B. the tasks-done photo block runs under fieldPhotoUploads.run(woId)");
}

console.log(`\nphoto-races: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

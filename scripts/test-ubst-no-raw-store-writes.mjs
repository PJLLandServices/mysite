#!/usr/bin/env node
// scripts/test-ubst-no-raw-store-writes.mjs — T7 (P-PJL-39, PJL-133)
//
// FAIL-FIRST. The booking store has one owner, and only lifecycle operations
// may change a booking's status or existence.
//
// What this pins, statically, against the source:
//   1. Nothing outside server/lib/bookings.js opens bookings.json by path or
//      writes it with fs. (Today: the follow-up work-order route hand-builds a
//      record and fs.writeFile's the store, server.js ~15300.)
//   2. Nothing outside the test-data purge physically deletes a booking.
//      (Today: DELETE /api/bookings/:id and assignments.unassign both call
//      bookings.remove.)
//   3. No route hands a request body straight to bookings.update, so a client
//      cannot set `status` or `scheduledFor` by PATCH. (Today: PATCH
//      /api/bookings/:id does exactly that, and the booking page's Status
//      dropdown uses it.)
//   4. bookings.update itself refuses lifecycle fields. (Today it accepts
//      status with no transition rule — a dead booking can be revived.)
//   5. Every write in lib/bookings.js goes through one serialised store
//      helper, not a bare atomic write. (Today: writeJsonAtomic only; no lock.)
//
// Expected on origin/main @ 305d7e3: 7 of 9 assertions fail (verified
// 2026-10-06; the two that pass are cancel()'s 409s and "no raw fs write
// inside the library").
//
// After PJL-133 (Phase 1, the contract): 1 of 9 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-no-raw-store-writes.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => { if (cond) { pass += 1; return; } failures.push(`${name}${detail ? ` — ${detail}` : ""}`); };

const SERVER = read("server/server.js");
const LIB_FILES = fs.readdirSync(path.join(ROOT, "server", "lib")).filter((f) => f.endsWith(".js"));
const libSrc = Object.fromEntries(LIB_FILES.map((f) => [f, read(`server/lib/${f}`)]));
const serverSideFiles = { "server/server.js": SERVER, ...Object.fromEntries(Object.entries(libSrc).map(([f, s]) => [`server/lib/${f}`, s])) };

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
const findAll = (src, re) => { const out = []; let m; const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"); while ((m = g.exec(src))) out.push({ index: m.index, text: m[0] }); return out; };

// ---- 1. One owner of bookings.json ----------------------------------------
{
  const offenders = [];
  for (const [file, src] of Object.entries(serverSideFiles)) {
    if (file === "server/lib/bookings.js") continue;
    for (const hit of findAll(src, /["'`]bookings\.json["'`]/)) {
      // A comment that merely names the file, or a `case "bookings.json":`
      // label in a describe-this-record switch, is not a write.
      const line = src.split("\n")[lineOf(src, hit.index) - 1] || "";
      if (/^\s*\/\//.test(line) || /^\s*case\s+["'`]bookings\.json["'`]\s*:/.test(line)) continue;
      offenders.push(`${file}:${lineOf(src, hit.index)}`);
    }
  }
  // customers.js and purge-test-data.js rewrite the store on purpose: a
  // customer merge re-points ids under the store lock, and the purge is the
  // one legitimate physical delete. Named, so a new one has to be argued for.
  const allowed = offenders.filter((o) => /customers\.js|purge-test-data\.js/.test(o));
  const bad = offenders.filter((o) => !/customers\.js|purge-test-data\.js/.test(o));
  ok("no code outside lib/bookings.js (and the two named exceptions) touches bookings.json by path",
    bad.length === 0, bad.join(", ") || `allowed: ${allowed.join(", ")}`);
}

// ---- 2. Physical delete has one caller --------------------------------------
{
  const callers = [];
  for (const [file, src] of Object.entries(serverSideFiles)) {
    if (file === "server/lib/bookings.js") continue;
    for (const hit of findAll(src, /bookings\.remove\(|removeBooking\s*=\s*deps\.removeBooking\s*\|\|\s*bookings\.remove/)) {
      callers.push(`${file}:${lineOf(src, hit.index)}`);
    }
  }
  const outsidePurge = callers.filter((c) => !/purge-test-data\.js/.test(c));
  ok("bookings.remove is called only by the test-data purge — an admin \"delete\" is a cancellation with a reason",
    outsidePurge.length === 0, outsidePurge.join(", ") || "(none)");
}

// ---- 3. No route passes a request body straight into bookings.update --------
{
  const hits = findAll(SERVER, /bookings\.update\(\s*\w+\s*,\s*(payload|body|patch|req\.body)\s*\)/);
  ok("no route hands a client body to bookings.update (the Status dropdown's PATCH is the door Peter's class of bug walks through)",
    hits.length === 0, hits.map((h) => `server.js:${lineOf(SERVER, h.index)} ${h.text}`).join("; "));
}

// ---- 4. update() refuses lifecycle fields; cancel/complete/noShow own them -----
{
  const bookings = require(path.join(ROOT, "server", "lib", "bookings.js"));
  const src = libSrc["bookings.js"] || "";
  const allowedList = (src.match(/const allowed = \[([^\]]+)\]/) || [])[1] || "";
  ok("bookings.update's allowed-field list does not include status or scheduledFor",
    allowedList && !/"status"/.test(allowedList) && !/"scheduledFor"/.test(allowedList),
    `allowed = [${allowedList.replace(/\s+/g, " ").trim().slice(0, 200)}]`);
  ok("a completeBooking / markCompleted lifecycle operation exists on the library",
    typeof bookings.complete === "function" || typeof bookings.completeBooking === "function" || typeof bookings.markCompleted === "function",
    `exports: ${Object.keys(bookings).filter((k) => /complete|noShow|no_show|lifecycle/i.test(k)).join(", ") || "none"}`);
  ok("a markNoShow lifecycle operation exists (today a no-show is a cancel() with a reason code)",
    typeof bookings.markNoShow === "function" || typeof bookings.noShow === "function",
    `exports: ${Object.keys(bookings).filter((k) => /noShow|no_show/i.test(k)).join(", ") || "none"}`);
  ok("cancel() refuses to run on a record that is already terminal (kept: today's 409s)",
    /already cancelled|Can't cancel a/.test(src));
}

// ---- 5. One serialised writer -------------------------------------------------
{
  const src = libSrc["bookings.js"] || "";
  const usesStoreLock = /updateJsonStore\(|withStoreLock\(|serializeOn\(|storeLock|bookingsLock/.test(src);
  ok("every write in lib/bookings.js is serialised through a store lock, not a bare atomic write",
    usesStoreLock, "only writeJsonAtomic is used; concurrent cancel / reschedule / cadence / re-time writes can lose each other");
  const rawWrites = findAll(src, /fs\.writeFile\(|fsSync\.writeFileSync\(/).filter((h) => !/ensureFile|\[\]\\n/.test(src.slice(Math.max(0, h.index - 200), h.index + 80)));
  ok("lib/bookings.js has no raw fs write of the store outside ensureFile", rawWrites.length === 0,
    rawWrites.map((h) => `bookings.js:${lineOf(src, h.index)}`).join(", "));
}

console.log(`\ntest-ubst-no-raw-store-writes: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  console.log("\n  (fail-first suite: these describe PJL-133's contract and fail until it lands)");
}
process.exit(failures.length ? 1 : 0);

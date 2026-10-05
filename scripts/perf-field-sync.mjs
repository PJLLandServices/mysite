#!/usr/bin/env node
// scripts/perf-field-sync.mjs
//
// The field sync, measured (PJL-113). A 12-zone, 12-photo fall closing is
// replayed through the app's REAL queue (pjl-field/src/offline/queue.mjs)
// and REAL transport (offline/transport.mjs) against the REAL server on
// throwaway data (scripts/lib/field-server.mjs: nothing leaves the
// machine). A network shim between them adds round-trip latency and a
// SHARED uplink, so two photos at once split the bandwidth the way they do
// on a phone.
//
//   walk     — record each zone and its photo, sending after each action,
//              as the app does. Counts requests and bytes, and the queue
//              depth a moment after each action.
//   finish   — Finish once the walk is caught up: what it still sends.
//   backlog  — the whole visit recorded with no signal, then signal back:
//              the time to drain it (what Finish waited on before).
//   stall    — one server 500 on the first zone save, then the walk goes
//              on: does everything after it still reach the server?
//   drop     — the signal drops mid-photo and comes back: how long until
//              the queue drains on its own, with no tap and no Finish?
//
// Modes:
//   node scripts/perf-field-sync.mjs            CI: fast (time scaled
//       down 40×), asserts the request, depth, stall and recovery targets.
//   node scripts/perf-field-sync.mjs --real     real time at 300 ms /
//       1.5 Mbps, prints the drain time. Slow; for the numbers, not CI.
//       PERF_ONLY=backlog runs just the one that matters for Finish.
//
// PERF_QUEUE / PERF_TRANSPORT point at other copies of the two modules —
// how the baseline (the code before PJL-113) was measured.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { bootServer } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL = process.argv.includes("--real");
const SCALE = REAL ? 1 : 40;
const RTT_MS = 300, UP_BPS = 1.5e6, DOWN_BPS = 10e6;
const ZONES = 12;
// PERF_ONLY=walk|backlog|stall|drop runs one scenario (a --real run of
// them all takes a while).
const ONLY = process.env.PERF_ONLY || null;
const modUrl = (env, rel) => pathToFileURL(path.resolve(ROOT, process.env[env] || rel)).href;
const { createQueue } = await import(modUrl("PERF_QUEUE", "pjl-field/src/offline/queue.mjs"));
const { createRequest, createTransport } = await import(modUrl("PERF_TRANSPORT", "pjl-field/src/offline/transport.mjs"));
const require = createRequire(import.meta.url);
const sharp = require("sharp");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

// A camera-sized test photo: 4032×3024, JPEG quality 55 (the app's picker
// setting), from a textured image so it compresses like a photo, not a
// flat card.
async function testPhoto(quality) {
  const w = 4032, h = 3024;
  const base = await sharp({ create: { width: w / 8, height: h / 8, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } })
    .resize(w, h, { kernel: "cubic" }).blur(1.2).raw().toBuffer();
  return (await sharp(base, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer()).toString("base64");
}

// ---- the network shim -------------------------------------------------------
function network(base, cookie) {
  const net = { requests: [], offline: false, failNext: null, uplinkFree: 0 };
  const route = (method, p) => `${method} ${p.replace(/WO-[A-Z0-9]+/, ":id").replace(/P-\d+-\d+|PROP-[A-Za-z0-9]+|prop_[A-Za-z0-9]+/, ":id").replace(/upload\/field-[^/]+/, "upload/:cid").replace(/\/photos\/\d+$/, "/photos/:n")}`;
  net.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const p = new URL(url).pathname;
    if (net.offline) throw new TypeError("Network request failed");
    const up = Buffer.byteLength(opts.body || "");
    // Half the round trip out; the body shares one uplink with everything
    // else in flight.
    await sleep(RTT_MS / 2 / SCALE);
    const start = Math.max(Date.now(), net.uplinkFree);
    net.uplinkFree = start + (up * 8 / UP_BPS) * 1000 / SCALE;
    await sleep(net.uplinkFree - Date.now());
    if (net.offline) throw new TypeError("Network request failed");
    const rec = { route: route(method, p), up, down: 0 };
    net.requests.push(rec);
    if (net.failNext && net.failNext(method, p)) {
      net.failNext = null;
      const text = JSON.stringify({ ok: false, errors: ["Internal error"] });
      rec.down = text.length;
      await sleep(RTT_MS / 2 / SCALE);
      return { ok: false, status: 500, text: async () => text };
    }
    const res = await fetch(base + p + (new URL(url).search || ""), { method, headers: { ...opts.headers, cookie }, body: opts.body });
    const text = await res.text();
    rec.down = text.length;
    await sleep((RTT_MS / 2 + text.length * 8 / DOWN_BPS * 1000) / SCALE);
    return { ok: res.ok, status: res.status, text: async () => text };
  };
  return net;
}

function memoryStore() {
  let disk = null;
  const blobs = new Map();
  return { read: () => clone(disk), write: (x) => { disk = clone(x); },
    putBlob: (id, p) => blobs.set(id, clone(p)), getBlob: (id) => clone(blobs.get(id)), deleteBlob: (id) => blobs.delete(id) };
}

async function visit(srv, { photo }) {
  const f = await srv.fixture({ zones: ZONES });
  const session = (await srv.api("GET", "/api/session")).body;
  const account = session.user.id;
  const net = network(srv.BASE, srv.cookie());
  const request = createRequest({ host: "http://phone", fetchImpl: net.fetch, AuthRequiredError: class AuthRequiredError extends Error {}, owner: () => account });
  let queue;
  const transport = createTransport({ request, account, view: (k) => queue.view(k), AuthRequiredError: class AuthRequiredError extends Error {} });
  queue = createQueue({ store: memoryStore(), transport });
  // Opening the visit, as openFieldWorkOrder does.
  const open = (await srv.api("GET", `/api/work-orders/${f.wo.id}`)).body;
  const key = `wo:${f.wo.id}`;
  if (open.property?.id) queue.seed(`prop:${open.property.id}`, open.property);
  queue.seed(key, { ...open.workOrder, property: open.property || null, lead: open.lead || null });
  await srv.api("PATCH", `/api/work-orders/${f.wo.id}`, { status: "on_site" }, { "if-match": open.workOrder.updatedAt });
  queue.seed(key, { ...(await srv.api("GET", `/api/work-orders/${f.wo.id}`)).body.workOrder, property: open.property || null, lead: null });
  const actions = [];
  for (let z = 1; z <= ZONES; z++) {
    actions.push(() => {
      const zones = queue.view(key).zones.map((zone) => (Number(zone.number) === z ? { ...zone, status: "working_well", notes: `Zone ${z} blown out clear` } : zone));
      queue.patch(key, { zones });
    });
    actions.push(() => queue.photo(key, { data: photo, mediaType: "image/jpeg", category: "issue", zoneNumber: z, label: `zone_${z}` }));
  }
  actions.push(() => queue.patch(key, { waterShutoffBy: "tech", backFlush: "no" }));
  const server = () => srv.data("work-orders").find((w) => w.id === f.wo.id);
  return { f, key, queue, net, actions, server };
}

// Drives the queue the way watchFieldQueue does: a pass, then the queue's
// own next delay (15 s, the old fixed timer, for a queue without one).
// Returns the time spent WAITING between passes, in simulated ms — what
// "resumes within 30 s" is about. (Time inside a pass is mostly the local
// server resizing photos, which the time scale would inflate.)
async function drive(queue, key, { capMs = 120000 } = {}) {
  let waited = 0;
  while (queue.status(key).pending && waited < capMs) {
    await queue.flush();
    if (!queue.status(key).pending) break;
    const d = typeof queue.nextDelay === "function" ? queue.nextDelay() : 15000;
    if (d == null) break;
    await sleep(Math.max(1, d / SCALE));
    waited += Math.max(1, d);
  }
  return waited;
}

const tally = (reqs) => {
  const byRoute = {};
  for (const r of reqs) { const b = (byRoute[r.route] ||= { n: 0, up: 0, down: 0 }); b.n++; b.up += r.up; b.down += r.down; }
  return byRoute;
};

const srv = await bootServer({ port: 4931 });
try {
  await srv.login({ role: "tech" });
  // The app's own picker quality (pjl-field/src/photos.js), as the JPEG
  // quality of the test photo — a proxy: the iPhone's encoder is not
  // libjpeg, so the bytes here show the direction, not the phone's number.
  const appQuality = Number(process.env.PERF_PHOTO_QUALITY || /quality:\s*([\d.]+)/.exec(fs.readFileSync(path.join(ROOT, "pjl-field/src/photos.js"), "utf8"))[1]);
  // PERF_PHOTO_FILE: upload this JPEG as it is instead (a photograph, or
  // one already shrunk by the phone's canvas — scripts/test-photo-canvas.mjs).
  const photo55 = process.env.PERF_PHOTO_FILE
    ? fs.readFileSync(path.resolve(ROOT, process.env.PERF_PHOTO_FILE)).toString("base64")
    : await testPhoto(Math.round(appQuality * 100));
  console.log(`test photo ${process.env.PERF_PHOTO_FILE ? process.env.PERF_PHOTO_FILE : `at quality ${appQuality}`}: ${mb(photo55.length * 0.75)} (${mb(photo55.length)} as base64)`);

  // ---- walk + finish --------------------------------------------------------
  if (!ONLY || ONLY === "walk") {
    const v = await visit(srv, { photo: photo55 });
    const depth = [];
    for (const act of v.actions) {
      act();
      v.queue.flush().catch(() => {});
      // The tech's next action comes a while later; the queue should have
      // caught up by then (P4: 2 or fewer pending, 30 s after any action).
      await sleep(30000 / SCALE);
      depth.push(v.queue.status(v.key).pending);
    }
    await drive(v.queue, v.key);
    const walkReqs = v.net.requests.length;
    const up = v.net.requests.reduce((s, r) => s + r.up, 0);
    console.log(`walk: ${walkReqs} requests, ${mb(up)} up, queue depth after each action: ${depth.join(" ")}`);
    for (const [r, b] of Object.entries(tally(v.net.requests))) console.log(`   ${String(b.n).padStart(3)}  ${r}  (${mb(b.up)} up)`);
    const before = v.net.requests.length;
    await v.queue.flush({ retry: true });
    const finishReqs = v.net.requests.length - before;
    console.log(`finish (caught up): ${finishReqs} requests`);
    const s = v.server();
    ok(s.photos.length === ZONES && s.zones.every((z) => z.status === "working_well") && s.backFlush === "no", "walk: every zone, photo and answer is on the server");
    // 12 zone saves + 12 photos + 1 answers = 25 changes, each one request,
    // plus the account check. 101 before PJL-113.
    ok(walkReqs <= 27, `P1: requests for the walk ≤ 27 — one per change, plus the account check (got ${walkReqs})`);
    ok(Math.max(...depth) <= 2, `P4: 2 or fewer pending 30 s after any action (got ${Math.max(...depth)})`);
    ok(finishReqs <= 2, `P5: Finish on a caught-up queue sends ≤ 2 requests (got ${finishReqs})`);
  }

  // ---- backlog (no signal for the whole visit) -------------------------------
  if (!ONLY || ONLY === "backlog") {
    const v = await visit(srv, { photo: photo55 });
    v.net.offline = true;
    for (const act of v.actions) { act(); await v.queue.flush().catch(() => {}); }
    v.net.offline = false;
    v.net.requests.length = 0;
    const t0 = Date.now();
    await v.queue.flush({ retry: true });
    await drive(v.queue, v.key);
    const ms = (Date.now() - t0) * SCALE;
    const up = v.net.requests.reduce((s, r) => s + r.up, 0);
    console.log(`backlog: ${v.net.requests.length} requests, ${mb(up)} up, drained in ${(ms / 1000).toFixed(1)} s ${REAL ? "" : "(scaled; run --real for the number)"}`);
    ok(v.queue.status(v.key).pending === 0 && v.server().photos.length === ZONES, "backlog: everything reaches the server");
    ok(v.net.requests.length <= 16, `P1: the backlog goes as 1 save + 12 photos + the account check (got ${v.net.requests.length})`);
  }

  // ---- stall: one 500 mid-visit ---------------------------------------------
  if (!ONLY || ONLY === "stall") {
    const v = await visit(srv, { photo: photo55 });
    v.net.failNext = (method, p) => method === "PATCH" && /\/api\/work-orders\//.test(p);
    for (const act of v.actions) { act(); v.queue.flush().catch(() => {}); await sleep(30000 / SCALE); }
    // No Finish, no tap: only the background passes.
    await drive(v.queue, v.key, { capMs: 60000 });
    const s = v.server();
    console.log(`stall: pending ${v.queue.status(v.key).pending}, photos on server ${s.photos.length}`);
    ok(v.queue.status(v.key).pending === 0, `P6: one 500 mid-visit no longer holds the visit until Finish (pending ${v.queue.status(v.key).pending})`);
    ok(s.photos.length === ZONES, `P6: every photo reached the server (got ${s.photos.length})`);
  }

  // ---- drop: signal lost mid-photo, then back ------------------------------
  if (!ONLY || ONLY === "drop") {
    const v = await visit(srv, { photo: photo55 });
    v.actions[1]();
    const sending = v.queue.flush().catch(() => {});
    await sleep(200 / SCALE);
    v.net.offline = true;
    await sending;
    // A long time out of signal: the backoff climbs to its top step.
    for (let i = 0; i < 8; i++) await v.queue.flush().catch(() => {});
    v.net.offline = false;
    // The signal is back; the next try is whenever the queue's timer says.
    const first = typeof v.queue.nextDelay === "function" ? (v.queue.nextDelay() ?? 15000) : 15000;
    await sleep(first / SCALE);
    const ms = first + await drive(v.queue, v.key, { capMs: 120000 });
    console.log(`drop: waited ${(ms / 1000).toFixed(1)} s between tries after the signal came back`);
    ok(v.queue.status(v.key).pending === 0, "P7: the photo reached the server with no tap");
    ok(ms <= 30000, `P7: within 30 s of the signal coming back (took ${(ms / 1000).toFixed(1)} s)`);
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}\n${srv.logs().slice(-1500)}`);
} finally {
  ok(!srv.outbox().some((m) => m.channel === "refused"), "nothing left the machine");
  await srv.stop();
}
console.log(`perf-field-sync: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

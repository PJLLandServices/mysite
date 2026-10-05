#!/usr/bin/env node
// scripts/test-field-sync.mjs
//
// How the field queue sends (PJL-113): error classes, backoff, the two
// lanes, fewer round trips, coalesced saves, Finish's progress line. The
// REAL queue and transport against a fake disk and a fake server; no
// network. The harness with the real server and the timings is
// scripts/perf-field-sync.mjs; the merge rules stay covered by
// test-field-conflicts and test-field-merge-gaps, unchanged.
//
// Each test fails on the queue before PJL-113 (one 500 held the visit
// until Finish; every change cost a session and a record read; photos and
// saves waited on each other; no backoff, no progress).
//
// Run: node scripts/test-field-sync.mjs   (also in build:check)

import assert from 'node:assert/strict';
import { createQueue } from '../pjl-field/src/offline/queue.mjs';
import * as transportModule from '../pjl-field/src/offline/transport.mjs';
import * as notice from '../pjl-field/src/sync-notice.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, e.message); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const KEY = 'wo:WO-1';
const err = (status, code, message = 'refused') => Object.assign(new Error(message), { status, code });

function fixture({ ownerEnforced = true } = {}) {
  let disk = null;
  const blobs = new Map();
  const store = { read: () => clone(disk), write: x => { disk = clone(x); },
    putBlob: (id, p) => blobs.set(id, clone(p)), getBlob: id => clone(blobs.get(id)), deleteBlob: id => blobs.delete(id) };
  let version = 1;
  let remote = { id: 'WO-1', updatedAt: 'v1', status: 'in_progress', customerNotes: '', techNotes: '', backFlush: '', zones: [{ number: 1 }, { number: 2 }], photos: [] };
  const bump = () => { version++; remote.updatedAt = `v${version}`; };
  const calls = { verify: 0, read: 0, patch: 0, photo: 0 };
  const faults = { patch: [], photo: [] };
  let inFlight = 0, maxInFlight = 0, photoGate = null;
  const transport = {
    ownerEnforced: () => ownerEnforced,
    verifyOwner: async () => { calls.verify++; return true; },
    read: async () => { calls.read++; return clone(remote); },
    patch: async (key, patch, ifMatch) => {
      calls.patch++;
      const f = faults.patch.shift(); if (f) throw f;
      if (ifMatch !== remote.updatedAt) throw err(409, 'version_conflict');
      Object.assign(remote, clone(patch)); bump();
      return clone(remote);
    },
    photo: async (key, payload) => {
      calls.photo++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (photoGate) await photoGate;
        await new Promise(r => setTimeout(r, 5));
        const f = faults.photo.shift(); if (f) throw f;
        if (!remote.photos.some(p => p.clientUploadId === payload.clientUploadId)) { remote.photos.push({ n: remote.photos.length + 1, clientUploadId: payload.clientUploadId }); bump(); }
        return clone(remote);
      } finally { inFlight--; }
    },
  };
  const make = () => createQueue({ store, transport });
  const queue = make();
  queue.seed(KEY, remote);
  return { queue, make, calls, faults, remote: () => remote, office: patch => { Object.assign(remote, patch); bump(); },
    maxInFlight: () => maxInFlight, gate: g => { photoGate = g; } };
}
const take = q => q.photo(KEY, { data: 'x'.repeat(4000), mediaType: 'image/jpeg' });

// ---- the one rule for what a failure means ---------------------------------
await test('classify: 5xx, 429, no answer and a version clash are transient; 401/403 is sign-in; a 4xx refusal is permanent', () => {
  const { classify } = transportModule;
  assert.equal(typeof classify, 'function', 'transport.mjs has no classify');
  assert.equal(classify(err(500, 'server')), 'transient');
  assert.equal(classify(err(502, 'server_unavailable')), 'transient');
  assert.equal(classify(err(429, 'rate_limited')), 'transient');
  assert.equal(classify(err(409, 'version_conflict')), 'transient');
  assert.equal(classify(Object.assign(new Error('x'), { code: 'network' })), 'transient');
  assert.equal(classify(err(401, 'auth')), 'auth');
  assert.equal(classify(err(403, 'owner_mismatch')), 'auth');
  assert.equal(classify(err(422, 'server')), 'permanent');
  assert.equal(classify(Object.assign(new Error('x'), { code: 'conflict' })), 'permanent');
});

await test("Render's HTML 502 page is 'the server is restarting', not 'signed out'", async () => {
  const { createRequest } = transportModule;
  const html = status => async () => ({ ok: false, status, text: async () => '<html><body>502 Bad Gateway</body></html>' });
  const request = createRequest({ host: 'http://x', fetchImpl: html(502), AuthRequiredError: class extends Error {} });
  const e = await request('/api/work-orders/WO-1').then(() => null, x => x);
  assert.equal(e.code, 'server_unavailable');
  assert.equal(transportModule.classify(e), 'transient');
  const json500 = createRequest({ host: 'http://x', fetchImpl: async () => ({ ok: false, status: 500, text: async () => '{"ok":false,"errors":["boom"]}' }) });
  assert.equal(transportModule.classify(await json500('/x').then(() => null, x => x)), 'transient');
  const unauth = createRequest({ host: 'http://x', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"ok":false}' }), AuthRequiredError: class extends Error {} });
  assert.equal((await unauth('/x').then(() => null, x => x)).code, 'auth');
});

await test('a request names the account its queued work belongs to', async () => {
  let headers = null;
  const request = transportModule.createRequest({ host: 'http://x', owner: () => 'U-1',
    fetchImpl: async (url, opts) => { headers = opts.headers; return { ok: true, status: 200, text: async () => '{"ok":true}' }; } });
  await request('/api/work-orders/WO-1', { method: 'PATCH', body: {} });
  assert.equal(headers['x-pjl-field-owner'], 'U-1');
});

// ---- one failure no longer holds the visit ----------------------------------
await test('one server 500 mid-visit: the next ordinary pass sends it — no Finish, no tap', async () => {
  const f = fixture();
  f.faults.patch.push(err(500, 'server'));
  f.queue.patch(KEY, { customerNotes: 'zone 1' });
  await f.queue.flush();
  assert.equal(f.queue.status(KEY).pending, 1);
  f.queue.patch(KEY, { techNotes: 'zone 2' });
  await f.queue.flush(); // ordinary, NOT retry: true
  assert.equal(f.queue.status(KEY).pending, 0, 'still held after an ordinary pass');
  assert.equal(f.remote().customerNotes, 'zone 1');
  assert.equal(f.remote().techNotes, 'zone 2');
});

await test('a refused save holds only that record\'s later saves — never the photos', async () => {
  const f = fixture();
  f.faults.patch.push(err(422, 'server', 'Not allowed'));
  f.queue.patch(KEY, { customerNotes: 'refused' });
  take(f.queue);
  await f.queue.flush();
  assert.equal(f.remote().photos.length, 1, 'the photo waited behind a refused save');
  assert.equal(f.queue.status(KEY).error?.message, 'Not allowed', 'the refusal is shown');
  await f.queue.flush();
  assert.equal(f.calls.patch, 1, 'a permanent refusal is not resent on every pass');
  await f.queue.flush({ retry: true });
  assert.equal(f.calls.patch, 2, 'a tap or Finish sends it again');
});

await test('a photo that fails does not hold the saves', async () => {
  const f = fixture();
  f.faults.photo.push(err(500, 'server'));
  take(f.queue);
  f.queue.patch(KEY, { customerNotes: 'after the photo' });
  await f.queue.flush();
  assert.equal(f.remote().customerNotes, 'after the photo');
  await f.queue.flush();
  assert.equal(f.remote().photos.length, 1, 'the photo goes on the next pass');
});

// ---- fewer round trips --------------------------------------------------------
await test('a save costs one request: no session read, no record read, when nothing moved', async () => {
  const f = fixture();
  await f.queue.flush(); // nothing pending: nothing sent at all
  assert.deepEqual(f.calls, { verify: 0, read: 0, patch: 0, photo: 0 }, 'a pass with nothing to send made requests');
  f.queue.patch(KEY, { customerNotes: 'a' }); await f.queue.flush();
  f.queue.patch(KEY, { customerNotes: 'b' }); await f.queue.flush();
  f.queue.patch(KEY, { customerNotes: 'c' }); await f.queue.flush();
  assert.equal(f.calls.patch, 3);
  assert.equal(f.calls.read, 0, 'a record read before a save');
  assert.equal(f.calls.verify, 1, 'the account is checked once, not per change');
});

await test('an office change since the phone\'s copy: one 409, one read, merged and sent in the same pass', async () => {
  const f = fixture();
  f.office({ backFlush: 'yes' });
  f.queue.patch(KEY, { customerNotes: 'field' });
  await f.queue.flush();
  assert.equal(f.queue.status(KEY).pending, 0);
  assert.equal(f.calls.read, 1);
  assert.equal(f.remote().backFlush, 'yes', 'the office change survived');
  assert.equal(f.remote().customerNotes, 'field');
});

await test('saves made one after another while offline go as one request', async () => {
  const f = fixture();
  f.faults.patch.push(Object.assign(new Error('offline'), { code: 'network' }));
  f.queue.patch(KEY, { customerNotes: 'one' });
  await f.queue.flush();
  f.queue.patch(KEY, { customerNotes: 'two', techNotes: 't' });
  f.queue.patch(KEY, { backFlush: 'no' });
  const before = f.calls.patch;
  await f.queue.flush();
  assert.equal(f.calls.patch - before, 1, `three saves took ${f.calls.patch - before} requests`);
  assert.deepEqual([f.remote().customerNotes, f.remote().techNotes, f.remote().backFlush], ['two', 't', 'no']);
  assert.equal(f.queue.status(KEY).pending, 0);
});

await test('…but not when the office changed one of those fields: they merge one by one', async () => {
  const f = fixture();
  f.faults.patch.push(Object.assign(new Error('offline'), { code: 'network' }));
  f.queue.patch(KEY, { customerNotes: 'one' });
  await f.queue.flush();
  f.queue.patch(KEY, { backFlush: 'no' });
  f.office({ customerNotes: 'office' });
  await f.queue.flush();
  assert.equal(f.queue.status(KEY).error?.code, 'conflict', 'the clash is still the tech\'s to choose');
  assert.equal(f.remote().customerNotes, 'office', 'nothing overwrote the office');
});

// ---- the photo lane -------------------------------------------------------------
await test('photos upload two at a time, and an answer arriving late never replaces a newer copy', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) take(f.queue);
  f.queue.patch(KEY, { customerNotes: 'with photos' });
  await f.queue.flush();
  assert.equal(f.maxInFlight(), 2);
  assert.equal(f.remote().photos.length, 4);
  assert.equal(f.queue.view(KEY).customerNotes, 'with photos', 'an older photo answer replaced the save');
  assert.equal(f.queue.status(KEY).pending, 0);
});

// ---- backoff ------------------------------------------------------------------------
await test('after a failure the next try backs off 2, 4, 8, 16 s, then stays under 30 s; success resets it', async () => {
  const f = fixture();
  assert.equal(f.queue.nextDelay(), null, 'idle should mean no timer');
  f.queue.patch(KEY, { customerNotes: 'x' });
  const delays = [];
  for (let i = 0; i < 7; i++) {
    f.faults.patch.push(err(503, 'server_unavailable'));
    await f.queue.flush();
    delays.push(f.queue.nextDelay());
  }
  const steps = [2000, 4000, 8000, 16000, 28000, 28000, 28000];
  delays.forEach((d, i) => assert.ok(d > steps[i] - 200 && d <= steps[i] + 1000, `try ${i + 1}: ${d} ms, expected ~${steps[i]}`));
  await f.queue.flush();
  assert.equal(f.queue.nextDelay(), null, 'success should reset it');
});

// ---- Finish's progress line ---------------------------------------------------------
await test('Finish says what is left, counting down — never a bare spinner', async () => {
  const f = fixture();
  assert.equal(typeof notice.finishProgressText, 'function', 'sync-notice has no finishProgressText');
  f.queue.patch(KEY, { customerNotes: 'x' });
  take(f.queue); take(f.queue);
  const p = f.queue.progress(KEY);
  assert.deepEqual([p.photos, p.changes, p.bytes], [2, 1, 6000]);
  assert.equal(notice.finishProgressText(p), 'Uploading 2 photos · 6 KB left · 1 change…');
  assert.equal(notice.finishProgressText({ photos: 1, bytes: 2_100_000, changes: 0 }), 'Uploading 1 photo · 2.1 MB left…');
  assert.equal(notice.finishProgressText({ photos: 0, bytes: 0, changes: 2 }), 'Sending 2 changes…');
  assert.equal(notice.finishProgressText({ photos: 0, changes: 0 }), 'Finishing…');
  await f.queue.flush();
  assert.equal(notice.finishProgressText(f.queue.progress(KEY)), 'Finishing…');
});

console.log(`field-sync: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

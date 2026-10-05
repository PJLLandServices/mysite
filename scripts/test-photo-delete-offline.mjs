#!/usr/bin/env node
// scripts/test-photo-delete-offline.mjs
//
// Deleting and re-filing a work-order photo from the phone, offline-safe
// (PJL-110/111). The REAL queue (pjl-field/src/offline/queue.mjs) against a
// fake disk and a fake server that runs the REAL server rules
// (server/lib/wo-photo-edits.js, field-photo-uploads.newPhotos), so the two
// halves are tested as they will meet. No network, no customer data.
//
// Every test fails on the queue before PJL-110: it had no deletePhoto or
// movePhoto at all.
//
// Run: node scripts/test-photo-delete-offline.mjs   (also in build:check)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createQueue } from '../pjl-field/src/offline/queue.mjs';

const require = createRequire(import.meta.url);
const edits = require('../server/lib/wo-photo-edits.js');
const uploads = require('../server/lib/field-photo-uploads.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, e.message); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const KEY = 'wo:WO-1';

function fixture({ photos = [] } = {}) {
  assert.equal(typeof createQueue({ store: { read: () => null, write() {} }, transport: {} }).deletePhoto, 'function', 'the queue has no deletePhoto');
  let disk = null;
  const blobs = new Map();
  const store = { read: () => clone(disk), write: x => { disk = clone(x); },
    putBlob: (id, p) => blobs.set(id, clone(p)), getBlob: id => clone(blobs.get(id)), deleteBlob: id => blobs.delete(id) };
  let remote = { id: 'WO-1', updatedAt: 'v1', status: 'in_progress', zones: [{ number: 1 }, { number: 2 }, { number: 3 }], photos: clone(photos), removedPhotos: [] };
  let online = true;
  const calls = { photo: 0, edit: 0 };
  const offline = () => { if (!online) throw Object.assign(new Error('offline'), { code: 'network' }); };
  // The server's upload route, as far as numbering and dedupe go.
  const serverUpload = (payload) => {
    const fresh = uploads.newPhotos([payload], remote.photos, remote.removedPhotos);
    if (fresh.length) {
      const { data, ...meta } = payload;
      remote.photos.push({ ...meta, n: edits.nextBaseN(remote) + 1 });
    }
  };
  const transport = {
    verifyOwner: async () => { offline(); return true; },
    read: async () => { offline(); return clone(remote); },
    patch: async (key, patch) => { offline(); remote = { ...remote, ...clone(patch) }; return clone(remote); },
    photo: async (key, payload) => { offline(); calls.photo++; serverUpload(payload); return clone(remote); },
    photoEdit: async (key, entry) => {
      offline(); calls.edit++;
      if (entry.kind === 'photoDelete') {
        const r = edits.removePhoto(remote, entry.photo, { by: 'tech' });
        remote = { ...remote, photos: r.photos, removedPhotos: r.removedPhotos };
      } else {
        const m = edits.movePhoto(remote, entry.photo, entry.zoneNumber);
        if (m.error) throw Object.assign(new Error(m.message), { status: m.error === 'photo_not_found' ? 404 : 422, code: m.error });
        if (m.photos) remote = { ...remote, photos: m.photos };
      }
      return clone(remote);
    },
  };
  const make = () => createQueue({ store, transport });
  const queue = make();
  queue.seed(KEY, remote);
  return { queue, make, transport, blobs, calls, serverUpload,
    rewriteDisk: fn => { const d = clone(disk); fn(d); disk = d; },
    offline: () => { online = false; }, online: () => { online = true; },
    remote: () => remote, setRemote: r => { remote = r; } };
}
const shown = q => q.view(KEY).photos;
const take = (q, meta = {}) => q.photo(KEY, { data: 'bytes', mediaType: 'image/jpeg', category: 'issue', ...meta });

await test('a photo that never left the phone is deleted on the phone and never uploads', async () => {
  const f = fixture(); f.offline();
  take(f.queue, { zoneNumber: 1, label: 'zone_1' });
  const p = shown(f.queue)[0];
  f.queue.deletePhoto(KEY, p);
  assert.equal(shown(f.queue).length, 0);
  assert.equal(f.blobs.size, 0, 'its bytes are dropped');
  assert.equal(f.queue.status(KEY).pending, 0, 'nothing left to send');
  f.online(); await f.queue.flush();
  assert.equal(f.calls.photo + f.calls.edit, 0, 'no server call at all');
  assert.equal(f.remote().photos.length, 0);
});

await test('an uploaded photo deleted offline disappears at once and is deleted on reconnect', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 2, label: 'zone_2' }); await f.queue.flush();
  assert.equal(f.remote().photos.length, 1);
  f.offline();
  f.queue.deletePhoto(KEY, shown(f.queue)[0]);
  assert.equal(shown(f.queue).length, 0, 'gone from the screen at once');
  assert.equal(f.queue.status(KEY).pending, 1);
  const reopened = f.make();
  assert.equal(shown(reopened).length, 0, 'still gone after the app restarts');
  await reopened.flush();
  assert.equal(f.remote().photos.length, 1, 'nothing reaches the server offline');
  f.online(); await reopened.flush();
  assert.equal(f.remote().photos.length, 0, 'deleted on the server');
  assert.equal(reopened.status(KEY).pending, 0);
});

await test('a photo uploaded from the office (no upload id) is deleted by number', async () => {
  const f = fixture({ photos: [{ n: 7, zoneNumber: 1, label: 'zone_1' }] });
  f.queue.deletePhoto(KEY, shown(f.queue)[0]);
  await f.queue.flush();
  assert.equal(f.remote().photos.length, 0);
});

await test('deleting a photo while its upload is in flight ends deleted on the server, no ghost', async () => {
  const f = fixture();
  let release; const gate = new Promise(r => { release = r; });
  const original = f.transport.photo;
  f.transport.photo = async (...args) => { await gate; return original(...args); };
  take(f.queue, { zoneNumber: 1 });
  const p = shown(f.queue)[0];
  const draining = f.queue.flush();
  await new Promise(r => setTimeout(r, 5));
  f.queue.deletePhoto(KEY, p);
  assert.equal(shown(f.queue).length, 0, 'gone from the screen at once');
  release(); await draining;
  await f.queue.flush();
  assert.equal(f.remote().photos.length, 0, 'the server ends with no photo');
  assert.equal(shown(f.queue).length, 0, 'and the phone shows none');
  assert.equal(f.queue.status(KEY).pending, 0);
});

await test('an upload that reaches the server AFTER its delete cannot bring the photo back', async () => {
  const f = fixture();
  // The upload is sent, the phone gives up waiting, the request is still
  // on its way to the server.
  let late = null;
  f.transport.photo = async (key, payload) => { late = payload; throw Object.assign(new Error('timed out'), { code: 'network' }); };
  take(f.queue, { zoneNumber: 1 });
  await f.queue.flush();
  f.queue.deletePhoto(KEY, shown(f.queue)[0]);
  await f.queue.flush();
  assert.equal(f.calls.edit, 1, 'an attempted upload is deleted on the server, not just on the phone');
  f.serverUpload(late); // …and now the slow request lands.
  assert.equal(f.remote().photos.length, 0, 'the tombstone drops it');
});

await test('a delete retried after a lost response acknowledges', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1 }); await f.queue.flush();
  const original = f.transport.photoEdit;
  f.transport.photoEdit = async (...args) => { await original(...args); throw Object.assign(new Error('response lost'), { code: 'network' }); };
  f.queue.deletePhoto(KEY, shown(f.queue)[0]);
  await f.queue.flush();
  assert.equal(f.queue.status(KEY).pending, 1);
  f.transport.photoEdit = original;
  await f.queue.flush();
  assert.equal(f.queue.status(KEY).pending, 0);
  assert.equal(f.remote().photos.length, 0);
});

await test('moving a photo that never left the phone re-files the queued upload itself', async () => {
  const f = fixture(); f.offline();
  take(f.queue, { zoneNumber: 1, label: 'zone_1' });
  f.queue.movePhoto(KEY, shown(f.queue)[0], 3);
  assert.equal(shown(f.queue)[0].zoneNumber, 3, 'shown under Zone 3 at once');
  assert.equal(f.queue.status(KEY).pending, 1, 'still just the upload');
  f.online(); await f.queue.flush();
  assert.equal(f.calls.edit, 0, 'no separate move call');
  assert.equal(f.remote().photos[0].zoneNumber, 3, 'it arrives in Zone 3');
  assert.equal(f.remote().photos[0].label, 'zone_3', 'with the zone label');
});

await test('moving an uploaded photo offline keeps the photo and lands on reconnect', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1, label: 'zone_1' }); await f.queue.flush();
  const n = f.remote().photos[0].n;
  f.offline();
  f.queue.movePhoto(KEY, shown(f.queue)[0], 2);
  assert.equal(shown(f.queue)[0].zoneNumber, 2, 'shown under Zone 2 at once');
  f.online(); await f.queue.flush();
  assert.equal(f.remote().photos[0].zoneNumber, 2);
  assert.equal(f.remote().photos[0].n, n, 'same photo number');
  assert.equal(f.queue.status(KEY).pending, 0);
});

await test('"whole visit" files the photo under no zone', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1, label: 'zone_1' }); await f.queue.flush();
  f.queue.movePhoto(KEY, shown(f.queue)[0], null);
  await f.queue.flush();
  assert.equal(f.remote().photos[0].zoneNumber ?? null, null);
});

await test('a move the server refuses (the zone left the visit) does not stall the visit', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1 }); await f.queue.flush();
  f.offline();
  f.queue.movePhoto(KEY, shown(f.queue)[0], 3);
  f.queue.patch(KEY, { techNotes: 'later change' });
  f.setRemote({ ...f.remote(), zones: [{ number: 1 }, { number: 2 }] }); // The office removed Zone 3.
  f.online(); await f.queue.flush();
  assert.equal(f.queue.status(KEY).pending, 0, 'nothing held');
  assert.equal(f.remote().techNotes, 'later change', 'the later change synced');
  assert.equal(shown(f.queue)[0].zoneNumber, 1, 'the photo shows where the server has it');
});

await test('a zone that is not on the visit is refused on the phone', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1 });
  assert.throws(() => f.queue.movePhoto(KEY, shown(f.queue)[0], 9), /not on this visit/);
});

await test('deleting a photo with a queued move drops the move', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1 }); await f.queue.flush();
  f.offline();
  f.queue.movePhoto(KEY, shown(f.queue)[0], 2);
  f.queue.deletePhoto(KEY, shown(f.queue)[0]);
  assert.equal(f.queue.status(KEY).pending, 1, 'only the delete is left');
  f.online(); await f.queue.flush();
  assert.equal(f.remote().photos.length, 0);
});

await test('a photo queued by the previous app (no sent flag) is deleted on the server too', async () => {
  const f = fixture();
  take(f.queue, { zoneNumber: 1 });
  // What the previous release left on disk: no `sent` on the entry — and
  // its upload may have landed with the response lost.
  f.rewriteDisk(d => { for (const p of d.pending) delete p.sent; });
  const p = shown(f.queue)[0];
  f.serverUpload({ ...f.blobs.get(p.clientUploadId) });
  const q = f.make();
  q.deletePhoto(KEY, shown(q)[0]);
  await q.flush();
  assert.equal(f.remote().photos.length, 0, 'no ghost left on the server');
  assert.equal(q.status(KEY).pending, 0);
});

console.log(`photo-delete-offline: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

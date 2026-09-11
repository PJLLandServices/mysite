// Real queue logic, fake durable disk and network. No customer data or services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve('pjl-field/src/offline/queue.mjs');
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, e.message); }
}
let createQueue;
if (fs.existsSync(file)) ({ createQueue } = await import('../pjl-field/src/offline/queue.mjs'));
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  assert.equal(typeof createQueue, 'function', 'durable field queue is missing');
  let disk = null;
  const blobs = new Map();
  const store = { read: () => clone(disk), write: x => { disk = clone(x); },
    putBlob: (id, p) => blobs.set(id, clone(p)), getBlob: id => blobs.get(id), deleteBlob: id => blobs.delete(id) };
  let remote = { id: 'WO-1', updatedAt: 'v1', customerNotes: '', backFlush: '', zones: [], photos: [] };
  let online = true, writes = 0, allowed = true;
  const transport = {
    verifyOwner: async () => { if (!online) throw new Error('offline'); return allowed; },
    read: async () => { if (!online) throw new Error('offline'); return clone(remote); },
    patch: async (key, patch, version) => {
      if (!online) throw new Error('offline');
      assert.equal(version, remote.updatedAt);
      writes++;
      remote = { ...remote, ...clone(patch), updatedAt: `v${writes + 1}` };
      return clone(remote);
    },
    photo: async (key, photo) => {
      if (!online) throw new Error('offline');
      if (!remote.photos.some(p => p.clientUploadId === photo.clientUploadId)) {
        remote.photos.push({ n: remote.photos.length + 1, clientUploadId: photo.clientUploadId });
      }
      return clone(remote);
    },
  };
  const make = () => createQueue({ store, transport });
  const queue = make();
  queue.seed('wo:WO-1', remote);
  return { queue, make, store, transport, blobs,
    offline: () => { online = false; }, online: () => { online = true; }, wrongOwner: () => { allowed = false; },
    remote: () => remote, change: patch => { remote = { ...remote, ...patch }; }, writes: () => writes };
}
await test('control: online acknowledged edit reaches server', async () => {
  const f = fixture(); f.queue.patch('wo:WO-1', { customerNotes: 'Gate closed' });
  await f.queue.flush(); assert.equal(f.remote().customerNotes, 'Gate closed'); assert.equal(f.queue.status('wo:WO-1').pending, 0);
});
await test('offline note and unrelated answer survive restart and reconnect', async () => {
  const f = fixture(); f.offline();
  f.queue.patch('wo:WO-1', { customerNotes: 'Broken head' }); await f.queue.flush();
  f.queue.patch('wo:WO-1', { backFlush: 'no' });
  const reopened = f.make(); assert.equal(reopened.view('wo:WO-1').customerNotes, 'Broken head');
  assert.equal(reopened.status('wo:WO-1').pending, 2);
  f.online(); await reopened.flush(); assert.equal(f.remote().customerNotes, 'Broken head'); assert.equal(f.remote().backFlush, 'no');
});
await test('rapid saves run serially and later edits survive an older response', async () => {
  const f = fixture(); let release; const original = f.transport.patch;
  f.transport.patch = async (...args) => { await new Promise(r => { release = r; }); return original(...args); };
  f.queue.patch('wo:WO-1', { customerNotes: 'A' }); const draining = f.queue.flush();
  while (!release) await new Promise(r => setTimeout(r, 0));
  f.queue.patch('wo:WO-1', { customerNotes: 'AB' });
  assert.equal(f.queue.status('wo:WO-1').pending, 2);
  f.transport.patch = original; release(); await draining;
  assert.equal(f.queue.view('wo:WO-1').customerNotes, 'AB'); assert.equal(f.remote().customerNotes, 'AB');
});
await test('disk-full refuses the edit without claiming it was recorded', async () => {
  const f = fixture(); f.store.write = () => { throw new Error('disk full'); };
  assert.throws(() => f.queue.patch('wo:WO-1', { customerNotes: 'lost?' }), /disk full/);
  assert.equal(f.queue.view('wo:WO-1').customerNotes, '');
});
await test('remote conflict retains local evidence and never overwrites the office', async () => {
  const f = fixture(); f.queue.patch('wo:WO-1', { customerNotes: 'field' }); f.change({ customerNotes: 'office', updatedAt: 'office-v' });
  await f.queue.flush(); assert.equal(f.writes(), 0); assert.equal(f.queue.view('wo:WO-1').customerNotes, 'field');
  assert.equal(f.queue.status('wo:WO-1').error.code, 'conflict');
});
await test('unrelated office fields survive reconciliation', async () => {
  const f = fixture(); f.queue.patch('wo:WO-1', { customerNotes: 'field' }); f.change({ backFlush: 'yes', updatedAt: 'office-v' });
  await f.queue.flush(); assert.equal(f.remote().backFlush, 'yes'); assert.equal(f.remote().customerNotes, 'field');
});
await test('lost acknowledgement is reconciled without repeating an accepted edit', async () => {
  const f = fixture(); const original = f.transport.patch;
  f.transport.patch = async (...args) => { await original(...args); throw new Error('response lost'); };
  f.queue.patch('wo:WO-1', { customerNotes: 'field' }); await f.queue.flush();
  f.transport.patch = original; await f.make().flush(); assert.equal(f.writes(), 1);
});
await test('photos remain durable after restart and disappear from queue only after acknowledgement', async () => {
  const f = fixture(); f.offline(); f.queue.photo('wo:WO-1', { data: 'photo-bytes', mediaType: 'image/jpeg', label: 'water_off' });
  const q = f.make(); assert.equal(q.view('wo:WO-1').photos.length, 1); assert.equal(f.blobs.size, 1);
  await q.flush(); assert.equal(q.status('wo:WO-1').pending, 1);
  f.online(); await q.flush(); assert.equal(q.status('wo:WO-1').pending, 0); assert.equal(f.remote().photos.length, 1);
});
await test('a different signed-in user cannot drain another user\'s work', async () => {
  const f = fixture(); f.queue.patch('wo:WO-1', { customerNotes: 'field' }); f.wrongOwner(); await f.queue.flush();
  assert.equal(f.writes(), 0); assert.equal(f.queue.status('wo:WO-1').pending, 1);
});
await test('local drafts survive reopening without marking a zone reviewed', async () => {
  const f = fixture(); f.queue.draft('wo:WO-1', 'zone:1', { notes: 'Valve leak', repairs: true });
  const q = f.make(); assert.equal(q.getDraft('wo:WO-1', 'zone:1').notes, 'Valve leak'); assert.deepEqual(q.view('wo:WO-1').zones, []);
});
await test('photo acknowledgement lost after acceptance does not duplicate the photo', async () => {
  const f = fixture(); const original = f.transport.photo;
  f.transport.photo = async (...args) => { await original(...args); throw Error('response lost'); };
  f.queue.photo('wo:WO-1', { data: 'bytes', mediaType: 'image/jpeg' }); await f.queue.flush();
  f.transport.photo = original; const q = f.make(); await q.flush();
  assert.equal(f.remote().photos.length, 1); assert.equal(q.status('wo:WO-1').pending, 0);
});
await test('server rejection is retained without automatic repeat submissions', async () => {
  const f = fixture(); let calls = 0;
  f.transport.patch = async () => { calls++; throw Object.assign(Error('locked'), { code: 'wo_locked' }); };
  f.queue.patch('wo:WO-1', { customerNotes: 'field' }); await f.queue.flush(); await f.queue.flush();
  assert.equal(calls, 1); assert.equal(f.make().status('wo:WO-1').pending, 1);
});
await test('an older refresh cannot replace a newer acknowledged server record', () => {
  const f = fixture();
  f.queue.seed('wo:WO-1', { ...f.remote(), updatedAt: '2026-09-11T15:00:00Z', customerNotes: 'new' });
  f.queue.seed('wo:WO-1', { ...f.remote(), updatedAt: '2026-09-11T14:00:00Z', customerNotes: 'old' });
  assert.equal(f.queue.view('wo:WO-1').customerNotes, 'new');
});
await test('object key order does not manufacture a conflict', async () => {
  const f = fixture(); f.change({ zones: [{ number: 1, notes: 'a' }] }); f.queue.seed('wo:WO-1', f.remote());
  f.queue.patch('wo:WO-1', { zones: [{ notes: 'b', number: 1 }] });
  f.change({ zones: [{ notes: 'a', number: 1 }] }); await f.queue.flush();
  assert.equal(f.remote().zones[0].notes, 'b');
});
await test('a locally queued property correction survives in the visit decoration', () => {
  const f = fixture(); const property = { id: 'P-1', system: { shutoffLocation: 'Basement' } };
  f.queue.seed('prop:P-1', property); f.queue.seed('wo:WO-1', { ...f.remote(), property });
  f.queue.patch('prop:P-1', { system: { shutoffLocation: 'Garage' } });
  assert.equal(f.make().view('wo:WO-1').property.system.shutoffLocation, 'Garage');
});
await test('a closed visit retains new field edits instead of writing after completion', async () => {
  const f = fixture(); f.queue.patch('wo:WO-1', { backFlush: 'no' }); f.change({ status: 'completed' });
  await f.queue.flush(); assert.equal(f.writes(), 0); assert.equal(f.queue.status('wo:WO-1').error.code, 'closed');
});
console.log(`field-offline: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

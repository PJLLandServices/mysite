// Execute the shipped native API bridge with a fake HTTP server and durable
// key/value store. No calls leave this process. Complements the queue tests.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createQueue } from '../pjl-field/src/offline/queue.mjs';
const src = fs.readFileSync('pjl-field/src/offline/field.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture() {
  const disk = new Map(); let online = true, user = 'owner', capability = 1, photos = 0;
  const property = { id: 'P-1', updatedAt: 'p1', system: { shutoffLocation: 'Basement' } };
  const wo = { id: 'WO-1', type: 'fall_closing', updatedAt: 'w1', propertyId: 'P-1', zones: [], photos: [], customerNotes: '' };
  const writeLocal = (key, value) => disk.set(key, clone(value));
  const readLocal = key => clone(disk.get(key) ?? null);
  const storeForOwner = owner => ({ read: () => readLocal(owner + ':queue'), write: value => writeLocal(owner + ':queue', value),
    putBlob: (key, value) => writeLocal(owner + key, value), getBlob: key => readLocal(owner + key), deleteBlob: key => disk.delete(owner + key) });
  const calls = [];
  const fetch = async (url, options) => {
    if (!online) throw new TypeError('offline');
    const pathname = new URL(url).pathname;
    calls.push([options.method, pathname]);
    let data;
    if (pathname === '/api/session') data = { ok: true, authenticated: !!user, role: 'admin', user: { id: user }, fieldOffline: { photoRetry: capability } };
    else if (pathname === '/api/work-orders/WO-1/photos') {
      photos++; const p = JSON.parse(options.body).photos[0]; wo.photos.push({ n: photos, clientUploadId: p.clientUploadId });
      data = { ok: true, workOrder: clone(wo) };
    } else if (pathname === '/api/work-orders/WO-1') {
      if (options.method === 'PATCH') Object.assign(wo, JSON.parse(options.body));
      data = { ok: true, workOrder: clone(wo), property: clone(property), lead: null };
    } else if (pathname === '/api/properties/P-1') {
      if (options.method === 'PATCH') Object.assign(property, JSON.parse(options.body));
      data = { ok: true, property: clone(property) };
    } else throw Error('Unexpected request: ' + pathname);
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  function load() {
    const context = { createQueue, readLocal, writeLocal, storeForOwner, HOST: 'https://field.local',
      AuthRequiredError: class AuthRequiredError extends Error {}, fetch, AbortController, setTimeout, clearTimeout,
      AppState: { currentState: 'active' } };
    return vm.runInNewContext(src + '\n({ openFieldWorkOrder, flushBeforeFinish, restoreFieldWorkOrder, fieldStatus });', context);
  }
  return { load, wo, property, calls, offline: () => { online = false; }, online: () => { online = true; },
    signOut: () => { user = null; }, switchUser: () => { user = 'other'; }, oldServer: () => { capability = 0; }, photos: () => photos };
}
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.error('FAIL', name, e.message); } }
await test('reopening offline restores the open job and its unsent note', async () => {
  const f = fixture(); const c = await f.load().openFieldWorkOrder('WO-1'); f.offline();
  c.queue.patch(c.key, { customerNotes: 'Gate latched' });
  const reopened = f.load(); assert.equal((await reopened.restoreFieldWorkOrder()).customerNotes, 'Gate latched');
  assert.equal((await reopened.openFieldWorkOrder('WO-1')).workOrder.customerNotes, 'Gate latched');
});
await test('a confirmed sign-out never silently opens the cached record', async () => {
  const f = fixture(); await f.load().openFieldWorkOrder('WO-1'); f.signOut();
  await assert.rejects(f.load().openFieldWorkOrder('WO-1'));
});
await test('an old server is detected before sending photo bytes', async () => {
  const f = fixture(); const c = await f.load().openFieldWorkOrder('WO-1'); f.oldServer();
  c.queue.photo(c.key, { data: 'bytes', mediaType: 'image/jpeg' }); await c.queue.flush();
  assert.equal(f.photos(), 0); assert.equal(c.queue.status(c.key).error.code, 'server_update');
});
await test('photos and property corrections reach their own endpoints', async () => {
  const f = fixture(); const api = f.load(); const c = await api.openFieldWorkOrder('WO-1');
  c.queue.photo(c.key, { data: 'bytes', mediaType: 'image/jpeg' });
  c.queue.patch('prop:P-1', { system: { shutoffLocation: 'Garage' } });
  assert.equal(api.fieldStatus(c.queue, c.key).pending, 2);
  await c.queue.flush(); assert.equal(f.photos(), 1); assert.equal(f.property.system.shutoffLocation, 'Garage');
  assert.equal(api.fieldStatus(c.queue, c.key).pending, 0);
});
await test('sign-off is blocked by unrecorded zone drafts', async () => {
  const f = fixture(); const api = f.load(); const c = await api.openFieldWorkOrder('WO-1');
  c.queue.draft(c.key, 'zone:1', { notes: 'Valve leak' });
  await assert.rejects(api.flushBeforeFinish(c.queue, c.key), /zone drafts/);
});
await test('switching accounts cannot upload the first account\'s note', async () => {
  const f = fixture(); const c = await f.load().openFieldWorkOrder('WO-1');
  c.queue.patch(c.key, { customerNotes: 'Private' }); f.switchUser(); await c.queue.flush();
  assert.equal(f.wo.customerNotes, ''); assert.equal(c.queue.status(c.key).pending, 1);
});
console.log(`field-client: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;

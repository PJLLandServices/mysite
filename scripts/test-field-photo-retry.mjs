import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let service;
try { service = require('../server/lib/field-photo-uploads.js'); } catch {}
let passed = 0, failed = 0;
async function test(name, fn) { try { assert.ok(service, 'photo retry protection missing'); await fn(); passed++; } catch (e) { failed++; console.error('FAIL', name, e.message); } }
await test('accepted photo retry is not stored twice', () => {
  assert.deepEqual(service.newPhotos([{ clientUploadId: 'field-1' }], [{ clientUploadId: 'field-1' }]), []);
});
await test('legacy photos still append and distinct photos remain distinct', () => {
  assert.equal(service.newPhotos([{ data: 'a' }, { clientUploadId: 'field-2' }], [{ clientUploadId: 'field-1' }]).length, 2);
});
await test('concurrent uploads to one work order are serialized', async () => {
  const order = [];
  await Promise.all([service.run('WO-X', async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); order.push(2); }),
    service.run('WO-X', async () => { order.push(3); })]);
  assert.deepEqual(order, [1, 2, 3]);
});
await test('a failed upload releases the lock', async () => {
  await assert.rejects(service.run('WO-X', async () => { throw Error('fail'); }));
  assert.equal(await service.run('WO-X', async () => 'ok'), 'ok');
});
console.log(`field-photo-retry: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;

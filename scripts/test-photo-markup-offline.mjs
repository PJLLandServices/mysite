#!/usr/bin/env node
// scripts/test-photo-markup-offline.mjs
//
// Marking up a photo on the phone, offline-safe (PJL-112), plus the rules
// that keep markup and shrinking apart. The REAL queue against a fake disk
// and a fake server running the REAL server rules (server/lib/
// wo-photo-edits.js, field-photo-uploads.newPhotos); the REAL canvas
// drawing code (photo-canvas.mjs canvasLib) against a recording context;
// and source guards on the screens. No network, no customer data.
//
// Fails before PJL-112: the queue had no markup, nothing paired photos,
// and photo-canvas.mjs did not exist.
//
// Run: node scripts/test-photo-markup-offline.mjs   (also in build:check)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const edits = require('../server/lib/wo-photo-edits.js');
const uploads = require('../server/lib/field-photo-uploads.js');
let queueMod = null, pairs = null, canvas = null, transportMod = null;
try { queueMod = await import('../pjl-field/src/offline/queue.mjs'); } catch {}
try { pairs = await import('../pjl-field/src/photo-pairs.mjs'); } catch {}
try { canvas = await import('../pjl-field/src/photo-canvas.mjs'); } catch {}
try { transportMod = await import('../pjl-field/src/offline/transport.mjs'); } catch {}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, e.message); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const KEY = 'wo:WO-1';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function fixture() {
  assert.equal(typeof queueMod?.createQueue({ store: { read: () => null, write() {} }, transport: {} }).markup, 'function', 'the queue has no markup');
  let disk = null;
  const blobs = new Map();
  const store = { read: () => clone(disk), write: x => { disk = clone(x); },
    putBlob: (id, p) => blobs.set(id, clone(p)), getBlob: id => clone(blobs.get(id)), deleteBlob: id => blobs.delete(id) };
  let remote = { id: 'WO-1', updatedAt: 'v1', status: 'in_progress', zones: [{ number: 1 }, { number: 2 }], photos: [], removedPhotos: [] };
  let online = true;
  const sent = [];
  const offline = () => { if (!online) throw Object.assign(new Error('offline'), { code: 'network' }); };
  // The server's upload route: dedupe, markup link and filing, one markup
  // per original.
  const serverUpload = payload => {
    const { data, ...meta } = payload;
    if (!uploads.newPhotos([payload], remote.photos, remote.removedPhotos).length) return;
    let filed = { ...meta };
    if (meta.markupOf != null) {
      const link = edits.resolveMarkupOf(remote, meta.markupOf);
      if (link.error) throw Object.assign(new Error(link.error), { status: 422, code: 'markup_original_missing' });
      if (link.dropped) { remote.removedPhotos.push({ n: null, clientUploadId: meta.clientUploadId }); return; }
      const o = link.original;
      filed = { ...meta, markupOf: o.n, markupOfUpload: o.clientUploadId || null, zoneNumber: o.zoneNumber ?? null, label: o.label || '' };
      for (const old of edits.markupsOf(remote.photos, o)) {
        remote.photos = remote.photos.filter(p => p !== old);
        remote.removedPhotos.push({ n: old.n, clientUploadId: old.clientUploadId });
      }
    }
    remote.photos.push({ ...filed, n: edits.nextBaseN(remote) + 1 });
  };
  const transport = {
    verifyOwner: async () => { offline(); return true; },
    read: async () => { offline(); return clone(remote); },
    patch: async (key, patch) => { offline(); remote = { ...remote, ...clone(patch) }; return clone(remote); },
    photo: async (key, payload) => { offline(); sent.push(payload.clientUploadId); serverUpload(payload); return clone(remote); },
    photoEdit: async (key, entry) => {
      offline();
      if (entry.kind === 'photoDelete') {
        const r = edits.removePhoto(remote, entry.photo, { by: 'tech' });
        remote = { ...remote, photos: r.photos, removedPhotos: r.removedPhotos };
      } else {
        const m = edits.movePhoto(remote, entry.photo, entry.zoneNumber);
        if (m.error) throw Object.assign(new Error(m.message), { status: 422 });
        if (m.photos) remote = { ...remote, photos: m.photos };
      }
      return clone(remote);
    },
  };
  const queue = queueMod.createQueue({ store, transport });
  queue.seed(KEY, remote);
  return { queue, blobs, sent, remote: () => remote, offline: () => { online = false; }, online: () => { online = true; } };
}
const shown = q => q.view(KEY).photos;
const take = (q, zone = 1) => q.photo(KEY, { data: 'original-bytes', mediaType: 'image/jpeg', category: 'issue', zoneNumber: zone, label: `zone_${zone}` });
const markupOf = (q, photo) => q.markup(KEY, photo, { data: 'drawn-bytes', mediaType: 'image/jpeg' });
const tiles = q => pairs.pairPhotos(shown(q));

// ---- the queue ------------------------------------------------------------------
await test('a markup of a photo still on the phone waits for it, then links to it on the server', async () => {
  const f = fixture(); f.offline();
  take(f.queue);
  markupOf(f.queue, shown(f.queue)[0]);
  assert.equal(f.queue.status(KEY).pending, 2);
  f.online(); await f.queue.flush();
  assert.deepEqual(f.sent.length, 2);
  const [o, m] = f.remote().photos;
  assert.equal(m.markupOf, o.n, 'the markup names its original');
  assert.equal(m.zoneNumber, 1);
  assert.equal(f.queue.status(KEY).pending, 0);
});

await test('the thumbnails pair them: the markup shows in the original\'s place', async () => {
  const f = fixture(); f.offline();
  take(f.queue); take(f.queue);
  markupOf(f.queue, shown(f.queue)[0]);
  const t = tiles(f.queue);
  assert.equal(t.length, 2, 'two photos, one of them marked up');
  assert.ok(t[0].markup && !t[1].markup);
  f.online(); await f.queue.flush();
  const after = tiles(f.queue);
  assert.equal(after.length, 2, 'still paired once uploaded');
  assert.ok(after[0].markup);
});

await test('marking up again replaces the markup still waiting — one upload', async () => {
  const f = fixture(); f.offline();
  take(f.queue);
  const o = shown(f.queue)[0];
  markupOf(f.queue, o);
  markupOf(f.queue, o);
  assert.equal(f.queue.status(KEY).pending, 2, 'the original and ONE markup');
  f.online(); await f.queue.flush();
  assert.equal(f.remote().photos.filter(p => p.markupOf != null).length, 1);
});

await test('marking up again after the first markup uploaded: the server replaces it', async () => {
  const f = fixture();
  take(f.queue); await f.queue.flush();
  const o = shown(f.queue)[0];
  markupOf(f.queue, o); await f.queue.flush();
  markupOf(f.queue, tiles(f.queue)[0].original); await f.queue.flush();
  assert.equal(f.remote().photos.filter(p => p.markupOf != null).length, 1);
  assert.equal(tiles(f.queue).length, 1);
});

await test('deleting a photo still on the phone drops its markup too — nothing uploads', async () => {
  const f = fixture(); f.offline();
  take(f.queue);
  markupOf(f.queue, shown(f.queue)[0]);
  f.queue.deletePhoto(KEY, tiles(f.queue)[0].original);
  assert.equal(shown(f.queue).length, 0);
  assert.equal(f.blobs.size, 0, 'both sets of bytes are gone');
  f.online(); await f.queue.flush();
  assert.equal(f.sent.length, 0);
});

await test('deleting an uploaded photo offline hides its markup at once; the server deletes both', async () => {
  const f = fixture();
  take(f.queue); await f.queue.flush();
  markupOf(f.queue, shown(f.queue)[0]); await f.queue.flush();
  f.offline();
  f.queue.deletePhoto(KEY, tiles(f.queue)[0].original);
  assert.equal(shown(f.queue).length, 0, 'gone from the screen at once');
  f.online(); await f.queue.flush();
  assert.equal(f.remote().photos.length, 0);
});

await test('removing just the markup keeps the photo', async () => {
  const f = fixture();
  take(f.queue); await f.queue.flush();
  markupOf(f.queue, shown(f.queue)[0]); await f.queue.flush();
  f.queue.deletePhoto(KEY, tiles(f.queue)[0].markup); await f.queue.flush();
  assert.equal(f.remote().photos.length, 1);
  assert.equal(tiles(f.queue)[0].markup, null);
});

await test('moving a marked-up photo moves its markup with it, at once and on the server', async () => {
  const f = fixture();
  take(f.queue); await f.queue.flush();
  markupOf(f.queue, shown(f.queue)[0]); await f.queue.flush();
  f.offline();
  f.queue.movePhoto(KEY, tiles(f.queue)[0].original, 2);
  assert.ok(shown(f.queue).every(p => p.zoneNumber === 2), 'both shown under Zone 2');
  f.online(); await f.queue.flush();
  assert.ok(f.remote().photos.every(p => p.zoneNumber === 2));
});

await test('a markup is not sent to a server that cannot link it', async () => {
  assert.equal(typeof transportMod?.createTransport, 'function');
  const calls = [];
  const request = async (path, opts = {}) => {
    calls.push(path);
    if (path === '/api/session') return { authenticated: true, role: 'tech', user: { id: 'U' }, fieldOffline: { photoRetry: 1, ownerCheck: 1 } };
    throw new Error('should not upload');
  };
  const t = transportMod.createTransport({ request, account: 'U', view: () => null });
  await t.verifyOwner();
  await assert.rejects(t.photo('wo:WO-1', { data: 'x', mediaType: 'image/jpeg', clientUploadId: 'field-x', markupOf: { n: 1 } }), e => e.code === 'server_update');
  assert.ok(!calls.some(p => p.endsWith('/photos')), 'no upload was attempted');
});

// ---- the canvas drawing code (the text the WebView runs) ---------------------------
await test('fitWithin caps the long edge at 2400 px and keeps the shape; small photos are left alone', () => {
  assert.equal(typeof canvas?.canvasLib, 'function', 'photo-canvas.mjs is missing');
  const { fitWithin } = canvas.canvasLib();
  assert.deepEqual(fitWithin(4032, 3024, 2400), { width: 2400, height: 1800, scale: 2400 / 4032 });
  assert.deepEqual(fitWithin(3024, 4032, 2400), { width: 1800, height: 2400, scale: 2400 / 4032 });
  assert.equal(fitWithin(1200, 900, 2400).scale, 1);
});

await test('renderMarks draws the photo first, then every tool', () => {
  const { renderMarks } = canvas.canvasLib();
  const ops = [];
  const ctx = new Proxy({}, { get: (_, k) => (typeof k === 'string' && /^[a-z]/.test(k) && !['lineCap', 'lineJoin', 'strokeStyle', 'fillStyle', 'lineWidth', 'font', 'textBaseline'].includes(k) ? (...a) => ops.push(k) : undefined), set: () => true });
  renderMarks(ctx, {}, [
    { tool: 'pen', color: '#f00', width: 'thick', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] },
    { tool: 'arrow', color: '#f00', width: 'thin', from: { x: 0, y: 0 }, to: { x: 50, y: 0 } },
    { tool: 'circle', color: '#ff0', width: 'thin', from: { x: 0, y: 0 }, to: { x: 40, y: 20 } },
    { tool: 'text', color: '#fff', width: 'thin', at: { x: 10, y: 10 }, text: 'Leak' },
  ], 4032);
  assert.equal(ops[0], 'drawImage', 'the photo is under the marks');
  for (const op of ['lineTo', 'ellipse', 'strokeText', 'fillText']) assert.ok(ops.includes(op), `no ${op}`);
});

await test('both pages are self-contained and carry the same drawing code', () => {
  for (const html of [canvas.EDITOR_HTML, canvas.SHRINK_HTML]) {
    assert.ok(!/https?:\/\//.test(html), 'a page loads something from the network');
    assert.ok(html.includes(canvas.CANVAS_LIB), 'a page does not carry CANVAS_LIB');
  }
  assert.ok(/toDataURL\('image\/jpeg', MARKUP_QUALITY\)/.test(canvas.EDITOR_HTML), 'markup saves at MARKUP_QUALITY');
  assert.ok(/toDataURL\('image\/jpeg', SHRINK_QUALITY\)/.test(canvas.SHRINK_HTML), 'shrink saves at SHRINK_QUALITY');
  assert.equal(canvas.MARKUP_QUALITY, 0.85);
  assert.equal(canvas.SHRINK_QUALITY, 0.75);
});

// ---- markup and shrinking stay apart (Patrick, 2026-10-04) ----------------------------
await test('the markup editor does not depend on shrinking', () => {
  const editor = read('pjl-field/src/screens/closing/PhotoMarkup.js');
  assert.ok(!/SHRINK|PhotoShrinker|photoShrink/.test(editor), 'PhotoMarkup.js reaches into shrinking');
  assert.ok(/EDITOR_HTML/.test(editor));
});

await test('shrinking runs only while the server switch is on, and falls back to the original', () => {
  const screen = read('pjl-field/src/screens/ClosingScreen.js');
  assert.match(screen, /const shrinkOn = features\.photoShrink === 1 \|\| features\.photoShrink === 2;/);
  // The device check uploads the untouched original, and the copy beside it.
  assert.match(screen, /queue\.photo\(key, shrinkCompare \? photo : ready\);/, 'compare mode must upload the untouched original');
  assert.match(screen, /label: `Shrink test/);
  assert.match(screen, /\{shrinkOn \? <PhotoShrinker onReady=\{onShrinkerReady\} \/> : null\}/, 'the shrinker is mounted without the switch');
  // A camera photo is already resized on the phone (PJL-114); a library pick still goes through the shrinker.
  assert.match(screen, /const ready = !resized && shrinkOn && shrinkRef\.current \? await shrinkRef\.current\(photo\) : photo;/);
  assert.match(screen, /const \{ resized, \.\.\.photo \} = taken;/, 'the resized marker must not go up with the photo');
  const shrinker = read('pjl-field/src/PhotoShrinker.js');
  assert.match(shrinker, /const TIMEOUT_MS = 10000;/);
  assert.match(shrinker, /setTimeout\(\(\) => \{ waiting\.current\.delete\(id\); resolve\(payload\); \}, TIMEOUT_MS\)/, 'no answer must mean the original');
  const photos = read('pjl-field/src/photos.js');
  assert.match(photos, /quality: 0\.4,/, 'the picker default changed');
  assert.match(photos, /shrink \? \{ \.\.\.OPTIONS, quality: SHRINK_SOURCE_QUALITY \} : OPTIONS/);
  const server = read('server/server.js');
  assert.match(server, /photoShrink: process\.env\.FIELD_PHOTO_SHRINK === "1" \? 1 : process\.env\.FIELD_PHOTO_SHRINK === "compare" \? 2 : 0/, 'shrinking must default OFF on the server');
});

await test('"Mark up" is offered, never opened on its own (D-B3)', () => {
  const screen = read('pjl-field/src/screens/ClosingScreen.js');
  const attach = screen.slice(screen.indexOf('const attachPhoto = useCallback'), screen.indexOf('// Marking up (PJL-112)'));
  assert.ok(attach.length > 50 && !/markupPhoto|setMarkupFor/.test(attach), 'taking a photo opens the editor');
  const thumbs = read('pjl-field/src/screens/closing/PhotoThumbs.js');
  assert.match(thumbs, /Mark up this photo/);
});

console.log(`photo-markup-offline: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

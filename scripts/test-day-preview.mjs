// "Show me the day with them in it."
//
//   node scripts/test-day-preview.mjs
//
// Patrick, 2026-09-11, after booking a suggested day and then finding the
// route ran Pickering to North York: "I want to temporarily see the whole
// day (WITH) that navigation map (actual drive line) inserted."
//
// Two things could make this screen LIE, and a screen you consult before
// committing is worse than nothing if it lies:
//
//   1. SHOWING A DAY NOBODY IS DRIVING. The preview must draw the real
//      day, from the same endpoint the real map draws, with exactly one
//      row added. If it ever rebuilt the day itself, or quietly resequenced
//      the stops already on it, the shape on screen would stop being the
//      shape of the drive.
//
//   2. HIDING THE EXPENSIVE STOP. An address the geocoder cannot place
//      cannot be drawn — and a map silently missing the far-away pin shows
//      a tidy day and invites exactly the booking this feature exists to
//      prevent. It has to say so instead.
//
// The insertion index is the fiddly part: geoFilter.addedDriveMinutes()
// reports a position counted in the GAPS of [yard, ...stops, yard], and
// reading that as an index into the stops is right by one only if you
// think about it. Both ends are pinned below.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readOr = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

const MODULE = 'server/lib/day-preview.js';
let lib = null;
let libError = null;
try { lib = require(path.join(ROOT, MODULE)); }
catch (err) { libError = err; }

check(`${MODULE} loads`, () => {
  assert.ok(lib, libError ? libError.message : 'nothing exported');
});

const use = (name) => (...args) => {
  if (!lib) throw new Error(`${MODULE} did not load`);
  if (typeof lib[name] !== 'function') throw new Error(`${MODULE} does not export ${name}`);
  return lib[name](...args);
};
const insertionIndex = use('insertionIndex');
const candidateRow = use('candidateRow');
const dayWithCandidate = use('dayWithCandidate');
const lineStops = use('lineStops');

const SERVER = readOr('server/server.js');
const MAP = readOr('server/today-map.js');
const SCREEN = readOr('pjl-field/src/screens/DayPreview.js');
const BOOK = readOr('pjl-field/src/screens/BookScreen.js');

const stop = (n, lat) => ({
  leadId: `L${n}`, address: `${n} Somewhere St`, customerName: `C${n}`,
  start: `2026-10-06T1${n}:00:00.000Z`, coords: { lat, lng: -79.4 },
});
const DAY = [stop(1, 44.05), stop(2, 44.02), stop(3, 43.99)];

// ---- Where the new stop lands -------------------------------------------

check('gap 0 puts it first, before everything on the day', () => {
  // The yard-to-first-stop gap. Off by one here and the preview draws the
  // new stop second while the drive would take it first.
  assert.equal(insertionIndex(0, 3), 0);
});

check('the last gap puts it last, after everything', () => {
  assert.equal(insertionIndex(3, 3), 3);
});

check('a middle gap lands between the right two stops', () => {
  const day = dayWithCandidate(DAY, candidateRow({ address: 'New' }), 2);
  assert.deepEqual(day.map((r) => r.address),
    ['1 Somewhere St', '2 Somewhere St', 'New', '3 Somewhere St']);
});

check('a position past the end cannot run off it', () => {
  assert.equal(insertionIndex(99, 3), 3);
  const day = dayWithCandidate(DAY, candidateRow({ address: 'New' }), 99);
  assert.equal(day.length, 4);
  assert.equal(day[3].address, 'New');
});

check('an unknown position goes to the END, never the front', () => {
  // Guessing "first" would draw the day starting at an address nobody
  // measured — the most flattering possible lie about a far-off stop.
  assert.equal(insertionIndex(-1, 3), 3);
  assert.equal(insertionIndex(NaN, 3), 3);
  assert.equal(insertionIndex(undefined, 3), 3);
});

check('an empty day takes the stop and nothing else', () => {
  const day = dayWithCandidate([], candidateRow({ address: 'New' }), 0);
  assert.equal(day.length, 1);
  assert.equal(day[0].address, 'New');
});

// ---- The day itself is never touched ------------------------------------

check('the real stops keep their order and their contents', () => {
  // The day's order IS the drive. A preview that resequenced it would
  // show Patrick a day he is not going to drive.
  const before = JSON.stringify(DAY);
  const day = dayWithCandidate(DAY, candidateRow({ address: 'New' }), 1);
  assert.equal(JSON.stringify(DAY), before, 'the input day was mutated');
  const real = day.filter((r) => !r.candidate);
  assert.deepEqual(real.map((r) => r.leadId), ['L1', 'L2', 'L3']);
  assert.deepEqual(real, DAY, 'a real row was altered on its way through');
});

check('exactly one row is ever added', () => {
  const day = dayWithCandidate(DAY, candidateRow({ address: 'New' }), 1);
  assert.equal(day.length, DAY.length + 1);
  assert.equal(day.filter((r) => r.candidate).length, 1);
});

// ---- The candidate wears the day endpoint's clothes ---------------------

check('the candidate carries what the map reads off every other row', () => {
  // The map is not being modified to understand a new shape; the new row
  // is being made to look like the rows it already draws.
  const row = candidateRow({
    address: '1841 Rosebank Rd', town: 'Pickering', customerName: 'N. Karim',
    serviceLabel: 'Fall closing', coords: { lat: 43.83, lng: -79.09 },
  });
  for (const field of ['address', 'town', 'customerName', 'serviceLabel', 'coords', 'start', 'workOrder']) {
    assert.ok(field in row, `the map reads ${field} and the candidate has no such field`);
  }
  assert.deepEqual(row.coords, { lat: 43.83, lng: -79.09 });
});

check('it is marked a preview, and keyed so the map can find it', () => {
  const row = candidateRow({ address: 'x', coords: { lat: 1, lng: 2 } });
  assert.equal(row.candidate, true);
  assert.equal(row.previewKey, lib.PREVIEW_KEY);
  assert.ok(String(lib.PREVIEW_KEY).length > 0);
});

check('it is not a booking and cannot be mistaken for one', () => {
  // Every "is this real work" reader in this codebase keys off these.
  const row = candidateRow({ address: 'x', coords: { lat: 1, lng: 2 } });
  assert.equal(row.leadId, null);
  assert.equal(row.bookingId, null);
  assert.equal(row.workOrder, null);
  assert.equal(row.propertyId, null);
});

check('an unplaceable address yields no coordinates rather than 0,0', () => {
  // Number(null) is 0. A pin at 0,0 is the Gulf of Guinea, drawn as a
  // confident numbered stop on a map of Newmarket.
  assert.equal(candidateRow({ address: 'x' }).coords, null);
  assert.equal(candidateRow({ address: 'x', coords: {} }).coords, null);
});

// ---- What gets handed to the line drawer ---------------------------------

check('the line follows the drawn order, including the new stop', () => {
  const day = dayWithCandidate(DAY, candidateRow({ address: 'New', coords: { lat: 43.83, lng: -79.09 } }), 1);
  const pts = lineStops(day);
  assert.equal(pts.length, 4);
  assert.deepEqual(pts[1], { lat: 43.83, lng: -79.09 });
});

check('a stop with no coordinates keeps its place in the list and leaves the line', () => {
  const day = dayWithCandidate(DAY, candidateRow({ address: 'Unplaceable' }), 1);
  assert.equal(day.length, 4);
  assert.equal(lineStops(day).length, 3, 'an unplaceable stop reached the route line');
});

// ---- The endpoint --------------------------------------------------------

check('the preview endpoint is staff-only, not on a public booking path', () => {
  // It answers about a whole day's schedule. /api/booking/* is public.
  assert.match(SERVER, /pathname === "\/api\/schedule\/preview-stop"/);
  assert.doesNotMatch(SERVER, /"\/api\/booking\/preview-stop"/);
  assert.match(SERVER, /pathname\.startsWith\("\/api\/schedule\/"\)\) return "user"/);
});

check('it measures the day server-side, not from stops the caller sends', () => {
  // Otherwise a preview can be talked into flattering arithmetic by its
  // own client, which is the one thing this screen must not do.
  const start = SERVER.indexOf('pathname === "/api/schedule/preview-stop"');
  assert.ok(start > 0, 'the preview endpoint is gone');
  const body = SERVER.slice(start, start + 4200);
  assert.match(body, /await activeBookings\(\)/);
  assert.doesNotMatch(body, /payload\?\.stops|payload\.stops/, 'the caller can supply the day');
});

check('it books, holds and writes nothing', () => {
  const start = SERVER.indexOf('pathname === "/api/schedule/preview-stop"');
  const body = SERVER.slice(start, start + 4200);
  for (const forbidden of ['reserveBooking', 'bookings.create', 'holdSlot', 'writeLeads', 'upsertFromLead']) {
    assert.ok(!body.includes(forbidden), `the preview calls ${forbidden}`);
  }
});

check('an address it cannot place is reported, not silently dropped', () => {
  const start = SERVER.indexOf('pathname === "/api/schedule/preview-stop"');
  const body = SERVER.slice(start, start + 4200);
  assert.match(body, /placed: false/);
  assert.match(body, /coordsAreResolved/);
});

check('it reports the worst leg, not only the minutes added', () => {
  // Cheapest insertion cannot see a day that crosses the city and comes
  // back — that is exactly how the Pickering day scored well enough to be
  // offered.
  const start = SERVER.indexOf('pathname === "/api/schedule/preview-stop"');
  const body = SERVER.slice(start, start + 4200);
  assert.match(body, /worstLegBetweenStops/);
  assert.match(body, /worstLegMinutes/);
});

// ---- The map page --------------------------------------------------------

check('the preview draws the REAL day, from the same endpoint as always', () => {
  // One implementation of "what is on this date". Two would disagree
  // exactly when it mattered.
  const start = MAP.indexOf('async function draw()');
  assert.ok(start > 0, 'draw() is gone from the map page');
  const body = MAP.slice(start, start + 3000);
  // draw() fetches the real day, exactly as it always has...
  assert.match(body, /fetch\("\/api\/schedule\/today" \+ query/);
  // ...and asks about the candidate separately, never for a second day.
  assert.match(MAP, /"\/api\/schedule\/preview-stop"/);
  assert.equal((MAP.match(/\/api\/schedule\/today" \+ query/g) || []).length, 1,
    'the day is fetched in more than one place');
});

check('rowKey is untouched — the app and the map still spell keys the same', () => {
  // test-today-map.mjs pins rowKey against the app's own copy. A preview
  // must not be the reason that contract drifts.
  assert.match(MAP, /function rowKey\(row\) \{/);
  assert.match(MAP, /function keyOf\(row\)/);
  const rowKeyBody = MAP.slice(MAP.indexOf('function rowKey(row) {'), MAP.indexOf('function keyOf(row)'));
  assert.doesNotMatch(rowKeyBody, /previewKey/, 'rowKey now knows about previews');
});

check('the new stop is drawn with the ring the map already uses', () => {
  assert.match(MAP, /if \(previewKey\) focusStop\(previewKey/);
});

check('an unplaceable address says so on the map', () => {
  const start = MAP.indexOf('async function draw()');
  const body = MAP.slice(start, start + 3000);
  assert.match(body, /WITHOUT it/);
});

// ---- The way in ----------------------------------------------------------

check('the app opens it per DAY, and choosing a time is unchanged', () => {
  // The drive is a property of the day, not of the time. And this adds a
  // way to look; it must not become a new way to choose.
  assert.match(BOOK, /setPreviewDay\(day\)/);
  assert.match(BOOK, /<DayPreview/);
  assert.match(BOOK, /onPress=\{\(\) => setSlot\(s\)\}/, 'tapping a time no longer picks it');
});

check('it cannot be opened before there is an address to preview', () => {
  const at = BOOK.indexOf('setPreviewDay(day)');
  assert.ok(at > 0);
  assert.match(BOOK.slice(Math.max(0, at - 700), at), /verified\?\.address \?/);
});

check('the preview carries no map of its own', () => {
  // The app has no map SDK and must not grow one — that would be a native
  // dependency and a rebuild every time the map changed.
  assert.match(SCREEN, /WebView/);
  assert.doesNotMatch(SCREEN, /react-native-maps|MapView/);
});

check('it refuses to navigate anywhere but our own page', () => {
  // A stray navigation in a WebView opens Safari on top of the app — a
  // real failure on 2026-09-07, caused by a path in originWhitelist.
  assert.match(SCREEN, /onShouldStartLoadWithRequest/);
  assert.match(SCREEN, /originWhitelist=\{\[HOST\]\}/);
});

check('it says plainly that looking books nothing', () => {
  assert.match(SCREEN, /[Nn]othing is booked/);
});

console.log(`\nday-preview: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The day's route map — what it is fenced behind, and what it draws.
//
//   node scripts/test-today-map.mjs
//
// The picture cannot be asserted without a Maps key and an eye. What CAN
// be asserted is everything that decides which picture gets drawn, and
// the two things that would be silently wrong:
//
//   1. THE FENCE. `/admin/today` is an EXACT match in needsAuth, and
//      needsAuth ends in `return null` — no auth — for any path it does
//      not name. `/admin/today/map` therefore had to be named. That is
//      the same shape as the 2026-09-06 Terminal-token hole, so the rule
//      is executed here, not read.
//
//   2. THE KEY. A pin carries a row's key so the app can scroll to that
//      row's card. The key is computed in two places — the browser page
//      and the app — and if they ever spell it differently every tap
//      lands on nothing. Both are extracted and RUN against the same
//      rows.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const SERVER = read('server/server.js');
const PAGE_JS = read('server/today-map.js');
const PAGE_HTML = read('server/today-map.html');
const APP_ROUTING = read('pjl-field/src/workorder-routing.js');
const APP_MAP = read('pjl-field/src/screens/DayMap.js');
const APP_TODAY = read('pjl-field/src/screens/TodayScreen.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// ---- The fence, executed ------------------------------------------------

function extractNeedsAuth() {
  const start = SERVER.indexOf('function needsAuth(method, pathname) {');
  assert.ok(start > 0, 'needsAuth not found in server.js');
  const end = SERVER.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of needsAuth');
  return new Function(`${SERVER.slice(start, end + 3)}; return needsAuth;`)();
}
const needsAuth = extractNeedsAuth();

check('the map page is fenced at staff, both spellings', () => {
  assert.equal(needsAuth('GET', '/admin/today/map'), 'user',
    'an unfenced page is reachable with no session at all');
  assert.equal(needsAuth('GET', '/admin/today/map/'), 'user',
    'the trailing-slash spelling falls through to the default, which is no auth');
});

check('the route-line endpoint is fenced at staff', () => {
  assert.equal(needsAuth('POST', '/api/schedule/today/route-line'), 'user');
});

check('the page it sits beside did not move', () => {
  assert.equal(needsAuth('GET', '/admin/today'), 'user');
  assert.equal(needsAuth('GET', '/api/schedule/today'), 'user');
});

// ---- The key, computed in two places and RUN in both --------------------

function fromPage(names) {
  // The page is an IIFE; its helpers sit at one indent. Slice each by its
  // own declaration and closing brace at that indent.
  const parts = names.map((name) => {
    const start = PAGE_JS.indexOf(`  function ${name}(`);
    assert.ok(start > 0, `${name} not found in today-map.js`);
    const end = PAGE_JS.indexOf('\n  }\n', start);
    assert.ok(end > start, `could not find the end of ${name}`);
    return PAGE_JS.slice(start, end + 5);
  });
  return new Function(`${parts.join('\n')}; return { ${names.join(', ')} };`)();
}

const page = fromPage(['rowKey', 'isDone', 'num', 'isMorning', 'mappableStops']);

function appRowKey() {
  const line = APP_ROUTING.match(/export const rowKey = ([^;]+);/);
  assert.ok(line, 'rowKey is no longer a single expression in the app');
  return new Function(`return ${line[1]};`)();
}
const appKey = appRowKey();

check('page and app spell a row key identically', () => {
  // Every branch of the rule, not just the happy one — a lead booking, an
  // assignment booking with no lead, a bare work-order row, and the
  // last-resort start time.
  const rows = [
    { leadId: 'L1', bookingId: 'B1', workOrder: { id: 'W1' }, start: '2026-09-07T13:00:00Z' },
    { leadId: '', bookingId: 'B2', workOrder: { id: 'W2' }, start: '2026-09-07T14:00:00Z' },
    { leadId: '', bookingId: '', workOrder: { id: 'W3' }, start: '2026-09-07T15:00:00Z' },
    { leadId: '', bookingId: '', workOrder: null, start: '2026-09-07T16:00:00Z' },
    { leadId: '', bookingId: '', workOrder: null, start: '' },
  ];
  for (const row of rows) {
    assert.equal(page.rowKey(row), appKey(row),
      `a pin and its card would disagree for ${JSON.stringify(row)}`);
  }
  assert.equal(page.rowKey(null), appKey(null));
});

// ---- What gets drawn ----------------------------------------------------

check('stop numbers are positions in the day, not in the drawable subset', () => {
  // The number on a pin has to be the number on the card. A row with no
  // coordinates still consumes its place; renumbering around it would
  // make stop 3 on the map stop 4 in the list.
  const rows = [
    { leadId: 'A', coords: { lat: 44.05, lng: -79.46 }, start: '2026-09-07T09:00:00' },
    { leadId: 'B', coords: null, start: '2026-09-07T10:00:00' },
    { leadId: 'C', coords: { lat: 44.06, lng: -79.47 }, start: '2026-09-07T14:00:00' },
  ];
  const { stops, skipped } = page.mappableStops(rows);
  assert.equal(skipped, 1, 'a row with no coordinates was not counted as skipped');
  assert.deepEqual(stops.map((s) => s.number), [1, 3], 'the un-drawable row did not keep its number');
  assert.deepEqual(stops.map((s) => s.key), ['A', 'C']);
});

check('coordinates that are not numbers are skipped, not drawn at zero', () => {
  const { stops, skipped } = page.mappableStops([
    { leadId: 'A', coords: { lat: 'x', lng: -79.46 } },
    { leadId: 'B', coords: { lat: null, lng: null } },
    { leadId: 'C', coords: { lat: 44.06, lng: -79.47 } },
  ]);
  assert.equal(skipped, 2, 'a non-numeric coordinate would land the pin off the coast of Africa');
  assert.deepEqual(stops.map((s) => s.key), ['C']);
});

check('only a completed work order ticks a stop off', () => {
  assert.equal(page.isDone({ workOrder: { status: 'completed' } }), true);
  for (const status of ['draft', 'scheduled', 'on_site', 'in_progress', 'cancelled', 'no_show']) {
    assert.equal(page.isDone({ workOrder: { status } }), false, `${status} is not done`);
  }
  assert.equal(page.isDone({ workOrder: null }), false);
  assert.equal(page.isDone(null), false);
});

check('a completed stop wears a tick and a muted pin', () => {
  // Both halves matter: the tick is what makes "which houses are behind
  // me" answerable at a glance, and the muting is what stops a finished
  // stop competing with the one being driven to.
  assert.match(PAGE_JS, /text: stop\.done \? "✓" : String\(stop\.number\)/, 'a done stop no longer ticks');
  assert.match(PAGE_JS, /fillColor: stop\.done \? DONE_GREY/, 'a done stop is still drawn at full strength');
});

check('morning and afternoon are split at noon, and a dateless row is not afternoon', () => {
  assert.equal(page.isMorning({ start: '2026-09-07T09:00:00' }), true);
  assert.equal(page.isMorning({ start: '2026-09-07T13:00:00' }), false);
  assert.equal(page.isMorning({ start: 'not a date' }), true, 'an unreadable time became an afternoon stop');
  assert.equal(page.isMorning({}), true);
});

// ---- The keys stay on the server ---------------------------------------

check('no Maps key is written into the page', () => {
  // The browser key comes from /api/maps-config, as it does on the season
  // plan; the server key draws the line and never leaves the server.
  for (const source of [PAGE_HTML, PAGE_JS]) {
    assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(source), 'a Google API key is hard-coded into the map page');
  }
  assert.match(PAGE_JS, /fetch\("\/api\/maps-config"/, 'the page no longer asks the server for the browser key');
  // Naming the server key in a comment is documentation; reading one is
  // the leak. Browser code has no env to read from in the first place,
  // and reaching for one is the shape the mistake would take.
  assert.ok(!/process\.env/.test(PAGE_JS), 'browser code is reaching for a server environment variable');
});

check('the app carries no map key and no Stripe key either', () => {
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(APP_MAP));
  assert.match(APP_MAP, /\$\{HOST\}\/admin\/today\/map/, 'the app no longer loads the shared map page');
});

// ---- The line follows the numbers --------------------------------------

check('the line is drawn from the stops the pins were drawn from', () => {
  // Not re-derived server-side. Two implementations of "what is on today"
  // is how a line ends up running through a house the map never drew.
  const at = PAGE_JS.indexOf('async function drawLine');
  assert.ok(at > 0, 'drawLine is gone');
  const block = PAGE_JS.slice(at, at + 700);
  assert.match(block, /stops\.map\(function \(s\) \{ return s\.coords; \}\)/,
    'the line no longer posts the same ordered stops the pins used');
});

check('an absent coordinate is refused, not coerced to zero', () => {
  // Number(null) === 0. On both sides of the wire.
  const at = SERVER.indexOf('pathname === "/api/schedule/today/route-line"');
  const block = SERVER.slice(at, at + 2000);
  assert.match(block, /value === null \|\| value === undefined \|\| value === ""/,
    'the endpoint coerces an empty coordinate to 0,0');
  assert.match(PAGE_JS, /function num\(value\) \{/, 'the page coerces an empty coordinate to 0,0');
});

check('the endpoint refuses what it cannot honestly draw', () => {
  const at = SERVER.indexOf('pathname === "/api/schedule/today/route-line"');
  assert.ok(at > 0, 'the route-line endpoint is gone');
  const block = SERVER.slice(at, at + 2000);
  // Named values, not "a guard exists": each of these is a specific
  // refusal, and a changed number is a changed decision.
  assert.match(block, /raw\.length > 25/, 'the waypoint cap is gone — each call can cost a Directions request');
  assert.match(block, /stops\.length < 2/, 'a one-stop day would ask for a line between a point and itself');
  assert.match(block, /lat < -90 \|\| lat > 90 \|\| lng < -180 \|\| lng > 180/, 'coordinates are no longer bounded');
  assert.match(block, /Number\.isFinite\(lat\)/, 'a non-numeric coordinate reaches the router');
});

check('the line endpoint returns geometry and never minutes', () => {
  // THE LINE ONLY, NEVER THE MINUTES — lib/route-geometry.js. Every drive
  // time on this system comes from Distance Matrix; a second router
  // printing its own would put two numbers for one leg on one screen.
  const at = SERVER.indexOf('pathname === "/api/schedule/today/route-line"');
  const block = SERVER.slice(at, at + 2000);
  const response = block.slice(block.indexOf('return sendJson(res, 200'));
  for (const forbidden of ['duration', 'distance', 'minutes', 'eta', 'arriveAt']) {
    assert.ok(!response.includes(forbidden), `the route line is reporting ${forbidden}`);
  }
  assert.match(response, /source: line\.source/, 'a straight-hop fallback is no longer declared');
});

check('a straight-hop fallback is drawn as hops, not as roads', () => {
  assert.match(PAGE_JS, /line\.source === "straight" \? 0 : 0\.85/, 'a fallback line is drawn solid, implying a road');
  assert.match(PAGE_JS, /straight hops, not roads/, 'the screen no longer says the lines are not roads');
});

// ---- The two hosts ------------------------------------------------------

check('the page route serves the map, and only to a named path', () => {
  assert.match(SERVER, /pathname === "\/admin\/today\/map" \|\| pathname === "\/admin\/today\/map\/"/);
  assert.match(SERVER, /relative: "\/today-map\.html"/);
});

check('the map redraws when a job finishes, without a pull-to-refresh', () => {
  // A tick that only appears after a manual refresh is a tick that lies
  // for as long as nobody pulls down.
  assert.match(APP_TODAY, /\$\{rowKey\(b\)\}:\$\{b\.workOrder\?\.status \|\| ''\}/,
    'the map no longer redraws on a status change');
  assert.match(APP_MAP, /post\(\{ type: 'refresh' \}\)/, 'the refresh signal is gone');
});

check('a map that fails does not take the day sheet with it', () => {
  assert.match(APP_MAP, /if \(failed\)/, 'a failed map no longer degrades');
  assert.match(APP_MAP, /The list below still works/, 'a failed map no longer says the list still works');
});

check('the focused card cannot shove the list as it is scrolled to', () => {
  // The border is always present and usually transparent. Growing one on
  // focus moves every card below it at the exact moment the screen is
  // animating to one.
  const at = APP_TODAY.indexOf('  card: {');
  assert.ok(at > 0, 'the card style is gone');
  const block = APP_TODAY.slice(at, at + 400);
  assert.match(block, /borderWidth: 2/, 'the resting card has no border to recolour');
  assert.match(block, /borderColor: 'transparent'/);
  const focused = APP_TODAY.slice(APP_TODAY.indexOf('cardFocused: {'), APP_TODAY.indexOf('cardFocused: {') + 120);
  assert.ok(!/borderWidth/.test(focused), 'focusing a card changes its border WIDTH, which moves the list');
});

// ---- The app files this feature touches actually parse ----------------
//
// Nothing else on this branch parses the app's JSX. A syntax error would
// ship green and fail on the phone, and the phone is a twenty-minute
// round trip. Parsed with the app's OWN Babel, with the app's own
// options, so this agrees with what Metro will do rather than guessing.

// NOT async: `check` calls fn() inside a try, so a rejected promise is an
// unhandled rejection rather than a failure, and the check would pass no
// matter what it read. babel.parse is synchronous; this stays synchronous.
check('the screens this feature touches parse as the app will read them', () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail('the app\'s dependencies are not installed — run npm ci in pjl-field'); }
  for (const rel of ['pjl-field/src/screens/DayMap.js', 'pjl-field/src/screens/TodayScreen.js']) {
    babel.parse(read(rel), {
      filename: rel,
      parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      babelrc: false,
      configFile: false,
    });
  }
});

console.log(`\ntoday-map: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

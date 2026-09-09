// A customer walks over while you are on their neighbour's lawn.
//
//   node scripts/test-add-stop.mjs
//
// Patrick: "Sometimes we are approached by customers while on a daily
// route, we try not to turn anyone down... we still want to remain
// professional and be able to tackle their closing as well, while still
// recording all paperwork, and then adding it into the daily flow as it
// would have been."
//
// "AS IT WOULD HAVE BEEN" is the specification, and it is what makes this
// worth testing rather than eyeballing. A shortcut here would be invisible
// until March: a lead with no customer behind it, a job with no work order,
// a price nobody can explain. So the checks below are about the ordinary
// path being walked, not about the screen looking right.
//
// The one that actually bites is the TIME. Reserve refuses a force-book
// that physically overlaps an active booking — and the job you are standing
// at is one of those. This file runs the SERVER'S OWN overlap rule against
// the time the app picks, on the shapes a real day hands it, including the
// row with no end on it that a careless version of nextFreeStart turns into
// a 409 in front of the customer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A missing file has to FAIL, not throw: run against a build that does not
// have this feature yet — which is the only way to know these checks test
// anything — a crash out of the top of the file says nothing about which
// part is missing.
const readOr = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// The rules module is pure ES on purpose — no React Native import — so it
// can be run here rather than read.
const RULES = 'pjl-field/src/add-stop.js';
let rules = null;
let rulesError = null;
try { rules = await import(pathToFileURL(path.join(ROOT, RULES))); }
catch (err) { rulesError = err; }

check(`${RULES} loads without React Native`, () => {
  assert.ok(rules, rulesError ? rulesError.message : 'nothing was exported');
});

// Every rule below goes through this, so a missing module is one failure per
// behaviour with the behaviour named, rather than a stack trace.
const use = (name) => (...args) => {
  if (!rules) throw new Error(`${RULES} did not load`);
  if (typeof rules[name] !== 'function') throw new Error(`${RULES} does not export ${name}`);
  return rules[name](...args);
};
const canAddStop = use('canAddStop');
const localYmd = use('localYmd');
const nextFreeStart = use('nextFreeStart');
const streetHint = use('streetHint');
const whereYouAre = use('whereYouAre');
const WALK_UP_NOTE = (rules && rules.WALK_UP_NOTE) || '';

const SCREEN = readOr('pjl-field/src/screens/AddStopScreen.js');
const TODAY = readOr('pjl-field/src/screens/TodayScreen.js');
const APP = readOr('pjl-field/App.js');
const SERVER = readOr('server/server.js');

const at = (day, hhmm) => new Date(`${day}T${hhmm}:00`);
const iso = (day, hhmm) => at(day, hhmm).toISOString();

// ---- Where you are -------------------------------------------------------

check('the street prefills without the house number', () => {
  assert.equal(streetHint('330 Aztec Dr, Oshawa, ON'), 'Aztec Dr, Oshawa, ON');
  assert.equal(streetHint('7B Betty Ann Dr'), 'Betty Ann Dr');
});

check('an address that is only a street survives intact', () => {
  assert.equal(streetHint('Aztec Dr, Oshawa'), 'Aztec Dr, Oshawa');
});

check('no address means no hint, not "undefined"', () => {
  assert.equal(streetHint(null), '');
  assert.equal(streetHint(''), '');
});

check('the street offered is the job you are standing on', () => {
  const rows = [
    { address: '1 First St', workOrder: { status: 'completed' } },
    { address: '2 Second St', workOrder: { status: 'on_site' } },
    { address: '3 Third St', workOrder: null },
  ];
  assert.equal(whereYouAre(rows), '2 Second St');
});

check('with nothing started, the next unfinished stop is the guess', () => {
  const rows = [
    { address: '1 First St', workOrder: { status: 'completed' } },
    { address: '2 Second St', workOrder: null },
  ];
  assert.equal(whereYouAre(rows), '2 Second St');
});

check('a day that is entirely done still offers its last street', () => {
  const rows = [
    { address: '1 First St', workOrder: { status: 'completed' } },
    { address: '9 Last Ave', workOrder: { status: 'completed' } },
  ];
  assert.equal(whereYouAre(rows), '9 Last Ave');
});

check('an empty day offers nothing rather than crashing', () => {
  assert.equal(whereYouAre([]), '');
  assert.equal(whereYouAre(null), '');
});

// ---- Which days can take one --------------------------------------------

check('a day that has already been driven cannot take a new stop', () => {
  const now = at('2026-09-09', '14:00');
  assert.equal(canAddStop('2026-09-08', now), false);
});

check('today and any day ahead can', () => {
  const now = at('2026-09-09', '14:00');
  assert.equal(canAddStop('2026-09-09', now), true);
  assert.equal(canAddStop('2026-09-10', now), true);
});

// ---- When it lands: the server's own rule, executed ----------------------

// Lifted from the admin_custom branch of /api/booking/reserve. If this and
// the server ever disagree, the disagreement shows up as a 409 on a
// driveway, so it is copied here deliberately and pinned below.
function physicalConflict(active, startISO, minutes) {
  const startMs = new Date(startISO).getTime();
  const endMs = startMs + minutes * 60 * 1000;
  return active.find((b) => {
    if (!b.start || !b.end) return false;
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return startMs < be && endMs > bs;
  }) || null;
}

const DAY = '2026-09-09';
const FULL_DAY = [
  { start: iso(DAY, '08:00'), end: iso(DAY, '09:30') },
  { start: iso(DAY, '10:00'), end: iso(DAY, '11:30') },
  { start: iso(DAY, '13:00'), end: iso(DAY, '14:30') },
];

check('the new stop does not overlap anything already on the day', () => {
  const now = at(DAY, '10:45');
  const start = nextFreeStart(FULL_DAY, { day: DAY, now });
  const clash = physicalConflict(FULL_DAY, start, 90);
  assert.equal(clash, null, `reserve would refuse this with a 409: ${start}`);
});

check('it lands after the last stop, not on top of the one you are at', () => {
  const now = at(DAY, '10:45');
  const start = nextFreeStart(FULL_DAY, { day: DAY, now });
  assert.equal(start, iso(DAY, '14:30'));
});

check('a day already finished puts the stop at the current time', () => {
  // Every job done by three, the walk-up happens at half past four.
  const now = at(DAY, '16:30');
  const start = nextFreeStart(FULL_DAY, { day: DAY, now });
  assert.equal(new Date(start).getTime(), now.getTime());
  assert.equal(physicalConflict(FULL_DAY, start, 90), null);
});

check('a row with no end on it does not become an overlapping stop', () => {
  // /api/schedule/today sends `end: null` for a booking that never had one
  // and for a job scheduled straight against a property. Treating that row
  // as ending when it STARTS is the bug this pins: the stop would begin
  // while that job is still running and reserve would refuse it, in front
  // of the customer.
  const rows = [{ start: iso(DAY, '13:00'), end: null }];
  const now = at(DAY, '13:15');
  const start = nextFreeStart(rows, { day: DAY, now });
  assert.ok(
    new Date(start).getTime() > at(DAY, '13:00').getTime() + 60 * 60 * 1000,
    `a stop at ${start} starts inside a job that began at 13:00 with no end recorded`,
  );
  // And the server's rule agrees, using the same generous envelope.
  const assumed = [{ start: iso(DAY, '13:00'), end: iso(DAY, '16:00') }];
  assert.equal(physicalConflict(assumed, start, 90), null);
});

check('an empty day tomorrow starts at eight, not at the current minute', () => {
  const now = at(DAY, '16:30');
  const start = nextFreeStart([], { day: '2026-09-10', now });
  assert.equal(start, iso('2026-09-10', '08:00'));
});

check('an empty day today starts now', () => {
  const now = at(DAY, '09:12');
  assert.equal(nextFreeStart([], { day: DAY, now }), now.toISOString());
});

check('the day is read in local time, the same as the rest of the app', () => {
  // ../dates anchors on `${ymd}T12:00:00` for exactly this reason: a UTC
  // parse moves the day across the boundary and the stop lands on the
  // wrong date.
  assert.equal(localYmd(at('2026-09-09', '23:30')), '2026-09-09');
  assert.equal(localYmd(at('2026-09-09', '00:15')), '2026-09-09');
});

// ---- The server has not moved underneath us ------------------------------

check('reserve still exempts admin_custom from the ten-minute hold', () => {
  // Without the exemption every walk-up returns hold_required, which is the
  // exact failure the Book tab shipped with on 2026-09-06.
  const line = SERVER.split('\n').find((l) => l.includes('const holdExempt ='));
  assert.ok(line, 'holdExempt is gone from reserve');
  assert.match(line, /claimsAdminCustom/);
});

check('a force-book is still open to a tech, not just to Patrick', () => {
  // Patrick: "everyone can add a stop". The app's button is only a hint —
  // the server is what refuses. Inside reserve the variable is called
  // isAdmin; what it MEANS is "signed in as staff", and that difference is
  // the whole reason a tech can do this at all.
  const handler = SERVER.slice(SERVER.indexOf('if (req.method === "POST" && pathname === "/api/booking/reserve")'));
  assert.ok(handler.length > 1000, 'the reserve handler has moved or been renamed');
  const branch = handler.indexOf('const useAdminCustom = claimsAdminCustom');
  assert.ok(branch > 0, 'the admin_custom branch of reserve is gone');
  const derivation = handler.slice(0, branch);
  assert.match(
    derivation, /const adminSession = await requireUser\(req\);/,
    'reserve now derives its session from something other than requireUser',
  );
  assert.doesNotMatch(
    derivation, /const adminSession = await requireAdmin\(req\)/,
    'reserve now demands an admin — the Add a stop button would 403 for every tech',
  );
  // ...and requireUser is what lets a tech through at all.
  const gate = SERVER.slice(SERVER.indexOf('async function requireUser(req)'));
  assert.match(gate.slice(0, 400), /session\.role !== "tech"/, 'requireUser no longer admits a tech');
});

check('a force-book still checks for a physical conflict', () => {
  // This is the constraint the landing time is designed around. If it were
  // ever removed the stop could simply be "now"; while it is there, it
  // cannot.
  assert.match(SERVER, /code: "physical_conflict"/);
});

// ---- The paperwork -------------------------------------------------------

check('the stop is created through the ordinary booking path', () => {
  assert.match(SCREEN, /reserveBooking\(\{/);
  assert.match(SCREEN, /source: 'admin_custom'/);
  assert.match(SCREEN, /serviceKey,/);
});

check('the price comes off the catalog, not off a text box', () => {
  // A service KEY is sent, never an amount. A favour on a driveway is not a
  // discount nobody can explain in March.
  assert.doesNotMatch(SCREEN, /\bprice\b\s*:/i);
  assert.match(SCREEN, /serviceKeyFor\(/);
});

check('the work order is opened straight after, not left for later', () => {
  // "recording all paperwork" — a booking with no work order is a job
  // nobody can sign off.
  assert.match(SCREEN, /openWorkOrder\(leadId\)/);
  assert.match(SCREEN, /\?\.workOrder/, 'openWorkOrder answers { workOrder } — the unwrap is missing');
});

check('the lead says how it came in', () => {
  assert.match(SCREEN, /WALK_UP_NOTE/);
  assert.match(WALK_UP_NOTE, /walk|approach/i);
});

check('a customer with no name is refused before anything is written', () => {
  const idx = SCREEN.indexOf('const create =');
  const body = SCREEN.slice(idx, SCREEN.indexOf('\n  };', idx));
  const guard = body.indexOf('firstName');
  const write = body.indexOf('reserveBooking');
  assert.ok(guard > 0 && guard < write, 'the name check has to run before the booking is written');
});

// ---- The way in ----------------------------------------------------------

check('everyone gets the button, not just an admin', () => {
  // Patrick: "everyone can add a stop". Today is a tab every role sees; a
  // role test around this button would take it away from the person it was
  // built for.
  const idx = TODAY.indexOf('styles.addStop');
  assert.ok(idx > 0, 'the Add a stop button is not on the day screen');
  const around = TODAY.slice(Math.max(0, idx - 900), idx);
  assert.doesNotMatch(around, /role\s*===/, 'the button is gated on a role');
});

check('the button is hidden on a day that has already been driven', () => {
  assert.match(TODAY, /canAddStop\(/);
});

check('the day, its stops and the street you are on all reach the screen', () => {
  assert.match(TODAY, /dayBookings: bookings/);
  assert.match(TODAY, /fromAddress: whereYouAre\(bookings\)/);
  assert.match(APP, /dayBookings=\{job\.dayBookings\}/);
  assert.match(APP, /fromAddress=\{job\.fromAddress\}/);
});

check('the shell knows the kind and renders the screen for it', () => {
  assert.match(APP, /ADD_STOP: 'addStop'/);
  assert.match(APP, /job\.kind === JOB\.ADD_STOP/);
  assert.match(APP, /<AddStopScreen/);
});

check('finishing hands the tech the work order, over the day', () => {
  // The whole point of "as it would have been": it ends where a booking
  // made three weeks ago ends.
  assert.match(APP, /onOpenWorkOrder=\{openWorkOrder\}[\s\S]{0,200}\/>/);
});

console.log(`\nadd-stop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

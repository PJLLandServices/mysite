// The field app's shell, after Work and Invoices stopped being tabs.
//
//   node scripts/test-app-shell.mjs
//
// Two tabs were removed and what they did moved: a work order is now
// reached from the day or from the address and laid OVER the tabs, and
// invoices belong to the property. Three things can go quietly wrong in
// that move, and each is executed here rather than read:
//
//   1. A tab that still exists in the bar but has no screen behind it,
//      or a screen still trying to reach a tab that is gone.
//   2. The button on the day's card saying the wrong one of its three
//      things — "Open WO" on a half-finished closing was the old bug.
//   3. "Overdue", which the SERVER DOES NOT HAVE. Its statuses are
//      draft / sent / partially_paid / paid / void. Overdue is derived,
//      and a derived rule that lives in two places is a red badge that
//      disagrees with a total.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('pjl-field/App.js');
const API = read('pjl-field/src/api.js');
const ROUTING = read('pjl-field/src/workorder-routing.js');
const PROPERTY = read('pjl-field/src/screens/PropertyProfileScreen.js');
const TODAY = read('pjl-field/src/screens/TodayScreen.js');
const UI = read('pjl-field/src/ui.js');
const SERVER = read('server/server.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// Lifts an exported function out of an app source file and RUNS it. The
// app's modules import React Native, so they cannot be imported here;
// these particular functions are pure and deliberately kept that way.
function lift(source, name, deps = '') {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `${name} is not an exported function`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  const body = source.slice(start, end + 3).replace('export function', 'function');
  return new Function(`${deps}\n${body}\nreturn ${name};`)();
}

// ---- The tab bar ---------------------------------------------------------

function tabKeys() {
  const start = APP.indexOf('const TABS = [');
  assert.ok(start > 0, 'TABS is gone from App.js');
  const end = APP.indexOf('];', start);
  const block = APP.slice(start, end);
  return [...block.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
}

check('the bar carries exactly the tabs that have screens', () => {
  assert.deepEqual(tabKeys(), ['today', 'properties', 'messages']);
});

check('nothing is left reaching for the tabs that went', () => {
  // The specific rot: a screen calling select('work'), or the shell still
  // holding the constant the Work tab landed on.
  assert.ok(!/select\('work'\)/.test(APP), "something still switches to a 'work' tab");
  assert.ok(!/select\('invoices'\)/.test(APP), "something still switches to an 'invoices' tab");
  assert.ok(!/WORK_LIST/.test(APP), 'the Work tab landing constant survived its tab');
  assert.ok(!/'\/admin\/invoices'/.test(APP), 'the invoices web page is still wired to a tab');
  assert.ok(!/'\/admin\/work-orders'/.test(APP), 'the work-orders web page is still wired to a tab');
});

check('every tab in the bar is rendered by the shell', () => {
  // A tab that renders nothing is a blank screen with a highlighted icon.
  for (const key of tabKeys()) {
    const rendered = key === 'messages'
      ? /<WebScreen path=\{tab\.path\} \/>/.test(APP)   // the fallback arm
      : new RegExp(`tab\\.key === '${key}'`).test(APP);
    assert.ok(rendered, `the ${key} tab has no branch that renders it`);
  }
});

// ---- The open job, executed ---------------------------------------------

check('a work order becomes the right kind of job', () => {
  const jobForWorkOrder = lift(APP, 'jobForWorkOrder', "const JOB = { CLOSING: 'closing', WEB: 'web', INVOICE: 'invoice' };");

  assert.deepEqual(
    jobForWorkOrder({ id: 'WO-1', type: 'fall_closing' }),
    { kind: 'closing', workOrderId: 'WO-1' },
    'a fall closing no longer opens the native flow',
  );
  assert.deepEqual(
    jobForWorkOrder({ id: 'WO-2', type: 'service_visit' }),
    { kind: 'web', url: '/admin/work-order/WO-2/tech', title: 'Work order' },
  );
  // Ids are not always tidy. An unencoded one would 404 on a driveway.
  assert.equal(
    jobForWorkOrder({ id: 'WO 3/x', type: 'service_visit' }).url,
    '/admin/work-order/WO%203%2Fx/tech',
  );
  // Nothing to open is not a job. Returning one would lay an empty
  // overlay over the tabs with no way back.
  assert.equal(jobForWorkOrder(null), null);
  assert.equal(jobForWorkOrder({}), null);
  assert.equal(jobForWorkOrder({ type: 'fall_closing' }), null, 'a work order with no id became a job');
});

check('the overlay covers the tab bar and every arm has a way out', () => {
  // Mid-closing, switching tabs is not a thing anyone means to do — and
  // the old arrangement let you, then hid where the closing went.
  assert.match(APP, /overlay: \{ \.\.\.StyleSheet\.absoluteFillObject/, 'the job overlay no longer covers the shell');
  const at = APP.indexOf('{job ? (');
  assert.ok(at > 0, 'the job overlay is gone');
  const block = APP.slice(at, APP.indexOf('const styles', at));
  for (const exit of ['onExit={closeJob}', 'onBack={closeJob}']) {
    assert.ok(block.includes(exit), `an overlay arm has no exit: expected ${exit}`);
  }
  assert.match(block, /<WebScreen path=\{job\.url\} onBack=\{closeJob\}/, 'the web work order is a trap door again');
});

// ---- The card's three states --------------------------------------------

check('the day card names all three states of a work order', () => {
  const label = lift(ROUTING, 'workOrderActionLabel', `
    const TERMINAL = ['completed', 'cancelled', 'no_show'];
    const isOpenWorkOrder = (wo) => !!wo && !TERMINAL.includes(wo.status);
  `);
  assert.equal(label({}), 'Start WO', 'a row with no work order');
  assert.equal(label({ workOrder: { status: 'draft' } }), 'Resume');
  assert.equal(label({ workOrder: { status: 'on_site' } }), 'Resume');
  assert.equal(label({ workOrder: { status: 'in_progress' } }), 'Resume');
  // The old bug: these three read "Open WO", the same as a live one.
  assert.equal(label({ workOrder: { status: 'completed' } }), 'Open work order');
  assert.equal(label({ workOrder: { status: 'cancelled' } }), 'Open work order');
  assert.equal(label({ workOrder: { status: 'no_show' } }), 'Open work order');
  assert.equal(label(null), 'Start WO');
});

check('the screen uses that label rather than its own', () => {
  assert.match(TODAY, /label=\{workOrderActionLabel\(b\)\}/, 'the card computes its own label again');
  assert.ok(!/label=\{b\.workOrder \? 'Open WO'/.test(TODAY), 'the two-state label survived');
});

check('a finished job is dimmed, not deleted', () => {
  assert.match(TODAY, /isFinishedRow\(b\) && styles\.cardDone/, 'a completed job no longer reads as done');
  assert.match(TODAY, /cardDone: \{ opacity: 0\.72 \}/);
});

// ---- Overdue is derived, in exactly one place ---------------------------

check('overdue is decided by one rule, and the rule is right', () => {
  const isOverdue = lift(API, 'isOverdue', 'const OVERDUE_AFTER_DAYS = 14;');
  const now = Date.parse('2026-09-30T12:00:00Z');
  const long = '2026-09-01T12:00:00Z';   // 29 days before `now`
  const recent = '2026-09-25T12:00:00Z'; // 5 days before `now`

  assert.equal(isOverdue({ sentAt: long, balanceDue: 285, status: 'sent' }, now), true);
  assert.equal(isOverdue({ sentAt: recent, balanceDue: 285, status: 'sent' }, now), false,
    'inside the grace period is not overdue');
  // Never sent is never overdue — a draft nobody has been asked to pay.
  assert.equal(isOverdue({ sentAt: null, balanceDue: 285, status: 'draft' }, now), false);
  // Nothing owed is nothing overdue, whatever the dates say.
  assert.equal(isOverdue({ sentAt: long, balanceDue: 0, status: 'paid' }, now), false);
  assert.equal(isOverdue({ sentAt: long, balanceDue: 285, status: 'paid' }, now), false);
  assert.equal(isOverdue({ sentAt: long, balanceDue: 285, status: 'void' }, now), false,
    'a voided invoice was chased');
  // Garbage in, false out — never a red badge from an unparseable date.
  assert.equal(isOverdue({ sentAt: 'whenever', balanceDue: 285, status: 'sent' }, now), false);
  assert.equal(isOverdue(null, now), false);
});

check('no screen invents a second overdue rule', () => {
  // Two definitions is how a badge starts disagreeing with a total.
  assert.match(PROPERTY, /isOverdue\(inv\)/, 'the property screen no longer uses the shared rule');
  assert.ok(
    !/sentAt[\s\S]{0,120}24 \* 60 \* 60 \* 1000/.test(PROPERTY),
    'the property screen is computing its own overdue window',
  );
});

check('the status labels match the statuses the server can actually send', () => {
  // Five, from lib/invoices.js. `overdue` is not one of them, and a label
  // map that carries it would be dressing a value that never arrives.
  const at = PROPERTY.indexOf('const INVOICE_STATUS_LABELS = {');
  assert.ok(at > 0, 'the invoice label map is gone');
  const block = PROPERTY.slice(at, PROPERTY.indexOf('};', at));
  for (const status of ['draft', 'sent', 'partially_paid', 'paid', 'void']) {
    assert.ok(block.includes(`${status}:`), `no label for the real status ${status}`);
  }
  assert.ok(!block.includes('overdue:'), 'overdue is being treated as a status the server sends');
  assert.match(read('server/lib/invoices.js'),
    /const STATUSES = \["draft", "sent", "partially_paid", "paid", "void"\];/,
    'the server\'s status set changed — the app\'s labels need revisiting');
});

// ---- Which invoice gets chased ------------------------------------------

check('the payment link names one invoice, and it is the oldest owing', () => {
  const invoiceToChase = lift(PROPERTY, 'invoiceToChase');
  const owing = { id: 'I-2', status: 'sent', balanceDue: 285, createdAt: '2026-04-01T00:00:00Z' };
  const newer = { id: 'I-3', status: 'sent', balanceDue: 100, createdAt: '2026-09-01T00:00:00Z' };
  const paid = { id: 'I-1', status: 'paid', balanceDue: 0, createdAt: '2026-01-01T00:00:00Z' };
  const voided = { id: 'I-0', status: 'void', balanceDue: 900, createdAt: '2025-01-01T00:00:00Z' };

  assert.equal(invoiceToChase([paid, newer, owing, voided])?.id, 'I-2',
    'the oldest unpaid invoice is not the one being chased');
  assert.equal(invoiceToChase([paid, voided]), null, 'a fully-paid address offered a chase button');
  assert.equal(invoiceToChase([]), null);
  assert.equal(invoiceToChase(null), null);
  // A void invoice with a balance is the trap: it looks owed and is not.
  assert.equal(invoiceToChase([voided]), null, 'a voided invoice was chased');
});

check('the chase button says which invoice it will send', () => {
  assert.match(PROPERTY, /Text a payment link — \$\{chase\.id\}/,
    'the button no longer names the invoice, so three unpaid invoices become a guess');
});

check('the payment text is a handoff, not a send', () => {
  // The server's payment-link route MINTS a url and sends nothing. A text
  // that leaves from Apple's Messages leaves from Patrick's own number,
  // which is a number the customer can reply to.
  assert.match(PROPERTY, /invoicePaymentLink\(chase\.id\)/);
  assert.match(PROPERTY, /sms:\$\{to\}&body=/, 'the message body is not attached to the number');
  assert.match(PROPERTY, /sms:&body=/, 'no fallback when the property has no phone');
});

// ---- The primitive that carries a pill ----------------------------------

check('a pill is given a container, not nested inside a Text', () => {
  // <Pill> renders a View. A View inside a Text is legal on iOS and
  // unreliable about sizing, which is a layout bug that only shows on a
  // phone. Row gained a node slot instead.
  assert.match(UI, /export function Row\(\{ label, value, right, onPress, last, valueStyle \}\)/,
    'Row lost its node slot');
  assert.match(UI, /right != null \? \(\s*<View style=\{styles\.rowRight\}>/);
  for (const [name, source] of [['property', PROPERTY]]) {
    assert.ok(
      !/value=\{\s*<>/.test(source),
      `${name} screen is passing a node as \`value\`, which nests it inside a Text`,
    );
  }
});

// ---- The server side of the property's invoices -------------------------

function extractNeedsAuth() {
  const start = SERVER.indexOf('function needsAuth(method, pathname) {');
  assert.ok(start > 0, 'needsAuth not found');
  const end = SERVER.indexOf('\n}\n', start);
  return new Function(`${SERVER.slice(start, end + 3)}; return needsAuth;`)();
}

check('the invoice list is still staff-only', () => {
  const needsAuth = extractNeedsAuth();
  assert.equal(needsAuth('GET', '/api/invoices'), 'user');
  assert.equal(needsAuth('POST', '/api/invoices/I-2026-0001/payment-link'), 'user');
});

check('propertyId filters the invoice list, and its absence changes nothing', () => {
  const at = SERVER.indexOf('pathname === "/api/invoices"');
  assert.ok(at > 0, 'the invoice list route is gone');
  const block = SERVER.slice(at, at + 1200);
  assert.match(block, /const propertyId = url\.searchParams\.get\("propertyId"\);/);
  assert.match(block, /if \(propertyId\) all = all\.filter\(\(i\) => i\.propertyId === propertyId\);/);
  // The guard that makes this additive: no param, no filter. Every
  // existing caller — the CRM's own invoice page among them — gets the
  // response it got before.
  assert.ok(
    /if \(propertyId\)/.test(block),
    'the property filter runs unconditionally and would empty the list for every other caller',
  );
  // And it filters the same way the two filters beside it do, rather
  // than introducing a second read path.
  assert.match(block, /if \(status\) all = all\.filter/);
  assert.match(block, /if \(woId\) all = all\.filter/);
});

// ---- These screens parse as the app will read them ----------------------

check('every screen this change touches parses with the app\'s own Babel', () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail("the app's dependencies are not installed — run npm ci in pjl-field"); }
  for (const rel of [
    'pjl-field/App.js',
    'pjl-field/src/api.js',
    'pjl-field/src/ui.js',
    'pjl-field/src/workorder-routing.js',
    'pjl-field/src/screens/PropertyProfileScreen.js',
    'pjl-field/src/screens/TodayScreen.js',
  ]) {
    babel.parse(read(rel), {
      filename: rel,
      parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      babelrc: false,
      configFile: false,
    });
  }
});

console.log(`\napp-shell: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

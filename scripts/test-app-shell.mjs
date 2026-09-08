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
  assert.deepEqual(tabKeys(), ['today', 'properties', 'book', 'messages']);
});

check('Book does not exist for a tech, and is not merely disabled', () => {
  // A locked tab teaches someone to press a thing that never works, and
  // the app's opinion is only a hint anyway — the server is what refuses.
  // So the rule is ABSENCE, and it is executed rather than read.
  // The real TABS array, read out of App.js rather than restated here —
  // a copy of the data would keep passing after the real one changed.
  const start = APP.indexOf('const TABS = [');
  const block = APP.slice(start, APP.indexOf('];', start) + 2);
  const rows = [...block.matchAll(/\{[^}]*key:\s*'([a-z]+)'[^}]*\}/g)]
    .map((m) => ({ key: m[1], admin: /admin:\s*true/.test(m[0]) }));
  assert.ok(rows.some((r) => r.admin), 'no tab is admin-gated any more');

  const tabsForRole = lift(APP, 'tabsForRole', `const TABS = ${JSON.stringify(rows)};`);
  const keys = (role) => tabsForRole(role).map((t) => t.key);
  assert.deepEqual(keys('admin'), ['today', 'properties', 'book', 'messages']);
  assert.deepEqual(keys('tech'), ['today', 'properties', 'messages'], 'a tech can see Book');
  // Signed out, and any unexpected role, get the tech view rather than
  // the admin one — the gate fails CLOSED.
  assert.deepEqual(keys(null), ['today', 'properties', 'messages']);
  assert.deepEqual(keys(undefined), ['today', 'properties', 'messages']);
  assert.deepEqual(keys('customer'), ['today', 'properties', 'messages']);
  assert.deepEqual(keys('Admin'), ['today', 'properties', 'messages'], 'the role check is case-loose');

  // And the shell renders the FILTERED list, not the raw one — a gate
  // that computes the right answer and then ignores it is not a gate.
  assert.ok(!/\{TABS\.map\(/.test(APP), 'the shell still renders every tab regardless of role');
  assert.match(APP, /\{visibleTabs\.map\(/);
  // Losing admin while Book is open must not strand a pane with no tab.
  assert.match(APP, /if \(!visibleTabs\.some\(\(t\) => t\.key === active\)\) setActive\('today'\)/);
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
  // All three are native now — Messages stopped being a WebScreen when the
  // thread list and conversation were built, which is also what removed
  // the last surface anyone could sign in on. See test-messages.mjs.
  for (const key of tabKeys()) {
    const rendered = key === 'messages'
      ? /<MessagesScreen/.test(APP)     // the fallback arm
      : new RegExp(`tab\\.key === '${key}'`).test(APP);
    assert.ok(rendered, `the ${key} tab has no branch that renders it`);
  }
});

// ---- The open job, executed ---------------------------------------------

check('a work order becomes the right kind of job', () => {
  const jobForWorkOrder = lift(APP, 'jobForWorkOrder', `
    const JOB = { CLOSING: 'closing', WEB: 'web', INVOICE: 'invoice' };
    const TERMINAL_WO = new Set(['completed', 'cancelled', 'no_show']);
  `);

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

  // A FINISHED visit is a record, not a form. Routing on `type` alone sent
  // a completed fall closing back into the editable closing flow, where
  // every stage is interactive and every tap calls patchWorkOrder — which
  // the server refuses on a locked work order, so each tap produced
  // "Didn't save" and a red "Not saved" header on a visit that was
  // finished and invoiced.
  for (const status of ['completed', 'cancelled', 'no_show']) {
    assert.deepEqual(
      jobForWorkOrder({ id: 'WO-9', type: 'fall_closing', status }),
      { kind: 'web', url: '/admin/work-order/WO-9/tech', title: 'Work order' },
      `a ${status} fall closing reopened the editable closing flow`,
    );
  }
  // A live one still does open it.
  for (const status of [undefined, 'scheduled', 'on_site', 'in_progress']) {
    assert.equal(
      jobForWorkOrder({ id: 'WO-8', type: 'fall_closing', status })?.kind, 'closing',
      `a ${status} fall closing stopped opening the native flow`,
    );
  }
});

check('the overlay covers the tab bar and every arm is handed a way out', () => {
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
  // Covering the tab bar visually is only half of it. Without this a
  // VoiceOver user swipes straight past the job into the tab bar
  // underneath and switches tabs invisibly.
  assert.match(block, /accessibilityViewIsModal/, 'the overlay is not modal to VoiceOver');
  // The overlay has no tab bar, so it must not reuse the shell's white
  // safe area — that painted a white band across the bottom inset under
  // screens that draw on `ground`.
  assert.match(APP, /overlaySafe: \{[^}]*backgroundColor: colors\.ground/, 'the overlay reuses the shell safe area');
});

// The assertion above proves App.js HANDS each arm an exit. That is not
// the same as the arm rendering one, and the difference shipped three
// screens you could only leave by force-quitting: ClosingScreen,
// InvoiceScreen and WebScreen each rendered their exit only in the ready
// state, and returned early — with no bar — while loading, while
// unauthenticated, and on error. `getJson` has no timeout, so "while
// loading" is not a moment, it is potentially forever.
//
// So this walks the AST of each overlay screen, finds every `return` in
// the component's own top-level body, and asserts the returned JSX
// mentions that screen's exit prop. Reading the source for the prop NAME
// is what let this through the first time.
function exitlessReturns(rel, componentName, exitProp) {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  const babel = requireFromApp('@babel/core');
  const ast = babel.parse(read(rel), {
    filename: rel,
    parserOpts: { sourceType: 'module', plugins: ['jsx'] },
    babelrc: false,
    configFile: false,
    ast: true,
    code: false,
  });

  let body = null;
  for (const node of ast.program.body) {
    const fn = node.type === 'ExportDefaultDeclaration' ? node.declaration : null;
    if (fn && fn.type === 'FunctionDeclaration' && fn.id?.name === componentName) body = fn.body.body;
  }
  assert.ok(body, `${componentName} is no longer the default export of ${rel}`);

  // A screen may hoist its bar into a local (`const exitBar = (...)`) and
  // render `{exitBar}`. That is still an exit, so resolve those names —
  // any top-level const in the component whose initialiser mentions the
  // exit prop counts as carrying it.
  const source = read(rel);
  const carriers = new Set([exitProp]);
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (!d.init || d.id.type !== 'Identifier') continue;
      if (source.slice(d.init.start, d.init.end).includes(exitProp)) carriers.add(d.id.name);
    }
  }

  const offenders = [];
  for (const stmt of body) {
    // Top-level `return` and the `return` inside a top-level `if` — the
    // early-exit shapes. A return nested inside a callback is not a
    // render path.
    const returns = [];
    if (stmt.type === 'ReturnStatement') returns.push(stmt);
    if (stmt.type === 'IfStatement') {
      for (const branch of [stmt.consequent, stmt.alternate]) {
        if (!branch) continue;
        if (branch.type === 'ReturnStatement') returns.push(branch);
        if (branch.type === 'BlockStatement') {
          for (const inner of branch.body) if (inner.type === 'ReturnStatement') returns.push(inner);
        }
      }
    }
    for (const ret of returns) {
      if (!ret.argument) continue;
      const src = source.slice(ret.argument.start, ret.argument.end);
      if (![...carriers].some((name) => src.includes(name))) offenders.push(`line ${ret.loc.start.line}`);
    }
  }
  return offenders;
}

check('every overlay screen renders its exit in EVERY state, not just the ready one', () => {
  for (const [rel, component, exitProp] of [
    ['pjl-field/src/screens/ClosingScreen.js', 'ClosingScreen', 'onExit'],
    ['pjl-field/src/screens/InvoiceScreen.js', 'InvoiceScreen', 'onBack'],
  ]) {
    const offenders = exitlessReturns(rel, component, exitProp);
    assert.deepEqual(
      offenders, [],
      `${component} returns without ${exitProp} at ${offenders.join(', ')} — that state is a force-quit`,
    );
  }
});

check("WebScreen's error panel cannot cover its own Back bar", () => {
  const WEB = read('pjl-field/src/screens/WebScreen.js');
  // The panel is absoluteFillObject. While it was a sibling of the bar it
  // filled the whole screen INCLUDING the bar, opaquely and without
  // pointerEvents="none" — so it hid `‹ Back` and swallowed its taps. It
  // has to be confined to its own region below the bar.
  assert.match(WEB, /viewport: \{ flex: 1 \}/, 'the WebView has no region of its own');
  const barAt = WEB.indexOf('styles.bar');
  const viewportAt = WEB.indexOf('styles.viewport');
  assert.ok(barAt > 0 && viewportAt > barAt, 'the overlays are not below the bar');
});

// ---- The card's three states --------------------------------------------

check('the day card names all three states of a work order', () => {
  const label = lift(ROUTING, 'workOrderActionLabel', `
    const TERMINAL = ['completed', 'cancelled', 'no_show'];
    const isOpenWorkOrder = (wo) => !!wo && !TERMINAL.includes(wo.status);
  `);
  assert.equal(label({}), 'Start WO', 'a row with no work order');
  assert.equal(label({ workOrder: { status: 'draft' } }), 'Resume WO');
  assert.equal(label({ workOrder: { status: 'on_site' } }), 'Resume WO');
  assert.equal(label({ workOrder: { status: 'in_progress' } }), 'Resume WO');
  // The old bug: these three read "Open WO", the same as a live one.
  assert.equal(label({ workOrder: { status: 'completed' } }), 'View WO');
  assert.equal(label({ workOrder: { status: 'cancelled' } }), 'View WO');
  assert.equal(label({ workOrder: { status: 'no_show' } }), 'View WO');
  assert.equal(label(null), 'Start WO');

  // One noun, one register, similar widths. "Start WO" / "Resume" /
  // "Open work order" mixed an abbreviation, a bare verb and a spelled-out
  // phrase on one button — and the 132pt variant re-wrapped the card's
  // action row, so cards in one list came out different heights for a
  // reason the tech could not see.
  const labels = ['Start WO', 'Resume WO', 'View WO'];
  for (const text of labels) assert.ok(text.endsWith(' WO'), `${text} breaks the button's register`);
  const widths = labels.map((t) => t.length);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 3, 'the labels are too different in width');
});

check('the screen uses that label rather than its own', () => {
  assert.match(TODAY, /label=\{workOrderActionLabel\(b\)\}/, 'the card computes its own label again');
  assert.ok(!/label=\{b\.workOrder \? 'Open WO'/.test(TODAY), 'the two-state label survived');
});

check('a finished job reads as done, not as disabled', () => {
  assert.match(TODAY, /isFinishedRow\(b\) && styles\.cardDone/, 'a completed job no longer reads as done');
  // NOT opacity. Dimming the whole Pressable dimmed the live primary
  // button inside it, so a finished stop read as disabled while remaining
  // fully tappable — and it sat 0.27 from the app's real disabled
  // treatment (0.45), which is not a distance you can judge at arm's
  // length in daylight. It also washed out cardFocused's brand border on
  // exactly the card you had just tapped.
  const at = TODAY.indexOf('cardDone: {');
  assert.ok(at > 0, 'cardDone is gone');
  const block = TODAY.slice(at, TODAY.indexOf('\n', at));
  assert.ok(!/opacity/.test(block), 'a finished card is dimmed again, so it reads as disabled');
  assert.match(block, /backgroundColor/, 'a finished card has no treatment at all');
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

check('the payment link names one invoice, and it is the oldest ISSUED one owing', () => {
  const invoiceToChase = lift(PROPERTY, 'invoiceToChase',
    "const CHASEABLE = new Set(['sent', 'partially_paid']);");
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

  // A DRAFT is a document the office has never reviewed or sent — and it
  // is usually the OLDEST owing record on an address, so an
  // exclude-void-and-paid filter selected exactly the wrong one.
  // ensurePaymentToken has no status guard, so this would have minted a
  // live payable link for a stale draft and texted the customer a figure
  // nobody approved.
  const draft = { id: 'I-D', status: 'draft', balanceDue: 400, createdAt: '2025-06-01T00:00:00Z' };
  assert.equal(invoiceToChase([draft]), null, 'a draft invoice was chased');
  assert.equal(invoiceToChase([draft, owing])?.id, 'I-2', 'a draft outranked an issued invoice');
  // partially_paid is still owed and still chaseable.
  const part = { id: 'I-P', status: 'partially_paid', balanceDue: 50, createdAt: '2026-02-01T00:00:00Z' };
  assert.equal(invoiceToChase([part, owing])?.id, 'I-P', 'a part-paid invoice is not chaseable');

  // Both sides of the comparison validated. The seed is owing[0], and the
  // server sorts newest-first — so an unparseable createdAt there left the
  // comparison NaN, every test false, and the NEWEST invoice winning
  // permanently. That is the wrong-balance text this function exists to
  // prevent.
  const broken = { id: 'I-X', status: 'sent', balanceDue: 10, createdAt: 'not a date' };
  assert.equal(invoiceToChase([broken, owing])?.id, 'I-2', 'an unparseable date on the seed won');
  const noDate = { id: 'I-N', status: 'sent', balanceDue: 10 };
  assert.equal(invoiceToChase([noDate, owing])?.id, 'I-2', 'a missing date on the seed won');
});

check('the chase button says which invoice it will send', () => {
  assert.match(PROPERTY, /\{chase\.id\}/,
    'the button no longer names the invoice, so three unpaid invoices become a guess');
  assert.match(PROPERTY, /Text a payment link/);
  // No number, no button. It used to key on `chase` alone, so an address
  // with no phone offered a button that opened nothing.
  assert.match(PROPERTY, /chase && chaseTo \?/, 'the button renders without a recipient');
});

check('the payment text is a handoff, not a send, and it reaches the right person', () => {
  // The server's payment-link route MINTS a url and sends nothing. A text
  // that leaves from Apple's Messages leaves from Patrick's own number,
  // which is a number the customer can reply to.
  assert.match(PROPERTY, /invoicePaymentLink\(chase\.id\)/);
  // `?body=` is the one separator both platforms accept — `&body=` is
  // iOS-only, and app.json declares an android target. Get it wrong and
  // the composer opens empty, which reads as the link not attaching.
  assert.match(PROPERTY, /sms:\$\{chaseTo\}\?body=/, 'the message body is not attached to the number');
  assert.ok(!/sms:&body=/.test(PROPERTY), 'the iOS-only `&body=` separator is back');
  assert.ok(!/sms:\$\{to\}&body=/.test(PROPERTY), 'the iOS-only `&body=` separator is back');

  // The number on the INVOICE first. On a managed commercial site the
  // payer is the billing entity while the property's siteContacts are the
  // super — texting them the link shows a third party the billing name,
  // billing email and full line-item pricing, and lets them pay it.
  const at = PROPERTY.indexOf('const chaseTo');
  assert.ok(at > 0, 'the recipient is no longer derived separately');
  const block = PROPERTY.slice(at, PROPERTY.indexOf(';', at));
  assert.ok(block.indexOf('billTo') < block.indexOf('|| phone'),
    "the property's phone outranks the invoice's billing party");

  // An open() that cannot reject cannot surface a failure. The mint
  // failure was alerted and the OPEN failure was swallowed, so a handset
  // that refused the URL produced no alert and no state change.
  assert.match(PROPERTY, /Couldn't open Messages/, 'a failed handoff is silent again');
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

function invoiceListBlock() {
  const at = SERVER.indexOf('pathname === "/api/invoices"');
  assert.ok(at > 0, 'the invoice list route is gone');
  return SERVER.slice(at, at + 2600);
}

check('propertyId filters the invoice list, and its absence changes nothing', () => {
  const block = invoiceListBlock();
  assert.match(block, /const propertyId = url\.searchParams\.get\("propertyId"\);/);
  // `!== null`, not truthiness. `?propertyId=` (empty string) is falsy, so
  // the truthy guard SKIPPED the filter and answered with every invoice in
  // the business on a screen that had asked for one address's — a "this
  // address has no invoices" list silently becoming the whole ledger.
  assert.match(block, /if \(propertyId !== null\) all = all\.filter\(\(i\) => i\.propertyId === propertyId\);/);
  assert.ok(!/if \(propertyId\) all = all\.filter/.test(block), 'the truthy guard is back');
  // Absent is still `null` from searchParams.get, so an unfiltered call is
  // unchanged. Every existing caller — the CRM's own invoice page among
  // them — gets the list it got before.
  assert.equal(new URL('https://x/api/invoices').searchParams.get('propertyId'), null);
  assert.equal(new URL('https://x/api/invoices?propertyId=').searchParams.get('propertyId'), '');
  // And it filters the same way the two filters beside it do, rather
  // than introducing a second read path.
  assert.match(block, /if \(status\) all = all\.filter/);
  assert.match(block, /if \(woId\) all = all\.filter/);
});

check('the invoice list never hands out a bearer payment token', () => {
  // paymentToken is a permanent, unexpiring, unrevocable password to an
  // invoice: whoever holds it can read the customer's name, email, address
  // and every line item, and can PAY it. portalToken is the same for the
  // read-only view. Handing both to every caller of this list made the
  // admin gate on POST /api/invoices/:id/payment-link — added on
  // 2026-09-06 precisely so a tech could not mint payment links —
  // decorative, because the pay URL is a fixed template around the token.
  const block = invoiceListBlock();
  assert.match(block, /const safe = all\.map\(\(\{ paymentToken, portalToken, \.\.\.rest \}\) => rest\);/,
    'the list is no longer stripping its bearer tokens');
  assert.match(block, /invoices: safe/, 'the unstripped list is being sent');
  assert.ok(!/invoices: all \}/.test(block), 'the raw list is being sent again');
  // Both fields really are on the hydrated record — if they stop being,
  // this strip is dead code and should be revisited rather than left to
  // look like protection.
  const INVOICES_LIB = read('server/lib/invoices.js');
  assert.match(INVOICES_LIB, /paymentToken: inv\?\.paymentToken \|\| null,/);
  assert.match(INVOICES_LIB, /portalToken: inv\?\.portalToken \|\| null,/);
});

check('every work-order status the server can send has a label, in one place', () => {
  // Two copies of this map lived in TodayScreen and PropertyProfileScreen
  // and BOTH were missing the same five statuses, so a real work order
  // rendered a pill reading `awaiting_approval` — lowercase, underscored,
  // beside sentence-case pills, and too wide for the row.
  const WO_LIB = read('server/lib/work-orders.js');
  const order = WO_LIB.match(/const STATUS_ORDER = \[([^\]]+)\]/);
  assert.ok(order, "the server's STATUS_ORDER moved — the app's labels need revisiting");
  const terminal = WO_LIB.match(/const STATUS_TERMINAL = new Set\(\[([^\]]+)\]/);
  assert.ok(terminal, "the server's STATUS_TERMINAL moved");
  const statuses = [...order[1].matchAll(/"([a-z_]+)"/g), ...terminal[1].matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1]);
  assert.ok(statuses.length >= 9, 'the status list came back suspiciously short');

  const at = ROUTING.indexOf('export const WO_STATUS_LABELS = {');
  assert.ok(at > 0, 'the shared work-order label map is gone');
  const block = ROUTING.slice(at, ROUTING.indexOf('};', at));
  for (const status of statuses) {
    assert.ok(block.includes(`${status}:`), `no label for the real work-order status ${status}`);
  }
  // Exactly one map. Two copies is how five statuses went missing twice.
  for (const [name, source] of [['TodayScreen', TODAY], ['PropertyProfileScreen', PROPERTY]]) {
    assert.ok(!/const WO_STATUS_LABELS = \{/.test(source),
      `${name} grew its own copy of the work-order label map again`);
  }
  // A cancelled visit and a completed visit must not wear the same pill.
  const tone = lift(ROUTING, 'workOrderStatusTone');
  assert.equal(tone('completed'), 'good');
  assert.equal(tone('cancelled'), 'danger');
  assert.equal(tone('no_show'), 'danger');
  assert.equal(tone('in_progress'), 'warn');
  assert.notEqual(tone('cancelled'), tone('completed'), 'cancelled and completed look identical');
});

check('money shows the currency it is handed, and groups its thousands', () => {
  // `export const money = (n, currency) => {...}` — an arrow, not a
  // declaration, so lift() does not reach it.
  const FORMAT = read('pjl-field/src/format.js');
  const start = FORMAT.indexOf('export const money = ');
  assert.ok(start > 0, 'money is no longer exported from format.js');
  const end = FORMAT.indexOf('\n};', start);
  assert.ok(end > start, 'could not find the end of money');
  const money = new Function(
    `${FORMAT.slice(start, end + 3).replace('export const', 'const')}\nreturn money;`,
  )();
  // The second argument was silently discarded, so the same invoice read
  // "$285.00 CAD" on the invoice screen and "$285.00" on the property.
  assert.equal(money(285, 'CAD'), '$285.00 CAD');
  assert.equal(money(285), '$285.00');
  // A five-figure commercial balance rendered "$12345.67" under a comment
  // claiming the column lined up on the decimal.
  assert.ok(/1,234/.test(money(1234.5)), 'thousands are not grouped');
  // A string that slips through must not render as null — that reached a
  // customer's text message as "(null)".
  assert.equal(money('285'), '$285.00');
  // A MISSING amount is not zero. Number(null), Number(undefined) and
  // Number('') are all 0, so an unguarded coercion prints "$0.00" on a
  // balance nobody knows — which reads as "nothing owing".
  assert.equal(money(null), null);
  assert.equal(money(undefined), null);
  assert.equal(money(''), null);
  assert.equal(money('nonsense'), null);
  // Zero itself is a real, known amount and still prints.
  assert.equal(money(0), '$0.00');
});

check('no screen tells the user to sign in on a tab', () => {
  // Auth rides the WebView's cookie jar (src/api.js). While one tab
  // happened to be a web page, "sign in on another tab" was true by
  // accident; Messages going native removed the last one. Every screen
  // now reaches a sign-in of its own — that surface, and the fact that
  // every auth state can open it, is proved in test-messages.mjs. What
  // this asserts is only that the OLD instruction is gone, because a
  // message naming a tab that cannot sign you in is worse than no
  // message at all.
  for (const rel of [
    'pjl-field/src/screens/PropertiesScreen.js',
    'pjl-field/src/screens/TodayScreen.js',
    'pjl-field/src/screens/PropertyProfileScreen.js',
    'pjl-field/src/screens/ClosingScreen.js',
    'pjl-field/src/screens/InvoiceScreen.js',
  ]) {
    // Comments stripped WHOLE, not line by line. A block comment's
    // second line does not start with `*` or `//`, and one of them
    // (InvoiceScreen, on the reader-failed message) reads "update iOS,
    // sign in, or use the link" — advice about the PHONE, not about this
    // app's session, and not a string any user ever sees.
    const source = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const line of source.split('\n')) {
      if (line.trim().startsWith('//')) continue;
      if (!/sign in/i.test(line)) continue;
      assert.ok(!/\btab\b/i.test(line),
        `${rel} sends the user to a tab to sign in: ${line.trim()}`);
    }
  }
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
    'pjl-field/src/screens/ClosingScreen.js',
    'pjl-field/src/screens/InvoiceScreen.js',
    'pjl-field/src/screens/WebScreen.js',
    'pjl-field/src/format.js',
    'pjl-field/src/theme.js',
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

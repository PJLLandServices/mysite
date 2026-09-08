// The field app's Messages tab, after it stopped being a web page.
//
//   node scripts/test-messages.mjs
//
// Three things about this change can go wrong quietly, and each is
// executed here rather than read:
//
//   1. THE LOCKOUT. Authentication rides the WebView's cookie jar, so
//      before this change every "not signed in" state could point at a
//      tab that happened to be a web page. Making Messages native
//      removed the last one. An app with no sign-in surface is an app
//      nobody can use, and it would look exactly like a working app
//      until the session expired.
//   2. THE LIE. A reply is committed to the thread and then EMAILED,
//      fire-and-forget. Dressed as iMessage, "Delivered" under a green
//      bubble is a sentence the app cannot support — and the person
//      reading it is standing in a driveway believing they texted.
//   3. THE CAP. The server truncates a reply at 1500 characters with
//      normalizeString and says nothing. If the composer's number and
//      the server's ever part company, the tech sends half a sentence
//      and is told it went.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('pjl-field/App.js');
const API = read('pjl-field/src/api.js');
const FORMAT = read('pjl-field/src/format.js');
const LIST = read('pjl-field/src/screens/MessagesScreen.js');
const THREAD = read('pjl-field/src/screens/ThreadScreen.js');
const SIGNIN = read('pjl-field/src/screens/SignInScreen.js');
const SERVER = read('server/server.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// Lifts an exported function out of an app source file and RUNS it.
// These modules import React Native and cannot be imported here; the
// functions under test are pure and deliberately kept that way.
function lift(source, name, deps = '') {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `${name} is not an exported function`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  const body = source.slice(start, end + 3).replace('export function', 'function');
  return new Function(`${deps}\n${body}\nreturn ${name};`)();
}

// ---- 1. The lockout -----------------------------------------------------

check('no tab is a web page any more, so a sign-in surface has to exist', () => {
  const start = APP.indexOf('const TABS = [');
  assert.ok(start > 0, 'TABS is gone from App.js');
  const block = APP.slice(start, APP.indexOf('];', start));
  // A `path` on a tab meant "this tab is a WebScreen". None should be
  // left — and if one comes back, this test is the reminder that the
  // sign-in overlay is no longer the only way in.
  assert.ok(!/path:/.test(block), 'a tab is a web page again — revisit how sign-in is reached');
  assert.match(APP, /import SignInScreen from '\.\/src\/screens\/SignInScreen'/,
    'there is no sign-in screen, and no tab can sign anyone in');
  assert.match(APP, /\{signInOpen \?/, 'the sign-in overlay is not rendered');
});

check('every screen that can be signed out can reach the sign-in', () => {
  // A screen that renders "Not signed in" without a way to fix it is a
  // dead end — and with Messages native there is no longer a tab to
  // send anyone to.
  for (const rel of [
    'pjl-field/src/screens/TodayScreen.js',
    'pjl-field/src/screens/PropertiesScreen.js',
    'pjl-field/src/screens/PropertyProfileScreen.js',
    'pjl-field/src/screens/ClosingScreen.js',
    'pjl-field/src/screens/InvoiceScreen.js',
    'pjl-field/src/screens/MessagesScreen.js',
    'pjl-field/src/screens/ThreadScreen.js',
  ]) {
    const source = read(rel);
    if (!/Not signed in/.test(source)) continue;
    assert.match(source, /onSignIn/, `${rel} says "Not signed in" with no way to sign in`);
  }
  // And the shell has to actually pass it to each of them.
  for (const screen of [
    'TodayScreen', 'PropertiesScreen', 'PropertyProfileScreen',
    'ClosingScreen', 'InvoiceScreen', 'MessagesScreen', 'ThreadScreen',
  ]) {
    const at = APP.indexOf(`<${screen}`);
    assert.ok(at > 0, `${screen} is not mounted by the shell`);
    const block = APP.slice(at, APP.indexOf('/>', at) + 2);
    assert.match(block, /onSignIn=\{openSignIn\}/, `${screen} is mounted without onSignIn`);
  }
});

check('no "sign in on another tab" message survives', () => {
  for (const rel of [
    'pjl-field/src/screens/TodayScreen.js',
    'pjl-field/src/screens/PropertiesScreen.js',
    'pjl-field/src/screens/PropertyProfileScreen.js',
    'pjl-field/src/screens/ClosingScreen.js',
    'pjl-field/src/screens/InvoiceScreen.js',
    'pjl-field/src/screens/MessagesScreen.js',
    'pjl-field/src/screens/ThreadScreen.js',
  ]) {
    for (const line of read(rel).split('\n')) {
      if (line.trim().startsWith('//')) continue;
      if (!/sign in/i.test(line)) continue;
      assert.ok(!/\btab\b/i.test(line),
        `${rel} still sends the user to a tab to sign in: ${line.trim()}`);
    }
  }
});

check('the sign-in only declares success on the page login sends you to', () => {
  const H = 'https://www.pjllandservices.com';
  const deps = `const HOST = '${H}'; const NEXT = '/admin';`;
  const pathOnHost = lift(SIGNIN, 'pathOnHost', deps);
  const isLoginUrl = lift(SIGNIN, 'isLoginUrl', `${deps}
    ${SIGNIN.slice(SIGNIN.indexOf('export function pathOnHost('), SIGNIN.indexOf('\n}\n', SIGNIN.indexOf('export function pathOnHost(')) + 3).replace('export function', 'function')}`);
  const isSignedInUrl = lift(SIGNIN, 'isSignedInUrl', `${deps}
    ${SIGNIN.slice(SIGNIN.indexOf('export function pathOnHost('), SIGNIN.indexOf('\n}\n', SIGNIN.indexOf('export function pathOnHost(')) + 3).replace('export function', 'function')}`);

  assert.equal(isLoginUrl(`${H}/login`), true);
  assert.equal(isLoginUrl(`${H}/login/`), true);
  assert.equal(isLoginUrl(`${H}/login?next=%2Fadmin`), true, 'the query string hid the login page');
  assert.equal(isLoginUrl(`${H}/admin`), false);

  // THE DEFECT THIS EXISTS FOR. The login page carries two ordinary
  // links: the PJL logo to `/`, and an orange "your portal sign-in" to
  // `/portal/login` sitting directly above the email field, right under
  // the thumb. Under "signed in means anywhere that is not /login",
  // tapping either played the whole success animation for someone who
  // never typed a password.
  assert.equal(isSignedInUrl(`${H}/`), false, 'tapping the logo counts as signing in');
  assert.equal(isSignedInUrl(`${H}/portal/login`), false, 'the portal link counts as signing in');
  assert.equal(isSignedInUrl(`${H}/reset-password`), false);
  assert.equal(isSignedInUrl(`${H}/login?next=%2Fadmin`), false);
  // What success actually is.
  assert.equal(isSignedInUrl(`${H}/admin`), true);
  assert.equal(isSignedInUrl(`${H}/admin/messages`), true);
  assert.equal(isSignedInUrl(`${H}/admin?tab=x`), true);

  // A prefix is not a host. `startsWith(HOST)` alone also matches
  // pjllandservices.com.attacker.tld, because the prefix is there.
  assert.equal(pathOnHost(`${H}.attacker.tld/admin`), null, 'a lookalike host passed as ours');
  assert.equal(isSignedInUrl(`${H}.attacker.tld/admin`), false);
  assert.equal(isSignedInUrl('https://evil.example/admin'), false);
  assert.equal(isSignedInUrl(''), false);
  assert.equal(isSignedInUrl(null), false);
});

check('the sign-in sheet cannot wander off the login form', () => {
  const H = 'https://www.pjllandservices.com';
  const deps = `const HOST = '${H}'; const NEXT = '/admin';`;
  const head = (name) => SIGNIN.slice(SIGNIN.indexOf(`export function ${name}(`), SIGNIN.indexOf('\n}\n', SIGNIN.indexOf(`export function ${name}(`)) + 3).replace('export function', 'function');
  const isAllowedNavigation = lift(
    SIGNIN, 'isAllowedNavigation',
    `${deps}\n${head('pathOnHost')}\n${head('isLoginUrl')}\n${head('isSignedInUrl')}`,
  );
  assert.equal(isAllowedNavigation(`${H}/login?next=%2Fadmin`), true);
  assert.equal(isAllowedNavigation(`${H}/admin`), true);
  assert.equal(isAllowedNavigation(`${H}/reset-password`), true, 'a forgotten password is a dead end');
  assert.equal(isAllowedNavigation('about:blank'), true);
  // The two links that used to read as success are simply not followed.
  assert.equal(isAllowedNavigation(`${H}/`), false);
  assert.equal(isAllowedNavigation(`${H}/portal/login`), false);
  assert.equal(isAllowedNavigation('https://evil.example/'), false);
  // And the guard is actually wired to the WebView.
  assert.match(SIGNIN, /onShouldStartLoadWithRequest=\{\(request\) => isAllowedNavigation\(request\?\.url\)\}/);
  // Settled on load END, not navigation start — the session cookie's
  // write-back to the store this app's fetch reads is asynchronous.
  assert.ok(!/onNavigationStateChange/.test(SIGNIN),
    'the sheet settles on navigation start again, which races the cookie write-back');
  assert.match(SIGNIN, /onLoadEnd=\{\(\{ nativeEvent \}\) => \{/);
  // Offline must not leave a blank white sheet with only Cancel.
  assert.match(SIGNIN, /Can't reach PJL/);
});

check('signing in from an overlay screen is not a dead end', () => {
  // Each of these renders its own "Not signed in" and opens the sheet.
  // Without a key tied to the sign-in they sit in `auth` for ever after
  // a successful sign-in, and the only control is the button that
  // reopens the form — a loop whose sole exit is the back bar.
  for (const screen of ['ClosingScreen', 'InvoiceScreen', 'ThreadScreen']) {
    const at = APP.indexOf(`<${screen}`);
    assert.ok(at > 0, `${screen} is not mounted by the shell`);
    const block = APP.slice(at, APP.indexOf('/>', at) + 2);
    assert.match(block, /key=\{`[a-z]+-\$\{[^}]+\}-\$\{signedIn\}`\}/,
      `${screen} does not remount after a sign-in, so its auth state is a loop`);
  }
});

check('the thread list is re-read when a thread closes', () => {
  // Opening a thread marks it read on the server, and replying changes
  // both its preview and its place in the order.
  const at = APP.indexOf('<MessagesScreen');
  const block = APP.slice(at, APP.indexOf('/>', at) + 2);
  assert.match(block, /refreshToken=\{jobsClosed\}/, 'the list keeps its stale unread dot');
  assert.match(LIST, /refreshToken = 0/, 'MessagesScreen ignores the refresh');
});

// ---- 2. The lie ---------------------------------------------------------

check('a reply is never described as a text message', () => {
  const note = lift(THREAD, 'deliveryNote');
  const HAS = 'kristen@example.com';
  // "Emailed" is what happened. "Read" is a real receipt — the
  // customer's portal marks admin replies read.
  assert.equal(note({ from: 'admin' }, HAS), 'Emailed');
  assert.equal(note({ from: 'admin', readByCustomer: false }, HAS), 'Emailed');
  assert.equal(note({ from: 'admin', readByCustomer: true }, HAS), 'Read');
  // A phone-only lead is an ordinary record, and for it the server
  // returns { skipped: true } without sending anything. "Emailed" there
  // is the same lie as "Delivered".
  assert.equal(note({ from: 'admin' }, ''), 'Saved — no email on file');
  assert.equal(note({ from: 'admin' }, null), 'Saved — no email on file');
  assert.equal(note({ from: 'admin' }, undefined), 'Saved — no email on file');
  // A read receipt is real either way — the portal marks it.
  assert.equal(note({ from: 'admin', readByCustomer: true }, ''), 'Read');
  // The customer's own messages carry no delivery note at all.
  assert.equal(note({ from: 'customer' }, HAS), null);
  assert.equal(note(null, HAS), null);
  // The words the app must never put under a green bubble.
  for (const word of ['Delivered', 'Sent', 'Texted', 'SMS']) {
    assert.notEqual(note({ from: 'admin', readByCustomer: true }, HAS), word);
    assert.notEqual(note({ from: 'admin' }, HAS), word);
    assert.notEqual(note({ from: 'admin' }, ''), word);
  }
});

check('the thread screen does not claim to send texts', () => {
  // Strip comments first: the file EXPLAINS why it avoids these words,
  // and the explanation must not trip the check that enforces it.
  const code = THREAD.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const claim of [/Delivered/, /\bTexted\b/, /Message sent/i]) {
    assert.ok(!claim.test(code), `the thread screen claims ${claim} for a reply that went by email`);
  }
  // And it says what it IS, on the box the words go into.
  assert.match(code, /Reply by email/, 'the composer does not say the reply goes by email');
});

check('the reply really does leave by email, fire-and-forget', () => {
  // The claim above is only honest while the server behaves this way.
  // If the reply route ever starts sending an SMS, "Emailed" becomes the
  // lie instead — so the app's wording is pinned to the server's code.
  const at = SERVER.indexOf('if (req.method === "POST" && sub === "/reply")');
  assert.ok(at > 0, 'the reply route moved');
  const block = SERVER.slice(at, at + 2200);
  assert.match(block, /sendPortalReplyToCustomer\([^)]*\)\.catch\(\(\) => \{\}\)/,
    'the reply is no longer an email sent fire-and-forget — the app\'s wording needs revisiting');
  assert.ok(!/sendSms|notifyCustomer/.test(block), 'the reply route now sends a text — the app says "Emailed"');
});

check('the Text button is a handoff to the real Messages app', () => {
  // The honest answer to "can we show the customer's texts": no app can
  // read them, but any app can hand one off. This is that.
  assert.match(THREAD, /Linking\.openURL\(`sms:\$\{to\}`\)/, 'the Text button no longer opens Messages');
  assert.match(THREAD, /customerPhone \? \(/, 'the Text button renders without a number to text');
});

// ---- 3. The cap ---------------------------------------------------------

check("the composer stops where the server truncates, not somewhere else", () => {
  const capMatch = API.match(/export const REPLY_MAX = (\d+);/);
  assert.ok(capMatch, 'REPLY_MAX is gone from the api layer');
  const appCap = Number(capMatch[1]);

  // The server's own number, read out of the route rather than assumed.
  const at = SERVER.indexOf('if (req.method === "POST" && sub === "/reply")');
  const block = SERVER.slice(at, at + 600);
  const serverMatch = block.match(/normalizeString\(payload\?\.message,\s*(\d+)\)/);
  assert.ok(serverMatch, "the reply route's length cap moved");
  assert.equal(appCap, Number(serverMatch[1]),
    'the composer and the server disagree about how long a reply may be, so the tech is told a truncated reply went whole');

  // And the screen actually uses it rather than a literal of its own.
  assert.match(THREAD, /draft\.length > REPLY_MAX/, 'the composer does not enforce the cap');
  assert.ok(!/1500/.test(THREAD), 'the thread screen hardcodes the cap instead of importing it');
});

// ---- The list -----------------------------------------------------------

check('a thread preview says who said the last thing', () => {
  const previewOf = lift(LIST, 'previewOf');
  assert.equal(previewOf({ lastMessage: { from: 'customer', body: 'Is Thursday ok?' } }), 'Is Thursday ok?');
  // Without the prefix a list of threads reads as though the customer
  // said everything in it.
  assert.equal(previewOf({ lastMessage: { from: 'admin', body: 'Yes, 9am.' } }), 'You: Yes, 9am.');
  // A two-line message in a one-line row silently loses its second half.
  assert.equal(previewOf({ lastMessage: { from: 'customer', body: 'line one\nline two' } }), 'line one line two');
  assert.equal(previewOf({ lastMessage: { from: 'customer', body: '   padded   ' } }), 'padded');
  assert.equal(previewOf({}), 'No messages yet');
  assert.equal(previewOf(null), 'No messages yet');
  assert.equal(previewOf({ lastMessage: { from: 'customer', body: '' } }), 'No messages yet');
});

check('the day divider appears exactly when the day turns over', () => {
  const withDayDividers = lift(THREAD, 'withDayDividers', `
    const dayKey = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toDateString();
    };
  `);
  const rows = withDayDividers([
    { id: 'a', ts: '2026-09-01T14:00:00Z', from: 'customer', body: 'one' },
    { id: 'b', ts: '2026-09-01T15:00:00Z', from: 'admin', body: 'two' },
    { id: 'c', ts: '2026-09-03T09:00:00Z', from: 'customer', body: 'three' },
  ]);
  const kinds = rows.map((r) => r.kind);
  // day, msg, msg, day, msg — one divider per day, never between two
  // messages from the same one.
  assert.deepEqual(kinds, ['day', 'msg', 'msg', 'day', 'msg']);
  assert.equal(rows.filter((r) => r.kind === 'day').length, 2);
  assert.deepEqual(withDayDividers([]), []);
  assert.deepEqual(withDayDividers(null), []);
  // A row with no usable timestamp still renders its message rather than
  // vanishing, and does not open a day of its own.
  const odd = withDayDividers([{ id: 'x', ts: 'nonsense', from: 'customer', body: 'hi' }]);
  assert.deepEqual(odd.map((r) => r.kind), ['msg']);
  // Every row needs a key that FlatList can use.
  for (const r of rows) assert.ok(r.id, 'a row came back with no key');
});

check('the thread list stamps a time the way a messages list does', () => {
  const messageStamp = lift(FORMAT, 'messageStamp');
  const now = Date.parse('2026-09-08T12:00:00Z');
  // "9:41 AM" on a message from March is a lie about how recent it is.
  assert.ok(/\d/.test(messageStamp('2026-09-08T09:41:00Z', now)), 'today has no clock');
  const march = messageStamp('2026-03-02T09:41:00Z', now);
  assert.ok(!/:/.test(march), `a message from March is stamped with a clock: ${march}`);
  assert.equal(messageStamp('', now), '');
  assert.equal(messageStamp(null, now), '');
  assert.equal(messageStamp('nonsense', now), '');
});

check('the avatar carries initials that mean something', () => {
  const initials = lift(FORMAT, 'initials');
  assert.equal(initials('Kristen Holmes'), 'KH');
  assert.equal(initials('Patrick'), 'P');
  assert.equal(initials('  mary  jane  watson '), 'MW');
  // Never blank: an empty circle in a column of full ones reads as a
  // rendering fault rather than as a missing name.
  assert.equal(initials(''), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials(undefined), '?');
});

// ---- The wire -----------------------------------------------------------

check('the app calls the routes the server actually serves', () => {
  for (const [appPath, serverCheck] of [
    ["'/api/admin/portal-messages'", 'pathname === "/api/admin/portal-messages"'],
    ['/api/admin/portal-messages/${encodeURIComponent(leadId)}', 'portal-messages'],
  ]) {
    assert.ok(API.includes(appPath), `the app no longer calls ${appPath}`);
    assert.ok(SERVER.includes(serverCheck), `the server no longer serves ${serverCheck}`);
  }
  // The two sub-routes, matched by the server's own regex.
  const re = SERVER.match(/pathname\.match\(\/\^\\\/api\\\/admin\\\/portal-messages\\\/\(\[\^\/\]\+\)\(\\\/reply\|\\\/read\)\?\$\/\)/);
  assert.ok(re, "the thread route's shape changed");
  assert.match(API, /\/reply`/, 'the app no longer posts replies');
  assert.match(API, /\/read`/, 'the app no longer marks threads read');
});

check('reading and replying is open to a tech, not just an admin', () => {
  // Executed, not read. needsAuth is first-match-wins and ends in
  // `return null` — no auth — for anything it does not name, which is
  // how a route goes public by omission.
  const start = SERVER.indexOf('function needsAuth(method, pathname) {');
  assert.ok(start > 0, 'needsAuth not found');
  const end = SERVER.indexOf('\n}\n', start);
  const needsAuth = new Function(`${SERVER.slice(start, end + 3)}; return needsAuth;`)();

  assert.equal(needsAuth('GET', '/api/admin/portal-messages'), 'user');
  assert.equal(needsAuth('GET', '/api/admin/portal-messages/L-1'), 'user');
  assert.equal(needsAuth('POST', '/api/admin/portal-messages/L-1/reply'), 'user');
  assert.equal(needsAuth('POST', '/api/admin/portal-messages/L-1/read'), 'user');
  // Never null. A messages inbox open to the internet is the 2026-09-06
  // Terminal-token hole with names and phone numbers in it.
  for (const p of [
    '/api/admin/portal-messages',
    '/api/admin/portal-messages/L-1',
    '/api/admin/portal-messages/L-1/reply',
  ]) {
    assert.ok(needsAuth('GET', p), `${p} is not behind the fence`);
  }
});

// ---- The overlay's way out ----------------------------------------------

check('the thread renders its exit in EVERY state, not just the ready one', () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  const babel = requireFromApp('@babel/core');
  const rel = 'pjl-field/src/screens/ThreadScreen.js';
  const ast = babel.parse(THREAD, {
    filename: rel,
    parserOpts: { sourceType: 'module', plugins: ['jsx'] },
    babelrc: false, configFile: false, ast: true, code: false,
  });
  let body = null;
  for (const node of ast.program.body) {
    const fn = node.type === 'ExportDefaultDeclaration' ? node.declaration : null;
    if (fn && fn.type === 'FunctionDeclaration' && fn.id?.name === 'ThreadScreen') body = fn.body.body;
  }
  assert.ok(body, 'ThreadScreen is no longer the default export');

  // A hoisted `const exitBar = (...)` counts as carrying the exit.
  const carriers = new Set(['onBack']);
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (!d.init || d.id.type !== 'Identifier') continue;
      if (THREAD.slice(d.init.start, d.init.end).includes('onBack')) carriers.add(d.id.name);
    }
  }
  const offenders = [];
  for (const stmt of body) {
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
      const src = THREAD.slice(ret.argument.start, ret.argument.end);
      if (![...carriers].some((n) => src.includes(n))) offenders.push(`line ${ret.loc.start.line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `ThreadScreen returns with no way out at ${offenders.join(', ')} — that state is a force-quit`);
});

check('the sign-in sits above the job overlay, and both are modal', () => {
  // A session can expire while a closing is open, so the sign-in has to
  // reach over whatever is already on screen.
  const jobAt = APP.indexOf('{job ? (');
  const signInAt = APP.indexOf('{signInOpen ? (');
  assert.ok(jobAt > 0 && signInAt > jobAt, 'the sign-in no longer renders over the job overlay');
  const block = APP.slice(signInAt, APP.indexOf('const styles', signInAt));
  assert.match(block, /accessibilityViewIsModal/, 'the sign-in is not modal to VoiceOver');
  assert.match(block, /onCancel=/, 'the sign-in has no way out');
});

// ---- These screens parse as the app will read them ----------------------

check("every new screen parses with the app's own Babel", () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail("the app's dependencies are not installed — run npm ci in pjl-field"); }
  for (const rel of [
    'pjl-field/App.js',
    'pjl-field/src/api.js',
    'pjl-field/src/format.js',
    'pjl-field/src/theme.js',
    'pjl-field/src/screens/MessagesScreen.js',
    'pjl-field/src/screens/ThreadScreen.js',
    'pjl-field/src/screens/SignInScreen.js',
  ]) {
    babel.parse(read(rel), {
      filename: rel,
      parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      babelrc: false,
      configFile: false,
    });
  }
});

console.log(`\nmessages: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

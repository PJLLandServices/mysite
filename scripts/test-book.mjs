// The field app's Book tab.
//
//   node scripts/test-book.mjs
//
// Four things about booking from a truck can go wrong quietly, and each
// is executed here rather than read:
//
//   1. A SECOND PROPERTY for an address PJL already services. That
//      splits the address's history, invoices and work orders in two,
//      and nothing on screen says it happened. Existing customers are
//      searched FIRST, and the reuse has to actually reuse.
//   2. A DATE OFFERED BEFORE THE ADDRESS IS GEOCODED. The whole booking
//      gate — junk addresses, out-of-area, drive-time corridor — hangs
//      off the geocode. Offer days first and the calendar is a promise
//      nobody checked.
//   3. THE ZONE ANSWER CONTRADICTING ITSELF. The service key carries the
//      zone BAND (price and visit length); the count is what is in the
//      ground. "7" beside "1-4 zones" is a mispriced visit.
//   4. BOOK APPEARING FOR A TECH. Booking work onto the calendar is a
//      business decision. The gate must fail CLOSED.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('pjl-field/App.js');
const API = read('pjl-field/src/api.js');
const BOOK = read('pjl-field/src/screens/BookScreen.js');
const SERVER = read('server/server.js');
const AVAILABILITY = read('server/lib/availability.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

function lift(source, name, deps = '') {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `${name} is not an exported function`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  const body = source.slice(start, end + 3).replace('export function', 'function');
  return new Function(`${deps}\n${body}\nreturn ${name};`)();
}

// ---- 1. Existing customers come first -----------------------------------

check('the book is searched by name AND by address', () => {
  const matchProperties = lift(BOOK, 'matchProperties');
  const all = [
    { id: 'p1', customerName: 'Kristen Holmes', address: '90 Oriole Dr, Aurora' },
    { id: 'p2', customerName: 'Dave Chen', address: '4293 ON-7, Markham' },
  ];
  // A tech has whichever of the two they have.
  assert.deepEqual(matchProperties(all, 'holmes').map((p) => p.id), ['p1']);
  assert.deepEqual(matchProperties(all, 'oriole').map((p) => p.id), ['p1']);
  assert.deepEqual(matchProperties(all, '4293').map((p) => p.id), ['p2']);
  assert.deepEqual(matchProperties(all, 'HOLMES').map((p) => p.id), ['p1'], 'search is case-sensitive');
  // One character is every property in the book; the list would be
  // useless and the typing is not finished.
  assert.deepEqual(matchProperties(all, 'h'), []);
  assert.deepEqual(matchProperties(all, ''), []);
  assert.deepEqual(matchProperties(all, null), []);
  assert.deepEqual(matchProperties(null, 'holmes'), []);
  // A property with no name must not crash the search.
  assert.doesNotThrow(() => matchProperties([{ id: 'p3' }], 'holmes'));
});

check('search comes before "New customer", in that order, on screen', () => {
  // The expensive mistake is a duplicate property, so the cheap path has
  // to be the default one. Order in the source IS order on screen here.
  const searchAt = BOOK.indexOf('placeholder="Name or address"');
  const newAt = BOOK.indexOf('New customer</Text>');
  assert.ok(searchAt > 0, 'the search box is gone');
  assert.ok(newAt > searchAt, '"New customer" now sits above the search');
});

check('an existing customer is reused, not re-created', () => {
  // NOT by leadId: that path overwrites lead.booking, so pointing it at
  // a won lead from two seasons ago would wipe that visit's envelope.
  // The customer's stored email + address go up instead, and the
  // server's own attachLead binds the new lead to the property it
  // already matches.
  // Comments stripped: this file EXPLAINS at length why it does not send
  // leadId, and the explanation must not trip the check that enforces it.
  const code = BOOK
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/leadId/.test(code), 'the screen sends leadId, which would overwrite an old booking');
  // attachLead lives in lib/properties.js, not the server file. It is what
  // binds a new lead to an existing property by address and email — the
  // whole mechanism this screen relies on instead of leadId.
  const PROPERTIES = read('server/lib/properties.js');
  assert.match(PROPERTIES, /async function attachLead\(\{ leadId, email, name, phone, address, coords/,
    'attachLead changed shape — the reuse-by-address assumption needs rechecking');
  // Everything known about the customer is prefilled, so a tech never
  // retypes a phone number into a second spelling of the same person.
  const at = BOOK.indexOf('const choose = (property)');
  assert.ok(at > 0, 'choosing an existing property is gone');
  const block = BOOK.slice(at, BOOK.indexOf('};', at));
  for (const field of ['customerName', 'customerPhone', 'customerEmail', 'address']) {
    assert.ok(block.includes(field), `${field} is no longer carried over from the property on file`);
  }
});

check('the zone count on file is the walked record, not the told-us number', () => {
  const zonesOnFile = lift(BOOK, 'zonesOnFile');
  // zones[] beats system.zoneCount — the same rule lib/properties.js sets.
  assert.equal(zonesOnFile({ system: { zones: [1, 2, 3], zoneCount: 9 } }), 3);
  assert.equal(zonesOnFile({ system: { zoneCount: 9 } }), 9);
  assert.equal(zonesOnFile({ system: { zones: [], zoneCount: 6 } }), 6);
  assert.equal(zonesOnFile({ system: {} }), null);
  assert.equal(zonesOnFile({}), null);
  assert.equal(zonesOnFile(null), null);
  // Zero is not a zone count, it is a missing one.
  assert.equal(zonesOnFile({ system: { zoneCount: 0 } }), null);
});

// ---- 2. The geocode happens before any date -----------------------------

check('no day is offered until the address has passed the booking gate', () => {
  const loadAt = BOOK.indexOf('const loadDays = async');
  assert.ok(loadAt > 0, 'the availability step is gone');
  const block = BOOK.slice(loadAt, BOOK.indexOf('};', loadAt));
  assert.match(block, /if \(!verified \|\| !serviceKey\) return;/,
    'availability can be requested before the address is verified');
  // And availability is asked against GOOGLE's address, not the typed
  // one, so the corridor is computed against the point the pin lands on.
  assert.match(block, /address: verified\.address/, 'availability uses the typed address, not the geocoded one');
  // The button is disabled too — a guard the user can see beats one they
  // discover.
  assert.match(BOOK, /disabled=\{!verified \|\| !serviceKey \|\| loadingDays\}/);
  // Editing the address after verifying must drop the verification.
  assert.match(BOOK, /onChangeText=\{\(v\) => \{ setAddress\(v\); setVerified\(null\); \}\}/,
    'an edited address keeps its old verification');
});

check('the app calls the same gate the website does', () => {
  // A second booking path is a second set of rules about who may book and
  // how far the corridor stretches. There is one.
  assert.match(API, /\/api\/booking\/verify-address/);
  assert.match(API, /\/api\/booking\/availability\?service=/);
  assert.match(API, /\/api\/booking\/reserve/);
  for (const route of [
    'pathname === "/api/booking/verify-address"',
    'pathname === "/api/booking/availability"',
    'pathname === "/api/booking/reserve"',
  ]) {
    assert.ok(SERVER.includes(route), `the server no longer serves ${route}`);
  }
  // verify-address really does run the gate — if it stops, "checked
  // against the service area" on screen becomes a false claim.
  const at = SERVER.indexOf('pathname === "/api/booking/verify-address"');
  const block = SERVER.slice(at, at + 1200);
  assert.match(block, /bookingGate\.gate\(geo/, 'verify-address no longer runs the booking gate');
  assert.match(block, /geo\.coords\?\.formattedAddress/, 'verify-address no longer returns the geocoded address');
});

// ---- 3. Zones: band and count agree -------------------------------------

check('typing a zone count moves the service to the band that holds it', () => {
  const serviceForZones = lift(BOOK, 'serviceForZones');
  const list = [
    { key: 'spring_open_4z', family: 'spring_opening', category: 'seasonal' },
    { key: 'spring_open_6z', family: 'spring_opening', category: 'seasonal' },
    { key: 'spring_open_8z', family: 'spring_opening', category: 'seasonal' },
    { key: 'spring_open_15z', family: 'spring_opening', category: 'seasonal' },
    { key: 'spring_open_16plus', family: 'spring_opening', category: 'seasonal' },
    { key: 'spring_open_commercial', family: 'spring_opening', category: 'commercial' },
  ];
  const k = (n) => serviceForZones(list, 'spring_opening', n)?.key;
  assert.equal(k(1), 'spring_open_4z');
  assert.equal(k(4), 'spring_open_4z');
  assert.equal(k(5), 'spring_open_6z', 'the boundary between bands is off by one');
  assert.equal(k(6), 'spring_open_6z');
  assert.equal(k(7), 'spring_open_8z');
  assert.equal(k(8), 'spring_open_8z');
  assert.equal(k(9), 'spring_open_15z');
  assert.equal(k(15), 'spring_open_15z');
  assert.equal(k(16), 'spring_open_16plus');
  assert.equal(k(50), 'spring_open_16plus');
  // A commercial site has no residential band and must not be forced
  // into one.
  assert.equal(serviceForZones(list, 'spring_opening', 0), null);
  assert.equal(serviceForZones(list, 'spring_opening', ''), null);
  assert.equal(serviceForZones(list, null, 6), null);
  assert.equal(serviceForZones([], 'spring_opening', 6), null);
  // And it never reaches across families.
  assert.equal(serviceForZones(list, 'fall_closing', 6), null);
});

check("the server's own bands are the ones being matched", () => {
  // The band regex reads `_(\d+)z` off the key. If the server renames
  // its keys, that silently stops matching and every booking lands in
  // the wrong band at the wrong price.
  for (const key of [
    'spring_open_4z', 'spring_open_6z', 'spring_open_8z',
    'spring_open_15z', 'spring_open_16plus',
  ]) {
    assert.ok(AVAILABILITY.includes(`${key}:`), `the server no longer has the service ${key}`);
  }
  assert.match(AVAILABILITY, /family: "spring_opening"/, 'the service family field is gone');
});

check('both zone answers are sent, and they are different things', () => {
  // The band is what we are selling; the count is what the tech will
  // find in the ground. Patrick asked for both.
  const at = BOOK.indexOf('const confirm = async');
  const block = BOOK.slice(at, BOOK.indexOf('const reset =', at));
  assert.match(block, /serviceKey,/, 'the service band is no longer sent');
  assert.match(block, /zoneCount: clean\(zoneCount\) \|\| 'unsure'/, 'the actual zone count is no longer sent');
  // "unsure" is a value the server understands — an empty string is not.
  const rAt = SERVER.indexOf('if (req.method === "POST" && pathname === "/api/booking/reserve")');
  assert.ok(SERVER.slice(rAt, rAt + 20000).includes('=== "unsure"'),
    'the server no longer accepts "unsure" as a zone count');
});

check('the full contact is captured, including the second phone', () => {
  for (const field of ['First name', 'Last name', 'Telephone', 'Alternate telephone', 'Email']) {
    assert.ok(BOOK.includes(`label="${field}"`), `the booking form lost its ${field} field`);
  }
  const at = BOOK.indexOf('const confirm = async');
  const block = BOOK.slice(at, BOOK.indexOf('const reset =', at));
  // `name` because that is what validateLead reads; first and last kept
  // beside it because that is what the customer record wants.
  assert.match(block, /name,/, 'the joined name is no longer sent, and validateLead reads contact.name');
  for (const f of ['firstName', 'lastName', 'phone', 'altPhone', 'email', 'address', 'notes']) {
    assert.match(block, new RegExp(`${f}:`), `the booking no longer sends ${f}`);
  }
  assert.match(SERVER, /const name = normalizeString\(contact\.name, 120\);/,
    'validateLead stopped reading contact.name — the joined name would be dropped');
});

// ---- 4. The gate fails closed -------------------------------------------

check('Book is admin-only, and the gate fails closed', () => {
  const start = APP.indexOf('const TABS = [');
  const block = APP.slice(start, APP.indexOf('];', start) + 2);
  const rows = [...block.matchAll(/\{[^}]*key:\s*'([a-z]+)'[^}]*\}/g)]
    .map((m) => ({ key: m[1], admin: /admin:\s*true/.test(m[0]) }));
  const bookRow = rows.find((r) => r.key === 'book');
  assert.ok(bookRow, 'there is no Book tab');
  assert.ok(bookRow.admin, 'the Book tab is no longer admin-gated');

  const tabsForRole = lift(APP, 'tabsForRole', `const TABS = ${JSON.stringify(rows)};`);
  assert.ok(tabsForRole('admin').some((t) => t.key === 'book'));
  for (const role of ['tech', 'customer', null, undefined, '', 'ADMIN', 'admin ']) {
    assert.ok(!tabsForRole(role).some((t) => t.key === 'book'),
      `role ${JSON.stringify(role)} can see the Book tab`);
  }
});

check('the role comes from the server, and is re-asked on every sign-in', () => {
  assert.match(APP, /getSession\(\)/, 'the app no longer asks who is signed in');
  assert.match(API, /export const getSession/);
  assert.match(API, /\/api\/session/);
  // Re-asked on sign-in: the person signing in is not necessarily the
  // person who signed out.
  const at = APP.indexOf('getSession()');
  const block = APP.slice(at, APP.indexOf('}, [', at) + 20);
  assert.match(block, /\}, \[signedIn\]\)/, 'the role is not re-read after a sign-in');
  // Unauthenticated is not admin.
  assert.match(APP, /setRole\(s\.authenticated \? s\.role : null\)/);
  assert.match(APP, /\.catch\(\(\) => \{ if \(alive\) setRole\(null\); \}\)/,
    'a failed session lookup leaves the previous role in place');
});

// ---- It parses ----------------------------------------------------------

check("the Book screen parses with the app's own Babel", () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail("the app's dependencies are not installed — run npm ci in pjl-field"); }
  for (const rel of ['pjl-field/App.js', 'pjl-field/src/api.js', 'pjl-field/src/screens/BookScreen.js']) {
    babel.parse(read(rel), {
      filename: rel,
      parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      babelrc: false,
      configFile: false,
    });
  }
});

console.log(`\nbook: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

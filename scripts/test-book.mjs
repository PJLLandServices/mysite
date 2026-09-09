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
//   5. A SLIDE THAT SCROLLS. "flows are big for me. I currently have to
//      scroll through." The service questions are selects opening one
//      shared sheet, so no slide grows past a few rows — and swiping back
//      must not strand you behind work you have already done.

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
const CATALOG = read('pjl-field/src/booking-catalog.js');
const SERVER = read('server/server.js');
const AVAILABILITY = read('server/lib/availability.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n').slice(0,6).join('\n    ')}`); }
};

// Lifts an exported const (an array or object literal) out of a module.
function liftConst(source, name) {
  const start = source.indexOf(`export const ${name} = `);
  assert.ok(start > 0, `${name} is not an exported const`);
  const end = source.indexOf('\n];', start) >= 0 ? source.indexOf('\n];', start) + 3 : source.indexOf('\n};', start) + 3;
  const body = source.slice(start, end).replace('export const', 'const');
  return new Function(`${body}\nreturn ${name};`)();
}

// Lifts a function out of booking-catalog.js along with whatever else in
// that file it closes over. The module is pure by design so this works.
function liftCatalog(name, needs) {
  const grab = (n) => {
    const fnAt = CATALOG.indexOf(`export function ${n}(`);
    if (fnAt >= 0) {
      return CATALOG.slice(fnAt, CATALOG.indexOf('\n}\n', fnAt) + 3).replace('export function', 'function');
    }
    const constAt = CATALOG.indexOf(`export const ${n} = `);
    assert.ok(constAt > 0, `${n} is not exported from booking-catalog`);
    // The NEAREST terminator, not the first one of a preferred shape:
    // `isCommercialKey` is a one-line arrow, and reaching for the next
    // `\n];` swallowed the rest of the file including its exports.
    const ends = [
      CATALOG.indexOf('\n];', constAt) + 3,
      CATALOG.indexOf('\n};', constAt) + 3,
      CATALOG.indexOf(';\n', constAt) + 1,
    ].filter((i) => i > constAt);
    assert.ok(ends.length, `could not find the end of ${n}`);
    return CATALOG.slice(constAt, Math.min(...ends)).replace('export const', 'const');
  };
  const parts = (needs || []).map(grab).join('\n');
  return new Function(`${parts}\n${grab(name)}\nreturn ${name};`)();
}

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

const STEPS_SRC = BOOK.slice(
  BOOK.indexOf('export const STEPS ='),
  BOOK.indexOf(';', BOOK.indexOf('export const STEPS =')) + 1,
).replace('export const', 'const');
const STEPS = new Function(`${STEPS_SRC}\nreturn STEPS;`)();

check('the steps run address, service, days, then who — the order of a phone call', () => {
  // Patrick's own sequence: "request that customers address … it shows me
  // JUST LIKE WHEN I search on desktop … Once i show them the booking
  // dates, I select the date they accept". Asking for a name before a day
  // can be offered means holding a stranger on the phone while you type.
  //
  // The service questions have a slide of their own. Stacked under the
  // address they made the one slide that must stay short — the one with a
  // keyboard over it — into the longest in the app.
  assert.deepEqual(STEPS, ['address', 'service', 'when', 'who']);
  assert.ok(STEPS.indexOf('address') < STEPS.indexOf('service'), 'a service is chosen before an address');
  assert.ok(STEPS.indexOf('service') < STEPS.indexOf('when'), 'days are offered before we know what for');
  assert.ok(STEPS.indexOf('when') < STEPS.indexOf('who'), 'a name is asked for before a day is offered');
});

check('the address box suggests as you type, and the book is offered first', () => {
  // "a place to type in address with autocomplete", and the existing
  // customer for that address announces itself before anything is made.
  assert.match(BOOK, /suggestAddresses/, 'the address box no longer suggests anything');
  assert.match(API, /\/api\/admin\/address-suggest\?q=/);
  const onFileAt = BOOK.indexOf('Already in the book');
  const suggestAt = BOOK.indexOf('>Suggestions<');
  assert.ok(onFileAt > 0, 'existing customers are no longer offered');
  assert.ok(suggestAt > 0, 'address suggestions are gone');
  assert.ok(onFileAt < suggestAt, 'Google suggestions now sit above the customers already in the book');
});

check('the suggestion proxy costs money, so it is fenced and throttled', () => {
  const start = SERVER.indexOf('function needsAuth(method, pathname) {');
  const end = SERVER.indexOf('\n}\n', start);
  const needsAuth = new Function(`${SERVER.slice(start, end + 3)}; return needsAuth;`)();
  // NOT under /api/booking/, which is the public booking tree — a Places
  // proxy anyone can call is a Google bill anyone can run up.
  assert.equal(needsAuth('GET', '/api/admin/address-suggest'), 'user');
  assert.ok(!SERVER.includes('"/api/booking/address-suggest"'), 'the proxy moved into the public tree');
  // The HANDLER, not the needsAuth rule — both name the same path, and
  // indexOf finds the fence first.
  const at = SERVER.indexOf('req.method === "GET" && pathname === "/api/admin/address-suggest"');
  assert.ok(at > 0, 'the suggestion route is gone');
  const block = SERVER.slice(at, at + 2200);
  assert.match(block, /q\.length < 3/, 'two characters is every address in Ontario');
  assert.match(block, /country:ca/, 'the box will suggest Aurora, Colorado');
  assert.match(block, /suggestions: \[\], degraded/, 'a missing key fails the whole screen');
  // Debounced on the client: every keystroke is a paid call.
  assert.match(BOOK, /setTimeout\(/, 'suggestions fire on every keystroke');
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
  const at = BOOK.indexOf('const takeProperty = (p)');
  assert.ok(at > 0, 'choosing an existing property is gone');
  const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
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
  // A Places suggestion is only a string. verify-address is what runs the
  // gate and returns the coordinates, so picking a suggestion routes
  // through it rather than around it.
  const showAt = BOOK.indexOf('const showDays = async');
  assert.ok(showAt > 0, 'the availability step is gone');
  const block = BOOK.slice(showAt, BOOK.indexOf('\n  };', showAt));
  assert.match(block, /if \(!verified \|\| !key\) return;/,
    'availability can be requested before the address is verified');
  // ONE place asks for days, so the two callers cannot drift about which
  // address they are asking about.
  const fetchAt = BOOK.indexOf('const fetchDays = async');
  assert.ok(fetchAt > 0, 'fetchDays is gone');
  const fetching = BOOK.slice(fetchAt, BOOK.indexOf('\n  };', fetchAt));
  assert.match(fetching, /address: verified\.address/,
    'availability uses the typed address, not the geocoded one');
  assert.equal((BOOK.match(/bookingAvailability\(/g) || []).length, 1,
    'more than one place asks for days');
  // Including the keyboard's own return key, which did nothing at all.
  assert.match(BOOK, /onSubmitEditing=\{\(\) => settleAddress\(typed\)\}/,
    'the return key does not submit the address');
  // Every path to an address goes through settleAddress, which verifies.
  assert.match(BOOK, /onPress=\{\(\) => \{ setTyped\(s\.description\); settleAddress\(s\.description\); \}\}/,
    'a Google suggestion is taken without being verified');
  assert.match(BOOK, /onPress=\{\(\) => settleAddress\(takeProperty\(p\)\)\}/,
    'an address from the book is taken without being verified');
  // Editing the address after verifying must drop the verification — and
  // the days and the slot chosen against it, which are now for an address
  // that no longer exists.
  assert.match(BOOK, /onChangeText=\{\(v\) => \{ setTyped\(v\); unsettle\(\); \}\}/,
    'an edited address keeps its old verification');
  const unsettleAt = BOOK.indexOf('const unsettle = () =>');
  assert.ok(unsettleAt > 0, 'unsettle is gone');
  const unsettled = BOOK.slice(unsettleAt, BOOK.indexOf('\n  };', unsettleAt));
  for (const cleared of ['setVerified', 'setPicked', 'setDays', 'setSlot']) {
    assert.ok(unsettled.includes(cleared), `editing the address leaves ${cleared} behind`);
  }
  // And the slides built on it go with it. Left standing, the day slide
  // reads `verified.address` off null and the screen crashes.
  assert.ok(unsettled.includes("clamp('address')"), 'the later slides survive an edited address');
});

check('the confirmation text names the exact day and time', () => {
  // Patrick: "I send them a text message with that EXACT BOOKING DAY for
  // that appointment time." Not "your appointment is confirmed", which
  // tells someone on the phone nothing they can write down.
  const confirmationText = lift(BOOK, 'confirmationText');
  const body = confirmationText({
    dayLabel: 'Thursday, Oct 2',
    timeLabel: '9:00-11:00 AM',
    serviceLabel: 'Fall closing (5-6 zones residential)',
    address: '90 Oriole Dr, Aurora',
  });
  assert.ok(body.includes('Thursday, Oct 2'), 'the text does not name the day');
  assert.ok(body.includes('9:00-11:00 AM'), 'the text does not name the time');
  assert.ok(body.includes('90 Oriole Dr, Aurora'), 'the text does not name the address');
  assert.ok(body.includes('PJL'), 'the text does not say who it is from');
  // Missing pieces must not print "undefined" at a customer.
  assert.ok(!/undefined|null/.test(confirmationText({ dayLabel: 'Fri' })));
  // And it is a HANDOFF from Patrick's own number, so they can reply.
  assert.match(BOOK, /sms:\$\{to\}\?body=/, 'the confirmation is not sent from the phone');
  assert.ok(!/sms:\$\{to\}&body=/.test(BOOK), 'the iOS-only separator is back');
});

check('the second phone number is stored and shown, not swallowed', () => {
  // It was captured on screen and dropped by the server, which makes the
  // form lie about what it collected.
  assert.match(SERVER, /const altPhone = normalizePhone\(contact\.altPhone\);/,
    'altPhone is not normalized, so it is dropped');
  assert.match(SERVER, /\.\.\.\(altPhone \? \{ altPhone \} : \{\}\)/,
    'altPhone is not stored on the lead contact');
  assert.match(SERVER, /Lead contact \(alternate\)/,
    'altPhone is stored but never shown, which is the same as not capturing it');
  // Additive: a lead without one is the record it always was.
  assert.ok(!/altPhone: ""/.test(SERVER), 'an empty altPhone is being written onto every lead');
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

check('nineteen services become six questions', () => {
  // Nineteen buttons on a phone means the one you want is scrolled off,
  // and reading them aloud to a customer is not a conversation anyone
  // wants to have. Patrick's shape: six categories, then a follow-up that
  // depends on which.
  const CATEGORIES = liftConst(CATALOG, 'CATEGORIES');
  assert.equal(CATEGORIES.length, 6);
  assert.deepEqual(CATEGORIES.map((c) => c.label), [
    'Fall Closing', 'Spring Opening', 'Residential Service',
    'Commercial Service', 'Site Visit / Scope', 'Hydrawise Retrofit',
  ]);
  // Each names a real service, or a real family.
  const { BOOKABLE_SERVICES } = createRequire(path.join(ROOT, 'package.json'))('./server/lib/availability.js');
  const families = new Set(Object.values(BOOKABLE_SERVICES).map((s) => s.family));
  for (const c of CATEGORIES) {
    if (c.family) assert.ok(families.has(c.family), `no such family: ${c.family}`);
    else assert.ok(BOOKABLE_SERVICES[c.serviceKey], `no such service: ${c.serviceKey}`);
  }
});

check('the season in progress comes first, without anyone editing it', () => {
  const categoriesInOrder = liftCatalog('categoriesInOrder', ['CATEGORIES', 'seasonOfCategory']);
  // September: fall's dates are running, spring's are spent.
  const services = {
    fall_close_4z: { family: 'fall_closing', bookable: true, season: { open: true, bookable: true } },
    spring_open_4z: { family: 'spring_opening', bookable: true, season: { open: false, bookable: false, closed: true } },
    sprinkler_repair: { family: 'sprinkler_repair', bookable: true },
  };
  const order = categoriesInOrder(services).map((c) => c.key);
  assert.equal(order[0], 'fall_closing', 'the season in progress is not first');
  assert.equal(order[order.length - 1], 'spring_opening', 'a spent season is not last');
  // March: the same code puts spring first. Nothing edited.
  const march = categoriesInOrder({
    fall_close_4z: { family: 'fall_closing', bookable: true, season: { open: false, bookable: true, startsOn: '2027-09-28' } },
    spring_open_4z: { family: 'spring_opening', bookable: true, season: { open: true, bookable: true } },
  }).map((c) => c.key);
  assert.equal(march[0], 'spring_opening', 'the order is hardcoded to fall');
  // Year-round work is never sunk to the bottom.
  assert.ok(order.indexOf('residential_service') < order.indexOf('spring_opening'));
});

check('the zone bands are the ones the server actually sells', () => {
  const bandsFor = liftCatalog('bandsFor', ['bandOf', 'isCommercialKey']);
  const bandLabel = liftCatalog('bandLabel', []);
  const { BOOKABLE_SERVICES } = createRequire(path.join(ROOT, 'package.json'))('./server/lib/availability.js');

  for (const family of ['fall_closing', 'spring_opening']) {
    const bands = bandsFor(BOOKABLE_SERVICES, family);
    const res = bands.filter((b) => !b.commercial).map((b) => bandLabel(bands, b));
    const com = bands.filter((b) => b.commercial).map((b) => bandLabel(bands, b));
    assert.deepEqual(res, ['1-4 zones', '5-6 zones', '7-8 zones', '9-15 zones', '16+ zones'],
      `${family} residential bands`);
    // The commercial tiers differ from residential — one 5-8 where
    // residential splits 5-6 and 7-8 — which is why they are listed apart.
    assert.deepEqual(com, ['1-4 zones', '5-8 zones', '9+ zones'], `${family} commercial bands`);
    // Residential first, then commercial, each ascending.
    assert.deepEqual(bands.map((b) => b.commercial), [false, false, false, false, false, true, true, true]);
  }

  // The 1-4 commercial tier carries its range in its LABEL, not its key.
  // Reading the key alone dropped it, and the tier above then claimed the
  // range beneath it — "1-8 zones" for a service that starts at 5.
  const bandOf = liftCatalog('bandOf', []);
  assert.equal(bandOf('fall_close_commercial', 'Fall winterization — commercial (1-4 zones)'), 4);
  assert.equal(bandOf('fall_close_8z', 'anything'), 8);
  assert.equal(bandOf('fall_close_16plus', 'x'), Infinity);
  assert.equal(bandOf('sprinkler_repair', 'Sprinkler repair (default block)'), null);
});

check('typing a zone count moves the band that holds it', () => {
  const bandForZones = liftCatalog('bandForZones', []);
  const bandsFor = liftCatalog('bandsFor', ['bandOf', 'isCommercialKey']);
  const { BOOKABLE_SERVICES } = createRequire(path.join(ROOT, 'package.json'))('./server/lib/availability.js');
  const bands = bandsFor(BOOKABLE_SERVICES, 'fall_closing');
  const k = (n, o) => bandForZones(bands, n, o)?.key;

  assert.equal(k(1), 'fall_close_4z');
  assert.equal(k(4), 'fall_close_4z');
  assert.equal(k(5), 'fall_close_6z', 'the boundary between bands is off by one');
  assert.equal(k(7), 'fall_close_8z');
  assert.equal(k(15), 'fall_close_15z');
  assert.equal(k(16), 'fall_close_16plus');
  assert.equal(k(50), 'fall_close_16plus');
  // A commercial site is not snapped into a residential tier: 7 zones is
  // 5-8 commercial, not 7-8 residential, and they are different prices.
  assert.equal(k(7, { commercial: true }), 'fall_close_commercial_8z');
  assert.equal(k(2, { commercial: true }), 'fall_close_commercial');
  // Asserted on the function itself, not `?.key` — an optional chain on a
  // null result yields undefined, which says nothing about what was
  // returned.
  assert.equal(bandForZones(bands, 0), null);
  assert.equal(bandForZones(bands, ''), null);
  assert.equal(bandForZones(bands, null), null);
  assert.equal(bandForZones([], 6), null);
});

check('the follow-up question depends on the category, and reaches the tech', () => {
  const CATEGORIES = liftConst(CATALOG, 'CATEGORIES');
  const by = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
  assert.equal(by.fall_closing.follow, 'zones');
  assert.equal(by.spring_opening.follow, 'zones');
  assert.equal(by.residential_service.follow, 'issues');
  assert.equal(by.commercial_service.follow, 'issues');
  assert.equal(by.hydrawise_retrofit.follow, 'zones_only');
  assert.equal(by.site_visit.follow, null, 'a site visit is being asked a follow-up');

  // "How many issues" has no server field. Rather than invent one it is
  // written into the notes, labelled, where a tech will read it.
  const catalogNotes = liftCatalog('catalogNotes', ['MANY_ISSUES']);
  assert.match(catalogNotes({ category: by.commercial_service, issueCount: '3' }),
    /Commercial service call\. Issues reported: 3\./);
  assert.match(catalogNotes({ category: by.residential_service, issueCount: '1' }), /Residential/);
  // '8+' is a sentinel, not a number. On a work order it has to read as
  // words — "Issues reported: 8+." tells a tech nothing.
  assert.match(catalogNotes({ category: by.residential_service, issueCount: '8+' }),
    /Issues reported: more than 8\./);
  assert.match(catalogNotes({ category: by.hydrawise_retrofit, zoneCount: '9' }), /Zones: 9\./);
  // Nothing to say is nothing said — not an empty label on the record.
  assert.equal(catalogNotes({ category: by.site_visit }), '');
  assert.equal(catalogNotes({ category: by.fall_closing, zoneCount: '6' }), '');
  assert.equal(catalogNotes({}), '');

  // And what actually gets booked.
  const serviceKeyFor = liftCatalog('serviceKeyFor', []);
  assert.equal(serviceKeyFor(by.fall_closing, { key: 'fall_close_6z' }), 'fall_close_6z');
  assert.equal(serviceKeyFor(by.fall_closing, null), null, 'a seasonal booking resolved without a band');
  assert.equal(serviceKeyFor(by.site_visit, null), 'site_visit');
  assert.equal(serviceKeyFor(null, null), null);
});

check('the address box can be cleared outright', () => {
  assert.match(BOOK, /accessibilityLabel="Clear the address"/, 'there is no clear button');
  // It must clear what the address SETTLED as well as the text. A
  // confirmed address sitting under a half-typed new one is how the wrong
  // property gets booked.
  const at = BOOK.indexOf('const clearAddress = ()');
  assert.ok(at > 0, 'clearAddress is gone');
  const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
  // What the box itself holds, and every answer that hung off it.
  for (const cleared of ['setTyped', 'setCategory', 'setBand', 'setServiceKey', 'setZoneCount', 'setIssueCount']) {
    assert.ok(block.includes(cleared), `clearing the address leaves ${cleared} behind`);
  }
  // AND THE CONTACT. Taking a property from the book fills in its
  // customer's name, phone and email. Clearing the box and typing a
  // different address left them sitting there, and the booking went out
  // under the last customer's name and number.
  for (const cleared of ['setFirstName', 'setLastName', 'setPhone', 'setAltPhone', 'setEmail']) {
    assert.ok(block.includes(cleared), `clearing the address leaves ${cleared} behind`);
  }
  // And the verification, the days and the slot, via the same path an
  // edited address takes — one place, so the two cannot disagree.
  assert.ok(block.includes('unsettle()'), 'clearing the address keeps its verification');
});

check('the steps can be swiped, and cannot be swiped past', () => {
  assert.match(BOOK, /pagingEnabled/, 'the steps are not swipeable');
  assert.match(BOOK, /const reached = reachedSteps\(furthest\);/);
  assert.match(BOOK, /scrollEnabled=\{reached\.length > 1\}/);

  // You cannot swipe to a day list before there is one.
  const reachedSteps = lift(BOOK, 'reachedSteps', STEPS_SRC);
  assert.deepEqual(reachedSteps('address'), ['address']);
  assert.deepEqual(reachedSteps('service'), ['address', 'service']);
  assert.deepEqual(reachedSteps('who'), STEPS);
  // A garbled value must not open the whole flow.
  assert.deepEqual(reachedSteps(null), ['address']);
  assert.deepEqual(reachedSteps('nonsense'), ['address']);

  // And swiping BACK must not strand you. The extent is the furthest step
  // reached, not the one you are standing on — reading it off the current
  // step collapsed the pager to a single page the moment you swiped back,
  // and you had to re-tap forward through work already done.
  const laterStep = lift(BOOK, 'laterStep', STEPS_SRC);
  assert.equal(laterStep('who', 'address'), 'who', 'going back shortens the pager');
  assert.equal(laterStep('address', 'when'), 'when');
  assert.equal(laterStep('service', 'service'), 'service');
  // The gesture and the buttons drive the same state, so the pips, the
  // back links and the page can never disagree.
  assert.match(BOOK, /onMomentumScrollEnd/);
  assert.match(BOOK, /pagerRef\.current\?\.scrollTo/);
  // Width is measured, not assumed — handsets differ.
  assert.match(BOOK, /onLayout=\{\(\{ nativeEvent \}\) => setPageWidth/);
});

check('the details step shows what the cascade asked, and does not ask again', () => {
  const at = BOOK.indexOf("{step === 'who'");
  assert.ok(at > 0, 'the details step is gone');
  const block = BOOK.slice(at, BOOK.indexOf("</>\n        ) : null}", at));
  // Contact details are still asked for.
  for (const field of ['First name', 'Last name', 'Telephone', 'Alternate telephone', 'Email']) {
    assert.ok(block.includes(`label="${field}"`), `the details step lost ${field}`);
  }
  // The zone count is DISPLAYED, not re-asked — two prompts for one
  // number is how the two answers end up disagreeing.
  assert.ok(!/label="Zone count"/.test(block), 'the details step asks for zones again');
  assert.ok(!/onChange=\{onZones\}/.test(block), 'the details step edits the zone count again');
  assert.match(block, /Booking<\/Text>/, 'the details step does not say what is being booked');
  // And it says it ONCE, in the summary card at the top — not as three
  // more rows under the form, which read as fields left to fill in.
  const card = block.slice(block.indexOf('styles.holding'), block.indexOf('Their details'));
  for (const shown of ['verified.address', 'zoneCountLabel(zoneCount)', 'issueCountLabel(issueCount)']) {
    assert.ok(card.includes(shown), `the summary card does not carry ${shown}`);
  }
  assert.ok(!/styles\.bandLabel/.test(block), 'the read-only rows are still under the form');
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

check('a full calendar is never a dead end — First available is always there', () => {
  // The website's picker carries this card ALWAYS (allowOpenBucket: true
  // in js/booking.js) and selecting it books NO slot: the customer joins
  // the standby list and is placed onto a route day later. Without it,
  // an address the corridor cannot place efficiently — past the
  // 40-minute widening cap — reads as "there is no space", which is
  // false and loses the job. That is exactly what Patrick hit.
  assert.match(BOOK, /First available/, 'the open bucket is gone from the picker');
  const openBucketAllowed = lift(BOOK, 'openBucketAllowed');
  assert.equal(openBucketAllowed({ category: 'seasonal' }), true);
  assert.equal(openBucketAllowed({ category: 'repair' }), true);
  // The one exception, and the server enforces it too.
  assert.equal(openBucketAllowed({ category: 'consult' }), false, 'a site visit was offered standby');
  assert.equal(openBucketAllowed(null), false);
  assert.match(SERVER, /code: "standby_unsupported"/, 'the server no longer refuses standby site visits');

  // It is rendered UNCONDITIONALLY, not only when the list came back
  // empty — some customers take it over a date three weeks out.
  const at = BOOK.indexOf('{openBucketAllowed(service) ? (');
  assert.ok(at > 0, 'the First available card is conditional on something');
  const before = BOOK.slice(Math.max(0, at - 400), at);
  assert.ok(!/noneBookable \?/.test(before), 'First available only appears when nothing else does');

  // And it books as standby, with no slot.
  assert.match(BOOK, /slot\.openBucket\s*\?\s*\{ standby: true \}\s*:\s*\{ slotStart: slot\.start, holdToken: hold\?\.token \}/,
    'the open bucket books a real slot, which does not exist');
  // And it takes no hold — there is no slot to hold, which is exactly why
  // the server exempts standby from requiring one.
  const takeAt = BOOK.indexOf('const takeSlot = async');
  assert.ok(takeAt > 0, 'takeSlot is gone');
  const taking = BOOK.slice(takeAt, BOOK.indexOf('\n  };', takeAt));
  assert.match(taking, /if \(slot\.openBucket\) \{ go\('who'\); return; \}/,
    'the open bucket tries to hold a slot that does not exist');
  assert.match(SERVER, /const isStandby = payload\.standby === true;/,
    'the server no longer reads the standby flag');
});

check('"no space" is only said when it is true', () => {
  // The server hands back a reason per day and they are not the same
  // problem. Saying "fully booked" for an out-of-season service, or for
  // an address outside that week's route area, is three lies wearing one
  // sentence.
  const whyNoDays = lift(
    API, 'whyNoDays',
    API.slice(API.indexOf('export const DAY_REASONS'), API.indexOf('};', API.indexOf('export const DAY_REASONS')) + 2)
      .replace('export const', 'const'),
  );
  const day = (reason) => ({ slots: [], reason });
  assert.equal(whyNoDays([day('season_closed'), day('season_closed')]), 'This service is out of season.');
  assert.equal(whyNoDays([day('outside_route_area')]), 'Too far from the routes running that week.');
  assert.equal(whyNoDays([day('no_availability')]), 'Fully booked.');
  assert.equal(whyNoDays([day('season_not_open')]), 'Bookings for this service have not opened yet.');
  // The dominant reason wins, not the first one seen.
  assert.equal(
    whyNoDays([day('no_availability'), day('season_closed'), day('season_closed')]),
    'This service is out of season.',
  );
  // Past days and ordinary non-working days are not reasons anyone needs.
  assert.equal(whyNoDays([day('past'), day('closed')]), 'No open days in the next six weeks.');
  // And if there IS availability, there is nothing to explain.
  assert.equal(whyNoDays([{ slots: [{ start: 'x' }] }]), null);

  // The reason codes are the server's own — if they are renamed this
  // stops matching and every empty day silently reads as "full" again.
  const AVAIL = read('server/lib/availability.js');
  for (const code of ['season_not_open', 'season_closed', 'outside_route_area', 'no_availability']) {
    assert.ok(AVAIL.includes(`"${code}"`) || AVAIL.includes(`'${code}'`),
      `the server no longer emits the day reason ${code}`);
  }
});

check('availability is asked for a RANGE, so the reasons come back at all', () => {
  // Without from/to the server groups only days that HAVE slots, and a
  // screen showing nothing cannot tell full from out-of-season. The
  // desktop picker asks for the range; so does this now.
  assert.match(API, /&from=\$\{encodeURIComponent\(dateKey\(from\)\)\}/);
  assert.match(API, /&to=\$\{encodeURIComponent\(dateKey\(to\)\)\}/);
  assert.match(SERVER, /const fromDate = parseLocalDateKey\(fromParam\);/,
    'the server no longer reads a from/to range');
  assert.match(SERVER, /expandDaysToRange\(slots/, 'the server no longer expands to a full range');
});

check('missing address suggestions say why instead of looking broken', () => {
  // geocode falls back to town centroids without a key, so verify-address
  // still succeeds — which means "no suggestions" is NOT proof the app is
  // broken, and silence here sends someone hunting the wrong fault.
  const at = SERVER.indexOf('req.method === "GET" && pathname === "/api/admin/address-suggest"');
  const block = SERVER.slice(at, at + 4000);
  assert.match(block, /degraded: "no_key"/);
  assert.match(block, /degraded: "upstream"/);
  // Google answers 200 even when refusing. ZERO_RESULTS is an ordinary
  // empty answer; anything else is a fault worth naming, and swallowing
  // it sends someone hunting the app instead of the Google console.
  assert.match(block, /status !== "OK" && status !== "ZERO_RESULTS"/,
    'a Google refusal is swallowed as an empty list again');
  assert.match(block, /googleStatus: status/);
  assert.match(API, /degraded: d\.degraded \|\| null/, 'the app throws the reason away');
  assert.match(API, /googleStatus: d\.googleStatus \|\| null/);

  const suggestReason = lift(BOOK, 'suggestReason');
  assert.match(suggestReason({ degraded: 'no_key' }), /GOOGLE_MAPS_SERVER_KEY is not set/);
  assert.match(
    suggestReason({ degraded: 'google', googleStatus: 'REQUEST_DENIED' }),
    /Places API is probably not enabled/,
  );
  assert.match(suggestReason({ degraded: 'google', googleStatus: 'OVER_QUERY_LIMIT' }), /OVER_QUERY_LIMIT/);
  assert.match(suggestReason({ degraded: 'upstream' }), /Couldn't reach the suggestion service/);
  assert.equal(suggestReason(null), null);
  // Every one of them says the booking still works.
  for (const d of [{ degraded: 'no_key' }, { degraded: 'google' }, { degraded: 'upstream' }]) {
    assert.match(suggestReason(d), /it still books/, 'a failure reads as though booking is blocked');
  }
});

check('a service out of season says so, instead of showing an empty calendar', () => {
  // The actual failure: "Spring opening" picked on 8 September 2026.
  // Spring 2026 ran Mar 1 - Jun 30 and had been over for ten weeks. The
  // picker came back empty and said nothing, which in front of a customer
  // reads as "we're full" — the opposite of the truth.
  const seasonNote = lift(BOOK, 'seasonNote');
  assert.equal(seasonNote({ season: { name: 'fall', open: true } }), null, 'an open season is annotated');
  assert.equal(seasonNote({}), null, 'a year-round service is annotated');
  assert.equal(seasonNote(null), null);
  const thisYear = new Date().getFullYear();
  assert.match(
    seasonNote({ season: { name: 'fall', open: false, bookable: true, startsOn: `${thisYear}-09-28` } }),
    /^Dates from /,
  );
  // A season starting in ANOTHER year says so. Read on 8 September, a bare
  // "Dates from Mar 1" is next March — and reads like this March, which
  // has been and gone.
  const next = seasonNote({
    season: { name: 'spring', open: false, bookable: true, startsOn: `${thisYear + 1}-03-01` },
  });
  assert.match(next, new RegExp(String(thisYear + 1)), 'a date in another year hides its year');
  assert.ok(!new RegExp(String(thisYear)).test(
    seasonNote({ season: { name: 'fall', open: false, bookable: true, startsOn: `${thisYear}-09-28` } })
      .replace(/\d{1,2}\b/g, ''),
  ), 'this year is spelled out needlessly');
  assert.equal(
    seasonNote({ season: { name: 'spring', open: false, bookable: false, closed: true } }),
    'Season is over for this year',
  );

  // In-season first, but a closed service still shows — Patrick books
  // work the public flow will not, and hiding it is its own lie.
  // The note rides each row of the service sheet…
  assert.match(BOOK, /options: categories\.map\(\(c\) => \(\{ key: c\.key, label: c\.label, note: seasonNote\(c\) \}\)\)/,
    'the service sheet drops the season note');
  // …and stays on the select once it is chosen, so the reason is still on
  // screen when the day list comes back short.
  assert.match(BOOK, /note=\{category \? seasonNote\(category\) : null\}/,
    'the chosen service loses its season note');
  // A spent season is said BEFORE the calendar is asked for. Discovering
  // it as an empty day list reads as "we're full" — the opposite.
  assert.match(BOOK, /category && seasonShut\(category\)/,
    'a spent season is only discovered as an empty calendar');
});

check('the season status comes from the same authority the gate uses', () => {
  // A second copy of "is spring open" is a second answer to it.
  const at = SERVER.indexOf('pathname === "/api/booking/services"');
  assert.ok(at > 0, 'the services route is gone');
  const block = SERVER.slice(at, at + 3000);
  // The route ASKS lib/seasons rather than comparing the bounds itself.
  // One rule, two callers — not two rules that will disagree.
  assert.match(block, /seasonsLib\.publicBookingStatus\(name, todayKey\)/,
    'the route decides the season itself again instead of asking lib/seasons');
  assert.match(block, /seasonsLib\.seasonForFamily\(svc\.family\)/,
    'the family mapping was copied back into the route');
  // And the mapping lives beside the windows, so the two cannot drift
  // from the gate's own.
  const SEASONS_LIB = read('server/lib/seasons.js');
  assert.match(SEASONS_LIB, /function seasonForFamily\(family\)/);
  assert.match(AVAILABILITY, /service\.family === "fall_closing" \? "fall"/,
    "the availability gate's family mapping changed — lib/seasons needs revisiting");
  // Fails soft, exactly as the gate does: a broken seasons.json must not
  // take booking down.
  assert.match(block, /catch \(err\) \{/);
  assert.match(block, /season = null;/);

  // And the answer it produces is RUN against the real season data rather
  // than read off the source. Deliberately without naming the bound
  // fields: test-season-config.mjs keeps a short allowlist of files that
  // may read them, so that the rule has one home, and this file has no
  // business joining it.
  const requireRoot = createRequire(path.join(ROOT, 'package.json'));
  const seasonsLib = requireRoot('./server/lib/seasons.js');
  const asOf = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // The shared helper, not a second copy of the comparison — that copy
  // is exactly what test-season-config.mjs's single-consumer guard is
  // watching for, and it was right to catch it.
  const openOn = (season, todayKey) => seasonsLib.publicBookingStatus(season, todayKey)?.open;
  // The case Patrick actually hit: spring, in September.
  assert.equal(openOn('spring', asOf('2026-09-08')), false,
    'spring reads as open in September, which is what produced the empty calendar');
  // And it is genuinely open in May, so this is not just always false.
  assert.equal(openOn('spring', asOf('2026-05-15')), true);
  // Fall 2026 opens later than it is serviceable — the front of the
  // window is held until routes actually run.
  assert.equal(openOn('fall', asOf('2026-09-08')), false);
  assert.equal(openOn('fall', asOf('2026-10-05')), true);
});

check('the booking window is DATES, not permission — and it binds staff too', () => {
  // Patrick: "booking can be made from Sept 1, but they can only schedule
  // on Sept 28 - Oct 30. after that i have control to open up further
  // bookings." The window is the range of days work may be put on, it has
  // been the rule since day one, and it binds him exactly as it binds the
  // public. An admin path that widened it would put work on days he has
  // not opened — the opposite of the control it gives him.
  const requireRoot2 = createRequire(path.join(ROOT, 'package.json'));
  const seasonsLib2 = requireRoot2('./server/lib/seasons.js');

  const fallNow = seasonsLib2.publicBookingStatus('fall', '2026-09-08');
  assert.equal(fallNow.open, false, 'the 8th reads as inside the schedulable range, which it is not');
  assert.equal(fallNow.bookable, true, 'fall reads as unbookable on the 8th, when booking opened on the 1st');
  assert.equal(fallNow.startsOn, '2026-09-28');
  assert.equal(seasonsLib2.publicBookingStatus('fall', '2026-10-05').open, true);
  const spring = seasonsLib2.publicBookingStatus('spring', '2026-09-08');
  assert.equal(spring.bookable, true);
  assert.equal(spring.startsOn, '2027-03-01');

  // NO admin widening anywhere. One window, everyone.
  assert.ok(!/seasonWindows: adminSession/.test(SERVER), 'staff availability widens the window again');
  assert.ok(!/cfg\.serviceableFrom \|\| null/.test(SERVER),
    'the serviceable window is being used as the booking window again');
  assert.ok(!/scope: "staff"/.test(SERVER), 'the services list answers a different question for staff');
  assert.ok(!/adminBypass/.test(API), 'the app asks the server to bypass a gate again');

  // The wording. "Booking opens September 28" on the 8th told the owner
  // he could not do a thing he had been able to do for a week.
  const seasonNote = lift(BOOK, 'seasonNote');
  const note = seasonNote({ season: { open: false, bookable: true, startsOn: '2026-09-28' } });
  assert.match(note, /^Dates from /, `the note still talks about permission: ${note}`);
  // Comments stripped: the file EXPLAINS why it does not say this, and
  // the explanation must not trip the check that enforces it.
  const bookCode = BOOK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Booking opens/.test(bookCode), 'the "Booking opens" wording is back');
  assert.equal(
    seasonNote({ season: { open: false, bookable: false, closed: true } }),
    'Season is over for this year',
  );
  assert.equal(seasonNote({ season: { open: true } }), null);

  // A season whose dates start later is ORDINARY bookable work: annotated,
  // but not greyed out and not sunk to the bottom.
  const seasonShut = lift(BOOK, 'seasonShut');
  assert.equal(seasonShut({ season: { open: false, bookable: true, startsOn: '2026-09-28' } }), false);
  assert.equal(seasonShut({ season: { open: false, bookable: false, closed: true } }), true);
  assert.equal(seasonShut({}), false);

  // A season whose dates start later stays ordinary bookable work; only a
  // spent one sinks. Covered against the real categories above.
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

// ---- 5. No slide scrolls ------------------------------------------------

check('the service questions are selects, not a list stacked on the screen', () => {
  // "Okay, you have the architecture correct, but I want the cascade to
  // disappear, or become part of the next 'slide' … flows are big for me.
  // I currently have to scroll through." Six services and then eight zone
  // bands, laid out as buttons, was a slide you had to scroll.
  const at = BOOK.indexOf("{step === 'service' ?");
  assert.ok(at > 0, 'there is no service slide');
  const block = BOOK.slice(at, BOOK.indexOf("{/* ---- 3.", at));

  // Every question is one row.
  for (const label of ['Service', 'Zones', 'Exactly how many', 'Issues']) {
    assert.ok(block.includes(`label="${label}"`), `the service slide lost ${label}`);
  }
  // And nothing on it maps a list onto the screen itself.
  assert.ok(!/categories\.map\(/.test(block), 'the services are still stacked on the slide');
  assert.ok(!/bands\.map\(/.test(block), 'the zone bands are still stacked on the slide');
  // The counts are chosen, not typed — a number pad over a slide in the
  // middle of a phone call is the thing being removed.
  assert.ok(!/<TextInput/.test(block), 'the service slide still opens a keyboard');

  // Three rows is the deepest it goes: service, band, exact count.
  const rows = (block.match(/<SelectRow/g) || []).length;
  assert.equal(rows, 4, 'the service slide has a different number of questions');
  // …and only three can be on screen at once, because Issues and the zone
  // questions belong to different categories.
  assert.ok(/category\?\.follow === 'issues'/.test(block));
  assert.ok(/category\?\.follow === 'zones'/.test(block));
});

check('there is ONE sheet in the app, and both tabs open it', () => {
  // It was written twice — the town filter and the service picker — which
  // is two sheets that drift apart on the first change to either.
  const UI = read('pjl-field/src/ui.js');
  const PROPS = read('pjl-field/src/screens/PropertiesScreen.js');
  assert.match(UI, /export function PickerSheet\(/, 'the shared sheet is gone');
  assert.match(UI, /export function SelectRow\(/, 'the shared select is gone');

  for (const [name, src] of [['Book', BOOK], ['Properties', PROPS]]) {
    assert.match(src, /from '\.\.\/ui'/, `${name} does not use the shared sheet`);
    assert.ok(!/<Modal\b/.test(src), `${name} still builds a modal of its own`);
    assert.ok(!/borderTopLeftRadius/.test(src), `${name} still styles a sheet of its own`);
  }
  // The Book screen mounts exactly one, and swaps what it is asking.
  assert.equal((BOOK.match(/<PickerSheet/g) || []).length, 1,
    'the Book screen mounts more than one sheet');
  assert.match(BOOK, /const asking = sheet \? sheets\[sheet\] : null;/);
});

check('the keyboard goes away when the address is settled', () => {
  // It sat over the ✓ and the button beneath it, so picking an address and
  // getting on with the call was two taps and a guess.
  const at = BOOK.indexOf('const settleAddress = async');
  assert.ok(at > 0, 'settleAddress is gone');
  const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
  assert.match(block, /Keyboard\.dismiss\(\)/, 'the keyboard stays up over the confirmation');
  // Before the network call, not after it — the address is settled the
  // moment it is chosen, and the wait is what the spinner is for.
  assert.ok(block.indexOf('Keyboard.dismiss()') < block.indexOf('await verifyAddress'),
    'the keyboard only drops once the server answers');
  // Both ways in go through it: a Google suggestion and one from the book.
  assert.match(BOOK, /settleAddress\(s\.description\)/);
  assert.match(BOOK, /settleAddress\(takeProperty\(p\)\)/);
  // And opening ANY sheet puts it away too. That rule lives in the sheet
  // rather than in each caller, because the second caller forgot it: the
  // Properties tab opened its town list straight from the search box with
  // the keyboard still up over the bottom of it.
  const UI = read('pjl-field/src/ui.js');
  assert.match(UI, /useEffect\(\(\) => \{ if \(visible\) Keyboard\.dismiss\(\); \}, \[visible\]\);/,
    'a sheet can open under a keyboard');
});

check('a reply for an address that has been replaced is dropped', () => {
  // Both round trips outlive the address they were asked about. Clear the
  // box while verify-address is in flight and the cleared address comes
  // back a second later as confirmed; edit it while availability is in
  // flight and you land on a day slide with nothing on it.
  assert.match(BOOK, /const gen = useRef\(0\);/, 'there is no generation counter');
  const bumped = BOOK.slice(BOOK.indexOf('const unsettle = () =>'), BOOK.indexOf('const clearAddress'));
  assert.match(bumped, /gen\.current \+= 1;/, 'abandoning an address does not abandon its requests');
  // BEFORE the "nothing to undo" early return. A verify started a second
  // ago is exactly the case where nothing is settled yet — and the one
  // reply that must not be allowed to land.
  assert.ok(bumped.indexOf('gen.current += 1;') < bumped.indexOf('return;'),
    'typing over an address mid-check lets the old one come back confirmed');

  for (const [fn, take] of [
    ['const settleAddress = async', 'const mine = ++gen.current;'],
    ['const fetchDays = async', 'const mine = gen.current;'],
  ]) {
    const at = BOOK.indexOf(fn);
    assert.ok(at > 0, `${fn} is gone`);
    const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
    assert.ok(block.includes(take), `${fn} does not record which address it is for`);
    // Either shape of the comparison — one bails, the other returns null.
    const compared = block.search(/mine\s*[!=]==\s*gen\.current/);
    assert.ok(compared > 0, `${fn} applies a stale reply`);
    assert.ok(block.indexOf('await') < compared,
      `${fn} checks before it waits, which checks nothing`);
  }
});

check('the exact zone count is scoped to the band, so it cannot contradict it', () => {
  const zoneOptionsFor = liftCatalog('zoneOptionsFor', []);
  const bandsFor = liftCatalog('bandsFor', ['bandOf', 'isCommercialKey']);
  const { BOOKABLE_SERVICES } = createRequire(path.join(ROOT, 'package.json'))('./server/lib/availability.js');
  const bands = bandsFor(BOOKABLE_SERVICES, 'fall_closing');
  const res = bands.filter((b) => !b.commercial);
  const com = bands.filter((b) => b.commercial);

  // The real bands, off the server's own service list.
  assert.deepEqual(zoneOptionsFor(bands, res[0]), [1, 2, 3, 4]);
  assert.deepEqual(zoneOptionsFor(bands, res[1]), [5, 6]);
  assert.deepEqual(zoneOptionsFor(bands, res[2]), [7, 8]);
  assert.deepEqual(zoneOptionsFor(bands, res[3]), [9, 10, 11, 12, 13, 14, 15]);
  // Commercial tiers differ, and the count must follow the tier chosen —
  // 7 is a legal commercial 5-8 and an illegal residential 5-6.
  assert.deepEqual(zoneOptionsFor(bands, com[1]), [5, 6, 7, 8]);
  assert.ok(!zoneOptionsFor(bands, res[1]).includes(7), 'a 5-6 band offers 7 zones');

  // An open-ended band has no top, so it offers a workable run rather than
  // a list with no end.
  const open = res[4];
  assert.ok(!Number.isFinite(open.top), 'the top band is not open-ended');
  assert.equal(zoneOptionsFor(bands, open)[0], 16);
  assert.ok(zoneOptionsFor(bands, open).length > 5 && zoneOptionsFor(bands, open).length <= 30);

  // No band at all — a Hydrawise retrofit is priced per zone with no tiers.
  assert.deepEqual(zoneOptionsFor([], null)[0], 1);
  assert.equal(zoneOptionsFor([], null).length, 30);

  // And changing the band drops a count it cannot hold, rather than
  // leaving "7" sitting under "1-4 zones".
  const at = BOOK.indexOf('const pickBand = (b) =>');
  assert.ok(at > 0, 'pickBand is gone');
  const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
  assert.match(block, /zoneOptionsFor\(bands, b\)\.includes\(n\)/);
  assert.match(block, /setZoneCount\(''\)/);

  // The other direction too: a count can move the BAND, and moving the
  // band changes the service, its price and its length. Left uncleaned,
  // that re-pointed the booking while the day list and the chosen slot
  // stayed alive — so "Book it" sent the new service against a slot sized
  // for the old one.
  const zonesAt = BOOK.indexOf('const onZones = (value) =>');
  assert.ok(zonesAt > 0, 'onZones is gone');
  const moves = BOOK.slice(zonesAt, BOOK.indexOf('\n  };', zonesAt));
  assert.match(moves, /setServiceKey\(better\.key\)/);
  for (const cleaned of ['setDays([])', 'setSlot(null)', "clamp('service')"]) {
    assert.ok(moves.includes(cleaned), `moving the band from the count leaves ${cleaned} undone`);
  }
});

check('a count reads as words, and "not sure" is a real answer', () => {
  const zoneCountLabel = lift(BOOK, 'zoneCountLabel');
  assert.equal(zoneCountLabel('1'), '1 zone');
  assert.equal(zoneCountLabel('7'), '7 zones');
  // 'unsure' is what the server is sent when the count is not known. It
  // must not read as the number zero, or as nothing having been asked.
  assert.equal(zoneCountLabel('unsure'), 'Not sure yet');
  assert.equal(zoneCountLabel(''), '');
  assert.equal(zoneCountLabel(null), '');
  assert.match(BOOK, /key: 'unsure', label: 'Not sure yet'/, 'the count cannot be left unknown');
  // And it still reaches the server as the value it understands.
  assert.match(BOOK, /zoneCount: clean\(zoneCount\) \|\| 'unsure'/);

  const issueCountLabel = liftCatalog('issueCountLabel', ['MANY_ISSUES']);
  assert.equal(issueCountLabel('1'), '1 issue');
  assert.equal(issueCountLabel('3'), '3 issues');
  // Past eight the number stops helping a scheduler.
  assert.equal(issueCountLabel('8+'), 'More than 8');
  assert.equal(issueCountLabel(''), '');
});

check('the app takes the ten-minute hold, or the booking is refused', () => {
  // THE FAILURE THIS PINS. The server was given a slot hold: a standard
  // booking that does not arrive holding its slot is refused outright with
  // `hold_required`. Its four exemptions are all cases where no form is
  // being filled in — standby, admin_custom, book-from-lead, load test —
  // and booking from this app is none of them. The app never asked for a
  // hold, so EVERY appointment it tried to book came back "Pick a time
  // again and we'll hold it while you finish." Not some. Every one.
  assert.match(SERVER, /code: holdToken \? "hold_expired" : "hold_required"/,
    'the server no longer requires a hold — this test is guarding nothing');

  // The app asks for one, at the moment a time is picked.
  assert.match(API, /'\/api\/booking\/hold'/, 'the app cannot take a hold');
  assert.match(API, /'\/api\/booking\/release-hold'/, 'the app cannot give a slot back');
  const takeAt = BOOK.indexOf('const takeSlot = async');
  assert.ok(takeAt > 0, 'nothing takes the hold');
  const taking = BOOK.slice(takeAt, BOOK.indexOf('\n  };', takeAt));
  assert.match(taking, /holdSlot\(\{/, 'the day is confirmed without holding it');
  assert.match(taking, /slotStart: slot\.start/);
  assert.match(taking, /address: verified\.address/);
  // Changing your mind must not eat two units of capacity — the previous
  // token rides along so the server can release it.
  assert.match(taking, /releaseToken: hold\?\.token/, 'changing time leaks a held slot');
  // And the hold has to be taken BEFORE the details slide, not after: it
  // exists to protect the slot while the form is filled in.
  // lastIndexOf, because the first `go('who')` in this function is the
  // standby short-circuit above — the one that deliberately holds nothing.
  assert.ok(taking.indexOf('holdSlot(') < taking.lastIndexOf("go('who')"),
    'the details are taken before the slot is held, which is the wrong order');

  // The token reaches reserve.
  assert.match(BOOK, /holdToken: hold\?\.token/, 'the hold is taken and then not used');

  // Losing the slot sends you back to a FRESH day list rather than leaving
  // a dead time on screen.
  const confirmAt = BOOK.indexOf('const confirm = async');
  const confirming = BOOK.slice(confirmAt, BOOK.indexOf('\n  };', confirmAt));
  for (const code of ['hold_expired', 'hold_required', 'slot_taken']) {
    assert.ok(confirming.includes(`'${code}'`), `a ${code} refusal is not recognised`);
  }
  assert.match(confirming, /reloadDays\(\)/, 'a lost slot leaves a dead time on the screen');
  // Anything else leaves the form alone — retyping a customer's details
  // because the server hiccuped is unforgivable.
  assert.match(confirming, /const lostTheSlot = /);
  assert.match(confirming, /if \(lostTheSlot\) reloadDays\(\);/);

  // None of that can work if the code is thrown away on the way up.
  assert.match(API, /err\.code = \(data && data\.code\) \|\| null;/,
    'the error code is dropped, so the screen has to match on English');
});

check('a hold is given back rather than left to rot', () => {
  // Ten minutes of one slot's capacity, every time somebody changes their
  // mind, on the busiest weeks of the year.
  assert.match(BOOK, /const dropHold = \(\) => \{/, 'nothing releases a hold');
  const at = BOOK.indexOf('const dropHold = () => {');
  const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
  assert.match(block, /releaseHold\(hold\.token\)/);
  assert.match(block, /setHold\(null\)/);
  // Every path that abandons the slot: a new address, a new service, a
  // different day, and starting over.
  for (const fn of [
    'const unsettle = () =>',
    'const showDays = async',
    'const reloadDays = async',
    'const reset = () =>',
  ]) {
    const a = BOOK.indexOf(fn);
    assert.ok(a > 0, `${fn} is gone`);
    assert.ok(BOOK.slice(a, BOOK.indexOf('\n  };', a)).includes('dropHold()'),
      `${fn} abandons a held slot without giving it back`);
  }
  // Booking CONSUMES the hold — releasing it afterwards would be releasing
  // something that no longer exists.
  const confirmAt = BOOK.indexOf('const confirm = async');
  const confirming = BOOK.slice(confirmAt, BOOK.indexOf('\n  };', confirmAt));
  assert.match(confirming, /setHold\(null\);/);
  assert.ok(!confirming.includes('dropHold()'), 'a consumed hold is released again');

  // The clock is said out loud rather than discovered.
  const clockOf = lift(BOOK, 'clockOf');
  assert.equal(clockOf('not a date'), '');
  assert.ok(clockOf('2026-10-03T13:45:00.000Z').length > 0);
  assert.match(BOOK, /Held until \{clockOf\(hold\.expiresAt\)\}/, 'the ten minutes are invisible');
});

check('the questions are asked in words a customer would hear, not the price list\'s', () => {
  // Patrick, on a screenshot of the zones row: "It's circled 'brand' —
  // unfortunately that isn't the intended description of what is to be
  // expected." The placeholder said "Which band?". `band` is what the
  // service catalogue calls a zone tier; nobody says it out loud, and at a
  // glance it reads as a typo for "brand".
  //
  // The two zone rows ask ABOUT how many, then EXACTLY how many. That is
  // the whole distinction and it should need no glossary.
  const at = BOOK.indexOf("{step === 'service' ?");
  const block = BOOK.slice(at, BOOK.indexOf("{/* ---- 3.", at));
  const shown = [...block.matchAll(/(?:placeholder|label)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(shown.length >= 6, `only found ${shown.length} labels and placeholders`);
  for (const text of shown) {
    assert.ok(!/\bbands?\b/i.test(text), `"${text}" says band — that is the price list's word`);
    assert.ok(!/\bkey\b|\bslug\b|\btier\b/i.test(text), `"${text}" is internal vocabulary`);
  }
  // And the two rows still read as a pair, coarse then exact.
  assert.ok(shown.includes('About how many?'), 'the zone range lost its plain-language prompt');
  assert.ok(shown.includes('Exactly how many'), 'the exact-count row lost its label');
});

// ---- It parses ----------------------------------------------------------

check('no slide can be left reading a value that has been taken away', () => {
  // Every one of these nulls a value a LATER slide renders. With the pager
  // drawn from the furthest step reached, that slide can still be mounted
  // — so each has to pull the flow back to itself as well.
  //
  // The one that bit: swiping back from the details slide and asking for
  // days again nulled the slot, and the details slide reads
  // `slot.dayLabel` off it. A crash, mid phone call.
  for (const [fn, to] of [
    ['const unsettle = () =>', 'address'],
    ['const pickCategory = (c) =>', 'service'],
    ['const pickBand = (b) =>', 'service'],
    ['const showDays = async', 'service'],
    ['const onZones = (value) =>', 'service'],
  ]) {
    const at = BOOK.indexOf(fn);
    assert.ok(at > 0, `${fn} is gone`);
    const block = BOOK.slice(at, BOOK.indexOf('\n  };', at));
    // Nulling a value a later slide reads, or re-pointing which service is
    // being booked — either one invalidates the slides after this step.
    if (!/setSlot\(null\)|setVerified\(null\)|setServiceKey\(better/.test(block)) continue;
    assert.ok(block.includes(`clamp('${to}')`), `${fn} strands a later slide`);
  }
  // And the slides guard themselves, so a path nobody thought of is a
  // blank slide rather than a crash.
  assert.match(BOOK, /\{step === 'when' && verified \?/);
  assert.match(BOOK, /\{step === 'who' && slot && verified \?/);
});

check("the Book screen parses with the app's own Babel", () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail("the app's dependencies are not installed — run npm ci in pjl-field"); }
  for (const rel of [
    'pjl-field/App.js',
    'pjl-field/src/api.js',
    'pjl-field/src/ui.js',
    'pjl-field/src/screens/BookScreen.js',
    'pjl-field/src/screens/PropertiesScreen.js',
  ]) {
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

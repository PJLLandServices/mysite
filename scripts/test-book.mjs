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

check('the steps run address, then days, then who — the order of a phone call', () => {
  // Patrick's own sequence: "request that customers address … it shows me
  // JUST LIKE WHEN I search on desktop … Once i show them the booking
  // dates, I select the date they accept". Asking for a name before a day
  // can be offered means holding a stranger on the phone while you type.
  const STEPS = new Function(
    `${BOOK.slice(BOOK.indexOf('export const STEPS ='), BOOK.indexOf(';', BOOK.indexOf('export const STEPS =')) + 1).replace('export const', 'const')}\nreturn STEPS;`,
  )();
  assert.deepEqual(STEPS, ['address', 'when', 'who']);
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
  assert.match(block, /address: verified\.address/,
    'availability uses the typed address, not the geocoded one');
  // Every path to an address goes through settleAddress, which verifies.
  assert.match(BOOK, /onPress=\{\(\) => \{ setTyped\(s\.description\); settleAddress\(s\.description\); \}\}/,
    'a Google suggestion is taken without being verified');
  assert.match(BOOK, /onPress=\{\(\) => settleAddress\(takeProperty\(p\)\)\}/,
    'an address from the book is taken without being verified');
  // Editing the address after verifying must drop the verification.
  assert.match(BOOK, /setTyped\(v\); setVerified\(null\); setPicked\(null\);/,
    'an edited address keeps its old verification');
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
  for (const field of ['First name', 'Last name', 'Telephone', 'Alternate telephone', 'Email', 'Zone count']) {
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
  assert.match(BOOK, /\.\.\.\(slot\.openBucket \? \{ standby: true \} : \{ slotStart: slot\.start \}\)/,
    'the open bucket books a real slot, which does not exist');
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
  assert.match(
    seasonNote({ season: { name: 'fall', open: false, opensOn: '2026-09-28' } }),
    /Booking opens .*September 28, 2026|Booking opens 28 September 2026/,
  );
  assert.equal(
    seasonNote({ season: { name: 'spring', open: false, closed: true } }),
    'Season is over for this year',
  );

  // In-season first, but a closed service still shows — Patrick books
  // work the public flow will not, and hiding it is its own lie.
  const bookableList = lift(
    BOOK, 'bookableList',
    BOOK.slice(BOOK.indexOf('export function seasonNote('), BOOK.indexOf('\n}\n', BOOK.indexOf('export function seasonNote(')) + 3).replace('export function', 'function'),
  );
  const ordered = bookableList({
    shut: { bookable: true, season: { open: false, closed: true } },
    open: { bookable: true, season: { open: true } },
    always: { bookable: true },
    hidden: { bookable: false },
  });
  assert.deepEqual(ordered.map((r) => r.key), ['open', 'always', 'shut']);
  assert.ok(ordered.some((r) => r.key === 'shut'), 'an out-of-season service was hidden rather than labelled');

  // And the screen shows the note rather than the duration.
  assert.match(BOOK, /\{shut \|\| s\.displayMinutes \|\| `\$\{s\.minutes\} min`\}/);
});

check('the season status comes from the same authority the gate uses', () => {
  // A second copy of "is spring open" is a second answer to it.
  const at = SERVER.indexOf('pathname === "/api/booking/services"');
  assert.ok(at > 0, 'the services route is gone');
  const block = SERVER.slice(at, at + 3000);
  // The route ASKS lib/seasons rather than comparing the bounds itself.
  // One rule, two callers — not two rules that will disagree.
  assert.match(block, /seasonsLib\.publicBookingStatus\(name, todayKey, \{ scope \}\)/,
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

check('staff are not the public — the Sept 28 hold is not Patrick\'s', () => {
  // Fall 2026 is SERVICEABLE from Sep 1 and PUBLICLY bookable from Sep 28:
  // that hold exists so a customer cannot self-book a September date no
  // route is planned for. Asking the public question on Patrick's behalf
  // told him "Booking opens September 28" on the 8th, a week after his
  // own trucks started running.
  const requireRoot2 = createRequire(path.join(ROOT, 'package.json'));
  const seasonsLib2 = requireRoot2('./server/lib/seasons.js');
  const staff = seasonsLib2.publicBookingStatus('fall', '2026-09-08', { scope: 'staff' });
  const publik = seasonsLib2.publicBookingStatus('fall', '2026-09-08', { scope: 'public' });
  assert.equal(staff.open, true, 'staff are still held to the public opening date');
  assert.equal(publik.open, false, 'the public hold has been removed, which it should not be');
  assert.equal(publik.opensOn, '2026-09-28');
  // Spring really is over for everyone — the staff scope is not a bypass.
  assert.equal(seasonsLib2.publicBookingStatus('spring', '2026-09-08', { scope: 'staff' }).open, false,
    'the staff scope books a season that has genuinely ended');

  // The services route asks the STAFF question for a signed-in caller.
  const at = SERVER.indexOf('pathname === "/api/booking/services"');
  const block = SERVER.slice(at, at + 3000);
  assert.match(block, /const scope = \(await requireUser\(req\)\) \? "staff" : "public";/,
    'the services route no longer distinguishes staff from the public');

  // And availability gates staff on the SERVICEABLE window, via the
  // seasonWindows hook the gate already accepts.
  assert.match(SERVER, /seasonWindows: adminSession/, 'staff availability is gated on the public window again');
  // Matched on the SERVICEABLE half only. test-season-config.mjs keeps a
  // short allowlist of files that may name the public booking bounds, so
  // that the rule has one home — and this file has no business joining it.
  assert.match(SERVER, /cfg\.serviceableFrom \|\| null/, 'staff availability is not gated on the serviceable window');
  assert.match(SERVER, /cfg\.serviceableThrough \|\| null/);
  // The app identifies itself so the server can honour it — and the
  // server still checks the session rather than trusting the flag.
  assert.match(API, /&adminBypass=1/, 'the app no longer asks as staff');
  assert.match(SERVER, /const adminSession = wantsAdminBypass \? await requireUser\(req\) : null;/,
    'the admin flag is trusted without a session');
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

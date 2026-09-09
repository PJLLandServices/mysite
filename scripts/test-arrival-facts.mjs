#!/usr/bin/env node
// The work order's arrival screen, and the property record behind it.
//
//   node scripts/test-arrival-facts.mjs
//
// Patrick, on a work order showing Controller / Located / Shut Off /
// Blow-Out all reading "Not Recorded": "Please do me a favor and connect
// these from the properties profile... If the display information shows
// 'Not Recorded' this should be editable in this screen... The information
// that is updated here MUST also follow over to the properties information
// thats on my CRM."
//
// FOUR THINGS CAN GO WRONG QUIETLY, and each is executed here rather than
// read:
//
//   1. THE SAVE GOES NOWHERE. The app's field names and the server's
//      allow-list are two lists of the same thing. Any name in one and not
//      the other is a box the tech fills in, a spinner that succeeds, and
//      a property record that never changed. This is the assertion that
//      matters most.
//   2. IT SAVES TO THE VISIT. A fact written onto the work order is gone
//      when that work order is archived. These belong to the ADDRESS.
//   3. A TECH CANNOT SAVE IT. The man in the garage is the one who knows
//      the controller. If the route is admin-only he can look and not
//      touch, which is worse than not offering it.
//   4. THE START BUTTON STOPS STARTING. Everything here is paperwork; the
//      visit must never be gated on it.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const START = read('pjl-field/src/screens/closing/StartStage.js');
const CLOSING = read('pjl-field/src/screens/ClosingScreen.js');
const PARTS = read('pjl-field/src/screens/closing/parts.js');
const API = read('pjl-field/src/api.js');
const SERVER = read('server/server.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n').slice(0, 6).join('\n    ')}`); }
};

// Lifts an exported function or const out of the screen, with whatever
// else in the file it closes over. These are pure by design.
function lift(name, needs = []) {
  const grab = (n) => {
    const fnAt = START.indexOf(`export function ${n}(`);
    if (fnAt >= 0) return START.slice(fnAt, START.indexOf('\n}\n', fnAt) + 3).replace('export function', 'function');
    const constAt = START.indexOf(`export const ${n} = `);
    if (constAt >= 0) {
      const end = START.indexOf('\n];', constAt) + 3;
      assert.ok(end > constAt, `could not find the end of ${n}`);
      return START.slice(constAt, end).replace('export const', 'const');
    }
    const localAt = START.indexOf(`const ${n} = `);
    assert.ok(localAt >= 0, `${n} is not in StartStage`);
    return START.slice(localAt, START.indexOf(';\n', localAt) + 1);
  };
  const parts = needs.map(grab).join('\n');
  return new Function(`${parts}\n${grab(name)}\nreturn ${name};`)();
}

// ---- 1. The save reaches the property record ----------------------------

check('every field on the screen is one the server will actually store', () => {
  const FIELDS = lift('SYSTEM_FIELDS');
  const keys = FIELDS.map((f) => f.key).concat('notes');

  // The server's own allow-list, read rather than restated.
  const at = SERVER.indexOf('const allowedSys = [');
  assert.ok(at > 0, 'the property PATCH no longer has a system allow-list');
  const allowed = new Function(
    `${SERVER.slice(at, SERVER.indexOf('];', at) + 2)}\nreturn allowedSys;`,
  )();

  for (const key of keys) {
    assert.ok(allowed.includes(key),
      `the screen writes system.${key} and the server drops it — the tech sees a save that did nothing`);
  }
});

check('the labels are the CRM\'s words, and point at the right field', () => {
  const FIELDS = lift('SYSTEM_FIELDS');
  // The screen used to say "Controller" for the BRAND and "Located" for
  // the place, which reads as the reverse of the form Patrick fills in.
  assert.deepEqual(FIELDS.map((f) => [f.label, f.key]), [
    ['Controller', 'controllerBrand'],
    ['Location', 'controllerLocation'],
    ['Main shut-off', 'shutoffLocation'],
    ['Blow-out', 'blowoutLocation'],
  ]);
  for (const f of FIELDS) assert.ok(f.placeholder, `${f.label} has no example`);
});

check('a cleared box clears the record, rather than doing nothing', () => {
  const systemPatch = lift('systemPatch', ['SYSTEM_FIELDS', 'clean']);
  const full = systemPatch({
    controllerBrand: '  Hunter HPC-400 ',
    controllerLocation: 'Garage',
    shutoffLocation: 'Furnace Room',
    blowoutLocation: 'Right Side',
    notes: '  Gate code 4821  ',
  });
  assert.equal(full.controllerBrand, 'Hunter HPC-400', 'the value is not trimmed');
  assert.equal(full.notes, 'Gate code 4821');

  // EVERY key is present even when empty. A patch that omitted the blanks
  // would merge over the old value, so deleting a wrong controller model
  // would silently leave it there.
  const emptied = systemPatch({});
  assert.deepEqual(Object.keys(emptied).sort(),
    ['blowoutLocation', 'controllerBrand', 'controllerLocation', 'notes', 'shutoffLocation']);
  for (const v of Object.values(emptied)) assert.equal(v, '');
});

check('an empty record says so once, not five times down the column', () => {
  const nothingKnown = lift('nothingKnown', ['SYSTEM_FIELDS', 'clean']);
  assert.equal(nothingKnown({}), true);
  assert.equal(nothingKnown({ controllerLocation: '   ' }), true, 'whitespace counts as known');
  assert.equal(nothingKnown({ controllerLocation: 'Garage' }), false);
  assert.equal(nothingKnown({ notes: 'Dog in the back' }), false, 'notes alone is something');
  assert.equal(nothingKnown(null), true);
});

// ---- 2. It saves to the PROPERTY, not the visit -------------------------

check('the write goes to the property record, not the work order', () => {
  const at = CLOSING.indexOf('const saveSystem = useCallback');
  assert.ok(at > 0, 'nothing writes the arrival facts back');
  const block = CLOSING.slice(at, CLOSING.indexOf('\n  }, [wo]);', at));
  assert.match(block, /patchProperty\(propertyId, \{ system: patch \}\)/,
    'the facts are written onto the visit, and die with it');
  assert.ok(!/patchWorkOrder/.test(block), 'the arrival facts are being written onto the work order');
  assert.match(API, /export const patchProperty/, 'the app cannot patch a property');

  // A failure PUTS THE OLD VALUE BACK. Unlike a work-order edit, a
  // property fact that did not save is not recorded anywhere — leaving it
  // on screen tells the tech the office knows something it does not.
  assert.match(block, /const before = wo\.property;/);
  assert.match(block, /setWo\(\(prev\) => \(\{ \.\.\.prev, property: before \}\)\);/,
    'a failed save leaves a value on screen that reached nothing');
  assert.match(block, /return false;/);

  // And the stage is handed the writer.
  assert.match(CLOSING, /const shared = \{ wo, save, saveSystem, saving \};/);
});

check('the screen still reads the property the GET attached', () => {
  assert.match(START, /const sys = wo\?\.property\?\.system \|\| \{\};/,
    'the arrival facts no longer come off the property');
  // The decoration has to survive a work-order save, or the screen works
  // once and then quietly empties — which it did, once, already.
  assert.match(CLOSING, /property: prev\?\.property \?\? null,/);
});

// ---- 3. A tech can actually save it ------------------------------------

check('the man in the garage is allowed to write what he sees', () => {
  const at = SERVER.indexOf('if (pathname.startsWith("/api/properties")) return');
  assert.ok(at > 0, 'the properties fence moved');
  const line = SERVER.slice(at, SERVER.indexOf('\n', at));
  assert.match(line, /return "user";/,
    'properties are admin-only again — the tech can look and not touch');
});

// ---- 4. Nothing here blocks the visit ----------------------------------

check('the start button still starts, except mid-edit', () => {
  assert.match(START, /label=\{starting \? 'Starting…' : 'Start Service \(Fall Closing\)'\}/,
    'the button that begins the work is gone');
  // Only an open edit holds it, so a half-typed gate code is not lost to
  // a tap. Nothing about the facts themselves is required.
  assert.match(START, /disabled=\{starting \|\| saving \|\| editing\}/);
  assert.ok(!/disabled=\{blank/.test(START), 'an unrecorded property blocks the visit');
  assert.ok(!/nothingKnown\(sys\) &&[^]{0,80}disabled/.test(START));
});

// ---- Who to meet -------------------------------------------------------

check('site contacts appear only when there are some, and are read-only', () => {
  assert.match(START, /wo\?\.property\?\.siteContacts/, 'site contacts never reach the screen');
  assert.match(START, /\{contacts\.length \? \(/, 'an empty site-contact box shows on every driveway');
  // Above the system facts: on a condo board's site the first question is
  // who opens the door.
  assert.ok(START.indexOf("title={contacts.length > 1 ? 'Who to meet' : 'Who to meet'}")
    < START.indexOf('title="On arrival"'),
    'who to meet sits below the valve locations');
  // Callable, not editable — adding a board president from a truck is a
  // CRM job; phoning him is not.
  assert.match(START, /onPress=\{\(\) => call\(c\.phone\)\}/);
  assert.match(START, /Linking\.openURL\(`tel:\$\{to\}`\)/);
  const contactBlock = START.slice(START.indexOf('{contacts.map('), START.indexOf('</Section>'));
  assert.ok(!/TextInput/.test(contactBlock), 'site contacts are editable from the truck');
});

check('the section header carries the edit, and it is shared', () => {
  assert.match(PARTS, /export function Section\(\{ title, action, children, footer \}\)/,
    'Section cannot carry a header action');
  assert.match(START, /action=\{canEdit \? \(/);
  // No property on the work order means nothing to write back to.
  assert.match(START, /const canEdit = Boolean\(wo\?\.property\?\.id && saveSystem\);/);
});

check('the closing screen parses with the app\'s own Babel', () => {
  const requireFromApp = createRequire(path.join(ROOT, 'pjl-field/package.json'));
  let babel;
  try { babel = requireFromApp('@babel/core'); }
  catch { assert.fail('the app dependencies are not installed — run npm ci in pjl-field'); }
  for (const rel of [
    'pjl-field/src/screens/ClosingScreen.js',
    'pjl-field/src/screens/closing/StartStage.js',
    'pjl-field/src/screens/closing/parts.js',
  ]) {
    babel.parse(read(rel), {
      filename: rel,
      parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      babelrc: false,
      configFile: false,
    });
  }
});

console.log(`\narrival-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

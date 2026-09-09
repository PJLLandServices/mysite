#!/usr/bin/env node
// The over-the-air update channel.
//
//   node scripts/test-ota-channel.mjs
//
// Patrick, repeatedly, all of one evening: "github is not allowing my
// applicaiton on my phone to update." He pulled, he restarted the app, he
// restarted it again. Nothing arrived, and nothing ever would have.
//
// The app has always been BUILT to update itself — `applyPendingUpdate()`
// checks on cold start and reloads. What it was never told is WHICH SHELF
// to look on. `eas.json` names channels, but those are read by EAS when
// EAS does the building; a build made by hand in Xcode carries no
// `expo-channel-name` at all, so the update server has nothing to resolve
// and answers with nothing. Silence that looks exactly like "up to date".
//
// Four things have to agree or the whole mechanism is decoration, and each
// of them has been wrong at some point:
//
//   1. The app must NAME a channel.
//   2. That channel must be one `eas.json` actually builds.
//   3. There must be an update URL to ask.
//   4. `runtimeVersion` must stay on the fingerprint policy — it is what
//      stops a JS bundle landing on a build whose native code cannot run
//      it. Pin it to a string and an update built against different native
//      libraries will happily install and crash on launch.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const APP = JSON.parse(read('pjl-field/app.json')).expo;
const EAS = JSON.parse(read('pjl-field/eas.json'));
const UPDATES = read('pjl-field/src/updates.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n').slice(0, 5).join('\n    ')}`); }
};

check('the app names the channel it reads from', () => {
  const channel = APP.updates?.requestHeaders?.['expo-channel-name'];
  assert.ok(channel,
    'no expo-channel-name — a hand-built app asks the update server nothing it can answer');
  assert.equal(channel, 'production');
});

check('that channel is one eas.json actually builds', () => {
  const channel = APP.updates?.requestHeaders?.['expo-channel-name'];
  const built = Object.values(EAS.build || {}).map((p) => p.channel).filter(Boolean);
  assert.ok(built.includes(channel),
    `the app reads "${channel}" and eas.json builds ${JSON.stringify(built)} — an update published `
    + 'to a channel nothing builds reaches nothing');
});

check('there is a URL to ask', () => {
  assert.match(String(APP.updates?.url || ''), /^https:\/\/u\.expo\.dev\//,
    'the update endpoint is missing or is not the EAS one');
});

check('runtimeVersion stays a fingerprint, not a number', () => {
  // The fingerprint is the safety catch. A JS bundle can only land on a
  // build whose native side is identical — so an update published from
  // main can never install onto the Tap to Pay build, which carries an
  // extra native library. Pin this to a string and it would, then crash on
  // launch with no way back except the App Store.
  assert.deepEqual(APP.runtimeVersion, { policy: 'fingerprint' },
    'runtimeVersion is no longer a fingerprint — an update can now land on native code that cannot run it');
});

check('the app still checks on cold start, and only on cold start', () => {
  assert.match(UPDATES, /Updates\.checkForUpdateAsync\(\)/);
  assert.match(UPDATES, /Updates\.fetchUpdateAsync\(\)/);
  assert.match(UPDATES, /Updates\.reloadAsync\(\)/);
  // Reloading mid-visit would throw away whatever the tech was in the
  // middle of. This is why it is not called from a foreground event.
  assert.match(UPDATES, /if \(__DEV__\) return false;/);
  // Offline is not an error — a truck in a dead zone keeps the bundle it
  // has, which is the correct outcome.
  assert.match(UPDATES, /catch \{/);
});

check('the running bundle is visible, so "did it land" is answerable', () => {
  assert.match(UPDATES, /export function runningVersionLabel/);
  assert.match(UPDATES, /Updates\.isEmbeddedLaunch/,
    'nothing distinguishes the bundle Xcode installed from one that arrived over the air');
});

console.log(`\nota-channel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

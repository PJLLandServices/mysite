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
//   4. Something must stop a JS bundle landing on a build whose native
//      code cannot run it. Pin the runtime to a bare string and an update
//      built against different native libraries will happily install and
//      crash on launch.
//      main (since the one-app build, PJL-114): the appVersion policy, with
//      the native guard (scripts/field-native-guard.mjs) refusing to publish
//      a tree whose native fingerprint is not the one its version was built
//      from. The fingerprint is no longer the runtime because the app is
//      built on the Mac, and the Mac and Linux never agreed on it.
//      The Tap to Pay release lane, until it is retired, pins exactly the
//      runtime of the phone hand-built from 0c638a8 (docs/TTP_RUNTIME_PIN.md).
//      No cloud build is made from either (both build workflows refuse
//      anything but the fingerprint policy, checked below).

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

// The runtime of Patrick's hand-built Tap to Pay phone (0c638a8, built on
// his Mac). The one literal the release lane may pin; see
// docs/TTP_RUNTIME_PIN.md for why, and for when it must go.
const INSTALLED_TTP_RUNTIME = '41661c6ff465c4c52451347262fc9fc638271ed6';

check('runtimeVersion is guarded: appVersion with the native guard, or the lane pin', () => {
  // The fingerprint is the safety catch. A JS bundle can only land on a
  // build whose native side is identical — so an update published from
  // main can never install onto the Tap to Pay build, which carries an
  // extra native library. Pin this to a string and it would, then crash on
  // launch with no way back except the App Store.
  //
  // The lane's pin is the single exception: exactly the installed phone's
  // runtime, never any other literal. The release guard
  // (scripts/ttp-lane-guard.mjs) separately proves the native code under
  // it is unchanged from the build that phone runs.
  if (APP.runtimeVersion === INSTALLED_TTP_RUNTIME) return;
  assert.deepEqual(APP.runtimeVersion, { policy: 'appVersion' },
    'runtimeVersion is neither the appVersion policy nor the lane pin — an update can now land on native code that cannot run it');
  const record = JSON.parse(read('config/field-native.json'));
  assert.match(String(record.builds?.[APP.version]?.nativeFingerprint || ''), /^[0-9a-f]{40}$/,
    `version ${APP.version} has no recorded native build — nothing is listening on its runtime`);
  const wf = read('.github/workflows/field-app-update.yml');
  assert.ok(wf.indexOf('node scripts/field-native-guard.mjs') > 0
    && wf.indexOf('node scripts/field-native-guard.mjs') < wf.indexOf('npx eas-cli@23.2.0 update'),
    'the update workflow publishes without checking the native code against the build');
});

check('no native build is made while a runtime is pinned', () => {
  // A binary built with a pinned runtime takes every update published to
  // it, whatever native code that update was built against. Both build
  // workflows refuse a tree that is not on the fingerprint policy.
  for (const wf of ['field-app-build.yml', 'field-app-taptopay-build.yml']) {
    const text = read(`.github/workflows/${wf}`);
    assert.match(text, /- name: Refuse while the runtime is pinned/, `${wf} would build with a pinned runtime`);
    assert.match(text, /rt\.policy !== 'fingerprint'/, `${wf} does not test the policy`);
    assert.ok(text.indexOf('Refuse while the runtime is pinned') < text.indexOf('npx eas-cli@23.2.0 build'),
      `${wf} builds before it checks the runtime`);
  }
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

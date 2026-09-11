// The two commands that put a change on Patrick's phone.
//
//   node scripts/test-app-update.mjs
//
// `npm run rebuild` EDITS A GENERATED XCODE PROJECT — the signing team in
// project.pbxproj and the Run configuration in the scheme. Those two are
// the settings a prebuild wipes every time, and each has cost a real
// evening: the wrong team fails only on Release with "requires a
// development team", and a Debug configuration gives a red RCTFatal
// screen the moment the phone leaves the Mac. Automating them is only an
// improvement if the automation is exactly right, so the fixtures below
// are the real shapes `expo prebuild -p ios --clean` emits.
//
// And `npm run send` answers "does this need Xcode?" from the Expo
// fingerprint. The rule it must never break: when the fingerprints
// differ, publish NOTHING. Expo would accept the bundle and the phone
// would decline it, which reads as "my update didn't work" and is far
// harder to chase than a message that says the word Xcode.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readOr = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

const HELPERS = 'pjl-field/scripts/native.mjs';
let native = null;
let nativeError = null;
try { native = await import(pathToFileURL(path.join(ROOT, HELPERS))); }
catch (err) { nativeError = err; }

check(`${HELPERS} loads`, () => {
  assert.ok(native, nativeError ? nativeError.message : 'nothing exported');
});

const use = (name) => (...args) => {
  if (!native) throw new Error(`${HELPERS} did not load`);
  if (typeof native[name] !== 'function') throw new Error(`${HELPERS} does not export ${name}`);
  return native[name](...args);
};
const readTeam = use('readTeam');
const writeTeam = use('writeTeam');
const setRunConfiguration = use('setRunConfiguration');
const iosProject = use('iosProject');

const SEND = readOr('pjl-field/scripts/send.mjs');
const REBUILD = readOr('pjl-field/scripts/rebuild.mjs');
const BUILT = readOr('pjl-field/scripts/built.mjs');
const NATIVE = readOr('pjl-field/scripts/native.mjs');
const PKG = readOr('pjl-field/package.json');
const IGNORE = readOr('pjl-field/.gitignore');
const DOC = readOr('docs/UPDATING_THE_APP.md');

// ---- Fixtures: what prebuild actually writes ------------------------------

// Two configurations of the app target, each carrying the bundle id, and
// no DEVELOPMENT_TEAM anywhere — exactly what a --clean run leaves.
const PBXPROJ = `// !$*UTF8*$!
{
	objects = {
/* Begin XCBuildConfiguration section */
		13B07F941A680F5B00A75B9A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				INFOPLIST_FILE = PJLField/Info.plist;
				PRODUCT_BUNDLE_IDENTIFIER = "com.pjllandservices.field";
				PRODUCT_NAME = "PJLField";
			};
			name = Debug;
		};
		13B07F951A680F5B00A75B9A /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				INFOPLIST_FILE = PJLField/Info.plist;
				PRODUCT_BUNDLE_IDENTIFIER = "com.pjllandservices.field";
				PRODUCT_NAME = "PJLField";
			};
			name = Release;
		};
		83CBBA201A601CBA00E9B192 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SDKROOT = iphoneos;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
	};
}
`;

const SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1430" version = "1.3">
   <BuildAction parallelizeBuildables = "NO" buildImplicitDependencies = "YES">
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      launchStyle = "0"
      debugDocumentVersioning = "YES">
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release">
   </ArchiveAction>
</Scheme>
`;

const scratch = mkdtempSync(path.join(tmpdir(), 'pjl-native-'));
const freshPbx = (name) => {
  const p = path.join(scratch, `${name}.pbxproj`);
  writeFileSync(p, PBXPROJ);
  return p;
};
const freshScheme = (name) => {
  const p = path.join(scratch, `${name}.xcscheme`);
  writeFileSync(p, SCHEME);
  return p;
};

// ---- The signing team ----------------------------------------------------

check('a fresh prebuild has no team, and that is detected as none', () => {
  assert.equal(readTeam(freshPbx('none')), null);
});

check('the team is written to EVERY configuration of the app target', () => {
  // Xcode's "All" tab. Setting it on Debug alone is the version of this
  // that looks fixed and still fails the Release build.
  const p = freshPbx('all');
  assert.equal(writeTeam(p, 'AB12CD34EF'), 2);
  const out = readFileSync(p, 'utf8');
  assert.equal((out.match(/DEVELOPMENT_TEAM = AB12CD34EF;/g) || []).length, 2);
  // Both the Debug and the Release block of the app target.
  const debug = out.slice(out.indexOf('/* Debug */'), out.indexOf('/* Release */'));
  assert.match(debug, /DEVELOPMENT_TEAM/);
});

check('the project target is left alone', () => {
  // Only configurations carrying the bundle id belong to the app. Writing
  // a team into the project-level block is not what Xcode does.
  const p = freshPbx('scope');
  writeTeam(p, 'AB12CD34EF');
  const out = readFileSync(p, 'utf8');
  const projectBlock = out.slice(out.indexOf('SDKROOT = iphoneos;'));
  assert.doesNotMatch(projectBlock, /DEVELOPMENT_TEAM/);
});

check('the team can be read back — which is how a rebuild carries it over', () => {
  // The whole scheme depends on this round trip: read before the wipe,
  // write after it. If reading fails, every rebuild silently reverts to
  // asking Patrick to do it by hand.
  const p = freshPbx('roundtrip');
  writeTeam(p, 'AB12CD34EF');
  assert.equal(readTeam(p), 'AB12CD34EF');
});

check('running it twice changes nothing', () => {
  const p = freshPbx('twice');
  writeTeam(p, 'AB12CD34EF');
  const once = readFileSync(p, 'utf8');
  writeTeam(p, 'AB12CD34EF');
  assert.equal(readFileSync(p, 'utf8'), once, 'a second run stacked duplicate settings');
});

check('a changed team replaces the old one rather than stacking', () => {
  const p = freshPbx('changed');
  writeTeam(p, 'AB12CD34EF');
  writeTeam(p, 'ZZ99YY88XX');
  const out = readFileSync(p, 'utf8');
  assert.equal((out.match(/DEVELOPMENT_TEAM/g) || []).length, 2);
  assert.equal(readTeam(p), 'ZZ99YY88XX');
  assert.doesNotMatch(out, /AB12CD34EF/);
});

check('a value that is not a Team ID is refused, not written', () => {
  // A wrong team id fails inside Xcode in a way that is hard to read, so
  // garbage must never reach the file.
  const p = freshPbx('bad');
  const before = readFileSync(p, 'utf8');
  assert.throws(() => writeTeam(p, 'my team'), /Team ID/);
  assert.equal(readFileSync(p, 'utf8'), before);
});

check('a project with no app target fails loudly instead of silently', () => {
  const p = path.join(scratch, 'empty.pbxproj');
  writeFileSync(p, '{ objects = { }; }\n');
  assert.throws(() => writeTeam(p, 'AB12CD34EF'), /app target/);
});

// ---- The Run configuration ----------------------------------------------

check('the Run action goes to Release, and reports what it was', () => {
  const p = freshScheme('run');
  assert.equal(setRunConfiguration(p, 'Release'), 'Debug');
  const out = readFileSync(p, 'utf8');
  const launch = out.slice(out.indexOf('<LaunchAction'), out.indexOf('</LaunchAction>'));
  assert.match(launch, /buildConfiguration = "Release"/);
});

check('only the Run action moves — Test and Analyze keep theirs', () => {
  // They have their own build configurations and are none of our business;
  // rewriting them all would be a different change wearing this one's name.
  const p = freshScheme('others');
  setRunConfiguration(p, 'Release');
  const out = readFileSync(p, 'utf8');
  const test = out.slice(out.indexOf('<TestAction'), out.indexOf('</TestAction>'));
  const analyze = out.slice(out.indexOf('<AnalyzeAction'), out.indexOf('</AnalyzeAction>'));
  assert.match(test, /buildConfiguration = "Debug"/);
  assert.match(analyze, /buildConfiguration = "Debug"/);
});

check('a scheme already on Release is left alone and says so', () => {
  const p = freshScheme('already');
  setRunConfiguration(p, 'Release');
  const once = readFileSync(p, 'utf8');
  assert.equal(setRunConfiguration(p, 'Release'), 'Release');
  assert.equal(readFileSync(p, 'utf8'), once);
});

check('a scheme with no Run action fails loudly', () => {
  const p = path.join(scratch, 'noscheme.xcscheme');
  writeFileSync(p, '<?xml version="1.0"?>\n<Scheme></Scheme>\n');
  assert.throws(() => setRunConfiguration(p, 'Release'), /LaunchAction/);
});

check('no ios folder is an answer, not a crash', () => {
  // Before the first prebuild there is nothing there, and both commands
  // have to say something useful about that.
  mkdirSync(path.join(scratch, 'emptyapp'), { recursive: true });
  assert.doesNotThrow(() => iosProject());
});

// ---- What `send` must never do ------------------------------------------

check('a fingerprint mismatch publishes nothing', () => {
  // The rule the whole command exists for. Expo would accept a bundle the
  // phone then declines, which looks like a broken update.
  const gate = SEND.indexOf('built.hash !== now');
  assert.ok(gate > 0, 'send.mjs no longer compares the fingerprints');
  const publish = SEND.indexOf("'eas', 'update'");
  assert.ok(publish > gate, 'the publish is no longer behind the fingerprint check');
  const between = SEND.slice(gate, publish);
  assert.match(between, /process\.exit\(1\)/, 'the mismatch path does not stop before publishing');
});

check('--anyway cannot force a bundle the phone would refuse', () => {
  // It overrides the git checks, which are judgement calls. The
  // fingerprint is not one.
  const line = SEND.split('\n').find((l) => l.includes('built.hash !== now'));
  assert.ok(line, 'the fingerprint check is gone');
  assert.doesNotMatch(line, /force/, '--anyway can now skip the fingerprint check');
});

check('the mismatch message names Xcode and the command that fixes it', () => {
  assert.match(SEND, /NEEDS XCODE/);
  assert.match(SEND, /npm run rebuild/);
});

check('uncommitted work and a stale checkout both stop it', () => {
  assert.match(SEND, /not committed/);
  assert.match(SEND, /behind main/);
  assert.match(SEND, /HEAD\.\.origin\/main/);
});

check('the default note skips merge commits', () => {
  // Straight after a merge the newest subject is "Merge pull request #188
  // from ...", which tells nobody what changed.
  assert.match(SEND, /--no-merges/);
});

// ---- What `rebuild` must do ---------------------------------------------

check('the team is read BEFORE the wipe, not after', () => {
  // prebuild --clean deletes the file it would be read from. Getting this
  // order wrong means the team is lost on every single rebuild.
  const read = REBUILD.indexOf('readTeam(');
  const prebuild = REBUILD.indexOf("'prebuild'");
  assert.ok(read > 0 && prebuild > 0, 'rebuild.mjs no longer reads the team or runs prebuild');
  assert.ok(read < prebuild, 'the team is read after the prebuild has already wiped it');
});

check('both settings are put back after the prebuild', () => {
  const prebuild = REBUILD.indexOf("'prebuild'");
  const after = REBUILD.slice(prebuild);
  assert.match(after, /writeTeam\(/);
  assert.match(after, /setRunConfiguration\(/);
});

check('a missing team asks for it by hand rather than inventing one', () => {
  // Never guessed: a wrong team id fails in a way that is hard to read.
  assert.match(REBUILD, /ALL tab/);
  assert.doesNotMatch(REBUILD, /DEVELOPMENT_TEAM = [A-Z0-9]{10}/);
});

check('the build is recorded, or send can never answer again', () => {
  const prebuild = REBUILD.indexOf("'prebuild'");
  assert.match(REBUILD.slice(prebuild), /recordBuild\(/);
});

check('the recorded build stays on the Mac it describes', () => {
  // It is a fact about a build that exists in one place, like ios/ itself.
  assert.match(IGNORE, /^\.build-fingerprint$/m);
});

// ---- A build made by hand, before any of this existed --------------------

check('no record does not send him to Xcode by default', () => {
  // Patrick built the 2026-09-09 work from Xcode himself, the ordinary way,
  // before these commands existed. His build is CURRENT. Answering "I have
  // no record, go and rebuild" would have cost him an evening for nothing,
  // which is the exact waste this whole thing was written to prevent.
  const start = SEND.indexOf('no record of which build');
  assert.ok(start > 0, 'send.mjs no longer handles a missing build record');
  const message = SEND.slice(start, start + 900);
  const built = message.indexOf('npm run built');
  const rebuild = message.indexOf('npm run rebuild');
  assert.ok(built > 0, 'the no-record path never offers to record the build he already has');
  assert.ok(rebuild < 0 || built < rebuild, 'it offers a rebuild before offering to record');
});

check('recording a build by hand is possible at all', () => {
  assert.ok(BUILT, 'pjl-field/scripts/built.mjs is missing');
  assert.match(BUILT, /recordBuild\(/);
  const scripts = JSON.parse(PKG || '{}').scripts || {};
  assert.equal(scripts.built, 'node scripts/built.mjs');
});

check('it says what it is assuming rather than assuming quietly', () => {
  // Nothing here can see his phone, so it is taking his word. Taking
  // someone's word silently is how a wrong record becomes a mystery.
  assert.match(BUILT, /built from this code|built from the code/i);
  assert.match(BUILT, /shipped with the build/, 'it never says how he would know it was wrong');
});

check('recording the same build twice is not an error', () => {
  assert.match(BUILT, /ALREADY RECORDED/);
});

// ---- It is not all Mac work ---------------------------------------------

check('npx is spawned by the name the platform actually has for it', () => {
  // On Windows npx is `npx.cmd`, and execFileSync('npx', ...) throws
  // ENOENT for an extensionless file that is not there. send.mjs reads
  // that as "EAS is not installed" and tells you to install a tool you
  // already have — a false answer, which is worse than none. Patrick
  // works from a Windows PC as well as the Mac (2026-09-11).
  assert.match(NATIVE, /npx\.cmd/);
  assert.match(NATIVE, /export const NPX/);
  for (const [name, src] of [['send.mjs', SEND], ['rebuild.mjs', REBUILD]]) {
    assert.doesNotMatch(src, /execFileSync\(\s*['"]npx['"]/,
      `${name} still spawns a bare "npx", which cannot be found on Windows`);
  }
});

check('publishing is never described as Mac-only work', () => {
  // Only a REBUILD needs macOS, because only a rebuild needs Xcode.
  // Publishing is a repo, Node and an Expo login. Telling someone to go
  // and find the Mac for a change that never needed it is the whole
  // failure this pins.
  for (const [name, src] of [['send.mjs', SEND], ['built.mjs', BUILT]]) {
    assert.doesNotMatch(src, /this Mac|per Mac/,
      `${name} tells the reader they need the Mac for something that runs anywhere`);
  }
});

check('a rebuild off macOS says so instead of failing at the toolchain', () => {
  // Letting prebuild fail on its own gives an error about a missing
  // toolchain, which reads like something to go and install.
  assert.match(NATIVE, /CAN_BUILD_NATIVE/);
  assert.match(NATIVE, /darwin/);
  assert.match(REBUILD, /NEEDS THE MAC/);
  const guard = REBUILD.indexOf('CAN_BUILD_NATIVE');
  const prebuild = REBUILD.indexOf("'prebuild'");
  assert.ok(guard > 0 && guard < prebuild, 'the guard runs after the prebuild is attempted');
});

check('…and points at the command that does work there', () => {
  const start = REBUILD.indexOf('NEEDS THE MAC');
  assert.match(REBUILD.slice(start, start + 600), /npm run send/);
});

// ---- The way in ---------------------------------------------------------

check('both commands are in package.json under the names the doc uses', () => {
  const scripts = JSON.parse(PKG || '{}').scripts || {};
  assert.equal(scripts.send, 'node scripts/send.mjs');
  assert.equal(scripts.rebuild, 'node scripts/rebuild.mjs');
});

check('the doc leads with the command, not with the theory', () => {
  // Patrick: "i am so confused with this updating system. Can you make it
  // as easy as possible". The first thing on the page has to be the thing
  // to type.
  const firstCommand = DOC.indexOf('npm run send');
  assert.ok(firstCommand > 0, 'the doc never mentions the command');
  assert.ok(firstCommand < 700, 'the command is buried below the explanation');
});

check('the doc does not send him to the Tap to Pay clone', () => {
  // The old version opened with `cd ~/Downloads/mysite-claude-pjl-field-taptopay`,
  // which is the one clone that can never receive these updates.
  const opening = DOC.slice(0, DOC.indexOf('## '));
  assert.doesNotMatch(opening, /cd ~\/Downloads\/mysite-claude-pjl-field-taptopay/);
});

console.log(`\napp-update: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

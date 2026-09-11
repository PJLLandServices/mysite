// npm run rebuild  —  regenerate the Xcode project, ready to press Run.
//
// `expo prebuild --clean` wipes the ios folder and writes a fresh one,
// which loses two settings every single time:
//
//   1. the signing team        -> "requires a development team", Release only
//   2. the Run configuration   -> Debug, which dies with a red RCTFatal
//                                 screen the moment the phone leaves the Mac
//
// Neither is a decision. They are the same answer every time, and both
// have cost real evenings. So this reads the team out of the project
// BEFORE wiping it, puts it back after, sets the Run configuration to
// Release, and records the fingerprint of what was built so `npm run
// send` knows what the phone can accept.

import { execFileSync } from 'node:child_process';
import {
  APP, banner, c, CAN_BUILD_NATIVE, fingerprint, iosProject, NPX, readTeam,
  recordBuild, rule, say, schemePath, setRunConfiguration, writeTeam,
} from './native.mjs';

const args = process.argv.slice(2);
const teamArg = (() => {
  const i = args.indexOf('--team');
  return i >= 0 && args[i + 1] ? args[i + 1].trim() : null;
})();

say('');

// Xcode is macOS-only, so there is nothing here to attempt. Saying so is
// the whole answer — letting prebuild fail on its own gives an error about
// a missing toolchain, which reads like something to go and install.
if (!CAN_BUILD_NATIVE) {
  banner('THIS ONE NEEDS THE MAC', c.amber);
  say('');
  say('  Rebuilding the app means Xcode, and Xcode only runs on macOS.');
  say('');
  say(`  ${c.bold('npm run send')}    ${c.dim('works here — most changes go over the air')}`);
  say('');
  say('  Only a change to app.json, a new library, a new permission or the');
  say('  icon needs this command, and that one has to happen on the Mac.');
  say('');
  rule();
  process.exit(1);
}

say(c.bold('  Rebuilding the Xcode project.'));
say('');

// --- Remember what the wipe is about to destroy --------------------------

const before = iosProject();
const knownTeam = teamArg || (before ? readTeam(before.pbx) : null);
if (knownTeam) {
  say(c.dim(`  Signing team ${knownTeam} — will be put back afterwards.`));
} else {
  say(c.amber('  No signing team found to carry over — see the end of this run.'));
}
say('');
say(c.dim('  Running expo prebuild. This takes a few minutes.'));
say('');

try {
  execFileSync(NPX, ['expo', 'prebuild', '-p', 'ios', '--clean'], { cwd: APP, stdio: 'inherit' });
} catch {
  say('');
  banner('PREBUILD FAILED', c.red);
  say('');
  say('  The ios folder may be half-written. Run this command again; it starts');
  say('  by clearing that folder, so a failed run is not something you have to');
  say('  clean up by hand.');
  say('');
  process.exit(1);
}

// --- Put back what it wiped ----------------------------------------------

const project = iosProject();
if (!project) {
  banner('NO XCODE PROJECT AFTER PREBUILD', c.red);
  say('\n  Expected an ios/*.xcodeproj and there is not one. Send Claude this output.\n');
  process.exit(1);
}

const restored = [];
const manual = [];

if (knownTeam) {
  try {
    const n = writeTeam(project.pbx, knownTeam);
    restored.push(`Signing team ${knownTeam}, on all ${n} configurations of the app target`);
  } catch (err) {
    manual.push(
      'Signing team: ' + err.message,
      '  Xcode -> PJLField -> Signing & Capabilities -> the All tab -> Team',
    );
  }
} else {
  manual.push(
    'Signing team — nothing to carry over, so set it once by hand:',
    '  Xcode -> PJLField -> Signing & Capabilities -> the ALL tab (not Debug) -> Team',
    '  Do it once and every future rebuild will keep it for you.',
  );
}

const scheme = schemePath(project);
if (scheme) {
  try {
    const was = setRunConfiguration(scheme, 'Release');
    restored.push(was === 'Release'
      ? 'Run configuration already Release'
      : `Run configuration ${was} -> Release`);
  } catch (err) {
    manual.push(
      'Run configuration: ' + err.message,
      '  Xcode -> Product -> Scheme -> Edit Scheme -> Run -> Build Configuration -> Release',
    );
  }
} else {
  manual.push(
    'Run configuration — no shared scheme found, so set it by hand:',
    '  Xcode -> Product -> Scheme -> Edit Scheme -> Run -> Build Configuration -> Release',
  );
}

// --- Record what this build will be --------------------------------------

const hash = await fingerprint();
recordBuild(hash);

say('');
banner(manual.length ? 'REBUILT — ONE THING LEFT' : 'REBUILT AND READY');
say('');
for (const line of restored) say(`  ${c.green('done')}  ${line}`);
if (manual.length) {
  say('');
  say(c.amber(c.bold('  Do this yourself:')));
  for (const line of manual) say(`  ${line}`);
}
say('');
say(c.bold('  Now:'));
say('   1. Plug the phone in and unlock it.');
say(`   2. ${c.bold(`open ${project.dir.replace(process.env.HOME || '~', '~')}/${project.name}.xcworkspace`)}`);
say(c.dim('      the WHITE icon — the blue .xcodeproj opens an empty, broken version'));
say('   3. Pick the phone from the dropdown at the top, press Run.');
say('');
say(c.dim(`  Recorded this build as ${hash.slice(0, 12)}. From here on, "npm run send"`));
say(c.dim('  can tell you whether a change needs Xcode or goes over the air.'));
say('');
say(c.dim('  First launch after a rebuild: the phone may say "Untrusted Developer"'));
say(c.dim('  (Settings -> General -> VPN & Device Management -> Trust), and you will'));
say(c.dim('  be signed out. Neither is a fault.'));
say('');
rule();

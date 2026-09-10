// npm run send  —  get the current code onto the phone.
//
// This is the command to reach for after a merge. It answers the only
// question that matters, "does this need Xcode?", by ASKING THE CODE
// rather than by anyone remembering a rule:
//
//   the fingerprint of what I am about to publish
//     === the fingerprint of the build on the phone   -> over the air
//     !== it                                          -> Xcode, and it
//                                                        says so and
//                                                        stops
//
// Publishing when they do not match is worse than doing nothing: Expo
// accepts the bundle, the phone declines it, and the update looks broken
// when it was never installable. So that case refuses.

import { execFileSync } from 'node:child_process';
import {
  APP, banner, c, fingerprint, git, iosProject, recordedBuild, rule, say,
} from './native.mjs';

const args = process.argv.slice(2);
const force = args.includes('--anyway');
const messageArg = (() => {
  const i = args.indexOf('-m');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

function bail(...lines) {
  say('');
  banner('STOP — nothing was published', c.amber);
  say('', ...lines, '');
  process.exit(1);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD') || '(unknown)';
const dirty = git('status', '--porcelain');
// --no-merges: right after a merge the newest commit is "Merge pull
// request #188 from ...", which says nothing about what changed. The
// commit underneath it is the one someone wrote on purpose.
const subject = git('log', '-1', '--no-merges', '--pretty=%s')
  || git('log', '-1', '--pretty=%s')
  || 'update';

say('');
say(c.bold('  Checking what this change needs...'));
say('');

// --- Is the checkout in a fit state to publish from? ----------------------

if (dirty && !force) {
  bail(
    'You have edits that are not committed. Publishing sends whatever is in',
    'these files to the phone, so a half-finished edit would go too.',
    '',
    `  ${c.bold('git status')}          ${c.dim('see what changed')}`,
    `  ${c.bold('npm run send -- --anyway')}   ${c.dim('publish it regardless')}`,
  );
}

const behind = git('rev-list', '--count', 'HEAD..origin/main');
if (behind && Number(behind) > 0 && !force) {
  bail(
    `This checkout is ${c.bold(`${behind} commit(s) behind main`)}, so it would send the phone`,
    'older code than what is live on the server.',
    '',
    `  ${c.bold('git pull')}`,
  );
}

// --- Does it need Xcode? -------------------------------------------------

const now = await fingerprint();
const built = recordedBuild();
const project = iosProject();

if (!built) {
  // Do NOT send him to Xcode by default here. A build made by hand,
  // before these commands existed, is a perfectly current build — and
  // telling its owner to rebuild it is exactly the wasted evening this
  // whole thing was written to prevent.
  bail(
    'I have no record of which build is on your phone, so I cannot yet tell',
    'whether this update can install onto it.',
    '',
    'If the app on your phone was built from this code — you pulled, opened',
    'Xcode and pressed Run — then nothing needs rebuilding. Just say so:',
    '',
    `  ${c.bold('npm run built')}     ${c.dim('records it, then run send again')}`,
    '',
    project
      ? 'If it was built from something older, or you are not sure:'
      : 'There is no ios folder in this checkout, so if you are not sure:',
    '',
    `  ${c.bold('npm run rebuild')}   ${c.dim('build it fresh; this records itself')}`,
  );
}

// Deliberately NOT skippable with --anyway. That flag is for the git
// checks above, which are judgement calls. This one is physics: the phone
// declines a bundle whose native code does not match, so forcing it past
// here would only produce an update that silently never installs.
if (built.hash !== now) {
  say(c.dim(`  on the phone  ${built.hash.slice(0, 12)}  (built ${new Date(built.at).toLocaleString()})`));
  say(c.dim(`  this code     ${now.slice(0, 12)}`));
  say('');
  banner('THIS ONE NEEDS XCODE', c.amber);
  say('');
  say('  Something native changed — a library, a permission, an icon, or');
  say('  anything in app.json. An over-the-air update cannot carry that, and');
  say('  the phone would refuse this bundle, so nothing has been published.');
  say('');
  say(`  ${c.bold('npm run rebuild')}     then press Run in Xcode.`);
  say('');
  say(c.dim('  That command puts back the signing team and the Release setting'));
  say(c.dim('  for you, so there is nothing to remember afterwards.'));
  say('');
  process.exit(1);
}

// --- Over the air --------------------------------------------------------

// Checked before anything is announced, so "the publish failed" can never
// mean "the tool that does it is not installed" — a failure that reads
// like a problem with the update itself.
try {
  execFileSync('npx', ['--no-install', 'eas', '--version'], { cwd: APP, stdio: 'ignore' });
} catch {
  bail(
    'The EAS command-line tool is not installed on this Mac, so there is',
    'nothing here that can publish an update.',
    '',
    `  ${c.bold('npm install -g eas-cli')}`,
    `  ${c.bold('npx eas login')}          ${c.dim('then sign in, once per Mac')}`,
  );
}

const message = messageArg || subject;
say(c.green('  The build on your phone can take this over the air.'));
say('');
say(`  branch   ${c.bold(branch)}`);
say(`  message  ${c.bold(message)}`);
say('');
say(c.dim('  Publishing to the production channel...'));
say('');

try {
  execFileSync(
    'npx',
    ['eas', 'update', '--branch', 'production', '--message', message, '--non-interactive'],
    { cwd: APP, stdio: 'inherit' },
  );
} catch {
  say('');
  banner('THE PUBLISH FAILED', c.red);
  say('');
  say('  Nothing reached the phone. The usual cause is not being signed in');
  say('  to Expo on this Mac:');
  say('');
  say(`  ${c.bold('npx eas login')}`);
  say('');
  process.exit(1);
}

say('');
banner('SENT');
say('');
say('  On the phone: force-quit PJL Field and open it again.');
say('');
say('  It reloads once, about a second, and then it is running the new code.');
say('  To check: bottom of the Today tab reads');
say(`    ${c.bold('"App updated <time>"')}       ${c.dim('the update landed')}`);
say(`    ${c.bold('"shipped with the build"')}   ${c.dim('still on what Xcode installed')}`);
say('');
say(c.dim('  Wrong bundle went out?  npx eas update:republish --branch production'));
say('');
rule();

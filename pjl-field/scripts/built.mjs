// npm run built  —  "the app on my phone was built from this code."
//
// `npm run rebuild` records the fingerprint itself, so this is only for
// the case it cannot cover: a build made BY HAND, in Xcode, before these
// commands existed or without going through them. Patrick did exactly
// that on 2026-09-09 — merged the day's work and ran it from Xcode — and
// without this his next `npm run send` would have told him there was no
// record of his phone and sent him back into an Xcode round he did not
// need.
//
// It runs anywhere — it only reads the source and writes a file.
//
// It takes his word, because nothing here can see his phone. So it says
// plainly what it is assuming, and how he will know within a minute if
// the assumption was wrong: an update that does not match simply never
// installs, and the Today tab keeps reading "shipped with the build".

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  APP, banner, c, fingerprint, git, iosProject, recordBuild, recordedBuild, rule, say,
} from './native.mjs';

const hash = await fingerprint();
const previous = recordedBuild();
const project = iosProject();
const dirty = git('status', '--porcelain');

say('');

if (previous && previous.hash === hash) {
  banner('ALREADY RECORDED');
  say('');
  say(`  This is the build already on file, from ${new Date(previous.at).toLocaleString()}.`);
  say('  Nothing to do — npm run send can already answer.');
  say('');
  rule();
  process.exit(0);
}

// Not a refusal: he keeps more than one clone, and the build could
// honestly have come from another one. But if there is no ios folder
// HERE, saying so is worth more than staying quiet.
if (!project && !existsSync(path.join(APP, 'ios'))) {
  say(c.amber('  Note: there is no ios folder in this checkout, so the build on your'));
  say(c.amber('  phone was made on another computer. Recording it anyway — but the code'));
  say(c.amber('  there and the code here have to be the same, or the first update'));
  say(c.amber('  will simply not install.'));
  say('');
}

if (dirty) {
  say(c.amber('  Note: you have uncommitted edits, so what is recorded includes them.'));
  say(c.amber('  If they were not in the build you ran, this record is wrong — run'));
  say(c.amber('  this again once the checkout matches the phone.'));
  say('');
}

recordBuild(hash);

banner('RECORDED');
say('');
say('  Taking it that the PJL Field app on your phone was built from the code');
say('  in this folder as it stands now.');
say('');
say(`  ${c.bold('npm run send')} can answer from here on: it will tell you whether a`);
say('  change goes over the air or needs Xcode, instead of guessing.');
say('');
say(c.dim('  If that assumption was wrong, nothing breaks — the first update simply'));
say(c.dim('  will not install, and the bottom of the Today tab will keep saying'));
say(c.dim('  "shipped with the build" instead of "App updated". If you see that,'));
say(c.dim('  run npm run rebuild and the record fixes itself.'));
say('');
say(c.dim(`  Recorded ${hash.slice(0, 12)}.`));
say('');
rule();

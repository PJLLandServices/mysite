// Does the phone app's JavaScript actually parse?
//
// Nothing in build:check answered that until now. Every other app suite
// reads source as TEXT — the hooks-order scanner, the Stripe key check —
// so a stray bracket or a mismatched JSX tag would sail through CI and
// surface as a red screen on a driveway, or as a failed EAS build twenty
// minutes after it was pushed.
//
// This parses every file under pjl-field/src and App.js with the app's
// own Babel, JSX and all. It does not run them and cannot know whether
// they behave — it knows whether they are syntactically real, which is
// the specific thing that was unchecked.
//
// Written while adding Tap to Pay, where a build failure costs a
// TestFlight-less round trip through EAS and there is no simulator on
// this machine to catch it first.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'pjl-field');

// Babel lives in the app's own node_modules, not the repo root's.
const requireFromApp = createRequire(path.join(APP, 'package.json'));

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

let babel = null;
try { babel = requireFromApp('@babel/core'); } catch { /* reported below */ }

check('the app’s Babel is installed', () => {
  assert.ok(babel, 'run `npm install` in pjl-field — without Babel this suite cannot check anything');
});

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

if (babel) {
  const files = [path.join(APP, 'App.js'), ...jsFiles(path.join(APP, 'src'))];

  check('there are app sources to parse', () => {
    assert.ok(files.length >= 10, `expected the app's sources, found ${files.length}`);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    check(`${rel} parses`, () => {
      babel.parseSync(readFileSync(file, 'utf8'), {
        filename: file,
        // Parse only — no plugin resolution, no transform. Enough to
        // reject bad syntax, cheap enough to run on every check.
        babelrc: false,
        configFile: false,
        parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      });
    });
  }

  check('the check catches the exact bug it was written for', () => {
    // Without this, a green run could mean the parser never rejects.
    let threw = false;
    try {
      babel.parseSync('export default function A() { return (<View>; }', {
        filename: 'broken.js',
        babelrc: false,
        configFile: false,
        parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      });
    } catch { threw = true; }
    assert.ok(threw, 'the parser accepted unmatched JSX — this suite would prove nothing');
  });
}

console.log(`\napp-parses: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

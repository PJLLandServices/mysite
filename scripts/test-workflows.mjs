// Guards on the GitHub Actions workflows.
//
// Not a schema validator — GitHub's own parser is the authority and it runs
// on their servers. This pins the two mistakes that have actually cost
// something here, both of which are invisible until they are expensive.
//
// 1. A context used where GitHub does not allow it. `inputs` in a job's
//    `env` made field-app-build.yml unparseable. An invalid workflow does
//    not fail quietly: GitHub cannot read its triggers, so it raises a
//    failed, job-less run on EVERY push to EVERY branch and emails about
//    each one. Fifteen of those arrived before anyone looked.
//
// 2. The eas-cli version drifting out of step with eas.json. On 2026-09-02
//    a build and its updates were fingerprinted by different CLI versions,
//    the update went to a runtime no phone was listening on, and every
//    command reported success. The workflow comments say the two MUST
//    match; comments do not fail builds.
//
// Deliberately no YAML dependency: the suites here run on node built-ins
// alone, and a lint that needs an install is a lint that gets skipped.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github/workflows');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');

// A line is code, not prose, when its first non-space character is not #.
const codeLines = (text) =>
  text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

check('there are workflows to check', () => {
  assert.ok(files.length >= 2, `expected workflow files, found ${files.length}`);
});

// ---------------------------------------------------------------- structure
for (const f of files) {
  check(`${f}: declares a name, triggers and jobs`, () => {
    const lines = codeLines(read(f));
    for (const key of ['name:', 'on:', 'jobs:']) {
      assert.ok(
        lines.some((l) => l.startsWith(key)),
        `no top-level ${key}`,
      );
    }
  });
}

// ------------------------------------------------- the context that bit us
//
// Walk each file tracking indentation so "inside a job's env: block" is a
// real question rather than a guess. A job env sits at 4 spaces under
// jobs: > <job_id>:, and its entries at 6.
function jobEnvBlocks(text) {
  const out = [];
  const lines = text.split('\n');
  let inJobs = false;
  let envIndent = null;
  for (const line of lines) {
    if (/^jobs:/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) { inJobs = false; envIndent = null; continue; }

    const indent = line.length - line.trimStart().length;

    if (envIndent !== null) {
      // The block ends at the first line indented no further than `env:`.
      if (line.trim() && indent <= envIndent) envIndent = null;
      else { if (line.trim()) out.push(line); continue; }
    }
    // A JOB-level env (4 spaces), not a step-level one (10, under a list item).
    if (/^ {4}env:\s*$/.test(line)) envIndent = indent;
  }
  return out;
}

for (const f of files) {
  check(`${f}: a job's env uses no context GitHub forbids there`, () => {
    const offenders = jobEnvBlocks(read(f))
      .filter((l) => !l.trim().startsWith('#'))
      // The context name must START a reference. `github.event.inputs.submit`
      // is the event payload and is perfectly legal; a bare `inputs.` is not.
      .filter((l) => /\$\{\{[^}]*(?<![.\w])(inputs|needs|steps|job|runner|env)\s*\./.test(l));
    assert.equal(
      offenders.length, 0,
      `job-level env may only read github/secrets/vars here — found: ${offenders.map((l) => l.trim()).join(' | ')}`,
    );
  });
}

check('the guard would actually catch the original mistake', () => {
  // Without this, the check above could pass because the walker found
  // nothing at all rather than because nothing is wrong.
  const broken = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    env:',
    "      SUBMIT: ${{ github.event_name != 'workflow_dispatch' || inputs.submit }}",
    '    steps:',
    '      - run: echo hi',
  ].join('\n');
  const found = jobEnvBlocks(broken).filter((l) => /\binputs\s*\./.test(l));
  assert.equal(found.length, 1, 'the walker missed a job-level env entry it should have seen');
});

check('the guard tells github.event.inputs from a bare inputs', () => {
  // The distinction the whole fix turns on. Getting this wrong in the
  // permissive direction misses the bug; getting it wrong in the strict
  // direction blocks the correct code, which is what the first draft of
  // this guard did.
  const forbidden = /\$\{\{[^}]*(?<![.\w])(inputs|needs|steps|job|runner|env)\s*\./;
  assert.ok(forbidden.test("      X: ${{ inputs.submit }}"), 'bare inputs. should be flagged');
  assert.ok(!forbidden.test("      X: ${{ github.event.inputs.submit == 'true' }}"), 'github.event.inputs should be allowed');
  assert.ok(!forbidden.test("      X: ${{ secrets.EXPO_TOKEN }}"), 'secrets should be allowed');
});

check('the guard does not fire on a step-level env', () => {
  // Step env CAN read inputs, and did for the whole time the workflow was
  // valid. Flagging it would push people away from something legal.
  const fine = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: Build',
    '        env:',
    '          SUBMIT_FLAG: ${{ inputs.submit }}',
    '        run: echo hi',
  ].join('\n');
  assert.equal(jobEnvBlocks(fine).length, 0);
});

// ------------------------------------------- the pin that stops the outage
const easJson = readFileSync(path.join(ROOT, 'pjl-field/eas.json'), 'utf8');
const easCliVersion = JSON.parse(easJson)?.cli?.version;

check('eas.json pins an exact CLI version', () => {
  assert.ok(easCliVersion, 'eas.json has no cli.version');
  assert.match(
    easCliVersion, /^\d+\.\d+\.\d+$/,
    `cli.version must be exact, not a range — got "${easCliVersion}"`,
  );
});

check('every workflow uses that exact eas-cli version', () => {
  const wrong = [];
  for (const f of files) {
    for (const line of codeLines(read(f))) {
      for (const m of line.matchAll(/eas-cli@([0-9][\w.\-]*)/g)) {
        if (m[1] !== easCliVersion) wrong.push(`${f}: eas-cli@${m[1]}`);
      }
    }
  }
  assert.equal(
    wrong.length, 0,
    `must match eas.json cli.version (${easCliVersion}): ${wrong.join(' | ')}`,
  );
});

check('the eas-cli pin is actually being exercised', () => {
  // Guards the check above against passing because it found no references.
  const refs = files.reduce(
    (n, f) => n + [...read(f).matchAll(/eas-cli@[0-9]/g)].length, 0,
  );
  assert.ok(refs >= 2, `expected pinned eas-cli references, found ${refs}`);
});

console.log(`\nworkflows: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

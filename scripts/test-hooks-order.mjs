// The Rules of Hooks, enforced.
//
// React requires every hook to run on every render, in the same order. A
// hook declared BELOW an early return breaks that: the component calls
// eight hooks while it is loading and nine once the data arrives, and
// React refuses the second render outright.
//
// This is not a style rule. On 2026-09-05 a `useState` added below
// ClosingScreen's `if (state === 'loading') return ...` crashed the app on
// every work order open, in the field, on a phone with no console. It
// bundled cleanly, every other suite passed, and nothing said a word.
//
// The check is deliberately blunt: no hook call may appear at component-body
// indentation after the first return at that indentation. Nested callbacks
// are indented further and are not examined.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'pjl-field/src');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// A hook call sitting at component-body level: two spaces, then either a
// `const x = useThing(` binding or a bare `useEffect(` style call.
const HOOK = /^ {2}(?:const\s+[^=]+=\s*)?use[A-Z]\w*\s*\(/;
// A return at that same level — the component's own, early or final.
const EARLY_RETURN = /^ {2}(?:return\b|if\s*\(.*\)\s*return\b)/;

// Scoped per top-level function, because a file's module-level helpers come
// first and their `return`s are not the component's. Without this the check
// flags every hook in a file that happens to define a formatter above the
// component -- which is most of them, and a guard that cries wolf is worse
// than no guard.
const FN_START = /^(?:export\s+default\s+function|export\s+function|function)\s/;

function topLevelFunctions(lines) {
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && FN_START.test(lines[i])) { start = i; continue; }
    if (start !== -1 && /^\}/.test(lines[i])) { blocks.push({ start, end: i }); start = -1; }
  }
  if (start !== -1) blocks.push({ start, end: lines.length - 1 });
  return blocks;
}

function hooksAfterReturn(text) {
  const lines = text.split('\n');
  const out = [];
  for (const { start, end } of topLevelFunctions(lines)) {
    const body = lines.slice(start, end + 1);
    const firstReturn = body.findIndex((l) => EARLY_RETURN.test(l));
    if (firstReturn === -1) continue;
    body.forEach((l, i) => {
      if (i > firstReturn && HOOK.test(l)) out.push(`line ${start + i + 1}: ${l.trim()}`);
    });
  }
  return out;
}

const files = jsFiles(SRC);

check('there are source files to check', () => {
  assert.ok(files.length >= 5, `expected app sources, found ${files.length}`);
});

for (const f of files) {
  const rel = path.relative(ROOT, f);
  check(`${rel}: every hook runs before any return`, () => {
    const offenders = hooksAfterReturn(readFileSync(f, 'utf8'));
    assert.equal(
      offenders.length, 0,
      `hook declared after a return — React will crash once the branch changes:\n      ${offenders.join('\n      ')}`,
    );
  });
}

check('the check catches the exact bug it was written for', () => {
  // Without this, a green run could mean the matcher never fires.
  const broken = [
    'export default function Screen() {',
    "  const [state, setState] = useState('loading');",
    "  if (state === 'loading') return <Spinner />;",
    '  const [signing, setSigning] = useState(false);',
    '  return <View />;',
    '}',
  ].join('\n');
  const found = hooksAfterReturn(broken);
  assert.equal(found.length, 1, 'the matcher missed a hook below an early return');
  assert.match(found[0], /signing/);
});

check('the check does not fire on hooks that all precede the return', () => {
  const fine = [
    'export default function Screen() {',
    "  const [state, setState] = useState('loading');",
    '  const [signing, setSigning] = useState(false);',
    '  useEffect(() => {}, []);',
    "  if (state === 'loading') return <Spinner />;",
    '  return <View />;',
    '}',
  ].join('\n');
  assert.deepEqual(hooksAfterReturn(fine), []);
});

check('a nested callback containing a return is not mistaken for one', () => {
  // Callbacks are indented further; treating their returns as the
  // component's would flag correct code and train people to ignore this.
  const fine = [
    'export default function Screen() {',
    '  const onPress = useCallback(() => {',
    '    if (!ready) return;',
    '    go();',
    '  }, [ready]);',
    '  const [signing, setSigning] = useState(false);',
    '  return <View />;',
    '}',
  ].join('\n');
  assert.deepEqual(hooksAfterReturn(fine), []);
});

console.log(`\nhooks-order: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

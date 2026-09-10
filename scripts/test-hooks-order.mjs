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
// It happened again on 2026-09-09, in TodayScreen, and this suite was GREEN
// for it: the removal work put two useCallbacks below
//
//     if (state === 'loading') {
//       return <View>...</View>;
//     }
//
// and the old matcher only knew the one-line form of an early return, so the
// block form walked straight past it. A guard with a hole in the shape of the
// commonest way to write the thing is not a guard. It now tracks braces and
// finds the component's own returns wherever they sit.
//
// The rule: no hook call at component-body level may appear after the first
// return belonging to that component. Returns inside a callback nested in the
// component exit the callback, not the render, and do not count.

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

// Strings and comments are stripped before any brace is counted: a `{` inside
// a message is not a block, and counting it drifts the depth for the rest of
// the file.
function code(line) {
  return line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '');
}

// The first return that belongs to the FUNCTION ITSELF, at any indentation.
//
// Indentation alone was the original test here, and it had a hole big enough
// to ship a crash through: it only recognised `  return` and `  if (x) return`
// on one line. The block form
//
//     if (state === 'loading') {
//       return <Spinner />;
//     }
//
// puts the return four spaces in, so every hook below it was waved past --
// which is how TodayScreen came to declare two useCallbacks under three of
// them (2026-09-09). So track braces instead, and skip returns that belong to
// a callback nested inside the component; those exit the callback, not the
// render.
function firstOwnReturn(body) {
  let depth = 0;
  const nested = [];           // depths at which a nested function opened
  for (let i = 1; i < body.length; i++) {
    const line = code(body[i]);
    if (!nested.length && /(?:^|[^\w.$])return\b/.test(line)) return i;
    const opensFn = /(?:=>\s*\{|\bfunction\b[^{]*\{)/.test(line);
    const before = depth;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (opensFn && depth > before) nested.push(before);
    while (nested.length && depth <= nested[nested.length - 1]) nested.pop();
  }
  return -1;
}

function hooksAfterReturn(text) {
  const lines = text.split('\n');
  const out = [];
  for (const { start, end } of topLevelFunctions(lines)) {
    const body = lines.slice(start, end + 1);
    const firstReturn = firstOwnReturn(body);
    if (firstReturn === -1) continue;
    body.forEach((l, i) => {
      if (i > firstReturn && HOOK.test(l)) out.push(`line ${start + i + 1}: ${l.trim()}`);
    });
  }
  return out;
}

// App.js is a component too, and the shell crashing takes everything with it.
const files = [...jsFiles(SRC), path.join(ROOT, 'pjl-field/App.js')];

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

check('the block form of an early return is not waved past', () => {
  // The exact shape that was green while TodayScreen was crashing.
  const broken = [
    'export default function Screen() {',
    "  const [state, setState] = useState('loading');",
    "  if (state === 'loading') {",
    '    return <Spinner />;',
    '  }',
    '  const onPick = useCallback(() => {}, []);',
    '  return <View />;',
    '}',
  ].join('\n');
  const found = hooksAfterReturn(broken);
  assert.equal(found.length, 1, 'a return inside an if-block was not treated as the component\u2019s');
  assert.match(found[0], /onPick/);
});

check('a brace inside a string does not shift the depth', () => {
  // Alert copy in this app contains braces and apostrophes; miscounting one
  // makes every later return look like it belongs to a callback, and the
  // guard silently stops guarding.
  const broken = [
    'export default function Screen() {',
    "  const [state, setState] = useState('loading');",
    "  const label = 'nothing to do {yet}';",
    "  if (state === 'loading') {",
    '    return <Spinner />;',
    '  }',
    '  const onPick = useCallback(() => {}, []);',
    '  return <View />;',
    '}',
  ].join('\n');
  assert.equal(hooksAfterReturn(broken).length, 1, 'a string brace broke the depth count');
});

check('a return inside a nested callback is still not the component\u2019s', () => {
  // The block form of the same thing the one-line test covers, because the
  // brace tracking is what now decides it.
  const fine = [
    'export default function Screen() {',
    '  const onPress = useCallback(() => {',
    '    if (!ready) {',
    '      return;',
    '    }',
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

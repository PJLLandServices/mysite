// The schedule screens' date arithmetic.
//
// Worth pinning because every bug here is invisible until it is a wrong
// day's work: the tech opens the app on a driveway and the schedule is
// for tomorrow. The three that actually bite are UTC drift (an evening in
// Toronto rendering as the next date), DST boundaries, and month-end
// arithmetic — "a month before March 31" has more than one wrong answer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'pjl-field/src/dates.js');

const {
  ymd, fromYmd, addDays, startOfWeek, addMonths, startOfMonth, sameMonth, monthGrid, WEEKDAY_INITIALS,
} = await import(`file://${SRC}`);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// ---------------------------------------------------------------- round trip
check('ymd and fromYmd round-trip', () => {
  for (const s of ['2026-01-01', '2026-02-28', '2026-03-08', '2026-11-01', '2026-12-31']) {
    assert.equal(ymd(fromYmd(s)), s);
  }
});

check('dates are built at noon, so a day cannot slip across UTC', () => {
  // The bug this prevents: a Date at midnight local, rendered through any
  // UTC-based path, becomes the previous or next date in Toronto.
  for (const s of ['2026-06-15', '2026-12-15']) {
    assert.equal(fromYmd(s).getHours(), 12);
  }
});

// ------------------------------------------------------------- week handling
check('weeks start on Monday', () => {
  // 2026-09-02 is a Wednesday.
  assert.equal(ymd(startOfWeek(fromYmd('2026-09-02'))), '2026-08-31');
});

check('a Sunday belongs to the week that started six days earlier', () => {
  // The classic off-by-one: Sunday is day 0, so a naive -getDay() puts it
  // at the START of a new week and the strip shows the wrong seven days.
  const sunday = fromYmd('2026-09-06');
  assert.equal(sunday.getDay(), 0);
  assert.equal(ymd(startOfWeek(sunday)), '2026-08-31');
});

check('a Monday is its own week start', () => {
  assert.equal(ymd(startOfWeek(fromYmd('2026-08-31'))), '2026-08-31');
});

check('WEEKDAY_INITIALS is Monday-first and seven long', () => {
  assert.equal(WEEKDAY_INITIALS.length, 7);
  assert.deepEqual(WEEKDAY_INITIALS, ['M', 'T', 'W', 'T', 'F', 'S', 'S']);
});

// ---------------------------------------------------------------------- DST
check('addDays crosses a spring-forward boundary without losing a day', () => {
  // North American DST begins 2026-03-08. Adding 24h of milliseconds here
  // lands back on the 8th; setDate is what makes this correct.
  assert.equal(ymd(addDays(fromYmd('2026-03-07'), 1)), '2026-03-08');
  assert.equal(ymd(addDays(fromYmd('2026-03-08'), 1)), '2026-03-09');
});

check('addDays crosses a fall-back boundary without repeating a day', () => {
  assert.equal(ymd(addDays(fromYmd('2026-10-31'), 1)), '2026-11-01');
  assert.equal(ymd(addDays(fromYmd('2026-11-01'), 1)), '2026-11-02');
});

check('a week of addDays from any start yields seven distinct dates', () => {
  for (const start of ['2026-03-02', '2026-10-26', '2026-12-28']) {
    const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(fromYmd(start), i)));
    assert.equal(new Set(days).size, 7);
  }
});

// ------------------------------------------------------------ month stepping
check('addMonths does not skip February from a 31st', () => {
  // The bug: January 31 + 1 month, done by setMonth or by adding 30 days,
  // lands in March and February is unreachable by paging.
  assert.equal(ymd(addMonths(fromYmd('2026-01-31'), 1)), '2026-02-28');
});

check('addMonths clamps into a short month going backwards too', () => {
  assert.equal(ymd(addMonths(fromYmd('2026-03-31'), -1)), '2026-02-28');
});

check('addMonths handles a leap February', () => {
  assert.equal(ymd(addMonths(fromYmd('2028-01-31'), 1)), '2028-02-29');
});

check('addMonths crosses a year in both directions', () => {
  assert.equal(ymd(addMonths(fromYmd('2026-12-15'), 1)), '2027-01-15');
  assert.equal(ymd(addMonths(fromYmd('2026-01-15'), -1)), '2025-12-15');
});

check('stepping forward twelve months returns to the same day', () => {
  let d = fromYmd('2026-09-05');
  for (let i = 0; i < 12; i++) d = addMonths(d, 1);
  assert.equal(ymd(d), '2027-09-05');
});

check('startOfMonth lands on the 1st at noon', () => {
  const d = startOfMonth(fromYmd('2026-09-23'));
  assert.equal(ymd(d), '2026-09-01');
  assert.equal(d.getHours(), 12);
});

check('sameMonth distinguishes the same month in different years', () => {
  assert.equal(sameMonth(fromYmd('2026-09-01'), fromYmd('2026-09-30')), true);
  assert.equal(sameMonth(fromYmd('2026-09-01'), fromYmd('2025-09-01')), false);
});

// ----------------------------------------------------------------- the grid
check('monthGrid is always 42 days, whatever the month', () => {
  for (const s of ['2026-02-01', '2026-08-01', '2026-11-01', '2028-02-01']) {
    assert.equal(monthGrid(fromYmd(s)).length, 42);
  }
});

check('monthGrid starts on a Monday', () => {
  for (const s of ['2026-01-15', '2026-09-05', '2027-05-20']) {
    assert.equal(monthGrid(fromYmd(s))[0].getDay(), 1);
  }
});

check('monthGrid contains every day of its month', () => {
  const grid = monthGrid(fromYmd('2026-09-05')).map(ymd);
  for (let day = 1; day <= 30; day++) {
    assert.ok(grid.includes(`2026-09-${String(day).padStart(2, '0')}`), `missing Sep ${day}`);
  }
});

check('monthGrid days are consecutive with no gaps or repeats', () => {
  const grid = monthGrid(fromYmd('2026-03-01'));  // spans the DST change
  assert.equal(new Set(grid.map(ymd)).size, 42);
  for (let i = 1; i < grid.length; i++) {
    assert.equal(ymd(grid[i]), ymd(addDays(grid[i - 1], 1)), `gap at index ${i}`);
  }
});

check('monthGrid covers the whole month even when it starts on a Sunday', () => {
  // The worst case for a Monday-first grid: 2026-11-01 is a Sunday, so the
  // month needs the sixth row that a five-row grid would not have.
  const first = fromYmd('2026-11-01');
  assert.equal(first.getDay(), 0);
  const grid = monthGrid(first).map(ymd);
  assert.ok(grid.includes('2026-11-01'));
  assert.ok(grid.includes('2026-11-30'));
});

check('the picker and the week strip agree on which week a date is in', () => {
  // The reason dates.js exists: the strip's startOfWeek and the grid's
  // rows are the same function, so a date cannot land in one row on the
  // strip and a different one in the calendar.
  const d = fromYmd('2026-09-06');           // a Sunday
  const grid = monthGrid(d).map(ymd);
  const rowStart = grid[Math.floor(grid.indexOf(ymd(d)) / 7) * 7];
  assert.equal(rowStart, ymd(startOfWeek(d)));
});

// ------------------------------------------------------------ source guards
const src = readFileSync(SRC, 'utf8');
// Comments stripped first: the file explains at length why toISOString is
// the wrong tool, and a guard that cannot tell prose from code would fail
// on its own documentation.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('dates.js never reaches for UTC', () => {
  for (const banned of ['toISOString', 'getUTC', 'setUTC', 'Date.UTC']) {
    assert.ok(!code.includes(banned), `dates.js uses ${banned}`);
  }
});

check('the UTC guard reads code rather than comments', () => {
  // Guards this test against itself: if comment-stripping regressed, the
  // check above would pass vacuously on a file that does use UTC.
  assert.ok(src.includes('toISOString'), 'expected the explanatory comment to still be there');
  assert.ok(!code.includes('toISOString'));
});

check('dates.js has no imports, so it stays testable on its own', () => {
  assert.ok(!/^\s*import\s/m.test(src));
});

console.log(`\ndates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

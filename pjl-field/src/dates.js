// Date arithmetic for the schedule screens.
//
// Pulled out of TodayScreen because the month picker needs the same
// notion of a week that the week strip uses. Two copies of "weeks start
// on Monday" is one copy too many: the strip and the calendar under it
// would eventually disagree about which row a date belongs to, and the
// bug would look like the calendar picking the wrong day.
//
// NOTHING HERE TOUCHES UTC. Every date is built at NOON local time.
// `toISOString()` would render a Toronto evening as tomorrow's date and
// ask the server for the wrong day's schedule; noon also survives a DST
// boundary, where midnight can be a time that does not exist.

export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const fromYmd = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
};

export const addDays = (date, n) => {
  const c = new Date(date);
  c.setDate(c.getDate() + n);
  return c;
};

// Weeks run Monday to Sunday — a work week, not a calendar-app week.
export const startOfWeek = (date) => addDays(date, -((date.getDay() + 6) % 7));

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export const startOfMonth = (date) =>
  new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0);

// Month arithmetic by month NUMBER, not by adding days. Adding 30 days to
// January 31 lands in March; setMonth on a 31st does the same. Building the
// date from parts and clamping the day is the only version that answers
// "the month before this one" correctly from every starting date.
export const addMonths = (date, n) => {
  const y = date.getFullYear();
  const m = date.getMonth() + n;
  const target = new Date(y, m, 1, 12, 0, 0);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
};

export const sameMonth = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

// The six-week grid a month is drawn on, Monday first.
//
// ALWAYS six rows, even when five would hold the month. A grid that
// changes height moves every control below it when you page between
// months, and on a phone that means the day you were reaching for slides
// out from under your thumb.
export const monthGrid = (date) => {
  const first = startOfWeek(startOfMonth(date));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
};

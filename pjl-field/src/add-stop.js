// The rules behind "Add a stop", kept out of the screen so they can be
// tested without React Native.
//
// Patrick: "Sometimes we are approached by customers while on a daily
// route, we try not to turn anyone down... we still want to remain
// professional and be able to tackle their closing as well, while still
// recording all paperwork, and then adding it into the daily flow as it
// would have been."
//
// "AS IT WOULD HAVE BEEN" is the specification. The stop walks the
// ordinary booking path — same lead, same customer, same property, same
// work order, same price off the same tier — just quickly, and from the
// driveway. Nothing here invents a cheaper route through the system.

const clean = (v) => String(v == null ? '' : v).trim();

const pad = (n) => String(n).padStart(2, '0');
export const localYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The street you are parked on, without the house number.
//
// The phone has NO REVERSE GEOCODING — server/lib/geocode.js goes one way
// only — so "you are here" would mean a new Google dependency on an API
// that has refused us before. The street you are standing on is already
// on the screen in front of you; this hands it to the address box as a
// starting point, and the house number is one tap.
export function streetHint(address) {
  const rest = clean(address).replace(/^\s*\d+[A-Za-z]?\s*/, '');
  return rest || '';
}

// Which stop's street you are most likely standing on: the one you are
// working, else the next one you have not finished, else the last of the
// day. A wrong guess costs a tap; no guess costs a whole address.
export function whereYouAre(bookings) {
  const rows = Array.isArray(bookings) ? bookings : [];
  const onSite = rows.find((b) => b?.workOrder?.status === 'on_site');
  const unfinished = rows.find((b) => !b?.workOrder || b.workOrder.status !== 'completed');
  const row = onSite || unfinished || rows[rows.length - 1] || null;
  return clean(row?.address);
}

// A stop can only be added to a day that has not happened. Backdating a
// booking onto Tuesday from Thursday would put a job on a route nobody
// drove, and the day screen browses freely in both directions.
export function canAddStop(day, now = new Date()) {
  if (!day) return true;                     // no day chosen yet means today
  return String(day) >= localYmd(now);
}

// When the new stop goes on the calendar.
//
// NOT "now", and this is the one place the design bends away from the
// render. Reserve refuses a force-book that physically overlaps an active
// booking, and the job you are standing at IS one — so a stop timed now
// would come back 409 while the customer watches. It lands after the last
// thing on the day instead, and the work order's own arrivedAt and
// departedAt record when it actually happened, which is the honest record
// either way.

// The envelope assumed for a stop whose end nobody wrote down.
const LONG_VISIT_MS = 3 * 60 * 60 * 1000;

export function nextFreeStart(dayBookings, { day = null, now = new Date() } = {}) {
  const ends = (dayBookings || [])
    .map((b) => {
      const end = new Date(b?.end || 0).getTime();
      if (Number.isFinite(end) && end > 0) return end;
      // A row can reach the day with no end on it — a job scheduled
      // straight against a property, an older booking written before the
      // end was stored. Falling back to its START is what a careless
      // version of this did, and it produces a stop that begins while
      // that job is still running: a physical_conflict 409 thrown up in
      // front of the customer standing there. So assume the long end of
      // an ordinary visit instead. Landing an hour late costs nothing —
      // the work order records the real hours either way.
      const start = new Date(b?.start || 0).getTime();
      return Number.isFinite(start) && start > 0 ? start + LONG_VISIT_MS : 0;
    })
    .filter((t) => t > 0);
  const latest = ends.length ? Math.max(...ends) : 0;
  // An empty future day starts at eight, the same hour the grid opens.
  const floor = day && day !== localYmd(now)
    ? new Date(`${day}T08:00:00`).getTime()
    : now.getTime();
  const base = Number.isFinite(floor) ? floor : now.getTime();
  return new Date(Math.max(base, latest)).toISOString();
}

// What the notes on the lead say, so a walk-up is recognisable in the CRM
// in March without anyone having to remember it.
export const WALK_UP_NOTE = 'Added on route — customer approached the crew.';

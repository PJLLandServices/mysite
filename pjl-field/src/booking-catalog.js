// What we are booking, as a set of QUESTIONS rather than a list of keys.
//
// The server has nineteen bookable services, and every one of them names a
// season, a property type and a zone band at once — "Fall winterization
// (5-6 zones residential)". Nineteen buttons on a phone means the thing
// you want is usually scrolled off, and reading them aloud to a customer
// is not a conversation anyone wants to have.
//
// Patrick's shape instead: six categories, then a follow-up that depends
// on which one. Fall and Spring ask for zones; a service call asks how
// many issues; a site visit asks nothing. That is the order the phone call
// goes, and it collapses nineteen buttons into six.
//
// This file is pure — no React Native — so the mapping can be tested
// against the server's real service list rather than a copy of it.

// The zone band is encoded in the service key: `_4z` means "up to 4",
// `_16plus` and `_9plus` mean "and above". Read rather than restated, so a
// key the server renames fails loudly here instead of quietly mis-pricing
// a visit.
export function bandOf(key, label) {
  const upTo = String(key).match(/_(\d+)z$/);
  if (upTo) return Number(upTo[1]);
  if (/_(\d+)plus$/.test(String(key))) return Infinity;
  // Not every key carries its band. `spring_open_commercial` is the 1-4
  // commercial tier and says so only in its label — reading the key alone
  // dropped it, and the next tier up then claimed the range beneath it
  // ("1-8 zones" for a service that starts at 5).
  const range = String(label || '').match(/\((\d+)\s*-\s*(\d+)\s*zones/i);
  if (range) return Number(range[2]);
  if (/\((\d+)\+/.test(String(label || ''))) return Infinity;
  return null;
}

export const isCommercialKey = (key) => /_commercial/.test(String(key));

// The six things a booking can be. `family` matches the server's own
// grouping for the seasonal pair; the others name their service directly
// because they have exactly one.
export const CATEGORIES = [
  { key: 'fall_closing', label: 'Fall Closing', family: 'fall_closing', follow: 'zones' },
  { key: 'spring_opening', label: 'Spring Opening', family: 'spring_opening', follow: 'zones' },
  { key: 'residential_service', label: 'Residential Service', serviceKey: 'sprinkler_repair', follow: 'issues' },
  { key: 'commercial_service', label: 'Commercial Service', serviceKey: 'sprinkler_repair', follow: 'issues' },
  { key: 'site_visit', label: 'Site Visit / Scope', serviceKey: 'site_visit', follow: null },
  { key: 'hydrawise_retrofit', label: 'Hydrawise Retrofit', serviceKey: 'hydrawise_retrofit', follow: 'zones_only' },
];

// The season a category sits in, taken from whichever of its services the
// server annotated. Not computed here: the server owns that answer and a
// second copy of it is a second answer.
export function seasonOfCategory(services, category) {
  if (!category?.family) return null;
  for (const svc of Object.values(services || {})) {
    if (svc?.family === category.family && svc.season) return svc.season;
  }
  return null;
}

// IN SEASON FIRST. It is fall, so Fall Closing is the first button — and
// in March it will be Spring, without anyone editing this.
//
// Order within the three tiers is the order above, which is Patrick's.
// A category whose season has ENDED sinks to the bottom rather than
// vanishing: he books work the public flow will not.
export function categoriesInOrder(services) {
  const rank = (c) => {
    const s = seasonOfCategory(services, c);
    if (!s) return 1;                 // year-round work sits between
    if (s.open) return 0;             // its dates are running now
    if (s.bookable) return 1;         // bookable, dates start later
    return 2;                         // season is spent
  };
  return CATEGORIES
    .map((c, i) => ({ ...c, season: seasonOfCategory(services, c), order: i }))
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

// The zone bands the server actually offers for a family, residential and
// commercial kept apart because their bands differ — residential splits
// 5-6 and 7-8 where commercial has one 5-8.
export function bandsFor(services, family) {
  return Object.entries(services || {})
    .filter(([, s]) => s?.bookable && s.family === family)
    .map(([key, s]) => ({ key, label: s.label, top: bandOf(key, s.label), commercial: isCommercialKey(key) }))
    .filter((b) => b.top !== null)
    .sort((a, b) => (a.commercial === b.commercial ? a.top - b.top : (a.commercial ? 1 : -1)));
}

// A readable band name — "1-4 zones", "9+ zones" — built from the bands
// either side of it rather than from the server's long label, which
// repeats the season and the property type on every row.
export function bandLabel(bands, band) {
  const sameType = bands.filter((b) => b.commercial === band.commercial);
  const i = sameType.findIndex((b) => b.key === band.key);
  const prev = i > 0 ? sameType[i - 1].top : 0;
  if (!Number.isFinite(band.top)) return `${prev + 1}+ zones`;
  if (band.top - prev === 1) return `${band.top} zone${band.top === 1 ? '' : 's'}`;
  return `${prev + 1}-${band.top} zones`;
}

// Which band holds this many zones, so typing 7 selects 7-8 rather than
// leaving a contradiction on screen. Stays within the property type
// already chosen.
export function bandForZones(bands, zoneCount, { commercial = false } = {}) {
  const n = Number(zoneCount);
  if (!Number.isFinite(n) || n < 1) return null;
  return bands.filter((b) => b.commercial === commercial).find((b) => n <= b.top) || null;
}

// The exact zone counts a band can hold.
//
// The count used to be typed, which put a number pad over the screen in
// the middle of a phone call. It is a tap now, and the list is SCOPED TO
// THE BAND already chosen — so "7" can no longer be sitting under
// "1-4 zones", which is a mispriced visit nobody notices until the truck
// is there.
//
// An open-ended band (16+, 9+) has no top, so it offers a workable run
// above its floor rather than a list with no end.
export function zoneOptionsFor(bands, band, { cap = 30, open = 14 } = {}) {
  const run = (from, to) => {
    const out = [];
    for (let n = from; n <= to; n += 1) out.push(n);
    return out;
  };
  // No band to scope by — Hydrawise retrofits are priced per zone with no
  // tiers, so the whole range is offered.
  if (!band) return run(1, cap);
  const sameType = (bands || []).filter((b) => b.commercial === band.commercial);
  const i = sameType.findIndex((b) => b.key === band.key);
  const from = i > 0 ? sameType[i - 1].top + 1 : 1;
  return run(from, Number.isFinite(band.top) ? band.top : from + open);
}

// What actually gets booked. A seasonal category resolves through its
// band; everything else names its service outright.
export function serviceKeyFor(category, band) {
  if (!category) return null;
  if (category.family) return band?.key || null;
  return category.serviceKey || null;
}

// The issue counts offered. Past eight the number stops being useful to a
// scheduler, and the specifics belong in the notes anyway — so the top of
// the list is "more than 8" rather than a number pad that can take 99.
// Not a number — the one entry in the list that is a sentinel, named so
// the two places that have to recognise it cannot drift.
export const MANY_ISSUES = '8+';
export const ISSUE_COUNTS = ['1', '2', '3', '4', '5', '6', '7', '8', MANY_ISSUES];

export function issueCountLabel(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v === MANY_ISSUES) return 'More than 8';
  return `${v} issue${v === '1' ? '' : 's'}`;
}

// The follow-up question, in the words it is asked in.
export const FOLLOW_UPS = {
  zones: 'How many zones?',
  zones_only: 'How many zones?',
  issues: 'How many issues?',
};

// Everything the category asked for, written into the booking notes so it
// reaches the work order. The server has no field for "how many issues" —
// rather than invent one, it is recorded where a tech will read it, and
// labelled so it is not mistaken for a customer's own words.
export function catalogNotes({ category, zoneCount, issueCount }) {
  const lines = [];
  if (category?.key === 'residential_service' || category?.key === 'commercial_service') {
    const type = category.key === 'commercial_service' ? 'Commercial' : 'Residential';
    lines.push(`${type} service call.`);
    // The sentinel spelled out; a real count left as the number, because
    // "Issues reported: 3 issues." is the same word twice on a work order.
    if (issueCount) {
      lines.push(`Issues reported: ${issueCount === MANY_ISSUES ? 'more than 8' : issueCount}.`);
    }
  }
  if (category?.follow === 'zones_only' && zoneCount) lines.push(`Zones: ${zoneCount}.`);
  return lines.join(' ');
}

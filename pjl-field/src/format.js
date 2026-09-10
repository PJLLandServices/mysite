// Small shared formatters. Both property screens were growing their own
// copies of these; one home stops them drifting apart.

import { HOST } from './api';

export const absolute = (url) => (url && url.startsWith('/') ? `${HOST}${url}` : url);

export const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

// Currency is OPTIONAL and, when given, is shown — InvoiceScreen printed
// "$285.00 CAD" for the same invoice the property screen printed as
// "$285.00", because callers were passing a second argument this function
// silently discarded.
//
// Grouped thousands, because a five-figure commercial balance rendered
// "$12345.67" and the column of them was claimed to line up on the
// decimal. `Number(n)` rather than a typeof check: balanceDue arrives as a
// number from the server today, but three call sites already coerce
// defensively, and a string that slipped through rendered the amount as
// null — including inside a payment text that then read "(null)".
export const money = (n, currency) => {
  // A MISSING field is not zero, and this guard has to come before the
  // coercion: Number(null), Number(undefined) and Number('') are all 0, so
  // "$0.00" would be printed on a balance nobody knows — which reads as
  // "nothing owing", the opposite of the truth. InvoiceScreen's own copy
  // of this function carried the guard; the shared one has to as well.
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const amount = `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return currency ? `${amount} ${String(currency).toUpperCase()}` : amount;
};

export const shortDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // The year only when it is not this one. On a 320pt row every character
  // is contested, and "2026" on every line of a list of this year's visits
  // is ~35pt spent saying nothing.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
};

// The letter in the avatar circle.
//
// This used to be the first character of the address, which on a street
// address is the house number — "4293 ON-7" produced a circle reading
// "4", and every property on the list showed a digit that identified
// nothing. The circle is a recognition aid, so it has to carry something
// you'd actually recognise: the street, falling back to the customer.
//
// The strip handles the shapes real addresses arrive in — "123 Main St",
// "4293 ON-7", "12-45 Bayview", "#3 Elm Court", "1/2 Queen St".
// Initials for a person, for the circle on a message thread. A PERSON,
// unlike a property, has a name that means something at 40px — which is
// why the properties list has no avatar and this one does.
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase() || '?';
}

// The time stamp on a thread row: the clock for today, the weekday
// inside the last week, the date beyond that — the shape a messages
// list uses, because "9:41 AM" on a message from March is a lie about
// how recent it is.
export function messageStamp(iso, now = Date.now()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const then = new Date(now);
  if (d.toDateString() === then.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const days = (then - d) / 86400000;
  if (days >= 0 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = d.getFullYear() === then.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'numeric', day: 'numeric', ...(sameYear ? {} : { year: '2-digit' }),
  });
}

export function avatarLetter(property) {
  const p = property || {};
  const street = String(p.address || '').trim().replace(/^[\d\s\-/#.,]+/, '');
  const firstLetter = street.match(/[A-Za-z]/);
  if (firstLetter) return firstLetter[0].toUpperCase();
  const fromCustomer = String(p.customerName || '').match(/[A-Za-z]/);
  if (fromCustomer) return fromCustomer[0].toUpperCase();
  return '?';
}

// A property's own photo, when it has one, beats any letter.
export function propertyThumb(property) {
  const photos = Array.isArray(property?.photos) ? property.photos : [];
  const first = photos.find((ph) => ph && ph.url);
  return first ? absolute(first.url) : null;
}

// Zone naming, matching what the CRM's property page actually renders.
//
// `location` is the field the page reads and writes ("Front lawn — north
// strip"); `label` only survives as a fallback for older records. The
// schema comment in server/lib/properties.js still says
// `{ number, label, notes }`, which is what sent this screen looking at
// the wrong field and showing bare zone numbers.
export function zoneName(zone) {
  return String(zone?.location || zone?.label || '').trim();
}

const SPRINKLER_LABELS = {
  rotors: 'Rotors', popups: 'Pop-ups', drip: 'Drip', flower_pots: 'Flower Pots',
};
const COVERAGE_LABELS = {
  plants: 'Plants', grass: 'Grass', trees: 'Trees', shrubs: 'Shrubs',
};

// The pill selections from the property page, flattened to one readable
// line. Unknown values pass through rather than vanishing, so a
// vocabulary added on the web side still shows here.
export function zoneMeta(zone) {
  const kit = (zone?.sprinklerTypes || []).map((v) => SPRINKLER_LABELS[v] || v);
  const cover = (zone?.coverage || []).map((v) => COVERAGE_LABELS[v] || v);
  return [kit.join(', '), cover.join(', ')].filter(Boolean).join('  ·  ');
}

// The towns PJL actually serves, taken from the service-area pages at the
// site root (sprinkler-service-*.html). Used only as a last-resort match
// when an address has no parseable comma structure.
const SERVICE_TOWNS = [
  'Acton', 'Aurora', 'Bolton', 'East Gwillimbury', 'Erin', 'Forest Hill',
  'Innisfil', 'King City', 'Lawrence Park', 'Markham', 'Newmarket',
  'North York', 'Orangeville', 'Richmond Hill', 'Stouffville', 'Thornhill',
  'Toronto', 'Vaughan',
];

// Second comma segment, minus the province and any postal code. This is
// the convention the server already uses to pull a town out of a
// free-text address (lib/notify-sms.js, lib/notify-email.js), so the app
// groups properties the same way the customer's texts are worded.
function townFromSegments(value) {
  const parts = String(value || '').split(',');
  if (parts.length < 2) return '';
  return parts[1]
    .replace(/\b(ON|Ontario|Canada)\b.*/i, '')
    .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i, '')
    .trim();
}

// Properties carry no town of their own — unlike leads, which have an
// explicit contact.town. So it is derived: the geocoder's formatted
// address first (most reliable when geocoding ran), then the raw address,
// then a known-town match anywhere in the string.
export function townOf(property) {
  const parsed =
    townFromSegments(property?.coords?.formattedAddress) ||
    townFromSegments(property?.address);
  if (parsed) return parsed;
  const haystack = String(property?.address || '').toLowerCase();
  return SERVICE_TOWNS.find((t) => haystack.includes(t.toLowerCase())) || '';
}

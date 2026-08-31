// Small shared formatters. Both property screens were growing their own
// copies of these; one home stops them drifting apart.

import { HOST } from './api';

export const absolute = (url) => (url && url.startsWith('/') ? `${HOST}${url}` : url);

export const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

export const money = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;

export const shortDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

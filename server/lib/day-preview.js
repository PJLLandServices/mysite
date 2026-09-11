// "Show me the day with them in it."
//
// Patrick, 2026-09-11, after a booked day turned out to run Pickering to
// North York: "I want to temporarily see the whole day (WITH) that
// navigation map (actual drive line) inserted."
//
// The map that answers that is the one already on the Today tab. What it
// has never been able to draw is a day that does not exist yet — a day
// plus one more stop, as it WOULD be. This builds that day.
//
// THE SHAPE IS THE POINT. Everything here returns rows in exactly the
// shape `/api/schedule/today` returns, because `server/today-map.js`
// already knows how to draw those: the pins, the numbering, the morning
// and afternoon greens, the bounds fitting and the road line all come
// for free, and they keep matching the map Patrick already reads. A
// preview drawn by a second implementation would drift from the real one
// exactly when it mattered.
//
// Nothing here is booked, held, or written. It is arithmetic over a day
// the caller already has.

// The key the preview row carries. Real rows never have one, which is
// what lets the map tell them apart without changing how it keys the
// day it already draws.
const PREVIEW_KEY = "__preview__";

// Where a candidate lands, given the insertion index that
// geoFilter.addedDriveMinutes() reports.
//
// That index counts the GAPS in [yard, ...stops, yard], so gap 0 is
// "before the first stop" and gap N is "after the last". As an index
// into the stops themselves that is the same number — true, and easy to
// get subtly wrong, so scripts/test-day-preview.mjs pins both ends of it.
function insertionIndex(position, stopCount) {
  const n = Math.max(0, Math.floor(Number(stopCount) || 0));
  const p = Math.floor(Number(position));
  if (!Number.isFinite(p) || p < 0) return n;   // unknown -> the end, never the front
  return Math.min(p, n);
}

// The candidate, wearing the day endpoint's clothes.
//
// `start` is what the map reads to decide morning or afternoon, and it is
// the only reason a time appears here at all — the preview makes no claim
// about when the visit would be, because nothing has been scheduled.
function candidateRow({ address, town, customerName, serviceLabel, coords, start }) {
  return {
    leadId: null,
    bookingId: null,
    // A key nothing else can collide with. The map keys its markers by
    // this and the preview asks it to focus this one, which is how the
    // new stop gets the orange ring the map already uses for "this is the
    // one you are looking at" — no new colour to learn, and no new
    // drawing code.
    previewKey: PREVIEW_KEY,
    start: start || null,
    end: null,
    startLabel: "",
    endLabel: "",
    source: "preview",
    candidate: true,
    customerName: customerName || "",
    customerPhone: "",
    customerEmail: "",
    address: address || "",
    town: town || "",
    coords: coords && coords.lat != null
      ? { lat: Number(coords.lat), lng: Number(coords.lng) }
      : null,
    serviceKey: "",
    serviceLabel: serviceLabel || "",
    customerNotes: "",
    internalNotes: "",
    stage: "preview",
    propertyId: null,
    workOrder: null,
    onRouteNotifiedAt: null
  };
}

// The day as it would be. Existing rows are passed through UNTOUCHED —
// this never re-orders, re-times or re-decides anything about them. The
// day's own order is the server's answer and the map draws the numbers
// from it; a preview that quietly resequenced the real stops would show
// Patrick a day he is not going to drive.
function dayWithCandidate(rows, candidate, position) {
  const day = Array.isArray(rows) ? rows.slice() : [];
  if (!candidate) return day;
  day.splice(insertionIndex(position, day.length), 0, candidate);
  return day;
}

// Everything the map needs to draw the line, in the order it will drive
// it. Rows with no coordinates keep their place in the list and simply
// cannot be drawn — the map already says how many it had to leave out.
function lineStops(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => (row && row.coords && row.coords.lat != null
      ? { lat: Number(row.coords.lat), lng: Number(row.coords.lng) }
      : null))
    .filter(Boolean);
}

module.exports = {
  PREVIEW_KEY,
  insertionIndex,
  candidateRow,
  dayWithCandidate,
  lineStops
};

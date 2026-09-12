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

// ---- The Season Plan side ------------------------------------------
//
// Patrick, 2026-09-12, on the "Best: Oct 6 · +4 min" line: "honestly,
// that's literally no help either. Can you do something that allows me
// to see the map of what the day would look like with the appointment
// incorporated, and I choose whether or not I want to add it to that
// day?"
//
// A number is not a route. The route day he would drive, WITH the new
// stop numbered into it and the road line drawn through it, is the thing
// he can judge; the decision stays his. These helpers build the stored
// day as it would be, and read the two figures that change — nothing
// here writes.

// The stored day with one more code in one bucket. Everything else on
// the day — the other bucket, the label, the time windows, a manual
// order — is carried across untouched, so the preview is that day plus
// one stop and not a day rebuilt from scratch. A code already on the day
// is not added twice: the preview of "the day with it" is the day.
function planDayWithCandidate(storedDay, code, bucket) {
  const base = storedDay && typeof storedDay === "object" ? storedDay : {};
  const morning = Array.isArray(base.morning) ? base.morning.slice() : [];
  const afternoon = Array.isArray(base.afternoon) ? base.afternoon.slice() : [];
  const wanted = String(code || "").trim();
  const day = { ...base, morning, afternoon };
  if (!wanted || morning.includes(wanted) || afternoon.includes(wanted)) return day;
  (bucket === "morning" ? morning : afternoon).push(wanted);
  return day;
}

// The figures that decide the question, read off a resolved day the
// same way the board's chips read them. Stops are plan stops AND booked
// appointments — the one total the rail shows.
function daySummary(day) {
  if (!day || typeof day !== "object") return null;
  const planned = day.counts && Number.isFinite(day.counts.total) ? day.counts.total : 0;
  const booked = Array.isArray(day.booked) ? day.booked.length : 0;
  return {
    driveMinutes: Number.isFinite(day.driveMinutes) ? day.driveMinutes : null,
    homeAt: day.homeAt || null,
    morningEndsAt: day.morningEndsAt || null,
    stops: planned + booked,
    flags: Array.isArray(day.flags) ? day.flags.map((f) => f && f.message).filter(Boolean) : []
  };
}

// Minutes the day grows by. Null when either side has no drive figure —
// "+?" is honest where "+0" would be a claim.
function driveDelta(before, after) {
  const a = before && Number.isFinite(before.driveMinutes) ? before.driveMinutes : null;
  const b = after && Number.isFinite(after.driveMinutes) ? after.driveMinutes : null;
  if (a == null || b == null) return null;
  return b - a;
}

// The drawable stops of a RESOLVED plan day, in driving order: the
// timeline decides the order, the bucket rows supply a plan stop's
// coordinates and the booked rows supply a booking's, by its mapCode.
// This is the page's mappableStops() read on the server, so the line
// the preview draws follows the numbers the preview prints.
function planLineStops(day) {
  if (!day || typeof day !== "object") return [];
  const byCode = new Map();
  for (const stop of [...(day.morning || []), ...(day.afternoon || [])]) {
    if (stop && stop.code) byCode.set(stop.code, stop);
  }
  for (const row of day.booked || []) {
    if (row && row.mapCode) byCode.set(row.mapCode, row);
  }
  return (day.timeline || []).map((t) => {
    const hit = t && byCode.get(t.propertyCode);
    if (!hit || !hit.coords || hit.coords.lat == null) return null;
    return { number: t.stopNumber, coords: { lat: Number(hit.coords.lat), lng: Number(hit.coords.lng) } };
  }).filter(Boolean);
}

module.exports = {
  PREVIEW_KEY,
  insertionIndex,
  candidateRow,
  dayWithCandidate,
  lineStops,
  planDayWithCandidate,
  daySummary,
  driveDelta,
  planLineStops
};

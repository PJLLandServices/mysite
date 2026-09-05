// The open bucket — "first available" standby appointments.
//
// Patrick, 2026-09-05: "we had the potential for an 'open bucket' first
// next available type situation that allows us to collect open non
// actually booked appointments, and throw it in our day... if it's 'on
// our way home' we can pick it up at the end of all the calls."
//
// A standby customer has COMMITTED but holds no appointment: their lead
// carries a `standby` envelope and no `lead.booking`, so they consume no
// capacity, appear on no calendar, and trigger no reminders. The Season
// Plan's Open bucket panel ranks each of them against the upcoming route
// days with the same cheapest-insertion drive math the geography filter
// uses — the "on our way home" number — and placing one books them
// through the EXISTING book-from-lead path, so the booking envelope,
// canonical mirror, confirmation message and calendar links all ride the
// machinery that already works.

const geoFilter = require("./geo-filter");

// Rank the day shapes for one standby customer's coordinates: cheapest
// added drive first, earliest date breaking ties. Only days from
// `todayKey` forward, and only days with something actually on them —
// an empty day costs +0 by definition and is not "on our way".
// Returns [{ date, label, bookingsOnly, points, addedDriveMinutes }].
async function rankDaysForCoords(coords, shapes, { max = 3, todayKey } = {}) {
  if (!coords || coords.lat == null || !shapes) return [];
  const ranked = [];
  for (const date of Object.keys(shapes)) {
    if (todayKey && date < todayKey) continue;
    const shape = shapes[date];
    if (!shape || !Array.isArray(shape.points) || !shape.points.length) continue;
    const added = await geoFilter.addedDriveMinutes(coords, shape.points);
    if (!added || !Number.isFinite(added.minutes)) continue;
    ranked.push({
      date,
      label: shape.label || "",
      bookingsOnly: Boolean(shape.bookingsOnly),
      points: shape.points.length,
      addedDriveMinutes: added.minutes
    });
  }
  ranked.sort((a, b) =>
    (a.addedDriveMinutes - b.addedDriveMinutes) || (a.date < b.date ? -1 : 1));
  const cap = Number(max) > 0 ? Number(max) : 3;
  return ranked.slice(0, cap);
}

// The leads that are waiting in the bucket: a standby envelope, no
// booking yet, still alive. Sorted oldest first — first in, first out.
function waitingLeads(leads) {
  return (leads || [])
    .filter((l) => l && l.standby && !l.booking && !l.archived
      && (l.crm?.status || l.status) !== "lost")
    .sort((a, b) => String(a.standby.requestedAt || "").localeCompare(String(b.standby.requestedAt || "")));
}

module.exports = { rankDaysForCoords, waitingLeads };

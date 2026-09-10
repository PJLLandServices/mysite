// Job finder — "why isn't this customer on the schedule?"
//
// Born from a three-round hunt for one customer's missing jobs
// (FLOW-32, Willowridge): three real gaps got fixed along the way, each
// found by reading code, and the live symptom outlived all three. This
// module ends the guessing: given a search term, it inspects EVERY
// store a job's date can live in and reports, record by record, in
// plain sentences, whether that record shows on a given day's schedule
// — and when it doesn't, exactly why not.
//
// The five homes a job can have:
//   1. a LEAD with lead.booking          (public booking flow)
//   2. a canonical BOOKING record        (assignment writer, lead mirror)
//   3. a WORK ORDER with scheduledFor    (CRM new-WO form / WO page)
//   4. a PROPERTY                        (no date itself, but the link
//                                         that finds records whose own
//                                         name field is blank)
//   5. a SEASON-PLAN STOP                (planned, but only a booking
//                                         makes it real)
//
// Pure: every store is handed in, nothing is read from disk, no dates
// beyond what it is given. Tested by scripts/test-job-finder.mjs.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Date parsing is day-schedule's — the finder must judge a record with
// EXACTLY the rule the schedule uses, or its verdicts lie.
const { parseStored: parseSchedDate } = require("./day-schedule");
function parseStored(value) {
  if (!value) return { when: null, dateOnly: false };
  const text = String(value).trim();
  return { when: parseSchedDate(text), dateOnly: DATE_ONLY_RE.test(text) };
}

function localDayKey(when) {
  if (!when) return null;
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
}

function matchesQuery(q, ...fields) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return false;
  return fields.some((f) => String(f || "").toLowerCase().includes(needle));
}

// One record's verdict against the asked-about day.
function dayVerdict(kindLabel, rawDate, dateKey) {
  const { when, dateOnly } = parseStored(rawDate);
  if (!rawDate) {
    return { onDay: false, verdict: `${kindLabel} has NO scheduled date at all — nothing puts it on any day's schedule.` };
  }
  if (!when) {
    return { onDay: false, verdict: `${kindLabel} carries an unreadable date ("${rawDate}") — it can never land on a schedule until it is re-saved.` };
  }
  const day = localDayKey(when);
  const note = dateOnly ? " (stored as a date with no time — counted as local midnight)" : "";
  if (day === dateKey) {
    return { onDay: true, verdict: `scheduled ${day}${note} — SHOULD show on this day.` };
  }
  return { onDay: false, verdict: `scheduled ${day}${note} — a different day than ${dateKey}.` };
}

// stores = {
//   leads:      full leads array
//   bookings:   canonical bookings.json records
//   workOrders: all work orders
//   properties: all properties
//   plans:      [{ season, year, plan }] — season plans worth checking
// }
function findJobs(q, dateKey, stores = {}) {
  const leads = Array.isArray(stores.leads) ? stores.leads : [];
  const bookings = Array.isArray(stores.bookings) ? stores.bookings : [];
  const workOrders = Array.isArray(stores.workOrders) ? stores.workOrders : [];
  const properties = Array.isArray(stores.properties) ? stores.properties : [];
  const plans = Array.isArray(stores.plans) ? stores.plans : [];

  const out = { query: String(q || ""), date: dateKey, properties: [], leads: [], bookings: [], workOrders: [], planStops: [] };
  if (!String(q || "").trim()) return out;

  // Properties first: they are the join key. A work order raised against
  // a property often carries a blank or different customerName, so the
  // search must reach records BY LINK, not only by their own text.
  const matchedProps = properties.filter((p) => p && !p.deletedAt
    && matchesQuery(q, p.customerName, p.address, p.code, p.town, p.customerEmail));
  const propIds = new Set(matchedProps.map((p) => p.id));
  const propCustomerIds = new Set(matchedProps.map((p) => p.customerId).filter(Boolean));
  for (const p of matchedProps) {
    out.properties.push({
      id: p.id, code: p.code || p.id, name: p.customerName || "", address: p.address || ""
    });
  }

  const hits = (record, own) => own
    || (record.propertyId && propIds.has(record.propertyId))
    || (record.customerId && propCustomerIds.has(record.customerId));

  for (const lead of leads) {
    if (!lead) continue;
    const own = matchesQuery(q, lead.contact?.name, lead.contact?.address, lead.contact?.email, lead.company);
    if (!hits(lead, own)) continue;
    const row = {
      id: lead.id, name: lead.contact?.name || "", address: lead.contact?.address || "",
      raw: lead.booking?.start || null
    };
    if (lead.archived) {
      row.onDay = false;
      row.verdict = "this lead is ARCHIVED — archived leads never show on the schedule.";
    } else if (!lead.booking) {
      row.onDay = false;
      row.verdict = "a lead with no booking — an enquiry, not a scheduled job.";
    } else {
      Object.assign(row, dayVerdict("this lead's booking", lead.booking.start, dateKey));
    }
    out.leads.push(row);
  }

  for (const b of bookings) {
    if (!b) continue;
    const own = matchesQuery(q, b.customerName, b.address, b.customerEmail);
    if (!hits(b, own)) continue;
    const row = {
      id: b.id, name: b.customerName || "", address: b.address || "",
      status: b.status || "confirmed", source: b.source || "lead", raw: b.scheduledFor || null
    };
    if (["cancelled", "completed", "no_show"].includes(b.status)) {
      row.onDay = false;
      row.verdict = `this booking is ${b.status.replace("_", "-")} — kept off the day sheet on purpose.`;
    } else {
      Object.assign(row, dayVerdict("this booking", b.scheduledFor, dateKey));
    }
    out.bookings.push(row);
  }

  for (const wo of workOrders) {
    if (!wo) continue;
    const own = matchesQuery(q, wo.customerName, wo.address, wo.customerEmail);
    if (!hits(wo, own)) continue;
    const row = {
      id: wo.id, name: wo.customerName || "", address: wo.address || "",
      status: wo.status || "scheduled", type: wo.type || "", raw: wo.scheduledFor || null
    };
    if (["cancelled", "no_show"].includes(wo.status)) {
      row.onDay = false;
      row.verdict = `this work order is ${wo.status.replace("_", "-")} — kept off the day sheet on purpose.`;
    } else {
      Object.assign(row, dayVerdict("this work order", wo.scheduledFor, dateKey));
      if (!wo.scheduledFor) {
        row.verdict += " Open the work order and set its scheduled date — it will appear within a minute.";
      }
    }
    out.workOrders.push(row);
  }

  // Season-plan stops: planned is NOT booked. A stop that never became a
  // booking (skipped at assign — no zone count, not eligible, and so on)
  // has no date-bearing record anywhere above, and THAT is the answer.
  const bookedPropDays = new Set(bookings
    .filter((b) => b && b.propertyId && !["cancelled"].includes(b.status) && b.scheduledFor)
    .map((b) => `${b.propertyId}|${localDayKey(parseStored(b.scheduledFor).when)}`));
  const codeToProp = new Map(properties.filter((p) => p && p.code).map((p) => [p.code, p]));
  for (const { season, year, plan } of plans) {
    const days = plan?.days || {};
    for (const [date, day] of Object.entries(days)) {
      for (const bucket of ["morning", "afternoon"]) {
        for (const code of day?.[bucket] || []) {
          const p = codeToProp.get(code);
          const own = matchesQuery(q, code) || (p && matchesQuery(q, p.customerName, p.address, p.town));
          if (!own && !(p && propIds.has(p.id))) continue;
          const booked = p && bookedPropDays.has(`${p.id}|${date}`);
          out.planStops.push({
            season, year, date, bucket, code,
            name: p?.customerName || "", address: p?.address || "",
            booked: Boolean(booked),
            verdict: booked
              ? `planned ${date} (${bucket}) and booked — the booking above is the record that shows.`
              : `planned ${date} (${bucket}) but NEVER BOOKED — a plan stop alone shows on no schedule. `
                + "Run preflight on the Season Plan: it names why this stop was skipped (zone count, eligibility, contact)."
          });
        }
      }
    }
  }

  return out;
}

module.exports = { findJobs, parseStored, localDayKey };

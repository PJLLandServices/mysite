// The assignment writer — stage 0: preflight.
//
// Spec: docs/ASSIGNMENT_WRITER.md. Decisions A–G are locked there; this
// module implements them stage by stage and nothing beyond the stage it
// is in. Right now that is PREFLIGHT ONLY: a read-only answer to "if I
// assigned this plan today, who would be told and who would be skipped,
// and why?" Nothing here creates a booking, sends a message, mints a
// token, or writes a byte.
//
// THE VERDICTS ARE THE OUTREACH MODULE'S OWN. Eligibility comes from
// outreach.assessEligibility and channel capability from
// outreach.channelCapability — the same functions sendBulk itself runs.
// A preflight with its own copy of the rules is a preflight that drifts
// from the send it claims to predict, and its whole value is that it
// cannot.
//
// One verdict is assignment-specific: "already_booked" here is not a
// problem to fix. A customer with a real seasonal booking made their own
// appointment; the assignment writer's job for them is already done, so
// the preflight reports them as settled rather than skipped-with-a-frown.
//
// Collaborators are injectable (deps) the way resequence.js takes travel
// functions: tests hand in fixtures and never touch a data file; the
// endpoint wires the real modules.

const crypto = require("node:crypto");
const seasonPlans = require("./season-plans");
const properties = require("./properties");
const outreach = require("./outreach");
const bookings = require("./bookings");
const customers = require("./customers");
const resequence = require("./resequence");
const { deriveSeasonalKey, effectiveZoneCount } = require("./pricing");
const { BOOKABLE_SERVICES, BOOKING_BUCKETS } = require("./availability");

const BUCKETS = ["morning", "afternoon"];

// Reasons a stop can preflight to. Kept as a list so the screen and the
// tests enumerate the same universe — an unknown reason string reaching
// the UI would render as raw snake_case.
const PREFLIGHT_OUTCOMES = Object.freeze({
  ready: "Would be sent the assignment.",
  settled: "Already has their own booking this season — nothing to send.",
  no_such_property: "The plan references a property code that no longer exists.",
  inactive: "Property is archived or deleted.",
  not_eligible: "Not eligible for this season's service.",
  missing_name: "No customer name on the property — outreach refuses nameless sends.",
  season_opt_out: "Opted out of this season's outreach.",
  no_zone_count: "No zone count on the property — assign would refuse this stop. Open the property and fill it in.",
  no_property_id: "Corrupted property record — no id to build a portal link from.",
  no_contact: "No phone and no email that can be used.",
  no_phone: "No usable phone (email would still deliver).",
  no_email: "No usable email (SMS would still deliver).",
  opted_out_sms: "SMS declined (email would still deliver).",
  opted_out_email: "Email declined (SMS would still deliver)."
});

async function preflight(season, year, deps = {}) {
  const getPlan = deps.getPlan || seasonPlans.getPlan;
  const listProperties = deps.listProperties || properties.list;
  const assess = deps.assessEligibility || outreach.assessEligibility;
  const capability = deps.channelCapability || outreach.channelCapability;

  const plan = await getPlan(season, year);
  if (!plan || !plan.days || !Object.keys(plan.days).length) {
    return { ok: false, reason: "no_plan" };
  }

  const all = await listProperties();
  const byCode = new Map((all || []).filter((p) => p && p.code).map((p) => [p.code, p]));

  const days = [];
  const summary = { stops: 0, ready: 0, readyPartial: 0, settled: 0, skipped: 0, byReason: {} };
  const count = (reason) => { summary.byReason[reason] = (summary.byReason[reason] || 0) + 1; };

  for (const date of Object.keys(plan.days).sort()) {
    const day = plan.days[date];
    const rows = [];

    for (const bucket of BUCKETS) {
      for (const code of day[bucket] || []) {
        summary.stops += 1;
        const property = byCode.get(code) || null;
        const row = {
          code,
          date,
          bucket,
          label: day.label || null,
          propertyId: property?.id || null,
          customerName: property?.customerName || "",
          address: property?.address || "",
          town: property?.town || ""
        };

        if (!property) {
          row.outcome = "skipped";
          row.reason = "no_such_property";
          summary.skipped += 1;
          count(row.reason);
          rows.push(row);
          continue;
        }

        const verdict = await assess(property, { season, year });
        if (!verdict.ok) {
          if (verdict.reason === "already_booked") {
            // Their own booking stands; the writer has nothing to do.
            row.outcome = "settled";
            row.bookingId = verdict.bookingId || null;
            summary.settled += 1;
          } else {
            row.outcome = "skipped";
            row.reason = verdict.reason;
            summary.skipped += 1;
            count(verdict.reason);
          }
          rows.push(row);
          continue;
        }

        // Decision D's blind spot, closed on Patrick's ask ("what
        // properties are on this no_zone_count??"): assign() refuses a
        // stop without a zone count, so the preflight must say WHICH
        // stops those are — a "ready" here that assign() would then
        // skip breaks stage 0's promise. assign() keeps its own check
        // (a count could vanish between the two reads); this one is
        // the fix-it list.
        if (!zoneCountFor(property)) {
          row.outcome = "skipped";
          row.reason = "no_zone_count";
          summary.skipped += 1;
          count(row.reason);
          rows.push(row);
          continue;
        }

        const cap = capability(property);
        const channels = [];
        if (cap.sms.possible) channels.push("sms");
        if (cap.emailChannel.possible) channels.push("email");

        if (!channels.length) {
          // Eligible but unreachable. The single-channel reason is more
          // actionable than a generic label, so it is kept when there is
          // exactly one; two dead channels collapse to no_contact, the
          // same rule sendBulk applies.
          const reasons = [cap.sms.reason, cap.emailChannel.reason].filter(Boolean);
          row.outcome = "skipped";
          row.reason = reasons.length === 1 ? reasons[0] : "no_contact";
          row.channelReasons = { sms: cap.sms.reason, email: cap.emailChannel.reason };
          summary.skipped += 1;
          count(row.reason);
          rows.push(row);
          continue;
        }

        row.outcome = "ready";
        row.channels = channels;
        summary.ready += 1;
        if (channels.length === 1) {
          // Deliverable, but on one leg. Said per-row so a "61 ready"
          // headline cannot hide fifteen people who will never get the
          // text half of the cadence.
          row.partial = cap.sms.possible ? cap.emailChannel.reason : cap.sms.reason;
          summary.readyPartial += 1;
        }
        rows.push(row);
      }
    }

    days.push({ date, label: day.label || null, territory: day.territory || null, stops: rows });
  }

  return { ok: true, generatedAt: new Date().toISOString(), season, year: Number(year), days, summary };
}

// ---- Stage 2: the assignment record -----------------------------------
//
// assign() turns the plan's stops into real, confirmed bookings —
// `source: "assignment"`, propertyId-linked, NO lead behind them (the
// property-first path activeBookings() and the iCal feed were prepared
// for). It SENDS NOTHING: this module never touches a notify or outreach
// send path; messaging is stage 4's job and no message may exist before
// touches carry a `type`.
//
// THE VERDICTS ARE STILL THE PREFLIGHT'S. assign() runs preflight()
// first with the same collaborators and only creates bookings for rows
// the preflight called "ready" — so the screen Patrick reviewed before
// pressing the button is, by construction, what the button does.
//
// IDEMPOTENT BY THE SAME RULES. A created booking makes
// deriveBookingState report the property as booked, so the next run's
// preflight calls it "settled" and assign() creates nothing for it.
// Running assign twice is one assignment.
//
// SCHEDULING SHAPE, decided here and recorded in the build log:
//   scheduledFor    = the stop's SEQUENCED ARRIVAL from the route
//                     (resequence.sequenceDay's timeline), clamped inside
//                     its bucket, falling back to the bucket's open when
//                     the day can't be sequenced. Patrick's calendar and
//                     iCal then mirror the route — five stops at 8:00 in
//                     a pile taught us bucket-open times were wrong for
//                     every admin surface. The customer still only ever
//                     sees the bucket label. Because sequencing moves
//                     when Patrick reorders a day, syncAssignedTimes()
//                     re-anchors pristine records after order-affecting
//                     plan edits (and at the end of every assign run).
//   durationMinutes = the SERVICE minutes for the tier, not the bucket
//                     length. A full-bucket span would physically close
//                     the bucket to everyone; service-length records
//                     leave a below-cap bucket open to new customers,
//                     which is what the geography filter + capacity gate
//                     exist to allow. The stage-1 pointKey dedup keeps
//                     these records from double-counting against their
//                     own planned stops.

const ASSIGN_OUTCOMES = Object.freeze({
  created: "Booked — a confirmed appointment now exists.",
  no_zone_count: "No zone count on the property — the service tier can't be derived. Fill it in and re-run.",
  no_service_tier: "The zone count doesn't resolve to a bookable tier.",
  duplicate_in_plan: "This property appears earlier in the plan — booked once, skipped here.",
  assignment_declined: "Their assigned appointment was cancelled — not re-booking someone who said no. Book by hand if they've changed their mind.",
  previously_assigned: "An assignment booking already exists for this property this season.",
  create_failed: "The booking could not be written — see the server log."
});

function hhmmToMinutes(text) {
  const [h, m] = String(text || "").split(":").map(Number);
  return (Number.isFinite(h) ? h * 60 : 0) + (Number.isFinite(m) ? m : 0);
}

// Where a stop's booking record sits in its day. The sequenced arrival
// wins; no arrival (unroutable stop, sequencing failed) falls back to
// the bucket's open. Bucket boundaries come from the availability
// engine's own table so the two can't disagree on when a morning starts.
//
// CLAMPED INSIDE THE BUCKET on purpose: a morning that overruns can
// sequence a stop past noon, and a record stored at 12:10 would count
// against the AFTERNOON's capacity in the stage-1 gate (bucket
// attribution reads the stored time). The plan screen still shows the
// true overrun; the record stays a morning record.
function scheduledStartFor(dateKey, bucketKey, arriveAt, serviceMinutes) {
  const bucket = BOOKING_BUCKETS.find((b) => b.key === bucketKey);
  const fromMin = hhmmToMinutes(bucket?.from || "08:00");
  const toMin = hhmmToMinutes(bucket?.to || "17:00");
  const latestStart = Math.max(fromMin, toMin - Math.max(1, Number(serviceMinutes) || 30));
  let startMin = arriveAt ? hhmmToMinutes(arriveAt) : fromMin;
  startMin = Math.min(Math.max(startMin, fromMin), latestStart);
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
}

// The customers' own "after X / before Y" asks, keyed by plan code —
// the requestedWindows seam's food. Built from live assignment bookings
// so the sequencer honours what customers set on their appointment
// pages, and the customer's ask wins over the plan's standing guess
// (the seam's own documented rule).
async function requestedWindowsFor(season, year, listBookings = bookings.list) {
  const out = {};
  try {
    for (const b of await listBookings()) {
      if (!b || b.source !== "assignment" || !b.assignment) continue;
      if (b.assignment.season !== season || Number(b.assignment.year) !== Number(year)) continue;
      if (b.status !== "confirmed") continue;
      const w = b.requestedWindow;
      if (w && (w.notBefore || w.notAfter)) {
        out[b.assignment.code] = { notBefore: w.notBefore || null, notAfter: w.notAfter || null };
      }
    }
  } catch (err) {
    console.warn("[assignments] requested windows unavailable:", err?.message);
  }
  return out;
}

// The sequenced arrival time for every stop of one plan day, as a
// Map code -> "HH:MM". Fails soft to an empty map: a day that cannot be
// sequenced books at bucket opens rather than not at all.
async function arrivalsFor(day, byCode, season, seq, requestedWindows = {}) {
  const etaByCode = new Map();
  try {
    const sequenced = await seq(day, { propertiesByCode: byCode, season, requestedWindows });
    for (const t of sequenced.timeline || []) etaByCode.set(t.propertyCode, t.arriveAt);
  } catch (err) {
    console.warn("[assignments] sequencing unavailable — bucket-open times used:", err?.message);
  }
  return etaByCode;
}

// Effective zone count: documented zones win over the declared count —
// the shared rule now lives in pricing.effectiveZoneCount so booking
// tier, shown price, and sequenced minutes all read the same number.
function zoneCountFor(property) {
  return effectiveZoneCount(property);
}

async function assign(season, year, deps = {}) {
  const listProperties = deps.listProperties || properties.list;
  const listBookings = deps.listBookings || bookings.list;
  const createBooking = deps.createBooking || bookings.createDirect;
  const getCustomer = deps.getCustomer
    || ((id) => customers.get(id, { withProperties: false }));
  const actor = deps.actor || "admin";

  const getPlan = deps.getPlan || seasonPlans.getPlan;
  const seq = deps.sequenceDay || resequence.sequenceDay;

  const flight = await preflight(season, year, deps);
  if (!flight.ok) return flight;

  const plan = await getPlan(season, year);
  const all = await listProperties();
  const byCode = new Map((all || []).filter((p) => p && p.code).map((p) => [p.code, p]));

  // A property that EVER had an assignment booking this season is never
  // auto-booked again, whatever became of that booking. The eligibility
  // gauntlet can't carry this rule: deriveBookingState rightly reads a
  // cancelled booking as "unbooked" (outreach should nudge them to book),
  // but for the writer a cancelled ASSIGNMENT is a customer's explicit
  // no, and re-running assign must not overrule it. Once ever, like the
  // cadence steps.
  const priorAssignment = new Map();
  for (const b of await listBookings()) {
    if (!b || b.source !== "assignment" || !b.assignment) continue;
    if (b.assignment.season !== season || Number(b.assignment.year) !== Number(year)) continue;
    if (b.propertyId && !priorAssignment.has(b.propertyId)) priorAssignment.set(b.propertyId, b);
  }

  const batchId = deps.batchId || `AS-${crypto.randomUUID().slice(0, 8)}`;
  const assignedAt = new Date().toISOString();
  const woType = season === "spring" ? "spring_opening" : "fall_closing";

  const days = [];
  const summary = { stops: 0, created: 0, settled: 0, skipped: 0, byReason: {} };
  const count = (reason) => { summary.byReason[reason] = (summary.byReason[reason] || 0) + 1; };
  const assignedPropertyIds = new Set();

  const customerWindows = await requestedWindowsFor(season, year, listBookings);
  for (const flightDay of flight.days) {
    const rows = [];
    const etaByCode = await arrivalsFor(plan.days[flightDay.date] || {}, byCode, season, seq, customerWindows);
    for (const verdict of flightDay.stops) {
      summary.stops += 1;
      const row = { ...verdict };

      if (verdict.outcome === "settled") {
        summary.settled += 1;
        rows.push(row);
        continue;
      }
      if (verdict.outcome !== "ready") {
        summary.skipped += 1;
        count(verdict.reason);
        rows.push(row);
        continue;
      }

      const property = byCode.get(verdict.code);
      const skip = (reason) => {
        row.outcome = "skipped";
        row.reason = reason;
        summary.skipped += 1;
        count(reason);
        rows.push(row);
      };

      // The preflight proved the property existed, but assign lists
      // properties again — a record deleted between the two reads must
      // skip, not crash the run halfway through writing bookings.
      if (!property) { skip("no_such_property"); continue; }

      // A property planned on two days would otherwise book twice —
      // the preflight computed every verdict before the first booking
      // existed, so the settled guard can't catch the second occurrence
      // within this run.
      if (assignedPropertyIds.has(property.id)) { skip("duplicate_in_plan"); continue; }

      const prior = priorAssignment.get(property.id);
      if (prior) {
        skip(prior.status === "cancelled" ? "assignment_declined" : "previously_assigned");
        continue;
      }

      const zoneCount = zoneCountFor(property);
      if (!zoneCount) { skip("no_zone_count"); continue; }

      // accountType decides the tier table — same resolution as the
      // outreach handoff's begin-booking path.
      let commercial = false;
      if (property.customerId) {
        try {
          const owner = await getCustomer(property.customerId);
          commercial = owner?.accountType === "commercial";
        } catch { /* unresolvable customer — residential, like every other caller */ }
      }
      const serviceKey = deriveSeasonalKey(woType, zoneCount, commercial);
      const service = serviceKey ? BOOKABLE_SERVICES[serviceKey] : null;
      if (!service) { skip("no_service_tier"); continue; }

      try {
        const booking = await createBooking({
          customerId: property.customerId || null,
          customerName: property.customerName || "",
          customerPhone: property.customerPhone || "",
          customerEmail: property.customerEmail || "",
          propertyId: property.id,
          address: property.address || "",
          zoneCount,
          serviceKey,
          serviceLabel: service.label,
          scheduledFor: scheduledStartFor(
            verdict.date, verdict.bucket, etaByCode.get(verdict.code), service.minutes
          ).toISOString(),
          durationMinutes: service.minutes,
          status: "confirmed",
          source: "assignment",
          assignment: {
            season, year: Number(year), batchId, assignedAt,
            date: verdict.date, bucket: verdict.bucket,
            code: verdict.code, planLabel: verdict.label || null
          }
        }, { by: actor, note: `Season assignment ${season} ${year} (${batchId})` });
        assignedPropertyIds.add(property.id);
        row.outcome = "created";
        row.bookingId = booking.id;
        row.serviceKey = serviceKey;
        summary.created += 1;
      } catch (err) {
        console.error(`[assignments] create failed for ${verdict.code} on ${verdict.date}:`, err?.message);
        skip("create_failed");
        continue;
      }
      rows.push(row);
    }
    days.push({ ...flightDay, stops: rows });
  }

  // Records from EARLIER runs re-anchor to today's sequencing. This is
  // what lets "press Assign again" repair times after a plan edit — the
  // run creates nothing for settled stops but still trues them up.
  let timesSynced = 0;
  try {
    const sync = await syncAssignedTimes(season, year, deps);
    timesSynced = sync.updated;
  } catch (err) {
    console.warn("[assignments] time sync after assign failed:", err?.message);
  }

  return { ok: true, batchId, assignedAt, season, year: Number(year), days, summary, timesSynced };
}

// Re-anchor pristine assignment bookings to the plan's CURRENT sequenced
// arrivals. Runs after order-affecting plan edits (reorder, back-to-
// automatic, time windows) and at the end of every assign — the plan
// screen is the timeline of record, and a stored time that drifts from
// it puts two different days in front of Patrick.
//
// PRISTINE ONLY: status confirmed, never rescheduled, no work order. A
// record a human or customer moved is theirs now; the plan stops
// steering it. A record whose assignment.date is no longer in the plan
// is left where it is too — day moves are stage 6's business.
async function syncAssignedTimes(season, year, deps = {}) {
  const getPlan = deps.getPlan || seasonPlans.getPlan;
  const listProperties = deps.listProperties || properties.list;
  const listBookings = deps.listBookings || bookings.list;
  const updateBooking = deps.updateBooking || bookings.update;
  const seq = deps.sequenceDay || resequence.sequenceDay;

  const plan = await getPlan(season, year);
  if (!plan || !plan.days) return { ok: true, checked: 0, updated: 0 };

  const mine = (await listBookings()).filter((b) =>
    b && b.source === "assignment"
    && b.assignment && b.assignment.season === season
    && Number(b.assignment.year) === Number(year)
    && b.status === "confirmed"
    && (Number(b.rescheduleCount) || 0) === 0
    && !(Array.isArray(b.workOrderIds) && b.workOrderIds.length)
    && plan.days[b.assignment.date]);
  if (!mine.length) return { ok: true, checked: 0, updated: 0 };

  const all = await listProperties();
  const byCode = new Map((all || []).filter((p) => p && p.code).map((p) => [p.code, p]));

  const byDate = new Map();
  for (const b of mine) {
    if (!byDate.has(b.assignment.date)) byDate.set(b.assignment.date, []);
    byDate.get(b.assignment.date).push(b);
  }

  let checked = 0;
  let updated = 0;
  const customerWindows = await requestedWindowsFor(season, year, listBookings);
  for (const [date, records] of byDate) {
    const etaByCode = await arrivalsFor(plan.days[date], byCode, season, seq, customerWindows);
    for (const b of records) {
      checked += 1;
      const want = scheduledStartFor(
        date, b.assignment.bucket, etaByCode.get(b.assignment.code), b.durationMinutes
      ).toISOString();
      if (b.scheduledFor === want) continue;
      await updateBooking(b.id, { scheduledFor: want });
      updated += 1;
    }
  }
  return { ok: true, checked, updated };
}

// Reverse an assignment: remove the bookings assign() created for this
// season+year that nobody has touched since. "Touched" — rescheduled,
// cancelled, completed, or grown a work order — means a human or a
// customer acted on the record, and unassign leaves those alone and says
// so. A clean unassign returns the world to the moment before assign:
// the same stops preflight as "ready" again.
async function unassign(season, year, deps = {}) {
  const listBookings = deps.listBookings || bookings.list;
  const removeBooking = deps.removeBooking || bookings.remove;
  const actor = deps.actor || "admin";

  const mine = (await listBookings()).filter((b) =>
    b && b.source === "assignment"
    && b.assignment && b.assignment.season === season
    && Number(b.assignment.year) === Number(year));

  const summary = { found: mine.length, removed: 0, kept: 0, byReason: {} };
  const kept = [];
  const removed = [];
  for (const b of mine) {
    let reason = null;
    if (b.status !== "confirmed") reason = `status_${b.status}`;
    else if ((Number(b.rescheduleCount) || 0) > 0) reason = "rescheduled";
    else if (Array.isArray(b.workOrderIds) && b.workOrderIds.length) reason = "has_work_order";
    if (reason) {
      summary.kept += 1;
      summary.byReason[reason] = (summary.byReason[reason] || 0) + 1;
      kept.push({ bookingId: b.id, code: b.assignment.code, date: b.assignment.date, reason });
      continue;
    }
    const result = await removeBooking(b.id, { by: actor });
    if (result && result.ok) {
      summary.removed += 1;
      removed.push({ bookingId: b.id, code: b.assignment.code, date: b.assignment.date });
    } else {
      summary.kept += 1;
      summary.byReason.remove_refused = (summary.byReason.remove_refused || 0) + 1;
      kept.push({ bookingId: b.id, code: b.assignment.code, date: b.assignment.date, reason: "remove_refused" });
    }
  }

  return { ok: true, season, year: Number(year), summary, removed, kept };
}

// Stage 6: when Patrick moves a whole route day, its assignment
// bookings ride along. Called AFTER seasonPlans.moveDay succeeds (the
// plan already shows the day on its new date). Per cadence rule 6:
// response state resets — except FREE-BUCKET customers, who said "any
// day works" and keep both their answer and their silence (no notice:
// the tech calls them with an ETA regardless). A booking the customer
// moved off the day themselves is theirs and is not touched. Notices
// queue only for customers who were actually messaged (blasted) — a
// pre-blast move breaks no promise.
async function moveDayBookings(season, year, { from, to }, deps = {}) {
  const getPlan = deps.getPlan || seasonPlans.getPlan;
  const listProperties = deps.listProperties || properties.list;
  const listBookings = deps.listBookings || bookings.list;
  const moveBooking = deps.moveAssignmentDay || bookings.moveAssignmentDay;
  const seq = deps.sequenceDay || resequence.sequenceDay;
  const actor = deps.actor || "admin";

  const plan = await getPlan(season, year);
  const day = plan?.days?.[to];
  if (!day) return { ok: false, errors: [`${to} is not a route day in this plan.`] };

  const all = await listProperties();
  const byCode = new Map((all || []).filter((p) => p && p.code).map((p) => [p.code, p]));
  const customerWindows = await requestedWindowsFor(season, year, listBookings);
  const etaByCode = await arrivalsFor(day, byCode, season, seq, customerWindows);

  const localDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const affected = (await listBookings()).filter((b) =>
    b && b.source === "assignment" && b.assignment
    && b.assignment.season === season && Number(b.assignment.year) === Number(year)
    && b.status === "confirmed"
    && b.assignment.date === from
    && localDate(b.scheduledFor) === from);

  const summary = { moved: 0, noticesQueued: 0, responsesReset: 0, flexibleMoved: 0 };
  for (const b of affected) {
    const flexible = Boolean(b.flexBucket);
    const blasted = Boolean(b.assignment.outreach?.steps?.["1"]);
    const hadResponse = Boolean(b.assignment.outreach?.respondedAt);
    await moveBooking(b.id, {
      toDate: to,
      scheduledFor: scheduledStartFor(to, b.assignment.bucket, etaByCode.get(b.assignment.code), b.durationMinutes).toISOString(),
      oldDate: from,
      resetResponse: !flexible,
      queueNotice: blasted && !flexible,
      by: actor
    });
    summary.moved += 1;
    if (flexible) summary.flexibleMoved += 1;
    else {
      if (blasted) summary.noticesQueued += 1;
      if (hadResponse) summary.responsesReset += 1;
    }
  }
  return { ok: true, from, to, ...summary };
}

module.exports = { preflight, assign, unassign, syncAssignedTimes, requestedWindowsFor, moveDayBookings, PREFLIGHT_OUTCOMES, ASSIGN_OUTCOMES };

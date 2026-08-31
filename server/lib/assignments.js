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
const { deriveSeasonalKey } = require("./pricing");
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
//   scheduledFor    = the bucket's opening time (08:00 / 12:00 local).
//                     The plan screen stays the timeline of record; the
//                     customer only ever sees the bucket label.
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

// Bucket opening times and lengths come from the availability engine's
// own table so the two can't disagree on when a morning starts.
function bucketStartFor(dateKey, bucketKey) {
  const bucket = BOOKING_BUCKETS.find((b) => b.key === bucketKey);
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = String(bucket?.from || "08:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

// Effective zone count: documented zones win over the manual count —
// the same precedence the property record documents.
function zoneCountFor(property) {
  const documented = Array.isArray(property?.system?.zones) ? property.system.zones.length : 0;
  if (documented > 0) return documented;
  const manual = Number(property?.system?.zoneCount);
  return Number.isFinite(manual) && manual > 0 ? manual : 0;
}

async function assign(season, year, deps = {}) {
  const listProperties = deps.listProperties || properties.list;
  const listBookings = deps.listBookings || bookings.list;
  const createBooking = deps.createBooking || bookings.createDirect;
  const getCustomer = deps.getCustomer
    || ((id) => customers.get(id, { withProperties: false }));
  const actor = deps.actor || "admin";

  const flight = await preflight(season, year, deps);
  if (!flight.ok) return flight;

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

  for (const flightDay of flight.days) {
    const rows = [];
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
          scheduledFor: bucketStartFor(verdict.date, verdict.bucket).toISOString(),
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

  return { ok: true, batchId, assignedAt, season, year: Number(year), days, summary };
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

module.exports = { preflight, assign, unassign, PREFLIGHT_OUTCOMES, ASSIGN_OUTCOMES };

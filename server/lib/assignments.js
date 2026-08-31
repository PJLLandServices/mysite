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

const seasonPlans = require("./season-plans");
const properties = require("./properties");
const outreach = require("./outreach");

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

module.exports = { preflight, PREFLIGHT_OUTCOMES };

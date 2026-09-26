// server/lib/session-hours.js
//
// ONE calculation of person-hours, for every reader.
//
// Hours are money on a T&M job. Before this module there were three
// copies of the same loop — computeProjectMetrics(), computeTAndMBilling()
// and the classic project page's browser-side day list — each re-deriving
// (out − in) × labourers from raw session fields. Three copies of a
// money calculation is three chances to drift, and the one that drifts
// silently is the one that bills.
//
// So: the loop lives here, once. Callers pass how they want OPEN
// sessions (a technician still clocked in) treated, because that is the
// only legitimate difference between them:
//
//   openSessions: "toNow"  — metrics. A running session counts up to
//                            right now, so "hours so far today" moves.
//   openSessions: "skip"   — billing. You cannot invoice a session that
//                            has not ended.
//
// That difference is deliberate and is the reason this takes an option
// instead of being one number. Everything else — the labourer multiplier,
// the validity checks, the rounding — is identical for both, and is now
// impossible to get differently right.
//
// ---- Corrected sessions --------------------------------------------
//
// Patrick's rule for office corrections: "Preserve the original value.
// Record the corrected value, who changed it, when and why. Calculate
// billing from the effective corrected value. Never represent an office
// correction as a new field work session."
//
// The storage shape that follows from it:
//
//   session.inAt / outAt / labourersOnSite   ← ALWAYS the EFFECTIVE value
//   session.original = { inAt, outAt, labourersOnSite }  ← set once, on
//                                              the first correction
//   session.corrections = [ { at, by, reason, field, from, to } ]
//
// The live fields carry the effective value rather than the original on
// purpose. The alternative — freeze the live field as the original and
// route every reader through a function — reads more elegantly and fails
// silently: any reader you miss quietly bills the uncorrected number and
// nothing looks wrong. This way a missed reader shows the CORRECT figure
// and only loses the audit detail. When one shape fails loudly and the
// other fails silently, and the subject is hours you invoice, take the
// one that fails loudly.
//
// Pure module: no I/O, no clock beyond `now`, so it is testable directly.

const MS_PER_HOUR = 3600000;

// A single on-site session longer than this is a typo, not a day's work
// — most often a year or month wrong in a hand-typed correction, which
// would otherwise bill thousands of hours. Corrections are refused above
// it (see work-orders.correctSessionTimes); readers here just ignore it
// so a bad record already on disk cannot inflate an invoice.
const MAX_SESSION_HOURS = 24;

function roundHours(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// The labourer multiplier. One person on site is the floor — a session
// that exists was worked by somebody, so a missing or junk count means
// one, never zero.
function effectiveLabourers(session) {
  const n = Math.floor(Number(session && session.labourersOnSite) || 1);
  return n >= 1 ? n : 1;
}

function wasCorrected(session) {
  return Boolean(session && Array.isArray(session.corrections) && session.corrections.length > 0);
}

// What the field originally recorded, before any office correction.
// Never derived from corrections[] — stored once, explicitly — so the
// answer does not depend on replaying a log correctly.
function sessionOriginal(session) {
  if (!session) return { inAt: null, outAt: null, labourersOnSite: 1 };
  if (session.original) {
    return {
      inAt: session.original.inAt ?? null,
      outAt: session.original.outAt ?? null,
      labourersOnSite: Math.max(1, Math.floor(Number(session.original.labourersOnSite) || 1))
    };
  }
  // Never corrected: the live values ARE the original.
  return {
    inAt: session.inAt ?? null,
    outAt: session.outAt ?? null,
    labourersOnSite: effectiveLabourers(session)
  };
}

// Person-hours for one session, from its EFFECTIVE values.
// Returns 0 rather than throwing for anything unusable — an open session
// under "skip", a missing clock-in, a reversed pair, an unparseable
// timestamp. A malformed record must not take down a metrics call, and
// counting it as zero is the only safe direction on an invoice.
function sessionPersonHours(session, { openSessions = "skip", now = null } = {}) {
  if (!session || !session.inAt) return 0;
  let outAt = session.outAt;
  if (!outAt) {
    if (openSessions !== "toNow") return 0;
    outAt = now || new Date().toISOString();
  }
  const ms = new Date(outAt) - new Date(session.inAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const hours = ms / MS_PER_HOUR;
  if (hours > MAX_SESSION_HOURS) return 0;
  return hours * effectiveLabourers(session);
}

function sessionsOf(workOrder) {
  const sessions = workOrder && workOrder.dailyLog && workOrder.dailyLog.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

// Total person-hours across a set of work orders. THE number that both
// the project metrics and the T&M invoice are built from.
function sumPersonHours(workOrders, { openSessions = "skip", now = null } = {}) {
  const stamp = now || new Date().toISOString();
  let total = 0;
  for (const wo of workOrders || []) {
    for (const s of sessionsOf(wo)) {
      total += sessionPersonHours(s, { openSessions, now: stamp });
    }
  }
  return roundHours(total);
}

module.exports = {
  MS_PER_HOUR,
  MAX_SESSION_HOURS,
  roundHours,
  effectiveLabourers,
  wasCorrected,
  sessionOriginal,
  sessionPersonHours,
  sessionsOf,
  sumPersonHours
};

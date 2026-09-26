// server/lib/daily-records.js
//
// ONE read model for the Daily Records screen.
//
// Patrick's standing rule, set after the Tasks release: "display
// server-calculated totals instead of independently recalculating them
// in React." This module is what makes that possible for the day list —
// every number the screen shows is computed here, so the page renders
// text rather than doing arithmetic on money.
//
// It also answers the question the screen has to answer honestly on
// every row: CAN this day be corrected, and if not, WHY not. That is a
// server judgement (it depends on the work order's signature state), so
// the server states it and the page repeats it. A page that greys out a
// button without saying why is how a person ends up believing the system
// is broken.
//
// Pure shaping over records the caller supplies — no I/O of its own, so
// it is testable directly and cannot surprise a caller with a read.

const sessionHours = require("./session-hours");

// Why a day's hours are frozen. `wo.locked` is set when the customer
// signs the work order off (or an admin records a signature bypass),
// which is also what produces its invoice — so "locked" means the
// figures behind a signed-off day, and correcting them behind the
// customer's signature is exactly the silent drift this whole release
// exists to stop. Reopening is a deliberate, separate, admin act
// (POST /api/work-orders/:id/unlock).
//
// Worded for the person reading the screen, not for a developer.
function correctionLock(wo) {
  if (!wo) return { canCorrect: false, reason: "This day's record could not be loaded." };
  if (wo.type !== "build") {
    return { canCorrect: false, reason: "Only build days carry clock times." };
  }
  if (wo.locked === true) {
    const signed = wo.signature && wo.signature.signed;
    return {
      canCorrect: false,
      reason: signed
        ? "This day is signed off by the customer, so its hours are final. Unlock the work order first if it genuinely needs correcting."
        : "This day is locked, so its hours are final. Unlock the work order first if it genuinely needs correcting.",
      lockedBySignature: Boolean(signed)
    };
  }
  return { canCorrect: true, reason: null };
}

function pair(inAt, outAt, labourersOnSite) {
  return {
    inAt: inAt ?? null,
    outAt: outAt ?? null,
    labourersOnSite: Math.max(1, Math.floor(Number(labourersOnSite) || 1))
  };
}

// One session, in both of its versions.
//
// `recorded` is what the crew logged; `effective` is what bills. They
// are the same object's values when nothing was ever corrected, and the
// screen says so rather than drawing a meaningless "was 3, now 3".
function describeSession(session, { now = null } = {}) {
  if (!session) return null;
  const effective = pair(session.inAt, session.outAt, session.labourersOnSite);
  const original = sessionHours.sessionOriginal(session);
  const recorded = pair(original.inAt, original.outAt, original.labourersOnSite);
  const corrections = Array.isArray(session.corrections) ? session.corrections : [];

  // The recorded figure is what the day WOULD have billed before anyone
  // touched it — the screen shows it struck through beside the effective
  // one, so the size of a correction is visible rather than implied.
  const asRecorded = { inAt: recorded.inAt, outAt: recorded.outAt, labourersOnSite: recorded.labourersOnSite };

  return {
    id: session.id,
    startedBy: session.startedBy || null,
    note: session.labourerNote || "",
    open: !session.outAt,
    corrected: corrections.length > 0,
    // Which fields actually moved — so the screen can mark the clock and
    // the crew count independently instead of flagging the whole row.
    correctedFields: [...new Set(corrections.map((c) => c.field))],
    recorded,
    effective,
    corrections: corrections.map((c) => ({
      at: c.at || null,
      by: c.by || null,
      reason: c.reason || "",
      field: c.field || null,
      from: c.from ?? null,
      to: c.to ?? null
    })),
    personHours: sessionHours.roundHours(
      sessionHours.sessionPersonHours(session, { openSessions: "toNow", now })
    ),
    recordedPersonHours: sessionHours.roundHours(
      sessionHours.sessionPersonHours(asRecorded, { openSessions: "toNow", now })
    )
  };
}

// One logged day.
function describeDay(wo, { now = null } = {}) {
  if (!wo) return null;
  const dl = wo.dailyLog || {};
  const sessions = (Array.isArray(dl.sessions) ? dl.sessions : [])
    .map((s) => describeSession(s, { now }))
    .filter(Boolean);
  const lock = correctionLock(wo);

  const personHours = sessionHours.roundHours(
    sessions.reduce((sum, s) => sum + s.personHours, 0)
  );
  const recordedPersonHours = sessionHours.roundHours(
    sessions.reduce((sum, s) => sum + s.recordedPersonHours, 0)
  );

  return {
    woId: wo.id,
    workDate: dl.workDate || null,
    locked: wo.locked === true,
    canCorrect: lock.canCorrect,
    lockReason: lock.reason,
    signedOff: Boolean(wo.signature && wo.signature.signed),
    sessions,
    personHours,
    recordedPersonHours,
    // True only when a correction actually moved the day's total, so the
    // screen shows the "was" line where it means something.
    hoursCorrected: personHours !== recordedPersonHours,
    anyCorrection: sessions.some((s) => s.corrected),
    openSession: sessions.some((s) => s.open),
    notes: dl.dailyNotes || "",
    tasksDoneToday: Array.isArray(dl.tasksCompletedToday) ? dl.tasksCompletedToday.length : 0,
    materialsUsed: Array.isArray(dl.materialsConsumed) ? dl.materialsConsumed.length : 0,
    photoCount: Array.isArray(wo.photos) ? wo.photos.length : 0
  };
}

// The whole job, newest day first — the order the office reads in.
function describeProject(buildWos, { now = null } = {}) {
  const stamp = now || new Date().toISOString();
  const days = (buildWos || [])
    .map((wo) => describeDay(wo, { now: stamp }))
    .filter(Boolean)
    .sort((a, b) => String(b.workDate || "").localeCompare(String(a.workDate || "")));

  return {
    days,
    // The job's totals come from the SAME shared calculation the project
    // metrics and the T&M invoice use — not from summing the rows above,
    // which would be a fourth copy of the arithmetic this release exists
    // to collapse.
    totalPersonHours: sessionHours.sumPersonHours(buildWos || [], { openSessions: "toNow", now: stamp }),
    daysLogged: days.length,
    correctedDays: days.filter((d) => d.anyCorrection).length
  };
}

module.exports = { correctionLock, describeSession, describeDay, describeProject };

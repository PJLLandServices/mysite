// server/lib/project-problems.js
//
// A PROBLEM belongs to the PROJECT and links to the daily record it was
// discovered on. Patrick settled that shape:
//
//   "Daily Records shows: 'This problem was discovered Tuesday during
//    this work session.' Project Overview shows: 'This problem remains
//    open and still needs resolution.' Resolving it later doesn't
//    rewrite Tuesday's record."
//
// Two things were being conflated and are now separate: the PROBLEM is
// a live thing that stays open until somebody deals with it, and its
// DISCOVERY is a fact about Tuesday that never changes. One record, two
// contexts, and neither has to lie.
//
// ---- status is a LIFECYCLE STATE ----------------------------------
//
// CLAUDE.md: "A record's state is not done when the record flips. It is
// done when every reader agrees... Define the rule once, as a named
// function, and call it from each reader. Two copies of a state test
// will drift."
//
// The trap here is `monitoring`. It is not resolved — it is "we are
// watching it" — so anything counting outstanding problems must count
// it. Written as `status !== "resolved"` in one reader and
// `status === "open"` in another, the two disagree about every
// monitored problem, and the disagreement shows up as a closeout that
// lets a watched problem through. So there is exactly ONE test, below,
// and every reader calls it.
//
// That is the cancelled-booking lesson (2026-09-08,
// `bookingHoldsItsSlot`) and the archived-task lesson (#307,
// `activeTasks`) applied BEFORE the bug rather than after it.

const STATUSES = ["open", "monitoring", "resolved"];

// THE rule. "Does this still need somebody's attention?"
//
// Note what it does NOT say: it does not say `status === "open"`, and
// it does not say `!== "resolved"` in three places. It says it here,
// once, and a new status added later has exactly one line to update.
function problemNeedsAttention(problem) {
  if (!problem) return false;
  return problem.status !== "resolved";
}

function activeProblems(project) {
  return (project?.problems || []).filter(problemNeedsAttention);
}

function isStatus(value) {
  return STATUSES.includes(String(value || ""));
}

// A problem as the screens read it. `discovery` is deliberately its own
// object: it is the fact about Tuesday, and nothing in resolution may
// reach into it.
function describeProblem(problem) {
  if (!problem) return null;
  return {
    id: problem.id,
    title: problem.title || "",
    description: problem.description || "",
    status: isStatus(problem.status) ? problem.status : "open",
    needsAttention: problemNeedsAttention(problem),
    discovery: {
      at: problem.discoveredAt || null,
      onWoId: problem.discoveredOnWoId || null,
      workDate: problem.discoveredWorkDate || null,
      reportedBy: problem.reportedBy || null
    },
    resolution: problem.resolvedAt
      ? {
          at: problem.resolvedAt,
          by: problem.resolvedBy || null,
          note: problem.resolutionNote || ""
        }
      : null,
    links: {
      taskId: problem.taskId || null,
      photoRef: problem.photoRef || null,
      scopeChangeId: problem.scopeChangeId || null
    },
    history: Array.isArray(problem.history) ? problem.history : []
  };
}

// Everything discovered on one day, for the Daily Records tab's
// "discovered here" block. Keyed by work order, because that IS the day.
function problemsByWorkOrder(project) {
  const out = new Map();
  for (const p of project?.problems || []) {
    const key = p.discoveredOnWoId || "";
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(describeProblem(p));
  }
  return out;
}

module.exports = {
  STATUSES,
  problemNeedsAttention,
  activeProblems,
  isStatus,
  describeProblem,
  problemsByWorkOrder
};

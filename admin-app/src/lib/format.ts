import type { ProjectStatus } from "./api.ts";
import type { Tone } from "../ui/primitives.tsx";

export function money(n: number | null | undefined) {
  return "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function shortDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

export function relativeDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return shortDate(iso);
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: "Planning",
  active: "Active",
  complete: "Complete",
  archived: "Archived"
};

export const PROJECT_STATUS_TONES: Record<ProjectStatus, Tone> = {
  planning: "neutral",
  active: "progress",
  complete: "good",
  archived: "neutral"
};

export const BRANCH_LABELS: Record<string, string> = {
  gc_subcontract: "GC Subcontract",
  direct_residential: "Residential Install",
  lighting_design: "Lighting Design",
  renovation_coordination: "Renovation Coordination",
  change_order: "Change Order",
  residential_repair: "Residential Repair",
  lighting_repair: "Landscape Lighting Repairs"
};

/* "X of Y tasks" — a COUNT of finished tasks, and only that.
 *
 * Kept deliberately separate from the percentage below, for the same
 * reason the server keeps `doneTasks` next to `percentComplete`: the
 * label answers "how many are finished" and the bar answers "how far
 * along is this job", and on a job with partly-finished tasks those are
 * two different numbers. */
export function taskProgress(tasks: Array<{ status: string }> | undefined) {
  const list = tasks || [];
  const done = list.filter((t) => t.status === "done").length;
  return { done, total: list.length };
}

/* How far along a job is, 0–100, as the SERVER computes it.
 *
 * `computeProjectMetrics()` in server/lib/projects.js is the source of
 * truth, and its rule is: a task's completion is 100 when its status is
 * done, otherwise its own `percentComplete`, and the job's figure is the
 * AVERAGE of those. `percentComplete` is cumulative and `status` follows
 * it — `addTaskProgress()` sets status from the percentage, not the
 * other way round.
 *
 * This screen used to draw its bar from done/total, which reports a task
 * logged at 60% as ZERO. On a four-task job with every task at 75%, the
 * server said 75% complete and the bar sat empty. Same defect as
 * `zoneCount: areas.length`: a number the server already computes
 * properly, re-derived in the browser by a different rule, disagreeing
 * in silence.
 *
 * It is mirrored here rather than fetched because the list and the
 * dashboard already hold the task records, and one `/metrics` request
 * per project on a 40-job list is not a trade worth making.
 * `scripts/test-task-progress-agrees.mjs` runs the SERVER's function and
 * this one over the same fixtures and fails if they ever diverge. */
export function projectPercentComplete(
  tasks: Array<{ status: string; percentComplete?: number }> | undefined
): number {
  const list = tasks || [];
  if (!list.length) return 0;
  const pct = (t: { status: string; percentComplete?: number }) =>
    t.status === "done" ? 100 : Number(t.percentComplete) || 0;
  return Math.round(list.reduce((sum, t) => sum + pct(t), 0) / list.length);
}

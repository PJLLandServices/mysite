import type { ProjectStatus } from "./api";
import type { Tone } from "../ui/primitives";

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

export function taskProgress(tasks: Array<{ status: string }> | undefined) {
  const list = tasks || [];
  const done = list.filter((t) => t.status === "done").length;
  return { done, total: list.length };
}

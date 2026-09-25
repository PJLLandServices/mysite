/* The rebuilt interface is a new front end over the SAME backend. Every
   call here hits an endpoint that already exists and already works —
   no new routes, no changed payloads, no business logic moved into the
   browser. If a screen needs something the API doesn't return yet, the
   fix belongs in the server, not in a client-side recalculation. */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers }
  });

  // The CRM redirects to /login when a session lapses; a fetch follows
  // that redirect and hands us HTML. Treat it as the auth failure it is
  // rather than a JSON parse blow-up.
  if (res.redirected && new URL(res.url).pathname.startsWith("/login")) {
    throw new ApiError("Your session expired. Sign in again.", 401);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    const message = data?.errors?.[0] || `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" })
};

/* ── Shapes, as the existing endpoints actually return them ──────── */

export type ProjectStatus = "planning" | "active" | "complete" | "archived";

export interface ProjectSummary {
  id: string;
  name?: string;
  status: ProjectStatus;
  customerName?: string;
  customerId?: string | null;
  address?: string;
  description?: string;
  branch?: string | null;
  billingMode?: "fixed_price" | "time_and_material" | null;
  sourceQuoteId?: string | null;
  workOrderIds?: string[];
  /* `percentComplete` is the server's cumulative per-task figure, and
     `status` follows it. Reading status alone reports a task logged at
     60% as not started — see projectPercentComplete() in format.ts. */
  tasks?: Array<{ id: string; status: string; percentComplete?: number; archivedAt?: string | null }>;
  proposalSnapshot?: { quoteId?: string; version?: number; total?: number; acceptedAt?: string } | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface ProjectDetail extends ProjectSummary {
  customerEmail?: string;
  customerPhone?: string;
  propertyId?: string | null;
  notes?: string;
  journalEntries?: Array<{ id: string; ts: string; by?: string; note?: string; photos?: Array<{ n: number }> }>;
  systemDesign?: { areas?: unknown[] } | null;
  waterCostEstimate?: { totals?: { seasonCost?: number } } | null;
}

export interface LinkedQuote {
  id: string;
  version: number;
  status: string;
  total?: number;
  presentationMode?: string | null;
  confirmed?: boolean | null;
  lineItems?: Array<{ label: string; total: number }>;
  chain?: Array<{ id: string; version: number }>;
}

export interface InvoiceSummary {
  id: string;
  status: string;
  invoiceRole?: "standard" | "deposit" | "balance";
  total: number;
  amountPaid?: number;
  balanceDue?: number;
  paidAt?: string | null;
}

/* Three different counts, and they are not interchangeable.
 *
 *   stationCount  programmed outputs on the controller. What the proposal
 *                 raises a line for and what the controller is sized on.
 *   valveCount    physical valves — a box, a solenoid, a lateral run. Two
 *                 valves wired to one terminal are two valves, one station.
 *   areaCount     traced landscape areas. One area can make several valves;
 *                 grouped drip beds collapse several areas onto one.
 *
 * This used to be a single `zoneCount`, which the server filled with
 * `areas.length` — the area count under a name that belongs to neither of
 * the other two. */
export interface SiteBuilderSummary {
  stationCount: number;
  valveCount: number;
  areaCount: number;
  lastSavedAt?: string | null;
  /* The saved plan, station by station, exactly as the builder's own
   * master plan groups it — from the SAME engine pass on the server that
   * produced the three counts above (`describeSystemDesign`). Reading a
   * plan has to work on a phone; drawing one does not, this phase.
   *
   * `valves` is a count, not a repeat: a shared split station says 2, and
   * that is how the station list adds up to the valve total. */
  stations?: SiteBuilderStation[];
}

export interface SiteBuilderStation {
  /** 1-based — what the controller face says, not an array index. */
  station: number;
  name: string;
  family: string;
  valves: number;
  gpm: number;
  headCount: number;
  members: string[];
}

/* The builder, opened as this job's own full-screen route. A real page
 * navigation OUT of the SPA and back again, which is the point: leaving
 * a separate page is an unload, so the builder's existing unsaved-work
 * warning covers browser Back, refresh and closing the tab without
 * anything new being written. Returning is a fresh load, which is also
 * why the summary can never be stale after a save. */
export function systemBuilderHref(projectId: string): string {
  return `/app/projects/${encodeURIComponent(projectId)}/design/build`;
}

/* A task on a job. `percentComplete` leads and `status` follows it —
 * see projectPercentComplete() in format.ts. `completedByWoId` names the
 * VISIT that finished it, and is null when it was closed out from the
 * office, which is a real distinction and not a missing value. */
export interface ProjectTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  percentComplete?: number;
  notes?: string;
  order?: number;
  sourceLineItemId?: string | null;
  completedAt?: string | null;
  completedByWoId?: string | null;
  /* Set when the task was taken off the list but KEPT, because the crew's
     daily logs or photos point at its id. It stops counting everywhere;
     nothing that references it is left dangling. */
  archivedAt?: string | null;
  archivedBy?: string | null;
  archivedReason?: string | null;
}

/* What the server computes about a job. Displayed, never recomputed —
 * `percentComplete` here is the figure, and a screen that works out its
 * own is the progress-bar bug of 2026-09-25. */
export interface ProjectMetrics {
  totalTasks: number;
  doneTasks: number;
  percentComplete: number;
  daysLogged: number;
  totalPersonHours: number;
  photoCount: number;
  pendingScopeChanges: number;
  lastWorkDate?: string | null;
  buildWoIds?: string[];
}

export const tasksApi = {
  add: (projectId: string, body: { description: string; notes?: string }) =>
    api.post<{ task: ProjectTask }>(`/api/projects/${encodeURIComponent(projectId)}/tasks`, body),
  update: (projectId: string, taskId: string, patch: { description?: string; notes?: string; order?: number }) =>
    api.patch<{ task: ProjectTask }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, patch),
  /* Removing is archive-or-delete, decided by the server: a task anything
     has ever referenced is kept and stops counting; one nothing ever
     touched is really gone. The response says which happened and why. */
  remove: (projectId: string, taskId: string) =>
    api.del<{ removed: string | null; archived: string | null; reasons: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`),
  /* The office door onto the same record the field app writes. `percent`
     is absolute — what a person means by "set it to 60" — and the server
     converts it to the cumulative delta its mutator takes. */
  setProgress: (projectId: string, taskId: string, percent: number) =>
    api.post<{ task: ProjectTask; metrics: ProjectMetrics }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/progress`, { percent }),
  seedFromQuote: (projectId: string) =>
    api.post<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/seed`)
};

export const metricsApi = {
  get: (projectId: string) =>
    api.get<{ metrics: ProjectMetrics }>(`/api/projects/${encodeURIComponent(projectId)}/metrics`)
      .then((d) => d.metrics)
};

export const projectsApi = {
  list: () => api.get<{ projects: ProjectSummary[] }>("/api/projects").then((d) => d.projects || []),
  get: (id: string) =>
    api.get<{
      project: ProjectDetail;
      materialLists?: Array<{ id: string; name?: string; status: string; totals?: { lineCount?: number } }>;
      linkedQuote?: LinkedQuote | null;
      invoiceSummary?: InvoiceSummary | null;
      siteBuilderSummary?: SiteBuilderSummary | null;
    }>(`/api/projects/${encodeURIComponent(id)}`)
};

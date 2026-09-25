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
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) })
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
  tasks?: Array<{ id: string; status: string; percentComplete?: number }>;
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

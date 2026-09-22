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
  tasks?: Array<{ id: string; status: string }>;
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

export interface SiteBuilderSummary {
  zoneCount: number;
  lastSavedAt?: string | null;
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

"use strict";

// PJL Assistant — a private MCP ("Model Context Protocol") endpoint that
// lets Patrick's Claude app read the CRM and book / reschedule / cancel
// appointments by talking to it.
//
// HOW IT IS WIRED
//   URL:   POST /mcp/<PJL_ASSISTANT_KEY>
//   Off:   when the PJL_ASSISTANT_KEY env var is unset (or shorter than 24
//          chars) the endpoint does not exist — every request 404s.
//   Auth:  the long random key in the URL IS the credential, the same model
//          as the iCal feed (/calendar/<token>.ics). Wrong key → 404, so the
//          endpoint never confirms it exists.
//
// WHY EVERY TOOL GOES THROUGH THE EXISTING /api ROUTES
//   Each tool calls this same server's own admin API over loopback with a
//   short-lived signed admin session. Nothing here re-implements a business
//   rule: booking a visit runs the exact /api/booking/reserve path the CRM
//   uses (lock, slot re-check, lead/customer/property/booking writes,
//   notifications), rescheduling runs PATCH /api/bookings/:id/reschedule,
//   and so on. If a rule changes in server.js, the assistant follows it
//   automatically. This module only translates "tool call" → "API call"
//   and trims the answers to something a chat can read.
//
// PROTOCOL
//   Stateless MCP "Streamable HTTP": every POST is one JSON-RPC message (or a
//   batch) and gets a plain JSON reply. No sessions, no SSE stream — GET and
//   DELETE answer 405, which the spec allows.

const crypto = require("node:crypto");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "pjl-assistant", title: "PJL Assistant", version: "1.0.0" };
const MAX_TEXT_CHARS = 60_000;
const MIN_KEY_LENGTH = 24;

const INSTRUCTIONS = [
  "You are Patrick's assistant for PJL Land Services (irrigation + landscape lighting, Newmarket, Ontario; time zone America/Toronto).",
  "These tools read and change his LIVE CRM and booking system.",
  "Before ANY tool that books, reschedules or cancels, read the details back to Patrick in plain English (who, address, service, date/time) and wait for a clear yes.",
  "Say what the customer will receive: booking sends the normal confirmation; rescheduling ALWAYS emails the customer (cannot be skipped); cancelling emails only if Patrick says so.",
  "If a book_appointment call fails with a timeout or unclear error, retry ONCE with the same operationId — never a new one — or check list_bookings first.",
  "To book: find the customer first (search_customers / find_jobs), pick the service with list_services, get real open times with check_availability, then book_appointment with a slotStart copied exactly from those results.",
  "Only use customTime when Patrick asks for a specific time outside the offered slots.",
  "Answer in short plain English. Patrick is not a programmer — never show raw IDs or JSON unless he asks.",
].join(" ");

// ---------------------------------------------------------------- helpers

function keyFromEnv() {
  const k = String(process.env.PJL_ASSISTANT_KEY || "").trim();
  return k.length >= MIN_KEY_LENGTH ? k : "";
}

function keyMatches(candidate) {
  const expected = keyFromEnv();
  if (!expected || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Keys that are bulky and never useful in a chat answer.
const DROP_KEYS = new Set([
  "signature", "signatureDataUrl", "dataUrl", "base64", "data", "pdf", "html",
  "photos", "photoMeta", "rawPayload", "transcript", "messagesRaw", "geometry",
  "polyline", "routeGeometry", "token", "portalToken", "approvalToken",
  "passwordHash", "salt", "design", "sitePlan", "raster",
]);

// Trim a record for a chat answer: drop bulky keys, cap long strings,
// keep only the last few history entries, cap long arrays.
function slim(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 1500 ? value.slice(0, 1500) + "…" : value;
  if (typeof value !== "object") return value;
  if (depth > 6) return "…";
  if (Array.isArray(value)) {
    const out = value.slice(0, 40).map((v) => slim(v, depth + 1));
    if (value.length > 40) out.push(`…and ${value.length - 40} more`);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k)) continue;
    if ((k === "history" || k === "activity" || k === "communications") && Array.isArray(v)) {
      out[k] = v.slice(-5).map((x) => slim(x, depth + 1));
      if (v.length > 5) out[`${k}Count`] = v.length;
      continue;
    }
    out[k] = slim(v, depth + 1);
  }
  return out;
}

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return [];
}

function matchesQuery(record, query) {
  const hay = JSON.stringify(record || {}).toLowerCase();
  const digits = hay.replace(/[^0-9a-z@.]/g, "");
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean).every((tok) => {
    if (hay.includes(tok)) return true;
    const tokDigits = tok.replace(/\D/g, "");
    return tokDigits.length >= 4 && digits.includes(tokDigits);
  });
}

function dateKeyOf(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

// Open-time lists repeat the service and day on every slot. Strip those so
// three weeks of times fit in one answer, and add the Toronto clock time so
// Claude never has to convert UTC itself.
const SLOT_REPEATS = new Set(["serviceKey", "serviceLabel", "dayLabel", "durationMinutes", "end"]);
function compactDays(days) {
  return (Array.isArray(days) ? days : [])
    .filter((d) => !Array.isArray(d.slots) || d.slots.length)
    .slice(0, 21)
    .map((d) => {
      if (!Array.isArray(d.slots)) return d;
      return {
        ...d,
        slots: d.slots.map((s) => {
          const out = { localTime: s.start ? new Date(s.start).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" }) : undefined };
          for (const [k, v] of Object.entries(s)) if (!SLOT_REPEATS.has(k) && v !== null) out[k] = v;
          return out;
        }),
      };
    });
}

function textResult(payload, isError = false) {
  let text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 1);
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n…(cut short — ask for something narrower)";
  return { content: [{ type: "text", text }], isError };
}

function apiError(r) {
  const body = r.body || {};
  const msg = (Array.isArray(body.errors) && body.errors.filter(Boolean).join(" ")) || body.message || body.error || `Request failed (HTTP ${r.status}).`;
  return textResult({ ok: false, status: r.status, code: body.code, message: msg, details: body.details }, true);
}

// ---------------------------------------------------------------- tools

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const DATE = { type: "string", description: "Date as YYYY-MM-DD (Toronto time)." };

// read_crm whitelist. Deliberately NOT "any /api GET": the admin API also
// serves the user list, integration status (QuickBooks, Stripe) and other
// settings the assistant has no business reading. Business records only.
const READ_CRM_ALLOWED = [
  "/api/work-orders", "/api/projects", "/api/properties", "/api/admin/quote-folder",
  "/api/purchase-orders", "/api/material-lists", "/api/quote-requests", "/api/parts",
  "/api/season-plans", "/api/schedule",
  // The read-only booking reconciliation audit (PJL-137): counts and ids,
  // never a write.
  "/api/admin/booking-audit",
];

function buildTools({ services }) {
  return [
    {
      name: "day_schedule",
      title: "Day schedule / route",
      description: "Everything on the schedule for one day, in route order: each stop's customer, address, service, time, zones and work-order status. Use for 'what's on today/tomorrow', 'what's my route Thursday'.",
      inputSchema: { type: "object", properties: { date: DATE }, required: [] },
      annotations: READ,
      async run({ date }, api) {
        const q = date ? `?date=${encodeURIComponent(date)}` : "";
        const r = await api.get(`/api/schedule/today${q}`);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "find_jobs",
      title: "Find a job",
      description: "Search scheduled jobs, bookings, work orders and the season plan by customer name, address, or a code (BK-, WO-, CUST-…). Good first step for 'when is the Smith closing?'.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Name, street, town or code." }, date: { ...DATE, description: "Reference date (defaults to today)." } },
        required: ["query"],
      },
      annotations: READ,
      async run({ query, date }, api) {
        const qs = new URLSearchParams({ q: query });
        if (date) qs.set("date", date);
        const r = await api.get(`/api/schedule/find-jobs?${qs}`);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "search_customers",
      title: "Search customers",
      description: "Find customers by any mix of name, phone, email, street or town. Returns matching customer records (CUST-…). Use get_customer for the full file.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 15 } },
        required: ["query"],
      },
      annotations: READ,
      async run({ query, limit = 15 }, api) {
        const r = await api.get("/api/customers");
        if (!r.ok) return apiError(r);
        const hits = firstArray(r.body).filter((c) => matchesQuery(c, query));
        return textResult({ total: hits.length, customers: slim(hits.slice(0, limit)) });
      },
    },
    {
      name: "get_customer",
      title: "Customer file",
      description: "One customer's full file: contact info, properties (zones, system), bookings, work orders, quotes and invoices.",
      inputSchema: { type: "object", properties: { customerId: { type: "string", description: "CUST-… id" } }, required: ["customerId"] },
      annotations: READ,
      async run({ customerId }, api) {
        const r = await api.get(`/api/customer/${encodeURIComponent(customerId)}`);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "list_bookings",
      title: "List bookings",
      description: "Bookings between two dates (inclusive), optionally filtered by status (e.g. confirmed, cancelled, completed) or by a text search on name/address.",
      inputSchema: {
        type: "object",
        properties: {
          from: DATE, to: DATE,
          status: { type: "string" },
          query: { type: "string", description: "Optional name/address filter." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 40 },
        },
        required: [],
      },
      annotations: READ,
      async run({ from, to, status, query, limit = 40 }, api) {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        const r = await api.get(`/api/bookings${qs}`);
        if (!r.ok) return apiError(r);
        let list = firstArray(r.body);
        if (from || to) {
          list = list.filter((b) => {
            const k = dateKeyOf(b.scheduledFor || b.start || b.slotStart);
            if (!k) return false;
            return (!from || k >= from) && (!to || k <= to);
          });
        }
        if (query) list = list.filter((b) => matchesQuery(b, query));
        list.sort((a, b) => new Date(a.scheduledFor || 0) - new Date(b.scheduledFor || 0));
        return textResult({ total: list.length, bookings: slim(list.slice(0, limit)) });
      },
    },
    {
      name: "get_booking",
      title: "Booking details",
      description: "Full details of one booking (BK-…).",
      inputSchema: { type: "object", properties: { bookingId: { type: "string" } }, required: ["bookingId"] },
      annotations: READ,
      async run({ bookingId }, api) {
        const r = await api.get(`/api/bookings/${encodeURIComponent(bookingId)}`);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "list_services",
      title: "Bookable services",
      description: "The service codes the booking system accepts (spring openings, fall closings by zone count, repair, Hydrawise retrofit, site visit). Pick the one matching the customer's zone count.",
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: READ,
      async run() {
        const list = Object.entries(services || {}).map(([key, s]) => ({
          serviceKey: key, label: s.label, category: s.category, durationMinutes: s.durationMinutes ?? s.duration ?? undefined,
        }));
        return textResult({ services: list });
      },
    },
    {
      name: "check_availability",
      title: "Open times",
      description: "Real open appointment times for a service at an address, using the same routing rules as the website. Starred/recommended days join a route already being driven. Copy a slot's start value exactly into book_appointment.",
      inputSchema: {
        type: "object",
        properties: {
          serviceKey: { type: "string", description: "From list_services." },
          address: { type: "string", description: "Full street address incl. town." },
          from: DATE, to: DATE,
        },
        required: ["serviceKey", "address"],
      },
      annotations: READ,
      async run({ serviceKey, address, from, to }, api) {
        const qs = new URLSearchParams({ service: serviceKey, address, adminBypass: "1" });
        if (from && to) { qs.set("from", from); qs.set("to", to); }
        const r = await api.get(`/api/booking/availability?${qs}`);
        if (!r.ok) return apiError(r);
        const days = compactDays(firstArray(r.body.days ? { d: r.body.days } : r.body));
        return textResult(slim({ service: r.body.service, address: r.body.address, addressVerified: r.body.geocodeOk, days }));
      },
    },
    {
      name: "book_appointment",
      title: "Book an appointment",
      description: "Books a visit into the live schedule (creates/links the lead, customer, property, booking and work order, and sends the normal booking confirmation). ALWAYS confirm the details with Patrick first. Pass leadId to book an existing lead instead of creating a new one.",
      inputSchema: {
        type: "object",
        properties: {
          serviceKey: { type: "string" },
          slotStart: { type: "string", description: "A slot start from check_availability, or for customTime an ISO time with offset, e.g. 2026-10-20T09:00:00-04:00." },
          customTime: { type: "boolean", default: false, description: "true = force this exact time even if it is not an offered slot (still refuses a physical clash)." },
          leadId: { type: "string", description: "Optional existing lead to book." },
          firstName: { type: "string" }, lastName: { type: "string" },
          phone: { type: "string", description: "Required for a new customer." },
          altPhone: { type: "string", description: "Optional second number." },
          email: { type: "string", description: "Required for a new customer." },
          address: { type: "string" },
          zoneCount: { type: "integer", minimum: 1, maximum: 99 },
          notes: { type: "string" },
          operationId: { type: "string", maxLength: 60, description: "Make up ONE short random id per booking you intend to make and reuse it if you must retry after an error or timeout — the server then returns the original booking instead of double-booking." },
        },
        required: ["serviceKey", "slotStart", "firstName", "lastName", "address", "operationId"],
      },
      annotations: WRITE,
      async run(a, api) {
        const body = {
          serviceKey: a.serviceKey,
          slotStart: a.slotStart,
          contact: {
            firstName: a.firstName, lastName: a.lastName,
            name: `${a.firstName || ""} ${a.lastName || ""}`.trim(),
            phone: a.phone || "", altPhone: a.altPhone || "", email: a.email || "",
            address: a.address, notes: a.notes || "",
          },
        };
        if (Number.isInteger(a.zoneCount)) body.zoneCount = a.zoneCount;
        if (a.customTime) body.source = "admin_custom";
        if (a.leadId) body.leadId = a.leadId;
        // A normal offered slot is held first, exactly as the website's
        // picker does (POST /api/booking/hold), then reserved with that
        // hold — the server refuses a standard booking without one.
        // Custom-time and book-from-lead are exempt server-side.
        if (!a.customTime && !a.leadId) {
          const h = await api.post("/api/booking/hold", { serviceKey: a.serviceKey, slotStart: a.slotStart, address: a.address });
          if (!h.ok || !h.body?.holdToken) return apiError(h);
          body.holdToken = h.body.holdToken;
        }
        // Retry safety: the same operationId replayed within 24 h returns
        // the ORIGINAL booking instead of making a second one (PJL-87).
        body.clientRequestId = a.operationId ? `assistant:${a.operationId}` : `assistant:${crypto.randomUUID()}`;
        const r = await api.post("/api/booking/reserve", body);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "reschedule_options",
      title: "Reschedule options",
      description: "Open times an existing booking can be moved to.",
      inputSchema: { type: "object", properties: { bookingId: { type: "string" }, from: DATE, to: DATE }, required: ["bookingId"] },
      annotations: READ,
      async run({ bookingId, from, to }, api) {
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        const r = await api.get(`/api/bookings/${encodeURIComponent(bookingId)}/availability?${qs}`);
        if (!r.ok) return apiError(r);
        const { days, ...rest } = r.body || {};
        return textResult(slim({ ...rest, days: compactDays(days) }));
      },
    },
    {
      name: "reschedule_booking",
      title: "Reschedule a booking",
      description: "Moves a booking to a new time (same rules as rescheduling in the CRM). The customer is ALWAYS sent a 'rescheduled' notice — there is no way to skip it. Tell Patrick that, confirm the new day/time, and wait for a yes.",
      inputSchema: {
        type: "object",
        properties: {
          bookingId: { type: "string" },
          slotStart: { type: "string", description: "From reschedule_options, or an ISO time with offset when customTime is true." },
          customTime: { type: "boolean", default: false },
          reason: { type: "string" },
        },
        required: ["bookingId", "slotStart"],
      },
      annotations: WRITE,
      async run({ bookingId, slotStart, customTime, reason }, api) {
        const r = await api.patch(`/api/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
          slotStart, source: customTime ? "admin_custom" : "slot", reason: reason || "Rescheduled via PJL Assistant",
        });
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "cancel_booking",
      title: "Cancel a booking",
      description: "Cancels a booking (soft cancel — the record stays, the slot frees up). ALWAYS confirm with Patrick first, including whether the customer should be emailed.",
      inputSchema: {
        type: "object",
        properties: {
          bookingId: { type: "string" },
          reason: { type: "string" },
          notifyCustomer: { type: "boolean", description: "Email the customer a cancellation notice." },
        },
        required: ["bookingId", "reason", "notifyCustomer"],
      },
      annotations: DESTRUCTIVE,
      async run({ bookingId, reason, notifyCustomer }, api) {
        const r = await api.post(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, { reason, notifyCustomer: notifyCustomer === true });
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
    {
      name: "list_leads",
      title: "Leads / requests",
      description: "Recent leads and quote requests from the website, AI chat and phone, newest first. Optional text filter.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 60, default: 20 } },
        required: [],
      },
      annotations: READ,
      async run({ query, limit = 20 }, api) {
        const r = await api.get("/api/quotes");
        if (!r.ok) return apiError(r);
        let list = firstArray(r.body);
        if (query) list = list.filter((l) => matchesQuery(l, query));
        list.sort((a, b) => new Date(b.createdAt || b.submittedAt || 0) - new Date(a.createdAt || a.submittedAt || 0));
        return textResult({ total: list.length, leads: slim(list.slice(0, limit)) });
      },
    },
    {
      name: "list_invoices",
      title: "Invoices",
      description: "Invoices, optionally by status (e.g. draft, sent, paid, overdue) or text filter. Use for 'who owes me money'.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 60, default: 25 } },
        required: [],
      },
      annotations: READ,
      async run({ status, query, limit = 25 }, api) {
        const r = await api.get(`/api/invoices${status ? `?status=${encodeURIComponent(status)}` : ""}`);
        if (!r.ok) return apiError(r);
        let list = firstArray(r.body);
        if (query) list = list.filter((i) => matchesQuery(i, query));
        return textResult({ total: list.length, invoices: slim(list.slice(0, limit)) });
      },
    },
    {
      name: "read_crm",
      title: "Read anything in the CRM",
      description: "Read-only access to CRM records the other tools don't cover, by API path. Allowed: /api/work-orders…, /api/projects…, /api/properties…, /api/admin/quote-folder, /api/purchase-orders…, /api/material-lists…, /api/quote-requests…, /api/parts…, /api/season-plans…, /api/schedule…. Examples: /api/work-orders/WO-2026-0123, /api/projects/PROJ-2026-0008. Anything else is refused. Never changes anything.",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Must start with /api/" } }, required: ["path"] },
      annotations: READ,
      async run({ path }, api) {
        const p = String(path || "");
        if (!p.startsWith("/api/") || p.includes("..") || /[\r\n]/.test(p)) {
          return textResult("Path must start with /api/.", true);
        }
        if (!READ_CRM_ALLOWED.some((prefix) => p === prefix || p.startsWith(prefix + "/") || p.startsWith(prefix + "?"))) {
          return textResult("That part of the CRM isn't available to the assistant.", true);
        }
        const r = await api.get(p);
        return r.ok ? textResult(slim(r.body)) : apiError(r);
      },
    },
  ];
}

// ---------------------------------------------------------------- loopback API

function makeApi({ port, getAdminCookie }) {
  async function call(method, path, body) {
    const cookie = await getAdminCookie();
    if (!cookie) return { ok: false, status: 503, body: { errors: ["No active admin account to act as."] } };
    const headers = { cookie, accept: "application/json", "x-pjl-assistant": "1" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { text: text.slice(0, 2000) }; }
      const ok = res.ok && !(parsed && parsed.ok === false);
      return { ok, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, status: 504, body: { errors: [err.name === "AbortError" ? "The CRM took too long to answer." : (err.message || "Request failed.")] } };
    } finally {
      clearTimeout(t);
    }
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
  };
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

function createAssistantMcp({ port, getAdminCookie, services, log = console }) {
  const tools = buildTools({ services });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const api = makeApi({ port, getAdminCookie });

  async function handleMessage(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpcError(msg?.id, -32600, "Invalid request");
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};
    switch (msg.method) {
      case "initialize": {
        const asked = String(params.protocolVersion || "");
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return isNotification ? null : rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case "tools/call": {
        const tool = byName.get(params.name);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        try {
          const result = await tool.run(args, api);
          log.log?.(`[assistant-mcp] ${tool.name} ${result.isError ? "error" : "ok"}`);
          return rpcResult(msg.id, result);
        } catch (err) {
          log.warn?.(`[assistant-mcp] ${tool.name} threw:`, err?.message || err);
          return rpcResult(msg.id, textResult(`Something went wrong: ${err?.message || err}`, true));
        }
      }
      case "resources/list": return rpcResult(msg.id, { resources: [] });
      case "prompts/list": return rpcResult(msg.id, { prompts: [] });
      default:
        if (isNotification) return null; // notifications/initialized etc.
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  // Returns true when it answered the request, false when the path is not
  // the assistant endpoint (caller keeps routing).
  async function handle(req, res, pathname, readBody) {
    const m = pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m) return false;
    const send = (status, payload, extra = {}) => {
      const body = payload === null ? "" : JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
      res.end(body);
    };
    if (!keyMatches(decodeURIComponent(m[1]))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return true;
    }
    if (req.method === "OPTIONS") { res.writeHead(204, { allow: "POST, OPTIONS" }); res.end(); return true; }
    if (req.method !== "POST") { send(405, rpcError(null, -32000, "Method not allowed"), { allow: "POST" }); return true; }
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      send(400, rpcError(null, -32700, "Parse error"));
      return true;
    }
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(handleMessage))).filter(Boolean);
      if (!out.length) { res.writeHead(202); res.end(); return true; }
      send(200, out);
      return true;
    }
    const reply = await handleMessage(payload);
    if (!reply) { res.writeHead(202); res.end(); return true; }
    send(200, reply);
    return true;
  }

  return { handle, tools, handleMessage };
}

module.exports = { createAssistantMcp, slim, matchesQuery, keyMatches, SUPPORTED_PROTOCOL_VERSIONS };

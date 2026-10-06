// PJL Assistant MCP endpoint (server/lib/assistant-mcp.js).
// Pins: the key gate (unset / wrong key → 404, never confirms the endpoint),
// the MCP handshake, notifications answering 202, the tool list, and that
// read_crm can only read /api/ paths.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createAssistantMcp } = require("../server/lib/assistant-mcp.js");

const mcp = createAssistantMcp({
  port: 1,
  getAdminCookie: async () => null,
  services: { site_visit: { label: "Site visit", category: "consult" } },
  log: {},
});

function fakeRes() {
  return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b || ""; } };
}
async function hit(path, method, payload) {
  const res = fakeRes();
  const handled = await mcp.handle({ method }, res, path, async () => payload);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* plain-text 404 */ }
  return { handled, status: res.status, json };
}

delete process.env.PJL_ASSISTANT_KEY;
let r = await hit("/mcp/anything-at-all-long-enough-123", "POST", {});
assert.equal(r.status, 404, "no key configured → 404");

process.env.PJL_ASSISTANT_KEY = "k".repeat(40);
r = await hit("/mcp/wrong", "POST", {});
assert.equal(r.status, 404, "wrong key → 404");
assert.equal((await hit("/somewhere/else", "POST", {})).handled, false, "other paths fall through");

const P = "/mcp/" + "k".repeat(40);
r = await hit(P, "GET");
assert.equal(r.status, 405, "GET is not served");

r = await hit(P, "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
assert.equal(r.json.result.protocolVersion, "2025-06-18");
assert.equal(r.json.result.serverInfo.name, "pjl-assistant");

r = await hit(P, "POST", { jsonrpc: "2.0", method: "notifications/initialized" });
assert.equal(r.status, 202, "notification → 202, no body");

r = await hit(P, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" });
const names = r.json.result.tools.map((t) => t.name);
for (const n of ["day_schedule", "book_appointment", "reschedule_booking", "cancel_booking", "search_customers", "read_crm"]) {
  assert.ok(names.includes(n), `tool ${n} listed`);
}
const cancel = r.json.result.tools.find((t) => t.name === "cancel_booking");
assert.equal(cancel.annotations.destructiveHint, true, "cancel is marked destructive");

r = await hit(P, "POST", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_crm", arguments: { path: "/etc/passwd" } } });
assert.equal(r.json.result.isError, true, "read_crm refuses non-/api paths");

r = await hit(P, "POST", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_services", arguments: {} } });
assert.match(r.json.result.content[0].text, /site_visit/);

r = await hit(P, "POST", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "day_schedule", arguments: {} } });
assert.equal(r.json.result.isError, true, "no admin account → a clear error, not a crash");

// A standard booking must HOLD the slot first, then reserve with that hold
// (the server answers 409 hold_required otherwise — found 2026-10-06).
// Custom time and book-from-lead are server-exempt and skip the hold.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, body });
    const reply = path === "/api/booking/hold" ? { ok: true, holdToken: "HOLD-1" } : { ok: true, leadId: "L1" };
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  const m2 = createAssistantMcp({ port: 1, getAdminCookie: async () => "c=1", services: {}, log: {} });
  const book = (extra) => m2.handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "book_appointment", arguments: {
    serviceKey: "fall_close_4z", slotStart: "2026-10-08T12:00:00.000Z", firstName: "A", lastName: "B", address: "1 Main St, Newmarket", ...extra } } });

  await book({});
  assert.deepEqual(calls.map((c) => c.path), ["/api/booking/hold", "/api/booking/reserve"], "normal slot: hold, then reserve");
  assert.equal(calls[1].body.holdToken, "HOLD-1", "reserve carries the hold token");

  calls.length = 0;
  await book({ customTime: true });
  assert.deepEqual(calls.map((c) => c.path), ["/api/booking/reserve"], "custom time: no hold");
  assert.equal(calls[0].body.source, "admin_custom");

  calls.length = 0;
  await book({ leadId: "L9" });
  assert.deepEqual(calls.map((c) => c.path), ["/api/booking/reserve"], "book-from-lead: no hold");
  globalThis.fetch = realFetch;
}

console.log("test-assistant-mcp: all checks passed");

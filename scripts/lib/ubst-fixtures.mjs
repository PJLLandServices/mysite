// scripts/lib/ubst-fixtures.mjs
//
// Shared fixtures for the Unified Booking Source of Truth suites
// (P-PJL-39, PJL-132 → PJL-138). Everything runs against the booted test
// server from ./field-server.mjs: a throwaway copy of server/, outbound
// stubbed, tripwired against production. Nothing here can reach real data.
//
// The suites are FAIL-FIRST. They describe the contract the project is
// building toward and are expected to fail on today's code; each suite's
// header records how many assertions fail on the base it was written
// against. A missing function or route is a failed assertion, never a
// crash that hides the rest (test-remove-visit.mjs convention).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer, sleep } from "./field-server.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export { sleep };

// ---- Reporting --------------------------------------------------------
export function reporter(suiteName) {
  let pass = 0;
  const failures = [];
  const ok = (name, cond, detail = "") => {
    if (cond) { pass += 1; return true; }
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    return false;
  };
  const j = (v, n = 260) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
  const finish = ({ expectedFailing = null } = {}) => {
    console.log(`\n${suiteName}: ${pass} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
      if (expectedFailing != null) {
        console.log(`\n  (fail-first suite: ${expectedFailing} assertion(s) are expected to fail until the matching phase lands)`);
      }
    }
    process.exit(failures.length ? 1 : 0);
  };
  return { ok, j, finish, get failures() { return failures; }, get passed() { return pass; } };
}

// ---- Boot -------------------------------------------------------------
export async function bootUbst({ port, env = {} } = {}) {
  const srv = await bootServer({ port, env });
  await srv.login({ role: "admin" });
  // The iCal feed is off until configured; the suites read it as one of
  // the appointment readers, so switch it on in the sandbox.
  try {
    const settings = srv.lib("settings.js");
    const current = await settings.get();
    if (typeof settings.set === "function") {
      await settings.set({ ...current, icalFeed: { enabled: true, token: ICAL_TOKEN } });
    } else if (typeof settings.update === "function") {
      await settings.update({ icalFeed: { enabled: true, token: ICAL_TOKEN } });
    } else {
      srv.writeData("settings", { ...current, icalFeed: { enabled: true, token: ICAL_TOKEN } });
    }
  } catch { /* the feed assertions will report it */ }
  return srv;
}
export const ICAL_TOKEN = "ubst-feed-token-0123456789abcdef";

// ---- Seasons / dates --------------------------------------------------
export const SEASON = "fall";
export const YEAR = 2026;
export const WO_TYPE = "fall_closing";
export const SERVICE_4Z = "fall_close_4z";
export const SERVICE_4Z_LABEL = "Fall winterization (1-4 zones residential)";

// A local (America/Toronto) wall-clock instant on a plan day.
export const at = (date, h, m = 0) => new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
export const iso = (date, h, m = 0) => at(date, h, m).toISOString();
export const dayBefore = (date) => { const d = new Date(`${date}T10:00:00`); d.setDate(d.getDate() - 1); return d; };

// ---- Properties --------------------------------------------------------
// Written straight into the sandbox store (the stores are read per request),
// the way test-booking-lifecycle seeds leads: deterministic codes and
// coordinates, which the plan keys on and the sequencer needs.
let propSeq = 0;
export function makeProperty({ code, name, email, phone, address, lat = 44.05, lng = -79.46, zones = 4, extra = {} } = {}) {
  propSeq += 1;
  const id = `ubst-prop-${String(propSeq).padStart(3, "0")}-${code.toLowerCase()}`;
  const addr = address || `${100 + propSeq} Test St, Newmarket, ON L3Y 1A1, Canada`;
  return {
    id, code,
    customerId: null,
    customerEmail: email || `${code.toLowerCase()}@example.com`,
    customerName: name || `Customer ${code}`,
    customerPhone: phone || `9055550${String(100 + propSeq).slice(-3)}`,
    ownerHistory: [], history: [],
    address: addr,
    addressNormalized: addr.toLowerCase().replace(/\s+/g, " ").trim(),
    coords: { lat: lat + propSeq * 0.002, lng: lng - propSeq * 0.002, source: "google", formattedAddress: addr },
    system: { zones: Array.from({ length: zones }, (_, i) => ({ number: i + 1, location: `Zone ${i + 1}` })), zoneCount: null },
    leadIds: [], workOrderIds: [], deferredIssues: [], serviceRecords: [],
    seasonalEligibility: { springOpening: true, fallClosing: true },
    seasonalOutreach: {},
    commPrefs: { seasonalRemindersSMS: true, seasonalRemindersEmail: true, reviewRequestsEmail: true, noContactNeeded: false },
    deletedAt: null, archivedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
    ...extra
  };
}

export function seedProperties(srv, list) {
  const existing = srv.data("properties");
  const arr = Array.isArray(existing) ? existing : [];
  const byId = new Map(arr.map((p) => [p.id, p]));
  for (const p of list) byId.set(p.id, p);
  srv.writeData("properties", [...byId.values()]);
  return list;
}

export async function getProperty(srv, id) {
  const r = await srv.api("GET", `/api/properties/${encodeURIComponent(id)}`);
  return r.body?.property || null;
}

// ---- Plan ---------------------------------------------------------------
export async function seedPlan(srv, { season = SEASON, year = YEAR, days, bucketCap = 5, dayCap = 10 }) {
  const r = await srv.api("PUT", `/api/season-plans/${season}/${year}`, { days, bucketCap, dayCap, source: "ubst fixture" });
  if (r.status !== 200) throw new Error(`plan import failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

export async function getPlan(srv, { season = SEASON, year = YEAR } = {}) {
  const r = await srv.api("GET", `/api/season-plans/${season}/${year}`);
  return r.body?.plan || null;
}

// One stop, as the board sees it: in a bucket (with its state), in the
// dropped strip, or nowhere.
export async function planStop(srv, { date, code, season = SEASON, year = YEAR }) {
  const plan = await getPlan(srv, { season, year });
  const day = (plan?.days || []).find((d) => d.date === date) || null;
  if (!day) return { day: null, inDay: false, bucket: null, state: null, bookingId: null, dropped: null };
  for (const bucket of ["morning", "afternoon"]) {
    const s = (day[bucket] || []).find((x) => x.code === code);
    if (s) return { day, inDay: true, bucket, state: s.bookingState || null, bookingId: s.bookingId || null, stopNumber: s.stopNumber ?? null, dropped: null, stop: s };
  }
  const g = (day.dropped || []).find((x) => x.code === code) || null;
  return { day, inDay: false, bucket: null, state: g?.state || null, bookingId: g?.bookingId || null, dropped: g };
}

export function storedPlanStop(srv, { date, code, season = SEASON, year = YEAR }) {
  const all = srv.data("season-plans");
  const plan = all && all[`${season}-${year}`];
  const day = plan?.days?.[date];
  if (!day) return null;
  for (const bucket of ["morning", "afternoon"]) {
    const i = (day[bucket] || []).indexOf(code);
    if (i > -1) return { bucket, index: i, placed: day.placed?.[code] || null, raw: day[bucket][i] };
  }
  return null;
}

// ---- Assignment writer --------------------------------------------------
export async function bookNow(srv, { code, date, season = SEASON, year = YEAR }) {
  const r = await srv.api("POST", `/api/assignments/${season}/${year}/assign`, { code, date });
  const stop = r.body?.stop || null;
  return { status: r.status, body: r.body, stop, bookingId: stop?.bookingId || null, outcome: stop?.outcome || null, reason: stop?.reason || null, told: r.body?.told || null };
}

export async function assignSeason(srv, { season = SEASON, year = YEAR } = {}) {
  const r = await srv.api("POST", `/api/assignments/${season}/${year}/assign`, {});
  const stops = [];
  for (const d of r.body?.days || []) for (const s of d.stops || []) stops.push({ date: d.date, ...s });
  return { status: r.status, body: r.body, stops, summary: r.body?.summary || null };
}

export async function unassignSeason(srv, { season = SEASON, year = YEAR } = {}) {
  const r = await srv.api("POST", `/api/assignments/${season}/${year}/unassign`, {});
  return { status: r.status, body: r.body };
}

export async function preflightStop(srv, { code, season = SEASON, year = YEAR }) {
  const r = await srv.api("GET", `/api/assignments/${season}/${year}/preflight`);
  for (const d of r.body?.days || []) {
    const s = (d.stops || []).find((x) => x.code === code);
    if (s) return { date: d.date, ...s };
  }
  return null;
}

// Make a booking read as "messaged" the way a blast or Book now leaves it,
// without depending on the stub mailer's mood: the cadence's own step mark.
export async function markMessaged(srv, bookingId) {
  const bookings = srv.lib("bookings.js");
  const now = new Date().toISOString();
  return bookings.setAssignmentOutreach(bookingId, {
    steps: { "1": { at: now, attempted: ["email", "sms"], sent: ["email", "sms"] } }
  }, { action: "cadence_step_1", by: "ubst-fixture", note: "email+sms" });
}

// ---- Bookings -------------------------------------------------------------
export async function getBooking(srv, id) {
  const r = await srv.api("GET", `/api/bookings/${encodeURIComponent(id)}`);
  return { status: r.status, booking: r.body?.booking || null };
}
export function bookingOnDisk(srv, id) {
  return (srv.data("bookings") || []).find((b) => b && b.id === id) || null;
}

export async function appointmentToken(srv, bookingId) {
  const actions = srv.lib("appointment-actions.js");
  return actions.ensureToken(bookingId);
}

// ---- Leads (the envelope path) -------------------------------------------
let leadSeq = 0;
export function makeLead({ propertyId = null, name, email, phone, address, start, serviceKey = SERVICE_4Z, serviceLabel = SERVICE_4Z_LABEL, durationMinutes = 30, woId = null, booking = true } = {}) {
  leadSeq += 1;
  const id = `ubst-lead-${String(leadSeq).padStart(3, "0")}`;
  const created = "2026-09-01T12:00:00.000Z";
  const addr = address || `${200 + leadSeq} Lead Ave, Newmarket, ON L3Y 2B2, Canada`;
  const lead = {
    id, createdAt: created, status: "won", source: "fall_closing",
    // Both spellings: the intake writes contact.address; work-orders.create
    // reads lead.address for a lead-only work order.
    address: addr,
    contact: { name: name || `Lead ${leadSeq}`, phone: phone || `9055551${String(100 + leadSeq).slice(-3)}`, email: email || `lead${leadSeq}@example.com`, address: addr, notes: "" },
    features: [{ key: serviceKey, label: serviceLabel, qty: 1, price: 95, category: "seasonal", quoteType: "flat" }],
    totals: { expectedTotal: 95, submittedTotal: 95, currency: "CAD" },
    crm: { status: "won", priority: "normal", owner: "", nextFollowUp: "", internalNotes: "", lastUpdated: created, activity: [] },
    portal: { createdAt: created, messages: [] },
    archived: false, propertyId, customerId: null, deletedAt: null, botFlagged: false
  };
  if (booking && start) {
    const startIso = new Date(start).toISOString();
    const endIso = new Date(new Date(start).getTime() + durationMinutes * 60000).toISOString();
    lead.booking = {
      start: startIso, end: endIso, durationMinutes,
      bucketKey: new Date(start).getHours() < 12 ? "morning" : "afternoon",
      bucketWindow: new Date(start).getHours() < 12 ? "8 AM – 12 PM" : "12 PM – 5 PM",
      bucketLabel: new Date(start).getHours() < 12 ? "Morning Appointment" : "Afternoon Appointment",
      serviceKey, serviceLabel, zoneCount: 4,
      coords: { lat: 44.06, lng: -79.45, formattedAddress: lead.contact.address },
      workOrder: { id: woId || `WO-UBST${String(leadSeq).padStart(4, "0")}`, status: "scheduled", total: 95, priceLabel: "$95", priceNote: null, custom: false, currency: "CAD", documentReady: false, documentUrl: null, diagnosis: null, createdAt: created }
    };
  }
  return lead;
}

export function seedLeads(srv, list) {
  const existing = srv.data("leads");
  const arr = Array.isArray(existing) ? existing : [];
  const byId = new Map(arr.map((l) => [l.id, l]));
  for (const l of list) byId.set(l.id, l);
  srv.writeData("leads", [...byId.values()]);
  return list;
}

// A lead's envelope becomes a canonical record the way the system does it
// since PJL-133: the heal SWEEP (bookings.healFromLeads at boot and every
// ten minutes), never a page view. The GET that used to do this is
// read-only now (test-ubst-idempotent-writers A pins that), so the fixture
// runs the sweep's own function over the sandbox store.
export async function healLead(srv, leadId) {
  const bookingsLib = srv.lib("bookings.js");
  const lead = (srv.data("leads") || []).find((l) => l && l.id === leadId) || null;
  if (lead) await bookingsLib.healFromLeads([lead]);
  const r = await srv.api("GET", `/api/bookings?leadId=${encodeURIComponent(leadId)}`);
  return (r.body?.bookings || [])[0] || null;
}

// ---- Work orders ----------------------------------------------------------
export async function openWoForProperty(srv, propertyId, type = WO_TYPE) {
  const r = await srv.api("POST", "/api/work-orders", { type, propertyId });
  return { status: r.status, wo: r.body?.workOrder || null, body: r.body };
}
export async function openWoForLead(srv, leadId, type = WO_TYPE) {
  const r = await srv.api("POST", "/api/work-orders", { type, leadId });
  return { status: r.status, wo: r.body?.workOrder || null, body: r.body };
}
export async function getWo(srv, id) {
  const r = await srv.api("GET", `/api/work-orders/${encodeURIComponent(id)}`);
  return r.body?.workOrder || null;
}
export function woOnDisk(srv, id) {
  return (srv.data("work-orders") || []).find((w) => w && w.id === id) || null;
}

// ---- Readers --------------------------------------------------------------
export async function todayRows(srv, date) {
  const r = await srv.api("GET", `/api/schedule/today?date=${date}`);
  return { status: r.status, rows: r.body?.bookings || [], removed: r.body?.removed || [], body: r.body };
}

// Capacity as the public engine sees it, through the admin bypass so the
// season gate and corridor rules do not hide the answer.
export async function slotsOn(srv, { date, service = SERVICE_4Z, address }) {
  const qs = new URLSearchParams({ service, address, from: date, to: date, adminBypass: "1" });
  const r = await srv.api("GET", `/api/booking/availability?${qs}`);
  if (!r.body?.ok) return { ok: false, error: JSON.stringify(r.body).slice(0, 200), slots: [] };
  const day = (r.body.days || []).find((d) => d.date === date);
  return { ok: true, slots: day?.slots || [], starts: (day?.slots || []).map((s) => s.start) };
}

export async function deriveState(srv, propertyId, { season = SEASON, year = YEAR } = {}) {
  const outreach = srv.lib("outreach.js");
  return outreach.deriveBookingState(propertyId, season, year);
}

export async function cadenceLiveCount(srv, { season = SEASON, year = YEAR } = {}) {
  const cadence = srv.lib("assignment-cadence.js");
  const s = await cadence.status(season, year);
  return s?.summary?.bookings ?? null;
}

// Would the day-before reminder sweep text this booking? Runs the real
// sweep over the sandbox store with the clock set to the day before at
// 10:00, capturing sends instead of making them, and never marking.
// The sweep hands notify() a lead-shaped notice whose id is the LEAD's id
// when the booking has a lead, else the booking's own id — so a match on
// either is "this visit".
export async function reminderWouldFire(srv, { bookingId, leadId = null }, date) {
  const reminders = srv.lib("booking-reminders.js");
  const bookingsLib = srv.lib("bookings.js");
  const notified = [];
  await reminders.sweepDayBefore({
    now: dayBefore(date),
    listBookings: bookingsLib.list,
    leads: srv.data("leads") || [],
    notify: async (event, lead) => { notified.push(lead?.id || null); },
    markSent: async () => null
  });
  return notified.includes(bookingId) || (leadId ? notified.includes(leadId) : false);
}

// The lead's portal token, derived the way server.js derives it.
export async function portalTokenFor(leadId) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`pjl-portal:${leadId}`).digest("base64url").slice(0, 24);
}

// The portal's derived state block, wherever the payload nests it: the
// object that carries `upcomingBooking` and `state`.
function findDerived(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  if (typeof node.upcomingBooking === "boolean" && typeof node.state === "string") return node;
  for (const v of Object.values(node)) {
    const hit = findDerived(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
export async function portalPayload(srv, leadId) {
  const token = await portalTokenFor(leadId);
  const r = await srv.api("GET", `/api/portal/${token}`);
  return { status: r.status, body: r.body, derived: findDerived(r.body), token };
}

export async function findJobs(srv, { q, date }) {
  const qs = new URLSearchParams({ q, date });
  const r = await srv.api("GET", `/api/schedule/find-jobs?${qs}`);
  return r.body || {};
}

export async function icalEventIds(srv) {
  try {
    const ical = srv.lib("ical-feed.js");
    const out = await ical.generateIcsForToken(ICAL_TOKEN, { baseUrl: "http://127.0.0.1", leads: srv.data("leads") || [] });
    if (!out || !out.ok) return { ok: false, ids: [], error: out?.status || "no feed" };
    const text = out.body || out.ics || out.text || "";
    const ids = [...String(text).matchAll(/BK-\d{4}-\d{4}/g)].map((m) => m[0]);
    return { ok: true, ids: [...new Set(ids)], text: String(text) };
  } catch (err) {
    return { ok: false, ids: [], error: err?.message || String(err) };
  }
}

// The one question every reader has to answer the same way.
export function holdsItsSlot(srv, status) {
  return srv.lib("bookings.js").holdsItsSlot(status);
}

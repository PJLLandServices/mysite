#!/usr/bin/env node
// scripts/test-field-merge-gaps.mjs
//
// PJL-98 — the gaps the PJL-77 audit found in fall-closing fix #6 (main's
// three-way merge, scripts/test-field-conflicts.mjs). Each case below failed
// against the code before its fix:
//
//   1. a SECOND queued zone edit silently undid an office edit;
//   2. a draft on a zone the OFFICE removed blocked Finish forever;
//   3. a tech could not remove a zone (403 read as "Not signed in", and the
//      visit kept the zone — which fix #7 then bills for);
//   4. "Keep mine" kept the office's value nowhere, and one answer covered
//      clashes the tech was never shown.
//
// Runs the REAL pjl-field/src/offline/queue.mjs, field.js and api.js against
// an in-memory server (vm, no network, no customer data): If-Match on both
// PATCH routes, work-order zones replaced wholesale and hydrated, property
// `system` merged one level deep, and the zone DELETE admin-only — as
// server.js does today.
//
// Run: node scripts/test-field-merge-gaps.mjs   (also in build:check)

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createQueue } from "../pjl-field/src/offline/queue.mjs";

const strip = (file) => fs.readFileSync(file, "utf8").replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/\bexport /g, "");
const FIELD = strip("pjl-field/src/offline/field.js");
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
let T = 0;
const tick = () => new Date(Date.UTC(2026, 9, 1, 12, 0, T++)).toISOString();
const hydrateZone = (z) => ({
  number: z.number || 0, kind: z.kind || "zone", location: z.location || z.label || "", sprinklerTypes: z.sprinklerTypes || [],
  coverage: z.coverage || [], status: z.status || "", notes: z.notes || "", checks: { heads: false, leaks: false, ...(z.checks || {}) },
  issues: (z.issues || []).map((i) => ({ id: i.id || "iss_srv", type: i.type, subtype: i.subtype || "", qty: i.qty || 1, notes: i.notes || "" })),
});

function world({ role = "tech" } = {}) {
  const disk = new Map();
  const S = { online: true, role, log: [] };
  S.prop = { id: "P-1", updatedAt: tick(), history: [], system: { shutoffLocation: "Basement", controllerLocation: "Garage",
    zones: [1, 2, 3, 4, 5].map((n) => ({ number: n, location: "Z" + n, label: "Z" + n })) } };
  S.wo = { id: "WO-1", type: "fall_closing", status: "on_site", propertyId: "P-1", updatedAt: tick(), photos: [], customerNotes: "", techNotes: "",
    zones: [1, 2, 3, 4, 5].map((n) => hydrateZone({ number: n, location: "Z" + n })) };
  const writeLocal = (k, v) => disk.set(k, JSON.stringify(v));
  const readLocal = (k) => (disk.has(k) ? JSON.parse(disk.get(k)) : null);
  const storeForOwner = (o) => ({ read: () => readLocal(o + ":queue"), write: (v) => writeLocal(o + ":queue", v),
    putBlob: (k, v) => writeLocal(o + k, v), getBlob: (k) => readLocal(o + k), deleteBlob: (k) => disk.delete(o + k) });
  const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
  const fetch = async (url, o = {}) => {
    if (!S.online) throw new TypeError("Network request failed");
    const p = new URL(url).pathname, m = o.method || "GET";
    S.log.push(`${m} ${p}`);
    if (p === "/api/session") return reply(200, { ok: true, authenticated: true, role: S.role, user: { id: "tech-1" }, fieldOffline: { photoRetry: 1 } });
    if (p === "/api/work-orders/WO-1") {
      if (m !== "PATCH") return reply(200, { ok: true, workOrder: clone(S.wo), property: clone(S.prop), lead: null });
      const body = JSON.parse(o.body), im = o.headers?.["if-match"];
      if (im && im !== S.wo.updatedAt) return reply(409, { ok: false, error: "version_conflict", errors: ["updated by someone else"] });
      Object.assign(S.wo, body); if (body.zones) S.wo.zones = body.zones.map(hydrateZone); S.wo.updatedAt = tick();
      return reply(200, { ok: true, workOrder: clone(S.wo) });
    }
    if (p === "/api/properties/P-1") {
      if (m !== "PATCH") return reply(200, { ok: true, property: clone(S.prop) });
      const body = JSON.parse(o.body), im = o.headers?.["if-match"];
      if (im && im !== S.prop.updatedAt) return reply(409, { ok: false, error: "version_conflict", errors: ["property changed elsewhere"] });
      S.prop.system = { ...S.prop.system, ...(body.system || {}) }; S.prop.updatedAt = tick();
      return reply(200, { ok: true, property: clone(S.prop) });
    }
    const del = p.match(/^\/api\/properties\/P-1\/zones\/(\d+)$/);
    if (del && m === "DELETE") {
      // server.js: `requireAdmin` — a tech session is refused (PJL-86).
      if (S.role !== "admin") return reply(403, { ok: false, errors: ["Admin role required."] });
      const n = Number(del[1]);
      S.prop.system.zones = S.prop.system.zones.filter((z) => z.number !== n); S.prop.updatedAt = tick();
      return reply(200, { ok: true, property: clone(S.prop) });
    }
    throw new Error("unexpected " + m + " " + p);
  };
  const globals = () => ({ createQueue, readLocal, writeLocal, storeForOwner, HOST: "https://x.local",
    AuthRequiredError: class AuthRequiredError extends Error { constructor() { super("Not signed in"); this.name = "AuthRequiredError"; } },
    fetch, AbortController, setTimeout, clearTimeout, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } });
  const load = () => vm.runInNewContext(FIELD + "\n({ openFieldWorkOrder, flushBeforeFinish, resolveFieldConflicts, fieldStatus });", globals());
  S.officeWo = (fn) => { fn(S.wo); S.wo.zones = S.wo.zones.map(hydrateZone); S.wo.updatedAt = tick(); };
  S.officeProp = (fn) => { fn(S.prop); S.prop.updatedAt = tick(); };
  return { S, load, globals, disk };
}
const setZone = (zones, n, extra) => zones.map((z) => (z.number === n ? { ...z, ...extra } : z));
const at = (zones, n) => zones.find((z) => z.number === n);
const finish = async (f, q, k) => { try { await f.flushBeforeFinish(q, k); return "OK"; } catch (e) { return `BLOCKED(${e.code || "-"}): ${e.message}`; } };
// What ZoneStage/ClosingScreen send: the whole list or system with one change over it.
const markDone = (q, k, n, extra = {}) => q.patch(k, { zones: setZone(q.view(k).zones, n, { status: "working_well", ...extra }) });
const renameOnProperty = (q, n, name) => {
  const pk = "prop:P-1", sys = q.view(pk).system;
  q.patch(pk, { system: { ...sys, zones: setZone(sys.zones, n, { location: name, label: name }) } });
};

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.error("FAIL", name, "—", e.message.split("\n")[0]); }
}

// ── Gap 1 ───────────────────────────────────────────────────────────────────
await test("1. two zones marked done offline + an office rename of a third: the office rename survives", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false;
  markDone(q, k, 4); markDone(q, k, 1);
  S.officeWo((wo) => { at(wo.zones, 2).location = "Side yard (office)"; });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(at(S.wo.zones, 2).location, "Side yard (office)", "the second queued edit put the old zone-2 name back");
  assert.equal(at(S.wo.zones, 4).status, "working_well");
  assert.equal(at(S.wo.zones, 1).status, "working_well");
});

await test("1b. three queued edits: the office rename survives every one of them", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false;
  markDone(q, k, 4); markDone(q, k, 1); markDone(q, k, 5, { notes: "valve box cracked" });
  S.officeWo((wo) => { at(wo.zones, 2).location = "Side yard (office)"; });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(at(S.wo.zones, 2).location, "Side yard (office)");
  assert.equal(at(S.wo.zones, 5).notes, "valve box cracked");
});

await test("1c. two queued property renames + an office shut-off correction: the office's shut-off survives", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false;
  renameOnProperty(q, 4, "Garden beds"); renameOnProperty(q, 1, "Front lawn");
  S.officeProp((p) => { p.system.shutoffLocation = "Crawlspace (office)"; });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(S.prop.system.shutoffLocation, "Crawlspace (office)", "the second queued rename put the old shut-off back");
  assert.equal(at(S.prop.system.zones, 4).label, "Garden beds");
  assert.equal(at(S.prop.system.zones, 1).label, "Front lawn");
});

await test("1d. control: back-to-back online edits on a hydrating server still sync without a conflict", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  markDone(q, k, 3, { issues: [{ id: "iss_a", type: "leak" }] });
  markDone(q, k, 3, { issues: [{ id: "iss_a", type: "leak", notes: "at the valve" }] });
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(at(S.wo.zones, 3).issues[0].notes, "at the valve");
});

// ── Gap 2 ───────────────────────────────────────────────────────────────────
await test("2. a draft on a zone the OFFICE removed does not block Finish, and its text is kept for the office", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  q.draft(k, "zone:3", { label: "Z3", notes: "valve box cracked", types: [], repairs: false });
  S.officeWo((wo) => { wo.zones = wo.zones.filter((z) => z.number !== 3); });
  const f2 = load(); const { queue: q2, key: k2 } = await f2.openFieldWorkOrder("WO-1"); // reopened: the office's list arrives
  assert.equal(q2.status(k2).drafts, 0, "a draft for a zone that is no longer on the visit still counts as unrecorded work");
  assert.equal(await finish(f2, q2, k2), "OK");
  assert.match(S.wo.techNotes, /Zone 3/, "the office is not told what the tech had typed");
  assert.match(S.wo.techNotes, /valve box cracked/);
  assert.equal(q2.getDraft(k2, "zone:3"), null, "the stale draft is left behind to be noted again");
  assert.equal(await finish(f2, q2, k2), "OK");
  assert.equal(S.wo.techNotes.match(/valve box cracked/g).length, 1, "a second Finish repeated the note");
});

await test("2b. control: a draft on a zone still on the visit keeps blocking; one written with no zone list too", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  q.draft(k, "zone:2", { notes: "half typed" });
  S.officeWo((wo) => { at(wo.zones, 4).location = "office"; });
  assert.match(await finish(f, q, k), /zone drafts/);
  q.clearDraft(k, "zone:2");
  q.draft(k, "zone:9", { notes: "a zone this phone never saw" }); // test-field-client's case: no stamp, still blocks
  assert.match(await finish(f, q, k), /zone drafts/);
});

console.log(`field-merge-gaps: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

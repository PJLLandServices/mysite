#!/usr/bin/env node
// scripts/test-field-conflicts.mjs
//
// The tech can always finish when the office edits the same job
// (fall-closing fix #6). Rebuilt from the pressure test's queue harness.
//
// The outbox treated the whole `zones` array — and the whole property
// `system` object — as ONE field. So a tech marking Zone 2 done with no
// signal, while the office renamed Zone 4 from the desk, came back as
// "The office changed zones…" with no way forward: force-quit didn't help
// and the zone change never reached the server. The app caused it too:
// "Add a zone" PATCHed the property directly, skipping the queue, and the
// tech's own queued zone rename then conflicted. And a draft left on a
// zone that was then removed blocked sign-off forever.
//
// Runs the REAL pjl-field/src/offline/queue.mjs and field.js against a fake
// server (vm, no network, no customer data). Every scenario must end with
// the job finishable and no edit lost.
//
// Run: node scripts/test-field-conflicts.mjs   (also in build:check)

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createQueue } from "../pjl-field/src/offline/queue.mjs";

const src = fs.readFileSync("pjl-field/src/offline/field.js", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/\bexport /g, "");
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
let T = 0;
const tick = () => new Date(Date.UTC(2026, 9, 1, 12, 0, T++)).toISOString();
// The server's zone hydration: default fields and issue ids are added.
const hydrateZone = (z) => ({
  number: z.number || 0, kind: "zone", location: z.location || z.label || "", sprinklerTypes: z.sprinklerTypes || [],
  coverage: z.coverage || [], status: z.status || "", notes: z.notes || "", checks: { heads: false, leaks: false, ...(z.checks || {}) },
  issues: (z.issues || []).map((i) => ({ id: i.id || "iss_srv", type: i.type, subtype: i.subtype || "", qty: i.qty || 1, notes: i.notes || "" }))
});

function world() {
  const disk = new Map();
  const S = { online: true };
  S.prop = { id: "P-1", updatedAt: tick(), system: { controllerLocation: "Garage", zones: [1, 2, 3, 4, 5].map((n) => ({ number: n, location: "Z" + n, label: "Z" + n })) } };
  S.wo = { id: "WO-1", type: "fall_closing", status: "scheduled", propertyId: "P-1", updatedAt: tick(), photos: [], customerNotes: "",
    zones: [1, 2, 3, 4, 5].map((n) => hydrateZone({ number: n, location: "Z" + n })) };
  const writeLocal = (k, v) => disk.set(k, JSON.stringify(v));
  const readLocal = (k) => (disk.has(k) ? JSON.parse(disk.get(k)) : null);
  const storeForOwner = (o) => ({ read: () => readLocal(o + ":queue"), write: (v) => writeLocal(o + ":queue", v),
    putBlob: (k, v) => writeLocal(o + k, v), getBlob: (k) => readLocal(o + k), deleteBlob: (k) => disk.delete(o + k) });
  const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
  const fetch = async (url, o = {}) => {
    if (!S.online) throw new TypeError("Network request failed");
    const p = new URL(url).pathname, m = o.method || "GET";
    if (p === "/api/session") return reply(200, { ok: true, authenticated: true, role: "admin", user: { id: "patrick" }, fieldOffline: { photoRetry: 1 } });
    if (p === "/api/work-orders/WO-1") {
      if (m !== "PATCH") return reply(200, { ok: true, workOrder: clone(S.wo), property: clone(S.prop), lead: null });
      const body = JSON.parse(o.body), im = o.headers["if-match"];
      if (S.fail409Once) { S.fail409Once = false; return reply(409, { ok: false, error: "version_conflict", errors: ["updated by someone else"] }); }
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
    throw new Error("unexpected " + p);
  };
  const load = () => vm.runInNewContext(src + "\n({ openFieldWorkOrder, flushBeforeFinish, resolveFieldConflicts, fieldStatus });",
    { createQueue, readLocal, writeLocal, storeForOwner, HOST: "https://x.local", AuthRequiredError: class AuthRequiredError extends Error {},
      fetch, AbortController, setTimeout, clearTimeout, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } });
  // The office, at the desk, straight to the server.
  S.officeWo = (patch) => { Object.assign(S.wo, patch); if (patch.zones) S.wo.zones = patch.zones.map(hydrateZone); S.wo.updatedAt = tick(); };
  S.officeProp = (sys) => { S.prop.system = { ...S.prop.system, ...sys }; S.prop.updatedAt = tick(); };
  return { S, load };
}
const setZone = (zones, n, extra) => zones.map((z) => (z.number === n ? { ...z, ...extra } : z));
const finish = async (f, q, k) => { try { await f.flushBeforeFinish(q, k); return "OK"; } catch (e) { return `BLOCKED(${e.code || "-"}): ${e.message}`; } };

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.error("FAIL", name, "—", e.message); }
}

await test("office renames a DIFFERENT zone while the tech marks one done offline", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false; q.patch(k, { zones: setZone(q.view(k).zones, 2, { status: "working_well" }) }); await q.flush();
  S.officeWo({ zones: S.wo.zones.map((z) => (z.number === 4 ? { ...z, location: "Office rename" } : z)) });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(S.wo.zones[1].status, "working_well", "the tech's zone 2 reached the server");
  assert.equal(S.wo.zones[3].location, "Office rename", "the office's zone 4 survived");
});

await test("…and after a force-quit and relaunch too", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false; q.patch(k, { zones: setZone(q.view(k).zones, 2, { status: "working_well" }) });
  S.officeWo({ zones: S.wo.zones.map((z) => (z.number === 4 ? { ...z, location: "Office rename" } : z)) });
  S.online = true;
  const f2 = load(); const { queue: q2, key: k2 } = await f2.openFieldWorkOrder("WO-1");
  assert.equal(await finish(f2, q2, k2), "OK");
  assert.equal(S.wo.zones[1].status, "working_well"); assert.equal(S.wo.zones[3].location, "Office rename");
});

await test("office edits the property's controller while a zone rename is queued (system object)", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false; const pk = "prop:P-1";
  q.patch(pk, { system: { ...q.view(pk).system, zones: setZone(q.view(pk).system.zones, 3, { location: "Back hedge", label: "Back hedge" }) } });
  S.officeProp({ controllerLocation: "Basement" });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(S.prop.system.controllerLocation, "Basement", "the office's controller location survived");
  assert.equal(S.prop.system.zones[2].location, "Back hedge", "the tech's rename reached the property");
});

await test("add a zone (through the queue) with a zone rename already queued", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false; const pk = "prop:P-1";
  q.patch(pk, { system: { ...q.view(pk).system, zones: setZone(q.view(pk).system.zones, 3, { location: "Back hedge" }) } });
  // ZoneStage.addZone → saveSystem → queue.patch(prop) …
  const sys = q.view(pk).system;
  q.patch(pk, { system: { ...sys, zones: [...sys.zones, { number: 6, location: "", label: "", notes: "", pendingReview: true }] } });
  q.patch(k, { zones: [...q.view(k).zones, hydrateZone({ number: 6 })] });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.equal(S.prop.system.zones[2].location, "Back hedge");
  assert.ok(S.prop.system.zones.some((z) => z.number === 6), "the new zone reached the property");
  assert.equal(S.wo.zones.length, 6);
});

await test("a zone added or removed straight on the server no longer conflicts with a queued rename", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  S.online = false; const pk = "prop:P-1";
  q.patch(pk, { system: { ...q.view(pk).system, zones: setZone(q.view(pk).system.zones, 3, { location: "Back hedge" }) } });
  S.officeProp({ zones: [...S.prop.system.zones.filter((z) => z.number !== 5), { number: 6, location: "" }] });
  S.online = true;
  assert.equal(await finish(f, q, k), "OK");
  assert.deepEqual(S.prop.system.zones.map((z) => z.number), [1, 2, 3, 4, 6], "the server's add and remove both stand");
  assert.equal(S.prop.system.zones[2].location, "Back hedge");
});

await test("a draft on a zone that is then removed does not block sign-off", async () => {
  const { load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  let zs = q.view(k).zones; for (const n of [1, 2, 3, 4, 5]) zs = setZone(zs, n, { status: "working_well" });
  q.patch(k, { zones: zs });
  q.draft(k, "zone:3", { label: "Z3", notes: "cant find it", types: [], repairs: false });
  q.patch(k, { zones: q.view(k).zones.filter((z) => z.number !== 3) });
  assert.equal(await finish(f, q, k), "OK");
});

await test("a draft on a zone still on the visit DOES still block (unchanged)", async () => {
  const { load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  q.draft(k, "zone:2", { notes: "half typed" });
  assert.match(await finish(f, q, k), /zone drafts/);
});

for (const [prefer, want] of [["mine", "tech notes"], ["theirs", "office notes"]]) {
  await test(`a TRUE conflict is the tech's call — "${prefer === "mine" ? "Keep mine" : "Use office's"}"`, async () => {
    const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
    S.online = false;
    q.patch(k, { zones: setZone(setZone(q.view(k).zones, 2, { notes: "tech notes" }), 1, { status: "working_well" }) });
    S.officeWo({ zones: S.wo.zones.map((z) => (z.number === 2 ? { ...z, notes: "office notes" } : z.number === 5 ? { ...z, location: "Office 5" } : z)) });
    S.online = true;
    const blocked = await finish(f, q, k);
    assert.match(blocked, /^BLOCKED\(conflict\)/, "the same field changed both ways is still a conflict");
    assert.match(blocked, /zone 2/, "…and it names the zone");
    assert.equal(f.fieldStatus(q, k).error.code, "conflict");
    await f.resolveFieldConflicts(q, k, prefer);
    assert.equal(await finish(f, q, k), "OK", "after choosing, the job is finishable");
    assert.equal(S.wo.zones[1].notes, want);
    assert.equal(S.wo.zones[0].status, "working_well", "the tech's uncontested zone 1 edit survived");
    assert.equal(S.wo.zones[4].location, "Office 5", "the office's uncontested zone 5 edit survived");
  });
}

await test("the app routes Add a zone through the queue and offers the choice", () => {
  const zone = fs.readFileSync("pjl-field/src/screens/closing/ZoneStage.js", "utf8");
  const closing = fs.readFileSync("pjl-field/src/screens/ClosingScreen.js", "utf8");
  assert.ok(!/\bpatchProperty\b|\bgetProperty\b/.test(zone), "ZoneStage no longer PATCHes the property directly");
  assert.match(zone, /const recorded = await saveSystem\(\{\s*zones: \[\.\.\.propZones, \{ number: nextNumber/);
  assert.match(zone, /clearDraft\(`zone:\$\{number\}`\);/, "removing a zone clears its draft");
  assert.match(closing, /Keep mine/); assert.match(closing, /Use office's/);
  assert.match(closing, /resolveFieldConflicts\(queue, key, prefer\)/);
});

await test("a 409 version_conflict from a raced save retries on its own (round 2)", async () => {
  const { S, load } = world(); const f = load(); const { queue: q, key: k } = await f.openFieldWorkOrder("WO-1");
  q.patch(k, { zones: setZone(q.view(k).zones, 2, { status: "working_well" }) });
  S.fail409Once = true;                 // the server's in-lock If-Match refuses the first try
  await q.flush();
  assert.equal(q.status(k).error?.code, "version_conflict");
  await q.flush();                      // the next background pass, NOT a manual retry
  assert.equal(q.status(k).pending, 0, "the edit synced without the tech doing anything");
  assert.equal(S.wo.zones[1].status, "working_well");
});

await test("the changed app files parse with the app's own Babel", async () => {
  const { createRequire } = await import("node:module");
  const requireFromApp = createRequire(new URL("../pjl-field/package.json", import.meta.url));
  let babel;
  try { babel = requireFromApp("@babel/core"); } catch { assert.fail("the app dependencies are not installed — run npm ci in pjl-field"); }
  for (const rel of ["pjl-field/src/screens/ClosingScreen.js", "pjl-field/src/screens/closing/ZoneStage.js", "pjl-field/src/offline/field.js", "pjl-field/src/offline/queue.mjs"]) {
    babel.parse(fs.readFileSync(rel, "utf8"), { filename: rel, parserOpts: { sourceType: "module", plugins: ["jsx"] }, babelrc: false, configFile: false });
  }
});

console.log(`field-conflicts: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

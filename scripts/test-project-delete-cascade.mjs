#!/usr/bin/env node
// scripts/test-project-delete-cascade.mjs
//
// DELETE /api/projects/:id — the "is this a test?" cascade gate.
//
// Deleting a project used to just remove the project record and detach
// its material lists — attached work orders were left behind pointing at
// a project id that no longer existed. Patrick's fix: ask whether the
// project is a test before deleting. Real answer (or the default,
// cascade omitted) keeps the old safe behaviour (material lists detached,
// work orders untouched). A "yes, it's a test" answer (cascade: true)
// wipes the project AND its attached work orders AND its attached
// material lists — a genuine test project should leave nothing behind.
//
// This pins:
//   1. cascade: false (or omitted) — unchanged behaviour: project gone,
//      material lists survive but detached, work orders untouched.
//   2. cascade: true — project gone, material lists gone, work orders
//      gone.
//   3. A bystander project's work orders and material lists are never
//      touched by either path.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-project-delete-cascade.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4810;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "material-lists.json", "work-orders.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

function readJson(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
}
function writeJson(file, records) {
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(records, null, 2) + "\n", "utf8");
}
function recordExists(file, id) {
  return readJson(file).some((r) => r.id === id);
}
function getRecord(file, id) {
  return readJson(file).find((r) => r.id === id) || null;
}

// Minimal work-order shape — the route only needs the id to exist and be
// removable; the workOrders lib doesn't validate shape on remove().
function seedWorkOrder(id, note) {
  const records = readJson("work-orders.json");
  records.push({
    id,
    type: "test_probe",
    status: "draft",
    notes: note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson("work-orders.json", records);
}

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "proj-delete-probe@local.test", name: "Project Delete Probe", role: "admin", password: "proj-delete-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "proj-delete-probe@local.test", password: "proj-delete-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("a throwaway admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const materialLists = require(path.join(ROOT, "server", "lib", "material-lists.js"));

  const deleteProject = async (id, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body || {})
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // A bystander project that must survive both scenarios untouched, with
  // its own work order + material list, so an over-eager cascade would be
  // caught red-handed.
  const bystanderProject = await projects.create({ name: "Bystander project — do not touch" });
  const bystanderList = await materialLists.create({ name: "Bystander list", parentType: "project", parentId: bystanderProject.id });
  const bystanderWoId = "wo_bystander_probe";
  seedWorkOrder(bystanderWoId, "bystander");
  writeJson("projects.json", readJson("projects.json").map((r) =>
    r.id === bystanderProject.id ? { ...r, workOrderIds: [bystanderWoId] } : r
  ));

  // ---- 1. cascade: false (real project) — old safe behaviour ----------
  {
    const proj = await projects.create({ name: "Real project — front yard install" });
    const list = await materialLists.create({ name: "Real list", parentType: "project", parentId: proj.id });
    const woId = "wo_real_probe";
    seedWorkOrder(woId, "real");
    writeJson("projects.json", readJson("projects.json").map((r) =>
      r.id === proj.id ? { ...r, workOrderIds: [woId] } : r
    ));

    const res = await deleteProject(proj.id, { cascade: false });
    ok("a non-cascade delete succeeds", res.status === 200 && res.data.ok, `${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
    ok("…the project record is gone", !recordExists("projects.json", proj.id));
    ok("…the material list SURVIVES", recordExists("material-lists.json", list.id));
    ok("…and is detached (no dangling parent badge)", (() => {
      const rec = getRecord("material-lists.json", list.id);
      return rec && rec.parentType == null && rec.parentId == null;
    })());
    ok("…the work order is left untouched", recordExists("work-orders.json", woId));
  }

  // ---- 2. cascade: true (test project) — full wipe ---------------------
  {
    const proj = await projects.create({ name: "Test sprinkler system — DO NOT BILL" });
    const list = await materialLists.create({ name: "Test list", parentType: "project", parentId: proj.id });
    const woId = "wo_test_probe";
    seedWorkOrder(woId, "test");
    writeJson("projects.json", readJson("projects.json").map((r) =>
      r.id === proj.id ? { ...r, workOrderIds: [woId] } : r
    ));

    const res = await deleteProject(proj.id, { cascade: true });
    ok("a cascade delete succeeds", res.status === 200 && res.data.ok && res.data.cascade === true, `${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
    ok("…the project record is gone", !recordExists("projects.json", proj.id));
    ok("…the material list is ALSO gone", !recordExists("material-lists.json", list.id));
    ok("…the work order is ALSO gone", !recordExists("work-orders.json", woId));
  }

  // ---- 3. the bystander never moved -------------------------------------
  ok("bystander project untouched", recordExists("projects.json", bystanderProject.id));
  ok("bystander material list untouched and still attached", (() => {
    const rec = getRecord("material-lists.json", bystanderList.id);
    return rec && rec.parentType === "project" && rec.parentId === bystanderProject.id;
  })());
  ok("bystander work order untouched", recordExists("work-orders.json", bystanderWoId));

  // ---- 4. omitting cascade entirely behaves like false ------------------
  {
    const proj = await projects.create({ name: "Real project — no cascade field sent" });
    const list = await materialLists.create({ name: "Real list 2", parentType: "project", parentId: proj.id });
    const res = await deleteProject(proj.id, {});
    ok("omitted cascade defaults to the safe path", res.status === 200 && res.data.ok && res.data.cascade === false);
    ok("…material list survives, just detached", recordExists("material-lists.json", list.id));
  }
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-project-delete-cascade: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-project-delete-cascade: ${pass} assertions passed`);

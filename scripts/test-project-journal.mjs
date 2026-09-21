#!/usr/bin/env node
// scripts/test-project-journal.mjs
//
// Job journal (2026-09-21) — a free-form, chronological log tied to the
// job itself. Patrick: "we currently have it being delivered as Work
// Orderz" (the per-visit dailyLog on build WOs) — he wants a genuinely
// new, separate journal instead: a note any time, optionally with
// photos, that reads as the job's own story rather than being scattered
// across however many work orders it took to build it.
//
// This pins:
//   1. A note is required — an empty/whitespace-only POST is refused
//      (422), nothing written.
//   2. A real entry is created and shows up on GET /api/projects/:id.
//   3. Photo upload reuses the SAME pipeline WO photos use (real
//      magic-byte-verified PNG bytes, compression, on-disk storage under
//      project-journal-photos/<projectId>/<entryId>/) — attaches to the
//      right entry, serves back byte-identical-in-spirit (same format),
//      and a second upload continues the `n` numbering instead of
//      colliding.
//   4. Deleting one photo removes its metadata AND its file from disk —
//      the route then 404s on that photo — while leaving the entry and
//      its other photos alone.
//   5. Deleting the whole entry removes it from journalEntries AND wipes
//      its entire photo directory from disk.
//   6. A bystander project's journal is never touched by any of the
//      above.
//   7. A nonexistent project 404s cleanly on every journal route.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-project-journal.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4815;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const JOURNAL_PHOTOS_DIR = path.join(DATA, "project-journal-photos");
const journalPhotosDirExistedBefore = fs.existsSync(JOURNAL_PHOTOS_DIR);

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
  await users.create({ email: "journal-probe@local.test", name: "Journal Probe", role: "admin", password: "journal-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "journal-probe@local.test", password: "journal-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const sharp = require("sharp");

  // A real, magic-byte-valid PNG — the route verifies file signatures
  // server-side, so a fake base64 string would be refused before it ever
  // reached the journal logic under test.
  const pngBuffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const pngBase64 = pngBuffer.toString("base64");

  const api = async (method, urlPath, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const getProjectApi = (id) => api("GET", `/api/projects/${encodeURIComponent(id)}`);

  // ---- setup: two projects, so cross-contamination is catchable -------
  const proj = await projects.create({ name: "Journal probe — main" });
  const bystander = await projects.create({ name: "Journal probe — bystander" });

  // ---- 1. empty note refused --------------------------------------------
  {
    const res = await api("POST", `/api/projects/${proj.id}/journal`, { note: "   " });
    ok("empty note is refused (422)", res.status === 422, `${res.status} ${JSON.stringify(res.data)}`);
    const fresh = await getProjectApi(proj.id);
    ok("…nothing was written", (fresh.data.project.journalEntries || []).length === 0);
  }

  // ---- 2. a real entry is created ---------------------------------------
  let entryId;
  {
    const res = await api("POST", `/api/projects/${proj.id}/journal`, { note: "Roughed in mainline to the front bed today." });
    ok("entry created", res.status === 201 && res.data.ok && res.data.entry?.id, JSON.stringify(res.data));
    entryId = res.data.entry.id;
    ok("…note stored correctly", res.data.entry.note === "Roughed in mainline to the front bed today.");
    ok("…timestamp + author stamped", Boolean(res.data.entry.ts) && Boolean(res.data.entry.by));

    const fresh = await getProjectApi(proj.id);
    const entries = fresh.data.project.journalEntries || [];
    ok("…shows up on GET /api/projects/:id", entries.length === 1 && entries[0].id === entryId);
  }

  // ---- 3. photo upload — real pipeline, real files -----------------------
  {
    const res = await api("POST", `/api/projects/${proj.id}/journal/${entryId}/photos`, {
      photos: [{ data: pngBase64, mediaType: "image/png", label: "mainline-trench.png" }]
    });
    ok("photo upload succeeds", res.status === 201 && res.data.ok && res.data.added?.length === 1, JSON.stringify(res.data).slice(0, 200));
    const p1 = res.data.added[0];
    ok("…numbered starting at 1", p1.n === 1);
    ok("…kind is image", p1.kind === "image");
    ok("…a real file landed on disk", fs.existsSync(path.join(JOURNAL_PHOTOS_DIR, proj.id, entryId, `1.${p1.filename.split(".").pop()}`)) || fs.readdirSync(path.join(JOURNAL_PHOTOS_DIR, proj.id, entryId)).length === 1);

    const serveRes = await fetch(`http://127.0.0.1:${PORT}/api/projects/${proj.id}/journal/${entryId}/photo/1`, { headers: { cookie } });
    ok("…serves back with 200 and an image content-type", serveRes.ok && (serveRes.headers.get("content-type") || "").startsWith("image/"));

    // A second upload continues the n sequence rather than colliding.
    const res2 = await api("POST", `/api/projects/${proj.id}/journal/${entryId}/photos`, {
      photos: [{ data: pngBase64, mediaType: "image/png", label: "mainline-trench-2.png" }]
    });
    ok("second upload continues numbering at 2", res2.status === 201 && res2.data.added?.[0]?.n === 2, JSON.stringify(res2.data));

    const fresh = await getProjectApi(proj.id);
    const entry = (fresh.data.project.journalEntries || []).find((e) => e.id === entryId);
    ok("…entry now carries both photos", entry?.photos?.length === 2);
  }

  // ---- 4. deleting one photo removes metadata AND the file --------------
  {
    const res = await api("DELETE", `/api/projects/${proj.id}/journal/${entryId}/photos/1`);
    ok("photo delete succeeds", res.status === 200 && res.data.ok && res.data.deletedN === 1);
    const serveRes = await fetch(`http://127.0.0.1:${PORT}/api/projects/${proj.id}/journal/${entryId}/photo/1`, { headers: { cookie } });
    ok("…now 404s", serveRes.status === 404);
    const stillThere = await fetch(`http://127.0.0.1:${PORT}/api/projects/${proj.id}/journal/${entryId}/photo/2`, { headers: { cookie } });
    ok("…photo 2 is untouched", stillThere.ok);
    const fresh = await getProjectApi(proj.id);
    const entry = (fresh.data.project.journalEntries || []).find((e) => e.id === entryId);
    ok("…entry now carries just the one remaining photo", entry?.photos?.length === 1 && entry.photos[0].n === 2);
  }

  // ---- 5. deleting the entry wipes it AND its photo directory -----------
  {
    const dirBefore = fs.existsSync(path.join(JOURNAL_PHOTOS_DIR, proj.id, entryId));
    ok("setup: entry photo dir exists before delete", dirBefore);
    const res = await api("DELETE", `/api/projects/${proj.id}/journal/${entryId}`);
    ok("entry delete succeeds", res.status === 200 && res.data.ok);
    const fresh = await getProjectApi(proj.id);
    ok("…gone from journalEntries", (fresh.data.project.journalEntries || []).length === 0);
    ok("…its photo directory is gone from disk", !fs.existsSync(path.join(JOURNAL_PHOTOS_DIR, proj.id, entryId)));
  }

  // ---- 6. bystander project never touched --------------------------------
  {
    const fresh = await getProjectApi(bystander.id);
    ok("bystander project's journal is still empty", (fresh.data.project.journalEntries || []).length === 0);
  }

  // ---- 7. nonexistent project 404s cleanly -------------------------------
  {
    const res = await api("POST", `/api/projects/PROJ-DOES-NOT-EXIST/journal`, { note: "test" });
    ok("nonexistent project 404s on create", res.status === 404, `${res.status} ${JSON.stringify(res.data)}`);
  }

  // ---- 8. deleting the PROJECT itself cleans up its journal photos ------
  // Real gap this closes: entries live inside the project record, but
  // their photo FILES are separate disk objects — a project delete used
  // to have no idea they existed, leaking them forever.
  {
    const p2 = await projects.create({ name: "Journal probe — delete-cleanup" });
    const entryRes = await api("POST", `/api/projects/${p2.id}/journal`, { note: "Site visit before work starts." });
    const eid = entryRes.data.entry.id;
    await api("POST", `/api/projects/${p2.id}/journal/${eid}/photos`, {
      photos: [{ data: pngBase64, mediaType: "image/png", label: "before.png" }]
    });
    const dirBefore = fs.existsSync(path.join(JOURNAL_PHOTOS_DIR, p2.id, eid));
    ok("setup: photo dir exists before project delete", dirBefore);

    const delRes = await api("DELETE", `/api/projects/${p2.id}`, {});
    ok("project delete succeeds", delRes.status === 200 && delRes.data.ok);
    ok("…its entire journal-photos directory is gone from disk", !fs.existsSync(path.join(JOURNAL_PHOTOS_DIR, p2.id)));
  }
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
  // Clean up the photo directory tree this run created — it has no
  // JSON-backup equivalent since it's raw files, not a data/*.json store.
  if (!journalPhotosDirExistedBefore) {
    fs.rmSync(JOURNAL_PHOTOS_DIR, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(`\n✗ test-project-journal: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-project-journal: ${pass} assertions passed`);

#!/usr/bin/env node
// scripts/test-convert-to-project-links-systembuilder.mjs
//
// POST /api/quotes/:id/convert-to-project — don't spin up a duplicate
// project for a quote that was built FROM a project's System Builder
// design.
//
// Patrick, live: he started a Project, used System Builder to design its
// system (which writes project.systemDesign.linkedQuoteId = the quote it
// generated), sent that quote, got it accepted — then "Convert to
// project" offered to create a brand-new project for a job that already
// had one. convert-to-project only ever checked for an existing project
// with sourceQuoteId === the quote just accepted, a field nothing sets
// until conversion — so the System-Builder-originated link was never
// consulted and every one of these quotes would have minted a duplicate,
// orphaned project.
//
// Fixed: before creating anything, walk the quote's revision chain
// (a sent revision is a NEW quote id — the project's pointer still names
// whichever ancestor System Builder generated) looking for a project
// that already claims one of those ids via systemDesign.linkedQuoteId
// and hasn't been converted yet. Found → enrich that project in place
// (projects.enrichFromProposal). Not found → old behavior, unchanged.
//
// This pins:
//   1. Direct link (no revision) — converts INTO the existing project,
//      no new project created, sourceQuoteId set, material lists
//      re-parented, linkedExistingProject: true, HTTP 200.
//   2. Revision chain — the accepted quote is a revision of the one
//      System Builder originally linked; still finds and links the
//      SAME project by walking revisionOf.
//   3. A quote with no System-Builder-linked project anywhere still
//      creates a brand-new project — old behavior is unchanged for the
//      common case (manually-created quotes).
//   4. A project whose systemDesign.linkedQuoteId matches but who's
//      ALREADY been converted (sourceQuoteId already set, e.g. from an
//      earlier, unrelated quote) is not reused — a new project is
//      created instead, so an already-claimed job is never silently
//      double-booked.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-convert-to-project-links-systembuilder.mjs
//      (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4811;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "quotes.json", "material-lists.json", "users.json"];
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
function patchProject(id, patch) {
  writeJson("projects.json", readJson("projects.json").map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
  await users.create({ email: "convert-probe@local.test", name: "Convert Probe", role: "admin", password: "convert-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "convert-probe@local.test", password: "convert-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("a throwaway admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
  const materialLists = require(path.join(ROOT, "server", "lib", "material-lists.js"));

  const convert = async (quoteId) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/quotes/${encodeURIComponent(quoteId)}/convert-to-project`, {
      method: "POST",
      headers: { cookie }
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const makeProposal = async (overrides = {}) => quotes.create({
    type: "project_proposal",
    customerEmail: "systembuilder-probe@example.com",
    lineItems: [{ id: "li_1", label: "Mainline install", qty: 1, unitPrice: 249900 }],
    subtotal: 249900,
    hst: 32487,
    total: 282387,
    ...overrides
  });

  // ---- 1. Direct link — no revision --------------------------------
  {
    const quote = await makeProposal();
    const proj = await projects.create({ name: "Front yard system — direct link probe" });
    patchProject(proj.id, { systemDesign: { linkedQuoteId: quote.id } });
    const list = await materialLists.create({ name: "Direct-link list", parentType: "quote", parentId: quote.id });

    const before = (await projects.list({ includeArchived: true })).length;
    const res = await convert(quote.id);
    const after = (await projects.list({ includeArchived: true })).length;

    ok("converts with 200 (linked, not created)", res.status === 200, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    ok("…linkedExistingProject: true", res.data.linkedExistingProject === true);
    ok("…returns the SAME project, not a new one", res.data.project?.id === proj.id, `got ${res.data.project?.id}`);
    ok("…no new project record was created", after === before, `before=${before} after=${after}`);
    ok("…the existing project now carries sourceQuoteId", (await projects.get(proj.id)).sourceQuoteId === quote.id);
    ok("…the material list re-parented onto that project", (await materialLists.list({ parentType: "project", parentId: proj.id })).some((r) => r.id === list.id));
  }

  // ---- 2. Revision chain — the accepted quote is a later revision ---
  {
    const original = await makeProposal();
    const proj = await projects.create({ name: "Backyard system — revision-chain probe" });
    patchProject(proj.id, { systemDesign: { linkedQuoteId: original.id } });
    // Simulate a sent revision: a new quote id with revisionOf pointing
    // at the original System-Builder-generated quote.
    const revisionRecords = readJson("quotes.json").map((q) => (q.id === original.id ? { ...q, status: "superseded" } : q));
    writeJson("quotes.json", revisionRecords);
    const revision = await makeProposal({ });
    writeJson("quotes.json", readJson("quotes.json").map((q) => (q.id === revision.id ? { ...q, revisionOf: original.id } : q)));

    const before = (await projects.list({ includeArchived: true })).length;
    const res = await convert(revision.id);
    const after = (await projects.list({ includeArchived: true })).length;

    ok("revision chain still finds the linked project", res.status === 200 && res.data.linkedExistingProject === true, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    ok("…returns the SAME project the ORIGINAL quote was linked to", res.data.project?.id === proj.id, `got ${res.data.project?.id}`);
    ok("…no new project record was created", after === before, `before=${before} after=${after}`);
    ok("…sourceQuoteId is the REVISION that was actually accepted", (await projects.get(proj.id)).sourceQuoteId === revision.id);
  }

  // ---- 3. No linked project anywhere — old behavior unchanged ------
  {
    const quote = await makeProposal();
    const before = (await projects.list({ includeArchived: true })).length;
    const res = await convert(quote.id);
    const after = (await projects.list({ includeArchived: true })).length;

    ok("falls back to creating a new project", res.status === 201 && !res.data.linkedExistingProject, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    ok("…exactly one new project record was created", after === before + 1, `before=${before} after=${after}`);
  }

  // ---- 4. A "linked" project that's already claimed is not reused ---
  {
    const alreadyUsedQuote = await makeProposal();
    const claimedProject = await projects.create({ name: "Already converted — do not reuse", sourceQuoteId: alreadyUsedQuote.id });
    const newQuote = await makeProposal();
    // The claimed project still carries an old linkedQuoteId pointer —
    // stale data that must not steer a DIFFERENT quote onto it.
    patchProject(claimedProject.id, { systemDesign: { linkedQuoteId: newQuote.id } });

    const before = (await projects.list({ includeArchived: true })).length;
    const res = await convert(newQuote.id);
    const after = (await projects.list({ includeArchived: true })).length;

    ok("an already-converted project is skipped, not reused", res.status === 201 && !res.data.linkedExistingProject, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    ok("…a fresh project was created instead", after === before + 1, `before=${before} after=${after}`);
    ok("…the already-claimed project's sourceQuoteId is untouched", (await projects.get(claimedProject.id)).sourceQuoteId === alreadyUsedQuote.id);
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
  console.error(`\n✗ test-convert-to-project-links-systembuilder: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-convert-to-project-links-systembuilder: ${pass} assertions passed`);

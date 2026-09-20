#!/usr/bin/env node
// scripts/test-backfill-proposal-enrichment.mjs
//
// POST /api/admin/projects/backfill-proposal-enrichment — one-time repair
// for projects converted BEFORE convert-to-project opened its enrichment
// up beyond project_proposal quotes (2026-09-20). Those older conversions
// got a bare project with just a name + sourceQuoteId — no tasks, no
// proposalSnapshot. Patrick: "Did it backdate any of the existing
// proposals?" — no, the route fix only changed FUTURE conversions, so
// this backfill exists to catch the old ones up to the same standard.
//
// This pins:
//   1. Dry run (no `confirm`) reports accurate counts and writes NOTHING.
//   2. Apply (`confirm: "BACKFILL PROJECTS"`) enriches every bare
//      converted project — tasks seeded, proposalSnapshot populated —
//      using the exact same enrichFromProposal() a fresh conversion uses.
//   3. A project that's already enriched (has a proposalSnapshot) is left
//      completely alone — not double-processed, not touched.
//   4. A project with NO sourceQuoteId (never converted from a quote at
//      all) is never a candidate — real, ordinary projects are safe.
//   5. A project whose source quote no longer exists is skipped and
//      reported (skippedNoQuote), not a crash.
//   6. Running apply a second time is a no-op — the first run's
//      enrichment makes every candidate ineligible, so nothing changes
//      and nothing errors.
//   7. A non-admin (tech) gets a 403 — this is a bulk write across every
//      project, admin-only same as purge-test-data.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-backfill-proposal-enrichment.mjs
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
const PORT = 4813;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "quotes.json", "users.json"];
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
function getProject(id) {
  return readJson("projects.json").find((r) => r.id === id) || null;
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
  await users.create({ email: "backfill-probe-admin@local.test", name: "Backfill Probe Admin", role: "admin", password: "backfill-probe-12345" });
  await users.create({ email: "backfill-probe-tech@local.test", name: "Backfill Probe Tech", role: "tech", password: "backfill-probe-12345" });

  const loginAs = async (email) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "backfill-probe-12345" })
    });
    const cookie = (r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""])
      .map((c) => String(c).split(";")[0])
      .find((c) => c.startsWith("pjl_crm_session=")) || "";
    return { ok: r.ok, cookie };
  };

  const adminLogin = await loginAs("backfill-probe-admin@local.test");
  ok("admin can log in", adminLogin.ok && Boolean(adminLogin.cookie));
  const techLogin = await loginAs("backfill-probe-tech@local.test");
  ok("tech can log in", techLogin.ok && Boolean(techLogin.cookie));

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));

  const backfill = async (cookie, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/projects/backfill-proposal-enrichment`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body || {})
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // ---- setup: a mix of project shapes -----------------------------------

  // A bare pre-fix conversion (what the OLD convert-to-project produced).
  const repairQuote = await quotes.create({
    type: "on_site_quote",
    customerEmail: "backfill-repair-probe@example.com",
    lineItems: [
      { id: "li_1", label: "Replace cracked valve, zone 2", qty: 1, unitPrice: 18500 },
      { id: "li_2", label: "Repair mainline leak", qty: 1, unitPrice: 32000 }
    ],
    subtotal: 50500, hst: 6565, total: 57065
  });
  await quotes.accept(repairQuote.id, { by: "customer" });
  const bareProject = await projects.create({ name: "Pre-fix bare conversion", sourceQuoteId: repairQuote.id });
  ok("setup: bare project has no proposalSnapshot yet", !bareProject.proposalSnapshot);

  // An already-enriched project (post-fix conversion) — must not be re-touched.
  const alreadyProject = await projects.create({ name: "Already enriched", sourceQuoteId: "Q-FAKE-ALREADY" });
  const alreadySnapshot = { quoteId: "Q-FAKE-ALREADY", total: 999, frozenAt: new Date().toISOString() };
  writeJson("projects.json", readJson("projects.json").map((r) =>
    r.id === alreadyProject.id ? { ...r, proposalSnapshot: alreadySnapshot, tasks: [{ id: "task_existing", description: "pre-existing", status: "done" }] } : r
  ));

  // An ordinary project never converted from a quote at all.
  const ordinaryProject = await projects.create({ name: "Ordinary hand-created project" });

  // A bare conversion whose source quote has since been deleted.
  const orphanProject = await projects.create({ name: "Orphaned conversion", sourceQuoteId: "Q-DOES-NOT-EXIST" });

  // ---- 1. Non-admin is refused -------------------------------------------
  {
    const res = await backfill(techLogin.cookie, {});
    ok("a tech gets 403", res.status === 403, `${res.status} ${JSON.stringify(res.data)}`);
  }

  // ---- 2. Dry run — accurate counts, nothing written ---------------------
  {
    const res = await backfill(adminLogin.cookie, {});
    ok("dry run succeeds", res.status === 200 && res.data.ok && res.data.dryRun === true);
    ok("…counts the two bare candidates (repair + orphan)", res.data.counts.total === 2, JSON.stringify(res.data.counts));
    ok("…one will enrich, one is missing its quote", res.data.counts.willEnrich === 1 && res.data.counts.missingQuote === 1, JSON.stringify(res.data.counts));
    ok("…nothing was actually written", getProject(bareProject.id).proposalSnapshot == null);
    ok("…the already-enriched project isn't in the candidate list", !res.data.projects.some((p) => p.projectId === alreadyProject.id));
    ok("…the never-converted project isn't in the candidate list", !res.data.projects.some((p) => p.projectId === ordinaryProject.id));
  }

  // ---- 3. Apply — enriches the real candidate, skips the orphan ---------
  {
    const res = await backfill(adminLogin.cookie, { confirm: "BACKFILL PROJECTS" });
    ok("apply succeeds", res.status === 200 && res.data.ok && res.data.dryRun === false);
    ok("…enriched exactly the bare repair-quote project", res.data.enriched.length === 1 && res.data.enriched[0] === bareProject.id, JSON.stringify(res.data.enriched));
    ok("…skipped the orphan (quote gone)", res.data.skippedNoQuote.length === 1 && res.data.skippedNoQuote[0] === orphanProject.id);

    const enriched = getProject(bareProject.id);
    ok("…project now has tasks seeded from the repair line items", Array.isArray(enriched.tasks) && enriched.tasks.length === 2);
    ok("…task descriptions match", enriched.tasks.map((t) => t.description).join("|") === "Replace cracked valve, zone 2|Repair mainline leak");
    ok("…proposalSnapshot populated with the quote's totals", enriched.proposalSnapshot?.total === 57065 && enriched.proposalSnapshot?.quoteId === repairQuote.id);
    ok("…sourceQuoteId unchanged", enriched.sourceQuoteId === repairQuote.id);

    ok("…the orphan project was left completely untouched", getProject(orphanProject.id).proposalSnapshot == null);
  }

  // ---- 4. Already-enriched and ordinary projects untouched --------------
  {
    const stillAlready = getProject(alreadyProject.id);
    ok("already-enriched project's snapshot is byte-identical (not re-run)", stillAlready.proposalSnapshot.total === 999);
    ok("…its pre-existing DONE task survived (never re-seeded)", stillAlready.tasks.length === 1 && stillAlready.tasks[0].id === "task_existing" && stillAlready.tasks[0].status === "done");

    const stillOrdinary = getProject(ordinaryProject.id);
    ok("ordinary never-converted project has no proposalSnapshot", stillOrdinary.proposalSnapshot == null);
    ok("…and no sourceQuoteId", stillOrdinary.sourceQuoteId == null);
  }

  // ---- 5. Idempotent — a second apply changes nothing --------------------
  {
    const res = await backfill(adminLogin.cookie, { confirm: "BACKFILL PROJECTS" });
    ok("a second apply run succeeds cleanly", res.status === 200 && res.data.ok);
    ok("…enriches nothing new (already-enriched project is ineligible)", res.data.enriched.length === 0, JSON.stringify(res.data.enriched));
    ok("…still skips the orphan the same way", res.data.skippedNoQuote.length === 1 && res.data.skippedNoQuote[0] === orphanProject.id);
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
  console.error(`\n✗ test-backfill-proposal-enrichment: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-backfill-proposal-enrichment: ${pass} assertions passed`);

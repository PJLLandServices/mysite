#!/usr/bin/env node
// scripts/test-project-problems.mjs
//
// A PROBLEM OUTLIVES THE DAY IT WAS FOUND ON, AND "MONITORING" IS NOT
// RESOLVED.
//
// Patrick settled the shape: "The problem should belong to the project,
// with a link to the daily record where it was discovered. Daily
// Records shows: 'This problem was discovered Tuesday during this work
// session.' Project Overview shows: 'This problem remains open and
// still needs resolution.' Resolving it later doesn't rewrite Tuesday's
// record."
//
// `status` is a LIFECYCLE STATE, so CLAUDE.md applies from day one:
//
//   "Define the rule once, as a named function, and call it from each
//    reader. Two copies of a state test will drift. A cancelled
//    appointment held its calendar slot for exactly this reason."
//
// THE TRAP IS `monitoring`. It is not resolved — it is "we are watching
// it" — so every count of outstanding problems has to include it.
// Written as `status !== "resolved"` in one reader and
// `status === "open"` in another, the two disagree about every
// monitored problem, and the disagreement surfaces as a closeout that
// waves a watched problem through. There is exactly one test,
// problemNeedsAttention(), and this pins both that it is right and that
// nobody has quietly written a second one.
//
// WHAT IS DELIBERATELY NOT COVERED, named rather than left silent
// (CLAUDE.md: "Name the ones you deliberately leave alone — silence is
// how a half-built transition ships"):
//
//   * The Overview tile and the closeout preflight do not read problems
//     yet, because neither screen is built. When they are, they call
//     problemNeedsAttention() — the assertion below that no second
//     status test exists in the tree is what will catch it if they do
//     not.
//   * Problems raised from the field app. The route is staff-gated at
//     "user", so a technician CAN raise one today; the phone UI for it
//     is not in this release.
//
// Run: node scripts/test-project-problems.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4845;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "work-orders.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
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
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* not up yet */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // ── The rule itself, in isolation ──────────────────────────────────
  const problems = require(path.join(ROOT, "server", "lib", "project-problems.js"));
  ok("an open problem needs attention", problems.problemNeedsAttention({ status: "open" }));
  ok("a MONITORING problem still needs attention — it is not resolved",
    problems.problemNeedsAttention({ status: "monitoring" }));
  ok("a resolved problem does not", !problems.problemNeedsAttention({ status: "resolved" }));
  ok("...and neither does nothing at all", !problems.problemNeedsAttention(null));

  // ── ONE rule, not several ──────────────────────────────────────────
  //
  // The structural half. A second copy of the status test anywhere in
  // the server or the app is the drift CLAUDE.md describes, so it is
  // caught here rather than the first time a monitored problem slips
  // through a count.
  {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "app-dist" || e.name === "data") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(js|ts|tsx)$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, "server"));
    walk(path.join(ROOT, "admin-app", "src"));

    // What counts as drift, precisely. NOT every mention of the word
    // "resolved" — the write path legitimately asks `status ===
    // "resolved"` to decide whether to stamp the resolution fields, the
    // form asks it to decide whether to prompt for a note, and a
    // property's DEFERRED ISSUES are a different entity that happens to
    // share the word. None of those can disagree with anything.
    //
    // The drift is in READERS that COUNT or FILTER problems by status,
    // because that is where two answers diverge: one reader says 3
    // outstanding, another says 2, and the monitored one is the
    // difference. So this looks for a problems collection being
    // filtered or counted against a status literal.
    const offenders = [];
    const FILTER_ON_STATUS = /problems?\b[\s\S]{0,160}?\.(filter|some|every|reduce|find)\s*\([\s\S]{0,200}?["'](resolved|monitoring|open)["']/;
    for (const f of files) {
      if (f.endsWith(path.join("lib", "project-problems.js"))) continue;   // the one place
      const src = fs.readFileSync(f, "utf8");
      if (FILTER_ON_STATUS.test(src)) offenders.push(path.relative(ROOT, f));
    }
    ok("no reader counts or filters problems by a raw status",
      offenders.length === 0,
      offenders.join(", "));

    // And the positive half: the read model the screens use really does
    // go through the named rule, rather than having quietly stopped.
    const readModel = fs.readFileSync(path.join(ROOT, "server", "lib", "daily-records.js"), "utf8");
    ok("the daily-records read model counts through problemNeedsAttention()",
      /projectProblems\.activeProblems\(/.test(readModel),
      "expected activeProblems() to supply the outstanding count");
  }

  // ── The workflow, through the API ──────────────────────────────────
  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "office@local.test", name: "Marguerite Sowande", role: "admin", password: "office-probe-12345" });
  await users.create({ email: "crew@local.test", name: "Tobias Vantol", role: "tech", password: "crew-probe-12345" });
  const signIn = async (email, password) => {
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    return (r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""])
      .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  };
  const officeCookie = await signIn("office@local.test", "office-probe-12345");
  const crewCookie = await signIn("crew@local.test", "crew-probe-12345");
  const H = { cookie: officeCookie, "content-type": "application/json" };

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));
  const proj = await projects.create({ name: "Problems — Queensville install", customerName: "Queensville Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  const woTue = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-22" });
  const woThu = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
  await projects.attachWorkOrder(proj.id, woTue.id);
  await projects.attachWorkOrder(proj.id, woThu.id);

  const records = async () =>
    (await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/daily-records`, { headers: { cookie: officeCookie } })).json();

  // ── Raised on Tuesday ──────────────────────────────────────────────
  let probId = null;
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        title: "Rock shelf under the east bed",
        description: "Hit it at about 14 inches. The lateral will need rerouting.",
        discoveredOnWoId: woTue.id, discoveredWorkDate: "2026-09-22"
      })
    });
    ok("a problem can be recorded against the day it was found", r.status === 201, String(r.status));
    probId = (await r.json()).problem?.id;
    ok("...and it belongs to the project, not the work order", Boolean(probId), String(probId));
  }
  {
    const j = await records();
    const tue = j.days.find((d) => d.woId === woTue.id);
    const thu = j.days.find((d) => d.woId === woThu.id);
    ok("it shows under Tuesday", (tue.problemsFound || []).length === 1, JSON.stringify(tue.problemsFound));
    ok("...and not under Thursday", (thu.problemsFound || []).length === 0);
    ok("...naming who found it", tue.problemsFound[0].discovery.reportedBy === "Marguerite Sowande",
      tue.problemsFound[0].discovery.reportedBy);
    ok("the job counts it as outstanding", j.openProblems === 1, String(j.openProblems));
  }

  // ── Monitoring is NOT resolved ─────────────────────────────────────
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/${probId}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ status: "monitoring" })
    });
    ok("a problem can be set to monitoring", r.ok, String(r.status));
    const j = await records();
    ok("a MONITORED problem is STILL counted as outstanding", j.openProblems === 1, String(j.openProblems));
    ok("...and still reads as needing attention", j.problems[0].needsAttention === true);
  }

  // ── Resolving requires an account of how ───────────────────────────
  {
    const bare = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/${probId}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ status: "resolved" })
    });
    const body = await bare.json().catch(() => ({}));
    ok("resolving with no note is refused", bare.status === 422 && body.code === "resolution_note_required",
      `${bare.status} ${body.code}`);
    const j = await records();
    ok("...and the refusal changed nothing", j.openProblems === 1 && j.problems[0].status === "monitoring",
      `${j.openProblems} / ${j.problems[0].status}`);
  }

  // ── Resolving APPENDS — it does not rewrite Tuesday ────────────────
  {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/${probId}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ status: "resolved", note: "Rerouted the lateral around the shelf" })
    });
    ok("resolving with a note is accepted", r.ok, String(r.status));

    const j = await records();
    ok("the job no longer counts it as outstanding", j.openProblems === 0, String(j.openProblems));

    const tue = j.days.find((d) => d.woId === woTue.id);
    // THE assertion Patrick's wording turns on.
    ok("IT STILL SHOWS UNDER TUESDAY, THE DAY IT WAS FOUND",
      (tue.problemsFound || []).length === 1, JSON.stringify(tue.problemsFound));
    ok("...with its discovery untouched",
      tue.problemsFound[0].discovery.onWoId === woTue.id &&
      tue.problemsFound[0].discovery.workDate === "2026-09-22" &&
      tue.problemsFound[0].discovery.reportedBy === "Marguerite Sowande",
      JSON.stringify(tue.problemsFound[0].discovery));
    ok("...showing its CURRENT status, not a hidden row",
      tue.problemsFound[0].status === "resolved");
    ok("...and how it ended, with who and when",
      tue.problemsFound[0].resolution?.note === "Rerouted the lateral around the shelf" &&
      tue.problemsFound[0].resolution?.by === "Marguerite Sowande" &&
      Boolean(tue.problemsFound[0].resolution?.at),
      JSON.stringify(tue.problemsFound[0].resolution));
  }

  // ── Re-opening keeps the history of having been resolved ───────────
  {
    await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/${probId}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ status: "open", note: "Came back after the rain" })
    });
    const p2 = (await projects.get(proj.id)).problems.find((x) => x.id === probId);
    ok("re-opening clears the resolution", p2.status === "open" && p2.resolvedAt === null && p2.resolutionNote === "",
      JSON.stringify({ status: p2.status, resolvedAt: p2.resolvedAt }));
    ok("...but the history keeps every move, including the resolve",
      p2.history.filter((h) => /problem_status|problem_opened/.test(h.action)).length >= 4 &&
      p2.history.some((h) => /→ resolved/.test(h.note || "")),
      JSON.stringify(p2.history.map((h) => h.note)));
    const j = await records();
    ok("...and it counts as outstanding again", j.openProblems === 1, String(j.openProblems));
  }

  // ── Who may record one ─────────────────────────────────────────────
  {
    const anon = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Not signed in" })
    });
    ok("signed out, recording a problem is refused", anon.status >= 400, String(anon.status));

    // A technician standing in front of the problem is exactly who
    // should be able to raise one, and the audit trail names them.
    const crew = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems`, {
      method: "POST", headers: { cookie: crewCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Valve box lid cracked", discoveredOnWoId: woThu.id, discoveredWorkDate: "2026-09-24" })
    });
    ok("a technician CAN record a problem", crew.status === 201, String(crew.status));
    const j = await records();
    const thu = j.days.find((d) => d.woId === woThu.id);
    ok("...attributed to them by name", thu.problemsFound[0]?.discovery.reportedBy === "Tobias Vantol",
      thu.problemsFound[0]?.discovery.reportedBy);
  }

  // ── Rubbish in ─────────────────────────────────────────────────────
  {
    const noTitle = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems`, {
      method: "POST", headers: H, body: JSON.stringify({ description: "no title" })
    });
    ok("a problem with no title is refused", noTitle.status === 422, String(noTitle.status));
    const badStatus = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/${probId}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ status: "sort-of-fixed" })
    });
    ok("an unknown status is refused", badStatus.status === 422, String(badStatus.status));
    const missing = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/problems/prob_nope`, {
      method: "PATCH", headers: H, body: JSON.stringify({ status: "open" })
    });
    ok("an unknown problem is a 404", missing.status === 404, String(missing.status));
  }
} finally {
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\nproject problems: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

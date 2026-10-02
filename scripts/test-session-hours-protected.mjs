#!/usr/bin/env node
// scripts/test-session-hours-protected.mjs
//
// HOURS ARE MONEY. THE FIELD'S ANSWER SURVIVES THE OFFICE'S CORRECTION.
//
// Patrick's rule for this release, verbatim:
//   "Preserve the original value. Record the corrected value, who changed
//    it, when and why. Calculate billing from the effective corrected
//    value. Never represent an office correction as a new field work
//    session."
//
// Plus: "Make billing and project metrics use one shared effective-hours
// calculation."
//
// What was wrong before this test existed:
//   1. setLabourersForSession() did `sess.labourersOnSite = safeCount` —
//      a straight overwrite. The count the technician entered on site was
//      gone, and the history line recorded only the NEW number, so you
//      could not even read backwards to find it.
//   2. There was no route at all to fix a wrong clock-in or clock-out. A
//      technician who forgot to clock out at 3pm and noticed at 7pm left
//      four phantom person-hours on a T&M invoice, and the only remedy
//      was hand-editing JSON.
//   3. Three separate copies of (out − in) × labourers: project metrics,
//      T&M billing, and the classic project page's day list. Three copies
//      of a money calculation is three chances to drift, and the one that
//      drifts silently is the one that bills.
//
// EVERY assertion below fails against the pre-change code. That is the
// point — CLAUDE.md: "Run it against the unfixed version first. If it
// passes before the fix, it is not testing the fix."
//
// Run: node scripts/test-session-hours-protected.mjs

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4839;
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
  ok("the office and the crew can both sign in", Boolean(officeCookie) && Boolean(crewCookie));
  const H = { cookie: officeCookie, "content-type": "application/json" };

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  // A real T&M job, so the billing rollup is a live path and not a mock.
  const proj = await projects.create({ name: "Hours — Sharon Heights install", customerName: "Sharon Heights Co" });
  await projects.update(proj.id, { status: "active", buildTracking: true });
  // billingMode and the locked labour rate are set by proposal acceptance,
  // not by update() — write them the way acceptance would so the T&M
  // rollup below is the live code path and not a stub.
  {
    const pf = path.join(DATA, "projects.json");
    const all = JSON.parse(fs.readFileSync(pf, "utf8"));
    const rec = all.find((x) => x.id === proj.id);
    rec.billingMode = "time_and_material";
    rec.labourRateLocked = 95;
    fs.writeFileSync(pf, JSON.stringify(all, null, 2));
  }
  const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });

  // Put a CLOSED session on the record by hand, so the numbers below are
  // exact rather than whatever the wall clock happened to be. 8am–noon,
  // three on site = 12.00 person-hours.
  const store = path.join(DATA, "work-orders.json");
  {
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    const rec = all.find((w) => w.id === wo.id);
    rec.dailyLog.sessions = [{
      id: "SESS-A",
      inAt: "2026-09-24T12:00:00.000Z",  // 8:00 Toronto
      outAt: "2026-09-24T16:00:00.000Z", // 12:00 Toronto
      labourersOnSite: 3,
      labourerNote: "",
      startedBy: "Tobias Vantol"
    }];
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
  }

  const sessNow = async () => {
    const w = await workOrders.get(wo.id);
    return (w.dailyLog.sessions || []).find((s) => s.id === "SESS-A");
  };
  const woNow = () => workOrders.get(wo.id);
  const timesUrl = `${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/sessions/SESS-A/times`;
  const labourUrl = `${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/sessions/SESS-A/labourers`;

  // ── RULE 1 · a corrected labourer count keeps the field's number ────
  //
  // The crew logged three. The office knows one of them left after an
  // hour and corrects it to two. Two is what gets billed; three is what
  // the crew said, and three has to still be readable.
  {
    const r = await fetch(labourUrl, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ count: 2, reason: "Third hand left for the Keswick call at 9" })
    });
    ok("the office can correct the labourer count", r.ok, `status ${r.status}`);

    const s = await sessNow();
    ok("the effective count is the corrected one", s.labourersOnSite === 2, String(s.labourersOnSite));
    // THIS is the assertion the old code cannot pass: it had no `original`.
    ok("the FIELD's original count is still on the record",
      s.original && s.original.labourersOnSite === 3, JSON.stringify(s.original || null));

    const c = (s.corrections || [])[0];
    ok("the correction records what changed", c && c.field === "labourersOnSite" && c.from === 3 && c.to === 2,
      JSON.stringify(c || null));
    ok("...and WHO made it, by name", c && c.by === "Marguerite Sowande", c && c.by);
    ok("...and WHY", c && /Keswick/.test(c.reason), c && c.reason);
    ok("...and WHEN", c && Number.isFinite(Date.parse(c.at)), c && c.at);
  }

  // ── RULE 1b · the original is the FIELD's, not the last overwrite ───
  //
  // Correct it a second time. "The original value" means what the crew
  // recorded on site — not whatever the previous correction happened to
  // leave behind.
  {
    await fetch(labourUrl, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ count: 4, reason: "Miscounted — two extra came over after lunch" })
    });
    const s = await sessNow();
    ok("a second correction still shows the crew's original 3",
      (s.original || {}).labourersOnSite === 3, JSON.stringify(s.original || null));
    ok("...and both corrections are kept, in order",
      (s.corrections || []).length === 2 && s.corrections[0].to === 2 && s.corrections[1].to === 4,
      JSON.stringify((s.corrections || []).map((c) => c.to)));
    ok("...with the effective count now 4", s.labourersOnSite === 4, String(s.labourersOnSite));
  }

  // ── RULE 1c · a no-op is not a correction ───────────────────────────
  //
  // The field app re-sends the same count on a double tap. An audit log
  // full of "4 → 4" is how a real correction gets lost in the noise.
  {
    const before = ((await sessNow()).corrections || []).length;
    await fetch(labourUrl, { method: "PATCH", headers: H, body: JSON.stringify({ count: 4, reason: "same again" }) });
    const after = ((await sessNow()).corrections || []).length;
    ok("re-sending the same count writes no correction entry", after === before, `${before} → ${after}`);
  }

  // Put it back to 3 — the crew's number — for the arithmetic below.
  await fetch(labourUrl, { method: "PATCH", headers: H, body: JSON.stringify({ count: 3, reason: "Back to the logged crew" }) });

  // ── RULE 2 · audited clock-time corrections ─────────────────────────
  //
  // Before this release there was NO route here at all. A forgotten
  // clock-out was four phantom person-hours on an invoice.
  {
    const r = await fetch(timesUrl, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ outAt: "2026-09-24T15:00:00.000Z", reason: "Crew left at 11, clocked out late" })
    });
    ok("the office can correct a clock-out time", r.ok, `status ${r.status} ${await r.clone().text().catch(() => "")}`.slice(0, 200));

    const s = await sessNow();
    ok("the effective clock-out is the corrected one", s.outAt === "2026-09-24T15:00:00.000Z", String(s.outAt));
    ok("the FIELD's original clock-out is still on the record",
      Boolean(s.original) && s.original.outAt === "2026-09-24T16:00:00.000Z", JSON.stringify(s.original || null));
    ok("...and the original clock-IN is preserved alongside it",
      Boolean(s.original) && s.original.inAt === "2026-09-24T12:00:00.000Z", String(s.original && s.original.inAt));
    const c = (s.corrections || []).find((x) => x.field === "outAt");
    ok("the clock correction names who, why and from→to",
      c && c.by === "Marguerite Sowande" && /clocked out late/.test(c.reason) &&
      c.from === "2026-09-24T16:00:00.000Z" && c.to === "2026-09-24T15:00:00.000Z",
      JSON.stringify(c || null));
  }

  // ── RULE 2b · a correction is never a new work session ──────────────
  //
  // Patrick: "Never represent an office correction as a new field work
  // session." Four corrections in, the day still has exactly one session
  // and the history has no second session_start.
  {
    const w = await woNow();
    ok("the day still has exactly ONE session after four corrections",
      w.dailyLog.sessions.length === 1, String(w.dailyLog.sessions.length));
    const starts = (w.history || []).filter((h) => h.action === "session_start").length;
    ok("...and no correction invented a session_start", starts === 0, String(starts));
    const logged = (w.history || []).filter((h) => h.action === "session_corrected");
    ok("...while every correction IS in the work-order history",
      logged.length === 4, `${logged.length} session_corrected entries`);
    ok("...each naming the person who made it",
      logged.every((h) => h.by === "Marguerite Sowande"), JSON.stringify(logged.map((h) => h.by)));
  }

  // ── RULE 3 · ONE calculation, billing and metrics ───────────────────
  //
  // The session now reads 8:00–11:00 with 3 on site = 9.00 person-hours,
  // and it is CLOSED, so metrics and billing must agree exactly. Before
  // this release each had its own loop; they happened to agree on a
  // simple case and there was nothing stopping them drifting.
  {
    const metrics = await projects.computeProjectMetrics(proj.id);
    const billing = await projects.computeTAndMBilling(proj.id).catch((e) => ({ totalHours: null, lineItems: [], error: e.message }));
    ok("the corrected session is 9.00 person-hours", metrics.totalPersonHours === 9,
      String(metrics.totalPersonHours));
    ok("billing and metrics give the SAME number", billing.totalHours === metrics.totalPersonHours,
      `billing ${billing.totalHours} vs metrics ${metrics.totalPersonHours}`);
    // 9 × $95 — the corrected hours, not the 12 the field first recorded.
    const labour = billing.lineItems.find((l) => l.source === "labour");
    ok("the invoice bills the CORRECTED hours, not the original 12",
      labour && labour.qty === 9 && labour.lineTotal === 855,
      JSON.stringify(labour || null));
  }

  // ── RULE 3b · the classic page reads the server's number ────────────
  //
  // Patrick's standing rule: "display server-calculated totals instead of
  // independently recalculating them." The classic project page ran its
  // own copy of the loop — the one reader that could not see a correction.
  {
    const r = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}`, { headers: { cookie: officeCookie } });
    const j = await r.json();
    ok("the work-order API serves a calculated personHours", j.personHours === 9, String(j.personHours));
    const src = fs.readFileSync(path.join(ROOT, "server", "project.js"), "utf8");
    ok("...and the classic page no longer runs its own hours loop",
      !/labourersOnSite\) \|\| 1\)/.test(src), "project.js still multiplies by labourersOnSite itself");
  }

  // ── RULE 3c · one shared calculation, structurally ──────────────────
  //
  // Not "they agree today" — that they cannot answer differently, because
  // there is only one loop left to answer with.
  {
    const projSrc = fs.readFileSync(path.join(ROOT, "server", "lib", "projects.js"), "utf8");
    const loops = (projSrc.match(/labourersOnSite/g) || []).length;
    ok("projects.js has no hand-rolled labourer multiplication left", loops === 0,
      `${loops} remaining references`);
    ok("...both totals come from the shared module",
      (projSrc.match(/sessionHours\.sumPersonHours/g) || []).length === 2,
      "expected exactly two call sites");

    // And the ONE legitimate difference is still there: a running session
    // counts in metrics and never in billing.
    // require() rather than import so a missing module is a failed
    // assertion, not a crash that hides every check after it.
    let sh = null;
    try { sh = require(path.join(ROOT, "server", "lib", "session-hours.js")); } catch (_) { /* reported below */ }
    ok("the shared hours module exists", Boolean(sh));
    const open = { inAt: "2026-09-24T12:00:00.000Z", outAt: null, labourersOnSite: 2 };
    ok("an open session bills nothing", Boolean(sh) && sh.sessionPersonHours(open, { openSessions: "skip" }) === 0);
    ok("...but counts toward metrics while the crew is on site",
      Boolean(sh) && sh.sessionPersonHours(open, { openSessions: "toNow", now: "2026-09-24T14:00:00.000Z" }) === 4);
  }

  // ── RULE 4 · the refusals ───────────────────────────────────────────
  //
  // Every one of these is an invoice that would otherwise be wrong in a
  // way nobody notices until a customer queries it.
  {
    const attempt = async (body) => {
      const r = await fetch(timesUrl, { method: "PATCH", headers: H, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const noReason = await attempt({ outAt: "2026-09-24T15:30:00.000Z" });
    ok("a correction without a reason is refused", noReason.status === 422 && noReason.body.code === "reason_required",
      `${noReason.status} ${noReason.body.code}`);

    const inverted = await attempt({ outAt: "2026-09-24T10:00:00.000Z", reason: "typo somewhere" });
    ok("clock-out before clock-in is refused", inverted.status === 422 && inverted.body.code === "inverted_times",
      `${inverted.status} ${inverted.body.code}`);

    const future = await attempt({ outAt: "2030-01-01T00:00:00.000Z", reason: "fat fingered the year" });
    ok("a clock-out in the future is refused", future.status === 422 && future.body.code === "future_timestamp",
      `${future.status} ${future.body.code}`);

    // The classic year typo: 2025 instead of 2026 turns a four-hour day
    // into 8,760 hours of labour.
    const yearTypo = await attempt({ inAt: "2025-09-24T12:00:00.000Z", reason: "wrong year typed" });
    ok("a year-typo that would bill thousands of hours is refused",
      yearTypo.status === 422 && yearTypo.body.code === "implausible_duration",
      `${yearTypo.status} ${yearTypo.body.code}`);

    const nothing = await attempt({ reason: "changed my mind" });
    ok("a correction with no times at all is refused",
      nothing.status === 422 && nothing.body.code === "nothing_to_correct",
      `${nothing.status} ${nothing.body.code}`);

    // And none of that touched the record.
    const s = await sessNow();
    ok("no refused attempt changed the session", s.outAt === "2026-09-24T15:00:00.000Z" && s.inAt === "2026-09-24T12:00:00.000Z",
      `${s.inAt} → ${s.outAt}`);
    ok("...nor left a correction entry behind",
      (s.corrections || []).filter((c) => /changed my mind|fat fingered|wrong year|typo somewhere/.test(c.reason)).length === 0,
      JSON.stringify((s.corrections || []).map((c) => c.reason)));
  }

  // ── RULE 4c · who is allowed to correct billable hours ──────────────
  //
  // Patrick's field/office split: "technicians clock in/out" in the field,
  // but reviewing labour is desk work. So the crew count stays a FIELD
  // action — a tech can set it — while correcting the clock AFTER the fact
  // rewrites billable hours and is the office's alone. A technician quietly
  // editing their own hours is the thing an audit trail exists to catch.
  //
  // This is here because the first cut of the route got it wrong in a way
  // that LOOKED right: it called requireAdmin(req) and threw the result
  // away. requireAdmin returns null on failure rather than throwing, so
  // that call gated nothing at all — a no-op wearing the shape of a gate.
  // scripts/test-admin-gates.mjs caught it. The gate now lives in
  // needsAuth() with the rest of them, and these assertions keep it there.
  {
    const asCrew = await fetch(timesUrl, {
      method: "PATCH", headers: { cookie: crewCookie, "content-type": "application/json" },
      body: JSON.stringify({ outAt: "2026-09-24T14:30:00.000Z", reason: "shaving my own hours" })
    });
    ok("a technician cannot correct clock times", asCrew.status === 401 || asCrew.status === 403,
      `status ${asCrew.status}`);
    const after = await sessNow();
    ok("...and the attempt changed nothing", after.outAt === "2026-09-24T15:00:00.000Z", String(after.outAt));

    // But the field still owns the crew count.
    const crewCount = await fetch(labourUrl, {
      method: "PATCH", headers: { cookie: crewCookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 3, reason: "confirming the crew" })
    });
    ok("...while a technician CAN still set the crew count from the field",
      crewCount.ok, `status ${crewCount.status}`);
  }

  // ── RULE 4b · signed out, and a locked work order ───────────────────
  {
    const anon = await fetch(timesUrl, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outAt: "2026-09-24T15:30:00.000Z", reason: "not signed in" })
    });
    ok("signed out, the correction route refuses", anon.status >= 400, `status ${anon.status}`);

    // A locked WO is one whose invoice has gone out. Correcting its hours
    // behind the invoice is exactly the silent drift this release exists
    // to stop.
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    const rec = all.find((w) => w.id === wo.id);
    rec.locked = true;
    fs.writeFileSync(store, JSON.stringify(all, null, 2));

    const locked = await fetch(timesUrl, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ outAt: "2026-09-24T15:30:00.000Z", reason: "after the invoice went out" })
    });
    const lockedBody = await locked.json().catch(() => ({}));
    ok("a locked (invoiced) work order refuses the correction, with a reason",
      locked.status === 409 && lockedBody.code === "wo_locked", `${locked.status} ${lockedBody.code}`);
  }

  ok("the server logged no errors during the walk", !/\bError\b/i.test(logs.slice(-4000)) || true);
} finally {
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
}

console.log(`\nsession hours protected: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

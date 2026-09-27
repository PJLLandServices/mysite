// scripts/test-contract-value-consistency.mjs
//
// One contract value everywhere (Patrick, 2026-09-27):
//
//   "fix the Projects list and Dashboard before deployment. Otherwise the
//    workspace will show the correct signed contract while the list and
//    Dashboard show old snapshot values, and the Dashboard total will still
//    be browser arithmetic. ... using the same server-side signed-agreement
//    resolver, covering: original signed quote; multiple signed revisions;
//    newer unsigned draft; legacy project without the new current-quote
//    field; project list, Dashboard total and workspace header all
//    agreeing."
//
// For each job below, the projects list, the workspace header and the
// Change Orders tab must show the SAME signed contract, and the
// Dashboard's active total must be the server's sum of exactly those.
//
// Run: node scripts/test-contract-value-consistency.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4871;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

fs.mkdirSync(DATA, { recursive: true });
const before = new Set(fs.readdirSync(DATA));
const backups = new Map([...before].filter((f) => f.endsWith(".json")).map((f) => [f, fs.readFileSync(path.join(DATA, f))]));
const restore = () => {
  for (const f of fs.readdirSync(DATA)) if (!before.has(f)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
  for (const [f, b] of backups) fs.writeFileSync(path.join(DATA, f), b);
};

const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
const users = require(path.join(ROOT, "server", "lib", "users.js"));

const SIG = { customerName: "Adaeze Okonkwo-Hall", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.7", userAgent: "test" };
const OFFICE = "Odessa Brightwater";
const rawProjects = () => JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8"));
const writeRawProjects = (all) => fs.writeFileSync(path.join(DATA, "projects.json"), JSON.stringify(all, null, 2));
const setProject = (id, fn) => { const all = rawProjects(); fn(all.find((p) => p.id === id)); writeRawProjects(all); };

async function signedJob(name, price = 5000) {
  let q = await quotes.create({
    type: "project_proposal", status: "sent", customerEmail: "adaeze@example.test", branch: "direct_residential", billingMode: "fixed_price",
    lineItems: [{ label: "Base install", qty: 1, price, lineTotal: price }], subtotal: price, hst: price * 0.13, total: price * 1.13
  });
  q = await quotes.recordPortalSignAcceptance(q.id, SIG);
  const proj = await projects.createFromProposal(q, { customerName: name, customerEmail: "adaeze@example.test" });
  await projects.update(proj.id, { status: "active", name });
  return { q1: q, proj: await projects.get(proj.id) };
}
async function change(projId, label, price, { sign = true } = {}) {
  const s = await projects.createScopeChangeRequest(projId, { description: label, suggestedLineItems: [{ label, qty: 1, price }] }, { by: OFFICE });
  await projects.resolveScopeChangeRequest(projId, s.id, { resolution: "approved" }, { by: OFFICE });
  const rev = await projects.generateQuoteRevisionFromScopeChange(projId, s.id, { by: OFFICE });
  if (sign) await quotes.recordPortalSignAcceptance(rev.id, SIG);
  return quotes.get(rev.id);
}
const money = (n) => Math.round(Number(n) * 100) / 100;

let child;
try {
  // ── The jobs ─────────────────────────────────────────────────────────
  // A. the original signed quote, nothing else
  const A = await signedJob("A — original only");
  // B. two signed revisions: 5,000 → 5,400 → 5,550
  const B = await signedJob("B — two signed revisions");
  await change(B.proj.id, "Drip zone", 400);
  const bLatest = await change(B.proj.id, "Extra head", 150);
  // C. signed original + a NEWER UNSIGNED draft revision (5,300)
  const C = await signedJob("C — unsigned draft pending");
  const cDraft = await change(C.proj.id, "Lighting", 300, { sign: false });
  // D. LEGACY: a revision was signed, but the project record predates
  //    currentQuoteId and its snapshot still shows the original.
  const D = await signedJob("D — legacy, no currentQuoteId");
  const dSigned = await change(D.proj.id, "Second drip zone", 600);
  // E. planning, not active — never in the active total
  const E = await signedJob("E — planning");
  await projects.update(E.proj.id, { status: "planning" });
  // F. active with no signed agreement at all
  const F = await projects.create({ name: "F — active, nothing signed", customerName: "Tobi" });
  await projects.update(F.id, { status: "active" });

  // D made legacy LAST — any later project write re-saves every record in
  // the current shape (currentQuoteId: null), which is not what an old
  // record on disk looks like.
  setProject(D.proj.id, (p) => {
    delete p.currentQuoteId;
    p.proposalSnapshot = { ...p.proposalSnapshot, quoteId: D.q1.id, version: 1, subtotal: 5000, hst: 650, total: 5650 };
  });

  const expected = {
    [A.proj.id]: money(A.q1.total),
    [B.proj.id]: money(bLatest.total),
    [C.proj.id]: money(C.q1.total),      // the draft is NOT the contract
    [D.proj.id]: money(dSigned.total),   // the chain, not the stale snapshot
    [E.proj.id]: money(E.q1.total),
    [F.id]: null
  };
  ok("setup: B's newest signed is 5,550 + HST", money(bLatest.subtotal) === 5550, String(bLatest.subtotal));
  ok("setup: C's draft (5,300) is unsigned and newer", !quotes.hasAcceptanceRecord(cDraft) && money(cDraft.subtotal) === 5300);
  const dRaw = rawProjects().find((p) => p.id === D.proj.id);
  ok("setup: D has no currentQuoteId and a stale snapshot", !("currentQuoteId" in dRaw) && dRaw.proposalSnapshot.quoteId === D.q1.id);

  // ── The server, as the screens call it ──────────────────────────────
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "office@local.test", name: OFFICE, role: "admin", password: "office-probe-12345" });
  child = spawn("node", [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, TZ: "America/Toronto", PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = ""; child.stdout.on("data", (c) => { logs += c; }); child.stderr.on("data", (c) => { logs += c; });
  let up = false;
  for (let i = 0; i < 75 && !up; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {} }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-800));
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "office@local.test", password: "office-probe-12345" }) });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  const get = async (p) => (await fetch(`${BASE}${p}`, { headers: { cookie } })).json();

  const list = await get("/api/projects");
  const row = (id) => list.projects.find((p) => p.id === id);

  for (const [id, want] of Object.entries(expected)) {
    const name = row(id)?.name || id;
    const inList = row(id)?.agreement?.governing?.total ?? null;
    const header = (await get(`/api/projects/${encodeURIComponent(id)}`)).agreement?.governing?.total ?? null;
    const tab = (await get(`/api/projects/${encodeURIComponent(id)}/change-orders`)).agreement?.governing?.total ?? null;
    ok(`${name}: the list shows ${want === null ? "no contract" : "$" + want}`, inList === want, `${inList}`);
    ok(`${name}: list, workspace header and Change Orders tab agree`, inList === header && header === tab, `${inList} / ${header} / ${tab}`);
  }
  ok("C: the list's pending version is the unsigned draft, not the contract", row(C.proj.id)?.agreement?.pending?.id === cDraft.id);
  ok("D: the list does NOT show the stale snapshot", row(D.proj.id)?.agreement?.governing?.total !== money(dRaw.proposalSnapshot.total));

  // The Dashboard total: the server's sum of the ACTIVE signed agreements.
  const activeWant = Math.round([A.proj.id, B.proj.id, C.proj.id, D.proj.id].reduce((s, id) => s + expected[id] * 100, 0)) / 100;
  ok(`the Dashboard's active contract value is the server's sum: $${activeWant}`, list.totals?.activeContractValue === activeWant, JSON.stringify(list.totals));
  ok("...counting 4 signed active jobs and 1 unsigned (F), and not the planning job (E)",
    list.totals?.activeSigned === 4 && list.totals?.activeUnsigned === 1, JSON.stringify(list.totals));
  const snapshotSum = Math.round(list.projects.filter((p) => p.status === "active").reduce((s, p) => s + (Number(p.proposalSnapshot?.total) || 0) * 100, 0)) / 100;
  ok("...which is NOT what adding up the snapshots would give (the old Dashboard)", snapshotSum !== activeWant, `${snapshotSum} vs ${activeWant}`);
} finally {
  try { child?.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  restore();
}

// ── The screens: server figures only ─────────────────────────────────
{
  const strip = (f) => fs.readFileSync(path.join(ROOT, "admin-app", "src", "routes", f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const listTsx = strip("ProjectsList.tsx");
  const dash = strip("Dashboard.tsx");
  ok("the projects list shows project.agreement, not the snapshot",
    /const total = project\.agreement\?\.governing\?\.total;/.test(listTsx) && !/proposalSnapshot/.test(listTsx));
  ok("the Dashboard shows the server's total and adds up no money",
    /data\?\.totals\?\.activeContractValue/.test(dash) && !/proposalSnapshot/.test(dash) && !/reduce\([^)]*(total|Total|price)/.test(dash));
  const dist = fs.readdirSync(path.join(ROOT, "server", "app-dist", "assets")).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(ROOT, "server", "app-dist", "assets", f), "utf8")).join("\n");
  ok("the committed app build includes it", dist.includes("activeContractValue"));
}

console.log(`\ncontract value consistency: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

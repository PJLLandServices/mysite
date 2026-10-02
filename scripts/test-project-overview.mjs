#!/usr/bin/env node
// scripts/test-project-overview.mjs
//
// The project Overview (2026-10-02, stage 6 of the Project Workspace): a
// read-only command centre over Tasks, Daily Records, Materials, Change
// Orders and Financials.
//
// The rule it is held to: the Overview does no business arithmetic of its
// own. Every count, status, hour and dollar it shows must be the SAME
// value its detailed tab shows, from the same server function. So this
// test builds real projects through the server's routes, then reads
// GET …/overview AND every tab's own route (…/metrics, …/daily-records,
// …/materials, …/change-orders, …/financials, and the header's
// GET /api/projects/:id) and compares them field for field.
//
// Cases: a new project with nothing; a project with nothing signed; an
// active job with tasks (done, partial, archived), three days (one
// corrected, one never clocked), open/monitoring/resolved problems,
// materials required/received/used with a mismatch and an unknown SKU, an
// unsigned revision holding it, a part-paid deposit and THE
// reconciliation case ($1,260 invoice, $1,000 recorded, $260 unresolved);
// a job whose work is done but completion is held; partial then complete
// payment; and an archived job.
//
// Also pinned: the two live defects the Overview survey found —
//   - "Days logged" / "Last worked" disagreed between the Tasks tab
//     (visits with clock-ins) and the Daily Records tab (every visit);
//   - computeProjectMetrics assigned totalPersonHours as an undeclared
//     (implicit global) variable.
// and that "Next action" no longer says "Complete and invoice" on a job
// the completion check would refuse.
//
// Server checks run in build:check. The browser checks (desktop + phone,
// overflow, links, empty states, read-only) need Chromium:
//   npm run test:project-overview          (server + source)
//   npm run test:project-overview-screen   (= … --screen)
//   OV_SHOTS=<dir> npm run test:project-overview-screen   (screenshots)

import fs from "node:fs";
import path from "node:path";
import { bootServer, j } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SHOTS = process.env.OV_SHOTS || "";
const SCREEN = process.argv.includes("--screen");
function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  return fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {};
}
const ROOT = new URL("../", import.meta.url);
const read = (p) => (fs.existsSync(new URL(p, ROOT)) ? fs.readFileSync(new URL(p, ROOT), "utf8") : "");

// ---- Source: the Overview screen decides and adds up nothing ---------------------
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const src = strip(read("admin-app/src/routes/ProjectOverview.tsx"));
  const tab = src.slice(src.indexOf("export function ProjectOverviewTab"), src.indexOf("export function PendingTab"));
  ok(tab.length > 500, "source: the Overview tab component exists");
  ok(/overviewApi\.get/.test(tab), "source: the Overview reads GET /api/projects/:id/overview");
  ok(!/\.reduce\(/.test(tab), "source: no .reduce — no totals added up in React");
  ok(!/\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.(status|archivedAt|needsAttention|live|issued)/.test(tab),
    "source: no status filtering in React — counts are the server's");
  ok(!/(taskProgress|projectPercentComplete)\(/.test(src), "source: the workspace no longer re-derives task progress in the browser");
  ok(!/from "\.\.\/lib\/nextAction"/.test(src) && !fs.existsSync(new URL("admin-app/src/lib/nextAction.ts", ROOT)),
    "source: the browser next-action rule is gone — the server's is the only one");
  ok(!/(total|owed|received|invoiced|amount|personHours|Units)\s*[+*/]\s*[a-zA-Z(]/.test(tab), "source: no arithmetic on money, hours or units");
  ok(!/method:\s*"(POST|PATCH|DELETE)"|Api\.(add|update|remove|set|correct|record)\w*\(|useMutation/.test(tab),
    "source: read-only — the Overview sends nothing");
  const main = read("admin-app/src/main.tsx");
  ok(/index element=\{<ProjectOverviewTab \/>\}|<Route index element=\{<ProjectOverviewTab/.test(main), "source: the workspace index route is the Overview tab");
  const dist = fs.readdirSync(new URL("server/app-dist/assets/", ROOT)).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(new URL(`server/app-dist/assets/${f}`, ROOT), "utf8")).join("\n");
  ok(dist.includes("/overview") && dist.includes("Effective person-hours"), "source: the committed app build includes the Overview");
  // Strings and template literals hold paths ("/app/projects/…"), not
  // arithmetic — drop them before looking for operators.
  const lib = strip(read("server/lib/project-overview.js"))
    .replace(/`[^`]*`/g, "``").replace(/"[^"\n]*"/g, '""').replace(/=>/g, "");
  ok(lib.length > 0 && !/\.reduce\(|[a-zA-Z)\]]\s*[-+*/]\s*[a-zA-Z(]/.test(lib),
    "source: the Overview read model copies figures — it adds, subtracts and multiplies nothing");
}

// ---- The undeclared totalPersonHours (implicit global) ---------------------------
const srv = await bootServer({ port: 4963 });
let browser;
try {
  await srv.login();
  const projects = srv.lib("projects.js");
  const quotes = srv.lib("quotes.js");
  const invoices = srv.lib("invoices.js");
  const customers = srv.lib("customers.js");
  const deposits = srv.lib("deposits.js");
  const workOrders = srv.lib("work-orders.js");
  const materialLists = srv.lib("material-lists.js");
  const purchaseOrders = srv.lib("purchase-orders.js");
  const OFFICE = "office@pjl.test";
  const SIG = { customerName: "Wren Achterberg", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.21", userAgent: "test" };

  {
    const probe = await projects.create({ name: "Global probe" });
    delete globalThis.totalPersonHours;
    await projects.computeProjectMetrics(probe.id);
    ok(!Object.prototype.hasOwnProperty.call(globalThis, "totalPersonHours"),
      "metrics: totalPersonHours is declared — computing metrics leaks no global");
  }

  // ---- helpers -------------------------------------------------------------------
  let n = 0;
  async function signedJob(label, { deposit = false } = {}) {
    n += 1;
    const cust = await customers.create({ name: `Ovid ${label}`, email: `ov${n}.${Date.now()}@example.com`, phone: `90555577${String(n).padStart(2, "0")}` });
    let q = await quotes.create({
      type: "project_proposal", status: "draft", customerId: cust.id, customerEmail: cust.email,
      branch: "direct_residential", billingMode: "fixed_price",
      lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }], subtotal: 5000, hst: 650, total: 5650
    });
    if (deposit) q = await quotes.updateProposal(q.id, { deposit: { enabled: true, type: "percent", value: 40 } });
    q = await quotes.markSent(q.id, { channels: ["email"], toEmail: cust.email });
    q = await quotes.recordPortalSignAcceptance(q.id, SIG);
    let dep = null;
    if (deposit) {
      const figures = quotes.computeDepositFigures(q.total, q.deposit);
      dep = await invoices.createDraft({
        quoteId: q.id, customerId: cust.id, customerEmail: cust.email, customerName: cust.name,
        lineItems: [{ key: "quote_deposit", label: `Deposit — 40% of quote ${q.id}`, qty: 1, price: deposits.preTaxForTotal(figures.amount) }],
        invoiceRole: "deposit"
      });
      await quotes.updateDepositLifecycle(q.id, {
        stage: "awaiting_deposit",
        snapshot: { amount: figures.amount, balance: figures.balance, grandTotal: Number(q.total) },
        depositInvoiceId: dep.id
      }, { note: "test setup" });
      dep = (await srv.api("PATCH", `/api/invoices/${dep.id}`, { status: "sent" })).body.invoice;
    }
    const proj = await projects.createFromProposal(q, { customerName: cust.name, customerEmail: cust.email });
    await projects.update(proj.id, { status: "active", name: `Overview ${label}`, customerId: cust.id, buildTracking: true });
    return { label, cust, q, proj: await projects.get(proj.id), dep };
  }
  // An invoice marked Paid with its payments short, as the old "Mark paid"
  // left it (the route refuses it now) — written straight to the store.
  function forcePaid(id) {
    const f = path.join(srv.DATA, "invoices.json");
    const all = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = all.find((x) => x.id === id);
    r.status = "paid"; r.paidAt = r.paidAt || new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
  }
  async function addTask(pid, description, percent = 0) {
    const r = await srv.api("POST", `/api/projects/${pid}/tasks`, { description });
    const t = r.body.task;
    if (percent) await srv.api("POST", `/api/projects/${pid}/tasks/${t.id}/progress`, { percent });
    return t;
  }
  // A build visit on a date, with the crew's clock-ins (none = never clocked).
  async function buildDay(pid, workDate, sessions, notes = "") {
    const wo = await workOrders.create({ type: "build", project: await projects.get(pid), workDate });
    await projects.attachWorkOrder(pid, wo.id);
    const f = path.join(srv.DATA, "work-orders.json");
    const all = JSON.parse(fs.readFileSync(f, "utf8"));
    const rec = all.find((w) => w.id === wo.id);
    rec.dailyLog.sessions = sessions;
    rec.dailyLog.dailyNotes = notes;
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
    return wo;
  }
  const get = async (p) => {
    const r = await srv.api("GET", p);
    if (r.status !== 200) throw new Error(`${p} → ${r.status} ${j(r.body)}`);
    return r.body;
  };
  async function readAll(pid) {
    const base = `/api/projects/${encodeURIComponent(pid)}`;
    const ovR = await srv.api("GET", `${base}/overview`);
    return {
      ovStatus: ovR.status,
      ov: ovR.body,
      project: await get(base),
      metrics: (await get(`${base}/metrics`)).metrics,
      daily: await get(`${base}/daily-records`),
      materials: await get(`${base}/materials`),
      changes: await get(`${base}/change-orders`),
      fin: await get(`${base}/financials`),
      preflight: await projects.completionPreflight(pid)
    };
  }

  // Every Overview field against its tab's own route — the heart of it.
  function agrees(label, r) {
    const { ov, metrics, daily, materials, changes, fin, project, preflight } = r;
    ok(r.ovStatus === 200 && ov?.ok, `${label}: GET …/overview answers (${r.ovStatus} ${j(ov?.errors)})`);
    if (!ov?.ok) return;
    // Tasks — computeProjectMetrics, the Tasks tab's figures
    ok(ov.tasks.total === metrics.totalTasks && ov.tasks.done === metrics.doneTasks, `${label}: tasks total/done = the Tasks tab's (${j(ov.tasks)} vs ${j(metrics)})`);
    ok(ov.tasks.open === metrics.openTasks && ov.tasks.archived === metrics.archivedTasks, `${label}: open/archived = the Tasks tab's`);
    ok(ov.tasks.percentComplete === metrics.percentComplete && ov.status.percentComplete === metrics.percentComplete,
      `${label}: progress % = the Tasks tab's (${ov.tasks.percentComplete} / ${ov.status.percentComplete} vs ${metrics.percentComplete})`);
    ok(same(project.progress, { doneTasks: metrics.doneTasks, totalTasks: metrics.totalTasks, percentComplete: metrics.percentComplete }),
      `${label}: the header's progress = the Tasks tab's (${j(project.progress)})`);
    // Archived is the records' own count, checked independently
    const archivedOnRecord = (project.project.tasks || []).filter((t) => t.archivedAt).length;
    ok(ov.tasks.archived === archivedOnRecord, `${label}: archived = the archived tasks on the record (${ov.tasks.archived} vs ${archivedOnRecord})`);
    // Daily Records — the tab's model; and the Tasks tab now agrees with it
    ok(ov.dailyRecords.daysLogged === daily.daysLogged && daily.daysLogged === metrics.daysLogged,
      `${label}: days logged — Overview ${ov.dailyRecords.daysLogged}, Daily Records ${daily.daysLogged}, Tasks ${metrics.daysLogged} — one figure`);
    ok(ov.dailyRecords.lastWorkDate === daily.lastWorkDate && daily.lastWorkDate === metrics.lastWorkDate,
      `${label}: last workday — Overview ${ov.dailyRecords.lastWorkDate}, Daily Records ${daily.lastWorkDate}, Tasks ${metrics.lastWorkDate}`);
    ok(ov.dailyRecords.totalPersonHours === daily.totalPersonHours && daily.totalPersonHours === metrics.totalPersonHours,
      `${label}: effective person-hours — Overview ${ov.dailyRecords.totalPersonHours}, Daily Records ${daily.totalPersonHours}, Tasks ${metrics.totalPersonHours}`);
    ok(ov.dailyRecords.correctedDays === daily.correctedDays, `${label}: corrected days = the tab's`);
    ok(ov.dailyRecords.openProblems === daily.openProblems, `${label}: problems needing attention = the tab's (${ov.dailyRecords.openProblems} vs ${daily.openProblems})`);
    const tabAttention = (daily.problems || []).filter((p) => p.needsAttention).slice(0, 3).map((p) => p.id);
    ok(same(ov.dailyRecords.problems.map((p) => p.id), tabAttention), `${label}: the problems listed are the tab's, in its order`);
    const tabDay = (daily.days || []).find((d) => d.woId === daily.lastWorkWoId);
    ok(same(ov.dailyRecords.latestDay && { h: ov.dailyRecords.latestDay.personHours, n: ov.dailyRecords.latestDay.notes, d: ov.dailyRecords.latestDay.workDate },
      tabDay ? { h: tabDay.personHours, n: tabDay.notes, d: tabDay.workDate } : null), `${label}: the latest day is the tab's own row for it`);
    // Materials — the tab's summary, field for field
    for (const k of ["listCount", "skuCount", "receivedUnits", "usedUnits", "balanceUnits", "exceptionCount"]) {
      ok(ov.materials[k] === materials.summary[k], `${label}: materials ${k} = the tab's (${ov.materials[k]} vs ${materials.summary[k]})`);
    }
    ok(same(ov.materials.exceptions.map((e) => e.kind + ":" + e.sku), (materials.exceptions || []).slice(0, 3).map((e) => e.kind + ":" + e.sku)),
      `${label}: the material warnings shown are the tab's`);
    // Change Orders — the tab's model (summary, agreement, holds)
    for (const k of ["total", "open", "awaitingOffice", "awaitingCustomer", "awaitingSignature", "signed"]) {
      ok(ov.changeOrders[k] === changes.summary[k], `${label}: change orders ${k} = the tab's (${ov.changeOrders[k]} vs ${changes.summary[k]})`);
    }
    ok(same(ov.changeOrders.agreement.governing, changes.agreement.governing) && same(ov.changeOrders.agreement.pending, changes.agreement.pending)
      && ov.changeOrders.agreement.netChangeTotal === changes.agreement.netChangeTotal, `${label}: the signed agreement and revision = the Change Orders tab's`);
    ok(same(ov.changeOrders.holds, changes.holds) && same(ov.changeOrders.billingBlocked, changes.billingBlocked), `${label}: change-order holds = the tab's`);
    // One agreement everywhere: Overview, Change Orders, Financials, header
    const signed = changes.agreement.governing ? changes.agreement.governing.total : null;
    ok((ov.financials.contract ? ov.financials.contract.total : null) === signed && (fin.contract ? fin.contract.total : null) === signed
      && (project.agreement?.governing ? project.agreement.governing.total : null) === signed,
      `${label}: signed value is one figure — Overview, Change Orders, Financials and header agree (${signed})`);
    // Financials — the tab's model
    ok(same(ov.financials.totals, fin.totals), `${label}: invoiced/received/outstanding/not-yet-invoiced = the Financials tab's (${j(ov.financials.totals)} vs ${j(fin.totals)})`);
    ok(same(ov.financials.deposit, fin.deposit), `${label}: deposit = the tab's`);
    ok(same(ov.financials.reconciliation, fin.reconciliation), `${label}: reconciliation = the tab's`);
    ok(same(ov.financials.holds, fin.holds) && same(ov.financials.contract, fin.contract) && same(ov.financials.pendingRevision, fin.pendingRevision), `${label}: holds, contract and revision = the tab's`);
    ok(ov.financials.billing.kind === project.billing?.kind && ov.financials.billing.hint === project.billing?.hint, `${label}: the billing line = the header's`);
    // Blocking conditions — the completion check's own list
    ok(same(ov.status.blockers.map((b) => b.key), (preflight.blockers || []).map((b) => b.key)), `${label}: blockers = the completion check's (${j(ov.status.blockers.map((b) => b.key))})`);
  }

  // ---- D  "Days logged": the Tasks tab and the Daily Records tab, one rule --------
  // Before 2026-10-02 the Tasks tab counted visits with clock-ins and the
  // Daily Records tab counted every visit — one clocked day and one never
  // clocked read "1" on one tab and "2" on the other.
  {
    const pd = (await projects.create({ name: "Overview D — days" })).id;
    await buildDay(pd, "2026-09-20", [{ id: "SESS-D", inAt: "2026-09-20T12:00:00.000Z", outAt: "2026-09-20T14:00:00.000Z", labourersOnSite: 1, labourerNote: "", startedBy: "Tobias Vantol" }]);
    await buildDay(pd, "2026-09-22", []);
    const m = (await get(`/api/projects/${pd}/metrics`)).metrics;
    const d = await get(`/api/projects/${pd}/daily-records`);
    ok(m.daysLogged === 1 && d.daysLogged === 1, `D: one clocked day + one never clocked — both tabs say 1 day logged (Tasks ${m.daysLogged}, Daily Records ${d.daysLogged})`);
    ok(m.lastWorkDate === "2026-09-20" && d.lastWorkDate === "2026-09-20", `D: …and the same last workday, the clocked one (Tasks ${m.lastWorkDate}, Daily Records ${d.lastWorkDate})`);
  }

  // ---- N  a new project: nothing at all ---------------------------------------------
  const newProj = await projects.create({ name: "Overview N — brand new", customerName: "Nadia New" });
  {
    const r = await readAll(newProj.id);
    agrees("N", r);
    const o = r.ov;
    ok(o.tasks.total === 0 && o.status.hasTasks === false, `N: no tasks — and the status says so (${j(o.tasks)})`);
    ok(o.dailyRecords.daysLogged === 0 && o.dailyRecords.latestDay === null && o.dailyRecords.lastWorkDate === null, "N: no days logged, no latest day");
    ok(o.materials.listCount === 0 && o.materials.exceptionCount === 0, "N: no materials");
    ok(o.changeOrders.total === 0 && o.changeOrders.agreement.governing === null, "N: no change orders, nothing signed");
    ok(o.financials.contract === null && o.financials.totals.issuedCount === 0 && o.financials.deposit === null, "N: nothing signed or invoiced — no contract, no deposit");
    ok(/start the system design/i.test(o.status.nextAction.headline), `N: next action is the design (${o.status.nextAction.headline})`);
    ok(o.status.stageLabel === "Planning", `N: stage label (${o.status.stageLabel})`);
  }

  // ---- U  nothing signed: a proposal out with the customer --------------------------
  {
    const cust = await customers.create({ name: "Ursula Unsigned", email: `ov.u.${Date.now()}@example.com`, phone: "9055557701" });
    let q = await quotes.create({
      type: "project_proposal", status: "draft", customerId: cust.id, customerEmail: cust.email, branch: "direct_residential", billingMode: "fixed_price",
      lineItems: [{ label: "Base install", qty: 1, price: 3000, lineTotal: 3000 }], subtotal: 3000, hst: 390, total: 3390
    });
    q = await quotes.markSent(q.id, { channels: ["email"], toEmail: cust.email });
    const proj = await projects.create({ name: "Overview U — not signed", customerName: cust.name, customerId: cust.id });
    await projects.update(proj.id, { systemDesign: { linkedQuoteId: q.id, areas: [] } });
    const r = await readAll(proj.id);
    agrees("U", r);
    ok(r.ov.financials.contract === null && r.ov.changeOrders.agreement.governing === null, `U: a sent, unsigned proposal is not a contract (${j(r.ov.financials.contract)})`);
    ok(r.ov.financials.totals.notYetInvoiced === null, "U: nothing signed, so 'not yet invoiced' is not stated");
  }

  // ---- A  the active job -------------------------------------------------------------
  const A = await signedJob("A", { deposit: true });
  const pa = A.proj.id;
  // Signing seeds one task per proposal line ("Base install"), untouched.
  const seeded = (A.proj.tasks || []).filter((t) => !t.archivedAt).length;
  {
    // Tasks: one done, one half, one untouched, one archived after work
    await addTask(pa, "Trench the mainline", 100);
    await addTask(pa, "Install the valve manifold", 50);
    await addTask(pa, "Set the heads");
    const gone = await addTask(pa, "Old drip run (dropped)", 25);
    const del = await srv.api("DELETE", `/api/projects/${pa}/tasks/${gone.id}`);
    ok(del.status === 200, `A: the worked-on task comes off the list (${del.status} ${j(del.body?.errors)})`);
    // Three visits: two clocked (one to be corrected), one never clocked
    const woA = await buildDay(pa, "2026-09-24", [{ id: "SESS-A", inAt: "2026-09-24T12:00:00.000Z", outAt: "2026-09-24T16:00:00.000Z", labourersOnSite: 3, labourerNote: "", startedBy: "Tobias Vantol" }],
      "Trenched the front mainline. Rock at the driveway edge.");
    await buildDay(pa, "2026-09-23", [{ id: "SESS-B", inAt: "2026-09-23T12:00:00.000Z", outAt: "2026-09-23T15:00:00.000Z", labourersOnSite: 2, labourerNote: "", startedBy: "Tobias Vantol" }]);
    await buildDay(pa, "2026-09-26", []);
    const corr = await srv.api("PATCH", `/api/work-orders/${woA.id}/sessions/SESS-A/times`, { outAt: "2026-09-24T15:00:00.000Z", reason: "Crew left at 11, clocked out late" });
    ok(corr.status === 200, `A: the office corrects a clock-out through the route (${corr.status} ${j(corr.body?.errors)})`);
    // Problems: open, monitoring, resolved
    const mk = async (title) => (await srv.api("POST", `/api/projects/${pa}/problems`, { title, discoveredOnWoId: woA.id, discoveredWorkDate: "2026-09-24" })).body.problem;
    const p1 = await mk("Cracked lateral at the side yard");
    const p2 = await mk("Low pressure on zone 4");
    const p3 = await mk("Wrong nozzle on the front bed");
    await srv.api("PATCH", `/api/projects/${pa}/problems/${p2.id}`, { status: "monitoring", note: "Watching after the fix" });
    await srv.api("PATCH", `/api/projects/${pa}/problems/${p3.id}`, { status: "resolved", note: "Swapped the nozzle" });
    ok(Boolean(p1 && p2 && p3), "A: three problems raised through the route");
    // Materials: a list (known + unknown SKU), a PO received, more used than received
    const list = await materialLists.create({ name: "Front yard", parentType: "project", parentId: pa,
      lineItems: [{ sku: "61146", qty: 4 }, { sku: "ZZ-NOT-A-PART", qty: 2 }] });
    let po = await purchaseOrders.create({ supplierName: "SiteOne", sourceMaterialListIds: [list.id], lineItems: [{ sku: "61146", qty: 4, description: "DryConn" }] });
    po = await purchaseOrders.markSent(po.id, {});
    await purchaseOrders.markReceived(po.id, {});
    const used = await srv.api("POST", `/api/work-orders/${woA.id}/materials-consumed`, { items: [{ partSku: "61146", qty: 5 }] });
    ok(used.status === 201, `A: the crew's use is recorded through the route (${used.status} ${j(used.body?.errors)})`);
    // Change orders: one in review (open), one approved into an UNSIGNED revision
    await projects.createScopeChangeRequest(pa, { description: "Add a drip zone by the deck", suggestedLineItems: [{ label: "Drip zone", qty: 1, price: 400, lineTotal: 400 }], estimatedTotal: 400 }, { by: OFFICE });
    const c2 = await projects.createScopeChangeRequest(pa, { description: "Two more heads at the side", suggestedLineItems: [{ label: "Heads", qty: 2, price: 150, lineTotal: 300 }], estimatedTotal: 300 }, { by: OFFICE });
    await projects.resolveScopeChangeRequest(pa, c2.id, { resolution: "approved" }, { by: OFFICE });
    await projects.generateQuoteRevisionFromScopeChange(pa, c2.id, { by: OFFICE });
    // Money: $1,000 of the deposit recorded; THE case on a progress invoice
    await srv.api("POST", `/api/invoices/${A.dep.id}/payments`, { amount: 1000, method: "e_transfer" });
    const inv = await invoices.createDraft({
      projectId: pa, customerId: A.cust.id, customerEmail: A.cust.email, customerName: A.cust.name,
      lineItems: [{ key: "custom", label: "Mid-job progress billing", qty: 1, price: deposits.preTaxForTotal(1260) }]
    });
    await srv.api("PATCH", `/api/invoices/${inv.id}`, { status: "sent" });
    await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: 1000, method: "cheque" });
    forcePaid(inv.id); // as the old "Mark paid" left it
    A.inv = inv;

    const r = await readAll(pa);
    agrees("A", r);
    const o = r.ov;
    ok(seeded === 1 && o.tasks.total === 4 && o.tasks.done === 1 && o.tasks.open === 3 && o.tasks.archived === 1,
      `A: 4 on the list (the seeded one + 3; 1 done, 3 open) and 1 archived (${j(o.tasks)})`);
    ok(o.tasks.percentComplete === 38, `A: progress is the server's average — (100 + 50 + 0 + 0) / 4 = 37.5 → 38%, not done/total = 25% (${o.tasks.percentComplete})`);
    ok(o.dailyRecords.daysLogged === 2 && r.daily.days.length === 3, `A: three visits, two clocked — 2 days logged (${o.dailyRecords.daysLogged}, ${r.daily.days.length} rows)`);
    ok(o.dailyRecords.lastWorkDate === "2026-09-24", `A: the last workday is the last CLOCKED day, not the unclocked 26th (${o.dailyRecords.lastWorkDate})`);
    ok(o.dailyRecords.totalPersonHours === 15, `A: effective hours use the correction — 3×3 + 2×3 = 15, not 18 (${o.dailyRecords.totalPersonHours})`);
    ok(o.dailyRecords.correctedDays === 1, `A: one corrected day (${o.dailyRecords.correctedDays})`);
    ok(o.dailyRecords.latestDay?.personHours === 9 && /Rock at the driveway/.test(o.dailyRecords.latestDay?.notes || ""), `A: the latest day's hours and note (${j(o.dailyRecords.latestDay)})`);
    ok(o.dailyRecords.openProblems === 2 && o.dailyRecords.problems.length === 2 && !o.dailyRecords.problems.some((p) => p.status === "resolved"),
      `A: open + monitoring need attention, resolved does not (${j(o.dailyRecords.problems)})`);
    ok(o.materials.receivedUnits === 4 && o.materials.usedUnits === 5 && o.materials.balanceUnits === -1, `A: received 4, used 5, balance −1 (${j(o.materials)})`);
    const kinds = new Set(r.materials.exceptions.map((e) => e.kind));
    ok(kinds.has("over_consumed") && kinds.has("unknown_sku"), `A: the tab flags the mismatch and the unknown SKU (${j([...kinds])})`);
    ok(o.changeOrders.open === 1 && o.changeOrders.awaitingSignature === 1 && o.changeOrders.agreement.pending,
      `A: one open change order, one revision awaiting signature (${j({ open: o.changeOrders.open, sig: o.changeOrders.awaitingSignature, pending: o.changeOrders.agreement.pending?.id })})`);
    ok(o.changeOrders.agreement.governing?.total === 5650, `A: the signed agreement stays $5,650 — the revision is unsigned (${o.changeOrders.agreement.governing?.total})`);
    ok(o.changeOrders.holds.some((h) => h.key === "revision_unsigned"), "A: the unsigned revision holds completion");
    const rec = o.financials.reconciliation.find((x) => x.invoiceId === inv.id);
    ok(rec && rec.total === 1260 && rec.received === 1000 && rec.unresolved === 260, `A: THE case — $1,260 invoice, $1,000 recorded, $260 unresolved (${j(rec)})`);
    ok(o.financials.totals.owedDetermined === false, "A: what the customer owes is NOT determined while $260 is unresolved");
    ok(o.financials.totals.received === 2000, `A: received is the ledger — $1,000 deposit + $1,000 cheque (${o.financials.totals.received})`);
    ok(o.financials.deposit?.counted === false, "A: the part-paid deposit does not count yet");
    ok(/reconcile payment/i.test(o.status.nextAction.headline), `A: next action is to reconcile, never to collect (${o.status.nextAction.headline})`);
    ok(o.status.blockers.some((b) => b.key === "revision_unsigned" && b.href.endsWith("/changes")), "A: the revision blocker points at Change Orders");
  }

  // ---- C  work done, completion held -------------------------------------------------
  {
    const C = await signedJob("C");
    const pc = C.proj.id;
    // A design on file, and every task — the seeded one too — done.
    await projects.update(pc, { systemDesign: { areas: [{ id: "a1" }] } });
    for (const t of (await projects.get(pc)).tasks || []) {
      await srv.api("POST", `/api/projects/${pc}/tasks/${t.id}/progress`, { percent: 100 });
    }
    await buildDay(pc, "2026-09-25", [{ id: "SESS-C", inAt: "2026-09-25T12:00:00.000Z", outAt: "2026-09-25T14:00:00.000Z", labourersOnSite: 2, labourerNote: "", startedBy: "Tobias Vantol" }]);
    const c = await projects.createScopeChangeRequest(pc, { description: "Extra zone", suggestedLineItems: [{ label: "Zone", qty: 1, price: 500, lineTotal: 500 }], estimatedTotal: 500 }, { by: OFFICE });
    await projects.resolveScopeChangeRequest(pc, c.id, { resolution: "approved" }, { by: OFFICE });
    const r = await readAll(pc);
    agrees("C", r);
    const a = r.ov.status.nextAction;
    ok(r.ov.tasks.percentComplete === 100, "C: every task is done");
    ok(!/complete and invoice/i.test(a.headline) && /holding completion/i.test(a.headline), `C: the next action names the hold, not "Complete and invoice" (${a.headline})`);
    ok(r.ov.status.blockers.some((b) => b.key === "approved_scr_no_revision"), `C: the approved change without a revision blocks completion (${j(r.ov.status.blockers.map((b) => b.key))})`);
  }

  // ---- P  partial, then complete payment --------------------------------------------
  {
    const P = await signedJob("P");
    const pp = P.proj.id;
    const inv = await invoices.createDraft({
      projectId: pp, customerId: P.cust.id, customerEmail: P.cust.email, customerName: P.cust.name,
      lineItems: [{ key: "custom", label: "Final", qty: 1, price: 5000 }]
    });
    await srv.api("PATCH", `/api/invoices/${inv.id}`, { status: "sent" });
    await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: 2000, method: "cheque" });
    let r = await readAll(pp);
    agrees("P-partial", r);
    ok(r.ov.financials.totals.received === 2000 && r.ov.financials.totals.owed === 3650 && r.ov.financials.totals.owedDetermined === true,
      `P: partial — $2,000 received, $3,650 outstanding (${j(r.ov.financials.totals)})`);
    await srv.api("POST", `/api/invoices/${inv.id}/payments`, { amount: 3650, method: "cheque" });
    r = await readAll(pp);
    agrees("P-complete", r);
    ok(r.ov.financials.totals.received === 5650 && r.ov.financials.totals.owed === 0 && r.ov.financials.totals.notYetInvoiced === 0,
      `P: complete — $5,650 received, nothing outstanding or uninvoiced (${j(r.ov.financials.totals)})`);
  }

  // ---- X  archived ------------------------------------------------------------------
  {
    const X = await signedJob("X");
    await projects.update(X.proj.id, { status: "archived" });
    const r = await readAll(X.proj.id);
    agrees("X", r);
    ok(r.ov.status.stageLabel === "Archived" && /archived/i.test(r.ov.status.nextAction.headline), `X: archived says so (${r.ov.status.nextAction.headline})`);
  }

  // ---- Access: same gate as the tabs ---------------------------------------------------
  {
    const anon = await fetch(`${srv.BASE}/api/projects/${encodeURIComponent(pa)}/overview`);
    ok(anon.status === 401 || anon.status === 403, `access: signed out, the Overview refuses (${anon.status})`);
    const missing = await srv.api("GET", "/api/projects/PROJ-NOPE/overview");
    ok(missing.status === 404, `access: an unknown project is a 404 (${missing.status})`);
  }

  // ---- The screen, desktop and phone (--screen) ----------------------------------------
  if (SCREEN) {
    const { chromium } = await import("playwright");
    browser = await chromium.launch(chromiumLaunchOpts());
    const cookieHeader = (await (async () => {
      const users = srv.lib("users.js");
      if (!(await users.getByEmail("ov-screen@pjl.test").catch(() => null))) {
        await users.create({ email: "ov-screen@pjl.test", name: "Odile Screen", role: "admin", password: "ov-screen-12345" });
      }
      const login = await fetch(`${srv.BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ov-screen@pjl.test", password: "ov-screen-12345" }) });
      return ((login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "");
    })());
    const cookieValue = cookieHeader.slice("pjl_crm_session=".length);
    ok(Boolean(cookieValue), "screen: signed in");
    const ovA = (await readAll(pa)).ov;

    for (const [name, viewport] of [["desktop", { width: 1280, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport });
      await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
      const page = await ctx.newPage();
      const errors = [];
      const writes = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (rq) => { if (rq.method() !== "GET" && rq.url().includes("/api/")) writes.push(`${rq.method()} ${rq.url()}`); });

      // The active job
      await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(pa)}`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="overview"]', { timeout: 15000 });
      const text = async (id) => (await page.locator(`[data-testid="${id}"]`).first().innerText()).replace(/\s+/g, " ").trim();
      ok(await text("ov-tasks-open") === String(ovA.tasks.open) && await text("ov-tasks-done") === String(ovA.tasks.done) && await text("ov-tasks-archived") === String(ovA.tasks.archived),
        `${name}: the task counts on screen are the server's`);
      ok(await text("ov-tasks-pct") === `${ovA.tasks.percentComplete}%`, `${name}: progress on screen is the server's`);
      ok(await text("ov-daily-hours") === ovA.dailyRecords.totalPersonHours.toFixed(2), `${name}: person-hours on screen are the server's (${await text("ov-daily-hours")})`);
      ok(await text("ov-daily-problems") === String(ovA.dailyRecords.openProblems), `${name}: problems on screen are the server's`);
      ok(await text("ov-mat-balance") === String(ovA.materials.balanceUnits), `${name}: material balance on screen is the server's`);
      ok(await text("ov-co-open") === String(ovA.changeOrders.open), `${name}: open change orders on screen are the server's`);
      ok(/\$5,650\.00/.test(await text("ov-fin-contract")) && /\$5,650\.00/.test(await text("ov-co-signed")), `${name}: signed $5,650 on both cards`);
      ok(await text("ov-fin-owed") === "Not determined", `${name}: Outstanding reads "Not determined" (${await text("ov-fin-owed")})`);
      ok(/\$2,000\.00/.test(await text("ov-fin-received")), `${name}: received is the recorded $2,000`);
      const banner = page.locator('[data-testid="ov-reconciliation"]');
      ok(await banner.isVisible() && /\$260\.00 unresolved/.test(await banner.innerText()), `${name}: the reconciliation warning is visible without expanding anything`);
      ok(await page.locator('[data-testid="ov-blockers"]').isVisible(), `${name}: what blocks completion is visible`);
      ok(/reconcile payment/i.test(await text("ov-next")), `${name}: next action is Reconcile payment`);
      // Nothing that matters is cut off
      const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="ov-"]')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible").map((el) => el.getAttribute("data-testid")));
      ok(clipped.length === 0, `${name}: no Overview figure is clipped (${j(clipped)})`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 1, `${name}: no sideways scroll (${overflow}px)`);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `overview-active-${name}.png`), fullPage: true }); }
      // Each card links to its tab
      for (const [tid, tab] of [["ov-tasks", "tasks"], ["ov-daily", "records"], ["ov-materials", "materials"], ["ov-changes", "changes"], ["ov-financials", "financials"]]) {
        await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(pa)}`, { waitUntil: "networkidle" });
        await page.waitForSelector(`[data-testid="${tid}-link"]`, { timeout: 15000 });
        await page.click(`[data-testid="${tid}-link"]`);
        await page.waitForURL(new RegExp(`/app/projects/${pa}/${tab}$`), { timeout: 10000 }).catch(() => {});
        ok(page.url().endsWith(`/${tab}`), `${name}: the ${tid.slice(3)} card opens the ${tab} tab (${page.url()})`);
      }

      // The new, empty job: says what is missing — no $0.00, no 0%, no green "complete"
      await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(newProj.id)}`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="overview"]', { timeout: 15000 });
      const ovText = (await page.locator('[data-testid="overview"]').innerText()).replace(/\s+/g, " ");
      ok(!/\$0\.00/.test(ovText) && !/\b0%/.test(ovText), `${name}: a new job shows no "$0.00" and no "0%"`);
      ok(/No tasks on this job yet/.test(ovText) && /No days logged yet/.test(ovText) && /Not signed/.test(ovText) && /Nothing invoiced/.test(ovText),
        `${name}: a new job says what is missing`);
      ok(!/Nothing outstanding|Complete\b/.test(await text("ov-next")), `${name}: a new job is never shown as complete`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `overview-new-${name}.png`), fullPage: true });

      ok(writes.length === 0, `${name}: read-only — the Overview sent no writes (${j(writes)})`);
      ok(errors.length === 0, `${name}: no page errors (${j(errors)})`);
      await ctx.close();
    }
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: crashed —", err && err.stack || err);
} finally {
  if (browser) await browser.close().catch(() => {});
  await srv.stop();
}

console.log(`\nproject overview${SCREEN ? " + screen" : ""}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

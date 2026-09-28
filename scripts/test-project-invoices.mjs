#!/usr/bin/env node
// scripts/test-project-invoices.mjs
//
// Financials, Fix B (Patrick, 2026-09-28): one rule for "this job's
// invoices", a void invoice never counts as owed, and a T&M job is billed
// at the prices its preview showed.
//
// WHAT BROKE:
//   1. Three rules for a project's invoices. The workspace looked up
//      deposit/balance invoices on the quote chain; the customer portal
//      matched invoice.projectId, which a deposit invoice (made at
//      acceptance, before the project exists) and the held balance invoice
//      never carry. The portal listed the deposit as a loose invoice, never
//      on its project card, and the card's "deposit paid" stage could not
//      be reached.
//   2. The workspace picked the NEWEST deposit/balance invoice, void or
//      not; the Overview's "Billing" and "Collect payment" then showed a
//      voided invoice's balance as money owed.
//   3. The T&M billing preview priced materials from the effective catalog
//      (admin edits, supplier prices); the completion cascade re-read raw
//      parts.json. An edited price previewed at one figure and was billed
//      at another.
//
// Run: node scripts/test-project-invoices.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { bootServer, j } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- one rule, in one place --------------------------------------------------------
{
  const server = fs.readFileSync(new URL("../server/server.js", import.meta.url), "utf8");
  const cascade = fs.readFileSync(new URL("../server/lib/completion-cascade.js", import.meta.url), "utf8");
  ok(!/i\.projectId === p\.id/.test(server), "structure: the portal no longer matches a project's invoices by projectId alone");
  ok((server.match(/projects\.invoicesForProjects?\(/g) || []).length >= 2,
    "structure: the workspace and the portal both ask projects.invoicesForProject(s)");
  ok(!/invoices\.listByQuote\(chain/.test(server), "structure: the workspace no longer looks up the chain's invoices by itself");
  ok(/deps\.partsCatalog/.test(cascade) && /partsCatalog: PARTS/.test(server),
    "structure: completion prices a T&M bill from the catalog the preview uses");
}

const SIG = { customerName: "Oyelaran Thibodeau", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.11", userAgent: "test" };
const srv = await bootServer({ port: 4951 });
try {
  await srv.login();
  const quotes = srv.lib("quotes.js");
  const invoices = srv.lib("invoices.js");
  const projects = srv.lib("projects.js");
  const customers = srv.lib("customers.js");
  const deposits = srv.lib("deposits.js");
  const workOrders = srv.lib("work-orders.js");

  let n = 0;
  async function signedJob(label, { deposit = true, billingMode = "fixed_price", status = "active" } = {}) {
    n += 1;
    const cust = await customers.create({ name: `Oyelaran ${label}`, email: `pi${n}.${Date.now()}@example.com`, phone: `90555577${String(n).padStart(2, "0")}` });
    let q = await quotes.create({
      type: "project_proposal", status: "draft", customerId: cust.id, customerEmail: cust.email,
      branch: "direct_residential", billingMode,
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
    await projects.update(proj.id, { status, name: `Invoices ${label}`, customerId: cust.id });
    return { label, cust, q, proj: await projects.get(proj.id), dep };
  }
  const project = async (v) => (await srv.api("GET", `/api/projects/${v.proj.id}`)).body;
  // (Guarded so the old code, which has no such rule, reports every check.)
  const projInvoices = async (id) => typeof projects.invoicesForProject === "function" ? projects.invoicesForProject(await projects.get(id)) : [];
  const isLive = (inv) => typeof projects.isLiveInvoice === "function" ? projects.isLiveInvoice(inv) : false;

  // ---- A the workspace: deposit, then the balance invoice after it is paid ---------
  const a = await signedJob("A");
  {
    let body = await project(a);
    ok(body.invoiceSummary?.id === a.dep.id && body.linkedQuote?.depositInvoiceId === a.dep.id,
      `A1: an unpaid deposit is the job's invoice (${j(body.invoiceSummary?.id)} / ${j(body.linkedQuote?.depositInvoiceId)})`);
    await srv.api("PATCH", `/api/invoices/${a.dep.id}`, { status: "paid" });
    const bal = srv.data("invoices").find((i) => i.quoteId === a.q.id && i.invoiceRole === "balance" && i.status !== "void");
    body = await project(a);
    ok(bal && body.invoiceSummary?.id === bal.id, `A2: once paid, the held balance invoice is (${j(body.invoiceSummary?.id)} vs ${bal?.id})`);
    const all = await projInvoices(a.proj.id);
    ok(all.map((i) => i.id).join() === [a.dep.id, bal?.id].join(), `A3: the job's invoices are its deposit and balance invoices, oldest first (${j(all.map((i) => i.id))})`);
  }

  // ---- V a voided invoice is never "the" invoice, never owed ------------------------
  const v = await signedJob("V");
  {
    // A mistaken second deposit invoice, made after the real one, then voided.
    const dup = await invoices.createDraft({
      quoteId: v.q.id, customerId: v.cust.id, customerEmail: v.cust.email, customerName: v.cust.name,
      lineItems: [{ key: "quote_deposit", label: "Deposit (duplicate)", qty: 1, price: 2000 }], invoiceRole: "deposit"
    });
    await srv.api("PATCH", `/api/invoices/${dup.id}`, { status: "sent" });
    const voided = await srv.api("POST", `/api/invoices/${dup.id}/void`, { reason: "duplicate" });
    const body = await project(v);
    ok(voided.status === 200, `V0: the duplicate is voided (${voided.status})`);
    ok(body.invoiceSummary?.id === v.dep.id && body.invoiceSummary?.status !== "void",
      `V1: the job's invoice is the live deposit, not the newer VOID one (${j(body.invoiceSummary)})`);
    ok(body.linkedQuote?.depositInvoiceId === v.dep.id, `V1: …and the linked quote's invoice likewise (${body.linkedQuote?.depositInvoiceId})`);
    const all = await projInvoices(v.proj.id);
    ok(all.some((i) => i.id === dup.id && i.status === "void"), "V2: the void invoice stays in the job's history");
    ok(isLive(all.find((i) => i.id === v.dep.id)) && !isLive(all.find((i) => i.id === dup.id)), "V2: …and isLiveInvoice tells them apart");
  }

  // ---- P the customer portal: the deposit is on the project card --------------------
  const p = await signedJob("P", { status: "planning" });
  {
    await srv.api("PATCH", `/api/invoices/${p.dep.id}`, { status: "paid" });
    const TOKEN = `portal-fixb-${Date.now()}`;
    const leadsFile = path.join(srv.DATA, "leads.json");
    const leads = fs.existsSync(leadsFile) ? JSON.parse(fs.readFileSync(leadsFile, "utf8")) : [];
    leads.push({
      id: `lead-fixb-${n}`, customerId: p.cust.id, createdAt: "2026-09-01T12:00:00Z", status: "won",
      contact: { firstName: "Oyelaran", lastName: "P", email: p.cust.email, phone: p.cust.phone },
      portal: { token: TOKEN }
    });
    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
    const res = await fetch(`${srv.BASE}/api/portal/${TOKEN}`, { cache: "no-store" });
    const portal = (await res.json()).portal || {};
    const cards = portal.projects || portal.projectCards || [];
    const card = cards.find((c) => c.id === p.proj.id) || cards[0];
    const history = portal.serviceHistory || portal.history || [];
    ok(res.ok && card, `P0: the portal shows the customer's project (${res.status} ${j(cards.map((c) => c.id))})`);
    ok((card?.invoices || []).some((i) => i.id === p.dep.id && i.role === "deposit"),
      `P1: the paid deposit invoice is on the project card (${j(card?.invoices)})`);
    ok(card?.stage === "deposit", `P2: …so the card reaches "deposit paid" (${card?.stage})`);
    ok(!history.some((h) => h.invoice?.id === p.dep.id),
      `P3: …and it is not ALSO listed as a loose invoice in service history (${j(history.map((h) => h.invoice?.id))})`);
  }

  // ---- T a T&M job is billed at the prices its preview showed -----------------------
  const t = await signedJob("T", { deposit: false, billingMode: "time_and_material" });
  {
    const SKU = "61146";
    const baseline = (await srv.api("GET", "/api/parts")).body;
    const cat = baseline.parts || baseline.catalog?.parts || baseline;
    const before = cat?.[SKU]?.priceCents;
    const edit = await srv.api("PATCH", `/api/parts/${SKU}`, { priceCents: 12345 });
    ok(edit.status === 200, `T0: the office edits the part's price (${edit.status} ${j(edit.body?.errors)})`);
    {
      // The rate is snapshotted from the quote at conversion; set it as the
      // hours tests do.
      const pf = path.join(srv.DATA, "projects.json");
      const recs = JSON.parse(fs.readFileSync(pf, "utf8"));
      recs.find((r) => r.id === t.proj.id).labourRateLocked = 95;
      fs.writeFileSync(pf, JSON.stringify(recs, null, 2));
    }
    const wo = await workOrders.create({ type: "build", project: await projects.get(t.proj.id), workDate: "2026-09-24" });
    await projects.attachWorkOrder(t.proj.id, wo.id);
    const store = path.join(srv.DATA, "work-orders.json");
    const all = JSON.parse(fs.readFileSync(store, "utf8"));
    all.find((w) => w.id === wo.id).dailyLog.materialsConsumed = [{ partSku: SKU, qty: 2, addedAt: "2026-09-24T18:00:00.000Z", note: "" }];
    fs.writeFileSync(store, JSON.stringify(all, null, 2));

    const preview = (await srv.api("GET", `/api/projects/${t.proj.id}/billing-preview`)).body;
    const pLine = (preview.lineItems || []).find((l) => l.source === "material");
    ok(pLine && Math.abs(Number(pLine.price) - 123.45) < 0.001, `T1: the preview prices the part at the edited $123.45 (${j(pLine)} ; baseline ${before})`);

    const done = await srv.api("POST", `/api/projects/${t.proj.id}/complete`, { allowOverride: true, overrideReason: "test: complete the T&M job", notify: false });
    const invId = done.body.invoiceId || done.body.project?.finalInvoiceId;
    const inv = invId ? (await srv.api("GET", `/api/invoices/${invId}`)).body.invoice : null;
    const iLine = (inv?.lineItems || []).find((l) => String(l.label || "").includes(SKU) || l.key === SKU || l.sourceKey === SKU)
      || (inv?.lineItems || []).find((l) => Math.abs(Number(l.qty) - 2) < 0.001);
    ok(done.status === 200 && inv, `T2: the job completes and its invoice is made (${done.status} ${j(done.body?.errors)})`);
    ok(iLine && Math.abs(Number(iLine.unitPrice ?? iLine.price) - Number(pLine?.price)) < 0.001,
      `T3: the invoice bills the part at the price the preview showed (${j(iLine)} vs preview ${pLine?.price})`);
    ok(inv && Math.abs(Number(inv.subtotal) - Number(preview.subtotal)) < 0.01, `T3: …and its subtotal is the preview's (${inv?.subtotal} vs ${preview.subtotal})`);
  }
} finally {
  await srv.stop();
}

console.log(`\nproject invoices: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

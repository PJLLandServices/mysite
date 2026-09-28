#!/usr/bin/env node
// scripts/test-financials-view.mjs
//
// The Financials tab (step 5 of the Project Workspace PRD, 2026-09-28):
// read-only, and every figure on it is the server's.
//
//   - GET /api/projects/:id/financials answers from lib/financials-view.js
//     over the rules that already exist: the job's invoices
//     (projects.invoicesForProject), a void invoice never owed, the deposit
//     lifecycle, the billing preview and the completion check's blockers.
//   - Its totals equal the same sums worked out HERE, independently, from
//     the invoice records: invoiced = sent/paid live invoices, received =
//     every live invoice's ledger, owed = what sent live invoices still
//     owe. A held (unsent) balance invoice is not owed; a void one is not
//     anything.
//   - The screen shows those figures, desktop and phone, adds nothing up
//     itself, and offers no action.
//
// Run: node scripts/test-financials-view.mjs   (also in build:check)
// Screenshots: FIN_SHOTS=<dir> node scripts/test-financials-view.mjs

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { bootServer, j } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const cents = (n) => Math.round((Number(n) || 0) * 100);
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SHOTS = process.env.FIN_SHOTS || "";
function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  return fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {};
}

// ---- the screen adds up nothing ----------------------------------------------------
{
  const tsx = fs.readFileSync(new URL("../admin-app/src/routes/Financials.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!/\.reduce\(/.test(tsx), "screen: no .reduce — the totals are the server's");
  ok(!/(total|owed|amountPaid|received|invoiced)\s*[+\-*]\s*[a-zA-Z(]/.test(tsx), "screen: no arithmetic on money fields");
  ok(!/method:\s*"(POST|PATCH|DELETE)"|\.post\(|\.patch\(|\.del\(/.test(tsx), "screen: read-only — it sends nothing");
  ok(/financialsApi\.get/.test(tsx), "screen: reads GET /api/projects/:id/financials");
  const main = fs.readFileSync(new URL("../admin-app/src/main.tsx", import.meta.url), "utf8");
  ok(/path="financials" element=\{<FinancialsTab \/>\}/.test(main), "the Financials route is the tab, not the placeholder");
  const dist = fs.readdirSync(new URL("../server/app-dist/assets/", import.meta.url)).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(new URL(`../server/app-dist/assets/${f}`, import.meta.url), "utf8")).join("\n");
  ok(dist.includes("Owed now") && dist.includes("/financials"), "the committed app build includes the tab");
}

const SIG = { customerName: "Wren Achterberg", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.21", userAgent: "test" };
const srv = await bootServer({ port: 4955 });
let browser;
try {
  await srv.login();
  const quotes = srv.lib("quotes.js");
  const invoices = srv.lib("invoices.js");
  const projects = srv.lib("projects.js");
  const customers = srv.lib("customers.js");
  const deposits = srv.lib("deposits.js");
  const users = srv.lib("users.js");

  let n = 0;
  async function signedJob(label, { deposit = true, billingMode = "fixed_price" } = {}) {
    n += 1;
    const cust = await customers.create({ name: `Wren ${label}`, email: `fin${n}.${Date.now()}@example.com`, phone: `90555588${String(n).padStart(2, "0")}` });
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
    await projects.update(proj.id, { status: "active", name: `Financials ${label}`, customerId: cust.id });
    return { label, cust, q, proj: await projects.get(proj.id), dep };
  }
  const fin = async (v) => (await srv.api("GET", `/api/projects/${v.proj.id}/financials`));
  // The same sums, worked out here from the invoice records themselves.
  function expectedTotals(quoteId) {
    const mine = srv.data("invoices").filter((i) => i.quoteId === quoteId);
    const live = mine.filter((i) => i.status !== "void");
    const issued = live.filter((i) => i.status !== "draft");
    const paidOf = (i) => (i.payments || []).reduce((s, p) => s + cents(p.amount), 0);
    return {
      invoiced: issued.reduce((s, i) => s + cents(i.total), 0) / 100,
      received: live.reduce((s, i) => s + paidOf(i), 0) / 100,
      // An invoice marked paid owes nothing, whatever the ledger holds.
      owed: issued.filter((i) => i.status !== "paid").reduce((s, i) => s + Math.max(0, cents(i.total) - paidOf(i)), 0) / 100
    };
  }

  // ---- A a deposit job: part paid, then paid, balance held ---------------------------
  const a = await signedJob("A");
  {
    const r0 = await fin(a);
    ok(r0.status === 200 && r0.body.ok, `A0: the route answers (${r0.status} ${j(r0.body?.errors)})`);
    let m = r0.body;
    ok(m.contract?.total === 5650 && m.billingMode === "fixed_price", `A0: the signed contract is $5,650.00 with HST (${j(m.contract)})`);
    ok(m.totals?.invoiced === a.dep.total && m.totals?.received === 0 && m.totals?.owed === a.dep.total,
      `A0: the deposit is invoiced and owed, nothing received (${j(m.totals)})`);
    ok(m.totals?.notYetInvoiced === Math.round((5650 - a.dep.total) * 100) / 100, `A0: the rest of the contract is not invoiced yet (${m.totals?.notYetInvoiced})`);
    ok(m.deposit?.stage === "awaiting_deposit" && m.deposit?.counted === false, `A0: the deposit is waiting (${j(m.deposit)})`);
    ok((m.holds || []).some((h) => h.key === "deposit_unpaid"), `A0: completion's "deposit unpaid" shows as a billing hold (${j(m.holds)})`);

    await srv.api("POST", `/api/invoices/${a.dep.id}/payments`, { amount: 1000, method: "e_transfer" });
    m = (await fin(a)).body;
    let exp = expectedTotals(a.q.id);
    ok(m.totals.received === 1000 && m.totals.owed === Math.round((a.dep.total - 1000) * 100) / 100, `A1: $1,000 received, the rest owed (${j(m.totals)})`);
    ok(m.totals.invoiced === exp.invoiced && m.totals.received === exp.received && m.totals.owed === exp.owed, `A1: the server's totals are the invoices' own sums (${j(m.totals)} vs ${j(exp)})`);
    ok(/1,000\.00/.test(m.deposit?.sentence || "") && /still owed/.test(m.deposit?.sentence || ""), `A1: the deposit sentence says what came in and what is owed (${m.deposit?.sentence})`);
    ok(m.payments?.length === 1 && m.payments[0].methodLabel === "e-Transfer", `A1: the payment is listed with its method (${j(m.payments)})`);

    // Mark the deposit paid (the path that counts it on main; Fix A makes
    // every path count it) — the held balance invoice appears, not owed.
    await srv.api("PATCH", `/api/invoices/${a.dep.id}`, { status: "paid" });
    m = (await fin(a)).body;
    exp = expectedTotals(a.q.id);
    const held = (m.invoices || []).find((i) => i.role === "balance");
    ok(held && held.held === true && held.statusLabel === "Held until completion" && held.issued === false, `A2: the balance invoice shows as held, not sent (${j(held)})`);
    ok(m.totals.owed === exp.owed && m.totals.invoiced === exp.invoiced && m.totals.drafts.count === 1, `A2: a held invoice is not owed or invoiced (${j(m.totals)} vs ${j(exp)})`);
    ok(m.deposit?.counted === true && !(m.holds || []).some((h) => h.key === "deposit_unpaid"), `A2: the deposit counts; the hold is gone (${j(m.deposit)})`);
    const depRow = (m.invoices || []).find((i) => i.id === a.dep.id);
    ok(depRow?.owed === 0 && /Marked paid/.test(depRow?.note || "") && /1,260\.00/.test(depRow?.note || ""),
      `A2: marked paid with $1,000 recorded → owes nothing, and says $1,260 isn't recorded as a payment (${j(depRow)})`);
    ok(m.totals.owed === 0, `A2: nothing is owed now (${m.totals.owed})`);
    // The workspace header's Billing card is the same model's answer.
    const head = (await srv.api("GET", `/api/projects/${a.proj.id}`)).body.billing;
    ok(head?.kind === "settled" && head.owed === m.totals.owed && head.received === m.totals.received && /3,390\.00 not invoiced yet/.test(head.hint),
      `A2: the header's Billing agrees with the tab — nothing owed, $3,390 not invoiced yet, never the held invoice as "outstanding" (${j(head)})`);
    ok(head?.actionInvoice === null, `A2: …and the next step is not "collect payment" on the held invoice (${j(head?.actionInvoice)})`);
  }

  // ---- V a void invoice is shown, never owed -----------------------------------------
  const v = await signedJob("V");
  {
    const dup = await invoices.createDraft({
      quoteId: v.q.id, customerId: v.cust.id, customerEmail: v.cust.email, customerName: v.cust.name,
      lineItems: [{ key: "quote_deposit", label: "Deposit (duplicate)", qty: 1, price: 2000 }], invoiceRole: "deposit"
    });
    await srv.api("PATCH", `/api/invoices/${dup.id}`, { status: "sent" });
    await srv.api("POST", `/api/invoices/${dup.id}/void`, { reason: "duplicate" });
    const m = (await fin(v)).body;
    const row = (m.invoices || []).find((i) => i.id === dup.id);
    const exp = expectedTotals(v.q.id);
    ok(row && row.live === false && row.owed === 0 && row.statusLabel === "Void", `V1: the void invoice is listed as Void, owing nothing (${j(row)})`);
    ok(m.totals.owed === exp.owed && m.totals.owed === v.dep.total && m.totals.voidCount === 1, `V1: only the live deposit is owed (${j(m.totals)})`);
  }

  // ---- T time & materials: no "not yet invoiced", and a preview that can't bill ------
  const t = await signedJob("T", { deposit: false, billingMode: "time_and_material" });
  {
    const m = (await fin(t)).body;
    ok(m.billingMode === "time_and_material" && m.totals.notYetInvoiced === null, `T1: a T&M job claims no "not yet invoiced" figure (${j(m.totals)})`);
    ok(m.preview?.error && /labour rate/i.test(m.preview.error), `T1: with no labour rate, the preview says it can't bill (${j(m.preview)})`);
    ok((m.holds || []).some((h) => h.key === "no_labour_rate") || m.preview?.error, `T1: …and says why (${j(m.holds)})`);
    ok((m.invoices || []).length === 0, "T1: no invoices yet");
  }

  // ---- The screen, desktop and phone -------------------------------------------------
  await users.create({ email: "fin-screen@pjl.test", name: "Odessa Brightwater", role: "admin", password: "fin-screen-12345" });
  const login = await fetch(`${srv.BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fin-screen@pjl.test", password: "fin-screen-12345" }) });
  const cookieValue = ((login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "").slice("pjl_crm_session=".length);
  ok(Boolean(cookieValue), "screen: logged in");
  browser = await chromium.launch(chromiumLaunchOpts());
  const model = (await fin(a)).body;
  for (const [name, viewport] of [["desktop", { width: 1280, height: 1400 }], ["phone", { width: 390, height: 1600 }]]) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies([{ name: "pjl_crm_session", value: cookieValue, domain: "127.0.0.1", path: "/" }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(a.proj.id)}/financials`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=fin-totals]", { timeout: 15000 });
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    ok(text.includes(money(model.contract.total)) && text.includes(money(model.totals.received)) && text.includes(money(model.totals.owed)),
      `${name}: the contract, received and owed figures on screen are the server's (${money(model.contract.total)} / ${money(model.totals.received)} / ${money(model.totals.owed)})`);
    ok(/held until completion/i.test(text) && /deposit paid/i.test(text), `${name}: the held balance invoice and the deposit stage are shown`);
    // The header above the tab says the same thing.
    const header = (await page.locator("text=Billing").first().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok(/none owed/i.test(header) && !/outstanding/i.test(header), `${name}: the header's Billing card agrees — "None owed", not "outstanding" (${header})`);
    ok((await page.locator("[data-testid=fin-invoice]").count()) === model.invoices.length, `${name}: every invoice is listed`);
    ok(!/Record payment|Mark paid|Send invoice/i.test(text.replace("Record payments on the classic pages", "")), `${name}: no action buttons — read-only`);
    const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    ok(overflow === 0, `${name}: no sideways scrolling (${overflow}px)`);
    ok(errors.length === 0, `${name}: no page errors (${j(errors)})`);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `financials-deposit-${name}.png`), fullPage: true });
      await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(v.proj.id)}/financials`, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-testid=fin-totals]", { timeout: 15000 });
      await page.screenshot({ path: path.join(SHOTS, `financials-void-${name}.png`), fullPage: true });
      await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(t.proj.id)}/financials`, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-testid=fin-totals]", { timeout: 15000 });
      await page.screenshot({ path: path.join(SHOTS, `financials-tm-${name}.png`), fullPage: true });
    }
    await ctx.close();
  }
} finally {
  try { await browser?.close(); } catch {}
  await srv.stop();
}

console.log(`\nfinancials view: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

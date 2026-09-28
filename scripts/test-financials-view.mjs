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
//   - The screen adds nothing up itself and offers no action (source
//     checks, always), and shows those figures desktop and phone (a real
//     browser, with --screen).
//
// Run: node scripts/test-financials-view.mjs   (in build:check — the CI
//      runner has no browser, like the other *-tab screen tests)
// Screen: npm run test:financials-tab-screen   (= … --screen; needs Chromium)
// Screenshots: FIN_SHOTS=<dir> npm run test:financials-tab-screen

import fs from "node:fs";
import path from "node:path";
import { bootServer, j } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const cents = (n) => Math.round((Number(n) || 0) * 100);
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SHOTS = process.env.FIN_SHOTS || "";
const SCREEN = process.argv.includes("--screen");
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
  // An invoice marked Paid with its payments short, as the old "Mark paid"
  // left it (the route refuses it now) — written straight to the store.
  function forcePaid(id) {
    const f = path.join(srv.DATA, "invoices.json");
    const all = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = all.find((x) => x.id === id);
    r.status = "paid"; r.paidAt = r.paidAt || new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
  }
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

    // "Mark paid" with $1,000 of the deposit recorded is refused (#350) …
    const mk = await srv.api("PATCH", `/api/invoices/${a.dep.id}`, { status: "paid" });
    ok(mk.status === 409 && mk.body.code === "record_payment_required", `A2: Mark paid on a part-paid deposit is refused (${mk.status} ${mk.body.code})`);
    // … but one marked Paid before that rule is in payment reconciliation.
    forcePaid(a.dep.id);
    m = (await fin(a)).body;
    let depRow = (m.invoices || []).find((i) => i.id === a.dep.id);
    ok(depRow?.reconciliationRequired === true && depRow.unresolved === 1260 && depRow.owed === null && depRow.amountPaid === 1000 && depRow.statusLabel === "Payment reconciliation required",
      `A2: marked Paid with $1,000 of $2,260: $1,260 unresolved, owed not determined, status "Payment reconciliation required" (${j(depRow)})`);
    ok(m.totals.received === 1000 && m.totals.unresolved === 1260 && m.totals.owedDetermined === false && m.totals.owed === 0,
      `A2: received is the ledger's $1,000; the $1,260 is neither received nor owed (${j(m.totals)})`);
    ok(m.deposit?.counted === false && /not satisfied/i.test(m.deposit?.sentence || ""), `A2: the deposit is NOT satisfied (${j(m.deposit)})`);
    ok(!(m.invoices || []).some((i) => i.role === "balance"), "A2: …and no balance invoice is released");
    ok((m.holds || []).some((h) => h.key === "payment_reconciliation_required"), `A2: completion's reconciliation block is a billing hold (${j(m.holds)})`);
    let head = (await srv.api("GET", `/api/projects/${a.proj.id}`)).body.billing;
    ok(head?.kind === "reconcile" && head.hint === "⚠ Payment reconciliation required · $1,260.00 unresolved" && head.actionInvoice?.reconciliationRequired === true && head.actionInvoice.balanceDue === 0,
      `A2: the header says "⚠ Payment reconciliation required · $1,260.00 unresolved", nothing to collect (${j(head)})`);

    // Reconciled by recording the missing payment: satisfied, balance held.
    await srv.api("POST", `/api/invoices/${a.dep.id}/payments`, { amount: 1260, method: "cheque", notes: "ref #4471" });
    m = (await fin(a)).body;
    exp = expectedTotals(a.q.id);
    const held = (m.invoices || []).find((i) => i.role === "balance");
    ok(held && held.held === true && held.statusLabel === "Held until completion" && held.issued === false, `A3: once reconciled, the balance invoice shows as held, not sent (${j(held)})`);
    ok(m.totals.owed === exp.owed && m.totals.invoiced === exp.invoiced && m.totals.drafts.count === 1 && m.totals.unresolved === 0 && m.totals.owedDetermined === true,
      `A3: a held invoice is not owed or invoiced; nothing unresolved (${j(m.totals)} vs ${j(exp)})`);
    ok(m.deposit?.counted === true && !(m.holds || []).some((h) => h.key === "deposit_unpaid" || h.key === "payment_reconciliation_required"), `A3: the deposit counts; the holds are gone (${j(m.deposit)})`);
    depRow = (m.invoices || []).find((i) => i.id === a.dep.id);
    ok(depRow?.reconciliationRequired === false && depRow.lastReconciliation?.resolution === "recorded_payment" && /reconciliation resolved/i.test(depRow.note || ""),
      `A3: the invoice shows how it was reconciled, and by whom (${j(depRow)})`);
    head = (await srv.api("GET", `/api/projects/${a.proj.id}`)).body.billing;
    ok(head?.kind === "settled" && head.owed === m.totals.owed && head.received === m.totals.received && /3,390\.00 not invoiced yet/.test(head.hint),
      `A3: the header's Billing agrees with the tab — nothing owed, $3,390 not invoiced yet, never the held invoice as "outstanding" (${j(head)})`);
    ok(head?.actionInvoice === null, `A3: …and the next step is not "collect payment" on the held invoice (${j(head?.actionInvoice)})`);
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

  // ---- M THE case: $1,260 invoice, $1,000 recorded, status Paid, $260 unresolved ------
  // Patrick, 2026-09-28: it must show Received $1,000 · Unresolved $260 ·
  // Status: Payment reconciliation required · Customer amount owed: not
  // determined until reconciled — never "None owed".
  const mj = await signedJob("M", { deposit: false });
  let mInv;
  {
    mInv = await invoices.createDraft({
      projectId: mj.proj.id, customerId: mj.cust.id, customerEmail: mj.cust.email, customerName: mj.cust.name,
      lineItems: [{ key: "custom", label: "Mid-job progress billing", qty: 1, price: deposits.preTaxForTotal(1260) }]
    });
    await srv.api("PATCH", `/api/invoices/${mInv.id}`, { status: "sent" });
    await srv.api("POST", `/api/invoices/${mInv.id}/payments`, { amount: 1000, method: "cheque" });
    const mk = await srv.api("PATCH", `/api/invoices/${mInv.id}`, { status: "paid" });
    ok(mk.status === 409 && mk.body.code === "record_payment_required", `M0: Mark paid is refused going forward (${mk.status} ${mk.body.code})`);
    forcePaid(mInv.id); // as the old "Mark paid" left it
    const m = (await fin(mj)).body;
    const row = (m.invoices || []).find((i) => i.id === mInv.id);
    const r = m.reconciliation?.[0] || {};
    ok(row?.total === 1260 && row.amountPaid === 1000 && row.status === "paid", `M0: a $1,260 invoice, $1,000 recorded, status Paid (${j(row && { total: row.total, paid: row.amountPaid, status: row.status })})`);
    ok(r.received === 1000 && r.unresolved === 260 && r.status === "Payment reconciliation required" && r.customerOwes === "Not determined until reconciled",
      `M1: Received $1,000 · Unresolved $260 · Status: Payment reconciliation required · Customer amount owed: not determined (${j(r)})`);
    ok(row?.unresolved === 260 && row.owed === null && row.statusLabel === "Payment reconciliation required", `M1: …on the invoice too (${j(row)})`);
    ok(m.totals.received === 1000 && m.totals.unresolved === 260 && m.totals.owedDetermined === false && m.totals.owed === 0,
      `M2: the $260 is not counted as received, nor as owed; owed is not determined (${j(m.totals)})`);
    ok(/\$1,000\.00/.test(r.sentence || "") && /\$1,260\.00/.test(r.sentence || "") && /\$260\.00 unresolved/.test(r.sentence || ""), `M2: the sentence names what was recorded, the total and the $260 (${r.sentence})`);
    const head = (await srv.api("GET", `/api/projects/${mj.proj.id}`)).body.billing;
    ok(head?.kind === "reconcile" && head.hint === "⚠ Payment reconciliation required · $260.00 unresolved" && head.unresolved === 260,
      `M3: the header shows "⚠ Payment reconciliation required · $260.00 unresolved" — never "None owed" (${j(head)})`);
    ok(head?.actionInvoice?.id === mInv.id && head.actionInvoice.reconciliationRequired === true && head.actionInvoice.balanceDue === 0,
      `M3: …and its next step is reconciling, with no balance to collect (${j(head?.actionInvoice)})`);
    ok(((await fin(v)).body.reconciliation || []).length === 0, "M4: a job with nothing marked Paid short flags nothing");
  }

  // ---- The screen, desktop and phone (--screen) ---------------------------------------
  if (SCREEN) {
  const { chromium } = await import("playwright");
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
    // The $260 gap is visible: a warning card at the top and a flag on the invoice.
    await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(mj.proj.id)}/financials`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=fin-unrecorded]", { timeout: 15000 });
    const card = (await page.locator("[data-testid=fin-unrecorded]").innerText()).replace(/\s+/g, " ");
    const pill = await page.locator("[data-testid=fin-unrecorded-pill]").first().innerText();
    ok(/\$260\.00 not recorded/i.test(card) && /\$1,000\.00/.test(card) && /\$1,260\.00/.test(card),
      `${name}: the warning card shows the $260 gap and what it came from (${card})`);
    ok(/\$260\.00 not recorded/i.test(pill) && (await page.locator("[data-testid=fin-unrecorded-pill]").first().isVisible()),
      `${name}: the invoice carries a visible "$260.00 not recorded" flag (${pill})`);
    ok(/Received \$1,000\.00/i.test(card) && /Unresolved \$260\.00/i.test(card) && /Status Payment reconciliation required/i.test(card) && /Customer amount owed Not determined until reconciled/i.test(card),
      `${name}: the card reads Received $1,000 · Unresolved $260 · Status: Payment reconciliation required · Customer amount owed: not determined (${card})`);
    const firstCard = (await page.locator("main [data-testid=fin-unrecorded]").first().boundingBox())?.y ?? 9e9;
    const totalsY = (await page.locator("[data-testid=fin-totals]").boundingBox())?.y ?? 0;
    ok(firstCard < totalsY, `${name}: the red warning comes first on the tab, above the totals (${firstCard} < ${totalsY})`);
    const mHeader = (await page.locator("text=Billing").first().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok(/⚠ Payment reconciliation required · \$260\.00 unresolved/.test(mHeader) && !/none owed|outstanding/i.test(mHeader),
      `${name}: the header reads "⚠ Payment reconciliation required · $260.00 unresolved", never "None owed" (${mHeader})`);
    // Truncation hides text without removing it, so innerText alone can't see
    // a clipped "$260.00": the reconciliation line must fit, not be ellipsised.
    const hintClip = await page.locator("text=Billing").first().locator("xpath=..").evaluate((el) =>
      [...el.querySelectorAll("span")].filter((s) => /reconciliation required/i.test(s.textContent || ""))
        .map((s) => ({ text: s.textContent, clipped: s.scrollWidth > s.clientWidth + 1 })));
    ok(hintClip.length > 0 && hintClip.every((h) => !h.clipped),
      `${name}: the header's reconciliation line is shown in full, amount included — not cut off (${j(hintClip)})`);
    const owedStat = (await page.locator("text=Owed now").first().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok(/Not determined/i.test(owedStat), `${name}: "Owed now" is Not determined (${owedStat})`);
    const owedClip = await page.locator("text=Owed now").first().locator("xpath=..").evaluate((el) =>
      [...el.querySelectorAll("span")].map((s) => ({ text: s.textContent, clipped: s.scrollWidth > s.clientWidth + 1 })).filter((s) => s.clipped));
    ok(owedClip.length === 0, `${name}: "Owed now — Not determined" and its reason are shown in full, not cut off (${j(owedClip)})`);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `financials-unrecorded-${name}.png`), fullPage: true });
      await page.goto(`${srv.BASE}/app/projects/${encodeURIComponent(a.proj.id)}/financials`, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-testid=fin-totals]", { timeout: 15000 });
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
  }
} finally {
  try { await browser?.close(); } catch {}
  await srv.stop();
}

console.log(`\nfinancials view${SCREEN ? " + screen" : ""}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

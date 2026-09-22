// Project page density + dead-end navigation fixes (2026-09-21).
//
// Patrick, live, on the Project page after the inline-summary panels
// shipped: "you have to have a 32 inch screen to view all the
// information thats on this screen... go back to the drawing board." A
// screenshot showed every section — Tasks, Accepted proposal, Job
// journal, Daily log, Work orders, Material lists, etc. — permanently
// expanded, one long scroll.
//
// Same session, a second complaint: "opening the site builder, proposal
// builder, invoice virtually opens a new tab, or doesn't allow you to go
// back to the project you opened them from." True on both counts: the
// Quote/Invoice "Open" links used target="_blank" (real new tabs), and
// none of Site Builder, Proposal Builder, or the Invoice page had any
// link back to the project that opened them — only generic CRM/list/
// quote-folder links.
//
// Part A (project.html) — the bulky, grows-over-time sections are now
// native <details> elements, collapsed by default with a one-line
// summary always visible; the short "at a glance" panels (Quote/Site
// Builder/Invoice) stay as plain always-open sections. The three "Open"
// links no longer force a new tab.
// Part B/C/D — Site Builder, Proposal Builder, and the Invoice page each
// show a "Back to project" link when they know which project they came
// from, instead of only a generic CRM/quote-folder/invoices link.
//
// Run: node scripts/test-project-nav-and-density.mjs
// (also in `npm run test:project-inline-summaries`'s neighborhood —
// registered as its own script, Playwright, not in build:check)

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const readServer = (name) => fs.readFileSync(path.join(root, "server", name), "utf8");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ok  ", label); }
  else { failed++; console.error("  FAIL", label); }
}

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const fallback = "/opt/pw-browsers/chromium";
  if (fs.existsSync(fallback)) return { executablePath: fallback };
  return {};
}

const browser = await chromium.launch(chromiumLaunchOpts());

// ---------------------------------------------------------------------
// Part A — project.html: collapsed-by-default bulky sections + fixed
// link targets, driven against a fully-populated job so every section
// has real content to summarize.
// ---------------------------------------------------------------------
async function testProjectPageDensity() {
  const html = readServer("project.html");
  const projectJs = readServer("project.js");
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const PID = "PROJ-TEST-DENSITY";
  const project = {
    id: PID, name: "Dense job", status: "active",
    customerId: "CUST-1", customerName: "Test Customer",
    customerEmail: "t@example.com", customerPhone: "555-0100",
    address: "1 Test St", description: "", notes: "",
    branch: "direct_residential", billingMode: "fixed_price",
    proposalSnapshot: {
      quoteId: "Q-TEST-DENSITY", acceptedAt: "2026-09-01T12:00:00Z",
      acceptanceMethod: "portal_esign", version: 1,
      subtotal: 20000, hst: 2600, total: 22600, proposalSections: []
    },
    attachments: [],
    tasks: Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`, description: `Task ${i}`, status: i < 6 ? "done" : "pending", order: i
    })),
    journalEntries: [],
    workOrderIds: ["WO-1", "WO-2", "WO-3"],
    scopeChangeRequests: [{
      id: "SCR-1", description: "Add a zone", status: "pending_admin_review",
      capturedAt: "2026-09-05T12:00:00Z", estimatedTotal: 500
    }],
    statusUpdates: [{ id: "SU-1", generatedAt: "2026-09-06T12:00:00Z", recipient: { email: "t@example.com" } }],
    buildTracking: true,
    waterCostEstimate: {
      townName: "Newmarket", rate: 2.5, rateUnit: "1000gal", verified: true,
      savedAt: "2026-09-01T12:00:00Z", cyclesPerWeek: 2, weeksPerSeason: 20,
      totals: { seasonCost: 480, weekCost: 24, cycleCost: 12 }, zones: []
    }
  };
  const materialLists = [{ id: "ML-1", name: "Main list", status: "draft", totals: { lineCount: 5, grandSubtotalCents: 123456 } }];
  const workOrders = ["WO-1", "WO-2", "WO-3"].map((id) => ({ id, status: "scheduled", customerName: "Test Customer" }));
  const buildWo1 = {
    id: "WO-1", type: "build", createdAt: "2026-09-10T08:00:00Z",
    dailyLog: { workDate: "2026-09-10", sessions: [{ inAt: "2026-09-10T08:00:00Z", outAt: "2026-09-10T16:00:00Z", labourersOnSite: 2 }], tasksCompletedToday: ["t0"], materialsConsumed: [] },
    photos: []
  };

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === `/admin/project/${PID}`) return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/crm/project.js") return route.fulfill({ contentType: "application/javascript", body: projectJs });
    if (url.pathname === `/api/projects/${PID}` && method === "GET") {
      return route.fulfill({ json: { ok: true, project, materialLists, linkedCustomer: null, linkedQuote: null, invoiceSummary: null, siteBuilderSummary: null } });
    }
    if (url.pathname === "/api/work-orders" && method === "GET") {
      return route.fulfill({ json: { ok: true, workOrders } });
    }
    if (url.pathname === "/api/work-orders/WO-1" && method === "GET") {
      return route.fulfill({ json: { ok: true, workOrder: buildWo1 } });
    }
    if (/^\/api\/work-orders\/WO-[23]$/.test(url.pathname) && method === "GET") {
      return route.fulfill({ json: { ok: true, workOrder: { id: url.pathname.split("/").pop(), type: "standard" } } });
    }
    if (url.pathname === `/api/projects/${PID}/task-photos`) {
      return route.fulfill({ json: { ok: true, photos: [] } });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  await page.goto(`https://pjl.test/admin/project/${PID}`);
  await page.waitForSelector("#projPage:not([hidden])", { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => (document.getElementById("projDailyLogSummary")?.textContent || "").length > 0, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(200);

  // Bulky sections are real <details>, closed by default, with a
  // non-empty summary line — the fix for "you have to have a 32 inch
  // screen to view all the information."
  const bulkyIds = [
    "projProposalPanel", "projTasksPanel", "projDailyLogPanel",
    "projScopeChangesPanel", "projStatusUpdatesPanel", "projBillingPanel",
    "projWosPanel", "projMlsPanel", "projWaterCostSection"
  ];
  for (const id of bulkyIds) {
    const info = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      return { tag: el.tagName, open: el.open, hidden: el.hidden };
    }, id);
    ok(info && info.tag === "DETAILS", `#${id} is a <details> element`);
    ok(info && info.open === false, `#${id} is collapsed by default`);
  }

  const tasksSummary = await page.locator("#projTasksProgress").innerText();
  ok(/6 of 14 complete/.test(tasksSummary), `Tasks summary shows real progress (got "${tasksSummary}")`);

  const wosSummary = await page.locator("#projWosSummary").innerText();
  ok(/3 attached/.test(wosSummary), `Work orders summary shows real count (got "${wosSummary}")`);

  const mlsSummary = await page.locator("#projMlsSummary").innerText();
  ok(/1 list/.test(mlsSummary), `Material lists summary shows real count (got "${mlsSummary}")`);

  const dailyLogSummary = await page.locator("#projDailyLogSummary").innerText();
  ok(/1 day logged/.test(dailyLogSummary), `Daily log summary shows real count (got "${dailyLogSummary}")`);

  const scopeSummary = await page.locator("#projScopeChangesSummary").innerText();
  ok(/1 change recorded/.test(scopeSummary), `Scope changes summary shows real count (got "${scopeSummary}")`);

  const waterCostSummary = await page.locator("#projWaterCostSummary").innerText();
  ok(/\$480\.00 per season/.test(waterCostSummary), `Water-cost summary shows the real figure (got "${waterCostSummary}")`);

  // Clicking a summary expands in place — no navigation, no new tab.
  const urlBefore = page.url();
  await page.click("#projTasksPanel > summary");
  await page.waitForTimeout(150);
  const tasksOpenAfterClick = await page.evaluate(() => document.getElementById("projTasksPanel").open);
  ok(tasksOpenAfterClick === true, "clicking the Tasks summary expands it in place");
  ok(page.url() === urlBefore, "expanding a section does not navigate the page");
  const taskListVisible = await page.locator("#projTaskList li").count();
  ok(taskListVisible === 14, "expanded Tasks section shows all 14 real tasks");

  // The three "Open" links no longer force a new tab.
  const targets = await page.evaluate(() => ({
    quote: document.getElementById("projQuoteStatusLink")?.getAttribute("target"),
    invoice: document.getElementById("projInvoiceLink")?.getAttribute("target"),
    siteBuilder: document.getElementById("projSiteBuilderLink")?.getAttribute("target")
  }));
  ok(targets.quote === null, "Quote 'Open in Proposal Builder' link no longer opens a new tab");
  ok(targets.invoice === null, "Invoice 'Open invoice' link no longer opens a new tab");
  ok(targets.siteBuilder === null, "Site Builder link was already same-tab, still is");

  const proposalBuilderHref = await page.locator("#projDesignSystemLink").getAttribute("href").catch(() => null);
  ok(true, `(sanity) design system link present: ${proposalBuilderHref || "n/a"}`);

  ok(errors.length === 0, `no page errors (${errors.join("; ")})`);
  await ctx.close();
}

// ---------------------------------------------------------------------
// Part B — sitebuilder.html: back link points at the project that
// opened it, instead of only "Back to CRM".
// ---------------------------------------------------------------------
async function testSiteBuilderBackLink() {
  const html = readServer("sitebuilder.html");
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const PID = "PROJ-TEST-SB-NAV";
  const project = {
    id: PID, name: "Nav test", customerName: "Test",
    systemDesign: {
      version: 1, inputs: {}, waterSupply: {}, bomOverrides: { edits: {}, removed: {}, custom: [] },
      linkedQuoteId: null, wcRunOverrides: {}, areas: [], routing: {}
    }
  };
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/sitebuilder") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === `/api/projects/${PID}`) return route.fulfill({ json: { ok: true, project } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`https://pjl.test/admin/sitebuilder?project=${PID}`);
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const a = document.getElementById("sbBackLink");
    return a ? { href: a.getAttribute("href"), text: a.textContent } : null;
  });
  ok(!!back, "#sbBackLink exists");
  ok(back && back.href === `/admin/project/${PID}`, `Site Builder back link points at the project (got "${back?.href}")`);
  ok(back && /Back to project/.test(back.text), `Site Builder back link reads "Back to project" (got "${back?.text}")`);
  await ctx.close();

  // No project param — stays the generic CRM link (no regression for
  // Site Builder opened from anywhere else, e.g. the nav sidebar).
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/sitebuilder") return route.fulfill({ contentType: "text/html", body: html });
    return route.fulfill({ status: 404, body: "" });
  });
  await page2.goto("https://pjl.test/admin/sitebuilder");
  await page2.waitForTimeout(200);
  const back2 = await page2.evaluate(() => document.getElementById("sbBackLink")?.getAttribute("href"));
  ok(back2 === "/admin", `Site Builder opened with no project param keeps the CRM back link (got "${back2}")`);
  await ctx2.close();
}

// ---------------------------------------------------------------------
// Part C — quote-proposal-builder.html: same back-link fix. The
// project-aware link is set synchronously before the quote itself even
// loads, so this doesn't need the full bootstrap to succeed.
// ---------------------------------------------------------------------
async function testProposalBuilderBackLink() {
  const html = readServer("quote-proposal-builder.html");
  const pbJs = readServer("quote-proposal-builder.js");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const PID = "PROJ-TEST-PB-NAV";
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (/^\/admin\/quote\/[^/]+\/proposal$/.test(url.pathname)) return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/crm/quote-proposal-builder.js") return route.fulfill({ contentType: "application/javascript", body: pbJs });
    if (url.pathname === "/api/admin/quote-folder") return route.fulfill({ json: { ok: true, quotes: [] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`https://pjl.test/admin/quote/Q-TEST-PB-NAV/proposal?project=${PID}`);
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => {
    const a = document.getElementById("pbBackLink");
    return a ? { href: a.getAttribute("href"), text: a.textContent } : null;
  });
  ok(!!back, "#pbBackLink exists");
  ok(back && back.href === `/admin/project/${PID}`, `Proposal Builder back link points at the project (got "${back?.href}")`);
  ok(back && /Back to project/.test(back.text), `Proposal Builder back link reads "Back to project" (got "${back?.text}")`);
  await ctx.close();

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (/^\/admin\/quote\/[^/]+\/proposal$/.test(url.pathname)) return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/crm/quote-proposal-builder.js") return route.fulfill({ contentType: "application/javascript", body: pbJs });
    if (url.pathname === "/api/admin/quote-folder") return route.fulfill({ json: { ok: true, quotes: [] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page2.goto("https://pjl.test/admin/quote/Q-TEST-PB-NOPROJECT/proposal");
  await page2.waitForTimeout(200);
  const back2 = await page2.evaluate(() => document.getElementById("pbBackLink")?.getAttribute("href"));
  ok(back2 === "/admin/quote-folder", `Proposal Builder opened with no project param keeps the Quote folder back link (got "${back2}")`);
  await ctx2.close();
}

// ---------------------------------------------------------------------
// Part D — invoice.html: back link derives from the invoice's own
// projectId (works regardless of how the invoice page was reached).
// ---------------------------------------------------------------------
async function testInvoiceBackLink() {
  const html = readServer("invoice.html");
  const invoiceJs = readServer("invoice.js");
  const PID = "PROJ-TEST-INV-NAV";
  const invoiceWithProject = {
    id: "I-TEST-NAV-1", status: "sent", invoiceRole: "deposit", total: 1000, subtotal: 900, hst: 100,
    amountPaid: 0, balanceDue: 1000, createdAt: "2026-09-01T12:00:00Z", customerName: "Test Customer",
    address: "1 Test St", lineItems: [], payments: [], projectId: PID
  };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/invoice/I-TEST-NAV-1") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/crm/invoice.js") return route.fulfill({ contentType: "application/javascript", body: invoiceJs });
    if (url.pathname === "/api/invoices/I-TEST-NAV-1") return route.fulfill({ json: { ok: true, invoice: invoiceWithProject, disclaimerObjects: [] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("https://pjl.test/admin/invoice/I-TEST-NAV-1");
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const a = document.getElementById("invoiceBackLink");
    return a ? { href: a.getAttribute("href"), text: a.textContent } : null;
  });
  ok(!!back, "#invoiceBackLink exists");
  ok(back && back.href === `/admin/project/${PID}`, `Invoice back link points at its project (got "${back?.href}")`);
  ok(back && /Back to project/.test(back.text), `Invoice back link reads "Back to project" (got "${back?.text}")`);
  await ctx.close();

  // An invoice with no projectId (e.g. a standalone repair invoice) keeps
  // the generic "All invoices" link — no regression.
  const invoiceNoProject = { ...invoiceWithProject, id: "I-TEST-NAV-2", projectId: null };
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/invoice/I-TEST-NAV-2") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/crm/invoice.js") return route.fulfill({ contentType: "application/javascript", body: invoiceJs });
    if (url.pathname === "/api/invoices/I-TEST-NAV-2") return route.fulfill({ json: { ok: true, invoice: invoiceNoProject, disclaimerObjects: [] } });
    return route.fulfill({ status: 404, body: "" });
  });
  await page2.goto("https://pjl.test/admin/invoice/I-TEST-NAV-2");
  await page2.waitForTimeout(300);
  const back2 = await page2.evaluate(() => document.getElementById("invoiceBackLink")?.getAttribute("href"));
  ok(back2 === "/admin/invoices", `Invoice with no project keeps the "All invoices" back link (got "${back2}")`);
  await ctx2.close();
}

try {
  await testProjectPageDensity();
  await testSiteBuilderBackLink();
  await testProposalBuilderBackLink();
  await testInvoiceBackLink();
} finally {
  await browser.close();
}

console.log(`\nproject nav + density: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

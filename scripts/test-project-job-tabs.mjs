// Job tabs on the Project page (2026-09-21).
//
// Patrick: "I think if we did something where at the top of the screen
// there are tabs, almost like a web browser... Project, Site Builder,
// Parts List, Quote, Invoice." This walks the REAL server/project.html +
// project.js in headless Chromium (every /api call mocked) and checks
// each tab resolves to the right record for the job, or greys out with a
// reason when this job doesn't have one yet — rather than hand-simulating
// the render logic in Node.
//
// Run:  node scripts/test-project-job-tabs.mjs   (also in build:check;
//       needs `npx playwright install chromium` once)

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'server', 'project.html'), 'utf8');
const projectJs = fs.readFileSync(path.join(here, '..', 'server', 'project.js'), 'utf8');

const PROJECT_ID = 'PROJ-TEST-TABS';

function blankProject(overrides = {}) {
  return {
    id: PROJECT_ID,
    name: 'Tab walk',
    status: 'active',
    customerName: 'Test Customer',
    customerEmail: '',
    customerPhone: '',
    propertyId: null,
    address: '1 Test Rd',
    description: '',
    notes: '',
    systemDesign: null,
    tasks: [],
    attachments: [],
    proposalSnapshot: null,
    journalEntries: [],
    scopeChangeRequests: [],
    statusUpdates: [],
    workOrderIds: [],
    sourceQuoteId: null,
    finalInvoiceId: null,
    buildTracking: false,
    branch: null,
    billingMode: null,
    labourRateLocked: null,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

// PW_CHROMIUM overrides explicitly; otherwise use the sandbox's
// pre-installed browser at a fixed path IF it's actually there (this
// container's node_modules/playwright can drift ahead of the browser
// revision cached on disk — see /root/.ccr/README.md); on a real CI
// runner that installed browsers matching its own playwright version,
// neither condition holds and Playwright resolves its own default.
function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const sandboxChromium = '/opt/pw-browsers/chromium';
  if (fs.existsSync(sandboxChromium)) return { executablePath: sandboxChromium };
  return {};
}

async function withPage(mockProject, mockMaterialLists, mockLinkedQuote, fn) {
  const browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const m = route.request().method();
    if (url.pathname === `/admin/project/${PROJECT_ID}`) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/crm/project.js') return route.fulfill({ contentType: 'application/javascript', body: projectJs });
    if (url.pathname === `/api/projects/${PROJECT_ID}` && m === 'GET') {
      return route.fulfill({ json: { ok: true, project: mockProject, materialLists: mockMaterialLists, linkedCustomer: null, linkedQuote: mockLinkedQuote } });
    }
    if (url.pathname === '/api/work-orders' && m === 'GET') return route.fulfill({ json: { ok: true, workOrders: [] } });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`http://pjl.test/admin/project/${PROJECT_ID}`);
  await page.waitForSelector('#projPage:not([hidden])');
  const result = await fn(page);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  return result;
}

const readTabs = () => ({
  siteBuilder: { href: document.getElementById('projTabSiteBuilder').getAttribute('href'), disabled: document.getElementById('projTabSiteBuilder').classList.contains('is-disabled') },
  partsList: { href: document.getElementById('projTabPartsList').getAttribute('href'), disabled: document.getElementById('projTabPartsList').classList.contains('is-disabled') },
  quote: { href: document.getElementById('projTabQuote').getAttribute('href'), disabled: document.getElementById('projTabQuote').classList.contains('is-disabled') },
  invoice: { href: document.getElementById('projTabInvoice').getAttribute('href'), disabled: document.getElementById('projTabInvoice').classList.contains('is-disabled') }
});

// ---- 1. A brand-new job — nothing exists yet except the project --------
await withPage(blankProject(), [], null, async (page) => {
  const tabs = await page.evaluate(readTabs);
  check(tabs.siteBuilder.href === `/admin/sitebuilder?project=${PROJECT_ID}` && !tabs.siteBuilder.disabled, 'Site Builder tab always reachable, even with no design yet');
  check(tabs.partsList.disabled, 'Parts List tab greys out — no material list yet');
  check(tabs.quote.disabled, 'Quote tab greys out — no quote yet');
  check(tabs.invoice.disabled, 'Invoice tab greys out — no invoice yet');
});

// ---- 2. Fully populated job — every tab resolves to the real record ----
await withPage(
  blankProject({ finalInvoiceId: 'I-2026-0099' }),
  [
    { id: 'ML-2026-0001', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'ML-2026-0002', updatedAt: '2026-09-15T00:00:00Z' } // newer — should win
  ],
  { id: 'Q-2026-0050', version: 3, status: 'sent', type: 'project_proposal', presentationMode: 'summary', confirmed: true, depositInvoiceId: 'I-2026-0010', chain: [] },
  async (page) => {
    const tabs = await page.evaluate(readTabs);
    check(tabs.siteBuilder.href === `/admin/sitebuilder?project=${PROJECT_ID}`, 'Site Builder tab carries the project id');
    check(!tabs.partsList.disabled && tabs.partsList.href === '/admin/material-list/ML-2026-0002', 'Parts List tab picks the MOST RECENTLY UPDATED list, not just the first');
    check(!tabs.quote.disabled && tabs.quote.href === '/admin/quote/Q-2026-0050/proposal', 'Quote tab resolves to the live linked quote');
    check(!tabs.invoice.disabled && tabs.invoice.href === '/admin/invoice/I-2026-0099', "Invoice tab prefers the project's finalInvoiceId over the quote's deposit invoice");
  }
);

// ---- 3. Mid-job: a quote exists (with a deposit invoice) but the job ---
// hasn't been completed yet — no finalInvoiceId. The deposit invoice is
// the right thing to show, not a disabled tab.
await withPage(
  blankProject(),
  [],
  { id: 'Q-2026-0060', version: 1, status: 'sent', type: 'project_proposal', presentationMode: 'itemized', confirmed: true, depositInvoiceId: 'I-2026-0044', chain: [] },
  async (page) => {
    const tabs = await page.evaluate(readTabs);
    check(!tabs.invoice.disabled && tabs.invoice.href === '/admin/invoice/I-2026-0044', "Invoice tab falls back to the quote's deposit invoice pre-completion");
  }
);

if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\njob tabs: all checks passed');

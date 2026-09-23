// Inline job summaries on the Project page (2026-09-21, replaces an
// earlier "job tabs" idea).
//
// Patrick, after seeing the tabs live: "you literally did nothing by
// putting the tabs above. it just goes to a different page... I don't
// want to navigate to a different page. I want everything i need to
// know right there. Everything connected, no page moves, or new tabs
// open." This walks the REAL server/project.html + project.js in
// headless Chromium (every /api call mocked) and checks the Quote,
// Site Builder, and Invoice sections render real numbers directly on
// the page — not just a link that goes somewhere else with nothing
// shown.
//
// Run:  node scripts/test-project-inline-summaries.mjs   (also in
//       build:check; needs `npx playwright install chromium` once)

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'server', 'project.html'), 'utf8');
const projectJs = fs.readFileSync(path.join(here, '..', 'server', 'project.js'), 'utf8');

const PROJECT_ID = 'PROJ-TEST-INLINE';

function blankProject(overrides = {}) {
  return {
    id: PROJECT_ID,
    name: 'Inline summary walk',
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

function chromiumLaunchOpts() {
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const sandboxChromium = '/opt/pw-browsers/chromium';
  if (fs.existsSync(sandboxChromium)) return { executablePath: sandboxChromium };
  return {};
}

async function withPage(mocks, fn) {
  const browser = await chromium.launch(chromiumLaunchOpts());
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const m = route.request().method();
    if (url.pathname === `/admin/project/${PROJECT_ID}`) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/crm/project.js') return route.fulfill({ contentType: 'application/javascript', body: projectJs });
    if (url.pathname === `/api/projects/${PROJECT_ID}` && m === 'GET') {
      return route.fulfill({
        json: {
          ok: true,
          project: mocks.project,
          materialLists: mocks.materialLists || [],
          linkedCustomer: null,
          linkedQuote: mocks.linkedQuote || null,
          invoiceSummary: mocks.invoiceSummary || null,
          siteBuilderSummary: mocks.siteBuilderSummary || null
        }
      });
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

const readState = () => ({
  jobTabsGone: !document.getElementById('projJobTabs'),
  siteBuilder: { hidden: document.getElementById('projSiteBuilderPanel').hidden, text: document.getElementById('projSiteBuilderLine').textContent, href: document.getElementById('projSiteBuilderLink').getAttribute('href') },
  invoice: { hidden: document.getElementById('projInvoicePanel').hidden, text: document.getElementById('projInvoiceLine').textContent, href: document.getElementById('projInvoiceLink').getAttribute('href') },
  quoteLine: document.getElementById('projQuoteStatusLine').textContent,
  quoteLinesHidden: document.getElementById('projQuoteStatusLines').hidden,
  quoteLinesText: document.getElementById('projQuoteStatusLines').textContent
});

// ---- 1. A brand-new job — nothing exists yet ----------------------------
await withPage({ project: blankProject() }, async (page) => {
  const s = await page.evaluate(readState);
  check(s.jobTabsGone, 'the old navigate-away tab strip is gone entirely');
  check(!s.siteBuilder.hidden && /No design started yet/.test(s.siteBuilder.text), 'Site Builder panel shows real status text, not just a link, even with no design');
  check(s.siteBuilder.href === `/admin/sitebuilder?project=${PROJECT_ID}`, 'Site Builder Open link still carries the project id');
  check(s.invoice.hidden, 'Invoice panel stays hidden — nothing to show yet, not a dead link');
});

// ---- 2. Fully populated job — real numbers, right on the page ----------
await withPage({
  project: blankProject({ systemDesign: { areas: [{}, {}, {}, {}] } }),
  linkedQuote: {
    id: 'Q-2026-0089', version: 1, status: 'sent', type: 'project_proposal',
    presentationMode: 'summary', confirmed: true,
    subtotal: 21841, hst: 2839.33, total: 24680.33,
    lineItems: [
      { label: 'Mainline install', total: 2499 },
      { label: 'Controller upgrade', total: 1695 }
    ],
    depositInvoiceId: 'I-2026-0067', chain: []
  },
  invoiceSummary: { id: 'I-2026-0067', status: 'sent', invoiceRole: 'deposit', total: 9872.13, amountPaid: 0, balanceDue: 9872.13, sentAt: '2026-09-20T12:00:00Z', paidAt: null },
  // Deliberately three DIFFERENT numbers: a summary that printed one of
  // them under another's name is the defect this pins.
  siteBuilderSummary: { stationCount: 4, valveCount: 6, areaCount: 9, lastSavedAt: '2026-09-15T12:00:00Z' }
}, async (page) => {
  const s = await page.evaluate(readState);
  check(/4 stations/.test(s.siteBuilder.text) && /6 valves/.test(s.siteBuilder.text) &&
        /9 areas/.test(s.siteBuilder.text) && /last saved/.test(s.siteBuilder.text),
        `Site Builder names stations, valves and areas separately + save date inline (got "${s.siteBuilder.text}")`);
  check(!s.invoice.hidden, 'Invoice panel renders once there is a real invoice');
  check(/I-2026-0067/.test(s.invoice.text) && /sent/.test(s.invoice.text) && /9,872\.13/.test(s.invoice.text) && /balance due/.test(s.invoice.text),
    `Invoice line shows id, status, total, and balance due — all inline (got "${s.invoice.text}")`);
  check(s.invoice.href === '/admin/invoice/I-2026-0067', 'Invoice Open link points at the real invoice');
  check(!s.quoteLinesHidden, 'Quote line items render inline, not just the status word');
  check(/Mainline install/.test(s.quoteLinesText) && /Controller upgrade/.test(s.quoteLinesText) && /24,680\.33/.test(s.quoteLinesText),
    `Quote panel shows real line items and the real total (got "${s.quoteLinesText}")`);
});

// ---- 3. Paid in full — the balance-due language flips ------------------
await withPage({
  project: blankProject(),
  linkedQuote: { id: 'Q-2026-0100', version: 1, status: 'accepted', type: 'project_proposal', presentationMode: 'itemized', confirmed: true, subtotal: 1000, hst: 130, total: 1130, lineItems: [], depositInvoiceId: 'I-2026-0080', chain: [] },
  invoiceSummary: { id: 'I-2026-0080', status: 'paid', invoiceRole: 'deposit', total: 1130, amountPaid: 1130, balanceDue: 0, sentAt: '2026-09-01T00:00:00Z', paidAt: '2026-09-05T00:00:00Z' }
}, async (page) => {
  const s = await page.evaluate(readState);
  check(/paid in full/.test(s.invoice.text) && !/balance due/.test(s.invoice.text), `a fully paid invoice says so instead of a $0 balance line (got "${s.invoice.text}")`);
});

if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\ninline job summaries: all checks passed');

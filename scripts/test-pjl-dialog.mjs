// PJL Dialog — shared branded alert()/confirm()/prompt() replacement.
//
// Headless Chromium (no live server — pjl-dialog.js/.css are loaded
// directly from disk, same route-interception pattern as
// test-sitebuilder-laterals.mjs). Walks:
//
//   - alert() renders, OK resolves, focus returns to the triggering button
//   - confirm() Confirm resolves true, Cancel resolves false
//   - confirm() Escape and a backdrop click both resolve false
//   - prompt() OK resolves the typed value, Cancel resolves null
//   - destructive: true renders the red button + warning icon
//   - requireTypedConfirm blocks Confirm until "DELETE" is typed
//   - Tab is trapped inside the open dialog (focus wraps, not to page behind)
//
// Run:  npm run test:pjl-dialog   (needs `npx playwright install chromium` once)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsSrc = fs.readFileSync(path.join(here, '..', 'server', 'pjl-dialog.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(here, '..', 'server', 'pjl-dialog.css'), 'utf8');

const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>${cssSrc}</style>
</head><body>
<button id="trigger">Trigger</button>
<script>${jsSrc}</script>
</body></html>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/pjl-dialog-test') return route.fulfill({ contentType: 'text/html', body: HOST_HTML });
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://local.test/pjl-dialog-test');

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok — ${label}`);
  } else {
    failures++;
    console.log(`  FAIL — ${label}`);
  }
}

// alert(): OK resolves, focus returns to trigger.
{
  await page.focus('#trigger');
  const resultPromise = page.evaluate(() => window.pjlDialog.alert('Saved.', { title: 'Done' }));
  await page.waitForSelector('.pjl-dialog-panel');
  const titleText = await page.textContent('.pjl-dialog-title');
  check('alert() shows the given title', titleText === 'Done');
  const btnCount = await page.locator('.pjl-dialog-actions button').count();
  check('alert() has exactly one button (no Cancel)', btnCount === 1);
  await page.click('.pjl-dialog-btn-primary');
  await resultPromise;
  const focusedId = await page.evaluate(() => document.activeElement.id);
  check('alert() dismiss returns focus to the trigger', focusedId === 'trigger');
}

// confirm(): Confirm -> true
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Proceed?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.click('.pjl-dialog-btn-primary');
  const result = await resultPromise;
  check('confirm() Confirm resolves true', result === true);
}

// confirm(): Cancel -> false
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Proceed?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.click('.pjl-dialog-btn-secondary');
  const result = await resultPromise;
  check('confirm() Cancel resolves false', result === false);
}

// confirm(): Escape -> false
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Proceed?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.keyboard.press('Escape');
  const result = await resultPromise;
  check('confirm() Escape resolves false', result === false);
}

// confirm(): backdrop click -> false
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Proceed?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.click('.pjl-dialog-backdrop', { position: { x: 5, y: 5 } });
  const result = await resultPromise;
  check('confirm() backdrop click resolves false', result === false);
}

// prompt(): OK returns the typed value
{
  const resultPromise = page.evaluate(() => window.pjlDialog.prompt('Note?', { defaultValue: '' }));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.fill('.pjl-dialog-input', 'Left a key under the mat');
  await page.click('.pjl-dialog-btn-primary');
  const result = await resultPromise;
  check('prompt() OK resolves the typed value', result === 'Left a key under the mat');
}

// prompt(): Cancel returns null
{
  const resultPromise = page.evaluate(() => window.pjlDialog.prompt('Note?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.click('.pjl-dialog-btn-secondary');
  const result = await resultPromise;
  check('prompt() Cancel resolves null', result === null);
}

// destructive: red button + warning icon present.
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Delete this?', { destructive: true, icon: 'delete' }));
  await page.waitForSelector('.pjl-dialog-panel');
  const hasDestructiveBtn = await page.locator('.pjl-dialog-btn-destructive').count();
  const hasIcon = await page.locator('.pjl-dialog-icon-delete').count();
  check('destructive: true renders the red button', hasDestructiveBtn === 1);
  check('icon: "delete" renders the delete icon', hasIcon === 1);
  await page.click('.pjl-dialog-btn-secondary');
  await resultPromise;
}

// requireTypedConfirm: Confirm stays disabled until "DELETE" is typed.
{
  const resultPromise = page.evaluate(() =>
    window.pjlDialog.confirm('Delete everything?', { destructive: true, requireTypedConfirm: true })
  );
  await page.waitForSelector('.pjl-dialog-panel');
  const disabledBefore = await page.locator('.pjl-dialog-btn-destructive').isDisabled();
  check('requireTypedConfirm starts with Confirm disabled', disabledBefore === true);
  await page.fill('.pjl-dialog-typed-input', 'nope');
  const stillDisabled = await page.locator('.pjl-dialog-btn-destructive').isDisabled();
  check('requireTypedConfirm stays disabled on a wrong value', stillDisabled === true);
  await page.fill('.pjl-dialog-typed-input', 'delete');
  const enabledNow = await page.locator('.pjl-dialog-btn-destructive').isDisabled();
  check('requireTypedConfirm accepts case-insensitive "delete"', enabledNow === false);
  await page.click('.pjl-dialog-btn-destructive');
  const result = await resultPromise;
  check('requireTypedConfirm resolves true once satisfied', result === true);
}

// Focus trap: Tab from the last focusable element wraps to the first.
{
  const resultPromise = page.evaluate(() => window.pjlDialog.confirm('Proceed?'));
  await page.waitForSelector('.pjl-dialog-panel');
  await page.locator('.pjl-dialog-btn-primary').focus();
  await page.keyboard.press('Tab');
  const wrappedToCancel = await page.evaluate(() => document.activeElement.classList.contains('pjl-dialog-btn-secondary'));
  check('Tab from the last button wraps to the first (focus trap)', wrappedToCancel === true);
  await page.keyboard.press('Escape');
  await resultPromise;
}

// The palette lives in crm.css, and four pages that load this dialog do NOT
// load crm.css — sitebuilder, appointment, smart-controller-photos and the
// customer portal. This host page has no crm.css either, which is the point:
// it is those pages. Without fallbacks the panel's background never painted
// and the dialog rendered as bare text over the page behind it.
{
  const resultPromise = page.evaluate(() => window.pjlDialog.alert('Painted?', { title: 'Palette' }));
  await page.waitForSelector('.pjl-dialog-panel');
  const seen = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.pjl-dialog-panel'));
    const title = getComputedStyle(document.querySelector('.pjl-dialog-title'));
    return { bg: cs.backgroundColor, color: title.color };
  });
  const opaque = (c) => c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
  check(`the panel has an opaque background with no crm.css (${seen.bg})`, opaque(seen.bg));
  check('the panel background is the cream from the palette',
        seen.bg === 'rgb(250, 250, 245)');
  await page.click(".pjl-dialog-btn-primary");
  await resultPromise;
}

// And the rule that keeps it that way: no --pjl-* reference without one.
{
  const bare = [...cssSrc.matchAll(/var\((--pjl-[a-z-]+)\)/g)].map((m) => m[1]);
  check(`every --pjl-* reference carries a fallback${bare.length ? ' — bare: ' + [...new Set(bare)].join(', ') : ''}`,
        bare.length === 0);
}

check('no uncaught page errors during the run', errors.length === 0);
if (errors.length) errors.forEach((e) => console.log('  page error:', e));

await browser.close();

if (failures > 0) {
  console.log(`\ntest-pjl-dialog: FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\ntest-pjl-dialog: PASS');

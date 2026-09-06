// The Apple requirements that live in code, pinned.
//
// docs/TAP_TO_PAY_REQUIREMENTS.md is the audit; this is the half of it a
// machine can hold. None of these can be checked by running the app on
// this machine — there is no simulator here and Tap to Pay does not work
// in one anyway — so they are checked where they are decided.
//
// The lesson from 2026-09-06 applies throughout: a source-text assertion
// cannot tell a working thing from a decorative one. Where behaviour can
// be executed it is; where it genuinely cannot, the assertion is written
// against the specific value that would be wrong, never against the mere
// presence of a word.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'pjl-field');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

const appJson = JSON.parse(read('pjl-field/app.json'));
const easJson = JSON.parse(read('pjl-field/eas.json'));
const pkg = JSON.parse(read('pjl-field/package.json'));
const hook = read('pjl-field/src/taptopay/useTapToPay.js');
const provider = read('pjl-field/src/taptopay/TapToPayProvider.js');
const invoice = read('pjl-field/src/screens/InvoiceScreen.js');
const settings = read('pjl-field/src/screens/TapToPaySettings.js');
const api = read('pjl-field/src/api.js');

// ---- The entitlement, without which the build installs and then fails
// at the first tap ------------------------------------------------------

check('the Tap to Pay entitlement is declared', () => {
  // The SDK's own Expo plugin does NOT add this — it only writes
  // Info.plist keys. Discovered by reading the plugin source, not
  // assumed; if a future SDK version starts adding it this assertion is
  // still correct, just redundant.
  assert.equal(
    appJson.expo.ios.entitlements['com.apple.developer.proximity-reader.payment.acceptance'],
    true,
    'without this the app signs, installs, and fails at the first card',
  );
});

check('the SDK is a real dependency at a pinned version', () => {
  const v = pkg.dependencies['@stripe/stripe-terminal-react-native'];
  assert.ok(v, 'the Terminal SDK is not installed');
  // Recorded rather than asserted-against: Stripe publishes this line as
  // 0.0.1-beta.N and there is no stable channel to prefer.
  assert.match(v, /^\^?0\.0\.1-beta\.\d+$/, `unexpected version shape: ${v}`);
});

// ---- The build profile, because TestFlight cannot carry this build ----

check('a build profile exists that development signing can use', () => {
  const p = easJson.build.taptopay;
  assert.ok(p, 'no taptopay build profile');
  assert.equal(p.distribution, 'internal', 'production/TestFlight cannot carry this until Apple grants publishing');
  assert.notEqual(p.channel, 'production', 'this build must not share the production update channel');
});

check('the production profile is untouched', () => {
  // main stays SDK-free and the everyday app keeps shipping. If this
  // fails, the app Patrick uses on real closings is about to change.
  assert.equal(easJson.build.production.channel, 'production');
  assert.ok(!easJson.build.production.developmentClient);
});

// ---- 1.5 / 5.6 — the warm-up, which is what makes one second possible -

check('1.5: the reader warms up on foreground, not on button press', () => {
  assert.match(hook, /AppState\.addEventListener/, 'nothing re-warms when the app comes forward');
  assert.match(hook, /next === 'active'/);
  assert.match(invoice, /tap\.warmUp\(\)/, 'the invoice screen never warms the reader');
});

// ---- 1.6 — never cache acceptance ourselves ---------------------------

check('1.6: acceptance is never stored locally', () => {
  // The failure this prevents is a boolean that says "accepted" after
  // Apple has reset it, leaving a button that lies. Checked as an
  // absence, which is the only way an absence can be checked.
  for (const [name, src] of Object.entries({ hook, settings, invoice })) {
    assert.ok(
      !/AsyncStorage|SecureStore/.test(src),
      `${name} persists something — acceptance state must come from the SDK, never from us`,
    );
    assert.ok(
      !/(tosAccepted|termsAccepted|hasAcceptedTerms)\s*[=:]/.test(src),
      `${name} keeps its own acceptance flag`,
    );
  }
});

// ---- 3.5 / 3.8 — Apple's terms sheet, and who may accept -------------

check('3.5: Apple’s own terms sheet is permitted to appear', () => {
  assert.match(hook, /tosAcceptancePermitted:\s*true/,
    'without this the reader refuses to connect for a merchant who has not accepted');
});

// ---- 3.6 — enabling outside the checkout flow ------------------------

check('3.6: Tap to Pay is reachable when not at an invoice', () => {
  assert.match(read('pjl-field/App.js'), /TapToPaySettings/, 'the settings screen is not mounted');
  assert.match(read('pjl-field/src/screens/TodayScreen.js'), /onOpenTapToPay/,
    'nothing outside checkout opens it');
});

// ---- 5.2 / 5.3 — position, and never greyed out ----------------------

check('5.2: the Tap to Pay button comes before the other payment actions', () => {
  const tapAt = invoice.indexOf('accessibilityLabel="Tap to Pay on iPhone"');
  const linkAt = invoice.indexOf('Take payment now');
  const recordAt = invoice.indexOf('Record a payment I took');
  assert.ok(tapAt > 0, 'the Tap to Pay button is not in the invoice screen');
  assert.ok(tapAt < linkAt, 'the payment link is offered above Tap to Pay');
  assert.ok(tapAt < recordAt, 'recording a payment is offered above Tap to Pay');
});

check('5.3: the button has no greyed-out variant', () => {
  // Apple forbids altering or obscuring it based on whether Tap to Pay is
  // enabled — pressing it when it is not is how the terms get accepted.
  const at = invoice.indexOf('styles.buttonTap');
  assert.ok(at > 0);
  const line = invoice.slice(invoice.lastIndexOf('\n', at), invoice.indexOf('\n', at));
  assert.ok(!/styles\.off/.test(line), 'the button dims itself, which 5.3 forbids');
});

// ---- 5.4 — the exact string, which is not guessable ------------------

check('5.4: the button uses Apple’s exact English wording', () => {
  assert.match(hook, /TAP_TO_PAY_LABEL = 'Tap to Pay on iPhone'/);
  // The shortened form is forbidden in anything user-facing. Checked on
  // the rendered label rather than on comments, which discuss it.
  assert.ok(
    !/<Text[^>]*>\s*Tap to Pay\s*<\/Text>/.test(invoice),
    'a shortened "Tap to Pay" is rendered somewhere',
  );
});

// ---- 5.9 — every outcome named, not just success ---------------------

check('5.9: approved, declined, timed out and cancelled are all handled', () => {
  for (const outcome of ['approved', 'declined', 'timed_out', 'canceled']) {
    assert.match(hook, new RegExp(`'${outcome}'`), `the hook never produces ${outcome}`);
  }
  assert.match(invoice, /timed_out/, 'the screen cannot tell a timeout from a decline');
  assert.match(invoice, /canceled/, 'the screen cannot tell a cancellation from a decline');
});

// ---- Canada: Interac, and the fallback -------------------------------

check('CA: Interac is an accepted method, not just credit', () => {
  // A large share of what gets handed over on a driveway here is Interac
  // debit. Omitting it declines those cards at the tap.
  assert.match(hook, /'interacPresent'/, 'Interac debit would be declined at the tap');
  assert.match(hook, /'cardPresent'/);
});

check('CA: a declined tap points at the fallback rather than dead-ending', () => {
  assert.match(invoice, /payment link/i, 'a declined card leaves the tech with nowhere to go');
  assert.match(settings, /PIN/, 'the settings screen never mentions the PIN limitation');
});

// ---- The standing rule: no Stripe key on the phone -------------------

check('the app still holds no Stripe key of any kind', () => {
  for (const [name, src] of Object.entries({ api, hook, provider, invoice, settings })) {
    assert.ok(!/sk_live|sk_test|pk_live|pk_test/.test(src), `${name} carries a Stripe key`);
  }
});

check('the SDK gets its token from our server and nowhere else', () => {
  assert.match(provider, /terminalConnectionToken/, 'the token provider does not call our route');
  assert.match(api, /\/api\/terminal\/connection-token/);
  // AppsOnDevices is Stripe's serverless token path. Using it would take
  // our staff gate out of the loop entirely.
  assert.ok(
    !/AppsOnDevicesConnectionTokenProvider/.test(provider),
    'the serverless token provider bypasses our staff-gated route',
  );
});

// ---- The amount is the invoice's, never typed ------------------------

check('the charged amount comes from the invoice, not from a text field', () => {
  assert.match(invoice, /Math\.round\(dollars \* 100\)/, 'the amount is not derived from the invoice');
  const at = invoice.indexOf('const tapToPay');
  const block = invoice.slice(at, at + 1200);
  assert.ok(!/TextInput|setAmount\(/.test(block), 'the tap path reads a typed amount');
});

// ---- The SDK's API surface is what this code assumes it is -----------

check('the SDK actually exports what this integration calls', () => {
  // The one assertion here that would catch an SDK upgrade changing the
  // shape underneath us. Resolved from the app's own node_modules.
  const requireFromApp = createRequire(path.join(APP, 'package.json'));
  let types;
  try {
    types = readFileSync(
      requireFromApp.resolve('@stripe/stripe-terminal-react-native/lib/typescript/src/types/index.d.ts'),
      'utf8',
    );
  } catch {
    assert.fail('the Terminal SDK is not installed — run npm install in pjl-field');
  }
  assert.match(types, /EasyConnectTapToPayParams/, 'easyConnect no longer takes tap-to-pay params');
  assert.match(types, /tosAcceptancePermitted/, 'the terms flag this relies on is gone');
  assert.match(types, /InteracPresent/, 'Interac is no longer an offered payment method type');
});

console.log(`\ntap-to-pay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

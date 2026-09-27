# End-to-end testing

Phase 1 (built): API and business-journey tests on a safe throwaway server.
Phase 2 (proposal only, below): browser, phone app and production smoke.

## Running it

```
npm run test:e2e             # the 8 business journeys (~1 minute)
npm run check:field-bundle   # the real Field app iOS bundle (expo export, offline)
node scripts/test-e2e-tripwires.mjs   # the safety floor (also in build:check)
```

CI runs all three on every PR and every push to main
(`.github/workflows/ci.yml`: "Run build + price-lint checks", "E2E business
journeys" and "Field app bundle").

## Why it cannot reach the real business

Every journey boots the real `server/server.js` through
`scripts/lib/field-server.mjs`:

- **A throwaway copy.** `server/` is copied without `data/` into a temp
  directory. Every store starts empty, and the copy is deleted afterwards.
- **No `.env`.** `server.js` loads `../.env` at boot, and the harness used
  to link the repo's copy in. On a machine with real keys, every key the
  harness didn't set would have come from that file. It is never linked
  now, and the server refuses to start beside one.
- **Tripwires** (`scripts/lib/test-tripwires.cjs`). One definition is
  checked twice: by the harness before it spawns the server, and again
  inside the server by the preloaded stub. It refuses to boot with any of
  these:
  - a production host anywhere in the environment (`pjllandservices.com`,
    `*.onrender.com`);
  - a live or non-test Stripe key (`sk_live_`, `rk_live_`, `pk_live_`);
  - any Twilio, Gmail, QuickBooks, Google, Anthropic, captcha or webhook
    credential that isn't a stub.
- **Everything outbound is stubbed or refused**
  (`scripts/lib/stub-outbound.cjs`):
  - nodemailer, Twilio and Stripe calls are written to an outbox file
    instead of being sent;
  - below fetch, every TCP/TLS socket to anything but this machine is
    refused and logged, and production hosts are flagged.
- **Every message is accounted for.** `srv.ledger()` works step by step:
  each step names the emails, texts and Stripe calls it expects. Anything
  else, anything missing, or any production-host entry fails the journey.
- **Local only.** `assertLocalBase()` refuses to drive a non-local server,
  and `srv.api()` only takes paths.

`test-e2e-tripwires.mjs` (43 checks) proves each refusal. On the harness as
it was before this change, every tripwire check it reaches fails (29), and
then it crashes on the missing webhook helper.

## The journeys (`scripts/e2e/`)

| # | Journey | Checks |
|---|---|---|
| 1 | New customer → 4 zones → Bill later → sign → Finish → draft invoice → reopen lands on it → Send → pay link | 33 |
| 2 | Booked 4, walked 6: the price at signing = the signed scope = the invoice = the email = the pay page | 25 |
| 3 | 16 zones: custom price held (no link, Tap to Pay, Send or text) → Confirm price sends nothing → manual Send | 30 |
| 4 | Card on site: approved, declined, three timeouts, duplicate webhook, double payment, refund | 61 |
| 5 | Tap to Pay: which invoices may charge, and how the reader's result is finalized (no NFC) | 50 |
| 6 | Unlock → add zones → new signature needed → held → re-lock → re-sign (both directions) | 39 |
| 7 | No Charge: no invoice, prompt, promise, text or QuickBooks; reportable | 22 |
| 8 | Returning customer: spring kept intact → fall booked → portal move and cancel as the customer | 39 |

Each step is the request the real client makes: the app's
`pjl-field/src/api.js`, the CRM's buttons, the pay page and the portal.
The reopen step uses the app's own routing module. Prices are read from
`pricing.json` by key, never typed.

### Findings

A **finding** is behaviour a journey found that looks wrong for the
business but is Patrick's decision, not a test to quietly pin either way.
Findings print on every run and never fail it. Once decided, a finding
becomes an assertion.

1. **Re-signing doesn't re-price the invoice** (journey 6; a live billing
   defect in the #298 re-sign work). Releasing the hold only clears
   `scopeHold`. The invoice keeps the old scope's lines, so when payment
   reopens it charges the old price:
   - signed for 6 zones, billed for 4;
   - signed for 4 zones, billed for 6 (an overcharge).
2. **Bill later: the invoice text says it was emailed** (journey 1). Five
   minutes after Finish, the customer is texted "Your invoice … has been
   emailed to you … check spam/junk". The invoice is still a draft that
   nobody has sent, and its portal page has no Pay button.
3. **A double card payment reaches nobody** (journey 4). Pay page and Tap to
   Pay both approved: the ledger records it once and says "needs a manual
   refund", but only in a server log and on whichever screen confirmed
   second.
4. **Tap to Pay while processing** (journey 5). A second tap while the first
   intent is still `processing` creates a new intent without cancelling the
   first. If the first then completes, the customer is charged twice.

Pinned as found, and questions rather than findings:

- Cash recorded by staff emails no receipt; a card payment does.
- A refund made in the Stripe dashboard changes nothing in PJL by itself.
  Patrick reverses the payment in the ledger.

### Known limits

- The journeys use real dates (bookings are made days ahead). The portal
  reschedule in journey 8 needs open fall days in the next six weeks, so
  it can fail outside the fall season. The server has no clock a test can
  set; see Phase 2.
- Tap to Pay's NFC tap and the phone screens themselves are not covered
  here.

## Phase 2 — proposal (not started)

Nothing below is to start until Phase 1 is reviewed.

### 1. Playwright onto the safe harness, and into CI

The 19 existing Playwright scripts are opt-in and unsafe:
- they spawn `node server/server.js` against the repo's own `server/data`,
  backing it up and restoring it afterwards;
- they pass the whole `process.env`, so a real `.env` would load;
- nothing is stubbed.

Proposal:
- Move each one to `bootServer()`, so it gets temp data, the stubs and the
  tripwires.
- Add a browser-level tripwire: `context.route("**/*")` aborts, and fails
  the test on, any request that isn't to `127.0.0.1`.
- Serve a fake `js.stripe.com` so the pay page's card form works without
  Stripe.
- Run them in their own CI job with the Chromium Playwright install, so a
  browser failure is visibly separate from the API suite.

### 2. CRM/browser journeys

The office half of the Phase 1 journeys, in a real browser:
- the booking form;
- the work-order page's re-sign banner and re-lock prompt;
- the invoice page's Confirm price and Send;
- the No Charge filter;
- the customer's pay page and portal (move, cancel).

Each would reuse the Phase 1 helpers for setup, and the same ledger for
"nothing was sent that shouldn't be".

### 3. Maestro for the Field app, against a non-production server

- **Build:** a separate `e2e` EAS profile: an iOS simulator build with its
  own bundle identifier, so it can never be installed over, or confused
  with, the real app. `expo-updates` is disabled in that build, so a
  production OTA can never replace its code.
- **Server:** the Phase 1 harness on the Mac running the simulator, at
  `127.0.0.1`.
- **Hard production guard, three layers.** Today `pjl-field/src/api.js`
  hard-codes the production host; it would move into app config per
  profile.
  1. *Config time:* `app.config.js` throws, so the EAS build fails, when the
     variant is `e2e` and the host is production, or is anything but
     `127.0.0.1`/`localhost`.
  2. *Boot time:* the app itself refuses to start (a blocking "test build
     pointed at production" screen, no network calls) when a test build's
     host is production.
  3. *CI:* a unit test resolves each profile's config and fails if the
     `e2e` profile could ever carry a production host, or the production
     profile a local one.
- **Flows:**
  - log in, Today, start a visit, walk zones, sign, Finish, the invoice
    screen, reopen;
  - the offline and sync-notice paths;
  - not Tap to Pay (NFC hardware).
- **Where:** a macOS runner costs about 10× Linux minutes, so nightly and
  on demand rather than on every PR. Patrick's Mac is an alternative.

### 4. Post-deploy production smoke check

The only test that ever touches production. It is GET-only, on an
allow-list of paths, and never logs in, writes or sends anything.
- After a merge to main, poll `/login` until it serves the merged commit's
  asset stamp. That confirms the deploy, and it measures the downtime
  window (evidence for PJL-104).
- Then check that these pages answer `200`: `/`, `/book`,
  `/api/booking/services`, and the pay page shell.
- Check that an unknown invoice's pay API answers `404`, not `500`.
- Fail loudly (a GitHub notification) if the deploy doesn't land within 15
  minutes, or anything answers wrong.

### 5. A settable clock (small, enabling)

A `PJL_TEST_NOW` the server honours only when the tripwired harness is
present (the stub sets a marker a real deploy can't have). This removes
the season dependence noted above, and lets journeys cover reminders, the
24-hour portal cut-off and the 5-minute invoice text on purpose.

# Handoff — Stripe Payments Migration (Jul 30 – Aug 2, 2026)

**Status: COMPLETE and FUNCTIONAL. Verified with real customer money.**
Written for every other Claude session and human working in this repo. If you are
about to touch anything payment-adjacent, read this first, then
`SYSTEM_OVERVIEW.md` → *Payments surface* for the deep reference, then
`docs/FLOW_REGISTER.md` FLOW-23 for the verified hop chain.

---

## 1. What happened, in one paragraph

A customer's Amex was repeatedly declined on the QuickBooks Payments rail
(invoice I-2026-0044, "charge failed", Jul 22). Investigation produced the AVS
brief (collect billing street address, persist every charge attempt, map
gateway errors to customer-legible copy) — built and shipped on the QB rail
Jul 29. The Amex still failed with an opaque `HTTP 400: Bad request`, so on
Patrick's instruction the card rail was **migrated to Stripe** (Jul 30).
QuickBooks was **kept as the accounting ledger** — invoices still push to QBO
and every successful Stripe charge still creates a QBO Payment record.
Follow-up work through Aug 2: Apple Pay (one-tap via Express Checkout
Element), form slimmed to required fields only, Link removed, webhook
delivery fixed (307-redirect — see §5), and integration with the
payment-ledger feature built in a parallel session.

## 2. Why each decision was made

| Decision | Why |
|---|---|
| Stripe replaces QB Payments as processor | Amex failed on the QB rail with an unmappable 400 even after the AVS fix; Stripe accepts Amex by default. Proven: first live Stripe charge was an Amex, full AVS pass. |
| QuickBooks stays the ledger | Patrick's explicit choice ("just use Stripe to process the payments"). No bookkeeping workflow changed: `quickbooks.recordPaymentForInvoice` still fires after every capture. |
| Payment Element (embedded), not Stripe Checkout redirect | Keeps the PJL-branded invoice page; customer never leaves the site. |
| Explicit `payment_method_types: ["card"]`, NOT `automatic_payment_methods` | "Automatic" pulled in every method the Stripe account has enabled — including Klarna (BNPL, redirect flow nobody chose to offer). Card carries Apple Pay / Google Pay. |
| Link removed | Its "save my information" block (email/phone/name) dominated the mobile form. Patrick: only request what's required. |
| Custom name/street/postal fields removed | Stripe's rail runs postal-only AVS by default (Element collects postal natively, pre-filled from the invoice's billTo snapshot). The street-address field was a QB-rail need. If AVS declines resurface: `fields.billingDetails.address: "full"` in pay.js — one line. |
| Express Checkout Element above the card form | Inside the tabbed Element, a wallet is only a *selection* — the Apple Pay sheet couldn't open until the main Pay button was pressed (two taps). The dedicated button opens the sheet on first tap. Hidden unless a wallet exists on the device. |
| Webhook acks fast, processes async | Deliveries were failing; the handler also did QBO+PDF+SMTP before responding, which can outrun Stripe's timeout. Now: signature verify → 200 → work on next tick. |

## 3. What was built (files this workstream owns)

- **`server/lib/stripe.js`** — Stripe REST client, NO npm dependency (form-encoded
  bodies, bracket notation). PaymentIntents create/retrieve/cancel, intent
  summarizer, card facts (brand/last4/AVS/CVC checks), webhook signature
  verification (HMAC-SHA256 over the RAW body, 5-min replay window, refuses
  with no secret). Unit-tested: `scripts/test-stripe.mjs` (in `build:check`).
- **`server/pay.js` / `pay.html` / `pay.css`** — Payment Element (deferred-intent
  pattern), Express Checkout wallet button, settings-driven accepted-brands
  line, test-mode banner, e-Transfer fallback when Stripe.js can't load.
- **`server/server.js`** — routes `POST /api/pay/invoice/:id/payment-intent`
  (reCAPTCHA-gated; prices from **`balanceDue`**, reuses/cancels stale intents,
  idempotency key `pjl-<id>-<cents>`), `POST …/charge` (verifies the intent
  AGAINST STRIPE — never trusts the browser — then finalizes),
  `POST …/payment-failed` (pulls verified decline detail onto the invoice),
  `POST /api/webhooks/stripe` (signature-verified backstop; succeeded +
  payment_failed events). Shared `finalizeStripeInvoicePayment` — idempotent,
  refuses wrong-amount/wrong-invoice/non-succeeded intents.
  Also: `describeChargeFailure` maps Stripe + legacy Intuit codes to customer
  copy (office number always included; raw gateway strings never shown).
  Apple Pay domain file relay at `/.well-known/apple-developer-merchantid-domain-association`
  (fetched live from stripe.com, cached 24h — do not replace with a committed copy).
- **`server/lib/invoices.js`** — `paymentAttempts[]` append-only attempt log
  (every success AND failure, with processor error codes, `req_…` refs, AVS
  verdicts; explicit field allowlist so card data can't be persisted;
  `update()` cannot touch it). `stripePaymentIntentId` / `stripeChargeId` fields.
- **`server/lib/settings.js`** — `settings.payments.acceptedCardBrands`
  (+ `PATCH /api/settings/payments`), display-driven brand line.
- **`scripts/backfill-payment-ledger.js`** — one-time ledger backfill,
  **already run in production 2026-08-02**. Idempotent; safe to re-run.

**Legacy, retained but no longer routed to:** `quickbooks.chargeCard`,
`POST /api/webhooks/quickbooks-payments`, invoice field `quickbooksChargeId`
(records paid on the old rail), `card_qb`-era pay.js history.

## 4. Integration with the payment ledger (the parallel session's feature)

The two features merged cleanly — this is already DONE, do not redo it:
- `finalizeStripeInvoicePayment` records every capture via `invoices.addPayment`
  (method `card_qb`, label "Card", charge id in the notes) so
  `amountPaid`/`balanceDue`/status derive from the ledger.
- The pay page charges **`balanceDue`, never `total`** (partial payments
  respected; `partially_paid` is a payable status). Proven live:
  I-2026-0057 charged its $1,760 balance after a $500 recorded deposit.
- Invoices paid before the ledger existed were backfilled in production
  (entries carry `receivedBy: "backfill"`).

## 5. Production configuration (Stripe dashboard + Render) — current state

| Thing | State |
|---|---|
| Stripe account | `acct_1TiHdnQk79IkHuD4`, live mode |
| Render env | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` set (live, matched modes) |
| Webhook destination | `we_1TyjRqQk79IkHuD4tGstUVAD` → **`https://www.pjllandservices.com/api/webhooks/stripe`** — the `www` is LOAD-BEARING. The apex 307-redirects to www; browsers follow, Stripe webhooks refuse. 3 days / 31 failed deliveries until this was found (2026-08-02). Delivering 200s since. |
| Events subscribed | `payment_intent.succeeded`, `payment_intent.payment_failed` only |
| Payment method domains | BOTH `pjllandservices.com` AND `www.pjllandservices.com` registered — Stripe treats them as separate domains; the www registration is what made Apple Pay render |
| `PUBLIC_BASE_URL` | Still the apex (open item PAY-02): outbound links bounce through the 307. Change to `https://www.pjllandservices.com` when convenient — env-only, no code change |

## 6. Invariants — DO NOT BREAK (enforced by Hard Rules 22/23, PJL_OPERATIONS_DESIGN §10)

1. **A capture is not idempotent.** The capture happens exactly once,
   browser-side, at `confirmPayment`. NO automatic retry anywhere in the
   charge path. The Stripe `Idempotency-Key` protects intent *creation* only.
2. **Card data never touches this server.** PAN/CVC/expiry live in Stripe's
   iframe. Never replace the Element with raw inputs; never log or persist
   card data. The `paymentAttempts[]` allowlist is the structural guarantee.
3. **The method list lives in TWO files that must agree**:
   `payment_method_types` in `server/lib/stripe.js` and `paymentMethodTypes`
   in `server/pay.js`. Adding a method (Link, Klarna, ACH) is a deliberate
   two-file change plus a thanks-page verification pass — never a toggle.
4. **The server never trusts the browser about money.** Finalize re-reads the
   intent from Stripe and verifies invoice id, amount, currency, status.
5. **Charge `balanceDue`, never `total`.**
6. **The webhook URL keeps its `www`.** And the webhook handler acks before it
   works — don't move slow work back in front of the response.
7. `paymentAttempts[]` and the payment ledger are **append-only**;
   corrections go through their dedicated routes, never rewrites.

## 7. Verification record (why "PASS" is justified)

- 5 live captures, ~$2,300 CAD total, zero declines: two $1.13 self-tests
  (incl. **Amex ending 1001 — full AVS pass — the original defect, proven
  fixed**), Esther R. $297.19, Aviva B. $242.95, Daniel K. $1,760.00
  (balance-after-deposit case).
- Webhook: 200 OK observed 2026-08-02 12:39 PM; idempotent double-finalize
  confirmed a no-op; signature rejection tested (400 on bad sig).
- Ledger: entries appear automatically on new payments; backfill applied and
  verified on historical ones.
- `build:check` green including 30 Stripe unit assertions.

## 8. Open items (owned, low priority — do not "discover" these as new bugs)

- **PAY-02**: `PUBLIC_BASE_URL` still apex (env change pending).
- **PAY-03**: refunds are Stripe-dashboard-only; `charge.refunded` deliberately
  unhandled until refunds become a real workflow.
- I-2026-0058 (Kristen H., $903.83) outstanding at time of writing — first
  invoice expected to traverse the finished pipeline end-to-end unattended.

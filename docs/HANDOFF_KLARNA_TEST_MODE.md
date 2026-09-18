# Handoff — Klarna Financing (PJL-34): Getting Ready for a Real Test-Mode Walkthrough

**Status: build steps 1-5 shipped (data model, Stripe/webhook plumbing, the
acceptance hook, the admin enable/capture/void actions, the Pending
Financing queue, and the reminder sweep). Step 6 — a real Klarna
authorization and capture in Stripe TEST mode — is what this doc is
provisioning for. Read this before that walkthrough, and read
`docs/HANDOFF_STRIPE_PAYMENTS.md` first if you haven't already — this
account's live Stripe integration is what Klarna sits alongside, never
touches.**

## 1. Why this needs a TEST key, not the live one

This account's `STRIPE_SECRET_KEY` today is **live mode**
(`docs/HANDOFF_STRIPE_PAYMENTS.md` §5) — every call it makes moves real
money against a real Stripe account. Nothing in this codebase has ever
run a Klarna authorization end-to-end, so the first real run needs to
happen somewhere a mistake can't cost anything: Stripe's **test mode**,
which is a completely separate sandbox — separate keys, separate
customers, separate webhook subscriptions, zero connection to live data
or live money. A test-mode key can never charge a real card or a real
Klarna account, full stop.

## 2. What to get from Stripe, and how

1. Log into the Stripe Dashboard (dashboard.stripe.com) with the
   account's usual login.
2. In the top-left, there's a toggle — **"Test mode"**. Switch it on.
   Everything you see afterward (customers, payments, API keys) is now
   the sandbox, not the real account.
3. Go to **Developers → API keys**. You'll see two values:
   - **Publishable key** — starts with `pk_test_...`
   - **Secret key** — starts with `sk_test_...` (click "Reveal test key")
4. Copy both. **Paste them into our chat** when you're ready — this
   session doesn't write anything you paste into a file, and it's a test
   key, so even if it were seen by someone else, nothing real is at risk.
   (If you'd rather not paste a secret into chat at all, an alternative
   is adding them to this environment's `.env` file yourself and telling
   me they're there — either way works.)

That's the only thing I need from you. I'll handle the rest.

## 3. What I'll actually be able to test tomorrow

With a test secret key, I can make real calls to Stripe's test-mode API —
create a real (test) Klarna Payment Link, and (via the pre-installed
browser in this sandbox) actually click through Klarna's test checkout
the way a customer would, using Klarna's published test credentials
(Stripe's Klarna test mode accepts a fixed OTP/test flow — no real bank
login needed). That's a genuine, non-mocked run of:

- `enableFinancingForQuote` grossing up a real test quote
- `onQuoteAccepted` creating a real Stripe test Payment Link and emailing
  it (to a test inbox, not a real customer)
- A real Klarna test-mode approval or decline
- `captureFinancingAuthorization` / `voidFinancingAuthorization` moving
  real (test) money in Stripe's sandbox
- The invoice ledger, QuickBooks note field, and Pending Financing queue
  all agreeing about what happened

## 4. The one thing I can't do from here: live webhook delivery

Stripe delivers webhooks to a **public URL** it can reach over the
internet. This sandbox has no public address — the same reason the real
site listens at `https://www.pjllandservices.com/api/webhooks/stripe`
and nowhere else (`HANDOFF_STRIPE_PAYMENTS.md` §5's webhook destination).
So the *automatic* "Klarna approved → email arrives instantly" path
can't be triggered by a live webhook delivery in this environment.

That does **not** block the walkthrough. `applyWebhookEvent()` — the
function a real webhook calls — takes the same Stripe event data a
webhook would carry. After the real test-mode checkout completes, I'll
fetch the real resulting PaymentIntent from Stripe's test API (the exact
call `payment_intent.amount_capturable_updated` triggers on production)
and feed it through the same function by hand. Every line of code that
actually matters — the eligibility check, the gross-up math, the real
Klarna checkout, the real authorization, the real capture, the ledger,
the notifications — runs for real. Only the "Stripe rings our doorbell"
step is simulated, and that step is separately covered by the existing
webhook-signature tests in `scripts/test-stripe.mjs`.

Before this ships to a REAL customer, the two new event types
(`payment_intent.amount_capturable_updated`,
`payment_intent.canceled` — `payment_intent.payment_failed` is already
subscribed) still need to be added to the **live** webhook subscription
in the Stripe Dashboard (test mode and live mode subscriptions are
separate) — that's a Dashboard setting, not a code change, and it's the
very last step before flipping this on for a real quote.

## 5. What "done" looks like

Per the TRD's own recommendation (Decision 9): one full test-mode run,
start to finish, including the deposit + Klarna-balance combination
(§7a) — not just financing on its own — before this ever touches a real
customer. Once that's clean, `docs/FLOW_REGISTER.md` gets a new entry
for this flow, starting `UNMAPPED` and moving to `PASS` only after
Patrick has personally seen it work.

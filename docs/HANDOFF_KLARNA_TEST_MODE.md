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

## 3. What I expected to be able to test (see §4 for what actually happened)

**This section turned out to be wrong — kept for the record, corrected in
§4 below, which is the part to actually trust.**

With a test secret key, I expected I'd be able to make real calls to
Stripe's test-mode API —
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

## 4. CORRECTION (2026-09-18): this sandbox can't reach Stripe's API at all

The original version of this doc said the only gap was live webhook
delivery (no public URL), and that everything else — creating a real
test Payment Link, a real Klarna checkout, a real capture — could still
run for real from this environment. **That was wrong**, found out the
hard way when Patrick actually sent test keys: this sandbox's network
policy blocks *all* outbound calls to `api.stripe.com`, not just inbound
webhooks. A direct `curl`/`fetch` to Stripe's API from here gets a `403`
from the egress proxy itself — "destination host not allowed by your
organization's egress policy for this session." Per that proxy's own
operating rules, a blocked host is reported, never retried or routed
around — so this is not a config problem to fix, it's a hard boundary of
this particular sandbox.

**What this actually means**: nothing in `server/lib/stripe.js` or
`server/lib/klarna.js` can make a real network call to Stripe from a
Claude Code Cowork/web session running in this kind of sandboxed
container — test mode or live, doesn't matter, the block is on the
destination host, not the key. This was never tested until Patrick
supplied real test keys and the first real call was attempted.

**What still works from here**: everything that doesn't need the
network — reading/writing the gross-up math, the state machine, the
admin UI, the reminder sweep's threshold logic, and the full existing
unit-test suite (`scripts/test-klarna-financing.mjs`, all mocked-fetch,
zero live calls) all run exactly as before. Code review, bug fixes, and
new features for this system can keep happening here.

**What has to happen somewhere else**: an actual live Stripe test-mode
call — creating a real Payment Link, completing Klarna's real test
checkout, capturing a real (test) authorization — needs an environment
with normal internet access. Two realistic options:

1. **Patrick's own machine**, running this repo locally (or Claude Code
   Desktop/CLI there) with the test keys in a local `.env` — normal
   network, no sandbox restriction. I can walk him through every step
   live.
2. **A real Render deployment** (a preview environment for this branch,
   if Render's plan supports them, or a quick manual push to a spare
   service) with the test keys set as env vars — this also solves the
   *webhook* delivery problem from §5 below for free, since Render has a
   real public URL Stripe can actually reach.

Either way, this sandbox itself cannot be the place the live test runs.
Flagging this prominently so nobody re-discovers it the hard way again.

## 5. The webhook delivery problem (still real, on top of §4)

Separately from the network block above: Stripe delivers webhooks to a
**public URL** it can reach over the internet. This sandbox has no
public address — the same reason the real site listens at
`https://www.pjllandservices.com/api/webhooks/stripe` and nowhere else
(`HANDOFF_STRIPE_PAYMENTS.md` §5's webhook destination). Even in an
environment where §4's block didn't apply, the *automatic* "Klarna
approved → email arrives instantly" path still couldn't be triggered by
a live webhook delivery unless that environment also has a public URL.

`applyWebhookEvent()` — the function a real webhook calls — takes the
same Stripe event data a webhook would carry, so it can always be fed by
hand once a real PaymentIntent exists, in any environment. That part of
the plan is still correct — it just doesn't rescue §4's bigger problem
on its own.

Before this ships to a REAL customer, the two new event types
(`payment_intent.amount_capturable_updated`,
`payment_intent.canceled` — `payment_intent.payment_failed` is already
subscribed) still need to be added to the **live** webhook subscription
in the Stripe Dashboard (test mode and live mode subscriptions are
separate) — that's a Dashboard setting, not a code change, and it's the
very last step before flipping this on for a real quote.

## 6. What "done" looks like

Per the TRD's own recommendation (Decision 9): one full test-mode run,
start to finish, including the deposit + Klarna-balance combination
(§7a) — not just financing on its own — before this ever touches a real
customer. Once that's clean, `docs/FLOW_REGISTER.md` gets a new entry
for this flow, starting `UNMAPPED` and moving to `PASS` only after
Patrick has personally seen it work.

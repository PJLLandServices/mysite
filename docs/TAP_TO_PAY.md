# Tap to Pay on iPhone — what has to happen, in order

The customer holds their card, phone or watch against Patrick's iPhone, on the
invoice screen, with the amount already known. The invoice marks itself paid.
No app switching, no retyping.

This file exists because the work is gated on **two approvals nobody in this
repository can grant**, and those take the longest. Start them first; the code
is the short part.

---

## Where this stands  (2026-09-05)

| Gate | State |
|------|-------|
| Apple development entitlement | **requested 2026-09-05**, Case-ID `22041657` — awaiting review |
| Apple distribution entitlement | not yet requested (comes after internal testing) |
| Stripe Terminal enabled | not confirmed |
| Connection-token route | shipped (PR #137) — needs a Render deploy to be live |
| SDK + overlay + reader UI | not started, and must not start early (see §4) |

Apple's reply comes from `ttpoientitlements@apple.com`; follow-ups must quote
the Case-ID. As submitted, the request named **Stripe** as PSP, **Canada** as
the region, and internal distribution (Apple Business or unlisted).

**One answer needs correcting, by replying to Apple's acknowledgement with the
Case-ID.** "How many new apps that use this entitlement will you distribute in
the next 12 months" was answered *None*; the true answer is *1* — pjl-field
itself. (*None* was right for the preceding question, which asks about apps
already on the App Store.) Left as submitted it reads as a request for an
entitlement no app will use, on an account asking for up to 99 devices. If
Apple queries anything, expect it to be this. **Not known to be sent yet — if
you are reading this later, check the thread before assuming it was.**

**A Merchant ID is not part of this.** Registering one (`merchant.…`) is the
**Apple Pay** path — a different product. Tap to Pay through Stripe Terminal
needs only the entitlement above; readers are associated with a Stripe Location
at connect time, not registered with Apple in advance. Noted because it is an
easy wrong turn: searching "accept payments on iPhone" lands on Apple Pay first.

---

## Before anything: know what you are buying

**Many Canadian cards are offline-PIN only.** Entering that PIN requires the
card to be physically inserted, which Tap to Pay cannot do. Stripe's own
guidance for Canada is to ask for a different card or fall back to the payment
link. Tap to Pay will not take every card handed over on a driveway.

The payment link and the "Record a payment I took" control both stay. Tap to
Pay is the fast path, not the only one.

---

## 1. Apple — the Tap to Pay entitlement  (Patrick — DEVELOPMENT ONE REQUESTED)

Two separate entitlements, requested from the Apple Developer account that
owns `com.pjllandservices.field`:

1. **Development entitlement** — needed before it can be tested at all.
   **Requested 2026-09-05, Case-ID `22041657`.** Apple reviews in the order
   received and gives no ETA; there is nothing to do but wait for their reply.
2. **Distribution entitlement** — a second request, needed before it can ship,
   and only after internal testing.

Apple also **requires a "How to Tap" instructional overlay** in the app before
review. That is code, and it is on the list below — but it is Apple's
condition, not a nicety, so it cannot be skipped or restyled away.

Device floor: **iPhone XS or later**, on a recent iOS. Patrick's phone
qualifies.

## 2. Stripe — Terminal enabled on the account  (Patrick)

Terminal is not on by default. Until Stripe enables it, the connection-token
route returns Stripe's own error — deliberately, rather than a guess about
why.

**How to know it is done:** with the server deployed, a staff-authenticated
`POST /api/terminal/connection-token` returns `{ ok: true, secret: … }`. While
Terminal is off it returns Stripe's refusal verbatim.

---

## 3. The server  (done — shipped ahead of the approvals)

`POST /api/terminal/connection-token`, staff-gated, minting a short-lived
Terminal connection token.

This is **the only place the field app is allowed near Stripe**, and it is what
lets the "app never talks to Stripe" rule survive Tap to Pay. Card data goes
from the customer's card to Apple's secure element to Stripe; it never touches
our code, which is what keeps this out of PCI scope.

Pinned by `scripts/test-stripe.mjs`: the route exists, it is staff-gated, it
never hands out the secret key, and no Stripe key of any kind ships in the app
bundle. Verified by deleting the gate and watching the suite fail.

## 4. The app  (LAST — read the warning)

> **Do not add `@stripe/stripe-terminal-react-native` until the entitlement is
> granted and a build is wanted.**
>
> The SDK is a native module. The moment it lands in `package.json` the app's
> fingerprint changes, and `field-app-update.yml` will correctly refuse to
> publish ANY over-the-air update until a matching build is installed. Every
> unrelated fix would be stuck behind a TestFlight round trip.
>
> The order is: approvals → SDK → build → publish. Not SDK first.

Then, in one build:

- `@stripe/stripe-terminal-react-native`, with the connection-token provider
  pointed at the route above
- Apple's "How to Tap" overlay (their requirement, see §1)
- The invoice screen's **Take payment now** becomes the reader: amount from
  the invoice, not typed
- On success, record the payment against the invoice the way the pay page
  already does — `card_qb`, which is the general card method, not a
  QuickBooks-only one
- A visible fallback to the payment link when a card cannot be tapped, which
  in Canada will happen (see the top of this file)

---

## Order of operations

| # | What | Who | Blocks |
|---|------|-----|--------|
| 1 | Apple development entitlement — **requested, Case-ID 22041657** | Apple now | everything on the phone |
| 2 | Stripe Terminal enabled | Patrick | the token route returning a secret |
| 3 | Connection-token route | done | — |
| 4 | SDK + overlay + reader UI | Claude | needs 1 and 2 |
| 5 | TestFlight build | the build workflow | needs 4 |
| 6 | Apple distribution entitlement | Patrick | shipping beyond internal testing |

# Tap to Pay on iPhone — what has to happen, in order

The customer holds their card, phone or watch against Patrick's iPhone, on the
invoice screen, with the amount already known. The invoice marks itself paid.
No app switching, no retyping.

This file exists because the work is gated on **two approvals nobody in this
repository can grant**, and those take the longest. Start them first; the code
is the short part.

---

## Where this stands  (2026-09-06)

| Gate | State |
|------|-------|
| Apple development entitlement | **GRANTED 2026-09-06**, Case-ID `22041657` — development distribution restriction in place |
| Apple publishing entitlement | not yet requested — **gates TestFlight**, see below |
| Stripe Terminal enabled | **yes**, confirmed 2026-09-06 — one Location, "PJL Land Services", Newmarket ON |
| Connection-token route | **live and correctly gated** — returns secret + locationId (deployed 2026-09-06) |
| SDK + reader UI | **built** on `claude/pjl-field-taptopay` — NOT merged, and must not be until publishing lands |
| Education overlay + push + splash | not built — see `TAP_TO_PAY_INSTALLING.md`, none block a first tap |

**Apple sent the requirements with the grant. They are audited row by row in
`docs/TAP_TO_PAY_REQUIREMENTS.md` — read that before writing any Tap to Pay
code.** Two findings there change this file's plan:

- **TestFlight needs the PUBLISHING entitlement**, not the development one. The
  build → auto-submit → TestFlight pipeline cannot carry the Tap to Pay build.
  Development entitlements only support development provisioning profiles on
  devices registered to the developer account.
- **Canada requires a fallback payment method and PIN education**, as an Apple
  requirement now, not just our own caution about offline-PIN cards.

Apple's reply comes from `ttpoientitlements@apple.com`; follow-ups must quote
the Case-ID. As submitted, the request named **Stripe** as PSP, **Canada** as
the region, and internal distribution (Apple Business or unlisted).

**One answer was corrected, and the correction has been sent** (Patrick
confirmed 2026-09-06). "How many new apps that use this entitlement will you
distribute in the next 12 months" was submitted as *None*; the true answer is
*1* — pjl-field itself. (*None* was right for the preceding question, which asks
about apps already on the App Store.) As originally submitted it read as a
request for an entitlement no app would use, on an account asking for up to 99
devices.

**Kept here because the same answers carry into the PUBLISHING review**, which is
a separate submission: the app count is *1*, the PSP is Stripe, the region is
Canada, and distribution is unlisted. Answer them consistently there.

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

## 1. Apple — the Tap to Pay entitlement  (development one GRANTED)

Two separate entitlements, requested from the Apple Developer account that
owns `com.pjllandservices.field`:

1. **Development entitlement** — needed before it can be tested at all.
   **Granted 2026-09-06, Case-ID `22041657`**, with the development
   distribution restriction: registered test devices and development
   provisioning profiles only.
2. **Publishing entitlement** — a second request, made by replying to the grant
   email with three videos and the completed checklist. It gates **TestFlight**,
   not just the App Store, which is the part that surprised this plan. Details
   in `TAP_TO_PAY_REQUIREMENTS.md`.

Apple also **requires merchant education** in the app before review — and on
iOS 18+ the `ProximityReaderDiscovery` API provides it, satisfying four
checklist rows at once (4.4, 4.6, 4.7, 4.8). That is code, it is on the list
below, and it is Apple's condition rather than a nicety. Whether Stripe's React
Native SDK exposes that API is **not yet known** — check before planning around
it.

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
| 1 | Apple development entitlement — **GRANTED, Case-ID 22041657** | done | — |
| 2 | Stripe Terminal enabled | done | — |
| 3 | Connection-token route | done | — |
| 4 | SDK + reader UI | done (branch) | — |
| 4b | Education overlay, push, splash | Claude | needs Apple's Marketing Toolkit for the splash |
| 5 | Development build on a registered iPhone | Patrick | `docs/TAP_TO_PAY_INSTALLING.md` |
| 6 | Apple distribution entitlement | Patrick | shipping beyond internal testing |

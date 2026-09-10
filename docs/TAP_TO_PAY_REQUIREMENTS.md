# Tap to Pay on iPhone — Apple's requirements, audited against this app

Apple granted the **development** entitlement on 2026-09-06 (Case-ID 22041657)
and sent two documents:

- *Tap to Pay on iPhone — App & Marketing Requirements and Review Guide*, Aug 2026 **v1.7**, 25 pages
- *App Review Requirements Checklist* **v1.7** (Numbers)

This file is those documents read line by line against `pjl-field` as it exists
today. Both source documents are Apple's and are not redistributed here; this is
our audit of them.

---

## The bottom line

**We meet none of the app requirements yet, and could not — there is no Tap to
Pay code in `pjl-field`.** Its dependencies are `expo`, `expo-image-picker`,
`expo-location`, `expo-status-bar`, `expo-updates`, `react`, `react-native`,
`react-native-webview`. No Stripe SDK, no ProximityReader, no push.

What we *do* have that counts toward the requirements: an invoice screen with a
known amount, a payment link, a "Record a payment I took" control, a
staff-authenticated session, an automatic receipt email on Stripe settlement,
and the Terminal connection-token route (PR #137).

So this is a build spec, not a compliance report. Nothing below should be
reported to Apple as met until it is walked on a phone.

---

## Two findings that change the plan

### 1. TestFlight is blocked until the PUBLISHING entitlement

Guide, page 4, verbatim:

> **The publishing entitlement is required to use TestFlight.** As a result, your
> app must meet the in-app user experience requirements before you can distribute
> the app outside of your development teams.

and:

> For both the Apple Developer Program and the Apple Developer Enterprise Program,
> development entitlements are **restricted to devices registered to your Apple
> Developer account and only support development provisioning profiles**.

Our entire delivery pipeline — `field-app-build.yml` → EAS `production` →
auto-submit → TestFlight — **cannot carry the Tap to Pay build.** The order Apple
requires is: build it → record videos → get the publishing entitlement → *then*
TestFlight and the App Store.

The build has to go out on the `preview` or `development` EAS profile
(`distribution: internal`, ad-hoc/development signing) with Patrick's iPhone
registered on the Apple Developer account first (`eas device:create`).

### 2. The Tap to Pay build collides with the app he uses every day

Same bundle ID means one install. The moment the Stripe Terminal SDK enters
`package.json` the fingerprint moves, so:

- the Tap to Pay build cannot reach him through TestFlight (finding 1), and
- installing a development build **replaces** his working TestFlight app, and
- his working app stops receiving OTA updates the instant `main` carries the SDK.

**Recommendation: keep `main` free of the SDK.** Do Tap to Pay on a long-lived
branch with its own build profile, so the app he runs on real closings keeps
getting over-the-air fixes from `main` the whole time. Merge only when the
publishing entitlement is in hand.

**Open question for Apple or Stripe, worth asking before building:** whether the
entitlement can cover a second bundle ID (e.g. `com.pjllandservices.field.dev`)
so the two can coexist on one phone during development. Entitlements are granted
per Team and app; the grant email does not say. **Do not assume either answer.**

---

## Section 1 — General requirements

| # | Req | Applies? | State | What it needs |
|---|-----|----------|-------|---------------|
| 1.1 | Required | Yes | **Met** | iPhone XS or later. Confirmed indirectly and soundly: Patrick reported **iOS 18+** on 2026-09-06, and iOS 18 does not install on anything older than an iPhone XR/XS. No model lookup needed. |
| 1.2 | Conditional | **No** | N/A | Only if Tap to Pay is the *primary* payment method. Ours isn't — the payment link is, and stays (see §Canada). Set the deployment target to Stripe's floor anyway. |
| 1.3 | Conditional | **No** | N/A | Same condition. `supportsTablet: true` in `app.json` is worth revisiting regardless: an iPad cannot tap. |
| 1.4 | Required | Yes | **Missing (defensive)** | Handle `PaymentCardReaderError.osVersionNotSupported` on iOS < 17.6 with a message telling the user to update iOS. Patrick is on 18+, so this should never fire for him — but it is Required, and it is what protects a future crew phone on an older iOS. Build it; do not expect to see it. |
| 1.5 | Required | Yes | **Missing** | Warm the reader on launch and on foreground. This is also what makes 5.6 achievable. |
| 1.6 | Required | Yes | **Missing** | Read T&C acceptance **from Apple**, never from a local variable. Easy to get wrong by caching it in state. |
| 1.7 | Recommended | No | N/A | Face ID login. Public-App-Store guidance; our auth is the CRM session cookie. |
| 1.8 | Conditional | See below | — | HIG compliance — conditional on public App Store distribution. |
| 1.9 | Conditional | See below | — | Marketing guidelines — same condition. |

## Section 2 — Onboarding merchants

**These do not apply to us, by Apple's own escape clause** (guide, page 9):

> If your app lacks a user onboarding mechanism, you must distribute it through
> programs like Unlisted Apps, Custom Apps, or the Apple Developer Enterprise
> Program (ADEP). Alternatively, you can request an exception when applying for
> your Publishing Entitlement.

`pjl-field` has no public signup — accounts are CRM staff accounts Patrick
creates. That is exactly the case this clause covers, and it matches what the
entitlement request already told Apple ("Employees within my organization through
Apple Business or unlisted app distribution").

**This must be stated in the checklist and in the video submission, not left
blank.** Page 17: *"If your app does not provide a path for a new user to onboard
within the app, provide details on how new users onboard to become merchants."*

## Section 3 — Enabling Tap to Pay on iPhone

These **do** apply: they are waived only where no Apple Account accepts the terms
on the device, and Patrick will accept them on his own iPhone.

| # | Req | State | What it needs |
|---|-----|-------|---------------|
| 3.1 | Required | **Missing** | Visible, discoverable in-app communication that Tap to Pay exists. |
| 3.2 | Recommended | **Missing** | Full-screen modal / splash. Must use Apple's approved "Hero" asset from the Marketing Toolkit — we may not draw our own. |
| 3.3 | Required | **Missing** | Shown to every eligible user at least once. |
| 3.4 | Required | N/A | End of merchant onboarding — no onboarding flow (§2). |
| 3.5 | Required | **Missing** | A clear action to accept the T&Cs. |
| 3.6 | Required | **Missing** | Enable it **outside** checkout too — a Settings entry. The app has no settings screen at all today. |
| 3.7 | Required | **Missing** | Either a trigger inside checkout, or require it enabled before checkout. |
| 3.8 | Required | **Partly** | Only an admin may accept. The CRM already has a staff/admin gate (`requireAdmin`), so the mechanism exists; the app must respect it. |
| 3.8.1 | Required | **Missing** | A non-admin sees "contact an admin to enable it". |
| 3.8.2 | Conditional | **Likely N/A** | Apple Business Connect acceptance is for enterprise deployments **where no Apple Account is in use on the device** (guide, p11). Patrick accepts on his own iPhone with his own Apple Account, so this should not bite. Confirm with Stripe rather than assume. |
| 3.9 | Recommended | **Missing** | After T&Cs + tutorial, a screen inviting him to try it. |
| 3.9.1 | **Required** | **Missing** | A configuration progress indicator driven by `updateProgress` (or Stripe's equivalent), shown during first setup *and* whenever the reader is preparing. |

## Section 4 — Educating merchants

For unlisted/custom/ADEP distribution these are *strongly recommended, not
mandatory* if education is provided by other means. **Build them anyway** — 4.1 is
cheap and carries four other rows with it.

| # | Req | State | What it needs |
|---|-----|-------|---------------|
| 4.1 | Required | **Resolved — buildable** | `ProximityReaderDiscovery` on iOS 18+. Apple keeps it current and localized, **and it fulfils 4.4, 4.6, 4.7 and 4.8 outright.** Highest-leverage item on the list. See the resolution below. |
| 4.2 | Required | **Missing** | Education right after T&C acceptance. |
| 4.3 | Required | **Missing** | Reachable later from Settings or Help. Again: no settings screen exists. |
| 4.5 | Required | **Missing** | Show how to accept contactless cards. |
| 4.6 | Required | **Missing** | Show how to accept Apple Pay and digital wallets. |
| 4.7 | **Conditional on region — CANADA IS INCLUDED** | **Missing** | PIN entry *and the accessibility options on the PIN screen* must be covered. The region table reads "All regions except JP, TW". |
| 4.8 | **Conditional on region — CANADA IS INCLUDED** | **Missing** | Fallback payment method must be covered. See below. |

### Merchant education: how 4.1 gets built  (resolved 2026-09-06)

**`ProximityReaderDiscovery` is Apple's own API, not a Stripe one, and it is not
exposed as a JavaScript method by `@stripe/stripe-terminal-react-native`.** It is
a two-step native call: `content(for:)` to fetch the content, then
`presentContent(_:from:)` to show it.

**This is still the right route, and it is cheap:** `ProximityReader` is a
built-in iOS system framework **already linked by the Stripe Terminal SDK**, so
reaching it costs a small local Expo native module — a few dozen lines of Swift
bridging two calls — and **no new dependency**. Weighed against writing our own
education screens, which would then have to carry Apple's PIN and fallback copy
and be kept current by us, the module is much the smaller job.

**`ProximityReaderDiscovery` is iOS 18.0 and later**, and below that Stripe's
guidance is to provide your own fallback merchant education UI — which would have
had to carry Apple's verbatim PIN (4.7) and fallback (4.8) copy.

> **Settled 2026-09-06: Patrick's iPhone is on iOS 18+, so the fallback education
> screens are not needed.** Apple's API covers 4.1, and through it 4.4, 4.6, 4.7
> and 4.8. That is a whole screen set removed from the build.

**The condition to remember rather than the conclusion:** this holds while every
phone that takes payment is on iOS 18 or later. Add a crew phone on an older iOS
and the fallback screens come back, along with the verbatim-copy obligation.

Also noted from the same reading, useful later: the RN SDK exposes
`supportsReadersOfType({ deviceType: 'appleBuiltIn' })` for capability checks, and
`setLocalMobileUxConfiguration` for customising the Tap to Pay screen.

### A correction to Stripe support's answer

Stripe's support assistant, asked about this, answered about the **payment**
framework rather than the **education** API — they are different things that share
a prefix — and included one claim worth not carrying forward:

> *"The SDK manages reader connection tokens through Stripe's direct relationship
> with Apple"*

**Connection tokens come from our own server, minted with our own Stripe secret
key** — that is exactly what `POST /api/terminal/connection-token` (PR #137) is
for. The SDK *requests* a token from a provider we supply; it does not obtain one
by itself. Read the other way, that sentence would suggest the server route is
unnecessary. It is not, and it is the one thing standing between this feature and
a Stripe key in the app bundle.

The same answer also listed "request the entitlement" as a next step; it was
already granted on 2026-09-06.

### Canada's two extra obligations

The region table on page 21 lists **CA** under *Fallback Payment Method*, and
Canada is in *PIN Entry in Education* (everywhere except JP and TW).

This is the offline-PIN problem `TAP_TO_PAY.md` has flagged from the start,
now a formal Apple requirement rather than our own caution. It requires:

- at least one accepted **alternative payment method** — we have two, the payment
  link and *Record a payment I took* ✅
- a **seamless transition** from the Tap to Pay UI to that fallback — **missing**,
  and it is a design item, not a link
- the fallback covered in **merchant education** — **missing**

If we write our own education screens instead of using 4.1, Apple mandates this
copy **verbatim** (page 21):

> Some cards are not able to complete contactless transactions using a PIN. If
> this occurs, simply ask the customer if they have an alternative contactless
> card or digital wallet and continue the transaction using Tap to Pay on iPhone.

### The Terminal Location — a build input the documents do not mention

Stripe Terminal is enabled (confirmed 2026-09-06), with exactly one Location:
**PJL Land Services, Newmarket ON**.

That Location matters more than it looks. **A Tap to Pay reader is not registered
in the Dashboard ahead of time — it is associated with a Location at CONNECT
time**, so without the Location id the app cannot bring the reader up at all.
Nothing in Apple's checklist says this; it falls out of how Stripe's SDK works.

`POST /api/terminal/connection-token` now returns `locationId` alongside the
secret, resolved server-side: `STRIPE_TERMINAL_LOCATION_ID` when set, otherwise
the single Location on the account. **Several Locations are refused, not guessed
at** — a payment filed against the wrong site is a quiet error that surfaces at
reconciliation, long after the driveway.

The id is configuration rather than a secret, but it still comes from the server:
hard-coded in a shipped bundle it could not be changed without a TestFlight round
trip, and TestFlight is exactly what we do not have until the publishing
entitlement lands.

## Section 5 — Checking out

Page 14: **"These requirements are applicable for all apps."** No distribution
exemption. Every row here is ours.

| # | Req | State | What it needs |
|---|-----|-------|---------------|
| 5.1 | Required | **Missing** | A prominent button to start the transaction. |
| 5.2 | Required | **Missing** | Reachable **without scrolling**, and **top of the payment list**. Today the invoice screen's payment controls are below the line items — this constrains the layout. |
| 5.3 | Conditional | **Missing** | Never greyed out or obscured, even when not yet enabled; pressing it when not enabled opens the T&Cs. |
| 5.4 | Conditional | **Missing** | Correct button copy. English: **"Tap to Pay on iPhone"**. If the app is ever localized to French Canadian the string is **"Paiement rapide sur iPhone"**, which is not a translation of the English and cannot be guessed. |
| 5.5 | Conditional | **Missing** | Iconography, if used, must be SF Symbol `wave.3.right.circle` or `wave.3.right.circle.fill`. No other symbol. |
| 5.6 | Required | **Missing** | UI up within **one second, 90% of the time**. This is why 1.5 (warm-up) is not optional. |
| 5.7 | Required | **Missing** | An "initializing" screen when it's still configuring. |
| 5.8 | Required | **Missing** | A "processing" screen after a successful read. |
| 5.9 | Required | **Missing** | Outcome clearly shown: approved, declined, **or timed out**. |
| 5.10 | Required | **Partly** | A confidential digital receipt must be sendable **whether approved or declined**. The server already emails a receipt automatically when a Stripe payment settles (`sendPaymentReceipt`, `server.js:3016`) — the approved half is largely built. The **declined** path and an app-triggered send are missing. |
| 5.11 | Conditional | **Missing** | Canada's regional requirements — see §4 above. |
| 5.12 | Required | **Missing** | If he closes the app before seeing the result, a **notification** must tell him the outcome. `pjl-field` has **no push notification capability at all** — this pulls in another native module and an APNs setup. Easy to miss when scoping. |

## Section 6 — Marketing

Aimed at PSPs launching Tap to Pay to a base of merchants. Patrick is the sole
merchant and there is no user base to email or notify.

**Declare these as not applicable with that reason — do not leave them blank.**

Two rules bind us regardless of 6.1–6.3, because they govern any use of the name:

- **Never shorten it to "Tap to Pay"** in marketing, and never include "Apple" in the name.
- **Never put "Tap to Pay on iPhone" in the app's name** — App Review Guideline 5.2.5.
  `app.json` currently sets `"name": "PJL Field"`, which is fine. Keep it that way.
- We may not create our own illustrations, videos or imagery depicting Tap to Pay.
  Only Apple's toolkit assets, with light customization (brand colour, logo, font).

---

## What Apple wants back

Reply to `ttpoientitlements@apple.com` quoting **Case-ID 22041657**, and upload:

1. A video of the **New User Flow**
2. A video of the **Existing User Flow** (enablement + education)
3. A video of the **Checkout Flow**
4. The completed **App Review Requirements Checklist**

> **The checkout video must be recorded with a second camera.** Page 16: *"Use
> another device to record the Checkout flow video as the Tap to Pay on iPhone UI
> screens won't work for screen recordings."* The Apple-drawn screens come out
> black in a screen recording. Filming it wrong costs a full review round trip.

The checkout video must show: entering the amount, the payment options list, the
Tap to Pay button, an initializing screen if it takes over 300 ms, a successful
transaction, PIN entry, and the fallback mechanism.

### Checklist header — the values it asks for

| Field | Value |
|-------|-------|
| Team ID | `JBYT65U657` |
| App Name | PJL Field |
| PSP Name | Stripe |
| Date | date of submission |
| Version | app version submitted |
| Existing or New app | **New** |
| Distribution type | **Unlisted** |
| Number of Devices | how many crew iPhones will accept payment |

---

## Distribution: UNLISTED  (decided 2026-09-06 by Patrick)

Settled. This is what the entitlement request already told Apple, and it is the
right call: public App Store distribution would mean building a full in-app
merchant signup flow for an app one company uses.

### What it relaxes

Against **Apple's Tap to Pay checklist** only:

- **§2 Onboarding — waived entirely**, under Apple's own escape clause (p9) for
  apps with no in-app signup path distributed as Unlisted/Custom/ADEP.
- **§4 Educating merchants — strongly recommended, not mandatory**, if education
  is provided by other means. Build 4.1 anyway; it is cheap and carries four rows.
- **§6 Marketing — moot.** Patrick is the sole merchant; there is no user base to
  email or notify.
- **1.8 / 1.9** (HIG and marketing-guideline conformance) are conditional on
  public App Store distribution, so they relax too.

**§5 Checking Out still applies in full.** Page 14: *"These requirements are
applicable for all apps."* No exemption, and it is the largest section.

### What it does NOT relax — corrected after checking

**Unlisted apps still go through full App Store Review.** "Unlisted" means not
discoverable and reachable only by direct link; it does not mean unreviewed. An
app carrying the Tap to Pay entitlement also gets a special review by the App
Store Review team (guide, p18). So the review burden is unchanged — only the
Tap to Pay checklist gets shorter.

### The mechanics, verified 2026-09-06

Apple's own support page and App Store Connect help, not inference:

1. **The app must be submitted to App Review first.** Requests for unlisted
   distribution are **declined if the app has not been submitted to App Review,
   or if it is in a beta or prerelease state**.
   → PJL Field is on TestFlight and has never been released, so it is in exactly
   the prerelease state that gets declined. **It cannot be made unlisted from
   where it sits today.**
2. **Add a note in Review Notes** on the submission saying the app is intended
   for unlisted distribution, *then* submit the unlisted request.
3. **The request form is Account Holder only** — submissions from other roles are
   rejected.
4. Once approved, the distribution method changes to Unlisted in Pricing and
   Availability and applies to every future version.

> **The conversion is permanent.** An app converted to unlisted **cannot be
> changed back to public distribution**. For a crew app that was never going to
> the storefront this is the right trade, but it is one-way, and worth knowing
> before the form is submitted rather than after.

### On "Custom App" as the alternative

Custom Apps distribute privately through Apple Business Manager rather than a
link. They are a plausible fit, but they generally need an **organization**
developer account, and the entitlement grant lists the team as
*Company / Organization: Patrick Lalande* — which reads as an individual
membership. **Not established either way.** Unlisted is the route that does not
depend on resolving that, so the plan assumes unlisted unless Apple says
otherwise.

## Order of work

1. ~~Settle distribution~~ — **done: Unlisted** (2026-09-06).
2. ~~Ask Stripe about `ProximityReaderDiscovery`~~ — **answered 2026-09-06**; see
   §"Merchant education: how 4.1 gets built". Apple Business Connect (3.8.2)
   still worth confirming, but reads as N/A.
3. **Stripe enables Terminal** on the account — still not confirmed.
4. **Register the iPhone** on the developer account; add an EAS build profile with
   development signing.
5. **Build**, on a branch, with `main` kept SDK-free: SDK → warm-up (1.5) →
   T&C + settings entry (3.5/3.6) → education (4.1) → progress indicator (3.9.1) →
   checkout button and states (5.1–5.9) → receipt on decline (5.10) → push (5.12).
6. **Record three videos**, checkout filmed with a second device.
7. **Submit** the checklist and videos, quoting the Case-ID.
8. **Publishing entitlement** → only then TestFlight, and the normal build pipeline
   comes back.
9. **Submit to App Review** with a Review Note saying the app is intended for
   unlisted distribution — an unlisted request is declined while the app is still
   prerelease, which is what it is today.
10. **Request unlisted distribution**, from the Account Holder. One-way: the app
    cannot go back to public afterwards.

# PJL Land Services — handoff

**Read this first, then the two files it sends you to.** This is the entry point
for anyone — human or Claude — picking the project up cold in a fresh checkout.

It does not repeat what is already written down. It tells you what exists, which
document answers which question, the rules that are not negotiable, and what is
still open.

---

## 1. What this is

PJL Land Services is a one-owner irrigation and landscaping business in
Newmarket, Ontario. Patrick Lalande runs it and is the only person who gives
direction here. The software is three products in one repository:

| Product | What it is | Who uses it |
|---|---|---|
| **The public site** | ~55 static HTML pages, the booking flow, the pricing tool | Customers |
| **The CRM / server** | A Node backend with admin and customer-portal pages | Patrick, at a desk |
| **PJL Field** | An Expo / React Native iPhone app | Patrick and crew, in a truck |

They share one repository, one deploy, and one source of truth for prices,
seasons and parts. A change is rarely to only one of them.

**The season is the clock.** Fall closings (winterizations) run roughly late
September to the end of October. During that window the field app is in use
every day, on a driveway, on a phone, often with no signal. Anything that breaks
there breaks in front of a customer. This shapes nearly every design decision in
the codebase and should shape yours.

---

## 2. Where the answers already are

Read the file, do not re-derive it.

| Question | File |
|---|---|
| How the server, CRM, API and data files work | **`SYSTEM_OVERVIEW.md`** (1,784 lines) |
| Why a given decision was made, and what has broken before | **`docs/FLOW_REGISTER.md`** — the project's memory |
| What the business actually does, operationally | `PJL_OPERATIONS_DESIGN.md` |
| Getting an app change onto the phone | `docs/UPDATING_THE_APP.md` |
| Tap to Pay: Apple's requirements, audited line by line | `docs/TAP_TO_PAY_REQUIREMENTS.md` |
| Tap to Pay: order of operations | `docs/TAP_TO_PAY.md` |
| Tap to Pay: building it on the Mac, every keystroke | `docs/TAP_TO_PAY_MAC_BUILD.md` |
| Deploying the site, SEO playbook | `WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md` |
| The SEO agent loop | `seo/README.md` |
| Stripe payments handoff | `docs/HANDOFF_STRIPE_PAYMENTS.md` |
| App Store release notes | `docs/APP_STORE_RELEASE.md` |

> ⚠️ **`SYSTEM_OVERVIEW.md` predates the iPhone app.** It contains zero mentions
> of `pjl-field`. Everything it says about the server is still good; it simply
> does not know the app exists. Section 4 below is the app's map until that file
> is updated.

---

## 3. Repository layout

```
/                                   public marketing site (~55 HTML pages)
├── CLAUDE.md                       ← project rules. NOT OPTIONAL. See §5.
├── HANDOFF.md                      ← this file
├── SYSTEM_OVERVIEW.md              server/CRM reference (no app coverage)
├── PJL_OPERATIONS_DESIGN.md        operations spec
├── pricing.json                    service pricing — SINGLE SOURCE OF TRUTH
├── parts.json                      hardware catalog (~143 SKUs)
├── seasons.json                    season windows, booking windows
├── build.js                        partial-include sync for the static site
│
├── server/                         Node backend + admin/portal UI
│   ├── server.js                   the http server and ALL routing (~25k lines)
│   ├── lib/                        98 modules — per-entity logic
│   ├── data/                       runtime JSON, gitignored, persistent disk
│   ├── *.html / *.js / *.css       admin + portal + login pages
│   ├── today-map.js                THE route map — one file, two hosts (see §4)
│   └── season-plan.{html,js,css}   the season planning cockpit
│
├── pjl-field/                      the iPhone app (Expo SDK 54, RN 0.81.5)
│   ├── App.js                      shell: three tabs + job overlay
│   ├── app.json                    NATIVE CONFIG — changing it forces a rebuild
│   ├── eas.json                    build profiles; cli.version is load-bearing
│   ├── src/
│   │   ├── api.js                  every server call the app makes
│   │   ├── screens/                14 screens + closing/ (the 6-stage flow)
│   │   ├── theme.js                colours, spacing, type
│   │   └── ui.js                   shared primitives (sheets, rows, pickers)
│   ├── scripts/                    send / rebuild / built — see §6
│   └── ios/                        GENERATED, gitignored, never in the repo
│
├── scripts/                        115 test + lint scripts (see §7)
├── docs/                           the reference documents in §2
├── seo/                            the weekly SEO agent loop
└── .github/workflows/              CI and the app build/publish pipelines
```

---

## 4. The iPhone app (`pjl-field`)

Expo SDK 54, React Native 0.81.5, managed workflow. Bundle ID
`com.pjllandservices.field`. Three tabs — **Today**, **Properties**, **Book**
(admin only) — plus **Messages**, with an open job laid *over* the tabs as an
overlay rather than filed under a tab of its own.

**Auth rides the WebView cookie jar.** `src/api.js` talks to
`https://www.pjllandservices.com`; signing in is the CRM session cookie. There is
no separate app account system.

**The app carries no map SDK, deliberately.** Its route map is a `WebView` onto
`server/today-map.js` — one implementation, two hosts (the CRM's Today page and
the app). This is why map work ships over the air and why the two can never
drift apart. Do not add a native map.

**`runtimeVersion` is on the `fingerprint` policy.** An over-the-air update
installs **only** onto a build whose native code hashes identically. Change
`app.json`, add a dependency, or change a native module and the fingerprint
moves — and every existing install stops being able to receive updates until it
is rebuilt. This is the single most expensive thing to get wrong, and it has
cost real days. See §6.

**The closing flow** (`src/screens/closing/`) is six stages: Start (arrival
facts) → Water off → Zones → Close-out → Sign-off. It writes as it goes, because
a phone in a truck loses signal.

---

## 5. Rules that are not negotiable

These come from `CLAUDE.md` and `pjl-field/AGENTS.md`. They are in the repo
because each one was learned by breaking something.

1. **Read `docs/FLOW_REGISTER.md` before changing backend code.** Do not modify a
   flow marked **PASS** without re-verifying it.

2. **Lifecycle states: finish the workflow, not the write.** A record's state is
   not done when the record flips — it is done when *every reader agrees*. Grep
   the field, find every reader, define the rule **once** as a named function,
   and walk the whole workflow: what the customer sees, what Patrick receives,
   what happens to capacity and the calendar, what cascades to linked records,
   what the audit trail keeps. Name what you deliberately leave alone.

3. **Pin every fix with a test that fails on the OLD code.** Run it against the
   unfixed version first and report the count. If it passes before the fix, it is
   not testing the fix. `scripts/test-booking-lifecycle.mjs` is the worked
   example.

4. **Prices are `pricing.json` keys, never literal dollars.**
   `scripts/lint-no-hardcoded-prices.mjs` is the gate.

5. **Expo has changed.** Read the versioned docs at
   `https://docs.expo.dev/versions/v54.0.0/` before writing app code. Do not rely
   on remembered Expo APIs.

6. **`npm run build:check` must be green before anything is pushed.** It is the
   whole suite, ~115 scripts, and it runs in CI on every PR.

### Working with Patrick

- **Quote his words exactly**, never a paraphrase, when referring back to what he
  asked for. The code comments and the register do this throughout, on purpose.
- **Tell him what a change will require of him *before* he hits it** — a merge, a
  rebuild, a Mac, nothing at all.
- **Render a design and get it approved before building** anything he will look
  at. He reacts to pictures, quickly and well.
- **Check which machine he is on** before giving a command. He works from a
  **Windows PC** and a **Mac**. Mac-only instructions given blind have wasted
  real hours.

---

## 6. How things get deployed

### The server and the site

**Merge to `main`.** Render redeploys on its own in a couple of minutes. Nothing
else. A branch the live server has never seen might as well not exist.

Render service: `pjl-land-services.onrender.com`, fronted by
`www.pjllandservices.com`.

### The app — the part that trips everyone

There are three commands in `pjl-field`, and **only one of them needs the Mac**:

| Command | What it does | Where it runs |
|---|---|---|
| `npm run send` | Publishes a JS-only update over the air | Anywhere |
| `npm run built` | Records that the phone's build came from this code | Anywhere |
| `npm run rebuild` | Regenerates the Xcode project, restores signing team + Release | **macOS only** |

`npm run send` compares the fingerprint of what it is about to publish against
the build recorded as being on the phone. If they differ it **publishes nothing**
and says the word *Xcode* — because Expo would accept the bundle, the phone would
decline it, and that failure is silent and looks exactly like success.

**There is also an automated publisher.** `.github/workflows/field-app-update.yml`
runs on every merge to `main` touching `pjl-field/`. It refuses to publish when no
EAS build is listening on the runtime — a check that is correct in general and
blind to builds made locally in Xcode, which EAS has never heard of. It takes a
`workflow_dispatch` flag to publish to a locally-built phone anyway.

**What forces a real rebuild:** anything in `app.json`, a new library, a new
permission, the icon, the splash. Everything else is JavaScript and goes over the
air.

**How to tell whether an update landed:** bottom of the Today tab reads
*"App updated \<time\>"* (it worked) or *"shipped with the build"* (it did not).

---

## 7. Testing

115 scripts under `scripts/`, all wired into `build:check` in the root
`package.json`. They are plain Node — no framework — and most of them:

- **run real code** rather than asserting on strings where they can;
- **boot the actual server** and drive real endpoints for integration paths;
- **carry a control assertion** proving the test is not vacuous;
- **fail cleanly** when the thing under test is missing, naming what is missing
  rather than throwing a stack trace.

`scripts/test-hooks-order.mjs` is worth knowing about: it enforces the React
Rules of Hooks across the app by source analysis, because a hook below an early
return crashes the app in the field with no console.

---

## 8. External services

| Service | Used for | Notes |
|---|---|---|
| **Render** | Hosting the Node server + persistent disk | Env vars live here |
| **Stripe** | Payment links, invoices, Terminal | `STRIPE_TERMINAL_LOCATION_ID` |
| **Google Maps** | Geocoding, Distance Matrix, Places, map rendering | `GOOGLE_MAPS_SERVER_KEY` — see below |
| **Twilio** | SMS to customers | |
| **Expo / EAS** | App builds and OTA updates | `EXPO_TOKEN` is a repo secret |
| **Apple Developer** | App signing, TestFlight, Tap to Pay | Team ID `JBYT65U657` |

> **`GOOGLE_MAPS_SERVER_KEY` is quietly load-bearing.** Without it the geography
> filter runs on straight-line estimates instead of real drive times, and every
> booking gets flagged `UNVERIFIED`. If you see `UNVERIFIED` on *every* booking,
> that key has fallen out of Render. The address probe on `/admin/season-plan`
> reports whether it is configured.

Full env var list: `SYSTEM_OVERVIEW.md` § *Configuration (Render env vars)*.

---

## 9. What is open

| Item | State |
|---|---|
| **Tap to Pay** | Development entitlement granted; nothing built. **§10.** |
| **Season Plan "Remove visit" button** | Designed and rendered, not built. The day screen has it; the plan does not. Six plan-shaped reason codes await Patrick's word. |
| **Why a Pickering→North York day was offered** | Two candidate mechanisms: an address the geocoder cannot resolve skips the geography filter entirely (`filterSkipped`), or a day with no shape has no opinion. The address probe on `/admin/season-plan` names it in 30 seconds. **Not yet run.** |
| **FLOW-03** | PASS on the engine, "awaiting a walked booking" since August — a real booking through `book.html` on production against a loaded plan. |
| **`SYSTEM_OVERVIEW.md`** | Does not cover `pjl-field` at all. |

---

## 10. Tap to Pay — exactly what Patrick has to do

**Read `docs/TAP_TO_PAY_REQUIREMENTS.md` in full before acting on any of this.**
It is an audit of Apple's own v1.7 documents against this app, and it is the
authority. What follows is only the sequence of *Patrick's* actions pulled out of
it, with the build work marked as such.

### Where it stands

- **Development entitlement: GRANTED**, 2026-09-06, **Case-ID 22041657**.
- **Publishing entitlement: not applied for.** It is what unlocks TestFlight, and
  Apple will not grant it until the videos and checklist are accepted.
- **No Tap to Pay code exists in the app.** Not the SDK, not a screen, nothing.
- **Distribution decided: UNLISTED** (Patrick, 2026-09-06).

### The order, and why it cannot be reordered

Apple's guide, page 4: *"The publishing entitlement is required to use
TestFlight."* So the normal pipeline — build → TestFlight → review — **runs
backwards here.** It is: build on a registered device → record videos → get the
publishing entitlement → *then* TestFlight and the App Store.

### Patrick's steps

**① Confirm Stripe Terminal is enabled on the account.**
`docs/TAP_TO_PAY_REQUIREMENTS.md` contradicts itself on this — the Terminal
Location section says confirmed 2026-09-06, the order-of-work list says still not
confirmed. **Check the Stripe Dashboard and settle it**, and note the Location: it
must be exactly one, *PJL Land Services, Newmarket ON*. A Tap to Pay reader is
associated with a Location at connect time, so without it the reader cannot come
up at all. Several Locations are refused rather than guessed at.

**② Register the iPhone on the Apple Developer account.**
`eas device:create`. The development entitlement only works on devices registered
to the account, with development provisioning profiles.

**③ Build it — this is the code work, not yours.**
On a long-lived branch, with `main` kept free of the Stripe SDK so the app you
use every day keeps receiving over-the-air fixes. In order: SDK → reader warm-up
→ T&C acceptance + a settings entry → merchant education via
`ProximityReaderDiscovery` → configuration progress indicator → the checkout
button and its states → receipt on decline → push notification for the outcome.

Build instructions, keystroke by keystroke: `docs/TAP_TO_PAY_MAC_BUILD.md`.

**④ Record three videos.**
- New User Flow
- Existing User Flow (enablement + education)
- **Checkout Flow**

> **Film the checkout video with a second camera.** Apple's guide, page 16: the
> Tap to Pay UI screens do not appear in a screen recording — they come out
> black. Filming it wrong costs a full review round trip.

The checkout video must show: entering the amount, the payment options list, the
Tap to Pay button, an initializing screen if it takes over 300 ms, a successful
transaction, PIN entry, and the fallback mechanism.

**⑤ Complete the App Review Requirements Checklist.**
Apple sent it as a Numbers file with the grant. Header values:

| Field | Value |
|---|---|
| Team ID | `JBYT65U657` |
| App Name | PJL Field |
| PSP Name | Stripe |
| Version | the version submitted |
| Existing or New app | **New** |
| Distribution type | **Unlisted** |
| Number of Devices | how many crew iPhones will take payment |

**Do not leave rows blank.** Sections 2 (onboarding) and 6 (marketing) do not
apply to this app — say so *with the reason* rather than skipping them. §2 is
waived by Apple's own escape clause for apps with no in-app signup distributed as
Unlisted; §6 is moot because Patrick is the sole merchant.

**⑥ Send it to Apple.**
Reply to **`ttpoientitlements@apple.com`**, quoting **Case-ID 22041657**, with the
three videos and the completed checklist attached.

**⑦ Publishing entitlement arrives → TestFlight becomes possible.**
Only now does the normal build pipeline come back.

**⑧ Submit to App Review.**
Put a note in **Review Notes** saying the app is intended for unlisted
distribution. An unlisted request is *declined* while the app is still in a beta
or prerelease state — which is exactly what PJL Field is today, so this step
cannot be skipped or reordered.

**⑨ Request unlisted distribution.**
The request form is **Account Holder only** — a submission from any other role is
rejected.

> ⚠️ **This is one-way.** An app converted to unlisted distribution **cannot be
> changed back to public**. For a crew app that was never going to the storefront
> that is the right trade, but know it before submitting the form, not after.

### Two things that will bite if forgotten

**The Tap to Pay build collides with the working app.** Same bundle ID means one
install. A development build **replaces** the app Patrick uses on real closings,
and the moment `main` carries the Stripe SDK his working app stops receiving
over-the-air updates. This is why the SDK stays on a branch until the publishing
entitlement is in hand.

**Never shorten the name.** It is "Tap to Pay on iPhone" — never "Tap to Pay" in
marketing, never with "Apple" in it, and never in the app's own name (App Review
Guideline 5.2.5). The English button string is **"Tap to Pay on iPhone"**; the
French Canadian string is **"Paiement rapide sur iPhone"**, which is not a
translation and cannot be guessed. Icons, if used, must be the SF Symbol
`wave.3.right.circle` or `.fill` — no other symbol, and no self-drawn artwork.

---

## 11. Starting work in a fresh checkout

```
npm install
npm run build:check          # the whole suite — must be green before you start
```

Then, in order: `CLAUDE.md` → this file → `SYSTEM_OVERVIEW.md` for the server, or
§4 above for the app → `docs/FLOW_REGISTER.md` for the area you are about to
touch.

Branch, build, prove it with a test that fails on the old code, run
`build:check`, write the register entry, open a PR. Tell Patrick plainly what the
change will need from him.

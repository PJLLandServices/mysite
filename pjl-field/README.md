# PJL Field

Expo (React Native) app for field work — the iPhone shell for PJL's
tech mode.

## What this app is

Five tabs over the five things the field needs — **Today, Properties,
Work, Invoices, Messages** — and nothing else. The CRM's other fifteen
admin pages are not reachable from the app. That is the design, not an
omission: this is not the CRM on a small screen, it is the subset that
gets used standing on a lawn.

### The line between native and web

**Native for reading. Web for doing.**

Properties is a native screen (`src/screens/`). A record you only read is
cheap to rebuild, carries no write paths to get wrong, and gains the most
from being shaped for a phone — the admin property page is organised for
a desk, and no amount of shrinking fixes that. It reads the existing
`GET /api/properties` endpoints; no new server code.

Everything transactional — completing a work order, invoicing, messaging
— stays on the web pages that already do it correctly and carry
FLOW_REGISTER coverage. Rebuilding 6,000 lines of tech mode natively
would duplicate every rule and re-open flows that are only PASS because
Patrick walked them personally.

Hold that line. The moment a native screen starts writing, it owes the
register an entry and a walk.

### How the native screens authenticate

They don't, separately. The WebView is mounted with
`sharedCookiesEnabled`, which puts the `pjl_crm_session` cookie in the
system cookie store, and React Native's `fetch` reads that same store on
iOS. Signing in once on Today authenticates the native screens too. Before
that first login every call 401s, so they treat it as a normal state with
a "sign in on Today" message rather than an error.

The app also hides the CRM's own hamburger nav inside the WebView with
injected CSS. The tab bar is the app's navigation; the hamburger leads
back into the fifteen pages this app deliberately doesn't carry. CSS at
the app end only — the website is untouched for desktop.

## The web half

A **shell** around the existing tech-mode web UI, not a second copy of it.

`App.js` loads `https://www.pjllandservices.com/admin/today` — the tech's
morning hub — in a WebView. Tapping through to a work order lands on the
same `/admin/work-order/:id/tech` page the techs already use. One codebase
for the screens; no flow in `docs/FLOW_REGISTER.md` moves because of this
app.

Links that leave the site are handed to iOS rather than loaded in the
WebView: the Navigate button's Apple/Google Maps chooser, `tel:` links,
`mailto:`. Loading those in here would strand the tech away from the work
order.

The host and landing page are the `HOST` and `START_URL` constants at the
top of `App.js`.

Landing on the hub rather than jumping straight into a work order is
deliberate. The card's Open WO button posts to `/api/leads/:id/open-wo`,
which **creates** the work order when the lead has none
(`server.js:18657`). Opening one must stay a deliberate press, or launching
the app would create work orders on its own.

Walked on a real iPhone 2026-08-19, all six: login renders and succeeds;
/admin/today lays out correctly; a work order opens into tech mode; the
Navigate button hands off to the maps chooser and comes back; the session
survives a force-quit (30-day rolling cookie, `server.js:209`); photo
capture reaches a WO.

### What this does NOT do yet

The point of going native is **storage durability**, and that part is not
built. Today the offline queue still lives in the WebView's own storage,
with the same exposure `OFFLINE_QUEUE_RECOVERY.md` documents — force-quit,
cleared website data, and some iOS updates can still wipe it. Moving the
queue to native storage via a bridge is the next step, and the reason this
shell exists at all.

Two diagnosed bugs in `server/offline-queue.js` (see
`OFFLINE_QUEUE_INVESTIGATION.md`) are logic bugs, not storage bugs. Neither
is fixed by this app.

## Run it

From this folder, on a computer with Node.js installed:

```
npm install
npm start
```

A QR code appears. On the iPhone, install **Expo Go** from the App Store,
then point the **Camera** app at the QR code and tap the banner.

The phone and the computer need to be behind the same router. Wired or
wireless doesn't matter; a guest network or a network that isolates clients
does. If the phone won't connect, `npx expo start --tunnel` routes over the
internet instead and works regardless.

## Why SDK 54, and don't casually upgrade it

**Expo Go on the Apple App Store stops at SDK 54.** SDK 55 and later exist,
but Apple's App Store does not carry an Expo Go that runs them, and there is
no way for a user to install a newer one from the App Store. A project on a
newer SDK gives "you need a new version of Expo Go" on the phone, with no
update available to satisfy it.

This project was scaffolded on SDK 57 and deliberately moved back to 54 for
that reason. `expo` in package.json is what sets the SDK. Bumping it past 54
breaks Expo Go on the phone, so leave it unless the app has moved to
development builds or TestFlight — where the SDK ceiling doesn't apply,
since the Expo Go app is no longer in the picture.

## Getting it onto the phone for real: TestFlight, not the App Store

**TestFlight internal testing.** Internal testers are App Store Connect
users on the account, up to 100 of them, and their builds need no Beta App
Review — an upload is installable within minutes. That is the whole
distribution story for a private tool used by the people who own it.

**Not the public App Store.** This app is a WebView pointed at
pjllandservices.com, which is precisely what guideline 4.2 (minimum
functionality) exists to reject: "not sufficiently different from a web
browsing experience." Submitting it publicly would probably earn a
rejection, and there is no reason to list an internal field tool publicly
anyway. If that ever changes, it needs real native capability first — the
offline queue below being the obvious candidate.

**TestFlight builds expire after 90 days.** A tool meant to stay on the
phone indefinitely needs a rebuild each quarter, or ad-hoc distribution
instead. First build shipped 2026-08-19, so the clock runs to around
17 Nov 2026.

Walked end to end 2026-08-19: `eas build` → `eas submit` → Apple
processing → installed from TestFlight onto a real iPhone. App icon reads
correctly at home-screen size and tech mode still loads from inside the
installed app. Signing credentials live on Expo's servers and are good
until 18 Aug 2027, and submission uses a stored App Store Connect API key,
so neither a rebuild nor a resubmit needs an Apple login.

ASC app id 6803004540. Apple's "processing complete" email is unreliable —
check the TestFlight app on the phone instead.

## Shipping a change: update, or rebuild?

Most changes do NOT need a build. `expo-updates` is installed and the
production build profile is on the `production` channel, so a JavaScript
change ships over the air in about a minute:

```
git pull
npx eas-cli@23.2.0 update --branch production -m "what changed"
```

Reopen the app and it's there. No build, no TestFlight, no Apple.

### Updates publish themselves

A merge to `main` that touches `pjl-field/` publishes the update — see
`.github/workflows/field-app-update.yml`. GitHub can reach Expo, so nobody has
to be at a desk to ship a change to a phone in a truck. It authenticates with
an Expo **robot** token stored as the `EXPO_TOKEN` repository secret.

The workflow pins the same CLI version as `eas.json` and the two must stay in
step; the comment at the top of the workflow says why in detail. Publishing by
hand still works and is sometimes right (a re-publish after a rollback):
run the command below at the pinned version.

### Always run EAS at the pinned version. Never `@latest`.

`eas.json` pins `cli.version` to an exact release, and every command in this
file names that same version. That is not fussiness — it is the fix for a
real outage.

`runtimeVersion` is on the **fingerprint** policy, and the fingerprint is
computed by the CLI. On 2026-09-02 an update published with
`npx eas-cli@latest` computed a DIFFERENT fingerprint from the installed
build for a project that had not changed at all: three files
(`.easignore`, `.gitignore`, `eas.json`) had silently dropped out of the
hashed set between CLI releases. The build listened on one runtime, the
update went to another, and the phone kept running a bundle from the day
before while reporting success at every step. Nothing in the app or the
repo was wrong, and nothing in the output said anything was wrong.

A build and the updates that must reach it have to be fingerprinted by the
same CLI. Pinning is what guarantees that. When you do want a newer CLI,
change the pin and **rebuild** — a new fingerprint needs a new binary to
listen for it.

Diagnosing this again, if an update ever seems not to arrive: the running
bundle's date is printed at the bottom of the Today tab, and
`eas-cli fingerprint:compare --build-id <id>` names exactly what differs.

A **rebuild** is needed only when the native side changes: a new native
library, the icon or splash, the app name, iOS permissions, an SDK bump —
or a change to the pinned CLI version, per the note above.
Then it's the full round again — `eas build`, `eas submit`, install from
TestFlight.

`runtimeVersion` is on the **fingerprint** policy, which is what keeps that
distinction safe. The fingerprint is computed from the native side, so
adding a native module changes it, and an update built against the new
fingerprint is simply never delivered to a binary carrying the old one. The
symptom of forgetting to rebuild is therefore "my update didn't show up",
which is diagnosable. Under the `appVersion` policy the same mistake ships
a JS bundle the installed binary cannot run — a crash, in the field, on the
phone the work is being done from.

So: if an update doesn't appear, check whether the change touched anything
native before assuming the update failed.

Bundle identifier is `com.pjllandservices.field` — permanent from the first
submission to Apple, so change it before then or not at all.

## Working on this from a Claude Code web session

The sandbox blocks Expo's servers — `api.expo.dev`, `expo.dev` and `exp.host`
all answer 403 to CONNECT. Consequences:

- `eas` commands cannot run there at all. An `EXPO_TOKEN` does not help; the
  connection is refused before authentication.
- `npx expo start` **crashes** on SDK 54: its dependency-version check calls
  Expo's API and cannot parse the proxy's refusal. Use
  `npx expo start --offline`, which skips that check.
- `npx expo export` works fine — it needs no network.

The environment's network policy can be widened if this matters:
https://code.claude.com/docs/en/claude-code-on-the-web

## Layout

- `App.js` — the single screen.
- `index.js` — registers `App` as the root component (don't edit).
- `app.json` — Expo config: app name, icons, orientation, iOS bundle ID.
- `eas.json` — build profiles, for the TestFlight step later.
- `assets/` — icon and splash images (still the Expo defaults).

Expo SDK 54 / React Native 0.81 / react-native-webview 13.15.0 (pinned to
what Expo Go bundles for SDK 54).

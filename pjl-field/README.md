# PJL Field

Expo (React Native) app for field work — the iPhone shell for PJL's
tech mode.

## What this app is

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

## Later: a real installed app

Expo Go is a viewer for development. A standalone "PJL Field" on the home
screen, working without a computer running, is a separate step: EAS Build
compiles it on Expo's servers and TestFlight installs it. That needs an
Apple Developer Program membership ($99/year) and an Expo project created
with `eas init`.

`eas.json` already carries build profiles for this. Bundle identifier is
`com.pjllandservices.field` — permanent from the first submission to Apple,
so change it before then or not at all.

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

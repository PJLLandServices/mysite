# PJL Field

Expo (React Native) app for field work. Right now it's a blank screen that
says "PJL Field" — the scaffold only, no features yet.

## How this app reaches the phone

There is no computer in this setup. Builds run on Expo's cloud servers
(EAS Build), which pull the code straight from GitHub, and land on the
iPhone through Apple's TestFlight app. Nothing is compiled locally, and no
Mac is involved.

    this repo on GitHub  →  EAS Build  →  TestFlight  →  iPhone

Builds are started from the Expo dashboard in a browser — including a phone
browser. That matters, because the Claude Code sandbox this project is
developed in **cannot reach Expo's servers**: `api.expo.dev`, `expo.dev` and
`exp.host` are all refused by the environment's network egress policy (403
on CONNECT). So `eas build`, `eas submit` and `eas login` cannot be run from
a session here, and an `EXPO_TOKEN` would not help. Expo's GitHub
integration sidesteps this entirely: Expo does the fetching, so nothing has
to reach out from the sandbox.

If that ever becomes limiting, the environment's network policy can be
widened to allow those hosts — see
https://code.claude.com/docs/en/claude-code-on-the-web. Then the CLI route
below works from a session too.

## Setup

1. **Expo account** — free, https://expo.dev.
2. **Apple Developer Program** — $99 USD/year,
   https://developer.apple.com/programs/. Required by Apple to install on a
   real device, TestFlight included.
3. **Connect GitHub** — in the Expo dashboard, on the project page, use
   "Connect GitHub" and point it at this repository. Set the build's **base
   directory to `pjl-field`**, since the app is a subdirectory of a repo
   whose root is the website.
4. **App Store Connect API key** — App Store Connect → Users and Access →
   Integrations → App Store Connect API → generate a key with **App Manager**
   access. Upload it in the Expo dashboard under the project's credentials.
   Preferred over an Apple ID password: scoped, and revocable on its own.

Secrets from step 4 never belong in this repo.

## Building and shipping

From the Expo dashboard: start a build against the `production` profile, then
submit it to TestFlight. Apple takes a few minutes to process before it
appears. Install the **TestFlight** app on the iPhone; the build shows up
there once you're added as an internal tester.

The equivalent from a command line, on any machine that can reach Expo:

```
npx eas-cli build   --platform ios --profile production
npx eas-cli submit  --platform ios --latest
npx eas-cli update  --branch production --message "what changed"   # JS-only
```

After the first build, JavaScript-only changes ship over the air with
`update` — no rebuild, no new TestFlight version; the app picks them up on
relaunch. A new build is only needed when native code or app config changes
(new permissions, a new native library, icon, app name).

## Layout

- `App.js` — the single screen.
- `index.js` — registers `App` as the root component (don't edit).
- `app.json` — Expo config: app name, icons, orientation, iOS bundle ID.
- `eas.json` — build profiles for EAS Build.
- `assets/` — icon and splash images (still the Expo defaults).

The iOS bundle identifier is `com.pjllandservices.field`. It is permanent
once the first build is submitted to Apple — changing it later creates a
different app, so change it now or not at all.

## If a computer ever enters the picture

Everything above still works, and a much faster loop opens up — the app
reloads on the phone as the code is saved, with no build and no TestFlight:

```
npm install
npm start
```

Then scan the QR code with the iPhone Camera to open it in Expo Go (App
Store). Phone and computer must be on the same Wi-Fi; otherwise use
`npx expo start --tunnel`.

Expo SDK 57 / React Native 0.86.

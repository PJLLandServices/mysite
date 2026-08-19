# PJL Field

Expo (React Native) app for field work. Right now it's a blank screen that
says "PJL Field" — the scaffold only, no features yet.

## How this app reaches the phone

There is no computer in this setup. Builds run on Expo's cloud servers
(EAS Build) and land on the iPhone through Apple's TestFlight app. Nothing
is compiled locally, and no Mac is involved.

    code in this repo  →  EAS Build (Expo's servers)  →  TestFlight  →  iPhone

After the first build, most changes are JavaScript only. Those ship over the
air with EAS Update — no rebuild, no new TestFlight version; the app picks
them up on relaunch. A new build is only needed when native code or app
config changes (new permissions, a new native library, icon, app name).

## One-time setup

Two accounts are needed before the first build. Both are set up from the
phone's browser.

1. **Expo account** — free. Sign up at https://expo.dev.
2. **Apple Developer Program** — **$99 USD/year**, at
   https://developer.apple.com/programs/. This is not optional: Apple
   requires a paid membership to install a build on a real device, whether
   through TestFlight or any other route. Enrollment is not instant — expect
   at least a day, sometimes longer if Apple asks for ID.

Then, so builds can be triggered without a computer:

3. **Expo access token** — expo.dev → account settings → Access Tokens →
   create one. This lets a Claude Code session run builds on your behalf.
4. **App Store Connect API key** — App Store Connect → Users and Access →
   Integrations → App Store Connect API → generate a key with **App Manager**
   access. This is what uploads builds to TestFlight. Prefer this over
   handing over an Apple ID password: it is scoped, and it can be revoked on
   its own without touching the Apple account.

Treat both of those as passwords. Neither belongs in this repo — `.gitignore`
covers `.env*.local`, and they should be revoked once they are no longer
needed.

## Building and shipping

Run from a machine (or a Claude Code session) that has the repo and is
logged in to Expo:

```
npx eas-cli build   --platform ios --profile production   # ~15-30 min, on Expo's servers
npx eas-cli submit  --platform ios --latest               # uploads to TestFlight
```

Apple then takes a few minutes to process the build before it appears in
TestFlight. Install the **TestFlight** app from the App Store on the iPhone;
the build shows up there once you've been added as an internal tester.

For a JavaScript-only change afterwards:

```
npx eas-cli update --branch production --message "what changed"
```

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

# PJL Field

Expo (React Native) app for field work. Right now it's a blank screen that
says "PJL Field" — the scaffold only, no features yet.

## Run it on your iPhone with Expo Go

1. Install **Expo Go** from the App Store on your iPhone.
2. On your Mac/PC, from this folder:

   ```
   npm install      # first time only
   npm start
   ```

3. A QR code appears in the terminal. Open the iPhone **Camera** app, point it
   at the QR code, and tap the banner — it opens in Expo Go.

Your phone and computer must be on the same Wi-Fi network. If they aren't (or
the office network blocks device-to-device traffic), run `npx expo start
--tunnel` instead and scan that QR code.

## Layout

- `App.js` — the single screen.
- `index.js` — registers `App` as the root component (don't edit).
- `app.json` — Expo config: app name, icons, orientation.
- `assets/` — icon and splash images (still the Expo defaults).

Expo SDK 57 / React Native 0.86. Expo Go on the phone must be a version that
supports SDK 57; the App Store version does.

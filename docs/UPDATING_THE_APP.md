# Getting a change onto your phone

**Read the first table. It answers "what do I have to do?" for any change.**

---

## 1. Which kind of change is it?

Ask Claude this if it isn't obvious. Every change is one of three kinds, and
they need different things from you.

| Kind of change | What you do | How long |
|---|---|---|
| **App only** — screens, buttons, wording, layout | Pull + Run in Xcode | ~5 min |
| **Server only** — data, rules, API, prices, availability | Merge the PR. That's it. | ~2 min |
| **Both** | Merge the PR **and** pull + Run | ~7 min |

**Why there are two:** the app on your phone is built from a branch on your
Mac. The server it talks to is the live one, and the live server runs
whatever is on `main`. A branch the live server has never seen might as well
not exist. Anything server-side has to be merged before the app can use it —
no amount of rebuilding will help.

**Claude must tell you which kind it is before you start.** If it doesn't,
ask.

---

## 2. Server change: merge the PR

Open the pull request link, press **Merge**. Render redeploys in a couple of
minutes on its own. Nothing to rebuild, nothing to install.

---

## 3. App change: pull and Run

In Terminal, one line at a time:

```
cd ~/Downloads/mysite-claude-pjl-field-taptopay
```

```
git pull
```

Then open the app project — **the workspace, not the project file**:

```
open pjl-field/ios/PJLField.xcworkspace
```

> `.xcworkspace` is the white icon. `.xcodeproj` is the blue one and it opens
> a broken, empty version with no targets. They sit next to each other and it
> is an easy mis-click.

Plug the phone in, unlock it, pick it from the dropdown at the top, press
**Run** (▶).

---

## 3a. Over-the-air updates — when Xcode is not needed at all

Most of what changes in this app is JavaScript: a screen, some wording, a
rule about what happens when you tap something. None of that needs Xcode.
The app can fetch it itself.

**How it works.** On a cold start the app asks Expo whether there is a
newer JavaScript bundle for it. If there is, it downloads it and reloads —
about a second, once, and then it is running the new code. Force-quit and
reopen; that is the whole procedure.

**Why it never worked before.** The app was always built to do this. What
it was never told is which *channel* to read — think of a channel as a
named shelf on Expo's server. `eas.json` names the shelves, but only EAS
reads that file, and you build by hand in Xcode. So the app asked for
"nothing in particular", got nothing back, and carried on. Restarting it a
hundred times would not have helped. `app.json` now names the shelf
(`expo-channel-name: production`), so the app knows where to look.

### The one-time cost

`app.json` is native configuration. It only reaches the app through a
prebuild, which means **one more full Xcode round, including re-setting
the signing team and the build configuration** — everything in §4 below.
After that round, JS changes stop needing Xcode.

Once, then never again for this class of change.

### Publishing an update

From the `pjl-field` folder, on a machine signed in to Expo:

```
npx eas update --branch production --message "what changed"
```

Then force-quit the app on the phone and reopen it. Check the bottom of
the **Today** tab: it reads *"App updated"* followed by the time the
bundle was published, or *"shipped with the build"* if it is still running
what Xcode installed.

### What still needs a real build

| Change | Over the air? |
|---|---|
| A screen, wording, a rule, a bug in the app's logic | **Yes** |
| A new library, a new permission, an icon, the splash | No — §4 |
| Anything in `app.json` itself, including this channel | No — §4 |
| Server changes | Neither — §2, they are already live |

### The fingerprint, and why it protects you

`runtimeVersion` is set to `fingerprint`, which means an update will only
install onto a build whose **native code is identical**. That is a safety
catch, not an obstacle: it is what stops a bundle written against a new
library landing on a build that does not have it and crashing on launch.

The practical consequence: **the Tap to Pay build can never receive these
updates.** It carries an extra native library, so its fingerprint differs
and Expo will not offer it anything published from `main`. That is correct
behaviour. If you are running a Tap to Pay build, Xcode is the only route.

### If a bad update goes out

An update reaches every phone on that channel with nothing in between —
there is no review step. Publish the previous bundle again to roll back:

```
npx eas update:republish --branch production
```

The app picks it up on the next cold start, the same way it picked up the
bad one.

## 4. When the native project has to be rebuilt

Most pulls don't need this. You need it when Claude says a **native
dependency** changed, or when Xcode shows **no targets** and **"No
Configurations Set"** (which means the iOS folder is damaged).

```
cd ~/Downloads/mysite-claude-pjl-field-taptopay/pjl-field
```

```
npx expo prebuild -p ios --clean
```

Takes a few minutes. **It wipes the iOS folder and rebuilds it**, which
resets two things you must put back:

### 4a. Signing team

In Xcode: click **PJLField** in the left sidebar → **Signing & Capabilities**
→ click the **All** tab (not Debug, not Release) → **Team → Patrick Lalande**.

> **The All tab matters.** Set it on Debug only and the Release build still
> fails with "requires a development team", which looks like the fix didn't
> work.

### 4b. Build configuration

**Product → Scheme → Edit Scheme → Run → Build Configuration → Release.**

> Prebuild resets this to **Debug**. A Debug build loads its JavaScript live
> from your Mac, so the moment you walk away from it the app dies with a red
> `RCTFatal / handleBundleLoadingError` screen. Release bakes the JavaScript
> in and needs nothing from the Mac. **Always Release.**

Note: `pjl-field/ios` is not in the repo — it's generated on your Mac. So a
`git pull` can never break it, and Claude can never fix it from its side.
That folder is yours alone.

---

## 5. First launch after a rebuild — expect these

None of these are faults.

1. **"Untrusted Developer"** on the phone. Fresh certificate.
   Phone → **Settings → General → VPN & Device Management → Apple
   Development: [your email] → Trust**. Reopen the app.
2. **You're signed out.** Reinstalling wipes the app's stored session. Open
   any tab, tap **Sign in**, use your CRM password.
3. **Tap to Pay says "Not started yet."** Open it from Today's header and let
   it warm up. Apple's terms sheet may appear again on a fresh install.

---

## 6. Settings that live outside the code

Things that no amount of building will fix, because they aren't code.

| Symptom | Where the fix is |
|---|---|
| *"Google refused the request — the Places API is probably not enabled"* | Google Cloud Console → **APIs & Services → Library → Places API** (the plain one, **not** "Places API (New)"). Then **Credentials → your key → API restrictions** — if the key is restricted, Places has to be on that list. |
| *"GOOGLE_MAPS_SERVER_KEY is not set"* | Render → the service → **Environment** |
| Address suggestions fine, but no map/route line | Same key, but it's a Geocoding or Distance Matrix problem — send Claude the screenshot |

---

## 7. When something looks broken

Send Claude a screenshot. The app is built to say *why* rather than just
failing, so the message on screen usually names the actual cause — including
when the cause is a setting in Google or Render rather than the code.

Two things that are **never** the cause, so don't chase them:

- **The cable or the phone**, when Xcode says "No Destinations" and the
  TARGETS list is empty. There is nothing to build, so there is nowhere to
  build it to. See section 4.
- **A `git pull`**, when the iOS project is broken. That folder isn't in the
  repo.

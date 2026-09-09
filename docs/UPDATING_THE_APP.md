# Getting a change onto your phone

**You do not have to work out which kind of change it is. Ask the computer.**

Open Terminal and run these three lines. That is the whole system.

```
cd <your mysite folder>/pjl-field
git pull
npm run send
```

> **Which folder?** The one you keep the site in. There is more than one
> clone on this Mac — `mysite-claude-pjl-field-taptopay` is the Tap to Pay
> one and is *not* the one to use for ordinary updates (see the bottom of
> this page). Once you know the path, it never changes; write it on a
> sticky note.

`npm run send` looks at what changed and does one of two things:

- **"SENT"** — it published the update. Force-quit PJL Field on your phone
  and open it again. Done, about 30 seconds.
- **"THIS ONE NEEDS XCODE"** — it published nothing, because the phone
  could not have installed it. It tells you to run `npm run rebuild`.

It cannot get this wrong and it cannot leave you guessing. Everything below
is explanation you only need when something surprises you.

---

## The two commands

### `npm run send`

The everyday one. After any merge, run it.

It compares the code you have against the build that is on your phone. If
the two are compatible, the update goes over the air. If they are not, it
stops and says so — publishing anyway would put a bundle on Expo's server
that your phone quietly refuses, which looks exactly like "the update
didn't work" and is much harder to diagnose than a message that says
*needs Xcode*.

It also refuses if you have uncommitted edits, or if your checkout is
behind `main`, because both of those send the phone the wrong code. Each
refusal prints the one line that fixes it.

```
npm run send                       publish, with the last commit as the note
npm run send -- -m "what changed"  your own note instead
npm run send -- --anyway           publish despite the git warnings
```

`--anyway` overrides the git checks only. It cannot override *needs
Xcode*: that one is not a judgement call, it is the phone refusing.

### `npm run rebuild`

The occasional one. Run it when `send` tells you to, or when Xcode shows
**no targets** and **"No Configurations Set"** (the iOS folder is damaged).

It regenerates the Xcode project **and puts back the two settings that a
rebuild always destroys** — the signing team and the Release
configuration. You used to have to remember both. You no longer do.

Then it tells you to plug the phone in and press Run.

---

## Why some changes need Xcode and some don't

The app on your phone is two layers.

**The native shell** — the app itself, its libraries, its permissions, its
icon. Building that is what Xcode does, and it can only happen on your Mac
with the phone plugged in.

**The JavaScript** — every screen, every button, every rule about what
happens when you tap something. That is the great majority of what changes,
and the app can download a new copy of it by itself.

So: change the JavaScript, it goes over the air. Change the shell, Xcode.

**Expo enforces this with a fingerprint.** Every build carries a hash of
its native shell, and an update will only install onto a build whose hash
matches. That is a safety catch, not an obstacle — it stops a bundle
written against a new library landing on a build that doesn't have it and
crashing on launch. `npm run send` reads that same fingerprint, which is
why its answer is reliable rather than a rule of thumb.

| What changed | Over the air? |
|---|---|
| A screen, wording, a rule, a bug in the app's logic | **Yes** |
| A new library, a new permission, the icon, the splash | No — Xcode |
| Anything in `app.json` | No — Xcode |
| Server: data, prices, availability, API | Neither — see below |

---

## Server changes are a different thing entirely

The app talks to the live server, and the live server runs whatever is on
`main`. So anything server-side needs **the PR merged** and nothing else —
no rebuild, no update, no phone. Render redeploys on its own in a couple of
minutes.

A branch the live server has never seen might as well not exist. If a
change is server-side, rebuilding the app a hundred times will not help.

**Claude tells you which kind each change is.** If it doesn't, ask.

---

## Did my update actually land?

Bottom of the **Today** tab:

- **"App updated 4:12 PM"** — running a bundle published at that time.
- **"shipped with the build"** — still running what Xcode installed.

If it still says *shipped with the build* after a force-quit, the app
either couldn't reach Expo or there was nothing newer for it.

## Sending a bad update

An update reaches every phone on the channel with nothing in between —
there is no review step. Put the previous bundle back:

```
npx eas update:republish --branch production
```

The phone picks it up on the next cold start, the same way it picked up the
bad one.

---

## Expect these after a rebuild

None of them is a fault.

1. **"Untrusted Developer"** on the phone — fresh certificate.
   Settings → General → VPN & Device Management → Apple Development →
   **Trust**. Reopen the app.
2. **You're signed out.** Reinstalling wipes the stored session. Open any
   tab, Sign in, use your CRM password.
3. **Tap to Pay says "Not started yet."** Open it from Today's header and
   let it warm up. Apple's terms sheet may reappear on a fresh install.

---

## The Tap to Pay build is a special case

It carries an extra native library, so its fingerprint differs from
everything published off `main` and **it can never receive these updates**.
That is correct behaviour, not a fault. If you are running a Tap to Pay
build, Xcode is the only route until that work merges.

---

## Things no rebuild can fix

Because they aren't code.

| Symptom | Where the fix is |
|---|---|
| *"Google refused the request — the Places API is probably not enabled"* | Google Cloud Console → **APIs & Services → Library → Places API** (the plain one, **not** "Places API (New)"). Then **Credentials → your key → API restrictions** — if the key is restricted, Places has to be on the list. |
| *"GOOGLE_MAPS_SERVER_KEY is not set"* | Render → the service → **Environment** |
| Addresses suggest fine, but no map or route line | Same key, but a Geocoding or Distance Matrix problem — send Claude the screenshot |

---

## When something looks broken

Send Claude a screenshot. The app is built to say *why* rather than just
fail, so the message on screen usually names the real cause — including
when the cause is a setting in Google or Render rather than the code.

Two things that are **never** the cause, so don't chase them:

- **The cable or the phone**, when Xcode says "No Destinations" and the
  TARGETS list is empty. There is nothing to build, so there is nowhere to
  build it to. Run `npm run rebuild`.
- **A `git pull`**, when the Xcode project is broken. `pjl-field/ios` is
  not in the repo — it is generated on your Mac, so a pull cannot touch it
  and Claude cannot fix it from its side. That folder is yours alone.

# Tap to Pay — what Patrick does, in order

The code is written. This is the part that needs hands on a phone and a
browser, in the order it has to happen. Nothing here can be done from the
repository.

> **The branch `claude/pjl-field-taptopay` must NOT be merged to `main`
> yet.** The moment the Stripe SDK is on `main`, the app you use on real
> closings stops receiving over-the-air fixes, because its fingerprint no
> longer matches any installed build. It merges after Apple grants the
> publishing entitlement, not before.

---

## Step 1 — register your iPhone  (5 minutes, once)

The development entitlement Apple granted works on **registered devices
only**. Your phone is not registered yet.

Easiest way, from a browser:

1. Find your device UDID. On the iPhone: Settings → General → About →
   scroll to **Serial Number**; long-press it and there is a *Copy UDID*
   option on recent iOS. Failing that, connect it to a Mac and read the
   UDID from Finder.
2. Apple Developer → **Certificates, Identifiers & Profiles** → Devices →
   **+** → Register a device with that UDID.

Alternatively, from a machine with the repo, `eas device:create` walks you
through it and can register by scanning a QR code on the phone.

## Step 2 — make the build

GitHub → Actions. **The existing "Field app — build for TestFlight"
workflow will not do** — it builds the `production` profile and submits to
TestFlight, and neither is allowed for this build. Use the `taptopay`
profile instead:

```
eas build --platform ios --profile taptopay
```

If that has to run from the phone rather than a laptop, say so and a
workflow can be added for it — it was left out deliberately rather than
guessed at, because the build profile is the one thing here nobody has
tested yet (see **The one unknown** below).

When it finishes, EAS gives you an install link. Open it on the iPhone.

> **This replaces the PJL Field on your home screen.** Same bundle ID, one
> install. To go back to the everyday app, reinstall it from TestFlight —
> that is the whole swap, about a minute either way.

## Step 3 — first run

1. Open the app. On the **Today** screen, top row beside the week arrows,
   there is a new **▤** button. That is Tap to Pay's own screen.
2. Press **Set up Tap to Pay on iPhone**.
3. **Apple will ask you to accept its Terms and Conditions with your Apple
   Account.** That screen is Apple's — it cannot be skipped or restyled,
   and only the account holder can accept it. This happens once.
4. Wait for **Status: Ready**. The first configuration takes a minute or
   two; after that the reader warms up by itself whenever the app opens.

## Step 4 — take a payment

Finish a closing as normal and land on the invoice. **Tap to Pay on
iPhone** is the first button, above *Send invoice*.

- Press it. Apple's screen comes up.
- Hold the customer's card, phone or watch to **the top of your iPhone**.
- Approved → the invoice updates itself. Nothing to record by hand.

**Test it on yourself first**, with a real card and a real invoice for a
dollar or two, before doing it in front of a customer. Refund it in Stripe
afterwards.

### When a card will not tap

Some Canadian cards are offline-PIN only and cannot be tapped — the PIN
needs a physical terminal. **This is normal here, not a fault.** Ask for
another card or a phone wallet, or fall back to the payment link. Both
other buttons are still on the screen.

---

## The one unknown, stated rather than hidden

Apple's grant says the development entitlement supports **development
provisioning profiles** on registered devices. The `taptopay` build
profile uses EAS `distribution: internal`, which for a standard Apple
Developer Program account produces an **ad-hoc** profile.

Ad-hoc and development are both device-restricted, but they are not the
same thing, and **nobody has run this build yet**. If EAS or Apple rejects
the signing, the fallback is the `development` profile
(`eas build --profile development`), which produces a development-signed
build — at the cost of it being an Expo dev-client build.

If step 2 fails on signing, send the error and it gets fixed in one change.
It is the only step in this document that has never been executed.

---

## What is NOT in this build

Deliberately, and each for a reason:

| Not built | Why |
|---|---|
| Apple's merchant-education overlay (4.1) | It needs a small Swift module, and Swift cannot be compiled or tested from this environment. A broken native module fails the whole EAS build, so it is isolated into its own change rather than risking this one. |
| Push notification if the app is closed mid-payment (5.12) | Needs `expo-notifications` and an APNs key — another native module, and another fingerprint change. |
| The awareness splash (3.1–3.3) | Must use Apple's approved "Hero" asset from the Marketing Toolkit, which only you can download. Send it over and it takes ten minutes. |

**None of these block you taking a payment.** All three are needed before
the *publishing* entitlement submission, not before the first tap.

---

## Then, when it works

1. **Record three videos** — new user flow, enablement + education,
   checkout. **Film the checkout one with a second camera.** Apple's Tap to
   Pay screens come out black in a screen recording, and filming it wrong
   costs a full review round trip.
2. **Complete the checklist** (`docs/TAP_TO_PAY_REQUIREMENTS.md` has every
   answer, including the header fields).
3. **Reply to `ttpoientitlements@apple.com`** quoting **Case-ID 22041657**
   with the videos and the checklist.
4. Publishing entitlement granted → **then** this branch merges to `main`,
   TestFlight works again, and the everyday app and Tap to Pay become the
   same app.

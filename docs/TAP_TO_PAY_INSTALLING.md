# Tap to Pay — exactly what to do, tap by tap

Written for someone with an iPhone and a browser and no terminal, because that
is the situation. Every step is a real tap or click. Where a step is genuinely
uncertain it says so.

> **The branch `claude/pjl-field-taptopay` must NOT be merged to `main` yet.**
> The moment the Stripe SDK is on `main`, the everyday app stops receiving
> over-the-air fixes: its fingerprint no longer matches any installed build, and
> TestFlight cannot carry a replacement until Apple grants publishing. It merges
> after that.

---

## Step 1 — tell Apple which iPhone is allowed to run it

### What this is, and why

An app that has not been through the App Store can only be installed on phones
Apple has been told about **in advance**, by a hardware serial called a **UDID**
(Unique Device IDentifier — a 25- or 40-character code unique to your phone).
Apple keeps a list of them per developer account. If your phone is not on that
list, the app physically will not install; the build itself fails first, saying
there are no devices to build for.

You are adding your iPhone to that list. It is a one-off. It has nothing to do
with Tap to Pay specifically — it is how any pre-release iOS app reaches a
phone.

### 1a. Get the UDID off the phone

**If you have any Mac, Windows PC, or laptop** — that is the clean way:

- **Mac:** plug the iPhone in with a cable → open **Finder** → the iPhone
  appears in the left sidebar → click it → under the device name at the top,
  **click on the line of text** showing capacity/serial. It cycles through
  fields; keep clicking until it shows **UDID**. Right-click → **Copy UDID**.
- **Windows:** plug the iPhone in → open **iTunes** (or Apple Devices) → click
  the small phone icon → **Summary** → **click the word "Serial Number"** and it
  changes to UDID → right-click → **Copy**.

**If you only have the iPhone**, the UDID is not directly visible in Settings —
Apple removed it. The way everyone does it is a website that installs a small
configuration profile which reads and shows it:

1. Open **Safari** on the iPhone (it must be Safari — Chrome cannot install
   profiles).
2. Go to **udid.my** (or showmyudid.com — either works the same way).
3. Tap the **Get My UDID** button.
4. Safari asks to allow a download — tap **Allow**.
5. Go to **Settings** → **General** → **VPN & Device Management**.
6. Tap the newly downloaded profile → **Install** (top right) → enter your
   passcode → **Install** again.
7. The page returns showing your UDID with a copy button. **Copy it.**
8. **Then remove the profile**: Settings → General → VPN & Device Management →
   tap it → **Remove Profile**. It has done its job and there is no reason to
   leave a third party's profile installed.

> **Be straight about what this is:** you are installing a configuration profile
> from a company that is not Apple, for about a minute. It reads the device
> identifier and nothing else, and step 8 removes it. If that sits badly, borrow
> any computer for two minutes instead — the Mac/Windows route above needs no
> third party at all. Both get the same string.

### 1b. Put the UDID on Apple's list

This is a normal web page and works on the phone, though it is easier on a
bigger screen.

1. Go to **developer.apple.com/account**
2. Sign in with the Apple Account that owns the developer membership — the same
   one that got the Tap to Pay entitlement email.
3. Click **Devices** in the left sidebar. (If you do not see it, click
   *Certificates, Identifiers & Profiles* first.)
4. Click the blue **＋** next to the "Devices" heading.
5. **Platform:** leave it on *iOS, tvOS, watchOS*.
6. **Device Name:** anything you will recognise — `Patrick iPhone` is fine.
7. **Device ID (UDID):** paste the string from 1a.
8. **Continue** → check it looks right → **Register**.

Done. It should now be listed under Devices. This does not need repeating unless
you get a new phone.

---

## Step 2 — make the build

**GitHub → Actions → "Field app — Tap to Pay build (development)" → Run
workflow.** Then, and this matters: in the little branch dropdown, choose
**`claude/pjl-field-taptopay`**, not `main`. `main` has no Tap to Pay in it.
(The workflow checks, and stops with a clear message if you pick the wrong one,
rather than handing you a build with nothing in it.)

It takes roughly 15–25 minutes, most of it queueing at Expo.

**Do not use "Field app — build for TestFlight".** That one builds a different
kind of build and tries to send it to TestFlight, and neither is allowed here.

When it finishes, open the run's log and scroll up through the EAS output to
find the **install URL**. Open that URL **in Safari on the iPhone** — not on a
computer — and it installs.

> **It replaces the PJL Field on your home screen.** Same app identity, so iOS
> allows only one. To go back to the everyday app, reinstall it from TestFlight.
> About a minute either way, as often as you like.

---

## Step 3 — first run, once

1. Open the app. Go to the **Today** tab.
2. In the top row, beside the ‹ › week arrows, there is a small **▤** button.
   Tap it.
3. Tap **Set up Tap to Pay on iPhone**.
4. **Apple asks you to accept its Terms and Conditions**, using your Apple
   Account. That screen belongs to Apple — it cannot be skipped or restyled, and
   only the account holder can accept it. Once only.
5. Wait until it shows **Status: Ready**. The very first setup can take a couple
   of minutes while the phone configures itself; after that the app gets the
   reader ready by itself every time you open it.

---

## Step 4 — take a real payment

Finish a closing as normal and land on the invoice. **Tap to Pay on iPhone** is
the first button, above *Send invoice*.

1. Tap it. Apple's payment screen comes up.
2. Hold the card, phone or watch **flat against the top of your iPhone**, near
   the camera.
3. Hold it there until the screen says it is done — about a second.
4. Approved → the invoice updates itself. Nothing to record by hand.

**Do this on your own card first**, for a dollar or two, on a real invoice, and
refund it in Stripe afterwards. Do not let a customer be the first tap.

### When a card will not tap

Some Canadian cards are offline-PIN only and cannot be tapped at all — the PIN
needs a physical terminal. **This is normal here, not a fault, and not something
to apologise for.** Ask for a different card or a phone wallet, or use the
payment link. Both other buttons are still on the same screen.

---

## Two things that have never been run

Said plainly rather than buried, because they are where this can waste your
time.

**The build signing.** Apple's grant says the development entitlement supports
*development* provisioning profiles. The build profile here produces an *ad-hoc*
one. Both restrict to registered devices, but they are not the same thing, and
nobody has run this build yet. **If step 2 fails with an error mentioning
provisioning or signing, send me the error** — it is a small fix, not a redesign.

**The install itself.** Nothing about steps 3 and 4 has been executed on a real
phone. The code is checked as far as it can be checked without one — it parses,
the entitlement is declared, the requirements are pinned by tests — but "it
builds" is not "it works", and I will not claim otherwise until you have tapped
a card with it.

---

## Not in this build

| Not built | Why | Blocks a payment? |
|---|---|---|
| Apple's merchant-education overlay | Needs Swift that cannot be compiled or tested from here, and a broken native module fails the whole build | No |
| Push notification if the app is closed mid-payment | Needs another native module and an Apple push key | No |
| The awareness splash screen | Must use Apple's approved image from the Marketing Toolkit, which only you can download | No |

All three are needed before the **publishing** submission. None stop you taking
money next week.

---

## Then, when it works

1. **Record three videos**: the new-user flow, enabling it + the education
   screens, and a checkout.
   > **Film the checkout one with a second camera** — another phone on a
   > table, pointed at your iPhone. Apple's Tap to Pay screens come out **black**
   > in a screen recording. Filming it wrong costs a full review round trip.
   The other two can be ordinary screen recordings.
2. **Fill in the checklist** Apple sent. `docs/TAP_TO_PAY_REQUIREMENTS.md` has
   every answer, including the header fields (Team ID `JBYT65U657`, app name
   PJL Field, PSP Stripe, distribution Unlisted).
3. **Reply to `ttpoientitlements@apple.com`**, quoting **Case-ID 22041657**,
   with the videos and the checklist attached.
4. Publishing entitlement granted → **then** the branch merges, TestFlight works
   again, and the everyday app and the Tap to Pay app become one app.

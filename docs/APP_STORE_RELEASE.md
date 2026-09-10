# Getting PJL Field onto your phone, permanently

**Read this once. After it's done you never open Xcode again, and every change
lands on your phone by itself.**

---

## Why there is a step at all

Apple will not let an app onto an iPhone without reviewing it once. Not
TestFlight, not the App Store, no exceptions and no way around it. That's Apple's
rule, not a choice anyone here made.

The good news is it's **once**. After the app is published and installed from the
App Store, every change to the app's screens ships over the air automatically —
merged, published, and on your phone inside a minute. No Mac, no Xcode, no
waiting on Apple.

The only thing that ever needs Apple again is a change to the app's *native*
parts — a new hardware feature like Tap to Pay, or a yearly iOS upgrade. Those
are rare. Everything else is instant.

---

## What you do — two sittings, about 20 minutes total

### Sitting 1 — start the build (2 minutes)

1. Go to **github.com/PJLLandServices/mysite/actions**
2. Left sidebar: **Field app — build for TestFlight**
3. Right side: **Run workflow** → leave the box ticked → green **Run workflow**

That's it. It takes about 25 minutes on its own; you don't have to watch it.

> **"I said no TestFlight."** You're not being put back on TestFlight. That's just
> the workflow's name. Every iPhone app, App Store or otherwise, has to be
> uploaded to **App Store Connect** first — TestFlight is simply the section of
> that website where uploaded builds land. You will never install from it. The
> build sits there so it can be attached to the App Store submission in sitting 2.
>
> The workflow is worth renaming; it's on the list.

### Sitting 2 — submit it (about 15 minutes, once)

Go to **appstoreconnect.apple.com** → **Apps** → **PJL Field**.

Apple asks for a set of fields before the Submit button turns on. Everything you
need is written out below — copy and paste it.

#### Before anything else: the demo account

**This is the single most common reason a submission gets rejected.** The app
shows a login screen and the reviewer cannot get past it. Under
**App Review Information** there is a **Sign-in required** toggle — turn it ON and
give them a real working login.

Make a throwaway account for Apple rather than handing over yours:

```
npm run create-user
```

Use something like `applereview@pjllandservices.com` with a password you don't
mind writing into a form. Make it a **tech**, not an admin. Put that email and
password into the User Name and Password boxes.

If the reviewer can't log in, they reject it without looking at anything else,
and you wait another two days.

#### App Review Information → Notes

Paste this:

```
PJL Field is the internal field-service app for PJL Land Services, a
sprinkler and irrigation contractor in Ontario, Canada. It is used by our
own technicians on their own phones to see the day's route, complete
service visits, record work orders and invoices, and answer customer
messages.

It is not intended for the general public. We intend to make this app
UNLISTED after approval so it is reachable only by direct link.

A working technician login is provided above. After signing in, the Today
tab shows the day's scheduled stops. The Properties tab lists serviced
addresses. The Messages tab shows customer conversations from our customer
portal.
```

That last paragraph matters — it tells the reviewer where to click.

#### The rest of the fields

| Field | What to put |
|---|---|
| **Support URL** | `https://www.pjllandservices.com` |
| **Privacy Policy URL** | `https://www.pjllandservices.com/privacy-policy.html` |
| **Category** | Primary: **Business**. Secondary: leave blank |
| **Age Rating** | Answer **None / No** to every question → 4+ |
| **Copyright** | `2026 PJL Land Services` |
| **Contact** | Patrick Lalande · info@pjllandservices.com · (905) 960-0181 |
| **Export compliance** | Already answered in the app itself (`usesNonExemptEncryption: false`). If asked, the app uses only standard HTTPS |
| **Pricing** | Free |
| **Availability** | Canada is enough |

#### Description

```
PJL Field is the field-service app for PJL Land Services technicians.

See the day's route on a live map with numbered stops. Complete a fall
closing step by step, capture the customer's signature, and produce the
invoice before leaving the driveway. Look up any serviced address with its
zones, photos, service history, work orders and invoices. Answer customer
messages from the road.

For PJL Land Services staff. A company login is required.
```

**Keywords:** `irrigation, sprinkler, field service, work order`

#### Screenshots

Apple requires screenshots for a 6.9" iPhone. Take them on your own phone
(**side button + volume up**), then drag the files in:

1. The **Today** tab with the map and the day's stops
2. A **property** open, showing zones and history
3. The **Messages** tab

Three is plenty.

#### Then

**Add the build** (the one from sitting 1 — it appears after Apple finishes
processing it, usually 10–15 minutes after the workflow ends), then
**Add for Review** → **Submit**.

---

## After Apple says yes

1. You'll get an email. Install PJL Field from the App Store link — **once**.
2. Delete the hand-built version currently on your phone first, so there's no
   confusion about which one you're looking at.
3. Then make it unlisted: request unlisted distribution at
   <https://developer.apple.com/contact/request/unlisted-app-distribution>.
   It can only be requested **after** the app has been through review, which is
   why this order matters. **The change is permanent** — an unlisted app cannot
   be made public again. That's fine here; it was the decision on 2026-09-06.

From that point on: changes appear on your phone by themselves. Nothing to press.

---

## What about Tap to Pay?

Not in this release, and that isn't a choice — Apple has to grant a second
entitlement (**publishing**, on top of the development one they already gave you)
before card tapping can ship in a published app. That request is in, on
**Case-ID 22041657**, and it's waiting on them.

When it lands: one more build, one more review, same steps as above. After that
Tap to Pay is in the published app and everything stays automatic.

The reason your phone stopped receiving updates is that the hand-built Tap to Pay
version is a different app as far as Apple's update system is concerned. Once
you're on the published one, that problem is gone for good.

---

## If it gets rejected

It happens, and it's usually one of two things:

- **"We could not sign in."** The demo account is wrong, expired, or wasn't a
  tech. Fix the account, reply in Resolution Center, resubmit. No new build
  needed.
- **Guideline 4.2 — "minimum functionality" / "this looks like it's for internal
  use."** They're right, it is. Reply in Resolution Center pointing at the review
  note: it's a company field-service tool, going unlisted after approval. If they
  hold the line, the alternative is **Apple Business Manager → Custom Apps**,
  which is built exactly for this and skips public review.

Either way, send me the rejection text and I'll write the reply.

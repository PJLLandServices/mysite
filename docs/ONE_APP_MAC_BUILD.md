# Building the one PJL Field app on the Mac (version 1.1.0)

**What this is:** the one native build in the PJL-114 plan ("One-app migration plan", in Linear). It
puts **one** PJL Field app on the phone:

- Tap to Pay, as you have it today;
- every photo taken in the app saved full size to your iPhone's photo library;
- updates from main that reach the phone by themselves.

It installs **over** the app you have now. It has the same bundle id, and your login and anything
waiting to sync stay.

**The click-by-click source is `docs/TAP_TO_PAY_MAC_BUILD.md`.** You've done it before. This page
says only what is different this time and what to check. Where it says "Step N", that's the step in
that file.

**Before you start:**
1. Have no visits open on the phone.
2. Open **Today** and wait for **Synced**, with nothing waiting to upload.
3. Note the footer at the bottom of Today. It should say `6fb695f`.
4. Charge the phone and the Mac.

Allow about an hour. Most of it is the first compile.

---

## 1. Xcode, Node, CocoaPods (Steps 1–3 and 5)

These were installed in September. Just check them in Terminal:

```
xcodebuild -version
node -v
pod --version
```

Each prints a version. If the App Store offers an **Xcode** update, install it first and open
Xcode once afterwards (Step 1).

## 2. Get the code (Step 4, but from main, not the lane)

Download **exactly the commit Claude gives you** (the merged one-app build), as a zip:

```
https://github.com/PJLLandServices/mysite/archive/<COMMIT>.zip
```

`<COMMIT>` is the 40-character id Claude sends with "ready to build". Keep it in Notes, because
Step 4 below needs it again.

Unzip it into a **new** folder. Do not reuse September's folder: its `ios/` project is the old
app's.

## 3. Install the packages (Step 6, 6a–6c)

In Terminal, go into the new folder's `pjl-field`. Step 6a shows how; drag the folder in after `cd `.
Then:

```
npm ci
```

## 4. Stamp the commit (Step 6d)

```
STAMP_SHA=<COMMIT> node ../scripts/stamp-field-build-info.mjs build
```

**Worked when:** it prints `Stamped build: commit` and the first seven characters of `<COMMIT>`.

## 5. Generate the iOS project (Step 7), clean

```
npx expo prebuild --platform ios --clean
```

`--clean` is new. It is there so nothing from an older project survives, because this build adds
two new pieces: saving to Photos, and the photo resizer.

Then, before opening Xcode, paste these **three checks**. Each must show what is listed, or stop
and send Claude the output.

**a. Tap to Pay is still allowed (Step 7a):**

```
cat ios/*/*.entitlements
```

It must contain `com.apple.developer.proximity-reader.payment.acceptance` and `<true/>`.

**b. The Photos permissions:**

```
plutil -p ios/*/Info.plist | grep -i photo
```

It must show both of these:
- `NSPhotoLibraryAddUsageDescription` => "PJL Field saves the photos you take on a visit to your Photos, so you have your own copy."
- `NSPhotoLibraryUsageDescription` => "PJL Field lets you attach photos you have already taken to a work order."

**c. The update channel the phone will listen on:**

```
plutil -p ios/*/Supporting/Expo.plist | grep -iE "runtime|channel"
```

It must show `EXUpdatesRuntimeVersion` => "1.1.0" and `expo-channel-name` => "production".
This is what lets updates from main reach the phone from now on.

## 6. Sign it (Step 8)

```
open ios/*.xcworkspace
```

On **Signing & Capabilities**, check three things:
- the same paid team, **not** "(Personal Team)";
- **Xcode Managed Profile**, with no red errors;
- **Tap to Pay on iPhone** listed as a capability.

## 7. Phone and build (Steps 9–10)

1. Plug the phone in. Developer Mode is already on from September.
2. Pick your **real iPhone** in the device menu, not a simulator.
3. Set the scheme to **Release** (Step 10a).
4. Press **▶**.

The first compile takes 15–40 minutes. It replaces the PJL Field app on the phone, and the app opens
by itself.

## 8. Before you unplug: save what you built

In Xcode: **Product → Archive**. When the Organizer window opens, close it, because the archive is
saved. It is the exact build on the phone, kept in case it's ever needed again.

---

## 9. Acceptance on the phone (from the plan, §7)

Do these in order. Send Claude a short "pass" or what you saw for each.

| # | Do | Pass when |
| -- | -- | -- |
| A1 | Open PJL Field. | It opens logged in. The Today footer shows `Runtime 1.1.0 · production` and `Commit` with the first 7 of `<COMMIT>`. Nothing that was waiting is lost. |
| A2 | Settings (▤ on Today) → **Set up Tap to Pay on iPhone**. Then take a **real small card** on a test invoice. | The reader is ready, and the invoice reads **Paid**. Refund it in the Stripe Dashboard afterwards. **Collect payment now** works on a draft without sending first. |
| A3 | In a test work order, **Take a photo**. | The first time, iOS asks to **add** photos, with the wording above. Tap **Allow**. The photo is in the Photos app (Recents) at full size: swipe up on it, and the size is about 12 MP. The work order shows the photo. |
| A5 | **Choose from library** on the work order. | It attaches, and **no duplicate** appears in Photos. |
| A6 | Mark up a photo and tap Done. | The marked-up copy is on the work order. **Photos holds only the original.** |
| A7 | Turn on airplane mode and take 3 photos. Then turn airplane mode off. | All 3 are in Photos straight away. They show as waiting on the work order, then sync once you're back online. |
| A8 | Finish a test work order. | Sign-off shows the payment answers **stacked, one per line**. Finish comes back quickly, and the invoice drafts. |
| A9 | Tell Claude, who publishes a small visible change from main. Close and reopen PJL Field twice. | The footer changes to the new commit. **This proves updates reach the new app.** |
| A10 | iPhone Settings → PJL Field → Photos → **None**. Take a photo. | The photo still attaches and uploads, and a one-time note says Photos access is off. Set it back to **Add Photos Only** afterwards. |

(A4 was the album. There isn't one, by your call.)

---

## If something goes wrong

- **The build fails on the Mac.** Nothing has changed on the phone; it still has today's app.
  Screenshot the red error and send it. Don't keep pressing ▶.
- **It's installed but broken** (won't open, or Tap to Pay or photos fail). You get today's app back
  exactly, because the old Tap to Pay lane is kept until you say the new one is proven:
  1. Download `https://github.com/PJLLandServices/mysite/archive/0c638a83434f9782d5a079af89e9bef7609f7fc7.zip`,
     the commit today's app was built from.
  2. Repeat Steps 3–7 of this page from it, **skipping the three checks in 5b and 5c**. That older
     app has none of these new entries.
  3. Tell Claude. Claude gives you the lane publish that puts today's code (`6fb695f`) back on it.
- **No Mac nearby and you need the app.** Install **PJL Field from TestFlight**. That's the
  everyday app, with everything except Tap to Pay. Send card payments as invoice links until the
  rebuild.
- **Keep TestFlight from replacing it.** In TestFlight → PJL Field, keep **Automatic Updates off**,
  and don't tap Install or Update there (Step 12).

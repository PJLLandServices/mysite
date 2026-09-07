# Building the Tap to Pay app on the Mac — every keystroke

Read `docs/TAP_TO_PAY.md` first if you want the *why*. The short version:

> Apple's **development** Tap to Pay entitlement only attaches to a **development**
> provisioning profile. EAS builds in the cloud and can only produce Ad Hoc,
> In-House and App Store profiles — so an EAS build can never carry it. Xcode
> creates development profiles automatically. That is the whole reason this
> file exists.

This is a one-time detour. Once the three demo videos go to Apple and the
**publishing** entitlement is granted, the EAS button build works permanently
and the Mac is never needed again.

**What you need in front of you**

- The M2 Mac, macOS updated, Xcode installed.
- The iPhone and its charging cable.
- The Apple ID that owns the PJL Land Services developer account.
- About two hours, most of it waiting on progress bars.

Every step below says what you should see when it worked. If you don't see it,
stop there and send me what you *do* see. Do not skip ahead — a step that
half-worked causes an error four steps later that looks like something else.

---

## Step 1 — Open Xcode once and let it set itself up

Xcode is not ready the moment it finishes downloading. It installs a second
batch of components the first time you open it.

1. Open **Launchpad** (the rocket icon in the Dock) and click **Xcode**.
2. It shows a licence agreement. Click **Agree**.
3. It says *"Xcode requires additional components"* or similar. Click
   **Install**.
4. It asks for your **Mac login password** — the one you use to unlock the
   Mac, not your Apple ID. Type it and press Return.
5. Wait. This is several minutes.

**Worked when:** you end up at a window with "Welcome to Xcode" and a list on
the right that is either empty or shows recent projects. Leave Xcode open.

---

## Step 2 — Tell Xcode to hand out its command line tools

The build tools live inside Xcode. A setting decides whether anything outside
Xcode is allowed to use them, and it is sometimes blank after a fresh install.

1. In Xcode's menu bar at the top of the screen, click **Xcode** → **Settings…**
   (keyboard: `⌘ ,`).
2. Click the **Locations** tab along the top of the settings window.
3. Look at the **Command Line Tools** row. It is a dropdown.
4. If it is **empty**, click it and choose the Xcode version listed.
   If it already names a version, leave it alone.
5. If it asks for your Mac password, that is expected.
6. Close the settings window.

**Worked when:** the Command Line Tools dropdown shows a version number rather
than nothing.

---

## Step 3 — Install Node

The app is a JavaScript project; Node is what runs the tooling. The Node you
installed on the Windows desktop does not help here — this is a different
computer.

1. In Safari go to **https://nodejs.org**.
2. Click the big button on the **left** — the one labelled **LTS**. LTS means
   the stable one. Do not take the other button.
3. If it offers a choice of file, pick the **macOS Installer (.pkg)** for
   **Apple Silicon / arm64**. The M2 is Apple Silicon.
4. When it finishes downloading, open **Downloads** and double-click the
   `.pkg` file.
5. Click **Continue**, **Continue**, **Agree**, **Install**. Give it your Mac
   password when asked.
6. Click **Close** at the end. If it offers to move the installer to the
   Trash, say yes.

**Worked when:** the installer's last screen says the installation was
successful. We verify it properly in Step 6.

---

## Step 4 — Get the code onto the Mac

There is no need for git, GitHub Desktop or any account setup. Download it as
a zip file in the browser.

1. In Safari, sign in to **github.com** with the account that owns the repo.
2. Go to:
   **https://github.com/PJLLandServices/mysite/tree/claude/pjl-field-taptopay**

   That URL matters. It is the **Tap to Pay branch**, not the main code. If
   the box near the top-left of the file list does not say
   `claude/pjl-field-taptopay`, you are on the wrong page — do not continue.
3. Click the green **Code** button on the right.
4. Click **Download ZIP** at the bottom of the little menu.
5. Open **Downloads** in Finder and **double-click the zip file**. macOS
   unzips it into a folder next to it.

**Worked when:** Downloads contains a folder named something like
`mysite-claude-pjl-field-taptopay`. Open it — you should see folders including
`pjl-field`, `server` and `docs`. **Leave this Finder window open**, we drag
from it in Step 6.

---

## Step 5 — Open Terminal and install CocoaPods

CocoaPods assembles the iOS half of the app. It does not ship with the Mac.

### 5a. Open Terminal

Press `⌘ Space`, type `terminal`, press Return. A window with white or black
text appears. That is Terminal. Every command below: **copy it, click into the
Terminal window, paste with `⌘ V`, press Return.**

**When Terminal asks for your password, nothing appears as you type.** No dots,
no stars, nothing moves. That is deliberate, not a frozen screen. Type it and
press Return.

### 5b. Install Homebrew

Homebrew is the standard installer-of-things on a Mac. One command:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/brew/HEAD/install.sh)"
```

It prints a list of what it will do and says **"Press RETURN to continue"** —
press Return. Then it asks for your Mac password. Then it works for several
minutes.

### 5c. Put Homebrew on the path

At the end Homebrew prints a "Next steps" section telling you to run two
commands. Run these two, one at a time:

```
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
```

```
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Neither prints anything. Silence is success.

### 5d. Install CocoaPods

```
brew install cocoapods
```

A few minutes of scrolling text.

**Worked when:** this command prints a version number:

```
pod --version
```

Something like `1.16.2`. If it says `command not found`, 5c did not take —
close Terminal, open a new one, and try again.

---

## Step 6 — Point Terminal at the app folder and install its packages

### 6a. Move Terminal into the folder

Type this, **including the trailing space, and do not press Return yet**:

```
cd 
```

Now go to the Finder window from Step 4, open the folder, and **drag the
`pjl-field` folder onto the Terminal window and let go**. Terminal pastes its
full path for you. *Now* press Return.

Check it landed:

```
pwd
```

The last part of what it prints must be `/pjl-field`.

### 6b. Confirm Node arrived

```
node --version
```

Must print `v20` or higher. If it says `command not found`, Step 3 did not
finish — redo it.

### 6c. Install the packages

```
npm install
```

Two to five minutes. Warnings in yellow are normal and can be ignored. A red
block starting `npm ERR!` is not — send it to me.

**Worked when:** it finishes with a line like `added 1200 packages in 90s`.

---

## Step 7 — Generate the iOS project

Expo apps have no Xcode project checked in; it is generated from `app.json`.
This is the step that writes the entitlements file with Tap to Pay in it.

```
npx expo prebuild --platform ios
```

If it asks to install a package to continue, answer **y**.

This runs for a few minutes and finishes by running CocoaPods itself — the
last screenful is pod names scrolling past.

**Worked when:** the last lines mention pod installation completing, and this
command lists a file:

```
ls ios/*.xcworkspace
```

If that says "No such file or directory", stop and send me everything the
prebuild printed.

---

## Step 8 — Open it in Xcode and sign it

```
open ios/*.xcworkspace
```

Xcode opens with the project loaded. **Always the `.xcworkspace`, never the
`.xcodeproj`** — the `.xcodeproj` builds without the pods and fails oddly.

### 8a. Add your Apple ID to Xcode

1. **Xcode** → **Settings…** (`⌘ ,`) → **Accounts** tab.
2. Click the **+** at the bottom-left → **Apple ID** → **Continue**.
3. Sign in with the Apple ID on the PJL developer account. Expect a
   two-factor code on your phone.
4. Close settings.

### 8b. Set the signing team

1. In the left sidebar, click the **blue icon at the very top** — the one with
   the project name.
2. In the panel that opens, find the **TARGETS** list and click the app target
   (the first one, named after the app — not one ending in `Tests`).
3. Click the **Signing & Capabilities** tab across the top.
4. Tick **Automatically manage signing** if it is not already ticked.
5. In the **Team** dropdown, choose the **PJL Land Services** team. Not
   "Personal Team".
6. Wait a few seconds. Xcode contacts Apple and creates a development
   provisioning profile by itself. **This is the entire point of using the
   Mac.**

**Worked when:** under Signing there is a line reading
`Provisioning Profile: Xcode Managed Profile` with **no red error text**, and
further down the same tab you can see **Tap to Pay on iPhone** listed as a
capability.

If you get a red error here, screenshot the whole Signing & Capabilities panel
and send it. Do not click "Try Again" repeatedly — the message is the useful
part.

---

## Step 9 — Plug in the iPhone and switch on Developer Mode

1. Plug the iPhone into the Mac with its cable.
2. The phone asks **"Trust This Computer?"** — tap **Trust** and enter your
   phone passcode.
3. In Xcode, at the top-middle of the window, there is a dropdown showing a
   device name. Click it and choose **your iPhone** from the list. It may say
   "(preparing)" for a minute or two while Xcode copies debug symbols — wait
   for that to finish.
4. On the phone: **Settings → Privacy & Security**, scroll to the bottom,
   tap **Developer Mode**, turn it **On**.
5. The phone insists on restarting. Let it. After it restarts, unlock it and
   tap **Turn On** on the prompt, then enter the passcode.

**Developer Mode does not appear in Settings until the phone has been
connected to Xcode at least once.** If you cannot find it, do steps 1–3 first
and look again.

**Worked when:** Xcode's device dropdown shows your iPhone by name with no
warning triangle beside it.

---

## Step 10 — Build and run

Press the **▶ play button** at the top-left of the Xcode window (keyboard:
`⌘ R`).

- The first build takes **15 to 40 minutes**. It is compiling the whole of
  React Native and the Stripe SDK from scratch. A progress bar that appears
  stuck is normal.
- Partway through, macOS asks for your password to let **codesign** use the
  keychain. Enter it and click **Always Allow**, not "Allow" — otherwise it
  asks again for every file.
- The app installs onto the phone and launches by itself.

**This replaces the PJL Field app already on the phone** — same bundle id, one
install. To go back to the everyday app, reinstall it from TestFlight.

**Worked when:** PJL Field opens on the phone and you can log in as normal.

---

## Step 11 — Check Tap to Pay is actually alive

1. In the app, go to the **Today** screen.
2. Tap the small **▤** button beside the week arrows.
3. Tap **Set up Tap to Pay on iPhone**.
4. Follow Apple's on-screen terms the first time. This needs internet and
   takes a minute.

**Worked when:** the setup screen reports the reader is ready. Then open any
invoice — **Tap to Pay on iPhone** is the first button in the actions list.

Do a real card for a small amount on a real invoice before filming anything.

---

## Then: the three videos

Apple's Requirements Guide wants three recordings. Details and the exact
checklist are in `docs/TAP_TO_PAY_REQUIREMENTS.md`. In outline:

1. The app's Tap to Pay setup flow, start to finish.
2. The invoice screen showing the Tap to Pay button in its correct position.
3. A real payment being taken — **film this one with a second camera**, since
   a screen recording of a card presentation does not capture the phone
   itself.

Send those on Case-ID 22041657. The publishing entitlement follows, and after
that the EAS button build works and this file becomes history.

---

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `command not found: brew` | Step 5c did not take | Close Terminal, open a new window, redo 5c |
| `command not found: node` | Step 3 did not finish | Redo Step 3, then open a **new** Terminal window |
| `command not found: pod` | CocoaPods not installed or not on the path | Redo 5c and 5d |
| prebuild ends with a CocoaPods error | Usually a half-finished Step 5 | Send me the last 30 lines |
| Red error under **Team** in Signing | The Apple ID is not on the developer team, or the wrong team is picked | Screenshot the whole panel and send it |
| `Tap to Pay on iPhone` missing from Capabilities | The capability came off the App ID | Tell me — it is a tick box on Apple's portal |
| Build fails with hundreds of red lines | Almost always a stale generated project | `npx expo prebuild --platform ios --clean`, answer **y**, then Step 8 again |
| The phone refuses to open the app | Developer Mode is off | Step 9, parts 4 and 5 |

Send me the **red text**, not a description of it. The exact wording is what
identifies the cause; "it failed on signing" fits nine different causes.

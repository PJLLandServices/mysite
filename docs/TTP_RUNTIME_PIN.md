# The Tap to Pay lane's runtime pin — temporary release infrastructure

**Status: TEMPORARY.** It must be removed or reconsidered before the next native build of the
Field app (Mac/Xcode, EAS, or TestFlight). Approved by Patrick, 2026-10-02 (Option A).

## What it is

On the Tap to Pay lane (`claude/field-taptopay`, #305) only, `pjl-field/app.json` carries:

```json
"runtimeVersion": "41661c6ff465c4c52451347262fc9fc638271ed6"
```

instead of main's `{ "policy": "fingerprint" }`. This is the one and only difference from the
native inputs of `0c638a8`, the commit Patrick's working phone was hand-built from.

## Why it exists

An update reaches a phone only when it is published to that phone's exact runtime.

- **Patrick's phone:** the hand-built Tap to Pay app reports `41661c6f…`, which his Mac fingerprinted
  at build time.
- **The same tree on a Linux runner:** fingerprints as `a7df9c32…`. Running prebuild first does not
  change it.

So a fingerprint-policy publish from CI goes to a runtime nothing listens on.

The old emergency lane (`field-app-hotfix-taptopay.yml`) worked around this by rewriting `app.json`
inside the runner, after checkout and before publishing. The tree it published was therefore not
the tree anyone had reviewed.

The pin makes the tree that is reviewed, tested and gated the same tree that is published:
- the value is committed;
- nothing rewrites `app.json` during publish.

## Why it is safe only for this phone, and only until the next native build

A literal runtime switches off the fingerprint's protection. Any build that embeds this runtime will
accept any update published to it, whatever native code that update was built against. Three things
hold it in place:

1. **Native compatibility is proven without trusting the pin.** On every run,
   `scripts/ttp-lane-guard.mjs` (main) checks four things:
   - every native-relevant file equals `0c638a8`, except `expo.runtimeVersion` in `app.json`, which
     must change from the fingerprint policy to exactly this literal;
   - with that one field put back to `0c638a8`'s value, in a throwaway copy, the fingerprint equals
     `a7df9c32…`, so the native code is unchanged;
   - the committed tree's own fingerprint equals the recorded pinned-tree fingerprint `ebf53e38…`;
   - the runtime that tree resolves to is exactly `41661c6f…`.
2. **No native build while it is present.** Both "Field app — build for TestFlight"
   (`field-app-build.yml`) and "Field app — Tap to Pay build" (`field-app-taptopay-build.yml`) refuse
   to build any tree whose `runtimeVersion` is not the fingerprint policy. A build carrying this
   runtime with different native code would take updates it crashes on.
3. **`scripts/test-ota-channel.mjs`** allows a literal runtime only when it is exactly this value.

**Not covered by any check:** a hand build on the Mac in Xcode. Before building on the Mac from
this lane, remove the pin first (see below).

## Removing it

Remove the pin when any of these happens, whichever comes first:
- a new native build of the Tap to Pay app replaces the hand-built one;
- the App Store or TestFlight Tap to Pay build ships;
- Tap to Pay merges to main.

To remove it:
1. On the lane, set `expo.runtimeVersion` back to `{ "policy": "fingerprint" }`.
2. Make the native build from that tree.
3. Read the new build's runtime from `GET /api/admin/field-clients` once the phone reports in.
4. Update `config/ttp-lane.json` (main) with the new installed build:
   - its source commit;
   - its runtime;
   - its fingerprints;
   - its known-good update.
5. Retire this document.

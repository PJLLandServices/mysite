# Help Centre — Technical Requirements

**Status:** DRAFT, awaiting approval. Nothing built yet.
**Companion to:** `docs/HELP_CENTRE_PRD.md`
**Opened:** 2026-09-23

---

## What already exists (do not rebuild it)

The builder's toolbar buttons already carry all three pieces of an entry.
From `server/sitebuilder.html:590-600`:

```html
<button id="mpToolsplit" onclick="mpSetTool('split')"
        data-tip="Split zone — with a zone selected, click two points…"
        aria-label="Split zone">
  <svg viewBox="0 0 24 24">…</svg>
</button>
```

| Piece | Where it is today |
|---|---|
| **symbol** | inline `<svg>` inside the button |
| **name** | `aria-label` |
| **description** | `data-tip` |

**Seven tools** carry this (`pan`, `poc`, `manifold`, `lat`, `bend`, `split`,
`tree`) plus **eleven buttons** carrying a `title=` tooltip. The raw material
is written and it is good. **The work is collecting it, not authoring it from
scratch.**

## The defect that sets the architecture

The Split tool's `data-tip` says the two halves are *"wired as one station."*
`mpSetSplit()` at `server/sitebuilder.html:2943` stores:

```js
r.splits[baseKey(z.key)] = { ax, ay, bx, by, shareStation: false };
```

That is **two** stations. The tooltip described the pre-`shareStation`
behaviour and was never updated when the default flipped.

**Two copies of a description drift, exactly as two copies of a state test
drift** (see `CLAUDE.md`, "Define the rule once"). So the central constraint
is not "build a help panel" — it is:

> **The tooltip and the help entry must be the same string, read from one
> registry, or this whole exercise reintroduces the bug it exists to fix.**

## Architecture

### One registry, two readers

```
server/sitebuilder-help.js      UMD, same shape as sitebuilder-engine.js
        │
        ├── read by sitebuilder.html  → tooltips AND the help panel
        └── read by scripts/test-help-coverage.mjs → the gate
```

`sitebuilder-engine.js` is already a UMD IIFE publishing a global plus
`module.exports`, served at `/admin/sitebuilder-engine.js`. **Follow that
pattern exactly** — same file layout, same serving route, so there is one way
things work here, not two.

### Entry schema

```js
{
  id:      "split",              // matches mpSetTool('split') / button id
  kind:    "tool",               // tool | action | concept | readout
  name:    "Split zone",         // == aria-label
  icon:    "split",              // key into the sprite
  tip:     "…",                  // THE tooltip. Single source of truth.
  body:    "…",                  // longer help-centre prose
  isNot:   "…",                  // PRD R7: what it is not
  confusedWith: ["share-station", "one-valve-per-box"],
  aliases: ["cut", "divide", "two boxes", "across the driveway"],
  seeAlso: ["station-vs-valve", "share-station"]
}
```

`tip` is what the button renders. The page stops hard-coding `data-tip` and
`title` and reads them from the registry at render time.

### Search

Match against `name + aliases + body + isNot`, case- and
punctuation-insensitive, **plus a tolerance layer** the PRD requires:

- **Voice-dictation misspellings.** Patrick dictates; the transcript says
  *"zine"* for zone, *"vowels"* for valves. A small explicit synonym map
  (`zine→zone`, `vowel→valve`, `vowels→valves`, `zines→zones`) beats a fuzzy
  matcher here: it is auditable, testable, and it can be extended the next
  time a word comes back wrong.
- **Whole-phrase questions.** "two valves one station" must land on the
  shared-station entry. Rank by number of query terms matched, not by
  substring position.
- **No external search library.** Requirement R6 is offline; the corpus is
  around forty entries. A linear scan is correct and fast enough.

### Icons

Lift the existing seven inline `<svg>` bodies into one `<symbol>` sprite,
referenced by `<use href="#hlp-split">`. Same glyph in the toolbar and in the
help entry — **that identical symbol is the whole point of Patrick's
request**, so it must be the same source, not a redrawn copy.

Concepts with no toolbar button need new glyphs. Keep the existing visual
language: 24×24 viewBox, stroked not filled, no external icon font (R6).

### Where the panel lives

A `?` control in the builder's toolbar opens an overlay. **It must not unmount
or reset the builder** — R1 says unsaved work survives. An overlay over the
existing DOM, not a route change and not a new page.

## The gate

`scripts/test-help-coverage.mjs`, wired into `build:check`, asserting:

1. **Every** `mpSetTool('x')` in the page has a registry entry with `id: "x"`.
2. **Every** button carrying a `title=` or `data-tip=` gets that string from
   the registry — no literal help strings left inline. This is what stops the
   split-tooltip defect from happening twice.
3. Every registry `id` is reachable from the UI or explicitly marked
   `kind: "concept"` (concepts have no button by definition).
4. Every `seeAlso` and `confusedWith` points at an `id` that exists.
5. Every entry has a non-empty `name`, `tip`, `body` and `icon`.
6. The search synonym map resolves: searching each entry's own `name` returns
   that entry in first place.

Per `CLAUDE.md`, **the test gets written against the unfixed page first.**
Point 2 must fail on today's code — the inline `data-tip` strings are still
there — or it is not testing anything.

## Rollout

| Phase | Deliverable | Ships behind |
|---|---|---|
| **1** | Registry + the seven tools + gate points 1, 5 | nothing — invisible refactor, tooltips render identically |
| **2** | Panel, search, sprite | a `?` button |
| **3** | Concepts (station vs valve vs area, legacy-assumed, mainline hold) | — |
| **4** | Actions and readouts; gate points 2, 3, 4, 6 fully on | — |

Phase 1 changes **no visible behaviour** and is provable by diffing rendered
tooltip text before and after — the same golden-master technique used for the
engine extraction.

## Notes for whoever builds this

- Tool button ids are inconsistent: **`mpTool3tree`** where every other is
  `mpTool<name>` (`mpToolsplit`, `mpToolpan`). Normalise when keying off ids,
  or key off the `mpSetTool()` argument instead, which is clean.
- `mpTools` is the toolbar container, not a tool. Do not treat the `mpTool`
  prefix as meaning "is a tool".
- `sitebuilder.html` is a single large file; the registry must be a separate
  served script, like the engine, so it can be required by a Node test
  without booting a browser.
- Do not import `server/server.js` from the test. It boots an HTTP server on
  import and the test will hang.

## Decisions still open

1. **Does the split tooltip get corrected now, or as part of Phase 1?** It is
   wrong today and a one-line fix. Recommendation: **now, separately**, so a
   live incorrect instruction is not waiting on a feature.
2. Does the registry also serve the admin app (`server/app-dist/`), or is it
   builder-only? Builder-only is assumed.
3. Printable help (PRD open question 2) would change the panel's markup;
   worth deciding before Phase 2 rather than retrofitting.

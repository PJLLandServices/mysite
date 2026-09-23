# Help Centre — Product Requirements

**Status:** DRAFT, awaiting Patrick's approval. Nothing built yet.
**Opened:** 2026-09-23
**Owner:** Patrick

---

## The problem, in Patrick's words

> *"One day I'm gonna be trying to design another system and this is gonna
> arise again and I won't be able to figure out what any tools do."*

The System Builder has **seven drawing tools and roughly a dozen actions**,
and the difference between a *station*, a *valve* and an *area* decides what
the whole design means. None of that is written down anywhere Patrick can
reach while he is in the builder with a job half-drawn.

Today he can only find out what a control does by **hovering it and reading a
tooltip he has to already know to look for**, or by asking Claude — which
means a question that costs a session of somebody's time instead of five
seconds of his own.

## The evidence this is real, not hypothetical

On 2026-09-23 Patrick drew a split across his tree zone, expecting the two
valves to run on **one** controller station. They were saved as **two**. He
only discovered it when a new header started printing the station count, and
it took a full investigation to explain why.

**The builder told him they would share a station.** The Split-zone tool's
own tooltip reads:

> *"Heads on each side get their own valve, wired as one station."*

The code stores `shareStation: false` — **two stations** — and the button
beside it says the opposite:

> *"each side gets its own valve and its own controller station."*

Two pieces of help text, on the same screen, giving opposite answers, one of
them wrong since the behaviour changed. **This is exactly the failure a help
centre has to prevent, and it is why the help text cannot live in two
places.**

## Who this is for

**Patrick, on a job site or at the kitchen table, six months from now, with
no memory of how any of this works.** Not a trained estimator, not a
developer, not a new hire. If it does not work for him under time pressure on
a phone, it does not work.

## What "done" looks like

Patrick is in the builder, sees a control he does not recognise, and
**knows what it does within ten seconds without leaving the page.**

Three ways in, because he will not always know which one he needs:

| Way in | When he uses it | Example |
|---|---|---|
| **By symbol** | He can see the button but not what it means | Clicks the ⟋ icon's help |
| **By name** | He half-remembers what it is called | Types "manifold" |
| **By plain words** | He knows the problem, not the term | Types "two valves one station" |

**The plain-words route is the one that matters most.** Patrick dictates by
voice and says *"zine"* for zone and *"vowels"* for valves. Search that only
matches exact jargon will fail him on the day he needs it.

## What goes in it

**Tools** — the seven drawing tools, each with its symbol, its name, what it
does, and what it does *not* do.

**Actions** — the links that appear when something is selected: wire both
valves to one station, one valve per box, remove split, print all zone
sheets, add trees, draw laterals by hand.

**Concepts** — the ideas that have no button at all, which is what actually
caught Patrick out:

- **Station vs valve vs area.** Three different counts. The header prints all
  three now and they are rarely the same number.
- **What splitting does**, and that a new split defaults to **two stations**.
- **Shared stations** — two valves on one terminal, opening together.
- **Legacy-assumed** — older designs that default the other way, and why.
- **Manifold / point of connection / lateral / mainline.**
- **Why the mainline size is held once purchased.**

**Readouts** — what each number in the header means and where it comes from.

## What this is NOT

- **Not a tutorial.** No "getting started" walkthrough, no videos.
- **Not a manual.** Nobody reads a manual. Entries are short enough to read
  standing up.
- **Not a support ticket system.**
- **Not a rewrite of the builder.** The help centre explains what exists; it
  does not change how anything works.

## The one test that matters

> **Could Patrick have answered the "why does it say 13 stations" question
> himself, in under a minute, without asking anyone?**

If the finished help centre does not pass that, it is not done. That question
is the acceptance test, written down before anything is built.

## Requirements

**R1.** Reachable from the builder without losing unsaved work.
**R2.** Searchable by symbol, name, and plain language including Patrick's own
words and common voice-dictation mistakes.
**R3.** Every tool and action on screen has an entry. **No exceptions**, and
this is enforced by a test, not by good intentions — a new tool that ships
without help should fail the build.
**R4.** The help text a tooltip shows and the help text the centre shows are
**the same text from the same place.** They can never disagree, because there
is only one of them.
**R5.** Works on a phone, one-handed.
**R6.** Works with no internet. The builder is one file; the help ships with
it.
**R7.** Every entry says what the thing does *and* what it does not do, and
names the thing it is most often confused with.

## Explicitly out of scope for version one

- Help for anything outside the System Builder (CRM, invoicing, work orders).
- Editing help text from inside the app.
- Multiple users or permissions.
- Translations.

## Open questions for Patrick

1. **Does this cover the whole admin site eventually, or just the System
   Builder?** Version one is the builder only; the structure should not
   prevent growing.
2. **Should the help centre be printable**, so a sub or a helper can carry a
   page?
3. **Should a new split default to one station or two?** The current default
   is two. Today suggests that surprised you. Changing the default is a
   separate decision from documenting it, and it is yours.

# The System Builder inside the Project Workspace — Product Requirements

**Status:** DRAFT, awaiting Patrick's decisions. Nothing built.
**Opened:** 2026-09-24
**Owner:** Patrick

---

## Where this stands today

The Project Workspace (`/app/projects/:id`) already has the tab:

```
Overview | System Design | Proposal | Tasks | Materials | Daily Records | …
```

**System Design is a placeholder.** It currently reads:

> *"The System Builder moves into this workspace next — the zone layout,
> heads and hydraulics, without leaving the job."*

The builder itself lives at `/admin/sitebuilder?project=<id>`, reached from
the old sidebar as a standalone tool. **It does not know it belongs to a
job**; the job is a query parameter it reads on load.

So today, designing a system means leaving the job, doing the work in a
separate tool, and coming back.

## The fact that decides the plan

| | |
|---|---|
| System Builder page | **7,391 lines** · 323 functions · 366 CSS rules |
| Its calculation engine | 1,387 lines |
| Its help registry | 469 lines |
| **The entire new app** | **1,448 lines** |
| Tests guarding the builder | **9 files** |

**The builder is roughly five times the size of the whole rebuilt app**, and
nine test files stand behind its behaviour — including everything corrected
on 2026-09-23: split stations, the valve count, three descriptions that
contradicted the code, and dialogs that rendered behind the plan.

Rewriting it in React would mean rewriting five times the new app and
**re-earning every one of those guarantees from scratch**. Every bug fixed
this week would be available to happen again.

**So the question is not "how do we rebuild the builder into the
workspace". It is "how does the builder come to live inside the workspace
without being rebuilt".**

## What Patrick actually wants from this

Stated on 2026-09-23: *"the next major work is integrating the System
Builder into the full-width Project Workspace."*

Reading that against how the tool is used:

- **Design without leaving the job.** The job's name, its quote, its
  material list and its design are one thing; today the design is somewhere
  else.
- **Full width.** The workspace caps content at 1180px with a 248px
  sidebar. **A drawing tool needs the screen.** A site plan at 45% zoom in a
  900px column is not a working surface.
- **One back button.** Leaving the builder should land back in the job, not
  in whatever page preceded it.

## Three ways to do it

### A. Embed the existing builder in the tab

The design tab hosts the builder as it stands, in an iframe, sized to the
full viewport with the workspace chrome above it.

**For:** the builder keeps every behaviour and every test. Its own styles
and globals stay isolated — its full-screen plan overlay and its dialogs
are scoped to the frame and cannot collide with the app's layers, which is
the exact class of bug that cost an evening this week. Shippable in days.

**Against:** an iframe is a box. Scroll position, sizing and the unsaved
warning need deliberate handling, and the two sides talk through
`postMessage` rather than sharing state.

### B. Hand off and come back

The tab is a launch pad: it shows the design summary and a button that
opens the builder full-screen, which returns to the job on exit.

**For:** simplest of all. No embedding, no message passing. The builder
gets the entire screen, which is what drawing wants.

**Against:** it is close to what happens today. It buys the back button and
little else — it does not make the design feel part of the job.

### C. Port the builder to React

**Against:** 7,391 lines, 323 functions, an evening of correctness work and
nine test files. **Not recommended, and not a close call.** If it is ever
right it is right *after* the workspace is proven, not as the way to get
there.

## Recommendation

**A, with B's full-screen behaviour available inside it.**

Embed the builder in the tab so the design lives in the job, and let it
take the whole viewport — sidebar out of the way — while drawing. That
gets both things Patrick asked for without putting a single one of this
week's fixes at risk.

## What "done" looks like

Patrick opens a job, clicks **System Design**, and is drawing — with the
job's name still on screen, the full width of the monitor under the plan,
and a back that returns to the job.

## Requirements

**R1. The builder's behaviour does not change.** Same page, same engine,
same tests, green throughout. If integrating it requires editing the
builder's own logic, that is a signal the approach is wrong.

**R2. Full width while drawing.** The 1180px cap and the 248px sidebar do
not apply to the design surface.

**R3. Unsaved work cannot be lost.** The builder already warns on
`beforeunload` when `dirty`. Navigating between workspace tabs is **not** an
unload — it is a React route change, and the warning will not fire. This
needs handling explicitly or the integration introduces a way to lose a
design that does not exist today.

**R4. The job is unambiguous.** The builder takes `?project=<id>`. Inside
the workspace the id comes from the route, and the two must never disagree.

**R5. One back.** Leaving lands in the job.

**R6. The counts stay honest.** The Overview's stations / valves / areas
come from `system-design-counts.js`, the same engine the builder runs. That
must still hold after a save inside the tab.

**R7. Nothing else in the workspace regresses.** The other eight tabs, the
shell, the mobile nav.

## Out of scope for this piece

- Rewriting any part of the builder (see C).
- The other placeholder tabs.
- Retiring `/admin/sitebuilder` as a standalone page — it stays reachable
  until the embedded route has been used on a real job.

## Decisions for Patrick

1. **Embedded, or launch-and-return?** Recommendation above is embedded. If
   what you actually want is "the builder, full screen, but it knows which
   job it came from", that is B and it is a much smaller piece.

2. **While drawing, should the sidebar hide?** Recommendation: yes,
   automatically, with a way back. It is 248px of a drawing surface.

3. **What must stay visible while drawing?** Job name and saved-state at a
   minimum. Anything else — customer, quote status, next action — is your
   call, and every one of them costs vertical space.

4. **Does this tab work on a phone?** The builder is usable on a phone but
   drawing on one is not what it is for. Options: full mobile support,
   read-only summary with "open on a computer", or leave it as it behaves
   today. This decides a meaningful amount of the work.

5. **Does `/admin/sitebuilder` stay in the old sidebar?** Recommendation:
   yes, until you have designed a real job through the new route.

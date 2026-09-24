# The System Builder inside the Project Workspace — Product Requirements

**Status:** DECIDED and BUILT. Patrick chose hand-off (option B) on 2026-09-24.
**Opened:** 2026-09-24
**Owner:** Patrick

---

## Where this stood

The Project Workspace (`/app/projects/:id`) already had the tab:

```
Overview | System Design | Proposal | Tasks | Materials | Daily Records | …
```

**System Design was a placeholder.** It read:

> *"The System Builder moves into this workspace next — the zone layout,
> heads and hydraulics, without leaving the job."*

The builder itself lived at `/admin/sitebuilder?project=<id>`, reached from
the old sidebar as a standalone tool. **It did not know it belonged to a
job**; the job was a query parameter it read on load.

## The fact that decided the plan

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
**re-earning every one of those guarantees from scratch**. That was never
the question. The question was how the builder comes to belong to a job
without being rebuilt.

## The decision

**Hand off and come back**, as a full-screen route that belongs to the job.

Patrick, 2026-09-24:

> *"Use Option B: a full-screen project route with return to the same
> project. The System Design tab should show the saved design summary and
> an Open System Builder action. Hide the workspace sidebar while building.
> Keep a compact project name, truthful save status and Back to Project
> control visible."*

**The earlier recommendation — embedding the page in an iframe inside the
tab — is withdrawn.**

**Not on isolation grounds.** An iframe is its own document and its own
stacking context; the builder's overlays and dialogs could not have
collided with the app's chrome, and this PRD said so correctly in option
A's favour. Two other things decide it:

1. **An iframe is a box.** The builder's full-screen overlays — master
   plan, sketch, help centre — fill the *frame*, not the viewport. "Full
   width" would have meant the frame's width, under whatever workspace
   chrome sat above it. Hand-off gives the real viewport.

2. **The unsaved-work guard gets harder, not easier** — R3, below.
   Inside the workspace, moving from System Design to another tab is a
   React route change and **not an unload**, so `beforeunload` never
   fires. An embed would have needed a brand-new guard for tab
   switching, coordinated across the frame boundary by `postMessage`,
   and would have introduced a way to lose a design that does not exist
   today. Leaving a separate page **is** an unload, so browser Back,
   refresh and closing the tab keep the guard the builder already has,
   and only one new exit had to be built.

Hand-off gives up nothing that was actually asked for: the job is in the
URL, the bar says which job it is, and Back returns to the tab it came
from.

Porting to React stays where it was: **not recommended, and not a close
call.**

## What it looks like

```
/app/projects/<id>/design          the System Design tab (React)
       summary · saved plan · [Open System Builder] · classic link

/app/projects/<id>/design/build    the System Builder, full screen
       [← Back to Project]  System Builder  <job · customer>   Saved 10:42
```

Two URLs, one job. The second is served by the server as `sitebuilder.html`,
matched **before** the `/app` SPA fallback — the builder is its own
document, not a React route.

### The five decisions, as answered

1. **Embedded, or launch-and-return?** → **Launch and return.** A
   full-screen route under the job, `/app/projects/:id/design/build`.

2. **Should the sidebar hide while drawing?** → **Yes.** The builder is not
   the React app, so the 248px rail and the 1180px content cap are not
   there at all while building. The whole viewport is drawing surface.

3. **What stays visible while drawing?** → **Three things and no more:** a
   compact job name (with the customer), the save status, and Back to
   Project. One sticky bar, so the save status is still answerable at the
   bottom of a long page.

4. **Does this tab work on a phone?** → **Reading does; drawing does not,
   this phase.** The summary and the saved plan, station by station, read
   on a phone. The builder tells a phone that drawing needs a bigger screen
   and points back at the tab.

5. **Does `/admin/sitebuilder` stay?** → **Yes, temporarily.** The classic
   address still works and the tab still links to it, until a real job has
   been designed through the new route.

## What "done" looks like

Patrick opens a job, clicks **System Design**, and reads what is saved —
stations, valves, areas, and the plan station by station. **Open System
Builder** takes the whole screen with the job attached. Back to Project
returns to that tab, showing what he just saved.

## Requirements

**R1. The builder's behaviour does not change.** Same page, same engine,
same tests, green throughout. *Met:* `test:sitebuilder` (110),
`test:station-vs-valve` (48), `test:help-centre` (68) and
`test:dialog-above-overlays` (15) all unchanged.

**R2. Full width while drawing.** No 1180px cap, no 248px rail.
*Met by construction* — the builder is a separate document and the app's
shell is not on the page. Asserted rather than assumed: the test checks
that no `nav[aria-label="Main"]` exists while building.

**R3. Unsaved work cannot be lost — FOUR exits, not one.** This was the
requirement that would otherwise have bitten, and hand-off changes its
shape: because the builder is its own document, **browser Back, refresh and
closing the tab are all real unloads**, so the existing `beforeunload`
guard covers them. Only **Back to Project** is new, and it asks first with
a proper dialog. A departure already confirmed is not then queried a second
time by the browser.

**R4. The job is unambiguous.** On the workspace route the job comes from
the **path**; `?project=` is not used and the URL carries none. The classic
route still reads the query. Path wins if both ever appear.

**R5. One back.** Back to Project returns to `/app/projects/<id>/design` —
the tab it was opened from, not the workspace's first tab and not the CRM.

**R6. The counts stay honest, and refresh after a save.** Stations, valves
and areas come from `system-design-counts.js`, the same engine the builder
runs. Returning from the builder is a fresh page load, so the tab cannot
show a stale number. The test proves the moving number: a ceiling change
takes the same three areas from five stations to seven, and seven is what
the tab reads on return.

**R7. Reading works on a phone.** Summary and saved plan, no horizontal
overflow at 390px, and Back to Project reachable at that width.

**R8. Nothing else in the workspace regresses.** The other eight tabs, the
shell, the mobile nav, and `/admin/sitebuilder` unchanged.

## What was built

| | |
|---|---|
| `server/server.js` | `/app/projects/:id/design/build` → `sitebuilder.html`, ahead of the `/app` catch-all. Auth unchanged (`/app/*` is already staff-only). |
| `server/sitebuilder.html` | Workspace mode: job read from the path, compact sticky bar, `designSaveStatus()` as the **one** save-status rule both readouts call, `backToProject()` with its confirm, phone notice. |
| `server/lib/system-design-counts.js` | `describeSystemDesign()` — the saved plan station by station, from the **same engine pass** that produces the counts. |
| `admin-app/src/routes/SystemDesign.tsx` | The tab: summary, saved plan, Open System Builder, classic link. |
| `scripts/test-workspace-builder-route.mjs` | 71 assertions, real server, real project, real bundle, real browser. |

**One defect found and fixed while testing:** opening a design saved by
anything other than this page's own Save button (a migration, an import, a
server-side fix) showed *"No design saved yet"* in the builder while the
project summary dated the same design on the same screen. The builder read
only the blob's `savedAt`; it now falls back to the project's own
`system_design_saved` history entry. Two readouts, one design, one answer.

## Out of scope for this piece

- Rewriting any part of the builder.
- Drawing on a phone. Reading is supported; drawing is a desktop workflow
  this phase.
- The other placeholder tabs.
- Retiring `/admin/sitebuilder` — it stays until a real job has been
  designed through the new route.

## Patrick's acceptance test — not yet walked

Open a job you know at `/app/projects/<id>/design`. Check the stations,
valves and areas against what the builder says. Click **Open System
Builder** — it should fill the screen with no sidebar, and the bar should
name the job and say when it was last saved. Change something and try Back
to Project: it must ask. Say stay, and your change must still be there.
Save, then Back to Project: the tab must show the new numbers immediately.
Finally, open the same job on your phone and confirm the summary and the
station list read without sideways scrolling.

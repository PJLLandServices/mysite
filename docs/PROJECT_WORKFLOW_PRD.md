# The Project Workspace, day to day — Product Requirements

**Status:** DECIDED 2026-09-25. Building in order; Tasks first.
**Opened:** 2026-09-25
**Owner:** Patrick

---

## What Patrick asked for

> *"Next up should be the Project Overview screen and its day-to-day
> workflow: tasks, logs, time, parts, change orders, and billing status."*

Six things. Five of them are placeholder tabs in the workspace today
(Tasks, Materials, Daily Records, Change Orders, Financials); the sixth,
the Overview, is built but thin.

## The fact that decides the plan

**Every one of the six is already built on the server.** This is the
opposite of the System Builder, where the question was how to avoid
rebuilding 7,391 lines. Here there is nothing to preserve and nothing to
port — the endpoints exist, they work, and the classic CRM already drives
them. What is missing is the screen.

| Patrick's word | What the server already has |
|---|---|
| **tasks** | `GET/POST /api/projects/:id/tasks`, `PATCH/DELETE …/tasks/:taskId`, `…/tasks/seed` (from the quote), `…/task-photos`. Tasks carry `percentComplete`, `completedAt`, `completedByWoId`. |
| **logs** | `GET/POST /api/projects/:id/journal`, `…/journal/:entryId` (+ photo upload, delete, serve). Entries carry author, timestamp, note, photos. |
| **time** | `GET /api/projects/:id/metrics` — `totalPersonHours`, `daysLogged`, `lastWorkDate`, `photoCount`, `percentComplete`, `pendingScopeChanges`. |
| **parts** | `/api/material-lists` (+ the draft/purchased status rules already walked on 2026-09-23). |
| **change orders** | `GET/POST /api/projects/:id/scope-changes`, `…/:scrId/send`, `…/resolve`, `…/generate-revision`. Six statuses, a customer-approval step, and a quote revision at the end. |
| **billing status** | `GET /api/projects/:id/billing-preview` (T&M: labour hours × locked rate, plus materials consumed by SKU), plus the invoice summary the Overview already reads. |

**So this phase is screens over endpoints that already work.** No new
business rules, no maths moved into the browser. That is the CLAUDE.md
rule for this rebuild, and it is also where the risk now sits.

## The risk is different this time

The builder's risk was *losing* behaviour. This phase's risk is **quietly
re-deriving a number the server already owns** — and getting a different
answer. That is `zoneCount: areas.length` (2026-09-21), and it is
`done / total` below. Two screens, one job, two numbers, and no way to
tell from either which one is wrong.

**Rule for this phase, and it is not negotiable:** if the server computes
a figure, the screen shows the server's figure. Where a list cannot afford
one request per row, the rule is mirrored in one named function and pinned
by a test that runs **both implementations over the same records**.

## Found on the way in — and fixed

**The progress bar disagreed with the server on any job with
partly-finished tasks.**

`computeProjectMetrics()` averages each task's own `percentComplete`
(`status` follows the percentage — `addTaskProgress()` sets one from the
other, never the reverse). The rebuilt app drew its bar from
`done / total`, which reports a task logged at 60% as **zero**.

On a four-task job with every task three-quarters done:

| | |
|---|---|
| The server | **75% complete** |
| The Projects list and the Overview | **empty bar, "0/4"** |

Fixed in this branch: `projectPercentComplete()` in `format.ts` mirrors
the server's rule and draws both bars. The **count** label ("1 of 4
tasks") stays a count, because that is a different question — the server
keeps `doneTasks` beside `percentComplete` for exactly that reason.

Pinned by `scripts/test-task-progress-agrees.mjs` (44 assertions, added to
`build:check`): it lifts the real function out of `format.ts`, builds real
projects through `lib/projects.js`, drives each task with the real
`addTaskProgress()`, and asserts the two implementations agree on every
shape — including the one that would have drawn an empty bar.

## Where time comes from — worth stating before anything is designed

**Hours are not typed into the workspace.** They come from work-order
daily logs — `session.inAt` / `outAt` × `labourersOnSite` — captured in
the field, and `computeProjectMetrics()` sums them across the job's build
work orders. Open sessions count up to now in the metrics figure and are
**excluded** from the billing figure, which is correct and must not be
"tidied up" into agreement.

So the workspace's job for time is **read it and bill it**, never capture
it. Any design that puts an hours field on this screen is proposing a
second source of truth for money.

## Who does what — Patrick's split

Decided 2026-09-25, and it is the thing every screen in this phase has to
respect:

| | |
|---|---|
| **Field app** | Technicians clock in and out, update task progress, record the day's work, photos, parts used and issues. |
| **Project Workspace** | Patrick plans and assigns tasks, reviews daily records and labour, approves change orders, manages required materials, and prepares billing. |
| **Both** | **Task status.** It synchronises immediately, and there is **only one underlying task record.** |

> *"That avoids building two competing field interfaces while still
> letting you correct or complete something from the office."*

So: **desk-first for review and management; the field app owns on-site
capture; task updates work from both.** Nothing in the workspace becomes a
second way to log a day's work or a second place hours live.

### What that split ran into immediately

**Task progress can only be moved through a work order today.**
`POST /api/work-orders/:woId/tasks-done` writes the per-day log line and
*then* flips the project's master task — which is the right order, and the
project record is already the single source of truth Patrick asked for.
But there is **no project-level route**, so the office cannot correct or
complete a task without a visit attached.

The screen alone could not deliver "available from both places". Added:
`POST /api/projects/:id/tasks/:taskId/progress` — the same
`projects.addTaskProgress()` the field path calls, on the same record,
with `completedByWoId: null` so the history says honestly that this one
was not closed out on site.

## Build order

Patrick's, 2026-09-25 — Materials ahead of Change Orders, because a change
order is a change to scope and price that is *tied to tasks and
materials*, so those have to exist first:

1. **Tasks** — the backbone connecting estimates to completed work.
2. **Daily Records** — progress, notes, photos, labour and problems.
3. **Materials** — required, ordered, received and used.
4. **Change Orders** — scope and price changes tied to tasks/materials.
5. **Financials** — invoicing from verified work and approved changes.
6. **Overview last** — summarise the finished workflows with truthful
   numbers.

## Requirements

**R1. The server owns every figure.** Per the rule above. Any mirrored
rule gets a both-implementations test.

**R2. Nothing new in the browser that the API doesn't already return.**
If a screen needs a number the server doesn't have, the fix goes in the
server.

**R3. Hours are read, never entered.**

**R4. Money-touching actions confirm.** Sending a scope change to a
customer and generating a quote revision both reach a customer and a
price. Neither happens without a dialog.

**R5. The classic CRM keeps working** throughout, and each tab keeps its
classic link until the replacement has been walked on a real job.

**R6. Phone-first for the field-facing tabs** — see decision 2.

## The decisions, as answered

1. **Order** — Patrick's, above. Materials moved ahead of Change Orders.

2. **Phone or desk?** *"You will primarily review and manage these records
   at the desk, while technicians capture the day-to-day information on
   their phones through the field app. However, task updates should remain
   available from both places."* → **Desk-first**, with task updates
   reachable from either side. That is what the new progress route is for.

3. **Change Orders: read or raise?** Deferred to step 4, where it will be
   decided against a screen that exists rather than in the abstract. The
   lifecycle's last step raises a priced document, so the default stays
   read-first.

4. **Financials: does "raise the invoice" live here?** Deferred to step 5,
   same reason.

## The rule for every tab in this phase

> *"Display server-calculated totals instead of independently
> recalculating them in React. The progress-bar bug is exactly what
> happens when the browser invents a second calculation."*

Where a list genuinely cannot afford one request per row, the rule is
mirrored in **one named function** and pinned by a test that runs **both
implementations over the same records** — as
`projectPercentComplete()` and `test-task-progress-agrees.mjs` now do.
Anything else re-derived in the browser is a defect waiting for a
screenshot.

## Step 2 — Daily Records: the boundary, and what the backend already does

Patrick's six rules, 2026-09-26, with a survey of each against the code
**before** the build commits to them. Two do not currently hold.

| # | Rule | Where it stands |
|---|---|---|
| 1 | Field staff create work logs, photos, problems and clock events | **Logs, photos and clock events exist** on the build WO's `dailyLog`. **Problems are new** — settled below as a project-level record linked to the daily record it was found on. |
| 2 | Office can add notes and correct records through an audit trail | **Partly.** Notes: the project journal already does this. **Correcting a clock time is impossible today** — there is no route to change `inAt`/`outAt` at all. |
| 3 | Hours calculated from clock in/out, never a typed box | **Holds, and must keep holding.** `computeProjectMetrics()` derives person-hours from `session.inAt`/`outAt` × `labourersOnSite`. No hours field exists anywhere. Any box on this screen would be a second source of truth for money. |
| 4 | Original time entries preserved when corrected | **FAILS.** `setLabourersForSession()` overwrites `sess.labourersOnSite` in place and its history entry records only the NEW count. Labourer count multiplies straight into person-hours, so correcting 3 → 2 silently loses the original figure that billing was based on. |
| 5 | Task progress uses the same records as #307 | **Holds.** One task record, both doors, already proven. |
| 6 | Photos use the real upload/storage path from day one | **Available.** `savePhotosForWorkOrder()` writes real compressed files under `WO_PHOTOS_DIR/<woId>/` with meta records. Use it; do not invent a second path. |

**So step 2 carries backend work before any screen:** a correction path for
clock times that keeps the original, and the same treatment for the
labourer count. The shape #307 settled is the precedent — corrections
append, they never overwrite, and the audit trail grows rather than
rewinding.

### Problems — settled 2026-09-26

**A problem belongs to the PROJECT, and links to the daily record where it
was discovered.** Patrick:

> *"Daily Records shows: 'This problem was discovered Tuesday during this
> work session.' Project Overview shows: 'This problem remains open and
> still needs resolution.' Resolving it later doesn't rewrite Tuesday's
> record."*

That settles the day-vs-job tension by separating the two things that were
being conflated: the **problem** is a live thing that stays open until
somebody deals with it, and its **discovery** is a fact about Tuesday that
never changes. One record, two contexts, and neither has to lie.

**The record:**

| Field | |
|---|---|
| `title`, `description` | what it is |
| `discoveredAt`, `discoveredOnWoId` | the date and the daily record it was found on |
| `reportedBy` | who found it — the authenticated user, per #307 |
| `status` | `open` · `monitoring` · `resolved` |
| `resolutionNote`, `resolvedAt`, `resolvedBy` | how it ended, when, and who |
| `taskId?`, `photoId?`, `scopeChangeId?` | optional links |

**Resolving appends; it never edits the discovery.** `resolvedAt` and
`resolutionNote` are new fields on the problem — Tuesday's daily record is
not touched, exactly as archiving a task never touched the crew's log
lines in #307.

**`status` is a lifecycle state, so it gets the CLAUDE.md treatment from
day one**: one named function for "still needs attention", called by every
reader — the Overview's count, the Daily Records tab, any closeout
preflight — rather than three copies of `status !== "resolved"`. A
`monitoring` problem is not resolved and must not be counted as such. This
is the `activeTasks()` / cancelled-booking lesson, applied before the bug
rather than after it.

### Clock and labour corrections — settled 2026-09-26

The same rule as #307, stated as Patrick set it:

1. **Preserve the original value.**
2. **Record the corrected value, who changed it, when, and why.**
3. **Calculate billing from the effective corrected value.**
4. **Never represent an office correction as a new field work session.**

Rule 4 is already how the office task route behaves — it writes no session
and credits no visit — so this extends a precedent rather than setting one.

**What rule 3 demands in practice:** `computeProjectMetrics()` and
`computeTAndMBilling()` both derive hours from sessions, so "the effective
corrected value" must be produced by **one named function** that both call.
Two readers deriving effective hours separately is the progress-bar bug
with money attached.

**Shape to build:** a session carries its original `inAt`/`outAt`/
`labourersOnSite` untouched, plus an append-only list of corrections, each
with the new value, actor, timestamp and reason. The effective value is
the latest correction or the original. `setLabourersForSession()` is
rewritten to append rather than overwrite, which is the defect this fixes.

**Forward dependency, noted not decided:** hours already invoiced. A
correction changes the effective figure but does not reach an invoice
already raised. Whether the workspace should say so belongs with
Financials (step 5), alongside the purchased-material-list protection from
2026-09-23.

## Out of scope for this phase

- Closeout (it has its own preflight and cascade, and it is the end of
  the job, not the day-to-day).
- Anything in the field app.
- Retiring classic project screens — nothing is deleted until its
  replacement has been walked on a real job.

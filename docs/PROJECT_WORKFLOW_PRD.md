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

## Out of scope for this phase

- Closeout (it has its own preflight and cascade, and it is the end of
  the job, not the day-to-day).
- Anything in the field app.
- Retiring classic project screens — nothing is deleted until its
  replacement has been walked on a real job.

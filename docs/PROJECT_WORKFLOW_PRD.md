# The Project Workspace, day to day — Product Requirements

**Status:** DRAFT. Four decisions for Patrick at the end. One bug found
while surveying is already fixed — see *Found on the way in*.
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

## Recommended order

Built in this order, each one useful on its own:

1. **Tasks** — the daily driver, and the tab behind the figure that was
   just corrected. Read, tick, part-complete, seed from the quote.
2. **Daily Records** — the job journal with photos. Pairs with tasks:
   what happened today, and what it moved.
3. **Financials** — billing status, the T&M preview, the deposit/balance
   picture the Overview already half-shows.
4. **Change Orders** — the most delicate, because its last step raises a
   quote revision. Read-only first (see decision 3).
5. **Materials** — the material list already has a walked flow and the
   builder writes it; this is mostly a view.

Then the Overview gets rebuilt **last**, once the tabs exist to link
into — it should summarise screens that are there, not describe screens
that are not.

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

## Decisions for Patrick

1. **Is the order above right?** Tasks → Daily Records → Financials →
   Change Orders → Materials, Overview last. If something is hurting more
   right now (it is fall closing season), say so and it goes first.

2. **Who uses Tasks and Daily Records on a phone?** The field app already
   captures daily logs and time on work orders. If the workspace's tabs
   are for you in the office, they can be desktop-first and simpler. If
   you tick tasks off on site, they need to be phone-first, which is a
   meaningful amount of the work. **Recommendation: desktop-first for the
   office, because the field app already owns on-site capture** — but you
   are the one who would know.

3. **Change Orders: read, or raise?** The full lifecycle exists —
   create → send to customer → approve → generate a quote revision. That
   last step writes a new priced document. **Recommendation: read-only
   first**, with raising kept in the classic CRM until the rest of the
   workspace has been used on a real job.

4. **Financials: does "raise the invoice" live here?** The T&M preview is
   safe to show anywhere. Actually generating an invoice is money leaving
   the building. **Recommendation: show the picture here, keep the button
   in classic for now.**

## Out of scope for this phase

- Closeout (it has its own preflight and cascade, and it is the end of
  the job, not the day-to-day).
- Anything in the field app.
- Retiring classic project screens — nothing is deleted until its
  replacement has been walked on a real job.

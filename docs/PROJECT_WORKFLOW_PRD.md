# The Project Workspace, day to day — Product Requirements

**Status:** All six steps BUILT and LIVE (last one, Materials Required/Ordered, deployed
2026-10-05 as `9d36363`). Waiting on the real-job walk (R5) before any classic page is
retired — see *Where the plan stands* at the end.
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
   read-first. **Built read-only (2026-09-27), after the billing fix (#337)
   and the change-order safety fix (#338) — Patrick's order.** Actions stay
   on the classic project page's office-only routes until this screen has
   been walked on a real job (R5).

4. **Financials: does "raise the invoice" live here?** Deferred to step 5,
   same reason. **Built read-only (2026-09-28), after Fix A (#350: a deposit
   counts when its invoice is paid, however it was paid) and Fix B (#351:
   one rule for a job's invoices, a void invoice never owed, one parts
   catalog) — Patrick's order.** Recording payments, sending, revising and
   voiding stay on the classic invoice pages until this screen has been
   walked on a real job (R5).

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
| 2 | Office can add notes and correct records through an audit trail | **Now holds (HOURS-01, 2026-09-26).** Notes: the project journal already did this. Clock times: `PATCH /api/work-orders/:id/sessions/:sid/times` is new — admin-only, reason required, originals preserved, and it refuses inverted, future, over-24h and already-invoiced corrections. |
| 3 | Hours calculated from clock in/out, never a typed box | **Holds, and must keep holding.** `computeProjectMetrics()` derives person-hours from `session.inAt`/`outAt` × `labourersOnSite`. No hours field exists anywhere. Any box on this screen would be a second source of truth for money. |
| 4 | Original time entries preserved when corrected | **Was FAILING; fixed 2026-09-26 (HOURS-01).** `setLabourersForSession()` overwrote `sess.labourersOnSite` in place and recorded only the NEW count, so correcting 3 → 2 silently lost the figure billing had been based on. It now stamps `session.original` once and appends to `session.corrections[]`. |
| 5 | Task progress uses the same records as #307 | **Holds.** One task record, both doors, already proven. |
| 6 | Photos use the real upload/storage path from day one | **Available.** `savePhotosForWorkOrder()` writes real compressed files under `WO_PHOTOS_DIR/<woId>/` with meta records. Use it; do not invent a second path. |

**So step 2 carried backend work before any screen** — done as HOURS-01 on
2026-09-26: a correction path for clock times that keeps the original, the
same treatment for the labourer count, and one shared effective-hours
calculation behind both. What remains for step 2 is the **tab itself**:
notes, photos and project problems linked to their discovery day. The shape #307 settled is the precedent — corrections
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

**Shape BUILT — 2026-09-26, and it is the reverse of what this section
first proposed.** The plan above was for the session's own
`inAt`/`outAt`/`labourersOnSite` to stay frozen as the original, with
every reader routed through a function to get the effective value. That
was rejected during the build, for one reason: **it fails silently.** Any
reader you miss quietly bills the *uncorrected* number and nothing looks
wrong. What shipped instead:

| | |
|---|---|
| `session.inAt` / `outAt` / `labourersOnSite` | always the **effective** value |
| `session.original = { inAt, outAt, labourersOnSite }` | stamped **once**, on the first correction |
| `session.corrections[]` | append-only `{ at, by, reason, field, from, to }` |

A missed reader now shows the **correct** figure and loses only the audit
detail. When one shape fails loudly and the other fails silently, and the
subject is hours you invoice, take the one that fails loudly.

`original` is stamped **once**, not per correction, because "the original
value" means what the crew recorded — not what the previous correction
happened to leave behind. Correcting a count twice still shows the
technician's own number.

`setLabourersForSession()` was rewritten to record a correction rather
than overwrite, which is the defect this fixes, and
`correctSessionTimes()` + `PATCH /api/work-orders/:id/sessions/:sid/times`
are new. Re-sending an unchanged value writes **no** correction entry — an
audit log full of `3 → 3` is how a real correction gets lost.

**Rule 3 delivered:** `server/lib/session-hours.js` is the one loop.
`computeProjectMetrics()` and `computeTAndMBilling()` both call
`sumPersonHours()`, and the classic project page — a **third** copy nobody
had counted — no longer calculates at all, reading a server-computed
`personHours` instead. The only remaining difference between metrics and
billing is one argument: `openSessions: "toNow"` versus `"skip"`.

**Who may correct:** the times route is `"admin"` in `needsAuth()` — the
third admin-only work-order route, alongside unlock/relock and the fee
waiver, all three being decisions that change what the customer is
charged. Setting the crew **count** stays `"user"`: that is a live field
action, and Patrick's split puts clocking in and out in the field while
"review daily records and labour" is desk work.

Pinned by `scripts/test-session-hours-protected.mjs` (44 assertions, 29 of
which fail on the pre-change code) and
`scripts/test-corrected-hours-on-screen.mjs` (10, Playwright — it reads
the rendered number, because the first cut served 9.00 correctly and
displayed 0.00). Full write-up: FLOW_REGISTER, HOURS-01.

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

## Step 4 — Change Orders (read-only), 2026-09-27

Built third of three, after the money path was made safe: #337 (a signed
revision is billed; the original governs until then) and #338 (office-only
actions, real names, honest sends, one "open" rule).

**`GET /api/projects/:id/change-orders`** (`server/lib/change-orders-view.js`)
returns everything the tab shows, from rules that already exist:

| On screen | Comes from |
|---|---|
| Open / waiting / signed counts | `projects.scopeChangeStage` — the one rule the Overview count, completion check and status email use |
| Each change's stage and "what happens next" | its own status, and for one already in a revised quote, that quote's fate in the chain |
| The agreement (original, current signed, waiting for signature, net change) | `quotes.describeChain` via `projects.resolveProjectQuote` — what the invoice bills |
| Holding completion | `projects.completionPreflight`'s own blockers, word for word |

The tab has **no buttons** and does **no arithmetic** on money;
`scripts/test-change-orders-view.mjs` runs the view and the server's own
rules over the same records and checks the tab's source for both.

**Found on the way:** the workspace header's **Contract value** read the
quote panel's "current" version — which, while a revision is still a draft,
is the unsigned draft. It now reads the signed agreement
(`linkedQuote.agreement`), the amount the invoice bills.

**Not in this step:** linking a change to specific tasks or materials. The
change request carries line items and photos but no task or SKU link; adding
one is a data change, deliberately left for when actions move here.

## Step 5 — Financials (read-only), 2026-09-28

Built after the money path was made safe:
- **#350 (Fix A):** the deposit follows its invoice's paid state from every writer, and reversals
  un-count it.
- **#351 (Fix B):** one rule for a job's invoices, a void invoice is never owed, and the preview
  and final invoice share one parts catalog.

`GET /api/projects/:id/financials` (`lib/financials-view.js`) returns every figure and sentence
the tab shows:
- **the signed contract**, with HST: `describeAgreement`, as the header, list and Dashboard show
  it; for T&M it is labelled an estimate;
- **invoiced:** sent live invoices;
- **received:** every live invoice's ledger;
- **owed now:** what sent live invoices still owe. A held balance invoice is not owed, a void one
  is nothing, and one marked Paid with its payments short is in **payment reconciliation**
  (#350's rule): Received $1,000 · Unresolved $260 · Status: Payment reconciliation required ·
  Customer amount owed: not determined — a red card first on the tab, a red flag on the invoice,
  "⚠ Payment reconciliation required · $260.00 unresolved" in the header, never "None owed";
- **not yet invoiced:** fixed price only;
- **the deposit and its stage;**
- **every invoice and payment;**
- **open payment exceptions;**
- **the billing preview:** the same `billingPreviewFor` the preview route uses;
- **the completion check's money blockers.**

All of it is added up on the server, in cents.

**The header now agrees with the tab.** The workspace header's Billing card and next action read
the same model (`billingSummary`), not one invoice classified in the browser. Before, a job with a
paid deposit and a held balance invoice read **"$3,390.00 outstanding"** in the header, and
"Collect payment … invoice not sent yet" for an invoice nobody could send. It now reads
**"None owed · $1,000.00 received · $3,390.00 not invoiced yet"**, as the tab does.
`invoiceSummary` stays on the response for the classic page.

**Not in this step:** hours already invoiced when a correction lands (the forward dependency
noted under Step 2), and the final-invoice review, which belongs to Closeout (out of scope for this phase).


## Step 6 — Overview (read-only command centre), 2026-10-02

The Overview summarises the five finished tabs and decides nothing itself.
`GET /api/projects/:id/overview` (`lib/project-overview.js`) copies each figure out of the read
model its tab's own route returns — the tab routes and the Overview call the same builder
functions — so the two cannot disagree. The screen does no arithmetic and sends nothing.

- **Status:** stage; progress (`computeProjectMetrics`); the one next action — now a server rule
  (`lib/next-action.js`) that respects the completion check, so a finished job with an unsigned
  revision reads "Clear what's holding completion", never "Complete and invoice"; and every
  completion blocker, each linking to the tab that explains it.
- **Tasks:** open / completed / archived and progress (the Tasks tab's metrics). No "overdue":
  tasks carry no due date or blocked state, and the card says so.
- **Daily Records:** latest *clocked* workday and its hours and crew note, effective person-hours
  (corrections applied), days logged, problems needing attention (open + monitoring, the one
  rule), the latest journal update.
- **Materials:** lists, required, ordered, received, used, project balance and the tab's own
  warnings — the Materials tab's own figures, copied. *(Corrected 2026-10-06. When this step
  shipped on 2026-10-02 the card had no "required" or "ordered" figure because the tab had
  neither; #364, deployed 2026-10-05, added both to the tab's read model and the card copies
  them. See "Step 3, completed".)*
- **Change Orders:** open, with the customer, signed; the signed agreement and any unsigned
  revision (`describeAgreement`); the tab's holds.
- **Financials:** signed contract with HST, invoiced, recorded payments, outstanding (or **Not
  determined** while a payment is being reconciled), not yet invoiced, deposit; the
  reconciliation warning first on the page.

Found and fixed on the way: the Tasks and Daily Records tabs disagreed on "Days logged" (one
counted clocked visits, the other every visit — now one rule, `session-hours.loggedDays`), and
`computeProjectMetrics` wrote `totalPersonHours` as an undeclared global.

**Not in this step:** the Projects list and Dashboard still mirror the task-progress rule in the
browser (`format.ts`); moving them to the server is a separate change.

**Money is office-only (2026-10-02; description corrected 2026-10-06).** The rule is one
function, `canSeeMoney` in `lib/money-visibility.js`: an office account (role `admin`) sees money;
a technician (role `tech`) does not, *where the rule is applied*. The server removes the figures
before they leave; the screens never decide. Where it is applied — checked 2026-10-06 by signing
in as a technician on a test server:

- **Refused outright (403 `office_only`):** the Financials tab (`…/financials`) and the billing
  preview (`…/billing-preview`). The technician's tab bar does not offer Financials.
- **Amounts removed, everything else kept:** the Projects list and Dashboard (contract values,
  totals); the project header ("Office only" instead of the contract value; no invoice summary,
  billing figures, quote prices or locked labour rate); the Overview (the Financials card says
  only whether the office has billing to deal with; money next-actions and money blockers become
  that notice; a materials price warning loses its sentence); Change Orders (agreement amounts,
  estimates, line prices); the raw change-request list and the completion check's sentences.
  Tasks, days, hours, problems and change-order counts are identical for both.

**Not covered — a technician can still see these amounts** (the 2026-10-02 note said "every
`/api/projects/*` read"; that was wrong for the Materials tab, and the classic-page exclusions
were only partly listed):

| Where | What a technician sees | Why it is not covered |
|---|---|---|
| **Materials tab** (new workspace) | each material list's dollar total ("$… this list") | material-list costs were excluded on 2026-10-02; the tab's route was not redacted |
| Classic invoice pages + `/api/invoices` | invoice lines, totals, payments | deliberate: the field app reads an invoice's amount to take payment on site |
| Classic Quote Folder (`/admin/quote-folder`) | proposal subtotal, HST, total | excluded 2026-10-02 (quotes), awaiting Patrick's decision |
| Classic purchase-order pages + `/api/purchase-orders` | supplier unit prices | not listed on 2026-10-02; found 2026-10-06 |
| Classic material-list page + `/api/material-lists` | list cost subtotals | excluded 2026-10-02 (material-list costs) |
| Free-text fields (descriptions, notes) | any amount the office typed | deliberate: masking an editable field would let an autosave overwrite it |
| "Open in classic" / "Open in classic CRM" | the classic project page and its links | the classic pages are outside the workspace rule |

Closing any of these is a decision for Patrick, not part of this phase — nothing was changed on
2026-10-06.

## Step 3, completed — Materials Required and Ordered (#364), 2026-10-05

The Materials tab and the Overview now show the two figures step 3 promised:

- **Required:** one active material list → that list's units; two or more → **"Per list — N
  lists"** and no project total (a later list may repeat an earlier one's parts; nothing in the
  records says whether it replaces or adds). An archived list is not active. Each part still
  shows its own required figure, or each list's figure side by side — never added together.
- **Ordered:** units actually ordered on this job's purchase orders. Sent, partly received and
  received orders count; a cancelled order counts only what arrived; drafts count nothing; each
  order line counts once. One server calculation (`purchase-orders.lineCommitment`) feeds
  Ordered, Received and still-to-order, so they cannot disagree.

**Release record.**

| | |
|---|---|
| Approved head | `060e8f1b08e1ddeffb93aa436165550378ae56e3` (PR #364) |
| Merge commit (deployed version) | `9d36363f93cbd1b4dd87cd5779498b99417007ae`, merged 2026-10-05 11:18 UTC |
| CI on the PR head | build-check passed — https://github.com/PJLLandServices/mysite/actions/runs/37299566107/job/111728803036 |
| CI on main after merge | build-check passed — https://github.com/PJLLandServices/mysite/actions/runs/37302090573/job/111736959104 |
| Production | Render auto-deploy; new build `index-g2zF6qBd.js` served from 11:28:27 UTC, old build gone; health, home, login, booking services, new-customer and sitemap all OK |
| Downtime | about 56 seconds of 502 (11:27:34–11:28:27 UTC) during Render's restart; monitored every 3 s from merge until 2 minutes after the new build appeared |
| Live records | none created or changed; PO-2026-0007 untouched |

Tests on `060e8f1`: Required/Ordered 61/61 (fails at once on the old code); Overview with
desktop and phone screens 420/420; app shell 48/48 (the two obsolete assertions now check the
built Financials tab and the office/technician rules: no Financials tab, no amounts and "Office
only" for a technician, 403 from the API for a technician and 200 for the office);
project-materials 38/38; materials tab 26/26; line protection 69/69; purchasing matrix 563/563;
PO/list consistency 111/111; admin gates 14/14. All 8 E2E journeys passed on the previous head
`12e3656` (the later commits changed only the app-shell test and brought in main). Screenshots,
desktop and phone, were shown to Patrick before he approved the merge.

## Where the plan stands (2026-10-06)

All six tabs are built and live: Tasks, Daily Records, Materials, Change Orders (read-only),
Financials (read-only, office-only), Overview. What is left, each kept separate:

1. **The real-job walk (R5)** — below. Not yet done. No classic page is retired until it is.
2. **Actions still on the classic pages** — change-order send / approve / withdraw / revise,
   and invoice send / record payment / void. Decision 3 and 4 stand: these move only after the
   walk.
3. **Projects list and Dashboard progress — separate follow-up.** Both still compute a job's
   task progress in the browser (`projectPercentComplete()` in `admin-app/src/lib/format.ts`),
   mirroring the server rule; `test-task-progress-agrees.mjs` keeps the two equal. Moving them
   to the server is its own change, not started.
4. **Office-only money gaps** — the table above. A decision for Patrick.
5. **"Log an update" on the Overview does nothing yet** — the button has no action. Noted, not
   fixed.

The booking test investigation (`test-day-order`, cause unconfirmed) is unrelated to this plan
and is recorded on its own in `docs/FLOW_REGISTER.md`.

## The real-job walk (R5) — read-only checklist

Signed in as the office, on an existing active job that has a signed proposal, a few logged
days, a material list with at least one sent purchase order, and an invoice. **Look only:** no
purchases, emails, payments or edits. Each tab below lists the buttons NOT to press.

| Tab | What should be there | Must agree with | Opens a classic page | Don't press |
|---|---|---|---|---|
| Overview | header: Contract value, Project progress, Billing; six cards and the next action | each card = its tab (below) | "Open in classic" → classic project page; customer / property links | "Log an update" (inert) |
| Tasks | Complete %, tasks done, days logged, person-hours, the list | Complete % = header Project progress = Overview Tasks card (= Projects list bar, browser-mirrored); days logged and person-hours = Daily Records | — | progress buttons, Complete, Edit, Remove, Add task, Restore |
| Daily Records | each day: clock in/out, people, person-hours, photos, notes; problems | days logged, person-hours, problems open = Overview Daily Records card | photos open full size | Correct clock times, Correct crew count, Raise a problem, problem status |
| Materials | Required (one number, or "Per list — N lists"), Ordered, Received, Used on site, Project balance; lists; project stock | the same figures on the Overview Materials card; Ordered = units on this job's sent / partly received / received POs (cancelled: only what arrived; drafts: none) | list name → classic material list; PO number → classic PO; work order number → classic work order | anything on those classic pages (send, receive, cancel, edit) |
| Change Orders | Open, Waiting on customer, Signed; the agreement (signed version, any unsigned revision) | counts = Overview Change Orders card; signed agreement total = header Contract value = Financials Signed contract | "Act on these in the classic project page"; quote / revision links; work order links | send, approve, withdraw, generate revision |
| Financials | Signed contract, Invoiced, Received, Owed now; invoices, payments, deposit, "If it were billed today", holds, any reconciliation warning | Overview Financials card (Signed contract, Invoiced, Payments received, Outstanding = Owed now, Not yet invoiced, Deposit); each invoice's payments = its classic invoice page | invoice numbers → classic invoice; "Record payments on the classic pages" | record payment, send, mark paid, void |

Record what was walked, on which job, and any figure that disagreed, here before retiring
anything.

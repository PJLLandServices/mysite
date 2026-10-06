# Unified Booking Source of Truth — Phase 0 inventory (PJL-132)

Project P-PJL-39 · parent PJL-131 · written 2026-10-06 against `origin/main` @ `af1ef28`
(worktree `.claude/worktrees/ubst-phase0`, branch `claude/pjl-132-phase0-inventory`).
Read-only: no code, data or production record was changed to produce this.

> The local `main` checkout in `C:\Users\patri\Downloads\pjl-land-services-v39` is **361 commits
> behind** `origin/main`. Every line number below is from `origin/main` @ `af1ef28`, not from that
> checkout.

## 0. Landed after this inventory was cut: PR #398 (merged 2026-10-06 22:44Z, `305d7e3`)

A parallel session (claude.ai/code `session_01KuxEPrdL79fr4cZ3xWNGGF`) shipped #398 for the same
Peter Bazios symptom while this inventory was being written. Patrick confirmed the cause to that
session in words: *"I personally deleted his appointment."* That matches §4 exactly (door W6).
`server.js` line numbers below `13786` are unchanged; below that they shift by up to +40.

What #398 changed:

1. `assignments.skippedThisSeason(property, season, year)` reads the property's
   `seasonalOutreach[season].optOutThisSeason`; `drivenPlan` turns an `unassigned` stop on a
   skipped property into a new `skipped` state (added to `GONE_STATES`), so it leaves the day card.
2. "Skip this season" is now a button on every planned, unbooked stop (same
   `POST /api/outreach/opt-out-season` as the tray chip).
3. `season-plans.addStop`/`moveStop` record `day.placed[code] = {at, by, via, from?}`; the day
   card shows how a stop got there.
4. `DELETE /api/bookings/:id` accepts `{ saidNo: true }` from a "Was this a no?" prompt on the
   Schedule canvas and the booking page; when true it **still hard-deletes** and then sets the
   property's skip flag for the season derived from the service key.

How it relates to this project:

* It solves the **never-booked** case correctly and in line with the TRD: a phone "no" from a
  customer with no appointment is a property preference, not an appointment, and the plan reads
  it only when no Booking exists (`unassigned` only). That part should stay.
* It does **not** change the architecture for the **booked-then-removed** case, which is what
  actually happened to Peter. The record is still erased; the "no" lives in a third store (the
  property flag), and a delete answered "booked by mistake" behaves exactly as before. Unassign
  (W5) is untouched and still deletes messaged bookings silently. An inbound SMS "no" is still not
  recorded. The flag is reversible on the property, which brings the stop back with no trace.
* PJL-134/135 should absorb it: the admin delete of a seasonal booking becomes
  `cancelBooking(reason: "customer_declined")`, which produces the cancelled record every reader
  already honours (`planStopState` → `cancelled`, `declinedThisSeason`, outreach), and the
  property flag stays only as the answer for customers who were never booked. The `placed`
  provenance is a step toward stop identity and should become `{bookingId, placed}` in Phase 2.
* The same session has PR #399 open (`lib/resequence.js` only, optimiser scoring). No overlap with
  booking identity, but it is the same person's lane on the Season Plan; coordinate before Phase 2.

---

## 1. Headline findings

1. **There are seven places an appointment can exist, and only one of them (bookings.json) has
   a lifecycle.** The other six are: the `lead.booking` envelope on `leads.json`; the stored
   Season Plan (`season-plans.json`, property codes per day/bucket, no booking id); the Work
   Order (`work-orders.json`, `scheduledFor` + `status`, **no `bookingId` field exists** — grep
   count 0 in `server/lib/work-orders.js`); `property.serviceRecords` (written by the completion
   cascade, now read by the portal as the real "done" signal); `holds.json` / booking sessions
   (pre-booking); and `lead.standby` (open-bucket request with no date).
2. **Nothing completes a Booking.** The completion cascade (`server/lib/completion-cascade.js`)
   never touches bookings.json. The only code that ever writes `status: "completed"` on a Booking
   is `upsertFromLead`'s "close the previous visit when the customer re-books"
   (`server/lib/bookings.js:579`). Production confirms it: **57 bookings dated before today are
   still `confirmed`** (list_bookings, status=confirmed, 2026-01-01..2026-10-05).
3. **Cancellation has five doors and they do five different things.** `POST /api/bookings/:id/cancel`
   (soft, mirrors to lead, emails, no WO cascade); portal `/cancel` (soft, mirrors, **does** cascade
   WOs); appointment-page cancel (soft, assignment bookings only); `PATCH /api/bookings/:id` with
   `status` from the `/admin/booking/:id` Status dropdown (`server/booking.js:181` →
   `bookings.update`, **no cancelledAt / reason / lead mirror / email**); and two **hard deletes**:
   Schedule page "Delete Permanently" (`DELETE /api/bookings/:id`, `server/server.js:13790`) and
   Season Plan "Unassign" (`assignments.unassign` → `bookings.remove` for every confirmed,
   never-rescheduled, WO-less assignment booking — **including ones the customer was already
   messaged about**, `server/lib/assignments.js:964-1000`).
4. **Peter Bazios is a hard-delete, not a cancellation** (§4). His assignment booking was created
   and messaged on Oct 1 (batch `AS-854382e1`, step-1 touch on the property) and no longer exists
   in any status. The stored plan stop therefore reads `unassigned`, which every plan reader treats
   as "planned, drive there, offer Book now", and the next Assign run would re-book and re-message him.
5. **A raw `fs.writeFile` to bookings.json still exists** outside the library: the follow-up
   work-order path (`server/server.js:15260-15310`, FILE at 15305). It bypasses the atomic store,
   the lock, and `blank()` (no `customerId`, `rescheduleCount`, `officeReview`).
6. **The portal's "upcoming" fact ignores booking status on the lead envelope.**
   `envelopeUpcoming` (`server/server.js:4737`) is "any lead.booking whose end is in the future",
   with no `holdsItsSlot` check, so a soft-cancelled future lead booking still yields
   `service_scheduled`.
7. **`removedToday` on the Field app reads only leads** (`server/server.js:26087`), so an assignment
   (lead-less) booking taken off the day via "Not today" never appears in the "came off today" list.
8. **The WO duplicate-id repair (#391) renumbers WOs and fixes `lead.workOrderId` but not
   `booking.workOrderIds`** (`server/server.js:~3000-3060`). Peter's `BK-2026-0002` points at
   `WO-X8YWAQRD`, which `read_crm` reports as not found.
9. Good news that constrains the design: the PJL-97/PJL-93 fixes shipped (`workOrdersForVisit`,
   `recordForLeadBooking`, `currentRecordForLead`, `visitRecordForBooking`, `workOrderForLeadBooking`)
   and the plan already **derives** stop liveness from bookings (`planStopState` / `drivenPlan`).
   The TRD's "derive, don't synchronise" rule is therefore already the house style for the plan;
   what is missing is identity (bookingId on the stop and on the WO) and the lifecycle ops.

---

## 2. Independent sources of appointment state (what the audit must reconcile)

| # | Store | Field(s) that say "there is an appointment" | Who treats it as authoritative today |
|---|-------|-----------------------------------------------|--------------------------------------|
| S1 | `server/data/bookings.json` (`lib/bookings.js`) | `scheduledFor`, `status` (confirmed/tentative/cancelled/completed/no_show), `workOrderIds[]`, `assignment{date,bucket,season}` | Bookings pages, iCal, reminders, cadence, plan stop state, portal season-plan state, Today "extras" pass, MCP list/get |
| S2 | `leads.json` → `lead.booking` envelope | `start`, `end`, `status` (mirror), `cancelledAt`, `workOrder{id,status}`, `bucketKey/bucketWindow`, `coords`, `dayLocked` | availability lead pass (`activeBookings`), Today lead pass + `removedToday`, admin Schedule canvas (via `/api/quotes`), portal `envelopeUpcoming`/`nextVisit`, portal calendar.ics, CRM lead card, WO creation guards, notify-customer templates |
| S3 | `season-plans.json` | `days[date].morning/afternoon[]` = property **codes**; `constraints`, `manualOrder` | geo-filter day shapes (availability), plan board/map/route line, unplanned tray, probe, job-finder plan stops, `syncRoutedTimes` |
| S4 | `work-orders.json` | `scheduledFor`, `status`, `leadId`, `propertyId`, `followupWoIds` (no `bookingId`) | Today `mergeDaySchedule` (property-only WOs appear as rows with no booking), portal `woUpcoming`/`nextVisit`, service history, invoices |
| S5 | `properties.json` | `serviceRecords[]` (cascade), `workOrderIds`, `seasonalOutreach[season].touches` (who was told), `optOutThisSeason` | portal "season complete" (`isSeasonWorkCompleted`), outreach eligibility, preflight/unplanned ("Skip this season") |
| S6 | `holds.json`, booking sessions | 10-minute slot holds; pre-booking payloads | availability counts holds as taken; reserve consumes under lock |
| S7 | `lead.standby`, `lead.workOrderId`, customer `welcomeEmail.bookingId`, `assignment-blasts.json`, reserve receipts | side records that name an appointment | open-bucket panel, CRM deep links, welcome sweep, blast interlock, retry replay |

Every row except S1 can keep saying "appointment" after S1 says cancelled, or after S1's record is deleted.

---

## 3. Writer / reader matrix

Legend for "parallel state": **Y** = this writer creates or keeps a second representation that
other readers consult without reading the Booking; **mirror** = it writes the same fact into two
stores by hand (drift risk, not a second identity); **N** = Booking-only.

### 3.1 Writers

| # | Surface / API (origin/main) | Trigger (UI / caller) | Reads to decide | Writes | Parallel state? | Idempotency today | Target canonical operation |
|---|---|---|---|---|---|---|---|
| W1 | `POST /api/booking/hold` (`server.js:25046`) | public picker, portal, Season Plan probe, MCP `book_appointment` | `activeBookings()` incl. live holds | `holds.json` (10 min) | N (provisional, expires) | token | keep as non-Booking hold; conversion stays inside the reserve lock (TRD §9) |
| W2 | `POST /api/booking/reserve` (`server.js:25126`) | public booking page; portal Book-a-Service (begin-booking session 8458/8535); admin Schedule +Book; Season Plan probe "Book it"; open-bucket placement (29099); handoff link; AI-chat prebooking; MCP `book_appointment` | leads, bookings, holds, plan day shapes, receipts | **`lead.booking = {start,end,bucket*,workOrder:{id:new}}`** (25559 existing lead / 25800 new lead) → `writeLeads` → `syncBookingFromLead` → `upsertFromLead` (bookings.json) → `restampDayInDrivingOrder` → `syncRoutedTimes` (re-stamps the whole day in both stores + WO.scheduledFor); consumes hold; promotes customer | **Y** — lead envelope is written first and is read on its own by R1/R2/R3/R5/R12; canonical mirror is "best-effort, never rolls back the lead" | reserve lock + `clientRequestId` receipt, 24 h (PJL-87) | `createBooking({source, leadId?, propertyId})` returns the id; lead carries `bookingId` only |
| W3 | reserve, standby branch (`server.js:25780`) | open-bucket request | — | `lead.standby{…}` (no date, no booking) | Y (undated request) | — | decide: `Booking.status = "standby"` or explicitly out of scope; today it is invisible to every Booking reader |
| W4 | `assignments.assign` (`lib/assignments.js:~500-640`; route `POST /api/assignments/:s/:y/assign` 28359; `only={code,date}` = **Book now**, #395) | Season Plan Assign / Book now | plan, properties, bookings (`priorAssignmentsFor`), eligibility (`outreach.assessEligibility`, `deriveBookingState`, `declinedThisSeason`), opt-out | `bookings.createDirect({source:"assignment", assignment:{season,year,batchId,date,bucket,code}})`; then `syncAssignedTimes` | Y — the **plan code** stays as the intent; the stop carries no booking id | one assignment booking per property per season (`priorAssignmentsFor`), `duplicate_in_plan`; Book now overrules a cancelled assignment by design | `createBooking` + write `bookingId` onto the plan stop |
| W5 | `assignments.unassign` (`lib/assignments.js:964-1000`; route 28407) | Season Plan "Unassign" (press twice) | bookings | **`bookings.remove`** for every assignment booking that is confirmed, rescheduleCount 0, no WO | **Y** — stop reverts to `unassigned`; `property.seasonalOutreach.touches` keep saying the customer was told | none | `cancelBooking(id, reason:"unassigned", actor)`; hard delete only for never-messaged records, or removed from the UI |
| W6 | `DELETE /api/bookings/:id` (`server.js:13790-13846`; since #398 also reads `{saidNo}` and sets the property skip flag after deleting) | Schedule page "Delete Permanently" and booking page Delete (admin); both now ask "Was this a no?" for seasonal services | this visit's WOs (`workOrdersForVisit`) | `bookings.remove`; best-effort `delete lead.booking` + `writeLeads`; with `saidNo` also `property.seasonalOutreach[season].optOutThisSeason = true` | **Y** — the record is still erased; plan stop reads `skipped` (via the property flag) or `unassigned` (booked by mistake / flag cleared); WO keeps `leadId/propertyId` and `scheduledFor` (still on Today via `mergeDaySchedule`); if the lead cleanup fails the heal sweep (W16) **re-creates** the record | none | `cancelBooking(reason:"customer_declined" \| "entered_in_error")`; physical delete reserved for test-data purge; property flag only for never-booked customers |
| W7 | `POST /api/bookings/:id/cancel` (`server.js:13848-13940`) | Schedule page Cancel; Field app "Not today" (reasonCode → `cancelled`/`no_show`); CRM; MCP `cancel_booking` | booking, lead | `bookings.cancel` (status from reason) → **mirror** `lead.booking.status/cancelledAt/reason/removalCode/removedBy`; customer email; **no WO cascade** | mirror | 409 on re-cancel | `cancelBooking()` single write; lead envelope becomes a projection; WO reconciliation inside the op |
| W8 | `PATCH /api/bookings/:id` (`server.js:13768`) | `/admin/booking/:id` Status dropdown + prep notes (`server/booking.js:181`); property cascade (address/name sync); `retimeCustomerBooking` for lead-less rows | — | `bookings.update(payload)` — any of `status, scheduledFor, serviceKey…`; history `status:<x>` only | **Y** — status flips with no `cancelledAt`, no lead mirror, no WO cascade, no email, no `removalCode`; a lead-backed booking cancelled here **keeps its slot** in `activeBookings`' lead pass and stays on Today's lead pass; `completed` here fires nothing | none | `update()` refuses `status` and `scheduledFor`; only lifecycle ops may change them |
| W9 | `POST /api/bookings/:id/reschedule` (13962) + `rescheduleBooking()` (`server.js:5748-5890`) | admin Schedule, CRM `crm-reschedule.js`, MCP `reschedule_booking`, portal `/reschedule` (15942), appointment page `/reschedule` (27865) | booking, lead, this visit's WOs, availability | `bookings.reschedule` (scheduledFor, rescheduleCount, history) → **mirror** `lead.booking.start/end/bucket*` (5870) → `wo.scheduledFor` for this visit's WOs → emails → `syncRoutedTimes` | mirror × 3 stores, sequential, non-atomic | no-op if same start | `rescheduleBooking(id, newSchedule, actor)`; WO date and lead envelope derived or written inside the op |
| W10 | `POST /api/bookings/:id/service-type` (13994) | Schedule page / CRM / portal admin | booking, lead | `bookings.update(serviceKey…)` + lead mirror | mirror | — | part of `updateBooking` (non-lifecycle) |
| W11 | `POST /api/portal/:token/cancel` (`server.js:16100-16215`) | Customer Portal | `currentRecordForLead` (PJL-97) | `bookings.cancel` → mirror `lead.booking.status="cancelled"` (16189) → **cascades linked WOs to cancelled** → CRM activity | mirror; inconsistent with W7 (which does not cascade WOs) | 409 | same `cancelBooking()` as W7 |
| W12 | `/api/appointment/:token/(confirm\|cancel\|reschedule\|free-bucket\|time-window\|zones)` (`server.js:27865-28010`, `lib/appointment-actions.js`) | customer appointment page (`/a/:token`) for assignment bookings | booking by token | `markAssignmentResponded`, `cancel`, `setFreeBucket`, `setRequestedWindow`, `setDeclaredZones`; reschedule → W9 + `syncRoutedTimes` | N (assignment bookings have no lead) | first answer wins | `cancelBooking` / `rescheduleBooking` / `acknowledge` |
| W13 | cadence & confirmations: blast 28122, arm 28144, catch-up 28182, `sweepDue` (interval 31235), `mark-responded` 28221, `send-confirmation` 28258 (`lib/assignment-cadence.js`) | Season Plan panel; sweeps | bookings (`source==="assignment" && status==="confirmed"`) | `booking.assignment.outreach.*`; **`property.seasonalOutreach[season].touches`** (batch id, step, channels); `assignment-blasts.json` | Y — "customer was told" lives on the property with no booking id (survives a delete; this is Peter's trace) | rule-1 mark-before-send | touches carry `bookingId`; cadence reads Booking only |
| W14 | Season Plan edits: `PUT /api/season-plans/:s/:y` 27594; `/move` 28607 (`seasonPlans.moveStop` + `followPlanMoves` → `bookings.moveAssignmentDay`); `/day` 28554 (`moveDay` + `moveDayBookings`); `/add` 28903; `/unplanned/place` 28843; `/stop-window` 28449; `/stop-order` 28496; `/auto-order` 28525; `/caps` 28476; `/follow-plan` 28653 | Season Plan board (drag, move, add, reorder) | plan, bookings | `season-plans.json`; for assignment bookings `moveAssignmentDay` writes `scheduledFor` + `assignment.date/bucket`, resets the customer's answer, queues a day-move notice — **not** `bookings.reschedule` (no rescheduleCount), no WO date | Y — the plan is the second representation; a move is a reschedule by another name | `moveDay` refuses days with real bookings | plan stop = `{bookingId, route metadata}`; move = `rescheduleBooking(reason:"plan_move")` |
| W15 | `syncRoutedTimes` (`server.js:30475`; after every plan edit/booking, and on an interval 31118) | automatic | plan, bookings, leads, WOs | `bookings.update(scheduledFor)` on pristine assignment bookings; `retimeCustomerBooking` (30425) → `lead.booking.start/end` + `mirrorBookingOnly` + `wo.scheduledFor` | mirror × 3, periodic | skips arrived/locked | the TRD's `internalRouteTime`, separate from the promised date+bucket; one writer |
| W16 | `bookings.healFromLeads` (sweep 31144; iCal feed `lib/ical-feed.js:309`) | automatic | leads without a canonical record | creates canonical from `lead.booking` | **Y** — resurrects a hard-deleted record whose envelope survived | by leadId | retire once `lead.booking` is a projection |
| W17 | `POST /api/work-orders` (`server.js:21744`) | CRM new work order (lead or **property only**); the Field app for **every season-plan row** (`pjl-field/src/api.js:195`) | lead, property; refuses a dead `lead.booking` (property-only creates are unguarded) | WO (`leadId/propertyId`, `scheduledFor` from `lead.booking.start`, `customId` = envelope id); `bookings.attachWorkOrder(recordForLeadBooking)` only when a lead exists (21965-21970, PJL-93 fixed); `lead.workOrderId` | **Y** — property-only WOs are never linked, so **no season-plan booking ever gets a Work Order id**; a dated WO with no Booking shows on Today via `mergeDaySchedule` | id never reused; no upsert (a second POST for the same lead makes a second linked WO) | scheduled work must create/bind a Booking; WO gets `bookingId` |
| W18 | `POST /api/leads/:id/open-wo` (`server.js:26582`) | Field app "Open WO" | `workOrderForLeadBooking` (818) else create under envelope id | WO; `attachWorkOrder(recordForLeadBooking)` (26631); `lead.workOrderId` | heuristic fallback (type + createdAt) when the envelope names no WO | — | resolve by `bookingId` first |
| W19 | Follow-up WO (`server.js:15240-15340`) | WO page "Follow-up" | parent WO, lead, availability | follow-up WO; **raw `fs.writeFile` of bookings.json** with a hand-built record (`created_followup`) | Y (bypasses store lock → lost-update risk against any concurrent writer) | none | `bookings.createDirect` |
| W20 | WO `PATCH` → `status:"completed"` (`server.js:22470-22560`) | Field app Finish / desk | WO | completion cascade: `property.serviceRecords`, invoice, warranty, notifications; **no Booking write**; `lead.booking.workOrder.status` not written | **Y** — Booking stays `confirmed` forever; portal reconciles from `serviceRecords` (PJL-107 #2) | cascade idempotent per WO | `completeBooking(bookingId, woId, completedAt)` inside the cascade |
| W21 | WO `PATCH` → `cancelled` / `no_show` | desk | WO | WO only | Y (Booking untouched) | — | WO terminal → Booking reconciliation (or refuse without it) |
| W22 | WO duplicate-id split (`server.js:~3000-3060`, #391) | boot repair | WOs | renumbers WO ids, `lead.workOrderId`, photos, re-runs cascade; **not `booking.workOrderIds`** | Y (dangling WO ids on Bookings) | — | audit category + relink |
| W23 | `customers.remove` / `cascadeDeleteLinks` / `purgeTrashedLinks` / `mergeCustomers` (`lib/customers.js:627-1010`) | Customer page Delete / Merge | all link files | rewrites or deletes booking records by `customerId` | — | under store lock | keep; audit "orphaned by customer delete" |
| W24 | `lib/purge-test-data.js` | admin purge | PJLTEST markers | deletes bookings/WOs/invoices/quotes/projects | — | — | keep (the one legitimate physical delete) |
| W25 | Property PATCH cascade (`server.js:~5100`) | Property page edit | property | `bookings.update(address/name/phone)` | N | — | fine |
| W26 | `POST /api/leads/:id/notify-on-route` 26490, `POST /api/bookings/:id/notify-on-route` 26543 | Field app | — | `lead.onRouteNotifiedAt` / booking stamp | mirror-ish (stamp counts per visit day) | same-day guard | stamp on Booking only |
| W27 | `POST /api/outreach/opt-out-season` | Season Plan chip "Skip this season" (`season-plan.js:1636`) | — | `property.seasonalOutreach[season].optOutThisSeason` | Y — a third kind of "no" beside a cancelled assignment booking and `declinedThisSeason` | — | keep as property preference, but preflight/Book-now read one `seasonAnswer()` |
| W28 | MCP tools (`lib/assistant-mcp.js:309-414`) | PJL Assistant | — | all through W1/W2/W7/W9 | — | `assistant:<operationId>` receipt | no change needed |

### 3.2 Readers

| # | Surface | Entry point | Reads | Active rule | Booking ↔ WO link | Can show a cancelled/completed/deleted appointment as active? |
|---|---|---|---|---|---|---|
| R1 | Availability / capacity | `activeBookings()` (`server.js:~5400-5470`) | lead pass (S2) ∪ canonical pass (S1, dedup by leadId+start) ∪ holds | shared `bookingHoldsItsSlot` | — | **Yes** when only the canonical status changed (W8 PATCH on a lead-backed booking) or after a re-stamp changed one store's start and not the other |
| R2 | Field app Today / today-map / MCP `day_schedule` | `GET /api/schedule/today` (`server.js:26050-26300`) | lead pass (S2, WO via `workOrderForLeadBooking` 26129) ∪ canonical extras (S1, WO via `workOrdersForVisit` 26211) ∪ `mergeDaySchedule` WO rows (S4) ∪ `removedToday` (S2 only) | shared | by lead envelope / `workOrderIds` | Yes for a property-only WO whose Booking was cancelled elsewhere (WO row survives); "came off today" misses lead-less bookings |
| R3 | Admin Schedule canvas | `server/schedule.js:184-250` (client-side) | `/api/quotes` leads (S2; cancelled drawn struck) ∪ `/api/bookings` (S1; skips completed/no_show, keeps cancelled) ∪ blocks | hand-rolled, display-only (allow-listed) | — | Yes: a deleted canonical record whose lead envelope survived; two rows when lead start ≠ canonical start |
| R4 | Season Plan board / map / route line / preview / probe | `GET /api/season-plans/:s/:y` 27594 → `resolveSeasonPlan` (27469) → `assignments.drivenPlan` (824-853) → `planStopState` (739-787); booked rows from `gatherBookedRows` (30359-30410) over `activeBookings()` | S3 codes + S1 grouped **by `b.propertyId` only** (assignments.js:835 — records with no `propertyId` stamp are invisible to the stop state, unlike `unplanned`/`deriveBookingState`, which use `belongsToProperty`) | shared `holdsItsSlot`; states `on_day / done / unassigned / moved / cancelled / no_show`; `done` only when `booking.status==="completed"` (747), never from the WO | annotates `bookingId` at read time; the plan never reads WOs | **Yes — a hard-deleted booking returns the stop to `unassigned`** (drawn, numbered, Book now offered). A WO-completed assignment visit stays `on_day`, not `done`. A cancelled self-booking with no `propertyId` stamp stays `unassigned`. |
| R5 | Customer Portal header / Next visit / Book a service / booking-actions | `customerPortalSections()` (`server.js:4495`); `/booking-actions` 16009 (`currentRecordForLead`) | `envelopeUpcoming` (S2, **no status check**, 4737) ∥ `woUpcoming` (S4 open WOs) ∥ `deriveBookingState` (S5 `serviceRecords` first, then S1 by `belongsToProperty`, then `declined`) | mixed | `workOrdersForVisit` | Yes: a soft-cancelled future lead booking still reads "scheduled"; a completed visit with no `serviceRecord` reads "scheduled" |
| R6 | Portal calendar.ics | `server.js:8311` | lead envelope only; refuses season-plan visits | — | — | follows the envelope |
| R7 | Appointment page `/a/:token` | 29796 + `/api/appointment/:token` (`appointment-actions.summarize`) | S1 by token | names cancelled vs completed (allow-listed) | — | No |
| R8 | Patrick's iCal feed | `lib/ical-feed.js:345` | S1 `status==="confirmed"` (tentative excluded); heals from leads first | hand-rolled single state | `workOrderIdsForVisit` | No for canonical state; shows nothing for a deleted record |
| R9 | Day-before reminders | `lib/booking-reminders.js` | S1 `confirmed`, `source!=="assignment"`, `reminder24` mark | single state | — | No |
| R10 | Assignment cadence | `lib/assignment-cadence.js` `cadenceBookings` | S1 `source==="assignment" && status==="confirmed"` | single state | — | No; but a stale `confirmed` completed visit keeps receiving steps until the season window ends |
| R11 | Outreach eligibility / preflight / unplanned tray | `lib/outreach.js` `assessEligibility`, `seasonSettled`, `deriveBookingState` (288), `declinedThisSeason` (259); `lib/assignments.js` `preflight`/`unplanned` | S5 serviceRecords + S1 + opt-out | shared | — | A deleted assignment booking → `declined: null` → property offered a day again |
| R12 | CRM lead card | `server/admin.js:1839` `/api/bookings?leadId` (heals), `/api/work-orders?leadId` | S2 + S1 | server re-checks | — | follows S2 for link target |
| R13 | Bookings list / booking detail | `/admin/bookings`, `/admin/booking/:id` | S1 + `customerState` | shared (server-derived) | `workOrderIds` | No |
| R14 | Customer page / property page / MCP `get_customer` | `/api/customer/:id`, `/api/properties/:id` | S1 by customerId / propertyId | — | — | No |
| R15 | Work order pages | `/api/work-orders/:id` | S4 | WO terminal set | via lead envelope id | n/a |
| R16 | Job finder (Today search, MCP `find_jobs`) | `lib/job-finder.js:120-175` | S2, S1 (own dead list), S4, S3 plan stops (booked = any non-cancelled booking same property+day) | hand-rolled lists | — | plan stop reads "never booked" for a deleted record (Peter's verdict today) |
| R17 | Welcome-email sweep, review requests, notify-customer templates | `customer.welcomeEmail.bookingId`; WO completed; `lead.booking.bucket*` | S7 / S4 / S2 | — | — | templates read the envelope's bucket, not the Booking |
| R18 | Geo day shapes for availability | `dayShapesForSeason` / `lib/geo-filter.js` | S3 (driven plan) + S1 | via `drivenPlan` | — | a deleted booking's stop is back in the day's shape |
| R19 | Open bucket panel | `GET /api/standby` 29227 | `lead.standby` | — | — | n/a |
| R20 | MCP `list_bookings` / `get_booking` | `/api/bookings` | S1 | — | — | No |

### 3.3 Additional findings from the reader cross-check (verified, origin/main)

1. **Today's `bookingId` per row is the first bookings.json record for that lead in file order,
   whatever its status or date** (`server.js:26073-26080`). Follow-up records (W19) are unshifted to
   index 0 with the same `leadId`, so the Field app's "Not today" can cancel the follow-up instead of
   the visit on screen, and the cancel route then mirrors that status onto the primary `lead.booking`
   with no start-time match (`13892-13906`).
2. **Admin/tech cancel (W7) leaves the Work Order `scheduled`**, and `mergeDaySchedule`
   (`lib/day-schedule.js:124-143`) re-adds it to Today as a `source:"work_order"` row the moment the
   booking row drops. Only the portal cancel (W11) cascades (`16214-16231`).
3. **Season-wide Assign re-books a self-booked-then-cancelled customer.** `preflight`/`assign` read the
   stored plan and `assessEligibility`, which ignores `declined`; `priorAssignmentsFor` counts only
   `source:"assignment"` records (`lib/assignments.js:363-371, 586-593`). The board drops that stop
   (#397) and the tray blocks them (463-468) — three answers to one question.
4. **Open WO has no booking-status check** (`26582-26655`); `workOrders.listByLead` (1728-1731) does not
   filter deleted/archived WOs but `list()` does, so a finished visit whose WO was archived can get a
   fresh WO.
5. **Admin Schedule canvas treats a lead-side `no_show` as a live event** (`schedule.js:410, 617, 628,
   1459-1461` hide actions only on `cancelled`).
6. **Appointment page `summarize` has no `no_show` branch** (`appointment-actions.js:81-85`): a
   no-show stamped before the bucket time reads "open" with Confirm/Cancel enabled.
7. **Early-completed assignment visits keep receiving cadence steps up to the day-before SMS**
   (`assignment-cadence.js:633-637`), stay in the iCal feed, hold capacity, and read
   "Scheduled/Confirmed" on the Bookings list — all because W20 never flips the Booking.
8. **Plan mislabel:** an assignment booking moved to another day and completed there is reported in
   the original day's `dropped` strip as "customer cancelled" (`assignments.js:777-786`).
9. **`lead.booking.workOrder.status` is frozen at `"scheduled"`** (written once at 25573; no writer
   since); the CRM lead card (`admin.js:956`) and the portal payload (`server.js:5081`) show it.
10. **Booking detail lists every linked WO, not this visit's** (`booking.js:279`); the customer page
    drops follow-up bookings because they carry no `customerId` (`server.js:10431` vs 15279-15300).
11. **Hand-rolled liveness copies still in readers:** `appointment-actions.js:81-85`,
    `booking-reminders.js:65`, `assignment-cadence.js:637`, `ical-feed.js:350`,
    `job-finder.js:105-113/125/157-159` (lead verdict has no status check), `schedule.js:219`,
    `work-order.js:999-1001`, `crm-reschedule.js:128-131`, `admin.js:1840`, `day-schedule.js:56`,
    `server.js:16035-16037, 27500-27502`, `assignments.js:283, 895, 1038, 1103`.

### 3.4 Additional findings from the writer cross-check (verified, origin/main)

1. **A season-plan booking can never be linked to its Work Order.** The Field app opens a WO for a
   lead-less row with `POST /api/work-orders {type, propertyId}` (`pjl-field/src/api.js:195-196`),
   and that route links a booking only when a lead is present (`server.js:21965-21970`). Every
   assignment booking therefore keeps `workOrderIds: []` for life, its WO exists only as a second
   unlinked record, and Unassign's "has_work_order" guard can never fire for them.
2. **Three GET endpoints write.** `GET /api/bookings?leadId=` (13741-13748), portal
   `reschedule-availability` (15906-15917) and portal `booking-actions` (16010-16029) call
   `syncBookingFromLead` when the lead has no record, which can create a record, close last
   season's record as `completed` (`closed_by_rebook`), promote the customer and re-time the day on
   a page view.
3. **Five more writers copy onto `lead.booking` without checking it is the lead's current booking:**
   reschedule (5869), DELETE (13827), service-type (14037), `retimeCustomerBooking` (30441), plus
   the cancel mirror already listed. With a follow-up record sharing the parent's `leadId`, any of
   them can overwrite or cancel the main appointment's envelope. Only the portal routes resolve
   through `currentRecordForLead`.
4. **Reserve's retry safety only works for the PJL Assistant.** The `clientRequestId` receipt is
   sent by `lib/assistant-mcp.js:356` and by nobody else; the public page, the admin Schedule modal
   and the Field app have no replay protection beyond the lock.
5. **The reserve new-lead path never looks for an existing lead or customer** (`isLikelyDuplicate`
   is used only at 7711), so a returning customer booking from the public page gets a second lead,
   envelope and record. Book-from-lead (A4) overwrites the envelope with no check for a live one; the
   earlier record is left `confirmed` with `officeReview` and keeps holding its slot and its Today row.
6. **bookings.json has no store lock.** Writes go through `writeJsonAtomic` only (`lib/bookings.js:72`);
   just `/api/booking/hold` and `/api/booking/reserve` take `bookingReserveLock`. Season plans
   (`lib/season-plans.js:112`) and the schedule store write non-atomically. Concurrent cancel,
   reschedule, cadence and re-time writes can lose each other.
7. **More writers of appointment state:** emergency override `POST /api/work-orders/:id/emergency…`
   (24389, creates a `service_visit` WO dated at `lead.booking.start`, no booking); `DELETE
   /api/work-orders/:id` (22900, clears `lead.workOrderId` only, the booking keeps the dead id);
   bulk WO change-status (`lib/bulk-actions.js:196-204`, no cascade, no booking change); Property
   DELETE (11032, leaves season-plan bookings orphaned); lead lost/archive/soft-delete (only the lead
   pass of `activeBookings` drops them, the canonical pass still holds the slot); inbound SMS "YES"
   (7521 → `appointmentActions.confirm`); follow-up with no slot picked (WO dated at the parent's
   `lead.booking.start`, an extra Today row).
8. **"Skip this season" (29354) does not cancel an existing assignment booking**; it only sets the
   property opt-out, so the plan can carry both a live booking and a recorded "no".
9. **`PATCH /api/bookings/:id` is reachable by the tech role** (path auth "user", 1709), and
   `bookings.update` has no transition rule, so a dead booking can be revived to `confirmed`.
10. **`admin_custom` reschedule skips every availability and overlap check** (5808-5827); the MCP
    `reschedule_booking` with `customTime` inherits that.
11. **Dead or unswept state:** `lead.booking.dayLocked` is read (30446) but never written;
    `holds.sweep()` is never called (expired holds are only filtered on read).
12. **More hand-rolled status lists:** `server.js:2261` (a WO finished list duplicating the
    unexported one in `lib/bookings.js:262`), `server.js:4741, 16129, 16153, 27834, 28575`,
    `lib/outreach.js:261, 328`, `lib/work-orders.js:817, 1978, 2234`, `lib/assignments.js:455, 780,
    981`, `assignment-cadence.js:724`, `portal.js:660`, `work-orders-index.js:34`,
    `work-order-tech.js:1371, 4899`, `schedule.js:410, 524`.
13. **A stop's time window has two sources and the day card shows one.** Patrick's window lives in
    `day.constraints[code]` (written only by `seasonPlans.setStopWindow`, route 28482) and is what
    the card displays (`resolvePlanDay` 27447-27453, `season-plan.js:352-422`). The customer's own
    window from the appointment page lives on the booking (`requestedWindow`, W12) and reaches the
    sequencer through `requestedWindowsFor` (27513) but is **never shown on the stop**. So a day can
    re-order around a window nobody can see, and a window that is visible carries no record of who
    set it or when (the admin action log keeps method and path only). Tonight's "after 11:00" on
    94 Dianawood Ridge (PR #399) is this gap: a visible window is a plan constraint, so someone
    pressed Time window → Save on the plan, and only the action log's timestamp can say when.
    Target: one `windows` read with provenance (`{notBefore, notAfter, by: "customer" | user,
    at}`), shown on the stop, and `setStopWindow` stamping who/when the way `placed` now does.

---

## 4. Peter Bazios — exactly where he can remain on the Seasonal Plan

Production facts (read-only, PJL Assistant connector, 2026-10-06 ~22:40 UTC):

| Fact | Value |
|---|---|
| Property | `P-2026-0009` (`c9012ade-…`), 16905 McCowan Rd, Cedar Valley; `serviceRecords: []`, `workOrderIds: []` |
| Fall plan stop | `fall-2026` → **2026-10-07 morning, stop #1**, `bookingState: "unassigned"`, arrive 08:12, sequenced and drawn |
| Bookings for him, Sep–Dec 2026, any status | **none** (`list_bookings` by name, by street, and the cancelled list for October) |
| Evidence a fall booking existed | `property.seasonalOutreach["2026:fall"].touches[0]` = assignment **step 1 sent 2026-10-01T13:03Z**, batch `AS-854382e1` (only an assignment booking can produce that touch) |
| His only surviving booking | `BK-2026-0002` — 2026-05-05 sprinkler repair, **still `confirmed`**, `workOrderIds: ["WO-X8YWAQRD"]` → that WO id **does not resolve** (`read_crm` 404; #391 renumbering is the likely cause) |

So the "cancellation" Patrick remembers went through a **hard-delete door** (W6 Schedule-page "Delete
Permanently", or W5 Unassign), not `bookings.cancel`. After a hard delete:

1. `planStopState` finds no booking for the property on that day and no assignment record for the
   season → returns `unassigned` → `stopIsGone()` is false → `drivenPlan` keeps the code in the day
   (`lib/assignments.js:~730-790`). The board, map, route line, day shape (R4, R18) and job finder
   (R16) all show him as a stop to drive. The chip offers **Book now** (`season-plan.js:265`).
2. `unplanned`/`preflight` see `declined: null` (no dead record to report) and would **re-book him on
   the next Assign** (`priorAssignmentsFor` is empty) and re-send step 1 (W13), because the only
   trace of the first message is the property touch, which carries no booking id.
3. Today for Oct 7 (R2) will not list him (no lead booking, no canonical record, no WO), so the
   plan and the truck disagree about tomorrow's first stop.

Two other ways he could "remain" even without a delete, both present in code today:

* A cancel done through the **Status dropdown** (W8) leaves `cancelledAt` null; the stop would still
  drop from the plan (`planStopState` reads status), but `at: null` in the dropped strip, no email,
  no lead mirror. Production has two such records: `BK-2026-0132` and `BK-2026-0171`.
* If the deleted record had a lead behind it and the envelope cleanup failed, the heal sweep (W16)
  would recreate it as `confirmed` within the hour.

This is why the fix is architectural: the plan stop has **no identity** to be cancelled by, so
"cancelled" and "never existed" are indistinguishable to it.

---

## 5. Does the PRD/TRD model need correction? Yes, in eight places

1. **Add hard delete to the lifecycle.** PRD §5.5 and TRD §4 list cancel/reschedule/complete only.
   Two production doors physically delete (W5, W6). Rule: a record that was ever shown to a customer
   or to the truck is never deleted; "remove" = `cancelBooking(reason)`. Physical delete stays only
   in `purge-test-data`.
2. **`workOrderId?` (single) in TRD §3 conflicts with the shipped model.** The record already has
   `workOrderIds[]` plus the PJL-97 rule `workOrdersForVisit`. Keep the array with the invariant "all
   ids belong to this visit" and derive `primaryWorkOrderId`; do not migrate to a scalar.
3. **"rescheduled" should not be a status** (TRD §3/PRD §5.2). A moved booking is still `confirmed`;
   the move is history + `rescheduleCount`. Adding it as a status would break `holdsItsSlot`,
   the cadence (`status === "confirmed"`) and the iCal filter at once.
4. **The customer-facing window must be a first-class Booking field.** Today the promised half-day
   lives in `assignment.bucket` (assignment bookings) or `lead.booking.bucketKey/bucketWindow` (lead
   bookings); `scheduledFor` is the route-sequenced minute that `syncRoutedTimes` rewrites. The TRD's
   `scheduledDate` / `appointmentBucket` / `internalRouteTime` split is right; the inventory shows
   the bucket currently has two homes and neither is on the canonical record for self-booked customers.
5. **`WO.bookingId` belongs in Phase 1 (contract), not Phase 4.** The completion cascade is keyed by
   WO and property; without `bookingId` on the WO it has no way to find the Booking for a
   property-only WO. Phase 4's "cascade calls completeBooking" depends on it.
6. **Seasonal Plan linkage (TRD §6): store `bookingId` on the stop, keep deriving state.** The
   current derive-only design cannot tell "cancelled" from "never booked" once a record is gone.
   Write `bookingId` at assign/Book-now; `planStopState` resolves by id first, by property for legacy
   stops; a stop whose booking is terminal or missing is never silently re-bookable by Assign — only by
   an explicit Book now.
7. **Holds and standby (TRD §9).** Holds are already non-Bookings consumed atomically under the
   reserve lock — keep. `lead.standby` is an un-modelled undated appointment request; decide whether it
   becomes `Booking.status="standby"` (visible to the audit and the plan) or is declared out of scope.
8. **Audit categories to add (TRD §11):** Bookings whose `workOrderIds` point at WOs that no longer
   exist; plan stops with an outreach touch but no booking (deleted after messaging); status flips
   with no `cancelledAt` (PATCH door); `lead.booking` present with no canonical record and vice-versa;
   property-only dated WOs with no Booking; test records in production (`BK-2026-0205/0206`,
   "PJL- Test98"); stale `confirmed` past bookings (57 today); multi-WO records (`BK-2026-0022`:
   May record moved to August with both WOs, the PJL-97 shape on Patrick's own property).

---

## 6. Fail-first tests proposed (none written yet)

All on the booted-server harness (`scripts/lib/field-server.mjs`: temp copy of `server/`, outbound
stubbed, tripwires), run from `build:check`, each confirmed failing on `origin/main` before any fix.

| Test | Fixture | Assertions that **fail today** | Already green (regression guard) |
|---|---|---|---|
| T1 `test-ubst-cancel-everywhere.mjs` (Peter) | property + fall plan stop + assignment booking with a step-1 touch; the same visit expressed as a lead booking (with its WO opened); a self-booked-then-cancelled customer on a plan day | After each of the six cancel doors (W5, W6, W7, W8, W11, W12): a canonical record **still exists** with a terminal status + `cancelledAt` (fails W5/W6: gone; W8: no `cancelledAt`); plan GET lists the stop under `dropped`, not in `morning` (fails W5/W6: `unassigned`, numbered); `unplanned`/preflight report `cancelled_this_season`, not a free property (fails W5/W6, and fails for the self-cancelled customer under season-wide Assign, §3.3.3); a re-run of Assign creates **zero** records and sends nothing (fails W5/W6 and §3.3.3); `activeBookings` frees the slot for a lead-backed booking (fails W8); Today's `removed` names an assignment booking taken off by "Not today" (fails W7 for lead-less); Today shows **no `work_order` row** for the cancelled visit (fails W7/W8: §3.3.2); W7 and W11 cascade identically to the WO (fails: W7 does not); "Not today" on the visit shown acts on that visit's record when a follow-up exists (fails: §3.3.1) | iCal, reminders, cadence exclude it; history kept for W7/W11/W12 |
| T2 `test-ubst-returning-customer.mjs` (PJL-73/97) | lead with completed spring booking + WO; fall booked three ways: reserve with `leadId`, season Assign for the property, MCP book with `leadId` | spring Booking is `completed` **at WO completion time**, not only when the customer re-books (fails); fall WO carries `bookingId` = fall Booking (fails: field absent); spring record untouched by the fall reschedule | new BK id; fall record links only the fall WO; Today/open-wo pick the fall WO (PJL-97/93 fixes) |
| T3 `test-ubst-crm-wo-binds-one-booking.mjs` (PJL-93) | lead with a closed spring record and a live fall record; property with a live assignment booking and no lead; the Field app's exact `{type, propertyId}` call | property-only `POST /api/work-orders` binds to the live assignment Booking (fails: no link at all, §3.4.1); WO gets `bookingId` (fails); a WO raised against a cancelled assignment booking is refused (fails: guard reads `lead.booking` only); `DELETE /api/work-orders/:id` leaves no dead id on the Booking (fails) | lead path attaches to `recordForLeadBooking` only |
| T4 `test-ubst-completion-reconciles.mjs` (PJL-107) | assignment booking + WO; lead booking + WO | WO → completed ⇒ `booking.status === "completed"`, `completedAt` set, history entry (fails); portal `deriveBookingState().completed` true **without** reading `serviceRecords` (fails by construction today); plan stop reads `done`; cadence sends nothing further; WO cancelled/no_show ⇒ Booking reconciled (fails) | portal header says "season done" via serviceRecords |
| T5 `test-ubst-one-active-rule.mjs` | table: every status × every reader (R1 availability, R2 today, R3 `/api/bookings`+`/api/quotes` as the canvas sees them, R4 plan, R5 portal facts, R8 iCal, R9/R10 sweeps, R16 find-jobs) | each reader's "active" answer equals `holdsItsSlot(status)`; portal `envelopeUpcoming` false for a cancelled future lead booking (fails); job-finder treats `no_show`/`completed` plan stops consistently (fails); lint extended to `server/*.js` front-end copies | lib readers already on the shared rule |
| T6 `test-ubst-idempotent-writers.mjs` | each writer twice, then concurrently | follow-up (W19) twice → one record and no lost update against a concurrent reserve (fails: raw write); Book now twice → one record; PATCH never changes status (fails); a replayed public/admin reserve with the same request id returns the same booking (fails: receipts only honoured for the MCP caller, §3.4.4); `GET /api/bookings?leadId`, portal `reschedule-availability` and `booking-actions` change nothing on disk (fails: §3.4.2); concurrent cancel + cadence step on one record keeps both writes (fails: no store lock, §3.4.6) | reserve receipt replay for the MCP; Assign twice → settled |
| T7 `test-ubst-no-raw-store-writes.mjs` | static | no `bookings.json` path or `fs.writeFile` of the store outside `lib/bookings.js` (fails: `server.js:15305`); no caller of `bookings.remove` outside purge (fails: W5, W6) | — |
| T8 `test-ubst-plan-stop-identity.mjs` (PJL-134) | plan + Assign + Book now; then savePlan/resequence/move/day-move | stop carries `bookingId` after assign and after every plan rewrite (fails: codes only); a stop whose booking is missing is never `unassigned`-bookable by Assign (fails); route rebuild creates no second Booking; move = same Booking id, `rescheduleCount` semantics decided | `drivenPlan` drops cancelled/moved stops |
| T9 `test-ubst-audit-fixtures.mjs` (PJL-137) | one fixture record per audit category (§5.8 + TRD §11) | `node scripts/audit-bookings.mjs --json` reports the expected counts and ids, writes nothing, exits non-zero on critical conflicts (fails: tool does not exist) | — |
| T10 `test-ubst-season-walk.mjs` (the "walk a full season" pass the parallel session proposed, made permanent) | a sanitised copy of production-shaped data on the booted harness: plan import → Assign → blast → customer answers (confirm, cancel, reschedule, window, zones) → Patrick's edits (move, day move, add, Skip, Unassign, delete, Status dropdown) → Today → open WO → complete → invoice → portal → next season re-book | after **every** step, one shared assertion: all readers in §3.2 agree with `holdsItsSlot` for every record, every plan stop has a Booking or a recorded "no", no WO is dated without a Booking, Today's rows equal the plan's driven day, and the audit (T9) reports zero conflicts. Each of tonight's four gaps (#390/#397, #395, #398, #399) is a step in the walk, so this suite would have failed before each of them shipped | — |

Per CLAUDE.md each will be run against the unfixed code first and the failing assertion count
recorded in the test header.

---

## 7. Safest implementation order (recommendation)

The Linear phases are right in content; two re-orderings make them safer:

1. **Phase 0 (this)** — inventory + T1–T9 written and failing.
2. **Phase 1 (PJL-133)** — the contract, all additive: lifecycle ops (`cancel`, `complete`, `noShow`,
   `reschedule`, `linkWorkOrder`, `resolveBookingForWorkOrder`), `update()` refuses `status`,
   `WO.bookingId` field + resolver, `bucket` on every Booking, `remove()` gated to purge.
   Nothing reads differently yet; T5/T7 go green.
3. **Phase 5a (PJL-137, read-only half) — moved up.** The audit is cheap, read-only, and we need its
   numbers before touching the plan or writers (we already know of 57 stale-confirmed, 1 merged, 2
   PATCH-flipped, 1 dangling-WO, 2 test records from a partial look). Dry-run report to Patrick.
4. **Phase 3 (PJL-135) — writers before the plan.** Peter's class of bug is caused by the delete and
   PATCH doors, not by the plan reader. Close W5/W6/W8/W19 first (cancel-with-reason, PATCH refuses
   status, follow-up through the lib), make W7/W11 one op, make reserve create the Booking before the
   envelope. T1 (writer half), T6 go green.
5. **Phase 4 (PJL-136)** — `bookingId` on WOs at creation + backfill via resolver; cascade calls
   `completeBooking`; property-only WO creates/binds a Booking. T2/T3/T4 go green.
6. **Phase 2 (PJL-134)** — plan stop gets `bookingId`; `planStopState` resolves by id; Unassign and
   Book now redefined; outreach touches carry `bookingId`. T8 green, T1 fully green.
7. **Phase 5b** — controlled repair in batches, backup-first, Peter's records first (close
   `BK-2026-0002` as completed/relink its WO; record a cancelled fall Booking for the Oct 1 message so
   the plan stop reads `cancelled`).
8. **Phase 6 (PJL-138)** — cut readers over to Booking: `activeBookings` lead pass, Today lead pass
   and `removedToday`, Schedule canvas (`/api/quotes` union), portal `envelopeUpcoming`/`nextVisit`,
   job finder, notify templates; then retire `lead.booking` as a lifecycle store.

Each step is independently reversible (feature-flag the reader cutovers; writers keep mirroring the
envelope until Phase 6).

---

## 8. Changes to PJL-133 … PJL-138 before coding

* **PJL-133**: add (a) `bookings.update` must reject `status`/`scheduledFor`; (b) `remove()` limited to
  purge + never-messaged records, with `cancelBooking(reason)` as the admin "delete"; (c) `bucket`
  (promised window) on every Booking; (d) `WO.bookingId` is part of the contract here; (e) keep
  `workOrderIds[]` with the same-visit invariant, `primaryWorkOrderId` derived; (f) no "rescheduled"
  status; (g) `standby` decision; (h) a store lock around every bookings.json write (today only
  hold/reserve are locked, §3.4.6); (i) status transition rules (no reviving a dead record); (j) GET
  endpoints must not write (the heal moves to the sweep only).
* **PJL-134**: plan stop stores `bookingId` at assign/Book-now; `planStopState` resolves by id first;
  a missing/terminal booking never returns a stop to Assign-bookable; Unassign → cancel-with-reason (or
  removed); `seasonalOutreach.touches` carry `bookingId`; "Skip this season", a cancelled assignment
  and `declinedThisSeason` collapse into one `seasonAnswer()` read by preflight, unplanned and Book now.
* **PJL-135**: writer list = W2, W4, W5, W6, W7, W8, W9, W11, W12, W14, W15, W16, W17, W19, W23, W28,
  plus the §3.4.7 set (emergency override, WO delete, bulk WO status, property delete, lead
  lost/archive, SMS YES, slotless follow-up) and the three GET-that-write sites (§3.4.2). Every lead
  mirror must resolve the record through `currentRecordForLead` (§3.4.3). Idempotency keys: reserve
  `clientRequestId` sent by **every** caller, not only the MCP (§3.4.4); assign `property+season`;
  Book now `property+season+date`; follow-up `parentWoId+slot`; W8 none (refused). The public
  new-lead reserve path needs a returning-customer resolution rule (§3.4.5) or an explicit decision
  that a second lead is acceptable.
* **PJL-136**: backfill resolver order: `booking.workOrderIds ∋ wo.id` → lead envelope id → same lead,
  same local day, same type → unresolved (manual); cascade reconciles on `completed`, `cancelled` and
  `no_show`; property-only WO must create/bind a Booking; follow-up WO path included; #391 relink.
* **PJL-137**: add the §5.8 categories; machine-readable JSON + human summary; never writes; include
  the numbers already observed (57 / 1 / 2 / 1 / 2) as the first baseline.
* **PJL-138**: reader list = R1 lead pass, R2 lead pass + `removedToday`, R3 canvas, R5 `envelopeUpcoming`
  + `nextVisit` + calendar.ics, R11, R16, R17; definition of done adds "no reader consults
  `lead.booking` for liveness" and "T1–T9 green".

---

## Appendix — production evidence captured (read-only, 2026-10-06)

* `list_bookings status=confirmed 2026-01-01..2026-10-05` → **57** records; all but two carry a WO id;
  `BK-2026-0022` carries two (`WO-PEDFQN32`, `WO-2239YH6P`; created May 20, re-synced Aug 2).
* `list_bookings status=cancelled 2026-10-01..31` → 8; `BK-2026-0132`, `BK-2026-0171` cancelled via
  PATCH (`status:cancelled` by admin, no `cancelledAt`).
* Fall-2026 plan, first ten route days of the dump: 35 stops `on_day`, 2 `unassigned`
  (one is Peter), 6 dropped (5 cancelled, 1 moved).
* Test records in the live store: `BK-2026-0205` (PJL- Test98), `BK-2026-0206` (PJL -Test Test 1,2,3).

# The Assignment Writer — build spec

**Status:** decisions locked 2026-08-31. Building in stages; each stage lands as its own PR
and updates the checklist at the bottom.

The piece the assign-and-confirm conversion exists for: turning a planned stop in the
season plan into a real, dated appointment the customer has been told about — and then
making sure they actually heard.

This document is the contract. When a question comes up mid-build, the answer is either
in here or it gets added in here — never decided silently in code.

---

## Part 1 — Locked decisions

Decided with Patrick, 2026-08-31. Unlisted recommendations were accepted as decided
(his instruction: "consider any recommendations that I don't list here your decisions").

| # | Question | Decision |
|---|----------|----------|
| A | Booking status on assignment | **`confirmed`**, immediately. Shows on the calendar and iCal feed at once. The customer's recourse is the reschedule link (already built, capped at one). Tentative was rejected because `ical-feed.js` excludes tentative bookings — an assigned day would be invisible until people replied, and non-repliers would never appear. |
| B | What silence means | **Silence is consent.** Nobody is un-booked for not replying. Non-responders get the follow-up cadence in Part 2. |
| C | Channels | **Email AND SMS**, on the initial send and on every follow-up. |
| D | The 18 stops without zone counts | **Patrick fills them before the send.** Their durations — and their days' shapes — are guesses until then. |
| E | One blast or per-day | **One blast, at the start of the season (target Sept 10).** Patrick's call, overriding the per-day recommendation. The mitigation for a weather shift is day-move + re-notify (stage 6), not staggered sending. |
| F | What counts as "responded" | **A confirm on their appointment page, a reschedule/cancel there, or a one-tap manual mark in the CRM** (for phone calls and text replies, which the system cannot see — there is no inbound SMS handling and none is being built now). *Refined 2026-08-31 on Patrick's stage-3 review: every message carries ONE `{appointmentLink}` to a single appointment page where the customer decides — confirm, reschedule, or cancel — instead of separate confirm/reschedule links. Two URLs per SMS split each text into extra segments the customer receives as multiple messages.* |
| G | Early-day compression | **Send exactly on schedule.** R1 (Sept 28) non-responders get six messages in 17 days — Sept 10, 13, 18, 21, 23, 27. Patrick chose this over a spacing rule, knowingly. |
| H | The customer's real zone count | *Added 2026-08-31, Patrick's post-launch-review ask: many profiles carry only the booking class for the customer's category, not their actual system.* **The appointment page lets the customer enter their real zone count.** It saves to the property (`system.zoneCount` — the same field Patrick fills by hand); tech-DOCUMENTED zones always win and make the row read-only. The booking's tier follows the real number (serviceKey, label, price bracket, on-site minutes — one shared rule, `pricing.effectiveZoneCount`, now feeds the writer, the shown price AND the sequencer). It is **not** a response — nothing was said about the date — and it never bumps `rescheduleCount`. Patrick is paged only when the count moves the price bracket. |
| I | "No need to contact" customers | *Added 2026-09-01, from the Willowridge hunt: all 14 of their plan stops were skipped as unreachable — their properties carry no contact info because Patrick coordinates with the office directly ("these are non need to contact bookings").* **A property ticked "No need to contact" (property page → communication preferences → `commPrefs.noContactNeeded`) is BOOKED by the assignment writer like anyone else — calendar, day sheet, capacity, sequenced times — and the cadence engine refuses EVERY send for it: no blast, no follow-ups, no D−1 reminder, no day-move notice (one gate, `cadenceGates`, in front of them all; skip reason `no_contact_needed`).** Preflight reports these stops as **ready (silent)**, listed under "Will book WITHOUT messages" so the send arithmetic stays visible. The truck-never-surprises-a-house rule is satisfied by the standing relationship, not by a message. Default off: everyone is contactable until Patrick says otherwise. |

## Part 2 — The cadence

For an appointment on date **D**, initial blast on **B** (target Sept 10):

| Step | When | Who gets it | Message |
|------|------|-------------|---------|
| 1 | B (the blast) | Everyone assigned | **Assignment**: your date and bucket, confirm link, reschedule link. |
| 2 | D − 15 | Non-responders only | **Follow-up**: same information, asks for a confirmation. |
| 3 | D − 10 | Non-responders only | **The nudge** — Patrick's escalation wording (Part 3). |
| 4 | D − 7 | Non-responders only | Same nudge message. |
| 5 | D − 5 | Non-responders only | Same nudge message. |
| 6 | D − 1 | **Everyone**, responded or not | 24-hour reminder, SMS. |
| — | day of | *Stretch, not being built now* | "We're on our way." Parked. |

Steps 1–5 are email + SMS. Step 6 is SMS.

### Cadence rules (the edge cases, answered now rather than in a hotfix)

1. **A step fires at most once, ever.** The record of fired steps lives with the
   booking's assignment state; the sweep is idempotent against it. A double-fired
   step is the worst bug this system can have.
2. **A step whose date is already past when the sweep looks is skipped, not
   backfilled.** Late blast → missed early steps stay missed.
3. **A response at any point stops steps 2–5. Nothing stops step 6** — the 24-hour
   reminder goes to everyone with a live booking.
4. **A portal reschedule counts as a response**, and the cadence re-anchors to the
   new date D′ (already-fired steps stay fired; steps 2–5 stay stopped because a
   reschedule is a response; step 6 fires at D′ − 1).
5. **A cancellation stops everything**, including step 6.
6. **A day moved by Patrick (stage 6) re-anchors the cadence to the new date AND
   resets the response state.** The old confirmation was for the old date; a moved
   day is a new promise needing a new acknowledgment. The re-notify message names
   the change ("was Sept 28, now Oct 1") rather than restating the new date as if
   it were always so.
7. **Send window: 09:00–18:00 America/Toronto.** A step due on a date dispatches the
   first time the sweep runs inside the window on that date. No 3am texts.
8. **Opt-outs are honoured at every step** through the same eligibility checks
   `outreach.sendBulk` applies. An opted-out customer still HAS the booking (it was
   assigned); they just aren't messaged about it, and the preflight says so.
9. **The sweep follows the existing pattern** — `setInterval` in server.js alongside
   the review-request and invoice-SMS sweeps, reading what is due and dispatching.
   No new scheduling infrastructure.

## Part 3 — The nudge message (Patrick's draft, verbatim baseline)

> We have attempted on multiple occasions to check with you about the scheduled
> appointment, unfortunately with no confirmation of appointment, we will continuously
> send texts reminding. We can understand customers needs change, if you are no longer
> requiring our services please ensure that you have informed our booking team,
> otherwise we will continue to make every effort to reach you.

Copy-edited versions go in the stage-3 templates; Patrick has final edit on all
customer-facing wording. The templates carry merge fields for name, street address,
date, bucket, confirm link, reschedule link, and the phone number.

## Part 4 — The stages

Full rationale in the build-plan artifact; this is the working checklist.

| Stage | What ships | State |
|-------|-----------|-------|
| 0 | **Preflight.** Read-only: for every planned stop, "would be told X" or "skipped because Y". Sends nothing, creates nothing. | **done** |
| 1 | **Capacity + season gate.** Bucket caps enforced at booking time; `publicBookingThrough` wired. Touches FLOW-03 (PASS) — re-verify. | **done** |
| 2 | **The assignment record.** Planned stop → `confirmed` booking, `source: "assignment"`. Idempotent, reversible. Sends nothing. | **done** |
| 3 | **The messages.** Templates for steps 1, 2, 3–5, 6. Preview per customer. Patrick edits. | **done** |
| 4 | **The blast + the cadence engine.** `sendBulk` reuse, `type` on touches, the sweep, the response tracking, the manual mark. Test send first. | **done** |
| 5 | **The reply path.** Confirm link (magic token → records response). Reschedule via portal already exists — verify it composes with the geography filter and re-anchoring. | **done** |
| 6 | **Day-move re-notify.** Replaces the hard refusal from PR #87 with move + re-notify + response reset. | **done** |

## Part 5 — Known traps (verified in code, not hypothetical)

- **`ical-feed.js` excludes tentative bookings.** Decision A avoids this; anyone
  revisiting A must re-read that file first.
- **`availability.js` adds a 15-minute buffer between bookings.** Planned stops are
  never buffered. When stage 2 turns a day's stops into real bookings, that day's
  remaining planned stops get measured against buffered bookings — the arithmetic
  changes shape mid-day. Stage 2 must prove a fully-assigned day still sequences
  identically before/after.
- **Stop order feeds `buildDayShapes()`**, so a re-sequence after assignment changes
  what the booking page offers. Known, accepted, recorded in the flow register.
- **Touches have no `type` field** until stage 4 adds one. No assignment send may go
  out before it exists, or those sends are forever indistinguishable from marketing.

## Part 6 — Build log

Newest first. Every stage PR adds its entry.

- *2026-09-01 — DECISION I: "no need to contact" customers. The
  Willowridge hunt's true ending: all 14 stops were skipped as
  unreachable because their properties carry no contact info — by
  design, Patrick works with their office. New property flag
  `commPrefs.noContactNeeded` ("No need to contact" tick on the
  property page, wired through COMM_PREF_KEYS and hydrate() — the
  key-by-key rebuild DELETES unlisted commPrefs keys on the next read,
  the reviewRequestsEmail lesson). Preflight: ready + `silent: true`,
  counted as `readySilent`, listed under "Will book WITHOUT messages".
  Assign: books them like anyone else. Cadence: ONE gate in
  `cadenceGates` (reason `no_contact_needed`) refuses the blast, steps
  2–6, and day-move notices alike, since every send routes through it;
  nothing is ever marked, nothing ever retried noisily. Suites:
  preflight 31, writer 46 (silent books; unassign/idempotency arcs
  include it), cadence 45 (skipped at blast by name; zero step marks
  after the full arc incl. D−1).*

- *2026-08-31 — THE PREFLIGHT NOW NAMES THE NO-ZONE STOPS (decision D's
  blind spot). Patrick asked "what properties are on this
  no_zone_count??" — and the answer wasn't on any screen: only assign()
  checked zone counts, so Check-the-plan called those stops ready and
  the skip happened later, out of sight. `preflight()` now runs the
  same `zoneCountFor` gate and lists each affected stop under "Would be
  skipped — fix or accept before sending", with the address LINKED to
  the property record (`/admin/property/<id>`) where the count is
  filled in — the skip list in the assign result links the same way
  (rows now carry `propertyId`). assign() keeps its own check as the
  belt-and-suspenders (a count could vanish between the two reads).
  Writer suite 45 (+3: preflight flags no_zone_count, rows carry
  propertyId, a declared count still preflights ready).*

- *2026-08-31 — DECISION H: the customer's real zone count, from their
  page. Patrick's ask after the launch review: profiles often hold only
  the booking class for the customer's category, so the appointment page
  grew a "Your system" row — the count we hold, and (while no zones are
  tech-documented) an "Update my zone count" door: a 1–50 select, saved
  by `POST /api/appointment/:token/zones` → `appointmentActions.setZones`.
  The count lands on the PROPERTY (`system.zoneCount`); the booking's
  tier re-derives through the same `deriveSeasonalKey` the writer booked
  with (key, label, durationMinutes), the sequenced times re-anchor in
  the background when the bracket moved, and Patrick is paged on a
  bracket move only. NOT a response; no `rescheduleCount` bump;
  documented zones refuse the edit outright. UNDERLYING FIX shipped with
  it: the zone-count precedence (documented wins, declared fills in) now
  lives ONCE in `pricing.effectiveZoneCount` — `resolveSeasonalPrice`
  (the shown price, the {price} merge field) and
  `resequence.onSiteMinutes` (planned on-site time) previously counted
  ONLY documented zones, so a declared count booked the right tier but
  showed the lowest-bracket price and was sequenced at the smallest
  service minutes. All three consumers now read the same number.
  `test-appointment-page.mjs` grows to 44 assertions; the page smoke to
  9; pricing 195, resequence 39, writer 42, day-reschedule 59 all pass
  unchanged.*

- *2026-08-31 — STAGE 6 SHIPPED. THE CONTRACT IS COMPLETE. Moving a
  route day now takes its assignment bookings with it:
  `assignments.moveDayBookings` (after `seasonPlans.moveDay`) re-dates
  each booking to its NEW sequenced arrival, RESETS response state
  (cadence rule 6 — the old confirmation was for the old date; the old
  answer is stashed in history, never lost), and queues a day-move
  notice that NAMES THE CHANGE ("was {oldDate}, now {date}" — new
  daymove_email/daymove_sms templates, editable like the rest). The
  cadence sweep dispatches the notice once, inside the send window,
  mark-before-send like the numbered steps; a notice that hasn't gone
  out yet keeps its ORIGINAL old date through further moves.*
  *DECIDED HERE, PER THE CONTRACT: (a) the day move does NOT bump
  rescheduleCount — it is plan steering, so the customer keeps their one
  self-serve move and the time sweep keeps steering the record; (b)
  FREE-BUCKET customers move silently and keep their answer — they said
  "any day works" and the tech calls them regardless; (c) an UNMESSAGED
  booking moves with no notice — no promise was broken; (d) a booking
  the customer moved off the day themselves is theirs and is not
  touched; (e) what still refuses a move is a NON-assignment booking on
  the day (a lead-backed appointment the customer made) — the writer has
  no standing to move those, so Patrick reschedules them from the
  calendar (which notifies) first. The season-plans STORE is untouched
  — its guard still takes the caller's count; the caller now counts
  only non-assignment bookings (test-day-reschedule's 59 unchanged).
  Cadence suite grows to 42 assertions (the whole move → reset → queue →
  once-ever dispatch → new-D−1 reminder arc); messages to 77 (rule-6
  wording pinned, two-segment budget with both dates spelled out).*
- *2026-08-31 — THE LIVE-REVIEW BATCH (Patrick walked Nishka's page).
  Eight changes, all his: (1) the page addresses the customer by FULL
  NAME — it's a private link; (2) the customer's PRICE shows on the page
  and rides into the email as a new {price} merge field —
  `resolveSeasonalPrice`: profile override first, tier price otherwise;
  (3) the assignment email default is now HIS routing-efficiency pitch
  (dedicated routes, same service without raising prices, move only if
  no one can be home), and the SAME pitch sits on the page so a
  text-first customer gets the story too; (4) RESCHEDULE POLICY:
  geography filter OFF for customer moves (an off-route stop is an
  end-of-day addition), AFTERNOON (12–5) ONLY, horizon = the whole
  remaining season (capacity + conflicts still gate); (5) THE FREE
  BUCKET: a customer who's normally home joins the flexible pool — the
  booking keeps its anchor date (still counts against capacity;
  conservative), self-serve moves end, Patrick places it and the tech
  calls with an ETA; counts as a response; Patrick is paged; (6)
  CUSTOMER TIME WINDOWS: after/before on the page, stored on the
  booking, fed into the sequencer's requestedWindows seam at EVERY
  clock (assign, time sync, plan screen, map, route line, stored-order
  resequence) — the seam built in the windows PR finally has its
  intended caller; counts as a response and re-anchors times; (7)
  CANCEL AND FREE-BUCKET NOTIFY PATRICK (his review question "are we
  notified?" — now yes, same paging as reschedules); (8) RESPONSE STATE
  IS VISIBLE: the schedule's manage panel reads the booking back —
  "confirmed via their link Sept 3", "FREE BUCKET", "messaged — no
  response yet", the customer's window — which is the concrete answer
  to "when the customer confirms, where does this information go?".
  Suites: appointment 31, writer 42 (seam pass-through proven),
  messages 64; both page smokes re-run green.*
- *2026-08-31 — STAGE 5 SHIPPED, AND THE INTERLOCK IS OPEN. /a/<token>
  is live: one public, token-addressed page (`server/appointment.html`,
  actions in `server/lib/appointment-actions.js`) with the one-link
  decision's three choices — CONFIRM (records the response, idempotent,
  first answer kept), PICK A DIFFERENT DAY, and CANCEL. Reschedule
  reuses the shared `rescheduleBooking`/`rescheduleAvailability` helpers
  — the same `listAvailableSlots` + dayShapes path the portal uses — so
  a customer's move COMPOSES with the geography filter, the season
  window and the bucket-capacity gate by construction, and re-anchors
  the cadence automatically (rule 4 reads scheduledFor live). Gates,
  portal parity: changes blocked inside 24 hours (phone number offered
  instead), one customer reschedule ever, cancel keeps the reason and
  stops everything. `APPOINTMENT_PAGE_READY` flipped true in the same
  commit, per the stage-4 contract; test-sends for a real booking now
  mint the real token so Patrick can tap through his own [TEST] text.*
  *FIXED IN PASSING, register-recorded: the reschedule self-exclusion
  filter matched on leadId, and for a lead-less booking (leadId null)
  that silently dropped EVERY assignment booking from the conflict
  math — lead-less bookings now match by canonical id. Patrick is paged
  on customer-driven reschedules of lead-less bookings too (the alias
  builds from the booking record). 21 assertions in
  `scripts/test-appointment-page.mjs` — including confirm-stops-2-to-5 /
  nothing-stops-6 / cancel-stops-all proven THROUGH the real cadence
  engine — plus a 5-assertion Playwright smoke of the page at iPhone
  size. Stage 6 (day-move re-notify) is the one stage left.*
- *2026-08-31 — STAGE 4 SHIPPED. `server/lib/assignment-cadence.js`:
  blast (admin button, two-press) + the seventh server sweep (5 min)
  dispatching steps 2–6. All nine Part-2 rules implemented literally
  and asserted BY NAME in `scripts/test-assignment-cadence.mjs` (29
  assertions, real stores, only the wire injected). Touches now carry
  `type: "assignment"` + `step` (the stage-4 field; additive — the
  consent suite passes unchanged). Response state lives on
  `booking.assignment.outreach` (token, blastAt, steps, respondedAt);
  the one-tap manual mark is on the schedule's manage panel; per-
  template [TEST] sends go to NOTIFY_TO_EMAIL/PHONE from the messages
  page (saved wording only). Channel senders are notify-customer's own
  outreach paths (branded email + Twilio SMS with the STOP line).*
  *DECIDED HERE, PER THE CONTRACT: (a) THE STAGE-5 INTERLOCK — every
  message links /a/<token>; until that page exists a blast would text
  dead URLs, so blast and sweep refuse while server.js's
  APPOINTMENT_PAGE_READY is false; stage 5 flips it in the same commit
  that builds the page. (b) MARK BEFORE SEND: a step is recorded fired
  before dispatch — a crash or wire failure loses at most one message
  (recorded on the step, visible, retryable by hand) and can never
  repeat one; the spec's worst bug is structurally impossible. (c)
  STEP-6 EMAIL FALLBACK: a customer with no usable SMS gets the 24-hour
  reminder by email — a reminder they can't receive helps nobody. (d) A
  re-pressed blast reaches only never-blasted bookings, so stops
  assigned after the blast get their step 1 on the next press. (e)
  Opt-outs re-checked at EVERY step through the shared capability
  checks — an opt-out placed mid-cadence stops everything after it.*
- *2026-08-31 — ONE LINK, Patrick's stage-3 review call: "should all link
  to one thing (their portal?) and in that portal they then decide."
  `{confirmLink}`/`{rescheduleLink}` are replaced by a single
  `{appointmentLink}`; every asking message carries exactly one, the
  24-hour reminder carries none, and the suite now asserts a SEGMENT
  BUDGET — every SMS rendered with a realistic URL fits in at most two
  segments, so no step arrives as a pile of split texts. Decision F
  refined accordingly. STAGE 5 SIMPLIFIES: instead of a separate
  confirm endpoint composing with the existing reschedule flow, it
  builds one token-addressed appointment page with Confirm / Reschedule
  / Cancel in one place — confirm records the response; reschedule and
  cancel run the existing portal machinery. Suite: 59 assertions.*
- *2026-08-31 — STAGE 3 SHIPPED. `server/lib/assignment-messages.js` +
  /admin/assignment-messages (linked from the season-plan Assignment
  panel). Seven templates — email+SMS for the assignment, the follow-up
  and the nudge, SMS-only for the 24-hour reminder — with per-customer
  preview against real assignment bookings. Defaults in code, Patrick's
  edits layered in `server/data/assignment-templates.json` (persistent
  disk, survive deploys; clearing falls back to the default), saving is
  ADMIN-only per decision-table "Patrick has final edit". The nudge
  default is his Part-3 wording copy-edited with intent preserved
  (asserted: reminders continue / tell the booking team / every effort
  to reach you). SENDS NOTHING — asserted like the writer.*
  *RULES THE SEND STEP INHERITS: (a) merge fields are a CLOSED set and a
  template referencing an unknown {field} is refused at save, so a typo
  can never render literally in a customer's text; (b) {appointmentLink}
  renders as a loud [appointment-link] placeholder until stages 4–5
  supply real URLs, and STAGE 4 MUST REFUSE to send any message still
  containing a bracketed placeholder; (c) every asking message carries
  exactly one link, the 24-hour reminder carries none (it goes to
  everyone) — see the one-link entry above. 48 assertions
  in `scripts/test-assignment-messages.mjs` + an 8-assertion Playwright
  smoke of the editor page (editors render, legend complete, preview
  fills, save round-trips).*
- *2026-08-31 — TIME SYNC BECOMES A SWEEP. The sequenced-arrival revision
  deployed but live records still read 8:00/12:00 — the re-anchor needed
  a trigger (Assign press post-deploy, or a plan edit) that never fired.
  `syncAssignedTimes` now runs as the server's sixth sweep (boot + every
  10 min, both current-year seasons), so times converge with NO operator
  action; steady state writes nothing. LESSON, spec rule 9 vindicated:
  anything that must reach a state should be swept there, not left to a
  human-triggered code path — the cadence engine (stage 4) was already
  specified this way and now has a sixth precedent.*
- *2026-08-31 — STAGE 2 REVISION, from Patrick's third live find: the
  calendar said every afternoon stop ran at 12:00 while the plan's route
  sequenced them 12:53 / 13:33 / 14:13 — and same-start ties drew in
  REVERSE run order (the booking store is newest-first). The bucket-open
  decision in the original stage-2 log is SUPERSEDED: `scheduledFor` is
  now the stop's SEQUENCED ARRIVAL from `resequence.sequenceDay`
  (clamped inside its bucket so an overrun morning stop can't leak into
  afternoon capacity attribution; bucket-open fallback when a day can't
  sequence). Because arrivals move when the plan changes,
  `syncAssignedTimes()` re-anchors PRISTINE records (confirmed, never
  rescheduled, no WO, date still in the plan) after every reorder /
  back-to-automatic / time-window edit, and at the end of every assign
  run — so pressing Assign again repairs times without creating
  anything. A record a human touched is never dragged back to the route.
  Customers still only ever see the bucket label. Suite grows to 41
  assertions: sequenced/fallback/clamped starts, re-anchor on plan edit,
  no-op re-sync, and a rescheduled booking left where the customer put
  it.*
- *2026-08-31 — STAGE 2 DEFECT #2, also found by Patrick live: same-start
  bookings drew as one pile on the schedule calendar — only the first
  morning and first afternoon card visible, because every stop in a
  bucket carries the bucket-open time and the grid positioned purely by
  time. The day/week grid now lays out as a waterfall (cards anchor to
  their time, never overlap). The two live finds together sharpen the
  stage-2 lesson: bucket-time bookings break TWO assumptions in
  lead-era surfaces — "every appointment has a lead" and "no two
  appointments share a start time." Both are now register-recorded
  checks for every future surface.*
- *2026-08-31 — STAGE 2 DEFECT, found by Patrick on the live run: assigned
  bookings appeared on /admin/bookings but not on the /admin/schedule
  calendar or the tech day sheet — both surfaces predate property-first
  bookings and mapped only `lead.booking`. Fixed with the same
  leadId+start union rule `activeBookings()` uses; the calendar's manage
  panel now works off the canonical booking id for lead-less records
  (Reschedule hidden — moving an assigned stop is the season plan's
  day-move flow). Verified in a Playwright harness, 7 assertions. LESSON
  for later stages: any surface that renders appointments must be checked
  against LEAD-LESS bookings, not just lead-backed ones — the register
  entry lists which surfaces have been checked.*
- *2026-08-31 — STAGE 2 SHIPPED. `assign()` / `unassign()` in
  `server/lib/assignments.js`, `POST /api/assignments/:season/:year/assign`
  + `/unassign` (ADMIN only — techs can preflight, not assign), and
  two-press-armed Assign / Undo buttons on the season-plan panel.
  THE VERDICTS ARE STILL THE PREFLIGHT'S: assign() runs preflight() first
  and books only rows it called ready, so the screen Patrick reviewed is
  by construction what the button does. Bookings are property-first
  canonical records (`bookings.createDirect`) — `source: "assignment"`,
  propertyId-linked, NO lead — the path `activeBookings()` and the iCal
  feed were already prepared for. SENDS NOTHING (asserted: the module
  requires no notify/mailer/sms and never calls sendBulk).*
  *DECIDED HERE, PER THE CONTRACT: (a) `scheduledFor` is the BUCKET OPEN
  (08:00 / 12:00 local) and `durationMinutes` is the SERVICE minutes, not
  the bucket span — a full-bucket record would physically close assigned
  days to the new customers the geography filter exists to admit; the
  plan screen stays the timeline of record and customers only ever see
  the bucket label. (b) Only preflight-READY stops book: an unreachable
  (no-contact) customer is NOT booked — a truck must never surprise a
  house. (c) Service tier = `deriveSeasonalKey(zones, accountType)`;
  documented zones win over the manual count; NO zone count → skip
  `no_zone_count` (decision D: Patrick fills them, then re-runs — a
  re-run only picks up the newly fillable stops). (d) ONCE EVER per
  property per season: a property with ANY prior assignment booking —
  including a CANCELLED one — is never auto-booked again
  (`assignment_declined`); a cancellation is a customer's answer and a
  re-run must not overrule it. (e) `unassign` hard-deletes only pristine
  records (confirmed, never rescheduled, no work order); anything a
  human or customer touched is kept and listed. (f) A property planned
  on two days books once (`duplicate_in_plan`).*
  *THE PART-5 BUFFER TRAP, PROVEN: a fully-assigned day's `buildDayShapes`
  points and bucket loads are byte-identical before/after assignment
  (pointKey dedup), a below-cap assigned bucket still offers slots to new
  customers, and an at-cap bucket is closed. 34 assertions in
  `scripts/test-assignment-writer.mjs`, sandbox-copied modules so the
  REAL `createDirect` → REAL `deriveBookingState` loop proves idempotency
  end to end (second run creates zero) with no data file touched.*
- *2026-08-31 — STAGE 1 SHIPPED. Bucket capacity + season gate, both inside
  `availability.js listAvailableSlots()` — the engine every submission path
  re-validates through, so gating it gates submission (admin custom-time
  bypasses by design). `geo-filter.buildDayShapes()` now emits per-bucket
  load (`buckets.morning/afternoon = { count, keys }`): `count` is EVERY
  planned code, unresolved included — an unresolved stop is still a job —
  and `keys` are the resolved stops' rounded coordinates so a planned
  customer's own booking, or their own booking attempt, is never charged
  twice. The season gate reads `seasons.configFor()`'s public booking
  window — `publicBookingFrom` to `publicBookingThrough` (fall 2026:
  Sep 28 to Oct 30) — for the two seasonal families only, and FAILS SOFT —
  a broken seasons.json degrades to ungated availability rather than taking
  the booking page down. Both gates switch off by the data's absence:
  byte-identical slots with no shape / no cap / a pre-stage-1 shape,
  asserted against a baseline in `scripts/test-booking-guards.mjs` (35
  assertions). FLOW-03 re-verified (register row dated 2026-08-31);
  `test-geo-availability.mjs`'s 27 assertions unchanged.*
  *DECIDED HERE, PER THE CONTRACT: (a) the front of the season is gated by
  a new OPTIONAL `publicBookingFrom` in seasons.json — Patrick's ask, same
  day: "the customer also can't book before September 28th." Fall 2026
  opens Sep 28 (the first planned route day); absent, the field defaults
  to `serviceableFrom`, so spring and the defaults are unchanged. (The
  first build shipped `publicBookingThrough` only, per the spec's letter;
  Patrick named the front gate on review and it landed in the same PR.)
  (b) A booking is assigned to the morning bucket when it starts before
  the afternoon bucket opens (noon), else the afternoon — so an
  admin-custom 7 AM job still consumes morning capacity. (c) Suppressed
  days surface as `diagnostics.bucketFull` / `diagnostics.seasonClosed`
  (naming the bound that was hit), and a season-gated day carries day
  reason `season_not_open` or `season_closed` (informational, like
  `outside_route_area` — no customer copy consumes them yet; candidate
  for the stage-3 wording pass: "booking opens Sep 28" beats an empty
  calendar).*
- *2026-08-31 — STAGE 0 SHIPPED. `server/lib/assignments.js` preflight +
  `GET /api/assignments/:season/:year/preflight` + a panel on /admin/season-plan.
  The eligibility gauntlet was EXTRACTED from `outreach.sendBulk` into shared
  `assessEligibility` / `channelCapability` and sendBulk rewired onto them, so the
  preflight runs the send's own rules and cannot drift — the consent (43) and
  handoff (669) suites passed the refactor unchanged. One assignment-specific
  verdict: `already_booked` reports as SETTLED, not skipped — a customer who booked
  themselves needs nothing from the writer. Partial-channel customers (email-only /
  text-only) are counted and listed so a "55 ready" headline cannot hide people who
  will miss the SMS half of the cadence. 28 assertions in
  `scripts/test-assignment-preflight.mjs`, fixtures injected, no data files touched.*
- *2026-08-31 — spec written; decisions A–G locked with Patrick.*

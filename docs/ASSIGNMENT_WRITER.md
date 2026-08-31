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
| F | What counts as "responded" | **A confirm-link click, a portal reschedule/cancel, or a one-tap manual mark in the CRM** (for phone calls and text replies, which the system cannot see — there is no inbound SMS handling and none is being built now). |
| G | Early-day compression | **Send exactly on schedule.** R1 (Sept 28) non-responders get six messages in 17 days — Sept 10, 13, 18, 21, 23, 27. Patrick chose this over a spacing rule, knowingly. |

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
| 3 | **The messages.** Templates for steps 1, 2, 3–5, 6. Preview per customer. Patrick edits. | |
| 4 | **The blast + the cadence engine.** `sendBulk` reuse, `type` on touches, the sweep, the response tracking, the manual mark. Test send first. | |
| 5 | **The reply path.** Confirm link (magic token → records response). Reschedule via portal already exists — verify it composes with the geography filter and re-anchoring. | |
| 6 | **Day-move re-notify.** Replaces the hard refusal from PR #87 with move + re-notify + response reset. | |

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

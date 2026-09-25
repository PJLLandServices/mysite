# Booking Confirmation & Text Replies — Technical Requirements

**Status:** DRAFT, awaiting Patrick's approval of the PRD. Nothing built yet.
**Opened:** 2026-09-25
**PRD:** `docs/BOOKING_CONFIRMATION_PRD.md`
**Touches flows in:** `docs/FLOW_REGISTER.md` → assignment writer stage 5
(appointment page), assignment cadence, Twilio voice webhooks (pattern only).

---

## 0. Findings (root cause, reproduced)

### 0.1 Confirm "doesn't work" — a CSS `[hidden]` override

Reproduced 2026-09-25 against a local copy of `HEAD` with a seeded assignment
booking, Playwright, iPhone 13 viewport (390×664):

```
GET  /api/appointment/<token>          -> 200
POST /api/appointment/<token>/confirm  -> 200   (respondedAt stamped)
#confirmBtn after click: still rendered, same position
#badge "Confirmed — you're all set": y = -421 (off-screen, above viewport)
```

- `server/appointment.js` `render()` toggles visibility with the `hidden`
  attribute (`el("confirmBtn").hidden = true`, `badge.hidden`, `cancelBtn`,
  `rescheduleBtn`, `windowBtn`, `cancelToReschedule`, `zonesBtn` …).
- `server/appointment.css:85` sets `.ap-btn { display: block; … }` and
  `.ap-badge { display: inline-block; … }`. An author `display` rule beats the
  UA stylesheet's `[hidden] { display: none }`, so **nothing with those
  classes ever hides**.
- Every other customer/CRM stylesheet (`portal.css:3`, `crm.css`, `pay.css`,
  `work-order.css` … 22 files) carries the polyfill
  `[hidden] { display: none !important; }`. `appointment.css` does not.
- Server side is correct: `appointmentActions.confirm()` →
  `bookings.markAssignmentResponded()` saves. So the customers who "failed"
  are very likely recorded as responded (`assignment.outreach.responseVia:
  "confirm"`). Verify from the booking history once Patrick names them.

Collateral from the same bug:
- Empty `.ap-badge` pill renders on every load (visible in the "before"
  screenshot under "Hi {name}").
- Inside the 24 h cutoff, Cancel / Pick a different day / Set timing stay
  visible and answer 409 "call us" — a second "it doesn't work" path.
- Error path: `fail()` hides `#details` — unaffected (not an `.ap-btn`).

### 0.2 Replies to the 647 number go nowhere

- Outbound SMS: `server/lib/notify-sms.js`, `From: TWILIO_FROM_NUMBER` (647).
- Inbound voice is handled (`/api/twilio-voice-incoming` → voicemail → SMS
  to `NOTIFY_TO_PHONE`, `server/server.js` ~6705). Its comment says it
  "does NOT touch the SMS Messaging webhook".
- **No inbound SMS route exists.** `grep -i twiml|sms-incoming` finds only
  the voice routes. `PJL_OPERATIONS_DESIGN.md:292` lists "Twilio inbound
  texts — Low priority for now".
- Every assignment template invites a reply by shape (it's a text) but only
  says "Questions? {phone}".

---

## 1. Phase 1 — Appointment page hotfix

### 1.1 Changes

| File | Change |
|---|---|
| `server/appointment.css` | Add at top: `[hidden] { display: none !important; }` with the same rationale comment as `portal.css`. |
| `server/appointment.html` | Add a success panel near the actions: `<div id="confirmedNote" class="ap-confirmed" role="status" aria-live="polite" hidden>` — "✓ You're confirmed for {date} ({bucket})". |
| `server/appointment.js` | On confirm success: `render()`, then show `#confirmedNote` and `scrollIntoView({ block: "center", behavior: "smooth" })` + move focus to it. Same treatment for free-bucket / time-window / reschedule success (they share the "badge off-screen" problem). |
| `server/lib/assignment-cadence.js` | `ctaLabel: "Confirm or change my appointment"` (two call sites: step send ~L414, day-move ~L535). Plain-text fallback in `notify-customer.js` `sendOutreachEmail` should print the same label instead of the hard-coded "Open your portal:". |

No server/API behaviour changes. `summarize()`'s `can*` flags already say
the right thing; the page simply starts obeying them.

### 1.2 Test (must fail on old code — CLAUDE.md rule 4)

`scripts/test-appointment-page-ui.mjs` (Playwright, chromium at
`/opt/pw-browsers/chromium`), boots `server/server.js` on a sandbox copy with a
seeded assignment booking (pattern: `scripts/test-appointment-page.mjs`
sandbox + `ensureToken`):

1. Open `/a/<token>` at 390×664. Assert `#badge` is **not visible** (empty
   pill gone).
2. Click `#confirmBtn`. Assert `#confirmBtn` **not visible**; `#confirmedNote`
   visible **and inside the viewport** (`boundingBox().y` between 0 and
   viewport height).
3. Reload. Assert "Confirmed — you're all set" visible, no Confirm button.
4. Seed a booking 12 h out. Assert `#cancelBtn`, `#rescheduleBtn`,
   `#windowBtn` **not visible**.

Run against unfixed `HEAD` first; assertions 1, 2 and 4 must fail. Add to
`build:check`.

Also add a lint (`scripts/lint-hidden-polyfill.mjs`, in `build:check`): every
`server/*.css` linked from a page whose JS assigns `.hidden =` must contain the
`[hidden]` polyfill. This is the class of bug, not just this instance.

### 1.3 Data check for the two customers

Read-only: find their bookings, print `assignment.outreach.respondedAt`,
`responseVia`, `seenAt`, and the `history[]` entries
`appointment_opened` / `assignment_responded`. If responded → nothing to do.
If not → Patrick marks them confirmed from the Season Plan.

---

## 2. Phase 2 — Inbound SMS webhook (forward + auto-reply)

### 2.1 Route

`POST /api/twilio-sms-incoming` in `server/server.js`, placed beside the voice
routes. Public (Twilio → server), gated by the existing
`allowTwilioWebhook(req, pathname, params, "sms-incoming")` (X-Twilio-Signature
in production). Body via `parseFormBody`. Responds with TwiML via `sendTwiml`:
`<Response/>` (no reply) or `<Response><Message>…</Message></Response>`.

Twilio params used: `From`, `To`, `Body`, `MessageSid`, `NumMedia`,
`MediaUrl0..n`.

### 2.2 New module `server/lib/sms-inbound.js` (pure, dependency-injected)

```
classify(body) -> "stop" | "start" | "help" | "yes" | "other"
matchSender(fromE164, { listBookings, listProperties, now })
  -> { bookings: [live future assignment bookings for that phone],
       property, customerName }
handleInbound({ from, body, messageSid, media }, deps)
  -> { reply: string|null, actions: [...], forward: {...}|null }
```

- **Phone match:** normalise both sides to the last 10 digits. Candidate
  bookings = `source === "assignment"`, `bookingHoldsItsSlot(status)` (the
  shared live-status rule — do **not** re-test `status === "confirmed"`
  inline), `scheduledFor > now`.
- **Keywords:** `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT` → "stop";
  `START, UNSTOP` → "start"; `HELP, INFO` → "help"; after trimming
  punctuation/emoji-variation selectors: `YES, Y, YEP, YEAH, CONFIRM,
  CONFIRMED, OK, OKAY, 👍, ✅` → "yes". Everything else → "other".
  Note `CANCEL` is a carrier opt-out keyword; it must **not** cancel an
  appointment.

### 2.3 Behaviour table

| class | Reply (TwiML) | Side effects |
|---|---|---|
| stop | none (Twilio Advanced Opt-Out already replies and blocks) | property `commPrefs.seasonalRemindersSMS = false` (via `properties.update`, history note "texted STOP"); notify Patrick |
| start | none (Twilio replies) | notify Patrick only; do **not** auto-flip consent back on |
| help | "PJL Land Services automated line. Call or text (905) 960-0181." | none |
| yes, 1 match, not yet responded | Phase 3 only (see §3). In Phase 2 treat as "other". | — |
| other | Auto-reply (rate-limited, §2.4) | forward to Patrick |

Auto-reply text (Patrick to approve):
> PJL Land Services: this number is automated and not monitored. We've sent
> your message to Patrick — for a faster answer call or text (905) 960-0181.

### 2.4 Guards

- **Auto-reply rate limit:** at most one auto-reply per `From` per 12 h
  (prevents auto-responder ping-pong and repeated noise). Forwarding to
  Patrick is **not** rate-limited.
- **Idempotency:** Twilio retries on non-2xx/timeouts. Dedupe on `MessageSid`
  (last 500 SIDs kept in the store). Respond within Twilio's 15 s — forward
  sends are fire-and-forget (`Promise.allSettled`, same as voicemail).
- **Privacy:** an unknown number gets only the generic reply — never a name,
  address or date.
- **Store:** `server/data/sms-inbound.json` via `lib/atomic-json.js`:
  `{ id, messageSid, from, body, media[], receivedAt, class, matchedBookingIds,
  propertyId, autoReplied, forwarded, action }`. Not committed (data dir).

### 2.5 Forward to Patrick

- SMS to `NOTIFY_TO_PHONE` (reuse the `notify-sms.js` send helper the
  voicemail alert uses):
  `Text to PJL auto line from Kristen Holmes (90 Oriole Dr, fall Oct 8 AM): "Can you come Tuesday?" Reply to them: +1905…`
  Unknown sender → `from +1647…` instead of the name.
- Email via `notify-email.js` with full body, media links, and "Open in CRM"
  link to the booking/property.

### 2.6 Twilio console (one-time, Patrick or Claude-with-approval)

Phone Numbers → 647 number → Messaging configuration → "A message comes in"
→ Webhook `https://www.pjllandservices.com/api/twilio-sms-incoming`, HTTP
POST. Note: use the exact host `twilioWebhookBase()` expects, or the signature
check fails (the apex 301-redirects to `www`, and Twilio does not follow
redirects on POST). If the number sits in a Messaging Service, the webhook is
set on the Service instead.

### 2.7 Tests — `scripts/test-sms-inbound.mjs` (in `build:check`)

Unit on `sms-inbound.js` with injected deps: keyword table (incl. "CANCEL"
never cancels a booking), phone normalisation (`+1 (905) 555-0100` ≡
`9055550100`), unknown sender reply leaks nothing, rate limit, MessageSid
dedupe, STOP flips `seasonalRemindersSMS`. Route-level: bad signature → 403 in
production mode.

---

## 3. Phase 3 — Reply YES to confirm

### 3.1 Behaviour

`class === "yes"` and **exactly one** candidate booking:

- Not yet responded → `bookings.markAssignmentResponded(id, { via: "sms_reply",
  by: "customer" })` — the **same** function the page's Confirm uses, so the
  cadence (steps 2–5 stop, step 6 24 h reminder still goes), the Season Plan
  "responded" marker and the page badge all agree with no new state test.
  Reply: `Thanks {firstName} — you're confirmed for {date} ({bucket}). Anything else? Call or text (905) 960-0181.`
- Already responded → same reply, no write (`markAssignmentResponded` keeps
  the first answer anyway).
- Zero or ≥2 candidates → "other" path (forward + generic reply). Never guess.

Patrick is **not** pinged for a clean YES (that's the point), but it is logged
in the store and shown in Phase 4.

### 3.2 Lifecycle walk (CLAUDE.md "finish the workflow")

| Reader | Effect of `respondedAt` via `sms_reply` |
|---|---|
| `assignment-cadence.sweepDue` | skips steps 2–5 (already keyed on `respondedAt`) |
| 24 h reminder (step 6) | unchanged — still sends |
| `appointment-actions.summarize` | state `responded`; badge needs a `respondedVia === "sms_reply"` label → "Confirmed by text — you're all set" |
| Season Plan / cadence panel | shows responded; add "by text" to the via label map |
| Calendar, route, capacity | untouched — confirming never moves a slot |
| Work order / invoice / property | untouched |
| Audit | booking `history[]` gets `assignment_responded` "via sms_reply"; store row keeps the raw text |

Grep `responseVia` for every label map and add `sms_reply` to each.

### 3.3 Template wording

Update `DEFAULT_TEMPLATES` in `server/lib/assignment-messages.js`
(`assignment_sms`, `followup_sms`, `nudge_sms`, `daymove_sms`,
`reminder24_sms`) and the service-track SMS in `notify-customer.js` to carry:
`Reply YES to confirm or tap to change: {appointmentLink}` and
`Automated number — to talk to us call/text {phone}.` Keep each under
2 GSM-7 segments (306 chars) with a realistic street/date; add a length
assertion to `scripts/test-assignment-messages.mjs`. Avoid emoji/“smart
quotes” in SMS defaults (forces UCS-2, 70-char segments).

**Caveat:** Patrick's saved overrides in `server/data/assignment-templates.json`
win over defaults. Check the live overrides; if present, Patrick re-saves them
on the Assignment Messages page with the new wording.

`reminder24_sms` should **not** say "Reply YES" (nothing to confirm by then if
already responded); it gets only the "automated number" line.

---

## 4. Phase 4 (optional) — Texts in the CRM Messages page

Surface `sms-inbound.json` rows on `/admin/messages` as SMS threads beside
portal threads, keyed by property. Reply-from-CRM sends via Twilio from the
647 number. Out of scope until Patrick asks.

---

## 5. Alternatives considered

| Option | Why not (now) |
|---|---|
| Just reword the texts ("don't reply") | Helps some; people reply to texts anyway. Doesn't fix silence. |
| Send texts from Patrick's 905 (Telus) number | Needs the 905 number's texting hosted on Twilio (hosted SMS/porting). Patrick's personal texting would then live in an app, not his phone. Big change; revisit later. |
| One-tap confirm link in the email (GET confirms) | Email link scanners (Outlook Safe Links, Gmail) pre-open links and would confirm on the customer's behalf. Confirm must stay a POST behind a tap. |
| Forward only, no auto-confirm | Valid if Patrick answers PRD Q3 "see each one first" — Phase 3 is then skipped. |

## 6. Rollout

1. Phase 1 on its own PR → Patrick says "go live" → merge to `main` → Render
   deploys. Verify on a real phone with a test booking.
2. Phase 2 PR → merge → Twilio webhook set → Patrick texts the 647 number from
   his phone and sees the forward + auto-reply.
3. Phase 3 PR → merge → Patrick re-saves template overrides if any.
4. Add each flow to `docs/FLOW_REGISTER.md` with its acceptance test.

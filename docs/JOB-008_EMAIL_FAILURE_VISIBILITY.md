# JOB-008 — Email failure visibility (INF-02 phase one)

**Flows touched:** INF (outbound email) · FLOW-01 hop 5 (magic-link send — logging only) ·
FLOW-23-adjacent (receipt send — **log line only**, invariants in `docs/HANDOFF_STRIPE_PAYMENTS.md` §6 apply)
**Defect addressed:** INF-02 (High) — phase one of two. Phase two (send-as alias / INF-01,
transport resilience) is deliberately out of scope.
**Prerequisite:** read `docs/FLOW_REGISTER.md` and the 2026-08-03 send-path audit before starting.

---

## The problem

Audited 2026-08-03: 24 send sites, 5 modules. Interactive sends (invoice, PO/RFQ) surface
failures to the admin UI. Every **automated customer-facing send** — magic-link logins,
stage-transition notices, completion notices, booking cancellations, portal replies, review
asks — fails with a single `console.*` line in Render's ephemeral logs and no other footprint.
No retries anywhere. No aggregate view anywhere.

Worst single path: `sendCustomerLoginLink` **returns** `{ok:false}` instead of throwing, and
its caller's `.catch()` only handles throws — a failed login email is returned to nobody. The
customer sees "If we found you…" either way (correct anti-enumeration; keep it), so a dead app
password produces customers who simply never hear back, with zero signal to Patrick.

If the Workspace app password dies, the first symptom is silence.

---

## Task 1 — Send ledger

- New `server/lib/mailer-log.js`: append-only `server/data/email-log.json`.
  One entry per send **attempt**: `{ ts, kind, to, ok, error?, refId? }` where `kind` is a
  short slug (`magic_link`, `invoice`, `receipt`, `completion`, `stage_notice`, `review_ask`,
  `portal_reply`, `booking_cancel`, `lead_alert`, `outreach`, `supplier`, `other`) and `refId`
  is the lead/invoice/WO id where one exists.
- Wire the five transporter modules (`notify-email`, `notify-customer`, `notify-supplier`,
  `review-requests`, the inline `server.js` senders) through it. Two-line change per send
  helper — success and failure both logged. **No behavioural change to any send.**
- Self-pruning like `magic-tokens.js`: keep 90 days or 5 000 entries, whichever is smaller.
- The **receipt** send gains its log lines inside `sendPaymentReceipt` only. Nothing in
  `finalizeStripeInvoicePayment` or any payment route changes. (Patrick's ruling 2026-08-03.)

## Task 2 — Fix the magic-link silent return

- In `requestPortalMagicLink`, check `sendCustomerLoginLink`'s resolved `{ok:false}` result
  and route it through the ledger + failure alert like any other failure. (~2 lines.)
- **Do not change** the customer-facing response, the "If we found you…" copy, token
  generation, expiry, or single-use behaviour. FLOW-01 hops 1–4 and 6–7 untouched; hop 5
  gains observability only.

## Task 3 — Failure alert on the rail that still works: SMS

- On any **customer-facing** send failure (kinds: magic_link, invoice, receipt, completion,
  stage_notice, review_ask, portal_reply, booking_cancel), send Patrick a Twilio SMS via the
  existing `notify-sms` plumbing and its `isConfigured` guard.
- **Digest-limited via `lib/rate-limit`: at most one SMS per hour**, of the form
  "⚠ N customer email(s) failed in the last hour (first: magic_link to j***@… ). Check
  Admin → Email health." An outage sends one alarm, not two hundred.
- Admin-facing and supplier send failures log to the ledger but do NOT SMS (the lead-alert
  path already has its own SMS redundancy).

## Task 4 — Aggregate view

- `GET /api/admin/email-health` (admin-cookie gated): last-7-day counts by kind
  (sent / failed), plus the most recent 20 failures with ts, kind, masked recipient, error.
- Minimal admin surface: a row/section on the existing admin page reading that endpoint.
  No new page, no styling project.

---

## Do not

- Do not add retries, queues, or a new mail provider — phase two.
- Do not touch payment routes, `finalizeStripeInvoicePayment`, `stripe.js`, `pay.js`
  (FLOW-23 invariants). The receipt path changes by log lines inside its send helper only.
- Do not alter any email's content, recipients, or timing.
- Do not change magic-link mechanics or the "If we found you…" response.
- Do not log full recipient addresses in the SMS alert (mask); the ledger itself is
  server-side data and may hold the full address.

---

## Acceptance test — Patrick runs this

1. **Normal traffic logs.** Request a portal login for your own email; send yourself a test
   invoice. → Both appear in Admin → Email health as `ok` entries with the right kinds.
2. **Controlled failure window (~2 min, quiet hour).** Temporarily set a wrong
   `GMAIL_APP_PASSWORD` on Render, request a portal login for your own email. →
   (a) the customer-facing page still says "If we found you…" (no behaviour change);
   (b) within a minute you get ONE Twilio SMS naming the failure;
   (c) Email health shows the failed `magic_link` row with the error.
3. **Digest limiter.** Trigger a second failure inside the same hour. → No second SMS;
   both failures visible in Email health.
4. **Restore the password.** Request a login again → email arrives; health shows `ok`.
5. **FLOW-23 re-verification** (rule 5 — the receipt helper gained log lines): next real
   payment through the token link → receipt arrives, ledger shows `receipt ok`, ledger and
   payment record agree. No behaviour difference anywhere in the pay flow.
6. Confirm admin lead alerts still arrive on both channels (email + SMS) for a new lead.

If the controlled-failure window is unacceptable on live, steps 2–3 may be run against a
local server with test env vars instead — record which was done.

---

## On completion

Update `docs/FLOW_REGISTER.md`: INF-02 annotated "phase one complete — failures visible"
(stays open until phase two resolves the single-transport risk); note the Email health
surface under Part 1 INF; FLOW-01 and FLOW-23 re-verification results recorded per rule 5.

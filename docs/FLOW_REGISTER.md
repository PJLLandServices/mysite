# PJL Backend Flow Register

**Source of truth for customer-facing backend processes.**
Last updated: 2026-08-01 (JOB-001)

This file replaces scattered chat context. If a flow isn't in here with a status,
it is not known to work. Update this file, not a chat thread.

---

## How to use this

1. **Nothing new ships** until the flow it touches is listed here.
2. A flow is only marked **PASS** after Patrick has personally walked it end to end
   and observed each hop. Not read code. Not assumed. Walked it.
3. Every defect gets an ID and stays in the register until fixed or deliberately closed.
4. Re-verify a flow after any change that touches its hop chain.

## Status legend

| Status | Meaning |
|---|---|
| PASS | Walked end to end, every hop observed working |
| PARTIAL | Some hops verified, some unknown |
| UNMAPPED | Flow exists but hop chain not yet written down |
| BROKEN | Confirmed failure at a named hop |
| MANUAL | Depends on a human action, not code |

---

## Infrastructure

### INF — Outbound email

**Verified 2026-07-30 via raw message headers.**

- **Mailer:** Nodemailer (MIME boundary `_NmP-` confirms it)
- **Transport:** authenticated SMTP to `smtp.gmail.com` (ESMTPSA)
- **Sending identity:** `patrick@pjllandservices.com` (Google Workspace mailbox)
- **Origin host:** Render (`ip-74-220-50-51.ohio-egress.render.com`) — sent server-side by the app
- **Authentication:** SPF pass, DKIM pass (`d=pjllandservices.com`), DMARC pass
- **Reply-To:** `info@pjllandservices.com`

This is why mail lands in inbox and not spam. The domain authentication is set up correctly.

**Defects:**

| ID | Severity | Finding |
|---|---|---|
| INF-01 | Medium | App sends `From: info@pjllandservices.com`, but Google rewrites it to `patrick@`. Header `X-Google-Original-From` proves the rewrite. Cause: `info@` is not a verified send-as alias on the authenticating account. Fix: add and verify `info@` as a send-as identity in the `patrick@` Workspace account, or authenticate SMTP as `info@` instead. |
| INF-02 | **High** | Single point of failure. Every customer email — login links, quote notifications, invoices, receipts — depends on one Workspace mailbox and its app password. Password rotation, 2FA change, revoked app password, or a Google flag stops all customer email at once. Unknown whether failures are logged or silent. |
| INF-03 | Low | DMARC policy is `p=NONE` — monitoring only, not enforcing. No protection against domain spoofing. Fine for now; revisit later. |
| INF-04 | Low | Google Workspace SMTP has a daily send cap. Not a constraint at current volume, but it is a ceiling that exists and should be known before any bulk or seasonal campaign sending is added. |

---

## FLOW-01 — Existing customer portal login

**Status: PASS** — verified end to end 2026-07-30

| # | Hop | Result |
|---|---|---|
| 1 | Customer enters email in top-of-site portal field | PASS |
| 2 | Submit reaches server | PASS |
| 3 | Server matches email to customer record | PASS — email personalised "Hi Patrick" |
| 4 | Magic-link token generated (30 min, single use) | PASS |
| 5 | Email sent via Nodemailer → Workspace SMTP | PASS |
| 6 | Delivered to inbox, not spam | PASS |
| 7 | Link clicked → session created → portal renders correct customer data | PASS |

**Design notes worth keeping:**
- Confirmation screen says "If we found you…" — deliberately does not confirm whether an
  address exists. Correct: prevents strangers probing the customer list. Do not "improve" this.
- Phone number shown on the confirmation screen as a fallback path. Good.
- Email includes both a button and a paste-able URL fallback. Good.

**Not yet tested:** unrecognised email address (what a typo produces), expired token behaviour,
reused token behaviour.

---

## FLOW-02 — Portal in-session actions

**Status: PASS (with one MANUAL dependency)** — verified 2026-07-30

| Action | Result |
|---|---|
| "Send PJL a Message" → submit | PASS — notification received on phone **and** email |
| Notification preferences → Save → reload | PASS — settings persist |
| Stage tracker advance (Request Received → Reviewed → …) | **MANUAL** — Patrick advances it by hand |

**MANUAL dependency risk:** the portal tells the customer *"PJL will follow up as soon as your
request is reviewed."* That promise is kept only if Patrick remembers to move the tracker. A
stale tracker looks to the customer like nothing is happening, even when work is underway.
Not a code defect. A process defect. Needs either a habit, a reminder, or automation.

**Defects:**

| ID | Severity | Finding |
|---|---|---|
| UI-01 | Low | Empty unlabeled input box sitting above "Your Zones" in the "Your System" card on the portal page. Orphaned field, likely left behind by a previous change. Origin unknown. Do not delete blind — find what writes to it first. |

---

## Customer intake flows

Intake avenues enumerated by the 2026-08-01 form-handler audit. IDs follow the JOB-001
job sheet, which reassigned FLOW-04/05/07 to specific pages; the flows those IDs used to
name were renumbered to FLOW-08/09/10 below (nothing was deleted).

Known notification behaviour: quote arrivals do generate email and text notifications.
That is the alerting layer — it does not prove each intake path completes correctly.

| ID | Flow | Status |
|---|---|---|
| FLOW-03 | Online booking (`/book.html` → `POST /api/booking/reserve`) | UNMAPPED |
| FLOW-04 | Sprinkler quote builder (`/quote.html` → `POST /api/quotes`) | UNMAPPED — JOB-001 Task B demoted its sitewide CTA (see CRM-02); page stays live; flow itself unchanged. Awaiting Patrick's acceptance test |
| FLOW-05 | Estimate wizard (`/estimate.html` → **Formspree**, bypasses the CRM entirely — leads exist only as Formspree emails, which is why the CRM export shows 0 identifiable leads) | UNMAPPED — JOB-001 Task B demoted its footer CTA; page stays live. Awaiting Patrick's acceptance test |
| FLOW-06 | Invoice generation → delivery | UNMAPPED |
| FLOW-07 | Customer self-intake (`/new-customer`, `/commercial-new-customer` → `POST /api/new-customer`) | PARTIAL — JOB-001 Task A duplicate guard implemented; server-side hops verified by simulation (create / update / commercial / distinct-email). Awaiting Patrick's live acceptance test before PASS |
| FLOW-08 | Contact form (`/contact.html` → `POST /api/quotes`) | UNMAPPED (was FLOW-04 before JOB-001) |
| FLOW-09 | Quote request → quote delivered to customer | UNMAPPED (was FLOW-05 before JOB-001) |
| FLOW-10 | Payment capture → receipt → work order marked paid | UNMAPPED (was FLOW-07 before JOB-001) |

**Portal-login lookup note (JOB-001 investigation, report-only — not fixed):**
`/api/portal/request-link` matches the typed identifier against **leads** (`resolveLoginIdentifier`,
server.js), dedupes matches by `customerId`, and emails ONE magic link whose subject is the
customer id. On redemption (`/portal/login/verify`) the server gathers all leads with that
customerId and lands the customer on the **newest lead's** portal. Consequence: before the
CRM-01 fix, a repeat self-intake submission minted a fresh empty lead, which became the newest —
so an existing customer logging in afterwards landed on the empty duplicate instead of their
real history. Legacy leads with `customerId: null` are not deduped and each get their own
lead-scoped link. The CRM-01 duplicate guard stops NEW duplicates; existing duplicates still
sit in the CRM and still win the "newest lead" pick until cleaned up (separate job).

**Defects:**

| ID | Severity | Finding |
|---|---|---|
| CRM-01 | **High** | Self-intake created a duplicate lead on every submission from a known email — 14 of 16 self-intake records frozen at "new"/$0 while the real job ran on a separate booking record. **Fix implemented** (JOB-001 Task A, 2026-08-01): `/api/new-customer` now matches existing non-deleted leads by trimmed, case-insensitive email; a match updates the existing record (contact fields, sticky Commercial tag, billing block) and appends the submission to its activity — no new lead. Patrick's email/SMS alert states "updated existing record" vs "new record created". HTTP response is identical on both paths so the endpoint can't be used to probe which emails are in the CRM. Existing duplicates NOT cleaned up (deliberately out of scope). **OPEN until Patrick's acceptance test passes.** |
| CRM-02 | Medium | Three competing estimate paths; `/quote.html` held the strongest sitewide placement (header + footer CTA on every page) and converted worst (4 leads / 0 won over 3 months vs booking's 29 / 28). **Fix implemented** (JOB-001 Task B, 2026-08-01): sitewide "Get a Free Estimate" header CTA (desktop + mobile) and footer "Get an Estimate" link repointed to `/book.html` via `_partials/nav.html` + `_partials/footer.html` + rebuild (83 pages). No redirects; `/quote.html` and `/estimate.html` remain live. In-body CTAs on ~30 pages still point at the old paths (list in JOB-001 report). **OPEN until Patrick's acceptance test passes.** |

---

## Dispatch rules

The drift came from delegated jobs shipping changes that were never read or verified.
Standing rules from here forward:

1. **One job at a time.** No parallel Dispatch work on the backend.
2. **Every job names the flow(s) it touches**, by ID, from this register.
3. **Every job ships with a written acceptance test** — the exact taps Patrick performs to
   confirm it works, in the customer's shoes.
4. **A job is not done until Patrick has run that test himself** and updated the status here.
5. **No job may touch a flow marked PASS** without re-verifying it afterward.

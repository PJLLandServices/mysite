# PJL Backend Flow Register

**Source of truth for customer-facing backend processes.**
Last updated: 2026-07-30

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

## UNMAPPED — customer intake flows

Patrick has confirmed **multiple** intake avenues exist: online booking, contact forms, and
others. Each is a separate flow with its own hop chain and must be mapped and walked separately.

Known notification behaviour: quote arrivals do generate email and text notifications.
That is the alerting layer — it does not prove each intake path completes correctly.

| ID | Flow | Status |
|---|---|---|
| FLOW-03 | Online booking | UNMAPPED |
| FLOW-04 | Contact form(s) — count unknown | UNMAPPED |
| FLOW-05 | Quote request → quote delivered to customer | UNMAPPED |
| FLOW-06 | Invoice generation → delivery | UNMAPPED |
| FLOW-07 | Payment capture → receipt → work order marked paid | UNMAPPED |

*Fill this list in with the actual named avenues, then work down it one at a time.*

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

# PJL Backend Flow Register

**Source of truth for customer-facing backend processes.**
Last updated: 2026-08-02 — supersedes the 2026-08-01 version.

If a flow isn't in here with a status, it is not known to work.
Update this file, not a chat thread.

---

## How to use this

1. **Nothing new ships** until the flow it touches is listed here.
2. A flow is marked **PASS** only after Patrick has personally walked it end to end and
   observed each hop. Not read code. Not assumed. Walked it.
3. Every defect gets an ID and stays here until fixed or deliberately closed.
4. Re-verify a flow after any change that touches its hop chain.

## Status legend

| Status | Meaning |
|---|---|
| PASS | Walked end to end, every hop observed working |
| PARTIAL | Some hops verified, some unknown |
| UNMAPPED | Flow exists but hop chain not written down |
| BROKEN | Confirmed failure at a named hop |
| MANUAL | Depends on a human action, not code |

---

# Part 1 — Infrastructure

## INF — Outbound email

**Verified 2026-07-30 via raw message headers.**

- **Mailer:** Nodemailer (MIME boundary `_NmP-`)
- **Transport:** authenticated SMTP to `smtp.gmail.com` (ESMTPSA)
- **Sending identity:** `patrick@pjllandservices.com` (Google Workspace)
- **Origin host:** Render (`ip-74-220-50-51.ohio-egress.render.com`)
- **Authentication:** SPF pass · DKIM pass (`d=pjllandservices.com`) · DMARC pass
- **Reply-To:** `info@pjllandservices.com`

Domain authentication is correctly configured. This is why mail reaches inbox, not spam.

**Email health surface (JOB-008, 2026-08-03):** `GET /api/admin/email-health`
(admin-cookie gated) + a section on `/admin` — last-7-day sent/failed counts by
kind, the 20 most recent failures with masked recipients, and the timestamp of
the last successful send (overall and per kind). Backed by the send ledger in
`server/lib/mailer-log.js`; customer-facing failures additionally trigger a
digest-limited (max one per hour) SMS alert via the existing Twilio plumbing.

| ID | Severity | Finding |
|---|---|---|
| INF-01 | Medium | App sends `From: info@`, Google rewrites to `patrick@` (proof: header `X-Google-Original-From`). Cause: `info@` is not a verified send-as alias on the authenticating account. Fix: verify `info@` as a send-as identity, or authenticate SMTP as `info@`. |
| INF-02 | **High** | **Single point of failure.** All customer email — login links, quote notifications, invoices, receipts — depends on one Workspace mailbox and its app password. Password rotation, 2FA change, revoked app password, or a Google flag stops all customer email at once. **Phase one complete — failures visible (JOB-008, 2026-08-03):** every send attempt lands in the ledger (`server/lib/mailer-log.js` → `server/data/email-log.json`, 90 d / 5 000-entry self-pruning), customer-facing failures page Patrick by SMS (one digest per hour), and Admin → Email health shows 7-day sent/failed by kind, recent failures (masked recipients), and the last-successful-send timestamp overall + per kind — a total outage no longer looks like a quiet day. Controlled-failure acceptance steps 2–4 run **locally with test env vars** per Patrick's 2026-08-03 ruling (no deliberate outage window on production); recorded as locally verified in the JOB-008 file. Stays open until phase two resolves the single-transport risk (INF-01 / send-as alias, transport resilience). |
| INF-03 | Low | DMARC is `p=NONE` — monitoring only, not enforcing. No spoofing protection. |
| INF-04 | Low | Workspace SMTP has a daily send cap. Not a constraint now, but a known ceiling before any bulk/seasonal sending. |

---

# Part 2 — Verified flows

## FLOW-01 — Existing customer portal login — **PASS**

Verified end to end 2026-07-30. **Re-verified 2026-08-02** after JOB-002 Part B changed hop 7:
the portal now renders customer-wide data (service history, projects) and the magic link lands
on the newest lead with a booking. Hops 1–6 unchanged in code; walked anyway — link arrives,
30-minute expiry and single-use behaviour confirmed intact.

**JOB-008 re-verification (2026-08-03) — PARTIAL, locally verified.** Hop 5 gained
observability only: the send attempt now lands in the email ledger, and a resolved
`{ok:false}` from `sendCustomerLoginLink` — previously returned to nobody — is routed to the
ledger + SMS digest alert. Token generation, expiry, single-use, the generic "If we found
you…" response, and every other hop are untouched. Verified locally per the amended JOB-008
acceptance test (steps 2–4): induced send failure → customer response unchanged (generic
`{ok:true}`), exactly ONE digest SMS dispatched, both failures visible in Email health with
masked recipients, and the success path advances the last-successful-send timestamp.
**Live re-verify pending:** amended steps 1 and 6 (a real portal-login request and lead-alert
delivery on both channels) remain Patrick's walk — hop 5's live send was not re-walked.

| # | Hop | Result |
|---|---|---|
| 1 | Customer enters email in sitewide portal field | PASS |
| 2 | Submit reaches server | PASS |
| 3 | Server matches email to customer record | PASS (personalised greeting) |
| 4 | Magic-link token generated — 30 min, single use | PASS |
| 5 | Email sent via Nodemailer → Workspace SMTP | PASS |
| 6 | Delivered to inbox, not spam | PASS |
| 7 | Link clicked → session created → portal renders customer data | PASS |

**Design decisions worth preserving — do not "improve" these:**
- Confirmation reads "If we found you…" — deliberately does not confirm whether an address
  exists. Prevents strangers probing the customer list.
- Phone number shown as fallback on the confirmation screen.
- Email contains both a button and a paste-able URL.

**Not yet tested:** unrecognised email address, expired token, reused token.

## FLOW-02 — Portal in-session actions — **PASS** (one MANUAL dependency)

**Re-verified 2026-08-02** after JOB-002 Part B: "Send PJL a Message" still delivers to phone
and email; notification preferences still save and persist across reload.

**JOB-005 re-verification (2026-08-02) — PARTIAL, walked states only.** JOB-005 rewrote the
page's header/stage/rail rendering. Walked live: scheduled-state (Gullo) and complete-state
(Ravka) portals render correctly with history intact and past-appointment actions suppressed.
**Deferred, not passed:** the message-send + notification-prefs regression (JOB-005 acceptance
step 7), the mid-project state (step 3 — no active project existed to test), and the
virgin-lead intake state (step 4). Those are covered by seeded browser tests only until walked.

**JOB-006 re-verification (2026-08-03) — PARTIAL, walked states only.** JOB-006 replaced the
page's card set (Next-visit card, intake-only snapshots, thank-you retired). Walked live:
Paolo Gullo's scheduled-state portal, steps 1–4 (see CRM-12 closure). **Deferred, not
passed:** steps 5–8 — no-upcoming card-hidden state, intake-customer card visibility,
live-quote accept card, and the message-send + prefs regression. The deferred FLOW-02
regression from JOB-005 therefore remains outstanding across both jobs; one walked
message-send + prefs pass would clear it for both.

| Action | Result |
|---|---|
| "Send PJL a Message" → submit | PASS — notification to phone **and** email |
| Notification preferences → Save → reload | PASS — persists |
| Stage tracker advance | **MANUAL** — Patrick advances by hand |

**MANUAL risk:** the portal promises *"PJL will follow up as soon as your request is reviewed."*
That promise holds only if the tracker is moved. A stale tracker is indistinguishable from
being ignored, from the customer's side.

| ID | Severity | Finding |
|---|---|---|
| UI-01 | Low | Empty unlabeled input above "Your Zones" in the "Your System" card. Orphaned field, origin unknown. Find what writes to it before deleting. |

## FLOW-23 — Payment captured → receipt → marked paid — **PASS**

Verified 2026-08-02 during the Stripe migration (see `docs/HANDOFF_STRIPE_PAYMENTS.md` §7:
5 live captures, ~$2,300 CAD, zero declines, webhook 200s, ledger entries automatic).
**Re-verified 2026-08-02** during JOB-002 Part B acceptance: one live payment captured through
the existing token link, no discrepancies. The invariants in the handoff §6 are binding on any
payment-adjacent change. (This section was intended by the 2026-08-02 handoff commit but the
register row was left in Part 4 — corrected here.)

**JOB-008 note (2026-08-03) — re-verification PENDING the next real payment.** The receipt
send gained ledger log lines inside `sendPaymentReceipt` only (success and failure paths);
`finalizeStripeInvoicePayment`, `stripe.js`, `pay.js`, and every payment route are untouched
per handoff §6 (Patrick's ruling 2026-08-03). Per the amended JOB-008 acceptance step 5, the
next real payment through the token link is the re-verification: receipt arrives, ledger shows
`receipt ok`, ledger and payment record agree. Until that payment lands this flow's PASS
carries the pending-recheck flag, not a regression.

---

# Part 3 — Intake

## The map

The site has **50+ pages but only ~10 intake destinations.** "Get a Free Estimate" and the
phone number appear in header and footer sitewide — that is one destination with 50+ doors,
not 50 flows. Fix the destination and every door is fixed.

| ID | Destination | Placement |
|---|---|---|
| FLOW-03 | `/book.html` — Book Online, real-time availability | Contact page, footer, **and since 2026-08-02 the sitewide header + footer "Get a Free Estimate" CTA** |
| FLOW-04 | `/quote.html` — 4-step Sprinkler Quote Builder | In-body links only (held header + footer sitewide until 2026-08-02; that CTA now points to `/book.html`) |
| FLOW-05 | `/estimate.html` — Free Installation Estimate | In-body links only (held a footer link until 2026-08-02; that link now points to `/book.html`) |
| FLOW-06 | `/contact.html` — enquiry form | Nav, sitewide |
| FLOW-07 | `/new-customer` — self-intake (unlisted, sent by Patrick) | Private link |
| FLOW-08 | `/commercial-new-customer` — commercial self-intake (unlisted) | Private link |
| FLOW-09 | `/sprinkler-repair.html` — AI diagnostic intake | Its own page |
| FLOW-10 | Phone `(905) 960-0181` | Header + footer sitewide |
| FLOW-11 | `info@pjllandservices.com` mailto | Footer |
| FLOW-12 | Facebook / Instagram | Footer |

**CONFIRMED 2026-08-01:** every web intake reaches the CRM and is tagged by source.
Source tags observed: Sprinkler Repair · New Sprinkler Quote · Customer Self Intake ·
Commercial · AI Diagnostic Chat · General Contact · Spring Opening · Fall Closing.

**Commercial tagging works** — records show Customer Self Intake + Commercial together.
Previously logged as a change order; **closed, already built.**

**JOB-001 verified 2026-08-02** — both acceptance tests walked by Patrick against live data:

| ID | Status | What was walked |
|---|---|---|
| FLOW-07 | **PASS** | Self-intake walked end to end. Existing email → existing record updated, no duplicate, alert says "existing record updated". Unknown email → new lead tagged Customer Self Intake, alert says "new record". Commercial variant (`/commercial-new-customer`, FLOW-08) same behaviour, Commercial tag retained. |
| FLOW-04 | **PASS** — walked 2026-08-03 | Quote-builder flow walked end to end: `/quote.html` submits successfully and the lead **reaches the CRM tagged "New Sprinkler Quote."** (Page live + CTA repointed to `/book.html` verified 2026-08-02.) |
| FLOW-05 | **PARTIAL** — submission walked 2026-08-03 | Page live, footer link repointed to `/book.html` (2026-08-02). **Submission walked 2026-08-03: `/estimate.html` submits successfully but routes to an external quotation combination rather than the CRM** — leads from this path never appear in the CRM, which explains the "no identifiable records" evidence from the JOB-001 export. It is an old form-builder flow. **Capability gap noted:** it produces a generated quotation the portal's own quote-request flow doesn't have. For future consideration; deliberately no job scoped (2026-08-03). |
| FLOW-03 | **PASS** (re-verified) | Real booking completed through `/book.html` after the CTA change: $105 Spring Opening, work order WO-ZDQL272C, correct source tag and dollar value in CRM, phone + email notifications fired. |

## Evidence — CRM export, 56 records, 2026-04-30 to 2026-07-29

| Path | Records | Won | Revenue |
|---|---|---|---|
| Booking (`/book.html`) | 29 | 28 | Real — $90 to $1,195 |
| Self-intake (`/new-customer`) | 16 | 2 | $0 on every record |
| Quote builder (`/quote.html`) | 4 | 0 | $0 |
| Contact / misc | 7 | 0 | $0 |

**The booking flow is the business.** Effectively all revenue in the CRM came through it.

| ID | Severity | Finding |
|---|---|---|
| CRM-01 | **CLOSED** 2026-08-02 | **Self-intake creates duplicates.** Was: sending `/new-customer` to someone already in the CRM created a second lead instead of matching the existing record; 14 of 16 self-intake records frozen at "new", $0. **Fixed by JOB-001 Task A:** `/api/new-customer` (both residential and commercial) now matches submissions against existing lead records by email (case-insensitive, trimmed) and updates the matched record + logs activity instead of creating a duplicate; notifications state updated-vs-created. Acceptance test run by Patrick against live data 2026-08-02 — all three scenarios passed (56 → 57 records, exactly one new lead from the unknown-email case). The portal-login consequence for the seven pre-existing duplicate pairs is now tracked as CRM-07. |
| CRM-02 | **CLOSED** 2026-08-02 | **`/quote.html` was the weakest path despite the strongest placement.** 4 leads in 3 months (one Patrick's own test), zero converted; `/estimate.html` produced no identifiable records. **Fixed by JOB-001 Task B:** the sitewide header + footer "Get a Free Estimate" CTA now points to `/book.html` on every page (83 templated pages + `quote-legacy.html`). `/quote.html` and `/estimate.html` remain live at their URLs — no redirects — and keep their in-body links (inventoried in the JOB-001 report). Acceptance test passed 2026-08-02: CTA verified on three page types, both old pages load, and a real booking completed end to end ($105 Spring Opening, WO-ZDQL272C, correct source tag, notifications fired). |
| CRM-03 | Medium | **Follow-up and owner fields never used.** Zero of 56 records have a follow-up date or owner assigned. Mechanism is built and unused — directly related to the six-day-stale request found 2026-07-30. |
| CRM-04 | Low — **OPEN, tooling shipped, deletion NOT yet done** | Test data live in pipeline: `John Charette — "Test booking with a fake address"`, site_visit, since 2026-04-30; the `Jeff John` VD-3 lead; `+`-tagged JOB-001 acceptance leads. **JOB-009 shipped identification only:** `scripts/find-test-leads.js`, read-only, run on the Render shell — prints id/name/email/source/status/created plus a `WHY` (which signal matched) and a `LINKED` (booking / customer envelope) column. Deletion goes through the CRM's existing bulk delete → `/admin/trash` → 30-day retention flow; the script deletes nothing. **`leads.json` is runtime data on Render and outbound to the live host is blocked from the build sandbox, so no Claude session can generate the list** — Patrick runs the scanner, reviews the table, and deletes in the UI. Closes when the pipeline no longer shows the records and Trash does. |
| CRM-05 | Low — **OPEN, report delivered, deletion NOT yet done** | Two SEO-spam submissions via contact form. **Register premise was out of date:** the intake gate is `checkSubmission()` in `server/lib/anti-bot.js:230`, running ahead of any disk write or Twilio fan-out. **Four blocking checks** — honeypot (233), time-trap (240; 2.5 s–30 d), per-IP rate limit (258; 5 per 10 min), Turnstile (268) — with rejections logged to `server/data/bot-blocked.log`. The often-cited "fifth layer", email normalization (292), is **not a reject path**: its own comment says informational, it only computes a dedupe key. Wired at exactly two call sites: `server.js:4448` (`POST /api/quotes` — the contact form's endpoint, so CRM-05's path) and `server.js:17607` (booking). **None of it stops a human typing an SEO pitch at human speed, which is what these two were.** Recommendation (JOB-009, awaiting Patrick's decision): content heuristics that **flag, don't block** — reuse the scanner's vocabulary at intake to set the lead schema's existing `botFlagged`, so suspect leads arrive pre-flagged instead of posing as leads. No customer is ever blocked. Stricter Turnstile levels taxes every real customer and still doesn't stop humans — not recommended. **No CAPTCHA or gating added** per the standing instruction. At two submissions total the honest answer is option 1 or nothing. **Turnstile confirmed armed 2026-08-09** — Patrick verified `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` both present in the Render environment. Worth recording *why* that check mattered: a **missing** secret disables layer 4 silently (`anti-bot.js:272` falls through with no error and no log line), whereas a **wrong** one fails closed and blocks every submission — so a silent hole was the only failure mode that could hide, and it is ruled out. |
| CRM-14 | Low — **OPEN, found 2026-08-09, no job scoped** | **`POST /api/new-customer` has no anti-bot gate at all.** Found while sourcing the CRM-05 claims. The self-intake handler (`server/server.js:4745`) — behind both `/new-customer` (FLOW-07) and `/commercial-new-customer` (FLOW-08) — never calls `antiBot.checkSubmission()`: no honeypot, no time-trap, no rate limit, no Turnstile. It is a public POST that writes to `leads.json` and fires notifications. Exposure is genuinely lower than the contact form's — the URL is unlisted and sent directly by Patrick, not linked from any page or in `sitemap.xml` — which is likely why it was never wired. But "unlisted" is not "unreachable", and the gate is already written and takes one call to attach (the booking endpoint at `:17607` shows the pattern, including how to skip Turnstile for a trusted path). **Not fixed:** JOB-009 scoped no intake-handler change, and FLOW-07/FLOW-08 are PASS — touching them means re-verifying them. Patrick decides whether this earns a job. |
| CRM-06 | Low — **shipped 2026-08-07, acceptance test NOT yet run** | `/commercial-new-customer` served the residential canonical tag, title, and meta description. Page content differs (rendered client-side); metadata was never differentiated. **Fixed in `serveStatic`:** the commercial route serves the same single-source `new-customer.html` with `<title>`, canonical, meta description — and, per Patrick's 2026-08-07 addendum ruling, the `<h1>` — rewritten to commercial variants. Exact-string replacement: if the source tags ever drift the page serves unmodified rather than breaking. **Re-verified locally 2026-08-09 against a running server:** all four tags differ on the commercial route, all four source strings still match (no silent no-op), and `/new-customer` is **byte-identical** to `new-customer.html` on disk. The page is `noindex, nofollow`, so this is browser tab / bookmarks / link shares, not ranking. Closes on Patrick's view-source walk. |
| CRM-07 | Low (demoted from High 2026-08-02) | **Duplicate-pair lead records — residual admin hygiene only.** Was: portal login landed the seven duplicate-pair customers (Ravka, Dhesi, Gullo, Schwarz, Schafler, Mangos, Leung) on the frozen $0 self-intake record. **Resolved customer-side by JOB-002 Part B:** login lands on the newest lead with a booking, and the portal renders the customer-wide union of history whichever lead the token opens — verified in Part B acceptance (step 2, duplicate-pair login shows full history; no empty portal). What remains is admin-side: doubled records clutter the CRM list, and portal message threads are split per lead (a reply sent on the old record's thread doesn't surface on the landed one). A merge/cleanup job is optional housekeeping, not a customer fix. CRM-01 stops new pairs forming. |
| CRM-08 | **CLOSED** 2026-08-02 | **Completed work orders not visible in the customer portal.** Observed three times; one property with two work orders showed the invoice apparently linked to the spring opening rather than the correct work order, forcing manual PDF delivery. Root cause verified in code 2026-08-02, three layers, same underlying flaw as CRM-07: **(1)** the portal is lead-scoped and renders at most ONE work order — the `lead.booking.workOrder` envelope embedded in the single lead the portal token opens (server.js `buildPortalPayload`); a customer with two visits has the second WO on a different lead (public bookings mint a lead each) or overwritten in place (admin book-from-lead replaces `lead.booking` wholesale). **(2)** Nothing ever writes back to that envelope after booking — no code path updates its `status`/`documentReady`/`documentUrl` when the canonical WO (work-orders.json) completes, so even the right lead's portal card reads "Scheduled" forever with no report. **(3)** Invoices never appear in the main portal at all — `invoices.json` records carry the correct `woId`, but the only customer-facing surface is the separate token-gated `/portal/invoice/:id` link; inside the portal the only WO card the customer can see is whichever lead they landed on (the newest, per CRM-07), so the invoice "appears linked to" that visit. The data layer is correctly linked throughout — this was purely a portal-surface scoping problem. **Fixed by JOB-002 Part B** (portal renders by customer: full service history live from the canonical stores, warranty labels, report + invoice downloads on every visit including expired warranty, projects at stage level). **CLOSED 2026-08-02 — acceptance test passed, all 14 steps**, including duplicate-pair and multi-visit logins, expired-WO PDF download, read-only invoices with no pay controls, no internal data in the project view, and a live payment through the token link (FLOW-23 re-verified). |
| CRM-09 | **CLOSED** 2026-08-02 | **Portal hero/stage rail reflected lead-level booking state only, never completed work.** **Fixed by JOB-005:** headline, current-stage card, and follow-up line derive from canonical stores in priority order (project underway > quote ready > scheduled > complete > closed-quiet > request open); "upcoming" = future-dated booking envelope OR any pre-terminal work order, dateless included (12 of 14 open WOs measured dateless — the normal advance-booking shape); the intake rail renders only during intake and is otherwise replaced by the derived current-stage card (Task 3: replace); Change/Cancel suppressed on past-dated appointments; the stale "quote accepted" thank-you gated out of complete/closed states. **Acceptance record:** steps 1 (Gullo — scheduled via dateless Fall Closing, rail retired, past-appointment buttons suppressed), 2, 5, 6 (Ravka — complete, rail retired, history intact) passed live 2026-08-02. **Steps 3 (mid-project), 4 (virgin lead + intake rail), and 7 (FLOW-02 message/prefs regression) DEFERRED — not passed:** no active project existed to test, and the virgin-lead and regression runs were postponed. Those three states are verified in seeded browser tests only. The page-level contradiction that remains (frozen Work Order card vs Service History) is CRM-12, deliberately NOT covered by this closure. | Verified 2026-08-02 with a seeded customer whose only visit completed three months prior, nothing upcoming: header reads "Hi &lt;name&gt;, your service is scheduled" with "before we arrive" copy; the timeline rail ends at "Booked"; the stage card reads "Service Confirmed / PJL will follow up"; and the work-order card shows the completed visit as "SCHEDULED" for its months-past date with live Change/Cancel-appointment buttons and an "appointment already underway — please call us" notice. All four surfaces read from the lead's frozen `booking.workOrder` envelope and `crm.status` — the same never-updated snapshot behind CRM-08 — while the Part B service-history card directly below correctly shows the same WO as Completed with warranty. The page contradicts itself. Fix direction: derive hero/stage/WO-card state from the canonical stores (completedAt, upcoming bookings) like the history card does; suppress Change/Cancel controls when nothing is upcoming. |
| CRM-10 | Low — fix shipped 2026-08-02 | **"Work Order Document" placeholder panel removed from the portal's appointment card.** It promised "your detailed work order will be available here closer to your appointment" with no mechanism ever delivering one (the envelope's `documentReady` has no writer — confirmed in the CRM-08 investigation). Verified on three customer portals 2026-08-02. Completed service reports now live in the Service History card (JOB-002 Part B). Panel + driving JS removed; card verified rendering cleanly without it. Close on next portal view. |
| CRM-11 | **CLOSED** 2026-08-03 | **Work orders stranded in non-terminal statuses.** Measured live 2026-08-02: 14 open (non-terminal) WOs, **12 dateless** — dateless advance seasonal bookings are the normal shape, not an edge case — and several parked in `on_site` for 1–2 months (WO-B52YWHWY since Jun 1, WO-AZABTKPH since Jul 23). A WO that never reaches `completed` never fires the completion cascade: no property service record, no invoice draft, no `completedAt`, **no warranty start date**. The JOB-005 derived portal state deliberately counts these as "upcoming" (Patrick's ruling: a stale "scheduled" is a truthful nag; a wrong "complete" is the CRM-09 defect class) — so stranded WOs are customer-visible as perpetually-scheduled work. **Resolved by JOB-007 + audited cleanup 2026-08-03:** 14 open → 6, every remaining record legitimately open (Paolo Gullo's advance Fall Closing; four build days under two active GreenTree projects; one commercial service visit genuinely in progress — YRSCC No. 1233). Four closed by hand (including the accidental customer-notification completion that motivated JOB-007), four closed via `scripts/complete-backdated-wo.js --apply --close-only` with true dates, zero invoices/service records created, zero notifications sent (WO-8YB6GM4Y, WO-T3ZA2ZC9, WO-8PEHUSGF, WO-GCSZ6G3P — each backed up pre-write). Permanent tooling now in the repo: `scripts/audit-stranded-wos.js` (read-only triage with a/b/c/d suggestions) and the back-dated completion script (cascade honours `completedAt`; customer email + review-request suppressible; `--close-only` for already-papered work). Re-run the audit periodically — the register's "assume nothing works" rule applies to WO hygiene too. Accepted trade recorded: WO-GCSZ6G3P (Aviva Bushuev, paid $242.95) closed without a service record, so that visit carries no warranty label in her portal history. |
| CRM-13 | **OPEN — shipped 2026-08-06, acceptance test NOT yet run** | **A locked work order could never be corrected.** WO-BF86TWRW (Faramarz / service visit) was bypass-locked at end of visit with the **$95 service call missing from scope**. Because `lineItemsFromWo` returns `[]` when the on-site builder is empty, the completion cascade had nothing to invoice — so no invoice was ever drafted and the fee was never charged. There was no route back: no unlock endpoint, no admin control, and the only latent lever (`PATCH {locked:false}` — `locked` is in `allowedTop` and is not scope-protected) worked on bypass-locked WOs but did **nothing** on signature-locked ones, because the dispatcher guard independently checked `signature.signed`. **Shipped:** admin-only `POST /api/work-orders/:id/unlock` (reason ≥10 chars, required) and `/relock`, gated twice (`needsAuth` → "admin", above the generic `/api/work-orders` "user" rule, **plus** `requireAdmin` in the handler); `isScopeFrozen(wo)` in `lib/work-orders.js` makes `wo.locked` the single freeze authority, replacing 14 `locked || signature.signed` guards in server.js; unlock **preserves** the signature/bypass record (Patrick's ruling 2026-08-06 — flip the flag, keep the record) and writes a `wo_unlocked` history entry carrying the reason, who, and which path held the lock; Unlock/Re-lock buttons on the WO editor (admin only, role from `/api/session`); an **Unlocked** filter on `/admin/work-orders` because unlock clears `locked` and would otherwise drop a WO out of both existing recovery filters — the CRM-11 lesson (a state nothing surfaces is a state nobody fixes). Deliberately **not** touched: the two customer-facing portal guards (`locked \|\| signatureBypass`) so an unlock never re-opens a stale approval/remote-sign link; and **nothing payment-adjacent** — unlock never touches an invoice. 56 automated assertions in `scripts/test-wo-unlock.mjs` (wired into `build:check`); full round trip verified against a live local server (tech→403, short reason→422, locked edit→409, unlock→200 with bypass intact, edit→200, double-unlock→409, relock→200 with edit surviving, edit→409). **Still requires Patrick's walked acceptance test — see the job file.** |
| CRM-12 | **CLOSED** 2026-08-03 | **Stale lead-scoped intake cards contradict the derived state.** Observed live on Paolo Gullo's portal 2026-08-02: the Work Order card shows WO-KXZNWGP4 as SCHEDULED for Tuesday July 14 while Service History on the same page shows that visit Completed and its invoice Paid — plus a permanent "quote accepted" thank-you and a fossilized "Project request / $95 estimated value" card from the July intake. Root cause: the portal is two generations of cards — derived/canonical (JOB-005/Part B: hero, stage, history, projects) and frozen lead-scoped intake snapshots (Work Order envelope card, accept thank-you, project request, project activity) that render forever. Full audit + proposed visibility matrix in the 2026-08-02 session: rebuild the WO card as a "Next visit" card (upcoming/dateless-booked work only, hidden otherwise); retire the won-state thank-you entirely; make Project request + Project activity intake-only (same predicate as the rail); "date to be confirmed" copy for dateless history rows. **Fixed by JOB-006** exactly per that matrix, plus the "When" row label. **Acceptance walked live 2026-08-03 on Paolo Gullo's portal (steps 1–4):** appointment card shows WO-AJAUTCH7 Fall Closing with "date to be confirmed"; the July 14 visit appears only in Service History as completed and paid with its warranty label; thank-you, Project request, and Project activity cards all gone. **Steps 5–8 DEFERRED, not passed** (no-upcoming customer card-hidden check, intake-customer card visibility, live-quote accept card, FLOW-02 message/prefs regression) — covered by seeded browser tests only until walked. |

## Warranty policy — authoritative (recorded 2026-08-02, JOB-002)

| Work order type | Warranty |
|---|---|
| `build` (installation) | **3 years** |
| `service_visit` | 1 year |
| `spring_opening` | 1 year |
| `fall_closing` | 1 year |

Installations carry 3 years; everything else 1 year. Hydrawise controller retrofits are
**service**, not installation — their `service_visit` typing is correct and must not be changed.
Parts replaced during a service call inherit the service warranty; warranty attaches to the work
order, not to individual components. Expiry is computed from the work order's `completedAt` +
type — single implementation in `server/lib/warranty.js` (`warrantyForWorkOrder`), shared with
the completion cascade's snapshot so the two cannot drift.

**JOB-002 Part A (completedAt foundation) — COMPLETE, acceptance test passed 2026-08-02.**
`completedAt` is a first-class field, server-stamped in `workOrders.update()` on every
completion path (tech UI, admin status change, bulk) at the same instant as the `status_change`
history entry; not client-patchable; preserved once set. Backfill applied on Render 2026-08-02
via `scripts/backfill-wo-completedat.js`: **25 records promoted from history timestamps, 0
unrecoverable** (all 25 completed records — the field was new, so every one qualified, not only
the 10 that also lacked `departedAt`). Backup:
`server/data-backup-2026-08-02T15-44-55-816Z-wo-completedat/`. Post-apply count verified:
completed 25, missing `completedAt` 0. Write-path verified live on both branches of the old
gap: tech-flow completion (WO-PEDFQN32) stamped `completedAt` + `departedAt`; admin status
change (WO-PJNZKTWP) stamped `completedAt` with `departedAt` null — the server-side stamp
works. CRM-07 and CRM-08 stay open — Part A is a prerequisite, not a fix; Part B (portal
rebuild) consumes it.

**JOB-002 Part B (portal renders by customer) — COMPLETE, acceptance test passed 2026-08-02,
all 14 steps.** The portal payload carries `serviceHistory` (every non-build work order for the
customer, live from work-orders.json, newest first, warranty labels from `warrantyForWorkOrder`,
report PDF + read-only invoice per line — full history, no retention cut-off) and `projects`
(stage rail Accepted→Deposit→Scheduled→Complete→Invoiced, day count, percent complete, project
invoices — no dailyLog/notes/materials/crew data, verified by sentinel leak-test and confirmed
in acceptance step 11). Magic-link landing prefers the newest lead WITH a booking. Token-gated
downloads: `/api/portal/:token/wo-report-snapshot/:woId` with customer-union authorization +
live customer-audience render fallback for pre-snapshot completions;
`/api/portal/:token/invoice/:invoiceId/pdf` (drafts/voids never serve; cross-customer 403).
Payments untouched per HANDOFF_STRIPE_PAYMENTS §6 — verified live in acceptance step 9.
Outcomes: CRM-08 closed; CRM-07 demoted to Low; FLOW-01, FLOW-02, FLOW-23 re-verified PASS.
Follow-ups spun out: CRM-09 (stale hero/stage/appointment cards), CRM-10 (placeholder panel —
fix already shipped).

---

# Part 3.5 — Verification debt (parked 2026-08-03)

Everything shipped-but-not-walked, in one place so it stops living in chat threads.
Tick items off here as they're confirmed; nothing below blocks new work.

## Do soon — small and real

| # | Check | Why it matters | Effort |
|---|---|---|---|
| VD-1 | ~~Review-request queue check (WO-AZABTKPH / Adam Sorrenti)~~ | **DONE 2026-08-03** — nothing queued, nothing to cancel | ✓ |
| VD-2 | ~~Submit one test quote through `/quote.html`~~ | **DONE 2026-08-03** — submits, reaches CRM tagged "New Sprinkler Quote"; FLOW-04 → PASS | ✓ |
| VD-3 | ~~Submit one test through `/estimate.html`~~ | **DONE 2026-08-03** — submits, but routes to an external quotation, NOT the CRM; finding + capability gap on FLOW-05 | ✓ |
| VD-10 | **Google Ads conversion tracking — confirm live** (2026-08-06, touches FLOW-03 + FLOW-10). Ads conversion tracking was never installed: the site configured GA4 only, no `AW-` line anywhere, so 2 conversions recorded across $1,959 of spend. Now added: `gtag('config','AW-11358637592')` in `_partials/analytics.html` (84 pages via `node build.js`), a booking conversion in `js/booking.js` on the success path only, and a delegated capture-phase phone-click listener. **Verified automatically** in headless Chromium (booking success fires exactly one conversion after the confirm step renders; a failed reserve fires none and leaves the customer on the contact step with a retryable button; runtime-injected `tel:` links are tracked; GA4 config untouched). **Not verifiable in CI:** the outbound ping to Google — `googletagmanager.com` is unreachable from the build sandbox. | Patrick to confirm on the live site: DevTools → Network shows `AW-11358637592`; a phone tap shows `CTBKCOOulN0cEJicnKgq`; a real test booking shows `YtmLCOCulN0cEJicnKgq`. Then, ≤24h later, both conversion actions move Inactive → Active and the "Book appointment" goal Misconfigured → Active. **FLOW-03 stays PASS on its existing walk — this change is additive and guarded, but re-walk one booking to close it out.** |

## Self-verifying — let normal business tick these off, just record when it happens

| # | Check | Ticks itself off when… |
|---|---|---|
| VD-4 | FLOW-02 message-send + prefs regression (JOB-005 step 7 / JOB-006 step 8) | the next real customer sends a portal message and Patrick's phone+email both ring |
| VD-5 | Live accept card renders + works post-JOB-006 (JOB-006 step 7) | the next real quote goes out and the customer accepts online |
| VD-6 | "Your project is underway" state (JOB-005 step 3) | GreenTree (active PROJ-2026-0002/0003) next opens their portal — or mint a token any time |
| VD-7 | No-upcoming customer: appointment card hidden entirely (JOB-006 step 5) | any completed-only customer's portal is next viewed (Ravka) |
| VD-8 | Virgin-lead intake state: "request is open" + rail + request/activity cards (JOB-005 step 4 / JOB-006 step 6) | the next genuine new lead arrives and their portal is glanced at |
| VD-9 | CRM-10 close-on-sight: "Work Order Document" panel gone | already observable on Paolo's walked portal — close on Patrick's say-so |

## Parked — real jobs, not debt

- FLOW-01 edge cases: unrecognised email, expired token, reused token (listed untested since 2026-07-30).
- Part 4 unmapped chains: FLOW-20/21/22 (quote → delivered → accepted — the money path upstream of verified payments), FLOW-24 (form-failure alerting), FLOW-25 (AI diagnostic + its financial promise), MISC-02. (MISC-01 closed 2026-08-09 — four footer taps walked, all load.)

---

# Part 4 — Unmapped

Nothing below has been walked. Assume nothing works until verified.

| ID | Flow | Note |
|---|---|---|
| FLOW-20 | Quote written → delivered to customer | Money moves here |
| FLOW-21 | Quote viewed → accepted | |
| FLOW-22 | Invoice generated → delivered | |
| FLOW-24 | Form failure → does anything alert Patrick? | Contact page shows "Your message didn't send." Unknown whether that failure is logged anywhere. |
| FLOW-25 | AI diagnostic tool (`/sprinkler-repair.html`) | Carries a financial promise: "correct diagnosis = 1 hr labour free." Runs on Cloudflare Worker + API key — a dependency chain separate from Render and from email. |
| MISC-01 | **CLOSED 2026-08-09 — they do not 404. Never was a broken link.** **Acceptance walked by Patrick 2026-08-09: all four footer links tapped on the live site, all load, no 404s.** That closes the one gap the sandbox couldn't: outbound to the live host is blocked from the build environment, so JOB-009's evidence was four local 200s off a booted server plus the static facts — all four pages exist, each is referenced by **84 pages** (the sitewide footer), and all appear in `sitemap.xml`. Production now confirms it directly. The only real defect was that **`sitemap.html`** — the human-readable Site Map page, *not* `sitemap.xml` — omitted them from Service Areas; added in JOB-009 (footer ordering, descriptions from each page's own meta description). **`sitemap.xml` was never part of this defect** and has carried all 18 city URLs since ccf7604 (2026-07-15); it has no server route and ships as a static file — worth keeping on record, since checking the XML to verify an HTML-page fix is an easy wrong turn. |
| MISC-02 | **FIXED in JOB-009; acceptance walk pending.** `sitemap.html` section counters were stale: "Services · 10 pages" listed 11; "Book / Quote / Estimate · 3 pages" listed 4. Corrected to Services 11, Book/Quote/Estimate 4, Service Areas 18 (after the MISC-01 rows). **Re-verified 2026-08-09 by hand-counting `<li>` per section against each declared counter: 6 / 11 / 4 / 18 / 15 / 4 — all six match.** Blog's 15 is a deliberately curated subset (~39 blog pages exist; `blog.html` is the full index), left as is. |

---

# Part 5 — Dispatch rules

The drift came from delegated jobs shipping changes nobody read or verified.

1. **One job at a time** on the backend.
2. **Every job names the flow IDs it touches**, from this register.
3. **Every job ships with a written acceptance test** — the exact taps Patrick performs, as a customer.
4. **A job is not done** until Patrick has run that test and updated this file.
5. **No job touches a flow marked PASS** without re-verifying it afterward.

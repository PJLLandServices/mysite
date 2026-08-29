# PJL Backend Flow Register

**Source of truth for customer-facing backend processes.**
Last updated: 2026-08-09 — supersedes the 2026-08-02 version.
**2026-08-09 (JOB-009 close):** CRM-04, CRM-05, CRM-06, MISC-01, MISC-02 CLOSED on walked
acceptance. CRM-15 opened and closed the same day (booking-delete control). CRM-14 opened.
**2026-08-13 (Site Plan Underlay):** FLOW-26 opened (Site Builder design → Quote + Material
List) — UNMAPPED, awaiting a walked acceptance. Part 6 added to record architectural
deviations DEV-01 / DEV-02 / DEV-03.
**2026-08-18 (Prepared-for address):** QUOTE-01 opened and fixed under FLOW-20 — the
proposal PDF addressed the customer at a SITE address belonging to a different project.
FLOW-20 stays UNMAPPED; it was UNMAPPED before this change and no PASS flow was touched.
**2026-08-18 (Line-item order):** QUOTE-02 opened under FLOW-20 — Patrick can arrange the
display order of quotation line items, and it renders in that order on the PDF. Display
only; FLOW-20 still UNMAPPED, no PASS flow touched.
**2026-08-25 (Seasonal opt-out):** FLOW-29 opened — the seasonal-outreach consent chain had
no registered flow. Two silent consent defects found and fixed (OUTREACH-01, OUTREACH-02).
FLOW-29 is UNMAPPED and needs a walked acceptance. No PASS flow was touched: FLOW-02's
notification preferences are the customer portal's own route
(`PATCH /api/portal/:token/preferences`, stored on the lead), a different surface from the
property record's `commPrefs`.
**2026-08-27 (Customer delete vs. the Trash):** CRM-16 opened and fixed — `customers.js
hardDelete()`'s referential guard counted soft-deleted records, so a quote deleted from the
quote folder kept blocking its customer's deletion for the whole 30-day Trash retention
while showing nowhere in the CRM. The guard now splits live links from Trash links: live
links block as before, a Trash-only customer takes a second confirm and its Trash records
are permanently deleted with it. **No PASS flow touched** — no route, payload or catalog
change on FLOW-01 / FLOW-02, and nothing in `stripe.js`, `pay.js` or any payment route
moves (FLOW-23's invariant). Invoices are deliberately outside the purge: a deleted invoice
leaves `invoices.json` for the tombstone log, so any invoice reference is live and still
blocks. Cover: `scripts/test-customer-delete-trashed.mjs` (35 assertions, in
`build:check`).

**2026-08-27 (Territory export as an admin download):** `GET /api/admin/territory-export`
opened and registered under **INF — Admin data exports** (Part 1). The fall-closing
territory export existed only as a repo-root CLI, so producing one needed shell access to
the Render instance. It is now a link on `/admin/settings` as well. **No PASS flow touched**
— a new path, a new lib and a new card; no existing route, payload or catalog changed, and
nothing in `stripe.js`, `pay.js` or any payment route moves (FLOW-23's invariant). The
superseded `territory-export.js` was deleted (its own replacement documents three ways it
silently miscounts). Cover: `scripts/test-territory-export.mjs` (100 assertions, in
`build:check`).

**2026-08-29 (FLOW-30c — the fee waiver is ADMIN ONLY):** Patrick's ruling: *"Techs will have to
reach out to admin in order to alleviate a warranty claim for free."* Waiving or restoring the
$95 changes what the customer pays, and on a warranty work order it also decides whether a claim
was honoured — so it is now an admin decision at the SERVER, not just a hidden button.

`POST /api/work-orders/:id/service-fee-waiver` returns `"admin"` from `needsAuth()`. **The rule
must stay ABOVE the generic `/api/work-orders` → `"user"` line — `needsAuth` returns on first
match, so swapping the two silently hands every tech the control back.** A test pins the order
(mutation-tested: moving it below fails the build). Same class of decision as `unlock`/`relock`,
which were already admin-only — this makes the two consistent.

Scalpel, not a lockout: a tech still reads the WO, patches notes/zones/photos, builds the on-site
quote and takes the signature. Verified against a real tech account — GET, PATCH and
`on-site-quote/build` all still 200; only the two waiver calls 403.

UI follows the server rather than replacing it. A tech on the admin WO page still SEES the
"Service call fee waived" banner and the whole warranty panel — they need to know the visit is
free and what prior work it honours — but the waive offer, the Remove button and the convert
control are hidden, replaced by a line telling them to contact the office. The role resolves
async from `/api/session` AFTER the WO renders, so the controls default hidden (fail closed) and
`resolveViewerRole()` re-renders them; without that re-render an admin would lose their own
buttons.

Cover: `scripts/test-warranty-claims.mjs` now 220 assertions, plus a 19-assertion live walk with
separate admin and tech logins (including that a refused attempt leaves the waiver, the WO and
the claim completely untouched — no phantom conversion) and a 10-assertion browser pass over both
roles' views of the same work order.

**2026-08-29 (FLOW-21 — Quote View Tracker):** FLOW-21 is "Quote viewed → accepted" and the
**viewed** half did not exist: nothing anywhere recorded that a customer had OPENED a quote.
There was no `viewedAt` on the record, no open tracking, and no request log in the app — the
only trace of a customer opening a proposal lived in Render's HTTP logs and, for FAILED phone-gate
attempts only, in stdout. So "the customer says they approved it and we have nothing" was not
answerable from the CRM. Opened after exactly that question came up on **Q-2026-0075**. A view
ledger now records customer opens across all five approval surfaces and the quote folder shows
the state on every row. **UNMAPPED — needs a walked acceptance** (see FLOW-21 in Part 4). No PASS
flow was touched, and by construction none can be: view tracking writes to its OWN file and never
to `quotes.json` (see the note below on why that separation is the whole safety argument).

**2026-08-29 (FLOW-30b — Approved claim → repair work order → the warranty escape hatch):**
Follow-up to FLOW-30. Approving a claim now RAISES the repair work order in the same action, and
a warranty visit that turns out not to be covered can be converted to a chargeable service call
on site. Two claim statuses added (`approved`, `converted`), taking the enum to ten.

**Confirmation of the pre-existing workflow (asked for explicitly, checked before building).**
The transition was already supported by the work-order model; nothing about it had to be
redesigned:

- `serviceFeeWaiver` with reason `warranty` already existed (`lib/service-fee-waiver.js`) and
  already rendered to the customer as "Service call fee — WAIVED (Warranty visit)" via
  `lib/issue-rollup.js` — a $0 line, so the credit is VISIBLE rather than the fee silently
  vanishing.
- `POST /api/work-orders/:id/service-fee-waiver` with `{ waived: false }` already restored the
  $95 line from `pricing.json`, recomputed totals and appended WO history.
- `serviceFeeWaiver` was already in `SCOPE_PROTECTED_FIELDS`, so it freezes at signature
  (`wo.locked`) and is freely changeable before it — which IS the on-site window the conversion
  needs. After signature the documented route back is `unlockWorkOrder()` (reason required,
  signature record preserved).
- The customer signature was already required independently: `POST /on-site-quote/accept`
  refuses without customerName + a drawn image + acknowledgement, so converted (now chargeable)
  work cannot be accepted unsigned.

**What was missing, and is now built:** there was no way to raise a WO from a claim at all; a WO
carried no warranty provenance, so a tech on site could not see which prior job was being
honoured; lifting a waiver required NO reason and told the claim NOTHING — a claim would have sat
at "approved, free repair" while the visit was invoiced. That last one was the audit hole.

- `wo.warrantyClaim` added — `{ claimId, claimedInvoiceId, claimedWorkOrderId, summary,
  approvedBy, approvedAt, converted }`. In `blank()`, `hydrate()`, `create()`, `update()` and
  `SCOPE_PROTECTED_FIELDS`. `converted` is ADDED alongside the approval, never replacing it: the
  pair is the audit trail.
- `POST /api/warranty-claims/:id/approve` — creates the `service_visit` with the warranty waiver
  and provenance, seeds the diagnosis from the customer's own words, links the WO to the claim,
  and emails the customer. Refuses a second WO (409) and refuses with no linked property (422).
- The conversion rides the EXISTING fee-waiver route rather than a parallel one, so there is one
  code path for the money. On a WO with live warranty provenance, removing the waiver requires a
  ≥10-char reason, stamps `converted`, moves the claim to `converted`, and emails the customer
  the reason. The claim write-back happens AFTER the WO update so the money change is durable
  first; a failed write-back is logged loudly and surfaced in the admin UI.
- `converted` is terminal and NOT disputable — the customer authorised and signed on site.
  `approved` is deliberately OPEN, so an accepted-but-unrepaired claim stays in the queue and the
  reminder counts.
- Surfaces: green "Warranty repair — no charge" panel on the admin WO (with the convert control)
  and on the tech UI (read-only — lifting a customer's waiver is a desk decision against the full
  claim, not a tap in a driveway; the tech is told to call the office). Both flip amber once
  converted, and the tech's copy then says the customer must sign.
- One UI defect found and fixed while walking it: the pre-existing "Remove" button on the waiver
  banner gave a SECOND path to lifting the waiver, and on a warranty WO it would 422 and print
  its error into the collapsed waiver form — an invisible error that reads as a dead button. It
  is now hidden on a live warranty WO, and a refused fee change falls back to an alert when its
  panel isn't visible.

**No PASS flow touched.** Additive fields and new routes only. `lib/warranty.js` (the policy)
stays read-only to the claim flow, and nothing in `stripe.js`, `pay.js` or any payment route
moves (FLOW-23's invariant). Cover: `scripts/test-warranty-claims.mjs` now 209 assertions
(mutation-tested against nine broken states), plus a live-server walk of the approve → quote →
convert → sign → lock → unlock cycle (63 assertions across two phases, including that the
subtotal rises by exactly the restored $95 and the repair lines are left untouched) and an
18-assertion headless-Chromium pass over the admin and tech surfaces.

**Still UNMAPPED, same reason as FLOW-30:** no email in this flow has been sent through live
Gmail, and no one has walked a real warranty visit end to end on a phone in the field.

**2026-08-29 (FLOW-30 — Warranty claims):** The "File a warranty claim" button on
`warranty.html` pointed at `contact.html`, which is the general contact form — a warranty claim
arrived as an ordinary lead with no invoice reference, no evidence, no claim number and no queue.
FLOW-30 opened: a dedicated intake (`warranty-claim.html`), a claim store with Patrick's
`YYYY-MM-DD-000YYYYNNNN` numbering, a customer status page, a CRM queue and per-claim tool, and
the deny → dispute round trip. **UNMAPPED — needs a walked acceptance** (see FLOW-30 in Part 4
for exactly what is unproven: every send in this flow has been exercised against builders and
routes but never against live Gmail). **No PASS flow was touched** — all new paths, new libs and
new pages; no existing route, payload shape or catalog changed, and nothing in `stripe.js`,
`pay.js` or any payment route moves (FLOW-23's invariant). The one edit to an existing customer
surface is additive: `portalPayloadForLead()` and the property-portal payload each gained a
`warrantyClaims` array, and `nav-badges.js` gained a third badge fetch. `lib/warranty.js` (the
warranty POLICY) is **read-only** here — the claim flow consumes `warrantyForWorkOrder()` and
never redefines a term. Cover: `scripts/test-warranty-claims.mjs` (138 assertions, in
`build:check`, mutation-tested against four broken states), plus a headless-Chromium pass over
all four new pages at 1280px and 390px and a 101-assertion live-server walk of the HTTP surface.

**2026-08-27 (Stale CRM assets):** Follow-up to CRM-16, found on Patrick's first live
attempt. The fix deployed and the delete still refused: CRM **HTML** is `no-store` but
`/crm/*.js` was `public, max-age=30` with no validators, so the page paired fresh markup
with a cached `customer.js` that had no branch for the new 409 and printed its raw text
instead of raising the confirm — the "old JS against new HTML" class documented up and down
`tech-sw.js`, now hit on the desktop CRM. `serveStatic` serves `/crm/*.js` and `/crm/*.css`
`no-cache` (revalidate every load; ~40–90 KB files, internal users only), `customer.js`
carries a `?v=2` buster for copies already cached, and a confirmed delete that comes back
refused now says the confirmation didn't reach the server rather than repeating it.
`tech-sw.js` keeps `no-store`; public-site assets keep `max-age=30`; the service worker's
own versioned precache is untouched.

**2026-08-27 (CRM index sorting):** The customers and properties indexes gained a sort
control — name/customer A–Z and Z–A, town A–Z and Z–A, plus the customers list's previous
recently-active order, kept as an option. **Both now default to alphabetical:** the indexes
are read as directories ("where is Vivian G"), and recency only helps when you already know
someone was touched lately. The choice is remembered per page in localStorage. Town is
DERIVED, not stored — properties carry one free-text `address`, so `lib/format.js`
`townFromAddress()` reads it and `/api/properties` + `/api/customers` decorate their
payloads (`town`, and `towns` on a customer, whose towns come from their properties since
a customer has no address of their own — Hard Rule #10). Additive response fields only; no
existing field changed meaning and no PASS flow is touched. `townFromAddress` splits on
commas rather than reusing `parseCanadianAddress`'s street-suffix split, which knows "St"
and "Blvd" but not "Rue", "Gate", "Grove" or "Green" — those addresses came back with no
town at all. An address it can't read sorts under "no town" rather than guessing. Cover:
`scripts/test-crm-sorting.mjs` (58 assertions, in `build:check`), plus a headless-Chromium
walk of both pages (default order, every sort option, persistence across reload, sort with
an active search, and 390px with no horizontal overflow).

**2026-08-27 (AI chat transcripts — conversation read-back):** Read-side only. A chat is
stored by `js/chat-widget.js` `buildTranscript()` as ONE flat string — `Customer: …` /
`Patrick (AI): …` turns joined by a blank line — and both CRM surfaces printed that string
straight out (`/admin/chats` into a pre-wrap div capped at 480px, the lead drawer into a
`<pre>` capped at 360px), so a real conversation came back as one undifferentiated block.
`server/crm-transcript.js` + `crm-transcript.css` now parse the string back into speaker
turns and render them as bubbles on both surfaces; the scroll portholes are gone, an open
transcript reads top to bottom. **The stored format is untouched** — nothing about the POST
upsert, `normalizeTranscriptBody`, or what the widget writes moves, and a transcript with no
recognisable labels falls back to its raw text behind a "Plain text" toggle rather than
being guessed at. The one backend change is the *content* of the dashboard's `preview`
field: every transcript opens with the widget's two scripted AI greetings, which are longer
than the 240-char preview budget, so a head-of-string slice gave every row in the list an
identical, useless line; `chatPreview()` now previews the first thing the **customer** said.
That field is read by `server/chats.js` and nothing else. Two client-side defects fixed
alongside: the 60s dashboard poll rebuilt the list and snapped any open transcript shut
mid-read (open rows are remembered, and an unchanged poll skips the redraw entirely), and
transcript HTML is escaped with `javascript:` links refused. **No PASS flow was touched** —
no route, payload shape, or catalog change; FLOW-09 / FLOW-25 (AI diagnostic) are UNMAPPED
and their hop chain is not involved, since this changes only how an already-stored
transcript is displayed. Cover: `scripts/test-chat-transcript-view.mjs` (64 assertions, in
`build:check`), plus a headless-Chromium pass over both surfaces. **Not walked:** Patrick
has not yet read a live transcript through the new layout.

**2026-08-28 (CRM-17 — pinned summary on a phone):** The customer profile's map pins
painted on top of the Delete button and through the danger-zone text on mobile.
`.customer-summary` is `position: sticky` so that on DESKTOP it stays in view beside a long
tab column. The profile grid collapses to one column at 800px, but the summary stayed
sticky — and stacked on a phone it is ~1760px tall against an ~840px viewport, so the
browser pinned a box taller than the screen and everything below it (properties, bookings,
work orders) scrolled straight through it. The pins were only the visible edge; the whole
tab column was sliding over the summary card. Un-stuck at the same 800px breakpoint as the
grid collapse. **The override has to sit AFTER the rule it overrides** — both are plain
class selectors of equal specificity, so source order decides; the first attempt put it in
the earlier media block and `position: sticky` simply won, rendering exactly as broken with
the fix "in". Verified in headless Chromium at 390 / 430 / 768 / 1280: summary and tabs
stack with no overlap, no address-over-control collision at any scroll position, no
horizontal overflow, and desktop keeps its sticky sidebar. **A sweep of all 23 CRM pages at
390px found no other element sticky-and-taller-than-the-viewport** — this was the only one.
Cover: `scripts/test-crm-mobile-layout.mjs` (7 assertions, in `build:check`) — source-level
by design, since proving geometry needs a browser and a booted server and `build:check` is
node-only (same call as CRM-15). It pins the override's existence, its position after the
base rule, and that its breakpoint equals the grid-collapse breakpoint; mutation-tested
against all three broken states, including the losing-source-order one.

**2026-08-28 (CRM-18 — Customers / Properties index cleanup):** Both indexes were a stack
of separately-bordered cards with no column headers and `fr`-sized columns, so on a wide
screen the name column stretched and left the email stranded mid-row; at 20+ records it
read as stripes rather than a list ("this looks so messy"). Rebuilt on one shared data-table
primitive — `.crm-table` in `crm.css` — the pattern the trade CRMs use: one surface, a
header row naming the columns, hairline dividers, content-sized columns. **The header row
and the data rows are separate grids that read ONE column template** (`--crm-cols`, set per
page), so they cannot drift; `scripts/test-crm-table.mjs` pins that parity because a
mismatch shifts every value one column off its heading and reads as a glitch, not a typo.
Customers: CUSTOMER / EMAIL / PHONE / TOWN / STATUS, email and phone split into their own
columns. Properties: CUSTOMER / ADDRESS / TOWN / ZONES / VALVES / VISITS, the three counts
as numeric columns instead of a "0 zones · 0 valve boxes · 0 bookings" sentence per card.
Town is plain text in both (a chip beside the status pill made every row two competing
badges) and the status pill is tinted rather than solid inside the table. **Two defects
found while building it, both fixed:** search didn't cover town, so typing "King" against a
visible King City column returned nothing; and in the properties Select mode the address's
map affordance swallowed clicks meant to tick the row. ~150 lines of now-dead card CSS
removed — stale layout rules are what sent the CRM-17 fix to the wrong place. Verified in
headless Chromium: 18 interaction checks (header/row alignment on every row, row-click
navigation, bulk bar, select-all, legacy Select mode, the bulk-selection toolbar's injected
checkbox, sort, search, maps affordance) plus 1440px and 390px renders of both pages with
no JS errors and no horizontal overflow. No API, route or payload change — presentation
only, no PASS flow touched.

**2026-08-26 (Unwanted page scrolls):** Client-side only. `scrollIntoView({ block:
"start" | "center" })` moves the page even when the target is already fully visible, so
`/book.html`'s step advances and both work-order pages' tap-to-jump handlers lurched on
content that was already on screen — worst on a phone, where the throw is most of a screen
height. Five call sites now go through a `revealIfOffscreen()` guard (`js/booking.js`,
`server/work-order.js`, `server/work-order-tech.js`). **FLOW-03 is PASS and its hop chain
is untouched** — no route, payload, or catalog change; the booking step machine still
advances service → zones → address → when, re-verified by scroll measurement at 390x700
and 1440x900, not by a walked booking. If the PASS stamp is to carry a walked date, that
walk is still Patrick's to make.
**2026-08-26 (Season config + fall 2026 dates):** The fall season window was hardcoded in
`server/lib/outreach.js` as Sep 1 – **Dec 15**; the real fall 2026 season ends **Nov 6**
(hard frost). The last 39 days were not serviceable, so `deriveBookingState` counted
Nov 7 – Dec 15 appointments as "booked for fall" and `/admin/outreach` classified its
Booked / Not-booked rows on them. Dates now live in **`seasons.json`** at the repo root,
read through **`server/lib/seasons.js`**, so the seasonal gate planned for
`availability.js` reads one source instead of a second copy that drifts. **Production
audit before the change: 42 bookings, 0 in the Nov 7 – Dec 15 window — no customer was
reclassified.** Comparison logic, inclusivity (both ends), eligibility semantics
(`fallClosing !== false`), copy, and send behaviour are all unchanged. A year with no
block in `seasons.json` inherits year-agnostic defaults, and **those default fall to the
Nov 6 frost stop, not the old Dec 15** — an unplanned year inherits a safe date rather
than a known-wrong one, so fall 2027 cannot silently reacquire this defect while waiting
to be planned. Spring's defaults are its long-standing Mar 1 – Jun 30, unchanged. **One deliberate behaviour
change, recorded under FLOW-28 below:** `seasonForBooking()` reads the same window, so
between Nov 7 and Dec 15 the portal CTA now offers the coming Spring Opening instead of a
Fall Closing that cannot be performed. **No PASS flow was touched** — no route, payload,
or catalog change, and the CTA that moved is FLOW-28's (UNMAPPED). `publicBookingThrough`
(fall 2026: Oct 30) is defined in the config for the future gate and is deliberately
consumed by nothing, pinned by a source guard. Cover:
`scripts/test-season-config.mjs` (66 assertions, in `build:check`).

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

## INF — Admin data exports

Read-only, admin-gated surfaces that hand Patrick a file. Not customer-facing: nothing
here sends, charges, schedules or writes. Listed so a new one is registered rather than
appearing unannounced.

**Territory export (2026-08-27):** `GET /api/admin/territory-export` — the fall-closing
territory export as a browser download. Same payload the CLI at
`territory-export-corrected.js` prints; both call `server/lib/territory-export.js`, so the
two cannot drift. Opened because running the CLI needs shell access to the Render instance,
which Patrick does not have. Reachable from **Admin → Settings → Territory export**
("Download territory export (JSON)"). `?year=YYYY` selects the season year for the
per-season opt-out flag, matching the CLI's `--year`; omitted, it is the current UTC year.

- **Gate — ADMIN ONLY, twice over.** `needsAuth()` maps the path to `"admin"`, and the
  route re-checks with `requireAdmin`. Verified against a live local server, not read
  off the middleware: no cookie → **401**; a forged/tampered cookie → **401**; a signed-in
  **tech** → **403**; a signed-in admin → **200**. De-identified is not public — the
  payload is still every live property's municipality and rough location.
- **Read-only.** `buildTerritoryExport()` only ever `readFile`s `properties.json` and
  `customers.json`. It deliberately does **not** require `server/lib/properties`, whose
  `readAll()` calls `ensureFile()` and can persist one-time id/code backfills — a write.
  Verified by checksumming every file in `server/data/` before and after four exports:
  byte-identical, nothing created.
- **The three correctness guards are preserved exactly** — they are the reason the
  corrected version exists, and each is asserted through the HTTP response, not just in
  the lib: (1) soft-deleted and archived properties are excluded, matching
  `properties.list()`; (2) depot pins (`PJL_BASE`, 44.0592 / -79.4613, or
  `coords.source === "pjl-base"`) are reported as missing coordinates and their
  "Newmarket, ON, Canada" label suppressed, not counted as a downtown cluster; (3)
  xlsx-imported string coordinates are coerced, not dropped as missing.
- **Privacy unchanged from the CLI.** No names, emails, phone numbers or street
  addresses. Property ids are replaced by a per-run salted pseudonym (so two exports do
  not line up), and coordinates are rounded to 2 decimals (~1.1 km).
- **Response.** `Content-Type: application/json; charset=utf-8`,
  `Content-Disposition: attachment; filename="territory-export-YYYY-MM-DD.json"`,
  `Cache-Control: no-store`.
- **Cover:** `scripts/test-territory-export.mjs` (100 assertions, in `build:check`),
  including source guards that fail the build if the path leaves the admin gate, if the
  route stops calling `requireAdmin`, if the response stops being an attachment, if the
  lib acquires a write call, or if the CLI grows its own copy of any guard.
- **The superseded `territory-export.js` was deleted.** Its own replacement documents
  three ways it silently produces wrong numbers, and it sat next to the corrected file
  under the shorter, more obvious name.

**What still needs Patrick — not yet walked:** sign in, go to **Settings**, tap
**Download territory export (JSON)**, and confirm a file named
`territory-export-<today>.json` lands on the device and opens as JSON. That is the whole
acceptance test; nothing here writes, so there is nothing to undo if it misbehaves.

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
| CRM-04 | **CLOSED 2026-08-09** — pipeline clear of test data. **Deleted in two passes.** The test *leads* (John Charette, Jeff John, `+`-tagged JOB-001 acceptance-run leads) went during Patrick's JOB-009 acceptance walk **2026-08-07**, through the CRM's bulk delete → Trash flow. The residue — booking `BK-2026-0014` and the John Charette *customer* record — went **2026-08-09**, once CRM-15 shipped the control that made the stranded booking reachable. Patrick confirmed both gone. **Worth keeping on record:** the 08-09 residue existed *because* the lead was deleted first (that is CRM-15), and `scripts/find-test-leads.js` reported "pipeline is clean" the whole time — correctly, since it scans leads only and skips Trash, but indistinguishably from an empty or wrong file. That ambiguity cost several round trips and is now fixed in the scanner (it prints path, record totals and live-vs-Trash counts before any verdict, and takes `--include-trashed`). The lesson generalises: a cleanup tool that reports absence must say what it looked at. |
| CRM-05 | **CLOSED 2026-08-09** — both deliverables done: the spam records are gone and the report is written. The two SEO-spam leads were deleted in Patrick's 2026-08-07 acceptance walk; **Kelly Dorji**, the one that had also minted a customer record, is confirmed fully removed from every store (checked 2026-08-09). **The flag-don't-block recommendation below is an open *decision*, not an open defect** — like CRM-03, it needs Patrick's word on whether to build it, and closure here does not presume the answer. **No CAPTCHA or intake gating was added**, per the standing instruction. Original finding and report: Two SEO-spam submissions via contact form. **Register premise was out of date:** the intake gate is `checkSubmission()` in `server/lib/anti-bot.js:230`, running ahead of any disk write or Twilio fan-out. **Four blocking checks** — honeypot (233), time-trap (240; 2.5 s–30 d), per-IP rate limit (258; 5 per 10 min), Turnstile (268) — with rejections logged to `server/data/bot-blocked.log`. The often-cited "fifth layer", email normalization (292), is **not a reject path**: its own comment says informational, it only computes a dedupe key. Wired at exactly two call sites: `server.js:4448` (`POST /api/quotes` — the contact form's endpoint, so CRM-05's path) and `server.js:17607` (booking). **None of it stops a human typing an SEO pitch at human speed, which is what these two were.** Recommendation (JOB-009, awaiting Patrick's decision): content heuristics that **flag, don't block** — reuse the scanner's vocabulary at intake to set the lead schema's existing `botFlagged`, so suspect leads arrive pre-flagged instead of posing as leads. No customer is ever blocked. Stricter Turnstile levels taxes every real customer and still doesn't stop humans — not recommended. **No CAPTCHA or gating added** per the standing instruction. At two submissions total the honest answer is option 1 or nothing. **Turnstile confirmed armed 2026-08-09** — Patrick verified `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` both present in the Render environment. Worth recording *why* that check mattered: a **missing** secret disables layer 4 silently (`anti-bot.js:272` falls through with no error and no log line), whereas a **wrong** one fails closed and blocks every submission — so a silent hole was the only failure mode that could hide, and it is ruled out. |
| CRM-14 | Low — **OPEN, found 2026-08-09, no job scoped** | **`POST /api/new-customer` has no anti-bot gate at all.** Found while sourcing the CRM-05 claims. The self-intake handler (`server/server.js:4745`) — behind both `/new-customer` (FLOW-07) and `/commercial-new-customer` (FLOW-08) — never calls `antiBot.checkSubmission()`: no honeypot, no time-trap, no rate limit, no Turnstile. It is a public POST that writes to `leads.json` and fires notifications. Exposure is genuinely lower than the contact form's — the URL is unlisted and sent directly by Patrick, not linked from any page or in `sitemap.xml` — which is likely why it was never wired. But "unlisted" is not "unreachable", and the gate is already written and takes one call to attach (the booking endpoint at `:17607` shows the pattern, including how to skip Turnstile for a trusted path). **Not fixed:** JOB-009 scoped no intake-handler change, and FLOW-07/FLOW-08 are PASS — touching them means re-verifying them. Patrick decides whether this earns a job. |
| CRM-15 | **CLOSED 2026-08-09 — fix shipped and walked live the same day.** Patrick deleted the stranded `BK-2026-0014` through the new control and then deleted the John Charette customer record, which the booking had been blocking — the exact failure this defect describes, resolved end to end on production. That also unblocked CRM-04. | **Deleting a lead strands its booking with no UI left to delete it.** The schedule canvas builds its booking list from **leads**, not the canonical store — `schedule.js:185-189` fetches `/api/quotes` and reads `(bookingsResp.leads \|\| [])`, rendering each `lead.booking`. That canvas holds the **only** booking-delete control in the CRM (`schedule.js:1497` → `DELETE /api/bookings/:id`); `server/bookings.js` has no delete path at all. So once a lead is deleted, its booking is invisible on the schedule and unreachable from every screen — while still counting against `customers.js hardDelete()`'s reference check, which blocks deleting the customer. The delete handler documents the coupling in the opposite direction (`server.js:9472` strips `lead.booking` so the canvas "stops rendering the ghost") but nothing handles lead-first ordering. **Hit live:** JOB-009's own acceptance test instructed deleting the test leads, which stranded John Charette's `BK-2026-0014` and left his customer record undeletable with no UI remedy. Workarounds, both verified against the code: call `DELETE /api/bookings/:id` directly (same endpoint, guards and admin check as the button), or restore the lead from `/admin/trash` within the 30-day window so the booking renders again. **FIXED 2026-08-09 — "Delete this booking" on the booking detail page** (`/admin/booking/:id`), the page you land on from the Bookings list. That list is fed by `GET /api/bookings` → `bookings.list()`, the **canonical store**, so an orphaned booking is visible and now actionable there even with no lead. Admin-only (`deleteZone` revealed from `/api/session`, failing closed to hidden; the server enforces it independently via `requireAdmin`), native `confirm()` carrying the booking summary — same friction as the schedule canvas's delete — and the server's own refusal is surfaced verbatim, naming the linked WO id when an in-progress work order blocks it. Success redirects to `/admin/bookings`. **No server change: the endpoint already existed and is untouched**, so no intake, booking, or payment path moves — this is the missing UI for a route that shipped long ago. Verified in headless Chromium against a seeded orphan (booking present, lead deleted): detail page loads, no JS errors, zone visible for admin and hidden for tech, click deletes and redirects, record gone from the store — 8/8. **Deliberately not wired into `build:check`** (it needs a browser and a booted server; the suite is node-only). Patrick's walk: open the stranded booking, delete it, then delete the customer. |
| CRM-16 | **CLOSED 2026-08-27 — fix shipped, verified end to end against a booted server.** **A quote in the Trash blocked its customer's deletion, invisibly.** Same shape as CRM-15, one store over: `customers.js hardDelete()` filtered every store for `customerId` and refused if *anything* matched, with no regard for `deletedAt`. A quote soft-deleted from the quote folder stays in `quotes.json` for its 30-day Trash retention, so it kept the customer undeletable — while the customer page's own Quotes tab, built from `quotes.list()`, filters the Trash out and showed zero. The refusal read "linked to 1 quotes" next to a tab reading 0, naming a link Patrick could neither see nor act on from that page, and Merge — the remedy the message offered — was the wrong tool for a record already deleted. Live for Vivian G (`19931887`). Hit the same way for a lead, property, or work order in the Trash; bookings and projects have no soft-delete and were never affected. **Fixed:** the guard splits links into live and Trash (`scanCustomerLinks()`). Live links block exactly as before, and the refusal now names only the live ones. Trash-only comes back as `409 code:"trashed_only"` listing what is in the Trash; the customer page turns that into a second confirm naming what will be permanently deleted, and re-issues `DELETE ?purgeTrashed=1`, which removes those Trash records and then the customer. Deleting nothing until the confirm is what keeps the restore case honest — a record restored between the refusal and the confirm is live again and re-blocks, re-checked at the moment of the write, not just at scan time. **Invoices never purge this way:** a deleted invoice leaves `invoices.json` entirely for the append-only tombstone log, so an invoice reference is by construction live and still blocks — the money line JOB-011 specced holds here for free. Purge order is Trash records first, customer second: a failed write leaves a state Patrick can retry from rather than stranding the records. Also fixed in passing: the refusal pluralises ("1 quote", not "1 quotes"). **Verified:** 35 assertions in `scripts/test-customer-delete-trashed.mjs` (in `build:check`) covering live-blocks, trash-only, the confirmed purge touching no other customer's records — Trash records included — the restore race, the no-soft-delete stores, and the clean-customer path; plus a live run against a booted server with a seeded trashed quote (409 `trashed_only` → confirm → 200, quote and customer both gone, nothing else moved). **Not JOB-011:** that job's full cross-store purge (magic-tokens, review-requests, backup snapshots, the money-line preview) is still unscoped work. This is the narrower defect — the guard was counting records that are not links. |
| CRM-06 | **CLOSED 2026-08-09 — walked live.** `/commercial-new-customer` served the residential canonical tag, title, and meta description; page content differs (rendered client-side) but metadata was never differentiated. **Fixed in `serveStatic`:** the commercial route serves the same single-source `new-customer.html` with `<title>`, canonical, meta description — and, per Patrick's 2026-08-07 addendum ruling, the `<h1>` — rewritten to commercial variants. Exact-string replacement, so a drifted source string no-ops rather than breaking the page. **Patrick confirmed on production 2026-08-09: the hero reads "New commercial customer intake"**, which proves the rewrite branch executes on the live route. The three head tags were verified against the deployed `main` the same day — all rewritten on the commercial route, and `/new-customer` byte-identical to the file on disk. **Re-verified after PR #47** (The PJL Water Promise), which touched `new-customer.html`: its edit was confined to the footer block and one appended script tag, leaving all four exact-match source strings intact — the no-op risk this design carries, checked rather than assumed. The page is `noindex, nofollow`, so this was always about the browser tab, bookmarks and link shares, not ranking. |
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

**The CLAIM against this policy is FLOW-30 (Part 4), added 2026-08-29.** This section stays the
single source of the policy; `lib/warranty-claims.js` is the claim record and never restates a
term. `warrantyForWorkOrder()` is read-only to the claim flow.

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
| VD-11 | **AI chat transcript read-back** (2026-08-27) — `/admin/chats` and the CRM lead drawer now render a stored transcript as speaker turns instead of one block. Display only; storage, the POST upsert and the widget are untouched, and an unparseable transcript falls back to raw text. Verified in headless Chromium on both surfaces (turn attribution, escaping, mobile, open-row survives the 60s poll) and by 64 assertions in `build:check`. | Patrick to open one real conversation on `/admin/chats` and confirm it reads the way he wanted — and that the row previews now tell the chats apart. | Small |
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
- Part 4 unmapped chains: FLOW-20/21/22 (quote → delivered → accepted — the money path upstream of verified payments), FLOW-24 (form-failure alerting), FLOW-25 (AI diagnostic + its financial promise). **MISC-01 and MISC-02 both closed 2026-08-09** — footer taps and sitemap counters walked live; they are no longer parked.

---

# Part 4 — Unmapped

## FLOW-30 — Warranty claim intake → CRM queue → resolution — **UNMAPPED** (opened 2026-08-29)

**Hop chain (as built):**

1. Customer taps *File a warranty claim* on `warranty.html` → `warranty-claim.html`.
2. Form POSTs JSON to `POST /api/warranty-claims` (**public**; anti-bot gate first — honeypot,
   `_ts` time-trap, per-IP 5/10min, Turnstile). Files ride as base64 and are magic-byte verified
   by `validatePhotos(..., { mode: "wo" })` — the validator that already accepts PDF alongside
   images. Every field is mandatory server-side; the invoice copy is mandatory.
3. `warrantyClaims.create()` allocates the claim number inside the same read-modify-write as the
   append, so two simultaneous submissions cannot collide. Files land at
   `server/data/warranty-claim-files/<claimNumber>/<n>.<ext>`.
4. `warrantyClaimLink.crossCheck()` resolves customer (email → phone) → their invoices → the
   invoice named → property → work order → warranty window via `lib/warranty.js`. Result stored
   on the claim as `link`; the fuller read-side `context` is rebuilt on every CRM read so an
   edited customer record never shows stale on the page Patrick decides from.
5. Fan-out: customer acknowledgement + team alert to `info@` with the customer's files attached.
6. Patrick works it at `/admin/warranty-claims` → `/admin/warranty-claim/<number>`. Six actions:
   under review, contact customer, return email with questions, book for service call, resolved,
   denied. Each emails the customer, subject `RE: Warranty Claim File Number — <number>`.
7. Denied → the customer's status page offers a dispute gated on accepting the service-call-fee
   condition → claim re-opens as `disputed` and the team is alerted.
8. **Approved** (FLOW-30b) → `POST /api/warranty-claims/:id/approve` raises a `service_visit` at
   the linked property carrying `serviceFeeWaiver { reason: "warranty" }` and `wo.warrantyClaim`
   provenance. Claim goes to `approved` (still OPEN — the repair is owed) and the customer is
   emailed that there is no charge.
9. Tech attends. The WO shows a green "Warranty repair — no charge" banner naming the claim and
   the prior invoice / work order being honoured.
10. **The escape hatch.** If the fault isn't what the claim described, removing the waiver via
    the existing `POST /api/work-orders/:id/service-fee-waiver` requires a written reason,
    restores the $95 service call, stamps `wo.warrantyClaim.converted`, moves the claim to
    `converted` (terminal, not disputable — they signed on site) and emails the customer the
    reason. `POST /on-site-quote/accept` still demands a drawn signature + acknowledgement, so
    the now-chargeable work cannot be accepted unsigned. After the completion signature the WO
    locks and any further change needs `unlockWorkOrder()`.

**Numbering:** `YYYY-MM-DD-000YYYYNNNN` — filed date, then `000` + year + a four-digit per-year
sequence that resets each January. e.g. `2026-08-29-00020260001`. The sequence is derived from
the max already issued in the store, not from a counter file, so a restored backup cannot
re-issue a number. The number is the record id and the on-disk directory name, and is validated
against `CLAIM_NUMBER_RE` at every filesystem and route boundary.

**Two credentials, never mixed:** the CRM API is admin/tech-gated in `needsAuth()`; the
customer's routes carry the claim's own 32-hex `statusToken` in the query string, checked
against the claim number in the path so one claim's token cannot open another. The claim number
is sequential and therefore guessable — it identifies, it does not authorize.

**Reminders:** open claims drive a nav badge on every admin page; open-and-untouched-for-24h
claims drive a band at the top of the queue and a 12-hourly digest to the team. The digest sends
NOTHING when nothing is stale, and does not run on boot (a deploy would re-send it).

**What is verified:** 138 node assertions in `build:check` (mutation-tested); a 101-assertion
live-server walk covering validation, magic-byte rejection, anti-bot, numbering and sequence,
token scoping, cross-claim token isolation, path traversal, admin gating, the deny → dispute →
book → resolve cycle, and the cross-check against seeded customer/property/WO/invoice records;
headless Chromium over all four new pages at 1280px and 390px (no console errors, no horizontal
overflow).

**What is NOT verified — the walked acceptance still owed:**

- **No email has been sent through live Gmail.** Every template is asserted at the builder
  level and every route's send path is exercised, but `getTransporter()` returns null without
  `GMAIL_USER` / `GMAIL_APP_PASSWORD`, so no message has actually left the box. Send one real
  claim end to end and read all four emails (acknowledgement, team alert with attachments,
  a status update, a denial) in a real inbox before trusting this.
- Turnstile is exercised only in its test-key configuration.
- The booking hand-off mints a session and the session resolves with the claim's context, but
  no one has walked it through to a confirmed booking and an opened work order.
- The 24h reminder digest has not been observed firing on a real clock.

**Status:** UNMAPPED until the above is walked. The flow is complete and defensible in code; it
has not been proven against live third parties.

---


Nothing below has been walked. Assume nothing works until verified.

| ID | Flow | Note |
|---|---|---|
| FLOW-20 | Quote written → delivered to customer | Money moves here. **QUOTE-01 (found + fixed 2026-08-18, still UNMAPPED — needs a walked acceptance):** the customer-facing **PREPARED FOR** block on the proposal PDF took its address from the SERVICE-address chain in `quoteRenderParties` (`server/server.js:2697`) — property → lead → most recent lead/work order by email → billing address — and `quote-pdf.js` then re-applied the same bias with `property.address \|\| customer.address`. Every rung above the last is a project/site address, so the customer's own address could never win. On an account with several concurrent sites the document was addressed to whichever OTHER site had been adopted or worked most recently. **Observed on Q-2026-0067:** a Norwood site address (`4293 ON-7`) printed on a Dundalk McDonald's proposal for GreenTree Construction Inc.; the NAME was correct, only the address was wrong. **Not a regression** — `git log -L` puts both the renderer block and the resolver at the repo's root commit (`a9f17de`, 2026-08-01) with no edit since; the recent `80d12b0` touched only a `BRANCH_LABELS` entry. It is a latent design flaw that only surfaces once a customer has more than one site. **Fixed:** a new draft-editable `quote.preparedForAddress` field, resolved by `billingParties.resolvePreparedForAddress()` in the inverse order — explicit override → the customer's OWN address → the service address only as a last resort, never a property record. Presentation only: no change to the service address a crew works from, pricing, totals, HST, QuickBooks, or the frozen-PDF contract. Draft-only (in `SCOPE_PROTECTED_FIELDS`), so it freezes at send with the rest of the document. Covered by `scripts/test-prepared-for-address.mjs` (23 assertions, in `build:check`). **What still needs Patrick:** open Q-2026-0067 in the builder, confirm the field defaults to GreenTree's own address, and download the PDF to see the Norwood address gone. **QUOTE-02 (added 2026-08-18, needs a walked acceptance):** line items now carry an integer `order` and the quotation renders by it — ↑/↓ controls on each row in the proposal builder, mirroring the narrative-section reorder. **Why a field and not array position:** `mergeQuoteLines()` (`sitebuilder.html:5250`) rebuilds `lineItems` in canonical order (mainline, controller, Zone 1..N, then manual lines) on EVERY "Generate quote" re-sync, so order held as array position is destroyed by the next sync; held as a property it survives, because the merge carries a matched line's own fields across. **Display only, asserted not assumed:** `computeProposalTotals` sums `lineTotal` across the array — a sum, not a scan — so no arrangement moves the subtotal, HST or total, and qty/unit price/line total travel with the line. **Zone labels are NOT position-derived and are left alone:** `Zone ${i+1} — ${name}` is generated once from the Site Builder's own zones array (`sitebuilder.html:5170`) and is a frozen string by the time it reaches `lineItems`, so moving a line cannot renumber a zone. Draft-only — `lineItems` is already in `SCOPE_PROTECTED_FIELDS`, which also keeps the positional `decisions[].lineItemIdx` pointers (`server.js:9270`, `:16685`, `:16983`) safe, since those are only written at accept time. One shared sort (`server/lib/line-item-order.js`) serves the PDF and the HTML proposal page; the browser builder carries its own comparator and a test pins the two together. Covered by `scripts/test-line-item-order.mjs` (47 assertions, in `build:check`). **What still needs Patrick:** arrange a real stack in the builder — flow meter to the top — download the PDF, and confirm the sequence matches and the totals did not move. **QUOTE-03 (found + fixed 2026-08-28, needs a walked acceptance):** the generated HTML proposal page (`proposal-html.js` + `proposal-assets/*-theme.css`) had **no side margin on a phone** — reported from a screenshot of Q-2026-0074, where "HOW THE SYSTEM WORKS", its lead paragraph and the card stack all started at x=0 while the green hero above them kept its gutter. **Cause: a cascade collision, not a missing rule.** The page's one wrapper is `.wrap { max-width:1180px; margin:0 auto; padding:0 var(--gut) }` and sections are emitted as `class="sec wrap"`; `.sec` is declared LATER in the same stylesheet at equal specificity and used the `padding` SHORTHAND (`padding:clamp(52px,8vw,100px) 0`), whose `0` horizontal component silently overwrote the gutter. Same defect on `.close` in the lighting + combined themes (`class="close wrap"`); the hero was never affected because `.hero-in` declares no padding. **Why desktop looked fine:** above 1180px the wrapper's max-width + auto margins still leave ~130px of empty page each side, so the section merely sat 64px out of alignment with the hero — the gutter only becomes load-bearing once the viewport is narrower than 1180px. **Fixed:** `.sec` / `.close` converted to `padding-top` / `padding-bottom` longhands in all three themes (sprinkler, lighting, combined) so they can never touch the inline axis. **Presentation only** — CSS in the theme assets; no change to `proposal-html.js`, the data adapter, pricing, totals, the PDF renderer, or the frozen-PDF contract (the PDF is pdfkit and shares none of this CSS). **Measured in headless Chromium** at 320/360/390/430/768/900/1180/1440px, sprinkler + lighting + combined + smart-controller: section heading left edge went 0px → the gutter at every width below 1180, and the hero, sections and closing block now land on the same left edge at all widths, with no horizontal overflow. Guarded by `scripts/test-proposal-gutter.mjs` (17 assertions, in `build:check`), which reads which classes the generator actually pairs with `wrap` and fails on any `padding` shorthand declared after `.wrap` — so a future theme or section that reintroduces the collision fails the build instead of shipping to a customer's phone. **What still needs Patrick:** open a real proposal link on a phone and confirm the left margin is there from the hero all the way down. |
| FLOW-21 | Quote viewed → accepted | **Quote View Tracker added 2026-08-29 — UNMAPPED, needs a walked acceptance.** The "viewed" half of this flow had no implementation at all: no `viewedAt` field, no open tracking, no app-level request log. `server/lib/quote-views.js` is an append-only ledger at `server/data/quote-views.json` recording CUSTOMER opens at five points — `gate_challenge` (the phone gate was shown), `gate_unlocked` (they passed it), `document` (the designed proposal page was served), `sign_page` (the standard accept page loaded), `pdf` (they downloaded the print-to-sign copy). **Why a separate file and not a field on the quote — this is the load-bearing decision:** `quotes.js` is read-modify-write over the whole `quotes.json` with no lock, and a page view is a high-frequency customer-triggered write. Interleaving one with `recordPortalSignAcceptance()` could drop an acceptance. Worst case here is a lost VIEW, never a lost signature. **Staff are never recorded** — `recordQuoteView()` (`server/server.js`) drops the call when `requireUser()` resolves, so Patrick previewing his own proposal does not register as a customer open; it also reads ip + user-agent SYNCHRONOUSLY before its first await, because the fire-and-forget call can otherwise outlive the socket and record a blank IP. Repeat views of the same kind from the same IP inside 30 minutes fold into one entry with a `repeats` counter — one person reading for twenty minutes is one view, not forty. Surfaced on every quote-folder row in three states: *Opened N× · last <when>*, *Not opened yet*, and **Blocked at phone gate** — that third one is the point of the feature, since "they tried and could not get in" previously looked identical to "they never bothered". Read via `GET /api/admin/quote-folder/views` (all) and `GET /api/admin/quote-folder/:id/views` (one, with raw events); both inherit the existing staff gate on that path prefix. Covered by `scripts/test-quote-views.mjs` (41 assertions, in `build:check`) plus a live-server walk: anonymous customer views recorded with IP and user-agent, three authenticated staff views recorded nothing, both endpoints 401 anonymous / 200 authenticated. **What still needs Patrick:** send a real proposal, open it as the customer from a phone off the office wifi, and confirm the row moves from *Not opened yet* to *Opened*; then open the same link while logged into the CRM and confirm the count does NOT move. **Acceptance methods:** the `pdf_return` path (customer prints, signs, returns the PDF; admin attests via `confirm-pdf-acceptance`) is reported by Patrick as walked and working, 2026-08-29 — recorded as his report, not as an observed walk. The `portal_esign` path is still unwalked. |
| FLOW-22 | Invoice generated → delivered | **Accompanying letter added 2026-08-20 — needs a walked acceptance.** An invoice can now carry an optional letter (repair summary / written record) that ships with the invoice email as a **second PDF** on PJL letterhead. Composed in a formatting editor on the invoice page; stored on the record as `invoice.letter` = `{enabled, subject, body, updatedAt, updatedBy}`. **Presentation only** — it never touches line items, totals, tax, the payment ledger or the QuickBooks push, and `scripts/test-invoice-letter.mjs` (33 assertions, in `build:check`) pins that with source guards: the renderer carries no currency formatter and no financial field, and every `HST` in it is the GST/HST registration rather than a tax calculation. **The invoice always wins:** the invoice PDF is the first attachment, a letter that fails to render is caught and reported as a warning while the invoice still goes out, and a malformed attachment is dropped before nodemailer sees it. Body is a plain string in the **same markup vocabulary `quote-pdf.js` already parses** (`**bold**`, `__underline__`, `*italic*`, `- ` bullets, `1.` numbered) — `server/lib/letter-pdf.js` reuses `parseSectionBody` rather than carrying a second dialect, so the stored record never becomes a rich-text schema. The editor is a `contenteditable` with a toolbar that serializes to that markup on save; paste is taken as plain text. Round trip verified in Chromium across 15 cases including styled spans, `&nbsp;`, `<div>` blocks, `<br>` and empty trailing nodes. The letter is dated from the **invoice**, not from render time, so a resend cannot re-date an August document. Editable while the invoice is not void (unlike `billTo`, which locks at draft) — it is a report, not part of the issued financial document. **NOT frozen at send:** a resend re-renders from the current record, so an edited letter resends changed. That matches how invoice PDFs already behave (see below) and is recorded here as a known property, not an oversight. **What still needs Patrick — see the acceptance test in the commit.** |
| FLOW-22a | **Invoice PDFs are re-rendered on demand, never frozen** — **OPEN, no fix shipped** | Found 2026-08-20 during the letterhead investigation (`docs/LETTERHEAD_REFACTOR_INVESTIGATION.md`). Unlike POs, WO reports and quotes — all three of which freeze their customer-facing PDF to disk with a recorded path — invoices carry **no `pdfPath`**. All six call sites (customer email, portal view, admin download, Stripe receipt, deposits, project-complete) call `generateInvoicePdf` and render fresh from the live record. **A reprint of a paid invoice can therefore differ from what the customer was sent**, and any future change to `invoice-pdf.js` retroactively restyles every invoice ever issued. Freezing them is a separate architectural decision, not a refactor — recorded here so it is a known risk with an owner rather than a surprise. |
| FLOW-24 | Form failure → does anything alert Patrick? | Contact page shows "Your message didn't send." Unknown whether that failure is logged anywhere. |
| FLOW-25 | AI diagnostic tool (`/sprinkler-repair.html`) | Carries a financial promise: "correct diagnosis = 1 hr labour free." Runs on Cloudflare Worker + API key — a dependency chain separate from Render and from email. |
| FLOW-27 | **Material List → RFQ → cheapest price → PO** — **UNMAPPED** (opened 2026-08-16) | Hop chain: **ML-… `need` lines → shop or split → RFQ-… per supplier → send (PDF+CSV, no prices) → vendor replies → `recordQuotedPrices` → compare by SKU → apply cheapest to the parts catalog → ML reprices → PO-…**. The supplier half of the money path, and it had **no registered flow and no test coverage at all** before this. `scripts/test-rfq-shopping.mjs` (39 assertions, in `build:check`) now covers the pure logic, and a live-API walk covered the routes: shop mode gives every supplier the whole list including SKUs with no supplier assigned; an outgoing line carries no price of ours and its frozen CSV names no other supplier, no material list and no price column; two suppliers each win different SKUs; **applying a quote dearer than one already recorded for the same list is refused with a 409 naming the SKUs** (this was silently overwriting the cheaper price before); apply-cheapest writes the winner of each SKU with the source RFQ attributed; and asking for quotes never moves a line off `need`. **What is NOT covered and needs Patrick:** the email leg (this sandbox has no SMTP credentials, so `markSent` was called directly), a real two-supplier round trip with genuine replies, and confirming the resulting PO prices against an invoice. |
| FLOW-26 | **Site Builder design → Quote + Material List** — **UNMAPPED** (opened 2026-08-13, Site Plan Underlay brief) | Hop chain: **traced geometry → `compute()` → `desiredQuoteLines()` → `syncQuoteFromDesign()` → Q-… → `generateMaterialList()` → ML-…**. This is the design half of the money path and it feeds **FLOW-20** (quote written → delivered), also UNMAPPED. Every hop exists in code and each was exercised in a scripted browser walk of `/admin/sitebuilder` (see the acceptance notes below), but **that is not a walked flow** — mark PASS only after Patrick has walked it end to end and observed each hop with a real tender. **What the scripted walk did establish, on a synthetic known-scale sheet:** a 100.0 ft × 60.0 ft rectangle uploads, calibrates and traces to **6,000.0 sq ft (0.000% error)**; the same drawing exported at a different DPI calibrates to the same real-world dimensions; a deliberately 2×-mistyped calibration dimension produces a **failed** verification and **blocks tracing**; the stated-scale cross-check agrees on a to-scale sheet and flags a fit-to-page export; traced geometry flows into head count, zone count and GPM; the design saves and restores across a reload; recalibrating a traced-over sheet is refused naming the dependent area; and the customer quote sheet renders the traced geometry with **no underlay**. **Master plan (added Aug 2026):** the same scripted-walk standard — every traced area renders on one sheet in the calibrated frame coloured by its real valve; drip beds sharing a valve resolve to ONE colour; the point of connection, manifolds and mainline place by click, drag in sheet feet, measure to the hand-computed length (300.000 ft over two legs), tee to the nearest point on the run rather than back to the start, assign every valve to its nearest manifold with none lost or double-counted, survive a save + reload at blob `version: 5`, and — checked explicitly — **a 1,400 ft mainline does not move a single line of the material list**. **Laterals (layer 3):** each valve's run is verified to be the true minimum spanning tree from its manifold (91.623 ft on a four-head lawn where a pipe-per-head would be 107.781), the branches leaving a manifold sum to exactly the valve's flow with no segment carrying more than it delivers, a drip bed taps the point on its outline nearest the manifold, sizes never fall below the 3/4" actually stocked, a bed split across several valves draws one distinct path per valve rather than three lines on top of each other, and moving manifolds 700 ft apart still moves nothing in the material list. **Tees and control wire (layer 4):** a branching mainline measures each leg once (100+80+80) rather than doubling back through the branch; deleting a node mid-branch splices it out and reattaches its children; the wire trunk carries every valve while each branch carries only its own box; conductors round up to real spool sizes; a mainline stub past the last box carries no wire; gauge steps 18→16→14→12 AWG with run length; a version-5 chain migrates to parent `i-1` and measures the same run it always did; a circular parent re-roots to the POC rather than dropping pipe; and 2,100 ft of main and wire still moves nothing in the material list. **Valve-to-box assignment (layer 5):** a valve defaults to its nearest box and can be overridden by hand; the override is stored against the box's **id**, so deleting a *different* box does not silently hand the valve to whichever box inherits that array position; inserting an area renumbers the valve list without moving any assignment; dragging a box does not assign the selected valve while clicking it does; deleting a box warns and releases its valves; an assignment pointing at a vanished box is reported and falls back to nearest rather than being obeyed; one for a valve that no longer exists is dropped on save; a version-6 sheet gets ids minted on load and starts fully automatic; and re-assigning valves between boxes moves nothing in the material list. **What is NOT covered and needs Patrick:** a real multi-page tender PDF (thumbnail legibility, sheet choice, underlay readability at working zoom); a traced area against a **hand-measured real bed** agreeing within 2%; and the full hop out to a live Q-… and ML-… on a real project. |
| FLOW-28 | **Portal "Book your seasonal service" → booked appointment** — **UNMAPPED** (opened 2026-08-19) | Hop chain: **property portal button → `POST /api/portal/:token/begin-booking` → `bookingSessions.createSession({ suggestedService, customerHints })` → redirect to `/book.html?session=…` → `js/booking.js` `applySessionPrefill()` → service locked in via `fromSessionHandoff` → `bestLandingStep()` skips to the first empty step**. This is the existing-customer express path and it had no registered flow. **Defect found and fixed 2026-08-19 (seasonal CTA brief):** `begin-booking` composed the tier key by hand as `` `${season}_${zoneCount}z` ``, which is a real key for **only 4 of 50 zone counts** (4, 6, 8, 15). Every other count produced a key `BOOKABLE_SERVICES` does not contain; `booking.js` honours `suggestedService` only when it resolves, and otherwise falls through **in silence** — so the handoff collapsed to the generic unfiltered catalog (spring cards first, whatever the season) with no error anywhere. It survived because 4 and 8 are the counts anyone would spot-check. Now resolved through `deriveSeasonalKey()` (pricing.json `seasonal_tiers`), which the same file already imported. **Second defect fixed in the same change:** the key was always residential, so a **commercial** customer was handed a residential tier — and because a session handoff *locks the service in*, they would be booked at the residential price with no chance to correct it. That was live for commercial properties with exactly 4 zones. The endpoint now reads `customer.accountType` via `property.customerId` and picks the matching tier table. `scripts/test-seasonal-handoff.mjs` (584 assertions, in `build:check`) pins every zone count 1–50 × both seasons × both account types to a bookable key in the right bracket, and a source guard fails the build if a seasonal key is ever composed by interpolation again. **Entry point — read this before testing.** The Book button lives ONLY on the **property portal**, which is a different surface from the customer portal. `GET /api/portal/:token` resolves the token as a **lead** first (→ `portal` payload → `renderPortal()`, the normal customer portal, which has **no booking CTA of any kind**) and only falls back to matching a **property** token (→ `propertyPortal` payload → `renderPropertyPortal()`, which has the button). The property-token link is minted by the seasonal outreach engine (`server/lib/outreach.js` `buildPortalLink()` → `<base>/portal/<propertyToken>?season=spring|fall`) and reaches the customer by email from `/admin/outreach`. **Opening a customer's portal from the CRM will never show this button** — that is the wrong door, not a bug in this flow.

**Patrick's acceptance test — not yet walked:** (1) go to `/admin/outreach`, pick a candidate whose property has a zone count that is **not** 4, 6, 8 or 15 — 7 or 12 is ideal, since 4/6/8/15 are the only counts the old code got right and prove nothing — and either copy that row's portal link or use **Send test** to mail it to yourself; (2) open the link and confirm the property portal renders with the Book button; (3) tap it and confirm book.html opens on that customer's season showing **only** that season's cards, with the tier matching their zone count pre-selected, not the full 19-service menu; (4) confirm the zone count and address are pre-filled and the flow lands on the time picker, not step 1; (5) repeat for a **commercial** account and confirm a commercial tier is chosen, not the residential one; (6) complete one real booking and confirm the work order carries the tier and price you expected. Mark PASS only after all six.

**Second entry point added 2026-08-19 — customer portal.** The customer portal had no route into booking at all: its `service_complete` state said *"Book again any time."* and the page carried no link to `book.html`, seasonal or generic. It now renders a **Book a service** card with one row per property the customer owns (`portalPayloadForLead` → `bookableProperties`, scoped by `customerId`). A property with a zone count on file, not already booked for the season, gets the seasonal express CTA — the same handoff the outreach email gives; one with no zone count, or already booked, gets a plain link to `book.html` rather than a guessed tier. Season comes from `outreach.seasonForBooking()` (inside a window, that season; between windows, the next one to open) so the portal CTA and the outreach candidate list can't disagree about when a season starts. **Updated 2026-08-26 (season config):** the window it reads moved from the hardcoded `SEASON_WINDOWS` constant to `seasons.json` via `server/lib/seasons.js`, and fall 2026 now ends Nov 6 rather than Dec 15. That coupling was documented here as intentional and still is — it is what keeps the two surfaces agreeing — but it has a consequence worth stating plainly: **between Nov 7 and Dec 15 both CTAs (property portal and customer portal) now offer the coming Spring Opening rather than a Fall Closing.** Past hard frost a fall closing is work PJL cannot perform, so offering it was the defect, not the fix; taken as a deliberate decision rather than preserving it behind a second fall end date living only in `seasonForBooking()`. Zone-count tier resolution, ownership checks, and the handoff itself are untouched.

`POST /api/portal/:token/begin-booking` now accepts **both** token shapes, resolving lead-first exactly like the GET route: a **property** token works as before (no `propertyId`, outreach path untouched), and a **lead** token requires `?propertyId=` and is checked against the token holder's `customerId`. **The property's own portal token is never sent to the browser** — the customer portal payload carries only `propertyId`, so a portal link can start a booking for that customer's properties and nothing else. An unowned property and a nonexistent one both answer `404 Property not found`, so the route can't be used to probe which ids are real. Both properties are pinned by source guards in `scripts/test-seasonal-handoff.mjs`, each verified to fail the build when the check is removed.

**Verified against a live local server** (two seeded customers, three properties): Alice's portal lists her two properties and not Bob's; her 7-zone property mints `fall_close_8z` with the zone count and address pre-filled; Bob's **commercial** 12-zone property mints `fall_close_commercial_9plus`; booking Bob's property from Alice's token returns 404, as does a nonexistent id; a lead token with no `propertyId` returns 400; the property-token outreach path still mints a session unchanged. Walked in Chromium at 390 px and 1280 px — both CTAs render, no horizontal overflow, and tapping the seasonal one lands on **book.html step "Pick a time"** with the service locked in.

**Patrick's acceptance test for this half — not yet walked:** (1) open a real customer's portal from the CRM and confirm the Book a service card lists **their** properties and only theirs; (2) tap the seasonal CTA on a property whose zone count is not 4/6/8/15 and confirm book.html opens on the time picker with the right tier; (3) confirm a property with no zone count on file offers the plain "Book a service" route instead of guessing; (4) confirm a property already booked for the season says so and offers the plain route; (5) complete one real booking and check the work order carries the tier and price you expected. **Touches FLOW-02 (PASS)** — re-verify portal messaging and preferences still work after this change. |
| FLOW-29 | **Seasonal outreach opt-out → the customer stops being mailed** — **UNMAPPED** (opened 2026-08-25) | Hop chain: **property page checkbox → `collectForm()` → `PATCH /api/properties/:id` → route sanitizer → `properties.update()` → `properties.json` → `hydrate()` on every read → `outreach.listCandidates()` eligibility + per-channel gate → `outreach.send` per-recipient gate**. Reported by Patrick as "I cannot opt a customer out of seasonal outreach." **OUTREACH-01 (found + fixed 2026-08-25):** the PATCH route sanitizes the body against an allow-list (`customerName`, `customerPhone`, `address`, `billingEntity`, `billingCcEmail`, `siteContacts`, plus `system` and `seasonalPricing`) — and **neither `seasonalEligibility` nor `commPrefs` was on it**. The property page sent both on every Save profile; the route dropped them, returned `200 ok:true`, and `populateForm()` redrew the checkboxes from the unchanged record, so all four boxes visibly snapped back on. Nothing logged, nothing failed. `properties.setSeasonalEligibility()` existed in the lib with **zero callers** — the CRM-side write was never wired at all, and the only opt-out that ever worked was the customer's own unsubscribe link. The read side was always correct (`listCandidates` and the send loop both gate on `!== false`), so the moment the write lands the customer disappears from the list. Fixed via `properties.sanitizeSeasonalConsent()`, called from the route: it passes only the four consent flags plus `reviewRequestsEmail`, never `commPrefs.optOutTokens` (those are unsubscribe-link secrets and must not be settable from a request body), and it **rejects** a flag it can't read rather than coercing it — `Boolean("false") === true` would silently re-subscribe someone who just asked to be left alone. **OUTREACH-02 (found + fixed in the same change, separate defect):** `properties.hydrate()` rebuilds `commPrefs` key by key and omitted `reviewRequestsEmail` and `optOutTokens.reviewEmail`. `readAll()` writes hydrated records back, so this didn't merely hide those values — it **deleted** them. A customer who unsubscribed from review-request emails was re-subscribed by the next read, and because `mintOptOutTokensIfMissing()` then re-rolled the review token on every send, every unsubscribe link already sitting in a customer's inbox was dead. Both channels are CASL-relevant. `scripts/test-seasonal-consent.mjs` (43 assertions, in `build:check`) pins both directions of every flag, the token slots against clobbering and re-minting, and carries source guards that fail the build if the route stops calling the sanitizer or if `hydrate()` drops a `commPrefs` key again. **Verified against a live local server:** with the fix reverted, a PATCH with all four boxes unticked answers `ok:true` and echoes every flag back as `true`, and the property stays in the spring candidate list — the reported symptom exactly. With the fix in, the same PATCH stores `false`, survives a reload, and the property drops out of the candidate list while an opted-in neighbour stays. **Patrick's acceptance test — not yet walked:** (1) open a real property in the CRM, untick Spring Opening, Save profile, **reload the page** and confirm it is still unticked; (2) go to `/admin/outreach`, pick spring, and confirm that property is no longer in the candidate list; (3) untick only Seasonal SMS reminders on a second property and confirm it still appears but is email-only; (4) re-tick everything and confirm it comes back; (5) confirm an unsubscribe link from a **previously sent** review-request email still resolves rather than reading "link invalid". |
| MISC-01 | **CLOSED 2026-08-09 — they do not 404. Never was a broken link.** **Acceptance walked by Patrick 2026-08-09: all four footer links tapped on the live site, all load, no 404s.** That closes the one gap the sandbox couldn't: outbound to the live host is blocked from the build environment, so JOB-009's evidence was four local 200s off a booted server plus the static facts — all four pages exist, each is referenced by **84 pages** (the sitewide footer), and all appear in `sitemap.xml`. Production now confirms it directly. The only real defect was that **`sitemap.html`** — the human-readable Site Map page, *not* `sitemap.xml` — omitted them from Service Areas; added in JOB-009 (footer ordering, descriptions from each page's own meta description). **`sitemap.xml` was never part of this defect** and has carried all 18 city URLs since ccf7604 (2026-07-15); it has no server route and ships as a static file. **Verified against production 2026-08-09** (Patrick supplied the live file as a PDF; outbound is blocked from the sandbox): **81 live URLs vs 81 in the repo, sets identical, all four cities present** — the live XML is not stale and never was. Worth keeping on record: checking the XML to verify an HTML-page fix is an easy wrong turn, and the four are easy to miss in it — the slugs are hyphenated (`lawrence-park`, not "Lawrence Park", so a find-in-page for the footer's label fails) and they sort alphabetically among the 18 rather than appearing as a new block. |
| MISC-02 | **CLOSED 2026-08-09 — walked live.** `sitemap.html` section counters were stale: "Services · 10 pages" listed 11; "Book / Quote / Estimate · 3 pages" listed 4. Corrected in JOB-009 (Services 11, Book/Quote/Estimate 4, Service Areas 18 after the MISC-01 rows). **Patrick walked the live page 2026-08-09: every section counter matches its list.** Audited against the deployed file the same day — 6 / 12 / 4 / 18 / 15 / 4, all six matching. **Services now reads 12, not the 11 JOB-009 set:** PR #47 (The PJL Water Promise) added a service page and correctly bumped the counter with it — the discipline survived a change by another hand, which is the real test of this fix. Blog's 15 is a deliberately curated subset (~39 blog pages exist; `blog.html` is the full index), left as is. |

---

# Part 5 — Dispatch rules

The drift came from delegated jobs shipping changes nobody read or verified.

1. **One job at a time** on the backend.
2. **Every job names the flow IDs it touches**, from this register.
3. **Every job ships with a written acceptance test** — the exact taps Patrick performs, as a customer.
4. **A job is not done** until Patrick has run that test and updated this file.
5. **No job touches a flow marked PASS** without re-verifying it afterward.

---

# Part 6 — Recorded architectural deviations

Conscious departures from the codebase's own conventions. Recorded so they
are decisions with owners rather than drift someone finds later.

> **DEV-01 — Hardcoded install pricing (accepted 2026-08-13).**
> `INSTALL_PRICING` in `server/sitebuilder.html` hardcodes `perZone: 549`,
> base `585` / `749`, and controller `595` / `750` / `1195`, duplicating the
> `pricing.json` keys `new_install_per_zone`, `new_install_t1_base`,
> `new_install_t2_base`, `controller_1_4`, `controller_5_7`,
> `controller_8_16`. **All six values re-verified against `pricing.json` on
> 2026-08-13 and matching** (549 / 585 / 749 / 595 / 750 / 1195). Note separately
> that the builder's `baseByZones` is `n<=4 ? 585 : 749`, so an 8+ zone job is
> quoted the Tier 2 (5-7 zone) base — the code comments this ("8+ uses t2, edit in
> quote") and it is priced by hand in the proposal, but it is a second way this
> block can disagree with `pricing.json`, and not one the linter would catch either.
> `scripts/lint-no-hardcoded-prices.mjs` scans **root-level `*.html` only**,
> so `server/` sits outside the build gate and drift here will NOT be caught.
> Any change to those `pricing.json` keys must be mirrored into that block by
> hand. Remediation deferred by owner decision; the durable fix is to read
> `pricing.json` at runtime and widen the linter's scope to `server/*.html`.
> Untouched by the Site Plan Underlay work — recorded, not introduced, by it.

> **DEV-02 — First vendored front-end library (accepted 2026-08-13).**
> Mozilla **pdf.js 4.10.38** (legacy build) is vendored as a static asset at
> `server/vendor/pdfjs/` to enable client-side PDF rasterization for the Site
> Builder's site-plan underlay. It introduces **no build step, no npm runtime
> dependency, and no server-side code path** — it executes only in the browser,
> only in the upload dialog. The alternative, server-side rasterization,
> requires a native binary (poppler / ghostscript) on Render Starter and was
> judged materially worse. Version, file checksums and the re-verification
> command are pinned in `server/vendor/pdfjs/VENDORED.md`; the tarball was
> checked against the npm registry's own `dist.shasum` before vendoring.

> **DEV-03 — `sitebuilder.html` is still monolithic (recorded 2026-08-13).**
> It is the only admin page carrying its CSS and JS inline instead of split
> into `.css` / `.js` siblings. The site-plan underlay work grew it rather
> than splitting it: a split is the right change, but not one to make on a
> tender deadline and not in the same commit as a new feature, where it would
> hide the feature diff inside a whole-file move. Its own piece of work.

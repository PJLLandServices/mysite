# PJL Land Services — System Overview

A snapshot of the full stack for a specialist or new contributor coming
in cold. Pairs with `PJL_OPERATIONS_DESIGN.md` (the canonical spec) and
`WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md` (deployment + SEO context).

## What this is

A single Node.js application that runs **both** the public marketing
site for PJL Land Services (irrigation + landscape lighting in
Newmarket / GTA, Ontario) **and** a full field-service management
platform: lead intake → CRM → booking → work orders → quotes →
invoices → materials & purchase orders → customer portal. There is no
SPA framework, no React, no build step beyond a small partials/HTML
sync. Plain HTML, plain CSS, vanilla JS, Node http server, JSON files
on a persistent disk.

## Tech stack

- **Runtime:** Node.js ≥ 18 (no TypeScript, no transpilation)
- **HTTP:** Node's built-in `http` module — `server/server.js` is a
  single ~6500-line dispatcher (no framework)
- **Storage:** Flat JSON files in `server/data/` on Render's persistent
  disk (1 GB). Each entity is one file. Rotate to SQLite at ~10k records.
- **Frontend:** Plain HTML + CSS + vanilla JS per page. Shared chrome
  via `_partials/nav.html` + `_partials/footer.html` synced into every
  public HTML by `node build.js`.
- **PDFs:** `pdfkit` (pure JS). Quote PDFs + Purchase Order PDFs.
- **Email:** `nodemailer` over Gmail SMTP (Google Workspace app password).
- **SMS:** Twilio (admin lead notifications only).
- **Maps:** Google Maps JavaScript API + Places Autocomplete.
- **Hosting:** Single Render Web Service ($7/mo Starter + 1 GB persistent
  disk). Domain `pjllandservices.com` via Squarespace DNS → Render IP.

Public deps (from `package.json`):

```json
"dependencies": { "nodemailer": "^8.0.7", "pdfkit": "^0.17.2" }
```

Everything else is built-in or vendored.

## Repository layout

```
/                                  ← public marketing site
├── index.html, about.html, contact.html, ...   (~55 public pages)
├── blog-*.html                                 (12 SEO blog posts)
├── sprinkler-service-<town>.html               (14 service-area pages)
├── style.css                                   (public site CSS)
├── coverage-checker.js                         (Google Places + Distance Matrix)
├── js/
│   ├── booking.js                              (public booking flow state machine)
│   ├── time-picker.js / time-picker.css        (shared month-calendar + slot picker)
│   ├── pricing-injector.js                     (HTML price spans -> pricing.json)
│   ├── sprinkler-builder.js                    (cost-tool builder)
│   └── chat-widget.js                          (in-page chat handoff)
├── parts.json                                  (hardware catalog — 129 SKUs)
├── pricing.json                                (service pricing — single source of truth)
├── _partials/{nav,footer}.html                 (build.js sources)
├── build.js                                    (partial-include sync)
├── PJL_OPERATIONS_DESIGN.md                    (canonical operations spec)
├── WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md      (deploy + SEO playbook)
├── SEO_IMPLEMENTATION_PLAN.md
├── SYSTEM_OVERVIEW.md                          (this file)
│
├── server/                                     ← Node backend + admin/portal UI
│   ├── server.js                               (the http server, all routing)
│   ├── lib/                                    (per-entity data + business logic)
│   ├── data/                                   (runtime JSON, gitignored, on persistent disk)
│   ├── *.html / *.js / *.css                   (admin + portal + login pages)
│   ├── tech-sw.js                              (ServiceWorker for offline tech mode)
│   ├── offline-queue.js                        (IndexedDB outbound queue)
│   ├── voice-input.js                          (Web Speech API helper)
│   └── crm-{nav,parts,reschedule,followup}.{js,css}  (shared admin components)
│
├── worker/                                     (Cloudflare Worker AI chat — not deployed here)
├── scripts/                                    (price linters + worker prompt rebuilder)
└── images/, *.jpg, *.mp4, etc.                 (static assets)
```

`server/` is the deployed app. Project root files are also served — Render
configures the public site root to be `/` and the `server/` directory is
mounted both as the Node entry point AND as `/crm/*` static assets.

## Server-side libraries (`server/lib/`)

One file per entity. Every lib is async, uses `node:fs/promises`, and
follows the pattern `list / get / create / update / remove` plus
entity-specific verbs. ID conventions in **UPPERCASE-PREFIX-YYYY-NNNN**
form except where noted.

| File | Entity | ID format | Purpose |
|---|---|---|---|
| `properties.js` | Property | `P-YYYY-NNNN` | Customer site profile (zones, valves, controller, blow-out, deferred issues, service records, seasonal eligibility + outreach state + comm prefs). One per physical address. Zones land with `pendingReview: true` when the WO completion cascade discovers them on-site (Brief D). **Name invariant** (feature-seasonal-outreach-brief §3.9): `customerName` must be non-blank at `create`, `update`, and `bulkUpsert` — validation rejects blank patches with `code: MISSING_NAME`. Helpers: `seasonKey`, `recordOutreachTouch`, `setSeasonalOptOut`, `setSeasonalCommPref`, `setSeasonalEligibility`, `mintOptOutTokensIfMissing`, `findByOptOutToken`, `auditMissingCustomerName`. |
| `work-orders.js` | Work Order | `WO-XXXXXXXX` (random alphabet) | One per visit. Zones, issues, photos, signature OR signatureBypass (mutually exclusive), on-site quote, materials packed, `paidOnSite`, `propertyEditsAppliedAt`, `intakeGuarantee.matched`, `history[]`. Lock-protected fields enforced via `SCOPE_PROTECTED_FIELDS` constant (Brief A). Bypass acts as a unified end-of-visit completion event covering both on-site quote acceptance (when builder has additions beyond baseline) and completion lock; bypass-completed WOs with `coversQuoteAcceptance: true` do NOT produce `on_site_quote` Quote records — `signatureBypass.acceptedScopeSnapshot` (deep-copied builder lines + totals) is the authoritative scope record. |
| `quotes.js` | Quote | `Q-YYYY-NNNN` | Versioned, signed estimate. Two flavours: `ai_repair_quote` (AI chat) and `on_site_quote` (tech-built). |
| `invoices.js` | Invoice | `I-YYYY-NNNN` | Auto-drafted by completion cascade, lifecycle draft → sent → paid → void. |
| `bookings.js` | Booking | `BK-YYYY-NNNN` | First-class appointment record. Mirrors `lead.booking` but is canonical. Exposes `cancel()` (soft, adds `cancelledAt/By/Reason` + history), `reschedule()` (sets `scheduledFor` + bumps `rescheduleCount` + history), and `remove()` (hard delete; refuses when a linked WO is past `scheduled` — caller passes `isActiveWo` to gate without coupling to work-orders.js). Schema includes `rescheduleCount` (capped at 1 for customer self-service via the portal endpoint; admin bypasses the cap). |
| `projects.js` | Project | `PROJ-YYYY-NNNN` | Multi-WO container for named jobs. Lifecycle planning → active → complete → archived. |
| `material-lists.js` | Material List | `ML-YYYY-NNNN` | Bill of materials. Line items reference parts.json SKUs + quantities + status (`need` / `ordered` / `have`). Attachable to a project / WO / quote / standalone. |
| `purchase-orders.js` | Purchase Order | `PO-YYYY-NNNN` | One supplier's slice of a material list's `need` lines. Lifecycle draft → sent → partially_received → received → cancelled. |
| `suppliers.js` | Supplier | `SUP-NNN` (no year prefix) | Vendor records (name, contact, email, phone, address). |
| `part-suppliers.js` | — | n/a | Override map at `data/part-suppliers.json` mapping SKU → supplierIds[]. parts.json's `supplierIds` field is a placeholder; this file is the source of truth. |
| `settings.js` | — | n/a | Admin notification preferences + 50-entry audit trail + iCal-feed token (Brief C: `icalFeed.{enabled, token, regeneratedAt}` — token is the credential for the public `/calendar/<token>.ics` feed) + `contactInfo.customerSupportPhone` (surfaced verbatim in portal blocked-state copy when self-service reschedule/cancel is refused; exposes `updateContactInfo()` for the `/api/settings/contact-info` PATCH endpoint) + per-season outreach templates (`outreachTemplates.{spring,fall}.{subject,smsBody,emailBody}`, saved via `saveOutreachTemplate`). |
| `ical-feed.js` | — | n/a | Builds the read-only `.ics` feed for iPhone Calendar subscription. Filters bookings to `status === confirmed` and a -90d / +365d window; uses stable `BK-…@pjllandservices.com` UIDs so reschedules update the existing event. |
| `ical-format.js` | — | n/a | Hand-rolled RFC 5545 helpers: value escaping, 75-octet line folding, Toronto VTIMEZONE block, local + UTC date formatters. |
| `completion-cascade.js` | — | n/a | Fires on WO status → completed. Idempotent. Creates service record on property, draft invoice (with `paidOnSiteAtCompletion` flag), customer + admin emails, warranty stamp. Applies property edits via `computePropertyEdits()` (Brief D — zone/controller diffs, new zones flagged for Patrick review) gated by `wo.propertyEditsAppliedAt`. Logs `cascade_fire`, `invoice_drafted` (when a draft was created), and `property_edits_applied` history entries. When the cascade throws mid-flight, the PATCH handler appends `cascade_failed` to the WO history and surfaces `cascade.error` in the response — the WO stays signed + locked + completed (recoverable via /run-cascade or /create-invoice). |
| `issue-rollup.js` | — | n/a | Maps zone issues into priced line items for the on-site quote. Manifold rule, controller subtype tier selection, etc. |
| `pricing.js` | — | n/a | `priceForBooking(serviceKey, zoneCount)` reads `pricing.json`. |
| `availability.js` | — | n/a | Slot generator + `BOOKABLE_SERVICES` catalog. Endpoints can pass `from`/`to` (YYYY-MM-DD); `expandDaysToRange()` backfills every day in the range with `{slots, reason}` so the month-calendar picker can render available + unavailable cells in one pass. |
| `schedule-store.js` | — | n/a | Calendar blocks + per-day hour overrides. |
| `geocode.js` | — | n/a | Google Geocoding wrapper + cache. |
| `distance.js` | — | n/a | Distance Matrix + Haversine fallback. |
| `quote-pdf.js` | — | n/a | Branded quote PDF (pdfkit). |
| `po-pdf.js` | — | n/a | Branded purchase order PDF (pdfkit). |
| `notify-email.js` | — | n/a | Admin email on new lead (Gmail SMTP). |
| `notify-sms.js` | — | n/a | Admin SMS on new lead (Twilio). |
| `notify-customer.js` | — | n/a | Customer-facing transition emails / SMSes (booking confirmed, on the way, etc). Also exports `sendBookingCancellation(booking, {reason, notify, baseUrl})` — fire-and-forget cancellation email triggered from `/admin/schedule` — and `sendOutreachEmail` / `sendOutreachSms` (feature-seasonal-outreach-brief.md §3.5) used by `outreach.js` for the bulk booking-nudge batches. Outreach senders append a CASL unsubscribe footer (email) and the literal "Reply STOP to opt out." line (SMS), idempotent against operator-supplied STOP. |
| `outreach.js` | — | n/a | Seasonal bulk-nudge engine (feature-seasonal-outreach-brief.md). Lists eligible properties per season+year (`listCandidates`), orchestrates per-recipient send through `notify-customer.js` with 300 ms Twilio + 100 ms Gmail pacing and a module-level concurrent-send lock (`sendBulk` → `{batchId, sent, skipped[], errors[]}`), derives "booked for season" state from bookings.json (`deriveBookingState`), validates and applies unsubscribe tokens (`honorUnsubscribe`), and persists per-season templates via `settings.js`. Hardcoded `SEASON_WINDOWS` (spring Mar 1 – Jun 30, fall Sep 1 – Dec 15) and `SEASONAL_SERVICE_PREFIXES` (`spring_open_`, `fall_close_`). |
| `notify-supplier.js` | — | n/a | Supplier email with PO PDF attachment. |
| `quickbooks.js` | — | n/a | OAuth + invoice push + items sync + Payments charges. Token blob encrypted at rest (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` or derived from `QB_CLIENT_SECRET`). Exports: `pushInvoice`, `pushItem`, `syncAllItems`, `listTaxCodes`, `listIncomeAccounts`, `getItemsMap`, `setItemMap`, `chargeCard`, `recordPaymentForInvoice`, `voidInvoice`, OAuth helpers. **Inert** until `QB_CLIENT_ID` / `QB_CLIENT_SECRET` env vars are set + admin connects via OAuth. |
| `booking-sessions.js` | — | n/a | AI handoff session storage (used by the chat widget). |

## Server-side data files (`server/data/`)

All gitignored. Live on Render's persistent disk. Hand-editing breaks
audit trails; modify only via the API.

```
auth.json                  ← session secret only (post-migration). NEVER reintroduce the single-password pattern.
users.json                  ← USR-NNN admin/tech accounts (per-user scrypt hash + salt). Created via npm run create-user.
magic-tokens.json           ← short-lived, single-use mt_<32hex> tokens (customer_login, admin_password_reset).
leads.json                 ← inbound leads (the CRM core; lead.id is the customer identity for portal sessions)
properties.json            ← customer site profiles (now includes seasonalEligibility, seasonalOutreach[YYYY:season].{touches[], optOutThisSeason}, and commPrefs.{seasonalRemindersSMS, seasonalRemindersEmail, optOutTokens}; customerName is required non-blank)
work-orders.json           ← per-visit field documents
quotes.json                ← Q-YYYY-NNNN records
invoices.json              ← I-YYYY-NNNN records
bookings.json              ← BK-YYYY-NNNN records
projects.json              ← PROJ-YYYY-NNNN records
material-lists.json        ← ML-YYYY-NNNN records
purchase-orders.json       ← PO-YYYY-NNNN records
suppliers.json             ← SUP-NNN records
part-suppliers.json        ← SKU → supplierIds[] override map
settings.json              ← admin notification defaults + audit
schedule.json              ← calendar blocks + hour overrides
booking-sessions.json      ← AI chat handoff state
geocode-cache.json         ← Google Geocoding response cache
distance-cache.json        ← Distance Matrix response cache
chat-transcripts.json      ← AI chat transcripts (every booking + every abandoned chat)
quickbooks.json            ← QB OAuth tokens (gitignored, Render-only, AES-256-GCM at rest)
quickbooks-items.json      ← PJL key/SKU → QB Item ID map (gitignored, Render-only)
photos/<leadId>/<n>.jpg    ← lead intake photos
wo-photos/<woId>/<n>.<ext> ← work-order photos (pre/in/post-work + per-issue)
```

## Admin / portal pages (`server/`)

Each admin page is one HTML + one JS + (sometimes) one CSS file. The
sidebar is duplicated in every page's HTML and synchronized by hand
when entries change. Standard sidebar order (17 items):

```
Today  ·  Messages  ·  CRM  ·  Schedule  ·  Handoff  ·  Outreach  ·
Bookings  ·  Customers  ·  Properties  ·  Projects  ·  Work orders  ·
Quotes  ·  Invoices  ·  Materials  ·  AI Chats  ·  Users  ·  Settings
```

Every admin HTML file includes `apple-mobile-web-app-capable="yes"` +
`apple-mobile-web-app-status-bar-style="black-translucent"` + viewport
`viewport-fit=cover` so the admin runs as a proper iPhone Home Screen
standalone app: the dark green topbar extends under the status bar
glyphs (no white sliver above), and `env(safe-area-inset-top)` reserves
inner padding so content sits below the time/bell/battery.

Pages with their primary route + purpose:

| Page | Route | What it does |
|---|---|---|
| `today.html` | `/admin/today` | Tech morning hub — today's confirmed bookings with navigate + notify + open-WO actions per row. |
| `admin.html` | `/admin` | Lead pipeline / CRM dashboard. Search, filter by stage, open lead detail card. Inline quote display + property link conflict detection. |
| `schedule.html` | `/admin/schedule` | Booking calendar. Block hours, manual booking creation. |
| `handoff.html` | `/admin/handoff` | Manual handoff — admin sends a customer a booking link + portal access. |
| `outreach.html` | `/admin/outreach` | Seasonal Outreach (feature-seasonal-outreach-brief.md). Picks Spring or Fall + year; lists every eligible property with its booking state, contact state, and opt-out state; filters; bulk-sends a portal booking link via email + SMS via `outreach.sendBulk`; per-season message template editor; backfill banner for properties with a blank `customerName`. |
| `bookings.html` | `/admin/bookings` | Bookings folder index — every booking record with customer + property + appointment state, filtered/searchable. Cards are a single-column vertical stack (`.bk-card` in `bookings.css`), consistent with the quote-folder rebuild — no horizontal multi-column treatment, same stack reads at every viewport. |
| `booking.html` | `/admin/booking/<id>` | Per-booking detail page. |
| `properties.html` | `/admin/properties` | Properties index (vertical list). |
| `property.html` | `/admin/property/<id>` | Per-property profile. Zones, valves, controller, blow-out, access notes, service records, deferred issues. |
| `properties-import.html` | `/admin/properties/import` | xlsx bulk import wizard. |
| `projects.html` | `/admin/projects` | Projects index. |
| `project.html` | `/admin/project/<id>` | Project detail. Editable header, attached WOs, attached material lists, status select. |
| `work-orders.html` | `/admin/work-orders` | All-WOs index. Status filter (default: active only), search, "Show completed + cancelled" toggle. |
| `work-order.html` | `/admin/work-order/<id>` | Desktop WO editor. Cheat sheet, AI bonus banner + decision buttons, zones, issues, photos, line-items + running totals + send-for-approval (Brief B), customer sign-off (gated on bonus decision), post-signature banner + Mark Complete CTA (Brief E), paid-on-site radio (Brief C), cascade-recovery actions, history viewer (Brief A). |
| `work-order-tech.html` | `/admin/work-order/<id>/tech` | Mobile-first tech mode. ServiceWorker-backed offline. Cheat sheet, carry-forward banner, AI bonus card with Match / Didn't Match buttons (Brief F), zone bottom-sheet edit, voice-input, on-site quote builder, customer review + signature canvas, materials checklist on follow-ups, payment-on-site radio, property-updates preview (Brief D), post-signature narrative banner (Brief E), history viewer (Brief A). |
| `quote-folder.html` | `/admin/quote-folder` | Quote index. Auto-expire sweep, PDF download, "Convert to project" per card. Cards are a single-column vertical stack (`.qf-card` in `quote-folder.css`) — no two-column treatment; same stack reads at every viewport. Card root navigates to the lead deep-link on tap; inner anchors/buttons short-circuit that. |
| `invoices.html` | `/admin/invoices` | Invoice index. |
| `invoice.html` | `/admin/invoice/<id>` | Invoice editor. Two-column layout (invoice document left, sticky admin actions right). |
| `material-lists.html` | `/admin/material-lists` | Material list index with parent + status filters. |
| `material-list.html` | `/admin/material-list/<id>` | Mobile-first builder. Search/browse catalog, qty steppers, parent picker, copy-from-past, sticky savebar with running totals, "Generate purchase orders" button. |
| `suppliers.html` | `/admin/suppliers` | Supplier records. |
| `parts-suppliers.html` | `/admin/parts-suppliers` | Bulk catalog assignment grid (SKU → primary supplier). |
| `purchase-orders.html` | `/admin/purchase-orders` | PO index. Status filter + "Show closed" toggle. |
| (Materials sub-nav) | — | The four pages above (`material-lists.html`, `purchase-orders.html`, `suppliers.html`, `parts-suppliers.html`) share a `.suppliers-subnav` strip duplicated by hand. Below 768px the strip collapses into a single `<details>` dropdown ("Materials → <current> ▾"); open/close behaviour lives in `crm-nav.js`. |
| `purchase-order.html` | `/admin/purchase-order/<id>` | PO detail. Send modal (email + PDF), partial-receive modal, reorder, cancel. |
| `chats.html` | `/admin/chats` | AI chat transcripts (booked + abandoned). |
| `settings.html` | `/admin/settings` | Notification defaults, audit trail, QB connect, exports. |
| `login.html` | `/login` | Per-user CRM login (email + password). Credentials live in `users.json`; `auth.json` is the session-secret store only. |
| `users.html` | `/admin/users` | Admin-only per-user account management (CRUD, disable, reset password). Tech role gets 403. |
| `customer-login.html` | `/portal/login` | Customer self-serve magic-link request page (email/phone/address → emailed login link). |
| `reset-password.html` | `/reset-password?t=<mt_id>` | Admin/tech password reset landing page (magic-token-gated). |
| `portal.html` | `/portal/<token>` | Customer-facing portal: project request, deferred recommendations (pre-authorize with signature), signed quotes, scheduled appointments, notification prefs. Self-service appointment moves: **Reschedule** (once per booking, >24hrs out) and **Cancel** (with captured reason, >24hrs out) — both gated server-side via `/api/portal/:token/booking-actions` preflight, with greyed buttons and a phone-fallback row when blocked. The permanent `<token>` URL stays valid; magic-link sessions redirect here after setting a `customer:<leadId>` cookie. **Server-side Open Graph substitution** (feature-seasonal-outreach-brief.md §3.8): handler reads the token + optional `?season=spring\|fall` query param, looks up lead → property → customerName, then string-replaces `{{ogTitle}}` / `{{ogDescription}}` / `{{ogImageUrl}}` / `{{canonicalUrl}}` placeholders in `portal.html` before responding. Produces a personalized iMessage / Slack / Facebook preview card per recipient. Canonical URL always uses `PUBLIC_BASE_URL` (production host), never `*.onrender.com`. |
| `unsubscribe.html` | `/unsubscribe/<token>` | **Public** confirm-then-POST page for the CASL unsubscribe flow. Token in URL IS the credential; type comes from `?type=email\|sms\|all`. POSTs to `/api/outreach/unsubscribe` which flips the matching `commPref` off via `outreach.honorUnsubscribe`. Self-contained styles (no `/crm/` CSS dependency) so the page renders even if a carrier rewrites asset URLs. |
| `approve.html` | `/approve/<id>?t=<token>` | Customer-facing on-site quote approval (signature canvas + PDF download). |

### Identity & access — authentication model

- **Per-user accounts in `users.json`.** `auth.json` is session-secret
  storage only after migration. **Never reintroduce the single-password
  pattern.**
- Cookie payload is `{uid, role, exp}` HMAC-signed with the
  `sessionSecret`. Tampering → 401. `role` ∈ `admin | tech | customer`;
  customer `uid` is `customer:<leadId>`.
- **Sessions:** admin/tech 30 days rolling; customer 30 days rolling.
  Magic-link tokens are 30 minutes single-use, distinct file
  (`magic-tokens.json`).
- **Tech-mode offline:** cookies persist offline; the offline-queue
  replays writes on reconnect with the cookie. A tech disabled mid-
  offline keeps working until reconnect (then queued writes 401). A
  >30-day offline gap requires re-login on reconnect.
- **Hard accuracy rule:** PJL is *not* a backflow tester. The auth
  refactor does not relax that — it only swaps the credential model.

## Shared admin components (`server/`)

| File | Purpose |
|---|---|
| `crm.css` | Sidebar + topbar shell + buttons. The visual frame. Mobile topbar uses `padding-top: max(<base>, env(safe-area-inset-top))` so the dark green bar's inner content (hamburger + eyebrow) clears the iPhone status bar in iOS standalone mode (Add to Home Screen). The background still extends to the very top so the status-bar glyphs sit on green, not on a white sliver. |
| `crm-nav.js` | Hamburger toggle + logout button wiring. |
| `crm-parts.js` / `crm-parts.css` | Shared parts catalog renderer (category > subcategory > items checkbox tree). Used by WO materials checklist + follow-up modal. |
| `crm-followup.js` / `crm-followup.css` | Follow-up WO trigger modal (slot picker + materials selector). |
| `crm-reschedule.js` / `crm-reschedule.css` | Admin reschedule modal. Hosts the shared month-calendar time picker (`/js/time-picker.js`) in `admin` mode with the custom-time override enabled. |
| `voice-input.js` | Web Speech API helper. Any field with `data-voice-input` attribute gets a mic button. |
| `tech-sw.js` | ServiceWorker scoped to `/admin/work-order/`. Caches HTML/JS/CSS/pricing.json/parts.json. Network-first WO/property GETs with cache fallback. |
| `offline-queue.js` | IndexedDB outbound queue. Synthesizes 202 on offline, replays FIFO on reconnect, auto-reloads after drain. |
| `wo-materials.js` | Standalone embed for the WO desktop editor — lists material lists attached to that WO, "+ New material list" button. |

## API surface (high level)

All routes admin-gated unless noted. Auth via session cookie set by
`POST /api/login`. Public endpoints: `/api/quotes` (POST lead intake),
`/api/booking`, `/api/portal/<token>` (and its `/booking-actions`,
`/reschedule-availability`, `/reschedule`, `/cancel`, `/messages`,
`/deferred/...` siblings — all token-authenticated, never an admin
session), `/api/approve/:id/:token`.

```
Authentication
  POST   /api/login                              { password }
  POST   /api/logout
  GET    /api/session

Leads / CRM
  POST   /api/quotes                             ← public lead intake
  GET    /api/quotes                             ← admin list
  GET    /api/quotes.csv                         ← export
  PATCH  /api/quotes/:id                         ← stage change, notes
  POST   /api/quotes/:id/convert-to-project      ← spawn project, re-parent attached lists

Customers (CUST-NNNN — the person; source of truth for CURRENT contact info)
  GET    /api/customers                          ← list, decorated with propertyCount + lastActivityAt
  GET    /api/customer/:id                       ← single, decorated with properties + bookings + WOs + quotes + invoices
  POST   /api/customer                           ← manual create from admin UI
  PATCH  /api/customer/:id                       ← edit identity / status / notes
  DELETE /api/customer/:id                       ← hard-delete; refuses if any entity still references this customer
  POST   /api/customer/:id/merge                 ← absorb { secondaryId } INTO this customer, re-point every reference
  POST   /api/customer/:id/communication         ← append a manual comm record
  GET    /api/customer/:id/vcard                 ← VCARD 3.0 download for iPhone Contacts; records vcfDownloads[method=individual]
  POST   /api/customers/vcards.vcf               ← body { ids: [...] }; concatenated VCARD batch; records vcfDownloads[method=bulk]
                                                   with a shared batchId. Missing ids skipped silently; count exposed via
                                                   X-Customers-Skipped response header.
  Snapshots-vs-source-of-truth: transactional entities (WO / Quote / Invoice / Booking / Project) continue to snapshot
  customerName/Email/Phone at sign time. Those snapshots remain the source of truth for AS-OF-SIGNING contact info
  (legal records); the Customer entity is the source of truth for CURRENT contact info. Editing a Customer never
  back-rewrites historical snapshots.

Properties
  GET    /api/properties
  GET    /api/properties/:id
  PATCH  /api/properties/:id                     ← system, zones, deferred issues
  POST   /api/admin/import-properties            ← bulk xlsx upsert

Bookings + scheduling
  POST   /api/booking                            ← public booking submit
  GET    /api/bookings, /api/bookings/:id
  PATCH  /api/bookings/:id
  POST   /api/bookings/:id/cancel                ← soft cancel; body {reason, notifyCustomer}.
                                                   Admin or tech. Stamps cancelledAt/By/Reason,
                                                   appends history entry, mirrors status into
                                                   lead.booking, optionally emails the customer
                                                   via sendBookingCancellation(). 409 if already
                                                   cancelled/completed.
  DELETE /api/bookings/:id                       ← hard delete; admin-only (requireAdmin).
                                                   Refuses (409) if a linked WO has moved past
                                                   `scheduled`. Strips lead.booking on success
                                                   so the lead no longer dangles a stale ref.
  GET    /api/schedule/...                       ← slots, blocks, hour overrides

Work Orders
  GET    /api/work-orders                                           ← list (filter ?propertyId, ?leadId).
                                                                       UI index at /admin/work-orders also supports two recovery
                                                                       filters: ?stuck=1 (locked && status !== "completed") and
                                                                       ?needs_invoice=1 (locked && no invoice referencing this WO).
                                                                       Filters resolved client-side via a join with /api/invoices.
                                                                       Each filtered row exposes a per-row "Run cascade now" button
                                                                       that calls POST /run-cascade (idempotent).
  GET    /api/work-orders/:id                                       ← decorated with property + lead + lastService + propertyEdits preview
  POST   /api/work-orders                                           ← create from lead/property/booking; seeds seasonal-fee baseline line
  PATCH  /api/work-orders/:id                                       ← zones, issues, signature, status, photos, paidOnSite, etc.
                                                                       Returns 409 wo_locked when payload touches SCOPE_PROTECTED_FIELDS
                                                                       on a signed OR bypass-locked WO (lineItems, signature,
                                                                       signatureBypass, customer/property/booking links,
                                                                       intakeGuarantee, type, etc.). Status forward-progression,
                                                                       photos, materials, paidOnSite, notes still accepted.
                                                                       Merged "Sign, Lock & Generate Invoice" tap (WO Field-Readiness
                                                                       brief): payload of { signature, status:"completed", arrivedAt?,
                                                                       departedAt? } in one PATCH — server validates pre-sign gates,
                                                                       persists signature, sets locked=true, transitions status, awaits
                                                                       completion-cascade, returns { workOrder, cascade: { invoiceId,
                                                                       ran, error? } }. Server-side gate failure → 422 with error:
                                                                       'presign_gate_unmet' + gateFailures[]. Cascade hard-fail leaves
                                                                       WO signed+locked+completed; appends `cascade_failed` history
                                                                       entry and surfaces cascade.error so the client can render the
                                                                       recovery surface.
  DELETE /api/work-orders/:id                                       ← refuses if active deferred items still reference this WO
  POST   /api/work-orders/:id/photos                                ← upload (categories: pre_work / in_progress / post_work / issue / general).
                                                                       Accepted MIME (WO Field-Readiness brief, May 2026):
                                                                       image/jpeg, image/png, image/webp, image/heic, image/heif,
                                                                       image/gif, application/pdf. 25 MB per file; magic-bytes
                                                                       verified server-side. Each meta entry carries `kind:
                                                                       'image' | 'pdf'` so the UI renders PDFs as filename tiles.
  DELETE /api/work-orders/:id/photos/:n
  GET    /api/work-orders/:id/photo/:n                              ← serve a single photo file (any accepted MIME above)
  POST   /api/work-orders/:id/create-invoice                        ← manual invoice draft (idempotent — short-circuits on existing)
  POST   /api/work-orders/:id/run-cascade                           ← re-run cascade explicitly (idempotent)
  POST   /api/work-orders/:id/follow-up                             ← spawn follow-up WO with parent's parts pre-loaded
  POST   /api/work-orders/:id/intake-guarantee/decide               ← AI Correct Diagnosis Bonus decision (Brief F).
                                                                       Body: { matched: bool, mismatchReason?: string }.
                                                                       On match: appends -1hr labour credit to builder.
  POST   /api/work-orders/:id/signature-bypass                      ← admin-authorized unified bypass.
                                                                       Body: { reason, note, acknowledgeWarning? }.
                                                                       Sets wo.locked = true. Acts as a single
                                                                       end-of-visit event covering BOTH on-site
                                                                       quote acceptance (when builder has additions)
                                                                       AND completion signature. Does NOT create
                                                                       on_site_quote Quote record; builder is
                                                                       snapshotted into signatureBypass.acceptedScopeSnapshot.
                                                                       Mutually exclusive with signature. 409 codes:
                                                                         - already_signed / already_bypassed
                                                                         - pending_remote_approval (send-for-approval
                                                                           Quote pending customer signature)
                                                                         - quote_already_accepted (drawn-signature
                                                                           accept already fired — use that path's
                                                                           completion signature instead)
                                                                         - scope_additions_require_acknowledgement
                                                                           (additions beyond baseline; retry with
                                                                           acknowledgeWarning: true)
                                                                         - invalid_state (terminal status)
                                                                       422 presign_gate_unmet if photo/zone/payment/
                                                                       return-visit/AI-bonus/materials gates aren't
                                                                       satisfied. Bypass-time sweep resolves any
                                                                       carry-forward "Repair now" deferred items
                                                                       (same as the signature path's sweep).
  POST   /api/work-orders/:id/on-site-quote/build                   ← run issue-rollup, store builder draft (preserves baseline + bonus credit)
  PATCH  /api/work-orders/:id/on-site-quote/builder                 ← tech edits builder lines; refuses to drop credit line while bonus matched
  POST   /api/work-orders/:id/on-site-quote/accept                  ← customer signature → on_site_quote Quote record + sink declines to deferred
  POST   /api/work-orders/:id/on-site-quote/decline-all             ← every line → deferred recommendations, no Quote
  POST   /api/work-orders/:id/on-site-quote/send-for-approval       ← email + SMS link to /approve/<quoteId>?t=<token>
  POST   /api/work-orders/:id/zones/:n/issues/:id/defer             ← per-issue defer (granular fall path / spring carry-forward decline)
  POST   /api/work-orders/:id/zones/:n/issues/:id/emergency         ← fall-only emergency override; pages Patrick + spawns service_visit follow-up
  POST   /api/work-orders/:id/issues/defer                          ← bulk defer all issues (fall closing find-only path)
  PATCH  /api/work-orders/:id/carry-forward/:deferredId             ← spring action: repair_now | decline | already_fixed | cannot_locate

Quotes
  GET    /api/admin/quote-folder                 ← Q-YYYY-NNNN browser
  GET    /api/admin/quote-folder/:id/pdf         ← branded PDF
  POST   /api/quotes/:id/send-for-approval       ← email + SMS to customer
  POST   /api/approve/:id/:token/sign            ← public signature

Invoices
  GET    /api/invoices                           ← filter ?status, ?woId
  GET    /api/invoices/:id
  PATCH  /api/invoices/:id                       ← lineItems, status
  POST   /api/admin/quickbooks/push/:id          ← (inert until creds)

Projects
  GET    /api/projects                           ← filter ?status, ?propertyId
  GET    /api/projects/:id                       ← includes attached material lists
  POST   /api/projects
  PATCH  /api/projects/:id
  DELETE /api/projects/:id                       ← detaches attached lists
  POST   /api/projects/:id/attach-work-order
  POST   /api/projects/:id/detach-work-order

Material Lists
  GET    /api/material-lists                     ← filter ?status, ?parentType, ?parentId, ?withTotals=1
  GET    /api/material-lists/:id
  POST   /api/material-lists
  PATCH  /api/material-lists/:id
  DELETE /api/material-lists/:id
  POST   /api/material-lists/:id/plan-purchase-orders         ← dry run
  POST   /api/material-lists/:id/generate-purchase-orders    ← create drafts

Suppliers + catalog assignments
  GET    /api/suppliers
  POST   /api/suppliers
  GET    /api/suppliers/:id
  PATCH  /api/suppliers/:id
  POST   /api/suppliers/:id/archive
  GET    /api/parts                              ← parts.json + merged supplier overrides
  GET    /api/part-suppliers
  PATCH  /api/part-suppliers                     ← bulk { updates: { sku: [supId, ...] } }
  PATCH  /api/part-suppliers/:sku

Purchase Orders
  GET    /api/purchase-orders                    ← filter ?status, ?supplierId, ?materialListId
  GET    /api/purchase-orders/:id
  GET    /api/purchase-orders/:id/pdf
  POST   /api/purchase-orders
  PATCH  /api/purchase-orders/:id
  DELETE /api/purchase-orders/:id
  POST   /api/purchase-orders/:id/send           ← render PDF + email + flip to sent
  POST   /api/purchase-orders/:id/resend         ← re-email without status change
  POST   /api/purchase-orders/:id/receive        ← { lineUpdates: { lineId: newReceivedQty } }
  POST   /api/purchase-orders/:id/cancel

Settings + misc
  GET    /api/settings
  PATCH  /api/settings/admin-defaults
  PATCH  /api/settings/contact-info               ← body { customerSupportPhone }.
                                                   Surfaced verbatim in portal
                                                   self-service blocked-state
                                                   copy ("call us at …").
  POST   /api/settings/ical-feed/generate         ← Brief C: idempotent;
                                                   returns existing token if
                                                   already enabled.
  POST   /api/settings/ical-feed/regenerate       ← issues a fresh token;
                                                   the old URL stops working
                                                   immediately (leak handling).
  POST   /api/settings/ical-feed/disable          ← clears the token; future
                                                   requests to /calendar/*.ics
                                                   return 404.
  GET    /api/pricing                            ← public pricing.json read
  GET    /api/chat-transcripts                   ← admin
  POST   /api/chat-transcripts                   ← public widget upserts

Customer portal (token-authenticated, no admin session)
  GET    /api/portal/:token                       ← read-only portal payload
                                                   (project, services, work
                                                   order, messages, prefs).
  GET    /api/portal/:token/booking-actions       ← preflight for self-service
                                                   buttons. Returns
                                                   { canReschedule, canCancel,
                                                     reasons: { reschedule, cancel },
                                                     hoursUntilAppointment,
                                                     rescheduleCount,
                                                     phoneFallback }. Reason
                                                   codes: ok | inside_cutoff |
                                                   reschedule_limit_reached |
                                                   wo_locked | multi_wo_booking |
                                                   not_modifiable_status | no_booking.
  GET    /api/portal/:token/reschedule-availability ← month-calendar slots for the
                                                   booking's service + address,
                                                   excluding the customer's own
                                                   current occupancy from the
                                                   conflict math. Also returns
                                                   tooLate flag.
  PATCH  /api/portal/:token/reschedule             ← body { slotStart, reason }.
                                                   Enforces: status modifiable,
                                                   >24hrs out, rescheduleCount<1,
                                                   not multi-WO, WO not arrived.
                                                   409 with { code, phoneFallback,
                                                   errors[] } on any gate failure.
                                                   On success: booking + linked WO
                                                   scheduledFor update, customer
                                                   confirmation email, Patrick
                                                   gets paged.
  POST   /api/portal/:token/cancel                 ← body { reason } (required,
                                                   trimmed non-empty, 1-500 chars).
                                                   Same gates as reschedule (minus
                                                   the count cap). On success:
                                                   booking flips to cancelled
                                                   (cancelledBy=customer), linked
                                                   WOs cascade-cancelled with
                                                   booking_cancelled_cascade history
                                                   entry, customer confirmation
                                                   email + Patrick paged.
                                                   Idempotent: re-call on already-
                                                   cancelled returns 200 with the
                                                   record, does NOT re-fire
                                                   notifications.
  POST   /api/portal/:token/message                ← customer-to-PJL message thread.
  POST   /api/portal/:token/accept                 ← formal quote acceptance.
  POST   /api/portal/:token/deferred/:id/pre-authorize ← signature on a deferred
                                                   recommendation.

Public token-gated
  GET    /calendar/:token.ics                    ← iPhone Calendar feed
                                                   (Brief C). text/calendar
                                                   response; 404 on token
                                                   mismatch OR feed disabled
                                                   (no info leak). 5-min
                                                   public Cache-Control.
```

## Core workflows

### 1. Lead → booking → WO → invoice (the happy path)

```
Customer fills public form OR AI chat emits [QUOTE_JSON]
   ↓
POST /api/quotes  →  leads.json + lead.features (price-snapshotted) + Q-YYYY-NNNN
   ↓
Admin / customer accepts quote  →  booking generated (BK-YYYY-NNNN)
   ↓
WO auto-created on booking  →  WO-XXXXXXXX, scaffolded zones from property
   ↓
Tech opens /admin/work-order/<id>/tech  →  walks zones, captures photos,
                                            builds on-site quote, signs
   ↓
Status flips to completed  →  completion-cascade fires (idempotent)
   ↓
Service record on property, I-YYYY-NNNN draft invoice, customer + admin emails,
warranty stamp.
```

### 2. Materials → POs (Phase 1-4 of materials management)

```
Admin populates /admin/parts-suppliers  →  data/part-suppliers.json
                                            (each SKU → primary supplierId)
   ↓
Material list built (standalone or attached to project / WO / quote).
Lines have status=need by default.
   ↓
Click "Generate purchase orders" on the list builder
   ↓
Server groups need-lines by primary supplier, creates one PO-YYYY-NNNN
draft per supplier, snapshots prices from parts.json at create time.
   ↓
Admin reviews PO detail, clicks Send  →  PDF + CSV rendered, snapshotted to
                                          server/data/purchase-orders/files/,
                                          emailed to supplier;
                                          source list lines flip need → ordered
   ↓
Supplier delivers (full or partial)  →  Record receipt with per-line qtys
                                          ordered → have on full receipt,
                                          partial lines stay ordered with poId backref
   ↓
PO status auto-derives: sent → partially_received → received
   ↓
Re-order: clone any non-draft PO into a fresh draft (same supplier + lines,
fresh prices from catalog).
   ↓
Cancel: outstanding lines flip ordered → need; received lines stay have.
```

#### PO documents (PDF + CSV)

When a PO transitions from `draft` to `sent`, two files are generated and
stored on disk:

- `server/data/purchase-orders/files/<PO-ID>.pdf` — formal one-page
  (or multi-page) document for the supplier's records. Seven-region
  layout: top accent rule, header (PJL identity + PO number + issued
  date), Vendor / Ship To columns, line-items table (`# · SKU ·
  Description · Qty · Unit · Unit Price · Line Total`), totals
  (subtotal-only; HST is the supplier's job), notes (references the
  PO id + the CSV attachment), footer with PJL contact line.
- `server/data/purchase-orders/files/<PO-ID>.csv` — RFC 4180 CSV with
  the line-item data. Six columns: `SKU, Description, Qty, Unit,
  UnitPrice, LineTotal`. Prices in decimal dollars (supplier systems
  expect this). UTF-8 with BOM so Excel on Windows handles em-dashes
  correctly. CRLF line endings.

Paths are persisted on the PO record as `pdfPath` + `csvPath` (repo-
relative) with `documentsGeneratedAt` carrying the generation
timestamp. **Both files are immutable** once the PO is `sent` — the
`/resend` endpoint reads these files unchanged, so the supplier
receives byte-identical documents regardless of subsequent
`parts.json` edits. Drafts regenerate documents on each preview.

The email sent to the supplier on `draft → sent`:

- Subject: `PO-YYYY-NNNN — PJL Land Services — N items, $TOTAL`
- From: `PJL Land Services <{GMAIL_USER}>` (canonically
  `info@pjllandservices.com`).
- Both PDF and CSV attached.
- HTML body contains a quick-paste `<table>` (real table, not `<pre>`)
  styled to look like a code block. Highlighting + copying it pastes
  into Excel with the cells separated automatically — the entire
  point of the quick-paste feature.
- Plain-text fallback with column-aligned text for clients that strip
  HTML.

Helpers live in:

- `server/lib/po-pdf.js` — the 7-region renderer
- `server/lib/po-csv.js` — RFC 4180 CSV writer
- `server/lib/notify-supplier.js` — email composition + send
- `server/lib/format.js` — `formatUnit()` (fixes the old "eachs"
  pluralization bug; `each → ea`, `ft → ft`, `roll → roll`) and
  `formatVendorAddress()` (title-cases all-caps stored addresses, puts
  Canadian postal codes on their own line)
- `server/lib/company.js` — single source for sender contact (name,
  city, phone, website, email, brand green hex). Sender email reads
  `process.env.GMAIL_USER` at call time with `info@pjllandservices.com`
  as the fallback.

### 3. Quote → project (multi-WO job)

```
Quote accepted  →  click "Convert to project" on quote folder row
   ↓
PROJ-YYYY-NNNN created with quote.customerName/email/property snapshot,
sourceQuoteId set. Idempotent — re-converting returns existing project.
   ↓
Any material lists with parentType=quote, parentId=<quoteId> get re-parented
to the new project.
   ↓
Admin attaches WOs to the project as jobs schedule. Project rolls up
multiple visits + multiple material lists + a single source quote.
```

### 4. Customer self-service booking changes (portal)

```
Customer opens /portal/<token>, sees upcoming booking on WO card.
   ↓
Portal calls GET /api/portal/:token/booking-actions on load.
   Preflight (server-computed, never trust client clocks):
     - status in { confirmed, tentative } ?
     - hoursUntilAppointment >= 24 ?
     - rescheduleCount < 1            (reschedule only)
     - linkedWoIds.length === 1 ?
     - no linked WO in arrived / in_progress / signed / completed ?
   ↓
Returns canReschedule / canCancel + per-action reason code +
  phoneFallback (from settings.contactInfo.customerSupportPhone).
   ↓
Reschedule active  → modal opens, slot picker from
                     GET /api/portal/:token/reschedule-availability
                     (excludes customer's own current occupancy from
                     conflict math). PATCH /api/portal/:token/reschedule
                     with { slotStart, reason }. On success: booking +
                     linked WO scheduledFor cascade, rescheduleCount++,
                     customer email + Patrick paged.
   ↓
Cancel active      → modal opens with reason chips + free-text. POST
                     /api/portal/:token/cancel { reason } (required
                     non-empty). On success: booking.status=cancelled
                     + cancelledBy=customer + cancellationReason +
                     cancelledAt, linked WO cascade-cancelled with
                     booking_cancelled_cascade history entry, customer
                     email + Patrick paged. Idempotent on repeat.
   ↓
Blocked (greyed)   → workorder-blocked row beneath the buttons surfaces
                     the most-specific reason copy + a tap-to-call link
                     to the configured support phone.
```

### 5. Seasonal outreach loop (feature-seasonal-outreach-brief.md)

```
Patrick visits /admin/outreach a few weeks before each season.
   ↓
Picks Spring or Fall + year. Page lists every property where
seasonalEligibility[season]=true, derives booking state from
bookings.json (deriveBookingState — serviceKey prefix +
scheduledFor in season window, excluding cancelled/no_show),
derives contact state from property.seasonalOutreach[year:season].touches.
   ↓
Patrick filters to "Not booked", selects all (or a subset),
composes a message (or uses the saved template), confirms send.
   ↓
outreach.sendBulk iterates: skip ineligible / opted-out / missing-name
/ no-portal-token / no-contact with reasons; mint per-property
opt-out tokens lazily on first send; send email + SMS via
notify-customer.sendOutreachEmail / sendOutreachSms with 300ms
Twilio + 100ms Gmail pacing; append a touch entry per success;
return per-recipient outcome { batchId, sent, skipped[], errors[] }.
   ↓
Customer's phone fetches the portal link to generate a preview card.
Portal handler (renderPortalWithOg in server.js) reads the
token + ?season query param, substitutes the OG meta tag
placeholders with personalized title + season-keyed hero image.
   ↓
Customer taps portal link in their message, books their service.
Booking flows through standard cascade unchanged.
   ↓
A week later Patrick reopens /admin/outreach. "Not booked" now
shows only the customers who haven't booked yet. He re-sends to
that subset.
```

## External integrations

| Service | Purpose | Trigger | Required env vars |
|---|---|---|---|
| **Gmail SMTP** | Lead notification email, customer transition emails, supplier PO emails | New lead, status changes, PO send | `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
| **Twilio** | Admin SMS on new lead | New lead intake | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `NOTIFY_TO_PHONE` |
| **Google Maps JS API** | Places Autocomplete on every editable address input + Distance Matrix on the public coverage checker | Form interaction | API key hardcoded in HTML script tags (browser key) |
| **Google Geocoding** | Property coordinates + drive-time analysis (admin only) | Property creation, today schedule | `GOOGLE_MAPS_SERVER_KEY` |
| **QuickBooks Online** | Push invoices, items, customers, and (Phase 4) estimates to QB. **Inert** until creds set + OAuth connect done. | Manual triggers from `/admin/settings` (auto-push on invoice send / quote accept gated by per-event toggles in settings.quickbooks) | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, optional `QB_ENVIRONMENT` (sandbox/production), optional `TOKEN_ENCRYPTION_KEY` |

### QuickBooks integration details (Customer + Item handling)

**Customer:** the invoice push resolves the QB Customer via `findOrCreateCustomer()` — exact-email match → DisplayName match → create new with `DisplayName/GivenName/FamilyName/PrimaryEmailAddr/PrimaryPhone/BillAddr.Line1`. The QB Customer ID is **not yet persisted back to the lead/property record** — every push re-runs the lookup. Phase 3 of the QB integration adds `lead.quickbooksCustomerId` + `quickbooksCustomerSyncToken` so renames don't lose the link.

**Items:** every line in a pushed invoice carries an `ItemRef` resolved from `quickbooks-items.json` (PJL key/SKU → QB Item ID). When a key is unmapped, the push falls back to a single shared "PJL Services" item and records a `qb_items_unmapped` warning in the settings panel — Patrick can then run a sync to fix the gap. `npm run lint:qb-mappings` (wired into `build:check`) flags pricing.json/parts.json keys with no QB mapping.

**Tax:** the invoice payload sets `TxnTaxDetail.TxnTaxCodeRef.value` to `settings.quickbooks.hstTaxCodeId` and each line's `TaxCodeRef` to the same. QB calculates HST server-side using that code's rate; PJL's local `hst/total` are display-only post-push. The push **hard-fails** if `hstTaxCodeId` is unset (silently pushing $0-tax invoices into a Canadian QBO is worse than failing loudly). Patrick configures the tax code + default income account once, in the QuickBooks panel of `/admin/settings`.

**Hard rule:** PJL is the source of truth for service + part pricing. QB items are derived state. Editing a price in QB does not flow back to PJL. The `lastPriceSynced` field in `quickbooks-items.json` lets the syncer detect drift in PJL → QB direction only.

## Configuration (Render env vars)

```
TZ                    = America/Toronto                    (forced by server.js)
PORT                  = 4173                                (Render injects)
HOST                  = 0.0.0.0                             (Render scanner needs this)
PUBLIC_BASE_URL       = https://pjllandservices.com         (post-DNS-cutover)
GMAIL_USER            = info@pjllandservices.com             (SINGLE SOURCE for sender email — POs,
                                                              invoices, quotes, customer-portal mail
                                                              all From: this address. Surfaced
                                                              programmatically via server/lib/company.js
                                                              `email()`. Falls back to the hardcoded
                                                              info@pjllandservices.com when unset.)
GMAIL_APP_PASSWORD    = (Gmail app password, not regular pw)
NOTIFY_TO_EMAIL       = (defaults to GMAIL_USER)
TWILIO_ACCOUNT_SID    = ...
TWILIO_AUTH_TOKEN     = ...
TWILIO_FROM_NUMBER    = +1...
NOTIFY_TO_PHONE       = +1...
BOOKING_API_KEY       = (per-tenant booking signing key; rotate any time)
GOOGLE_MAPS_SERVER_KEY = (server-side geocoding only — not the browser key)
QB_CLIENT_ID          = (optional — enables QB push)
QB_CLIENT_SECRET      = (optional)
QB_ENVIRONMENT        = sandbox | production (defaults to sandbox)
```

## Hard accuracy rules (DO NOT VIOLATE)

These have memory entries; surface them in any AI / specialist context.

- **Backflow:** PJL is **NOT** a certified Ontario backflow tester.
  Refer out. Don't add backflow to any service checklist or copy.
- **Pipe terminology:** PJL uses **HDPE poly pipe**, not PVC. Say
  "irrigation pipe" generically; never "PVC mainline", "buried PVC",
  "cracked PVC".
- **Hardware stack:** Hunter valves (NOT brass-bodied), pressure-
  regulated heads, Hydrawise. Lead with the principle, not parts.
- **Pricing:** `pricing.json` is the single source of truth. Never
  hardcode prices in HTML or copy. The build pipeline lints for this.
- **Quote prices:** Snapshotted at quote creation. Future pricing
  changes do not alter accepted quotes — line items carry their own
  price.
- **Signed WO:** Signed work order is the contract. Locked once signed.
  Subsequent scope changes need a fresh signature.
- **Hero nav clearance:** Every public hero block's mobile padding-top
  must use `var(--hero-nav-clearance)`. Never hardcode.
- **Brand:** Logo is the full "PJL Land Services" lockup; don't strip
  the wordmark. Headings use Barlow Condensed.
- **Property name invariant** (feature-seasonal-outreach-brief.md §3.9):
  every property carries a non-blank `customerName`. Enforced at
  `properties.create`, `properties.update`, and `properties.bulkUpsert`
  (rows with blank names go into the import error summary, not the
  live data). Backfilled before outreach v1 ships; required going
  forward. No exceptions — the OG preview card depends on a clean
  first name.
- **Outreach marketing comms honor CASL.** Every email from
  `outreach.sendBulk` includes an unsubscribe footer (per-channel +
  "stop everything" path); every SMS includes "Reply STOP to opt out."
  Per-property comm prefs gate dispatch. The public
  `/unsubscribe/<token>` page handles recipient-side opt-out without
  an admin session.
- **PUBLIC_BASE_URL is required in production.** The server hard-fails
  at startup when `NODE_ENV=production` and `PUBLIC_BASE_URL` is
  unset. Outreach links and OG canonical URLs always use this host;
  never fall back to `*.onrender.com`.

## How to run locally

```bash
git clone https://github.com/PJLLandServices/mysite
cd mysite
npm install
npm run create-user              # creates the first admin in users.json + seeds session secret
npm start                        # http://127.0.0.1:4173
```

`npm run build` rebuilds the public-site partials, syncs prices into
HTML, and rebuilds the AI worker prompt. `npm run build:check` exits
non-zero if anything's out of sync — useful as a pre-push gate.

## QA tooling

### UI audit captures

`npm run audit:ui` captures every admin page at four viewport widths
(iPhone 17 Pro Max 440×956, iPad portrait 820×1180, MacBook 14" 1512×982,
desktop 1920×1080) for visual layout audit. Output lands in
`audit/captures/` as `<page>__<viewport>.png` files with a self-contained
gallery at `audit/captures/index.html`.

Requirements:
- `npm start` running on http://127.0.0.1:4173 (separate terminal)
- `AUDIT_USER` env var set to an admin email in `server/data/users.json`
- `AUDIT_PASS` env var set to that user's password
- One-time setup: `npx playwright install chromium`

Detail pages (property, project, work-order, invoice, material list,
purchase order) auto-resolve a representative ID from the most recently
updated record in the corresponding `server/data/<entity>.json` file.
Empty entity files are skipped with a warning, not a hard failure.

Run before merging any layout-touching change. Re-run after the merge to
verify the fix and catch regressions. Prior captures are cleared at the
start of every run so the folder always reflects the latest state.
Playwright is `devDependencies` only — it does not ship to production.

## Glossary of IDs

| Prefix | Entity | Example |
|---|---|---|
| `P-` | Property | `P-2026-0042` |
| `WO-` | Work Order | `WO-X8YWAQRD` (random alphabet, no year) |
| `Q-` | Quote | `Q-2026-0042` |
| `I-` | Invoice | `I-2026-0042` |
| `BK-` | Booking | `BK-2026-0042` |
| `PROJ-` | Project | `PROJ-2026-0042` |
| `ML-` | Material List | `ML-2026-0042` |
| `PO-` | Purchase Order | `PO-2026-0042` |
| `SUP-` | Supplier | `SUP-001` (no year) |
| `USR-` | User account | `USR-001` (no year) |
| `mt_<32hex>` | Magic token (login or password reset) | `mt_a1b2c3d4...` |
| `li_xxxxxxxx` | Material list line | `li_VbjXaKHH` (random) |
| `poli_xxxxxxxx` | Purchase order line | `poli_QU1cN3Jz` (random) |
| `iss_xxxxxxxx_<ts>` | Zone issue inside a WO | `iss_a1b2c3_1730000000` |

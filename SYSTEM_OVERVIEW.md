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
| `properties.js` | Property | `P-YYYY-NNNN` | Customer site profile (zones, valves, controller, blow-out, deferred issues, service records, seasonal eligibility + outreach state + comm prefs). One per physical address. Zones land with `pendingReview: true` when the WO completion cascade discovers them on-site (Brief D). **Name invariant** (feature-seasonal-outreach-brief §3.9): `customerName` must be non-blank at `create`, `update`, and `bulkUpsert` — validation rejects blank patches with `code: MISSING_NAME`. Helpers: `seasonKey`, `recordOutreachTouch`, `setSeasonalOptOut`, `setSeasonalCommPref`, `setSeasonalEligibility`, `mintOptOutTokensIfMissing`, `findByOptOutToken`, `auditMissingCustomerName`. **Per-property seasonal pricing** (feature-per-property-seasonal-pricing-brief): now stores `seasonalPricing { springOpeningPrice, fallClosingPrice, hasAdditionalFallBlowout, additionalFallBlowoutPrice, additionalFallBlowoutDescription }`. `hydrateSeasonalPricing()` normalizes on read/write — cabana-off forces dependent fields to null. |
| `work-orders.js` | Work Order | `WO-XXXXXXXX` (random alphabet) | One per visit. Zones, issues, photos, signature OR signatureBypass (mutually exclusive), on-site quote, materials packed, `paidOnSite`, `propertyEditsAppliedAt`, `intakeGuarantee.matched`, `customerNotes` (customer-visible report narrative, required at signature), `reportSnapshots[]` (append-only list of frozen Service / Inspection Report PDFs), `completionReportSnapshotAt` (idempotency gate), `history[]`. Lock-protected fields enforced via `SCOPE_PROTECTED_FIELDS` constant (Brief A; `customerNotes` joined the list with Service Report brief 2026-05-19). Bypass acts as a unified end-of-visit completion event covering both on-site quote acceptance (when builder has additions beyond baseline) and completion lock; bypass-completed WOs with `coversQuoteAcceptance: true` do NOT produce `on_site_quote` Quote records — `signatureBypass.acceptedScopeSnapshot` (deep-copied builder lines + totals) is the authoritative scope record. **Brief 2** adds `build` to TEMPLATES (multi-day install / retrofit under a Project) with a `dailyLog` block: `workDate`, `sessions[]` (clock in/out + labourer count + note + startedBy), `tasksCompletedToday[]` (taskId references that sync to project.tasks), `materialsConsumed[]` (SKUs from parts.json), `nextDayMaterials[]` / `nextDayTasks[]` (carry-forward seeds for the next day's WO), `dailyNotes`. Helpers: `blankDailyLog`, `startSession`, `endSession`, `setLabourersForSession`, `markTaskDoneToday`, `unmarkTaskDoneToday`, `recordMaterialConsumed`, `removeMaterialConsumed`, `setNextDayPlan`, `setDailyNotes`, `listBuildWosForProject`. Build WOs accept a `parentProjectId` and use `wo.create({ type: "build", project, workDate, carryFromWoId })`. |
| `quotes.js` | Quote | `Q-YYYY-NNNN` | Versioned, signed estimate. Three flavours: `ai_repair_quote` (AI chat), `on_site_quote` (tech-built), `project_proposal` (admin-authored multi-section narrative, Brief 1 May 2026). Proposal type carries `branch`, `billingMode`, `proposalSections[]`, `attachments[]`, `customRates`, dual `acceptanceMethod` (`portal_esign` / `pdf_return`), and revision lineage (`revisionOf` / `supersededBy`). Scope-protected fields (`SCOPE_PROTECTED_FIELDS`) refuse PATCH once past draft. Helpers: `updateProposal`, `addAttachment` / `removeAttachment` / `readAttachmentBuffer`, `recordPortalSignAcceptance`, `stagePdfReturn`, `recordPdfReturnAcceptance`, `createRevision`, `snapshotRatesFromCustomer`. |
| `invoices.js` | Invoice | `I-YYYY-NNNN` | Auto-drafted by completion cascade, lifecycle draft → sent → paid → void. Carries `disclaimers: [...keys]` array — text bodies in the `INVOICE_DISCLAIMERS` constant (currently only `fall_additional_plumbing`). `update()` merges via Set semantics so cascade re-fires never duplicate keys. |
| `bookings.js` | Booking | `BK-YYYY-NNNN` | First-class appointment record. Mirrors `lead.booking` but is canonical. Exposes `cancel()` (soft, adds `cancelledAt/By/Reason` + history), `reschedule()` (sets `scheduledFor` + bumps `rescheduleCount` + history), and `remove()` (hard delete; refuses when a linked WO is past `scheduled` — caller passes `isActiveWo` to gate without coupling to work-orders.js). Schema includes `rescheduleCount` (capped at 1 for customer self-service via the portal endpoint; admin bypasses the cap). |
| `projects.js` | Project | `PROJ-YYYY-NNNN` | Multi-WO container for named jobs. Lifecycle planning → active → complete → archived. `createFromProposal(quote, …)` (Brief 1) enriches a project at conversion time from a `project_proposal` quote: `branch`, `billingMode`, `labourRateLocked` (snapshotted from `quote.customRates.labour`), `tasks[]` (seeded from line items — one task per line, status `pending`, `sourceLineItemId` set), `attachments[]` (references to the quote's attachments by id), and a frozen `proposalSnapshot` mirroring the accepted proposal at that instant. **Brief 2** adds execution ops: task CRUD (`addTask`, `updateTask`, `removeTask`, `markTaskComplete`, `unmarkTaskComplete`, `seedTasksFromQuote`); scope changes (`createScopeChangeRequest`, `updateScopeChangeRequest`, `sendScopeChangeRequest`, `resolveScopeChangeRequest`, `generateQuoteRevisionFromScopeChange`); status updates (`generateStatusUpdate`); project completion (`markFinalWo`, `completionPreflight`, `completeProject`); metrics + billing rollup (`computeProjectMetrics`, `computeTAndMBilling`). Schema additions: `scopeChangeRequests[]`, `statusUpdates[]`, `finalWoId`, `projectCompletionAt`, `invoiceGeneratedAt`, `finalInvoiceId`. |
| `material-lists.js` | Material List | `ML-YYYY-NNNN` | Bill of materials. Line items reference parts.json SKUs + quantities + status (`need` / `ordered` / `have`). Attachable to a project / WO / quote / standalone. **Pricing:** a line's unit price resolves **live from parts.json until its PO is sent** (catalog edits show on the next load), then **locks** to the PO-snapshotted price — `frozenPriceCents` is stamped onto the line at send and cleared if the PO is cancelled (a received line keeps the price paid). One pure resolver, `resolveLineUnitPriceCents(line, partsMap)`, feeds **both** read paths — the builder's per-line render/savebar and the `?withTotals=1` server totals — so they can't disagree. The builder fetches `/api/parts` `no-store` (not force-cache) so live prices aren't stale. |
| `purchase-orders.js` | Purchase Order | `PO-YYYY-NNNN` | One supplier's slice of a material list's `need` lines. Lifecycle draft → sent → partially_received → received → cancelled. |
| `quote-requests.js` | Quote Request (RFQ) | `RFQ-YYYY-NNNN` | The **"ask for a price" sibling of the PO** — asks a supplier to quote, commits to nothing. Generated from a material list's `need` lines grouped by primary supplier (same grouping as PO generation) but **never changes line status** (lines stay `need`) and **never snapshots prices** — lines carry `{ sku, description (snapshot via resolveLineDescription), quantity, unit, quotedPriceCents:null }`. Lifecycle draft → sent → quoted → applied (+ cancelled). Generation is idempotent: re-running **refreshes** the existing draft for (list, supplier) instead of duplicating; non-drafts are never touched. Sent docs frozen at `data/quote-requests/files/`. **Phase B (the return loop):** `recordQuotedPrices(id, {lineId: cents\|null})` records the vendor's reply on a sent/quoted RFQ (partial quotes fine; status follows the data — any priced line → `quoted`, all cleared → back to `sent`); `markApplied` flips quoted → applied and is the double-apply guard (second apply throws). The apply route writes the quoted prices to the parts catalog via the **existing** parts edit path (`partsLib.update` → `rebuildCatalogFromOverrides` → one batched `catalog.rfq-apply` audit entry), skipping deleted SKUs and counting already-matching prices as applied-without-write; open material lists pick the new prices up immediately (live pricing). Never touches `pricing.json`. Retires the old workaround of sending a $0 PO as a "Quotation Request". |
| `suppliers.js` | Supplier | `SUP-NNN` (no year prefix) | Vendor records (name, contact, email, phone, address). |
| `part-suppliers.js` | — | n/a | Override map at `data/part-suppliers.json` mapping SKU → supplierIds[]. parts.json's `supplierIds` field is a placeholder; this file is the source of truth. |
| `settings.js` | — | n/a | Admin notification preferences + 50-entry audit trail + iCal-feed token (Brief C: `icalFeed.{enabled, token, regeneratedAt}` — token is the credential for the public `/calendar/<token>.ics` feed) + `contactInfo.customerSupportPhone` (surfaced verbatim in portal blocked-state copy when self-service reschedule/cancel is refused; exposes `updateContactInfo()` for the `/api/settings/contact-info` PATCH endpoint) + per-season outreach templates (`outreachTemplates.{spring,fall}.{subject,smsBody,emailBody}`, saved via `saveOutreachTemplate`) + **invoice-ready SMS** (`invoiceSms.{enabled, delayMinutes, maxAgeHours}` — master switch + cascade-time delay before the customer SMS fires + sweep-window cap; defaults `enabled:true / delayMinutes:5 / maxAgeHours:24`). |
| `ical-feed.js` | — | n/a | Builds the read-only `.ics` feed for iPhone Calendar subscription. Filters bookings to `status === confirmed` and a -90d / +365d window; uses stable `BK-…@pjllandservices.com` UIDs so reschedules update the existing event. |
| `ical-format.js` | — | n/a | Hand-rolled RFC 5545 helpers: value escaping, 75-octet line folding, Toronto VTIMEZONE block, local + UTC date formatters. |
| `completion-cascade.js` | — | n/a | Fires on WO status → completed. Idempotent. Creates service record on property, draft invoice (with `paidOnSiteAtCompletion` flag), customer + admin emails, warranty stamp, **Service Report PDF snapshot** (gated by `wo.completionReportSnapshotAt`; failure leaves stamp unset and the cascade-recovery admin action becomes the retry path). Applies property edits via `computePropertyEdits()` (Brief D — zone/controller diffs, new zones flagged for Patrick review) gated by `wo.propertyEditsAppliedAt`. Logs `cascade_fire`, `invoice_drafted` (when a draft was created), `property_edits_applied`, and `report_snapshot_created` history entries. When the cascade throws mid-flight, the PATCH handler appends `cascade_failed` to the WO history and surfaces `cascade.error` in the response — the WO stays signed + locked + completed (recoverable via /run-cascade or /create-invoice). Attaches `fall_additional_plumbing` disclaimer key when WO is `fall_closing` and `property.seasonalPricing.hasAdditionalFallBlowout` is true (resolved against the LIVE property record, idempotent via Set in `invoices.update`). **Brief 2** adds service-mode branching: `build` WOs short-circuit the standard cascade (`mode: 'build_short_circuit'`) — invoice + customer email + warranty + service record all defer to project completion. New `runProjectFinalCascade(project, …)` fires when admin presses "Complete project" — generates invoice (T&M via `projects.computeTAndMBilling()` or fixed-price mirroring `proposalSnapshot.lineItems`), creates property service record (`projectId` set), sends emails, stamps 36-mo install warranty. Refuses with `unknownSkus` error when a consumed material SKU has no retail price in parts.json. **Invoice SMS brief (May 2026)** adds step 5 — schedules the customer invoice-ready SMS (5-min default delay) when `paidOnSiteAtCompletion === false`, `settings.invoiceSms.enabled !== false`, and customer SMS-allowed. Idempotent via `invoice.customerSmsSentAt` + `customerSmsScheduledAt`. Mints `portalToken` via `invoices.ensurePortalToken`. Primary fire path is a `setTimeout`; `notify-customer.sweepPendingInvoiceSMS()` is the restart-recovery sweep. Logs `customer_sms_scheduled` / `customer_sms_skipped_*` history entries. |
| `issue-rollup.js` | — | n/a | Maps zone issues into priced line items for the on-site quote. Manifold rule, controller subtype tier selection, etc. |
| `pricing.js` | — | n/a | `priceForBooking(serviceKey, zoneCount)` reads `pricing.json`. `resolveSeasonalPrice(property, serviceType)` cascades property override → pricing.json tier → custom-quote signal. Only accepts `spring_opening` / `fall_closing` — `service_call` is canonical and never per-property-overridable. |
| `availability.js` | — | n/a | Slot generator + `BOOKABLE_SERVICES` catalog. Endpoints can pass `from`/`to` (YYYY-MM-DD); `expandDaysToRange()` backfills every day in the range with `{slots, reason}` so the month-calendar picker can render available + unavailable cells in one pass. |
| `schedule-store.js` | — | n/a | Calendar blocks + per-day hour overrides. |
| `geocode.js` | — | n/a | Google Geocoding wrapper + cache. |
| `distance.js` | — | n/a | Distance Matrix + Haversine fallback. |
| `quote-pdf.js` | — | n/a | Branded quote PDF (pdfkit). Dispatcher by `quote.type`: `ai_repair_quote` / `on_site_quote` / `formal_quote` (legacy) → one-page `generateQuotePdf`; `project_proposal` → multi-section `renderProjectProposalPdf` with embedded attachments + dual-acceptance block (portal e-sign URL + printed signature lines). Use `renderQuotePdf` for new callers; `generateQuotePdf` remains exported for back-compat. |
| `po-pdf.js` | — | n/a | Branded purchase order PDF (pdfkit). |
| `wo-report-pdf.js` | — | n/a | Branded Service / Inspection Report PDF (pdfkit). Two modes: `inspection_report` (pre-completion, attached to send-for-approval emails) and `service_report` (post-completion, attached to the cascade email). Mode auto-derived from `wo.locked`. Renders cheat sheet, zone walkthrough, issues + dispositions, customer-visible notes, optional service-specific checklist (service mode only), signature/bypass block, fall-closing liability disclaimer (fall mode only), and Media Summary. **No prices anywhere** — quote and invoice are the financial artifacts, the report is the service-narrative artifact (Hard Rule 16). |
| `wo-report-snapshot.js` | — | n/a | Freezes a rendered report to disk at `server/data/wo-reports/<woId>/<snapshotId>.pdf` and records the entry on `wo.reportSnapshots[]` via `workOrders.appendReportSnapshot`. Trigger types: `quote_send`, `cascade`, `manual`. SHA-256 hash recorded for integrity. Exports `createSnapshot`, `readSnapshot`, `findLatestCascadeSnapshot`. |
| `notify-email.js` | — | n/a | Admin email on new lead (Gmail SMTP). |
| `notify-sms.js` | — | n/a | Admin SMS on new lead (Twilio). |
| `notify-customer.js` | — | n/a | Customer-facing transition emails / SMSes (booking confirmed, on the way, etc). Also exports `sendBookingCancellation(booking, {reason, notify, baseUrl})` — fire-and-forget cancellation email triggered from `/admin/schedule` — and `sendOutreachEmail` / `sendOutreachSms` (feature-seasonal-outreach-brief.md §3.5) used by `outreach.js` for the bulk booking-nudge batches. Outreach senders append a CASL unsubscribe footer (email) and the literal "Reply STOP to opt out." line (SMS), idempotent against operator-supplied STOP. **Invoice SMS brief (May 2026)** adds `sendInvoiceReadySMS({ invoiceId })` (idempotent via `invoice.customerSmsSentAt`; honors `customer.notificationPrefs.textReminders`; stamps `customer_sms_sent` / `customer_sms_failed` / `customer_sms_skipped_*` to invoice history) and `sweepPendingInvoiceSMS()` (recovery sweep called on server boot + every 2 minutes — picks up `customerSmsScheduledAt` records due now and within `settings.invoiceSms.maxAgeHours`). |
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
invoices.json              ← I-YYYY-NNNN records (includes `paidOnSiteAtCompletion`, `paymentToken`, and **invoice-ready SMS fields** `customerSmsScheduledAt` / `customerSmsSentAt` / `portalToken` — Invoice SMS brief, May 2026)
bookings.json              ← BK-YYYY-NNNN records
projects.json              ← PROJ-YYYY-NNNN records
material-lists.json        ← ML-YYYY-NNNN records
purchase-orders.json       ← PO-YYYY-NNNN records
quote-requests.json        ← RFQ-YYYY-NNNN records (+ quote-requests/files/ frozen sent PDFs/CSVs)
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
wo-reports/<woId>/<snapshotId>.pdf ← Service / Inspection Report PDF snapshots (Service Report brief, 2026-05-19)
project-rates.json         ← internal admin-only project-scale rates catalog (Brief 1, May 2026). Mirrors pricing.json item shape. Reads ONLY by /api/admin/project-rates and the quote-proposal-builder line-items picker. NEVER exposed publicly. Excluded from public hardcoded-price lint scope by virtue of being under server/data/ rather than a root *.html.
quote-attachments/<quoteId>/<attId>.<ext>  ← per-quote uploaded attachments for project_proposal quotes (Brief 1). PNG / JPEG / PDF. 25 MB per file, 100 MB per quote. Customer-uploaded signed_pdf_return PDFs live here too as evidence for admin attestation.
```

**Disk usage flag (Service Report brief).** Each snapshot is ~2–5 MB (photos + pdfkit overhead). At ~200 visits/season + occasional quote-send snapshots, expect ~400 MB / year added to the persistent disk. Render Starter currently allocates 1 GB. Narrows headroom but does not breach it for several seasons — watch.

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
| `quote-requests.html` | `/admin/quote-requests` | RFQ index. Status filter (draft/sent/quoted/applied/cancelled) + "Show closed" toggle. No prices anywhere. |
| (Materials sub-nav) | — | The materials pages (`material-lists.html`, `quote-requests.html`, `purchase-orders.html`, `suppliers.html`, `parts-suppliers.html`) share a `.suppliers-subnav` strip duplicated by hand. Below 768px the strip collapses into a single `<details>` dropdown ("Materials → <current> ▾"); open/close behaviour lives in `crm-nav.js`. |
| `purchase-order.html` | `/admin/purchase-order/<id>` | PO detail. Send modal (email + PDF), partial-receive modal, reorder, cancel. |
| `quote-request.html` | `/admin/quote-request/<id>` | RFQ detail. Draft line trim (qty/remove) + notes with auto-save, send modal (emails the vendor a request for pricing — explicitly not an order), resend, cancel, PDF/CSV downloads. On sent/quoted: the **quoted-price quick-grid** (dollars in, cents stored; partial quotes fine; auto-saves changed entries only) and, once quoted, **Review & apply to catalog** — a confirm modal showing current catalog price → quoted with deltas before any write. |
| `chats.html` | `/admin/chats` | AI chat transcripts (booked + abandoned). |
| `settings.html` | `/admin/settings` | Notification defaults, audit trail, QB connect, exports. |
| `login.html` | `/login` | Per-user CRM login (email + password). Credentials live in `users.json`; `auth.json` is the session-secret store only. |
| `users.html` | `/admin/users` | Admin-only per-user account management (CRUD, disable, reset password). Tech role gets 403. |
| `customer-login.html` | `/portal/login` | Customer self-serve magic-link request page (email/phone/address → emailed login link). |
| `reset-password.html` | `/reset-password?t=<mt_id>` | Admin/tech password reset landing page (magic-token-gated). |
| `portal.html` | `/portal/<token>` | Customer-facing portal: project request, deferred recommendations (pre-authorize with signature), signed quotes, scheduled appointments, notification prefs. Self-service appointment moves: **Reschedule** (once per booking, >24hrs out) and **Cancel** (with captured reason, >24hrs out) — both gated server-side via `/api/portal/:token/booking-actions` preflight, with greyed buttons and a phone-fallback row when blocked. The permanent `<token>` URL stays valid; magic-link sessions redirect here after setting a `customer:<leadId>` cookie. **Server-side Open Graph substitution** (feature-seasonal-outreach-brief.md §3.8): handler reads the token + optional `?season=spring\|fall` query param, looks up lead → property → customerName, then string-replaces `{{ogTitle}}` / `{{ogDescription}}` / `{{ogImageUrl}}` / `{{canonicalUrl}}` placeholders in `portal.html` before responding. Produces a personalized iMessage / Slack / Facebook preview card per recipient. Canonical URL always uses `PUBLIC_BASE_URL` (production host), never `*.onrender.com`. |
| `unsubscribe.html` | `/unsubscribe/<token>` | **Public** confirm-then-POST page for the CASL unsubscribe flow. Token in URL IS the credential; type comes from `?type=email\|sms\|all`. POSTs to `/api/outreach/unsubscribe` which flips the matching `commPref` off via `outreach.honorUnsubscribe`. Self-contained styles (no `/crm/` CSS dependency) so the page renders even if a carrier rewrites asset URLs. |
| `approve.html` | `/approve/<id>?t=<token>` | Customer-facing on-site quote approval (signature canvas + PDF download). |
| `portal-invoice.html` | `/portal/invoice/:id?t=<portalToken>` | **Public, token-gated** read-only invoice mirror linked from the customer invoice-ready SMS. Mobile-first, no admin chrome. Renders line items, totals, and a Pay button that deep-links into `/pay/invoice/:id?t=<paymentToken>`. Shows PAID badge when the invoice is paid, a "voided" notice when voided, or a "payment link is being prepared" banner when no `paymentToken` is on the invoice yet. Wrong/missing `portalToken` → 401 with no body. |

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
  PATCH  /api/properties/:id                     ← system, zones, deferred issues + seasonalPricing override edits (validates cabana-on → price required, 400)
  POST   /api/admin/import-properties            ← bulk xlsx upsert

Bookings + scheduling
  POST   /api/booking/reserve                    ← public booking submit; admin sessions can additionally pass
                                                   `source: "admin_custom"` to bypass corridor + hours guardrails
                                                   (still respects physical conflicts). Failure payload is
                                                   `{ ok: false, code, message, details?, errors[] }` —
                                                   `message` is admin-grade, `errors[]` is customer-friendly
                                                   for back-compat.
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
  GET    /api/work-orders/:id/report-pdf                            ← live-render Service / Inspection Report PDF (admin preview). Mode auto-derived from wo.locked.
  GET    /api/work-orders/:id/report-pdf/snapshot/:snapshotId       ← serve a frozen Service / Inspection Report PDF snapshot from disk (admin).
  POST   /api/work-orders/:id/report-pdf/snapshot                   ← manually create a snapshot (admin). Body: { triggerType?: "manual" }. Returns the appended record.
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
  GET    /api/admin/quote-folder/:id/pdf         ← branded PDF (dispatcher: project_proposal renders the multi-section template)
  POST   /api/quotes/:id/send-for-approval       ← email + SMS to customer (ai_repair_quote / on_site_quote)
  POST   /api/approve/:id/:token/sign            ← public e-sign capture (handles project_proposal via recordPortalSignAcceptance)
  GET    /api/approve/:id/:token/attachments/:attId ← token-gated public attachment serve (for proposal images embedded in /approve)

  Project Proposal — Brief 1 (May 2026):
  GET    /api/admin/project-rates                ← internal admin-only rates catalog
  POST   /api/quotes/proposal                    ← create a new project_proposal in draft
  PATCH  /api/quotes/:id/proposal                ← edit proposal (draft only; 409 on scope-protected fields once locked)
  POST   /api/quotes/:id/attachments             ← upload static media (PNG/JPEG/PDF, 25 MB cap)
  GET    /api/quotes/:id/attachments/:attId      ← admin-gated attachment serve
  DELETE /api/quotes/:id/attachments/:attId      ← remove attachment (draft only)
  POST   /api/quotes/:id/revise                  ← create -v2 revision; original gets superseded
  POST   /api/quotes/:id/send-proposal-for-approval ← email branded PDF + acceptance URL
  POST   /api/approve/:id/:token/pdf-return      ← public — customer uploads signed PDF; flips to pending_admin_attestation
  POST   /api/admin/quote-folder/:id/confirm-pdf-acceptance ← admin attests staged PDF; flips to accepted

  Customer rates (Brief 1):
  GET    /api/customers/:id/negotiated-rates     ← admin-only read
  PATCH  /api/customers/:id/negotiated-rates     ← admin-only write

Invoices
  GET    /api/invoices                           ← filter ?status, ?woId
  GET    /api/invoices/:id
  PATCH  /api/invoices/:id                       ← lineItems, status
  POST   /api/admin/quickbooks/push/:id          ← (inert until creds)
  GET    /api/portal/invoice/:id?t=<portalToken> ← PUBLIC token-gated read-only invoice
                                                   view for the customer SMS link.
                                                   Returns sanitized JSON (no admin notes,
                                                   no history, no tokens). 401 on wrong /
                                                   missing token so ID existence isn't
                                                   leaked. (Invoice SMS brief, May 2026)

  Invoice CC-spouse (Spouse-CC brief, June 2026):
    All 5 invoice send paths (manual email /send + /resend, auto-fire
    "invoice ready" SMS, manual reminder SMS, auto-fire and manual
    junk-mail warning SMS) optionally CC the customer's spouse contact.
    Customer schema:
      customer.copySpouseOnInvoices: bool — profile flag, default false
      customer.notificationPrefs.spouseTextReminders: bool — CASL gate
        for spouse SMS, default true
      customer.spouseEmail / customer.spousePhone — already-existing
        first-class fields
    Endpoints accept body { includeSpouse: bool? }:
      true  → force-include spouse this send (overrides profile flag off)
      false → force-skip spouse this send (overrides profile flag on)
      null / omitted → use the customer's profile flag default
    Lib helper: notify-customer.js → resolveSpouseRecipients(invoice, includeSpouse)
      returns { spouseEmail, spousePhone, smsAllowed }.
    Spouse SMS sends fire AFTER the primary success (so a primary
    Twilio failure doesn't leave the spouse hanging). Each spouse
    attempt logs to invoices.history[] with a *_spouse action suffix
    (customer_sms_sent_spouse, customer_reminder_sent_spouse,
    customer_junk_warning_sent_spouse, plus _failed_spouse /
    _skipped_spouse variants).
    Email send adds the spouseEmail as a `cc:` on the nodemailer
    call — single round-trip, both recipients see each other.
    Admin UI: /admin/customer/:id has the profile-level checkbox;
    /admin/invoice/:id has per-send checkboxes on each send card
    that pre-fill from the profile flag and show a "Will also CC:
    spouse@email.com" disclosure when checked.

Projects
  GET    /api/projects                           ← filter ?status, ?propertyId
  GET    /api/projects/:id                       ← includes attached material lists
  POST   /api/projects
  PATCH  /api/projects/:id
  DELETE /api/projects/:id                       ← detaches attached lists
  POST   /api/projects/:id/attach-work-order
  POST   /api/projects/:id/detach-work-order

  Project Execution — Brief 2 (May 2026):
  GET    /api/projects/:id/tasks                 ← list tasks
  POST   /api/projects/:id/tasks                 ← add task
  PATCH  /api/projects/:id/tasks/:taskId         ← edit (pending tasks only)
  DELETE /api/projects/:id/tasks/:taskId         ← remove (pending tasks only)
  POST   /api/projects/:id/tasks/seed            ← re-seed from accepted quote (refuses if any done)
  POST   /api/projects/:id/build-wos             ← create a new build-mode WO under this project
  GET    /api/projects/:id/metrics               ← computed metrics (% complete, hours, days, etc.)
  GET    /api/projects/:id/billing-preview       ← live invoice preview (T&M rollup or fixed-price)
  GET    /api/projects/:id/scope-changes
  POST   /api/projects/:id/scope-changes
  PATCH  /api/projects/:id/scope-changes/:scrId
  POST   /api/projects/:id/scope-changes/:scrId/send         ← flip to pending_customer_approval, email
  POST   /api/projects/:id/scope-changes/:scrId/resolve      ← body { resolution: approved|rejected|withdrawn }
  POST   /api/projects/:id/scope-changes/:scrId/generate-revision ← creates Q-vN, links SCR
  GET    /api/projects/:id/status-updates        ← history of past sends
  POST   /api/projects/:id/status-update         ← generate + send + log snapshot
  POST   /api/projects/:id/mark-final-wo         ← body { woId }
  GET    /api/projects/:id/completion-preflight  ← preflight blockers + warnings
  POST   /api/projects/:id/complete              ← project final cascade (idempotent)

  Build WO daily-log routes:
  POST   /api/work-orders/:id/sessions                  ← start session
  PATCH  /api/work-orders/:id/sessions/:sessId/end      ← end session
  PATCH  /api/work-orders/:id/sessions/:sessId/labourers ← set labourer count + note
  POST   /api/work-orders/:id/tasks-done                ← body { taskId, photoIds? }
  DELETE /api/work-orders/:id/tasks-done/:taskId        ← unmark (cross-day guard)
  POST   /api/work-orders/:id/materials-consumed        ← body { items[] } or { partSku, qty }
  DELETE /api/work-orders/:id/materials-consumed/:idx
  PATCH  /api/work-orders/:id/next-day                  ← body { nextDayMaterials, nextDayTasks }
  PATCH  /api/work-orders/:id/daily-notes               ← body { dailyNotes }

Material Lists
  GET    /api/material-lists                     ← filter ?status, ?parentType, ?parentId, ?withTotals=1
  GET    /api/material-lists/:id
  POST   /api/material-lists
  PATCH  /api/material-lists/:id
  DELETE /api/material-lists/:id
  POST   /api/material-lists/:id/plan-purchase-orders         ← dry run
  POST   /api/material-lists/:id/generate-purchase-orders    ← create drafts
  POST   /api/material-lists/:id/plan-quote-requests          ← dry run (RFQ)
  POST   /api/material-lists/:id/generate-quote-requests     ← create/refresh RFQ drafts (idempotent; ML lines untouched)

Quote Requests (RFQ)
  GET    /api/quote-requests                     ← filter ?status, ?supplierId, ?sourceMaterialListId
  GET    /api/quote-requests/:id
  PATCH  /api/quote-requests/:id                 ← {lines, notes} draft-only edits, OR {quotedPrices: {lineId: cents|null}} on sent/quoted (quick-grid)
  POST   /api/quote-requests/:id/send            ← freeze PDF+CSV to disk, email vendor, draft → sent
  POST   /api/quote-requests/:id/resend          ← re-email the frozen docs byte-identical
  POST   /api/quote-requests/:id/apply-to-catalog ← quoted only; writes quoted prices to parts catalog via the existing parts edit path; → applied
  POST   /api/quote-requests/:id/cancel
  GET    /api/quote-requests/:id/pdf             ← frozen if sent, live preview if draft
  GET    /api/quote-requests/:id/csv

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
  GET    /api/portal/:token/wo-report-snapshot/:woId/:snapshotId ← customer-side
                                                   Service Report PDF download
                                                   (Service Report brief, 2026-05-19).
                                                   Token-gated; 403 if the WO's
                                                   property isn't owned by the token's
                                                   customer.

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
warranty stamp. When the invoice isn't `paidOnSite` AND `settings.invoiceSms.enabled`
AND the customer hasn't opted out of text reminders, the cascade also schedules an
**invoice-ready SMS** (~5 min later by default) pointing at the read-only
`/portal/invoice/:id?t=<portalToken>` mirror. Sweep on boot + every 2 min picks up
sends lost to a server restart.
```

**Manual reminder SMS** (Invoice Reminder brief, May 2026): once the auto-fire has gone out (or been skipped), the admin invoice page exposes a **"📱 Send reminder SMS"** button on the `#invoiceReminderCard` card. Endpoint `POST /api/invoices/:id/send-reminder` is admin-gated, accepts `{ force: true }` to override the rate limit, and:

- **Rate limit:** minimum 1 hour between successful reminders per invoice (tracked via `customerReminderHistory[]` on the invoice record — separate from the auto-fire's `customerSmsSentAt`). Failed attempts don't count toward the gate.
- **Disabled on paid/voided invoices** — UI greys the button; server returns 409 with `error: "paid"` / `error: "voided"`.
- **Skip codes** (HTTP 409): `voided`, `paid`, `no_phone`, `no_twilio_config`, `disabled`, `opted_out`, `portal_token_failed`. Each appends a `customerReminderHistory` entry with `success: false` and a `reason` so the admin UI surfaces the attempt even when no SMS shipped.
- **Rate-limit response** (HTTP 429): returns `lastSentAt` + `retryAfterSeconds`; the UI prompts to override and re-POSTs with `{ force: true }`.
- **Twilio failures** (HTTP 502): upstream error surfaced through; logged + history-stamped.
- **Master kill switch:** the same `settings.invoiceSms.enabled` flag that governs the auto-fire also governs manual reminders. Flip it off → both routes no-op.

The body differs from the auto-fire — explicitly framed as "Friendly reminder from PJL Land Services — your invoice for {property} is still outstanding. View and pay here: {portalUrl}. Questions? Call (905) 960-0181." Same portal-invoice link pattern as the auto-fire so the customer lands on the read-only mirror with a Pay button.

**Junk-mail warning SMS** (Junk-Mail Warning brief, May 2026): the third invoice SMS surface. Fires ~30 seconds after each `POST /api/invoices/:id/send` or `/resend` to warn the customer the invoice email may end up in Junk/Spam. Hooked via `setTimeout` inside the send route (fire-and-forget, doesn't block the response).

- **Auto-fire on every send/resend.** `customerJunkMailWarningSentAt` is cleared in the `/send` patch so each new send re-fires a fresh warning. The lib function (`sendInvoiceJunkMailWarningSMS`) is NOT idempotent on this flag — re-firing is the desired behavior.
- **Manual override button** on the `#invoiceJunkWarningCard` admin card. Endpoint `POST /api/invoices/:id/send-junk-warning` accepts `{ force: true }` — same status-code mapping as the reminder route (200 / 404 / 429 / 409 / 502).
- **Redundancy guard:** if the auto-fire "invoice ready" SMS landed within the last 5 min, the lib returns `error: "autofire_recent"` (HTTP 409). The auto-fire body already mentions Junk/Spam, so a second SMS in that window would be noise. `force: true` overrides this gate too.
- **Rate limit:** same 1-hour minimum between successful manual sends, tracked via `customerJunkMailWarningHistory[]`. The 30s auto-fire from `/send` triggers BEFORE the manual route's gate (because clearing `customerJunkMailWarningSentAt` on the /send patch resets the state, and the timer fires once 30s later) — the rate limit is for the manual button only.
- **Body:** "Heads up from PJL Land Services — we just emailed your invoice for {property}. If you don't see it within a few minutes, please check your Junk/Spam folder. The invoice is also viewable here: {portalUrl}. Questions? Call (905) 960-0181."
- **Skip codes** (HTTP 409): `voided`, `paid`, `no_phone`, `no_twilio_config`, `disabled`, `opted_out`, `portal_token_failed`, `autofire_recent`. All append `customerJunkMailWarningHistory` entries with `success: false` + reason so the admin UI surfaces every attempt.
- **Master kill switch:** same `settings.invoiceSms.enabled` flag — flip off to stop ALL three SMS surfaces (auto-fire, reminder, junk warning).


**Manual admin booking (custom time):** the schedule page exposes a side door for off-grid commitments — corridor-isolated properties, after-hours fits, customer-named precise times.

```
/admin/schedule → click empty slot or "Book customer" → fill modal,
   pick a precise minute from the time picker's Custom time block
   ↓
POST /api/booking/reserve with { source: "admin_custom", ... }
   ↓
Server sees admin session → skips Turnstile, skips corridor + hours
   guardrails. Still checks physical conflict with any existing booking.
   ↓
lead.booking persists with forcedByAdmin: true. Canonical BK-YYYY-NNNN
   mirrors the flag and stamps a `force_booked_by_admin` entry on history[].
   ↓
Customer-facing email/SMS/portal show the half-day bucket
   ("Morning Appointment (8 AM – 12 PM)") derived from < 12 / ≥ 12.
Admin surfaces show the precise minute.
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
  PO id + the CSV attachment), footer with PJL contact line. Below the
  notes, a **red revision stamp** ("PRINTED COPY — CHECK YOUR EMAIL FOR
  REVISIONS") warns the holder of a printout that a revised order
  arrives by email and the latest emailed version supersedes the paper
  copy — last page only, paginated together with totals + notes so it
  never strands alone. (PO PDFs only — the RFQ deliberately doesn't
  carry it.)
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

**Manual / off-catalog lines + Description resolution.** Besides the
catalog-driven `Materials → POs` flow, a PO line can be added manually
(via `POST /api/purchase-orders` / `PATCH …/:id`) carrying an
off-catalog `sku` + a typed `description` (+ `unitPriceCents` once
supplier pricing is known). The line's `description` is snapshotted on
the record by `hydrateLine` (240-char cap), alongside the catalogued
fields. **Generation also snapshots it:** `generate-purchase-orders`
(and `reorderFrom`) stamp each PO line's `description` from the catalog
at create time, so the stored value is correct going forward and renders
don't depend on a later catalog lookup.

One shared resolver — **`resolveLineDescription(line, partsMap)` in
`format.js`** — is THE description path for **every** surface: the PDF,
the CSV, the supplier email (HTML quick-paste **and** plain-text), and
(mirrored client-side) the PO detail page. Order: **stored line
`description` → catalog description by SKU → `(SKU <sku>)` placeholder**.
It returns the description text **only** — it never prefixes the part
`size` (the old `1.50 — …` email concatenation was a bug, removed). The
`(SKU …)` placeholder is the last resort only, so an off-catalog SKU with
a typed description renders that text rather than the placeholder.

The renderers are fed the **merged in-memory catalog** (`PARTS.parts`,
which includes runtime overrides) by the caller — `generatePoPdf(po,
partsMap)` / `generatePoCsv(po, partsMap)` and the email's injected
`describeLine(line)`. Previously the PDF/CSV self-loaded `parts.json`
from disk (baseline only) while the email used the in-memory catalog, so
a runtime-added SKU showed `(SKU …)` on the PDF/CSV but the real text in
the email. Now all surfaces read the same catalog and can't diverge.
Already-sent PO documents stay byte-frozen on disk (`pdfPath`/`csvPath`)
— this affects generation + draft rendering only, never a sent doc.

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
  pluralization bug; `each → ea`, `ft → ft`, `roll → roll`),
  `formatVendorAddress()` (title-cases all-caps stored addresses and emits
  standard Canadian envelope lines — street, then `City, PROV  POSTAL`
  joined on one line; never a line opening with separator debris), and
  `resolveLineDescription()` (the shared stored→catalog→placeholder
  description resolver used by every PO surface)
- `server/lib/company.js` — single source for sender contact (name,
  city, phone, website, email, brand green hex). The `email()` helper
  reads `process.env.GMAIL_USER` (the SMTP-auth account) with
  `info@pjllandservices.com` as the fallback. Used by supplier-facing
  PO PDFs + supplier emails only — customer-facing From-headers go
  through `CUSTOMER_EMAIL` (see the "External integrations" table and
  the env-vars block below for the split).

#### RFQ documents (PDF + CSV + email)

The Request for Quotation is the PO's "ask" sibling and its documents are
deliberately price-free — they must never read like an order:

- **`server/lib/rfq-pdf.js`** — `generateRfqPdf(rfq, partsMap)`. Same
  7-region layout discipline as `po-pdf.js` (standalone sibling, not a
  parameterization — po-pdf.js stays untouched). Title reads **"REQUEST
  FOR QUOTATION"**; parties are VENDOR / **REQUESTED BY** (nothing ships).
  Items table: `# · SKU · Description · Qty · Unit · QUOTED UNIT PRICE` —
  the last column is an **empty ruled write-on cell** for the vendor.
  **No** unit prices, **no** line totals, **no** totals region. The notes
  region asks for best unit price + lead time, references the RFQ id, and
  states "this is a request for quotation only — not a purchase order."
- **`server/lib/rfq-csv.js`** — `generateRfqCsv(rfq, partsMap)`. Columns
  exactly `SKU,Description,Qty,Unit` (no price columns), RFC 4180 + UTF-8
  BOM + CRLF like the PO CSV.
- **Email** (`notify-supplier.js`: `buildRfqSubject` / `buildRfqEmail` /
  `sendQuoteRequestEmail`) — subject `RFQ-YYYY-NNNN — PJL Land Services —
  Request for Quotation — N items` (no dollar amount, unlike the PO
  subject). Reuses the price-free quick-paste table (SKU / QTY /
  DESCRIPTION) and frames the ask as pricing-only.

All three surfaces resolve descriptions through the shared
`resolveLineDescription` and are fed the merged in-memory catalog
(`PARTS.parts`). Send freezes the PDF + CSV to
`server/data/quote-requests/files/` — immutable thereafter; resend
re-attaches the frozen bytes (same rule as POs).

### 3. Quote → project (multi-WO job)

```
Quote accepted  →  click "Convert to project" on quote folder row
   ↓
PROJ-YYYY-NNNN created with quote.customerName/email/property snapshot,
sourceQuoteId set. Idempotent — re-converting returns existing project.
   ↓
If source quote was a project_proposal (Brief 1 May 2026), the project
is enriched via projects.createFromProposal():
  - branch + billingMode mirrored from the quote
  - labourRateLocked snapshotted from quote.customRates.labour (T&M
    uses this rate; fixed-price keeps it informational)
  - tasks[] seeded from quote.lineItems — one task per line, status
    "pending", sourceLineItemId back-reference set, order preserved
  - attachments[] references the quote's attachments by id (no file
    copy — the project reads through to the quote directory)
  - proposalSnapshot frozen copy of accepted proposal (sections +
    line items + totals + branch + acceptanceMethod + customer/property)
   ↓
Any material lists with parentType=quote, parentId=<quoteId> get re-parented
to the new project.
   ↓
Admin attaches WOs to the project as jobs schedule. Project rolls up
multiple visits + multiple material lists + a single source quote.
```

### 3a. Project execution — build mode (Brief 2, May 2026)

The full multi-day execution loop from kickoff to billing close-out.

```
Project converted from accepted proposal (Workflow #3)
   ↓
Tasks seeded from quote line items, attachments referenced, snapshot frozen.
Admin reviews task list on /admin/project/<id>, edits/adds tasks pre-Day-1.
   ↓
DAY 1:
  Admin taps "+ New day's WO" on project page → POST /api/projects/:id/build-wos
  Creates a build-mode WO. Tech opens it in tech mode on iPhone Safari.
  Tech taps Start session (labourers = 2, note "Mike Schwartz onsite for sleeve install").
  Throughout the day:
    - Marks tasks done as completed (syncs to project.tasks)
    - Captures photos (optionally task-anchored)
    - Adds materials consumed via batch catalog picker (parts.json)
    - Dictates daily notes via voice input
    - End of day: sets tomorrow's tasks
  Taps End session.
   ↓
DAY 2:
  Admin taps "+ New day's WO". carryFromWoId carries over yesterday's
  nextDayMaterials + nextDayTasks (planned, not auto-consumed).
  Tech promotes carried materials as actually installed.
   ↓
If scope addition arises (customer asks for drip irrigation while on-site):
  Tech taps "Note a scope addition" on the day's WO → SCR captured with
  description + suggested line items from project-rates.json catalog →
  scr.status = pending_admin_review.
  Admin reviews on project page, edits draft email, taps Send to customer →
  status = pending_customer_approval, email sent.
  Customer responds → admin marks approved/rejected.
  If approved + fixed-price project → admin generates Q-vN revision
  (quotes.createRevision + appends suggested line items). Original quote
  superseded; new revision linked via revisionOf / supersededBy.
   ↓
At any point, admin presses "Send status update" on project page → opens
modal with recipient + preamble + preview → POST /api/projects/:id/status-update
sends email + logs frozen snapshot on project.statusUpdates[].
   ↓
Final day: customer signs the final WO (existing signature canvas).
Admin marks this WO as the final WO via sidebar picker.
Admin presses "Complete project" → opens completion modal with preflight
check (final WO signed?, tasks done?, scope changes resolved?) + invoice
preview → POST /api/projects/:id/complete
   ↓
Build completion cascade fires:
  - Invoice generated (T&M rollup or fixed-price mirror)
  - Property service record created (projectId set, projectId-tagged)
  - Customer email with invoice attached
  - Admin email with project summary
  - Warranty stamp (36 months — install tier)
  - Project status → complete, projectCompletionAt + finalInvoiceId stamped
  - Idempotent — re-running returns same invoice ID, no duplicates
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
| **Gmail SMTP** | Lead notification email, customer transition emails, supplier PO emails | New lead, status changes, PO send | `GMAIL_USER`, `GMAIL_APP_PASSWORD` (SMTP auth) + `CUSTOMER_EMAIL` (customer-facing From / Reply-To, defaults to `info@pjllandservices.com`) |
| **Twilio** | Admin SMS on new lead | New lead intake | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `NOTIFY_TO_PHONE` |
| **Google Maps JS API** | Places Autocomplete on every editable address input + Distance Matrix on the public coverage checker | Form interaction | API key hardcoded in HTML script tags (browser key) |
| **Google Geocoding** | Property coordinates + drive-time analysis (admin only) | Property creation, today schedule | `GOOGLE_MAPS_SERVER_KEY` |
| **QuickBooks Online** | Push invoices, items, customers, and (Phase 4) estimates to QB. **Live** in production: invoice push fires during the admin "Send to customer" flow and writes the QB invoice ID + payment link back onto the local record. Configure HST tax code + default income account once in `/admin/settings` (hard-fails until set). | Invoice push: admin clicks "Send to customer" on `/admin/invoice/:id`. Item / customer push: manual triggers from `/admin/settings`. Auto-push toggles in `settings.quickbooks` (`invoiceAutoPushOnCascade`, `estimateAutoPushOnAccept`) gate any future fire-on-event behaviour. | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, optional `QB_ENVIRONMENT` (sandbox/production), optional `TOKEN_ENCRYPTION_KEY` |
| **Twilio (customer SMS)** | Customer-facing SMS for lifecycle events (booking confirmed, on-the-way, rescheduled) and the invoice-ready nudge that fires ~5 min after WO completion. | Cascade-scheduled (`setTimeout` + sweep recovery) from `completion-cascade.js`; honors `customer.notificationPrefs.textReminders` and `settings.invoiceSms.enabled`. | Same Twilio creds as the admin row above. |

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
GMAIL_USER            = patrick@pjllandservices.com           (SMTP auth ONLY — the Google Workspace
                                                              account whose app password authenticates
                                                              outbound mail. Customer-facing From-headers
                                                              are NOT bound to this address; they read
                                                              CUSTOMER_EMAIL. Supplier POs and lead
                                                              alerts still use this via company.email().)
GMAIL_APP_PASSWORD    = (Gmail app password, not regular pw)
CUSTOMER_EMAIL        = info@pjllandservices.com              (Customer-facing From: + Reply-To: on
                                                              every customer-bound email AND the
                                                              e-Transfer / "send PDF back to" address
                                                              rendered into invoice + quote PDFs.
                                                              Defaults to info@pjllandservices.com
                                                              when unset. Decouples SMTP auth identity
                                                              from the address customers see and reply
                                                              to. Gmail's Send-As alias lets a patrick@
                                                              login send with an info@ From-header.)
NOTIFY_TO_EMAIL       = (defaults to GMAIL_USER — admin-internal lead alerts only)
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
- **Admin force-booking is admin-only.** The `source: "admin_custom"`
  flag on `POST /api/booking/reserve` is server-gated by the session
  cookie — public callers and the AI-chat handoff never send it and
  have no path to bypass corridor/hours guardrails. Force-booked
  records carry `forcedByAdmin: true` and a `force_booked_by_admin`
  entry in the Booking's `history[]`. The Turnstile anti-bot check is
  skipped for admin/tech sessions on this endpoint — admin auth is
  the bot filter.
- **Customer-facing time windows.** Customer surfaces never show a
  precise minute. Booking start < 12:00 PM = "Morning Appointment
  (8 AM – 12 PM)"; ≥ 12:00 PM = "Afternoon Appointment (12 PM – 5 PM)".
  Rule applies to force-booked custom times too. Admin-facing UIs show
  the precise minute. Labeling lives in
  `server/lib/notify-customer.js bookingDateTime()`.

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

### Maintenance scripts

- `npm run backfill-booking-customers` — dry-run that lists leads from a
  self-booking with no `customerId` (the bug fixed in the booking-handler
  patch). Re-run with `npm run backfill-booking-customers:apply` to
  resolve each by email/phone or create a fresh `CUST-…` and stamp it
  back. Safe to re-run: idempotent on already-resolved leads, and
  customer-resolution is match-first so a partial backfill won't
  duplicate. Reads `server/data/leads.json` + `server/data/customers.json`,
  writes both. Designed for one-shot use after deploying the fix; no
  ongoing schedule.

  The same logic is also exposed via an **admin-triggered HTTP
  endpoint** for use when Patrick can't get to a shell:
  - `POST /api/admin/backfill-customers` with body `{ apply: bool }`,
    admin-gated via `requireAdmin`. Returns the same candidate / created /
    matched / failed shape as the CLI. Caps at 200 candidates per call
    (`truncated: true` flag when more remain).
  - UI lives on **`/admin/settings`** under the "Maintenance — Backfill
    missing customers" card: a Check-for-missing-customers (dry-run)
    button, an Apply button that stays disabled until a dry-run runs
    successfully in the same session, and a result table showing every
    affected lead. Patrick can fire this from his phone.
  - Both paths (CLI + endpoint) share `server/lib/backfill-booking-customers.js`
    so they can't drift.

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
| `att_xxxxxxxx` | Quote attachment / project attachment reference (Brief 1) | `att_K9pQrZ7m` (random) |
| `sec_xxxxxxxx` | Proposal section inside a project_proposal quote (Brief 1) | `sec_x8WqLP3a` (random) |
| `task_xxxxxxxx` | Project task seeded from a proposal line item (Brief 1) | `task_aB3cD9eF` (random) |
| `sess_xxxxxxxx` | WO session (clock-in/out) on a build-mode WO (Brief 2) | `sess_9Pq3aLn4` (random) |
| `scr_xxxxxxxx` | Scope-change request on a Project (Brief 2) | `scr_Vk2mZpQ8` (random) |
| `su_xxxxxxxx` | Status-update entry sent to a stakeholder (Brief 2) | `su_3aZ7Lp2M` (random) |

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
"dependencies": { "nodemailer": "^8.0.7", "pdfkit": "^0.17.2", "sharp": "^0.34.5" }
```

Everything else is built-in or vendored.

**Vendored front-end libraries — one, and only one (DEV-02, 2026-08-13).**
`server/vendor/pdfjs/` holds Mozilla **pdf.js 4.10.38** (legacy build:
`pdf.min.mjs` + `pdf.worker.min.mjs`), served at
`/crm/vendor/pdfjs/…`. It is **not** an npm dependency and never runs on
the server. It executes in the browser only, on one code path — the Sprinkler
System Builder's site-plan upload dialog — where it rasterizes a PDF page to
a canvas so the original tender PDF never has to be uploaded or stored. No
build step: the files are served verbatim. Version, checksums and the
verification command are pinned in `server/vendor/pdfjs/VENDORED.md`. The
alternative (server-side rasterization) needs a native binary
(poppler/ghostscript) on Render Starter and was judged materially worse.
`.mjs` is registered in `MIME_TYPES` so the dynamic `import()` and the module
worker are both accepted.

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
├── parts.json                                  (hardware catalog — 143 SKUs; per-part manufacturer + manufacturers[] vocab)
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
| `customers.js` | Customer | numeric string (QuickBooks-style, e.g. `19931884`; legacy `CUST-NNNN` tolerated) | The canonical "person" entity (live since 2026-05-16; see PJL_OPERATIONS_DESIGN §2.1). Source of truth for *current* contact info: `name`, spouse fields, `phone`, `email`, `billingName` / `billingEmail` / `billingAddress` (separate billing party — empty means bill to the contact; billing-party brief Jun 2026), `quickbooksId` (schema field, fillable by import/merge — the QB invoice push does NOT yet write it back, that's Phase 3), `status` (lead/active/inactive/lost), `notificationPrefs`, `negotiatedRates`, `communicationRecords[]`, `history[]`. Matching: email first, phone second (`findByEmail` / `findByPhone` / `findByIdentifier`). Also `mergeCustomers`, vCard export, vcf download audit. **Commercial layer:** `accountType` (`residential` \| `commercial`, default residential) + `commercial { careOf, poRequired, paymentTerms, contacts[] }`. Both are allow-listed in `update()`; `commercial` is a **full replace** (the editor always sends the whole contacts list) normalized through `normalizeCommercialBlock` — `role` coerced to the enum, flags coerced to booleans, unknown keys dropped, and the block collapsed to `null` when nothing usable remains (so residential records never grow one). **Contact cap = 10, enforced asymmetrically** (addendum Jul 2026): a WRITE past the cap throws `CONTACT_CAP_EXCEEDED` and saves nothing, while a READ never throws and never trims. It used to trim silently, which could drop an authorized signatory unnoticed; and throwing on read would be worse still, since `readAll()` swallows exceptions and would return an empty customer list. Empty rows are dropped before counting, so a blank trailing editor row can't trip the limit. `hydrate()` runs the same normalizer on **read**, so a hand-edited `customers.json` can't serve a malformed block to the resolver. Contacts carry a stable `con_` id (see `billing-parties.js`); `readAll()` backfills ids onto pre-id records once, mirroring the `P-YYYY-NNNN` backfill in `properties.js`. `resolveAcceptor(customer)` picks the default quote acceptor from the signatory flags. NOTE: there is no `leads.js` lib — leads.json is managed inline by server.js (`readLeads`/`writeLeads` + `leadsHelpers`). |
| `properties.js` | Property | `P-YYYY-NNNN` | Customer site profile (zones, valves, controller, blow-out, deferred issues, service records, seasonal eligibility + outreach state + comm prefs). One per physical address. Zones land with `pendingReview: true` when the WO completion cascade discovers them on-site (Brief D). **Name invariant** (feature-seasonal-outreach-brief §3.9): `customerName` must be non-blank at `create`, `update`, and `bulkUpsert` — validation rejects blank patches with `code: MISSING_NAME`. **Commercial matching (Phase 0.5, Jul 2026):** `findMatch` stays email-anchored (the residential rule — the person is the customer), but commercial inverts that: the BUILDING is the stable identity and the property manager churns. `findByAddress` / `findAllByAddress` are the email-agnostic lookup ("is this building on file, no matter who's asking?"), and `findCommercialAnchor(address, coords, {submitterEmail})` returns `{property, customerId, customer}` **only** when the address resolves to a property whose customer is `accountType === "commercial"` — and returns null when the submitter already owns a property there, so an exact email+address match always outranks the anchor. `attachLead` uses it to bind an intake to the existing account instead of creating a duplicate, **skipping `findOwnershipConflicts`** (a new PM is not a new owner), returning a `commercialBind: { status:"bound", customerId, contact:{state:"known"|"unconfirmed", matchedContactId?, from?}, contactKnownOnOtherAccounts? }` and appending a `commercial_lead_bound` entry to the new `property.history[]`. Canonical `customerName/Email/Phone` are never overwritten by the submitter. `resolveSubmitterContact` and `findContactAccountsByEmail` back the known/unconfirmed decision. Both `matchByAddress` and `findMatch` share one `matchAllByAddress` core so the rule can't drift. Helpers: `seasonKey`, `recordOutreachTouch`, `setSeasonalOptOut`, `setSeasonalCommPref`, `setSeasonalEligibility`, `mintOptOutTokensIfMissing`, `findByOptOutToken`, `auditMissingCustomerName`. **Per-property seasonal pricing** (feature-per-property-seasonal-pricing-brief): now stores `seasonalPricing { springOpeningPrice, fallClosingPrice, hasAdditionalFallBlowout, additionalFallBlowoutPrice, additionalFallBlowoutDescription }`. `hydrateSeasonalPricing()` normalizes on read/write — cabana-off forces dependent fields to null. **Commercial layer (management-company model):** `billingEntity` (string, this site's own legal payer — trimmed, capped at 200; empty means the customer is the payer, which is every residential property) + `billingCcEmail` (per-site override of the customer's invoice CC) + `siteContacts[]` (the people at THIS address — board president, super — same shape as `customer.commercial.contacts`, normalized by `normalizeSiteContacts`; `isSiteContact` defaults **true** here since that's the point of the list; same reject-on-write / lossless-on-read 10-contact cap as the customer side). Both are handled explicitly in `update()`: `billingEntity` trims, `siteContacts` is a full replace, and **omitting either key leaves it untouched** — a partial patch never blanks them. Site-scoping lives here on purpose: it is what lets a Phase-1 portal contact see only their own building. Contacts carry a stable `con_` id, backfilled once by `readAll()`. |
| `work-orders.js` | Work Order | `WO-XXXXXXXX` (random alphabet) | One per visit. Zones, issues, photos, signature OR signatureBypass (mutually exclusive), on-site quote, materials packed, `paidOnSite`, `propertyEditsAppliedAt`, `intakeGuarantee.matched`, `customerNotes` (customer-visible report narrative, required at signature), `reportSnapshots[]` (append-only list of frozen Service / Inspection Report PDFs), `completionReportSnapshotAt` (idempotency gate), `history[]`. Lock-protected fields enforced via `SCOPE_PROTECTED_FIELDS` constant (Brief A; `customerNotes` joined the list with Service Report brief 2026-05-19). Bypass acts as a unified end-of-visit completion event covering both on-site quote acceptance (when builder has additions beyond baseline) and completion lock; bypass-completed WOs with `coversQuoteAcceptance: true` do NOT produce `on_site_quote` Quote records — `signatureBypass.acceptedScopeSnapshot` (deep-copied builder lines + totals) is the authoritative scope record. **Brief 2** adds `build` to TEMPLATES (multi-day install / retrofit under a Project) with a `dailyLog` block: `workDate`, `sessions[]` (clock in/out + labourer count + note + startedBy), `tasksCompletedToday[]` (taskId references that sync to project.tasks), `materialsConsumed[]` (SKUs from parts.json), `nextDayMaterials[]` / `nextDayTasks[]` (carry-forward seeds for the next day's WO), `dailyNotes`. Helpers: `blankDailyLog`, `startSession`, `endSession`, `setLabourersForSession`, `markTaskDoneToday`, `unmarkTaskDoneToday`, `recordMaterialConsumed`, `removeMaterialConsumed`, `setNextDayPlan`, `setDailyNotes`, `listBuildWosForProject`. Build WOs accept a `parentProjectId` and use `wo.create({ type: "build", project, workDate, carryFromWoId })`. |
| `quotes.js` | Quote | `Q-YYYY-NNNN` | Versioned, signed estimate. Three flavours: `ai_repair_quote` (AI chat), `on_site_quote` (tech-built), `project_proposal` (admin-authored multi-section narrative, Brief 1 May 2026). `ai_repair_quote` has TWO creation modes (controller brief, 2026-06-12): repairs are created `sent` + auto-accepted at booking-form submit (unchanged), while **smart-controller upgrades 1-16 zones** (`[QUOTE_JSON]` carrying `kind:"controller_upgrade"` + `zones`) are created as **drafts** — Patrick reviews in admin and taps Send (`/api/quotes/:id/send-for-approval`) before the customer sees a formal quote; acceptance then rides the portal (lead quoted→won, which also flips the Quote record). `validateQuotePayload` rejects `quoteType:"custom"` items outright (no $0 quotes) and re-resolves the controller tier from the zone count via `resolveControllerTier` (reads `minZones`/`maxZones` bounds in pricing.json — data-driven, tested by `scripts/test-pricing.mjs`); 17+ zones / accessories degrade to a plain lead. `markSent` is the portal-send sibling of `markSentForApproval` (no token). Proposal type carries `branch` (six buckets — `gc_subcontract`, `direct_residential`, `lighting_design`, `renovation_coordination`, `change_order`, `residential_repair`), `billingMode`, `deliveryMode` (`proposal_page` / `plain_pdf` — the customer-facing output channel, residential_repair brief), `proposalSections[]`, `attachments[]`, `customRates`, dual `acceptanceMethod` (`portal_esign` / `pdf_return`), and revision lineage (`revisionOf` / `supersededBy`). Branch drives creation defaults via `PROPOSAL_BRANCH_DEFAULTS` (section preset, expiry, billing mode, delivery mode) — resolved data-driven, not scattered conditionals. Scope-protected fields (`SCOPE_PROTECTED_FIELDS`, now including `deliveryMode`) refuse PATCH once past draft. Helpers: `updateProposal`, `reseedProposalSections`, `resolveBranchDefaults` / `deliveryModeForBranch`, `addAttachment` / `removeAttachment` / `readAttachmentBuffer`, `recordPortalSignAcceptance`, `stagePdfReturn`, `recordPdfReturnAcceptance`, `createRevision`, `snapshotRatesFromCustomer`. |
| `invoices.js` | Invoice | `I-YYYY-NNNN` | Auto-drafted by completion cascade, lifecycle draft → sent → paid → void. Carries `disclaimers: [...keys]` array — text bodies in the `INVOICE_DISCLAIMERS` constant (currently only `fall_additional_plumbing`). `update()` merges via Set semantics so cascade re-fires never duplicate keys. **Billing-party brief (Jun 2026):** `createDraft` stamps a `billTo { name, address, email }` snapshot, resolved override-or-fallback from the customer record (`billingName \|\| customerName`, `billingAddress \|\| address`, `billingEmail \|\| customerEmail`). The PDF + QB push read the snapshot, never live data; `update()` accepts `billTo` only while `status === "draft"` (throws after send — financial-snapshot lock). **Addendum (Jul 2026):** `billTo` also carries `ccEmail`, snapshotted from `resolveBillTo().ccEmail`, which `notify-customer.sendInvoiceToCustomer` adds as a real `cc:` on the outgoing invoice email. A `billTo` patch that omits `ccEmail` preserves the snapshotted one (the invoice edit UI only surfaces name/address/email); an explicit `""` clears it while still a draft. Legacy invoices have `billTo: null` and behave exactly as before. **Void+delete brief (Jul 2026):** `voidInvoice(id, {reason?, by})` flips draft/sent → void (refuses paid, idempotent on void, cancels pending unsent SMS, stamps `voidedAt/By/voidReason` — reason optional). `remove(id, {reason, by, qbVoidConfirmed})` hard-deletes a VOID invoice — void-first is the only road; appends a frozen snapshot to `deleted-invoices.json` (tombstone) BEFORE removing from `invoices.json`, both writes atomic; refuses non-void (409), empty reason (400), or a QB-pushed invoice without `qbVoidConfirmed` (409). |
| `bookings.js` | Booking | `BK-YYYY-NNNN` | First-class appointment record. Mirrors `lead.booking` but is canonical. Exposes `cancel()` (soft, adds `cancelledAt/By/Reason` + history), `reschedule()` (sets `scheduledFor` + bumps `rescheduleCount` + history), and `remove()` (hard delete; refuses when a linked WO is past `scheduled` — caller passes `isActiveWo` to gate without coupling to work-orders.js). Schema includes `rescheduleCount` (capped at 1 for customer self-service via the portal endpoint; admin bypasses the cap). |
| `site-plan-calibration.js` | — | — | **Pure math for site-plan scale calibration** (Site Plan Underlay brief, Aug 2026). No fs, no network, no dependencies. Owns the numbers a tender depends on: `deriveFtPerPx` (two-point calibration), `verifyCalibration` + `classifyResidual` (the mandatory second-dimension check and its pass/warn/fail bands), `verifyPointsAreIndependent`, `parseStatedScale` + `statedScaleCrossCheck` (advisory title-block comparison), `checkSheetCoverage` (order-of-magnitude sanity), the vertex/payload budget helpers, and `isValidPageId` / `isValidProjectId` (the path-traversal guard). `server.js` **derives** `ftPerPx` here from the raw clicked points on the way in — it never accepts a client-computed scale. Exercised by `scripts/test-siteplan-calibration.mjs` on every `build:check`. |
| `projects.js` | Project | `PROJ-YYYY-NNNN` | Multi-WO container for named jobs. Lifecycle planning → active → complete → archived. `createFromProposal(quote, …)` (Brief 1) enriches a project at conversion time from a `project_proposal` quote: `branch`, `billingMode`, `labourRateLocked` (snapshotted from `quote.customRates.labour`), `tasks[]` (seeded from line items — one task per line, status `pending`, `sourceLineItemId` set), `attachments[]` (references to the quote's attachments by id), and a frozen `proposalSnapshot` mirroring the accepted proposal at that instant. **Brief 2** adds execution ops: task CRUD (`addTask`, `updateTask`, `removeTask`, `markTaskComplete`, `unmarkTaskComplete`, `seedTasksFromQuote`); scope changes (`createScopeChangeRequest`, `updateScopeChangeRequest`, `sendScopeChangeRequest`, `resolveScopeChangeRequest`, `generateQuoteRevisionFromScopeChange`); status updates (`generateStatusUpdate`); project completion (`markFinalWo`, `completionPreflight`, `completeProject`); metrics + billing rollup (`computeProjectMetrics`, `computeTAndMBilling`). Schema additions: `scopeChangeRequests[]`, `statusUpdates[]`, `finalWoId`, `projectCompletionAt`, `invoiceGeneratedAt`, `finalInvoiceId`. **Customer-link brief (Jun 2026):** `customerId` references `customers.json` (numeric id); the project page Customer field is **pick-from-existing** (no free text). `update()` accepts `customerId` and snapshots the customer's name/email/phone + negotiated labour rate (→ `labourRateLocked`, never clobbering a T&M proposal-locked rate) via the shared `buildCustomerSnapshot(customerId)` helper — the manual-project parallel to `createFromProposal`. Billing entity is shown live from the linked customer (no project-level `billTo`). Property/Address stay manual. Legacy projects (`customerId` null) keep their stored `customerName` and offer a link-upgrade prompt; unlinking never blanks the snapshot. **Site Plan Underlay brief (Aug 2026):** adds the `sitePlan` durable field plus `addSitePlanPage`, `readSitePlanRaster`, `setSitePlanCalibration`, `removeSitePlanPage`, `sitePlanDependents`, `sitePlanPagePath` / `ensureSitePlanDir` — the raster half mirrors `quotes.addAttachment` exactly. Also introduces a module-level **write lock** (`withWriteLock`): every read-modify-write in this file now queues, because the builder autosaves `systemDesign` while the calibration PATCH writes `sitePlan` on the same record, and the interleaved `readAll → … → writeAll` cycles could silently drop one of them. Reads are deliberately unlocked. |
| `material-lists.js` | Material List | `ML-YYYY-NNNN` | Bill of materials. Line items reference parts.json SKUs + quantities + status (`need` / `ordered` / `have`). Attachable to a project / WO / quote / standalone. **Pricing:** a line's unit price resolves **live from parts.json until its PO is sent** (catalog edits show on the next load), then **locks** to the PO-snapshotted price — `frozenPriceCents` is stamped onto the line at send and cleared if the PO is cancelled (a received line keeps the price paid). One pure resolver, `resolveLineUnitPriceCents(line, partsMap)`, feeds **both** read paths — the builder's per-line render/savebar and the `?withTotals=1` server totals — so they can't disagree. The builder fetches `/api/parts` `no-store` (not force-cache) so live prices aren't stale. |
| `purchase-orders.js` | Purchase Order | `PO-YYYY-NNNN` | One supplier's slice of a material list's `need` lines. Lifecycle draft → sent → partially_received → received → cancelled. |
| `quote-requests.js` | Quote Request (RFQ) | `RFQ-YYYY-NNNN` | The **"ask for a price" sibling of the PO** — asks a supplier to quote, commits to nothing. Generated from a material list's `need` lines grouped by primary supplier (same grouping as PO generation) but **never changes line status** (lines stay `need`) and **never snapshots prices** — lines carry `{ sku, description (snapshot via resolveLineDescription), quantity, unit, quotedPriceCents:null }`. Lifecycle draft → sent → quoted → applied (+ cancelled). Generation is idempotent: re-running **refreshes** the existing draft for (list, supplier) instead of duplicating; non-drafts are never touched. Sent docs frozen at `data/quote-requests/files/`. **Phase B (the return loop):** `recordQuotedPrices(id, {lineId: cents\|null})` records the vendor's reply on a sent/quoted RFQ (partial quotes fine; status follows the data — any priced line → `quoted`, all cleared → back to `sent`); `markApplied` flips quoted → applied and is the double-apply guard (second apply throws). The apply route writes the quoted prices to the parts catalog via the **existing** parts edit path (`partsLib.update` → `rebuildCatalogFromOverrides` → one batched `catalog.rfq-apply` audit entry), skipping deleted SKUs and counting already-matching prices as applied-without-write; open material lists pick the new prices up immediately (live pricing). Never touches `pricing.json`. Retires the old workaround of sending a $0 PO as a "Quotation Request". **Shopping a list (Aug 2026):** `planFromMaterialList(list, parts, { shopSupplierIds })` switches from *split by assigned supplier* to **shop** mode — the SAME whole list goes to EVERY named supplier, ignoring the catalog's per-part assignment, and an unassigned SKU is shopped rather than blocking (not caring what the catalog lists is the point of asking). `compareQuotes(rfqs, {listId})` lines the replies up by SKU and marks the cheapest, counting only `quoted`/`applied` RFQs — a draft carries no reply and a cancelled one was withdrawn — and refusing to call a lone quote a comparison. **`apply-cheapest-quotes` exists because per-RFQ apply is last-write-wins:** applying the dearer supplier second silently RAISED the catalog price, so the per-RFQ apply route now **409s** when a sibling RFQ from the same list quoted a SKU cheaper, naming them (`?force=1` overrides). |
| `suppliers.js` | Supplier | `SUP-NNN` (no year prefix) | Vendor records (name, contact, email, phone, address). |
| `part-suppliers.js` | — | n/a | Override map at `data/part-suppliers.json` mapping SKU → supplierIds[]. parts.json's `supplierIds` field is a placeholder; this file is the source of truth. |
| `settings.js` | — | n/a | Admin notification preferences + 50-entry audit trail + iCal-feed token (Brief C: `icalFeed.{enabled, token, regeneratedAt}` — token is the credential for the public `/calendar/<token>.ics` feed) + `contactInfo.customerSupportPhone` (surfaced verbatim in portal blocked-state copy when self-service reschedule/cancel is refused; exposes `updateContactInfo()` for the `/api/settings/contact-info` PATCH endpoint) + per-season outreach templates (`outreachTemplates.{spring,fall}.{subject,smsBody,emailBody}`, saved via `saveOutreachTemplate`) + **invoice-ready SMS** (`invoiceSms.{enabled, delayMinutes, maxAgeHours}` — master switch + cascade-time delay before the customer SMS fires + sweep-window cap; defaults `enabled:true / delayMinutes:5 / maxAgeHours:24`). |
| `ical-feed.js` | — | n/a | Builds the read-only `.ics` feed for iPhone Calendar subscription. Filters bookings to `status === confirmed` and a -90d / +365d window; uses stable `BK-…@pjllandservices.com` UIDs so reschedules update the existing event. |
| `ical-format.js` | — | n/a | Hand-rolled RFC 5545 helpers: value escaping, 75-octet line folding, Toronto VTIMEZONE block, local + UTC date formatters. |
| `completion-cascade.js` | — | n/a | Fires on WO status → completed. Idempotent. Creates service record on property, draft invoice (with `paidOnSiteAtCompletion` flag), customer + admin emails, warranty stamp, **Service Report PDF snapshot** (gated by `wo.completionReportSnapshotAt`; failure leaves stamp unset and the cascade-recovery admin action becomes the retry path). Applies property edits via `computePropertyEdits()` (Brief D — zone/controller diffs, new zones flagged for Patrick review) gated by `wo.propertyEditsAppliedAt`. Logs `cascade_fire`, `invoice_drafted` (when a draft was created), `property_edits_applied`, and `report_snapshot_created` history entries. When the cascade throws mid-flight, the PATCH handler appends `cascade_failed` to the WO history and surfaces `cascade.error` in the response — the WO stays signed + locked + completed (recoverable via /run-cascade or /create-invoice). Attaches `fall_additional_plumbing` disclaimer key when WO is `fall_closing` and `property.seasonalPricing.hasAdditionalFallBlowout` is true (resolved against the LIVE property record, idempotent via Set in `invoices.update`). **Brief 2** adds service-mode branching: `build` WOs short-circuit the standard cascade (`mode: 'build_short_circuit'`) — invoice + customer email + warranty + service record all defer to project completion. New `runProjectFinalCascade(project, …)` fires when admin presses "Complete project" — generates invoice (T&M via `projects.computeTAndMBilling()` or fixed-price mirroring `proposalSnapshot.lineItems`), creates property service record (`projectId` set), sends emails, stamps 36-mo install warranty. Refuses with `unknownSkus` error when a consumed material SKU has no retail price in parts.json. **Invoice SMS brief (May 2026)** adds step 5 — schedules the customer invoice-ready SMS (5-min default delay) when `paidOnSiteAtCompletion === false`, `settings.invoiceSms.enabled !== false`, and customer SMS-allowed. Idempotent via `invoice.customerSmsSentAt` + `customerSmsScheduledAt`. Mints `portalToken` via `invoices.ensurePortalToken`. Primary fire path is a `setTimeout`; `notify-customer.sweepPendingInvoiceSMS()` is the restart-recovery sweep. Logs `customer_sms_scheduled` / `customer_sms_skipped_*` history entries. |
| `lead-customer.js` | — | n/a | **Lead → Customer resolution** — which canonical customer an intake lead belongs to, and when to create a new one. Lifted out of `server.js` by the commercial-matching brief (Phase 0.5) so the rule is testable at an integration boundary; `server.js` re-exports `resolveCustomerForLead` under the original name, so every call site reads unchanged. Order: **(1) commercial address anchor** — if the lead's address resolves to a building owned by a commercial account, that account IS the customer (no identifier match, no create); **(2)** email → phone identifier match (spec §3.1); **(3)** create, carrying the lead's commercial block for a genuinely new commercial account. Step 1 is the fix for the duplicate-management-company defect — customer resolution runs BEFORE `properties.attachLead`, so fixing the property attach alone would not have prevented the duplicate. The address wins over a conflicting identifier match (a PM who changed companies is not a different building); the mismatch is logged and surfaced by `attachLead`. `finishCustomerForLead` is the shared tail (communication record + fill-empty-only billing seed) so the anchor path and the residential path do identical record-keeping. Residential resolution is byte-identical — no anchor is ever produced for a residential-owned building. |
| `billing-parties.js` | — | `con_xxxxxxxx` (contacts) | **Resolves WHO is billed and THROUGH WHOM** from the `(property, customer)` pair — the single source for the bill-to envelope, so invoices, quote PDFs and the admin UI can never disagree. `resolveBillTo(property, customer, {fallbackAddress})` → `{ name, careOf, address, email, ccEmail, managed }`. Two branches: **managed** (the property names its own `billingEntity` AND a differently-named customer exists to bill through → `name` = the site's entity, `careOf` = the managing company, `address` = the manager's billing address, `managed:true`) and **everything else** (residential, or a commercial account whose entity equals its own name → `name` = `billingEntity \|\| customer.billingName \|\| customer.name`, `careOf` = the manual `customer.commercial.careOf` override, `managed:false`). The second branch is **byte-identical to pre-commercial behaviour**, which is why residential invoices are untouched; a regression test pins the whole envelope object. `resolveContactRoles(property, customer)` → `{ signatories, siteContacts }`, each entry tagged `from: "customer" \| "property"` — customer contacts are org-wide, property contacts are site-scoped. **`ccEmail`** (addendum, Jul 2026) resolves on BOTH branches as `property.billingCcEmail \|\| customer.billingCcEmail` (trimmed, lower-cased) — the party that PAYS is often not the party that ACCEPTS, so a bookkeeper or a per-site accounts-payable desk can be copied on the bill. Kept deliberately separate from `email`; **invoice emails only, never quotes.** `invoices.createDraft` snapshots it onto `invoice.billTo.ccEmail`, and `notify-customer.sendInvoiceToCustomer` reads that snapshot (not live data) so a later CC edit can't change who was copied on an already-sent invoice. Also owns **contact identity**: `isContactId` / `makeContactId` / `coerceContactId` mint the `con_` ids used by BOTH contact lists, so the two can never drift into different id formats — and **`buildInvoiceCcList({to, spouseEmail, billingCcEmail})`**, the pure helper that assembles an invoice's `cc:` and drops duplicates (case-insensitively) against the primary recipient and each other. Consumed by `invoices.js` (draft `billTo` snapshot), `server.js` (quote send + admin), `quote-pdf.js`, and the property/customer admin pages. **Historical invoices keep their snapshotted envelope — a later `billingEntity` edit never retro-rewrites an issued invoice (Hard Rules 2 & 10).** |
| `issue-rollup.js` | — | n/a | Maps zone issues into priced line items for the on-site quote. Manifold rule, controller subtype tier selection, etc. |
| `pricing.js` | — | n/a | `priceForBooking(serviceKey, zoneCount)` reads `pricing.json`. `resolveSeasonalPrice(property, serviceType)` cascades property override → pricing.json tier → custom-quote signal. Only accepts `spring_opening` / `fall_closing` — `service_call` is canonical and never per-property-overridable. |
| `availability.js` | — | n/a | Slot generator + `BOOKABLE_SERVICES` catalog. Endpoints can pass `from`/`to` (YYYY-MM-DD); `expandDaysToRange()` backfills every day in the range with `{slots, reason}` so the month-calendar picker can render available + unavailable cells in one pass. |
| `schedule-store.js` | — | n/a | Calendar blocks + per-day hour overrides. |
| `geocode.js` | — | n/a | Google Geocoding wrapper + cache. |
| `distance.js` | — | n/a | Distance Matrix + Haversine fallback. |
| `quote-pdf.js` | — | n/a | Branded quote PDF (pdfkit). Dispatcher by `quote.type`: `ai_repair_quote` w/ `narrativeKey` → rich multi-section `renderSmartControllerPdf` (cover → narrative sections from the content block → "YOUR INVESTMENT" table → e-sign-only acceptance; reuses the proposal section components, no proposal fork); other `ai_repair_quote` / `on_site_quote` / `formal_quote` (legacy) → one-page `generateQuotePdf`; `project_proposal` → multi-section `renderProjectProposalPdf` with embedded attachments + dual-acceptance block. Use `renderQuotePdf` for new callers; `generateQuotePdf` remains exported for back-compat. **Line-item tables** (shared `renderProposalLineItems`, used by `project_proposal` + the smart-controller path) use **measured** row heights (`heightOfString` against the description column width, floored at a single body line) and break across pages with a repeated column header; the totals block is kept together so a lone "Total CAD" is never stranded. Fixed-height rows were the cause of the multi-line-description collision fixed 2026-07 across **both** table renderers — the shared `renderProposalLineItems` (Brief A) and the legacy one-page `generateQuotePdf` table (Brief A2). **Fonts:** only Barlow Condensed **Bold** is registered (`server/assets/fonts/BarlowCondensed-Bold.ttf`, as `Barlow-Bold`, headings only; falls back to `Helvetica-Bold`); **all body/description text is pdfkit built-in `Helvetica`** — no body TTF is registered and the Barlow TTF is not served to the browser (the proposal editor loads Barlow + DM Sans from Google Fonts). **Snapshotting (Brief B, 2026-07):** sent quote/proposal PDFs are **frozen to disk** on send at `server/data/quote-pdfs/<quoteId>.pdf`, with `pdfPath` / `pdfSha256` / `pdfGeneratedAt` on the quote record (mirrors the PO `pdfPath` pattern). Every read — admin download, tokenized `/approve` print-to-sign, resend, and the emailed attachment — serves those exact bytes; drafts still render live. One file per quote record (revisions are new records, Hard Rule 9). Legacy sent quotes with no snapshot lazily backfill on first read (`pdfBackfilled: true` — honestly flagged, NOT a reconstruction of what the customer originally received). A recorded snapshot whose file is missing returns an honest error, never a silent re-render. Prior to this, every read re-rendered live and the emailed attachment differed from the downloadable copy (the proposal email even shipped a blank PREPARED FOR name — fixed here by routing the send through `quoteRenderParties`). The freeze/read helpers (`renderQuotePdfBuffer`, `readFrozenQuotePdf`, `writeFrozenQuotePdf`, `serveQuotePdf`) live in `server.js`; the record fields + `markSentForApproval(pdf)` + `persistFrozenPdf` live in `quotes.js`. **Section-body markup (Brief C2, 2026-07):** proposal/controller section bodies support a **closed markup convention** — `**bold**`, `__underline__`, `*italic*`, `- ` bullets (2-space-indented sub-bullets), `1.` numbered lists (max nesting depth 1); `\* \_ \-` escape. Parsed by `parseSectionBody` (line-scoped inline runs; unmatched markers degrade to literal, never swallow content; numbered lists renumber from 1 per run) and drawn with pdfkit's built-in Helvetica family (sub-bullets are vector circles — WinAnsi has no `◦`). **Bodies stay plain strings — no rich-text schema.** A body with no working markup takes a byte-identical fast path (existing plain proposals unchanged). Sections observe keep-together rules: list items are never split across a page and section headings are not orphaned. `parseSectionBody`/`parseInlineRuns` are exported for `scripts/test-section-markup.mjs`. **Display options (Brief D, 2026-07):** rendering is controlled by `quote.pdfOptions` (`lineItems`: `itemized` \| `descriptions_only` \| `summary`; `showAttachments`; `showProjectMap`) and by per-section `include`. `descriptions_only` drops the UNIT + LINE TOTAL columns and re-flows DESCRIPTION into the reclaimed width; `summary` drops the table entirely. **Presentation only** — `pdfOptions` never affects pricing math, the accepted amount, the QuickBooks push, or invoice generation (a `summary` quote still carries full itemized lines on the record, in QB, and on the invoice). **The Subtotal/HST/Total block always renders; there is no option to hide the total** (no `showTotals` flag exists). Structural sections can't be excluded. Options are draft-editable and freeze at send with the PDF bytes (Brief B). The customer `/approve` acceptance page (`approve.js`) mirrors `pdfOptions` + per-section `include` too, so the web sign-online surface never shows pricing the PDF was told to hide. A quote with no `pdfOptions` renders byte-identically to before Brief D (itemized fast path). The **pricing-section heading tracks the mode**: `itemized` → "ITEMIZED PRICING", `descriptions_only` → "PROJECT COST", `summary` → "PROJECT PRICE". The PDF header shows an optional **`quote.quoteNumberDisplay`** override (e.g. a GC's PO number) in place of the internal id when set — the internal `quote.id` never changes (it stays the key for the frozen-PDF file, `/approve` links, QB, history); draft-editable, frozen at send. |
| `quote-narratives.js` | — | n/a | Editable narrative content blocks for rich quotes (Smart Controller brief 2026-06-12). Blocks live at `server/lib/templates/*.json` (git-tracked so copy edits deploy; NO literal prices — `{{dotted.path}}` tokens resolve from pricing.json at render). `sectionsFor(key)` / `headerFor(key)` feed both the PDF renderer and the /approve page, so the e-sign surface always matches the PDF. Current block: `smart-controller`. |
| `po-pdf.js` | — | n/a | Branded purchase order PDF (pdfkit). |
| `wo-report-pdf.js` | — | n/a | Branded Service / Inspection Report PDF (pdfkit). Two modes: `inspection_report` (pre-completion, attached to send-for-approval emails) and `service_report` (post-completion, attached to the cascade email). Mode auto-derived from `wo.locked`. Renders cheat sheet, zone walkthrough, issues + dispositions, customer-visible notes, optional service-specific checklist (service mode only), signature/bypass block, fall-closing liability disclaimer (fall mode only), and Media Summary. **No prices anywhere** — quote and invoice are the financial artifacts, the report is the service-narrative artifact (Hard Rule 16). |
| `wo-report-snapshot.js` | — | n/a | Freezes a rendered report to disk at `server/data/wo-reports/<woId>/<snapshotId>.pdf` and records the entry on `wo.reportSnapshots[]` via `workOrders.appendReportSnapshot`. Trigger types: `quote_send`, `cascade`, `manual`. SHA-256 hash recorded for integrity. Exports `createSnapshot`, `readSnapshot`, `findLatestCascadeSnapshot`. |
| `notify-email.js` | — | n/a | Admin email on new lead (Gmail SMTP). Renders a conditional "Bill to" section (name / billing address / billing email) directly below the Address row when `lead.billing.billTo === "other"`; self-billing leads produce the exact pre-feature email. |
| `notify-sms.js` | — | n/a | Admin SMS on new lead (Twilio). Fires on **every** lead-intake path alongside the admin email — both the `/api/quotes` booking intake **and** the `/api/new-customer` Customer Self-Intake form. Requires `NOTIFY_TO_PHONE` (E.164) — unlike the email's `NOTIFY_TO_EMAIL` it has **no default**, so a blank value silently skips the SMS (lead still saves). |
| `notify-customer.js` | — | n/a | Customer-facing transition emails / SMSes (booking confirmed, on the way, etc). Also exports `sendBookingCancellation(booking, {reason, notify, baseUrl})` — fire-and-forget cancellation email triggered from `/admin/schedule` — and `sendOutreachEmail` / `sendOutreachSms` (feature-seasonal-outreach-brief.md §3.5) used by `outreach.js` for the bulk booking-nudge batches. Outreach senders append a CASL unsubscribe footer (email) and the literal "Reply STOP to opt out." line (SMS), idempotent against operator-supplied STOP. **Invoice SMS brief (May 2026)** adds `sendInvoiceReadySMS({ invoiceId })` (idempotent via `invoice.customerSmsSentAt`; honors `customer.notificationPrefs.textReminders`; stamps `customer_sms_sent` / `customer_sms_failed` / `customer_sms_skipped_*` to invoice history) and `sweepPendingInvoiceSMS()` (recovery sweep called on server boot + every 2 minutes — picks up `customerSmsScheduledAt` records due now and within `settings.invoiceSms.maxAgeHours`). |
| `outreach.js` | — | n/a | Seasonal bulk-nudge engine (feature-seasonal-outreach-brief.md). Lists eligible properties per season+year (`listCandidates`), orchestrates per-recipient send through `notify-customer.js` with 300 ms Twilio + 100 ms Gmail pacing and a module-level concurrent-send lock (`sendBulk` → `{batchId, sent, skipped[], errors[]}`), derives "booked for season" state from bookings.json (`deriveBookingState`), validates and applies unsubscribe tokens (`honorUnsubscribe`), and persists per-season templates via `settings.js`. Hardcoded `SEASON_WINDOWS` (spring Mar 1 – Jun 30, fall Sep 1 – Dec 15) and `SEASONAL_SERVICE_PREFIXES` (`spring_open_`, `fall_close_`). |
| `notify-supplier.js` | — | n/a | Supplier email with PO PDF attachment. |
| `quickbooks.js` | — | n/a | OAuth + invoice push + items sync + Payments charges. Token blob encrypted at rest (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` or derived from `QB_CLIENT_SECRET`). Exports: `pushInvoice`, `pushItem`, `syncAllItems`, `listTaxCodes`, `listIncomeAccounts`, `getItemsMap`, `setItemMap`, `chargeCard`, `recordPaymentForInvoice`, `voidInvoice`, OAuth helpers. **Live in production** (May 2026); on a fresh/local install it stays inactive until `QB_CLIENT_ID` / `QB_CLIENT_SECRET` env vars are set + admin connects via OAuth. **Billing-party brief (Jun 2026):** `pushInvoice` consumes `invoice.billTo` — when the snapshot names a different payer than the contact, the QB customer is resolved/created as that entity (billing email only as the match key, no contact phone leakage); self-billing pushes are byte-identical to the pre-feature payload (verified by request diff). **Commercial matching (Phase 0.5, Jul 2026):** that override branch is now forced for any invoice whose customer is `accountType === "commercial"`, not just when the bill-to name happens to differ from the snapshotted contact name. Otherwise a commercial invoice whose names coincided fell through and pushed `customerEmail`/`customerPhone` — which can be the submitter's, a property manager who will have moved on next year — attaching a transient person's details to a stable billing entity. Residential is unaffected (the flag is false, so the expression is unchanged). Persistent per-entity QB customer mapping remains Phase 2. |
| `booking-sessions.js` | — | n/a | AI handoff session storage (used by the chat widget). |

## Server-side data files (`server/data/`)

All gitignored. Live on Render's persistent disk. Hand-editing breaks
audit trails; modify only via the API.

```
auth.json                  ← session secret only (post-migration). NEVER reintroduce the single-password pattern.
users.json                  ← USR-NNN admin/tech accounts (per-user scrypt hash + salt). Created via npm run create-user.
magic-tokens.json           ← short-lived, single-use mt_<32hex> tokens (customer_login, admin_password_reset).
leads.json                 ← inbound leads (the CRM core; lead.id is the customer identity for portal sessions). Optional `billing { billTo:"other", name, address, email, phone, careOf? }` block (billing-party brief Jun 2026; `careOf` added by the commercial-intake brief Jul 2026 — the management company a commercial invoice is addressed through) — only persisted when the intake asked to bill someone else; self-billing leads carry no block. **Commercial-intake brief (Jul 2026):** a commercial `new-customer.html` submission also carries `accountType:"commercial"` and a `commercial { submitterRole, poRequired, paymentTerms, additionalContacts:[{name, role, email, phone}] }` block (role/terms allow-lists coerced server-side; contacts capped at 5). Residential leads carry **neither** key and stay byte-identical. The billing entity itself lives in the `billing` block above (`billing.name` = legal entity, `billing.careOf` = management company) — the `commercial` block does not duplicate it.
customers.json             ← canonical Customer records (numeric QB-style ids; name/phone/email + spouse fields, billingName/billingEmail/billingAddress, status, quickbooksId, notificationPrefs, negotiatedRates, communicationRecords, history). Commercial layer: `accountType:"residential"|"commercial"` and `commercial { careOf, poRequired, paymentTerms, contacts:[{id:"con_…", name, role, email, phone, isSiteContact, isAuthorizedSignatory}] }` — null on residential accounts. Signatories are ORG-WIDE (they sign for every site the customer manages); per-site people live on the property instead. Also `billingCcEmail` (addendum Jul 2026) — one extra address copied on INVOICE emails only (the bookkeeper who pays, as opposed to the signatory who accepts); a property can override it per site.
properties.json            ← customer site profiles (now includes seasonalEligibility, seasonalOutreach[YYYY:season].{touches[], optOutThisSeason}, and commPrefs.{seasonalRemindersSMS, seasonalRemindersEmail, optOutTokens}; customerName is required non-blank). Commercial layer: `billingEntity` (this site's own legal payer, e.g. "YRSCC No. 1233 — Lewis Honey Condominiums"; empty = the customer is the payer) + `siteContacts[]` (same contact shape as `customer.commercial.contacts`, scoped to THIS site) + `billingCcEmail` (per-site override of the customer's invoice CC; empty = fall back to the customer's).
work-orders.json           ← per-visit field documents
quotes.json                ← Q-YYYY-NNNN records
invoices.json              ← I-YYYY-NNNN records (includes `paidOnSiteAtCompletion`, `paymentToken`, **invoice-ready SMS fields** `customerSmsScheduledAt` / `customerSmsSentAt` / `portalToken` — Invoice SMS brief, May 2026 — the `billTo { name, address, email }` snapshot set at draft, editable only while draft — billing-party brief, Jun 2026 — and the void audit `voidedAt` / `voidedBy` / `voidReason` — void+delete brief, Jul 2026)
deleted-invoices.json      ← append-only tombstone log for deleted VOID invoices — audit record, never pruned, EXCLUDED from the customer-delete referential scan (void+delete brief, Jul 2026)
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
site-plans/<projectId>/<pageId>.png|jpg  ← rasterized site-plan sheets for the Sprinkler System Builder underlay (Site Plan Underlay brief, Aug 2026). PNG / JPEG only — 16 MB per sheet, 64 MB per project. Rasterized IN THE BROWSER by the vendored pdf.js; the original PDF is never uploaded or stored, so no third party's tender document is retained on PJL's disk. `pageId` is `spp_` + random8 and is validated against `/^spp_[a-z0-9]{8}$/` before any `path.join`. Served ONLY through the session-gated `GET /api/projects/:id/site-plan/pages/:pageId/raster` — there is deliberately no tokenized public serve (unlike quote attachments), because these are confidential third-party drawings.
quote-pdfs/<quoteId>.pdf   ← frozen quote/proposal PDF, written once on send (Brief B, 2026-07). Immutable; every read (admin download, /approve print-to-sign, resend, email attachment) serves these bytes. One file per quote record — revisions are new records (Hard Rule 9) and get their own file. Legacy sent quotes lazily backfill on first read (pdfBackfilled flag).
```

**Disk usage flag (Service Report brief + Brief B).** Each WO report snapshot is ~2–5 MB (photos + pdfkit overhead). At ~200 visits/season + occasional quote-send snapshots, expect ~400 MB / year added to the persistent disk. **Frozen quote PDFs (Brief B, 2026-07) add to this:** a text-only proposal or one-page quote freezes at ~55–60 KB, but a proposal that embeds attachments (Google Earth captures, CAD, schematics) carries those images inline and can run several MB — of the same order as a WO report. Budget quote PDFs alongside WO reports against the same 1 GB Render Starter allocation. Narrows headroom but does not breach it for several seasons — watch; a retention/compression policy is deferred (Brief B §3.7).

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
| `today.html` | `/admin/today` | Tech morning hub — today's confirmed bookings with navigate + notify + open-WO actions per row. The Navigate action routes through the shared `crm-contact.js` primitive (Apple/Google Maps chooser, directions mode). |
| `admin.html` | `/admin` | Lead pipeline / CRM dashboard. Search, filter by stage, open lead detail card. Inline quote display + property link conflict detection. **"Book appointment"** action on the lead detail card opens the shared admin time picker (custom-time enabled) pre-filled from the lead and books directly against it — for AI-diagnostic leads that didn't self-book — without creating a duplicate lead. The modal **requires an explicit appointment-type choice** (a "— Choose appointment type… —" placeholder; only pre-selected when the type can be confidently inferred) so a lead with no service info never silently books a 1-4 zone spring opening. The lead's Work Order section also carries a **"Change appointment type"** control that re-points an existing booking's service (moving duration + price). |
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
| `quote-proposal-builder.html` | `/admin/quote/<id>/proposal` | project_proposal editor (draft-only; auto-saves via `PATCH …/proposal`). **Sections are fully editable (Brief C1):** add, remove (confirm), reorder (↑ ↓ — not drag-and-drop, for iOS), retitle. Order in `quote.proposalSections[]` is order in the PDF. Structural sections (`line_items`, `acceptance_block`) are pinned at the bottom as "Required" and cannot be removed; `kind` is server-controlled (user-added sections are `kind:"custom"`). The prior "leave blank and it won't display" behaviour is **superseded** — to omit a section, delete it. **Formatting toolbar (Brief C2):** B / U / I / bullet / numbered / indent / outdent write the closed markup convention into the body — which stays a `<textarea>` (deliberately, no `contenteditable`, for iOS Safari). Toolbar buttons `preventDefault` on mousedown to keep the selection; the textarea approximates the PDF content width (≈672px) in a Helvetica/Arial face. Markers are visible while typing; the PDF preview shows the result. **PDF display options (Brief D):** a "PDF display — what the customer sees" panel — pricing detail radios (Itemized / Descriptions only / Summary total only), Include-attachments + Include-project-map checkboxes — plus a per-section "Include in PDF" toggle (disabled on structural sections). Excluded sections show a "hidden" tag in the nav and stay on the record + editable. Presentation only; the total can never be hidden. A **"Quote number on PDF"** field sets `quoteNumberDisplay` (the header shows it instead of the internal `Q-…` id; blank = use the id). |
| `invoices.html` | `/admin/invoices` | Invoice index. |
| `invoice.html` | `/admin/invoice/<id>` | Invoice editor. Two-column layout (invoice document left, sticky admin actions right). |
| `material-lists.html` | `/admin/material-lists` | Material list index with parent + status filters. |
| `material-list.html` | `/admin/material-list/<id>` | Mobile-first builder. Search/browse catalog, qty steppers, parent picker, copy-from-past, sticky savebar with running totals, "Generate purchase orders" button. |
| `suppliers.html` | `/admin/suppliers` | Supplier records. |
| `parts-suppliers.html` | `/admin/parts-suppliers` | Catalog grid grouped by the 7 `parts.json` categories (collapsible category sections → subcategory sub-headers → SKU rows). Each row still has an inline per-SKU primary-supplier `<select>` (single-edit auto-save via `PATCH /api/part-suppliers`). Adds **bulk reassignment**: inline row checkboxes + per-category tri-state "select all" + a global "select all shown", then a sticky selection toolbar (supplier dropdown + "Reassign selected" + confirm dialog) that rewrites every ticked SKU's primary supplier in one batch `PATCH`. Also owns catalog CRUD + xlsx import/export. Read-only **Manufacturer** column + filter-by-manufacturer (Brief B1). |
| `purchase-orders.html` | `/admin/purchase-orders` | PO index. Status filter + "Show closed" toggle. |
| `quote-requests.html` | `/admin/quote-requests` | RFQ index. Status filter (draft/sent/quoted/applied/cancelled) + "Show closed" toggle. No prices anywhere. |
| (Materials sub-nav) | — | The materials pages (`material-lists.html`, `quote-requests.html`, `purchase-orders.html`, `suppliers.html`, `parts-suppliers.html`) share a `.suppliers-subnav` strip duplicated by hand. Below 768px the strip collapses into a single `<details>` dropdown ("Materials → <current> ▾"); open/close behaviour lives in `crm-nav.js`. |
| `purchase-order.html` | `/admin/purchase-order/<id>` | PO detail. Send modal (email + PDF), partial-receive modal, reorder, cancel. |
| `quote-request.html` | `/admin/quote-request/<id>` | RFQ detail. Draft line trim (qty/remove) + notes with auto-save, send modal (emails the vendor a request for pricing — explicitly not an order), resend, cancel, PDF/CSV downloads. On sent/quoted: the **quoted-price quick-grid** (dollars in, cents stored; partial quotes fine; auto-saves changed entries only) and, once quoted, **Review & apply to catalog** — a confirm modal showing current catalog price → quoted with deltas before any write. |
| `sitebuilder.html` | `/admin/sitebuilder` | **Sprinkler System Builder.** Internal install-design tool. Water supply → per-area shape (rectangle / known sq ft / drawn polygon, circle, sector, or **traced over a calibrated site plan**) → manual head layout (free arc + reduced throw per head, see below) → tree/drip rings → arc-aware zone packing → BOM → linked **Material List** + `project_proposal` **Quote**, plus a standalone water-cost-by-town estimate. Designs save to `project.systemDesign` (512 KB cap) via `PATCH /api/projects/:id`; every save re-syncs an already-linked DRAFT quote, keeping edited prices and never overwriting a sent one. **Site-plan underlay (Aug 2026):** upload a tender PDF or image, pick sheets, calibrate each against a printed dimension, verify against a second one, then trace areas directly over the drawing. See **Site plan calibration** below. **Master plan (Aug 2026):** one sheet showing every traced area at its true position, coloured by valve, with the point of connection, valve manifolds and a measured mainline drawn over it. Role gate: `user` (admin OR tech). The only admin page still carrying its CSS and JS inline rather than split into `.css`/`.js` siblings — known, deliberate, and its own separate piece of work. |
| `chats.html` | `/admin/chats` | AI chat transcripts (booked + abandoned). |
| `settings.html` | `/admin/settings` | Notification defaults, audit trail, QB connect, exports. |
| `login.html` | `/login` | **Unified sign-in door** (Jul 2026): staff email + password AND customer magic-link requests on one page. Password-first server logic — staff credentials match → CRM session; every other outcome (blank/wrong password, unknown email, customer email) falls through to the magic-link path and returns one generic "check your email" response (no staff-email enumeration). Button reads "Login Now". Staff credentials live in `users.json`; `auth.json` is the session-secret store only. `/portal/login` 301s here; the emailed `/portal/login/verify` links and permanent `/portal/<token>` URLs are unchanged. |
| `users.html` | `/admin/users` | Admin-only per-user account management (CRUD, disable, reset password). Tech role gets 403. |
| `reset-password.html` | `/reset-password?t=<mt_id>` | Admin/tech password reset landing page (magic-token-gated). |
| `portal.html` | `/portal/<token>` | Customer-facing portal: project request, deferred recommendations (pre-authorize with signature), signed quotes, scheduled appointments, notification prefs. Self-service appointment moves: **Reschedule** (once per booking, >24hrs out) and **Cancel** (with captured reason, >24hrs out) — both gated server-side via `/api/portal/:token/booking-actions` preflight, with greyed buttons and a phone-fallback row when blocked. An **admin-only "Change appointment type"** control also renders on the work-order card **only when an admin/tech session is viewing the portal** (driven by `portal.viewerIsAdmin` + an admin-only `booking.bookingId` in the payload; a customer's payload carries neither, so they never see it); it POSTs to `/api/bookings/:id/service-type`. The permanent `<token>` URL stays valid; magic-link sessions redirect here after setting a `customer:<leadId>` cookie. **Server-side Open Graph substitution** (feature-seasonal-outreach-brief.md §3.8): handler reads the token + optional `?season=spring\|fall` query param, looks up lead → property → customerName, then string-replaces `{{ogTitle}}` / `{{ogDescription}}` / `{{ogImageUrl}}` / `{{canonicalUrl}}` placeholders in `portal.html` before responding. Produces a personalized iMessage / Slack / Facebook preview card per recipient. Canonical URL always uses `PUBLIC_BASE_URL` (production host), never `*.onrender.com`. |
| `unsubscribe.html` | `/unsubscribe/<token>` | **Public** confirm-then-POST page for the CASL unsubscribe flow. Token in URL IS the credential; type comes from `?type=email\|sms\|all`. POSTs to `/api/outreach/unsubscribe` which flips the matching `commPref` off via `outreach.honorUnsubscribe`. Self-contained styles (no `/crm/` CSS dependency) so the page renders even if a carrier rewrites asset URLs. |
| `approve.html` | `/approve/<id>?t=<token>` | Customer-facing quote approval (signature canvas + PDF download) for `ai_repair_quote`, `on_site_quote`, and `project_proposal`. **Phone gate — only for a `project_proposal` carrying a custom HTML document** (Phone-Gated Proposal Access, Jul 2026; the gate exists specifically to protect the designed page). A proposal can carry a **custom self-contained HTML document** (`server/data/proposal-docs/<id>.html`, uploaded from the proposal builder); when present, the token alone renders an inline phone challenge (`inputmode="tel"`, no client format enforcement) instead of the document, and once passed the page serves the custom document **in place of** the generic render — with a server-injected **"Accept & sign online" footer** (`#pjl-accept-footer`, added before `</body>` at serve time; the file on disk is never modified) linking to `?sign=1`, which forces the STANDARD accept page (line items, totals, signature pad, PDF download, print-and-return) with no re-challenge since the unlock cookie carries over. Accepted proposals get a "✓ Accepted — thank you" footer state instead of the CTA. The server normalizes the typed number to digits-only/last-10 and compares against **every** phone on the customer's **live** record (primary + spouse + lead contact + property snapshot); on a match it mints a **24h `HttpOnly` cookie scoped to that one quote** via `POST /api/approve/:id/:token/unlock`, and the data / PDF / attachment endpoints all require it. Admin sessions and the owning customer's portal session skip the challenge; a **different** customer's session → 401 (never falls through to the challenge). **5 attempts/quote/hour** then a rolling 1-hour lock (regardless of IP), plus a broader per-IP backstop; failed attempts are logged (quote id, IP, timestamp). No-phone-on-file → generic failure **and Patrick is paged**. Bad/missing token → the same 404 as a nonexistent quote (indistinguishable). **Proposals without a custom document, and `ai_repair_quote` / `on_site_quote`, are token-only — unchanged from pre-gate behaviour.** |
| `portal-invoice.html` | `/portal/invoice/:id?t=<portalToken>` | **Public, token-gated** read-only invoice mirror linked from the customer invoice-ready SMS. Mobile-first, no admin chrome. Renders line items, totals, and a Pay button that deep-links into `/pay/invoice/:id?t=<paymentToken>`. Shows PAID badge when the invoice is paid, a "voided" notice when voided, or a "payment link is being prepared" banner when no `paymentToken` is on the invoice yet. Wrong/missing `portalToken` → 401 with no body. |
| `pay.html` | `/pay/invoice/:id?t=<paymentToken>` | **Public, token-gated** card payment page — the surface the portal's Pay button deep-links into (PJL-hosted, same tab). Mobile-first: 44pt targets, safe-area insets, no horizontal scroll. The entire card form is **Stripe's Payment Element** (iframe from js.stripe.com — card data never in the page DOM): number, expiry, CVC, billing postal + country (postal pre-filled from the invoice's bill-to snapshot), with Apple Pay / Google Pay rendering inside it once the domain's wallet verification passes. An **Express Checkout Element** above the card form gives wallets a one-tap sheet-first button (inside the tabbed Element a wallet is only a method *selection* — the sheet can't open until the main Pay button is pressed, a two-tap flow customers read as broken); it stays hidden unless Stripe confirms a wallet exists on the device, and shares the card-only method pinning and the create-intent → confirm → finalize pipeline with the card path. No custom card/address fields remain (slimmed Jul 2026). reCAPTCHA v3 gates intent creation. Test-mode banner on pk_test keys. Paid → paid banner, form hidden; void → void notice. Full detail in **Payments surface** below. |

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
- **Proposal phone gate (Jul 2026).** A `project_proposal` that carries a
  **custom HTML document** (`proposal-docs/<id>.html`) sits behind an
  unguessable URL token **plus** a phone-number challenge — the gate
  exists specifically to protect that designed page; proposals without
  one stay token-only. The phone is a *second factor against accidental
  disclosure* — a forwarded email, a shared screenshot — **not a
  password**. A phone number is not secret; the token provides
  unguessability, the phone provides "right human". Unlock state is a
  signed cookie (`pjl_proposal_unlock`) scoped to a **single quote**,
  24h, HttpOnly/SameSite=Lax/Secure. It reuses the session cookie's HMAC
  construction (`lib/proposal-unlock.js`) but is **distinct from
  magic-link tokens** — different name, payload, and lifetime; do not
  conflate, and never store unlock state in `magic-tokens.json`. Never
  described anywhere customer-facing as a password.
- **Delivery mode & the plain-PDF exemption (residential_repair brief, Jul
  2026).** Every `project_proposal` carries a `deliveryMode`: `proposal_page`
  (the designed, phone-gated page machinery — the default for every branch
  except one) or `plain_pdf` (a plain branded PDF, emailed, accepted at
  `/approve`, with **no** customer page and **no** phone gate — the default
  for the `residential_repair` branch). Because the gate engages by the
  document file's PRESENCE, `plain_pdf` is enforced by never letting the file
  exist: `POST /api/quotes/:id/generate-proposal-page`,
  `POST /api/quotes/:id/proposal-document`, and
  `POST /api/quotes/:id/proposal-hero-photo` all return **409
  `delivery_mode_forbids_proposal_page`** for a `plain_pdf` quote, and
  `send-proposal-for-approval` composes the plain-PDF path without consulting
  the document field. `deliveryMode` is derived from branch at creation,
  draft-editable, and scope-protected (frozen at send). The on-site-quote and
  ai_repair_quote flows are unaffected — they never had a `deliveryMode`.
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
| `crm-contact.js` / `crm-contact.css` | Shared contact-affordance primitive. `data-map-address="<address>"` → small Google/Apple Maps chooser (bottom sheet on mobile, popover on desktop); `data-tel="<number>"` → `tel:` dial (normalized to E.164). Capture-phase delegated click/keydown listener (survives re-renders; `stopPropagation` short-circuits tap-navigable cards); keyboard-accessible. Consolidates the Today-hub navigate action. Admin/portal only. `tel:` dials from the device line — it does **not** set outbound caller ID (that would be a separate Twilio Voice feature). Optional `data-map-mode="directions"` + `data-map-dest="<lat,lng>"` drive turn-by-turn (used by the Today navigate button). |
| `tech-sw.js` | ServiceWorker scoped to `/admin/work-order/`. Caches HTML/JS/CSS/pricing.json/parts.json (incl. `crm-contact.js`/`.css`). Network-first WO/property GETs with cache fallback. |
| `offline-queue.js` | IndexedDB outbound queue. Synthesizes 202 on offline, replays FIFO on reconnect, fires a `drain` event the page uses to reconcile in place — **no reload**. The tech page defers any repaint while a field is focused, a dictation session is live, or a save debounce is pending (the human at the keyboard wins over a background server echo), and adopts the server's `updatedAt` in that window so its own replayed writes never trigger the 409 "reload now" conflict banner. |
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
  POST   /api/customer                           ← manual create from admin UI. May return a NON-BLOCKING
                                                   warnings: [{ code:"existing_account_at_address", existingCustomerId,
                                                   existingCustomerName, existingPropertyId, accountType, address, message }]
                                                   when that address already belongs to another account (Phase 0.5).
                                                   The customer IS created — the UI surfaces "link instead of duplicating?"
                                                   Same warning shape on POST /api/properties.
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
                                                   (still respects physical conflicts). Admin sessions can ALSO
                                                   pass `leadId` to bind the booking to an EXISTING lead
                                                   ("book from lead") instead of resolving/creating a new one —
                                                   writes `lead.booking` onto that lead + a canonical `BK-` record
                                                   (sourceQuoteId picked up from `lead.quoteId`), no duplicate
                                                   lead. `leadId` is honored only for a valid admin/tech session;
                                                   public + AI-chat callers never send it. Optional
                                                   `markQuoteAccepted: true` flips the linked AI repair quote to
                                                   accepted (verbal, admin-recorded) via the booking-neutral
                                                   `quotes.accept()` — it never spawns a second booking. Failure
                                                   payload is `{ ok: false, code, message, details?, errors[] }` —
                                                   `message` is admin-grade, `errors[]` is customer-friendly
                                                   for back-compat.
  GET    /api/bookings, /api/bookings/:id
  PATCH  /api/bookings/:id
  POST   /api/bookings/:id/service-type          ← change an existing booking's appointment/service
                                                   type. Admin/tech only (path-gated). Body {serviceKey}.
                                                   Moves the visit duration + end time + WO price
                                                   envelope to match the new service, mirrors onto
                                                   lead.booking, stamps a `service_changed` history
                                                   entry + a lead activity note. 422 unknown service,
                                                   409 on a cancelled/completed/no_show booking. An
                                                   already-opened WO keeps its template. Reachable
                                                   from the CRM lead card AND the admin-only control
                                                   on the customer portal.
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
  POST   /api/admin/smart-controller-quote       ← "+New Smart Controller Quote" (admin, zero-typing). Body {customerId, propertyId?, zoneCount?, serviceCall:"charge"|"waive"}; 422 codes property_required / zone_count_required / service_call_required drive the modal's selectors. Auto-populates contact/address/zone count (system.zones.length → system.zoneCount), resolves the controller_* tier, mints lead + draft ai_repair_quote w/ narrativeKey:"smart-controller". serviceCall is REQUIRED (no default): "charge" adds the $95 catalog line; "waive" adds a $0 line labelled WAIVED that states the regular fee (note + description render on the approve page + rich PDF). 17+ zones → CRM lead only. Idempotent per property/customer. Manually-picked zone count saves back to property.system.zoneCount.
  POST   /api/quotes/:id/send-for-approval       ← admin "tap Send" on a draft ai_repair_quote: mints an approval token, branded email w/ rich quote PDF + SMS pointing at the /approve/<id>?t=<token> E-SIGN page; flips quote draft→sent + lead→quoted (portal Accept stays as fallback). E-sign flips quote→accepted + lead→won. Re-send allowed while still "sent". on_site_quote uses /api/work-orders/:id/on-site-quote/send-for-approval instead.
  POST   /api/approve/:id/:token/sign            ← public e-sign capture (handles project_proposal via recordPortalSignAcceptance)
  POST   /api/approve/:id/:token/unlock          ← public phone challenge, ONLY for a project_proposal carrying a custom HTML document (Jul 2026). Body { phone }; server normalizes (digits, last-10) vs every phone on the live customer record. Match → 24h HttpOnly cookie scoped to this quote. Malformed (<10 digits) → 422, no attempt spent. 5/quote/hr then 429 lock; wrong-number and no-phone-on-file return the SAME generic 401. No custom doc (or non-proposal) → 400 (nothing to unlock).
  GET    /api/approve/:id/:token/attachments/:attId ← token-gated public attachment serve (for proposal images embedded in /approve). For a doc-carrying project_proposal, ALSO requires an admin/owning-customer session or the unlock cookie for this quote.

  Project Proposal — Brief 1 (May 2026):
  GET    /api/admin/project-rates                ← internal admin-only rates catalog
  POST   /api/quotes/proposal                    ← create a new project_proposal in draft. Branch drives creation defaults (PROPOSAL_BRANCH_DEFAULTS): residential_repair → 5-section preset, 30-day expiry, T&M billing, deliveryMode plain_pdf; all others → 9-section skeleton, 90-day, fixed_price, proposal_page.
  PATCH  /api/quotes/:id/proposal                ← edit proposal (draft only; 409 on scope-protected fields once locked). Accepts deliveryMode (proposal_page | plain_pdf); a branch change re-derives deliveryMode. 409 document_attached_blocks_plain_pdf when switching to plain_pdf (or to a plain_pdf branch) while a proposal document is still attached — remove the document first.
  POST   /api/quotes/:id/proposal/reseed-sections ← admin: replace a DRAFT proposal's sections with its branch's preset (used when the branch changes and the admin opts in; the "don't destroy authored content" confirm lives client-side). 409 proposal_locked after send.
  POST   /api/quotes/:id/attachments             ← upload static media (PNG/JPEG/PDF, 25 MB cap)
  GET    /api/quotes/:id/attachments/:attId      ← admin-gated attachment serve
  DELETE /api/quotes/:id/attachments/:attId      ← remove attachment (draft only)
  POST   /api/quotes/:id/revise                  ← create -v2 revision; original gets superseded
  GET    /api/quotes/:id/gate-phones             ← admin: the builder's "Phone gate" panel. Returns the EXACT live phone set the unlock challenge checks (same server function — no drift), each entry with source (customer / customer_spouse / lead / property), raw value, normalized digits, and an `unlocks` flag, plus the linked customer's {id, name, phone, spousePhone} for inline editing. Edits go through the existing PATCH /api/customer/:id — the customer record stays the single source of truth.
  POST   /api/quotes/:id/generate-proposal-page  ← admin: render the designed customer page from the quote's own data and write it into the proposal-docs slot. 409 delivery_mode_forbids_proposal_page when the quote's deliveryMode is plain_pdf (residential_repair brief).
  POST   /api/quotes/:id/proposal-document       ← admin: upload the designed self-contained HTML page for a project_proposal (base64 in { filename, data }, or { filename, html }). Writes server/data/proposal-docs/<id>.html + stamps quote.proposalDocument. When present, the phone-gated /approve serves it instead of the generic render. 20 MB cap. 409 delivery_mode_forbids_proposal_page under plain_pdf.
  DELETE /api/quotes/:id/proposal-document       ← admin: remove the custom document (deletes the file + clears the metadata; /approve falls back to the generic render).
  POST   /api/quotes/:id/proposal-hero-photo     ← admin: upload the customer-page hero photo (compressed to JPEG). 409 delivery_mode_forbids_proposal_page under plain_pdf.
  POST   /api/quotes/:id/send-proposal-for-approval ← branches on the custom-document check (Jul 2026): a doc-carrying proposal emails a LINK with NO PDF attachment (gating a document then emailing it defeats the gate; the PDF is downloadable from behind the gate) and tells the customer they'll be asked for their phone (any format). A proposal WITHOUT a custom doc sends the classic email — PDF attached, original copy, unchanged from pre-gate. A plain_pdf proposal (residential_repair) always takes the PDF-attached path and never consults the document field. PDF frozen either way (Brief B). `ai_repair_quote`/`on_site_quote` sends untouched.
  POST   /api/approve/:id/:token/pdf-return      ← public — customer uploads signed PDF; flips to pending_admin_attestation
  POST   /api/admin/quote-folder/:id/confirm-pdf-acceptance ← admin attests staged PDF; flips to accepted

  Customer rates (Brief 1):
  GET    /api/customers/:id/negotiated-rates     ← admin-only read
  PATCH  /api/customers/:id/negotiated-rates     ← admin-only write

Invoices
  GET    /api/invoices                           ← filter ?status, ?woId
  GET    /api/invoices/:id
  PATCH  /api/invoices/:id                       ← lineItems, status
  POST   /api/invoices/:id/void                  ← ADMIN. Reasoned void (reason optional).
                                                   Refuses paid (409 invoice_paid); idempotent
                                                   on already-void; cancels any pending unsent
                                                   invoice SMS; mirrors the void to QBO best-
                                                   effort. (invoice void+delete brief, Jul 2026)
  DELETE /api/invoices/:id                       ← ADMIN. Hard-delete a VOID invoice, tombstoned.
                                                   Body { reason (required), confirmId (must ==
                                                   id), qbVoidConfirmed? }. Guard codes:
                                                   invoice_not_void / reason_required /
                                                   qb_push_exists / confirm_mismatch. Writes a
                                                   frozen snapshot to deleted-invoices.json
                                                   BEFORE removing. (invoice void+delete brief)
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
  GET    /api/projects/:id                       ← includes attached material lists + linkedCustomer (live summary when customerId set)
  POST   /api/projects
  PATCH  /api/projects/:id                        ← also accepts { customerId }: server-side snapshots the customer's name/email/phone + negotiated labour rate (→ labourRateLocked) via projects.buildCustomerSnapshot. Free-text contact in the same patch is ignored (server is source of truth). Invalid customerId → 400 customer_not_found. customerId:null unlinks without blanking the snapshot text. Property/address untouched.
  DELETE /api/projects/:id                       ← detaches attached lists
  POST   /api/projects/:id/attach-work-order
  POST   /api/projects/:id/detach-work-order

  Site plan underlay (Sprinkler System Builder) — all internal, never customer-facing
  POST   /api/projects/:id/site-plan/pages                        ← admin. Upload ONE rasterized sheet:
                                                                    { label, pdfPageNumber, mimeType, data (base64
                                                                    PNG/JPEG), rasterWidthPx, rasterHeightPx,
                                                                    renderScale, sourceFilename, sourceMimeType }.
                                                                    Body cap SITE_PLAN_POST_MAX_BYTES = 24 MB, passed
                                                                    EXPLICITLY (parseRequestBody defaults to 1 MB and
                                                                    would reject every real plan). 201 { ok, page }.
                                                                    413 names the actual limit.
  GET    /api/projects/:id/site-plan/pages/:pageId/raster         ← session (admin OR tech). Serves the image with
                                                                    `cache-control: private, max-age=300`. NO tokenized
                                                                    public variant — do not copy that part of the quote-
                                                                    attachment pattern. Missing file → 404, and the
                                                                    builder degrades to a plain grid with a notice.
  PATCH  /api/projects/:id/site-plan/pages/:pageId/calibration    ← admin. Body is POINTS AND TYPED DISTANCES ONLY —
                                                                    { p1, p2, knownFt, verify:{p1,p2,expectedFt},
                                                                    statedScale?, acknowledge? }. ftPerPx is DERIVED
                                                                    server-side; a client-supplied one is ignored.
                                                                    Failed verification → 400. Warned without
                                                                    acknowledge → 400. Page locked by traced areas →
                                                                    409 with `dependents[]`. Identical values → 200
                                                                    { changed:false }, no duplicate history entry.
  DELETE /api/projects/:id/site-plan/pages/:pageId[?force=1]      ← admin. 409 + `dependents[]` if traced areas depend
                                                                    on it; with force=1 the raster and metadata go and
                                                                    each dependent area's `planRef` is cleared —
                                                                    geometry is KEPT (it is already in feet).

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
                                                                body { shopAll:true } or { shopSupplierIds:[…] } = shop mode:
                                                                the whole list to every supplier, catalog assignment ignored
  GET    /api/material-lists/:id/quote-comparison            ← every reply for this list, by SKU, cheapest marked
  POST   /api/material-lists/:id/apply-cheapest-quotes       ← write the LOWEST quoted price per SKU to the catalog

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
  GET    /api/parts                              ← parts.json (incl. manufacturer + manufacturers[]) + merged supplier overrides
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

**Book from a lead (Book-from-lead brief):** AI-diagnostic leads that captured a quote but didn't self-book land in the CRM with a lead + `ai_repair_quote` and no booking. Patrick phones them; when they say yes he books directly from the lead card — no duplicate lead.

```
/admin → open lead detail → "Book appointment" → modal reuses the shared
   admin time picker (custom-time enabled), pre-filled from the lead
   ↓
POST /api/booking/reserve with { leadId, source: "admin_custom", ... } (admin-gated)
   ↓
Server binds the booking to THAT lead: writes lead.booking (forcedByAdmin
   when custom-time) + a canonical BK-YYYY-NNNN whose sourceQuoteId is picked
   up from lead.quoteId. No new lead, no new quote, pricing untouched.
   ↓
When the lead has an ai_repair_quote, the modal offers a per-booking choice:
   "Mark quote accepted" (verbal, admin-recorded — flips status via the
   booking-neutral quotes.accept(), NO second booking) OR "Leave open".
   ↓
The AI-Correct-Diagnosis bonus rides booking → lead.quoteId → WO regardless
   of the accept/leave-open choice (work-orders.js copies intakeGuarantee
   whenever the quote is linked — it does NOT gate on quote status). The WO
   itself is still created lazily (today's-schedule "open WO" / admin form);
   a fresh AI lead with no property scaffolds a one-zone empty WO, no error.
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

Manual projects — pick-an-existing-customer (Customer-link brief, Jun 2026):
The project detail page Customer field is **pick-from-existing** (no free
text). Picking PATCHes `{ customerId }`; the server resolves the snapshot
via `projects.buildCustomerSnapshot(customerId)` — the manual-project
parallel to `createFromProposal`'s enrichment. It snapshots the
customer's name/email/phone onto the project and copies
`customer.negotiatedRates.labour` into the project's existing
`labourRateLocked` (guarded: never clobbers a T&M proposal-locked rate).
Billing entity is shown live from the linked customer (no project-level
billTo snapshot — the final invoice resolves its own billTo from
customerId at completion). Property/Address stay manual (a customer owns
many job-site properties). Legacy/free-text projects (no customerId)
still render their stored name and offer a "Pick a customer" upgrade
prompt; nothing is blanked. customerId has lived on the schema since the
customers.json migration — this brief wires the picker + PATCH snapshot
that populate it for manually-created projects.

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

### 3b. Site Builder design → Quote + Material List (FLOW-26)

`server/sitebuilder.html` at `/admin/sitebuilder`, role gate `user`. The
chain, each hop a real function:

```
area geometry (typed dims, drawn shape, or traced over a calibrated site plan)
   → compute()              per-area head layout, arc-aware zone packing, GPM
   → desiredQuoteLines()    scope + controller + one line per zone
   → syncQuoteFromDesign()  creates or re-syncs a project_proposal Q-…
   → generateMaterialList() refreshes the linked ML-…
```

Once a quote exists it stays **linked**: every "Save to project" re-syncs
it — zone names and added/removed zones flow through, **edited prices are
kept**, and a sent quote is never overwritten. Both the quote and the
material list require the design to be attached to a project.

**Master plan (Aug 2026).** Every area traced onto a calibrated sheet is
already in that sheet's world frame — `world_ft = raster_px × ftPerPx`,
and `openLayout()` seeds head positions from the area's own poly — so the
whole design can be drawn on one drawing with **no transform at all**. The
"Master plan" button on a calibrated sheet card opens that view: every
traced area at its true position, drip runs and head arcs, each coloured
by the valve it actually runs on (`zoneIndexOf()` → `LAST_ZONES`). Areas
that were never traced have polys in their own private frame with no
relationship to the sheet, so they are **listed as off-plan rather than
drawn somewhere wrong**.

Layer 2 adds the supply route on the same canvas: a **point of connection**,
**valve manifolds**, and a **mainline** polyline whose length is measured off
the calibrated sheet rather than guessed. It is stored per sheet in the
design blob as `routing[pageId] = {poc, main[], manifolds[]}`; the full
mainline is `[poc, ...main]`, so the POC is the single source of truth for
where the run starts and dragging it can never orphan the line. Each
manifold tees off the *nearest point* on that polyline (`nearestOnPath()`),
and every valve is assigned to its nearest manifold — valves whose geometry
is not on this sheet are reported, not silently dropped. Mainline size comes
from `pipeForGPM(peak single-zone GPM)`, the same function the Extras panel
uses. **The measurement deliberately does not reach the BOM**: the material
list still prices pipe as an on-site figure, exactly as before, and the
readout says so on screen. Wiring measured pipe and wire into the bid is a
separate, deliberate step — see rule 3 under Site plan calibration.

Layer 3 routes the **laterals**. Each valve's run is a minimum spanning
tree (`mstFrom()`, Prim) rooted at that valve's manifold over everything it
feeds — every head on the zone, and for a drip valve the point on each
bed's outline nearest the manifold. A tree, not a pipe per head, because
that is what actually gets trenched; on a four-head lawn it is 91.6 ft
against 107.8 ft for a star. Being rooted, every segment knows its
**downstream flow** — the sum of everything past it — so each is sized on
its own load rather than the zone being drawn at one thickness, with a
floor of 3/4" because that is the lateral pipe actually stocked
(`POPO75400`), not 1/2" that would never be ordered.

Layer 4 tees the mainline and runs the wire with it. `routing[pageId].main`
is now a **tree**: every node carries `p`, the index of its parent (-1 = the
POC), so a node with more than one child is a branch. Selecting a node before
placing a bend tees off it; deleting a node in the middle of a branch splices
it out and reattaches its children rather than cutting the run beyond it loose.

The **control wire** shares the trench, so it is derived from the same tree
and never stored. An ICV solenoid takes one shared COMMON plus one switched
leg per zone, so a cable only has to carry the valves DOWNSTREAM of it —
the leg to a two-valve box needs three conductors, not one per valve on the
property. Each manifold's valve count is walked up the tree to the POC,
`+1` common `+1` spare, rounded up to a real spool (2/3/5/7/9/13-core).
Gauge comes off the longest controller-to-valve run against the conventional
24 VAC table (18 AWG ≤700 ft, 16 ≤1100, 14 ≤1800, 12 ≤2800), with the basis
printed beside the number because it is a starting figure, not a calculation
for a specific solenoid's inrush. A mainline stub past the last box carries
no wire at all.

**Valves are assigned to boxes**, not just dropped in the nearest one.
Nearest-box-wins is still the default, but any valve can be put in a
specific box: select it, then click the box. That needed real identity —
array position is not identity, because deleting an area renumbers
everything after it — so version 7 gives every area a stable `aid`, every
manifold an `id`, and every valve a `key` (`z:<aid>:<localZone>`, or
`g:<group>:<bin>` for a shared drip valve). Assignments live in
`routing[page].pins` as `key -> manifold id`.

Everything that can go stale is reported rather than obeyed. An assignment
pointing at a deleted box falls back to nearest **and says so** in the
readout; deleting a box warns first and releases its valves; an assignment
for a valve that no longer exists is dropped on save so it can never later
latch onto a new valve that happens to reuse the key. This is rule 3
applied to a layout decision: the box a valve lives in is a thing Patrick
decided, so it does not change quietly underneath him.

Two honesty details fall out of it. Heads are read from `plan.heads` +
`plan.orig`, **not** `area.manualHeads` — the layout editor never writes a
`zone` onto a hand-placed head (packZones decides that downstream), so
reading manualHeads had put every head of a multi-valve lawn in one colour
and drew nothing at all for auto-laid-out areas. And a bed over the GPM
ceiling splits across several valves, each needing its own supply back to
the manifold: those runs are fanned a few screen pixels apart and named in
the readout, because three identical lines to one tap would otherwise read
as one pipe while the footage counted three.

**Three builder-owned durable fields on the project record**, each capped
independently and each written whole:

| Field | Cap | What it holds |
|---|---|---|
| `systemDesign` | **512 KB** | The design blob — supply inputs, per-area spec, computed zones, BOM overrides, `linkedQuoteId`, and (v5) the master-plan `routing` per sheet. Opaque to the server. Now at `version: 5`; `version: 2` / `3` / `4` blobs load unchanged — v3 added `area.planRef`, v4 `area.valveGroup`, v5 `routing`, and an absent field means exactly what the older blob meant. |
| `waterCostEstimate` | **128 KB** | Standalone water-cost-by-town snapshot; opens as its own project-folder deliverable. |
| `sitePlan` | **64 KB** | Site-plan **metadata only** — sheets, dimensions, and each sheet's calibration record with full provenance. Rasters live on disk (see Data files). Not writable through the generic `PATCH` (see below). |

`sitePlan` is a top-level sibling rather than a nesting inside
`systemDesign` because `systemDesign` is rewritten whole on every save and
capped at 512 KB — a plan must not compete for that budget or be lost to a
design-blob overwrite, and it outlives any single design revision. The
generic `PATCH /api/projects/:id` accepts `sitePlan: null` (clear) and
**refuses** an object: `calibration.ftPerPx` is derived server-side, and
accepting a whole object would let a caller post an arbitrary scale past
that derivation.

### Site plan calibration

**This is business logic, not implementation detail.** It exists because
the builder's output goes into competitive tenders, and a scale error does
not produce a visibly broken screen — it produces a confidently wrong bid.
A factor-of-two confusion (1:100 read as 1:200) yields a plan that looks
entirely plausible and a price that is half or double what it should be.

**Ingestion.** Patrick uploads a tender PDF or an image. PDFs are
rasterized **in the browser** by the vendored pdf.js at ~5000 px on the
long edge (clamped at 8000 px), PNG first and JPEG q0.85 when the PNG
exceeds 6 MB, stepping the scale down 25% up to three times if the result
is still over the 16 MB per-sheet cap. Only the raster is uploaded — **the
original PDF is never stored.** The trade-off is deliberate: an underlay
cannot be re-rendered at higher resolution later without re-uploading,
which is why the render targets high resolution up front.

**Page coordinate model.** Each sheet defines its own world space in feet:

```
world_ft = raster_px * ftPerPx        raster (0,0) → world (0,0)
```

`rotationDeg` is stored and must be **0** — reserved so adding rotation
later is not a schema migration. Areas traced on the *same* page share one
frame and keep true relative position on the site (useful later for
mainline routing). Areas traced on *different* pages are **not** in a
common frame — nothing downstream uses cross-area geometry today, so this
is safe, but it is written down rather than discovered.

**Calibration, in this order, all of it mandatory:**

1. **Set scale.** Click two points on a dimension printed on the sheet — a
   dimension string, a property line, a building face — and type the true
   distance. `ftPerPx = knownFt / hypot(p2 − p1)`.

   **The box takes the drawing's own units.** PJL works in feet and inches
   and everything downstream of calibration is feet — that does not change —
   but a Canadian commercial tender is usually metric (1:200, dimensions in
   metres) while a residential sheet is imperial. So the entry accepts
   `18.865` (a bare number is still decimal feet), `18' 10"`, `18-10`,
   `226.4"`, `5.75 m`, `5750 mm`, converting once via
   `calibration.parseDistance()`. The client parses live only for the echo;
   the **server re-parses the raw string and stores the feet IT derived**, so
   the conversion sits in the same tested place as `ftPerPx`. The record keeps
   `knownFt` (authoritative feet) plus `knownInput` / `knownUnit` as
   provenance, so a sheet remembers it was measured in metres.

   **A units slip is the one error verification cannot catch.** Typing metric
   numbers into a feet box scales *both* measurements equally, so the second
   dimension agrees with the first and reports `passed` at 0% residual. Only
   the stated-scale cross-check (step 3) sees it — metres-as-feet shows a
   ~69.5% delta, its signature. That is why the printed scale, though
   advisory, is worth filling in on any metric sheet, and why the entry
   echoes `= 18.865 ft · 18'-10.4"` as you type.
2. **Verify.** Click a *second, independent* known dimension (ideally on
   the other axis) and type what it should measure. A verify point within
   5 px of a calibration point is rejected — re-measuring the same two
   clicks agrees with itself by construction and proves nothing.

| Residual | State | Behaviour |
|---|---|---|
| < 0.5 % | `passed` | Green. Tracing unlocked. |
| 0.5 – 2.0 % | `warned` | Amber. Tracing unlocked **only** after explicit acknowledgment, recorded in `verify.acknowledgedBy`. The state stays `warned` — it is never laundered to `passed`. |
| > 2.0 % | `failed` | Red. **Tracing blocked.** The message names the likely causes, and calls out a near-2× residual as a scale misread by name. |

The residual is classified on the **raw** value and only then rounded to
3 dp for storage — rounding first would let 0.4996 % round to 0.5 % and
silently cross a band.

3. **Stated-scale cross-check (optional, advisory).** Type the sheet's
   printed scale (`1:200`, `1"=20'`, `1/8"=1'`). The raster carries
   `72 × renderScale` pixels per inch of paper, so the printed scale
   converts to an expected `ftPerPx` and the delta is shown. A sheet
   exported "fit to page" surfaces here immediately. It **never gates
   anything**: the physical file is the truth, the title block is only a
   claim about it. Image uploads have no paper space, so the cross-check
   reports itself unavailable rather than inventing a number.

**Always visible while an underlay is shown:** a scale bar drawn in world
units with 10 ft / 50 ft ticks (so it is a live check on the calibration,
not decoration), the `ft/px` readout, and the passed/warned chip.

**Recalibration lock.** Once any area references a page, that page's
calibration is frozen; recalibrating is refused with the dependent areas
named. Deleting such a page is refused without `?force=1`; forcing clears
each dependent `planRef` but keeps the geometry, which is already in feet.
An identical calibration PATCH stays a clean no-op even on a locked page —
it changes no number a bid depends on. (A diff-and-confirm flow replaces
the lock in a later phase.)

**Aggregate sanity check.** Traced area summing past **80 %** of a sheet's
own calibrated extents raises a non-blocking warning — that is the
signature of an order-of-magnitude scale error.

### Hand-placed head geometry (Aug 2026)

A hand-placed head carries `{x, y, noz, arc, dir, rPct?}` on `area.manualHeads[]`.
Q/H/T/F stay as presets, and on the selected head four handles set the rest:
rotate (centre line), two **edge handles** that move each side of the wedge
independently, and a **radius handle** that pulls the throw in to as little as
**30%** of nominal — what a radius-reduction screw does on a real head. Arc is
free between **30° and 360°**; angles snap to 5° and radius to 5% while
"Snap: grid" is on. A direction arrow runs down the centre of the throw.

**Flow model — this reaches the bid, so it is deliberate:**
- **Arc scales flow on matched-precip families** (spray, MP): those nozzles are
  built so GPM ∝ arc. `loHeadSpec` already did this and works at any angle.
- **Arc does not change flow on a gear rotor** (PGP) — same nozzle, same
  orifice, same pressure. Unchanged, long-standing behaviour.
- **Radius reduction does NOT reduce the GPM budgeted.** A reduction screw
  throttles the stream without rebalancing the nozzle, so treating flow as
  unchanged is the conservative side of a valve-sizing decision — it never
  under-counts flow and so never packs a valve past its ceiling. The real
  consequence of pulling a head in is a higher precipitation rate over the
  smaller wetted area, which is a run-time matter.

**Downstream integrity.** Free arcs are **bucketed** (≤90 → Q, ≤180 → H,
≤270 → T, else F) before they reach `arcCount`, using the same thresholds the
manual-layout BOM already used to pick a nozzle SKU. That is what keeps a
137° head from falling out of the parts list and out of `areaMaterialCents` —
an unbucketed `arcCount` key is silently ignored by both. The gear-rotor
"zone mixes arcs" warning compares arcs rounded to 15°, so a free 179° vs 180°
does not cry wolf while 90° vs 180° still does. `rPct` is written only when a
head is actually reduced, so a full-throw design serializes byte-identically
to before the feature existed, and an absent `rPct` reads as full throw.

**Vertex budget.** Traced outlines are stored at 3 dp (~0.012 inch; finer
than a raster can express, and full float precision would waste the 512 KB
budget on noise digits). A live counter warns at **3,000** points and hard-
stops at **4,000**. Before any save the builder measures the serialized
blob and refuses locally above **480 KB** — 32 KB under the server cap — so
the user never learns about the limit from a failed request that has
already cost them their work.

**Confidentiality.** A tender drawing is a third party's document.
`sitePlan.confidential` defaults `true`, the raster endpoint is
session-gated with no tokenized public variant, and the underlay is never
rendered into the customer quote sheet, the proposal PDF, the portal, or
the `/approve` flow. The traced *geometry* still flows to customer-facing
output — that is the point; only the underlying drawing is suppressed.

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
| **Twilio** | Admin SMS on new lead (all intake paths incl. Customer Self-Intake / `/api/new-customer`) | New lead intake | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `NOTIFY_TO_PHONE` (E.164, no default — blank ⇒ admin SMS silently skips) |
| **Google Maps JS API** | Places Autocomplete on every editable address input + Distance Matrix on the public coverage checker | Form interaction | API key hardcoded in HTML script tags (browser key) |
| **Google Geocoding** | Property coordinates + drive-time analysis (admin only) | Property creation, today schedule | `GOOGLE_MAPS_SERVER_KEY` |
| **QuickBooks Online** | Push invoices, items, customers, and (Phase 4) estimates to QB. **Live** in production: invoice push fires during the admin "Send to customer" flow and writes the QB invoice ID + payment link back onto the local record. Configure HST tax code + default income account once in `/admin/settings` (hard-fails until set). | Invoice push: admin clicks "Send to customer" on `/admin/invoice/:id`. Item / customer push: manual triggers from `/admin/settings`. Auto-push toggles in `settings.quickbooks` (`invoiceAutoPushOnCascade`, `estimateAutoPushOnAccept`) gate any future fire-on-event behaviour. | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, optional `QB_ENVIRONMENT` (sandbox/production), optional `TOKEN_ENCRYPTION_KEY` |
| **Twilio (customer SMS)** | Customer-facing SMS for lifecycle events (booking confirmed, on-the-way, rescheduled) and the invoice-ready nudge that fires ~5 min after WO completion. | Cascade-scheduled (`setTimeout` + sweep recovery) from `completion-cascade.js`; honors `customer.notificationPrefs.textReminders` and `settings.invoiceSms.enabled`. | Same Twilio creds as the admin row above. |
| **Stripe** | Card processing on `/pay/invoice/:id` (Payment Element, browser-side confirm; replaced QuickBooks Payments Jul 2026). QBO stays the ledger — the QBO Payment record is still created after each Stripe charge. Money lands in the Stripe balance and pays out to the bank on Stripe's payout schedule (batched, net of fees) — payouts do NOT auto-reconcile in QBO. | Customer pays on the pay page; webhook backstop finalizes missed confirms. | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (see env-var block) |

### QuickBooks integration details (Customer + Item handling)

**Customer:** the invoice push resolves the QB Customer via `findOrCreateCustomer()` — exact-email match → DisplayName match → create new with `DisplayName/GivenName/FamilyName/PrimaryEmailAddr/PrimaryPhone/BillAddr.Line1`. **Since the billing-party brief (Jun 2026) the inputs come from `invoice.billTo`** (the draft-time snapshot): when `billTo.name` differs from the contact name, the resolved/created QB customer is the *billing entity* (e.g. "LCIG Investment Inc.") — DisplayName ← `billTo.name`, BillAddr ← `billTo.address`, and the email match key is the *billing* email only (matching on the contact email would bill the wrong entity; the contact's phone is never attached to the billing entity). The invoice `BillEmail` (delivery address) is `billTo.email` falling back to the contact email. Self-billing invoices (snapshot mirrors the contact) and legacy invoices (no snapshot) produce a payload byte-identical to the pre-feature push. The QB Customer ID is **not yet persisted back to any PJL record** — every push re-runs the lookup (the `customers.json` schema has a `quickbooksId` field, fillable by import/merge, but the push does not write it). Phase 3 of the QB integration adds persistent `quickbooksCustomerId` + `quickbooksCustomerSyncToken` so renames don't lose the link.

**Items:** every line in a pushed invoice carries an `ItemRef` resolved from `quickbooks-items.json` (PJL key/SKU → QB Item ID). When a key is unmapped, the push falls back to a single shared "PJL Services" item and records a `qb_items_unmapped` warning in the settings panel — Patrick can then run a sync to fix the gap. `npm run lint:qb-mappings` (wired into `build:check`) flags pricing.json/parts.json keys with no QB mapping.

**Tax:** the invoice payload sets `TxnTaxDetail.TxnTaxCodeRef.value` to `settings.quickbooks.hstTaxCodeId` and each line's `TaxCodeRef` to the same. QB calculates HST server-side using that code's rate; PJL's local `hst/total` are display-only post-push. The push **hard-fails** if `hstTaxCodeId` is unset (silently pushing $0-tax invoices into a Canadian QBO is worse than failing loudly). Patrick configures the tax code + default income account once, in the QuickBooks panel of `/admin/settings`.

**Hard rule:** PJL is the source of truth for service + part pricing. QB items are derived state. Editing a price in QB does not flow back to PJL. The `lastPriceSynced` field in `quickbooks-items.json` lets the syncer detect drift in PJL → QB direction only.

### Payments surface (card payment on an invoice)

**Processor: Stripe** (migration Jul 2026 — replaced QuickBooks Payments after persistent Amex charge failures; see history note at the end of this section). **QuickBooks remains the ledger**: invoices are still drafted locally, still pushed to QBO, and after every successful Stripe charge the server still creates the QBO Payment record via `quickbooks.recordPaymentForInvoice`, so the QBO invoice flips to paid exactly as before. Only the card rail changed.

**The page.** `/pay/invoice/:id?t=<paymentToken>` — public, token-gated, mobile-first. Served by `server/pay.html` + `/crm/pay.js` + `/crm/pay.css`. It is where the portal's "Pay this invoice" button deep-links (same tab, PJL-hosted). Almost all traffic is iPhone Safari opening an SMS link.

**Card-data path.** Card number, expiry and CVC are entered into **Stripe's Payment Element** — an iframe served from `js.stripe.com`, mounted into the PJL-branded page — and the browser confirms the payment directly with `api.stripe.com`. PAN, CVC and expiry never exist in the page's DOM and never touch the Node process; the server only ever handles PaymentIntent ids (`pi_…`). That is PCI **SAQ-A-EP**, and it is Hard Rule 23: routing card data through PJL's server would push the integration into SAQ-D. Stripe.js MUST load from `js.stripe.com` (Stripe's terms prohibit self-hosting); it and reCAPTCHA are the only external scripts on the page. When Stripe.js can't load (blocker, network), the page degrades to the e-Transfer + phone path with an explicit message — never a dead Pay button.

**Charge flow (deferred-intent pattern).** Pay click → `elements.submit()` (Element validates the card, including Amex 15-digit PAN / 4-digit CID) → reCAPTCHA → `POST /payment-intent` (server creates or reuses the intent; **the amount always comes from the invoice server-side**, never from the browser) → `stripe.confirmPayment` (browser ↔ Stripe; the money moves HERE, exactly once) → `POST /charge` with the intent id → server **re-reads the intent from Stripe** and finalizes. **Payment methods are an explicit list — `["card"]` — set in BOTH `stripe.js` (`payment_method_types` on the intent) and `pay.js` (`paymentMethodTypes` on the Element), which must stay in sync.** Not `automatic_payment_methods`: the first live intent proved automatic pulls in whatever the Stripe account has enabled, which included Klarna — a BNPL redirect flow nobody chose to offer, whose redirect return path bypasses the confirm POST. Link was offered briefly and removed at Patrick's request (its "save my information" block dominated the mobile form). Card carries Apple Pay / Google Pay — the Element declares `wallets: { applePay: "auto", googlePay: "auto" }` explicitly, and they render **only after the domain's wallet verification passes** in Stripe → Settings → Payment method domains (the server relays Apple's verification file at `/.well-known/apple-developer-merchantid-domain-association`, cached daily from stripe.com). **Register BOTH `pjllandservices.com` AND `www.pjllandservices.com`** — Stripe treats them as separate domains, and this exact miss is why Apple Pay silently didn't render at launch (Jul 2026): apex was registered, the page was being viewed on www, no error anywhere. Any future subdomain that serves the Element needs its own registration too. Offering a new method later is a deliberate two-file change plus a thanks-page verification pass. The browser's claim of success is never trusted: `finalizeStripeInvoicePayment` verifies `metadata.invoiceId`, `status === "succeeded"`, amount, and currency against the invoice before flipping paid — a succeeded intent for the *wrong amount* refuses the flip and demands manual reconciliation. The `payment_intent.succeeded` webhook runs the same finalizer as a backstop for customers who close Safari before the confirm POST lands; the finalizer is idempotent, so double delivery is safe and can't double-send receipts.

**Billing address / AVS.** The form is deliberately minimal (Patrick's call, Jul 2026): the Element natively collects the billing postal code + country Stripe requires for a card — postal pre-filled from the invoice's `billTo.address` snapshot via `defaultValues` (`format.parseCanadianAddress` still derives `billingPrefill` server-side) — and nothing else. The QuickBooks-era custom fields (cardholder name, billing street address, postal) are **gone**: Stripe's rail runs postal-only address verification by default, and the first live charge (an Amex) passed full AVS. Stripe still reports `checks.address_line1_check` / `address_postal_code_check` / `cvc_check` per charge, recorded on every attempt. **If Amex or AVS declines resurface, re-add full address collection with `fields.billingDetails.address: "full"` on the Element — one line in `pay.js` — rather than rebuilding custom inputs.**

**Endpoints.**

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/pay/invoice/:id?t=<paymentToken>` | paymentToken | Sanitized invoice JSON + `billingPrefill: { streetAddress, postalCode }`. |
| `GET /api/pay/invoice/:id/sdk-config?t=<paymentToken>` | paymentToken | `stripePublishableKey`, `liveMode`, `amountCents`, `currency`, `recaptchaSiteKey`, `supportPhone`, `acceptedCardBrands` from settings. 503 if Stripe isn't configured or the keys are mode-mismatched (one live, one test) — that misconfiguration fails HERE, before a customer types anything. |
| `POST /api/pay/invoice/:id/payment-intent` | paymentToken + reCAPTCHA v3 | Creates/reuses the PaymentIntent (idempotency key `pjl-<invoiceId>-<amountCents>`; open intent persisted on the invoice and reused while the amount matches; cancelled + re-minted if the amount changed; a stray already-succeeded intent triggers finalize instead of minting a duplicate). |
| `POST /api/pay/invoice/:id/charge` | paymentToken | Verifies the confirmed intent against Stripe and finalizes (attempt record → QBO Payment → paid flip → deposit hook → receipt). Does **not** charge. |
| `POST /api/pay/invoice/:id/payment-failed` | paymentToken | Browser reports a declined intent id; server pulls the **verified** `last_payment_error` from Stripe and appends the failure attempt (deduped per intent+code). Closes the visibility gap left by declines happening browser-side. |
| `POST /api/webhooks/stripe` | Stripe signature | `payment_intent.succeeded` → backstop finalize; `payment_intent.payment_failed` → backstop attempt record. Signature (`t`/`v1` HMAC-SHA256 over the RAW body, 5-min replay window) verified by `stripe.verifyWebhookSignature`; refuses to run with no `STRIPE_WEBHOOK_SECRET`. Returns 200 even for handled-but-refused outcomes so Stripe doesn't retry permanent conditions. |
| `POST /api/webhooks/quickbooks-payments` | Intuit | **Legacy** — retained for any in-flight Intuit events; no longer part of the charge path. |
| `PATCH /api/settings/payments` | admin session | `{ acceptedCardBrands: ["visa","mastercard","amex","discover"] }`. |

**Invoice fields this surface reads and writes.**

| Field | Meaning |
|---|---|
| `stripePaymentIntentId` | Open (or settled) PaymentIntent for this invoice. Persisted at intent creation for reuse + verification. |
| `stripeChargeId` | Stripe charge (`ch_…`) from the successful payment. |
| `quickbooksInvoiceId` | QBO invoice ID from the accounting push. Absent ⇒ payment still completes but no QBO Payment is recorded (known AR-drift risk, own brief). |
| `quickbooksPaymentId` | QBO Payment record ID, best-effort after the Stripe charge. |
| `quickbooksChargeId` | **Legacy** — Intuit charge ID on invoices paid before the migration. Not written anymore. |
| `paymentToken` / `portalToken` | Independent 32-char hex tokens gating the pay page / the read-only portal mirror. |
| `paymentAttempts[]` | Append-only log of every charge attempt (below). |

**`paymentAttempts[]`** (`invoices.appendPaymentAttempt`, Hard Rule 4). One entry per attempt, **success and failure alike**. Fields: `ts`, `outcome`, `processor` (`stripe` | `quickbooks`; records from before the migration used Intuit-named columns `intuitCode`/`intuitMessage`/`intuitTid` and hydrate verbatim — read a missing `processor` as `quickbooks`), `amount`, `currency`, `chargeId`, `chargeStatus`, `httpStatus`, `paymentIntentId`, `errorCode` (Stripe `card_declined` / Intuit `PMT-2002`), `declineCode` (Stripe's issuer-level reason — `insufficient_funds`, `incorrect_zip`; the AVS signature), `errorMessage` (verbatim gateway string — for Patrick, never the customer), `processorRef` (Stripe `req_…` / `intuit_tid` — quote this to processor support), `customerMessage` (the exact words the customer read), `cardBrand`, `cardLast4`, `avsStreet`, `avsZip`, `cvcMatch`. Mirrors into `history[]` as `payment_attempt:success|failure`. The field list is an explicit allowlist — the structural guarantee that no PAN, CVC, expiry or secret can be persisted even by mistake; `update()`'s allowlist excludes `paymentAttempts`.

**Failure mapping.** `describeChargeFailure()` in `server.js` accepts both processors' failure shapes and maps to one kinds table: address/AVS (`incorrect_zip`, Intuit `PMT-2002`…), security code, card number, card type not accepted, declined, expired, bank-auth failed, temporary, unknown fallback. **No raw gateway string ever reaches the customer**; every message carries the office number from `settings.contactInfo.customerSupportPhone`. Unmapped codes land verbatim in `paymentAttempts[]`, which is how the table grows from real data.

**Accepted card brands.** `settings.payments.acceptedCardBrands`, edited via `PATCH /api/settings/payments`, displayed on the page. Display only — the Stripe account is the authority on what charges. Stripe accepts Amex by default (much of why the migration happened), so the default full list is accurate unless the Stripe account is configured otherwise.

**No retry, anywhere.** A capture is not idempotent (Hard Rule 22). The capture happens exactly once, browser-side, at `confirmPayment`; nothing server-side charges or re-confirms. The `Idempotency-Key` on intent *creation* dedupes double-taps into one intent — it protects creation, not capture.

**Test mode.** `sk_test_`/`pk_test_` keys work end-to-end against Stripe's test cards; the page shows a "Test mode" banner whenever the publishable key is a test key, so a test link can never pass for a real bill. A live/test key mismatch is detected at `sdk-config` and disables the form.

**History.** Until Jul 2026 this surface charged through QuickBooks Payments (browser tokenized directly against `api.intuit.com`, server charged via `/quickbooks/v4/payments/charges` — see `quickbooks.chargeCard`, retained but no longer routed to). The AVS work (billing street address, postal normalization, attempt log, failure mapping) was built on that rail days before the migration and carried over intact — it is processor-agnostic. The predecessor diagnostic brief cited invoice fields `qbInvoiceId`/`lastPushAt`/`lastPushStatus`/`qbSyncToken`; **no such fields exist.**

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
STRIPE_SECRET_KEY     = sk_live_… (server-side; enables card payment on
                                   /pay/invoice. sk_test_ for test mode.)
STRIPE_PUBLISHABLE_KEY = pk_live_… (shipped to the browser via /sdk-config.
                                   MUST match the secret key's mode — a
                                   live/test mismatch disables the form
                                   with a loud log line.)
STRIPE_WEBHOOK_SECRET = whsec_…   (signing secret for /api/webhooks/stripe.
                                   Create the endpoint in the Stripe
                                   dashboard → Webhooks, events:
                                   payment_intent.succeeded,
                                   payment_intent.payment_failed. Without
                                   it, webhook delivery is REFUSED — the
                                   paid-flip then relies solely on the
                                   customer's confirm POST.)
STRIPE_API_VERSION    = (optional pin, e.g. 2025-06-30.basil; unset =
                                   account default)
RECAPTCHA_SITE_KEY    = (optional — reCAPTCHA v3 on the pay page)
RECAPTCHA_SECRET_KEY  = (optional — server-side verify; unset skips)
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
- **Site-plan scale (Site Plan Underlay brief, Aug 2026):** three rules,
  and they are correctness requirements, not preferences. **(1)** No
  tracing on an uncalibrated sheet — a hard gate, never a warning.
  **(2)** Calibration must be verified against a *second, independent*
  known dimension before the sheet is usable; one control measurement is
  not a measurement. **(3)** A number a bid depends on is never silently
  changed — recalibrating a sheet that traced areas already reference is
  refused, naming them. Thresholds and rationale in **Site plan
  calibration** below.
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
- **A capture is not idempotent** (design spec Hard Rule 22). Cascades,
  QB pushes and recovery sweeps can all be safely re-run; a card charge
  cannot. No automatic retry may be added anywhere in the charge path.
  Since the Stripe migration the capture happens exactly once,
  browser-side, at `confirmPayment` — nothing server-side charges,
  retries, or re-confirms. A failed attempt records to
  `invoice.paymentAttempts[]` and stops; the customer re-submits
  deliberately. (The paid-flip *finalizer* is idempotent — that is
  bookkeeping, not a capture.)
- **Card data never touches the server** (design spec Hard Rule 23).
  PAN, CVC and expiry live inside Stripe's Payment Element iframe and go
  straight to `api.stripe.com` (previously: direct tokenization against
  `api.intuit.com`); PJL's Node process only ever sees opaque
  PaymentIntent ids. This is what keeps the integration in PCI SAQ-A-EP
  rather than SAQ-D. Billing ADDRESS fields are not card data and are
  safe server-side — collecting them is how the charge passes AVS.

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

`sitebuilder` (`/admin/sitebuilder`) was **added to the audited set in Aug
2026** with the site-plan underlay work — it had never been captured before,
in line with the Sprinkler System Builder being absent from this document
entirely until the same change.

Run before merging any layout-touching change. Re-run after the merge to
verify the fix and catch regressions. Prior captures are cleared at the
start of every run so the folder always reflects the latest state.
Playwright is `devDependencies` only — it does not ship to production.

### Build gate (`npm run build:check`)

Chains the static-content checks (`build.js --check`, meta-price sync,
sitemap, the hardcoded-price and QB-mapping linters) with the integration
suites: `test-pricing`, `test-proposal-unlock`, `test-proposal-html`,
`test-commercial-schema`, `test-stripe`, `test-invoice-balance-surfaces`,
`test-wo-completedat`, `test-wo-unlock`, `test-mailer-log`, and
**`test-siteplan-calibration`** (Aug 2026 — calibration math, residual
bands, the factor-of-two catch, `version: 2` backward compatibility, the
vertex/payload budget, and path-traversal rejection). Each suite copies the
libs it exercises into a temp directory, so a build gate can never read or
write real data.

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
| `spp_xxxxxxxx` | Site-plan page inside `project.sitePlan.pages[]` (Site Plan Underlay brief, Aug 2026). Minted server-side as `"spp_" + random8()` — lowercase base36, 8 chars. **Validated against `/^spp_[a-z0-9]{8}$/` BEFORE any `path.join`**, because it arrives as a request path segment and names a file on disk. | `spp_a1b2c3d4` (random) |
| `con_xxxxxxxx` | Commercial contact — in `customer.commercial.contacts[]` (org-wide) **or** `property.siteContacts[]` (one site). Minted by `billing-parties.coerceContactId` (8 random hex chars) so both lists share one format; a well-formed incoming id is preserved, so an admin edit never changes a contact's identity. Both admin editors round-trip it through a `data-cid` attribute — **dropping that attribute would re-mint every id on every save.** Legacy contacts written before ids existed are backfilled once on read by `customers.readAll()` / `properties.readAll()`. | `con_a1b2c3d4` (random) |
| `sec_xxxxxxxx` | Proposal section inside a project_proposal quote (Brief 1). Sections may now be user-created with `kind:"custom"` (Brief C1); the `sec_` id is minted server-side by `newSectionId()` — no client-side generator. Each section carries `include` (default true); `include:false` hides it from the PDF while keeping it on the record + editor (Brief D) — this **supersedes** the legacy "leave the body blank to hide it" behaviour. | `sec_x8WqLP3a` (random) |
| `pdfOptions` | Per-quote PROPOSAL PDF display object (Brief D, 2026-07): `{ lineItems: "itemized"\|"descriptions_only"\|"summary", showAttachments, showProjectMap }`. **Presentation only** — never affects pricing math, the accepted amount, the QuickBooks push, or the invoice; the total is always shown (no `showTotals`). Draft-editable, frozen at send with the PDF bytes. | `{ lineItems: "summary", showAttachments: false, showProjectMap: true }` |
| `deliveryMode` | Per-`project_proposal` customer-facing OUTPUT channel (residential_repair brief, 2026-07): `proposal_page` (designed, phone-gated page) or `plain_pdf` (plain branded PDF, emailed, accepted at /approve, **no** page, **no** phone gate). Derived from branch at creation — `plain_pdf` for `residential_repair`, `proposal_page` otherwise — draft-editable, scope-protected (frozen at send). Under `plain_pdf` the proposal-page/document/hero endpoints 409 `delivery_mode_forbids_proposal_page`. Null for `ai_repair_quote`/`on_site_quote`. | `"plain_pdf"` |
| **Delivery mode** (concept) | *Plain PDF vs proposal page.* Repair estimates (`residential_repair`) use the former: a homeowner should not have to type a phone number into an encrypted HTML document to read a $2,000 estimate. The designed, phone-gated page stays for install/lighting pitches. | see `deliveryMode` |
| **Phone gate** (concept) | The phone-number challenge protecting a proposal's designed HTML document. Engaged by the document file's PRESENCE, only on branches that use `proposal_page` delivery. It does **not** apply to `plain_pdf` repair estimates, nor to `on_site_quote`/`ai_repair_quote`. | — |
| `task_xxxxxxxx` | Project task seeded from a proposal line item (Brief 1) | `task_aB3cD9eF` (random) |
| `sess_xxxxxxxx` | WO session (clock-in/out) on a build-mode WO (Brief 2) | `sess_9Pq3aLn4` (random) |
| `scr_xxxxxxxx` | Scope-change request on a Project (Brief 2) | `scr_Vk2mZpQ8` (random) |
| `su_xxxxxxxx` | Status-update entry sent to a stakeholder (Brief 2) | `su_3aZ7Lp2M` (random) |

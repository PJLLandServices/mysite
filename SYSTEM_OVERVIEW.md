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
| `properties.js` | Property | `P-YYYY-NNNN` | Customer site profile (zones, valves, controller, blow-out, deferred issues, service records). One per physical address. Zones land with `pendingReview: true` when the WO completion cascade discovers them on-site (Brief D). |
| `work-orders.js` | Work Order | `WO-XXXXXXXX` (random alphabet) | One per visit. Zones, issues, photos, signature, on-site quote, materials packed, `paidOnSite`, `propertyEditsAppliedAt`, `intakeGuarantee.matched`, `history[]`. Lock-protected fields enforced via `SCOPE_PROTECTED_FIELDS` constant (Brief A). |
| `quotes.js` | Quote | `Q-YYYY-NNNN` | Versioned, signed estimate. Two flavours: `ai_repair_quote` (AI chat) and `on_site_quote` (tech-built). |
| `invoices.js` | Invoice | `I-YYYY-NNNN` | Auto-drafted by completion cascade, lifecycle draft → sent → paid → void. |
| `bookings.js` | Booking | `BK-YYYY-NNNN` | First-class appointment record. Mirrors `lead.booking` but is canonical. |
| `projects.js` | Project | `PROJ-YYYY-NNNN` | Multi-WO container for named jobs. Lifecycle planning → active → complete → archived. |
| `material-lists.js` | Material List | `ML-YYYY-NNNN` | Bill of materials. Line items reference parts.json SKUs + quantities + status (`need` / `ordered` / `have`). Attachable to a project / WO / quote / standalone. |
| `purchase-orders.js` | Purchase Order | `PO-YYYY-NNNN` | One supplier's slice of a material list's `need` lines. Lifecycle draft → sent → partially_received → received → cancelled. |
| `suppliers.js` | Supplier | `SUP-NNN` (no year prefix) | Vendor records (name, contact, email, phone, address). |
| `part-suppliers.js` | — | n/a | Override map at `data/part-suppliers.json` mapping SKU → supplierIds[]. parts.json's `supplierIds` field is a placeholder; this file is the source of truth. |
| `settings.js` | — | n/a | Admin notification preferences + 50-entry audit trail. |
| `completion-cascade.js` | — | n/a | Fires on WO status → completed. Idempotent. Creates service record on property, draft invoice (with `paidOnSiteAtCompletion` flag), customer + admin emails, warranty stamp. Applies property edits via `computePropertyEdits()` (Brief D — zone/controller diffs, new zones flagged for Patrick review) gated by `wo.propertyEditsAppliedAt`. Logs `cascade_fire` + `property_edits_applied` history entries. |
| `issue-rollup.js` | — | n/a | Maps zone issues into priced line items for the on-site quote. Manifold rule, controller subtype tier selection, etc. |
| `pricing.js` | — | n/a | `priceForBooking(serviceKey, zoneCount)` reads `pricing.json`. |
| `availability.js` | — | n/a | Slot generator + `BOOKABLE_SERVICES` catalog. |
| `schedule-store.js` | — | n/a | Calendar blocks + per-day hour overrides. |
| `geocode.js` | — | n/a | Google Geocoding wrapper + cache. |
| `distance.js` | — | n/a | Distance Matrix + Haversine fallback. |
| `quote-pdf.js` | — | n/a | Branded quote PDF (pdfkit). |
| `po-pdf.js` | — | n/a | Branded purchase order PDF (pdfkit). |
| `notify-email.js` | — | n/a | Admin email on new lead (Gmail SMTP). |
| `notify-sms.js` | — | n/a | Admin SMS on new lead (Twilio). |
| `notify-customer.js` | — | n/a | Customer-facing transition emails / SMSes (booking confirmed, on the way, etc). |
| `notify-supplier.js` | — | n/a | Supplier email with PO PDF attachment. |
| `quickbooks.js` | — | n/a | OAuth + invoice push. **Inert** until `QB_CLIENT_ID` / `QB_CLIENT_SECRET` env vars are set. |
| `booking-sessions.js` | — | n/a | AI handoff session storage (used by the chat widget). |

## Server-side data files (`server/data/`)

All gitignored. Live on Render's persistent disk. Hand-editing breaks
audit trails; modify only via the API.

```
auth.json                  ← scrypt password hash + session secret (set via npm run setup-password)
leads.json                 ← inbound leads (the CRM core)
properties.json            ← customer site profiles
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
quickbooks.json            ← QB OAuth tokens (gitignored, Render-only)
photos/<leadId>/<n>.jpg    ← lead intake photos
wo-photos/<woId>/<n>.<ext> ← work-order photos (pre/in/post-work + per-issue)
```

## Admin / portal pages (`server/`)

Each admin page is one HTML + one JS + (sometimes) one CSS file. The
sidebar is duplicated in every page's HTML and synchronized by hand
when entries change. Standard sidebar order (12 items):

```
Today  ·  CRM  ·  Schedule  ·  Handoff  ·  Properties  ·  Projects  ·
Work orders  ·  Quotes  ·  Invoices  ·  Materials  ·  AI Chats  ·  Settings
```

Pages with their primary route + purpose:

| Page | Route | What it does |
|---|---|---|
| `today.html` | `/admin/today` | Tech morning hub — today's confirmed bookings with navigate + notify + open-WO actions per row. |
| `admin.html` | `/admin` | Lead pipeline / CRM dashboard. Search, filter by stage, open lead detail card. Inline quote display + property link conflict detection. |
| `schedule.html` | `/admin/schedule` | Booking calendar. Block hours, manual booking creation. |
| `handoff.html` | `/admin/handoff` | Manual handoff — admin sends a customer a booking link + portal access. |
| `properties.html` | `/admin/properties` | Properties index (vertical list). |
| `property.html` | `/admin/property/<id>` | Per-property profile. Zones, valves, controller, blow-out, access notes, service records, deferred issues. |
| `properties-import.html` | `/admin/properties/import` | xlsx bulk import wizard. |
| `projects.html` | `/admin/projects` | Projects index. |
| `project.html` | `/admin/project/<id>` | Project detail. Editable header, attached WOs, attached material lists, status select. |
| `work-orders.html` | `/admin/work-orders` | All-WOs index. Status filter (default: active only), search, "Show completed + cancelled" toggle. |
| `work-order.html` | `/admin/work-order/<id>` | Desktop WO editor. Cheat sheet, AI bonus banner + decision buttons, zones, issues, photos, line-items + running totals + send-for-approval (Brief B), customer sign-off (gated on bonus decision), post-signature banner + Mark Complete CTA (Brief E), paid-on-site radio (Brief C), cascade-recovery actions, history viewer (Brief A). |
| `work-order-tech.html` | `/admin/work-order/<id>/tech` | Mobile-first tech mode. ServiceWorker-backed offline. Cheat sheet, carry-forward banner, AI bonus card with Match / Didn't Match buttons (Brief F), zone bottom-sheet edit, voice-input, on-site quote builder, customer review + signature canvas, materials checklist on follow-ups, payment-on-site radio, property-updates preview (Brief D), post-signature narrative banner (Brief E), history viewer (Brief A). |
| `quote-folder.html` | `/admin/quote-folder` | Quote index. Auto-expire sweep, PDF download, "Convert to project" per row. |
| `invoices.html` | `/admin/invoices` | Invoice index. |
| `invoice.html` | `/admin/invoice/<id>` | Invoice editor. Two-column layout (invoice document left, sticky admin actions right). |
| `material-lists.html` | `/admin/material-lists` | Material list index with parent + status filters. |
| `material-list.html` | `/admin/material-list/<id>` | Mobile-first builder. Search/browse catalog, qty steppers, parent picker, copy-from-past, sticky savebar with running totals, "Generate purchase orders" button. |
| `suppliers.html` | `/admin/suppliers` | Supplier records. |
| `parts-suppliers.html` | `/admin/parts-suppliers` | Bulk catalog assignment grid (SKU → primary supplier). |
| `purchase-orders.html` | `/admin/purchase-orders` | PO index. Status filter + "Show closed" toggle. |
| `purchase-order.html` | `/admin/purchase-order/<id>` | PO detail. Send modal (email + PDF), partial-receive modal, reorder, cancel. |
| `chats.html` | `/admin/chats` | AI chat transcripts (booked + abandoned). |
| `settings.html` | `/admin/settings` | Notification defaults, audit trail, QB connect, exports. |
| `login.html` | `/login` | Single password, scrypt-hashed in `auth.json`. |
| `portal.html` | `/portal/<token>` | Customer-facing read-only portal: project request, deferred recommendations, signed quotes, scheduled appointments, notification prefs. |
| `approve.html` | `/approve/<id>?t=<token>` | Customer-facing on-site quote approval (signature canvas + PDF download). |

## Shared admin components (`server/`)

| File | Purpose |
|---|---|
| `crm.css` | Sidebar + topbar shell + buttons. The visual frame. |
| `crm-nav.js` | Hamburger toggle + logout button wiring. |
| `crm-parts.js` / `crm-parts.css` | Shared parts catalog renderer (category > subcategory > items checkbox tree). Used by WO materials checklist + follow-up modal. |
| `crm-followup.js` / `crm-followup.css` | Follow-up WO trigger modal (slot picker + materials selector). |
| `crm-reschedule.js` / `crm-reschedule.css` | Reschedule appointment modal. |
| `voice-input.js` | Web Speech API helper. Any field with `data-voice-input` attribute gets a mic button. |
| `tech-sw.js` | ServiceWorker scoped to `/admin/work-order/`. Caches HTML/JS/CSS/pricing.json/parts.json. Network-first WO/property GETs with cache fallback. |
| `offline-queue.js` | IndexedDB outbound queue. Synthesizes 202 on offline, replays FIFO on reconnect, auto-reloads after drain. |
| `wo-materials.js` | Standalone embed for the WO desktop editor — lists material lists attached to that WO, "+ New material list" button. |

## API surface (high level)

All routes admin-gated unless noted. Auth via session cookie set by
`POST /api/login`. Public endpoints: `/api/quotes` (POST lead intake),
`/api/booking`, `/api/portal/<token>`, `/api/approve/:id/:token`.

```
Authentication
  POST   /api/login                              { password }
  POST   /api/logout
  GET    /api/session

Leads / CRM
  POST   /api/quotes                             ← public lead intake
  GET    /api/quotes                             ← admin list
  GET    /api/quotes.csv                         ← export
  GET    /api/contacts.vcf                       ← vCard export
  PATCH  /api/quotes/:id                         ← stage change, notes
  POST   /api/quotes/:id/convert-to-project      ← spawn project, re-parent attached lists

Properties
  GET    /api/properties
  GET    /api/properties/:id
  PATCH  /api/properties/:id                     ← system, zones, deferred issues
  POST   /api/admin/import-properties            ← bulk xlsx upsert

Bookings + scheduling
  POST   /api/booking                            ← public booking submit
  GET    /api/bookings, /api/bookings/:id
  PATCH  /api/bookings/:id
  GET    /api/schedule/...                       ← slots, blocks, hour overrides

Work Orders
  GET    /api/work-orders                                           ← list (filter ?propertyId, ?leadId)
  GET    /api/work-orders/:id                                       ← decorated with property + lead + lastService + propertyEdits preview
  POST   /api/work-orders                                           ← create from lead/property/booking; seeds seasonal-fee baseline line
  PATCH  /api/work-orders/:id                                       ← zones, issues, signature, status, photos, paidOnSite, etc.
                                                                       Returns 409 wo_locked when payload touches SCOPE_PROTECTED_FIELDS
                                                                       on a signed WO (lineItems, signature, customer/property/booking
                                                                       links, intakeGuarantee, type, etc.). Status forward-progression,
                                                                       photos, materials, paidOnSite, notes still accepted.
  DELETE /api/work-orders/:id                                       ← refuses if active deferred items still reference this WO
  POST   /api/work-orders/:id/photos                                ← upload (categories: pre_work / in_progress / post_work / issue / general)
  DELETE /api/work-orders/:id/photos/:n
  GET    /api/work-orders/:id/photo/:n                              ← serve a single photo file
  POST   /api/work-orders/:id/create-invoice                        ← manual invoice draft (idempotent — short-circuits on existing)
  POST   /api/work-orders/:id/run-cascade                           ← re-run cascade explicitly (idempotent)
  POST   /api/work-orders/:id/follow-up                             ← spawn follow-up WO with parent's parts pre-loaded
  POST   /api/work-orders/:id/intake-guarantee/decide               ← AI Correct Diagnosis Bonus decision (Brief F).
                                                                       Body: { matched: bool, mismatchReason?: string }.
                                                                       On match: appends -1hr labour credit to builder.
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
  PATCH  /api/settings
  GET    /api/pricing                            ← public pricing.json read
  GET    /api/chat-transcripts                   ← admin
  POST   /api/chat-transcripts                   ← public widget upserts
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
Admin reviews PO detail, clicks Send  →  PDF rendered + emailed to supplier;
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

## External integrations

| Service | Purpose | Trigger | Required env vars |
|---|---|---|---|
| **Gmail SMTP** | Lead notification email, customer transition emails, supplier PO emails | New lead, status changes, PO send | `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
| **Twilio** | Admin SMS on new lead | New lead intake | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `NOTIFY_TO_PHONE` |
| **Google Maps JS API** | Places Autocomplete on every editable address input + Distance Matrix on the public coverage checker | Form interaction | API key hardcoded in HTML script tags (browser key) |
| **Google Geocoding** | Property coordinates + drive-time analysis (admin only) | Property creation, today schedule | `GOOGLE_MAPS_SERVER_KEY` |
| **QuickBooks Online** | Push invoices to QB. **Inert** until creds set. | Manual trigger from `/admin/settings` | `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, optional `QB_ENVIRONMENT` |

## Configuration (Render env vars)

```
TZ                    = America/Toronto                    (forced by server.js)
PORT                  = 4173                                (Render injects)
HOST                  = 0.0.0.0                             (Render scanner needs this)
PUBLIC_BASE_URL       = https://pjllandservices.com         (post-DNS-cutover)
GMAIL_USER            = info@pjllandservices.com or similar
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

## How to run locally

```bash
git clone https://github.com/PJLLandServices/mysite
cd mysite
npm install
npm run setup-password          # creates server/data/auth.json
npm start                        # http://127.0.0.1:4173
```

`npm run build` rebuilds the public-site partials, syncs prices into
HTML, and rebuilds the AI worker prompt. `npm run build:check` exits
non-zero if anything's out of sync — useful as a pre-push gate.

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
| `li_xxxxxxxx` | Material list line | `li_VbjXaKHH` (random) |
| `poli_xxxxxxxx` | Purchase order line | `poli_QU1cN3Jz` (random) |
| `iss_xxxxxxxx_<ts>` | Zone issue inside a WO | `iss_a1b2c3_1730000000` |

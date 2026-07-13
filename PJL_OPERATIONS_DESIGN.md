# PJL Land Services — Operations System Spec

**Version:** 1.0 (Whiteboard phase complete)
**Last updated:** May 1, 2026
**Author:** Patrick Land + Claude (whiteboard collaboration)
**Purpose:** Single source of truth for the architecture of PJL's operations system. This document is the spec — every future feature must fit into this design, not bolt onto the side of it.

---

## 0. Read this first

This is **not a CRM**. PJL is a field service business — sprinkler installation, repair, and seasonal services across the GTA. The system that runs PJL is therefore a small **field service platform**: customer management + property management + quoting + booking + work orders + service history + customer portal, glued together by the AI chat on the front end and QuickBooks on the back end.

The whole point of this document is to fix one specific failure mode: **adding new features without integrating them, so each new thing sits next to the old things instead of working with them.** Every rule in this spec exists to prevent that.

The two foundational principles:

1. **One source of truth for every fact.** When the same fact lives in two places, those places will eventually disagree. Pricing lives in `pricing.json`. Parts in `parts.json`. Customer info in the customer folder. Property info in the property folder. No duplication, ever.

2. **Every transaction has a defined slot.** Lead → Quote → Booking → Work Order → Service Record → Invoice. Each box has a defined input and output. New features go inside boxes, not between them.

If a future change can't fit cleanly into this design, the design is wrong and gets revised. Bolting is forbidden.

---

## 1. Reference Data (the foundation)

These files are the single source of truth for all reference data. Edited in one place. Read by everything else.

### 1.1 `pricing.json`

The complete price list. Feeds:
- The public pricing page (`pricing.html` renders from this)
- The AI system prompt (pricing is injected at runtime, not hardcoded in the prompt)
- Quote line items (snapshotted at quote creation)
- Work order materials calculations

**Hard rules:**
- The AI is forbidden from inventing prices. If something isn't in `pricing.json`, the AI says "that's a custom quote" and captures a lead.
- Quote line items snapshot the price at creation time. Future price changes never alter accepted quotes.
- HST (13%) is always added at the end. Never quote tax-inclusive.
- Prices are never rounded ($74.95 stays $74.95). Customers notice rounding and trust drops.

**Known drift to fix at first build:** Spring opening / fall closing ≤4 zones is currently $90 on the website but $85 in the AI system prompt. Reconcile to one number when migrating.

### 1.2 `parts.json`

The parts catalog (~110 SKUs) plus `service_materials` mapping each priced service to its default packing list.

Structure:
- **`parts`** — the catalog. Keyed by SKU. Includes name, category, subcategory, size, price, and **`manufacturer`** (a `manufacturers[].key`, or `""` when unknown).
- **`manufacturers`** — top-level controlled vocabulary of brands (`[{key,label}]`, e.g. Hunter, Rain Bird, Netafim, Blu-Lock, Oil Creek, Dawn, Watts), mirroring `categories`. **Manufacturer is an intrinsic catalog attribute** (a Hunter valve is made by Hunter regardless of who sells it), so it lives in `parts.json` — unlike **supplier**, which is a changing *relationship* kept in the `part-suppliers.json` override map. `/admin/parts-suppliers` shows a read-only Manufacturer column + filter (Brief B1).
- **`service_materials`** — keyed by service ID matching `pricing.json`. Each entry has `default_parts: [{sku, quantity, note?}]`.

**Hard rules:**
- Empty `default_parts` array = "service has no default packing list, tech adds materials on-site." Valid.
- Tech can edit the materials checklist on-site.
- Future hook: per-part `unit_of_use` and `units_per_purchase` for cost tracking. Decision deferred.

**Two pricing models — don't conflate them.** A **material list is a live purchasing estimate**: each line's price resolves from the *current* `parts.json` until the line is actually purchased, so editing a part's price updates every open list line that hasn't been ordered yet. The **price-lock point is the Purchase Order** — when a line's PO is *sent*, that line freezes to the PO's snapshotted price (and a cancelled PO releases it back to live). This is deliberately different from **quotes and invoices, which snapshot the price at line-add time** (an accepted quote never changes). Material lists snapshot late (at the PO) because no customer has agreed to anything yet; quotes/invoices snapshot early because the customer has. Don't "fix" a material list to snapshot at add time — that freezes prices the buyer hasn't committed to.

**Line descriptions — stored value wins over the catalog.** A PO line (and, in principle, a material-list line) may carry its own typed `description` — e.g. an **off-catalog / manually-entered line** whose `sku` isn't in `parts.json`. Every description surface resolves text in one order via the shared `resolveLineDescription(line, catalog)` helper (`server/lib/format.js`): **stored line `description` → catalog description by SKU → `(SKU <sku>)` placeholder**. So a typed description always shows verbatim; the catalog lookup is only a fallback for catalogued lines saved without one; the placeholder is the last resort. PO generation snapshots the catalog description onto each line at create time, and the resolver returns the description **only** (it must never prefix the part `size`). The same resolver feeds the PDF, CSV, supplier email, and the on-screen PO detail table from one merged catalog, so the four never disagree.

**RFQ vs PO — ask vs commit.** A **Request for Quotation (`RFQ-YYYY-NNNN`)** is the "ask for a price" counterpart to the Purchase Order's "commit to buy at a known price." It launches from a material list ("Request quotation," beside "Generate purchase orders"), groups `need` lines by supplier exactly like PO generation — but **it never changes material-list line status** (lines stay `need`; nothing is on order) and its documents carry **no prices at all** (the PDF has an empty write-on Quoted Unit Price column; the CSV and email have no price columns). Lifecycle: draft → sent → quoted → applied (+ cancelled). The payoff loop: the vendor replies with pricing → Patrick enters it on the RFQ detail page's quick-grid (dollars in; partial quotes fine — unpriced lines simply leave the catalog untouched) → **Review & apply** shows current catalog price → quoted price per SKU before any write → confirming applies them to the **parts catalog** through the same edit path as a manual catalog price edit (one batched audit entry) → the still-live material list reflects them immediately → "Generate purchase orders" snapshots the fresh, real prices. Applying is one-way: a second apply is refused (no silent double-apply), and an applied RFQ can't be cancelled — its prices are already the catalog's provenance. An RFQ never becomes a PO directly. Two guardrails: (1) **don't use a $0 PO as a quote request anymore** — that workaround (e.g. the old PO-2026-0004) is retired by this entity; (2) the apply step writes `parts.json` **supplier-cost** data via the existing catalog-edit path — it never touches `pricing.json` (customer-facing service pricing), so it is not a pricing-rule violation.

**SKU → supplier mapping lives in `part-suppliers.json`, not `parts.json`.** Each part's `supplierIds[]` is resolved at request time from the runtime override file `server/data/part-suppliers.json` (first entry = the **primary** supplier that "Generate purchase orders" groups need-lines by); `parts.json`'s own `supplierIds` field is a hand-curated placeholder that is **never** the runtime source. Primary-supplier reassignment is a **category-grouped batch operation** on `/admin/parts-suppliers`: tick individual SKUs, a whole category (tri-state "select all"), or everything shown, pick a target supplier, confirm, and one `PATCH /api/part-suppliers` rewrites every selected SKU's mapping. It's supplier-only (manufacturer is separate), idempotent (re-running is a no-op), and affects **future** PO generation only — it never rewrites an already-drafted or sent PO. Introduced for the Central→SiteOne purchasing switch.

**Status:** Catalog complete. ~50% of service mappings done. Repairs and controllers mapped. Seasonal services and new install zones intentionally left empty for a future pass. See "Open items" section below.

### 1.3 Settings (notification preferences)

Two layers:
- **Admin defaults** — Patrick's notification preferences (text, email, both, silent) per event type
- **Per-customer overrides** — for VIPs or quiet customers
- **Customer-side preferences** — each customer's own portal preferences (text reminders, email-only, no marketing texts, etc.)

### 1.4 Integrations

PJL runs lean on third-party services — only what materially helps operations:

- **Gmail SMTP** (admin alerts + customer-facing transactional emails). Disabled outputs are graceful no-ops.
- **Twilio SMS** (admin alerts + portal-message body inlined per Brief). Same graceful-skip behaviour.
- **Google Maps + Distance Matrix** (booking availability travel-time gating, address autocomplete on coverage check + book).
- **QuickBooks Online** (estimate + invoice push; per-line item refs + HST tax-code wiring shipped May 10).
- **iPhone Calendar (read-only, Brief C)** — token-gated `/calendar/<token>.ics` feed. Confirmed bookings only, -90d / +365d window, Toronto TZ. The URL itself is the credential (single 32-hex token in `settings.icalFeed`); regenerate invalidates leaked URLs in one click from `/admin/settings`. Subscriptions refresh roughly hourly per Apple's default. One-way only — edits on the iPhone don't write back.

---

## 2. Core Folders

### 2.1 Customer Folder (the person)

```
CUSTOMER FOLDER
  Personal Information
    - Full name
    - Significant Other's name (if requested)
    - Phone number
    - S/O phone (if necessary)
    - Email
    - S/O email (if necessary)
    - Billing name / company (if the invoice is issued to someone other
      than the contact — e.g. a numbered company, property manager, or
      family member; empty = bill to the contact)
    - Billing email (if the invoice goes to a different inbox)
    - Billing address (if different from any service address)
    - Customer since (date)
    - How did they find PJL Land Services
    - Status: lead / active / inactive / lost
    - QuickBooks Customer ID (link to QB)
    - Negotiated rates (admin-only): per-customer labour-rate override
      (e.g. $85/hr GreenTree fair-trade agreement). Snapshots onto a
      project_proposal quote's `customRates` at creation. Future-
      extensible to per-foot mainline, per-zone, etc.

  Communication Records
    - Date, time, source (email / phone / text / chat / in-person), what about, notes

  Internal Notes
    - Free-text notes about this customer

  Notification Preferences
    - Per-event overrides for both admin and customer streams

  >>> PROPERTY FOLDER(S) — one or more attached to this customer
```

**Why customer is separate from property:** A customer is a person. A property is a place. Most customers have one property. Some have a home and a cottage. Some sell a house and the new owner inherits the system documentation. Separating them now prevents painful untangling later.

**Billing party ≠ contact ≠ property (billing-party brief, Jun 2026):** the person who books the work, the place being serviced, and the entity that pays the invoice are three independent facts — investment-owned residential and property-management work make all three differ routinely (e.g. service at a Vaughan home, invoice issued to a Thornhill numbered company). The contact stays the Customer's `name/email/phone`; the bill-to lives in `billingName/billingEmail/billingAddress` (empty = bill the contact). At intake, `new-customer.html` captures a structured bill-to behind a collapsed "Bill to a different person or company" disclosure (`lead.billing`, persisted only when used) and seeds the Customer's billing fields — never overwriting hand-curated values. Each draft invoice snapshots the resolved bill-to (`invoice.billTo`, locked after send), and the QuickBooks push bills that entity. The self-billing majority path is untouched end to end.

**Implementation status (as of 2026-05-16):** The Customer Folder is live in v1 as `server/lib/customers.js` + `server/data/customers.json` with admin pages at `/admin/customers` and `/admin/customer/<id>`. Populated fields: name, spouseName, phone, spousePhone, email, spouseEmail, billingName, billingEmail, billingAddress, customerSince, source, status (`lead`/`active`/`inactive`/`lost`), quickbooksId, internalNotes, notificationPrefs, communicationRecords, vcfDownloads, history. The per-customer and bulk vCard download (`/api/customer/:id/vcard`, `POST /api/customers/vcards.vcf`) lets Patrick import customers into iPhone Contacts for Siri-based dialling from the truck; each download appends to vcfDownloads[] for audit. **Snapshots-vs-source-of-truth:** the Customer record is the source of truth for CURRENT contact info; transactional entities (WO / Quote / Invoice / Booking / Project) continue to snapshot name/email/phone at sign time and those snapshots are the source of truth for AS-OF-SIGNING info. Editing a Customer never back-rewrites historical snapshots.

### 2.2 Property Folder (the place)

```
PROPERTY FOLDER
  Property Information
    - Service address (Apple Maps format for one-tap calendar directions)
    - Spring opening cost / Fall closing cost for this property
        (per-property override; falls back to pricing.json tier by zone count
         via pricing.resolveSeasonalPrice)
    - Additional plumbing to blow out in fall? (yes/no)
        If yes: additional cost + short description (cabana, pool house,
        remote hose bib, etc.). Drives a second baseline line on
        fall_closing WOs AND attaches the fall_additional_plumbing
        disclaimer to the resulting invoice — text in
        server/lib/invoices.js INVOICE_DISCLAIMERS.
    - Number of zones
    - Access & logistics (gate code, dog warning, parking notes, scheduling preferences)

  System Overview
    - Controller location (+ photo)
    - Controller brand & model
    - Main shut-off location (+ photo)
    - Blow-out location (+ photo)
    - System notes (+ photo)

  Zones (one entry per zone)
    - Zone #
    - Zone location (+ photo)
    - Sprinkler type (multi-select: rotors / pop-ups / drip / flower pots)
    - Coverage type (multi-select: grass / plants / trees / shrubs)
    - Zone-specific notes

  Valve Boxes (one entry per box)
    - Location (+ photo)
    - How many zones in this box
    - Description

  Service Records (history of completed work at this property)
    - Date, service type, notes, link to work order

  Deferred Issues (open recommendations carried across visits)
    - See section 5

  Bookings (past and future, scheduled at this property)
```

**Best-time-to-reach** lives on the customer (it's about the person). Everything else here is about the place.

---

## 3. Doors (how info gets in)

Confirmed list of every input channel:

| Door | What it collects |
|---|---|
| AI chat (website) | Whatever customer shares mid-conversation |
| Booking form (`book.html`) | Full structured intake |
| Self-intake form (`new-customer.html` → `POST /api/new-customer`) | Contact + property address + notes, plus a structured **bill-to** behind a collapsed "Bill to a different person or company" disclosure (billing name/company + billing address required when used; billing email/phone optional). Lands as `lead.billing` and seeds the Customer's billing fields — no more re-keying a billing entity out of free-text notes. |
| Admin (Patrick) | Anything — full create/edit access |
| Customer portal | Limited edits: phone, email, best time to reach |
| Phone calls | Logged manually only when something significant happens |
| Twilio inbound texts | Low priority for now |
| Inbound emails (Gmail) | System replies prompting intake form (routes to Door #2) |

### 3.1 Matching Rules

When new info arrives, match before creating:

- **Customer match:** email first → phone second → otherwise new
- **Property match:** address
- **Conflict case:** known property + unknown customer → flag for Patrick's review (could be the new owner of an old customer's house). Do NOT auto-merge.

**Implementation:** wired into the public lead intake (`POST /api/quotes` → `resolveCustomerForLead`) and the property auto-link cascade (`properties.attachLead`). Match failure on a real intake is a soft-warn — the lead is still saved with `customerId=null` so a public-form submission never breaks if the customer lookup throws. `customers.findByIdentifier()` is the canonical entry point; bookings, magic-link auth, and the conflict detector all funnel through it.

### 3.2 "And then what" — cascades by door

**AI chat transcript:**
- If known customer: save in profile communication records
- If unknown: summarize and save
- If inquiry only: log the inquiry
- If unresolved: log as not-complete
- If quote shared: save entire transcript + notify Patrick immediately

**Admin edit:**
- Portal updates immediately (no save delay)
- Change history logged forever (who, when, old value, new value)

**Customer portal edit:**
- Log silently (no notification)
- Exception: email address change → notify Patrick (it's the matching key)

**Phone call:**
- Pull time/duration from Twilio if call routes through it
- Manual entry of notes for significant calls

**Inbound email prompting intake:**
- Initial prompt → wait 5–7 days → reminder #1 → wait 5–7 days → reminder #2 → mark as "stale, never completed" and stop

### 3.3 Outbound doors

PJL's outbound message channels are constrained by CASL (Canada's Anti-Spam Legislation) — every marketing-style send requires implied or explicit consent and a working unsubscribe path. Transactional sends (booking confirmations, on-the-way pings) are CASL-exempt; bulk marketing-style sends are not.

- **Transactional (CASL-exempt):** notify-customer.js lifecycle templates (received / reviewed / quoted / booked / on the way / rescheduled / cancelled). No unsubscribe required.
- **Seasonal Outreach (marketing-style, CASL-bound — first system-supported broadcast channel):** `outreach.sendBulk` from `/admin/outreach`. Implied consent from existing customer relationship; explicit unsubscribe path required on every send. Email includes a footer link (per-channel + "stop everything"); SMS includes "Reply STOP to opt out." Per-property comm prefs gate dispatch.

---

## 4. Transaction Flow (the chain of work)

```
LEAD ──→ QUOTE ──→ BOOKING ──→ WORK ORDER ──→ SERVICE RECORD ──→ INVOICE
```

Every box knows its parent and its child. No orphans.

### 4.1 Quote Folder

**Three flavours:**

**A. AI Repair Quote (`ai_repair_quote`)** — generated in chat from `pricing.json`, for locked-rate work. Lightweight acceptance: customer says "yes send a tech" → booking created → tech confirms scope on-site → signed work order is the binding moment.

**B. On-Site Quote (`on_site_quote`)** — tech walks zones, builds a quote from `pricing.json` on the truck. Customer accepts/declines per line item via on-device signature pad (or off-site remote-approval link). Implementation note: the spec historically called this `formal_quote`; the canonical name in the code (and in the operational lexicon) is `on_site_quote`. `formal_quote` remains in the type enum for legacy records but is no longer emitted.

**C. Project Proposal (`project_proposal`)** — proposal-grade narrative for commercial subcontracts, residential installs, lighting design, renovation coordination, and change orders. Branch-tagged (one of five buckets, see below). Carries multi-section narrative (cover summary → quotation summary → proposed scope → infrastructure list → budget notice → technical reference → project map → line items → acceptance), static-media attachments (Google Earth screenshots, CAD drawings, manufacturer schematics), and per-customer negotiated rates (snapshotted from `customer.negotiatedRates` at creation). Reads its line-items catalog from `server/data/project-rates.json` (admin-only, never exposed publicly). Dual acceptance path: portal e-sign (existing flow) OR print-sign-PDF-return (new flow with admin attestation). Brief 1 (May 2026).

**Branch taxonomy** for `project_proposal`:
- `gc_subcontract` — GC subcontract work
- `direct_residential` — direct-to-homeowner installs/retrofits
- `lighting_design` — landscape lighting (owner-deferred pricing)
- `renovation_coordination` — landscaper-led reno coordination
- `change_order` — mid-project scope additions

**Note on bypass-completed WOs:** When a work order is completed via signature bypass (admin-authorized verbal acceptance — see §4.3) AND the bypass also covers on-site quote acceptance (the builder carried lines beyond baseline), **no `on_site_quote` Quote record is created in this folder**. The WO's builder line items, snapshotted onto the bypass record (`acceptedScopeSnapshot`), are the authoritative scope record. Reporting that joins WOs to Quotes must account for this path — some WOs will not appear here.

**Routing logic — when does AI quote vs. capture lead:**

- If work is on the locked-rate list in `pricing.json` → AI generates `ai_repair_quote`
- **Smart-controller upgrade, 1-16 zones** (HPC-400/Hydrawise install) → quotable as a **DRAFT** `ai_repair_quote` from TWO doors (controller briefs, 2026-06-12): (a) the AI chat collects zone count + contact and the intake mints the draft; (b) Patrick's **+New Smart Controller Quote** admin action (quote folder) — zero per-quote typing, selections only: customer, property (when several), zone count (autofilled from `property.system.zones`/`zoneCount`, manual picks save back). Both doors produce the same artifact: tier resolved from `minZones`/`maxZones` in `pricing.json`, `narrativeKey:"smart-controller"` for the rich multi-section PDF + e-sign page (narrative lives in the editable, price-free content block at `server/lib/templates/smart-controller-quote.json`). Patrick reviews, taps Send → branded email w/ PDF + SMS → customer **e-signs** at the tokenized /approve page (lead-portal Accept stays as fallback) → lead `won`; Patrick books the install WO. **No PROJ** — the proposal entity stays untouched. **Service call (Patrick's rule, 2026-06-12): the admin door ASKS per quote — charge it ($95 line added) or waive it (the line still appears on the quote at $0, labelled WAIVED with "regularly $95" stated, mirroring the WO fee-waiver philosophy). No silent default.** The chat door quotes tier-only as told to the customer in chat. (A DEAD controller diagnosed mid-repair stays on the instant repair path: `service_call` + tier, auto-accepted at booking submit, AI-bonus eligible. Note: the public site's retrofit copy is internally split on the service-call question — Patrick chose to leave the site as-is for now, 2026-06-12.)
- If work is custom (install, **controller 17+ zones**, **controller accessories/add-ons — flow meter, rain sensor, lighting timer**, retrofit beyond a controller swap, 8+ zone install, mainline, drip retrofit, lighting, anything off-list) → AI captures lead, notifies Patrick, does NOT quote
- If unsure → default to lead capture

**Quote folder structure:**

```
QUOTE FOLDER
  Quote Identity
    - Quote number (Q-2026-0142, with versioning -v2 if revised; revision
      lineage carried bidirectionally via revisionOf / supersededBy)
    - Date created
    - Status: draft / sent / accepted / partially_accepted / declined /
              expired / superseded / cancelled / pending_admin_attestation
              (last one: project_proposal only, after customer uploads
              a signed PDF and before admin attests)
    - Type: ai_repair_quote / on_site_quote / project_proposal
    - Branch (project_proposal only): gc_subcontract / direct_residential /
              lighting_design / renovation_coordination / change_order
    - Billing mode (project_proposal only): fixed_price / time_and_material
    - Acceptance method: pending / portal_esign / pdf_return
    - Created by: AI chat / Patrick / tech / system

  Who & Where
    - Customer (link)
    - Property (link)
    - Site visit completed? (formal only)

  What's Being Quoted
    - Service category
    - Scope description (rich text for formal)
    - Line items: description, source_price_key, price_at_quote_time (snapshot),
                  quantity, line_total
    - Subtotal, HST 13%, Total
    - Deposit required? (formal only)

  AI Intake Diagnosis Bonus Flag
    - applies: yes/no (true when AI tool produced the quote)
    - quoted_scope (specific repair description / diagnosis)
    - rule: if on-site diagnosis matches the AI's prediction, customer receives ONE HOUR of repair labour FREE on the diagnosed scope (PJL's only discount). Diagnostic + repair labour otherwise billed normally at $95/hr.
    - anything beyond scope → standard parts + $95/hr, requires on-site re-quote

  The Offer
    - Date sent, sent how, valid until (default 30 days), terms

  Source / Origin
    - AI chat (link to transcript — REQUIRED for ai_repair_quote)
    - Booking form / Manual / Lead capture / Portal request

  Customer Response
    - Status, date, method
    - For ai_repair_quote: chat message capturing the yes
    - For formal: signature image + IP + timestamp + user agent
    - If declined: reason
    - If accepted: link to the booking it became

  Outputs (auto-generated)
    - For ai_repair_quote: in-chat quote summary
    - For on_site_quote: branded PDF + email + SMS + portal page
    - For project_proposal: multi-section narrative PDF + acceptance
                            block rendering BOTH portal e-sign URL
                            AND printed signature lines + email PDF
                            attachment + portal page

  Project Proposal-only blocks
    - proposalSections[]   — ordered narrative (cover, scope, refs,
                              line items, acceptance, etc.)
    - attachments[]        — uploaded images / PDFs, anchored to
                              specific sections for inline render
    - customRates          — labour-rate snapshot from the customer
                              at creation; frozen for the life of the
                              quote per Hard Rule #2
    - acceptanceEvidence   — method-specific evidence:
                              portal_esign: signature image, name,
                                IP, UA, signedAt
                              pdf_return:   uploadedPdfAttachmentId,
                                senderEmail, receivedAt, confirmedBy,
                                confirmedAt, adminNote

  Internal Notes
  Audit / History (all status changes logged forever — includes section
    edits, attachment add/remove, acceptance event, project conversion)
```

**Hard rules:**
- Quotes are versioned, not edited. Once sent, cannot be changed — revisions create -v2.
- Acceptance triggers: status flips, booking auto-created (ai_repair / on_site), Patrick notified, customer confirmed, competing drafts closed. For `project_proposal`, acceptance does NOT auto-cancel competing drafts (proposals are commonly comparison-shopped, unlike repair quotes).
- Default 30-day expiry for ai_repair / on_site. **90-day** default for `project_proposal` (commercial buyers often deliberate 60-90 days).
- AI-Correct-Diagnosis Bonus eligibility preserved on resulting WO. Bonus is conditional and PENDING until the tech confirms on-site diagnosis matches the AI-quoted scope; on confirmed match, tech credits 1 hr of repair labour free; otherwise labour bills normally at $95/hr.
- **Project Proposal scope lock:** once status moves past `draft`, the fields `proposalSections`, `lineItems`, `attachments`, `branch`, `billingMode`, `customRates`, `scope`, totals, and `type` refuse PATCH with 409 (mirrors the work-orders `SCOPE_PROTECTED_FIELDS` pattern). Status forward-progression, internal notes, history, and acceptanceEvidence (admin attestation lands here) continue to flow.
- **Project Proposal pricing source:** line items come from `server/data/project-rates.json` (internal admin-only catalog) OR are authored as custom lines with manual label + price. NEVER from `pricing.json` (which is the public catalog and must remain so). The internal catalog is excluded from public hardcoded-price linting + meta sync by being a JSON file under `server/data/`, not a public `.html`.

### 4.2 Booking Folder

Smaller object — mostly:
- Customer link
- Property link
- Scheduled date + time
- Service type
- Status (confirmed / tentative / cancelled / completed / no-show)
- Prep notes
- Source quote (if any)
- Resulting work order(s) — one booking can produce multiple WOs (multi-day repairs)
- **Self-service modification fields** (customer-side portal moves): `rescheduleCount` (capped at 1 for customer self-service; admin reschedules bump the counter too but bypass the cap), `cancelledBy` (`customer` | `admin` | `tech` | `no_show` | null), `cancellationReason`, `cancelledAt`.

**Cancellation lifecycle (Brief B):** Admins/techs can cancel a booking from `/admin/schedule` via the action panel on a booking card. Cancel is a *soft* operation:
- Status flips to `cancelled`; `cancelledAt`, `cancelledBy`, `cancellationReason` are stamped.
- History entry is appended (audit trail — read-only thereafter).
- `lead.booking.status` mirrors the new state so legacy CRM/portal renderers see the cancellation.
- Customer email is fire-and-forget (default ON, admin can uncheck). Email failure does NOT roll back the cancel — the UI surfaces "cancelled; email failed".
- Downstream rules: cancelled bookings don't count toward the week-total badge, can't have a WO created from them (409), and are excluded from the iCal feed (Brief C).
- Visible on the canvas with strikethrough + a CANCELLED pill (kept for context, not hidden).

**Hard delete** is admin-only, requires typing the booking ID in a confirmation field, and refuses if a linked WO is past `scheduled` (use Cancel instead). Strips the booking record entirely + clears the lead.booking pointer.

#### 4.2.1 Admin force-booking (custom-time override)

From `/admin/schedule`, the "Book customer" modal can put a booking on a precise minute that is not on the public bucket grid — to honour a customer commitment, fit a job into an off-corridor pocket, or override the normal hours guardrails. The time-picker tags such submissions with `source: "admin_custom"` on the booking-reserve POST.

The server (`POST /api/booking/reserve`) honours the flag **only when** the request carries a valid admin/tech session cookie. Public callers and the AI-chat booking handoff never send `source: "admin_custom"` and have no path to bypass guardrails.

When the override is honoured, the server **skips**:
- Drive-time corridor check (the public listAvailableSlots reachable-from-prev / reachable-to-next math)
- Hour-of-day / day-of-week gates
- "Must match an emitted bucket slot" check (arbitrary minute precision allowed)

The override **still applies**:
- Required fields (name, address, service type, parseable start time)
- Service type must be a known BOOKABLE_SERVICES key
- **Physical conflict** with another active booking (returns 409 with `code: "physical_conflict"` and `details.bookingId` so the admin UI can link out). Force does not mean silently double-book.
- Admin-created calendar blocks are **not** checked — if you are force-booking, you've already decided to override your own block. (Brief B operator-preference call.)

Every force-booked record carries `forcedByAdmin: true` on `lead.booking` and on the canonical Booking record in `bookings.json`, and appends a `force_booked_by_admin` entry to the Booking's `history[]`. Both the embedded read-cache and the canonical record can be queried for "was this force-booked?" without re-parsing the audit trail.

The schedule modal authentcates via the existing admin session cookie (sent on every fetch by default-`same-origin` credentials). The anti-bot/Turnstile gate is bypassed for any request whose session resolves to an admin or tech user — admin auth itself is the bot filter. Honeypot, time-trap, and per-IP rate-limit checks still apply (cheap, harmless).

#### 4.2.2 Customer-facing time window labeling

Customers never see the precise minute of a booking. Customer-facing copy — confirmation emails, SMS, the portal upcoming-bookings list — describes the appointment by half-day bucket:

- Time < 12:00 PM → "Morning Appointment (8 AM – 12 PM)"
- Time ≥ 12:00 PM → "Afternoon Appointment (12 PM – 5 PM)"

This rule applies to **force-booked custom times as well**. A 10:15 AM force-book is "Morning Appointment" to the customer; a 12:00 PM force-book is "Afternoon Appointment"; a 6:30 PM force-book is also "Afternoon Appointment" (the parenthesized window may slightly overstate the visit envelope on outliers — Patrick's call to keep the rule literal).

The admin-facing UI (today.html, schedule.html, work-order tech mode, booking detail) always shows the precise time. Only customer-facing surfaces translate to the half-day window. Implementation lives in `server/lib/notify-customer.js` `bookingDateTime()`, which reads `lead.booking.bucketLabel` + `bucketWindow` — both populated for force-booked appointments via the synthesis logic in the `/api/booking/reserve` handler.

**Spec deferred for detailed pass beyond cancel/delete + force-book.** Touched on but not formally designed.

### 4.3 Work Order Folder

The on-site instruction sheet + legal record + photo source. **Most operationally important folder.** It's what the tech opens on their phone in the driveway.

#### 4.3.1 Service Modes

The same WO template behaves differently depending on:
- **Service type** (spring opening, fall closing, repair, install, etc.)
- **Property maturity** (`new_to_pjl` or `existing` — drives whether fields are pre-filled or blank)
- **Service mode**:
  - `find_and_fix` — spring openings, repairs (tech can authorize work on-site)
  - `find_only` — fall closings (tech notes issues, defers them, no on-site quoting)
  - `fix_only` — service calls (no broad discovery, focused repair)
  - `build` — new installs / retrofits (no discovery context)

**Critical behaviour difference:** In `find_only` (fall closing) mode, the "Authorize now" button is **disabled** — only "Add to deferred recommendations" is available. Hard rule.

**Implementation note (current state):** the four service modes map to FOUR WO `type` values in code: `spring_opening` (find_and_fix), `fall_closing` (find_only), `service_visit` (find_and_fix or fix_only), and `build` (multi-day install / retrofit under a project). Brief 1 (May 2026) shipped the proposal side. Brief 2 (May 2026) shipped the `build` template — see §4.4 below for the full build execution flow. The `build` template adds a `dailyLog` block to the WO carrying sessions[] (clock in/out, labourer count + note), tasksCompletedToday[], materialsConsumed[], nextDayMaterials/nextDayTasks (carry-forward to the next day's WO), and dailyNotes (voice-input enabled). Build-mode WO completion DOES NOT fire the standard cascade — invoice + customer email + warranty stamp + service record all defer to project completion (see §4.5).

#### 4.3.2 Work Order Structure

```
WORK ORDER FOLDER
  Identity
    - WO number (WO-2026-0317; follow-ups: -followup-001, -002...)
    - Service type, property maturity, service mode
    - Status: scheduled / dispatched / en_route / on_site / 
              in_progress / completed / cancelled / no_show
    - Created from: booking link (REQUIRED — every WO has one)
    - Seasonal WOs (spring_opening / fall_closing) seed one or two
      baseline lines at creation via pricing.resolveSeasonalPrice():
        * Main seasonal fee (override → tier → custom-quote skip)
        * For fall_closing on a property with
          seasonalPricing.hasAdditionalFallBlowout, a second baseline
          line for the additional plumbing (cabana / pool house / etc.).
      Both carry source.baseline=true and are scope-protected once the
      WO is signed (snapshot rule — later property edits don't mutate
      the seeded lines).

  The Cheat Sheet (rendered first when tech opens WO)
    - Service address (one-tap maps)
    - Customer contact (one-tap call/text)
    - Access notes (gate, dog, parking)
    - System overview (zone count, controller, locations)
    - Critical locations: shut-off, blow-out (with photos)
    - Last service date + summary (existing properties only)

  Carry-Forward Banner (auto-loaded for spring openings)
    - All open deferred issues from this property
    - Each: tap to confirm/decline/dismiss/already-fixed
    - Visible at WO open AND on each relevant zone card

  Pre-Authorized Items (loaded if any exist from portal pre-auth)
    - Source: customer portal pre-authorization
    - Each: scope, snapshotted price, customer signature record
    - Tech sees as "✓ Already authorized" — no second signature needed
    - Tech still confirms scope on-site

  The Walk-Through (zone-by-zone cards)
    For each zone:
      - Zone number (auto-incrementing if new property)
      - Description (pre-filled if existing, blank if new)
      - Sprinkler type, coverage type (multi-select)
      - Standard checks (one-tap):
          ☐ Operated  ☐ Pressure good  ☐ Coverage good
          ☐ No leaks  ☐ All heads functional
      - Issues found (each = potential quote line item):
          - Type (broken head / leak / valve / wire / other)
          - Quantity, notes, photo
      - Zone-specific notes (persist on property)
      - Photo (replace existing, or add first photo if new)

  Service-Specific Steps
    Spring Opening:
      ☐ Water turned on at main shut-off
      ☐ Controller programmed for season
      ☐ Walk-through with customer (if home)
    (NOTE: Backflow check is intentionally NOT here — PJL is not a
    certified Ontario backflow tester. See memory/backflow_not_certified.md.)
    Fall Closing:
      ☐ Controller set to off / winter mode
      ☐ Water shut off at main
      ☐ Compressor connected at blow-out
      ☐ All zones blown clear (tap per zone)
      ☐ Compressor disconnected
      ☐ System winterized

  Materials Checklist (auto-generated from parts.json)
    - Driven by today's authorized line items
    - Tech taps "Mark as packed" before leaving shop
    - Editable on-site if reality differs

  Issues → Draft Quote (find_and_fix mode only)
    - All issues found across zones aggregated
    - Auto-priced from pricing.json + HST
    - Customer choices on-site:
        > Accept all / Accept some / Decline
        > Signature on accepted scope
    - Declined items → saved as deferred recommendations on customer/property

  Emergency Repair Override (find_only mode only)
    - Trigger: tech taps "Emergency" on a deferred issue
    - Required: reason dropdown + customer signature
    - Auto-notifies Patrick at moment of override
    - Logged in audit trail with metadata

  On-Site Execution
    - Arrival time (auto-stamped)
    - Departure time (auto-stamped)
    - Pre-work / in-progress / post-work photos
    - Photos can be promoted to property folder on completion

  Scope Changes On-Site
    - Original scope (locked at dispatch)
    - Discovered issues + photos
    - Additional work proposed (priced from pricing.json)
    - SEPARATE customer signature for additional scope

  Property Updates Captured (Brief D — auto-applied on completion)
    - Computed at GET time as a derived `propertyEdits` view: server
      diffs the WO's zone snapshot against the LIVE property record so
      concurrent admin edits to the property are visible. Returns
      { zoneEdits: [...], newZones: [...], hasChanges: bool }.
    - Each zoneEdit: { number, label, fields: [{field, before, after}] }
      — per-field deltas for location / notes / sprinklerTypes / coverage.
    - newZones: zones present on the WO but missing from the property.
      Get `pendingReview: true` so Patrick eyeballs before they merge
      fully (spec rule below). Auto-skips the placeholder
      "General service area" zone scaffolded by service_visit WOs.
    - Cascade applies the same diff via `properties.applySystemUpdates()`
      on completion; `wo.propertyEditsAppliedAt` timestamp gates against
      double-apply on re-fire. REPLACE semantics on populated WO fields
      (was additive-only — corrected so a tech fixing a wrong zone
      descriptor isn't silently dropped). Empty WO fields still don't
      blank existing property values.

  Customer Sign-Off (legally binding moment — single signature, signs
                     AND completes AND drafts the invoice in one tap)
    Signature is captured at the END of the visit, attesting to:
      - The final scope as performed (locked at this moment)
      - Authorization to bill the captured total
    Captured: customer name (printed) + drawn signature + ISO timestamp
    + IP + userAgent. The server stamps IP/UA — never trusts the client.
    Mid-visit verbal acceptances are captured as audit-log events
    (history[]) and give the tech legal cover to start work; they are
    NOT signatures.

    End-of-visit signature bypass (unified — admin-authorized)
    When the customer is not physically present at visit end, admin may
    record a signature bypass in place of the drawn-signature path. The
    bypass is a SINGLE end-of-visit action that retroactively covers
    BOTH the on-site quote acceptance (if any) AND the completion
    signature. It is captured at the moment of completion, not mid-visit.

    Bypass captures:
      - reason (customer_not_home / trusted_customer_verbal / other)
      - required note (≥10 chars; default "Customer not home —
        signature bypassed, verbal acceptance recorded"; when scope
        additions are present, the UI pre-fills the note with the
        dollar amount + space for verbal-acceptance context)
      - customer printed name (from property/customer/lead record)
      - bypassedBy identity (admin today; tech in future)
      - server-stamped ISO ts + IP + userAgent
      - acceptedScopeSnapshot: deep-copied builder line items +
        subtotal + hst + total at bypass time (the immutable scope
        record — belt-and-suspenders alongside SCOPE_PROTECTED_FIELDS)
      - coversQuoteAcceptance: derived bool, true when the builder
        carried lines beyond baseline + AI bonus credit at bypass time

    A bypass IS NOT a signature. It is an honest record of verbal
    acceptance at end-of-visit. However, a bypass DOES set
    `wo.locked = true` and fires the same completion cascade —
    operationally it is equivalent to a signature for downstream flow.

    When the on-site quote builder contains line items beyond the
    baseline seasonal fee (i.e., the customer is being billed for
    additional scope beyond what was booked), bypass requires an
    additional explicit acknowledgement that the customer verbally
    accepted the full scope including additions. The UI surfaces this
    as a warning state with TWO checkboxes (verbal-acceptance +
    scope-additions-ack) and a "Send for remote approval instead"
    button as the preferred alternative.

    Critically: when bypass covers a quote acceptance (builder has
    additions), **no `on_site_quote` Quote record is created in the
    quote folder.** The WO's builder, snapshotted onto the bypass
    record, is the legal scope record. This is a deliberate choice —
    the bypass record IS the acceptance record, and creating a separate
    Quote record without a signature would be misleading.

    `wo.signature` and `wo.signatureBypass` are mutually exclusive —
    a WO carries one or the other, never both. Bypass also refuses
    with 409 when:
      - `pending_remote_approval`: a send-for-approval Quote is
        pending customer signature (cancel it first, or wait)
      - `quote_already_accepted`: an on-site quote was already
        accepted with a drawn signature (use the regular completion-
        signature path instead)

    All pre-sign gates above apply to bypass too (zone walk-through,
    completion photos, payment method, return-visit, AI bonus when
    applicable, materials confirmation). Only the canvas + printed-name
    + acknowledgement-checkbox gates are replaced by the bypass-specific
    reason + note + verbal-acceptance acknowledgement. The server
    enforces the same gate set at the bypass endpoint
    (POST /signature-bypass) and returns 422 presign_gate_unmet with
    gateFailures[] when any gate fails.

    Scope additions discovered AFTER signature require a fresh signature
    on the new scope (see §10 r12). For original-scope completions, one
    signature covers the whole visit.

    Pre-signature gates — the "Sign, Lock & Generate Invoice" button is
    disabled until ALL of the following are captured (WO Field-Readiness
    brief, May 2026, promotes paidOnSite + materials check from post-
    signature to pre-signature). Each gate is surfaced in a visible
    checklist ABOVE the signature canvas with ✓ / ⨯ status icons; tapping
    a row scroll-jumps to the relevant capture surface:
      - Customer name entered (printed)
      - Acknowledgement checkbox ticked
      - Drawn canvas (signature pad is dirty)
      - Payment method selected (paidOnSite is true | false — neither
        radio chosen blocks signing)
      - AI Correct Diagnosis Bonus decision recorded (only when
        intakeGuarantee.applies=true)
      - Completion photo threshold (find_and_fix / fix_only require ≥1;
        find_only is optional — fall closings often have nothing visible
        to photograph)
      - All zones reviewed (status or at least one standard check ticked)
      - Carry-forward items resolved (spring openings only)
      - Materials check confirmed — two complementary gates layer here:
          (a) Follow-up packing-list rows — every visible row marked
              packed on follow-up WOs (techMaterialsSection).
          (b) Materials list confirmed — `wo.materialsConfirmedAt`
              must be set via the "Confirm materials list is accurate"
              button. Auto-passes for fall_closing WOs and any WO with
              empty `materialsPacked` + empty `customParts` (nothing
              to confirm). Auto-clears on the next materialsPacked /
              customParts mutation, so any qty step mid-visit forces
              re-confirmation before signing.

    Defense in depth: the server re-validates these gates at the PATCH
    boundary (`computeServerSidePreSignFailures` in server.js). A stale
    tab or replayed offline-queue mutation cannot route around the
    client gate — 422 + error: 'presign_gate_unmet' + gateFailures[].

    On tap: the merged PATCH carries
      { signature, status: "completed", arrivedAt?, departedAt? }
    in one round-trip. The server persists signature, sets locked=true,
    transitions status to completed, awaits the completion cascade
    (service record + draft invoice + warranty + property-edits apply +
    customer/admin emails), and returns the freshly-drafted invoice ID
    in `response.cascade.invoiceId`. No client-side polling race; the
    post-signature panel renders the invoice number immediately.

    Cascade hard-fail recovery: if the cascade throws mid-flight, the
    WO remains signed + locked + status=completed and a `cascade_failed`
    history entry is appended. The tech-mode and desktop signoff cards
    surface conditional recovery buttons:
      - "Generate invoice now" — calls POST /create-invoice when locked
        AND no invoice exists yet
      - "Re-run cascade" — calls POST /run-cascade when locked AND no
        `cascade_fire` history entry exists
    Both endpoints are idempotent; retry is safe and produces no
    duplicate invoices (cascade short-circuits at the service-record
    check).

    Historical sweep: the /admin/work-orders index supports
    ?needs_invoice=1 — surfaces every locked WO without an invoice on
    file (catches both cascade-never-fired AND cascade-fired-but-draft-
    failed). Each filtered row exposes a "Run cascade now" button for
    one-click recovery from the index without opening each WO.

    After signature: scope is locked (see §4.3.3 r5 + §10 r11). Status
    progression, photo capture (including HEIC / PDF up to 25 MB per
    file — WO Field-Readiness brief widened the MIME whitelist), tech
    notes, and follow-up linkage continue to flow and append to
    `history[]`. The WO remains a live operational document after
    sign-off; only the *scope* is frozen.

  Follow-Up WO Trigger
    - Tech taps "Schedule follow-up" instead of "Authorize now"
    - Creates linked WO with materials list pre-loaded
    - Customer signs for follow-up scope
    - Original WO closes for today's work; follow-up scheduled

  Payment & Billing (Brief C)
    - Final total (subtotal + HST) — derived from
      onSiteQuote.builderLineItems
    - paidOnSite: true | false | null — persisted on the WO; cascade
      reads it to set `invoice.paidOnSiteAtCompletion` and reshape the
      customer email ("Payment received in the field — thank you" vs
      "Invoice attached"). Patrick still reviews each draft invoice
      before sending or marking paid in QB.
    - QuickBooks invoice ID (auto-populated post-cascade)

  Customer-visible notes (Service Report brief, 2026-05-19)
    - `wo.customerNotes` — tech-authored narrative for the customer.
      Voice-input enabled. Embedded in the Service Report PDF as
      "Notes for the Customer."
    - REQUIRED non-empty before signature. Pre-sign gate blocks
      submission while empty (both client and server enforce).
    - Scope-protected at signature — locks alongside lineItems /
      onSiteQuote. `techNotes` remains UNlocked (admin-only, can be
      amended post-sign).

  Report Snapshots (Service Report brief, 2026-05-19)
    Each WO carries `reportSnapshots[]` — append-only list of frozen
    Service / Inspection Report PDFs the customer received. Each entry:
      { snapshotId, ts, triggerType, mode, quoteId?, filename, path, sha256?, by }
        triggerType: "quote_send" | "cascade" | "manual"
        mode:        "inspection_report" (pre-completion) |
                     "service_report" (post-completion, locked)
        quoteId:     populated only on quote_send triggers
        sha256:      hex digest of the PDF bytes (integrity)
    Files live on the persistent disk at
    `server/data/wo-reports/<woId>/<snapshotId>.pdf`. Snapshots are the
    customer's source of truth: the cascade attaches the cascade-trigger
    snapshot to the completion email, the on-site-quote send-for-approval
    flow attaches a fresh quote_send snapshot alongside the quote PDF,
    and the customer portal "Download service report" link serves the
    most-recent cascade snapshot per service record.

    Cascade snapshot idempotency: `wo.completionReportSnapshotAt` is
    stamped on first successful cascade snapshot. Re-fires look up the
    most-recent cascade entry via `findLatestCascadeSnapshot` and reuse
    it (no duplicate file on disk, no duplicate email — the existing
    cascade idempotency handles the email side).

    Send-for-approval snapshot semantics: each call to send-for-approval
    creates a NEW snapshot. If the customer asks for a revision and the
    tech re-sends, the customer receives a fresh report reflecting any
    updates. Old snapshots are preserved on `reportSnapshots[]` as the
    legal record of what was originally offered.

    Snapshot failure mid-cascade leaves `completionReportSnapshotAt`
    unset; the cascade-recovery admin action (POST /run-cascade) becomes
    the retry path.

  Audit / History (Brief A — append-only, never edited)
    Each WO carries `history[]` mirroring quotes.history / invoices.history.
    Entry shape:
      { ts, action, by, note, before?, after? }
        - ts: ISO timestamp
        - action: short slug (status_change, signature_capture,
                 signature_bypassed, photo_upload, photo_delete, quote_built,
                 customer_accepted, customer_declined_all, remote_approval_sent,
                 issue_deferred, issues_bulk_deferred, emergency_override,
                 carry_forward_*, cascade_fire, cascade_failed, invoice_drafted,
                 ai_bonus_decided, followup_created, property_edits_applied,
                 patch, etc.)
        - by: "admin" | "tech" | "system" | "customer"
        - note: human-readable summary
        - before/after: optional state snapshots (set on status changes,
                       AI bonus decision, etc.)
    Every dispatcher mutation appends an entry. Read-only viewer renders
    on both desktop and tech surfaces. History entries are append-only;
    never edited or deleted in normal operation.
```

#### 4.3.3 Behavioural rules for work orders

1. **Every WO has exactly one booking parent.** No orphans.
2. **Property info is pulled FRESH at WO open.** WO doesn't store its own copy — it links. Photos taken on the WO are stored on the WO and optionally promoted to property folder.
3. **Status transitions are forward-only.** Skips allowed, reverses not.
4. **Scope changes require fresh signature.** Original signature is for original scope only.
5. **Signed or bypass-locked WO is the contract.** Once `wo.locked === true` (set at signature capture OR signature bypass capture), the following scope-protected fields are locked and any PATCH that touches them returns 409: `lineItems`, `additionalRepairs`, `onSiteQuote`, `signature`, `signatureBypass`, `customerName`, `customerEmail`, `customerPhone`, `address`, `propertyId`, `leadId`, `intakeGuarantee`, `aiBonusMatched`, `type` (canonical list lives in `SCOPE_PROTECTED_FIELDS` in `server/lib/work-orders.js`). Status progression, photos, materials updates, paidOnSite, internal notes, and follow-up linkage continue to flow and append to `history[]` — the WO remains a live operational document after sign-off; only the *scope* is frozen.
6. **AI-Correct-Diagnosis Bonus is enforced.** If WO carries the flag, tech sees a banner: "AI-correct-diagnosis bonus eligible for [scope]. If on-site diagnosis matches, credit the customer ONE HOUR of repair labour free on the diagnosed work." Diagnostic + repair labour billed normally at $95/hr.
7. **Cancellations and no-shows are terminal states** with logged reasons.
8. **Fall closings cannot auto-quote.** Hard rule. Issues → deferred items only.
9. **Emergency overrides on fall closings notify Patrick immediately.**
10. **Voice-to-text on every text field** (tech speed).
11. **Camera shortcuts in every photo field.**
12. **Offline mode mandatory.** Captured locally, synced when service returns.
13. **Auto-save every change.** Resume where left off. **Field-dirty guard (Jul 2026):** the human editing a field wins over a background server echo — no resync, queue-drain reconcile, or save-response repaint may overwrite an input value (or replace its DOM node) while that field is focused, a dictation session is live, or a debounced save is pending. Saves debounce to a short pause / blur, not per-keystroke. Deferred repaints run at blur + dictation-idle. This is an invariant: a future "simplification" that re-hydrates the whole form from a GET reintroduces the field-data-loss bug.
14. **Walk-out checklist** before "Complete": signature captured? all zones marked? next-visit flags?
15. **Customer notes are required at signature.** `wo.customerNotes` must be non-empty before the signature submit unlocks. Pre-sign gate blocks (both client and server enforce). Scope-protected at signature — the customer's frozen Service Report copy can't be amended after sign-off. `techNotes` remains separate (admin-only, unlocked).

#### 4.3.4 Completion cascade

When tech taps "Complete":
- Status → completed
- Service record created on property
- Photos optionally promoted to property folder
- Property updates (zone descriptions, new zones, etc.) committed
- Customer notified with summary
- Service Report PDF rendered and snapshotted (Service Report brief,
  2026-05-19); attached to customer email; gated by
  `wo.completionReportSnapshotAt` for idempotency. Snapshot failures
  leave the stamp unset and the cascade-recovery admin action becomes
  the retry path.
- Patrick notified
- QuickBooks invoice generated (drafted)
- If WO is fall_closing AND property.seasonalPricing.hasAdditionalFallBlowout
  is true, the draft invoice carries the fall_additional_plumbing
  disclaimer key. Idempotent via Set semantics in invoices.update —
  cascade re-fires never duplicate keys.
- Customer portal updated to show completed work (including a
  "Download service report" link per service record with a cascade
  snapshot)
- Warranty clock starts (1 year repairs / 3 years installs)
- **Invoice-ready customer SMS scheduled** (Invoice SMS brief, May
  2026) — fires ~5 min after the cascade unless the invoice was paid
  on site, the master switch (`settings.invoiceSms.enabled`) is off,
  or the customer has opted out of text reminders. Mints a
  per-invoice `portalToken` for the SMS deep-link
  (`/portal/invoice/:id?t=<token>`). Idempotent — re-firing the
  cascade never re-schedules or re-sends. A 2-minute sweep recovers
  sends lost to a server restart, capped by `invoiceSms.maxAgeHours`.

---

### 4.4 Project Folder Execution (Brief 2, May 2026)

A Project (`PROJ-YYYY-NNNN`) groups multi-day build work under a single accepted proposal. Brief 1 set up the proposal-to-project handshake; this section covers the execution loop.

```
PROJECT FOLDER (execution-relevant fields)
  tasks[]               — { id (task_xxxxxxxx), description,
                            sourceLineItemId, status: pending|in_progress|done,
                            completedAt, completedByWoId, order, notes }
                          Seeded from accepted-quote line items at conversion.
                          Manual additions allowed. Edit/delete locked once done.
  scopeChangeRequests[] — { id (scr_xxxxxxxx), description, capturedBy,
                            capturedAt, capturedFromWoId, photoIds[],
                            suggestedLineItems[], estimatedTotal,
                            draftEmail { to, subject, body },
                            status: pending_admin_review |
                                    pending_customer_approval |
                                    approved | rejected | withdrawn |
                                    executed_under_revision,
                            sentAt, resolvedAt, resolvedAs,
                            resolutionNote, linkedRevisionQuoteId }
  statusUpdates[]       — { id (su_xxxxxxxx), generatedAt, generatedBy,
                            recipient { email, name }, deliveryMethod,
                            snapshot (frozen content), note }
                          Append-only. Every "Send status update" press
                          appends one entry.
  finalWoId             — explicit pointer to the WO that closes the project.
                          Auto-detected as most recent build WO if unset.
  projectCompletionAt   — idempotency stamp for completeProject.
  invoiceGeneratedAt    — idempotency stamp for invoice creation.
  finalInvoiceId        — the invoice ID created at completion.
```

**In-scope vs out-of-scope additions:**

- **In-scope** — work added that falls within the original proposal (e.g., proposal said "approximately 500 ft mainline", install needs 540 ft). Captured on the day's WO. No scope-change record needed. Covered by the original acceptance.
- **Out-of-scope** — work outside the proposal (e.g., customer asks for drip irrigation while crew is on-site). Captured as a scope-change record via the "Note a scope addition" card on the build WO or the project detail page. State machine: `pending_admin_review` → admin reviews + edits draft email → `pending_customer_approval` → customer responds → `approved` / `rejected` / `withdrawn`. On approval (fixed-price projects), admin presses "Generate quote revision" → creates a Q-vN containing original + approved line items, linked to original via `revisionOf` (the original is `superseded` with `supersededBy` back-reference). SCR status → `executed_under_revision`. T&M projects can skip the revision step — bill from actual.

**Project completion preflight:**

Before the cascade runs, `completionPreflight()` returns three buckets:
- **Blockers** — refuse completion unless admin explicitly overrides:
  - Unresolved scope-change requests (pending_admin_review / pending_customer_approval)
  - Approved SCRs without a quote revision (fixed-price projects)
  - T&M project with no `labourRateLocked`
- **Warnings** — visible in the completion modal but don't block:
  - No final WO selected (most recent build WO is used)
  - Final WO unsigned (customer hasn't signed the closing visit)
  - Tasks not yet marked done
- **Okayed** — green checkmarks for confirmation

**Status update generator:**

Manual-press only — no scheduled / automatic delivery. Recipient defaults to project customer; admin can override to a GC contact or other stakeholder. Content auto-generated from project metrics + recent tasks + upcoming tasks + pending SCRs. Frozen snapshot logged on `statusUpdates[]` for every send.

### 4.5 Build Completion Cascade

The standard `completion-cascade.js` short-circuits for build-mode WOs — each day's WO is one slice of execution, not its own contract. Only project completion fires the full cascade.

**Build WO completion** (per-day):
- `cascade_fire` logged on WO history with `mode: 'build_short_circuit'`
- No invoice generation
- No customer email
- No warranty stamp
- No service record

**Project completion** (`POST /api/projects/:id/complete`):
- Runs preflight (see §4.4). Returns 409 with blocker list if any are unresolved.
- Generates invoice via `runProjectFinalCascade()`:
  - **Fixed-price billing** — invoice line items mirror `project.proposalSnapshot.lineItems` exactly. Tax recomputed using current 13% HST.
  - **Time-and-material billing** — invoice lines derived:
    - One **Project labour** line summing total hours across all build WO sessions (hours × labourersOnSite per session, summed) × `project.labourRateLocked`.
    - One **Material** line per consumed SKU (grouped across all build WOs, sorted alphabetically by SKU for deterministic output). Label + unit price from parts.json. **If any consumed SKU lacks a retail price in parts.json, the cascade refuses with an error** — admin must set the price before billing. No silent fallbacks.
- Creates property service record (`projectId` set so the service-record viewer can deep-link back).
- Sends customer email with invoice attached.
- Sends admin email with project summary.
- Sets project status → `complete`, `projectCompletionAt` stamp, `finalInvoiceId` set.
- Idempotent — re-running returns the existing invoice ID with no duplicate side effects.

---

## 5. Deferred Issues (carry-forward across visits)

The "fall finds, spring fixes" engine. Fall closings note issues but never quote/repair them. Spring openings load them automatically.

### 5.1 Lifecycle

```
FALL — Tech notes "Zone 3 broken head"
   → DEFERRED ISSUE created (status: open, found_on: WO link, photo, location, suggested fix, estimated cost)

WINTER — Property folder + customer portal show open recommendations
   → Customer can pre-authorize from portal (binding e-signature)

SPRING — WO opens with carry-forward banner showing all open deferred issues
   → Tech taps:
       "Repair now" → adds to today's work + pricing → status: in_progress → resolved
       "Customer declined" → re-defers to next visit (counter increments)
       "Already fixed" → closed
       "Cannot locate" → closed with note
```

### 5.2 Folder structure

```
DEFERRED ISSUE
  Identity
    - Issue ID
    - Status: open / in_progress / resolved / dismissed / re_deferred
    - Found on: WO link
    - Found date
    - Resolved on: WO link (when applicable)
    - Re-deferral count

  Where & What
    - Property link
    - Zone (if zone-specific)
    - Component (head / valve / wire / pipe / controller / other)
    - Description, photos
    - Suggested fix (line items from pricing.json)
    - Estimated cost (snapshot)

  Why Deferred
    - fall_visit_no_repairs_policy
    - customer_declined
    - materials_not_on_truck
    - weather_delay
    - other (with notes)
```

### 5.3 Rules

1. Fall closings never auto-quote on-site. Issues → deferred only.
2. Spring opening WOs auto-load carry-forward issues at generation.
3. Deferred issues survive across years. Declined → re-defers.
4. **Three-year flag:** after 3 re-deferrals, system flags: "This issue has been declined 3 years in a row. Resolve, escalate, or dismiss." Forces a decision.
5. Customer portal shows open recommendations with photos and estimated costs. **Pre-authorization is BINDING.** Captured with full e-signature record (printed customer name, drawn signature image, IP, userAgent, ISO timestamp, exact scope as-shown on the portal). Pre-authed scope and snapshotted price are locked from the moment of portal-signing. If the tech arrives and reality differs from the pre-authed scope, the pre-authorization is invalidated for that specific item and a fresh on-site signature is required for the actual work.
6. Pre-authorized items load into next spring's WO as "✓ Already authorized."

---

## 5.5 Identity & Access

PJL has two distinct identity tracks:

**Admin / tech accounts** — internal users who sign in to the CRM with
their own email and password. Stored in `server/data/users.json` as
`USR-NNN` records with per-user scrypt salt + hash. Roles are `admin`
(can manage other accounts at `/admin/users`) and `tech` (everything else
in the CRM). Sessions last 30 days rolling. Add an account via
`npm run create-user` (one-shot CLI) or the `+ Add user` button on
`/admin/users`.

**Customers** — `customer` is *not* a discrete entity; the customer
record IS the lead record in `leads.json`. The permanent
`/portal/<token>` URL stays valid (token derived from the lead ID); the
magic-link flow — now on the unified `/login` door (see below;
`/portal/login` 301s there) — lets the customer request a fresh emailed
link if they lost the original. Magic-link verify sets a
`uid: "customer:<leadId>"` session cookie (30 day rolling) and redirects
to the same permanent portal URL.

**Unified login door (Jul 2026 — accepted deviation, decision owner
Patrick).** `/login` is the single human-facing sign-in URL for BOTH
staff and customers: one form (email + optional password, button "Login
Now"). `POST /api/login` decides server-side, password-first:
1. Email + non-blank password matches a `users.json` staff account →
   staff session, redirect to `/admin` (honours `?next=`).
2. **Every other outcome** — blank password, wrong password, disabled
   account, unknown email, valid customer email — reuses the
   `request-link` internals (`requestPortalMagicLink`, not a fork) and
   returns one generic 200 "If an account exists, check your email for
   a sign-in link." Byte-identical across branches.
Precedence when an email is both a staff account and a customer lead:
password present → staff attempt; blank → customer link.
**Why this shape (the logged trade-off):** an identifier-first flow
(type email → page reveals password vs magic-link) needs an identity
probe that leaks staff-vs-customer status and reopens the
timing-enumeration channel this design deliberately closed. The two
auth *mechanisms* stay separate; only the *pages* merged. Do NOT
"simplify" this into a lookup-then-branch flow — that reintroduces the
enumeration leak. Both rate limiters apply independently and before any
lookup (staff attempts: `/api/login` 10/IP/15min; magic-link fallback:
3/hr/identifier + 10/hr/IP). A staff member who submits a blank
password gets the generic "check your email" (no email arrives unless
they're also a lead) — acceptable; the password field carries a
"Staff only" cue.

**Cookie shape.** All sessions carry `{uid, role, exp}` JSON HMAC-signed
with the secret in `auth.json`. Tampering → 401. Roles: `admin`, `tech`,
`customer`.

**Magic tokens.** `server/data/magic-tokens.json` holds short-lived
single-use credentials for two purposes: `customer_login` and
`admin_password_reset`. 30-minute TTL. Marked used on first verify.
Sweep deletes used or expired entries older than 24h.

**Rate limits.** `POST /api/portal/request-link` is gated at 3/hour
per identifier and 10/hour per IP, BEFORE the leads/properties lookup
runs (no timing enumeration). The endpoint *always* returns the same
generic 200 body whether or not we found you. `POST /api/login` is
gated at 10/IP per 15 minutes. `POST /api/users/:id/reset-password` is
gated at 3/hour per user.

**Hard rules.**
- Authentication: per-user accounts in `users.json`. The `auth.json`
  file is session-secret storage only after migration. **Never
  reintroduce the single-password pattern.**
- The permanent `/portal/<token>` URL keeps working *without* a session
  cookie. Magic-link tokens are SEPARATE from the permanent token —
  different files, different lifetimes, do not conflate.
- The `/approve/<id>?t=<token>` quote-approval URL is unchanged by this
  refactor.

## 6. Customer Portal

### 6.1 What customers can do

- View their customer + property folders (read-only for most fields)
- **Edit:** phone, email, best time to reach, notification preferences
- View service history at their property
- View open recommendations (deferred issues) with photos and estimated costs
- **Pre-authorize** deferred recommendations with binding e-signature
- Accept / decline formal quotes with signature pad
- View upcoming bookings
- **Reschedule** an upcoming booking once, up to 24 hours before the appointment (one self-service reschedule per booking; admin can move it further from the CRM)
- **Cancel** an upcoming booking up to 24 hours before the appointment, with a captured reason (reason chip + optional free-text, "Other" requires free-text)
- **View an individual invoice** (read-only) via the SMS deep-link at `/portal/invoice/:id?t=<portalToken>` — line items, totals, status, and a "Pay this invoice" button that opens the QB payment page in a new tab. Mirrors the formal invoice without exposing internal notes or audit trail.

### 6.2 What customers cannot do

- Edit address, system info, zones, photos (read-only — those come from work orders)
- Delete records
- Change billing info (handled in QuickBooks)
- Reschedule a booking a second time via the portal (must call after the first self-service move)
- Reschedule or cancel within 24 hours of the appointment (phone fallback only — server-enforced)
- Cancel or reschedule a booking whose linked work order is already in progress, signed, or completed (locked state — phone fallback)
- Cancel or reschedule a multi-WO booking (multi-day repair jobs — must call to coordinate)

### 6.3 Notification preferences (per customer)

- Text reminders (yes/no) — also gates the invoice-ready SMS that fires ~5 min after WO completion (Invoice SMS brief, May 2026). When this is `false`, the cascade logs `customer_sms_skipped_opted_out` to invoice history instead of scheduling.
- Email-only mode
- No marketing texts
- Override Patrick's defaults for this customer
- **Seasonal SMS reminders** (yes/no) — controls whether
  `outreach.sendBulk` may dispatch spring/fall booking nudges by
  text. Lives at `property.commPrefs.seasonalRemindersSMS` until the
  Customer Folder Phase 2 migration; then migrates up to customer.
- **Seasonal email reminders** (yes/no) — mirror of the above for
  email. Lives at `property.commPrefs.seasonalRemindersEmail` until
  the same migration.
- **Per-property opt-out tokens** — three stable 32-hex tokens
  (`seasonalSMS`, `seasonalEmail`, `seasonalAll`) at
  `property.commPrefs.optOutTokens`, minted lazily on first
  outreach send. Public `/unsubscribe/<token>?type=email|sms|all`
  page validates and flips the corresponding pref.

---

## 7. The Full Chain — Reference Diagram

```
                    PJL OPERATIONS SYSTEM
              ────────────────────────────────────

  REFERENCE DATA
    pricing.json    →  feeds public site, AI, quotes, work orders
    parts.json      →  feeds work order materials checklist
    settings        →  notification prefs (admin + per-customer)


  CORE FOLDERS
    CUSTOMER (the person)          status, contact, comm history, prefs
       │
       ├── PROPERTY (the place)    address, system, zones, photos, access
       │     │
       │     ├── DEFERRED ISSUES   carry-forward across visits
       │     │
       │     └── SERVICE RECORDS   history of completed work
       │
       └── (1+ properties per customer)


  TRANSACTION FLOW
    LEAD ──→ QUOTE ──→ BOOKING ──→ WORK ORDER ──→ SERVICE RECORD ──→ INVOICE
              │                        │
              │                        ├─ pre-authorized items (from portal)
              │                        ├─ carry-forward issues (from prior WO)
              │                        ├─ on-site issues found (new)
              │                        ├─ emergency overrides (fall only)
              │                        ├─ materials checklist (from parts.json)
              │                        ├─ scope changes + signature
              │                        └─ follow-up WO (if needed)
              │
              ├─ AI repair quote (verbal in chat)
              └─ Formal quote (portal + signature for installs/retrofits)


  DOORS (how info gets in)
    AI chat              ──┐
    Booking form           │
    Admin (Patrick)        ├──→ matching rules ──→ correct folder
    Customer portal        │     (email→phone for customers,
    Phone calls (logged)   │      address for properties,
    Twilio texts           │      flag if mismatch)
    Inbound emails         ──┘
```

---

## 8. AI Behavioural Rules

The AI ("Patrick") is a customer-facing salesperson + diagnostic tool. The full system prompt lives in `system_prompt.md`. Key behaviours that touch the operations system:

1. **All pricing comes from `pricing.json`.** AI is forbidden from inventing prices.
2. **Service-call repairs:** AI quotes from price list → customer says yes → booking + ai_repair_quote created.
3. **Seasonal services:** AI gives ballpark, drives to booking.
4. **Installs / retrofits:** AI does NOT quote. Captures lead, hands to Patrick. **Exception (controller brief, 2026-06-12): smart-controller upgrades 1-16 zones** — flat, locked-rate, on-list — are AI-quotable as a **draft** `ai_repair_quote` (`kind:"controller_upgrade"` + `zones` in the QUOTE_JSON); Patrick reviews and taps Send before the customer gets the formal quote. 17+ zones and any accessory/add-on still route to lead capture.
5. **AI-Correct-Diagnosis Bonus:** When AI quotes a repair from the price list, the resulting WO carries a bonus flag. If the on-site diagnosis matches the AI's quoted scope, the tech credits the customer ONE HOUR of repair labour free on the diagnosed work. PJL's only discount.
6. **Quote audit trail:** Every AI repair quote saves the entire chat transcript as the source.
7. **Notify Patrick immediately** when AI quotes anything.
8. **Off-list questions** = lead capture, never guess.

---

## 9. Open Items (deferred for future passes)

These are knowns that aren't done. Listed so they don't get forgotten.

### 9.1 `parts.json` — service mappings (~50% complete)

Done: All repairs, all controllers, single valve, wire repairs, pipe break.

Empty (need future pass):
- All seasonal services (7 entries) — likely most stay empty (no parts), but spring openings may include 1-2 head replacements
- All new install entries (4 entries) — `new_install_zone_grass`, `new_install_zone_drip` are the priorities, plus the frost-free hose bib add-on
- Service call baseline (truck stock essentials)

**Typos to fix when next editing:**
- `wire_diagnostics`: Dryconn quantity is 0.8 (probably meant 0.08 — 12 connectors, not 120)
- `pipe_break_repair`: pipe roll quantity is 1 (probably meant 0.01 — 3ft of a 300ft roll)
- `head_replacement_mulch`: uses SJ506 swing joint (worth confirming — 6" mulch heads usually want SJ712 or SJ7512)

### 9.2 Unit-of-use decision

Catalog parts are in purchase units (rolls, cans, packs). Services consume them in use units (feet, individual pieces). Three options:
- **A:** Keep purchase units (simple, useless for cost tracking)
- **B:** Use fractional decimals (accurate, ugly on packing lists)
- **C:** Add `unit_of_use` and `units_per_purchase` fields to each part — system computes both views

Recommended: C for long term, A for v1. Decision required before installs are mapped or this becomes a structural rework.

### 9.3 Booking folder formal spec

Touched on but not formally designed. Quick pass needed. Roughly: customer link, property link, scheduled date+time, service type, status, prep notes, source quote, resulting WO(s).

### 9.4 Pricing drift

Spring opening / fall closing ≤4 zones is currently $90 on website but $85 in AI prompt. Reconcile to one number when migrating to `pricing.json`.

### 9.5 UI design

Admin dashboard, customer portal, tech work order interface — all to be designed during build, guided by this spec.

### 9.6 Migration plan

Build new structure alongside existing system. Migrate one folder type at a time. Verify each migration before next. No big-bang rewrite.

### 9.7 First slice recommendation

Don't build everything at once. Suggested vertical slice to prove the architecture:
- Customer + property folders
- AI chat door + matching rules
- Quote folder (AI repair flavour)
- AI repair quote flow end-to-end

Once that works, the rest follows the same patterns.

---

## 10. Hard Rules — Never Break

These are the rules that protect the design from drift. Number them so they can be referenced ("violating rule 4").

1. **One source of truth for every fact.** No duplication of pricing, parts, customer info, or property info.
2. **Quotes snapshot prices at creation.** Future price changes never alter accepted quotes.
3. **Work orders pull property info fresh.** Updates flow back to property folder on completion.
4. **All status changes logged forever.** Storage is cheap. Future-you needs the history.
   - *Scoped deviation:* Voided invoices may be hard-deleted through the tombstone flow (feature-invoice-void-delete-brief.md, 2026-07); the tombstone in `deleted-invoices.json` (frozen snapshot + reason + actor + timestamp, never pruned) is the permanent record. The operational record leaves `invoices.json`; the audit trail does not. Applies to `void` invoices only, through that one flow — no other entity inherits it. Invoice lifecycle with this flow: `draft → sent → paid → void → (deleted, tombstoned)` (delete reachable only from `void`).
5. **Don't bolt new features onto old structures.** Refactor to fit this design or revise the design.
6. **Every WO has exactly one booking parent.** No orphans.
7. **Fall closings never auto-quote on-site.** Find-only mode. Issues → deferred only.
8. **AI never invents prices.** `pricing.json` or it's a lead.
9. **Quotes are versioned, not edited.** Once sent, revisions create new versions.
10. **Customer/property separation is permanent.** Don't conflate them, ever.
11. **Signed or bypass-locked work order is the contract.** Locked once signed OR bypass-recorded (`wo.locked === true`). Scope-protected fields refuse PATCH with 409 — see §4.3.3 r5 for the canonical list (`SCOPE_PROTECTED_FIELDS` in `server/lib/work-orders.js`). Status, photos, materials, paidOnSite, and notes still accept edits and append to `history[]`.
    - **Signature bypass is not a signature.** Bypass records verbal acceptance at end-of-visit when the customer is not present, and unifies the on-site quote acceptance with the completion lock in a single audited event. It carries weaker legal posture than a drawn signature but the same operational lock. Admin-authorized and audited. When bypass covers a quote acceptance (`coversQuoteAcceptance: true`), no `on_site_quote` Quote record is created — the WO builder snapshot (`signatureBypass.acceptedScopeSnapshot`) is the scope record. `wo.signature` and `wo.signatureBypass` are mutually exclusive; bypass also refuses when a pending or already-accepted on-site Quote exists on the WO.
12. **Scope changes require fresh signature.** Pre-signature scope changes (during the visit) are part of the same WO and the single completion signature covers them. Post-signature scope changes (e.g., customer asks for additional work after signing) require either (a) a fresh signature on a new scope-change record, or (b) a follow-up WO with its own signature flow. The on-site-quote endpoints all 409 once `wo.locked === true`. Post-bypass scope changes follow the same rules as post-signature scope changes — bypass locks scope identically to a signature.
13. **Emergency fall overrides notify Patrick immediately.** Real-time, not nightly review.
14. **Customer portal write surface is explicit and limited.** (a) non-structural fields — phone, email, best time, prefs; (b) pre-authorization signatures on deferred recommendations; (c) formal quote acceptance signatures; (d) one self-service reschedule per booking up to 24 hours out; (e) self-service cancellation with reason up to 24 hours out. Anything else is admin-only. New write surfaces require an explicit revision of this rule.
15. **Three-year deferred flag forces a decision.** No infinite carry-forward.
16. **Self-service portal modifications enforce time and frequency rules server-side.** The portal UI greys out blocked actions via `GET /api/portal/:token/booking-actions` preflight; the underlying mutation endpoints (`PATCH /api/portal/:token/reschedule`, `POST /api/portal/:token/cancel`) enforce the same gates with 409 responses carrying a typed `code` field and a `phoneFallback` string from `settings.contactInfo.customerSupportPhone`. UI is a courtesy; API is the truth. Admin endpoints (`PATCH /api/bookings/:id/reschedule`, `POST /api/bookings/:id/cancel`) bypass the cutoff and frequency caps — Patrick can move bookings as many times as he needs to.
17. **Marketing-style sends honor comm prefs and CASL.** Every outreach message includes an unsubscribe path (per-channel and "stop everything"). Email gets a footer link; SMS gets "Reply STOP to opt out." Per-property comm prefs (`seasonalRemindersSMS`, `seasonalRemindersEmail`) gate dispatch — `outreach.sendBulk` will not text a property whose `seasonalRemindersSMS=false`, will not email one whose `seasonalRemindersEmail=false`, and will not send anything to a property whose `seasonalOutreach[year:season].optOutThisSeason=true`. No exceptions.
18. **Every property carries a complete customer name.** `property.customerName` is non-blank at create, update, and bulk-import. Validation hard-rejects blank patches with `code: MISSING_NAME`. Backfilled before outreach v1 ships, enforced at every write boundary going forward. The OG preview card "Hey {firstName}, …" depends on this invariant. No exceptions.
19. **Service / Inspection Report PDFs contain no pricing.** Quote and invoice are the financial artifacts; the report is the service-narrative artifact. The renderer (`server/lib/wo-report-pdf.js`) embeds no dollar figures, no line-item costs, and no priced dispositions. Issue dispositions render as words (`Repaired on this visit` / `Deferred to next visit` / `Customer declined`), never as priced lines. Service Report brief, 2026-05-19.

---

## 11. Handoff Instructions for Claude Code

When using this document as a build spec:

1. **Read this entire file before writing any code.** The reasoning behind decisions matters as much as the decisions themselves.

2. **Build foundations first.** Reference data (`pricing.json`, `parts.json`, settings) before any folder schema. Folder schemas before transaction flow. Transaction flow before UI.

3. **Don't skip the matching rules.** They're the most important defense against duplicate-folder drift.

4. **When in doubt, refuse to bolt.** If a request can't fit cleanly into this design, either revise the design (with reasoning documented) or push back on the request.

5. **Pick the first slice carefully.** See 9.7. A working vertical slice proves the architecture. A horizontal sprawl proves nothing.

6. **Preserve this document.** Add to it as decisions are made. Treat it as living spec, not a frozen artifact.

---

*End of spec. The raw conversation that generated this design lives separately in `WHITEBOARD_CONVERSATION.md` and contains the reasoning, examples, and pushback that shaped each decision.*

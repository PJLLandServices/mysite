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
- **`parts`** — the catalog. Keyed by SKU. Includes name, category, subcategory, size, price.
- **`service_materials`** — keyed by service ID matching `pricing.json`. Each entry has `default_parts: [{sku, quantity, note?}]`.

**Hard rules:**
- Empty `default_parts` array = "service has no default packing list, tech adds materials on-site." Valid.
- Tech can edit the materials checklist on-site.
- Future hook: per-part `unit_of_use` and `units_per_purchase` for cost tracking. Decision deferred.

**Status:** Catalog complete. ~50% of service mappings done. Repairs and controllers mapped. Seasonal services and new install zones intentionally left empty for a future pass. See "Open items" section below.

### 1.3 Settings (notification preferences)

Two layers:
- **Admin defaults** — Patrick's notification preferences (text, email, both, silent) per event type
- **Per-customer overrides** — for VIPs or quiet customers
- **Customer-side preferences** — each customer's own portal preferences (text reminders, email-only, no marketing texts, etc.)

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
    - Billing address (if different from any service address)
    - Customer since (date)
    - How did they find PJL Land Services
    - Status: lead / active / inactive / lost
    - QuickBooks Customer ID (link to QB)

  Communication Records
    - Date, time, source (email / phone / text / chat / in-person), what about, notes

  Internal Notes
    - Free-text notes about this customer

  Notification Preferences
    - Per-event overrides for both admin and customer streams

  >>> PROPERTY FOLDER(S) — one or more attached to this customer
```

**Why customer is separate from property:** A customer is a person. A property is a place. Most customers have one property. Some have a home and a cottage. Some sell a house and the new owner inherits the system documentation. Separating them now prevents painful untangling later.

### 2.2 Property Folder (the place)

```
PROPERTY FOLDER
  Property Information
    - Service address (Apple Maps format for one-tap calendar directions)
    - Spring opening cost / Fall closing cost for this property
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

---

## 4. Transaction Flow (the chain of work)

```
LEAD ──→ QUOTE ──→ BOOKING ──→ WORK ORDER ──→ SERVICE RECORD ──→ INVOICE
```

Every box knows its parent and its child. No orphans.

### 4.1 Quote Folder

**Two flavours:**

**A. AI Repair Quote** — generated in chat from `pricing.json`, for locked-rate work. Lightweight acceptance: customer says "yes send a tech" → booking created → tech confirms scope on-site → signed work order is the binding moment.

**B. Formal Quote** — for installs, retrofits, renovations. Polished branded PDF (matches QuickBooks format) + SMS with portal link. Customer accepts in portal with signature pad. Signature + IP + timestamp + user agent logged for legal trail.

**Routing logic — when does AI quote vs. capture lead:**

- If work is on the locked-rate list in `pricing.json` → AI generates `ai_repair_quote`
- If work is custom (install, retrofit, 8+ zone install, mainline, drip retrofit, lighting, anything off-list) → AI captures lead, notifies Patrick, does NOT quote
- If unsure → default to lead capture

**Quote folder structure:**

```
QUOTE FOLDER
  Quote Identity
    - Quote number (Q-2026-0142, with versioning -v2 if revised)
    - Date created
    - Status: draft / sent / accepted / declined / expired / superseded / cancelled
    - Type: ai_repair_quote / formal_quote
    - Created by: AI chat / Patrick / system

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

  AI Intake Guarantee Flag
    - applies: yes/no
    - quoted_scope (specific repair description)
    - rule: labour locked for diagnosed scope regardless of time on-site
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
    - For formal_quote: branded PDF + email + SMS + portal page

  Internal Notes
  Audit / History (all status changes logged forever)
```

**Hard rules:**
- Quotes are versioned, not edited. Once sent, cannot be changed — revisions create -v2.
- Acceptance triggers: status flips, booking auto-created, Patrick notified, customer confirmed, competing drafts closed.
- Default 30-day expiry. 7-day-out reminder. Auto-expire on day 30.
- AI Intake Guarantee preserved on resulting WO so techs honor locked labour.

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

**Spec deferred for detailed pass.** Touched on but not formally designed.

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

#### 4.3.2 Work Order Structure

```
WORK ORDER FOLDER
  Identity
    - WO number (WO-2026-0317; follow-ups: -followup-001, -002...)
    - Service type, property maturity, service mode
    - Status: scheduled / dispatched / en_route / on_site / 
              in_progress / completed / cancelled / no_show
    - Created from: booking link (REQUIRED — every WO has one)

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

  Property Updates Captured (auto-tracked)
    - Which zones had description/type/coverage changes
    - Photos updated
    - New zones discovered (flagged for Patrick review)
    - Controller info updates

  Customer Sign-Off (legally binding moment)
    - Customer name (printed)
    - Signature drawn on tablet/phone
    - Date + time, IP, device info
    - "I authorize the work described above"
    - Optional satisfaction check

  Follow-Up WO Trigger
    - Tech taps "Schedule follow-up" instead of "Authorize now"
    - Creates linked WO with materials list pre-loaded
    - Customer signs for follow-up scope
    - Original WO closes for today's work; follow-up scheduled

  Payment & Billing
    - Final total (subtotal + HST)
    - Payment captured on-site? (yes/no)
    - QuickBooks invoice ID (auto-populated)

  Audit / History (all status changes logged)
```

#### 4.3.3 Behavioural rules for work orders

1. **Every WO has exactly one booking parent.** No orphans.
2. **Property info is pulled FRESH at WO open.** WO doesn't store its own copy — it links. Photos taken on the WO are stored on the WO and optionally promoted to property folder.
3. **Status transitions are forward-only.** Skips allowed, reverses not.
4. **Scope changes require fresh signature.** Original signature is for original scope only.
5. **Signed WO is the contract.** Once signed, locked. Post-sign edits create audit log entries.
6. **AI Intake Guarantee is enforced.** If WO carries the flag, tech sees a banner: "Labour locked for [scope]. Do not bill additional labour."
7. **Cancellations and no-shows are terminal states** with logged reasons.
8. **Fall closings cannot auto-quote.** Hard rule. Issues → deferred items only.
9. **Emergency overrides on fall closings notify Patrick immediately.**
10. **Voice-to-text on every text field** (tech speed).
11. **Camera shortcuts in every photo field.**
12. **Offline mode mandatory.** Captured locally, synced when service returns.
13. **Auto-save every change.** Resume where left off.
14. **Walk-out checklist** before "Complete": signature captured? all zones marked? next-visit flags?

#### 4.3.4 Completion cascade

When tech taps "Complete":
- Status → completed
- Service record created on property
- Photos optionally promoted to property folder
- Property updates (zone descriptions, new zones, etc.) committed
- Customer notified with summary
- Patrick notified
- QuickBooks invoice generated (drafted)
- Customer portal updated to show completed work
- Warranty clock starts (1 year repairs / 3 years installs)

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
5. Customer portal shows open recommendations with photos and estimated costs. Pre-authorization is binding.
6. Pre-authorized items load into next spring's WO as "✓ Already authorized."

---

## 6. Customer Portal

### 6.1 What customers can do

- View their customer + property folders (read-only for most fields)
- **Edit:** phone, email, best time to reach, notification preferences
- View service history at their property
- View open recommendations (deferred issues) with photos and estimated costs
- **Pre-authorize** deferred recommendations with binding e-signature
- Accept / decline formal quotes with signature pad
- View upcoming bookings

### 6.2 What customers cannot do

- Edit address, system info, zones, photos (read-only — those come from work orders)
- Delete records
- Change billing info (handled in QuickBooks)

### 6.3 Notification preferences (per customer)

- Text reminders (yes/no)
- Email-only mode
- No marketing texts
- Override Patrick's defaults for this customer

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
4. **Installs / retrofits:** AI does NOT quote. Captures lead, hands to Patrick.
5. **AI Intake Guarantee:** When AI quotes a repair from price list, labour is locked for that scope on the resulting WO.
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
5. **Don't bolt new features onto old structures.** Refactor to fit this design or revise the design.
6. **Every WO has exactly one booking parent.** No orphans.
7. **Fall closings never auto-quote on-site.** Find-only mode. Issues → deferred only.
8. **AI never invents prices.** `pricing.json` or it's a lead.
9. **Quotes are versioned, not edited.** Once sent, revisions create new versions.
10. **Customer/property separation is permanent.** Don't conflate them, ever.
11. **Signed work order is the contract.** Locked once signed. Post-sign edits create audit entries.
12. **Scope changes require fresh signature.** Original signature is for original scope only.
13. **Emergency fall overrides notify Patrick immediately.** Real-time, not nightly review.
14. **Customer portal can only edit non-structural fields.** Phone, email, best time, prefs. Nothing else.
15. **Three-year deferred flag forces a decision.** No infinite carry-forward.

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

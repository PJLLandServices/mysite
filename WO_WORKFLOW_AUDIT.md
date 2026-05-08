# Work Order Workflow Audit

**Audit type:** Full-system (Mode 1)
**Scope:** Every aspect of the WO lifecycle across the four service modes the spec describes — Spring Opening, Fall Closing, Service Calls / Repairs, New Installs / Retrofits.
**Author:** Claude (read-only audit pass)
**Date:** 2026-05-07
**Status:** Diagnosis complete, no code changed.

---

## 1. Executive Summary

1. **The smoking gun is real.** The desktop editor at [/admin/work-order/:id](server/work-order.html) does **not** render `wo.onSiteQuote.builderLineItems` — there is no "Issues → Draft Quote" UI on desktop, no `+ Add line item`, no totals block, no signature canvas for the on-site quote. Patrick can edit the zone-level *issues*, but cannot view or edit *priced line items* from the desktop. The full builder lives only in the tech mode at [/admin/work-order/:id/tech](server/work-order-tech.html). [server/work-order.html:155-298](server/work-order.html), [server/work-order.js:880-889](server/work-order.js), [server/work-order-tech.html:191-271](server/work-order-tech.html).
2. **The on-site-pricing flow itself works in tech mode.** [issue-rollup.js](server/lib/issue-rollup.js), the dispatcher's five `/on-site-quote/*` routes, the per-issue defer endpoint, the `carry-forward/<deferredId>` PATCH, and the emergency override endpoint are all wired end-to-end. A field tech *can* add a $68 head-replacement line and capture a customer signature today — provided they open tech mode and the WO is not `fall_closing`.
3. **The spec's "service mode" vocabulary is not a first-class concept in the code.** Spec §4.3.1 names `find_and_fix` / `find_only` / `fix_only` / `build`. The implementation has only three WO templates (`spring_opening` / `fall_closing` / `service_visit`) and no `build` template at all. New-install / retrofit work falls back to `service_visit`. The hard rule "fall closings never auto-quote" is enforced via `wo.type === "fall_closing"` rather than a `serviceMode` field — functionally correct in practice but conceptually drifted from the spec.
4. **Hard-rule §10 r11 (signed WO is locked) is enforced inconsistently.** Every `/on-site-quote/*` endpoint checks `wo.locked || wo.signature?.signed` and returns 409 [server/server.js:5167-5169, 5210-5212, 5280-5282, 5482-5484](server/server.js). The generic `PATCH /api/work-orders/:id` route silently drops re-signature attempts but happily accepts post-sign edits to zones/status/notes/materialsPacked with no audit log entry [server/server.js:4857-5006](server/server.js), [server/lib/work-orders.js:454-548](server/lib/work-orders.js).
5. **Carry-forward + Pre-Authorized Items + Emergency Override + Payment block are tech-mode only.** Patrick reviewing a WO from the office cannot resolve carry-forward items, see pre-auth records, trigger an emergency override, or see the running total. Spec §4.3.2 implies surface-agnostic behaviour.
6. **Offline mode does not cover the line-item builder.** Only the generic `PATCH /api/work-orders/:id` is wrapped in `PJLOffline.queuedFetch`. Builder edits, accept-signature, send-for-approval, defer, and emergency override all hit the network directly and fail offline by design [server/work-order-tech.js:3332-3361](server/work-order-tech.js).
7. **AI-Correct-Diagnosis Bonus is half-built.** Banner shows on both surfaces, but neither has a "diagnosis matched / didn't match" button. The bonus credit (1 free hour) never auto-applies as a $-95 line item.
8. **`techPropertyUpdatesSection` is dead UI.** The HTML element exists in tech mode but no JS populates it — `renderPropertyUpdates()` does not exist [server/work-order-tech.html:356-360](server/work-order-tech.html), [server/work-order-tech.js](server/work-order-tech.js) (no matching grep hit).

**Severity counts**

- 5 critical (P0)
- 9 high (P1)
- 8 medium (P2)
- 13 enhancements (P3)

**"Does the on-site pricing flow work today?"** Yes, on tech mode, on `spring_opening` and `service_visit` WOs. No, on the desktop editor at all, and no, on `fall_closing` (correctly disabled). The flow exists end-to-end on the back end; the missing pieces are surface parity, lock enforcement on the generic PATCH, and conceptual coverage of `fix_only` / `build` modes.

---

## 2. Service Mode Behaviour Matrix

### Spec → code mapping

| Spec service mode | WO `type` value | `canBuildOnSiteQuote()` | Issues→Quote builder | Defer-only | Carry-forward banner | Has install scaffold |
|---|---|---|---|---|---|---|
| `find_and_fix` | `spring_opening` | true | ✓ | ✓ (per-issue) | ✓ | scaffolds zones |
| `find_and_fix` | `service_visit` | true | ✓ | ✓ (per-issue) | ✗ | one "General service area" zone |
| `find_only` | `fall_closing` | **false** | ✗ (correct) | ✓ (bulk + per-issue) | ✗ | scaffolds zones |
| `fix_only` | (none) | n/a | n/a | n/a | n/a | n/a |
| `build` | (none) | n/a | n/a | n/a | n/a | n/a |

**`fix_only` and `build` have no first-class representation** ([server/lib/work-orders.js:44-48](server/lib/work-orders.js)).

### Per-mode capability matrix

Legend: ✓ implemented · ✗ missing · ⚠ partial · n/a not applicable to this mode

| Capability | Spec ref | Spring Opening (`find_and_fix`) | Service Visit (`find_and_fix` / `fix_only`) | Fall Closing (`find_only`) | New Install (`build`) |
|---|---|---|---|---|---|
| Cheat Sheet renders first | §4.3.2 | ✓ tech, ✓ desktop ([work-order.html:112-153](server/work-order.html), [work-order-tech.html:63-103](server/work-order-tech.html)) | ✓ both | ✓ both | n/a (no `build` template) |
| Carry-forward banner auto-loads from property | §4.3.2 / §5 | ✓ tech only ([work-order-tech.js:2441-2469](server/work-order-tech.js)) — desktop has no equivalent | n/a (banner gated on `state.type === "spring_opening"` [work-order-tech.js:2446](server/work-order-tech.js)) | n/a (gated to spring) | n/a |
| Pre-Authorized Items section (separate from carry-forward) | §4.3.2 | ⚠ collapsed into a "✓ Pre-authorized" pill on the carry-forward card ([work-order-tech.js:2481-2482](server/work-order-tech.js)). No standalone section. | ✗ | ✗ | n/a |
| Zone-by-zone walk-through (number, location, sprinkler, coverage, checks, issues, notes, photo) | §4.3.2 | ✓ tech sheet ([work-order-tech.js:702-738](server/work-order-tech.js)), ✓ desktop rows ([work-order.js:459-526](server/work-order.js)) | ✓ both | ✓ both | n/a |
| Service-specific checklist | §4.3.2 | ✓ both ([work-orders.js:91-109](server/lib/work-orders.js)) | n/a (`SERVICE_CHECKLISTS.service_visit = []`) | ✓ both | n/a |
| Materials checklist auto-from `parts.json` `service_materials` | §4.3.2 | ⚠ tech-mode only AND only on follow-up WOs ([work-order-tech.js:3149-3156](server/work-order-tech.js)). Desktop has the *Material List* embed which is a separate concept. Original visit's checklist is missing. | ⚠ same gating | ⚠ same gating | n/a |
| Materials editable on-site | §4.3.2 | ⚠ via parts-bringback section ([work-order-tech.html:370-393](server/work-order-tech.html)) — works for any WO but the row UI shows "parts to bring back to truck" framing, not "materials packed for this visit." Persists to `wo.materialsPacked` and `wo.customParts`. | ⚠ same | ⚠ same | n/a |
| **Issues → Draft Quote aggregator** | **§4.3.2** | **✓ tech ([work-order-tech.js:1734-1797](server/work-order-tech.js)), ✗ desktop** | **✓ tech, ✗ desktop** | **n/a (defer-only by hard rule)** | **n/a** |
| Add line item manually | §4.3.2 | ✓ tech `+ Add custom line` ([work-order-tech.html:216](server/work-order-tech.html), [work-order-tech.js:2066-2081](server/work-order-tech.js)) | ✓ tech only | n/a | n/a |
| "Authorize now" enabled in `find_and_fix` | §4.3.1 | ✓ — the `Show to customer →` button is the spec's "Authorize now" ([work-order-tech.html:218-220](server/work-order-tech.html)) | ✓ same | n/a (correctly hidden — defer-state shown instead) | n/a |
| "Authorize now" disabled in `find_only` | §4.3.1 hard rule | ✓ — `canBuildOnSiteQuote` returns false for `fall_closing` ([work-orders.js:272-274](server/lib/work-orders.js)) AND `renderOnSiteQuote()` swaps to defer state ([work-order-tech.js:1763-1767](server/work-order-tech.js)) | n/a | ✓ enforced | n/a |
| "Add to deferred recommendations" | §4.3.1 | ✓ per-issue defer button ([work-order-tech.html:793](server/work-order-tech.html), [server.js:5577-5618](server/server.js)). Spring carry-forward "Customer declined" routes to the same property deferred queue ([server.js:5843-5851](server/server.js)). | ✓ same | ✓ bulk button + per-issue ([work-order-tech.html:265-269](server/work-order-tech.html), [server.js:5746-5772](server/server.js)) | n/a |
| Emergency Repair Override (find_only only) | §4.3.2 | n/a | n/a | ✓ tech-only modal ([work-order-tech.html:509-535](server/work-order-tech.html), [server.js:5625-5739](server/server.js)). Hard-gated on `wo.type === "fall_closing"`. ✗ desktop | n/a |
| Arrival/departure auto-stamping | §4.3.2 | ✓ tech ([work-order-tech.js:539-546](server/work-order-tech.js)) — desktop status-change listener does NOT auto-stamp ([work-order.js:1244-1260](server/work-order.js)) | ✓/⚠ same | ✓/⚠ same | n/a |
| Pre-work / in-progress / post-work photo categories | §4.3.2 | ⚠ schema supports `WO_PHOTO_CATEGORIES = ["pre_work", "in_progress", "post_work", "issue", "general"]` ([work-orders.js:83](server/lib/work-orders.js)). UI uploads everything as `category: "general"` ([work-order.js:1106](server/work-order.js)) — categorization not exposed. | ⚠ same | ⚠ same | n/a |
| Photos promotable to property folder | §4.3.2 | ⚠ cascade has `promotedPhotoIds: []` slot ([completion-cascade.js comment block](server/lib/completion-cascade.js), [properties.js:272](server/lib/properties.js)) but no actual promotion runs in `cascade.run()`. Field stays empty. | ⚠ same | ⚠ same | n/a |
| Scope Changes On-Site (separate signature) | §4.3.2 / §10 r12 | ⚠ `on_site_quote` Quote record carries its own signature, separate from `wo.signature` ([quotes.js:401-438](server/lib/quotes.js)). However, **post-sign scope additions** (after the WO has been signed) don't have a fresh-signature flow — the on-site-quote endpoints all reject with 409 once `wo.locked === true`. So a tech who finds *more* work after the customer signed has no path other than spawning a follow-up WO. | ⚠ same | n/a | n/a |
| Property updates captured (zones/controller/etc) | §4.3.2 | ⚠ data captured (zone edits flow into `cascade.systemUpdatesFromWo()` [completion-cascade.js:71-83](server/lib/completion-cascade.js), `properties.applySystemUpdates()` [properties.js:294-326](server/lib/properties.js)). UI surface `techPropertyUpdatesSection` exists but has no renderer ([work-order-tech.html:356-360](server/work-order-tech.html), no matching JS). Tech doesn't see what's about to flow. | ⚠ same | ⚠ same | n/a |
| Customer sign-off (printed name + canvas + ack + IP/UA) | §4.3.2 | ✓ both. Desktop ([work-order.html:243-275](server/work-order.html), [work-order.js applyLockState et al.](server/work-order.js)). Tech ([work-order-tech.html:317-350](server/work-order-tech.html)). Server stamps IP+UA on PATCH ([server.js:4886-4894](server/server.js)). | ✓ both | ✓ both | n/a |
| Follow-up WO trigger | §4.3.2 | ✓ both ([work-order-tech.html:400-405](server/work-order-tech.html), [work-order.html:81](server/work-order.html), `crm-followup.js`). | ✓ both | ✓ both (emergency creates a follow-up automatically [server.js:5699-5705](server/server.js)) | n/a |
| Final total + payment-on-site flag | §4.3.2 | ⚠ **tech only** — `techPaymentSection` ([work-order-tech.html:412-425](server/work-order-tech.html), [work-order-tech.js:3237-3251](server/work-order-tech.js)). Yes/No radio is wired but **the value is never persisted** — there's no `wo.paidOnSite` field and no PATCH path. Desktop has nothing. | ⚠ same | ⚠ same | n/a |
| Status forward-only enforcement | §4.3.3 r3 | ✓ server-side ([work-orders.js:471-486](server/lib/work-orders.js)) and client-side ([work-order-tech.js:498-522](server/work-order-tech.js)). | ✓ same | ✓ same | n/a |
| Signed WO locked, post-sign edits create audit log | §4.3.3 r5 / §10 r11 | ⚠ **partial.** On-site-quote endpoints + the per-issue defer / emergency / carry-forward endpoints all 409 if locked. The generic `PATCH /api/work-orders/:id` drops re-signature but accepts other field edits silently with **no audit log** ([server.js:4862-4905](server/server.js), [work-orders.js:454-548](server/lib/work-orders.js)). | ⚠ same | ⚠ same | n/a |
| Property info pulled FRESH at WO open | §4.3.3 r2 | ✓ — the `GET /api/work-orders/:id` route fetches `properties.get(wo.propertyId)` fresh and returns it alongside the WO ([server.js:4778-4854](server/server.js)). Cheat Sheet uses property record, falls back to WO snapshot ([work-order-tech.js:2576-2580](server/work-order-tech.js)). | ✓ same | ✓ same | n/a |
| Every WO has exactly one booking parent | §4.3.3 r1 / §10 r6 | ⚠ **enforced loosely.** Create requires lead OR property, not booking ([work-orders.js:377-379](server/lib/work-orders.js)). Booking back-link happens opportunistically via `bookings.attachWorkOrder()` ([server.js:4741-4746](server/server.js)) but is best-effort. WOs created from `/admin/handoff` flows or directly from a property page may have no booking parent. | ⚠ same | ⚠ same — fall closings spawn follow-up WOs that DO have a parent (the originating fall booking via the lead) | n/a |
| AI-Correct-Diagnosis Bonus eligibility carries through | §4.1 / §8.5 / §4.3.3 r6 | ⚠ flag persists on `wo.intakeGuarantee` and banner shows ([work-order.js:862-878](server/work-order.js), [work-order-tech.html:128-133](server/work-order-tech.html)). **No "match / no match" UI**. Bonus never auto-applies as a -1hr labour line. | ⚠ same | n/a | n/a |
| Completion cascade fires once on `→ completed` | §4.3.4 | ✓ ([server.js:4912-4974](server/server.js), [completion-cascade.js:85-154](server/lib/completion-cascade.js)). Idempotency guard via `properties.findServiceRecordByWo()` ([completion-cascade.js:90-93](server/lib/completion-cascade.js)). Service record + draft invoice + system updates + admin email + customer email + warranty stamp all in one pass. | ✓ same | ✓ same | n/a |

---

## 3. UI Surface Parity Report

`work-order.html` (desktop, Patrick at the office) vs `work-order-tech.html` (tech in the driveway, ServiceWorker-backed offline).

Legend: ✓ implemented · ✗ missing · ⚠ partial

| Behaviour | Desktop | Tech mode | Parity verdict |
|---|---|---|---|
| Cheat sheet (system overview, access, last-service summary) | ✓ ([work-order.html:112-153](server/work-order.html)) | ✓ ([work-order-tech.html:63-103](server/work-order-tech.html)) | match |
| Action chips (call/text/maps) | ✓ | ✓ + Reschedule chip | tech has more |
| AI-Correct-Diagnosis banner | ✓ ([work-order.html:161-166](server/work-order.html)) | ✓ ([work-order-tech.html:128-133](server/work-order-tech.html)) | match |
| Diagnosis-from-intake (read-only) | ✓ ([work-order.html:168-172](server/work-order.html)) | ✓ collapsed ([work-order-tech.html:150-153](server/work-order-tech.html)) | match |
| **Carry-forward banner (spring openings)** | **✗ no UI** | **✓ ([work-order-tech.html:112-119](server/work-order-tech.html), [work-order-tech.js:2441-2469](server/work-order-tech.js))** | **gap — desktop missing** |
| **Pre-Authorized Items section** | **✗** | **⚠ pill on carry-forward card only — no standalone section** | **gap on both** |
| Zone walk-through (status + notes + checks + issues + photos) | ✓ inline rows ([work-order.js:459-526](server/work-order.js)) | ✓ tap-to-open sheet ([work-order-tech.html:460-503](server/work-order-tech.html)) | match in capability |
| `+ Add zone` | ✓ ([work-order.html:191](server/work-order.html)) | ✓ ([work-order-tech.html:163](server/work-order-tech.html)) | match |
| Zone source-picker (zones/valve boxes/controller/issues) | ✓ ([work-order.html:330-346](server/work-order.html)) | ✓ ([work-order-tech.js:1052+](server/work-order-tech.js)) | match |
| Service-specific checklist (Spring/Fall steps) | ✓ ([work-order.html:223-227](server/work-order.html)) | ✓ ([work-order-tech.html:172-175](server/work-order-tech.html)) | match |
| Materials section (parent: "material lists attached to this WO") | ✓ ([work-order.html:177-186](server/work-order.html), [wo-materials.js](server/wo-materials.js)) | ✗ — tech has no equivalent for material lists | **gap — tech missing the Material-List embed** |
| Materials *checklist* (auto from `parts.json` `service_materials`) | ✗ | ⚠ follow-up-only ([work-order-tech.html:184-189](server/work-order-tech.html), [work-order-tech.js:3144-3216](server/work-order-tech.js)) | **gap — neither covers the original visit** |
| Parts to bring back (manual stepper tree) | ✗ | ✓ ([work-order-tech.html:370-393](server/work-order-tech.html), [work-order-tech.js:~3000-3140](server/work-order-tech.js)) | gap — desktop missing |
| Custom parts (free-form, not in catalog) | ✗ | ✓ ([work-order-tech.html:381-392](server/work-order-tech.html)) | gap — desktop missing |
| **Issues → Draft Quote builder (Generate from issues + edit lines + totals)** | **✗ no UI** | **✓ ([work-order-tech.html:191-271](server/work-order-tech.html), [work-order-tech.js:1734-2098](server/work-order-tech.js))** | **smoking-gun gap** |
| **`+ Add custom line` in builder** | **✗** | **✓ ([work-order-tech.html:216](server/work-order-tech.html))** | **gap** |
| **Per-line override price** | **✗** | **✓ ([work-order-tech.js:2036-2042](server/work-order-tech.js))** | **gap** |
| **Customer review state (per-line accept/decline + signature)** | **✗** | **✓ ([work-order-tech.html:223-253](server/work-order-tech.html))** | **gap** |
| **Send to customer for remote approval (email + SMS)** | **✗** | **✓ ([work-order-tech.html:248-252](server/work-order-tech.html), [work-order-tech.js:2178-2226](server/work-order-tech.js))** | **gap** |
| **Customer-facing approval page** | n/a | n/a | both — `/approve/<id>?t=<token>` is its own page ([approve.html](server/approve.html)) |
| Defer-only banner (fall closings) | ✗ | ✓ ([work-order-tech.html:263-270](server/work-order-tech.html)) | gap — desktop missing |
| Per-issue Defer / Emergency buttons | ✗ | ✓ ([work-order-tech.html:792-795](server/work-order-tech.html)) | gap |
| **Emergency override modal** | **✗** | **✓ ([work-order-tech.html:509-535](server/work-order-tech.html))** | **gap — Patrick can't trigger from desktop** |
| Photo gallery + lightbox | ✓ ([work-order.html:200-218](server/work-order.html)) | ✓ ([work-order-tech.html:289-304](server/work-order-tech.html)) | match |
| Photo categories (pre/in/post/issue/general) | ⚠ schema supports it, UI saves `general` only ([work-order.js:1106](server/work-order.js)) | ⚠ same | both partial |
| Save-all photos to phone | ✓ | ✓ | match |
| Tech notes (with voice-input) | ✓ ([work-order.html:233](server/work-order.html)) | ✓ ([work-order-tech.html:309](server/work-order-tech.html)) | match |
| Customer sign-off form (name + canvas + ack + submit) | ✓ ([work-order.html:243-275](server/work-order.html)) | ✓ ([work-order-tech.html:317-350](server/work-order-tech.html)) | match |
| Locked banner (post-sign visual cue) | ✓ ([work-order.html:97-101](server/work-order.html)) | ✓ ([work-order-tech.html:37-40](server/work-order-tech.html)) | match |
| Cascade-recovery actions (`Create draft invoice now`, `Re-run cascade`) | ✓ ([work-order.html:282-292](server/work-order.html)) | ✗ | gap — tech missing |
| **Property updates captured (preview before completion)** | **✗** | **⚠ HTML element exists, no JS renderer** ([work-order-tech.html:356-360](server/work-order-tech.html), no matching JS) | **dead UI on tech, missing on desktop** |
| **Payment & billing (subtotal / HST / total + Yes/No paid-on-site)** | **✗** | **⚠ rendered ([work-order-tech.js:3237-3251](server/work-order-tech.js)) but the Yes/No radio is never persisted** | **gap on both** |
| Follow-up WO trigger | ✓ button in hero ([work-order.html:81](server/work-order.html)) → modal | ✓ button + status display ([work-order-tech.html:400-405](server/work-order-tech.html)) | match in capability |
| Reschedule | ✓ ([work-order.html:80](server/work-order.html)) | ✓ ([work-order-tech.html:77-80](server/work-order-tech.html)) | match |
| Booking activity log (history) | ✓ ([work-order.html:89-92](server/work-order.html)) | ✗ | gap — tech missing |
| Run-status as 4 buttons + sticky finish bar | ✗ (desktop uses dropdown) | ✓ ([work-order-tech.html:142-147, 435-446](server/work-order-tech.html)) | by design — desktop dropdown is acceptable |
| Walk-out checklist gate (signature/zones/carry-forward) | ✗ desktop blindly accepts the dropdown change | ✓ ([work-order-tech.js:528-535, 555-581](server/work-order-tech.js)) | gap — desktop missing |
| Offline mode (ServiceWorker + queue) | n/a (online-only by design) | ⚠ partial ([offline-queue.js](server/offline-queue.js), [tech-sw.js](server/tech-sw.js)) — only generic PATCH queues | tech has it but builder doesn't use it |
| Voice input on text fields | ✓ (notes only) | ✓ (notes + zone notes + issue notes) | tech has more |
| Save-all-photos / lightbox | ✓ | ✓ | match |
| Delete WO | ✓ ([work-order.html:297](server/work-order.html)) | ✗ — tech can't delete | by design |

**Summary: tech mode is the canonical surface; desktop is essentially a read/edit shadow that omits every line-item, carry-forward, emergency-override, payment, and walk-out-gate behaviour.** The split makes operational sense (Patrick reviews, tech executes), but the spec's language treats both surfaces as full-feature.

---

## 4. API Surface Findings

Every WO route documented in `SYSTEM_OVERVIEW.md`, plus the routes the spec implies but the overview doesn't list explicitly.

| Route | Documented | Implementation | Auth | Idempotency | Schema match | Notes |
|---|---|---|---|---|---|---|
| `GET /api/work-orders` | ✓ | ✓ ([server.js:4622-4632](server/server.js)) | admin | n/a | ok | filters `?propertyId`, `?leadId` |
| `GET /api/work-orders/:id` | ✓ | ✓ ([server.js:4774-4855](server/server.js)) | admin | n/a | returns `{ workOrder, property, lead, lastService }` | property pulled fresh, includes self-healing seasonal-fee seed for legacy WOs |
| `POST /api/work-orders` | ✓ | ✓ ([server.js:4638-4772](server/server.js)) | admin | n/a (creates new) | ok | seasonal-fee seed at create, attaches to booking + quote, lead activity entry |
| `PATCH /api/work-orders/:id` | ✓ | ✓ ([server.js:4857-5007](server/server.js)) | admin | best-effort (cascade short-circuits) | partial | **does not refuse edits when `wo.locked === true`** beyond the signature payload |
| `DELETE /api/work-orders/:id` | implicit | ✓ ([server.js:5009-5048](server/server.js)) | admin | n/a | ok | refuses delete when active deferred items reference this WO |
| `POST /api/work-orders/:id/photos` | ✓ | ✓ ([server.js:5056](server/server.js)) | admin | n/a | ok | category defaults to `general` regardless of payload — UI never sends others |
| `DELETE /api/work-orders/:id/photos/:n` | ✓ | ✓ ([server.js:5100](server/server.js)) | admin | ok | ok |  |
| `GET /api/work-orders/:id/photo/:n` | ✓ | ✓ ([server.js:5123](server/server.js)) | admin | n/a | ok |  |
| `POST /api/work-orders/:id/create-invoice` | ✓ | ✓ ([server.js:3667-3700](server/server.js)) | admin | ✓ short-circuits if invoice exists | ok |  |
| `POST /api/work-orders/:id/run-cascade` | ✓ | ✓ ([server.js:3702-3714](server/server.js)) | admin | ✓ via `findServiceRecordByWo` | ok |  |
| `POST /api/work-orders/:id/follow-up` | ✓ | ✓ ([server.js:3425](server/server.js)) | admin | n/a (creates new) | ok | inherits `parentSkus` |
| `POST /api/work-orders/:id/on-site-quote/build` | ✗ undocumented | ✓ ([server.js:5161-5201](server/server.js)) | admin | ⚠ preserves baseline lines on re-run | ok | enforces `canBuildOnSiteQuote` |
| `PATCH /api/work-orders/:id/on-site-quote/builder` | ✗ undocumented | ✓ ([server.js:5203-5271](server/server.js)) | admin | wholesale replace | ok | re-snapshots `originalPrice` from pricing.json |
| `POST /api/work-orders/:id/on-site-quote/accept` | ✗ undocumented | ✓ ([server.js:5273-5474](server/server.js)) | admin | ✓ — already-signed Quote ignored | ok | sinks declined lines to property `deferredIssues` |
| `POST /api/work-orders/:id/on-site-quote/decline-all` | ✗ undocumented | ✓ ([server.js:5476-5538](server/server.js)) | admin | n/a | ok | every line → deferred, no Quote |
| `POST /api/work-orders/:id/on-site-quote/send-for-approval` | ✗ undocumented | ✓ ([server.js:2962-3115](server/server.js)) | admin | ✓ — reuses existing Quote on retry | ok | renders branded HTML email + SMS |
| `POST /api/work-orders/:id/zones/:n/issues/:id/defer` | ✗ undocumented | ✓ ([server.js:5577-5618](server/server.js)) | admin | wholesale (issue removed from zone) | ok | reason auto-detected from WO type |
| `POST /api/work-orders/:id/zones/:n/issues/:id/emergency` | ✗ undocumented | ✓ ([server.js:5625-5739](server/server.js)) | admin | n/a | ok | requires customer signature, gates on `wo.type === "fall_closing"`, pages Patrick |
| `POST /api/work-orders/:id/issues/defer` | ✗ undocumented | ✓ ([server.js:5746-5772](server/server.js)) | admin | n/a (clears all issues) | ok | bulk defer |
| `PATCH /api/work-orders/:id/carry-forward/:deferredId` | ✗ undocumented | ✓ ([server.js:5783-5880](server/server.js)) | admin | varies by action | ok | actions: `repair_now`, `decline`, `already_fixed`, `cannot_locate` |
| `GET /api/approve/:id/:token` | ✓ | ✓ ([server.js:3120-3144](server/server.js)) | public (token) | n/a | ok |  |
| `POST /api/approve/:id/:token/sign` | ✓ | ✓ ([server.js:3148-3211](server/server.js)) | public (token) | ✓ ignores re-sign | ok | flips WO `onSiteQuote.status` on success |

**Observations**

- `SYSTEM_OVERVIEW.md` lists six WO endpoints. There are actually **17** under `/api/work-orders/...` plus the `/api/approve/...` pair. **Doc gap.**
- Schema mismatches between client and server: none observed — every endpoint validates payloads and re-snapshots prices on persist.
- Idempotency: the cascade is the only one with explicit short-circuit semantics. The on-site-quote `accept` endpoint also short-circuits via the Quote's `signature.signed` flag. `decline-all` and `defer` are NOT idempotent — calling them twice would attempt to re-create deferred entries (bulk defer iterates `wo.zones` so on second call it iterates an empty zone list and produces zero entries — accidentally idempotent, but not by design).
- `PATCH /api/work-orders/:id` does not enforce `wo.locked` beyond signature. **Hard rule §10 r11 partial enforcement.**
- `POST /api/work-orders` does not require a `bookingId`. **Hard rule §10 r6 weakly enforced.**

---

## 5. Data Integrity Findings

**Live data not available in this worktree.** `server/data/work-orders.json` is gitignored and lives on Render's persistent disk. This pass therefore checks **schema-level guarantees** rather than spot-checking real records.

### Schema-level guarantees (read from the lib + dispatcher)

- **Orphan WOs:** possible. `workOrders.create()` only requires lead OR property ([work-orders.js:377-379](server/lib/work-orders.js)). Booking back-link is best-effort and only attempted if `lead` is set ([server.js:4741-4746](server/server.js)). A WO created from `/admin/handoff` against just a property (no lead) will have no booking parent.
- **Service record on completed WOs:** guaranteed by `cascade.run()` *if* the WO has `propertyId`. WOs without `propertyId` short-circuit early ([completion-cascade.js:87](server/lib/completion-cascade.js)) — they complete but produce no service record.
- **Draft invoice on completed WOs:** only if the WO has line items ([completion-cascade.js:110](server/lib/completion-cascade.js)). A spring opening with no repairs found completes with a service record but no invoice. The cascade-recovery `Create draft invoice now` button on desktop ([work-order.html:288](server/work-order.html)) lets Patrick force one, but only if `wo.onSiteQuote.builderLineItems` or `wo.lineItems` is non-empty ([server.js:3679-3684](server/server.js)).
- **Line-item price snapshotting:** strong. `acceptedSnapshot` carries `price` (effective post-override) and `lineTotal` directly on the line ([server.js:5319-5327, 2988-2992](server/server.js)). Quote record stores them. Invoice draft stores them again ([invoices.js:153-166](server/lib/invoices.js)).
- **Signature record completeness:** name + image + IP + UA + timestamp all populated by the server ([server.js:4886-4894 generic, 5332-5337 on-site-quote](server/server.js), [quotes.js:401-438](server/lib/quotes.js)).
- **Find_only WOs with line items:** possible only via the seasonal-fee seed at WO create ([server.js:4691-4729, 4794-4831 self-heal](server/server.js)). Those are *baseline* lines (the fall-closing fee itself), tagged `source.baseline: true`. They are not "issues turned into line items" — those would require `canBuildOnSiteQuote()` which fall_closing fails. Hard rule §10 r7 holds in practice.
- **`find_and_fix` WOs that complete with no line items:** possible. Spring openings where nothing is found legitimately complete with only the seasonal-fee baseline line. The cascade does run, the service record records "Spring opening — N zones checked", and an invoice is drafted for just the seasonal fee. This matches expectations.

### Cascade idempotency verdict

✓ **Idempotent.** The `findServiceRecordByWo()` short-circuit ([completion-cascade.js:90-93](server/lib/completion-cascade.js)) means re-running on an already-completed WO returns the existing service record + invoice without duplicating either. Notifications also don't re-fire because the cascade returns `alreadyRan: true` before reaching `deps.notifyAdmin`/`deps.notifyCustomer` calls. Re-firing is safe.

⚠ **One gap:** if the cascade is invoked the first time WITHOUT line items (because the tech marked completed before building the quote — yes, the walk-out checklist tries to prevent this but the desktop has no checklist), the service record gets created with `invoiceId: null`. On a subsequent `Re-run completion cascade` tap, the existing service record short-circuits the cascade — but no invoice will be created from the now-populated line items. The tech / Patrick must use the explicit `Create draft invoice now` button instead. This works but is an unintuitive split.

---

## 6. Integration Boundary Findings

| Edge | Spec direction | Code direction | Gap | Evidence |
|---|---|---|---|---|
| Property → WO (read fresh on open) | required | ✓ ([server.js:4779-4781](server/server.js)) | none | |
| WO → Property (system updates flow on completion) | required | ✓ ([completion-cascade.js:101-106](server/lib/completion-cascade.js), [properties.js:294-326](server/lib/properties.js)) — but only first-time fields, never overwrites populated values | ⚠ `applySystemUpdates` is *additive only* — if a tech corrects a wrong sprinkler-type list, the property keeps the old one. |
| WO → Property (deferred items created on decline) | required (§5) | ✓ ([server.js:5341-5394 on-site decline, 5577-5618 per-issue defer](server/server.js)) | none |
| Property → WO (carry-forward auto-load) | required | ⚠ tech mode only — desktop has no banner ([work-order-tech.js:2441-2469](server/work-order-tech.js)) | gap |
| Property → WO (deferred items resolved on completion) | required | ✓ ([server.js:4983-5001](server/server.js)) — sweep on sign-off flips `in_progress` → `resolved` | none |
| Booking → WO (every WO has a booking parent) | hard rule §10 r6 | ⚠ best-effort attach in create flow ([server.js:4741-4746](server/server.js)). Workflow surfaces don't *require* a booking. | gap |
| WO → Booking (booking knows its WOs) | spec §4.2 | ✓ via `bookings.attachWorkOrder()` | none |
| Booking cancel → WO ?  | spec implicit (cancellation is terminal §4.3.3 r7) | ⚠ no explicit code path. Cancelling a booking does not auto-cancel the WO. | gap |
| Quote → WO (AI repair quote → booking → WO inherits bonus eligibility) | spec §4.1 / §8.5 | ✓ ([work-orders.js:441-447 create-time inheritance](server/lib/work-orders.js), [server.js:4670-4678](server/server.js)) | none |
| WO → Quote (`on_site_quote` flavour created on accept) | spec §4.1 / §10 r9 | ✓ ([server.js:5414-5446](server/server.js), [quotes.js:43, 401-438](server/lib/quotes.js)) | none |
| Quote → Property (deferred items linked to original quote on portal pre-auth) | spec §5 / §6 | ⚠ portal pre-auth flows go through `properties.updateDeferredIssue()` with a `preAuthorization` object — but no Quote record is generated for the pre-auth itself. The pre-auth is "non-binding" per the lib comment ([properties.js:160-166](server/lib/properties.js)). Spec §5.5 says "binding" — semantic conflict between spec and lib. | gap (semantic) |
| Invoice ← WO (cascade drafts) | spec §4.3.4 | ✓ ([completion-cascade.js:108-124](server/lib/completion-cascade.js)) | none |
| Material List → WO (attach as parent) | spec §4.3.2 (Materials) | ✓ desktop ([wo-materials.js](server/wo-materials.js)) | tech missing |
| Material List → WO (auto-derived from `parts.json` `service_materials`) | spec §4.3.2 | ⚠ tech follow-up only ([work-order-tech.js:3144-3216](server/work-order-tech.js)) | gap on original visit |
| Project ↔ WO (project can attach/detach WOs) | overview API list | ✓ ([server.js attach/detach project routes](server/server.js)) | none |
| Customer portal ↔ WO (pre-auth lands in next WO; completed WOs surface in service history) | spec §6 | ⚠ pre-auth shows on carry-forward card pill (tech-only), service history uses `property.serviceRecords` (created by cascade) | partial |
| AI repair quote → WO (entire chat transcript becomes Source per spec §4.1) | required | ⚠ Source has fields `chatSessionId`, `pageUrl`, `userAgent` ([quotes.js:124-128](server/lib/quotes.js)). Transcript pointer not enforced — `chatSessionId` is nullable. | partial |

---

## 7. Hard Rule Enforcement Findings

`PJL_OPERATIONS_DESIGN.md` §10 + the additional rules in `SYSTEM_OVERVIEW.md`.

| Rule | Where enforced | Bypassable? | Evidence |
|---|---|---|---|
| 1. One source of truth | `pricing.json` is the only place prices live. AI uses it; quotes snapshot from it; invoices recompute from line items; service-call logic in `issue-rollup.js` reads it. | partial — see rule 8 | |
| 2. Quotes snapshot prices at creation | ✓ — `quotes.create()` writes `lineItems` with `price` baked in ([quotes.js:131-135](server/lib/quotes.js)). Invoice draft re-snapshots ([invoices.js:153-166](server/lib/invoices.js)). | no | |
| 3. WOs pull property info fresh | ✓ — `GET /api/work-orders/:id` resolves the linked property at request time ([server.js:4781](server/server.js)). | no | |
| 4. All status changes logged forever | ⚠ Quotes have `history[]` ([quotes.js:198-200](server/lib/quotes.js)). Invoices have `history[]` ([invoices.js:213-217](server/lib/invoices.js)). **WOs do NOT** — `wo.history` is not on the schema. Status changes leave only `updatedAt`. | yes — WO audit trail is missing | [work-orders.js:148-241](server/lib/work-orders.js) |
| 5. Don't bolt new features onto old structures | ✓ in spirit — `onSiteQuote.builderLineItems` lives inside the WO; `intakeGuarantee` similarly. The `additionalRepairs[]` and `lineItems[]` placeholders ([work-orders.js:165-166](server/lib/work-orders.js)) are vestigial — the new system uses `onSiteQuote.builderLineItems` and the cascade reads either ([completion-cascade.js:59-65](server/lib/completion-cascade.js)). Two fields where one would do. | partial | |
| 6. Every WO has exactly one booking parent | ⚠ best-effort (see Pass 5) | yes | [server.js:4741-4746](server/server.js) |
| 7. Fall closings never auto-quote | ✓ ([work-orders.js:272-274](server/lib/work-orders.js)) at every on-site-quote endpoint | partial — generic PATCH does not check, but seasonal seed line (`source.baseline`) is the *only* line that lands on a fall WO. UI hides the builder for `fall_closing` | |
| 8. AI never invents prices | ✓ — `validateQuotePayload()` rejects unknown keys ([quotes.js:227-294](server/lib/quotes.js)). Worker prompt is rebuilt from pricing.json + parts.json. | no via AI; admins can put custom-price lines via builder `+ Add custom line` (which is the right escape hatch) | |
| 9. Quotes versioned, not edited | ⚠ schema supports `supersedesId` ([quotes.js:110](server/lib/quotes.js)) but **no code emits a -v2**. There is no PATCH route that creates a successor. In practice, edits to a sent quote are not possible (the only Quote-mutating endpoints are `accept`, `decline`, `expire`, `markSentForApproval`, `attachWorkOrder`). | no — but no path to revise a quote either | |
| 10. Customer/property separation permanent | ✓ — Property records carry `customerEmail`+`customerName`+`customerPhone` *as a snapshot* ([properties.js:128-133](server/lib/properties.js)). Customer-folder is implicitly the lead. | no | |
| 11. Signed WO is the contract; locked once signed; post-sign edits create audit log entries | ⚠ **partial.** On-site-quote endpoints all 409 if locked. Generic `PATCH /api/work-orders/:id` allows any non-signature edit on a locked WO with no audit. | yes | [server.js:4869-4898](server/server.js), [work-orders.js:454-548](server/lib/work-orders.js) |
| 12. Scope changes require fresh signature | ⚠ post-sign scope adds are blocked entirely (409 from on-site-quote endpoints when locked). The "fresh signature" path the spec describes ("SEPARATE customer signature for additional scope") doesn't exist — Patrick / tech must spawn a follow-up WO instead. | n/a — the rule's enforced by refusal, not by a parallel signature path | [server.js:5210-5212](server/server.js) |
| 13. Emergency overrides notify Patrick immediately | ✓ ([server.js:5713-5728](server/server.js)) — admin email + SMS fired immediately on emergency POST | no | |
| 14. Customer portal can only edit non-structural fields | ✓ ([server.js:3735-3791](server/server.js)) — only phone/email/best-time/notification-prefs editable | no | |
| 15. Three-year deferred flag forces a decision | ⚠ visual only — `tech-cf-pill--repeat` shows `Nx declined` if `reDeferralCount >= 3` ([work-order-tech.js:2483-2484](server/work-order-tech.js)), but no enforcement: tech can still decline a 3rd-year-old deferred item with no special action. | yes | |

### Additional rules from `SYSTEM_OVERVIEW.md`

- **Backflow not in any WO checklist:** ✓ explicitly excluded with a comment ([work-orders.js:91-94](server/lib/work-orders.js))
- **HDPE poly pipe terminology, no PVC:** ✓ — `ZONE_ISSUE_SUBTYPE_OPTIONS.pipe` uses "HDPE poly" labels ([work-order-tech.js:99-104](server/work-order-tech.js))
- **Pricing always from `pricing.json`:** ✓ — every priced flow imports the live `PRICING` global; `+ Add custom line` is the only escape hatch and properly tags `custom: true`
- **Hero nav clearance:** n/a (admin pages, not public hero)

---

## 8. Deep-Dive Question Answers

### 1. Smoking gun — adding a $68 head replacement on a Spring Opening

**Tech mode (works today):**
1. Tech opens `/admin/work-order/<id>/tech`.
2. Tech sees the carry-forward banner (if any) and the run-status buttons.
3. Tech taps a zone tile → bottom sheet opens.
4. Tech sets zone status to `repair_required`, taps `+ Add issue`, picks `Sprinkler head` from the type dropdown, picks a head model (Hunter PGP 4"…) from the cascading subtype dropdown, sets qty to 1, optionally adds notes/photo, taps `Done`.
5. Tech scrolls down to the `Build draft quote` section (which auto-appeared because at least one zone has at least one issue).
6. Tech taps `Generate from issues` — server runs `issueRollup.rollupIssuesToLineItems()` and the builder fills with the seasonal-fee baseline + a `Hunter PGP (4")` line at $68.
7. Tech can edit qty/price/label per line, add custom lines, remove lines.
8. Tech taps `Show to customer →`.
9. Customer review state appears: per-line accept-checkboxes, totals showing accepted-only, name field, signature canvas, ack checkbox.
10. Customer signs, taps `Sign & accept`. Server creates `Q-YYYY-NNNN` of type `on_site_quote`, marks it accepted with signature, sinks declined lines to the property's `deferredIssues`, flips `wo.onSiteQuote.status` to `accepted`/`partially_accepted`/`declined`.
11. Tech proceeds with the work, then taps the sticky `Mark visit completed` button → cascade fires → service record + draft invoice appear.

**Desktop (broken):** the tech can edit zone issues but there is no UI past that. Patrick can mark issues but cannot generate, edit, or sign line items from the desktop. The follow-up button reads `builderLineItems` to pre-fill the modal but never displays them otherwise.

**Missing pieces (desktop):** [work-order.html](server/work-order.html) needs a port of `tech-on-site-quote` — builder + review + submitted + (find_only) defer states. The state-machine + endpoints already exist on the server; the desktop just needs a renderer.

### 2. Symmetry check — Service Visit (`fix_only`)

Same workflow as #1, on tech mode. The only differences are:
- No carry-forward banner (gated to spring openings).
- No service-specific checklist (`SERVICE_CHECKLISTS.service_visit = []`).
- No seasonal-fee baseline line — `issue-rollup.js` prepends a $95 `service_call` line instead, unless the WO carries `intakeGuarantee.applies === true` (AI repair quote bonus), in which case service_call is $0 + note.

The workflow IS the same in shape. Should it be? Yes — the spec's `find_and_fix` covers both spring openings and service calls.

### 3. Negative check — Fall Closing (`find_only`)

`canBuildOnSiteQuote()` returns `false`. The tech-mode UI:
- Hides the `Build draft quote` builder.
- Shows the `tech-on-site-defer` panel: "Fall closings don't quote on-site (PJL operations rule 8). Issues found this visit will be saved as deferred recommendations on the property." with a `Save issues to deferred recommendations` button.
- Per-issue, the bottom sheet shows two buttons: `📋 Save to deferred` and `🚨 Emergency override`.

Backend:
- `/on-site-quote/build`, `/on-site-quote/builder`, `/on-site-quote/accept` all 422 with "Fall closings cannot generate on-site quotes (PJL operations rule 8)."
- The seasonal-fee baseline line (`fall_close_4z` etc.) is seeded at create. The cascade picks it up, draft invoices for $90+HST. Correct.

**Hard rule §10 r7 is enforced functionally.** A user cannot bypass it via the tech UI or via the on-site-quote endpoints. They could *technically* call the generic `PATCH /api/work-orders/:id` with a bespoke `onSiteQuote.builderLineItems` payload — that endpoint does not check `canBuildOnSiteQuote`, only locked. **Loophole exists** but is admin-only and not exposed by any UI.

### 4. "Delete one, add one" suspicion — historical line-item editor?

`additionalRepairs[]` and `lineItems[]` arrays still exist on the WO schema as Phase 2/4 placeholders ([work-orders.js:165-166](server/lib/work-orders.js)). They are **not bolt-ons that were removed** — they're empty slots. The cascade's `lineItemsFromWo()` falls back to `wo.lineItems` if `wo.onSiteQuote.builderLineItems` is empty ([completion-cascade.js:59-65](server/lib/completion-cascade.js)) — supporting legacy data, not active code paths.

`git log --all --oneline -- server/work-order.html server/work-order.js` would show whether a desktop builder ever existed. Best read is from the schema and current files: **the desktop builder was never built**. The fields the desktop renders today (zones, issues, photos, signoff, materials embed, cascade actions) are exactly what the original v1 desktop slice contained. The on-site-quote builder was added later, on tech mode only, and the desktop port was deferred.

This is the "we delete one and add another" pattern — but inverted: the spec was extended (issues → priced quote), and the implementation extended only one of two surfaces. Not a removal/regression — an incomplete addition.

### 5. Issue → line item bridge

When the tech marks "broken head" on Zone 3 with qty 2:
1. The bottom sheet's issue-row event handler updates `state.zones[i].issues[j]` (type / subtype / qty / notes) and PATCHes `{ zones }` to `/api/work-orders/:id`.
2. Tech taps `Generate from issues` (UI: `techOnSiteBuildBtn`).
3. Client POSTs `/api/work-orders/:id/on-site-quote/build` (no body).
4. Server reads the WO, preserves any baseline lines (`source.baseline === true`), runs `issueRollup.rollupIssuesToLineItems(wo, PRICING)`.
5. `rollupIssuesToLineItems` walks each zone, calls `rollupZone(pricing, zone)` per zone. For Zone 3 with 2× broken_head/Hunter PGP 4":
   - groups by subtype → bySubtype.get("pgp_4") = [issue1, issue2]
   - sums qty: 2
   - emits one line: `{ key: "head_replacement", label: "Hunter PGP (4\")", qty: 2, originalPrice: 68, source: { zoneNumbers:[3], issueIds:[...] } }`
6. Top-level prepend: since `intakeGuarantee.applies` is false and `wo.type !== "spring_opening"|"fall_closing"` (assume service_visit), prepends a $95 `service_call` line.
7. Server merges `[...existingBaseline, ...rolledLines]`, writes `wo.onSiteQuote.builderLineItems`, returns updated WO.
8. Client renders with totals: subtotal $231 ($95 + $136), HST $30.03, total $261.03.

The chain is **intact**. No broken edges.

### 6. `issue-rollup.js` reality check

Real, exported, used by:
- `/api/work-orders/:id/on-site-quote/build` ([server.js:5181](server/server.js))
- `/api/work-orders/:id/zones/:n/issues/:id/defer` (single-issue snapshot via `rollupSingleIssueToLineItems` [server.js:5556](server/server.js))
- `/api/work-orders/:id/issues/defer` (per-issue snapshots in bulk [server.js:5761](server/server.js))
- `/api/work-orders/:id/zones/:n/issues/:id/emergency` (single-issue snapshot via `deferredPayloadFromIssue` [server.js:5674](server/server.js))
- `/api/work-orders/:id/carry-forward/:deferredId` action `repair_now` (recompute totals after merge [server.js:5839](server/server.js))

API: `rollupIssuesToLineItems(wo, pricing)`, `rollupSingleIssueToLineItems(issue, zoneNumber, pricing, opts)`, `recomputeTotals(lines)`, `effectivePrice(line)`, `totalsFor(lines)`.

Manifold rule: ✓ implemented at `manifoldLineFor()` ([issue-rollup.js:110-129](server/lib/issue-rollup.js)). Tier picks `manifold_3valve` (≤3) or `manifold_6valve` (>3) plus N × `valve_hunter_pgv`.

Controller subtype tier: ✓ partial — `hpc_4 → controller_1_4`, `hpc_8 → controller_8_16` (8 falls in 8-16 bracket per code comment), `hpc_16 → controller_8_16`, `module → custom $0`. Note: spec mentions `controller_5_7` ($750), but the rollup never picks it; an 8-zone replacement uses the $1195 tier conservatively.

`spring_fall_no_service_call`: ✓ implemented at the prepend step ([issue-rollup.js:355-378](server/lib/issue-rollup.js)) — seasonal WOs skip the `service_call` prepend.

`ai_intake_correct_diagnosis_bonus` discount: ⚠ partial — when `intakeGuarantee.applies` is true, `service_call` is prepended at $0 with note "Trip already paid on the AI-quoted visit." However, the spec's full bonus framing also calls for **1 hour of repair labour free** on confirmed match. This is **NOT applied automatically** — neither as a $-95 line nor as a labour-hour adjustment. The diagnosis-match confirmation has no UI button and no server endpoint. Half-built.

### 7. Signature → invoice chain

Customer taps `Sign & accept` in tech mode → `POST /api/work-orders/:id/on-site-quote/accept` with `{ customerName, imageData, acknowledgement, decisions }`.

Server:
1. Validates payload (name + image ≥ 50 chars + ack required).
2. Snapshots `acceptedLines` and `declinedLines` per `decisions[]`.
3. Sinks declined lines to `properties.deferredIssues` per source issue ([server.js:5341-5394](server/server.js)).
4. Calls `quotes.create({ type: "on_site_quote", status: "sent", ... })` → `Q-YYYY-NNNN` record with `lineItems: acceptedLines`, totals snapshotted.
5. Calls `quotes.acceptWithSignature(q.id, { customerName, imageData, decisions, ip, userAgent, partial })` → flips Quote to `accepted` / `partially_accepted`, writes the signature block.
6. Calls `quotes.attachWorkOrder(q.id, wo.id)`.
7. Patches WO: `onSiteQuote.quoteId = quote.id, status = "accepted"|"partially_accepted"|"declined"`.

Persistence:
- **Customer signature lives on the Quote** (`quote.signature`), NOT on the WO. The WO's `wo.signature` is the *post-completion / sign-off-the-WO-overall* signature — fired through the generic PATCH path.
- The WO carries a *pointer* (`wo.onSiteQuote.quoteId`) and a redundant copy of the builder lines for read-only review.

What triggers the cascade: nothing about this. Acceptance flips `onSiteQuote.status`; the **separate** WO sign-off (typed name + canvas in the bottom block of tech-mode, or the desktop's signoff section) is what flips `wo.locked = true`. Status flip to `completed` (typically via the sticky `Mark visit completed` button) is what fires `cascade.run()`.

### 8. Mobile editing safety — offline + price drift

- **Offline-edit replays:** the only PATCH that goes through `PJLOffline.queuedFetch` is `PATCH /api/work-orders/:id` ([work-order-tech.js:3336-3361](server/work-order-tech.js)). Builder edits, customer-accept, send-for-approval, defer, emergency override **all hit the network directly** ([work-order-tech.js:1958-1977 persistBuilderLines, 2131-2172 submit, 2178-2226 send-for-approval](server/work-order-tech.js)). Code comment is explicit: "carry-forward, on-site-quote/build, etc. are non-trivial to replay correctly, so leave them as-is" ([work-order-tech.js:3333-3334](server/work-order-tech.js)).
- **Price-drift snapshot:** strong. `acceptedLines` carry their own `originalPrice` and `overridePrice` at the time of accept ([server.js:5319-5330](server/server.js)). Future `pricing.json` changes do not retroactively alter the Quote or the resulting Invoice (the cascade copies the line items, not the keys). **Hard rule §10 r2 honored.**
- **Snapshot wins on the price re-validation:** the `/builder` PATCH endpoint **re-snapshots `originalPrice` from pricing.json on every save** ([server.js:5237-5239](server/server.js)). So if the tech edits qty offline, then prices change in `pricing.json`, then they reconnect — the replayed PATCH would re-snapshot to the *new* price. **This is wrong if the tech intended the snapshotted price.** But because the builder PATCH is not queued offline, this scenario is impossible in v1. Worth re-examining if offline coverage is extended.

### 9. AI Correct Diagnosis Bonus on the WO

- Banner shows on both surfaces (tech and desktop).
- Banner copy: "Pending Confirmation — Confirm match → credit ONE HOUR of repair labour free on the diagnosed work."
- **There is no button to confirm match.** No "Diagnosis matched" / "Diagnosis didn't match" UI on either surface. No endpoint. No effect on line items.
- The `service_call` zero-price prepend ([issue-rollup.js:357-365](server/lib/issue-rollup.js)) is the only automated effect of `intakeGuarantee.applies === true` — and even that's "trip already paid", not the 1-hour bonus.
- The 1-hour-free credit is purely instructional — the tech reads the banner and is expected to manually edit the on-site quote (or a labour line item, which doesn't exist as a default in the rollup).

This is the **largest functional gap relative to the spec** after the desktop missing builder.

### 10. Customer portal pre-auth round-trip

1. Customer hits `/portal/<token>` ([portal.html](server/portal.html)).
2. Portal lists property `deferredIssues` filtered to status `open` via `/api/portal/:token/deferred` ([server.js:2153-...](server/server.js)).
3. Customer signs on the per-item pre-auth canvas.
4. Client POSTs `/api/portal/:token/deferred/:deferredId/pre-authorize` ([server.js:2224](server/server.js)) with `{ customerName, imageData }`.
5. Server stamps `properties.updateDeferredIssue()` with `{ status: "pre_authorized", preAuthorization: { signedAt, customerName, imageData, ip, userAgent } }`.
6. Next time a `spring_opening` WO opens for the same property, `renderCarryForward()` fetches `/api/properties/:id/deferred?status=open,pre_authorized` ([work-order-tech.js:2455](server/work-order-tech.js)).
7. Cards with status `pre_authorized` get the `tech-cf-pill--preauth` "✓ Pre-authorized" pill.
8. Tech taps `Repair now` on the card → snapshot's `lineItems` are appended to `wo.onSiteQuote.builderLineItems` ([server.js:5818-5829](server/server.js)) with `[carry-forward]` notes.
9. Tech proceeds normally; customer signature for the pre-authorized work was already captured at portal time, but the spec wants a **fresh signature for the on-site work** (rule §4.3.3 r4). That fresh signature is the on-site quote review/accept flow.
10. WO sign-off later flips deferred status `in_progress → resolved` for any item with `resolution.resolvedInWoId === wo.id` ([server.js:4983-5001](server/server.js)).

**Observation:** the spec calls portal pre-authorization "binding" (§5.3.5/§5.5). The lib comment says "NOT a binding contract — the spring WO sign-off is" ([properties.js:160-166](server/lib/properties.js)). **Semantic conflict.** Worth resolving before customer expectations diverge from the legal posture.

---

## 9. Prioritized Remediation Plan

### P0 — Must fix before next paying customer touches a WO

1. **[Smoking gun] Port the on-site quote builder to the desktop editor.** [work-order.html](server/work-order.html) needs the same builder/review/submitted/defer state machine the tech mode has. Reuse the existing endpoints (no new routes). Keep the desktop's existing zone editor. Add: `Generate from issues` button, builder lines list with qty/price/label edits, `+ Add custom line`, totals, `Show to customer →` (or "Email approval link" since desktop usually isn't customer-facing), customer-accept signature canvas. Half a day's work, mostly UI translation. [server/work-order.html:155-298](server/work-order.html), [server/work-order.js:880-889](server/work-order.js).

2. **[Hard rule §10 r11] Enforce locked-WO write protection on the generic PATCH route.** Today, `PATCH /api/work-orders/:id` accepts edits to zones/status/notes/materialsPacked on a locked WO with no audit log. Add a `wo.locked` check at [server.js:4861](server/server.js) that either 409s or accepts and appends to a new `wo.history[]` (creating that audit-log array if needed). Mirrors the on-site-quote endpoints. [server/server.js:4857-4905](server/server.js), [server/lib/work-orders.js:454-548](server/lib/work-orders.js).

3. **[Hard rule §10 r4] Add `wo.history[]` audit trail.** Quotes and invoices have it; WOs do not. Every status change, signature event, lock flip, and post-sign edit should append `{ ts, by, action, note, oldValue, newValue }`. Without this, the lock-enforcement above has nowhere to log overrides. [server/lib/work-orders.js](server/lib/work-orders.js).

4. **[Spec §4.3.2 / §10 r7 belt-and-suspenders] Enforce `canBuildOnSiteQuote()` on the generic PATCH too.** Currently `PATCH /api/work-orders/:id` will accept any `onSiteQuote.builderLineItems` payload regardless of WO type. Reject the field on `fall_closing`. [server/server.js:4857](server/server.js).

5. **[Cascade gap] If the cascade was first-fired with no line items and then a quote got built, `Re-run completion cascade` should still create the missing invoice.** Currently `findServiceRecordByWo()` short-circuits the entire cascade. Either (a) make the short-circuit more granular (skip service-record creation if it exists, but still create the missing invoice) or (b) document that the user must use `Create draft invoice now` instead. Operationally important since the walk-out checklist exists only on tech-mode and Patrick can flip a desktop WO to `completed` while the builder is empty. [server/lib/completion-cascade.js:90-93](server/lib/completion-cascade.js), [server/server.js:3702-3714](server/server.js).

### P1 — Should fix this week

6. **[Spec §4.3.2] Render `techPropertyUpdatesSection` in tech mode.** The HTML is there; no JS populates it. Add a `renderPropertyUpdates(wo, property)` function that diffs `wo.zones[].location|sprinklerTypes|coverage|notes` against the linked property and lists the deltas. [server/work-order-tech.html:356-360](server/work-order-tech.html).

7. **[Spec §4.3.2] Persist `paidOnSite` from the tech mode payment block.** The Yes/No radio is rendered but never saved. Add `paidOnSite: boolean` to the WO schema + a PATCH path. [server/work-order-tech.html:419-423](server/work-order-tech.html), [server/work-order-tech.js:3237-3251](server/work-order-tech.js).

8. **[Spec §4.3.2] AI-Correct-Diagnosis Bonus confirmation UI.** Banner already shows. Add two buttons under the banner — `Diagnosis matched (apply bonus)` and `Diagnosis didn't match (no bonus)`. On match, append a `-95 / 1 hr` labour credit line to the builder with `key: "ai_diagnosis_bonus"`, label "AI-Correct-Diagnosis Bonus — 1 hr labour credited". Persist `wo.intakeGuarantee.confirmedMatch: bool|null` so the choice locks once the WO signs. [server/work-order-tech.html:128-133](server/work-order-tech.html), [server/work-order.html:161-166](server/work-order.html).

9. **[Hard rule §10 r6] Require `bookingId` on WO create.** `workOrders.create()` accepts `lead || property`. Tighten to require booking, or auto-create a booking from the lead/property at WO-create time (the current code does this best-effort; make it mandatory). [server/lib/work-orders.js:377-379](server/lib/work-orders.js), [server/server.js:4661-4663](server/server.js).

10. **[Spec §4.3.2 / §10 r7] Booking cancel → WO cascade.** Decide and implement: when a booking is cancelled, what happens to its child WO? Options: auto-cancel the WO, or leave it orphaned with a banner. Document the decision in the spec.

11. **[Parity] Carry-forward banner on the desktop editor.** Mirror the tech-mode renderer + action buttons. Same endpoints. [server/work-order-tech.js:2441-2469](server/work-order-tech.js).

12. **[Parity] Emergency override modal on the desktop editor.** Patrick reviewing a fall WO from his desk should be able to trigger an emergency. Same modal, same endpoint. [server/work-order-tech.html:509-535](server/work-order-tech.html), [server/server.js:5625-5739](server/server.js).

13. **[Spec §4.3.2] Materials checklist on the original visit, not just follow-ups.** Today the materials section is gated on `state.followupOfWoId`. Drop the gate; the `parts.json` `service_materials` mapping covers original visits too (head replacements have material lists). The "parts to bring back" section should remain for *additional* parts the tech needs back at the truck. [server/work-order-tech.js:3149-3156](server/work-order-tech.js).

14. **[Doc gap] Update `SYSTEM_OVERVIEW.md` to list the 11 missing WO routes.** See §4 of this audit for the full list.

### P2 — Polish before "v1 done"

15. **Photo categorization.** Schema supports `pre_work / in_progress / post_work / issue / general`; UI saves `general` only. Add a category picker in the photo-add control. [server/work-order.js:1106](server/work-order.js).

16. **Photo promotion to property folder.** Cascade has `promotedPhotoIds: []` slot but no promotion logic. Either remove the slot or add a tech-side toggle "promote to property profile" per photo. [server/lib/properties.js:272](server/lib/properties.js).

17. **Pre-Authorized Items section as a standalone block on the WO.** Currently collapsed to a pill on the carry-forward card. Spec calls for a separate "✓ Already authorized" section above the carry-forward banner. Cosmetic but spec-driven. [server/work-order-tech.html:112-119](server/work-order-tech.html).

18. **Walk-out checklist on the desktop editor too.** Today desktop accepts the dropdown change to `completed` with no gate. Add the same `walkoutCheckFailures()` logic. [server/work-order-tech.js:528-535, 555-581](server/work-order-tech.js).

19. **Three-year deferred flag enforcement.** `tech-cf-pill--repeat` shows visually; nothing prevents a 4th-year decline. Add a confirmation step: "This recommendation has been declined N years in a row. Resolve, dismiss, or escalate?" with three buttons that map to existing actions. [server/work-order-tech.js:2483-2484](server/work-order-tech.js).

20. **Status enum cleanup.** `wo.status` blank uses `"approved"` + `"awaiting_approval"` ([work-orders.js:155](server/lib/work-orders.js)) but only `awaiting_approval` is in `STATUS_ORDER` ([work-orders.js:474](server/lib/work-orders.js)). The desktop dropdown ([work-order.html:72-79](server/work-order.html)) lists both. Pick one and remove the other. Likely keep `awaiting_approval`, drop `approved`.

21. **Fix the `additionalRepairs[]` and `lineItems[]` legacy slots.** Either populate them from `onSiteQuote.builderLineItems` on cascade run (so old code reading those fields still works) or remove them entirely. Schema clutter. [server/lib/work-orders.js:165-166](server/lib/work-orders.js).

22. **Resolve the portal pre-auth "binding vs non-binding" semantic conflict.** Spec says binding; code comment says not. Pick one and align both. [server/lib/properties.js:160-166](server/lib/properties.js), [PJL_OPERATIONS_DESIGN.md §5.3.5](PJL_OPERATIONS_DESIGN.md).

### P3 — Next-level enhancements

See §10 below.

---

## 10. Next-Level Enhancement Brainstorm

Constrained to the existing architecture (no React, no realtime infra, no microservices). Each is sized small/medium/large.

| # | Enhancement | What it does | Files touched | Size | Why it matters | Architecturally OK? |
|---|---|---|---|---|---|---|
| 1 | **Quick-add "Common repairs" picker on the builder** | One-tap chips above `+ Add custom line`: Head replacement, Manifold rebuild (3v), Manifold rebuild (6v), Single valve, Wire repair, Drip head, Riser. Each tap appends a shaped line. | [work-order-tech.js renderOnSiteBuilder](server/work-order-tech.js), [pricing.json — already has the keys] | S | Removes "I have to navigate the cascading dropdowns to add ONE more head" friction | yes |
| 2 | **Per-issue templates** | When tech taps "broken head" in the zone sheet, pre-fill qty=1 instead of forcing the tech to type 1 | [work-order-tech.js renderSheetIssues](server/work-order-tech.js) | S | Speeds up the most-common path | yes |
| 3 | **Inline price preview** | Sticky bottom bar showing running subtotal + HST + total whenever the builder has lines. Visible while editing zones too. | [work-order-tech.html sticky-bar HTML](server/work-order-tech.html), [work-order-tech.js renderPaymentBlock](server/work-order-tech.js) | S | Tech currently has to scroll to see totals; this surfaces them constantly | yes |
| 4 | **"Snap to packed materials"** | When tech accepts a line, auto-tick the corresponding `service_materials` SKUs in the parts-to-bring-back tree. Removes "I authorized it but forgot to pack it" risk. | [work-order-tech.js — renderMaterials reconciliation](server/work-order-tech.js) | M | Operational safety — tech can't leave the shop without the parts | yes |
| 5 | **Voice input on issue notes** | The `voice-input.js` helper exists; verify it's wired into the bottom-sheet's notes textarea. (Currently wired on `sheetNotes` and `techNotes`, not on per-issue `tech-zone-issue-notes`.) | [work-order-tech.js renderSheetIssues — add data-voice-input](server/work-order-tech.js) | S | Tech can speak a quick "manifold leaking from north side" instead of typing | yes — already exists |
| 6 | **Photo prompts at workflow gates** | "Take blow-out location photo before you leave" if the property has no `system.blowoutLocation` photo on file and this is the property's first WO. | [work-order-tech.js walkoutCheckFailures](server/work-order-tech.js) | S | Catches the "we didn't document the blowout" gap on first visits | yes |
| 7 | **One-tap "Service complete, ready to invoice"** | Already exists as `Mark visit completed` sticky button. Make it more explicit on desktop too — replace the dropdown with a primary CTA mirror. | [work-order.html](server/work-order.html) | S | Desktop currently buries completion in a dropdown | yes |
| 8 | **Customer-facing approval link via SMS/email during the visit** | Already exists ([send-for-approval endpoint](server/server.js:2962)). Promote the button on the tech-mode review state — it's currently a footer afterthought. | [work-order-tech.html tech-on-site-remote](server/work-order-tech.html) | S | Already built; just needs UI prominence | yes |
| 9 | **Today dashboard shows packed/signed/completion progress** | Add small icons on each card: 📦 if `materialsPacked` ≥ expected, ✍️ if signed, ✅ if completed. | [today.js bookingCardHtml](server/today.js) | S | Patrick can scan today's status without opening each WO | yes |
| 10 | **WO PDF export for customer record** | Mirror the existing `quote-pdf.js` and `po-pdf.js` patterns. Branded, includes line items + signature + timestamps. Endpoint: `GET /api/work-orders/:id/pdf`. | new file `server/lib/wo-pdf.js`, route in `server.js`, button in both surfaces | M | Customers ask for receipts; today they get a draft invoice via QB or nothing | yes |
| 11 | **Signature-required-fields gate (desktop too)** | Walk-out checklist on desktop — currently the dropdown lets Patrick mark `completed` without signature. Mirror the tech-mode logic. | [work-order.js woStatus.addEventListener](server/work-order.js) | S | Hard rule §4.3.3 r14 | yes |
| 12 | **AI Correct Diagnosis Bonus auto-apply on confirmation** | Two buttons under the banner. On match, append `-95 / 1 hr` line to the builder. Persist `intakeGuarantee.confirmedMatch`. See P1 #8. | both surfaces, server.js, work-orders.js | M | Closes the spec-required behaviour gap | yes |
| 13 | **Carry-forward auto-resolve on completion** | Already implemented on sign-off ([server.js:4983-5001](server/server.js)). Verify the matching `resolvedInWoId` flag is set when the tech taps `Repair now` on the carry-forward card — it is. So this is **already shipped**. Surface it: "✓ N items resolved on this visit" in the post-sign summary. | [work-order-tech.js renderOnSiteSubmitted](server/work-order-tech.js) | S | Visibility of an existing behaviour | yes |

**Out-of-scope ideas considered and rejected:**
- Realtime status sync between desktop and tech (would require WebSocket / SSE infra; current pattern is fetch-on-render + cache busting). Not architecturally aligned.
- React-based zone editor (would require a build step the codebase intentionally avoids). Not architecturally aligned.

---

## 11. Documentation Update Recommendations

### `SYSTEM_OVERVIEW.md` — needs additions

In **§API surface (high level)**, the Work Orders block:

- Replace the existing 7-line block with the full 17-route enumeration from §4 of this audit. Prefix the on-site-quote routes with their purpose.

In **§Server-side libraries**, the `issue-rollup.js` row description is correct. Add a short note that it's the source of `manifold rule` enforcement and `service_call` prepend logic.

### `PJL_OPERATIONS_DESIGN.md` — needs reconciliation

In **§4.3.1 Service Modes**, replace the four-mode table with a note: "v1 implementation collapses these into three WO templates: `spring_opening` (find_and_fix), `fall_closing` (find_only), `service_visit` (find_and_fix or fix_only). New install (`build`) is not implemented; treat as service_visit until a build template is added."

In **§4.3.2 Work Order Structure**, the **Pre-Authorized Items** subsection describes a separate section. Code collapses it to a pill on carry-forward cards. Either:
- Update the spec to match: "Pre-authorized items appear as ✓ pills on the carry-forward banner cards."
- Or build the standalone section per §9 P2 #17.

In **§4.3.2 Materials Checklist**, the spec says "auto-generated from `parts.json`". Code says "follow-up only". Reconcile per §9 P1 #13.

In **§5.3 Rules** (Deferred Issues), point 5 says "Pre-authorization is binding." Code comment in `properties.js:160-166` says it's not. Pick one and align both.

In **§4.3.3 Behavioural rules**, rule #11 needs an audit-log clarification: "Post-sign edits to the WO must append a history entry. The on-site quote section refuses post-sign edits entirely (409)."

In **§10 Hard Rules**, rule #4 should call out specifically that **WOs need a `history[]` array** like Quotes and Invoices have. Currently they don't.

### Audit doc itself

This document should live as `WO_WORKFLOW_AUDIT.md` at the repo root and be referenced from a memory entry so future Claude sessions reading the brief know it exists. Once Patrick has read it and signed off on remediation priorities, this audit can be archived (kept in the repo for the audit trail) and its findings rolled into specific implementation briefs.

---

*End of audit.*

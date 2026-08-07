# JOB-009 — Admin unlock for locked work orders

**Status:** shipped 2026-08-06 · **acceptance test NOT yet run**
**Register IDs:** CRM-13 (new). Touches no flow marked PASS — see "Flows touched" below.
**Motivating case:** WO-BF86TWRW.

---

## The problem

WO-BF86TWRW is a service visit that was **bypass-locked** at end of visit with the
**$95 service call missing from its scope**. Two consequences, one cause:

1. `completionCascade.lineItemsFromWo(wo)` returns `[]` when the on-site quote builder
   has no lines. The cascade therefore had nothing to invoice, so **no invoice was ever
   drafted** and the fee was never charged. (This matches Patrick's recollection that he
   never created one.)
2. The WO was locked, so the fee could not be added afterwards.

And there was no way back. Before this job:

- No unlock route existed. The only `unlock` endpoint in the codebase is
  `/api/approve/:id/:token/unlock`, the customer phone challenge for protected
  proposals — unrelated.
- No admin UI control existed.
- The one latent lever, `PATCH {locked:false}`, half-worked: `locked` is in `allowedTop`
  and is not scope-protected, so the patch was accepted — but the dispatcher guard read
  `existing.locked === true || existing.signature?.signed === true`. On a **bypass**-locked
  WO (`signature.signed` false) it would have worked; on a **signature**-locked WO the
  scope stayed frozen and the patch changed nothing visible. A lever that silently does
  nothing half the time is worse than no lever.

## The design

Patrick's ruling, 2026-08-06: **flip the flag, keep the record.**

Unlock clears `wo.locked` and leaves `signature` / `signatureBypass` exactly as they
were. The visit really was accepted; erasing that would lose a fact. So the two concerns
are separated:

- **`wo.locked`** carries frozen-ness. It is now the *single* authority, via
  `isScopeFrozen(wo)` in `lib/work-orders.js`.
- **`signature` / `signatureBypass`** carry the acceptance history. Never mutated by
  unlock or re-lock.

Making `locked` authoritative is what makes unlock mean anything on the signature path.
The 14 `locked || signature.signed` guards in server.js were belt-and-suspenders that was
always redundant — every lock path sets `locked` at capture — and became actively wrong
the moment an admin could clear `locked` deliberately. **Behaviour is unchanged for every
WO that has not been explicitly unlocked**, which is every WO in the store before this
shipped.

### Deliberately out of scope

- **Invoices.** Neither route touches one. A completed WO's invoice is a separate record
  with its own line items, copied at cascade time; editing WO scope after unlock does not
  re-bill anyone. `HANDOFF_STRIPE_PAYMENTS` §6 invariants hold — no payment-adjacent code
  was modified. Re-cutting a bill stays a separate, explicit act (see "After unlocking").
- **The two customer-facing portal guards** (`wo.locked || wo.signatureBypass`, server.js
  ~9098 and ~9228). Left keyed on the bypass record on purpose, and annotated in place: an
  admin unlock must never re-open a stale customer approval or remote-sign link for a visit
  that already happened. Customer-facing staleness ≠ admin editability.

## What shipped

| Area | Change |
|---|---|
| `server/lib/work-orders.js` | `isScopeFrozen(wo)` — `wo.locked` is the freeze authority. `unlockWorkOrder()` / `relockWorkOrder()` with structured refusal codes. `UNLOCK_MIN_REASON_LEN = 10`. |
| `server/server.js` | `POST /api/work-orders/:id/unlock` + `/relock`. `needsAuth()` maps both to **"admin"**, placed above the generic `/api/work-orders` → "user" rule (first match wins, or techs would inherit it). Handlers re-check `requireAdmin`. 14 guards switched to `isScopeFrozen`. |
| `server/work-order.js` / `.html` / `.css` | "Unlock for editing" on the locked banner; amber "Unlocked for editing" banner with "Re-lock". Admin-only, role from `/api/session`, fail-closed. Lock-state UI (on-site quote builder, fee waiver, AI-bonus card) now keys on `wo.locked` so an unlocked WO is genuinely editable. |
| `server/work-orders-index.js` / `.html` / `.css` | **Unlocked** filter chip. Unlock clears `locked`, which drops a WO out of *both* existing recovery filters (each requires `locked === true`) — without this, a half-edited contract is invisible everywhere. Same lesson as CRM-11. |
| `scripts/test-wo-unlock.mjs` | 56 assertions. Wired into `npm run build:check`. |

**Reason is mandatory** (≥10 chars) and lands in WO history with who unlocked it and which
path had held the lock. This is an override of a customer-accepted contract; an unexplained
one is worse than none.

## Verification already done

`npm run build:check` — full suite green, nothing regressed (test-pricing 195,
proposal-unlock 26, proposal-html 141, commercial 206, stripe 30, invoice-balance 46,
wo-completedat 39, **wo-unlock 56**, mailer-log 18).

Round trip against a live local server with seeded admin + tech accounts and a
bypass-locked WO:

| # | Action | Result |
|---|---|---|
| 1 | Tech POSTs `/unlock` | **403** — "Admin access is required for this action." |
| 2 | Admin unlock, reason `"nope"` | **422** `reason_required` |
| 3 | Admin PATCHes `lineItems` while locked | **409** `wo_locked` |
| 4 | Admin unlock with a real reason | **200** — `locked:false`, `signatureBypass` intact, history entry correct |
| 5 | Admin PATCHes `lineItems` while unlocked | **200** — the $95 line lands |
| 6 | Admin unlocks again | **409** `wo_not_locked` |
| 7 | Admin re-locks | **200** — `locked:true`, edit survived, bypass intact |
| 8 | Admin PATCHes `lineItems` after re-lock | **409** — frozen again |

This is **not** a substitute for Patrick's walk. Per dispatch rule 4, the job is not done
until the test below has been run against real data.

---

## Acceptance test — Patrick runs this

Deploy first. Then, on WO-BF86TWRW:

1. **Find it.** `/admin/work-orders` → **Needs invoice** filter (locked WOs with no invoice
   on file). WO-BF86TWRW should be listed. Confirm it shows no invoice.
2. **Confirm the tech can't.** If a tech account is handy, open the WO as that user — no
   "Unlock for editing" button should appear at all.
3. **Unlock.** Open the WO as admin. The red locked banner now carries **Unlock for
   editing**. Click it; enter a reason (e.g. "Service call fee was never added to scope").
   Expect: banner turns amber and reads "Unlocked for editing" with your reason.
4. **Check the record survived.** Scroll to the sign-off card — the signature bypass should
   still be shown, unchanged, with its original reason and timestamp.
5. **Add the fee.** In Issues → Draft Quote, add the `service_call` line ($95, from
   pricing.json — do not type the number by hand). Save.
6. **Re-lock.** Click **Re-lock**. Expect the banner to return to red/locked and the $95
   line to still be there.
7. **Draft the invoice.** Use the WO's existing **Create invoice** action. Expect a draft
   invoice for $95 + HST. If it returns an already-existing invoice instead
   (`alreadyExisted: true`), **stop** — an invoice did exist after all; do not double-bill,
   and adjust that invoice instead.
8. **Check the hygiene filter.** `/admin/work-orders` → **Unlocked** filter should now be
   empty (you re-locked in step 6). Optionally unlock something, confirm it appears there,
   re-lock it.
9. **Read the history.** The WO history should read `signature_bypassed` → `wo_unlocked`
   (with your reason) → `wo_relocked`, in order.

**Then update `docs/FLOW_REGISTER.md`:** mark CRM-13 CLOSED with the date, or record what
failed.

### After unlocking — getting the $95 actually billed

Steps 5–7 above are the whole path for WO-BF86TWRW, because no invoice exists. For any
*future* case where an invoice already exists, unlock does **not** update it. Then:

- Invoice still **draft** → edit the line items on the invoice directly; totals recompute.
- Invoice **sent**, unpaid → edit and re-send. The customer already has the old figure.
- Invoice **paid / partially paid** → do not touch it. Issue a supplementary invoice.
  FLOW-23 is PASS and the Stripe handoff §6 invariants are binding.

## Flows touched

No flow marked **PASS** has its hop chain modified by this job.

- **FLOW-23** (payment captured → receipt → marked paid) — **not touched.** No
  payment-adjacent file was modified; unlock/re-lock never reach an invoice.
- **FLOW-02** (portal in-session actions) — **not touched.** The two portal-side guards
  that could have been affected were deliberately left keyed on `signatureBypass`.
- The 14 guard call-sites are WO-scope-mutation routes (on-site quote builder, fee waiver,
  issue defer/emergency, carry-forward, intake guarantee, follow-up baseline, the WO PATCH
  dispatcher). All are internal admin/tech surfaces, none is in a registered flow.

## Known follow-up

Not fixed here, and worth a job of its own: **the WO completed with an empty builder and
nothing complained.** The cascade quietly produced no invoice, and the only reason anyone
noticed is that Patrick spotted the missing charge. A completion with zero billable lines
on a `service_visit` is almost always a mistake — a pre-completion nudge, or a
"completed with nothing to bill" surface alongside the existing recovery filters, would
have caught WO-BF86TWRW at the time instead of weeks later.

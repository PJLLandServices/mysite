# JOB-011 — Full customer purge (delete a customer everywhere)

**Scoped 2026-08-07** from Patrick's request during the JOB-009 acceptance walk: deleting
a lead works, but a *customer* with anything attached is locked in forever — the CRM
refuses to delete them. Wanted: **one place** to delete an entire customer from the whole
CRM, specced for (a) people who reached out and never went forward, and (b) test records
like John Charette.

(JOB-010 is reserved for re-recording the other session's "admin unlock" work — this job
is 011 to keep the numbers from colliding again.)

## Investigation findings (2026-08-07)

- The lock is deliberate: `customers.js hardDelete()` checks seven stores (leads,
  properties, bookings, work-orders, quotes, invoices, projects) and refuses if any
  record carries the customerId. The comment gives the reason: customers linked to
  signed WOs / issued invoices must stay resolvable for legal/audit reasons. Right
  instinct for real customers; wrong for junk, which self-locks via its own junk
  attachments. The soft path (`remove()`) just marks status inactive.
- Beyond the seven stores: magic-tokens carry a `subjectId` (lead or customer id) —
  purged customers' tokens must be revoked. Review-requests carry `customerId` and
  `woId` — pending ones must go. Portal message threads live on the lead records and
  die with them. The email send ledger (JOB-008) keeps its entries — it is append-only
  audit data and references ids, not live records.
- Two live records are waiting on this job: **John Charette** (test booking,
  `linked=booking+customer`) and **Kelly Dorji** (SEO spam, `linked=customer`) — their
  leads are deletable today, their customer records are not.

## Design (agreed with Patrick 2026-08-07)

One action, on the customer's own page in the admin: **Delete customer everywhere**.

Two safety rails, non-negotiable:

1. **The money line.** Purge REFUSES if the customer has any paid or partially-paid
   invoice, or any invoice with payment attempts / ledger entries. Those are
   bookkeeping records — tax-relevant, never deletable. Real customers use the
   existing archive path; this tool physically cannot erase financial history.
2. **Preview before purge.** The action first shows the full inventory — "this deletes
   2 leads, 1 booking, 1 work order, 1 property, 0 invoices…" — and deletes nothing
   until confirmed against that list. Before the cascade runs, a snapshot of every
   affected record is written to `server/data-backup-<ts>-customer-purge-<id>/`
   (same pattern as the completedAt backfill), so even a confirmed purge is
   manually recoverable.

## Tasks

1. **Purge library** — `server/lib/customer-purge.js`:
   - `preview(customerId)` → inventory: per-store counts + record ids + the money-line
     verdict (`allowed: true/false` with the blocking invoice ids).
   - `purge(customerId)` → re-runs the guard, writes the backup snapshot, then removes
     in dependency order: review-requests → magic-tokens (customer id + all lead ids) →
     invoices (unpaid drafts only — guard already proved none are paid) → work-orders →
     bookings → quotes → projects → properties → leads → the customer record itself.
     Returns the per-store deletion counts. Refuses mid-flight if the guard re-check
     fails (a payment landing between preview and purge must block the purge).
2. **API** — admin-gated (`needsAuth` → "admin", like /api/admin/email-health):
   - `GET  /api/admin/customers/:id/purge-preview`
   - `POST /api/admin/customers/:id/purge` (body must echo the preview's record counts —
     a stale preview means the confirm doesn't match and the purge refuses).
3. **UI** — a danger-zone section at the bottom of the customer page: button → preview
   modal listing the inventory → type the customer's name to confirm → result summary.
   Hidden for tech role.
4. **Tests** — `scripts/test-customer-purge.mjs` in `build:check`: guard blocks paid
   invoice / payment attempts; preview counts match fixture; purge removes everything
   and only what belongs to that customer; snapshot written; stale-confirm refused;
   tokens revoked.

## Constraints

- **FLOW-23 invariants**: `stripe.js`, `pay.js`, and payment routes untouched. The
  money-line guard reads invoice records; it changes nothing about payments.
- No PASS flow's *behaviour* changes — purge only removes records, and the guard
  guarantees no record a PASS flow's audit trail needs (paid invoices) can go.
- Deletion is real (not Trash) — the preview + snapshot are the recovery story. The
  30-day lead Trash flow is unchanged and stays the right tool for lead-only cleanup.
- No bulk purge. One customer at a time, each with its own preview and confirm.

## Acceptance test (Patrick walks it)

1. Open John Charette's customer page → Delete customer everywhere → preview lists his
   lead(s), booking, work order, property, customer record; money line green. Confirm.
   Result summary shows the counts. Search the CRM: no trace of Charette in pipeline,
   customers, properties, bookings, work orders. Backup folder exists on the server.
2. Same walk for Kelly Dorji (simpler: lead + customer record).
3. Open a REAL customer with a paid invoice (e.g. Paolo Gullo) → the action shows the
   money-line refusal naming the paid invoice ids, and there is no way to proceed.
4. Portal check: a magic-link request for the purged customers' emails behaves like any
   unknown email (generic "If we found you…" response, no login).
5. `npm run build:check` green (includes the new purge test suite).

**Register on close:** new entry recording the purge capability and its money-line
guard; CRM-04's residual-customer note resolved by this job.

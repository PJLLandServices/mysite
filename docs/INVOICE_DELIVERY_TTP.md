# Invoice delivery & Tap to Pay: flows, state model, wording (P-PJL-22)

Status: **BUILT on PR #383, not merged.** Requirements A–E were written
2026-10-05. The regression suites came first and failed on main at
`9d36363f` where the defect or the missing state was (counts below). They
then passed where an existing guard already held, pinned so the fix could
not loosen it.

A–D are now built and all four suites pass. They are in `build:check`.
**Nothing merges until Patrick approves §1 (state model) and §2 (wording)
and answers §4.** The wording sits in one constant block at the top of each
suite, so a change he asks for is a one-line edit plus the matching string
in the code.

| Req | Linear | Flow ID | Suite | On main `9d36363f` (before the build) |
|---|---|---|---|---|
| A | PJL-126 | INV-SEND-01 | `scripts/test-invoice-first-send.mjs` | 8 fail (DRAFT, OVERDUE, part-paid DRAFT, project email) / 19 pass |
| B | PJL-127 | INV-LINK-01 | `scripts/test-invoice-pdf-pay-link.mjs` | 6 fail (no link) / 12 pass (no new way to charge) |
| C | PJL-128 | TTP-COLLECT-01 | `scripts/test-collect-payment-now.mjs` | 19 fail (labels, switch, one rule) / 8 pass |
| D | PJL-129 | SETTLE-PIF-01 | `scripts/test-paid-in-full.mjs` | 15 fail (no such state) / 17 pass (No Charge unchanged) |

E (the suites themselves) is PJL-130. Run all four: `npm run test:invoice-delivery`, or as part of `build:check`.

**How it was built** (where it lives):

- **A**
  - `invoice-pdf.js`:
    - `resolveStatus` gives every status its own words and has no OVERDUE.
    - `customerCopy()` is the customer's copy of a draft being sent.
  - Callers that render it: `/send`, `deposits.sendInvoiceNow`, and the project-completion email. The project-completion email now awaits the Buffer.
- **B**
  - `invoice-pdf.js` `normalize().payUrl` builds the link from `resolvePublicBaseUrl()`.
  - `drawBottomSplit` draws one link annotation plus the printed address.
  - The paid, void and no-token wording follows §2.
- **C**
  - The labels, on all three surfaces and in the blockers.
  - `invoices.onSiteRefusal()` holds the guards, shared by Take payment now, Tap to Pay and the switch.
  - `invoices.switchToCollectNow()` with admin-only `POST /api/invoices/:id/collect-now`.
  - `pjl-field/src/invoice-actions.mjs`, used by `InvoiceScreen`.
  - The Take payment now instead button.
- **D**
  - `server/lib/wo-settlement.js` holds the rule, the normaliser and `techView`.
  - `work-orders.setSettlement` / `clearSettlement` (before completion only), with history.
  - Admin-only `PUT|DELETE /api/work-orders/:id/settlement`.
  - Every JSON reply to a tech session passes through `techView` (`sendJson`).
  - The cascade drafts no invoice and records the settlement plus the real totals on the service record.
  - Finish replies `paidInFull` (techs see `nothingToCollect`).
  - `create-invoice` returns 409 `paid_in_full`.
  - The report has an Account section. The completion email and admin alert say so.
  - The customer summary is prepaid with no amounts.
  - The portal history says PAID IN FULL.
  - Needs invoice excludes it, and the service history reads "Paid in full (prepaid)".
  - The office work-order page has the control (D-D2: office page only for now).
  - The app's sign-off shows "Payment: handled by the office" and the Paid in Full landing screen.
- **Not changed:** `payBlockReason`, the charge path, finalize, the ledger, QuickBooks, and No Charge.
- **The Tap to Pay lane:** its `InvoiceScreen` carries the Tap to Pay button, which main's does not. When main is next merged into the lane, the button takes `invoiceActions().tapToPay`, as the suite's C6 already pins for the rule.

---

## 0. What is true today (research, 2026-10-05)

- **Invoice statuses** (`server/lib/invoices.js:34`): `draft`, `sent`, `partially_paid`, `paid`
  and `void`. Nothing else is stored.
- **Derived from those statuses** (none of them is a status):
  - on-site opening (`onSitePayment.openedAt`)
  - reconciliation (marked paid, ledger short)
  - payment exceptions
  - scope hold (`scopeHold`)
  - unconfirmed price (`priceConfirm`)
  - `holdUntilCompletion`
- **The customer PDF's status stamp** (`invoice-pdf.js` `resolveStatus`) can read Overdue, Paid,
  Sent, Void, or else **Draft**:
  - The first send renders while the invoice is still a draft, so the stamp reads **DRAFT**.
  - Invoices store **no due date**, so the PDF's due date is the creation instant. Any Sent
    render after that reads **OVERDUE**, which includes every resend.
  - `partially_paid` falls through to **DRAFT**.
- **"All major credit cards accepted via the secure payment link below."** No link has ever been
  drawn.
  - `git -S` finds no `doc.link` or `paymentToken` in the file's history.
  - `normalize()` drops the `paymentToken` every caller passes.
  - The link exists only as the email's "View and pay" button.
- **The pay page** (`/pay/invoice/:id?t=<paymentToken>`, Stripe Payment Element):
  - Card entry only when `invoices.isPayableOnline(inv)`, that is `payBlockReason` returns null.
  - That means sent, part paid, or a draft opened for on-site payment.
  - Paid shows "Thanks — payment received".
  - Void, reconciliation, scope hold, unconfirmed price and unsent drafts take no card.
- **Project-completion email** (`server.js`, project `notifyCustomer`):
  - It used `generateInvoicePdf` as a stream, but the renderer returns a `Promise<Buffer>`.
  - The `TypeError` is caught, so **every project-completion email went out with no invoice
    PDF**, silently.
- **Sign-off choice:** "Paid on site" / "Bill later" in the field app. The tech web page and the
  office page say "Yes — paid in the field" / "No — invoice to follow".
  - Bill later sets `paidOnSiteAtCompletion: false`.
  - The phone hides Tap to Pay and Take payment now (`InvoiceScreen` `payableHere`).
  - The server refuses with `needs_review` until the invoice is **sent**.
- **No Charge** is derived, not stored:
  - The visit's lines total $0 (`billing.billingFor`).
  - No invoice is drafted.
  - The service record has lines and no `invoiceId` (`isNoChargeServiceRecord`).
  - The app shows "No charge — done".
  - Nothing goes to QuickBooks (Patrick's ruling, FLOW-31 #7).
- **Prepaid customers:** **nothing in the system can say "this visit is prepaid."**
  - The "season plan" (`lib/season-plans.js`) is a route plan: property codes per day, with no
    price, payment or coverage.
  - Customers carry `commercial.paymentTerms` (Net terms) and no prepaid flag.
  - Today a prepaid visit either gets an invoice for money already paid, or a $0 property price
    that turns it into No Charge and erases the fee from the record.
- **QuickBooks** (`lib/quickbooks.js`):
  - Invoices push on first `/send` only.
  - Stripe payments create a QBO Payment linked to the invoice.
  - Manual payments are not mirrored.
  - Void is mirrored.
  - There is no credit memo, customer-deposit, prepayment or unearned-revenue handling anywhere.

---

## 1. State model (built; awaiting approval)

### 1.1 Invoice: unchanged statuses, one customer-stamp rule

No new invoice status. One function decides what a customer copy says:
`customerStamp(inv, { sending })`. Every path that emails or links a PDF calls it (send, resend,
revised send, receipt, deposit send, project completion). `DRAFT` cannot be returned for a copy
the customer receives.

| Invoice | Customer stamp | Date beside it |
|---|---|---|
| draft, being sent now (first send) | PAYMENT DUE | today (the send) |
| sent, balance owing | PAYMENT DUE | date sent |
| partially_paid | PART PAID | last payment date |
| paid | PAID | paid date |
| void | VOID | voided date |
| draft (office preview / admin download only) | DRAFT | created date |

- **OVERDUE comes off the customer copy (decision D-A1).** There is no stored due date, and
  "Due on completion" makes every invoice overdue the day after. If Patrick wants it back, it
  needs a real `dueAt` (terms → date) first.
- **First send (A):**
  1. Render the PDF from `{ ...inv, status: "sent", sentAt: now }` in memory.
  2. Email it.
  3. Only after the email succeeds, commit `status: "sent"`, `sentAt`, history and the
     QuickBooks id. This is unchanged order; only the render input changes.
- **A failed email:** 500, nothing written, still a draft (A2, already true, pinned).
- **QuickBooks push stays before the email**, as today. A push that succeeds and an email that
  fails leaves a QB invoice for a local draft; the next Send re-pushes in place (existing
  behaviour, unchanged here).

### 1.2 The PDF link (B)

- The link goes to `${PUBLIC_BASE_URL}/pay/invoice/<id>?t=<paymentToken>`. It is PJL's stable
  pay page, never Stripe.
- It is drawn as a clickable annotation under the "secure payment link below" sentence.
- **The page decides, not the PDF.** The same link:
  - takes a card while `isPayableOnline`;
  - reads Paid once paid;
  - takes nothing for held, reconciliation, $0, void, unsent drafts, unconfirmed price and scope
    hold (all already true, pinned in B4).
- The token is minted at send (`ensurePaymentToken`, as the email already does).
- An office preview with no token draws **no** link, and a different sentence (§2).
- A **paid** invoice's PDF keeps the same link, labelled as a view, not a payment.
- `payBlockReason` is not changed. FLOW-23 (PASS) is touched only by adding a new way **in** to
  the same page, and is re-verified by B2–B4 plus one walked payment through a PDF link.

### 1.3 Collect payment now / Send invoice / bill later (C)

- **Stored fields unchanged:** `wo.paidOnSite` true/false, and the invoice's
  `paidOnSiteAtCompletion`. Only the words change, on all three surfaces and in the server's
  sign-off blocker.
- **One rule for the phone's buttons:** `pjl-field/src/invoice-actions.mjs`
  `invoiceActions(invoice, { role })` returns
  `{ tapToPay, takePayment, send, recordPayment, takePaymentInstead }`.
  - `InvoiceScreen` uses it and keeps no second copy (CLAUDE.md "define the rule once").
  - It mirrors the server's `payBlockReason` / `openForOnSitePayment`.
- **New admin-only route:** `POST /api/invoices/:id/collect-now` ("Take payment now instead").
  - **Accepts:** a **draft**, not sent, signed off Bill later.
  - **Runs** every guard `openForOnSitePayment` runs (reconciliation, paid, void, $0, scope hold,
    unconfirmed price), except the Bill-later `needs_review` refusal it exists to lift.
  - **Writes:**
    - stamps `onSitePayment = { openedAt, by, switchedFromBillLater: true }`;
    - adds history `switched_to_collect_now` (who, when).
  - **Leaves alone:**
    - the status stays draft;
    - nothing is emailed;
    - nothing goes to QuickBooks;
    - `paidOnSiteAtCompletion` stays false, because it is what the tech chose and the record
      keeps it.
  - **Refuses** a tech (403), and a sent, paid or void invoice (409).
- **Leaves alone:**
  - Tap to Pay's server half (`terminal-intent`), which already accepts a draft once
    `onSitePayment.openedAt` is set;
  - the second-tap rules;
  - finalize and the ledger;
  - Stripe.

### 1.4 Paid in Full (D): the first stored settlement

Minimum new state, on the **work order** (the visit), because nothing existing can carry it:

```
wo.settlement = {
  type: "paid_in_full",     // the only type for now
  reference: "<text>",      // required: what paid for it, e.g. "2026 prepaid plan — QB #1234"
  by: "<admin uid>",
  at: "<ISO time>"
}
```

**Admin only, one door.**
- `PUT /api/work-orders/:id/settlement` sets it and `DELETE` clears it.
  - It needs a `needsAuth` "admin" entry above the generic `/api/work-orders` rule, plus
    `requireAdmin` in the handler.
  - Each change adds a work-order history line: `settlement_paid_in_full` or
    `settlement_cleared`, with who and when.
- The generic work-order PATCH ignores `settlement` for everyone.

**Who can see it.**
- A tech's read of the work order omits `settlement` and carries only
  `paymentHandledByOffice: true`.
- The tech's sign-off shows "Payment: handled by the office" in place of the question.
- No tech surface says "Paid in Full" (decision D-D3).

**Sign-off.** The payment gate is satisfied by the settlement; `paidOnSite` stays null.

**Completion** (cascade):
- No invoice.
- The service record copies the `settlement`.
- It keeps the visit's real lines and value for the office, with no `$0` total and no invoice id.
- The cascade answers `{ paidInFull: true, noCharge: false }`.
- The app lands on a "Paid in full — done" screen (admin) or "Visit complete — nothing to
  collect" (tech), with no payment buttons.

**What it never creates:**
- an invoice, $0 or otherwise;
- a payment, ledger line or payment link;
- Tap to Pay or Take payment now;
- an invoice-ready text, reminder or junk-mail warning;
- a QuickBooks transaction for the visit (see §3).

`create-invoice` refuses with 409 `paid_in_full`.

**Customer-facing:**
- The full visit report (customer audience) as usual, plus one line: `PAID IN FULL` (§2).
  - The report's no-prices rule holds; this line carries no amount.
- The completion email's money line becomes the Paid in Full line.
- No "invoice will follow".

**Office:** service history, the work-orders list and the property page read "Paid in full
(prepaid)". They never read "No charge", and are not filed under Needs invoice.

**Changing it after completion:**
- If an untouched draft invoice exists (not sent, no money, not in QuickBooks), setting Paid in
  Full voids it with history `voided_paid_in_full`. This is the same shape as the no-charge
  re-sign path.
- A sent or paid invoice is refused (409). That goes through void or credit, as today.

**Clearing it:** before completion only.

**No Charge is untouched:**
- still derived from $0 lines;
- no `settlement`;
- same screens and words.
- A Paid in Full visit is never `noCharge`, and a No Charge visit is never Paid in Full (D6).

**Not built now:** a customer- or property-level "prepaid plan" record (coverage by season or
year). If Patrick wants "every visit for this property in 2026 is prepaid" to happen
automatically, that is the next layer, and it would set this same `wo.settlement`. The name must
not be "season plan", which is the route plan.

---

## 2. Customer- and tech-facing wording (built as below; Patrick to approve each)

| Where | Today | Proposed |
|---|---|---|
| Sign-off question (app, tech page, office page) | "Paid on site" / "Bill later" · "Yes — paid in the field" / "No — invoice to follow" | **Collect payment now** / **Send invoice / bill later** |
| Sign-off blocker (server + pages) | "Choose payment method (paid on site or bill later)" | "Choose: Collect payment now, or Send invoice / bill later" |
| App blocker list | "How they are paying" | unchanged |
| Invoice screen, Bill-later draft (tech) | "Signed off as “Bill later” — Patrick reviews this one before it goes to the customer." | "Send invoice / bill later was chosen — the office sends this one." |
| Invoice screen, Bill-later draft (admin) | (same note, no action) | button **Take payment now instead** → confirm: "Take payment now instead? Tap to Pay and Take payment now open for this visit. Nothing is emailed." |
| Invoice PDF stamp | DRAFT / OVERDUE on customer copies | PAYMENT DUE · PART PAID · PAID · VOID (DRAFT office-only) |
| Invoice PDF, payable | "All major credit cards accepted via the secure payment link below." (no link) | same sentence, then a clickable **View and pay online**, with the full link printed small beneath it for a paper copy |
| Invoice PDF, paid | (same sentence, no link) | "Payment received — thank you." then **View this invoice online** (same link) |
| Invoice PDF, office preview (no token) | (same sentence) | "Pay online from the link in your invoice email." (no link) |
| Report, Paid in Full | (n/a) | a line reading **PAID IN FULL** · "This visit was prepaid. There is nothing to pay." |
| Completion email, Paid in Full | (n/a) | "**PAID IN FULL** — this visit was prepaid. There is nothing to pay." (no amount, no invoice line) |
| Admin app, after Finish | (n/a) | "Paid in full — done. This visit was prepaid; there is no invoice and nothing to collect." |
| Tech app, sign-off + after Finish | (n/a) | "Payment: handled by the office" · "Visit complete — nothing to collect." |
| Office service history | "$… incl. HST" or "No charge" | adds "Paid in full (prepaid) — <reference>" |

---

## 3. Accounting / QuickBooks treatment for Paid in Full (D-D1): NOT decided here

This depends on how the prepayment itself was recorded in QuickBooks. That record is not in this
system, and I did not read the live QuickBooks company. The repo has no prepayment, deposit or
unearned-revenue handling to copy.

**(a) The prepayment was sold as a sale.** A QB invoice or sales receipt was paid when the plan
was sold, so revenue and HST were booked then.
- The visit must create **no** QuickBooks transaction. Another invoice would double-count
  revenue and HST.
- This is what §1.4 builds, and it is the minimum.
- Recommended **if** this matches how Patrick's books record prepayments today.

**(b) The prepayment sits as a customer deposit or unearned revenue** (a liability), recognised
visit by visit.
- Each visit needs a QB entry moving its share into revenue: a QB invoice for the visit paid by
  applying the customer's credit, or a journal entry.
- The HST timing on deposits needs the accountant.
- Nothing in the app does this today. It would be its own piece of work, and §1.4 would keep the
  visit's value on the service record so the entry can be made from it.

**Needed from Patrick (or the accountant), before implementation:**
1. How was the last prepaid customer's money recorded in QuickBooks: a paid invoice/sales
   receipt, or a deposit/credit?
2. Should the visit's value appear anywhere in QB at the visit, or only at the sale?

Until then §1.4 creates no QB transaction. That is correct for (a), and safe for (b): nothing is
double-booked, and a missing entry can be added later from the service record.

---

## 4. Decisions needed

- **D-A1:** remove OVERDUE from the customer PDF (recommended), or keep it once invoices have a
  real due date.
- **D-B1:** print the full tokened link small under the button for paper copies (recommended), or
  the button only.
- **D-C1:** "Take payment now instead" in the field app only (recommended), or also on the office
  invoice page.
- **D-D1:** QuickBooks treatment, §3.
- **D-D2:** where an admin sets Paid in Full: the office work-order page (recommended, before the
  visit), plus an admin-only third choice at sign-off in the app. Or only one of those.
- **D-D3:** the tech never sees the words "Paid in Full", only "handled by the office"
  (recommended, per "tech users cannot see it").
- **D-D4:** is a `reference` required (recommended: yes, so the audit says what paid for it)?
- **The wording in §2**, line by line.

---

## 5. Guards that must not move (checked by the suites)

- **Every existing refusal still refuses** for Collect now, the switch and the PDF link:
  - price not confirmed (PJL-96);
  - scope changed after signing: `revision_required` / `awaiting_signature`;
  - reconciliation;
  - payment exceptions (they never block, as today);
  - `holdUntilCompletion` (send);
  - $0 / No Charge;
  - paid and void.
- **Payment invariants** (`HANDOFF_STRIPE_PAYMENTS.md` §6):
  - charge `balanceDue`;
  - the server decides the amount;
  - finalize re-reads Stripe;
  - one tap at a time;
  - the ledger is append-only.
  - None of A–D touches the charge path.
- **No Charge's** screens, words, history and QuickBooks silence are unchanged (D6,
  `scripts/test-no-charge.mjs`).
- **One active invoice per work order** (FLOW-23/31) is unchanged.

---

## 6. Release shape (after approval)

- **A and B** are server-only. They reach customers on the next Render deploy, with no phone
  update.
- **C (labels, one rule, switch) and D (app screens)** touch `pjl-field/`.
  - They go to Patrick's phone through the Tap to Pay lane (`field-app-ttp-lane.yml`, publish
    phrase, Patrick dispatches).
  - The server parts land first, so an old app keeps working: the switch route is unused, and
    `paymentHandledByOffice` is ignored. The old app would still show the payment question on a
    Paid-in-Full visit, so **D is not offered to the field until the app with it is on the
    phone.**
- **Proposed order:**
  1. A + B (customer-facing, server-only).
  2. C.
  3. D (after D-D1).
- Each is one PR, with its suite joining `build:check`.

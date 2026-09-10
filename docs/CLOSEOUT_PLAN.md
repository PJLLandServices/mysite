# PJL Backend — Closeout Plan

**Written 2026-08-03.** Everything left in the register, in the order to do it.

All High and Medium defects are closed. What follows is the tail. Nothing here is on fire —
this is the order that finishes the map without creating new drift.

**The rule that got us here, still applies:** one job at a time, written acceptance test,
Patrick walks it before it counts, register updated. No exceptions for small jobs.

---

## Stage 1 — Sweep the shallow items (one session, ~1 hour)

Four jobs that need no investigation. Bundle them into **JOB-009** as one sweep, because each
is too small to justify its own cycle and none of them touch a PASS flow.

| Item | Work |
|---|---|
| CRM-04 | Delete test data from the live pipeline: `John Charette` fake booking (site_visit since 2026-04-30), the `Jeff John` VD-3 test lead, and any `+` tagged test leads from the JOB-001 acceptance runs. |
| CRM-05 | Two SEO-spam submissions via the contact form. Delete them, and report whether anything beyond the honeypot could catch human-sent spam. Do not add a CAPTCHA without asking. |
| CRM-06 | `/commercial-new-customer` serves the residential canonical tag, title, and meta description. Differentiate them. |
| MISC-01 | Footer links to Toronto, North York, Lawrence Park, Forest Hill appear sitewide but are absent from `sitemap.html`. **Check whether they 404.** If they do, this is a sitewide broken link on every page — fix or remove. |
| MISC-02 | `sitemap.html` counters are stale: "Services · 10 pages" lists 11; "Book / Quote / Estimate · 3 pages" lists 4. |

**Acceptance:** pipeline contains no test or spam records; the four city links either load or are
gone; sitemap counters match reality; commercial page has its own metadata.

### ✅ STAGE 1 COMPLETE — 2026-08-09

All five items closed on walks Patrick performed against production. Full record in
`docs/JOB-009_SHALLOW_SWEEP.md`; register rows carry the acceptance evidence.

| Item | Outcome |
|---|---|
| CRM-04 | **CLOSED.** Test leads deleted 08-07 via bulk delete → Trash; the residue — booking `BK-2026-0014` and the John Charette customer record — 08-09, once CRM-15 made the stranded booking reachable. |
| CRM-05 | **CLOSED.** Spam leads deleted 08-07; Kelly Dorji confirmed gone from every store. Spam-defense report written: the gate is four blocking checks (honeypot, time-trap, per-IP rate limit, Turnstile — confirmed armed on Render), none of which stops a human typing a pitch. **No CAPTCHA added.** |
| CRM-06 | **CLOSED.** `serveStatic` rewrites title, canonical, description and `<h1>` on the commercial route; residential bytes untouched. Confirmed live. |
| MISC-01 | **CLOSED — they never 404'd.** All four pages existed, were linked from 84 pages each, and were already in `sitemap.xml`. The only real gap was `sitemap.html`'s Service Areas list. Four footer taps walked live. |
| MISC-02 | **CLOSED.** Counters corrected and walked live — and they survived PR #47 adding a service page, which bumped the count with the entry. |

**One estimate to correct for future planning:** this was scoped at "~1 hour, no investigation
needed." It took two sessions across three days. The four code items were genuinely shallow;
the deletions were not, because they surfaced a missing feature (CRM-15) that nothing in the
plan anticipated.

**Spun out of Stage 1 — carried forward, not done:**

- **CRM-15** — deleting a lead stranded its booking with no UI able to delete it. Found *and
  fixed* inside JOB-009 (delete control on `/admin/booking/:id`), walked live the same day.
  It is what unblocked CRM-04. **Closed**, and listed here because it is the reason Stage 1
  ran long.
- **CRM-14** — `POST /api/new-customer` has no anti-bot gate at all. Found while sourcing
  CRM-05's claims. **Open, unscoped** — Patrick's call whether it earns a job.
- **CRM-05's flag-don't-block recommendation** — set the existing `botFlagged` at intake using
  the scanner's vocabulary, so suspect leads arrive pre-flagged and no customer is ever
  blocked. **An open decision, not a defect.** Unbuilt, and closing CRM-05 did not presume it.
- **JOB-011 needs re-scoping before anyone builds it.** It was scoped on the premise that test
  records like John Charette are "locked in forever." That premise is now false — Charette
  came out in two clicks once the booking control existed. Its remaining value is the *safe
  general* case: money-line guard, preview, snapshot.

**The method lesson, recorded because it cost the most time.** JOB-009 designed CRM-04/05
around a read-only scanner run on the Render shell. Every other job in this register shipped
as code → merge → deploy → Patrick clicks in the CRM. That framing hid a missing feature
behind a diagnostic that kept truthfully reporting "pipeline is clean" while the real blocker
sat in a store it never read. **When a cleanup tool reports absence, the answer is usually a
control in the product, not a better script.**

---

## Stage 2 — JOB-004, the presentation fixes (small, visible)

Two changes, both confirmed real, both customer-facing.

1. **Name placeholders.** Forms sitewide show hardcoded `Patrick` / `Lalande` in the first and
   last name fields. Verified in incognito 2026-08-01 — every customer has seen Patrick's name in
   their own name fields. Replace with `First` / `Last`.
   **Leave email and phone placeholders alone** — `you@example.com` and `(905) 555-0100` show
   expected format, which is correct. Same for "Gate code, dog out back, hidden valve box, etc."
2. **Price visibility.** On `/book.html` service cards the price sits in small grey text under
   the heading. Patrick receives frequent "how much is this?" calls. Increase size and contrast.
   **Must hold up on mobile.**

**Acceptance:** open a form in incognito — fields read First / Last. Booking page prices legible
at a glance on a phone.

---

## Stage 3 — JOB-003, finish the intake consolidation

JOB-001 repointed the sitewide header and footer CTAs to `/book.html`, but deliberately left
in-body links alone. The result is a site whose chrome sends people one way and whose body
content sends them another — visible on the homepage, where the header button goes to booking and
a green "Get a Free Estimate" button goes to the estimator.

Remaining links to `/quote.html` and `/estimate.html`, inventoried 2026-08-01:

- 17 city pages — one "Build Your Quote" button each
- `index.html` — quote teaser widget, green CTA, FAQ estimator link
- `sprinkler-systems.html`, `sprinkler-installation.html`, `landscape-lighting.html`,
  `water-cost-calculator.html`, `process.html`, `faq.html`
- Five blog posts
- `quote-legacy.html`

**Decide before scoping:** `/quote.html` produced 4 leads and 0 conversions in three months
against booking's 29 and 28 — but VD-3 confirmed it works and tags correctly. `/estimate.html`
produces an external quotation combination the portal itself can't do (FLOW-05 finding). So this
is not simply "repoint everything." Ask what each page's in-body CTA should do before moving it.

---

## Stage 4 — The money path (the real remaining unknown)

**This is the highest-value item on the list and the only one that needs real investigation.**

FLOW-20 through FLOW-22 have never been walked: quote written → delivered to customer → viewed →
accepted → invoiced. Payments at the end of that chain are PASS (FLOW-23, five live captures).
The hops that get a quote in front of a customer are unverified.

Part 4's standing warning applies: assume nothing works until walked.

**Method — the same four passes that worked all week:**

1. **Investigate.** Where does a quote get written, how does it reach a customer, what does the
   customer see, how do they accept, what happens on acceptance. Read-only, report first.
2. **Map the hops.** Write the chain down before touching anything.
3. **Walk it.** Send a real quote to an address Patrick controls. Accept it. Follow it through to
   invoice.
4. **Register it.** PASS, PARTIAL, or BROKEN with the evidence.

**Ride along cheaply in the same investigation:**

- **FLOW-24** — a failed contact form shows the customer "Your message didn't send." Does anything
  tell Patrick? If not, that is a silent failure on an intake path.
- **FLOW-25** — the AI diagnostic tool at `/sprinkler-repair.html` carries a financial promise:
  *"correct diagnosis = 1 hr labour free."* It runs on a Cloudflare Worker and an API key — a
  dependency chain separate from Render and from email. If it misfires, Patrick is either
  honouring claims he didn't intend or breaking a public promise.

---

## Stage 5 — INF-02 phase two, and the tail

Only after everything above.

- **INF-02 phase two** — the transport question. Phase one made failure visible; phase two decides
  whether to move transactional mail off the single Workspace mailbox to a dedicated sender. This
  is a decision, not a task: it means DNS changes and a new account, with real risk of breaking
  email entirely if botched. **INF-01** (the `info@` send-as alias) folds in here.
- **INF-03** — DMARC is `p=NONE`, monitoring only. Revisit once mail transport is settled.
- **INF-04** — Workspace SMTP daily send cap. A known ceiling, relevant before any bulk or
  seasonal campaign sending.
- **CRM-03** — follow-up and owner fields exist and have never been used, on any of 56+ records.
  Only worth building around if Patrick will actually use them. **This is a business decision, not
  a defect.**
- **CRM-07** — merge the seven duplicate lead pairs. Demoted to Low: the portal renders by
  customer now, so customers are unaffected. What remains is CRM-list clutter and message threads
  split across pairs — a reply on the old record's thread won't appear on the one the customer
  landed on.
- **UI-01** — empty unlabeled input above "Your Zones" in the portal's System card. Find what
  writes to it before deleting.

---

## Standing items — not jobs, habits

- **Run `audit-stranded-wos.js` every few weeks.** The pattern that created 14 stranded work
  orders — dateless advance bookings plus manual close-out — is still how the business operates.
- **Glance at the Email health panel** when already in the CRM. Green with a recent last-send is
  healthy; a stale timestamp with quiet counts means email is down.
- **Verification debt (register Part 3.5)** ticks off through normal business: the next customer
  message proves FLOW-02, the next quote proves the accept card, GreenTree logging in proves the
  mid-project state.
- **One Claude Code session on the backend at a time.** Two parallel-session collisions have
  already occurred. Recovery worked both times; it should not be routine.

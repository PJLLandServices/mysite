# Letterhead Refactor — Blocking Investigation (Brief 1 of 2)

**Status: STOPPED AT THE §0 GATE. No renderer code changed.**

The brief instructs: *"If the investigation contradicts this brief, stop and report rather than
adapting the code to fit the brief."* It does. Two independent stop conditions fired — §6's
invoice re-render clause, and the discovery that the brief's central premise (four
implementations of *the same* letterhead) is not what is in the source tree.

Everything below is read from source, not inferred.

---

## Executive summary

| # | Item | Finding |
|---|---|---|
| I-1 | Invoice renderer | `server/lib/invoice-pdf.js`, standalone lib. **Missing from the `SYSTEM_OVERVIEW.md` table — doc bug confirmed.** |
| I-2 | Draw sites | Not four. **5 renderer files, 8 header sites, 7 footer sites.** `rfq-pdf.js` is a sixth renderer the brief never mentions; `quote-pdf.js` has **three** render paths, not two. |
| I-3 | Frozen vs re-rendered | PO frozen ✓. WO frozen ✓. **Quote frozen** (brief said unknown). **Invoice re-rendered on demand, always.** |
| I-4 | Font | One TTF, one key (`Barlow-Bold`), consistent across all five. Base-14 Helvetica body split is intentional. |
| I-5 | Logo | One file, `server/assets/logo-dark.png`, 1000×574 RGBA. No drift. **`po-pdf.js` / `rfq-pdf.js` use no logo at all.** |
| I-6 | Identity drift | Street + GST are hardcoded literals in 3 renderers. **But the sender email already differs at runtime between renderer families** — naive consolidation breaks the pixel gate. |
| I-7 | §2 geometry | §2 describes **`invoice-pdf.js` only**. It is not a shared spec. |

**The headline:** there is no single letterhead to extract. There are three unrelated document
designs. Extracting one shared helper across them is not a refactor — it is a redesign of four
document types, which §6 forbids.

---

## I-1 — The invoice PDF renderer

- **Path:** `server/lib/invoice-pdf.js` (795 lines)
- **Export:** `module.exports = { generateInvoicePdf }` — `generateInvoicePdf(rawInvoice) → Promise<Buffer>`
- **Standalone lib**, not inline in `server.js`. Returns a Buffer (not a stream) specifically so
  one call site can both stream to HTTP and attach to email.
- Header comment references `_design/invoice-pdf-preview.html` as the design source.

**Documentation bug confirmed (for §7).** The `server/lib/` table in `SYSTEM_OVERVIEW.md` has rows
for `quote-pdf.js` (L134), `po-pdf.js` (L136) and `wo-report-pdf.js` (L137). There is **no
`invoice-pdf.js` row anywhere in the table.** `rfq-pdf.js` is also absent from the table (it is
described in prose at L989, but not listed as a lib).

**A stale comment inside the file itself** (L19–22) claims *"Existing quote-pdf.js + po-pdf.js use a
text wordmark in their headers; this file follows that convention."* That is no longer true — the
invoice, quote and WO renderers all embed the logo PNG; only the wordmark **fallback** path remains.

---

## I-2 — Every header/footer draw site

**5 renderer files · 8 header blocks · 7 footer blocks.**

| File | Header sites | Footer sites |
|---|---|---|
| `invoice-pdf.js` | `drawHeader` **356–411** | `drawFooter` **771–793** |
| `quote-pdf.js` | `renderPdfHeader` **81–134** (shared by all 3 paths) | **3 duplicates**: 429–444, 594–610, 1322–1334 |
| `po-pdf.js` | `drawTopRule` **158–164**, `drawHeaderFull` **165–209**, `drawHeaderCondensed` **211–224** | `drawFooter` **438–462** |
| `rfq-pdf.js` | `drawTopRule` **161–167**, `drawHeaderFull` **168–213**, `drawHeaderCondensed` **215–228** | `drawFooter` **378–402** |
| `wo-report-pdf.js` | inline in `generateWoReportPdf`, **~441–500** (no named function) | `drawFooter` **291–306** + `wirePerPageFooter` **311–319** |

**Three render paths in `quote-pdf.js`, not two.** `renderQuotePdf` (L1343) dispatches on
`quote.type`:
- `project_proposal` → `renderProjectProposalPdf` (L476)
- `ai_repair_quote` **with `narrativeKey`** → `renderSmartControllerPdf` (L1239) ← the brief misses this one
- everything else → `generateQuotePdf` (L146)

**`quote-pdf.js` has already solved this problem internally.** `renderPdfHeader` is a single shared
header for all three paths, written for exactly the reason this brief exists (its comment: *"Born
from a repeat spacing bug: per-renderer headers kept printing a full-width company contact strip
that ran underneath the logo"*). Its **footer**, however, is copy-pasted three times, byte-identical.

---

## I-3 — Frozen vs re-rendered *(the risk item)*

| Document | Behaviour | Evidence |
|---|---|---|
| **PO** | **Frozen** | `pdfPath` / `csvPath` persisted by `purchase-orders.markSent` (L330–349). |
| **WO report** | **Frozen** | `server/data/wo-reports/<woId>/<snapshotId>.pdf`, SHA-256 per snapshot (`wo-report-snapshot.js` L13, L50). |
| **Quote** *(all 3 paths)* | **FROZEN** — brief listed this unknown | `pdfPath` / `pdfSha256` / `pdfGeneratedAt` on the record; `serveQuotePdf` (server.js L2818) serves frozen bytes for sent quotes, live-renders drafts only. |
| **Invoice** | **RE-RENDERED ON DEMAND, EVERY TIME** | No `pdfPath` field exists on invoices anywhere. |

### Invoices — all six call sites re-render from the live record

| Call site | What it does |
|---|---|
| `server.js:2559` | Stripe receipt email after payment |
| `server.js:6069` | Customer-portal PDF view |
| `server.js:7773` | **The invoice email to the customer** |
| `server.js:8641` | Admin `GET /api/invoices/:id/pdf` (view + download) |
| `server.js:12766` | Project-complete email attachment *(broken — see Appendix A)* |
| `deposits.js:123` | Deposit invoice |

**Consequence.** An invoice PDF a customer received in May is not stored. If they open their portal
link today, or Patrick re-downloads it, the bytes are generated fresh from the current record and
the current renderer code. **Any change to `drawHeader` retroactively changes the appearance of
every invoice ever issued** — including ones already emailed, already paid, and already filed for
tax. This is the exact collision with snapshot-immutability that §0 I-3 flagged as the risk item,
and §6 says: *"If I-3 finds invoices are re-rendered on demand, document it and stop."*

### A second, subtler landmine: the quote lazy-backfill

`serveQuotePdf` (server.js L2841): a **sent** quote with **no** snapshot yet freezes *on next read*.
There is a population of legacy sent quotes whose bytes are not yet fixed. If the letterhead changes
and one of those is opened afterward, it freezes **post-refactor** geometry and stamps it
`pdfBackfilled: true` — permanently, with a SHA-256 that now attests to a document the customer
never received. §5's "existing frozen artifacts on disk are untouched" does not cover this case,
because these artifacts don't exist on disk yet.

---

## I-4 — Font registration

- **One TTF:** `server/assets/fonts/BarlowCondensed-Bold.ttf` (104,316 bytes). Only the **Bold**
  weight exists. Confirmed present.
- **All five renderers resolve it independently** with identical logic — a module-level
  `BARLOW_BOLD_PATH` + a lazy `barlowBuffer()` cache + `doc.registerFont("Barlow-Bold", buf)`.
  Identical font-name key in all five. Identical `Helvetica-Bold` fallback when the file is missing.
- **Body text is base-14 `Helvetica` / `Helvetica-Bold` everywhere.** The split is **intentional and
  documented** — `invoice-pdf.js` L15–17 says Helvetica is *"visually indistinguishable from DM Sans
  at small print sizes and saves shipping a second TTF"*, and the `SYSTEM_OVERVIEW.md` quote-pdf row
  states it as a rule. Matches the reference artifact. **Consistent across all five.**

Centralizing registration is *probably* subset-neutral (same buffer, same glyph set, same key), but
it is not free: each renderer currently owns a per-module cache, and `po-pdf.js`/`rfq-pdf.js` never
load the logo at all. This would need per-renderer byte verification before it could be claimed.

---

## I-5 — Logo asset

- **One file:** `server/assets/logo-dark.png` — **1000 × 574**, bit depth 8, **PNG colour type 6
  (RGBA)**. Exactly matches the reference artifact's "1000×574 RGB image with a separate soft mask" —
  pdfkit splits the alpha channel into an `/SMask` at embed time.
- **No drift.** `invoice-pdf.js` (L76), `quote-pdf.js` (L29) and `wo-report-pdf.js` (L47) resolve the
  same path. There are no copies.
- **`po-pdf.js` and `rfq-pdf.js` embed no logo at all** — their header is a text lockup in Barlow
  Condensed plus a 4pt green top rule.
- Transparency is handled entirely by pdfkit from the PNG's own alpha; no renderer does manual
  masking. The §4 "preserve whatever masking the current renderers do" concern is a non-issue —
  **but** it does mean any shared helper must support a *no-logo* mode for the supplier documents.

---

## I-6 — Identity data source *(the drift already in flight)*

`company.js` exports `NAME`, `CITY`, `PHONE`, `WEBSITE`, `GREEN_HEX`, `FALLBACK_EMAIL`, `email()`.
It has **no street address and no GST/HST registration.** Its own migration note (L20–23) already
admits `invoice-pdf.js` + `quote-pdf.js` still hardcode the constants.

### Where the two fields actually come from — hardcoded string literals

| File | Line | Literal |
|---|---|---|
| `invoice-pdf.js` | 375 | `"1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5"` |
| `invoice-pdf.js` | 377 | `"info@pjllandservices.com  ·  (905) 960-0181  ·  pjllandservices.com"` |
| `invoice-pdf.js` | 380 | `"GST/HST Reg. No. 757080940 RT0001"` |
| `invoice-pdf.js` | 784 | footer — name + GST + email + phone in one string |
| `quote-pdf.js` | 129–131 | street / phone / email, **stacked on separate lines** |
| `quote-pdf.js` | 440, 605, 1329 | footer ×3 — `"PJL Land Services · Newmarket, Ontario · (905) 960-0181 · pjllandservices.com"` |
| `wo-report-pdf.js` | 478, 480 | street + `·`-joined contact strip |

`po-pdf.js` and `rfq-pdf.js` are the **only** renderers already reading `company.js` correctly.

So yes — §3.3's premise holds, and this is genuine duplication. **But there is a trap that §3.3 does
not anticipate:**

> **The sender email already differs at runtime between the two renderer families.**
> `po-pdf.js` / `rfq-pdf.js` call `company.email()`, which returns `process.env.GMAIL_USER` and only
> falls back to `info@pjllandservices.com`. The invoice/quote/WO renderers hardcode the literal
> `info@pjllandservices.com`.
>
> On any deployment where `GMAIL_USER` is not literally `info@pjllandservices.com`, these already
> print **different addresses on different documents today**. Routing the customer-facing renderers
> through `company.email()` would therefore **change their rendered output** — silently, and only on
> production where the env var is set. That is a §5 pixel-gate failure that would not reproduce
> locally.

**Consequence for §3.3:** the street and GST can be added to `company.js` as plain constants safely.
The email **cannot** simply be swapped to `email()`. It needs its own constant, and the pre-existing
inconsistency needs a deliberate decision from Patrick — it is a real business-identity bug (two
different reply-to addresses on customer vs supplier paper), but fixing it is a visible change and
therefore out of scope for this brief.

---

## I-7 — §2's measured geometry vs. the code

**§2 is an accurate description of `invoice-pdf.js` and of nothing else.** Spot-checks against
source (code is authoritative, per the brief):

| §2 row | Code | Verdict |
|---|---|---|
| Margins left/right 40 | `MARGIN_X = 40` (L55) | ✓ |
| Logo x 412–572, top 28 | `PAGE_W - 40 - 160 = 412`; `top - 12 = 28` (L392) | ✓ |
| Title Barlow-Bold 30, x 40, top 46, green | L361–366, `characterSpacing: 1.5` | ✓ (top 40 + cap offset) |
| Sender name Helvetica-Bold 10, top 77.2 | `y = top + 38` = 78 (L372–374) | ✓ |
| Street Helvetica 9 / contact 9 / GST 8 | L374–380 | ✓ |
| Band `#F4F8EE`, hairlines `#EFEDE3` | `GREEN_TINT` / `HAIRLINE` (L31, L35) | ✓ |
| Band top 128 / bottom 224 | **`startY = doc.y + 4`; height computed from address line count** (L419, L429–436) | ⚠ **dynamic, not fixed** — 128/224 is one record's instance |
| Band heading Barlow-Bold 14 | only drawn when `inv.billTo.company` is set (L446–450) | ⚠ **conditional** |
| Meta row / table header / rules | `drawDetailsStrip`, `drawLineItems` | **out of scope** — §6 forbids touching these |
| Footer Helvetica 8 grey centred | L782–789, at `page.height - 30` | ✓ |

### Where §2 does **not** describe the other four renderers

| | invoice | quote | wo-report | po / rfq |
|---|---|---|---|---|
| `MARGIN_X` | **40** | **60** | **60** | **36** |
| Body text | `#1A1A1A` | `#1F2A22` | `#1F2A22` | `#1F2A22` |
| Muted text | `#7A7A72` | `#6A6A60` | `#6A6A60` | `#5A5F58` / `#888780` |
| Rule colour | `#EFEDE3` | `PJL_MUTED` | `#D6D6CC` | `#D3D1C7` |
| Logo | PNG | PNG | PNG | **none** — text lockup |
| Green top rule | no | no | no | **yes, 4pt full-bleed** |
| Contact layout | one `·`-joined strip | **stacked lines** | one `·`-joined strip | stacked, from `company.js` |
| GST/HST shown | **yes** | no | no | no |
| Footer y | `height - 30` | `height - 50` | `height - 38` | `height - 42` |
| Footer content | name+GST+email+phone | name+city+phone+web | name+doc type+id+page № | name+city+phone+email |

**Three distinct design families, not one letterhead:**
1. **Customer-facing title-and-logo** — invoice, quote, WO report. Similar *shape*; different
   margins, palettes and contact formatting.
2. **Supplier-facing rule-and-wordmark** — PO, RFQ. Different palette, no logo, different geometry.
   `rfq-pdf.js` is a near-verbatim clone of `po-pdf.js` (deliberately — `SYSTEM_OVERVIEW.md` L990
   calls it a *"standalone sibling, not a parameterization"*).
3. The WO footer carries per-page numbering and a document-type label, so it is not a contact
   footer at all.

A `drawLetterhead(doc, opts)` that serves all five would need margin, full palette, logo on/off,
top-rule on/off, contact-layout mode, GST on/off, and a per-page-numbering footer variant. At that
point the "shared" helper is a switch statement over five callers with no shared geometry — it moves
the duplication, it doesn't remove it.

---

## Additional finding: the §2 letterspacing trap does not apply

§2 warns that character spacing must not leak into later draw calls. **Verified clean.** No renderer
uses a canvas-level spacing setter — `grep` for `.characterSpacing(` and `.lineGap(` across
`server/lib/*.js` returns nothing. Every site passes `characterSpacing` as a **per-call option** to
`doc.text()`, which pdfkit scopes to that call. The hazard was real in the `reportlab`/`pdfplumber`
reverse-engineering work; it does not exist in this codebase.

---

## §5 acceptance gate — cannot be executed in this environment

| Gate item | Status |
|---|---|
| Render real records before/after | ❌ **impossible here** |
| Rasterize ≥150 dpi and diff | ❌ no `pdftoppm` / `mutool` / PyMuPDF / pdfplumber installed |
| `pdffonts` output identical | ❌ `pdffonts` not installed |
| `npm run lint:prices` / `lint:qb-mappings` / `test:pricing` | ✓ scripts exist and would run |

**Why the records are unavailable:** `.gitignore` L38–39 excludes `server/data/*`. This container's
`server/data/` holds exactly one file — `project-rates.json`. There is no `invoices.json`,
`quotes.json`, `work-orders.json` or `purchase-orders.json`. **Invoice `I-2026-0060` and every other
reference record named in §5 exist only on the Render instance.**

### The good news — a *stronger* gate than §5 asks for is buildable

I installed deps and ran `_design/invoice-pdf-smoke.js` (an existing synthetic-fixture harness for
invoices). It renders fine. I then rendered the same fixtures twice and compared bytes:

- Same size, **64 differing bytes out of 55,943**.
- Diff is confined to exactly two things: object 15, `/CreationDate (D:20260820125504Z)`, and the
  trailer `/ID [<…> <…>]`.
- **Every content stream, font subset and embedded image is byte-stable.**

So once masked for `/CreationDate` and `/ID`, PJL's PDFs are **deterministic**, and a byte-for-byte
comparison is available. That is strictly stronger than a 150 dpi raster diff (it catches sub-pixel
shifts a rasterizer would round away) and needs no extra tooling. **Recommend replacing §5's raster
diff with a masked byte-compare** whenever this work does proceed.

It still needs the real records. The harness must run where the data is.

---

## Recommendation

**Do not proceed with §3.1/§3.2 as written.** Three things must be settled first:

1. **Invoices are re-rendered on demand.** §6 says stop. Beyond this brief, that is a live
   correctness problem on its own — reprinting a paid invoice can silently produce a different
   document than the customer was sent. Worth its own brief; freezing invoices to match PO/WO/quote
   is the obvious fix, and it would also *de-risk* this refactor by removing the retroactive-change
   hazard entirely. **Freezing invoices first, then doing the letterhead work, inverts the risk.**

2. **The shared-letterhead premise doesn't survive contact with the source.** The five renderers do
   not draw the same letterhead. A helper that serves them all is a parameter bag, not a
   deduplication. If the real goal is §1's *"produce a one-off document on PJL letterhead without
   reverse-engineering a sent PDF"*, that goal is fully served by Brief 2 defining **one canonical
   letterhead** (the invoice's — it is the most complete, and the only one carrying the GST
   registration) and leaving the existing five renderers alone.

3. **What genuinely *is* duplicated, and could be cleaned up safely today** — a much smaller,
   lower-risk piece of work:
   - `quote-pdf.js`'s **three byte-identical footers** (L429–444, L594–610, L1322–1334) → one local
     helper. Single file, no cross-renderer geometry, trivially verifiable.
   - `po-pdf.js` / `rfq-pdf.js` — near-identical twins. Deliberate per `SYSTEM_OVERVIEW.md`, so this
     needs Patrick's call before touching.
   - Street + GST → `company.js` as constants (**not** routed through `email()` — see I-6).
   - The five copies of the `barlowBuffer()` / `logoBuffer()` loader pair → one small asset module.
     This is pure I/O plumbing with no geometry, so it carries none of the pixel risk.

### Questions for Patrick

1. Should invoices be frozen on send (matching PO / WO / quote)? That is the real finding here.
2. Given three distinct document designs — is the goal still one shared helper, or one canonical
   letterhead *spec* for new documents, with the existing renderers left as-is?
3. Customer paper says `info@pjllandservices.com`; supplier paper says whatever `GMAIL_USER` is.
   Intentional, or should they converge? (Converging is a visible change.)
4. The §5 gate needs production records. Should this work be verified on the Render instance, or
   should a fixture corpus be committed for quotes/POs/WOs like `invoice-pdf-smoke.js` already
   provides for invoices?

---

## Appendix A — pre-existing bug found in passing (not fixed; out of scope)

**`server/server.js:12766–12773`** — the project-complete customer email treats `generateInvoicePdf`
as a **stream**, but it returns a **`Promise<Buffer>`**:

```js
const pdfDoc = invoicePdf.generateInvoicePdf(invoice);   // ← a Promise
const chunks = [];
await new Promise((resolve, reject) => {
  pdfDoc.on("data", (c) => chunks.push(c));              // ← TypeError: pdfDoc.on is not a function
  ...
});
```

`Promise.prototype.on` does not exist, so this throws immediately, is swallowed by the enclosing
`catch` (L12780), and logs `[project-complete] invoice PDF attach failed`. **The project-completion
email has been going out with no invoice attached.** Every other call site correctly `await`s the
promise. Confirmed by reading the call sites, not executed — it needs a real project record.

## Appendix B — noted, deliberately preserved, not changed

Per §4 *"do not improve anything"* — flagged for a later brief:

- `invoice-pdf.js` L19–22 stale comment (claims the renderers use a text wordmark).
- `company.js` L20–23 migration note is out of date — it omits `wo-report-pdf.js` and `rfq-pdf.js`.
- Both `invoice-pdf.js` and `quote-pdf.js` hold a `HST_RATE = 0.13` constant; `invoice-pdf.js` also
  defines `BORDER = "#E2E0D4"`, which nothing in the file references.
- Four different muted-grey values and four different hairline values across five renderers, with no
  single palette module. `style.css :root` matches the **invoice** values only.
- The three quote footers print `company.CITY` ("Newmarket, Ontario") while the quote *header* two
  hundred lines above prints the full street address. Inconsistent, but shipped.

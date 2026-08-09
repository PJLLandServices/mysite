# JOB-009 — Shallow sweep (CRM-04, CRM-05, CRM-06, MISC-01, MISC-02)

**Dispatched 2026-08-07** per the closeout plan, Stage 1. Five register items too small
for their own cycles, bundled into one sweep. None touches a PASS flow.

## Investigation findings (2026-08-07, before implementation)

- **MISC-01 is not a broken-link problem.** All four pages exist in the repo
  (`sprinkler-service-toronto/north-york/lawrence-park/forest-hill.html`) and the sitewide
  footer links them correctly — they deploy from main like every other page, so they do not
  404. The only real gap: `sitemap.html`'s Service Areas section omits them. (Live 200s
  could not be confirmed from the sandbox — outbound to the site is blocked — so the
  acceptance test keeps the four taps.)
- **CRM-04/05 need no new deletion code.** The CRM already has a full soft-delete system:
  bulk delete → `/admin/trash` view → 30-day retention → purge. Deleting through it is
  safer than any new script (recoverable for 30 days, uses the existing tested path).
  What's missing is only identification: a read-only scanner that lists the candidates.
- **CRM-06 root cause:** `/commercial-new-customer` deliberately serves the same
  `new-customer.html` file (one source of truth — commercial mode is chosen client-side
  from the URL path). So the residential `<title>`, canonical, and meta description ship
  on both URLs. Fix must preserve the single-file design: rewrite the three head tags
  server-side when serving the commercial route. Note: the page is `noindex, nofollow`,
  so this is about the browser tab, bookmarks, and link shares — not search ranking.
- **MISC-02 confirmed:** Services says 10, lists 11. Book/Quote/Estimate says 3, lists 4.
  Service Areas says 14, lists 14 — becomes 18 after the MISC-01 rows. Main Pages (6),
  Legal (4) are correct. Blog says 15 and lists 15 — consistent, though the list is a
  curated subset (~39 blog pages exist; `blog.html` is the full index). Left as is.

## Tasks

1. **CRM-04/05 — identify test + spam leads.** `scripts/find-test-leads.js`, read-only,
   run on the Render shell. Scans `leads.json` (skipping records already in Trash) for:
   - the `John Charette` fake booking and the `Jeff John` VD-3 test lead (name match);
   - `+`-tagged emails from the JOB-001 acceptance runs;
   - spam heuristics: URLs or SEO-pitch phrasing in the message/notes fields.
   Prints one table with id, name, email, source, CRM status, created date, bucket, and a
   linked-records warning (booking envelope / customerId) so nothing entangled gets
   deleted blind. **Deletion itself happens in the CRM UI** via the existing bulk delete →
   Trash flow. The script deletes nothing.
2. **CRM-05 — spam defense report.** Written findings only (below). No CAPTCHA, no new
   gating without Patrick's explicit word.
3. **CRM-06 — commercial metadata.** In `serveStatic`, when the route is
   `/commercial-new-customer`, serve `new-customer.html` with `<title>`, canonical, and
   meta description rewritten to commercial variants. Exact-string replacement; if the
   source strings ever drift, the page serves unmodified rather than breaking. The
   residential URL's bytes are untouched.
4. **MISC-01 — sitemap coverage.** Add Toronto, North York, Lawrence Park, Forest Hill to
   `sitemap.html`'s Service Areas section (footer ordering: after Thornhill/Markham,
   before Bolton), descriptions sourced from each page's own meta description.
5. **MISC-02 — counters.** Services → 11, Book/Quote/Estimate → 4, Service Areas → 18.

### Addendum (2026-08-07, during acceptance)

Patrick's step-2 walk surfaced that the change was invisible on the page itself — the
hero still read "New customer intake" on the commercial route (the visible heading was
never part of the registered defect). Per his ruling, the same server-side rewrite now
also swaps the `<h1>` to **"New commercial customer intake"** on
`/commercial-new-customer`. Residential route unchanged. Acceptance step 2 gains: the
green banner on the commercial URL reads "New commercial customer intake".

### Addendum 2 (2026-08-09) — re-verification + scanner hardening

Stage-1 re-dispatch. The four code items were already shipped; this pass verified them
against a running server rather than by reading the diff, and hardened the one piece that
had never been exercised.

**Verified locally (server booted, routes actually requested):**

| Item | Check | Result |
|---|---|---|
| CRM-06 | `/commercial-new-customer` head tags + `<h1>` | All four rewritten — title, canonical, description, hero |
| CRM-06 | `/new-customer` response vs `new-customer.html` on disk | **Byte-identical** — residential route untouched |
| CRM-06 | The four exact-match source strings still present in `new-customer.html` | All 4 present — no silent no-op |
| MISC-01 | The four city pages requested over HTTP | **200 each** (see finding below) |
| MISC-02 | Declared counter vs hand-counted `<li>` per section | 6/11/4/18/15/4 — **all six match** |
| — | `npm run build:check` | Green (86 files in sync; 757 assertions, 0 failures) |

**MISC-01 — settled, not a broken link.** All four pages exist, return **200** from the
same server that serves production, are referenced by **84 pages** each (the sitewide
footer), and appear in `sitemap.xml`. The register's "four taps to confirm whether they
404" is answered: they do not 404. The only real gap was the `sitemap.html` omission,
already fixed. *Caveat unchanged from the first pass:* outbound to
`www.pjllandservices.com` is blocked from the sandbox by proxy policy, so this is a local
200, not a production 200. Patrick's footer taps remain the production confirmation.

**Scanner hardening (CRM-04/05) — a real false positive, found by testing it.** The
scanner had never been run against data. Exercised against a fixture of nine leads
covering every bucket, it flagged **a real, won customer as spam**: a contact-form message
reading *"Saw your review page at https://g.page/pjllandservices and wanted to ask about a
drip retrofit"* matched the bare-URL pattern. Bulk-deleting the `spam` bucket on that
output would have deleted a paying customer. Fixed, still read-only and still deleting
nothing:

- **`WHY` column** — names the matched signal (`link-building`, `guest-post`, `url-only`…),
  so a row can be judged without opening the record. Bare-URL patterns are ordered last, so
  a row reading `url-only` matched *nothing but a link*.
- **`KEEP?` column + a loud footer block** — a spam-bucket row carrying a booking, a
  customer record, or a CRM status past `new` is called out by name as a probable real
  customer. Flag, not filter: the row still prints, the judgement stays Patrick's.
- Name-match and `+`-tag buckets are deliberately **not** flagged — those are deliberate
  acts, not inference, so they cannot misfire on a stranger.

Confirmed against the fixture: already-trashed records skipped; `\bseo\b` does not match
"season" in a real note ("come in the season opener window" — not flagged).

**`sitemap.xml` vs `sitemap.html` — raised 2026-08-09, no repo defect found.** Patrick
checked `https://www.pjllandservices.com/sitemap.xml` and read it as missing the four city
URLs. In the repo they are all present and have been for weeks:

- All **18** city pages appear in `sitemap.xml` (81 `<url>` entries total), the four
  included, each with `lastmod 2026-07-08`.
- They entered the file in **ccf7604, 2026-07-15** — on `main`, 109 commits back. Not new,
  not pending.
- `sitemap.xml` has **no server route** — `grep sitemap server/server.js` returns nothing.
  It is served as a plain static file straight off the deployed tree, so whatever is on
  `main` is what ships. Requested over HTTP from a locally booted server it returns **200**
  with all four `<loc>` entries.
- `generate-sitemap --check` is green — the file matches what the generator would produce.

**MISC-01 was never about `sitemap.xml`.** The register entry, the closeout plan, and the
fix all concern **`sitemap.html`** — the human-readable Site Map page, whose Service Areas
list omitted the four. `sitemap.xml` already had them; that is why the JOB-009 diff touched
`sitemap.html` only. The two files are easy to conflate when checking the fix.

If the *live* `sitemap.xml` genuinely lacks the four URLs, the repo is not the cause and the
next place to look is delivery, not content: a stale deploy on Render (compare the live
file against `main`), a CDN/browser cache (hard-reload, or fetch with cache disabled), or —
if this came from Search Console rather than the raw URL — Google showing its own last-read
copy, which lags the file. Outbound HTTPS to the live host is blocked from this sandbox
(CONNECT refused 403), so the live file could not be fetched here to settle it directly.

**The delete list itself is still un-generated.** `server/data/leads.json` is runtime data
that lives only on Render (gitignored, absent from the repo), and outbound HTTPS to the
live host is blocked from the sandbox by proxy policy — the CONNECT is refused 403. No
session running here can produce the list of records to delete. Patrick runs
`node scripts/find-test-leads.js` on the Render shell; the table it prints **is** the
confirmation list, and deletion stays in the CRM's bulk-delete → Trash flow.

## Constraints

- No PASS flow is touched. The only backend change is the head rewrite in the static
  file server — no intake handler, no API, no data model.
- Deletions go through the existing Trash flow only — recoverable for 30 days.
- No CAPTCHA or submission gating in this job.
- `npm run build:check` green before commit (sitemap.html edits must not break the
  build-sync or sitemap checks).

## CRM-05 report — what could catch human-sent spam beyond the honeypot

**The register's premise is out of date.** The intake gate (`server/lib/anti-bot.js`,
wired into `/api/quotes` before any disk write) is now five layers, not one: honeypot,
time-trap (<2.5 s or >30 days rejects), per-IP rate limit (5/10 min), email
normalization, and Cloudflare Turnstile (active when `TURNSTILE_SECRET_KEY` is set —
worth confirming it's set on Render). Every rejection logs to
`server/data/bot-blocked.log`.

None of that stops a human typing an SEO pitch at human speed and passing a Turnstile
challenge — which is exactly what CRM-05's two submissions were. The only remaining
option short of a gate that also taxes real customers:

1. **Content heuristics → flag, don't block** (recommended if anything). The lead schema
   already carries `botFlagged`; the same URL-and-SEO-vocabulary logic the JOB-009
   scanner uses could set it at intake, so suspect leads arrive pre-flagged for review
   instead of sitting in the pipeline as apparent leads. No legitimate customer is ever
   blocked; worst case a real lead wears a flag Patrick clears in one click.
2. **Stricter challenge levels** (Turnstile managed → interactive) — taxes every real
   customer and still doesn't stop humans. Not recommended.

At two spam submissions total, the recommendation is option 1 or nothing: the volume
doesn't yet justify even its own job. Patrick decides.

### CRM-05 sourcing (2026-08-09) — two corrections to the report above

The spam-defense report was written from the prior session's summary. Read against the
source, two things in it are wrong:

1. **Four blocking checks, not five.** `checkSubmission()` (`server/lib/anti-bot.js:230`):
   honeypot (233), time-trap (240), per-IP rate limit (258), Turnstile (268). Email
   normalization (292) is labelled in its own comment *"informational, not a reject path"* —
   it computes a dedupe key and blocks nothing. Wired at two call sites only:
   `server.js:4448` (`POST /api/quotes`, where `contact.html:595` posts — CRM-05's path) and
   `server.js:17607` (booking).
2. **`POST /api/new-customer` is not gated at all** — recorded as **CRM-14**. Found while
   checking call sites for claim 1.

**Turnstile confirmed armed 2026-08-09.** Patrick verified both `TURNSTILE_SECRET_KEY` and
`TURNSTILE_SITE_KEY` are present in the Render environment. The check mattered because of
the asymmetry in how that layer fails: a **missing** secret disables Turnstile silently
(`anti-bot.js:272` short-circuits with no error, no log entry), while a **wrong** secret
fails closed and rejects every submission — visible immediately. Only the silent mode could
have been hiding, and it wasn't.

`botFlagged` (the flag-don't-block recommendation's target) is already fully plumbed: read
at `server.js:1153`, written at `:1244`, set by the `bot-spam` bulk tag
(`lib/bulk-actions.js:142`) whose button is `admin.html:718`. Leads can be flagged by hand
today; the recommendation only adds setting it automatically at intake.

## Acceptance test (Patrick walks it)

1. **CRM-04/05:** on the Render shell run `node scripts/find-test-leads.js`. Review the
   table — it should list John Charette, Jeff John, any `+`-tagged acceptance leads, and
   the two SEO-spam submissions, and nothing you recognize as a real customer. Delete the
   listed records in the CRM (bulk delete). Confirm the pipeline list no longer shows
   them and `/admin/trash` does.
2. **CRM-06:** open `/commercial-new-customer`, view source: title reads "Commercial
   customer intake — PJL Land Services", canonical ends `/commercial-new-customer`,
   description mentions commercial properties. Open `/new-customer`, view source:
   unchanged residential metadata. Both forms still render and (optionally) submit.
3. **MISC-01:** from any page footer, tap Toronto, North York, Lawrence Park, Forest
   Hill — all four load.
4. **MISC-02:** open `/sitemap.html` — Service Areas lists 18 cities including the four
   above; every section counter matches a hand count of its list.

**Register on close:** CRM-04, CRM-05, CRM-06, MISC-01, MISC-02 closed with this
acceptance record; CRM-05 carries the spam-defense finding and Patrick's decision.

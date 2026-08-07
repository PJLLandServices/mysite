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

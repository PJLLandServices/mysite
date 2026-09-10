---
name: seo-competitor-intel
description: Competitive SEO intelligence for pjllandservices.com — for the top gap-zone keywords, finds who outranks us, explains specifically why each competitor page wins, assigns a threat level, and lists quick wins and keywords to avoid. Also runs a "competitor gap check" against a named competitor domain. Use when asked "who's beating us", "run competitor intelligence", or "gap check against [domain]".
---

# Competitor Intelligence — who is beating us, and why

You are a competitive SEO analyst for PJL Land Services (sprinkler and
irrigation contractor, Newmarket / York Region / GTA). Read
`seo/README.md` once per session if you have not.

Rule one: **be specific, never generic.** "They have more backlinks" is not
a finding. "Their title carries '2026' and a price; ours carries neither"
is. Every "why they win" must be something Patrick could verify by opening
the two pages side by side, and every fix must name the file on our side.

## Steps

1. Read the newest `seo/reports/gap-analysis-*.md`. If none exists, run
   the `seo-gap-finder` skill first.
2. Take the top 5 keywords from its opportunity cards (10 if asked).
3. For each keyword, search the query with WebSearch (Canadian / Ontario
   context — add "Ontario" only if the query lacks a town) and identify
   the top 3 organic results outranking our landing page. Note whether a
   map pack, a Google AI Overview, or a People Also Ask block is present.
4. Open each competitor page (WebFetch) and analyse why it ranks:
   title and H1 wording, publish / updated date, word count, presence of
   a price or a comparison table or step list, town-specific content,
   internal-link depth, schema, whether it is a directory or manufacturer
   page. Compare against our page's inventory
   (`node scripts/seo-site-inventory.mjs --page FILE`).
5. Assign a threat level (below) and write one actionable insight.
6. Save to `seo/reports/competitive-YYYY-MM-DD.md` in the format below.

## Threat levels — local-service edition

- **HIGH** — structural advantages we should not attack head-on:
  directories and marketplaces (HomeStars, Yelp, Houzz, TrustedPros),
  manufacturer sites (Hunter, Rain Bird, Orbit), big-box retailers, a
  municipality's own page for bylaw queries, national publishers.
  Recommendation: a related angle we can own (the town-specific version,
  the "what it costs in York Region" version, the how-to the directory
  cannot write).
- **MEDIUM** — an established local irrigation company with a dedicated
  page for the query. Beatable in 30–60 days by matching the one or two
  things they do better and adding what only we have (published prices,
  the Hydrawise standard, the 3-year warranty, same-day repair).
- **LOW** — thin page, forum thread, generic national blog, or a page
  ranking by coincidence. One solid article or one title update wins.

If the SERP is led by a map pack, say so: that keyword is decided by the
Google Business Profile more than by the page, and the on-page fix is the
secondary lever.

## "Why they win" — the bar

Good:
- "Title: 'Sprinkler Winterization Aurora – $79 Blowout (2026)'. Price and
  year in the title; ours has neither. Fix: add the fall-closing price via
  a `data-price` token to the H1 area of `sprinkler-service-aurora.html`
  and put the season year in the title."
- "1,900-word guide with a 6-row 'DIY vs pro' table above the fold. Our
  `blog-diy-sprinkler-blowout-ontario.html` is 900 words with no table.
  Fix: add the table under the first H2."
- "Ranks on domain strength only — 300 words, no town named, last updated
  2022. Beatable with the post we already have if it gets 3 inbound links."

Not acceptable: "better authority", "more content", "stronger backlinks",
"better UX".

## Competitor gap check (Thursday)

Trigger: "Run a competitor gap check against [domain]".
Fetch the competitor's sitemap or main navigation (WebFetch), list the
service and blog topics they cover, and diff against our inventory
(`node scripts/seo-site-inventory.mjs --stdout`). Output up to 10 topics
they have that we do not, each with a one-line verdict (worth it / not
for us / already covered under another name) and the file we would create.
Save to `seo/reports/competitor-gap-[domain]-YYYY-MM-DD.md`.

## Report format — `seo/reports/competitive-YYYY-MM-DD.md`

```
# Competitive intelligence — YYYY-MM-DD
Source: seo/reports/gap-analysis-YYYY-MM-DD.md (top N keywords)

| Keyword | Our page (pos) | Competitor | Threat | Why they win | Fix |

## Quick wins — 3 LOW-threat competitors displaceable this month
## Avoid list — 3 HIGH-threat keywords, each with the alternative angle
## SERP features seen (map pack / AI Overview / PAA) per keyword
```

Trigger phrases: "Run competitor intelligence for this week's top
keywords" · "Who is outranking us for [keyword]" · "Run a competitor gap
check against [domain]".

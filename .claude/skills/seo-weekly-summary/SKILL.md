---
name: seo-weekly-summary
description: Friday one-page SEO summary for pjllandservices.com — what moved in rankings, what was published, competitive highlights, and the top 3 keyword targets for next week, saved to seo/reports. Use when asked for "the weekly summary", "what happened this week in SEO", or "top 3 for next week".
---

# Weekly summary — one page, five minutes to read

Read `seo/README.md` once per session if you have not.

## Inputs

1. Every file in `seo/reports/` and `seo/drafts/` dated this week
   (Monday to today). If there is no gap analysis this week, run
   `seo-gap-finder` first — a summary without ranking data is a diary.
2. What actually shipped: `git log --since="7 days ago" --name-only --
   '*.html' sitemap.xml` shows published or updated pages.
3. The previous weekly summary, so "top 3 for next week" can be checked
   against what was said last Friday. Say plainly which of last week's
   three got done.

## Output — `seo/reports/weekly-summary-YYYY-MM-DD.md`

```
# Weekly SEO summary — week of YYYY-MM-DD

## Rankings
Movers (3+ positions) from this week's gap analysis, best and worst, with
the page. One line on whether the snapshot window changed.

## Published / updated
Pages from git log, each with the keyword it targets.

## Competitive highlights
Two or three lines from this week's competitive report: the quick win
taken, the one being avoided.

## Last week's top 3 — done?
| Target | Status | Note |

## Top 3 targets for next week
1. keyword — page — the single action — why now (season)
2. …
3. …

## Needs Patrick
Anything blocked on him: a photo, a review, a price decision, a
check-in answer.
```

Keep it to one screen. No repetition of the full reports — link to them
by filename. Ask Patrick to confirm the top 3, and record his answer in
next week's plan.

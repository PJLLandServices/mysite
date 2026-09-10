# PJL SEO agent — setup and weekly rhythm

An adaptation of the "Claude Code SEO Agent Playbook" (three skills on a
weekly loop, driven by real Search Console data) for pjllandservices.com.
The playbook was written for DTC brands; this version is tuned for a local
irrigation contractor — town pages, seasonal demand, map-pack queries, and
the repo's own rules about prices and page structure.

It replaces nothing that already exists: `SEO_IMPLEMENTATION_PLAN.md` and
`Website_Audit_SEO_Action_Tracker.csv` remain the backlog of one-off fixes.
This folder is the **recurring** loop — what to target this week, who is
beating us on it, and what to write.

## What is where

| Path | What |
| --- | --- |
| `.claude/skills/seo-gap-finder/` | Monday: gap zone (positions 5–20) → 10 action cards + movement |
| `.claude/skills/seo-competitor-intel/` | Monday/Thursday: who outranks us and exactly why; competitor gap check |
| `.claude/skills/seo-brand-writer/` | Tuesday: brand interview, weekly check-in, 4-brief plan, article drafts |
| `.claude/skills/seo-weekly-summary/` | Friday: one-page summary + top 3 for next week |
| `seo/brand-voice.md` | The voice profile every draft is written from. **DRAFT until the interview is done.** |
| `seo/reports/` | Dated outputs: `gap-analysis-`, `competitive-`, `content-plan-`, `internal-links-`, `weekly-summary-` |
| `seo/drafts/` | Article drafts (markdown) pending review and publish |
| `seo/data/` | Search Console snapshots (`gsc-YYYY-MM-DD.json`) and `site-inventory.json` |
| `scripts/seo-gsc-pull.mjs` | Pulls 90 days of query + page data from Search Console (`npm run seo:gsc`) |
| `scripts/seo-site-inventory.mjs` | Title / description / H1 / word count / **body** inbound links per page (`npm run seo:inventory`) |
| `scripts/seo-gap-analysis.mjs` | Joins snapshot + inventory into the evidence the gap-finder reasons over (`npm run seo:gap`) |
| `scripts/seo-lib.mjs` · `scripts/test-seo-tools.mjs` | Shared pure helpers and their test (runs in `build:check`) |

The skills live under `.claude/skills/` so Claude Code loads them as
slash-invocable skills. `.gitignore` un-ignores that one directory
(everything else under `.claude/` stays private).

## One-time setup

1. **Search Console access (10 minutes, the only credential).**
   The script authenticates as a Google service account so it runs headless
   in Claude Code sessions and in CI without a browser OAuth step.
   1. [console.cloud.google.com](https://console.cloud.google.com) → create or
      pick a project → *APIs & Services* → *Enable APIs* → **Google Search
      Console API**.
   2. *IAM & Admin* → *Service Accounts* → *Create* (name it `pjl-seo`) →
      open it → *Keys* → *Add key* → JSON. Download the file.
   3. [search.google.com/search-console](https://search.google.com/search-console)
      → the `pjllandservices.com` property → *Settings* → *Users and
      permissions* → *Add user* → paste the service account's
      `client_email` (ends in `.iam.gserviceaccount.com`) → permission
      **Full** (Restricted also works for reads).
   4. Tell the script where the key is. Which way depends on where you run
      Claude Code — and never paste the key's contents into a chat message;
      conversations are stored.

      **Claude Code on the web (claude.ai/code):** there is no file to edit.
      Open *Environments* → the environment for this repo → *Environment
      variables* and add two entries:

      | Name | Value |
      | --- | --- |
      | `GSC_SITE_URL` | `sc-domain:pjllandservices.com` |
      | `GSC_SERVICE_ACCOUNT_JSON` | the entire contents of the downloaded JSON key file (open it in Notepad, select all, copy, paste — one long line is fine) |

      Save, then **start a new session** — variables only reach sessions
      created after they are saved. The new session must also have this
      folder's scripts: merge the PR that added them, or check out its branch.

      **Claude Code on your own computer:** create a file named `.env` in the
      repo folder (next to `.env.example`, never committed) containing:
      ```
      GSC_SITE_URL=sc-domain:pjllandservices.com
      GSC_SERVICE_ACCOUNT_FILE=/absolute/path/to/pjl-seo-key.json
      ```

      Either way, check the property type first: in Search Console's top-left
      dropdown, a property shown as `pjllandservices.com` is a domain property
      (use the `sc-domain:` form above); one shown as
      `https://www.pjllandservices.com/` is a URL-prefix property — use that
      full URL as `GSC_SITE_URL` instead.
   5. Test: `npm run seo:gsc` should print "Saved seo/data/gsc-….json — N
      queries …". A 403 means step 3 was skipped.
2. **Brand interview.** In Claude Code: *"Run the brand interview."* Eight
   questions, one at a time. It rewrites `seo/brand-voice.md` from DRAFT to
   CURRENT. Everything the writer produces depends on this.
3. **First run.** *"Run this week's gap analysis"*, then *"Run competitor
   intelligence for this week's top keywords"*, then *"Generate this week's
   content plan"*.

Optional: the playbook uses Apify's `rag-web-browser` for SERP scraping.
Claude Code's built-in WebSearch / WebFetch cover the same need here at no
cost; if an Apify MCP server is added later the competitor skill can use it
without changes to the process.

## The weekly rhythm (about 30 minutes of Patrick's time a day)

| Day | Prompt to Claude Code | Output |
| --- | --- | --- |
| Monday | "Run this week's gap analysis" then "Run competitor intelligence for this week's top keywords" | `seo/reports/gap-analysis-…md`, `competitive-…md` |
| Tuesday | "Generate this week's content plan" then "Write this week's article targeting [keyword]" | `content-plan-…md`, `seo/drafts/…md` |
| Wednesday | "Audit internal links for [the page published this week]" | `internal-links-…md` — 10 minutes to add the links |
| Thursday | "Run a competitor gap check against [competitor domain]" | `competitor-gap-[domain]-…md` |
| Friday | "Give me the weekly summary" | `weekly-summary-…md` — 5 minutes to review, confirm next week's top 3 |

Commit the reports and the snapshot each week; the folder becomes the
record of what worked. To automate the Monday and Friday runs, a Claude
Code Routine (scheduled trigger) can send those exact prompts into a
session on a cron — set that up once the credential step above is done,
otherwise every run stops at "credentials not configured".

## Publishing a draft

Drafts are markdown on purpose. Publishing is a separate, explicit step:
build the `blog-*.html` from a recent post's structure (BlogPosting
JSON-LD, partial markers, `data-price` tokens for any PJL price), add the
card to `blog.html`, then `npm run build` and `npm run build:check`. The
hardcoded-price linter and the sitemap check will catch the two most
common mistakes.

## Why the data layer is in scripts, not in the skills

The gap zone, movement, clustering, and inbound-link counting are
deterministic, so they are code with a test rather than instructions to
the model. The skills do the part that needs judgement — reading the page,
reading the SERP, choosing the fix. Inbound links are counted after
stripping the nav and footer partials; otherwise every page has 20+
inbound links and "zero internal links" can never be detected.

# PJL Land Services — SEO Implementation Plan

> **Companion to** [`WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md`](WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md) **and** [`Website_Audit_SEO_Action_Tracker.csv`](Website_Audit_SEO_Action_Tracker.csv).
> **Last updated:** 2026-04-27
> **Owner:** Patrick Lalande (PJL Land Services)
> **Format:** Five phases. Each task references its row in the CSV tracker (e.g. `Tracker ID 5`).

---

## How to use this plan

Each phase is a logical bundle. They are **roughly sequential** — Phase 1 before Phase 2 — but within a phase you can parallelize across roles (developer / marketer / owner).

For each task you'll see:

- **What** — the change
- **Why it matters** — the SEO / conversion / maintainability rationale
- **Files affected** — exact paths
- **Time** — rough hours
- **Difficulty** — Easy / Medium / Hard
- **Who** — Developer (D) / Marketer (M) / Owner (O)
- **Tracker ID** — to look up full detail in the CSV

**Time estimates assume a competent professional.** A first-time contributor will need 1.5–2× longer.

**Total estimate (all phases):** ~110–140 hours, spread across 9–12 months at a sustainable pace.

---

## Phase 1 — Critical Fixes (Week 1)

**Goal:** Stop bleeding leads and fix structural SEO errors. ~7–8 hours of work.

### 1.1 Fix duplicate `<h1>` on estimate.html
- **What:** Demote second `<h1>` (line 382) to `<h2>`.
- **Why:** Search engines split keyword authority when there are multiple H1s. Structural SEO error.
- **Files:** `estimate.html`
- **Time:** 15 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 1

### 1.2 Replace placeholder reviews with real ones
- **What:** Collect 5–10 real Google / HomeStars reviews. Insert into `reviews.html`. Uncomment the AggregateRating + Review JSON-LD schema (search the file for the comment block).
- **Why:** Reviews page is currently 100% template. No social proof. No review-rich-result eligibility. Single biggest local-SEO + conversion gap.
- **Files:** `reviews.html`
- **Time:** 3–4 hr · **Difficulty:** Medium · **Who:** O (provide reviews) + M (format and insert)
- **Tracker ID:** 2

### 1.3 Replace `mailto:` form with a real handler
- **What:** Sign up for Formspree (free 50 submissions/month tier) or Netlify Forms or Basin. Update `contact.html`'s form `action` and remove the `handleSubmit()` JavaScript that opens email client. Add success / error states.
- **Why:** Current form opens user's email client; if they close it, the lead is gone. Estimated 40–60% loss rate.
- **Files:** `contact.html`
- **Time:** 1–2 hr · **Difficulty:** Medium · **Who:** D
- **Tracker ID:** 3

### 1.4 Compress 8.1 MB SVG on homepage
- **What:** Open `about-section-picture.svg` in Inkscape or run through `svgo`. Either re-export at <300 KB or convert to a 100 KB WebP/JPG.
- **Why:** Single 8 MB asset dominates page weight on mobile. Lighthouse performance flag.
- **Files:** `about-section-picture.svg`, possibly `index.html` (if extension changes)
- **Time:** 30 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 4

### 1.5 Trim over-length meta descriptions
- **What:** Shorten 5 descriptions to ≤155 chars: `sprinkler-service-newmarket.html`, `sprinkler-service-aurora.html`, `blog-spring-fertilization-sprinkler-timing-gta.html`, `blog-landscape-renovation-sprinkler-prep-gta.html`, `blog-tree-irrigation-newmarket-gta.html`.
- **Why:** Google truncates beyond 155–160 chars in SERP. Looks unprofessional.
- **Files:** named above
- **Time:** 45 min · **Difficulty:** Easy · **Who:** M
- **Tracker ID:** 12

### 1.6 Strengthen weak titles
- **What:** Rewrite titles on `contact.html`, `estimate.html`, `quote.html`, `faq.html`. Add primary keyword + location. Stay 50–60 chars.
- **Why:** Generic titles ("Contact Us") cost SERP CTR.
- **Files:** named above (also update `og:title`, `twitter:title`)
- **Time:** 30 min · **Difficulty:** Easy · **Who:** M
- **Tracker ID:** 13

### 1.7 Add OG / Twitter / JSON-LD to legal pages
- **What:** Mirror the OG / Twitter / JSON-LD pattern from any standard page onto `privacy-policy.html`, `terms-of-service.html`, `accessibility-statement.html`.
- **Why:** Consistency for crawlers and social-share previews. Closes the 89% → 100% schema-coverage gap.
- **Files:** named above
- **Time:** 30 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 11

**End of Phase 1:** Site is structurally sound, leads are no longer being lost on contact form, page is no longer a Lighthouse performance disaster, all pages have full meta. Real reviews are live (or scheduled to go live).

---

## Phase 2 — High-Impact SEO Improvements (Weeks 2–4)

**Goal:** Capture currently-missed search demand. Strengthen internal architecture. ~25–30 hours of work.

### 2.1 Add BlogPosting schema to all 8 blog posts
- **What:** Use the existing schema on `blog-spring-sprinkler-opening.html` as a template. Add to each other blog post with appropriate headline / datePublished / dateModified / author / image / articleSection.
- **Why:** Google blog rich-results, author E-E-A-T, publication-date badges in SERP.
- **Files:** all `blog-*.html` (except `blog.html` index)
- **Time:** 1.5 hr · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 10

### 2.2 Build the Spring Opening service page
- **What:** New page `sprinkler-systems-spring-opening.html`. Localized for Newmarket / GTA. Pricing ($90), what's included, mid-April booking deadline urgency, last-frost guidance. FAQPage schema.
- **Why:** Captures highest-volume seasonal queries. Drives a flagship $90 service.
- **Files:** new file + `sitemap.xml` + cross-link from `index.html` and area pages
- **Time:** 3 hr · **Difficulty:** Medium · **Who:** M + D
- **Tracker ID:** 6

### 2.3 Build the Fall Winterization service page
- **What:** New page `sprinkler-systems-fall-winterization.html`. October booking urgency, freeze-damage risk messaging, low-pressure compressor mention. FAQPage schema.
- **Why:** Inverse seasonal capture. Currently only mentioned in blog and FAQ.
- **Files:** new file + `sitemap.xml` + cross-link
- **Time:** 3 hr · **Difficulty:** Medium · **Who:** M + D
- **Tracker ID:** 7

### 2.4 Build the Sprinkler Repair service page
- **What:** New page `sprinkler-systems-repair.html`. Common issues, diagnostic checklist, same-day guarantee, $95 mobilization fee, AI-Smart-Intake first-hour-free hook. FAQPage schema.
- **Why:** "Sprinkler repair near me" is the highest-converting query in irrigation. Year-round.
- **Files:** new file + `sitemap.xml` + cross-link
- **Time:** 3 hr · **Difficulty:** Medium · **Who:** M + D
- **Tracker ID:** 8

### 2.5 Build the Markham service-area page
- **What:** New page `sprinkler-service-markham.html` cloned from `sprinkler-service-aurora.html`. Localize for Angus Glen / Unionville / Cornell / Markham Village. Geo coords. Local FAQ.
- **Why:** Markham (~330k residents) is the largest unaddressed market. Single biggest geographic SEO win.
- **Files:** new file + `sitemap.xml` + cross-link
- **Time:** 4 hr · **Difficulty:** Medium · **Who:** M + D
- **Tracker ID:** 5

### 2.6 Add internal links from blog posts to services
- **What:** At the end of each `blog-*.html`, add a "Related services" card-group linking to relevant service page(s) + a primary CTA button.
- **Why:** Blog content currently has zero conversion path. Could lift blog→booking 5–10×.
- **Files:** all `blog-*.html`
- **Time:** 1 hr · **Difficulty:** Easy · **Who:** M
- **Tracker ID:** 14

### 2.7 Add Service Areas section to core service pages
- **What:** On `sprinkler-systems.html` and `landscape-lighting.html`, add a section listing all area pages (Newmarket / Aurora / King City / Richmond Hill / Vaughan / Markham once built) with linked tiles.
- **Why:** Improves internal-link equity to area pages. Reassures local prospects.
- **Files:** `sprinkler-systems.html`, `landscape-lighting.html`
- **Time:** 30 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 15

### 2.8 Decide and consolidate Estimate vs Quote
- **What:** Owner decision. Recommended: keep `quote.html` as the universal builder; convert `estimate.html` to a redirect or repurpose for landscape-lighting estimates only. Update all CTAs to use one consistent label.
- **Why:** Two near-identical conversion pages confuse users. Splits the funnel.
- **Files:** `estimate.html`, `quote.html`, plus CTA references in many pages
- **Time:** 1 hr · **Difficulty:** Easy · **Who:** O (decides) + D (implements)
- **Tracker ID:** 16

### 2.9 Add before/after gallery to landscape-lighting.html
- **What:** Add a native HTML grid (8–12 photos) showing installed lighting projects. Each with location and brief caption. No external plugin.
- **Why:** Buying decision for landscape lighting is visual-first. Estimated +15–25% conversion lift.
- **Files:** `landscape-lighting.html`
- **Time:** 4 hr · **Difficulty:** Medium · **Who:** O (provide photos) + M (format)
- **Tracker ID:** 9

### 2.10 Repository cleanup
- **What:** Move ~28 MB of dev-iteration screenshots and unused assets (`audit-*`, `postfix-*`, `about-debug-*`, `about-home-*-check.png`, `Home-{estate,large,small}.png`, `Same Day Service.svg`) to a `/dev-archive/` folder OR add to .gitignore + delete.
- **Why:** Cleaner repo. Smaller deploy. Easier maintenance.
- **Files:** various (verify each is unreferenced before removing)
- **Time:** 30 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 17

**End of Phase 2:** 4 new conversion-driving pages live (Spring / Fall / Repair / Markham). All 9 blog posts have proper schema. Internal-linking architecture is solid. Repository is clean. Lighting page has visual proof.

---

## Phase 3 — Content & Local Ranking Expansion (Months 2–4)

**Goal:** Expand geographic and topical coverage. Build authority through content. ~30–40 hours.

### 3.1 Build 3 more service-area pages
- **What:** Stouffville / East Gwillimbury / Thornhill (lighting-focused). Use the area-page template. Localize each.
- **Why:** Eastern York Region coverage gaps. Thornhill captures premium lighting searches.
- **Files:** new `sprinkler-service-stouffville.html`, `sprinkler-service-east-gwillimbury.html`, `sprinkler-service-thornhill.html`
- **Time:** 9 hr (3 hr each) · **Difficulty:** Medium · **Who:** M + D
- **Tracker IDs:** 18, 19, 20

### 3.2 Build 2 more service-specific pages
- **What:** Smart Controllers (Hydrawise) and Drip Irrigation. Each with own keyword cluster, schema, CTAs.
- **Why:** Captures retrofit market and diversifies offering beyond lawn irrigation.
- **Files:** new `hydrawise-installation.html`, `drip-irrigation.html`
- **Time:** 5 hr (2.5 hr each) · **Difficulty:** Medium · **Who:** M + D
- **Tracker IDs:** 21, 22

### 3.3 Build the Warranty page
- **What:** Document the 3-year warranty in detail: coverage table, claim process, exclusions, comparison to industry-standard 1-year.
- **Why:** Major trust differentiator currently buried in scattered mentions.
- **Files:** new `warranty.html`
- **Time:** 2 hr · **Difficulty:** Easy · **Who:** M
- **Tracker ID:** 23

### 3.4 Build the Process / How It Works page
- **What:** Walk through the install-to-finish journey for sprinklers + lighting. Reduces buyer hesitation for higher-ticket projects.
- **Files:** new `process.html`
- **Time:** 2 hr · **Difficulty:** Easy · **Who:** M
- **Tracker ID:** 24

### 3.5 Publish 4 high-priority blog posts
1. **How much does a sprinkler system cost in Ontario** (Tracker ID 26) — 2 hr
2. **When to turn on sprinklers in Ontario** (Tracker ID 27) — 1.5 hr
3. **Sprinkler maintenance checklist** (Tracker ID 28) — 1.5 hr
4. **Watering bylaws by York Region municipality** (Tracker ID 29) — 1.5 hr

- **Files:** new `blog-*.html` files for each
- **Total time:** 6.5 hr · **Difficulty:** Easy–Medium · **Who:** M

### 3.6 Build Pricing Guide page (owner-approved)
- **What:** "Starting at" rate card per service. Disclaimer that on-site visit calibrates final number.
- **Why:** Captures research-stage traffic. Trust signal — competitors usually hide pricing.
- **Files:** new `pricing.html`
- **Time:** 2 hr · **Difficulty:** Medium · **Who:** O (approves) + M (writes)
- **Tracker ID:** 25

### 3.7 Add Coverage / Service Area Map
- **What:** Embed Google Map with marked service area, OR create a stylized SVG map of York Region. Link to area pages.
- **Why:** Reduces out-of-area inquiries. Visual trust signal.
- **Files:** new `coverage-map.html` OR section on `contact.html`
- **Time:** 2 hr · **Difficulty:** Medium · **Who:** D
- **Tracker ID:** 61

**End of Phase 3:** 8 service area pages, 7 service-specific pages, 13 blog posts, plus warranty / process / pricing / coverage. Site has the depth to compete for any sprinkler / lighting query in York Region.

---

## Phase 4 — Authority-Building & Long-Term Growth (Months 4–9)

**Goal:** Build off-site signals. Win the local pack. ~25–30 hours of largely-marketing work.

### 4.1 Google Business Profile optimization
- **What:** Audit GBP completeness — verify business / hours / categories / 10+ photos / weekly posts. Pursue reviews actively. Use UTM-tagged links to track GBP→site traffic.
- **Why:** GBP is 60–80% of local-pack visibility. Free.
- **Files:** External (Google Business Profile)
- **Time:** 2–4 hr setup + ongoing · **Difficulty:** Medium · **Who:** O
- **Tracker ID:** 57

### 4.2 Citation & directory build-out
- **What:** Audit current presence on Yelp / HomeStars / TrustedPros / BBB / Yellow Pages / York Region Chamber. Create / claim missing listings. Ensure NAP (Name / Address / Phone) is byte-identical.
- **Why:** Citation consistency is a top-5 local-pack ranking factor.
- **Files:** External
- **Time:** 2–3 hr · **Difficulty:** Medium · **Who:** M
- **Tracker ID:** 58

### 4.3 Backlink strategy
- **What:** Pursue: York Region Chamber listing, local newspaper supplier directory, Hunter dealer locator, Hydrawise certified installer page (suppliers have these — claim yours), charity sponsorships with local-paper coverage.
- **Why:** Authority signal. Compounds over time. Local backlinks are 3–5× more valuable than generic ones.
- **Files:** External
- **Time:** Ongoing · **Difficulty:** Hard · **Who:** O + M
- **Tracker ID:** 59

### 4.4 Build 4 more service-area pages (lower priority)
- Caledon (premium estates focus)
- Whitchurch-Stouffville (if not subsumed by Stouffville page from Phase 3)
- Innisfil (already in FAQ as service area; back the claim)
- Ajax / Pickering (if owner expands south)

- **Files:** new `sprinkler-service-{caledon,whitchurch-stouffville,innisfil,ajax}.html`
- **Time:** 12 hr (3 hr each) · **Difficulty:** Medium · **Who:** M + D
- **Tracker IDs:** 45, 46, 47

### 4.5 Build 2 specialty service pages
- ~~**Backflow Testing**~~ — **CANCELLED 2026-04-27.** PJL does NOT hold an Ontario backflow tester certification; building this page would have been false advertising. Instead, the seasonal-service pages (Spring Opening / Fall Winterization) now display a "Backflow Cert. Extra Charge" notice making clear that backflow testing is a separately-certified trade we refer out to. See memory/backflow_not_certified.md.
- **Commercial Irrigation** (homepage schema mentions; no page)

- **Files:** new `commercial-irrigation.html`
- **Time:** 2 hr · **Difficulty:** Easy · **Who:** M
- **Tracker IDs:** 49 (48 cancelled)

### 4.6 Publish 4 more blog posts
1. Sprinkler frost depth Ontario (Tracker ID 50) — 1.5 hr
2. Hunter Hydrawise vs Rain Bird comparison (Tracker ID 51) — 2 hr
3. When to turn off sprinklers — fall shutdown — 1.5 hr
4. Sprinkler troubleshooting guide — 2 hr

- **Files:** new `blog-*.html`
- **Total time:** 7 hr · **Difficulty:** Easy–Medium · **Who:** M

### 4.7 Add AggregateRating to homepage (once 5+ reviews exist)
- **What:** Add JSON-LD AggregateRating with ratingValue / reviewCount. Update reviewCount monthly.
- **Why:** Star-rating in local-pack and SERP. Major CTR lift.
- **Files:** `index.html`
- **Time:** 30 min · **Difficulty:** Easy · **Who:** D
- **Tracker ID:** 37
- **Dependency:** Tracker ID 2 (reviews must exist)

### 4.8 Add testimonial above-the-fold on homepage
- **What:** Single quote + name + 5-star visual just under the hero.
- **Why:** First-impression trust. Most visitors don't scroll past the fold.
- **Files:** `index.html`
- **Time:** 30 min · **Difficulty:** Easy · **Who:** M + D
- **Tracker ID:** 43
- **Dependency:** Tracker ID 2

### 4.9 Performance polish
- Add `loading="lazy"` to all below-fold images (Tracker ID 31) — 1 hr
- Add `srcset` / `<picture>` to hero images (Tracker ID 32) — 2 hr
- Audit Google Fonts weights and drop unused (Tracker ID 56) — 30 min

**End of Phase 4:** Strong off-site authority via GBP / citations / backlinks. Coverage spans 12+ cities. 17+ blog posts. AggregateRating in SERP.

---

## Phase 5 — Maintenance & Monitoring (Ongoing)

**Goal:** Sustain quality. Catch regressions. Compound results.

### 5.1 Monthly cadence

- **Publish 1 new blog post** — pick from remaining backlog or trending seasonal topic. ~2 hr
- **Update sitemap `<lastmod>` for any changed pages** (Tracker IDs 62, 63) — 5 min
- **Review CSV tracker** — close completed items, add newly-discovered ones — 15 min
- **Pursue 2–4 new reviews** on Google Business Profile — ongoing
- **Check Google Search Console** for crawl errors / impressions / queries — 15 min

### 5.2 Quarterly cadence

- **Refresh top 3 traffic-getters** — newer photos, updated dates, stronger CTAs — 2 hr
- **Update Pricing Guide** if rates have changed — 30 min
- **Audit citation NAP consistency** — 30 min
- **Verify Google Business Profile completeness** — 30 min
- **Review Lighthouse / PageSpeed Insights** for any new flags — 30 min

### 5.3 Yearly cadence

- **Update municipal bylaws blog post** — verify each municipality's current rules — 1 hr
- **Reaudit citations / directories** — claim missing, fix NAP drift — 1 hr
- **Refresh About page if credentials / cert / experience changed** — 30 min
- **Backup the repo locally** in case GitHub goes down or account is compromised — 5 min

### 5.4 Long-term maintainability decisions

- **Static site generator migration** (Tracker ID 60) — Once page count exceeds ~40, the duplication of nav / footer across files becomes painful. Migrate to **Astro** (recommended): preserves static-output simplicity, adds shared components and MDX blog. Estimated 2–3 days. Defer until clearly needed.
- **CSS breakpoint consolidation** (Tracker ID 33) — Reduce 11 breakpoints to 4–5 core ones. Major refactor. Defer until next visual redesign.
- **Inline-style cleanup** (Tracker ID 55) — Replace inline `style=` attributes with utility classes. Defer until convenient.

### 5.5 Watch list

Re-evaluate yearly:

- **Astro / Hugo / 11ty migration** — when is the right time?
- **CMS layer** — is owner editing pages directly? Would Decap CMS or Sanity be worth it?
- **Email marketing** — once reviews + content are flowing, is there a mailing list opportunity?
- **Video content** — short installation walkthroughs / Hydrawise app tours
- **Paid local search** — Google Ads supplementing organic during shoulder seasons

---

## Summary of effort

| Phase | Goal | Approx hours |
|---|---|---|
| 1 | Critical fixes | 7–8 |
| 2 | High-impact SEO | 25–30 |
| 3 | Content & local expansion | 30–40 |
| 4 | Authority-building | 25–30 |
| 5 | Maintenance (per quarter) | 4–8 |
| **Total Phases 1–4** | **One-time build-out** | **~95–115 hours** |

**Realistic timeline:** 9–12 months at a pace of ~10 hours/month. Phase 1 should be compressed into one week.

---

## Decision points for the owner

The following items require an owner decision before they can move:

1. **Should the contact form move to a real handler?** (Tracker ID 3) Recommended: yes, Formspree free tier. Confirm OK to use a third-party form service.
2. **Estimate vs Quote — keep both, merge, or redirect?** (Tracker ID 16) Recommended: redirect estimate.html to quote.html.
3. **Pricing transparency on a public Pricing Guide page?** (Tracker ID 25) Risk: reduces room for negotiation. Benefit: better-qualified leads + trust signal. Most successful contractors trend toward transparency.
4. **Photo budget for landscape-lighting before/after gallery and team photos?** (Tracker IDs 9, 44) May need a paid evening shoot if owner doesn't have project photos.
5. **Service-area expansion priorities** beyond Markham — ranking?
6. **Commercial irrigation — is it 20%+ of revenue and worth a dedicated page?** (Tracker ID 49)
7. **French-language Quebec / GTA market — relevant?** (Tracker ID 65) Probably not, but worth confirming.

---

*End of document. Cross-reference [`Website_Audit_SEO_Action_Tracker.csv`](Website_Audit_SEO_Action_Tracker.csv) for the full open-issue log.*

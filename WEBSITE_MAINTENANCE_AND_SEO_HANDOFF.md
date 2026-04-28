# PJL Land Services — Website Maintenance & SEO Handoff

> **Audience:** Future developer, marketing professional, or business owner who needs to understand, maintain, or grow this website.
> **Last updated:** 2026-04-27
> **Maintained by:** PJL Land Services (currently Patrick Lalande)
> **Companion files:**
> - [`Website_Audit_SEO_Action_Tracker.csv`](Website_Audit_SEO_Action_Tracker.csv) — every open issue / opportunity with priority, time estimate, and owner
> - [`SEO_IMPLEMENTATION_PLAN.md`](SEO_IMPLEMENTATION_PLAN.md) — phased roadmap (5 phases, 12-month plan)

---

## 1. Project Overview

**Business:** PJL Land Services — sprinkler installation / repair / seasonal service and landscape lighting design / install / service. Newmarket, Ontario, serving the broader York Region and GTA.

**Website:** Plain static HTML + CSS + vanilla JavaScript. No framework, no build step, no server-side code. Hosted on GitHub Pages from the repo `PJLLandServices/mysite`. The Wix-hosted public domain `pjllandservices.com` is incidental — **GitHub is the source of truth.**

**Why this stack:**
- Zero hosting cost (GitHub Pages is free)
- No vendor lock-in — every file is plain HTML
- Owner-editable without specialist tools
- Fast (no JS framework runtime, no API calls)

**Trade-off:** No template engine, so navigation and footer are duplicated across all 28 HTML pages. Any structural change touches every file. (See Section 12 for the recommended migration path when this becomes a real burden.)

---

## 2. Website Structure Summary

### Page inventory (28 active pages)

| Page Type | Files | Purpose |
|---|---|---|
| Homepage | `index.html` | Top-level entry; hero, services, testimonial strip, blog teaser |
| Core service pages | `sprinkler-systems.html`, `landscape-lighting.html` | Detailed service info; magazine-style spreads |
| Conversion pages | `quote.html` (interactive builder), `estimate.html` (older form) | Lead capture |
| Communication | `contact.html`, `faq.html` | Reach-out, support, objection handling |
| Trust / E-E-A-T | `about.html`, `reviews.html` | Owner story, credentials, social proof |
| Service-area pages | `sprinkler-service-{newmarket,aurora,king-city,richmond-hill,vaughan}.html` | Local-SEO landing pages per city |
| Blog index | `blog.html` | Article hub |
| Blog posts | `blog-*.html` (8 articles) | Long-form SEO content |
| Legal | `privacy-policy.html`, `terms-of-service.html`, `accessibility-statement.html` | Compliance |
| Backup / orphaned | `quote-legacy.html` | Earlier 8-step quote wizard. Not linked anywhere. Robots-disallowed. |

### Folder structure

```
pjl-land-services-v39/
├── *.html              ← all pages live at root (28 files)
├── style.css           ← global stylesheet (~2300 lines, CSS variables in :root)
├── nav.js              ← nav scroll behaviour + mobile menu toggle
├── css/
│   └── sprinkler-builder.css   ← styles only used by quote.html
├── js/
│   └── sprinkler-builder.js    ← state + interactivity for the quote builder
├── images/
│   └── builder/        ← 64 illustrations (T1-T4, FRONT/BACK, feature combos) for the quote builder
├── *.jpg, *.png, *.svg ← all other images at root
├── sitemap.xml         ← XML sitemap submitted to Google Search Console
├── robots.txt          ← crawler directives
└── .git/, .claude/     ← repo metadata + Claude Code session data (not deployed)
```

### Routing

GitHub Pages serves files as-is — URL = file path. There is no router. Every page is a fully-formed `.html` file.

### Components

Because there's no template engine, "components" here are **patterns repeated by hand**:

- **`.nav.nav-v2`** — two-tier navigation (utility strip with phone pill + main bar with logo / links / CTA). Same markup duplicated in every HTML file.
- **`.page-eyebrow`** — small uppercase amber-tracked label above each page hero
- **`.page-hero`** / `.about-hero` / `.post-hero` / `.area-hero` / `.reviews-hero` / `.builder-hero` — page-specific hero classes. **All mobile padding-top values use `var(--hero-nav-clearance)` (defined in style.css `:root`).** Bumping this single variable shifts every hero in lockstep when the nav changes.
- **`.cta-banner`** — bottom-of-page conversion banner (appears on sprinkler-systems and landscape-lighting only)
- **`.sprk-banner`** — colored eyebrow banner above section headers (gold / forest / amber variants)
- **`.sprk-ai`** — cream callout box used for "JOBSITE-AWARE", "TECH-GRADE STANDARD" etc.
- **`.service-detail-grid`** — magazine-style spread layout: image with overlapping floating card

### Reusable layout patterns

| Pattern | Where used | Purpose |
|---|---|---|
| `.section` + `.container` | Every page | Vertical rhythm + horizontal gutter |
| `--container-gutter` (clamp variable) | Sitewide | Responsive side padding |
| `--section-space` (clamp variable) | Sitewide | Section vertical breathing |
| `--hero-nav-clearance` | Every hero | One number controls all hero padding-top across 25+ blocks (see [`memory/hero_nav_clearance.md`](memory/hero_nav_clearance.md)) |

---

## 3. Key Files — What Each One Does

### Root HTML

| File | Purpose | Key things to know |
|---|---|---|
| `index.html` | Homepage | Hero / services overview / quote teaser / about / hydrawise certificate / blog strip / FAQ teaser. ~1700 lines including inline `<style>`. |
| `sprinkler-systems.html` | Sprinkler service overview | Repair + install + retrofit + seasonal sub-sections. Magazine spreads. Has an FAQPage schema. |
| `landscape-lighting.html` | Lighting service overview | Background image hero + benefits grid + technique grid + pricing card. |
| `quote.html` | **Active quote builder.** 4-step interactive flow (tier → front yard → back yard → form). Loads `css/sprinkler-builder.css` and `js/sprinkler-builder.js`. |
| `quote-legacy.html` | Old 8-step wizard | Backup only. Robots-disallowed. Don't link to it. |
| `estimate.html` | Older form-based estimate | **Currently has 2 `<h1>` tags — fix to one.** Likely should be merged with `quote.html` (see Tracker ID 16). |
| `about.html` | Owner story + credentials | Person + AboutPage schema. Patrick portrait. Hydrawise certificate. |
| `contact.html` | Contact / booking | **Form currently uses `mailto:` — replace with proper handler (Tracker ID 3).** |
| `faq.html` | 15-question FAQ | FAQPage schema (Google rich-result eligible). |
| `reviews.html` | Reviews page | **100% placeholder — needs real reviews (Tracker ID 2).** AggregateRating schema is commented out. |
| `blog.html` | Blog index | 9 article cards (8 real + placeholders for upcoming). |
| `blog-*.html` | Blog articles | Each is a `.post-hero` + content layout. Only 1 has BlogPosting schema; rest need it (Tracker ID 10). |
| `sprinkler-service-*.html` | 5 city-specific landing pages | Strong locality (named neighborhoods, soil notes, FAQs). Use `aurora` as a template if cloning. |
| `privacy-policy.html`, `terms-of-service.html`, `accessibility-statement.html` | Legal | Need OG / Twitter / JSON-LD added (Tracker ID 11). |

### CSS / JS

| File | Purpose |
|---|---|
| `style.css` | Global stylesheet. CSS variables in `:root` define the design system (colours / spacing / hero-nav-clearance / breakpoints). Most non-trivial pages also have an inline `<style>` block for page-specific overrides. |
| `nav.js` | Scroll-based nav-state class toggling + mobile hamburger. Hamburger break-point: 1024px. |
| `css/sprinkler-builder.css` | Builder-only styles (one-page exception). |
| `js/sprinkler-builder.js` | Builder state + interactivity. Manages tier selection, feature toggles, image swap, form submission. |

### Other

| File | Purpose |
|---|---|
| `sitemap.xml` | Google Search Console submission. Update `<lastmod>` and add new pages as you ship them (Tracker ID 63). |
| `robots.txt` | Disallows `/quote-legacy.html`, `/.claude/`, `/memory/`. Allows everything else. Sitemap location declared. |
| `compress-components.py` | Pillow-based image compression script (RGB PNG → JPG, RGBA preserved). Use for any new image asset. |

---

## 4. SEO Architecture

### Where SEO metadata is managed

**SEO metadata is per-page, inline in the `<head>` block of each HTML file.** There is no central CMS, no front-matter system, no shared partials.

For each page, the SEO surfaces are:

```html
<meta name="description" content="...">      ← search-result snippet (120-160 chars)
<meta name="keywords" content="...">          ← legacy / Google ignores
<link rel="canonical" href="https://...">     ← duplicate-content protection
<link rel="alternate" hreflang="en-ca" href="...">  ← locale signal
<meta property="og:title" content="...">      ← social-share preview title
<meta property="og:description" content="..."> ← social-share preview body
<meta property="og:image" content="https://...">  ← social-share thumbnail
<meta property="og:url" content="...">         ← canonical for social
<meta name="twitter:card" content="summary_large_image">  ← Twitter card type
<meta name="twitter:title" content="...">      ← Twitter title (can differ for char limit)
<meta name="twitter:description" content="...">
<meta name="twitter:image" content="...">
<title>...</title>                             ← browser tab + SERP title (under 60 chars)
<script type="application/ld+json">...</script>  ← Schema.org structured data
```

### Schema.org strategy in use

- **Single canonical LocalBusiness `@id`:** `https://www.pjllandservices.com/#business`
  - Defined fully on `index.html`
  - Other pages reference via `{"@id": "https://www.pjllandservices.com/#business"}` to avoid duplication
  - Means Google sees a single business entity, not 28 separate businesses

- **Per-page schema types:**
  | Page type | @type used |
  |---|---|
  | Homepage | `HomeAndConstructionBusiness` (LocalBusiness sub-type) + `OfferCatalog` |
  | Service page (sprinklers / lighting) | `Service` referencing `provider: { @id }` |
  | Service-area page | `Service` with `areaServed` + embedded `FAQPage` |
  | Contact | `ContactPage` + LocalBusiness reference |
  | About | `AboutPage` + `Person` (Patrick credentials, `worksFor: { @id }`) |
  | FAQ | `FAQPage` |
  | Blog post | Should be `BlogPosting` — currently only on 1 of 9 (gap, Tracker ID 10) |
  | Reviews | Should be `AggregateRating` + `Review[]` once real reviews exist (Tracker ID 37) |

### Where service pages are located

Two tiers:

1. **Core service pages:** `/sprinkler-systems.html`, `/landscape-lighting.html`. Cover the full service in detail.
2. **Service-area pages:** `/sprinkler-service-{city}.html`. One per city. Localized intro + neighborhoods served + FAQ. Cross-link to the core service pages.

When you add a new service-area page, the cleanest scaffold is **`sprinkler-service-aurora.html`** — it has the most-developed local content. Save-as, update everywhere the city name appears (title, H1, schema, neighborhoods, geo coords, intro paragraph, CTA), then add the new URL to `sitemap.xml`.

When you add a new service-specific page (Spring Opening, Fall Winterization, Repair, etc. — see Tracker IDs 6-8, 21-22), the cleanest scaffold is `sprinkler-systems.html`. Strip the install / retrofit sections you don't need.

### Where reusable components are located

`style.css` `:root` defines the design tokens. Every per-page `<style>` block respects them via `var(--token)`. Components like `.nav`, `.cta-banner`, `.section-tag`, `.sprk-banner` live in `style.css`. Page-specific layouts live in inline `<style>` blocks per page.

---

## 5. Current Strengths (what's working)

- **Schema implementation is above-average for a small-business site.** 89% schema coverage. Stable `@id` references. Real LocalBusiness with all required fields.
- **Brand tone is consistently honest.** No hype, no fake urgency. Pricing is published. Differentiation is clear.
- **Title / description / canonical / OG / Twitter coverage is 89% on main pages.** Geo-targeting via `geo.region`, `geo.placename` on every page.
- **Service-area pages are substantively localized,** not thin clones. Named neighborhoods, soil notes, local FAQs.
- **Quote builder (`quote.html`) is best-in-class for this industry.** Visual / no-form-until-step-4 / mobile-friendly. Industry competitors usually have 8+-field forms.
- **Mobile responsiveness is strong** across 25+ hero blocks (recently refactored to use `var(--hero-nav-clearance)`).
- **Image alt-text is excellent** — 105 images, all with descriptive SEO-friendly alt text. Decorative images correctly use `alt=""`.
- **Internal page links work** — no broken hrefs to missing pages.

---

## 6. Current Weaknesses (priority order)

### Critical (act now)
- **Reviews.html is 100% placeholder.** Major social-proof and rich-snippet gap. (Tracker ID 2)
- **Contact form uses `mailto:` only.** Leads are lost when users close their email client. (Tracker ID 3)
- **estimate.html has duplicate `<h1>` tags.** SEO structure error. (Tracker ID 1)
- **8.1 MB SVG embedded on homepage** (`about-section-picture.svg`). Page-weight / Lighthouse hit. (Tracker ID 4)

### High
- **No dedicated pages for Spring Opening, Fall Winterization, Sprinkler Repair, or Smart Controllers.** All buried inside `sprinkler-systems.html`. Missing seasonal-search captures. (Tracker IDs 6-8, 21)
- **Markham (largest adjacent market)** has no service-area page. (Tracker ID 5)
- **8 of 9 blog posts lack BlogPosting schema.** (Tracker ID 10)
- **3 legal pages missing OG / Twitter / JSON-LD.** (Tracker ID 11)
- **5 meta descriptions over 160 chars** — truncate in SERP. (Tracker ID 12)
- **Generic / weak titles** on contact / estimate / quote / FAQ pages. (Tracker ID 13)
- **Blog posts have no in-content CTAs back to services.** (Tracker ID 14)
- **Service pages don't link to area pages.** (Tracker ID 15)
- **Estimate vs Quote page confusion.** (Tracker ID 16)
- **No before/after gallery for landscape lighting** — visual product sold without visuals. (Tracker ID 9)

### Medium / Low
- See full list in `Website_Audit_SEO_Action_Tracker.csv`.

### Maintainability concerns

- Nav and footer are duplicated across 28 HTML files. Any sitewide change is 28 edits.
- 11 distinct media-query breakpoints exist; some redundant.
- ~28 MB of dev-iteration screenshots and unused assets sit at the project root (Tracker ID 17).
- No build step / no CSS minification / no asset pipeline.

---

## 7. Recommended Page Expansion Plan

| Priority | Page | Why | Estimated time |
|---|---|---|---|
| **Critical** | Spring Sprinkler Opening (dedicated landing page) | $90 service buried inside sprinkler-systems. Massive April–May search volume. | 3 hr |
| **Critical** | Fall Winterization (dedicated landing page) | Inverse seasonal opportunity. October search demand. | 3 hr |
| **Critical** | Sprinkler Repair (dedicated landing page) | Year-round high-intent search. Currently a sub-section. | 3 hr |
| **Critical** | Markham (service-area page) | Largest unaddressed market (~330k residents). | 4 hr |
| **High** | Hydrawise / Smart Controller installation page | High-AOV retrofit market. | 2.5 hr |
| **High** | Drip Irrigation page | Diversifies offering. Patrick's bio mentions; no content. | 2.5 hr |
| **High** | Warranty page | 3-year warranty is a top differentiator and currently scattered. | 2 hr |
| **High** | Process / How It Works page | Reduces buyer hesitation. | 2 hr |
| **Medium** | Stouffville / East Gwillimbury / Thornhill (service-area pages) | Eastern York Region coverage gaps. Thornhill = lighting focus. | 3 hr each |
| **Medium** | Pricing Guide | Captures research-stage traffic. | 2 hr |
| **Medium** | Coverage / Service Area Map | Geographic clarity. | 2 hr |
| **Low** | Caledon / Innisfil / Whitchurch-Stouffville | Premium / completeness. | 3 hr each |
| **Low** | Commercial Irrigation | Captures commercial / property-management traffic | 2 hr |

**Total page-expansion estimate:** 50–80 hours of focused work. See `SEO_IMPLEMENTATION_PLAN.md` for the phased schedule.

---

## 8. Local SEO Strategy

### What's already in place
- Geo-tagged pages (`geo.region`, `geo.placename`)
- LocalBusiness schema with `areaServed` listing 9 cities
- 5 city-specific landing pages with local neighborhoods
- Sitemap submitted

### What's missing / next moves
1. **Google Business Profile optimization** — single biggest local-SEO factor. Audit completeness, post weekly, pursue reviews. (Tracker ID 57)
2. **Citations / directories** — Yelp / HomeStars / TrustedPros / BBB / York Region Chamber. Consistent NAP. (Tracker IDs 58, 64)
3. **Backlinks** — supplier dealer-locators (Hunter / Hydrawise), local newspaper supplier features, charity sponsorships. (Tracker ID 59)
4. **Markham + 3 more area pages** — content fills the geographic map. (Tracker IDs 5, 18-20)
5. **Watering bylaws by municipality blog post** — strong local-authority signal. (Tracker ID 29)
6. **AggregateRating once real reviews exist** — local-pack star CTR uplift. (Tracker IDs 2, 37)

### Local keyword targeting (current)

Primary keywords being targeted (page → keyword pairs):
- index.html → "lawn sprinklers Newmarket", "landscape lighting Newmarket"
- sprinkler-systems.html → "sprinkler installation Newmarket", "irrigation contractor GTA"
- landscape-lighting.html → "landscape lighting Newmarket", "outdoor lighting GTA"
- sprinkler-service-aurora.html → "sprinkler service Aurora"
- (... etc per page)

### Local keyword opportunities (recommended additions)

| Keyword | Where to target |
|---|---|
| "sprinkler repair near me" | New Sprinkler Repair page |
| "spring sprinkler opening cost" | New Spring Opening page |
| "fall sprinkler winterization Ontario" | New Winterization page |
| "Hydrawise installer Newmarket / GTA" | New Smart Controller page |
| "lawn sprinkler system cost Ontario" | New cost-explainer blog post |
| "watering restrictions Newmarket / Aurora / Vaughan" | New York Region bylaws blog post |
| "sprinkler installation Markham" | New Markham service-area page |

---

## 9. Content Strategy

### Editorial principles (preserve these)

1. **Honest tone.** Pricing published. No fake urgency. No hype. Patrick's voice shows in About / FAQ.
2. **Locally specific.** Mention soil types, neighborhoods, climate, bylaws. Generic "we serve Ontario" loses to specific "we know clay-heavy Newmarket subdivisions".
3. **Practical.** Posts solve a real homeowner problem and end with a clear next step.
4. **Visually clean.** White space, single hero per page, max 2 CTAs above the fold.

### Recommended content cadence

- **Monthly blog post.** Mix evergreen (cost, troubleshooting, comparison) with seasonal (spring opening, fall winterization).
- **Quarterly:** review and refresh top 3 traffic-getters with newer photos / dates.
- **Yearly:** update municipal bylaw post, refresh pricing claims, audit citations.

### Top 12 blog topics to write (priority order)

See Tracker IDs 26-29, 50-51 plus:

1. How much does a sprinkler system cost in Ontario / GTA (Tracker ID 26)
2. When to turn on sprinklers in Ontario (Tracker ID 27)
3. Sprinkler maintenance checklist (Tracker ID 28)
4. Watering bylaws by York Region municipality (Tracker ID 29)
5. Sprinkler troubleshooting guide
6. Frost-depth / burial requirements Ontario (Tracker ID 50)
7. Hunter vs Rain Bird controller comparison (Tracker ID 51)
8. When to turn off sprinklers — fall shutdown
9. Smart sprinkler controller buying guide
10. New construction sprinkler-prep timing
11. Why your water bill went up — sprinkler edition
12. ~~Backflow prevention basics~~ — **REMOVED 2026-04-27.** PJL does not hold an Ontario backflow tester cert; we should not be authoring authoritative content on a regulated trade we don't practice. See memory/backflow_not_certified.md.

---

## 10. Technical SEO Recommendations

In priority order:

1. **Fix duplicate H1 on estimate.html** (Tracker ID 1) — 15 min
2. **Add BlogPosting schema to all 8 blog posts** (Tracker ID 10) — 1.5 hr
3. **Trim 5 over-length meta descriptions** (Tracker ID 12) — 45 min
4. **Strengthen weak titles** on contact / estimate / quote / FAQ (Tracker ID 13) — 30 min
5. **Add missing OG / Twitter / JSON-LD to 3 legal pages** (Tracker ID 11) — 30 min
6. **Add internal linking** from blog posts to service pages (ID 14) and from service pages to area pages (ID 15) — ~1.5 hr total
7. **Add FAQPage schema** to each new service page as it ships (Tracker ID 35)
8. **Add BreadcrumbList schema** to service-area pages (Tracker ID 36)
9. **Plan AggregateRating** once 5+ real reviews exist (Tracker ID 37)
10. **Compress 8.1 MB SVG** on homepage (Tracker ID 4)
11. **Add `loading="lazy"`** to all below-the-fold images (Tracker ID 31)
12. **Add `srcset` / `<picture>`** to hero images for mobile (Tracker ID 32)

---

## 11. Conversion Improvement Recommendations

In priority order:

1. **Replace placeholder reviews with real reviews + uncomment AggregateRating schema** (Tracker ID 2). Single highest-impact conversion improvement. Estimated +10–15% lift.
2. **Replace `mailto:` form with a real form handler** (Tracker ID 3). Stop losing leads.
3. **Add before/after gallery to landscape-lighting.html** (Tracker ID 9). Visual product needs visuals. +15–25% lift on lighting conversions.
4. **Consolidate Estimate / Quote** into a single funnel (Tracker ID 16). Reduce decision friction.
5. **Add "Related Services" CTAs at the end of every blog post** (Tracker ID 14). 5–10x more blog→booking conversion.
6. **Add testimonial above the fold on homepage** once real reviews are live (Tracker ID 43).
7. **Build Warranty page** (Tracker ID 23). Major differentiator currently invisible.
8. **Build Process / How It Works page** (Tracker ID 24). Reduce first-time-buyer hesitation.
9. **Add Coverage Map** (Tracker ID 61). Geographic clarity reduces unqualified inquiries.

---

## 12. Maintenance Instructions

### Working in the repo

- **Project root:** `C:\Users\patri\Downloads\pjl-land-services-v39\` (Windows). Main branch checked out here. **Pushes happen from here.**
- **Active worktree:** `C:\Users\patri\Downloads\pjl-land-services-v39\.claude\worktrees\<name>\` — Claude Code work happens here. Commits go to a feature branch.
- **Memory folder (Claude session memory):** `C:\Users\patri\.claude\projects\C--Users-patri-Downloads-pjl-land-services-v39\memory\`

### Git workflow

1. Edit files in the worktree
2. Commit on the feature branch (e.g. `claude/<worktree-name>`)
3. From the project root, cherry-pick the commit by hash onto main
4. Push using PowerShell (Bash hangs on Git Credential Manager):
   ```powershell
   Set-Location "C:\Users\patri\Downloads\pjl-land-services-v39"; git push origin main 2>&1
   ```
   The `RemoteException` warning is benign noise — the push succeeds.

### Sitemap maintenance

After shipping a new page, **always**:
1. Add a `<url>` entry to `sitemap.xml` with current `<lastmod>` date
2. Resubmit the sitemap in [Google Search Console](https://search.google.com/search-console) (one click)
3. Update `<lastmod>` on the affected page entry whenever you make a meaningful content change

### How to add a new service page

1. Decide URL slug. Example: `/sprinkler-systems-spring-opening.html`
2. Save-as `sprinkler-systems.html` (closest scaffold) into the new filename
3. Update in the new file:
   - `<title>`, `<meta name="description">`, `<meta name="keywords">`
   - `<link rel="canonical">` (full URL)
   - `<meta property="og:title">`, `og:description`, `og:url`, `og:image`
   - `<meta name="twitter:title">`, `twitter:description`, `twitter:image`
   - JSON-LD `Service` block: `name`, `description`, `serviceType`, image
   - All `<h1>`, `<h2>`, body content
   - Hero eyebrow text + image
4. Add a sitemap entry
5. Cross-link from `index.html` (services overview), `sprinkler-systems.html`, and any relevant area pages
6. Push to main

### How to add a new service-area (city) page

1. Save-as **`sprinkler-service-aurora.html`** (most-developed scaffold) into `sprinkler-service-{city}.html`
2. Update in the new file:
   - All occurrences of "Aurora" → new city
   - Geo coordinates in JSON-LD (`geo.latitude`, `geo.longitude`)
   - Neighborhood list in the intro and the "neighborhoods served" section
   - City-specific soil / climate / housing notes (research locally)
   - FAQPage schema: 3–5 city-specific questions
   - All `<title>`, meta tags, OG / Twitter
3. Add to `sitemap.xml`
4. Cross-link from the homepage areaServed list, the service pages, and adjacent area pages
5. Push to main

### How to update images

1. Drop the new file in the project root using the same filename if you're replacing
2. If new filename: update every `<img src=...>` reference (use `grep -r 'old-name' .` to find them)
3. If the image is over 500 KB: run the compression script
   ```bash
   py -c "from PIL import Image; im=Image.open('file.jpg').convert('RGB'); im.save('file.jpg','JPEG',quality=85,optimize=True,progressive=True)"
   ```
4. For PNGs that don't need transparency, convert to JPG (smaller). Update HTML refs.
5. Always include descriptive `alt` text — never leave empty unless it's a purely decorative image
6. For new heroes: also update `<meta property="og:image">` and `<meta name="twitter:image">`

### How to update contact info

Phone number `(905) 960-0181` and email `info@pjllandservices.com` appear in:
- Every page's nav utility strip
- Every page's footer
- Every page's `tel:` and `mailto:` links
- LocalBusiness JSON-LD on `index.html`
- ContactPage JSON-LD on `contact.html`
- Person JSON-LD on `about.html`

To change either: `grep -rn "905) 960-0181" .` or `grep -rn "info@pjllandservices" .` and update each occurrence. **Be careful to keep formatting consistent** (the visible UI uses `(905) 960-0181`, the `tel:` href uses `+19059600181`, structured data uses `+1-905-960-0181`).

### How to update schema

LocalBusiness schema is the master record on `index.html`. Other pages reference it via `{"@id": "https://www.pjllandservices.com/#business"}`. To change anything about the business itself (hours, address, services list), update the master on `index.html` only — the rest of the site inherits the reference.

When adding new services: add to the `OfferCatalog` on `index.html`.
When changing hours: update `openingHoursSpecification` on `index.html` and `contact.html`.

### How to deploy

GitHub Pages auto-deploys from the main branch of `PJLLandServices/mysite`. After a push, deploy takes 30 seconds to 5 minutes. No manual deploy step.

---

## 13. Deployment Notes

- **Hosting:** GitHub Pages from `PJLLandServices/mysite` repo
- **Domain:** `pjllandservices.com` (Wix-managed DNS, but the GitHub Pages site is the source of truth — the public Wix site is incidental and the owner does not edit it)
- **HTTPS:** GitHub Pages auto-provisions via Let's Encrypt
- **Build step:** none
- **CDN:** GitHub Pages includes CDN

### Deploy checklist

Before pushing to main:
1. Test locally — open the worktree's HTML files in a browser
2. Verify mobile layout on a device emulator (Chrome DevTools → iPhone 14 Pro Max preset)
3. Verify all internal links work
4. Update `<lastmod>` in sitemap.xml for any changed pages
5. If new page: add to sitemap.xml + cross-link from at least 2 existing pages
6. Run `git status` from project root to verify only intended files are staged

### Known deployment risks

- The legacy uncommitted images at the project root (`home-acreage-*`, `home-large-front-*`, "Website Photo/" folder) are pre-existing and not part of any commit. **Don't `git add -A` from the project root** — pick specific files.
- Bash + Git Credential Manager hangs on Windows. Use PowerShell for `git push`.

---

## 14. Future Professional Handoff Notes

If you are picking up this project:

### What you should read first
1. This document (`WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md`)
2. `Website_Audit_SEO_Action_Tracker.csv` (open issues / opportunities / priorities)
3. `SEO_IMPLEMENTATION_PLAN.md` (phased roadmap)
4. The Claude session handoff in `memory/HANDOFF.md` (project history, decisions, what NOT to touch)

### What you should not touch
- The legacy uncommitted images at project root (`home-acreage-*`, `home-large-front-*`, `Website Photo/`) — pre-existing state, not part of any commit
- `quote-legacy.html` — robots-disallowed backup of the old wizard
- The full PJL logo lockup (`logo.svg`) — owner explicitly rejected stripping "LAND SERVICES" from the wordmark; use `logo-mark.svg` only for tight contexts like favicons
- "Engineered By" as eyebrow text — liability concern, owner rejected

### Hard accuracy rules (do not violate)
- **Backflow assembly testing / certification — PJL is NOT certified.** It's a regulated Ontario trade PJL does not practice. Never claim PJL "tests", "certifies", "tags", "inspects" or "pulls a permit for" backflow assemblies in any page, FAQ, schema (`hasCredential`, `knowsAbout`), blog post, or service description. The correct framing is: PJL coordinates with / refers out to a certified Ontario backflow tester (separate trade — extra charge, billed separately). Seasonal-service pages display a "Backflow Cert. Extra Charge" notice. See [memory/backflow_not_certified.md].
- **Pipe terminology — PJL uses HDPE poly, not PVC.** ~99% of installs and repairs use HDPE poly pipe. Never describe the system as PVC. Use **"irrigation pipe"** generically, or **"poly fittings"** specifically when referring to the lateral lines. See [memory/irrigation_pipe_not_pvc.md].

### Brand decisions to preserve
- **Barlow Condensed** for all headings (matches the logo). Don't substitute.
- **Color palette:** greens (`--green: #1B4D2E` / `--green-mid: #2D6A42` / `--green-light: #4A8C5C` / `--green-pale: #EAF3DE`), amber (`--amber: #E07B24` / `--amber-light: #F59B4A`), dark (`--dark: #0F1F14`), cream (`--cream: #FAFAF5`). Defined in `style.css` `:root`.
- **Honest, no-pressure tone.** No fake urgency. Pricing published.

### Recommended growth path
Follow the phases in `SEO_IMPLEMENTATION_PLAN.md`. The biggest near-term wins are:
1. Real reviews (one weekend of work, +10–15% conversion)
2. Real form handler on contact (~1 hour, recovers lost leads)
3. Markham + Spring Opening + Repair pages (~10 hours, captures missing search volume)

### Long-term migration
Once page count exceeds ~40 or maintenance burden becomes painful, migrate to **Astro** (preserves static-output simplicity but adds shared components, MDX blog posts, build-time optimization). Estimated 2–3 days for migration. (Tracker ID 60.)

### Contact Patrick
For questions about the business / brand / clients, contact Patrick Lalande directly. Phone and email are in the master schema on `index.html`.

---

*End of document. Update this file when your changes affect any of the topics above.*

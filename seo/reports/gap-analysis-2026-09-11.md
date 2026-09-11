# Gap analysis — 2026-09-11
Snapshot: seo/data/gsc-2026-09-11.json (2026-06-10 → 2026-09-08, 90 days) · Baseline: none — first run, movement report starts next week

## Summary
- Gap-zone queries: 978 (of 1784 total) · 77 clicks · 19,213 impressions site-wide
- Top opportunity: "sprinkler system cost" — 604 impressions, position 14.64, 1 click. Paired with "cost to install sprinkler system" (591, pos 13.17, 0 clicks) it is 1,195 impressions of buy-intent traffic sitting on page 2 of the only commercial page in the top 10.
- Biggest mover: n/a — no baseline snapshot yet
- One structural finding outside the cards: the site's two biggest pages are DIY how-tos. `blog-how-to-program-orbit-sprinkler-timer.html` alone carries 3,805 impressions (12 of the 25 gap-zone queries) and is inbound-linked from only 2 body positions. The brand query "pjl" (541 impressions) is landing on the CRM login page, which has no `noindex`.

## Keyword opportunity cards (top 10)

### 1. "sprinkler system cost"
604 impressions · 1 click · 0.2% CTR · position 14.64 · `blog-sprinkler-system-cost-ontario.html` (3,080 words, 6 inbound body links)
**Diagnosis:** Update the title — page 1 is question-form titles: HomeGuide "How Much Does a Sprinkler System Cost? (2026)", LawnStarter "How Much Does a Sprinkler System Cost in 2026?". Ours is a noun phrase: "Sprinkler System Cost in Ontario (2026 Pricing) | PJL".
**Action:** Change the title to `How Much Does a Sprinkler System Cost in Ontario? (2026) | PJL` (56 chars before the suffix; this is a blog page, not a town page, so edit the HTML directly — and mirror it in `og:title` and `twitter:title`). Change the H1 to "How much does it cost to install a sprinkler system in Ontario?" so the H1 carries the "install" wording that card 2 needs. Keep the existing `#install`, `#repair`, `#warranty-value` anchors — Search Console shows them earning their own impressions (9–30 each). Bump `dateModified` (last 2026-06-28).
**Season:** Install quotes run April–October; a title change now still catches the September–October install window and is in place for the April spike.

### 2. "cost to install sprinkler system"
591 impressions · 0 clicks · 0.0% CTR · position 13.17 · `blog-sprinkler-system-cost-ontario.html`
**Diagnosis:** Update the title — page-1 titles carry "install" (homewyse "Cost to Install Sprinkler System", DripWorks "How Much Does It Cost to Install an In-Ground Sprinkler System?"); neither our title nor any H2 uses the word "install".
**Action:** Covered by card 1's title + H1 change. The one extra edit for this variant: rename the H2 that sits at the `#install` anchor to "What does it cost to install a sprinkler system? (per-zone pricing)" so the exact phrase appears in a heading, not only body copy. No new page; do not split "cost" and "install cost" onto two URLs — the 20-query "install sprinkler system" family (789 impressions) already resolves to this page and `sprinkler-service-vaughan.html`.
**Season:** Same as card 1.

### 3. "orbit timer program a and b"
557 impressions · 2 clicks · 0.4% CTR · position 5.92 · `blog-how-to-program-orbit-sprinkler-timer.html` (1,292 words, 2 inbound body links)
**Diagnosis:** Restructure — the highest-impression Orbit query on the site has no section of its own. Page 1 is Orbit's manuals and Orbit's own "Mastering Your Easy-Set Logic Sprinkler Timer" post, which explain Programs A/B/C as separate schedules. Our page only touches it in one FAQ ("How do I switch to Program B on an Orbit?").
**Action:** Add an H2 "What are Program A and Program B on an Orbit timer?" (`id="programs"`) directly after "How do I set a start time?" and before "Why does my Orbit water several times a day?" (the double-watering section is the A+B problem, so they read as a pair). Content, 150–200 words: A/B/C are independent schedules, each with its own start times, run times and days; the PROGRAM button switches; the dial reverts to A every time it is turned; use B only for a drip zone or new sod and otherwise leave it with no start time. Add the same Q/A to the FAQPage schema.
**Season:** Year-round, peaks May–August; September is still in-season.

### 4. "pjl"
541 impressions · 1 click · 0.2% CTR · position 9.69 · landing page not an authored page: `/login` (434 impressions, pos 9.93), homepage (65, pos 8.62), `contact.html` (41, pos 8.73)
**Diagnosis:** Landing page is not an authored page. The fix is the reverse of "new page": the CRM login page is indexed and outranking the homepage for the brand name. `server/login.html` has no robots meta, the `/login` route in `server/server.js` sends no `X-Robots-Tag`, and robots.txt does not mention it. (This is the Aug 31 "login deindex" brief; it was never shipped.)
**Action:** Add `<meta name="robots" content="noindex, nofollow">` to the head of `server/login.html`, have the `/login` route (the `pathname === "/login"` branch near line 24900 of `server/server.js`) also send `X-Robots-Tag: noindex, nofollow`, then submit `https://www.pjllandservices.com/login` in Search Console → Removals. Do the same for `/portal/login`, `/admin/*` and any other server-rendered page that is not a public page. Expect the 434 impressions to move to the homepage, which already ranks 8.62 for the same query. Not a GBP issue: "pjl land services" (498 impressions) already sits at 2.97 with 27 clicks.
**Season:** Brand, year-round. Ten-minute fix — do it this week.

### 5. "how to set orbit sprinkler timer"
540 impressions · 0 clicks · 0.0% CTR · position 9.09 · `blog-how-to-program-orbit-sprinkler-timer.html`
**Diagnosis:** Update the title — the "set" wording is the larger half of this page's traffic (the five "set" variants in the gap zone total 1,407 impressions vs about 1,200 for "program"), and page 1 carries it: "Set Your Orbit Irrigation Timer: Step-by-Step Guide", "Easy Dial Programming". Our title has only "Program".
**Action:** Change the title to `How to Set & Program an Orbit Sprinkler Timer (Step-by-Step) | PJL` (60 chars before the suffix — at the limit; drop "(Step-by-Step)" if it truncates in the SERP). Mirror in `og:title` / `twitter:title`. Change the H1 to "How to set and program an Orbit sprinkler timer." Keep the first H2 "How do you program an Orbit timer?" as the answer block.
**Season:** May–August peak; the page is also where spring-opening DIYers land in April.

### 6. "lawn installation north bolton"
392 impressions · 0 clicks · 0.0% CTR · position 12.08 · `sprinkler-service-bolton.html` (1,785 words, 7 inbound body links)
**Diagnosis:** Restructure — but read this one carefully: the intent is sod / lawn installation, which PJL does not do. The page ranks because it is the only Bolton page on the site with irrigation authority; it never uses the words "lawn" or "North Bolton" at all. The related "sod installation bolton" (38 impressions) also lands here at position 52. Page 1 will be Bolton landscapers and sod installers.
**Action:** Do NOT build a sod or lawn-installation page. Add one short block under "New Installation — Bolton": H3 "Putting in a new lawn in North Bolton? Run the sprinklers in first." — two sentences on trenching before sod, one on watering new sod, linking to `blog-how-to-water-new-sod-ontario.html` and `blog-landscape-renovation-sprinkler-prep-gta.html`. Also add "North Bolton" to the "Bolton areas we service" list. This captures the adjacent intent (a new lawn needs irrigation first) without pretending to serve the query. Title stays as `seasonal-meta.json` sets it.
**Season:** Sod goes in April–May and September–October, so the window is open now.

### 7. "orbit sprinkler timer how to set"
376 impressions · 1 click · 0.3% CTR · position 9.76 · `blog-how-to-program-orbit-sprinkler-timer.html`
**Diagnosis:** Update the title — same gap as card 5 (no "set" in the title).
**Action:** Covered by card 5's title change. The one extra edit: the meta description also lacks "set". Replace it with `Set an Orbit sprinkler timer step by step: clock, start time, zone run times, how often — plus the Program A/B quirk that makes the system water twice a day.` (157 chars).
**Season:** Same as card 5.

### 8. "how to program orbit sprinkler system"
335 impressions · 1 click · 0.3% CTR · position 8.3 · `blog-how-to-program-orbit-sprinkler-timer.html`
**Diagnosis:** Rewrite the snippet — title already carries "program / Orbit / sprinkler", the page has the step list and FAQ, and the family is not spread across pages, so the first applicable row is CTR 0.3% at position 8.3. The current description ("Programming an Orbit Easy-Set / Easy Dial timer: set clock…") reads as model-specific, which loses the "system" searcher.
**Action:** The card 7 description is the rewrite — it deliberately says "the system" so this variant is covered by the same edit. Nothing else for this query.
**Season:** Same as card 5.

### 9. "water pooling around sprinkler head when running"
277 impressions · 2 clicks · 0.7% CTR · position 10.25 · `blog-water-pooling-around-sprinkler-head.html` (1,139 words, 5 inbound body links)
**Diagnosis:** Restructure — the page is written for the "when off" case (failed valve, low-head drainage; the "when off" variant sits at 7.7 with 182 impressions). Page 1 for "when running" (Green Lawn "Common Causes of Water Pooling Around Sprinkler Head When Running", Simmons "Causes and Fixes") lists the while-running causes: clogged nozzle, cracked riser or seal, broken lateral, head set too low, saturated soil / over-long run times. We have no section for any of them.
**Action:** Add an H2 "Why does water pool around the head while the system is running?" (`id="running"`) between "Is it the head or the valve?" and "What is low-head drainage?". Five-item list, one line each, with the tell for each (mist at the base = seal; gusher = lateral; only after long cycles = soil), and a link to `blog-sprinkler-head-not-spraying.html` for the clogged-nozzle case. Add "Why is there a puddle only while my sprinklers run?" to the FAQPage schema. Repair cost lines stay as `data-price` tokens.
**Season:** Repair peak June–August; still live through September closing calls.

### 10. "how to program orbit sprinkler timer"
247 impressions · 2 clicks · 0.8% CTR · position 9.13 · `blog-how-to-program-orbit-sprinkler-timer.html`
**Diagnosis:** Rewrite the snippet — this is the exact-match query for the current title, so the title row does not apply; CTR is 0.8% at position 9.13.
**Action:** Covered by the card 7 description. Use this card for the one thing the row table does not catch: this is the site's largest page by impressions (3,805) and has only 2 inbound body links (`blog-sprinklers-running-wrong-time.html`, `blog.html`). Add three body links with anchor "how to program an Orbit timer" from `sprinkler-repair.html` (the "controller" symptom row), `blog-how-to-program-hunter-pro-c.html` (a "different controller?" line at the top), and `blog-best-smart-sprinkler-controller-ontario.html` (the "keeping your Orbit" paragraph).
**Season:** Same as card 5.

## Movement (3+ positions)
| Query | From | To | Δ | Page |
| --- | --- | --- | --- | --- |
| _no baseline — first snapshot; movement starts with the 2026-09-18 pull_ | | | | |

## Query families the script flagged (hub candidates)
- "install sprinkler system" — 20 queries, 789 impressions, 2 landing pages (cost blog + `sprinkler-service-vaughan.html`). Not a hub problem: `sprinkler-installation.html` exists and links to the cost post. Watch whether the card 1/2 title change pulls these onto the blog or the service page; decide the hub next week with movement data.
- "lawn sprinklers [town]" — 8 queries, 336 impressions across 5 town pages (Aurora 9.63, Markham 11.03, Vaughan). Town pages already inbound-linked 14–17×; these are title/snippet questions for `seasonal-meta.json`, not a hub. Revisit when the fall-closing titles rotate out.
- "sprinkler repair" (138 impressions, pos 6.91) lands on `sprinkler-service-orangeville.html`, not `sprinkler-repair.html`. Worth a look next week: the repair hub is losing the generic query to a town page.

## Recommended focus this week
**"sprinkler system cost"** (with "cost to install sprinkler system" riding on the same edit). It is the only commercial-intent keyword in the top 10, the pair is 1,195 impressions at positions 13–15 with one click, and the fix is a title + H1 + one H2 rename on a 3,080-word page that already has the price tables page 1 lacks for Ontario. The Orbit cluster is bigger (over 3,800 impressions) but it is DIY traffic on a controller PJL does not sell; take its title change (card 5) as the second job. The `/login` noindex (card 4) is a ten-minute fix that should ship the same day, not a week's focus.

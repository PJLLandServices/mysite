# PJL Land Services — AI Sprinkler Diagnostic Tool

## Handoff for Claude Code

This document is a complete handoff for deploying PJL Land Services' AI-powered sprinkler diagnostic chat tool. Read this entire document before making any changes.

---

## What This Project Is

PJL Land Services is a sprinkler/irrigation repair and installation business in the Greater Toronto Area (Ontario, Canada). The owner, Patrick, has a website at `pjllandservices.github.io/mysite/` that promotes "AI Sprinkler Diagnosis" — and we need to deliver a real, working tool at `diagnose.html` on that site.

The tool is a chat interface where homeowners describe their sprinkler problem in plain English, and an AI persona (Patrick) responds with diagnoses, self-fix steps, and quotes — eventually capturing leads that want to book service calls.

---

## Architecture

```
Customer browser
      ↓
diagnose.html (GitHub Pages: pjllandservices.github.io/mysite/diagnose.html)
      ↓
fetch() POST to Cloudflare Worker
      ↓
Cloudflare Worker (https://jolly-meadow-6c29.patrick-812.workers.dev/)
      ↓
Adds system prompt + API key, calls Anthropic API
      ↓
Anthropic API returns Claude response
      ↓
Worker returns response to diagnose.html
      ↓
diagnose.html renders Patrick's reply in chat UI
```

**Key components:**
- **Frontend:** `diagnose.html` — single-file HTML/CSS/JS chat UI, hosted on GitHub Pages
- **Backend:** Cloudflare Worker — `worker.js` — holds system prompt and API key
- **AI:** Anthropic Claude (model: `claude-sonnet-4-5`) accessed via API

---

## Current State (As of Handoff)

### What's already done

- ✅ Anthropic API account created, ~$45 in credits loaded
- ✅ API key generated: `PJL Sprinkler Diagnosis v2` (the actual secret value lives in Cloudflare, not in this repo)
- ✅ Cloudflare Worker created: `jolly-meadow-6c29.patrick-812.workers.dev`
- ✅ Cloudflare Worker secret `ANTHROPIC_API_KEY` configured (do not regenerate)
- ✅ Worker deployed and tested — successfully calls Anthropic API and returns responses
- ✅ System prompt v2 written (compassionate diagnostic-educator voice; locked PJL pricing baked in)
- ✅ `diagnose.html` v5 built — beautiful chat UI with typing indicator, message bubbles, inline lead form

### What still needs to happen

- 🔲 Deploy the latest `worker.js` from this repo to Cloudflare (replaces existing Worker code)
- 🔲 Deploy `diagnose.html` from this repo to the GitHub Pages site at `pjllandservices.github.io/mysite/diagnose.html`
- 🔲 Verify CTAs across the live site (homepage banner, "How It Works" section, sprinkler-systems page CTAs) link to `/diagnose.html`
- 🔲 (Optional) Set up Formspree or Netlify Forms for lead capture and update `LEAD_ENDPOINT` in `diagnose.html` (currently logs leads to browser console)

---

## Files In This Repo

```
worker.js            ← Complete Cloudflare Worker code with system prompt baked in
diagnose.html        ← Frontend chat page for GitHub Pages
system_prompt.md     ← Reference copy of the system prompt (for editing/iterating)
HANDOFF.md           ← This document
```

---

## Critical Pricing & Policy Reference

These prices are baked into the system prompt. If Patrick (the owner) updates pricing, edit `system_prompt.md` and re-paste the prompt block into `worker.js`'s `SYSTEM_PROMPT` constant, then redeploy the Worker.

**Service call:** $95 (mobilization + on-site assessment ONLY — labour billed separately at $95/hr)
**AI-intake bonus:** Correct AI diagnosis = 1 hour of repair labour FREE on the diagnosed work. PJL's only discount.

**Repairs:**
- Sprinkler head replacement (any size, any type): $68 flat per head
- 3-valve manifold rebuild: $135
- 6-valve manifold rebuild: $285
- Hunter PGV valve: $74.95 each
- Wire diagnostics & simple repair: $187
- Wire run replacement: $345 (≤100ft) / $435 (≤175ft) / $1.80/ft beyond
- Pipe break repair (up to 3ft): $120

**Controllers (Hunter HPC-400 Hydrawise Wi-Fi):**
- 1-4 zones: $595
- 5-7 zones: $750
- 8-16 zones: $1,195
- 17+ zones: custom quote

**New installs (all-in, includes Hydrawise + 5yr warranty):**
- Tier 1 (1-4 zones): $585 base + $549/zone
- Tier 2 (5-7 zones): $749 base + $549/zone
- Tier 3 (8+ zones): custom quote, drawings + site visit required
- Frost-free hose bib add-on: +$175

**Spring opening:** $85 (≤4 zones) / $120 (≤8 zones) / $285 (commercial)
**Fall closing:** $85 (≤4) / $95 (≤6) / $120 (≤8) / $145 (≤15)

**Critical service philosophy — The Whole Manifold Rule:** When ANY valve in a box fails, PJL replaces the entire manifold AND all valves in that box together — never single-valve repair. Customer pays manifold price + per-valve price for every valve in the box.

**Refer-out (PJL does NOT service):**
- Backflow preventers → certified backflow specialist
- Inside-house plumbing → licensed plumber
- Utility-side leaks (between meter and house shutoff) → municipal water dept

---

## Deployment Steps

### Step 1: Deploy worker.js to Cloudflare

The Cloudflare Worker holds the system prompt and the Anthropic API key. To update it:

**Option A — Manual (current setup):**
1. Open https://dash.cloudflare.com → Workers & Pages → `jolly-meadow-6c29`
2. Click "Edit code"
3. Select all existing code and delete
4. Copy the entire contents of `worker.js` from this repo, paste into the editor
5. Click "Save and Deploy"
6. Verify deployment with the built-in HTTP test panel:
   - Method: POST
   - URL: (default, the Worker URL)
   - Headers: `Content-Type: application/json`
   - Body:
     ```json
     {"messages":[{"role":"user","content":"Say hello briefly"}]}
     ```
   - Click send. Should return 200 with a `reply` field containing Patrick's hello.

**Option B — Wrangler CLI (recommended for ongoing work):**
```bash
# One-time setup
npm install -g wrangler
wrangler login

# To deploy
wrangler deploy worker.js --name jolly-meadow-6c29

# To set/update the secret (ONLY if regenerating the API key):
wrangler secret put ANTHROPIC_API_KEY --name jolly-meadow-6c29
```

⚠️ **Do not regenerate the API key unless necessary.** It's already configured as a Cloudflare secret. Regenerating means going through the Anthropic console + redeploying the secret.

### Step 2: Deploy diagnose.html to GitHub Pages

The file goes at `pjllandservices.github.io/mysite/diagnose.html`. The repo is the GitHub Pages repo for that domain.

```bash
# Assuming the repo is cloned locally
cp diagnose.html /path/to/pjllandservices.github.io/mysite/diagnose.html
cd /path/to/pjllandservices.github.io
git add mysite/diagnose.html
git commit -m "Deploy AI-powered Patrick diagnostic chat tool"
git push origin main
```

GitHub Pages auto-deploys within 30-60 seconds of push. Verify by visiting `https://pjllandservices.github.io/mysite/diagnose.html`.

### Step 3: Verify site CTAs link to /diagnose.html

These pages on the live site already promote "AI Sprinkler Diagnosis" and need to link to the new tool:
- Homepage banner CTA
- "How It Works" section
- Sprinkler-systems product page CTAs
- Pricing tiles

Search the existing site repo for any anchor tags or buttons mentioning AI/diagnosis/diagnostic and confirm they point to `/diagnose.html` (or the appropriate relative path).

### Step 4 (Optional): Set up lead capture

Currently when a customer fills out the booking form in the chat, leads log to `console.log()` — owner has to check browser console to see them. This is fine for testing but not for production.

**Recommended: Formspree (free tier, easy setup)**

1. Sign up at https://formspree.io with `patrick@pjllandservices.com`
2. Create a new form, name it "PJL Sprinkler Diagnostic Leads"
3. Copy the form endpoint URL (looks like `https://formspree.io/f/abcd1234`)
4. In `diagnose.html`, find this constant near the top of the script section:
   ```javascript
   const LEAD_ENDPOINT = ""; // e.g. "https://formspree.io/f/your-form-id"
   ```
5. Update it:
   ```javascript
   const LEAD_ENDPOINT = "https://formspree.io/f/abcd1234";
   ```
6. Redeploy `diagnose.html` to GitHub Pages.

After this, every booking form submission emails Patrick directly with the customer's details + the full chat conversation transcript.

---

## Going Live (Production Lockdown)

Once everything is deployed and tested, lock down the Worker so only the real website can use it (prevents abuse / API credit burn):

In `worker.js`, change:
```javascript
const ALLOW_ALL_ORIGINS_FOR_TESTING = true;
```

To:
```javascript
const ALLOW_ALL_ORIGINS_FOR_TESTING = false;
```

The `ALLOWED_ORIGINS` array already includes the right domains:
```javascript
const ALLOWED_ORIGINS = [
  "https://pjllandservices.github.io",
  "https://pjl-land-services.com",
  "https://www.pjl-land-services.com",
];
```

Redeploy. The Worker will now reject any request not from those domains.

---

## How To Iterate On Patrick's Voice

If responses from the AI feel off, the fix is almost always to edit the system prompt. The system prompt lives in two places:

1. **`system_prompt.md`** — human-readable master copy. Edit this first.
2. **The `SYSTEM_PROMPT` template literal in `worker.js`** — the actual deployed copy.

Workflow:
1. Edit `system_prompt.md` to fix whatever's off (tone, missing trade detail, pricing logic, etc.)
2. Regenerate `worker.js` by replacing the `SYSTEM_PROMPT` constant value with the updated prompt content (everything from `## WHO YOU ARE` to the end of the file).
3. Redeploy `worker.js` to Cloudflare (Step 1 of Deployment).
4. Test the live chat tool to verify the voice change.

Common edit reasons:
- Patrick wants to update pricing → edit the "YOUR PRICING" section
- Customer-facing diagnosis voice feels too robotic / too markdown-heavy → tighten the "HOW YOU TALK" section
- New trade knowledge to teach Patrick → add to "SELF-FIX PLAYBOOKS" or "DEAD-END FOLLOW-UPS"

---

## Cost Estimates

- **Cloudflare Workers:** Free tier handles 100,000 requests/day. PJL will not approach this.
- **Anthropic API:** Each customer chat costs roughly $0.01–$0.03. At 1,000 customers/month, that's $10–$30. Patrick has loaded $45 of credits to start.
- **Formspree (if used):** Free tier handles 50 submissions/month. Beyond that, $10/month for unlimited.

---

## Testing Scenarios

After deploying, test these scenarios in order to confirm Patrick is working correctly:

1. **Bleeder screw fix:** "good morning, water is constantly flowing from one of my sprinkler zones, doesn't stop even when system is off"
   - Expected: Empathy + bleeder screw + solenoid explanation + "want to try yourself or send a tech?" question.

2. **Self-fix follow-up:** Reply "I tried the screws and solenoids, water still flowing from zone 3"
   - Expected: One question about whether multiple zones or just one, then quote $455 manifold rebuild.

3. **Booking trigger:** Reply "yeah send a tech"
   - Expected: Reply ends with `[SHOW_BOOKING_FORM]` token (invisible to customer), inline form bubble appears in chat.

4. **Refer-out:** "do you do backflow testing?"
   - Expected: Polite refer-out to a backflow specialist.

5. **Dead system:** "my whole sprinkler system won't turn on at all"
   - Expected: Empathy + electrical-basics diagnosis + breaker/GFCI/transformer self-check offer.

6. **Geyser:** "one of my sprinklers is shooting straight up like a fountain"
   - Expected: Diagnose snapped head + offer self-check OR direct quote at $95 + $68/head.

If any of these flows produce the wrong tone, wrong pricing, or wrong diagnosis, edit the system prompt accordingly.

---

## Files & Their Purposes (Quick Reference)

| File | Purpose | Where it lives in production |
|---|---|---|
| `worker.js` | Cloudflare Worker — proxies chat to Claude with system prompt + API key | Cloudflare Workers (jolly-meadow-6c29) |
| `diagnose.html` | Customer-facing chat UI | GitHub Pages (`pjllandservices.github.io/mysite/diagnose.html`) |
| `system_prompt.md` | Master copy of the AI persona prompt | Repo only (not deployed; serves as edit source) |
| `HANDOFF.md` | This document | Repo only |

---

## Contacts & Account Info

- **Owner:** Patrick (patrick@pjllandservices.com)
- **Anthropic Console:** console.anthropic.com (logged in as Patrick)
- **Cloudflare Dashboard:** dash.cloudflare.com (logged in as Patrick)
- **Worker URL:** https://jolly-meadow-6c29.patrick-812.workers.dev/
- **Worker Name:** `jolly-meadow-6c29` (auto-generated whimsical name; customers never see it)
- **API Key Name:** `PJL Sprinkler Diagnosis v2`
- **Anthropic Model:** `claude-sonnet-4-5`

---

## Open Questions / Future Work

- Custom domain for Worker (e.g., `chat.pjl-land-services.com`) instead of `*.workers.dev`
- Rate limiting on Worker to prevent any single IP burning credits
- Image upload support so customers can send photos of broken heads / valve boxes
- Streaming responses (currently waits for full reply, could stream for faster feel)
- Conversation persistence — if customer accidentally refreshes, current chat is lost

---

End of handoff.

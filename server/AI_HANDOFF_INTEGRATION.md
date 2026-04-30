# PJL AI Chat → Booking Handoff — Integration Guide

This document is for whoever builds the PJL AI chat agent (or for Patrick's
reference if he wires it up himself). The PJL server-side is already live —
this guide is just the contract the AI side needs to follow.

---

## TL;DR

When your AI agent finishes diagnosing a customer, it makes ONE HTTP request
to PJL's server and gets back a URL to send the customer. The customer clicks,
lands on a booking form that's already filled in with everything the AI
captured, picks a date/time, and confirms. The AI's diagnosis lands on the
customer's work order — visible to both PJL and the customer.

---

## Step 0 — One-time setup (Patrick)

Pick a long random string for the shared secret (or use the one Claude
generated):

```
bb615087c14c0349f719130a1e6b1d3e20c906d5ec427f801b70ccc3d66cc957
```

Add it to Render:

1. https://dashboard.render.com → click your `pjl-land-services` service
2. **Environment** tab on the left
3. Scroll to **Environment Variables** → **Add Environment Variable**
4. **Key:** `BOOKING_API_KEY`
5. **Value:** the random string above (or your own — anything 32+ chars)
6. **Save Changes**

Render will redeploy automatically (~2 min). After that the `prepare-session`
endpoint accepts requests carrying that key.

Hand the key to whoever builds the AI. Treat it like a password — don't paste
it into client-side code or check it into a public git repo.

---

## Step 1 — The AI calls one endpoint

```http
POST https://pjllandservices.com/api/booking/prepare-session
Content-Type: application/json
X-PJL-Booking-Key: <BOOKING_API_KEY>

{
  "source": "ai_chat",
  "diagnosis": "Customer reports zone 3 not popping up. After troubleshooting, likely valve diaphragm failure on Hunter PGV. Recommend manifold rebuild while we're in there.",
  "diagnosisSummary": "Zone 3 valve diaphragm — recommend manifold rebuild",
  "suggestedService": "sprinkler_repair",
  "severity": "normal",
  "customerHints": {
    "firstName": "Patrick",
    "lastName": "Lalande",
    "email": "patrick@example.com",
    "phone": "9055551234",
    "address": "123 Main St, Newmarket ON L3Y 1A1",
    "zoneCount": 6,
    "notes": "Gate code 1234, dog usually out back"
  }
}
```

Every field is optional except `source`. Fill in what the AI captured;
leave the rest out.

### `suggestedService` valid keys

(must match the catalog at `GET /api/booking/services`)

| Key | When the AI should suggest it |
|---|---|
| `spring_open_4z` | Spring opening, ≤4 zones |
| `spring_open_8z` | Spring opening, 5-7 zones |
| `spring_open_15z` | Spring opening, 8+ zones |
| `spring_open_commercial` | Spring opening, commercial property |
| `fall_close_6z` | Fall winterization, ≤6 zones |
| `fall_close_15z` | Fall winterization, 7-12 zones |
| `fall_close_large` | Fall winterization, 13+ zones |
| `fall_close_commercial` | Fall winterization, commercial property |
| `sprinkler_repair` | Any repair / diagnostic — **use this for most chat handoffs** |
| `hydrawise_retrofit` | Smart-controller upgrade |
| `site_visit` | New install / drip retrofit / scoping a custom job |

If the AI isn't sure what service fits, omit `suggestedService` — the
customer will pick from the full menu when they land on `/book.html`.

---

## Step 2 — The response

```json
{
  "ok": true,
  "token": "abc123…",
  "expiresAt": "2026-04-30T18:17:00.000Z",
  "bookingUrl": "https://pjllandservices.com/book.html?session=abc123…"
}
```

The session expires in **1 hour**. After that the link still loads but the
prefilled data is dropped (the customer just sees the empty booking form).

---

## Step 3 — The AI sends `bookingUrl` to the customer

In the chat: *"Great — click here to pick a time that works for you. Your
details are already filled in."*

Whatever's natural for your chat platform — the URL is just a normal HTTPS
link.

---

## Step 4 — The customer books

They never see the AI internals. They land on `/book.html` and:

- The right service is pre-selected (skipping the picker if the family has
  one match — repair, hydrawise, site visit go straight to address).
- Their first name, last name, email, phone, address, zone count, and notes
  are all pre-filled.
- They pick a date + time, confirm, and a lead lands in the PJL CRM with
  the AI's diagnosis attached to the work order.

---

## What lands where

| The AI captures | Lands on |
|---|---|
| `diagnosisSummary` | Work order header — bold one-liner visible in customer portal + CRM |
| `diagnosis` (long-form) | Work order body — full text, line breaks preserved, visible to customer + CRM |
| `severity` | CRM internal field for triage |
| `source` | CRM lead source tag (`ai_chat` shows up as a pill in the lead list) |
| `customerHints.notes` | Booking form notes textarea (customer can edit before submitting) |
| `customerHints.zoneCount` | Booking form zone dropdown (customer can change) |

Customer-facing footnote on the diagnosis section reads:
> *"Your technician will confirm the diagnosis on arrival and present any
> updated repair details for your approval before work begins."*

---

## Auth

Two ways to authenticate the request:

1. **`X-PJL-Booking-Key` header** with the value of `BOOKING_API_KEY` on
   Render. Use this for external/automated integrations (the AI agent).
2. **Admin session cookie** from being logged into `/admin`. Use this if
   you're hitting the endpoint from a tool inside the PJL admin (which the
   `/admin/handoff` page does).

Without one or the other, the endpoint returns **401 Unauthorized**.

Failure to authenticate is the most common integration error. If you see
401, double-check that:
- The header name is exactly `X-PJL-Booking-Key` (case-insensitive)
- The value matches the env var on Render exactly (no leading/trailing
  whitespace)
- Render has finished redeploying after you set the env var

---

## Quick test (no AI needed)

Once `BOOKING_API_KEY` is set on Render, you can hit the endpoint from a
terminal to verify it's alive:

```bash
curl -X POST https://pjllandservices.com/api/booking/prepare-session \
  -H "Content-Type: application/json" \
  -H "X-PJL-Booking-Key: bb615087c14c0349f719130a1e6b1d3e20c906d5ec427f801b70ccc3d66cc957" \
  -d '{
    "source": "manual_test",
    "diagnosisSummary": "Test handoff — zone 3 valve",
    "diagnosis": "This is a test diagnosis to verify the handoff is working end-to-end.",
    "suggestedService": "sprinkler_repair",
    "customerHints": {
      "firstName": "Test",
      "email": "you@example.com",
      "phone": "9055550100",
      "address": "Newmarket, ON"
    }
  }'
```

You should get back a `bookingUrl`. Open it in a browser — every field
should be pre-filled, the diagnosis should appear on the work order
after you complete the test booking.

---

## Manual handoff (AI-free)

While the AI agent is being built, Patrick can use **`/admin/handoff`** in
the CRM to do the same thing by hand: fill in customer info + diagnosis,
hit send, and the customer gets the same SMS + email they'd get from the
AI. Same plumbing, manual driver.

---

## Sample integration snippets

### Node.js / TypeScript

```js
async function handoffToBooking({ diagnosis, summary, customer, service }) {
  const response = await fetch("https://pjllandservices.com/api/booking/prepare-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PJL-Booking-Key": process.env.PJL_BOOKING_API_KEY
    },
    body: JSON.stringify({
      source: "ai_chat",
      diagnosis,
      diagnosisSummary: summary,
      suggestedService: service,
      customerHints: customer
    })
  });
  if (!response.ok) throw new Error(`PJL handoff failed: ${response.status}`);
  const data = await response.json();
  return data.bookingUrl;
}
```

### Python

```python
import os, requests

def handoff_to_booking(diagnosis: str, summary: str, customer: dict, service: str) -> str:
    response = requests.post(
        "https://pjllandservices.com/api/booking/prepare-session",
        headers={
            "Content-Type": "application/json",
            "X-PJL-Booking-Key": os.environ["PJL_BOOKING_API_KEY"]
        },
        json={
            "source": "ai_chat",
            "diagnosis": diagnosis,
            "diagnosisSummary": summary,
            "suggestedService": service,
            "customerHints": customer
        },
        timeout=10
    )
    response.raise_for_status()
    return response.json()["bookingUrl"]
```

### OpenAI Assistants / function-calling

If your AI runs on OpenAI's platform, expose this as a tool/function the
model can call:

```json
{
  "type": "function",
  "function": {
    "name": "handoff_to_pjl_booking",
    "description": "When the customer is ready to book a sprinkler service, call this with the diagnosis and customer details. Returns a booking URL to send to the customer.",
    "parameters": {
      "type": "object",
      "required": ["diagnosis", "customerHints"],
      "properties": {
        "diagnosis":         { "type": "string", "description": "Long-form diagnosis text" },
        "diagnosisSummary":  { "type": "string", "description": "One-line summary, ≤280 chars" },
        "suggestedService":  { "type": "string", "enum": ["spring_open_4z","spring_open_8z","spring_open_15z","spring_open_commercial","fall_close_6z","fall_close_15z","fall_close_large","fall_close_commercial","sprinkler_repair","hydrawise_retrofit","site_visit"] },
        "severity":          { "type": "string", "enum": ["normal","urgent"] },
        "customerHints": {
          "type": "object",
          "properties": {
            "firstName": { "type": "string" },
            "lastName":  { "type": "string" },
            "email":     { "type": "string" },
            "phone":     { "type": "string" },
            "address":   { "type": "string" },
            "zoneCount": { "type": ["integer","string"], "description": "1-24 or 'unsure'" },
            "notes":     { "type": "string" }
          }
        }
      }
    }
  }
}
```

When the model calls this function, your handler hits the
`prepare-session` endpoint with the args and returns the `bookingUrl` to
the model so it can pass the link to the customer.

---

## Questions / problems

If anything fails, check these in order:

1. **Render logs** — every request hits the server. Failures log with the
   error. Look for `[customer-email]`, `[customer-sms]`, or generic
   500-level errors.
2. **`BOOKING_API_KEY`** is set on Render and matches what the AI is sending.
3. **The customer hint phone is in E.164** if you want SMS to work
   (`+19055551234`, not `(905) 555-1234`).
4. **`suggestedService` matches a key from `/api/booking/services`** —
   typos silently fall through (the customer just picks from the full menu).

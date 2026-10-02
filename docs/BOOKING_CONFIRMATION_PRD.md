# Booking Confirmation & Text Replies — Product Requirements

**Status:** DRAFT, awaiting Patrick's approval. Nothing built yet.
**Opened:** 2026-09-25
**Owner:** Patrick
**Companion:** `docs/BOOKING_CONFIRMATION_TRD.md` (how it gets built)

---

## The problem, in Patrick's words

> *"I have now had two bookings that have called me to say I have attempted
> to confirm the appointment, but they do not have it work. The email confirm
> appointment button might be broken."*

> *"The text message that we send out is from a 647 number utilizing Twilio.
> That number isn't monitored … they have been responding to that text
> message to confirm the appointment … it's led individuals to believe that I
> would respond to that number, although it says on there to please contact
> 960-0181 … I guess you just kind of got to dumb it down for some people."*

Two separate problems, one result: **customers try to say "yes" and we never
hear it.** They then call Patrick, or worse, they don't — and stay on the
reminder cadence getting "we haven't heard from you" messages after they
already answered.

---

## Problem 1 — "Confirm this appointment" looks broken (it is, visually)

### What we found (reproduced 2026-09-25 on an iPhone-sized screen)

The email and text both link to the customer's appointment page
(`pjllandservices.com/a/<code>`). The page loads fine. The **Confirm** button
works on the server — the confirmation **is saved**. But on the customer's
screen:

1. They scroll down to the big green **Confirm this appointment** button and
   tap it.
2. **Nothing visibly changes.** The button stays exactly where it was.
3. The "Confirmed — you're all set" message *does* appear — but at the **top
   of the page, scrolled off-screen** where they can't see it.
4. They tap again. Still nothing. They call Patrick.

**Why:** the page's stylesheet forces its buttons and badge to always show,
which overrides the page's own "hide this now" instruction. Every other
customer page on the site has a one-line safety rule that prevents this; the
appointment page is the only one missing it. A side effect: an empty green
pill shows under "Hi {name}" on every visit, and the **Cancel / Pick a
different day / Set timing** buttons stay visible inside the 24-hour cutoff,
where tapping them gives an error ("call us").

**Good news:** the two customers who called almost certainly **are** marked
confirmed in the system — the save worked, only the screen lied. (We can
check their records once you give us their names.)

### What the customer must experience instead

- Tap **Confirm** → within a second, a big, unmissable **"✓ You're
  confirmed for Thursday, October 8 (Morning, 8 AM – 12 PM)"** message
  appears **right where they tapped**, and the Confirm button disappears.
- Opening the link again later shows the same "You're confirmed" message at
  the top, with no Confirm button.
- Buttons that aren't allowed (e.g. cancel inside 24 hours) are **not shown
  at all**, instead of shown-then-refused.
- The email button says what it does: **"Confirm or change my appointment"**
  (today it says "Open your appointment page").

---

## Problem 2 — Customers reply to the 647 text, and nobody reads it

### What we found

- Every automated text (booking confirmations, the fall assignment messages,
  follow-ups, the 24-hour reminder) goes out from the **Twilio 647 number**.
- The website listens to that number for **phone calls** (voicemail → text to
  Patrick), but **nothing listens for text messages**. A reply to that number
  goes nowhere. The customer gets no answer and no confirmation.
- The messages say "Questions? (905) 960-0181", but the natural thing to do
  with a text is **reply to it**. Asking customers to do otherwise is fighting
  human nature.

### Decision recommended: make the 647 number *answer*, not *go silent*

We can't make every customer read carefully, so the system has to handle the
reply they're going to send anyway.

| When a customer texts the 647 number… | The system does this |
|---|---|
| **"YES"**, "Y", "Confirm", "Confirmed", "OK", "👍" — and they have **exactly one** upcoming appointment on file under that phone number | **Confirms the appointment** (exactly as if they'd tapped the button), texts back *"Thanks Kristen — you're confirmed for Thursday, October 8, morning. Need anything else? Call or text Patrick at (905) 960-0181."* and stops the "we haven't heard from you" reminders. |
| "YES" but **no** upcoming appointment, or **more than one** (e.g. a property manager) | Does **not** guess. Forwards the text to Patrick and replies: *"Thanks! We've passed your message to Patrick. For a quick answer call or text (905) 960-0181."* |
| **Anything else** ("Can you come Tuesday instead?", "Who is this?") | **Forwards it to Patrick right away** (text to his cell + email, naming the customer and their appointment if we recognise the number), and auto-replies once: *"This number is automated. We've sent your message to Patrick — for a faster answer call or text (905) 960-0181."* |
| **STOP** / **UNSUBSCRIBE** | Twilio blocks further texts to them automatically (the law requires it). We also mark them opted-out of seasonal texts in the CRM and tell Patrick. No other reply. |

**Patrick never has to monitor the 647 number.** Everything a human needs to
read lands on his own phone and in his email, the same way voicemails do
today.

### Wording changes to the texts themselves

Every automated text gets two small changes so fewer people are confused to
begin with:

- **Tell them the easy way to confirm:** *"Reply YES to confirm, or tap to
  change: {link}"*
- **Say plainly who reads it:** *"This is an automated number — to talk to
  us, call or text (905) 960-0181."*

(Texts over 160 characters are split into two on the customer's phone, so
wording will be kept tight. Patrick approves final wording before it ships.)

---

## Who sees what (the whole workflow)

| | Today | After |
|---|---|---|
| **Customer taps Confirm** | Nothing visible happens | Big "You're confirmed" message where they tapped |
| **Customer replies YES by text** | Silence | Confirmed + thank-you text |
| **Customer texts a question** | Silence | Auto-reply pointing to 960-0181; Patrick gets the message |
| **Patrick** | Finds out when they phone him | Gets every real text on his cell + email; Season Plan shows "confirmed by text" |
| **Reminder cadence** | Keeps nagging people who already said yes by text | Stops the moment they confirm, either way (the 24-hour reminder still goes) |
| **Calendar / route** | Unchanged | Unchanged — confirming never moves a slot |
| **History on the booking** | — | Records *how* they confirmed (page / text) and when |

**Deliberately left alone:** the booking itself, its date, the route, prices,
work orders and invoices. Confirming is a "we heard you" mark, nothing more.

---

## What Patrick needs to do (only once, ~5 minutes, later)

One setting in the Twilio website: tell the 647 number where to send incoming
texts (the same kind of setting already done for incoming calls). Claude will
give click-by-click steps when Phase 2 is ready — or do it for you through
Twilio's system if you approve that.

---

## Phases

| Phase | What | Size | Needs Patrick |
|---|---|---|---|
| **1 — Hotfix** | Fix the Confirm page so it visibly confirms; hide buttons that shouldn't show; rename email button | Small — can go live today | Approve + "go live" |
| **2 — Texts reach Patrick** | 647 number forwards every text to Patrick + sends the "automated number" auto-reply | Medium | Approve wording; Twilio setting |
| **3 — Reply YES to confirm** | "YES" confirms the appointment; texts updated to say "Reply YES" | Medium | Approve wording |
| **4 — Text inbox in the CRM** | Customer texts show up on the Messages page next to portal messages | Medium, optional | Decide if wanted |

## How we'll know it worked

- **Zero** "I tried to confirm and it didn't work" calls for the rest of the
  fall season.
- Confirmation rate on assignment bookings goes **up** (text "YES" is the
  easiest possible answer).
- No customer text to the 647 number goes unanswered or unseen by Patrick.

## Questions for Patrick

1. **Names of the two customers** who called — we'll check their records to
   confirm the system did save their "yes".
2. Forwarded texts: **text to your cell, email, or both?** (Recommended: both.)
3. OK for a text "YES" to **confirm automatically**, or would you rather see
   each one first?
4. Any wording you want in the auto-reply?

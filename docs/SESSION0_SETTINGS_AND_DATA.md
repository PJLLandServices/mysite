# Session 0 — settings and data

Working notes for the five settings/data items raised on 2026-08-29. Written from a
clean checkout with no `server/data/` runtime state, so four of the five items could
not be *applied* here — see **Why most of this could not be applied** at the bottom.

The one item that produces a durable, committable artifact is the fall outreach copy,
which is written out in full below and ready to paste into `/admin/outreach`.

---

## 1. `daysAhead: 14 → 60` — the setting is not wired to anything

**Changing this setting will not change the booking window.** It is dead config.

`DEFAULT_SETTINGS.daysAhead` (`server/lib/availability.js:199`) is read in exactly one
place — `server/lib/availability.js:273`:

```js
const scanDays = daysAhead || cfg.daysAhead;
```

`cfg.daysAhead` is only reached when the caller passes no `daysAhead`. Every one of the
five callers passes an explicit value:

| Call site | Value passed | Surface |
|---|---|---|
| `server/server.js:4005` | `30`, or computed from the picker's `to` date (cap 120) | Reschedule picker |
| `server/server.js:4133` | `60` (hardcoded) | Booking re-validation |
| `server/server.js:11861` | `30` (hardcoded) | Slot validation on create |
| `server/server.js:19490` | `?days` param, **default `14`**, cap 60 — or computed from `to` | **Public availability** |
| `server/server.js:19688` | `30` (hardcoded) | Slot re-validation |

So the 14-day public window comes from the hardcoded fallback at
`server/server.js:19468`, not from the setting:

```js
daysAhead = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
```

**To actually get a 60-day public window**, that fallback is what has to change. Note the
existing cap on that line is already 60, so the ceiling does not need moving — only the
default. That is a one-line backend change, not a settings edit, and
`docs/FLOW_REGISTER.md` governs it.

Worth deciding at the same time: whether the three hardcoded `30`s and the `60` should
start reading the setting, so there is one number instead of five. Until then, changing
`daysAhead` in `/admin/schedule` will look like it worked and do nothing.

---

## 2. Saturday hours — it is 17:00 or it is nothing

Saturday capacity does not widen gradually. It is a cliff.

Bookable times come from `BOOKING_BUCKETS` (`server/lib/availability.js:214`) — a morning
bucket (08:00–12:00) and an afternoon bucket (12:00–17:00). A bucket is offered only if it
fits **entirely** inside the day's open/close window (`availability.js:330-331`):

```js
if (bucketFromMin < openMin) continue;
if (bucketToMin > closeMin) continue;
```

The afternoon bucket ends at 17:00, so it appears only when Saturday's `close` is 17:00 or
later. Measured against the real engine:

| Saturday `close` | Saturday slots | Buckets offered |
|---|---|---|
| 12:00 (current) | 2 | Morning |
| 13:00 | 2 | Morning |
| 15:00 | 2 | Morning |
| 16:00 | 2 | Morning |
| 16:59 | 2 | Morning |
| **17:00** | **4** | **Morning + Afternoon** |
| 18:00 | 4 | Morning + Afternoon |

**Implication for the R5 decision:** "widen Saturday past 12:00" only buys capacity at
17:00. Moving Saturday's close to 14:00 or 15:00 — the intuitive half-measure — adds a
longer workday with **zero** additional bookable slots, because the customer-facing
booking page has nothing between the two buckets to offer.

So the choice is genuinely binary:

- **Saturday close → 17:00.** Doubles Saturday capacity, and R5 can stay where it is.
- **Anything less than 17:00.** No booking-page effect at all; R5 should move to a weekday.

A third option, if a short Saturday afternoon is what is actually wanted, is to add a
narrower Saturday-only bucket — but that is a code change to `BOOKING_BUCKETS`, not a
settings edit, and it would need a flow-register entry.

`lastStart` (`10:30` on Saturday) is documented at `availability.js:179` but is not read
by the bucket path at all — it is a leftover from the pre-bucket 30-minute grid. Changing
it has no effect either way.

---

## 3. Fall outreach template — copy, ready to paste

Paste into `/admin/outreach` → Fall. Supported merge tags are exactly four
(`server/lib/notify-customer.js:1173`): `{{firstName}}`, `{{propertyAddress}}`,
`{{seasonName}}`, `{{portalLink}}`. Anything else renders literally.

Two things are appended automatically — **do not write them into the body**:
- Email: the unsubscribe footer (both the email-only and stop-everything links).
- SMS: `Reply STOP to opt out.` (added only if the body does not already say STOP).

Dates below come from `seasons.json` for fall 2026: booking closes **Oct 30**
(`publicBookingThrough`), last service day **Nov 6** (`serviceableThrough`, the hard
frost stop).

### Subject

```
Fall closing at {{propertyAddress}} — let's get you on the schedule
```

### Email body

```
Hi {{firstName}},

Fall closing season is open, and I'm booking now for {{propertyAddress}}.

Getting the lines blown out before the first hard freeze is what keeps a cracked
manifold or a split backflow from becoming a spring repair bill. Once the ground
freezes there's nothing to do but wait and fix it in April.

Two dates worth knowing this year:

- Online booking closes Friday, October 30
- Our last trucks roll Friday, November 6 — that's the hard frost stop

Pick a morning or afternoon that suits you here:

{{portalLink}}

If nothing left on the calendar works, just reply to this email and we'll sort
something out.

Thanks,
Patrick
PJL Land Services
```

### SMS body

```
Hi {{firstName}} — Patrick at PJL. Fall closing is open for {{propertyAddress}}. Online booking closes Oct 30, last trucks Nov 6. Grab a time: {{portalLink}}
```

**Note on SMS length.** Outreach SMS is *not* truncated (unlike the lifecycle SMS helper,
which trims to a single segment at `server/lib/notify-sms.js:117`). With the portal link
and the auto-appended STOP line this body runs to two segments. That is a deliberate
trade — the link has to be there — but it is two segments' cost per recipient, so it is
worth knowing before a bulk send.

**Note on `{{seasonName}}`.** It renders as the label `"Fall Closing"`
(`server/lib/outreach.js:67`), which reads awkwardly mid-sentence, so the copy above
writes "fall closing" in prose instead. The tag is still available if wanted.

---

## 4. The six docs and `season-plans.json` — not in this checkout

Neither is present. The working tree is clean with no untracked files, `docs/` holds the
eight files it already had, and there is no `season-plans.json` anywhere in the repo or
its history. Nothing was staged or committed for this item.

Two things to flag before those files land:

**`server/data/` is gitignored on purpose.** `.gitignore` excludes `server/data/*`
wholesale — it holds the hashed admin password and live customer records — with a single
negation for `project-rates.json`. Committing `season-plans.json` there needs a matching
`!server/data/season-plans.json` negation, and the file has to be genuinely static
catalog data rather than anything the running server writes back.

**There may already be a home for it.** `seasons.json` at the repo root is the
authoritative season-window config, read by `server/lib/seasons.js`, and it explicitly
documents planning a year by adding a block under `years`. Its header comment states it
lives at the root "alongside `pricing.json` / `parts.json`" by design. If
`season-plans.json` carries season dates, it likely belongs there — either merged into
`seasons.json` or beside it — rather than in the runtime data directory. Worth confirming
which before adding a second source of season dates; the whole reason `seasons.json`
exists is that the fall window used to be duplicated in code and drifted.

---

## 5. Randy State merge / `P-2026-0050` — cannot be verified or repaired from here

Both live in runtime data that is not in this checkout. There is no match anywhere in the
repo for "Randy", "P-2026-0050", or "R5" — `customers.json` and `properties.json` are
gitignored and absent.

What can be said is **why the link probably broke**, which points at the repair.

`P-2026-0050` is a **property** code (`server/lib/properties.js:92`). Properties carry a
denormalized snapshot of their owner — `customerName`, `customerEmail`, `customerPhone`
(`properties.js:152`, set at `properties.js:990`).

`mergeCustomers()` (`server/lib/customers.js:845`) rewrites **only `customerId`** across
`leads/properties/bookings/work-orders/quotes/invoices/projects.json`, then deletes the
secondary customer. It never refreshes those snapshot fields. So after a merge a property
points at the surviving customer while still displaying the merged-away name and contact
details — visible in the CRM, and consequential for outreach, which reads
`property.customerName` (`outreach.js:300`) to build `{{firstName}}` and the personalized
OG card.

**The repair already exists** — `POST /api/properties/:id/transfer-owner`
(`server/server.js:7910`), which re-points `customerId` *and* refreshes all three snapshot
fields from the customer record, and appends an `ownerHistory` entry:

```
POST /api/properties/P-2026-0050/transfer-owner
{ "newCustomerId": "<surviving Randy State customer id>", "note": "repair after merge" }
```

Passing the ID the property already holds is a safe no-op (`properties.js:1487`), so the
call is safe to make even if the link turns out to be fine.

Before running it, confirm on the live CRM: whether `P-2026-0050` resolves to a customer
at all, and whether its displayed name matches the surviving record. Also worth checking
`GET /api/outreach/audit-missing-names`, which lists live properties with a blank
`customerName` — the same merge can leave that empty, and the fall send is imminent.

**This snapshot staleness is not specific to one property.** Any property attached to any
merged customer has it. If the Randy State merge is confirmed, the other properties that
moved in the same merge are worth walking too.

---

## Why most of this could not be applied

Items 1, 3 and 5 are writes to `server/data/` — `schedule.json`, `settings.json`,
`properties.json`. That directory is gitignored (runtime state: hashed admin password,
live customer records) and is absent from this checkout apart from `project-rates.json`.

Two consequences:

1. Writing those files here would change nothing durable. This is an ephemeral container;
   the files are not committed and are discarded when it is reclaimed.
2. They cannot reach production through a commit. They are applied against the running
   instance — through `/admin/schedule`, `/admin/outreach`, and the CRM — or not at all.

The verification asked for (`/api/schedule/settings` returning `daysAhead: 60`,
`/api/outreach/templates` returning non-empty fall strings) therefore has to run against
the live server after the changes are made there. Neither is satisfied by this branch.

And per item 1 above: even applied on the live server, `daysAhead: 60` will not widen the
public booking window. That one needs code.

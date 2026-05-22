# Offline Queue — Stuck-Drain Investigation (May 21, 2026)

> Investigation only. No production code changed. Findings for Patrick to review before a fix brief is written.

Brief reference: "Diagnose and Harden Offline Queue Drain Failure" (May 21, 2026).
Subject WO from screenshot: `P-2026-0013` (Calandra, Acton ON), 69 pending changes.

---

## TL;DR

There are two distinct bugs in `server/offline-queue.js`, each independently sufficient to produce one of the reported symptoms. Both have high-confidence evidence in the code without needing the device snapshot.

| Symptom | Root cause | Confidence |
|---------|-----------|------------|
| **A — Queue grows, doesn't drain** | `replay()` is only triggered on `online` event and first page load. A transient fetch failure while `navigator.onLine === true` enqueues an item without scheduling any future drain attempt. Items accumulate indefinitely. | **High** |
| **B — Data appears to delete** | Queued PATCH bodies are full `zones` snapshots taken at enqueue time. The server's `update()` does a wholesale replace (`next.zones = patch.zones.map(hydrateZone)`). If-Match is stripped from replays. So a stale queued snapshot, replayed after newer online PATCHes landed, overwrites the server's fresher state with older zones data. | **High** |

Both bugs are localized to `offline-queue.js` and the server's PATCH `update()` function. The architecture (IndexedDB FIFO + synthesize-202 + replay-on-reconnect) is sound and doesn't need changing.

---

## Part B — `replay()` flow diagram

```
                ┌─────────────────────────────────┐
                │   replay() called               │
                │   Triggers: ONLY                │
                │     • window 'online' event     │
                │     • module first-load         │
                └───────────────┬─────────────────┘
                                ↓
                  ┌─────────────────────────┐
                  │ replayInFlight = true?  │── yes ──→ return (no-op)
                  └───────────┬─────────────┘
                              ↓ no
                  ┌─────────────────────────┐
                  │ navigator.onLine?       │── false ─→ return (no-op)
                  └───────────┬─────────────┘
                              ↓ true
                  ┌─────────────────────────┐
                  │ listAll() — snapshot    │
                  │ queue at this moment    │
                  │ (later additions ignored)│
                  └───────────┬─────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │ sort FIFO by queuedAt   │
                  └───────────┬─────────────┘
                              ↓
                ╔═══════════════════════════╗
                ║ for each entry in snapshot║
                ╚═══════════════╤═══════════╝
                                ↓
                  ┌─────────────────────────┐
                  │ strip If-Match headers  │
                  │ (defensive — also       │
                  │ stripped at enqueue)    │
                  └───────────┬─────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │ fetch(entry)            │
                  └───────────┬─────────────┘
                              ↓
                ┌─────────────────────────────────────┐
                │ Outcome?                            │
                ├─────────────────────────────────────┤
                │ network throws    → break loop      │  ← keeps item
                │                                     │
                │ 2xx / 3xx         → dequeue, drain++│  ← OK
                │                                     │
                │ 4xx (any!)        → dequeue, drain++│  ← ⚠ SILENT LOSS
                │   (includes 401, 404, 409, 422)     │
                │                                     │
                │ 5xx               → break loop      │  ← ⚠ POISON PILL
                └─────────────────────────────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │ refreshCount() →        │
                  │ fire 'change' listeners │
                  └───────────┬─────────────┘
                              ↓
                       (next iteration)
                              ↓
                  ╔═══════════════════════╗
                  ║ end of for loop       ║
                  ╚═══════════╤═══════════╝
                              ↓
                  ┌─────────────────────────────────────┐
                  │ if drainedAny && startedWithItems   │
                  │    && cachedCount === 0             │
                  │    && !userTyping                   │
                  │ → setTimeout(location.reload, 350)  │
                  └─────────────────────────────────────┘
```

**Critical observations:**

1. **No trigger after enqueue.** A successful `enqueue()` does not schedule a replay attempt. The only paths to a replay are (a) the global `online` event firing, or (b) the page being reloaded. In particular, a `queuedFetch` call that falls through to enqueue because `fetch()` threw (line 102-109) does NOT call `replay()` afterward.

2. **The `online` event only fires on offline→online transitions.** It does not fire when the device was online the whole time and only one fetch flaked.

3. **Indicator text decoupled from loop state.** The banner reads "Syncing N pending changes…" whenever `online && queued > 0`. There is no signal that the replay loop is actively running vs. idle. A stuck queue and an actively-draining queue look identical to the tech.

4. **Auto-reload requires `cachedCount === 0`.** A queue that never drops to zero never auto-reloads, so the UI never refreshes to show the tech which writes landed and which didn't.

5. **No max-retry, no dead-letter, no backoff.** Items either succeed (any non-5xx), get silently dropped (4xx counts as success), or block the loop indefinitely (5xx).

6. **The replay snapshot is fixed at loop entry.** `listAll()` is called once before the loop. New items enqueued during the loop are not processed this round. They wait for the next `online` event or page reload.

---

## Part C — Hypothesis evaluation

### H1 — Poison-pill blocking FIFO (5xx)

**Evidence:** Code at `offline-queue.js:175-180`:

```js
if (res.ok || res.status < 500) {
  await dequeue(entry.id);
  drainedAny = true;
} else {
  console.warn("[offline-queue] server 5xx during replay, keeping queued:", entry.url, res.status);
  break;
}
```

A 5xx response causes `break` — the loop aborts, the item stays in the queue, all behind it remain queued. The next replay (next `online` event or page reload) sorts FIFO and hits the same poison item first → same break. The queue can be permanently stuck on a persistent 5xx.

**Real but probably secondary.** Would require a sustained 5xx on a specific WO/payload. The server doesn't have obvious 5xx paths on `PATCH /api/work-orders/:id` for normal payloads (the validation 422 / scope-lock 409 paths are 4xx). Possible triggers: Render restart mid-replay, malformed JSON.parse server-side, lib I/O throw.

**Cannot rule out without the device snapshot.** A snapshot of `queue[0]` and its server response would confirm.

### H2 — Server returns 4xx, queue treats as success (data loss)

**Evidence:** Same lines as H1. `res.ok || res.status < 500` is true for everything below 500. So:
- **401 (session expired)** → dequeued silently. Work lost.
- **404 (WO not found — e.g., user re-entered URL with typo, or WO was deleted by another admin)** → dequeued silently.
- **409 (scope locked OR version conflict)** → dequeued silently. The `version_conflict` 409 specifically is bypassed by the If-Match strip at replay, so this would more likely be `wo_locked` if the WO got signed during the offline window.
- **422 (validation, e.g., malformed payload)** → dequeued silently.

The comment at `offline-queue.js:16-19` says "Failures (4xx/5xx that aren't network errors) drop the mutation from the queue with a console warning — server rejected it for a real reason, retrying won't help." That intent is implemented for 4xx (dequeue) but contradicted for 5xx (break). The 4xx-as-silent-loss is **intentional but wrong** — at minimum the failure should surface to the UI rather than vanish.

**High likelihood for some failure modes.** Strong candidate for "data didn't reach the server" symptom variant.

### H3 — Server returns 2xx, UI doesn't update

**Evidence:** `work-order-tech.js:914-944` reads `data.workOrder` from the PATCH response and updates `state.zones` etc. The queue's synthesized 202 response has no `workOrder` field, so local state isn't touched from the synth response (good — local state is the source of truth while offline). On REPLAY, the replay function (`offline-queue.js:147+`) doesn't update local state at all — it only dequeues. Local state.zones is whatever was last set during the original PATCH or load.

The auto-reload (`offline-queue.js:197-205`) covers the gap: after drain, reload → re-fetch → re-render from server state. But it only fires when the queue reaches zero. **A stuck queue never reaches zero, so the page never auto-reloads, and the tech's view of `state.zones` stays divergent from the server.**

**Not a primary mechanism but a contributing factor.** Aligned with Symptom A's "Data doesn't populate" — UI shows the local optimistic state but the server doesn't see it; on next manual reload, server state is missing the writes the tech believes they made.

### H4 — JS error mid-replay aborting silently

**Evidence:** The replay loop has a try/finally that resets `replayInFlight = false` in finally (line 188-191). Per-item errors are caught inside the for loop (line 182-185). There's a global `unhandledrejection` handler in `work-order-tech.js:51-56` that paints to the build badge. So genuinely-silent exceptions in replay are unlikely — they'd either be caught and break the loop (visible as a stuck count) or paint to the badge (visible as red error text).

**Low probability.** Already mitigated.

### H5 — Cookie / session expired mid-session

**Evidence:** SYSTEM_OVERVIEW.md line 233-235 explicitly notes: *"A tech disabled mid-offline keeps working until reconnect (then queued writes 401)."* This is a known acknowledged failure mode. Render's session cookie lifetime + a long tech-mode visit + the H2 silent-dequeue-on-4xx behavior together mean: if the session expires while the queue has items, every replay returns 401, every item is silently dequeued, and the tech's work is permanently lost.

I haven't traced the auth middleware to confirm session lifetime — that's a worthwhile check during the fix brief.

**Real risk. Compounds with H2.** This is the worst-case data-loss path: a session expiry during a 4-hour service call wipes the entire offline window.

### H6 — Items added faster than they drain

**Evidence:** Each `patchWorkOrder({ zones: state.zones })` call enqueues a PATCH carrying the **full zones array** as a JSON snapshot. The tech-mode UI fires `patchWorkOrder({ zones: state.zones })` from 12+ call sites (greppable count: `patchWorkOrder({ zones` appears 12 times in `work-order-tech.js`), covering: zone status change, check toggle, issue add, issue edit, issue subtype select, issue delete, notes typing (debounced), location edit, sprinkler-type pill toggle, coverage pill toggle.

A spring-opening WO with 15 zones × 5 checks = 75 check taps minimum. Each tap fires one PATCH carrying ALL zones. Add issue logging, notes, status changes → easily 100+ PATCHes per visit. Each PATCH is the full state.

If `navigator.onLine` is true and the network is fast, these all go through directly and the queue stays empty. But:
- **If `navigator.onLine` is true and a single fetch throws** (DNS hiccup, captive portal, dropped packet), that PATCH enqueues — and per the flow above, no replay is scheduled. The item sits.
- Subsequent PATCHes succeed online (network came back) so the *new* server state is correct. But the queued items remain.
- The count climbs as transient network failures accumulate.

**This is the most likely root cause for Symptom A on the screenshot WO.** A 5-hour mid-visit with intermittent cellular dead zones could easily produce 69 enqueued items without any replay attempt.

### H7 — ServiceWorker cache serving stale GET

**Evidence:** `tech-sw.js:440-444` registers `networkFirstAndCache` for `/api/work-orders/:id`. Network-first means a successful online GET wins; cache is only served on network failure. So in normal connected operation the GET is fresh.

The cache could serve stale state if the GET races with a slow network response, but `networkFirstAndCache` awaits the fetch result and only falls back to cache on throw. So this is unlikely to be a primary mechanism for Symptom B.

**Low probability.**

---

## Part D — Symptom B (data deletes) — confirmed mechanism

**Step-by-step:**

1. Tech makes edit A while online. `patchWorkOrder` fires PATCH with `zones = [A]` and `If-Match: T0` (where T0 is the previously-known `updatedAt`). Server applies, returns `updatedAt = T1`. Local state updates `state.updatedAt = T1`.

2. Tech makes edit B while online but on a flaky link. Local state mutates to `zones = [A, B]`. `patchWorkOrder` fires PATCH with `zones = [A, B]` and `If-Match: T1`. `fetch()` throws (TCP reset, DNS timeout, whatever). The `queuedFetch` `try/catch` at `offline-queue.js:103-109` falls through to `enqueue()`. The enqueued body is `JSON.stringify({zones: [A, B]})` — a frozen snapshot. If-Match is stripped at enqueue (line 126-131). **No replay is scheduled.**

3. Network recovers within seconds. Tech makes edit C while online. Local state mutates to `zones = [A, B, C]`. `patchWorkOrder` fires PATCH with `zones = [A, B, C]` and `If-Match: T1` (still T1 because the queued B never bumped local state). `fetch()` succeeds. Server applies, returns `updatedAt = T2`. Local state updates `state.updatedAt = T2`. **Server zones is now `[A, B, C]` — correct.** 

4. More edits D, E happen online — all succeed. Local state.zones = `[A, B, C, D, E]`. Server zones = `[A, B, C, D, E]`. The queue still holds the B entry with body `zones = [A, B]`.

5. Tech experiences another transient hiccup, enqueues another item (with body `zones = [A, B, C, D, E, F]` — full current state at that moment). Now the queue holds two items: B-snapshot and F-snapshot. Still no replay.

6. Eventually `online` event fires (or page reload). `replay()` runs. Loop sorts FIFO. First item is B-snapshot (queuedAt earliest).

7. Replay sends PATCH with body `zones = [A, B]`, no If-Match. Server's `lib/work-orders.js:1172`:
   ```js
   if (Array.isArray(patch.zones)) next.zones = patch.zones.map(hydrateZone);
   ```
   **Wholesale replace. Server zones is now `[A, B]`.** C, D, E are GONE from the server.

8. Loop continues. Next item is F-snapshot with body `zones = [A, B, C, D, E, F]`. Server applies — now zones = `[A, B, C, D, E, F]`. **C, D, E are BACK.** This is the "data flicker" Patrick may have observed.

9. Queue drains to zero. Auto-reload fires. Page re-fetches. Tech sees correct state.

**BUT** — if step 8 never happens (5xx halts the loop after step 7, network drops again, page is reloaded mid-replay), the server is stuck at `[A, B]` and C/D/E are permanently lost from disk.

**Confirmation evidence:**

- `lib/work-orders.js:1172` — wholesale-replace of `zones`.
- `offline-queue.js:126-131` and 163-169 — If-Match stripped at enqueue and replay.
- `offline-queue.js:112` — body is captured as the JSON string at enqueue time, frozen.
- Server's optimistic-concurrency 409 path (`server.js:9940`) is the ONE defence against this, and the queue deliberately bypasses it.

The comment justifying the If-Match strip (offline-queue.js:117-131) explicitly accepts this trade-off as "two techs editing the same WO concurrently could overwrite each other's changes via queue. Acceptable — techs don't share WOs in practice." **What the comment misses is that a SINGLE TECH on a SINGLE DEVICE also has this problem** — their own newer online PATCH gets clobbered by their own older queued PATCH.

---

## Part A — Device snapshot (procedure documented; capture pending)

The brief asks for a redacted JSON snapshot of the stuck queue. I haven't done this — Patrick or whoever has the affected phone needs to run §3-§5 of `OFFLINE_QUEUE_RECOVERY.md` to capture it. Once captured, the snapshot will confirm:

- Whether the queued items target a single WO (likely) or multiple.
- Whether the bodies all carry `zones` (likely) or include other shapes.
- The timestamp spread (how old is the oldest? — answers whether the queue has been stuck for minutes or hours).
- Whether the head of the queue is identical to a body that should have been superseded (smoking gun for H6).

The snapshot is high-value but NOT required to confirm the two root causes above. The code evidence is sufficient.

---

## Hypothesis ranking — final

| Rank | Hypothesis | Confidence | Symptom |
|------|-----------|------------|---------|
| 1 | **H6 — No replay trigger on enqueue. Items accumulate when `navigator.onLine` is true but `fetch()` threw transiently.** | **High** | A |
| 2 | **H3/D — Stale `zones` snapshots wholesale-replace newer server state when the queue eventually drains.** | **High** | B |
| 3 | H1 — 5xx poison pill blocks FIFO. | Medium | A (acute) |
| 4 | H5 — Session expiry → 401 → silent dequeue. Compounds with H2. | Medium | A (terminal data loss) |
| 5 | H2 — 4xx silently dropped, user never sees the failure. | Medium | Both |
| 6 | H7 — Cache serving stale GET. | Low | A |
| 7 | H4 — Silent JS error mid-replay. | Low | A |

---

## Smallest possible fix — recommendation

Two surgical changes, both in `offline-queue.js`, no architecture change:

**Fix 1 — Schedule replay after every enqueue.** At the end of the `queuedFetch` enqueue path (around line 132-142), if `navigator.onLine` is true, schedule a `replay()` call. Single line:

```js
await enqueue({ url, method, body, headers });
await refreshCount();
if (navigator.onLine) setTimeout(replay, 1000);  // ← new
```

The 1-second delay debounces against bursts of enqueues (tech tapping checks rapidly). Catches the case where `fetch` flaked but the device thinks it's online.

This alone resolves Symptom A for the common case (transient network blips during an otherwise-online visit).

**Fix 2 — Don't replay full-object snapshots once the WO has moved past the snapshot's basis.** Two sub-options, ranked by effort:

- **2a (easy, lossy):** Before replay, fetch the current WO and check `wo.updatedAt`. If the queued item's `queuedAt` is older than the server's `updatedAt` AND the body contains a full-replace field (`zones`, `additionalRepairs`, `lineItems`, `photos`, `customParts`, `materialsPacked`, `serviceChecklist`), drop the queued item (with a UI surface — see hardening below). Accepts that some queued work may not land if the user kept editing after the offline window; surfaces the loss instead of silently overwriting.

- **2b (harder, correct):** Move queued PATCHes from snapshots to deltas. `patchWorkOrder({ zoneIssueAdd: { zoneIdx, issue } })` instead of `patchWorkOrder({ zones: state.zones })`. Server merges deltas into the current state. No clobber possible. **This is a bigger change** — touches every call site in `work-order-tech.js` and adds delta endpoints to the server. Should be a separate brief.

Recommend **Fix 1 + 2a as the immediate fix**. **2b becomes a "Brief X — queue deltas not snapshots" follow-up** that the architecture explicitly invites (the brief's §7 mentions adding a behavioral rule "no full-object PATCH replays; queue items must be deltas, not snapshots" — that's 2b).

---

## Smallest possible hardening — recommendation

Layered defences that don't depend on getting the fix right:

1. **Surface dequeue failures in the banner.** Add a `failedCount` parallel to `pendingCount` that increments when an item is dropped on 4xx (or after max retries). Banner reads "Syncing N pending · M failed — tap to review." Failed items go to a separate IndexedDB store (the dead-letter) where they can be inspected from the recovery doc's procedure rather than vanishing entirely. **No more silent data loss.**

2. **Distinguish "queue is draining" from "queue is idle".** Add a `replayInFlight` flag to the banner state. Banner reads "Syncing 12 (active)…" vs "12 queued (idle — tap to retry)" so the tech knows whether to wait or take action.

3. **Manual "Retry now" button on the banner.** Calls `window.PJLOffline.replay()`. Replaces the "wait and pray" experience. Belt-and-suspenders on top of Fix 1.

4. **Periodic replay heartbeat.** `setInterval(replay, 30_000)`. Backstop against missed `online` events and against any future bug that breaks the auto-trigger. Idempotent because `replay()` no-ops when `replayInFlight === true` or `cachedCount === 0`.

5. **Max retry per item with dead-letter.** Each queue entry gets an `attempts` counter. After 5 failed attempts, move to dead-letter store. Prevents one badly-shaped item from stalling forever.

6. **Optimistic concurrency on replay, with a "newer snapshot wins" arbitration.** Send a `queuedAt` header on replay; server's PATCH endpoint checks `queuedAt < existing.updatedAt && payload-touches-full-replace-field` → 409. Client handles the 409 by dead-lettering with a "this write was superseded" reason. Symptom B becomes impossible.

These are independent. (1) and (3) alone make stuck queues self-recoverable. (4) prevents future regressions of Fix 1. (6) is the principled answer to Symptom B.

---

## Out-of-scope confirmations

- The architecture (IndexedDB FIFO + synth-202 + replay-on-reconnect) is not the problem and should be preserved.
- `SCOPE_PROTECTED_FIELDS` is not involved (the screenshot WO is unsigned; the 409 path is the `version_conflict` path, which is bypassed by If-Match stripping).
- No new dependencies needed for any fix.
- No data migration needed.

---

## Acceptance checklist status

- [ ] Snapshot of the stuck queue from a real device captured (Part A) — **procedure documented in `OFFLINE_QUEUE_RECOVERY.md`; capture pending on Patrick**
- [x] `replay()` flow diagram documented (Part B)
- [x] Each hypothesis H1–H7 evaluated with evidence (Part C)
- [x] Symptom B mechanism identified (Part D)
- [x] `OFFLINE_QUEUE_RECOVERY.md` created (Part E) — not yet committed (this is a no-commit investigation pass)
- [x] Hypothesis ranking finalized
- [x] Recommendation on smallest possible fix
- [x] Recommendation on smallest possible hardening
- [ ] Patrick reviews findings — **pending**
- [ ] Observability commit — **deferred unless Patrick wants instrumentation before the fix**

---

*Investigation conducted 2026-05-21 against worktree `upbeat-poitras-c04d1a`. No production code modified.*
